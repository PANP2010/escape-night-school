/** Ordered campaign modes. Unlocking belongs to the player's local campaign record. */
export type DifficultyId = 'story' | 'standard' | 'challenge' | 'nightmare';
export interface DifficultyMode {
  id: DifficultyId;
  name: string;
  description: string;
  monsterSpeed: number;
  hearing: number;
  batteryMultiplier: number;
  bossCooldown: number;
  bossWindup: number;
}
export const DIFFICULTY_MODES: readonly DifficultyMode[] = Object.freeze([
  { id: 'story', name: '初见', description: '较慢的追逐、更多喘息时间，熟悉八章路线。', monsterSpeed: .8, hearing: .8, batteryMultiplier: 1.5, bossCooldown: 13, bossWindup: 2.2 },
  { id: 'standard', name: '夜巡', description: '原版追逐强度，保持警惕并与同学配合。', monsterSpeed: 1, hearing: 1, batteryMultiplier: 1, bossCooldown: 10, bossWindup: 1.8 },
  { id: 'challenge', name: '禁校', description: '更敏锐的值周生，追逐间的喘息更短。', monsterSpeed: 1.12, hearing: 1.2, batteryMultiplier: .75, bossCooldown: 8, bossWindup: 1.6 },
  { id: 'nightmare', name: '无人生还', description: '追逐更紧、物资更少，每次躲避都要果断。', monsterSpeed: 1.22, hearing: 1.4, batteryMultiplier: .5, bossCooldown: 6.5, bossWindup: 1.4 },
]);
export const isDifficultyId = (value: unknown): value is DifficultyId =>
  typeof value === 'string' && DIFFICULTY_MODES.some(mode => mode.id === value);
/** Older clients omit the mode and retain the original night patrol rules. */
export function difficultyMode(value: unknown): DifficultyMode {
  return DIFFICULTY_MODES.find(mode => mode.id === value) ?? DIFFICULTY_MODES[1];
}
