import { describe, expect, it } from 'vitest';
import { BALL_RADIUS, GYM_TRIP_S, GymSwitches, sweptBallHit } from '../../shared/gym.ts';
import { GymRuntime } from '../../server/gym.ts';
import { L5 } from '../../shared/levels/l5.ts';
import type { GymSound } from '../../shared/gym.ts';
import type { Vec3 } from '../../shared/protocol.ts';
import { gymAreaNav } from '../../server/gym-nav.ts';
import { generateLevel, levelSolids } from '../../shared/level.ts';
import { CollisionWorld, moveCapsule, type AABB } from '../../shared/campus/collision.ts';
import { NAV_CAPSULE } from '../../shared/campus/nav.ts';
import { campusDoorSlab, type DoorSpot } from '../../shared/doors.ts';
import campusData from '../../shared/campus/colliders.json';
import { Room, type Conn } from '../../server/room.ts';
import { TICK_MS } from '../../shared/constants.ts';
import type { ServerMsg } from '../../shared/protocol.ts';

const setup = (blocked = (_x: number, _z: number, _r: number) => false) => {
  const noise: { p: Vec3; r: number; player?: number }[] = [], sounds: GymSound[] = [], trips: number[] = [];
  const runtime = new GymRuntime(L5.gym!, 0, { blocked, noise: (p, r, player) => noise.push({ p: [...p], r, player }), sound: (e) => sounds.push(e), trip: (id) => trips.push(id) });
  return { runtime, noise, sounds, trips };
};

describe('L5 scoreboard timing', () => {
  it('solo latches each station for 20s, enough to walk all four; completion stays open', () => {
    const s = new GymSwitches(); s.syncTeam([1]);
    for (const [id, at] of [[0, 0], [1, 4], [2, 11], [3, 19.95]]) expect(s.press(id, at)).toBe(true);
    expect(s.complete).toBe(true); s.expire(200); expect(s.complete).toBe(true);
    expect(s.press(0, 201)).toBe(false);
  });
  it('exactly 20s expires the first solo latch and can be retried without reloading', () => {
    const s = new GymSwitches(); s.syncTeam([1]);
    s.press(0, 0); s.press(1, 6); s.press(2, 12); s.press(3, 20);
    expect(s.complete).toBe(false); expect(s.until[0]).toBe(0);
    expect(s.press(0, 20)).toBe(true); expect(s.complete).toBe(true);
  });
  it.each([2, 3, 4])('%i players must press inside a strict 5s overlap', (n) => {
    const s = new GymSwitches(); s.syncTeam(Array.from({ length: n }, (_, i) => i + 1));
    s.press(0, 10); s.press(1, 11); s.press(2, 13); s.press(3, 14.95);
    expect(s.complete).toBe(true); expect(s.solo).toBe(false);
  });
  it('5s boundary rejects an expired switch; duplicate spam cannot extend its deadline', () => {
    const s = new GymSwitches(); s.syncTeam([1, 2]);
    s.press(0, 0); expect(s.press(0, 4.9)).toBe(false); expect(s.until[0]).toBe(5);
    s.press(1, 2); s.press(2, 3); s.press(3, 5);
    expect(s.complete).toBe(false); expect(s.until[0]).toBe(0);
    s.press(0, 5); expect(s.complete).toBe(true);
  });
  it('joining, leaving or replacing a participant resets only unfinished attempts', () => {
    const s = new GymSwitches(); s.syncTeam([1]); s.press(0, 0);
    s.syncTeam([1, 2]); expect(s.until).toEqual([0, 0, 0, 0]); expect(s.solo).toBe(false);
    s.press(0, 1); s.syncTeam([2, 1]); expect(s.until[0]).toBe(6);
    s.syncTeam([1, 3]); expect(s.until[0]).toBe(0);
    s.syncTeam([1]); expect(s.solo).toBe(true);
    for (let i = 0; i < 4; i++) s.press(i, 2);
    s.syncTeam([1, 2]); expect(s.complete).toBe(true);
  });
  it('rejects invalid station IDs', () => {
    const s = new GymSwitches();
    for (const i of [-1, 4, 0.5, NaN, Infinity]) expect(s.press(i, 0)).toBe(false);
    expect(s.until).toEqual([0, 0, 0, 0]);
  });
});

