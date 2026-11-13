import * as THREE from 'three';
import { buildingHeight, courtRect, FLOOR_HEIGHT, floorStack, parseNightRoom, roofTop, WALL_T, type BuildingDef, type Side } from '../../../../shared/campus/campus_schema.ts';
import { courtOpenings, facadeOpenings, FRAME_W, MULLION, type Opening } from '../world/building.ts';
import { NET } from '../world/netroom.ts';
import { rectOf, storeyPartitions, storeyRooms, PART } from '../world/rooms.ts';
import { flightBoxes, stairPlan, stairTop, STAIR, type Flight, type LBox, type StairPlan } from '../../../../shared/campus/stairs.ts';
import { BASEMENT, DADO, LAMP, PAINT, stairLamps, stairPlans, TERRAZZO, TILE } from '../world/interior.ts';
import { tiledRects } from '../world/canteen.ts';
import { tankInside } from '../world/tankroom.ts';
import { darkroomLights } from '../world/oldlab.ts';
import { oneLampBox } from '../world/boiler.ts';
import { exitSigns, type ExitSign } from '../world/stairfit.ts';
import { equipCeiling } from '../world/gym.ts';
import { sampleTimeOfDay } from '../systems/timeofday.ts';
import { lampHeights, lampPositions } from '../world/lamps.ts';
import { DESK, FURN_COLOR, lampsAndFans, storeyFurniture, SURF_BOARD, SURF_FAN, SURF_LABEL, SURF_PILE, SURF_TILE, TUBE } from '../world/classroom.ts';

export { TUBE };

/**
 * 室内时段光 (docs/05_art_audio.md): the interior material lights itself from the same sun, but only through the holes
 * the facade really has, and swaps the outdoor hemisphere for an indoor ambient; at night the ceiling 日光灯 come on.
 * No shadow maps, no extra meshes: per fragment, the ray toward the sun is followed to the outer wall it leaves by
 * (inner and outer plane, so thick walls narrow the patch); a baked window mask (glass minus frame and mullion, open
 * doorways) says whether it gets out, the storey's ceiling and a short list of wall boxes (隔墙, stairwell walls) whether
 * it is blocked on the way. Round a 天井 (回字形) a ray that meets the light well goes out through its wall instead (4 more
 * mask bands) and must then clear the far wing's parapet on its way across the void. The mask is read soft (bilinear + a tent that widens away from the window, PENUMBRA), so the
 * patches have a penumbra instead of 5 cm stair-steps. `sunLight` is the same test in TS, for tests.
 */

/** Mask texel size (m): fine enough that the mullion and the frame border show in the patch. */
export const MASK_RES = 0.05;
/** Occluder boxes per building the shader loops over (A 回字形 needs ~30). */
export const MAX_OCC = 40;
/**
 * Soft patch edges (光斑柔化): the window mask is read bilinearly through a 3×3 tent whose width on the window plane grows
 * with the distance from the fragment to the window (`base + perM · t`, the patch goes vaguer the further it falls from
 * the window) plus `foot` × the fragment's own footprint (anti-aliasing far away; at 1 it washes the 中梃 gap out at a
 * grazing view), capped at `max` (m).
 */
export const PENUMBRA = { base: 0.02, perM: 0.015, foot: 0.5, max: 0.2 };
/** Indoor ambient: share of the hemisphere light left deep inside vs at the windows, and its falloff (m). */
export const INDOOR = { deep: 0.55, falloff: 5, bounce: 0.12 };
/**
 * 阴雨雪天 by day the 日光灯 come on (dayTubesOn) on top of the window ambient; under snow's bright sky (hemi × 1.15) the
 * two stacked to ~1.6× a clear 10:00 and the 课桌 read washed-out grey. Where they are on by day the window ambient is
 * cut by this share (rain ≈ a clear morning, snow ~10% over it): the lights stand in for the dull sky, not add to it.
 */
export const DAY_AMB_CUT = 0.5;
/** SpotLights with at least this decay are 手电 (they light the interior); the street lamps (decay 1.6) do not. */
export const TORCH_DECAY = 1.9;

const SIDES: Side[] = ['+x', '-x', '+z', '-z'];

/**
 * Window mask of a building: R8, one band of `rows` rows per side (+x, −x, +z, −z), u centred on `half`; a 回字形 one
 * has 4 more (`bands` = 8): the 天井 walls by the side their facade faces, u from the void's centre line.
 */
export interface WindowMask { data: Uint8Array; width: number; rows: number; bands: number; half: number; res: number }
/**
 * An axis-aligned wall box in world space, standing on the storeys whose bit is set in `levels` (storeyIndex). `rel`:
 * y0/y1 are from the floor of the storey the fragment is on (a stair flight, the same on every storey it climbs).
 */
export interface OccBox { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number; levels: number; rel?: true }
/** Boxes a stair flight is cut into as a light occluder (under its treads, so the treads do not shade themselves). */
export const STAIR_OCC = { chunks: 4 };
/** Everything the per-fragment sun test needs about one building. */
export interface InteriorLightGeo {
  cx: number; cz: number; hw: number; hd: number; wall: number; storey: number; slab: number;
  mask: WindowMask; occ: OccBox[];
  /** the furniture's top-view height map (家具挡光, furnMap) */
  furn: FurnMap;
  /** 天井 (world centre, half size of the void) and the parapet top a ray must clear to get out of it */
  court?: { cx: number; cz: number; hw: number; hd: number; top: number };
}
/** Soft edge (m, in height) of the far wing's shadow across a 天井. */
export const COURT_EDGE = 0.3;

/** Bake where light gets through the outer walls: glass (inside the frame, minus the mullion) and open doorways. */
export function windowMask(b: BuildingDef, res = MASK_RES): WindowMask {
  const half = Math.max(b.w, b.d) / 2, width = Math.ceil((2 * half) / res), rows = Math.ceil(buildingHeight(b) / res);
  const bands = b.courtyard ? 8 : 4, data = new Uint8Array(width * rows * bands);
  const fill = (s: number, u0: number, u1: number, y0: number, y1: number, v: number) => {
    const c0 = Math.max(0, Math.ceil((u0 + half) / res - 0.5)), c1 = Math.min(width - 1, Math.floor((u1 + half) / res - 0.5));
    const r0 = Math.max(0, Math.ceil(y0 / res - 0.5)), r1 = Math.min(rows - 1, Math.floor(y1 / res - 0.5));
    for (let r = r0; r <= r1; r++) data.fill(v, (s * rows + r) * width + c0, (s * rows + r) * width + c1 + 1);
  };
  const band = (o: Opening) => (o.court ? 4 : 0) + SIDES.indexOf(o.side);
  for (const o of [...facadeOpenings(b), ...courtOpenings(b)]) {
    const s = band(o);
    if (o.kind === 'entrance') { fill(s, o.u0, o.u1, o.y0, o.y1, 255); continue; }
    const um = (o.u0 + o.u1) / 2;
    fill(s, o.u0 + FRAME_W, o.u1 - FRAME_W, o.y0 + FRAME_W, o.y1 - FRAME_W, 255);
    fill(s, um - MULLION / 2, um + MULLION / 2, o.y0, o.y1, 0);
  }
  return { data, width, rows, bands, half, res };
}

/** Storey index of a world height (0 = ground floor), as the shader's intCeil counts storeys. */
export const storeyIndex = (y: number, storey: number) => Math.floor((y + 0.05) / storey);

/**
 * Walls inside the shell that stop light (world space): every storey's 隔墙 (holes ignored) and the stairwell walls.
 * A sun ray never leaves the storey it starts on (it gets out through a window below that storey's ceiling), so a
 * wall is one plan footprint + `levels`, the bitmask of the storeys (storeyIndex) it stands on: the same wall on every
 * floor of a 回字形 plan is one box, not five. The 天井 walls are not here: `sunLight` goes through them like an outer wall.
 * A 吊顶 hung lower than the windows (体育馆 器材室) is one too.
 */
export function occluders(b: BuildingDef): OccBox[] {
  const out: OccBox[] = [], t = PART.t / 2, E = 1e-6, H = b.floorHeight ?? FLOOR_HEIGHT;
  const add = (o: Omit<OccBox, 'levels'>, k: number) => {
    const bit = k >= 0 && k < 24 ? 2 ** k : 0;
    const m = out.find(q => !q.rel === !o.rel && Math.abs(q.x0 - o.x0) < E && Math.abs(q.x1 - o.x1) < E && Math.abs(q.z0 - o.z0) < E && Math.abs(q.z1 - o.z1) < E);
    if (!m) { out.push({ ...o, levels: bit }); return; }
    if (!(m.levels & bit)) m.levels += bit;
    m.y0 = Math.min(m.y0, o.y0); m.y1 = Math.max(m.y1, o.y1);
  };
  for (const st of floorStack(b)) if (st.y >= 0) for (const w of storeyPartitions(b, st.level)) {
    add(w.axis === 'x'
      ? { x0: w.u0, x1: w.u1, z0: w.c - t, z1: w.c + t, y0: w.y0, y1: w.y1 }
      : { x0: w.c - t, x1: w.c + t, z0: w.u0, z1: w.u1, y0: w.y0, y1: w.y1 }, storeyIndex(st.y, H));
  }
  for (const s of b.stairwells ?? []) {
    const p = stairPlan(b, s, WALL_T), r = p.rect, e = STAIR.encl;
    const y0 = p.storeys[0].y, y1 = stairTop(p);
    for (const side of p.walls) for (const st of p.storeys) add(side[1] === 'x'
      ? { x0: side[0] === '+' ? r.x1 - e : r.x0, x1: side[0] === '+' ? r.x1 : r.x0 + e, z0: r.z0, z1: r.z1, y0, y1 }
      : { x0: r.x0, x1: r.x1, z0: side[0] === '+' ? r.z1 - e : r.z0, z1: side[0] === '+' ? r.z1 : r.z0 + e, y0, y1 }, storeyIndex(st.y, H));
    // the flights and the 休息平台 slab: a stairwell on the outer wall gets sun through its 休息平台 windows, low
    // morning sun along the stair would otherwise come through the flight above onto the treads and the far wall
    if (p.walls.length < 4) for (const st of p.storeys) {
      const k = storeyIndex(st.y, H), rel = Math.abs(st.y - k * H) < 1e-3;
      const lift = (o: LBox) => (rel ? { ...o, y0: o.y0 - st.y, y1: o.y1 - st.y, rel: true as const } : o);
      if (st.mid) add(lift(st.mid), k);
      for (const f of [st.flight1, st.flight2]) if (f) for (const o of flightOcc(p, f)) add(lift(o), k);
    }
  }
  // a 吊顶 under the high windows (体育馆 器材室): the sun would come down through it onto the room's walls
  for (const st of floorStack(b)) if (st.y >= 0) for (const r of storeyRooms(b, st.level)) {
    if (r.kind === 'equip') add(equipCeiling(b, r, st.y), storeyIndex(st.y, H));
  }
  return out.map(o => ({ ...o, x0: o.x0 + b.x, x1: o.x1 + b.x, z0: o.z0 + b.z, z1: o.z1 + b.z }));
}

/**
 * A flight as STAIR_OCC.chunks boxes: plan = the chunk's steps, top = its first tread (the treads above it stick out
 * a step or two: they shade the next chunk's foot, not themselves), bottom = the soffit under that first step (a hand's
 * breadth below the real soffit at the chunk's top end, no gap a low sun gets through in streaks).
 */
export function flightOcc(p: StairPlan, f: Flight, n = STAIR_OCC.chunks): LBox[] {
  const steps = flightBoxes(p, f), out: LBox[] = [];
  for (let c = 0; c < n; c++) {
    const s = steps.slice(Math.floor((c * steps.length) / n), Math.floor(((c + 1) * steps.length) / n));
    if (!s.length) continue;
    const y1 = s[0].y1, y0 = Math.min(...s.map(q => q.y0));
    out.push({ x0: Math.min(...s.map(q => q.x0)), x1: Math.max(...s.map(q => q.x1)), z0: Math.min(...s.map(q => q.z0)), z1: Math.max(...s.map(q => q.z1)), y0, y1 });
  }
  return out;
}

/**
 * 家具挡光: the furniture as a light occluder, a top-view height map per storey (band = storeyIndex) of the storey's
 * colliders (实验桌, 课桌椅, 书架, 柜子: storeyFurniture solid, each a block from the floor to its top). The sun ray is
 * marched across it from the fragment toward the window (`steps` samples from `start` m out, at least `minStep` apart,
 * until it is above the tallest top), so the floor under and behind a 实验桌 and the wall behind it lie in its shadow.
 * A sample shades by how far the map stands above the ray (minus `bias`, over `soft` m): a top never shades itself.
 */
export const FURN_SHADE = { res: 0.1, start: 0.12, steps: 40, minStep: 0.1, bias: 0.02, soft: 0.06 };
/** R8, `bands` bands of `rows` rows (z) × `width` (x) from the building's (x0, z0) corner; value × `scale` = top above the storey floor. */
export interface FurnMap { data: Uint8Array; width: number; rows: number; bands: number; res: number; x0: number; z0: number; scale: number; max: number }
export function furnMap(b: BuildingDef, res = FURN_SHADE.res): FurnMap {
  const H = b.floorHeight ?? FLOOR_HEIGHT, width = Math.ceil(b.w / res), rows = Math.ceil(b.d / res);
  const sts = floorStack(b).filter(s => s.y >= 0), bands = Math.max(1, ...sts.map(s => storeyIndex(s.y, H) + 1));
  const data = new Uint8Array(width * rows * bands);
  let max = 0;
  for (const st of sts) {
    const k = storeyIndex(st.y, H);
    for (const q of storeyFurniture(b, st.level).solid) {
      const v = Math.round((Math.min(H, q.y1 - k * H) / H) * 255);
      if (v <= 0) continue;
      const c0 = Math.max(0, Math.ceil((q.x0 + b.w / 2) / res - 0.5)), c1 = Math.min(width - 1, Math.floor((q.x1 + b.w / 2) / res - 0.5));
      const r0 = Math.max(0, Math.ceil((q.z0 + b.d / 2) / res - 0.5)), r1 = Math.min(rows - 1, Math.floor((q.z1 + b.d / 2) / res - 0.5));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        const i = (k * rows + r) * width + c;
        if (data[i] < v) data[i] = v;
      }
      if (c0 <= c1 && r0 <= r1) max = Math.max(max, (v / 255) * H);
    }
  }
  return { data, width, rows, bands, res, x0: b.x - b.w / 2, z0: b.z - b.d / 2, scale: H, max };
}
/** Bilinear read of a storey's band (m above its floor), clamped to the band as the shader's intFurnAt. */
export function furnAt(f: FurnMap, band: number, x: number, z: number): number {
  const cu = Math.min(Math.max((x - f.x0) / f.res, 0.5), f.width - 0.5) - 0.5, cr = Math.min(Math.max((z - f.z0) / f.res, 0.5), f.rows - 0.5) - 0.5;
  const c0 = Math.floor(cu), r0 = Math.floor(cr), fu = cu - c0, fr = cr - r0;
  const c1 = Math.min(c0 + 1, f.width - 1), r1 = Math.min(r0 + 1, f.rows - 1);
  const at = (c: number, r: number) => f.data[(band * f.rows + r) * f.width + c] / 255;
  return ((at(c0, r0) * (1 - fu) + at(c1, r0) * fu) * (1 - fr) + (at(c0, r1) * (1 - fu) + at(c1, r1) * fu) * fr) * f.scale;
}
/**
 * Share of the sun ray from `p` (storey `si`, `storey` m high) the furniture blocks before it reaches the window
 * `t` m on along unit `L`, 0..1. Mirrors the shader's intFurnShade.
 */
export function furnShade(f: FurnMap, p: [number, number, number], L: [number, number, number], si: number, t: number, storey: number): number {
  const lh = Math.hypot(L[0], L[2]);
  if (!(f.max > 0) || si < 0 || si >= f.bands || lh < 1e-4) return 0;
  const S = FURN_SHADE, dx = L[0] / lh, dz = L[2] / lh, k = L[1] / lh, y = p[1] - si * storey;
  const reach = Math.min(t * lh, (f.max - y) / k);
  if (reach <= S.start) return 0;
  const step = Math.max(S.minStep, (reach - S.start) / (S.steps - 1));
  let s = 0;
  for (let i = 0; i < S.steps; i++) {
    const r = S.start + step * i;
    if (r > reach) break;
    s = Math.max(s, Math.min(1, Math.max(0, (furnAt(f, si, p[0] + dx * r, p[2] + dz * r) - y - k * r - S.bias) / S.soft)));
    if (s >= 1) break;
  }
  return s;
}

export function interiorLightGeo(b: BuildingDef): InteriorLightGeo {
  const c = courtRect(b);
  return {
    cx: b.x, cz: b.z, hw: b.w / 2, hd: b.d / 2, wall: WALL_T, storey: b.floorHeight ?? FLOOR_HEIGHT, slab: STAIR.slab,
    mask: windowMask(b), occ: occluders(b), furn: furnMap(b),
    court: c && { cx: b.x + (c.x0 + c.x1) / 2, cz: b.z + (c.z0 + c.z1) / 2, hw: (c.x1 - c.x0) / 2, hd: (c.z1 - c.z0) / 2, top: roofTop(b) },
  };
}

