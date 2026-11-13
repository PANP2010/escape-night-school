import * as THREE from 'three';
import { box, type AABB } from '../../../../shared/campus/collision.ts';
import { buildingHeight, WALL_T, type BuildingDef, type Side } from '../../../../shared/campus/campus_schema.ts';
import { Soup } from './building.ts';
import { SURF } from '../render/facade.ts';
import type { Face as FFace, FurnBox, Kind } from './classroom.ts';
import type { LBox } from '../../../../shared/campus/stairs.ts';

/**
 * 天台水箱间 (docs/03_campus.md, campus.json A tankRoom): a little brick-and-render room on the roof against the
 * 出屋面 bulkhead (their shared wall is the bulkhead's), shut by an iron door with a 挂锁; a cement 压顶 slab on it, two
 * 槽钢 across the slab and the steel panel 水箱 on them (flanged ribs, a 检修口, a 通气管; an 溢流管 down the north side, the
 * 进水管 up it), and a 铁爬梯 up the outside wall onto the slab, its stiles bent over the 压顶 (鹅颈). Nothing here
 * climbs: the ladder is a collider. The iron door stands pushed open (outward, its 挂锁 hanging open on the hasp):
 * inside is 据点 #1 (docs/04 据点系统) — the 水泵 pair on a plinth, risers up through the slab to the tank, 闸阀 with red
 * 手轮, a 配电箱, a bare bulb; two old 课桌 (one upside down on the other), chairs, and flattened 纸箱 on the floor
 * by the north wall with a bottle and some paper on them: someone has sat here (nobody says who).
 * The shell is its own mesh under the building material (world/campus.ts); the inside (lining, floor, ceiling,
 * furniture) is FurnBoxes drawn under the building's interior material, shown with the roof as a storey. Pure.
 */
export const TANK = {
  /** 压顶 slab: thickness, overhang past the walls */
  slab: { t: 0.16, out: 0.06 },
  /** the iron door: width, height; the walls' thickness (the inner lining); the leaf's thickness and how far it stands open (rad from shut, outward) */
  door: { w: 1.0, h: 2.0, t: 0.04, open: 2.0 }, wall: 0.12,
  /** 槽钢 height, width; the 水箱: inset from the slab edges, height; rib pitch, depth */
  beam: { h: 0.2, w: 0.12 }, tank: { inset: 0.7, h: 1.8, pitch: 1.0, rib: 0.04 },
  /** 爬梯: clear width, stile size, standoff from the wall (stile centre), rung pitch, 鹅颈 height above the slab */
  ladder: { w: 0.45, s: 0.05, off: 0.18, pitch: 0.3, neck: 0.9 },
  /** inside: the cement 墙裙's height above the floor (whitewash above it) */
  dado: 1.2,
};

const C = {
  door: '#5d6a62', frame: '#4c524d', lock: '#8e7a4e', slab: '#a9a49a', beam: '#4a4844', tank: '#a4aaa4', rib: '#8c938e',
  hatch: '#7d847f', pipe: '#77847c', ladder: '#5a524a',
};

/** The room's walls (world rect) and its height span. */
export function tankRoomRect(b: BuildingDef): { x0: number; x1: number; z0: number; z1: number; y0: number; y1: number } | undefined {
  const t = b.tankRoom;
  if (!t) return undefined;
  const y0 = buildingHeight(b);
  return { x0: b.x + t.x - t.w / 2, x1: b.x + t.x + t.w / 2, z0: b.z + t.z - t.d / 2, z1: b.z + t.z + t.d / 2, y0, y1: y0 + t.h };
}

/** The 水箱 body (world box): on the 槽钢, inset from the slab. */
export function tankBox(b: BuildingDef) {
  const r = tankRoomRect(b);
  if (!r) return undefined;
  const i = TANK.tank.inset, y0 = r.y1 + TANK.slab.t / 2 + TANK.beam.h;
  return { x0: r.x0 + i, x1: r.x1 - i, z0: r.z0 + i, z1: r.z1 - i, y0, y1: y0 + TANK.tank.h };
}

/** Where on the wall `side` a thing at `at` (m from the wall's centre) is: the wall plane, the along-wall coordinate. */
function onWall(b: BuildingDef, side: Side, at: number) {
  const r = tankRoomRect(b)!, t = b.tankRoom!, alongX = side[1] === 'z';
  const w = alongX ? (side[0] === '+' ? r.z1 : r.z0) : (side[0] === '+' ? r.x1 : r.x0);
  const u = (alongX ? b.x : b.z) + (alongX ? t.x : t.z) + at, sg = side[0] === '+' ? 1 : -1;
  return { alongX, w, u, sg };
}

/**
 * The iron door's leaf in plan (world): hinged at the doorway's −u jamb on the wall plane, swung `open` rad out past
 * square (it stands in the nook toward the bulkhead, the doorway clear).
 */
