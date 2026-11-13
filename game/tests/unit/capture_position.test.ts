import { describe, expect, it } from 'vitest';
import { CAUGHT_HOLD_S, LEVEL_FADE_S, REVIVE_S, SAFE_S, RoomManager, type Conn } from '../../server/room.ts';
import { RESUME_MS, ResumeSessions } from '../../server/reconnect.ts';
import { TICK_MS } from '../../shared/constants.ts';
import { F_HIDE, ST_DOWN, ST_OK, ST_SPECTATE, type CatchSource, type ServerMsg, type Vec3 } from '../../shared/protocol.ts';
import { mulberry32 } from '../../shared/rng.ts';

const peer = (id: number) => {
  const messages: ServerMsg[] = [];
  const conn: Conn = { id, name: `同学${id}`, send: m => messages.push(structuredClone(m)), sendRaw: raw => messages.push(JSON.parse(raw)) };
  return { conn, messages };
};
const setup = (count = 2, level = 0) => {
  const room = new RoomManager(mulberry32(71)).create(true, level);
  const peers = Array.from({ length: count }, (_, i) => peer(i + 1));
  const sessions = new ResumeSessions();
  const tokens = peers.map(p => {
    const hello = sessions.hello(p.conn, undefined, 0);
    if (!('token' in hello)) throw new Error('Expected fresh session');
    room.add(p.conn, 0);
    return hello.token;
  });
  room.handle(peers[0].conn, { t: 'start' }, 0);
  const intro = peers[0].messages.findLast(m => m.t === 'event' && m.kind === 'intro');
  if (intro?.t !== 'event' || intro.kind !== 'intro') throw new Error('Expected synchronized opening');
  for (const p of peers) room.handle(p.conn, { t: 'intro-skip', id: intro.id }, 0);
  for (const p of peers) room.handle(p.conn, { t: 'ready', incarnation: room.incarnation }, 0);
  expect(room.introFrozen).toBe(false);
  type Player = NonNullable<ReturnType<typeof room.players.get>>;
  const authority = room as unknown as { punish(pl: Player, by: CatchSource, source: Vec3, mob?: number): void };
  const catchPlayer = (id: number, by: CatchSource = 'warden') => {
    const pl = room.players.get(id)!;
    authority.punish(pl, by, [pl.p[0] + .5, pl.p[1], pl.p[2]], by === 'monitor' ? 2 : undefined);
  };
  const place = (id: number, x = -30, z = 73.36) => {
    const pl = room.players.get(id)!;
    room.handle(pl.conn, { t: 'debug', op: 'tp', x, z, floor: 0 }, room.tick * TICK_MS);
    expect(pl.p).toEqual([x, 0, z]);
    return pl;
  };
  const step = (n = 1) => { for (let i = 0; i < n; i++) room.step(); };
  const fade = () => peers[0].messages.filter(m => m.t === 'fade');
  return { room, peers, sessions, tokens, catchPlayer, place, step, fade };
};
const snap = (messages: ServerMsg[]) => {
  const s = messages.findLast(m => m.t === 'snap');
  if (s?.t !== 'snap') throw new Error('Expected authority snapshot');
  return s;
};

