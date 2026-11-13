import * as THREE from 'three';
import { buildingHeight, courtRect, entranceLevel, entranceY, floorStack, isHollow, PARAPET, parseNightRoom, WALL_T, type BuildingDef, type CanopyDims, type Side } from '../../../../shared/campus/campus_schema.ts';
import { rectMinus, STAIR, stairPlan, type StairPlan } from '../../../../shared/campus/stairs.ts';
import { Rng } from '../core/rng.ts';
import { GLASS_NIGHT_ONLY, paneSeed, roofSeed, SURF } from '../render/facade.ts';
import { CANOPY, canopyOf } from './shelter.ts';
import { rectOf, storeyRooms } from './rooms.ts';

/**
 * 建筑生成器 (docs/03_campus.md 建筑外观): one BuildingDef → one non-indexed, flat-normal, vertex-coloured
 * BufferGeometry in world space (one mesh = one draw call per building). Outer walls are cut into horizontal bands
 * around every opening (so a row of windows costs one pier quad each), openings get recessed reveals (their creases
 * are what the ink pass draws as the window outline), a frame plate and two glass panes; plus a plinth (勒脚), a belt
 * course at every floor slab, a cornice, a parapet (女儿墙) and the roof slab. Pure geometry (no scene), for tests.
 */

const PLINTH = { h: 0.45, out: 0.05, shade: 0.8 };
const BELT = { h: 0.18, out: 0.05, shade: 0.93 };
export const CORNICE = { h: 0.3, out: 0.12, shade: 0.9 };
/** 煤仓's 投煤口 (campus.json coalStore): a sheet-iron lid w × h from y up, 铁红 like the 煤仓门 (classroom.ts ironDoor), a 挂锁 */
export const COAL_HATCH = { w: 0.9, h: 0.75, y: 1.0, color: '#c48a6c', lock: '#8a8270' };
/** parapet wall thickness */
export const PARAPET_T = 0.24;
/** frame border around the glass, the mullion between the two panes, and how far the glass sits proud of the frame */
export const FRAME_W = 0.07, MULLION = 0.06;
const GLASS_OUT = 0.015;
const REVEAL_SHADE = 0.86;
export const ROOF_SHADE = 0.78;
const DEFAULT_FRAME = '#8b8676', DEFAULT_GLASS = '#56636a', DOOR_GLASS = '#4a5559';
/** windows light up per room-sized group of this width along the wall (a classroom's windows go on together) */
const ROOM_W = 9;

/** 0..1 from a string (FNV-1a → mulberry32): stable per-pane seeds without threading an RNG through the builder. */
export function hash01(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  return new Rng(h).next();
}

/**
 * An opening in one outer wall: along-wall span [u0, u1], height [y0, y1] above ground, recessed by `depth`. `court`:
 * in a 天井 wall instead (`side` = the way that wall's facade faces, into the void; u from the void's centre line).
 */
export interface Opening {
  side: Side; u0: number; u1: number; y0: number; y1: number; depth: number; kind: 'window' | 'entrance'; court?: boolean;
  /** a 休息平台 window of a stairwell (`windows: 'landing'`): half a storey up, the belt course breaks round it */
  stair?: string;
  /** 推拉小窗 (WindowDef.hatch): the -u half open, a 递物台 this deep outside */
  hatch?: number;
  /** an entrance's 雨棚 (shelter.ts canopyOf) */
  canopy?: CanopyDims;
}

/**
 * A facade plane in plan (world): outward normal `n` (into the open air), its centre point `o`, length `len`; the
 * along-wall tangent is +z for ±x faces, +x for ±z faces. The 4 outer walls, then (回字形) the 4 天井 walls, whose
 * facades face into the void: `court` faces meet in concave corners (courses stop short there, parapets reach round).
 */
export interface Frame { side: Side; court: boolean; n: [number, number]; o: [number, number]; len: number }
const SIDES: Side[] = ['+x', '-x', '+z', '-z'];
const normal = (s: Side): [number, number] => (s[1] === 'x' ? [s[0] === '+' ? 1 : -1, 0] : [0, s[0] === '+' ? 1 : -1]);
export function facadeFrames(b: BuildingDef): Frame[] {
  const out: Frame[] = SIDES.map(side => {
    const n = normal(side), half = side[1] === 'x' ? b.w / 2 : b.d / 2;
    return { side, court: false, n, o: [b.x + n[0] * half, b.z + n[1] * half], len: side[1] === 'x' ? b.d : b.w };
  });
  const c = b.courtyard;
  if (c) for (const side of SIDES) {
    // the wall on the far side of the void from where its facade looks
    const n = normal(side);
    out.push({ side, court: true, n, o: [b.x + c.x - n[0] * c.w / 2, b.z + c.z - n[1] * c.d / 2], len: side[1] === 'x' ? c.d : c.w });
  }
  return out;
}

/**
 * 天井 openings: its ground-floor doors (`courtyard.doors`, open doorways, no 雨棚) and the building's facade rule run
 * along each courtyard wall; a door replaces the ground-floor windows it hits, as an entrance does outside.
 */
