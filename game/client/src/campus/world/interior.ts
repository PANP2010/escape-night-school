import * as THREE from 'three';
import type { AABB } from '../../../../shared/campus/collision.ts';
import { bridgeSpan, buildingHeight, courtOuter, courtRect, entranceY, floorStack, isHollow, roofTop, WALL_T, type BuildingDef, type CampusDef, type EntranceDef, type Side } from '../../../../shared/campus/campus_schema.ts';
import { flightBoxes, opp, stairPlan, stairTop, STAIR, type Flight, type LBox, type LRect, type StairPlan } from '../../../../shared/campus/stairs.ts';
import { SURF } from '../render/facade.ts';
import { courtOpenings, facadeFrames, facadeOpenings, frameAxes } from './building.ts';
import { minus, partitionBoxes, PART, rectMinus, rectOf, storeyPartitions, storeyRooms } from './rooms.ts';
import { roomSpot, storeyFurniture } from './classroom.ts';

/**
 * 室内 (docs/03_campus.md 室内生成①): a hollow building = outer walls (open at the entrances), a floor slab per upper
 * storey with the stairwells cut out, the 双跑楼梯 of every stairwell (world/stairs.ts) and its enclosure walls with a
 * door per storey. One list of building-local boxes feeds both the colliders and the render (`interiorGeometry`), so
 * what you see is what you walk on. The outer wall's faces are drawn by world/building.ts (outside + inner plane).
 */

/** What an interior box is, for colour (and so the render can skip boxes that building.ts already draws). */
export type Part = 'outer' | 'slab' | 'landing' | 'tread' | 'encl' | 'part' | 'well' | 'rail' | 'furn';
export interface Piece extends LBox { part: Part }

/** 白灰 wall paint (outer walls' inner face, stairwell walls, 隔墙) */
export const PAINT = '#e2ddcf';
const COLOR: Record<Exclude<Part, 'outer' | 'well' | 'furn'>, string> = {
  slab: '#b8b2a3', landing: '#aaa497', tread: '#bdb7a8', encl: PAINT, part: PAINT, rail: '#6d6a60',
};
/**
 * 水磨石 floor top vs 白灰 ceiling vs the slab's cut edge. FLOOR_K keeps the floor a palette step under the walls: at 1
 * the corridor's wall, floor and ceiling all came out the same two greys (#665e53 / #7b7266) by day.
 */
export const FLOOR_K = 0.68; const CEIL = '#e6e2d6', EDGE_K = 0.8;
/**
 * 墙裙: the lower 1.2 m of every wall indoors is painted a pale blue (淡蓝油漆), as school corridors and stairwells are.
 * The act-1 palette has no green, and under the warm indoor light a pale green (#b9c4b0, Oklab C .03) came out the same
 * grey as the wall: this blue is saturated enough (C ~.05) to land on #4a5a70 by day, #2f3a4c at night, dithered with a grey like faded paint. Not cut
 * into the geometry: wall faces carry surf.y = 1 and the interior material (render/interior_light.ts) paints the band
 * from each storey's floor (0 triangles, docs/05 budget).
 */
export const DADO = { h: 1.2, color: '#8aa8cc', /** 分色线: a band this tall along its top, × lineK */ line: 0.035, lineK: 0.72 };
/**
 * 水磨石 on stair treads and landings (surf.y = 3): the material scatters chips per `cell` (m) — a share `dark` of
 * cells × darkK, `light` × lightK — and each tread gets a darker 防滑条 strip near its nosing (geometry, 2 triangles).
 */
/**
 * 白瓷砖 (FurnBox kind tileWhite, surf.y = SURF_TILE; the 后厨's walls, world/canteen.ts tiledRects): `size` m square
 * tiles laid from the storey floor, `joint` m 格缝 between them × `k`; on a tiled wall they run up to `dado` m.
 */
export const TILE = { size: 0.15, joint: 0.01, k: 0.6, dado: 1.5 };
export const TERRAZZO = { cell: 0.025, dark: 0.2, darkK: 0.8, light: 0.16, lightK: 1.12, /** view distance (m) the chips fade out over */ fade: [3, 8], strip: { w: 0.04, at: 0.04, k: 0.72 } };

export { rectMinus };

/** 地下室: top of the ground-floor slab over a basement (a hair above the campus ground and the puddle layer, as the
 *  ground-floor floor elsewhere), and the indoor ambient level below ground (no windows: flat, under INDOOR.deep). */
export const BASEMENT = { floor: 0.02, ambient: 0.45 };

/**
 * Where a building's basement takes the campus ground away (world space): its stairwells that reach below level 1
 * (the ground plane, the puddle layer) and its whole footprint for the walker (CollisionWorld.holes: the ground-floor
 * slab and the basement floor carry it there instead).
 */
export function groundHoles(b: BuildingDef): { stairs: LRect[]; footprint?: LRect } {
  if (!isHollow(b) || floorStack(b)[0].y >= 0) return { stairs: [] };
  const w = (r: LRect): LRect => ({ x0: b.x + r.x0, x1: b.x + r.x1, z0: b.z + r.z0, z1: b.z + r.z1 });
  return {
    stairs: stairPlans(b).filter(p => p.def.from < 1).map(p => w(p.rect)),
    footprint: w({ x0: -b.w / 2, x1: b.w / 2, z0: -b.d / 2, z1: b.d / 2 }),
  };
}

/** Stair plans of a building (outer walls WALL_T thick). */
export const stairPlans = (b: BuildingDef): StairPlan[] => (b.stairwells ?? []).map(s => stairPlan(b, s, WALL_T));

/** Enclosure wall of a stairwell on `side`, split around the door span on every storey the stair serves. */
function enclosure(p: StairPlan, side: Side, y0: number, y1: number, doors: number[]): Piece[] {
  const r = p.rect, t = STAIR.encl;
  const slab = side[1] === 'x'
    ? { x0: side[0] === '+' ? r.x1 - t : r.x0, x1: side[0] === '+' ? r.x1 : r.x0 + t, z0: r.z0, z1: r.z1 }
    : { x0: r.x0, x1: r.x1, z0: side[0] === '+' ? r.z1 - t : r.z0, z1: side[0] === '+' ? r.z1 : r.z0 + t };
  if (side !== p.doorSide) return [{ ...slab, y0, y1, part: 'encl' }];
  const out: Piece[] = [];
  const [d0, d1] = p.door;
  const cut = (lo: number, hi: number): LRect => (side[1] === 'x' ? { ...slab, z0: lo, z1: hi } : { ...slab, x0: lo, x1: hi });
  const [e0, e1] = side[1] === 'x' ? [r.z0, r.z1] : [r.x0, r.x1];
  let y = y0;
  for (const dy of doors) {
    // full-width band up to this door's sill, then the jambs either side of it, then its lintel starts the next band
    if (dy > y) out.push({ ...slab, y0: y, y1: dy, part: 'encl' });
    const top = Math.min(dy + STAIR.door.h, y1);
    out.push({ ...cut(e0, d0), y0: dy, y1: top, part: 'encl' }, { ...cut(d1, e1), y0: dy, y1: top, part: 'encl' });
    y = top;
  }
  if (y1 > y) out.push({ ...slab, y0: y, y1, part: 'encl' });
  return out;
}

/** Floor area inside the outer walls (building-local): the whole plate, or the ring round a 天井 and its walls. */
export function floorPlan(b: BuildingDef): LRect[] {
  const T = WALL_T, inner: LRect = { x0: -b.w / 2 + T, x1: b.w / 2 - T, z0: -b.d / 2 + T, z1: b.d / 2 - T };
  const c = courtOuter(b);
  return c ? rectMinus(inner, c) : [inner];
}

