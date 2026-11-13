import * as THREE from 'three';
import type { AABB } from '../../../../shared/campus/collision.ts';
import { bridgeDoor, bridgeSpan, type BridgeDef, type BridgeSpan, type CampusDef } from '../../../../shared/campus/campus_schema.ts';
import { Soup } from './building.ts';
import { SURF } from '../render/facade.ts';
import type { Roof } from './shelter.ts';

/**
 * 连廊 (docs/03_campus.md): an open walkway between two buildings' facing walls at one storey (CampusDef.bridges).
 * A deck slab level with the storey floor, a solid 栏板 along both edges with a 压顶 on top, and square columns under
 * its edges every ≤ BRIDGE.bay m, standing on the ground or on the roof of the 连廊 below on the same line. Over it a
 * flat roof slab on slim posts (one on each 栏板 at every column station), wider than the deck so rain and snow stay
 * off it, open along both long sides (world/shelter.ts bridgeRoofs: 半室内). The doorways at its ends are the
 * buildings' own 连廊门 (entrances of that level). Boxes are the colliders; the render is the same boxes with only the
 * faces that can show (world/campus.ts: the building material, except the faces under the roof: no lying snow).
 */
export const BRIDGE = {
  /** deck slab depth under the floor line; 栏板 height above the deck, its thickness; 压顶 overhang + depth */
  deck: 0.35, rail: 1.1, railT: 0.12, cap: 0.04, capH: 0.08,
  /** column side, the most column spacing; columns stand this far in from the walls */ col: 0.4, bay: 8, inset: 0.6,
  /** roof underside above the deck (over the 2.6 m 连廊门), slab thickness, overhang past the deck each long side; post side */
  roofGap: 2.9, roofT: 0.18, eave: 0.35, post: 0.14,
  /** 顶棚梁 across the roof's underside at each post station: width along the run, depth below the slab (clears the 2.6 m door) */ beamW: 0.2, beamD: 0.22,
};
/** Top of a 连廊's roof slab above its deck. */
const roofTopY = (s: BridgeSpan) => s.y + BRIDGE.roofGap + BRIDGE.roofT;
/** UNDER: the deck's underside × the wall; SOFFIT: the roof's (whitewashed) underside × the wall, BEAM: its 梁 × that */
const FLOOR = '#b8b2a3', UNDER = 0.72, SOFFIT = 1, BEAM = 0.9, RAIL_SHADE = 0.95, COL_SHADE = 0.88, ROOF_SHADE = 0.78;

/** Building-free box in world space. */
export interface BridgeBox { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number; part: 'deck' | 'rail' | 'cap' | 'col' | 'post' | 'roof' | 'beam' }

/** Every box of one 连廊 (world space); `below` = roof tops of 连廊 under it on the same line (its columns stand there). */
export function bridgeBoxes(s: BridgeSpan, below: number[] = []): BridgeBox[] {
  const B = BRIDGE, hw = s.width / 2, out: BridgeBox[] = [];
  // along / across → world: run 'x' = u is x, v is z
  const put = (u0: number, u1: number, v0: number, v1: number, y0: number, y1: number, part: BridgeBox['part']) =>
    out.push(s.run === 'x' ? { x0: u0, x1: u1, z0: s.at + v0, z1: s.at + v1, y0, y1, part } : { x0: s.at + v0, x1: s.at + v1, z0: u0, z1: u1, y0, y1, part });
  put(s.u0, s.u1, -hw, hw, s.y - B.deck, s.y, 'deck');
  for (const k of [-1, 1]) {
    const v0 = k < 0 ? -hw : hw - B.railT, v1 = v0 + B.railT;
    put(s.u0, s.u1, v0, v1, s.y, s.y + B.rail, 'rail');
    put(s.u0, s.u1, v0 - B.cap, v1 + B.cap, s.y + B.rail, s.y + B.rail + B.capH, 'cap');
  }
  const roofY = s.y + B.roofGap, re = hw + B.eave;
  put(s.u0, s.u1, -re, re, roofY, roofY + B.roofT, 'roof');
  const foot = Math.max(0, ...below.filter(y => y < s.y - B.deck));
  const len = s.u1 - s.u0 - 2 * B.inset, n = Math.max(1, Math.ceil(len / B.bay));
  for (let i = 0; i <= n; i++) {
    const u = s.u0 + B.inset + (len * i) / n;
    for (const k of [-1, 1]) {
      const v = k * (hw - B.col / 2), w = k * (hw - B.railT / 2);
      put(u - B.col / 2, u + B.col / 2, v - B.col / 2, v + B.col / 2, foot, s.y - B.deck, 'col');
      put(u - B.post / 2, u + B.post / 2, w - B.post / 2, w + B.post / 2, s.y + B.rail + B.capH, roofY, 'post');
    }
    put(u - B.beamW / 2, u + B.beamW / 2, -hw, hw, roofY - B.beamD, roofY, 'beam');
  }
  return out;
}

