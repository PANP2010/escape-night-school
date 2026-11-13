import { describe, expect, it } from 'vitest';
import campus from '../../shared/campus/campus.json';
import campusData from '../../shared/campus/colliders.json';
import { overlaps, type Body } from '../../shared/campus/collision.ts';
import type { CampusDef } from '../../shared/campus/campus_schema.ts';
import { lineOfSight, walk } from '../../shared/campus/nav.ts';
import { exitOpen, generateLevel, hasLevel, inExit, levelDefinition, LEVELS } from '../../shared/level.ts';
import { L1 } from '../../shared/levels/l1.ts';
import { L2 } from '../../shared/levels/l2.ts';
import { L3 } from '../../shared/levels/l3.ts';
import { L4 } from '../../shared/levels/l4.ts';
import {
  inMirrorHall, L7, L7_CAPSULE, L7_CAMPUS_DOORS, L7_EXIT, L7_INDEX, l7Colliders, l7World,
  MIRROR_DOORS, mirrorForPlayer, mirrorPoint, MIRRORS, mirrorYaw, wallPointFromReflection, type MirrorSurface,
} from '../../shared/levels/l7.ts';
import type { Vec3 } from '../../shared/protocol.ts';

const body = (p: Vec3): Body => ({ x: p[0], y: p[1], z: p[2], grounded: true, vy: 0 });
const nearPoint = (actual: Vec3, expected: Vec3): void => actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 8));
const direction = (yaw: number): Vec3 => [-Math.sin(yaw), 0, -Math.cos(yaw)];

