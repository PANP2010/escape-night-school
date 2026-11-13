// Each level stays inside its area: walking (the players' capsule, every door open) from the spawn never leaves
// inBounds because the level's barriers are in the way, the exit is still reachable, and the area nav 角色074 walks
// is inside the area and joins spawn to exit.
import { describe, expect, test } from 'vitest';
import data from '../../shared/campus/colliders.json';
import { CollisionWorld, groundHeight, moveCapsule, overlaps, type AABB, type Body } from '../../shared/campus/collision.ts';
import { NAV_CAPSULE } from '../../shared/campus/nav.ts';
import { campusNavCached } from '../../client/src/campus/world/navcache.ts';
import { fallenBox, generateLevel, inBounds, inExit, levelSolids, LEVELS } from '../../shared/level.ts';
import { levelAreaNav } from '../../server/room.ts';
import { freshLoop, loopDestination } from '../../shared/loop.ts';
import { isFinaleGateLeaf } from '../../server/finale-nav.ts';

/** 8-way flood fill on a 0.5 m grid with moveCapsule steps; stops at cells outside inBounds (returned as `out`). */
function flood(w: CollisionWorld, lv: ReturnType<typeof generateLevel>) {
  const S = 0.5, sp = lv.spawns[0];
  const key = (b: Body) => `${Math.round(b.x / S)},${Math.round(b.z / S)},${Math.round(b.y / 0.6)}`;
  const start: Body = { x: sp.x, y: sp.y ?? 0, z: sp.z, vy: 0, grounded: true };
  moveCapsule(w, start, 0, 0, 0.05, NAV_CAPSULE);
  const seen = new Map<string, Body>([[key(start), start]]), q = [start], out: Body[] = [];
  while (q.length) {
    const b = q.pop()!;
    for (let k = 0; k < 8; k++) {
      const ang = (k / 8) * Math.PI * 2, n = { ...b };
      for (let s = 0; s < 4; s++) moveCapsule(w, n, (Math.cos(ang) * S) / 4, (Math.sin(ang) * S) / 4, 0.05, NAV_CAPSULE);
      if (Math.hypot(n.x - b.x, n.z - b.z) < S * 0.3 || seen.has(key(n))) continue;
      seen.set(key(n), n);
      if (!inBounds(lv, n.x, n.y, n.z)) out.push(n); else q.push(n);
    }
  }
  return { cells: [...seen.values()], out };
}

