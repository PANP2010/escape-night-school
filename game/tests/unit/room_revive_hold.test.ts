import { describe, expect, it } from 'vitest';
import { Room, REVIVE_S } from '../../server/room.ts';
import { TICK_MS } from '../../shared/constants.ts';
import { ACT_DY } from '../../shared/interact.ts';
import { parseClientMsg, ST_DOWN, ST_OK, ST_SPECTATE } from '../../shared/protocol.ts';

const REVIVE_TICKS = Math.ceil(REVIVE_S * 1000 / TICK_MS);

function setup() {
  const room = new Room('HOLD', 7);
  for (let id = 1; id <= 3; id++) room.add({ id, name: `p${id}`, send() {}, sendRaw() {} }, 0);
  const a = room.players.get(1)!, b = room.players.get(2)!, c = room.players.get(3)!;
  b.p = [a.p[0] + 1, a.p[1], a.p[2]];
  c.p = [...a.p];
  b.st = ST_DOWN; b.heldUntil = 9999;
  return { room, a, b, c };
}

type Fixture = ReturnType<typeof setup>;
function advance(room: Room, ticks: number) { for (let i = 0; i < ticks; i++) room.step(); }
/** Ordinary clients renew every 100 ms; the room still decides completion on its own 20 Hz clock. */
function holdFor(f: Fixture, ticks: number, rescuers = [f.a]) {
  for (let i = 0; i < ticks; i++) {
    if (i % 2 === 0) for (const p of rescuers) f.room.handle(p.conn, { t: 'act', kind: 'revive', id: f.b.conn.id }, f.room.tick * TICK_MS);
    f.room.step();
  }
}

describe('authoritative revive hold continuity', () => {
  it('keeps exactly the existing 12-tick grace and discards the hold on tick 13', () => {
    const f = setup();
    f.room.handle(f.a.conn, { t: 'act', kind: 'revive', id: 2 }, 0);
    advance(f.room, 12);
    expect(f.a.reviving).toEqual({ id: 2, since: 0, seen: 0 });
    expect(f.b.st).toBe(ST_DOWN);
    f.room.step();
    expect(f.a.reviving).toBeUndefined();
    expect(f.b.st).toBe(ST_DOWN);
    holdFor(f, REVIVE_TICKS - 1);
    expect(f.b.st).toBe(ST_DOWN);
    f.room.step();
    expect(f.b.st).toBe(ST_OK);
  });

  it('a renewal inside the 12-tick grace preserves progress', () => {
    const f = setup();
    expect(f.room.act(f.a, 'revive', 2)).toBe(true);
    advance(f.room, 12);
    expect(f.room.act(f.a, 'revive', 2)).toBe(true);
    expect(f.a.reviving).toEqual({ id: 2, since: 0, seen: 12 });
    holdFor(f, REVIVE_TICKS - 12 - 1);
    expect(f.b.st).toBe(ST_DOWN);
    f.room.step();
    expect(f.b.st).toBe(ST_OK);
  });

  it('a late renewal cannot recover expired progress before stale cleanup runs', () => {
    const f = setup();
    expect(f.room.act(f.a, 'revive', 2)).toBe(true);
    // Exercise message validation independently of stepRevives: cleanup order cannot make an expired hold valid.
    f.room.tick += 13;
    f.room.handle(f.a.conn, { t: 'act', kind: 'revive', id: 2 }, 13 * TICK_MS);
    expect(f.a.reviving).toEqual({ id: 2, since: 13, seen: 13 });
    holdFor(f, REVIVE_TICKS - 1);
    expect(f.b.st).toBe(ST_DOWN);
    f.room.step();
    expect(f.b.st).toBe(ST_OK);
  });

  it.each(['range', 'storey', 'rescuer down', 'rescuer spectating', 'target up', 'target spectating'])(
    'revalidates %s during a live hold and starts the next valid hold from zero', (invalid) => {
      const f = setup(), origin = [...f.a.p] as typeof f.a.p;
      holdFor(f, REVIVE_TICKS - 2);
      if (invalid === 'range') f.a.p[0] += 10;
      if (invalid === 'storey') f.a.p[1] = f.b.p[1] + ACT_DY;
      if (invalid === 'rescuer down') f.a.st = ST_DOWN;
      if (invalid === 'rescuer spectating') f.a.st = ST_SPECTATE;
      if (invalid === 'target up') f.b.st = ST_OK;
      if (invalid === 'target spectating') f.b.st = ST_SPECTATE;
      expect(f.room.act(f.a, 'revive', 2)).toBe(false);
      f.room.step();
      expect(f.a.reviving).toBeUndefined();
      f.a.p = origin; f.a.st = ST_OK; f.b.st = ST_DOWN;
      const since = f.room.tick;
      f.room.handle(f.a.conn, { t: 'act', kind: 'revive', id: 2 }, since * TICK_MS);
      expect(f.a.reviving).toEqual({ id: 2, since, seen: since });
      holdFor(f, REVIVE_TICKS - 1);
      expect(f.b.st).toBe(ST_DOWN);
      f.room.step();
      expect(f.b.st).toBe(ST_OK);
      expect(f.b.heldUntil).toBeUndefined();
    });

  it('a removed target clears the hold and an absent target cannot be renewed', () => {
    const f = setup();
    holdFor(f, REVIVE_TICKS - 1);
    f.room.remove(f.b.conn, f.room.tick * TICK_MS);
    f.room.step();
    expect(f.a.reviving).toBeUndefined();
    expect(f.room.act(f.a, 'revive', 2)).toBe(false);
  });
});