export function tankDoorLeaf(b: BuildingDef) {
  const t = b.tankRoom!, D = TANK.door, l = onWall(b, t.door.side, t.door.at), hu = l.u - D.w / 2;
  // along-wall / outward unit vectors in world (x, z)
  const U: [number, number] = l.alongX ? [1, 0] : [0, 1], O: [number, number] = l.alongX ? [0, l.sg] : [l.sg, 0];
  const hinge: [number, number] = l.alongX ? [hu, l.w] : [l.w, hu];
  const c = Math.cos(D.open), sn = Math.sin(D.open);
  // along the leaf from the hinge, and its outer face's normal (the shut leaf's outward face, turned with it)
  const dir: [number, number] = [U[0] * c + O[0] * sn, U[1] * c + O[1] * sn], face: [number, number] = [O[0] * c - U[0] * sn, O[1] * c - U[1] * sn];
  return { hinge, dir, face, len: D.w, l };
}

/**
 * A wall's thickness inside the rect: TANK.wall, or on a facade run up (the room flush with the building's outer
 * face) as thick as the 女儿墙 standing inside it, so the parapet is buried in the wall and not in the room.
 */
function wallT(b: BuildingDef, side: Side): number {
  const t = b.tankRoom!, sg = side[0] === '+' ? 1 : -1, ax = side[1] === 'x';
  const plane = (ax ? t.x + sg * t.w / 2 : t.z + sg * t.d / 2) * sg, face = (ax ? b.w : b.d) / 2;
  return Math.abs(plane - face) < 0.05 ? WALL_T + (plane - face) + 0.05 : TANK.wall;
}

/**
 * The room's clear inside (world rect, floor `y0` to the 压顶's underside `y1`) and its doorway on the door wall's
 * inner face (world bottom centre `x, z`, inward normal `nx, nz`, size `w` × `h`): render/interior_light.ts lights
 * the room through it.
 */
export function tankInside(b: BuildingDef) {
  const t = b.tankRoom;
  if (!t) return undefined;
  const y0 = buildingHeight(b), D = TANK.door, l = onWall(b, t.door.side, t.door.at), face = l.w - l.sg * wallT(b, t.door.side);
  return {
    x0: b.x + t.x - t.w / 2 + wallT(b, '-x'), x1: b.x + t.x + t.w / 2 - wallT(b, '+x'),
    z0: b.z + t.z - t.d / 2 + wallT(b, '-z'), z1: b.z + t.z + t.d / 2 - wallT(b, '+z'), y0, y1: y0 + t.h - TANK.slab.t / 2,
    door: { x: l.alongX ? l.u : face, z: l.alongX ? face : l.u, nx: l.alongX ? 0 : -l.sg, nz: l.alongX ? -l.sg : 0, w: D.w, h: D.h },
    bulb: tankBulb(b),
  };
}

/** The bare bulb on its flex (world centre): in the middle of the room, over the 配电箱's conduit run (tankRoomFurniture). */
export function tankBulb(b: BuildingDef): { x: number; y: number; z: number } {
  const t = b.tankRoom!, top = buildingHeight(b) + t.h - TANK.slab.t / 2;
  const X0 = t.x - t.w / 2 + wallT(b, '-x'), X1 = t.x + t.w / 2 - wallT(b, '+x'), Z0 = t.z - t.d / 2 + wallT(b, '-z'), Z1 = t.z + t.d / 2 - wallT(b, '+z');
  return { x: b.x + (X0 + X1) / 2, y: top - 0.605, z: b.z + (Z0 + Z1) / 2 - 0.3 };
}

/** How far (m) world point (x, z) inside the room is from its door wall's plane. */
export function tankDoorDepth(b: BuildingDef, x: number, z: number): number {
  const l = onWall(b, b.tankRoom!.door.side, 0);
  return Math.max(0, -l.sg * ((l.alongX ? z : x) - l.w));
}

/**
 * Colliders: the four walls (TANK.wall thick, inside the rect; the door wall round its doorway, a lintel over it),
 * the 压顶, the open leaf (short boxes along it: a turned slab is not an AABB), the 爬梯 standing off its wall, the
 * 水箱 on top, and what stands in the room.
 */
