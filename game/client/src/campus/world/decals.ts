import * as THREE from 'three';
import data from '../data/decals.json';
import { WALL_T, floorStack, roomKey, type BuildingDef, type RoomDef, type Side } from '../../../../shared/campus/campus_schema.ts';
import { DESK, classroomFacing, roomFrame, seatGrid } from './classroom.ts';
import { examCountdown } from './blackboard.ts';
import { PART, rectOf, storeyRooms } from './rooms.ts';
import { STAIR } from '../../../../shared/campus/stairs.ts';
import { TOILET, toiletPlan } from './toilet.ts';
import { SURF } from '../render/facade.ts';
import { hydrantPosters } from './stairfit.ts';
import { extinguisherSpots } from './safety.ts';

/**
 * 贴花与标识 (docs/03_campus.md 细节: 贴花): signs drawn on one shared canvas atlas from data/decals.json, shelf-packed
 * (decals of any px size), the story swaps one (`Decals.set`) and only its slot is redrawn. A storey's decals are one
 * mesh under a copy of the building's interior material (lit like the corridor), a child of the storey's furniture
 * mesh (shown and hidden with it): +1 draw call on the player's storey. ① 班牌: a 侧挂式 plate over each classroom's
 * front door (the one at the 讲台 end), standing out from the corridor face of the wall, the same words on both faces.
 * Pure apart from the canvas / mesh builders.
 */

export interface PlateDef { text: string; sub?: string }
/**
 * ② 墙面贴 (标语 / 标语条): flat on one side of a room's or a stairwell's wall. `wall` = a room key (`A.4F.class7`), or
 * `<building>.<room or stairwell id>` with `levels`; `side` = which of its walls; `face` = 'out' (default for a room:
 * the corridor face) or 'in' (default for a stairwell: inside it); `u` along the wall from the room's / stairwell's
 * centre line (+x or +z), `y` the centre above the storey floor, `w` × `h` m. `style`: 'sign' = 亚克力标牌 (pale,
 * coloured words), 'banner' = 红布标语条, 'scrawl' = ③ 涂鸦 (no ground: pencil / 圆珠笔 handwriting, `\n` between
 * lines, a line starting `~` scratched out; `doodle` adds drawings; `rot` tilts it, degrees). `{n}` in the text = days
 * left until 高考 (redrawn when the game day changes). 'sheet' = ④ 成绩单: a printed table on white paper taped up (title =
 * `text`, a line under it = `sub`, `head` the column headings, `rows` the table, finer px per m so it reads up close).
 * Or on a desk top instead of a wall (`desk`, then no `wall` / `side`): the room key, desk pair from the window side
 * (0 = by the windows), `seat` −1 / 1 = the left / right desk of the pair, `row` from the front (negative: from the
 * back, −1 = last), read from that desk's chair; `u` / `y` shift it across / along the desk top.
 * Or inside a 厕所 蹲位 (`stall`, then no `wall` / `side`): `room` as `wall` (a room key, or `<building>.<room id>` with
 * `levels`), `n` = the 蹲位 from the far end (0 = the one by the side wall: its door shut, nobody gets in), `face`: 'a'
 * = the 隔板 on the far-end side (the other one has the open door against it), 'back' = the back wall over the 蹲坑
 * (keep `u` off its middle: the 水箱's pipe), 'door' = the outside of 蹲位 0's shut door; `u` to the viewer's right of
 * the face's middle, `y` above the step.
 */
export interface PosterDef {
  wall?: string; levels?: number[]; side?: Side; face?: 'in' | 'out'; u: number; y: number; w: number; h: number;
  desk?: { room: string; pair: number; seat: -1 | 1; row: number };
  stall?: { room: string; levels?: number[]; n: number; face: 'a' | 'back' | 'door' };
  style: 'sign' | 'banner' | 'scrawl' | 'sheet' | 'tin' | 'plate' | 'menu'; text: string; sub?: string; ink?: string; doodle?: Doodle[]; rot?: number;
  head?: string[]; rows?: string[][];
  /** a wall 墙面贴 this much further off the wall face (m): on the front of something fixed to it ('tin') */ out?: number;
}
/** 涂鸦 drawings: 三八线 down the edge toward the 同桌 (+ 越线归我), a crude face, a ring round the last line, tally. */
export type Doodle = 'line38' | 'face' | 'ring' | 'arrow';
interface DecalData { plates: Record<string, PlateDef>; posters: Record<string, PosterDef> }
export const DECALS = data as unknown as DecalData;

/** 班牌 (m): face size (out from the wall × high), thickness, bottom above the storey floor, gap to the wall face. */
export const PLATE = { w: 0.62, h: 0.24, t: 0.03, y0: 2.2, gap: 0.02, px: [256, 100] as const, face: '#3e4a58', ink: '#ece6d4', edge: '#8b8f8a' };

/**
 * Atlas: shelf-packed into ATLAS_W px rows, tallest first, each slot at the end of the first row it still fits in (so
 * short slots fill out the tall rows; `at` stays in input order); the first block is a solid edge colour (sampled at
 * one texel).
 */
export const ATLAS_W = 2048;
const SOLID = 8;
export function packSlots(sizes: readonly (readonly [number, number])[], w = ATLAS_W): { at: [number, number][]; h: number } {
  const at: [number, number][] = new Array(sizes.length);
  // rows (top y, height = its first and tallest slot, filled up to x); the first row starts after the solid block
  const rows: { y: number; h: number; x: number }[] = [];
  const order = sizes.map((_, i) => i).sort((a, b) => sizes[b][1] - sizes[a][1] || a - b);
  for (const i of order) {
    const [sw, sh] = sizes[i];
    if (sw > w) throw new Error(`decal ${sw} px wider than the atlas`);
    // first fit: the end of any open row it fits in (shorter slots fill out the tall rows), else a new row
    let r = rows.find(q => q.x + sw <= w);
    if (!r) { const last = rows[rows.length - 1]; r = { y: last ? last.y + last.h : 0, h: Math.max(sh, last ? 0 : SOLID), x: last ? 0 : SOLID }; rows.push(r); }
    at[i] = [r.x, r.y]; r.x += sw;
  }
  const last = rows[rows.length - 1];
  return { at, h: Math.max(SOLID, last ? last.y + last.h : 0) };
}

type V3 = [number, number, number];
const vec = (s: Side): [number, number] => (s[1] === 'x' ? [s[0] === '+' ? 1 : -1, 0] : [0, s[0] === '+' ? 1 : -1]);

/** A 班牌 placed (building-local): its root at the wall face, out = the corridor-side normal, along = across the plate. */
export interface PlateSpot { key: string; room: string; root: V3; out: [number, number]; along: [number, number] }

/**
 * Where a classroom's 班牌 hangs (building-local, y from the storey floor `y`): over the edge of its front door (the
 * door nearest the 讲台) that faces the 讲台 end, on the corridor face of the door's wall. Null without doors.
 */
