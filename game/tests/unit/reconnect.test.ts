import { describe, expect, it } from 'vitest';
import { IpConnections, MAX_BAD_MESSAGES, MAX_IP_CONNECTIONS, MAX_RATE_DROPS, MESSAGES_PER_SECOND, MessageGuard, RESUME_MS, ResumeSessions } from '../../server/reconnect.ts';
import { MAX_ROOMS, MOVE_BURST, RoomManager, type Conn } from '../../server/room.ts';
import { F_LIGHT, F_RUN, parseClientMsg, ST_DOWN, ST_OK, ST_SPECTATE, type ServerMsg, type Vec3 } from '../../shared/protocol.ts';
import { TICK_MS, TPS } from '../../shared/constants.ts';
import { mulberry32 } from '../../shared/rng.ts';
import { NavGraph } from '../../shared/campus/nav.ts';

const peer = (id: number) => {
  const got: ServerMsg[] = [];
  const conn: Conn = { id, name: `p${id}`, send: m => got.push(structuredClone(m)), sendRaw: s => got.push(JSON.parse(s)) };
  return { conn, got };
};
const setup = (level = 0, lobby = false, nav?: NavGraph) => {
  const manager = new RoomManager(mulberry32(31), () => nav), room = manager.create(lobby, level);
  const sessions = new ResumeSessions(), a = peer(1), b = peer(2);
  const hello = sessions.hello(a.conn, undefined, 0);
  if (!('token' in hello)) throw new Error('Fresh hello needs a session');
  room.add(a.conn, 0); room.add(b.conn, 0);
  return { manager, room, sessions, a, b, token: hello.token };
};

describe('resume credentials', () => {
  it('issues one opaque 256-bit secret per connection; repeated hello cannot grow sessions or rotate it', () => {
    const sessions = new ResumeSessions(), a = peer(1), b = peer(2);
    const first = sessions.hello(a.conn, undefined, 0);
    expect('token' in first && /^[A-Za-z0-9_-]{43}$/.test(first.token)).toBe(true);
    const repeated = sessions.hello(a.conn, undefined, 1);
    expect('token' in first && 'token' in repeated && first.token === repeated.token).toBe(true);
    const other = sessions.hello(b.conn, undefined, 1);
    expect('token' in first && 'token' in other && first.token !== other.token).toBe(true);
    expect(parseClientMsg('{"t":"hello","name":"甲","resume":"invalid"}')).toBeNull();
    expect(parseClientMsg(JSON.stringify({ t: 'hello', name: '甲', resume: 'A'.repeat(43) }))).toEqual({ t: 'hello', name: '甲', resume: 'A'.repeat(43) });
  });

  it('refuses an active token, rotates a detached token once and rejects its later replay', () => {
    const { room, sessions, a, token } = setup();
    const contender = peer(3);
    const pending = sessions.hello(contender.conn, token, 1);
    expect('resumePending' in pending && pending.resumePending).toBe(true);
    expect(Object.keys(pending)).toEqual(['resumePending']);
    expect(contender.conn.id).toBe(3);
    expect(room.players.get(1)!.conn).toBe(a.conn);
    sessions.disconnect(a.conn, 100);
    const result = sessions.hello(contender.conn, token, 101);
    expect('resumed' in result && result.resumed).toBe(true);
    if (!('previous' in result)) throw new Error('Expected detached session');
    expect(result.token === token).toBe(false);
    expect(room.resume(result.previous, contender.conn, 101)).toBe(true);
    const replay = sessions.hello(peer(4).conn, token, 102);
    expect('resumeFailed' in replay && replay.resumeFailed).toBe(true);
    expect(room.players.size).toBe(2);
  });

  it('expires exactly at ten seconds, frees its slot and leaves failed recovery in a fresh lobby session', () => {
    const { room, sessions, a, token, manager } = setup();
    sessions.disconnect(a.conn, 100);
    sessions.expire(100 + RESUME_MS - 1);
    expect(room.players.has(1)).toBe(true);
    const newcomer = peer(3), result = sessions.hello(newcomer.conn, token, 100 + RESUME_MS);
    expect('resumeFailed' in result && result.resumeFailed).toBe(true);
    expect(newcomer.conn.room).toBeUndefined();
    expect(newcomer.conn.id).toBe(3);
    expect(room.players.has(1)).toBe(false);
    room.remove(room.players.get(2)!.conn, 100 + RESUME_MS);
    manager.step(100 + RESUME_MS + 30_001);
    expect(manager.rooms.size).toBe(0);
  });

  it('revokes kicked credentials so reconnect cannot bypass removal', () => {
    const { room, sessions, a, token } = setup();
    sessions.revoke(a.conn, 100);
    const result = sessions.hello(peer(3).conn, token, 101);
    expect('resumeFailed' in result && result.resumeFailed).toBe(true);
    expect(room.players.has(1)).toBe(false);
  });
});

