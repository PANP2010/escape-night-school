import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Rng } from '../core/rng.ts';

/**
 * 墙外: what lies past the campus. Nobody goes there, but the 西北矮墙 (结局3「远方」), the upper floors and the 天台
 * look out on it: a band of 荒地 round the campus ground, a 土路 with a line of 电线杆 along it (not on the street side),
 * 平房 with 太阳能热水器 on their flat roofs close in, 自建房 a few storeys behind them, then 居民楼 and one 塔吊 going
 * grey into the fog. Never walked into (the wall stops the walker). One merged vertex-coloured mesh; windows are drawn
 * per fragment from a `win` tag (patchOutskirts), a share of them lit at night (`outskirtsLit` ← the 路灯 level).
 */
export const OUTSKIRTS = {
  /** how far the 荒地 runs out past the campus ground (m); how far the ±z rows run on past the corners */ reach: 320, corner: 170,
  /** 土路: centre distance out from the ground's edge, width */ road: [7, 4],
  /** 电线杆 line: distance out, spacing, height, section, 横担 width; wire section, sag at mid-span */
  pole: { v: 10.5, bay: 36, h: 9, s: 0.24, arm: 1.8, wire: 0.11, sag: 0.45 },
  /** rows of houses: start distance [min, max] out from the ground's edge, storeys, storey height, size along / out, gap,
   * window spacing along the wall */
  rows: [
    { kind: 'pingfang', at: [15, 21], storeys: [1, 1], fh: 3.4, w: [6, 12], d: [5, 8], gap: [1, 6], win: 3.2 },
    { kind: 'zijian', at: [34, 52], storeys: [2, 4], fh: 3.1, w: [8, 14], d: [8, 12], gap: [2, 9], win: 3 },
    { kind: 'louban', at: [80, 150], storeys: [5, 7], fh: 2.9, w: [24, 52], d: [10, 13], gap: [12, 36], win: 2.8 },
  ],
  /** the 塔吊 on the west: distance out, along (world z), mast height, jib length either side of the mast */
  crane: { v: 135, u: 176, h: 42, jib: [12, 36] },
  /** at most this share of windows lit at night (× the 路灯 level) */ lit: 0.3,
} as const;

export type OutKind = 'ground' | 'road' | 'pole' | 'wire' | 'house' | 'roof' | 'heater' | 'crane';
/** A world-space box: centre, size (x, y, z), tilts about world x / z (rad); `win` = [storey height, window spacing, seed] */
export interface OutPart { kind: OutKind; c: [number, number, number]; s: [number, number, number]; rx?: number; rz?: number; color: string; win?: [number, number, number]; row?: number }
type Side = '-x' | '+x' | '-z' | '+z';
const TILE = 40;

export const COLOR = {
  ground: '#8b846a', road: '#a39880', pole: '#9b978d', wire: '#3b3835', roof: '#6f6b63', heater: '#3d424a', tank: '#c9c8c0',
  crane: '#b39a4a',
  walls: [['#8e5c4a', '#7f7b72', '#c4bfb1', '#b5a47e'], ['#cfc9ba', '#c2a497', '#9d9a90', '#d6cfb8'], ['#c6bfad', '#b6b0a0', '#a8a59b', '#cbbfa6']],
};

