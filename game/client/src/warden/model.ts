// 角色074: code-generated SkinnedMesh (design.md「角色074形象与形态」). Pure code, no model files.
// Built facing +Z in bind pose (arms hanging), then turned π inside `root` so it faces -Z like the game's yaw.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { faceTexture, makeMaterials } from './textures.ts';
import { POSTURE, UPRIGHT, WardenAnimator } from './anim.ts';

const SMILES: THREE.Texture[] = [];

export const BONES = [
  'hips', 'spine', 'chest', 'neck', 'head', 'jaw', 'glasses',
  'shoulderL', 'upperArmL', 'foreArmL', 'handL', 'fingersL', 'fingers2L', 'shoulderR', 'upperArmR', 'foreArmR', 'handR', 'fingersR', 'fingers2R',
  'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR', 'bag',
] as const;
export type BoneName = typeof BONES[number];
export const MATS = ['face', 'skin', 'jacket', 'sleeve', 'pants', 'shoe', 'frame', 'lens', 'metal', 'lapel'] as const;
export type MatName = typeof MATS[number];

type V3 = [number, number, number];
// bone → [parent, rest position in model space]; his left = +X
const REST: Record<BoneName, [BoneName | null, V3]> = {
  hips: [null, [0, 0.95, 0]], spine: ['hips', [0, 1.1, 0]], chest: ['spine', [0, 1.28, 0]],
  neck: ['chest', [0, 1.48, 0]], head: ['neck', [0, 1.57, 0]], jaw: ['head', [0, 1.6, 0.04]], glasses: ['head', [0, 1.683, 0.13]],
  shoulderL: ['chest', [0.08, 1.44, 0]], upperArmL: ['shoulderL', [0.25, 1.42, 0]], foreArmL: ['upperArmL', [0.257, 1.15, 0]], handL: ['foreArmL', [0.277, 0.9, 0.01]], fingersL: ['handL', [0.278, 0.842, 0.012]], fingers2L: ['fingersL', [0.278, 0.802, 0.012]],
  shoulderR: ['chest', [-0.08, 1.44, 0]], upperArmR: ['shoulderR', [-0.25, 1.42, 0]], foreArmR: ['upperArmR', [-0.257, 1.15, 0]], handR: ['foreArmR', [-0.277, 0.9, 0.01]], fingersR: ['handR', [-0.278, 0.842, 0.012]], fingers2R: ['fingersR', [-0.278, 0.802, 0.012]],
  thighL: ['hips', [0.1, 0.92, 0]], shinL: ['thighL', [0.1, 0.51, 0]], footL: ['shinL', [0.1, 0.09, 0]],
  thighR: ['hips', [-0.1, 0.92, 0]], shinR: ['thighR', [-0.1, 0.51, 0]], footR: ['shinR', [-0.1, 0.09, 0]],
  bag: ['hips', [-0.245, 0.99, 0]], // sling-bag pivot where the strap ends: the bag hangs (and swings) from here
};
export const EYE_Y = 1.683;

type Weigher = (p: THREE.Vector3) => [BoneName, number][];
const bn = (n: string) => n as BoneName;
const rigid = (b: BoneName): Weigher => () => [[b, 1]];
/** Blend along y between consecutive (bone, height) stops; outside the stops the end bone takes all. */
export function chain(...stops: [BoneName, number][]): Weigher {
  return (p) => {
    for (let i = 0; i < stops.length - 1; i++) {
      const [a, ya] = stops[i], [b, yb] = stops[i + 1];
      const t = (p.y - ya) / (yb - ya);
      if (t <= 1 || i === stops.length - 2) {
        const c = Math.min(1, Math.max(0, t));
        return c <= 0 ? [[a, 1]] : c >= 1 ? [[b, 1]] : [[a, 1 - c], [b, c]];
      }
    }
    return [[stops[0][0], 1]];
  };
}

