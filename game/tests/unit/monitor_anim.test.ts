import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { BONES, MATS } from '../../client/src/warden/model.ts';
import type { BoneName, Warden } from '../../client/src/warden/model.ts';
import { MONITOR_SPEED } from '../../server/ai/monitor.ts';
import { TICK_MS } from '../../shared/constants.ts';

// Build the real skinned figures; only their canvas painting is replaced in this node suite.
const ctx2d: any = new Proxy(function () {}, { get: (_, k) => (k === 'measureText' ? () => ({ width: 1 }) : ctx2d), apply: () => ctx2d, set: () => true });
vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }) });
const { Mobs } = await import('../../client/src/mobs.ts');
const { MonitorAnimator, MONITOR_GAIT } = await import('../../client/src/warden/monitorAnim.ts');

const dt = 1 / 60;
const angle = (q: THREE.Quaternion) => q.angleTo(new THREE.Quaternion());
const atPosition = (mesh: THREE.Object3D, p: [number, number, number]) => expect(mesh.position.distanceTo(new THREE.Vector3(...p))).toBeLessThan(1e-9);
const pose = (w: Warden) => BONES.map((n) => ({ p: w.bones[n].position.clone(), q: w.bones[n].quaternion.clone() }));
const samePose = (w: Warden, before: ReturnType<typeof pose>) => BONES.forEach((n, i) => {
  expect(w.bones[n].position.distanceTo(before[i].p), `${n} position`).toBeLessThan(1e-9);
  expect(w.bones[n].quaternion.angleTo(before[i].q), `${n} rotation`).toBeLessThan(1e-7);
});
const inModel = (w: Warden, n: BoneName) => w.mesh.worldToLocal(w.bones[n].getWorldPosition(new THREE.Vector3()));

function make(anim = 'idle') {
  const mobs = new Mobs(new THREE.Scene());
  mobs.onSnap([{ id: 2, kind: 'monitor', p: [0, 0, 0], yaw: 0, anim }], 0);
  const o = mobs.byId.get(2)!;
  return { mobs, o };
}

/** Actual shoe vertices in the foot's bind frame, without an assumed sole shape or a copy of the IK. */
function shoe(w: Warden, foot: 'footL' | 'footR') {
  const g = w.mesh.geometry, group = g.groups.find((v) => v.materialIndex === MATS.indexOf('shoe'))!;
  const position = g.getAttribute('position'), indices = g.getAttribute('skinIndex'), weights = g.getAttribute('skinWeight');
  const bi = BONES.indexOf(foot), vertices = new Set<number>();
  for (let k = group.start; k < group.start + group.count; k++) {
    const i = g.index?.getX(k) ?? k;
    if (indices.getX(i) === bi && weights.getX(i) > 0.999) vertices.add(i);
  }
  expect(vertices.size).toBeGreaterThan(30);
  return [...vertices].map((i) => new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(w.mesh.bindMatrix).applyMatrix4(w.mesh.skeleton.boneInverses[bi]));
}

/** Geometric acceptance: hands at the trouser seams, elbows straight, torso and gaze level. */
function attention(w: Warden) {
  w.root.updateMatrixWorld(true);
  for (const side of ['L', 'R'] as const) {
    const hand = inModel(w, `hand${side}`), upper = inModel(w, `upperArm${side}`), elbow = inModel(w, `foreArm${side}`);
    expect(hand.y, `${side} hand height`).toBeGreaterThan(0.75);
    expect(hand.y, `${side} hand height`).toBeLessThan(1.0);
    expect(Math.abs(hand.x), `${side} hand at side`).toBeGreaterThan(0.2);
    expect(Math.abs(hand.x), `${side} hand at trouser seam`).toBeLessThan(0.24);
    expect(Math.abs(hand.z), `${side} hand front/back`).toBeLessThan(0.09);
    expect(elbow.clone().sub(upper).angleTo(hand.clone().sub(elbow)), `${side} elbow bend`).toBeLessThan(0.22);
    for (const part of ['hand', 'fingers', 'fingers2'] as const) expect(angle(w.bones[`${part}${side}`].quaternion), `${part}${side}`).toBeLessThan(0.2);
  }
  for (const n of ['hips', 'spine', 'chest', 'neck', 'head'] as const) expect(angle(w.bones[n].quaternion), n).toBeLessThan(0.12);
}

/** Leave several run snapshots ahead of playback, as there are when the server first sees a watching player. */
function running() {
  const { mobs, o } = make('run');
  for (let k = 1; k <= 30; k++) {
    mobs.onSnap([{ id: 2, p: [k * MONITOR_SPEED * TICK_MS / 1000, 0, 0], yaw: 0 }], k * TICK_MS);
    for (let j = 0; j < 3; j++) mobs.update(k * TICK_MS + j * 1000 * dt, dt);
  }
  return { mobs, o, now: 30 * TICK_MS + 2 * 1000 * dt };
}