export function tankRoomColliders(b: BuildingDef): AABB[] {
  const r = tankRoomRect(b);
  if (!r) return [];
  const t = b.tankRoom!, h = r.y1 - r.y0, D = TANK.door;
  const rect = (x0: number, x1: number, z0: number, z1: number, y0 = r.y0, y1 = r.y1): AABB => ({ minX: x0, maxX: x1, minZ: z0, maxZ: z1, minY: y0, maxY: y1 });
  const out: AABB[] = [];
  for (const side of ['+x', '-x', '+z', '-z'] as Side[]) {
    const l = onWall(b, side, 0), [a, e] = l.alongX ? [r.x0, r.x1] : [r.z0, r.z1], W = wallT(b, side);
    const w0 = Math.min(l.w, l.w - l.sg * W), w1 = Math.max(l.w, l.w - l.sg * W);
    const seg = (u0: number, u1: number, y0 = r.y0) => out.push(l.alongX ? rect(u0, u1, w0, w1, y0) : rect(w0, w1, u0, u1, y0));
    if (side !== t.door.side) { seg(a, e); continue; }
    const dl = onWall(b, side, t.door.at), d0 = dl.u - D.w / 2, d1 = dl.u + D.w / 2;
    seg(a, d0); seg(d1, e); seg(d0, d1, r.y0 + D.h);
  }
  out.push(rect(r.x0, r.x1, r.z0, r.z1, r.y1 - TANK.slab.t / 2, r.y1 + TANK.slab.t / 2));
  // the leaf: 4 boxes along it
  const f = tankDoorLeaf(b), n = 4;
  for (let i = 0; i < n; i++) {
    const p0 = [f.hinge[0] + f.dir[0] * f.len * i / n, f.hinge[1] + f.dir[1] * f.len * i / n];
    const p1 = [f.hinge[0] + f.dir[0] * f.len * (i + 1) / n, f.hinge[1] + f.dir[1] * f.len * (i + 1) / n];
    const e = D.t / 2;
    out.push(rect(Math.min(p0[0], p1[0]) - e, Math.max(p0[0], p1[0]) + e, Math.min(p0[1], p1[1]) - e, Math.max(p0[1], p1[1]) + e, r.y0, r.y0 + D.h));
  }
  const L = TANK.ladder, l = onWall(b, t.ladder.side, t.ladder.at), deep = L.off + L.s / 2;
  const cw = l.w + l.sg * deep / 2, ww = L.w + 2 * L.s;
  out.push(l.alongX ? box(l.u, cw, ww, deep, h, r.y0) : box(cw, l.u, deep, ww, h, r.y0));
  const k = tankBox(b)!;
  out.push(box((k.x0 + k.x1) / 2, (k.z0 + k.z1) / 2, k.x1 - k.x0, k.z1 - k.z0, k.y1 - r.y1, r.y1));
  for (const q of tankRoomFurniture(b).solid) out.push(rect(b.x + q.x0, b.x + q.x1, b.z + q.z0, b.z + q.z1, q.y0, q.y1));
  return out;
}

const N = { '+x': new THREE.Vector3(1, 0, 0), '-x': new THREE.Vector3(-1, 0, 0), '+z': new THREE.Vector3(0, 0, 1), '-z': new THREE.Vector3(0, 0, -1) };
const UP = new THREE.Vector3(0, 1, 0), DOWN = new THREE.Vector3(0, -1, 0);
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
type Face = Side | 'top' | 'bottom';

/** An axis-aligned box's faces (sides 0.9 shade of `c`, top `c`, bottom 0.75), less the ones in `skip`. */
function cube(s: Soup, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, c: THREE.Color, skip: Face[] = [], kind: number = SURF.plain): void {
  const sd = c.clone().multiplyScalar(0.9);
  if (!skip.includes('+x')) s.quad(V(x1, y0, z0), V(x1, y0, z1), V(x1, y1, z1), V(x1, y1, z0), N['+x'], sd, kind);
  if (!skip.includes('-x')) s.quad(V(x0, y0, z0), V(x0, y0, z1), V(x0, y1, z1), V(x0, y1, z0), N['-x'], sd, kind);
  if (!skip.includes('+z')) s.quad(V(x0, y0, z1), V(x1, y0, z1), V(x1, y1, z1), V(x0, y1, z1), N['+z'], sd, kind);
  if (!skip.includes('-z')) s.quad(V(x0, y0, z0), V(x1, y0, z0), V(x1, y1, z0), V(x0, y1, z0), N['-z'], sd, kind);
  if (!skip.includes('top')) s.quad(V(x0, y1, z0), V(x1, y1, z0), V(x1, y1, z1), V(x0, y1, z1), UP, c, kind);
  if (!skip.includes('bottom')) s.quad(V(x0, y0, z0), V(x1, y0, z0), V(x1, y0, z1), V(x0, y0, z1), DOWN, c.clone().multiplyScalar(0.75), kind);
}

/**
 * A box given in wall terms on a wall of the room: along-wall u0..u1, out from the wall plane o0..o1 (m, outward
 * positive), y0..y1.
 */