const TORSO: [number, number][] = [[0.198, 0.8], [0.205, 0.86], [0.212, 0.95], [0.214, 1.05], [0.2, 1.15], [0.2, 1.25], [0.21, 1.33], [0.205, 1.4], [0.155, 1.46], [0.07, 1.5]];
/** Body build: 角色074 (paunchy, stooped, hooded jacket + sling bag) or the 无脸值日生 (flat-chested, straight-backed, tall and thin, nothing but a shirt). */
export type Build = 'warden' | 'student' | 'monitor';
const BODY = {
  warden: { sx: 1.14, sz: 0.74, curves: true, gear: true, scale: [1, 1, 1] as V3, posture: POSTURE },
  student: { sx: 1.14, sz: 0.74, curves: true, gear: true, scale: [1, 1, 1] as V3, posture: POSTURE },
  monitor: { sx: 1.0, sz: 0.62, curves: false, gear: false, scale: [0.9, 1.1, 0.9] as V3, posture: UPRIGHT }, // ~1.9 m, narrow: a schoolboy stretched too tall
};
let body = BODY.warden; // the build being generated (buildWardenGeometry sets it; the helpers below read it)
const belly = (y: number) => { const t = (y - 1.02) / 0.16; return 1 + 0.15 * Math.exp(-t * t); }; // middle-aged paunch, front only
/** Rounded upper back (kyphosis), back only: reads as a stoop in profile even before the POSTURE lean. */
export const hump = (y: number) => { const t = (y - 1.36) / 0.1; return 1 + 0.3 * Math.exp(-t * t); };
const depth = (y: number, z: number) => body.sz * (!body.curves ? 1 : z > 0 ? belly(y) : hump(y));
function torsoR(y: number) {
  for (let i = 0; i < TORSO.length - 1; i++) {
    const [r0, y0] = TORSO[i], [r1, y1] = TORSO[i + 1];
    if (y <= y1) return r0 + (r1 - r0) * Math.max(0, (y - y0) / (y1 - y0));
  }
  return TORSO[TORSO.length - 1][0];
}
/** Point just off the jacket surface at (x, y) on the front (side 1) or back (side -1). */
function onTorso(x: number, y: number, side: 1 | -1, off = 0.012) {
  const r = torsoR(y), rx = r * body.sx, rz = r * depth(y, side);
  return new THREE.Vector3(x, y, side * (rz * Math.sqrt(Math.max(0, 1 - (x / rx) ** 2)) + off));
}