describe('L7 uses the real LAB rooms without changing ordinary progression', () => {
  it('registers the real seventh chapter within the complete campaign', () => {
    expect(L7_INDEX).toBe(6);
    expect(LEVELS[2]).toBeDefined();
    expect(LEVELS[2]).not.toBe(L7);
    for (const level of LEVELS) expect(level).toBeDefined();
    expect(LEVELS[L7_INDEX]).toBe(L7);
    expect(L7.building).toBe('LAB');
    expect(L7.floors).toEqual([1, 2]);
    expect(L7.spawns).toHaveLength(4);
    expect(LEVELS).toHaveLength(8);
    for (const [index, definition] of [L1, L2, L3, L4].entries()) {
      expect(LEVELS[index]).toBe(definition);
      expect(levelDefinition(index)).toBe(definition);
      expect(generateLevel(index, 72).def).toBe(definition);
      expect(hasLevel(index)).toBe(true);
    }
    expect(levelDefinition(6)).toBe(L7);
    expect(hasLevel(6)).toBe(true);
    expect(generateLevel(6, 72)).toMatchObject({ index: 6, seed: 72, name: '镜廊', def: L7 });
    expect(generateLevel(6, 72)).toEqual(generateLevel(6, 72));
    for (const index of [8, -1, 0.5, Infinity, NaN]) {
      expect(hasLevel(index)).toBe(false);
      expect(() => generateLevel(index, 72)).toThrow(RangeError);
    }
  });

  it('opens the campaign exit only after the shared mirror key and both actual wall doors', () => {
    const level = generateLevel(6, 1), bag = { stair_key: 10 };
    expect(exitOpen(level, 99, bag)).toBe(false);
    expect(exitOpen(level, 99, bag, true)).toBe(false);
    expect(exitOpen(level, 99, bag, { step: 99, loops: 0, mistakes: 0 })).toBe(false);
    expect(exitOpen(level, 99, bag, { keyTaken: false, openDoors: [1, 2] })).toBe(false);
    expect(exitOpen(level, 99, bag, { keyTaken: true, openDoors: [1] })).toBe(false);
    expect(exitOpen(level, 0, {}, { keyTaken: true, openDoors: [2, 1] })).toBe(true);
  });

  it('puts the mirrors and east-wall doorways in dark / specimen, one storey apart', () => {
    const lab = (campus as unknown as CampusDef).buildings.find((b) => b.id === 'LAB')!;
    for (const [i, roomId] of ['dark', 'specimen'].entries()) {
      const room = lab.floors![i].rooms!.find((r) => r.id === roomId)!;
      const mirror = MIRRORS[i], door = MIRROR_DOORS[i];
      expect(lab.x + room.x - room.w / 2).toBeCloseTo(-82.35);
      expect(lab.x + room.x + room.w / 2).toBeCloseTo(-77.65);
      expect(lab.z + room.z - room.d / 2).toBeCloseTo(141.3);
      expect(lab.z + room.z + room.d / 2).toBeCloseTo(146.76);
      expect(mirror.center[0]).toBeGreaterThan(-82.25); // room side of the west partition
      expect(mirror.normal).toEqual([1, 0, 0]);
      expect(door.wall).toEqual([-77.65, i * 3.6, 143.4]);
      expect(door.normal).toEqual([-1, 0, 0]);
      expect(door.mirrorId).toBe(mirror.id);
      expect(campusData.colliders.some((b) => b.minX === -77.75 && b.maxX === -77.55 &&
        b.minY === door.wall[1] && b.minZ <= door.wall[2] - door.width / 2 && b.maxZ >= door.wall[2] + door.width / 2)).toBe(true);
    }
  });

  it('has clear spawns, real open campus entrances, and an exit restricted to 2F hallE', () => {
    const world = l7World();
    for (const p of L7.spawns) {
      expect(overlaps(world, body([p.x, p.y!, p.z]), L7_CAPSULE)).toBe(false);
      // Being clear at spawn is insufficient if the room's furniture leaves that slot trapped.
      expect(walk(l7World([1]), { x: p.x, y: p.y ?? 0, z: p.z }, [[-80.05, 143.4], [-76.2, 143.4]], L7_CAPSULE)).toEqual([0, 0]);
    }
    expect(L7_CAMPUS_DOORS.find((d) => d.id === 154)).toMatchObject({ x: -81.25, z: 141.3, y0: 0, locked: false });
    expect(L7_CAMPUS_DOORS.find((d) => d.id === 162)).toMatchObject({ x: -81.25, z: 141.3, y0: 3.6, locked: false });
    expect(L7_CAMPUS_DOORS.every((d) => (d.y0 ?? 0) < 7.2)).toBe(true);
    expect(overlaps(world, body([-81.25, 0, 141.3]), L7_CAPSULE)).toBe(false);
    expect(overlaps(world, body([-81.25, 3.6, 141.3]), L7_CAPSULE)).toBe(false);
    expect(inExit({ exit: L7_EXIT }, L7_EXIT.x, 3.6, L7_EXIT.z)).toBe(true);
    expect(inExit({ exit: L7_EXIT }, L7_EXIT.x, 0, L7_EXIT.z)).toBe(false);
    expect(overlaps(world, body([L7_EXIT.x, 3.6, L7_EXIT.z]), L7_CAPSULE)).toBe(false);
  });
});

