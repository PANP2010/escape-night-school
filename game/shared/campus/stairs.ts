import type { BuildingDef, Side, StairwellDef } from './campus_schema.ts';
import { buildingHeight, floorStack } from './campus_schema.ts';

/**
 * 楼梯间 layout (docs/03_campus.md 室内): a 双跑楼梯 in a stairwell rect, building-local, pure (no three) so the
 * validator, the colliders and the renderer (world/interior.ts) share one plan. Per storey: a 楼层平台 at the -dir end
 * (the door in the -dir enclosure wall opens onto it), flight 1 climbing along `dir` on the -across half, a 休息平台 at
 * the far end half a storey up, flight 2 coming back on the +across half to the next 楼层平台. A 梯井 between the
 * flights carries the 栏板 + handrail on both sides.
 */
export const STAIR = {
  rise: 0.15, run: 0.28, landing: 1.6, gap: 0.3, encl: 0.2, rail: 0.95, slab: 0.2,
  /** 顶层水平护栏 height above the top 楼层平台 (GB 50099 中小学校: 水平扶手 ≥ 1.10 m) */ guard: 1.1,
  /** depth of the flight's sloped soffit under the tread nosing line */ waist: 0.45,
  minMid: 1.2, minFlight: 1.0, door: { w: 1.6, h: 2.4 },
  /** 出屋面 bulkhead height above the roof slab (a `roof` stair's last storey) */ roofH: 2.8,
};

/** Axis-aligned rect, building-local. */
export interface LRect { x0: number; x1: number; z0: number; z1: number }
/** A box, building-local. */
/** `floor`: a walkable raised floor (the 观众席's tiers): route planning walks over it instead of round it */
export interface LBox extends LRect { y0: number; y1: number; floor?: true }
/** A straight flight: foot at along-distance `a` from the door end, climbing `dir` (sg = ±1 in plan) from `y`. */
export interface Flight { a: number; v0: number; v1: number; dir: Side; steps: number; rise: number; run: number; y: number }
export interface StoreyStairs { level: number; y: number; h: number; flight1?: Flight; mid?: LBox; flight2?: Flight; landing?: LBox }
export interface StairPlan {
  def: StairwellDef; rect: LRect; clear: LRect;
  /** stairwell sides that are enclosure walls (the others lie on the outer wall) */
  walls: Side[];
  /** the enclosure side the doors are in (the -dir end) and the door span across it (building-local) */
  doorSide: Side; door: [number, number];
  storeys: StoreyStairs[];
  /** 梯井 between the flights (plan) and the height its guard reaches */
  gap: LRect; gapY: [number, number];
  /** guard across the flight-1 half at the top 楼层平台 (nothing climbs on from there) */
  topRail: LBox;
  /** plan mapping: along-distance a (from the door end) + across v → building-local x, z */
  at(a: number, v: number): { x: number; z: number };
  span(a0: number, a1: number, va: number, vb: number): LRect;
}

/** a − hole, as up to four rects (hole assumed inside a or disjoint). */
export function rectMinus(a: LRect, h: LRect): LRect[] {
  if (h.x1 <= a.x0 || h.x0 >= a.x1 || h.z1 <= a.z0 || h.z0 >= a.z1) return [a];
  const out: LRect[] = [];
  if (h.z0 > a.z0) out.push({ ...a, z1: h.z0 });
  if (h.z1 < a.z1) out.push({ ...a, z0: h.z1 });
  const z0 = Math.max(a.z0, h.z0), z1 = Math.min(a.z1, h.z1);
  if (h.x0 > a.x0) out.push({ x0: a.x0, x1: h.x0, z0, z1 });
  if (h.x1 < a.x1) out.push({ x0: h.x1, x1: a.x1, z0, z1 });
  return out;
}

export const opp = (s: Side): Side => ((s[0] === '+' ? '-' : '+') + s[1]) as Side;

/** Whether a stairwell side lies on the building's outer wall. */
export function onOuterWall(b: BuildingDef, s: StairwellDef, side: Side): boolean {
  const e = 1e-6;
  switch (side) {
    case '+x': return Math.abs(s.x + s.w / 2 - b.w / 2) < e;
    case '-x': return Math.abs(s.x - s.w / 2 + b.w / 2) < e;
    case '+z': return Math.abs(s.z + s.d / 2 - b.d / 2) < e;
    default: return Math.abs(s.z - s.d / 2 + b.d / 2) < e;
  }
}

/** Risers of one flight for a storey of height h (two flights per storey, risers ≈ STAIR.rise). */
/** Top of a stairwell's enclosure (building-local y): its top storey's ceiling, or `cap` above that storey's floor. */
export function stairTop(p: StairPlan): number {
  const t = p.storeys[p.storeys.length - 1];
  return t.y + (p.def.cap ?? t.h);
}

export const flightRisers = (h: number) => Math.max(2, Math.round(h / 2 / STAIR.rise));

