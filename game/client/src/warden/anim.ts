// 角色074 actions (design.md「角色074形象与形态」): procedural poses baked into AnimationClips and played by an
// AnimationMixer with spring-eased weight blending. Gait clips last 1 s per stride cycle and all play one shared stride
// phase advancing at speed / stride (blended by weight), so the stance foot stays planted and gaits fade in step.
// A procedural posture layer (breathing, weight shift, head micro-motion, speed-driven chase lean, sprung sling bag)
// and head look-at to the nearest player go on after the mixer.
import * as THREE from 'three';
import type { BoneName } from './model.ts';

export const CLIPS = ['idle', 'walk', 'look', 'investigate', 'chase', 'catch', 'joke', 'peek', 'sprint'] as const;
export type ClipName = typeof CLIPS[number];
type E = [number, number, number];
type Rot = Partial<Record<BoneName, E>>;
interface Pose { r: Rot; dy?: number; dx?: number; dz?: number }
interface Ctx { hip: THREE.Vector3; posture: Rot } // rest hips position (body frame) and the posture added on top of every pose

const LEG = 0.83; // hip → ankle (m)
const AMP = { walk: 0.36, chase: 0.5, sprint: 0.9 }; // stride length stays tied to the rig; the taller teacher takes fewer steps per metre
/** Ground covered per gait cycle by a leg swinging ±amp about the vertical: 2·LEG·sin(amp) per step, two steps a cycle. */
export const strideOf = (amp: number) => 4 * LEG * Math.sin(amp);
export const STRIDE = { walk: strideOf(AMP.walk), chase: strideOf(AMP.chase), sprint: strideOf(AMP.sprint) };
const MOVING = 0.2; // m/s: below this a moving action shows its standing clip
export const RUN_CLIP = 4.5; // m/s: a running student (SPEED.run 6) switches from the walk to the sprint clip above this
/** Deliberate upper-body gestures; locomotion always uses measured distance / stride instead. */
export const WARDEN_GESTURE_RATE: Partial<Record<ClipName, number>> = {
  idle: 0.65, look: 0.6, investigate: 0.65, catch: 0.72, joke: 0.65, peek: 0.6,
};

/** Server action string (MobSnap.anim) + ground speed → clip. */
export function clipFor(anim: string, speed: number): ClipName {
  const moving = speed > MOVING;
  switch (anim) {
    case 'chase': case 'catch': case 'joke': case 'peek': case 'sprint': return anim;
    case 'patrol': return moving ? 'walk' : 'look'; // stops and looks left/right
    case 'investigate': return moving ? 'walk' : 'investigate';
    case 'run': return !moving ? 'idle' : speed > RUN_CLIP ? 'sprint' : 'walk'; // remote students: ground speed picks the gait
    default: return moving ? 'walk' : 'idle';
  }
}
/** Playback rate: gait clips are one stride cycle per second of clip time. */
export function gaitRate(clip: ClipName, speed: number) {
  return clip === 'walk' || clip === 'chase' || clip === 'sprint' ? Math.max(0, speed) / STRIDE[clip] : 1;
}
/** 冷笑话: the corners of the mouth creep up after he turns his head. */
export const jokeSmile = (t: number) => 0.3 + 0.7 * ss(0.8, 2.8, t);

function ss(a: number, b: number, t: number) { const x = Math.min(1, Math.max(0, (t - a) / (b - a))); return x * x * (3 - 2 * x); }
/** 0 → 1 over [a, a+f], hold, 1 → 0 over [b-f, b]. */
const bump = (t: number, a: number, b: number, f: number) => ss(a, a + f, t) * (1 - ss(b - f, b, t));
const lerp = (p: E, q: E, k: number): E => [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k, p[2] + (q[2] - p[2]) * k];
const TAU = Math.PI * 2;
const add = (p: E, q?: E): E => (q ? [p[0] + q[0], p[1] + q[1], p[2] + q[2]] : p);

const BEHIND: Rot = { // 背手: shoulder blades pinched back, upper arms back, forearms folded in so the hands meet at the small of the back
  shoulderL: [0, 0.05, 0], shoulderR: [0, -0.05, 0],
  upperArmL: [-0.08, 0, 0.07], foreArmL: [-0.22, 0, 0], handL: [0, 0, 0], // hands hang naturally in front of the thighs
  upperArmR: [-0.08, 0, -0.07], foreArmR: [-0.22, 0, 0], handR: [0, 0, 0],
};
const HANG: Rot = { upperArmL: [0, 0, 0.06], foreArmL: [-0.15, 0, 0], upperArmR: [0, 0, -0.06], foreArmR: [-0.15, 0, 0] };
const blendArms = (r: Rot, a: Rot, b: Rot, k: number) => {
  for (const n of Object.keys(a) as BoneName[]) r[n] = lerp(a[n]!, b[n] ?? [0, 0, 0], k);
};
/** Sling bag hanging from the hip: cancels the pelvis roll (gravity keeps it plumb) and swings as a pendulum that lags
 *  the stride by ~60° (second-order lag), plus a small fore-aft knock from the leg; amp in rad. */
export const bagSwing = (a: number, hips: E, amp: number): E =>
  [0.5 * amp * Math.sin(2 * a - 1.0), -0.5 * hips[1], -hips[2] - amp * (Math.sin(a - 1.05) + 0.4)]; // +0.4: biased outward, off the thigh

/** Gaussian bump of the wrapped angle difference x (rad), width w. */
const near = (x: number, w: number) => { const d = Math.atan2(Math.sin(x), Math.cos(x)) / w; return Math.exp(-d * d); };
/** World pitch of the foot sole (+ = toe down). Spread heel / toe roll over the contact rather than flicking a short rig's ankle at running cadence. */
export const footPitch = (a: number) => -0.28 * near(a - Math.PI / 2 + 0.1, 0.65) + 0.5 * near(a + 1.75, 0.7);
// GaitCfg legs by inverse kinematics: each foot is planted on the ground (body frame: slides back at exactly the body's
// speed, linear in time) for the stance part of the cycle, the shoe's sole rolls heel → flat → toe on it without slipping
// (pitch from footPitch), then swings forward on a curve that leaves and lands at the ground's speed. Two-bone IK in the
// hips' frame turns each ankle target into thigh/knee angles, so the pelvis bob, sway and twist never drag the feet.
const L1 = 0.41, L2 = 0.42, REACH = 0.995 * (L1 + L2), SOFT = 0.9 * (L1 + L2); // thigh, shin (m); never quite locked straight (the knee angle is
// singular there): targets past SOFT ease into REACH (tanh) instead of clamping, so an over-long reach never kinks the knee
const JOINT: E = [0.1, -0.03, 0]; // left hip joint, hips frame
const SOLE = { y: -0.045, z: 0.035, a: 0.13, b: 0.048 }; // side view of the shoe: an ellipse around this point (ankle frame), half-length a, half-height b
const GROUND = 0.09 + SOLE.y - SOLE.b; // sole height standing (body frame)
/** Arc length of the sole from its bottom point (ellipse angle -π/2) to angle th, + toward the toe. */
function soleArc(th: number) {
  const n = 16, h = (th + Math.PI / 2) / n, g = (u: number) => Math.hypot(SOLE.a * Math.sin(u), SOLE.b * Math.cos(u));
  let s = g(-Math.PI / 2) + g(th);
  for (let i = 1; i < n; i++) s += (i % 2 ? 4 : 2) * g(-Math.PI / 2 + i * h);
  return (s * h) / 3;
}
/** Ankle (body frame y, z) with the sole at pitch f rolled onto the ground, its flat-foot contact at z0. */
function planted(z0: number, f: number): [number, number] {
  const th = Math.atan2(-SOLE.b * Math.cos(f), SOLE.a * Math.sin(f)); // lowest sole point at this pitch
  const cy = SOLE.y + SOLE.b * Math.sin(th), cz = SOLE.z + SOLE.a * Math.cos(th), c = Math.cos(f), s = Math.sin(f);
  return [GROUND - (cy * c - cz * s), z0 + soleArc(th) - (cy * s + cz * c)];
}
export interface GaitCfg { stride: number; duty: number; lift: number; ahead?: number } // m / cycle; stance share; swing ankle lift (m); stance centre ahead of the hips (m)
/** Stance share of the cycle (0.5 = no double support / flight: ±stride/4 under the hips; chase and sprint strides are past
 *  that reach so they fly a little / a lot), swing ankle lift, hip drop [mean, ± half-range over the stride]. */
