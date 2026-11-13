import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoomManager, LEVEL_FADE_S, type Conn } from '../../server/room.ts';
import { SpeedrunLeaderboard, type AuthoritativeRun } from '../../server/leaderboard.ts';
import { ST_OK, ST_SPECTATE, type ServerMsg } from '../../shared/protocol.ts';
import { TICK_MS } from '../../shared/constants.ts';
import { mulberry32 } from '../../shared/rng.ts';
import type { RoomOptions } from '../../shared/runMode.ts';
import type { DifficultyId } from '../../shared/difficultyModes.ts';

const directories: string[] = [];
const pending: SpeedrunLeaderboard[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const board of pending.splice(0)) await board.flushed();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function setup(count = 1, initialLevel = 0, options: RoomOptions = { guidance: false }, difficulty: DifficultyId = 'story') {
  vi.stubEnv('NODE_ENV', 'development');
  const directory = await mkdtemp(join(tmpdir(), 'escape-authority-'));
  directories.push(directory);
  const board = new SpeedrunLeaderboard(join(directory, 'leaderboard.json'));
  pending.push(board);
  const runs: AuthoritativeRun[] = [], accepted: boolean[] = [];
  const manager = new RoomManager(mulberry32(104));
  manager.onRunComplete = run => { runs.push(structuredClone(run)); accepted.push(board.record(run)); };
  const room = manager.create(true, initialLevel, difficulty, options);
  const messages = new Map<number, ServerMsg[]>(), connections: Conn[] = [];
  const joinPlayer = (id: number, now: number) => {
    const sent: ServerMsg[] = []; messages.set(id, sent);
    const connection: Conn = { id, name: `player${id}`, send: message => sent.push(message), sendRaw: raw => sent.push(JSON.parse(raw)) };
    connections.push(connection); room.add(connection, now); return connection;
  };
  for (let id = 1; id <= count; id++) joinPlayer(id, 0);
  const ready = (now: number) => {
    const current = connections.filter(connection => room.players.has(connection.id));
    if (room.introFrozen) {
      const intro = messages.get(current[0].id)!.filter((message): message is Extract<ServerMsg, { t: 'event'; kind: 'intro' }> => message.t === 'event' && message.kind === 'intro').at(-1)!;
      for (const connection of current) room.handle(connection, { t: 'intro-skip', id: intro.id }, now);
      expect(room.introFrozen).toBe(false);
    }
    for (const connection of current) room.handle(connection, { t: 'ready', incarnation: room.incarnation }, now);
  };
  const startedAt = 1000;
  room.handle(connections[0], { t: 'start' }, startedAt);
  // Private level placement isolates result authority. It is not a claim of completing the eight-chapter route.
  const level = (index: number, now: number) => {
    (room as unknown as { loadLevel(index: number): void }).loadLevel(index);
    ready(now);
  };
  const finish = (now: number) => {
    const host = connections.find(connection => connection.id === room.host)!;
    const register = room.level.def.finale!.rollcall;
    room.players.get(host.id)!.p = [register.x, register.y, register.z + 1.45];
    for (const player of room.players.values()) if (player.st === ST_OK)
      room.handle(host, { t: 'act', kind: 'rollcall', id: player.conn.id }, now);
    room.step(now);
    const phase = messages.get(host.id)!.filter(message => message.t === 'finale').at(-1)!;
    expect(phase.phase).toBe('chase');
    for (const player of room.players.values()) if (player.st === ST_OK)
      player.p = [room.level.exit.x, room.level.exit.y, room.level.exit.z];
    room.step(now + TICK_MS);
    expect(messages.get(host.id)!.filter(message => message.t === 'completed').at(-1)?.members.every(member => member.escaped)).toBe(true);
  };
  return { room, board, runs, accepted, messages, connections, joinPlayer, ready, level, finish, startedAt };
}

