import { describe, expect, it } from 'vitest';
import type { ServerMsg, Vec3 } from '../../shared/protocol.ts';
import { RoomManager, type Conn } from '../../server/room.ts';
import { SPEED } from '../../shared/constants.ts';
import { mulberry32 } from '../../shared/rng.ts';
import { moveCapsule, type Body } from '../../shared/campus/collision.ts';
import { NAV_CAPSULE } from '../../shared/campus/nav.ts';
import { MoveLog } from '../../client/src/reconcile.ts';
import { CorrectionSmoother } from '../../client/src/interp.ts';

function setup() {
  const room = new RoomManager(mulberry32(3)).create();
  const got: ServerMsg[] = [];
  const c: Conn = { id: 1, name: 'p1', send: (m) => got.push(m), sendRaw: (s) => got.push(JSON.parse(s)) };
  room.add(c, 0);
  return { room, c, got, pl: room.players.get(1)! };
}
const corrects = (got: ServerMsg[]) => got.filter((m) => m.t === 'correct');

/** A direction from the spawn along which 50 ms running steps of moveCapsule go straight for `len` m (nothing in the way). */
function clearLine(room: ReturnType<typeof setup>['room'], p: number[], len: number) {
  const step = SPEED.run * 0.05;
  for (let k = 0; k < 72; k++) {
    const a = (k / 72) * Math.PI * 2, ux = Math.cos(a), uz = Math.sin(a);
    const b: Body = { x: p[0], y: p[1], z: p[2], vy: 0, grounded: true };
    const pts: [number, number, number][] = [];
    for (let i = 0; i < Math.ceil(len / step); i++) { moveCapsule(room.world!, b, ux * step, uz * step, 0.05, NAV_CAPSULE); pts.push([b.x, b.y, b.z]); }
    if (Math.hypot(b.x - p[0] - ux * len, b.z - p[2] - uz * len) < 0.05 + step && Math.abs(b.y - p[1]) < 0.01) return pts;
  }
  throw new Error('no clear line near the spawn');
}

describe('movement budget (sliding-window distance cap)', () => {
  it('accepts steady running and bunched packets, rejects a 10 m teleport even after idling', () => {
    const { room, c, got, pl } = setup();
    const pts = clearLine(room, pl.p, 44 * SPEED.run * 0.05 + 0.3); // 2.2 s of running
    let now = 1000, seq = 0;
    for (const p of pts.slice(0, 40)) room.handle(c, { t: 'input', seq: ++seq, p, yaw: 0, pitch: 0, f: 2 }, (now += 50));
    // jitter: 200 ms silence, then four 50 ms steps in the same instant
    now += 200;
    for (const p of pts.slice(40, 44)) room.handle(c, { t: 'input', seq: ++seq, p, yaw: 0, pitch: 0, f: 2 }, now);
    expect(corrects(got)).toEqual([]);
    expect(pl.p).toEqual(pts[43]);
    // 10 s standing still refills only up to the cap (run 6 × 1.3 + 0.5 ≈ 8.3 m), so a 10 m jump down the same clear line is refused
    // walk back to the start of the line first, then jump to its far end in one packet
    const start = pts[0];
    for (const p of [...pts.slice(0, 43)].reverse()) room.handle(c, { t: 'input', seq: ++seq, p, yaw: 0, pitch: 0, f: 2 }, (now += 50));
    expect(corrects(got)).toEqual([]);
    now += 10_000;
    const end = pts.find((q) => Math.hypot(q[0] - start[0], q[2] - start[2]) > 10)!;
    expect(Math.hypot(end[0] - start[0], end[2] - start[2])).toBeLessThan(10.5);
    room.handle(c, { t: 'input', seq: ++seq, p: end, yaw: 0, pitch: 0, f: 2 }, now);
    expect(got.at(-1)).toEqual({ t: 'correct', p: start, c: 1, ack: seq });
    expect(pl.p).toEqual(start);
  });

  it('accepts sliding past box corners that a straight chord would clip', () => {
    for (const [a, b] of [[[-36.55, 0, 66.44], [-36.51, 0, 66.64]], [[-36.54, 0, 66.56], [-36.37, 0, 66.81]]] as [Vec3, Vec3][]) {
      const { room, c, got, pl } = setup();
      pl.p = a; pl.lastInput = 950; pl.budgetAt = 950; pl.budget = 1;
      room.handle(c, { t: 'input', seq: 1, p: b, yaw: 0, pitch: 0, f: 2 }, 1000);
      expect(corrects(got)).toEqual([]);
      expect(pl.p).toEqual(b);
    }
  });
});

