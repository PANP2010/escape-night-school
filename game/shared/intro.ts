import type { Vec3 } from './protocol.ts';

/** Server wall-clock milliseconds. `now` lets peers map the deadline to their own monotonic clock. */
export interface IntroEvent {
  t: 'event';
  kind: 'intro';
  /** Monotonic for the lifetime of this room, including retries of a chapter. */
  id: number;
  /** Zero-based chapter index, matching the room message. */
  level: number;
  startedAt: number;
  endsAt: number;
  now: number;
  skipped: number[];
  ended: boolean;
  /** Feet positions along connected nav edges; the camera adds its eye height. */
  route: Vec3[];
  silhouette?: Vec3;
}

export interface ClearEvent {
  t: 'event';
  kind: 'clear';
  id: number;
  level: number;
  /** Active play time in seconds, excluding the intro and the following fade. */
  elapsed: number;
  secs: number;
}

export const INTRO_S = 8;
