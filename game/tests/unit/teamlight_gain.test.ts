import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { TEAM_LIGHT, teammateLightGain, teammatePoolOverlap, type TeamBeam } from '../../client/src/teamlight.ts';

const beam = (x: number, z = 0): TeamBeam => ({
  o: new THREE.Vector3(x, 1.15, z), d: new THREE.Vector3(0, -1.15, -4.3).normalize(), t: 4.5,
});

describe('teammate torch surface headroom', () => {
  it('bounds near-surface inverse-square glare while keeping the distant corridor pool at full strength', () => {
    for (const distance of [0.05, 0.1, 0.25, 0.5, 1, 1.55, 2, 2.5, 3]) {
      const axialIlluminance = TEAM_LIGHT * teammateLightGain(distance) / (distance * distance);
      expect(axialIlluminance, `${distance} m`).toBeLessThan(3.5);
    }
    expect(teammateLightGain(1.55)).toBeLessThanOrEqual(0.2);
    expect(teammateLightGain(4.5)).toBe(1);
    expect(teammateLightGain(20)).toBe(1);
  });

  it('changes continuously as a surface moves through the end of the near range', () => {
    let previous = 0;
    for (let distance = 0; distance <= 5; distance += 0.01) {
      const gain = teammateLightGain(distance);
      expect(gain).toBeGreaterThanOrEqual(previous);
      expect(gain - previous).toBeLessThan(0.01);
      previous = gain;
    }
    expect(teammateLightGain(3.5 + 1e-4) - teammateLightGain(3.5 - 1e-4)).toBeLessThan(1e-5);
  });

  it('shares overlapping spill headroom, leaving separate pools at full strength', () => {
    const a = beam(0), nearby = beam(2), separate = beam(30);
    const overlap = teammatePoolOverlap(a, nearby);
    expect(overlap).toBeGreaterThan(0.5);
    expect(teammatePoolOverlap(nearby, a)).toBeCloseTo(overlap, 12);
    expect(teammateLightGain(a.t, overlap)).toBeLessThan(0.8);
    expect(2 * teammateLightGain(a.t, overlap)).toBeGreaterThan(1);
    expect(teammatePoolOverlap(a, separate)).toBe(0);
    expect(teammateLightGain(a.t, teammatePoolOverlap(a, separate))).toBe(1);
  });

  it('uses world geometry consistently and returns the remaining beam to full strength as its partner fades out', () => {
    const a = beam(0), b = beam(2), overlap = teammatePoolOverlap(a, b);
    const offset = new THREE.Vector3(-50, 9, 70);
    a.o.add(offset); b.o.add(offset);
    expect(teammatePoolOverlap(a, b)).toBeCloseTo(overlap, 12);
    let previous = 0;
    for (const otherLevel of [1, 0.75, 0.5, 0.25, 0]) {
      const gain = teammateLightGain(a.t, overlap * otherLevel);
      expect(gain).toBeGreaterThan(previous);
      previous = gain;
    }
    expect(previous).toBe(1);
  });
});
