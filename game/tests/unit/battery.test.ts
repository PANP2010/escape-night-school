import { describe, expect, it } from 'vitest';
import { RoomManager, type Conn } from '../../server/room.ts';
import { BATTERY_RUN_MUL, BATTERY_S, TPS } from '../../shared/constants.ts';
import { F_LIGHT, F_RUN, parseClientMsg, type ServerMsg } from '../../shared/protocol.ts';
import { mulberry32 } from '../../shared/rng.ts';

function setup() {
  const room = new RoomManager(mulberry32(3)).create();
  const got: ServerMsg[] = [];
  const c: Conn = { id: 1, name: 'p1', send: (m) => got.push(m), sendRaw: (s) => got.push(JSON.parse(s)) };
  room.add(c, 0);
  const pl = room.players.get(1)!;
  const input = (f: number, now: number) => room.handle(c, { t: 'input', seq: 1, p: pl.p, yaw: 0, pitch: 0, f }, now);
  return { room, c, got, pl, input };
}

describe('flashlight battery (server-authoritative)', () => {
  it('starts full and drains only with the light on', () => {
    const { room, pl, input } = setup();
    expect(pl.battery).toBe(1);
    input(0, 100);
    for (let i = 0; i < TPS; i++) room.step();
    expect(pl.battery).toBe(1);
    input(F_LIGHT, 200);
    for (let i = 0; i < TPS * 9; i++) room.step();
    expect(pl.battery).toBeCloseTo(1 - 9 / BATTERY_S, 3);
  });

  it('drains faster while running', () => {
    const { room, pl, input } = setup();
    input(F_LIGHT | F_RUN, 100);
    for (let i = 0; i < TPS * 9; i++) room.step();
    expect(pl.battery).toBeCloseTo(1 - (9 * BATTERY_RUN_MUL) / BATTERY_S, 3);
  });

  it('light goes out at 0 and F_LIGHT is ignored until recharged', () => {
    const { room, pl, input } = setup();
    pl.battery = 0.001;
    input(F_LIGHT, 100);
    for (let i = 0; i < 5; i++) room.step();
    expect(pl.battery).toBe(0);
    expect(pl.f & F_LIGHT).toBe(0);
    input(F_LIGHT, 200);
    expect(pl.f & F_LIGHT).toBe(0);
    const snap = (() => { room.step(); return pl; })();
    expect(snap.battery).toBe(0);
  });

  it('use battery: spends one from the bag and refills; no-op with an empty bag or a full light', () => {
    const { room, c, got, pl } = setup();
    pl.battery = 0.1;
    room.handle(c, { t: 'use', item: 'battery' }, 1);
    expect(pl.battery).toBe(0.1); // empty bag
    room.bag = { battery: 2 };
    room.handle(c, { t: 'use', item: 'battery' }, 2);
    expect(pl.battery).toBe(1);
    expect(room.bag.battery).toBe(1);
    expect(got.at(-1)).toMatchObject({ t: 'bag', bag: { battery: 1 } });
    room.handle(c, { t: 'use', item: 'battery' }, 3);
    expect(room.bag.battery).toBe(1); // already full: not wasted
  });

  it('snapshots carry the charge; the message parses', () => {
    const { room, got } = setup();
    room.step();
    const snap = got.filter((m) => m.t === 'snap').at(-1) as Extract<ServerMsg, { t: 'snap' }> | undefined;
    expect(snap?.players[0].bat).toBe(1);
    expect(parseClientMsg('{"t":"use","item":"battery"}')).toEqual({ t: 'use', item: 'battery' });
    expect(parseClientMsg('{"t":"use","item":"x"}')).toBeNull();
  });
});
