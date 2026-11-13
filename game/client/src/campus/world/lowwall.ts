import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Rng } from '../core/rng.ts';
import { box, type AABB } from '../../../../shared/campus/collision.ts';
import type { LowWallDef, WallDef } from '../../../../shared/campus/campus_schema.ts';

/**
 * 西北矮墙 (docs/03_campus.md WALL, 结局3「远方」): the stretch of the perimeter wall nobody built up — `low.h` high
 * between two 墙垛 where the full wall stops. A cement 压顶 on it with 碎玻璃 set in the cement (bottle greens and
 * browns, a few clear), and 铁丝 on rusty angle-iron posts: three strands, the top two sagging over one span (wire
 * gives; nobody says why). The wall body itself is one of wallBoxes (world/campus.ts); this is the rest, as a parts
 * list for tests, one merged vertex-coloured mesh to draw. Nothing here climbs: the wall is a collider like the rest.
 */
export const LOWWALL = {
  /** 墙垛 at both ends: plan size (along, across), how much taller than the wall */ pier: [0.5, 0.56, 0.1],
  /** 压顶: overhang either side, thickness */ coping: [0.05, 0.07],
  /** 碎玻璃 per metre, shard size ranges (along, up) and thickness */ glass: { per: 7, w: [0.05, 0.13], h: [0.05, 0.14], t: 0.008 },
  /** 铁丝 posts: spacing, height above the 压顶, angle-iron section; strand heights over the 压顶, wire section */
  post: { bay: 2.4, h: 0.62, s: 0.035 }, strands: [0.2, 0.4, 0.6], wire: 0.012,
  /** which bay sags (index from `from`), how far its top two strands drop at mid-span */ sag: { bay: 3, drop: [0.12, 0.3] },
};

export type LowKind = 'pier' | 'cap' | 'coping' | 'glass' | 'post' | 'wire';
/** A box in the wall's frame turned into world space: centre, size (along the wall, up, across), yaw `ry` and tilt `rz` (rad) */
export interface LowPart { kind: LowKind; c: [number, number, number]; s: [number, number, number]; ry?: number; rz?: number; color: string }

const COLOR = { cap: '#c2baa6', coping: '#b9b3a4', post: '#5e4a3c', wire: '#4a4440' };
const GLASS = ['#6f8a74', '#7d9682', '#8a7a58', '#9d8a62', '#c9d0c6', '#5f7a6a'];
/** 碎玻璃 against the sun (patchLowWall): light through a shard when the sun is behind it (power of the cone, gain on the
 * glass's own colour), and a glint off a face turned just right (power, gain on the sun colour) */
export const GLINT = { backPow: 3, back: 2.2, glintPow: 90, glint: 1.6 };

/** The low stretch's line: the wall's fixed coordinate (x on a ±x side, z on a ±z side) and whether it runs along z. */
export function lowLine(w: WallDef, low: LowWallDef): { along: 'x' | 'z'; at: number } {
  const along = low.side[1] === 'x' ? 'z' : 'x';
  const at = low.side === '-x' ? w.minX : low.side === '+x' ? w.maxX : low.side === '-z' ? w.minZ : w.maxZ;
  return { along, at };
}

