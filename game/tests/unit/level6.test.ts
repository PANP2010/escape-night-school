import { beforeAll, describe, expect, it } from 'vitest';
import data from '../../shared/campus/colliders.json';
import { CollisionWorld, groundHeight, moveCapsule, overlaps, type AABB, type Body } from '../../shared/campus/collision.ts';
import { lineOfSight, NAV_CAPSULE, walk, type NavGraph, type NavNode } from '../../shared/campus/nav.ts';
import { barrierBox, exitOpen, generateLevel, inArea, inBounds, inExit, levelSolids } from '../../shared/level.ts';
import { L6 } from '../../shared/levels/l6.ts';
import { campusNavCached } from '../../client/src/campus/world/navcache.ts';
import { CAMPUS } from '../../client/src/campus/world/campus.ts';
import { classroomFurniture } from '../../client/src/campus/world/classroom.ts';
import { storeyRooms } from '../../client/src/campus/world/rooms.ts';
import { levelAreaNav } from '../../server/room.ts';

const level = generateLevel(5, 6);
const world = (barriers = true) => {
  const w = new CollisionWorld([...(data.colliders as AABB[]), ...(barriers ? levelSolids(L6) : [])]);
  for (const h of data.holes) w.addHole(h.x0, h.x1, h.z0, h.z1);
  return w;
};

/** Walk the same capsule as a player, with every classroom door open (the least restrictive containment case). */
function flood(w: CollisionWorld) {
  const step = 0.5, sp = L6.spawns[0];
  const key = (b: Body) => `${Math.round(b.x / step)},${Math.round(b.z / step)},${Math.round(b.y / 0.3)}`;
  const start: Body = { x: sp.x, y: sp.y!, z: sp.z, vy: 0, grounded: true };
  moveCapsule(w, start, 0, 0, 0.05, NAV_CAPSULE);
  const seen = new Map<string, Body>([[key(start), start]]), queue = [start], outside: Body[] = [];
  while (queue.length) {
    const b = queue.pop()!;
    for (let k = 0; k < 8; k++) {
      const angle = k / 8 * Math.PI * 2, next = { ...b };
      for (let j = 0; j < 4; j++) moveCapsule(w, next, Math.cos(angle) * step / 4, Math.sin(angle) * step / 4, 0.05, NAV_CAPSULE);
      if (Math.hypot(next.x - b.x, next.z - b.z) < step * 0.3 || seen.has(key(next))) continue;
      seen.set(key(next), next);
      if (!inBounds(level, next.x, next.y, next.z)) outside.push(next); else queue.push(next);
    }
  }
  return { cells: [...seen.values()], outside };
}