/** Every box past the campus ground (`size`/`center` of the ground plane); `street`: the -z side has the 门外马路. */
export function outskirtsParts(ground: { size: readonly number[]; center: readonly number[] }, street: boolean): OutPart[] {
  const O = OUTSKIRTS, out: OutPart[] = [], rnd = new Rng(20070607), r = (a: number, b: number) => rnd.range(a, b);
  const gx0 = ground.center[0] - ground.size[0] / 2, gx1 = ground.center[0] + ground.size[0] / 2;
  const gz0 = ground.center[1] - ground.size[1] / 2, gz1 = ground.center[1] + ground.size[1] / 2, R = O.reach;
  // flat slabs are cut into tiles of at most TILE m: one 300 m triangle crossing the near plane rasterises with a bad
  // depth here and there (SwiftShader), and the 土路 showed through the 围墙 in a row of pale dashes
  const tiles = (a: number, b: number) => { const n = Math.ceil((b - a) / TILE - 1e-6); return Array.from({ length: n }, (_, i) => [a + (b - a) * i / n, a + (b - a) * (i + 1) / n]); };
  const flat = (kind: OutKind, x0: number, x1: number, z0: number, z1: number, top: number, color: string) => {
    for (const [a, b] of tiles(x0, x1)) for (const [c, d] of tiles(z0, z1))
      out.push({ kind, c: [(a + b) / 2, top - 0.01, (c + d) / 2], s: [b - a, 0.02, d - c], color });
  };
  // 荒地: a frame round the ground plane, a hair below it where they overlap
  flat('ground', gx0 - R, gx0 + 0.5, gz0 - 0.5, gz1 + 0.5, -0.02, COLOR.ground);
  flat('ground', gx1 - 0.5, gx1 + R, gz0 - 0.5, gz1 + 0.5, -0.02, COLOR.ground);
  flat('ground', gx0 - R, gx1 + R, gz1 - 0.5, gz1 + R, -0.02, COLOR.ground);
  flat('ground', gx0 - R, gx1 + R, gz0 - R, gz0 + 0.5, -0.02, COLOR.ground);
  // a side's frame: u along it (world z on ±x, x on ±z), y up, v out from the ground's edge
  for (const side of ['-x', '+z', '+x', '-z'] as Side[]) {
    const onX = side[1] === 'x', sign = side[0] === '-' ? -1 : 1, edge = onX ? (sign < 0 ? gx0 : gx1) : (sign < 0 ? gz0 : gz1);
    const [u0, u1] = onX ? [gz0, gz1] : [gx0 - O.corner, gx1 + O.corner];
    /** a box in the side's frame: centre (u, y, v), size along u / up / along v; `tu` tilts the u end up, `tv` the v end */
    const add = (kind: OutKind, u: number, y: number, v: number, su: number, sy: number, sv: number, color: string, tu = 0, tv = 0, extra: Partial<OutPart> = {}) => {
      const p: OutPart = onX ? { kind, c: [edge + sign * v, y, u], s: [sv, sy, su], color, ...extra } : { kind, c: [u, y, edge + sign * v], s: [su, sy, sv], color, ...extra };
      // +u is +z on ±x (rotateX(-a) lifts it), +x on ±z (rotateZ(a)); the v tilt is the other axis, signed by the side
      if (tu) { if (onX) p.rx = -tu; else p.rz = tu; }
      if (tv) { if (onX) p.rz = tv * sign; else p.rx = -tv * sign; }
      out.push(p);
    };
    const poles = !(street && side === '-z');
    if (poles) {
      const [rv, rw] = O.road, ext = onX ? rv + rw / 2 : 0;
      for (const [a, b] of tiles(u0 - ext, u1 + ext)) add('road', (a + b) / 2, onX ? 0.004 - 0.01 : 0.008 - 0.01, rv, b - a, 0.02, rw, COLOR.road);
      // 电线杆 + 横担, four wires between neighbours (three on the 横担 and the top, a telecom cable lower that sags more)
      const P = O.pole, start = u0 + r(4, P.bay - 4), n = Math.floor((u1 - start) / P.bay);
      const wires: [number, number, number][] = [[-0.8, P.h - 0.45, 1], [0.8, P.h - 0.45, 1], [0, P.h + 0.03, 0.9], [0.3, P.h - 2.4, 2.2]];
      for (let i = 0; i <= n; i++) {
        const u = start + i * P.bay;
        add('pole', u, P.h / 2, P.v, P.s, P.h, P.s, COLOR.pole);
        add('pole', u, P.h - 0.4, P.v, 0.12, 0.1, P.arm, COLOR.pole);
        if (i === n) continue;
        for (const [dv, y, k] of wires) {
          const half = P.bay / 2, drop = P.sag * k, len = Math.hypot(half, drop), ang = Math.atan2(drop, half);
          add('wire', u + half / 2, y - drop / 2, P.v + dv, len, P.wire, P.wire, COLOR.wire, -ang);
          add('wire', u + half * 1.5, y - drop / 2, P.v + dv, len, P.wire, P.wire, COLOR.wire, ang);
        }
      }
    }
    // rows of houses, each a box with its windows drawn on (`win`), a roof slab a little proud of it, and on top: 太阳能热水器
    // on the 平房, a 楼梯间 on some 自建房, a 水箱 on the 楼板
    O.rows.forEach((row, ri) => {
      for (let u = u0 + r(0, row.gap[1]); ; ) {
        const wu = r(row.w[0], row.w[1]), d = r(row.d[0], row.d[1]), v = r(row.at[0], row.at[1]);
        if (u + wu > u1) break;
        const n = row.storeys[0] + Math.floor(r(0, row.storeys[1] - row.storeys[0] + 1)), h = n * row.fh + (ri === 0 ? 0.3 : 0);
        const cu = u + wu / 2, cv = v + d / 2, walls = COLOR.walls[ri];
        add('house', cu, h / 2, cv, wu, h, d, walls[Math.floor(r(0, walls.length))], 0, 0, { win: [row.fh, row.win, Math.floor(r(0, 997))], row: ri });
        add('roof', cu, h + 0.1, cv, wu + 0.3, 0.2, d + 0.3, COLOR.roof);
        if (ri === 0 && r(0, 1) < 0.55) {
          // 太阳能热水器: the tubes tilted to the south, the tank along their top edge
          const p = onX ? [edge + sign * (cv + r(-1, 1)), cu] : [cu + r(-2, 2), edge + sign * (cv + r(-1, 1))];
          out.push({ kind: 'heater', c: [p[0], h + 0.75, p[1]], s: [1.8, 0.06, 1.4], rx: -0.75, color: COLOR.heater });
          out.push({ kind: 'heater', c: [p[0], h + 1.25, p[1] + 0.5], s: [1.9, 0.44, 0.44], color: COLOR.tank });
        } else if (ri === 1 && r(0, 1) < 0.4) add('roof', cu - wu / 2 + 2, h + 1.4, cv, 2.6, 2.6, 2.8, walls[0]);
        else if (ri === 2) add('roof', cu + r(-wu / 4, wu / 4), h + 1.2, cv, 3, 2.2, 3, COLOR.roof);
        u += wu + r(row.gap[0], row.gap[1]);
      }
    });
    // a 塔吊 over the far roofs to the west: mast, jib, counterweight
    if (side === '-x') {
      const C = O.crane;
      add('crane', C.u, C.h / 2, C.v, 1.6, C.h, 1.6, COLOR.crane);
      add('crane', C.u + (C.jib[1] - C.jib[0]) / 2, C.h + 0.6, C.v, C.jib[0] + C.jib[1], 1.2, 1.2, COLOR.crane);
      add('crane', C.u - C.jib[0] + 2.5, C.h - 0.6, C.v, 4, 2, 2, COLOR.roof);
      add('crane', C.u, C.h + 4, C.v, 1, 8, 1, COLOR.crane);
    }
  }
  return out;
}

