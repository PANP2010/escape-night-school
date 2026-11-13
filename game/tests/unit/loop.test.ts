import { describe, expect, it } from 'vitest';
import { L3 } from '../../shared/levels/l3.ts';
import { enterLoopDoor, freshLoop, loopDestination, loopSolved } from '../../shared/loop.ts';
import { exitOpen, generateLevel, inBounds } from '../../shared/level.ts';
import type { Vec3 } from '../../shared/protocol.ts';

const lp = L3.loop!, open = Array<boolean>(120).fill(true);
const cross = (s = freshLoop(), label = '303', isOpen = open) => {
  const d = lp.doors.filter((d) => d.label === label).at(-1)!;
  return enterLoopDoor(L3, s, [d.x, d.y, d.z + 0.6], [d.x, d.y, d.z - 0.6], isOpen);
};
const leave = (s: ReturnType<typeof freshLoop>) => enterLoopDoor(L3, s, [43.1725, 7.2, 82], [43.1725, 7.2, 84.2], open);

describe('L3 personal door sequence', () => {
  it('only advances on real entry; leaving/repeated samples/threshold jitter do not count', () => {
    let s = cross(); expect(s.step).toBe(1); expect(s.armed).toBe(false);
    expect(cross(s)).toBe(s);
    expect(enterLoopDoor(L3, s, [43.1725, 7.2, 82.2], [43.1725, 7.2, 82.8], open)).toBe(s);
    s = leave(s); expect(s.step).toBe(1); expect(s.armed).toBe(true);
    s = cross(s, '301'); expect(s.step).toBe(2);
  });
  it('wrong door resets only that player, correct order unlocks and remains unlocked', () => {
    const other = freshLoop();
    let s = cross(); s = cross(leave(s), '302');
    expect(s).toMatchObject({ step: 0, mistakes: 1 });
    for (const n of lp.sequence) s = cross(leave(s), n);
    expect(s.step).toBe(4); expect(loopSolved(L3, s)).toBe(true);
    expect(cross(leave(s), '304').step).toBe(4);
    expect(other).toEqual(freshLoop());
    expect(exitOpen(generateLevel(2, 1), 100, { stair_key: 1 }, other)).toBe(false);
    expect(exitOpen(generateLevel(2, 1), 0, {}, s)).toBe(true);
  });
  it('closed doors, other floors, side crossings and wall crossings cannot advance', () => {
    const s = freshLoop(), d = lp.doors[5];
    expect(cross(s, '303', [])).toBe(s);
    for (const [a, b] of [
      [[d.x, 3.6, 83], [d.x, 3.6, 82]],
      [[d.x + 1, 7.2, 83], [d.x + 1, 7.2, 82]],
      [[d.x, 7.2, 82], [d.x, 7.2, 83]],
      [[d.x, 7.2, 83], [d.x, 7.2, 82.4]],
    ] as [Vec3, Vec3][]) expect(enterLoopDoor(L3, s, a, b, open).step).toBe(0);
  });
  it('both doors carry the same room number and can satisfy its step', () => {
    for (const d of lp.doors.filter((d) => d.label === '303')) {
      expect(enterLoopDoor(L3, freshLoop(), [d.x, 7.2, 83.2], [d.x, 7.2, 82], open).step).toBe(1);
    }
  });
  it('remembers the physical aperture across packets before confirming a diagonal entry', () => {
    const d = lp.doors[5], s = freshLoop();
    const atDoor = enterLoopDoor(L3, s, [d.x, d.y, d.z + 0.3], [d.x + 0.2, d.y, d.z - 0.2], open);
    expect(atDoor).toMatchObject({ step: 0, armed: true, entering: d.id });
    const inside = enterLoopDoor(L3, atDoor, [d.x + 0.2, d.y, d.z - 0.2], [d.x + 0.6, d.y, d.z - 0.5], open);
    expect(inside).toMatchObject({ step: 1, armed: false, entering: undefined });
    expect(enterLoopDoor(L3, s, [d.x, d.y, d.z - 0.2], [d.x, d.y, d.z - 0.6], open)).toBe(s);
  });
  it('partial entry and a retreat through the physical plane cancel without progress or a mistake', () => {
    const d = lp.doors[5];
    const partial = enterLoopDoor(L3, freshLoop(), [d.x, d.y, d.z + 0.2], [d.x, d.y, d.z - 0.1], open);
    const retreat = enterLoopDoor(L3, partial, [d.x, d.y, d.z - 0.1], [d.x, d.y, d.z + 0.1], open);
    expect(retreat).toMatchObject({ step: 0, mistakes: 0, armed: true, entering: undefined });
    expect(enterLoopDoor(L3, retreat, [d.x, d.y, d.z - 0.1], [d.x, d.y, d.z - 0.5], open)).toBe(retreat);
    expect(cross(retreat).step).toBe(1);
  });
});

describe('loop seam', () => {
  it('translates only unsolved players crossing westward in the corridor, retaining height and lane', () => {
    const p: Vec3 = [19.4, 7.2, 84.7], from: Vec3 = [19.6, 7.2, 84.7], s = freshLoop();
    expect(loopDestination(L3, s, from, p)).toEqual([55.4, 7.2, 84.7]);
    expect(inBounds(generateLevel(2, 1), ...loopDestination(L3, s, from, p)!)).toBe(true);
    for (const q of [[20, 7.2, 84.2], [19, 3.6, 84.2], [19, 7.2, 80]] as Vec3[]) expect(loopDestination(L3, s, from, q)).toBeNull();
    expect(loopDestination(L3, { ...s, step: 4 }, from, p)).toBeNull();
  });
  it('does not mistake a 301 west-door return, stationary look or eastward move for crossing the seam', () => {
    const west = lp.doors[0], s = freshLoop();
    expect(loopDestination(L3, s, [west.x, west.y, 82.95], [west.x, west.y, 83.1])).toBeNull();
    expect(loopDestination(L3, s, [19.4, 7.2, 84.2], [19.4, 7.2, 84.2])).toBeNull();
    expect(loopDestination(L3, s, [19.4, 7.2, 84.2], [19.6, 7.2, 84.2])).toBeNull();
    expect(loopDestination(L3, s, [19.6, 3.6, 84.2], [19.4, 7.2, 84.2])).toBeNull();
    expect(loopDestination(L3, s, [19.6, 7.2, 82.9], [19.4, 7.2, 83.1])).toBeNull();
  });
});
