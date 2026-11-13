import { floorStack, WALL_T, type BuildingDef, type Side } from '../../../../shared/campus/campus_schema.ts';
import { facadeOpenings } from './building.ts';
import { STAIR, stairPlan, type LBox, type StairPlan } from '../../../../shared/campus/stairs.ts';
import type { Face, FurnBox, Kind } from './classroom.ts';
import type { PosterDef } from './decals.ts';

/**
 * 楼梯间陈设 (打磨批次③): on every 休息平台 a 四柱 cast-iron radiator in 银粉 against the end wall (the +dir end, the
 * outer wall), under the 休息平台 window if there is one, else beside the storey windows that wall has; all of a
 * stairwell's radiators stacked on one 立管 (单管顺流: a 支管 into the top hub, one out of the bottom) that keeps clear of
 * every window. On the 1F 楼层平台 a 消火栓箱 on the door wall beside the door, dull red steel with white words on its
 * 铁皮门 (a 墙面贴, `hydrantPosters`: no pure red, 红蓝只属于警车). Pure; the boxes go into classroom.ts storeyFurniture
 * (a storey's mesh also carries the radiator of the 休息平台 below it, seen down the flight); none of them cast light
 * shadows (render/interior_light.ts occluders).
 */
export const STAIRFIT = {
  /** sections (at most, `min` in a narrow pier), pitch along the wall, column width, height (hubs included), depth, off the wall, off the landing, hub band */
  rad: { n: 18, min: 8, pitch: 0.06, col: 0.04, h: 0.68, d: 0.14, wall: 0.05, lift: 0.12, hub: 0.07 },
  /** 立管 / 支管: square section, centre off the wall, off the radiator's end; clear of a window's edge by (the radiator
   *  by `block`); the radiator kept off the wall's ends by; the longest 支管 */
  pipe: { t: 0.035, c: 0.1, off: 0.08, clear: 0.15, block: 0.06, end: 0.15, reach: 0.35 },
  /** 消火栓箱: wide × high × deep, bottom above the floor, off the door jamb; its 铁皮门 inset; the white words' strip */
  hyd: { w: 0.65, h: 0.8, d: 0.16, y0: 0.7, jamb: 0.3, inset: 0.03, label: { w: 0.5, h: 0.22, top: 0.09 } },
  /** 安全出口 灯箱 over each stairwell door, both faces of its wall: wide × high × deep, bottom above the floor, its lit face inset */
  exit: { w: 0.36, h: 0.14, d: 0.04, y0: 2.5, inset: 0.012 },
};

/** A 安全出口 sign (world): its lit face's centre, the unit normal it faces (plan), the storey floor. */
export interface ExitSign { x: number; y: number; z: number; nx: number; nz: number; floor: number }
/** Every stairwell door's two 安全出口 signs, every storey (world): on the stairwell side and the corridor side. */
export function exitSigns(b: BuildingDef): ExitSign[] {
  const out: ExitSign[] = [], E = STAIRFIT.exit;
  for (const p of (b.stairwells ?? []).map(q => stairPlan(b, q, WALL_T))) {
    const vc = (p.door[0] + p.door[1]) / 2, o = p.at(0, vc), i = p.at(1, vc), nx = i.x - o.x, nz = i.z - o.z;
    for (const st of p.storeys) for (const [a, sg] of [[E.d, 1], [-STAIR.encl - E.d, -1]] as const) {
      const c = p.at(a, vc);
      out.push({ x: b.x + c.x, y: st.y + E.y0 + E.h / 2, z: b.z + c.z, nx: nx * sg, nz: nz * sg, floor: st.y });
    }
  }
  return out;
}

/** One stairwell's radiators: across span of the group, the 立管's across position and height span, the landings. */
export interface StairFit {
  p: StairPlan; L: number; v: [number, number]; riser: number; ry: [number, number];
  rads: { level: number; y: number }[];
}

const across = (p: StairPlan): [number, number] => (p.def.dir[1] === 'x' ? [p.clear.z0, p.clear.z1] : [p.clear.x0, p.clear.x1]);
const inAny = (u: number, spans: [number, number][]) => spans.some(([a, b]) => u > a && u < b);

