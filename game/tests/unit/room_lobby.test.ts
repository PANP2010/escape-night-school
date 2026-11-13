import { describe, expect, it } from 'vitest';
import { ST_OK, ST_SPECTATE, type ServerMsg } from '../../shared/protocol.ts';
import { LEVEL_FADE_S, PING_GAP_MS, RoomManager, type Conn } from '../../server/room.ts';
import { TICK_MS } from '../../shared/constants.ts';
import { mulberry32 } from '../../shared/rng.ts';

const setup = () => {
  const room = new RoomManager(mulberry32(5)).create(true);
  const got: ServerMsg[] = [];
  const mk = (id: number): Conn => ({ id, name: `p${id}`, send: (m) => got.push(m), sendRaw: (s) => got.push(JSON.parse(s)) });
  return { room, got, mk };
};
const rooms = (got: ServerMsg[]) => got.filter((m): m is Extract<ServerMsg, { t: 'room' }> => m.t === 'room');

describe('waiting lobby', () => {
  it('holds the game until the host starts: no snaps, no level state, only the host may start', () => {
    const { room, got, mk } = setup();
    const a = mk(1), b = mk(2);
    room.add(a, 0); room.add(b, 0);
    expect(rooms(got).at(-1)).toMatchObject({ started: false, host: 1 });
    expect(rooms(got).at(-1)!.players).toHaveLength(2);
    expect(got.some((m) => m.t === 'doors' || m.t === 'items')).toBe(false);
    room.handle(b, { t: 'start' }, 10); // not the host
    expect(room.started).toBe(false);
    room.step(); room.step();
    expect(got.some((m) => m.t === 'snap')).toBe(false);
    room.handle(a, { t: 'start' }, 20);
    expect(room.started).toBe(true);
    expect(rooms(got).at(-1)).toMatchObject({ started: true });
    expect(got.some((m) => m.t === 'doors')).toBe(true);
    room.step();
    expect(got.some((m) => m.t === 'snap')).toBe(true);
    expect([...room.players.values()].map((p) => p.st)).toEqual([ST_OK, ST_OK]);
  });

  it('a player joining a running level observes until the next level', () => {
    const { room, got, mk } = setup();
    room.add(mk(1), 0);
    room.handle(room.players.get(1)!.conn, { t: 'start' }, 1);
    const intro = got.findLast(m => m.t === 'event' && m.kind === 'intro');
    if (intro?.t !== 'event' || intro.kind !== 'intro') throw new Error('Missing shared opening');
    room.handle(room.players.get(1)!.conn, { t: 'intro-skip', id: intro.id }, 1);
    room.handle(room.players.get(1)!.conn, { t: 'ready', incarnation: room.incarnation }, 1);
    room.add(mk(2), 2);
    expect(room.players.get(2)!.st).toBe(ST_SPECTATE);
    expect(room.players.get(1)!.st).toBe(ST_OK);

    // The observer stays at spawn and must not block the survivor's exit condition.
    const host = room.players.get(1)!, observer = room.players.get(2)!;
    room.bag = { stair_key: 1 };
    host.p = [room.level.exit.x, room.level.exit.y, room.level.exit.z];
    room.step();
    expect(got.filter((m) => m.t === 'fade').at(-1)).toMatchObject({ restart: false });
    for (let i = 0; i < Math.ceil(LEVEL_FADE_S * 1000 / TICK_MS) - 1; i++) room.step();
    expect(room.levelIndex).toBe(0);
    expect(observer.st).toBe(ST_SPECTATE);
    room.step();
    expect(room.levelIndex).toBe(1);
    expect(observer.st).toBe(ST_OK);
    expect(observer.p).not.toEqual(host.p);
    expect(rooms(got).at(-1)).toMatchObject({ started: true, level: 1 });
  });

  it('host leaving hands the lobby to the next member', () => {
    const { room, got, mk } = setup();
    const a = mk(1), b = mk(2);
    room.add(a, 0); room.add(b, 0);
    room.remove(a, 1);
    expect(rooms(got).at(-1)).toMatchObject({ host: 2, started: false });
  });

  it('a newcomer takes the spawn a leaver freed, not a teammate\'s', () => {
    const { room, mk } = setup();
    const c = [1, 2, 3].map(mk);
    c.forEach((x) => room.add(x, 0));
    const at = (id: number) => room.players.get(id)!.p.join(',');
    const freed = at(2);
    expect(new Set([at(1), at(2), at(3)]).size).toBe(3);
    room.remove(c[1], 1);
    room.add(mk(4), 2);
    expect(at(4)).toBe(freed);
    room.handle(c[0], { t: 'start' }, 3); // the level load keeps everyone on their own spawn
    expect(new Set([at(1), at(3), at(4)]).size).toBe(3);
    expect(at(4)).toBe(freed);
  });
});

describe('location markers', () => {
  it('relays a ping to everyone with the sender id, at most one per PING_GAP_MS per player', () => {
    const { room, got, mk } = setup();
    const a = mk(1), b = mk(2);
    room.add(a, 0); room.add(b, 0);
    room.handle(a, { t: 'start' }, 0);
    const pings = () => got.filter((m) => m.t === 'ping');
    room.handle(a, { t: 'ping', p: [1, 0, 2] }, 5000);
    expect(pings()).toEqual([{ t: 'ping', from: 1, p: [1, 0, 2] }, { t: 'ping', from: 1, p: [1, 0, 2] }]); // both conns got it
    room.handle(a, { t: 'ping', p: [3, 0, 3] }, 5000 + PING_GAP_MS - 1); // spam: dropped
    expect(pings()).toHaveLength(2);
    room.handle(b, { t: 'ping', p: [4, 0, 4] }, 5001); // the other player has their own budget
    expect(pings()).toHaveLength(4);
    room.handle(a, { t: 'ping', p: [5, 0, 5] }, 5000 + PING_GAP_MS);
    expect(pings()).toHaveLength(6);
  });
});