describe('L5 basketball simulation', () => {
  it('rolls from equipment room on schedule with 10m noise and audible events', () => {
    const { runtime: g, noise, sounds } = setup();
    g.step(5.95, 0.05, []); expect(g.balls).toHaveLength(0);
    g.step(6, 0.05, []); expect(g.balls).toHaveLength(1);
    expect(g.balls[0].p[2]).toBeGreaterThan(L5.gym!.ballSpawn.z);
    expect(noise).toHaveLength(1); expect(noise[0].r).toBe(10); expect(sounds[0].kind).toBe('roll');
    g.step(6.05, 0.05, []); expect(noise).toHaveLength(1);
    g.step(7, 0.05, []); expect(noise).toHaveLength(2);
  });
  it('sweeps a fast ball through a player, freezes 1.5s and emits one 15m impact', () => {
    const { runtime: g, noise, trips } = setup();
    g.step(6, 0.05, []);
    g.balls[0].p = [0, 0, 0]; g.balls[0].v = [12, 0];
    g.step(6.1, 0.2, [{ id: 1, p: [1.2, 0, 0], active: true }]);
    expect(trips).toEqual([1]); expect(g.tripped(1, 6.1 + GYM_TRIP_S - 0.001)).toBe(true);
    expect(g.tripped(1, 7.6)).toBe(false);
    expect(noise.filter((n) => n.r === 15)).toEqual([{ p: [1.2, 0, 0], r: 15, player: 1 }]);
    expect(g.snapshot(6.1).trips).toEqual([{ id: 1, until: 7.6 }]);
  });
  it('accepted player motion is swept too; one impact cannot indefinitely renew the stun', () => {
    const { runtime: g, trips } = setup(); g.step(6, 0.05, []);
    g.balls[0].p = [0, 0, 0];
    g.touchMove(1, [-1, 0, 0], [1, 0, 0], 6.1);
    g.touchMove(1, [-1, 0, 0], [1, 0, 0], 6.2);
    expect(trips).toEqual([1]); expect(g.snapshot(6.2).trips[0].until).toBe(7.6);
  });
  it('checks the overlapping height interval while stepping down, without hitting a different storey', () => {
    expect(sweptBallHit([-1, 0.8, 0], [1, 0.035, 0], [0, 0.035, 0], 0.57)).toBe(true);
    expect(sweptBallHit([-1, 0.035, 0], [1, 0.8, 0], [0, 0.035, 0], 0.57)).toBe(true);
    expect(sweptBallHit([0, 1, 0], [0, 0.035, 0], [0, 0.035, 0], 0.57)).toBe(true);
    expect(sweptBallHit([-1, 2, 0], [1, 2, 0], [0, 0.035, 0], 0.57)).toBe(false);
    // The closest horizontal point is too high, but contact begins at the
    // edge of the height band before the horizontal circles stop touching.
    expect(sweptBallHit([-1, 0, 0], [1, 2, 0], [0, 0, 0], 0.57)).toBe(true);
    expect(sweptBallHit([-1, 0, 0], [1, 3, 0], [0, 0, 0], 0.4)).toBe(false);
  });
  it('bounces off a thin wall without tunnelling, and publishes a bounce sound', () => {
    const { runtime: g, sounds } = setup((x, _z, r) => Math.abs(x - 1) < 0.025 + r);
    g.step(6, 0.05, []); g.balls[0].p = [0, 0, 0]; g.balls[0].v = [20, 0];
    g.step(6.1, 0.1, []);
    expect(g.balls[0].v[0]).toBe(-20); expect(g.balls[0].p[0]).toBeLessThan(1 - BALL_RADIUS);
    expect(sounds.some((e) => e.kind === 'bounce')).toBe(true);
  });
  it('ignores downed/hidden players and other storeys; retires old balls', () => {
    const { runtime: g, trips } = setup(); g.step(6, 0.05, []); const p = [...g.balls[0].p] as Vec3;
    g.step(6.05, 0.05, [{ id: 1, p, active: false }, { id: 2, p: [p[0], 2, p[2]], active: true }]);
    expect(trips).toEqual([]); g.step(34, 0.05, []); expect(g.balls.some((b) => b.id === 1)).toBe(false);
    expect(sweptBallHit([0, 0, 0], [0, 0, 0], [0, 2, 0], 1)).toBe(false);
  });
  it('snapshots are independent copies and include late-join puzzle/balls/trips', () => {
    const { runtime: g } = setup(); g.switches.syncTeam([1]); g.press(0, 0); g.step(6, 0.05, [{ id: 1, p: [-90, 0, 60], active: true }]);
    const s = g.snapshot(6); s.until.fill(99); s.balls[0].p[0] = 900;
    expect(g.snapshot(6).until[0]).toBe(20); expect(g.balls[0].p[0]).toBeLessThan(0);
  });
  it('rounds only visual ball wire values while retaining exact simulation coordinates and authority deadlines', () => {
    const { runtime: g } = setup(); g.step(6, 0.05, []);
    const ball = g.balls[0], at = 6.1234567, now = 6.2345678;
    ball.p = [-100.123456, 0.035123, 60.987654]; ball.v = [1.234567, -3.141592];
    g.switches.syncTeam([1]); g.press(0, at);
    g.touchMove(1, [ball.p[0] - 1, ball.p[1], ball.p[2]], [ball.p[0] + 1, ball.p[1], ball.p[2]], at);
    const before = structuredClone(g.balls), snapshot = g.snapshot(now);
    expect(snapshot.balls[0]).toEqual({ id: ball.id, p: [-100.12, 0.04, 60.99], v: [1.23, -3.14] });
    expect(g.balls).toEqual(before);
    expect(snapshot.now).toBe(now); expect(snapshot.until[0]).toBe(at + 20);
    expect(snapshot.trips).toEqual([{ id: 1, until: at + GYM_TRIP_S }]);
    snapshot.balls[0].p[0] = 999; snapshot.trips[0].until = 999;
    expect(g.balls).toEqual(before); expect(g.snapshot(now).trips[0].until).toBe(at + GYM_TRIP_S);
  });
});

