import * as THREE from 'three';
import type { BridgeLampSet } from '../world/bridges.ts';

/**
 * 建筑表面 (docs/05 建筑色彩与材质): the building generator tags every vertex with `surf = (kind, seed)`; one patch on
 * the shared building material turns that into brick courses, sky-reflecting glass by day and a scatter of lit
 * windows at night. All per fragment, no textures, no extra draw calls.
 */
export const SURF = { plain: 0, brick: 1, glass: 2, door: 3, roof: 4, lamp: 5 } as const;
/** SURF.glass of a pane that stays dark by day even on a 阴雨天 (stairwell windows: 声控灯, not 日光灯; a `dayLit: false` building's): still glass to the shader (1.5 < x < 2.5). */
export const GLASS_NIGHT_ONLY = 2.25;

/** Uniforms shared by the building material (main.ts sets them from the time-of-day sample every frame). */
export interface FacadeUniforms {
  /** sky colours the glass reflects (linear): x = zenith, y = horizon */
  glassZenith: { value: THREE.Color };
  glassHorizon: { value: THREE.Color };
  /** 0..1: how much of the sky the glass shows (weather/night lower it via the sky colours themselves) */
  glassReflect: { value: number };
  /** share of windows lit (a pane is lit when its seed < this) */
  windowsLit: { value: number };
  /** 阴雨天白天的日光灯 (render/interior_light.ts tubeState: on × day): every glass pane but GLASS_NIGHT_ONLY's lit, paler than at night */
  windowsDay: { value: number };
  /** lit-window colour (linear, already scaled to its radiance) */
  windowColor: { value: THREE.Color };
  /** 连廊吸顶灯 (BRIDGE_LIGHT) radiance (linear), 0 = off: on with the 走廊灯 at night (main.ts syncFacade) */
  bridgeLamp: { value: THREE.Color };
}

export function createFacadeUniforms(): FacadeUniforms {
  return {
    glassZenith: { value: new THREE.Color(0x9cb2c8) }, glassHorizon: { value: new THREE.Color(0xe6e4da) },
    glassReflect: { value: 0.5 }, windowsLit: { value: 0 }, windowsDay: { value: 0 },
    windowColor: { value: new THREE.Color(0xdde2d2).multiplyScalar(0.8) }, bridgeLamp: { value: new THREE.Color(0) },
  };
}

/** Brick module (m): a course and a brick length. Stylised ×4 so a course is a few internal pixels at 20 m. */
export const BRICK = { h: 0.3, l: 0.9, fadeNear: 18, fadeFar: 55, jitter: 0.07, course: 0.05 };

/**
 * 屋面分格缝 (docs/05 建筑色彩与材质): the roof slab's cement screed is cast in `grid` m panels, the joints between
 * them filled with black 密封膏 (`joint` m wide, stylised ×2 so it reads at 360p; linear `seal` colour, `dark` = how
 * far a joint goes to it), each panel its own ±`jitter` shade
 * (cast and weathered apart); fades flat from `fadeNear` to `fadeFar` m. The joint lines' phase is per roof, packed
 * into the surf seed (`roofSeed`), so a roof's grid sits centred on it.
 */
export const ROOF = { grid: 3, joint: 0.06, seal: [0.035, 0.033, 0.03], dark: 0.75, jitter: 0.05, fadeNear: 30, fadeFar: 70 };

/** Pack a roof's joint phase (world x, z of one joint crossing, mod ROOF.grid; cm) into a surf seed. Pure. */
export function roofSeed(ox: number, oz: number): number {
  const m = (v: number) => Math.round((((v % ROOF.grid) + ROOF.grid) % ROOF.grid) * 100) % Math.round(ROOF.grid * 100);
  return m(ox) * 1000 + m(oz);
}

/** The joint phase back out of a seed (what the shader does): world x, z of a joint crossing. Pure. */
export function roofPhase(seed: number): [number, number] {
  const a = Math.floor((seed + 0.5) / 1000);
  return [a / 100, (seed - a * 1000) / 100];
}