/** Every interior box of a hollow building (building-local); empty for solid ones. */
export function interiorPieces(b: BuildingDef): Piece[] {
  if (!isHollow(b)) return [];
  const H = buildingHeight(b), top = roofTop(b), hw = b.w / 2, hd = b.d / 2, T = WALL_T;
  const out: Piece[] = [];
  // outer walls, open at the entrances (lintel above), parapet included
  for (const side of ['+x', '-x', '+z', '-z'] as Side[]) {
    const alongX = side[1] === 'z', len = alongX ? b.w : b.d, s = side[0] === '+' ? 1 : -1;
    const wall = (u0: number, u1: number, y0: number, y1: number) => out.push(alongX
      ? { x0: u0, x1: u1, z0: s > 0 ? hd - T : -hd, z1: s > 0 ? hd : -hd + T, y0, y1, part: 'outer' }
      : { x0: s > 0 ? hw - T : -hw, x1: s > 0 ? hw : -hw + T, z0: u0, z1: u1, y0, y1, part: 'outer' });
    // entrances stacked on one span (a ground door and the 连廊门 above it, or 2F + 4F 连廊门) cut one column of wall:
    // wall between each opening's head and the next one's sill, the thresholds level with their storey floors
    const spans = new Map<string, EntranceDef[]>();
    for (const e of (b.entrances ?? []).filter(q => q.side === side)) {
      const k = `${e.at - e.width / 2}:${e.at + e.width / 2}`;
      spans.set(k, [...(spans.get(k) ?? []), e]);
    }
    let u = -len / 2;
    for (const es of [...spans.values()].sort((p, q) => p[0].at - q[0].at)) {
      const e0 = es[0].at - es[0].width / 2, e1 = es[0].at + es[0].width / 2;
      wall(u, e0, 0, top);
      let y = 0;
      for (const e of es.sort((p, q) => entranceY(b, p) - entranceY(b, q))) {
        if (entranceY(b, e) > y) wall(e0, e1, y, entranceY(b, e));
        y = entranceY(b, e) + e.height;
      }
      wall(e0, e1, y, top);
      u = e1;
    }
    wall(u, len / 2, 0, top);
  }
  // 天井 walls (回字形): the ring round the void, full height, parapet included (their windows are glazed shut), open
  // at the ground-floor doors out into it (lintel above)
  const court = courtRect(b), courtWall = courtOuter(b);
  if (court && courtWall) for (const r of rectMinus(courtWall, court)) {
    // which wall this strip is, by the way its facade faces (into the void), and its along-wall centre line
    const side: Side = r.z1 <= court.z0 + 1e-6 ? '+z' : r.z0 >= court.z1 - 1e-6 ? '-z' : r.x1 <= court.x0 + 1e-6 ? '+x' : '-x';
    const alongX = side[1] === 'z', mid = alongX ? (court.x0 + court.x1) / 2 : (court.z0 + court.z1) / 2;
    const piece = (u0: number, u1: number, y0: number) => {
      if (u1 > u0 + 1e-6) out.push(alongX ? { ...r, x0: u0, x1: u1, y0, y1: top, part: 'outer' } : { ...r, z0: u0, z1: u1, y0, y1: top, part: 'outer' });
    };
    let u = alongX ? r.x0 : r.z0;
    for (const e of (b.courtyard!.doors ?? []).filter(d => d.side === side).sort((p, q) => p.at - q.at)) {
      const e0 = mid + e.at - e.width / 2, e1 = mid + e.at + e.width / 2;
      piece(u, e0, 0); piece(e0, e1, e.height); u = e1;
    }
    piece(u, alongX ? r.x1 : r.z1, 0);
  }
  // 教室隔墙 (world/rooms.ts): per storey, door and 高窗 holes cut
  for (const st of floorStack(b)) for (const w of storeyPartitions(b, st.level)) for (const q of partitionBoxes(w)) out.push({ ...q, part: 'part' });
  // 教室陈设 (world/classroom.ts): desk pairs with their chairs, 讲台, 讲桌; drawn by their own per-storey mesh
  for (const st of floorStack(b)) for (const q of storeyFurniture(b, st.level).solid) out.push({ ...q, part: 'furn' });
  const plans = stairPlans(b);
  // floor slabs of the upper storeys + the roof slab, open over the 天井; a stairwell is cut out of every storey it
  // serves above its foot
  // 地下室 (levels < 0): the lowest storey's floor is a slab too (no ground plane under it, CollisionWorld.holes), and
  // the ground floor's slab tops out at BASEMENT.floor like the ground-floor floor of a building without one
  const ring = floorPlan(b), stack = floorStack(b), low = stack[0];
  for (const st of stack) if (st.level > 1 || st.y > low.y || st.y < 0) {
    let parts = ring;
    for (const p of plans) if (st.level > p.def.from && st.level <= p.def.to) parts = parts.flatMap(r => rectMinus(r, p.rect));
    const top = st.y + (st.level === 1 ? BASEMENT.floor : 0);
    for (const r of parts) out.push({ ...r, y0: st.y - STAIR.slab, y1: top, part: 'slab' });
  }
  // the basement's outer walls, from its floor slab up to the ground (no openings, nothing drawn outside)
  if (low.y < 0) for (const r of rectMinus({ x0: -hw, x1: hw, z0: -hd, z1: hd }, { x0: -hw + T, x1: hw - T, z0: -hd + T, z1: hd - T })) out.push({ ...r, y0: low.y - STAIR.slab, y1: 0, part: 'outer' });
  // the roof slab, cut where a stair runs on up to the roof (上屋面)
  let roofParts = ring;
  for (const p of plans) if (p.def.roof) roofParts = roofParts.flatMap(r => rectMinus(r, p.rect));
  for (const r of roofParts) out.push({ ...r, y0: H - STAIR.slab, y1: H, part: 'slab' });
  for (const p of plans) {
    const levels = p.storeys;
    const y0 = levels[0].y, y1 = stairTop(p);
    for (const side of p.walls) out.push(...enclosure(p, side, y0, y1, side === p.doorSide ? levels.map(l => l.y) : []));
    // 出屋面: above the roof the sides on the outer wall are bulkhead walls too
    if (p.def.roof) for (const side of (['+x', '-x', '+z', '-z'] as Side[]).filter(q => !p.walls.includes(q))) out.push(...enclosure(p, side, H, y1, []));
    // a capped tower's lid, the 出屋面 bulkhead's
    if (p.def.cap !== undefined || p.def.roof) out.push({ ...p.rect, y0: y1 - STAIR.slab, y1, part: 'slab' });
    for (const st of levels) {
      if (st.landing) out.push({ ...st.landing, part: 'landing' });
      if (st.mid) out.push({ ...st.mid, part: 'landing' });
      for (const f of [st.flight1, st.flight2]) if (f) for (const t of flightBoxes(p, f)) out.push({ ...t, part: 'tread' });
    }
    // 梯井: solid for the walker (never drawn; the handrail panels show it), the guard at the top landing
    out.push({ ...p.gap, y0: p.gapY[0], y1: p.gapY[1], part: 'well' });
    out.push({ ...p.topRail, part: 'rail' });
  }
  return out;
}

/**
 * World (x, z) waypoints from outside the first entrance, along the main corridor to a classroom's corridor door and
 * 2 m into the room (tests / e2e drive the walker along it). `room` defaults to the first classroom with a door.
 */
