import { buildingHeight, courtOuter, courtRect, floorStack, groundEntrances, isHollow, roofTop, WALL_T, type BuildingDef, type CanopyDims, type EntranceDef, type RoomDef, type Side } from '../../../../shared/campus/campus_schema.ts';
import { rectMinus, STAIR, type LRect } from '../../../../shared/campus/stairs.ts';
import { rectOf, storeyRooms } from './rooms.ts';
import { tankBox, tankDoorDepth, tankRoomRect, TANK } from './tankroom.ts';

/**
 * 室内判定 (docs/05_art_audio.md 天气细节): how sheltered a point is, from the map data. Two numbers, because they
 * drive different things: `cover` = something overhead (rain strokes thin out, no flakes), `enclosed` = walls round
 * the listener (the rain bed muffles). Inside a hollow building the storey's rooms decide: a walled room is shut,
 * open floor (corridor/hall) near a ground-floor entrance lets the outside in; under a 雨棚 or a 连廊 roof is 半室内,
 * covered but open on its free sides (a 雨棚: three, a 连廊: the two long ones). Solid buildings keep the footprint ramp (you can only be inside one by teleport).
 */

export interface Shelter {
  /** 0..1 roof overhead */ cover: number;
  /** 0..1 walls round (0 outdoors, 1 in a shut room) */ enclosed: number;
  /** building / storey / room the point is in (undefined outdoors or in a stairwell) */
  building?: string; level?: number; room?: RoomDef;
  /** under cover with a way out (雨棚, 门厅): unit plan direction toward the open air, how far off it is (m), and the
   * 雨棚 at that way out (the last roof overhead before the sky) */
  open?: [number, number]; edge?: number; roof?: Roof;
}

export const SHELTER = {
  /** solid-footprint ramp past the wall (m) */ ramp: 1.5,
  /** enclosure right in an open doorway, and how far inside (m) it takes to shut out the rest */ door: 0.5, doorRamp: 3,
  /** under a canopy: enclosure, and the soft rim along its open edges (m) */ under: 0.25, rim: 0.5,
  /** share of the rain strokes left under cover per unit of openness (rain seen past the edge) */ seen: 0.5,
};

/** 雨棚 over an entrance (CanopyDims): the usual one; an entrance's `canopy` overrides it (canopyOf). */
export const CANOPY: CanopyDims = { out: 1.4, side: 0.4, gap: 0.25, t: 0.16 };
/** The 雨棚 of an entrance: CANOPY, or its own sizes (the 礼堂's 门廊). */
export const canopyOf = (e: EntranceDef): CanopyDims => ({ ...CANOPY, ...e.canopy });

/**
 * A roof overhead with open sides (雨棚, 连廊 roof) in plan, world space: rect, top height `y`, slab thickness `t`, and
 * the edges that meet a wall (`closed`: no way out there, no drips); `sheltered` = under another roof (does not drip).
 */
export interface Roof { x0: number; x1: number; z0: number; z1: number; y: number; t: number; closed: Side[]; sheltered?: boolean }
/** A 雨棚: a Roof hanging off the wall on `side` of its building (that wall is its one closed edge). */
export interface CanopyRect extends Roof { side: Side; /** how far it sticks out of the wall */ out: number }
const opposite = (s: Side) => `${s[0] === '+' ? '-' : '+'}${s[1]}` as Side;
/** Every 雨棚 of a building (one per entrance), matching what `canopy` draws. */
export function canopyRects(b: BuildingDef): CanopyRect[] {
  return groundEntrances(b).map(e => {
    const C = canopyOf(e), s = e.side[0] === '+' ? 1 : -1, u0 = e.at - e.width / 2 - C.side, u1 = e.at + e.width / 2 + C.side;
    const y = e.height + C.gap + C.t, own = { y, t: C.t, side: e.side, out: C.out, closed: [opposite(e.side)] };
    if (e.side[1] === 'z') {
      const f = b.z + s * b.d / 2, g = f + s * C.out;
      return { x0: b.x + u0, x1: b.x + u1, z0: Math.min(f, g), z1: Math.max(f, g), ...own };
    }
    const f = b.x + s * b.w / 2, g = f + s * C.out;
    return { x0: Math.min(f, g), x1: Math.max(f, g), z0: b.z + u0, z1: b.z + u1, ...own };
  });
}