/**
 * 连廊门 (todo 打磨批次②③b): each end's doorway (the building's entrance at that level) gets a steel 门框 (two jambs and
 * a head, `face` wide on the deck side, standing `proud` off the wall and lining the reveal `reveal` deep) and a pair
 * of 铁框玻璃门 leaves hinged at the jambs, standing open square onto the deck (as they stand all day) and held there by
 * a 门钩 rod to the 栏板's inner face. Leaf: two stiles and a top rail of `stile`, a mid rail, a steel kick plate,
 * glass above and below the mid rail (the facade's door glass), a 拉手 bar on both faces near the free edge. The
 * walker (radius 0.3) passes between the two open leaves (1.9 m clear); each leaf is solid.
 */
export const BRIDGE_DOOR = {
  /** 门框: face width, how far it stands off the wall, how deep it lines the reveal; its paint */ face: 0.05, proud: 0.03, reveal: 0.06, color: '#56605a',
  /** leaf: slab thickness, stile / top rail width, kick plate height, mid rail [y0, y1], gap under the head */
  t: 0.04, stile: 0.07, kick: 0.35, mid: [0.98, 1.06] as const, gap: 0.01,
  /** 门钩 height above the deck (under the 栏板's top), its side, how far in from the free edge */ hookY: 0.9, hook: 0.016, hookIn: 0.1,
};
const DOOR_GLASS = '#4a5559';
/** Half the width of the 连廊门 at the run's first end. */
const hwOf = (s: BridgeSpan, level: number) => (bridgeDoor(s.ends[0].b, s.ends[0].side, level, s.at)?.width ?? 0) / 2;

/** A box of a 连廊门 (world space); 'leaf' = a whole leaf's collider (not drawn; its parts are). */
export interface BridgeDoorBox { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number; part: 'frame' | 'stile' | 'kick' | 'glass' | 'pull' | 'hook' | 'leaf' }

