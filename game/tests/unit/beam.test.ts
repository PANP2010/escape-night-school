import { describe, expect, it } from 'vitest';
import { beamHit } from '../../shared/campus/nav.ts';
import { box, CollisionWorld } from '../../shared/campus/collision.ts';

describe('beamHit (teammate torch spot)', () => {
  const n = (x: number, y: number, z: number) => { const l = Math.hypot(x, y, z); return { x: x / l, y: y / l, z: z / l }; };

  it('lands on the ground plane, normal up', () => {
    const h = beamHit(new CollisionWorld(), { x: 0, y: 1, z: 0 }, n(0, -1, -1), 10)!;
    expect(h.t).toBeCloseTo(Math.SQRT2, 6);
    expect([h.nx, h.ny, h.nz]).toEqual([0, 1, 0]);
  });

  it('hits the nearer wall face before the ground, normal towards the ray', () => {
    const w = new CollisionWorld([box(0, -2.1, 4, 0.2, 3)]); // wall face at z = -2
    const h = beamHit(w, { x: 0, y: 1, z: 0 }, n(0, -0.2, -1), 10)!;
    expect(h.t).toBeCloseTo(2 * Math.hypot(1, 0.2), 6);
    expect([h.nx, h.ny, h.nz]).toEqual([0, 0, 1]);
    const side = beamHit(w, { x: 5, y: 1, z: -2.1 }, n(-1, 0, 0), 10)!; // from +x: the wall's x = 2 end face
    expect(side.t).toBeCloseTo(3, 6);
    expect(side.nx).toBe(1);
  });

  it('nothing within reach, a hole in the ground, or a box the ray starts in → null', () => {
    expect(beamHit(new CollisionWorld(), { x: 0, y: 1, z: 0 }, n(0, -0.1, -1), 5)).toBeNull();
    const holed = new CollisionWorld();
    holed.addHole(-5, 5, -5, 5);
    expect(beamHit(holed, { x: 0, y: 1, z: 0 }, n(0, -1, -1), 10)).toBeNull();
    // inside a slab-free room box (e.g. a trigger volume the size of the corridor): skipped, the floor below still counts
    const inside = new CollisionWorld([box(0, 0, 20, 20, 3)]);
    expect(beamHit(inside, { x: 0, y: 1, z: 0 }, n(0, -1, 0), 10)!.t).toBeCloseTo(1, 6);
  });

  it('an upper-storey slab top catches a downward beam (normal up)', () => {
    const w = new CollisionWorld([box(0, 0, 10, 10, 0.2, 3.8)]); // slab 3.8–4.0
    const h = beamHit(w, { x: 0, y: 5.5, z: 0 }, n(0, -1, -1), 10)!;
    expect(h.t).toBeCloseTo(1.5 * Math.SQRT2, 6);
    expect(h.ny).toBe(1);
  });
});