export function classroomRoute(b: BuildingDef, level = 1, room?: string): [number, number][] {
  const rooms = storeyRooms(b, level);
  const r = rooms.find(q => (room ? q.id === room : q.kind === 'classroom' && (q.doors ?? []).length > 0));
  if (!r || !r.doors?.length) throw new Error(`${b.id} ${level}F: no classroom ${room ?? ''} with a door`);
  const ent = b.entrances![0], d = r.doors[0];
  const hall = rooms.filter(q => q.kind === 'corridor').reduce((a, q) => (q.w * q.d > a.w * a.d ? q : a));
  const n = sideNormal(ent.side), t = n[0] === 0 ? [1, 0] : [0, 1];
  const face = (off: number): [number, number] => [b.x + n[0] * (b.w / 2 + off) + t[0] * ent.at, b.z + n[1] * (b.d / 2 + off) + t[1] * ent.at];
  // the door in world space, and which way is "into the room" (−normal of the door's side)
  const dn = sideNormal(d.side);
  const along = d.side[1] === 'z' ? [r.x + d.at, r.z + dn[1] * r.d / 2] : [r.x + dn[0] * r.w / 2, r.z + d.at];
  const door = (off: number): [number, number] => [b.x + along[0] + dn[0] * off, b.z + along[1] + dn[1] * off];
  const inCorr: [number, number] = hall.w >= hall.d ? [door(1)[0], b.z + hall.z] : [b.x + hall.x, door(1)[1]];
  const enter: [number, number] = hall.w >= hall.d ? [face(-3)[0], b.z + hall.z] : [b.x + hall.x, face(-3)[1]];
  return [face(1), face(-3), enter, inCorr, door(0), door(-2)];
}

/**
 * World (x, z) waypoints from outside the first entrance, in through the first stairwell's door and up its flights to
 * the 楼层平台 of level `to` (down to it for a basement; for e2e / tests that drive the walker; a straight line between waypoints is walkable).
 */
export function stairRoute(b: BuildingDef, to: number): [number, number][] {
  const p = stairPlans(b)[0], ent = b.entrances![0];
  const w = (a: number, v: number): [number, number] => { const q = p.at(a, v); return [b.x + q.x, b.z + q.z]; };
  const f1 = p.storeys.find(st => st.flight1)!.flight1!, f2 = p.storeys.find(st => st.flight2)!.flight2!;
  const v1 = (f1.v0 + f1.v1) / 2, v2 = (f2.v0 + f2.v1) / 2, dc = (p.door[0] + p.door[1]) / 2;
  const far = (p.def.dir[1] === 'x' ? p.clear.x1 - p.clear.x0 : p.clear.z1 - p.clear.z0) - 0.7; // on the 休息平台
  const n = sideNormal(ent.side), t = n[0] === 0 ? [1, 0] : [0, 1];
  const face = (off: number): [number, number] => [b.x + n[0] * (b.w / 2 + off) + t[0] * ent.at, b.z + n[1] * (b.d / 2 + off) + t[1] * ent.at];
  // 进门 → 门厅 → 主走廊 → 楼梯间门前: the classroom band now sits between the entrance and the stairwell
  // (no corridor on the ground floor, e.g. 食堂: its largest open hall, the 就餐区)
  const r1 = storeyRooms(b, 1), halls = r1.filter(r => r.kind === 'corridor');
  const hall = (halls.length ? halls : r1.filter(r => r.kind === 'dining' || r.kind === 'court' || r.kind === 'auditorium'))
    .reduce((a, r) => (r.w * r.d > a.w * a.d ? r : a));
  const ap = w(-2, dc), cz = b.z + hall.z, cx = b.x + hall.x;
  const via: [number, number][] = hall.w >= hall.d ? [[face(-3)[0], cz], [ap[0], cz]] : [[cx, face(-3)[1]], [cx, ap[1]]];
  // a 门厅 with furniture in the way (图书馆 借还台 / 长椅): round it along the floor instead of straight across
  const loc = (q: [number, number]): [number, number] => [q[0] - b.x, q[1] - b.z];
  const straight = [face(-3), ...via, ap].every((q, i, a) => i === 0 || clearLine(b, 1, loc(a[i - 1]), loc(q)));
  const route: [number, number][] = [face(1), ...(straight ? [face(-3), ...via, ap] : storeyPath(b, 1, loc(face(-1)), loc(ap))), w(1, dc), w(1, v1)];
  for (let l = 1; l < to; l++) route.push(w(far, v1), w(far, v2), w(0.8, v2), ...(l + 1 < to ? [w(0.8, v1)] : []));
  // down to a basement: the flight that arrives on this storey's 楼层平台 (the +across half), back on the other
  if (to < 1) {
    route.pop();
    for (let l = 1; l > to; l = l === 1 ? -1 : l - 1) route.push(w(0.8, v2), w(far, v2), w(far, v1), w(0.8, v1));
  }
  return route;
}
const sideNormal = (s: Side): [number, number] => (s[1] === 'x' ? [s[0] === '+' ? 1 : -1, 0] : [0, s[0] === '+' ? 1 : -1]);

/** roomRoute's grid: cell size and the walker's clearance from any wall (capsule radius 0.3 + slack), m. */
export const ROUTE = { res: 0.1, clear: 0.35 };

/**
 * World (x, z) waypoints into room `room` on `level` (its middle, or a 教室's middle aisle: classroom.ts roomSpot), along the corridors only (no cutting through other
 * rooms): on the ground floor from outside entrance `entrance`, above it from the end of stairRoute. A grid search over
 * the storey's corridor rooms + the target, kept ROUTE.clear off every interior piece standing at knee height, then
 * pulled tight (a straight line between waypoints is walkable). Any layout, so 回字形 rings too; throws if unreachable.
 */
export function roomRoute(b: BuildingDef, level: number, room: string, entrance = 0): [number, number][] {
  const rooms = storeyRooms(b, level), goal = rooms.find(r => r.id === room);
  if (!goal) throw new Error(`${b.id} ${level}F: no room ${room}`);
  let head: [number, number][];
  if (level === 1) {
    const ent = b.entrances![entrance], n = sideNormal(ent.side), t = n[0] === 0 ? [1, 0] : [0, 1];
    const face = (off: number): [number, number] => [b.x + n[0] * (b.w / 2 + off) + t[0] * ent.at, b.z + n[1] * (b.d / 2 + off) + t[1] * ent.at];
    head = [face(1), face(-1)];
  } else head = stairRoute(b, level);
  const last = head[head.length - 1];
  return [...head, ...storeyPath(b, level, [last[0] - b.x, last[1] - b.z], roomSpot(b, goal), room)];
}

/**
 * World (x, z) waypoints from room `from` through 连廊 `id` to room `to` on the same storey of the other building:
 * out of the room along the corridors to 1 m inside the 连廊门, straight across the deck, then on to `to`. `reverse`
 * starts in the bridge's far building (bridgeSpan.ends[1]) instead.
 */
export function bridgeRoute(c: Pick<CampusDef, 'buildings' | 'bridges'>, id: string, from: string, to: string, reverse = false): [number, number][] {
  const def = c.bridges?.find(q => q.id === id), span = def && bridgeSpan(c, def);
  if (!def || !span) throw new Error(`no bridge ${id}`);
  const [p, q] = reverse ? [span.ends[1], span.ends[0]] : span.ends;
  // building-local point `off` m out of the wall face on the bridge's centre line (negative = indoors)
  const face = ({ b, side }: { b: BuildingDef; side: Side }, off: number): [number, number] => {
    const n = sideNormal(side);
    return n[0] !== 0 ? [n[0] * (b.w / 2 + off), span.at - b.z] : [span.at - b.x, n[1] * (b.d / 2 + off)];
  };
  const spot = (b: BuildingDef, room: string) => {
    const r = storeyRooms(b, def.level).find(o => o.id === room);
    if (!r) throw new Error(`${b.id} ${def.level}F: no room ${room}`);
    return roomSpot(b, r);
  };
  const world = (b: BuildingDef, [x, z]: [number, number]): [number, number] => [b.x + x, b.z + z];
  return [
    ...storeyPath(p.b, def.level, spot(p.b, from), face(p, -1), from),
    world(p.b, face(p, 1)), world(q.b, face(q, 1)),
    ...storeyPath(q.b, def.level, face(q, -1), spot(q.b, to), to),
  ];
}

