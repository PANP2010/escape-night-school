import { describe, expect, it } from 'vitest';
import { broadcastGoalPoint, guideWaypoint, shutDoorOn } from '../../client/src/guide.ts';
import { campusNavCached } from '../../client/src/campus/world/navcache.ts';
import { CollisionWorld, moveCapsule, type AABB, type Body } from '../../shared/campus/collision.ts';
import { lineOfSight, NAV_CAPSULE, NavGraph } from '../../shared/campus/nav.ts';
import data from '../../shared/campus/colliders.json';
import { campusDoorSlab, doorTargetIn, type DoorSpot } from '../../shared/doors.ts';
import { generateLevel, inExit, levelSolids } from '../../shared/level.ts';
import { L4 } from '../../shared/levels/l4.ts';
import { levelAreaNav } from '../../server/room.ts';

const clues = (values: (string | null)[] = [null, null, null, null], off = false) => ({ clues: values, off });
const at = (x: number, z: number, y = 0) => ({ x, y, z });

describe('L4 shared objective arrow', () => {
  it('shows the precise unread wall centre and its floor instead of a floor-level anonymous diamond', () => {
    const sticker = L4.broadcast!.stickers[3];
    const goal = broadcastGoalPoint(L4, clues(['3', '3', '4', null]), at(sticker.x, 130, sticker.y));
    expect(goal).toMatchObject({ x: sticker.x, y: sticker.y + 1.45, z: sticker.z, floorY: sticker.y,
      exact: true, label: '贴纸④ · 4楼', approach: { x: sticker.x, y: sticker.y, z: sticker.z - .65 } });
  });

  it('selects the nearest unread clue rather than password order, using the latest shared read state', () => {
    const from = at(-20, 130, 10.8);
    expect(broadcastGoalPoint(L4, clues(['3', '3', null, null]), from)?.label).toBe('贴纸④ · 4楼');
    expect(broadcastGoalPoint(L4, clues(['3', '3', null, '5']), from)?.label).toBe('贴纸③ · 4楼');
  });

  it('uses walking distance instead of a nearer clue behind a detour and skips disconnected clues', () => {
    const def = { ...L4, broadcast: { ...L4.broadcast!, stickers: [
      { x: 2, y: 0, z: .65, label: 'detour', face: 'z-' as const },
      { x: 0, y: 0, z: 10.65, label: 'direct', face: 'z-' as const },
      { x: 0, y: 3.6, z: .65, label: 'disconnected upper floor', face: 'z-' as const },
    ] } };
    const g = new NavGraph();
    g.chain([at(0, 0), at(-10, 0), at(-10, 15), at(2, 15), at(2, 0)]);
    g.link(0, g.addNode(at(0, 10)));
    g.addNode(at(0, 0, 3.6));
    const goal = broadcastGoalPoint(def, clues([null, null, null]), at(0, 0), g)!;
    expect(goal).toMatchObject({ x: 0, z: 10.65, floorY: 0 });
    expect(broadcastGoalPoint(def, clues(['1', '2', null]), at(0, 0), g)).toBeNull();
  });

  it('routes an elevated wall label through its true floor and stairs', () => {
    const g = new NavGraph();
    g.chain([at(0, 0, 7.2), at(4, 0, 7.2), at(4, 4, 10.8), at(0, 4, 10.8)]);
    // A node on a higher stair flight is vertically nearer the visible label but belongs to the wrong route.
    g.link(2, g.addNode(at(0, 4, 12.3)));
    const goal = { ...at(0, 4, 12.25), floorY: 10.8, approach: at(0, 4, 10.8) };
    const wp = guideWaypoint(g, at(0, 0, 7.2), goal);
    expect(wp).toMatchObject({ x: 4, y: 7.2, z: 0 });
    expect(wp.dist).toBeCloseTo(4 + Math.hypot(4, 3.6) + 4 + 1.45);
  });

  it('leads to the console only after all shared clues are read, then to the correct-floor exit', () => {
    const all = ['1', '2', '3', '4'], from = at(-20, 130, 10.8), console = L4.broadcast!.console;
    expect(broadcastGoalPoint(L4, clues(all), from)).toMatchObject({ x: console.x, y: console.y + 1.25,
      z: console.z - .18, floorY: console.y, label: '广播室 · 4楼' });
    expect(broadcastGoalPoint(L4, clues(all, true), from)).toMatchObject({ ...L4.exit, label: '集合点 · 3楼' });
    expect(broadcastGoalPoint(L4, clues(all, true), L4.exit)).toHaveProperty('arrived', true);
    expect(broadcastGoalPoint(L4, clues(all, true), { ...L4.exit, y: 10.8 })).not.toHaveProperty('arrived');
  });
});

