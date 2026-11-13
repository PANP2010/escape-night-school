import type { DifficultyId } from './difficultyModes.ts';

export type SpeedrunTeam = 'solo' | 'team';
/** Public rows contain display names only; room codes and connection/session ids stay private. */
export interface SpeedrunEntry {
  id: string;
  difficulty: DifficultyId;
  team: SpeedrunTeam;
  players: string[];
  elapsedMs: number;
  downs: number;
  finishedAt: string;
  /** 2 proves the server enforced pre-game guidance and developer-room exclusion. Omitted = legacy archive. */
  rulesVersion?: 2;
}
export interface LeaderboardResponse { entries: SpeedrunEntry[]; difficulty: DifficultyId; team: SpeedrunTeam }

export function speedrunTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minute = Math.floor(seconds / 60) % 60;
  return `${hours ? `${hours}:` : ''}${String(minute).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.${Math.floor(ms % 1000 / 100)}`;
}