export const GAIT: Record<'walk' | 'chase' | 'sprint', GaitCfg> = {
  walk: { stride: STRIDE.walk, duty: 0.5, lift: 0.1 }, chase: { stride: STRIDE.chase, duty: 0.45, lift: 0.1 }, sprint: { stride: STRIDE.sprint, duty: 0.33, lift: 0.25 },
};
const WALK_DY = [-0.03, 0.013], CHASE_DY = [-0.07, 0.012], SPRINT_DY = [-0.1, 0.02];
/** Leg phase q ∈ [0,1) from heel strike → [stance?, u ∈ [0,1], footPitch phase]. */
const legPhase = (q: number, d: number): [boolean, number, number] => {
  if (q < d) return [true, q / d, Math.PI / 2 + (Math.PI * q) / d];
  const u = (q - d) / (1 - d), m = (1 - d) / d; // swing: the pitch phase eases so its rate matches the stance's at both ends (no toe skid at lift-off)
  return [false, u, 1.5 * Math.PI + Math.PI * (m * u + (1 - m) * (10 * u ** 3 - 15 * u ** 4 + 6 * u ** 5))];
};
const stanceAnkle = (g: GaitCfg, u: number) => { const D = g.duty * g.stride; return planted((g.ahead ?? 0) + D / 2 - u * D, footPitch(Math.PI / 2 + Math.PI * u)); };
/** Ankle target (body frame y, z) at leg phase q. */
export function ankleAt(g: GaitCfg, q: number): [number, number] {
  const [stance, u, fp] = legPhase(q, g.duty);
  if (stance) return stanceAnkle(g, u);
  const e = 1e-4, k = (1 - g.duty) / (e * g.duty); // stance d/du → swing d/du
  const p0 = stanceAnkle(g, 1), p1 = stanceAnkle(g, 0), m0 = stanceAnkle(g, 1 - e), m1 = stanceAnkle(g, e);
  const h00 = 2 * u ** 3 - 3 * u * u + 1, h10 = u ** 3 - 2 * u * u + u, h01 = 1 - h00, h11 = u ** 3 - u * u;
  const w = u + 0.3 * u * (1 - u); // lift peaks a little before mid-swing (the knee is folded most there)
  const y = h00 * p0[0] + h10 * k * (p0[0] - m0[0]) + h01 * p1[0] + h11 * k * (m1[0] - p1[0]) + g.lift * Math.sin(Math.PI * w) ** 2;
  // Return the rolling contact reference with matched stance velocity / acceleration; keep the existing
  // vertical knee lift instead of extending the toe-roll curvature through the whole airborne trajectory.
  const back = (1 - g.duty) * g.stride, s = 10 * u ** 3 - 15 * u ** 4 + 6 * u ** 5;
  const [, z] = planted((g.ahead ?? 0) - g.duty * g.stride / 2 - back * u + g.stride * s, footPitch(fp));
  return [y, z];
}
const _gq = new THREE.Quaternion(), _gq2 = new THREE.Quaternion(), _gqh = new THREE.Quaternion(), _ge = new THREE.Euler(), _gt = new THREE.Vector3();
const toQ = (q: THREE.Quaternion, v: E) => q.setFromEuler(_ge.set(v[0], v[1], v[2]));
/** Leg bones for gait phase p ∈ [0,1) from the hips' pose already in r (+ its offset from the rest position `hip` (body frame)). */
function gait(r: Rot, p: number, g: GaitCfg, k: Ctx, off: E = [0, 0, 0]) {
  const P = k.posture, hipsQ = toQ(_gqh, add(r.hips ?? [0, 0, 0], P.hips));
  for (const [S, x, ph] of [['L', 1, (p + 0.75) % 1], ['R', -1, (p + 0.25) % 1]] as const) { // left heel strike at p = 0.25
    const [, , fp] = legPhase(ph, g.duty), [ay, az] = ankleAt(g, ph);
    // ankle target relative to the hip joint, in the hips' frame
    const T = _gt.set(x * JOINT[0] - k.hip.x - off[0], ay - k.hip.y - off[1], az - k.hip.z - off[2]).applyQuaternion(_gq.copy(hipsQ).invert());
    T.x -= x * JOINT[0]; T.y -= JOINT[1]; T.z -= JOINT[2];
    const len = T.length();
    if (len > SOFT) T.setLength(SOFT + (REACH - SOFT) * Math.tanh((len - SOFT) / (REACH - SOFT)));
    const kn = Math.acos(Math.max(-1, Math.min(1, (T.lengthSq() - L1 * L1 - L2 * L2) / (2 * L1 * L2))));
    const vy = -(L1 + L2 * Math.cos(kn)), vz = -L2 * Math.sin(kn), tz = Math.asin(Math.max(-1, Math.min(1, T.x / -vy)));
    const tx = Math.atan2(T.z, T.y) - Math.atan2(vz, vy * Math.cos(tz));
    const th: E = [tx, 0, tz], sh: E = [kn, 0, 0];
    // foot: level across, pitched footPitch in the body frame (undo the hips · thigh · shin rotation above it)
    _gq2.copy(hipsQ).multiply(toQ(_gq, th)).multiply(toQ(_gq, sh)).invert().multiply(toQ(_gq, [footPitch(fp), 0, 0]));
    _ge.setFromQuaternion(_gq2);
    const pick = (v: E, b: BoneName): E => { const o = P[b] ?? [0, 0, 0]; return [v[0] - o[0], v[1] - o[1], v[2] - o[2]]; };
    r[`thigh${S}`] = pick(th, `thigh${S}`); r[`shin${S}`] = pick(sh, `shin${S}`); r[`foot${S}`] = pick([_ge.x, _ge.y, _ge.z], `foot${S}`);
  }
}

// right hand at the glasses bridge; left hand on a shoulder in front, right arm pointing out at the wall
const PUSH: Rot = { upperArmR: [-1.3, 0, 0.06], foreArmR: [-1.5, 0.4, 0], handR: [0.2, 0, 0] }; // upper arm out of the chest, forearm ~vertical so the hand stops at the glasses
const GRAB: Rot = { upperArmL: [-1.25, 0, -0.25], foreArmL: [-0.35, 0, 0], handL: [0.5, 0, 0] };
const POINT: Rot = { upperArmR: [-0.6, 0, -0.85], foreArmR: [-0.26, 0, -0.05], handR: [0, 0, 0] }; // forward +35°, out ~60°, elbow 15°: not a side raise