function wallCube(s: Soup, l: ReturnType<typeof onWall>, u0: number, u1: number, o0: number, o1: number, y0: number, y1: number, c: THREE.Color, skip: Face[] = []): void {
  const w0 = l.w + l.sg * o0, w1 = l.w + l.sg * o1, a = Math.min(w0, w1), e = Math.max(w0, w1);
  if (l.alongX) cube(s, u0, u1, y0, y1, a, e, c, skip);
  else cube(s, a, e, y0, y1, u0, u1, c, skip);
}

/** Render geometry (world space, the building material's attributes): walls, door, 压顶, 槽钢, 水箱, pipes, 爬梯. */
export function tankRoomGeometry(b: BuildingDef): THREE.BufferGeometry | undefined {
  const t = b.tankRoom, r = tankRoomRect(b);
  if (!t || !r) return undefined;
  const s = new Soup(), col = (hex: string, k = 1) => new THREE.Color(hex).multiplyScalar(k);
  const wallC = col(b.color, 0.95), kind = b.material === 'brick' ? SURF.brick : SURF.plain;
  const D = TANK.door, dl = onWall(b, t.door.side, t.door.at), d0 = dl.u - D.w / 2, d1 = dl.u + D.w / 2, dh = r.y0 + D.h;
  // walls (not the one shared with the bulkhead); the door's wall is cut round the doorway, the leaf recessed in it
  for (const side of ['+x', '-x', '+z', '-z'] as Side[]) {
    if (side === t.back) continue;
    const l = onWall(b, side, 0), [a, e] = l.alongX ? [r.x0, r.x1] : [r.z0, r.z1];
    const P = (u: number, y: number, o = 0) => (l.alongX ? V(u, y, l.w + l.sg * o) : V(l.w + l.sg * o, y, u));
    const q = (u0: number, u1: number, y0: number, y1: number) => s.quad(P(u0, y0), P(u1, y0), P(u1, y1), P(u0, y1), N[side], wallC, kind);
    if (side !== t.door.side) { q(a, e, r.y0, r.y1); continue; }
    q(a, d0, r.y0, r.y1); q(d1, e, r.y0, r.y1); q(d0, d1, dh, r.y1);
    // reveals and head through the wall's thickness, a steel 门框 round the outside
    const rv = wallC.clone().multiplyScalar(0.82), tg = l.alongX ? N['+x'] : N['+z'], tn = tg.clone().negate(), o = -TANK.wall;
    s.quad(P(d0, r.y0), P(d0, r.y0, o), P(d0, dh, o), P(d0, dh), tg, rv);
    s.quad(P(d1, r.y0), P(d1, r.y0, o), P(d1, dh, o), P(d1, dh), tn, rv);
    s.quad(P(d0, dh), P(d1, dh), P(d1, dh, o), P(d0, dh, o), DOWN, rv.clone().multiplyScalar(0.85));
    const fr = col(C.frame), f = 0.05, fo = 0.02;
    wallCube(s, dl, d0 - f, d0, 0, fo, r.y0, dh + f, fr, ['bottom']);
    wallCube(s, dl, d1, d1 + f, 0, fo, r.y0, dh + f, fr, ['bottom']);
    wallCube(s, dl, d0, d1, 0, fo, dh, dh + f, fr, ['bottom']);
    leaf(s, b, col, r.y0);
  }
  // 压顶: the slab over the walls, overhanging a little all round (its underside shows)
  const S = TANK.slab, sy0 = r.y1 - S.t / 2, sy1 = r.y1 + S.t / 2;
  cube(s, r.x0 - S.out, r.x1 + S.out, sy0, sy1, r.z0 - S.out, r.z1 + S.out, col(C.slab));
  // two 槽钢 across the slab (along the room's long axis), the 水箱 on them
  const k = tankBox(b)!, B = TANK.beam, alongX = r.x1 - r.x0 >= r.z1 - r.z0, beamC = col(C.beam);
  for (const f of [0.22, 0.78]) {
    if (alongX) { const z = k.z0 + (k.z1 - k.z0) * f; cube(s, k.x0 - 0.3, k.x1 + 0.3, sy1, sy1 + B.h, z - B.w / 2, z + B.w / 2, beamC, ['bottom']); }
    else { const x = k.x0 + (k.x1 - k.x0) * f; cube(s, x - B.w / 2, x + B.w / 2, sy1, sy1 + B.h, k.z0 - 0.3, k.z1 + 0.3, beamC, ['bottom']); }
  }
  tank(s, k, col);
  // 溢流管 off the tank's +z side, out past the slab edge and down to the roof; 进水管 up the same wall into the tank
  const pc = col(C.pipe), p = 0.06, iz = r.z1 + S.out + 0.08, ox = (k.x0 + k.x1) / 2 + 1.2;
  cube(s, ox - p / 2, ox + p / 2, k.y1 - 0.3, k.y1 - 0.3 + p, k.z1, iz + p / 2, pc);
  cube(s, ox - p / 2, ox + p / 2, r.y0, k.y1 - 0.3, iz - p / 2, iz + p / 2, pc, ['bottom']);
  const ix = (k.x0 + k.x1) / 2 - 1.2;
  cube(s, ix - p / 2, ix + p / 2, r.y0, sy1 + 0.5, iz - p / 2, iz + p / 2, pc, ['bottom']);
  cube(s, ix - p / 2, ix + p / 2, sy1 + 0.5 - p, sy1 + 0.5, k.z1, iz + p / 2, pc);
  ladder(s, onWall(b, t.ladder.side, t.ladder.at), r.y0, sy1, col(C.ladder));
  return s.geometry();
}

