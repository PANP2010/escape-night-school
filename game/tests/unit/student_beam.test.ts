import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { beamHit } from '../../shared/campus/nav.ts';
import { box, CollisionWorld } from '../../shared/campus/collision.ts';
import { TORCH_DECAY } from '../../client/src/campus/render/interior_light.ts';

// the avatar paints its textures on canvases: a 2D context that swallows every call is enough here
const ctx2d: any = new Proxy(function () {}, { get: (_, k) => (k === 'measureText' ? () => ({ width: 1 }) : ctx2d), apply: () => ctx2d, set: () => true });
vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }) });
const { Student, BEAM_LEN, spotGain } = await import('../../client/src/warden/student.ts');

function aim(world: CollisionWorld, pitch: number, light = true, crouch = false) {
  const s = new Student(0x3366aa);
  s.root.position.set(0, 0, 0);
  s.update(crouch ? 1 : 0.016, 0, crouch, light, pitch, 5);
  s.root.updateMatrixWorld(true);
  const o = new THREE.Vector3(), d = new THREE.Vector3();
  s.beam(o, d);
  const hit = beamHit(world, o, d, BEAM_LEN);
  s.land(hit);
  s.spot.updateMatrixWorld();
  const cone = s.root.children.find((c) => c instanceof THREE.Mesh && (c.material as THREE.Material).type === 'ShaderMaterial')!;
  return { s, o, d, hit, cone };
}

describe('teammate torch beam', () => {
  it('keeps the student face at the dim body level after construction and pose updates', () => {
    const s = new Student(0x3366aa);
    const [face, skin] = s.warden.mesh.material as THREE.MeshStandardMaterial[];
    const dimFace = () => {
      expect(face.emissiveIntensity).toBe(skin.emissiveIntensity);
      expect(face.emissiveIntensity).toBeLessThan(0.1);
      expect(face.emissiveMap).toBe(face.map);
    };
    dimFace();
    for (const down of [false, true, false]) {
      s.update(0.2, 2, false, false, 0, 5, down);
      dimFace();
    }
    s.dispose();
  });

  it.each([false, true])('lands on the floor 3–6 m ahead at pitch -0.4, with the cone cut there (crouch=%s)', (crouch) => {
    const { s, o, d, hit, cone } = aim(new CollisionWorld(), -0.4, true, crouch);
    expect(d.z).toBeLessThan(-0.9); // -Z = facing
    expect(hit).not.toBeNull();
    expect(hit!.t).toBeCloseTo(o.y / -d.y, 4);
    const ahead = -o.z - d.z * hit!.t;
    expect(ahead).toBeGreaterThanOrEqual(3);
    expect(ahead).toBeLessThanOrEqual(6);
    expect(s.spot.visible).toBe(true);
    const p = new THREE.Vector3().setFromMatrixPosition(s.spot.matrixWorld);
    expect(p.y).toBeCloseTo(0.01, 4);
    expect(p.z).toBeCloseTo(o.z + d.z * hit!.t, 4);
    const n = new THREE.Vector3(0, 0, 1).transformDirection(s.spot.matrixWorld);
    expect(n.y).toBeCloseTo(1, 4);
    expect(cone.scale.x).toBeCloseTo(hit!.t / BEAM_LEN, 6);
    // grazing floor hit: the spot stretches along the beam
    const sx = new THREE.Vector3().setFromMatrixColumn(s.spot.matrixWorld, 0).length();
    const sy = new THREE.Vector3().setFromMatrixColumn(s.spot.matrixWorld, 1).length();
    expect(sx).toBeGreaterThan(sy * 1.5);
  });

  it('a wall in the way takes the spot, normal back towards the teammate', () => {
    const { s, hit } = aim(new CollisionWorld([box(0, -2.1, 4, 0.2, 3)]), 0);
    expect(hit!.t).toBeCloseTo(2 - 0.35, 2);
    const n = new THREE.Vector3(0, 0, 1).transformDirection(s.spot.matrixWorld);
    expect(n.z).toBeCloseTo(1, 4);
  });

  it('no spot when the light is off or nothing is within reach; full-length cone then', () => {
    expect(aim(new CollisionWorld(), -0.35, false).s.spot.visible).toBe(false);
    const up = aim(new CollisionWorld(), 0.5);
    expect(up.hit).toBeNull();
    expect(up.s.spot.visible).toBe(false);
    expect(up.cone.scale.x).toBe(1);
    // turning the light off after a hit hides the spot on the next update
    const { s } = aim(new CollisionWorld(), -0.35);
    s.update(0.016, 0, false, false, -0.35, 5);
    expect(s.spot.visible).toBe(false);
  });

  it('spot is dimmer further away and when grazing', () => {
    expect(spotGain(2, 1)).toBeGreaterThan(spotGain(5, 1));
    expect(spotGain(3, 1)).toBeGreaterThan(spotGain(3, 0.2));
    expect(spotGain(0, 1)).toBeLessThanOrEqual(1);
  });

  it('torch decay marks hand-held lights for the interior pass, not the street lamps (1.6) ', () => {
    expect(TORCH_DECAY).toBeGreaterThan(1.6);
    expect(TORCH_DECAY).toBeLessThanOrEqual(2); // flashlight + teamLights use decay 2
  });
});
