import { describe, expect, it } from 'vitest';
import { RoomManager, FINALE_CHASE_S, FINALE_RESCUE_S, LEVEL_FADE_S, REVIVE_S } from '../../server/room.ts';
import type { Conn } from '../../server/room.ts';
import { type ServerMsg, ST_DOWN, ST_OK, ST_SPECTATE } from '../../shared/protocol.ts';
import { mulberry32 } from '../../shared/rng.ts';
import { TICK_MS } from '../../shared/constants.ts';
import { boxAt, inReach } from '../../shared/interact.ts';
import type { FinaleAI } from '../../server/ai/finale.ts';

const setup = (count = 2) => {
  const room = new RoomManager(mulberry32(88)).create();
  const sent = new Map<number, ServerMsg[]>();
  const conns: Conn[] = [];
  for (let id = 1; id <= count; id++) {
    const messages: ServerMsg[] = []; sent.set(id, messages);
    const c: Conn = { id, name: `player${id}`, send: (m) => messages.push(m), sendRaw: (s) => messages.push(JSON.parse(s)) };
    room.add(c, 0); conns.push(c);
  }
  room.handle(conns[0], { t: 'debug', op: 'level', level: 7 }, 0);
  return { room, sent, conns, players: conns.map((c) => room.players.get(c.id)!) };
};
const ticks = (room: { step(): void }, seconds: number) => {
  for (let i = 0; i < Math.ceil(seconds * 1000 / TICK_MS) + 1; i++) room.step();
};
const finale = (messages: ServerMsg[]) => messages.filter((m): m is Extract<ServerMsg, { t: 'finale' }> => m.t === 'finale').at(-1)!;

