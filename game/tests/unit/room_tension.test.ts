import { describe, expect, it, vi } from 'vitest';
import { campusNavCached } from '../../client/src/campus/world/navcache.ts';
import { Room, type Conn } from '../../server/room.ts';
import { TENSION, type TensionDirector } from '../../server/ai/tensionDirector.ts';
import type { WardenAI, WardenEnv } from '../../server/ai/warden.ts';
import { F_HIDE, ST_OK, type ServerMsg, type Vec3 } from '../../shared/protocol.ts';
import { WARDEN_CHASE_SPEED } from '../../server/ai/warden.ts';
import { overlaps, type CollisionWorld } from '../../shared/campus/collision.ts';
import { NAV_CAPSULE } from '../../shared/campus/nav.ts';
import { inBounds } from '../../shared/level.ts';
import { roomIntroReady } from './room-intro-fixture.ts';

type Internal = { warden: WardenAI; wardenEnv: WardenEnv; tension: TensionDirector; doorWorld: CollisionWorld; huntFrom: number; tripNext: number; tripCool: number;
  stepTrip(): void; hearWarden(ev: { kind: 'run'; x: number; y: number; z: number; r: number; src: number }): void; loadLevel(n: number): void };
const graph = () => campusNavCached('.cache/campus-nav.json').graph;
function setup(seed = 1, level = 0, count = 2, firstId = 1) {
  const room = new Room('PACE', seed, graph(), level), got: ServerMsg[] = [], received = new Map<number, ServerMsg[]>();
  const conns: Conn[] = Array.from({ length: count }, (_, i) => {
    const id = firstId + i, messages: ServerMsg[] = [];
    received.set(id, messages);
    const send = (m: ServerMsg) => { got.push(m); messages.push(m); };
    return { id, name: `p${id}`, send, sendRaw: s => send(JSON.parse(s)) };
  });
  for (const c of conns) room.add(c, 0);
  const ready = roomIntroReady(conns);
  const r = room as unknown as Internal;
  const run = (s: number) => { for (let i = 0; i < Math.ceil(s * 20); i++) room.step(); };
  return { room, r, got, received, conns, run, ready };
}

