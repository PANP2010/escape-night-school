import { describe, expect, it } from 'vitest';
import { CAPTURE_THREAT_MS, captureThreatBeat } from '../../client/src/captureThreat.ts';

describe('one capture contact accent', () => {
  it('approaches once, holds a readable face, then ends before the existing shoulder/down handoff', () => {
    expect(captureThreatBeat(0, false).opacity).toBe(0);
    expect(captureThreatBeat(80, false).opacity).toBe(1);
    expect(captureThreatBeat(280, false).opacity).toBe(1);
    expect(captureThreatBeat(CAPTURE_THREAT_MS, false).opacity).toBe(0);
    expect(captureThreatBeat(1500, false).opacity).toBe(0);
    const distances = [0, 40, 80, 120, 280].map(ms => captureThreatBeat(ms, false).distance);
    expect(distances).toEqual([...distances].sort((a, b) => b - a));
    expect(distances.at(-1)).toBeCloseTo(.63);
  });

  it('reduced motion retains a static face with a softer appearance, without forward travel', () => {
    for (const ms of [0, 50, 100, 250, 500]) expect(captureThreatBeat(ms, true).distance).toBe(.98);
    expect(captureThreatBeat(35, true).opacity).toBeLessThan(captureThreatBeat(35, false).opacity);
    expect(captureThreatBeat(CAPTURE_THREAT_MS, true).opacity).toBe(0);
  });
});