describe('level area containment', () => {
  const graph = campusNavCached('.cache/campus-nav.json').graph;
  for (const def of LEVELS) {
    const lv = generateLevel(LEVELS.indexOf(def), 1);
    test(`${def.name}: walking never leaves the area, the exit is reachable`, () => {
      // This test opens every door. L8's centre gate is a static campus leaf,
      // opened authoritatively after roll call, so include that opening here too.
      const campus = (data.colliders as AABB[]).filter(b => !def.finale || !isFinaleGateLeaf(b));
      const w = new CollisionWorld([...campus, ...levelSolids(def)]);
      for (const h of data.holes) w.addHole(h.x0, h.x1, h.z0, h.z1);
      const { cells, out } = flood(w, lv);
      expect(cells.length).toBeGreaterThan(500);
      expect(out.map((b) => [+b.x.toFixed(1), +b.y.toFixed(2), +b.z.toFixed(1)])).toEqual([]);
      expect(cells.some((b) => inExit(lv, b.x, b.y, b.z))).toBe(true);
      // the fallen desks close off dead ends, not item spots: every spot of every kind is still walkable to
      for (const s of def.items.flatMap((it) => it.spots)) {
        expect(cells.some((b) => Math.hypot(b.x - s.x, b.z - s.z) < 1.5 && Math.abs(b.y - s.y) < 1.5), s.label).toBe(true);
      }
      if (def.loop) {
        const lp = def.loop;
        // A nearest graph node alone cannot establish a capsule route through a classroom aperture.
        const targets = [
          ...lv.spawns, { ...lp.clue, z: lp.clue.z - 0.6 },
          ...lp.doors.flatMap((d) => [{ ...d, z: d.z + 0.65 }, { ...d, z: d.z - 0.65 }]),
        ];
        for (const target of targets) {
          expect(cells.some((b) => Math.hypot(b.x - target.x, b.z - target.z) < 0.75 && Math.abs(b.y - (target.y ?? lv.exit.y)) < 0.1), JSON.stringify(target)).toBe(true);
        }
        // B3's classrooms have 20 cm lectern platforms; none of the flood reaches the real stair's half-floor.
        expect(cells.filter((b) => b.y < lv.exit.y - 0.001 || b.y > lv.exit.y + NAV_CAPSULE.stepHeight + 0.001)).toEqual([]);
        let landings = 0;
        for (const b of cells) {
          const dest = loopDestination(def, freshLoop(), [lp.endX + .1, b.y, b.z], [b.x, b.y, b.z]);
          if (!dest) continue;
          const landed = { x: dest[0], y: dest[1], z: dest[2], vy: 0, grounded: true };
          expect(inBounds(lv, ...dest)).toBe(true);
          expect(overlaps(w, landed, NAV_CAPSULE), JSON.stringify({ source: b, dest })).toBe(false);
          expect(groundHeight(w, landed.x, landed.z, NAV_CAPSULE.radius, landed.y + NAV_CAPSULE.stepHeight)).toBe(lv.exit.y);
          landings++;
        }
        expect(landings).toBeGreaterThan(10);
      }
    }, 300_000);
    test(`${def.name}: wayfinding — sign, lit room and fallen desks inside the area, desks clear of spawns, exit and nav`, () => {
      for (const k of ['arrow', 'hydrant', 'sign', 'lit', 'fallen'] as const) expect(def.landmarks.some((m) => m.kind === k), k).toBe(true);
      for (const m of def.landmarks) expect(inBounds(lv, m.x, m.y, m.z), JSON.stringify(m)).toBe(true);
      const r = NAV_CAPSULE.radius, nav = levelAreaNav(graph, lv);
      for (const m of def.landmarks.filter((l) => l.kind === 'fallen')) {
        const f = fallenBox(m), near = (x: number, z: number, d: number) => x > f.minX - d && x < f.maxX + d && z > f.minZ - d && z < f.maxZ + d;
        for (const sp of lv.spawns) expect(near(sp.x, sp.z, 1), `spawn ${JSON.stringify(sp)}`).toBe(false);
        expect(near(lv.exit.x, lv.exit.z, lv.exit.r)).toBe(false);
        // no nav node under the desk (角色074 would be stuck on it) and it is propped against something, not floating mid-room
        for (const n of nav.nodes) expect(near(n.x, n.z, r) && Math.abs(n.y - m.y) < 1, `node ${JSON.stringify(n)}`).toBe(false);
        const g = (data.colliders as AABB[]).filter((c) => c.maxY > m.y + 0.3 && c.minY < m.y + 1);
        expect(g.some((c) => c.minX < f.maxX + 0.1 && c.maxX > f.minX - 0.1 && c.minZ < f.maxZ + 0.1 && c.maxZ > f.minZ - 0.1), JSON.stringify(m)).toBe(true);
        expect(g.some((c) => c.minX < f.maxX && c.maxX > f.minX && c.minZ < f.maxZ && c.maxZ > f.minZ), `inside a wall ${JSON.stringify(m)}`).toBe(false);
      }
    });
    test(`${def.name}: without the barriers it does leave (they are what holds it)`, () => {
      const w = new CollisionWorld(data.colliders as AABB[]);
      for (const h of data.holes) w.addHole(h.x0, h.x1, h.z0, h.z1);
      expect(flood(w, lv).out.length).toBeGreaterThan(0);
    }, 300_000);
    test(`${def.name}: every area nav node is in bounds, spawn and exit connected`, () => {
      const nav = levelAreaNav(graph, lv), sp = lv.spawns[0];
      expect(nav.nodes.length).toBeGreaterThan(20);
      expect(nav.nodes.length).toBeLessThan(graph.nodes.length);
      for (const n of nav.nodes) expect(inBounds(lv, n.x, n.y, n.z), JSON.stringify(n)).toBe(true);
      const a = nav.nearest(sp.x, sp.y ?? 0, sp.z), b = nav.nearest(lv.exit.x, lv.exit.y, lv.exit.z);
      expect(Math.hypot(nav.nodes[b].x - lv.exit.x, nav.nodes[b].z - lv.exit.z)).toBeLessThan(lv.exit.r + 3);
      expect(nav.astar(a, b)).not.toBeNull();
      // all of the area graph hangs together (no corridor cut off by the area's cut)
      expect(nav.reachable(a).size).toBeGreaterThan(nav.nodes.length * 0.9);
      if (def.loop) {
        const reached = nav.reachable(a);
        for (const target of [def.loop.clue, ...def.loop.doors]) {
          const n = nav.nearest(target.x, target.y, target.z);
          expect(Math.abs(nav.nodes[n].y - target.y)).toBeLessThan(0.1);
          expect(reached.has(n), JSON.stringify(target)).toBe(true);
        }
      }
    });
  }
});
