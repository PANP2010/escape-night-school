/** Real 3-WS acceptance. Start the built development server on 4463 separately. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { F_CROUCH, F_LIGHT, F_RUN, ST_DOWN, ST_SPECTATE, type ServerMsg } from '../shared/protocol.ts';
import { assertActiveSince, assertPrivateCapture, FeedbackPeer, reviveWith, waitFor } from './team-feedback-peer.ts';

const base = `ws://127.0.0.1:${process.env.ESC_TEST_PORT ?? 4463}/ws`;
const peers: FeedbackPeer[] = [];
const report: { endpoint: string; startedAt: string; finishedAt?: string; status: string; cases: unknown[]; error?: string } = {
  endpoint: base, startedAt: new Date().toISOString(), status: 'running', cases: [],
};
const output = new URL('../test-results/team-feedback-ws.json', import.meta.url);

async function check(name: string, body: () => Promise<unknown>) {
  const start = Date.now();
  const evidence = await body();
  report.cases.push({ name, status: 'passed', durationMs: Date.now() - start, evidence });
  console.log(`PASS ${name}`);
}

function routing(marks: number[], victim: FeedbackPeer, by: 'warden' | 'monitor', seq: number) {
  const caught = peers.map((p, i) => p.messages(marks[i], 'caught'));
  const notices = peers.map((p, i) => p.messages(marks[i], 'team-caught'));
  const contact = caught[peers.indexOf(victim)][0]?.m as (Extract<ServerMsg, { t: 'caught' }> & { name?: string }) | undefined;
  let episode = 0;
  for (const [i, p] of peers.entries()) {
    if (p === victim) {
      assert.equal(caught[i].length, 1, 'Victim receives one private caught message');
      const m = caught[i][0].m as Extract<ServerMsg, { t: 'caught' }>;
      const before = victim.snapshots.findLast(s => s.tick < m.tick)?.players.find(player => player.id === victim.id);
      assert.ok(before, 'A prior authoritative position establishes the real contact');
      assertPrivateCapture(m, { id: victim.id, seq, by, at: before.p }, victim.snapshots);
      assert.equal(notices[i].length, 0, 'Victim must not receive a team notice about themself');
    } else {
      assert.equal(caught[i].length, 0, `${p.name}: private caught must not leak`);
      assert.equal(notices[i].length, 1, `${p.name}: exactly one team notice, including spectators`);
      const m = notices[i][0].m as Extract<ServerMsg, { t: 'team-caught' }>;
      assert.ok(Number.isSafeInteger(m.episode) && m.episode > 0);
      assert.deepEqual(m, { t: 'team-caught', id: victim.id, by, episode: m.episode, ...(contact?.name === undefined ? {} : { name: contact.name }) }, 'Teammates receive only the short capture notice with the actual catcher name');
      if (episode) assert.equal(m.episode, episode, 'Every recipient sees the same catch episode');
      episode = m.episode;
    }
  }
  return { by, episode, privateCaughtCounts: caught.map((m) => m.length), teamNoticeCounts: notices.map((m) => m.length) };
}

try {
  const a = new FeedbackPeer('救援甲', base), b = new FeedbackPeer('被抓乙', base), c = new FeedbackPeer('旁观丙', base);
  peers.push(a, b, c);
  await Promise.all(peers.map((p) => p.connect()));
  const create = a.mark(); a.send({ t: 'create' });
  const room = await a.waitMessage(create, 'room', () => true, 45_000);
  for (const p of [b, c]) { p.send({ t: 'join', code: room.code }); await p.waitMessage(0, 'room'); }
  await waitFor(() => peers.every((p) => p.room?.players.length === 3), 'three-member lobby');
  a.send({ t: 'start' });
  await waitFor(() => peers.every((p) => p.room?.started && p.intro?.ended && p.players.size === 3), 'three real clients completed the synchronized intro');
  a.send({ t: 'debug', op: 'safe', s: 600, mob: 1 });
  a.send({ t: 'debug', op: 'safe', s: 600, mob: 2 });
  c.send({ t: 'debug', op: 'down', s: 1 });
  await waitFor(() => peers.every((p) => p.state(c.id)?.st === ST_SPECTATE), 'third client is a genuine spectator');

  let wardenEpisode = 0;
  await check('角色074 catch: private victim message; one short notice for teammate and spectator; no repeated catch notice', async () => {
    const marks = peers.map((p) => p.mark());
    b.look(Math.PI / 2, 0, F_CROUCH | F_RUN | F_LIGHT); b.send({ t: 'debug', op: 'warden', d: 1.5 });
    await b.waitMessage(marks[1], 'caught');
    const caughtTick = b.tick;
    await waitFor(() => peers.every((p) => p.state(b.id)?.st === ST_DOWN), 'down state propagated');
    for (const p of peers) assert.equal(p.state(b.id)?.f, F_LIGHT, `${p.name}: down snapshot clears old crouch/run and keeps flashlight`);
    // Re-summoning onto a still-down player must not create a second episode. Other players stay protected.
    a.send({ t: 'debug', op: 'safe', s: 600 });
    for (let i = 0; i < 2; i++) { b.send({ t: 'debug', op: 'warden', d: 1.5 }); await a.ticks(5); }
    a.send({ t: 'debug', op: 'safe', s: 600, mob: 1 });
    await a.ticks(5);
    const result = routing(marks, b, 'warden', 1); wardenEpisode = result.episode;
    const [x, , z] = b.state()!.p;
    await a.teleport(x + .9, z);
    assert.ok(Math.hypot(a.state()!.p[0] - x, a.state()!.p[2] - z) < 1.5, 'Rescuer really reached the downed player');
    const holdMs = await reviveWith(a, b.id, peers), revivedTick = a.tick;
    // Cross the original 30-second heldUntil, not just the immediate successful-rescue snapshot.
    await waitFor(() => peers.every((p) => p.tick >= caughtTick + 625), 'past the original caught expiry', 40_000);
    const activeSamples = assertActiveSince(peers, b.id, revivedTick);
    // Include the whole observation window, so an expiry cannot send a delayed second capture notice.
    assert.deepEqual(routing(marks, b, 'warden', 1), result);
    assert.equal(c.state()!.st, ST_SPECTATE, 'The spectator was not silently revived by this rescue');
    return { ...result, caughtTick, revivedTick, finalTick: a.tick, holdMs, activeSamples, stableMs: (a.tick - revivedTick) * 50 };
  });

  await check('无脸值日生 catch: correct source and new episode after changing level; spectator receives one notice', async () => {
    a.send({ t: 'debug', op: 'key', door: -1 });
    await a.teleport(-60, 66); await b.teleport(-60, 66, 0, false);
    await waitFor(() => peers.every((p) => p.room?.level === 1), 'real transition into L2', 15_000);
    await waitFor(() => peers.every(p => p.intro?.level === 1 && p.intro.ended), 'L2 synchronized intro ended');
    a.send({ t: 'debug', op: 'safe', s: 600, mob: 1 });
    a.send({ t: 'debug', op: 'safe', s: 600, mob: 2 });
    await a.teleport(30, 84.2, 1); await b.teleport(40, 84.2, 1);
    c.send({ t: 'debug', op: 'down', s: 1 });
    await waitFor(() => peers.every((p) => p.state(c.id)?.st === ST_SPECTATE), 'spectator restored in L2');
    await a.ticks(85); // loadLevel's five-second per-player grace must expire; no blanket debug safe here.
    const marks = peers.map((p) => p.mark());
    b.look(-Math.PI / 2); // summon to the east, within the open corridor
    b.send({ t: 'debug', op: 'monitor', d: 1.5 });
    a.look(Math.PI / 2); b.look(Math.PI / 2); // both active players look west, away from the real monitor
    await b.waitMessage(marks[1], 'caught', (m) => m.by === 'monitor', 12_000);
    a.send({ t: 'debug', op: 'safe', s: 600, mob: 2 });
    await a.ticks(10);
    const result = routing(marks, b, 'monitor', 2);
    assert.ok(result.episode > wardenEpisode, 'Catch episode must not reset on level change');
    return { ...result, recipientStates: peers.map((p) => p.state()!.st) };
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1; console.error(report.error);
} finally {
  report.finishedAt = new Date().toISOString();
  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
  await writeFile(output, JSON.stringify({ ...report, messages: peers.map((p) => ({ name: p.name, id: p.id, events: p.history.filter(({ m }) => ['caught', 'team-caught', 'room', 'error'].includes(m.t)) })) }, null, 2));
  await Promise.all(peers.map((p) => p.close()));
}