describe('L5 room gym wire cadence', () => {
  const roomWithBall = () => {
    const messages: ServerMsg[] = [], room = new Room('RATE', 42);
    const conn: Conn = { id: 1, name: 'court player', send: m => messages.push(structuredClone(m)), sendRaw: s => messages.push(JSON.parse(s)) };
    room.add(conn, 0); room.handle(conn, { t: 'debug', op: 'level5' }, 0);
    for (let tick = 0; tick < 6 * 1000 / TICK_MS; tick++) room.step();
    expect(room.tick).toBe(120); expect(room.gym!.balls).toHaveLength(1);
    messages.length = 0; return { room, messages, ball: room.gym!.balls[0] };
  };
  const gymMessages = (messages: ServerMsg[]) => messages.filter(m => m.t === 'gym');

  it('moves a real basketball on every 20Hz physics step but sends only ten regular snapshots per second', () => {
    const { room, messages, ball } = roomWithBall();
    ball.p = [-100.123456, 0.035, 60]; ball.v = [1.25, 0];
    for (let step = 1; step <= 20; step++) {
      const x = ball.p[0]; room.step();
      expect(ball.p[0] - x, `physics step ${step}`).toBeCloseTo(1.25 * TICK_MS / 1000, 8);
      expect(gymMessages(messages), `wire step ${step}`).toHaveLength(Math.floor(step / 2));
    }
    expect(gymMessages(messages).map(m => m.now)).toEqual(Array.from({ length: 10 }, (_, i) => 6 + (i + 1) / 10));
  });

  it('publishes both impact and exact 1.5s release immediately on odd ticks between regular snapshots', () => {
    const { room, messages, ball } = roomWithBall(), player = room.players.get(1)!;
    player.p = [-100, 0.035, 60]; ball.p = [...player.p]; ball.v = [0, 0];
    room.step(); expect(room.tick % 2).toBe(1);
    const at = room.tick * TICK_MS / 1000, until = at + GYM_TRIP_S;
    expect(gymMessages(messages)).toHaveLength(1);
    expect(gymMessages(messages)[0]).toMatchObject({ now: at, trips: [{ id: 1, until }] });
    ball.p = [-110, 0.035, 56];
    for (let step = 0; step < GYM_TRIP_S * 1000 / TICK_MS - 1; step++) room.step();
    expect(room.gym!.tripped(1, room.tick * TICK_MS / 1000)).toBe(true);
    messages.length = 0; room.step(); expect(room.tick % 2).toBe(1);
    expect(room.tick * TICK_MS / 1000).toBe(until);
    expect(room.gym!.tripped(1, until)).toBe(false);
    expect(gymMessages(messages)).toHaveLength(1);
    expect(gymMessages(messages)[0]).toMatchObject({ now: until, trips: [] });
  });
});

describe('L5 stand navigation', () => {
  it('records settled feet heights for every node and keeps the stands connected to the court', () => {
    const nav = gymAreaNav(generateLevel(4, 42));
    const world = new CollisionWorld([...(campusData.colliders as AABB[]), ...levelSolids(L5),
      ...(campusData.doors as DoorSpot[]).filter((d) => d.id !== L5.gym!.equipmentDoor).map((d) => campusDoorSlab(d, false))]);
    const spawn = L5.spawns[0], reachable = nav.reachable(nav.nearest(spawn.x, spawn.y ?? 0, spawn.z));
    for (const [id, node] of nav.nodes.entries()) {
      const body = { ...node, vy: 0, grounded: true };
      moveCapsule(world, body, 0, 0, 0.05, NAV_CAPSULE);
      expect(body.y, JSON.stringify(node)).toBeCloseTo(node.y, 5);
      expect(reachable.has(id), JSON.stringify(node)).toBe(true);
    }
    for (const p of L5.monitor!.spawns!) {
      const node = nav.nodes[nav.nearest(p.x, p.y ?? 0, p.z)];
      expect(node.y).toBeCloseTo(p.y ?? 0);
    }
  });
});