describe('capture position and authoritative rescue', () => {
  it.each(['warden', 'monitor', 'mirror'] as const)('%s keeps contact, correction, teammate snapshot and resumed body at the same point through a real rescue', by => {
    const { room, peers, sessions, tokens, catchPlayer, place, step } = setup();
    const [a, b] = peers, spawn: Vec3 = [...room.players.get(1)!.p];
    const victim = place(1), at: Vec3 = [...victim.p];
    expect(at).not.toEqual(spawn);
    catchPlayer(1, by);
    const contact = a.messages.findLast(m => m.t === 'caught');
    expect(contact).toMatchObject({ t: 'caught', by, at, hold: CAUGHT_HOLD_S });
    expect(a.messages.findLast(m => m.t === 'correct')).toMatchObject({ p: at, forced: true });
    expect(victim.p).toEqual(at);
    const deadline = victim.heldUntil;
    // Stale walking prediction cannot move either the body or its correction back toward spawn.
    room.applyInput(victim, { t: 'input', seq: 1, p: spawn, c: victim.c, yaw: .5, pitch: 0, f: 0 }, 50);
    expect(victim.p).toEqual(at);
    expect(a.messages.findLast(m => m.t === 'correct')).toMatchObject({ p: at, forced: true });
    step();
    for (const p of peers) expect(snap(p.messages).players.find(pl => pl.id === 1)).toMatchObject({ p: at, st: ST_DOWN });

    sessions.disconnect(a.conn, 100);
    const restored = peer(9), result = sessions.hello(restored.conn, tokens[0], 101);
    if (!('previous' in result)) throw new Error('Expected real session recovery');
    expect(room.resume(result.previous, restored.conn, 101)).toBe(true);
    expect(snap(restored.messages).players.find(pl => pl.id === 1)).toMatchObject({ p: at, st: ST_DOWN });
    expect(restored.messages.findLast(m => m.t === 'correct')).toMatchObject({ p: at, forced: true });
    expect(restored.messages.some(m => m.t === 'caught')).toBe(false);
    expect(victim.heldUntil).toBe(deadline);
    expect(restored.messages.find(m => m.t === 'resume')).toEqual({ t: 'resume', downLeft: 29.95 });

    const rescuer = place(2, at[0] + .9, at[2]);
    const ticks = REVIVE_S * 1000 / TICK_MS;
    for (let i = 0; i < ticks - 1; i++) { expect(room.act(rescuer, 'revive', 1)).toBe(true); step(); }
    expect(victim.st).toBe(ST_DOWN);
    expect(victim.p).toEqual(at);
    expect(room.act(rescuer, 'revive', 1)).toBe(true); step();
    expect(victim.st).toBe(ST_OK);
    expect(victim.heldUntil).toBeUndefined();
    expect(victim.safeUntil).toBe(room.tick + SAFE_S * 1000 / TICK_MS);
    expect(victim.p).toEqual(at);
    for (const p of [restored, b]) {
      const state = snap(p.messages).players.find(pl => pl.id === 1)!;
      expect(state.p).toEqual(at);
      expect(state.st ?? ST_OK).toBe(ST_OK);
    }
  });

  it('keeps a full 30-second down window while a standing teammate is hidden', () => {
    const { room, catchPlayer, place, step, fade } = setup();
    const victim = place(1), rescuer = room.players.get(2)!, hide = room.level.def.hides[0];
    rescuer.p = [hide.x, hide.y ?? 0, hide.z];
    expect(room.act(rescuer, 'hide', 0)).toBe(true);
    expect(rescuer.f & F_HIDE).toBe(F_HIDE);
    catchPlayer(1);
    const at: Vec3 = [...victim.p];
    step(CAUGHT_HOLD_S * 1000 / TICK_MS - 1);
    expect(victim.st).toBe(ST_DOWN);
    expect(fade()).toEqual([]);
    expect(victim.p).toEqual(at);
    step();
    expect(victim.st).toBe(ST_SPECTATE);
    expect(rescuer.st).toBe(ST_OK);
    expect(fade()).toEqual([]);
  });
});

