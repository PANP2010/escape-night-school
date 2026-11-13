import { describe, expect, it } from 'vitest';
import { boxAt, downCand, fuseBoxBounds, FUSE_BOX_CENTER_H, FUSE_BOX_H, FUSE_BOX_R, hideTarget, inReach, pickNear, inReachDown, lookDir, pingPoint, rayTarget, KEY_R, KEY_H, type Cand } from '../../shared/interact.ts';
import type { Vec3 } from '../../shared/protocol.ts';
import { LEVELS } from '../../shared/level.ts';
import { parseClientMsg } from '../../shared/protocol.ts';

const door: Cand = { kind: 'use', id: 3, min: [-0.5, 0, -5], max: [0.5, 3, -4.8] };
const key: Cand = { kind: 'pick', id: 1, min: [-0.3, 0, -1], max: [0.3, 1.2, -0.5] };

describe('crosshair ray', () => {
  it('looks down -Z at yaw 0', () => {
    const d = lookDir(0, 0);
    expect(d[2]).toBeCloseTo(-1);
    expect(lookDir(0, Math.PI / 2)[1]).toBeCloseTo(1);
  });
  it('hits the nearest candidate in range only', () => {
    expect(rayTarget([0, 1.6, -3.5], 0, 0, [door, key])?.id).toBe(3);
    expect(rayTarget([0, 1.6, 0], 0, 0, [door])).toBeNull(); // 4.8 m away
    expect(rayTarget([0, 1, 0], 0, 0, [door, key])?.kind).toBe('pick'); // key in front of the door
    expect(rayTarget([0, 1.6, -3.5], Math.PI / 2, 0, [door])).toBeNull(); // looking away
  });
});

describe('inReach', () => {
  it('is flat distance to the box, ≤ 2 m, on the same storey', () => {
    expect(inReach([0, 0, -2.7], door.min, door.max)).toBe(false); // 2.3 m
    expect(inReach([0, 0, -2.9], door.min, door.max)).toBe(true); // 2.1 → border
    expect(inReach([0, 0, -2.8], door.min, door.max)).toBe(true); // 2.0
    expect(inReach([0, 3.5, -4], door.min, door.max)).toBe(false); // other floor
  });
});

describe('wall-mounted fuse cabinet', () => {
  it('aiming at the visible centre or upper door hits at standing eye height on every storey', () => {
    for (const floorY of [0, 3.6, 7.2]) {
      const floor: Vec3 = [40, floorY, 85.6], eye: Vec3 = [40, floorY + 1.6, 84.3];
      const c: Cand = { kind: 'fuse', id: 0, ...fuseBoxBounds(floor) };
      const old: Cand = { kind: 'fuse', id: 0, ...boxAt(floor, FUSE_BOX_R, KEY_H) };
      for (const offset of [0, FUSE_BOX_H / 2 - .05]) {
        const pitch = Math.atan2(floorY + FUSE_BOX_CENTER_H + offset - eye[1], floor[2] + .1 - eye[2]);
        expect(rayTarget(eye, Math.PI, pitch, [c])?.kind).toBe('fuse');
        expect(rayTarget(eye, Math.PI, pitch, [old])).toBeNull();
      }
    }
  });

  it('preserves the authoritative floor/flat reach and rejects another storey, distance and looking away', () => {
    const floor: Vec3 = [40, 3.6, 85.6], c: Cand = { kind: 'fuse', id: 0, ...fuseBoxBounds(floor) };
    const authority = boxAt(floor, .6, KEY_H);
    for (const feet of [[40, 3.6, 84.3], [40, 0, 84.3], [40, 7.2, 84.3], [40, 3.6, 82.9]] as Vec3[]) {
      expect(inReach(feet, c.min, c.max)).toBe(inReach(feet, authority.min, authority.max));
    }
    expect(inReach([40, 3.6, 84.3], c.min, c.max)).toBe(true);
    expect(inReach([40, 0, 84.3], c.min, c.max)).toBe(false);
    expect(inReach([40, 7.2, 84.3], c.min, c.max)).toBe(false);
    expect(inReach([40, 3.6, 82.9], c.min, c.max)).toBe(false);
    expect(rayTarget([40, 5.2, 84.3], 0, 0, [c])).toBeNull();
    expect(rayTarget([40, 5.2, 82.9], Math.PI, 0, [c])).toBeNull();
  });
});

