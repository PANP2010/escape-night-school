import { describe, expect, it, vi } from 'vitest';
import { LEVEL_FADE_S, MOVE_BURST, RoomManager, type Conn } from '../../server/room.ts';
import { lineOfSight, NavGraph } from '../../shared/campus/nav.ts';
import type { CollisionWorld } from '../../shared/campus/collision.ts';
import { campusNavCached } from '../../client/src/campus/world/navcache.ts';
import { TICK_MS } from '../../shared/constants.ts';
import { INTRO_S, type IntroEvent } from '../../shared/intro.ts';
import { F_LIGHT, F_RUN, ST_OK, ST_SPECTATE, type ServerMsg, type Vec3 } from '../../shared/protocol.ts';
import { mulberry32 } from '../../shared/rng.ts';
import { inBounds } from '../../shared/level.ts';
import type { WardenAI } from '../../server/ai/warden.ts';
import { MonitorAI } from '../../server/ai/monitor.ts';

type Snap = Extract<ServerMsg, { t: 'snap' }>;
const intros = (messages: ServerMsg[]) => messages.filter((m): m is IntroEvent => m.t === 'event' && m.kind === 'intro');
const snaps = (messages: ServerMsg[]) => messages.filter((m): m is Snap => m.t === 'snap');
const peer = (id: number) => {
  const messages: ServerMsg[] = [];
  const conn: Conn = { id, name: `p${id}`, send: m => messages.push(structuredClone(m)), sendRaw: raw => messages.push(JSON.parse(raw)) };
  return { conn, messages };
};
const setup = (initialLevel = 0, mobs = false) => {
  const nav = new NavGraph();
  nav.chain([{ x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }]);
  const manager = new RoomManager(mulberry32(4), mobs ? () => nav : undefined);
  const room = manager.create(true, initialLevel), a = peer(1), b = peer(2);
  room.add(a.conn, 1000); room.add(b.conn, 1000);
  room.handle(a.conn, { t: 'start' }, 1000);
  const intro = intros(a.messages).at(-1)!;
  const allSkip = (now: number) => {
    for (const p of room.players.values()) room.handle(p.conn, { t: 'intro-skip', id: intros(a.messages).at(-1)!.id }, now);
  };
  return { manager, room, a, b, intro, allSkip, nav };
};
const move = (p: { p: Vec3; c: number }, dx: number, c = p.c) => ({
  t: 'input' as const, seq: 1, p: [p.p[0] + dx, p.p[1], p.p[2]] as Vec3, yaw: 1, pitch: 0.3, f: F_LIGHT | F_RUN, c,
});
const mobPositions = (snap: Snap) => snap.mobs.map(m => ({ id: m.id, p: m.p, yaw: m.yaw }));