export function plateSpot(b: BuildingDef, r: RoomDef, y: number, key: string): PlateSpot | null {
  const doors = r.doors ?? [];
  if (!doors.length) return null;
  const f = vec(classroomFacing(b, r));
  const centre = (d: (typeof doors)[number]): [number, number] => {
    const n = vec(d.side), half = n[0] !== 0 ? r.w / 2 : r.d / 2;
    // along the wall: +x for walls along x (±z sides), +z for walls along z (±x sides)
    return n[0] !== 0 ? [r.x + n[0] * half, r.z + d.at] : [r.x + d.at, r.z + n[1] * half];
  };
  const d = doors.reduce((a, c) => { const pa = centre(a), pc = centre(c); return (pc[0] - r.x) * f[0] + (pc[1] - r.z) * f[1] > (pa[0] - r.x) * f[0] + (pa[1] - r.z) * f[1] ? c : a; });
  const out = vec(d.side), c = centre(d), along: [number, number] = [Math.abs(out[1]), Math.abs(out[0])];
  // the door jamb toward the front: along the wall by half the door width in the facing direction
  const s = Math.sign(along[0] * f[0] + along[1] * f[1]) || 1, u = s * d.width / 2, o = PART.t / 2;
  return { key, room: r.id, root: [c[0] + along[0] * u + out[0] * o, y + PLATE.y0, c[1] + along[1] * u + out[1] * o], out, along };
}

/** Every 班牌 of a storey's classrooms that data/decals.json gives one (room key order of the layout). */
export function storeyPlates(b: BuildingDef, level: number, plates: Record<string, PlateDef> = DECALS.plates): PlateSpot[] {
  const st = floorStack(b).find(s => s.level === level);
  if (!st) return [];
  return storeyRooms(b, level).filter(r => r.kind === 'classroom').flatMap(r => {
    const key = roomKey(b.id, level, r.id), p = key in plates ? plateSpot(b, r, st.y, key) : null;
    return p ? [p] : [];
  });
}

/**
 * A 班牌's box corners (building-local): the two faces (each bottom-left, bottom-right, top-right, top-left as seen
 * from its side) and the face normals. The plate is PLATE.t thick across `along`, PLATE.w out from the wall.
 */
export function plateFaces(p: PlateSpot): { faces: { q: V3[]; n: V3 }[]; box: { min: V3; max: V3 } } {
  const [x, y, z] = p.root, o = p.out, a = p.along, h = PLATE.t / 2;
  const at = (w: number, dy: number, v: number): V3 => [x + o[0] * w + a[0] * v, y + dy, z + o[1] * w + a[1] * v];
  const w0 = PLATE.gap, w1 = PLATE.gap + PLATE.w, H = PLATE.h;
  // seen from +along: the wall on the viewer's right iff out × up · along > 0 … pick corners so u runs wall → tip
  // when the wall is on the left, so the words read left to right from either side
  const side = (v: number): { q: V3[]; n: V3 } => {
    const n: V3 = [a[0] * Math.sign(v), 0, a[1] * Math.sign(v)];
    // viewer looks along −n; their right = (−n) × up = (n.z, −n.x) in plan
    const right: [number, number] = [n[2], -n[0]], wallOnLeft = right[0] * o[0] + right[1] * o[1] > 0;
    const [u0, u1] = wallOnLeft ? [w0, w1] : [w1, w0];
    return { q: [at(u0, 0, v), at(u1, 0, v), at(u1, H, v), at(u0, H, v)], n };
  };
  const c = [at(w0, 0, -h), at(w1, H, h)];
  return {
    faces: [side(h), side(-h)],
    box: { min: [Math.min(c[0][0], c[1][0]), y, Math.min(c[0][2], c[1][2])], max: [Math.max(c[0][0], c[1][0]), y + H, Math.max(c[0][2], c[1][2])] },
  };
}
const FONT = '"WenQuanYi Zen Hei", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';

/**
 * One 班牌 face at (ox, oy): a dark blue-grey 铝牌 with a pale border line, the class in bold, a smaller line under it
 * if `sub`. Null = taken down: a paler patch with the 4 screw holes (the bracket stays on the wall).
 */
export function drawPlate(g: CanvasRenderingContext2D, p: PlateDef | null, ox: number, oy: number): void {
  const [w, h] = PLATE.px;
  g.save();
  g.beginPath(); g.rect(ox, oy, w, h); g.clip();
  g.fillStyle = p ? PLATE.face : '#8e928c'; g.fillRect(ox, oy, w, h);
  g.strokeStyle = p ? '#9aa3a8' : '#a6aaa3'; g.lineWidth = 3; g.strokeRect(ox + 7, oy + 7, w - 14, h - 14);
  g.fillStyle = '#2a2f33';
  for (const [x, y] of [[14, 14], [w - 14, 14], [14, h - 14], [w - 14, h - 14]]) { g.beginPath(); g.arc(ox + x, oy + y, 3, 0, Math.PI * 2); g.fill(); }
  if (p) {
    g.fillStyle = PLATE.ink; g.textAlign = 'center'; g.textBaseline = 'middle';
    const big = p.sub ? 40 : 46;
    g.font = `bold ${big}px ${FONT}`;
    // squeeze long names into the plate rather than clip them
    const fit = Math.min(1, (w - 40) / g.measureText(p.text).width);
    g.save(); g.translate(ox + w / 2, oy + (p.sub ? h * 0.4 : h / 2)); g.scale(fit, 1); g.fillText(p.text, 0, 0); g.restore();
    if (p.sub) { g.font = `18px ${FONT}`; g.fillStyle = '#c9c6ba'; g.fillText(p.sub, ox + w / 2, oy + h * 0.76); }
  }
  g.restore();
}

/**
 * A storey's decal mesh (building-local spots → world): per 班牌 two textured faces into its atlas slot `slot(key)`
 * (px origin), and its four edges (top, bottom, tip, and the end on the wall) sampling the solid edge texel. White
 * vertex colour (the texture is the colour), `surf` plain.
 */
/** Geometry under construction: quads wound to face their normal, white vertex colour, `surf` plain (building-local in). */
export class QuadBuf {
  pos: number[] = []; nor: number[] = []; col: number[] = []; uv: number[] = []; surf: number[] = [];
  private b: BuildingDef;

