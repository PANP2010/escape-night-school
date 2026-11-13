import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { beamScore, TeamLightPick, SWITCH_RATIO, FADE_OUT_S, FADE_IN_S } from '../../client/src/teamlight.ts';

// A at the origin, eye 1.6 m up, looking down -z.
const cam = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 100);
cam.position.set(0, 1.6, 0);
cam.lookAt(0, 1.4, -10);
cam.updateMatrixWorld();
const fr = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
const clear = () => false, wall = () => true;
const beam = (ox: number, oz: number, tx: number, tz: number) => {
  const o = new THREE.Vector3(ox, 1.3, oz), d = new THREE.Vector3(tx, 0, tz).sub(o);
  const t = d.length();
  return { o, d: d.normalize(), t, r: 0.06 + t * Math.tan(0.2) * 1.15 };
};
const score = (b: ReturnType<typeof beam>, occ = clear) => beamScore(fr, cam.position, b.o, b.d, b.t, b.r, occ);

describe('beamScore', () => {
  it('a beam lighting the floor ahead beats a nearer teammate pointing behind A', () => {
    const ahead = beam(0, -5, 0, -7), behind = beam(1.3, 0.6, 1.3, 3);
    expect(score(ahead)).toBeGreaterThan(score(behind) * 10);
  });
  it('a pool behind a wall counts far less than the same pool in plain view', () => {
    const b = beam(0, -5, 0, -7);
    expect(score(b, wall)).toBeLessThan(score(b) * 0.2);
    expect(score(b, wall)).toBeGreaterThan(0);
  });
  it('a beam crossing the view whose pool is off-screen counts more than one wholly out of view, less than its pool in view', () => {
    const across = beam(-2, -2, 6, 1); // pool off past A's right shoulder, shaft across the view ahead
    const pooled = beam(-2, -2, 0, -5);
    const behind = beam(0, 2, 0, 5);
    expect(score(across)).toBeGreaterThan(score(behind));
    expect(score(across)).toBeLessThan(score(pooled));
  });
  it('a nearer pool in view outscores a farther one', () => {
    expect(score(beam(0, -3, 0, -4.5))).toBeGreaterThan(score(beam(0, -12, 0, -14)));
  });
});

const m = (o: Record<number, number>) => new Map(Object.entries(o).map(([k, v]) => [+k, v]));

describe('TeamLightPick', () => {
  it('with nothing lit before, the first lit teammate gets the light at full strength at once', () => {
    const p = new TeamLightPick<number>();
    expect(p.update(0.016, m({}))).toBeUndefined();
    expect(p.level).toBe(0);
    expect(p.update(0.016, m({ 1: 0.1, 2: 0.3 }))).toBe(2);
    expect(p.level).toBe(1);
  });
  it('keeps the holder while a challenger is within the switch ratio', () => {
    const p = new TeamLightPick<number>();
    p.update(0.016, m({ 1: 1 }));
    for (let i = 0; i < 100; i++) expect(p.update(0.016, m({ 1: 1, 2: SWITCH_RATIO * 0.95 }))).toBe(1);
    expect(p.level).toBe(1);
  });
  it('switches to a clearly better beam by fading out, moving, then fading in', () => {
    const p = new TeamLightPick<number>();
    p.update(0.016, m({ 1: 1 }));
    const s = m({ 1: 1, 2: SWITCH_RATIO * 2 }), dt = 0.01;
    let t = 0, last = 1;
    while (p.holder === 1) { p.update(dt, s); t += dt; expect(p.level).toBeLessThanOrEqual(last); last = p.level; if (t > 1) break; }
    expect(p.holder).toBe(2);
    expect(p.level).toBe(0);
    expect(t).toBeGreaterThan(FADE_OUT_S - 2 * dt);
    expect(t).toBeLessThan(FADE_OUT_S + 2 * dt);
    let u = 0;
    while (p.level < 1) { p.update(dt, s); u += dt; expect(p.holder).toBe(2); if (u > 1) break; }
    expect(u).toBeGreaterThan(FADE_IN_S - 2 * dt);
    expect(u).toBeLessThan(FADE_IN_S + 2 * dt);
  });
  it('a challenger that turns off mid-fade hands the light back to the holder', () => {
    const p = new TeamLightPick<number>();
    p.update(0.016, m({ 1: 1 }));
    p.update(0.05, m({ 1: 1, 2: 5 }));
    expect(p.level).toBeLessThan(1);
    p.update(0.05, m({ 1: 1 }));
    expect(p.holder).toBe(1);
    for (let i = 0; i < 30; i++) p.update(0.016, m({ 1: 1 }));
    expect(p.level).toBe(1);
  });
  it("the holder's torch going off drops the light at once and fades it in on the next best", () => {
    const p = new TeamLightPick<number>();
    p.update(0.016, m({ 1: 1, 2: 0.9 }));
    expect(p.update(0.016, m({ 2: 0.9 }))).toBe(2);
    expect(p.level).toBeLessThan(0.2);
    for (let i = 0; i < 30; i++) p.update(0.016, m({ 2: 0.9 }));
    expect(p.level).toBe(1);
  });
  it('everyone off → light off', () => {
    const p = new TeamLightPick<number>();
    p.update(0.016, m({ 1: 1 }));
    expect(p.update(0.016, m({}))).toBeUndefined();
    expect(p.level).toBe(0);
  });
});