describe('room intro authority', () => {
  it('all four real campus chapters have a safe camera flight and a visible distant silhouette with doors closed', () => {
    const graph = campusNavCached('.cache/campus-nav.json').graph;
    const manager = new RoomManager(mulberry32(4), () => graph);
    for (let level = 0; level < 4; level++) {
      const room = manager.create(true, level);
      const camera = room as unknown as {
        introPlan(): { route: Vec3[]; silhouette?: Vec3 };
        campusMoveOk(world: CollisionWorld, a: Vec3, b: Vec3): boolean;
        doorWorld: CollisionWorld; barrierWorld: CollisionWorld;
      };
      const { route, silhouette } = camera.introPlan();
      expect(route.length, `L${level + 1} camera flight`).toBeGreaterThan(1);
      expect(silhouette, `L${level + 1} distant sighting`).toBeDefined();
      let distance = 0;
      for (let i = 0; i < route.length; i++) {
        expect(inBounds(room.level, ...route[i])).toBe(true);
        expect(camera.campusMoveOk(room.world, route[i], route[i])).toBe(true);
        if (i) {
          expect(camera.campusMoveOk(room.world, route[i - 1], route[i])).toBe(true);
          distance += Math.hypot(...route[i].map((v, k) => v - route[i - 1][k]));
        }
      }
      expect(distance, `L${level + 1} flight length`).toBeGreaterThanOrEqual(4);
      expect(inBounds(room.level, ...silhouette!)).toBe(true);
      expect(camera.campusMoveOk(room.world, silhouette!, silhouette!)).toBe(true);
      const last = route.at(-1)!, gap = Math.hypot(...silhouette!.map((v, k) => v - last[k]));
      if (level === 0) {
        const exit = room.level.exit;
        expect(last[0], 'L1 flies west toward the stairs').toBeLessThan(-50);
        expect(silhouette![0], 'L1 reveal faces the stairwell corridor').toBeLessThan(-55);
        expect(Math.hypot(silhouette![0] - exit.x, silhouette![2] - exit.z)).toBeLessThan(12);
      }
      expect(gap).toBeGreaterThanOrEqual(6); expect(gap).toBeLessThanOrEqual(10);
      const eye = (p: Vec3) => ({ x: p[0], y: p[1] + 1.55, z: p[2] });
      for (const world of [room.world, camera.doorWorld, camera.barrierWorld]) {
        expect(lineOfSight(world, eye(last), eye(silhouette!)), `L${level + 1} sightline`).toBe(true);
      }
    }
  });

  it('starts every peer together, rejects movement/interactions/debug and freezes mobs and resources while snapshots advance', () => {
    const { room, a, b, intro, nav } = setup(1, true);
    expect(intros(b.messages)).toEqual([intro]);
    expect(intro).toMatchObject({ level: 1, startedAt: 1000, endsAt: 9000, ended: false });
    const p = room.players.get(1)!, origin = [...p.p], tick = room.tick;
    p.battery = p.stamina = 0.5; p.f = F_LIGHT | F_RUN;
    room.bag = { battery: 2 };
    room.items = [{ id: 99, kind: 'battery', p: [...p.p] }];
    const ai = room as unknown as { warden: WardenAI; monitors: MonitorAI[] };
    // L2 normally unlocks its monitor after installing a fuse. An existing live monitor must also freeze.
    expect(ai.monitors).toHaveLength(0);
    ai.monitors.push(new MonitorAI({ graph: nav, los: () => true }, [40, 3.6, 84.2]));
    const wardenStep = vi.spyOn(ai.warden, 'step'), monitorSteps = ai.monitors.map(m => vi.spyOn(m, 'step'));
    room.step(1050);
    const first = snaps(a.messages).at(-1)!;
    const doors = [...room.doorOpen];
    for (const m of [move(p, 1), { t: 'use', item: 'battery' }, { t: 'act', kind: 'pick', id: 99 },
      { t: 'door', id: 0 }, { t: 'debug', op: 'tp', x: 40, z: 84.2 }, { t: 'debug', op: 'warden', d: 1.5 },
      { t: 'debug', op: 'monitor', d: 1.5 }, { t: 'debug', op: 'down' }, { t: 'debug', op: 'key', door: -1 },
      { t: 'debug', op: 'power' }, { t: 'debug', op: 'safe', s: 600 }] as const) room.handle(a.conn, m, 1200);
    expect(room.act(p, 'pick', 99)).toBe(false);
    expect(room.toggleDoor(p, 0)).toBe(false);
    expect(room.hideIn(p, 0)).toBe(false);
    expect(room.unhide(p)).toBe(false);
    room.handle(a.conn, { t: 'intro-skip', id: intro.id }, 1300);
    expect(intros(b.messages).at(-1)).toMatchObject({ skipped: [1], ended: false });
    for (let now = 1350; now <= 2300; now += TICK_MS) room.step(now);
    const samples = snaps(a.messages);
    expect(samples).toHaveLength(21);
    expect(samples.map(s => s.tick)).toEqual(Array.from({ length: 21 }, (_, i) => first.tick + i));
    expect(room.tick).toBe(tick);
    expect(p.p).toEqual(origin); expect(p.yaw).toBe(0); expect(p.pitch).toBe(0);
    expect(p.st).toBe(ST_OK); expect(p.safeUntil).toBeUndefined();
    expect(p.battery).toBe(0.5); expect(p.stamina).toBe(0.5); expect(p.f).toBe(F_LIGHT | F_RUN);
    expect(room.bag).toEqual({ battery: 2 }); expect(room.items).toHaveLength(1); expect(room.doorOpen).toEqual(doors);
    expect(wardenStep).not.toHaveBeenCalled();
    expect(monitorSteps).toHaveLength(1);
    for (const step of monitorSteps) expect(step).not.toHaveBeenCalled();
    for (const snap of samples) expect(mobPositions(snap)).toEqual(mobPositions(first));
    expect(first.mobs[0]).toMatchObject({ kind: 'warden', form: 'night' });
    expect(samples[19].mobs[0]).toMatchObject({ kind: 'warden', form: 'night' }); // wire keyframe keeps its one-second cadence
    room.handle(b.conn, { t: 'intro-skip', id: intro.id }, 2400);
    expect(room.introFrozen).toBe(false);
    expect(intros(a.messages).at(-1)).toMatchObject({ ended: true, skipped: [1, 2] });
    expect(a.messages.at(-2)).toMatchObject({ t: 'correct', forced: true, c: 1 });
    room.step(2450);
    expect(room.tick).toBe(tick + 1);
    expect(wardenStep).toHaveBeenCalledOnce(); expect(monitorSteps[0]).toHaveBeenCalledOnce();
  });

  it('expires on server wall time and discards frozen prediction epochs and movement budget', () => {
    const { manager, room, a, intro } = setup();
    const p = room.players.get(1)!, origin = [...p.p], frozenTick = room.tick;
    p.budget = 20;
    manager.step(intro.endsAt - 1);
    expect(room.introFrozen).toBe(true); expect(room.tick).toBe(frozenTick);
    manager.step(intro.endsAt);
    expect(room.introFrozen).toBe(false); expect(room.tick).toBe(frozenTick + 1);
    expect(intros(a.messages).at(-1)).toMatchObject({ ended: true, now: intro.endsAt });
    expect(p.c).toBe(1); expect(p.budget).toBe(MOVE_BURST); expect(p.budgetAt).toBe(intro.endsAt);
    room.handle(a.conn, move(p, 0.1, 0), intro.endsAt + 50);
    expect(p.p).toEqual(origin); expect(p.budget).toBe(MOVE_BURST);
    room.handle(a.conn, move(p, 0.1), intro.endsAt + 100);
    expect(p.p[0]).toBeCloseTo(origin[0] + 0.1);
    const endedCount = intros(a.messages).filter(m => m.ended).length;
    room.handle(a.conn, { t: 'intro-skip', id: intro.id }, intro.endsAt + 150);
    expect(intros(a.messages).filter(m => m.ended)).toHaveLength(endedCount);
  });

  it('late joiners only observe the existing deadline and cannot vote; a disconnect releases the skipped survivor', () => {
    const { room, a, b, intro } = setup();
    const late = peer(3); room.add(late.conn, 3000);
    expect(room.players.get(3)!.st).toBe(ST_SPECTATE);
    expect(intros(late.messages)).toEqual([{ ...intro, now: 3000 }]);
    room.handle(late.conn, { t: 'intro-skip', id: intro.id }, 3100);
    room.handle(b.conn, { t: 'intro-skip', id: intro.id + 1 }, 3100);
    expect(intros(a.messages)).toHaveLength(1);
    room.handle(a.conn, { t: 'intro-skip', id: intro.id }, 3200);
    expect(room.introFrozen).toBe(true);
    room.remove(b.conn, 3300);
    expect(room.host).toBe(1); expect(room.introFrozen).toBe(false);
    expect(intros(late.messages).at(-1)).toMatchObject({ id: intro.id, ended: true, endsAt: intro.endsAt, skipped: [1] });
    expect(room.players.get(3)!.st).toBe(ST_SPECTATE);
    room.remove(a.conn, 3400); room.remove(late.conn, 3400);
    const replacement = peer(4); room.add(replacement.conn, 3500);
    expect(room.players.get(4)!.st).toBe(ST_SPECTATE);
    expect(intros(replacement.messages).at(-1)).toMatchObject({ id: intro.id, ended: true, endsAt: intro.endsAt });
  });

  it('a disconnect after the deadline also ends the session when another unskipped voter stays', () => {
    const { room, a, b, intro } = setup();
    room.remove(b.conn, intro.endsAt);
    expect(room.introFrozen).toBe(false);
    expect(intros(a.messages).at(-1)).toMatchObject({ ended: true, now: intro.endsAt });
  });

  it('clear excludes intro time, freezes players/mobs/resources for exactly three seconds, then starts the next intro', () => {
    const { room, a, b, intro } = setup(0, true);
    for (let now = 1050; now < intro.endsAt; now += TICK_MS) room.step(now);
    room.step(intro.endsAt); // one active simulation tick at the deadline
    for (let i = 1; i <= 19; i++) room.step(intro.endsAt + i * TICK_MS);
    const p = room.players.get(1)!, q = room.players.get(2)!;
    p.p = [room.level.exit.x, room.level.exit.y, room.level.exit.z]; q.p = [...p.p];
    p.battery = p.stamina = 0.5; p.f = F_LIGHT | F_RUN;
    room.bag = { stair_key: 1, battery: 2 };
    room.items = [{ id: 99, kind: 'battery', p: [...p.p] }];
    const warden = (room as unknown as { warden: WardenAI }).warden, wardenStep = vi.spyOn(warden, 'step');
    const clearAt = intro.endsAt + 20 * TICK_MS;
    room.step(clearAt);
    const clear = a.messages.find((m): m is Extract<ServerMsg, { kind: 'clear' }> => m.t === 'event' && m.kind === 'clear')!;
    expect(clear).toMatchObject({ level: 0, secs: LEVEL_FADE_S, elapsed: 21 * TICK_MS / 1000 });
    expect(clear.elapsed).toBeLessThan(INTRO_S);
    expect(b.messages).toContainEqual(clear);
    const origin = [...p.p], mob = [...warden.p], yaw = warden.yaw, c = p.c, doors = [...room.doorOpen];
    const calls = wardenStep.mock.calls.length, snapshotCount = snaps(a.messages).length;
    for (let i = 1; i < LEVEL_FADE_S * 1000 / TICK_MS; i++) {
      const now = clearAt + i * TICK_MS;
      room.handle(a.conn, move(p, 1), now);
      room.handle(a.conn, { t: 'use', item: 'battery' }, now);
      room.handle(a.conn, { t: 'act', kind: 'pick', id: 99 }, now);
      room.handle(a.conn, { t: 'door', id: 0 }, now);
      room.handle(a.conn, { t: 'debug', op: 'warden', d: 1.5 }, now);
      room.step(now);
      expect(room.levelIndex).toBe(0); expect(room.introFrozen).toBe(false);
      expect(p.p).toEqual(origin); expect(p.c).toBe(c); expect(p.battery).toBe(0.5); expect(p.stamina).toBe(0.5);
      expect(room.bag).toEqual({ stair_key: 1, battery: 2 }); expect(room.items).toHaveLength(1); expect(room.doorOpen).toEqual(doors);
      expect(warden.p).toEqual(mob); expect(warden.yaw).toBe(yaw); expect(wardenStep).toHaveBeenCalledTimes(calls);
    }
    expect(snaps(a.messages)).toHaveLength(snapshotCount); // preserve the existing fade wire behavior
    const late = peer(3); room.add(late.conn, clearAt + 2950);
    expect(late.messages).toContainEqual({ ...clear, secs: 0.05 });
    room.step(clearAt + LEVEL_FADE_S * 1000);
    expect(room.levelIndex).toBe(1); expect(room.introFrozen).toBe(true);
    const next = intros(a.messages).at(-1)!;
    expect(next).toMatchObject({ id: intro.id + 1, level: 1, startedAt: clearAt + LEVEL_FADE_S * 1000, ended: false });
    expect(next.endsAt - next.startedAt).toBe(INTRO_S * 1000);
    expect(room.players.get(3)!.st).toBe(ST_OK);
    room.handle(a.conn, { t: 'intro-skip', id: intro.id }, next.startedAt + 10);
    expect(room.introFrozen).toBe(true); // stale chapter vote
    for (const conn of [a.conn, b.conn]) room.handle(conn, { t: 'intro-skip', id: next.id }, next.startedAt + 20);
    expect(room.introFrozen).toBe(true); // the observer is now a participant in this new chapter
    room.handle(late.conn, { t: 'intro-skip', id: next.id }, next.startedAt + 30);
    expect(room.introFrozen).toBe(false);
  });

  it('a real wipe keeps its three-second fade and restarts with a new intro epoch', () => {
    const { room, a, b, intro, allSkip } = setup(2);
    allSkip(1100);
    for (const p of room.players.values()) p.st = ST_SPECTATE;
    room.step(1150);
    expect(a.messages).toContainEqual({ t: 'fade', secs: LEVEL_FADE_S, restart: true });
    expect(a.messages.some(m => m.t === 'event' && m.kind === 'clear')).toBe(false);
    for (let i = 1; i <= LEVEL_FADE_S * 1000 / TICK_MS; i++) room.step(1150 + i * TICK_MS);
    expect(room.levelIndex).toBe(2); expect(room.introFrozen).toBe(true);
    expect(intros(a.messages).at(-1)).toMatchObject({ id: intro.id + 1, level: 2, startedAt: 4150, endsAt: 12_150, ended: false });
    expect(intros(b.messages).at(-1)).toEqual(intros(a.messages).at(-1));
    expect([...room.players.values()].map(p => p.st)).toEqual([ST_OK, ST_OK]);
    for (const { messages } of [a, b]) {
      const roomAt = messages.findLastIndex(m => m.t === 'room');
      const introAt = messages.findIndex((m, i) => i > roomAt && m.t === 'event' && m.kind === 'intro');
      const loopAt = messages.findIndex((m, i) => i > roomAt && m.t === 'loop');
      const itemsAt = messages.findIndex((m, i) => i > roomAt && m.t === 'items');
      expect(roomAt).toBeGreaterThanOrEqual(0);
      expect(introAt).toBeGreaterThan(roomAt);
      expect(loopAt).toBeGreaterThan(introAt); expect(itemsAt).toBeGreaterThan(introAt);
    }
  });

  it('direct running rooms preserve their clock and late-observer policy without starting an intro', () => {
    const room = new RoomManager(mulberry32(5)).create(), a = peer(1);
    room.add(a.conn, 0); room.lateObserve = true;
    room.handle(a.conn, { t: 'start' }, 0); room.step(50);
    expect(room.tick).toBe(1); expect(snaps(a.messages).at(-1)!.tick).toBe(1); expect(intros(a.messages)).toEqual([]);
    room.players.get(1)!.st = ST_SPECTATE; room.step(100);
    for (let i = 1; i <= LEVEL_FADE_S * 1000 / TICK_MS; i++) room.step(100 + i * TICK_MS);
    expect(room.introFrozen).toBe(false); expect(intros(a.messages)).toEqual([]);
    expect(room.players.get(1)!.st).toBe(ST_OK);
  });
});
