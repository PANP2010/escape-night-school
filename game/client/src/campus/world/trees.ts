import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import treesJson from '../data/trees.json';
import { Rng } from '../core/rng.ts';
import { PAVE } from './paving.ts';
import { hexToSrgb, srgbToLinear } from '../render/palette.ts';

/**
 * 中轴梧桐 (悬铃木), docs/03 中轴大道 / docs/05 每幕调色板. Every tree is grown from its own seed: a mottled trunk that
 * forks at ~2.8 m into 3 (sometimes 2 or 4) limbs, each forking twice more; leaf clusters (jittered icospheres,
 * darker underneath) sit on the limb ends and the branch tips, so the crown is a broad lumpy dome over the road
 * that leaves the trunk clear up to ~3.6 m. All trees merge into two meshes (wood, crowns: 2 draw calls).
 * The season (data/trees.json, by game day) lives in uniforms only: each crown cluster switches whole from the
 * first colour to the second (a per-fragment blend would be dithered into grey by the palette) and drops out
 * whole as the tree goes bare, so winter is the branches alone. Falling and lying leaves: one InstancedMesh of
 * small quads (+1 draw call while any show), all motion in the vertex shader like world/snow.ts.
 */

type Vec3 = [number, number, number];
export interface SeasonKey { day: number; crown: [string, string]; turn: number; fill: number; fall: number; litter: number }
export interface TreesData { chapterDay: number[]; season: SeasonKey[] }
export const TREES = treesJson as unknown as TreesData;
export interface Season { crown: [Vec3, Vec3]; turn: number; fill: number; fall: number; litter: number }

export const TREE = {
  /** fork height range, trunk radius (base, fork) */ fork: [2.6, 3.0] as const, trunkR: [0.3, 0.22] as const,
  /** prism sides of every wood segment */ sides: 5,
  /** trees are merged per square cell this wide (x centred on the axis), so the frustum culls what is out of view */ chunk: 30,
  /** max horizontal reach of any crown cluster's edge from its trunk (keeps the 宣传栏 and lamp heads clear) */ reach: 3.6,
  bark: ['#8f8874', '#aba68f', '#6f6858', '#9c9a86'],
  twig: '#5c554a',
};
export const FALLING_PER_TREE = 22;
export const LYING_PER_TREE = 56;
/** leaves on the 树池 soil (swept there by the 值日生 and blown in; they stay longer than the ones on the paving) */
export const PIT_PER_TREE = 14;
const LEAF_SIZE = 0.2;

const lin = (hex: string) => hexToSrgb(hex).map(srgbToLinear) as Vec3;
const mix = (a: number, b: number, k: number) => a + (b - a) * k;

/**
 * Season on a game day (day 0 = 9 月 1 日), interpolated between data/trees.json keys (colours in linear light);
 * `chapter` floors the day at that act's `chapterDay`, so a bare `?chapter=6` jump shows January trees. Pure.
 */
export function seasonAt(day: number, chapter = 0, d: TreesData = TREES): Season {
  const k = d.season, floor = d.chapterDay[Math.min(d.chapterDay.length - 1, Math.max(0, Math.floor(chapter)))] ?? 0;
  const t = Math.max(day, floor);
  let i = 0;
  while (i < k.length - 2 && t >= k[i + 1].day) i++;
  const a = k[i], b = k[i + 1] ?? a;
  const f = b.day > a.day ? Math.min(1, Math.max(0, (t - a.day) / (b.day - a.day))) : 0;
  const c = (j: 0 | 1) => lin(a.crown[j]).map((v, n) => mix(v, lin(b.crown[j])[n], f)) as Vec3;
  return { crown: [c(0), c(1)], turn: mix(a.turn, b.turn, f), fill: mix(a.fill, b.fill, f), fall: mix(a.fall, b.fall, f), litter: mix(a.litter, b.litter, f) };
}

