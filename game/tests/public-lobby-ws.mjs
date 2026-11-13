/**
 * Real protocol acceptance with three concurrent WebSocket clients.
 * Build and start this tree's server on 4431 first, then run:
 *   node tests/public-lobby-ws.mjs
 * No server is started here, and evidence stays in this tree's test-results/.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';

const WS_URL = 'ws://127.0.0.1:4431/ws';
const report = { target: WS_URL, status: 'running', startedAt: new Date().toISOString(), maxConcurrentPeers: 0, cases: [], trace: [] };
const started = performance.now();
let peers = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const elapsed = () => Math.round(performance.now() - started);

/** Evidence must never persist reconnect credentials or future welcome fields. */
function traceMessage(message) {
  if (message.t === 'welcome') return { t: 'welcome', id: message.id };
  const scrub = value => {
    if (Array.isArray(value)) return value.map(scrub);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/token|secret|credential|authorization|cookie/i.test(key))
      .map(([key, item]) => [key, scrub(item)]));
  };
  return scrub(message);
}

class Peer {
  constructor(name) {
    this.name = name;
    this.messages = [];
    this.last = new Map();
    this.players = [];
    this.socket = new WebSocket(WS_URL, { handshakeTimeout: 8000 });
    this.socket.on('message', raw => {
      const message = JSON.parse(raw.toString());
      this.messages.push(message);
      this.last.set(message.t, message);
      if (message.t === 'welcome') this.id = message.id;
      if (message.t === 'snap') this.players = message.players;
      if (!['snap', 'nav', 'doors', 'items', 'keys', 'bag'].includes(message.t)) {
        report.trace.push({ ms: elapsed(), peer: name, receive: traceMessage(message) });
      }
    });
    this.socket.on('error', error => { this.fault = error.message; });
    this.socket.on('close', () => { if (!this.closing) this.fault = 'unexpected socket close'; });
  }
  mark() { return this.messages.length; }
  send(message) {
    assert.equal(this.socket.readyState, WebSocket.OPEN, `${this.name}: socket not open`);
    report.trace.push({ ms: elapsed(), peer: this.name, send: traceMessage(message) });
    this.socket.send(JSON.stringify(message));
  }
  async after(mark, predicate, label) {
    return until(() => this.messages.slice(mark).find(predicate), `${this.name}: ${label}`);
  }
  async exchange(message, type) {
    const mark = this.mark();
    this.send(message);
    const reply = await this.after(mark, reply => reply.t === type || reply.t === 'error', `${message.t} → ${type}`);
    assert.equal(reply.t, type, `${this.name}: ${message.t} failed: ${reply.msg ?? reply.t}`);
    return reply;
  }
  async close() {
    this.closing = true;
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise(resolve => this.socket.once('close', resolve));
    this.socket.close();
    await Promise.race([closed, delay(1000)]);
    if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate();
  }
}

async function until(predicate, label, timeout = 10_000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const faulted = peers.find(peer => peer.fault);
    assert.equal(faulted?.fault, undefined, `${faulted?.name}: ${faulted?.fault}`);
    const value = predicate();
    if (value) return value;
    await delay(20);
  }
  throw new Error(`Timed out: ${label}`);
}

async function reset() {
  await Promise.all(peers.map(peer => peer.close()));
  peers = ['甲', '乙', '丙'].map(name => new Peer(name));
  report.maxConcurrentPeers = Math.max(report.maxConcurrentPeers, peers.length);
  for (const peer of peers) {
    await until(() => peer.id !== undefined, `${peer.name}: welcome`);
    peer.send({ t: 'hello', name: `协议${peer.name}` });
  }
  return peers;
}

async function list(peer) {
  // The server deliberately enforces a one-second list interval per connection.
  const gap = 1050 - (performance.now() - (peer.lastListAt ?? -Infinity));
  if (gap > 0) await delay(gap);
  peer.lastListAt = performance.now();
  return (await peer.exchange({ t: 'list' }, 'rooms')).rooms;
}

async function create(peer, publicRoom = true, allowLateJoin = true) {
  return peer.exchange({ t: 'create', public: publicRoom, allowLateJoin }, 'room');
}

async function join(peer, code) { return peer.exchange({ t: 'join', code }, 'room'); }
function passed(name, details) { report.cases.push({ name, status: 'passed', details }); }

