/**
 * The arrow on the real L1/L2 campus: an ideal player walking at guideWaypoint (6 m/s, opening doors) reaches
 * the stair key / fuses, their next objectives and the exit from spawns and the recorded HUD bot stalls.
 */
import { describe, expect, test } from 'vitest';
import data from '../../shared/campus/colliders.json';
import { CollisionWorld, moveCapsule, type AABB, type Body } from '../../shared/campus/collision.ts';
import { lineOfSight, NAV_CAPSULE, walk as walkLeg } from '../../shared/campus/nav.ts';
import { campusNavCached } from '../../client/src/campus/world/navcache.ts';
import { generateLevel, inExit, levelSolids, LEVELS } from '../../shared/level.ts';
import { levelAreaNav } from '../../server/room.ts';
import { campusDoorSlab, doorTargetIn, type DoorSpot } from '../../shared/doors.ts';
import { ACT_REACH, pickNear } from '../../shared/interact.ts';
import { goalPoint, guideWaypoint, shutDoorOn } from '../../client/src/guide.ts';
import { objective } from '../../client/src/objective.ts';
import type { WorldItem } from '../../shared/protocol.ts';

const nav = campusNavCached('.cache/campus-nav.json').graph;
const doors = data.doors as DoorSpot[];
type P = { x: number; y: number; z: number };
type WalkState = { p?: P; open?: boolean[] };

/** Seconds to the key (null: not within `limit`) and how often the waypoint went A → B → A. */
function walk(seed: number, start: (lv: ReturnType<typeof generateLevel>) => P, limit = 40, toExit = false, kind: 'drawer_key' | 'stair_key' = 'stair_key', state?: WalkState) {
  const def = LEVELS[0], lv = generateLevel(0, seed);
  const w = new CollisionWorld([...(data.colliders as AABB[]), ...levelSolids(def)]);
  for (const h of data.holes) w.addHole(h.x0, h.x1, h.z0, h.z1);
  const open = doors.map((_, i) => state?.open?.[i] ?? false), locked = doors.map((d) => !!d.locked || lv.lockedDoors.includes(d.id));
  const slabs = doors.map((d) => w.add(campusDoorSlab(d, open[d.id])));
  const g = levelAreaNav(nav, lv);
  const items = lv.items.map((it) => ({ id: it.id, kind: it.kind, p: [it.x, it.y, it.z], ...(it.decoy ? { decoy: true } : {}) }) as WorldItem);
  const key = items.find((i) => i.kind === kind && !i.decoy)!;
  const o = objective(def, kind === 'stair_key' ? { drawer_key: 1 } : {}, 0), seen = new Set<number>();
  const s = state?.p ?? start(lv), b: Body = { x: s.x, y: s.y, z: s.z, vy: 0, grounded: true };
  moveCapsule(w, b, 0, 0, 0.05, NAV_CAPSULE);
  const los = (a: P, c: P) => lineOfSight(w, a, c);
  const wps: string[] = [];
  let flips = 0;
  for (let t = 0; t < limit; t += 0.25) {
    const eye = { x: b.x, y: b.y + 1.6, z: b.z }, k = { x: key.p[0], y: key.p[1] + 0.1, z: key.p[2] };
    const d = Math.hypot(k.x - eye.x, k.y - eye.y, k.z - eye.z);
    if (d <= 8 && los(eye, k)) seen.add(key.id);
    if (toExit ? inExit(lv, b.x, b.y, b.z) : d < ACT_REACH) {
      if (state) { state.p = { x: b.x, y: b.y, z: b.z }; state.open = [...open]; }
      return { t, flips };
    }
    const goal = toExit ? { x: lv.exit.x, y: lv.exit.y, z: lv.exit.z } : goalPoint(def, o, items, seen, b, g)!;
    const wp = guideWaypoint(g, b, goal, los, (a, c) => shutDoorOn(doors, open, a, c)), id = `${wp.x.toFixed(1)},${wp.z.toFixed(1)}`;
    if (id !== wps[wps.length - 1]) { if (id === wps[wps.length - 2]) flips++; wps.push(id); }
    const di = doorTargetIn(doors, b.x, b.z, Math.atan2(b.x - wp.x, b.z - wp.z), 1.8, b.y);
    if (di >= 0 && !open[di] && !locked[di]) { open[di] = true; w.move(slabs[di], campusDoorSlab(doors[di], true)); }
    // steering at the arrow's point every frame (it turns as you pass it)
    for (let i = 0; i < 5; i++) {
      const dx = wp.x - b.x, dz = wp.z - b.z, l = Math.hypot(dx, dz) || 1;
      moveCapsule(w, b, (dx / l) * 0.3, (dz / l) * 0.3, 0.05, NAV_CAPSULE);
    }
  }
  return { t: null, flips };
}

