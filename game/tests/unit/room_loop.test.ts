import { withCampaignEndingAt } from './campaign-fixture.ts';
import { describe, expect, it, vi } from 'vitest';
import { Room, LEVEL_FADE_S, REVIVE_S } from '../../server/room.ts';
import { F_LIGHT, F_RUN, ST_DOWN, ST_OK, ST_SPECTATE, type ServerMsg, type Vec3 } from '../../shared/protocol.ts';
import { TICK_MS } from '../../shared/constants.ts';
import { inBounds } from '../../shared/level.ts';
import { L3 } from '../../shared/levels/l3.ts';
import { L4 } from '../../shared/levels/l4.ts';
import { L5 } from '../../shared/levels/l5.ts';
import { overlaps } from '../../shared/campus/collision.ts';
import { NAV_CAPSULE } from '../../shared/campus/nav.ts';

const setup = (level = 2, count = 2) => {
  const room = new Room('LOOP', 7), messages = Array.from({ length: count }, () => [] as ServerMsg[]);
  for (let i = 0; i < count; i++) room.add({ id: i + 1, name: `p${i}`, send: (m) => messages[i].push(structuredClone(m)), sendRaw: (s) => messages[i].push(JSON.parse(s)) }, 0);
  (room as any).loadLevel(level);
  messages.forEach((m) => m.splice(0));
  return { room, messages, a: room.players.get(1)!, b: room.players.get(2)! };
};
type Player = ReturnType<typeof setup>['a'];
const advance = (room: Room, s = LEVEL_FADE_S + 0.1) => { for (let i = 0; i < s * 1000 / TICK_MS; i++) room.step(); };
const move = (room: Room, p: Player, to: Vec3, c = p.c) => room.applyInput(p, { t: 'input', seq: 1, p: to, yaw: 1.2, pitch: -0.1, f: 0, c }, p.lastInput + 100);
/** Walk, via many validated 10 cm moves, through a real doorway and out again. */
const enter = (room: Room, p: Player, label: string) => {
  const d = L3.loop!.doors.filter((d) => d.label === label).at(-1)!;
  p.p = [d.x, 7.2, 84.2]; p.budget = 0.5;
  if (!room.doorOpen[d.id]) expect(room.toggleDoor(p, d.id)).toBe(true);
  for (let z = 84.1; z >= 81.99; z -= 0.1) move(room, p, [d.x, 7.2, z]);
  expect(p.p[2]).toBeLessThan(82.1);
  for (let z = 82.1; z <= 84.21; z += 0.1) move(room, p, [d.x, 7.2, z]);
};

