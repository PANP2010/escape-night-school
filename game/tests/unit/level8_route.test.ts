import { beforeAll, describe, expect, it } from 'vitest';
import data from '../../shared/campus/colliders.json';
import { CollisionWorld, moveCapsule, overlaps } from '../../shared/campus/collision.ts';
import { campusNavCached } from '../../client/src/campus/world/navcache.ts';
import { NAV_CAPSULE, walk, type NavGraph } from '../../shared/campus/nav.ts';
import { L8 } from '../../shared/levels/l8.ts';
import { hasLevel, LEVELS, generateLevel, inArea, inBounds, inExit, levelSolids } from '../../shared/level.ts';
import { roomRoute } from '../../client/src/campus/world/interior.ts';
import { CAMPUS } from '../../client/src/campus/world/campus.ts';
import { storeyRooms } from '../../client/src/campus/world/rooms.ts';
import { officeFurniture } from '../../client/src/campus/world/office.ts';
import { finaleAreaNav, isFinaleGateLeaf } from '../../server/finale-nav.ts';

describe('L8 教务处 → 校门 route', () => {
  let graph: NavGraph;
  let campus: CollisionWorld;
  beforeAll(() => { ({ graph, world: campus } = campusNavCached('.cache/campus-nav.json')); }, 120_000);

  it('registers the complete campaign and the real finale at the eighth index', () => {
    expect(LEVELS).toHaveLength(8);
    expect(LEVELS[7]).toBe(L8);
    for (const n of [0, 1, 2, 3, 4, 5, 6, 7]) expect(hasLevel(n)).toBe(true);
    for (const n of [-1, 8, .5, Infinity]) expect(hasLevel(n)).toBe(false);
    expect(generateLevel(7, 18).def).toBe(L8);
  });

  it('starts in the actual OFF:1:jiaowu route and gives the squad walk-up access to the register desk', () => {
    const level = generateLevel(7, 1), finale = L8.finale!;
    expect(level.index).toBe(7);
    expect(L8.building).toBe('OFF');
    expect(L8.floors).toEqual([1]);
    expect(L8.spawns).toHaveLength(4);
    const b = CAMPUS.buildings.find(v => v.id === 'OFF')!, room = storeyRooms(b, 1).find(v => v.id === 'jiaowu')!;
    const route = roomRoute(b, 1, 'jiaowu');
    expect(room.name).toBe('教务处');
    expect(route.some(([x, z]) => Math.hypot(x + 23.55, z - 127.95) < 0.2)).toBe(true);
    const desk = officeFurniture(b, room, 0).render.filter(p => p.kind === 'desk' && p.y1 === 0.76);
    expect(desk.some(p => finale.rollcall.x >= p.x0 - 20 && finale.rollcall.x <= p.x1 - 20 && finale.rollcall.z >= p.z0 + 130 && finale.rollcall.z <= p.z1 + 130)).toBe(true);
    const approach = { x: finale.rollcall.x, y: 0, z: finale.rollcall.z + 1.45 };
    const routeToBook: [number, number][] = [[-23.55, 129.15], [-23.55, 127.95], [approach.x, approach.z]];
    for (const sp of L8.spawns) expect(walk(campus, { x: sp.x, y: sp.y ?? 0, z: sp.z }, routeToBook), `spawn ${sp.x},${sp.z}`).not.toBeNull();
    const door = { x: -23.55, y: 0, z: 127.95 };
    expect(walk(campus, door, [[approach.x, approach.z]])).not.toBeNull();
    expect(overlaps(campus, { ...approach, vy: 0, grounded: true }, NAV_CAPSULE)).toBe(false);
    expect(Math.hypot(approach.x - finale.rollcall.x, approach.z - finale.rollcall.z)).toBeLessThan(1.5);
  });

  it('walks every marked leg with the player capsule, including the flag-platform detour and opened school gate', () => {
    // L8 opens the actual centre gate panel after roll call; retain its two side wall segments.
    const gate = (c: any) => c.minX === -4.8 && c.maxX === 4.8 && c.minZ === -8.125 && c.maxZ === -7.875 && c.maxY === 1.5;
    const world = new CollisionWorld([...(data.colliders as any[]).filter(c => !gate(c)), ...levelSolids(L8)]);
    for (const h of data.holes) world.addHole(h.x0, h.x1, h.z0, h.z1);
    const closedWorld = new CollisionWorld([...(data.colliders as any[]), ...levelSolids(L8)]);
    for (const h of data.holes) closedWorld.addHole(h.x0, h.x1, h.z0, h.z1);
    expect(walk(closedWorld, L8.finale!.route.at(-2)!, [[L8.exit.x, L8.exit.z]])).toBeNull();
    let p = L8.finale!.route[0];
    for (const [i, q] of L8.finale!.route.entries()) {
      const y = walk(world, { x: p.x, y: p.y ?? 0, z: p.z }, [[q.x, q.z]]);
      expect(y, `route leg ${i}: (${p.x},${p.z}) → (${q.x},${q.z})`).not.toBeNull();
      expect(Math.abs(y![0] - q.y), `route height ${i}`).toBeLessThan(0.3);
      expect(inBounds(generateLevel(7, 1), q.x, q.y, q.z), `route area ${i}`).toBe(true);
      p = q;
    }
    expect(L8.exitName).toContain('校门');
    expect(L8.exit.z).toBeLessThan(L8.finale!.gate!.z); // safety circle is farther outside than the gate waypoint
    expect(L8.finale!.gate!.z).toBeLessThan(-8.2); // outside the perimeter wall
    expect(inExit(generateLevel(7, 1), L8.finale!.gate!.x, 0, L8.finale!.gate!.z)).toBe(false);
  });

  it('places the whole register on a clear desktop without intersecting the office CRT or paperwork', () => {
    const b = CAMPUS.buildings.find(v => v.id === 'OFF')!, room = storeyRooms(b, 1).find(v => v.id === 'jiaowu')!;
    const furniture = officeFurniture(b, room, 0).render;
    const book = L8.finale!.rollcall, x0 = book.x - 0.24, x1 = book.x + 0.24, z0 = book.z - 0.175, z1 = book.z + 0.175;
    expect(furniture.some(p => p.kind === 'desk' && p.y1 === 0.76 &&
      x0 >= p.x0 - 20 && x1 <= p.x1 - 20 && z0 >= p.z0 + 130 && z1 <= p.z1 + 130)).toBe(true);
    for (const p of furniture) {
      if (p.y1 <= 0.762 || p.y0 >= 0.864) continue;
      const cx = (p.x0 + p.x1) / 2 - 20, cz = (p.z0 + p.z1) / 2 + 130;
      const hx = (p.x1 - p.x0) / 2, hz = (p.z1 - p.z0) / 2, c = Math.abs(Math.cos(p.rot ?? 0)), s = Math.abs(Math.sin(p.rot ?? 0));
      const rx = c * hx + s * hz, rz = s * hx + c * hz;
      expect(x1 <= cx - rx || x0 >= cx + rx || z1 <= cz - rz || z0 >= cz + rz, `register overlaps ${p.kind}`).toBe(true);
    }
  });

  it('keeps every marked route point in its declared region union, with the outdoor graph joining the office to the gate', () => {
    const level = generateLevel(7, 9), start = graph.nearest(L8.spawns[0].x, 0, L8.spawns[0].z);
    const reached = graph.reachable(start);
    const routeStart = graph.nearest(L8.finale!.route[0].x, L8.finale!.route[0].y, L8.finale!.route[0].z);
    expect(reached.has(routeStart)).toBe(true);
    const world = new CollisionWorld([...(data.colliders as any[]), ...levelSolids(L8)]);
    for (const h of data.holes) world.addHole(h.x0, h.x1, h.z0, h.z1);
    for (const sp of L8.spawns) expect(overlaps(world, { x: sp.x, y: sp.y ?? 0, z: sp.z, vy: 0, grounded: true }, NAV_CAPSULE)).toBe(false);
    const goal = graph.nearest(L8.finale!.route.at(-2)!.x, 0, L8.finale!.route.at(-2)!.z);
    expect(reached.has(goal)).toBe(true);
    for (const p of [...L8.finale!.route, L8.finale!.rollcall, L8.finale!.chaseSpawn]) {
      expect(inArea(level, p.x, p.y, p.z), JSON.stringify(p)).toBe(true);
    }
    for (const p of L8.spawns) expect(inArea(level, p.x, p.y ?? 0, p.z), JSON.stringify(p)).toBe(true);
    expect(inArea(level, L8.exit.x, L8.exit.y, L8.exit.z)).toBe(true);
    const gatePanel = (data.colliders as any[]).find(c => c.minZ > -8.2 && c.maxZ < -7.8 && c.minX < 4.8 && c.maxX > -4.8 && c.maxY === 1.5);
    expect(gatePanel).toBeDefined(); // server must open this existing panel before the final leg
  });

  it('region grates stop capsule movement off the campus route and stay beyond the finish radius', () => {
    const world = new CollisionWorld([...(data.colliders as any[]), ...levelSolids(L8)]);
    for (const h of data.holes) world.addHole(h.x0, h.x1, h.z0, h.z1);
    const west: any = { x: -14, y: 0, z: 100, vy: 0, grounded: true };
    moveCapsule(world, west, -3, 0, 0.05, NAV_CAPSULE);
    expect(west.x).toBeGreaterThan(-16);
    expect(west.x).toBeLessThan(-14);
    const south: any = { x: -2, y: 0, z: -11, vy: 0, grounded: true };
    expect(inExit(generateLevel(7, 1), south.x, south.y, south.z)).toBe(true);
    expect(L8.regions!.at(-1)!.z0).toBeLessThan(L8.exit.z - L8.exit.r - 0.3);
    south.z = -15;
    moveCapsule(world, south, 0, -8, 0.05, NAV_CAPSULE);
    expect(south.z).toBeGreaterThan(-16);
    expect(south.z).toBeLessThan(-15.4);
  });

  it('keeps the OFF stairs physically closed while every escape navigation edge and authored waypoint remains walkable', () => {
    const level = generateLevel(7, 9), nav = finaleAreaNav(level);
    const world = new CollisionWorld([...(data.colliders as any[]).filter(c => !isFinaleGateLeaf(c)), ...levelSolids(L8)]);
    for (const h of data.holes) world.addHole(h.x0, h.x1, h.z0, h.z1);
    const stairs = { x: -12.2, y: 0, z: 132.5, vy: 0, grounded: true };
    for (let i = 0; i < 60; i++) moveCapsule(world, stairs, .05, 0, .05, NAV_CAPSULE);
    expect(stairs.x).toBeLessThan(-11.85);
    expect(stairs.y).toBe(0);
    const start = nav.nearest(L8.spawns[0].x, 0, L8.spawns[0].z), reached = nav.reachable(start);
    for (const p of [...L8.spawns, ...L8.finale!.route, L8.finale!.chaseSpawn]) {
      const n = nav.nearest(p.x, p.y ?? 0, p.z);
      expect(reached.has(n), JSON.stringify(p)).toBe(true);
      expect(Math.hypot(nav.nodes[n].x - p.x, nav.nodes[n].z - p.z), JSON.stringify(p)).toBeLessThan(.75);
    }
    for (const [i, a] of nav.nodes.entries()) for (const j of nav.adj[i]) {
      const b = nav.nodes[j], ys = walk(world, a, [[b.x, b.z]]);
      expect(ys, `escape edge ${i}->${j}`).not.toBeNull();
      expect(ys![0]).toBeCloseTo(b.y);
    }
  });
});