/** Per-action pose over clip time t (s). Rotations are local Euler XYZ; +x bends forward / thighs back, +y turns to his left. */
const DEFS: Record<ClipName, { dur: number; loop: boolean; f: (t: number, k: Ctx) => Pose }> = {
  idle: { dur: 6.4, loop: true, f: (t) => { // breathing, hands behind his back; brings the right hand round to push his glasses up
    const r: Rot = { ...BEHIND }, k = bump(t, 2.6, 4.4, 0.55); // (breathing / weight shift / head micro-motion: WardenAnimator's posture layer)
    blendArms(r, { upperArmR: BEHIND.upperArmR!, foreArmR: BEHIND.foreArmR!, handR: BEHIND.handR! }, PUSH, k);
    r.chest = [0, 0, 0]; r.spine = [0.02, 0, 0]; r.shoulderL = add(BEHIND.shoulderL!, [0, -0.2 * k, 0]); r.shoulderR = add(BEHIND.shoulderR!, [0, 0.2 * k, 0]);
    r.head = [0.12 * k, 0, 0];
    return { r };
  } },
  walk: { dur: 1, loop: true, f: (t, k) => { // 踱步, hands behind his back
    const r: Rot = { ...BEHIND }, a = t * TAU;
    // pelvis yaws/rolls with the swing leg and shifts over the stance foot; shoulders counter-rotate and shrug in turn
    const s = Math.sin(a);
    // (exaggerated past real life so a single frame still shows the twist: hips and shoulders visibly out of line)
    r.hips = [0, 0.15 * s, 0.085 * s]; r.spine = [0.04, -0.1 * s, -0.07 * s];
    r.chest = [0.05 + 0.015 * Math.cos(2 * a), -0.11 * s, -0.07 * s]; // shoulder line tilts against the pelvis (weight over the stance leg)
    r.neck = [0, 0.08 * s, 0.03 * s]; r.head = [-0.04, 0.06 * s, 0.03 * s];
    r.shoulderL = add(BEHIND.shoulderL!, [0, 0.06 * s, 0.07 * Math.max(0, s)]); r.shoulderR = add(BEHIND.shoulderR!, [0, 0.06 * s, -0.07 * Math.max(0, -s)]);
    r.bag = bagSwing(a, [0, 0.15 * s, 0.085 * s], 0.14);
    const off: E = [0.05 * s, WALK_DY[0] + WALK_DY[1] * Math.cos(2 * a), 0]; // ~3 cm bob (more read as "suddenly shorter" mid-stride) + sway over the stance foot
    gait(r, t, GAIT.walk, k, off);
    return { r, dx: off[0], dy: off[1] };
  } },
  look: { dur: 5, loop: true, f: (t) => { // patrol stop: head (then chest) turns left, holds, right, holds
    const r: Rot = { ...BEHIND }, y = 0.85 * (bump(t, 0.3, 2.1, 0.5) - bump(t, 2.6, 4.6, 0.6));
    r.chest = [0, y * 0.25, 0]; r.neck = [0, y * 0.3, 0]; r.head = [0.04, y * 0.45, 0];
    return { r };
  } },
  investigate: { dur: 7, loop: true, f: (t) => { // 歪头听, then bends down to look under a desk
    const r: Rot = { ...BEHIND }, l = bump(t, 0.2, 3.0, 0.5), d = bump(t, 3.4, 6.8, 0.8);
    r.neck = [-0.25 * d, 0.15 * l, 0.12 * l]; r.head = [0.05 - 0.2 * d, 0.3 * l, 0.32 * l]; // neck/head lift to look under the desk
    r.spine = [0.42 * d, 0, 0]; r.chest = [0.32 * d, 0, 0];
    // hip flexion ~55° with the knees ~46°: the pelvis sits back so the feet stay put
    const th = 0.95 * d, kn = 0.8 * d, h = LEG / 2;
    r.thighL = r.thighR = [-th, 0, 0]; r.shinL = r.shinR = [kn, 0, 0]; r.footL = r.footR = [th - kn, 0, 0];
    blendArms(r, BEHIND, { ...HANG, upperArmL: [-0.9, 0, 0.12], foreArmL: [-0.4, 0, 0], upperArmR: [-0.9, 0, -0.12], foreArmR: [-0.4, 0, 0] }, d);
    return { r, dy: -(LEG - h * (Math.cos(th) + Math.cos(th - kn))), dz: -h * (Math.sin(th) + Math.sin(th - kn)) };
  } },
  chase: { dur: 1, loop: true, f: (t, k) => { // 前倾僵直快走: big strides, torso locked forward, arms rigid
    const r: Rot = {}, a = t * TAU, dy = CHASE_DY[0] + CHASE_DY[1] * Math.cos(2 * a);
    gait(r, t, GAIT.chase, k, [0, dy, 0]);
    // (the forward lean is not baked here: WardenAnimator blends LEAN in from ground speed, so patrol → chase hunches over continuously)
    r.upperArmL = [0.12 * Math.sin(a), 0, 0.14]; r.upperArmR = [-0.12 * Math.sin(a), 0, -0.14]; // rigid, barely swinging, held a little out like claws
    r.foreArmL = [-0.5 - 0.04 * Math.sin(a), 0, 0]; r.foreArmR = [-0.5 + 0.04 * Math.sin(a), 0, 0];
    // clawed reach: hands twisted palm-down and flexed forward, a half fist (fingers ~65° / ~70° on top of POSTURE's resting curl) with the knuckles twitching
    r.handL = [-0.9, -1.4, 0]; r.handR = [-0.9, 1.4, 0];
    r.fingersL = [0, 0, -0.85 - 0.08 * Math.sin(3 * a)]; r.fingersR = [0, 0, 0.85 + 0.08 * Math.sin(3 * a + 1)];
    r.fingers2L = [0, 0, -0.9 - 0.1 * Math.sin(3 * a)]; r.fingers2R = [0, 0, 0.9 + 0.1 * Math.sin(3 * a + 1)];
    r.bag = bagSwing(a, [0, 0, 0], 0.16);
    return { r, dy };
  } },
  sprint: { dur: 1, loop: true, f: (t, k) => { // 无脸值日生 7.8 m/s 冲刺 / 同学 6 m/s 跑: whole body pitched forward, knees driven high, elbows at 90° pumping against the legs, fists, head level
    const r: Rot = {}, a = t * TAU, dy = SPRINT_DY[0] + SPRINT_DY[1] * Math.cos(2 * a);
    r.hips = [0.12, 0.1 * Math.sin(a), 0.04 * Math.sin(a)];
    gait(r, t, GAIT.sprint, k, [0, dy, 0.02]); r.spine = [0.28, -0.12 * Math.sin(a), 0]; r.chest = [0.18, -0.14 * Math.sin(a), 0]; r.neck = [-0.1, 0, 0]; r.head = [-0.12, 0, 0];
    r.upperArmL = [0.95 * Math.sin(a) - 0.15, 0, 0.1]; r.upperArmR = [-0.95 * Math.sin(a) - 0.15, 0, -0.1];
    r.foreArmL = [-1.35 - 0.2 * Math.sin(a), 0, 0]; r.foreArmR = [-1.35 + 0.2 * Math.sin(a), 0, 0];
    r.fingersL = [0, 0, -1.1]; r.fingersR = [0, 0, 1.1]; r.fingers2L = [0, 0, -1.2]; r.fingers2R = [0, 0, 1.2];
    r.bag = bagSwing(a, [0, 0, 0], 0.3);
    return { r, dy, dz: 0.02 };
  } },
  catch: { dur: 2.4, loop: false, f: (t) => { // 按肩: left hand onto the shoulder; 指墙: right arm points out
    const r: Rot = { ...HANG }, g = ss(0, 0.5, t), p = ss(0.6, 1.3, t);
    blendArms(r, { upperArmL: HANG.upperArmL!, foreArmL: HANG.foreArmL!, handL: [0, 0, 0] }, GRAB, g);
    blendArms(r, { upperArmR: HANG.upperArmR!, foreArmR: HANG.foreArmR!, handR: [0, 0, 0] }, POINT, p);
    r.spine = [0.1 * g, -0.17 * p, 0]; r.chest = [0.05, -0.1 * p, 0]; r.head = [0.08 * g, -0.4 * p, 0];
    return { r };
  } },
  joke: { dur: 4, loop: false, f: (t) => { // 冷笑话: slow turn of the head to you, holds; the smile is on the face texture
    const r: Rot = { ...BEHIND }, y = ss(0, 0.9, t);
    r.chest = [0, 0.15 * y, 0]; r.neck = [0, 0.15 * y, 0]; r.head = [0.06, 0.35 * y, -0.08 * y];
    return { r };
  } },
  peek: { dur: 5, loop: true, f: (t) => { // 后门小窗: leans sideways so half his face shows, holds still, a slow small tilt
    const r: Rot = { ...BEHIND }, s = 0.04 * Math.sin((t / 5) * TAU), tw = Math.sin((t / 5) * 3 * TAU);
    r.spine = [0.05, 0, 0.2]; r.chest = [0.04, 0, 0.14]; r.neck = [0, 0.03 * tw, -0.05]; r.head = [0.05, -0.1 + s + 0.04 * tw, -0.12 + s]; // tw: small glances
    r.thighL = [0, 0, 0.08]; r.thighR = [0, 0, 0.08]; r.footL = r.footR = [0, 0, -0.08];
    return { r, dx: 0.06 + 0.01 * Math.sin((t / 5) * TAU), dy: -0.004 * Math.sin((t / 2.5) * TAU) };
  } },
};
const ANIMATED: BoneName[] = ['hips', 'spine', 'chest', 'neck', 'head', 'glasses', 'shoulderL', 'upperArmL', 'foreArmL', 'handL', 'fingersL', 'fingers2L',
  'shoulderR', 'upperArmR', 'foreArmR', 'handR', 'fingersR', 'fingers2R', 'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR', 'bag'];
const FPS = 30;
/** Middle-aged stoop layered under every clip: upper back rounded ~10°, head pushed forward and tipped back up to level the eyes. */
export const POSTURE: Rot = { thighL: [-0.05, 0, 0], thighR: [-0.05, 0, 0], shinL: [0.1, 0, 0], shinR: [0.1, 0, 0], footL: [-0.05, 0, 0], footR: [-0.05, 0, 0], // soft knees
  spine: [0.04, 0, 0], chest: [0.16, 0, 0], neck: [0.34, 0, 0], head: [-0.46, 0, 0], shoulderL: [0.08, -0.14, 0], shoulderR: [0.08, 0.14, 0], // + shoulders rolled in
  fingersL: [0, 0, -0.4], fingersR: [0, 0, 0.4], fingers2L: [0, 0, -0.5], fingers2R: [0, 0, 0.5] }; // + fingers relaxed, curled (~23°/29°) toward the palm

/** 角色074 (~35): relaxed adult shoulders and a supported neck. The original posture stays available to student avatars. */
export const WARDEN_POSTURE: Rot = { ...POSTURE,
  spine: [0.025, 0, 0], chest: [0.085, 0, 0], neck: [0.1, 0, 0], head: [-0.16, 0, 0],
  shoulderL: [0.025, -0.06, 0], shoulderR: [0.025, 0.06, 0],
};

/** Bake every action into an AnimationClip; every clip keys every animated bone so the mixer fully owns the pose. */
/** The 值日生 stands to attention: straight back and locked knees, chin level, shoulders squared back, hands flat at the seams. */
export const UPRIGHT: Rot = {
  spine: [-0.02, 0, 0], chest: [-0.04, 0, 0], neck: [0.02, 0, 0], head: [0.02, 0, 0], shoulderL: [-0.06, 0.06, 0], shoulderR: [-0.06, -0.06, 0],
  fingersL: [0, 0, -0.08], fingersR: [0, 0, 0.08], fingers2L: [0, 0, -0.1], fingers2R: [0, 0, 0.1],
};

