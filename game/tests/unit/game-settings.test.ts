import { afterEach, describe, expect, it, vi } from 'vitest';
import { gamePreferencesFrom, readGamePreferences } from '../../client/src/settings.ts';
import { Input } from '../../client/src/input.ts';

afterEach(() => vi.unstubAllGlobals());

describe('saved game preferences', () => {
  it('uses device defaults without sharing mutable snapshots', () => {
    const desktop = gamePreferencesFrom(undefined);
    expect(desktop).toEqual({ sensitivity: 1, pixelRatio: 1.5, postprocessing: true, interactionHighlights: true });
    expect(gamePreferencesFrom(undefined, true)).toEqual({ sensitivity: 1, pixelRatio: 1, postprocessing: false, interactionHighlights: true });
    desktop.sensitivity = 200;
    expect(gamePreferencesFrom(undefined).sensitivity).toBe(1);
  });

  it.each([null, [], 'settings', 12, true])('recovers from a non-record saved value: %j', (value) => {
    expect(gamePreferencesFrom(value)).toEqual({ sensitivity: 1, pixelRatio: 1.5, postprocessing: true, interactionHighlights: true });
  });

  it('accepts saved mobile choices while rejecting coercion and unknown rendering modes', () => {
    expect(gamePreferencesFrom({ sensitivity: 1.75, pixelRatio: 1.5, postprocessing: true, interactionHighlights: true }, true))
      .toEqual({ sensitivity: 1.75, pixelRatio: 1.5, postprocessing: true, interactionHighlights: true });
    expect(gamePreferencesFrom({ sensitivity: '2', pixelRatio: 2, postprocessing: 'false', volume: 0 }))
      .toEqual({ sensitivity: 1, pixelRatio: 1.5, postprocessing: true, interactionHighlights: true });
    expect(gamePreferencesFrom({ sensitivity: Number.NaN, pixelRatio: '1.5', postprocessing: 0 }, true))
      .toEqual({ sensitivity: 1, pixelRatio: 1, postprocessing: false, interactionHighlights: true });
  });

  it('keeps the saved highlight opt-out independent of device defaults and postprocessing', () => {
    expect(gamePreferencesFrom({ interactionHighlights: false }).interactionHighlights).toBe(false);
    expect(gamePreferencesFrom({ interactionHighlights: false, postprocessing: true }, true).interactionHighlights).toBe(false);
    for (const value of ['false', 0, null]) expect(gamePreferencesFrom({ interactionHighlights: value }).interactionHighlights).toBe(true);
  });

  it('bounds valid sensitivity and recovers from non-finite values', () => {
    expect(gamePreferencesFrom({ sensitivity: -10 }).sensitivity).toBe(0.25);
    expect(gamePreferencesFrom({ sensitivity: 100 }).sensitivity).toBe(2.5);
    expect(gamePreferencesFrom({ sensitivity: Infinity }).sensitivity).toBe(1);
    expect(gamePreferencesFrom({ sensitivity: -Infinity }).sensitivity).toBe(1);
  });

  it('reads only the game preference key and leaves audio preferences intact', () => {
    const audio = '{"volume":0.34,"muted":true,"haptics":false}';
    const data = new Map([
      ['escape.settings', '{"sensitivity":1.4,"pixelRatio":1,"postprocessing":false}'],
      ['escape.feedback', audio],
    ]);
    const getItem = vi.fn((key: string) => data.get(key) ?? null);
    vi.stubGlobal('localStorage', { getItem });
    expect(readGamePreferences()).toEqual({ sensitivity: 1.4, pixelRatio: 1, postprocessing: false, interactionHighlights: true });
    expect(getItem).toHaveBeenCalledExactlyOnceWith('escape.settings');
    expect(data.get('escape.feedback')).toBe(audio);
  });

  it.each(['{', 'null', '[]', '{"sensitivity":"bad"}'])('starts safely with corrupt or obsolete JSON: %s', (raw) => {
    vi.stubGlobal('localStorage', { getItem: () => raw });
    expect(readGamePreferences(true)).toEqual({ sensitivity: 1, pixelRatio: 1, postprocessing: false, interactionHighlights: true });
  });

  it('keeps settings available when private browsing rejects storage access', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('Storage denied'); } });
    expect(readGamePreferences()).toEqual({ sensitivity: 1, pixelRatio: 1.5, postprocessing: true, interactionHighlights: true });
  });
});

