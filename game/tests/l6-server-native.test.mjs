// Built server + real WebSockets. Run only after this tree's complete build.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import WebSocket from 'ws';
import { generateExam } from '../shared/exam.ts';
import { L6 } from '../shared/levels/l6.ts';
import { ST_SPECTATE } from '../shared/protocol.ts';
import { CollisionWorld, overlaps } from '../shared/campus/collision.ts';
import { lineOfSight, NAV_CAPSULE } from '../shared/campus/nav.ts';
import { campusDoorSlab } from '../shared/doors.ts';
import { baseURL, startL6Server } from './l6-real-server.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, predicate, label, timeout = 5000) {
  const start = performance.now();
  while (performance.now() - start < timeout) {
    const value = read();
    if (predicate(value)) return value;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(read())}`);
}
async function connect(name) {
  const ws = new WebSocket(baseURL.replace('http', 'ws') + '/ws'), messages = [], mobs = new Map();
  ws.on('message', data => {
    const message = JSON.parse(data.toString()); messages.push({ ...message, receivedAt: performance.now() });
    if (message.t === 'snap') for (const mob of message.mobs) mobs.set(mob.id, { ...mobs.get(mob.id), ...mob });
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const send = message => ws.send(JSON.stringify(message));
  send({ t: 'hello', name });
  const latest = type => messages.findLast(message => message.t === type);
  await until(() => latest('welcome'), Boolean, `${name} welcome`);
  return { ws, send, latest, messages, mobs };
}
async function teleport(peer, x, z, floor) {
  const before = peer.messages.length;
  peer.send({ t: 'debug', op: 'tp', x, z, floor });
  await until(() => peer.messages.slice(before).findLast(m => m.t === 'correct'),
    m => m && Math.hypot(m.p[0] - x, m.p[2] - z) < .1 && Math.abs(m.p[1] - floor * 3.6) < .1, 'authoritative teleport');
}
async function choose(peer, question, choice, revision = peer.latest('exam').revision) {
  peer.send({ t: 'exam', op: 'answer', question, choice, revision });
  return until(() => peer.latest('exam'), state => state?.answers[question] === choice, `question ${question}`);
}
async function crossExitGate(peer, open) {
  const gate = L6.exam.exitGate, z = (gate.z0 + gate.z1) / 2;
  await teleport(peer, gate.x1 + .65, z, 4);
  await delay(200); // refill the server's legitimate movement budget before testing this short segment
  const seq = open ? 901 : 900, before = peer.messages.length;
  const destination = [gate.x0 - .65, gate.y, z];
  peer.send({ t: 'input', seq, p: destination, yaw: Math.PI / 2, pitch: 0, f: 0, c: peer.latest('correct').c });
  if (!open) {
    const rejected = await until(() => peer.messages.slice(before).find(m => m.t === 'correct' && m.ack === seq), Boolean, 'closed physical exit rejection');
    assert.equal(rejected.p[0] > gate.x1, true);
    return { blockedAt: rejected.p, attempted: destination };
  }
  const id = peer.latest('welcome').id;
  const accepted = await until(() => peer.latest('snap')?.players.find(p => p.id === id), p => p?.p[0] < gate.x0, 'open physical exit crossing');
  assert.equal(peer.messages.slice(before).some(m => m.t === 'correct' && m.ack === seq), false);
  return { acceptedAt: accepted.p, attempted: destination };
}
const paper = L6.exam.paper, near = { x: paper.x, z: paper.z + .75, floor: 3 };

test('real L6 server: shared seed, authority, exact punishment, nearest-door Warden, one invigilator and team completion', { timeout: 40_000 }, async () => {
  const server = await startL6Server('websocket'), clients = [], evidence = {};
  try {
    const a = await connect('实服考生甲'); clients.push(a);
    a.send({ t: 'create' });
    const room = await until(() => a.latest('room'), Boolean, 'created room');
    assert.equal(room.level, 5); assert.equal(room.started, false);
    const b = await connect('实服考生乙'); clients.push(b);
    b.send({ t: 'join', code: room.code });
    const joined = await until(() => b.latest('room'), Boolean, 'joined room');
    assert.equal(joined.level, 5); assert.equal(joined.seed, room.seed);
    a.send({ t: 'start' });
    await until(() => a.latest('snap'), m => m?.players.length === 2, 'two actual players');
    for (const peer of [a, b]) peer.send({ t: 'debug', op: 'safe', s: 600 });
    const questions = generateExam(room.seed);
    assert.equal(questions.length, 5); assert.deepEqual(a.latest('exam').answers, [null, null, null, null, null]);
    assert.deepEqual(a.latest('exam').answers, b.latest('exam').answers);
    evidence.seed = room.seed; evidence.questions = questions.map(({ id, prompt, clue }) => ({ id, prompt, clue }));
    // The wire carries a shared answer sheet, never correct answers or a client-controlled pass bit.
    assert.equal(JSON.stringify(a.latest('exam')).includes('correct'), false);
    const initial = a.latest('exam').revision;
    a.send({ t: 'exam', op: 'answer', question: 0, choice: questions[0].correct, revision: initial });
    a.send({ t: 'exam', op: 'submit', revision: initial });
    a.send({ t: 'exam', op: 'pass', passed: true, revision: initial });
    await delay(150); assert.equal(a.latest('exam').revision, initial); assert.equal(a.latest('exam').passed, false);
    // Merely gathering at the exit cannot bypass the server's explicit submission gate.
    evidence.exitGate = { closed: await crossExitGate(a, false) };
    await teleport(a, L6.exit.x, L6.exit.z, 4); await teleport(b, L6.exit.x, L6.exit.z, 4);
    await delay(150); assert.equal(a.latest('fade'), undefined); assert.equal(b.latest('fade'), undefined);
    await teleport(a, near.x, near.z, near.floor); await teleport(b, near.x, near.z, near.floor);
    // Incomplete and stale sheets cannot unlock the exit.
    a.send({ t: 'exam', op: 'submit', revision: initial });
    await until(() => a.latest('exam'), m => /未作答/.test(m?.feedback), 'incomplete refusal');
    await choose(a, 0, (questions[0].correct + 1) % 4);
    const updated = a.latest('exam').revision;
    b.send({ t: 'exam', op: 'answer', question: 0, choice: questions[0].correct, revision: initial });
    await until(() => b.latest('exam'), m => m?.revision === updated, 'stale teammate resync');
    assert.equal(b.latest('exam').answers[0], (questions[0].correct + 1) % 4);
    for (let question = 1; question < 5; question++) await choose(question % 2 ? b : a, question, questions[question].correct);
    await until(() => a.latest('exam'), m => m?.answers.every(x => x !== null), 'all answers synchronized');
    assert.equal(a.latest('exam').passed, false);
    // A sheet complete on the client still cannot be submitted remotely or through the adjacent wall.
    const filledRevision = a.latest('exam').revision;
    await teleport(a, paper.x, 71.5, 3);
    a.send({ t: 'exam', op: 'submit', revision: filledRevision });
    await delay(150); assert.equal(a.latest('exam').revision, filledRevision);
    await teleport(a, near.x, near.z, near.floor);
    a.send({ t: 'exam', op: 'submit', revision: filledRevision });
    const penalty = await until(() => a.latest('exam'), m => m?.cooldown === 10, 'wrong-answer punishment');
    assert.equal(penalty.passed, false); assert.deepEqual(penalty.blackout, { floor: 3, seconds: 10 });
    await until(() => b.latest('exam'), m => m?.revision === penalty.revision, 'shared punishment');
    assert.deepEqual(b.latest('exam').answers, penalty.answers);
    // Observe the first real post-submission snapshot before AI has time to leave the doorway.
    const snap = await until(() => a.messages.find(m => m.t === 'snap' && m.receivedAt >= penalty.receivedAt), Boolean, 'penalty snapshot');
    const warden = snap.mobs.find(m => m.id === 1), doors = JSON.parse(await readFile(new URL('../shared/campus/colliders.json', import.meta.url), 'utf8')).doors;
    const nearest = doors.filter(d => Math.abs(d.y0 - 10.8) < .5).sort((x, y) => Math.hypot(x.x - near.x, x.z - near.z) - Math.hypot(y.x - near.x, y.z - near.z))[0];
    await writeFile('test-results/l6-warden-first-snapshot.json', JSON.stringify({ seed: room.seed, near, penalty, warden, nearest, snapshot: snap }, null, 2));
    assert.equal(nearest.id, 67);
    assert.equal(warden.target, a.latest('welcome').id);
    assert.equal(warden.p[0] > nearest.x + .3, true); assert.equal(Math.hypot(warden.p[0] - nearest.x, warden.p[2] - nearest.z) < 4, true);
    assert.equal(Math.abs(warden.p[1] - 10.8) < .05, true);
    const doorStates = new Map(a.latest('doors').doors.map(d => [d.id, d.open]));
    const closedDoors = new CollisionWorld(doors.map(d => campusDoorSlab(d, doorStates.get(d.id))));
    const bodyAt = p => ({ x: p[0], y: p[1], z: p[2], vy: 0, grounded: true });
    assert.equal(overlaps(closedDoors, bodyAt(warden.p), NAV_CAPSULE), false, 'first actual Warden capsule must clear the closed door');
    assert.equal(lineOfSight(closedDoors, { x: near.x, y: 12.4, z: near.z }, { x: warden.p[0], y: warden.p[1] + 1.6, z: warden.p[2] }), false, 'closed nearest door hides the summoned Warden');
    assert.equal([...a.mobs.values()].filter(m => m.kind === 'monitor').length, 1);
    evidence.punishment = { state: penalty, warden, nearestDoor: nearest.id, monitorCount: 1 };
    // Repeated packets cannot extend the ten-second timer or mutate its answer sheet.
    for (let i = 0; i < 10; i++) {
      b.send({ t: 'exam', op: 'submit', revision: penalty.revision });
      b.send({ t: 'exam', op: 'answer', question: 0, choice: questions[0].correct, revision: penalty.revision });
    }
    await delay(250); assert.equal(b.latest('exam').revision, penalty.revision); assert.deepEqual(b.latest('exam').answers, penalty.answers);
    const punishmentSnaps = a.messages.filter(m => m.t === 'snap' && m.receivedAt >= penalty.receivedAt);
    for (const m of punishmentSnaps) assert.equal(overlaps(closedDoors, bodyAt(m.mobs.find(mob => mob.id === 1).p), NAV_CAPSULE), false, 'later real Warden snapshot must not enter a closed door');
    evidence.punishment.collisionFreeSnapshots = punishmentSnaps.length;
    const late = await connect('晚入监考观察者'); clients.push(late);
    late.send({ t: 'join', code: room.code });
    const lateState = await until(() => late.latest('exam'), Boolean, 'late shared blackout');
    assert.equal(lateState.revision, penalty.revision); assert.equal(lateState.blackout.floor, 3);
    assert.equal(lateState.cooldown > 8 && lateState.cooldown < 10, true);
    const lateId = late.latest('welcome').id;
    await until(() => late.latest('snap')?.players.find(p => p.id === lateId), p => p?.st === ST_SPECTATE, 'late spectator status');
    await teleport(late, near.x, near.z, near.floor);
    late.send({ t: 'exam', op: 'answer', question: 0, choice: questions[0].correct, revision: penalty.revision });
    await delay(100); assert.equal(a.latest('exam').revision, penalty.revision);
    const restored = await until(() => a.latest('exam'), m => m?.revision === penalty.revision + 1 && m.cooldown === 0, 'ten-second restoration', 12_000);
    const elapsedMs = restored.receivedAt - penalty.receivedAt;
    assert.equal(elapsedMs >= 9700 && elapsedMs < 11_500, true, `blackout lasted ${elapsedMs} ms`);
    assert.equal(restored.blackout, undefined); assert.equal(a.messages.some(m => m.t === 'trip'), false);
    evidence.punishment.elapsedMs = elapsedMs; evidence.lateJoin = { ...lateState, spectator: true };
    await choose(b, 0, questions[0].correct);
    await until(() => a.latest('exam'), m => m?.answers[0] === questions[0].correct, 'peer correction');
    assert.equal(a.latest('exam').passed, false);
    b.send({ t: 'exam', op: 'submit', revision: b.latest('exam').revision });
    await until(() => a.latest('exam'), m => m?.passed, 'authority accepted submission');
    await until(() => late.latest('exam'), m => m?.passed, 'observer sees authority pass');
    const passedRevision = a.latest('exam').revision;
    await choose(a, 0, questions[0].correct);
    assert.equal(a.latest('exam').revision, passedRevision);
    evidence.exitGate.open = await crossExitGate(a, true);
    await teleport(a, L6.exit.x, L6.exit.z, 4); await delay(150);
    assert.equal(a.latest('fade'), undefined);
    await teleport(b, L6.exit.x, L6.exit.z, 4);
    await until(() => a.latest('fade'), m => m?.restart === false, 'living teammates exit together');
    const complete = await until(() => a.latest('complete'), Boolean, 'terminal preview completion', 5000);
    assert.equal(complete.level, 5);
    await until(() => b.latest('complete'), Boolean, 'peer completion');
    await until(() => late.latest('complete'), Boolean, 'late observer completion');
    // Completed rooms remain immutable; a late observer was never required in the exit circle.
    const completedSheet = a.latest('exam');
    a.send({ t: 'exam', op: 'answer', question: 0, choice: (questions[0].correct + 1) % 4, revision: passedRevision });
    await delay(150); assert.deepEqual(a.latest('exam'), completedSheet);
    evidence.complete = { t: complete.t, level: complete.level }; evidence.passed = true;
  } finally {
    await writeFile('test-results/l6-real-websocket.json', JSON.stringify(evidence, null, 2));
    for (const peer of clients) peer.ws.close();
    await server.stop();
  }
});