export function courtOpenings(b: BuildingDef): Opening[] {
  const f = b.facade, out: Opening[] = [], c = b.courtyard;
  if (!c) return out;
  const doors = c.doors ?? [];
  for (const e of doors) out.push({ side: e.side, u0: e.at - e.width / 2, u1: e.at + e.width / 2, y0: 0, y1: e.height, depth: f?.depth ?? 0.2, kind: 'entrance', court: true });
  if (!f) return out;
  for (const fr of facadeFrames(b).filter(q => q.court)) {
    // a light well is seen from inside at close range: every other bay is enough, and keeps A under the 5k budget
    const bay = f.bay * 2, n = Math.floor((fr.len - 2 * (f.margin ?? 1.2)) / bay);
    for (const st of floorStack(b)) if (st.level >= 1) for (let i = 0; i < n; i++) {
      const u = (i - (n - 1) / 2) * bay, y0 = st.y + f.sill, u0 = u - f.width / 2, u1 = u + f.width / 2;
      if (st.level === 1 && doors.some(e => e.side === fr.side && u0 < e.at + e.width / 2 + 0.2 && e.at - e.width / 2 - 0.2 < u1)) continue;
      out.push({ side: fr.side, u0, u1, y0, y1: y0 + f.height, depth: f.depth, kind: 'window', court: true });
    }
  }
  return out;
}

/**
 * A frame as vectors: outward normal n, along-wall tangent t, and `at(u, y, off)` = the world point `u` along the wall,
 * `y` up, `off` out from the wall plane (into the open air: the street, or the 天井).
 */
export function frameAxes(fr: Frame) {
  const n = new THREE.Vector3(fr.n[0], 0, fr.n[1]), t = fr.side[1] === 'x' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  const at = (u: number, y: number, off = 0) => new THREE.Vector3(fr.o[0] + n.x * off + t.x * u, y, fr.o[1] + n.z * off + t.z * u);
  return { n, t, at };
}

/** Wall frame of a side: outward normal n, along-wall tangent t, half extent to the wall plane, wall length. */
function sideFrame(b: BuildingDef, side: Side) {
  const s = side[0] === '+' ? 1 : -1;
  return side[1] === 'x'
    ? { n: new THREE.Vector3(s, 0, 0), t: new THREE.Vector3(0, 0, 1), half: b.w / 2, len: b.d }
    : { n: new THREE.Vector3(0, 0, s), t: new THREE.Vector3(1, 0, 0), half: b.d / 2, len: b.w };
}

/** Every facade window + entrance of a building (building-local), from the facade rule and the entrance list. */
export function facadeOpenings(b: BuildingDef): Opening[] {
  const out: Opening[] = [];
  const ents = b.entrances ?? [];
  for (const e of ents) { const y = entranceY(b, e); out.push({ side: e.side, u0: e.at - e.width / 2, u1: e.at + e.width / 2, y0: y, y1: y + e.height, depth: b.facade?.depth ?? 0.2, kind: 'entrance', canopy: canopyOf(e) }); }
  // room windows that sit in an outer wall are cut through the facade, and replace grid windows they hit (in an
  // enterable building the room edge may be the wall's outer face or its inner face, WALL_T in)
  const own: Opening[] = [];
  const inner = isHollow(b) ? WALL_T : 0;
  const onWall = (face: number, half: number) => Math.abs(Math.abs(face) - half) < 1e-6 || (inner > 0 && Math.abs(Math.abs(face) - (half - inner)) < 1e-6);
  for (const st of floorStack(b)) for (const r of b.floors.find(fl => fl.level === st.level)?.rooms ?? []) for (const w of r.windows ?? []) {
    const { half } = sideFrame(b, w.side);
    const face = w.side[1] === 'x' ? r.x + (w.side[0] === '+' ? 1 : -1) * r.w / 2 : r.z + (w.side[0] === '+' ? 1 : -1) * r.d / 2;
    if (!onWall(face, half) || Math.sign(face) !== (w.side[0] === '+' ? 1 : -1)) continue;
    const u = (w.side[1] === 'x' ? r.z : r.x) + w.at;
    own.push({ side: w.side, u0: u - w.width / 2, u1: u + w.width / 2, y0: st.y + w.sill, y1: st.y + w.sill + w.height, depth: w.depth ?? 0.2, kind: 'window', ...(w.hatch ? { hatch: w.hatch } : {}) });
  }
  out.push(...own);
  const f = b.facade;
  if (!f) return out;
  // 楼梯间 with `windows: 'landing'`: its stretch of outer wall drops the grid, a window per 休息平台 instead
  const stairs = stairWindows(b, f);
  own.push(...stairs.windows);
  out.push(...stairs.windows);
  const margin = f.margin ?? 1.2;
  for (const side of f.sides ?? (['+x', '-x', '+z', '-z'] as Side[])) {
    const { len } = sideFrame(b, side);
    const n = Math.floor((len - 2 * margin) / f.bay);
    if (n < 1) continue;
    for (const st of floorStack(b)) {
      if (st.level < 1) continue;
      for (let i = 0; i < n; i++) {
        const u = (i - (n - 1) / 2) * f.bay;
        const u0 = u - f.width / 2, u1 = u + f.width / 2;
        // an entrance replaces the ground-floor windows it hits (0.2 m of wall kept between them)
        const y0 = st.y + f.sill, y1 = y0 + f.height;
        if (stairs.walls.some(w => w.side === side && st.level >= w.from && st.level <= w.to && u0 < w.u1 && w.u0 < u1)) continue;
        if (own.some(o => o.side === side && o.y0 < y1 && y0 < o.y1 && u0 < o.u1 + 0.2 && o.u0 - 0.2 < u1)) continue;
        if (ents.some(e => entranceLevel(e) === st.level && e.side === side && u0 < e.at + e.width / 2 + 0.2 && e.at - e.width / 2 - 0.2 < u1)) continue;
        out.push({ side, u0, u1, y0, y1, depth: f.depth, kind: 'window' });
      }
    }
  }
  return out;
}