export function buildClips(hip: THREE.Vector3, posture: Rot = POSTURE): Record<ClipName, THREE.AnimationClip> {
  const out = {} as Record<ClipName, THREE.AnimationClip>;
  const q = new THREE.Quaternion(), e = new THREE.Euler();
  for (const name of CLIPS) {
    const { dur, f } = DEFS[name], n = Math.max(2, Math.round(dur * FPS) + 1);
    const times = Array.from({ length: n }, (_, i) => (i / (n - 1)) * dur);
    const rot = new Map(ANIMATED.map((b) => [b, [] as number[]])), pos: number[] = [];
    for (const t of times) {
      const p = f(t, { hip, posture });
      for (const b of ANIMATED) { const v = add(p.r[b] ?? [0, 0, 0], posture[b]); q.setFromEuler(e.set(v[0], v[1], v[2])); rot.get(b)!.push(q.x, q.y, q.z, q.w); }
      pos.push(hip.x + (p.dx ?? 0), hip.y + (p.dy ?? 0), hip.z + (p.dz ?? 0));
    }
    const tracks: THREE.KeyframeTrack[] = ANIMATED.map((b) => new THREE.QuaternionKeyframeTrack(`${b}.quaternion`, times, rot.get(b)!));
    tracks.push(new THREE.VectorKeyframeTrack('hips.position', times, pos));
    out[name] = new THREE.AnimationClip(name, dur, tracks);
  }
  return out;
}

const FADE = 0.5; // s: a clip's share grows at most 1/FADE per s, which keeps the biggest swap (look → chase arms) under 0.06 rad a frame
const FADE_W = 8; // rad/s: the share eases in and out on a critically damped spring, so a fade starting, ending or reversing
                  // never kinks a bone's velocity (a linear ramp turning round flicked the hands 0.1 rad in one frame)
const STILL_W = 8; // rad/s: standing ↔ moving share of the posture layer (~90% in 0.5 s)
const SPEED_W = 14; // rad/s: upper-body speed / clip choice; snapshot jitter must not flicker walk / look.
const STRIDE_W = 100; // feet follow measured travel promptly; a slower filter lets a support foot fall behind the moving body.
const START_LEAD = 0.15; // cycles: let the gait share fade in before the support foot reaches midstance.
const LOOK_MAX = 1.1, LOOK_RANGE = 8, LOOK_W = 8; // head yaw clamp (rad), look-at distance (m), turn spring (rad/s, ~0.5 s)
const BREATH = 0.4, BREATH_AMP = 0.065; // Hz, chest pitch (rad) standing still
const SHIFT = 0.17, SHIFT_DX = 0.025, SHIFT_ROLL = 0.03; // weight shift between the feet: Hz, hip slide (m), pelvis roll (rad)
const LEAN: Partial<Record<BoneName, number>> = { spine: 0.3, chest: 0.16, neck: 0.06, head: -0.3 }; // chase hunch, eyes kept forward
const LEAN_W = 10, LEAN_V = 2.4; // rad/s: critically damped, ~90% in 0.45 s; lean rate cap (/s) so no frame bends > 0.05
const BAG_W = 6.3, BAG_Z = 0.4, BAG_MAX = 0.35, BAG_V = 1.5, G = 9.8; // strap pendulum: natural freq, damping ratio, clamp (rad), max rad/s
/** Bones the posture layer writes on top of the mixer; the mixer skips unchanged bones, so they are restored first. */
const LAYERED: BoneName[] = ['hips', 'spine', 'chest', 'neck', 'head', 'shoulderL', 'shoulderR', 'upperArmL', 'upperArmR', 'foreArmL', 'foreArmR',
  'thighL', 'thighR', 'shinL', 'shinR', 'footL', 'footR', 'bag'];
// Foot placement (after the posture layer): the clips step as if he walked straight on at the smoothed speed. Each ankle
// is re-aimed by two-bone IK: a planted foot keeps its spot and heading on the ground (dead-reckoned from the ground speed
// and the body's yaw; the sole still rolls heel → toe on the clip's pitch), a stride's swing leaves from where the foot
// really was and fades onto the clip's swing by touchdown, and standing he steps: when the body has turned or moved off a
// planted foot it lifts and sets down under the hip (ahead of a turn still going on), one foot at a time on the other.
const STEP_T = 0.32, STEP_LIFT = 0.07; // s, m: a standing step (turning on the spot, closing the feet after a stop)
const STEP_POS = 0.07, STEP_YAW = 0.35; // m, rad: a planted foot this far off its place under the hip steps (the two add up)
const CLOSE = 0.02; // m: for 1.5 s after a stop the feet close up to this
const STEP_REST = 0.04; // s on both feet between standing steps
const LAND_T = 0.16, PITCH_JOIN = 0.08; // s: finish a closing step before the next support release; join the sole's angular velocity too.
const PIVOT = 0.65, DRAG = 0.4; // rad, m: past this a planted foot pivots / slides with the body (a snap turn outruns stepping)
const KNEE_TWIST = 0.7; // share of a foot's turn on the ground the knee follows
const LIFT_LATE = 0.6; // a stride swing more than this far through when the foot could leave is skipped (no hop)
const SURGE_A = 10, SURGE_DEAD = 1.5, SURGE_W = 9; // m/s² for a full start / pull-up surge, ignored below (jitter); spring rad/s
export type Loco = 'idle' | 'start' | 'move' | 'stop' | 'turn';
interface Foot {
  planted: boolean; g: THREE.Vector3; yaw: number; // planted: flat-foot ground contact (model frame xz), heading on the ground (rel. body)
  step: boolean; k: number; dur: number; s: THREE.Vector3; v0: THREE.Vector3; end: THREE.Vector3; sYaw: number; lift: number; // standing step from s (world-fixed) on its own clock
  u0: number; off: THREE.Vector3; offV: THREE.Vector3; swingT: number; offYaw: number; // swing correction carries position and velocity into the stride
  at: THREE.Vector3; last: THREE.Vector3; vel: THREE.Vector3; head: number; pitch: number; sPitch: number; // ankle target, heading, sole pitch this frame; last target, its velocity (body frame)
  pitchJoin: number; pitchOff: number; pitchOffV: number; pitchVel: number; clipPitch: number;
}
const newFoot = (): Foot => ({ planted: true, g: new THREE.Vector3(), yaw: 0, step: false, k: 0, dur: STEP_T, s: new THREE.Vector3(), v0: new THREE.Vector3(),
  end: new THREE.Vector3(),
  sYaw: 0, lift: 0, u0: 0, off: new THREE.Vector3(), offV: new THREE.Vector3(), swingT: 0, offYaw: 0, at: new THREE.Vector3(), last: new THREE.Vector3(), vel: new THREE.Vector3(), head: 0, pitch: 0, sPitch: 0,
  pitchJoin: -1, pitchOff: 0, pitchOffV: 0, pitchVel: 0, clipPitch: 0 });
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
/** Ankle [height, distance ahead of its flat-foot ground contact] with the sole rolled to pitch f. */
const roll = (f: number) => planted(0, f);
/** Conservative smooth maximum: never underestimates either height constraint, with a 1 cm handover between legs. */
const reachMax = (a: number, b: number) => (a + b + Math.hypot(a - b, 0.01)) / 2;
const h01 = (k: number) => k * k * (3 - 2 * k), h10 = (k: number) => k * (1 - k) * (1 - k); // Hermite: end-point blend, start tangent
/** How far toward the chase hunch a server action leans at a ground speed: walk upright, run bent over. */
export function leanFor(anim: string, speed: number) {
  if (anim !== 'patrol' && anim !== 'investigate' && anim !== 'chase') return 0; // students / 班长 / catch keep their own spine
  return Math.max(ss(2.3, 4.2, speed), anim === 'chase' ? 0.7 : 0);
}

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
const _h = new THREE.Quaternion(), _h2 = new THREE.Quaternion(), _r = new THREE.Quaternion(), _c = new THREE.Quaternion();
const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
const _fa = new THREE.Vector3(), _fb = new THREE.Vector3(), _fc = new THREE.Vector3(), _fq = new THREE.Quaternion(), _fq2 = new THREE.Quaternion(), _fq3 = new THREE.Quaternion();
const GAITS = ['walk', 'chase', 'sprint'] as const;
type Gait = typeof GAITS[number];
const LEGS = [['thighL', 'shinL', 'footL'], ['thighR', 'shinR', 'footR']] as const;
const ARMS = [['upperArmL', 'foreArmL', 1, 0], ['upperArmR', 'foreArmR', -1, 2.1]] as const; // side (abduction sign), drift phase
/** One step of a damped spring toward `goal` (natural freq w rad/s, damping ratio z), sub-stepped for long frames. */
function spring(x: number, v: number, goal: number, w: number, z: number, dt: number): [number, number] {
  const n = Math.ceil(dt / 0.02), h = dt / n;
  for (let i = 0; i < n; i++) { v += (w * w * (goal - x) - 2 * z * w * v) * h; x += v * h; }
  return [x, v];
}
/** Bag pendulum step: the heavy bag swings no faster than BAG_V and stops dead against the strap at ±BAG_MAX
 *  (a sudden stop from a sprint would otherwise whip it through 0.13 rad a frame). */