/** Every part on top of and at the ends of the low stretch (world space). */
export function lowWallParts(w: WallDef): LowPart[] {
  const low = w.low;
  if (!low) return [];
  const L = LOWWALL, { along, at } = lowLine(w, low), out: LowPart[] = [];
  // u = along the wall, y = up, v = across it (+ = into the campus)
  const inward = low.side[0] === '-' ? 1 : -1;
  const add = (kind: LowKind, u: number, y: number, v: number, su: number, sy: number, sv: number, color: string, ry = 0, rz = 0) => {
    const c: [number, number, number] = along === 'z' ? [at + v * inward, y, u] : [u, y, at + v * inward];
    out.push({ kind, c, s: [su, sy, sv], ...(ry ? { ry } : {}), ...(rz ? { rz } : {}), color });
  };
  const top = low.h, [cpo, cpt] = L.coping, ct = top + cpt;
  // 墙垛 where the full wall stops, a little proud of it, with a cap
  const [pa, px, pt] = L.pier;
  for (const u of [low.from - pa / 2, low.to + pa / 2]) {
    add('pier', u, (w.h + pt) / 2, 0, pa, w.h + pt, px, w.color); // the full wall's paint
    add('cap', u, w.h + pt + 0.04, 0, pa + 0.08, 0.08, px + 0.08, COLOR.cap);
  }
  add('coping', (low.from + low.to) / 2, top + cpt / 2, 0, low.to - low.from, cpt, w.t + 2 * cpo, COLOR.coping);
  // 碎玻璃 stuck up out of the cement, every which way
  const rnd = new Rng(19970701), r = (a: number, b: number) => rnd.range(a, b), G = L.glass;
  const n = Math.round((low.to - low.from) * G.per);
  for (let i = 0; i < n; i++) {
    const u = low.from + (i + r(0.15, 0.85)) * (low.to - low.from) / n, h = r(G.h[0], G.h[1]);
    const color = GLASS[Math.floor(r(0, GLASS.length))];
    add('glass', u, ct + h / 2 - 0.02, r(-w.t / 2 + 0.04, w.t / 2 - 0.04), r(G.w[0], G.w[1]), h, G.t, color, r(-1.2, 1.2), r(-0.35, 0.35));
  }
  // 铁丝: posts in the middle of the 压顶, strands between neighbours, one span sagging
  const P = L.post, bays = Math.max(1, Math.round((low.to - low.from - 0.4) / P.bay)), step = (low.to - low.from - 0.4) / bays;
  for (let i = 0; i <= bays; i++) {
    const u = low.from + 0.2 + i * step;
    add('post', u, ct + P.h / 2, 0, P.s, P.h, P.s, COLOR.post, 0, i === L.sag.bay ? 0.12 : 0);
    if (i === bays) continue;
    L.strands.forEach((sy, k) => {
      const y = ct + sy, sagging = i === L.sag.bay && k > 0, drop = sagging ? L.sag.drop[k - 1] : 0.015;
      // a strand as two straight halves down to its low point at mid-span
      const half = step / 2, len = Math.hypot(half, drop), ang = Math.atan2(drop, half);
      add('wire', u + half / 2, y - drop / 2, 0, len, L.wire, L.wire, COLOR.wire, 0, -ang);
      add('wire', u + half * 1.5, y - drop / 2, 0, len, L.wire, L.wire, COLOR.wire, 0, ang);
    });
  }
  return out;
}

/** What stops the walker beyond wallBoxes: the 墙垛 (the low body is a wall box). */
export function lowWallColliders(w: WallDef): AABB[] {
  if (!w.low) return [];
  const alongZ = lowLine(w, w.low).along === 'z';
  return lowWallParts(w).filter(p => p.kind === 'pier')
    .map(p => box(p.c[0], p.c[2], alongZ ? p.s[2] : p.s[0], alongZ ? p.s[0] : p.s[2], p.s[1]));
}

/** The low stretch's parts as one merged, vertex-coloured geometry (one draw call). */
export function lowWallGeometry(w: WallDef): THREE.BufferGeometry | undefined {
  const parts = lowWallParts(w);
  if (!parts.length || !w.low) return undefined;
  const alongZ = lowLine(w, w.low).along === 'z';
  const geos = parts.map(p => {
    const g = new THREE.BoxGeometry(...p.s).toNonIndexed();
    if (p.rz) g.rotateZ(p.rz);
    if (p.ry) g.rotateY(p.ry);
    // parts are authored along x; a stretch along z turns them a quarter
    if (alongZ) g.rotateY(Math.PI / 2);
    g.translate(...p.c);
    const c = new THREE.Color(p.color), n = g.getAttribute('position').count, col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('glassy', new THREE.BufferAttribute(new Float32Array(n).fill(p.kind === 'glass' ? 1 : 0), 1));
    g.deleteAttribute('uv');
    return g;
  });
  return mergeGeometries(geos)!;
}

/**
 * The 碎玻璃 catch the sun (vertex colour alone leaves them dark blobs against a low sun): with the sun behind a shard
 * the bottle glass glows its own green / brown, and a face turned just right flashes the sun's colour — which shards
 * flash moves as you walk. Both from the scene's sun (directionalLights[0]), so the moon gives a faint version at night.
 */
export function patchLowWall(mat: THREE.MeshLambertMaterial): void {
  const f = (v: number) => v.toFixed(4), G = GLINT;
  mat.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float glassy; varying float vGlassy;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlassy = glassy;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGlassy;')
      .replace('#include <opaque_fragment>', `
        #if NUM_DIR_LIGHTS > 0
        if (vGlassy > 0.5) {
          vec3 V = normalize(vViewPosition), L = directionalLights[0].direction, sunC = directionalLights[0].color;
          float through = pow(max(dot(-V, L), 0.0), ${f(G.backPow)});
          vec3 H = L + V;
          float glint = dot(H, H) > 1e-3 ? pow(abs(dot(normal, normalize(H))), ${f(G.glintPow)}) : 0.0;
          outgoingLight += sunC * (diffuseColor.rgb * through * ${f(G.back)} + glint * ${f(G.glint)});
        }
        #endif
        #include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => 'lowwall';
}
