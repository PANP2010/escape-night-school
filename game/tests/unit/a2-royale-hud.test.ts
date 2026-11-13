import { test, expect } from 'vitest';
import { formatClock, zoneHeadline, nextZoneOf, zoneGuide, bearingDeg, fogTarget, fogLevel, OutTimer, type ZoneSnap } from '../../client/src/royaleHud.ts';
import { generateZonePhases } from '../../shared/royale.ts';

test('formatClock: m:ss with rounding up so 0:00 never shows while time remains', () => {
  expect(formatClock(0)).toBe('0:00');
  expect(formatClock(999)).toBe('0:01'); // rounds up to 1 s
  expect(formatClock(1000)).toBe('0:01');
  expect(formatClock(1001)).toBe('0:02');
  expect(formatClock(59999)).toBe('1:00');
  expect(formatClock(60000)).toBe('1:00');
  expect(formatClock(60001)).toBe('1:01');
  expect(formatClock(125000)).toBe('2:05');
  expect(formatClock(Infinity)).toBe('0:00');
  expect(formatClock(-10)).toBe('0:00');
});

test('zoneHeadline: phase 0 shows grace countdown, 1..4 show shrink phase, final says no more shrinks', () => {
  expect(zoneHeadline({ phase: 0, remainingMs: 60000 })).toBe('1:00 后安全区开始收缩');
  expect(zoneHeadline({ phase: 0, remainingMs: 999 })).toBe('0:01 后安全区开始收缩');
  expect(zoneHeadline({ phase: 1, remainingMs: 45000 })).toBe('第 1/4 圈 · 0:45 后再缩');
  expect(zoneHeadline({ phase: 2, remainingMs: 30000 })).toBe('第 2/4 圈 · 0:30 后再缩');
  expect(zoneHeadline({ phase: 4, remainingMs: 0 })).toBe('最终圈 · 不再缩小');
  expect(zoneHeadline({ phase: 5, remainingMs: 0 })).toBe('最终圈 · 不再缩小');
});

test('nextZoneOf: returns phase+1 when snap matches generated table, undefined when out of sync', () => {
  const phases = generateZonePhases(9527);
  const snap1: ZoneSnap = { phase: 1, center: [phases[1].center[0], phases[1].center[1]], radius: phases[1].radius, remainingMs: 30000, alive: 5 };
  expect(nextZoneOf(phases, snap1)).toEqual(phases[2]);
  const snap0: ZoneSnap = { phase: 0, center: [phases[0].center[0], phases[0].center[1]], radius: phases[0].radius, remainingMs: 50000, alive: 8 };
  expect(nextZoneOf(phases, snap0)).toEqual(phases[1]);
  const snap4: ZoneSnap = { phase: 4, center: [phases[4].center[0], phases[4].center[1]], radius: phases[4].radius, remainingMs: 0, alive: 2 };
  expect(nextZoneOf(phases, snap4)).toBeUndefined(); // no phase 5
  const snapWrong: ZoneSnap = { phase: 1, center: [99, 99], radius: 100, remainingMs: 30000, alive: 5 }; // mismatch
  expect(nextZoneOf(phases, snapWrong)).toBeUndefined();
});

test('zoneGuide: out when outside cur, warn when in cur but out of next, safe otherwise', () => {
  const cur = { center: [0, 100] as const, radius: 50 };
  const next = { center: [10, 110] as const, radius: 30 };
  expect(zoneGuide(cur, next, { x: 0, z: 100 }).state).toBe('safe'); // centre
  expect(zoneGuide(cur, next, { x: 0, z: 148 }).state).toBe('warn'); // 2 m inside cur edge, but 39 m from next's centre (radius 30)
  expect(zoneGuide(cur, next, { x: 0, z: 151 }).state).toBe('out'); // 1 m outside cur
  expect(zoneGuide(cur, next, { x: 0, z: 70 }).state).toBe('warn'); // inside cur but > 30 m from next centre
  expect(zoneGuide(cur, next, { x: 10, z: 110 }).state).toBe('safe'); // next centre
  expect(zoneGuide(cur, undefined, { x: 0, z: 100 }).state).toBe('safe'); // no next = final circle
  expect(zoneGuide(cur, undefined, { x: 60, z: 100 }).state).toBe('out');
});

test('zoneGuide: metres gives distance to enter target or to edge when safe', () => {
  const cur = { center: [0, 100] as const, radius: 50 };
  const next = { center: [0, 100] as const, radius: 30 };
  const g1 = zoneGuide(cur, next, { x: 0, z: 151 });
  expect(g1.state).toBe('out');
  expect(g1.metres).toBeCloseTo(1, 1); // 1 m outside
  const g2 = zoneGuide(cur, next, { x: 0, z: 100 });
  expect(g2.state).toBe('safe');
  expect(g2.metres).toBeCloseTo(30, 1); // 30 m to next edge
});

test('bearingDeg: clockwise from straight ahead; yaw 0 faces -z, so +x (east) is on the left', () => {
  const me = { x: 0, z: 100 };
  expect(bearingDeg(me, 0, [0, 90])).toBeCloseTo(0, 1); // ahead (-z)
  expect(bearingDeg(me, 0, [0, 110])).toBeCloseTo(180, 1); // behind
  expect(bearingDeg(me, 0, [10, 100])).toBeCloseTo(-90, 1); // east of a south-facing player: left
  expect(bearingDeg(me, 0, [-10, 100])).toBeCloseTo(90, 1); // west: right
  expect(bearingDeg(me, Math.PI / 2, [-10, 100])).toBeCloseTo(0, 1); // yaw 90° faces -x: west is ahead
  expect(bearingDeg(me, Math.PI / 2, [0, 90])).toBeCloseTo(-90, 1); // facing west, south is on the left
});

test('fogTarget: 0.3..1 while outside, 0 inside', () => {
  expect(fogTarget(0, true)).toBeCloseTo(0.3, 2);
  expect(fogTarget(4, true)).toBeCloseTo(0.65, 2);
  expect(fogTarget(8, true)).toBeCloseTo(1, 2);
  expect(fogTarget(10, true)).toBeCloseTo(1, 2);
  expect(fogTarget(5, false)).toBe(0);
  expect(fogTarget(0, false)).toBe(0);
});

test('fogLevel: fast approach (0.25 s), slow lift (0.9 s)', () => {
  expect(fogLevel(0, 1, 0.25)).toBeGreaterThan(0.6);
  expect(fogLevel(1, 0, 0.25)).toBeGreaterThan(0.6);
  expect(fogLevel(1, 0, 0.9)).toBeCloseTo(0.37, 1);
});

test('OutTimer: accumulates dt while outside, resets when inside', () => {
  const t = new OutTimer();
  expect(t.seconds).toBe(0);
  t.step(1, true);
  expect(t.seconds).toBeCloseTo(1, 2);
  t.step(2, true);
  expect(t.seconds).toBeCloseTo(3, 2);
  t.step(0.5, false); // back inside
  expect(t.seconds).toBe(0);
  expect(t.remaining).toBeCloseTo(8, 2);
  t.step(9, true); // capped at 8
  expect(t.seconds).toBe(8);
  expect(t.remaining).toBe(0);
});
