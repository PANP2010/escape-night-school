import { expect, it } from 'vitest';
import { l4StairDoors } from '../../server/l4-nav.ts';
import { CollisionWorld, overlaps, type AABB } from '../../shared/campus/collision.ts';
import { NAV_CAPSULE, NavGraph, walk } from '../../shared/campus/nav.ts';
import campusData from '../../shared/campus/colliders.json';
import { L4 } from '../../shared/levels/l4.ts';

const world = new CollisionWorld(campusData.colliders as AABB[]);
for (const h of campusData.holes) world.addHole(h.x0, h.x1, h.z0, h.z1);

it('mounts the L4 fire cabinet against a solid wall rather than the open stair approach', () => {
  const cabinet = L4.landmarks.find(m => m.kind === 'hydrant')!;
  expect(cabinet.dir).toBe('z-');
  const rear = cabinet.z + .11 + .005;
  for (const x of [cabinet.x - .35, cabinet.x + .35]) for (const y of [cabinet.y + .5, cabinet.y + 1.5]) {
    expect(campusData.colliders.some(b => x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY && rear >= b.minZ && rear <= b.maxZ), `backing wall at ${x},${y},${rear}`).toBe(true);
  }
  expect(walk(world, { x: -18, y: 7.2, z: 130 }, [[-14.5, 130], [-14.5, 134.13], [-12.1, 134.13]])).not.toBeNull();
});

it('L4 preserves legal east-corridor links south of the stair enclosure on both floors', () => {
  for (const y of [7.2, 10.8]) {
    const graph = new NavGraph();
    const [a, b] = graph.chain([{ x: -13.35, y, z: 130.95 }, { x: -9.05, y, z: 129.15 }]);
    l4StairDoors(graph);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.adj[a]).toContain(b);
    expect(walk(world, graph.nodes[a], [[graph.nodes[b].x, graph.nodes[b].z]])).not.toBeNull();
    expect(walk(world, graph.nodes[b], [[graph.nodes[a].x, graph.nodes[a].z]])).not.toBeNull();
  }
});

it('L4 stair detours keep every connecting leg clear in both directions', () => {
  for (const y of [7.2, 10.8]) {
    const graph = new NavGraph();
    const [a, b] = graph.chain([{ x: -14.5, y, z: 130 }, { x: -12, y, z: 132.74 }]);
    l4StairDoors(graph);
    expect(graph.adj[a]).not.toContain(b);
    expect(graph.nodes).toHaveLength(4);
    graph.adj.forEach((links, i) => {
      for (const j of links) {
        const from = graph.nodes[i], to = graph.nodes[j];
        expect(walk(world, from, [[to.x, to.z]]), `${y}: ${i} → ${j}`).not.toBeNull();
        // Warden follows the straight edge. A sliding player walker alone can conceal a bad edge.
        for (let k = 0; k <= 50; k++) {
          const t = k / 50;
          expect(overlaps(world, {
            x: from.x + (to.x - from.x) * t, y, z: from.z + (to.z - from.z) * t,
            vy: 0, grounded: true,
          }, NAV_CAPSULE), `${y}: ${i} → ${j} at ${t}`).toBe(false);
        }
      }
    });
  }
});