/** One wood segment (a tapered prism a → b) and one leaf cluster, relative to the trunk foot. */
export interface Segment { a: Vec3; b: Vec3; r0: number; r1: number; bark: boolean }
export interface Cluster { c: Vec3; r: number; /** 0..1: the share of `turn` that recolours it */ turn: number; /** 0..1: above `fill` it is gone */ fill: number }
export interface Skeleton { segments: Segment[]; clusters: Cluster[] }

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const dirOf = (az: number, el: number, len: number): Vec3 => [Math.cos(az) * Math.cos(el) * len, Math.sin(el) * len, Math.sin(az) * Math.cos(el) * len];

/**
 * A 梧桐's skeleton from its seed (pure, deterministic): trunk → limbs → branches → twigs, leaf clusters at the
 * branch ends (the core, full early, last to go bare) and the twig ends (the rim, first to turn and to drop).
 * `lean` (unit x, z) tips the upper crown toward the road, as street plane trees grow toward the open light.
 * Horizontal reach is scaled down to TREE.reach; no cluster hangs below `clear` m.
 */
export function treeSkeleton(seed: number, lean: [number, number] = [0, 0], clear = 3.6): Skeleton {
  const rnd = new Rng(seed * 7919 + 17), r = (a: number, b: number) => rnd.range(a, b);
  const segments: Segment[] = [], clusters: Cluster[] = [];
  const forkY = r(...TREE.fork);
  // trunk: four stacked pieces with a slight wander (more bark patches, no ruler-straight pole)
  let p: Vec3 = [0, 0, 0];
  for (let i = 1; i <= 4; i++) {
    const q: Vec3 = [r(-0.05, 0.05) * i, (forkY * i) / 4, r(-0.05, 0.05) * i];
    segments.push({ a: p, b: q, r0: mix(TREE.trunkR[0], TREE.trunkR[1], (i - 1) / 4), r1: mix(TREE.trunkR[0], TREE.trunkR[1], i / 4), bark: true });
    p = q;
  }
  const fork = p, u = rnd.next();
  const limbs = u < 0.12 ? 2 : u < 0.8 ? 3 : 4, az0 = r(0, Math.PI * 2);
  for (let l = 0; l < limbs; l++) {
    const az = az0 + (l / limbs) * Math.PI * 2 + r(-0.35, 0.35);
    const e = add(fork, dirOf(az, r(0.85, 1.05), r(1.7, 2.2)));
    segments.push({ a: fork, b: e, r0: 0.17, r1: 0.12, bark: true });
    for (let b = 0; b < 2; b++) {
      const baz = az + (b ? 1 : -1) * r(0.3, 0.6);
      const be = add(e, dirOf(baz, r(0.55, 0.85), r(1.1, 1.5)));
      segments.push({ a: e, b: be, r0: 0.1, r1: 0.065, bark: true });
      clusters.push({ c: add(be, [0, r(0.2, 0.5), 0]), r: r(1.15, 1.45), turn: rnd.next(), fill: r(0, 0.55) });
      for (let t = 0; t < 2; t++) {
        const taz = baz + (t ? 1 : -1) * r(0.35, 0.7);
        const te = add(be, dirOf(taz, r(0.15, 0.6), r(0.8, 1.15)));
        segments.push({ a: be, b: te, r0: 0.055, r1: 0.03, bark: false });
        clusters.push({ c: te, r: r(0.85, 1.15), turn: rnd.next(), fill: r(0.35, 1) });
      }
    }
  }
  clusters.push({ c: [fork[0], fork[1] + r(3.3, 3.8), fork[2]], r: r(1.4, 1.7), turn: rnd.next(), fill: r(0, 0.3) });
  // balance the crown over the trunk (random limbs can all fall to one side), then lean it toward the road; both
  // grow with height above the fork, so the limbs bend instead of detaching
  const mx = clusters.reduce((a, c) => a + c.c[0], 0) / clusters.length, mz = clusters.reduce((a, c) => a + c.c[2], 0) / clusters.length;
  const tip = (v: Vec3): Vec3 => {
    const k = Math.min(1, Math.max(0, v[1] - forkY) / 2.5);
    return [v[0] + (lean[0] * 0.7 - mx) * k, v[1], v[2] + (lean[1] * 0.7 - mz) * k];
  };
  for (const s of segments) { s.a = tip(s.a); s.b = tip(s.b); }
  for (const c of clusters) c.c = tip(c.c);
  const ext = Math.max(...clusters.map(c => Math.hypot(c.c[0], c.c[2]) + c.r));
  if (ext > TREE.reach) {
    const k = TREE.reach / ext;
    const sq = (v: Vec3): Vec3 => (v[1] > forkY ? [v[0] * k, v[1], v[2] * k] : v);
    for (const s of segments) { s.a = sq(s.a); s.b = sq(s.b); }
    for (const c of clusters) { c.c = sq(c.c); c.r *= k; }
  }
  for (const c of clusters) c.r = Math.min(c.r, (c.c[1] - clear) / 0.8);
  return { segments, clusters };
}

