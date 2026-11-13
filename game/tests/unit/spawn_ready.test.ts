import { describe, expect, it } from 'vitest';
import { LEVEL_FADE_S, RoomManager, type Conn } from '../../server/room.ts';
import { createSpawnReady, isSpawnProtected, markSpawnReady, type SpawnReadyState } from '../../server/spawn-ready.ts';
import { TICK_MS } from '../../shared/constants.ts';
import { parseClientMsg, ST_DOWN, ST_OK, ST_SPECTATE, type ClientMsg, type ServerMsg, type Vec3 } from '../../shared/protocol.ts';
import { mulberry32 } from '../../shared/rng.ts';
import { NavGraph } from '../../shared/campus/nav.ts';
import type { WardenEnv, WardenTarget } from '../../server/ai/warden.ts';
import type { TensionDirector } from '../../server/ai/tensionDirector.ts';
import { campusNavCached } from '../../client/src/campus/world/navcache.ts';
import { inZone, ZONE_OUT_ELIM_S } from '../../shared/royale.ts';

const SECOND = 1000 / TICK_MS;
const run = (room: { step(): void }, seconds: number) => {
  for (let i = 0; i < Math.ceil(seconds * SECOND); i++) room.step();
};

function setup(count = 1, skipIntro = true, mode: 'campaign' | 'royale' = 'campaign') {
  // Product rooms enter through the lobby. Legacy already-started unit rooms intentionally keep their old timing.
  const nav = mode === 'royale' ? () => campusNavCached('.cache/campus-nav.json').graph : undefined;
  const room = new RoomManager(mulberry32(537), nav).create(true, 0, 'standard', { mode });
  const got: ServerMsg[][] = [];
  const mk = (id: number): Conn => {
    const messages: ServerMsg[] = []; got[id - 1] = messages;
    return { id, name: `p${id}`, send: (m) => messages.push(structuredClone(m)), sendRaw: (s) => messages.push(JSON.parse(s)) };
  };
  const conns = Array.from({ length: count }, (_, i) => mk(i + 1));
  for (const conn of conns) room.add(conn, 0);
  room.handle(conns[0], { t: 'start' }, 0);
  const finishIntro = () => {
    const intro = got[0].findLast((m) => m.t === 'event' && m.kind === 'intro');
    if (intro?.t === 'event' && intro.kind === 'intro') {
      for (const conn of conns) room.handle(conn, { t: 'intro-skip', id: intro.id }, 0);
    }
  };
  if (skipIntro) finishIntro(); // readiness tests measure gameplay time; intro freezing is covered in intro_room
  const player = (id = 1) => room.players.get(id)!;
  const spawns = new Map(conns.map(conn => [conn.id, [...player(conn.id).p] as Vec3]));
  const ready = (id = 1) => (player(id) as unknown as { spawnReady: SpawnReadyState }).spawnReady;
  let sequence = 0;
  const input = (id = 1, extra: Partial<Extract<ClientMsg, { t: 'input' }>> = {}) => {
    const p = player(id);
    room.handle(p.conn, { t: 'input', seq: ++sequence, p: [...p.p], yaw: p.yaw, pitch: p.pitch, f: 0, c: p.c, ...extra }, room.tick * TICK_MS);
  };
  return { room, got, conns, mk, player, ready, input, finishIntro, spawns };
}

function setupWithRescuer(targetCount = 1) {
  const t = setup(targetCount + 1), id = targetCount + 1;
  // Readiness / capture boundaries need a real standing teammate so the victim's down state can
  // persist. The helper is loaded and protected, and never offered to either enemy as extra prey.
  t.room.handle(t.conns[id - 1], { t: 'ready', incarnation: t.room.incarnation }, 0);
  t.player(id).safeUntil = 100_000;
  return t;
}

const expectedCaught = (t: ReturnType<typeof setup>, id: number, by: 'warden' | 'monitor'): Extract<ServerMsg, { t: 'caught' }> => {
  const snap = t.got[id - 1].findLast((m) => m.t === 'snap');
  if (snap?.t !== 'snap') throw new Error('Expected capture snapshot');
  return { t: 'caught', id, seq: 1, tick: snap.tick, hold: 30, by, at: t.spawns.get(id)!, source: t.spawns.get(1)!,
    ...(by === 'monitor' ? { mob: 2, name: '值周生' } : {}) };
};

