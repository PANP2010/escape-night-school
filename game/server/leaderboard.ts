import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isDifficultyId, type DifficultyId } from '../shared/difficultyModes.ts';
import { sanitizePlayerName } from '../shared/lobby.ts';
import type { SpeedrunEntry, SpeedrunTeam } from '../shared/leaderboard.ts';

const PER_BOARD = 50;
export interface AuthoritativeRun {
  difficulty: DifficultyId;
  elapsedMs: number;
  downs: number;
  members: readonly { name: string; escaped: boolean }[];
  startedAtLevel: number;
  debugUsed: boolean;
  guidance: boolean;
  developerMode: boolean;
  /** Maximum simultaneously participating players anywhere in this run, never only the finish roster. */
  maxPlayers?: number;
}

/** Receives a completed Room result, never client-submitted times. Bounded memory and atomic persistence. */
export class SpeedrunLeaderboard {
  private entries: SpeedrunEntry[] = [];
  private writes: Promise<void> = Promise.resolve();
  private readonly path: string;
  constructor(path: string) { this.path = path; }

  async load(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (!Array.isArray(parsed)) throw new Error('排行榜文件格式无效');
      this.entries = this.trim(parsed.filter(validEntry).map(e => ({ ...e, players: e.players.map(sanitizePlayerName) })));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('排行榜未能读取：', error);
    }
  }

  list(difficulty: DifficultyId, team: SpeedrunTeam): SpeedrunEntry[] {
    return this.entries.filter(e => e.rulesVersion === 2 && e.difficulty === difficulty && e.team === team).slice(0, 20).map(e => ({ ...e, players: [...e.players] }));
  }

  record(run: AuthoritativeRun): boolean {
    if (run.startedAtLevel !== 0 || run.debugUsed || run.guidance !== false || run.developerMode !== false || !isDifficultyId(run.difficulty)
      || !Number.isFinite(run.elapsedMs) || run.elapsedMs <= 0 || run.elapsedMs > 7 * 24 * 3600_000
      || !Number.isSafeInteger(run.downs) || run.downs < 0
      || run.members.length < 1 || run.members.length > 4 || !run.members.every(m => m.escaped)) return false;
    const entry: SpeedrunEntry = {
      id: randomUUID(), difficulty: run.difficulty, team: Math.max(run.maxPlayers ?? 0, run.members.length) <= 1 ? 'solo' : 'team',
      players: run.members.map(m => sanitizePlayerName(m.name)), elapsedMs: Math.round(run.elapsedMs),
      downs: run.downs, finishedAt: new Date().toISOString(), rulesVersion: 2,
    };
    this.entries = this.trim([...this.entries, entry]);
    const snapshot = JSON.stringify(this.entries);
    this.writes = this.writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await rename(temporary, this.path);
    }).catch(error => { console.error('排行榜保存失败：', error); });
    return true;
  }

  async flushed(): Promise<void> { await this.writes; }
  private trim(entries: SpeedrunEntry[]): SpeedrunEntry[] {
    const counts = new Map<string, number>();
    return entries.sort((a, b) => a.elapsedMs - b.elapsedMs || a.downs - b.downs || a.finishedAt.localeCompare(b.finishedAt))
      .filter(entry => {
        const board = `${entry.rulesVersion ?? 'legacy'}:${entry.difficulty}:${entry.team}`, count = counts.get(board) ?? 0;
        counts.set(board, count + 1); return count < PER_BOARD;
      });
  }
}

function validEntry(value: unknown): value is SpeedrunEntry {
  if (!value || typeof value !== 'object') return false;
  const e = value as SpeedrunEntry;
  return typeof e.id === 'string' && e.id.length <= 64 && isDifficultyId(e.difficulty)
    && (e.rulesVersion === undefined || e.rulesVersion === 2)
    && (e.team === 'solo' || e.team === 'team')
    && Array.isArray(e.players) && e.players.length >= 1 && e.players.length <= 4 && e.players.every(p => typeof p === 'string')
    && Number.isFinite(e.elapsedMs) && e.elapsedMs > 0 && Number.isSafeInteger(e.downs) && e.downs >= 0
    && typeof e.finishedAt === 'string' && Number.isFinite(Date.parse(e.finishedAt));
}