/**
 * World (x, z) waypoints on storey `level` from building-local point `from` to `to`, along the corridors only (plus
 * room `room`, when the path has to go in or out of it): roomRoute's grid search + string-pull, from any start.
 */
export function storeyPath(b: BuildingDef, level: number, from: [number, number], to: [number, number], room?: string): [number, number][] {
  const rooms = storeyRooms(b, level), st = floorStack(b).find(s => s.level === level)!;
  // building-local: where the walker may go, and what stands in its way between step height and the knee
  // (the stairwell too: an upper storey's route starts on its 楼层平台)
  const walk = [...rooms.filter(r => r.kind === 'corridor' || r.kind === 'court' || r.kind === 'dining' || r.kind === 'auditorium' || r.kind === 'stage' || r.id === room).map(rectOf),
    ...stairPlans(b).filter(p => level >= p.def.from && level <= p.def.to).map(p => p.rect)];
  // 舞台 deck: a walkable surface reached by its steps, not an obstacle (but its front lip stays shut, only the steps cross it)
  const stage = rooms.find(r => r.kind === 'stage'), onDeck = (p: { y0: number; y1: number }) => !!stage && p.y0 <= st.y + 0.01 && p.y1 > st.y + STAIR_STEP && p.y1 < st.y + 1.5;
  const block = interiorPieces(b).filter(p => !p.floor && p.y0 < st.y + 1 && p.y1 > st.y + STAIR_STEP && !onDeck(p));
  const c = ROUTE.clear, e = 0.05;
  const free = (x: number, z: number) =>
    walk.some(r => x >= r.x0 - e && x <= r.x1 + e && z >= r.z0 - e && z <= r.z1 + e) &&
    !block.some(p => x > p.x0 - c && x < p.x1 + c && z > p.z0 - c && z < p.z1 + c);
  const R = ROUTE.res, nx = Math.ceil(b.w / R), nz = Math.ceil(b.d / R);
  const cell = (x: number, z: number) => [Math.floor((x + b.w / 2) / R), Math.floor((z + b.d / 2) / R)];
  const at = (i: number, k: number): [number, number] => [-b.w / 2 + (i + 0.5) * R, -b.d / 2 + (k + 0.5) * R];
  const ok = new Uint8Array(nx * nz);
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) ok[k * nx + i] = free(...at(i, k)) ? 1 : 0;
  // nearest free cell to a building-local point
  const snap = (x: number, z: number) => {
    const [ci, ck] = cell(x, z);
    for (let rr = 0; rr < 20; rr++) for (let k = ck - rr; k <= ck + rr; k++) for (let i = ci - rr; i <= ci + rr; i++)
      if (i >= 0 && k >= 0 && i < nx && k < nz && ok[k * nx + i]) return k * nx + i;
    throw new Error(`${b.id} ${level}F: no free floor near ${x.toFixed(1)}, ${z.toFixed(1)}`);
  };
  const s0 = snap(...from), s1 = snap(...to);
  const prev = new Int32Array(nx * nz).fill(-1);
  prev[s0] = s0;
  for (let q = [s0], h = 0; h < q.length && prev[s1] < 0; h++) {
    const v = q[h], i = v % nx;
    for (const w of [i > 0 ? v - 1 : -1, i < nx - 1 ? v + 1 : -1, v - nx, v + nx])
      if (w >= 0 && w < nx * nz && ok[w] && prev[w] < 0) { prev[w] = v; q.push(w); }
  }
  if (prev[s1] < 0) throw new Error(`${b.id} ${level}F: ${room ?? to.map(v => v.toFixed(1)).join(', ')} not reachable along the corridors`);
  const path: [number, number][] = [];
  for (let v = s1; ; v = prev[v]) { path.push(at(v % nx, Math.floor(v / nx))); if (v === s0) break; }
  path.reverse();
  // string-pull: from each waypoint jump to the furthest path point in clear line of sight
  const sight = (p: [number, number], q: [number, number]) => {
    const n = Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / 0.05);
    for (let j = 1; j < n; j++) if (!free(p[0] + ((q[0] - p[0]) * j) / n, p[1] + ((q[1] - p[1]) * j) / n)) return false;
    return true;
  };
  const out: [number, number][] = [path[0]];
  for (let i = 0; i < path.length - 1;) {
    let j = path.length - 1;
    while (j > i + 1 && !sight(path[i], path[j])) j--;
    out.push(path[j]); i = j;
  }
  return out.map(([x, z]): [number, number] => [b.x + x, b.z + z]);
}
/** Whether nothing knee-high stands within ROUTE.clear of the straight line from `p` to `q` on storey `level` (building-local). */
function clearLine(b: BuildingDef, level: number, p: [number, number], q: [number, number]): boolean {
  const st = floorStack(b).find(s => s.level === level)!, c = ROUTE.clear;
  const block = interiorPieces(b).filter(o => o.part === 'furn' && o.y0 < st.y + 1 && o.y1 > st.y + STAIR_STEP);
  const n = Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / 0.05);
  for (let j = 0; j <= n; j++) {
    const x = p[0] + ((q[0] - p[0]) * j) / n, z = p[1] + ((q[1] - p[1]) * j) / n;
    if (block.some(o => x > o.x0 - c && x < o.x1 + c && z > o.z0 - c && z < o.z1 + c)) return false;
  }
  return true;
}
/** Pieces lower than this over the floor are stepped onto, not walked round (player step height). */
const STAIR_STEP = 0.35;

/** Interior colliders in world space. */
export function interiorColliders(b: BuildingDef): AABB[] {
  return interiorPieces(b).map(p => ({ minX: b.x + p.x0, maxX: b.x + p.x1, minY: p.y0, maxY: p.y1, minZ: b.z + p.z0, maxZ: b.z + p.z1 }));
}

/** Growing flat-shaded, vertex-coloured triangle soup with the `surf` attribute the building material expects. */
class Soup {
  pos: number[] = []; nor: number[] = []; col: number[] = []; surf: number[] = [];
  /** surf.y of the quads drawn now: 1 = a wall face that takes the 墙裙, 3 = 水磨石 (TERRAZZO), 4 = 声控灯罩 (LAMP) */
  dado = 0;
  private e1 = new THREE.Vector3(); private e2 = new THREE.Vector3(); private c = new THREE.Vector3();
  quad(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3, n: THREE.Vector3, col: THREE.Color): void {
    this.c.crossVectors(this.e1.subVectors(p1, p0), this.e2.subVectors(p2, p0));
    const vs = this.c.dot(n) >= 0 ? [p0, p1, p2, p0, p2, p3] : [p0, p2, p1, p0, p3, p2];
    for (const v of vs) { this.pos.push(v.x, v.y, v.z); this.nor.push(n.x, n.y, n.z); this.col.push(col.r, col.g, col.b); this.surf.push(SURF.plain, this.dado); }
  }
  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('surf', new THREE.Float32BufferAttribute(this.surf, 2));
    return g;
  }
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const NX = V(1, 0, 0), NXN = V(-1, 0, 0), NZ = V(0, 0, 1), NZN = V(0, 0, -1), UP = V(0, 1, 0), DOWN = V(0, -1, 0);

/**
 * Six faces of a world-space box; `top`/`bottom` colours for the horizontal faces (null = face hidden, not drawn);
 * `hide` = vertical faces (+x, −x, +z, −z) flush against a wall, never seen.
 */