/** Share of the town's windows lit: the 路灯 level, thinning out after 22:30 to a fifth by 00:30, until the lamps go off. */
export function townLit(minute: number, lamps: number): number {
  const m = ((minute % 1440) + 1440) % 1440, late = m >= 22.5 * 60 ? m - 22.5 * 60 : m < 5 * 60 ? m + 90 : 0;
  return OUTSKIRTS.lit * lamps * (1 - 0.8 * Math.min(1, late / 120));
}

/** The parts as one merged geometry: vertex colour + `win` (storey height, window spacing, seed) on house walls. */
export function outskirtsGeometry(ground: { size: readonly number[]; center: readonly number[] }, street = true): THREE.BufferGeometry {
  const geos = outskirtsParts(ground, street).map(p => {
    const g = new THREE.BoxGeometry(...p.s).toNonIndexed();
    if (p.rz) g.rotateZ(p.rz);
    if (p.rx) g.rotateX(p.rx);
    g.translate(...p.c);
    const c = new THREE.Color(p.color), n = g.getAttribute('position').count, col = new Float32Array(n * 3), win = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col.set([c.r, c.g, c.b], i * 3); if (p.win) win.set(p.win, i * 3); }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('win', new THREE.BufferAttribute(win, 3));
    g.deleteAttribute('uv');
    return g;
  });
  return mergeGeometries(geos)!;
}

