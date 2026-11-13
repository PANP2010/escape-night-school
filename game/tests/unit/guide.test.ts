import { describe, expect, it } from 'vitest';
import { ARRIVED, avoidArrowControls, bestStart, distText, distTo, edgeArrow, goalPoint, guideWaypoint, LOOKAHEAD, ON_TOP, navFromMsg, seenNearest, wideLos } from '../../client/src/guide.ts';
import { objective } from '../../client/src/objective.ts';
import { lineOfSight, NavGraph } from '../../shared/campus/nav.ts';
import { CollisionWorld } from '../../shared/campus/collision.ts';
import { LEVELS } from '../../shared/level.ts';
import type { WorldItem } from '../../shared/protocol.ts';

const [L1, L2] = LEVELS;
const at = (x: number, z: number, y = 0) => ({ x, y, z });

describe('navFromMsg', () => {
  it('reads cm triples + adjacency into a graph in metres', () => {
    const g = navFromMsg([0, 0, 0, 150, 360, -250], [[1], [0]])!;
    expect(g.nodes).toEqual([at(0, 0), at(1.5, -2.5, 3.6)]);
    expect(g.adj).toEqual([[1], [0]]);
    expect(g.astar(0, 1)).toEqual([0, 1]);
  });
  it('rejects malformed messages', () => {
    expect(navFromMsg([0, 0], [[]])).toBeNull(); // not triples
    expect(navFromMsg([0, 0, 0], [[], []])).toBeNull(); // adj length
    expect(navFromMsg([], [])).toBeNull();
    expect(navFromMsg([0, 0, 0, 1, 1, 1], [[5], [0]])).toBeNull(); // out of range
    expect(navFromMsg([0, 0, 0, 1, 1, 1], [[0], [0]])).toBeNull(); // self loop
    expect(navFromMsg([0, NaN, 0], [[]])).toBeNull();
    expect(navFromMsg('x', [[]])).toBeNull();
  });
});

