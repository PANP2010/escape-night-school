import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { AABB } from '../../../../shared/campus/collision.ts';
import type { CampusProps, Side } from '../../../../shared/campus/campus_schema.ts';
import type { Roof } from './shelter.ts';

/**
 * 自行车棚 (data/campus/campus.json `props.sheds` = [centre x, z, length, open side]): a lean-to of square steel posts
 * under a faded blue 彩钢瓦 sheet (high over the open front, low at the back), a concrete slab, a ground rack along the
 * back the front wheels go into (the sheet off-white underneath), and a row of low-poly bikes (二八大杠 and the like, some with a basket), leaning a
 * little on their stands. Built in the shed's own frame (x = along it, y, z = towards the open side), turned into the
 * world by its facing. The sheet is its roof for world/shelter.ts (rain thins, no flakes underneath); the sheet goes
 * in the snow-lying mesh, everything under it in one that never gathers snow (`roof` / `under`).
 */
export const SHED = {
  /** depth (back posts to front posts), most post spacing, post section, roof top over the front / back posts */ d: 4.2, bay: 3.6, post: 0.08, hi: 2.75, lo: 2.3,
  /** sheet overhang past the posts, its thickness, rib pitch and height (彩钢瓦) */ over: 0.35, sheet: 0.04, rib: 0.25, ribH: 0.03,
  /** bike slot pitch, front hub this far in from the back posts, share of slots taken, wheelbase, wheel radius */ slot: 0.62, rack: 0.5, fill: 0.72, base: 1.05, wheel: 0.33,
  /** slab height; the bike band collider height */ slab: 0.05, band: 1.1,
};

export type ShedKind = 'sheet' | 'soffit' | 'rib' | 'fascia' | 'post' | 'beam' | 'slab' | 'rack' | 'tire' | 'seat' | 'basket' | 'chrome' | `frame${number}`;
/** A box from `a` to `b` (its long axis), `s` = its section (across, up); or, `wheel` set, a tire round `a` of that radius. */
export interface ShedPart { kind: ShedKind; a: [number, number, number]; b: [number, number, number]; s: [number, number]; wheel?: number; roof?: boolean }

const FRAMES = ['#2c2b2a', '#3d4f63', '#6b3a35', '#4a5a4a', '#8a8a86', '#2c2b2a'];
const COLOR: Record<string, string> = {
  sheet: '#61788a', soffit: '#e4e0d4', rib: '#6f8796', fascia: '#c9c3b2', post: '#7b8078', beam: '#71766e', slab: '#bab4a6', rack: '#6a6e6a',
  tire: '#262624', seat: '#3a2f28', basket: '#9a9a92', chrome: '#a7a7a1', ...Object.fromEntries(FRAMES.map((c, i) => [`frame${i}`, c])),
};

const ANGLE: Record<Side, number> = { '+z': 0, '+x': Math.PI / 2, '-z': Math.PI, '-x': -Math.PI / 2 };
const hash = (x: number) => { const q = Math.sin(x * 12.9898) * 43758.5453; return q - Math.floor(q); };

/** One bike standing in slot `u`, front hub at z = `zf`, nose towards −z; `j` in 0..1 picks its colour, basket, lean. */
function bike(out: ShedPart[], u: number, zf: number, j: number) {
  const S = SHED, R = S.wheel, f = `frame${Math.floor(j * FRAMES.length) % FRAMES.length}` as ShedKind;
  // bike-local (a = along it from the rear hub towards the nose, y) to the shed frame, tilted `lean` on its stand
  const lean = (j < 0.5 ? 1 : -1) * (0.05 + 0.04 * j);
  const p = (a: number, y: number, side = 0): [number, number, number] => [u + side * Math.cos(lean) + y * Math.sin(lean), y * Math.cos(lean) - side * Math.sin(lean), zf + S.base - a];
  const tube = (kind: ShedKind, a0: number, y0: number, a1: number, y1: number, t = 0.035) => out.push({ kind, a: p(a0, y0), b: p(a1, y1), s: [t, t] });
  const rear: [number, number] = [0, R], front: [number, number] = [S.base, R], bb: [number, number] = [0.47, 0.3];
  const seat: [number, number] = [0.3, 0.86], headT: [number, number] = [0.86, 0.92], headB: [number, number] = [0.9, 0.74];
  for (const c of [rear, front]) out.push({ kind: 'tire', a: p(c[0], c[1]), b: p(c[0], c[1]), s: [0.035, 0.035], wheel: R - 0.02 });
  tube(f, ...bb, ...seat); tube(f, ...seat, ...headT); tube(f, ...bb, ...headB); tube(f, ...headB, ...headT, 0.045);
  tube(f, ...rear, ...bb, 0.03); tube(f, ...rear, ...seat, 0.03); tube(f, ...headB, ...front, 0.03);
  // 车座 on its post, the 车把 across the stem, a 后座 carrier over the rear wheel, the chain guard
  tube('chrome', ...seat, 0.27, 0.93, 0.025);
  out.push({ kind: 'seat', a: p(0.17, 0.95), b: p(0.36, 0.95), s: [0.14, 0.05] });
  tube('chrome', ...headT, 0.82, 1.04, 0.025);
  out.push({ kind: 'chrome', a: p(0.8, 1.04, -0.28), b: p(0.8, 1.04, 0.28), s: [0.025, 0.025] });
  out.push({ kind: 'rack', a: p(-0.12, R + 0.36), b: p(0.28, R + 0.36), s: [0.14, 0.02] });
  tube('rack', -0.1, R + 0.35, 0, R, 0.02);
  out.push({ kind: f, a: p(0.02, 0.38), b: p(0.5, 0.34), s: [0.02, 0.1] });
  if (j > 0.55) out.push({ kind: 'basket', a: p(1.0, 0.82), b: p(1.28, 0.82), s: [0.32, 0.2] });
}