function boxAll(s: Soup, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, side: THREE.Color, top: THREE.Color | null, bottom: THREE.Color | null, hide: Side[] = []): void {
  if (!hide.includes('+x')) s.quad(V(x1, y0, z0), V(x1, y0, z1), V(x1, y1, z1), V(x1, y1, z0), NX, side);
  if (!hide.includes('-x')) s.quad(V(x0, y0, z0), V(x0, y0, z1), V(x0, y1, z1), V(x0, y1, z0), NXN, side);
  if (!hide.includes('+z')) s.quad(V(x0, y0, z1), V(x1, y0, z1), V(x1, y1, z1), V(x0, y1, z1), NZ, side);
  if (!hide.includes('-z')) s.quad(V(x0, y0, z0), V(x1, y0, z0), V(x1, y1, z0), V(x0, y1, z0), NZN, side);
  if (top) s.quad(V(x0, y1, z0), V(x1, y1, z0), V(x1, y1, z1), V(x0, y1, z1), UP, top);
  if (bottom) s.quad(V(x0, y0, z0), V(x1, y0, z0), V(x1, y0, z1), V(x0, y0, z1), DOWN, bottom);
}

/**
 * Render geometry of the interior (world space, one mesh per building): slabs (水磨石 top, 白灰 underside), landings
 * and treads, enclosure walls with a 墙裙, a ground-floor floor, handrails along the 梯井 and the top guard rail.
 */
export function interiorGeometry(b: BuildingDef): THREE.BufferGeometry {
  const s = new Soup();
  const c = (hex: string, k = 1) => new THREE.Color(hex).multiplyScalar(k);
  const ceil = c(CEIL);
  const ys = floorStack(b).map(st => st.y), H = buildingHeight(b);
  const ceilings = [...ys.slice(1).map(y => y - STAIR.slab), roofTop(b), ...stairPlans(b).filter(p => p.def.roof).map(stairTop)];
  // a slab edge shows only where a stairwell is cut out of it: every other edge is buried in the outer / 天井 wall or
  // butts into the next piece of the same slab
  const cuts = stairPlans(b).map(p => p.rect);
  const walled = (q: LRect) => (['+x', '-x', '+z', '-z'] as Side[]).filter(side => !cuts.some(r => side[1] === 'x'
    ? Math.abs((side[0] === '+' ? r.x0 : r.x1) - (side[0] === '+' ? q.x1 : q.x0)) < 1e-6 && r.z0 < q.z1 - 1e-6 && q.z0 < r.z1 - 1e-6
    : Math.abs((side[0] === '+' ? r.z0 : r.z1) - (side[0] === '+' ? q.z1 : q.z0)) < 1e-6 && r.x0 < q.x1 - 1e-6 && q.x0 < r.x1 - 1e-6));
  // ground-floor floor, a hair above the campus ground and the puddle layer (1.5 cm), so no puddles indoors
  const fy = BASEMENT.floor;
  if (floorStack(b)[0].y >= 0) for (const r of floorPlan(b)) {
    const x0 = b.x + r.x0, x1 = b.x + r.x1, z0 = b.z + r.z0, z1 = b.z + r.z1;
    s.quad(V(x0, fy, z0), V(x1, fy, z0), V(x1, fy, z1), V(x0, fy, z1), UP, c(COLOR.slab, FLOOR_K));
  }
  for (const p of interiorPieces(b)) {
    // (the top guard 'rail' is drawn as a railing by handrails: as a box it was a blank dark slab over the landing)
    if (p.part === 'outer' || p.part === 'well' || p.part === 'part' || p.part === 'tread' || p.part === 'furn' || p.part === 'rail') continue;
    const x0 = b.x + p.x0, x1 = b.x + p.x1, z0 = b.z + p.z0, z1 = b.z + p.z1;
    const base = c(COLOR[p.part]);
    if (p.part === 'encl') {
      // stairwell walls: the sides take the 墙裙; a top/bottom shows only on a door's lintel or under the roof
      const underSlab = ceilings.some(v => Math.abs(p.y1 - v) < 1e-3);
      s.dado = 1;
      boxAll(s, x0, x1, p.y0, p.y1, z0, z1, base, null, null);
      s.dado = 0;
      boxAll(s, x0, x1, p.y0, p.y1, z0, z1, base, underSlab ? null : base, ys.some(v => Math.abs(p.y0 - v) < 1e-3) ? null : base.clone().multiplyScalar(0.85), ['+x', '-x', '+z', '-z']);
      continue;
    }
    const bottom = p.part === 'slab' || p.part === 'landing' ? ceil : base.clone().multiplyScalar(0.85);
    // the roof slab's top is the building mesh's roof (world/building.ts: 分格缝, lying snow): drawing it here too
    // z-fought with it, and from the roof the indoor-lit, snowless copy won
    const roofTop = p.part === 'slab' && Math.abs(p.y1 - H) < 1e-3;
    s.dado = p.part === 'landing' ? 3 : 0;
    boxAll(s, x0, x1, p.y0, p.y1, z0, z1, base.clone().multiplyScalar(p.part === 'slab' ? EDGE_K : 0.9), roofTop ? null : p.part === 'slab' ? base.clone().multiplyScalar(FLOOR_K) : base, bottom, p.part === 'slab' ? walled(p) : []);
  }
  s.dado = 1;
  innerWalls(s, b, c(COLOR.encl));
  partitionFaces(s, b, c(COLOR.part));
  s.dado = 0;
  for (const p of stairPlans(b)) for (const st of p.storeys) for (const f of [st.flight1, st.flight2]) if (f) {
    treads(s, b, p, f, c(COLOR.tread));
    soffit(s, b, p, f, ceil, c(COLOR.tread, 0.9));
  }
  for (const p of stairPlans(b)) handrails(s, b, p, c(COLOR.rail));
  for (const l of stairLamps(b)) stairLamp(s, l);
  return s.geometry();
}

/**
 * 声控灯 (stairwell `lamp: 'sound'`): a 灯座 + 乳白半球灯罩 on the ceiling over each 楼层平台, midway between the door and
 * the foot of flight 1. The 灯罩 faces carry surf.y = 4: the interior material lights them with intStairLamp
 * (render/interior_light.ts), on or off as a whole, apart from the 日光灯.
 */
export const LAMP = { base: 0.09, baseH: 0.025, r: 0.12, h: 0.09, sides: 8, base_c: '#d9d4c4', shade: '#e8e6dc' };
export interface StairLamp { stair: string; level: number; x: number; z: number; /** ceiling height it hangs from */ y: number }
export function stairLamps(b: BuildingDef): StairLamp[] {
  const out: StairLamp[] = [];
  for (const p of stairPlans(b)) {
    if (p.def.lamp !== 'sound') continue;
    const [v0, v1] = p.def.dir[1] === 'x' ? [p.clear.z0, p.clear.z1] : [p.clear.x0, p.clear.x1];
    const q = p.at(STAIR.landing / 2, (v0 + v1) / 2);
    for (const st of p.storeys) out.push({ stair: p.def.id, level: st.level, x: b.x + q.x, z: b.z + q.z, y: st.y + st.h - STAIR.slab });
  }
  return out;
}

function stairLamp(s: Soup, l: StairLamp): void {
  const B = LAMP.base, y0 = l.y - LAMP.baseH;
  s.dado = 0;
  boxAll(s, l.x - B, l.x + B, y0, l.y, l.z - B, l.z + B, new THREE.Color(LAMP.base_c).multiplyScalar(0.9), null, new THREE.Color(LAMP.base_c));
  // 半球: two rings of quads down to a flat octagon at the bottom
  s.dado = 4;
  const shade = new THREE.Color(LAMP.shade), n = LAMP.sides;
  const ring = (k: number) => { const a = Math.PI / 2 * k; return { r: LAMP.r * Math.cos(a * 0.85), y: y0 - LAMP.h * Math.sin(a) }; };
  const rings = [ring(0), ring(0.5), ring(1)];
  const at = (i: number, q: { r: number; y: number }) => { const a = (i / n) * Math.PI * 2; return V(l.x + q.r * Math.cos(a), q.y, l.z + q.r * Math.sin(a)); };
  for (let k = 0; k + 1 < rings.length; k++) for (let i = 0; i < n; i++) {
    const p0 = at(i, rings[k]), p1 = at(i + 1, rings[k]), p2 = at(i + 1, rings[k + 1]), p3 = at(i, rings[k + 1]);
    const m = (i + 0.5) / n * Math.PI * 2, tilt = (k + 0.5) / (rings.length - 1);
    s.quad(p0, p1, p2, p3, V(Math.cos(m) * Math.cos(tilt), -Math.sin(tilt), Math.sin(m) * Math.cos(tilt)).normalize(), shade);
  }
  const bot = rings[rings.length - 1], c = V(l.x, bot.y, l.z);
  for (let i = 0; i < n; i += 2) s.quad(c, at(i, bot), at(i + 1, bot), at(i + 2, bot), DOWN, shade);
  s.dado = 0;
}

