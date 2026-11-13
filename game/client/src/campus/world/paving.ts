import * as THREE from 'three';
import { fieldGeometry } from './field.ts';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { AABB } from '../../../../shared/campus/collision.ts';
import type { CampusDef, CoverDef, PavePattern, PavingDef, PlatformDef, StreetDef, WallDef } from '../../../../shared/campus/campus_schema.ts';

/**
 * 铺装 (南门③, docs/03_campus.md): the paved rects of campus.json `paving` (中轴大道, 人行道, 升旗广场, paths to the
 * 教学楼), their 路缘石, the 旗杆底座 and 升旗台 coping, and the 树池 round the axis trees. One merged vertex-coloured mesh, one draw call. The joints
 * are not geometry: every paving vertex carries `pave = (pattern, tile x, tile z)` and a patch on the Lambert
 * material (patchPaving) draws them per fragment in world space, one internal pixel wide, fading out once a tile
 * is only a few pixels across (they would dither into noise). Lying snow (render/snowcover.ts) chains on top.
 */

export const PAVE = {
  /** paving top above the ground plane: under the puddle layer (world/wet.ts, 1.5 cm) so puddles lie on it */ y: 0.008,
  /** 路缘石 (wide, high) */ curb: [0.15, 0.12] as const, curbColor: '#b2ab9b',
  /** 树池: outer size, frame (wide, high), soil a hair above the paving */ pit: 1.5, pitFrame: [0.12, 0.1] as const, soil: '#6e604e', soilY: 0.011,
  /** joint darkening, per-tile tone jitter (±), checker's second tone */ joint: 0.8, jitter: 0.035, checker: 0.9,
  /** 草坪: the darker 割草条纹 tone; 绿篱 (wide, high, side / top colour) */ mow: 0.9, hedge: [0.6, 0.75] as const, hedgeC: '#5c7049', hedgeTop: '#6e8556',
  /** joints fade between a tile this many and this many internal pixels across */ fadePx: [3, 8] as const,
};
const PATTERN_ID: Record<PavePattern, number> = { bond: 1, grid: 2, checker: 3, lawn: 4 };

const hash = (x: number, y: number) => { const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; return s - Math.floor(s); };
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * Brightness multiplier of paving `pattern` with `tile` at world (x, z), seen at `mpp` metres per internal pixel —
 * the shader's maths (`mpp` = [x, z] footprint of a pixel, the shader's fwidth). Rows run along x ('bond' offsets
 * every other row half a tile); a fragment within half a pixel of a joint is a joint (per axis, fading per axis); each tile gets its own ±jitter, 'checker' tiles alternate a darker tone (that one never
 * fades later, then settles to the mean tone). Pure, for tests.
 */
export function paveShade(pattern: PavePattern, tile: [number, number], x: number, z: number, mpp: [number, number]): number {
  if (pattern === 'lawn') {
    const row = Math.floor(z / tile[1]), k = smooth(PAVE.fadePx[0] / 2, PAVE.fadePx[0], tile[1] / mpp[1]);
    return mix((1 + PAVE.mow) / 2, ((row % 2) + 2) % 2 ? PAVE.mow : 1, k);
  }
  let u = x / tile[0];
  const v = z / tile[1], row = Math.floor(v);
  if (pattern === 'bond') u += (((row % 2) + 2) % 2) * 0.5;
  const cx = Math.floor(u), fu = u - cx, fv = v - row;
  const du = Math.min(fu, 1 - fu) * tile[0], dv = Math.min(fv, 1 - fv) * tile[1];
  // per axis: on a grazing view the along-view joints are many pixels apart while the across-view ones crowd
  const fu1 = smooth(PAVE.fadePx[0], PAVE.fadePx[1], tile[0] / mpp[0]), fv1 = smooth(PAVE.fadePx[0], PAVE.fadePx[1], tile[1] / mpp[1]);
  let s = 1 + (hash(cx, row) - 0.5) * 2 * PAVE.jitter * Math.min(fu1, fv1);
  if (du < mpp[0] * 0.5) s = mix(s, PAVE.joint, fu1);
  if (dv < mpp[1] * 0.5) s = mix(s, PAVE.joint, fv1);
  // the checker's second tone survives further out than the joints, then settles to the mean (no moiré)
  const odd = pattern === 'checker' && (((cx + row) % 2) + 2) % 2 === 1;
  const k = smooth(PAVE.fadePx[0] / 2, PAVE.fadePx[0], Math.min(tile[0] / mpp[0], tile[1] / mpp[1]));
  const tone = pattern !== 'checker' ? 1 : mix((1 + PAVE.checker) / 2, odd ? PAVE.checker : 1, k);
  return tone * s;
}

