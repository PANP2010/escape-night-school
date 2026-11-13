import { afterEach, describe, expect, it } from 'vitest';
import { LEVEL_FADE_S, RoomManager, TRIP, type Conn, type Room } from '../../server/room.ts';
import { TICK_MS } from '../../shared/constants.ts';
import { NavGraph } from '../../shared/campus/nav.ts';
import { parseClientMsg, ST_OK, ST_SPECTATE, type ServerMsg } from '../../shared/protocol.ts';
import { mulberry32 } from '../../shared/rng.ts';

type Trip = Extract<ServerMsg, { t: 'trip' }>;
const trips = (got: ServerMsg[]) => got.filter((m): m is Trip => m.t === 'trip');
const cancel: Trip = { t: 'trip', at: [0, 0], omen: 0, off: 0 };
const ticks = (seconds: number) => Math.ceil(seconds * 1000 / TICK_MS);
const step = (room: Room, count: number) => { for (let i = 0; i < count; i++) room.step(); };
const env = process.env.NODE_ENV;
afterEach(() => { process.env.NODE_ENV = env; });

function setup(nav?: NavGraph) {
  process.env.NODE_ENV = 'test';
  const room = new RoomManager(mulberry32(3), () => nav).create();
  const join = (id: number) => {
    const got: ServerMsg[] = [];
    const conn: Conn = { id, name: `p${id}`, send: m => got.push(m), sendRaw: s => got.push(JSON.parse(s)) };
    room.add(conn, room.tick * TICK_MS);
    return { conn, got, player: room.players.get(id)! };
  };
  const a = join(1), b = join(2);
  a.got.length = b.got.length = 0;
  const power = (s?: number) => {
    const message = parseClientMsg(JSON.stringify({ t: 'debug', op: 'power', ...(s === undefined ? {} : { s }) }));
    expect(message).not.toBeNull();
    room.handle(a.conn, message!, room.tick * TICK_MS);
  };
  return { room, a, b, join, power };
}

describe('debug power wire parsing', () => {
  it('keeps the default duration, finite values and the zero cancellation command', () => {
    expect(parseClientMsg('{"t":"debug","op":"power"}')).toEqual({ t: 'debug', op: 'power' });
    for (const s of [0, 0.25, 8, 30, -1]) {
      expect(parseClientMsg(JSON.stringify({ t: 'debug', op: 'power', s }))).toEqual({ t: 'debug', op: 'power', s });
    }
  });

  it('rejects invalid and non-finite durations before the room handles them', () => {
    for (const s of ['8', null, true, [], {}]) {
      expect(parseClientMsg(JSON.stringify({ t: 'debug', op: 'power', s }))).toBeNull();
    }
    expect(parseClientMsg('{"t":"debug","op":"power","s":1e400}')).toBeNull();
    expect(parseClientMsg('{"t":"debug","op":"power","s":NaN}')).toBeNull();
  });
});