/**
 * The open iron leaf (tankDoorLeaf): a plate TANK.door.t thick standing out from its hinge, a raised 门框 round its
 * outer face and a 腰档 across it, the hasp at its free edge with the 挂锁 hanging open from it.
 */
function leaf(s: Soup, b: BuildingDef, col: (hex: string, k?: number) => THREE.Color, y0: number): void {
  const D = TANK.door, f = tankDoorLeaf(b), [dx, dz] = f.dir, ht = D.t / 2;
  // the leaf's frame: u along it from the hinge, v out of its outer face
  const nn = f.face;
  const P = (u: number, y: number, v: number) => V(f.hinge[0] + dx * u + nn[0] * v, y, f.hinge[1] + dz * u + nn[1] * v);
  const NV = (a: number, c: number) => V(a, 0, c).normalize();
  const plate = (u0: number, u1: number, ya: number, yb: number, v0: number, v1: number, c: THREE.Color) => {
    const cs = c.clone().multiplyScalar(0.9);
    s.quad(P(u0, ya, v1), P(u1, ya, v1), P(u1, yb, v1), P(u0, yb, v1), NV(nn[0], nn[1]), c);
    s.quad(P(u0, ya, v0), P(u1, ya, v0), P(u1, yb, v0), P(u0, yb, v0), NV(-nn[0], -nn[1]), c.clone().multiplyScalar(0.85));
    s.quad(P(u1, ya, v0), P(u1, ya, v1), P(u1, yb, v1), P(u1, yb, v0), NV(dx, dz), cs);
    s.quad(P(u0, ya, v0), P(u0, ya, v1), P(u0, yb, v1), P(u0, yb, v0), NV(-dx, -dz), cs);
    s.quad(P(u0, yb, v0), P(u1, yb, v0), P(u1, yb, v1), P(u0, yb, v1), UP, c);
  };
  const L = f.len - 0.02, H = D.h - 0.02, y = y0 + 0.01, fc = col(C.frame), fw = 0.05, fo = 0.02;
  plate(0.01, L, y, y + H, -ht, ht, col(C.door));
  plate(0.01, 0.01 + fw, y, y + H, ht, ht + fo, fc);
  plate(L - fw, L, y, y + H, ht, ht + fo, fc);
  plate(0.01 + fw, L - fw, y + H - fw, y + H, ht, ht + fo, fc);
  plate(0.01 + fw, L - fw, y + 0.95, y + 1.0, ht, ht + fo * 0.6, fc);
  // the hasp on the free edge, the 挂锁 hanging open off it (its shackle swung down)
  const lc = col(C.lock);
  plate(L - 0.21, L - 0.11, y + 1.07, y + 1.15, ht, ht + 0.03, fc);
  plate(L - 0.19, L - 0.13, y + 0.9, y + 0.98, ht + 0.03, ht + 0.06, lc);
  plate(L - 0.175, L - 0.165, y + 0.98, y + 1.07, ht + 0.035, ht + 0.045, lc);
}

