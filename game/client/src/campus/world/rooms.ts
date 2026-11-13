import type { BuildingDef, CampusDef, DoorDef, EntranceDef, FloorDef, RoomDef, Side, WindowDef } from '../../../../shared/campus/campus_schema.ts';
import { courtOuter, entranceLevel, floorStack, parseNightRoom, roomKey, WALL_T } from '../../../../shared/campus/campus_schema.ts';
import { rectMinus, stairPlan, STAIR, type LBox, type LRect } from '../../../../shared/campus/stairs.ts';
import { facadeOpenings } from './building.ts';

/**
 * 走廊与隔墙 (docs/03_campus.md 室内②): the rooms of a storey (floors[].rooms, or a default 「北走廊 + 南教室」 layout
 * for storeys without room data) → partition wall lines with their door/window openings. Pure (no three): the
 * colliders (partitionBoxes) and the render (world/interior.ts) take the same lines. Building-local coordinates.
 * No three here beyond world/building.ts's facadeOpenings (the default layout keeps its walls off the windows).
 */

export { rectMinus };

export const PART = {
  /** 隔墙 thickness, centred on the shared room edge */ t: 0.2,
  /** default layout: classroom depth, corridor width, target classroom width */ room: 8.4, corridor: 2.6, bay: 9.6,
  /** office layout (旧办公楼): target 办公室 width */ officeBay: 5,
  /** corridor stub kept clear in front of a stairwell door / an entrance */ spur: 2.4,
  /** narrower leftovers become corridor, not rooms */ minRoom: 3,
  /** 回字形 ring: shallowest room band (小房间: 厕所/饮水机间/办公室), their target width; narrowest ring corridor */
  small: 3.4, smallBay: 6, aisleMin: 2, /** shallowest 教室 */ classMin: 6.5,
  door: { width: 1, height: 2.1, inset: 1.1 },
  /** 教室 corridor-side windows (between the front and back doors) */ window: { width: 1.5, sill: 1.2, height: 1.1 },
};

/** A hole through a partition: along-wall span, height span above the storey floor. */
export interface WallHole { u0: number; u1: number; y0: number; y1: number; kind: 'door' | 'window' }
/**
 * One partition wall: a slab along `axis` ('x' = runs along x at z = c; 'z' = runs along z at x = c), from u0 to u1,
 * t thick, standing from y0 (floor) to y1 (under the next slab). Holes' y are relative to y0.
 */
export interface Partition { axis: 'x' | 'z'; c: number; u0: number; u1: number; y0: number; y1: number; holes: WallHole[] }

const E = 1e-6;
export const rectOf = (r: { x: number; z: number; w: number; d: number }): LRect => ({ x0: r.x - r.w / 2, x1: r.x + r.w / 2, z0: r.z - r.d / 2, z1: r.z + r.d / 2 });
const room = (id: string, name: string, kind: RoomDef['kind'], r: LRect, doors: DoorDef[] = [], windows: WindowDef[] = []): RoomDef =>
  ({ id, name, kind, x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2, w: r.x1 - r.x0, d: r.z1 - r.z0, doors, windows });

/** Merge [a, b] intervals (sorted, touching ones joined). */
function union(spans: [number, number][]): [number, number][] {
  const s = [...spans].sort((p, q) => p[0] - q[0]), out: [number, number][] = [];
  for (const [a, b] of s) { const l = out.at(-1); if (l && a <= l[1] + E) l[1] = Math.max(l[1], b); else out.push([a, b]); }
  return out;
}
/** [lo, hi] minus the given intervals. */
export function minus(lo: number, hi: number, cut: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  let u = lo;
  for (const [a, b] of union(cut)) { if (a > u + E && a < hi) out.push([u, Math.min(a, hi)]); u = Math.max(u, b); }
  if (hi > u + E) out.push([u, hi]);
  return out;
}

/**
 * Plan rects rooms must keep clear on a storey: each stairwell it serves + a corridor stub in front of its door, and
 * a 门厅 stub inside each entrance on it (the ground-floor ones; upstairs a 连廊门's).
 */