/** An axis-aligned box (min/max corners), the curbs and tree-pit frames. */
export interface PaveBox { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number }

/** [lo, hi] minus every interval in `cut` (sorted pieces left over, ≥ 1 cm long). */
export function subtract(lo: number, hi: number, cut: [number, number][]): [number, number][] {
  let out: [number, number][] = [[lo, hi]];
  for (const [a, b] of cut) out = out.flatMap(([p, q]): [number, number][] => (b <= p || a >= q ? [[p, q]] : [[p, Math.min(a, q)], [Math.max(b, p), q]]));
  return out.filter(([s, e]) => e - s > 0.01);
}

/** 路缘石 along the `curb` sides of each paving rect, standing just outside its edge, broken at the side's gaps. */
export function curbBoxes(paving: PavingDef[]): PaveBox[] {
  const [cw, ch] = PAVE.curb, out: PaveBox[] = [];
  for (const p of paving) for (const k of p.curb ?? []) {
    const side = typeof k === 'string' ? k : k.side, gaps = typeof k === 'string' ? [] : k.gaps;
    const alongX = side[1] === 'z', sg = side[0] === '+' ? 1 : -1;
    const edge = alongX ? p.z + sg * p.d / 2 : p.x + sg * p.w / 2;
    // a z side runs on over the corner when the x side there is curbed too (no notch where they meet)
    const has = (k2: string) => (p.curb ?? []).some(c => (typeof c === 'string' ? c : c.side) === k2);
    const lo = alongX ? p.x - p.w / 2 - (has('-x') ? cw : 0) : p.z - p.d / 2, hi = alongX ? p.x + p.w / 2 + (has('+x') ? cw : 0) : p.z + p.d / 2;
    const e0 = sg > 0 ? edge : edge - cw, e1 = e0 + cw;
    for (const [a, b] of subtract(lo, hi, gaps)) {
      out.push(alongX ? { x0: a, x1: b, y0: 0, y1: ch, z0: e0, z1: e1 } : { x0: e0, x1: e1, y0: 0, y1: ch, z0: a, z1: b });
    }
  }
  return out;
}

/** 绿篱 along the `hedge` sides of each paving rect (a lawn), just inside its edge, broken at the gaps: body + top. */
export function hedgeBoxes(paving: PavingDef[]): (PaveBox & { color: string; top?: true })[] {
  const [hw, hh] = PAVE.hedge, out: (PaveBox & { color: string; top?: true })[] = [];
  for (const p of paving) for (const k of p.hedge ?? []) {
    const side = typeof k === 'string' ? k : k.side, gaps = typeof k === 'string' ? [] : k.gaps;
    const alongX = side[1] === 'z', sg = side[0] === '+' ? 1 : -1;
    const edge = alongX ? p.z + sg * p.d / 2 : p.x + sg * p.w / 2, e0 = sg > 0 ? edge - hw : edge, e1 = e0 + hw;
    // x sides stop short of a hedged z side so the corners don't overlap
    const has = (k2: string) => (p.hedge ?? []).some(c => (typeof c === 'string' ? c : c.side) === k2);
    const lo = alongX ? p.x - p.w / 2 : p.z - p.d / 2 + (has('-z') ? hw : 0), hi = alongX ? p.x + p.w / 2 : p.z + p.d / 2 - (has('+z') ? hw : 0);
    for (const [a, b] of subtract(lo, hi, gaps)) {
      const r = alongX ? { x0: a, x1: b, z0: e0, z1: e1 } : { x0: e0, x1: e1, z0: a, z1: b };
      out.push({ ...r, y0: 0, y1: hh - 0.06, color: PAVE.hedgeC });
      out.push({ x0: r.x0 + 0.04, x1: r.x1 - 0.04, z0: r.z0 + 0.04, z1: r.z1 - 0.04, y0: hh - 0.06, y1: hh, color: PAVE.hedgeTop, top: true });
    }
  }
  return out;
}