function installCatcher(t: ReturnType<typeof setup>, kind: 'warden' | 'monitor', id = 1, caught = [id]) {
  const offered: number[][] = [];
  const mob = {
    p: [...t.player(id).p] as Vec3, yaw: 0, anim: 'patrol', state: 'patrol', target: id,
    caught, blinked: false,
    // Deliberately retain an old target, even when it is absent from prey: the final catch gate must also protect it.
    step: (_dt: number, prey: readonly { id: number }[]) => offered.push(prey.map((p) => p.id)),
    takeLines: () => [], forget: () => {},
  };
  const internals = t.room as unknown as { warden?: typeof mob; monitors: (typeof mob)[];
    wardenEnv?: WardenEnv; tension: TensionDirector; sightingFinished: boolean };
  if (kind === 'warden') {
    internals.warden = mob;
    // This constructor-free AI stub now also needs the search environment. Keep the real room prey / catch
    // gates, while the unrelated encounter director forwards every already-eligible player to the stub.
    internals.wardenEnv = { graph: new NavGraph(), rng: () => .5, los: () => false };
    internals.sightingFinished = true;
    internals.tension.plan = (_now: number, prey: readonly WardenTarget[]) => ({ prey: [...prey] });
    internals.tension.observe = () => {};
  }
  else internals.monitors = [mob];
  return offered;
}

describe('one-shot spawn readiness', () => {
  it('waits for its own incarnation, then grants at least ten seconds exactly once', () => {
    const state = createSpawnReady(7);
    expect(isSpawnProtected(state, 12 * SECOND)).toBe(true);
    expect(markSpawnReady(state, 6, 12 * SECOND)).toBe(false);
    expect(markSpawnReady(state, 8, 12 * SECOND)).toBe(false);
    expect(state.readyAtTick).toBeUndefined();
    expect(markSpawnReady(state, 7, 12 * SECOND)).toBe(true);
    expect(state.readyAtTick).toBe(12 * SECOND);
    const until = state.protectedUntilTick!;
    expect(until - state.readyAtTick!).toBeGreaterThanOrEqual(10 * SECOND);
    expect(isSpawnProtected(state, until - 1)).toBe(true);
    expect(markSpawnReady(state, 7, until - 1)).toBe(false);
    expect(state.protectedUntilTick).toBe(until);
    expect(isSpawnProtected(state, until)).toBe(false);
  });

  it('accepts only a positive safe-integer readiness incarnation and discards client authority claims', () => {
    for (const incarnation of [0, -1, 1.5, '7', null, Number.MAX_SAFE_INTEGER + 1]) {
      expect(parseClientMsg(JSON.stringify({ t: 'ready', incarnation }))).toBeNull();
    }
    expect(parseClientMsg('{"t":"ready"}')).toBeNull();
    expect(parseClientMsg(JSON.stringify({ t: 'ready', incarnation: 7, id: 99, level: 3, seed: 123, protectedUntilTick: 1e9 })))
      .toEqual({ t: 'ready', incarnation: 7 });
  });

  it('rejects malformed correction epochs instead of treating them as legacy inputs', () => {
    const input = { t: 'input', seq: 1, p: [0, 0, 0], yaw: 0, pitch: 0, f: 0 };
    for (const c of [-1, 1.5, '0', null, Number.MAX_SAFE_INTEGER + 1]) {
      expect(parseClientMsg(JSON.stringify({ ...input, c }))).toBeNull();
    }
    expect(parseClientMsg(JSON.stringify(input))).toEqual(input);
    expect(parseClientMsg(JSON.stringify({ ...input, c: 0 }))).toEqual({ ...input, c: 0 });
  });
});