function reserved(b: BuildingDef, level: number, band: number = PART.room): { rect: LRect; stair: boolean }[] {
  const out: { rect: LRect; stair: boolean }[] = [];
  const S = PART.spur;
  for (const s of b.stairwells ?? []) {
    if (level < s.from || level > s.to) continue;
    const r = rectOf(s), d = stairPlan(b, s, WALL_T).doorSide;
    out.push({ rect: r, stair: true });
    out.push({ rect: d === '+x' ? { ...r, x0: r.x1, x1: r.x1 + S } : d === '-x' ? { ...r, x0: r.x0 - S, x1: r.x0 }
      : d === '+z' ? { ...r, z0: r.z1, z1: r.z1 + S } : { ...r, z0: r.z0 - S, z1: r.z0 }, stair: false });
  }
  for (const e of b.entrances ?? []) if (entranceLevel(e) === level) out.push({ rect: entranceStub(b, e, band), stair: false });
  return out;
}
function entranceStub(b: BuildingDef, e: EntranceDef, band: number): LRect {
  // a 门厅 through the room band (`band` deep) it opens into, out to the corridor (回字形: to the 天井 wall, across the ring)
  const hw = b.w / 2, hd = b.d / 2, h = e.width / 2 + 0.6, c = courtOuter(b);
  if (c) switch (e.side) {
    case '+x': return { x0: c.x1, x1: hw, z0: e.at - h, z1: e.at + h };
    case '-x': return { x0: -hw, x1: c.x0, z0: e.at - h, z1: e.at + h };
    case '+z': return { x0: e.at - h, x1: e.at + h, z0: c.z1, z1: hd };
    default: return { x0: e.at - h, x1: e.at + h, z0: -hd, z1: c.z0 };
  }
  const S = WALL_T + (e.side[1] === 'z' ? band + PART.corridor / 2 : PART.spur);
  switch (e.side) {
    case '+x': return { x0: hw - S, x1: hw, z0: e.at - h, z1: e.at + h };
    case '-x': return { x0: -hw, x1: -hw + S, z0: e.at - h, z1: e.at + h };
    case '+z': return { x0: e.at - h, x1: e.at + h, z0: hd - S, z1: hd };
    default: return { x0: e.at - h, x1: e.at + h, z0: -hd, z1: -hd + S };
  }
}

/** What a band of rooms holds: room `k` of `n` → kind, name, door count; and the target room width. */
interface BandSpec { room: (k: number, n: number) => [RoomDef['kind'], string, 1 | 2]; bay: number }
const CLASSROOMS: BandSpec = { room: () => ['classroom', '教室', 2], bay: PART.bay };
/** 小房间 band: 男厕 at one end, 女厕 at the other, the 饮水机间 in the middle, 办公室 between. */
const SMALL: BandSpec = {
  bay: PART.smallBay,
  room: (k, n) => (k === 0 ? ['toilet', '男厕所', 1] : k === n - 1 ? ['toilet', '女厕所', 1] : k === Math.floor(n / 2) ? ['water', '饮水机间', 1] : ['office', '办公室', 1]),
};

/**
 * A row of rooms filling `band` along x, doors on `doorSide` (the corridor side). Stretches blocked by a reserved rect
 * become corridor (minus the stairwells themselves); what is left is cut into rooms ≈ `spec.bay` wide. `open` = the
 * x span of the door side with corridor in front of it (a 回字形 band that takes the corners only faces the ring
 * corridor between them): doors keep to it, and a room that would get no door there is merged into its neighbour.
 */
