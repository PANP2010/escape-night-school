// Noise model shared by the server (event source) and monster AI (listener): how far each action is heard, and how walls muffle it.
import { F_CROUCH, F_RUN } from './protocol.ts';

/** Audible radius in metres per kind of action. */
export const NOISE_RADIUS = { crouch: 0, walk: 4, run: 12, door: 8, item: 15, basketball: 10 } as const;
export type NoiseKind = keyof typeof NOISE_RADIUS;

/** A sound that crosses a wall is heard at this fraction of its radius. */
export const WALL_ATTEN = 0.5;
/** Height above the feet the sound is emitted from / heard at (m); keeps the wall test off the floor plane. */
export const NOISE_EAR_H = 1.0;

/** One sound produced during a tick. `r` is the unattenuated radius; (x, y, z) the source (y = feet). */
export interface NoiseEvent { kind: NoiseKind; x: number; y: number; z: number; r: number; src?: number }

/** Radius of a footstep given input flags (crouch wins over run; not moving makes no sound). */
export function moveNoise(flags: number, moving: boolean): number {
  if (!moving || flags & F_CROUCH) return NOISE_RADIUS.crouch;
  return flags & F_RUN ? NOISE_RADIUS.run : NOISE_RADIUS.walk;
}

/** Kind of footstep for the same inputs (a still or crouching player is 'crouch', radius 0). */
export function moveKind(flags: number, moving: boolean): NoiseKind {
  if (!moving || flags & F_CROUCH) return 'crouch';
  return flags & F_RUN ? 'run' : 'walk';
}

/** Radius at which the sound is heard behind (`blocked`) or without a wall. */
export const effectiveRadius = (r: number, blocked: boolean): number => (blocked ? r * WALL_ATTEN : r);

/** Wall test between two points (the sound path); true if something solid is in between. */
export type BlockedFn = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => boolean;

/** Does a listener at (lx, ly, lz) hear `ev`? Silent events (r ≤ 0) are never heard; the wall test only runs when in range. */
export function hears(ev: NoiseEvent, lx: number, ly: number, lz: number, blocked?: BlockedFn): boolean {
  if (ev.r <= 0) return false;
  const d = Math.hypot(lx - ev.x, lz - ev.z);
  if (d > ev.r) return false;
  if (!blocked) return true;
  const wall = blocked(ev.x, ev.y + NOISE_EAR_H, ev.z, lx, ly + NOISE_EAR_H, lz);
  return d <= effectiveRadius(ev.r, wall);
}

/** Per-tick collector: sources push events, the server hands the batch to subscribers once per tick. */
export class NoiseBus {
  private queue: NoiseEvent[] = [];
  private subs: ((events: readonly NoiseEvent[], tick: number) => void)[] = [];

  subscribe(fn: (events: readonly NoiseEvent[], tick: number) => void): () => void {
    this.subs.push(fn);
    return () => { this.subs = this.subs.filter((s) => s !== fn); };
  }

  emit(ev: NoiseEvent): void { if (ev.r > 0) this.queue.push(ev); }

  /** Deliver this tick's events (nothing when quiet) and clear the queue. */
  flush(tick: number): void {
    if (!this.queue.length) return;
    const batch = this.queue;
    this.queue = [];
    for (const f of this.subs) f(batch, tick);
  }
}
