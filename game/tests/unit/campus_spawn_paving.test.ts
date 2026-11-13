import { describe, expect, it } from 'vitest';
import { CAMPUS } from '../../client/src/campus/world/campus.ts';
import { curbBoxes, paveQuads, paveShade } from '../../client/src/campus/world/paving.ts';

const paving = CAMPUS.paving ?? [];
const pavedAt = (x: number, z: number) => paving.find(p => p.pattern !== 'lawn'
  && Math.abs(x - p.x) < p.w / 2 && Math.abs(z - p.z) < p.d / 2);
const curbs = curbBoxes(paving);

describe('royale north spawn paving (R13-2)', () => {
  it('gives the spawn a narrow paved route with joints and curbs in its first 3–5 metres', () => {
    const path = pavedAt(6, 192.3);
    expect(path, 'spawn must stand on a path').toBeDefined();
    if (!path) return;
    expect(path.w).toBeLessThanOrEqual(4);
    expect(paveQuads(path).some(q => q.pattern !== 0 && q.pattern !== 4
      && q.x0 < 6 && q.x1 > 6 && q.z0 < 192.3 && q.z1 > 192.3)).toBe(true);
    for (const ahead of [3, 4, 5]) {
      expect(pavedAt(6, 192.3 - ahead)).toBe(path);
      // Both raised edges must continue beside the first visible stretch of road.
      for (const side of [-1, 1]) expect(curbs.some(b => b.y1 >= 0.1
        && Math.abs((b.x0 + b.x1) / 2 - 6) <= 2.2
        && Math.sign((b.x0 + b.x1) / 2 - 6) === side
        && b.z0 < 192.3 - ahead && b.z1 > 192.3 - ahead)).toBe(true);
    }
    // A real shader joint within the 3–5 m band, compared with the adjacent slab interior.
    const jointZ = Math.floor(189.3 / path.tile[1]) * path.tile[1], x = 6 + path.tile[0] / 4;
    expect(jointZ).toBeGreaterThanOrEqual(187.3);
    expect(paveShade(path.pattern, path.tile, x, jointZ, [0.01, 0.01]))
      .toBeLessThan(paveShade(path.pattern, path.tile, x, jointZ + path.tile[1] / 4, [0.01, 0.01]) - 0.1);
    // Grass/ground on both sides must survive; a new apron covering the back field fails this.
    expect(pavedAt(0, 192.3)).toBeUndefined();
    expect(pavedAt(12, 192.3)).toBeUndefined();
  });

  it('connects to the boiler road without a transverse curb or a floating paving gap', () => {
    const path = pavedAt(6, 192.3), road = pavedAt(6, 172);
    expect(path).toBeDefined();
    expect(road).toBeDefined();
    if (!path || !road) return;
    const joinZ = road.z + road.d / 2;
    expect(path.z - path.d / 2).toBe(joinZ);
    // Check the entire mouth, including room for a capsule at each side, rather than only its centre.
    expect(curbs.filter(b => b.x1 > path.x - path.w / 2 + 0.3 && b.x0 < path.x + path.w / 2 - 0.3
      && b.z1 > joinZ - 0.2 && b.z0 < joinZ + 0.2)).toEqual([]);
  });
});