function swing(x: number, v: number, goal: number, dt: number): [number, number] {
  [x, v] = spring(x, v, Math.max(-BAG_MAX, Math.min(BAG_MAX, goal)), BAG_W, BAG_Z, dt);
  v = Math.max(-BAG_V, Math.min(BAG_V, v));
  if (Math.abs(x) > BAG_MAX) { x = Math.sign(x) * BAG_MAX; if (v * x > 0) v = 0; }
  return [x, v];
}
/** q ← R·q, R a rotation about the parent-space axis (pre-multiply: the bone turns in its parent's frame). */
const pre = (q: THREE.Quaternion, axis: THREE.Vector3, a: number) => q.premultiply(_q.setFromAxisAngle(axis, a));

/** Drives a Warden's bones: mixer clips blended by per-action weights, gait rate from ground speed, then a procedural
 *  posture layer (breathing, weight shift, head micro-motion, speed-driven lean, sprung sling bag) and head look-at. */
export class WardenAnimator {
  readonly mixer: THREE.AnimationMixer;
  readonly actions = {} as Record<ClipName, THREE.AnimationAction>;
  clip: ClipName = 'idle';
  lean = 0; // 0 upright … 1 chase hunch
  bagPitch = 0; bagRoll = 0; // strap swing from body acceleration (rad)
  private still = 1; private stillV = 0;
  private t = Math.random() * 10; // breathing / weight-shift phase: a row of students doesn't sway in step
  private speed = 0;
  private speedV = 0;
  private phase = 0; // shared gait clip time (all gaits are 1 s cycles)
  private fadeV = 0; // rate of the current clip's share (/s)
  private readonly dw = {} as Record<ClipName, number>; // each weight's last rate (/s)
  private leanV = 0;
  private lookYaw = 0;
  private lookPitch = 0;
  private lookYawV = 0;
  private lookPitchV = 0;
  private readonly weight = {} as Record<ClipName, number>;
  private readonly tmp = new THREE.Vector3();
  private readonly base = new Map<BoneName, THREE.Quaternion>(); // layered bones as the mixer left them
  private readonly hipPos = new THREE.Vector3();
  private readonly bagAt: THREE.Vector3; // strap end in the model frame
  private readonly bag = { p: new THREE.Vector3(), v: new THREE.Vector3(), a: new THREE.Vector3(), vp: 0, vr: 0, primed: false };
  loco: Loco = 'idle'; // locomotion state of the foot placement
  private readonly foot = [newFoot(), newFoot()];
  private readonly ca = [new THREE.Vector3(), new THREE.Vector3()]; // the clip's ankles (model frame)
  private readonly prevCa = [new THREE.Vector3(), new THREE.Vector3()];
  private readonly cq = [new THREE.Quaternion(), new THREE.Quaternion()]; // … feet (model frame)
  private readonly cp = [0, 0]; private readonly cy = [0, 0]; // … foot pitch, heading
  private readonly home: THREE.Vector3[]; // where each ankle stands (model frame)
  private yaw = 0; private yawRate = 0; private primed = false; // body heading (world), its smoothed rate
  private rate = 0; // stride phase rate (/s)
  private rateV = 0;
  private gaitMoving = false;
  private rest = 0; private sinceMove = 9; private moveT = 0; // s: wait before the next standing step; since / for how long he strode
  private surge = 0; private surgeV = 0; // start / pull-up pitch of the upper body (−1 … 1)
  private reachDrop = 0; private reachV = 0; // pelvis stays loaded while the knee's reach constraint releases
  private reachNeed: number | null = null;

  private readonly root: THREE.Object3D;
  private readonly deliberate: boolean;
  private readonly bones: Record<BoneName, THREE.Bone>;
  readonly onSmile?: (s: number) => void; // face texture hook (冷笑话 smile)

  constructor(root: THREE.Object3D, bones: Record<BoneName, THREE.Bone>, onSmile?: (s: number) => void, posture: Rot = POSTURE, deliberate = false) {
    this.root = root; this.bones = bones; this.onSmile = onSmile;
    this.deliberate = deliberate;
    this.mixer = new THREE.AnimationMixer(root);
    const clips = buildClips(bones.hips.position.clone(), posture);
    for (const n of CLIPS) {
      const a = this.mixer.clipAction(clips[n], root);
      a.timeScale = deliberate ? WARDEN_GESTURE_RATE[n] ?? 1 : 1;
      if (!DEFS[n].loop) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
      this.actions[n] = a; this.weight[n] = 0; this.dw[n] = 0;
    }
    this.weight.idle = 1; this.actions.idle.play();
    for (const b of LAYERED) this.base.set(b, bones[b].quaternion.clone());
    this.hipPos.copy(bones.hips.position);
    this.bagAt = bones.hips.position.clone().add(bones.bag.position);
    this.home = LEGS.map(([t]) => bones.hips.position.clone().add(bones[t].position).setY(roll(0)[0]));
  }
  /** Is foot 0 (left) / 1 (right) planted on the ground (not in a swing or step)? */
  planted(i: number) { return this.foot[i].planted && !this.foot[i].step; }
  /** `target` = world position of the nearest player's head, or null; `scale` = the rig's world scale along the stride. */
  update(dt: number, anim: string, speed: number, target?: THREE.Vector3 | null, scale = 1) {
    const ground = Math.max(0, speed) / scale; // the floor under him (model units / s): planted feet hold still on it
    [this.speed, this.speedV] = spring(this.speed, this.speedV, speed, SPEED_W, 1, dt); // snapshot jitter would flicker walk/look
    speed = this.speed = Math.max(0, this.speed);
    this.t += dt;
    let w0 = 0;
    for (const n of GAITS) w0 += this.weight[n];
    this.blend(dt, clipFor(anim, speed));
    // one stride phase for every gait: blended gaits stay in step (separate timeScales drifted chase and walk apart
    // within a fade, and the mix of two strides half a step apart flicked the feet), stepping at the blended stride
    let w = 0, rate = 0, duty = 0;
    for (const n of GAITS) { w += this.weight[n]; rate += this.weight[n] * gaitRate(n, ground); duty += this.weight[n] * GAIT[n].duty; } // a scaled-down rig strides shorter: step faster
    if (w0 === 0 && w > 0) this.phase = (0.75 + duty / (2 * w) - START_LEAD) % 1;
    const nextRate = w > 0 ? rate / w : 0, d = this.rate - nextRate, c = this.rateV + STRIDE_W * d, decay = Math.exp(-STRIDE_W * dt);
    const travel = nextRate * dt + d * (1 - decay) / STRIDE_W + c * (1 - decay * (1 + STRIDE_W * dt)) / (STRIDE_W * STRIDE_W);
    this.rate = nextRate + (d + c * dt) * decay;
    this.rateV = (this.rateV - STRIDE_W * c * dt) * decay;
    this.phase = (this.phase + travel) % 1;
    for (const n of GAITS) { this.actions[n].timeScale = 0; this.actions[n].time = this.phase; }
    this.mix(dt);
    this.onSmile?.(this.clip === 'joke' ? jokeSmile(this.actions.joke.time) : jokeSmile(0));
    this.posture(dt, anim, speed);
    this.feet(dt, ground, w, w > 0 ? duty / w : 0.5);
    this.lookAt(dt * (this.deliberate ? 0.65 : 1), target ?? null);
  }

  /** Freeze one clip at clip time t (s) for docs shots: no breathing / look-at, chase keeps its hunch. */
  pose(clip: ClipName, t: number) {
    for (const n of CLIPS) { this.actions[n].stop(); this.weight[n] = 0; this.dw[n] = 0; }
    const a = this.actions[clip];
    this.clip = clip; this.weight[clip] = 1; this.fadeV = 0;
    a.setEffectiveWeight(1).play(); a.time = t;
    this.mix(0);
    this.lean = clip === 'chase' ? 1 : 0; this.leanV = 0;
    this.hunch();
    this.primed = false; // the feet stand as posed when he moves again
    this.reachDrop = this.reachV = 0;
    this.reachNeed = null;
    this.onSmile?.(clip === 'joke' ? jokeSmile(t) : jokeSmile(0));
  }