function bandRooms(band: LRect, doorSide: Side, spec: BandSpec, tag: string, res: { rect: LRect; stair: boolean }[], snap: Snap, open: [number, number] = [band.x0, band.x1]): RoomDef[] {
  const hits = res.filter(r => r.rect.z0 < band.z1 - E && r.rect.z1 > band.z0 + E && r.rect.x0 < band.x1 - E && r.rect.x1 > band.x0 + E);
  // a free stretch's ends move inward off any window in the outer wall they would butt into (the corridor widens)
  const free = minus(band.x0, band.x1, hits.map(r => [Math.max(band.x0, r.rect.x0), Math.min(band.x1, r.rect.x1)]))
    .map(([a, b]) => [a > band.x0 + E ? snap(a, 1) : a, b < band.x1 - E ? snap(b, -1) : b] as [number, number]).filter(([a, b]) => b > a + E);
  const blocked = minus(band.x0, band.x1, free);
  const out: RoomDef[] = [];
  const stairs = hits.filter(r => r.stair).map(r => r.rect);
  const corridor = (x0: number, x1: number) => {
    let parts: LRect[] = [{ ...band, x0, x1 }];
    for (const s of stairs) parts = parts.flatMap(p => rectMinus(p, s));
    for (const p of parts) if (p.x1 - p.x0 > E && p.z1 - p.z0 > E) out.push(room(`${tag}c${out.length}`, '走廊', 'corridor', p));
  };
  for (const [x0, x1] of blocked) corridor(x0, x1);
  const { width: dw, inset } = PART.door, win = PART.window, jamb = 0.3, need = dw + 2 * jamb;
  const reach = (a: number, c: number) => Math.min(c, open[1]) - Math.max(a, open[0]);
  const rooms: [number, number][] = [];
  for (const [x0, x1] of free) {
    if (x1 - x0 < PART.minRoom || reach(x0, x1) < need) { corridor(x0, x1); continue; }
    const n = Math.max(1, Math.round((x1 - x0) / spec.bay));
    const cuts = [x0, ...Array.from({ length: n - 1 }, (_, k) => snap(x0 + (k + 1) * (x1 - x0) / n, 0)), x1];
    for (let k = 0; k + 2 < cuts.length;) {
      if (reach(cuts[k], cuts[k + 1]) >= need && reach(cuts[k + 1], cuts[k + 2]) >= need) k++;
      else cuts.splice(k + 1, 1);
    }
    for (let k = 0; k + 1 < cuts.length; k++) rooms.push([cuts[k], cuts[k + 1]]);
  }
  rooms.forEach(([x0, x1], k) => {
    const [kind, name, nd] = spec.room(k, rooms.length);
    const mid = (x0 + x1) / 2, at = (x1 - x0) / 2 - inset;
    const lo = Math.max(x0, open[0]) + dw / 2 + jamb - mid, hi = Math.min(x1, open[1]) - dw / 2 - jamb - mid;
    const clamp = (u: number) => Math.min(hi, Math.max(lo, u));
    // 前门 + 后门 (one, in the open stretch, when they would crowd); a 小房间's one door sits at its end toward the
    // middle of the band
    const two = [clamp(-at), clamp(at)];
    const us = nd === 1 ? [clamp(k < rooms.length / 2 ? at : -at)] : two[1] - two[0] < 3 ? [(two[0] + two[1]) / 2] : two;
    const doors: DoorDef[] = us.map(u => ({ side: doorSide, at: u, width: dw }));
    // 教室 走廊侧高窗 between the doors, as many as fit (each with 0.4 m of wall round it)
    const span = us.length === 2 ? us[1] - us[0] - dw - 0.8 : -1, wc = (us[0] + us[us.length - 1]) / 2;
    const nw = Math.max(0, Math.floor((span + 0.4) / (win.width + 0.4)));
    const windows: WindowDef[] = Array.from({ length: nw }, (_, j) => ({ side: doorSide, at: wc + (j - (nw - 1) / 2) * (win.width + 0.4), width: win.width, sill: win.sill, height: win.height }));
    out.push(room(`${tag}${k + 1}`, name, kind, { ...band, x0, x1 }, doors, windows));
  });
  return out;
}
/**
 * Snap a partition line off the outer-wall openings it would butt into: `axis` = the partition's run direction
 * ('z' = at x = v, meets the ±z walls; `sides` = only those walls). dir +1/−1 = only move toward +/−, 0 = nearest.
 */
