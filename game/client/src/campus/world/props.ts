import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { box, type AABB } from '../../../../shared/campus/collision.ts';
import type { CampusProps, Side } from '../../../../shared/campus/campus_schema.ts';

/**
 * 室外小件 (data/campus/campus.json `props`): 分类双桶 (可回收物 + 其他垃圾 in one steel frame), 长椅 (cast concrete
 * ends, wooden slats, a back), 花坛 (a low brick box with a coping, soil and a row of clipped 黄杨). Pure parts list for
 * tests; the render is one merged vertex-coloured mesh for the whole campus (1 draw call), the collision one box per
 * thing (a bench is not for climbing onto, a 花坛 is waist-high with the shrubs).
 */
export const PROPS = {
  /** one bin (wide, deep, high), lid lip, frame post section, gap between the two bins */ bin: [0.42, 0.4, 0.74] as const, lip: 0.025, post: 0.04, gap: 0.08,
  /** 长椅: length, seat height, depth, slat section (deep, thick), back height above the seat, ends (thick) */ bench: { len: 1.8, h: 0.44, d: 0.42, slat: [0.09, 0.035], back: 0.4, end: 0.08 },
  /** 花坛: rim height, rim thickness, coping overhang, soil this far under the rim top, shrub radius, spacing */ bed: { h: 0.45, t: 0.24, cap: 0.03, soil: 0.08, r: 0.36, step: 0.7 },
};

export type PropKind = 'binA' | 'binB' | 'lid' | 'flap' | 'label' | 'frame' | 'slat' | 'fastener' | 'end' | 'brick' | 'coping' | 'soil' | 'shrub' | 'shrubD'
  | /** 监控摄像头 (world/safety.ts) */ 'camBody' | 'camLens' | 'camMount' | 'camLed'
  | /** 食堂楼后 (world/canyard.ts) */ 'slopBin' | 'slopRim' | 'slopLid' | 'slop' | 'crateR' | 'crateG' | 'greens' | 'cageFrame' | 'cageBar' | 'lock'
  | 'gasBottle' | 'gasCollar' | 'gasBand' | 'fanFrame' | 'fanHole' | 'fanBlade' | 'grease' | 'greaseD' | 'plinth' | 'fanBox' | 'fanSeam' | 'duct'
  | /** 礼堂正门 (world/hallfront.ts) */ 'porch' | 'porchSoffit' | 'porchCol' | 'porchBase' | 'hallDoor' | 'hallPanel' | 'doorGlass' | 'doorCase' | 'hallWord'
  | /** 舞台后墙 (world/hallfront.ts) */ 'dock' | 'dockEdge' | 'shutter' | 'shutterSeam' | 'shutterBox' | 'bar' | 'wellKerb' | 'grate' | 'ladder' | 'ladderPlate' | 'downpipe'
  | /** 体育馆东门 + 长立面 (world/gymfront.ts) */ 'gymGate' | 'wheel' | 'gymSign' | 'gymSignText' | 'louvre' | 'louvreHole' | 'apron';
/** A box (or, for shrubs, a squashed ball of that size): world centre and size */
export interface PropPart { kind: PropKind; c: [number, number, number]; s: [number, number, number]; /** an upright octagonal prism in the box (a 桶, a 气瓶) */ round?: true }