  /** Per-action weights (summing to 1) ramp linearly (1/FADE per s) toward the current clip, so a change in
   *  mid-fade carries on from where the blend is instead of popping (crossFadeTo restarts its weights from 1). */
  private blend(dt: number, next: ClipName) {
    if (next !== this.clip) {
      const to = this.actions[next];
      if (this.weight[next] === 0) to.reset().play(); // a gait's clip time is set from the shared stride phase
      else if (!DEFS[next].loop && this.weight[next] < 0.05) to.reset(); // a one-shot that has all but faded starts over
      this.clip = next; this.fadeV = this.dw[next]; // the new clip's share carries on at the rate it was moving
    }
    // the incoming clip's share grows (≤ 1/FADE per s); the outgoing mixture shrinks in proportion (fading each one
    // out separately and renormalising sped the blend up ~2× when three clips overlapped: a visible snap of the arms)
    let cur = this.weight[this.clip];
    if (cur < 1) {
      [cur, this.fadeV] = spring(cur, this.fadeV, 1, FADE_W, 1, dt);
      this.fadeV = Math.min(1 / FADE, this.fadeV);
      if (cur > 1 - 1e-4) { cur = 1; this.fadeV = 0; }
    }
    let rest = 0;
    for (const n of CLIPS) if (n !== this.clip) rest += this.weight[n];
    const k = rest > 0 ? (1 - cur) / rest : 0;
    for (const n of CLIPS) {
      const w = n === this.clip ? cur : this.weight[n] * k;
      this.dw[n] = dt > 0 ? (w - this.weight[n]) / dt : 0; this.weight[n] = w;
    }
    for (const n of CLIPS) {
      const a = this.actions[n];
      if (this.weight[n] > 0 || n === this.clip) a.setEffectiveWeight(this.weight[n]);
      else if (a.isScheduled()) a.setEffectiveWeight(0).stop();
    }
  }

  /** Mixer pass. It skips writing a bone whose blended value didn't change, so last frame's layers are undone first. */
  private mix(dt: number) {
    for (const [b, q] of this.base) this.bones[b].quaternion.copy(q);
    this.bones.hips.position.copy(this.hipPos);
    this.mixer.update(dt);
    for (const [b, q] of this.base) q.copy(this.bones[b].quaternion);
    this.hipPos.copy(this.bones.hips.position);
  }

  /** Procedural layer on top of the clip pose: the parts that must never freeze or switch abruptly. */
  private posture(dt: number, anim: string, speed: number) {
    // standing share, sprung: a 0 → 4.6 m/s step crosses the 0.15–1 m/s window in ~3 frames and would snap the weight-shift slide off
    [this.still, this.stillV] = spring(this.still, this.stillV, 1 - ss(0.15, 1, speed), STILL_W, 1, dt);
    const b = this.bones, t = this.t, still = Math.max(0, Math.min(1, this.still));
    // speed-driven lean: patrol → chase bends over continuously instead of swapping clips
    [this.lean, this.leanV] = spring(this.lean, this.leanV, leanFor(anim, speed), LEAN_W, 1, dt);
    this.leanV = Math.max(-LEAN_V, Math.min(LEAN_V, this.leanV));
    this.hunch();
    // inertia: setting off pitches him into the first step; pulling up throws the upper body on over the feet and the
    // knees give (the foot IK keeps the soles down, so the dropped hips bend them)
    const acc = Math.min(1, Math.max(0, Math.abs(this.speedV) - SURGE_DEAD) / SURGE_A) * Math.sign(this.speedV);
    [this.surge, this.surgeV] = spring(this.surge, this.surgeV, acc, SURGE_W, 1, dt);
    const sg = Math.abs(this.surge);
    pre(b.spine.quaternion, X, 0.09 * sg); pre(b.chest.quaternion, X, 0.06 * sg); pre(b.head.quaternion, X, -0.07 * sg);
    b.hips.position.y -= 0.035 * Math.max(0, -this.surge);
    // breathing: the chest opens on the in-breath, lower back gives a little, shoulders rise, gaze stays level
    const br = BREATH_AMP * (0.4 + 0.6 * still) * Math.sin(TAU * BREATH * t);
    pre(b.chest.quaternion, X, -br); pre(b.spine.quaternion, X, 0.4 * br);
    pre(b.shoulderL.quaternion, Z, 0.3 * br); pre(b.shoulderR.quaternion, Z, -0.3 * br);
    // weight shift foot to foot: the pelvis slides and rolls over the loaded leg, the legs swing about the hip joints
    // so the feet stay planted (ankles held within a few mm), the upper body counter-rolls to stay over them
    const ws = still * Math.sin(TAU * SHIFT * t);
    if (ws !== 0) {
      const dx = SHIFT_DX * ws, roll = SHIFT_ROLL * ws, hips = b.hips;
      const H = _h.copy(hips.quaternion), r = _r.setFromAxisAngle(Z, roll);
      hips.position.x += dx; hips.quaternion.premultiply(r);
      const Hinv = _h2.copy(hips.quaternion).invert();
      pre(b.spine.quaternion, Z, -0.5 * roll); pre(b.chest.quaternion, Z, -0.3 * roll);
      for (const [thigh, shin, foot] of LEGS) {
        const j = _v.copy(b[thigh].position).applyQuaternion(H), j2 = _v2.copy(j).applyQuaternion(r);
        const a = Math.asin(Math.max(-1, Math.min(1, -(dx + j2.x - j.x) / LEG)));
        const ra = _q2.setFromAxisAngle(Z, a), chain = _c.copy(H).multiply(b[thigh].quaternion).multiply(b[shin].quaternion); // H·T·S as the mixer left it
        b[thigh].quaternion.premultiply(H).premultiply(ra).premultiply(Hinv); // T' = H'⁻¹·Rz(α)·H·T
        b[foot].quaternion.premultiply(chain).premultiply(ra.invert()).premultiply(chain.invert()); // F' = C⁻¹·Rz(−α)·C·F: sole unchanged
      }
      pre(b.bag.quaternion, Z, -roll); // still hangs plumb
    }
    // head micro-motion: small, never-repeating drift (two incommensurate sines per axis) plus the breath counter-nod
    const m = 0.5 + 0.5 * still;
    b.head.quaternion.premultiply(_q.setFromEuler(_e.set(
      0.48 * br + m * 0.025 * (Math.sin(1.3 * t) + 0.6 * Math.sin(2.9 * t + 1)),
      m * 0.035 * (Math.sin(0.7 * t + 2) + 0.5 * Math.sin(1.9 * t)), 0)));
    // arms: the in-breath lifts them a touch off the body, plus a slow drift, so a held pose (look, catch) never freezes
    for (const [up, fore, s, ph] of ARMS) {
      pre(b[up].quaternion, Z, s * 0.6 * br);
      pre(b[up].quaternion, X, m * 0.03 * (Math.sin(0.9 * t + ph) + 0.5 * Math.sin(2.3 * t + 2 * ph)));
      pre(b[fore].quaternion, X, -m * 0.04 * (Math.sin(1.1 * t + 1.7 * ph) + 0.4 * Math.sin(2.7 * t + ph)));
    }
    this.swingBag(dt);
    if (this.deliberate) b.bag.quaternion.slerp(_q.identity(), 0.8); // a short snug strap restrains the adult's bag at the rear hip
  }

