import { afterEach, describe, expect, it } from 'vitest';
import { NavGraph } from '../../shared/campus/nav.ts';
import { mulberry32 } from '../../shared/rng.ts';
import { LEVEL_FADE_S, RoomManager, type Conn } from '../../server/room.ts';
import { TICK_MS } from '../../shared/constants.ts';
import { FLOOR_HEIGHT } from '../../shared/campus/campus_schema.ts';
import { parseClientMsg, ST_DOWN, type ServerMsg } from '../../shared/protocol.ts';

function tee() {
  const g = new NavGraph();
  g.chain([{ x: 0, y: 0, z: 0 }, { x: 5, y: 0.5, z: 0 }, { x: 10, y: 1, z: 0 }]);
  // L2 encounter starts must lie on its storey, at least 20 m off all spawns.
  g.chain([{ x: 15, y: 3.6, z: 84.2 }, { x: 20, y: 3.6, z: 84.2 }, { x: 25, y: 3.6, z: 84.2 }]);
  return g;
}
const join = (withRescuer = false) => {
  const room = new RoomManager(mulberry32(3), () => tee()).create();
  const got: ServerMsg[] = [];
  const c: Conn = { id: 1, name: 'p1', send: (m) => got.push(m), sendRaw: (s) => got.push(JSON.parse(s)) };
  room.add(c, 0);
  if (withRescuer) {
    room.add({ id: 2, name: 'standing rescuer', send: () => {}, sendRaw: () => {} }, 0);
    // Keep this debug catch fixture in one attempt while its target waits for a rescue.
    room.players.get(2)!.safeUntil = 100_000;
  }
  return { room, got, c, pl: room.players.get(1)! };
};
const wardenOf = (room: unknown) => (room as { warden: { state: string; p: number[] } }).warden;
const env = process.env.NODE_ENV;
afterEach(() => { process.env.NODE_ENV = env; });