/** The trees along the axis, each with its seed and the way its crown leans (toward the road, x = 0). */
export function axisTrees(positions: [number, number][]): { x: number; z: number; seed: number; lean: [number, number] }[] {
  return positions.map(([x, z], i) => ({ x, z, seed: i + 1, lean: [x > 0 ? -1 : x < 0 ? 1 : 0, 0] as [number, number] }));
}

/** A tapered n-sided prism a → b, flat faces, one colour per face from `pick` (梧桐 bark: grey-green-cream patches). */
function prism(s: Segment, pick: () => THREE.Color): THREE.BufferGeometry {
  const n = TREE.sides, axis = new THREE.Vector3(...s.b).sub(new THREE.Vector3(...s.a));
  const len = axis.length();
  const g = new THREE.CylinderGeometry(s.r1, s.r0, len, n, 1, false).toNonIndexed();
  g.translate(0, len / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.normalize()));
  g.translate(...s.a);
  g.deleteAttribute('uv');
  g.computeVertexNormals();
  const cnt = g.getAttribute('position').count, col = new Float32Array(cnt * 3);
  // one colour per side quad (2 triangles); the caps share the first
  for (let t = 0; t < cnt / 3; t += 2) {
    const c = pick();
    for (let v = 0; v < 6 && (t * 3 + v) < cnt; v++) col.set([c.r, c.g, c.b], (t * 3 + v) * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** All trunks/limbs/twigs as one vertex-coloured geometry (world space). */
export function woodGeometry(trees: { x: number; z: number; seed: number; lean: [number, number] }[]): THREE.BufferGeometry {
  const bark = TREE.bark.map(h => new THREE.Color(h)), twig = new THREE.Color(TREE.twig);
  const geos: THREE.BufferGeometry[] = [];
  for (const t of trees) {
    const rnd = new Rng(t.seed * 31 + 5);
    for (const s of treeSkeleton(t.seed, t.lean).segments) {
      const g = prism(s, () => (s.bark ? bark[Math.floor(rnd.next() * bark.length)] : twig));
      g.translate(t.x, 0, t.z);
      geos.push(g);
    }
  }
  return mergeGeometries(geos)!;
}

/**
 * All leaf clusters as one geometry (world space): jittered icospheres, squashed a little, shaded darker toward the
 * underside in the vertex colour. Attribute `leaf` = (turn, fill, cluster centre x, y, z… packed as vec4 + vec3).
 */
export function crownGeometry(trees: { x: number; z: number; seed: number; lean: [number, number] }[]): THREE.BufferGeometry {
  const geos: THREE.BufferGeometry[] = [];
  for (const t of trees) {
    const rnd = new Rng(t.seed * 131 + 9);
    for (const c of treeSkeleton(t.seed, t.lean).clusters) {
      let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, 1);
      // lumpy: push every shared vertex in or out (before un-indexing, so faces stay closed)
      const pos = g.getAttribute('position') as THREE.BufferAttribute, seen = new Map<string, number>();
      for (let i = 0; i < pos.count; i++) {
        const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
        if (!seen.has(key)) seen.set(key, rnd.range(0.82, 1.12));
        const k = seen.get(key)!;
        pos.setXYZ(i, pos.getX(i) * k * c.r, pos.getY(i) * k * c.r * 0.8, pos.getZ(i) * k * c.r);
      }
      if (g.index) g = g.toNonIndexed();
      g.deleteAttribute('uv');
      g.translate(t.x + c.c[0], c.c[1], t.z + c.c[2]);
      g.computeVertexNormals();
      const n = g.getAttribute('position').count, nrm = g.getAttribute('normal');
      const col = new Float32Array(n * 3), leaf = new Float32Array(n * 4), tone = rnd.range(0.92, 1.06);
      for (let i = 0; i < n; i++) {
        // lit from inside by sky through the gaps: brighter than the colour on top, a step darker underneath (the
        // palette would otherwise pull the shaded side of every crown down to its near-black)
        const ny = nrm.getY(i), s = tone * (ny < -0.35 ? 0.95 : ny > 0.35 ? 1.35 : 1.15);
        col.set([s, s, s], i * 3);
        leaf.set([c.turn, c.fill, t.x + c.c[0], t.z + c.c[2]], i * 4);
      }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.setAttribute('leaf', new THREE.BufferAttribute(leaf, 4));
      g.setAttribute('leafY', new THREE.BufferAttribute(new Float32Array(n).fill(c.c[1]), 1));
      geos.push(g);
    }
  }
  return mergeGeometries(geos)!;
}

export type AxisTree = ReturnType<typeof axisTrees>[number];

/** Trees grouped by TREE.chunk cells (x centred on the axis, so both rows of a stretch share one), in first-seen order. */
export function treeCells<T extends { x: number; z: number }>(trees: T[]): T[][] {
  const cells = new Map<string, T[]>(), C = TREE.chunk;
  for (const t of trees) {
    const k = `${Math.floor((t.x + C / 2) / C)},${Math.floor(t.z / C)}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k)!.push(t);
  }
  return [...cells.values()];
}

/**
 * The axis 梧桐 in the scene: wood + crowns per cell (2 draw calls each in view, treeCells) and the leaf particles (falling + lying, 1 draw call
 * while the season has any). `sync(day, chapter)` sets the season uniforms (cheap; call every frame),
 * `update(time, light)` drives the leaves (`light` = linear colour of the air on a leaf, from the time of day).
 */
/** 夜色: crowns and leaf litter are greyed (lerp 0.55) and halved, so the trees are dark silhouettes, not a green park */
const NIGHT_GREY = new THREE.Color(0.12, 0.12, 0.12);

export class AxisTrees {
  readonly group = new THREE.Group();
  readonly trees: AxisTree[];
  readonly leaves: THREE.InstancedMesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  season: Season = seasonAt(0);
  private u = {
    crownA: { value: new THREE.Color() }, crownB: { value: new THREE.Color() },
    turn: { value: 0 }, fill: { value: 1 },
    /** sky light scattered through the leaves (linear; follows the air's light, so dark at night) */ glow: { value: new THREE.Color() },
  };
  private leafMat!: THREE.ShaderMaterial;
  private key = '';

  constructor(positions: [number, number][]) {
    this.trees = axisTrees(positions);
    const woodMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const crownMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    crownMat.customProgramCacheKey = () => 'crown';
    crownMat.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, this.u);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 leaf; attribute float leafY; uniform float fill; varying float vTurn;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vTurn = leaf.x;
          // bare: the whole cluster collapses to its centre (a degenerate point, nothing drawn)
          if (leaf.y >= fill) transformed = vec3(leaf.z, leafY, leaf.w);`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 crownA; uniform vec3 crownB; uniform float turn; uniform vec3 glow; varying float vTurn;')
        .replace('#include <color_fragment>', `#include <color_fragment>
          diffuseColor.rgb *= vTurn < turn ? crownB : crownA;`)
        // a crown is not a solid: light comes through it, so its shaded side never sinks to the palette's black
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += diffuseColor.rgb * glow;');
    };
    // one wood + one crown mesh per cell (merged geometry is one bounding sphere: the whole avenue plus the tree by
    // the 西北矮墙 would never leave the frustum)
    for (const cell of treeCells(this.trees)) {
      const wood = new THREE.Mesh(woodGeometry(cell), woodMat), crowns = new THREE.Mesh(crownGeometry(cell), crownMat);
      wood.name = 'TREES.wood';
      crowns.name = 'TREES.crowns';
      this.group.add(wood, crowns);
    }
    this.leaves = this.buildLeaves();
    this.group.add(this.leaves);
    this.sync(0, 0);
  }

  private buildLeaves(): THREE.InstancedMesh<THREE.PlaneGeometry, THREE.ShaderMaterial> {
    const per = FALLING_PER_TREE + LYING_PER_TREE + PIT_PER_TREE, n = this.trees.length * per;
    const geo = new THREE.PlaneGeometry(1, 1);
    // seed: (x, z of the crown / of the pit for kind 2, kind 0 = falling / 1 = lying / 2 = in the 树池, rank 0..1); look: 3 randoms
    const a = new Float32Array(n * 4), b = new Float32Array(n * 3);
    const rnd = new Rng(20261002);
    this.trees.forEach((t, i) => {
      for (let k = 0; k < per; k++) {
        const j = i * per + k, kind = k < FALLING_PER_TREE ? 0 : k < FALLING_PER_TREE + LYING_PER_TREE ? 1 : 2;
        a.set(kind === 2 ? [t.x, t.z, 2, rnd.next()] : [t.x + t.lean[0] * 0.6, t.z, kind, rnd.next()], j * 4);
        b.set([rnd.next(), rnd.next(), rnd.next()], j * 3);
      }
    });
    geo.setAttribute('seed', new THREE.InstancedBufferAttribute(a, 4));
    geo.setAttribute('look', new THREE.InstancedBufferAttribute(b, 3));
    this.leafMat = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 }, fall: { value: 0 }, litter: { value: 0 },
        colA: { value: new THREE.Color() }, colB: { value: new THREE.Color() }, light: { value: new THREE.Color(1, 1, 1) },
        size: { value: LEAF_SIZE }, reach: { value: TREE.reach - 0.4 },
        pit: { value: PAVE.pit / 2 - PAVE.pitFrame[0] }, soilY: { value: PAVE.soilY }, trunk: { value: TREE.trunkR[0] },
      },
      vertexShader: /* glsl */ `
        attribute vec4 seed; attribute vec3 look;
        uniform float time; uniform float fall; uniform float litter; uniform float size; uniform float reach;
        uniform float pit; uniform float soilY; uniform float trunk;
        varying float vB; varying float vShade; varying vec2 vUv;
        mat3 rot(vec3 a){
          float cx = cos(a.x), sx = sin(a.x), cy = cos(a.y), sy = sin(a.y), cz = cos(a.z), sz = sin(a.z);
          return mat3(cy*cz, cy*sz, -sy, sx*sy*cz - cx*sz, sx*sy*sz + cx*cz, sx*cy, cx*sy*cz + sx*sz, cx*sy*sz - sx*cz, cx*cy);
        }
        void main(){
          bool lying = seed.z > 0.5, inPit = seed.z > 1.5;
          // the pit gathers them first and keeps them longest (swept off the paving into the soil)
          float on = step(seed.w, inPit ? min(1.0, litter * 1.6) : lying ? litter : fall);
          float ang = look.x * 6.2832, rad = reach * sqrt(look.y);
          vec3 c; vec3 r;
          if (inPit) {
            // on the soil inside the frame (edges clear of it), pushed off the trunk's foot; flatter than on the paving
            vec2 d = (look.xy - 0.5) * 2.0 * (pit - size * 0.7);
            float dl = length(d), rmin = trunk + size * 0.5;
            if (dl < rmin) d = (dl > 1e-3 ? d / dl : vec2(1.0, 0.0)) * rmin;
            c = vec3(seed.x + d.x, soilY + 0.004 + look.z * 0.006, seed.y + d.y);
            r = vec3(1.5708 + (look.z - 0.5) * 0.3, look.x * 40.0, (look.y - 0.5) * 0.25);
          } else if (lying) {
            // flat on the paving round the tree pit (outside its frame), a little tilted (curled leaves)
            float o = (pit + 0.12) / max(abs(cos(ang)), abs(sin(ang))) + 0.1 + rad;
            c = vec3(seed.x + cos(ang) * o, 0.025 + look.z * 0.01, seed.y + sin(ang) * o);
            r = vec3(1.5708 + (look.z - 0.5) * 0.5, look.x * 40.0, (look.y - 0.5) * 0.4);
          } else {
            // drop from the crown (4.2~7.5 m), flutter sideways, land, loop; each leaf on its own phase
            float speed = 0.55 + look.z * 0.35, h = 4.2 + look.y * 3.3, period = h / speed + 1.5;
            float ph = mod(time + look.x * period * 7.0, period);
            float y = max(0.03, h - ph * speed);
            float sway = sin(time * (1.3 + look.z) + look.x * 30.0) * 0.45 * min(1.0, ph * 0.5);
            c = vec3(seed.x + cos(ang) * rad + sway, y, seed.y + sin(ang) * rad + cos(time * 0.9 + look.y * 20.0) * 0.3);
            r = y > 0.04 ? vec3(time * (1.5 + look.z * 2.0) + look.x * 9.0, time * (0.8 + look.y) + look.z * 7.0, sin(time * 2.0 + look.y * 5.0)) : vec3(1.5708, look.x * 40.0, 0.0);
            // fade in at the top of the drop, gone in the last half second before the loop restarts
            on *= step(ph, period - 0.5);
          }
          vB = step(0.5, fract(look.x * 13.0 + look.y * 7.0));
          vUv = position.xy;
          vec3 p = rot(r) * vec3(position.xy * size * (0.8 + look.z * 0.5), 0.0);
          vShade = 0.85 + 0.15 * abs(normalize(rot(r) * vec3(0.0, 0.0, 1.0)).y);
          vec4 mv = viewMatrix * vec4(c + p * on, 1.0);
          // far leaves are noise at 360p: drop them past 45 m
          if (-mv.z > 45.0) mv = vec4(0.0, 0.0, 1.0, 0.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 colA; uniform vec3 colB; uniform vec3 light; varying float vB; varying float vShade; varying vec2 vUv;
        void main(){
          // a pointed leaf (lens along the quad's diagonal), not a square chip of paper
          vec2 q = vec2(vUv.x + vUv.y, vUv.x - vUv.y) * 0.7071;
          if (abs(q.y) > 0.42 * (1.0 - 2.9 * q.x * q.x)) discard;
          gl_FragColor = vec4((vB > 0.5 ? colB : colA) * light * vShade, 1.0); }`,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const m = new THREE.InstancedMesh(geo, this.leafMat, n);
    m.name = 'TREES.leaves';
    m.frustumCulled = false; // positions come from the shader
    m.renderOrder = 9;
    return m;
  }

  /** Season from the game day + chapter (data/trees.json); recomputed only when either changes. */
  sync(day: number, chapter: number): void {
    const key = `${Math.floor(day)}|${chapter}`;
    if (key === this.key) return;
    this.key = key;
    const s = this.season = seasonAt(day, chapter);
    this.u.crownA.value.setRGB(...s.crown[0]).lerp(NIGHT_GREY, 0.55).multiplyScalar(0.5);
    this.u.crownB.value.setRGB(...s.crown[1]).lerp(NIGHT_GREY, 0.55).multiplyScalar(0.5);
    this.u.turn.value = s.turn;
    this.u.fill.value = s.fill;
    const lu = this.leafMat.uniforms;
    lu.fall.value = s.fall; lu.litter.value = s.litter;
    // leaves on the ground are the turned colour, a step browner
    lu.colA.value.setRGB(...s.crown[1]).lerp(NIGHT_GREY, 0.55).multiplyScalar(0.5);
    lu.colB.value.setRGB(...s.crown[1]).lerp(new THREE.Color(0x6e5a3e), 0.4).lerp(NIGHT_GREY, 0.55).multiplyScalar(0.5);
    this.leaves.visible = s.fall > 0.001 || s.litter > 0.001;
  }

  /** Per frame: leaf motion (`time` in seconds) and the light falling on them (linear). */
  update(time: number, light: THREE.Color): void {
    this.leafMat.uniforms.time.value = time;
    this.leafMat.uniforms.light.value.copy(light);
    this.u.glow.value.copy(light).multiplyScalar(0.45);
  }
}
