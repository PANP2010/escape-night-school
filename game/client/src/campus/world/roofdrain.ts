import * as THREE from 'three';
import { bridgeSpan, buildingHeight, floorStack, PARAPET, type BuildingDef, type CampusDef, type Side } from '../../../../shared/campus/campus_schema.ts';
import { CORNICE, facadeFrames, facadeOpenings, frameAxes, hash01, PARAPET_T, ROOF_SHADE, Soup } from './building.ts';
import { BRIDGE } from './bridges.ts';
import { CANOPY } from './shelter.ts';
import { roofSeed, SURF } from '../render/facade.ts';

/**
 * 屋面排水 (docs/03 楼体): 外排水 through the parapet. On each long wall of a building, near both corners and every
 * ~`every` m between, a 过水孔 (an iron-framed slot at the foot of the parapet's inner face, a darker 找坡 patch of
 * screed in front of it where the water stands) drops into a 雨水斗 hung under the cornice outside, and a square
 * 落水管 runs down a pier between the windows to a shoe that spills onto a little concrete 水簸箕. Positions dodge
 * windows, entrances (and their 雨棚), 连廊, 出屋面 boxes on the roof and a chimney outside. Decoration only: no
 * colliders (the pipe stands proud of the wall less than the player's radius), one mesh for the campus (+1 draw call).
 */
export const DRAIN = {
  /** spacing along a long wall, first/last this far in from the corners, clearance to an opening, search ±m */
  every: 18, corner: 0.6, pad: 0.25, search: 2,
  /** pipe side, its back this far off the wall (clear of the 5 cm plinth/belts); hopper w × d × h */
  pipe: 0.11, off: 0.07, hopper: [0.34, 0.26, 0.42] as [number, number, number],
  /** 过水孔 slot w × h, its iron frame's margin; the 找坡 patch: along the wall × out from it, shade */
  slot: [0.3, 0.14] as [number, number], frame: 0.05, stain: [1.6, 1.1] as [number, number], stainShade: 0.88, stainLift: 0.003,
  /** shoe: top height, reach out from the pipe; 水簸箕 w × reach × h */
  shoe: [0.18, 0.3] as [number, number], splash: [0.36, 0.55, 0.04] as [number, number, number],
  colors: { pipe: '#878a83', iron: '#5b5850', slot: '#24231f', splash: '#a39e92' },
};

export interface RoofDrain { b: BuildingDef; side: Side; u: number }

type Rect = { x0: number; x1: number; z0: number; z1: number };
const grow = (r: Rect, e: number): Rect => ({ x0: r.x0 - e, x1: r.x1 + e, z0: r.z0 - e, z1: r.z1 + e });
const overlap = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.z0 < b.z1 && b.z0 < a.z1;
const centred = (x: number, z: number, w: number, d: number): Rect => ({ x0: x - w / 2, x1: x + w / 2, z0: z - d / 2, z1: z + d / 2 });

/** Building-local plan rect spanning along-wall [u0, u1] and outward offsets [o0, o1] from the wall plane of `side`. */
function sideRect(b: BuildingDef, side: Side, u0: number, u1: number, o0: number, o1: number): Rect {
  const s = side[0] === '+' ? 1 : -1, half = (side[1] === 'x' ? b.w : b.d) / 2;
  const [a, c] = [s * (half + o0), s * (half + o1)].sort((p, q) => p - q);
  return side[1] === 'x' ? { x0: a, x1: c, z0: u0, z1: u1 } : { x0: u0, x1: u1, z0: a, z1: c };
}

