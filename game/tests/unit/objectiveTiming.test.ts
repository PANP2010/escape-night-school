import { describe, expect, it } from 'vitest';
import { BANNER_FADE_MS, ObjectiveTiming } from '../../client/src/objectiveTiming.ts';

const shown = { spawned: true, visible: true, rendered: true };

describe('objective presentation timing', () => {
  it('waits for three seconds of stable rendered frames, restarting after a loading stall', () => {
    const t = new ObjectiveTiming();
    expect(t.frame(0, shown).start).toBe(false);
    expect(t.frame(5000, shown).start).toBe(false);
    for (let now = 5100; now < 8000; now += 100) expect(t.frame(now, shown).start).toBe(false);
    expect(t.frame(8000, shown).start).toBe(true);
    expect(t.frame(8100, shown).start).toBe(false);
  });

  it('allows the first input to start after spawn, including a deliberately undrawn test scene', () => {
    const t = new ObjectiveTiming();
    t.input();
    expect(t.frame(0, { ...shown, spawned: false }).start).toBe(false);
    expect(t.frame(9000, { ...shown, rendered: false }).start).toBe(true);
    const undrawn = new ObjectiveTiming();
    expect(undrawn.frame(0, { ...shown, rendered: false }).start).toBe(false);
    expect(undrawn.frame(9000, { ...shown, rendered: false }).start).toBe(false);
  });

  it('starts the readable interval at the next presented frame, even when the first render takes seconds', () => {
    const t = new ObjectiveTiming();
    t.show(3000);
    expect(t.frame(8000, shown).phase).toBe('readable');
    for (let now = 8500; now < 10_999; now += 500) t.frame(now, shown);
    expect(t.frame(10_999, shown).phase).toBe('readable');
    expect(t.frame(11_000, shown).phase).toBe('fading');
    expect(t.frame(11_000 + BANNER_FADE_MS, shown).phase).toBe('hidden');
  });

  it('gives a complete readable interval after a background, intro or capture interruption', () => {
    const t = new ObjectiveTiming();
    t.show(3000);
    t.frame(0, shown);
    for (let now = 500; now < 2900; now += 500) t.frame(now, shown);
    expect(t.frame(2900, shown).phase).toBe('readable');
    expect(t.frame(2950, { ...shown, visible: false }).phase).toBe('hidden');
    expect(t.frame(50_000, { ...shown, visible: false }).phase).toBe('hidden');
    expect(t.frame(60_000, shown).phase).toBe('readable');
    for (let now = 60_500; now < 62_999; now += 500) t.frame(now, shown);
    expect(t.frame(62_999, shown).phase).toBe('readable');
    expect(t.frame(63_000, shown).phase).toBe('fading');
  });

  it('an explicit pause between rAF callbacks also restores a fading banner in full', () => {
    const t = new ObjectiveTiming();
    t.show(3000);
    t.frame(0, shown);
    for (let now = 500; now < 3200; now += 500) t.frame(now, shown);
    expect(t.frame(3200, shown).phase).toBe('fading');
    t.pause();
    expect(t.frame(30_000, shown).phase).toBe('readable');
    for (let now = 30_500; now < 32_999; now += 500) t.frame(now, shown);
    expect(t.frame(32_999, shown).phase).toBe('readable');
  });

  it('does not spend an active banner while drawing is disabled for capture', () => {
    const t = new ObjectiveTiming();
    t.show(3000); t.frame(0, shown);
    expect(t.frame(1500, { ...shown, rendered: false }).phase).toBe('hidden');
    expect(t.frame(20_000, shown).phase).toBe('readable');
    for (let now = 20_500; now < 22_999; now += 500) t.frame(now, shown);
    expect(t.frame(22_999, shown).phase).toBe('readable');
  });

  it('gives a full interval after real rAF suspension even without visibilitychange', () => {
    const t = new ObjectiveTiming();
    t.show(3000); t.frame(0, shown); t.frame(450, shown);
    expect(t.frame(10_000, shown).phase).toBe('readable');
    for (let now = 10_450; now < 13_000; now += 450) expect(t.frame(now, shown).phase).toBe('readable');
    expect(t.frame(13_150, shown).phase).toBe('fading');
  });

  it('a new level discards the previous banner and input latch', () => {
    const t = new ObjectiveTiming();
    t.input(); t.frame(0, shown); t.show(3000); t.frame(1, shown);
    t.reset();
    expect(t.pending).toBe(true);
    expect(t.frame(30_000, shown)).toEqual({ start: false, phase: 'hidden' });
  });

  it('cancels a replaced banner without rearming an already-started opening', () => {
    const t = new ObjectiveTiming();
    t.input(); expect(t.frame(0, shown).start).toBe(true);
    t.show(3000); expect(t.frame(1, shown).phase).toBe('readable');
    t.hide();
    expect(t.pending).toBe(false);
    expect(t.frame(100_000, shown)).toEqual({ start: false, phase: 'hidden' });
  });
});
