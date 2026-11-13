import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { CollisionWorld } from '../../shared/campus/collision.ts';
import { beamHit } from '../../shared/campus/nav.ts';

const ctx2d: any = new Proxy(function () {}, { get: (_, k) => (k === 'measureText' ? () => ({ width: 1 }) : ctx2d), apply: () => ctx2d, set: () => true });
vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }) });
const { Student, BEAM_LEN } = await import('../../client/src/warden/student.ts');

describe('teammate torch direction from behind', () => {
  it('lights the floor 3–6 m ahead when looking down slightly, including the review #225 heading', () => {
    const world = new CollisionWorld();
    for (const yaw of [0, Math.PI / 2, Math.PI / 2 + 0.3, -Math.PI + 0.3]) {
      const s = new Student(0x3366aa);
      s.root.position.set(-5, 0, 0);
      s.root.rotation.y = yaw;
      s.update(1 / 60, 0, false, true, -0.4, 5);
      const o = new THREE.Vector3(), d = new THREE.Vector3();
      s.beam(o, d);
      const hit = beamHit(world, o, d, BEAM_LEN);
      expect(hit, `yaw ${yaw}`).not.toBeNull();
      s.land(hit);
      s.spot.updateMatrixWorld();
      const pool = new THREE.Vector3().setFromMatrixPosition(s.spot.matrixWorld);
      const fromBody = pool.clone().sub(s.root.position);
      const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
      const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
      expect(fromBody.dot(forward), `yaw ${yaw}`).toBeGreaterThanOrEqual(3);
      expect(fromBody.dot(forward), `yaw ${yaw}`).toBeLessThanOrEqual(6);
      expect(Math.abs(fromBody.dot(right)), `yaw ${yaw}`).toBeLessThan(0.5);
      expect(pool.y).toBeCloseTo(0.01, 5);
      expect(s.spot.visible).toBe(true);
      s.dispose();
    }
  });
});