/** Where each stairwell's radiators and 立管 go (building-local plan), memoised per building. */
export function stairFits(b: BuildingDef): StairFit[] {
  const hit = MEMO.get(b);
  if (hit) return hit;
  const R = STAIRFIT.rad, P = STAIRFIT.pipe, out: StairFit[] = [];
  const ops = b.facade ? facadeOpenings(b) : [];
  for (const p of (b.stairwells ?? []).map(q => stairPlan(b, q, WALL_T))) {
    const rads = p.storeys.filter(st => st.mid).map(st => ({ level: st.level, y: st.mid!.y1 }));
    if (!rads.length) continue;
    const [c0, c1] = across(p), lo = c0 + P.end, hi = c1 - P.end;
    const L = p.def.dir[1] === 'x' ? p.clear.x1 - p.clear.x0 : p.clear.z1 - p.clear.z0;
    const wall = p.walls.includes(p.def.dir) ? [] : ops.filter(o => o.side === p.def.dir && !o.court);
    const pad = (k: number) => (o: { u0: number; u1: number }): [number, number] => [o.u0 - k, o.u1 + k];
    // the radiator keeps out of every opening it would stand in front of on any landing; the 立管 out of all of them
    const block = wall.filter(o => rads.some(r => o.y0 < r.y + R.lift + R.h && o.y1 > r.y + R.lift)).map(pad(P.block));
    const all = wall.map(pad(P.clear));
    // a radiator `len` long: centred on the wall (under the 休息平台 window) if it can be, else in the middle of the
    // widest free stretch; its 立管 a little past one end, pushed on past a window there (the shorter 支管 wins)
    const place = (len: number): { v: [number, number]; riser: number } | null => {
      const free = (m: number) => m - len / 2 >= lo && m + len / 2 <= hi && !block.some(([a, q]) => a < m + len / 2 && q > m - len / 2);
      let m = (c0 + c1) / 2;
      if (!free(m)) {
        const cuts = [lo, ...block.flat().filter(u => u > lo && u < hi), hi].sort((x, y) => x - y);
        const gaps = cuts.slice(1).map((u, i) => [cuts[i], u] as [number, number]).filter(([a, q]) => free((a + q) / 2));
        if (!gaps.length) return null;
        const g = gaps.reduce((x, y) => (y[1] - y[0] > x[1] - x[0] ? y : x));
        m = (g[0] + g[1]) / 2;
      }
      const v: [number, number] = [m - len / 2, m + len / 2];
      const side = (k: -1 | 1) => {
        let u = (k < 0 ? v[0] : v[1]) + k * P.off;
        for (const [a, q] of [...all].sort((x, y) => k * (x[0] - y[0]))) if (u > a && u < q) u = k < 0 ? a : q;
        return { u, e: k < 0 ? v[0] : v[1] };
      };
      const ends = ([-1, 1] as const).map(side).filter(({ u, e }) => u >= c0 + P.t && u <= c1 - P.t && !inAny(u, all) && Math.abs(u - e) <= P.reach);
      if (!ends.length) return null;
      return { v, riser: ends.reduce((x, y) => (Math.abs(y.u - y.e) < Math.abs(x.u - x.e) ? y : x)).u };
    };
    // a pier between two windows takes fewer sections, so its 立管 still fits beside it
    let fit: ReturnType<typeof place> = null;
    for (let n = R.n; n >= R.min && !fit; n -= 2) fit = place(n * R.pitch);
    if (!fit) continue;
    const { v, riser } = fit;
    const top = rads[rads.length - 1].y + R.lift + R.h - R.hub / 2;
    out.push({ p, L, v, riser, ry: [p.storeys[0].y, top + P.t / 2], rads });
  }
  MEMO.set(b, out);
  return out;
}
const MEMO = new WeakMap<BuildingDef, StairFit[]>();

/** The 消火栓箱 of a stairwell: on its 1F (else lowest) 楼层平台, the door wall's inner face, the flight-1 side of the door. */
export function hydrantSpot(p: StairPlan): { level: number; y: number; u: number; ax: 'x' | 'z' } | null {
  const H = STAIRFIT.hyd, st = p.storeys.find(q => q.level === 1) ?? p.storeys[0];
  const u = p.door[0] - H.jamb - H.w / 2, [c0] = across(p);
  if (u - H.w / 2 < c0 + 0.05) return null;
  return { level: st.level, y: st.y, u, ax: p.def.dir[1] === 'x' ? 'z' : 'x' };
}