/**
 * The 电线 as line segments along each wire box's axis (xyz pairs): drawn 1 px over the boxes, so a span far off that is
 * under a pixel thick stays one unbroken line instead of rasterising into dashes; up close it sits inside its box.
 */
export function outskirtsWires(ground: { size: readonly number[]; center: readonly number[] }, street = true): Float32Array {
  const wires = outskirtsParts(ground, street).filter(p => p.kind === 'wire'), out = new Float32Array(wires.length * 6);
  const X = new THREE.Vector3(1, 0, 0), Z = new THREE.Vector3(0, 0, 1);
  wires.forEach((p, i) => {
    const long = p.s[0] >= p.s[2] ? 0 : 2, half = new THREE.Vector3();
    half.setComponent(long, p.s[long] / 2);
    // same order as the box: rotateZ, then rotateX
    if (p.rz) half.applyAxisAngle(Z, p.rz);
    if (p.rx) half.applyAxisAngle(X, p.rx);
    out.set([p.c[0] - half.x, p.c[1] - half.y, p.c[2] - half.z, p.c[0] + half.x, p.c[1] + half.y, p.c[2] + half.z], i * 6);
  });
  return out;
}

/**
 * Windows on the town's walls, per fragment: a grid of storey height × spacing on every side face tagged `win`, dark
 * glass by day, a share lit 日光灯 cold white at night (`outskirtsLit`, townLit), one flat colour the fog fades
 * whole; panes keep ≥ ~1 px and the grid switches to its average once a cell is under 2 px (no moiré far off). Returns the uniforms.
 */
export function patchOutskirts(mat: THREE.MeshLambertMaterial): { outskirtsLit: { value: number } } {
  const u = { outskirtsLit: { value: 0 } };
  mat.onBeforeCompile = shader => {
    shader.uniforms.outskirtsLit = u.outskirtsLit;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 win; varying vec3 vWin; varying vec3 vWinP;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 winW = modelMatrix * vec4(transformed, 1.0);
        vWin = win; vWinP = vec3(abs(objectNormal.x) > 0.5 ? winW.z : winW.x, winW.y, abs(objectNormal.y));`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float outskirtsLit; varying vec3 vWin; varying vec3 vWinP;
        // integer lattice in, so no sin() of a big number: that and an interpolated seed a hair off 997 flipped on per pixel
        float winHash(vec3 p){ p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yzx + 33.33); return fract((p.x + p.y) * p.z); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec2 winC = vec2(vWinP.x / max(vWin.y, 0.1), vWinP.y / max(vWin.x, 0.1)), winFw = fwidth(winC);
        float winPx = max(max(winFw.x, winFw.y), 1e-4), winLit = 0.0;
        if (vWin.x > 0.5 && vWinP.z < 0.5) {
          vec2 fr = fract(winC) - 0.5, id = floor(winC);
          // hard-edged panes, never thinner than ~1 px (a sub-pixel pane would flicker in and out); once a cell is
          // under 2 px the grid gives way to its average, all or nothing, so no band in between turns to dither
          vec2 hw = max(vec2(0.22, 0.21), vec2(0.6 * winPx));
          float inWin = step(abs(fr.x), hw.x) * step(abs(fr.y + 0.01), hw.y);
          bool far = winPx > 0.5;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05, 0.06, 0.07), far ? 0.12 : inWin * 0.75);
          float on = step(winHash(vec3(id, floor(vWin.z + 0.5))), outskirtsLit);
          winLit = far ? 0.185 * outskirtsLit : inWin * on;
        }`)
      .replace('#include <fog_fragment>', `// a lit pane is one flat 日光灯 white (as on the campus blocks), put in before the fog so the fog fades it whole
        gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.761, 0.701, 0.578), winLit);
        #include <fog_fragment>`);
  };
  mat.customProgramCacheKey = () => 'outskirts';
  return u;
}