  /** Foot placement on top of the posture layer (see Foot). `v` = ground speed (model units / s), `wg` the gaits' share, `duty` their stance share. */
  private feet(dt: number, v: number, wg: number, duty: number) {
    const F = this.foot;
    this.root.updateWorldMatrix(true, false);
    const m = this.root.matrixWorld.elements, yaw = Math.atan2(m[8], m[10]), dy = wrap(yaw - this.yaw);
    this.yaw = yaw;
    const fresh = !this.primed || dt <= 0 || dt > 0.1 || Math.abs(dy) > 0.6; // first frame, hitch or a snapped heading: stand as posed
    this.primed = true;
    if (!fresh) this.yawRate += (dy / dt - this.yawRate) * (1 - Math.exp(-dt / 0.08));
    const g: GaitCfg = { stride: 0, duty, lift: 0 };
    if (wg > 0) for (const n of GAITS) {
      g.stride += this.weight[n] / (GAIT[n].stride * wg); g.lift += this.weight[n] * GAIT[n].lift / wg;
    }
    if (wg > 0) g.stride = 1 / g.stride; // matches the blended speed / stride phase rate
    for (let i = 0; i < 2; i++) {
      this.prevCa[i].copy(this.ca[i]);
      this.fk(i);
      if (wg > 0) {
        // Continuous foot targets share the stance solver's phase and sole pitch. Reconstructing them from
        // independently interpolated 30 Hz bone tracks changes their speed around heel strike / toe-off.
        const ph = (this.phase + (i ? 0.25 : 0.75)) % 1, [, , fp] = legPhase(ph, duty), [ay, az] = ankleAt(g, ph);
        this.ca[i].lerp(_fa.set(i ? -JOINT[0] : JOINT[0], ay, az), wg);
        this.cp[i] += (footPitch(fp) - this.cp[i]) * wg; this.cy[i] *= 1 - wg;
      }
    }
    const gaitOn = wg > 0.2 && this.speed > MOVING;
    const settingOff = gaitOn && !this.gaitMoving;
    this.gaitMoving = gaitOn;
    if (gaitOn) { this.sinceMove = 0; this.moveT += dt; } else { this.sinceMove += dt; this.moveT = 0; }
    this.rest -= dt;
    const c = Math.cos(dy), s = Math.sin(dy), dz = v * dt;
    const tr = (p: THREE.Vector3) => { const z = p.z - dz, x = p.x; p.x = x * c - z * s; p.z = x * s + z * c; return p; }; // a point on the floor into this frame's body frame
    const score = [0, 0];
    for (let i = 0; i < 2; i++) {
      const f = F[i], A = this.ca[i], cy = this.cy[i], rawPitch = this.cp[i], oldPitch = f.pitch;
      const pitchRate = dt > 0 ? (rawPitch - f.clipPitch) / dt : 0;
      if (settingOff && !f.step && !fresh) {
        f.pitchJoin = 0; f.pitchOff = oldPitch - f.clipPitch; f.pitchOffV = f.pitchVel - pitchRate;
      }
      f.clipPitch = rawPitch;
      let cp = rawPitch;
      if (f.pitchJoin >= 0) {
        f.pitchJoin += dt;
        const k = Math.min(1, f.pitchJoin / PITCH_JOIN);
        cp += f.pitchOff * (1 - h01(k)) + f.pitchOffV * PITCH_JOIN * h10(k);
        if (k >= 1) f.pitchJoin = -1;
      }
      const [stance, u] = legPhase((this.phase + (i ? 0.25 : 0.75)) % 1, duty);
      f.last.copy(f.at);
      if (fresh) { f.planted = true; f.step = false; f.pitch = cp; this.plant(f, A, cy); }
      else {
        if (f.planted) { tr(f.g); f.yaw -= dy; }
        if (f.step) tr(f.s);
        if (!f.step && gaitOn && stance && !f.planted) { f.planted = true; f.pitch = cp; this.plant(f, A, f.head); } // touchdown
        else if (!f.step && gaitOn && v > MOVING && !stance && f.planted && u < LIFT_LATE) { // lift-off: the swing starts from where the foot is
          // The smoothed stride keeps running after the body stops. Keep its support foot down until the airborne foot
          // lands; letting the chase's next flight start here would leave a stationary body with neither foot planted.
          // Carry the rolling contact to this instant before releasing it. Translating only last frame's ankle
          // omits the heel/toe roll since then, leaving an O(dt) position error at every lift-off.
          f.pitch = cp; this.onFloor(f);
          f.planted = false; f.u0 = u; f.off.copy(f.at).sub(A); f.offYaw = f.yaw - cy;
          // A closing/turning step can rejoin an already advancing swing. Position alone would inherit the
          // swing's current velocity in one frame; carry the release velocity into it on a Hermite tangent too.
          const clipV = tr(_fa.copy(this.prevCa[i])).sub(A).multiplyScalar(-1 / dt);
          f.offV.copy(f.at).sub(tr(_fb.copy(f.last))).divideScalar(dt).sub(clipV);
          f.swingT = (1 - u) * (1 - duty) / Math.max(this.rate, 1e-3);
        } else if (!f.step && !gaitOn && !f.planted) { // the stride stopped with this foot in the air: it carries on down under the hip
          f.step = true; f.k = 0; tr(f.s.copy(f.last)); f.v0.copy(f.vel); f.sYaw = f.head; f.sPitch = f.pitch; f.lift = 0;
          f.dur = Math.max(LAND_T, Math.min(STEP_T, ((1 - u) * (1 - duty)) / Math.max(this.rate, 1.2)));
        }
      }
      if (settingOff && f.step && (1 - f.k) * f.dur > LAND_T) {
        f.k = 0; f.dur = LAND_T; tr(f.s.copy(f.last)); f.v0.copy(f.vel);
        f.sYaw = f.head; f.sPitch = f.pitch; f.lift = 0;
      }
      if (f.step) { // standing step: Hermite from its start (carrying on at the start's velocity) to under the hip, lifted on the way
        const first = f.k === 0;
        f.k += dt / f.dur;
        const k = Math.min(1, f.k), d = Math.max(-0.6, Math.min(0.6, this.yawRate * (1.5 - k) * f.dur)); // lands half a step ahead of a turn going on
        // Finish the committed closing step under the hip even if locomotion resumes. Switching its endpoint
        // to the advancing gait as gaitOn crosses its threshold jumps the foot halfway through this step.
        const E = _fa.copy(this.home[i]), ex = E.x, ez = E.z, ey = 0;
        E.x = ex * Math.cos(d) + ez * Math.sin(d); E.z = -ex * Math.sin(d) + ez * Math.cos(d);
        const rz = roll(0)[1], end = _fb.copy(E);
        end.x -= Math.sin(ey + d) * rz; end.z -= Math.cos(ey + d) * rz; end.y = 0;
        if (first) f.end.copy(end);
        const endV = _fc.copy(end).sub(tr(f.end)).divideScalar(Math.max(dt, 1e-6)); f.end.copy(end);
        const a = h01(k), t = h10(k) * f.dur;
        f.at.set(f.s.x + (E.x - f.s.x) * a + f.v0.x * t, f.s.y + (E.y - f.s.y) * a + f.v0.y * t + f.lift * Math.sin(Math.PI * k) ** 2, f.s.z + (E.z - f.s.z) * a + f.v0.z * t);
        f.at.addScaledVector(endV, -(k ** 3 - k * k) * f.dur); // land at the floor's speed even when the endpoint is still moving
        f.head = f.sYaw + wrap(ey + d - f.sYaw) * a;
        f.pitch = f.sPitch * (1 - a) + (f.lift > 0 ? 0.22 * Math.sin(TAU * k) * Math.sin(Math.PI * k) ** 2 : 0); // heel off first, toe up to land
        f.at.y = Math.max(f.at.y, roll(f.pitch)[0]);
        if (f.k >= 1) {
          f.step = false; f.planted = true; this.plant(f, f.at, f.head); this.rest = STEP_REST;
          if (gaitOn) {
            f.pitchJoin = 0; f.pitchOff = f.pitch - rawPitch; f.pitchOffV = f.pitchVel - pitchRate;
          }
        }
      } else if (f.planted) { // held on the floor; the sole rolls on the clip's pitch (flat while the clip swings this leg)
        const want = gaitOn && !stance ? 0 : stance ? cp : cp * (1 - wg);
        f.pitch = gaitOn && stance ? cp : f.pitch + Math.max(-4 * dt, Math.min(4 * dt, want - f.pitch));
        const e = wrap(f.yaw - cy);
        if (Math.abs(e) > PIVOT) { // swivels on the floor about the ankle rather than wring the leg
          const rz = roll(f.pitch)[1], y0 = f.yaw;
          f.yaw = cy + Math.sign(e) * PIVOT; f.g.x += (Math.sin(y0) - Math.sin(f.yaw)) * rz; f.g.z += (Math.cos(y0) - Math.cos(f.yaw)) * rz;
        }
        this.onFloor(f);
        const ref = gaitOn ? A : this.home[i], dx = ref.x - f.at.x, dzz = ref.z - f.at.z, dist = Math.hypot(dx, dzz);
        if (dist > DRAG) { f.g.x += dx * (1 - DRAG / dist); f.g.z += dzz * (1 - DRAG / dist); this.onFloor(f); } // dragged along
        if (!gaitOn) score[i] = Math.hypot(this.home[i].x - f.at.x, this.home[i].z - f.at.z) / (this.sinceMove < 1.5 ? CLOSE : STEP_POS) + Math.abs(wrap(f.yaw) - 0.15 * this.yawRate) / STEP_YAW; // where it will be by the time a step could land
      } else { // stride swing: the lift-off offset fades out by touchdown
        const k = Math.max(0, Math.min(1, (u - f.u0) / Math.max(1e-3, 1 - f.u0))), fade = 1 - h01(k);
        f.at.copy(A).addScaledVector(f.off, fade).addScaledVector(f.offV, h10(k) * f.swingT);
        f.at.y += Math.max(0, -f.off.y) * 64 * k ** 3 * (1 - k) ** 3; // lift clear without adding velocity / acceleration at either contact
        f.head = cy + f.offYaw * fade; f.pitch = cp;
      }
      if (dt > 0) f.vel.copy(f.at).sub(tr(f.last)).divideScalar(dt); // over the floor
      if (dt > 0) f.pitchVel = (f.pitch - oldPitch) / dt;
    }
    // standing: the foot furthest off its place steps (one at a time, the other holding)
    const i = score[0] >= score[1] ? 0 : 1, f = F[i];
    if (!gaitOn && this.rest <= 0 && score[i] > 1 && !F[0].step && !F[1].step) {
      const off = Math.hypot(this.home[i].x - f.at.x, this.home[i].z - f.at.z);
      f.step = true; f.k = 0; f.s.copy(f.at); f.v0.set(0, 0, 0); f.sYaw = f.yaw; f.sPitch = f.pitch;
      f.lift = Math.min(STEP_LIFT, 0.03 + 0.3 * off); f.dur = STEP_T - 0.03 * Math.min(3, Math.abs(this.yawRate));
    }
    this.fitReach(dt);
    for (let j = 0; j < 2; j++) this.aim(j, F[j].at, F[j].head, F[j].pitch);
    const busy = F.some((q) => q.step || !q.planted) || Math.max(score[0], score[1]) > 1;
    this.loco = gaitOn ? (this.moveT < 0.5 ? 'start' : 'move') : Math.abs(this.yawRate) > 1.2 ? 'turn' : !busy ? 'idle' : this.sinceMove < 1.5 ? 'stop' : 'turn';
  }
  /** Plant foot f with its ankle at A (model frame) and heading `head`, its sole at f.pitch. */
  private plant(f: Foot, A: THREE.Vector3, head: number) {
    const rz = roll(f.pitch)[1];
    f.yaw = head; f.g.set(A.x - Math.sin(head) * rz, 0, A.z - Math.cos(head) * rz);
    this.onFloor(f);
  }
  /** A planted foot's ankle from its ground contact, heading and sole pitch. */
  private onFloor(f: Foot) {
    const [ry, rz] = roll(f.pitch);
    f.head = f.yaw; f.at.set(f.g.x + Math.sin(f.yaw) * rz, ry, f.g.z + Math.cos(f.yaw) * rz);
  }
  /** The clip's leg i as the mixer and posture layer left it: ankle and foot in the model frame, sole pitch, heading, reach. */
  private fk(i: number) {
    const b = this.bones, [tn, sn, fn] = LEGS[i], H = b.hips.quaternion;
    const q = this.cq[i].copy(H).multiply(b[tn].quaternion).multiply(b[sn].quaternion).multiply(b[fn].quaternion);
    const j = _fa.copy(b[fn].position).applyQuaternion(b[sn].quaternion).add(b[sn].position).applyQuaternion(b[tn].quaternion);
    this.ca[i].copy(j).add(b[tn].position).applyQuaternion(H).add(b.hips.position);
    const fwd = _fb.copy(Z).applyQuaternion(q);
    this.cp[i] = Math.atan2(-fwd.y, Math.hypot(fwd.x, fwd.z)); this.cy[i] = Math.atan2(fwd.x, fwd.z);
  }
  /** Carry the existing soft knee reach into pelvis height, rather than shortening the ankle target radially.
   *  The sole keeps its rolling contact and the knee enters its reach limit smoothly, before straightening. */
  private fitReach(dt: number) {
    const b = this.bones, hip = b.hips;
    let drop = -Infinity;
    for (let i = 0; i < 2; i++) {
      const j = _fa.copy(b[LEGS[i][0]].position).applyQuaternion(hip.quaternion).add(hip.position), at = this.foot[i].at;
      const len = j.distanceTo(at), reach = len <= SOFT ? len : SOFT + (REACH - SOFT) * Math.tanh((len - SOFT) / (REACH - SOFT));
      const dy = Math.sqrt(Math.max(1e-6, reach * reach - (at.x - j.x) ** 2 - (at.z - j.z) ** 2));
      const need = j.y - at.y - dy;
      drop = Number.isFinite(drop) ? reachMax(drop, need) : need;
    }
    // A foot leaving the floor must not instantly spring the pelvis back up. Recover on the posture spring,
    // then project onto the current reach constraint: recovery can lag, but a planted ankle never can.
    const needed = Number.isFinite(drop) ? reachMax(0, drop) : 0;
    const needV = this.reachNeed !== null && dt > 0 ? (needed - this.reachNeed) / dt : 0;
    this.reachNeed = needed;
    [this.reachDrop, this.reachV] = spring(this.reachDrop, this.reachV, 0, STILL_W, 1, dt);
    // A hard projection preserves position but changes velocity when the constraint takes over. This compact C2
    // envelope stays above both heights (so the sole still holds), adding at most 3.75 mm at the handover.
    const gap = this.reachDrop - needed, window = 0.02;
    if (gap < -window) { this.reachDrop = needed; this.reachV = needV; }
    else if (gap < window) {
      const d = gap / window, share = (1 + 1.5 * d - 0.5 * d ** 3) / 2;
      this.reachDrop = (this.reachDrop + needed + window * (3 / 8 + 3 / 4 * d * d - d ** 4 / 8)) / 2;
      this.reachV = this.reachV * share + needV * (1 - share);
    }
    hip.position.y -= this.reachDrop;
  }
  /** Two-bone IK to the requested ankle and sole orientation (model frame). Use the same yaw/pitch as onFloor:
   *  separately interpolated bone tracks can leave a residual roll in the clip FK, incompatible with that contact. */
  private aim(i: number, at: THREE.Vector3, yaw: number, pitch: number) {
    const b = this.bones, [tn, sn, fn] = LEGS[i], T = b[tn], S = b[sn], Fb = b[fn], H = b.hips.quaternion;
    const want = _fq.setFromAxisAngle(Y, yaw).multiply(_fq2.setFromAxisAngle(X, pitch));
    const d = _fa.copy(at).sub(b.hips.position).applyQuaternion(_fq3.copy(H).invert()).sub(T.position); // hip joint → ankle, hips frame
    let len = d.length();
    // fitReach keeps ordinary targets reachable. A snapped heading can still put an ankle horizontally beyond
    // either leg; cap only that unreachable fallback, never soften an already reachable ground contact.
    if (len > REACH) d.setLength(len = REACH);
    S.quaternion.setFromAxisAngle(X, Math.acos(Math.max(-1, Math.min(1, (len * len - L1 * L1 - L2 * L2) / (2 * L1 * L2)))));
    const v = _fb.copy(Fb.position).applyQuaternion(S.quaternion).add(S.position).applyQuaternion(T.quaternion).normalize();
    T.quaternion.premultiply(_fq2.setFromUnitVectors(v, d.normalize()));
    T.quaternion.premultiply(_fq2.setFromAxisAngle(d.negate(), KNEE_TWIST * wrap(yaw - this.cy[i]))); // about the ankle → hip line (≈ up)
    Fb.quaternion.copy(_fq3.copy(H).multiply(T.quaternion).multiply(S.quaternion).invert().multiply(want));
  }