type Snap = (v: number, dir: number) => number;
function snapper(b: BuildingDef, axis: 'x' | 'z', sides: Side[] = axis === 'z' ? ['+z', '-z'] : ['+x', '-x']): Snap {
  const m = PART.t / 2 + 0.05;
  // (a 休息平台 window is inside its stairwell's enclosure: no partition reaches it, and it must not shift one across the building)
  const bad = union(facadeOpenings(b).filter(o => sides.includes(o.side) && !o.stair).map(o => [o.u0 - m, o.u1 + m]));
  return (v, dir) => {
    const hit = bad.find(([a, c]) => v > a + E && v < c - E);
    if (!hit) return v;
    return dir > 0 ? hit[1] : dir < 0 ? hit[0] : (v - hit[0] < hit[1] - v ? hit[0] : hit[1]);
  };
}

/**
 * Default storey layout 「北走廊 + 南教室」: a classroom band PART.room deep along the south wall (doors to the north),
 * the corridor PART.corridor wide north of it, and whatever depth is left north of that an open 大厅 (walls only
 * round the classrooms). Stairwells and the stubs in front of their doors / inside entrances stay corridor.
 * A 回字形 building (courtyard) takes `courtRooms` instead.
 */
export function defaultRooms(b: BuildingDef, level: number): RoomDef[] {
  if (b.courtyard) return courtRooms(b, level);
  if (b.layout === 'office') return officeRooms(b, level);
  const T = WALL_T, x0 = -b.w / 2 + T, x1 = b.w / 2 - T, z0 = -b.d / 2 + T, z1 = b.d / 2 - T;
  const res = reserved(b, level), snapX = snapper(b, 'z'), snapZ = snapper(b, 'x');
  if (z1 - z0 < PART.room + PART.minRoom) return [room('c', '走廊', 'corridor', { x0, x1, z0, z1 })];
  const zc = snapZ(z0 + PART.room, 1);
  const out = bandRooms({ x0, x1, z0, z1: zc }, '+z', CLASSROOMS, 's', res, snapX);
  const zh = z1 - (zc + PART.corridor) < PART.minRoom ? z1 : zc + PART.corridor;
  const cut = (r: LRect) => (b.stairwells ?? []).filter(s => level >= s.from && level <= s.to)
    .reduce<LRect[]>((ps, s) => ps.flatMap(p => rectMinus(p, rectOf(s))), [r]);
  for (const r of cut({ x0, x1, z0: zc, z1: zh })) out.push(room(`c${out.length}`, '走廊', 'corridor', r));
  if (zh < z1 - E) for (const r of cut({ x0, x1, z0: zh, z1 })) out.push(room(`h${out.length}`, '大厅', 'hall', r));
  return out;
}

/** 办公楼 bands: 办公室 one door each; the south band's west end is the 厕所 (老楼 one per storey). */
const OFFICES_S: BandSpec = { bay: PART.officeBay, room: k => (k === 0 ? ['toilet', '厕所', 1] : ['office', '办公室', 1]) };
const OFFICES_N: BandSpec = { bay: PART.officeBay, room: () => ['office', '办公室', 1] };

/**
 * Office storey layout (`layout: 'office'`, 旧办公楼): a 中走廊 PART.corridor wide along the middle of the plan, a band
 * of 办公室 on either side (doors onto it; the south band starts with the 厕所 at its west end). Stairwells and the stubs
 * in front of their doors / inside entrances stay corridor, as in the default layout.
 */