/**
 * A sloped 扶手 on both edges of the 梯井 above each flight, with under it either a 栏板 panel (`rail: 'panel'`) or,
 * in an old stair (`'bars'`), 铁栏杆: a 扁钢 bar along the nosing line, two balusters per tread and newel posts with
 * a level rail across the well where the flights turn; the 扶手 is then wood. The well itself stays open.
 */
function handrails(s: Soup, b: BuildingDef, p: StairPlan, col: THREE.Color): void {
  const bars = p.def.rail === 'bars', panel = c2(col), wood = new THREE.Color(RAIL.wood), iron = new THREE.Color(RAIL.iron);
  const R = 0.05, top = bars ? wood : col;
  for (const st of p.storeys) for (const f of [st.flight1, st.flight2]) {
    if (!f) continue;
    const up = f.dir === p.def.dir ? 1 : -1;
    const aFoot = f.a, aTop = f.a + up * f.steps * f.run;
    const yFoot = f.y + f.rise, yTop = f.y + f.steps * f.rise;
    // the well-side edge of this flight
    const v = f.v0 < wellV(p) ? f.v1 : f.v0;
    const inWard = v === f.v1 ? 1 : -1; // from the flight toward the well
    const w = (a: number, y: number, dv: number) => { const q = p.at(a, v + inWard * dv); return V(b.x + q.x, y, b.z + q.z); };
    const n = alongNormal(p, inWard);
    if (bars) {
      // 扁钢 along the nosing line, the balusters standing on it up to the rail
      const B = RAIL.bar, k = (yTop - yFoot) / (aTop - aFoot);
      const yAt = (a: number) => yFoot + (a - aFoot) * k;
      ribbon(s, w, aFoot, aTop, yFoot - 0.04, yTop - 0.04, 0.05, B, n, iron);
      for (let i = 0; i < f.steps * 2; i++) {
        const a = aFoot + up * (i + 0.5) * f.run / 2;
        post(s, w, a, B, yAt(a) + 0.01, yAt(a) + STAIR.rail - R, n, p, iron);
      }
    } else {
      // 栏板: a thin panel from the nosing line to rail height, on the well face of the flight
      s.quad(w(aFoot, yFoot - 0.15, 0.02), w(aTop, yTop - 0.15, 0.02), w(aTop, yTop + STAIR.rail - R, 0.02), w(aFoot, yFoot + STAIR.rail - R, 0.02), n, panel);
      s.quad(w(aFoot, yFoot - 0.15, 0.02), w(aTop, yTop - 0.15, 0.02), w(aTop, yTop + STAIR.rail - R, 0.02), w(aFoot, yFoot + STAIR.rail - R, 0.02), n.clone().negate(), panel);
    }
    // the rail on top: a sloped bar R × R
    const y0 = STAIR.rail - R, y1 = STAIR.rail + R;
    s.quad(w(aFoot, yFoot + y1, -R), w(aTop, yTop + y1, -R), w(aTop, yTop + y1, R), w(aFoot, yFoot + y1, R), UP, top);
    s.quad(w(aFoot, yFoot + y0, -R), w(aTop, yTop + y0, -R), w(aTop, yTop + y1, -R), w(aFoot, yFoot + y1, -R), n.clone().negate(), top);
    s.quad(w(aFoot, yFoot + y0, R), w(aTop, yTop + y0, R), w(aTop, yTop + y1, R), w(aFoot, yFoot + y1, R), n, top);
    if (bars) s.quad(w(aFoot, yFoot + y0, -R), w(aTop, yTop + y0, -R), w(aTop, yTop + y0, R), w(aFoot, yFoot + y0, R), DOWN, wood.clone().multiplyScalar(0.7));
  }
  if (bars) turns(s, b, p, wood, iron);
  topGuard(s, b, p, bars ? wood : col, panel, iron);
}

/**
 * 顶层水平护栏 (the stairs.ts topRail collider, drawn): along the top 楼层平台's edge, from the wall across the void
 * over the flight below and across the 梯井 to the arriving flight's handrail, its rail STAIR.guard high, a post
 * where the two rails meet; a 栏板 under the rail (`rail: 'panel'`) or 铁栏杆 on a 扁钢 (`'bars'`).
 */
function topGuard(s: Soup, b: BuildingDef, p: StairPlan, rail: THREE.Color, panel: THREE.Color, iron: THREE.Color): void {
  const f = p.storeys[p.storeys.length - 2]?.flight2;
  if (!f) return;
  const R = 0.05, B = RAIL.bar, bars = p.def.rail === 'bars', ax = p.def.dir[1] === 'x';
  // the wall-side edge of the void (v0), the arriving flight's well edge (g1), the slab edge line (a), heights
  const v0 = ax ? p.topRail.z0 : p.topRail.x0, g1 = f.v0, a = STAIR.landing + (bars ? 0 : 0.02);
  const y = p.topRail.y0, yr = y + STAIR.guard, wall: Side[] = [ax ? '-z' : '-x'];
  const w = (aa: number, yy: number, v: number) => { const q = p.at(aa, v); return V(b.x + q.x, yy, b.z + q.z); };
  const box = (a0: number, a1: number, va: number, vb: number, y0: number, y1: number, col: THREE.Color) => {
    const r = p.span(a0, a1, va, vb);
    boxAll(s, b.x + r.x0, b.x + r.x1, y0, y1, b.z + r.z0, b.z + r.z1, col, col, col.clone().multiplyScalar(0.7), wall);
  };
  const across = alongNormal(p, 1), o = p.at(0, 0), q = p.at(1, 0), along = V(q.x - o.x, 0, q.z - o.z);
  box(a - R, a + R, v0, g1 + R, yr - 2 * R, yr, rail);
  if (bars) {
    box(a - B, a + B, v0, g1, y - 0.09, y - 0.04, iron);
    const n = Math.max(2, Math.round((g1 - v0) / 0.12));
    for (let i = 0; i < n; i++) {
      const v = v0 + (i + 0.5) * (g1 - v0) / n;
      post(s, (aa, yy, dv) => w(aa, yy, v + dv), a, B, y + 0.01, yr - 2 * R, across, p, iron);
    }
    post(s, (aa, yy, dv) => w(aa, yy, g1 + dv), a, RAIL.newel, y - f.rise - 0.1, yr, across, p, iron);
  } else {
    const c = [w(a, y - 0.15, v0), w(a, y - 0.15, g1 - 0.02), w(a, yr - 2 * R, g1 - 0.02), w(a, yr - 2 * R, v0)] as const;
    s.quad(...c, along, panel);
    s.quad(...c, along.clone().negate(), panel);
    // the arriving flight's sloped rail ends lower: a post up from its end to the level rail
    post(s, (aa, yy, dv) => w(aa, yy, g1 + dv), a, R, y - f.rise + STAIR.rail - R, yr - 2 * R, across, p, rail);
  }
}