/** Every part of one shed, in its own frame (x along it, z towards the open side). */
export function shedLocalParts(len: number, seed = 0): ShedPart[] {
  const S = SHED, out: ShedPart[] = [], hz = S.d / 2, hx = len / 2;
  const top = (z: number) => S.lo + (S.hi - S.lo) * (z + hz) / S.d;
  const beam = (kind: ShedKind, a: [number, number, number], b: [number, number, number], s: [number, number], roof = false) => out.push({ kind, a, b, s, roof });
  // posts front and back, every bay; the beams along their tops, a rafter over each pair
  const n = Math.max(1, Math.ceil(len / S.bay));
  for (let i = 0; i <= n; i++) {
    const x = -hx + (i * len) / n;
    for (const z of [-hz, hz]) beam('post', [x, 0, z], [x, top(z) - S.sheet - 0.1, z], [S.post, S.post]);
    beam('beam', [x, top(-hz - S.over) - S.sheet - 0.05, -hz - S.over], [x, top(hz + S.over) - S.sheet - 0.05, hz + S.over], [0.06, 0.1]);
  }
  for (const z of [-hz, hz]) beam('beam', [-hx, top(z) - S.sheet - 0.1, z], [hx, top(z) - S.sheet - 0.1, z], [0.1, 0.1]);
  // the 彩钢瓦 sheet down the slope, ribs on it, a white fascia board along the high front edge
  const z0 = -hz - S.over, z1 = hz + S.over, ux = hx + S.over;
  beam('sheet', [0, top(z0) - S.sheet / 2, z0], [0, top(z1) - S.sheet / 2, z1], [2 * ux, S.sheet], true);
  // 彩钢瓦 is off-white underneath: a thin skin just under the sheet (in the snowless mesh), so the underside is not a black lid
  beam('soffit', [0, top(z0) - S.sheet - 0.004, z0], [0, top(z1) - S.sheet - 0.004, z1], [2 * ux - 0.02, 0.006]);
  for (let x = -ux + S.rib / 2; x < ux; x += S.rib) beam('rib', [x, top(z0) + S.ribH / 2 - 0.005, z0], [x, top(z1) + S.ribH / 2 - 0.005, z1], [0.07, S.ribH], true);
  beam('fascia', [-ux, top(z1) - 0.08, z1 + 0.02], [ux, top(z1) - 0.08, z1 + 0.02], [0.03, 0.2], true);
  // the slab, the rack (a low rail with an upright either side of each slot), the bikes
  out.push({ kind: 'slab', a: [0, S.slab / 2, -hz - 0.25], b: [0, S.slab / 2, hz + 0.25], s: [len + 0.5, S.slab] });
  const zf = -hz + S.rack, slots = Math.floor((len - 0.4) / S.slot);
  for (const y of [0.12, 0.38]) beam('rack', [-hx + 0.1, y, zf - 0.12], [hx - 0.1, y, zf - 0.12], [0.03, 0.03]);
  for (let i = 0; i < slots; i++) {
    const u = -((slots - 1) * S.slot) / 2 + i * S.slot;
    for (const s of [-1, 1]) beam('rack', [u + s * 0.05, S.slab, zf - 0.12], [u + s * 0.05, 0.42, zf - 0.12], [0.02, 0.02]);
    const j = hash(seed + i * 7.31);
    if (hash(seed * 3.7 + i * 1.93) < S.fill) bike(out, u + (j - 0.5) * 0.06, zf, j);
  }
  return out;
}

