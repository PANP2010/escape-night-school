import { describe, expect, it } from 'vitest';
import campusData from '../../shared/campus/campus.json';
import data from '../../shared/campus/colliders.json';
import { floorStack, loadCampus, WALL_T } from '../../shared/campus/campus_schema.ts';
import { CollisionWorld, groundHeight, moveCapsule, overlaps, type AABB, type Body } from '../../shared/campus/collision.ts';
import { NAV_CAPSULE } from '../../shared/campus/nav.ts';
import { stairPlan } from '../../shared/campus/stairs.ts';
import { campusDoorSlab, doorTargetIn } from '../../shared/doors.ts';
import { exitOpen, generateLevel, inArea, inBounds, inExit, levelSolids, LEVELS } from '../../shared/level.ts';
import { L3 } from '../../shared/levels/l3.ts';
import { enterLoopDoor, freshLoop, loopDestination, loopSolved } from '../../shared/loop.ts';
import type { Vec3 } from '../../shared/protocol.ts';
import { storeyRooms } from '../../client/src/campus/world/rooms.ts';

const loop = L3.loop!, level = generateLevel(2, 17);
const building = loadCampus(campusData).buildings.find((b) => b.id === L3.building)!;
const floor = floorStack(building).find((f) => f.level === 3)!;
const open = Array<boolean>(data.doors.length).fill(true);
const bodyAt = (p: { x: number; y?: number; z: number }): Body => ({ x: p.x, y: p.y ?? floor.y, z: p.z, vy: 0, grounded: true });
const vec = (p: Body): Vec3 => [p.x, p.y, p.z];
const world = (shut = false) => {
  const w = new CollisionWorld([
    ...(data.colliders as AABB[]), ...levelSolids(L3),
    ...(shut ? data.doors.map((d) => campusDoorSlab(d, false)) : []),
  ]);
  for (const h of data.holes) w.addHole(h.x0, h.x1, h.z0, h.z1);
  return w;
};

/** Actual 10 cm capsule moves, not graph proximity: a wall, stair or desk makes the endpoint assertion fail. */
function walk(w: CollisionWorld, body: Body, x: number, z: number, onStep?: (from: Vec3, to: Vec3) => void) {
  const n = Math.max(1, Math.ceil(Math.hypot(x - body.x, z - body.z) / 0.1));
  const dx = (x - body.x) / n, dz = (z - body.z) / n;
  for (let i = 0; i < n; i++) {
    const from = vec(body);
    moveCapsule(w, body, dx, dz, 1 / 60, NAV_CAPSULE);
    onStep?.(from, vec(body));
  }
  expect(Math.hypot(body.x - x, body.z - z), `walk to ${x},${z}`).toBeLessThan(0.01);
  expect(body.y).toBeCloseTo(floor.y, 5);
  expect(body.grounded).toBe(true);
  expect(overlaps(w, body, NAV_CAPSULE)).toBe(false);
  expect(inBounds(level, body.x, body.y, body.z)).toBe(true);
}