/** Bilinear read of the mask (as the GPU's LinearFilter does), clamped to its side's band. */
export const maskBilinear = (m: WindowMask, side: number, u: number, y: number) => {
  const cu = Math.min(Math.max((u + m.half) / m.res, 0.5), m.width - 0.5) - 0.5, cr = Math.min(Math.max(y / m.res, 0.5), m.rows - 0.5) - 0.5;
  const c0 = Math.floor(cu), r0 = Math.floor(cr), fu = cu - c0, fr = cr - r0;
  const c1 = Math.min(c0 + 1, m.width - 1), r1 = Math.min(r0 + 1, m.rows - 1);
  const at = (c: number, r: number) => m.data[(side * m.rows + r) * m.width + c] / 255;
  return (at(c0, r0) * (1 - fu) + at(c1, r0) * fu) * (1 - fr) + (at(c0, r1) * (1 - fu) + at(c1, r1) * fu) * fr;
};
/** Penumbra width on the window plane for a fragment `t` m from it with a `foot` m footprint. */
export const penumbra = (t: number, foot = 0) => Math.min(PENUMBRA.max, PENUMBRA.base + PENUMBRA.perM * Math.max(0, t) + PENUMBRA.foot * foot);
const TENT: [number, number][] = [[-0.5, 0.25], [0, 0.5], [0.5, 0.25]];
/** The mask through the tent of width `w`. */
export function maskSoft(m: WindowMask, side: number, u: number, y: number, w: number): number {
  let s = 0;
  for (const [a, wa] of TENT) for (const [b, wb] of TENT) s += wa * wb * maskBilinear(m, side, u + a * w, y + b * w);
  return s;
}

/**
 * How much sun world point `p` indoors gets along unit `L` (+y up) through a window, 0..1 (soft at the patch edges);
 * `foot` = the fragment's footprint on the window plane (the shader takes it from screen derivatives). Mirrors the shader.
 */
export function sunLight(g: InteriorLightGeo, p: [number, number, number], L: [number, number, number], foot = 0): number {
  // below ground (地下室) no sun gets in
  if (L[1] <= 0.01 || p[1] < -0.1) return 0;
  const ceil = (Math.floor((p[1] + 0.05) / g.storey) + 1) * g.storey - g.slab;
  const rx = p[0] - g.cx, rz = p[2] - g.cz, sx = L[0] >= 0 ? 1 : -1, sz = L[2] >= 0 ? 1 : -1;
  const ix = g.hw - g.wall, iz = g.hd - g.wall;
  const tx = Math.abs(L[0]) > 1e-4 ? (sx * ix - rx) / L[0] : 1e9, tz = Math.abs(L[2]) > 1e-4 ? (sz * iz - rz) / L[2] : 1e9;
  let xs = tx < tz, t = xs ? tx : tz;
  let tOut = xs ? (sx * g.hw - rx) / L[0] : (sz * g.hd - rz) / L[2];
  let side = xs ? (sx > 0 ? 0 : 1) : (sz > 0 ? 2 : 3);
  // u along the wall the ray leaves by, from the building's centre line (outer walls) or the void's (天井 walls)
  let ux = rx, uz = rz, sky = 1;
  const c = g.court;
  if (c) {
    // the 天井 with its walls, relative to p: does the ray meet it (before the outer wall, as it lies inside)?
    const qx = p[0] - c.cx, qz = p[2] - c.cz, ox = c.hw + g.wall, oz = c.hd + g.wall;
    const ax = Math.abs(L[0]) > 1e-4 ? (-sx * ox - qx) / L[0] : (Math.abs(qx) < ox ? -1e9 : 1e9);
    const az = Math.abs(L[2]) > 1e-4 ? (-sz * oz - qz) / L[2] : (Math.abs(qz) < oz ? -1e9 : 1e9);
    const bx = Math.abs(L[0]) > 1e-4 ? (sx * ox - qx) / L[0] : 1e9, bz = Math.abs(L[2]) > 1e-4 ? (sz * oz - qz) / L[2] : 1e9;
    const tn = Math.max(ax, az), tf = Math.min(bx, bz);
    if (tn < tf && tn > 0) {
      // in through the 天井 wall facing the way the ray goes (its facade looks into the void, toward the sun)
      xs = ax > az; t = tn;
      tOut = xs ? (-sx * c.hw - qx) / L[0] : (-sz * c.hd - qz) / L[2];
      side = 4 + (xs ? (sx > 0 ? 0 : 1) : (sz > 0 ? 2 : 3));
      ux = qx; uz = qz;
      // across the void and over the far wing's parapet (a soft edge: the shadow line of the opposite roof)
      const ex = Math.abs(L[0]) > 1e-4 ? (sx * c.hw - qx) / L[0] : 1e9, ez = Math.abs(L[2]) > 1e-4 ? (sz * c.hd - qz) / L[2] : 1e9;
      const yExit = p[1] + L[1] * Math.min(ex, ez);
      sky = Math.min(1, Math.max(0, (yExit - c.top) / COURT_EDGE + 0.5));
      if (sky <= 0) return 0;
    }
  }
  const y0 = p[1] + L[1] * t, y1 = p[1] + L[1] * tOut;
  if (y0 > ceil) return 0;
  const u = (k: number) => (xs ? uz + L[2] * k : ux + L[0] * k);
  const w = penumbra(t, foot);
  const through = sky * Math.min(maskSoft(g.mask, side, u(t), y0, w), maskSoft(g.mask, side, u(tOut), y1, w));
  if (through <= 0) return 0;
  const si = storeyIndex(p[1], g.storey), bit = 2 ** si;
  for (const o of g.occ) {
    if (!(o.levels & bit)) continue;
    const dy = o.rel ? si * g.storey : 0;
    let n = -Infinity, f = Infinity;
    for (const [pp, l, a, c] of [[p[0], L[0], o.x0, o.x1], [p[1], L[1], o.y0 + dy, o.y1 + dy], [p[2], L[2], o.z0, o.z1]]) {
      const inv = 1 / (Math.abs(l) < 1e-5 ? 1e-5 : l), t1 = (a - pp) * inv, t2 = (c - pp) * inv;
      n = Math.max(n, Math.min(t1, t2)); f = Math.min(f, Math.max(t1, t2));
    }
    if (n < f && f > 0.02 && n < t) return 0;
  }
  return through * (1 - furnShade(g.furn, p, L, si, t, g.storey));
}

/**
 * Indoor ambient level at world (x, z), INDOOR.deep..1: falls off with the distance to the nearest glazed wall,
 * the outer faces or (回字形) the 天井 ring, so the corridor along the light well is not a deep-plan dark. Mirrors `intAmbient`.
 */
export function indoorAmbient(g: InteriorLightGeo, x: number, z: number): number {
  let d = Math.max(0, Math.min(g.hw - Math.abs(x - g.cx), g.hd - Math.abs(z - g.cz)) - WALL_T);
  if (g.court) d = Math.min(d, Math.max(0, Math.max(Math.abs(x - g.court.cx) - g.court.hw, Math.abs(z - g.court.cz) - g.court.hd) - WALL_T));
  return INDOOR.deep + (1 - INDOOR.deep) * Math.exp(-d / INDOOR.falloff);
}

/** Whether `p` is inside a patch (at least half lit): `sunLight` ≥ 0.5. */
export const sunThrough = (g: InteriorLightGeo, p: [number, number, number], L: [number, number, number]) => sunLight(g, p, L) >= 0.5;

/** 日光灯 on (0..1) for the share of lit windows (晚自习 / 早读): off by day and after lights-out. Pure. */
export const tubesOn = (windows: number) => { const k = Math.min(1, Math.max(0, (windows - 0.05) / 0.2)); return k * k * (3 - 2 * k); };
/**
 * 阴雨雪天开灯: by day (路灯 off, people in the building) a rain / snow sky dark enough turns the 日光灯 on in every
 * room and corridor (nightRooms only say who stays at night), from `overcast` (the weather's strength 0..1) past
 * `from`, full at `full`; it gives way as the 路灯 come on (× 1 − lamps), where tubesOn(windows) takes over. Pure.
 */
export const DAY_TUBES = { from: 0.3, full: 0.8 };
export const dayTubesOn = (overcast: number, lamps: number) => {
  const k = Math.min(1, Math.max(0, (overcast - DAY_TUBES.from) / (DAY_TUBES.full - DAY_TUBES.from)));
  return k * k * (3 - 2 * k) * Math.max(0, 1 - lamps);
};
/** The 日光灯 as a whole: on = max(night, day), and the share of `on` that is the day's (every room lit) rather than the night's (nightRooms only). Pure. */
export function tubeState(windows: number, overcast = 0, lamps = 0): { on: number; day: number } {
  const n = tubesOn(windows), d = dayTubesOn(overcast, lamps), on = Math.max(n, d);
  return { on, day: on > 0 ? d / on : 0 };
}

/** Uniforms every interior material shares (main.ts sets them from the time-of-day sample each frame). */
export interface InteriorLightUniforms {
  /** unit vector toward the sun/moon, world */
  intSunDir: { value: THREE.Vector3 };
  /** sun colour × intensity as applied to the scene light (0 below the horizon): for the bounce off lit floors */
  intSunC: { value: THREE.Color };
  /** 日光灯 radiance (linear), 0 = off */
  intTube: { value: THREE.Color };
  /** share of intTube that is 阴雨天 daylight lighting (tubeState.day): every room of a `dayLit` building lit, not only its nightRooms */
  intDayShare: { value: number };
  /** share of the window ambient the 阴雨天 daytime 日光灯 stand in for (DAY_AMB_CUT × on × day): lit rooms not lit twice */
  intDayAmb: { value: number };
  /** 声控灯 (world/interior.ts LAMP, surf.y = 4) radiance (linear), 0 = off: on its own switch, not the 日光灯's */
  intStairLamp: { value: THREE.Color };
  /** night sky seen through a dark corridor's end window (WIN_GLOW), linear, 0 = none */
  intWinSky: { value: THREE.Color };
  /** the 路灯 seen through the end windows (WIN_LAMP): its colour × level × the lamps' on (syncInteriorLight) */
  intWinLamp: { value: THREE.Color };
  /** seconds (game loop time): the 机房's 指示灯 flicker and 监控 pictures (world/netroom.ts, glowGlsl) */
  intTime: { value: number };
  /** 吊扇 angle (rad, spinFans): advances only while the 日光灯 are on, so the fans run up and wind down with them */
  intFanAng: { value: number };
  /** 水箱间's bare bulb (TANK_BULB) radiance (linear), 0 = off: on once it is dark (syncInteriorLight) */
  intTankBulb: { value: THREE.Color };
  /** 夜里的底光 (NIGHT_AMB) radiance (linear), 0 by day: faded in with winNight */
  intNightAmb: { value: THREE.Color };
  /** 跳闸 (CampusScene.out): x, z = where the tubes start dying, z = radius (m) reached, w = how far out (0..1) */
  intOut: { value: THREE.Vector4 };
  /** Optional zero-based storey for an exam penalty; -999 preserves ordinary trips. */
  intOutFloor: { value: number };
  /** 暗适应 (EYE_LIGHT, CampusScene.eye): xyz = the eye (world), w = strength 0..1 (0 but in a dark 停电关) */
  intEye: { value: THREE.Vector4 };
  /** The active level's lit landmark: fixture xyz, w = powered (0/1); always allocated, moved between levels. */
  intLandmark: { value: THREE.Vector4 };
  /** Its room's actual clear plan rect (x0, z0, x1, z1), storey floor/ceiling and tube axis in plan. */
  intLandmarkRect: { value: THREE.Vector4 };
  intLandmarkY: { value: THREE.Vector2 };
  intLandmarkAxis: { value: THREE.Vector2 };
}
export function createInteriorLightUniforms(): InteriorLightUniforms {
  return { intSunDir: { value: new THREE.Vector3(0, 1, 0) }, intSunC: { value: new THREE.Color(0) }, intTube: { value: new THREE.Color(0) }, intDayShare: { value: 0 }, intDayAmb: { value: 0 }, intStairLamp: { value: new THREE.Color(0) }, intWinSky: { value: new THREE.Color(0) }, intWinLamp: { value: new THREE.Color(0) }, intTime: { value: 0 }, intFanAng: { value: 0 }, intTankBulb: { value: new THREE.Color(0) }, intNightAmb: { value: new THREE.Color(0) }, intOut: { value: new THREE.Vector4(0, 0, 999, 0) }, intOutFloor: { value: -999 }, intEye: { value: new THREE.Vector4(0, 0, 0, 0) }, intLandmark: { value: new THREE.Vector4() }, intLandmarkRect: { value: new THREE.Vector4() }, intLandmarkY: { value: new THREE.Vector2() }, intLandmarkAxis: { value: new THREE.Vector2(1, 0) } };
}

/**
 * The landmark's existing 1.4 m ceiling tube supplies local irradiance, like the analytic stair lamps below.
 * Three samples along its length soften the wall wash; the housing sends most light down and the whitewash
 * returns a small bounce. Room bounds keep it off the other side of walls and the floor above. No THREE light,
 * draw call, shadow map or light-count shader variant is needed.
 */
export const LANDMARK_LIGHT = { height: 2.95, half: 0.7, k: 9, core: 0.6, up: 0.3, above: 0.01, cap: 0.3, bounce: 0.075, edge: 0.02, warm: new THREE.Color(1, 0.89, 0.73) };
/** CPU counterpart of intLandmarkAt, before the tube colour/power and intLive outage factor. */
export function landmarkLight(u: InteriorLightUniforms, p: readonly [number, number, number], n: readonly [number, number, number]): number {
  const l = u.intLandmark.value, r = u.intLandmarkRect.value, y = u.intLandmarkY.value, a = u.intLandmarkAxis.value, e = LANDMARK_LIGHT.edge;
  if (l.w <= 0 || p[0] < r.x - e || p[0] > r.z + e || p[2] < r.y - e || p[2] > r.w + e || p[1] < y.x - e || p[1] > y.y + e) return 0;
  let s = 0;
  for (const offset of [-LANDMARK_LIGHT.half * 2 / 3, 0, LANDMARK_LIGHT.half * 2 / 3]) {
    const dx = l.x + a.x * offset - p[0], dy = l.y - p[1], dz = l.z + a.y * offset - p[2];
    const d2 = dx * dx + dy * dy + dz * dz, len = Math.max(Math.sqrt(d2), 1e-4);
    const cap = 1 - (1 - LANDMARK_LIGHT.above) * THREE.MathUtils.smoothstep(-dy / len, 0, LANDMARK_LIGHT.cap);
    s += Math.max(0, (dx * n[0] + dy * n[1] + dz * n[2]) / len)
      * (LANDMARK_LIGHT.up + (1 - LANDMARK_LIGHT.up) * Math.max(0, dy / len)) * cap / (d2 + LANDMARK_LIGHT.core);
  }
  return l.w * (LANDMARK_LIGHT.bounce + LANDMARK_LIGHT.k * s / 3);
}
/** 声控灯: a warm 白炽灯泡 behind milk glass (yellower than the 日光灯), and how bright its shade glows when on. */
export const STAIR_LAMP_COLOR = new THREE.Color(0xf2dcae);
export const STAIR_LAMP_LEVEL = 0.85;
/**
 * 声控灯的光 (旧办公楼④a): each lamp is an analytic point light in the interior shader (no THREE light, 0 draw calls),
 * added to the indoor irradiance × intStairLamp. A bare bulb in a milk-glass bowl: `k` / (d² + `core`) with a soft
 * cut at `range` (m), Lambert on the receiving face, and `up` = the share it throws up out of the open bowl (onto the
 * ceiling) against straight down. It lights only its own stairwell (clear rect) and only 本层: the 楼层平台, the
 * half-flight coming up to it from the 休息平台 below and the one going on up to the 休息平台 above, with the walls
 * round them up to its ceiling; treads above that 休息平台 belong to the next lamp. No shadows: flights do not cast.
 */
export const LAMP_LIGHT = { k: 4.5, core: 0.35, range: 7, up: 0.3, max: 8 };
/** One lamp's light, world space: the bulb, its storey's floor and height, and the stairwell clear rect it stays in. */
export interface LampLight { x: number; y: number; z: number; floor: number; h: number; rect: { x0: number; x1: number; z0: number; z1: number } }
export function lampLights(b: BuildingDef): LampLight[] {
  const plans = stairPlans(b);
  return stairLamps(b).map(l => {
    const p = plans.find(q => q.def.id === l.stair)!, st = p.storeys.find(s => s.level === l.level)!, c = p.clear;
    return {
      x: l.x, y: l.y - LAMP.baseH - LAMP.h * 0.6, z: l.z, floor: st.y, h: st.h,
      rect: { x0: b.x + c.x0, x1: b.x + c.x1, z0: b.z + c.z0, z1: b.z + c.z1 },
    };
  });
}
/** Soft lower edge (m) of a lamp's reach, round the 休息平台 below (a hard cut would draw a line across the wall). */
export const LAMP_FADE = 0.5;
/**
 * How much lamp `l` reaches a face at `p` with normal `n`, 0..1 (its stairwell, its storey's span: fading out round
 * the 休息平台 below, which lies under the flight above). Mirrors the shader.
 */
