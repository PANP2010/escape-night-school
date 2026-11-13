import { beforeAll, describe, expect, test } from 'vitest';
import data from '../../shared/campus/colliders.json';
import { CollisionWorld, overlaps, type AABB } from '../../shared/campus/collision.ts';
import { NAV_CAPSULE, walk, type NavGraph } from '../../shared/campus/nav.ts';
import { campusNav } from '../../client/src/campus/world/navgraph.ts';
import { campusDoorSlab, type DoorSpot } from '../../shared/doors.ts';
import { generateLevel, inBounds, levelSolids } from '../../shared/level.ts';
import { levelAreaNav } from '../../server/room.ts';

describe('the blackout floor corridor around the blocked stairs', () => {
  let graph: NavGraph, openWorld: CollisionWorld, shutWorld: CollisionWorld;
  const lv = generateLevel(1, 1);
  const at = (x: number, z: number) => graph.nearest(x, 3.6, z);
  beforeAll(() => {
    graph = levelAreaNav(campusNav().graph, lv);
    const world = (open: boolean) => {
      const w = new CollisionWorld([
        ...(data.colliders as AABB[]), ...levelSolids(lv.def),
        ...(data.doors as DoorSpot[]).map((d) => campusDoorSlab(d, open)),
      ]);
      for (const h of data.holes) w.addHole(h.x0, h.x1, h.z0, h.z1);
      return w;
    };
    openWorld = world(true); shutWorld = world(false);
  }, 120_000);

  test('removes the campus routes through the level stair barricade', () => {
    const east = { x: 57.55, y: 3.6, z: 83.35 };
    expect(graph.nodes.some((n) => Math.hypot(n.x - east.x, n.z - east.z) < 0.1)).toBe(false);
    for (const [x, z] of [[22.75, 83.35], [33.85, 83.35], [43.05, 83.25], [52.75, 83.15]]) {
      expect(walk(openWorld, east, [[x, z]])).toBeNull();
    }
    for (let i = 0; i < graph.nodes.length; i++) for (const j of graph.adj[i]) {
      if (j <= i) continue;
      const a = graph.nodes[i], b = graph.nodes[j];
      expect(walk(openWorld, a, [[b.x, b.z]]), `edge ${i} → ${j}`).not.toBeNull();
      // A walk may slide around a wall. The straight edge followed by the arrow must stay clear too.
      const steps = Math.max(1, Math.ceil(graph.dist(i, j) / 0.1));
      for (let k = 0; k <= steps; k++) {
        const t = k / steps, p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
        expect(inBounds(lv, p.x, p.y, p.z), `edge ${i} → ${j} at ${t}`).toBe(true);
        expect(overlaps(openWorld, { ...p, vy: 0, grounded: true }, NAV_CAPSULE), `edge ${i} → ${j} at ${t}`).toBe(false);
      }
    }
  });

  test('every returned node is reachable from the spawn corridor', () => {
    expect(graph.reachable(at(55.8, 84.2)).size).toBe(graph.nodes.length);
    expect(graph.nodes.every((n) => n.x > 14.75 && n.x < 57)).toBe(true);
    expect(graph.nodes.every((n) => inBounds(lv, n.x, n.y, n.z))).toBe(true);
  });

  test('joins the four classroom doors to the exit without a detour to the east stairs', () => {
    for (const [x, z] of [[22.75, 83.35], [33.85, 83.35], [43.05, 83.25], [52.75, 83.15]]) {
      const start = at(x, z), finish = at(16.05, 84.25), path = graph.astar(start, finish);
      expect(path).not.toBeNull();
      let length = 0;
      for (let k = 1; k < path!.length; k++) {
        const a = graph.nodes[path![k - 1]], b = graph.nodes[path![k]];
        length += graph.dist(path![k - 1], path![k]);
        expect(walk(shutWorld, a, [[b.x, b.z]])).not.toBeNull();
        expect(b.x).toBeLessThanOrEqual(x + 0.1);
      }
      expect(length).toBeLessThan(Math.hypot(x - 16.05, z - 84.25) + 4);
    }
  });

  test('keeps the links across openable classroom doors', () => {
    for (const [x, z] of [[22.75, 83.35], [33.85, 83.35], [43.05, 83.25], [52.75, 83.15]]) {
      const outside = at(x, z), inside = at(x, 82.15);
      expect(graph.adj[outside]).toContain(inside);
      expect(walk(shutWorld, graph.nodes[outside], [[x, 82.15]])).toBeNull();
      expect(walk(openWorld, graph.nodes[outside], [[x, 82.15]])).not.toBeNull();
    }
  });
});
