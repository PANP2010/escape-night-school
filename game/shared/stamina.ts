import { STAMINA_RUN_S, STAMINA_REGEN_S } from './constants.ts';

/** Stamina 0..1 after `dt` seconds: drains while running, refills when not. Once empty, running needs `STAMINA_MIN` back. */
export const STAMINA_MIN = 0.15;
export function stepStamina(s: number, running: boolean, dt: number): number {
  return running ? Math.max(0, s - dt / STAMINA_RUN_S) : Math.min(1, s + dt / STAMINA_REGEN_S);
}
/** May the player run at stamina `s`? `wasExhausted` applies the hysteresis. */
export function canRun(s: number, wasExhausted: boolean): boolean {
  return wasExhausted ? s >= STAMINA_MIN : s > 0;
}
