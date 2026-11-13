import { describe, expect, it } from 'vitest';
import { HeadBob, bobAmp, bobStep } from '../../client/src/bob.ts';
import { SPEED } from '../../shared/constants.ts';

const DT = 1 / 60;
/** Runs the bob at a constant ground speed; returns the y offsets and the number of dips (footfalls). */
function walk(bob: HeadBob, v: number, secs: number, still = false) {
  const ys: number[] = [];
  for (let i = 0; i < secs / DT; i++) ys.push(bob.step(v * DT, DT, still));
  let dips = 0;
  for (let i = 1; i < ys.length - 1; i++) if (ys[i] < ys[i - 1] && ys[i] <= ys[i + 1]) dips++;
  return { ys, dips };
}

describe('head bob', () => {
  it('is flat when standing, crouching / hidden, or blocked by a wall', () => {
    expect(walk(new HeadBob(), 0, 2).ys.every((y) => y === 0)).toBe(true);
    expect(walk(new HeadBob(), SPEED.run, 2, true).ys.every((y) => y === 0)).toBe(true);
    const bob = new HeadBob();
    walk(bob, SPEED.run, 2);
    const phase = bob.phase, stopped = walk(bob, 0, 1); // ran into a wall: no ground covered
    expect(bob.phase).toBe(phase); // phase frozen: no footfalls without feet moving
    expect(stopped.dips).toBe(0);
    expect(Math.abs(stopped.ys.at(-1)!)).toBeLessThan(0.001); // and the bob fades out with the speed
  });
  it('footfalls follow ground covered: walk ≈ 2.2 steps/s, run ≈ 2.9 steps/s', () => {
    for (const v of [SPEED.walk, SPEED.run]) {
      const bob = new HeadBob();
      walk(bob, v, 1); // settle the speed estimate
      const { dips } = walk(bob, v, 10);
      expect(dips / 10).toBeCloseTo(v / bobStep(v), 0);
      expect(dips / 10).toBeGreaterThan(1.8); expect(dips / 10).toBeLessThan(3.2);
    }
  });
  it('a few centimetres deep, deeper when running, never above eye height', () => {
    for (const v of [SPEED.crouch, SPEED.walk, SPEED.run]) {
      const { ys } = walk(new HeadBob(), v, 4);
      const depth = -Math.min(...ys.slice(60));
      expect(Math.max(...ys)).toBeLessThanOrEqual(0);
      expect(depth).toBeCloseTo(bobAmp(v), 3);
      expect(depth).toBeLessThanOrEqual(0.026);
    }
    expect(bobAmp(SPEED.run)).toBeGreaterThan(bobAmp(SPEED.walk));
  });
  it('a reconcile snap / teleport is not a step', () => {
    const bob = new HeadBob();
    walk(bob, SPEED.walk, 1);
    const phase = bob.phase;
    bob.step(3, DT); // 3 m in one frame
    expect(bob.phase).toBe(phase);
  });
});
