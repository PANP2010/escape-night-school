import { describe, expect, it } from 'vitest';
import { CorrectionSmoother, InterpBuffer, approachYaw } from '../../client/src/interp.ts';

const buf = (...xs: [number, number][]) => {
  const b = new InterpBuffer();
  for (const [t, x] of xs) b.push({ t, x, y: 0, z: 0, yaw: 0 });
  return b;
};

describe('InterpBuffer extrapolation', () => {
  it('interpolates inside the buffer, holds past the end by default', () => {
    const b = buf([0, 0], [50, 1]);
    expect(b.at(25)!.x).toBeCloseTo(0.5);
    expect(b.at(80)!.x).toBe(1);
  });

  it('extrapolates the last velocity up to the cap, then holds', () => {
    const b = buf([0, 0], [50, 1]); // 20 m/s
    expect(b.at(75, 100)!.x).toBeCloseTo(1.5);
    expect(b.at(150, 100)!.x).toBeCloseTo(3);
    expect(b.at(400, 100)!.x).toBeCloseTo(3); // capped at 100 ms past the newest
  });

  it('caps the extrapolated speed', () => {
    const b = buf([0, 0], [50, 1]); // 20 m/s burst
    expect(b.at(150, 100, 6)!.x).toBeCloseTo(1.6); // 6 m/s · 0.1 s
    expect(b.at(150, 100, 30)!.x).toBeCloseTo(3); // under the cap: unchanged
  });

  it('does not extrapolate from a single sample or across a long gap', () => {
    expect(buf([0, 2]).at(60, 100)!.x).toBe(2);
    expect(buf([0, 0], [1000, 1]).at(1050, 100)!.x).toBe(1);
  });
});

describe('CorrectionSmoother', () => {
  it('starts at the old spot and slides to the new one without a jump', () => {
    const s = new CorrectionSmoother(0.1);
    expect(s.kick({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })).toBe(true);
    expect(s.x).toBeCloseTo(1); // rendered position unchanged on the correction frame
    let prev = s.x;
    for (let k = 0; k < 6; k++) { s.step(1 / 60); expect(s.x).toBeLessThan(prev); expect(prev - s.x).toBeLessThan(0.2); prev = s.x; }
    for (let k = 0; k < 60; k++) s.step(1 / 60);
    expect(s.x).toBe(0);
  });

  it('frame-rate independent: 0.1 s at 30 fps ≈ at 120 fps', () => {
    const a = new CorrectionSmoother(), b = new CorrectionSmoother();
    a.kick({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }); b.kick({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    for (let k = 0; k < 3; k++) a.step(1 / 30);
    for (let k = 0; k < 12; k++) b.step(1 / 120);
    expect(a.x).toBeCloseTo(b.x, 6);
  });

  it('accumulates back-to-back corrections; a big jump snaps', () => {
    const s = new CorrectionSmoother(0.1, 2);
    s.kick({ x: 0.5, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    s.kick({ x: 0, y: 0, z: 0 }, { x: -0.5, y: 0, z: 0 });
    expect(s.x).toBeCloseTo(1);
    expect(s.kick({ x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 })).toBe(false);
    expect(s.x).toBe(0);
  });
});

describe('approachYaw', () => {
  const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
  it('eases toward the target, never more than maxRate per second', () => {
    let y = 0;
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) { const n = approachYaw(y, Math.PI * 0.9, 1 / 60); seen.push(n - y); y = n; }
    for (const d of seen) { expect(d).toBeGreaterThan(0); expect(d).toBeLessThanOrEqual(9 / 60 + 1e-9); }
    for (let i = 0; i < 120; i++) y = approachYaw(y, Math.PI * 0.9, 1 / 60);
    expect(y).toBeCloseTo(Math.PI * 0.9, 4);
  });
  it('turns the short way across ±π', () => {
    const n = approachYaw(3.0, -3.0, 1 / 60);
    expect(n).toBeGreaterThan(3.0); // through π, not back through 0
    let y = 3.0;
    for (let i = 0; i < 60; i++) y = approachYaw(y, -3.0, 1 / 60);
    expect(wrap(y)).toBeCloseTo(-3.0, 4);
  });
  it('is frame-rate independent for small turns', () => {
    let a = 0, b = 0;
    for (let i = 0; i < 12; i++) a = approachYaw(a, 0.3, 1 / 120);
    for (let i = 0; i < 3; i++) b = approachYaw(b, 0.3, 1 / 30);
    expect(a).toBeCloseTo(b, 6);
  });
});