/** The shed's frame into the world: centre (x, z), open side `facing`. */
function frame(x: number, z: number, facing: Side): THREE.Matrix4 {
  return new THREE.Matrix4().makeRotationY(ANGLE[facing]).setPosition(x, 0, z);
}

/** Every shed on the campus: parts in world space (`a`, `b`), for tests. */
export function shedParts(p: CampusProps | undefined): ShedPart[] {
  return (p?.sheds ?? []).flatMap(([x, z, len, f]) => {
    const m = frame(x, z, f), v = new THREE.Vector3();
    const w = (q: [number, number, number]) => v.set(...q).applyMatrix4(m).toArray() as [number, number, number];
    return shedLocalParts(len, x + z).map(q => ({ ...q, a: w(q.a), b: w(q.b) }));
  });
}

/** World AABB of a local rect (x0..x1, z0..z1) of a shed, from y0 to y1. */
function worldBox(m: THREE.Matrix4, x0: number, x1: number, z0: number, z1: number, y0: number, y1: number): AABB {
  const b = new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1)).applyMatrix4(m);
  return { minX: b.min.x, maxX: b.max.x, minY: b.min.y, maxY: b.max.y, minZ: b.min.z, maxZ: b.max.z };
}

/** Colliders: each post, the slab (a step up), one box over the rack and the bikes in it (no walking between them). */
export function shedColliders(p: CampusProps | undefined): AABB[] {
  const S = SHED;
  return (p?.sheds ?? []).flatMap(([x, z, len, f]) => {
    const m = frame(x, z, f), hz = S.d / 2, hx = len / 2, n = Math.max(1, Math.ceil(len / S.bay)), h = S.post / 2;
    const posts = Array.from({ length: n + 1 }, (_, i) => -hx + (i * len) / n).flatMap(px =>
      [-hz, hz].map(pz => worldBox(m, px - h, px + h, pz - h, pz + h, 0, S.lo + (S.hi - S.lo) * (pz + hz) / S.d)));
    const zf = -hz + S.rack;
    return [worldBox(m, -hx - 0.25, hx + 0.25, -hz - 0.25, hz + 0.25, 0, S.slab), worldBox(m, -hx, hx, zf - 0.75, zf + S.base + 0.45, 0, S.band), ...posts];
  });
}

/** Each shed's sheet as a Roof (world/shelter.ts shelterAt / dryBoxes, world/drips.ts): open all round, `y` its high edge. */
export function shedRoofs(p: CampusProps | undefined): Roof[] {
  const S = SHED;
  return (p?.sheds ?? []).map(([x, z, len, f]) => {
    const b = worldBox(frame(x, z, f), -len / 2 - S.over, len / 2 + S.over, -S.d / 2 - S.over, S.d / 2 + S.over, 0, 1);
    return { x0: b.minX, x1: b.maxX, z0: b.minZ, z1: b.maxZ, y: S.hi + S.ribH, t: S.hi - S.lo + 0.12, closed: [] };
  });
}

function partGeometry(q: ShedPart): THREE.BufferGeometry {
  const a = new THREE.Vector3(...q.a), b = new THREE.Vector3(...q.b);
  if (q.wheel) {
    // a tire (in the shed's frame): its axis across the bike, along x
    const g = new THREE.TorusGeometry(q.wheel, q.s[0], 4, 14);
    g.rotateY(Math.PI / 2);
    g.translate(a.x, a.y, a.z);
    return g;
  }
  const d = b.clone().sub(a), len = d.length();
  const g = new THREE.BoxGeometry(q.s[0], q.s[1], Math.max(len, 1e-3));
  if (len > 1e-6) g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), d.normalize()));
  g.translate((q.a[0] + q.b[0]) / 2, (q.a[1] + q.b[1]) / 2, (q.a[2] + q.b[2]) / 2);
  return g;
}

/** All sheds as two merged vertex-coloured geometries: the roof (gathers lying snow) and what is under it (never). */
export function shedGeometry(p: CampusProps | undefined): { roof: THREE.BufferGeometry; under: THREE.BufferGeometry } | null {
  const sheds = p?.sheds ?? [];
  if (!sheds.length) return null;
  // built in each shed's own frame (a tire's axis is its x), then moved into the world
  const geos = sheds.flatMap(([x, z, len, f]) => {
    const m = frame(x, z, f);
    return shedLocalParts(len, x + z).map(q => {
      const g = partGeometry(q).toNonIndexed().applyMatrix4(m), c = new THREE.Color(COLOR[q.kind]), n = g.getAttribute('position').count, col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.deleteAttribute('uv');
      return { g, roof: !!q.roof };
    });
  });
  return { roof: mergeGeometries(geos.filter(q => q.roof).map(q => q.g))!, under: mergeGeometries(geos.filter(q => !q.roof).map(q => q.g))! };
}