describe('goalPoint', () => {
  const it1 = (id: number, kind: string, x: number, z: number, y = 1): WorldItem => ({ id, kind, p: [x, y, z] }) as WorldItem;
  const g = new NavGraph();
  g.chain([at(0, 0), at(10, 0), at(10, 10)]);

  it('L1: real drawer key → locked drawer → exit; decoys never become arrow targets', () => {
    const o = objective(L1, {}, 0), key = it1(7, 'drawer_key', 11, 9);
    const drawer = it1(9, 'stair_key', 1, 1), decoy = { ...it1(10, 'drawer_key', 0, 0), decoy: true };
    const items = [drawer, decoy, key, it1(8, 'battery', 0, 1)];
    expect(goalPoint(L1, o, items, new Set([10]), at(0, 0), g)).toEqual({ x: 10, y: 0, z: 10, exact: false, item: 7 });
    expect(goalPoint(L1, o, items, new Set([7]), at(0, 0), g)).toEqual({ x: 11, y: 1, z: 9, exact: true, item: 7 });
    expect(goalPoint(L1, o, items, new Set(), at(0, 0), null)).toMatchObject({ x: 11, z: 9, exact: false });
    const unlocked = objective(L1, { drawer_key: 1 }, 0);
    expect(goalPoint(L1, unlocked, items, new Set([9]), at(0, 0), g)).toMatchObject({ x: 1, z: 1, item: 9, exact: true });
    const final = objective(L1, { drawer_key: 1, stair_key: 1 }, 0);
    expect(goalPoint(L1, final, items, new Set(), at(0, 0), g)).toEqual({ x: L1.exit.x, y: L1.exit.y, z: L1.exit.z, exact: true });
    expect(goalPoint(L1, o, [drawer, decoy], new Set([10]), at(0, 0), g)).toBeNull();
  });
  it('last step, already in the exit zone: flagged arrived (only then)', () => {
    const o2 = objective(L1, { stair_key: 1 }, 0), e = L1.exit;
    expect(goalPoint(L1, o2, [], new Set(), at(e.x + e.r - 0.2, e.z), g)).toEqual({ x: e.x, y: e.y, z: e.z, exact: true, arrived: true });
    expect(goalPoint(L1, o2, [], new Set(), at(e.x + e.r + 0.5, e.z), g)).not.toHaveProperty('arrived');
    expect(goalPoint(L1, o2, [], new Set(), at(e.x, e.z, e.y + 3.6), g)).not.toHaveProperty('arrived'); // the storey above
    // not the last step: standing in the exit zone means nothing
    const items = [it1(7, 'drawer_key', e.x, e.z)];
    expect(goalPoint(L1, objective(L1, {}, 0), items, new Set([7]), at(e.x, e.z), g)).not.toHaveProperty('arrived');
  });

  it('L2: a seen fuse before a nearer unseen one, nearest by floor (y ×3); then the fuse box; then the exit', () => {
    const bo = L2.blackout!;
    const fuses = [it1(1, 'fuse', 3, 0), it1(2, 'fuse', 9, 0), it1(3, 'fuse', 1, 1, 4.6)];
    const o = objective(L2, {}, 0);
    expect(o.cur).toBe(0);
    // (1,_,1) one storey up is 3 m off in y → ×3 = 9 m: the (3,0) fuse is nearer
    expect(goalPoint(L2, o, fuses, new Set(), at(0, 0), null)).toMatchObject({ item: 1, exact: false });
    expect(goalPoint(L2, o, fuses, new Set([2]), at(0, 0), null)).toMatchObject({ item: 2, x: 9, exact: true });
    const o1 = objective(L2, { fuse: bo.fuses }, 0);
    expect(o1.cur).toBe(1);
    expect(goalPoint(L2, o1, [], new Set(), at(0, 0), g)).toEqual({ x: bo.fuseBox.x, y: bo.fuseBox.y, z: bo.fuseBox.z, exact: true });
    const o2 = objective(L2, {}, bo.fuses);
    expect(o2.cur).toBe(2);
    expect(goalPoint(L2, o2, fuses, new Set(), at(0, 0), g)).toEqual({ x: L2.exit.x, y: L2.exit.y, z: L2.exit.z, exact: true });
  });
  it('L2: the nearest unseen room by its walking route, retaining it as that route gets shorter', () => {
    const rooms = new NavGraph();
    rooms.chain([at(0, 0), at(-10, 0), at(-10, 15), at(2, 15), at(2, 0)]);
    rooms.link(0, rooms.addNode(at(0, 10)));
    const fuses = [it1(1, 'fuse', 2, 0), it1(2, 'fuse', 0, 10)];
    const o = objective(L2, {}, 0);
    // The first fuse is 2 m away through a wall, but its doorway route is 52 m. The second is a 10 m walk.
    for (const z of [0, 4, 8]) expect(goalPoint(L2, o, fuses, new Set(), at(0, z), rooms)).toMatchObject({ item: 2, exact: false });
    expect(goalPoint(L2, o, fuses, new Set([1]), at(0, 0), rooms)).toMatchObject({ item: 1, exact: true });
  });
});