export function officeRooms(b: BuildingDef, level: number): RoomDef[] {
  const T = WALL_T, x0 = -b.w / 2 + T, x1 = b.w / 2 - T, z0 = -b.d / 2 + T, z1 = b.d / 2 - T;
  const snapX = snapper(b, 'z'), snapZ = snapper(b, 'x');
  const zm = (z0 + z1) / 2, zc0 = snapZ(zm - PART.corridor / 2, -1), zc1 = snapZ(zm + PART.corridor / 2, 1);
  if (zc0 - z0 < PART.minRoom || z1 - zc1 < PART.minRoom) return [room('c', '走廊', 'corridor', { x0, x1, z0, z1 })];
  const res = reserved(b, level, zc0 - z0);
  const out = [
    ...bandRooms({ x0, x1, z0, z1: zc0 }, '+z', OFFICES_S, 's', res, snapX),
    ...bandRooms({ x0, x1, z0: zc1, z1 }, '-z', OFFICES_N, 'n', res, snapX),
  ];
  const parts = (b.stairwells ?? []).filter(s => level >= s.from && level <= s.to)
    .reduce<LRect[]>((ps, s) => ps.flatMap(p => rectMinus(p, rectOf(s))), [{ x0, x1, z0: zc0, z1: zc1 }]);
  for (const r of parts) out.push(room(`c${out.length}`, '走廊', 'corridor', r));
  return out;
}

/** A rect / door side / reserved list with x and z swapped (a band along z is laid out as one along x). */
const flip = (r: LRect): LRect => ({ x0: r.z0, x1: r.z1, z0: r.x0, z1: r.x1 });
const flipSide = (s: Side): Side => `${s[0]}${s[1] === 'x' ? 'z' : 'x'}` as Side;
const flipRoom = (r: RoomDef): RoomDef => ({
  ...r, x: r.z, z: r.x, w: r.d, d: r.w,
  doors: r.doors?.map(d => ({ ...d, side: flipSide(d.side) })), windows: r.windows?.map(w => ({ ...w, side: flipSide(w.side) })),
});

/**
 * 回字形 storey layout: a ring corridor round the 天井 walls, rooms between it and the outer wall. Each ring side's
 * room band is 教室 when it is deep enough (PART.classMin), else 小房间 (男/女厕所 at its ends, 饮水机间, 办公室); a
 * side too shallow even for those is all corridor. The south band runs the full width, the ±x wings from it up to the
 * north wall, the north band between the wings; a band's doors keep to the stretch the ring corridor runs past.
 * Stairwells and the stubs at their doors / inside entrances stay corridor, as in the default layout.
 */
export function courtRooms(b: BuildingDef, level: number): RoomDef[] {
  const T = WALL_T, x0 = -b.w / 2 + T, x1 = b.w / 2 - T, z0 = -b.d / 2 + T, z1 = b.d / 2 - T, c = courtOuter(b)!;
  const res = reserved(b, level), snapZ = snapper(b, 'x');
  const snapS = snapper(b, 'z', ['-z']), snapN = snapper(b, 'z', ['+z']), snapW = snapper(b, 'x', ['-x']), snapE = snapper(b, 'x', ['+x']);
  // corridor width on a ring side of depth d: the full corridor in front of 教室, what is left in front of 小房间
  const aisle = (d: number) => (d >= PART.classMin + PART.corridor ? PART.corridor : d >= PART.small + PART.aisleMin ? Math.min(PART.corridor, d - PART.small) : d);
  const spec = (depth: number) => (depth >= PART.classMin - E ? CLASSROOMS : SMALL);
  // the band edges facing the ring move off outer-wall windows where they meet the outer wall (the corridor widens)
  const zs = snapZ(c.z0 - aisle(c.z0 - z0), -1), zn = c.z1 + aisle(z1 - c.z1);
  // (the wings' inner edges meet the north wall: they move toward the 天井 while the corridor stays PART.aisleMin wide)
  const toCourt = (v: number, dir: number, room: number) => { const u = snapN(v, dir); return Math.abs(room - u) >= PART.aisleMin ? u : snapN(v, -dir); };
  const xw = toCourt(c.x0 - aisle(c.x0 - x0), 1, c.x0), xe = toCourt(c.x1 + aisle(x1 - c.x1), -1, c.x1);
  const out: RoomDef[] = [];
  if (zs > z0 + E) out.push(...bandRooms({ x0, x1, z0, z1: zs }, '+z', spec(zs - z0), 's', res, snapS, [xw, xe]));
  if (zn < z1 - E) out.push(...bandRooms({ x0: xw, x1: xe, z0: zn, z1 }, '-z', spec(z1 - zn), 'n', res, snapN));
  // the wings run along z: lay them out transposed
  const resT = res.map(r => ({ ...r, rect: flip(r.rect) }));
  if (xw > x0 + E) out.push(...bandRooms(flip({ x0, x1: xw, z0: zs, z1 }), '+z', spec(xw - x0), 'w', resT, snapW, [zs, zn]).map(flipRoom));
  if (xe < x1 - E) out.push(...bandRooms(flip({ x0: xe, x1, z0: zs, z1 }), '-z', spec(x1 - xe), 'e', resT, snapE, [zs, zn]).map(flipRoom));
  // the ring corridor itself
  for (const r of rectMinus({ x0: xw, x1: xe, z0: zs, z1: zn }, c)) out.push(room(`r${out.length}`, '走廊', 'corridor', r));
  return out;
}