const COLOR: Record<PropKind, string> = {
  binA: '#4f6075', binB: '#5d5a54', lid: '#3a3936', flap: '#22211f', label: '#d9d3c4', frame: '#6c6a64',
  slat: '#93703c', fastener: '#666b65', end: '#a39d90', brick: '#94604a', coping: '#bdb5a3', soil: '#5a4c3c', shrub: '#5f6c3c', shrubD: '#535e35',
  camBody: '#d6d4cc', camLens: '#222322', camMount: '#8c8d88', camLed: '#c8302a',
  slopBin: '#3f6a8c', slopRim: '#33597a', slopLid: '#2f4f6a', slop: '#8a7a52', crateR: '#b8473a', crateG: '#4f8a52', greens: '#7ea04a',
  cageFrame: '#7d8482', cageBar: '#8f9592', lock: '#b8a050', gasBottle: '#5a8fb8', gasCollar: '#3c3e3c', gasBand: '#d9d3c4',
  fanFrame: '#9a9890', fanHole: '#1c1a17', fanBlade: '#6e6c66', grease: '#a89a7e', greaseD: '#8e7f66',
  plinth: '#a29d92', fanBox: '#b2b6b4', fanSeam: '#8a8e8c', duct: '#a9adab',
  porch: '#a7a397', porchSoffit: '#d8d2c4', porchCol: '#cbbfa6', porchBase: '#a39b8a', hallDoor: '#7e3a30', hallPanel: '#6a3028', doorGlass: '#3c4446', doorCase: '#9c8f78', hallWord: '#b8402f',
  dock: '#b3aea2', dockEdge: '#c9a447', shutter: '#b7bdbc', shutterSeam: '#7c8384', shutterBox: '#a3a9a8', bar: '#3e403e', wellKerb: '#9b968a', grate: '#2a2b29', ladder: '#5f625e', ladderPlate: '#6d726c', downpipe: '#8d8a80',
  gymGate: '#4a5a58', wheel: '#2e302e', gymSign: '#e4e0d4', gymSignText: '#3a3a38', louvre: '#7d8682', louvreHole: '#1f2221', apron: '#a9a596',
};

const FACING: Record<Side, [number, number]> = { '+x': [1, 0], '-x': [-1, 0], '+z': [0, 1], '-z': [0, -1] };

/** Boxes in a thing's own frame (u = to its right, y, w = towards its facing) put into the world at (x, z). */
function placer(out: PropPart[], x: number, z: number, facing: Side) {
  const [fx, fz] = FACING[facing], rx = -fz, rz = fx, alongX = fx === 0;
  return (kind: PropKind, u: number, y: number, w: number, su: number, sy: number, sw: number) =>
    out.push({ kind, c: [x + u * rx + w * fx, y, z + u * rz + w * fz], s: alongX ? [su, sy, sw] : [sw, sy, su] });
}

/** 分类双桶 at (x, z), the slots facing `facing`: 可回收物 (blue-grey) on the left, 其他垃圾 (grey) on the right. */
export function binParts(x: number, z: number, facing: Side): PropPart[] {
  const P = PROPS, [bw, bd, bh] = P.bin, out: PropPart[] = [], add = placer(out, x, z, facing);
  const off = (bw + P.gap) / 2, y0 = 0.06;
  for (const [s, kind] of [[1, 'binA'], [-1, 'binB']] as const) {
    const u = s * off;
    add(kind, u, y0 + bh / 2, 0, bw, bh, bd);
    add('lid', u, y0 + bh + 0.03, 0, bw + 2 * P.lip, 0.06, bd + 2 * P.lip);
    // the push flap high on the front, the printed label below it
    add('flap', u, y0 + bh - 0.12, bd / 2 + 0.004, bw * 0.62, 0.13, 0.01);
    add('label', u, y0 + bh * 0.5, bd / 2 + 0.004, bw * 0.7, 0.18, 0.008);
  }
  // the steel frame: a post at each end, a rail across the back at lid height, feet under the bins
  const half = off + bw / 2 + P.post / 2 + 0.01, top = y0 + bh + 0.1;
  for (const s of [-1, 1]) add('frame', s * half, top / 2, -bd / 2 + P.post / 2, P.post, top, P.post);
  add('frame', 0, top - P.post / 2, -bd / 2 - P.post / 2, 2 * half + P.post, P.post, P.post);
  add('frame', 0, y0 / 2, 0, 2 * half, y0, bd * 0.8);
  return out;
}