  /** The chase hunch, weighted by `lean`. */
  private hunch() {
    for (const [n, a] of Object.entries(LEAN) as [BoneName, number][]) pre(this.bones[n].quaternion, X, a * this.lean);
  }
  /** Sling bag on a damped pendulum driven by the body's acceleration: it lags back when he sets off, swings forward
   *  when he stops and out on turns (the baked bagSwing already covers the stride's own sway). */
  private swingBag(dt: number) {
    const s = this.bag;
    this.root.updateWorldMatrix(true, false);
    const p = this.root.localToWorld(_v.copy(this.bagAt));
    if (!s.primed || dt > 0.1) { s.p.copy(p); s.v.set(0, 0, 0); s.a.set(0, 0, 0); s.primed = true; } // first frame / hitch: no fake jolt
    else if (dt > 1e-4) {
      const k = 1 - Math.exp(-dt / 0.05);
      const v = _v2.copy(p).sub(s.p).divideScalar(dt).sub(s.v).multiplyScalar(k); // Δ of the low-passed velocity
      s.p.copy(p); s.v.add(v);
      s.a.lerp(v.divideScalar(dt), k).clampLength(0, 30); // network snapshots are steppy: smooth and cap
      const a = this.tmp.copy(s.a).applyQuaternion(this.root.getWorldQuaternion(_q2).invert()); // model frame: +Z forward, +X his left
      [this.bagPitch, s.vp] = swing(this.bagPitch, s.vp, a.z / G, dt); // +x swings the bottom back
      [this.bagRoll, s.vr] = swing(this.bagRoll, s.vr, -a.x / G, dt);
    }
    pre(this.bones.bag.quaternion, Z, this.bagRoll); pre(this.bones.bag.quaternion, X, this.bagPitch);
  }

  /** Added on top of the clip's head pose (restored before every mixer pass). Off while the clip itself aims the head. */
  private lookAt(dt: number, target: THREE.Vector3 | null) {
    let yaw = 0, pitch = 0;
    const free = this.clip !== 'catch' && this.clip !== 'investigate' && this.clip !== 'look';
    if (target && free) {
      const head = this.bones.head;
      this.root.updateMatrixWorld();
      const local = this.bones.neck.worldToLocal(this.tmp.copy(target)); // neck frame ≈ model frame: +Z forward, +X his left
      if (local.length() < LOOK_RANGE && local.z > -0.2) {
        yaw = Math.max(-LOOK_MAX, Math.min(LOOK_MAX, Math.atan2(local.x, local.z)));
        pitch = Math.max(-0.4, Math.min(0.4, -Math.atan2(local.y - head.position.y, Math.hypot(local.x, local.z))));
      }
    }
    // second order, so the head eases into a turn: a first-order lag set off at full speed the frame a target appeared
    [this.lookYaw, this.lookYawV] = spring(this.lookYaw, this.lookYawV, yaw, LOOK_W, 1, dt);
    [this.lookPitch, this.lookPitchV] = spring(this.lookPitch, this.lookPitchV, pitch, LOOK_W, 1, dt);
    this.bones.neck.rotateY(this.lookYaw * 0.35);
    this.bones.head.rotateY(this.lookYaw * 0.65).rotateX(this.lookPitch);
  }
}
