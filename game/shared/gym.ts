import type { AABB } from './campus/collision.ts';
import type { Vec3 } from './protocol.ts';

export interface GymDef {
  equipmentDoor: number;
  switches: { x: number; y: number; z: number; label: string; yaw: number }[];
  ballSpawn: { x: number; y: number; z: number };
  stands: { x: number; z: number; w: number; rows: number; run: number; rise: number }[];
}
export const GYM_WINDOW_S = 5, GYM_SOLO_S = 20, GYM_TRIP_S = 1.5;
export const BALL_RADIUS = 0.22, BALL_NOISE = 10, BALL_TRIP_NOISE = 15;
export interface GymBallSnap { id: number; p: Vec3; v: [number, number] }
/** All deadlines are authoritative simulation seconds, relative to this room's tick. */
export interface GymSnap {
  t: 'gym'; now: number; solo: boolean; until: number[]; complete: boolean;
  balls: GymBallSnap[]; trips: { id: number; until: number }[];
}
export interface GymSound { t: 'gym-sound'; kind: 'roll' | 'bounce' | 'trip' | 'switch' | 'open'; p: Vec3; player?: number }

export function gymStandBoxes(def: GymDef): AABB[] {
  return def.stands.flatMap((s) => Array.from({ length: s.rows }, (_, i) => ({
    minX: s.x, maxX: s.x + s.w, minZ: s.z + i * s.run, maxZ: s.z + (i + 1) * s.run,
    minY: 0, maxY: (i + 1) * s.rise,
  })));
}

/** Server-only use: changing the playing team resets an unfinished attempt, preventing a 20s solo latch in a team. */
export class GymSwitches {
  until = [0, 0, 0, 0];
  complete = false;
  solo = true;
  private team = '';
  syncTeam(ids: readonly number[]) {
    const team = [...ids].sort((a, b) => a - b).join(',');
    if (team !== this.team && !this.complete) this.until.fill(0);
    this.team = team;
    this.solo = ids.length <= 1;
  }
  expire(now: number) {
    if (!this.complete) this.until = this.until.map((t) => t > now ? t : 0);
  }
  press(id: number, now: number): boolean {
    this.expire(now);
    if (!Number.isInteger(id) || id < 0 || id >= 4 || this.complete || this.until[id] > now) return false;
    this.until[id] = now + (this.solo ? GYM_SOLO_S : GYM_WINDOW_S);
    this.complete = this.until.every((t) => t > now);
    return true;
  }
}

/** Distance from a point to a swept circle's centre segment, used for ball and accepted-player movement. */
export function sweptBallHit(a: Vec3, b: Vec3, p: Vec3, radius: number): boolean {
  // Clip the sweep to the height band first. A player stepping down from a stand
  // can meet a ball midway even when one endpoint is above its collision band.
  let from = 0, to = 1;
  const dy = b[1] - a[1];
  if (Math.abs(dy) < 1e-9) {
    if (Math.abs(p[1] - a[1]) > 0.7) return false;
  } else {
    const t0 = (p[1] - 0.7 - a[1]) / dy, t1 = (p[1] + 0.7 - a[1]) / dy;
    from = Math.max(from, Math.min(t0, t1));
    to = Math.min(to, Math.max(t0, t1));
    if (from > to) return false;
  }
  const dx = b[0] - a[0], dz = b[2] - a[2], l2 = dx * dx + dz * dz;
  const t = l2 ? Math.max(from, Math.min(to, ((p[0] - a[0]) * dx + (p[2] - a[2]) * dz) / l2)) : from;
  return Math.hypot(p[0] - a[0] - dx * t, p[2] - a[2] - dz * t) <= radius;
}