export function lampReach(l: LampLight, p: readonly [number, number, number], n: readonly [number, number, number]): number {
  const E = 0.05, r = l.rect;
  if (p[0] < r.x0 - E || p[0] > r.x1 + E || p[2] < r.z0 - E || p[2] > r.z1 + E) return 0;
  if (p[1] > l.y + LAMP.h) return 0;
  // a floor above the 休息平台 over it is the next storey's
  if (n[1] > 0.5 && p[1] > l.floor + l.h / 2 - 0.02) return 0;
  const k = Math.min(1, Math.max(0, (p[1] - (l.floor - l.h / 2 - LAMP_FADE)) / (2 * LAMP_FADE)));
  return k * k * (3 - 2 * k);
}
/** Irradiance factor (× intStairLamp) at `p`, normal `n` (unit), from all the lamps. Mirrors the shader's intLampAt. */
export function stairLampLight(lamps: LampLight[], p: readonly [number, number, number], n: readonly [number, number, number]): number {
  let s = 0;
  for (const l of lamps) {
    const reach = lampReach(l, p, n);
    if (reach <= 0) continue;
    const d = [l.x - p[0], l.y - p[1], l.z - p[2]], d2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2, len = Math.sqrt(d2) || 1;
    const cos = Math.max(0, (d[0] * n[0] + d[1] * n[1] + d[2] * n[2]) / len);
    // the bowl: full strength downward, `up` toward the ceiling (−d.y / len = how far below the bulb p lies)
    const bowl = LAMP_LIGHT.up + (1 - LAMP_LIGHT.up) * Math.max(0, d[1] / len);
    const cut = Math.min(1, Math.max(0, (LAMP_LIGHT.range - len) / 1.5));
    s += reach * LAMP_LIGHT.k * cos * bowl * cut / (d2 + LAMP_LIGHT.core);
  }
  return s;
}
/**
 * 夜里只亮一间 (旧办公楼④b1): a building with `nightRooms` keeps its 日光灯 on at night only in those rooms (21:40: the
 * 语文组, 角色074 still at his desk); the corridors and every other room are dark. A lit room's open doorways spill its
 * light into the corridor outside: each doorway is an analytic area light (no THREE light, 0 draw calls) of radiance
 * `k` × the 日光灯 irradiance (the lit room seen through it), sampled `nu` × `nv` points over the opening, Lambert at
 * both ends over d² (+ `core` so a face touching the opening does not blow up), cut off by `range`, and only on the
 * corridor side of the door and inside that corridor's rect (no light through the walls of the rooms across it).
 */
export const SPILL = { k: 0.8, core: 0.05, range: 9, nu: 3, nv: 3 };
/** A lit room (world rect, floor to ceiling) and its 日光灯 as ROOM_LAMP sample points (world; none in a one-fixture room, ONE_LAMP). */
export interface NightRoom { x0: number; x1: number; z0: number; z1: number; y0: number; y1: number; lamps: [number, number, number][] }
/**
 * An area light on a wall (a lit room's doorway, a corridor's end window), world: bottom centre `x, ey, z` on the face
 * it shines from, normal `nx, nz` into the space it lights, size `w` × `h`; it lights only `rect` between that storey's
 * floor `y` and ceiling `top`, in front of it.
 */
export interface DoorSpill { x: number; y: number; ey: number; z: number; nx: number; nz: number; w: number; h: number; top: number; rect: { x0: number; x1: number; z0: number; z1: number }; /** a 楼梯间转角窗 (not a corridor's end window) */ stair?: boolean;
  /** a lit room's doorway: that room's index in nightLight().rooms (its 日光灯 shine straight through it, doorBeam) */ room?: number }
/**
 * 走廊尽头窗的夜光 (旧办公楼④b2): with the corridor dark at night, its end window is the only light in it, the night
 * sky seen through the glass. Each glazed end window (an outer-wall window the corridor meets end-on) is an area light
 * of radiance `k` × the sky (intWinSky, main.ts syncWindowGlow: the hemisphere sky colour, faded in as the night
 * comes), the same maths as SPILL, cut off by `range`. Only buildings with `nightRooms` (elsewhere the corridors are
 * lit, or nobody is in them).
 */
export const WIN_GLOW = { k: 2.4, core: 0.1, range: 8, nu: 3, nv: 3 };
/** The sky's radiance through the end window, × the hemisphere sky colour (its intensity is for the open ground, not a pane seen from a dark room). */
export const WIN_SKY = 3.6;
/**
 * 端窗外的路灯 (打磨批次③①): a 路灯 outside an end window lights the pane warm. Per window, from the lamps in front of
 * it (beyond the glass, within `range` in plan): Σ cos(the lamp off the pane's outward normal) / (d² + core), d the 3D
 * distance pane centre → lamp head, × `k`, saturated to `max` (1 - e^-x: a lamp right outside cannot outshine a 日光灯).
 * Its light comes in along `dir` (lamp → pane, the lamps' mean): a lamp below the window throws it up onto the
 * ceiling, one above onto the floor, `bias` of it everywhere (the glass and the room scatter some). Radiance through
 * the pane = that × `color` × `level` × the lamps' on (intWinLamp, syncInteriorLight). `color` is a deeper sodium than
 * the outdoor LAMP_COLOR: through the glass, against the dark corridor, the pale one reads grey.
 */
export const WIN_LAMP = { k: 260, core: 4, range: 30, max: 1.6, level: 1.1, bias: 0.15, color: new THREE.Color(0xff7a2e) };
/** The lamp factor `f` (WIN_LAMP, before × colour × on) of an end window `w` from lamp heads `lamps` (x, z) at heights `hs`, and the unit direction its light comes in along. Pure. */
export function windowLampFactor(w: DoorSpill, lamps: readonly (readonly [number, number])[], hs: readonly number[]): { f: number; dir: [number, number, number] } {
  const cx = w.x, cy = w.ey + w.h / 2, cz = w.z, dir: [number, number, number] = [-w.nx, 0, -w.nz];
  let x = 0, sx = 0, sy = 0, sz = 0;
  lamps.forEach(([lx, lz], i) => {
    // outward = -n (n faces into the corridor)
    const dx = lx - cx, dy = hs[i] - cy, dz = lz - cz, out = -(dx * w.nx + dz * w.nz), plan = Math.hypot(dx, dz);
    if (out <= 0.1 || plan > WIN_LAMP.range) return;
    const d2 = plan * plan + dy * dy, d = Math.sqrt(d2), e = WIN_LAMP.k * (out / d) / (d2 + WIN_LAMP.core);
    x += e; sx -= e * dx / d; sy -= e * dy / d; sz -= e * dz / d;
  });
  const l = Math.hypot(sx, sy, sz);
  return { f: WIN_LAMP.max * (1 - Math.exp(-x / WIN_LAMP.max)), dir: l > 0 ? [sx / l, sy / l, sz / l] : dir };
}
/** windowLampFactor of every end window of `b` (nightLight order) against the campus lamps. */
export const windowLamps = (b: BuildingDef) => (nightLight(b)?.windows ?? []).map(w => windowLampFactor(w, lampPositions(), lampHeights()));
/** null = no nightRooms: every room lit while the windows are (晚自习). */
export function nightLight(b: BuildingDef): { rooms: NightRoom[]; spills: DoorSpill[]; windows: DoorSpill[] } | null {
  if (!b.nightRooms) return null;
  const rooms: NightRoom[] = [], spills: DoorSpill[] = [], windows: DoorSpill[] = [];
  for (const k of b.nightRooms) {
    const { level, id } = parseNightRoom(k), st = floorStack(b).find(s => s.level === level)!;
    const all = storeyRooms(b, level), r = all.find(q => q.id === id)!, R = rectOf(r);
    const top = st.y + st.h - STAIR.slab, ri = rooms.length;
    // its 日光灯 (lampsAndFans' lattice, as drawn): ROOM_LAMP.n points along each tube, at the tube's middle height
    const ty = -DESK.lamp.tube.h / 2, lamps = (b.nightTube ?? 1) < 1 ? [] : lampsAndFans(r, st.y, st.h, 0).lamps.flatMap(l => Array.from({ length: ROOM_LAMP.n },
      (_, i): [number, number, number] => [b.x + (l.x0 + l.x1) / 2 + ((i + 0.5) / ROOM_LAMP.n - 0.5) * TUBE.len, l.y0 + ty, b.z + (l.z0 + l.z1) / 2]));
    rooms.push({ x0: b.x + R.x0, x1: b.x + R.x1, z0: b.z + R.z0, z1: b.z + R.z1, y0: st.y, y1: top, lamps });
    for (const d of r.doors ?? []) {
      const sg = d.side[0] === '+' ? 1 : -1, ax = d.side[1] === 'x';
      const nx = ax ? sg : 0, nz = ax ? 0 : sg;
      const edge = ax ? (sg > 0 ? R.x1 : R.x0) : (sg > 0 ? R.z1 : R.z0), face = edge + sg * PART.t / 2;
      const lx = ax ? face : r.x + d.at, lz = ax ? r.z + d.at : face;
      // the corridor the door opens onto (a door onto anything else spills nowhere)
      const c = all.find(q => q.kind === 'corridor' && Math.abs(lx + nx * 0.3 - q.x) < q.w / 2 && Math.abs(lz + nz * 0.3 - q.z) < q.d / 2);
      if (!c) continue;
      const C = rectOf(c);
      spills.push({ x: b.x + lx, y: st.y, ey: st.y, z: b.z + lz, nx, nz, w: d.width, h: d.height ?? PART.door.height, top,
        rect: { x0: b.x + C.x0, x1: b.x + C.x1, z0: b.z + C.z0, z1: b.z + C.z1 }, room: ri });
    }
  }
  // the corridors' end windows, every storey: the wall a corridor runs into, the window inside its width
  const ops = facadeOpenings(b).filter(o => o.kind === 'window' && !o.stair);
  for (const st of floorStack(b)) if (st.level > 0) for (const c of storeyRooms(b, st.level).filter(q => q.kind === 'corridor')) {
    const C = rectOf(c), alongX = c.w >= c.d;
    for (const o of ops) {
      if (o.y0 < st.y || o.y0 >= st.y + st.h || (o.side[1] === 'x') !== alongX) continue;
      const sg = o.side[0] === '+' ? 1 : -1, ax = o.side[1] === 'x';
      const face = sg * ((ax ? b.w : b.d) / 2 - WALL_T);
      if ((ax ? (sg > 0 ? C.x1 : C.x0) : (sg > 0 ? C.z1 : C.z0)) * sg < face * sg - 0.05) continue;
      const [a0, a1] = ax ? [C.z0, C.z1] : [C.x0, C.x1];
      if (o.u0 < a0 - 1e-6 || o.u1 > a1 + 1e-6) continue;
      const um = (o.u0 + o.u1) / 2;
      windows.push({ x: b.x + (ax ? face : um), y: st.y, ey: o.y0 + FRAME_W, z: b.z + (ax ? um : face), nx: ax ? -sg : 0, nz: ax ? 0 : -sg,
        w: o.u1 - o.u0 - 2 * FRAME_W, h: o.y1 - o.y0 - 2 * FRAME_W, top: st.y + st.h - STAIR.slab,
        rect: { x0: b.x + C.x0, x1: b.x + C.x1, z0: b.z + C.z0, z1: b.z + C.z1 } });
    }
  }
  // 楼梯间转角窗 (关灯的楼): the window over each 休息平台 lights its stairwell (clear rect), from the 楼层平台 below it
  // to the one above, so the treads and the 扶手 read by the sky and the 路灯 outside while the 声控灯 is off
  const plans = stairPlans(b);
  for (const o of facadeOpenings(b).filter(q => q.kind === 'window' && q.stair)) {
    const p = plans.find(q => q.def.id === o.stair);
    if (!p) continue;
    const sg = o.side[0] === '+' ? 1 : -1, ax = o.side[1] === 'x', c = p.clear;
    const face = sg * ((ax ? b.w : b.d) / 2 - WALL_T), um = (o.u0 + o.u1) / 2;
    windows.push({ x: b.x + (ax ? face : um), y: o.y0 - STAIR_WIN.below, ey: o.y0 + FRAME_W, z: b.z + (ax ? um : face), nx: ax ? -sg : 0, nz: ax ? 0 : -sg,
      w: o.u1 - o.u0 - 2 * FRAME_W, h: o.y1 - o.y0 - 2 * FRAME_W, top: o.y1 + STAIR_WIN.above,
      rect: { x0: b.x + c.x0, x1: b.x + c.x1, z0: b.z + c.z0, z1: b.z + c.z1 }, stair: true });
  }
  return { rooms, spills, windows };
}
/**
 * 灯下明暗 (OFF·语文组夜里): at night a lit nightRoom is not flat-lit. Each of its 日光灯 is `n` point lights along the
 * tube (NightRoom.lamps), under a housing: full strength straight down, `up` of it sideways and up (emit = up + (1 − up)
 * × the cosine below), Lambert on the receiving face over d² + `core`, × `k`; + `bounce` (the whitewash, the desks). So
 * the desk tops under a fixture are the brightest, the corners, the walls over the tubes and the ceiling sink. The
 * room's light is `warm` (an old tube against yellowed whitewash and wood), and so is what comes out of its door. By
 * day (阴雨天, intDayShare) a lit room is still the flat, cold one: the windows light it too.
 */
export const ROOM_LAMP = { n: 3, k: 1.5, core: 0.3, up: 0.12, bounce: 0.22, warm: new THREE.Color(1, 0.89, 0.73) };
/**
 * 门里漏出来的光: the same tubes seen straight through a lit room's open doorway (DoorSpill.room) light a sharp-edged
 * patch of the corridor floor and the wall across it, the hole's both faces (the 隔墙 is PART.t thick) as the stop,
 * edges `soft` (m) wide; on top of SPILL's soft glow. The leaf (opened into the room) is not in the way. Only within
 * `reach` (m) of the doorway along the corridor (ceiling tubes through a door 2.1 m high land within ~3 m of it).
 */
export const BEAM = { k: 12, soft: 0.04, reach: 6 };
/** One ROOM_LAMP point `l`'s light at `p`, normal `n` (before × k). Mirrors the shader. */
const lampTerm = (l: readonly number[], p: readonly number[], n: readonly number[]) => {
  const d = [l[0] - p[0], l[1] - p[1], l[2] - p[2]], d2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2, len = Math.max(Math.sqrt(d2), 1e-4);
  return Math.max(0, (d[0] * n[0] + d[1] * n[1] + d[2] * n[2]) / len) * (ROOM_LAMP.up + (1 - ROOM_LAMP.up) * Math.max(0, d[1] / len)) / (d2 + ROOM_LAMP.core);
};
/** The 日光灯 factor at `p`, normal `n`, in lit room `r` at night (× intTube, in place of the flat face factor). Mirrors intRoomFall. */
export const roomLampFall = (r: NightRoom, p: readonly [number, number, number], n: readonly [number, number, number]) =>
  ROOM_LAMP.bounce + ROOM_LAMP.k * r.lamps.reduce((s, l) => s + lampTerm(l, p, n), 0);
/** How much of doorway `q` the segment p → l passes through (0..1, BEAM.soft edges), through both faces of the 隔墙. */
export function doorPass(q: DoorSpill, p: readonly number[], l: readonly number[]): number {
  const d = [l[0] - p[0], l[1] - p[1], l[2] - p[2]], dn = -(d[0] * q.nx + d[2] * q.nz);
  if (dn <= 1e-3) return 0;
  const o = (p[0] - q.x) * q.nx + (p[2] - q.z) * q.nz;
  let pass = 1;
  for (const t of [o / dn, (o + PART.t) / dn]) {
    if (t >= 1) return 0;
    const u = (p[0] + t * d[0] - q.x) * -q.nz + (p[2] + t * d[2] - q.z) * q.nx, v = p[1] + t * d[1] - q.ey;
    pass = Math.min(pass, Math.min(1, Math.max(0, Math.min(q.w / 2 - Math.abs(u), v, q.h - v) / BEAM.soft + 0.5)));
  }
  return pass;
}
/** Irradiance factor (× intTube × warm) at `p`, normal `n`, of the lit rooms' tubes straight through their doorways (the shader's intBeamAt). */
export function doorBeam(nl: { rooms: NightRoom[]; spills: DoorSpill[] }, p: readonly [number, number, number], n: readonly [number, number, number]): number {
  let s = 0;
  for (const q of nl.spills) {
    const r = q.rect;
    if (q.room === undefined || p[0] < r.x0 - 0.05 || p[0] > r.x1 + 0.05 || p[2] < r.z0 - 0.05 || p[2] > r.z1 + 0.05 || p[1] < q.y - 0.05 || p[1] > q.top + 0.05) continue;
    if ((p[0] - q.x) * q.nx + (p[2] - q.z) * q.nz < 0.01 || Math.abs((p[0] - q.x) * -q.nz + (p[2] - q.z) * q.nx) > BEAM.reach) continue;
    for (const l of nl.rooms[q.room].lamps) { const k = doorPass(q, p, l); if (k > 0) s += k * lampTerm(l, p, n); }
  }
  return BEAM.k * s;
}
/** 楼梯间转角窗's reach (m) below its sill and above its head: down to the 楼层平台 under it, up to the one over it. */
export const STAIR_WIN = { below: 2.6, above: 1.4 };
/**
 * 夜里只亮一盏灯 (锅炉房, campus.json `nightTube` < 1): its lit room hangs one 日光灯 (world/boiler.ts oneLamp), so the
 * room is not flat-lit: × `nightTube` and a point falloff from that fixture, (`core` + h²) / (`core` + d²) with h its
 * drop to the floor (1 on the floor under it), floored at `min` (the whitewash bounces some into the corners).
 */