describe('royale slow-loading player authority', () => {
  it.each(['warden', 'monitor'] as const)('keeps delayed-ready players out of %s prey and grants one finite grace', (kind) => {
    const t = setup(3, true, 'royale'), offered = installCatcher(t, kind);
    run(t.room, 12);
    expect(t.player().st).toBe(ST_OK);
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.every(ids => !ids.includes(1))).toBe(true);
    expect(t.ready()).toEqual({ incarnation: t.room.incarnation });
    expect(t.got[0].filter(m => m.t === 'royale-eliminated' || m.t === 'caught')).toEqual([]);
    const started = t.got[0].findLast(m => m.t === 'room' && m.started);
    expect(started).toMatchObject({ t: 'room', mode: 'royale', incarnation: t.room.incarnation });
    expect(t.room.incarnation).toBeGreaterThan(0);

    t.room.handle(t.conns[0], { t: 'ready', incarnation: t.room.incarnation }, t.room.tick * TICK_MS);
    const ready = { ...t.ready() }, until = ready.protectedUntilTick!;
    expect(ready.readyAtTick).toBe(t.room.tick);
    expect(until - t.room.tick).toBeGreaterThanOrEqual(10 * SECOND);
    run(t.room, 4);
    t.room.handle(t.conns[0], { t: 'ready', incarnation: t.room.incarnation }, t.room.tick * TICK_MS);
    t.input(); // A first valid input and repeated ready must retain the same absolute deadline.
    expect(t.ready()).toEqual(ready);
    while (t.room.tick < until - 1) t.room.step();
    expect(t.player().st).toBe(ST_OK);
    expect(offered.every(ids => !ids.includes(1))).toBe(true);
    t.room.step();
    expect(offered.at(-1)).toContain(1);
    expect(t.player().st).toBe(kind === 'warden' ? ST_SPECTATE : ST_DOWN);
    if (kind === 'warden') {
      expect(t.got[0].filter(m => m.t === 'royale-eliminated')).toEqual([{ t: 'royale-eliminated', id: 1, rank: 3, alive: 2 }]);
    } else {
      expect(t.got[0].findLast(m => m.t === 'caught')).toMatchObject({ t: 'caught', id: 1, by: 'monitor' });
    }
    expect(t.ready()).toEqual(ready);
    expect([t.player(2).st, t.player(3).st]).toEqual([ST_OK, ST_OK]);
  });

  it.each([false, true])('keeps out-of-zone elimination unchanged while ready=%s', (ready) => {
    const t = setup(3, true, 'royale');
    t.room.step(); // Zone state first appears in the running room's snapshots.
    if (ready) t.room.handle(t.conns[0], { t: 'ready', incarnation: t.room.incarnation }, t.room.tick * TICK_MS);
    expect(t.ready()).toBeDefined();
    expect(isSpawnProtected(t.ready(), t.room.tick)).toBe(true);
    const zone = t.got[0].findLast(m => m.t === 'snap' && m.zone);
    if (zone?.t !== 'snap' || !zone.zone) throw new Error('Expected royale zone snapshot');
    t.player().p = [-120, 0, 200];
    expect(inZone(t.player().p[0], t.player().p[2], zone.zone)).toBe(false);
    run(t.room, ZONE_OUT_ELIM_S - 0.5);
    expect(t.player().st).toBe(ST_OK);
    expect(isSpawnProtected(t.ready(), t.room.tick)).toBe(true);
    run(t.room, 0.7);
    expect(t.player().st).toBe(ST_SPECTATE);
    expect(t.got[0].filter(m => m.t === 'royale-eliminated')).toEqual([{ t: 'royale-eliminated', id: 1, rank: 3, alive: 2 }]);
    expect([t.player(2).st, t.player(3).st]).toEqual([ST_OK, ST_OK]);
  });
});

