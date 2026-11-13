// Door state machine helpers shared by server (authority) and client (prediction / rendering).
import type { AABB } from './campus/collision.ts';

/** Thickness of a closed door's collision slab (m). */
export const DOOR_T = 0.3;
/** Max distance from the player to a door cell centre for E to work (server-checked, with some slack). */
export const DOOR_REACH = 3.2;
/** Noise radius of opening or closing a door (m). */
export const DOOR_NOISE = 8;

export interface Box { x0: number; z0: number; x1: number; z1: number }
export interface DoorSnap { id: number; open: boolean; locked: boolean }
/** What door logic needs of a door: a campus one (a slab in a 隔墙 hole, `y0`..`y1` above the ground). */
export interface DoorSpot { id: number; x: number; z: number; alongX: boolean; box: Box; y0?: number; y1?: number; locked?: boolean }

/** A campus door's collision slab (client/src/campus/world/doorway.ts campusDoors); open = sunk below the ground, so it blocks nothing. */
export const campusDoorSlab = (d: DoorSpot, open: boolean): AABB => ({
  minX: d.box.x0, maxX: d.box.x1, minZ: d.box.z0, maxZ: d.box.z1,
  minY: open ? -100 : d.y0 ?? 0, maxY: open ? -100 : d.y1 ?? 3,
});

/** The door the player is looking at: nearest within `reach` and roughly in front (yaw 0 faces -Z); campus doors only count on the player's storey (`y` = feet height). Returns -1 if none. */
export function doorTargetIn(defs: readonly DoorSpot[], x: number, z: number, yaw: number, reach = 2.6, y = 0): number {
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  let best = -1, bestD = reach;
  for (const d of defs) {
    if (d.y0 !== undefined && Math.abs(y - d.y0) > 1.2) continue;
    const dx = d.x - x, dz = d.z - z, dist = Math.hypot(dx, dz);
    if (dist > bestD || (dist > 0.8 && (dx * fx + dz * fz) / dist < 0.5)) continue;
    best = d.id; bestD = dist;
  }
  return best;
}