describe('authoritative reserved players', () => {
  it('preserves gameplay state, transfers the host once, sends a complete state and ignores the former socket', () => {
    const { room, sessions, a, b, token } = setup(2);
    const pl = room.players.get(1)!;
    pl.battery = .37; pl.stamina = .42; pl.safeUntil = 7;
    pl.loop = { ...pl.loop, step: 2, loops: 3, mistakes: 1 };
    pl.f = F_LIGHT; pl.st = ST_DOWN; pl.heldUntil = 400;
    const position = [...pl.p], loop = { ...pl.loop };
    sessions.disconnect(a.conn, 100);
    expect(room.host).toBe(2);
    expect(b.got.findLast(m => m.t === 'room')).toMatchObject({ players: [{ id: 1, online: false }, { id: 2 }] });
    for (let i = 0; i < 20; i++) room.step();
    const next = peer(3), result = sessions.hello(next.conn, token, 1100);
    if (!('previous' in result)) throw new Error('Expected resume');
    expect(room.resume(result.previous, next.conn, 1100)).toBe(true);
    expect(pl).toMatchObject({ battery: .37, stamina: .42, st: ST_DOWN, heldUntil: 400, safeUntil: 7, p: position, loop });
    expect(pl.conn).toBe(next.conn);
    expect(room.host).toBe(2);
    expect(next.conn.id).toBe(1);
    expect(next.got.map(m => m.t)).toEqual(expect.arrayContaining(['room', 'items', 'keys', 'bag', 'power', 'doors', 'loop', 'snap', 'resume', 'correct']));
    expect(next.got[0].t).toBe('room');
    const snap = next.got.find(m => m.t === 'snap');
    expect(snap?.players.find(p => p.id === 1)).toMatchObject({ id: 1, p: position, f: F_LIGHT, st: ST_DOWN, bat: .37, sta: .42 });
    expect(next.got.find(m => m.t === 'resume')).toEqual({ t: 'resume', downLeft: 19 });
    expect(next.got.at(-1)).toMatchObject({ t: 'correct', p: position, forced: true, c: 1 });
    expect(next.got.some(m => m.t === 'caught')).toBe(false);
    const count = b.got.length;
    room.handle(a.conn, { t: 'chat', text: 'stale' }, 1200);
    room.remove(a.conn, 1200);
    expect(b.got.length).toBe(count);
    expect(room.players.get(1)!.conn).toBe(next.conn);
  });

  it('requires the new c and an increasing seq, while accepting fresh low sequence numbers after refresh', () => {
    const { room, sessions, a, token } = setup();
    const pl = room.players.get(1)!;
    sessions.disconnect(a.conn, 10);
    const next = peer(3), result = sessions.hello(next.conn, token, 20);
    if (!('previous' in result)) throw new Error('Expected resume');
    room.resume(result.previous, next.conn, 20);
    const start: Vec3 = [...pl.p], target: Vec3 = [start[0] + .1, start[1], start[2]];
    const input = { t: 'input' as const, seq: 1, p: target, yaw: .5, pitch: 0, f: 0 };
    room.handle(next.conn, input, 100);
    room.handle(next.conn, { ...input, c: pl.c - 1, seq: 1000000 }, 150);
    expect(pl.p).toEqual(start);
    const c = pl.c;
    room.handle(next.conn, { ...input, c }, 200);
    expect(pl.p).toEqual(target);
    room.handle(next.conn, { ...input, c, p: start }, 250);
    expect(pl.p).toEqual(target);
    expect(pl.budget).toBeLessThanOrEqual(MOVE_BURST + 2);
  });

  it('excludes offline players from prey, interactions and rescue, but keeps down timers running and avoids an all-offline wipe', () => {
    const { room, sessions, a, b } = setup();
    const pl = room.players.get(1)!, other = room.players.get(2)!;
    pl.st = ST_DOWN; pl.heldUntil = 3; other.p = [...pl.p]; other.f = F_RUN | F_LIGHT;
    room.handle(b.conn, { t: 'act', kind: 'revive', id: 1 }, 0);
    expect(other.reviving).toBeDefined();
    sessions.disconnect(a.conn, 1);
    expect(other.reviving).toBeUndefined();
    expect(room.act(other, 'revive', 1)).toBe(false);
    sessions.disconnect(b.conn, 1); // no hello token: this peer is removed, leaving only the offline downed member
    for (let i = 0; i < 4; i++) room.step();
    expect(pl.st).toBe(ST_SPECTATE);
    expect(pl.heldUntil).toBeUndefined();
    expect(room.tick).toBe(4);
    expect(b.got.some(m => m.t === 'fade')).toBe(false);
    expect((room as unknown as { prey(): unknown[] }).prey()).toEqual([]);
    expect(room.act(pl, 'pick', room.items[0]?.id ?? 0)).toBe(false);
  });

  it('keeps battery and stamina unchanged while offline, and lets a sole returning player reclaim an empty host', () => {
    const { room, sessions, a, b, token } = setup();
    room.remove(b.conn, 0);
    const pl = room.players.get(1)!;
    pl.battery = .3; pl.stamina = .4; pl.f = F_RUN | F_LIGHT;
    sessions.disconnect(a.conn, 1);
    expect(room.host).toBe(0);
    for (let i = 0; i < 1000 / TICK_MS; i++) room.step();
    expect(pl.battery).toBe(.3); expect(pl.stamina).toBe(.4);
    const next = peer(3), result = sessions.hello(next.conn, token, 1001);
    if (!('previous' in result)) throw new Error('Expected resume');
    room.resume(result.previous, next.conn, 1001);
    expect(room.host).toBe(1);
    expect(pl.st).toBe(ST_OK);
  });

  it('sends complete mob fields between delta keyframes', () => {
    const nav = new NavGraph(); nav.chain([{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 20, y: 0, z: 0 }]);
    const { room, sessions, a, token } = setup(0, false, nav);
    room.step(); room.step();
    sessions.disconnect(a.conn, 1);
    const next = peer(3), result = sessions.hello(next.conn, token, 2);
    if (!('previous' in result)) throw new Error('Expected resume');
    room.resume(result.previous, next.conn, 2);
    const snap = next.got.find(m => m.t === 'snap');
    expect(snap).toMatchObject({ mobs: [{ id: 1, kind: 'warden', form: 'normal', anim: expect.any(String), target: expect.any(Number), st: expect.any(Number) }] });
    expect(next.got.at(-1)).toMatchObject({ t: 'correct', forced: true });
  });

  it('also sends the ready correction when a reserved player returns to the waiting room', () => {
    const { room, sessions, a, token } = setup(0, true);
    sessions.disconnect(a.conn, 1);
    const next = peer(3), result = sessions.hello(next.conn, token, 2);
    if (!('previous' in result)) throw new Error('Expected resume');
    room.resume(result.previous, next.conn, 2);
    expect(next.got[0]).toMatchObject({ t: 'room', started: false });
    expect(next.got.some(m => m.t === 'snap')).toBe(true);
    expect(next.got.at(-1)).toMatchObject({ t: 'correct', forced: true });
  });
});

