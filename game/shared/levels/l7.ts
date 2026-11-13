import campusData from '../campus/colliders.json' with { type: 'json' };
import { CollisionWorld, type AABB, type Capsule } from '../campus/collision.ts';
import type { DoorSpot } from '../doors.ts';
import type { Vec3 } from '../protocol.ts';
import type { LevelDef } from './def.ts';

/** Real seventh chapter of the shared campaign. */
export const L7_INDEX = 6;
export const L7_CAPSULE: Capsule = { radius: 0.3, height: 1.7, stepHeight: 0.35 };

/** The normal points out of a vertical mirror into its room; center is the glass centre. */
export interface MirrorSurface { id: number; center: Vec3; normal: Vec3; width: number; height: number }
/** wall is the doorway's bottom centre (feet height); normal points into the mirror room. */
export interface MirrorDoor { id: number; mirrorId: number; wall: Vec3; width: number; height: number; normal: Vec3 }

/** LAB dark / specimen: local room x ±2.35, z 1.3..6.76, with floors at 0 / 3.6. */
export const MIRRORS: MirrorSurface[] = [0, 3.6].map((y, i) => ({
  id: i + 1, center: [-82.22, y + 1.45, 143.4], normal: [1, 0, 0], width: 2.2, height: 2.4,
}));
export const MIRROR_DOORS: MirrorDoor[] = [0, 3.6].map((y, i) => ({
  id: i + 1, mirrorId: i + 1, wall: [-77.65, y, 143.4], normal: [-1, 0, 0], width: 1.2, height: 2.2,
}));
export const L7_EXIT = { x: -76.2, y: 3.6, z: 143.4, r: 0.9 };

export const L7: LevelDef = {
  name: '镜廊', building: 'LAB', floors: [1, 2], mirror: true,
  area: { x0: -93, x1: -67, z0: 133, z1: 147, y0: -0.2, y1: 6.8 },
  spawns: [
    { x: -80.9, y: 0, z: 142.5 }, { x: -80.05, y: 0, z: 142.5 },
    { x: -79.2, y: 0, z: 142.5 }, { x: -80.05, y: 0, z: 143.4 },
  ],
  exit: L7_EXIT, exitName: '二楼标本室外的走廊', lockedDoors: [],
  barriers: [
    { kind: 'grate', x0: -81, x1: -79, z0: 133.05, z1: 133.25, y: 0, h: 2.6, face: 'z+', say: '出口在二楼镜廊' },
    // Only the upward first flight on 2F: the 1F → 2F returning flight remains clear.
    { kind: 'grate', x0: -73.3, x1: -73.05, z0: 141.5, z1: 143.98, y: 3.6, h: 2.4, face: 'x-', say: '三楼封闭' },
  ],
  landmarks: [
    { kind: 'arrow', x: -80, y: 0, z: 140, dir: 'x+', text: '镜廊' },
    { kind: 'hydrant', x: -92.65, y: 0, z: 140, dir: 'x+' },
    { kind: 'sign', x: -79.4, y: 0, z: 141.3, dir: 'z-', text: '暗室 · 留意镜中的门' },
    { kind: 'lit', x: -76.2, y: 3.6, z: 143.4, dir: 'z-' },
    { kind: 'fallen', x: -92.4, y: 0, z: 144.4, dir: 'x+' },
  ], hides: [], items: [],
};