/** 休息平台 window: sill above the landing, size, and the pier between the corner one on a side wall and the corner */
export const LANDING_WIN = { sill: 1.2, height: 1.5, width: 1.4, pier: 0.45 };

/**
 * The outer-wall stretches of `windows: 'landing'` stairwells (grid windows dropped there on the storeys it serves)
 * and their 休息平台 windows: on the wall behind the landing (the +dir end) centred on the stair's clear width, and
 * on an outer side wall the landing touches, near the corner (a 转角窗 pair).
 */
function stairWindows(b: BuildingDef, f: NonNullable<BuildingDef['facade']>) {
  const walls: { side: Side; u0: number; u1: number; from: number; to: number }[] = [], windows: Opening[] = [];
  for (const s of b.stairwells ?? []) {
    if (s.windows !== 'landing') continue;
    const p = stairPlan(b, s, WALL_T), W = LANDING_WIN;
    for (const side of SIDES) {
      if (p.walls.includes(side)) continue;
      const [u0, u1] = side[1] === 'x' ? [p.rect.z0, p.rect.z1] : [p.rect.x0, p.rect.x1];
      walls.push({ side, u0, u1, from: s.from, to: s.to });
      const [c0, c1] = side[1] === 'x' ? [p.clear.z0, p.clear.z1] : [p.clear.x0, p.clear.x1];
      let u: number;
      if (side === s.dir) u = (c0 + c1) / 2;
      else if (side === p.doorSide) continue;
      else {
        // a side wall: next to the +dir end's corner, over the landing
        const end = p.at(1e3, 0), sg = (side[1] === 'x' ? end.z : end.x) > (c0 + c1) / 2 ? 1 : -1;
        u = (sg > 0 ? c1 : c0) - sg * (W.pier + W.width / 2);
      }
      for (const st of p.storeys) if (st.mid) windows.push({
        side, u0: u - W.width / 2, u1: u + W.width / 2, y0: st.mid.y1 + W.sill, y1: st.mid.y1 + W.sill + W.height,
        depth: f.depth, kind: 'window', stair: s.id,
      });
    }
  }
  return { walls, windows };
}