/** Kinds that are open floor: an entrance nearby opens them to the outside. Walled rooms are shut (their doors face a corridor). */
const OPEN: readonly RoomDef['kind'][] = ['corridor', 'hall', 'stairs', 'court', 'dining', 'auditorium', 'stage'];

/** Every 雨棚 on the campus (with world/bridges.ts bridgeRoofs: the roofs `shelterAt` treats as 半室内). */
export const campusRoofs = (buildings: BuildingDef[]): Roof[] => buildings.flatMap(canopyRects);

/** Plan rects (building-local) of the stairs that climb on up to the roof (上屋面): their bulkheads stand on it. */
const roofStairs = (b: BuildingDef): LRect[] => (b.stairwells ?? []).filter(s => s.roof).map(s => ({ x0: s.x - s.w / 2, x1: s.x + s.w / 2, z0: s.z - s.d / 2, z1: s.z + s.d / 2 }));

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * Storey whose floor the feet stand on (highest floor at or below y; below the lowest floor, the lowest: a 地下室 or
 * a 台仓 is a storey like any other, its doors all upstairs); undefined from the roof slab up (on the roof).
 */
function storeyAt(b: BuildingDef, y: number): number | undefined {
  if (y >= buildingHeight(b) - 0.05) return undefined;
  const stack = floorStack(b);
  let level = stack[0]?.level;
  for (const st of stack) if (st.y <= y + 0.05) level = st.level;
  return level;
}

/**
 * Nearest ground-floor doorway to the open air from (lx, lz) (building-local): an entrance (`i` = its index, the 雨棚
 * over it) or a door out into the 天井 (`i` = −1: no 雨棚, the sky is right outside); plan distance and outward normal.
 */
function nearestDoor(b: BuildingDef, lx: number, lz: number): { d: number; n: [number, number]; i: number } {
  let best = { d: Infinity, n: [0, -1] as [number, number], i: 0 };
  // u along the wall from its centre line, depth in from the face the door opens out of, along the inward normal
  const test = (side: Side, at: number, width: number, u: number, depth: number, i: number) => {
    const s = side[0] === '+' ? 1 : -1, du = Math.max(0, Math.abs(u - at) - width / 2), d = Math.hypot(du, Math.max(0, depth));
    if (d < best.d) best = { d, n: side[1] === 'z' ? [0, s] : [s, 0], i };
  };
  for (const [i, e] of groundEntrances(b).entries()) {
    const s = e.side[0] === '+' ? 1 : -1;
    if (e.side[1] === 'z') test(e.side, e.at, e.width, lx, b.d / 2 - s * lz, i); else test(e.side, e.at, e.width, lz, b.w / 2 - s * lx, i);
  }
  const c = courtRect(b);
  // a 天井 door's side is the way it faces (into the void): '+z' is in the void's south wall, opening north
  if (c) for (const e of b.courtyard!.doors ?? []) {
    const s = e.side[0] === '+' ? 1 : -1;
    if (e.side[1] === 'z') test(e.side, e.at, e.width, lx - (c.x0 + c.x1) / 2, s * ((s > 0 ? c.z0 : c.z1) - lz), -1);
    else test(e.side, e.at, e.width, lz - (c.z0 + c.z1) / 2, s * ((s > 0 ? c.x0 : c.x1) - lx), -1);
  }
  return best;
}

/** How far (m) (x, z) is under `r` from its nearest open edge (closed edges do not count), and that edge's normal. */
const SIDE_N: [Side, [number, number]][] = [['+x', [1, 0]], ['-x', [-1, 0]], ['+z', [0, 1]], ['-z', [0, -1]]];