describe('bounded server resources', () => {
  it('caps real peer addresses at four connections and releases closed admissions', () => {
    const ips = new IpConnections();
    for (let i = 0; i < MAX_IP_CONNECTIONS; i++) expect(ips.acquire('127.0.0.1')).toBe(true);
    expect(ips.acquire('127.0.0.1')).toBe(false);
    expect(ips.acquire('127.0.0.2')).toBe(true);
    ips.release('127.0.0.1');
    expect(ips.acquire('127.0.0.1')).toBe(true);
  });

  it('executes a bounded number of packets per rolling second and kicks sustained floods', () => {
    const guard = new MessageGuard();
    for (let second = 0; second < 4; second++) {
      const times = [...Array.from({ length: TPS }, (_, i) => second * 1000 + i * (1000 / TPS)), ...Array.from({ length: 8 }, (_, i) => second * 1000 + i * 125)].sort((a, b) => a - b);
      for (const at of times) expect(guard.allow(at)).toBe(true);
    }
    const flood = new MessageGuard();
    for (let i = 0; i < MESSAGES_PER_SECOND; i++) expect(flood.allow(i)).toBe(true);
    for (let i = 0; i < MAX_RATE_DROPS; i++) expect(flood.allow(MESSAGES_PER_SECOND + 1 + i)).toBe(false);
    expect(flood.kicked).toBe(true);
    expect(flood.allow(1030)).toBe(true);
    const invalid = new MessageGuard();
    for (let i = 0; i < MAX_BAD_MESSAGES - 1; i++) invalid.invalid();
    expect(invalid.kicked).toBe(false);
    invalid.invalid(); expect(invalid.kicked).toBe(true);
  });

  it('limits rooms to fifty and recycles empty rooms without deleting a reserved session', () => {
    const manager = new RoomManager(mulberry32(28));
    for (let i = 0; i < MAX_ROOMS; i++) manager.create(true);
    expect(() => manager.create()).toThrow('房间数量已满');
    manager.step(30_001);
    expect(manager.rooms.size).toBe(0);
    const room = manager.create(), a = peer(1); room.add(a.conn, 30_002); room.disconnect(a.conn);
    manager.step(100_000);
    expect(manager.rooms.size).toBe(1);
  });
});