/** The panel 水箱: a body with flanged ribs (vertical every `pitch`, one round the middle), a 检修口 and a 通气管 on top. */
function tank(s: Soup, k: NonNullable<ReturnType<typeof tankBox>>, col: (hex: string, k?: number) => THREE.Color): void {
  const T = TANK.tank, rc = col(C.rib), e = T.rib;
  cube(s, k.x0, k.x1, k.y0, k.y1, k.z0, k.z1, col(C.tank), ['bottom']);
  // ribs: thin strips proud of each side (their ends overshoot the corners so the corners close)
  const ym = (k.y0 + k.y1) / 2;
  cube(s, k.x0 - e, k.x1 + e, ym - 0.03, ym + 0.03, k.z0 - e, k.z1 + e, rc, ['top', 'bottom']);
  cube(s, k.x0 - e, k.x1 + e, k.y1 - 0.05, k.y1 + 0.01, k.z0 - e, k.z1 + e, rc, ['bottom']);
  for (let x = k.x0 + T.pitch; x < k.x1 - 0.3; x += T.pitch) {
    cube(s, x - 0.025, x + 0.025, k.y0, k.y1, k.z1, k.z1 + e, rc, ['bottom', 'top', '-z']);
    cube(s, x - 0.025, x + 0.025, k.y0, k.y1, k.z0 - e, k.z0, rc, ['bottom', 'top', '+z']);
  }
  for (let z = k.z0 + T.pitch; z < k.z1 - 0.3; z += T.pitch) {
    cube(s, k.x1, k.x1 + e, k.y0, k.y1, z - 0.025, z + 0.025, rc, ['bottom', 'top', '-x']);
    cube(s, k.x0 - e, k.x0, k.y0, k.y1, z - 0.025, z + 0.025, rc, ['bottom', 'top', '+x']);
  }
  // 检修口 (a raised curb, its lid a little bigger, a hasp), 通气管 with its turned-down cap
  const hx = k.x1 - 0.7, hz = (k.z0 + k.z1) / 2, hc = col(C.hatch);
  cube(s, hx - 0.3, hx + 0.3, k.y1 + 0.01, k.y1 + 0.12, hz - 0.3, hz + 0.3, hc, ['bottom']);
  cube(s, hx - 0.34, hx + 0.34, k.y1 + 0.12, k.y1 + 0.15, hz - 0.34, hz + 0.34, hc);
  cube(s, hx + 0.34, hx + 0.37, k.y1 + 0.04, k.y1 + 0.13, hz - 0.03, hz + 0.03, col(C.lock));
  const vx = k.x0 + 0.5, vz = k.z1 - 0.5, pc = col(C.pipe);
  cube(s, vx - 0.04, vx + 0.04, k.y1 + 0.01, k.y1 + 0.5, vz - 0.04, vz + 0.04, pc, ['bottom', 'top']);
  cube(s, vx - 0.09, vx + 0.09, k.y1 + 0.5, k.y1 + 0.58, vz - 0.09, vz + 0.09, pc);
}

/**
 * 铁爬梯 up wall `l` from the roof (y0) to the 压顶 (top): two flat stiles standing `off` out from the wall on brackets,
 * round rungs every `pitch`, the stiles running on `neck` above the slab and bending back over it (鹅颈) down onto it.
 */
function ladder(s: Soup, l: ReturnType<typeof onWall>, y0: number, top: number, c: THREE.Color): void {
  const L = TANK.ladder, hs = L.s / 2, yt = top + L.neck;
  for (const u of [l.u - L.w / 2 - hs, l.u + L.w / 2 + hs]) {
    wallCube(s, l, u - hs, u + hs, L.off - 0.01, L.off + 0.01, y0, yt, c, ['bottom', 'top']);
    // 鹅颈: over the 压顶 edge and down onto the slab 0.3 m in
    wallCube(s, l, u - hs, u + hs, -0.3, L.off + 0.01, yt - 0.02, yt, c);
    wallCube(s, l, u - hs, u + hs, -0.32, -0.3, top, yt - 0.02, c, ['bottom', 'top']);
    // brackets back to the wall
    for (const y of [y0 + 0.5, top - 0.5]) wallCube(s, l, u - 0.015, u + 0.015, 0, L.off - 0.01, y - 0.03, y + 0.03, c);
  }
  for (let y = y0 + L.pitch; y < yt - 0.1; y += L.pitch) wallCube(s, l, l.u - L.w / 2, l.u + L.w / 2, L.off - 0.015, L.off + 0.015, y - 0.015, y + 0.015, c, l.alongX ? ['+x', '-x'] : ['+z', '-z']);
}

type Put = (kind: Kind, q: LBox, skip?: FFace[], more?: Partial<FurnBox>) => void;
const bx = (x0: number, x1: number, z0: number, z1: number, y0: number, y1: number): LBox => ({ x0, x1, z0, z1, y0, y1 });
const ALL: FFace[] = ['+x', '-x', '+z', '-z', 'top', 'bottom'];
const only = (...keep: FFace[]) => ALL.filter(q => !keep.includes(q));

/**
 * Inside the 水箱间 (building-local boxes, y = the roof): the cement lining of the four walls (cut round the doorway),
 * the floor screed (the roof slab under it takes lying snow; this does not) and the slab's underside; the 水泵 pair on
 * their plinth under the north wall, risers up into the tank with 闸阀, a 配电箱 on the west wall with its conduit, a
 * bare bulb on its flex; two 课桌 stacked (the top one upside down) in the north-east corner, a chair; flattened
 * 纸箱 along the bulkhead wall in the west half, one folded under the end like a pillow, a bottle and some paper on them.
 */