describe('第6关「考场」真实教学楼A四、五楼', () => {
  let nav: NavGraph;
  beforeAll(() => { nav = levelAreaNav(campusNavCached('.cache/campus-nav.json').graph, level); }, 120_000);

  it('uses four 4F spawns, a 5F exit, one monitor and distinct clues across both floors', () => {
    expect(L6.name).toBe('考场');
    expect(L6.building).toBe('A');
    expect(L6.floors).toEqual([4, 5]);
    expect(L6.spawns).toHaveLength(4);
    expect(new Set(L6.spawns.map((p) => `${p.x},${p.y},${p.z}`)).size).toBe(4);
    for (const p of L6.spawns) { expect(p.y).toBe(10.8); expect(inArea(level, p.x, p.y!, p.z)).toBe(true); }
    expect(L6.exit.y).toBe(14.4);
    expect(inExit(level, L6.exit.x, 14.4, L6.exit.z)).toBe(true);
    expect(inExit(level, L6.exit.x, 10.8, L6.exit.z)).toBe(false);
    expect(L6.monitor?.count).toBe(1);
    expect(L6.monitor?.spawns).toHaveLength(1);
    expect(L6.exam!.notices).toHaveLength(2);
    expect(L6.exam!.notices.map((n) => n.questions)).toEqual([[0, 1, 2], [3, 4]]);
    expect(L6.exam!.notices[0].y - 1.45).toBeCloseTo(10.8);
    expect(L6.exam!.notices[1].y - 1.45).toBeCloseTo(14.4);
    for (const p of [L6.exam!.paper, ...L6.exam!.notices]) expect(inArea(level, p.x, p.y, p.z)).toBe(true);
  });

  it('puts the paper exactly on the existing A.4F.class7 lectern, and each notice against a real wall beside a door', () => {
    const a = CAMPUS.buildings.find((b) => b.id === 'A')!, room = storeyRooms(a, 4).find((r) => r.id === 'class7')!;
    expect(room.name).toBe('高三（7）班');
    const lectern = classroomFurniture(a, room, 10.8).render.find((f) => f.kind === 'lectern')!, paper = L6.exam!.paper;
    expect(paper.x).toBeCloseTo(a.x + (lectern.x0 + lectern.x1) / 2, 2);
    expect(paper.z).toBeCloseTo(a.z + (lectern.z0 + lectern.z1) / 2, 2);
    expect(paper.y).toBeCloseTo(lectern.y1);
    for (const notice of L6.exam!.notices) {
      expect(notice.dir).toBe('x+');
      expect((data.colliders as AABB[]).some((c) => c.minX < notice.x - 0.1 && c.maxX > notice.x - 0.15
        && c.minY < notice.y && c.maxY > notice.y && c.minZ < notice.z && c.maxZ > notice.z)).toBe(true);
      expect(data.doors.some((d) => Math.abs(d.y0 - (notice.y - 1.45)) < 0.01 && Math.hypot(d.x - notice.x, d.z - notice.z) < 1.5)).toBe(true);
    }
  });

  it('keeps the standalone level at index 5 without consuming another campaign slot and generates batteries deterministically', () => {
    expect(level.index).toBe(5);
    expect(level.def).toBe(L6);
    expect(generateLevel(5, 6)).toEqual(level);
    for (let seed = 1; seed <= 40; seed++) {
      const seeded = generateLevel(5, seed);
      expect(seeded.items).toHaveLength(2);
      expect(new Set(seeded.items.map((i) => i.spot)).size).toBe(2);
      for (const item of seeded.items) { expect(item.kind).toBe('battery'); expect(inArea(seeded, item.x, item.y, item.z)).toBe(true); }
    }
  });

  it('opens only for an explicit authoritative fifth-argument true, never keys or a truthy forged flag', () => {
    expect(exitOpen(level, 999, { stair_key: 9 })).toBe(false);
    expect(exitOpen(level, 999, { stair_key: 9 }, { step: 999, loops: 0, mistakes: 0 })).toBe(false);
    for (const flag of [false, undefined, null, 0, 1, 'true', {}]) expect(exitOpen(level, 0, {}, undefined, flag as boolean)).toBe(false);
    expect(exitOpen(level, 0, {}, undefined, true)).toBe(true);
  });

  it('grounds every player, monitor and candidate battery on an unobstructed real floor', () => {
    const w = world();
    const places = [...L6.spawns, ...L6.monitor!.spawns!, ...L6.items.flatMap((g) => g.spots)];
    for (const place of places) {
      const body: Body = { x: place.x, y: place.y!, z: place.z, vy: 0, grounded: true };
      expect(overlaps(w, body, NAV_CAPSULE), JSON.stringify(place)).toBe(false);
      expect(groundHeight(w, place.x, place.z, NAV_CAPSULE.radius, place.y! + NAV_CAPSULE.stepHeight), JSON.stringify(place)).toBeCloseTo(place.y!, 3);
    }
  });

  it('maps each shared hiding footprint to a real locker on both active storeys', () => {
    const a = CAMPUS.buildings.find((b) => b.id === 'A')!;
    for (const floor of L6.floors) {
      const lockers = storeyRooms(a, floor).filter((r) => r.kind === 'classroom')
        .flatMap((r) => classroomFurniture(a, r, (floor - 1) * 3.6).render.filter((f) => f.kind === 'locker'));
      expect(lockers.length).toBeGreaterThan(0);
      for (const hide of L6.hides.filter((h) => Math.abs(h.y! - (floor - 1) * 3.6) < 0.01)) {
        expect(hide.kind).toBe('locker');
        expect(lockers.some((l) => hide.x >= a.x + l.x0 && hide.x <= a.x + l.x1
          && hide.z >= a.z + l.z0 && hide.z <= a.z + l.z1), JSON.stringify({ floor, hide })).toBe(true);
      }
    }
  });

  it('all actual area nav nodes are connected, and every spawn reaches both floors and the monitor', () => {
    expect(nav.nodes.length).toBeGreaterThan(100);
    for (const n of nav.nodes) expect(inBounds(level, n.x, n.y, n.z), JSON.stringify(n)).toBe(true);
    for (const sp of L6.spawns) {
      const from = nav.nearest(sp.x, sp.y!, sp.z), reach = nav.reachable(from);
      expect(reach.size).toBe(nav.nodes.length);
      for (const p of [L6.exam!.paper, ...L6.exam!.notices, L6.exit, ...L6.monitor!.spawns!]) {
        const y = 'questions' in p ? p.y! - 1.45 : p === L6.exam!.paper ? 10.8 : p.y!;
        expect(reach.has(nav.nearest(p.x, y, p.z)), JSON.stringify(p)).toBe(true);
      }
    }
  });

  it('every retained nav edge is physically walkable with the authored boundary grates in place', () => {
    const w = world();
    for (let i = 0; i < nav.nodes.length; i++) {
      const from = nav.nodes[i];
      expect(overlaps(w, { ...from, vy: 0, grounded: true }, NAV_CAPSULE), JSON.stringify(from)).toBe(false);
      for (const j of nav.adj[i]) {
        if (j <= i) continue;
        const to = nav.nodes[j], ys = walk(w, from, [[to.x, to.z]]), label = JSON.stringify({ from, to });
        expect(ys, label).not.toBeNull();
        expect(Math.abs(ys![0] - to.y), label).toBeLessThan(0.3);
      }
    }
  });

  it('walks the real double-flight staircase up and down using the player capsule without teleportation', () => {
    const w = world();
    const points: NavNode[] = [
      { x: -54.45, y: 10.8, z: 72.75 }, { x: -54.65, y: 10.8, z: 66.45 },
      { x: -56.45, y: 10.8, z: 66.45 }, { x: -58, y: 10.8, z: 64.555 },
      { x: -64.06, y: 12.6, z: 64.555 }, { x: -64.06, y: 12.6, z: 67.485 },
      { x: -58, y: 14.4, z: 67.485 }, { x: -56.45, y: 14.4, z: 66.45 },
    ];
    for (const route of [points, [...points].reverse()]) {
      const ys = walk(w, route[0], route.slice(1).map((n) => [n.x, n.z]));
      expect(ys).not.toBeNull();
      route.slice(1).forEach((p, i) => expect(ys![i], JSON.stringify(p)).toBeCloseTo(p.y, 1));
    }
    // The 5F collection zone lies in the open strip south of the classroom, reached around its south wall.
    const exitPath = walk(w, points.at(-1)!, [[-56.45, 70.4], [L6.exit.x, L6.exit.z]]);
    expect(exitPath).not.toBeNull();
    expect(exitPath!.at(-1)).toBeCloseTo(14.4);
  });

  it('provides reachable, collision-free reading positions within 2m and a clear eye ray to each paper', () => {
    const w = world(), targets = [L6.exam!.paper, ...L6.exam!.notices];
    const stands = [
      { x: -60.86, y: 10.8, z: 73.51 },
      { x: -56.32, y: 10.8, z: 74.35 },
      { x: -56.32, y: 14.4, z: 78.75 },
    ];
    targets.forEach((target, i) => {
      const stand = stands[i], near = nav.nodes[nav.nearest(stand.x, stand.y, stand.z)];
      expect(overlaps(w, { ...stand, grounded: true, vy: 0 }, NAV_CAPSULE)).toBe(false);
      expect(walk(w, near, [[stand.x, stand.z]])).not.toBeNull();
      expect(Math.hypot(stand.x - target.x, stand.z - target.z)).toBeLessThan(2);
      expect(lineOfSight(w, { ...stand, y: stand.y + 1.55 }, target)).toBe(true);
    });
  });

  it('fits four separate player capsules inside the upstairs collection zone with a walkable approach', () => {
    const w = world(), landing = { x: -56.45, y: 14.4, z: 66.45 };
    const stands = [-0.45, 0.45].flatMap((dx) => [-0.45, 0.45].map((dz) => ({
      x: L6.exit.x + dx, y: L6.exit.y, z: L6.exit.z + dz, vy: 0, grounded: true,
    })));
    for (const [i, stand] of stands.entries()) {
      expect(inExit(level, stand.x, stand.y, stand.z), JSON.stringify(stand)).toBe(true);
      expect(overlaps(w, stand, NAV_CAPSULE), JSON.stringify(stand)).toBe(false);
      expect(groundHeight(w, stand.x, stand.z, NAV_CAPSULE.radius, stand.y + NAV_CAPSULE.stepHeight)).toBeCloseTo(14.4, 3);
      const ys = walk(w, landing, [[landing.x, L6.exit.z], [L6.exit.x, L6.exit.z], [stand.x, stand.z]]);
      expect(ys, JSON.stringify(stand)).not.toBeNull();
      expect(ys!.at(-1)).toBeCloseTo(stand.y, 3);
      for (const other of stands.slice(i + 1)) expect(Math.hypot(stand.x - other.x, stand.z - other.z)).toBeGreaterThan(NAV_CAPSULE.radius * 2);
    }
  });

  it('physically contains capsule walking on 4–5F while keeping clues, paper, item spots and exit reachable', () => {
    const { cells, outside } = flood(world());
    expect(cells.length).toBeGreaterThan(1000);
    expect(outside.map((b) => [+b.x.toFixed(2), +b.y.toFixed(2), +b.z.toFixed(2)])).toEqual([]);
    expect(cells.some((b) => inExit(level, b.x, b.y, b.z))).toBe(true);
    const goals = [
      { ...L6.exam!.paper, y: 10.8 },
      ...L6.exam!.notices.map((n) => ({ ...n, y: n.y - 1.45 })),
      ...L6.items.flatMap((g) => g.spots),
    ];
    for (const goal of goals) expect(cells.some((b) => Math.hypot(b.x - goal.x, b.z - goal.z) < 1.5 && Math.abs(b.y - goal.y) < 0.5), JSON.stringify(goal)).toBe(true);
    expect(cells.some((b) => b.y < 10.2 || b.y > 17.5)).toBe(false);
  }, 300_000);

  it('the closed exit door seals every capsule approach while keeping both floors of clues and the paper reachable', () => {
    const w = world(); w.add(barrierBox(L6.exam!.exitGate!));
    const { cells, outside } = flood(w);
    expect(outside).toEqual([]);
    expect(cells.length).toBeGreaterThan(1000);
    expect(cells.filter((b) => inExit(level, b.x, b.y, b.z)).map((b) => [b.x, b.y, b.z])).toEqual([]);
    // Check the physical strip too, independently of the trigger radius: no route may get behind the shut door.
    const gate = L6.exam!.exitGate!;
    expect(cells.filter((b) => b.x < gate.x0 && b.z > 69 && b.z < 71.96 && Math.abs(b.y - gate.y) < 0.5)
      .map((b) => [b.x, b.y, b.z])).toEqual([]);
    const goals = [{ ...L6.exam!.paper, y: 10.8 }, ...L6.exam!.notices.map((n) => ({ ...n, y: n.y - 1.45 }))];
    for (const goal of goals) expect(cells.some((b) => Math.hypot(b.x - goal.x, b.z - goal.z) < 1.5 && Math.abs(b.y - goal.y) < 0.5), JSON.stringify(goal)).toBe(true);
  }, 300_000);

  it('the authored barriers are what prevent escapes through the bridge, lower staircase or roof', () => {
    expect(flood(world(false)).outside.length).toBeGreaterThan(0);
  }, 300_000);
});