describe('值日生 dedicated animation', () => {
  it('constructs the first freeze snapshot standing at attention', () => {
    const { o } = make('freeze');
    expect(o.monitorAnim).toBeInstanceOf(MonitorAnimator);
    attention(o.warden); // no rendered update has run: the first visible frame must already be valid
  });

  it('keeps both hands at the seams through the entire former glasses-push interval, without tracking heads', () => {
    const { mobs, o } = make();
    const before = pose(o.warden);
    for (let k = 0; k < 7 * 60; k++) {
      mobs.update(k * 1000 * dt, dt, [new THREE.Vector3(3, 1.7, -3)]);
      attention(o.warden);
    }
    samePose(o.warden, before);
    expect(o.monitorAnim!.phase).toBe(0);
  });

  it('runs with straight elbows and open fingers while the legs actually stride', () => {
    const { mobs, o } = make('run');
    const thighs: number[] = [], hands: number[] = [];
    for (let k = 0; k < 120; k++) {
      if (k % 3 === 0) mobs.onSnap([{ id: 2, p: [0, 0, -k * MONITOR_SPEED * dt], yaw: 0 }], k * 1000 * dt);
      mobs.update(k * 1000 * dt, dt, [new THREE.Vector3(3, 1.7, -3)]);
      o.mesh.updateMatrixWorld(true);
      thighs.push(o.warden.bones.thighL.rotation.x);
      hands.push(inModel(o.warden, 'handL').z);
      for (const side of ['L', 'R'] as const) {
        expect(angle(o.warden.bones[`foreArm${side}`].quaternion), `${side} elbow`).toBeLessThan(0.3);
        for (const part of ['hand', 'fingers', 'fingers2'] as const) expect(angle(o.warden.bones[`${part}${side}`].quaternion), `${part}${side}`).toBeLessThan(0.2);
      }
      for (const n of ['spine', 'chest', 'neck', 'head'] as const) expect(angle(o.warden.bones[n].quaternion), n).toBeLessThan(0.2);
    }
    expect(Math.max(...thighs) - Math.min(...thighs)).toBeGreaterThan(0.7);
    expect(Math.max(...hands) - Math.min(...hands)).toBeLessThan(0.3); // stiff arms, far below an ordinary pumping sprint
  });

  it('gives the same leg pose for the same distance at different speeds and frame rates', () => {
    const advance = (speed: number, frame: number) => {
      const { o } = make('run'), anim = o.monitorAnim!;
      const distance = 3.9, steps = Math.round(distance / (speed * frame)), step = distance / steps;
      for (let k = 0; k < steps; k++) {
        o.mesh.position.z -= step;
        anim.update(step / speed, speed, 'run');
      }
      return o;
    };
    const a = advance(MONITOR_SPEED, 1 / 60), b = advance(MONITOR_SPEED / 2, 1 / 24);
    expect(a.monitorAnim!.phase).toBeCloseTo(b.monitorAnim!.phase, 9);
    for (const n of ['thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR'] as const) expect(a.warden.bones[n].quaternion.angleTo(b.warden.bones[n].quaternion), n).toBeLessThan(1e-6);
  });

  for (const speed of [MONITOR_SPEED, MONITOR_SPEED / 2]) it(`plants the real shoe on the floor at ${speed} m/s with the tall, narrow build`, () => {
    const { o } = make('run'), w = o.warden, anim = o.monitorAnim!, frame = 1 / 120;
    expect(w.mesh.scale.toArray()).toEqual([0.9, 1.1, 0.9]); // stride and leg height use different world scales
    const soles = [shoe(w, 'footL'), shoe(w, 'footR')], frames: { phase: number; feet: THREE.Matrix4[] }[] = [];
    let lowest = Infinity, highest = 0;
    for (let k = 0; k < 240; k++) {
      o.mesh.position.z -= speed * frame;
      anim.update(frame, speed, 'run');
      w.root.updateMatrixWorld(true);
      const feet = [w.bones.footL.matrixWorld.clone(), w.bones.footR.matrixWorld.clone()];
      frames.push({ phase: anim.phase, feet });
      for (let side = 0; side < 2; side++) {
        const y = Math.min(...soles[side].map((p) => p.clone().applyMatrix4(feet[side]).y));
        lowest = Math.min(lowest, y); highest = Math.max(highest, y);
      }
    }
    expect(lowest, 'shoe must not pass through the floor').toBeGreaterThan(-0.01);
    expect(highest, 'swinging shoe visibly leaves the floor').toBeGreaterThan(0.07);
    let samples = 0, worst = 0;
    for (let i = 30; i < frames.length - 1; i++) for (let side = 0; side < 2; side++) {
      const u = ((frames[i].phase + side * 0.5) % 1) / MONITOR_GAIT.duty;
      if (u < 0.2 || u > 0.8) continue; // central support only; touchdown and toe-off are separate transitions
      const contact = soles[side].reduce((a, b) => a.clone().applyMatrix4(frames[i].feet[side]).y <= b.clone().applyMatrix4(frames[i].feet[side]).y ? a : b);
      const a = contact.clone().applyMatrix4(frames[i - 1].feet[side]), b = contact.clone().applyMatrix4(frames[i + 1].feet[side]);
      worst = Math.max(worst, Math.hypot(b.x - a.x, b.z - a.z) / (2 * frame) / speed);
      samples++;
    }
    expect(samples).toBeGreaterThan(30);
    expect(worst, 'planted shoe world speed / body speed').toBeLessThan(0.1);
  });
});