/** 树池 frames: four low kerb bars round each tree, the soil inside left to treePitSoil. */
export function treePitBoxes(trees: [number, number][]): PaveBox[] {
  const h = PAVE.pit / 2, [fw, fh] = PAVE.pitFrame, out: PaveBox[] = [];
  for (const [x, z] of trees) {
    out.push({ x0: x - h, x1: x + h, y0: 0, y1: fh, z0: z - h, z1: z - h + fw }, { x0: x - h, x1: x + h, y0: 0, y1: fh, z0: z + h - fw, z1: z + h });
    out.push({ x0: x - h, x1: x - h + fw, y0: 0, y1: fh, z0: z - h + fw, z1: z + h - fw }, { x0: x + h - fw, x1: x + h, y0: 0, y1: fh, z0: z - h + fw, z1: z + h - fw });
  }
  return out;
}
/** 树池 soil squares (inside the frames), drawn as flat quads a hair above the paving. */
export function treePitSoil(trees: [number, number][]): PaveBox[] {
  const h = PAVE.pit / 2 - PAVE.pitFrame[0];
  return trees.map(([x, z]) => ({ x0: x - h, x1: x + h, y0: PAVE.soilY, y1: PAVE.soilY, z0: z - h, z1: z + h }));
}

/** A paving rect split into its field and (with `border`) four border bands, each with its own colour and joints. */
export interface PaveQuad { x0: number; x1: number; z0: number; z1: number; color: string; pattern: number; tile: [number, number] }
export function paveQuads(p: PavingDef): PaveQuad[] {
  const x0 = p.x - p.w / 2, x1 = p.x + p.w / 2, z0 = p.z - p.d / 2, z1 = p.z + p.d / 2, pat = PATTERN_ID[p.pattern];
  const b = p.border;
  if (!b) return [{ x0, x1, z0, z1, color: p.color, pattern: pat, tile: p.tile }];
  const w = b.w, edge = (q: Omit<PaveQuad, 'color' | 'pattern' | 'tile'>, along: 'x' | 'z'): PaveQuad =>
    // border slabs: square across the band, twice as long along it
    ({ ...q, color: b.color, pattern: PATTERN_ID.grid, tile: along === 'x' ? [w * 2, w] : [w, w * 2] });
  return [
    { x0: x0 + w, x1: x1 - w, z0: z0 + w, z1: z1 - w, color: p.color, pattern: pat, tile: p.tile },
    edge({ x0, x1, z0, z1: z0 + w }, 'x'), edge({ x0, x1, z0: z1 - w, z1 }, 'x'),
    edge({ x0, x1: x0 + w, z0: z0 + w, z1: z1 - w }, 'z'), edge({ x0: x1 - w, x1, z0: z0 + w, z1: z1 - w }, 'z'),
  ];
}

/**
 * 旗杆 and its 底座 on the 升旗台 (platform `pole`): a two-tier stone plinth, a steel collar, the pole as a tapered
 * octagonal tube with a ball on top, and a halyard cleat on the south side at hand height. Plus the platform's
 * stone coping, a frame 1 cm proud of its top so the edge reads as a separate course. Parts are vertex-coloured.
 */
export const FLAG_POLE = {
  plinth: [[0.9, 0.22], [0.56, 0.16]] as [number, number][], collar: [0.13, 0.12] as const,
  r: [0.075, 0.045] as const, ball: 0.1, cleat: 1.1, coping: [0.22, 0.05, 0.07] as const,
  stone: '#c9c1ae', plinthTop: '#b8b09d', steel: '#cfd2cf', collarC: '#8f918c', ballC: '#d2b25a', copingC: '#cec6b3',
};