describe('第 3 关「三楼·无尽走廊」真实校园参数', () => {
  it('uses B 3F only, with four clear spawns and deterministic batteries inside the same floor', () => {
    expect(LEVELS[2]).toBe(L3);
    expect(L3.name).toBe('三楼·无尽走廊');
    expect(L3.building).toBe('B');
    expect(L3.floors).toEqual([3]);
    expect(floor.y).toBe(7.2);
    expect(L3.spawns).toHaveLength(4);
    const w = world();
    for (const p of [...L3.spawns, L3.exit, loop.clue, ...loop.doors]) {
      expect(p.y).toBe(floor.y);
      expect(inArea(level, p.x, p.y!, p.z)).toBe(true);
    }
    for (const p of L3.spawns) {
      const b = bodyAt(p);
      expect(overlaps(w, b, NAV_CAPSULE), JSON.stringify(p)).toBe(false);
      expect(groundHeight(w, b.x, b.z, NAV_CAPSULE.radius, b.y + NAV_CAPSULE.stepHeight)).toBe(floor.y);
    }
    for (const y of [floor.y - 3.6, floor.y + 3.6]) {
      expect(inArea(level, L3.exit.x, y, L3.exit.z)).toBe(false);
      expect(inExit(level, L3.exit.x, y, L3.exit.z)).toBe(false);
    }
    for (let seed = 1; seed <= 40; seed++) {
      const lv = generateLevel(2, seed);
      expect(lv.items.map((i) => i.kind)).toEqual(['battery', 'battery']);
      expect(new Set(lv.items.map((i) => i.spot)).size).toBe(lv.items.length);
      for (const item of lv.items) expect(inArea(lv, item.x, item.y, item.z)).toBe(true);
    }
    expect(generateLevel(2, 17)).toEqual(level);
    expect(L3.lockedDoors).toEqual([]);
    expect(L3.blackout).toBeUndefined();
  });

  it('numbers the actual eight B3 classroom apertures, pairing both doors of each room', () => {
    const rooms = storeyRooms(building, 3).filter((r) => r.kind === 'classroom').sort((a, b) => a.x - b.x);
    expect(rooms).toHaveLength(4);
    expect(loop.sequence).toEqual(['303', '301', '304', '302']);
    expect(loop.doors.map((d) => d.id)).toEqual([112, 113, 114, 115, 116, 117, 118, 119]);
    expect(new Set(loop.doors.map((d) => d.id)).size).toBe(8);
    for (const [i, room] of rooms.entries()) {
      const doors = loop.doors.filter((d) => d.label === String(301 + i));
      expect(doors).toHaveLength(2);
      expect(room.doors).toHaveLength(2);
      for (const [j, d] of doors.entries()) {
        const actual = data.doors.find((a) => a.id === d.id)!;
        expect(actual).toBeDefined();
        expect(actual.alongX).toBe(true);
        expect(actual.locked).toBe(false);
        expect(d.x).toBeCloseTo(actual.x, 6);
        expect(d.z).toBeCloseTo(actual.z, 6);
        expect(d.y).toBe(actual.y0);
        expect(d.halfWidth * 2).toBeCloseTo(actual.box.x1 - actual.box.x0, 6);
        expect(room.doors![j].side).toBe('+z');
        expect(d.x).toBeCloseTo(building.x + room.x + room.doors![j].at, 6);
        expect(d.z).toBeCloseTo(building.z + room.z + room.d / 2, 6);
        expect(doorTargetIn(data.doors, d.x, d.z + 1, 0, 2.6, floor.y)).toBe(d.id);
        expect(doorTargetIn([actual], d.x, d.z + 1, 0, 2.6, floor.y - 3.6)).toBe(-1);
        expect(doorTargetIn([actual], d.x, d.z + 1, 0, 2.6, floor.y + 3.6)).toBe(-1);
      }
    }
  });

  it('the taped desk pile closes the real eastern stair aperture on 3F', () => {
    expect(building.stairwells).toHaveLength(1);
    const stair = stairPlan(building, building.stairwells![0], WALL_T);
    expect(stair.doorSide).toBe('-x');
    const barrier = L3.barriers.find((b) => b.kind === 'desks' && b.tape)!;
    const doorX = building.x + stair.rect.x0;
    expect(barrier.x0).toBeLessThan(doorX);
    expect(barrier.x1).toBeGreaterThanOrEqual(doorX);
    expect(barrier.z0).toBeLessThanOrEqual(building.z + stair.door[0]);
    expect(barrier.z1).toBeGreaterThanOrEqual(building.z + stair.door[1]);
    expect(barrier.y).toBe(floor.y);
    expect(barrier.h).toBeGreaterThan(NAV_CAPSULE.stepHeight);
  });
});