/** Where a building's drains go (pure, for tests): long outer walls only, none on a building without a parapet. */
export function roofDrains(b: BuildingDef, campus: Pick<CampusDef, 'buildings' | 'bridges'>): RoofDrain[] {
  const P = b.parapet ?? PARAPET;
  if (P <= 0) return [];
  const D = DRAIN, open = facadeOpenings(b).filter(o => !o.court);
  const top = Math.max(...b.floors.map(f => f.level));
  // on the roof: 出屋面 bulkheads, the 水箱间; outside the wall: a chimney, a 煤仓
  const onRoof: Rect[] = (b.stairwells ?? []).filter(s => s.to === top).map(s => grow(centred(s.x, s.z, s.w, s.d), 0.1));
  if (b.tankRoom) onRoof.push(grow(centred(b.tankRoom.x, b.tankRoom.z, b.tankRoom.w, b.tankRoom.d), 0.1));
  const outside: Rect[] = [b.chimney, b.coalStore].flatMap(o => (o ? [grow(centred(o.x, o.z, o.w, o.d), 0.2)] : []));
  const spans = (campus.bridges ?? []).map(br => bridgeSpan(campus, br)).filter(s => s !== undefined);
  const out: RoofDrain[] = [];
  for (const side of ['+x', '-x', '+z', '-z'] as Side[]) {
    const len = side[1] === 'x' ? b.d : b.w, other = side[1] === 'x' ? b.w : b.d;
    if (len < other) continue;
    const blocked: [number, number][] = open.filter(o => o.side === side).map(o => {
      const e = D.pad + (o.kind === 'entrance' && o.y0 === 0 ? (o.canopy ?? CANOPY).side : 0);
      return [o.u0 - e, o.u1 + e];
    });
    for (const s of spans) for (const e of s.ends) if (e.b === b && e.side === side) {
      const c = s.at - (side[1] === 'x' ? b.z : b.x), h = s.width / 2 + BRIDGE.eave + D.pad;
      blocked.push([c - h, c + h]);
    }
    const lim = len / 2 - D.corner, w = D.pipe / 2;
    const free = (u: number) => Math.abs(u) <= lim + 1e-9
      && !blocked.some(([a, c]) => u + w > a && u - w < c)
      && !onRoof.some(r => overlap(r, sideRect(b, side, u - D.stain[0] / 2, u + D.stain[0] / 2, -PARAPET_T - D.stain[1], -PARAPET_T)))
      && !outside.some(r => overlap(r, sideRect(b, side, u - D.hopper[0] / 2, u + D.hopper[0] / 2, 0, D.off + D.shoe[1] + D.splash[1])));
    const n = len < 12 ? 1 : Math.max(2, Math.round(len / D.every) + 1);
    for (let i = 0; i < n; i++) {
      const want = n === 1 ? lim : -lim + (2 * lim * i) / (n - 1);
      for (let k = 0; k <= D.search * 10; k++) {
        const u = want + (k % 2 === 0 ? 1 : -1) * Math.ceil(k / 2) * 0.1;
        if (!free(u)) continue;
        if (!out.some(d => d.side === side && Math.abs(d.u - u) < 3)) out.push({ b, side, u: Math.round(u * 100) / 100 });
        break;
      }
    }
  }
  return out;
}

const UP = new THREE.Vector3(0, 1, 0), DOWN = new THREE.Vector3(0, -1, 0);