/**
 * A storey's 楼梯间陈设 (building-local, y = world height): the radiators on its 休息平台 and, seen down flight 2 from
 * its 楼层平台, the one below; the 立管 from the landing below to its ceiling; its 消火栓箱. Colliders: its own
 * radiators and the box.
 */
export function stairFurniture(b: BuildingDef, level: number): { render: FurnBox[]; solid: LBox[] } {
  const render: FurnBox[] = [], solid: LBox[] = [];
  const st = floorStack(b).find(s => s.level === level);
  if (!st) return { render, solid };
  const R = STAIRFIT.rad, P = STAIRFIT.pipe, H = STAIRFIT.hyd;
  for (const f of stairFits(b)) {
    if (!f.p.storeys.some(q => q.level === level)) continue;
    const p = f.p, back = p.def.dir, sides: Side[] = p.def.dir[1] === 'x' ? ['+z', '-z'] : ['+x', '-x'];
    // a box k0..k1 out from the end wall's face, across u0..u1
    const put = (kind: Kind, k0: number, k1: number, u0: number, u1: number, y0: number, y1: number, skip: Face[]) =>
      render.push({ ...p.span(f.L - k1, f.L - k0, u0, u1), y0, y1, kind, skip });
    const own = f.rads.find(r => r.level === level), below = f.rads.filter(r => r.level < level).pop(), above = f.rads.find(r => r.level > level);
    for (const r of [own, below]) {
      if (!r) continue;
      const y0 = r.y + R.lift, y1 = y0 + R.h, k0 = R.wall, k1 = R.wall + R.d;
      // 四柱 sections (the end two on 足片 down to the landing), the dark between them, the 对丝 bands top and bottom
      const n = Math.round((f.v[1] - f.v[0]) / R.pitch);
      for (let i = 0; i < n; i++) {
        const u = f.v[0] + i * R.pitch + (R.pitch - R.col) / 2, foot = i === 0 || i === n - 1;
        put('radIron', k0, k1, u, u + R.col, foot ? r.y : y0, y1, ['bottom', back]);
      }
      put('radGap', k0 + 0.03, k1 - 0.03, f.v[0], f.v[1], y0 + R.hub, y1 - R.hub, ['top', 'bottom', back, ...sides]);
      // (the top one's lid a hair under the sections' tops: no z-fight, it shows only down the slots)
      for (const [a, q] of [[y1 - R.hub, y1 - 0.01], [y0, y0 + R.hub]]) put('radIron', k0 + 0.02, k1 - 0.02, f.v[0], f.v[1], a, q, ['bottom', back, ...sides]);
      // 支管 from the 立管 into the top and the bottom band
      const [u0, u1] = f.riser < f.v[0] ? [f.riser, f.v[0]] : [f.v[1], f.riser];
      for (const y of [y1 - R.hub / 2, y0 + R.hub / 2]) put('radIron', P.c - P.t / 2, P.c + P.t / 2, u0, u1, y - P.t / 2, y + P.t / 2, [back]);
      if (r === own) solid.push({ ...p.span(f.L - k1, f.L, f.v[0], f.v[1]), y0: r.y, y1 });
    }
    // the 立管, from the landing below (the lowest floor) up into the landing above: from this 休息平台 the end wall
    // shows up to the next one's soffit
    const lo = below ? below.y : f.ry[0], hi = Math.min(f.ry[1], above ? above.y : Infinity);
    if (hi > lo) put('radIron', P.c - P.t / 2, P.c + P.t / 2, f.riser - P.t / 2, f.riser + P.t / 2, lo, hi, ['top', 'bottom', back]);
  }
  for (const p of (b.stairwells ?? []).map(q => stairPlan(b, q, WALL_T))) {
    const h = hydrantSpot(p);
    if (!h || h.level !== level) continue;
    const sides: Side[] = h.ax === 'z' ? ['+z', '-z'] : ['+x', '-x'];
    // k out from the door wall's inner face (a = 0), across u
    const put = (kind: Kind, k0: number, k1: number, u0: number, u1: number, y0: number, y1: number, skip: Face[]) =>
      render.push({ ...p.span(k0, k1, u0, u1), y0: h.y + y0, y1: h.y + y1, kind, skip });
    const u0 = h.u - H.w / 2, u1 = h.u + H.w / 2, d = H.d, i = H.inset, thin: Face[] = ['top', 'bottom', p.doorSide, ...sides];
    put('hydBox', 0, d, u0, u1, H.y0, H.y0 + H.h, [p.doorSide]);
    // the 铁皮门 (its seam inset all round), the glass over the coiled 水带 (two crossed panels and its dark eye), the
    // handle; the white words are a 墙面贴 on the door above the glass (hydrantPosters)
    put('hydDoor', d, d + 0.006, u0 + i, u1 - i, H.y0 + i, H.y0 + H.h - i, thin);
    const gTop = H.h - H.label.top - H.label.h - 0.03;
    put('extGlass', d + 0.006, d + 0.01, u0 + 0.08, u1 - 0.08, H.y0 + 0.08, H.y0 + gTop, thin);
    const cy = H.y0 + (0.08 + gTop) / 2;
    put('hydHose', d + 0.01, d + 0.013, h.u - 0.17, h.u + 0.17, cy - 0.12, cy + 0.12, thin);
    put('hydHose', d + 0.01, d + 0.013, h.u - 0.12, h.u + 0.12, cy - 0.17, cy + 0.17, thin);
    put('radGap', d + 0.013, d + 0.015, h.u - 0.03, h.u + 0.03, cy - 0.03, cy + 0.03, thin);
    put('camLens', d + 0.006, d + 0.03, u1 - i - 0.05, u1 - i - 0.025, cy - 0.06, cy + 0.06, ['bottom', p.doorSide]);
    solid.push({ ...p.span(0, d, u0, u1), y0: h.y + H.y0, y1: h.y + H.y0 + H.h });
  }
  // 安全出口 灯箱 over the door, both faces of the enclosure wall: a pale case, its green face lit day and night
  const E = STAIRFIT.exit;
  for (const p of (b.stairwells ?? []).map(q => stairPlan(b, q, WALL_T))) {
    const st = p.storeys.find(q => q.level === level);
    if (!st) continue;
    const vc = (p.door[0] + p.door[1]) / 2, u0 = vc - E.w / 2, u1 = vc + E.w / 2, y0 = st.y + E.y0, y1 = y0 + E.h;
    const sides: Side[] = p.def.dir[1] === 'x' ? ['+z', '-z'] : ['+x', '-x'], into = p.def.dir;
    for (const [a0, a1, face] of [[0, E.d, into], [-STAIR.encl - E.d, -STAIR.encl, p.doorSide]] as const) {
      const lit = face === into ? a1 : a0, back: Side = face === into ? p.doorSide : into;
      render.push({ ...p.span(a0, a1, u0, u1), y0, y1, kind: 'exitCase', skip: [back] });
      render.push({ ...p.span(Math.min(lit, lit + (face === into ? 0.004 : -0.004)), Math.max(lit, lit + (face === into ? 0.004 : -0.004)), u0 + E.inset, u1 - E.inset), y0: y0 + E.inset, y1: y1 - E.inset,
        kind: 'exitSign', skip: ['top', 'bottom', back, ...sides], glow: 'led', phase: 1.5 });
    }
  }
  return { render, solid };
}

/** The 消火栓箱 doors' words, as 墙面贴 ('tin': white on the door's dull red, `out` = off the wall onto the door). */
export function hydrantPosters(buildings: BuildingDef[]): Record<string, PosterDef> {
  const out: Record<string, PosterDef> = {}, H = STAIRFIT.hyd;
  for (const b of buildings) for (const s of b.stairwells ?? []) {
    const p = stairPlan(b, s, WALL_T), h = hydrantSpot(p);
    if (!h) continue;
    out[`${b.id}.${s.id}.hydrant`] = {
      wall: `${b.id}.${s.id}`, levels: [h.level], side: p.doorSide, face: 'in', u: h.u - (h.ax === 'x' ? s.x : s.z),
      y: H.y0 + H.h - H.label.top - H.label.h / 2, w: H.label.w, h: H.label.h, style: 'tin', text: '消火栓', sub: '火警 119', out: H.d + 0.006,
    };
  }
  return out;
}
