import { describe, expect, it } from 'vitest';
import { CollisionWorld, moveCapsule, type Body } from '../../shared/campus/collision.ts';
import { lineOfSight, NAV_CAPSULE } from '../../shared/campus/nav.ts';
import { MIRRORS, mirrorForPlayer, mirrorPoint } from '../../shared/levels/l7.ts';
import { ST_DOWN, ST_SPECTATE, type Vec3 } from '../../shared/protocol.ts';
import {
  MirrorAI, MIRROR_CATCH_R, MIRROR_CHASE_S, MIRROR_CHASE_SPEED, MIRROR_COOLDOWN_S,
  MIRROR_DELAY_S, MIRROR_EMERGE_M, MIRROR_STILL_S, type MirrorEnv, type MirrorPlayer,
} from '../../server/ai/mirror.ts';

const DT = 0.05;
const clone = (p: Vec3): Vec3 => [p[0], p[1], p[2]];
const viewer = (id = 1, floor = 0, ahead = 2.7): MirrorPlayer => {
  const m = MIRRORS[floor];
  return { id, p: [m.center[0] + m.normal[0] * ahead, m.center[1] - 1.45, m.center[2] + m.normal[2] * ahead], yaw: Math.PI / 2, pitch: 0 };
};
const blocked = (): MirrorEnv => ({ move: (from) => clone(from), walkable: () => false, los: () => true });
const open = (): MirrorEnv => ({ move: (_from, to) => clone(to), los: () => true });
const run = (ai: MirrorAI, seconds: number, players: MirrorPlayer[], dt = DT): void => {
  let left = seconds;
  while (left > 1e-8) { const used = Math.min(left, dt); ai.step(used, players); left -= used; }
};
const only = (ai: MirrorAI) => { expect(ai.snapshots()).toHaveLength(1); return ai.snapshots()[0]; };

describe('MirrorAI delayed pose', () => {
  it('keeps 0.6 seconds of position and yaw history and interpolates between samples', () => {
    const ai = new MirrorAI(blocked()), p = viewer();
    p.yaw -= 0.15;
    ai.step(0, [p]);
    const initial = clone(p.p), yaw = p.yaw;
    p.p[2] += 0.6; p.yaw += 0.3;
    ai.step(0.4, [p]);
    expect(only(ai).p).toEqual(initial);
    expect(only(ai).yaw).toBeCloseTo(yaw);
    ai.step(0.4, [p]); // delayed time 0.2, halfway between the samples at 0 and 0.4
    expect(only(ai).p[2]).toBeCloseTo(initial[2] + 0.3);
    expect(only(ai).yaw).toBeCloseTo(yaw + 0.15);
    ai.step(0.2, [p]);
    expect(only(ai).p[2]).toBeCloseTo(p.p[2]);
    expect(only(ai).yaw).toBeCloseTo(p.yaw);
    expect(only(ai).p[0]).toBeCloseTo(p.p[0]); // snapshot is real-space; renderer applies mirrorPoint
    expect(mirrorPoint(MIRRORS[0], only(ai).p)[0]).not.toBeCloseTo(p.p[0]);
  });

  it('follows moving poses at 0.6 seconds for every server tick', () => {
    const ai = new MirrorAI(blocked()), p = viewer(), z = p.p[2];
    ai.step(0, [p]);
    for (let i = 1; i <= 40; i++) {
      const t = i * DT;
      p.p[2] = z + 0.2 * t; p.yaw = Math.PI / 2 + 0.03 * t;
      ai.step(DT, [p]);
      const delayed = Math.max(0, t - MIRROR_DELAY_S), snap = only(ai);
      expect(snap.p[2]).toBeCloseTo(z + 0.2 * delayed, 7);
      expect(snap.yaw).toBeCloseTo(Math.PI / 2 + 0.03 * delayed, 7);
      if (t > MIRROR_DELAY_S + DT) { expect(snap.phase).toBe('follow'); expect(snap.stillFor).toBe(0); }
    }
  });

  it.each([-0.3, 0.3])('delays upward and downward pitch and interpolates from %s', (pitch) => {
    const ai = new MirrorAI(blocked()), p = viewer();
    p.pitch = pitch;
    ai.step(0, [p]);
    p.pitch = -pitch;
    ai.step(0.4, [p]);
    expect(only(ai).pitch).toBeCloseTo(pitch);
    ai.step(0.4, [p]);
    expect(only(ai).pitch).toBeCloseTo(0); // delayed time 0.2, midway through the turn
    expect(only(ai).phase).toBe('follow');
    ai.step(0.2, [p]);
    expect(only(ai).pitch).toBeCloseTo(-pitch);
  });

  it('treats an omitted pitch as level and identical to explicit zero', () => {
    const ai = new MirrorAI(blocked()), p = viewer();
    delete p.pitch;
    ai.step(0, [p]);
    expect(only(ai).pitch).toBe(0);
    ai.step(1, [p]);
    p.pitch = 0;
    ai.step(1, [p]);
    expect(only(ai).pitch).toBe(0);
    expect(only(ai).stillFor).toBeCloseTo(2);
  });

  it('treats equivalent yaw angles as still and never interpolates the long rotation', () => {
    const ai = new MirrorAI(blocked()), p = viewer();
    ai.step(0, [p]);
    p.yaw += Math.PI * 2;
    ai.step(1, [p]);
    expect(only(ai).yaw).toBeCloseTo(Math.PI / 2);
    expect(only(ai).stillFor).toBeCloseTo(1);
  });

  it('returns defensive snapshots and copies the mutable input poses', () => {
    const ai = new MirrorAI(blocked()), p = viewer();
    ai.step(0, [p]);
    const original = clone(p.p), snapshot = only(ai);
    snapshot.p[0] = 999; snapshot.stillFor = 999; snapshot.pitch = 999;
    p.p[2] += 0.4;
    ai.step(0.1, [p]);
    expect(only(ai).p).toEqual(original);
    expect(only(ai).stillFor).toBeCloseTo(0.1);
    expect(only(ai).pitch).toBe(0);
  });
});