function underRoof(r: Roof, x: number, z: number): { d: number; n: [number, number] } | undefined {
  const edges: [Side, number, [number, number]][] = [['+x', r.x1 - x, [1, 0]], ['-x', x - r.x0, [-1, 0]], ['+z', r.z1 - z, [0, 1]], ['-z', z - r.z0, [0, -1]]];
  let best: { d: number; n: [number, number] } = { d: Infinity, n: [0, 0] };
  for (const [side, v, n] of edges) {
    if (v < 0) return undefined;
    if (!r.closed.includes(side) && v < best.d) best = { d: v, n };
  }
  return best;
}

/** How sheltered world point (x, y = feet height, z) is. */
export function shelterAt(buildings: BuildingDef[], roofs: Roof[], x: number, y: number, z: number): Shelter {
  let out: Shelter = { cover: 0, enclosed: 0 };
  for (const b of buildings) {
    const lx = x - b.x, lz = z - b.z;
    const inset = Math.min(b.w / 2 - Math.abs(lx), b.d / 2 - Math.abs(lz));
    if (inset <= 0) continue;
    if (!isHollow(b)) {
      if (y >= roofTop(b)) continue;
      const k = clamp01(inset / SHELTER.ramp);
      if (k > out.enclosed) out = { cover: k, enclosed: k, building: b.id };
      continue;
    }
    const c = courtRect(b);
    if (c && lx > c.x0 && lx < c.x1 && lz > c.z0 && lz < c.z1) continue; // in the 天井: open to the sky
    const level = storeyAt(b, y);
    if (level === undefined) {
      // on the roof: out in the weather, unless inside a 出屋面 bulkhead (上屋面 stair)
      const H = buildingHeight(b), p = roofStairs(b).find(q => lx > q.x0 && lx < q.x1 && lz > q.z0 && lz < q.z1);
      if (p && y >= H - 0.05 && y < H + STAIR.roofH) return { cover: 1, enclosed: 1, building: b.id };
      // or inside the 天台水箱间 (据点 #1): its door stands open, so as sheltered as just inside a doorway, more further in
      const t = tankRoomRect(b);
      if (t && x > t.x0 && x < t.x1 && z > t.z0 && z < t.z1 && y >= t.y0 - 0.05 && y < t.y1) {
        const d = tankDoorDepth(b, x, z);
        return { cover: 1, enclosed: SHELTER.door + (1 - SHELTER.door) * clamp01(d / SHELTER.doorRamp), building: b.id };
      }
      continue;
    }
    const room = inset > WALL_T ? storeyRooms(b, level).find(r => {
      const R = rectOf(r);
      return lx >= R.x0 && lx <= R.x1 && lz >= R.z0 && lz <= R.z1;
    }) : undefined;
    // open floor on the ground storey (or standing in a doorway itself, in the outer wall or a 天井 wall): the
    // entrance lets the weather in
    const w = courtOuter(b), inCourtWall = !!w && lx > w.x0 && lx < w.x1 && lz > w.z0 && lz < w.z1;
    if (level === 1 && (!room ? inset <= WALL_T || inCourtWall : OPEN.includes(room.kind))) {
      const door = nearestDoor(b, lx, lz), k = clamp01(door.d / SHELTER.doorRamp);
      if (k < 1) {
        const roof = door.i >= 0 ? canopyRects(b)[door.i] : undefined;
        return { cover: 1, enclosed: SHELTER.door + (1 - SHELTER.door) * k, building: b.id, level, room, open: door.n, edge: door.d + (roof ? roof.out : 0), roof };
      }
    }
    return { cover: 1, enclosed: 1, building: b.id, level, room };
  }
  for (const r of roofs) {
    if (y >= r.y) continue;
    const u = underRoof(r, x, z);
    if (!u) continue;
    const k = clamp01(u.d / SHELTER.rim);
    if (k <= out.cover) continue;
    out = { cover: k, enclosed: Math.max(out.enclosed, SHELTER.under * k), open: u.n, edge: u.d, roof: r };
  }
  return out;
}

