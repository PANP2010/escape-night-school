import { describe, expect, it } from 'vitest';
import { F_CROUCH, F_HIDE, F_RUN, type ServerMsg } from '../../shared/protocol.ts';
import { HIDE_REACH, RoomManager, type Conn } from '../../server/room.ts';
import { mulberry32 } from '../../shared/rng.ts';

const setup = () => {
  const room = new RoomManager(mulberry32(3)).create();
  const got: ServerMsg[] = [];
  const mk = (id: number): Conn => ({ id, name: `p${id}`, send: (m) => got.push(m), sendRaw: (s) => got.push(JSON.parse(s)) });
  room.add(mk(1), 0); room.add(mk(2), 0);
  return { room, got, p1: room.players.get(1)!, p2: room.players.get(2)! };
};
type Fx = ReturnType<typeof setup>;
const spot = (room: Fx['room'], i = 0) => room.level.def.hides[i];
const stand = (room: Fx['room'], pl: Fx['p1'], i: number, off = 0.6) => { const h = spot(room, i); pl.p = [h.x + off, 0, h.z]; };
const input = (room: Fx['room'], pl: Fx['p1'], f: number, p = pl.p, now = 1000) =>
  room.handle(pl.conn, { t: 'input', seq: 1, p: [...p] as [number, number, number], yaw: 0, pitch: 0, f }, now);

describe('hiding places (server)', () => {
  it('has lockers and desks in the level data', () => {
    const { room } = setup();
    const kinds = new Set(room.level.def.hides.map((h) => h.kind));
    expect(kinds).toEqual(new Set(['locker', 'desk']));
  });

  it('hide pins the player in the spot with F_HIDE, visible in the snapshot', () => {
    const { room, got, p1 } = setup();
    stand(room, p1, 0);
    room.handle(p1.conn, { t: 'act', kind: 'hide', id: 0 }, 0);
    const h = spot(room, 0);
    expect(p1.p[0]).toBeCloseTo(h.x); expect(p1.p[2]).toBeCloseTo(h.z);
    expect(p1.f & F_HIDE).toBe(F_HIDE);
    got.length = 0;
    room.step();
    for (let i = 0; i < 6 && !got.some((m) => m.t === 'snap'); i++) room.step();
    const snap = got.find((m) => m.t === 'snap');
    expect(snap?.t === 'snap' && snap.players.find((q) => q.id === 1)!.f! & F_HIDE).toBe(F_HIDE);
  });

  it('refuses a hide from beyond HIDE_REACH, a bad id, and a spot someone else is in', () => {
    const { room, p1, p2 } = setup();
    stand(room, p1, 0, HIDE_REACH + 0.3);
    room.handle(p1.conn, { t: 'act', kind: 'hide', id: 0 }, 0);
    expect(p1.hide).toBeUndefined();
    expect(room.hideIn(p1, 99999)).toBe(false);
    stand(room, p1, 0); stand(room, p2, 0);
    expect(room.hideIn(p1, 0)).toBe(true);
    expect(room.hideIn(p2, 0)).toBe(false);
  });

  it('ignores the client claiming F_HIDE and ignores movement while hidden', () => {
    const { room, p1, p2 } = setup();
    stand(room, p2, 5);
    input(room, p2, F_HIDE);
    expect(p2.f & F_HIDE).toBe(0);
    stand(room, p1, 0);
    room.hideIn(p1, 0);
    const at = [...p1.p];
    input(room, p1, F_RUN, [at[0] + 0.1, at[1], at[2]], 1050);
    expect(p1.p).toEqual(at);
    expect(p1.f & F_HIDE).toBe(F_HIDE);
    expect(p1.f & F_RUN).toBe(0);
  });

  it('unhide (E) returns the player to where they stood; unhide while not hidden does nothing', () => {
    const { room, p1 } = setup();
    expect(room.act(p1, 'unhide', 0)).toBe(false);
    stand(room, p1, 0);
    const before = [...p1.p];
    room.handle(p1.conn, { t: 'act', kind: 'hide', id: 0 }, 0);
    room.handle(p1.conn, { t: 'act', kind: 'unhide', id: 0 }, 0);
    expect(p1.p).toEqual(before);
    expect(p1.f & F_HIDE).toBe(0);
    expect(p1.hide).toBeUndefined();
  });

  it('a fresh Crouch press climbs out; a Crouch still held from before does not', () => {
    const { room, p1 } = setup();
    stand(room, p1, 0);
    input(room, p1, F_CROUCH, p1.p, 1000);
    room.hideIn(p1, 0);
    input(room, p1, F_CROUCH, p1.p, 1050); // still held from before entering
    expect(p1.hide).toBeDefined();
    input(room, p1, 0, p1.p, 1100);
    input(room, p1, F_CROUCH, p1.p, 1150);
    expect(p1.hide).toBeUndefined();
    expect(p1.f & F_HIDE).toBe(0);
  });

  it('a hidden player cannot open doors or pick up', () => {
    const { room, p1 } = setup();
    stand(room, p1, 0);
    room.hideIn(p1, 0);
    const open = [...room.doorOpen];
    room.handle(p1.conn, { t: 'door', id: 0 }, 0);
    expect(room.doorOpen).toEqual(open);
  });
});