describe('MirrorAI individual state machine', () => {
  it('stands for five seconds, pursues for four, then cools down and follows again', () => {
    const ai = new MirrorAI(blocked()), p = viewer();
    ai.step(0, [p]);
    expect(only(ai).phase).toBe('follow');
    run(ai, MIRROR_STILL_S - DT, [p]);
    expect(only(ai).phase).toBe('still');
    expect(only(ai).stillFor).toBeCloseTo(MIRROR_STILL_S - DT);
    ai.step(DT, [p]);
    expect(only(ai).phase).toBe('chase');
    expect(only(ai).chaseLeft).toBeCloseTo(MIRROR_CHASE_S);
    expect(only(ai).p[0]).toBeCloseTo(MIRRORS[0].center[0] + MIRROR_EMERGE_M);
    run(ai, MIRROR_CHASE_S - DT, [p]);
    expect(only(ai).phase).toBe('chase');
    expect(only(ai).chaseLeft).toBeCloseTo(DT);
    ai.step(DT, [p]);
    expect(ai.snapshots()).toEqual([]);
    run(ai, MIRROR_COOLDOWN_S - DT, [p]);
    expect(ai.snapshots()).toEqual([]);
    ai.step(DT, [p]);
    expect(only(ai).phase).toBe('follow');
    expect(only(ai).stillFor).toBe(0);
    ai.step(DT, [p]);
    expect(only(ai).phase).toBe('still');
    expect(only(ai).stillFor).toBeCloseTo(DT);
  });

  it.each([0.013, 0.05, 0.2, 0.7])('uses elapsed seconds at dt=%s, including partial transition ticks', (dt) => {
    const ai = new MirrorAI(blocked()), p = viewer();
    ai.step(0, [p]);
    run(ai, 5.25, [p], dt);
    expect(only(ai).phase).toBe('chase');
    expect(only(ai).chaseLeft).toBeCloseTo(3.75, 7);
    run(ai, 3.75, [p], dt);
    expect(ai.snapshots()).toEqual([]);
    run(ai, 1.25, [p], dt);
    expect(only(ai).phase).toBe('still');
    expect(only(ai).stillFor).toBeCloseTo(0.25, 7);
  });

  it.each(['yaw', 'pitch'] as const)('resets the five seconds when the delayed reflection turns its %s', (angle) => {
    const ai = new MirrorAI(blocked()), p = viewer();
    ai.step(0, [p]);
    run(ai, 3.5, [p]);
    p[angle] = (p[angle] ?? 0) + 0.15;
    ai.step(0.1, [p]);
    run(ai, 0.6, [p]); // the delayed turn occupies 4.1..4.2 s
    expect(only(ai).phase).toBe('follow');
    expect(only(ai).stillFor).toBe(0);
    run(ai, 4.95, [p]);
    expect(only(ai).phase).toBe('still');
    expect(only(ai).stillFor).toBeCloseTo(4.95);
    ai.step(DT, [p]);
    expect(only(ai).phase).toBe('chase');
  });

  it('counts from the delayed stop, not the tick when the player stops moving', () => {
    const ai = new MirrorAI(blocked()), p = viewer(), initial = p.p[2];
    ai.step(0, [p]);
    for (let i = 1; i <= 20; i++) { p.p[2] = initial + i * 0.02; ai.step(DT, [p]); }
    run(ai, MIRROR_DELAY_S, [p]);
    expect(only(ai).phase).toBe('follow');
    expect(only(ai).stillFor).toBe(0);
    run(ai, MIRROR_STILL_S - DT, [p]);
    expect(only(ai).phase).toBe('still');
    expect(only(ai).stillFor).toBeCloseTo(MIRROR_STILL_S - DT);
    ai.step(DT, [p]);
    expect(only(ai).phase).toBe('chase');
  });

  it('keeps separate entry times and cancels one chase even while a teammate watches', () => {
    const ai = new MirrorAI(blocked()), a = viewer(1), b = viewer(2);
    ai.step(0, [a]); run(ai, 2, [a]);
    ai.step(0, [a, b]); run(ai, 3, [a, b]);
    const first = ai.snapshots();
    expect(first.find((s) => s.id === a.id)?.phase).toBe('chase');
    expect(first.find((s) => s.id === b.id)?.stillFor).toBeCloseTo(3);
    a.yaw = -Math.PI / 2;
    ai.step(0, [a, b]);
    expect(only(ai).id).toBe(b.id);
    expect(only(ai).stillFor).toBeCloseTo(3);
    a.yaw = Math.PI / 2;
    ai.step(0, [a, b]); run(ai, 2, [a, b]);
    expect(ai.snapshots().find((s) => s.id === a.id)?.stillFor).toBeCloseTo(2);
    expect(ai.snapshots().find((s) => s.id === b.id)?.phase).toBe('chase');
  });

  it('a moving teammate neither resets nor advances another player’s timer', () => {
    const ai = new MirrorAI(blocked()), a = viewer(1), b = viewer(2), bz = b.p[2];
    ai.step(0, [a, b]);
    for (let i = 1; i <= 100; i++) { b.p[2] = bz + Math.sin(i * DT) * 0.2; b.yaw = Math.PI / 2 + Math.sin(i * DT) * 0.1; ai.step(DT, [a, b]); }
    expect(ai.snapshots().find((s) => s.id === a.id)?.phase).toBe('chase');
    expect(ai.snapshots().find((s) => s.id === b.id)?.phase).toBe('follow');
    expect(ai.snapshots().find((s) => s.id === b.id)?.stillFor).toBe(0);
  });

  it('keeps a pitching teammate in follow independently of a stationary player’s chase', () => {
    const ai = new MirrorAI(blocked()), a = viewer(1), b = viewer(2);
    ai.step(0, [a, b]);
    for (let i = 1; i <= 120; i++) {
      b.pitch = Math.sin(i * DT) * 0.25;
      ai.step(DT, [a, b]);
      const snap = ai.snapshots().find((s) => s.id === b.id)!;
      expect(snap.pitch).toBeCloseTo(Math.sin(Math.max(0, i * DT - MIRROR_DELAY_S)) * 0.25, 7);
      if (i * DT > MIRROR_DELAY_S + DT) { expect(snap.phase).toBe('follow'); expect(snap.stillFor).toBe(0); }
    }
    expect(ai.snapshots().find((s) => s.id === a.id)?.phase).toBe('chase');
  });
});