/** Follow the same visible / rough item targets as the HUD, collecting all three fuses before returning to the box. */
function walkFuses(seed: number, start: P, limit = 60) {
  const def = LEVELS[1], lv = generateLevel(1, seed), g = levelAreaNav(nav, lv);
  const w = new CollisionWorld([...(data.colliders as AABB[]), ...levelSolids(def)]);
  for (const h of data.holes) w.addHole(h.x0, h.x1, h.z0, h.z1);
  const slabs = doors.map((d) => w.add(campusDoorSlab(d, false))), open = doors.map(() => false);
  const locked = doors.map((d) => !!d.locked || lv.lockedDoors.includes(d.id));
  const items = lv.items.filter((it) => it.kind === 'fuse').map((it) => ({ id: it.id, kind: it.kind, p: [it.x, it.y, it.z] }) as WorldItem);
  const seen = new Set<number>(), picked: number[] = [], b: Body = { ...start, vy: 0, grounded: true };
  const los = (a: P, c: P) => lineOfSight(w, a, c);
  let inserted = 0;
  for (let t = 0; t < limit; t += 0.25) {
    const eye = { x: b.x, y: b.y + 1.6, z: b.z };
    for (const it of items) {
      const p = { x: it.p[0], y: it.p[1] + 0.1, z: it.p[2] };
      if (Math.hypot(p.x - eye.x, p.y - eye.y, p.z - eye.z) <= 8 && los(eye, p)) seen.add(it.id);
    }
    if (inserted && inExit(lv, b.x, b.y, b.z)) return { t, picked, left: items.length };
    const goal = goalPoint(def, objective(def, { fuse: picked.length }, inserted), items, seen, b, g)!;
    const wp = guideWaypoint(g, b, goal, los, (a, c) => shutDoorOn(doors, open, a, c));
    const yaw = Math.atan2(b.x - wp.x, b.z - wp.z), pi = pickNear(items, [b.x, b.y, b.z], yaw);
    if (pi >= 0 && los(eye, { x: items[pi].p[0], y: items[pi].p[1] + 0.1, z: items[pi].p[2] })) {
      picked.push(items[pi].id); items.splice(pi, 1); continue;
    }
    if (!items.length && !inserted && Math.hypot(b.x - def.blackout!.fuseBox.x, b.z - def.blackout!.fuseBox.z) < ACT_REACH) { inserted = 3; continue; }
    const di = doorTargetIn(doors, b.x, b.z, yaw, 1.8, b.y);
    if (di >= 0 && !open[di] && !locked[di]) { open[di] = true; w.move(slabs[di], campusDoorSlab(doors[di], true)); }
    for (let i = 0; i < 5; i++) {
      const dx = wp.x - b.x, dz = wp.z - b.z, l = Math.hypot(dx, dz) || 1;
      moveCapsule(w, b, (dx / l) * 0.3, (dz / l) * 0.3, 0.05, NAV_CAPSULE);
    }
  }
  return { t: null, picked, left: items.length, at: [b.x, b.y, b.z] };
}

