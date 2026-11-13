import { expect, test } from 'vitest';
import * as THREE from 'three';
import { MATS, Warden, buildWardenGeometry } from '../../client/src/warden/model.ts';
import { STRIDE, POSTURE, buildClips } from '../../client/src/warden/anim.ts';
import { createHash } from 'node:crypto';
import { WardenAI, WARDEN_CHASE_SPEED, type WardenEnv } from '../../server/ai/warden.ts';
import { NavGraph } from '../../shared/campus/nav.ts';
import { SPEED } from '../../shared/constants.ts';
import { mulberry32 } from '../../shared/rng.ts';

const materials = () => MATS.map(() => new THREE.MeshBasicMaterial());

test('the original 1.75 m teacher keeps its authored scale; student and monitor scales stay separate', () => {
  const teacher = new Warden(materials()), student = new Warden(materials(), false), monitor = new Warden(materials(), false, 'monitor');
  teacher.anim.pose('idle', 0);
  teacher.root.updateMatrixWorld(true);
  teacher.mesh.computeBoundingBox();
  const box = teacher.mesh.boundingBox!.clone().applyMatrix4(teacher.mesh.matrixWorld);
  expect(box.max.y).toBeGreaterThan(1.70);
  expect(box.max.y).toBeLessThan(1.82);
  expect(teacher.mesh.scale.toArray()).toEqual([1, 1, 1]);
  expect(box.min.y).toBeLessThan(0.01);
  expect(box.max.x - box.min.x).toBeLessThan(0.85); // fits a 1 m door; authoritative capsule stays unchanged
  expect(student.mesh.scale.toArray()).toEqual([1, 1, 1]);
  expect(monitor.mesh.scale.toArray()).toEqual([0.9, 1.1, 0.9]);
});

test('the restored teacher retains deliberate gestures while measured speed drives his original-sized stride', () => {
  const teacher = new Warden(materials()), student = new Warden(materials(), false);
  for (let i = 0; i < 60; i++) { teacher.update(1 / 60, 0, 'catch'); student.update(1 / 60, 0, 'catch'); }
  expect(teacher.anim.actions.catch.time).toBeCloseTo(0.72, 2);
  expect(student.anim.actions.catch.time).toBeCloseTo(1, 2);
  for (let i = 0; i < 180; i++) { teacher.root.position.z -= WARDEN_CHASE_SPEED / 60; teacher.update(1 / 60, WARDEN_CHASE_SPEED, 'chase'); }
  const rate = (teacher.anim as unknown as { rate: number }).rate;
  expect(rate * STRIDE.chase * teacher.mesh.scale.z).toBeCloseTo(WARDEN_CHASE_SPEED, 2);
});

test('the slower chase still catches a walking player, while sprinting opens distance', () => {
  const graph = new NavGraph();
  graph.chain([{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -100 }]);
  const env: WardenEnv = { graph, rng: mulberry32(3), los: () => true, walkable: () => true };
  const chase = (speed: number) => {
    const w = new WardenAI(env, 0), p = { id: 1, p: [0, 0, -4] as [number, number, number], yaw: 0, f: 0 };
    w.forceChase([0, 0, 0], 0, p.id, p.p);
    let caughtAt = Infinity;
    for (let i = 0; i < 12 / 0.05; i++) {
      p.p[2] -= speed * 0.05;
      w.step(0.05, [p]);
      if (w.caught.length) { caughtAt = i * 0.05; break; }
    }
    return { caughtAt, distance: Math.hypot(w.p[0] - p.p[0], w.p[2] - p.p[2]) };
  };
  expect(WARDEN_CHASE_SPEED).toBeGreaterThan(SPEED.walk);
  expect(WARDEN_CHASE_SPEED).toBeLessThan(SPEED.run);
  const walk = chase(SPEED.walk), sprint = chase(SPEED.run);
  expect(walk.caughtAt).toBeGreaterThan(6);
  expect(walk.caughtAt).toBeLessThan(12);
  expect(sprint.caughtAt).toBe(Infinity);
  expect(sprint.distance).toBeGreaterThan(10);
});

test('a form can increase hearing without changing noise events or chase rules', () => {
  const graph = new NavGraph();
  graph.chain([{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -20 }]);
  const env: WardenEnv = { graph, rng: mulberry32(3), los: () => true };
  const normal = new WardenAI(env, 0), night = new WardenAI({ ...env, hearingMultiplier: () => 1.5 }, 0);
  const event = { kind: 'item' as const, x: 0, y: 0, z: -8, r: 6 };
  normal.hear(event); night.hear(event);
  expect(normal.state).toBe('patrol');
  expect(night.state).toBe('investigate');
  expect(event.r).toBe(6);
});

test('the restored teacher keeps the authored sling-bag pivot and original standing posture', () => {
  const w = new Warden(materials());
  expect(w.bones.bag.position.toArray()).toEqual([-0.245, 0.040000000000000036, 0]);
  const clips = buildClips(w.bones.hips.position.clone(), POSTURE);
  const expected = clips.idle.tracks.find(t => t.name === 'head.quaternion')!;
  const actual = w.anim.actions.idle.getClip().tracks.find(t => t.name === 'head.quaternion')!;
  expect(actual.values).toEqual(expected.values);
});

const geometryDigest = (geometry: THREE.BufferGeometry) => {
  const hash = createHash('sha256');
  for (const name of Object.keys(geometry.attributes).sort()) {
    const a = geometry.attributes[name].array;
    hash.update(name); hash.update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  }
  const index = geometry.index!.array;
  hash.update(new Uint8Array(index.buffer, index.byteOffset, index.byteLength));
  return hash.digest('hex');
};
// Captured from the user's original code-built geometry with this Three.js version, before applying the restoration.
test.each([
  ['warden', true, 'f3a1b991477fd23936ec8bedc94cb600caf8c631e06e234d0cc3bb71bd7a7b17'],
  ['student', false, '89f0fc66a9658fa9ff00a6ddf53d4f8b64e0ebf8c593357bfdc4918a4a15c9e2'],
  ['monitor', false, '9dcaf980fb1bc439d3d9a39130019004f5f4e923f339519190f42eb140c6cda3'],
] as const)('preserves the original %s geometry identity', (build, claws, expected) => {
  const geometry = buildWardenGeometry(claws, build);
  expect(geometryDigest(geometry)).toBe(expected);
  geometry.dispose();
});
