// A level = a region of the campus (levels/*.ts) plus what a seed decides: where the items lie.
import { mulberry32 } from './rng.ts';
import type { AABB } from './campus/collision.ts';
import type { BarrierDef, ItemKind, LandmarkDef, LevelDef, Pt } from './levels/def.ts';
import { L1 } from './levels/l1.ts';
import { L2 } from './levels/l2.ts';
import { L4 } from './levels/l4.ts';
import { L7, MIRROR_DOORS } from './levels/l7.ts';
import type { MirrorProgress } from './l7-campaign.ts';
import { L3 } from './levels/l3.ts';
import { L8 } from './levels/l8.ts';
import { L6 } from './levels/l6.ts';
import { L5 } from './levels/l5.ts';
import { gymStandBoxes } from './gym.ts';
import { loopSolved, type LoopProgress } from './loop.ts';

export const LEVELS: LevelDef[] = [L1, L2, L3, L4, L5, L6, L7, L8];
export const L6_INDEX = 5;

/** Every entry point uses the same ordered, eight-chapter campaign registry. */
export const levelDefinition = (index: number): LevelDef | undefined => LEVELS[index];
export const hasLevel = (index: number): boolean => Number.isInteger(index) && index >= 0 && levelDefinition(index) !== undefined;
export const EXTRA_LEVELS = new Map<number, LevelDef>();

export type { BarrierDef, ItemKind, Pt };
export interface Item { id: number; kind: ItemKind; x: number; y: number; z: number; spot: string; decoy?: boolean; label?: string }

export interface Level {
  index: number;
  seed: number;
  name: string;
  def: LevelDef;
  spawns: LevelDef['spawns']; // one per player slot
  exit: LevelDef['exit'];
  lockedDoors: number[];
  items: Item[];
}

/** Is the feet position inside the level's active region? */
export const inArea = (lv: Level, x: number, y: number, z: number): boolean => {
  return (lv.def.regions ?? [lv.def.area]).some((a) => x >= a.x0 && x <= a.x1 && z >= a.z0 && z <= a.z1 && y >= a.y0 && y <= a.y1);
};

/** Slack around `area` for the soft boundary (capsule radius plus the doorway/wall thickness the area box ends in). */
export const AREA_MARGIN = 0.3;

/** The soft boundary the server enforces on every move / tp: inside `area` (± AREA_MARGIN in x/z) or in the exit zone. */
export const inBounds = (lv: Level, x: number, y: number, z: number): boolean => {
  const m = AREA_MARGIN;
  return (lv.def.regions ?? [lv.def.area]).some((a) => x >= a.x0 - m && x <= a.x1 + m && z >= a.z0 - m && z <= a.z1 + m && y >= a.y0 && y <= a.y1) || inExit(lv, x, y, z);
};

/** The collider of a barrier (server and client add the same box). */
export const barrierBox = (b: BarrierDef): AABB => ({ minX: b.x0, maxX: b.x1, minY: b.y, maxY: b.y + b.h, minZ: b.z0, maxZ: b.z1 });

/** A fallen desk's footprint: FALLEN.w along the wall, FALLEN.d out from it towards `dir`, FALLEN.h tall. */
export const FALLEN = { w: 1.2, d: 0.7, h: 0.8 };
export const fallenBox = (m: LandmarkDef): AABB => {
  const hx = m.dir[0] === 'x' ? FALLEN.d / 2 : FALLEN.w / 2, hz = m.dir[0] === 'x' ? FALLEN.w / 2 : FALLEN.d / 2;
  return { minX: m.x - hx, maxX: m.x + hx, minY: m.y, maxY: m.y + FALLEN.h, minZ: m.z - hz, maxZ: m.z + hz };
};

/** Every level-only solid (barriers, then fallen desks): the server's barrierWorld and the client's extra colliders. */
export const levelSolids = (def: LevelDef): AABB[] => [
  ...def.barriers.map(barrierBox), ...def.landmarks.filter((m) => m.kind === 'fallen').map(fallenBox),
  ...(def.gym ? gymStandBoxes(def.gym) : []),
  ...(def.broadcast ? def.hides.flatMap((h): AABB[] => {
    const y = h.y ?? 0, half = h.kind === 'booth' ? 0.6 : 0.325;
    const back = { minX: h.x - half, maxX: h.x + half, minY: y, maxY: y + 1.9, minZ: h.z + .21, maxZ: h.z + .43 };
    return h.kind === 'booth' ? [back, ...[-.6, .6].map(x => ({ minX: h.x + x - .04, maxX: h.x + x + .04, minY: y, maxY: y + 1.9, minZ: h.z - .45, maxZ: h.z + .45 }))] : [{ ...back, minZ: h.z - .32 }];
  }) : []),
];

/** Is the feet position in the exit zone? */
export const inExit = (lv: Pick<Level, 'exit'>, x: number, y: number, z: number): boolean =>
  Math.hypot(x - lv.exit.x, z - lv.exit.z) <= lv.exit.r && Math.abs(y - lv.exit.y) < 1.5;

/** Fuses a 停电 level needs in its box (0 for ordinary levels). */
export const fusesNeeded = (lv: Level): number => lv.def.blackout?.fuses ?? 0;

/** Is the lights-out level powered (or not a blackout level at all)? */
export const powered = (lv: Level, fusesIn: number): boolean => fusesIn >= fusesNeeded(lv);

/** Each puzzle keeps its own exit authority: broadcast off, personal loop solved, restored power, or the stair key. */
export const exitOpen = (lv: Level, fusesIn: number, bag: Partial<Record<ItemKind, number>>, progress?: LoopProgress | MirrorProgress | boolean, examPassed = false): boolean =>
  lv.def.finale ? false : lv.def.exam ? examPassed === true : lv.def.mirror ? typeof progress === 'object' && 'keyTaken' in progress && progress.keyTaken && MIRROR_DOORS.every((d) => progress.openDoors.includes(d.id)) :
    lv.def.gym || lv.def.broadcast ? progress === true : lv.def.loop ? loopSolved(lv.def, typeof progress === 'object' && 'step' in progress ? progress : undefined) : lv.def.blackout ? powered(lv, fusesIn) : (bag.stair_key ?? 0) > 0;

/** Pure & deterministic in (index, seed) so server and client build the same level. */
export function generateLevel(index: number, seed: number): Level {
  const def = levelDefinition(index);
  if (!hasLevel(index) || !def) throw new RangeError(`Unknown level index: ${index}`);
  const rng = mulberry32(seed ^ (index * 0x9e3779b1));
  const items: Item[] = [], used = new Set<string>(); // one item per spot across all kinds
  for (const it of def.items) {
    const pool = it.spots.filter((s) => !used.has(s.label));
    for (let k = pool.length - 1; k > 0; k--) { // Fisher–Yates, then take the first n
      const r = Math.floor(rng() * (k + 1));
      [pool[k], pool[r]] = [pool[r], pool[k]];
    }
    for (const s of pool.slice(0, it.n)) used.add(s.label), items.push({ id: items.length + 1, kind: it.kind, x: s.x, y: s.y, z: s.z, spot: s.label,
      ...(it.decoy ? { decoy: true } : {}), ...(it.label ? { label: it.label } : {}),
    });
  }
  return { index, seed, name: def.name, def, spawns: def.spawns, exit: def.exit, lockedDoors: def.lockedDoors, items };
}