describe('debug messages', () => {
  it('parses the four ops and rejects malformed ones', () => {
    expect(parseClientMsg('{"t":"debug","op":"tp","x":1,"z":2,"floor":1}')).toEqual({ t: 'debug', op: 'tp', x: 1, z: 2, floor: 1 });
    expect(parseClientMsg('{"t":"debug","op":"warden"}')).toMatchObject({ op: 'warden' });
    expect(parseClientMsg('{"t":"debug","op":"down"}')).toEqual({ t: 'debug', op: 'down' });
    expect(parseClientMsg('{"t":"debug","op":"down","s":3}')).toEqual({ t: 'debug', op: 'down', s: 3 });
    expect(parseClientMsg('{"t":"debug","op":"down","s":"x"}')).toBeNull();
    expect(parseClientMsg('{"t":"debug","op":"safe","s":60}')).toEqual({ t: 'debug', op: 'safe', s: 60 });
    expect(parseClientMsg('{"t":"debug","op":"safe"}')).toEqual({ t: 'debug', op: 'safe' });
    expect(parseClientMsg('{"t":"debug","op":"safe","s":"x"}')).toBeNull();
    expect(parseClientMsg('{"t":"debug","op":"safe","s":60,"mob":1}')).toEqual({ t: 'debug', op: 'safe', s: 60, mob: 1 });
    expect(parseClientMsg('{"t":"debug","op":"safe","mob":2}')).toEqual({ t: 'debug', op: 'safe', mob: 2 });
    expect(parseClientMsg('{"t":"debug","op":"safe","mob":3}')).toBeNull();
    expect(parseClientMsg('{"t":"debug","op":"key","door":3}')).toMatchObject({ op: 'key', door: 3 });
    expect(parseClientMsg('{"t":"debug","op":"tp","x":"a","z":2}')).toBeNull();
    expect(parseClientMsg('{"t":"debug","op":"boom"}')).toBeNull();
  });

  it('warden puts him d m in front of the player and straight into chase', () => {
    process.env.NODE_ENV = 'test';
    const { room, pl } = join();
    pl.yaw = 0; // forward = -z
    room.handle(pl.conn, { t: 'debug', op: 'warden', d: 5 }, 10);
    const w = wardenOf(room);
    expect(w.state).toBe('chase');
    expect(w.p[0]).toBeCloseTo(pl.p[0]);
    expect(w.p[2]).toBeCloseTo(pl.p[2] - 5);
    room.step();
    expect(wardenOf(room).state).toBe('chase');
  });

  it('down, key and tp work for the sender', () => {
    process.env.NODE_ENV = 'test';
    const { room, got, pl } = join();
    room.handle(pl.conn, { t: 'debug', op: 'down' }, 10);
    expect(pl.st).toBe(ST_DOWN);
    room.handle(pl.conn, { t: 'debug', op: 'key', door: 7 }, 10);
    expect(got).toContainEqual({ t: 'keys', keys: [7] });
    got.length = 0;
    room.handle(pl.conn, { t: 'debug', op: 'tp', x: -45, z: 75 }, 10);
    expect([pl.p[0], pl.p[2]]).toEqual([-45, 75]);
    expect(got).toContainEqual({ t: 'correct', p: pl.p, c: 1, forced: true, f: pl.f });
  });

  it('safe gives every player the spawn grace for s seconds (capped at 600)', () => {
    process.env.NODE_ENV = 'test';
    const { room, pl } = join();
    const tick = () => (room as unknown as { tick: number }).tick;
    room.handle(pl.conn, { t: 'debug', op: 'safe', s: 30 }, 10);
    expect(pl.safeUntil).toBe(tick() + 600);
    room.handle(pl.conn, { t: 'debug', op: 'safe', s: 9999 }, 10);
    expect(pl.safeUntil).toBe(tick() + 12000);
  });

  it('safe mob 1: only 角色074 leaves the player alone (they stay prey for the 值日生), until he is summoned again', () => {
    process.env.NODE_ENV = 'test';
    const ticks = Math.ceil(10_000 / TICK_MS);
    // control: summoned 1.5 m ahead, he catches within 10 s
    const a = join(true);
    a.room.handle(a.pl.conn, { t: 'debug', op: 'warden', d: 1.5 }, 10);
    for (let i = 0; i < ticks && a.pl.st !== ST_DOWN; i++) a.room.step();
    expect(a.pl.st).toBe(ST_DOWN);
    const { room, pl } = join(true);
    room.handle(pl.conn, { t: 'debug', op: 'warden', d: 1.5 }, 10);
    room.handle(pl.conn, { t: 'debug', op: 'safe', s: 60, mob: 1 }, 10);
    for (let i = 0; i < ticks; i++) room.step();
    expect(pl.st).not.toBe(ST_DOWN);
    expect(pl.safeUntil).toBeUndefined(); // the per-player grace (both NPCs) is untouched
    room.handle(pl.conn, { t: 'debug', op: 'warden', d: 1.5 }, 10);
    for (let i = 0; i < ticks && pl.st !== ST_DOWN; i++) room.step();
    expect(pl.st).toBe(ST_DOWN);
  });

  it('safe mob 2: only the 值日生 stands down (角色074 untouched), until it is summoned again', () => {
    process.env.NODE_ENV = 'test';
    const ticks = Math.ceil(20_000 / TICK_MS); // past its 15 s start delay
    const l2 = (mob2: boolean) => {
      const j = join();
      (j.room as unknown as { loadLevel(i: number): void }).loadLevel(1);
      j.pl.safeUntil = undefined;
      j.room.handle(j.pl.conn, { t: 'debug', op: 'safe', s: 60, mob: 1 }, 10); // 角色074 out of the way for this check
      if (mob2) j.room.handle(j.pl.conn, { t: 'debug', op: 'safe', s: 60, mob: 2 }, 10);
      return { ...j, r: j.room as unknown as { monitors: { state: string }[] } };
    };
    // control: without mob 2 it starts hunting
    const a = l2(false);
    for (let i = 0; i < ticks && a.r.monitors[0].state === 'wait'; i++) a.room.step();
    expect(a.r.monitors[0].state).not.toBe('wait');
    const { room, pl, r } = l2(true);
    for (let i = 0; i < ticks; i++) room.step();
    expect(pl.st).not.toBe(ST_DOWN);
    expect(r.monitors[0].state).toBe('wait'); // no prey: it never starts hunting
    expect(pl.safeUntil).toBeUndefined();
    room.handle(pl.conn, { t: 'debug', op: 'monitor', d: 6 }, 10);
    room.step();
    expect(r.monitors[0].state).not.toBe('wait');
  });

  it('tp out of the level area is refused: the player is snapped back where they were', () => {
    process.env.NODE_ENV = 'test';
    const { room, got, pl } = join();
    const p0 = [...pl.p];
    for (const [x, z, floor] of [[3, 4, 0], [-40, 60, 0], [-75, 80, 0], [30, 80, 1]]) {
      got.length = 0;
      room.handle(pl.conn, { t: 'debug', op: 'tp', x, z, floor }, 10);
      expect(pl.p).toEqual(p0);
      expect(got.at(-1)).toMatchObject({ t: 'correct', p: p0, forced: true });
    }
  });

  it('tp without a floor stays on the sender\'s floor (第 2 关 is on 2F, so the ground floor would be refused)', () => {
    process.env.NODE_ENV = 'test';
    const room = new RoomManager(mulberry32(3)).create(); // the real campus nav: 2F has to exist
    room.add({ id: 1, name: 'p1', send: () => {}, sendRaw: () => {} }, 0);
    const pl = room.players.get(1)!;
    room.bag = { stair_key: 1 };
    pl.p = [room.level.exit.x, room.level.exit.y, room.level.exit.z];
    for (let i = 0; i < Math.ceil(((LEVEL_FADE_S + 1) * 1000) / TICK_MS); i++) room.step();
    expect(room.levelIndex).toBe(1);
    const y0 = pl.p[1];
    expect(Math.round(y0 / FLOOR_HEIGHT)).toBe(1);
    room.handle(pl.conn, { t: 'debug', op: 'tp', x: 40, z: 83.4 }, 10);
    expect([pl.p[0], pl.p[2]]).toEqual([40, 83.4]);
    expect(pl.p[1]).toBeCloseTo(y0, 0);
    room.handle(pl.conn, { t: 'debug', op: 'tp', x: 22, z: 84.2, floor: 0 }, 10); // an explicit ground floor is out of its area
    expect([pl.p[0], pl.p[2]]).toEqual([40, 83.4]);
  });

  it('is ignored and counted as a bad message in production', () => {
    process.env.NODE_ENV = 'production';
    const { room, got, pl } = join();
    const p0 = [...pl.p];
    const state = wardenOf(room).state;
    for (const m of [{ op: 'tp', x: 3, z: 4 }, { op: 'warden' }, { op: 'down' }, { op: 'safe' }, { op: 'key', door: 1 }] as const) {
      room.handle(pl.conn, { t: 'debug', ...m } as never, 10);
    }
    expect(room.badMsgs).toBe(5);
    expect(pl.p).toEqual(p0);
    expect(pl.st).toBe(0);
    expect(wardenOf(room).state).toBe(state);
    expect(got.some((m) => m.t === 'keys' && m.keys.length > 0)).toBe(false);
  });
});

describe('puzzleFailed', () => {
  it('makes 角色074 say a fail line that is broadcast to the room', () => {
    const { room, got } = join();
    room.puzzleFailed();
    room.step();
    const lines = got.filter((m) => m.t === 'event' && m.kind === 'line');
    expect(lines).toHaveLength(1);
  });
});