  constructor(b: BuildingDef) { this.b = b; }
  /** a quad wound to face `n` (corners in order round it, either way) */
  quad(q: V3[], n: V3, t: [number, number][]): void {
    const e1 = [q[1][0] - q[0][0], q[1][1] - q[0][1], q[1][2] - q[0][2]], e2 = [q[2][0] - q[0][0], q[2][1] - q[0][1], q[2][2] - q[0][2]];
    const d = (e1[1] * e2[2] - e1[2] * e2[1]) * n[0] + (e1[2] * e2[0] - e1[0] * e2[2]) * n[1] + (e1[0] * e2[1] - e1[1] * e2[0]) * n[2];
    for (const i of d < 0 ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3]) {
      this.pos.push(this.b.x + q[i][0], q[i][1], this.b.z + q[i][2]); this.nor.push(...n); this.col.push(1, 1, 1); this.uv.push(...t[i]); this.surf.push(SURF.plain, 0);
    }
  }
  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('surf', new THREE.Float32BufferAttribute(this.surf, 2));
    g.computeBoundingSphere();
    return g;
  }
}
/** Atlas uv rect of a px slot: corners bottom-left, bottom-right, top-right, top-left. */
const slotUV = ([ox, oy]: [number, number], [pw, ph]: readonly [number, number], H: number): [number, number][] => {
  const u0 = ox / ATLAS_W, u1 = (ox + pw) / ATLAS_W, v0 = 1 - (oy + ph) / H, v1 = 1 - oy / H;
  return [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
};

/**
 * 班牌 into a storey's decal geometry (building-local spots → world): per plate two textured faces into its atlas slot
 * `slot(key)` (px origin), and its four edges (top, bottom, tip, and the end on the wall) sampling the solid edge texel.
 */
function addPlates(buf: QuadBuf, plates: PlateSpot[], slot: (key: string) => [number, number], H: number): void {
  const solid: [number, number] = [SOLID / 2 / ATLAS_W, 1 - SOLID / 2 / H];
  const quad = buf.quad.bind(buf);
  for (const p of plates) {
    const t = slotUV(slot(p.key), PLATE.px, H);
    const { faces, box } = plateFaces(p);
    for (const f of faces) quad(f.q, f.n, t);
    // edges: the box sides whose normal is not ±along (those are the faces)
    const { min: m, max: M } = box, s = [solid, solid, solid, solid];
    const ax = p.along[0] !== 0;
    quad([[m[0], M[1], M[2]], [M[0], M[1], M[2]], [M[0], M[1], m[2]], [m[0], M[1], m[2]]], [0, 1, 0], s);
    quad([[m[0], m[1], m[2]], [M[0], m[1], m[2]], [M[0], m[1], M[2]], [m[0], m[1], M[2]]], [0, -1, 0], s);
    if (ax) {
      // plate runs out along z: its ends face ±z
      quad([[M[0], m[1], M[2]], [m[0], m[1], M[2]], [m[0], M[1], M[2]], [M[0], M[1], M[2]]], [0, 0, 1], s);
      quad([[m[0], m[1], m[2]], [M[0], m[1], m[2]], [M[0], M[1], m[2]], [m[0], M[1], m[2]]], [0, 0, -1], s);
    } else {
      quad([[M[0], m[1], m[2]], [M[0], m[1], M[2]], [M[0], M[1], M[2]], [M[0], M[1], m[2]]], [1, 0, 0], s);
      quad([[m[0], m[1], M[2]], [m[0], m[1], m[2]], [m[0], M[1], m[2]], [m[0], M[1], M[2]]], [-1, 0, 0], s);
    }
  }
}

/** A storey's 班牌 as one geometry (white vertex colour: the texture is the colour). */
export function plateGeometry(b: BuildingDef, plates: PlateSpot[], slot: (key: string) => [number, number], H: number): THREE.BufferGeometry {
  const buf = new QuadBuf(b);
  addPlates(buf, plates, slot, H);
  return buf.geometry();
}

/** 墙面贴: canvas px per m, gap off the wall face (m), colours per style. */
export const POSTER = {
  ppm: 256, gap: 0.012,
  /** 科室牌 are small and read up close (6 characters on 0.42 m) */ platePpm: 640,
  /** 涂鸦: finer (handwriting), a desk-top one this far above the top; pencil / 圆珠笔 grey-blue, never black */
  scrawlPpm: 640, lift: 0.004, pencil: '#77736b',
  /** 成绩单: printed (toner, not black), the paper a little short of the slot all round so its tilt fits, tape */
  sheet: { ppm: 1536, paper: '#f8f6ef', shade: '#e2ded2', ink: '#2c2b28', rule: '#7d7a72', tape: 'rgba(226, 219, 186, 0.9)', margin: 0.014 },
  sign: { face: '#e9e6dc', ink: '#a8322c', rule: '#b9b3a3' },
  banner: { face: '#b8382e', ink: '#f6e39a', rule: '#8a2a22' },
  /** 铁皮: white words stencilled on a dull red steel door (the 消火栓箱's, world/stairfit.ts) */
  tin: { face: '#cc5e4d', ink: '#ece8dc', rule: '#a84f44' },
  /** 科室牌: the 班牌's dark 铝牌 (PLATE) flat on the wall by an 办公室 door (doorSigns), pale words */
  plate: { face: PLATE.face, ink: PLATE.ink, rule: '#9aa3a8' },
  /** 价目牌 (食堂 2F, over each 打饭窗口): a white 白板 in an aluminium frame, the window's name printed red across the
   *  top (the first line of `text`), the dishes and prices under it in 白板笔 by hand (the rest: scrawl) */
  menu: { ppm: 400, face: '#f4f3ec', ink: '#1a3a94', rule: '#8f9698', head: '#c42a20' },
  /** taken down: the paint a shade paler where it hung, a strip of tape left at each top corner */ gone: '#d9d4c6',
};
export const posterPx = (d: PosterDef): [number, number] => {
  const k = d.style === 'scrawl' ? POSTER.scrawlPpm : d.style === 'sheet' ? POSTER.sheet.ppm : d.style === 'plate' ? POSTER.platePpm : d.style === 'menu' ? POSTER.menu.ppm : POSTER.ppm;
  return [Math.round(d.w * k), Math.round(d.h * k)];
};

/** 科室牌 (m): across × high, centre above the storey floor, gap from the door hole's edge (clear of the 门套) */
export const DOOR_SIGN = { w: 0.42, h: 0.14, y: 1.72, gap: 0.16, /** clear of the room's corner */ end: 0.12, /** over the door head (门套 + gap) */ over: 0.12 };

/**
 * 门牌 for the rooms floors[].rename gives a function (OFF: docs/03_campus.md 房间表; classrooms have their 班牌): a
 * 'plate' 墙面贴 on the corridor face of the door's wall, beside the door on the side toward the room's middle (the
 * other jamb, or over the door, where a 灭火器 sign or the room's corner is in the way), the room's name on it. Keyed
 * `门牌:<room key>`.
 */
export function doorSigns(buildings: BuildingDef[]): Record<string, PosterDef> {
  const out: Record<string, PosterDef> = {}, S = DOOR_SIGN;
  for (const b of buildings) for (const f of b.floors) {
    if (!f.rename || f.rooms) continue;
    const ids = new Set(Object.values(f.rename).map(v => v.id)), rooms = storeyRooms(b, f.level);
    // the 灭火器 signs on the corridor walls (world/safety.ts, at the 门牌's height): the 门牌 goes the other side of its door
    const ext = rooms.filter(r => r.kind === 'corridor').flatMap(r => extinguisherSpots(b, f.level, r));
    for (const r of rooms) {
      const d = r.doors?.[0];
      if (!ids.has(r.id) || r.kind === 'classroom' || !d) continue;
      const key = roomKey(b.id, f.level, r.id), along = d.side[1] === 'z' ? r.x : r.z, edge = d.side[1] === 'z' ? 'x' : 'z';
      const at = (s: number) => d.at + s * (d.width / 2 + S.gap + S.w / 2), half = (d.side[1] === 'z' ? r.w : r.d) / 2;
      const ok = (u: number) => Math.abs(u) + S.w / 2 < half - S.end && !ext.some(e => e.ax === edge && Math.abs(e.u - (along + u)) < S.w / 2 + 0.25);
      // beside the door toward the room's middle, else beside its other jamb, else over the door head
      const s0 = d.at > 0 ? -1 : 1, u = [at(s0), at(-s0)].find(ok);
      const y = u === undefined ? (d.height ?? PART.door.height) + S.over + S.h / 2 : S.y;
      out[`门牌:${key}`] = { wall: key, side: d.side, face: 'out', u: u ?? d.at, y, w: S.w, h: S.h, style: 'plate', text: r.name };
    }
  }
  return out;
}

/** A 墙面贴 placed (building-local): its corners bottom-left, bottom-right, top-right, top-left as seen, and normal. */
export interface PosterSpot { key: string; q: V3[]; n: V3; level: number }

/**
 * The plane a poster hangs on (building-local, plan): the wall face's line c on axis ('x' = the face runs along x at
 * z = c), the face normal, and the centre the poster's `u` counts from. Rooms: the partition face (PART.t thick,
 * centred on the room edge) or, against the outer wall, its inner face; stairwells: the enclosure's (STAIR.encl, inside
 * the rect) or the outer wall's (WALL_T) inner face. Null if `wall` names nothing on `level`.
 */
export function posterWall(b: BuildingDef, level: number, d: PosterDef): { axis: 'x' | 'z'; c: number; n: [number, number]; mid: number; span: [number, number] } | null {
  if (!d.wall || !d.side) return null;
  const side: Side = d.side, [bid, ...rest] = d.wall.split('.'), sg = side[0] === '+' ? 1 : -1, axis = side[1] === 'x' ? 'z' : 'x';
  if (bid !== b.id) return null;
  const T = WALL_T, outer = (c: number) => Math.abs(Math.abs(c) - (axis === 'x' ? b.d / 2 - T : b.w / 2 - T)) < 0.3;
  const R = (r: { x: number; z: number; w: number; d: number }) => rectOf(r);
  const s = rest.length === 1 ? (b.stairwells ?? []).find(q => q.id === rest[0]) : undefined;
  if (!s) {
    // a room: A.4F.class7, or A.w2 on each of `levels`
    const r = storeyRooms(b, level).find(q => (rest.length === 2 ? roomKey(b.id, level, q.id) : `${b.id}.${q.id}`) === d.wall);
    if (!r) return null;
    const E = R(r), edge = side === '+x' ? E.x1 : side === '-x' ? E.x0 : side === '+z' ? E.z1 : E.z0;
    const inward = (d.face ?? 'out') === 'in';
    const c = outer(edge) ? edge : edge + (inward ? -sg : sg) * PART.t / 2;
    if (!inward && outer(edge)) return null;
    const span: [number, number] = axis === 'x' ? [E.x0, E.x1] : [E.z0, E.z1];
    return { axis, c, n: vecN(side, inward ? -1 : 1), mid: axis === 'x' ? r.x : r.z, span };
  }
  if (level < s.from || level > s.to) return null;
  const E = R(s), edge = side === '+x' ? E.x1 : side === '-x' ? E.x0 : side === '+z' ? E.z1 : E.z0;
  const inward = (d.face ?? 'in') === 'in', encl = !outer(edge - sg * T);
  if (!inward && !encl) return null;
  const c = inward ? edge - sg * (encl ? STAIR.encl : T) : edge;
  const span: [number, number] = axis === 'x' ? [E.x0, E.x1] : [E.z0, E.z1];
  return { axis, c, n: vecN(side, inward ? -1 : 1), mid: axis === 'x' ? s.x : s.z, span };
}
const vecN = (s: Side, k: number): [number, number] => { const v = vec(s); return [v[0] * k, v[1] * k]; };

/** Every 墙面贴 of a storey (data order), its quad off the wall face by POSTER.gap; posters naming nothing here skipped. */
export function storeyPosters(b: BuildingDef, level: number, posters: Record<string, PosterDef> = DECALS.posters): PosterSpot[] {
  const st = floorStack(b).find(q => q.level === level);
  if (!st) return [];
  return Object.entries(posters).flatMap(([key, d]) => {
    if (d.desk) { const q = deskPoster(b, level, st.y, d); return q ? [{ key, level, ...q }] : []; }
    if (d.stall) { const q = stallPoster(b, level, st.y, d); return q ? [{ key, level, ...q }] : []; }
    if (!d.wall) return [];
    if (d.levels ? !d.levels.includes(level) : d.wall.split('.').length !== 3) return [];
    if (d.wall.split('.').length === 3 && d.levels) return [];
    const w = posterWall(b, level, d);
    if (!w) return [];
    const [nx, nz] = w.n, n: V3 = [nx, 0, nz];
    // the viewer looks along −n; their right = (n.z, −n.x) in plan
    const right: [number, number] = [nz, -nx], g = POSTER.gap + (d.out ?? 0);
    const at = (du: number, dy: number): V3 => {
      const u = w.mid + d.u + du * (w.axis === 'x' ? right[0] : right[1]);
      return w.axis === 'x' ? [u, st.y + d.y + dy, w.c + nz * g] : [w.c + nx * g, st.y + d.y + dy, u];
    };
    const hw = d.w / 2, hh = d.h / 2;
    return [{ key, level, n, q: [at(-hw, -hh), at(hw, -hh), at(hw, hh), at(-hw, hh)] }];
  });
}

/**
 * A desk-top 涂鸦's quad (building-local, `y` = the storey floor): flat on the desk top DECAL.lift above it, read from the
 * desk's chair (bottom edge toward the chair, the words running to the sitter's right). Null if `desk.room` is not a
 * classroom of this storey or has no such desk.
 */
export function deskPoster(b: BuildingDef, level: number, y: number, d: PosterDef): { q: V3[]; n: V3 } | null {
  const k = d.desk!, r = storeyRooms(b, level).find(q => q.kind === 'classroom' && roomKey(b.id, level, q.id) === k.room);
  if (!r) return null;
  const { pairs, rows } = seatGrid(b, r), v0 = pairs[k.pair], a0 = rows[k.row < 0 ? rows.length + k.row : k.row];
  if (v0 === undefined || a0 === undefined) return null;
  const { pt } = roomFrame(r, classroomFacing(b, r));
  const a = a0 + d.y, v = v0 + (k.seat * DESK.w) / 2 + d.u, hw = d.w / 2, hh = d.h / 2, top = y + DESK.h + POSTER.lift;
  return { n: [0, 1, 0], q: [pt(a - hh, v - hw, top), pt(a - hh, v + hw, top), pt(a + hh, v + hw, top), pt(a + hh, v - hw, top)] };
}

/**
 * A 厕所 涂鸦's quad (building-local, `y` = the storey floor) on a face inside a 蹲位 (world/toilet.ts toiletPlan),
 * POSTER.gap off it, facing into the 蹲位 (the shut door's: out at the aisle). Null if `stall.room` is no 厕所 of this
 * storey (or not on `levels`), the 蹲位 is not there, or the face is out of sight (蹲位 0's inside).
 */
export function stallPoster(b: BuildingDef, level: number, y: number, d: PosterDef): { q: V3[]; n: V3 } | null {
  const k = d.stall!, full = k.room.split('.').length === 3;
  if (full ? !!k.levels : !k.levels?.includes(level)) return null;
  const r = storeyRooms(b, level).find(q => q.kind === 'toilet' && (full ? roomKey(b.id, level, q.id) : `${b.id}.${q.id}`) === k.room);
  if (!r) return null;
  const p = toiletPlan(b, r), i = k.n, n = p.parts.length - 1;
  if (i < 0 || i >= n || (k.face === 'door' ? i !== 0 : i === 0)) return null;
  const T = TOILET, ht = T.part.t / 2, a0 = p.ba, a1 = p.ba + T.stall.d, g = POSTER.gap, s = p.s;
  // the face's middle and normal in the room frame (a, v), normal as a (da, dv) direction
  const [ca, cv, na, nv] = k.face === 'door' ? [a1 + g, (p.parts[0] + p.parts[1]) / 2, 1, 0]
    : k.face === 'a' ? [(a0 + a1) / 2, p.parts[i] + s * (ht + g), 0, s]
    : [a0 + g, (p.parts[i] + p.parts[i + 1]) / 2, 1, 0];
  const o = p.pt(0, 0, 0), dn = p.pt(na, nv, 0), nx = dn[0] - o[0], nz = dn[2] - o[2], c = p.pt(ca, cv, 0);
  const right: [number, number] = [nz, -nx], cy = y + T.step + d.y;
  const at = (du: number, dy: number): V3 => [c[0] + right[0] * (d.u + du), cy + dy, c[2] + right[1] * (d.u + du)];
  const hw = d.w / 2, hh = d.h / 2;
  return { n: [nx, 0, nz], q: [at(-hw, -hh), at(hw, -hh), at(hw, hh), at(-hw, hh)] };
}

/** A 墙面贴's words on game day `day`: `{n}` = days left until 高考. */
export const posterText = (t: string, day: number) => t.replace('{n}', String(examCountdown(day)));

/**
 * One 墙面贴 at (ox, oy), `w` × `h` px. 'sign': a pale 亚克力 plate, a thin inset rule, the words in bold red; 'banner':
 * 红布 with a sewn hem top and bottom, a few soft vertical creases, the words in yellow; 'tin': stencilled white on dull
 * red 铁皮, a sunk seam round it. Null = taken down: the wall
 * paint a shade paler where it hung and two bits of tape left at the top corners.
 */
export function drawPoster(g: CanvasRenderingContext2D, d: PosterDef | null, size: readonly [number, number], ox: number, oy: number, day: number): void {
  const [w, h] = size;
  g.save();
  g.beginPath(); g.rect(ox, oy, w, h); g.clip();
  g.clearRect(ox, oy, w, h);
  if (!d) {
    g.fillStyle = POSTER.gone; g.fillRect(ox, oy, w, h);
    g.fillStyle = 'rgba(214, 205, 170, 0.9)';
    for (const x of [ox + 4, ox + w - 4 - h * 0.35]) g.fillRect(x, oy + 2, h * 0.35, h * 0.14);
    g.restore();
    return;
  }
  if (d.style === 'scrawl') { drawScrawl(g, d, w, h, ox, oy, day); g.restore(); return; }
  if (d.style === 'sheet') { drawSheet(g, d, w, h, ox, oy, day); g.restore(); return; }
  if (d.style === 'menu') { drawMenu(g, d, w, h, ox, oy, day); g.restore(); return; }
  const st = POSTER[d.style];
  g.fillStyle = st.face; g.fillRect(ox, oy, w, h);
  if (d.style === 'banner') {
    // creases: soft darker/lighter vertical bands where the cloth was folded
    for (let i = 1; i < 6; i++) {
      const x = ox + (w * i) / 6 + ((i * 37) % 23) - 11;
      const gr = g.createLinearGradient(x - 18, 0, x + 18, 0);
      gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(0.5, i % 2 ? 'rgba(40,0,0,0.16)' : 'rgba(255,220,200,0.08)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(x - 18, oy, 36, h);
    }
    g.fillStyle = st.rule; const hem = Math.max(3, h * 0.06);
    g.fillRect(ox, oy, w, hem); g.fillRect(ox, oy + h - hem, w, hem);
  } else {
    g.strokeStyle = st.rule; g.lineWidth = Math.max(2, h * 0.025);
    const m = h * 0.08; g.strokeRect(ox + m, oy + m, w - 2 * m, h - 2 * m);
  }
  g.fillStyle = d.ink ?? st.ink; g.textAlign = 'center'; g.textBaseline = 'middle';
  const text = posterText(d.text, day), big = h * (d.sub ? 0.46 : d.style === 'banner' ? 0.6 : 0.52);
  g.font = `bold ${big}px ${FONT}`;
  // squeeze rather than clip; banners letter-space their words out (标语条: one character per cloth panel)
  const tw = g.measureText(text).width, fit = Math.min(1, (w * 0.9) / tw);
  g.save(); g.translate(ox + w / 2, oy + (d.sub ? h * 0.4 : h / 2) + big * 0.04); g.scale(fit, 1); g.fillText(text, 0, 0); g.restore();
  if (d.sub) { g.font = `${h * 0.17}px ${FONT}`; g.globalAlpha = 0.75; g.fillText(posterText(d.sub, day), ox + w / 2, oy + h * 0.76); g.globalAlpha = 1; }
  g.restore();
}

/** 价目牌: the board and frame, a ghost of last week's wiped-off words, the red title, the handwritten lines under it. */
function drawMenu(g: CanvasRenderingContext2D, d: PosterDef, w: number, h: number, ox: number, oy: number, day: number): void {
  const M = POSTER.menu, fr = Math.max(4, h * 0.035), [title, ...rest] = d.text.split('\n');
  g.fillStyle = M.rule; g.fillRect(ox, oy, w, h);
  g.fillStyle = M.face; g.fillRect(ox + fr, oy + fr, w - 2 * fr, h - 2 * fr);
  // 擦不干净: pale blue smears where the old prices were
  const r = rng(`${d.text}#smear`);
  for (let i = 0; i < 5; i++) { g.fillStyle = 'rgba(70, 100, 150, 0.07)'; g.fillRect(ox + w * (0.1 + 0.6 * r()), oy + h * (0.3 + 0.55 * r()), w * (0.15 + 0.2 * r()), h * 0.06); }
  const th = h * 0.2;
  g.fillStyle = M.head; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = `bold ${th * 0.78}px ${FONT}`;
  g.fillText(posterText(title, day), ox + w / 2, oy + fr + th * 0.62);
  g.fillRect(ox + w * 0.08, oy + fr + th * 1.18, w * 0.84, Math.max(2, h * 0.012));
  const top = fr + th * 1.3;
  drawScrawl(g, { ...d, text: rest.join('\n'), ink: d.ink ?? M.ink, doodle: [] }, w - 2 * fr, h - top - fr, ox + fr, oy + top, day);
}

/**
 * 成绩单: a printed sheet on a transparent slot (its margin left clear so the paper can sit `rot` off square), taped
 * at the top corners. Title (`text`, bold), a small line under it (`sub`), then the table: `head` on a grey band, one
 * line per `rows` entry, thin rules between, the first column (名次) and the name left, the rest right-aligned.
 * Columns share the width by how long their longest cell is. Toner grey, never black.
 */
function drawSheet(g: CanvasRenderingContext2D, d: PosterDef, w: number, h: number, ox: number, oy: number, day: number): void {
  const S = POSTER.sheet, m = S.margin * S.ppm, pw = w - 2 * m, ph = h - 2 * m, head = d.head ?? [], rows = d.rows ?? [];
  g.save();
  g.translate(ox + w / 2, oy + h / 2); g.rotate(((d.rot ?? 0) * Math.PI) / 180); g.translate(-pw / 2, -ph / 2);
  g.fillStyle = S.paper; g.fillRect(0, 0, pw, ph);
  // the paper: a faint shade down one edge (it was folded in four to carry it from the 年级组 office)
  g.fillStyle = S.shade; g.globalAlpha = 0.5;
  g.fillRect(pw / 2 - 1, 0, 2, ph); g.fillRect(0, ph / 2 - 1, pw, 2); g.globalAlpha = 1;
  const pad = pw * 0.06, tw = pw - 2 * pad, n = rows.length + (head.length ? 1 : 0);
  // vertical units: title 1.9, sub 1.3, a gap 0.5, then one per table line
  const unit = (ph - 2 * pad) / (1.9 + (d.sub ? 1.3 : 0) + 0.5 + n);
  g.fillStyle = d.ink ?? S.ink; g.textBaseline = 'middle'; g.textAlign = 'center';
  let y = pad;
  g.font = `bold ${unit * 1.15}px ${FONT}`;
  const title = posterText(d.text, day), tfit = Math.min(1, tw / g.measureText(title).width);
  g.save(); g.translate(pw / 2, y + unit * 0.95); g.scale(tfit, 1); g.fillText(title, 0, 0); g.restore();
  y += unit * 1.9;
  if (d.sub) { g.font = `${unit * 0.62}px ${FONT}`; g.globalAlpha = 0.8; g.fillText(posterText(d.sub, day), pw / 2, y + unit * 0.6); g.globalAlpha = 1; y += unit * 1.3; }
  y += unit * 0.5;
  // column widths by their longest cell (CJK ≈ 1, digits / dashes ≈ 0.55), at least 2 each
  const cols = Math.max(head.length, ...rows.map(r => r.length)), len = (t = '') => [...t].reduce((a, c) => a + (/[\x00-\x7f]/.test(c) ? 0.55 : 1), 0);
  const wt = Array.from({ length: cols }, (_, i) => Math.max(2, len(head[i]) + 0.8, ...rows.map(r => len(r[i]) + 0.8)));
  const sum = wt.reduce((a, b) => a + b, 0), xs = wt.reduce<number[]>((a, v) => [...a, a[a.length - 1] + (v / sum) * tw], [pad]);
  const fs = unit * 0.68, line = (t: string[], yc: number, bold: boolean) => {
    g.font = `${bold ? 'bold ' : ''}${fs}px ${FONT}`;
    t.forEach((c, i) => {
      const left = i < 2, x = left ? xs[i] + fs * 0.3 : xs[i + 1] - fs * 0.3;
      g.textAlign = left ? 'left' : 'right';
      const cw = g.measureText(c).width, room = xs[i + 1] - xs[i] - fs * 0.4, k = Math.min(1, room / Math.max(1, cw));
      g.save(); g.translate(x, yc); g.scale(k, 1); g.fillText(c, 0, 0); g.restore();
    });
  };
  g.strokeStyle = S.rule; g.lineWidth = Math.max(1, unit * 0.05);
  if (head.length) {
    g.fillStyle = S.shade; g.fillRect(pad, y, tw, unit); g.fillStyle = d.ink ?? S.ink;
    line(head, y + unit / 2, true); y += unit;
  }
  const top = y - (head.length ? unit : 0);
  rows.forEach((r, i) => { line(r, y + unit / 2 + unit * 0.03, false); y += unit; if (i % 5 === 4 || i === rows.length - 1) { g.beginPath(); g.moveTo(pad, y); g.lineTo(pad + tw, y); g.stroke(); } });
  // the grid: an outer box, the head's underline, the column rules (every fifth row ruled, as 教务处's template does)
  g.strokeRect(pad, top, tw, y - top);
  g.beginPath(); if (head.length) { g.moveTo(pad, top + unit); g.lineTo(pad + tw, top + unit); }
  for (const x of xs.slice(1, -1)) { g.moveTo(x, top); g.lineTo(x, y); }
  g.stroke();
  g.restore();
  drawSheetTape(g, w, ox, oy, 1);
}

/** 成绩单 tape over the slot's two top corners (not turned with the paper: stuck on after); `keep` < 1 = torn stubs. */
function drawSheetTape(g: CanvasRenderingContext2D, w: number, ox: number, oy: number, keep: number): void {
  const S = POSTER.sheet, m = S.margin * S.ppm, pw = w - 2 * m, tl = pw * 0.14, th = pw * 0.045;
  g.fillStyle = S.tape;
  for (const [cx, a, sg] of [[ox + m + tl * 0.25, -0.6, -1], [ox + w - m - tl * 0.25, 0.6, 1]] as const) {
    // torn: only the outer end of each strip stays on the wall
    g.save(); g.translate(cx, oy + m + th * 0.4); g.rotate(a);
    g.fillRect(keep < 1 ? (sg * tl) / 2 - (sg > 0 ? tl * keep : 0) : -tl / 2, -th / 2, tl * keep, th); g.restore();
  }
}

/** A small deterministic generator from a string (the same 涂鸦 shakes the same way every load). */
function rng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => { h = Math.imul(h ^ (h >>> 15), 2246822519); h ^= h >>> 13; return ((h >>> 0) % 10007) / 10007; };
}

/**
 * 涂鸦: handwriting on a transparent slot. One line per `\n`, each character on its own small tilt / size / baseline
 * wobble, the whole lot tilted `rot`; a line starting `~` is scratched out with a back-and-forth scribble. Strokes are
 * opaque (the material alpha-tests at 0.45) and thin: from across the room they vanish in the mipmaps, up close they read.
 */
function drawScrawl(g: CanvasRenderingContext2D, d: PosterDef, w: number, h: number, ox: number, oy: number, day: number): void {
  const r = rng(d.text), ink = d.ink ?? POSTER.pencil, lines = posterText(d.text, day).split('\n');
  const fs = Math.min(h / (lines.length * 1.25), w / 3.2, POSTER.scrawlPpm * 0.07); // ≤ 7 cm characters
  g.save();
  g.translate(ox + w / 2, oy + h / 2); g.rotate(((d.rot ?? 0) * Math.PI) / 180);
  g.fillStyle = ink; g.strokeStyle = ink; g.lineCap = 'round'; g.lineJoin = 'round';
  g.textAlign = 'left'; g.textBaseline = 'middle';
  const rows = lines.map((l, i) => ({ l: l.replace(/^~/, ''), out: l.startsWith('~'), y: (i - (lines.length - 1) / 2) * fs * 1.22 }));
  let last = { x0: 0, x1: 0, y: 0 };
  for (const row of rows) {
    // lay the characters out first (each its own size), then centre the line, a little off to one side
    const cs = [...row.l].map(c => ({ c, s: fs * (0.88 + 0.22 * r()), t: (r() - 0.5) * 0.22, dy: (r() - 0.5) * fs * 0.12, w: 0 }));
    for (const c of cs) { g.font = `${c.s}px ${FONT}`; c.w = g.measureText(c.c).width * (0.92 + 0.1 * r()); }
    const tw = cs.reduce((a, c) => a + c.w, 0), fit = Math.min(1, (w * 0.94) / Math.max(1, tw));
    let x = -tw * fit / 2 + (r() - 0.5) * fs * 0.4;
    const x0 = x;
    for (const c of cs) {
      const cw = c.w * fit;
      g.save(); g.translate(x, row.y + c.dy); g.rotate(c.t); g.scale(fit, 1); g.font = `${c.s}px ${FONT}`; g.fillText(c.c, 0, 0);
      // gone over once more (a pen pressed into the paint): fatter strokes keep their alpha further down the mipmaps
      g.lineWidth = Math.max(1.5, c.s * 0.045); g.strokeText(c.c, 0, 0); g.restore();
      x += cw;
    }
    if (row.out) {
      // scratched out: a tight zigzag over the words, pressed hard (wider than the letters' strokes)
      g.lineWidth = Math.max(2, fs * 0.09); g.beginPath();
      // there and back again, so no word underneath survives
      const n = Math.max(6, Math.round((x - x0) / (fs * 0.14)));
      for (let k = 0; k <= 2 * n; k++) {
        const j = k <= n ? k : 2 * n - k, px = x0 - fs * 0.1 + ((x - x0 + fs * 0.2) * j) / n;
        const py = row.y + (k % 2 ? -1 : 1) * fs * (0.3 + 0.12 * r());
        if (k) g.lineTo(px, py); else g.moveTo(px, py);
      }
      g.stroke();
    }
    last = { x0, x1: x, y: row.y };
  }
  g.lineWidth = Math.max(2, fs * 0.06);
  for (const k of d.doodle ?? []) {
    g.beginPath();
    if (k === 'line38') {
      // 三八线: down the slot's left edge (toward the 同桌 when the desk is the right one), gone over twice
      for (let p = 0; p < 2; p++) {
        const lx = -w / 2 + fs * 0.25 + p * 2;
        g.moveTo(lx + (r() - 0.5) * 3, -h / 2 + 2);
        for (let t = 1; t <= 6; t++) g.lineTo(lx + (r() - 0.5) * 4, -h / 2 + 2 + ((h - 4) * t) / 6);
      }
    } else if (k === 'face') {
      // a crude face after the last line: a circle, two dots, a flat mouth
      const R = fs * 0.42, cx = Math.min(w / 2 - R - 2, last.x1 + R * 1.5), cy = last.y;
      g.arc(cx, cy, R, 0, Math.PI * 2);
      g.moveTo(cx - R * 0.35 + 1.5, cy - R * 0.25); g.arc(cx - R * 0.35, cy - R * 0.25, 1.5, 0, Math.PI * 2);
      g.moveTo(cx + R * 0.35 + 1.5, cy - R * 0.25); g.arc(cx + R * 0.35, cy - R * 0.25, 1.5, 0, Math.PI * 2);
      g.moveTo(cx - R * 0.4, cy + R * 0.4); g.lineTo(cx + R * 0.4, cy + R * 0.32);
    } else if (k === 'ring') {
      // a ring round the last line, not quite closed
      const cx = (last.x0 + last.x1) / 2, rx = (last.x1 - last.x0) / 2 + fs * 0.3;
      g.ellipse(cx, last.y, rx, fs * 0.7, -0.04, 0.3, Math.PI * 2 + 0.1);
    } else {
      // an arrow from the last line's end up toward the line above
      const ax = Math.min(w / 2 - 4, last.x1 + fs * 0.3), ay = last.y, bx = ax + fs * 0.1, by = last.y - fs * 1.1;
      g.moveTo(ax, ay); g.quadraticCurveTo(ax + fs * 0.5, (ay + by) / 2, bx, by);
      g.moveTo(bx - fs * 0.22, by + fs * 0.12); g.lineTo(bx, by); g.lineTo(bx + fs * 0.16, by + fs * 0.22);
    }
    g.stroke();
  }
  g.restore();
}

/** Every 班牌 key in the campus (atlas order: building, storey, room). */
export function plateKeys(buildings: BuildingDef[], plates: Record<string, PlateDef> = DECALS.plates): string[] {
  return buildings.flatMap(b => floorStack(b).flatMap(st => storeyPlates(b, st.level, plates).map(p => p.key)));
}

/** Every 墙面贴 key that lands on some storey of `buildings` (data order). */
export function posterKeys(buildings: BuildingDef[], posters: Record<string, PosterDef> = DECALS.posters): string[] {
  const on = new Set(buildings.flatMap(b => floorStack(b).flatMap(st => storeyPosters(b, st.level, posters).map(p => p.key))));
  return Object.keys(posters).filter(k => on.has(k));
}

/** A storey's 墙面贴 into its decal geometry: one textured quad each into its atlas slot. */
function addPosters(buf: QuadBuf, posters: PosterSpot[], slot: (key: string) => [number, number], size: (key: string) => readonly [number, number], H: number): void {
  for (const p of posters) buf.quad(p.q, p.n, slotUV(slot(p.key), size(p.key), H));
}

/**
 * The decals in the scene: one atlas for the campus (a slot per 班牌 and per 墙面贴), one mesh per storey that has
 * any. Without a DOM (unit tests) there is no canvas: the decals draw as their material's plain colour.
 */
export class Decals {
  readonly texture: THREE.CanvasTexture | null = null;
  private g: CanvasRenderingContext2D | null = null;
  /** 班牌 keys (room keys) and 墙面贴 keys (data names) */
  readonly keys: string[];
  readonly posterKeys: string[];
  /** current plate per key (null = taken down) */
  readonly plates: Record<string, PlateDef | null>;
  /** current 墙面贴 per key (null = taken down); where it hangs never changes */
  readonly posters: Record<string, PosterDef | null>;
  private readonly at: Map<string, [number, number]>;
  private readonly spots: Record<string, PosterDef>;
  readonly height: number;
  private day = 0;
  constructor(buildings: BuildingDef[], plates: Record<string, PlateDef> = DECALS.plates, posters: Record<string, PosterDef> = { ...DECALS.posters, ...hydrantPosters(buildings), ...doorSigns(buildings) }) {
    this.keys = plateKeys(buildings, plates);
    this.posterKeys = posterKeys(buildings, posters);
    this.plates = Object.fromEntries(this.keys.map(k => [k, plates[k]]));
    this.posters = Object.fromEntries(this.posterKeys.map(k => [k, posters[k]]));
    this.spots = posters;
    const pack = packSlots([...this.keys.map(() => PLATE.px), ...this.posterKeys.map(k => posterPx(posters[k]))]);
    this.at = new Map([...this.keys, ...this.posterKeys.map(k => `poster:${k}`)].map((k, i) => [k, pack.at[i]]));
    this.height = pack.h;
    if (typeof document === 'undefined') return;
    const c = document.createElement('canvas');
    c.width = ATLAS_W; c.height = pack.h;
    this.g = c.getContext('2d');
    if (!this.g) return;
    this.g.fillStyle = PLATE.edge; this.g.fillRect(0, 0, SOLID, SOLID);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
    this.texture = tex;
    for (const k of this.keys) this.draw(k);
    for (const k of this.posterKeys) this.drawPoster(k);
  }
  private draw(key: string): void {
    if (!this.g || !this.texture) return;
    const [x, y] = this.at.get(key)!;
    drawPlate(this.g, this.plates[key], x, y);
    this.texture.needsUpdate = true;
  }
  private drawPoster(key: string): void {
    if (!this.g || !this.texture) return;
    const [x, y] = this.at.get(`poster:${key}`)!;
    // a 涂鸦 rubbed off leaves nothing (its slot transparent), not the paler patch of a sign taken down
    if (!this.posters[key] && this.spots[key].style === 'scrawl') {
      const [w, h] = posterPx(this.spots[key]);
      this.g.clearRect(x, y, w, h); this.texture.needsUpdate = true;
      return;
    }
    // a 成绩单 torn down leaves the corners of its tape (the paint behind printed paper does not fade)
    if (!this.posters[key] && this.spots[key].style === 'sheet') {
      const [w, h] = posterPx(this.spots[key]);
      this.g.clearRect(x, y, w, h);
      drawSheetTape(this.g, w, x, y, 0.35);
      this.texture.needsUpdate = true;
      return;
    }
    drawPoster(this.g, this.posters[key], posterPx(this.spots[key]), x, y, this.day);
    this.texture.needsUpdate = true;
  }
  /** Change room `key`'s 班牌 (null = take it down, the bracket stays); redraws that slot only. */
  set(key: string, plate: PlateDef | null): void {
    if (!this.at.has(key)) throw new Error(`decals: no 班牌 at ${key}`);
    this.plates[key] = plate;
    this.draw(key);
  }
  /**
   * Change 墙面贴 `key`'s words / look (null = take it down); it stays where it hangs and keeps its size. Redraws
   * that slot only.
   */
  setPoster(key: string, poster: Pick<PosterDef, 'text'> & Partial<Pick<PosterDef, 'sub' | 'style' | 'ink' | 'head' | 'rows'>> | null): void {
    if (!this.at.has(`poster:${key}`)) throw new Error(`decals: no 墙面贴 ${key}`);
    this.posters[key] = poster && { ...this.spots[key], sub: undefined, ink: undefined, ...poster };
    this.drawPoster(key);
  }
  /** The game day: redraws the 墙面贴 that count down to 高考 (no-op if unchanged). */
  sync(day: number): void {
    const d = Math.floor(day);
    if (d === this.day) return;
    this.day = d;
    for (const k of this.posterKeys) if (/\{n\}/.test(`${this.posters[k]?.text}${this.posters[k]?.sub ?? ''}`)) this.drawPoster(k);
  }
  /** The decal mesh of one storey (null if it has none), under a copy of the interior material with the atlas. */
  storeyMesh(b: BuildingDef, level: number, interior: THREE.MeshLambertMaterial): THREE.Mesh | null {
    const ps = storeyPlates(b, level).filter(p => this.at.has(p.key));
    const qs = storeyPosters(b, level, this.spots).filter(p => this.at.has(`poster:${p.key}`));
    if (!ps.length && !qs.length) return null;
    const buf = new QuadBuf(b);
    addPlates(buf, ps, k => this.at.get(k)!, this.height);
    addPosters(buf, qs, k => this.at.get(`poster:${k}`)!, k => posterPx(this.spots[k]), this.height);
    return new THREE.Mesh(buf.geometry(), this.material(interior));
  }
  private mats = new Map<THREE.Material, THREE.MeshLambertMaterial>();
  private material(interior: THREE.MeshLambertMaterial): THREE.MeshLambertMaterial {
    let m = this.mats.get(interior);
    if (!m) {
      m = new THREE.MeshLambertMaterial({ vertexColors: true, map: this.texture, color: this.texture ? 0xffffff : 0x3e4a58 });
      m.onBeforeCompile = interior.onBeforeCompile;
      m.customProgramCacheKey = interior.customProgramCacheKey;
      m.userData.noSnow = true;
      // 涂鸦 have no ground: their slots are transparent round the strokes (班牌 / 标语 are opaque all over)
      m.alphaTest = 0.45;
      this.mats.set(interior, m);
    }
    return m;
  }
}
