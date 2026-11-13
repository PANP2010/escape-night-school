import { BATTERY_RUN_MUL, BATTERY_S, MAX_PLAYERS_CAMPAIGN } from './constants.ts';
import type { ItemKind, LevelDef } from './levels/def.ts';

/** The roster is sampled at the start of a level and kept through retries. Campaign balance only: royale has no supplies to scale. */
export const difficultyTeamSize = (players: number): number => Math.max(1, Math.min(MAX_PLAYERS_CAMPAIGN, Math.floor(players) || 1));

/** L1/L2 each allow one replacement per player. Sharing lights and switching them off stretches this budget. */
export function batteryBudget(players: number) {
  const teamSize = difficultyTeamSize(players), replacements = teamSize;
  return { teamSize, replacements, secondsPerPlayer: BATTERY_S * 2, runningSecondsPerPlayer: BATTERY_S * 2 / BATTERY_RUN_MUL };
}

export function levelDifficulty(index: number, def: LevelDef, players: number) {
  const teamSize = difficultyTeamSize(players), monitor = def.monitor;
  return {
    teamSize,
    monitors: Math.max(0, Math.floor((teamSize > 1 ? monitor?.teamCount : undefined) ?? monitor?.count ?? 0)),
    batteries: index <= 1 ? batteryBudget(teamSize).replacements : def.items.filter(i => i.kind === 'battery').reduce((sum, i) => sum + i.n, 0),
  };
}

/** Progress gates never delay completion: finding either real L1 key opens its latter-half encounter. */
export function monitorUnlocked(monitor: LevelDef['monitor'], bag: Partial<Record<ItemKind, number>>): boolean {
  return !monitor?.afterItem || (bag[monitor.afterItem] ?? 0) > 0 || (monitor.afterItem === 'drawer_key' && (bag.stair_key ?? 0) > 0);
}

export interface DifficultyPoint { x: number; z: number; y?: number }
export const MONITOR_SPAWN_CLEAR_M = 20;
export const MONITOR_SEPARATION_M = 4;

/** A late encounter must materialize away from every spawn and every living player, including hidden players. */
export function safeMonitorStart(point: DifficultyPoint, spawns: readonly DifficultyPoint[], players: readonly DifficultyPoint[], monitors: readonly DifficultyPoint[] = []): boolean {
  const distance = (p: DifficultyPoint) => Math.hypot(point.x - p.x, point.z - p.z);
  return [...spawns, ...players].every(p => distance(p) >= MONITOR_SPAWN_CLEAR_M)
    && monitors.every(p => distance(p) >= MONITOR_SEPARATION_M);
}