/** Every box of the 旗杆 and its 底座 and of the 升旗台 coping (world space), with its colour. */
export function flagPoleParts(p: PlatformDef): (PaveBox & { color: string; oct?: [number, number] })[] {
  if (!p.pole) return [];
  const F = FLAG_POLE, cx = p.x, cz = p.z + p.d / 4, out: (PaveBox & { color: string; oct?: [number, number] })[] = [];
  const sq = (r: number, y0: number, y1: number, color: string) => out.push({ x0: cx - r, x1: cx + r, y0, y1, z0: cz - r, z1: cz + r, color });
  let y = p.h;
  F.plinth.forEach(([w, h], i) => { sq(w / 2, y, y + h, i ? F.plinthTop : F.stone); y += h; });
  sq(F.collar[0], y, y + F.collar[1], F.collarC);
  const top = p.h + p.pole;
  // the pole: an octagonal tube tapering r[0] → r[1] (oct = [r bottom, r top])
  out.push({ x0: cx, x1: cx, y0: y, y1: top, z0: cz, z1: cz, color: F.steel, oct: [F.r[0], F.r[1]] });
  sq(F.ball, top, top + F.ball * 2, F.ballC);
  // 系绳器 on the south face at hand height above the platform
  out.push({ x0: cx - 0.05, x1: cx + 0.05, y0: p.h + F.cleat, y1: p.h + F.cleat + 0.04, z0: cz - F.r[0] - 0.05, z1: cz - F.r[0], color: F.collarC });
  // coping: a frame round the platform top, proud of the body by `coping[2]` sideways and 1 cm up
  const [cw, ch, over] = F.coping, x0 = p.x - p.w / 2 - over, x1 = p.x + p.w / 2 + over, z0 = p.z - p.d / 2 - over, z1 = p.z + p.d / 2 + over;
  const y0 = p.h - ch + 0.01, y1 = p.h + 0.01;
  out.push({ x0, x1, y0, y1, z0, z1: z0 + cw, color: F.copingC }, { x0, x1, y0, y1, z0: z1 - cw, z1, color: F.copingC });
  out.push({ x0, x1: x0 + cw, y0, y1, z0: z0 + cw, z1: z1 - cw, color: F.copingC }, { x0: x1 - cw, x1, y0, y1, z0: z0 + cw, z1: z1 - cw, color: F.copingC });
  return out;
}

/** Colliders the 旗杆底座 adds on top of the platform (the pole itself is platformBoxes' column). */
export function flagPoleColliders(p: PlatformDef): AABB[] {
  return flagPoleParts(p).filter(b => !b.oct && b.y1 - b.y0 > 0.1 && b.x1 - b.x0 > 0.3)
    .map(b => ({ minX: b.x0, minY: b.y0, minZ: b.z0, maxX: b.x1, maxY: b.y1, maxZ: b.z1 }));
}

/**
 * 门外马路 (campus.json `street`): what the gate opens onto. Under the gate a 门槛 strip continues the 中轴大道's slabs
 * across the wall line (under the rail); outside, the sidewalk's pavers run up to the wall, cut by a 门口坡道 (a drive
 * strip of the same slabs, its curb dropped to a lip) as wide as the gate between the pillars; then asphalt with a
 * double yellow centre line, dashed lane lines, white edge lines and a 斑马线 (bars along x, the gaps between them
 * what you step across), the far curb and sidewalk, and a low 绿篱 closing the view. Markings lie 3 mm over the
 * asphalt (under the puddles). Pure data; pavingGeometry draws it in the paving mesh.
 */
