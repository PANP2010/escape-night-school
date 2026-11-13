import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProgressionStore } from '../../client/src/progression.ts';

let saved: Map<string, string>;
beforeEach(() => {
  saved = new Map();
  vi.stubGlobal('localStorage', { getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => { saved.set(key, value); } });
});
afterEach(() => vi.unstubAllGlobals());
const escape = [{ id: 1, escaped: true, downs: 0 }];

describe('campaign progression', () => {
  it('starts with one tier and unlocks only the following tier after an escaped result', () => {
    const store = new ProgressionStore();
    expect(store.unlocked).toEqual(['story']);
    store.setRoom('ABCD', 'story', false); store.observeSnap(0);
    store.completed([{ id: 1, escaped: false, downs: 0 }], 1);
    expect(store.unlocked).toEqual(['story']);
    store.completed(escape, 1);
    expect(store.unlocked).toEqual(['story', 'standard']);
    expect(store.achievements).toContain('chapter-8');
    expect(store.achievements).toContain('no-down-escape');
    expect(new ProgressionStore().unlocked).toEqual(['story', 'standard']);
  });

  it('does not skip tiers when a friend hosts a harder difficulty', () => {
    const store = new ProgressionStore();
    store.setRoom('ABCD', 'nightmare', false); store.observeSnap(0); store.completed(escape, 1);
    expect(store.unlocked).toEqual(['story']);
    expect(new ProgressionStore().unlocked).toEqual(['story']);
  });

  it('ignores spectators, other players actions, failed escapes and duplicate achievements', () => {
    const store = new ProgressionStore();
    store.setRoom('ABCD', 'story', true); store.observeSnap(2);
    store.activity(1, 'pick', 1); store.chapterCleared(0); store.completed([{ id: 2, escaped: true, downs: 0 }], 1);
    expect(store.achievements).toEqual([]);
    store.observeSnap(0); store.activity(2, 'pick', 1); expect(store.achievements).toEqual([]);
    store.activity(1, 'pick', 1); store.activity(1, 'pick', 1);
    expect(store.achievements).toEqual(['first-pick']);
    store.setRoom('ABCD', 'story', true); store.chapterCleared(0);
    expect(store.achievements).toContain('chapter-1');
  });

  it('awards an escaped member when a restored result arrives before the first snapshot', () => {
    const store = new ProgressionStore();
    store.setRoom('ABCD', 'story', true); store.completed(escape, 1);
    expect(store.achievements).toContain('escape');
    expect(store.unlocked).toEqual(['story', 'standard']);
  });

  it('requires a real discovered Easter egg and preserves it with storage denied', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
    const store = new ProgressionStore(); store.setRoom('ABCD', 'story', false); store.observeSnap(0);
    store.storyRead('2:note:chalk'); expect(store.achievements).toEqual([]);
    store.storyRead('2:note:chalk-cat'); store.storyRead('4:note:role_boss-signature');
    expect(store.achievements).toEqual(['secret-chalk']);
    store.setRoom('ABCD', 'story', false, true, false, true);
    store.storyRead('4:note:role_boss-signature');
    expect(store.achievements).toEqual(['secret-chalk', 'secret-role_boss']);
  });

  it('requires the current room to opt in before a signature can award the named Easter egg', () => {
    const store = new ProgressionStore();
    store.setRoom('NAMED', 'story', false, true, false, true);
    store.setRoom('PLAIN', 'story', false);
    store.storyRead('4:note:role_boss-signature');
    expect(store.achievements).not.toContain('secret-role_boss');
    store.setRoom('TEST', 'story', false, true, true, true);
    store.storyRead('4:note:role_boss-signature');
    expect(store.achievements).not.toContain('secret-role_boss');
    store.setRoom('NAMED2', 'story', false, true, false, true);
    store.storyRead('4:note:role_boss-signature');
    expect(store.achievements).toContain('secret-role_boss');
  });

  it('rejects malformed storage unlocks and reconstructs a completed tier after an interrupted write', () => {
    saved.set('escape.progress.v1', JSON.stringify({ unlocked: ['nightmare'], achievements: ['unknown', 'difficulty-story'] }));
    const store = new ProgressionStore();
    expect(store.unlocked).toEqual(['story', 'standard']);
    expect(store.achievements).toEqual(['difficulty-story']);
    saved.set('escape.progress.v1', '{'); expect(new ProgressionStore().unlocked).toEqual(['story']);
  });

  it('unlocks named monitors only after sequential tiers and the server-confirmed nightmare full run', () => {
    const store = new ProgressionStore();
    for (const difficulty of ['story', 'standard', 'challenge', 'nightmare'] as const) {
      store.setRoom(difficulty, difficulty, false);
      store.completed(escape, 1, difficulty === 'nightmare', 'guidance');
      expect(store.canEnableNamedMonitors).toBe(difficulty === 'nightmare');
    }
    expect(new ProgressionStore().canEnableNamedMonitors).toBe(true);
  });

  it('keeps legacy nightmare achievements locked until the server confirms an escaped full run', () => {
    const store = new ProgressionStore();
    for (const difficulty of ['story', 'standard', 'challenge', 'nightmare'] as const) {
      store.setRoom(difficulty, difficulty, false); store.completed(escape, 1);
    }
    expect(store.canEnableNamedMonitors).toBe(false);
    store.completed([{ id: 2, escaped: true, downs: 0 }], 1, true, 'eligible');
    expect(store.canEnableNamedMonitors).toBe(false);
    store.completed(escape, 1, true, 'eligible');
    expect(store.canEnableNamedMonitors).toBe(true);
  });

  it('rejects a nightmare shortcut and a forged preference while lower tiers are unfinished', () => {
    saved.set('escape.namedMonitors', '1');
    saved.set('escape.progress.v1', JSON.stringify({ unlocked: ['nightmare'], achievements: ['difficulty-nightmare'], namedMonitorsUnlocked: true }));
    const store = new ProgressionStore();
    expect(store.canEnableNamedMonitors).toBe(false);
    store.setRoom('ABCD', 'nightmare', false); store.completed(escape, 1, true, 'guidance');
    expect(store.canEnableNamedMonitors).toBe(false);
    for (const difficulty of ['story', 'standard', 'challenge'] as const) {
      store.setRoom(difficulty, difficulty, false); store.completed(escape, 1);
    }
    expect(store.canEnableNamedMonitors).toBe(false);
  });

  it('never grants achievements or unlocks in a developer room, including after snapshots reassert an active player', () => {
    const store = new ProgressionStore();
    store.setRoom('TEST', 'nightmare', false, true, true); store.observeSnap(0);
    store.activity(1, 'pick', 1); store.chapterCleared(0); store.storyRead('2:note:chalk-cat');
    expect(store.record('difficulty-story')).toBe(false);
    store.completed(escape, 1, true, 'eligible');
    expect(store.achievements).toEqual([]); expect(store.unlocked).toEqual(['story']);
    expect(store.canEnableNamedMonitors).toBe(false);
  });

  it.each(['developer', 'debug', 'incomplete'] as const)('rejects %s completion rewards even outside a developer room', ranking => {
    const store = new ProgressionStore();
    store.setRoom('ABCD', 'nightmare', false); store.observeSnap(0);
    store.completed(escape, 1, true, ranking);
    expect(store.achievements).toEqual([]); expect(store.canEnableNamedMonitors).toBe(false);
  });

});
