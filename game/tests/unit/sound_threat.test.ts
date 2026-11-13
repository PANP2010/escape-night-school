import { describe, expect, it } from 'vitest';
import { isNearbyChase, soundThreat } from '../../client/src/soundThreat.ts';
import { MonitorAI } from '../../server/ai/monitor.ts';
import { WardenAI } from '../../server/ai/warden.ts';
import { NavGraph } from '../../shared/campus/nav.ts';

function fixture() {
  const graph = new NavGraph();
  const [start] = graph.chain([{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -20 }]);
  const env = { graph, rng: () => 0.5, los: () => true };
  return { warden: new WardenAI(env, start), monitor: new MonitorAI(env, [0, 0, 0]) };
}

describe('isNearbyChase', () => {
  it('recognises the real WardenAI chase animation and leaves patrol at the ambient threat level', () => {
    const { warden } = fixture();
    expect(isNearbyChase({ monitor: false, anim: warden.anim }, 6)).toBe(false);
    warden.forceChase([0, 0, 0], 0, 1, [0, 0, -6]);
    expect(warden.anim).toBe('chase');
    expect(isNearbyChase({ monitor: false, anim: warden.anim }, 6)).toBe(true);
  });

  it('keeps the real MonitorAI run animation eligible for the chase layer', () => {
    const { monitor } = fixture();
    expect(isNearbyChase({ monitor: true, anim: monitor.anim }, 6)).toBe(false);
    monitor.forceHunt([0, 0, 0], 0);
    expect(monitor.anim).toBe('run');
    expect(isNearbyChase({ monitor: true, anim: monitor.anim }, 6)).toBe(true);
  });

  it.each([{ monitor: false, anim: 'chase' }, { monitor: true, anim: 'run' }])(
    'preserves the strict 15 metre boundary for $anim', (mob) => {
      expect(isNearbyChase(mob, 14.99)).toBe(true);
      expect(isNearbyChase(mob, 15)).toBe(false);
      expect(isNearbyChase(mob, 20)).toBe(false);
      expect(isNearbyChase(mob, Infinity)).toBe(false);
      expect(isNearbyChase(mob, NaN)).toBe(false);
    },
  );

  it('does not infer pursuit from the other mob kind or a similar animation name', () => {
    for (const anim of ['idle', 'patrol', 'investigate', 'catch', 'freeze', 'sprint', 'chasing', 'run-fast']) {
      expect(isNearbyChase({ monitor: false, anim }, 1)).toBe(false);
      expect(isNearbyChase({ monitor: true, anim }, 1)).toBe(false);
    }
    expect(isNearbyChase({ monitor: false, anim: 'run' }, 1)).toBe(false);
    expect(isNearbyChase({ monitor: true, anim: 'chase' }, 1)).toBe(false);
  });
});

describe('soundThreat', () => {
  const threatFor = (wardenDistance: number, mobs: { monitor: boolean; anim: string; distance: number }[]) => {
    let chaseDistance = Infinity;
    for (const mob of mobs) if (isNearbyChase(mob, mob.distance)) chaseDistance = Math.min(chaseDistance, mob.distance);
    return soundThreat(wardenDistance, chaseDistance);
  };

  it('raises the chase layer for a real running MonitorAI even when 角色074 is out of range', () => {
    const { monitor } = fixture();
    expect(threatFor(40, [{ monitor: true, anim: monitor.anim, distance: 6 }])).toBe(0);
    monitor.forceHunt([0, 0, 0], 0);
    expect(threatFor(40, [{ monitor: true, anim: monitor.anim, distance: 6 }])).toBeCloseTo(0.36);
    expect(threatFor(Infinity, [{ monitor: true, anim: monitor.anim, distance: 6 }])).toBeCloseTo(0.36);
  });

  it('preserves the quiet 角色074 patrol layer and raises its real chase animation', () => {
    const { warden } = fixture();
    expect(threatFor(6, [{ monitor: false, anim: warden.anim, distance: 6 }])).toBeCloseTo(0.36 * 0.35);
    warden.forceChase([0, 0, 0], 0, 1, [0, 0, -6]);
    expect(threatFor(6, [{ monitor: false, anim: warden.anim, distance: 6 }])).toBeCloseTo(0.36);
  });

  it('uses each pursuer distance instead of amplifying a nearer patrolling 角色074', () => {
    const mobs = [
      { monitor: false, anim: 'patrol', distance: 2 },
      { monitor: true, anim: 'run', distance: 14 },
    ];
    expect(threatFor(2, mobs)).toBeCloseTo((1 - 2 / 15) ** 2 * 0.35);
    mobs[1].distance = 1;
    expect(threatFor(2, mobs)).toBeCloseTo((1 - 1 / 15) ** 2);
  });

  it('falls back to ambient when pursuit ends and reaches silence at the chase boundary', () => {
    expect(threatFor(40, [{ monitor: true, anim: 'run', distance: 14 }])).toBeGreaterThan(0);
    expect(threatFor(40, [{ monitor: true, anim: 'run', distance: 15 }])).toBe(0);
    expect(threatFor(40, [{ monitor: true, anim: 'idle', distance: 2 }])).toBe(0);
    expect(threatFor(6, [{ monitor: false, anim: 'patrol', distance: 6 }])).toBeCloseTo(0.36 * 0.35);
    expect(soundThreat(NaN, Infinity)).toBe(0);
  });
});