function xf(g: THREE.BufferGeometry, t: V3, s: V3 = [1, 1, 1], r: V3 = [0, 0, 0]) {
  return g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(...t), new THREE.Quaternion().setFromEuler(new THREE.Euler(...r)), new THREE.Vector3(...s)));
}
/** Finger segment: a capsule from a to b. */
function phal(a: THREE.Vector3, b: THREE.Vector3, r: number) {
  const d = b.clone().sub(a), g = new THREE.CapsuleGeometry(r, Math.max(0.001, d.length() - r), 1, 5);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  return g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
}
function rod(a: THREE.Vector3, b: THREE.Vector3, r: number, seg = 5, r1 = r) { // r1 = radius at b (tapered when different)
  const d = b.clone().sub(a), g = new THREE.CylinderGeometry(r1, r, d.length(), seg, 1);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  return g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
}
const lathe = (pts: [number, number][], seg: number, phiStart = 0) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg, phiStart);
function mapPos(g: THREE.BufferGeometry, f: (v: THREE.Vector3) => void) {
  const p = g.attributes.position as THREE.BufferAttribute, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) { f(v.fromBufferAttribute(p, i)); p.setXYZ(i, v.x, v.y, v.z); }
  g.computeVertexNormals();
  return g;
}
/** All body parts merged into one geometry with one group per MATS entry, skinned to BONES. */
export function buildWardenGeometry(claws = true, build: Build = 'warden') {
  body = BODY[build];
  const byMat = new Map<MatName, THREE.BufferGeometry[]>();
  const add = (mat: MatName, g: THREE.BufferGeometry, w: Weigher) => {
    const pos = g.attributes.position, n = pos.count, si = new Uint16Array(n * 4), sw = new Float32Array(n * 4), v = new THREE.Vector3();
    for (let i = 0; i < n; i++) w(v.fromBufferAttribute(pos, i)).forEach(([b, x], k) => { si[i * 4 + k] = BONES.indexOf(b); sw[i * 4 + k] = x; });
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    byMat.set(mat, [...(byMat.get(mat) ?? []), g]);
  };
  const torsoW = chain(['hips', 0.98], ['spine', 1.1], ['spine', 1.18], ['chest', 1.28]);

  // jacket body: phiStart π puts the front (phi 2π) at u = 0.5 of the jacket texture (zip V, folds, pockets)
  add('jacket', mapPos(lathe(TORSO, 24, Math.PI), (v) => { v.x *= body.sx; v.z *= depth(v.y, v.z); }), torsoW);
  // ribbed hem band: a straight knit cuff (fine vertical ribs) closing the jacket's open bottom edge
  const hemP: [number, number][] = [[-0.03, 0.792], [0.006, 0.795], [0.008, 0.82], [0.008, 0.845], [0.001, 0.852]];
  add('sleeve', mapPos(new THREE.LatheGeometry(hemP.map(([o, y]) => new THREE.Vector2(torsoR(y) + o, y)), 48), (v) => {
    const k = 1 + (v.y > 0.794 && v.y < 0.85 ? 0.012 * Math.cos(Math.atan2(v.x, v.z) * 24) : 0);
    v.x *= body.sx * k; v.z *= depth(v.y, v.z) * k;
  }), rigid('hips'));
  // open zip: two lapels folded back along the V of the T-shirt, raised along the fold so they have visible thickness
  for (const side of [1, -1] as const) {
    const at = (th: number, y: number, off: number) => { const r = torsoR(y) + off; return new THREE.Vector3(r * body.sx * Math.sin(th), y, r * depth(y, 1) * Math.cos(th)); };
    const tri: THREE.Vector3[] = [], N = 8;
    for (let i = 0; i < N; i++) {
      const row = (j: number) => { const t = j / N, y = 1.255 + 0.2 * t, e = side * (0.03 + 0.6 * t), w = side * (0.04 + 0.32 * t);
        return [at(e, y, 0.003), at(e + side * 0.02, y, 0.032), at(e + w, y, 0.012)]; }; // torso at the fold, fold crest (~3 cm proud), outer edge flush
      const [a0, b0, c0] = row(i), [a1, b1, c1] = row(i + 1);
      for (const q of [[a0, b0, b1, a1], [b0, c0, c1, b1]]) tri.push(q[0], q[1], q[2], q[0], q[2], q[3], q[0], q[2], q[1], q[0], q[3], q[2]); // both windings: one always faces the camera
    }
    const lap = new THREE.BufferGeometry().setFromPoints(tri);
    lap.setIndex(tri.map((_, i) => i)).computeVertexNormals();
    lap.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(tri.length * 2), 2)); // merge needs matching attributes
    add('lapel', lap, torsoW); // a shade lighter than the jacket so the open front reads as two layers
  }
  add('sleeve', xf(new THREE.TorusGeometry(0.085, 0.026, 6, 16), [0, 1.485, -0.005], [1, 0.9, 1], [Math.PI / 2, 0, 0]), rigid('chest')); // collar
  add('pants', mapPos(lathe([[0.18, 0.76], [0.175, 0.84], [0.16, 0.92]], 16), (v) => { v.x *= body.sx; v.z *= body.sz; }), rigid('hips')); // waist stays inside the jacket hem (was z-fighting into a jagged edge)
  if (body.gear) { // 角色074's hood and sling bag pants waist band over the jacket hem
    // hood lying flat on the upper back: a back-half lathe shell hugging the torso, thickest at the fold, pleated lower hem
    const hoodP: [number, number][] = [[0.004, 1.25], [0.035, 1.27], [0.07, 1.35], [0.09, 1.43]]; // bottom → top: outward faces; the top tapers to the torso under the rolled collar (a taller shell stood up behind the head and showed as a black ribbon when the chase lean pitched him forward)
    const hood = new THREE.LatheGeometry(hoodP.map(([o, y]) => new THREE.Vector2(torsoR(y) + 0.012 + o, y)), 12, Math.PI - 0.95, 1.9);
    add('sleeve', mapPos(hood, (v) => {
      const phi = Math.atan2(v.x, -v.z), edge = 1 - Math.abs(phi) / 0.95; // 1 at the spine, 0 at the hood's sides
      if (v.y < 1.36) v.y += (0.014 * Math.sin(phi * 9) - 0.02 * edge) * (1.36 - v.y) / 0.085; // folds + sags lowest in the middle
      v.x *= body.sx; v.z *= depth(v.y, v.z);
    }), rigid('chest'));

    // sling-bag strap: bag top (back) → over the left shoulder → bag top (front), metal buckle on the chest.
    // stands a webbing-width off the jacket (was half buried in it) and bridges the paunch in a straight pull down to the bag
    const front: THREE.Vector3[] = [], back: THREE.Vector3[] = [];
    for (let i = 0; i <= 10; i++) { // front lies on the chest/paunch curve (clear of the lapel crests), leaves the body just above the bag
      const s = i / 10, x = 0.12 - 0.25 * s, y = 1.44 - 0.36 * s;
      // front pulled taut: straight shoulder → bag line, only lifted where the chest/paunch would poke through it (no waving over folds)
      const t = new THREE.Vector3(0.12, 1.44, onTorso(0.12, 1.44, 1, 0.03).z).lerp(new THREE.Vector3(-0.255, 0.985, 0.07), 0.88 * (0.6 * s + 0.4 * s * s * (3 - 2 * s))); // eased ends = small arcs at the shoulder and the bag
      t.z = Math.max(t.z, onTorso(t.x, t.y, 1, 0.03).z + 0.012 * Math.sin(Math.PI * Math.min(1, s * 5))); // 3 cm off the body, bowed out where it leaves the shoulder (lapel crest)
      front.push(t); back.unshift(onTorso(x, y, -1, 0.022 + 0.03 * s * s));
    }
    const strap = new THREE.CatmullRomCurve3([new THREE.Vector3(-0.255, 0.985, -0.07), ...back, new THREE.Vector3(0.12, 1.5, 0), ...front, new THREE.Vector3(-0.255, 0.985, 0.07)]);
    const strapW: Weigher = (p) => { // lower ends ride on the bag so they follow its swing
      const k = Math.min(1, Math.max(0, (1.09 - p.y) / 0.09));
      return k <= 0 ? torsoW(p) : [...torsoW(p).map(([b, w]) => [b, w * (1 - k)] as [BoneName, number]), ['bag', k]];
    };
    add('pants', new THREE.TubeGeometry(strap, 40, 0.011, 4), strapW); // navy webbing: reads against the black jacket
    const bk = onTorso(0.015, 1.265, 1, 0.032);
    add('metal', xf(new THREE.BoxGeometry(0.04, 0.03, 0.008), [bk.x, bk.y, bk.z], [1, 1, 1], [0, 0, 0.6]), rigid('chest'));
    // the hood's opening rolled up round the neck: a thick fold wrapping back and sides, its two ends meeting under the chin
    // (visible from the front as the hood bunched at both sides of the collar)
    add('sleeve', xf(new THREE.TorusGeometry(0.11, 0.032, 5, 12, Math.PI * 1.6), [0, 1.5, -0.02], [1.05, 1, 0.95], [Math.PI / 2, 0, Math.PI * 0.7]), rigid('chest'));
    // drawstrings hanging from eyelets at the hood opening, a slight swing out, aglets at the tips
    for (const side of [1, -1] as const) {
      const top = onTorso(side * 0.055, 1.47, 1, 0.02), mid = onTorso(side * 0.06, 1.38, 1, 0.026), tip = onTorso(side * 0.052, 1.27, 1, 0.024);
      add('metal', xf(new THREE.TorusGeometry(0.009, 0.003, 3, 6), [top.x, top.y, top.z]), rigid('chest')); // eyelet
      // thick cord with a gentle S-curve (bowing out at the middle, swinging back toward the tip), fat aglet
      const out = new THREE.Vector3(side * 0.012, 0, 0.01);
      add('lapel', new THREE.TubeGeometry(new THREE.CatmullRomCurve3([top, mid.clone().add(out), tip.clone().addScaledVector(out, -0.4)]), 8, 0.012, 5), rigid('chest'));
      add('metal', rod(tip, tip.clone().add(new THREE.Vector3(0, -0.03, 0.002)), 0.0135), rigid('chest'));
    }
    // the bag itself: a curved kidney-shaped band (crescent) hugging the hip, rounded ends
    const bagCurve = new THREE.CatmullRomCurve3([[-0.25, 0.95, -0.11], [-0.31, 0.9, -0.05], [-0.32, 0.89, 0.03], [-0.29, 0.93, 0.11]].map(([x, y, z]) => new THREE.Vector3(x, y, z)));
    add('sleeve', mapPos(new THREE.TubeGeometry(bagCurve, 16, 0.05, 10), (v) => { v.y += (v.y - 0.91) * 0.6; }), rigid('bag'));
    for (const t of [0, 1]) { const e = bagCurve.getPoint(t); add('sleeve', xf(new THREE.SphereGeometry(1, 10, 8), [e.x, e.y, e.z], [0.05, 0.08, 0.05]), rigid('bag')); } // rounded ends
  }

  const earBox: Record<number, THREE.Box3> = {};
  for (const side of [1, -1] as const) {
    const S = side > 0 ? 'L' : 'R';
    // slimmer sleeve tapering into a sloped trapezius instead of a ball joint
    // muscled sleeve: wrist cuff → forearm swell → pinched elbow with a bunched fold → biceps/deltoid bulge → shoulder
    const sleeve = lathe([[0.037, 0.93], [0.04, 0.96], [0.05, 1.02], [0.053, 1.06], [0.047, 1.11], [0.038, 1.145], [0.046, 1.17], [0.043, 1.19],
      [0.05, 1.24], [0.058, 1.3], [0.06, 1.35], [0.058, 1.39], [0.048, 1.435], [0.022, 1.462]], 12);
    const bulge = (y: number, c: number, w: number) => Math.exp(-(((y - c) / w) ** 2));
    add('sleeve', mapPos(sleeve, (v) => {
      v.z *= v.z > 0 ? 1 + 0.2 * bulge(v.y, 1.3, 0.07) : 1 + 0.12 * bulge(v.y, 1.3, 0.07) + 0.4 * bulge(v.y, 1.165, 0.035); // biceps forward, bony elbow point backward
      v.z -= 0.025 * Math.min(1, Math.max(0, (v.y - 1.0) / 0.2)); // upper arm sits behind the forearm: the arm is bent at the elbow, not a ruler
      v.x += side * (0.228 + (1.44 - v.y) * 0.08);
    }), chain([bn(`foreArm${S}`), 1.135], [bn(`upperArm${S}`), 1.165], [bn(`upperArm${S}`), 1.39], [bn(`shoulder${S}`), 1.46])); // short blend: the elbow turns a corner
    const sh = bn(`shoulder${S}`);
    add('sleeve', xf(new THREE.SphereGeometry(1, 12, 8), [side * 0.155, 1.448, -0.012], [0.105, 0.036, 0.07], [0, 0, -side * 0.33]), (p) => {
      const k = Math.min(1, Math.max(0, (Math.abs(p.x) - 0.09) / 0.12));
      return k <= 0 ? [['chest', 1]] : k >= 1 ? [[sh, 1]] : [['chest', 1 - k], [sh, k]];
    }); // trapezius: neck → shoulder slope
    // hand: a rounded-box palm (twice as wide as thick, narrowing to the wrist), a wrist cylinder 2 cm up inside the cuff, four 3-segment tapered
    // fingers with ball knuckles (proximal on `fingers`, middle + distal on `fingers2`: they curl in two stages), a 2-segment thumb at 45° from the heel
    const hd = bn(`hand${S}`), fg = bn(`fingers${S}`), fg2 = bn(`fingers2${S}`), V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    const sx = side * 0.278, ball = (c: THREE.Vector3, r: number, dx = 0) => xf(new THREE.SphereGeometry(r, 5, 3), [c.x + dx, c.y, c.z]);
    const sq = (a: number) => Math.sign(a) * Math.abs(a) ** 0.5; // squircle: sphere → rounded box
    add('skin', mapPos(new THREE.SphereGeometry(1, 10, 6), (v) => {
      const y = 0.884 + sq(v.y) * 0.049, t = (y - 0.835) / 0.098; // t: 0 at the knuckles, 1 at the wrist
      v.set(sx + sq(v.x) * 0.02, y, 0.012 + sq(v.z) * 0.043 * (1 - 0.25 * t));
    }), rigid(hd));
    add('skin', mapPos(lathe([[0.03, 0.87], [0.0295, 0.91], [0.0285, 0.952]], 8), (v) => { v.x += side * 0.274; v.z *= 1.15; }), rigid(hd)); // wrist runs ~2 cm up inside the cuff (opens at y 0.93)
    add('skin', xf(new THREE.SphereGeometry(1, 6, 4), [sx - side * 0.003, 0.885, 0.036], [0.013, 0.03, 0.017], [0, 0, side * 0.2]), rigid(hd)); // thenar pad under the thumb
    add('sleeve', xf(new THREE.TorusGeometry(0.039, 0.0075, 5, 12), [side * 0.269, 0.934, 0], [1, 1, 1], [Math.PI / 2, 0, 0]), rigid(bn(`foreArm${S}`))); // rolled cuff hem: gives the opening thickness
    add('skin', ball(V(sx, 0.93, -0.014), 0.0115, side * 0.018), rigid(hd)); // ulnar styloid: the bony knob on the wrist
    const t0 = V(sx - side * 0.004, 0.9, 0.04), t1 = t0.clone().addScaledVector(V(-side * 0.45, -0.6, 0.66).normalize(), 0.036);
    const t2 = t1.clone().addScaledVector(V(-side * 0.6, -0.45, 0.66).normalize(), 0.03);
    add('skin', rod(t0, t1, 0.0125, 6, 0.0112), rigid(hd)); add('skin', ball(t1, 0.0112), rigid(hd)); // thumb
    add('skin', rod(t1, t2, 0.0112, 6, 0.0088), rigid(hd)); add('skin', ball(t2, 0.0088), rigid(hd));
    for (let k = 0; k < 4; k++) {
      const f = 1.5 - k, len = [0.92, 1, 0.94, 0.76][k], p0 = V(sx, 0.842, 0.012 + f * 0.02);
      const c1 = [0.0, 0.08, 0.16, 0.28][k], c2 = [0.1, 0.2, 0.3, 0.4][k]; // static per-finger extra curl (index straightest, pinky most curled) toward -side
      const dir = (a: number) => V(-side * Math.sin(a), -Math.cos(a), 0);
      const p1 = p0.clone().add(V(0, -0.04, 0)), p2 = p1.clone().add(dir(c1).multiplyScalar(0.028 * len)), p3 = p2.clone().add(dir(c1 + c2).multiplyScalar(0.024 * len)); // proximal length is fixed: `fingers2` pivots at y 0.802
      add('skin', ball(p0, 0.0115, side * 0.004), rigid(hd)); // knuckle on the back of the hand
      add('skin', rod(p0, p1, 0.0105, 6, 0.0095), rigid(fg)); add('skin', ball(p1, 0.0098, side * 0.003), rigid(fg));
      add('skin', rod(p1, p2, 0.0095, 6, 0.0085), rigid(fg2)); add('skin', ball(p2, 0.0087, side * 0.002), rigid(fg2));
      add('skin', rod(p2, p3, 0.0085, 6, 0.0066), rigid(fg2)); add('skin', ball(p3, 0.0066), rigid(fg2));
      if (claws) add('shoe', rod(p3, p3.clone().add(V(0, -0.016, 0)), 0.0068, 4, 0.0008), rigid(fg2)); // claw (the students' shoe material is white: none for them)
    }
    // one continuous trouser tube with real contours: flared hem, calf muscle, kneecap + dented hollow behind it, quad sweep into the hip
    const prof = new THREE.SplineCurve([[0.052, 0.06], [0.06, 0.1], [0.062, 0.18], [0.066, 0.27], [0.06, 0.38], [0.057, 0.46], [0.064, 0.51], [0.075, 0.58], [0.088, 0.68], [0.097, 0.78], [0.1, 0.86], [0.1, 0.94]]
      .map(([r, y]) => new THREE.Vector2(r, y))).getPoints(16);
    const gauss = (y: number, c: number, w: number) => Math.exp(-(((y - c) / w) ** 2));
    const leg = mapPos(new THREE.LatheGeometry(prof, 12), (v) => {
      const k = 1 + (body.curves ? 0.2 : 0) * (1 - Math.min(1, Math.max(0, (v.y - 0.55) / 0.35))); v.x *= k; v.z *= k; // sturdier below the hip (stick legs under a bulky jacket read as a toy)
      v.z *= v.z < 0 ? 1 + 0.3 * gauss(v.y, 0.27, 0.09) - 0.1 * gauss(v.y, 0.5, 0.05) : 1 + 0.18 * gauss(v.y, 0.5, 0.045) + 0.1 * gauss(v.y, 0.72, 0.12);
      v.z += v.y < 0.5 ? -0.014 * Math.sin(Math.PI * Math.min(1, Math.max(0, (v.y - 0.1) / 0.4))) : 0.012 * Math.sin(Math.PI * (v.y - 0.5) / 0.44); // calf swells back, thigh bows forward
    });
    add('pants', leg.translate(side * 0.1, 0, 0), chain([bn(`shin${S}`), 0.4], [bn(`thigh${S}`), 0.62], [bn(`thigh${S}`), 0.85], ['hips', 0.93]));
    add('shoe', mapPos(xf(new THREE.SphereGeometry(1, 12, 8), [side * 0.1, 0.045, 0.035], [0.062, 0.048, 0.13]), (v) => { v.y = Math.max(v.y, 0.003); }), rigid(bn(`foot${S}`)));
    // ear: a thin oval plate (8.4 cm) with a raised helix rim, a lower antihelix ring and a sunken concha bowl, narrowing to the lobe;
    // its front edge sinks into the head, the back flares out and the top leans back (the old ellipsoid read as a bead)
    if (body.gear) {
      const ear = xf(mapPos(new THREE.SphereGeometry(1, 10, 7).rotateZ(Math.PI / 2), (v) => {
        const q = Math.hypot(v.y, v.z), th = 0.008;
        v.x = v.x > 0 ? th * (q > 0.9 ? 1 : q > 0.6 ? 0.5 : q - 0.25) : -th * (q > 0.9 ? 0.4 : 1);
        v.z *= 0.024 * (v.y < 0 ? 1 + 0.35 * v.y : 1); v.y *= 0.042;
        v.x *= side; v.z *= side; // the right ear is the left one turned 180° (a mirror would flip its faces inside out)
      }), [side * 0.118, 1.648, -0.008], [1, 1, 1], [-0.15, -side * 0.3, 0]);
      ear.computeBoundingBox(); earBox[side] = ear.boundingBox!.clone(); // the temples are measured against it
      add('skin', ear, rigid('head'));
    }
  }

  // neck: a column from inside the head down into the collar; the sternocleidomastoid ridges run diagonally from behind the ear
  // (back of the jaw) down and forward to beside the throat, with the throat a little hollow between them
  add('skin', mapPos(lathe([[0.1, 1.43], [0.086, 1.47], [0.078, 1.5], [0.074, 1.54], [0.072, 1.58], [0.07, 1.62]], 18), (v) => {
    const t = Math.min(1, Math.max(0, (v.y - 1.48) / 0.12)), a = Math.atan2(Math.abs(v.x), v.z); // a: 0 = throat, π = nape
    const r = 1 + 0.13 * Math.exp(-(((a - 0.45 - 1.5 * t) / 0.3) ** 2)) - 0.1 * t * Math.exp(-((a / 0.4) ** 2));
    v.x *= r; v.z *= r;
  }), chain(['neck', 1.47], ['head', 1.6]));
  // bald head: a lathe through stations chin → crown, each an oval ring [y, front z, back z, half width] round C (front half
  // flattened into a face plane); below the mouth the back rises into the jaw's underside, so the chin and jaw line stand clear
  // of the neck. Then mirrored facial structure on the front: [|x|, y, width x, width y, out x, out z]. Face drawn in its
  // texture (equirect round C: u 0.25 = +Z front), its v recomputed from the final shape so the paint lands in the sockets.
  const C = new THREE.Vector3(0, 1.65, 0.005);
  const HEAD = [[-0.12, 0.085, 0.08, 0], [-0.114, 0.1, 0.072, 0.03], [-0.102, 0.115, 0.055, 0.05], [-0.087, 0.115, 0.025, 0.07], // chin
    [-0.072, 0.11, -0.012, 0.088], [-0.06, 0.112, -0.045, 0.094], [-0.045, 0.121, -0.085, 0.102], [-0.027, 0.12, -0.108, 0.113], // jaw angle, mouth
    [-0.012, 0.117, -0.118, 0.12], [0, 0.115, -0.124, 0.123], [0.012, 0.114, -0.128, 0.124], [0.022, 0.115, -0.13, 0.124], // cheekbones, eyes
    [0.033, 0.118, -0.131, 0.124], [0.045, 0.116, -0.131, 0.123], [0.062, 0.111, -0.128, 0.118], [0.085, 0.098, -0.118, 0.105], // brow, forehead
    [0.105, 0.075, -0.1, 0.085], [0.12, 0.04, -0.07, 0.05], [0.126, 0, -0.02, 0]]; // crown
  const FACE = [[0.04, 0.034, 0.03, 0.01, 0, 0.006], [0, 0.031, 0.016, 0.012, 0, 0.004], // brow ridge, glabella
    [0.045, 0.013, 0.019, 0.012, 0, -0.011], // eye sockets: ~9 mm behind the brow and cheek
    [0.074, -0.012, 0.024, 0.013, 0.008, 0.006], [0.066, -0.042, 0.022, 0.016, -0.008, -0.004], // cheekbones, the hollow under them
    [0.108, 0.048, 0.02, 0.025, -0.006, 0], [0.086, -0.072, 0.014, 0.012, 0.006, 0], // temples, jaw angle
    [0, -0.04, 0.02, 0.009, 0, 0.004], [0, -0.06, 0.018, 0.008, 0, -0.004]]; // lips, the crease under them
  const head = mapPos(lathe(HEAD.map(([y]) => [1, y]), 28, -Math.PI / 2), (v) => { // unit rings: v.x = sin φ, v.z = cos φ
    const [y, zf, zb, wx] = HEAD.reduce((a, s) => (Math.abs(s[0] - v.y) < Math.abs(a[0] - v.y) ? s : a));
    v.set(wx * v.x, y, (zf + zb) / 2 + ((zf - zb) / 2) * (v.z > 0 ? v.z ** 0.75 : v.z));
    const w = Math.min(1, Math.max(0, (v.z + 0.03) / 0.06)), ax = Math.abs(v.x);
    if (body.gear) for (const [x0, y0, sx, sy, ox, oz] of FACE) {
      const g = w * Math.exp(-(((ax - x0) / sx) ** 2 + ((v.y - y0) / sy) ** 2));
      v.x += Math.sign(v.x) * ox * g; v.z += oz * g;
    }
    v.add(C);
  });
  const hp = head.attributes.position, huv = head.attributes.uv, d = new THREE.Vector3();
  for (let i = 0; i < hp.count; i++) { d.fromBufferAttribute(hp, i).sub(C); huv.setY(i, 1 - Math.acos(d.y / d.length()) / Math.PI); }
  add('face', head, (p) => (p.y < 1.61 && p.z > 0.04 ? [['head', 0.5], ['jaw', 0.5]] : [['head', 1]]));
  if (body.gear) { // the 值日生 has no face: no glasses, no nose
    // glasses: thin light-gold rims bent to follow the brow/cheek contour (2 mm off the skin), reflective lenses, nose pads on the
    // nasal root and temples that run back along the side of the head to the top of the ear, then hook 15 mm down behind it
    const faceMesh = new THREE.Mesh(head, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })), ray = new THREE.Raycaster();
    const hit = (o: V3, d: V3) => { ray.set(new THREE.Vector3(...o), new THREE.Vector3(...d)); return ray.intersectObject(faceMesh)[0].point; };
    const faceZ = (x: number, y: number) => hit([x, y, 0.4], [0, 0, -1]).z;
    const flankX = (side: number, y: number, z: number) => hit([side * 0.4, y, z], [-side, 0, 0]).x;
    const GAP = 0.002, ringR = 0.025, V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    for (const side of [1, -1] as const) {
      const cx = side * 0.043;
      let shift = 0, n = 0;
      const ring = mapPos(new THREE.TorusGeometry(ringR, 0.0018, 3, 14).translate(cx, EYE_Y, 0), (v) => {
        const dz = faceZ(v.x, v.y) + GAP; v.z += dz; shift += dz; n++;
      });
      add('frame', ring, rigid('glasses'));
      // domed lens (cap of a 6 cm sphere): the curvature catches a specular glint from the flashlight at most angles
      const cap = new THREE.SphereGeometry(0.06, 10, 2, 0, Math.PI * 2, 0, Math.asin(0.024 / 0.06)).rotateX(Math.PI / 2);
      add('lens', cap.translate(cx, EYE_Y, shift / n - 0.001 - 0.06 * Math.cos(Math.asin(0.024 / 0.06))), rigid('glasses'));
      // nose pad: a small plate on the side of the nasal root, joined to the rim's inner edge
      const px = side * 0.0105, py = EYE_Y - 0.01, pz = faceZ(px, py) + 0.0015, ix = side * (0.043 - ringR);
      add('frame', xf(new THREE.SphereGeometry(1, 4, 3), [px, py, pz], [0.0014, 0.0045, 0.0025]), rigid('glasses'));
      add('frame', rod(V(px, py + 0.003, pz), V(ix, EYE_Y, faceZ(ix, EYE_Y) + GAP), 0.0013, 4), rigid('glasses'));
      // temple: hinge on the rim's outer edge, level back along the flank to the top of the ear (ear mesh bounds), then hooked down behind it
      const eb = earBox[side], yT = Math.min(EYE_Y + 0.002, eb.max.y - 0.003), zh = eb.min.z - 0.001, yh = yT - 0.015;
      const hinge = V(side * 0.068, EYE_Y + 0.002, faceZ(side * 0.068, EYE_Y + 0.002) + GAP), pts = [hinge];
      for (let k = 1; k <= 4; k++) { const t = k / 4, z = hinge.z + (zh - hinge.z) * t; pts.push(V(flankX(side, yT, z) + side * 0.0045, yT, z)); } // dense: a chord must not cut under the skull's curve
      pts.push(V(flankX(side, yh, zh) + side * 0.0045, yh, zh));
      pts.forEach((p, i) => {
        if (!i) return;
        add('frame', rod(pts[i - 1], p, 0.0016, 3), rigid('glasses'));
      });
    }
    add('frame', rod(V(-0.019, EYE_Y + 0.005, faceZ(-0.019, EYE_Y + 0.005) + GAP), V(0.019, EYE_Y + 0.005, faceZ(0.019, EYE_Y + 0.005) + GAP), 0.0018), rigid('glasses'));
    // nose: a wedge growing out of the face from between the eyes (nasion) down to a rounded tip, the nostril wings flaring at
    // the base; its underside closes back to the face over the lip
    add('skin', mapPos(new THREE.SphereGeometry(1, 8, 8), (v) => {
      const t = (1 - v.y) / 2, w = (0.006 + 0.0105 * t ** 1.5) * (1 + 0.6 * Math.max(0, t - 0.65));
      v.set(v.x * w, C.y + 0.022 - 0.045 * t, C.z + 0.112 + v.z * (v.z > 0 ? 0.005 + 0.038 * t ** 1.3 : 0.006));
    }), rigid('head'));
  }
  // every material slot needs a group (the materials array is indexed by MATS order): an invisible speck inside the head
  for (const m of MATS) if (!byMat.get(m)?.length) add(m, xf(new THREE.SphereGeometry(0.001, 3, 2), [0, 1.62, 0]), rigid('head'));
  const groups = MATS.map((m) => mergeGeometries(byMat.get(m)!));
  return mergeGeometries(groups, true);
}