describe('downCand', () => {
  // body parts of the downed pose in the player's own frame: [forward, right, height] (head and hands ahead, feet behind)
  const PARTS: Record<string, [number, number, number]> = { head: [0.55, 0.17, 0.27], handL: [0.67, -0.41, 0.1], handR: [0.67, 0.64, 0.1], chest: [0.29, 0.09, 0.2], footL: [-0.29, -0.77, 0.1], footR: [-0.79, -0.11, 0.1] };
  const world = (p: [number, number, number], yaw: number, [f, r, h]: [number, number, number]): [number, number, number] =>
    [p[0] - Math.sin(yaw) * f + Math.cos(yaw) * r, p[1] + h, p[2] - Math.cos(yaw) * f - Math.sin(yaw) * r];
  /** Crosshair from `eye` aimed straight at world point `q`. */
  const aim = (eye: [number, number, number], q: [number, number, number], c: Cand) => {
    const dx = q[0] - eye[0], dz = q[2] - eye[2];
    return rayTarget(eye, Math.atan2(-dx, -dz), Math.atan2(q[1] - eye[1], Math.hypot(dx, dz)), [c]);
  };
  const rev = (p: [number, number, number], yaw: number): Cand => ({ kind: 'revive', id: 2, ...downCand(p, yaw) });
  it('covers head, hands and feet whichever way the body lies', () => {
    const p: [number, number, number] = [3, 3.5, -7];
    for (const yaw of [0, 0.7, Math.PI / 4, Math.PI / 2, 2.4, Math.PI, -1.1]) {
      const c = rev(p, yaw);
      for (const [n, part] of Object.entries(PARTS)) {
        const q = world(p, yaw, part), eye = world(p, yaw, [part[0] + 1.2, part[1], 1.6]); // 1.2 m ahead of the part, looking down at it
        expect(aim(eye, q, c)?.id, `${n} @ yaw ${yaw}`).toBe(2);
        expect(inReachDown([eye[0], p[1], eye[2]], p, yaw), `${n} @ yaw ${yaw}`).toBe(true);
      }
      expect(c.min[1]).toBe(0);
      expect(c.max[1]).toBeLessThan(1); // lying: no standing-height box to aim over
    }
  });
  it('lets the crosshair take the head from 1.6 m in front of it, where the old feet box was out of the ray', () => {
    for (const [yaw, oldMissed] of [[0, true], [0.7, true], [-2, false]] as const) { // the old box's corner reaches it at some yaws
      const p: [number, number, number] = [0, 0, 0], head = world(p, yaw, PARTS.head), eye = world(p, yaw, [0.55 + 1.6, 0.17, 1.6]);
      expect(aim(eye, head, rev(p, yaw))?.id, `yaw ${yaw}`).toBe(2);
      if (oldMissed) expect(aim(eye, head, { kind: 'revive', id: 2, ...boxAt(p, 0.5, 1.8) }), `yaw ${yaw}`).toBeNull();
      expect(inReachDown([eye[0], 0, eye[2]], p, yaw)).toBe(true); // and the server's reach agrees from there
    }
  });
  it('turns with yaw: the head end of one facing is out of reach from the other side', () => {
    const p: [number, number, number] = [0, 0, 0], at: [number, number, number] = [0, 0, -2.8]; // 2.8 m along -Z
    expect(inReachDown(at, p, 0)).toBe(true); // facing -Z: head 0.85 m towards it
    expect(inReachDown(at, p, Math.PI / 2)).toBe(false); // facing -X: its right side (0.75 m) towards it
  });
  it('lying at 45°: the empty floor past the head end or the side is not the body (the old world AABB around it was ≈ 1.4× wider)', () => {
    const p: [number, number, number] = [5, 0, 5], yaw = Math.PI / 4, c = rev(p, yaw);
    // the old downBox: the footprint's corners turned by yaw, then a world AABB around them
    const corners = [[0.85, -0.9], [0.85, 0.75], [-0.9, -0.9], [-0.9, 0.75]].map(([f, r]) => world(p, yaw, [f, r, 0]));
    const old: Cand = { kind: 'revive', id: 2, min: [Math.min(...corners.map((q) => q[0])), 0, Math.min(...corners.map((q) => q[2]))], max: [Math.max(...corners.map((q) => q[0])), 0.8, Math.max(...corners.map((q) => q[2]))] };
    // floor 0.4 m past the head end and 0.35 m off the right side, each looked down at from 1.2 m further out
    for (const [n, gap, eye] of [['head end', [1.25, 0, 0.05], [2.45, 0, 1.6]], ['right side', [0, 1.1, 0.05], [0, 2.3, 1.6]]] as const) {
      const g = world(p, yaw, [...gap]), e = world(p, yaw, [...eye]);
      expect(aim(e, g, old)?.id, n).toBe(2); // the old box took this bare floor…
      expect(aim(e, g, c), n).toBeNull(); // …the body's own box does not
    }
    expect(aim(world(p, yaw, [2.05, 0.1, 1.6]), world(p, yaw, [0.8, 0.1, 0.1]), c)?.id).toBe(2); // the head end itself still is
    // the server's reach is to the body too: 2.1 m past the head end is out (the old AABB put it ≈ 1.3 m away)
    const far = world(p, yaw, [2.95, 0, 0]);
    expect(inReach(far, old.min, old.max)).toBe(true);
    expect(inReachDown(far, p, yaw)).toBe(false);
    expect(inReachDown(world(p, yaw, [2.8, 0, 0]), p, yaw)).toBe(true); // 1.95 m
  });
});