describe('第 8 关 authoritative finale', () => {
  it('includes all active teammates when a room starts directly at the eighth index', () => {
    const room = new RoomManager(mulberry32(88)).create(false, 7);
    const sent: ServerMsg[] = [];
    const conns: Conn[] = [1, 2].map(id => ({ id, name: `direct${id}`, send: m => sent.push(m), sendRaw: raw => sent.push(JSON.parse(raw)) }));
    for (const conn of conns) room.add(conn, 0);
    expect(finale(sent).members.map(member => member.id)).toEqual([1, 2]);
    const book = room.level.def.finale!.rollcall;
    room.players.get(1)!.p = [book.x, 0, book.z + 1.45];
    room.handle(conns[0], { t: 'act', kind: 'rollcall', id: 1 }, 0);
    room.step();
    expect(finale(sent).phase).toBe('rollcall');
    room.handle(conns[0], { t: 'act', kind: 'rollcall', id: 2 }, 0);
    room.step();
    expect(finale(sent).phase).toBe('chase');
  });

  it('rejects remote and downed book actions; any active teammate can cross every participant off', () => {
    const { room, sent, conns, players } = setup();
    expect(room.levelIndex).toBe(7);
    expect(finale(sent.get(1)!).phase).toBe('rollcall');
    room.handle(conns[0], { t: 'act', kind: 'rollcall', id: 1 }, 0);
    expect(finale(sent.get(1)!).members[0].crossedOut).toBe(false); // too far from the book
    const book = room.level.def.finale!.rollcall;
    players[0].p = [book.x, 0, book.z];
    players[0].st = ST_DOWN;
    room.handle(conns[0], { t: 'act', kind: 'rollcall', id: 1 }, 0);
    expect(finale(sent.get(1)!).members[0].crossedOut).toBe(false);
    players[0].st = ST_OK;
    room.handle(conns[0], { t: 'act', kind: 'rollcall', id: 1 }, 0);
    room.handle(conns[0], { t: 'act', kind: 'rollcall', id: 2 }, 0);
    room.step();
    expect(finale(sent.get(1)!).phase).toBe('chase');
    expect(sent.get(1)!.some((m) => m.t === 'snap' && m.mobs.some((mob) => mob.form === 'perfect'))).toBe(true);
  });

  it('only completes when a participant reaches the safe side; escaped players are frozen and completion is replayed to late observers', () => {
    const { room, sent, conns, players } = setup(1);
    const book = room.level.def.finale!.rollcall;
    players[0].p = [book.x, 0, book.z];
    room.handle(conns[0], { t: 'act', kind: 'rollcall', id: 1 }, 0);
    room.step();
    players[0].p = [-2, 0, -8]; // inside the gate leaf, before the safe side
    room.step();
    expect(players[0].escaped).not.toBe(true); // the gate leaf itself is not the safe zone
    players[0].p = [room.level.exit.x, room.level.exit.y, room.level.exit.z];
    room.step();
    expect(players[0].escaped).toBe(true);
    room.handle(conns[0], { t: 'input', seq: 1, p: [0, 0, 0], yaw: 1, pitch: 0, f: 0 }, 100);
    expect(players[0].p).toEqual([room.level.exit.x, room.level.exit.y, room.level.exit.z]);
    expect(sent.get(1)!.some((m) => m.t === 'completed' && m.members[0].escaped)).toBe(true);
    const late: ServerMsg[] = [];
    room.add({ id: 9, name: 'observer', send: (m) => late.push(m), sendRaw: (s) => late.push(JSON.parse(s)) }, 100);
    expect(late.some((m) => m.t === 'completed')).toBe(true);
    const seed = room.seed;
    room.handle(conns[0], { t: 'restart' }, 100);
    expect(sent.get(1)!.some((m) => m.t === 'fade' && m.restart)).toBe(true);
    ticks(room, LEVEL_FADE_S + 0.1);
    expect(room.seed).toBe(seed);
    expect(room.levelIndex).toBe(7);
    expect(finale(sent.get(1)!).phase).toBe('rollcall');
    expect(finale(sent.get(1)!).downs).toBe(0);
  });

  it('uses the rescue window after one extraction, then settles downed teammates without a permanent wait', () => {
    const { room, conns, players, sent } = setup(2);
    const book = room.level.def.finale!.rollcall;
    players[0].p = [book.x, 0, book.z];
    room.handle(conns[0], { t: 'act', kind: 'rollcall', id: 1 }, 0);
    room.handle(conns[0], { t: 'act', kind: 'rollcall', id: 2 }, 0);
    room.step();
    players[0].p = [room.level.exit.x, 0, room.level.exit.z];
    room.step();
    room.handle(conns[1], { t: 'debug', op: 'down' }, 0);
    room.step();
    expect(finale(sent.get(1)!).downs).toBe(1);
    ticks(room, FINALE_RESCUE_S + 0.1);
    expect(players[1].st).toBe(ST_SPECTATE);
    expect(sent.get(1)!.some((m) => m.t === 'completed' && m.downs === 1)).toBe(true);
  });

  it('restores the same level and seed after a full wipe', () => {
    const { room, players, sent } = setup(1);
    const seed = room.seed;
    players[0].st = ST_SPECTATE;
    ticks(room, 0.2);
    expect(room.levelIndex).toBe(7);
    ticks(room, LEVEL_FADE_S + 0.2);
    expect(room.levelIndex).toBe(7);
    expect(room.seed).toBe(seed);
    expect(players[0].st).toBe(ST_OK);
    expect(finale(sent.get(1)!).phase).toBe('rollcall');
  });

  it('extracts on the safe side before a pursuer in catch range can down the player in the same tick', () => {
    const s = setup(1), book = s.room.level.def.finale!.rollcall;
    s.players[0].p = [book.x, 0, book.z + 1.45];
    s.room.handle(s.conns[0], { t: 'act', kind: 'rollcall', id: 1 }, 0);
    s.room.step();
    const exit = s.room.level.exit;
    s.players[0].p = [exit.x, exit.y, exit.z];
    const internal = s.room as unknown as { finaleAI: FinaleAI };
    internal.finaleAI.p = [exit.x + 0.1, exit.y, exit.z];
    s.room.step();
    expect(s.players[0].st).toBe(ST_OK);
    expect(s.players[0].escaped).toBe(true);
    expect(s.sent.get(1)!.some(message => message.t === 'caught')).toBe(false);
    expect(s.sent.get(1)!.find(message => message.t === 'completed')?.downs).toBe(0);
  });
});


