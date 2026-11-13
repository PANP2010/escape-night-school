import { beforeAll, describe, expect, it } from 'vitest';
import { lineOfSight, NAV_CAPSULE, walk, type NavGraph } from '../../shared/campus/nav.ts';
import { overlaps, type CollisionWorld } from '../../shared/campus/collision.ts';
import { floorStack } from '../../shared/campus/campus_schema.ts';
import { CAMPUS } from '../../client/src/campus/world/campus.ts';
import { campusNav, campusSpawns, spawnRoute } from '../../client/src/campus/world/navgraph.ts';

describe('campus nav graph', () => {
  let graph: NavGraph, world: CollisionWorld, failures: string[], start: number;
  beforeAll(() => {
    ({ graph, world, failures } = campusNav());
    const s = campusSpawns()[0];
    start = graph.nearest(s.x, 0, s.z);
  }, 120_000);

  it('walks every room route and reaches every storey of every building from the 教学楼A spawn', () => {
    expect(failures).toEqual([]);
    const reached = new Set([...graph.reachable(start)].map(i => graph.nodes[i].tag));
    for (const b of CAMPUS.buildings) for (const { level } of floorStack(b)) expect(reached, `${b.id}:${level}`).toContain(`${b.id}:${level}`);
  });

  it('A* goes around walls, every leg walkable', () => {
    const goal = graph.nodes.findIndex(n => n.tag === 'B:3');
    const path = graph.astar(start, goal)!;
    expect(path).not.toBeNull();
    const a = graph.nodes[start], g = graph.nodes[goal];
    let len = 0;
    for (let i = 1; i < path.length; i++) {
      const p = graph.nodes[path[i - 1]], q = graph.nodes[path[i]];
      len += graph.dist(path[i - 1], path[i]);
      expect(walk(world, p, [[q.x, q.z]]), `leg ${i}`).not.toBeNull();
    }
    expect(len).toBeGreaterThan(Math.hypot(a.x - g.x, a.y - g.y, a.z - g.z) * 1.2);
    expect(g.y).toBeGreaterThan(5);
  });

  it('nearest stays on the storey asked for', () => {
    const g = graph.nodes[graph.nodes.findIndex(n => n.tag === 'A:3')];
    expect(Math.abs(graph.nodes[graph.nearest(g.x, g.y, g.z)].y - g.y)).toBeLessThan(0.3);
  });

  it('spawns are clear and the spawn route walks into a classroom', () => {
    for (const s of campusSpawns()) expect(overlaps(world, { ...s, y: 0, vy: 0, grounded: true }, NAV_CAPSULE)).toBe(false);
    const r = spawnRoute(), ys = walk(world, { x: r[0][0], y: 0, z: r[0][1] }, r.slice(1));
    expect(ys).not.toBeNull();
    expect(Math.max(...ys!.map(Math.abs))).toBeLessThan(0.2);
  });

  it('line of sight: blocked by 教学楼A walls, clear across open ground', () => {
    const A = CAMPUS.buildings.find(b => b.id === 'A')!, eye = 1.6;
    // into 教室 s1 (local x -9, beside the south entrance) below the window sills
    const outside = { x: A.x - 9, y: 0.5, z: A.z - A.d / 2 - 6 }, inside = { x: A.x - 9, y: 0.5, z: A.z - 12.35 };
    expect(lineOfSight(world, { ...outside, x: A.x }, { ...inside, x: A.x })).toBe(true); // through the entrance
    expect(lineOfSight(world, outside, inside)).toBe(false);
    const o = graph.nodes.filter(n => n.tag === 'out');
    const pair = o.flatMap(p => o.filter(q => q.x === p.x && q.z === p.z + 4 && q.y === p.y && p.y === 0).map(q => [p, q] as const))[0];
    expect(pair).toBeDefined();
    expect(lineOfSight(world, { ...pair[0], y: eye }, { ...pair[1], y: eye })).toBe(true);
  });
});
