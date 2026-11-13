/**
 * Real HTTP/WebSocket acceptance against the built server (not a Room mock).
 * Run from game/: node tests/l8-ws-authority.mjs
 * This script owns only the server PID it starts on the isolated port 4414.
 * Debug commands stage boundaries; normal roll-call/restart messages still pass
 * through the production parser, WebSocket dispatcher and authoritative ticks.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import { L8 } from '../shared/levels/l8.ts';
import { ST_DOWN, ST_OK, ST_SPECTATE } from '../shared/protocol.ts';

const gameDirectory = fileURLToPath(new URL('../', import.meta.url));
const resultDirectory = new URL('../test-results/', import.meta.url);
const baseURL = 'http://127.0.0.1:4414';
const wsURL = 'ws://127.0.0.1:4414/ws';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const started = performance.now();
const elapsed = () => Math.round(performance.now() - started);
const peers = [];
const report = { transport: 'built-server-real-websocket', target: wsURL, status: 'running', cases: [], trace: [] };
let server;
let serverExit;
let serverLog;
let barrierNumber = 0;

async function waitFor(predicate, label, timeout = 10000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    assert.equal(serverExit, undefined, `Owned test server exited: ${JSON.stringify(serverExit)}`);
    const failed = peers.find(peer => peer.fault);
    assert.equal(failed?.fault, undefined, `${failed?.name ?? 'WebSocket'}: ${failed?.fault ?? ''}`);
    const value = await predicate();
    if (value) return value;
    await delay(20);
  }
  assert.fail(`Timed out after ${timeout} ms: ${label}`);
}

class Peer {
  constructor(name) {
    this.name = name;
    this.history = [];
    this.latest = new Map();
    this.players = new Map();
    this.mobs = new Map();
    this.socket = new WebSocket(wsURL, { handshakeTimeout: 8000 });
    this.opened = new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
    this.socket.on('error', error => { this.fault = error.message; });
    this.socket.on('close', (code, reason) => {
      if (!this.closing) this.fault = `Unexpected close ${code}: ${reason}`;
    });
    this.socket.on('message', raw => {
      let message;
      try { message = JSON.parse(raw.toString()); }
      catch (error) { this.fault = `Invalid server JSON: ${error.message}`; return; }
      this.history.push(message);
      this.latest.set(message.t, message);
      if (message.t === 'welcome') this.id = message.id;
      if (message.t === 'snap') {
        // Player st/escaped omit their default values; unlike f/bat/sta they are not retained deltas.
        for (const player of message.players) this.players.set(player.id, { ...this.players.get(player.id), st: ST_OK, escaped: false, ...player });
        for (const mob of message.mobs) this.mobs.set(mob.id, { ...this.mobs.get(mob.id), ...mob });
      } else if (message.t !== 'nav' && message.t !== 'doors') {
        report.trace.push({ atMs: elapsed(), peer: name, direction: 'receive', message });
      }
    });
    peers.push(this);
  }
  mark() { return this.history.length; }
  last(type) { return this.latest.get(type); }
  since(mark, predicate) { return this.history.slice(mark).filter(predicate); }
  send(message) {
    assert.equal(this.socket.readyState, WebSocket.OPEN, `${this.name}: socket must be open`);
    report.trace.push({ atMs: elapsed(), peer: this.name, direction: 'send', message });
    this.socket.send(JSON.stringify(message));
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

async function connect(name, code) {
  const peer = new Peer(name);
  await peer.opened;
  await waitFor(() => peer.id, `${name}: welcome`);
  peer.send({ t: 'hello', name });
  peer.send(code ? { t: 'join', code } : { t: 'create' });
  await waitFor(() => peer.last('room'), `${name}: room state`, 20000);
  return peer;
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
    entry.error = error.stack ?? String(error);
    throw error;
  }
}

// Ordered chat delivery confirms the server handled preceding silent refusals.
async function barrier(sender, recipients, label) {
  const text = `L8WS:${++barrierNumber}:${label}`;
  const marks = recipients.map(peer => peer.mark());
  sender.send({ t: 'chat', text });
  await Promise.all(recipients.map((peer, i) => waitFor(() => peer.since(marks[i], message => message.t === 'chat' && message.from === sender.id && message.text === text)[0], label)));
}

async function ticks(peer, count = 5) {
  const tick = peer.last('snap')?.tick ?? 0;
  await waitFor(() => (peer.last('snap')?.tick ?? 0) >= tick + count, `${count} real server ticks`);
}

async function teleport(peer, point) {
  const mark = peer.mark();
  peer.send({ t: 'debug', op: 'tp', x: point.x, z: point.z, floor: 0 });
  const correct = await waitFor(() => peer.since(mark, message => message.t === 'correct' && message.forced)[0], `${peer.name}: staging teleport accepted`);
  assert.ok(Math.hypot(correct.p[0] - point.x, correct.p[1], correct.p[2] - point.z) < .08, `Wrong staging position: ${JSON.stringify(correct.p)}`);
}

async function crossAll(actor, recipients) {
  await teleport(actor, { x: L8.finale.rollcall.x, z: L8.finale.rollcall.z + 1.45 });
  for (const member of actor.last('finale').members) if (member.status !== 'left') actor.send({ t: 'act', kind: 'rollcall', id: member.id });
  await waitFor(() => recipients.every(peer => peer.last('finale')?.phase === 'chase'), 'all peers see authoritative chase');
}

async function revive(healer, target, recipients) {
  const refresh = () => healer.send({ t: 'act', kind: 'revive', id: target.id });
  refresh();
  const timer = setInterval(refresh, 50);
  try {
    await waitFor(() => recipients.every(peer => peer.players.get(target.id)?.st === ST_OK), 'ordinary hold-to-revive succeeds', 7000);
  } finally { clearInterval(timer); }
  await ticks(healer, 3);
  assert.ok(recipients.every(peer => peer.players.get(target.id)?.st === ST_OK), 'Rescued player must remain active');
}

await mkdir(resultDirectory, { recursive: true });
try {
  const occupied = await fetch(`${baseURL}/healthz`).then(() => true, () => false);
  assert.equal(occupied, false, 'Port 4414 is occupied; refusing to use or stop an unowned server');
  serverLog = createWriteStream(new URL('l8-ws-server.log', resultDirectory));
  server = spawn(process.execPath, ['dist-server/index.js'], { cwd: gameDirectory, env: { ...process.env, NODE_ENV: 'development', PORT: '4414', HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.pipe(serverLog, { end: false });
  server.stderr.pipe(serverLog, { end: false });
  server.once('exit', (code, signal) => { serverExit = { code, signal }; });
  await waitFor(() => fetch(`${baseURL}/healthz`).then(response => response.ok, () => false), 'owned built-server health', 30000);

  const host = await connect('WS点名甲');
  const code = host.last('room').code;
  const teammate = await connect('WS点名乙', code);
  host.send({ t: 'start' });
  await waitFor(() => host.last('room').started && teammate.last('room').started, 'room starts');
  const earlierDowns = 4;
  await check('registered L1–L4 retain their actual indexes and contribute whole-run statistics', async () => {
    assert.ok([host, teammate].every(peer => peer.last('room').level === 0), 'Ordinary rooms must still start with L1');
    for (const level of [0, 1, 2, 3]) {
      if (level) {
        host.send({ t: 'debug', op: 'level', level });
        await waitFor(() => [host, teammate].every(peer => peer.last('room')?.level === level && peer.players.get(host.id)?.st === ST_OK), `both clients load chapter ${level + 1}`);
      }
      await ticks(host, 4);
      host.send({ t: 'debug', op: 'down' });
      await waitFor(() => [host, teammate].every(peer => peer.players.get(host.id)?.st === ST_DOWN), `chapter ${level + 1}: down recorded`);
    }
    return { verifiedChapterIndexes: [0, 1, 2, 3], hostDowns: earlierDowns };
  });
  host.send({ t: 'debug', op: 'level', level: 7 });
  await waitFor(() => [host, teammate].every(peer => peer.last('room')?.level === 7 && peer.last('finale')?.phase === 'rollcall'), 'genuine eighth index');
  const seed = host.last('room').seed;
  const initialElapsed = host.last('finale').elapsedMs;

  await check('actual WebSocket rejects remote and forged roll-call then synchronizes the full team', async () => {
    assert.equal(host.last('finale').downs, earlierDowns, 'All registered earlier chapter downs must carry into the ending');
    host.send({ t: 'act', kind: 'rollcall', id: host.id });
    host.send({ t: 'act', kind: 'rollcall', id: 9999 });
    await barrier(host, [host, teammate], 'remote-and-forged-rollcall');
    assert.ok(host.last('finale').members.every(member => !member.crossedOut));
    await teleport(teammate, L8.exit);
    await ticks(host);
    assert.equal(teammate.players.get(teammate.id)?.escaped, false, 'The exit cannot extract anyone before roll-call ends');
    assert.equal(host.last('completed'), undefined);
    await teleport(host, { x: L8.finale.rollcall.x, z: L8.finale.rollcall.z + 1.45 });
    host.send({ t: 'debug', op: 'down', s: 30 });
    await waitFor(() => host.players.get(host.id)?.st === ST_DOWN, 'book actor is downed');
    host.send({ t: 'act', kind: 'rollcall', id: host.id });
    await barrier(host, [host, teammate], 'downed-rollcall-refused');
    assert.ok(host.last('finale').members.every(member => !member.crossedOut));
    await teleport(teammate, { x: L8.finale.rollcall.x + 1, z: L8.finale.rollcall.z + 1.45 });
    await revive(teammate, host, [host, teammate]);
    host.send({ t: 'act', kind: 'rollcall', id: host.id });
    await waitFor(() => [host, teammate].every(peer => peer.last('finale')?.members.find(member => member.id === host.id)?.crossedOut), 'one valid name is crossed out');
    const revision = host.last('finale').revision;
    host.send({ t: 'act', kind: 'rollcall', id: host.id });
    await barrier(host, [host, teammate], 'duplicate-rollcall-refused');
    for (const peer of [host, teammate]) {
      assert.equal(peer.last('finale').revision, revision, 'A duplicate must not mutate authoritative revision');
      assert.equal(peer.last('finale').phase, 'rollcall', 'One unmarked teammate still blocks the chase');
      assert.equal(peer.last('finale').members.filter(member => member.crossedOut).length, 1);
    }
    host.send({ t: 'act', kind: 'rollcall', id: teammate.id });
    await waitFor(() => [host, teammate].every(peer => peer.last('finale')?.phase === 'chase'), 'both clients enter chase');
    assert.ok(host.last('finale').members.every(member => member.crossedOut));
    assert.deepEqual(host.last('finale').members, teammate.last('finale').members);
    await waitFor(() => host.mobs.get(1)?.form === 'perfect', 'perfect form snapshot');
    const from = [...host.mobs.get(1).p];
    await ticks(host, 12);
    const to = host.mobs.get(1).p;
    const movedMetres = Math.hypot(to[0] - from[0], to[2] - from[2]);
    assert.ok(movedMetres > .8, `Pursuer must actually move, got ${movedMetres}`);
    host.send({ t: 'debug', op: 'safe', s: 60 });
    return { memberIds: host.last('finale').members.map(member => member.id), movedMetres, seed };
  });

  const late = await connect('WS晚加入', code);
  await check('late joins receive live state as observers and cannot extract', async () => {
    await waitFor(() => late.players.get(late.id)?.st === ST_SPECTATE, 'late join is an observer');
    assert.equal(late.last('finale').phase, 'chase');
    assert.deepEqual(late.last('finale').members.map(member => member.id), [host.id, teammate.id]);
    assert.ok(late.last('nav').n.length > 0 && late.last('doors').doors.length > 0);
    late.send({ t: 'act', kind: 'rollcall', id: late.id });
    await teleport(late, L8.exit);
    await ticks(host);
    assert.equal(late.players.get(late.id).st, ST_SPECTATE);
    assert.equal(late.last('completed'), undefined);
    assert.equal(host.last('completed'), undefined);
    return { observerId: late.id, participantIds: late.last('finale').members.map(member => member.id) };
  });

  await check('real full wipe reloads the same seed, recruits observers, and keeps accumulated downs/time', async () => {
    const before = host.last('finale').elapsedMs;
    host.send({ t: 'debug', op: 'down', s: 1 });
    teammate.send({ t: 'debug', op: 'down', s: 1 });
    await waitFor(() => host.last('fade')?.restart, 'automatic same-seed fade');
    await waitFor(() => [host, teammate, late].every(peer => peer.last('finale')?.phase === 'rollcall' && peer.players.get(peer.id)?.st === ST_OK && peer.players.get(peer.id)?.escaped === false), 'wipe ends with active clients', 12000);
    for (const peer of [host, teammate, late]) {
      assert.equal(peer.last('room').seed, seed);
      assert.equal(peer.last('room').level, 7);
      assert.equal(peer.last('finale').downs, earlierDowns + 3);
      assert.ok(peer.last('finale').elapsedMs > before);
      assert.deepEqual(peer.last('finale').members.map(member => member.id), [host.id, teammate.id, late.id]);
      assert.ok(peer.last('finale').members.every(member => !member.crossedOut));
      for (const member of peer.last('finale').members) assert.equal(peer.players.get(member.id)?.escaped, false, `${peer.name}: wipe must clear ${member.id}'s escaped flag`);
    }
    return { seed, downs: host.last('finale').downs, elapsedMs: host.last('finale').elapsedMs };
  });

  let completion;
  await check('built server publishes identical whole-run completion after safe-side extraction', async () => {
    await crossAll(host, [host, teammate, late]);
    for (const peer of [host, teammate, late]) {
      peer.send({ t: 'debug', op: 'safe', s: 60 });
      await teleport(peer, L8.exit);
    }
    await waitFor(() => [host, teammate, late].every(peer => peer.last('completed')), 'shared completion');
    completion = host.last('completed');
    assert.deepEqual(completion, teammate.last('completed'));
    assert.deepEqual(completion, late.last('completed'));
    assert.equal(completion.downs, earlierDowns + 3);
    assert.ok(completion.elapsedMs > initialElapsed);
    assert.deepEqual(completion.members.map(member => [member.id, member.downs, member.escaped]), [[host.id, earlierDowns + 2, true], [teammate.id, 1, true], [late.id, 0, true]]);
    return completion;
  });

  const observer = await connect('WS结局观察', code);
  await check('late completed observers receive frozen results and a non-host cannot restart', async () => {
    await waitFor(() => observer.last('completed'), 'completion replay to late observer');
    await waitFor(() => observer.players.get(observer.id)?.st === ST_SPECTATE, 'completed late join is an observer');
    assert.deepEqual(observer.last('completed'), completion);
    assert.equal(observer.last('finale').elapsedMs, completion.elapsedMs);
    const firstRoom = observer.history.findIndex(message => message.t === 'room');
    const firstFinale = observer.history.findIndex(message => message.t === 'finale');
    const firstCompleted = observer.history.findIndex(message => message.t === 'completed');
    assert.ok(firstRoom >= 0 && firstFinale > firstRoom && firstCompleted > firstFinale, 'A late client must receive room construction before finale state and frozen completion');
    const frozenPosition = [...host.players.get(host.id).p];
    host.send({ t: 'input', seq: 999, p: [frozenPosition[0], frozenPosition[1], frozenPosition[2] + 2], yaw: 0, pitch: 0, f: 2 });
    await ticks(host, 25);
    for (const peer of [host, teammate, late, observer]) {
      assert.deepEqual(peer.last('completed'), completion);
      assert.equal(peer.last('finale').elapsedMs, completion.elapsedMs, 'Completed run time must stay frozen over real ticks');
      assert.equal(peer.last('finale').downs, completion.downs, 'Completed down count must stay frozen');
      assert.deepEqual(peer.players.get(host.id).p, frozenPosition, 'An escaped participant cannot move after completion');
    }
    const marks = [host, teammate, late, observer].map(peer => peer.mark());
    teammate.send({ t: 'restart' });
    await barrier(teammate, [host, teammate, late, observer], 'non-host-restart-refused');
    for (const [index, peer] of [host, teammate, late, observer].entries()) {
      assert.equal(peer.since(marks[index], message => message.t === 'fade').length, 0);
      assert.equal(peer.last('finale').phase, 'complete');
    }
  });

  await check('host transfer grants replay authority and explicit replay clears the entire run', async () => {
    await host.close();
    await waitFor(() => [teammate, late, observer].every(peer => peer.last('room').host === teammate.id), 'host ownership transfer to every remaining peer');
    await ticks(teammate, 2);
    for (const peer of [teammate, late, observer]) {
      assert.equal(peer.last('finale').phase, 'complete', 'Room membership updates cannot reset the ending');
      assert.equal(peer.last('finale').elapsedMs, completion.elapsedMs);
      assert.deepEqual(peer.last('completed'), completion, 'Host departure cannot rewrite the frozen result');
      assert.ok(!peer.last('room').players.some(player => player.id === host.id) && !peer.last('snap').players.some(player => player.id === host.id), 'Departed host must leave the live room and authoritative snapshots');
    }
    teammate.send({ t: 'restart' });
    await waitFor(() => teammate.last('fade')?.restart, 'host replay begins a real fade');
    const duringFade = await connect('WS淡出加入', code);
    await waitFor(() => duringFade.last('fade'), 'late join receives remaining replay fade');
    assert.ok(duringFade.last('fade').secs > 0 && duringFade.last('fade').secs <= 3);
    assert.equal(duringFade.last('fade').restart, true);
    // The server intentionally sends no snapshots while a fade freezes its ticks.
    // Its first post-fade snapshot must activate this joiner with the rest of the squad.
    assert.ok(!duringFade.last('finale').members.some(member => member.id === duringFade.id), 'Joining during a fade must not mutate the completed attempt roster');
    const replayPeers = [teammate, late, observer, duringFade];
    await waitFor(() => replayPeers.every(peer => peer.last('finale')?.phase === 'rollcall' && peer.players.get(peer.id)?.st === ST_OK && peer.players.get(peer.id)?.escaped === false), 'new host explicit replay', 12000);
    for (const peer of replayPeers) {
      const state = peer.last('finale');
      assert.equal(peer.last('room').seed, seed);
      assert.equal(state.downs, 0);
      assert.ok(state.elapsedMs < 500);
      assert.deepEqual(state.members.map(member => member.id), replayPeers.map(member => member.id));
      assert.ok(state.members.every(member => member.downs === 0 && !member.crossedOut));
      for (const member of state.members) assert.equal(peer.players.get(member.id)?.escaped, false, `${peer.name}: explicit replay must clear ${member.id}'s escaped flag`);
    }
    return { hostId: teammate.id, seed, replayElapsedMs: teammate.last('finale').elapsedMs };
  });
  report.status = 'passed';
  console.log(`RESULT ${report.cases.length} passed, 0 failed. Actual built HTTP/WebSocket server; boundary debug staging is explicit.`);
} catch (error) {
  report.status = 'failed';
  report.error = error.stack ?? String(error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await Promise.all(peers.map(peer => peer.close()));
  if (server && server.exitCode === null && server.signalCode === null) {
    const stopped = new Promise(resolve => server.once('exit', resolve));
    server.kill('SIGTERM');
    await Promise.race([stopped, delay(2000)]);
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
  }
  serverLog?.end();
  report.durationMs = elapsed();
  await writeFile(new URL('l8-ws-authority.json', resultDirectory), JSON.stringify(report, null, 2) + '\n');
}