describe('L8 multiplayer edge cases', () => {
  const crossAll = (s: ReturnType<typeof setup>) => {
    const b = s.room.level.def.finale!.rollcall;
    s.players[0].p = [b.x, 0, b.z + 1.45];
    for (const c of s.conns) s.room.handle(s.conns[0], { t: 'act', kind: 'rollcall', id: c.id }, 0);
    s.room.step();
  };
  const lateJoin = (s: ReturnType<typeof setup>, id = 3) => {
    const got: ServerMsg[] = [];
    const c: Conn = { id, name: `late${id}`, send: m => got.push(m), sendRaw: raw => got.push(JSON.parse(raw)) };
    s.room.lateObserve = true;
    s.room.add(c, 0);
    return { c, got, pl: s.room.players.get(id)! };
  };

  it('rejects forged/duplicate names and book actions through the office wall', () => {
    const s = setup(), book = s.room.level.def.finale!.rollcall;
    s.players[0].p = [book.x, 0, book.z + 1.45];
    s.room.handle(s.conns[0], { t: 'act', kind: 'rollcall', id: 9001 }, 0);
    expect(finale(s.sent.get(1)!).members.every(m => !m.crossedOut)).toBe(true);
    s.players[0].p = [book.x, 0, 128.85]; // deliberately inject an untrusted wall-side position to isolate LOS from reach
    const target = boxAt([book.x, book.y, book.z], 0.6, 1.4);
    expect(inReach(s.players[0].p, target.min, target.max)).toBe(true);
    s.room.handle(s.conns[0], { t: 'act', kind: 'rollcall', id: 1 }, 0);
    expect(finale(s.sent.get(1)!).members[0].crossedOut).toBe(false);
    s.players[0].p = [book.x, 0, book.z + 1.45];
    s.room.handle(s.conns[0], { t: 'act', kind: 'rollcall', id: 1 }, 0);
    const revision = finale(s.sent.get(1)!).revision;
    s.room.handle(s.conns[0], { t: 'act', kind: 'rollcall', id: 1 }, 0);
    expect(finale(s.sent.get(1)!).revision).toBe(revision);
    expect(finale(s.sent.get(1)!).members.filter(m => m.crossedOut)).toHaveLength(1);
  });

  it('late observers receive the live roster without blocking; a wipe recruits them into the next attempt', () => {
    const s = setup();
    crossAll(s);
    const late = lateJoin(s);
    expect(late.pl.st).toBe(ST_SPECTATE);
    expect(finale(late.got).phase).toBe('chase');
    expect(finale(late.got).members.map(m => m.id)).toEqual([1, 2]);
    late.pl.p = [s.room.level.exit.x, 0, s.room.level.exit.z];
    s.room.step();
    expect(late.pl.escaped).not.toBe(true);
    for (const p of s.players) p.st = ST_SPECTATE;
    ticks(s.room, LEVEL_FADE_S + 0.2);
    expect(late.pl.st).toBe(ST_OK);
    expect(finale(late.got).members.map(m => m.id)).toEqual([1, 2, 3]);
    expect(finale(late.got).phase).toBe('rollcall');
  });

  it('does not deadlock when all original participants disconnect while an observer remains', () => {
    const s = setup(1);
    const late = lateJoin(s, 9);
    s.room.remove(s.conns[0], 0);
    ticks(s.room, LEVEL_FADE_S + 0.2);
    expect(s.room.host).toBe(9);
    expect(late.pl.st).toBe(ST_OK);
    expect(finale(late.got).phase).toBe('rollcall');
    expect(finale(late.got).members.find(m => m.id === 9)?.crossedOut).toBe(false);
  });

  it('departed names never block the register, and host ownership moves to the remaining player', () => {
    const s = setup();
    s.room.remove(s.conns[1], 0);
    const b = s.room.level.def.finale!.rollcall;
    s.players[0].p = [b.x, 0, b.z + 1.45];
    s.room.handle(s.conns[0], { t: 'act', kind: 'rollcall', id: 1 }, 0);
    s.room.step();
    expect(finale(s.sent.get(1)!).phase).toBe('chase');
    expect(finale(s.sent.get(1)!).members[1]).toMatchObject({ id: 2, status: 'left', crossedOut: false });
  });

  it('a standing straggler cannot hold the ending forever after the first teammate escapes', () => {
    const s = setup(); crossAll(s);
    s.players[1].safeUntil = Infinity;
    s.players[0].p = [s.room.level.exit.x, 0, s.room.level.exit.z];
    s.room.step();
    expect(s.sent.get(1)!.some(m => m.t === 'completed')).toBe(false);
    expect(finale(s.sent.get(1)!).rescueMs).toBe(FINALE_RESCUE_S * 1000);
    ticks(s.room, FINALE_RESCUE_S + 0.1);
    expect(s.players[1].st).toBe(ST_SPECTATE);
    const a = s.sent.get(1)!.filter(m => m.t === 'completed').at(-1)!;
    const b = s.sent.get(2)!.filter(m => m.t === 'completed').at(-1)!;
    expect(a).toEqual(b);
    expect(a.members).toMatchObject([{ escaped: true }, { escaped: false }]);
    const late = lateJoin(s, 8);
    expect(late.got.filter(m => m.t === 'completed').at(-1)).toEqual(a);
    s.room.remove(s.conns[0], 0);
    expect(s.room.host).toBe(2);
    s.room.handle(s.conns[1], { t: 'restart' }, 0);
    ticks(s.room, LEVEL_FADE_S + 0.1);
    expect(finale(s.sent.get(2)!).phase).toBe('rollcall');
  });

  it('the unassisted chase deadline restarts the same seed instead of hanging, preserving failed-run time and down counts', () => {
    const s = setup(1); crossAll(s);
    s.players[0].safeUntil = Infinity;
    s.players[0].stamina = 0; s.players[0].exhausted = true;
    const seed = s.room.seed;
    ticks(s.room, FINALE_CHASE_S + LEVEL_FADE_S + 0.2);
    expect(s.room.seed).toBe(seed);
    expect(s.room.levelIndex).toBe(7);
    expect(finale(s.sent.get(1)!).phase).toBe('rollcall');
    expect(finale(s.sent.get(1)!).elapsedMs).toBeGreaterThan(FINALE_CHASE_S * 1000);
    expect(s.players[0].stamina).toBe(1);
    expect(s.players[0].exhausted).toBe(false);
  });

  it('ordinary hold-to-revive works during the final chase and the down count survives a wipe until explicit replay', () => {
    const s = setup(); crossAll(s);
    s.players[0].safeUntil = Infinity;
    s.room.handle(s.conns[1], { t: 'debug', op: 'down' }, 0);
    s.players[0].p = [...s.players[1].p];
    for (let i = 0; i <= REVIVE_S * 1000 / TICK_MS + 2; i++) {
      s.room.handle(s.conns[0], { t: 'act', kind: 'revive', id: 2 }, i * TICK_MS);
      s.room.step();
    }
    expect(s.players[1].st).toBe(ST_OK);
    expect(s.players[1].heldUntil).toBeUndefined();
    expect(finale(s.sent.get(1)!).downs).toBe(1);
    for (const p of s.players) p.st = ST_SPECTATE;
    ticks(s.room, LEVEL_FADE_S + 0.2);
    expect(finale(s.sent.get(1)!).downs).toBe(1);
    expect(finale(s.sent.get(1)!).members.every(m => !m.crossedOut)).toBe(true);
  });
});