describe('guideWaypoint', () => {
  // an L-shaped corridor: (0,0) → (10,0) → (10,10) → (10,20), wall inside the corner (x < 10, z > 0)
  const g = new NavGraph();
  g.chain([at(0, 0), at(5, 0), at(10, 0), at(10, 10), at(10, 20)]);
  const wall = (a: { x: number; z: number }, b: { x: number; z: number }) => {
    for (let t = 0; t <= 1; t += 0.01) { const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t; if (x < 9 && z > 1) return false; }
    return true;
  };

  it('arrived (in the exit zone): straight at the exit even through walls, straight-line distance', () => {
    // the L1 bug: inside the stairwell no ray reaches the exit, the path led back out to the nearest node in sight
    expect(guideWaypoint(g, at(0, 5), { ...at(10, 20), arrived: true }, wall)).toEqual({ x: 10, y: 0, z: 20, dist: Math.hypot(10, 15) });
    expect(guideWaypoint(g, at(0, 5), at(10, 20), wall)).not.toMatchObject({ x: 10, z: 20 });
    expect(ARRIVED).toBe('到了，等队友');
  });
  it('goes straight at the goal when the line is clear', () => {
    expect(guideWaypoint(g, at(0, 0), at(8, 0), wall)).toEqual({ x: 8, y: 0, z: 0, dist: 8 });
    expect(guideWaypoint(null, at(0, 0), at(3, 4))).toEqual({ x: 3, y: 0, z: 4, dist: 5 });
  });
  it('round the corner: the furthest clear path node, distance along the path', () => {
    const w = guideWaypoint(g, at(0, 0), at(10, 20), wall);
    expect([w.x, w.z]).toEqual([10, 0]);
    expect(w.dist).toBeCloseTo(30);
    // from the corner the rest is in view
    expect(guideWaypoint(g, at(10, 0), at(10, 20), wall)).toMatchObject({ x: 10, z: 20, dist: 20 });
  });
  it('another storey always routes over the graph (stairs), never straight up', () => {
    const s = new NavGraph();
    s.chain([at(0, 0), at(4, 0), at(4, 4, 3.6), at(0, 4, 3.6)]);
    const w = guideWaypoint(s, at(0, 0), at(0, 4, 3.6));
    expect([w.x, w.y, w.z]).toEqual([4, 0, 0]);
    expect(w.dist).toBeCloseTo(4 + Math.hypot(4, 3.6) + 4);
  });
  it('nothing in view (a shut door): the node after the one underfoot', () => {
    const w = guideWaypoint(g, at(0.2, 0), at(10, 20), () => false);
    expect([w.x, w.z]).toEqual([5, 0]);
    expect(w.dist).toBeCloseTo(4.8 + 5 + 20);
    // far off the graph: the nearest node first
    expect(guideWaypoint(g, at(0, 4), at(10, 20), () => false)).toMatchObject({ x: 0, z: 0 });
  });
  it('starts from the nearest node in sight, not one through a wall', () => {
    // a room behind the wall z = 1 (x < 9): (2, 1.6) is in it, the corridor node (2, 0) is nearer but walled off
    const s = new NavGraph();
    s.chain([at(2, 0), at(10, 0), at(10, 5), at(4, 5)]);
    const room = (a: { z: number }, b: { z: number }) => (a.z > 1) === (b.z > 1);
    expect(seenNearest(s, at(2, 1.6), room)).toBe(3);
    expect(seenNearest(s, at(2, 1.6))).toBe(0); // no los: plain nearest
    expect(seenNearest(s, at(2, 1.6), () => false)).toBe(0); // nothing in sight: plain nearest
    // nearest first: the rays stop at the first node in sight
    let rays = 0;
    expect(seenNearest(s, at(2, 1.6), (a, b) => (rays++, room(a, b)))).toBe(3);
    expect(rays).toBe(2); // (2, 0) walled off, then (4, 5)
    const w = guideWaypoint(s, at(2, 1.6), at(10, 0), room);
    expect([w.x, w.z]).toEqual([10, 5]); // the room node is passed by: (10, 5) is in sight too
    expect(w.dist).toBeCloseTo(Math.hypot(8, 3.4) + 5);
  });
  it('no node in sight (a node-less strip between walls): the one in sight past the strip\'s open end, not through the wall', () => {
    // the L1 bug: the strip 0 < z < 2 (x < 10) is walled both sides, open at x = 10; plain nearest (4, -3) is through the wall
    const s = new NavGraph();
    s.chain([at(13, 5), at(4, -3)]);
    const strip = (q: { x: number; z: number }) => q.x < 10 && q.z > 0 && q.z < 2, beside = (q: { x: number; z: number }) => q.x < 10 && !strip(q);
    const walls = (a: { x: number; z: number }, b: { x: number; z: number }) => {
      let i = false, o = false;
      for (let t = 0; t <= 1; t += 0.01) { const q = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }; i ||= strip(q); o ||= beside(q); }
      return !(i && o);
    };
    expect(s.nearest(3, 0, 1)).toBe(1);
    expect(seenNearest(s, at(3, 1), walls)).toBe(0);
    expect(guideWaypoint(s, at(3, 1), at(4, -3), walls)).toMatchObject({ x: 13, z: 5 });
  });
  it('standing on the path\'s last node, the goal round the doorpost: the goal itself, not the node underfoot', () => {
    const s = new NavGraph();
    s.chain([at(0, 0), at(10, 0)]);
    const post = (a: { z: number }, b: { z: number }) => a.z < 2 && b.z < 2;
    const w = guideWaypoint(s, at(9.8, 0), at(12, 3), post);
    expect([w.x, w.y, w.z]).toEqual([12, 0, 3]);
    expect(w.dist).toBeCloseTo(Math.hypot(2.2, 3));
  });
  it('an item on a desk / lectern (up to ON_TOP above the feet) is on this storey: straight at it when clear', () => {
    expect(ON_TOP).toBeGreaterThan(1.15);
    expect(guideWaypoint(g, at(10, 0), at(10, 10, 1.15), wall)).toEqual({ x: 10, y: 1.15, z: 10, dist: Math.hypot(10, 1.15) });
    // round the corner: routed to the node on the floor under it
    const w = guideWaypoint(g, at(0, 0), at(10, 10, 1.15), wall);
    expect([w.x, w.z]).toEqual([10, 0]);
    expect(w.dist).toBeCloseTo(10 + 10 + 1.15);
  });
  it('seenNearest picks what a filtered nearest() would, with fewer rays', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const s = new NavGraph();
    s.chain(Array.from({ length: 60 }, () => ({ x: rnd() * 30, y: rnd() < 0.2 ? 3.6 : 0, z: rnd() * 30 })));
    const wall = (a: { x: number }, b: { x: number }) => (a.x > 15) === (b.x > 15);
    for (let k = 0; k < 40; k++) {
      const p = { x: rnd() * 30, y: rnd() < 0.2 ? 3.6 : 0, z: rnd() * 30 };
      const lift = (q: { x: number; y: number; z: number }) => ({ x: q.x, y: q.y + 0.5, z: q.z });
      const ref = s.nearest(p.x, p.y, p.z, (n) => Math.abs(n.y - p.y) < 1 && (n.x - p.x) ** 2 + (n.z - p.z) ** 2 < 144 && wall(lift(p), lift(n)));
      expect(seenNearest(s, p, wall)).toBe(ref >= 0 ? ref : s.nearest(p.x, p.y, p.z));
    }
  });
  it('distTo: the walk to a node over the graph from every node, Infinity where cut off', () => {
    const s = new NavGraph();
    s.chain([at(0, 0), at(3, 4), at(3, 10)]);
    s.addNode(at(50, 50));
    expect(distTo(s, 2)).toEqual([11, 6, 0, Infinity]);
  });
  it('bestStart: the node in sight with the shortest walk via it, not the nearer one off the way round', () => {
    // (0, 0) is nearest but its link goes the long way (west then north); (4, 3) links straight to the goal's node
    const s = new NavGraph();
    s.chain([at(0, 0), at(-10, 0), at(-10, 14), at(5, 14)]);
    s.link(s.addNode(at(4, 3)), 3);
    const d = distTo(s, 3), p = at(1, 0);
    expect(seenNearest(s, p, () => true)).toBe(0);
    expect(bestStart(s, p, d, () => true)).toBe(4);
    // (4, 3) out of sight: the nearer one after all; no los: plain nearest
    expect(bestStart(s, p, d, (_a, b) => b.x !== 4)).toBe(0);
    expect(bestStart(s, p, d)).toBe(0);
    expect(guideWaypoint(s, p, at(5, 15), (_a, b) => b.z < 14.5)).toMatchObject({ x: 5, z: 14 });
  });
  it('bestStart: a clear centre ray past a wall corner must also leave room for the capsule', () => {
    const s = new NavGraph();
    s.chain([at(0, 0), at(8, 0)]);
    s.link(s.addNode(at(2, 3)), 1);
    const w = new CollisionWorld([{ minX: 3.5, maxX: 4.5, minY: 0, maxY: 2, minZ: 1.18, maxZ: 1.55 }]);
    const p = at(0, 2), los = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => lineOfSight(w, a, b);
    expect(los({ ...p, y: 0.5 }, { ...s.nodes[1], y: 0.5 })).toBe(true);
    expect(bestStart(s, p, distTo(s, 1), los)).toBe(2);
  });
  it('past the path\'s last node, the goal round the doorpost but in view from the eyes: the goal, the arrow doesn\'t flip back', () => {
    const s = new NavGraph();
    s.chain([at(0, 0), at(10, 0)]);
    // the post blocks the knee rays to the goal, not the eyes' line (a desk's edge)
    const post = (a: { y: number; z: number }, b: { z: number }) => a.y > 1 || (a.z < 2 && b.z < 2);
    expect(guideWaypoint(s, at(11.8, 0), at(12, 3), post)).toMatchObject({ x: 12, z: 3 });
    // short of the node: the node
    expect(guideWaypoint(s, at(8.2, 0), at(12, 3), post)).toMatchObject({ x: 10, z: 0 });
    // past it but the goal hidden from the eyes too: still the node
    expect(guideWaypoint(s, at(11.8, 0), at(12, 3), (a, b) => a.z < 2 && b.z < 2)).toMatchObject({ x: 10, z: 0 });
  });
  it('nothing in view, still short of the nearest node (round a wall end): that node; past it along the next leg: the next', () => {
    expect(guideWaypoint(g, at(-1, 0), at(10, 20), () => false)).toMatchObject({ x: 0, z: 0 });
    expect(guideWaypoint(g, at(1, 0), at(10, 20), () => false)).toMatchObject({ x: 5, z: 0 });
  });
  it('nothing in view, on the way along the next leg (a shut door at its end): the next node, not back to the one behind', () => {
    // 2 m along the leg, the old 1.5 m from the node: walked back to it, never in reach of the door (#224, L1 door 16)
    expect(guideWaypoint(g, at(2, 0.5), at(10, 20), () => false)).toMatchObject({ x: 5, z: 0 });
    // more than 1 m off the leg (round a wall end): the node first
    expect(guideWaypoint(g, at(0.5, 1.2), at(10, 20), () => false)).toMatchObject({ x: 0, z: 0 });
  });
  it('skips at most LOOKAHEAD nodes ahead', () => {
    const s = new NavGraph();
    s.chain(Array.from({ length: 12 }, (_, i) => at(i, 0)));
    const w = guideWaypoint(s, at(0, 0), at(11, 0, 3), () => true);
    expect(w.x).toBe(LOOKAHEAD);
  });
  it('wideLos needs all three rays (centre, both shoulders) clear', () => {
    const rays: number[] = [];
    expect(wideLos((a, b) => (rays.push(a.y, b.y), true), at(0, 0), at(0, 5))).toBe(true);
    expect(rays.every((y) => y === 0.5)).toBe(true);
    expect(wideLos((a) => a.x < 0.3, at(0, 0), at(0, 5))).toBe(false); // a shoulder ray is blocked
  });
});