export const STREET = {
  asphalt: '#6f6d68', walkColor: '#a3927d', walkTile: [0.5, 0.25] as [number, number],
  yellow: '#c9a54a', white: '#d8d4c8', markY: 0.011, line: 0.15, yGap: 0.15, dash: [2, 4] as const,
  zebra: { bar: 0.45, gap: 0.6, margin: 0.5 }, lip: 0.04, hedgeC: '#4f5a43', hedgeTop: '#5d6a4e',
};
export interface StreetParts { quads: PaveQuad[]; marks: PaveQuad[]; curbs: PaveBox[]; hedge: (PaveBox & { color: string })[] }
export function streetParts(w: WallDef, s: StreetDef, road: PavingDef | undefined): StreetParts {
  const S = STREET, X0 = w.minX - w.t / 2, X1 = w.maxX + w.t / 2, out = w.minZ - w.t / 2;
  const g0 = w.gate[0] + w.t / 2, g1 = w.gate[1] - w.t / 2, slab = road ? road.color : S.walkColor;
  const slabT: [number, number] = road ? road.tile : [1.2, 0.6], slabP = PATTERN_ID[road?.pattern ?? 'grid'];
  const zw = out - s.walk, zr = zw - s.road, zf = zr - s.far, [cw, ch] = PAVE.curb;
  const q = (x0: number, x1: number, z0: number, z1: number, color: string, pattern = 0, tile: [number, number] = [1, 1]): PaveQuad => ({ x0, x1, z0, z1, color, pattern, tile });
  const quads: PaveQuad[] = [
    // 门槛 under the rail (between the pillars, wall thickness deep) + the 门口坡道 across the sidewalk
    q(g0, g1, zw, w.minZ + w.t / 2, slab, slabP, slabT),
    ...subtract(X0, X1, [[g0, g1]]).map(([a, b]) => q(a, b, zw, out, S.walkColor, PATTERN_ID.bond, S.walkTile)),
    q(X0, X1, zr, zw - cw, S.asphalt),
    q(X0, X1, zf, zr - cw, S.walkColor, PATTERN_ID.bond, S.walkTile),
  ];
  // markings: centre double yellow, lane dashes, edge lines; none across the 斑马线
  const [zx, zwid] = s.zebra, zb = [[zx - zwid / 2 - S.zebra.margin, zx + zwid / 2 + S.zebra.margin]] as [number, number][];
  const a0 = zr, a1 = zw - cw, mid = (a0 + a1) / 2, lane = (a1 - a0) / s.lanes, L = S.line, marks: PaveQuad[] = [];
  const run = (z: number, color: string, dashed: boolean) => {
    for (const [a, b] of subtract(X0, X1, zb)) {
      if (!dashed) { marks.push(q(a, b, z - L / 2, z + L / 2, color)); continue; }
      const p = S.dash[0] + S.dash[1];
      for (let x = Math.ceil(a / p) * p; x + S.dash[0] <= b; x += p) marks.push(q(x, x + S.dash[0], z - L / 2, z + L / 2, color));
    }
  };
  run(mid - (S.yGap + L) / 2, S.yellow, false); run(mid + (S.yGap + L) / 2, S.yellow, false);
  for (let i = 1; i < s.lanes / 2; i++) { run(a0 + i * lane, S.white, true); run(a1 - i * lane, S.white, true); }
  run(a0 + 0.3 + L / 2, S.white, false); run(a1 - 0.3 - L / 2, S.white, false);
  // 斑马线: bars along x, `bar` wide, `gap` apart, centred on zx
  const n = Math.floor((zwid + S.zebra.gap) / (S.zebra.bar + S.zebra.gap)), span = n * S.zebra.bar + (n - 1) * S.zebra.gap;
  for (let i = 0; i < n; i++) { const x = zx - span / 2 + i * (S.zebra.bar + S.zebra.gap); marks.push(q(x, x + S.zebra.bar, a0 + 0.2, a1 - 0.2, S.white)); }
  // curbs: the near one broken at the 坡道 (a lip there), the far one whole
  const curbs: PaveBox[] = [
    ...subtract(X0, X1, [[g0, g1]]).map(([a, b]) => ({ x0: a, x1: b, y0: 0, y1: ch, z0: zw - cw, z1: zw })),
    { x0: g0, x1: g1, y0: 0, y1: S.lip, z0: zw - cw, z1: zw },
    { x0: X0, x1: X1, y0: 0, y1: ch, z0: zr - cw, z1: zr },
  ];
  const [hd, hh] = s.hedge;
  const hedge = [{ x0: X0, x1: X1, y0: 0, y1: hh - 0.06, z0: zf - hd, z1: zf, color: S.hedgeC }, { x0: X0, x1: X1, y0: hh - 0.06, y1: hh, z0: zf - hd + 0.04, z1: zf - 0.04, color: S.hedgeTop }];
  return { quads, marks, curbs, hedge };
}