describe('L8 ending deadlines and whole-run statistics', () => {
  it('carries time and downs through every implemented L1–L4 chapter into the eighth-index ending', () => {
    const s = setup(1);
    for (const level of [0, 1, 2, 3]) {
      s.room.handle(s.conns[0], { t: 'debug', op: 'level', level }, 0);
      expect(s.room.levelIndex).toBe(level);
      ticks(s.room, 2);
      s.room.handle(s.conns[0], { t: 'debug', op: 'down' }, 0);
    }
    s.room.handle(s.conns[0], { t: 'debug', op: 'level', level: 7 }, 0);
    const book = s.room.level.def.finale!.rollcall;
    s.players[0].p = [book.x, 0, book.z + 1.45];
    s.room.handle(s.conns[0], { t: 'act', kind: 'rollcall', id: 1 }, 0);
    s.room.step();
    s.players[0].p = [s.room.level.exit.x, 0, s.room.level.exit.z];
    s.room.step();
    const result = s.sent.get(1)!.filter(m => m.t === 'completed').at(-1)!;
    expect(result.elapsedMs).toBeGreaterThanOrEqual(8000);
    expect(result.downs).toBe(4);
    expect(result.members[0]).toMatchObject({ id: 1, downs: 4, escaped: true });
  });

  it('keeps the displayed full extraction window even when the first escape happens close to the chase deadline', () => {
    const s = setup(), b = s.room.level.def.finale!.rollcall;
    s.players[0].p = [b.x, 0, b.z + 1.45];
    for (const c of s.conns) s.room.handle(s.conns[0], { t: 'act', kind: 'rollcall', id: c.id }, 0);
    s.room.step();
    for (const p of s.players) p.safeUntil = Infinity;
    ticks(s.room, FINALE_CHASE_S - 10);
    s.players[0].p = [s.room.level.exit.x, 0, s.room.level.exit.z];
    s.room.step();
    expect(finale(s.sent.get(1)!).rescueMs).toBe(FINALE_RESCUE_S * 1000);
    ticks(s.room, 11);
    expect(s.players[1].st).toBe(ST_OK);
    expect(s.sent.get(1)!.some(m => m.t === 'completed')).toBe(false);
    ticks(s.room, FINALE_RESCUE_S - 11 + 0.1);
    expect(s.sent.get(1)!.some(m => m.t === 'completed')).toBe(true);
  });

  it('includes earlier chapter time and downs, while explicit replay clears the whole-run counters', () => {
    const s = setup(1);
    s.room.handle(s.conns[0], { t: 'debug', op: 'level', level: 0 }, 0);
    ticks(s.room, 10);
    s.room.handle(s.conns[0], { t: 'debug', op: 'down' }, 0);
    s.room.handle(s.conns[0], { t: 'debug', op: 'level', level: 7 }, 0);
    const b = s.room.level.def.finale!.rollcall;
    s.players[0].p = [b.x, 0, b.z + 1.45];
    s.room.handle(s.conns[0], { t: 'act', kind: 'rollcall', id: 1 }, 0);
    s.room.step();
    s.players[0].p = [s.room.level.exit.x, 0, s.room.level.exit.z];
    s.room.step();
    const result = s.sent.get(1)!.filter(m => m.t === 'completed').at(-1)!;
    expect(result.elapsedMs).toBeGreaterThanOrEqual(10000);
    expect(result.downs).toBe(1);
    expect(result.members[0].downs).toBe(1);
    s.room.handle(s.conns[0], { t: 'restart' }, 0);
    ticks(s.room, LEVEL_FADE_S + 0.1);
    expect(finale(s.sent.get(1)!).downs).toBe(0);
    expect(finale(s.sent.get(1)!).elapsedMs).toBeLessThan(500);
  });
});