export function tankRoomFurniture(b: BuildingDef): { render: FurnBox[]; solid: LBox[] } {
  const out = { render: [] as FurnBox[], solid: [] as LBox[] }, t = b.tankRoom;
  if (!t) return out;
  const put: Put = (kind, q, skip = ['bottom'], more = {}) => out.render.push({ ...q, kind, skip, ...more });
  const D = TANK.door, y = buildingHeight(b), top = y + t.h - TANK.slab.t / 2, e = 0.01;
  const X0 = t.x - t.w / 2 + wallT(b, '-x'), X1 = t.x + t.w / 2 - wallT(b, '+x'), Z0 = t.z - t.d / 2 + wallT(b, '-z'), Z1 = t.z + t.d / 2 - wallT(b, '+z');
  // lining: each wall's inner face (a thin box showing that face only); the door wall in three pieces round the hole
  const face: Record<Side, FFace> = { '+x': '-x', '-x': '+x', '+z': '-z', '-z': '+z' };
  for (const side of ['+x', '-x', '+z', '-z'] as Side[]) {
    const alongX = side[1] === 'z', pos = side[0] === '+';
    const w0 = alongX ? (pos ? Z1 : Z0 - e) : (pos ? X1 : X0 - e), w1 = w0 + e;
    // cement 墙裙 to TANK.dado, whitewash above
    const seg = (u0: number, u1: number, y0: number, y1: number) => {
      const yd = y + TANK.dado, box = (k: Kind, v0: number, v1: number) => put(k, alongX ? bx(u0, u1, w0, w1, v0, v1) : bx(w0, w1, u0, u1, v0, v1), only(face[side]));
      if (y0 < yd) box('cement', y0, Math.min(y1, yd));
      if (y1 > yd) box('lime', Math.max(y0, yd), y1);
    };
    const [a, c] = alongX ? [X0, X1] : [Z0, Z1];
    if (side !== t.door.side) { seg(a, c, y, top); continue; }
    const du = (alongX ? t.x : t.z) + t.door.at, d0 = du - D.w / 2, d1 = du + D.w / 2;
    seg(a, d0, y, top); seg(d1, c, y, top); seg(d0, d1, y + D.h, top);
  }
  put('cementD', bx(X0, X1, Z0, Z1, y, y + e), only('top'));
  put('lime', bx(X0, X1, Z0, Z1, top - e, top), only('bottom'));
  // 水泵 pair on a plinth along the north wall, west half: motor, coupling, the pump body; risers up into the tank
  const px0 = X0 + 0.4, px1 = X0 + 2.6, pz1 = Z1 - 0.15, pz0 = pz1 - 0.9;
  put('cement', bx(px0, px1, pz0, pz1, y, y + 0.15));
  out.solid.push(bx(px0, px1, pz0, pz1, y, y + 0.75));
  for (const cx of [px0 + 0.55, px1 - 0.55]) {
    const cz = (pz0 + pz1) / 2, b0 = y + 0.15;
    put('tankMotor', bx(cx - 0.35, cx + 0.05, cz - 0.17, cz + 0.17, b0 + 0.05, b0 + 0.39));     // motor
    put('blrIron', bx(cx - 0.3, cx + 0.3, cz - 0.2, cz + 0.2, b0, b0 + 0.05));                  // base frame
    put('blrIron', bx(cx + 0.05, cx + 0.12, cz - 0.08, cz + 0.08, b0 + 0.14, b0 + 0.3));        // coupling
    put('tankPump', bx(cx + 0.12, cx + 0.32, cz - 0.15, cz + 0.15, b0 + 0.05, b0 + 0.42));      // pump body
    // riser off the pump, up the wall and through the slab; a 闸阀 on it with its red 手轮
    const rx = cx + 0.22, rz = pz1 - 0.08;
    put('steel', bx(rx - 0.04, rx + 0.04, cz - 0.04, rz + 0.04, b0 + 0.42, b0 + 0.5));
    put('steel', bx(rx - 0.04, rx + 0.04, rz - 0.04, rz + 0.04, b0 + 0.42, top), ['top', 'bottom']);
    put('blrIron', bx(rx - 0.07, rx + 0.07, rz - 0.07, rz + 0.07, y + 1.3, y + 1.5));
    put('blrValve', bx(rx - 0.13, rx + 0.13, rz - 0.18, rz - 0.15, y + 1.27, y + 1.53));
  }
  // the suction main along the wall at knee height, into the 进水管 through the north wall
  put('steel', bx(px0 - 0.1, px1 + 0.3, Z1 - 0.1, Z1 - 0.02, y + 0.5, y + 0.58), ['+z']);
  // 配电箱 on the west wall, its conduit up to the ceiling; the bulb on its flex in the middle of the room
  const ez = (Z0 + Z1) / 2 - 0.3;
  put('cabinet', bx(X0, X0 + 0.18, ez - 0.25, ez + 0.25, y + 1.35, y + 2.0), ['-x']);
  put('cord', bx(X0, X0 + 0.04, ez - 0.02, ez + 0.02, y + 2.0, top), ['-x', 'top', 'bottom']);
  put('cord', bx(X0, (X0 + X1) / 2, ez - 0.015, ez + 0.015, top - 0.03, top), ['top']);
  const lx = (X0 + X1) / 2;
  // (the bulb's place is tankBulb: keep the two in step)
  put('cord', bx(lx - 0.008, lx + 0.008, ez - 0.008, ez + 0.008, top - 0.55, top), ['top', 'bottom']);
  put('enamel', bx(lx - 0.035, lx + 0.035, ez - 0.035, ez + 0.035, top - 0.66, top - 0.55), []);
  // 课桌 pair stacked in the north-east corner (the top one upside down, legs up), a chair by them
  const dx = X1 - 0.5, dz = Z1 - 0.4, hw = 0.3, hd = 0.21, H = 0.76;
  const desk = (y0: number, up: boolean) => {
    const tp = up ? y0 + H - 0.03 : y0, tq = tp + 0.03;
    put('wood', bx(dx - hw, dx + hw, dz - hd, dz + hd, tp, tq), up ? ['bottom'] : []);
    // 桌肚 under (or, upside down, over) the top
    const m0 = up ? tp - 0.15 : tq, m1 = up ? tp : tq + 0.15;
    put('steel', bx(dx - hw + 0.03, dx + hw - 0.03, dz - hd + 0.02, dz + hd - 0.02, m0, m1), [], { mouth: '-x' });
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const lx2 = dx + sx * (hw - 0.03), lz = dz + sz * (hd - 0.03);
      put('steel', bx(lx2 - 0.015, lx2 + 0.015, lz - 0.015, lz + 0.015, up ? y0 : tq, up ? tp : tq + H - 0.03), ['bottom', 'top']);
    }
  };
  desk(y, true); desk(y + H, false);
  out.solid.push(bx(dx - hw, dx + hw, dz - hd, dz + hd, y, y + 2 * H));
  chair(put, out.solid, dx - 0.85, dz - 0.15, y, 0.35);
  // 纸箱 flattened along the bulkhead wall, west half; one folded double at the west end; on them a bottle, paper
  const cz0 = Z0 + 0.1;
  put('box', bx(X0 + 0.15, X0 + 1.15, cz0, cz0 + 0.75, y + e, y + 0.025), ['bottom'], { rot: 0.06 });
  put('boxB', bx(X0 + 1.05, X0 + 2.0, cz0 + 0.02, cz0 + 0.72, y + e, y + 0.03), ['bottom'], { rot: -0.09 });
  put('box', bx(X0 + 0.05, X0 + 0.5, cz0 + 0.12, cz0 + 0.62, y + 0.025, y + 0.09), ['bottom'], { rot: 0.12 });
  put('paper', bx(X0 + 1.3, X0 + 1.51, cz0 + 0.35, cz0 + 0.65, y + 0.03, y + 0.034), ['bottom'], { rot: 0.4 });
  put('cover', bx(X0 + 1.55, X0 + 1.73, cz0 + 0.15, cz0 + 0.4, y + 0.03, y + 0.038), ['bottom'], { rot: -0.2 });
  put('bottle', bx(X0 + 1.85, X0 + 1.92, cz0 + 0.6, cz0 + 0.67, y + 0.03, y + 0.26), ['bottom']);
  put('bottle', bx(X0 + 1.87, X0 + 1.9, cz0 + 0.62, cz0 + 0.65, y + 0.26, y + 0.31), ['bottom']);
  return out;
}

