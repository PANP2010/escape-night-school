import { describe, expect, it } from 'vitest';
import { CollisionWorld, box } from '../../shared/campus/collision.ts';
import { lineOfSight } from '../../shared/campus/nav.ts';
import { effectiveRadius, hears, moveKind, moveNoise, NOISE_RADIUS, NoiseBus, type NoiseEvent } from '../../shared/noise.ts';
import { F_CROUCH, F_RUN } from '../../shared/protocol.ts';
import { DOOR_NOISE } from '../../shared/doors.ts';
import { RoomManager, type Conn } from '../../server/room.ts';
import { mulberry32 } from '../../shared/rng.ts';

describe('noise radius per action', () => {
  it('matches the design table', () => {
    expect(NOISE_RADIUS).toEqual({ crouch: 0, walk: 4, run: 12, door: 8, item: 15, basketball: 10 });
    expect(DOOR_NOISE).toBe(NOISE_RADIUS.door);
  });
  it('maps input flags to footstep radius', () => {
    expect(moveNoise(0, true)).toBe(4);
    expect(moveNoise(F_RUN, true)).toBe(12);
    expect(moveNoise(F_CROUCH, true)).toBe(0);
    expect(moveNoise(F_CROUCH | F_RUN, true)).toBe(0);
    expect(moveNoise(F_RUN, false)).toBe(0);
    expect(moveKind(F_RUN, true)).toBe('run');
    expect(moveKind(0, true)).toBe('walk');
    expect(moveKind(F_CROUCH, true)).toBe('crouch');
  });
});

describe('wall attenuation', () => {
  const ev = (kind: keyof typeof NOISE_RADIUS): NoiseEvent => ({ kind, x: 0, y: 0, z: 0, r: NOISE_RADIUS[kind] });
  it('halves the radius through a wall', () => {
    expect(effectiveRadius(12, false)).toBe(12);
    expect(effectiveRadius(12, true)).toBe(6);
  });
  it('hears within range without walls, not beyond', () => {
    expect(hears(ev('run'), 11.9, 0, 0)).toBe(true);
    expect(hears(ev('run'), 12.1, 0, 0)).toBe(false);
    expect(hears(ev('walk'), 4.1, 0, 0)).toBe(false);
    expect(hears(ev('item'), 0, 0, 14.9)).toBe(true);
  });
  it('crouching is never heard, even adjacent', () => {
    expect(hears(ev('crouch'), 0.1, 0, 0)).toBe(false);
  });
  it('through a wall: 10 m run is heard in the open but not behind a wall', () => {
    const w = new CollisionWorld([box(5, 0, 0.3, 20, 3)]);
    const blocked = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) =>
      !lineOfSight(w, { x: ax, y: ay, z: az }, { x: bx, y: by, z: bz });
    const run = ev('run');
    expect(hears(run, -7, 0, 0, blocked)).toBe(true); // same side
    expect(hears(run, 8, 0, 0, blocked)).toBe(false); // 8 > 12 × 0.5
    expect(hears(run, 5.9, 0, 0, blocked)).toBe(true);
    expect(hears(run, 6.1, 0, 0, blocked)).toBe(false);
    expect(hears(ev('door'), 4.5, 0, 0, blocked)).toBe(true); // wall at x=5 not yet crossed
    expect(hears(ev('door'), 6, 0, 0, blocked)).toBe(false); // crossed: 6 > 8 × 0.5
  });
});

describe('NoiseBus', () => {
  it('batches events per flush and drops silent ones', () => {
    const bus = new NoiseBus();
    const got: [number, number][] = [];
    const off = bus.subscribe((e, t) => got.push([e.length, t]));
    bus.emit({ kind: 'walk', x: 0, y: 0, z: 0, r: 4 });
    bus.emit({ kind: 'crouch', x: 0, y: 0, z: 0, r: 0 });
    bus.emit({ kind: 'run', x: 0, y: 0, z: 0, r: 12 });
    bus.flush(7);
    bus.flush(8); // quiet tick: no call
    expect(got).toEqual([[2, 7]]);
    off();
    bus.emit({ kind: 'walk', x: 0, y: 0, z: 0, r: 4 });
    bus.flush(9);
    expect(got.length).toBe(1);
  });
});

describe('room noise collection', () => {
  function setup() {
    const c: Conn = { id: 1, name: 'a', send: () => {}, sendRaw: () => {} };
    const room = new RoomManager(mulberry32(3)).create();
    room.add(c, 0);
    const batches: NoiseEvent[][] = [];
    room.noise.subscribe((e) => batches.push([...e]));
    const pl = room.players.get(1)!;
    return { room, pl, batches };
  }
  const input = (room: ReturnType<typeof setup>['room'], pl: ReturnType<typeof setup>['pl'], f: number, now: number) =>
    room.applyInput(pl, { t: 'input', seq: 1, p: [pl.p[0] + 0.5, 0, pl.p[2]], yaw: 0, pitch: 0, f }, now);

  it('walk 4 / run 12 / crouch silent, delivered on the next step', () => {
    const { room, pl, batches } = setup();
    pl.lastInput = 1000;
    input(room, pl, 0, 1200);
    input(room, pl, F_RUN, 1400);
    input(room, pl, F_CROUCH, 1600);
    expect(batches.length).toBe(0);
    room.step();
    expect(batches.length).toBe(1);
    expect(batches[0].map((e) => [e.kind, e.r])).toEqual([['walk', 4], ['run', 12]]);
    room.step();
    expect(batches.length).toBe(1);
  });

  it('a door toggle emits an 8 m door event with its source', () => {
    const { room, pl, batches } = setup();
    const d = room.doors[0];
    pl.p = [d.x - (d.alongX ? 0 : 1.5), 0, d.z - (d.alongX ? 1.5 : 0)];
    expect(room.toggleDoor(pl, 0)).toBe(true);
    room.step();
    expect(batches[0]).toEqual([{ kind: 'door', x: d.x, y: 0, z: d.z, r: 8, src: 1 }]);
  });

  it('noiseBlocked is muffled by a closed door, not an open one', () => {
    const { room, pl } = setup();
    const d = room.doors[0], o = d.alongX ? [0, 1.5] : [1.5, 0];
    const across = () => room.noiseBlocked(d.x - o[0], 1, d.z - o[1], d.x + o[0], 1, d.z + o[1]);
    expect(across()).toBe(true);
    pl.p = [d.x - o[0], 0, d.z - o[1]];
    expect(room.toggleDoor(pl, 0)).toBe(true);
    expect(across()).toBe(false);
  });
});
