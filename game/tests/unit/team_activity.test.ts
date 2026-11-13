import { describe, expect, it } from 'vitest';
import { TICK_MS } from '../../shared/constants.ts';
import { ST_DOWN, ST_OK, ST_SPECTATE, type ServerMsg, type TeamActivityEvent, type WorldItem } from '../../shared/protocol.ts';
import { REVIVE_S, RoomManager, type Conn } from '../../server/room.ts';
import { mulberry32 } from '../../shared/rng.ts';

function setup() {
  const room = new RoomManager(mulberry32(3)).create();
  const connect = (id: number) => {
    const got: ServerMsg[] = [];
    const conn: Conn = { id, name: `p${id}`, send: m => got.push(m), sendRaw: s => got.push(JSON.parse(s)) };
    room.add(conn, 0);
    return { conn, got, pl: room.players.get(id)! };
  };
  const a = connect(1), b = connect(2);
  a.got.length = b.got.length = 0;
  return { room, a, b };
}
const activity = (got: ServerMsg[]): TeamActivityEvent[] => got.filter((m): m is TeamActivityEvent => m.t === 'activity');
const nearDoor = ({ room, a }: ReturnType<typeof setup>) => {
  const door = room.doors.find(d => !room.doorLocked[d.id])!;
  a.pl.p = [door.x - (door.alongX ? 0 : 1.5), door.y0 ?? 0, door.z - (door.alongX ? 1.5 : 0)];
  return door;
};