/**
 * Screen rain strokes (render/post.ts) at a sheltered spot: full outdoors, none in a shut room. Under cover with a way
 * out (雨棚, 门厅) the strokes are the rain seen past the edge: thinned by how enclosed it is, and only while looking
 * out (`fwd` = unit plan view direction; facing the wall behind you see no rain).
 */
export function rainStrokes(rain: number, s: Pick<Shelter, 'cover' | 'enclosed' | 'open' | 'roof' | 'building'>, fwd: [number, number] = [0, 0]): number {
  // the way out, and straight across from it too when that edge is open as well (a 连廊 deck: both long sides; a
  // 雨棚 has its wall there)
  const across = s.open && s.roof && !s.building && !s.roof.closed.includes(SIDE_N.find(([, n]) => n[0] === -s.open![0] && n[1] === -s.open![1])![0]);
  const ns: [number, number][] = !s.open ? [] : across ? [s.open, [-s.open[0], -s.open[1]]] : [s.open];
  const o = ns.length ? Math.max(...ns.map(n => fwd[0] * n[0] + fwd[1] * n[1])) : 1;
  const facing = clamp01((o + 0.2) / 0.6);
  return rain * ((1 - s.cover) + s.cover * (1 - s.enclosed) * SHELTER.seen * facing);
}

/**
 * View depth (m, along the unit camera forward `fwd`) of the farthest corner of the roof's underside, seen from `eye`:
 * rain strokes drawn nearer than this would sit on the roof itself (render/post.ts `rain.z`). Pure.
 */
export function roofDepth(r: Roof, eye: [number, number, number], fwd: [number, number, number]): number {
  const y = r.y - r.t;
  let far = 0;
  for (const [x, z] of [[r.x0, r.z0], [r.x1, r.z0], [r.x0, r.z1], [r.x1, r.z1]]) {
    far = Math.max(far, (x - eye[0]) * fwd[0] + (y - eye[1]) * fwd[1] + (z - eye[2]) * fwd[2]);
  }
  return far;
}

/**
 * Boxes nothing falls into (world space, from the ground up to `y`): every building up to its parapet top, every
 * roof up to its underside (under a 连廊 that is the deck above, as good as a roof). Fed to the snow shader (world/snow.ts) so no flake is ever indoors or under a canopy.
 */
export interface DryBox { x0: number; x1: number; z0: number; z1: number; y: number }
export function dryBoxes(buildings: BuildingDef[], roofs: Roof[]): DryBox[] {
  return [
    // a 回字形 building is its ring round the 天井 (snow falls into the light well)
    ...buildings.flatMap(b => {
      const foot = { x0: -b.w / 2, x1: b.w / 2, z0: -b.d / 2, z1: b.d / 2 }, c = courtRect(b);
      return (c ? rectMinus(foot, c) : [foot]).map(r => ({ x0: b.x + r.x0, x1: b.x + r.x1, z0: b.z + r.z0, z1: b.z + r.z1, y: roofTop(b) }));
    }),
    ...roofs.map(r => ({ x0: r.x0, x1: r.x1, z0: r.z0, z1: r.z1, y: r.y })),
    // 出屋面 bulkheads of 上屋面 stairs (their lid stands above the parapet)
    ...buildings.flatMap(b => roofStairs(b).map(r => ({ x0: b.x + r.x0, x1: b.x + r.x1, z0: b.z + r.z0, z1: b.z + r.z1, y: buildingHeight(b) + STAIR.roofH }))),
    // 天台水箱间 (world/tankroom.ts): the room up to its 压顶, the 水箱 on it
    ...buildings.flatMap(b => {
      const r = tankRoomRect(b), k = tankBox(b);
      return r && k ? [{ ...r, y: r.y1 + TANK.slab.t / 2 }, { ...k, y: k.y1 }] : [];
    }),
  ];
}
