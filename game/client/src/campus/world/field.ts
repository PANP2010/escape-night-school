/**
 * 田径场 (data/campus/campus.json `field`, docs/03 田径场): a 200 m track (塑胶红, white lane lines, 终点线), the
 * infield lawn (mowing stripes) with a 七人制 pitch and two goals, and the 看台 along the south side: concrete rows you
 * walk up through the aisles (each row one step, ≤ the walker's stepHeight), rows of plastic seats between the aisles,
 * and the 主席台 in the middle (raised deck, red-clothed table, parapet, a canopy on four columns).
 * Everything is one vertex-coloured mesh (one draw call); its colliders come from the same boxes.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { AABB } from '../../../../shared/campus/collision.ts';
import type { FieldDef } from '../../../../shared/campus/campus_schema.ts';
import type { Roof } from './shelter.ts';
import { tag } from './paving.ts';

export const FIELD = {
  color: {
    track: '#9a5b4e', line: '#d8d4c8', kerb: '#c4beb0', apron: '#a39d8f', grass: ['#7b875a', '#727e53'],
    concrete: '#b0a998', riser: '#9c9584', seat: ['#6f8296', '#66788b'], post: '#dcd8cc', cloth: '#8b4a44',
    table: '#8b4a44', chair: '#5f5a52', column: '#8f969a', roof: '#c4bfb2',
  },
  /** surface heights above the ground plane: under the puddle layer (1.5 cm); lines and the kerb a step higher */
  y: { surface: 0.008, line: 0.024, kerb: 0.03 },
  line: 0.08,
  /** samples per semicircle */ segs: 24,
  /** 七人制 pitch (along x, along z), centre circle radius, penalty box (deep, wide), goal (wide, high, deep), post */
  pitch: [52, 28] as [number, number], circle: 4, box: [7, 14] as [number, number], goal: [5, 2, 1.5] as [number, number, number], postW: 0.1,
  /** stand: seat pitch along x, aisle width, seat (wide, seat top, deep), backrest (high, thick), parapet height */
  seatPitch: 0.5, aisle: 1.2, seat: [0.42, 0.42, 0.4] as [number, number, number], back: [0.32, 0.05] as [number, number], parapet: 1.0,
  /** 主席台: table (long, high, deep, back from the front), chairs, canopy (height above the deck, overhang) */
  table: [8, 0.75, 0.6, 1.6] as [number, number, number, number], chairs: 10, canopy: [3.2, 1] as [number, number], column: 0.3,
  /** canopy slab thickness, front lip depth below it */ roof: [0.18, 0.35] as [number, number],
};

export interface FieldBox { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number; color: string; solid?: boolean }

/** Track outer radius (inner edge r + lanes), the apron's outer radius and the stand's front edge (world z). */
export function fieldLayout(f: FieldDef) {
  const outer = f.r + f.lanes * f.lane, apron = outer + f.apron;
  const front = f.z - apron - f.stand.gap;
  return { outer, apron, front, back: front - f.stand.rows * f.stand.run };
}

/** Length of the stadium loop `off` m outside the track's inner edge (lane 1 is measured 0.3 m out). */
export const loopLength = (f: FieldDef, off = 0) => 2 * f.straight + 2 * Math.PI * (f.r + off);

/** Stand seat runs: [x0, x1] spans along x between the aisles (ends, each wing's middle, and the 主席台's sides). */
export function seatRuns(f: FieldDef): [number, number][] {
  const { len, dais } = f.stand, a = FIELD.aisle, out: [number, number][] = [];
  for (const s of [-1, 1]) {
    const inner = f.x + s * dais / 2, outer = f.x + s * len / 2, mid = (inner + outer) / 2;
    const cuts = [inner + s * a, mid - s * a / 2, mid + s * a / 2, outer - s * a];
    out.push([Math.min(cuts[0], cuts[1]), Math.max(cuts[0], cuts[1])], [Math.min(cuts[2], cuts[3]), Math.max(cuts[2], cuts[3])]);
  }
  return out.sort((p, q) => p[0] - q[0]);
}

/** The 主席台 canopy's plan rect (world) and the height of its slab's underside: from the back parapet out past the front. */
export function standCanopy(f: FieldDef) {
  const { front, back } = fieldLayout(f), [ch, over] = FIELD.canopy, d0 = f.x - f.stand.dais / 2, d1 = f.x + f.stand.dais / 2;
  return { x0: d0 - 0.4, x1: d1 + 0.4, z0: back - 0.2, z1: front + over, y: 4 * f.stand.rise + ch };
}