/**
 * 对面人行道的高杆路灯 (campus.json `street.lamps` = [pitch, high, arm]): poles half a metre behind the far curb, a
 * pair flanking the 斑马线 `STREET_LAMP_CLEAR` past its edges (none on the crossing's mouth, so from the gate the
 * view across is not split by a pole) and every `pitch` outward to the wall's ends; each head hangs on its arm over
 * the far lanes, so the pools fall on the road, the 斑马线 and (the nearest two) the 门口. Pure data;
 * world/lamps.ts draws them with the campus lamps and lets them share the camera-nearest point lights.
 */
/** 斑马线 edge → nearest 高杆路灯 pole, m. */
export const STREET_LAMP_CLEAR = 4;
export interface StreetLamp { x: number; z: number; headZ: number; h: number }
export function streetLamps(w: WallDef, s: StreetDef): StreetLamp[] {
  if (!s.lamps) return [];
  const [pitch, h, arm] = s.lamps, X0 = w.minX - w.t / 2 + 1, X1 = w.maxX + w.t / 2 - 1;
  const z = w.minZ - w.t / 2 - s.walk - s.road - PAVE.curb[0] - 0.5, out: StreetLamp[] = [];
  const [zx, zw] = s.zebra, f = zw / 2 + STREET_LAMP_CLEAR;
  for (let x = zx - f; x >= X0; x -= pitch) out.unshift({ x, z, headZ: z + arm, h });
  for (let x = zx + f; x <= X1; x += pitch) out.push({ x, z, headZ: z + arm, h });
  return out;
}

/**
 * 井盖 / 篦子 (campus.json `covers`): flat cast iron set into the paving, 2 mm proud (over the paving, under the soil
 * and the puddles). A 雨水篦子 is a frame round slots running across its long axis (bars and slots as abutting
 * strips, nothing overlaps); a 检查井盖 is a square frame with a round lid in it, the lid's concentric grooves as thin
 * dark rings. Slots and grooves are a few centimetres: dark against the iron, they read from the sidewalk and fade
 * into a dark plate further off. Pure data; pavingGeometry draws it.
 */
export const COVER = {
  grate: [0.75, 0.45] as const, grateFrame: 0.05, slot: 0.04, bar: 0.03,
  lid: 0.8, lidR: 0.32, grooves: [0.07, 0.15, 0.23] as const, groove: 0.012, gap: 0.012,
  iron: '#5a5751', frame: '#67635b', slotC: '#2c2a27', y: 0.01,
};
export interface CoverParts { quads: PaveQuad[]; rings: { x: number; z: number; r0: number; r1: number; color: string }[]; frames: { x: number; z: number; s: number; r: number; color: string }[] }
export function coverParts(covers: CoverDef[]): CoverParts {
  const C = COVER, out: CoverParts = { quads: [], rings: [], frames: [] };
  const q = (x0: number, x1: number, z0: number, z1: number, color: string) => out.quads.push({ x0, x1, z0, z1, color, pattern: 0, tile: [1, 1] });
  for (const [kind, x, z, axis] of covers) {
    if (kind === 'lid') {
      const r = C.lidR + C.gap;
      out.frames.push({ x, z, s: C.lid, r, color: C.frame });
      out.rings.push({ x, z, r0: C.lidR, r1: r, color: C.slotC });
      let r0 = 0;
      for (const g of C.grooves) {
        out.rings.push({ x, z, r0, r1: g, color: C.iron }, { x, z, r0: g, r1: g + C.groove, color: C.slotC });
        r0 = g + C.groove;
      }
      out.rings.push({ x, z, r0, r1: C.lidR, color: C.iron });
      continue;
    }
    // along = the long axis (u), across (v); strips run across, stacked along u
    const [L, W] = C.grate, f = C.grateFrame, inner = L - 2 * f;
    const n = Math.floor((inner - C.bar) / (C.slot + C.bar)), pitch = (inner - C.bar) / n;
    const strip = (u0: number, u1: number, v0: number, v1: number, color: string) =>
      axis === 'x' ? q(x + u0, x + u1, z + v0, z + v1, color) : q(x + v0, x + v1, z + u0, z + u1, color);
    strip(-L / 2, L / 2, -W / 2, -W / 2 + f, C.frame); strip(-L / 2, L / 2, W / 2 - f, W / 2, C.frame);
    strip(-L / 2, -L / 2 + f, -W / 2 + f, W / 2 - f, C.frame); strip(L / 2 - f, L / 2, -W / 2 + f, W / 2 - f, C.frame);
    for (let i = 0; i < n; i++) {
      const u = -inner / 2 + i * pitch;
      strip(u, u + C.bar, -W / 2 + f, W / 2 - f, C.iron);
      strip(u + C.bar, u + pitch, -W / 2 + f + C.bar, W / 2 - f - C.bar, C.slotC);
      // the slot's two ends: the bearing bars along the frame
      strip(u + C.bar, u + pitch, -W / 2 + f, -W / 2 + f + C.bar, C.iron); strip(u + C.bar, u + pitch, W / 2 - f - C.bar, W / 2 - f, C.iron);
    }
    strip(inner / 2 - C.bar, inner / 2, -W / 2 + f, W / 2 - f, C.iron);
  }
  return out;
}

