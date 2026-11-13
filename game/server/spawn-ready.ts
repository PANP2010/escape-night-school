import { TICK_MS } from '../shared/constants.ts';

/** Each player gets this much time after their first ready / accepted input, s. */
export const SPAWN_GRACE_S = 10;
export const SPAWN_GRACE_TICKS = Math.ceil(SPAWN_GRACE_S * 1000 / TICK_MS);

/** One server-issued level incarnation, including same-seed retries. Keep this on the Player when rebinding a connection. */
export interface SpawnReadyState {
  incarnation: number;
  readyAtTick?: number;
  protectedUntilTick?: number;
}

export const createSpawnReady = (incarnation: number): SpawnReadyState => ({ incarnation });

/** A stale, future or repeated ready can never grant or extend protection. */
export function markSpawnReady(state: SpawnReadyState, incarnation: number, tick: number): boolean {
  if (state.incarnation !== incarnation || state.readyAtTick !== undefined) return false;
  state.readyAtTick = tick;
  // ready may arrive just before the next step; the extra tick preserves ten complete seconds after receipt.
  state.protectedUntilTick = tick + SPAWN_GRACE_TICKS + 1;
  return true;
}

/** Loading players are not prey. The first accepted ready starts their one finite grace. */
export const isSpawnProtected = (state: SpawnReadyState, tick: number): boolean =>
  state.readyAtTick === undefined || tick < (state.protectedUntilTick ?? 0);

/** Development summons deliberately end only the sender's grace, consuming it so later ready cannot grant another. */
export function spendSpawnReady(state: SpawnReadyState, tick: number): void {
  state.readyAtTick ??= tick;
  state.protectedUntilTick = Math.min(state.protectedUntilTick ?? tick, tick);
}
