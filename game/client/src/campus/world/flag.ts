import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { FLAG_POLE } from './paving.ts';
import type { PlatformDef } from '../../../../shared/campus/campus_schema.ts';

/**
 * 旗杆上的旗 (升旗台, campus.json platform `pole`): a 3号旗 (1.92 × 1.28 m) at the top of the pole, flying toward +x.
 * One vertex-coloured mesh, one draw call: a plane in `seg` columns plus the five stars laid a hair proud of both faces
 * (the 30 × 20 grid of the standard: big star r 3 at (5, 5), small stars r 1 pointing at it). The wave is all in the
 * vertex shader: z = amp · u^0.8 · sin(k·x − ω·t), u = distance from the hoist / width, so the hoist stays on the pole;
 * the normal tilts with the slope so the folds catch the light.
 */
export const FLAG = {
  w: 1.92, h: 1.28, seg: [16, 4] as const, /** below the 顶球 */ drop: 0.08, /** gap to the pole axis */ gap: 0.05,
  red: '#c23a2e', star: '#e8c54a', /** star lift off the cloth (m) */ lift: 0.004,
  /** wave: amplitude m, wavenumber rad/m, speed rad/s */ amp: 0.11, k: 3.6, w0: 2.6,
};

const tag = (g: THREE.BufferGeometry, color: string) => {
  const c = new THREE.Color(color), n = g.getAttribute('position').count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g.index ? g.toNonIndexed() : g;
};

/** Points of a 5-pointed star at (cx, cy) with outer radius r, one point at angle `a` (rad, from +x, CCW). */
export function starPoints(cx: number, cy: number, r: number, a: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < 10; i++) {
    const t = a + (i * Math.PI) / 5, rr = i % 2 ? r * 0.382 : r;
    out.push([cx + Math.cos(t) * rr, cy + Math.sin(t) * rr]);
  }
  return out;
}

/** The five stars in flag-local metres (x from the hoist, y down from the top edge → negative). */
export function flagStars(): { x: number; y: number; r: number; a: number }[] {
  const c = FLAG.w / 30, big = { x: 5 * c, y: -5 * c, r: 3 * c, a: Math.PI / 2 };
  const small = [[10, 2], [12, 4], [12, 7], [10, 9]].map(([gx, gy]) => {
    const x = gx * c, y = -gy * c;
    return { x, y, r: c, a: Math.atan2(big.y - y, big.x - x) };
  });
  return [big, ...small];
}

/** Flag geometry in flag-local space: hoist at x 0, top edge at y 0, cloth in the z 0 plane. */
export function flagGeometry(): THREE.BufferGeometry {
  const F = FLAG, cloth = new THREE.PlaneGeometry(F.w, F.h, F.seg[0], F.seg[1]);
  cloth.translate(F.w / 2, -F.h / 2, 0);
  const geos = [tag(cloth, F.red)];
  for (const s of flagStars()) {
    const pts = starPoints(s.x, s.y, s.r, s.a).map(([x, y]) => new THREE.Vector2(x, y));
    for (const side of [1, -1]) {
      const g = new THREE.ShapeGeometry(new THREE.Shape(pts));
      if (side < 0) { g.scale(1, 1, -1); g.index?.array.reverse(); }
      g.translate(0, 0, side * F.lift);
      geos.push(tag(g, F.star));
    }
  }
  return mergeGeometries(geos)!;
}

/** The flag on the 升旗台's pole (or nothing if no platform has one). `update(t)` drives the wave. */
export class Flag {
  readonly mesh: THREE.Mesh | null = null;
  private time = { value: 0 };
  constructor(platforms: PlatformDef[]) {
    const p = platforms.find(q => q.pole);
    if (!p) return;
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const f = (v: number) => v.toFixed(4);
    mat.onBeforeCompile = shader => {
      shader.uniforms.flagTime = this.time;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          uniform float flagTime;
          float flagU(float x) { return pow(clamp(x / ${f(FLAG.w)}, 0.0, 1.0), 0.8); }
          float flagZ(vec3 p) { return ${f(FLAG.amp)} * flagU(p.x) * sin(${f(FLAG.k)} * p.x - ${f(FLAG.w0)} * flagTime + p.y * 0.8); }`)
        .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
          float dzdx = (flagZ(position + vec3(0.01, 0.0, 0.0)) - flagZ(position)) / 0.01;
          objectNormal = normalize(vec3(-dzdx, 0.0, 1.0)) * (normal.z < 0.0 ? -1.0 : 1.0);`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          transformed.z += flagZ(position);`);
    };
    mat.customProgramCacheKey = () => 'flag';
    const top = p.h + p.pole!;
    const geo = flagGeometry();
    // culled like everything else (indoors it costs no draw call); the sphere padded by the wave's swing
    geo.computeBoundingSphere(); geo.boundingSphere!.radius += FLAG.amp;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(p.x + FLAG.gap + FLAG_POLE.r[1], top - FLAG.drop, p.z + p.d / 4);
    mesh.name = 'FLAG';
    this.mesh = mesh;
  }
  /** Per frame: `t` real seconds. */
  update(t: number): void { this.time.value = t; }
}