describe('mirror geometry', () => {
  it('reflects twice back to the original point on both real storeys', () => {
    for (const mirror of MIRRORS) for (const p of [mirror.center, [-80, mirror.center[1] + 0.4, 142.7] as Vec3, [-76, 0, 146] as Vec3]) {
      nearPoint(mirrorPoint(mirror, mirrorPoint(mirror, p)), p);
      expect(mirrorPoint(mirror, p)[1]).toBe(p[1]);
      expect(mirrorPoint(mirror, p)[2]).toBe(p[2]);
    }
  });

  it('maps a door that only appears behind the glass back to its real wall', () => {
    for (const door of MIRROR_DOORS) {
      const mirror = MIRRORS.find((m) => m.id === door.mirrorId)!;
      const virtual = mirrorPoint(mirror, door.wall);
      expect(virtual[0]).toBeLessThan(mirror.center[0]);
      nearPoint(wallPointFromReflection(mirror, virtual), door.wall);
      for (const dz of [-door.width / 2, door.width / 2]) {
        const corner: Vec3 = [door.wall[0], door.wall[1] + door.height, door.wall[2] + dz];
        nearPoint(wallPointFromReflection(mirror, mirrorPoint(mirror, corner)), corner);
      }
    }
  });

  it('shows the whole reflected doorway through the actual glass above the specimen worktop', () => {
    const world = l7World();
    for (const door of MIRROR_DOORS) {
      const mirror = MIRRORS.find((m) => m.id === door.mirrorId)!;
      const eye = { x: -80.4, y: door.wall[1] + 1.55, z: 143.4 };
      expect(lineOfSight(world, eye, { x: mirror.center[0], y: mirror.center[1], z: mirror.center[2] })).toBe(true);
      for (const y of [door.wall[1], door.wall[1] + door.height]) for (const dz of [-door.width / 2, door.width / 2]) {
        const virtual = mirrorPoint(mirror, [door.wall[0], y, door.wall[2] + dz]);
        const t = (mirror.center[0] - eye.x) / (virtual[0] - eye.x);
        const glass = { x: mirror.center[0], y: eye.y + t * (virtual[1] - eye.y), z: eye.z + t * (virtual[2] - eye.z) };
        expect(t).toBeGreaterThan(0);
        expect(t).toBeLessThan(1);
        expect(Math.abs(glass.y - mirror.center[1])).toBeLessThan(mirror.height / 2);
        expect(Math.abs(glass.z - mirror.center[2])).toBeLessThan(mirror.width / 2);
        expect(lineOfSight(world, eye, glass)).toBe(true);
      }
    }
  });

  it('supports shifted planes, opposite normals, non-unit normals and diagonal walls', () => {
    const p: Vec3 = [4, 3, -5];
    for (const normal of [[2, 0, 0], [-1, 0, 0], [0, 0, -1], [1, 0, 1]] as Vec3[]) {
      const m: MirrorSurface = { id: 9, center: [2, 1, -1], normal, width: 3, height: 2 };
      nearPoint(mirrorPoint(m, mirrorPoint(m, p)), p);
      for (const yaw of [0, 0.47, Math.PI / 2, -2.1, Math.PI]) {
        const original = direction(yaw), reflected = direction(mirrorYaw(m, yaw));
        const originReflection = mirrorPoint({ ...m, center: [0, 0, 0] }, original);
        nearPoint(reflected, originReflection);
        nearPoint(direction(mirrorYaw(m, mirrorYaw(m, yaw))), original);
      }
    }
    nearPoint(mirrorPoint({ ...MIRRORS[0], normal: [-1, 0, 0] }, p), mirrorPoint(MIRRORS[0], p));
  });

  it('uses the camera yaw convention and excludes backs, other storeys, halls behind walls and vertical looks', () => {
    for (const [i, y] of [0, 3.6].entries()) {
      const p: Vec3 = [-80.4, y, 143.4];
      expect(mirrorForPlayer(p, Math.PI / 2)?.id).toBe(MIRRORS[i].id);
      expect(mirrorForPlayer(p, -Math.PI / 2)).toBeUndefined();
      expect(mirrorForPlayer(p, 0)).toBeUndefined();
      expect(mirrorForPlayer(p, Math.PI / 2, 1.45)).toBeUndefined();
      expect(mirrorForPlayer(p, Math.PI / 2, -1.45)).toBeUndefined();
      expect(mirrorForPlayer([-76.2, y, 143.4], Math.PI / 2)).toBeUndefined();
      expect(mirrorForPlayer([-83, y, 143.4], -Math.PI / 2)).toBeUndefined();
      expect(inMirrorHall(p)).toBe(true);
      expect(inMirrorHall([-76.2, y, 143.4])).toBe(true);
      expect(inMirrorHall([-80.4, y, 140])).toBe(false);
    }
    expect(mirrorForPlayer([-80.4, 1.8, 143.4], Math.PI / 2)).toBeUndefined();
    expect(mirrorForPlayer([-80.4, 7.2, 143.4], Math.PI / 2)).toBeUndefined();
    expect(inMirrorHall([-80.4, 7.2, 143.4])).toBe(false);
  });
});

