import { describe, expect, it } from 'vitest';
import { NavGraph } from '../../shared/campus/nav.ts';
import { TICK_MS } from '../../shared/constants.ts';
import { mulberry32 } from '../../shared/rng.ts';
import { CAUGHT_HOLD_S, RoomManager, type Conn } from '../../server/room.ts';
import type { ServerMsg } from '../../shared/protocol.ts';

/** A 10 m corridor with a 5 m side branch, y rising 1 m along the corridor. */
function tee() {
  const g = new NavGraph();
  g.chain([{ x: 0, y: 0, z: 0 }, { x: 5, y: 0.5, z: 0 }, { x: 10, y: 1, z: 0 }]);
  g.chain([{ x: 5, y: 0.5, z: 0 }, { x: 5, y: 0.5, z: 5 }]);
  return g;
}

describe('Room mobs', () => {
  const join = (nav?: NavGraph) => {
    const room = new RoomManager(mulberry32(3), () => nav).create();
    const got: ServerMsg[] = [];
    const c: Conn = { id: 1, name: 'p1', send: (m) => got.push(m), sendRaw: (s) => got.push(JSON.parse(s)) };
    room.add(c, 0);
    return { room, got };
  };

  it('puts one warden with form and anim into campus snapshots when a nav graph is given', () => {
    const { room, got } = join(tee());
    room.step(); room.step();
    const snaps = got.filter((m): m is Extract<ServerMsg, { t: 'snap' }> => m.t === 'snap');
    expect(snaps[1].mobs).toHaveLength(1);
    expect(snaps[0].mobs[0]).toMatchObject({ kind: 'warden', form: 'normal', anim: 'patrol', st: 0, target: 0 });
    // delta: unchanged kind / form / st / target are left out of later snaps
    expect(snaps[1].mobs[0]).toEqual({ id: 1, p: snaps[1].mobs[0].p, yaw: snaps[1].mobs[0].yaw });
    expect(snaps[1].mobs[0].p).not.toEqual(snaps[0].mobs[0].p);
  });

  it('has no mobs without a nav graph', () => {
    const { room, got } = join();
    room.step();
    expect(got.find((m) => m.t === 'snap')).toMatchObject({ mobs: [] });
  });

  it('does not hand downed players to Warden as targets', () => {
    const { room } = join(tee());
    room.add({ id: 2, name: 'rescuer', send() {}, sendRaw() {} }, 0);
    const seen: number[][] = [];
    const warden = (room as unknown as { warden: { step: (dt: number, ps: { id: number }[]) => void } }).warden;
    warden.step = (_dt, ps) => { seen.push(ps.map((q) => q.id)); };
    room.step();
    room.players.get(1)!.st = 1;
    room.step();
    expect(seen).toEqual([[1, 2], [2]]);
  });

  it('keeps the player at the contact point for the full rescue window while a teammate remains standing', () => {
    const { room, got } = join(tee());
    room.add({ id: 2, name: 'rescuer', send() {}, sendRaw() {} }, 0);
    const pl = room.players.get(1)!;
    const spawn = [...pl.p];
    const warden = (room as unknown as { warden: { p: [number, number, number]; caught: number[]; step: () => void; target: number; state: string } }).warden;
    let hit = true;
    warden.step = function () { this.caught = hit ? [1] : []; this.target = hit ? 1 : 0; this.state = hit ? 'catch' : 'patrol'; };
    pl.p = [spawn[0] + 5, spawn[1], spawn[2]];
    const at = [...pl.p], source = [...warden.p];
    got.length = 0;
    room.step();
    hit = false;
    expect(pl.p).toEqual(at);
    expect(pl.st).toBe(1);
    expect(got).toContainEqual({ t: 'caught', id: 1, seq: 1, tick: room.tick, hold: CAUGHT_HOLD_S, by: 'warden', at, source });
    expect(got.findIndex(m => m.t === 'caught')).toBeLessThan(got.findIndex(m => m.t === 'correct'));
    expect(pl.heldUntil! - room.tick).toBe(CAUGHT_HOLD_S * 1000 / TICK_MS); // presentation never extends the 30 s rescue window
    expect(got).toContainEqual({ t: 'correct', p: at, c: 1, forced: true, f: pl.f }); // correction clears queued walking prediction at contact
    const snap = got.find(m => m.t === 'snap') as Extract<ServerMsg, { t: 'snap' }>;
    expect(snap.players[0].st).toBe(1);
    expect(snap.players[0].downUntil).toBe(pl.heldUntil);
    expect(snap.mobs[0]).toMatchObject({ st: 1, target: 1 });
    // moving while held is rejected
    got.length = 0;
    room.applyInput(pl, { t: 'input', seq: 1, p: [spawn[0] + 0.1, spawn[1], spawn[2]], yaw: 1, pitch: 0, f: 0 }, 100);
    expect(pl.p).toEqual(at);
    expect(pl.yaw).toBe(1);
    expect(got).toContainEqual({ t: 'correct', p: at, c: 2, forced: true, f: pl.f });
    for (let i = 0; i < Math.ceil((CAUGHT_HOLD_S * 1000) / TICK_MS) + 1; i++) room.step();
    expect(pl.st).toBe(2); // nobody revived: spectator
    expect(pl.heldUntil).toBeUndefined();
  });

  it('ends a solo attempt on the actual catch tick, preserving contact until the restart', () => {
    const { room, got } = join(tee()), pl = room.players.get(1)!;
    pl.p = [pl.p[0] + 5, pl.p[1], pl.p[2]];
    const at = [...pl.p];
    const warden = (room as unknown as { warden: { caught: number[]; step: () => void } }).warden;
    warden.step = function () { this.caught = [1]; };
    got.length = 0;
    room.step();
    expect(got.some(m => m.t === 'caught')).toBe(true);
    expect(pl.p).toEqual(at);
    expect(pl.st).toBe(2);
    expect(pl.heldUntil).toBeUndefined();
    expect(got.filter(m => m.t === 'fade')).toEqual([{ t: 'fade', secs: 3, restart: true }]);
    expect(got.find(m => m.t === 'snap')).toMatchObject({ players: [{ id: 1, p: at.map(v => Math.round(v * 100) / 100), st: 2 }] });
  });

  it('sends one local event for the actual catching monitor, with copied contact positions', () => {
    const { room, got } = join(tee());
    const other: ServerMsg[] = [];
    room.add({ id: 2, name: 'p2', send: m => other.push(m), sendRaw: s => other.push(JSON.parse(s)) }, 0);
    const pl = room.players.get(1)!;
    pl.p = [pl.p[0] + 4, pl.p[1], pl.p[2]];
    const at = [...pl.p], source: [number, number, number] = [pl.p[0], pl.p[1], pl.p[2] + 0.5];
    const r = room as unknown as { warden: { step: () => void; caught: number[] }; monitors: unknown[] };
    r.warden.step = () => { r.warden.caught = []; };
    const still = { p: [200, 0, 200], yaw: 0, state: 'wait', anim: 'idle', caught: [], blinked: false, step() {} };
    const catcher = { ...still, p: source, state: 'hold', caught: [1, 1] };
    r.monitors = [still, catcher];
    got.length = 0; other.length = 0;
    room.step(); room.step();
    const events = got.filter(m => m.t === 'caught');
    expect(events).toEqual([{ t: 'caught', id: 1, seq: 1, tick: room.tick - 1, hold: CAUGHT_HOLD_S, by: 'monitor', at, source, mob: 3, name: '值周生' }]);
    expect(other.some(m => m.t === 'caught')).toBe(false);
    // The actual catcher uses the very same name in both peers' keyframes and the victim's event.
    for (const messages of [got, other]) {
      const named = messages.filter(m => m.t === 'snap').flatMap(m => m.mobs).find(m => m.id === 3 && m.name !== undefined);
      expect(named?.name).toBe(events[0].t === 'caught' ? events[0].name : undefined);
    }
    source[0] += 100; pl.p[0] += 100;
    expect(events[0]).toMatchObject({ at, source: [at[0], at[1], at[2] + 0.5] });
    // The same connection's next real capture has a fresh sequence even after it gets up.
    pl.st = 0; pl.heldUntil = undefined;
    room.step();
    expect(got.filter(m => m.t === 'caught').map(m => m.seq)).toEqual([1, 2]);
  });
});