/** A school chair turned `rot` in plan: seat at DESK seat height, four legs, a backrest on its −z side. */
function chair(put: Put, solid: LBox[], x: number, z: number, y: number, rot: number): void {
  const s = 0.19, seat = y + 0.45;
  put('wood', bx(x - s, x + s, z - s, z + s, seat - 0.02, seat), [], { rot });
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const c = Math.cos(rot), sn = Math.sin(rot), ox = sx * (s - 0.03), oz = sz * (s - 0.03);
    const lx = x + ox * c - oz * sn, lz = z + ox * sn + oz * c;
    put('steel', bx(lx - 0.012, lx + 0.012, lz - 0.012, lz + 0.012, y, seat - 0.02), ['bottom', 'top']);
  }
  // the back on the chair's −z side (turned with it)
  const c = Math.cos(rot), sn = Math.sin(rot), bz = -(s - 0.01), bxc = x - bz * sn, bzc = z + bz * c;
  put('wood', bx(bxc - s, bxc + s, bzc - 0.012, bzc + 0.012, seat + 0.12, seat + 0.4), [], { rot });
  put('steel', bx(bxc - 0.012, bxc + 0.012, bzc - 0.012, bzc + 0.012, seat, seat + 0.12), ['bottom', 'top'], { rot });
  solid.push(bx(x - 0.25, x + 0.25, z - 0.25, z + 0.25, y, seat + 0.4));
}