/**
 * The 主席台 canopy as a Roof (world/shelter.ts shelterAt / dryBoxes, world/drips.ts, render/snowcover.ts): its back
 * edge rests on the back parapet (closed: eye height on the deck is under the parapet top), open to the field and both
 * ends; `t` reaches down to the front lip, so drops fall from its lower edge.
 */
export function standRoofs(f: FieldDef | undefined): Roof[] {
  if (!f) return [];
  const c = standCanopy(f), [slab, lip] = FIELD.roof;
  return [{ x0: c.x0, x1: c.x1, z0: c.z0, z1: c.z1, y: c.y + slab, t: slab + lip, closed: ['-z'] }];
}

/** Every box of the 看台, 主席台 and goals; `solid` ones are colliders. */
export function fieldBoxes(f: FieldDef): FieldBox[] {
  const C = FIELD.color, st = f.stand, { front, back } = fieldLayout(f), out: FieldBox[] = [];
  const x0 = f.x - st.len / 2, x1 = f.x + st.len / 2, d0 = f.x - st.dais / 2, d1 = f.x + st.dais / 2;
  const deck = 4 * st.rise;
  // rows: each solid from the ground to its tread (the 主席台 cuts the middle out of them)
  for (let k = 1; k <= st.rows; k++) {
    const z1 = front - (k - 1) * st.run, z0 = z1 - st.run, y1 = k * st.rise;
    for (const [a, b] of [[x0, d0], [d1, x1]]) {
      out.push({ x0: a, x1: b, y0: 0, y1, z0, z1, color: k % 2 ? C.concrete : C.riser, solid: true });
    }
    // seats at the back of the tread, in runs between the aisles: pedestal, pan, backrest (one collider per run)
    const [sw, sy, sd] = FIELD.seat, sz0 = z0 + 0.06, sz1 = sz0 + sd;
    for (const [r0, r1] of seatRuns(f)) {
      out.push({ x0: r0, x1: r1, y0: y1, y1: y1 + sy, z0: sz0, z1: sz1, color: C.seat[0], solid: true });
      const n = Math.floor((r1 - r0) / FIELD.seatPitch);
      for (let i = 0; i < n; i++) {
        const cx = r0 + (i + 0.5) * (r1 - r0) / n, col = C.seat[(i + k) % 2];
        out.push({ x0: cx - 0.06, x1: cx + 0.06, y0: y1, y1: y1 + sy - 0.05, z0: sz0 + 0.12, z1: sz0 + 0.26, color: C.riser });
        out.push({ x0: cx - sw / 2, x1: cx + sw / 2, y0: y1 + sy - 0.05, y1: y1 + sy, z0: sz0, z1: sz1, color: col });
        out.push({ x0: cx - sw / 2, x1: cx + sw / 2, y0: y1 + sy, y1: y1 + sy + FIELD.back[0], z0: sz0, z1: sz0 + FIELD.back[1], color: col });
      }
    }
  }
  const top = st.rows * st.rise;
  // back parapet + the stepped side walls at both ends
  out.push({ x0: x0 - 0.2, x1: x1 + 0.2, y0: 0, y1: top + FIELD.parapet, z0: back - 0.2, z1: back, color: C.riser, solid: true });
  for (const [a, b] of [[x0 - 0.2, x0], [x1, x1 + 0.2]]) for (let k = 1; k <= st.rows; k++) {
    const z1 = front - (k - 1) * st.run;
    out.push({ x0: a, x1: b, y0: 0, y1: k * st.rise + FIELD.parapet, z0: z1 - st.run, z1, color: C.riser, solid: true });
  }
  // 主席台: deck, front parapet hung with red cloth, the table (cloth to the floor), chairs, canopy on four columns
  out.push({ x0: d0, x1: d1, y0: 0, y1: deck, z0: back, z1: front, color: C.concrete, solid: true });
  out.push({ x0: d0, x1: d1, y0: deck, y1: deck + FIELD.parapet, z0: front - 0.15, z1: front, color: C.riser, solid: true });
  out.push({ x0: d0 + 0.6, x1: d1 - 0.6, y0: 0.35, y1: deck + FIELD.parapet - 0.12, z0: front, z1: front + 0.02, color: C.cloth });
  const [tl, th, td, tb] = FIELD.table, tz1 = front - tb, tz0 = tz1 - td;
  out.push({ x0: f.x - tl / 2, x1: f.x + tl / 2, y0: deck, y1: deck + th, z0: tz0, z1: tz1, color: C.table, solid: true });
  for (let i = 0; i < FIELD.chairs; i++) {
    const cx = f.x - tl / 2 + (i + 0.5) * tl / FIELD.chairs, cz = tz0 - 0.45;
    out.push({ x0: cx - 0.22, x1: cx + 0.22, y0: deck, y1: deck + 0.45, z0: cz - 0.2, z1: cz + 0.2, color: C.chair });
    out.push({ x0: cx - 0.22, x1: cx + 0.22, y0: deck + 0.45, y1: deck + 0.95, z0: cz - 0.22, z1: cz - 0.17, color: C.chair });
  }
  const cw = FIELD.column, cn = standCanopy(f), roofY = cn.y;
  for (const cx of [d0 + cw / 2, d1 - cw / 2]) for (const cz of [front - 0.4, back + 0.2]) {
    out.push({ x0: cx - cw / 2, x1: cx + cw / 2, y0: deck, y1: roofY, z0: cz - cw / 2, z1: cz + cw / 2, color: C.column, solid: true });
  }
  out.push({ x0: cn.x0, x1: cn.x1, y0: roofY, y1: roofY + FIELD.roof[0], z0: cn.z0, z1: cn.z1, color: C.roof });
  out.push({ x0: cn.x0, x1: cn.x1, y0: roofY - FIELD.roof[1], y1: roofY, z0: cn.z1 - 0.08, z1: cn.z1, color: C.roof });
  // goals: two posts + crossbar on the goal line, back bars on the ground and a top frame back to them (no net)
  const [gw, gh, gd] = FIELD.goal, p = FIELD.postW, half = FIELD.pitch[0] / 2;
  for (const s of [-1, 1]) {
    const gx = f.x + s * half, bx = gx + s * gd, xa = Math.min(gx, bx), xb = Math.max(gx, bx);
    for (const zz of [f.z - gw / 2, f.z + gw / 2]) {
      out.push({ x0: gx - p / 2, x1: gx + p / 2, y0: 0, y1: gh, z0: zz - p / 2, z1: zz + p / 2, color: C.post, solid: true });
      out.push({ x0: xa, x1: xb, y0: 0, y1: 0.06, z0: zz - 0.03, z1: zz + 0.03, color: C.post });
      out.push({ x0: bx - 0.03, x1: bx + 0.03, y0: 0, y1: gh * 0.6, z0: zz - 0.03, z1: zz + 0.03, color: C.post });
      out.push({ x0: xa, x1: xb, y0: gh - 0.05, y1: gh, z0: zz - 0.03, z1: zz + 0.03, color: C.post });
    }
    out.push({ x0: gx - p / 2, x1: gx + p / 2, y0: gh - p, y1: gh, z0: f.z - gw / 2, z1: f.z + gw / 2, color: C.post });
    out.push({ x0: bx - 0.03, x1: bx + 0.03, y0: 0, y1: 0.06, z0: f.z - gw / 2, z1: f.z + gw / 2, color: C.post });
  }
  return out;
}

