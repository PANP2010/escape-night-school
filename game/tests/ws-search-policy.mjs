/**
 * Real two-client acceptance test. Start this tree's genuine server on 4448, then:
 *   node tests/ws-search-policy.mjs
 * The script never starts/builds a server and writes evidence only to test-results/.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import { L1 } from '../shared/levels/l1.ts';
import { F_HIDE, ST_DOWN, ST_OK } from '../shared/protocol.ts';
import { CollisionWorld, groundHeight, overlaps } from '../shared/campus/collision.ts';
import { NAV_CAPSULE } from '../shared/campus/nav.ts';

const endpoint = 'ws://127.0.0.1:4448/ws';
const campus = JSON.parse(await readFile(new URL('../shared/campus/colliders.json', import.meta.url), 'utf8'));
const campusWorld = new CollisionWorld(campus.colliders);
for (const h of campus.holes) campusWorld.addHole(h.x0, h.x1, h.z0, h.z1);
function clearCapsule(a, b) {
  const steps = Math.max(1, Math.ceil(Math.hypot(...a.map((v, i) => v - b[i])) / .1));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (overlaps(campusWorld, { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, z: a[2] + (b[2] - a[2]) * t, vy: 0, grounded: true }, NAV_CAPSULE)) return false;
  }
  return true;
}
const started = performance.now();
const elapsed = () => Math.round(performance.now() - started);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const peers = [];
const report = { endpoint, status: 'running', cases: [], trace: [], externalVideoScore: null };
let barrierId = 0;

class Peer {
  constructor(name) {
    this.name = name;
    this.messages = [];
    this.players = new Map();
    this.mobs = new Map();
    this.doors = new Map();
    this.ws = new WebSocket(endpoint, { handshakeTimeout: 8000 });
    this.ready = new Promise((resolve, reject) => { this.ws.once('open', resolve); this.ws.once('error', reject); });
    this.ws.on('error', error => { this.fault = error.message; });
    this.ws.on('message', raw => {
      const m = JSON.parse(raw.toString());
      this.messages.push({ ms: elapsed(), m });
      if (m.t === 'welcome') this.id = m.id;
      if (m.t === 'room') {
        this.room = m;
        if (m.started && this.readyIncarnation !== m.incarnation) {
          this.readyIncarnation = m.incarnation;
          this.send({ t: 'ready', incarnation: m.incarnation });
        }
      }
      if (m.t === 'correct') this.correction = m;
      if (m.t === 'snap') {
        this.tick = m.tick;
        for (const p of m.players) this.players.set(p.id, { ...this.players.get(p.id), ...p, st: p.st ?? ST_OK });
        for (const w of m.mobs) this.mobs.set(w.id, { ...this.mobs.get(w.id), ...w });
      }
      for (const d of m.doors ?? []) this.doors.set(d.id, d);
      if (m.t !== 'snap' && m.t !== 'nav' && m.t !== 'doors') report.trace.push({ ms: elapsed(), peer: name, receive: m });
    });
    peers.push(this);
  }
  send(m) { report.trace.push({ ms: elapsed(), peer: this.name, send: m }); this.ws.send(JSON.stringify(m)); }
  mark() { return this.messages.length; }
  after(mark, predicate) { return this.messages.slice(mark).filter(e => predicate(e.m)); }
  self() { return this.players.get(this.id); }
  async close() {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    const closed = new Promise(resolve => this.ws.once('close', resolve));
    this.ws.close();
    await Promise.race([closed, delay(750)]);
    if (this.ws.readyState !== WebSocket.CLOSED) this.ws.terminate();
  }
}

async function until(predicate, label, timeout = 8000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    for (const p of peers) assert.equal(p.fault, undefined, `${p.name}: ${p.fault}`);
    const value = predicate();
    if (value) return value;
    await delay(15);
  }
  assert.fail(`Timed out: ${label}`);
}
async function ticks(peer, count) {
  const tick = peer.tick ?? 0;
  await until(() => peer.tick >= tick + count, `${count} authoritative ticks`, count * 100 + 4000);
}
async function barrier(peer, recipients = peers) {
  const text = `SEARCH-WS:${++barrierId}`;
  const marks = recipients.map(p => p.mark());
  peer.send({ t: 'chat', text });
  await Promise.all(recipients.map((p, i) => until(() => p.after(marks[i], m => m.t === 'chat' && m.text === text).length, 'message barrier')));
}
const near = (p, q, tolerance = .08) => Array.isArray(p) && Math.hypot(...p.map((v, i) => v - q[i])) < tolerance;
async function teleport(peer, p, snapshot = true) {
  const mark = peer.mark();
  peer.send({ t: 'debug', op: 'tp', x: p[0], z: p[2], floor: Math.round(p[1] / 3.6) });
  await until(() => peer.after(mark, m => m.t === 'correct' && m.forced && near(m.p, p)).length, `${peer.name} valid teleport ${p}`);
  if (snapshot) await until(() => near(peer.self()?.p, p), `${peer.name} teleport snapshot`);
}
async function face(peer, yaw) {
  peer.send({ t: 'input', seq: (peer.seq = (peer.seq ?? 0) + 1), p: peer.self().p, yaw, pitch: 0, f: 0, c: peer.correction?.c ?? 0 });
  await barrier(peer);
}
async function check(name, body) {
  const item = { name, status: 'running', startedMs: elapsed() };
  report.cases.push(item);
  try { item.evidence = await body(); item.status = 'passed'; console.log(`PASS ${name}`); }
  catch (error) { item.status = 'failed'; item.error = error.stack ?? String(error); throw error; }
  finally { item.durationMs = elapsed() - item.startedMs; }
}

try {
  const a = new Peer('search-target'), b = new Peer('rescue-teammate');
  await Promise.all(peers.map(p => p.ready));
  await until(() => peers.every(p => p.id), 'welcomes');
  for (const p of peers) p.send({ t: 'hello', name: p.name });
  a.send({ t: 'create' });
  await until(() => a.room?.code, 'room created');
  b.send({ t: 'join', code: a.room.code });
  await until(() => peers.every(p => p.room?.players.length === 2), 'both joined lobby');
  a.send({ t: 'start' });
  await until(() => peers.every(p => p.self()?.st === ST_OK && p.doors.size > 0 && p.mobs.has(1)), 'both in genuine L1');
  // The target's debug summon later removes only their own protection. The teammate stays protected.
  b.send({ t: 'debug', op: 'safe', s: 600 });
  await barrier(b);

  await check('unlocked pursuit opens the real door and sends identical deltas to both clients', async () => {
    const door = campus.doors[1];
    assert.equal(a.doors.get(door.id).locked, false);
    await teleport(a, [door.x, 0, 73.36]);
    await teleport(b, [door.x + 1.4, 0, 73.5]);
    b.send({ t: 'door', id: door.id });
    await until(() => peers.every(p => p.doors.get(door.id)?.open), 'player opens door before sight samples');
    await face(a, 0);
    const start = [3, 3.2, 3.5, 4, 4.5].map(distance => [door.x, 0, door.z - distance])
      .find(p => clearCapsule(p, [door.x, 0, door.z + .4]));
    assert.ok(start, 'summon starts on a real clear capsule approach to the unlocked door');
    a.send({ t: 'debug', op: 'warden', d: a.self().p[2] - start[2] });
    await ticks(a, 3);
    assert.equal(a.self().st, ST_OK, 'target must still be alive before closing the door');
    const marks = peers.map(p => p.mark());
    b.send({ t: 'door', id: door.id });
    await until(() => peers.every(p => !p.doors.get(door.id)?.open), 'teammate actually closes chase door');
    const closedAt = a.tick;
    await until(() => peers.every((p, i) => p.after(marks[i], m => m.t === 'snap' && m.tick > closedAt && m.doors?.some(d => d.id === door.id && d.open && !d.locked)).length), 'AI opening delivered in both authoritative door deltas', 12000);
    const opened = a.after(marks[0], m => m.t === 'snap' && m.tick > closedAt && m.doors?.some(d => d.id === door.id && d.open))[0].m;
    const mob = opened.mobs.find(w => w.id === 1);
    assert.ok(mob && Math.hypot(mob.p[0] - door.x, mob.p[2] - door.z) <= 3.2, 'AI must approach before opening');
    const caught = await until(() => a.messages.find(e => e.m.t === 'caught' && e.m.by === 'warden'), 'Warden catches after physically crossing the unlocked door', 12000);
    await until(() => peers.every(p => p.players.get(a.id)?.st === ST_DOWN), 'both observe authoritative down state');
    return { door: door.id, closedTick: closedAt, openedTick: opened.tick, openingPosition: mob.p, caughtAtMs: caught.ms };
  });

  await check('revive clears the down timer and preserves the full five-second protection', async () => {
    const target = a.self().p;
    await teleport(b, [target[0] + .6, target[1], target[2]]);
    const marks = peers.map(p => p.mark());
    const deadline = performance.now() + 6500;
    while (a.self().st === ST_DOWN && performance.now() < deadline) {
      b.send({ t: 'act', kind: 'revive', id: a.id });
      await delay(50);
    }
    assert.equal(a.self().st, ST_OK, 'three-second real WS revive completes');
    const revivedTick = a.tick;
    await ticks(a, 98);
    for (const [i, p] of peers.entries()) {
      const snapshots = p.after(marks[i], m => m.t === 'snap' && m.tick > revivedTick && m.tick < revivedTick + 100);
      assert.ok(snapshots.length >= 85, 'continuous authoritative evidence during protection');
      assert.ok(snapshots.every(e => (e.m.players.find(q => q.id === a.id)?.st ?? ST_OK) === ST_OK), 'revived player must remain up and never become a spectator');
    }
    assert.equal(a.after(marks[0], m => m.t === 'caught').length, 0, 'no repeated catch during revive protection');
    return { revivedTick, lastProtectedTick: a.tick, stateAtBothPeers: peers.map(p => p.players.get(a.id).st) };
  });

  await check('a locked campus door remains shut and the pursuing capsule never crosses it', async () => {
    b.send({ t: 'debug', op: 'safe', s: 600 });
    await barrier(b);
    const door = campus.doors[5];
    assert.equal(a.doors.get(door.id).locked, true);
    await teleport(a, [door.x, 0, 94.9]);
    await face(a, 0);
    const mark = a.mark();
    a.send({ t: 'debug', op: 'warden', d: 4.5 });
    await ticks(a, 200);
    const positions = a.after(mark, m => m.t === 'snap').flatMap(e => e.m.mobs.filter(w => w.id === 1).map(w => w.p));
    assert.ok(positions.length >= 180, 'recorded ten seconds of genuine pursuit');
    assert.ok(positions.every(p => p[2] < door.box.z0 - .2), `locked-door crossing: ${JSON.stringify(positions.filter(p => p[2] >= door.box.z0 - .2).slice(0, 5))}`);
    assert.ok(peers.every(p => p.doors.get(door.id)?.locked && !p.doors.get(door.id)?.open), 'locked state stays authoritative at both peers');
    assert.equal(a.after(mark, m => m.t === 'caught').length, 0, 'no catch through a locked door');
    return { door: door.id, snapshots: positions.length, furthestZ: Math.max(...positions.map(p => p[2])), boundaryZ: door.box.z0 };
  });

  await check('both peers see a witnessed locker entry, a real inspection pause, extraction and catch', async () => {
    b.send({ t: 'debug', op: 'safe', s: 600 });
    await barrier(b);
    const hide = L1.hides[0], approach = [hide.x + 1, 0, hide.z];
    const start = Array.from({ length: 24 }, (_, i) => {
      const angle = i * Math.PI / 12;
      return [approach[0] + 2.8 * Math.cos(angle), 0, approach[2] + 2.8 * Math.sin(angle)];
    }).find(p => clearCapsule(p, approach));
    assert.ok(start && clearCapsule(approach, approach), 'real locker entry and summon must be outside campus furniture');
    await teleport(a, approach);
    await face(a, Math.atan2(approach[0] - start[0], approach[2] - start[2]));
    a.send({ t: 'debug', op: 'warden', d: 2.8 });
    await ticks(a, 2);
    const mark = a.mark();
    a.send({ t: 'act', kind: 'hide', id: 0 });
    await until(() => peers.every(p => (p.players.get(a.id)?.f ?? 0) & F_HIDE), 'both receive authoritative hidden flags');
    assert.ok(peers.every(p => p.players.get(a.id).st === ST_OK), 'entry cannot catch instantly');
    const hiddenTick = a.tick;
    await until(() => a.after(mark, m => m.t === 'caught' && m.by === 'warden').length, 'observed cabinet search leads to the genuine catch', 12000);
    await until(() => peers.every(p => p.players.get(a.id)?.st === ST_DOWN && !((p.players.get(a.id)?.f ?? 0) & F_HIDE)), 'both receive extraction and down state');
    let previous, still = 0, longestPause = 0;
    const samples = a.after(mark, m => m.t === 'snap');
    for (const { m } of samples) {
      const p = m.mobs.find(w => w.id === 1)?.p;
      const near = p && Math.hypot(p[0] - approach[0], p[2] - approach[2]) <= 1.8;
      still = near && previous && Math.hypot(...p.map((v, i) => v - previous[i])) < .03 ? still + 1 : 0;
      longestPause = Math.max(longestPause, still);
      previous = p;
    }
    assert.ok(longestPause >= 6, `the monster must visibly inspect the locker (pause=${longestPause} ticks)`);
    const caughtTick = a.tick;
    a.send({ t: 'debug', op: 'safe', s: 600 });
    await barrier(a);
    await teleport(b, [a.self().p[0] + .6, a.self().p[1], a.self().p[2]]);
    const deadline = performance.now() + 6500;
    while (a.self().st === ST_DOWN && performance.now() < deadline) { b.send({ t: 'act', kind: 'revive', id: a.id }); await delay(50); }
    assert.equal(a.self().st, ST_OK, 'the cabinet victim remains rescuable');
    return { hide: 0, hiddenTick, caughtTick, inspectionPauseTicks: longestPause, rescuedTick: a.tick };
  });

  await check('the genuine L1 exit still advances both survivors to L2', async () => {
    a.send({ t: 'debug', op: 'safe', s: 600 });
    await barrier(a);
    a.send({ t: 'debug', op: 'key', door: -1 });
    await barrier(a);
    const exit = L1.exit;
    const landing = dx => [exit.x + dx, groundHeight(campusWorld, exit.x + dx, exit.z, NAV_CAPSULE.radius, exit.y + 2), exit.z];
    const positions = [landing(1), landing(1.5)];
    assert.ok(positions.every(p => Math.abs(p[1] - exit.y) < 1.5), 'both real staircase landings must be in the exit height band');
    await teleport(a, positions[0]);
    // levelFlow runs before snapshots: the last survivor entering starts the shared fade immediately.
    // Its forced correction confirms the exact landing; the fade and L2 snapshots confirm both peers below.
    await teleport(b, positions[1], false);
    await until(() => peers.every(p => p.messages.some(e => e.m.t === 'fade' && !e.m.restart)), 'shared genuine level fade');
    await until(() => peers.every(p => p.room?.level === 1), 'both advance to L2', 8000);
    await until(() => peers.every(p => p.self()?.st === ST_OK && Math.abs(p.self().p[1] - 3.6) < .4), 'both L2 spawns are alive');
    return { level: peers.map(p => p.room.level), positions: peers.map(p => p.self().p) };
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error.stack ?? String(error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  report.durationMs = elapsed();
  for (const p of peers) report.trace.push({ peer: p.name, authoritativeSnapshots: p.messages.filter(e => e.m.t === 'snap') });
  await Promise.allSettled(peers.map(p => p.close()));
  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
  await writeFile(new URL('../test-results/search-policy-ws.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log(`RESULT ${report.status.toUpperCase()} (${report.durationMs} ms); external video score: not assessed`);
}