/** The rooms of a storey: its floors[].rooms when given, else the default layout with floors[].rename applied. */
export function storeyRooms(b: BuildingDef, level: number): RoomDef[] {
  const f = b.floors.find(fl => fl.level === level);
  if (f?.rooms) return f.rooms;
  const rn = f?.rename;
  return rn ? defaultRooms(b, level).map(r => (rn[r.id] ? { ...r, ...rn[r.id] } : r)) : defaultRooms(b, level);
}

/** Find a room by its global id (`A.4F.class7`), in the data or the default layout. */
export function findRoom(c: CampusDef, key: string): { building: BuildingDef; floor: FloorDef; room: RoomDef } | undefined {
  for (const building of c.buildings) for (const floor of building.floors) {
    const room = storeyRooms(building, floor.level).find(r => roomKey(building.id, floor.level, r.id) === key);
    if (room) return { building, floor, room };
  }
  return undefined;
}

/**
 * floors[].rename against the layout it renames (the schema validator only checks its shape): every key is a room of
 * the default layout, and no new id clashes with another room on the storey. Empty = fine.
 */
export function renameProblems(c: CampusDef): string[] {
  const errs: string[] = [];
  for (const b of c.buildings) for (const f of b.floors) {
    if (!f.rename || f.rooms) continue;
    const at = `building ${b.id} level ${f.level} rename`, base = defaultRooms(b, f.level);
    for (const k of Object.keys(f.rename)) if (!base.some(r => r.id === k)) errs.push(`${at} ${k}: no such room in the default layout`);
    const ids = storeyRooms(b, f.level).map(r => r.id);
    for (const id of new Set(ids)) if (ids.filter(i => i === id).length > 1) errs.push(`${at}: room id ${id} used twice`);
  }
  return errs;
}

/** nightRooms (shape checked by the schema): every key names a room of that storey. */
export function nightRoomProblems(c: CampusDef): string[] {
  const errs: string[] = [];
  for (const b of c.buildings) for (const k of b.nightRooms ?? []) {
    const { level, id } = parseNightRoom(k);
    if (!b.floors.some(f => f.level === level)) errs.push(`building ${b.id} nightRooms ${k}: no level ${level}`);
    else if (!storeyRooms(b, level).some(r => r.id === id)) errs.push(`building ${b.id} nightRooms ${k}: no such room`);
  }
  return errs;
}

/** Kinds that are open floor (no walls of their own); every other room is walled on its sides off the outer wall. */
export const OPEN: readonly RoomDef['kind'][] = ['corridor', 'hall', 'stairs', 'court', 'dining', 'auditorium', 'stage'];

/**
 * Partition walls of a storey (building-local): every non-open room's edges that are not on the outer wall, shared
 * edges merged, the rooms' doors and windows on each edge cut as holes. Walls along x are lengthened by t/2 at both
 * ends so corners close; everything is clipped to the inner face of the outer walls.
 */
