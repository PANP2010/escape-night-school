/**
 * Real WebSocket acceptance test for an externally started L4 preview.
 * Start the preview separately on 4294 with --l4-preview, then run:
 *   node tests/l4-ws.mjs > test-results/l4-ws.log 2>&1
 * This script never builds or starts a server. Results stay in test-results/.
 * There is no roll-call debug command, so the test waits for the real 60–90 s schedule.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import { L4, L4_INDEX } from '../shared/levels/l4.ts';
import { F_HIDE, ST_DOWN, ST_OK, ST_SPECTATE } from '../shared/protocol.ts';

const WS_URL = `ws://127.0.0.1:${process.env.ESC_TEST_PORT ?? 4294}/ws`;
const REFUSED_ERROR = '操作过快或已离开广播台，请靠近后稍等一秒再试';
const RESULT = fileURLToPath(new URL('../test-results/l4-ws.json', import.meta.url));
const def = L4.broadcast;
assert.ok(def, 'L4 must define the broadcasting puzzle');
assert.equal(L4_INDEX, 3, 'The preview must use the genuine zero-based L4 index');

const startedAt = performance.now();
const elapsed = () => Math.round(performance.now() - startedAt);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const peers = [];
const report = { target: WS_URL, startedAt: new Date().toISOString(), status: 'running', cases: [], trace: [] };
let barrierSeq = 0;

function compact(m) {
  if (m.t === 'nav') return { t: m.t, nodes: m.n.length / 3, adjacencyRows: m.adj.length };
  if (m.t === 'doors') return { t: m.t, count: m.doors.length };
  return m;
}

class Peer {
  constructor(name) {
    this.name = name;
    this.history = [];
    this.latest = new Map();
    this.players = new Map();
    this.mobs = new Map();
    this.seq = 0;
    this.closing = false;
    this.socket = new WebSocket(WS_URL, { handshakeTimeout: 8000 });
    this.opened = new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
    this.socket.on('error', error => { this.fault = error.message; });
    this.socket.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      if (!this.closing) this.fault = `Unexpected WS close ${code}: ${reason}`;
    });
    this.socket.on('message', raw => {
      let m;
      try { m = JSON.parse(raw.toString()); }
      catch (error) { this.fault = `Invalid JSON from server: ${error.message}`; return; }
      this.history.push({ atMs: elapsed(), m });
      this.latest.set(m.t, m);
      if (m.t === 'welcome') this.id = m.id;
      if (m.t === 'correct') this.correction = m;
      if (m.t === 'snap') {
        for (const p of m.players) {
          const old = this.players.get(p.id);
          this.players.set(p.id, { ...old, ...p, f: p.f ?? old?.f ?? 0, st: p.st ?? ST_OK });
        }
        for (const mob of m.mobs) this.mobs.set(mob.id, { ...this.mobs.get(mob.id), ...mob });
      } else report.trace.push({ atMs: elapsed(), peer: name, direction: 'receive', message: compact(m) });
    });
    peers.push(this);
  }
  mark() { return this.history.length; }
  last(type) { return this.latest.get(type); }
  since(mark, predicate) { return this.history.slice(mark).filter(e => predicate(e.m)).map(e => e.m); }
  send(m) {
    assert.equal(this.socket.readyState, WebSocket.OPEN, `${this.name}: socket is not open`);
    report.trace.push({ atMs: elapsed(), peer: this.name, direction: 'send', message: m });
    this.socket.send(JSON.stringify(m));
  }
  async waitAfter(mark, predicate, label, timeout = 8000) {
    return waitFor(() => this.since(mark, predicate)[0], `${this.name}: ${label}`, timeout);
  }
  async close() {
    this.closing = true;
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise(resolve => this.socket.once('close', resolve));
    this.socket.close();
    await Promise.race([closed, delay(750)]);
    if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate();
  }
}

async function waitFor(predicate, label, timeout = 8000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const failed = peers.find(p => p.fault);
    assert.equal(failed?.fault, undefined, `${failed?.name ?? 'WS'}: ${failed?.fault ?? ''}`);
    const result = predicate();
    if (result) return result;
    await delay(15);
  }
  assert.fail(`Timed out after ${timeout} ms: ${label}`);
}

async function check(name, body) {
  const entry = { name, startedMs: elapsed(), status: 'running' };
  report.cases.push(entry);
  try {
    entry.evidence = await body();
    entry.status = 'passed';
    entry.durationMs = elapsed() - entry.startedMs;
    console.log(`PASS ${name} (${entry.durationMs} ms)`);
  } catch (error) {
    entry.status = 'failed';
    entry.durationMs = elapsed() - entry.startedMs;
    entry.error = error.stack ?? String(error);
    throw error;
  }
}

async function connect(name) {
  const peer = new Peer(name);
  await peer.opened;
  await waitFor(() => peer.id, `${name}: welcome`);
  peer.send({ t: 'hello', name });
  return peer;
}

// WS frame ordering makes this a server-handled action barrier, including silent refusals.
async function barrier(sender, recipients, label) {
  const text = `L4WS:${++barrierSeq}:${label}`;
  const marks = recipients.map(p => p.mark());
  sender.send({ t: 'chat', text });
  await Promise.all(recipients.map((p, i) => p.waitAfter(marks[i], m => m.t === 'chat' && m.from === sender.id && m.text === text, label)));
}

async function ticks(peer, count = 8) {
  const tick = peer.last('snap')?.tick ?? 0;
  await waitFor(() => (peer.last('snap')?.tick ?? 0) >= tick + count, `${peer.name}: ${count} authoritative ticks`);
}

const at = (p, dz = 0, y = p.y) => ({ x: p.x, y, z: p.z + dz });
const near = (p, q, tolerance = .08) => Array.isArray(p) && Math.hypot(p[0] - q.x, p[1] - q.y, p[2] - q.z) < tolerance;

async function teleport(peer, point, { snapshot = true, timeout = 8000 } = {}) {
  const mark = peer.mark();
  peer.send({ t: 'debug', op: 'tp', x: point.x, z: point.z, floor: Math.round(point.y / 3.6) });
  const corrected = await peer.waitAfter(mark, m => m.t === 'correct' && m.forced === true,
    'debug teleport correction (debug is disabled under NODE_ENV=production; use a development preview)', timeout);
  assert.ok(near(corrected.p, point), `${peer.name}: refused/wrong-floor teleport; expected ${JSON.stringify(point)}, got ${JSON.stringify(corrected.p)}`);
  if (snapshot) await peer.waitAfter(mark, m => m.t === 'snap' && m.players.some(p => p.id === peer.id && near(p.p, point)), 'teleport in authoritative snapshot', timeout);
}

function assertStation(station) {
  assert.ok(station, 'Expected a full broadcast snapshot');
  assert.deepEqual(Object.keys(station).sort(), ['call', 'clues', 'nextIn', 'off', 't'], 'Broadcast snapshots must not disclose unread password data');
  assert.equal(station.t, 'broadcast');
  assert.equal(typeof station.off, 'boolean');
  assert.ok(Array.isArray(station.clues) && station.clues.length === 4);
  assert.ok(station.clues.every(c => c === null || /^\d$/.test(c)));
  assert.ok(Number.isInteger(station.nextIn) && station.nextIn >= 0 && station.nextIn <= 90);
  if (station.call) {
    assert.deepEqual(Object.keys(station.call).sort(), (station.call.shielded ? ['id', 'left', 'shielded'] : ['id', 'left', 'p', 'shielded']).sort());
    assert.ok(Number.isInteger(station.call.id) && station.call.id > 0);
    assert.ok(Number.isInteger(station.call.left) && station.call.left > 0 && station.call.left <= def.reveal);
    if (!station.call.shielded) assert.ok(Array.isArray(station.call.p) && station.call.p.length === 3 && station.call.p.every(Number.isFinite));
  }
}

function assertClues(recipients, expected, off = false) {
  for (const p of recipients) {
    const station = p.last('broadcast');
    assertStation(station);
    assert.deepEqual(station.clues, expected, `${p.name}: shared sticker state`);
    assert.equal(station.off, off, `${p.name}: station off state`);
  }
}

function assertNoFade(recipients) {
  for (const p of recipients) assert.equal(p.history.some(e => e.m.t === 'fade'), false, `${p.name}: exit advanced before all conditions were met`);
}

async function hidden(peer, recipients, value) {
  await waitFor(() => recipients.every(p => !!(p.players.get(peer.id)?.f & F_HIDE) === value), `${peer.name}: authoritative hiding=${value} on every client`);
}

function assertPlayersOK(activePlayers, recipients, label) {
  for (const recipient of recipients) for (const player of activePlayers) {
    assert.equal(recipient.players.get(player.id)?.st, ST_OK, `${label}: ${recipient.name} must see ${player.name} active; an NPC catch must not be mistaken for puzzle refusal`);
  }
}

async function revive(rescuer, downed, recipients) {
  const interval = setInterval(() => rescuer.send({ t: 'act', kind: 'revive', id: downed.id }), 150);
  try {
    rescuer.send({ t: 'act', kind: 'revive', id: downed.id });
    await waitFor(() => recipients.every(p => p.players.get(downed.id)?.st === ST_OK), `${downed.name}: actual held revive`, 7000);
  } finally { clearInterval(interval); }
  // A real revival replaces safeUntil with the normal five-second grace; restore this test's NPC isolation.
  downed.send({ t: 'debug', op: 'safe', s: 180 });
  await barrier(downed, recipients, `safe-after-revive-${downed.id}`);
}

async function fullState(peer, mark, reference, code, memberCount) {
  const required = ['room', 'items', 'keys', 'bag', 'power', 'doors', 'nav', 'broadcast', 'snap'];
  await waitFor(() => required.every(t => peer.since(mark, m => m.t === t).length), `${peer.name}: complete join state`, 15000);
  const room = peer.last('room');
  assert.equal(room.code, code); assert.equal(room.level, 3); assert.equal(room.started, true);
  assert.equal(room.players.length, memberCount);
  const nav = peer.last('nav');
  assert.ok(nav.n.length > 0 && nav.n.length % 3 === 0);
  assert.equal(nav.adj.length, nav.n.length / 3);
  assert.ok(nav.n.every(Number.isFinite));
  assert.ok(nav.adj.every(row => Array.isArray(row) && row.every(id => Number.isInteger(id) && id >= 0 && id < nav.adj.length)));
  const floors = nav.n.filter((_, i) => i % 3 === 1);
  assert.ok(floors.some(y => Math.abs(y - 720) < 10) && floors.some(y => Math.abs(y - 1080) < 10), 'Full nav must include both real L4 floors');
  assert.ok(peer.last('doors').doors.length > 0, 'Full door state must be present');
  assertStation(peer.last('broadcast'));
  if (reference) {
    for (const type of ['items', 'keys', 'bag', 'power', 'doors', 'nav']) assert.deepEqual(peer.last(type), reference.last(type), `${peer.name}: late-join ${type} full state`);
    assert.deepEqual(peer.last('broadcast').clues, reference.last('broadcast').clues);
    assert.equal(peer.last('broadcast').off, reference.last('broadcast').off);
    assert.equal(peer.players.get(peer.id)?.st, ST_SPECTATE, 'Late joiner must observe the running level');
  }
}

let a, b, c, d, code, expected = [null, null, null, null], answer;
try {
  await check('Two real WS players start the independent L4 preview at index 3', async () => {
    [a, b] = await Promise.all([connect('广播甲'), connect('广播乙')]);
    const createMark = a.mark(); a.send({ t: 'create' });
    const room = await a.waitAfter(createMark, m => m.t === 'room', 'create lobby', 45000);
    assert.equal(room.level, 3, 'Server must run --l4-preview, not a fake L3');
    assert.equal(room.started, false); assert.equal(room.host, a.id); assert.match(room.code, /^[A-Z2-9]{4}$/);
    code = room.code; report.roomCode = code;
    const joinMark = b.mark(); b.send({ t: 'join', code });
    await b.waitAfter(joinMark, m => m.t === 'room' && m.players.length === 2, 'join lobby');
    await waitFor(() => a.last('room')?.players.length === 2, 'host sees teammate');
    assert.deepEqual(a.last('room'), b.last('room'));
    const marks = [a.mark(), b.mark()]; a.send({ t: 'start' });
    await Promise.all([fullState(a, marks[0], null, code, 2), fullState(b, marks[1], null, code, 2)]);
    assertClues([a, b], expected);
    for (const p of [a, b]) {
      assert.equal(p.last('broadcast').call, null);
      assert.ok(p.last('broadcast').nextIn >= 60, 'First call cannot begin before 60 server seconds');
      assert.deepEqual([...p.players.keys()].sort((x, y) => x - y), [a.id, b.id].sort((x, y) => x - y));
      assert.ok([...p.players.values()].every(q => q.st === ST_OK));
    }
    // Check the authority before the first state-changing debug command, with a short failure deadline.
    const [x, y, z] = a.players.get(a.id).p;
    await teleport(a, { x, y, z }, { timeout: 2500 });
    a.send({ t: 'debug', op: 'safe', s: 180 }); await barrier(a, [a, b], 'safe');
    await waitFor(() => a.mobs.get(1)?.form === 'rollcall', 'L4 real monster rollcall form');
    return { level: room.level, players: [a.id, b.id], firstCallSeconds: a.last('broadcast').nextIn };
  });

  await check('All players at the exit and a stair key cannot bypass an active station', async () => {
    await teleport(a, at(L4.exit)); await teleport(b, at(L4.exit));
    a.send({ t: 'debug', op: 'key', door: -1 }); await barrier(a, [a, b], 'key-does-not-stop-broadcast');
    for (const p of [a, b]) assert.equal(p.last('bag').bag.stair_key, 1);
    await ticks(a); assertClues([a, b], expected); assertNoFade([a, b]);
    return { off: false, stairKey: 1, bothAtExit: true };
  });

  await check('Ordinary movement packets cannot jump through the slab in either direction', async () => {
    const evidence = [];
    for (const y of [7.2, 10.8]) {
      const from = { x: L4.spawns[0].x, y, z: L4.spawns[0].z };
      await teleport(a, from);
      const mark = a.mark(), forged = [from.x, y === 7.2 ? 10.8 : 7.2, from.z];
      a.send({ t: 'input', seq: ++a.seq, p: forged, yaw: 0, pitch: 0, f: 0, c: a.correction.c });
      const correction = await a.waitAfter(mark, m => m.t === 'correct' && m.ack === a.seq, 'reject ordinary cross-floor movement');
      assert.ok(near(correction.p, from), 'Refused vertical movement must retain the real floor');
      await ticks(a, 4);
      for (const p of [a, b]) assert.ok(near(p.players.get(a.id)?.p, from), `${p.name}: the authoritative position must remain on the original floor`);
      evidence.push({ forged, retained: correction.p, correctionEpoch: correction.c });
    }
    assertClues([a, b], expected); assertNoFade([a, b]);
    return evidence;
  });

  await check('A reachable keypad rejects submission before all four stickers are read', async () => {
    assertPlayersOK([a, b], [a, b], 'Missing-clue keypad phase');
    await teleport(a, at(def.console, -.8)); const mark = a.mark();
    a.send({ t: 'broadcast', op: 'code', code: '0000' }); await barrier(a, [a, b], 'missing-clues');
    const errors = a.since(mark, m => m.t === 'error');
    assert.deepEqual(errors, [{ t: 'error', msg: '先读齐四张编号贴纸' }]);
    assertClues([a, b], expected); assertNoFade([a, b]);
    return { error: errors[0].msg };
  });

  await check('Remote, malformed, and same-XZ cross-floor sticker reads are refused', async () => {
    await teleport(a, at(L4.exit));
    for (const id of [0, 1, 2, 3, -1, 4, .5, '0']) a.send({ t: 'broadcast', op: 'read', id });
    await barrier(a, [a, b], 'remote-read'); await ticks(a, 3); assertClues([a, b], expected);
    for (const id of [0, 2]) {
      const s = def.stickers[id], otherY = s.y === 7.2 ? 10.8 : 7.2;
      await teleport(a, at(s, s.face === 'z+' ? .6 : -.6, otherY));
      a.send({ t: 'broadcast', op: 'read', id }); await barrier(a, [a, b], `wrong-floor-read-${id}`);
      assertClues([a, b], expected);
    }
    return { remoteIds: [0, 1, 2, 3], rejectedInvalidIds: [-1, 4, .5, '0'], crossFloorIds: [0, 2] };
  });

  await check('Cross-floor hiding is refused and authoritative hiding blocks a reachable sticker', async () => {
    const h = L4.hides[1]; await teleport(a, at(h));
    a.send({ t: 'act', kind: 'hide', id: 0 }); await barrier(a, [a, b], 'wrong-floor-hide'); await ticks(a, 3);
    await hidden(a, [a, b], false);
    a.send({ t: 'act', kind: 'hide', id: 1 }); await hidden(a, [a, b], true);
    a.send({ t: 'broadcast', op: 'read', id: 2 }); await barrier(a, [a, b], 'hidden-read'); assertClues([a, b], expected);
    a.send({ t: 'act', kind: 'unhide', id: 1 }); await hidden(a, [a, b], false);
    // The identical location is in genuine reach of sticker 2; a subsequent legal read proves it below.
    return { sameXZWrongFloorHide: false, realHide: true, hiddenReadClues: [...expected] };
  });

  await check('A downed player cannot read a reachable sticker; actual teammate revival restores play', async () => {
    await teleport(a, at(def.stickers[2], .6)); await teleport(b, at(def.stickers[2], .6));
    a.send({ t: 'debug', op: 'down', s: 30 });
    await waitFor(() => [a, b].every(p => p.players.get(a.id)?.st === ST_DOWN), 'downed state shared');
    a.send({ t: 'broadcast', op: 'read', id: 2 }); await barrier(a, [a, b], 'downed-read'); assertClues([a, b], expected);
    await revive(b, a, [a, b]);
    return { downedReadClues: [...expected], revivedState: a.players.get(a.id).st };
  });

  await check('Alternating players read four numbered stickers and both clients receive every shared digit', async () => {
    for (const id of [0, 1, 2, 3]) {
      const reader = id % 2 ? b : a, s = def.stickers[id];
      // Read sticker 2 from the locker position used above to prove hidden refusal was not a distance refusal.
      await teleport(reader, id === 2 ? at(L4.hides[1]) : at(s, s.face === 'z+' ? .6 : -.6));
      if (id === 0) {
        reader.send({ t: 'input', seq: ++reader.seq, p: [...reader.players.get(reader.id).p], yaw: 0, pitch: 0, f: F_HIDE, c: reader.correction.c });
        await barrier(reader, [a, b], 'forged-hide-flag'); await ticks(reader, 2); await hidden(reader, [a, b], false);
      }
      reader.send({ t: 'broadcast', op: 'read', id });
      await waitFor(() => [a, b].every(p => typeof p.last('broadcast')?.clues[id] === 'string'), `shared sticker ${id}`);
      expected[id] = a.last('broadcast').clues[id]; assertClues([a, b], expected);
      const duplicateMark = reader.mark(); reader.send({ t: 'broadcast', op: 'read', id });
      await barrier(reader, [a, b], `duplicate-read-${id}`); assertClues([a, b], expected);
      assert.equal(reader.since(duplicateMark, m => m.t === 'error').length, 0);
    }
    answer = expected.join(''); assert.match(answer, /^\d{4}$/);
    return { sharedClues: [...expected], order: [0, 1, 2, 3], forgedHideFlagAccepted: false };
  });

  await check('A natural roll call tracks movement, shields authoritative hiding, and sends current state to a late observer', async () => {
    assertPlayersOK([a, b], [a, b], 'Before natural roll call');
    await teleport(a, at(L4.hides[0])); await teleport(b, at(L4.hides[1]));
    const initialNext = a.last('broadcast').nextIn;
    console.log(`Waiting for real roll call (nextIn=${initialNext}s; no schedule debug interface).`);
    const call = await waitFor(() => a.last('broadcast')?.call, 'natural 60–90 second roll call', (initialNext + 6) * 1000);
    assertPlayersOK([a, b], [a, b], 'Natural roll call began');
    assert.ok([a.id, b.id].includes(call.id)); assert.equal(call.shielded, false); assert.ok(call.left >= 9);
    const target = call.id === a.id ? a : b;
    const monsterBefore = structuredClone(a.mobs.get(1));
    const shelters = target === a ? [0, 2] : [1, 3];
    const shelterId = shelters.sort((i, j) => Math.hypot(L4.hides[j].x - monsterBefore.p[0], L4.hides[j].z - monsterBefore.p[2]) - Math.hypot(L4.hides[i].x - monsterBefore.p[0], L4.hides[i].z - monsterBefore.p[2]))[0];
    const h = L4.hides[shelterId];
    await waitFor(() => b.last('broadcast')?.call?.id === target.id, 'same call on teammate');
    await teleport(target, { x: h.x + .35, y: h.y, z: h.z - .35 });
    await waitFor(() => [a, b].every(p => near(p.last('broadcast')?.call?.p, { x: h.x + .35, y: h.y, z: h.z - .35 })), 'live exposed location tracks server movement');
    await waitFor(() => [a, b].every(p => p.mobs.get(1)?.anim === 'investigate'), 'the real monster investigates a naturally broadcast location', 2000);
    await waitFor(() => Math.hypot(...a.mobs.get(1).p.map((n, i) => n - monsterBefore.p[i])) > .15, 'the investigating monster actually moves in authoritative snapshots', 2000);
    const monsterResponse = structuredClone(a.mobs.get(1));
    target.send({ t: 'input', seq: ++target.seq, p: [...target.players.get(target.id).p], yaw: 0, pitch: 0, f: F_HIDE, c: target.correction.c });
    await barrier(target, [a, b], 'call-forged-hide'); await ticks(target, 2); await hidden(target, [a, b], false);
    for (const p of [a, b]) { assert.equal(p.last('broadcast').call?.shielded, false); assert.ok(p.last('broadcast').call?.p); }
    target.send({ t: 'act', kind: 'hide', id: shelterId }); await hidden(target, [a, b], true);
    await waitFor(() => [a, b].every(p => p.last('broadcast')?.call?.shielded === true), 'hide shields call on both clients');
    for (const p of [a, b]) { assertStation(p.last('broadcast')); assert.equal('p' in p.last('broadcast').call, false); }
    c = await connect('广播晚到丙'); const mark = c.mark(); c.send({ t: 'join', code });
    await fullState(c, mark, a, code, 3);
    assert.equal(c.last('broadcast').call?.id, target.id); assert.equal(c.last('broadcast').call?.shielded, true);
    assert.equal('p' in c.last('broadcast').call, false, 'Late observer must not receive a shielded target location');
    const shieldedLeft = c.last('broadcast').call.left;
    target.send({ t: 'act', kind: 'unhide', id: shelterId }); await hidden(target, [a, b, c], false);
    await waitFor(() => [a, b, c].every(p => p.last('broadcast')?.call?.id === target.id && p.last('broadcast').call.shielded === false && p.last('broadcast').call.p), 'unhide resumes remaining exposure');
    assert.ok(a.last('broadcast').call.left <= shieldedLeft, 'Unhide must not reset the ten-second call');
    await waitFor(() => [a, b, c].every(p => p.last('broadcast')?.call === null), 'natural exposure expiry', (a.last('broadcast').call.left + 3) * 1000);
    assertClues([a, b, c], expected); assertNoFade([a, b, c]);
    return { target: target.id, initialNextSeconds: initialNext, shelterId, monsterBefore, monsterResponse, shieldedLocationOmitted: true, observerState: c.players.get(c.id).st, expiredNaturally: true };
  });

  await check('Known correct codes are refused remotely and at the same XZ on the wrong floor', async () => {
    assertPlayersOK([a, b], [a, b, c], 'Remote and cross-floor keypad phase');
    await teleport(a, at(L4.exit)); const remoteMark = a.mark();
    a.send({ t: 'broadcast', op: 'code', code: answer }); await barrier(a, [a, b, c], 'remote-code'); assertClues([a, b, c], expected);
    assert.deepEqual(a.since(remoteMark, m => m.t === 'error'), [{ t: 'error', msg: REFUSED_ERROR }], 'Remote code submission must return exactly one private refusal');
    await teleport(a, at(def.console, -.8, 7.2)); const floorMark = a.mark();
    a.send({ t: 'broadcast', op: 'code', code: answer }); await barrier(a, [a, b, c], 'wrong-floor-code'); await ticks(a, 3);
    assert.deepEqual(a.since(floorMark, m => m.t === 'error'), [{ t: 'error', msg: REFUSED_ERROR }], 'Cross-floor code submission must return exactly one private refusal');
    assertClues([a, b, c], expected); assertNoFade([a, b, c]);
    return { correctCodeRemoteAccepted: false, sameXZWrongFloorAccepted: false, remoteErrors: 1, crossFloorErrors: 1, refusalMessage: REFUSED_ERROR };
  });

  await check('Malformed codes are dropped; a wrong code reports failure and immediately correct retry is cooled down', async () => {
    assertPlayersOK([a, b], [a, b, c], 'Wrong-code and cooldown keypad phase');
    await teleport(a, at(def.console, -.8)); const malformedMark = a.mark();
    for (const invalid of ['123', '12345', 'abcd', 1234, null, '\n1234', '１２３４']) a.send({ t: 'broadcast', op: 'code', code: invalid });
    await barrier(a, [a, b, c], 'malformed-codes');
    assert.equal(a.since(malformedMark, m => m.t === 'error').length, 0); assertClues([a, b, c], expected);
    const wrong = String((Number(answer) + 1) % 10000).padStart(4, '0'); assert.notEqual(wrong, answer);
    const mark = a.mark(), tick = a.last('snap').tick;
    // Same ordered WS stream: both submissions reach the server before the chat acknowledgement.
    a.send({ t: 'broadcast', op: 'code', code: wrong }); a.send({ t: 'broadcast', op: 'code', code: answer });
    await barrier(a, [a, b, c], 'wrong-code-and-cooled-retry');
    assert.deepEqual(a.since(mark, m => m.t === 'error'), [
      { t: 'error', msg: '密码错误，广播惊动了角色074' },
      { t: 'error', msg: REFUSED_ERROR },
    ], 'Wrong code and cooled-down retry must each return their exact ordered private error');
    assertClues([a, b, c], expected); assertNoFade([a, b, c]);
    const cooldownTicks = Math.max(0, 23 - (a.last('snap').tick - tick)); if (cooldownTicks) await ticks(a, cooldownTicks);
    return { wrongErrorCount: 1, cooldownErrorCount: 1, immediateCorrectRetryAccepted: false, serverTicksBeforeRetry: a.last('snap').tick - tick };
  });

  await check('The collected ordered password stops the station for everyone and a new observer receives full stopped state', async () => {
    assertPlayersOK([a, b], [a, b, c], 'Legal stopping-code keypad phase');
    a.send({ t: 'broadcast', op: 'code', code: answer });
    await waitFor(() => [a, b, c].every(p => p.last('broadcast')?.off === true), 'legal password stops broadcast on all clients');
    for (const p of [a, b, c]) { assertStation(p.last('broadcast')); assert.equal(p.last('broadcast').call, null); assert.equal(p.last('broadcast').nextIn, 0); }
    assertClues([a, b, c], expected, true);
    d = await connect('广播晚到丁'); const mark = d.mark(); d.send({ t: 'join', code }); await fullState(d, mark, a, code, 4);
    assertClues([a, b, c, d], expected, true); assert.equal(d.last('broadcast').call, null); assert.equal(d.last('broadcast').nextIn, 0);
    const attemptMark = a.mark(); a.send({ t: 'broadcast', op: 'code', code: answer }); await barrier(a, [a, b, c, d], 'repeat-stopped-code');
    assert.equal(a.since(attemptMark, m => m.t === 'error').length, 0); assertClues([a, b, c, d], expected, true);
    return { off: true, nextIn: 0, lateObservers: [c.id, d.id], fullBag: d.last('bag').bag };
  });

  await check('The 3F exit requires every living survivor, rejects cross-floor gathering, and includes downed survivors', async () => {
    await teleport(a, at(L4.exit)); await ticks(a); assertNoFade([a, b, c, d]);
    await teleport(b, at(L4.exit, 0, 10.8)); await ticks(a); assertNoFade([a, b, c, d]);
    b.send({ t: 'debug', op: 'down', s: 30 });
    await waitFor(() => [a, b, c, d].every(p => p.players.get(b.id)?.st === ST_DOWN), 'cross-floor survivor downed');
    await ticks(a); assertNoFade([a, b, c, d]);
    await teleport(a, at(L4.exit, 0, 10.8)); await revive(a, b, [a, b, c, d]);
    await teleport(a, at(L4.exit)); await ticks(a, 3); assertNoFade([a, b, c, d]);
    // The final arrival immediately starts fade, which deliberately freezes ordinary snapshots.
    const marks = [a, b, c, d].map(p => p.mark()); await teleport(b, at(L4.exit), { snapshot: false });
    const fades = await Promise.all([a, b, c, d].map((p, i) => p.waitAfter(marks[i], m => m.t === 'fade', 'whole-team exit fade')));
    for (const fade of fades) { assert.equal(fade.restart, false); assert.ok(Number.isFinite(fade.secs) && fade.secs > 0); }
    assert.ok(fades.every(f => JSON.stringify(f) === JSON.stringify(fades[0])));
    for (const p of [c, d]) { assert.equal(p.players.get(p.id)?.st, ST_SPECTATE); assert.ok(!near(p.players.get(p.id)?.p, at(L4.exit), 1.1), 'Observers must not need to gather at the exit'); }
    return { missingSurvivorBlocked: true, wrongFloorBlocked: true, downedSurvivorBlocked: true, allSurvivorsFade: fades[0], spectatorsExcluded: [c.id, d.id] };
  });

  await check('Only the five intentional password errors occurred and no protected player was caught', async () => {
    assert.deepEqual(a.history.filter(e => e.m.t === 'error').map(e => e.m.msg), [
      '先读齐四张编号贴纸',
      REFUSED_ERROR,
      REFUSED_ERROR,
      '密码错误，广播惊动了角色074',
      REFUSED_ERROR,
    ]);
    for (const p of [b, c, d]) assert.equal(p.history.filter(e => e.m.t === 'error').length, 0, `${p.name}: unexpected server error`);
    for (const p of [a, b, c, d]) assert.equal(p.history.some(e => e.m.t === 'caught'), false, `${p.name}: safe debug did not isolate NPC interference`);
    return { intentionalErrors: 5, caught: 0 };
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error.stack ?? String(error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  report.durationMs = elapsed();
  report.clients = peers.map(p => ({ name: p.name, id: p.id, fault: p.fault, messages: p.history.length,
    room: p.last('room'), broadcast: p.last('broadcast'), correction: p.correction,
    players: [...p.players.values()], mobs: [...p.mobs.values()], lastMessages: p.history.slice(-12).map(e => ({ atMs: e.atMs, m: compact(e.m) })) }));
  await Promise.allSettled(peers.map(p => p.close()));
  await mkdir(fileURLToPath(new URL('../test-results/', import.meta.url)), { recursive: true });
  await writeFile(RESULT, JSON.stringify(report, null, 2) + '\n');
  console.log(`L4 WS ${report.status}: ${report.cases.filter(c => c.status === 'passed').length}/${report.cases.length} cases in ${(report.durationMs / 1000).toFixed(1)} s; ${RESULT}`);
}