try {
  let [a, b, c] = await reset();
  const room = await create(a);
  assert.match(room.code, /^[A-HJ-NP-Z2-9]{4}$/);
  const advertised = (await list(b)).find(entry => entry.code === room.code);
  assert.ok(advertised, 'public room must be advertised');
  assert.deepEqual({ name: advertised.name, n: advertised.n, max: advertised.max, state: advertised.state, level: advertised.level, joinable: advertised.joinable },
    { name: '协议甲的教室', n: 1, max: 4, state: 'waiting', level: 0, joinable: true });
  await join(b, room.code);
  const quickRoom = await c.exchange({ t: 'quick' }, 'room');
  assert.equal(quickRoom.code, room.code);
  await until(() => peers.every(peer => peer.last.get('room')?.players.length === 3), 'three lobby member lists');
  const playerIds = peers.map(peer => peer.id).sort((left, right) => left - right);
  assert.equal(new Set(playerIds).size, 3, 'all peers have distinct real connections');
  for (const peer of peers) {
    assert.equal(peer.last.get('room').code, room.code);
    assert.deepEqual(peer.last.get('room').players.map(player => player.id).sort((left, right) => left - right), playerIds);
  }
  a.send({ t: 'start' });
  await until(() => peers.every(peer => peer.last.get('room')?.started && peer.last.get('room')?.level === 0
    && peer.players.length === 3 && peer.players.every(player => (player.st ?? 0) === 0)
    && peer.players.some(player => player.id === peer.id)), 'three clients started in L1');
  for (const peer of peers) {
    assert.deepEqual(peer.players.map(player => player.id).sort((left, right) => left - right), playerIds);
  }
  passed('public-list-join-quick-start', { code: room.code, members: 3, level: 0 });

  [a, b, c] = await reset();
  const secret = await create(a, false);
  const [bList, cList] = await Promise.all([list(b), list(c)]);
  assert.equal(bList.some(entry => entry.code === secret.code), false);
  assert.equal(cList.some(entry => entry.code === secret.code), false);
  assert.equal((await join(b, secret.code.toLowerCase())).code, secret.code);
  const emptyQuick = await c.exchange({ t: 'quick' }, 'room');
  assert.notEqual(emptyQuick.code, secret.code);
  assert.equal(emptyQuick.public, true);
  assert.equal(emptyQuick.players.length, 1);
  passed('private-code-and-empty-quick', { privateCode: secret.code, newPublicCode: emptyQuick.code });

  [a, b, c] = await reset();
  const sparse = await create(a);
  const dense = await create(b);
  await join(c, dense.code);
  await delay(1050); // create and quick share the per-connection one-second limiter.
  const chosen = await a.exchange({ t: 'quick' }, 'room');
  assert.equal(chosen.code, dense.code, 'quick must choose the most populated available waiting public room');
  assert.equal(chosen.players.length, 3);
  assert.equal((await list(c)).some(entry => entry.code === sparse.code), false, 'the now-empty room disappears immediately');
  passed('quick-most-populated-and-hide-empty', { sparse: sparse.code, selected: dense.code, n: chosen.players.length });

  [a, b, c] = await reset();
  const open = await create(a, true, true);
  a.send({ t: 'start' });
  await until(() => a.last.get('room')?.started, 'open room started');
  const inProgress = (await list(b)).find(entry => entry.code === open.code);
  assert.equal(inProgress.state, 'playing');
  assert.equal(inProgress.joinable, true);
  await join(b, open.code);
  await until(() => b.players.find(player => player.id === b.id)?.st === 2, 'late join is a spectator');
  const waiting = await c.exchange({ t: 'quick' }, 'room');
  assert.notEqual(waiting.code, open.code, 'quick must not select a playing room');
  assert.equal(waiting.started, false);
  passed('playing-spectator-and-quick-excludes-playing', { playingCode: open.code, quickCode: waiting.code });

  [a, b, c] = await reset();
  const closed = await create(a, true, false);
  a.send({ t: 'start' });
  await until(() => a.last.get('room')?.started, 'closed room started');
  const closedListing = (await list(b)).find(entry => entry.code === closed.code);
  assert.equal(closedListing.state, 'playing');
  assert.equal(closedListing.allowLateJoin, false);
  assert.equal(closedListing.joinable, false);
  const refusal = await c.exchange({ t: 'join', code: closed.code }, 'error');
  assert.match(refusal.msg, /不允许|关闭|禁止|不能|不接受/);
  assert.equal(a.last.get('room').players.length, 1);
  passed('closed-playing-room-rejects-code', { code: closed.code, error: refusal.msg });

  [a, b, c] = await reset();
  const rateRoom = await create(a);
  assert.ok((await list(b)).some(entry => entry.code === rateRoom.code));
  const burstMark = b.mark();
  b.send({ t: 'list' });
  const limited = await b.after(burstMark, reply => reply.t === 'error', 'list burst is rate limited');
  assert.match(limited.msg, /太快|频|稍后/);
  await delay(100);
  assert.equal(b.messages.slice(burstMark).some(reply => reply.t === 'rooms'), false, 'rejected list must not send a directory');
  // Rate limits are per connection: C can still list while B is cooling down.
  assert.ok((await list(c)).some(entry => entry.code === rateRoom.code));
  assert.ok((await list(b)).some(entry => entry.code === rateRoom.code), 'list recovers after the one-second interval');
  passed('list-rate-limit-and-recovery', { code: rateRoom.code, error: limited.msg, independentConnection: true });
  report.status = 'passed';
  console.log(`PUBLIC LOBBY WS PASS: ${report.cases.length} cases, three concurrent real WS peers`);
} catch (error) {
  report.status = 'failed';
  report.error = error.stack ?? String(error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await Promise.all(peers.map(peer => peer.close()));
  report.durationMs = elapsed();
  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
  await writeFile(new URL('../test-results/public-lobby-ws.json', import.meta.url), JSON.stringify(report, null, 2));
}