export class Warden {
  readonly root = new THREE.Group();
  readonly mesh: THREE.SkinnedMesh;
  readonly bones = {} as Record<BoneName, THREE.Bone>;
  readonly anim: WardenAnimator;

  /** `smiles` off for the student avatars: their face texture is fixed. `build` 'monitor' = the 值日生's own body and upright posture. */
  constructor(materials: THREE.Material[] = makeMaterials(), smiles = true, build: Build = 'warden') {
    // Preserve the public student build and legacy Warden(materials, false) callers.
    const resolvedBuild = build === 'warden' && !smiles ? 'student' : build;
    for (const name of BONES) {
      const [parent, p] = REST[name], b = new THREE.Bone();
      b.name = name;
      const pp = parent ? REST[parent][1] : [0, 0, 0];
      b.position.set(p[0] - pp[0], p[1] - pp[1], p[2] - pp[2]);
      if (parent) this.bones[parent].add(b);
      this.bones[name] = b;
    }
    this.bones.hips.updateMatrixWorld(true);
    this.mesh = new THREE.SkinnedMesh(buildWardenGeometry(smiles, resolvedBuild), materials);
    this.mesh.add(this.bones.hips);
    this.mesh.bind(new THREE.Skeleton(BONES.map((n) => this.bones[n])));
    this.mesh.frustumCulled = false; // posed bounds drift from the bind-pose box
    this.mesh.rotation.y = Math.PI;
    this.mesh.scale.set(...BODY[resolvedBuild].scale);
    this.root.add(this.mesh);
    const face = materials[0] as THREE.MeshStandardMaterial;
    let level = -1;
    this.anim = new WardenAnimator(this.mesh, this.bones, !smiles ? undefined : (smile) => { // face textures cached per smile step
      const l = Math.round(smile * 8);
      if (l === level || !face.map) return;
      level = l;
      face.map = SMILES[l] ??= faceTexture(l / 8);
    }, BODY[resolvedBuild].posture, resolvedBuild === 'warden');
  }

  /** Advance the action clip; `speed` = ground speed (m/s) for the gait rate, `look` = nearest player's head (world). */
  update(dt: number, speed: number, anim = 'patrol', look?: THREE.Vector3 | null) {
    this.anim.update(dt, anim, speed, look, this.root.scale.z * this.mesh.scale.z); // 值日生 / 同学 are scaled: keep the planted foot planted
    const lens = this.mesh.material as THREE.Material[];
    (lens[0] as THREE.MeshStandardMaterial).emissiveIntensity = anim === 'chase' ? 1.8 : 0.25; // eye embers flare while hunting
    const lm = lens[7] as THREE.MeshPhongMaterial; // 'lens': dead-white glare while hunting
    if (!lm.emissive) return;
    lm.emissive.setHex(anim === 'chase' ? 0x9db0cc : 0x3a4a5c); lm.opacity = anim === 'chase' ? 0.42 : 0.6; // hunting: a cold glint, but thin enough that the black red-lit eyes show through
  }
}