describe('correction epoch + ack', () => {
  it('ignores the movement of inputs sent before the last correction arrived, accepts the next epoch', () => {
    const { room, c, got, pl } = setup();
    const pts = clearLine(room, pl.p, 2);
    const start = [...pl.p];
    room.handle(c, { t: 'input', seq: 1, p: [start[0] + 30, start[1], start[2]], yaw: 0, pitch: 0, f: 0 }, 500);
    expect(got.at(-1)).toEqual({ t: 'correct', p: start, c: 1, ack: 1 });
    const n = got.length;
    // in flight before the correction landed: c is still 0 → look only, no second correction
    room.handle(c, { t: 'input', seq: 2, p: [start[0] + 30.2, start[1], start[2]], yaw: 1.25, pitch: 0.5, f: 0, c: 0 }, 550);
    expect(got.length).toBe(n);
    expect(pl.p).toEqual(start);
    expect(pl.yaw).toBe(1.25);
    room.handle(c, { t: 'input', seq: 3, p: pts[0], yaw: 0, pitch: 0, f: 0, c: 1 }, 600);
    expect(got.length).toBe(n);
    expect(pl.p).toEqual(pts[0]);
  });
});

describe('MoveLog (client replay of unacknowledged moves)', () => {
  it('drops the refused input and older ones, replays the rest with moveCapsule from the server position', () => {
    const { room } = setup();
    const w = room.world!;
    const log = new MoveLog();
    for (let s = 1; s <= 10; s++) log.push({ seq: s, dx: 0.1, dz: 0.05, dt: 0.05 });
    const p: [number, number, number] = [-36.55, 0, 66.44];
    const b = log.replay(w, p, 6, NAV_CAPSULE);
    expect(log.size).toBe(4);
    const ref: Body = { x: p[0], y: p[1], z: p[2], vy: 0, grounded: true };
    for (let i = 0; i < 4; i++) moveCapsule(w, ref, 0.1, 0.05, 0.05, NAV_CAPSULE);
    expect(b).toEqual(ref);
    // replaying an ack past everything leaves the server position as is
    expect(log.replay(w, p, 99, NAV_CAPSULE)).toMatchObject({ x: p[0], y: p[1], z: p[2] });
    expect(log.size).toBe(0);
  });

  it('keeps at most `cap` moves', () => {
    const log = new MoveLog(5);
    for (let s = 1; s <= 12; s++) log.push({ seq: s, dx: 0, dz: 0, dt: 0.05 });
    expect(log.size).toBe(5);
    log.clear();
    expect(log.size).toBe(0);
  });
});

describe('CorrectionSmoother tau override', () => {
  it('a kick with a shorter tau decays faster, the next plain kick goes back to the default', () => {
    const a = new CorrectionSmoother(0.1), b = new CorrectionSmoother(0.1);
    const o = { x: 0, y: 0, z: 0 }, to = { x: -0.2, y: 0, z: 0 };
    a.kick(o, to); b.kick(o, to, 0.03);
    a.step(0.05); b.step(0.05);
    expect(a.x).toBeCloseTo(0.2 * Math.exp(-0.5));
    expect(b.x).toBeCloseTo(0.2 * Math.exp(-0.05 / 0.03));
    b.reset(); b.kick(o, to); b.step(0.05);
    expect(b.x).toBeCloseTo(0.2 * Math.exp(-0.5));
  });
});