describe('authoritative team activity', () => {
  it('broadcasts real opening and closing to the team without target ids or positions', () => {
    const fx = setup(), d = nearDoor(fx);
    fx.room.handle(fx.a.conn, { t: 'door', id: d.id }, 0);
    expect(fx.room.doorOpen[d.id]).toBe(true);
    fx.room.handle(fx.a.conn, { t: 'act', kind: 'use', id: d.id }, 50);
    expect(fx.room.doorOpen[d.id]).toBe(false);
    const expected = [{ t: 'activity', from: 1, kind: 'open' }, { t: 'activity', from: 1, kind: 'close' }];
    expect(activity(fx.a.got)).toEqual(expected);
    expect(activity(fx.b.got)).toEqual(expected);
  });

  it('does not report invalid, distant, locked or other-storey door attempts, nor a blocked close', () => {
    const fx = setup(), d = nearDoor(fx), at = [...fx.a.pl.p] as typeof fx.a.pl.p;
    fx.room.handle(fx.a.conn, { t: 'door', id: 999999 }, 0);
    fx.a.pl.p = [d.x + 20, d.y0 ?? 0, d.z];
    fx.room.handle(fx.a.conn, { t: 'door', id: d.id }, 0);
    fx.a.pl.p = [at[0], at[1] + 3.5, at[2]];
    fx.room.handle(fx.a.conn, { t: 'door', id: d.id }, 0);
    fx.a.pl.p = at;
    fx.room.doorLocked[d.id] = true;
    fx.room.handle(fx.a.conn, { t: 'door', id: d.id }, 0);
    expect(fx.room.doorOpen[d.id]).toBe(false);
    expect(activity(fx.a.got)).toEqual([]);
    fx.room.doorLocked[d.id] = false;
    fx.room.handle(fx.a.conn, { t: 'door', id: d.id }, 0);
    fx.a.got.length = 0;
    fx.a.pl.p = [d.x, d.y0 ?? 0, d.z];
    fx.room.handle(fx.a.conn, { t: 'door', id: d.id }, 50);
    expect(fx.room.doorOpen[d.id]).toBe(true);
    expect(activity(fx.a.got)).toEqual([]);
  });

  it.each<WorldItem['kind']>(['drawer_key', 'door_key', 'stair_key', 'battery', 'fuse'])('reports a real %s pickup once, after the item is gone', kind => {
    const { room, a, b } = setup();
    const item: WorldItem = { id: 999, kind, p: [...a.pl.p], ...(kind === 'door_key' ? { door: 1 } : {}) };
    room.items = [item];
    if (kind === 'stair_key') {
      // L1's stair key is now in a locked drawer. An unsuccessful attempt has no team activity.
      room.handle(a.conn, { t: 'act', kind: 'pick', id: item.id }, 0);
      expect(room.items).toEqual([item]);
      expect(activity(a.got)).toEqual([]);
      expect(activity(b.got)).toEqual([]);
      room.bag = { drawer_key: 1 };
    }
    room.handle(a.conn, { t: 'act', kind: 'pick', id: item.id }, 0);
    room.handle(a.conn, { t: 'act', kind: 'pick', id: item.id }, 50);
    expect(room.items).toEqual([]);
    expect(activity(a.got)).toEqual([{ t: 'activity', from: 1, kind: 'pick', item: kind }]);
    expect(activity(b.got)).toEqual(activity(a.got));
  });

  it('does not report missing, distant or other-storey pickups, or interactions while down / out / hidden', () => {
    const { room, a } = setup(), at = [...a.pl.p] as typeof a.pl.p;
    room.items = [{ id: 999, kind: 'battery', p: [at[0] + 10, at[1], at[2]] }];
    room.handle(a.conn, { t: 'act', kind: 'pick', id: 999 }, 0);
    room.handle(a.conn, { t: 'act', kind: 'pick', id: 998 }, 0);
    room.items[0].p = [at[0], at[1] + 3.5, at[2]];
    room.handle(a.conn, { t: 'act', kind: 'pick', id: 999 }, 0);
    room.items[0].p = at;
    for (const st of [ST_DOWN, ST_SPECTATE]) {
      a.pl.st = st;
      room.handle(a.conn, { t: 'act', kind: 'pick', id: 999 }, 0);
    }
    a.pl.st = ST_OK;
    a.pl.hide = { id: 0, out: at, crouch: false };
    room.handle(a.conn, { t: 'act', kind: 'pick', id: 999 }, 0);
    expect(room.items).toHaveLength(1);
    expect(activity(a.got)).toEqual([]);
  });

  it('reports a revive only after the full successful hold, exactly once for the rescuer', () => {
    const { room, a, b } = setup();
    b.pl.st = ST_DOWN; b.pl.heldUntil = 9999;
    b.pl.p = [a.pl.p[0] + 1, a.pl.p[1], a.pl.p[2]];
    const steps = Math.ceil(REVIVE_S * 1000 / TICK_MS);
    for (let i = 0; i < steps - 1; i++) { room.handle(a.conn, { t: 'act', kind: 'revive', id: 2 }, i * TICK_MS); room.step(); }
    expect(b.pl.st).toBe(ST_DOWN);
    expect(activity(a.got)).toEqual([]);
    room.handle(a.conn, { t: 'act', kind: 'revive', id: 2 }, steps * TICK_MS); room.step();
    expect(b.pl.st).toBe(ST_OK);
    room.handle(a.conn, { t: 'act', kind: 'revive', id: 2 }, (steps + 1) * TICK_MS); room.step();
    expect(activity(a.got)).toEqual([{ t: 'activity', from: 1, kind: 'revive' }]);
    expect(activity(b.got)).toEqual(activity(a.got));
  });

  it('does not report a revive for an invalid target, out-of-reach hold or interrupted rescue', () => {
    const { room, a, b } = setup();
    room.handle(a.conn, { t: 'act', kind: 'revive', id: 999 }, 0);
    room.handle(a.conn, { t: 'act', kind: 'revive', id: 1 }, 0);
    room.handle(a.conn, { t: 'act', kind: 'revive', id: 2 }, 0); // alive
    b.pl.st = ST_DOWN; b.pl.heldUntil = 9999;
    b.pl.p = [a.pl.p[0] + 10, a.pl.p[1], a.pl.p[2]];
    room.handle(a.conn, { t: 'act', kind: 'revive', id: 2 }, 0);
    expect(a.pl.reviving).toBeUndefined();
    b.pl.p = [a.pl.p[0] + 1, a.pl.p[1], a.pl.p[2]];
    room.handle(a.conn, { t: 'act', kind: 'revive', id: 2 }, 0);
    for (let i = 0; i < 70; i++) room.step(); // no refresh: cannot complete
    expect(a.pl.reviving).toBeUndefined();
    expect(b.pl.st).toBe(ST_DOWN);
    expect(activity(a.got)).toEqual([]);
  });
});