export function fieldColliders(f: FieldDef): AABB[] {
  return fieldBoxes(f).filter(b => b.solid).map(b => ({ minX: b.x0, minY: b.y0, minZ: b.z0, maxX: b.x1, maxY: b.y1, maxZ: b.z1 }));
}

/** Samples of the stadium loop's centre line: point on the inner frame (cx, cz) + outward normal (nx, nz). */
function loopFrame(f: FieldDef): [number, number, number, number][] {
  const h = f.straight / 2, out: [number, number, number, number][] = [];
  for (const s of [1, -1]) {
    // straight on the −z (s = 1) / +z side, walked toward +x / −x, then the semicircle at that end
    out.push([f.x - s * h, f.z, 0, -s], [f.x + s * h, f.z, 0, -s]);
    for (let i = 1; i < FIELD.segs; i++) {
      const a = -Math.PI / 2 + (i / FIELD.segs) * Math.PI;
      out.push([f.x + s * h, f.z, s * Math.cos(a), s * Math.sin(a)]);
    }
  }
  return out;
}

/** Flat band of the loop between offsets ra < rb from its centre line (ra = 0 fills the stadium). */
function ring(f: FieldDef, ra: number, rb: number, y: number, color: string): THREE.BufferGeometry {
  const fr = loopFrame(f), pos: number[] = [];
  for (let i = 0; i < fr.length; i++) {
    const [ax, az, anx, anz] = fr[i], [bx, bz, bnx, bnz] = fr[(i + 1) % fr.length];
    const a0 = [ax + anx * ra, az + anz * ra], a1 = [ax + anx * rb, az + anz * rb];
    const b0 = [bx + bnx * ra, bz + bnz * ra], b1 = [bx + bnx * rb, bz + bnz * rb];
    // the loop runs clockwise seen from above (+y): wind each quad so it faces up
    pos.push(a0[0], y, a0[1], b1[0], y, b1[1], a1[0], y, a1[1], a0[0], y, a0[1], b0[0], y, b0[1], b1[0], y, b1[1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return tag(g, color);
}
const flat = (x0: number, x1: number, z0: number, z1: number, y: number, color: string) => {
  const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
  g.rotateX(-Math.PI / 2);
  g.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
  return tag(g, color);
};
const boxGeo = (b: FieldBox) => {
  const g = new THREE.BoxGeometry(b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0);
  g.translate((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2);
  return tag(g, b.color);
};

/** The whole 田径场 as one geometry (paving attributes: merged into the PAVING mesh, world/campus.ts). */
export function fieldGeometry(f: FieldDef): THREE.BufferGeometry {
  const C = FIELD.color, Y = FIELD.y, L = FIELD.line, { outer, apron } = fieldLayout(f), geos: THREE.BufferGeometry[] = [];
  geos.push(ring(f, 0, f.r - 0.1, Y.surface, C.grass[0]), ring(f, f.r - 0.1, f.r, Y.kerb, C.kerb));
  geos.push(ring(f, f.r, outer, Y.surface, C.track), ring(f, outer, apron, Y.surface, C.apron));
  for (let i = 1; i <= f.lanes; i++) {
    const r = f.r + i * f.lane;
    geos.push(ring(f, r - (i === f.lanes ? L : L / 2), r + (i === f.lanes ? 0 : L / 2), Y.line, C.line));
  }
  // 终点线 across the lanes at the east end of the south straight (in front of the 看台), start line at its west end
  for (const x of [f.x + f.straight / 2 - L, f.x - f.straight / 2]) geos.push(flat(x, x + L, f.z - outer, f.z - f.r, Y.line, C.line));
  // mowing stripes across the pitch, then its lines
  const [pw, pd] = FIELD.pitch, px0 = f.x - pw / 2, px1 = f.x + pw / 2, pz0 = f.z - pd / 2, pz1 = f.z + pd / 2;
  const stripes = 13, sw = pw / stripes;
  for (let i = 1; i < stripes; i += 2) geos.push(flat(px0 + i * sw, px0 + (i + 1) * sw, pz0, pz1, Y.surface + 0.006, C.grass[1]));
  const outline = (x0: number, x1: number, z0: number, z1: number) => {
    geos.push(flat(x0, x1, z0, z0 + L, Y.line, C.line), flat(x0, x1, z1 - L, z1, Y.line, C.line));
    geos.push(flat(x0, x0 + L, z0, z1, Y.line, C.line), flat(x1 - L, x1, z0, z1, Y.line, C.line));
  };
  outline(px0, px1, pz0, pz1);
  geos.push(flat(f.x - L / 2, f.x + L / 2, pz0, pz1, Y.line, C.line));
  const [bd, bw] = FIELD.box;
  outline(px0, px0 + bd, f.z - bw / 2, f.z + bw / 2);
  outline(px1 - bd, px1, f.z - bw / 2, f.z + bw / 2);
  const circle = new THREE.RingGeometry(FIELD.circle - L, FIELD.circle, 32);
  circle.rotateX(-Math.PI / 2);
  circle.translate(f.x, Y.line, f.z);
  geos.push(tag(circle, C.line), flat(f.x - 0.15, f.x + 0.15, f.z - 0.15, f.z + 0.15, Y.line + 0.001, C.line));
  for (const b of fieldBoxes(f)) geos.push(boxGeo(b));
  return mergeGeometries(geos)!;
}