export const ONE_LAMP = { core: 3, min: 0.2 };
/** World centre of the one fixture of a `nightTube` building's lit room and its height over the floor; null otherwise. */
export function oneLampAt(b: BuildingDef): { x: number; y: number; z: number; h: number } | null {
  if ((b.nightTube ?? 1) >= 1 || !b.nightRooms) return null;
  const { level, id } = parseNightRoom(b.nightRooms[0]), st = floorStack(b).find(s => s.level === level)!;
  const r = storeyRooms(b, level).find(q => q.id === id)!, k = oneLampBox(r, st.y, st.h, b.entrances?.[0]?.at ?? 0, 0);
  return { x: b.x + (k.x0 + k.x1) / 2, y: k.y0, z: b.z + (k.z0 + k.z1) / 2, h: k.y0 - st.y };
}
/** The ONE_LAMP factor at `p` (1 under the fixture, falling off). Mirrors the shader's intOneLamp. */
export function oneLampFall(l: { x: number; y: number; z: number; h: number }, p: readonly [number, number, number]): number {
  const d2 = (p[0] - l.x) ** 2 + (p[1] - l.y) ** 2 + (p[2] - l.z) ** 2;
  return Math.max(ONE_LAMP.min, Math.min(1.5, (ONE_LAMP.core + l.h * l.h) / (ONE_LAMP.core + d2)));
}
/** How far past its rect a lit room reaches: its half of the 隔墙 (the door jambs), not the wall's corridor face. */
const NIGHT_EDGE = PART.t / 2 - 0.01;
/** Whether `p` is inside a lit room (walls' inner faces and door jambs included, the corridor face of its partition not). */
export const inNightRoom = (rooms: NightRoom[], p: readonly [number, number, number]) => {
  const e = NIGHT_EDGE;
  return rooms.some(r => p[0] > r.x0 - e && p[0] < r.x1 + e && p[2] > r.z0 - e && p[2] < r.z1 + e && p[1] > r.y0 - 0.05 && p[1] < r.y1 + 0.05);
};
/** Irradiance factor at `p`, normal `n`, of area lights `qs` with constants `c` (SPILL, WIN_GLOW). Mirrors the shader. */
export function areaLight(qs: DoorSpill[], c: { k: number; core: number; range: number; nu: number; nv: number }, p: readonly [number, number, number], n: readonly [number, number, number]): number {
  let s = 0;
  for (const q of qs) {
    const r = q.rect;
    if (p[0] < r.x0 - 0.05 || p[0] > r.x1 + 0.05 || p[2] < r.z0 - 0.05 || p[2] > r.z1 + 0.05 || p[1] < q.y - 0.05 || p[1] > q.top + 0.05) continue;
    if ((p[0] - q.x) * q.nx + (p[2] - q.z) * q.nz < 0.01) continue;
    // along the opening: perpendicular to its normal in plan
    const tx = -q.nz, tz = q.nx, A = (q.w * q.h) / (c.nu * c.nv);
    for (let i = 0; i < c.nu; i++) for (let j = 0; j < c.nv; j++) {
      const u = ((i + 0.5) / c.nu - 0.5) * q.w, v = ((j + 0.5) / c.nv) * q.h;
      const d = [q.x + tx * u - p[0], q.ey + v - p[1], q.z + tz * u - p[2]], d2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2, len = Math.sqrt(d2) || 1;
      if (len > c.range) continue;
      const cosE = Math.max(0, -(d[0] * q.nx + d[2] * q.nz) / len), cosR = Math.max(0, (d[0] * n[0] + d[1] * n[1] + d[2] * n[2]) / len);
      s += c.k * A * cosE * cosR / (d2 + c.core);
    }
  }
  return s;
}
/** Irradiance factor (× intTube) at `p`, normal `n`, from the lit doorways (the shader's intSpillAt). */
export const doorSpill = (spills: DoorSpill[], p: readonly [number, number, number], n: readonly [number, number, number]) => areaLight(spills, SPILL, p, n);
/** Irradiance factor (× intWinSky) at `p`, normal `n`, from the corridors' end windows (the shader's intWinAt). */
export const windowGlow = (wins: DoorSpill[], p: readonly [number, number, number], n: readonly [number, number, number]) => areaLight(wins, WIN_GLOW, p, n);
/** GLSL: an end window's 路灯 weight along the ray e → p (`d` = e - p), WIN_LAMP; a literal 0.0 with no lamp outside. */
const lampW = (l: { f: number; dir: [number, number, number] }) => l.f < 1e-3 ? '0.0'
  : `${f(l.f * (1 - WIN_LAMP.bias))} * max(0.0, -dot(d, vec3(${l.dir.map(f).join(', ')})) / len) + ${f(l.f * WIN_LAMP.bias)}`;
/** GLSL: the sum of area lights `qs` (constants `c`) into `s`, at p with normal n (areaLight). */
const areaGlsl = (qs: DoorSpill[], c: { k: number; core: number; range: number; nu: number; nv: number }, lamp?: { f: number; dir: [number, number, number] }[]) => qs.map((q, qi) => `
          if (p.x > ${f(q.rect.x0 - 0.05)} && p.x < ${f(q.rect.x1 + 0.05)} && p.z > ${f(q.rect.z0 - 0.05)} && p.z < ${f(q.rect.z1 + 0.05)} && p.y > ${f(q.y - 0.05)} && p.y < ${f(q.top + 0.05)}
              && (p.x - ${f(q.x)}) * ${f(q.nx)} + (p.z - ${f(q.z)}) * ${f(q.nz)} > 0.01) {
            vec3 N = vec3(${f(q.nx)}, 0.0, ${f(q.nz)}), T = vec3(${f(-q.nz)}, 0.0, ${f(q.nx)});
            for (int i = 0; i < ${c.nu}; i++) for (int j = 0; j < ${c.nv}; j++) {
              vec3 e = vec3(${f(q.x)}, ${f(q.ey)}, ${f(q.z)}) + T * ((float(i) + 0.5) / ${f(c.nu)} - 0.5) * ${f(q.w)} + vec3(0.0, (float(j) + 0.5) / ${f(c.nv)} * ${f(q.h)}, 0.0);
              vec3 d = e - p;
              float d2 = dot(d, d), len = max(sqrt(d2), 1e-4);
              if (len > ${f(c.range)}) continue;
              s += ${f(c.k * (q.w * q.h) / (c.nu * c.nv))} * max(0.0, -dot(d, N) / len) * max(0.0, dot(d, n) / len) / (d2 + ${f(c.core)})${lamp ? ` * vec2(1.0, ${lampW(lamp[qi])})` : ''};
            }
          }`).join('');
/** GLSL: the lit rooms' 日光灯 (ROOM_LAMP) at p, n, and through their doorways (BEAM); rooms without tubes are left out. */
function roomLampGlsl(nl: { rooms: NightRoom[]; spills: DoorSpill[] }): string {
  const e = NIGHT_EDGE, L = ROOM_LAMP, at = (l: [number, number, number]) => `vec3(${l.map(f).join(', ')})`;
  const sum = (r: NightRoom, w: (l: string) => string = () => '') => r.lamps.map(l => `
            s += ${w(at(l))}intLampTerm(${at(l)}, p, n);`).join('');
  const rooms = nl.rooms.map(r => !r.lamps.length ? '' : `
          if (p.x > ${f(r.x0 - e)} && p.x < ${f(r.x1 + e)} && p.z > ${f(r.z0 - e)} && p.z < ${f(r.z1 + e)} && p.y > ${f(r.y0 - 0.05)} && p.y < ${f(r.y1 + 0.05)}) {
            float s = 0.0;${sum(r)}
            return ${f(L.bounce)} + ${f(L.k)} * s;
          }`).join('');
  const beams = nl.spills.map(q => q.room === undefined || !nl.rooms[q.room].lamps.length ? '' : `
          if (p.x > ${f(q.rect.x0 - 0.05)} && p.x < ${f(q.rect.x1 + 0.05)} && p.z > ${f(q.rect.z0 - 0.05)} && p.z < ${f(q.rect.z1 + 0.05)} && p.y > ${f(q.y - 0.05)} && p.y < ${f(q.top + 0.05)}
              && (p.x - ${f(q.x)}) * ${f(q.nx)} + (p.z - ${f(q.z)}) * ${f(q.nz)} > 0.01 && abs((p.x - ${f(q.x)}) * ${f(-q.nz)} + (p.z - ${f(q.z)}) * ${f(q.nx)}) < ${f(BEAM.reach)}) {
            vec4 Q = vec4(${f(q.x)}, ${f(q.ey)}, ${f(q.z)}, 0.0); vec4 S = vec4(${f(q.nx)}, ${f(q.nz)}, ${f(q.w)}, ${f(q.h)});${sum(nl.rooms[q.room], l => `intDoorPass(p, ${l}, Q, S) * `)}
          }`).join('');
  return `
        float intLampTerm(vec3 l, vec3 p, vec3 n) {
          vec3 d = l - p;
          float d2 = dot(d, d), len = max(sqrt(d2), 1e-4);
          return max(0.0, dot(d, n) / len) * (${f(L.up)} + ${f(1 - L.up)} * max(0.0, d.y / len)) / (d2 + ${f(L.core)});
        }
        // the lit room's 日光灯 factor at p (ROOM_LAMP, in place of the flat face factor), -1 outside every lit room
        float intRoomFall(vec3 p, vec3 n) {${rooms}
          return -1.0;
        }
        // how much of a doorway (bottom centre Q.xyz, normal S.xy, size S.zw) the segment p → l passes, both faces of the 隔墙
        float intDoorPass(vec3 p, vec3 l, vec4 Q, vec4 S) {
          vec3 d = l - p;
          float dn = -(d.x * S.x + d.z * S.y), o = (p.x - Q.x) * S.x + (p.z - Q.z) * S.y, pass = 1.0;
          if (dn <= 1e-3) return 0.0;
          for (int k = 0; k < 2; k++) {
            float t = (o + float(k) * ${f(PART.t)}) / dn;
            if (t >= 1.0) return 0.0;
            float u = (p.x + t * d.x - Q.x) * -S.y + (p.z + t * d.z - Q.z) * S.x, v = p.y + t * d.y - Q.y;
            pass = min(pass, clamp(min(S.z / 2.0 - abs(u), min(v, S.w - v)) / ${f(BEAM.soft)} + 0.5, 0.0, 1.0));
          }
          return pass;
        }
        // the lit rooms' tubes seen straight through their doorways (BEAM, × intTube × warm)
        float intBeamAt(vec3 p, vec3 n) {
          float s = 0.0;${beams}
          return ${f(BEAM.k)} * s;
        }`;
}
/**
 * 天台水箱间 (world/tankroom.ts): no window, so no indoor ambient from the facade; a dim bounce `deep` × the sky, and
 * the daylight through its open iron door: an area light (DoorSpill, the same maths as SPILL) of radiance `k` × the
 * hemisphere (sky and ground as seen out of the doorway), bright on the floor inside the door and the wall facing it,
 * the back corners dark. The sun is shut out.
 */
export const TANK_LIGHT = { deep: 0.7, k: 6, core: 0.4, range: 9, nu: 3, nv: 3, sky: 0.65 };
/** The 水箱间's doorway as an area light into its clear inside, or null. */
export function tankDoorLight(b: BuildingDef): DoorSpill | null {
  const r = tankInside(b);
  if (!r) return null;
  const d = r.door;
  return { x: d.x, y: r.y0, ey: r.y0, z: d.z, nx: d.nx, nz: d.nz, w: d.w, h: d.h, top: r.y1, rect: { x0: r.x0, x1: r.x1, z0: r.z0, z1: r.z1 } };
}
/** Irradiance factor (× the hemisphere) at `p`, normal `n`, from the 水箱间's doorway (the shader's intTankDoorAt). */
export const tankDoorGlow = (q: DoorSpill, p: readonly [number, number, number], n: readonly [number, number, number]) => areaLight([q], TANK_LIGHT, p, n);
/**
 * 水箱间's bare bulb (world/tankroom.ts tankBulb), at night: a 40 W 白炽灯泡 on its flex, no shade, warmer than the
 * 声控灯. An analytic point light like the 声控灯 (0 draw calls): `k` × Lambert / (d² + `core`), only inside the room;
 * the 灯头 and its flex shade what goes up (`cap`: cos of the angle from straight up; full light at and below level with
 * the bulb, fading to `up` of it by cap[1]), so the ceiling half a metre above does not burn out in rings while the
 * walls level with the bulb get all of it (a bare bulb, not a downlight), and `bounce` a flat fill off the whitewash everywhere in the room (the corners are not black); the bulb itself glows (`glow` × its radiance). Its radiance is `level` × `color` × how dark it
 * is (winNight of the sky light): whoever hides up here has it on, and from 18:10 on it is someone's.
 */
export const TANK_BULB = { k: 7.5, core: 0.6, up: 0.2, cap: [0, 0.7] as const, bounce: 0.15, level: 1, glow: 2.5, color: new THREE.Color(0xf2d2a2) };
/** Irradiance factor (× intTankBulb) at `p`, normal `n` (unit), from the bulb at `l`. Mirrors the shader's intTankBulbAt. */
export function tankBulbLight(l: { x: number; y: number; z: number }, p: readonly [number, number, number], n: readonly [number, number, number]): number {
  const d = [l.x - p[0], l.y - p[1], l.z - p[2]], d2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2, len = Math.sqrt(d2) || 1;
  const s = Math.min(1, Math.max(0, (-d[1] / len - TANK_BULB.cap[0]) / (TANK_BULB.cap[1] - TANK_BULB.cap[0])));
  const cap = 1 - (1 - TANK_BULB.up) * s * s * (3 - 2 * s);
  return TANK_BULB.bounce + TANK_BULB.k * Math.max(0, (d[0] * n[0] + d[1] * n[1] + d[2] * n[2]) / len) * cap / (d2 + TANK_BULB.core);
}
/** GLSL: intInTank(p) (inside the 水箱间's clear rect), intTankDoorAt(p, n), intTankBulbAt(p, n) and intOnTankBulb(p). */
/**
 * 无窗空间 (地下室 below y −0.1, the 体育馆 器材室 under its 吊顶): no window, so their light does not follow the time of
 * day or the weather: a flat ambient fixed at a clear 10:00's hemisphere (sky and ground mixed as indoors) × BASEMENT.ambient,
 * no sun bounce, no window glow, and their 日光灯 on day and night. Pure.
 */
export const SEALED_AMBIENT = (() => {
  const s = sampleTimeOfDay(10 * 60), c = new THREE.Color().setRGB(...s.hemiGround).lerp(new THREE.Color().setRGB(...s.hemiSky), 0.6);
  return c.multiplyScalar(s.hemiIntensity * BASEMENT.ambient);
})();
/**
 * 暗室 (world/oldlab.ts darkRoom, 旧实验楼 1F): the window boarded over, so nothing from the facade, the sun or the
 * 日光灯 (it has none); a near-black bounce `deep` × the hemisphere, the corridor's daylight through its door (an
 * area light like the 水箱间's, `door` × the hemisphere, the 遮光帘 pulled aside) and the 安全灯: a small red point
 * light, `k` / (d² + `lampCore`), Lambert, hooded (`up` of it toward the ceiling), soft cut at `reach` (m), always on. The 湿台 and the 显影盘 under it read in
 * red, the far corners and the door wall sink into the dark.
 */
