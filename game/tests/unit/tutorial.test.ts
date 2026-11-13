/** L1 controls (client/src/tutorial.ts); nearby perfume must never open a text alarm. */
import { describe, expect, test } from 'vitest';
import { Tutorial, TUT_DONE_S, TUT_MIN_S, TUT_S, TUT_STEPS, tutParts, tutText, type TutDid } from '../../client/src/tutorial.ts';

const none: TutDid = { moved: 0, light: false, crouched: false, used: false, mapped: false, picked: false, hidden: false };
const controls: TutDid = { ...none, moved: 5, light: true, crouched: true, used: true, mapped: true, picked: true };

describe('Tutorial', () => {
  test('one tip at a time, in order, the next only once this one is done and has been up TUT_MIN_S', () => {
    const t = new Tutorial();
    t.start(10);
    expect(t.tick(10, none)).toEqual({ step: 'move', n: 1, m: 6, done: false });
    expect(t.tick(30, none)?.step).toBe('move'); // not done: stays
    const d = { ...none, moved: 3.2 };
    expect(t.tick(30.1, d)).toMatchObject({ step: 'move', done: true });
    expect(t.tick(30.1 + TUT_DONE_S - 0.01, d)?.step).toBe('move');
    expect(t.tick(30.1 + TUT_DONE_S, d)).toEqual({ step: 'light', n: 2, m: 6, done: false });
    // done at once: still shown TUT_MIN_S before the tick
    const l = { ...d, light: true };
    expect(t.tick(31, l)).toMatchObject({ step: 'light', done: false });
    expect(t.tick(30.1 + TUT_DONE_S + TUT_MIN_S, l)).toMatchObject({ step: 'light', done: true });
  });

  test('a step already done before its turn is skipped; all done → no tip', () => {
    const t = new Tutorial();
    t.start(0);
    expect(t.tick(TUT_MIN_S, controls)).toMatchObject({ step: 'move', done: true });
    expect(t.tick(TUT_MIN_S + TUT_DONE_S + 0.001, controls)).toBeUndefined();
    expect(t.tick(20, none)).toBeUndefined();
    const u = new Tutorial();
    u.start(0);
    const lit = { ...none, moved: 4, light: true };
    u.tick(TUT_MIN_S, lit);
    expect(u.tick(TUT_MIN_S + TUT_DONE_S + 0.001, lit)?.step).toBe('crouch'); // light was on already
  });

  test('crouching and picking need their own completed actions; generic interaction is not a pickup', () => {
    const t = new Tutorial(['crouch', 'pick']);
    t.start(0);
    const interacted = { ...none, used: true };
    expect(t.tick(10, interacted)).toMatchObject({ step: 'crouch', done: false });
    const crouched = { ...interacted, crouched: true };
    expect(t.tick(10.1, crouched)).toMatchObject({ step: 'crouch', done: true });
    expect(t.tick(11, crouched)).toMatchObject({ step: 'pick', done: false });
    expect(t.tick(20, crouched)).toMatchObject({ step: 'pick', done: false });
    const picked = { ...crouched, picked: true };
    expect(t.tick(20.1, picked)).toMatchObject({ step: 'pick', done: true });
    expect(t.tick(21, picked)).toBeUndefined();
  });

  test('only the first TUT_S s from start; a start in the future (under the banner) holds the first tip', () => {
    const t = new Tutorial();
    t.start(103.6);
    expect(t.tick(101, { ...none, moved: 9 })).toMatchObject({ step: 'move', done: false });
    expect(t.tick(103.6 + TUT_S - 1, none)?.step).toBe('move');
    expect(t.tick(103.6 + TUT_S + 0.1, none)).toBeUndefined();
    const s = new Tutorial();
    s.start(0);
    s.stop();
    expect(s.tick(1, none)).toBeUndefined();
  });

  test('nearby perfume does not interrupt controls or reopen finished teaching', () => {
    const t = new Tutorial();
    t.start(0);
    const near = { ...none, scented: true };
    expect(t.tick(1, near)).toEqual({ step: 'move', n: 1, m: 6, done: false });
    expect(t.tick(5, near)?.step).toBe('move');
    expect(t.tick(TUT_S + 1, near)).toBeUndefined();
    t.start(100);
    expect(t.tick(101, near)?.step).toBe('move');
    t.stop();
    expect(t.tick(102, near)).toBeUndefined();
  });

  test('an explicitly taught hiding action still needs the current authoritative hiding state', () => {
    const t = new Tutorial(['hide']);
    t.start(0);
    expect(t.tick(5, none)).toMatchObject({ step: 'hide', done: false });
    expect(t.tick(6, { ...none, hidden: true })).toMatchObject({ step: 'hide', done: true });
    expect(t.tick(7, none)).toBeUndefined();
  });

  test('tips name the right controls; key caps parse', () => {
    expect(TUT_STEPS).toEqual(['move', 'light', 'crouch', 'use', 'map', 'pick']);
    expect(tutText('light', false)).toContain('[F]');
    expect(tutText('use', false)).toContain('[E]');
    expect(tutText('map', false)).toContain('[M]');
    expect(tutText('crouch', false)).toContain('[C]');
    expect(tutText('crouch', false)).toContain('[Ctrl]');
    expect(tutText('pick', false)).toContain('[E]');
    expect(tutText('hide', false)).toContain('[E]');
    expect(tutText('light', true)).toContain('[手电]'); // touch.ts BUTTONS / main.ts #touch-map labels
    expect(tutText('use', true)).toContain('直接点门或物品');
    expect(tutText('map', true)).toContain('[地图]');
    expect(tutText('crouch', true)).toContain('[蹲]');
    expect(tutText('pick', true)).toContain('直接点');
    expect(tutText('hide', true)).toContain('[互动]');
    for (const step of [...TUT_STEPS, 'hide'] as const) expect(tutText(step, true)).not.toMatch(/\[(?:W|A|S|D|C|Ctrl|E|F|M)\]/);
    expect(tutParts('[W][A] 走动 · 按 [E]')).toEqual([
      { t: 'W', key: true }, { t: 'A', key: true }, { t: ' 走动 · 按 ', key: false }, { t: 'E', key: true },
    ]);
  });
});
