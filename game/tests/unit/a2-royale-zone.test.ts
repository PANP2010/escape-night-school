import { describe, expect, it } from 'vitest';
import { generateZonePhases, distToZoneCenter, inZone, ZONE_PHASES, CAMPUS_LANDMARKS } from '../../shared/royale.ts';

describe('A2 royale zone mechanics', () => {
  it('generates zone phases: initial + 4 shrinks', () => {
    const phases = generateZonePhases(12345);
    expect(phases).toHaveLength(ZONE_PHASES + 1); // initial + 4 phases
    expect(phases[0].radius).toBeGreaterThan(100); // initial covers campus

    // Each phase shrinks
    for (let i = 1; i < phases.length; i++) {
      expect(phases[i].radius).toBeLessThan(phases[i - 1].radius);
    }
  });

  it('zone centers are campus landmarks', () => {
    const phases = generateZonePhases(67890);
    for (let i = 1; i < phases.length; i++) {
      const [cx, cz] = phases[i].center;
      // Each center must be one of the landmarks
      const isLandmark = CAMPUS_LANDMARKS.some(([lx, lz]) => lx === cx && lz === cz);
      expect(isLandmark).toBe(true);
    }
  });

  it('distToZoneCenter calculates correctly', () => {
    const zone = { center: [10, 20] as const, radius: 50 };
    expect(distToZoneCenter(10, 20, zone)).toBe(0); // at center
    expect(distToZoneCenter(40, 20, zone)).toBe(30); // 30m east
    expect(distToZoneCenter(10, 50, zone)).toBe(30); // 30m north
  });

  it('inZone checks boundary correctly', () => {
    const zone = { center: [0, 0] as const, radius: 50 };
    expect(inZone(0, 0, zone)).toBe(true); // center
    expect(inZone(30, 40, zone)).toBe(true); // 50m exactly
    expect(inZone(49, 0, zone)).toBe(true); // inside
    expect(inZone(51, 0, zone)).toBe(false); // outside
    expect(inZone(100, 0, zone)).toBe(false); // far outside
  });

  it('same seed produces same phases', () => {
    const a = generateZonePhases(42);
    const b = generateZonePhases(42);
    expect(a).toEqual(b);
  });

  it('different seeds produce different phases', () => {
    const a = generateZonePhases(111);
    const b = generateZonePhases(222);
    expect(a).not.toEqual(b);
  });
});