export const DARKROOM = { deep: 0.08, door: 1.4, core: 0.3, range: 6, nu: 3, nv: 3, sky: 0.6, k: 4.5, up: 0.25, lampCore: 0.12, reach: 3.6, glow: 1.6, color: new THREE.Color(0.6, 0.12, 0.06) };
const darkDoors = (b: BuildingDef): DoorSpill[] => darkroomLights(b).map(q => ({ ...q.door, y: q.y0, ey: q.y0, top: q.y1, rect: q.rect }));
/** Irradiance factor (× DARKROOM.color) at `p`, normal `n` (unit), from the 安全灯 at `l`. Mirrors the shader's intSafeAt. */
export function safelightLight(l: { x: number; y: number; z: number }, p: readonly [number, number, number], n: readonly [number, number, number]): number {
  const d = [l.x - p[0], l.y - p[1], l.z - p[2]], d2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2, len = Math.sqrt(d2) || 1;
  const cut = Math.min(1, Math.max(0, (DARKROOM.reach - len) / 1.2));
  // the black case hoods it: full strength below, `up` toward the ceiling
  const hood = DARKROOM.up + (1 - DARKROOM.up) * Math.max(0, d[1] / len);
  return DARKROOM.k * Math.max(0, (d[0] * n[0] + d[1] * n[1] + d[2] * n[2]) / len) * hood * cut / (d2 + DARKROOM.lampCore);
}
/** Irradiance factor (× the hemisphere) at `p`, normal `n`, from the 暗室's doorway (the shader's intDarkDoorAt). */
export const darkDoorGlow = (b: BuildingDef, p: readonly [number, number, number], n: readonly [number, number, number]) => areaLight(darkDoors(b), { ...DARKROOM, k: DARKROOM.door }, p, n);
/** GLSL: intInDark(p), intDarkDoorAt(p, n), intSafeAt(p, n). */
function darkGlsl(b: BuildingDef): string {
  const qs = darkroomLights(b), e = 0.05;
  if (!qs.length) return `
        bool intInDark(vec3 p) { return false; }
        float intDarkDoorAt(vec3 p, vec3 n) { return 0.0; }
        float intSafeAt(vec3 p, vec3 n) { return 0.0; }`;
  const inside = qs.map(q => `(p.x > ${f(q.rect.x0 - e)} && p.x < ${f(q.rect.x1 + e)} && p.z > ${f(q.rect.z0 - e)} && p.z < ${f(q.rect.z1 + e)} && p.y > ${f(q.y0 - e)} && p.y < ${f(q.y1 - e)})`).join(' || ');
  const lamps = qs.map(q => `
          d = vec3(${f(q.safe.x)}, ${f(q.safe.y)}, ${f(q.safe.z)}) - p; d2 = dot(d, d); il = inversesqrt(max(d2, 1e-8));
          s += ${f(DARKROOM.k)} * max(0.0, dot(d, n) * il) * (${f(DARKROOM.up)} + ${f(1 - DARKROOM.up)} * max(0.0, d.y * il)) * clamp((${f(DARKROOM.reach)} - d2 * il) / 1.2, 0.0, 1.0) / (d2 + ${f(DARKROOM.lampCore)});`).join('');
  return `
        bool intInDark(vec3 p) { return ${inside}; }
        float intDarkDoorAt(vec3 p, vec3 n) {
          float s = 0.0;${areaGlsl(darkDoors(b), { ...DARKROOM, k: DARKROOM.door })}
          return s;
        }
        float intSafeAt(vec3 p, vec3 n) {
          vec3 d; float d2, il, s = 0.0;${lamps}
          return s;
        }`;
}
/**
 * 安全出口 灯箱 (world/stairfit.ts exitSigns): lit day and night, so in a dark building it is the one light by every
 * stairwell door; a small green point light at its face, Lambert on the receiving face and on its own front half
 * (nothing behind the wall), `k` / (d² + `core`), cut at `reach` (m): the door head, the jambs, a patch of floor.
 */
export const EXIT_LIGHT = { k: 1.2, core: 0.08, reach: 3.2, color: new THREE.Color(0.12, 0.4, 0.36) };
/** Irradiance factor (× EXIT_LIGHT.color) at `p`, normal `n`, from signs `es`. Mirrors the shader's intExitAt. */
export function exitLight(es: ExitSign[], p: readonly [number, number, number], n: readonly [number, number, number]): number {
  let s = 0;
  for (const e of es) {
    const d = [e.x - p[0], e.y - p[1], e.z - p[2]], d2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2, len = Math.sqrt(d2) || 1;
    if (len > EXIT_LIGHT.reach || (p[0] - e.x) * e.nx + (p[2] - e.z) * e.nz < -0.06 || p[1] < e.floor - 0.05) continue;
    const cut = Math.min(1, (EXIT_LIGHT.reach - len) / 0.8);
    s += EXIT_LIGHT.k * Math.max(0, (d[0] * n[0] + d[1] * n[1] + d[2] * n[2]) / len) * cut / (d2 + EXIT_LIGHT.core);
  }
  return s;
}
function exitGlsl(b: BuildingDef): string {
  const es = exitSigns(b), R = EXIT_LIGHT.reach;
  return `
        float intExitAt(vec3 p, vec3 n) {
          vec3 d; float d2, len, s = 0.0;${es.map(e => `
          d = vec3(${f(e.x)}, ${f(e.y)}, ${f(e.z)}) - p; d2 = dot(d, d);
          if (d2 < ${f(R * R)} && (p.x - ${f(e.x)}) * ${f(e.nx)} + (p.z - ${f(e.z)}) * ${f(e.nz)} > -0.06 && p.y > ${f(e.floor - 0.05)}) {
            len = sqrt(d2);
            s += ${f(EXIT_LIGHT.k)} * max(0.0, dot(d, n) / max(len, 1e-4)) * min(1.0, (${f(R)} - len) / 0.8) / (d2 + ${f(EXIT_LIGHT.core)});
          }`).join('')}
          return s;
        }`;
}
/** World boxes of the sealed rooms above ground (体育馆 器材室: inside its walls, floor to just over its 吊顶). */
export function sealedBoxes(b: BuildingDef): LBox[] {
  const out: LBox[] = [];
  for (const st of floorStack(b)) if (st.y >= 0) for (const r of storeyRooms(b, st.level)) {
    if (r.kind !== 'equip') continue;
    const c = equipCeiling(b, r, st.y);
    out.push({ x0: c.x0 + b.x, x1: c.x1 + b.x, y0: st.y, y1: c.y1, z0: c.z0 + b.z, z1: c.z1 + b.z });
  }
  return out;
}
/** Whether `p` (world) is in a sealed space: under ground, or in a sealedBoxes room. Mirrors the shader's intSealed. */
export const inSealed = (b: BuildingDef, p: [number, number, number]) => p[1] < -0.1 ||
  sealedBoxes(b).some(o => p[0] > o.x0 - 0.05 && p[0] < o.x1 + 0.05 && p[1] > o.y0 - 0.05 && p[1] < o.y1 + 0.05 && p[2] > o.z0 - 0.05 && p[2] < o.z1 + 0.05);
function sealedGlsl(b: BuildingDef): string {
  const e = 0.05, t = sealedBoxes(b).map(o => ` || (p.x > ${f(o.x0 - e)} && p.x < ${f(o.x1 + e)} && p.y > ${f(o.y0 - e)} && p.y < ${f(o.y1 + e)} && p.z > ${f(o.z0 - e)} && p.z < ${f(o.z1 + e)})`).join('');
  return `
        bool intSealed(vec3 p) { return p.y < -0.1${t}; }`;
}
function tankGlsl(b: BuildingDef): string {
  const q = tankDoorLight(b);
  if (!q) return `
        bool intInTank(vec3 p) { return false; }
        float intTankDoorAt(vec3 p, vec3 n) { return 0.0; }
        float intTankBulbAt(vec3 p, vec3 n) { return 0.0; }
        bool intOnTankBulb(vec3 p) { return false; }`;
  const r = q.rect, e = 0.05, l = tankInside(b)!.bulb;
  return `
        bool intInTank(vec3 p) { return p.x > ${f(r.x0 - e)} && p.x < ${f(r.x1 + e)} && p.z > ${f(r.z0 - e)} && p.z < ${f(r.z1 + e)} && p.y > ${f(q.y - e)} && p.y < ${f(q.top + e)}; }
        float intTankDoorAt(vec3 p, vec3 n) {
          float s = 0.0;${areaGlsl([q], TANK_LIGHT)}
          return s;
        }
        float intTankBulbAt(vec3 p, vec3 n) {
          vec3 d = vec3(${f(l.x)}, ${f(l.y)}, ${f(l.z)}) - p;
          float d2 = dot(d, d), il = inversesqrt(max(d2, 1e-8));
          float cap = 1.0 - ${f(1 - TANK_BULB.up)} * smoothstep(${f(TANK_BULB.cap[0])}, ${f(TANK_BULB.cap[1])}, -d.y * il);
          return ${f(TANK_BULB.bounce)} + ${f(TANK_BULB.k)} * max(0.0, dot(d, n) * il) * cap / (d2 + ${f(TANK_BULB.core)});
        }
        // the bulb's own faces (tankroom.ts: an enamel box 7 × 7 × 11 cm round tankBulb)
        bool intOnTankBulb(vec3 p) { vec3 d = abs(p - vec3(${f(l.x)}, ${f(l.y)}, ${f(l.z)})); return d.x < 0.045 && d.z < 0.045 && d.y < 0.06; }`;
}
/** GLSL of intNightLit(p) alone (1 = the 日光灯 at `p` are on when the tubes are): the vertex shader's 吊扇 need it too. */
function nightLitGlsl(b: BuildingDef): string {
  const nl = nightLight(b);
  if (!nl) return `
        uniform float intDayShare;
        float intNightLit(vec3 p) { return ${b.dayLit === false ? '1.0 - intDayShare' : '1.0'}; }
        float intOneLamp(vec3 p) { return 1.0; }`;
  // 阴雨天白天: every room on at the day's share, unless the building is not in use by day (dayLit false)
  const day = b.dayLit === false ? '0.0' : 'intDayShare';
  const e = NIGHT_EDGE, rooms = nl.rooms.map(r => `
          if (p.x > ${f(r.x0 - e)} && p.x < ${f(r.x1 + e)} && p.z > ${f(r.z0 - e)} && p.z < ${f(r.z1 + e)} && p.y > ${f(r.y0 - 0.05)} && p.y < ${f(r.y1 + 0.05)}) return 1.0;`).join('');
  const l = oneLampAt(b), one = l ? `
          float d2 = dot(p - vec3(${f(l.x)}, ${f(l.y)}, ${f(l.z)}), p - vec3(${f(l.x)}, ${f(l.y)}, ${f(l.z)}));
          return ${f(b.nightTube!)} * clamp(${f(ONE_LAMP.core + l.h * l.h)} / (${f(ONE_LAMP.core)} + d2), ${f(ONE_LAMP.min)}, 1.5);` : `
          return 1.0;`;
  return `
        uniform float intDayShare;
        float intNightLit(vec3 p) {${rooms}
          return ${day};
        }
        // the room's 日光灯 irradiance × this (ONE_LAMP): 1 but in a room with one fixture
        float intOneLamp(vec3 p) {${one}
        }`;
}
/** GLSL body of intNightLit(p), intSpillAt(p, n) and intWinAt(p, n). */
function nightGlsl(b: BuildingDef): string {
  const nl = nightLight(b);
  if (!nl) return `${nightLitGlsl(b)}
        float intRoomFall(vec3 p, vec3 n) { return -1.0; }
        float intBeamAt(vec3 p, vec3 n) { return 0.0; }
        float intSpillAt(vec3 p, vec3 n) { return 0.0; }
        vec2 intWinAt(vec3 p, vec3 n) { return vec2(0.0); }`;
  return `${nightLitGlsl(b)}${roomLampGlsl(nl)}
        float intSpillAt(vec3 p, vec3 n) {
          float s = 0.0;${areaGlsl(nl.spills, SPILL)}
          return s;
        }
        // x: × the sky (intWinSky), y: × the 路灯 outside each window (intWinLamp, WIN_LAMP)
        vec2 intWinAt(vec3 p, vec3 n) {
          vec2 s = vec2(0.0);${areaGlsl(nl.windows, WIN_GLOW, windowLamps(b))}
          return s;
        }`;
}
/** 声控灯 switch → its uniform (main.ts, every frame). */
export function syncStairLamp(u: InteriorLightUniforms, on: boolean): void {
  u.intStairLamp.value.copy(STAIR_LAMP_COLOR).multiplyScalar(on ? STAIR_LAMP_LEVEL : 0);
}
/** 日光灯 colour: the same cold white as a lit window from outside (render/facade.ts windowColor). */
export const TUBE_COLOR = new THREE.Color(0xdde2d2);
/** 日光灯 irradiance when fully on (× TUBE_COLOR, linear): a lit classroom at night is flat and as bright as a cloudy day. */
export const TUBE_LEVEL = 0.8;
/** 黑板灯 (world/classroom.ts DESK.boardLamp, the 黑板's face tagged surf.y = SURF_BOARD): extra irradiance on the
 *  slate × the 日光灯's (on with them), so at night the 黑板 is the brightest thing in the room, as under a real one */
export const BOARD_LAMP = 1.1;

const f = (v: number) => v.toFixed(4);
/** a colour × k as a GLSL vec3 literal (linear) */
const v3 = (c: THREE.Color, k = 1) => `vec3(${f(c.r * k)}, ${f(c.g * k)}, ${f(c.b * k)})`;

/** 书脊 painting (FurnBox.spine): runs SPINE.run m long of one book cloth colour (world/library.ts BOOKS' colours),
 *  books SPINE.book wide in a run, heights a share of the tier, some runs empty, a pale 书标 low on some spines */
export const SPINE = { run: 0.16, book: 0.035, h: [0.55, 0.93], gap: 0.08, label: 0.3 };
const SPINE_C = ['bookR', 'bookB', 'bookG', 'bookY', 'bookW', 'bookB', 'bookR', 'bookG'] as const;
function spineGlsl(): string {
  const cs = SPINE_C.map(k => v3(new THREE.Color(FURN_COLOR[k])));
  const pick = cs.map((c, i) => `${i ? 'else ' : ''}${i < cs.length - 1 ? `if (ci == ${i}u) ` : ''}bc = ${c};`).join(' ');
  return `{
          // surf.x = the tier's bottom y + 64 × a seed (a moving 密集架's: world/classroom.ts SPINE_SEED)
          float sk = floor((vIntSurfX + 32.0) / 64.0), sb = vIntSurfX - 64.0 * sk;
          float sh = vIntDado - 5.0, sy = vIntW.y - sb;
          // along the run: world z on an x-facing face, x on a z-facing one; the face's depth coordinate seeds the side
          bool fx = abs(vIntN.x) > 0.5;
          float su = fx ? vIntW.z : vIntW.x, sd = fx ? vIntW.x : vIntW.z;
          uint rn = uint(floor(mod(su, 256.0) / ${f(SPINE.run)})) * 1597334677u ^ uint(floor(sb * 7.0 + 64.0)) * 3812015801u ^ (sk > 0.5 ? uint(sk) * 2246822519u : uint(floor(sd * 3.0 + 512.0)) * 2654435761u);
          rn ^= rn >> 16; rn *= 2246822519u; rn ^= rn >> 13;
          float h1 = float(rn >> 8) / 16777216.0, h2 = fract(h1 * 13.7), h3 = fract(h1 * 71.3);
          vec3 bc; uint ci = (rn >> 3) % ${cs.length}u; ${pick}
          // each book of the run its own height and a touch lighter / darker; a thin dark line between books
          float bu = su / ${f(SPINE.book)}, bh = fract(sin(floor(bu) * 12.989 + h1 * 78.2) * 437.58);
          float top = sh * mix(${f(SPINE.h[0])}, ${f(SPINE.h[1])}, mix(h2, bh, 0.35));
          bc *= 0.9 + 0.18 * bh;
          float edge = smoothstep(0.0, 0.12, fract(bu)) * smoothstep(1.0, 0.88, fract(bu));
          bc *= mix(0.62, 1.0, edge);
          if (h3 < 0.5 && abs(sy - sh * ${f(SPINE.label)}) < 0.018) bc = mix(bc, vec3(0.75, 0.72, 0.64), 0.8);
          if (sy > top || h3 > ${f(1 - SPINE.gap)}) bc = ${v3(new THREE.Color(FURN_COLOR.shelfBack), 0.38)};
          diffuseColor.rgb *= bc;
        }`;
}
/**
 * 档案盒 spine (world/office.ts FurnBox.label, surf = (u + 2 × packed (width cm, height cm, seed), SURF_LABEL + v)):
 * a 标签 pasted on its upper part with a column of handwritten characters (dark ink, now and then red), now and then
 * yellowed or torn off (a pale glue patch left); a round 指孔 low on it. 作业本 pile (FurnBox.pile, surf = (pile height
 * + 10 for a `paper` batch, SURF_PILE + v)): the side shows the books' pale page edges between darker cover lines, a
 * batch of 卷子 its sheets' edges a few at a time; both fade to their mean colour once a line is finer than a pixel.
 */
