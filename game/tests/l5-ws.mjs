/**
 * Real L5 acceptance against this tree's externally started dist-server on 4411.
 * Run: node tests/l5-ws.mjs
 * This script never builds, starts, replaces or stops a server.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import { L5, L5_INDEX } from '../shared/levels/l5.ts';
import { GYM_SOLO_S, GYM_WINDOW_S, GYM_TRIP_S } from '../shared/gym.ts';
import { ST_DOWN, ST_OK, ST_SPECTATE } from '../shared/protocol.ts';

const TARGET = `ws://127.0.0.1:${process.env.ESC_TEST_PORT ?? 4386}/ws`;
const peers = [], started = performance.now(), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { target: TARGET, startedAt: new Date().toISOString(), status: 'running', cases: [], trace: [] };
let barrierId = 0;
const elapsed = () => Math.round(performance.now() - started);
const near = (a, b, gap = 0.04) => a && Math.hypot(a[0] - b[0], a[2] - b[2]) < gap;

async function waitFor(predicate, label, timeout = 8000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const failed = peers.find(p => p.fault);
    assert.equal(failed?.fault, undefined, `${failed?.name ?? 'WS'}: ${failed?.fault ?? ''}`);
    const result = predicate(); if (result) return result;
    await delay(15);
  }
  assert.fail(`Timed out after ${timeout} ms: ${label}`);
}

class Peer {
  constructor(name) {
    this.name = name; this.history = []; this.latest = new Map(); this.players = new Map(); this.mobs = new Map(); this.seq = 0;
    this.socket = new WebSocket(TARGET, { handshakeTimeout: 8000 });
    this.opened = new Promise((resolve, reject) => { this.socket.once('open', resolve); this.socket.once('error', reject); });
    this.socket.on('error', error => { this.fault = error.message; });
    this.socket.on('close', (code, reason) => { if (!this.closing) this.fault = `Unexpected close ${code}: ${reason}`; });
    this.socket.on('message', raw => {
      const m = JSON.parse(raw.toString()); this.history.push(m); this.latest.set(m.t, m);
      if (m.t === 'welcome') this.id = m.id;
      if (m.t === 'correct') this.correction = m;
      if (m.t === 'snap') {
        for (const p of m.players) this.players.set(p.id, { ...this.players.get(p.id), ...p, st: p.st ?? ST_OK });
        for (const mob of m.mobs) this.mobs.set(mob.id, { ...this.mobs.get(mob.id), ...mob });
      } else if (m.t !== 'gym' && m.t !== 'nav' && m.t !== 'doors') {
        report.trace.push({ atMs: elapsed(), peer: name, direction: 'receive', message: m });
      }
    });
    peers.push(this);
  }
  get gym() { return this.latest.get('gym'); }
  mark() { return this.history.length; }
  since(mark, predicate) { return this.history.slice(mark).filter(predicate); }
  send(m) {
    assert.equal(this.socket.readyState, WebSocket.OPEN, `${this.name}: socket is not open`);
    report.trace.push({ atMs: elapsed(), peer: this.name, direction: 'send', message: m });
    this.socket.send(JSON.stringify(m));
  }
  async ready() { await this.opened; await waitFor(() => this.id, `${this.name}: welcome`); this.send({ t: 'hello', name: this.name }); return this; }
  after(mark, predicate, label, timeout) { return waitFor(() => this.since(mark, predicate)[0], `${this.name}: ${label}`, timeout); }
  async close() {
    this.closing = true;
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const done = new Promise(resolve => this.socket.once('close', resolve)); this.socket.close();
    await Promise.race([done, delay(750)]); if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate();
  }
}

async function check(name, body) {
  const entry = { name, startedMs: elapsed(), status: 'running' }; report.cases.push(entry);
  try { entry.evidence = await body(); entry.status = 'passed'; console.log(`PASS ${name}`); }
  catch (error) { entry.status = 'failed'; entry.error = error.stack ?? String(error); throw error; }
  finally { entry.durationMs = elapsed() - entry.startedMs; }
}

async function barrier(peer) {
  const mark = peer.mark(), text = `L5WS:${++barrierId}`;
  peer.send({ t: 'chat', text }); await peer.after(mark, m => m.t === 'chat' && m.text === text, 'ordered command barrier');
}
async function ticks(peer, count = 2) {
  const now = peer.gym.now; await waitFor(() => peer.gym.now >= now + count * 0.05 - 1e-8, `${peer.name}: ${count} authoritative ticks`);
}
async function teleport(peer, p) {
  const mark = peer.mark(); peer.send({ t: 'debug', op: 'tp', x: p[0], z: p[2], floor: Math.round(p[1] / 3.6) });
  // A basketball hit can already have queued its own correction. Match the requested placement so
  // that unrelated authoritative correction cannot be mistaken for the debug command's reply.
  const correction = await peer.after(mark, m => m.t === 'correct' && near(m.p, p), 'accepted teleport correction');
  assert.ok(near(correction.p, p), `${peer.name}: debug placement rejected: ${JSON.stringify({ wanted: p, actual: correction.p })}`);
  return correction;
}
async function station(peer, id) {
  const s = L5.gym.switches[id]; await teleport(peer, [s.x + 0.9, s.y, s.z]);
  await waitFor(() => !peer.gym.trips.some(t => t.id === peer.id), `${peer.name}: trip released`);
  const mark = peer.mark(); peer.send({ t: 'act', kind: 'gym-switch', id });
  return peer.after(mark, m => m.t === 'gym' && (m.until[id] > m.now || m.complete), `switch ${id + 1}`);
}
async function createRoom(count) {
  const group = await Promise.all(Array.from({ length: count }, (_, i) => new Peer(`L5同学${peers.length + i + 1}`).ready()));
  const host = group[0]; host.send({ t: 'create' });
  const room = await waitFor(() => host.latest.get('room'), 'created room');
  for (const peer of group.slice(1)) peer.send({ t: 'join', code: room.code });
  await waitFor(() => host.latest.get('room').players.length === count, 'whole lobby joined');
  host.send({ t: 'start' }); await waitFor(() => host.latest.get('snap'), 'real server started');
  const mark = host.mark(); host.send({ t: 'debug', op: 'level5' });
  await host.after(mark, m => m.t === 'room' && m.level === L5_INDEX, 'host L5 entry');
  for (const peer of group) await waitFor(() => peer.gym && peer.latest.get('room').level === L5_INDEX, `${peer.name}: full L5 state`);
  host.send({ t: 'debug', op: 'safe', s: 600 }); await barrier(host);
  return group;
}
async function joinObserver(host, name) {
  const peer = await new Peer(name).ready(); peer.send({ t: 'join', code: host.latest.get('room').code });
  await waitFor(() => peer.gym && peer.players.get(peer.id)?.st === ST_SPECTATE, `${name}: late observer plus full gym state`);
  return peer;
}
async function revive(rescuer, downed) {
  const p = downed.players.get(downed.id).p; await teleport(rescuer, [p[0] + 0.9, p[1], p[2]]);
  const timer = setInterval(() => rescuer.send({ t: 'act', kind: 'revive', id: downed.id }), 50);
  try { await waitFor(() => downed.players.get(downed.id)?.st === ST_OK, 'continuous real-server rescue', 6000); }
  finally { clearInterval(timer); }
  const now = downed.gym.now; await waitFor(() => downed.gym.now >= now + 2, 'rescued player remains alive for 2s');
  assert.equal(downed.players.get(downed.id).st, ST_OK);
}

try {
  await check('Solo switch latches last exactly 20s, spam cannot extend them, and retry completes the real final chapter', async () => {
    const [solo] = await createRoom(1); assert.equal(solo.gym.solo, true);
    await teleport(solo, [L5.exit.x, L5.exit.y, L5.exit.z]); await ticks(solo); assert.equal(solo.history.some(m => m.t === 'fade'), false);
    const first = await station(solo, 0), deadline = first.until[0]; assert.equal(deadline, first.now + GYM_SOLO_S);
    solo.send({ t: 'act', kind: 'gym-switch', id: 0 }); await barrier(solo); assert.equal(solo.gym.until[0], deadline);
    await waitFor(() => solo.gym.until[0] === 0, 'real 20s solo expiry', 22_000); assert.ok(solo.gym.now >= deadline); assert.equal(solo.gym.complete, false);
    for (let id = 0; id < 4; id++) await station(solo, id);
    assert.equal(solo.gym.complete, true);
    const mark = solo.mark(); await teleport(solo, [L5.exit.x, L5.exit.y, L5.exit.z]);
    assert.equal((await solo.after(mark, m => m.t === 'fade', 'solo exit fade')).restart, false);
    assert.deepEqual(await solo.after(mark, m => m.t === 'complete', 'solo final completion'), { t: 'complete', level: 4 });
    await solo.close(); return { latchSeconds: GYM_SOLO_S, deadline, retryCompleted: true, completeLevel: 4 };
  });

  const [a, b] = await createRoom(2); let observer, late;
  await check('Real L5 state preserves two raised monitors and rejects remote, through-wall, forged and out-of-bounds actions', async () => {
    await ticks(a);
    const monitors = [...a.mobs.values()].filter(m => m.kind === 'monitor'); assert.equal(monitors.length, 2);
    for (const monitor of monitors) assert.ok(Math.abs(monitor.p[1] - 0.72) < 0.01);
    a.send({ t: 'act', kind: 'gym-switch', id: 0 }); a.send({ t: 'act', kind: 'gym-switch', id: 99 });
    a.send({ t: 'gym', complete: true, until: [999, 999, 999, 999] }); await barrier(a); await ticks(a);
    assert.deepEqual(a.gym.until, [0, 0, 0, 0]); assert.equal(a.gym.complete, false);
    await teleport(a, [-112.7, 0, 51.6]); a.send({ t: 'act', kind: 'gym-switch', id: 0 }); await barrier(a); await ticks(a);
    assert.equal(a.gym.until[0], 0, 'near but occluded equipment switch must reject');
    const before = [...a.correction.p], mark = a.mark(); a.send({ t: 'debug', op: 'tp', x: -200, z: 60, floor: 0 });
    assert.deepEqual((await a.after(mark, m => m.t === 'correct', 'out-of-bounds correction')).p, before);
    const seq = ++a.seq, inputMark = a.mark(); a.send({ t: 'input', seq, p: [-111.76, 3.6, 49.6], yaw: 0, pitch: 0, f: 0, c: a.correction.c });
    assert.deepEqual((await a.after(inputMark, m => m.t === 'correct' && m.ack === seq, 'other-storey forged input')).p, before);
    observer = await joinObserver(a, 'L5中途观察者'); await teleport(observer, [L5.gym.switches[1].x + 0.9, 0, L5.gym.switches[1].z]);
    observer.send({ t: 'act', kind: 'gym-switch', id: 1 }); await barrier(observer); await ticks(a); assert.equal(a.gym.until[1], 0);
    return { monitors: monitors.map(m => ({ id: m.id, y: m.p[1] })), remoteRejected: true, wallRejected: true, boundsRejected: true, observer: observer.id };
  });

  await check('Two-player stations expire at 5s, non-host entry cannot reset progress, and all four connections share the unlock', async () => {
    const first = await station(a, 0), deadline = first.until[0]; assert.equal(first.solo, false); assert.equal(deadline, first.now + GYM_WINDOW_S);
    a.send({ t: 'act', kind: 'gym-switch', id: 0 }); b.send({ t: 'debug', op: 'level5' });
    await barrier(a); await barrier(b); assert.equal(a.gym.until[0], deadline);
    await waitFor(() => a.gym.until[0] === 0 && b.gym.until[0] === 0, 'real multiplayer expiry', 6500);
    assert.equal(a.gym.complete, false); assert.ok(a.gym.now >= deadline);
    for (let id = 0; id < 4; id++) await station(id % 2 ? b : a, id);
    await waitFor(() => [a, b, observer].every(p => p.gym.complete), 'shared completion');
    assert.deepEqual(a.gym.until, b.gym.until); assert.deepEqual(a.gym.until, observer.gym.until);
    late = await joinObserver(a, 'L5已解锁观察者'); assert.equal(late.gym.complete, true); assert.deepEqual(late.gym.until, a.gym.until);
    return { windowSeconds: GYM_WINDOW_S, deadline, sharedUntil: a.gym.until, lateObserver: late.id };
  });

  await check('Actual rolling basketball trips a player for 1.5s and every peer receives the same sound and authoritative stun', async () => {
    await waitFor(() => a.gym.balls.some(ball => ball.p[2] > 54 && ball.p[2] < 69), 'basketball enters court', 12_000);
    const ball = a.gym.balls.find(ball => ball.p[2] > 54 && ball.p[2] < 69), mark = a.mark();
    await teleport(a, [ball.p[0] + ball.v[0] * 0.1, ball.p[1], ball.p[2] + ball.v[1] * 0.1]);
    const trip = await a.after(mark, m => m.t === 'gym-sound' && m.kind === 'trip' && m.player === a.id, 'real ball impact', 3000);
    await waitFor(() => a.gym.trips.some(t => t.id === a.id), 'server trip deadline');
    const until = a.gym.trips.find(t => t.id === a.id).until;
    assert.ok(until - a.gym.now > 1.3 && until - a.gym.now <= GYM_TRIP_S);
    for (const peer of [b, observer, late]) {
      await waitFor(() => peer.gym.trips.find(t => t.id === a.id)?.until === until, `${peer.name}: identical trip deadline`);
      await waitFor(() => peer.history.some(m => JSON.stringify(m) === JSON.stringify(trip)), `${peer.name}: identical trip event`);
    }
    const frozen = [...a.correction.p], seq = ++a.seq, inputMark = a.mark();
    a.send({ t: 'input', seq, p: [frozen[0] + 0.2, frozen[1], frozen[2]], yaw: 1, pitch: 0, f: 0, c: a.correction.c });
    assert.deepEqual((await a.after(inputMark, m => m.t === 'correct' && m.ack === seq, 'trip rejects forged movement')).p, frozen);
    await waitFor(() => !a.gym.trips.some(t => t.id === a.id), 'trip releases', 3000); assert.ok(a.gym.now >= until);
    return { event: trip, until, tripSeconds: GYM_TRIP_S, sharedPeers: [b.id, observer.id, late.id], frozen };
  });

  await check('Downed teammates still block the exit, rescue remains alive, observers do not block and the real L5 completes once', async () => {
    await teleport(b, [-96, 0, 60]); b.send({ t: 'debug', op: 'down', s: 30 }); await waitFor(() => b.players.get(b.id)?.st === ST_DOWN, 'teammate down');
    await teleport(a, [L5.exit.x, L5.exit.y, L5.exit.z]); await ticks(a, 3);
    assert.equal(a.history.some(m => m.t === 'fade'), false, 'a downed teammate outside the exit must still be gathered');
    await revive(a, b); await teleport(a, [L5.exit.x, L5.exit.y, L5.exit.z]); await ticks(a, 3);
    assert.equal(a.history.some(m => m.t === 'fade'), false, 'standing teammate remains outside');
    const group = [a, b, observer, late], marks = group.map(p => p.mark());
    await teleport(b, [L5.exit.x, L5.exit.y, L5.exit.z]);
    const fades = await Promise.all(group.map((p, i) => p.after(marks[i], m => m.t === 'fade', 'whole-team fade')));
    for (const fade of fades) assert.deepEqual(fade, { t: 'fade', secs: 3, restart: false });
    const completions = await Promise.all(group.map((p, i) => p.after(marks[i], m => m.t === 'complete', 'real campaign completion')));
    for (const complete of completions) assert.deepEqual(complete, { t: 'complete', level: L5_INDEX });
    await delay(250);
    for (const peer of group) assert.equal(peer.history.filter(m => m.t === 'complete').length, 1);
    return { downedBlocked: true, rescueStayedAliveSeconds: 2, observersExcluded: [observer.id, late.id], completion: completions[0] };
  });
  await Promise.all([a, b, observer, late].map(peer => peer.close()));

  await check('Four active teammates each press one station inside 5s and only the final survivor arrival opens the exit', async () => {
    const team = await createRoom(4), host = team[0], presses = [];
    for (const peer of team) assert.equal(peer.players.get(peer.id).st, ST_OK, 'all four participants must be active players');
    for (let id = 0; id < 4; id++) {
      const state = await station(team[id], id);
      assert.equal(state.solo, false); assert.equal(state.until[id], state.now + GYM_WINDOW_S);
      presses.push({ player: team[id].id, station: id, pressedAt: state.now, deadline: state.until[id] });
    }
    assert.ok(presses[3].pressedAt < presses[0].deadline, 'four distinct players must finish before the first 5s deadline');
    await waitFor(() => team.every(peer => peer.gym.complete), 'four-player shared unlock');
    for (const peer of team) assert.deepEqual(peer.gym.until, host.gym.until);
    for (const peer of team.slice(0, 3)) await teleport(peer, [L5.exit.x, L5.exit.y, L5.exit.z]);
    await ticks(host, 3);
    for (const peer of team) assert.equal(peer.history.some(m => m.t === 'fade'), false, 'three arrivals cannot leave the fourth active teammate behind');
    assert.ok(!near(team[3].players.get(team[3].id).p, [L5.exit.x, L5.exit.y, L5.exit.z], 1.1));
    const marks = team.map(peer => peer.mark()); await teleport(team[3], [L5.exit.x, L5.exit.y, L5.exit.z]);
    const fades = await Promise.all(team.map((peer, i) => peer.after(marks[i], m => m.t === 'fade', 'four-player final arrival fade')));
    for (const fade of fades) assert.deepEqual(fade, { t: 'fade', secs: 3, restart: false });
    const completed = await Promise.all(team.map((peer, i) => peer.after(marks[i], m => m.t === 'complete', 'four-player campaign completion')));
    for (const message of completed) assert.deepEqual(message, { t: 'complete', level: L5_INDEX });
    await Promise.all(team.map(peer => peer.close()));
    return { activePlayers: team.map(peer => peer.id), presses, lastArrivalRequired: true, completion: completed[0] };
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.stack ?? String(error); console.error(report.error); process.exitCode = 1;
} finally {
  await Promise.all(peers.map(p => p.close())); report.durationMs = elapsed();
  await mkdir('test-results', { recursive: true }); await writeFile('test-results/l5-ws.json', JSON.stringify(report, null, 2));
  console.log(`L5 WS ${report.status}: ${report.cases.filter(c => c.status === 'passed').length}/${report.cases.length} in ${(report.durationMs / 1000).toFixed(1)}s`);
}
