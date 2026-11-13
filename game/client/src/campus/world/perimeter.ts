import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { AABB } from '../../../../shared/campus/collision.ts';
import type { WallDef } from '../../../../shared/campus/campus_schema.ts';

/**
 * 围墙 (docs/03_campus.md WALL) the way a county school builds one: a painted brick wall on a grey cement 勒脚, a
 * 墙垛 every few metres standing a little proud of both faces and a little above the top, a cement 压顶 along the top.
 * The piers and the plinth catch the sun on their ends and throw the wall into bays, so a long stretch reads as a
 * wall, not one flat board. Only on full-height stretches: the 西北矮墙 has its own 压顶 and 墙垛 (world/lowwall.ts),
 * the 南门 its 门柱 (world/gate.ts). Nothing here collides: it is within a few cm of the wall boxes.
 */
export const PERIM = {
  /** 墙垛: spacing (m), along-wall width, how far proud of each face, how much above the wall, cap overhang / thickness */
  pier: { bay: 3.6, w: 0.37, proud: 0.06, up: 0.12, cap: 0.03, capT: 0.06 },
  /** 压顶: overhang either side, thickness */ coping: [0.04, 0.08],
  /** 勒脚: height, how far proud */ plinth: [0.45, 0.02],
  /** no pier closer than this to the end of a stretch that is not a corner (门柱, 矮墙墙垛 stand there) */ clear: 1.0,
};

export type PerimKind = 'body' | 'plinth' | 'pier' | 'cap' | 'coping';
export interface PerimPart { kind: PerimKind; box: AABB; color: string }

const COLOR = { plinth: '#8f8a80', cap: '#c9c4b8', coping: '#c9c4b8' };

/** The wall body boxes (wallBoxes) plus everything on them (world space). */
export function perimeterParts(w: WallDef, bodies: AABB[]): PerimPart[] {
  const P = PERIM, pr = P.pier, [co, ct] = P.coping, [ph, pp] = P.plinth, out: PerimPart[] = [];
  const add = (kind: PerimKind, minX: number, maxX: number, minY: number, maxY: number, minZ: number, maxZ: number, color: string) =>
    out.push({ kind, box: { minX, maxX, minY, maxY, minZ, maxZ }, color });
  const corner = (x: number, z: number) =>
    (Math.abs(x - w.minX) < 0.01 || Math.abs(x - w.maxX) < 0.01) && (Math.abs(z - w.minZ) < 0.01 || Math.abs(z - w.maxZ) < 0.01);
  // a pier at (x, z): square-ish in plan, `proud` past both faces and (at a corner) past both ends
  const pier = (x: number, z: number, alongX: boolean) => {
    const hw = corner(x, z) ? w.t / 2 + pr.proud : pr.w / 2, ht = w.t / 2 + pr.proud;
    const [hx, hz] = alongX ? [hw, ht] : [ht, hw], top = w.h + pr.up;
    add('pier', x - hx, x + hx, 0, top, z - hz, z + hz, w.color);
    add('cap', x - hx - pr.cap, x + hx + pr.cap, top, top + pr.capT, z - hz - pr.cap, z + hz + pr.cap, COLOR.cap);
  };
  for (const b of bodies) {
    add('body', b.minX, b.maxX, b.minY, b.maxY, b.minZ, b.maxZ, w.color);
    if (b.maxY < w.h - 0.01) continue; // the low stretch
    const alongX = b.maxX - b.minX > b.maxZ - b.minZ;
    const [a0, a1] = alongX ? [b.minX, b.maxX] : [b.minZ, b.maxZ];
    const [c0, c1] = alongX ? [b.minZ, b.maxZ] : [b.minX, b.maxX];
    const span = (u0: number, u1: number, v0: number, v1: number, y0: number, y1: number, kind: PerimKind, color: string) =>
      alongX ? add(kind, u0, u1, y0, y1, v0, v1, color) : add(kind, v0, v1, y0, y1, u0, u1, color);
    span(a0, a1, c0 - pp, c1 + pp, 0, ph, 'plinth', COLOR.plinth);
    span(a0, a1, c0 - co, c1 + co, w.h, w.h + ct, 'coping', COLOR.coping);
    // piers on whole bays between the ends: a corner end has the corner pier, any other end keeps `clear`
    const end = (u: number) => (alongX ? corner(u, w.minZ) || corner(u, w.maxZ) : corner(w.minX, u) || corner(w.maxX, u));
    const e0 = end(a0 + w.t / 2) ? a0 + w.t / 2 : a0 + P.clear, e1 = end(a1 - w.t / 2) ? a1 - w.t / 2 : a1 - P.clear;
    const n = Math.max(1, Math.round((e1 - e0) / pr.bay)), step = (e1 - e0) / n, v = (c0 + c1) / 2;
    for (let i = 1; i < n; i++) alongX ? pier(e0 + i * step, v, true) : pier(v, e0 + i * step, false);
  }
  for (const x of [w.minX, w.maxX]) for (const z of [w.minZ, w.maxZ]) pier(x, z, true);
  return out;
}

/** All of it as one merged vertex-coloured geometry (one draw call, the wall's). */
export function perimeterGeometry(parts: PerimPart[]): THREE.BufferGeometry {
  return mergeGeometries(parts.map(({ box: b, color }) => {
    const g = new THREE.BoxGeometry(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ).toNonIndexed();
    g.translate((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2);
    const c = new THREE.Color(color), n = g.getAttribute('position').count, col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.deleteAttribute('uv');
    return g;
  }))!;
}