describe('room L3 authority and lifecycle', () => {
  it('L2 normal fuse insertion and gathering loads the third floor for all players', () => {
    const { room, messages, a, b } = setup(1);
    room.bag = { fuse: 3 };
    a.p = [40, 3.6, 85];
    for (let i = 0; i < 3; i++) expect(room.act(a, 'fuse', 0)).toBe(true);
    a.stamina = 0; a.exhausted = true;
    const oldC = a.c;
    a.p = b.p = [15.5, 3.6, 84.2]; room.step(); advance(room);
    expect(room.levelIndex).toBe(2); expect(room.level.name).toBe('三楼·无尽走廊');
    for (const p of [a, b]) { expect(p.p[1]).toBeCloseTo(7.2); expect(inBounds(room.level, ...p.p)).toBe(true); expect(p.stamina).toBe(1); expect(p.exhausted).toBe(false); }
    const spawn = [...a.p];
    move(room, a, [15.5, 3.6, 84.2], oldC);
    expect(a.p).toEqual(spawn);
    move(room, a, [a.p[0] - 0.1, a.p[1], a.p[2]]);
    expect(a.p[0]).toBeCloseTo(spawn[0] - 0.1);
    expect(messages[0].filter((m) => m.t === 'loop').at(-1)).toMatchObject({ players: [{ id: 1, step: 0, loops: 0 }, { id: 2, step: 0, loops: 0 }] });
  });
  it('silently freezes in-flight fade inputs and still forces the new-level spawn once for every player', () => {
    const { room, messages, a, b } = setup(1);
    room.fusesIn = room.level.def.blackout!.fuses;
    a.p = [room.level.exit.x, room.level.exit.y, room.level.exit.z]; b.p = [...a.p];
    const frozen = [...a.p], epoch = a.c, budget = a.budget, budgetAt = a.budgetAt;
    room.step(); expect(messages[0].some((m) => m.t === 'fade')).toBe(true);
    for (let i = 1; i <= 5; i++) room.applyInput(a, { t: 'input', seq: 100 + i, p: [frozen[0] + i * 0.1, frozen[1], frozen[2]], yaw: 2, pitch: 0.3, f: F_RUN, c: epoch }, i * TICK_MS);
    expect(a.p).toEqual(frozen); expect(a.c).toBe(epoch); expect(a.lastInput).toBe(5 * TICK_MS);
    expect([a.budget, a.budgetAt]).toEqual([budget, budgetAt]);
    for (const got of messages) expect(got.filter((m) => m.t === 'correct')).toEqual([]);
    advance(room);
    expect(room.levelIndex).toBe(2); expect(a.c).toBe(epoch + 1);
    for (const [i, p] of [a, b].entries()) expect(messages[i].filter((m) => m.t === 'correct')).toEqual([{ t: 'correct', p: p.p, c: p.c, forced: true, f: p.f }]);
    const spawn = [...a.p]; move(room, a, [spawn[0] - 0.1, spawn[1], spawn[2]]);
    expect(a.p[0]).toBeCloseTo(spawn[0] - 0.1);
    expect(messages[0].filter((m) => m.t === 'correct')).toHaveLength(1);
  });
  it('real colliders permit every numbered door; merely opening it does nothing; wrong door resets only its player', () => {
    const { room, messages, a, b } = setup();
    const d = L3.loop!.doors[5]; a.p = [d.x, 7.2, 84.2]; room.toggleDoor(a, d.id);
    expect(a.loop.step).toBe(0);
    enter(room, a, '303'); expect(a.loop.step).toBe(1);
    enter(room, a, '302'); expect(a.loop).toMatchObject({ step: 0, mistakes: 1 });
    for (const label of L3.loop!.sequence) enter(room, a, label);
    expect(a.loop.step).toBe(4); expect(b.loop.step).toBe(0);
    expect(messages[0].filter((m) => m.t === 'correct')).toEqual([]);
    expect(messages[1].filter((m) => m.t === 'loop').at(-1)).toMatchObject({ players: [{ id: 1, step: 4 }, { id: 2, step: 0 }] });
  });
  it('seam broadcasts a translation, drops stale and epochless inputs, then accepts walking with no correction', () => {
    const { room, messages, a, b } = setup();
    a.p = [19.6, 7.2, 84.2]; const oldC = a.c, bp = [...b.p];
    const control = setup(); control.a.p = [30, 7.2, 84.2];
    move(control.room, control.a, [29.8, 7.2, 84.2]);
    move(room, a, [19.4, 7.2, 84.2]);
    expect(a.p).toEqual([55.4, 7.2, 84.2]); expect(a.c).toBe(oldC + 1);
    expect(a.loop.loops).toBe(1); expect(a.yaw).toBe(1.2); expect(b.p).toEqual(bp);
    expect(a.budget).toBeCloseTo(control.a.budget);
    const budget = a.budget, budgetAt = a.budgetAt, lastInput = a.lastInput;
    expect(messages[1].find((m) => m.t === 'warp')).toMatchObject({ id: 1, p: [55.4, 7.2, 84.2], c: a.c });
    move(room, a, [19.2, 7.2, 84.2], oldC);
    room.applyInput(a, { t: 'input', seq: 3, p: [19, 7.2, 84.2], yaw: 1.2, pitch: 0, f: 0 }, a.lastInput + 100);
    expect(a.p).toEqual([55.4, 7.2, 84.2]);
    expect([a.budget, a.budgetAt, a.lastInput]).toEqual([budget, budgetAt, lastInput]);
    for (let x = 55.3; x > 53; x -= 0.1) move(room, a, [x, 7.2, 84.2]);
    expect(a.p[0]).toBeLessThan(53.2); expect(a.loop.loops).toBe(1);
    expect(messages[0].filter((m) => m.t === 'correct')).toEqual([]);
    const p = { x: a.p[0], y: a.p[1], z: a.p[2], vy: 0, grounded: true };
    expect(overlaps(room.world, p, NAV_CAPSULE)).toBe(false);
  });
  it('four players can warp in the same tick with individual epochs, despite delayed old-epoch packets', () => {
    const { room, messages } = setup(2, 4);
    const players = [...room.players.values()], order = [3, 0, 2, 1];
    players[0].p = [19.6, 7.2, 84.2];
    const firstEpoch = players[0].c;
    move(room, players[0], [19.4, 7.2, 84.2]);
    const epochs = players.map((p) => p.c), tick = room.tick;
    messages.forEach((m) => m.splice(0));
    for (const [i, p] of players.entries()) { p.p = [19.6, 7.2, 84.2 + i * 0.1]; p.budget = 0.5; }
    for (const i of order) {
      const p = players[i];
      room.applyInput(p, { t: 'input', seq: 10, p: [19.4, 7.2, p.p[2]], yaw: i, pitch: 0, f: 0, c: epochs[i] }, 200);
    }
    expect(room.tick).toBe(tick);
    const expectedWarps = order.map((i) => ({ t: 'warp', id: i + 1, p: [55.4, 7.2, 84.2 + i * 0.1], c: epochs[i] + 1, yaw: i }));
    for (const got of messages) expect(got.filter((m) => m.t === 'warp')).toEqual(expectedWarps);
    for (const p of players) room.applyInput(p, { t: 'input', seq: 11, p: [55.3, 7.2, p.p[2]], yaw: 0, pitch: 0, f: 0, c: p.c }, 300);
    const state = () => players.map((p) => ({ p: [...p.p], c: p.c, loop: { ...p.loop }, budget: p.budget, budgetAt: p.budgetAt, lastInput: p.lastInput }));
    const afterFreshInput = state();
    for (const i of [2, 0, 3, 1]) {
      const p = players[i];
      room.applyInput(p, { t: 'input', seq: 1000, p: [19.2, 7.2, p.p[2]], yaw: 1, pitch: 0.1, f: F_RUN, c: epochs[i] }, 400);
      room.applyInput(p, { t: 'input', seq: 9, p: [19.1, 7.2, p.p[2]], yaw: 1, pitch: 0.1, f: F_RUN }, 500);
    }
    room.applyInput(players[0], { t: 'input', seq: 1001, p: [19, 7.2, 84.2], yaw: 1, pitch: 0, f: F_RUN, c: firstEpoch }, 550);
    expect(state()).toEqual(afterFreshInput);
    for (const p of players) room.applyInput(p, { t: 'input', seq: 12, p: [55.2, 7.2, p.p[2]], yaw: 0, pitch: 0, f: 0, c: p.c }, 600);
    expect(players.map((p) => p.p[0])).toEqual([55.2, 55.2, 55.2, 55.2]);
    const progress = players.map((p, i) => ({ id: i + 1, step: 0, loops: i === 0 ? 2 : 1, mistakes: 0 }));
    for (const got of messages) {
      expect(got.filter((m) => m.t === 'loop').at(-1)).toEqual({ t: 'loop', players: progress });
      expect(got.filter((m) => m.t === 'correct')).toEqual([]);
      expect(got.filter((m) => m.t === 'warp')).toHaveLength(4);
    }
  });
  it('a warp cancels a revive and checks queued source interactions against the authoritative destination', () => {
    const { room, messages, a, b } = setup();
    a.p = [19.6, 7.2, 84.2]; b.p = [18.4, 7.2, 84.2]; b.st = ST_DOWN;
    room.items = [{ id: 91, kind: 'battery', p: [...a.p] }, { id: 92, kind: 'battery', p: [55.4, 7.2, 84.2] }];
    expect(room.act(a, 'revive', b.conn.id)).toBe(true);
    expect(a.reviving?.id).toBe(b.conn.id);
    const epoch = a.c;
    room.applyInput(a, { t: 'input', seq: 1, p: [19.4, 7.2, 84.2], yaw: 0, pitch: 0, f: 0, c: epoch }, 100);
    expect(a.p).toEqual([55.4, 7.2, 84.2]); expect(a.reviving).toBeUndefined();
    const afterWarp = { p: [...a.p], c: a.c, budget: a.budget, budgetAt: a.budgetAt, lastInput: a.lastInput, loop: { ...a.loop } };
    room.applyInput(a, { t: 'input', seq: 2, p: [19.3, 7.2, 84.2], yaw: 1, pitch: 0.1, f: F_RUN, c: epoch }, 100);
    room.handle(a.conn, { t: 'act', kind: 'pick', id: 91 }, 100);
    room.handle(a.conn, { t: 'act', kind: 'revive', id: b.conn.id }, 100);
    expect({ p: a.p, c: a.c, budget: a.budget, budgetAt: a.budgetAt, lastInput: a.lastInput, loop: a.loop }).toEqual(afterWarp);
    expect(a.reviving).toBeUndefined(); expect(a.f).toBe(0); expect(room.bag).toEqual({});
    expect(room.items.map((item) => item.id)).toEqual([91, 92]);
    room.applyInput(a, { t: 'input', seq: 3, p: [55.3, 7.2, 84.2], yaw: 1, pitch: 0.1, f: 0, c: a.c }, 100);
    room.handle(a.conn, { t: 'act', kind: 'pick', id: 92 }, 100);
    expect(a.p).toEqual([55.3, 7.2, 84.2]); expect(room.bag).toEqual({ battery: 1 });
    expect(room.items.map((item) => item.id)).toEqual([91]); expect(b.st).toBe(ST_DOWN);
    for (const got of messages) { expect(got.filter((m) => m.t === 'warp')).toHaveLength(1); expect(got.filter((m) => m.t === 'correct')).toEqual([]); }
  });
  it('speed/wall/area checks still reject invalid claims and never grant puzzle progress', () => {
    const { room, messages, a } = setup();
    for (const p of [[43.1725, 7.2, 82], [1, 7.2, 84.2], [55.2, 20, 84.2]] as Vec3[]) move(room, a, p);
    expect(a.loop).toMatchObject({ step: 0, loops: 0 });
    expect(messages[0].filter((m) => m.t === 'correct' && !m.forced)).toHaveLength(3);
  });
  it('unsolved players loop independently; solved ones can wait at the exit; completion requires both', () => {
    const { room, messages, a, b } = setup();
    for (const n of L3.loop!.sequence) enter(room, a, n);
    a.p = [19.6, 7.2, 84.2]; move(room, a, [19.4, 7.2, 84.2]); expect(a.p[0]).toBe(19.4);
    a.p = [17.5, 7.2, 84.2]; b.p = [19.6, 7.2, 84.2]; move(room, b, [19.4, 7.2, 84.2]);
    expect(b.loop.loops).toBe(1); expect(a.loop.loops).toBe(0);
    room.step(); expect(messages[0].some((m) => m.t === 'fade')).toBe(false);
    for (const n of L3.loop!.sequence) enter(room, b, n);
    b.p = [17.5, 7.2, 84.2]; room.step(); advance(room);
    expect(room.completed).toBe(false); expect(room.levelIndex).toBe(3); expect(room.level.def).toBe(L4);
    expect(messages[1].filter((m) => m.t === 'complete')).toEqual([]);
    expect(messages[1].filter((m) => m.t === 'room').at(-1)).toMatchObject({ level: 3 });
    expect(messages[1].filter((m) => m.t === 'broadcast').at(-1)).toMatchObject({ off: false, clues: [null, null, null, null] });
    for (const p of [a, b]) { expect(p.loop.step).toBe(0); expect(inBounds(room.level, ...p.p)).toBe(true); }
  });
  it('four interleaved personal sequences require every survivor to solve and the last teammate to reach the exit', () => {
    const { room, messages } = setup(2, 4);
    const players = [...room.players.values()], sequence = L3.loop!.sequence;
    for (let step = 0; step < sequence.length; step++) {
      for (const [i, p] of players.entries()) if (step < sequence.length - i) enter(room, p, sequence[step]);
    }
    enter(room, players[3], '304');
    const progress = players.map((p, i) => ({ id: i + 1, step: [4, 3, 2, 0][i], loops: 0, mistakes: i === 3 ? 1 : 0 }));
    for (const got of messages) expect(got.filter((m) => m.t === 'loop').at(-1)).toEqual({ t: 'loop', players: progress });
    for (const p of players) p.p = [L3.exit.x, L3.exit.y, L3.exit.z];
    room.step();
    for (const got of messages) expect(got.some((m) => m.t === 'fade')).toBe(false);
    for (const [i, p] of players.entries()) for (const label of sequence.slice(progress[i].step)) enter(room, p, label);
    for (const p of players.slice(0, 3)) p.p = [L3.exit.x, L3.exit.y, L3.exit.z];
    const last = players[3];
    last.p = [L3.exit.x + L3.exit.r + 0.1, L3.exit.y, L3.exit.z];
    room.step();
    expect(players.map((p) => p.loop.step)).toEqual([4, 4, 4, 4]);
    for (const got of messages) expect(got.some((m) => m.t === 'fade')).toBe(false);
    move(room, last, [last.p[0] - 0.2, last.p[1], last.p[2]]);
    room.step(); advance(room); advance(room);
    expect(room.completed).toBe(false); expect(room.levelIndex).toBe(3);
    for (const [i, got] of messages.entries()) {
      expect(got.filter((m) => m.t === 'fade')).toEqual([{ t: 'fade', secs: LEVEL_FADE_S, restart: false }]);
      expect(got.filter((m) => m.t === 'complete')).toEqual([]);
      expect(got.filter((m) => m.t === 'correct')).toEqual([{ t: 'correct', p: players[i].p, c: players[i].c, forced: true, f: players[i].f }]);
      expect(got.filter((m) => m.t === 'broadcast').at(-1)).toMatchObject({ off: false, clues: [null, null, null, null] });
    }
  });
  it('downed/spectating players cannot progress; late join receives full state; wipe resets personal progress', () => {
    const { room, messages, a, b } = setup();
    enter(room, a, '303'); a.st = ST_DOWN;
    const before = a.loop.step; move(room, a, [33.95, 7.2, 82]); expect(a.loop.step).toBe(before);
    room.lateObserve = true;
    const got: ServerMsg[] = [];
    room.add({ id: 3, name: 'observer', send: (m) => got.push(m), sendRaw: (s) => got.push(JSON.parse(s)) }, 1000);
    const c = room.players.get(3)!; expect(c.st).toBe(ST_SPECTATE);
    expect(got.find((m) => m.t === 'loop')).toMatchObject({ players: [{ id: 1, step: 1 }, { id: 2, step: 0 }, { id: 3, step: 0 }] });
    expect(messages[0].filter((m) => m.t === 'loop').at(-1)).toMatchObject({ players: [{ id: 1, step: 1 }, { id: 2, step: 0 }, { id: 3, step: 0 }] });
    const spectatorPos = [...c.p]; move(room, c, [c.p[0] - 0.1, c.p[1], c.p[2]]);
    expect(c.p).toEqual(spectatorPos); expect(c.loop.step).toBe(0);
    room.remove(c.conn, 1100);
    expect(messages[0].filter((m) => m.t === 'loop').at(-1)).toMatchObject({ players: [{ id: 1, step: 1 }, { id: 2, step: 0 }] });
    expect((messages[0].filter((m) => m.t === 'loop').at(-1) as Extract<ServerMsg, { t: 'loop' }>).players).toHaveLength(2);
    room.add(c.conn, 1200); expect(room.players.get(3)!.st).toBe(ST_SPECTATE);
    a.stamina = 0; a.exhausted = true;
    a.st = b.st = ST_SPECTATE; room.step(); advance(room);
    expect(room.levelIndex).toBe(2);
    for (const p of room.players.values()) { expect(p.st).toBe(ST_OK); expect(p.loop).toMatchObject({ step: 0, loops: 0, mistakes: 0 }); expect(p.stamina).toBe(1); expect(p.exhausted).toBe(false); }
  });
  it('leaving 301 through its west door and looking around behind the seam never returns a player to spawn', () => {
    const { room, messages, a } = setup();
    enter(room, a, '303'); enter(room, a, '301');
    const west = L3.loop!.doors[0];
    a.p = [west.x, west.y, 82]; a.budget = 0.5;
    expect(room.toggleDoor(a, west.id)).toBe(true);
    for (let z = 82.05; z <= 84.21; z += 0.05) move(room, a, [west.x, west.y, z]);
    expect(a.loop).toMatchObject({ step: 2, loops: 0 });
    expect(a.p[0]).toBe(west.x); expect(a.p[2]).toBeCloseTo(84.2);
    const at = [...a.p] as Vec3;
    for (const yaw of [0, Math.PI / 2, Math.PI]) room.applyInput(a, { t: 'input', seq: 2, p: [...at], yaw, pitch: .2, f: 0, c: a.c }, a.lastInput + 100);
    expect(a.p).toEqual(at);
    expect(messages[0].filter((m) => m.t === 'warp' || m.t === 'correct')).toEqual([]);
    // Walking east through the line is also safe. Only actually crossing westward should loop.
    for (let x = west.x + 0.1; x <= 20.21; x += 0.1) move(room, a, [x, west.y, at[2]]);
    expect(a.loop.loops).toBe(0);
    for (let x = 20.1; x >= 19.39 && a.loop.loops === 0; x -= 0.1) move(room, a, [x, west.y, at[2]]);
    expect(a.loop).toMatchObject({ step: 2, loops: 1 });
    expect(a.p[0]).toBeGreaterThan(55);
    expect(messages[0].filter((m) => m.t === 'warp')).toHaveLength(1);
    expect(messages[0].filter((m) => m.t === 'correct')).toEqual([]);
  });
  it('partial real entry has no public progress, retreat cancels it, and opening from inside cannot count', () => {
    const { room, messages, a } = setup();
    const d = L3.loop!.doors[5]; a.p = [d.x, d.y, 83.2]; a.budget = 0.5;
    expect(room.toggleDoor(a, d.id)).toBe(true);
    for (let z = 83.1; z >= 82.39; z -= 0.1) move(room, a, [d.x, d.y, z]);
    expect(a.loop).toMatchObject({ step: 0, entering: d.id });
    expect(messages[0].filter((m) => m.t === 'loop')).toEqual([]);
    for (let z = 82.5; z <= 83.21; z += 0.1) move(room, a, [d.x, d.y, z]);
    expect(a.loop).toMatchObject({ step: 0, mistakes: 0, entering: undefined });
    a.p = [d.x, d.y, 82.4];
    move(room, a, [d.x, d.y, 82.2]);
    expect(a.loop.step).toBe(0);
    enter(room, a, '303'); expect(a.loop.step).toBe(1);
    const publicState = messages[0].filter((m) => m.t === 'loop').at(-1) as Extract<ServerMsg, { t: 'loop' }>;
    expect(publicState.players[0]).toEqual({ id: 1, step: 1, loops: 0, mistakes: 0 });
    expect(messages[0].filter((m) => m.t === 'correct')).toEqual([]);
  });
  it('being caught and revived preserves only earned progress and clears an unfinished doorway crossing', () => {
    const { room, messages, a, b } = setup();
    enter(room, a, '303');
    const d = L3.loop!.doors[1]; a.p = [d.x, d.y, 83.2];
    expect(room.toggleDoor(a, d.id)).toBe(true);
    for (let z = 83.1; z >= 82.39; z -= 0.1) move(room, a, [d.x, d.y, z]);
    expect(a.loop).toMatchObject({ step: 1, entering: d.id });
    const caughtAt = [...a.p] as Vec3, source: Vec3 = [a.p[0], a.p[1], a.p[2] + 0.6];
    (room as any).punish(a, 'warden', source);
    expect(messages[0].find((m) => m.t === 'caught')).toMatchObject({ id: 1, by: 'warden', at: caughtAt, source });
    expect(a.st).toBe(ST_DOWN); expect(a.loop).toMatchObject({ step: 1, armed: true, entering: undefined });
    const spawn = [...a.p];
    move(room, a, [a.p[0] - 0.1, a.p[1], a.p[2]]);
    expect(a.p).toEqual(spawn); expect(a.loop.step).toBe(1);
    b.p = [a.p[0] - 1.2, a.p[1], a.p[2]];
    for (let i = 0; i < Math.ceil(REVIVE_S * 1000 / TICK_MS) + 1; i++) { room.act(b, 'revive', 1); room.step(); }
    expect(a.st).toBe(ST_OK); expect(a.heldUntil).toBeUndefined(); expect(a.loop.step).toBe(1);
    enter(room, a, '301'); expect(a.loop.step).toBe(2); expect(b.loop.step).toBe(0);
    expect(messages[0].filter((m) => m.t === 'correct' && !m.forced)).toEqual([]);
  });
  it('all downed players end the attempt immediately, then everyone and every personal state restart together', () => {
    const { room, messages, a, b } = setup();
    enter(room, a, '303'); enter(room, b, '302');
    const contacts = [[...a.p], [...b.p]];
    a.st = b.st = ST_DOWN; a.heldUntil = b.heldUntil = room.tick + 600;
    room.step();
    expect([a.st, b.st]).toEqual([ST_SPECTATE, ST_SPECTATE]);
    expect([a.heldUntil, b.heldUntil]).toEqual([undefined, undefined]);
    expect([a.p, b.p]).toEqual(contacts);
    for (const got of messages) expect(got.filter((m) => m.t === 'fade')).toEqual([{ t: 'fade', secs: LEVEL_FADE_S, restart: true }]);
    room.step();
    for (const got of messages) expect(got.filter((m) => m.t === 'fade')).toHaveLength(1);
    const epochs = [a.c, b.c];
    advance(room);
    expect(room.completed).toBe(false); expect(room.levelIndex).toBe(2);
    for (const [i, p] of [a, b].entries()) { expect(p.st).toBe(ST_OK); expect(p.loop).toEqual({ step: 0, loops: 0, mistakes: 0, armed: true }); expect(p.c).toBeGreaterThan(epochs[i]); }
    expect(messages[0].filter((m) => m.t === 'complete')).toEqual([]);
  });
  it('a player joining during a restart fade receives its remaining time and joins the same fresh attempt', () => {
    const { room, messages, a, b } = setup();
    room.lateObserve = true;
    enter(room, a, '303');
    a.st = b.st = ST_SPECTATE;
    room.step(); advance(room, 0.5);
    const joined: ServerMsg[] = [];
    room.add({ id: 3, name: 'restart observer', send: (m) => joined.push(structuredClone(m)), sendRaw: (s) => joined.push(JSON.parse(s)) }, 500);
    const c = room.players.get(3)!;
    expect(c.st).toBe(ST_SPECTATE);
    expect(joined.filter((m) => m.t === 'fade')).toEqual([{ t: 'fade', secs: LEVEL_FADE_S - 0.5, restart: true }]);
    expect(joined.find((m) => m.t === 'loop')).toMatchObject({ players: [{ id: 1, step: 1 }, { id: 2, step: 0 }, { id: 3, step: 0 }] });
    const at = [...c.p]; move(room, c, [c.p[0] - 0.1, c.p[1], c.p[2]]);
    expect(c.p).toEqual(at); expect(c.c).toBe(0); expect(joined.some((m) => m.t === 'correct')).toBe(false);
    advance(room);
    expect(room.completed).toBe(false); expect(room.levelIndex).toBe(2);
    for (const p of [a, b, c]) { expect(p.st).toBe(ST_OK); expect(p.loop).toEqual({ step: 0, loops: 0, mistakes: 0, armed: true }); expect(inBounds(room.level, ...p.p)).toBe(true); }
    expect(joined.filter((m) => m.t === 'correct')).toEqual([{ t: 'correct', p: c.p, c: 1, forced: true, f: c.f }]);
    expect(joined.filter((m) => m.t === 'loop').at(-1)).toEqual({ t: 'loop', players: [1, 2, 3].map((id) => ({ id, step: 0, loops: 0, mistakes: 0 })) });
    for (const got of [...messages, joined]) expect(got.some((m) => m.t === 'complete')).toBe(false);
    move(room, c, [c.p[0] - 0.1, c.p[1], c.p[2]]); expect(c.p[0]).toBeCloseTo(at[0] - 0.1);
  });
  it('a disconnected unsolved teammate no longer blocks the remaining solved player from finishing', () => {
    const { room, messages, a, b } = setup();
    for (const n of L3.loop!.sequence) enter(room, a, n);
    a.p = [17.5, 7.2, 84.2]; room.step();
    expect(messages[0].some((m) => m.t === 'fade')).toBe(false);
    room.remove(b.conn, 10_000); room.step(); advance(room);
    expect(room.completed).toBe(false); expect(room.players.size).toBe(1); expect(room.levelIndex).toBe(3);
    expect(messages[0].filter((m) => m.t === 'complete')).toEqual([]);
    expect(messages[0].filter((m) => m.t === 'room').at(-1)).toMatchObject({ level: 3 });
  });
  it('a solved survivor advances with a downed teammate; chapter fades and a campaign ending at L5 freeze actions', () => {
    withCampaignEndingAt(4, () => {
      const { room, messages, a, b } = setup();
      room.lateObserve = true;
      for (const n of L3.loop!.sequence) enter(room, a, n);
      b.st = ST_DOWN; b.heldUntil = room.tick + 1000;
      a.p = [17.5, 7.2, 84.2]; a.battery = a.stamina = 0.5; a.f = F_LIGHT | F_RUN;
      room.bag = { battery: 2 };
      room.items = [{ id: 99, kind: 'battery', p: [...a.p] }];
      const mobStep = vi.fn();
      (room as any).warden = { step: mobStep, takeLines: () => [], caught: [] };
      room.step();
      expect(messages[0].filter((m) => m.t === 'fade')).toEqual([{ t: 'fade', secs: LEVEL_FADE_S, restart: false }]);
      const at = [...a.p], door = L3.loop!.doors[0], oldDoor = room.doorOpen[door.id];
      const fadeEpoch = a.c;
      for (let i = 0; i < 5; i++) move(room, a, [at[0] - 0.1 * (i + 1), at[1], at[2]], fadeEpoch);
      expect(a.p).toEqual(at); expect(a.c).toBe(fadeEpoch); expect(messages[0].filter((m) => m.t === 'correct')).toEqual([]);
      for (const m of [{ t: 'use', item: 'battery' }, { t: 'act', kind: 'pick', id: 99 }, { t: 'door', id: door.id }, { t: 'debug', op: 'tp', x: 40, z: 84.2 }] as const) room.handle(a.conn, m, 10_000);
      expect(room.act(a, 'pick', 99)).toBe(false); expect(room.toggleDoor(a, door.id)).toBe(false);
      expect(a.p).toEqual(at); expect(a.battery).toBe(0.5); expect(a.stamina).toBe(0.5); expect(room.bag).toEqual({ battery: 2 }); expect(room.items).toHaveLength(1); expect(room.doorOpen[door.id]).toBe(oldDoor);
      advance(room, 0.5);
      const joined: ServerMsg[] = [];
      room.add({ id: 3, name: 'observer', send: (m) => joined.push(structuredClone(m)), sendRaw: (s) => joined.push(JSON.parse(s)) }, 10_500);
      expect(room.players.get(3)!.st).toBe(ST_SPECTATE);
      expect(joined.find((m) => m.t === 'fade')).toEqual({ t: 'fade', secs: LEVEL_FADE_S - 0.5, restart: false });
      expect(joined.find((m) => m.t === 'loop')).toMatchObject({ players: [{ id: 1, step: 4 }, { id: 2, step: 0 }, { id: 3, step: 0 }] });
      expect(mobStep).not.toHaveBeenCalled();
      (room as any).warden = undefined;
      for (const p of room.players.values()) p.f = 0;
      advance(room);
      expect(room.completed).toBe(false); expect(room.levelIndex).toBe(3);
      expect(messages[0].filter((m) => m.t === 'complete')).toEqual([]);
      for (const p of room.players.values()) { expect(p.st).toBe(ST_OK); expect(p.battery).toBe(1); expect(p.loop.step).toBe(0); }
      // This player has loaded L4 before interacting with its station.
      room.handle(a.conn, { t: 'ready', incarnation: room.incarnation }, room.tick * TICK_MS);
      // Complete L4 through its real server handlers, then verify its genuine L5 successor.
      const station = room.broadcastStation!, broadcast = L4.broadcast!;
      broadcast.stickers.forEach((s, id) => { a.p = [s.x, s.y, s.z]; room.handle(a.conn, { t: 'broadcast', op: 'read', id }, 11_000); });
      a.p = [broadcast.console.x, broadcast.console.y, broadcast.console.z];
      room.handle(a.conn, { t: 'broadcast', op: 'code', code: station.clues.join('') }, 11_100);
      expect(station.off).toBe(true);
      for (const p of room.players.values()) p.p = [L4.exit.x, L4.exit.y, L4.exit.z];
      room.step(); advance(room);
      expect(room.completed).toBe(false); expect(room.levelIndex).toBe(4); expect(room.level.def).toBe(L5);
      expect(messages[0].filter((m) => m.t === 'complete')).toEqual([]);
      expect(room.gym!.switches.complete).toBe(false);
      room.handle(a.conn, { t: 'ready', incarnation: room.incarnation }, room.tick * TICK_MS);
      for (let id = 0; id < 4; id++) {
        const s = L5.gym!.switches[id]; a.p = [s.x, s.y, s.z + 0.6];
        room.handle(a.conn, { t: 'act', kind: 'gym-switch', id }, 15_000);
      }
      expect(room.gym!.switches.complete).toBe(true);
      for (const p of room.players.values()) p.p = [L5.exit.x, L5.exit.y, L5.exit.z];
      room.step(); advance(room);
      expect(room.completed).toBe(true); expect(room.levelIndex).toBe(4);
      const frozen = [...a.p], oldC = a.c;
      move(room, a, [a.p[0] + 0.1, a.p[1], a.p[2]]);
      room.handle(a.conn, { t: 'use', item: 'battery' }, 20_000);
      expect(a.p).toEqual(frozen); expect(a.c).toBe(oldC); expect(a.battery).toBe(1); expect(a.stamina).toBe(1);
      const completeJoin: ServerMsg[] = [];
      room.add({ id: 4, name: 'finished observer', send: (m) => completeJoin.push(structuredClone(m)), sendRaw: (s) => completeJoin.push(JSON.parse(s)) }, 20_001);
      expect(completeJoin.filter((m) => m.t === 'complete')).toEqual([{ t: 'complete', level: 4 }]);
      expect(completeJoin.some((m) => m.t === 'fade')).toBe(false);
      advance(room); expect(messages[0].filter((m) => m.t === 'complete')).toHaveLength(1);
    });
  });
});