describe('revive cancellation authority', () => {
  it('a release before the completion tick cancels only its sender while another rescuer can finish', () => {
    const f = setup();
    holdFor(f, REVIVE_TICKS - 1, [f.a, f.c]);
    expect(f.b.st).toBe(ST_DOWN);
    const other = { ...f.c.reviving! };
    f.room.handle(f.a.conn, { t: 'act', kind: 'revive_cancel', id: 3 }, 2950);
    expect(f.a.reviving?.id).toBe(2);
    f.room.handle(f.a.conn, { t: 'act', kind: 'revive_cancel', id: 2 }, 2950);
    expect(f.a.reviving).toBeUndefined();
    expect(f.c.reviving).toEqual(other);
    f.room.step();
    expect(f.b.st).toBe(ST_OK);
    expect(f.b.heldUntil).toBeUndefined();
  });

  it.each(['down', 'spectator', 'hidden', 'lobby', 'fade', 'complete'])(
    'still accepts a matching release when its sender is now %s', (gate) => {
      const f = setup();
      expect(f.room.act(f.a, 'revive', 2)).toBe(true);
      expect(f.room.act(f.c, 'revive', 2)).toBe(true);
      const other = { ...f.c.reviving! }, deadline = f.b.heldUntil;
      if (gate === 'down') f.a.st = ST_DOWN;
      if (gate === 'spectator') f.a.st = ST_SPECTATE;
      if (gate === 'hidden') f.a.hide = { id: 0, out: [...f.a.p], crouch: false };
      if (gate === 'lobby') f.room.started = false;
      if (gate === 'fade') (f.room as any).advanceAt = 100;
      if (gate === 'complete') f.room.completed = true;
      f.room.handle(f.a.conn, { t: 'act', kind: 'revive_cancel', id: 2 }, 0);
      f.room.handle(f.a.conn, { t: 'act', kind: 'revive_cancel', id: 2 }, 0); // duplicate releases are harmless
      expect(f.a.reviving).toBeUndefined();
      expect(f.c.reviving).toEqual(other);
      expect(f.b.st).toBe(ST_DOWN);
      expect(f.b.heldUntil).toBe(deadline);
    });

  it('uses the connection identity even when a valid wire message spoofs another sender', () => {
    const f = setup();
    expect(f.room.act(f.a, 'revive', 2)).toBe(true);
    const message = parseClientMsg('{"t":"act","kind":"revive_cancel","id":2,"from":1}');
    expect(message).toEqual({ t: 'act', kind: 'revive_cancel', id: 2 });
    f.room.handle(f.c.conn, message!, 0);
    expect(f.a.reviving).toEqual({ id: 2, since: 0, seen: 0 });
    expect(f.c.reviving).toBeUndefined();
  });

  it.each([-1, 1.5, '2', null, true, {}, [], undefined])('rejects malformed cancellation target %j', (id) => {
    expect(parseClientMsg(JSON.stringify({ t: 'act', kind: 'revive_cancel', id }))).toBeNull();
  });
});
