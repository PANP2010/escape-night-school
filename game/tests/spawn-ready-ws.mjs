/**
 * Real three-client spawn-readiness acceptance test, using only our own server on 4444.
 * Prepare a fallback bundle when direct Node TypeScript cannot load JSON imports:
 *   python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- npm run build:server
 * Run from game/: node tests/spawn-ready-ws.mjs (first-input fallback)
 *                node tests/spawn-ready-ws.mjs --ready (explicit ready, input 1 s later)
 * The script refuses an occupied port, starts/stops only its own child, never builds,
 * and writes uncommitted evidence to test-results/spawn-ready-ws[-ready].{json,server.log}.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, open, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const RESULTS = fileURLToPath(new URL('../test-results/', import.meta.url));
const PORT = 4444;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const READY_PATH = process.argv.includes('--ready');
const ARTIFACT = READY_PATH ? 'spawn-ready-ws-ready' : 'spawn-ready-ws';
const TICK_MS = 50;
const LOADING_TICKS = 12_000 / TICK_MS;
const PROTECTION_TICKS = 10_000 / TICK_MS;
const ST_OK = 0, ST_DOWN = 1;
const started = performance.now();
const elapsed = () => Math.round(performance.now() - started);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const peers = [];
const intervals = [];
const report = {
  target: WS_URL, readinessPath: READY_PATH ? 'explicit ready' : 'first legal input fallback', startedAt: new Date().toISOString(), nodeVersion: process.version, status: 'running',
  serverAttempts: [], cases: [], trace: [], delayedSnapshots: [],
};
let child, serverLog, intervalFault, interrupted;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { interrupted = signal; });

function repeat(run, ms) {
  const interval = setInterval(() => {
    try { run(); }
    catch (error) { intervalFault = error; }
  }, ms);
  intervals.push(interval);
  return interval;
}

async function waitFor(predicate, label, timeout = 10_000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (interrupted) throw new Error(`Interrupted by ${interrupted}`);
    if (intervalFault) throw intervalFault;
    const fault = peers.find(peer => peer.fault);
    assert.equal(fault?.fault, undefined, `${fault?.name ?? 'WS'}: ${fault?.fault ?? ''}`);
    if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error(`Own server exited (${child.exitCode ?? child.signalCode}): ${label}`);
    const found = predicate();
    if (found) return found;
    await delay(10);
  }
  assert.fail(`Timed out after ${timeout} ms: ${label}`);
}

async function check(name, run) {
  const entry = { name, startedMs: elapsed(), status: 'running' };
  report.cases.push(entry);
  try {
    entry.evidence = await run();
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

async function assertPortFree() {
  await new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: PORT });
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error(`${PORT} is occupied; no server was started or stopped`));
    });
    socket.once('error', error => error.code === 'ECONNREFUSED' ? resolve() : reject(error));
    socket.setTimeout(1000, () => {
      socket.destroy();
      reject(new Error(`Timed out probing ${PORT}`));
    });
  });
}

async function stopServer() {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}

async function startServer() {
  await assertPortFree();
  serverLog = await open(`${RESULTS}${ARTIFACT}.server.log`, 'w');
  for (const entry of ['server/index.ts', 'dist-server/index.js']) {
    if (entry.startsWith('dist-')) {
      await access(`${ROOT}${entry}`).catch(() => {
        throw new Error('Direct Node startup failed and dist-server/index.js is absent; run the documented gated build:server first');
      });
    }
    const attempt = { entry, startedMs: elapsed() };
    report.serverAttempts.push(attempt);
    child = spawn(process.execPath, [entry], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'test', NAV_CACHE: 'test-results/spawn-ready-nav.json' },
      stdio: ['ignore', serverLog.fd, serverLog.fd],
    });
    attempt.pid = child.pid;
    let spawnError;
    child.once('error', error => { spawnError = error; });
    const deadline = performance.now() + 15_000;
    while (performance.now() < deadline && child.exitCode === null && !spawnError) {
      try {
        const response = await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(500) });
        if (response.ok && child.exitCode === null) {
          attempt.status = 'running';
          return;
        }
      } catch { /* Our child may still be starting. */ }
      await delay(50);
    }
    attempt.status = 'failed';
    attempt.exitCode = child.exitCode;
    attempt.error = spawnError?.message;
    await stopServer();
    if (entry.startsWith('dist-')) throw new Error(`Own bundled server failed to start; see ${ARTIFACT}.server.log`);
    console.log('Direct TypeScript startup unavailable; trying the prepared server bundle');
  }
}

function compact(message) {
  if (message.t === 'nav') return { t: 'nav', nodes: message.n.length / 3 };
  if (message.t === 'doors') return { t: 'doors', count: message.doors.length };
  if (message.t === 'items') return { t: 'items', count: message.items.length };
  return message;
}