/** Every drain on the campus as one vertex-coloured soup (world space) under the building material. */
export function roofDrainGeometry(campus: Pick<CampusDef, 'buildings' | 'bridges'>): THREE.BufferGeometry {
  const soup = new Soup(), D = DRAIN;
  const col = (hex: string, k = 1) => new THREE.Color(hex).multiplyScalar(k);
  const pipeC = col(D.colors.pipe), pipeS = col(D.colors.pipe, 0.85), ironC = col(D.colors.iron), slotC = col(D.colors.slot), splashC = col(D.colors.splash);
  for (const b of campus.buildings) {
    const drains = roofDrains(b, campus);
    if (!drains.length) continue;
    const H = buildingHeight(b), top = H + (b.parapet ?? PARAPET);
    // the 找坡 patch is roof screed (same 分格缝, render/facade.ts ROOF), a shade darker where the water stands
    const stainC = col(b.color, ROOF_SHADE * D.stainShade), seed = roofSeed(b.x, b.z);
    const frames = facadeFrames(b);
    for (const d of drains) {
      const { n, t, at } = frameAxes(frames.find(f => !f.court && f.side === d.side)!);
      const neg = n.clone().negate(), tn = t.clone().negate();
      /** box over along-wall [u0, u1], height [y0, y1], out from the wall plane [o0, o1]; `skip` faces: b(ack) d(own) */
      const box = (u0: number, u1: number, y0: number, y1: number, o0: number, o1: number, c: THREE.Color, side: THREE.Color, skip = '', front = c) => {
        soup.quad(at(u0, y0, o1), at(u1, y0, o1), at(u1, y1, o1), at(u0, y1, o1), n, front);
        soup.quad(at(u1, y0, o0), at(u1, y0, o1), at(u1, y1, o1), at(u1, y1, o0), t, side);
        soup.quad(at(u0, y0, o0), at(u0, y0, o1), at(u0, y1, o1), at(u0, y1, o0), tn, side);
        soup.quad(at(u0, y1, o0), at(u1, y1, o0), at(u1, y1, o1), at(u0, y1, o1), UP, c);
        if (!skip.includes('d')) soup.quad(at(u0, y0, o0), at(u1, y0, o0), at(u1, y0, o1), at(u0, y0, o1), DOWN, side);
        if (!skip.includes('b')) soup.quad(at(u0, y0, o0), at(u1, y0, o0), at(u1, y1, o0), at(u0, y1, o0), neg, side);
      };
      const u = d.u, pw = D.pipe / 2, [hw, hd, hh] = D.hopper;
      // outside: the spout's mouth above the 雨水斗 (box + a neck), the pipe with a 管卡 per storey, the shoe, the 水簸箕
      const hTop = H + 0.02, neck = hTop - hh * 0.7, pipeTop = hTop - hh;
      const mouthTop = Math.min(H + D.slot[1], top - CORNICE.h);
      if (mouthTop > hTop) soup.quad(at(u - D.slot[0] / 2, hTop, 0.004), at(u + D.slot[0] / 2, hTop, 0.004), at(u + D.slot[0] / 2, mouthTop, 0.004), at(u - D.slot[0] / 2, mouthTop, 0.004), n, slotC);
      box(u - hw / 2, u + hw / 2, neck, hTop, 0.01, 0.01 + hd, pipeC, pipeS, 'b', pipeC);
      box(u - pw - 0.03, u + pw + 0.03, pipeTop, neck, D.off - 0.02, D.off + D.pipe + 0.02, pipeC, pipeS, 'bd');
      box(u - pw, u + pw, D.shoe[0], pipeTop, D.off, D.off + D.pipe, pipeC, pipeS, 'bd');
      for (const st of floorStack(b)) {
        const y = st.y + st.h * 0.55;
        if (y < pipeTop - 0.3) box(u - pw - 0.012, u + pw + 0.012, y, y + 0.04, 0, D.off + D.pipe + 0.012, ironC, ironC, 'b');
      }
      box(u - pw, u + pw, D.shoe[0] - D.pipe, D.shoe[0], D.off, D.off + D.shoe[1], pipeC, pipeS, 'b', slotC);
      box(u - D.splash[0] / 2, u + D.splash[0] / 2, 0, D.splash[2], 0.055, 0.055 + D.splash[1], splashC, splashC.clone().multiplyScalar(0.85), 'bd');
      // on the roof: the 过水孔 at the foot of the parapet's inner face (iron frame, two bars) and the 找坡 patch
      const io = -PARAPET_T, [sw, sh] = D.slot, fm = D.frame;
      soup.quad(at(u - sw / 2 - fm, H, io - 0.004), at(u + sw / 2 + fm, H, io - 0.004), at(u + sw / 2 + fm, H + sh + fm, io - 0.004), at(u - sw / 2 - fm, H + sh + fm, io - 0.004), neg, ironC);
      soup.quad(at(u - sw / 2, H, io - 0.008), at(u + sw / 2, H, io - 0.008), at(u + sw / 2, H + sh, io - 0.008), at(u - sw / 2, H + sh, io - 0.008), neg, slotC);
      for (const k of [-1, 1]) soup.quad(at(u + k * sw / 6 - 0.012, H, io - 0.012), at(u + k * sw / 6 + 0.012, H, io - 0.012), at(u + k * sw / 6 + 0.012, H + sh, io - 0.012), at(u + k * sw / 6 - 0.012, H + sh, io - 0.012), neg, ironC);
      // a lopsided half-disc fanned from the slot (6 wedges, 3 quads), flat like everything else (a gradient this soft
      // only dithers away), a hair above the roof (higher and the ink pass outlines it as a plate)
      const y = H + D.stainLift, c = at(u, y, io), rim = Array.from({ length: 7 }, (_, i) => {
        const a = (Math.PI * i) / 6, r = 0.8 + 0.35 * hash01(`${b.id}${d.side}${u}:${i}`);
        return at(u + Math.cos(a) * (D.stain[0] / 2) * r, y, io - Math.sin(a) * D.stain[1] * r);
      });
      for (let i = 0; i < 6; i += 2) soup.quad(c, rim[i], rim[i + 1], rim[i + 2], UP, stainC, SURF.roof, seed);
    }
  }
  return soup.geometry();
}