/** Metres from world (x, z) to the nearest 分格缝 of the roof with `seed` (0 on a joint's centre line). Pure. */
export function roofJointDist(x: number, z: number, seed: number): number {
  const [ox, oz] = roofPhase(seed), g = ROOF.grid;
  const d = (v: number, o: number) => { const q = (v - o) / g + 0.5; return Math.abs(q - Math.floor(q) - 0.5) * g; };
  return Math.min(d(x, ox), d(z, oz));
}

const hash = (x: number, y: number) => { const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; return s - Math.floor(s); };

/**
 * Brightness multiplier of a brick wall at along-wall `u`, height `y`, seen from `dist` metres — the shader's maths.
 * Every other course is a shade darker, courses are offset by half a brick, each brick gets its own ±jitter; the
 * whole pattern fades to flat with distance (it would dither into noise). Pure, for tests.
 */
export function brickShade(u: number, y: number, dist: number): number {
  const row = Math.floor(y / BRICK.h);
  const col = Math.floor(u / BRICK.l + (row % 2 === 0 ? 0 : 0.5));
  const s = 1 - (row % 2 === 0 ? 0 : BRICK.course) + (hash(col, row) - 0.5) * 2 * BRICK.jitter;
  const fade = 1 - Math.min(1, Math.max(0, (dist - BRICK.fadeNear) / (BRICK.fadeFar - BRICK.fadeNear)));
  return 1 + (s - 1) * fade;
}

/** Whether a pane with `seed` is lit when `share` of the windows are (seed ≥ 1 = never lit). Pure. */
export const windowLit = (seed: number, share: number) => seed < share;

/**
 * Seed stored for a pane: a uniform draw `r` stretched by the building's night occupancy `share` (教学楼 1, 锅炉房
 * 0.2 …) so one global `windowsLit` uniform lights each building in proportion; share 0 never lights.
 */
export const paneSeed = (r: number, share: number) => (share > 0 ? r / share : 2);

/** Share of the night window radiance a 阴雨天 daytime lit pane shows (the room's light against daylight). */
export const DAY_WINDOW = 0.35;

/**
 * 连廊吸顶灯 (world/bridges.ts BRIDGE_LAMP) at night: an analytic point light per lamp on the 连廊's covered material
 * (no THREE light, no extra draw call): `k` × Lambert on the receiving face × the milk-glass dome's spread (`up`
 * sideways, 1 straight down) / (d² + `core`), + `bounce` (the lit deck back onto the 栏板 and the roof's underside),
 * only inside that 连廊's box (deck to roof underside, eave to eave: the end walls round its 连廊门 too). So the deck has a pool under each
 * lamp and goes dim between them. Radiance `level` × `color`: an old tube's white in a milk-glass dome, as warm as a
 * lit room at night (render/interior_light.ts ROOM_LAMP.warm), × the 走廊灯's on (main.ts syncFacade); the 灯罩 glows
 * `glow` × it.
 */