describe('act message', () => {
  it('parses valid and rejects bad ones', () => {
    expect(parseClientMsg('{"t":"act","kind":"pick","id":2}')).toEqual({ t: 'act', kind: 'pick', id: 2 });
    expect(parseClientMsg('{"t":"act","kind":"steal","id":2}')).toBeNull();
    expect(parseClientMsg('{"t":"act","kind":"use","id":-1}')).toBeNull();
  });
});

describe('hideTarget', () => {
  const hides = [{ x: 0, z: -1 }, { x: 0, z: -0.6 }, { x: 0, z: 1 }, { x: 3, z: 0 }];
  it('picks the nearest spot in front within reach', () => {
    expect(hideTarget(hides, 0, 0, 0)).toBe(1); // yaw 0 faces -Z; z=-0.6 is nearer than z=-1
  });
  it('ignores spots behind or out of reach, but takes one underfoot', () => {
    expect(hideTarget(hides, 0, 0, Math.PI)).toBe(2); // facing +Z
    expect(hideTarget(hides, 0, 1.4, Math.PI)).toBe(-1); // (0,1) is 0.4 m behind
    expect(hideTarget(hides, 0, 1, 0)).toBe(2); // standing on it
    expect(hideTarget(hides, 10, 10, 0)).toBe(-1);
  });
});

describe('pingPoint', () => {
  const eye: [number, number, number] = [0, 1.6, 0];
  it('lands on the floor where a downward look meets it', () => {
    const p = pingPoint(eye, 0, -Math.atan(1.6 / 4), [], 0);
    expect(p[0]).toBeCloseTo(0); expect(p[1]).toBeCloseTo(0); expect(p[2]).toBeCloseTo(-4);
  });
  it('stops at the nearest wall in the way, ignoring a box the eye is inside', () => {
    const wall = { min: [-5, 0, -3.2] as [number, number, number], max: [5, 3, -3] as [number, number, number] };
    const far = { min: [-5, 0, -9] as [number, number, number], max: [5, 3, -8] as [number, number, number] };
    const room = { min: [-10, 0, -10] as [number, number, number], max: [10, 3, 10] as [number, number, number] };
    const p = pingPoint(eye, 0, 0, [far, room, wall], 0);
    expect(p[2]).toBeCloseTo(-3);
  });
  it('ends at the max length looking up into nothing', () => {
    const p = pingPoint(eye, 0, 0.5, [], 0, 10);
    expect(Math.hypot(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2])).toBeCloseTo(10);
  });
});

describe('pickNear: picking beats hiding', () => {
  const items = [{ p: [0, 0, -1.5] as Vec3 }, { p: [0, 0, 1.5] as Vec3 }, { p: [0, 3.2, -1] as Vec3 }];
  it('takes the key in reach in front, not the one behind or a storey up', () => {
    expect(pickNear(items, [0, 0, 0], 0)).toBe(0);
    expect(pickNear(items, [0, 0, 0], Math.PI)).toBe(1);
    expect(pickNear(items, [0, 0, 0], Math.PI / 2)).toBe(-1); // facing -X: both off to the side
    expect(pickNear([items[2]], [0, 0, 0], 0)).toBe(-1);
  });
  it('agrees with the server reach check', () => {
    expect(pickNear([{ p: [0, 0, -2.3] }], [0, 0, 0], 0)).toBe(0); // box edge 1.95 m away
    expect(pickNear([{ p: [0, 0, -2.4] }], [0, 0, 0], 0)).toBe(-1); // 2.05 m: the server would refuse it
  });
  it('the #226 bot spot on L1: key on a desk at (-19.1, 1.1, 86.3) by a hiding place gives 「E 拾取」', () => {
    const key = [{ p: [-19.1, 1.1, 86.3] as Vec3 }], at: Vec3 = [-17.7, 0, 87.9], yaw = 7.84;
    expect(pickNear(key, at, yaw)).toBe(0);
    const { min, max } = boxAt(key[0].p, KEY_R, KEY_H);
    expect(inReach(at, min, max)).toBe(true); // the server takes it
    expect(hideTarget(LEVELS[0].hides, at[0], at[2], yaw)).toBeGreaterThanOrEqual(0); // …while a locker is in reach too
  });
});