class Peer {
  constructor(name, recordDelayed = false) {
    this.name = name;
    this.recordDelayed = recordDelayed;
    this.history = [];
    this.latest = new Map();
    this.players = new Map();
    this.mobs = new Map();
    this.caught = [];
    this.seq = 0;
    this.epoch = 0;
    this.socket = new WebSocket(WS_URL, { handshakeTimeout: 8000 });
    this.opened = new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
    this.socket.on('error', error => { this.fault = error.message; });
    this.socket.on('close', (code, reason) => {
      if (!this.closing) this.fault = `Unexpected close ${code}: ${reason.toString()}`;
    });
    this.socket.on('message', raw => {
      try {
        const message = JSON.parse(raw.toString());
        const atMs = elapsed();
        this.history.push({ atMs, message });
        this.latest.set(message.t, message);
        if (message.t === 'welcome') this.id = message.id;
        if (message.t === 'correct') {
          this.position = message.p;
          this.epoch = message.c ?? this.epoch;
        }
        if (message.t === 'caught') this.caught.push({ atMs, precedingServerTick: this.last('snap')?.tick, message });
        if (message.t === 'snap') {
          for (const player of message.players) {
            this.players.set(player.id, { ...this.players.get(player.id), ...player, st: player.st ?? ST_OK });
            if (player.id === this.id) this.position = player.p;
          }
          for (const mob of message.mobs) this.mobs.set(mob.id, { ...this.mobs.get(mob.id), ...mob });
          for (const caught of this.caught) if (caught.serverTick === undefined) caught.serverTick = message.tick;
          if (this.recordDelayed) {
            const player = this.players.get(this.id), mob = this.mobs.get(1);
            report.delayedSnapshots.push({
              atMs, tick: message.tick, serverTimeMs: message.tick * TICK_MS,
              player: player && { p: player.p, st: player.st },
              mob: mob && { p: mob.p, anim: mob.anim, target: mob.target, st: mob.st },
              distanceM: player && mob ? Math.hypot(player.p[0] - mob.p[0], player.p[2] - mob.p[2]) : null,
            });
          }
        } else report.trace.push({ atMs, peer: name, direction: 'receive', message: compact(message) });
      } catch (error) { this.fault = `Invalid server message: ${error.message}`; }
    });
    peers.push(this);
  }
  last(type) { return this.latest.get(type); }
  mark() { return this.history.length; }
  send(message) {
    assert.equal(this.socket.readyState, WebSocket.OPEN, `${this.name}: socket must be open`);
    report.trace.push({ atMs: elapsed(), peer: this.name, direction: 'send', serverTick: this.last('snap')?.tick, message });
    this.socket.send(JSON.stringify(message));
  }
  input() {
    assert.ok(this.position, `${this.name}: authoritative position must arrive before input`);
    this.send({ t: 'input', seq: ++this.seq, p: [...this.position], yaw: 0, pitch: 0, f: 0, c: this.epoch });
  }
  async waitAfter(mark, predicate, label, timeout) {
    return waitFor(() => this.history.slice(mark).find(event => predicate(event.message))?.message, `${this.name}: ${label}`, timeout);
  }
  async close() {
    this.closing = true;
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise(resolve => this.socket.once('close', resolve));
    this.socket.close();
    await Promise.race([closed, delay(500)]);
    if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate();
  }
}

async function connect(name, recordDelayed = false) {
  const peer = new Peer(name, recordDelayed);
  await peer.opened;
  await waitFor(() => peer.id, `${name}: welcome`);
  peer.send({ t: 'hello', name });
  return peer;
}

async function teleport(peer, x, z) {
  const mark = peer.mark();
  peer.send({ t: 'debug', op: 'tp', x, z, floor: 0 });
  const correction = await peer.waitAfter(mark, message => message.t === 'correct' && message.forced, 'teammate isolation teleport');
  assert.ok(Math.abs(correction.p[0] - x) < .01 && Math.abs(correction.p[2] - z) < .01, 'Teleport must be accepted');
  await peer.waitAfter(mark, message => message.t === 'snap' && message.players.some(player => player.id === peer.id && Math.abs(player.p[0] - x) < .01 && Math.abs(player.p[2] - z) < .01), 'isolated position in server snapshot');
}

function assertDelayedOK(peer, label) {
  assert.equal(peer.caught.length, 0, `${label}: delayed client must receive no caught event`);
  for (const observer of peers) assert.equal(observer.players.get(peer.id)?.st, ST_OK, `${label}: ${observer.name} sees delayed player active`);
}