describe('slow-loading player authority', () => {
  it('accepts readiness during the intro and does not renew it after the authoritative prediction reset', () => {
    const t = setup(1, false);
    expect(t.player().c).toBe(0);
    t.room.handle(t.conns[0], { t: 'ready', incarnation: t.room.incarnation }, 0);
    expect(t.ready().readyAtTick).toBe(t.room.tick);
    expect(t.ready().protectedUntilTick! - t.room.tick).toBeGreaterThanOrEqual(10 * SECOND);
    const ready = { ...t.ready() };
    t.finishIntro();
    expect(t.player().c).toBe(1);
    run(t.room, 12);
    t.input(1, { c: undefined });
    t.room.handle(t.conns[0], { t: 'ready', incarnation: t.room.incarnation }, t.room.tick * TICK_MS);
    expect(t.ready()).toEqual(ready);
  });

  it('keeps ten elapsed seconds of grace when ready arrives just before the next tick', () => {
    const t = setupWithRescuer(); run(t.room, 12);
    const receivedAtMs = t.room.tick * TICK_MS + TICK_MS - 1;
    t.room.handle(t.conns[0], { t: 'ready', incarnation: t.room.incarnation }, receivedAtMs);
    const until = t.ready().protectedUntilTick!;
    expect(until * TICK_MS - receivedAtMs).toBeGreaterThanOrEqual(10_000);
    const offered = installCatcher(t, 'warden');
    while (t.room.tick < until - 1) t.room.step();
    expect(t.player().st).toBe(ST_OK);
    expect(offered.every((ids) => !ids.includes(1))).toBe(true);
    t.room.step();
    expect(t.player().st).toBe(ST_DOWN);
    expect(t.player(2).st).toBe(ST_OK);
    expect(t.got[0].filter(m => m.t === 'fade')).toEqual([]);
  });

  it.each(['warden', 'monitor'] as const)('starts each player\'s explicit-ready deadline separately against %s', (kind) => {
    const t = setupWithRescuer(2), offered = installCatcher(t, kind, 1, [1, 2]);
    run(t.room, 12);
    t.room.handle(t.conns[0], { t: 'ready', incarnation: t.room.incarnation }, t.room.tick * TICK_MS);
    const first = { ...t.ready(1) };
    run(t.room, 4);
    expect(t.ready(2).readyAtTick).toBeUndefined();
    expect(t.player(2).st).toBe(ST_OK);
    expect(offered.every((ids) => !ids.includes(1) && !ids.includes(2))).toBe(true);
    t.room.handle(t.conns[1], { t: 'ready', incarnation: t.room.incarnation }, t.room.tick * TICK_MS);
    const second = { ...t.ready(2) };
    expect(second.readyAtTick! - first.readyAtTick!).toBe(4 * SECOND);
    expect(first.protectedUntilTick! - first.readyAtTick!).toBeGreaterThanOrEqual(10 * SECOND);
    expect(second.protectedUntilTick! - second.readyAtTick!).toBeGreaterThanOrEqual(10 * SECOND);
    while (t.room.tick < first.protectedUntilTick! - 1) t.room.step();
    expect([t.player(1).st, t.player(2).st]).toEqual([ST_OK, ST_OK]);
    t.room.step();
    expect([t.player(1).st, t.player(2).st]).toEqual([ST_DOWN, ST_OK]);
    expect(offered.at(-1)).toEqual([1]);
    expect(t.got[1].filter((m) => m.t === 'caught')).toEqual([]);
    while (t.room.tick < second.protectedUntilTick! - 1) t.room.step();
    expect(t.player(2).st).toBe(ST_OK);
    t.room.step();
    expect(t.player(2).st).toBe(ST_DOWN);
    expect(offered.at(-1)).toEqual([2]);
    expect(t.got[1].filter((m) => m.t === 'caught')).toEqual([expectedCaught(t, 2, kind)]);
    expect(t.ready(1)).toEqual(first);
    expect(t.ready(2)).toEqual(second);
    expect(t.player(3).st).toBe(ST_OK);
    expect(t.got[0].filter(m => m.t === 'fade')).toEqual([]);
  });

  it.each(['warden', 'monitor'] as const)('first legal input after twelve seconds keeps %s from catching for at least ten more', (kind) => {
    const t = setupWithRescuer(), offered = installCatcher(t, kind);
    run(t.room, 12);
    expect(t.player().st).toBe(ST_OK);
    expect(t.ready().readyAtTick).toBeUndefined();
    expect(offered.every((ids) => !ids.includes(1))).toBe(true);
    t.input(); // Standing still is a valid first input; no movement key is required.
    expect(t.ready().readyAtTick).toBe(t.room.tick);
    const until = t.ready().protectedUntilTick!;
    expect(until - t.room.tick).toBeGreaterThanOrEqual(10 * SECOND);
    while (t.room.tick < until - 1) t.room.step();
    expect(t.player().st).toBe(ST_OK);
    expect(t.got[0].filter((m) => m.t === 'caught')).toEqual([]);
    expect(offered.every((ids) => !ids.includes(1))).toBe(true);
    t.room.step();
    expect(t.player().st).toBe(ST_DOWN);
    expect(t.got[0].filter((m) => m.t === 'caught')).toEqual([expectedCaught(t, 1, kind)]);
    expect(offered.at(-1)).toContain(1);
    expect(t.player(2).st).toBe(ST_OK);
    expect(t.got[0].filter(m => m.t === 'fade')).toEqual([]);
  });

  it('does not consume readiness on malformed, old-epoch, out-of-area or airborne input', () => {
    const t = setup(); run(t.room, 12);
    expect(parseClientMsg('{"t":"input","seq":1,"p":[1,0,"bad"],"yaw":0,"pitch":0,"f":0}')).toBeNull();
    expect(parseClientMsg('{"t":"input","seq":1,"p":[1e400,0,0],"yaw":0,"pitch":0,"f":0}')).toBeNull();
    const original = [...t.player().p];
    t.input(1, { c: t.player().c + 1 });
    t.input(1, { p: [original[0] + 100, original[1], original[2]] });
    t.input(1, { p: [original[0], original[1] + 2, original[2]] });
    expect(t.player().p).toEqual(original);
    expect(t.ready().readyAtTick).toBeUndefined();
    expect(t.ready().protectedUntilTick).toBeUndefined();
    t.input();
    expect(t.ready().readyAtTick).toBe(t.room.tick);
  });

  it('ignores forged epochs and cannot renew protection through ready, input, start or room broadcasts', () => {
    const t = setupWithRescuer(); run(t.room, 12);
    const incarnation = t.room.incarnation, player = t.player();
    t.room.handle(t.conns[0], { t: 'ready', incarnation: incarnation + 1 }, t.room.tick * TICK_MS);
    expect(t.ready().readyAtTick).toBeUndefined();
    const forged = parseClientMsg(JSON.stringify({ t: 'ready', incarnation, id: 99, protectedUntilTick: 1e9 }))!;
    t.room.handle(t.conns[0], forged, t.room.tick * TICK_MS);
    const state = { ...t.ready() };
    run(t.room, 4);
    for (let i = 0; i < 3; i++) {
      t.room.handle(t.conns[0], { t: 'ready', incarnation }, t.room.tick * TICK_MS);
      t.room.handle(t.conns[0], { t: 'start' }, t.room.tick * TICK_MS);
      t.room.broadcastRoom();
      t.input();
    }
    expect(t.room.incarnation).toBe(incarnation);
    expect(t.player()).toBe(player);
    expect(t.ready()).toEqual(state);
    const offered = installCatcher(t, 'warden');
    while (t.room.tick < state.protectedUntilTick! - 1) t.room.step();
    expect(t.player().st).toBe(ST_OK);
    t.room.step();
    expect(t.player().st).toBe(ST_DOWN);
    expect(offered.at(-1)).toContain(1);
    expect(t.player(2).st).toBe(ST_OK);
    expect(t.got[0].filter(m => m.t === 'fade')).toEqual([]);
  });

  it('refuses useful interactions while still loading, then permits them without renewing the timer', () => {
    const t = setup(); run(t.room, 12);
    t.room.items = [{ id: 901, kind: 'battery', p: [...t.player().p] }];
    t.room.bag = { battery: 1 }; t.player().battery = 0.25;
    t.room.handle(t.conns[0], { t: 'act', kind: 'pick', id: 901 }, t.room.tick * TICK_MS);
    t.room.handle(t.conns[0], { t: 'use', item: 'battery' }, t.room.tick * TICK_MS);
    expect(t.room.items.map((item) => item.id)).toEqual([901]);
    expect(t.room.bag).toEqual({ battery: 1 });
    expect(t.player().battery).toBe(0.25);
    expect(t.ready().readyAtTick).toBeUndefined();
    t.room.handle(t.conns[0], { t: 'ready', incarnation: t.room.incarnation }, t.room.tick * TICK_MS);
    const readyState = { ...t.ready() };
    run(t.room, 1);
    t.room.handle(t.conns[0], { t: 'act', kind: 'pick', id: 901 }, t.room.tick * TICK_MS);
    t.room.handle(t.conns[0], { t: 'use', item: 'battery' }, t.room.tick * TICK_MS);
    expect(t.room.items).toEqual([]);
    expect(t.room.bag).toEqual({ battery: 1 });
    expect(t.player().battery).toBe(1);
    expect(t.ready()).toEqual(readyState);
  });

  it('retains player state on connection replacement and fences the obsolete connection from input and removal', () => {
    const t = setup(); run(t.room, 12); t.input();
    const player = t.player(), original = { ...t.ready() }, incarnation = t.room.incarnation;
    run(t.room, 4);
    const restored = t.mk(1);
    t.room.add(restored, t.room.tick * TICK_MS);
    expect(t.player()).toBe(player);
    expect(t.player().conn).toBe(restored);
    expect(t.player().st).toBe(ST_OK);
    expect(t.room.players.size).toBe(1);
    const yaw = player.yaw;
    t.room.handle(t.conns[0], { t: 'input', seq: 99, p: [...player.p], yaw: 1.23, pitch: 0.4, f: 0, c: player.c }, t.room.tick * TICK_MS);
    expect(player.yaw).toBe(yaw);
    t.room.remove(t.conns[0], t.room.tick * TICK_MS);
    expect(t.player()).toBe(player);
    expect(restored.room).toBe(t.room);
    t.room.handle(restored, { t: 'ready', incarnation }, t.room.tick * TICK_MS);
    t.room.broadcastRoom(); t.input(1, { yaw: 2 });
    expect(player.yaw).toBe(2);
    expect(t.room.incarnation).toBe(incarnation);
    expect(t.ready()).toEqual(original);
  });

  it('does not restore expired protection when replacing a connection or repeating ready', () => {
    const t = setupWithRescuer(); run(t.room, 12); t.input();
    const player = t.player(), original = { ...t.ready() };
    while (t.room.tick < original.protectedUntilTick!) t.room.step();
    expect(isSpawnProtected(t.ready(), t.room.tick)).toBe(false);
    const restored = t.mk(1);
    t.room.add(restored, t.room.tick * TICK_MS);
    t.room.handle(restored, { t: 'ready', incarnation: t.room.incarnation }, t.room.tick * TICK_MS);
    t.input();
    expect(t.player()).toBe(player);
    expect(t.ready()).toEqual(original);
    const offered = installCatcher(t, 'warden');
    t.room.step();
    expect(offered.at(-1)).toEqual([1]);
    expect(t.player().st).toBe(ST_DOWN);
    expect(t.got[0].filter((m) => m.t === 'caught')).toEqual([expectedCaught(t, 1, 'warden')]);
    expect(t.player(2).st).toBe(ST_OK);
    expect(t.got[0].filter(m => m.t === 'fade')).toEqual([]);
  });

  it('keeps midgame and empty-room rejoiners observing even if they send current ready and valid input', () => {
    const t = setup(); t.input();
    const original = { ...t.ready() }, incarnation = t.room.incarnation;
    const late = t.mk(2); t.room.add(late, 1000);
    t.room.handle(late, { t: 'ready', incarnation }, 1000); t.input(2);
    expect(t.player(2).st).toBe(ST_SPECTATE);
    expect(t.ready()).toEqual(original);
    t.room.remove(late, 1100); t.room.remove(t.conns[0], 1100);
    t.room.add(t.conns[0], 1200);
    t.room.handle(t.conns[0], { t: 'ready', incarnation }, 1200); t.input();
    expect(t.room.incarnation).toBe(incarnation);
    expect(t.player().st).toBe(ST_SPECTATE);
  });

  it('gives a late observer its first readiness state only when the next level starts', () => {
    const t = setup(); t.input();
    const incarnation = t.room.incarnation, late = t.mk(2);
    t.room.add(late, 1000);
    const observer = t.player(2);
    expect(t.ready(2)).toBeUndefined();
    t.room.handle(late, { t: 'ready', incarnation }, 1000); t.input(2);
    expect(observer.st).toBe(ST_SPECTATE);
    expect(t.ready(2)).toBeUndefined();
    t.room.bag = { stair_key: 1 };
    t.player().p = [t.room.level.exit.x, t.room.level.exit.y, t.room.level.exit.z];
    t.room.step(); run(t.room, LEVEL_FADE_S);
    expect(t.room.levelIndex).toBe(1);
    expect(t.room.incarnation).toBe(incarnation + 1);
    expect(t.player(2)).toBe(observer);
    expect(observer.st).toBe(ST_OK);
    expect(t.ready(2)).toEqual({ incarnation: incarnation + 1 });
    run(t.room, 12);
    t.room.handle(late, { t: 'ready', incarnation }, t.room.tick * TICK_MS);
    expect(t.ready(2).readyAtTick).toBeUndefined();
    t.input(2);
    expect(t.ready(2).readyAtTick).toBe(t.room.tick);
    expect(t.ready(2).protectedUntilTick! - t.room.tick).toBeGreaterThanOrEqual(10 * SECOND);
    expect(t.ready(1).readyAtTick).toBeUndefined();
  });

  it('does not let an untagged or old-epoch input consume readiness after a same-seed wipe', () => {
    const t = setup(); t.input();
    const seed = t.room.seed, incarnation = t.room.incarnation, oldEpoch = t.player().c;
    t.player().st = ST_SPECTATE;
    t.room.step(); run(t.room, LEVEL_FADE_S);
    expect(t.room.seed).toBe(seed);
    expect(t.room.levelIndex).toBe(0);
    expect(t.room.incarnation).toBe(incarnation + 1);
    expect(t.player().c).toBeGreaterThan(oldEpoch);
    run(t.room, 12);
    const currentEpoch = t.player().c;
    t.input(1, { c: undefined });
    expect(t.ready().readyAtTick).toBeUndefined();
    t.input(1, { c: oldEpoch });
    expect(t.ready().readyAtTick).toBeUndefined();
    expect(t.ready().protectedUntilTick).toBeUndefined();
    expect(t.player().c).toBe(currentEpoch);
    t.input(1, { c: currentEpoch });
    expect(t.ready().readyAtTick).toBe(t.room.tick);
    expect(t.ready().protectedUntilTick! - t.room.tick).toBeGreaterThanOrEqual(10 * SECOND);
  });

  it('opens one new readiness incarnation on the next level and on a same-seed same-level wipe', () => {
    const t = setup(2), seed = t.room.seed, initial = t.room.incarnation;
    t.input(1); t.input(2);
    const players = [t.player(1), t.player(2)];
    t.room.bag = { stair_key: 1 };
    for (const p of players) p.p = [t.room.level.exit.x, t.room.level.exit.y, t.room.level.exit.z];
    t.room.step(); run(t.room, LEVEL_FADE_S);
    expect(t.room.levelIndex).toBe(1);
    expect(t.room.seed).toBe(seed);
    expect(t.room.incarnation).toBe(initial + 1);
    for (let id = 1; id <= 2; id++) {
      expect(t.player(id)).toBe(players[id - 1]);
      expect(t.ready(id).readyAtTick).toBeUndefined();
      t.room.handle(t.conns[id - 1], { t: 'ready', incarnation: initial }, t.room.tick * TICK_MS);
      expect(t.ready(id).readyAtTick).toBeUndefined();
    }
    run(t.room, 12); t.input(1); t.input(2);
    const next = t.room.incarnation, nextState = { ...t.ready() };
    t.room.broadcastRoom(); t.room.handle(t.conns[0], { t: 'ready', incarnation: next }, t.room.tick * TICK_MS);
    expect(t.ready()).toEqual(nextState);
    for (const p of players) p.st = ST_SPECTATE;
    t.room.step(); run(t.room, LEVEL_FADE_S);
    expect(t.room.levelIndex).toBe(1);
    expect(t.room.seed).toBe(seed);
    expect(t.room.incarnation).toBe(next + 1);
    expect(t.player().st).toBe(ST_OK);
    expect(t.ready().readyAtTick).toBeUndefined();
    t.room.handle(t.conns[0], { t: 'ready', incarnation: next }, t.room.tick * TICK_MS);
    expect(t.ready().readyAtTick).toBeUndefined();
    const current = t.room.incarnation;
    t.room.handle(t.conns[0], { t: 'ready', incarnation: current }, t.room.tick * TICK_MS);
    const fresh = { ...t.ready() };
    expect(fresh.readyAtTick).toBe(t.room.tick);
    expect(fresh.protectedUntilTick! - t.room.tick).toBeGreaterThanOrEqual(10 * SECOND);
    run(t.room, 1); t.room.broadcastRoom(); t.input();
    t.room.handle(t.conns[0], { t: 'ready', incarnation: current }, t.room.tick * TICK_MS);
    expect(t.room.incarnation).toBe(current);
    expect(t.ready()).toEqual(fresh);
  });
});