/** Both 连廊门 of one 连廊 at `level`, opened onto its deck. */
export function bridgeDoorBoxes(s: BridgeSpan, level: number): BridgeDoorBox[] {
  const D = BRIDGE_DOOR, out: BridgeDoorBox[] = [];
  const put = (u0: number, u1: number, v0: number, v1: number, y0: number, y1: number, part: BridgeDoorBox['part']) => {
    const [a0, a1] = u0 < u1 ? [u0, u1] : [u1, u0], [b0, b1] = v0 < v1 ? [v0, v1] : [v1, v0];
    out.push(s.run === 'x' ? { x0: a0, x1: a1, z0: s.at + b0, z1: s.at + b1, y0, y1, part } : { x0: s.at + b0, x1: s.at + b1, z0: a0, z1: a1, y0, y1, part });
  };
  s.ends.forEach(({ b, side }, i) => {
    const e = bridgeDoor(b, side, level, s.at);
    if (!e) return;
    // the wall face this end, and the way onto the deck from it
    const uw = i === 0 ? s.u0 : s.u1, k = i === 0 ? 1 : -1, hw = e.width / 2, H = e.height, y = s.y;
    const f0 = uw - k * D.reveal, f1 = uw + k * D.proud, inner = hw - D.face, head = H - D.face;
    for (const j of [-1, 1]) put(f0, f1, j * hw, j * inner, y, y + head, 'frame');
    put(f0, f1, -hw, hw, y + head, y + H, 'frame');
    // the leaves: hinged at the jamb's inner edge on its deck-side face, open square (along the run), slab outside the
    // clear width; leaf-local a = along from the hinge, h = up from the deck
    const w = inner, h = head - D.gap, St = D.stile;
    for (const j of [-1, 1]) {
      const v0 = j * inner, v1 = j * (inner + D.t), a = (a0: number, a1: number) => [f1 + k * a0, f1 + k * a1] as const;
      const leaf = (a0: number, a1: number, h0: number, h1: number, part: BridgeDoorBox['part'], vv: [number, number] = [v0, v1]) =>
        put(...a(a0, a1), vv[0], vv[1], y + h0, y + h1, part);
      leaf(0, St, 0, h, 'stile'); leaf(w - St, w, 0, h, 'stile');
      leaf(St, w - St, h - St, h, 'stile'); leaf(St, w - St, D.mid[0], D.mid[1], 'stile'); leaf(St, w - St, 0, D.kick, 'kick');
      const g = j * (inner + D.t / 2), gt = 0.004;
      leaf(St, w - St, D.kick, D.mid[0], 'glass', [g - gt, g + gt]); leaf(St, w - St, D.mid[1], h - St, 'glass', [g - gt, g + gt]);
      // 拉手: a bar standing off each face near the free edge
      leaf(w - 0.16, w - 0.13, 0.8, 1.24, 'pull', [v0 - j * 0.05, v0]); leaf(w - 0.16, w - 0.13, 0.8, 1.24, 'pull', [v1, v1 + j * 0.05]);
      // 门钩: from the leaf's outer face to the 栏板's inner face
      const rail = s.width / 2 - BRIDGE.railT, c = w - D.hookIn;
      leaf(c - D.hook / 2, c + D.hook / 2, D.hookY - D.hook / 2, D.hookY + D.hook / 2, 'hook', [v1, j * rail]);
      put(...a(0, w), v0, v1, y, y + h, 'leaf'); // (the collider)
    }
  });
  return out;
}

/**
 * 连廊吸顶灯 (todo M3 审查① B·连廊夜里没灯): one milk-glass 吸顶灯 under the roof slab at the middle of every bay
 * (between two column stations, on the run's centre line), on the 走廊灯's switch (main.ts syncFacade, the light
 * itself render/facade.ts BRIDGE_LIGHT). 灯座 `base` square × `baseH`, 乳白半球 `r` × `h` in `sides`, like the
 * stairwells' 声控灯 (world/interior.ts LAMP) a size up.
 */
export const BRIDGE_LAMP = { base: 0.1, baseH: 0.025, r: 0.16, h: 0.08, sides: 8, base_c: '#d9d4c4', shade: '#e8e6dc' };
/**
 * Every 连廊's lamps (world points: the 灯罩's centre) and the box their light stays in: deck to roof underside (the
 * slabs stop it) and wall to wall, hard; across the run (world axis `v`: 0 = x, 2 = z, about `at`) it fades out from
 * the eave (`fade[0]`) to `fade[1]` (on the walls round the 连廊门, past the roof's edge, no cut-out rectangle).
 */