describe('TeamLightPick with two lights', () => {
  const held = (p: TeamLightPick<number>) => p.slots.map((s) => s.holder);
  const run = (p: TeamLightPick<number>, sc: Record<number, number>, n = 40) => { for (let i = 0; i < n; i++) p.update(0.016, m(sc)); };
  it('two lit teammates each get a light, no key held twice', () => {
    const p = new TeamLightPick<number>(2);
    run(p, { 1: 1, 2: 0.5 });
    expect(new Set(held(p))).toEqual(new Set([1, 2]));
    expect(p.slots.every((s) => s.level === 1)).toBe(true);
  });
  it('a single lit teammate takes one slot, the other stays dark', () => {
    const p = new TeamLightPick<number>(2);
    run(p, { 1: 1 });
    expect(held(p).filter((h) => h !== undefined)).toEqual([1]);
    expect(p.slots.find((s) => s.holder === undefined)!.level).toBe(0);
  });
  it('a third challenger takes only the weakest slot, and only above the ratio', () => {
    const p = new TeamLightPick<number>(2);
    run(p, { 1: 1, 2: 0.5 });
    run(p, { 1: 1, 2: 0.5, 3: 0.5 * SWITCH_RATIO * 0.9 });
    expect(new Set(held(p))).toEqual(new Set([1, 2]));
    run(p, { 1: 1, 2: 0.5, 3: 0.5 * SWITCH_RATIO * 1.1 });
    expect(new Set(held(p))).toEqual(new Set([1, 3]));
  });
  it("one holder's torch off: the other slot keeps its light at full level", () => {
    const p = new TeamLightPick<number>(2);
    run(p, { 1: 1, 2: 0.5 });
    const keep = p.slots.find((s) => s.holder === 1)!;
    p.update(0.016, m({ 1: 1 }));
    expect(keep.holder).toBe(1);
    expect(keep.level).toBe(1);
    expect(held(p).filter((h) => h === 2)).toEqual([]);
  });
  it('the swapped slot fades out before the newcomer fades in', () => {
    const p = new TeamLightPick<number>(2);
    run(p, { 1: 1, 2: 0.5 });
    const sc = { 1: 1, 2: 0.5, 3: 2 };
    p.update(0.016, m(sc));
    const s = p.slots.find((x) => x.want === 3)!;
    expect(s.holder).toBe(2);
    expect(s.level).toBeLessThan(1);
    run(p, sc, Math.ceil(FADE_OUT_S / 0.016) + 1);
    expect(s.holder).toBe(3);
    run(p, sc, Math.ceil(FADE_IN_S / 0.016) + 1);
    expect(s.level).toBe(1);
  });
});