describe('input while settings are open', () => {
  it('captures key releases before native panels can stop them from bubbling', () => {
    const listeners = new Map<string, { handle: (event: { code: string }) => void; capture?: boolean }>();
    vi.stubGlobal('addEventListener', vi.fn((type: string, handle: (event: { code: string }) => void,
      capture?: boolean) => { listeners.set(type, { handle, capture }); }));
    vi.stubGlobal('document', new EventTarget());
    const input = new Input({ addEventListener() {} } as unknown as HTMLElement);
    listeners.get('keydown')!.handle({ code: 'KeyW' });
    input.endFrame();
    expect(input.down('KeyW')).toBe(true);
    expect(listeners.get('keyup')!.capture).toBe(true);
    listeners.get('keyup')!.handle({ code: 'KeyW' });
    expect(input.down('KeyW')).toBe(false);
  });

  it('drops synthetic touches and action edges while suspended, then accepts a fresh gesture', () => {
    vi.stubGlobal('addEventListener', vi.fn());
    vi.stubGlobal('document', new EventTarget());
    const input = new Input({ addEventListener() {} } as unknown as HTMLElement);
    input.press('KeyW');
    input.press('KeyE');
    input.clear();
    input.enabled = false;
    input.press('KeyW');
    input.press('KeyE');
    input.look(100, -100, 0.004);
    input.release('KeyW');
    input.enabled = true;
    expect([...input.keys]).toEqual([]);
    expect(input.down('KeyW')).toBe(false);
    expect(input.consume('KeyE')).toBe(false);
    expect({ yaw: input.yaw, pitch: input.pitch }).toEqual({ yaw: 0, pitch: 0 });
    input.press('KeyE');
    expect(input.consume('KeyE')).toBe(true);
    input.look(100, 0, 0.004);
    expect(input.yaw).toBeCloseTo(-0.4);
  });

  it('keeps an independent chat or completion lock after a settings session closes', () => {
    vi.stubGlobal('addEventListener', vi.fn());
    vi.stubGlobal('document', new EventTarget());
    const input = new Input({ addEventListener() {} } as unknown as HTMLElement);
    input.press('KeyW');
    input.press('KeyE');
    const closeSettings = input.suspend();
    expect([...input.keys]).toEqual([]);
    expect(input.consume('KeyE')).toBe(false);
    input.press('KeyE');
    input.look(60, 0, 0.004);
    input.enabled = false; // Another mode takes control while the menu is open.
    closeSettings();
    expect(input.enabled).toBe(false);
    expect(input.consume('KeyE')).toBe(false);
    expect(input.yaw).toBe(0);
    input.enabled = true;
    expect(input.enabled).toBe(true);
    expect(input.down('KeyW')).toBe(false);
  });

  it('resumes only after every overlapping input lock is released', () => {
    vi.stubGlobal('addEventListener', vi.fn());
    vi.stubGlobal('document', new EventTarget());
    const input = new Input({ addEventListener() {} } as unknown as HTMLElement);
    const closeFirst = input.suspend(), closeSecond = input.suspend();
    closeFirst();
    closeFirst(); // A repeated close cannot consume the other overlay's lock.
    expect(input.enabled).toBe(false);
    input.press('KeyW');
    closeSecond();
    expect(input.enabled).toBe(true);
    expect(input.down('KeyW')).toBe(false);
    input.sensitivity = 0.0044;
    input.look(60, 0, 0.004);
    expect(input.yaw).toBeCloseTo(-0.48);
  });
});
