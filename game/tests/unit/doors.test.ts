import { describe, expect, it } from 'vitest';
import { doorTargetIn, DOOR_NOISE } from '../../shared/doors.ts';
import { CAMPUS } from '../../client/src/campus/world/campus.ts';
import { campusDoors } from '../../client/src/campus/world/doorway.ts';
import { parseClientMsg, type ServerMsg } from '../../shared/protocol.ts';
import { RoomManager, type Conn } from '../../server/room.ts';
import { mulberry32 } from '../../shared/rng.ts';

describe('doors', () => {
  const defs = campusDoors(CAMPUS);

  it('doorTargetIn needs the door in front, within reach and on the same storey', () => {
    const d = defs[0], dir = d.alongX ? { x: 0, z: 1 } : { x: 1, z: 0 };
    const [sx, sz] = [d.x - dir.x * 1.5, d.z - dir.z * 1.5];
    const yaw = Math.atan2(-dir.x, -dir.z); // forward = (-sin, -cos) = dir
    expect(doorTargetIn(defs, sx, sz, yaw)).toBe(d.id);
    expect(doorTargetIn(defs, sx, sz, yaw + Math.PI)).not.toBe(d.id);
    expect(doorTargetIn(defs, sx - dir.x * 10, sz - dir.z * 10, yaw)).not.toBe(d.id);
    expect(doorTargetIn(defs, sx, sz, yaw, 2.6, 7.2)).not.toBe(d.id);
  });

  it('parses door messages strictly', () => {
    expect(parseClientMsg('{"t":"door","id":3}')).toEqual({ t: 'door', id: 3 });
    expect(parseClientMsg('{"t":"door","id":-1}')).toBeNull();
    expect(parseClientMsg('{"t":"door","id":"x"}')).toBeNull();
  });
});

describe('room door state machine', () => {
  function setup() {
    const got: ServerMsg[] = [];
    const c: Conn = { id: 1, name: 'a', send: (m) => got.push(m), sendRaw: (s) => got.push(JSON.parse(s)) };
    const room = new RoomManager(mulberry32(3)).create();
    room.add(c, 0);
    const noises: number[][] = [];
    room.noiseListeners.push((x, z, r) => noises.push([x, z, r]));
    return { room, c, got, noises, pl: room.players.get(1)! };
  }
  const near = (room: ReturnType<typeof setup>['room'], pl: ReturnType<typeof setup>['pl'], id: number) => {
    const d = room.doors[id];
    const along = d.alongX ? [0, 1.5] : [1.5, 0];
    pl.p = [d.x - along[0], 0, d.z - along[1]];
  };

  it('sends the full table on join, then only changes in snaps', () => {
    const { room, c, got, pl } = setup();
    const full = got.find((m) => m.t === 'doors');
    expect(full && full.t === 'doors' && full.doors.length === room.doors.length && full.doors.every((d) => !d.open)).toBe(true);
    near(room, pl, 2);
    room.handle(c, { t: 'door', id: 2 }, 10);
    expect(got.filter(m => m.t === 'doors').at(-1)).toEqual({ t: 'doors', doors: [{ id: 2, open: true, locked: false }] });
    room.step();
    const snap = got.filter((m) => m.t === 'snap').at(-1)!;
    expect(snap.t === 'snap' && snap.doors).toEqual([{ id: 2, open: true, locked: false }]);
    room.step();
    expect((got.filter((m) => m.t === 'snap').at(-1) as { doors?: unknown }).doors).toBeUndefined();
  });

  it('toggle makes 8 m noise, respects reach, lock and bad ids', () => {
    const { room, c, got, noises, pl } = setup();
    const d = room.doors[1];
    pl.p = [d.x - 20, 0, d.z - 20];
    room.handle(c, { t: 'door', id: 1 }, 10);
    expect(room.doorOpen[1]).toBe(false);
    near(room, pl, 1);
    room.handle(c, { t: 'door', id: 9999 }, 10);
    room.doorLocked[1] = true;
    room.handle(c, { t: 'door', id: 1 }, 10);
    expect(room.doorOpen[1]).toBe(false);
    expect(noises).toEqual([]);
    expect(got.at(-1)).toEqual({ t: 'doors', doors: [{ id: 1, open: false, locked: true }] });
    room.doorLocked[1] = false;
    room.handle(c, { t: 'door', id: 1 }, 10);
    expect(room.doorOpen[1]).toBe(true);
    expect(noises).toEqual([[d.x, d.z, DOOR_NOISE]]);
    pl.p = [d.x, 0, d.z]; // standing in the doorway: cannot close
    room.handle(c, { t: 'door', id: 1 }, 20);
    expect(room.doorOpen[1]).toBe(true);
    near(room, pl, 1);
    room.handle(c, { t: 'door', id: 1 }, 30);
    expect(room.doorOpen[1]).toBe(false);
  });

  it('server rejects walking through a closed door but accepts it once open', () => {
    const { room, c, got, pl } = setup();
    const d = room.doors[0];
    const dir = d.alongX ? [0, 1] : [1, 0];
    const at = (t: number): [number, number, number] => [d.x + dir[0] * t, 0, d.z + dir[1] * t];
    pl.p = at(-0.6);
    room.handle(c, { t: 'input', seq: 1, p: at(0), yaw: 0, pitch: 0, f: 0 }, 100);
    expect(got.at(-1)).toEqual({ t: 'correct', p: at(-0.6), c: 1, ack: 1 });
    room.handle(c, { t: 'door', id: 0 }, 110);
    room.handle(c, { t: 'input', seq: 2, p: at(0), yaw: 0, pitch: 0, f: 0 }, 200);
    expect(pl.p).toEqual(at(0));
  });
});
