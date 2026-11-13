import { describe, expect, it } from 'vitest';
import { Room, type Conn } from '../../server/room.ts';
import { moveCapsule, groundHeight, overlaps, type Body } from '../../shared/campus/collision.ts';
import { NAV_CAPSULE } from '../../shared/campus/nav.ts';
import { L4, L4_INDEX } from '../../shared/levels/l4.ts';
import { F_HIDE, ST_DOWN, ST_SPECTATE, parseClientMsg, type ServerMsg, type Vec3 } from '../../shared/protocol.ts';

function setup() {
  const room = new Room('L4MV', 4, undefined, L4_INDEX);
  const messages: ServerMsg[] = [];
  const conn: Conn = { id: 1, name: '楼梯同学', send: m => messages.push(m), sendRaw: raw => messages.push(JSON.parse(raw)) };
  room.add(conn, 0);
  // Keep a standing teammate in the room while testing a downed or spectator player.
  room.add({ id: 2, name: '同伴', send: () => {}, sendRaw: () => {} }, 0);
  const player = room.players.get(conn.id)!;
  let seq = 0;
  const input = (p: Vec3, now = 500, f = 0) => {
    // These are ordinary wire inputs: no debug command or correction epoch bypass.
    const message = parseClientMsg(JSON.stringify({ t: 'input', seq: ++seq, p, yaw: 0, pitch: 0, f }));
    expect(message?.t).toBe('input');
    room.handle(conn, message!, now);
    return seq;
  };
  messages.length = 0;
  return { room, player, messages, input };
}

type Fixture = ReturnType<typeof setup>;
const body = (p: Vec3): Body => ({ x: p[0], y: p[1], z: p[2], vy: 0, grounded: true });

function expectSnapshotsAt({ room, player, messages }: Fixture, expected: Vec3) {
  const from = messages.length;
  for (let i = 0; i < 3; i++) room.step();
  const positions = messages.slice(from).flatMap(m => m.t === 'snap' ? m.players.filter(p => p.id === player.conn.id).map(p => p.p) : []);
  expect(positions.length).toBeGreaterThan(0);
  for (const p of positions) expect(p).toEqual(expected);
}