/** Tag a geometry with a flat colour and its `pave` attribute (pattern 0 = no joints). */
export function tag(g: THREE.BufferGeometry, color: string, pattern = 0, tile: [number, number] = [1, 1]): THREE.BufferGeometry {
  if (g.index) g = g.toNonIndexed();
  const c = new THREE.Color(color), n = g.getAttribute('position').count, col = new Float32Array(n * 3), pv = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col.set([c.r, c.g, c.b], i * 3); pv.set([pattern, tile[0], tile[1]], i * 3); }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('pave', new THREE.BufferAttribute(pv, 3));
  g.deleteAttribute('uv');
  return g;
}
const boxGeo = (b: PaveBox, color: string) => {
  const g = new THREE.BoxGeometry(b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0);
  g.translate((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2);
  return tag(g, color);
};
const flat = (x0: number, x1: number, z0: number, z1: number, y: number, color: string, pattern = 0, tile?: [number, number]) => {
  const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
  g.rotateX(-Math.PI / 2);
  g.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
  return tag(g, color, pattern, tile);
};

/** All the paving, 路缘石, 树池 and 旗杆底座 as one merged geometry (one draw call). */
export function pavingGeometry(c: CampusDef, trees: [number, number][]): THREE.BufferGeometry {
  const paving = c.paving ?? [], geos: THREE.BufferGeometry[] = [];
  for (const p of paving) for (const q of paveQuads(p)) geos.push(flat(q.x0, q.x1, q.z0, q.z1, PAVE.y, q.color, q.pattern, q.tile));
  for (const b of [...curbBoxes(paving), ...treePitBoxes(trees)]) geos.push(boxGeo(b, PAVE.curbColor));
  for (const b of hedgeBoxes(paving)) geos.push(boxGeo(b, b.color));
  for (const s of treePitSoil(trees)) geos.push(flat(s.x0, s.x1, s.z0, s.z1, s.y0, PAVE.soil));
  if (c.street) {
    const st = streetParts(c.wall, c.street, paving.find(p => p.id === 'AXIS_ROAD'));
    for (const q of st.quads) geos.push(flat(q.x0, q.x1, q.z0, q.z1, PAVE.y, q.color, q.pattern, q.tile));
    for (const q of st.marks) geos.push(flat(q.x0, q.x1, q.z0, q.z1, STREET.markY, q.color));
    for (const b of st.curbs) geos.push(boxGeo(b, PAVE.curbColor));
    for (const b of st.hedge) geos.push(boxGeo(b, b.color));
  }
  if (c.covers) {
    const cv = coverParts(c.covers);
    for (const q of cv.quads) geos.push(flat(q.x0, q.x1, q.z0, q.z1, COVER.y, q.color));
    for (const r of cv.rings) {
      const g = r.r0 > 0 ? new THREE.RingGeometry(r.r0, r.r1, 24, 1) : new THREE.CircleGeometry(r.r1, 24);
      g.rotateX(-Math.PI / 2); g.translate(r.x, COVER.y, r.z); geos.push(tag(g, r.color));
    }
    for (const f of cv.frames) {
      const sh = new THREE.Shape().moveTo(-f.s / 2, -f.s / 2).lineTo(f.s / 2, -f.s / 2).lineTo(f.s / 2, f.s / 2).lineTo(-f.s / 2, f.s / 2).lineTo(-f.s / 2, -f.s / 2);
      sh.holes.push(new THREE.Path().absarc(0, 0, f.r, 0, Math.PI * 2, true));
      const g = new THREE.ShapeGeometry(sh, 6);
      g.rotateX(-Math.PI / 2); g.translate(f.x, COVER.y, f.z); geos.push(tag(g, f.color));
    }
  }
  for (const p of c.platforms) for (const b of flagPoleParts(p)) {
    if (!b.oct) { geos.push(boxGeo(b, b.color)); continue; }
    const g = new THREE.CylinderGeometry(b.oct[1], b.oct[0], b.y1 - b.y0, 8, 1, true);
    g.translate(b.x0, (b.y0 + b.y1) / 2, b.z0);
    geos.push(tag(g, b.color));
  }
  // 田径场 + 看台 (world/field.ts) ride in the same mesh: the weather tint and lying snow come with it
  if (c.field) geos.push(fieldGeometry(c.field));
  return mergeGeometries(geos)!;
}

/**
 * Patch the paving material: per-fragment joints from the `pave` attribute (paveShade's maths, footprint from
 * fwidth). Applied before the vertex colour, so the snow patch chained after it (render/snowcover.ts) covers them.
 */
export function patchPaving(mat: THREE.MeshLambertMaterial): void {
  const f = (v: number) => v.toFixed(4);
  mat.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 pave; varying vec3 vPave; varying vec2 vPaveW;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vPave = pave; vPaveW = (modelMatrix * vec4(transformed, 1.0)).xz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vPave; varying vec2 vPaveW;
        float paveHash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }`)
      .replace('#include <color_fragment>', `
        if (vPave.x > 3.5) {
          float mpz = max(fwidth(vPaveW.y), 1e-5), k = smoothstep(${f(PAVE.fadePx[0] / 2)}, ${f(PAVE.fadePx[0])}, vPave.z / mpz);
          diffuseColor.rgb *= mix(${f((1 + PAVE.mow) / 2)}, mod(floor(vPaveW.y / vPave.z), 2.0) > 0.5 ? ${f(PAVE.mow)} : 1.0, k);
        } else if (vPave.x > 0.5) {
          vec2 tile = vPave.yz, uv = vPaveW / tile, mpp = max(fwidth(vPaveW), vec2(1e-5));
          float row = floor(uv.y);
          if (vPave.x < 1.5) uv.x += mod(row, 2.0) * 0.5;
          float col = floor(uv.x);
          vec2 fr = fract(uv), d = min(fr, 1.0 - fr) * tile;
          vec2 fa = smoothstep(vec2(${f(PAVE.fadePx[0])}), vec2(${f(PAVE.fadePx[1])}), tile / mpp);
          float s = 1.0 + (paveHash(vec2(col, row)) - 0.5) * ${f(2 * PAVE.jitter)} * min(fa.x, fa.y);
          if (d.x < mpp.x * 0.5) s = mix(s, ${f(PAVE.joint)}, fa.x);
          if (d.y < mpp.y * 0.5) s = mix(s, ${f(PAVE.joint)}, fa.y);
          if (vPave.x > 2.5) {
            float odd = mod(col + row, 2.0);
            vec2 r = tile / mpp; float k = smoothstep(${f(PAVE.fadePx[0] / 2)}, ${f(PAVE.fadePx[0])}, min(r.x, r.y));
            s *= mix(${f((1 + PAVE.checker) / 2)}, odd > 0.5 ? ${f(PAVE.checker)} : 1.0, k);
          }
          diffuseColor.rgb *= s;
        }
        #include <color_fragment>`);
  };
  mat.customProgramCacheKey = () => 'paving';
}