describe('the arrow on the L2 campus', () => {
  test.each([1, 4, 10])('seed %i: from the east classroom stalls through all fuses, the box and the exit', (seed) => {
    const fuses = generateLevel(1, seed).items.filter((it) => it.kind === 'fuse').map((it) => it.id).sort((a, b) => a - b);
    for (const [x, z] of [[56.1, 80.5], [51.5, 83.2], [54.4, 77.9], [55.8, 84.2]]) {
      const r = walkFuses(seed, { x, y: 3.6, z });
      expect({ x, z, ...r, picked: r.picked.slice().sort((a, b) => a - b) }).toEqual({ x, z, t: expect.any(Number), picked: fuses, left: 0 });
    }
  });
});

describe('the arrow on the L1 campus', () => {
  test('the corridor node near (-36.5, 72.5) connects east along a capsule-walkable leg', () => {
    const lv = generateLevel(0, 1), g = levelAreaNav(nav, lv), i = g.nearest(-36.5, 0, 72.5), n = g.nodes[i];
    expect(Math.hypot(n.x + 36.5, n.z - 72.5)).toBeLessThan(0.1);
    const w = new CollisionWorld([...(data.colliders as AABB[]), ...levelSolids(lv.def), ...doors.map((d) => campusDoorSlab(d, false))]);
    for (const h of data.holes) w.addHole(h.x0, h.x1, h.z0, h.z1);
    const east = g.adj[i].filter((j) => g.nodes[j].x > n.x + 0.5 && Math.abs(g.nodes[j].z - n.z) < 0.5);
    expect(east.length).toBeGreaterThan(0);
    expect(east.some((j) => walkLeg(w, n, [[g.nodes[j].x, g.nodes[j].z]]) !== null)).toBe(true);
  });
  test.each([1, 4, 7, 10])('seed %i: all three objectives are walkable in order with real collision and doors', (seed) => {
    for (let sp = 0; sp < generateLevel(0, seed).spawns.length; sp++) {
      // Continue from the actual pickup stance with the doors already opened. An item's x/z at feet y=0
      // is inside its solid lectern; resolving that artificial start can push the walker onto the wrong side.
      const state: WalkState = {}, start = (lv: ReturnType<typeof generateLevel>) => ({ x: lv.spawns[sp].x, y: lv.spawns[sp].y ?? 0, z: lv.spawns[sp].z });
      const first = walk(seed, start, 40, false, 'drawer_key', state);
      expect({ sp, ...first }).toEqual({ sp, t: expect.any(Number), flips: 0 });
      const second = walk(seed, start, 40, false, 'stair_key', state);
      expect({ sp, ...second }).toEqual({ sp, t: expect.any(Number), flips: 0 });
      const last = walk(seed, start, 40, true, 'stair_key', state);
      expect({ sp, ...last }).toEqual({ sp, t: expect.any(Number), flips: 0 });
    }
  });
  test.each(Array.from({ length: 12 }, (_, i) => i + 1))('seed %i: from every spawn to the unlocked stair-key drawer', (seed) => {
    for (let sp = 0; sp < generateLevel(0, seed).spawns.length; sp++) {
      const r = walk(seed, (lv) => ({ x: lv.spawns[sp].x, y: lv.spawns[sp].y ?? 0, z: lv.spawns[sp].z }));
      expect({ sp, ...r }).toEqual({ sp, t: expect.any(Number), flips: 0 });
      expect(r.t).toBeLessThan(20);
    }
  });
  test.each(Array.from({ length: 12 }, (_, i) => i + 1))('seed %i: from the key to the exit', (seed) => {
    const r = walk(seed, (lv) => { const k = lv.items.find((i) => i.kind === 'stair_key')!; return { x: k.x, y: 0, z: k.z }; }, 40, true);
    expect(r).toEqual({ t: expect.any(Number), flips: 0 });
    expect(r.t).toBeLessThan(20);
  });
  test('seed 3: from where the e2e bot got stuck (the corridor node with no link east, the lobby, the west hall)', () => {
    for (const [x, z] of [[-38.4, 74], [-36.4, 68.2], [-43.6, 70.6], [-54.4, 63.6], [-41.4, 75.3], [-54.9, 79.7], [-56.5, 91.8]]) {
      const r = walk(3, () => ({ x, y: 0, z }));
      expect({ x, z, ...r }).toEqual({ x, z, t: expect.any(Number), flips: 0 });
      expect(r.t).toBeLessThan(20);
    }
  });
  // #226: the key on the lectern of the classroom at x -25..-15, z 63..72; the desk rows block the knee rays to it and to
  // the room's one node, so 1 m from it the arrow led 23 m out round the west aisle (the bot never got 「E 拾取」)
  test.each([1, 10])('seed %i: the key on the lectern behind the desk rows', (seed) => {
    const lv = generateLevel(0, seed), k = lv.items.find((i) => i.kind === 'stair_key')!;
    expect([k.x, k.z].map((v) => Math.round(v))).toEqual([-16, 68]);
    const w = new CollisionWorld([...(data.colliders as AABB[]), ...levelSolids(LEVELS[0])]);
    const los = (a: P, c: P) => lineOfSight(w, a, c);
    for (const [x, z] of [[-15.5, 66.8], [-16.5, 69], [-18, 68]]) {
      const wp = guideWaypoint(levelAreaNav(nav, lv), { x, y: 0, z }, { x: k.x, y: k.y, z: k.z }, los);
      expect({ x, z, wp: [wp.x, wp.z] }).toEqual({ x, z, wp: [k.x, k.z] });
    }
    for (const [x, z] of [[-24.4, 63.8], [-20.3, 71.7], [-23, 72.5], [-24.9, 64.6], [-40.4, 65.3]]) {
      const r = walk(seed, () => ({ x, y: 0, z }));
      expect({ x, z, ...r }).toEqual({ x, z, t: expect.any(Number), flips: 0 });
      expect(r.t).toBeLessThan(20);
    }
  });
  // #226: the exit chain's west hall node (-55.2, 73.4) linked only east (-40, 73.4) and south, not to the hall's own
  // nodes 1 m off it, so from the west hall the arrow led 15 m east and back (e2e 乙 out of time on 集合); levelAreaNav
  // now links near nodes a capsule walks between
  test('seed 1: from the west hall to the exit, no detour east', () => {
    const g = levelAreaNav(nav, generateLevel(0, 1)), at = (x: number, z: number) => g.nearest(x, 0, z);
    expect(g.adj[at(-55.2, 73.4)]).toEqual(expect.arrayContaining([expect.toSatisfy((j: number) => Math.hypot(g.nodes[j].x + 55.6, g.nodes[j].z - 74.4) < 1.5)]));
    for (const [x, z] of [[-46.1, 75.4], [-47.7, 75.2], [-60, 78], [-54.9, 83.7], [-56.5, 81.4], [-48.5, 72.5], [-38.7, 72.6]]) {
      const r = walk(1, () => ({ x, y: 0, z }), 40, true);
      expect({ x, z, ...r }).toEqual({ x, z, t: expect.any(Number), flips: 0 });
      expect(r.t).toBeLessThan(20);
    }
  });
  test.each([1, 4, 10].flatMap((seed) =>
    [[-27.2, 0, 93], [-60, 0.9, 65.3], [-56.7, 0, 64.5], [-28.9, 0, 75.2], [-54.4, 0, 68], [-56.5, 0, 82], [-59.8, 0, 82.5], [-59.8, 0, 84.3], [-59.8, 0, 88]]
      .map(([x, y, z]) => ({ seed, x, y, z }))))('seed $seed: the remaining L1 exit stall ($x, $y, $z)', ({ seed, x, y, z }) => {
    const r = walk(seed, () => ({ x, y, z }), 40, true);
    expect({ x, y, z, ...r }).toEqual({ x, y, z, t: expect.any(Number), flips: 0 });
    expect(r.t).toBeLessThan(20);
  });
});