/** 铁栏杆 + 木扶手 (stairwell `rail: 'bars'`): 扁钢 / baluster size and the colours (painted iron, varnished wood). */
export const RAIL = { bar: 0.014, newel: 0.03, wood: '#6e4f37', iron: '#3c4440' };

/**
 * Where the flights turn round the 梯井 (at the 休息平台 and at every 楼层平台 a flight leaves upward): a newel post on
 * each flight's well corner and a level rail across the well between them, at the higher of the two rail ends.
 */
function turns(s: Soup, b: BuildingDef, p: StairPlan, wood: THREE.Color, iron: THREE.Color): void {
  const R = 0.05, g = p.gap, ax = p.def.dir[1] === 'x';
  const [g0, g1] = ax ? [g.z0, g.z1] : [g.x0, g.x1];
  for (let i = 0; i < p.storeys.length; i++) {
    const st = p.storeys[i], f1 = st.flight1, f2 = st.flight2;
    if (!f1 || !f2) continue;
    // the 休息平台 end (a = foot of flight 2) and, under the next storey's flight 1, the 楼层平台 end (a = flight 1's foot)
    // (rail heights of the flight on the g0 side, flight 1, and on the g1 side, flight 2)
    const ends: [number, number, number][] = [[f2.a, f1.y + f1.steps * f1.rise, f2.y + f2.rise]];
    const nx = p.storeys[i + 1]?.flight1;
    if (nx) ends.push([nx.a, nx.y + nx.rise, f2.y + f2.steps * f2.rise]);
    for (const [a, ya, yb] of ends) {
      const y = Math.max(ya, yb) + STAIR.rail;
      const w = (aa: number, yy: number, v: number) => { const q = p.at(aa, v); return V(b.x + q.x, yy, b.z + q.z); };
      for (const [v, yl] of [[g0, ya], [g1, yb]] as const) {
        const ww = (aa: number, yy: number, dv: number) => w(aa, yy, v + dv);
        post(s, ww, a, RAIL.newel, yl - 0.1, y + R, alongNormal(p, 1), p, iron);
      }
      // level rail across the well, R × R, from one flight's rail line to the other's
      const n = p.at(1, 0), o = p.at(0, 0), along = V(n.x - o.x, 0, n.z - o.z);
      const lo = (yy: number, da: number) => [w(a + da, yy, g0 - R), w(a + da, yy, g1 + R)] as const;
      const [p0, p1] = lo(y + R, -R), [q0, q1] = lo(y + R, R), [r0, r1] = lo(y - R, -R), [t0, t1] = lo(y - R, R);
      s.quad(p0, p1, q1, q0, UP, wood);
      s.quad(r0, r1, p1, p0, along.clone().negate(), wood);
      s.quad(t0, t1, q1, q0, along, wood);
      s.quad(r0, r1, t1, t0, DOWN, wood.clone().multiplyScalar(0.7));
    }
  }
}

/** A vertical bar of half-width `h` at along-distance `a` on the frame `w` (dv = across offset from its line), y0..y1. */
function post(s: Soup, w: (a: number, y: number, dv: number) => THREE.Vector3, a: number, h: number, y0: number, y1: number, n: THREE.Vector3, p: StairPlan, col: THREE.Color): void {
  const o = p.at(0, 0), q = p.at(1, 0), along = V(q.x - o.x, 0, q.z - o.z);
  s.quad(w(a - h, y0, -h), w(a + h, y0, -h), w(a + h, y1, -h), w(a - h, y1, -h), n.clone().negate(), col);
  s.quad(w(a - h, y0, h), w(a + h, y0, h), w(a + h, y1, h), w(a - h, y1, h), n, col);
  s.quad(w(a - h, y0, -h), w(a - h, y0, h), w(a - h, y1, h), w(a - h, y1, -h), along.clone().negate(), col);
  s.quad(w(a + h, y0, -h), w(a + h, y0, h), w(a + h, y1, h), w(a + h, y1, -h), along, col);
}

/** A sloped flat bar from (a0, y0) to (a1, y1), `ht` tall, `h` half-thick across: both faces + the underside. */
function ribbon(s: Soup, w: (a: number, y: number, dv: number) => THREE.Vector3, a0: number, a1: number, y0: number, y1: number, ht: number, h: number, n: THREE.Vector3, col: THREE.Color): void {
  for (const dv of [-h, h]) s.quad(w(a0, y0 - ht, dv), w(a1, y1 - ht, dv), w(a1, y1, dv), w(a0, y0, dv), dv > 0 ? n : n.clone().negate(), col);
  s.quad(w(a0, y0 - ht, -h), w(a1, y1 - ht, -h), w(a1, y1 - ht, h), w(a0, y0 - ht, h), DOWN, col.clone().multiplyScalar(0.8));
}

const c2 = (col: THREE.Color) => new THREE.Color(0xd8d3c4).lerp(col, 0.15);
/** across coordinate of the well centre */
function wellV(p: StairPlan): number {
  return p.def.dir[1] === 'x' ? (p.gap.z0 + p.gap.z1) / 2 : (p.gap.x0 + p.gap.x1) / 2;
}
/** world normal pointing across the stair, toward +v (inWard = 1) or −v */
function alongNormal(p: StairPlan, inWard: number): THREE.Vector3 {
  return p.def.dir[1] === 'x' ? V(0, 0, inWard) : V(inWard, 0, 0);
}

/**
 * Inner face of the outer walls (and of the 天井 walls), WALL_T in from the facade, cut round every window and doorway
 * exactly like the facade (world/building.ts runs the reveals through to this plane); the 墙裙 comes from the material. Outer walls' inner faces meet in concave corners (WALL_T short at each end), a 天井's in convex ones.
 */
function innerWalls(s: Soup, b: BuildingDef, wall: THREE.Color): void {
  const H = buildingHeight(b), outer = facadeOpenings(b), court = courtOpenings(b), Y0 = Math.min(0, floorStack(b)[0].y);
  for (const fr of facadeFrames(b)) {
    const ax = frameAxes(fr), n = ax.n.clone().negate(), len = fr.len / 2 + (fr.court ? WALL_T : -WALL_T);
    const at = (u: number, y: number) => ax.at(u, y, -WALL_T);
    const mine = (fr.court ? court : outer).filter(o => o.side === fr.side);
    const ys = [...new Set([Y0, H, ...mine.flatMap(o => [o.y0, o.y1])])]
      .filter(y => y >= Y0 && y <= H).sort((p, q) => p - q);
    for (let i = 0; i + 1 < ys.length; i++) {
      const y0 = ys[i], y1 = ys[i + 1];
      const cut = mine.filter(o => o.y0 <= y0 + 1e-6 && o.y1 >= y1 - 1e-6).sort((p, q) => p.u0 - q.u0);
      let u = -len;
      const rect = (u0: number, u1: number) => { if (u1 > u0 + 1e-6) s.quad(at(u0, y0), at(u1, y0), at(u1, y1), at(u0, y1), n, wall); };
      for (const o of cut) { rect(u, Math.min(o.u0, len)); u = Math.max(u, o.u1); }
      rect(u, len);
    }
  }
}

/**
 * 隔墙 (world/rooms.ts storeyPartitions) as faces, not boxes: both faces of each wall cut round its holes in bands
 * between the hole edges (runs of the same span merged upward, like innerWalls), each hole's reveals (a shade darker,
 * one quad each), and the end caps that stand free (not in the outer / 天井 wall or against another partition). The colliders keep
 * partitionBoxes; drawn as boxes, every pier and lintel would bring its own hidden faces (docs/05 budget).
 */