export const BRIDGE_LAMP_FADE = 2;
export interface BridgeLampSet { box: [number, number, number, number, number, number]; v: 0 | 2; at: number; fade: [number, number]; lamps: [number, number, number][] }
export function bridgeLamps(c: Pick<CampusDef, 'buildings' | 'bridges'>): BridgeLampSet[] {
  const B = BRIDGE, L = BRIDGE_LAMP;
  return spans(c).map(({ span: s }) => {
    const len = s.u1 - s.u0 - 2 * B.inset, n = Math.max(1, Math.ceil(len / B.bay)), y = s.y + B.roofGap - L.baseH - L.h / 2;
    const w = (u: number, v: number): [number, number] => (s.run === 'x' ? [u, s.at + v] : [s.at + v, u]);
    const lamps = Array.from({ length: n }, (_, i): [number, number, number] => {
      const [x, z] = w(s.u0 + B.inset + (len * (i + 0.5)) / n, 0);
      return [x, y, z];
    });
    const re = s.width / 2 + B.eave + 0.02, fe = re + BRIDGE_LAMP_FADE, [ax, az] = w(s.u0 - 0.1, -fe), [bx, bz] = w(s.u1 + 0.1, fe);
    return { box: [Math.min(ax, bx), s.y - 0.05, Math.min(az, bz), Math.max(ax, bx), s.y + B.roofGap + 0.05, Math.max(az, bz)], v: s.run === 'x' ? 2 : 0, at: s.at, fade: [re, fe], lamps };
  });
}

/** Spans of every 连廊 with the roof tops below each one on the same line. */
function spans(c: Pick<CampusDef, 'buildings' | 'bridges'>): { def: BridgeDef; span: BridgeSpan; below: number[]; above: boolean }[] {
  const all = (c.bridges ?? []).map(def => ({ def, span: bridgeSpan(c, def)! })).filter(q => q.span);
  const line = (q: typeof all[number]) => all.filter(o => o !== q && o.span.run === q.span.run && Math.abs(o.span.at - q.span.at) < 1e-6 && o.span.u0 === q.span.u0);
  return all.map(q => ({ ...q, below: line(q).filter(o => o.span.y < q.span.y).map(o => roofTopY(o.span)), above: line(q).some(o => o.span.y > q.span.y) }));
}

/**
 * Plan rect of every 连廊 roof (world/shelter.ts 半室内, drips, dry snow boxes): its run's ends meet the walls (closed).
 * `sheltered` = another 连廊 right above it on the same line (its roof stays dry: no drips, no lying snow).
 */
export function bridgeRoofs(c: Pick<CampusDef, 'buildings' | 'bridges'>): Roof[] {
  return spans(c).map(({ span: s, above }) => {
    const re = s.width / 2 + BRIDGE.eave, y = roofTopY(s), t = BRIDGE.roofT;
    const r: Roof = s.run === 'x' ? { x0: s.u0, x1: s.u1, z0: s.at - re, z1: s.at + re, y, t, closed: ['-x', '+x'] }
      : { x0: s.at - re, x1: s.at + re, z0: s.u0, z1: s.u1, y, t, closed: ['-z', '+z'] };
    return above ? { ...r, sheltered: true } : r;
  });
}