// Summoning intentionally ends the summoner's own grace. Use a different client
// so the delayed client never invokes a debug operation that bypasses protection.
// The helper may be caught/downed; test-only teleport/summon stays available and
// does not revive it or alter the delayed player's readiness or safety deadline.
function pressureFromTeammate(helper, delayed) {
  const [x, , z] = delayed.position;
  helper.send({ t: 'debug', op: 'tp', x, z: z + 1.5, floor: 0 });
  helper.send({ t: 'debug', op: 'warden', d: 1.5 });
}

let a, b, c, startTick, readyTick, readyAt, pressure;
try {
  await mkdir(RESULTS, { recursive: true });
  await startServer();
  await check('Three real WS clients start L1 with the same positive incarnation', async () => {
    [a, b, c] = await Promise.all([connect('ready-explicit'), connect('ready-input'), connect('ready-delayed', true)]);
    let mark = a.mark();
    a.send({ t: 'create' });
    const lobby = await a.waitAfter(mark, message => message.t === 'room', 'create lobby and build/cache real nav', 60_000);
    report.roomCode = lobby.code;
    for (const peer of [b, c]) {
      mark = peer.mark();
      peer.send({ t: 'join', code: lobby.code });
      await peer.waitAfter(mark, message => message.t === 'room' && message.players.some(player => player.id === peer.id), 'join lobby');
    }
    await waitFor(() => peers.every(peer => peer.last('room')?.players.length === 3), 'all three clients in lobby');
    a.send({ t: 'start' });
    await waitFor(() => peers.every(peer => peer.last('room')?.started && peer.last('snap')?.players.length === 3), 'three clients receive running L1 and authority snapshots');
    const room = a.last('room');
    assert.equal(room.level, 0);
    assert.ok(Number.isInteger(room.incarnation) && room.incarnation > 0, 'Running room must identify its current incarnation');
    assert.ok(peers.every(peer => peer.last('room').incarnation === room.incarnation));
    startTick = c.last('snap').tick;
    report.start = { tick: startTick, serverTimeMs: startTick * TICK_MS, atMs: elapsed(), incarnation: room.incarnation };
    a.send({ t: 'ready', incarnation: room.incarnation });
    a.input(); b.input();
    await teleport(a, -62, 94);
    await teleport(b, -16.5, 94);
    for (const peer of [a, b]) repeat(() => peer.input(), 100);
    return { ids: peers.map(peer => peer.id), startTick, incarnation: room.incarnation, readiness: ['explicit ready + input', 'input fallback', 'no ready/input for 12 seconds'] };
  });

  await check('Delayed client survives 12 server seconds of loading under nearby monster pressure', async () => {
    pressureFromTeammate(a, c);
    pressure = repeat(() => pressureFromTeammate(a, c), 500);
    await waitFor(() => {
      assertDelayedOK(c, 'loading');
      return c.last('snap').tick >= startTick + LOADING_TICKS;
    }, 'delayed client waits 12 seconds before any readiness/input', 16_000);
    assert.equal(c.seq, 0, 'No input may precede the twelve-second loading delay');
    assert.equal(report.trace.some(event => event.peer === c.name && event.direction === 'send' && event.message.t === 'ready'), false, 'Delayed client must not send explicit ready');
    const window = report.delayedSnapshots.filter(snap => snap.tick >= startTick && snap.tick <= startTick + LOADING_TICKS);
    assert.ok(window.every(snap => snap.player.st === ST_OK));
    assert.ok(window.some(snap => snap.distanceM !== null && snap.distanceM <= 1.6), 'Monster must actually be nearby during loading');
    readyTick = c.last('snap').tick;
    readyAt = elapsed();
    report.readinessTrigger = { atMs: readyAt, precedingServerTick: readyTick, serverTimeMs: readyTick * TICK_MS, path: report.readinessPath };
    if (READY_PATH) {
      c.send({ t: 'ready', incarnation: c.last('room').incarnation });
      await waitFor(() => {
        assertDelayedOK(c, 'explicit ready before first input');
        return c.last('snap').tick >= readyTick + 20;
      }, 'one complete server second between explicit ready and first input', 3000);
    }
    report.firstDelayedInput = { atMs: elapsed(), precedingServerTick: c.last('snap').tick, serverTimeMs: c.last('snap').tick * TICK_MS, seq: 1, epoch: c.epoch };
    c.input();
    repeat(() => c.input(), 100);
    return { loadingTicks: readyTick - startTick, loadingServerMs: (readyTick - startTick) * TICK_MS, caught: [], closestMonsterM: Math.min(...window.map(snap => snap.distanceM ?? Infinity)), readiness: report.readinessTrigger, firstInput: report.firstDelayedInput };
  });

  await check(`${READY_PATH ? 'Explicit ready' : 'First legal input'} provides ten seconds of protection after delayed loading`, async () => {
    await waitFor(() => {
      assertDelayedOK(c, 'grace before repeated ready');
      return c.last('snap').tick >= readyTick + 160;
    }, 'eight protected seconds before repeated ready', 11_000);
    report.repeatedReady = { atMs: elapsed(), precedingServerTick: c.last('snap').tick, incarnation: c.last('room').incarnation, epoch: c.epoch };
    c.send({ t: 'ready', incarnation: report.repeatedReady.incarnation });
    await waitFor(() => {
      assertDelayedOK(c, 'post-input grace');
      return c.last('snap').tick >= readyTick + PROTECTION_TICKS - 1;
    }, 'all protected authority snapshots before the 10-second boundary', 13_000);
    clearInterval(pressure);
    const window = report.delayedSnapshots.filter(snap => snap.tick > readyTick && snap.tick < readyTick + PROTECTION_TICKS);
    assert.equal(window.length, PROTECTION_TICKS - 1, 'Receive every authoritative protected tick before the exact expiry boundary');
    assert.ok(window.every(snap => snap.player.st === ST_OK), 'Every protected snapshot must keep the delayed player active');
    assert.ok(window.some(snap => snap.tick >= readyTick + 180 && snap.distanceM !== null && snap.distanceM <= 1.6), 'Monster must remain nearby in the final protected second');
    report.protectedWindow = { firstTick: readyTick + 1, lastTick: readyTick + PROTECTION_TICKS - 1, expiryEarliestTick: readyTick + PROTECTION_TICKS, samples: window.length, caught: [], closestMonsterM: Math.min(...window.map(snap => snap.distanceM ?? Infinity)) };
    return report.protectedWindow;
  });

  await check('Repeated ready does not renew protection; the real monster catches after the original deadline', async () => {
    await waitFor(() => c.caught[0]?.serverTick !== undefined && peers.every(peer => peer.players.get(c.id)?.st === ST_DOWN), 'real caught event followed by ST_DOWN on all three clients', 7000);
    const caught = c.caught[0];
    assert.equal(caught.message.by, 'warden');
    assert.ok(caught.serverTick >= readyTick + PROTECTION_TICKS, 'Caught cannot occur before the full 200-server-tick grace expires');
    assert.ok(caught.atMs - readyAt >= 10_000, 'Caught cannot occur before ten observed seconds after the readiness trigger');
    assert.ok(caught.serverTick <= readyTick + PROTECTION_TICKS + 120, 'Protection must not leave the nearby monster harmless indefinitely');
    assert.ok(caught.serverTick < report.repeatedReady.precedingServerTick + PROTECTION_TICKS, 'Repeated ready must not restart the original protection deadline');
    if (READY_PATH) assert.ok(caught.serverTick < report.firstDelayedInput.precedingServerTick + PROTECTION_TICKS, 'The later first input must not restart the explicit-ready deadline');
    const lastSummon = report.trace.filter(event => event.peer === a.name && event.direction === 'send' && event.message.t === 'debug' && event.message.op === 'warden').at(-1);
    assert.ok(lastSummon.serverTick < readyTick + PROTECTION_TICKS, 'Final pressure summon must precede grace expiry');
    report.catch = { ...caught, sinceReadyServerMs: (caught.serverTick - readyTick) * TICK_MS, sinceReadyObservedMs: caught.atMs - readyAt, sinceFirstInputServerMs: (caught.serverTick - report.firstDelayedInput.precedingServerTick) * TICK_MS, states: peers.map(peer => ({ observer: peer.name, st: peer.players.get(c.id)?.st })), lastSummonServerTick: lastSummon.serverTick };
    return report.catch;
  });

  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error.stack ?? String(error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  for (const interval of intervals) clearInterval(interval);
  await Promise.allSettled(peers.map(peer => peer.close()));
  await stopServer();
  report.finishedAt = new Date().toISOString();
  report.durationMs = elapsed();
  report.serverStopped = !child || child.exitCode !== null || child.signalCode !== null;
  report.serverExit = child && { pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode };
  await assertPortFree().then(() => { report.portAvailableAfterCleanup = true; }, error => { report.portAvailableAfterCleanup = false; report.portProbeError = error.message; });
  await serverLog?.close();
  await mkdir(RESULTS, { recursive: true });
  await writeFile(`${RESULTS}${ARTIFACT}.json`, JSON.stringify(report, null, 2));
  console.log(`${report.status.toUpperCase()}: ${RESULTS}${ARTIFACT}.json; own server stopped=${report.serverStopped}`);
}