/** Layout of one stairwell; `wallT` = outer wall thickness. Never throws: `stairProblems` says whether it fits. */
export function stairPlan(b: BuildingDef, s: StairwellDef, wallT: number): StairPlan {
  const rect: LRect = { x0: s.x - s.w / 2, x1: s.x + s.w / 2, z0: s.z - s.d / 2, z1: s.z + s.d / 2 };
  const walls = (['+x', '-x', '+z', '-z'] as Side[]).filter(side => !onOuterWall(b, s, side));
  const inset = (side: Side) => (walls.includes(side) ? STAIR.encl : wallT);
  const clear: LRect = { x0: rect.x0 + inset('-x'), x1: rect.x1 - inset('+x'), z0: rect.z0 + inset('-z'), z1: rect.z1 - inset('+z') };
  const ax = s.dir[1] as 'x' | 'z', sg = s.dir[0] === '+' ? 1 : -1;
  const [u0, u1] = ax === 'x' ? [clear.x0, clear.x1] : [clear.z0, clear.z1];
  const [v0, v1] = ax === 'x' ? [clear.z0, clear.z1] : [clear.x0, clear.x1];
  const uStart = sg > 0 ? u0 : u1, L = u1 - u0, W = v1 - v0;
  const fw = (W - STAIR.gap) / 2;
  const at = (a: number, v: number) => (ax === 'x' ? { x: uStart + sg * a, z: v } : { x: v, z: uStart + sg * a });
  const span = (a0: number, a1: number, va: number, vb: number): LRect => {
    const p = at(a0, va), q = at(a1, vb);
    return { x0: Math.min(p.x, q.x), x1: Math.max(p.x, q.x), z0: Math.min(p.z, q.z), z1: Math.max(p.z, q.z) };
  };
  const doorSide = opp(s.dir);
  // the 楼层平台 runs under the door-side enclosure wall and out to the stairwell's side edges
  const [r0, r1] = ax === 'x' ? [rect.z0, rect.z1] : [rect.x0, rect.x1];
  const storeys: StoreyStairs[] = [];
  let flen = 0, lowest = Infinity, top = 0;
  // 上屋面: the roof is one more storey, its floor the roof slab, its ceiling the bulkhead's lid
  const stack = floorStack(b), last = s.roof ? s.to + 1 : s.to;
  if (s.roof) stack.push({ level: last, y: buildingHeight(b), h: STAIR.roofH });
  for (const st of stack) {
    if (st.level < s.from || st.level > last) continue;
    const out: StoreyStairs = { level: st.level, y: st.y, h: st.h };
    lowest = Math.min(lowest, st.y); top = st.y;
    if (st.level > s.from) out.landing = { ...span(-STAIR.encl, STAIR.landing, r0, r1), y0: st.y - STAIR.slab, y1: st.y };
    if (st.level < last) {
      const n = flightRisers(st.h), rise = st.h / 2 / n, steps = n - 1, len = steps * STAIR.run;
      flen = Math.max(flen, len);
      out.flight1 = { a: STAIR.landing, v0, v1: v0 + fw, dir: s.dir, steps, rise, run: STAIR.run, y: st.y };
      out.mid = { ...span(STAIR.landing + len, L, v0, v1), y0: st.y + st.h / 2 - STAIR.slab, y1: st.y + st.h / 2 };
      out.flight2 = { a: STAIR.landing + len, v0: v1 - fw, v1, dir: opp(s.dir), steps, rise, run: STAIR.run, y: st.y + st.h / 2 };
    }
    storeys.push(out);
  }
  const gap = span(STAIR.landing, STAIR.landing + flen, v0 + fw, v1 - fw);
  const vc = (v0 + v1) / 2;
  const door: [number, number] = [vc - STAIR.door.w / 2, vc + STAIR.door.w / 2];
  const topRail = { ...span(STAIR.landing, STAIR.landing + 0.08, v0, v0 + fw), y0: top, y1: top + STAIR.guard };
  return { def: s, rect, clear, walls, doorSide, door, storeys, gap, gapY: [lowest, top + STAIR.rail], topRail, at, span };
}

/** Why a stairwell cannot hold its stairs (empty = fits). */
export function stairProblems(b: BuildingDef, s: StairwellDef, wallT: number): string[] {
  const errs: string[] = [];
  const p = stairPlan(b, s, wallT);
  if (!p.walls.includes(p.doorSide)) errs.push(`the ${p.doorSide} end (door side) lies on the outer wall`);
  const ax = s.dir[1];
  const L = ax === 'x' ? p.clear.x1 - p.clear.x0 : p.clear.z1 - p.clear.z0;
  const W = ax === 'x' ? p.clear.z1 - p.clear.z0 : p.clear.x1 - p.clear.x0;
  if ((W - STAIR.gap) / 2 < STAIR.minFlight - 1e-6) errs.push(`too narrow for two flights (${W.toFixed(2)} m clear)`);
  if (W < STAIR.door.w) errs.push('too narrow for the door');
  for (const st of p.storeys) if (st.flight1) {
    const need = STAIR.landing + st.flight1.steps * STAIR.run + STAIR.minMid;
    if (L < need - 1e-6) errs.push(`level ${st.level}: needs ${need.toFixed(2)} m along ${s.dir}, has ${L.toFixed(2)}`);
  }
  return errs;
}

/**
 * Tread boxes of a flight (building-local). Step i's top is the tread; its underside follows the sloped soffit
 * (never below the flight's foot), so there is headroom under upper flights and nothing to fall through above.
 */
export function flightBoxes(p: StairPlan, f: Flight): LBox[] {
  const out: LBox[] = [];
  const sg = f.dir === p.def.dir ? 1 : -1;
  for (let i = 0; i < f.steps; i++) {
    const a0 = f.a + sg * i * f.run, a1 = a0 + sg * f.run;
    const top = f.y + (i + 1) * f.rise;
    out.push({ ...p.span(Math.min(a0, a1), Math.max(a0, a1), f.v0, f.v1), y0: Math.max(f.y, top - STAIR.waist), y1: top });
  }
  return out;
}