/** Colliders of every 连廊. */
export function bridgeColliders(c: Pick<CampusDef, 'buildings' | 'bridges'>): AABB[] {
  return spans(c).flatMap(q => [...bridgeBoxes(q.span, q.below), ...bridgeDoorBoxes(q.span, q.def.level).filter(p => p.part === 'leaf')]).map(p => ({ minX: p.x0, maxX: p.x1, minY: p.y0, maxY: p.y1, minZ: p.z0, maxZ: p.z1 }));
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const N = { px: V(1, 0, 0), nx: V(-1, 0, 0), pz: V(0, 0, 1), nz: V(0, 0, -1), up: V(0, 1, 0), dn: V(0, -1, 0) };

/**
 * Render geometry of every 连廊 (world space, two soups): `open` = what the weather reaches (the roof's top and edges,
 * the deck's underside and edges, the columns), `covered` = what is under the roof (the deck's top, both faces of each
 * 栏板, the 压顶, the posts, the roof's underside; the roof's top too under another 连廊), drawn without lying snow. Faces buried in the building walls (the
 * run's ends of deck / 栏板 / 压顶 / roof) and the column / post tops and feet are not drawn. Colour from the first
 * building's walls and trims.
 */
export function bridgeGeometry(c: Pick<CampusDef, 'buildings' | 'bridges'>): { open: THREE.BufferGeometry; covered: THREE.BufferGeometry } {
  const open = new Soup(), covered = new Soup();
  const steel = new THREE.Color(BRIDGE_DOOR.color), glass = new THREE.Color(DOOR_GLASS);
  for (const { def, span, below, above } of spans(c)) {
    // the 连廊门 (all under the roof): steel boxes without their feet, the glass only its two faces
    for (const p of bridgeDoorBoxes(span, def.level)) {
      if (p.part === 'leaf') continue;
      const { x0, x1, y0, y1, z0, z1 } = p, thin = p.part === 'glass';
      const col = steel.clone().multiplyScalar({ frame: 0.95, stile: 1, kick: 0.85, pull: 1.25, hook: 1.1, glass: 1 }[p.part]);
      const faces: [THREE.Vector3, THREE.Vector3[]][] = [
        [N.px, [V(x1, y0, z0), V(x1, y0, z1), V(x1, y1, z1), V(x1, y1, z0)]], [N.nx, [V(x0, y0, z0), V(x0, y0, z1), V(x0, y1, z1), V(x0, y1, z0)]],
        [N.pz, [V(x0, y0, z1), V(x1, y0, z1), V(x1, y1, z1), V(x0, y1, z1)]], [N.nz, [V(x0, y0, z0), V(x1, y0, z0), V(x1, y1, z0), V(x0, y1, z0)]],
        [N.up, [V(x0, y1, z0), V(x1, y1, z0), V(x1, y1, z1), V(x0, y1, z1)]],
      ];
      const vAt = (q: THREE.Vector3[]) => Math.abs((span.run === 'x' ? q[0].z : q[0].x) - span.at);
      for (const [n, q] of faces) {
        // the 门框's faces on the reveal's planes (its outer edges, the head's top: a 3 cm sliver past the wall) z-fight it
        if (p.part === 'frame' && (n.y > 0 || ((span.run === 'x' ? n.z : n.x) !== 0 && vAt(q) > hwOf(span, def.level) - 1e-4))) continue;
        // glass: only the faces across its thin side (the leaf's two faces), the facade's door glass (sky reflection)
        if (thin) { if ((x1 - x0 < z1 - z0 ? n.x : n.z) !== 0) covered.quad(q[0], q[1], q[2], q[3], n, glass, SURF.door, 0.37); continue; }
        covered.quad(q[0], q[1], q[2], q[3], n, col);
      }
    }
    const b = span.ends[0].b, wall = new THREE.Color(b.color), trim = new THREE.Color(b.trim ?? b.color);
    const floor = new THREE.Color(FLOOR), under = wall.clone().multiplyScalar(UNDER), k = (c: THREE.Color, f: number) => c.clone().multiplyScalar(f);
    const X = span.run === 'x';
    for (const p of bridgeBoxes(span, below)) {
      const { x0, x1, y0, y1, z0, z1 } = p;
      const sides: [THREE.Vector3, THREE.Vector3[]][] = [
        [N.px, [V(x1, y0, z0), V(x1, y0, z1), V(x1, y1, z1), V(x1, y1, z0)]], [N.nx, [V(x0, y0, z0), V(x0, y0, z1), V(x0, y1, z1), V(x0, y1, z0)]],
        [N.pz, [V(x0, y0, z1), V(x1, y0, z1), V(x1, y1, z1), V(x0, y1, z1)]], [N.nz, [V(x0, y0, z0), V(x1, y0, z0), V(x1, y1, z0), V(x0, y1, z0)]],
      ];
      const col = { deck: k(wall, 0.9), rail: k(wall, RAIL_SHADE), cap: k(trim, 0.9), col: k(wall, COL_SHADE), post: k(trim, 0.8), roof: k(trim, 0.85), beam: k(wall, SOFFIT * BEAM) }[p.part];
      const stick = p.part === 'col' || p.part === 'post', beam = p.part === 'beam';
      // the sides: under the roof for the 栏板, 压顶 and posts (the 栏板's outer face too: the eave overhangs it)
      const side = p.part === 'rail' || p.part === 'cap' || p.part === 'post' || beam ? covered : open;
      for (const [n, q] of sides) {
        if (!stick && !beam && (X ? n.x !== 0 : n.z !== 0)) continue; // ends in the walls
        side.quad(q[0], q[1], q[2], q[3], n, col);
      }
      if (beam) { covered.quad(V(x0, y0, z0), V(x1, y0, z0), V(x1, y0, z1), V(x0, y0, z1), N.dn, col); continue; } // (its top in the slab)
      if (stick || p.part === 'rail') continue; // (a 栏板's top is under its 压顶, its foot on the deck)
      const top = p.part === 'deck' ? floor : p.part === 'roof' ? k(trim, ROOF_SHADE) : trim;
      const bottom = p.part === 'deck' ? under : p.part === 'roof' ? k(wall, SOFFIT) : k(trim, 0.75);
      (p.part === 'roof' && !above ? open : covered).quad(V(x0, y1, z0), V(x1, y1, z0), V(x1, y1, z1), V(x0, y1, z1), N.up, top);
      (p.part === 'roof' ? covered : open).quad(V(x0, y0, z0), V(x1, y0, z0), V(x1, y0, z1), V(x0, y0, z1), N.dn, bottom);
    }
  }
  // the 吸顶灯 (BRIDGE_LAMP): a 灯座 on the roof's underside (its foot inside the dome), the 乳白半球 under it (SURF.lamp: lit by the facade patch)
  const L = BRIDGE_LAMP, baseC = new THREE.Color(L.base_c), shade = new THREE.Color(L.shade);
  for (const set of bridgeLamps(c)) for (const [x, yc, z] of set.lamps) {
    const top = yc + L.h / 2 + L.baseH, y0 = top - L.baseH, B = L.base;
    for (const [n, q] of [[N.px, [V(x + B, y0, z - B), V(x + B, y0, z + B), V(x + B, top, z + B), V(x + B, top, z - B)]], [N.nx, [V(x - B, y0, z - B), V(x - B, y0, z + B), V(x - B, top, z + B), V(x - B, top, z - B)]],
      [N.pz, [V(x - B, y0, z + B), V(x + B, y0, z + B), V(x + B, top, z + B), V(x - B, top, z + B)]], [N.nz, [V(x - B, y0, z - B), V(x + B, y0, z - B), V(x + B, top, z - B), V(x - B, top, z - B)]]] as [THREE.Vector3, THREE.Vector3[]][])
      covered.quad(q[0], q[1], q[2], q[3], n, baseC.clone().multiplyScalar(0.9));
    // 半球: two rings of quads down to a flat octagon at the bottom
    const ring = (f: number) => { const a = Math.PI / 2 * f; return { r: L.r * Math.cos(a * 0.85), y: y0 - L.h * Math.sin(a) }; };
    const rings = [ring(0), ring(0.5), ring(1)], m = L.sides;
    const at = (i: number, q: { r: number; y: number }) => { const a = (i / m) * Math.PI * 2; return V(x + q.r * Math.cos(a), q.y, z + q.r * Math.sin(a)); };
    for (let r = 0; r + 1 < rings.length; r++) for (let i = 0; i < m; i++) {
      const a = (i + 0.5) / m * Math.PI * 2, tilt = (r + 0.5) / (rings.length - 1);
      covered.quad(at(i, rings[r]), at(i + 1, rings[r]), at(i + 1, rings[r + 1]), at(i, rings[r + 1]), V(Math.cos(a) * Math.cos(tilt), -Math.sin(tilt), Math.sin(a) * Math.cos(tilt)).normalize(), shade, SURF.lamp);
    }
    const bot = rings[rings.length - 1], cb = V(x, bot.y, z);
    for (let i = 0; i < m; i += 2) covered.quad(cb, at(i, bot), at(i + 1, bot), at(i + 2, bot), N.dn, shade, SURF.lamp);
  }
  return { open: open.geometry(), covered: covered.geometry() };
}