it('replays an in-progress same-seed reset fade to a late joiner so their local gate and input reset too', () => {
  const s = setup(1), book = s.room.level.def.finale!.rollcall;
  s.players[0].p = [book.x, 0, book.z + 1.45];
  s.room.handle(s.conns[0], { t: 'act', kind: 'rollcall', id: 1 }, 0);
  s.room.step();
  s.players[0].st = ST_SPECTATE;
  s.room.step();
  ticks(s.room, 0.5);
  const got: ServerMsg[] = [];
  s.room.lateObserve = true;
  s.room.add({ id: 9, name: '淡出时加入', send: m => got.push(m), sendRaw: raw => got.push(JSON.parse(raw)) }, 0);
  const fade = got.find(m => m.t === 'fade');
  expect(fade).toBeDefined();
  expect(fade?.secs).toBeGreaterThan(0);
  expect(fade?.secs).toBeLessThan(LEVEL_FADE_S);
  expect(fade?.restart).toBe(true);
  ticks(s.room, LEVEL_FADE_S);
  expect(finale(got).phase).toBe('rollcall');
  expect(s.room.players.get(9)!.st).toBe(ST_OK);
});


it('retains a disconnected escaped member in the final result when only late observers remain', () => {
  const s = setup(), book = s.room.level.def.finale!.rollcall;
  s.players[0].p = [book.x, 0, book.z + 1.45];
  for (const c of s.conns) s.room.handle(s.conns[0], { t: 'act', kind: 'rollcall', id: c.id }, 0);
  s.room.step();
  s.players[0].p = [s.room.level.exit.x, 0, s.room.level.exit.z];
  s.room.step();
  const got: ServerMsg[] = [];
  s.room.lateObserve = true;
  s.room.add({ id: 9, name: '观察者', send: m => got.push(m), sendRaw: raw => got.push(JSON.parse(raw)) }, 0);
  for (const c of s.conns) s.room.remove(c, 0);
  s.room.step();
  const result = got.find(m => m.t === 'completed');
  expect(result?.members).toMatchObject([{ id: 1, escaped: true }, { id: 2, escaped: false }]);
  expect(finale(got).phase).toBe('complete');
  expect(s.room.host).toBe(9);
});

it('does not rebuild the replay roster until an explicit restart fade finishes, including a join during that fade', () => {
  const s = setup(1), book = s.room.level.def.finale!.rollcall;
  s.players[0].p = [book.x, 0, book.z + 1.45];
  s.room.handle(s.conns[0], { t: 'act', kind: 'rollcall', id: 1 }, 0);
  s.room.step();
  s.players[0].p = [s.room.level.exit.x, 0, s.room.level.exit.z];
  s.room.step();
  const seed = s.room.seed;
  s.room.handle(s.conns[0], { t: 'restart' }, 0);
  ticks(s.room, .5);
  const got: ServerMsg[] = [];
  s.room.lateObserve = true;
  s.room.add({ id: 9, name: '重玩淡出加入', send: message => got.push(message), sendRaw: raw => got.push(JSON.parse(raw)) }, 0);
  expect(got.find(message => message.t === 'fade')).toMatchObject({ restart: true });
  expect(finale(got).members).toEqual([]);
  ticks(s.room, LEVEL_FADE_S);
  expect(s.room.seed).toBe(seed);
  expect(s.room.players.get(9)!.st).toBe(ST_OK);
  expect(finale(got).phase).toBe('rollcall');
  expect(finale(got).members.map(member => member.id)).toEqual([1, 9]);
  expect(finale(got).downs).toBe(0);
});