describe('L4 guidance on the actual campus', () => {
  const nav = campusNavCached('.cache/campus-nav.json').graph;
  const graph = levelAreaNav(nav, generateLevel(3, 7));

  it('2/4 from the eastern third-floor corridor chooses the closer fourth-floor sticker and routes through stairs', () => {
    const w = new CollisionWorld([...(data.colliders as AABB[]), ...levelSolids(L4)]);
    for (const h of data.holes) w.addHole(h.x0, h.x1, h.z0, h.z1);
    const los = (a: ReturnType<typeof at>, b: ReturnType<typeof at>) => lineOfSight(w, a, b);
    const from = at(-14, 130, 7.2), goal = broadcastGoalPoint(L4, clues(['3', '3', null, null]), from, graph, los)!;
    expect(goal.label).toBe('贴纸④ · 4楼');
    const wp = guideWaypoint(graph, from, goal, los);
    expect(wp.y).toBeLessThan(9);
    expect(wp.dist).toBeGreaterThan(Math.hypot(goal.x - from.x, goal.z - from.z));
  });

  it.each([7.2, 10.8])('at y=%s follows unread clues, console and exit with real walls, doors and stairs', y => {
    const w = new CollisionWorld([...(data.colliders as AABB[]), ...levelSolids(L4)]);
    for (const h of data.holes) w.addHole(h.x0, h.x1, h.z0, h.z1);
    const doors = data.doors as DoorSpot[], open = doors.map(() => false);
    const slabs = doors.map(d => w.add(campusDoorSlab(d, false)));
    const los = (a: ReturnType<typeof at>, b: ReturnType<typeof at>) => lineOfSight(w, a, b);
    const state = clues(['3', '3', null, null]), body: Body = { ...at(-14, 130, y), vy: 0, grounded: true };
    const visited: string[] = [];
    let complete = false;
    for (let t = 0; t < 120; t += .25) {
      const goal = broadcastGoalPoint(L4, state, body, graph, los);
      expect(goal, JSON.stringify({ t, body, state, visited })).not.toBeNull();
      if (!goal) break;
      if (goal.arrived && state.off) { complete = true; break; }
      if (Math.abs(body.y - (goal.floorY ?? goal.y)) < .5
        && Math.hypot(body.x - goal.x, body.z - goal.z) < 1.5
        && los({ x: body.x, y: body.y + 1.6, z: body.z }, goal)) {
        const id = L4.broadcast!.stickers.findIndex(s => s.x === goal.x && s.z === goal.z);
        if (id >= 0) { state.clues[id] = '4'; visited.push(goal.label!); continue; }
        if (!state.off && state.clues.every(c => c !== null)) { state.off = true; visited.push('console'); continue; }
      }
      const wp = guideWaypoint(graph, body, goal, los, (a, b) => shutDoorOn(doors, open, a, b));
      const door = doorTargetIn(doors, body.x, body.z, Math.atan2(body.x - wp.x, body.z - wp.z), 1.8, body.y);
      if (door >= 0 && !open[door]) { open[door] = true; w.move(slabs[door], campusDoorSlab(doors[door], true)); }
      for (let i = 0; i < 5; i++) {
        const dx = wp.x - body.x, dz = wp.z - body.z, d = Math.hypot(dx, dz) || 1;
        moveCapsule(w, body, dx / d * Math.min(.3, d), dz / d * Math.min(.3, d), .05, NAV_CAPSULE);
      }
    }
    expect({ complete, visited, body }).toMatchObject({ complete: true, visited: ['贴纸④ · 4楼', '贴纸③ · 4楼', 'console'] });
    expect(inExit(L4, body.x, body.y, body.z)).toBe(true);
  });
});