describe('authoritative room tension wiring', () => {
  it('turns an overdue investigation into a real walking chase within 90 s on both level areas', () => {
    for (const level of [0, 1]) for (const seed of [1, 2, 3]) {
      const { room, r, conns, ready } = setup(seed, level, 2);
      // Use the same start path as a real lobby, including opening grace and initial trip scheduling.
      room.started = false;
      room.handle(conns[0], { t: 'start' }, 0);
      ready(room);
      room.handle(conns[0], { t: 'debug', op: 'safe', s: 600, mob: 2 }, 0);
      const initialDeadline = r.tension.status(0).nextEncounter;
      const diagnostic = () => JSON.stringify({ level, seed, tick: room.tick, state: r.warden.state, p: r.warden.p, pacing: r.tension.status(room.tick / 20) });
      while (room.tick < 90 * 20 && r.warden.state !== 'chase' && r.warden.state !== 'catch') {
        const from = [...r.warden.p];
        room.step();
        expect(Math.hypot(...r.warden.p.map((v, i) => v - from[i])), diagnostic()).toBeLessThanOrEqual(WARDEN_CHASE_SPEED / 20 + .001);
        const body = { x: r.warden.p[0], y: r.warden.p[1], z: r.warden.p[2], vy: 0, grounded: true };
        expect(overlaps(room.world!, body, NAV_CAPSULE), diagnostic()).toBe(false);
        expect(overlaps(r.doorWorld, body, NAV_CAPSULE), diagnostic()).toBe(false);
        expect(inBounds(room.level, ...r.warden.p), diagnostic()).toBe(true);
      }
      expect(['chase', 'catch'], diagnostic()).toContain(r.warden.state);
      expect(room.tick / 20, diagnostic()).toBeLessThanOrEqual(90);
      expect(room.tick / 20, diagnostic()).toBeLessThanOrEqual(initialDeadline + TENSION.approachLead + .05);
      expect(room.players.has(r.warden.target), diagnostic()).toBe(true);
    }
  }, 120_000);

  it('actually sends a safe walking investigation after a quiet minute, in each level area', () => {
    for (const level of [0, 1]) for (const seed of [1, 2, 3]) {
      const { room, r, conns } = setup(seed, level, 1);
      const p = room.players.get(1)!;
      room.handle(conns[0], { t: 'debug', op: 'safe', s: 600, mob: 2 }, 0);
      // Isolate a quiet investigation from incidental patrol sightings and the L2 monitor.
      const original = r.warden.step.bind(r.warden);
      const originalHear = r.warden.hear.bind(r.warden);
      const heardAt: Vec3[] = [];
      const hear = vi.spyOn(r.warden, 'hear').mockImplementation((ev, blocked) => {
        const before: Vec3 = [...r.warden.p];
        originalHear(ev, blocked);
        expect(r.warden.p).toEqual(before); // scheduling never teleports
        heardAt.push(before);
      });
      r.warden.step = (dt) => original(dt, []);
      while (room.tick < 90 * 20 && !hear.mock.calls.length) room.step();
      expect(hear.mock.calls.length, JSON.stringify({ level, seed, from: r.warden.p, player: p.p, pacing: r.tension.status(room.tick / 20) })).toBeGreaterThan(0);
      const ev = hear.mock.calls[0][0], d = Math.hypot(ev.x - p.p[0], ev.z - p.p[2]);
      expect(room.tick / 20).toBeGreaterThanOrEqual(60);
      expect(room.tick / 20).toBeLessThanOrEqual(75.05);
      expect(d).toBeGreaterThanOrEqual(TENSION.standOff[0]);
      expect(d).toBeLessThanOrEqual(TENSION.standOff[1]);
      expect(inBounds(room.level, ev.x, ev.y, ev.z)).toBe(true);
      expect(Math.hypot(r.warden.p[0] - heardAt[0][0], r.warden.p[2] - heardAt[0][2])).toBeLessThanOrEqual(.24);
      expect(r.warden.state).toBe('investigate');
      r.warden.step = original;
      const from = [...r.warden.p];
      room.step();
      expect(Math.hypot(r.warden.p[0] - from[0], r.warden.p[1] - from[1], r.warden.p[2] - from[2])).toBeLessThanOrEqual(.24);
    }
  }, 120_000);

  it('does not restart a chase or respond to noise during the fixed respite; another room is unaffected', () => {
    const a = setup(8), b = setup(8), w = a.r.warden;
    const p = a.room.players.get(1)!;
    w.forceChase([p.p[0], p.p[1], p.p[2] - 1.5], Math.PI, 1, p.p);
    for (let i = 0; i < 200 && w.state !== 'catch'; i++) a.room.step();
    expect(w.state).toBe('catch');
    const caughtAt = a.room.tick / 20, until = a.r.tension.status(caughtAt).respiteUntil;
    expect(until - caughtAt).toBeGreaterThanOrEqual(20);
    expect(until - caughtAt).toBeLessThanOrEqual(30);
    const hear = vi.spyOn(w, 'hear');
    while (a.room.tick / 20 < until - .1) {
      a.room.emitNoise(p.p[0], p.p[2], 200, 'item', p.p[1], 2);
      a.room.step();
      expect(w.state).not.toBe('chase');
    }
    expect(hear).not.toHaveBeenCalled();
    expect(a.r.tension.status(a.room.tick / 20).respiteUntil).toBe(until);
    expect(b.r.tension.resting(b.room.tick / 20)).toBe(false);
  });

  it('enters respite before another visible teammate can replace a target who leaves between ticks', () => {
    const { room, r, conns } = setup(5), p = room.players.get(1)!;
    r.warden.forceChase([p.p[0] - 8, p.p[1], p.p[2]], -Math.PI / 2, 1, p.p);
    room.step();
    expect(r.warden.state).toBe('chase');
    expect(r.warden.target).toBe(1);
    room.remove(conns[0], 100);
    expect(r.warden.state).toBe('patrol');
    room.step();
    const until = r.tension.status(room.tick / 20).respiteUntil;
    expect(until - room.tick / 20).toBeGreaterThanOrEqual(20);
    expect(until - room.tick / 20).toBeLessThanOrEqual(30);
    while (room.tick / 20 < until - .05) {
      expect(r.warden.state).not.toBe('chase');
      expect(room.players.get(2)!.st).toBe(ST_OK);
      room.step();
    }
    expect(r.tension.status(room.tick / 20).respiteUntil).toBe(until);
  });

  it('broadcasts the same threat only to its room and does not consume another room’s scare cooldown', () => {
    const a = setup(8, 0, 2), b = setup(8, 0, 1, 101);
    const p = a.room.players.get(1)!;
    a.room.handle(a.conns[0], { t: 'debug', op: 'warden', d: 8 }, 0);
    a.room.step();
    b.room.step();
    const snapshots = (messages: ServerMsg[]) => messages.filter(m => m.t === 'snap');
    const aSnap = snapshots(a.received.get(1)!).at(-1)!;
    expect(aSnap).toEqual(snapshots(a.received.get(2)!).at(-1));
    expect(aSnap.players.map(p => p.id)).toEqual([1, 2]);
    expect(aSnap.mobs.find(m => m.id === 1)).toMatchObject({ anim: 'chase', target: p.conn.id });
    const bSnap = snapshots(b.received.get(101)!).at(-1)!;
    expect(bSnap.players.map(p => p.id)).toEqual([101]);
    for (const m of bSnap.mobs) if (m.target) expect(m.target).toBe(101);
    a.room.tick = b.room.tick = 50 * 20;
    for (const { room, r } of [a, b]) { r.tripNext = room.tick; r.stepTrip(); }
    expect(a.got.some(m => m.t === 'trip' && m.off > 0)).toBe(true);
    expect(b.got.some(m => m.t === 'trip' && m.off > 0)).toBe(true);
    expect(a.r.tension.status(50).lastScare).toBe(50);
    expect(b.r.tension.status(50).lastScare).toBe(50);
  });

  it('waits 60–90 s between real pursuits and rotates to the teammate after a genuine rescue', () => {
    const { room, r, conns } = setup(1), a = room.players.get(1)!, b = room.players.get(2)!;
    // Stage only the first encounter; the second must use real navigation, hearing and sight.
    a.yaw = Math.PI / 2;
    b.p = [a.p[0] - .5, a.p[1], a.p[2]];
    room.handle(conns[0], { t: 'debug', op: 'warden', d: 6 }, 0);
    room.step();
    expect(r.warden.state).toBe('chase');
    expect(r.warden.target).toBe(1);
    const firstTick = room.tick;
    while (room.tick < firstTick + 10 * 20 && r.warden.state !== 'catch') room.step();
    expect(r.warden.state).toBe('catch');
    expect(a.st).not.toBe(ST_OK);
    for (let i = 0; i < 4 * 20 && a.st !== ST_OK; i++) {
      room.handle(conns[1], { t: 'act', kind: 'revive', id: 1 }, room.tick * 50);
      room.step();
    }
    expect(a.st).toBe(ST_OK);
    expect(b.st).toBe(ST_OK);
    while (room.tick < firstTick + 90 * 20 && r.warden.state !== 'chase') room.step();
    const evidence = JSON.stringify({ tick: room.tick, firstTick, mob: r.warden.state, target: r.warden.target, pacing: r.tension.status(room.tick / 20) });
    expect(r.warden.state, evidence).toBe('chase');
    expect((room.tick - firstTick) / 20, evidence).toBeGreaterThanOrEqual(60);
    expect((room.tick - firstTick) / 20, evidence).toBeLessThanOrEqual(90);
    expect(r.warden.target, evidence).toBe(2);
    expect(a.st, evidence).toBe(ST_OK);
  });

  it('all natural trip sources share at least 45s; a level reload does not erase that cooldown', () => {
    const { room, r, got } = setup();
    room.tick = 1000;
    r.tripNext = room.tick;
    r.stepTrip();
    expect(got.filter(m => m.t === 'trip' && m.off > 0)).toHaveLength(2); // one broadcast per recipient
    const n = got.length;
    room.tick += 20 * 44;
    r.tripNext = room.tick;
    r.tripCool = 0;
    r.warden.state = 'chase'; // a different source tries during the same room cooldown
    r.stepTrip();
    expect(got.length).toBe(n);
    room.tick += 20;
    r.stepTrip();
    expect(got.filter(m => m.t === 'trip' && m.off > 0)).toHaveLength(4);
    r.loadLevel(1);
    room.fusesIn = 3;
    room.tick += 20 * 20;
    r.tripNext = room.tick;
    const positive = got.filter(m => m.t === 'trip' && m.off > 0).length;
    r.stepTrip();
    expect(got.filter(m => m.t === 'trip' && m.off > 0)).toHaveLength(positive);
  });

  it('allows a genuine chase to be escaped by breaking sight and keeps hidden unobserved players private', () => {
    const { room, r } = setup(5);
    const a = room.players.get(1)!, b = room.players.get(2)!;
    // A controlled LOS break uses the real AI lost-sight clock, without a teleport/chase override in the director.
    r.wardenEnv.los = () => false;
    b.f |= F_HIDE;
    r.warden.forceChase([...a.p], 0, 1, a.p);
    for (let i = 0; i < 6 * 20 + 2; i++) room.step();
    expect(r.warden.state).not.toBe('chase');
    expect(r.warden.caught).toEqual([]);
    expect(a.st).toBe(0);
    expect(b.st).toBe(0);
    expect(r.tension.status(room.tick / 20).phase).toBe('respite');
  });
});