describe('MirrorAI visibility and lifetime', () => {
  it.each([0, 1])('uses the same geometry on mirror floor %s and rejects all back/side directions', (floor) => {
    const ai = new MirrorAI(blocked()), p = viewer(1, floor);
    expect(mirrorForPlayer(p.p, p.yaw)?.id).toBe(MIRRORS[floor].id);
    for (const yaw of [Math.PI / 2, Math.PI / 2 + 2 * Math.PI]) {
      p.yaw = yaw; ai.step(0, [p]);
      expect(only(ai).mirrorId).toBe(MIRRORS[floor].id);
    }
    for (const yaw of [-Math.PI / 2, 0, Math.PI]) {
      p.yaw = yaw; ai.step(0, [p]); expect(ai.snapshots()).toEqual([]);
    }
    p.yaw = Math.PI / 2; p.pitch = Math.PI / 2;
    ai.step(0, [p]); expect(ai.snapshots()).toEqual([]);
  });

  it.each(['back', 'look-up', 'look-down', 'leave', 'down', 'spectate', 'disconnect', 'occlude'] as const)('immediately deletes active chase and history on %s', (kind) => {
    let visible = true;
    const ai = new MirrorAI({ ...blocked(), los: () => visible }), p = viewer();
    ai.step(0, [p]); run(ai, 5.1, [p]);
    expect(only(ai).phase).toBe('chase');
    const initial = clone(p.p);
    if (kind === 'back') p.yaw = -Math.PI / 2;
    if (kind === 'look-up') p.pitch = Math.PI / 2;
    if (kind === 'look-down') p.pitch = -Math.PI / 2;
    if (kind === 'leave') p.p = [0, 0, 0];
    if (kind === 'down') p.st = ST_DOWN;
    if (kind === 'spectate') p.st = ST_SPECTATE;
    if (kind === 'occlude') visible = false;
    ai.step(0, kind === 'disconnect' ? [] : [p]);
    expect(ai.snapshots()).toEqual([]); expect(ai.caught).toEqual([]);
    p.p = initial; p.yaw = Math.PI / 2; p.pitch = 0; p.st = 0; visible = true;
    ai.step(0, [p]);
    expect(only(ai).phase).toBe('follow'); expect(only(ai).stillFor).toBe(0);
    run(ai, 4.9, [p]); expect(only(ai).phase).toBe('still');
  });

  it('forgets disconnected players independently and can reset a room', () => {
    const ai = new MirrorAI(blocked()), a = viewer(1), b = viewer(2, 1);
    ai.step(0, [a, b]); run(ai, 3, [a, b]);
    ai.forget(a.id);
    expect(only(ai).id).toBe(b.id); expect(only(ai).stillFor).toBeCloseTo(3);
    ai.reset(); expect(ai.snapshots()).toEqual([]); expect(ai.caught).toEqual([]);
    ai.step(0, [a, b]); expect(ai.snapshots().every((s) => s.stillFor === 0)).toBe(true);
  });
});

