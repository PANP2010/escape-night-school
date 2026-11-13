import { beforeAll, describe, expect, it } from 'vitest';
import { generateLevel, inArea, inExit, LEVELS } from '../../shared/level.ts';
import type { NavGraph } from '../../shared/campus/nav.ts';
import { CAMPUS } from '../../client/src/campus/world/campus.ts';
import { campusNavCached } from '../../client/src/campus/world/navcache.ts';
import { campusSpawns } from '../../client/src/campus/world/navgraph.ts';
import { storeyRooms } from '../../client/src/campus/world/rooms.ts';
import { classroomFurniture } from '../../client/src/campus/world/classroom.ts';

describe('levels as campus regions', () => {
  it('l1 = 教学楼A 1F', () => {
    expect(LEVELS[0].building).toBe('A');
    expect(LEVELS[0].floors).toEqual([1]);
  });

  it('l1 spawns are the campus entrance-hall spawns', () => {
    LEVELS[0].spawns.forEach((p, k) => {
      expect(p.x).toBeCloseTo(campusSpawns()[k].x, 2);
      expect(p.z).toBeCloseTo(campusSpawns()[k].z, 2);
    });
  });

  it('is deterministic per seed and the seed moves the items', () => {
    const a = generateLevel(0, 42), b = generateLevel(0, 42);
    expect(a).toEqual(b);
    const spots = (seed: number) => generateLevel(0, seed).items.map((i) => i.spot).join();
    expect(new Set(Array.from({ length: 20 }, (_, k) => spots(k + 1))).size).toBeGreaterThan(5);
  });

  it('draws the requested number of items, one per spot, inside the region', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const lv = generateLevel(0, seed);
      expect(lv.items.filter((i) => i.kind === 'stair_key' && !i.decoy)).toHaveLength(1);
      expect(lv.items.filter((i) => i.kind === 'drawer_key' && !i.decoy)).toHaveLength(1);
      expect(lv.items.filter((i) => i.decoy)).toHaveLength(2);
      expect(lv.items.filter((i) => i.kind === 'door_key')).toHaveLength(3);
      expect(lv.items.filter((i) => i.kind === 'battery')).toHaveLength(4);
      expect(new Set(lv.items.map((i) => i.spot)).size).toBe(lv.items.length);
      lv.items.forEach((it, k) => expect(it.id).toBe(k + 1));
      for (const it of lv.items) expect(inArea(lv, it.x, it.y, it.z), `${seed} ${it.spot}`).toBe(true);
    }
  });

  it('every stair-key spot is a real 讲台 of a 教学楼A 1F 教室', () => {
    const A = CAMPUS.buildings.find((b) => b.id === 'A')!;
    const lecterns = storeyRooms(A, 1).filter((r) => r.kind === 'classroom').map((r) => {
      const q = classroomFurniture(A, r, 0).render.find((f) => (f.kind as string) === 'lectern')!;
      return { x: A.x + (q.x0 + q.x1) / 2, z: A.z + (q.z0 + q.z1) / 2 };
    });
    for (const s of LEVELS[0].items[0].spots) {
      expect(lecterns.some((l) => Math.hypot(l.x - s.x, l.z - s.z) < 0.05), s.label).toBe(true);
    }
  });

  describe('nav', () => {
    let nav: NavGraph;
    beforeAll(() => { nav = campusNavCached('.cache/campus-nav.json').graph; }, 120_000);

    it('every spawn is inside the region and reaches the exit and every item spot', () => {
      const def = LEVELS[0], lv = generateLevel(0, 1);
      const at = (p: { x: number; z: number }, y: number) => nav.nearest(p.x, y, p.z);
      const exit = at(def.exit, def.exit.y);
      expect(Math.hypot(nav.nodes[exit].x - def.exit.x, nav.nodes[exit].z - def.exit.z)).toBeLessThan(def.exit.r);
      expect(inExit(lv, nav.nodes[exit].x, nav.nodes[exit].y, nav.nodes[exit].z)).toBe(true);
      for (const sp of def.spawns) {
        expect(inArea(lv, sp.x, 0, sp.z)).toBe(true);
        const reach = new Set(nav.reachable(at(sp, 0)));
        expect(reach.has(exit)).toBe(true);
        for (const g of def.items) for (const s of g.spots) expect(reach.has(at(s, 0)), s.label).toBe(true);
      }
    });

    it('the exit path stays inside the active storey', () => {
      const def = LEVELS[0], lv = generateLevel(0, 1);
      const path = nav.astar(nav.nearest(def.spawns[0].x, 0, def.spawns[0].z), nav.nearest(def.exit.x, def.exit.y, def.exit.z))!;
      expect(path).not.toBeNull();
      for (const i of path) expect(inArea(lv, nav.nodes[i].x, nav.nodes[i].y, nav.nodes[i].z)).toBe(true);
    });
  });
});