/** 长椅 at (x, z), the sitter facing `facing`. */
export function benchParts(x: number, z: number, facing: Side): PropPart[] {
  const B = PROPS.bench, out: PropPart[] = [], add = placer(out, x, z, facing);
  const [sd, st] = B.slat, ends = B.len / 2 - 0.2;
  for (const s of [-1, 1]) {
    // cast end: leg block under the seat and a back post rising from its rear
    add('end', s * ends, (B.h - st) / 2, 0, B.end, B.h - st, B.d);
    add('end', s * ends, B.h + B.back / 2, -B.d / 2 + B.end / 2, B.end, B.back, B.end);
  }
  const n = 4, pitch = (B.d - sd) / (n - 1);
  for (let i = 0; i < n; i++) {
    const w = -B.d / 2 + sd / 2 + i * pitch;
    add('slat', 0, B.h - st / 2, w, B.len, st, sd - 0.015);
    for (const s of [-1, 1]) add('fastener', s * ends, B.h + .002, w, .025, .004, .025);
  }
  for (const y of [0.16, 0.32]) {
    const w = -B.d / 2 + B.end + st / 2;
    add('slat', 0, B.h + y, w, B.len, sd, st);
    for (const s of [-1, 1]) add('fastener', s * ends, B.h + y, w + st / 2 + .002, .025, .025, .004);
  }
  return out;
}

/** 花坛: a w × d brick box centred on (x, z) (w along x), coping on the rim, soil inside, a row of shrubs along it. */
export function bedParts(x: number, z: number, w: number, d: number): PropPart[] {
  const E = PROPS.bed, out: PropPart[] = [], add = placer(out, x, z, '+z');
  const t = E.t, cy = E.h + 0.025;
  add('brick', 0, E.h / 2, d / 2 - t / 2, w, E.h, t);
  add('brick', 0, E.h / 2, -d / 2 + t / 2, w, E.h, t);
  for (const s of [-1, 1]) add('brick', s * (w / 2 - t / 2), E.h / 2, 0, t, E.h, d - 2 * t);
  add('coping', 0, cy, d / 2 - t / 2, w + 2 * E.cap, 0.05, t + 2 * E.cap);
  add('coping', 0, cy, -d / 2 + t / 2, w + 2 * E.cap, 0.05, t + 2 * E.cap);
  for (const s of [-1, 1]) add('coping', s * (w / 2 - t / 2), cy, 0, t + 2 * E.cap, 0.05, d - 2 * t);
  add('soil', 0, E.h - E.soil - 0.01, 0, w - 2 * t, 0.02, d - 2 * t);
  // clipped 黄杨 in a grid over the soil, each a little uneven (seeded by position), two greens in a checker
  const iw = w - 2 * t, id = d - 2 * t, nu = Math.max(1, Math.round(iw / E.step)), nw = Math.max(1, Math.round(id / E.step));
  for (let i = 0; i < nu; i++) for (let k = 0; k < nw; k++) {
    const q = Math.sin(x * 12.9898 + z * 78.233 + i * 37.719 + k * 11.13) * 43758.5453, j = q - Math.floor(q);
    const su = (iw / nu) * (1.15 + 0.2 * j), sw = (id / nw) * (1.15 + 0.2 * (1 - j)), sh = E.r * (1.5 + 0.5 * j);
    add((i + k) % 2 ? 'shrubD' : 'shrub', -iw / 2 + (i + 0.5) * (iw / nu), E.h - E.soil + sh / 2 - 0.06, -id / 2 + (k + 0.5) * (id / nw), su, sh, sw);
  }
  return out;
}

/** Every part of every prop on the campus. */
export function propParts(p: CampusProps | undefined): PropPart[] {
  if (!p) return [];
  return [
    ...(p.bins ?? []).flatMap(([x, z, f]) => binParts(x, z, f)),
    ...(p.benches ?? []).flatMap(([x, z, f]) => benchParts(x, z, f)),
    ...(p.beds ?? []).flatMap(([x, z, w, d]) => bedParts(x, z, w, d)),
  ];
}