/** Growing non-indexed triangle soup with flat normals and per-vertex colours (world/bridges.ts draws with it too). */
export class Soup {
  pos: number[] = []; nor: number[] = []; col: number[] = []; surf: number[] = [];
  private e1 = new THREE.Vector3(); private e2 = new THREE.Vector3(); private c = new THREE.Vector3();
  /** Quad p0..p3 (in order around it) facing `n`; winding is fixed up from n so callers never think about it. */
  /** `kind`/`seed` go to the `surf` attribute (render/facade.ts): what the surface is made of, and a per-pane value. */
  quad(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3, n: THREE.Vector3, col: THREE.Color, kind: number = SURF.plain, seed = 0): void {
    this.c.crossVectors(this.e1.subVectors(p1, p0), this.e2.subVectors(p2, p0));
    const vs = this.c.dot(n) >= 0 ? [p0, p1, p2, p0, p2, p3] : [p0, p2, p1, p0, p3, p2];
    for (const v of vs) { this.pos.push(v.x, v.y, v.z); this.nor.push(n.x, n.y, n.z); this.col.push(col.r, col.g, col.b); this.surf.push(kind, seed); }
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

/**
 * Seed of a pane that fronts one of the building's `nightRooms` (旧办公楼④b2): lit while the global share is above it,
 * i.e. while the interior's 日光灯 are on (render/interior_light.ts tubesOn); every other pane of such a building stays
 * dark, so the facade at night shows the same one lit room the corridor inside does.
 */
export const NIGHT_PANE = 0.1;
/** NIGHT_PANE of a building whose one lit room has a single lamp (`nightTube` < 1, 锅炉房): lit from the same moment as the 日光灯 (tubesOn starts at 0.05) and a grade dimmer (facade.ts: k = 0.65 + 0.35 · fract(seed · 7.31) ≈ 0.78 against NIGHT_PANE's 0.91). */
export const NIGHT_PANE_DIM = 0.05;
/**
 * The pane test of a building with `nightRooms` (null without): whether the window centred at along-wall `u`, sill
 * height `y`, on outer wall `side` lights a lit room (the room's rect reaches that wall's inner face and spans u).
 */
export function nightPane(b: BuildingDef): ((side: Side, u: number, y: number) => boolean) | null {
  if (!b.nightRooms) return null;
  const lit = b.nightRooms.map(k => {
    const { level, id } = parseNightRoom(k);
    const st = floorStack(b).find(q => q.level === level)!;
    return { st, r: rectOf(storeyRooms(b, level).find(q => q.id === id)!) };
  });
  return (side, u, y) => lit.some(({ st, r }) => {
    if (y < st.y || y >= st.y + st.h) return false;
    const half = (side[1] === 'x' ? b.w : b.d) / 2 - WALL_T - 0.05, sg = side[0] === '+' ? 1 : -1;
    const edge = side[1] === 'x' ? (sg > 0 ? r.x1 : -r.x0) : (sg > 0 ? r.z1 : -r.z0);
    const [a0, a1] = side[1] === 'x' ? [r.z0, r.z1] : [r.x0, r.x1];
    return edge >= half && u > a0 && u < a1;
  });
}

const UP = new THREE.Vector3(0, 1, 0), DOWN = new THREE.Vector3(0, -1, 0);

/** Build the merged geometry of one building (world space). */
export function buildingGeometry(b: BuildingDef): THREE.BufferGeometry {
  const soup = new Soup();
  const H = buildingHeight(b), P = b.parapet ?? PARAPET;
  const base = new THREE.Color(b.color);
  const shade = (k: number) => base.clone().multiplyScalar(k);
  const wallC = base, revealC = shade(REVEAL_SHADE);
  const frameC = new THREE.Color(b.facade?.frame ?? DEFAULT_FRAME), glassC = new THREE.Color(b.facade?.glass ?? DEFAULT_GLASS);
  const doorC = new THREE.Color(DOOR_GLASS);
  // 砖楼: walls (incl. parapet, bulkhead) carry brick courses in the shader; the trims are a separate cement colour
  const wallK = b.material === 'brick' ? SURF.brick : SURF.plain;
  const trim = b.trim ? new THREE.Color(b.trim) : base;
  const trimShade = (k: number) => trim.clone().multiplyScalar(k);
  const lit = b.nightLit ?? 1, pane = nightPane(b);
  const openings = facadeOpenings(b), court = courtOpenings(b);
  for (const fr of facadeFrames(b)) {
    const { n, t, at } = frameAxes(fr), len = fr.len, side = fr.side;
    const neg = n.clone().negate(), tn = t.clone().negate();
    const rect = (u0: number, u1: number, y0: number, y1: number, off: number, c: THREE.Color, kind: number = SURF.plain, seed = 0) =>
      soup.quad(at(u0, y0, off), at(u1, y0, off), at(u1, y1, off), at(u0, y1, off), n, c, kind, seed);
    const mine = (fr.court ? court : openings).filter(o => o.side === side);
    // wall plane: horizontal bands between opening edges; inside a band, piers between the openings that span it
    const ys = [...new Set([0, H + P, ...mine.flatMap(o => [o.y0, o.y1])])].sort((p, q) => p - q);
    for (let i = 0; i + 1 < ys.length; i++) {
      const y0 = ys[i], y1 = ys[i + 1];
      const cut = mine.filter(o => o.y0 <= y0 + 1e-6 && o.y1 >= y1 - 1e-6).sort((p, q) => p.u0 - q.u0);
      let u = -len / 2;
      for (const o of cut) { if (o.u0 > u + 1e-6) rect(u, o.u0, y0, y1, 0, wallC, wallK); u = o.u1; }
      if (len / 2 > u + 1e-6) rect(u, len / 2, y0, y1, 0, wallC, wallK);
    }
    const hollow = isHollow(b);
    for (const o of mine) {
      // an enterable building's doorways are open and go through the wall; its window reveals run to the inner face
      // (world/interior.ts draws it), so the glass sits at `depth` with the rest of the wall behind it
      const open = hollow && o.kind === 'entrance';
      const d = -o.depth, back = hollow ? -WALL_T : d;
      // reveals: jambs, head, sill — the creases the ink pass draws as the window outline
      soup.quad(at(o.u0, o.y0, 0), at(o.u0, o.y0, back), at(o.u0, o.y1, back), at(o.u0, o.y1, 0), t, revealC);
      soup.quad(at(o.u1, o.y0, 0), at(o.u1, o.y0, back), at(o.u1, o.y1, back), at(o.u1, o.y1, 0), tn, revealC);
      soup.quad(at(o.u0, o.y1, 0), at(o.u1, o.y1, 0), at(o.u1, o.y1, back), at(o.u0, o.y1, back), DOWN, shade(REVEAL_SHADE * 0.85));
      if (o.y0 > 0) soup.quad(at(o.u0, o.y0, 0), at(o.u1, o.y0, 0), at(o.u1, o.y0, back), at(o.u0, o.y0, back), UP, shade(REVEAL_SHADE * 1.06));
      // (a door out into the 天井 gets no 雨棚: it is a few steps across a light well; nor does a 连廊门 upstairs)
      if (open) { if (!o.court && o.y0 === 0) canopy(soup, at, o, trimShade(0.9), n, t); continue; }
      // frame plate at the back, glass a little proud of it (frame border shows round it), mullion in front
      const fw = FRAME_W, gy0 = o.kind === 'entrance' ? o.y0 : o.y0 + fw;
      const um = (o.u0 + o.u1) / 2;
      // one seed per room-sized run of windows on a storey: they light up together at night
      const seed = o.stair ? paneSeed(0, 0) : pane ? (!fr.court && pane(side, um, o.y0) ? ((b.nightTube ?? 1) < 1 ? NIGHT_PANE_DIM : NIGHT_PANE) : paneSeed(0, 0)) : paneSeed(hash01(`${b.id}${fr.court ? 'c' : ''}${side}${Math.round(o.y0 * 10)}:${Math.floor((um + len / 2) / ROOM_W)}`), lit);
      if (o.hatch) { hatch(soup, at, o, d, frameC, glassC, trimShade(0.9), n, t, seed); continue; }
      rect(o.u0, o.u1, o.y0, o.y1, d, frameC);
      if (o.kind === 'entrance') rect(o.u0 + fw, o.u1 - fw, gy0, o.y1 - fw, d + GLASS_OUT, doorC, SURF.door, seed);
      // 阴雨天白天 the 日光灯 behind every pane are on (render/facade.ts windowsDay), but not the stairwell's (声控灯) nor in a building nobody uses by day
      else rect(o.u0 + fw, o.u1 - fw, gy0, o.y1 - fw, d + GLASS_OUT, glassC, o.stair || b.dayLit === false ? GLASS_NIGHT_ONLY : SURF.glass, seed);
      rect(um - MULLION / 2, um + MULLION / 2, gy0, o.y1 - fw, d + 2 * GLASS_OUT, frameC);
      if (o.kind === 'entrance') canopy(soup, at, o, trimShade(0.9), n, t);
    }
    // 砖楼 gable: full-height brick 壁柱 at the corners and in the wide piers between window columns (else the short
    // end is one flat slab with a few holes in it)
    if (!fr.court && b.material === 'brick') for (const u of gablePilasters(b, side)) {
      const a = u - PILASTER.w / 2, e = u + PILASTER.w / 2, y1 = H + P - CORNICE.h, o = PILASTER.out;
      rect(a, e, 0, y1, o, wallC, wallK);
      soup.quad(at(a, 0, 0), at(a, 0, o), at(a, y1, o), at(a, y1, 0), tn, shade(0.86), wallK);
      soup.quad(at(e, 0, o), at(e, 0, 0), at(e, y1, 0), at(e, y1, o), t, shade(0.86), wallK);
    }
    // parapet inner face (the outer face is the wall plane, run up to H + P above); round a 天井 it wraps the corners
    if (P > 0) {
      const ci = len / 2 + (fr.court ? PARAPET_T : -PARAPET_T);
      soup.quad(at(-ci, H, -PARAPET_T), at(ci, H, -PARAPET_T), at(ci, H + P, -PARAPET_T), at(-ci, H + P, -PARAPET_T), neg, shade(0.88), wallK);
    }
  }
  // horizontal courses: plinth (broken at entrances), a belt at every upper slab (broken at its 连廊门), coping on
  // the parapet (or eave)
  const gaps = openings.filter(o => o.kind === 'entrance' || o.stair);
  ring(soup, b, 0, PLINTH.h, 0, PLINTH.out, trimShade(PLINTH.shade), gaps);
  for (const st of floorStack(b)) if (st.level > 1) ring(soup, b, st.y - BELT.h / 2, st.y + BELT.h / 2, 0, BELT.out, trimShade(BELT.shade), gaps);
  const top = H + P;
  ring(soup, b, top - CORNICE.h, top, P > 0 ? PARAPET_T + 0.03 : 0, CORNICE.out, trimShade(CORNICE.shade), []);
  if (b.courtyard) {
    // no plinth in the well, and the 5 cm belts' undersides are too thin to read from its floor (5k budget)
    for (const st of floorStack(b)) if (st.level > 1) courtRing(soup, b, st.y - BELT.h / 2, st.y + BELT.h / 2, 0, BELT.out, trimShade(BELT.shade), false);
    courtRing(soup, b, top - CORNICE.h, top, P > 0 ? PARAPET_T + 0.03 : 0, CORNICE.out, trimShade(CORNICE.shade));
  }
  // roof slab inside the parapet, open over the 天井 (its parapet stands round the void)
  const ri = P > 0 ? PARAPET_T : 0;
  const rx = b.w / 2 - ri, rz = b.d / 2 - ri, c = courtRect(b);
  const roof = c ? rectMinus({ x0: -rx, x1: rx, z0: -rz, z1: rz }, { x0: c.x0 - ri, x1: c.x1 + ri, z0: c.z0 - ri, z1: c.z1 + ri }) : [{ x0: -rx, x1: rx, z0: -rz, z1: rz }];
  const v = (x: number, z: number) => new THREE.Vector3(b.x + x, H, b.z + z);
  // (open over a stair that climbs on up to the roof: 上屋面)
  const up = (b.stairwells ?? []).filter(s => s.roof).map(s => stairPlan(b, s, WALL_T));
  // (the cement screed's 分格缝 are drawn by the shader, render/facade.ts ROOF: a joint line runs through the roof's centre)
  const rs = roofSeed(b.x, b.z);
  for (const r of up.reduce((rs, p) => rs.flatMap(q => rectMinus(q, p.rect)), roof)) soup.quad(v(r.x0, r.z0), v(r.x1, r.z0), v(r.x1, r.z1), v(r.x0, r.z1), UP, shade(ROOF_SHADE), SURF.roof, rs);
  // 楼梯间出屋面: a stair core that reaches the top floor pokes a bulkhead through the roof; a 上屋面 stair's has a
  // doorway onto the roof (its inner faces, jambs and lintel are the stair enclosure's: world/interior.ts), and its
  // shell stands a hair proud of that enclosure so the two never z-fight
  const topLevel = Math.max(...b.floors.map(f => f.level));
  for (const s of b.stairwells ?? []) if (s.to === topLevel) {
    const p = up.find(q => q.def === s);
    if (!p) { boxFaces(soup, b.x + s.x, b.z + s.z, s.w, s.d, H, H + STAIR.roofH, shade(0.95), shade(ROOF_SHADE * 0.95), wallK); continue; }
    bulkhead(soup, b, p, H, shade(0.95), shade(ROOF_SHADE * 0.95), wallK);
  }
  // 砖烟囱: a brick stack standing behind (锅炉房), a cement 压顶 at its top, a dark mouth
  const ch = b.chimney;
  if (ch) {
    const cx = b.x + ch.x, cz = b.z + ch.z;
    boxFaces(soup, cx, cz, ch.w, ch.d, 0, ch.h - 0.4, shade(0.92), shade(0.92), wallK);
    boxFaces(soup, cx, cz, ch.w + 0.2, ch.d + 0.2, ch.h - 0.4, ch.h, trimShade(0.85), new THREE.Color(0x2a2826));
  }
  // 煤仓: a low closed brick shed against the wall outside the 煤仓门 (never entered), a cement 压顶 and, on its
  // outer face, a padlocked 铁皮投煤口 (frame, hinged lid, 搭扣 and 挂锁) over a smear of coal dust
  const cs = b.coalStore;
  if (cs) {
    const cx = b.x + cs.x, cz = b.z + cs.z, C = COAL_HATCH;
    boxFaces(soup, cx, cz, cs.w, cs.d, 0, cs.h - 0.2, shade(0.9), shade(0.9), wallK);
    boxFaces(soup, cx, cz, cs.w + 0.12, cs.d + 0.12, cs.h - 0.2, cs.h, trimShade(0.85), trimShade(0.8));
    const fz = cz + cs.d / 2, iron = new THREE.Color(C.color), dark = iron.clone().multiplyScalar(0.55);
    boxFaces(soup, cx, fz + 0.02, C.w + 0.1, 0.04, C.y - 0.05, C.y + C.h + 0.05, dark, dark);
    boxFaces(soup, cx, fz + 0.05, C.w, 0.03, C.y, C.y + C.h, iron, iron);
    boxFaces(soup, cx, fz + 0.075, C.w - 0.04, 0.02, C.y + C.h - 0.1, C.y + C.h - 0.04, dark, dark);
    boxFaces(soup, cx, fz + 0.075, 0.06, 0.02, C.y + 0.1, C.y + C.h - 0.1, dark, dark);
    boxFaces(soup, cx, fz + 0.1, 0.07, 0.04, C.y + 0.08, C.y + 0.16, new THREE.Color(C.lock), new THREE.Color(C.lock));
    soup.quad(new THREE.Vector3(cx - C.w / 2 - 0.2, 0.012, fz), new THREE.Vector3(cx + C.w / 2 + 0.2, 0.012, fz), new THREE.Vector3(cx + C.w / 2, 0.012, fz + 0.45),
      new THREE.Vector3(cx - C.w / 2, 0.012, fz + 0.45), UP, new THREE.Color(0x2e2c2a));
  }
  return soup.geometry();
}

/** 上屋面 bulkhead shell (world space): four walls BULK_OUT outside the stair rect, the door-side one open at the door, a lid. */
const BULK_OUT = 0.02;
function bulkhead(soup: Soup, b: BuildingDef, p: StairPlan, H: number, c: THREE.Color, lid: THREE.Color, kind: number): void {
  const e = BULK_OUT, y1 = H + STAIR.roofH + e;
  const x0 = b.x + p.rect.x0 - e, x1 = b.x + p.rect.x1 + e, z0 = b.z + p.rect.z0 - e, z1 = b.z + p.rect.z1 + e;
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const dh = H + STAIR.door.h;
  // one wall: along u (x for ±z sides, z for ±x sides) from a to b at fixed w, a doorway [d0, d1] cut when given
  const wall = (side: Side, n: THREE.Vector3) => {
    const alongX = side[1] === 'z', w = alongX ? (side[0] === '+' ? z1 : z0) : (side[0] === '+' ? x1 : x0);
    const [a, bb] = alongX ? [x0, x1] : [z0, z1];
    const P = (u: number, y: number) => (alongX ? v(u, y, w) : v(w, y, u));
    const q = (u0: number, u1: number, ya: number, yb: number) => soup.quad(P(u0, ya), P(u1, ya), P(u1, yb), P(u0, yb), n, c, kind);
    if (side !== p.doorSide) { q(a, bb, H, y1); return; }
    const off = alongX ? b.x : b.z, d0 = off + p.door[0], d1 = off + p.door[1];
    q(a, d0, H, y1); q(d1, bb, H, y1); q(d0, d1, dh, y1);
  };
  wall('+x', new THREE.Vector3(1, 0, 0)); wall('-x', new THREE.Vector3(-1, 0, 0));
  wall('+z', new THREE.Vector3(0, 0, 1)); wall('-z', new THREE.Vector3(0, 0, -1));
  soup.quad(v(x0, y1, z0), v(x1, y1, z0), v(x1, y1, z1), v(x0, y1, z1), UP, lid);
}

type At = (u: number, y: number, off?: number) => THREE.Vector3;

/** 雨棚 over an entrance (dimensions: the entrance's, world/shelter.ts canopyOf, which also knows where they are for 室内判定). */
function canopy(soup: Soup, at: At, o: Opening, c: THREE.Color, n: THREE.Vector3, t: THREE.Vector3): void {
  const C = o.canopy ?? CANOPY, u0 = o.u0 - C.side, u1 = o.u1 + C.side, y0 = o.y1 + C.gap, y1 = y0 + C.t, out = C.out;
  const tn = t.clone().negate();
  soup.quad(at(u0, y0, out), at(u1, y0, out), at(u1, y1, out), at(u0, y1, out), n, c);
  soup.quad(at(u0, y1, 0), at(u1, y1, 0), at(u1, y1, out), at(u0, y1, out), UP, c);
  soup.quad(at(u0, y0, 0), at(u1, y0, 0), at(u1, y0, out), at(u0, y0, out), DOWN, c.clone().multiplyScalar(0.8));
  soup.quad(at(u0, y0, 0), at(u0, y0, out), at(u0, y1, out), at(u0, y1, 0), tn, c);
  soup.quad(at(u1, y0, 0), at(u1, y0, out), at(u1, y1, out), at(u1, y1, 0), t, c);
}

/**
 * 门卫室的推拉小窗 (WindowDef.hatch): the fixed pane on the +u half (frame plate + glass), the -u half's pane slid
 * behind it so that half is open onto the 值班桌, a frame round the whole opening and a mid stile, and a 递物台 slab
 * outside the sill on two little brackets (where the 登记本 gets pushed out for you to sign). The fixed pane lights
 * at night with `seed` like any other pane of the room.
 */
function hatch(soup: Soup, at: At, o: Opening, d: number, frameC: THREE.Color, glassC: THREE.Color, slabC: THREE.Color, n: THREE.Vector3, t: THREE.Vector3, seed: number): void {
  const fw = FRAME_W, um = (o.u0 + o.u1) / 2, tn = t.clone().negate();
  const rect = (u0: number, u1: number, y0: number, y1: number, off: number, c: THREE.Color, kind: number = SURF.plain) =>
    soup.quad(at(u0, y0, off), at(u1, y0, off), at(u1, y1, off), at(u0, y1, off), n, c, kind, kind === SURF.glass ? seed : paneSeed(0, 0));
  // fixed half: plate, glass; the slid pane's edge shows as a second stile just inside the mid one
  rect(um, o.u1, o.y0, o.y1, d, frameC);
  rect(um + fw / 2, o.u1 - fw, o.y0 + fw, o.y1 - fw, d + GLASS_OUT, glassC, SURF.glass);
  // frame round the open half (head, bottom rail, outer stile) and the mid stile, as thin boxes on the glass plane
  const bar = (u0: number, u1: number, y0: number, y1: number) => {
    const f0 = d, f1 = d + 2 * GLASS_OUT + 0.02;
    soup.quad(at(u0, y0, f1), at(u1, y0, f1), at(u1, y1, f1), at(u0, y1, f1), n, frameC);
    soup.quad(at(u0, y0, f0), at(u0, y0, f1), at(u0, y1, f1), at(u0, y1, f0), tn, frameC);
    soup.quad(at(u1, y0, f0), at(u1, y0, f1), at(u1, y1, f1), at(u1, y1, f0), t, frameC);
    soup.quad(at(u0, y1, f0), at(u1, y1, f0), at(u1, y1, f1), at(u0, y1, f1), UP, frameC);
    soup.quad(at(u0, y0, f0), at(u1, y0, f0), at(u1, y0, f1), at(u0, y0, f1), DOWN, frameC);
  };
  bar(o.u0, um, o.y1 - fw, o.y1);
  bar(o.u0, um, o.y0, o.y0 + fw);
  bar(o.u0, o.u0 + fw, o.y0 + fw, o.y1 - fw);
  bar(um - MULLION / 2, um + MULLION / 2, o.y0 + fw, o.y1 - fw);
  // 递物台: a slab from inside the reveal out past the wall, wider than the opening, on two brackets
  const H = o.hatch!, T = 0.05, u0 = o.u0 - 0.08, u1 = o.u1 + 0.08, y1 = o.y0 + 0.01, y0 = y1 - T, back = d;
  soup.quad(at(u0, y1, back), at(u1, y1, back), at(u1, y1, H), at(u0, y1, H), UP, slabC);
  soup.quad(at(u0, y0, H), at(u1, y0, H), at(u1, y1, H), at(u0, y1, H), n, slabC.clone().multiplyScalar(0.92));
  soup.quad(at(u0, y0, 0), at(u1, y0, 0), at(u1, y0, H), at(u0, y0, H), DOWN, slabC.clone().multiplyScalar(0.75));
  soup.quad(at(u0, y0, 0), at(u0, y0, H), at(u0, y1, H), at(u0, y1, 0), tn, slabC);
  soup.quad(at(u1, y0, 0), at(u1, y0, H), at(u1, y1, H), at(u1, y1, 0), t, slabC);
  // brackets: a wedge under each end (two side triangles + the sloped underside)
  for (const ub of [u0 + 0.1, u1 - 0.1]) {
    const bw = 0.03, by = y0 - 0.22, bc = slabC.clone().multiplyScalar(0.7);
    soup.quad(at(ub - bw, by, 0), at(ub - bw, y0, 0), at(ub - bw, y0, H * 0.8), at(ub - bw, y0, H * 0.8), tn, bc);
    soup.quad(at(ub + bw, by, 0), at(ub + bw, y0, H * 0.8), at(ub + bw, y0, H * 0.8), at(ub + bw, y0, 0), t, bc);
    soup.quad(at(ub - bw, by, 0), at(ub + bw, by, 0), at(ub + bw, y0, H * 0.8), at(ub - bw, y0, H * 0.8), n.clone().add(DOWN).normalize(), bc);
  }
}

/**
 * A horizontal course running round the whole building between heights y0..y1, from `inner` inside the wall plane to
 * `out` outside it: front, top, underside (and an inner face when inner > 0). Sides overshoot by `out` so the corners
 * close. `gaps` (entrances) break it, with end caps.
 */
function ring(soup: Soup, b: BuildingDef, y0: number, y1: number, inner: number, out: number, c: THREE.Color, gaps: Opening[]): void {
  const under = c.clone().multiplyScalar(0.8);
  for (const side of ['+x', '-x', '+z', '-z'] as Side[]) {
    const { n, t, half, len } = sideFrame(b, side);
    const at = (u: number, y: number, off = 0) => new THREE.Vector3(b.x + n.x * (half + off) + t.x * u, y, b.z + n.z * (half + off) + t.z * u);
    const cuts = gaps.filter(g => g.side === side && g.y0 < y1 && g.y1 > y0).sort((p, q) => p.u0 - q.u0);
    const segs: [number, number][] = [];
    let u = -len / 2 - out;
    for (const g of cuts) { segs.push([u, g.u0]); u = g.u1; }
    segs.push([u, len / 2 + out]);
    const tn = t.clone().negate(), neg = n.clone().negate();
    for (const [a, e] of segs) {
      soup.quad(at(a, y0, out), at(e, y0, out), at(e, y1, out), at(a, y1, out), n, c);
      soup.quad(at(a, y1, -inner), at(e, y1, -inner), at(e, y1, out), at(a, y1, out), UP, c);
      soup.quad(at(a, y0, 0), at(e, y0, 0), at(e, y0, out), at(a, y0, out), DOWN, under);
      if (inner > 0) {
        const ci = Math.min(e, len / 2 - inner), ca = Math.max(a, -len / 2 + inner);
        soup.quad(at(ca, y0, -inner), at(ci, y0, -inner), at(ci, y1, -inner), at(ca, y1, -inner), neg, under);
      }
      // end caps where an entrance breaks the course
      if (a > -len / 2) soup.quad(at(a, y0, 0), at(a, y0, out), at(a, y1, out), at(a, y1, 0), tn, c);
      if (e < len / 2) soup.quad(at(e, y0, 0), at(e, y0, out), at(e, y1, out), at(e, y1, 0), t, c);
    }
  }
}

/**
 * The same course round a 天井: its four walls meet in concave corners, so every face is mitred (45° in plan, `u` ends
 * at ±(len/2 − off)): shorter at the front, longer behind the wall plane where the ring's roof side turns convex.
 * `under` = draw the underside.
 */
function courtRing(soup: Soup, b: BuildingDef, y0: number, y1: number, inner: number, out: number, c: THREE.Color, under = true): void {
  const dark = c.clone().multiplyScalar(0.8);
  for (const fr of facadeFrames(b).filter(f => f.court)) {
    const { n, at } = frameAxes(fr), L = fr.len / 2, neg = n.clone().negate();
    const e = (off: number) => L - off;
    soup.quad(at(-e(out), y0, out), at(e(out), y0, out), at(e(out), y1, out), at(-e(out), y1, out), n, c);
    soup.quad(at(-e(-inner), y1, -inner), at(e(-inner), y1, -inner), at(e(out), y1, out), at(-e(out), y1, out), UP, c);
    if (under) soup.quad(at(-e(0), y0, 0), at(e(0), y0, 0), at(e(out), y0, out), at(-e(out), y0, out), DOWN, dark);
    if (inner > 0) soup.quad(at(-e(-inner), y0, -inner), at(e(-inner), y0, -inner), at(e(-inner), y1, -inner), at(-e(-inner), y1, -inner), neg, dark);
  }
}

/** Four walls + lid of an axis-aligned box (no floor: it always stands on something). */
function boxFaces(soup: Soup, cx: number, cz: number, w: number, d: number, y0: number, y1: number, c: THREE.Color, lid: THREE.Color, kind: number = SURF.plain): void {
  const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2;
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  soup.quad(v(x1, y0, z0), v(x1, y0, z1), v(x1, y1, z1), v(x1, y1, z0), new THREE.Vector3(1, 0, 0), c, kind);
  soup.quad(v(x0, y0, z0), v(x0, y0, z1), v(x0, y1, z1), v(x0, y1, z0), new THREE.Vector3(-1, 0, 0), c, kind);
  soup.quad(v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1), new THREE.Vector3(0, 0, 1), c, kind);
  soup.quad(v(x0, y0, z0), v(x1, y0, z0), v(x1, y1, z0), v(x0, y1, z0), new THREE.Vector3(0, 0, -1), c, kind);
  soup.quad(v(x0, y1, z0), v(x1, y1, z0), v(x1, y1, z1), v(x0, y1, z1), UP, lid);
}

/** 砖壁柱 on a brick building's gable ends: width, how far proud of the wall, the least clear pier between window columns that takes one */
export const PILASTER = { w: 0.5, out: 0.12, pier: 1.6 };

/**
 * Where the 壁柱 stand on a side (u along the wall): only on the short ends of a 砖楼 (`material: 'brick'`), one at each
 * corner and one in the middle of every pier between window/door columns (any storey) wide enough to take it.
 */
export function gablePilasters(b: BuildingDef, side: Side): number[] {
  const { len } = sideFrame(b, side);
  if (b.material !== 'brick' || len > Math.min(b.w, b.d) + 1e-6) return [];
  const W = PILASTER.w, spans = facadeOpenings(b).filter(o => o.side === side).map(o => [o.u0, o.u1]).sort((p, q) => p[0] - q[0]);
  const clear = (c: number) => !spans.some(([a, e]) => a < c + W / 2 + 0.1 && c - W / 2 - 0.1 < e);
  const out = [-len / 2 + W / 2].filter(clear);
  let u = -len / 2;
  for (const [a, e] of spans) {
    if (u > -len / 2 && a - u >= PILASTER.pier) out.push((u + a) / 2);
    u = Math.max(u, e);
  }
  if (clear(len / 2 - W / 2)) out.push(len / 2 - W / 2);
  return out;
}