export function storeyPartitions(b: BuildingDef, level: number): Partition[] {
  const st = floorStack(b).find(s => s.level === level);
  if (!st) return [];
  const T = WALL_T, hw = b.w / 2, hd = b.d / 2, t = PART.t;
  const top = st.y + st.h - STAIR.slab;
  type Edge = { axis: 'x' | 'z'; c: number; u0: number; u1: number; holes: WallHole[] };
  const edges: Edge[] = [];
  for (const r of storeyRooms(b, level)) {
    if (OPEN.includes(r.kind)) continue;
    const R = rectOf(r);
    const sides: [Side, 'x' | 'z', number, number, number, number][] = [
      ['+z', 'x', R.z1, R.x0, R.x1, r.x], ['-z', 'x', R.z0, R.x0, R.x1, r.x],
      ['+x', 'z', R.x1, R.z0, R.z1, r.z], ['-x', 'z', R.x0, R.z0, R.z1, r.z],
    ];
    for (const [side, axis, c, u0, u1, mid] of sides) {
      if (Math.abs(Math.abs(c) - (axis === 'x' ? hd : hw)) < 0.3) continue; // on (or against) the outer wall
      const holes: WallHole[] = [
        ...(r.doors ?? []).filter(d => d.side === side).map(d => ({ u0: mid + d.at - d.width / 2, u1: mid + d.at + d.width / 2, y0: 0, y1: d.height ?? PART.door.height, kind: 'door' as const })),
        ...(r.windows ?? []).filter(w => w.side === side).map(w => ({ u0: mid + w.at - w.width / 2, u1: mid + w.at + w.width / 2, y0: w.sill, y1: w.sill + w.height, kind: 'window' as const })),
      ];
      const ext = axis === 'x' ? t / 2 : 0, lim = axis === 'x' ? hw - T : hd - T;
      edges.push({ axis, c, u0: Math.max(-lim, u0 - ext), u1: Math.min(lim, u1 + ext), holes });
    }
  }
  const out: Partition[] = [];
  const done = new Set<Edge>();
  for (const e of edges) {
    if (done.has(e)) continue;
    const same = edges.filter(f => !done.has(f) && f.axis === e.axis && Math.abs(f.c - e.c) < 1e-3);
    same.forEach(f => done.add(f));
    const holes = same.flatMap(f => f.holes);
    for (const [u0, u1] of union(same.map(f => [f.u0, f.u1]))) {
      out.push({ axis: e.axis, c: e.c, u0, u1, y0: st.y, y1: top, holes: holes.filter(h => h.u0 >= u0 - E && h.u1 <= u1 + E) });
    }
  }
  return out;
}

/** A partition as solid boxes (building-local) around its holes: horizontal bands between hole edges, piers in each. */
export function partitionBoxes(p: Partition): LBox[] {
  const H = p.y1 - p.y0, t = PART.t / 2;
  const ys = [...new Set([0, H, ...p.holes.flatMap(h => [h.y0, Math.min(h.y1, H)])])].filter(y => y >= 0 && y <= H).sort((a, b) => a - b);
  const out: LBox[] = [];
  for (let i = 0; i + 1 < ys.length; i++) {
    const a = ys[i], c = ys[i + 1];
    const cut = p.holes.filter(h => h.y0 <= a + E && h.y1 >= c - E).map(h => [h.u0, h.u1] as [number, number]);
    for (const [u0, u1] of minus(p.u0, p.u1, cut)) out.push(p.axis === 'x'
      ? { x0: u0, x1: u1, z0: p.c - t, z1: p.c + t, y0: p.y0 + a, y1: p.y0 + c }
      : { x0: p.c - t, x1: p.c + t, z0: u0, z1: u1, y0: p.y0 + a, y1: p.y0 + c });
  }
  // rows that cut nothing new leave piers stacked on piers of the same footprint: merge them (fewer faces to draw)
  const merged: LBox[] = [];
  for (const q of out) {
    const below = merged.find(m => Math.abs(m.y1 - q.y0) < E && Math.abs(m.x0 - q.x0) < E && Math.abs(m.x1 - q.x1) < E && Math.abs(m.z0 - q.z0) < E && Math.abs(m.z1 - q.z1) < E);
    if (below) below.y1 = q.y1; else merged.push({ ...q });
  }
  return merged;
}