/** Plan footprints (x0, x1, z0, z1) of each prop, for colliders and placement checks. */
export function propFootprints(p: CampusProps | undefined): { kind: 'bin' | 'bench' | 'bed'; x0: number; x1: number; z0: number; z1: number; h: number }[] {
  if (!p) return [];
  const span = (parts: PropPart[]) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, h = 0;
    for (const q of parts) {
      x0 = Math.min(x0, q.c[0] - q.s[0] / 2); x1 = Math.max(x1, q.c[0] + q.s[0] / 2);
      z0 = Math.min(z0, q.c[2] - q.s[2] / 2); z1 = Math.max(z1, q.c[2] + q.s[2] / 2);
      h = Math.max(h, q.c[1] + q.s[1] / 2);
    }
    return { x0, x1, z0, z1, h };
  };
  return [
    ...(p.bins ?? []).map(([x, z, f]) => ({ kind: 'bin' as const, ...span(binParts(x, z, f)) })),
    ...(p.benches ?? []).map(([x, z, f]) => ({ kind: 'bench' as const, ...span(benchParts(x, z, f)) })),
    ...(p.beds ?? []).map(([x, z, w, d]) => ({ kind: 'bed' as const, ...span(bedParts(x, z, w, d).filter(q => q.kind !== 'shrub' && q.kind !== 'shrubD')), h: PROPS.bed.h + 0.5 })),
  ];
}

/** One box per prop: bins and benches their full height, a 花坛 rim + shrubs. */
export function propColliders(p: CampusProps | undefined): AABB[] {
  return propFootprints(p).map(f => box((f.x0 + f.x1) / 2, (f.z0 + f.z1) / 2, f.x1 - f.x0, f.z1 - f.z0, f.h));
}

/** A clipped shrub: a low-poly ball squashed to its box, each vertex pushed in or out by a hash of where it is
 * (the same corner moves the same way on every face, so no cracks): reads as a lumpy hedge, not a loaf. */
function lumpy(q: PropPart): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(0.5, 1), p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const h = Math.sin(x * 91.7 + y * 47.3 + z * 63.1 + q.c[0] * 3.1 + q.c[2] * 1.7) * 43758.5453, k = 0.8 + 0.32 * (h - Math.floor(h));
    // flatter underneath (sits in the soil), clipped flat-ish on top
    p.setXYZ(i, x * k, Math.min(y * k, 0.42), z * k);
  }
  g.scale(...q.s);
  g.computeVertexNormals();
  return g;
}

/** All props (and `extra` parts: the outdoor cameras, world/safety.ts) as one merged, vertex-coloured geometry (null when there are none). */
export function propGeometry(p: CampusProps | undefined, extra: PropPart[] = []): THREE.BufferGeometry | null {
  const parts = [...propParts(p), ...extra];
  if (!parts.length) return null;
  const cols = Object.fromEntries(Object.entries(COLOR).map(([k, v]) => [k, new THREE.Color(v)])) as Record<PropKind, THREE.Color>;
  const geos = parts.map(q => {
    const shrub = q.kind === 'shrub' || q.kind === 'shrubD';
    // a shrub: a low-poly ball squashed to its box, so the clipped hedge reads as lumps, not a block
    // a shrub's icosahedron is already non-indexed (toNonIndexed would warn)
    const g0 = shrub ? lumpy(q) : q.round ? new THREE.CylinderGeometry(0.5, 0.5, 1, 8).scale(...q.s) : new THREE.BoxGeometry(...q.s);
    const g = g0.index ? g0.toNonIndexed() : g0;
    g.translate(...q.c);
    const c = cols[q.kind].clone(), n = g.getAttribute('position').count, col = new Float32Array(n * 3);
    // A few old timber tones keep the low-poly slats distinct, without a texture or another material/draw call.
    if (q.kind === 'slat') {
      const seed = Math.sin(q.c[0] * 12.9898 + q.c[1] * 34.17 + q.c[2] * 78.233) * 43758.5453;
      c.multiplyScalar(.84 + (seed - Math.floor(seed)) * .22);
    }
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.deleteAttribute('uv');
    return g;
  });
  return mergeGeometries(geos)!;
}
