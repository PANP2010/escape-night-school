import { describe, expect, it } from 'vitest';
import { spatialMix } from '../../client/src/spatialAudio.ts';

describe('spatial floor and distance boundaries', () => {
  const ear = { x: 0, y: 1.6, z: 0, yaw: 0, floorY: 0 };
  const source = { x: 2, y: 0.12, z: -3, floorY: 0 };

  it('keeps ears, footfalls and ordinary steps on the same acoustic floor', () => {
    const floor = spatialMix(ear, source);
    const step = spatialMix(ear, { ...source, floorY: 0.35 });
    expect(floor.floors).toBe(0);
    expect(step.floors).toBe(0);
    expect(step.gain).toBe(floor.gain);
    expect(step.cutoff).toBe(floor.cutoff);
    expect(spatialMix({ x: 0, y: 1.6, z: 0, yaw: 0 }, { x: 2, y: 0.12, z: -3 }).floors).toBe(0);
  });

  it('changes continuously while climbing stairs and treats upward and downward floors equally', () => {
    for (const height of [0.6, 1.8, 3.6, 7.2]) {
      const below = spatialMix(ear, { ...source, floorY: height - 0.00001 });
      const above = spatialMix(ear, { ...source, floorY: height + 0.00001 });
      expect(Math.abs(above.gain - below.gain)).toBeLessThan(0.00001);
      expect(Math.abs(above.cutoff - below.cutoff)).toBeLessThan(0.1);
    }
    const upper = spatialMix(ear, { ...source, floorY: 3.6 });
    const lower = spatialMix(ear, { ...source, floorY: -3.6 });
    const same = spatialMix(ear, source);
    expect(upper).toEqual(lower);
    expect(upper.gain).toBeLessThan(same.gain * 0.5);
    expect(upper.cutoff).toBeLessThan(same.cutoff * 0.5);
  });

  it('applies walls in addition to floor attenuation and keeps cutoff positive', () => {
    const point = { ...source, floorY: 3.6 };
    const clear = spatialMix(ear, point), wall = spatialMix(ear, point, true);
    expect(wall.distance).toBe(clear.distance);
    expect(wall.floors).toBe(clear.floors);
    expect(wall.gain).toBeLessThan(clear.gain);
    expect(wall.cutoff).toBeLessThan(clear.cutoff);
    expect(spatialMix(ear, { ...source, floorY: 100 }, true).cutoff).toBeGreaterThan(0);
  });

  it('silences invalid coordinates and sources outside the audible horizon', () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(spatialMix(ear, { ...source, x: value }).gain).toBe(0);
      expect(spatialMix({ ...ear, y: value }, source).gain).toBe(0);
    }
    for (const distance of [25, 26, 1_000_000]) {
      const result = spatialMix(ear, { x: distance, y: 1.6, z: 0, floorY: 0 });
      expect(result.gain).toBe(0);
      expect(Number.isFinite(result.cutoff)).toBe(true);
    }
  });
});