describe('MirrorAI authoritative pursuit', () => {
  it('retains the exact contact source after deleting the reflection, then clears it on the next tick', () => {
    let moved: Vec3 = [0, 0, 0];
    const ai = new MirrorAI({
      move: (from, to, maxStep) => {
        const length = Math.hypot(...to.map((v, i) => v - from[i]));
        const k = length ? Math.min(1, maxStep / length) : 0;
        moved = from.map((v, i) => v + (to[i] - v) * k) as Vec3;
        return [...moved];
      },
      walkable: () => true,
      los: () => true,
    });
    const player = viewer();
    ai.step(0, [player]);
    for (let i = 0; i < 150 && !ai.caught.length; i++) ai.step(DT, [player]);
    expect(ai.caught).toEqual([player.id]);
    expect(ai.snapshots()).toEqual([]);
    expect(ai.caughtSources.get(player.id)).toEqual(moved);
    const gap = Math.hypot(...moved.map((v, i) => v - player.p[i]));
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThanOrEqual(MIRROR_CATCH_R);
    ai.step(DT, [{ ...player, st: ST_DOWN }]);
    expect(ai.caughtSources.size).toBe(0);
  });

  it('moves at the chase speed through the server callback and catches only its owner once', () => {
    const ai = new MirrorAI(open()), a = viewer(1), b = viewer(2, 0, MIRROR_EMERGE_M + 0.02);
    ai.step(0, [a]); run(ai, 4.9, [a]); ai.step(0, [a, b]); run(ai, 0.1, [a, b]);
    const start = ai.snapshots().find((s) => s.id === a.id)!;
    expect(start.phase).toBe('chase');
    ai.step(0.05, [a, b]);
    const after = ai.snapshots().find((s) => s.id === a.id)!;
    expect(after.p[0] - start.p[0]).toBeCloseTo(MIRROR_CHASE_SPEED * 0.05);
    expect(ai.caught).toEqual([]); // teammate b stands beside a's figure, but is never its prey
    const hits: number[] = [];
    for (let i = 0; i < 30; i++) { ai.step(DT, [a, b]); hits.push(...ai.caught); }
    expect(hits).toEqual([a.id]);
    expect(ai.snapshots().find((s) => s.id === a.id)?.phase).not.toBe('chase');
    ai.step(DT, [{ ...a, st: ST_DOWN }, b]);
    expect(ai.caught).toEqual([]); expect(only(ai).id).toBe(b.id);
  });

  it('accepts a walkable callback without a movement resolver', () => {
    const ai = new MirrorAI({ walkable: () => true }), p = viewer();
    ai.step(0, [p]); run(ai, 5, [p]);
    const start = only(ai).p[0]; ai.step(DT, [p]);
    expect(only(ai).p[0] - start).toBeCloseTo(MIRROR_CHASE_SPEED * DT);
  });

  it('cannot cross low geometry or catch through a thin wall within the catch radius', () => {
    const p = viewer(1, 0, MIRROR_EMERGE_M + MIRROR_CATCH_R), m = MIRRORS[0];
    const wallX = m.center[0] + MIRROR_EMERGE_M + 0.4;
    const world = new CollisionWorld([{ minX: wallX - 0.02, maxX: wallX + 0.02, minY: 0, maxY: 0.9, minZ: m.center[2] - 2, maxZ: m.center[2] + 2 }]);
    const move = (from: Vec3, to: Vec3, maxStep: number): Vec3 => {
      const body: Body = { x: from[0], y: from[1], z: from[2], grounded: true, vy: 0 };
      moveCapsule(world, body, to[0] - from[0], to[2] - from[2], maxStep / MIRROR_CHASE_SPEED, NAV_CAPSULE);
      return [body.x, body.y, body.z];
    };
    const ai = new MirrorAI({ move, los: (a, b) => lineOfSight(world, { x: a[0], y: a[1], z: a[2] }, { x: b[0], y: b[1], z: b[2] }) });
    ai.step(0, [p]); run(ai, 5, [p]);
    expect(only(ai).phase).toBe('chase');
    for (let i = 0; i < 79; i++) {
      ai.step(DT, [p]); const snap = only(ai);
      expect(snap.p[0]).toBeLessThan(wallX - 0.02);
      expect(ai.caught).toEqual([]);
    }
    expect(p.p[0] - only(ai).p[0]).toBeLessThan(MIRROR_CATCH_R);
    ai.step(DT, [p]); expect(ai.snapshots()).toEqual([]);
  });

  it('requires the server to provide collision authority', () => {
    expect(() => new MirrorAI({})).toThrow(/collision/);
  });
});