export const BRIDGE_LIGHT = { k: 14, core: 0.3, up: 0.3, bounce: 0.06, level: 0.8, glow: 1.2, color: new THREE.Color(0xdde2d2).multiply(new THREE.Color(1, 0.89, 0.73)) };
/** Irradiance factor (× bridgeLamp) at `p`, normal `n` (unit), from the 连廊吸顶灯 `sets`. Mirrors the shader's bridgeLampAt. Pure. */
export function bridgeLight(sets: readonly BridgeLampSet[], p: readonly [number, number, number], n: readonly [number, number, number]): number {
  const L = BRIDGE_LIGHT;
  let s = 0;
  for (const { box: b, v, at, fade, lamps } of sets) {
    if (p[0] < b[0] || p[1] < b[1] || p[2] < b[2] || p[0] > b[3] || p[1] > b[4] || p[2] > b[5]) continue;
    const t = Math.min(1, Math.max(0, (Math.abs(p[v] - at) - fade[0]) / (fade[1] - fade[0])));
    let q = L.bounce;
    for (const l of lamps) {
      const d = [l[0] - p[0], l[1] - p[1], l[2] - p[2]], d2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2, len = Math.max(Math.sqrt(d2), 1e-4);
      q += L.k * Math.max(0, (d[0] * n[0] + d[1] * n[1] + d[2] * n[2]) / len) * (L.up + (1 - L.up) * Math.max(0, d[1] / len)) / (d2 + L.core);
    }
    s += q * (1 - t * t * (3 - 2 * t));
  }
  return s;
}
/** GLSL bridgeLampAt(p, n): bridgeLight with the lamps baked in. */
function bridgeLampGlsl(sets: readonly BridgeLampSet[]): string {
  const f = (v: number) => v.toFixed(3), L = BRIDGE_LIGHT, v3 = (a: readonly number[]) => `vec3(${a.map(f).join(', ')})`;
  return `
        float bridgeLampTerm(vec3 d, vec3 n) {
          float d2 = dot(d, d), il = inversesqrt(max(d2, 1e-8));
          return max(0.0, dot(d, n) * il) * (${f(L.up)} + ${f(1 - L.up)} * max(0.0, d.y * il)) / (d2 + ${f(L.core)});
        }
        float bridgeLampAt(vec3 p, vec3 n) {
          float s = 0.0;${sets.map(q => `
          if (all(greaterThanEqual(p, ${v3(q.box.slice(0, 3))})) && all(lessThanEqual(p, ${v3(q.box.slice(3))}))) {
            float q = ${f(L.bounce)};${q.lamps.map(l => `
            q += ${f(L.k)} * bridgeLampTerm(${v3(l)} - p, n);`).join('')}
            s += q * (1.0 - smoothstep(${f(q.fade[0])}, ${f(q.fade[1])}, abs(p.${'xyz'[q.v]} - ${f(q.at)})));
          }`).join('')}
          return s;
        }`;
}

/**
 * Patch the building material. Chains any earlier onBeforeCompile and keys the program cache accordingly. With
 * `lamps` (the 连廊's covered material) the 连廊吸顶灯 light it too (BRIDGE_LIGHT).
 */
