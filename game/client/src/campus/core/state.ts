// Type stub: the ported campus modules only need the shapes below (no story state in this game).
import type { Bus } from './bus.ts';

export type FlagValue = boolean | number | string;
export type Relation = string;

export const MINUTES_PER_DAY = 24 * 60;

/** "HH:MM" → minute of the day. */
export function parseClock(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`bad clock "${s}"`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** What systems/timeofday + systems/weather read from a store. */
export interface Store {
  state: { time: { day: number; minute: number } };
  bus: Bus;
  getFlag(key: string): FlagValue | undefined;
}