function partitionFaces(s: Soup, b: BuildingDef, wall: THREE.Color): void {
  const t = PART.t / 2, E = 1e-6, plan = floorPlan(b), head = wall.clone().multiplyScalar(0.85);
  const inRect = (r: LRect, x: number, z: number) => x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1;
  for (const st of floorStack(b)) {
    const parts = storeyPartitions(b, st.level);
    const rects = parts.map(q => (q.axis === 'x' ? { x0: q.u0, x1: q.u1, z0: q.c - t, z1: q.c + t } : { x0: q.c - t, x1: q.c + t, z0: q.u0, z1: q.u1 }));
    const solid = (x: number, z: number) => !plan.some(r => inRect(r, x, z)) || rects.some(r => inRect(r, x, z));
    for (const p of parts) {
      const H = p.y1 - p.y0, X = p.axis === 'x';
      // building-local along-wall u, height above the storey floor y, across offset v → world
      const at = (u: number, y: number, v: number) => (X ? V(b.x + u, p.y0 + y, b.z + p.c + v) : V(b.x + p.c + v, p.y0 + y, b.z + u));
      const nU = X ? NX : NZ, nV = X ? NZ : NX;
      // a vertical strip across the wall at u (jamb, end cap), a shade darker than the faces
      const across = (u: number, y0: number, y1: number, n: THREE.Vector3, col = head) =>
        s.quad(at(u, y0, -t), at(u, y0, t), at(u, y1, t), at(u, y1, -t), n, col);
      const ys = [...new Set([0, H, ...p.holes.flatMap(h => [h.y0, Math.min(h.y1, H)])])].filter(y => y >= 0 && y <= H).sort((a, c) => a - c);
      const runs: { u0: number; u1: number; y0: number; y1: number }[] = [];
      for (let i = 0; i + 1 < ys.length; i++) {
        const y0 = ys[i], y1 = ys[i + 1];
        const cut = p.holes.filter(h => h.y0 <= y0 + E && h.y1 >= y1 - E).map(h => [h.u0, h.u1] as [number, number]);
        for (const [u0, u1] of minus(p.u0, p.u1, cut)) {
          const r = runs.find(q => Math.abs(q.y1 - y0) < E && Math.abs(q.u0 - u0) < E && Math.abs(q.u1 - u1) < E);
          if (r) r.y1 = y1; else runs.push({ u0, u1, y0, y1 });
        }
      }
      for (const r of runs) for (const v of [-t, t]) s.quad(at(r.u0, r.y0, v), at(r.u1, r.y0, v), at(r.u1, r.y1, v), at(r.u0, r.y1, v), v > 0 ? nV : nV.clone().negate(), wall);
      for (const h of p.holes) {
        const y1 = Math.min(h.y1, H);
        across(h.u0, h.y0, y1, nU); across(h.u1, h.y0, y1, nU.clone().negate());
        s.dado = 0;
        if (h.y0 > E) s.quad(at(h.u0, h.y0, -t), at(h.u1, h.y0, -t), at(h.u1, h.y0, t), at(h.u0, h.y0, t), UP, wall);
        if (y1 < H - E) s.quad(at(h.u0, y1, -t), at(h.u1, y1, -t), at(h.u1, y1, t), at(h.u0, y1, t), DOWN, head);
        s.dado = 1;
      }
      // end caps, unless buried: the point just past the end is in a wall
      for (const [u, k] of [[p.u0, -1], [p.u1, 1]] as const) {
        const q = u + k * 0.02;
        if (!(X ? solid(q, p.c) : solid(p.c, q))) across(u, 0, H, k > 0 ? nU : nU.clone().negate());
      }
    }
  }
}

/**
 * A flight's tread boxes (stairs.ts flightBoxes, the colliders) with only the faces that can show: the tread, the
 * riser and the 梯井 side. The bottoms sit on the landing or above the soffit, the wall side is flush with the
 * stairwell wall, and each back face is inside the next step (the last one's stays: it shows under the landing lip).
 */
function treads(s: Soup, b: BuildingDef, p: StairPlan, f: Flight, top: THREE.Color): void {
  const back = f.dir, v = p.def.dir[1] === 'x' ? 'z' : 'x', c = p.def.dir[1] === 'x' ? p.clear.z0 : p.clear.x0;
  const wall = `${Math.abs(f.v0 - c) < 1e-6 ? '-' : '+'}${v}` as Side;
  const side = top.clone().multiplyScalar(0.9), boxes = flightBoxes(p, f);
  const strip = top.clone().multiplyScalar(TERRAZZO.strip.k), S = TERRAZZO.strip, nose = opp(back);
  boxes.forEach((t, i) => {
    s.dado = 3;
    boxAll(s, b.x + t.x0, b.x + t.x1, t.y0, t.y1, b.z + t.z0, b.z + t.z1, side, top, null, i === boxes.length - 1 ? [wall] : [wall, back]);
    s.dado = 0;
    // 防滑条 (an old stair, `rail: 'bars'`; A / B keep under the 5k budget without): a darker strip across the tread
    // just behind its nosing, a hair above it
    if (p.def.rail !== 'bars') return;
    const r = { x0: b.x + t.x0, x1: b.x + t.x1, z0: b.z + t.z0, z1: b.z + t.z1 }, y = t.y1 + 0.003;
    const e = nose[1] === 'x' ? (nose[0] === '+' ? r.x1 : r.x0) : (nose[0] === '+' ? r.z1 : r.z0), k = nose[0] === '+' ? -1 : 1;
    const [a0, a1] = [e + k * S.at, e + k * (S.at + S.w)].sort((p, q) => p - q);
    const q = nose[1] === 'x' ? { ...r, x0: a0, x1: a1 } : { ...r, z0: a0, z1: a1 };
    s.quad(V(q.x0, y, q.z0), V(q.x1, y, q.z0), V(q.x1, y, q.z1), V(q.x0, y, q.z1), UP, strip);
  });
}

/**
 * 梯段板 underside: the tread boxes' bottoms step down with the treads (a stripe per step from below); a sloped plane
 * through their back-lower corners hides that, with a strip on each side closing it to the boxes. Starts where it
 * leaves the flight's foot level (the first treads' bottoms sit flat on it).
 */
function soffit(s: Soup, b: BuildingDef, p: StairPlan, f: Flight, under: THREE.Color, side: THREE.Color): void {
  const up = f.dir === p.def.dir ? 1 : -1, k = f.rise / f.run, E = 0.004;
  const aAt = (i: number) => f.a + up * (i + 1) * f.run; // back edge of tread i
  const yAt = (i: number) => f.y + (i + 1) * f.rise - STAIR.waist - E;
  const last = f.steps - 1;
  const i0 = Math.max(0, Math.ceil((STAIR.waist + E) / f.rise) - 1);
  if (i0 >= last) return;
  const a0 = aAt(i0) - up * (yAt(i0) - Math.max(f.y, yAt(i0))) / k, y0 = Math.max(f.y, yAt(i0));
  const a1 = aAt(last), y1 = yAt(last);
  const w = (a: number, v: number, y: number) => { const q = p.at(a, v); return V(b.x + q.x, y, b.z + q.z); };
  // normal: down and toward the foot of the flight
  const q0 = p.at(0, 0), q1 = p.at(up, 0), ax = V(q1.x - q0.x, 0, q1.z - q0.z);
  const n = V(0, -1, 0).addScaledVector(ax, k).normalize();
  s.quad(w(a0, f.v0, y0), w(a1, f.v0, y1), w(a1, f.v1, y1), w(a0, f.v1, y0), n, under);
  // side strips from the soffit up to the tread boxes' bottom corners (one rise tall), a hair proud of the boxes
  for (const [v, dv] of [[f.v0, -E], [f.v1, E]] as const) {
    const vv = v + dv, nv = alongNormal(p, dv > 0 ? 1 : -1);
    s.quad(w(a0, vv, y0), w(a1, vv, y1), w(a1, vv, y1 + f.rise + E), w(a0, vv, y0 + f.rise + E), nv, side);
  }
}
