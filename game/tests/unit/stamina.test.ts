import { describe, expect, it } from 'vitest';
import { canRun, stepStamina } from '../../shared/stamina.ts';
import { SPEED, STAMINA_RUN_S } from '../../shared/constants.ts';
import { WARDEN_CHASE_SPEED } from '../../server/ai/warden.ts';

describe('stamina', () => {
  it('drains in STAMINA_RUN_S (5 s) of running, not before', () => {
    expect(STAMINA_RUN_S).toBe(5);
    let s = 1;
    for (let i = 0; i < 49; i++) s = stepStamina(s, true, 0.1);
    expect(s).toBeGreaterThan(0.01);
    s = stepStamina(s, true, 0.1);
    expect(s).toBeCloseTo(0, 5);
  });
  it('a full sprint gains ground on a chasing Warden, then he closes it once the runner is down to a walk', () => {
    // The deliberate 3.8 m/s chase gains on walking at 0.4 m/s. A full sprint earns 11 m of space:
    // verify both opening that gap and actually closing it during sustained walking.
    const lead = (SPEED.run - WARDEN_CHASE_SPEED) * STAMINA_RUN_S;
    expect(lead).toBeGreaterThan(5);
    expect(WARDEN_CHASE_SPEED).toBeGreaterThan(SPEED.walk);
    expect(WARDEN_CHASE_SPEED).toBeLessThan(SPEED.run);
    expect(lead).toBeCloseTo(11);
    let gap = lead;
    for (let i = 0; i < 27 * 20; i++) gap += (SPEED.walk - WARDEN_CHASE_SPEED) / 20;
    expect(gap).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) gap += (SPEED.walk - WARDEN_CHASE_SPEED) / 20;
    expect(gap).toBeLessThan(0);
  });
  it('refills in 4 s of rest and clamps', () => {
    let s = 0;
    for (let i = 0; i < 50; i++) s = stepStamina(s, false, 0.1);
    expect(s).toBe(1);
  });
  it('needs a recovery margin after exhaustion', () => {
    expect(canRun(0, false)).toBe(false);
    expect(canRun(0.05, true)).toBe(false);
    expect(canRun(0.2, true)).toBe(true);
    expect(canRun(0.05, false)).toBe(true);
  });
});