export const LABEL = { hole: [0.2, 0.012], tag: [0.42, 0.88], margin: 0.011, ch: 0.017, gap: 0.004, stroke: 0.0022, torn: 0.15, old: 0.3 };
export const PILE = { book: 0.007, cover: 0.3, sheet: 0.0035, line: 0.62, fade: [0.45, 1.1] };
function decalGlsl(): string {
  const paper = v3(new THREE.Color(FURN_COLOR.paper), 0.9), ink = v3(new THREE.Color(FURN_COLOR.ink), 0.55), red = v3(new THREE.Color(FURN_COLOR.coverR), 0.75);
  return `{
          float foot = max(length(fwidth(vIntW)), 1e-5);
          if (vIntDado > ${f(SURF_LABEL - 0.5)}) {
            float dv = vIntDado - ${f(SURF_LABEL)}, pk = floor(vIntSurfX * 0.5), du = vIntSurfX - 2.0 * pk;
            float sw = mod(pk, 16.0) * 0.01, sh = mod(floor(pk / 16.0), 64.0) * 0.01, seed = floor(pk / 1024.0);
            float x = (du - 0.5) * sw, y = dv * sh;
            float hs = fract(sin(seed * 91.7 + sw * 311.0 + sh * 57.3) * 43758.5453), hs2 = fract(hs * 17.3), hs3 = fract(hs * 61.1);
            // 指孔: dark inside the box, a soft rim
            float hd = length(vec2(x, y - sh * ${f(LABEL.hole[0])})) - ${f(LABEL.hole[1])};
            diffuseColor.rgb *= mix(0.22, 1.0, smoothstep(-foot, foot, hd)) * mix(0.85, 1.0, smoothstep(0.0, 0.004, abs(hd)));
            // the 标签
            float tw = sw * 0.5 - ${f(LABEL.margin)}, t0 = sh * ${f(LABEL.tag[0])}, t1 = sh * ${f(LABEL.tag[1])};
            float inTag = step(abs(x), tw) * step(t0, y) * step(y, t1);
            if (inTag > 0.5) {
              if (hs < ${f(LABEL.torn)}) diffuseColor.rgb *= 1.08;
              else {
                vec3 pc = ${paper} * (hs2 < ${f(LABEL.old)} ? vec3(1.0, 0.93, 0.78) : vec3(1.0));
                // a column of characters from the top down, 2..6 of them; each a few strokes from its own hash
                float cy = (t1 - 0.01 - y) / ${f(LABEL.ch + LABEL.gap)}, ci = floor(cy), cf = fract(cy) * ${f((LABEL.ch + LABEL.gap) / LABEL.ch)};
                float n = 2.0 + floor(hs3 * 5.0), m = 0.0;
                if (cy > 0.0 && ci < n && cf < 1.0 && abs(x) < ${f(LABEL.ch / 2)}) {
                  vec2 c = vec2(x / ${f(LABEL.ch)} + 0.5, 1.0 - cf);
                  float hc = fract(sin(ci * 12.9898 + seed * 78.233 + sw * 7.0) * 43758.5453);
                  float sk = ${f(LABEL.stroke / LABEL.ch)} * max(1.0, foot / ${f(LABEL.stroke)});
                  for (int k = 0; k < 3; k++) {
                    float hk = fract(hc * (3.1 + float(k) * 5.7)), hk2 = fract(hk * 23.9);
                    float s = k == 1 ? abs(c.x - 0.15 - 0.7 * hk) : abs(c.y - 0.15 - 0.7 * hk - 0.1 * (c.x - 0.5) * (hk2 - 0.5));
                    m = max(m, 1.0 - smoothstep(sk * 0.5, sk, s));
                  }
                }
                vec3 ic = hs3 > 0.85 ? ${red} : ${ink};
                // characters finer than a pixel: their mean, a grey smudge down the label
                float far = smoothstep(${f(LABEL.stroke)}, ${f(LABEL.stroke * 4)}, foot);
                float cov = mix(m, step(0.0, cy) * step(ci, n - 1.0) * step(abs(x), ${f(LABEL.ch / 2)}) * 0.35, far);
                diffuseColor.rgb = mix(pc, ic, cov);
              }
            }
          } else {
            float dv = vIntDado - ${f(SURF_PILE)};
            bool sheets = vIntSurfX > 9.5;
            float y = dv * (sheets ? vIntSurfX - 10.0 : vIntSurfX), t = sheets ? ${f(PILE.sheet)} : ${f(PILE.book)};
            float fy = fract(y / t), fl = fwidth(y) / t;
            float hb = fract(sin(floor(y / t) * 12.9898 + vIntSurfX * 78.233) * 43758.5453);
            vec3 pc = ${paper} * (0.92 + 0.12 * hb);
            if (sheets) diffuseColor.rgb = pc * mix(mix(0.7, 1.0, smoothstep(0.0, 0.3, fy)), 0.9, smoothstep(${f(PILE.fade[0])}, ${f(PILE.fade[1])}, fl));
            else {
              // a 作业本: its cover (the vertex colour) at the bottom and top of it, the pages' pale edge between
              // (the cover darker where it bends round the book's edge, so a pile reads as books, not one block)
              float cv = step(fy, ${f(PILE.cover / 2)}) + step(${f(1 - PILE.cover / 2)}, fy);
              vec3 cc = diffuseColor.rgb * ${f(PILE.line)};
              diffuseColor.rgb = mix(mix(pc, cc, cv), mix(pc, cc, ${f(PILE.cover)}), smoothstep(${f(PILE.fade[0])}, ${f(PILE.fade[1])}, fl));
            }
          }
        }`;
}
/**
 * 机房 lights (world/netroom.ts FurnBox.glow): a 指示灯 (surf.y = -1) shows its own colour lit, a steady one
 * (phase ≥ 1) always, the rest blink on a hash of (time slot, phase) at GLOW.rate slots a second, on a share GLOW.on
 * of them, a dim ember when off; a 监控 quarter (surf.y = -2, phase = its camera) a cold grey picture with scanlines,
 * each camera its own brightness drifting slowly, now and then a bright roll bar running down it.
 */
const NET_FEED = NET.feed;
export const GLOW = { rate: 7, on: 0.6, led: 3, off: 0.15, feed: 0.32, scan: 260, roll: 0.35 };
function glowGlsl(): string {
  return `{
          float gp = vIntSurfX;
          if (vIntDado > -1.5) {
            // GLOW_LED
            float slot = floor(intTime * ${f(GLOW.rate)} * (0.6 + 0.8 * fract(gp * 7.3)) + gp * 977.0);
            float on = gp >= 1.0 ? 1.0 : step(1.0 - ${f(GLOW.on)}, fract(sin(slot * 12.9898 + gp * 78.233) * 43758.5453));
            vec3 lc = diffuseColor.rgb;
            diffuseColor.rgb = lc * mix(${f(GLOW.off)}, 1.0, on);
            totalEmissiveRadiance += lc * on * ${f(GLOW.led)};
          } else {
            float cam = floor(gp * 4.0);
            float lvl = ${f(GLOW.feed)} * (0.75 + 0.25 * sin(intTime * (0.3 + 0.17 * cam) + cam * 2.1));
            float scan = 0.82 + 0.18 * step(0.5, fract(vIntW.y * ${f(GLOW.scan)}));
            float roll = fract(-intTime * ${f(GLOW.roll)} + cam * 0.37 - vIntW.y * 9.0);
            float bar = smoothstep(0.92, 1.0, roll) * 0.35;
            // a corridor seen from the ceiling: a darker floor wedge narrowing to the far end, the walls either side
            float qy = fract(vIntW.y / ${f(NET_FEED.h)}), qu = fract((abs(vIntN.x) > 0.5 ? vIntW.z : vIntW.x) / ${f(NET_FEED.w)} + cam * 0.13);
            float floorK = step(qy, 0.55) * step(abs(qu - 0.5), 0.12 + 0.3 * (0.55 - qy));
            vec3 pc = vec3(0.5, 0.58, 0.55) * lvl * scan * (1.0 - 0.45 * floorK) + bar * vec3(0.3, 0.33, 0.32);
            diffuseColor.rgb = vec3(0.08, 0.1, 0.1);
            totalEmissiveRadiance += pc;
          }
        }`;
}
/** 墙裙 colour over the wall paint (linear, per channel): the shader multiplies the wall's vertex colour by it. */
const dadoTint = (hex: string) => { const d = new THREE.Color(hex), w = new THREE.Color(PAINT); return [d.r / w.r, d.g / w.g, d.b / w.b].map(f).join(', '); };

/**
 * GLSL for intDadoFloor: inside each stairwell's clear rect the 墙裙 follows the walking surface, as it is painted in a
 * real stair — level with the 楼层平台 at the door end, rising with flight 1 along its wall, level with the 休息平台
 * at the far end and coming back down with flight 2 (so h − the rise, mod a storey) along the other side wall.
 */
export function stairDado(b: BuildingDef): string {
  let out = '';
  for (const p of stairPlans(b)) {
    const st = p.storeys.find(s => s.flight1), f1 = st?.flight1;
    if (!st || !f1) continue;
    const ax = p.def.dir[1] === 'x', E = 0.03;
    const c = p.clear, o = p.at(0, 0), sg = p.def.dir[0] === '+' ? 1 : -1;
    const len = f1.steps * f1.run, vc = ax ? (c.z0 + c.z1) / 2 : (c.x0 + c.x1) / 2, side1 = f1.v0 < vc ? -1 : 1;
    const A = (ax ? 'q.x' : 'q.y'), Vv = (ax ? 'q.y' : 'q.x');
    out += `
          { vec2 q = p.xz - vec2(${f(b.x)}, ${f(b.z)});
            if (q.x > ${f(c.x0 - E)} && q.x < ${f(c.x1 + E)} && q.y > ${f(c.z0 - E)} && q.y < ${f(c.z1 + E)}) {
              float a = ${f(sg)} * (${A} - ${f(ax ? o.x : o.z)});
              float r = clamp((a - ${f(f1.a)}) / ${f(len)}, 0.0, 1.0) * ${f(st.h / 2)};
              return ${f(side1)} * (${Vv} - ${f(vc)}) > 0.0 ? r : (a < ${f(f1.a)} ? 0.0 : ${f(st.h)} - r);
            } }`;
  }
  return out;
}

/**
 * The sun through a window (intSunSees v): its chroma fades with v, so a patch's penumbra (and a furniture shadow's
 * soft edge) is a dimmer grey, not a ring the palette search snaps to the warm darks (act1 #6e4535 / #5e4a24 sit
 * between the mid greys): the 16:30 / 17:40 patches had an orange outline.
 */
const SUN_RIM = '{ float intV = intSunSees(vIntW, intSunDir); directLight.color = mix(vec3(dot(directLight.color, vec3(0.2126, 0.7152, 0.0722))), directLight.color, intV * intV) * intV; }';

