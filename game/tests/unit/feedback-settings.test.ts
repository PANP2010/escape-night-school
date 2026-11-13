import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedbackSettings } from '../../client/src/feedbackSettings.ts';

let data: Map<string, string>;
let storage: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn> };
const instances: FeedbackSettings[] = [];
const mount = (onChange = vi.fn()) => {
  const settings = new FeedbackSettings(onChange);
  instances.push(settings);
  return settings;
};
beforeEach(() => {
  data = new Map();
  storage = {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { data.set(key, value); }),
  };
  vi.stubGlobal('localStorage', storage);
});
afterEach(() => { for (const settings of instances.splice(0)) settings.dispose(); vi.unstubAllGlobals(); });

describe('feedback preferences behind the unified settings dialog', () => {
  it('applies defaults immediately without creating another product entry', () => {
    const changed = vi.fn();
    vi.stubGlobal('document', { createElement: () => { throw new Error('preferences must not create UI'); } });
    const settings = mount(changed);
    expect(settings.preferences).toEqual({ volume: 0.65, muted: false, haptics: true });
    expect(changed).toHaveBeenCalledExactlyOnceWith(settings.preferences);
  });

  it.each([
    ['broken JSON', '{', { volume: 0.65, muted: false, haptics: true }],
    ['non-object', 'null', { volume: 0.65, muted: false, haptics: true }],
    ['array', '[1,true,false]', { volume: 0.65, muted: false, haptics: true }],
    ['invalid field types', '{"volume":"NaN","muted":"false","haptics":0}', { volume: 0.65, muted: false, haptics: true }],
    ['high volume', '{"volume":8,"muted":true,"haptics":false}', { volume: 1, muted: true, haptics: false }],
    ['low volume', '{"volume":-2}', { volume: 0, muted: false, haptics: true }],
  ])('sanitizes stored preferences: %s', (_name, value, expected) => {
    data.set('escape.feedback', value);
    expect(mount().preferences).toEqual(expected);
  });

  it('persists unified control changes under the compatible key and reloads them', () => {
    const changed = vi.fn();
    const settings = mount(changed);
    settings.update({ volume: 0.2, muted: true, haptics: false });
    expect(settings.preferences).toEqual({ volume: 0.2, muted: true, haptics: false });
    expect(changed).toHaveBeenLastCalledWith(settings.preferences);
    expect(JSON.parse(data.get('escape.feedback')!)).toEqual(settings.preferences);
    settings.dispose();
    expect(mount().preferences).toEqual({ volume: 0.2, muted: true, haptics: false });
  });

  it('works when private-mode storage rejects reads and writes', () => {
    storage.getItem.mockImplementation(() => { throw new Error('denied'); });
    storage.setItem.mockImplementation(() => { throw new Error('denied'); });
    const changed = vi.fn();
    const settings = mount(changed);
    expect(() => settings.update({ volume: 0.4 })).not.toThrow();
    expect(settings.preferences.volume).toBe(0.4);
    expect(changed).toHaveBeenLastCalledWith({ volume: 0.4, muted: false, haptics: true });
  });

  it('prevents NaN state and returns snapshots that cannot mutate live preferences', () => {
    const settings = mount();
    settings.update({ volume: Number.NaN });
    expect(settings.preferences.volume).toBe(0.65);
    const snapshot = settings.preferences;
    snapshot.volume = 200;
    expect(settings.preferences.volume).toBe(0.65);
  });


  it('notifies live subscribers and releases them when disposed', () => {
    const changed = vi.fn(), listener = vi.fn(), settings = mount(changed);
    const unsubscribe = settings.subscribe(listener);
    expect(listener).toHaveBeenCalledExactlyOnceWith(settings.preferences);
    settings.update({ muted: true });
    expect(listener).toHaveBeenLastCalledWith({ volume: 0.65, muted: true, haptics: true });
    unsubscribe(); listener.mockClear();
    settings.update({ haptics: false });
    expect(listener).not.toHaveBeenCalled();
    settings.dispose(); changed.mockClear();
    settings.update({ volume: 1 });
    expect(changed).not.toHaveBeenCalled();
    expect(() => settings.dispose()).not.toThrow();
  });
});