describe('no remaining rescuer ends the attempt immediately', () => {
  it.each([1, 2, 3])('%i players: all down become spectators within one tick and only the real restart returns them to spawn', count => {
    const { room, peers, catchPlayer, place, step, fade } = setup(count);
    const starts = peers.map(p => [...room.players.get(p.conn.id)!.p]);
    const contacts = peers.map((p, i) => [...place(p.conn.id, -30 - i * 2).p]);
    for (const p of peers) catchPlayer(p.conn.id);
    const incarnation = room.incarnation;
    step();
    expect(room.tick).toBe(1);
    expect(fade()).toEqual([{ t: 'fade', secs: LEVEL_FADE_S, restart: true }]);
    for (const [i, p] of peers.entries()) {
      const pl = room.players.get(p.conn.id)!;
      expect(pl.st).toBe(ST_SPECTATE);
      expect(pl.heldUntil).toBeUndefined();
      expect(pl.p).toEqual(contacts[i]);
    }
    step(LEVEL_FADE_S * 1000 / TICK_MS - 1);
    expect(room.incarnation).toBe(incarnation);
    step();
    expect(room.incarnation).toBe(incarnation + 1);
    expect(room.levelIndex).toBe(0);
    expect(room.introFrozen).toBe(true);
    for (const [i, p] of peers.entries()) expect(room.players.get(p.conn.id)).toMatchObject({ st: ST_OK, p: starts[i] });
    expect(fade()).toHaveLength(1);
  });

  it('waits for the last standing teammate, and late observers cannot block a subsequent wipe', () => {
    const { room, peers, catchPlayer, step, fade } = setup(3);
    catchPlayer(1); catchPlayer(2); step();
    expect(room.players.get(1)!.st).toBe(ST_DOWN);
    expect(room.players.get(2)!.st).toBe(ST_DOWN);
    expect(fade()).toEqual([]);
    const observer = peer(4); room.add(observer.conn, 100);
    expect(room.players.get(4)!.st).toBe(ST_SPECTATE);
    catchPlayer(3); step();
    for (const p of peers) expect(room.players.get(p.conn.id)!.st).toBe(ST_SPECTATE);
    expect(fade()).toHaveLength(1);
  });

  it('retains a disconnected standing rescuer until actual session expiry, then immediately wipes', () => {
    const { room, peers, sessions, catchPlayer, step, fade } = setup();
    sessions.disconnect(peers[1].conn, 100);
    catchPlayer(1); step(20);
    expect(room.players.get(1)!.st).toBe(ST_DOWN);
    expect(fade()).toEqual([]);
    sessions.expire(100 + RESUME_MS - 1); step();
    expect(room.players.has(2)).toBe(true);
    expect(fade()).toEqual([]);
    sessions.expire(100 + RESUME_MS); step();
    expect(room.players.has(2)).toBe(false);
    expect(room.players.get(1)!.st).toBe(ST_SPECTATE);
    expect(fade()).toHaveLength(1);
  });

  it('lets the reserved standing teammate reconnect and complete a real rescue', () => {
    const { room, peers, sessions, tokens, catchPlayer, place, step, fade } = setup();
    const victim = place(1), at: Vec3 = [...victim.p];
    sessions.disconnect(peers[1].conn, 100); catchPlayer(1); step(20);
    const returning = peer(9), hello = sessions.hello(returning.conn, tokens[1], 1100);
    if (!('previous' in hello)) throw new Error('Expected reserved rescuer');
    expect(room.resume(hello.previous, returning.conn, 1100)).toBe(true);
    const rescuer = place(2, at[0] + .9, at[2]);
    for (let i = 0; i < REVIVE_S * 1000 / TICK_MS; i++) { expect(room.act(rescuer, 'revive', 1)).toBe(true); step(); }
    expect(victim).toMatchObject({ st: ST_OK, p: at });
    expect(fade()).toEqual([]);
  });

  it('does not start an attempt or fade for an empty room or an entirely offline room', () => {
    const { room, peers, sessions, catchPlayer, step, fade } = setup();
    for (const p of peers) { catchPlayer(p.conn.id); sessions.disconnect(p.conn, 100); }
    step(20);
    expect(fade()).toEqual([]);
    for (const p of peers) expect(room.players.get(p.conn.id)!.st).toBe(ST_DOWN);
    sessions.expire(100 + RESUME_MS); step();
    expect(room.players.size).toBe(0);
    expect(fade()).toEqual([]);
  });

  it('eliminates all down during final rollcall without waiting thirty seconds', () => {
    const { room, peers, catchPlayer, step, fade } = setup(2, 7);
    for (const p of peers) catchPlayer(p.conn.id);
    step();
    for (const p of peers) expect(room.players.get(p.conn.id)!.st).toBe(ST_SPECTATE);
    expect(fade()).toEqual([{ t: 'fade', secs: LEVEL_FADE_S, restart: true }]);
  });

  it('preserves final extraction results when every remaining unescaped member is down', () => {
    const { room, peers, catchPlayer, step, fade } = setup(2, 7);
    const a = room.players.get(1)!, b = room.players.get(2)!, book = room.level.def.finale!.rollcall;
    a.p = [book.x, book.y, book.z + 1.45];
    expect(room.act(a, 'rollcall', 1)).toBe(true);
    expect(room.act(a, 'rollcall', 2)).toBe(true); step();
    a.p = [room.level.exit.x, room.level.exit.y, room.level.exit.z]; step();
    expect(a.escaped).toBe(true);
    catchPlayer(2); step();
    expect(b.st).toBe(ST_SPECTATE);
    expect(b.heldUntil).toBeUndefined();
    expect(a.escaped).toBe(true);
    expect(peers[0].messages.findLast(m => m.t === 'completed')).toMatchObject({ members: [{ id: 1, escaped: true }, { id: 2, escaped: false }] });
    expect(fade()).toEqual([]);
  });
});