export function patchFacade(mat: THREE.MeshLambertMaterial, u: FacadeUniforms, lamps: readonly BridgeLampSet[] = []): void {
  mat.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 surf; varying vec2 vSurf; varying vec3 vFacW; varying vec3 vFacN;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vSurf = surf;
        vFacW = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vFacN = normalize(mat3(modelMatrix) * objectNormal);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 glassZenith; uniform vec3 glassHorizon; uniform float glassReflect; uniform float windowsLit; uniform float windowsDay; uniform vec3 windowColor; uniform vec3 bridgeLamp;
        varying vec2 vSurf; varying vec3 vFacW; varying vec3 vFacN;
        float facHash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }${lamps.length ? bridgeLampGlsl(lamps) : ''}`)
      .replace('#include <color_fragment>', `
        // 屋面分格缝 (ROOF): before the vertex colour, so lying snow (render/snowcover.ts, after it) covers the joints.
        // The line is box-filtered over the pixel footprint (fwidth, taken outside the branch): it thins to a faint even
        // darkening at grazing angles instead of crawling
        vec2 roofFw = max(fwidth(vFacW.xz), vec2(1e-4));
        if (vSurf.x > 3.5 && vSurf.x < 4.5) {
          float ra = floor((vSurf.y + 0.5) / 1000.0);
          vec2 rq = (vFacW.xz - vec2(ra, vSurf.y - ra * 1000.0) * 0.01) / ${ROOF.grid.toFixed(2)};
          vec2 rd = abs(fract(rq + 0.5) - 0.5) * ${ROOF.grid.toFixed(2)};
          vec2 hw = vec2(${(ROOF.joint / 2).toFixed(3)});
          vec2 cov = max(vec2(0.0), min(hw, rd + 0.5 * roofFw) - max(-hw, rd - 0.5 * roofFw)) / roofFw;
          float j = max(cov.x, cov.y);
          float s = 1.0 + (facHash(floor(rq) + 17.0) - 0.5) * ${(2 * ROOF.jitter).toFixed(3)};
          float fade = 1.0 - smoothstep(${ROOF.fadeNear.toFixed(1)}, ${ROOF.fadeFar.toFixed(1)}, length(vViewPosition));
          // the joint goes to the 密封膏's own dark (divided by the vertex colour <color_fragment> multiplies in next)
          vec3 roofSeal = vec3(${ROOF.seal.map(v => v.toFixed(3)).join(', ')}) / max(vColor.rgb, vec3(0.05));
          diffuseColor.rgb = mix(diffuseColor.rgb, mix(diffuseColor.rgb * s, roofSeal, j * ${ROOF.dark.toFixed(2)}), fade);
        }
        #include <color_fragment>
        float facU = dot(vFacW.xz, vec2(-vFacN.z, vFacN.x));
        if (vSurf.x > 0.5 && vSurf.x < 1.5) {
          float row = floor(vFacW.y / ${BRICK.h.toFixed(3)});
          float odd = mod(row, 2.0);
          float col = floor(facU / ${BRICK.l.toFixed(3)} + odd * 0.5);
          float s = 1.0 - odd * ${BRICK.course.toFixed(3)} + (facHash(vec2(col, row)) - 0.5) * ${(2 * BRICK.jitter).toFixed(3)};
          float fade = 1.0 - smoothstep(${BRICK.fadeNear.toFixed(1)}, ${BRICK.fadeFar.toFixed(1)}, length(vViewPosition));
          diffuseColor.rgb *= mix(1.0, s, fade);
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if (vSurf.x > 1.5 && vSurf.x < 3.5) {
          bool lit = vSurf.x < 2.5 && vSurf.y < windowsLit;
          // 阴雨天白天: the rooms behind are lit too (interior_light dayTubesOn), but in daylight that only reads as
          // the glass a little brighter and colder than the sky in it, not as a glowing block
          float dayK = (vSurf.x < 2.1 && !lit) ? windowsDay : 0.0;
          // the sky in the glass: zenith up high, horizon low, one diagonal glint per pane
          float up = clamp(vFacW.y / 18.0, 0.0, 1.0);
          vec3 skyC = mix(glassHorizon, glassZenith, 0.35 + 0.5 * up);
          float glint = step(fract((facU + vFacW.y) * 0.55 + vSurf.y * 3.1), 0.22);
          float k = 0.65 + 0.35 * fract(vSurf.y * 7.31);
          if (lit) {
            // a lit room: cold 日光灯 white (the street lamps keep the only warm light), each a little different (curtains)
            diffuseColor.rgb *= 0.3;
            totalEmissiveRadiance += windowColor * k;
          } else {
            diffuseColor.rgb *= 1.0 - 0.5 * dayK;
            totalEmissiveRadiance += skyC * glassReflect * (0.22 + 0.2 * fract(vSurf.y * 3.7) + 0.35 * glint) * (1.0 - 0.35 * dayK)
              + windowColor * k * ${DAY_WINDOW.toFixed(2)} * dayK;
          }
        }
        // 连廊吸顶灯's 乳白灯罩 (SURF.lamp): grey-white while off, glowing while the 走廊灯 are on
        if (vSurf.x > 4.5 && vSurf.x < 5.5) totalEmissiveRadiance += bridgeLamp * ${BRIDGE_LIGHT.glow.toFixed(2)};`);
    // the 连廊吸顶灯 on what is under the 连廊's roof: added to the ambient irradiance (RE_IndirectDiffuse takes it)
    if (lamps.length) shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_end>',
      'irradiance += bridgeLamp * bridgeLampAt(vFacW, normalize(vFacN));\n#include <lights_fragment_end>');
  };
  mat.customProgramCacheKey = () => (lamps.length ? `facade|bridge-lamps:${lamps.map(q => q.lamps.length).join(',')}` : 'facade');
}