describe('real secret-wall collision', () => {
  it('blocks each closed wall and attached cabinet, then cuts a walkable opening on only its own floor', () => {
    for (const door of MIRROR_DOORS) {
      const y = door.wall[1], target: [number, number] = [-76.2, door.wall[2]];
      expect(walk(l7World(), { x: -79.2, y, z: door.wall[2] }, [target], L7_CAPSULE)).toBeNull();
      expect(walk(l7World([door.id]), { x: -79.2, y, z: door.wall[2] }, [target], L7_CAPSULE)?.[0]).toBeCloseTo(y);
      expect(overlaps(l7World([door.id]), body([door.wall[0], y, door.wall[2]]), L7_CAPSULE)).toBe(false);
      const other = MIRROR_DOORS.find((d) => d.id !== door.id)!;
      expect(walk(l7World([other.id]), { x: -79.2, y, z: door.wall[2] }, [target], L7_CAPSULE)).toBeNull();
      const boxes = l7Colliders([door.id]);
      expect(boxes.some((b) => b.minX <= -77.65 && b.maxX >= -77.65 && b.minZ <= door.wall[2] && b.maxZ >= door.wall[2] &&
        Math.abs(b.minY - (y + door.height)) < 1e-8 && b.maxY > y + door.height)).toBe(true); // lintel survives
      expect(overlaps(l7World([door.id]), body([-77.65, y, door.wall[2] + door.width / 2 + 0.2]), L7_CAPSULE)).toBe(true);
    }
  });

  it('keeps the existing LAB stairs reachable from 1F and returns onto the 2F hall exit', () => {
    const way: [number, number][] = [
      [-76.2, 143.4], [-76.2, 144.13], [-74, 144.13], [-74, 142.7],
      [-68.5, 142.7], [-68.5, 145.4], [-74, 145.4], [-74, 144.13], [-76.2, 144.13], [-76.2, 143.4],
    ];
    const ys = walk(l7World([1, 2]), { x: -80.05, y: 0, z: 143.4 }, way, L7_CAPSULE);
    expect(ys).not.toBeNull();
    expect(ys?.at(-1)).toBeCloseTo(3.6);
    expect(walk(l7World([1, 2]), { x: -76.2, y: 3.6, z: 143.4 }, [[-79.2, 143.4]], L7_CAPSULE)?.[0]).toBeCloseTo(3.6);
  });

  it('lets teammates return down the same stairs to rescue someone on 1F', () => {
    const way: [number, number][] = [
      [-76.2, 144.13], [-74, 144.13], [-74, 145.4], [-68.5, 145.4],
      [-68.5, 142.7], [-74, 142.7], [-74, 144.13], [-76.2, 144.13], [-80.05, 143.4],
    ];
    const ys = walk(l7World([1, 2]), { x: L7_EXIT.x, y: L7_EXIT.y, z: L7_EXIT.z }, way, L7_CAPSULE);
    expect(ys).toHaveLength(way.length);
    expect(ys?.at(-1)).toBeCloseTo(0);
  });

  it('blocks the upward 2F flight without blocking the returning 1F flight', () => {
    const world = l7World([1, 2]);
    expect(walk(world, { x: -74, y: 3.6, z: 142.7 }, [[-68.5, 142.7]], L7_CAPSULE)).toBeNull();
    // Side approaches from the return flight must not bypass the grate onto a higher tread.
    for (const x of [-72.9, -72.74, -72.6]) {
      expect(walk(world, { x: -74, y: 3.6, z: 145.4 }, [[x, 145.4], [x, 144.13], [x, 142.7]], L7_CAPSULE)).toBeNull();
    }
  });

  it('reaches the specimen mirror through its existing south door before its secret wall opens', () => {
    const way: [number, number][] = [[-76.2, 140], [-81.25, 140], [-81.25, 141.8], [-80.4, 142], [-80.4, 143.4]];
    const ys = walk(l7World([1]), { x: L7_EXIT.x, y: L7_EXIT.y, z: L7_EXIT.z }, way, L7_CAPSULE);
    expect(ys).toHaveLength(way.length);
    for (const y of ys!) expect(y).toBeCloseTo(3.6);
  });

  it('does not mutate source campus boxes or share mutable collision boxes between worlds', () => {
    const before = JSON.stringify(campusData.colliders);
    const closed = l7Colliders(), opened = l7Colliders([1, 2]);
    expect(opened).not.toEqual(closed);
    opened[0].minX = 123;
    expect(l7Colliders([1, 2])[0].minX).not.toBe(123);
    expect(JSON.stringify(campusData.colliders)).toBe(before);
  });
});