describe('L4 authoritative movement across floor slabs', () => {
  it('accepts a real multi-frame capsule slide around a shielding locker without a correction', () => {
    const fx = setup();
    // Two consecutive wire positions from the real browser: the straight chord clips the
    // rounded corner, while replaying the capsule with the shelter included stays clear.
    const start: Vec3 = [-33.288262441377476, 7.2, 129.97990000000001];
    const target: Vec3 = [-33.12844152053111, 7.2, 129.9835336140647];
    fx.player.p = [...start];
    fx.input(target);
    expect(fx.player.p).toEqual(target);
    expect(fx.messages.filter(m => m.t === 'correct')).toEqual([]);
  });

  it('still rejects a clear endpoint reached by jumping through a solid shielding locker', () => {
    const fx = setup(), start: Vec3 = [-33.5, 7.2, 129.9];
    fx.player.p = [...start]; fx.player.budget = 10;
    const seq = fx.input([-33.5, 7.2, 131.4]);
    expect(fx.player.p).toEqual(start);
    expect(fx.messages.at(-1)).toMatchObject({ t: 'correct', p: start, ack: seq });
  });

  it.each([
    { name: '3F to 4F', from: [-18, 7.2, 130], to: [-18, 10.8, 130] },
    { name: '4F to 3F', from: [-18, 10.8, 130], to: [-18, 7.2, 130] },
  ])('corrects a same-XZ ordinary input from $name', ({ from, to }) => {
    const fx = setup(), start = from as Vec3, target = to as Vec3;
    fx.player.p = [...start];
    // Both endpoints are valid standing positions. The intervening slab is the obstacle.
    for (const p of [start, target]) {
      expect(overlaps(fx.room.world, body(p), NAV_CAPSULE)).toBe(false);
      expect(groundHeight(fx.room.world, p[0], p[2], NAV_CAPSULE.radius, p[1] + NAV_CAPSULE.stepHeight)).toBeCloseTo(p[1]);
    }
    expect(overlaps(fx.room.world, body([-18, 9, 130]), NAV_CAPSULE)).toBe(true);
    const beforeEpoch = fx.player.c, seq = fx.input(target);
    expect(fx.player.p).toEqual(start);
    expect(fx.messages.at(-1)).toMatchObject({ t: 'correct', p: start, ack: seq });
    expect(fx.player.c).toBeGreaterThan(beforeEpoch);
    expectSnapshotsAt(fx, start);
  });

  it.each([
    { name: 'upward', from: [-18, 7.2, 130], to: [-17.75, 10.8, 130.2] },
    { name: 'downward', from: [-18, 10.8, 130], to: [-17.75, 7.2, 130.2] },
  ])('rejects an $name diagonal floor jump despite sufficient horizontal budget', ({ from, to }) => {
    const fx = setup(), start = from as Vec3, target = to as Vec3;
    fx.player.p = [...start];
    fx.player.budget = 10;
    const seq = fx.input(target);
    expect(fx.player.p).toEqual(start);
    expect(fx.messages.at(-1)).toMatchObject({ t: 'correct', p: start, ack: seq });
    expectSnapshotsAt(fx, start);
  });

  it('accepts capsule-predicted movement up and down the real 3F/4F stairs without corrections', () => {
    const fx = setup(), p = body(fx.player.p);
    // Enter through the real stair doorway, take both flights, then return through the upper doorway.
    const route: [number, number][] = [
      [-14.5, 130], [-14.5, 134.13], [-12.1, 134.13], [-12, 132.74],
      [-5.94, 132.74], [-5.94, 135.52], [-12, 135.52], [-12.1, 134.13],
      [-13.65, 134.13], [-14.5, 130],
    ];
    let now = 0, accepted = 0;
    const heights: number[] = [];
    const follow = (points: [number, number][]) => {
      for (const [x, z] of points) {
        let arrived = false;
        for (let guard = 0; guard < 400; guard++) {
          const dx = x - p.x, dz = z - p.z, distance = Math.hypot(dx, dz);
          if (distance < .06) { arrived = true; break; }
          const step = Math.min(.13, distance) / distance;
          moveCapsule(fx.room.world, p, dx * step, dz * step, .05, NAV_CAPSULE);
          now += 50;
          fx.input([p.x, p.y, p.z], now);
          accepted++;
          heights.push(p.y);
          expect(fx.player.p, `predicted stair position at input ${accepted}`).toEqual([p.x, p.y, p.z]);
        }
        expect(arrived, `capsule reached stair waypoint (${x}, ${z})`).toBe(true);
      }
    };
    follow(route);
    expect(p.y).toBeCloseTo(10.8);
    follow([...route].reverse());
    expect(p.y).toBeCloseTo(7.2);
    expect(accepted).toBeGreaterThan(200);
    expect(heights.some(y => y > 7.5 && y < 10.5)).toBe(true);
    expect(fx.messages.filter(m => m.t === 'correct')).toEqual([]);
    expectSnapshotsAt(fx, [Math.round(p.x * 100) / 100, 7.2, Math.round(p.z * 100) / 100]);
  });

  it.each([ST_DOWN, ST_SPECTATE])('corrects a pure height claim while player state is %s', st => {
    const fx = setup(), start: Vec3 = [...fx.player.p];
    fx.player.st = st;
    const beforeEpoch = fx.player.c;
    fx.input([start[0], 10.8, start[2]]);
    expect(fx.player.p).toEqual(start);
    expect(fx.messages.at(-1)).toMatchObject({ t: 'correct', p: start });
    expect(fx.player.c).toBeGreaterThan(beforeEpoch);
    expectSnapshotsAt(fx, start);
  });

  it.each([0, 1, 2, 3])('corrects a pure height claim while authoritatively hidden in L4 shelter %s', id => {
    const fx = setup(), hide = L4.hides[id];
    fx.player.p = [hide.x, hide.y!, hide.z - .6];
    expect(fx.room.hideIn(fx.player, id)).toBe(true);
    const start: Vec3 = [...fx.player.p];
    const beforeEpoch = fx.player.c;
    fx.messages.length = 0;
    fx.input([start[0], hide.y === 7.2 ? 10.8 : 7.2, start[2]]);
    expect(fx.player.p).toEqual(start);
    expect(fx.player.hide).toBeDefined();
    expect(fx.player.f & F_HIDE).toBe(F_HIDE);
    expect(fx.messages.at(-1)).toMatchObject({ t: 'correct', p: start });
    expect(fx.player.c).toBeGreaterThan(beforeEpoch);
    expectSnapshotsAt(fx, start);
  });
});