describe('L3 capsule routes and safe loop landings', () => {
  it('every spawn reaches the chalk clue and every real open doorway without changing storey', () => {
    const w = world();
    for (const spawn of L3.spawns) {
      const b = bodyAt(spawn);
      walk(w, b, loop.clue.x, loop.clue.z - 0.6);
      for (const d of loop.doors) {
        walk(w, b, b.x, 84.2);
        walk(w, b, d.x, 84.2);
        walk(w, b, d.x, d.z - 0.65);
        walk(w, b, d.x, 84.2);
      }
    }
  });

  it('closed campus doors physically stop entry while the corresponding open aperture permits it', () => {
    const closed = world(true), clear = world();
    for (const d of loop.doors) {
      const b = bodyAt({ x: d.x, y: d.y, z: d.z + 1 });
      for (let i = 0; i < 20; i++) moveCapsule(closed, b, 0, -0.1, 1 / 60, NAV_CAPSULE);
      expect(b.z, `closed ${d.id}`).toBeGreaterThan(d.z + 0.25);
      expect(overlaps(closed, b, NAV_CAPSULE)).toBe(false);
      walk(clear, b, d.x, d.z - 0.65);
    }
  });

  it('each spawn can solve the full sequence through real capsule movement, then reach the exit', () => {
    const w = world();
    for (const spawn of L3.spawns) {
      const b = bodyAt(spawn);
      let state = freshLoop(), warps = 0;
      const update = (from: Vec3, to: Vec3) => {
        state = enterLoopDoor(L3, state, from, to, open);
        const dest = loopDestination(L3, state, from, to);
        if (dest) { [b.x, b.y, b.z] = dest; warps++; }
      };
      for (const [step, label] of loop.sequence.entries()) {
        // 301's east door is before the seam; the west door can also be reached through its classroom.
        const d = loop.doors.filter((d) => d.label === label).at(-1)!;
        walk(w, b, d.x, 84.2, update);
        walk(w, b, d.x, d.z - 0.65, update);
        expect(state.step).toBe(step + 1);
        walk(w, b, d.x, 84.2, update);
      }
      expect(loopSolved(L3, state)).toBe(true);
      expect(exitOpen(level, 0, {}, state)).toBe(true);
      walk(w, b, L3.exit.x, L3.exit.z, update);
      expect(inExit(level, b.x, b.y, b.z)).toBe(true);
      expect(warps).toBe(0);
      expect(state.mistakes).toBe(0);
    }
  });

  it('all physically valid westward seam crossings land clear and do not immediately loop again', () => {
    const w = world(), state = freshLoop();
    let sources = 0;
    for (let ix = Math.ceil((loop.endX - .5) * 20); ix <= Math.floor(loop.endX * 20); ix++) {
      for (let iz = Math.ceil(loop.corridorZ * 20); iz <= Math.floor(L3.area.z1 * 20); iz++) {
        const b = bodyAt({ x: ix / 20, z: iz / 20 }), from: Vec3 = [loop.endX + .1, floor.y, b.z];
        if (!inBounds(level, b.x, b.y, b.z) || overlaps(w, b, NAV_CAPSULE) || overlaps(w, bodyAt({ x: from[0], z: from[2] }), NAV_CAPSULE)) continue;
        if (groundHeight(w, b.x, b.z, NAV_CAPSULE.radius, b.y + NAV_CAPSULE.stepHeight) !== floor.y) continue;
        const dest = loopDestination(L3, state, from, vec(b))!;
        expect(dest, JSON.stringify(b)).not.toBeNull();
        const landed = bodyAt({ x: dest[0], y: dest[1], z: dest[2] });
        expect(inBounds(level, ...dest)).toBe(true);
        expect(dest[1]).toBe(b.y); expect(dest[2]).toBe(b.z);
        expect(overlaps(w, landed, NAV_CAPSULE), JSON.stringify({ source: b, dest })).toBe(false);
        expect(groundHeight(w, landed.x, landed.z, NAV_CAPSULE.radius, landed.y + NAV_CAPSULE.stepHeight)).toBe(floor.y);
        expect(loopDestination(L3, state, dest, dest)).toBeNull();
        sources++;
      }
    }
    expect(sources).toBeGreaterThan(300);
  });

  it('a real route through both 301 doors and back east crosses no westward corridor seam', () => {
    const w = world(), b = bodyAt(L3.spawns[0]);
    let state = freshLoop(), warps = 0;
    const update = (from: Vec3, to: Vec3) => {
      state = enterLoopDoor(L3, state, from, to, open);
      if (loopDestination(L3, state, from, to)) warps++;
    };
    const west = loop.doors.find((d) => d.label === '301')!;
    const east = loop.doors.filter((d) => d.label === '301').at(-1)!;
    walk(w, b, east.x, 84.2, update);
    walk(w, b, east.x, east.z - .65, update);
    walk(w, b, west.x, west.z - .65, update);
    walk(w, b, west.x, 84.2, update);
    walk(w, b, east.x, 84.2, update);
    expect(warps).toBe(0);
  });
});