/** Build the interior material of one hollow building (its own geometry uniforms, the shared time-of-day ones). */
export function interiorLightMaterial(b: BuildingDef, u: InteriorLightUniforms): THREE.MeshLambertMaterial {
  const g = interiorLightGeo(b), m = g.mask, dado = b.dado ?? DADO.color;
  const tex = new THREE.DataTexture(m.data, m.width, m.rows * m.bands, THREE.RedFormat, THREE.UnsignedByteType);
  // bilinear: the tent below reads between texels (no mipmaps; the band is clamped in the shader)
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  const fm = g.furn, ftex = new THREE.DataTexture(fm.data, fm.width, fm.rows * fm.bands, THREE.RedFormat, THREE.UnsignedByteType);
  ftex.minFilter = ftex.magFilter = THREE.LinearFilter;
  ftex.unpackAlignment = 1;
  ftex.needsUpdate = true;
  if (g.occ.length > MAX_OCC) throw new Error(`${b.id}: ${g.occ.length} light occluders > MAX_OCC ${MAX_OCC}`);
  const pad = Array.from({ length: MAX_OCC }, (_, i) => g.occ[i]);
  const lamps = lampLights(b);
  if (lamps.length > LAMP_LIGHT.max) throw new Error(`${b.id}: ${lamps.length} 声控灯 > LAMP_LIGHT.max ${LAMP_LIGHT.max}`);
  const lampPad = Array.from({ length: LAMP_LIGHT.max }, (_, i) => lamps[i]);
  const own = {
    intMask: { value: tex },
    intMaskInfo: { value: new THREE.Vector4(m.width, m.rows, m.half, m.res) },
    intBox: { value: new THREE.Vector4(g.cx, g.cz, g.hw, g.hd) },
    // 天井 void (world centre, half size); hw < 0 = none
    intCourt: { value: g.court ? new THREE.Vector4(g.court.cx, g.court.cz, g.court.hw, g.court.hd) : new THREE.Vector4(0, 0, -1, -1) },
    intOccMin: { value: pad.map(o => (o ? new THREE.Vector3(o.x0, o.y0, o.z0) : new THREE.Vector3())) },
    intOccMax: { value: pad.map(o => (o ? new THREE.Vector3(o.x1, o.y1, o.z1) : new THREE.Vector3())) },
    // storey-relative boxes (OccBox.rel) as negative masks
    intOccL: { value: pad.map(o => (o ? (o.rel ? -o.levels : o.levels) : 0)) },
    intOccN: { value: g.occ.length },
    // 家具挡光 (furnMap): the height map, (width, rows, res, scale), (x0, z0, tallest top)
    intFurn: { value: ftex },
    intFurnInfo: { value: new THREE.Vector4(fm.width, fm.rows, fm.res, fm.scale) },
    intFurnO: { value: new THREE.Vector3(fm.x0, fm.z0, fm.max) },
    // 声控灯 bulbs (lampLights): position, stairwell clear rect (x0, z0, x1, z1), storey floor + height
    intLampPos: { value: lampPad.map(l => (l ? new THREE.Vector3(l.x, l.y, l.z) : new THREE.Vector3())) },
    intLampRect: { value: lampPad.map(l => (l ? new THREE.Vector4(l.rect.x0, l.rect.z0, l.rect.x1, l.rect.z1) : new THREE.Vector4())) },
    intLampY: { value: lampPad.map(l => (l ? new THREE.Vector2(l.floor, l.h) : new THREE.Vector2())) },
    intLampN: { value: lamps.length },
  };
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  mat.userData.noSnow = true;
  // this building's own uniforms (e2e: interior_light.spec takes the 家具挡光 out through intFurnO.z)
  mat.userData.intOwn = own;
  mat.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, u, own);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec2 surf; varying vec3 vIntW; varying vec3 vIntN; varying float vIntDado; varying float vIntSurfX;
        uniform float intFanAng;${nightLitGlsl(b)}`)
      // 吊扇 (world/classroom.ts FurnBox.fan, surf = (axis x, SURF_FAN - axis z)): blades and motor turned about the
      // axis by intFanAng where the room's 日光灯 are on (the one lit room at night; every room by 晚自习 light)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        bool intFan = surf.y < -500.0;
        vec2 intFanC = intFan ? vec2(surf.x, ${f(SURF_FAN)} - surf.y) : vec2(0.0);
        float intFanA = intFan ? intFanAng * intNightLit(vec3(intFanC.x, position.y, intFanC.y)) : 0.0;
        mat2 intFanR = mat2(cos(intFanA), sin(intFanA), -sin(intFanA), cos(intFanA));
        objectNormal.xz = intFanR * objectNormal.xz;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        transformed.xz = intFanC + intFanR * (transformed.xz - intFanC);`)
      .replace('#include <project_vertex>', `#include <project_vertex>
        vIntDado = intFan ? 0.0 : surf.y; vIntSurfX = intFan ? 0.0 : surf.x;
        vIntW = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vIntN = normalize(mat3(modelMatrix) * objectNormal);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vIntW; varying vec3 vIntN; varying float vIntDado; varying float vIntSurfX;
        uniform vec3 intSunDir; uniform vec3 intSunC; uniform vec3 intTube; uniform vec3 intStairLamp; uniform vec3 intWinSky; uniform vec3 intWinLamp; uniform vec3 intTankBulb; uniform vec3 intNightAmb; uniform vec4 intOut; uniform float intOutFloor; uniform vec4 intEye; uniform float intTime; uniform float intDayAmb;
        uniform vec4 intLandmark; uniform vec4 intLandmarkRect; uniform vec2 intLandmarkY; uniform vec2 intLandmarkAxis;
        uniform sampler2D intMask; uniform vec4 intMaskInfo; uniform vec4 intBox; uniform vec4 intCourt;
        uniform vec3 intOccMin[${MAX_OCC}]; uniform vec3 intOccMax[${MAX_OCC}]; uniform float intOccL[${MAX_OCC}]; uniform int intOccN;
        uniform sampler2D intFurn; uniform vec4 intFurnInfo; uniform vec3 intFurnO;
        uniform vec3 intLampPos[${LAMP_LIGHT.max}]; uniform vec4 intLampRect[${LAMP_LIGHT.max}]; uniform vec2 intLampY[${LAMP_LIGHT.max}]; uniform int intLampN;
        // the floor the 墙裙 is measured from, mod a storey: 0, or in a stairwell the flight / landing below (stairDado)
        float intDadoFloor(vec3 p) {${stairDado(b)}
          return 0.0;
        }
        // 白瓷砖 (world/interior.ts TILE): the share of a pixel not on a 格缝, box-filtered over its footprint dw (a
        // joint finer than a pixel greys the tile a little instead of shimmering), × k on the joints; tiles square from
        // the storey floor on a side face, on the world grid on a top
        float intGrout(vec3 p, vec3 n, vec3 dw) {
          float fy = floor((p.y + 0.05) / ${f(g.storey)}) * ${f(g.storey)}, N = ${f(TILE.size / TILE.joint)};
          bool sx = abs(n.x) > 0.5, up = abs(n.y) > 0.5;
          vec2 c = (up ? p.xz : vec2(sx ? p.z : p.x, p.y - fy)) * ${f(1 / TILE.size)} + 0.5 / N;
          vec2 w = (up ? dw.xz : vec2(sx ? dw.z : dw.x, dw.y)) * ${f(1 / TILE.size)} + 0.001;
          vec2 a = c + 0.5 * w, d = c - 0.5 * w;
          vec2 i = (floor(a) + min(fract(a) * N, 1.0) - floor(d) - min(fract(d) * N, 1.0)) / (N * w);
          return mix(${f(TILE.k)}, 1.0, (1.0 - i.x) * (1.0 - i.y));
        }
        bool intTiled(vec3 p) { return false${tiledRects(b).map(o => ` || (p.x > ${f(o.x0 - 0.05)} && p.x < ${f(o.x1 + 0.05)} && p.z > ${f(o.z0 - 0.05)} && p.z < ${f(o.z1 + 0.05)} && p.y > ${f(o.y0 - 0.05)} && p.y < ${f(o.y1)})`).join('')}; }
        float intCeil(float y) { return (floor((y + 0.05) / ${f(g.storey)}) + 1.0) * ${f(g.storey)} - ${f(g.slab)}; }
        // bilinear mask read (LinearFilter), clamped to the side's band so neighbouring bands never bleed in
        float intMaskAt(int side, float u, float y) {
          vec2 c = vec2(clamp((u + intMaskInfo.z) / intMaskInfo.w, 0.5, intMaskInfo.x - 0.5), clamp(y / intMaskInfo.w, 0.5, intMaskInfo.y - 0.5));
          return texture2D(intMask, vec2(c.x / intMaskInfo.x, (float(side) * intMaskInfo.y + c.y) / (${f(m.bands)} * intMaskInfo.y))).r;
        }
        // the mask through a 3×3 tent of width w on the window plane (maskSoft)
        float intMaskSoft(int side, float u, float y, float w) {
          float s = 0.0;
          for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++)
            s += (i == 0 ? 0.5 : 0.25) * (j == 0 ? 0.5 : 0.25) * intMaskAt(side, u + 0.5 * w * float(i), y + 0.5 * w * float(j));
          return s;
        }
        // 家具挡光: a storey's furniture top (m above its floor), bilinear, clamped to its band (furnAt)
        float intFurnAt(float band, vec2 xz) {
          vec2 c = clamp((xz - intFurnO.xy) / intFurnInfo.z, vec2(0.5), intFurnInfo.xy - 0.5);
          return texture2D(intFurn, vec2(c.x / intFurnInfo.x, (band * intFurnInfo.y + c.y) / (${f(fm.bands)} * intFurnInfo.y))).r * intFurnInfo.w;
        }
        // share of the ray the furniture blocks before the window, t on: marched across the height map (furnShade)
        float intFurnShade(vec3 p, vec3 L, float si, float t) {
          float lh = length(L.xz);
          if (intFurnO.z <= 0.0 || si < 0.0 || si > ${f(fm.bands - 0.5)} || lh < 1e-4) return 0.0;
          vec2 d = L.xz / lh;
          float k = L.y / lh, y = p.y - si * ${f(g.storey)};
          float reach = min(t * lh, (intFurnO.z - y) / k);
          if (reach <= ${f(FURN_SHADE.start)}) return 0.0;
          float dr = max(${f(FURN_SHADE.minStep)}, (reach - ${f(FURN_SHADE.start)}) / ${f(FURN_SHADE.steps - 1)}), s = 0.0;
          for (int i = 0; i < ${FURN_SHADE.steps}; i++) {
            float r = ${f(FURN_SHADE.start)} + dr * float(i);
            if (r > reach || s >= 1.0) break;
            s = max(s, clamp((intFurnAt(si, p.xz + d * r) - y - k * r - ${f(FURN_SHADE.bias)}) / ${f(FURN_SHADE.soft)}, 0.0, 1.0));
          }
          return s;
        }
        // 天台水箱间: its clear inside and the daylight through its door (tankGlsl)${tankGlsl(b)}
        // 暗室 (darkGlsl)${darkGlsl(b)}
        // 安全出口 灯箱 (exitGlsl)${exitGlsl(b)}
        // 无窗空间 (sealedGlsl)${sealedGlsl(b)}
        // this fragment's footprint (m), set in main before the light loop: screen derivatives must not sit behind a branch
        float intFoot;
        // sun through a window, 0..1 soft at the patch edges (interior_light.ts sunLight is the same test)
        float intSunSees(vec3 p, vec3 L) {
          if (L.y <= 0.01 || p.y < -0.1 || dot(vIntN, L) <= 0.0 || intInTank(p) || intInDark(p)) return 0.0;
          vec2 rel = p.xz - intBox.xy, sg = vec2(L.x >= 0.0 ? 1.0 : -1.0, L.z >= 0.0 ? 1.0 : -1.0);
          vec2 inner = intBox.zw - ${f(g.wall)};
          float tx = abs(L.x) > 1e-4 ? (sg.x * inner.x - rel.x) / L.x : 1e9;
          float tz = abs(L.z) > 1e-4 ? (sg.y * inner.y - rel.y) / L.z : 1e9;
          bool xs = tx < tz;
          float t = xs ? tx : tz;
          float tOut = xs ? (sg.x * intBox.z - rel.x) / L.x : (sg.y * intBox.w - rel.y) / L.z;
          int side = xs ? (sg.x > 0.0 ? 0 : 1) : (sg.y > 0.0 ? 2 : 3);
          float sky = 1.0;
          if (intCourt.z > 0.0) {
            // 天井: a ray that meets the void goes out through the wall facing the sun and across, over the far parapet
            vec2 q = p.xz - intCourt.xy, o = intCourt.zw + ${f(g.wall)};
            float ax = abs(L.x) > 1e-4 ? (-sg.x * o.x - q.x) / L.x : (abs(q.x) < o.x ? -1e9 : 1e9);
            float az = abs(L.z) > 1e-4 ? (-sg.y * o.y - q.y) / L.z : (abs(q.y) < o.y ? -1e9 : 1e9);
            float bx = abs(L.x) > 1e-4 ? (sg.x * o.x - q.x) / L.x : 1e9, bz = abs(L.z) > 1e-4 ? (sg.y * o.y - q.y) / L.z : 1e9;
            float tn = max(ax, az);
            if (tn < min(bx, bz) && tn > 0.0) {
              xs = ax > az; t = tn;
              tOut = xs ? (-sg.x * intCourt.z - q.x) / L.x : (-sg.y * intCourt.w - q.y) / L.z;
              side = 4 + (xs ? (sg.x > 0.0 ? 0 : 1) : (sg.y > 0.0 ? 2 : 3));
              rel = q;
              float ex = abs(L.x) > 1e-4 ? (sg.x * intCourt.z - q.x) / L.x : 1e9, ez = abs(L.z) > 1e-4 ? (sg.y * intCourt.w - q.y) / L.z : 1e9;
              sky = clamp((p.y + L.y * min(ex, ez) - ${f(g.court?.top ?? 0)}) / ${f(COURT_EDGE)} + 0.5, 0.0, 1.0);
              if (sky <= 0.0) return 0.0;
            }
          }
          float y0 = p.y + L.y * t, y1 = p.y + L.y * tOut;
          if (y0 > intCeil(p.y)) return 0.0;
          float u0 = xs ? rel.y + L.z * t : rel.x + L.x * t, u1 = xs ? rel.y + L.z * tOut : rel.x + L.x * tOut;
          // penumbra: wider the further the fragment is from the window, + its own footprint (no far-away stair-steps)
          float w = min(${f(PENUMBRA.max)}, ${f(PENUMBRA.base)} + ${f(PENUMBRA.perM)} * max(t, 0.0) + ${f(PENUMBRA.foot)} * intFoot);
          float through = sky * min(intMaskSoft(side, u0, y0, w), intMaskSoft(side, u1, y1, w));
          if (through <= 0.0) return 0.0;
          vec3 inv = 1.0 / vec3(abs(L.x) < 1e-5 ? 1e-5 : L.x, L.y, abs(L.z) < 1e-5 ? 1e-5 : L.z);
          // this storey's bit (storeyIndex): a wall stops the ray only on the storeys it stands on
          float si = floor((p.y + 0.05) / ${f(g.storey)}), bit = exp2(si);
          for (int i = 0; i < ${MAX_OCC}; i++) {
            if (i >= intOccN) break;
            // a negative mask: y from this storey's floor (a stair flight)
            float lv = intOccL[i];
            vec3 dy = vec3(0.0, lv < 0.0 ? si * ${f(g.storey)} : 0.0, 0.0);
            if (mod(floor(abs(lv) / bit), 2.0) < 0.5) continue;
            vec3 a = (intOccMin[i] + dy - p) * inv, c = (intOccMax[i] + dy - p) * inv;
            vec3 lo = min(a, c), hi = max(a, c);
            float tn = max(max(lo.x, lo.y), lo.z), tf = min(min(hi.x, hi.y), hi.z);
            if (tn < tf && tf > 0.02 && tn < t) return 0.0;
          }
          return through * (1.0 - intFurnShade(p, L, si, t));
        }
        // inside a 声控灯 stairwell (its clear rect): no 日光灯 there, the lamp is all the light it has at night
        bool intInLampStair(vec3 p) {
          for (int i = 0; i < ${LAMP_LIGHT.max}; i++) {
            if (i >= intLampN) break;
            vec4 r = intLampRect[i];
            if (p.x > r.x - 0.05 && p.x < r.z + 0.05 && p.z > r.y - 0.05 && p.z < r.w + 0.05) return true;
          }
          return false;
        }
        // 声控灯 irradiance factor (× intStairLamp) at p, normal n: interior_light.ts stairLampLight / lampReach
        float intLampAt(vec3 p, vec3 n) {
          float s = 0.0;
          for (int i = 0; i < ${LAMP_LIGHT.max}; i++) {
            if (i >= intLampN) break;
            vec4 r = intLampRect[i]; vec2 fy = intLampY[i];
            if (p.x < r.x - 0.05 || p.x > r.z + 0.05 || p.z < r.y - 0.05 || p.z > r.w + 0.05) continue;
            if (p.y > intLampPos[i].y + ${f(LAMP.h)} || (n.y > 0.5 && p.y > fy.x + fy.y * 0.5 - 0.02)) continue;
            float reach = smoothstep(fy.x - fy.y * 0.5 - ${f(LAMP_FADE)}, fy.x - fy.y * 0.5 + ${f(LAMP_FADE)}, p.y);
            vec3 d = intLampPos[i] - p;
            float d2 = dot(d, d), len = max(sqrt(d2), 1e-4);
            float bowl = ${f(LAMP_LIGHT.up)} + ${f(1 - LAMP_LIGHT.up)} * max(0.0, d.y / len);
            float cut = clamp((${f(LAMP_LIGHT.range)} - len) / 1.5, 0.0, 1.0);
            s += reach * ${f(LAMP_LIGHT.k)} * max(0.0, dot(d, n) / len) * bowl * cut / (d2 + ${f(LAMP_LIGHT.core)});
          }
          return s;
        }
        // 夜里只亮一间 (nightLight): whether this fragment's 日光灯 are on, and the light out of the lit rooms' doorways${nightGlsl(b)}
        // a ceiling 日光灯 under this fragment (0/1): tube grid on the underside of every storey's slab
        float intTubeAt(vec3 p) {
          if (${(b.nightTube ?? 1) < 1} || vIntN.y > -0.99 || abs(p.y - intCeil(p.y - 0.3)) > 0.03 || intInLampStair(p) || intInDark(p)) return 0.0;
          vec2 q = p.xz - intBox.xy;
          float fx = mod(q.x + ${f(TUBE.px / 2)}, ${f(TUBE.px)}) - ${f(TUBE.px / 2)};
          float fz = mod(q.y + ${f(TUBE.pz / 2)}, ${f(TUBE.pz)}) - ${f(TUBE.pz / 2)};
          return step(abs(fx), ${f(TUBE.len / 2)}) * step(abs(fz), ${f(TUBE.w / 2)});
        }
        // 跳闸 (intOut): 1 where the tubes still burn, 0 inside the dying radius around intOut.xy (soft 3 m edge)
        float intLive(vec3 p) {
          float onFloor = intOutFloor < -998.0 ? 1.0 : 1.0 - step(0.5, abs(floor((p.y + 0.01) / ${f(FLOOR_HEIGHT)}) - intOutFloor));
          return 1.0 - intOut.w * onFloor * smoothstep(intOut.z, intOut.z - 3.0, distance(p.xz, intOut.xy));
        }
        // The level's lit landmark: a ceiling tube lighting actual receiving walls/floor, confined to its room.
        float intLandmarkAt(vec3 p, vec3 n) {
          if (intLandmark.w <= 0.0 || p.x < intLandmarkRect.x - ${f(LANDMARK_LIGHT.edge)} || p.x > intLandmarkRect.z + ${f(LANDMARK_LIGHT.edge)}
            || p.z < intLandmarkRect.y - ${f(LANDMARK_LIGHT.edge)} || p.z > intLandmarkRect.w + ${f(LANDMARK_LIGHT.edge)}
            || p.y < intLandmarkY.x - ${f(LANDMARK_LIGHT.edge)} || p.y > intLandmarkY.y + ${f(LANDMARK_LIGHT.edge)}) return 0.0;
          float s = 0.0;
          for (int i = 0; i < 3; i++) {
            float offset = float(i - 1) * ${f(LANDMARK_LIGHT.half * 2 / 3)};
            vec3 d = intLandmark.xyz + vec3(intLandmarkAxis.x * offset, 0.0, intLandmarkAxis.y * offset) - p;
            float d2 = dot(d, d), len = max(sqrt(d2), 1e-4);
            float cap = 1.0 - ${f(1 - LANDMARK_LIGHT.above)} * smoothstep(0.0, ${f(LANDMARK_LIGHT.cap)}, -d.y / len);
            s += max(0.0, dot(d, n) / len) * (${f(LANDMARK_LIGHT.up)} + ${f(1 - LANDMARK_LIGHT.up)} * max(0.0, d.y / len)) * cap / (d2 + ${f(LANDMARK_LIGHT.core)});
          }
          return intLandmark.w * (${f(LANDMARK_LIGHT.bounce)} + ${f(LANDMARK_LIGHT.k / 3)} * s);
        }
        // one 日光灯 fixture (its cell of the tube grid): ~8% dead (TUBE_SICK.dead), ~14% buzzing on and off (TUBE_SICK.flick)
        float intTubeSick(vec3 p) {
          vec2 c = floor((p.xz - intBox.xy) / vec2(${f(TUBE.px)}, ${f(TUBE.pz)}) + 0.5) + floor(p.y / 3.0) * 17.0;
          float h = fract(sin(dot(c, vec2(12.9898, 78.233))) * 43758.5453);
          if (h < ${f(TUBE_SICK.dead)}) return 0.0;
          if (h > ${f(1 - TUBE_SICK.flick)}) return step(0.25, fract(sin(floor(intTime * (6.0 + h * 9.0)) * 91.7 + h * 311.0) * 4375.5)) * 0.85 + 0.15;
          return 1.0;
        }`)
      .replace('#include <lights_lambert_pars_fragment>', `#include <lights_lambert_pars_fragment>
        // indoor ambient in place of the outdoor hemisphere: sky and ground mixed (a ceiling is not lit by the ground
        // only), strongest by the outer walls and falling off toward the middle of the plan; + the bounce of the sun
        // off lit floors and the 日光灯 at night
        // The mirror scene has ambient light only; Three declares HemisphereLight only when this count is positive.
        #if NUM_HEMI_LIGHTS > 0
        vec3 intAmbient(HemisphereLight h) {
          vec2 rel = abs(vIntW.xz - intBox.xy);
          float d = max(0.0, min(intBox.z - rel.x, intBox.w - rel.y) - ${f(WALL_T)});
          if (intCourt.z > 0.0) {
            vec2 cr = abs(vIntW.xz - intCourt.xy) - intCourt.zw;
            d = min(d, max(0.0, max(cr.x, cr.y) - ${f(WALL_T)}));
          }
          float k = mix(${f(INDOOR.deep)}, 1.0, exp(-d / ${f(INDOOR.falloff)}));
          float face = vIntN.y > 0.5 ? 1.0 : (vIntN.y < -0.5 ? 0.8 : 0.9);
          // 天台水箱间 (TANK_LIGHT): a dim bounce and the doorway, nothing from the facade or the 日光灯
          if (intInTank(vIntW)) {
            vec3 seen = mix(h.groundColor, h.skyColor, ${f(TANK_LIGHT.sky)});
            return seen * (${f(TANK_LIGHT.deep)} * face + intTankDoorAt(vIntW, vIntN)) + intTankBulb * intTankBulbAt(vIntW, vIntN);
          }
          // 暗室 (DARKROOM): near black but for the corridor through its door and the red 安全灯
          if (intInDark(vIntW)) {
            vec3 seen = mix(h.groundColor, h.skyColor, ${f(DARKROOM.sky)});
            return seen * (${f(DARKROOM.deep)} * face + intDarkDoorAt(vIntW, vIntN)) + ${v3(DARKROOM.color)} * intSafeAt(vIntW, vIntN);
          }
          // 地下室 / 器材室 (SEALED_AMBIENT): no window anywhere, so a fixed dim ambient whatever the hour or weather and
          // their 日光灯 on day and night
          bool under = intSealed(vIntW);
          vec3 amb = under ? ${v3(SEALED_AMBIENT)} : mix(h.groundColor, h.skyColor, 0.6) * k * (1.0 - intDayAmb * intNightLit(vIntW)) + intSunC * ${f(INDOOR.bounce)};
          vec3 tubeC = under ? ${v3(TUBE_COLOR, TUBE_LEVEL)} : intTube * intNightLit(vIntW) * intOneLamp(vIntW) * intLive(vIntW);
          // 灯下明暗 (ROOM_LAMP): at night a lit nightRoom's tubes fall off from each fixture and light it warm, in place
          // of the flat face factor; by day (阴雨天) it stays flat and cold, the windows light it too
          float fall = intRoomFall(vIntW, vIntN), lit = fall < 0.0 ? 0.0 : 1.0 - intDayShare;
          vec3 tube = intInLampStair(vIntW) ? vec3(0.0) : tubeC * mix(vec3(vIntN.y > 0.5 ? 1.0 : (vIntN.y < -0.5 ? 0.55 : 0.8)), ${v3(ROOM_LAMP.warm)} * fall / face, lit);
          // 黑板灯 on the front 黑板's slate (from above and in front: no face falloff)
          if (abs(vIntDado - ${f(SURF_BOARD)}) < 0.5) tube += intTube * intNightLit(vIntW) * intLive(vIntW) * ${f(BOARD_LAMP)};
          if (under) return (amb + tube) * face + intStairLamp * intLampAt(vIntW, vIntN);
          // 夜里的底光 (NIGHT_AMB): the town's glow through every window, so a dark room keeps its faces apart
          amb += ${v3(EXIT_LIGHT.color)} * intExitAt(vIntW, vIntN) / face;
          amb += intNightAmb * (intOutFloor < -998.0 ? 1.0 : 0.15 + 0.85 * intLive(vIntW)) * k * (vIntN.y > 0.5 ? 1.0 : (vIntN.y < -0.5 ? ${f(NIGHT_AMB.down)} : ${f(NIGHT_AMB.side)})) / face;
          // 暗适应 (EYE_LIGHT): what the dark-adapted eye still makes out around itself in a 停电关, the floor first
          vec3 eyeD = vIntW - intEye.xyz;
          amb += ${v3(EYE_LIGHT.color, EYE_LIGHT.level)} * intEye.w * exp(-dot(eyeD, eyeD) * ${f(1 / EYE_LIGHT.reach ** 2)}) * (vIntN.y > 0.5 ? 1.0 : (vIntN.y < -0.5 ? ${f(EYE_LIGHT.down)} : ${f(EYE_LIGHT.side)})) / face;
          amb += intTube * ${v3(LANDMARK_LIGHT.warm)} * intLandmarkAt(vIntW, vIntN) * intLive(vIntW) / face;
          return (amb + tube) * face + intStairLamp * intLampAt(vIntW, vIntN) + intTube * (1.0 - intDayShare) * (intSpillAt(vIntW, vIntN) * ${f(b.nightTube ?? 1)} + intBeamAt(vIntW, vIntN)) * intLive(vIntW) * ${nightLight(b)?.rooms.some(r => r.lamps.length) ? v3(ROOM_LAMP.warm) : 'vec3(1.0)'} + mat2x3(intWinSky, intWinLamp) * intWinAt(vIntW, vIntN);
        }
        #endif`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        // a pixel's footprint on the walls (here, outside any branch: derivatives in one are undefined)
        vec3 intDW = fwidth(vIntW);
        // 墙裙 (world/interior.ts DADO): wall faces tagged surf.y = 1 take the 墙裙 band up to DADO.h above their storey's
        // floor, as a tint (the vertex colour's face shading stays), with a darker 分色线 along its top; in a 后厨
        // (intTiled) white tile with its 格缝 up to TILE.dado instead
        if (vIntDado > 0.5 && vIntDado < 1.5 && abs(vIntN.y) < 0.5) {
          float hy = vIntW.y - intDadoFloor(vIntW) + 0.05;
          hy = hy - floor(hy / ${f(g.storey)}) * ${f(g.storey)} - 0.05;
          if (intTiled(vIntW)) { if (hy < ${f(TILE.dado)}) diffuseColor.rgb *= vec3(${dadoTint(FURN_COLOR.tileWhite)}) * intGrout(vIntW, vIntN, intDW); }
          else if (hy < ${f(DADO.h)}) diffuseColor.rgb *= vec3(${dadoTint(dado)}) * (hy > ${f(DADO.h - DADO.line)} ? ${f(DADO.lineK)} : 1.0);
        }
        // a white 瓷砖 box (world/classroom.ts SURF_TILE): its 格缝
        if (abs(vIntDado - ${f(SURF_TILE)}) < 0.5) diffuseColor.rgb *= intGrout(vIntW, vIntN, intDW);
        // 书脊 (world/library.ts 密集架: FurnBox.spine, surf = (tier bottom y, 5 + clear height)): one box per tier
        // painted as runs of books, a colour, height and a hash per run, spine edges inside it, gaps of dark shelf
        if (vIntDado > 4.5) ${spineGlsl()}
        // 档案盒 标签 + 指孔, 作业本 pile edges (world/office.ts FurnBox.label / pile, surf.y SURF_LABEL / SURF_PILE + v)
        if (vIntDado < ${f(SURF_LABEL + 1.5)} && vIntDado > ${f(SURF_PILE - 0.5)}) ${decalGlsl()}
        // 水磨石 (world/interior.ts TERRAZZO, surf.y = 3): stone chips in the cement, a hash per ~2 cm cell
        // on the top faces only, fading out with distance (a chip finer than a pixel would only shimmer)
        if (vIntDado > 2.5 && vIntDado < 3.5 && vIntN.y > 0.5) {
          // integer hash of the cell (a float sin()/fract() hash of whole numbers clumps into blocks under SwiftShader)
          vec2 tw = mod(vIntW.xz, 64.0) * ${f(1 / TERRAZZO.cell)};
          uvec2 tc = uvec2(floor(tw));
          uint hn = (tc.x * 1597334677u) ^ (tc.y * 3812015801u);
          hn ^= hn >> 16; hn *= 2246822519u; hn ^= hn >> 13;
          float h = float(hn >> 8) / 16777216.0;
          // a round chip inside its cell, its size from the hash too (a whole-cell square reads as 马赛克 up close)
          if (length(fract(tw) - 0.5) > 0.22 + 0.2 * fract(h * 7.0)) h = 0.5;
          float k = h < ${f(TERRAZZO.dark)} ? ${f(TERRAZZO.darkK)} : (h > ${f(1 - TERRAZZO.light)} ? ${f(TERRAZZO.lightK)} : 1.0);
          diffuseColor.rgb *= mix(k, 1.0, smoothstep(${f(TERRAZZO.fade[0])}, ${f(TERRAZZO.fade[1])}, length(vViewPosition)));
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        intFoot = length(fwidth(vIntW));
        // the strip on the ceiling, or a 教室 fixture's tube (world/classroom.ts: surf.y = 2)
        float intT = abs(vIntDado - 2.0) < 0.5 ? 1.0 : intTubeAt(vIntW);
        if (intT > 0.5) {
          // the tube: a pale strip by day, lit cold white at night
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.93, 0.9), 0.6);
          totalEmissiveRadiance += (intSealed(vIntW) ? ${v3(TUBE_COLOR, TUBE_LEVEL)} : intTube * intNightLit(vIntW) * intLive(vIntW) * intTubeSick(vIntW)) * 1.6;
        }
        // 声控灯罩 (world/interior.ts LAMP: surf.y = 4): milk glass, grey-white when off, glowing when its lamp is on
        if (vIntDado > 3.5 && vIntDado < 4.5) {
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.8, 0.79, 0.74), 0.3);
          totalEmissiveRadiance += intStairLamp;
        }
        // 水箱间's bare bulb (TANK_BULB): a warm white glass, glowing once it is on
        if (intInTank(vIntW) && intOnTankBulb(vIntW)) {
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.9, 0.8), 0.5);
          totalEmissiveRadiance += intTankBulb * ${f(TANK_BULB.glow)};
        }
        // 指示灯 / 监控 picture (world/netroom.ts: FurnBox.glow, surf = (phase, -1 | -2))
        if (vIntDado < -0.5 && vIntDado > -2.5) ${glowGlsl()}`)
      // the light loop is an #include, expanded only after onBeforeCompile: inline it so the edits below find their lines
      .replace('#include <lights_fragment_begin>', THREE.ShaderChunk.lights_fragment_begin)
      .replace('getDirectionalLightInfo( directionalLight, directLight );',
        'getDirectionalLightInfo( directionalLight, directLight );\n\t\t' + SUN_RIM)
      // the street lamps are outside: their light does not come through walls. The 手电 do light the interior: the player's
      // (game.ts flashlight, the one spot on the camera: view-space position ~0) and two teammates' (teamLights),
      // told apart from the lamps by decay ≥ TORCH_DECAY (the lamps use 1.6)
      .replace('getPointLightInfo( pointLight, geometryPosition, directLight );', 'getPointLightInfo( pointLight, geometryPosition, directLight );\n\t\tdirectLight.color *= 0.0;')
      .replace('getSpotLightInfo( spotLight, geometryPosition, directLight );', `getSpotLightInfo( spotLight, geometryPosition, directLight );
        directLight.color *= max( step( length( spotLight.position ), 1.0 ), step( ${f(TORCH_DECAY)}, spotLight.decay ) );
        // The eye's torch: soften inverse-square irradiance at arm's length so pale plaster retains its texture.
        // A 2 m soft core bounds the near field; fade it out over 2–4 m, leaving the distant beam unchanged.
        // Teammates already have their own surface-distance gain (teamlight.ts): do not attenuate them twice.
        if (length(spotLight.position) <= 1.0 && spotLight.coneCos > 0.7) {
          vec3 intTorchV = spotLight.position - geometryPosition;
          float intTorchD2 = dot(intTorchV, intTorchV);
          float intTorchCore = 4.0 * (1.0 - smoothstep(2.0, 4.0, sqrt(intTorchD2)));
          directLight.color *= intTorchD2 / (intTorchD2 + intTorchCore);
        }`)
      .replace('irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );', 'irradiance += intAmbient( hemisphereLights[ i ] );');
    // a three.js upgrade that renames a line must fail loudly, not light the interior like outdoors
    if (!shader.vertexShader.includes('intFanR * (transformed')) throw new Error("interior light: shader patch 'intFanR' not applied");
    for (const k of ['intSunSees(vIntW', 'diffuseColor.rgb *= vec3(', 'directLight.color *= 0.0', 'step( length( spotLight.position ), 1.0 ), step(', 'intAmbient( hemisphereLights', 'float intT = abs(vIntDado - 2.0)', 'totalEmissiveRadiance += intStairLamp', 'GLOW_LED', 'intStairLamp * intLampAt(vIntW', 'intTube * (1.0 - intDayShare) * (intSpillAt(vIntW', 'intRoomFall(vIntW, vIntN)', 'mat2x3(intWinSky, intWinLamp) * intWinAt(vIntW', 'intTankDoorAt(vIntW', 'intDarkDoorAt(vIntW', 'intTankBulb * intTankBulbAt(vIntW', 'totalEmissiveRadiance += intTankBulb'])
      if (!shader.fragmentShader.includes(k)) throw new Error(`interior light: shader patch '${k}' not applied`);
    if (shader.fragmentShader.includes('${')) throw new Error('interior light: uninterpolated ${...} in the fragment shader');
  };
  mat.customProgramCacheKey = () => `interior-light:${b.id}:${g.storey}/${g.slab}/${m.bands}/${g.court?.top ?? 0}/${dado}:landmark-v1`;
  return mat;
}

/** Time of day → the interior uniforms. `sun` is the scene light as applied (colour × intensity); `hemi` the sky light. */
export function syncInteriorLight(u: InteriorLightUniforms, sunDir: readonly [number, number, number], sun: THREE.DirectionalLight, windows: number, hemi?: THREE.HemisphereLight, lamps = 0, overcast = 0): void {
  u.intSunDir.value.set(...sunDir).normalize();
  u.intSunC.value.copy(sun.color).multiplyScalar(sun.intensity);
  const tubes = tubeState(windows, overcast, lamps);
  u.intTube.value.copy(TUBE_COLOR).multiplyScalar(TUBE_LEVEL * tubes.on);
  u.intDayShare.value = tubes.day;
  u.intDayAmb.value = DAY_AMB_CUT * tubes.on * tubes.day;
  u.intWinLamp.value.copy(WIN_LAMP.color).multiplyScalar(WIN_LAMP.level * lamps);
  // the sky colour, 40% greyed: a pale cold window, not a blue lamp
  if (hemi) {
    const c = hemi.color, l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    u.intWinSky.value.copy(c).lerp(new THREE.Color(l, l, l), 0.4).multiplyScalar(WIN_SKY * winNight(hemi.intensity));
    u.intNightAmb.value.copy(NIGHT_AMB.color).multiplyScalar(NIGHT_AMB.level * winNight(hemi.intensity));
    u.intTankBulb.value.copy(TANK_BULB.color).multiplyScalar(TANK_BULB.level * winNight(hemi.intensity));
  }
}
/** 日光灯 fixtures that are dead (share) or buzz on and off (share): per fixture, a hash of its tube-grid cell (intTubeSick) */
export const TUBE_SICK = { dead: 0.08, flick: 0.14 };
/**
 * 夜里的底光 (关灯的楼): with the 日光灯 and the 声控灯 off the hemisphere ambient is near black and a room is only its
 * ink lines. The town's sky glow and the 路灯 come in through every window: a cold grey `level` × the indoor falloff,
 * strongest on floors and treads (up), `side` on walls and risers, `down` on ceilings and soffits, so steps read as
 * light treads over dark risers. Added in lit rooms too (it is small next to a 日光灯).
 */
export const NIGHT_AMB = { level: 0.05, side: 0.5, down: 0.3, color: new THREE.Color(0.62, 0.7, 0.85) };
/**
 * 暗适应 (停电关, 用户 10-28「第二层要保证最暗也能看到脚底的路」): with the 日光灯 out and a 跳闸 cutting the 应急 floor
 * (NIGHT_AMB × BLACKOUT_AMB × 0.15) the ground at your feet would be black. The dark-adapted eye still makes out the
 * nearest surfaces: a faint cold radiance `level` × exp(−(d / `reach`)²), d the distance to the eye (CampusScene.eye
 * sets where and how strong), full on floors and treads, `side` on walls, `down` on ceilings, so the floor reads above
 * the walls beside it and the floor/wall edge holds; at 2 × reach it is 2%, so past a few metres the corridor stays black.
 */
export const EYE_LIGHT = { level: 0.3, reach: 5, side: 0.4, down: 0.15, color: new THREE.Color(0.62, 0.7, 0.85) };
/** EYE_LIGHT radiance factor (× EYE_LIGHT.color × level) at `p` with normal `n`, eye at `eye` with strength `w`. Mirrors the shader. */
export function eyeLight(eye: readonly [number, number, number], w: number, p: readonly [number, number, number], n: readonly [number, number, number]): number {
  const d2 = (p[0] - eye[0]) ** 2 + (p[1] - eye[1]) ** 2 + (p[2] - eye[2]) ** 2;
  return w * Math.exp(-d2 / EYE_LIGHT.reach ** 2) * (n[1] > 0.5 ? 1 : n[1] < -0.5 ? EYE_LIGHT.down : EYE_LIGHT.side);
}
/** 吊扇 speed when fully on (rad/s): ~60 rpm, a 教室 fan on its middle setting, slow enough to read the blades */
export const FAN_RATE = 6.5;
/** Frame step → the 吊扇 angle: it turns at FAN_RATE × how far the 日光灯 are on (so it runs up / winds down). */
export function spinFans(u: InteriorLightUniforms, dt: number, windows: number, overcast = 0, lamps = 0): void {
  u.intFanAng.value = (u.intFanAng.value + dt * FAN_RATE * tubeState(windows, overcast, lamps).on) % (2 * Math.PI);
}
/** End-window glow on (0..1) from the sky light's intensity: only once it is night (by day the ambient has it). Pure. */
export const winNight = (hemiIntensity: number) => { const k = Math.min(1, Math.max(0, (0.8 - hemiIntensity) / 0.25)); return k * k * (3 - 2 * k); };