// #223/#227 B3a: on L2's first floor the A* node past a shut door 0.4 m ahead read as「through the wall」(the k = 1 rule);
// the arrow now points at the door itself (its「E 打开」is the next step), and past it once the door is open
describe('a shut door on the way', () => {
  test('L2 y 3.6: the arrow points at the shut door, then through it once open', () => {
    const lv = generateLevel(1, 1), g = levelAreaNav(nav, lv), door = doors.find((d) => d.y0 === 3.6 && Math.hypot(d.x - 52.85, d.z - 82.64) < 0.1)!;
    const w = new CollisionWorld([...(data.colliders as AABB[]), ...levelSolids(LEVELS[1])]);
    for (const h of data.holes) w.addHole(h.x0, h.x1, h.z0, h.z1);
    const slabs = doors.map((d) => w.add(campusDoorSlab(d, false))), open = doors.map(() => false);
    const los = (a: P, c: P) => lineOfSight(w, a, c), shut = (a: P, c: P) => shutDoorOn(doors, open, a, c);
    // Use the real lectern inside the classroom's east wall (x 53.85..54.05), reached through this door.
    const fuse = lv.items.find((it) => it.kind === 'fuse' && it.spot === 's4')!;
    const from = { x: 53.2, y: 3.6, z: 83.0 }, goal = { x: fuse.x, y: fuse.y, z: fuse.z };
    const past = guideWaypoint(g, from, goal, los);
    expect(shutDoorOn(doors, open, from, past)).toEqual({ x: door.x, y: 3.6, z: door.z });
    const wp = guideWaypoint(g, from, goal, los, shut);
    expect([wp.x, wp.y, wp.z]).toEqual([door.x, 3.6, door.z]);
    expect(wp.dist).toBe(past.dist);
    // facing the arrow, the door is in reach to open (the bot's / a player's 「E 打开」)
    expect(doorTargetIn(doors, from.x, from.z, Math.atan2(from.x - wp.x, from.z - wp.z), 2.6, from.y)).toBe(door.id);
    open[door.id] = true;
    w.move(slabs[door.id], campusDoorSlab(door, true));
    const after = guideWaypoint(g, from, goal, los, shut);
    expect(after.z).toBeLessThan(door.box.z0);
    // the storey matters: the ground floor's door under it, shut, is not on the way
    expect(shutDoorOn(doors, doors.map((d) => d.id === door.id), from, after)).toBeNull();
  });
  // iter-227 e2e: 1.3 m out, the doorway node 0.5 m this side of the door is the waypoint; the walk to it doesn't cross
  // the door, the leg after it does: the door itself
  test('L1 y 0: on the near side of a doorway node, the arrow points at the shut door past it', () => {
    const lv = generateLevel(0, 1), g = levelAreaNav(nav, lv), door = doors.find((d) => (d.y0 ?? 0) === 0 && Math.hypot(d.x + 45.15, d.z - 72.06) < 0.1)!;
    const w = new CollisionWorld([...(data.colliders as AABB[]), ...levelSolids(LEVELS[0])]);
    for (const h of data.holes) w.addHole(h.x0, h.x1, h.z0, h.z1);
    const slabs = doors.map((d) => w.add(campusDoorSlab(d, false))), open = doors.map(() => false);
    const los = (a: P, c: P) => lineOfSight(w, a, c), shut = (a: P, c: P) => shutDoorOn(doors, open, a, c);
    const from = { x: -45.15, y: 0, z: 73.36 }, goal = { x: -45.55, y: 0, z: 67.65 };
    const node = guideWaypoint(g, from, goal, los);
    expect(node.z).toBeGreaterThan(door.box.z1);
    expect(shutDoorOn(doors, open, from, node)).toBeNull();
    const wp = guideWaypoint(g, from, goal, los, shut);
    expect([wp.x, wp.y, wp.z]).toEqual([door.x, 0, door.z]);
    expect(wp.dist).toBe(node.dist);
    open[door.id] = true;
    w.move(slabs[door.id], campusDoorSlab(door, true));
    const after = guideWaypoint(g, from, goal, los, shut);
    expect(Math.hypot(after.x - door.x, after.z - door.z)).toBeGreaterThan(0.3);
  });
});
