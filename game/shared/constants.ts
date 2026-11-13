// Gameplay & network constants shared by server and client.
export const TPS = 20;
/** Flashlight: seconds of light on a full battery, and the drain multiplier while running. */
export const BATTERY_S = 180;
export const BATTERY_RUN_MUL = 1.5;
export const TICK_MS = 1000 / TPS;
export const CELL = 4; // metres per grid cell
export const WALL_H = 3.2;
export const EYE_H = 1.6;
export const CROUCH_EYE_H = 1.0;
export const PLAYER_R = 0.35;
export const MAX_PLAYERS_CAMPAIGN = 4;
export const MAX_PLAYERS_ROYALE = 8;
export function maxPlayers(mode?: 'campaign' | 'royale'): number {
  return mode === 'royale' ? MAX_PLAYERS_ROYALE : MAX_PLAYERS_CAMPAIGN;
}

export const SPEED = { crouch: 1.8, walk: 3.4, run: 6.0 } as const;
/** Server accepts up to this multiple of run speed per input step (latency jitter). */
export const SPEED_TOLERANCE = 1.3;
/** Remote entities render this far behind the newest snapshot. Two ticks (100 ms) is enough on a LAN, but campus /
 *  carrier links sit at 150-250 ms with retransmits: when a batch of snapshots arrives late every remote player and
 *  monster held still and then jumped, which players read as 卡顿. */
export const INTERP_DELAY_MS = 150;
/** Past the newest snapshot, remote players / monsters keep moving on their last velocity for at most this long, then hold. */
export const EXTRAP_MAX_MS = 200;
/** Extrapolated speed cap (m/s, ≈ run · tolerance): a jittery last segment (batched / bursty input) must not fling the entity. */
export const EXTRAP_MAX_SPEED = 8;

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LEN = 4;
export const STAMINA_RUN_S = 5;
export const STAMINA_REGEN_S = 4;
