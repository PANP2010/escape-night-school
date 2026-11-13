// Royale mode: safe zone shrinkage phases and damage over time outside the zone.
import { mulberry32 } from './rng.ts';
import type { AreaDef } from './levels/def.ts';

/** Zone phase progression: waits before first shrink, then several shrinking stages. */
export const ZONE_GRACE_S = 60; // 60s before first shrink
export const ZONE_PHASE_S = 60; // each phase lasts 60s
export const ZONE_PHASES = 4; // 4 shrinkage phases
export const ZONE_OUT_ELIM_S = 8; // 8s outside zone → forced elimination

/**
 * Where a royale player may stand: the whole campus nav (x ±126, z -35.7…204.3, feet y -3.6 in the library basement up to
 * 14.4) plus a rim. A royale room still carries level 1 as a stand-in, whose `area` is one 50 × 34 m region, so
 * `inBounds(level, …)` is no measure of the play area there. A test checks every nav node against this box.
 */
export const ROYALE_AREA: AreaDef = { x0: -128, x1: 128, z0: -38, z1: 207, y0: -5, y1: 16 };

export const inRoyaleArea = (x: number, y: number, z: number): boolean =>
  x >= ROYALE_AREA.x0 && x <= ROYALE_AREA.x1 && z >= ROYALE_AREA.z0 && z <= ROYALE_AREA.z1 && y >= ROYALE_AREA.y0 && y <= ROYALE_AREA.y1;

/** Campus landmark positions for zone centers (building centers from campus.json). */
export const CAMPUS_LANDMARKS: ReadonlyArray<readonly [number, number]> = [
  [0, 2], // 南门 (GATE)
  [-40, 80], // 教学楼A
  [40, 80], // 教学楼B
  [-20, 130], // 旧办公楼 (OFF)
  [-80, 140], // 旧实验楼 (LAB)
  [60, 140], // 图书馆 (LIB)
  [-100, 60], // 体育馆 (GYM)
  [100, 60], // 食堂 (CAN)
  [100, 120], // 礼堂 (HALL)
  [110, 190], // 锅炉房 (BOIL)
  [-76, 184], // 田径场 (FIELD)
] as const;

/** Initial zone (covers most campus), then 4 shrinking stages. */
export interface ZonePhase {
  /** Center [x, z] in world metres. */
  center: readonly [number, number];
  /** Radius in metres. */
  radius: number;
}

/** Generate zone phases for a royale match: initial + 4 shrinks toward random landmarks. */
export function generateZonePhases(seed: number): readonly ZonePhase[] {
  const rng = mulberry32(seed ^ 0x7a6f6e); // 'zon'
  // Initial zone: covers most campus (145m radius from center; campus extents ≈ -130 to 130 x, -10 to 210 z)
  const phases: ZonePhase[] = [{ center: [0, 100], radius: 145 }];

  let prevCenter = phases[0].center;
  const radii = [95, 60, 38, 22]; // shrinking radii for phases 1-4

  for (let i = 0; i < ZONE_PHASES; i++) {
    // Pick a landmark within previous zone that leaves room for the next radius
    const margin = radii[i] * 0.7;
    const candidates = CAMPUS_LANDMARKS.filter(([x, z]) => {
      const dx = x - prevCenter[0], dz = z - prevCenter[1];
      return Math.sqrt(dx * dx + dz * dz) <= phases[phases.length - 1].radius - margin;
    });
    const target = candidates.length > 0
      ? candidates[Math.floor(rng() * candidates.length)]
      : prevCenter; // fallback if no candidates

    phases.push({ center: target, radius: radii[i] });
    prevCenter = target;
  }

  return phases;
}

/** Distance from point to zone center. */
export function distToZoneCenter(x: number, z: number, zone: ZonePhase): number {
  const dx = x - zone.center[0], dz = z - zone.center[1];
  return Math.sqrt(dx * dx + dz * dz);
}

/** Is the point inside the zone? */
export function inZone(x: number, z: number, zone: ZonePhase): boolean {
  return distToZoneCenter(x, z, zone) <= zone.radius;
}