/** Reflect any world point across a plane, including non-unit and reversed normals. */
export function mirrorPoint(mirror: MirrorSurface, p: Vec3): Vec3 {
  const n = mirror.normal, c = mirror.center;
  const k = 2 * ((p[0] - c[0]) * n[0] + (p[1] - c[1]) * n[1] + (p[2] - c[2]) * n[2]) /
    (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
  return [p[0] - k * n[0], p[1] - k * n[1], p[2] - k * n[2]];
}

/** Yaw 0 faces -z; positive yaw turns toward -x, matching the player camera. */
export function mirrorYaw(mirror: MirrorSurface, yaw: number): number {
  const n = mirror.normal, x = -Math.sin(yaw), z = -Math.cos(yaw);
  const k = 2 * (x * n[0] + z * n[2]) / (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
  return Math.atan2(-(x - k * n[0]), -(z - k * n[2]));
}

/** A door drawn at this reflected point corresponds to this point on the real wall. */
export const wallPointFromReflection = (mirror: MirrorSurface, p: Vec3): Vec3 => mirrorPoint(mirror, p);

const onMirrorFloor = (p: Vec3): boolean => Math.abs(p[1]) <= 0.75 || Math.abs(p[1] - 3.6) <= 0.75;

/** The two mirror rooms and their east connecting hall, excluding the ordinary main corridor and stairs. */
export function inMirrorHall(p: Vec3): boolean {
  return onMirrorFloor(p) && p[0] >= -82.25 && p[0] <= -75.3 && p[2] >= 141.4 && p[2] <= 146.76;
}

/** Visible glass in the player's current room and storey, within a 110° viewing cone. p is feet position. */
export function mirrorForPlayer(p: Vec3, yaw: number, pitch = 0): MirrorSurface | undefined {
  if (!p.every(Number.isFinite) || !Number.isFinite(yaw) || !Number.isFinite(pitch) ||
      !inMirrorHall(p) || p[0] > -77.75) return undefined;
  const fx = -Math.sin(yaw) * Math.cos(pitch), fy = Math.sin(pitch), fz = -Math.cos(yaw) * Math.cos(pitch);
  let best: MirrorSurface | undefined, distance = Infinity;
  for (const m of MIRRORS) {
    if (Math.abs(p[1] - (m.center[1] - 1.45)) > 0.75) continue;
    const dx = m.center[0] - p[0], dy = m.center[1] - (p[1] + 1.55), dz = m.center[2] - p[2];
    if (dx * m.normal[0] + dy * m.normal[1] + dz * m.normal[2] >= -0.05) continue;
    const d = Math.hypot(dx, dy, dz);
    if (d < distance && (dx * fx + dy * fy + dz * fz) / d >= Math.cos(55 * Math.PI / 180)) {
      best = m; distance = d;
    }
  }
  return best;
}

/** Campus doors are real existing holes and begin open in this level. */
export const L7_CAMPUS_DOORS: DoorSpot[] = (campusData.doors as DoorSpot[]).filter((d) =>
  d.x >= L7.area.x0 && d.x <= L7.area.x1 && d.z >= L7.area.z0 && d.z <= L7.area.z1 &&
  (d.y0 ?? 0) >= 0 && (d.y0 ?? 0) < 7.2,
).map((d) => ({ ...d, box: { ...d.box }, locked: false }));

/** A box minus an intersecting opening, preserving side pieces and its lintel. */
function subtract(b: AABB, hole: AABB): AABB[] {
  const x0 = Math.max(b.minX, hole.minX), x1 = Math.min(b.maxX, hole.maxX);
  const y0 = Math.max(b.minY, hole.minY), y1 = Math.min(b.maxY, hole.maxY);
  const z0 = Math.max(b.minZ, hole.minZ), z1 = Math.min(b.maxZ, hole.maxZ);
  if (x0 >= x1 || y0 >= y1 || z0 >= z1) return [b];
  const out: AABB[] = [];
  if (b.minX < x0) out.push({ ...b, maxX: x0 });
  if (x1 < b.maxX) out.push({ ...b, minX: x1 });
  if (b.minZ < z0) out.push({ ...b, minX: x0, maxX: x1, maxZ: z0 });
  if (z1 < b.maxZ) out.push({ ...b, minX: x0, maxX: x1, minZ: z1 });
  if (b.minY < y0) out.push({ ...b, minX: x0, maxX: x1, minZ: z0, maxZ: z1, maxY: y0 });
  if (y1 < b.maxY) out.push({ ...b, minX: x0, maxX: x1, minZ: z0, maxZ: z1, minY: y1 });
  return out;
}

/**
 * Real LAB collision/render boxes, including the 2F floor, stairs and upper ceiling.
 * Pushing a secret wall also moves the attached cabinet strip out of its doorway.
 * Campus door slabs are omitted because those doors begin open; unrelated furniture stays solid.
 */
export function l7Colliders(openDoorIds: readonly number[] = []): AABB[] {
  const a = L7.area;
  let boxes: AABB[] = (campusData.colliders as AABB[]).filter((b) =>
    b.minX >= a.x0 - 1e-6 && b.maxX <= a.x1 + 1e-6 && b.minZ >= a.z0 - 1e-6 && b.maxZ <= a.z1 + 1e-6 &&
    b.minY < 7.2 && b.maxY > 0,
  ).map((b) => ({ ...b, maxY: Math.min(b.maxY, 7.2) }));
  for (const d of MIRROR_DOORS) {
    if (!openDoorIds.includes(d.id)) continue;
    const hole: AABB = {
      minX: -78.45, maxX: -77.3, minY: d.wall[1], maxY: d.wall[1] + d.height,
      minZ: d.wall[2] - d.width / 2, maxZ: d.wall[2] + d.width / 2,
    };
    boxes = boxes.flatMap((b) => subtract(b, hole));
  }
  for (const b of L7.barriers) boxes.push({ minX: b.x0, maxX: b.x1, minZ: b.z0, maxZ: b.z1, minY: b.y, maxY: b.y + b.h });
  return boxes;
}

export const l7World = (openDoorIds: readonly number[] = []): CollisionWorld => new CollisionWorld(l7Colliders(openDoorIds));
