/**
 * Acceptance against a separately started real dist-server on 127.0.0.1:4419.
 * Never builds, starts a server, reads credentials, or logs tokens.
 * Run from game/: node tests/reconnect-ws.mjs
 * The parent controls the shared heavy/browser gates and starts/stops its own server PID.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import { ReconnectPeer, delay, near, waitFor } from './reconnect-peer.mjs';

const URL = 'ws://127.0.0.1:4419/ws';
const RESULT = fileURLToPath(new globalThis.URL('../test-results/reconnect-ws.json', import.meta.url));
const peers = [];
const report = { target: URL, startedAt: new Date().toISOString(), status: 'running', cases: [] };
let a, b, code;
const online = room => room?.players.filter(p => p.online !== false) ?? [];
const own = peer => peer.players.get(peer.id);

async function connect(name, token, options) {
  const peer = new ReconnectPeer(URL, name, options);
  peers.push(peer);
  const welcome = await peer.hello(token);
  return { peer, welcome };
}
async function check(name, body) {
  const entry = { name, status: 'running', durationMs: 0 };
  report.cases.push(entry);
  const start = performance.now();
  try { entry.evidence = await body(); entry.status = 'passed'; }
  catch (error) { entry.status = 'failed'; entry.error = error.stack ?? String(error); throw error; }
  finally { entry.durationMs = Math.round(performance.now() - start); }
  console.log(`PASS ${name} (${entry.durationMs} ms)`);
}
async function ticks(peer, n = 5) {
  const tick = peer.last('snap')?.tick ?? 0;
  await waitFor(() => (peer.last('snap')?.tick ?? 0) >= tick + n, `${peer.name}: ${n} server ticks`);
}
async function roomOnline(peer, count) {
  return waitFor(() => online(peer.last('room')).length === count && peer.last('room'), `${peer.name}: ${count} online room members`);
}
async function resume(peer) {
  const token = peer.token;
  const id = peer.id;
  const start = performance.now();
  await peer.terminate();
  await waitFor(() => b.last('room')?.players.some(p => p.id === id && p.online === false), 'server sees actual terminated socket');
  const { peer: replacement, welcome } = await connect(peer.name, token);
  assert.equal(welcome.resumed, true, 'A detached identity must resume');
  assert.equal(welcome.id, id, 'Resume must preserve the player id');
  assert.ok(replacement.token !== token, 'Successful resume must rotate its credential');
  assert.ok(performance.now() - start < 10_000, 'The actual reconnect must complete inside the ten-second window');
  return replacement;
}
async function fullResume(peer, previousPosition, previousEpoch) {
  const types = ['room', 'doors', 'items', 'keys', 'bag', 'power', 'nav', 'snap', 'resume', 'correct'];
  await waitFor(() => types.every(t => peer.last(t)), 'resume sends complete room state');
  assert.equal(peer.last('room').code, code);
  assert.equal(peer.last('room').started, true);
  const index = type => peer.history.findIndex(m => m.t === type && (type !== 'welcome' || m.resumed));
  assert.ok(index('welcome') < index('room') && index('room') < index('snap') && index('snap') < index('correct'), 'Resume must establish identity, room and full snapshot before correction');
  assert.equal(peer.correction.forced, true, 'Resume uses an authoritative forced correction');
  assert.ok(Number.isInteger(peer.correction.c) && peer.correction.c > previousEpoch, 'Resume must advance the correction epoch');
  assert.ok(near(peer.correction.p, previousPosition), 'Resume must preserve the authoritative position');
  assert.ok(near(own(peer)?.p, previousPosition), 'The full player snapshot must match the preserved position');
  assert.equal(own(peer).st, 0, 'A returning active player must not become a late-join spectator');
  assert.ok(peer.last('nav').n.length > 0 && peer.last('doors').doors.length > 0, 'Resume must include world state');
}

try {
  await check('two real WS players receive private hello tokens and enter the same lobby', async () => {
    ({ peer: a } = await connect('续接甲'));
    ({ peer: b } = await connect('续接乙'));
    a.send({ t: 'create' });
    const room = await a.after(0, m => m.t === 'room', 'create room', 45000);
    code = room.code;
    b.send({ t: 'join', code });
    await roomOnline(a, 2); await roomOnline(b, 2);
    assert.equal(a.last('room').host, a.id);
    assert.ok(a.token !== b.token, 'Each identity must have its own token');
    for (const p of [a, b]) for (const m of p.history) if (m.t !== 'welcome') {
      const text = JSON.stringify(m);
      assert.ok(!text.includes(a.token) && !text.includes(b.token), 'Room and snapshot broadcasts must never expose resume credentials');
    }
    return { players: [a.id, b.id], room: code, privateTokens: true };
  });

  await check('an active credential cannot seize or rotate the live owner connection', async () => {
    const before = a.token, id = a.id;
    const { peer: attacker, welcome } = await connect('抢占尝试', before);
    assert.equal(welcome.resumePending, true, 'A still-live identity must reject competing transport ownership');
    assert.ok(welcome.id !== id && !Object.hasOwn(welcome, 'token'), 'Pending must neither impersonate nor disclose/rotate the owner token');
    attacker.send({ t: 'start' });
    await delay(150);
    assert.equal(a.socket.readyState, WebSocket.OPEN);
    assert.equal(a.last('room').started, false, 'The contender cannot start the owner room');
    assert.ok(a.token === before, 'An active claim must not rotate the owner token');
    await attacker.terminate();
    return { owner: id, takeoverRefused: true };
  });

  await check('actual terminate resumes the lobby identity and transfers host once', async () => {
    const id = a.id, oldToken = a.token;
    a = await resume(a);
    await roomOnline(b, 2);
    assert.equal(a.last('room').host, b.id, 'The returning former host must not take host back');
    assert.equal(a.last('room').players.filter(p => p.id === id).length, 1, 'Resume must not duplicate a room member');
    const { peer: replay, welcome } = await connect('过期令牌重放', oldToken);
    assert.equal(welcome.resumeFailed, true, 'The consumed token must be unusable');
    assert.ok(welcome.id !== id, 'A consumed token cannot recover the former id');
    await delay(120);
    assert.equal(replay.history.some(m => m.t === 'room'), false, 'A consumed token must not join any room');
    await replay.terminate();
    return { resumedId: id, host: b.id, rotatedTokenReplayRefused: true };
  });

  await check('running room resumes full state, same position, active status and a fresh correction epoch', async () => {
    b.send({ t: 'start' });
    await waitFor(() => a.last('room')?.started && own(a) && own(b), 'both genuine players start', 20000);
    a.send({ t: 'debug', op: 'safe', s: 180 });
    // A dev-only command must actually affect authoritative state before it is used as test isolation.
    const mark = a.mark(); a.send({ t: 'debug', op: 'tp', x: own(a).p[0], z: own(a).p[2] });
    await a.after(mark, m => m.t === 'correct' && m.forced, 'real debug teleport acknowledges isolation');
    const position = [...a.correction.p], c = a.correction.c;
    a.input(position, c, { yaw: .25 }); await ticks(a);
    const authoritative = [...own(a).p];
    a = await resume(a);
    await fullResume(a, authoritative, c);
    for (const type of ['doors', 'items', 'keys', 'bag', 'power', 'nav']) assert.deepEqual(a.last(type), b.last(type), `Full resumed ${type} must match the teammate`);
    return { id: a.id, position: authoritative, epochAdvanced: true, fullStateTypes: 10 };
  });

  await check('old epoch, omitted epoch and duplicate input sequence cannot replay movement', async () => {
    const p = [...own(a).p], c = a.correction.c;
    const target = [p[0] + .12, p[1], p[2]];
    a.input(target, c - 1); await ticks(a);
    assert.ok(near(own(a).p, p), 'An input from the pre-disconnect epoch must be ignored');
    a.send({ t: 'input', seq: ++a.seq, p: target, yaw: 0, pitch: 0, f: 0 }); await ticks(a);
    assert.ok(near(own(a).p, p), 'Omitting c must not bypass the resume epoch');
    a.input(p, c, { yaw: .75 }); await ticks(a);
    assert.ok(Math.abs(own(a).yaw - .75) < .02, 'A new-epoch input must still be accepted');
    a.send({ t: 'input', seq: a.seq, p: target, yaw: 0, pitch: 0, f: 0, c }); await ticks(a);
    assert.ok(near(own(a).p, p), 'A duplicated sequence must not move the player');
    // Prove the replay destination itself is a valid small move; rejecting everything is not a pass.
    a.input(target, c); await ticks(a);
    assert.ok(near(own(a).p, target), 'The same destination with fresh c and seq must be accepted');
    return { staleEpochIgnored: true, missingEpochIgnored: true, duplicateSequenceIgnored: true, freshInputAccepted: true };
  });

  await check('a resumed transport still rejects a fresh-epoch ten-metre teleport', async () => {
    const p = [...own(a).p], c = a.correction.c, mark = a.mark();
    a.input([p[0] + 10, p[1], p[2]], c);
    const rejected = await a.after(mark, m => m.t === 'correct' && m.ack === a.seq, 'resumed movement remains authoritative');
    assert.ok(near(rejected.p, p), 'A fresh resume credential cannot authorize a teleport');
    assert.ok(rejected.c > c && rejected.forced !== true, 'Invalid movement must take the ordinary correction path');
    await ticks(a);
    assert.ok(near(own(a).p, p), 'The rejected prediction must not change the room position');
    a.input(p, rejected.c); await ticks(a);
    assert.equal(a.socket.readyState, WebSocket.OPEN, 'The corrected transport must remain usable');
    return { teleportRejected: true, positionPreserved: true, ordinaryCorrectionApplied: true };
  });

  await check('20 Hz input plus 8 Hz held revive stays under the 30 messages/s budget', async () => {
    const downMark = a.mark(); a.send({ t: 'debug', op: 'down', s: 30 });
    await a.after(downMark, m => m.t === 'snap' && m.players.some(p => p.id === a.id && p.st === 1), 'genuine downed state');
    await delay(350);
    const downId = a.id, downEpoch = a.correction.c;
    a = await resume(a);
    await waitFor(() => a.last('resume') && a.correction, 'downed resume carries remaining time');
    assert.equal(a.id, downId);
    assert.equal(own(a).st, 1, 'Disconnecting cannot turn a downed player into an active player');
    assert.ok(a.last('resume').downLeft > 25 && a.last('resume').downLeft < 30, 'Resume carries the remaining countdown instead of resetting the thirty-second clock');
    assert.ok(a.correction.c > downEpoch, 'Downed resume must also change the input epoch');
    const p = [...own(a).p], mark = b.mark();
    b.send({ t: 'debug', op: 'tp', x: p[0] + 1, z: p[2] });
    await b.after(mark, m => m.t === 'correct' && m.forced, 'rescuer stands in reach');
    const stand = [...b.correction.p];
    assert.ok(Math.hypot(stand[0] - p[0], stand[2] - p[2]) < 1.5, 'Rescuer teleport must be inside reach');
    const start = performance.now();
    const inputs = setInterval(() => b.input(stand), 50);
    const revives = setInterval(() => b.send({ t: 'act', kind: 'revive', id: a.id }), 125);
    try {
      await waitFor(() => own(a)?.st === 0, 'held revive succeeds with ordinary movement traffic', 6500);
      assert.ok(performance.now() - start >= 2800, 'A tap cannot complete the three-second rescue');
      await delay(1200);
      assert.equal(b.socket.readyState, WebSocket.OPEN, 'Ordinary play must not trigger the message flood kick');
      assert.equal(own(a).st, 0, 'The revived player must remain active');
    } finally { clearInterval(inputs); clearInterval(revives); }
    return { inputHz: 20, reviveHz: 8, downedResumePreserved: true, revived: true, connectionAlive: true };
  });

  await check('ten-second expiry returns a fresh lobby identity and cannot leave a ghost player', async () => {
    const id = a.id, token = a.token;
    await a.terminate();
    await waitFor(() => b.last('room')?.players.some(p => p.id === id && p.online === false), 'detached player is visibly offline');
    await delay(10_300);
    await waitFor(() => !b.last('room')?.players.some(p => p.id === id) && !b.players.has(id), 'expired member leaves roster and snapshots');
    const { peer: expired, welcome } = await connect('续接甲', token);
    assert.equal(welcome.resumeFailed, true);
    assert.ok(welcome.id !== id, 'Expiry must not resurrect the former identity');
    await delay(200);
    assert.equal(expired.history.some(m => m.t === 'room'), false, 'Expired resume stays in the entry lobby');
    expired.send({ t: 'join', code });
    await expired.after(0, m => m.t === 'snap' && m.players.some(p => p.id === expired.id), 'explicit normal rejoin');
    assert.equal(own(expired).st, 2, 'An explicit late join follows the ordinary spectator rule');
    assert.equal(b.last('room').players.some(p => p.id === id), false, 'Old identity must remain gone after a normal join');
    a = expired;
    return { expiredId: id, newId: a.id, noGhost: true, normalLateJoinSpectator: true };
  });

  await check('real WS ping/pong terminates a non-pong client after fifteen seconds', async () => {
    const { peer: silent } = await connect('不应答控制帧', undefined, { autoPong: false });
    silent.send({ t: 'join', code });
    await silent.after(0, m => m.t === 'room' && m.code === code, 'silent socket joins');
    const start = performance.now();
    // The helper still echoes application heartbeat, proving application traffic cannot replace WS pong.
    await waitFor(() => silent.closed, 'actual heartbeat timeout closes the underlying ws', 18_000);
    const afterMs = Math.round(performance.now() - start);
    assert.ok(afterMs >= 14_000 && afterMs < 18_000, 'The control-frame timeout must be approximately fifteen seconds');
    await waitFor(() => b.last('room')?.players.some(p => p.id === silent.id && p.online === false), 'timed-out transport detaches its member');
    assert.equal(b.last('room').host, b.id, 'A heartbeat timeout cannot transfer ownership to an offline peer');
    return { timeoutMs: afterMs, autoPong: false, applicationHeartbeatCannotMaskTimeout: true };
  });

  await check('the fifth simultaneous connection from one IP is refused', async () => {
    const { peer: c } = await connect('限额丙');
    const { peer: d } = await connect('限额丁');
    const fifth = new ReconnectPeer(URL, '限额第五'); peers.push(fifth);
    await fifth.opened;
    await waitFor(() => fifth.closed, 'fifth transport closes at admission');
    assert.ok(fifth.id === undefined, 'A refused connection must not receive an identity');
    assert.equal(c.socket.readyState, WebSocket.OPEN); assert.equal(d.socket.readyState, WebSocket.OPEN);
    // An illegal-message kick must revoke a genuinely joined session, not reserve a bypass token.
    d.send({ t: 'join', code });
    await d.after(0, m => m.t === 'room' && m.code === code, 'fourth genuine room member');
    const revokedToken = d.token, revokedId = d.id;
    for (let i = 0; i < 8; i++) d.send({ t: 'invalid-acceptance-message' });
    await waitFor(() => d.closed, 'eight illegal packets terminate the actual ws');
    await waitFor(() => !b.last('room')?.players.some(p => p.id === revokedId), 'a kicked member is removed immediately');
    const { peer: revoked, welcome } = await connect('被踢令牌重放', revokedToken);
    assert.equal(welcome.resumeFailed, true, 'A kicked session token cannot bypass the invalid-message kick');
    assert.ok(welcome.id !== revokedId, 'A revoked identity must not resume');
    assert.equal(revoked.history.some(m => m.t === 'room'), false, 'A revoked credential cannot silently rejoin');
    assert.equal(b.socket.readyState, WebSocket.OPEN, 'A malformed peer cannot disturb an ordinary teammate');
    await c.terminate(); await revoked.terminate();
    return { admitted: 4, fifthRefused: true, illegalMessagesKicked: true, kickedTokenRevoked: true };
  });

  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  // Assertions above only use fixed credential failure messages; raw hello/welcome never leave memory.
  report.error = error.stack ?? String(error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await Promise.all(peers.map(peer => peer.terminate()));
  await mkdir(fileURLToPath(new globalThis.URL('../test-results/', import.meta.url)), { recursive: true });
  await writeFile(RESULT, JSON.stringify(report, null, 2) + '\n');
}
