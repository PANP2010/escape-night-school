import { describe, it, expect } from 'vitest';
import { NavGraph } from '../../shared/campus/nav.ts';
import { pickWardenStart } from '../../server/room.ts';

describe('pickWardenStart', () => {
  it('picks a same-storey node 25-40 m from the spawn', () => {
    const g = new NavGraph();
    const ids: number[] = [];
    for (let x = 0; x <= 120; x += 5) ids.push(g.addNode({ x, y: 0, z: 0 }), g.addNode({ x, y: 4, z: 0 }));
    for (let seed = 1; seed < 30; seed++) {
      let s = seed;
      const rng = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      const n = g.nodes[pickWardenStart(g, { x: 0, z: 0 }, ids, rng)];
      expect(n.y).toBe(0);
      expect(n.x).toBeGreaterThanOrEqual(25);
      expect(n.x).toBeLessThanOrEqual(40);
    }
  });
});