describe('room trip lifecycle', () => {
  it('broadcasts one origin and bounded duration to every current peer', () => {
    const { a, b, power } = setup();
    a.player.p = [-45.14, 0, 75.26];
    for (const [s, off] of [[undefined, 8], [0.1, 0.5], [-1, 0.5], [100, 30]] as const) {
      power(s);
      expect(trips(a.got).at(-1)).toEqual({ t: 'trip', at: [-45.1, 75.3], omen: TRIP.omen, off });
      expect(trips(b.got)).toEqual(trips(a.got));
    }
    expect(trips(a.got)).toHaveLength(4);
  });

  it('sends a late joiner only the remaining omen or dark duration without rebroadcasting to existing peers', () => {
    const { room, a, b, join, power } = setup();
    power(8);
    step(room, ticks(0.6));
    const c = join(3);
    expect(trips(c.got)).toEqual([{ t: 'trip', at: trips(a.got)[0].at, omen: 1, off: 8 }]);
    expect(c.got.findIndex(m => m.t === 'room')).toBeLessThan(c.got.findIndex(m => m.t === 'trip'));
    step(room, ticks(2));
    const d = join(4);
    expect(trips(d.got)).toEqual([{ t: 'trip', at: trips(a.got)[0].at, omen: 0, off: 7 }]);
    expect(trips(a.got)).toHaveLength(1);
    expect(trips(b.got)).toHaveLength(1);
  });

  it('cancels during both omen and darkness and does not replay a cancelled trip to a late joiner', () => {
    for (const elapsed of [0.3, 2]) {
      const { room, a, b, join, power } = setup();
      power(8);
      step(room, ticks(elapsed));
      power(0);
      expect(trips(a.got)).toHaveLength(2);
      expect(trips(a.got).at(-1)).toEqual(cancel);
      expect(trips(b.got)).toEqual(trips(a.got));
      const c = join(3);
      expect(trips(c.got)).toEqual([]);
      step(room, ticks(1));
      expect(trips(a.got)).toHaveLength(2);
    }
  });

  it('consumes a pending chase edge and preserves later cooldowns when cancelled', () => {
    const nav = new NavGraph();
    nav.chain([{ x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }]);
    const { room, a, power } = setup(nav);
    const r = room as unknown as { warden: { step: () => void; state: string }; tripCool: number; tripNext: number };
    room.handle(a.conn, { t: 'debug', op: 'warden', d: 8 }, 0);
    r.warden.step = () => {}; // keep the deliberately summoned chase stable for this edge test
    expect(r.warden.state).toBe('chase');
    r.tripNext = 0;
    power(0);
    step(room, 1);
    expect(trips(a.got)).toEqual([cancel]);
    expect(r.tripCool).toBeGreaterThanOrEqual(ticks(TRIP.chaseCool));
    expect(r.tripNext).toBeGreaterThanOrEqual(ticks(TRIP.chaseCool));
    power(30);
    const cool = r.tripCool, next = r.tripNext;
    power(0);
    expect(r.tripCool).toBe(cool);
    expect(r.tripNext).toBe(next);
  });

  it('retires a completed trip and never gives late joiners an artificial last fraction of darkness', () => {
    const { room, a, join, power } = setup();
    power(0.5);
    step(room, ticks(TRIP.omen + 0.5) - 1);
    const c = join(3);
    expect(trips(c.got)[0].off).toBeCloseTo(TICK_MS / 1000);
    expect(trips(c.got)[0].off).toBeLessThan(0.1);
    step(room, 1);
    const d = join(4);
    expect(trips(d.got)).toEqual([]);
    expect(trips(a.got)).toHaveLength(1); // clients finish the normal event on their own
  });

  it('does not revive an expired trip while the level simulation is paused for a wipe fade', () => {
    const { room, a, b, join, power } = setup();
    power(0.5);
    a.player.st = b.player.st = ST_SPECTATE;
    step(room, ticks(2.2));
    expect(a.got.some(m => m.t === 'fade')).toBe(true);
    const c = join(3);
    expect(c.got.some(m => m.t === 'fade')).toBe(true);
    expect(trips(c.got)).toEqual([]);
  });

  it('broadcasts cancellation after the same-seed wipe reload and starts the new level with no trip', () => {
    const { room, a, b, join, power } = setup();
    const seed = room.seed;
    power(30);
    a.player.st = b.player.st = ST_SPECTATE;
    step(room, ticks(LEVEL_FADE_S) + 1);
    expect(room.seed).toBe(seed);
    expect(room.levelIndex).toBe(0);
    expect(a.player.st).toBe(ST_OK);
    expect(b.player.st).toBe(ST_OK);
    expect(trips(a.got).at(-1)).toEqual(cancel);
    expect(trips(b.got)).toEqual(trips(a.got));
    const roomIndex = a.got.findIndex(m => m.t === 'room');
    expect(a.got.slice(0, roomIndex).some(m => m.t === 'correct' && m.forced)).toBe(true);
    expect(a.got.findIndex(m => m.t === 'trip' && m.off === 0)).toBeGreaterThan(roomIndex);
    expect(trips(join(3).got)).toEqual([]);
  });

  it('keeps power commands inert and counts them as bad messages in production', () => {
    const { room, a, b, power } = setup();
    process.env.NODE_ENV = 'production';
    power(8);
    power(0);
    expect(room.badMsgs).toBe(2);
    expect(trips(a.got)).toEqual([]);
    expect(trips(b.got)).toEqual([]);
  });
});
