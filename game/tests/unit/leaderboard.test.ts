import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { SpeedrunLeaderboard, type AuthoritativeRun } from '../../server/leaderboard.ts';
import { speedrunTime } from '../../shared/leaderboard.ts';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const run = (overrides: Partial<AuthoritativeRun> = {}): AuthoritativeRun => ({
  difficulty: 'story', elapsedMs: 600_123, downs: 0, members: [{ name: '值周代号025', escaped: true }], startedAtLevel: 0, debugUsed: false, guidance: false, developerMode: false, ...overrides,
});
async function create() { const dir = await mkdtemp(join(tmpdir(), 'escape-ranking-')); dirs.push(dir); return join(dir, 'data/leaderboard.json'); }

describe('server speedrun leaderboard', () => {
  it('keeps legacy times archived without ranking runs whose guidance setting was never verified', async () => {
    const path = await create(); await mkdir(dirname(path), { recursive: true });
    const legacy = { id: 'legacy', difficulty: 'story', team: 'solo', players: ['旧版记录'], elapsedMs: 300_000, downs: 0, finishedAt: '2026-11-07T00:00:00Z' };
    await writeFile(path, JSON.stringify([legacy]));
    const board = new SpeedrunLeaderboard(path); await board.load();
    expect(board.list('story', 'solo')).toEqual([]);
    board.record(run()); await board.flushed();
    expect(board.list('story', 'solo')).toHaveLength(1);
    const persisted = JSON.parse(await readFile(path, 'utf8'));
    expect(persisted).toContainEqual(legacy);
    expect(persisted.find((entry: { rulesVersion?: number }) => entry.rulesVersion === 2)).toMatchObject({ elapsedMs: 600_123 });
  });

  it('sorts each difficulty and team independently and persists through a new process store', async () => {
    const path = await create(), board = new SpeedrunLeaderboard(path); await board.load();
    board.record(run()); board.record(run({ elapsedMs: 500_000, downs: 2 })); board.record(run({ elapsedMs: 500_000 }));
    board.record(run({ difficulty: 'challenge' })); board.record(run({ members: [{ name: 'a', escaped: true }, { name: 'b', escaped: true }] }));
    await board.flushed();
    const restored = new SpeedrunLeaderboard(path); await restored.load();
    expect(restored.list('story', 'solo').map(e => [e.elapsedMs, e.downs])).toEqual([[500_000, 0], [500_000, 2], [600_123, 0]]);
    expect(restored.list('challenge', 'solo')).toHaveLength(1); expect(restored.list('story', 'team')).toHaveLength(1);
    expect(JSON.parse(await readFile(path, 'utf8'))).toHaveLength(5);
    const copied = restored.list('story', 'solo'); copied[0].players[0] = 'mutated';
    expect(restored.list('story', 'solo')[0].players).toEqual(['值周代号025']);
  });

  it('rejects previews, debug runs, failed escapes and invalid timing', async () => {
    const board = new SpeedrunLeaderboard(await create());
    for (const bad of [{ startedAtLevel: 7 }, { debugUsed: true }, { guidance: true }, { developerMode: true }, { guidance: undefined }, { developerMode: undefined }, { elapsedMs: NaN }, { elapsedMs: -1 }, { members: [{ name: 'out', escaped: false }] }]) {
      expect(board.record(run(bad))).toBe(false);
    }
    expect(board.list('story', 'solo')).toEqual([]);
  });

  it('bounds storage and sanitizes public names without exposing room/session identity', async () => {
    const path = await create(), board = new SpeedrunLeaderboard(path);
    for (let i = 0; i < 55; i++) board.record(run({ elapsedMs: 600_000 + i, members: [{ name: '<值周代号025>\u202e', escaped: true }] }));
    await board.flushed();
    expect(board.list('story', 'solo')).toHaveLength(20);
    expect(JSON.parse(await readFile(path, 'utf8'))).toHaveLength(50);
    expect(board.list('story', 'solo')[0].players).toEqual(['值周代号025']);
    expect(speedrunTime(65_123)).toBe('01:05.1'); expect(speedrunTime(3665_900)).toBe('1:01:05.9');
  });
});