describe('distText / edgeArrow', () => {
  it('keeps the complete two-line label and rotated marker clear of measured touch controls', () => {
    const footprint = { left: -62, top: -22, right: 62, bottom: 53 };
    const blocked = [
      { left: 50, top: 240, right: 170, bottom: 360 },
      { left: 480, top: 245, right: 655, bottom: 365 },
      { left: 535, top: 175, right: 653, bottom: 225 },
    ];
    for (const x of [-5, -1, 0, 1, 5]) for (const y of [-5, -1, 0, 1, 5]) {
      const a = edgeArrow(x, y, false, 667, 375, 64);
      const r = avoidArrowControls(a, 667, 375, footprint, blocked);
      expect(r.x + footprint.left).toBeGreaterThanOrEqual(8);
      expect(r.x + footprint.right).toBeLessThanOrEqual(659);
      expect(r.y + footprint.top).toBeGreaterThanOrEqual(8);
      expect(r.y + footprint.bottom).toBeLessThanOrEqual(367);
      for (const b of blocked) expect(r.x + footprint.right > b.left && r.x + footprint.left < b.right
        && r.y + footprint.bottom > b.top && r.y + footprint.top < b.bottom).toBe(false);
      if (!a.on) expect(r.a).toBe(a.a);
    }
  });
  it('exact metres, rough to 5 m', () => {
    expect(distText(12.4, true)).toBe('12 m');
    expect(distText(0.2, true)).toBe('1 m');
    expect(distText(13, false)).toBe('约 15 m');
    expect(distText(1, false)).toBe('约 5 m');
  });
  it('on screen → the marker at the point', () => {
    expect(edgeArrow(0, 0, false, 640, 400, 34)).toEqual({ x: 320, y: 200, a: 0, on: true });
    expect(edgeArrow(0.5, 0.5, false, 640, 400, 34)).toEqual({ x: 480, y: 100, a: 0, on: true });
  });
  it('off screen → clamped to the inset edge, pointing out', () => {
    const r = edgeArrow(3, 0, false, 640, 400, 34);
    expect(r).toMatchObject({ x: 640 - 34, y: 200, on: false });
    expect(r.a).toBeCloseTo(90);
    const u = edgeArrow(0, 5, false, 640, 400, 34);
    expect(u).toMatchObject({ x: 320, y: 34 });
    expect(u.a).toBeCloseTo(0);
    const c = edgeArrow(-4, -4, false, 640, 400, 34); // bottom-left: hits the bottom edge first
    expect(c.y).toBeCloseTo(400 - 118);
    expect(c.x).toBeGreaterThanOrEqual(34);
    expect(c.a).toBeCloseTo(-180 + (Math.atan2(4 * 320, 4 * 200) * 180) / Math.PI);
  });
  it('behind the camera → mirrored, never shown as on screen', () => {
    const r = edgeArrow(0.2, 0, true, 640, 400, 34);
    expect(r.on).toBe(false);
    expect(r.x).toBeCloseTo(34);
    expect(r.a).toBeCloseTo(-90);
    expect(edgeArrow(0, 0, true, 640, 400, 34)).toMatchObject({ x: 320, y: 400 - 118, on: false });
  });
  it.each([
    { w: 667, h: 375, margin: 34, hintLines: 2, safeBottom: 34 },
    { w: 844, h: 390, margin: 34, hintLines: 1, safeBottom: 34 },
    { w: 1280, h: 720, margin: 46, hintLines: 1, safeBottom: 0 },
  ])('keeps a bottom distance tag clear of the control hint at $w × $h', ({ w, h, margin, hintLines, safeBottom }) => {
    const r = edgeArrow(0, -5, false, w, h, margin);
    const tagBottom = r.y + 17 + 20; // CSS top + its padded line height
    const hintTop = h - (w < 900 ? 6 : 10) - safeBottom - hintLines * 17;
    expect(tagBottom + 6).toBeLessThanOrEqual(hintTop);
    expect(r).toMatchObject({ x: w / 2, a: 180, on: false });
    // The same strip also clips projected targets that are technically inside the camera view.
    const low = edgeArrow(0, -0.95, false, w, h, margin);
    expect(low.on).toBe(false);
    expect(low.y).toBe(r.y);
  });
  it.each([{ w: 320, h: 80 }, { w: 667, h: 320 }])('keeps the footer inside a short $w × $h viewport', ({ w, h }) => {
    for (const behind of [false, true]) for (const [x, y] of [[0, -5], [0, 5], [5, 0], [-5, 0], [3, -3]]) {
      const r = edgeArrow(x, y, behind, w, h, 34), sign = behind ? -1 : 1;
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.x).toBeLessThanOrEqual(w);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeLessThanOrEqual(h);
      expect(r.a).toBeCloseTo(Math.atan2(sign * x * w, sign * y * h) * 180 / Math.PI);
    }
  });
});