describe('Room completion authority for public speedrun boards', () => {
  it('awards the optional name unlock only to a genuine nightmare campaign, including guided clears', async () => {
    for (const item of [
      { difficulty: 'nightmare', initial: 0, options: { guidance: false }, debug: false, unlock: true },
      { difficulty: 'nightmare', initial: 0, options: { guidance: true }, debug: false, unlock: true },
      { difficulty: 'challenge', initial: 0, options: { guidance: false }, debug: false, unlock: false },
      { difficulty: 'nightmare', initial: 7, options: { guidance: false }, debug: false, unlock: false },
      { difficulty: 'nightmare', initial: 0, options: { guidance: false, developerMode: true }, debug: false, unlock: false },
      { difficulty: 'nightmare', initial: 0, options: { guidance: false }, debug: true, unlock: false },
    ] as const) {
      const s = await setup(1, item.initial, item.options, item.difficulty); s.ready(1000);
      if (item.debug) s.room.handle(s.connections[0], { t: 'debug', op: 'safe', s: 600 }, 1500);
      if (item.initial !== 7) s.level(7, 2000);
      s.finish(60_000);
      expect(s.messages.get(1)!.filter(m => m.t === 'completed').at(-1)?.namedMonitorsUnlocked).toBe(item.unlock);
    }
  });

  it('excludes a guided or developer room even when no cheat was ever used', async () => {
    for (const options of [{}, { guidance: true }, { guidance: false, developerMode: true }]) {
      const s = await setup(1, 0, options); s.ready(1000);
      s.level(7, 3000); s.finish(60_000);
      expect(s.runs[0].debugUsed).toBe(false);
      expect(s.accepted).toEqual([false]);
      expect(s.board.list('story', 'solo')).toEqual([]);
      const display = s.messages.get(1)!.filter(message => message.t === 'completed').at(-1)!;
      expect(display.ranking).toBe(options.developerMode ? 'developer' : 'guidance');
    }
  });

  it('records one real escaped result and counts wall-clock cinematic pauses and stalled simulation time', async () => {
    const s = await setup();
    expect(s.room.introFrozen).toBe(true);
    const tick = s.room.tick;
    s.room.step(6000); // The cinematic still owns authority; simulation time has not advanced.
    expect(s.room.tick).toBe(tick);
    s.ready(6000);
    s.level(7, 10_000);
    s.finish(95_000); // No simulated ticks were invented for the 85-second scheduling/network gap.
    expect(s.runs).toHaveLength(1);
    expect(s.runs[0]).toMatchObject({ elapsedMs: 94_050, startedAtLevel: 0, debugUsed: false, maxPlayers: 1 });
    expect(s.accepted).toEqual([true]);
    expect(s.board.list('story', 'solo')[0].elapsedMs).toBe(94_050);
    const display = s.messages.get(1)!.filter(message => message.t === 'completed').at(-1)!;
    expect(s.runs[0].elapsedMs).toBeGreaterThan(display.elapsedMs);
    s.room.step(96_000); s.room.step(97_000);
    expect(s.runs).toHaveLength(1);
  });

  it('keeps a team run in the team board when only one player reaches the final chapter', async () => {
    const s = await setup(2); s.ready(1000);
    s.room.remove(s.connections[1], 2000);
    s.level(7, 3000); s.finish(60_000);
    expect(s.runs[0]).toMatchObject({ maxPlayers: 2, members: [{ name: 'player1', escaped: true }] });
    expect(s.board.list('story', 'solo')).toEqual([]);
    expect(s.board.list('story', 'team')).toHaveLength(1);
  });

  it('counts a late spectator once recruited at a chapter transition, even if they later leave', async () => {
    const s = await setup(); s.ready(1000);
    const late = s.joinPlayer(2, 2000);
    expect(s.room.players.get(2)!.st).toBe(ST_SPECTATE);
    s.level(1, 3000);
    expect(s.room.players.get(2)!.st).toBe(ST_OK);
    s.room.remove(late, 4000);
    s.level(7, 5000); s.finish(60_000);
    expect(s.runs[0].maxPlayers).toBe(2);
    expect(s.board.list('story', 'solo')).toEqual([]);
    expect(s.board.list('story', 'team')).toHaveLength(1);
  });

  it('disqualifies an accepted debug aid for the remaining run, even after another chapter loads', async () => {
    const s = await setup(); s.ready(1000);
    s.room.handle(s.connections[0], { t: 'debug', op: 'safe', s: 600 }, 2000);
    s.level(7, 3000); s.finish(60_000);
    expect(s.runs[0].debugUsed).toBe(true);
    expect(s.accepted).toEqual([false]);
    expect(s.board.list('story', 'solo')).toEqual([]);
  });

  it('does not let guidance conceal a cheated or preview completion from progression rewards', async () => {
    for (const initial of [0, 7]) {
      const s = await setup(1, initial, { guidance: true }); s.ready(1000);
      if (initial === 0) {
        s.room.handle(s.connections[0], { t: 'debug', op: 'safe', s: 600 }, 1500);
        s.level(7, 2000);
      }
      s.finish(60_000);
      const completion = s.messages.get(1)!.filter(m => m.t === 'completed').at(-1)!;
      expect(completion.ranking).toBe(initial === 0 ? 'debug' : 'incomplete');
      expect(completion.namedMonitorsUnlocked).toBe(false);
      expect(s.accepted).toEqual([false]);
    }
  });

  it('rejects every preview start and a finale replay as an incomplete campaign', async () => {
    for (const initial of [3, 4, 5, 6, 7]) {
      const s = await setup(1, initial); s.ready(1000);
      if (initial !== 7) s.level(7, 2000);
      s.finish(60_000);
      expect(s.runs[0].startedAtLevel).toBe(initial);
      expect(s.accepted).toEqual([false]);
      expect(s.board.list('story', 'solo')).toEqual([]);
    }
    const s = await setup(); s.ready(1000); s.level(7, 2000); s.finish(60_000);
    expect(s.accepted).toEqual([true]);
    s.room.handle(s.connections[0], { t: 'restart' }, 61_000);
    for (let i = 1; i <= Math.ceil(LEVEL_FADE_S * 1000 / TICK_MS) + 2; i++) s.room.step(61_000 + i * TICK_MS);
    s.ready(65_000); s.finish(100_000);
    expect(s.runs).toHaveLength(2);
    expect(s.runs[1].startedAtLevel).toBe(7);
    expect(s.accepted).toEqual([true, false]);
    expect(s.board.list('story', 'solo')).toHaveLength(1);
  });
});