describe('值日生 authoritative stops and warps', () => {
  it('freezes its position, yaw, every bone and stride phase even with unplayed run snapshots', () => {
    const { mobs, o, now } = running(), before = pose(o.warden), phase = o.monitorAnim!.phase;
    const p: [number, number, number] = [31 * MONITOR_SPEED * TICK_MS / 1000, 0, 0.05], yaw = 1.3;
    expect(o.mesh.position.distanceTo(new THREE.Vector3(...p))).toBeGreaterThan(0.3);
    mobs.onSnap([{ id: 2, anim: 'freeze', p, yaw }], 31 * TICK_MS);
    for (let k = 1; k <= 30; k++) {
      mobs.update(now + k * 1000 * dt, dt, [new THREE.Vector3(-3, 2, 3)]);
      atPosition(o.mesh, p);
      expect(o.mesh.rotation.y).toBe(yaw);
      expect(o.monitorAnim!.phase).toBe(phase);
      samePose(o.warden, before);
    }
    // Delta snapshots omit anim: a frozen figure must stay frozen.
    mobs.onSnap([{ id: 2, p, yaw }], 32 * TICK_MS);
    mobs.update(now + 600, dt);
    expect(o.monitorAnim!.frozen).toBe(true);
    samePose(o.warden, before);
  });

  it('stops at attention immediately on idle without replaying unplayed run snapshots', () => {
    const { mobs, o, now } = running(), phase = o.monitorAnim!.phase;
    const p: [number, number, number] = [31 * MONITOR_SPEED * TICK_MS / 1000, 0, 0.05], yaw = 0.9;
    expect(o.mesh.position.distanceTo(new THREE.Vector3(...p))).toBeGreaterThan(0.3);
    mobs.onSnap([{ id: 2, anim: 'idle', p, yaw }], 31 * TICK_MS);
    atPosition(o.mesh, p); // the stop must already be authoritative before another rendered update
    expect(o.mesh.rotation.y).toBe(yaw);
    expect(o.monitorAnim!.phase).toBe(phase);
    attention(o.warden);
    const stopped = pose(o.warden);
    for (let k = 1; k <= 30; k++) {
      mobs.update(now + k * 1000 * dt, dt, [new THREE.Vector3(-3, 2, 3)]);
      atPosition(o.mesh, p);
      expect(o.mesh.rotation.y).toBe(yaw);
      expect(o.monitorAnim!.phase).toBe(phase);
      attention(o.warden);
      samePose(o.warden, stopped);
    }
    // Delta snapshots omit anim: idle must keep the stop and standing pose.
    mobs.onSnap([{ id: 2, p, yaw }], 32 * TICK_MS);
    mobs.update(now + 600, dt);
    atPosition(o.mesh, p);
    expect(o.monitorAnim!.phase).toBe(phase);
    samePose(o.warden, stopped);
  });

  it('lands on each blink snapshot without counting the jump as a stride', () => {
    const { mobs, o, now } = running(), phase = o.monitorAnim!.phase;
    mobs.blink(now, 0.2);
    for (let k = 1; k <= 3; k++) {
      const p: [number, number, number] = [(30 + k) * MONITOR_SPEED * TICK_MS / 1000, 0, 0.1 * k];
      mobs.onSnap([{ id: 2, p, yaw: k * 0.5 }], (30 + k) * TICK_MS);
      mobs.update(now + k * TICK_MS, dt);
      atPosition(o.mesh, p);
      expect(o.mesh.rotation.y).toBe(k * 0.5);
      expect(o.monitorAnim!.phase).toBe(phase);
    }
    const landed = o.mesh.position.clone();
    mobs.update(now + 500, dt);
    expect(o.mesh.position.distanceTo(landed)).toBeLessThan(1e-9);
    expect(o.monitorAnim!.phase).toBe(phase);
  });

  for (const displacement of [[3.1, 0, 0], [0, 3.6, 0]] as const) it(`teleports ${displacement.join(',')} in one frame without a stride or later drift`, () => {
    const { mobs, o, now } = running(), phase = o.monitorAnim!.phase;
    const p: [number, number, number] = [30 * MONITOR_SPEED * TICK_MS / 1000 + displacement[0], displacement[1], displacement[2]], yaw = -1.1;
    mobs.onSnap([{ id: 2, p, yaw }], 31 * TICK_MS);
    for (let k = 1; k <= 20; k++) {
      mobs.update(now + k * 1000 * dt, dt);
      atPosition(o.mesh, p);
      expect(o.mesh.rotation.y).toBe(yaw);
      expect(o.monitorAnim!.phase).toBe(phase);
    }
  });
});
