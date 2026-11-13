import { afterEach, describe, expect, it, vi } from 'vitest';
import { Haptics } from '../../client/src/haptics.ts';
import type { HapticKind, HapticsOptions } from '../../client/src/haptics.ts';

function fixture(options: Partial<HapticsOptions> = {}) {
  let now = 1000;
  const visibilityListeners = new Set<() => void>();
  const reducedListeners = new Set<() => void>();
  const vibrate = vi.fn((_pattern: number | number[]) => true);
  const activation = { isActive: true };
  const nav = { vibrate, maxTouchPoints: 1, userAgent: '', userActivation: activation };
  const doc = {
    hidden: false,
    addEventListener: vi.fn((_type: string, fn: () => void) => { visibilityListeners.add(fn); }),
    removeEventListener: vi.fn((_type: string, fn: () => void) => { visibilityListeners.delete(fn); }),
  };
  const reduced = {
    matches: false,
    addEventListener: vi.fn((_type: string, fn: () => void) => { reducedListeners.add(fn); }),
    removeEventListener: vi.fn((_type: string, fn: () => void) => { reducedListeners.delete(fn); }),
  };
  const coarse = { matches: false };
  const haptics = new Haptics({
    navigator: nav, document: doc, now: () => now,
    matchMedia: (query) => query.includes('reduced-motion') ? reduced : coarse,
    ...options,
  });
  return {
    haptics, nav, doc, reduced, coarse, vibrate, activation, visibilityListeners, reducedListeners,
    advance: (ms: number) => { now += ms; },
    visibility: (hidden: boolean) => { doc.hidden = hidden; for (const listener of visibilityListeners) listener(); },
    reduce: (matches: boolean) => { reduced.matches = matches; for (const listener of reducedListeners) listener(); },
  };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Haptics user gesture and support boundaries', () => {
  it('does not vibrate until unlock, and unlock itself is silent', () => {
    const f = fixture();
    expect(f.haptics.pulse('door')).toBe(false);
    f.haptics.setEnabled(true);
    expect(f.haptics.pulse('pickup')).toBe(false);
    f.haptics.unlock();
    expect(f.vibrate).not.toHaveBeenCalled();
    expect(f.haptics.pulse('door')).toBe(true);
    expect(f.vibrate).toHaveBeenCalledExactlyOnceWith(12);
  });

  it('rejects unlock without current browser user activation or while hidden', () => {
    const f = fixture();
    f.activation.isActive = false;
    f.haptics.unlock();
    f.activation.isActive = true;
    expect(f.haptics.pulse('door')).toBe(false);
    f.visibility(true);
    f.haptics.unlock();
    f.visibility(false);
    expect(f.haptics.pulse('door')).toBe(false);
    f.haptics.unlock();
    f.activation.isActive = false; // Accepted network events can arrive after the gesture.
    expect(f.haptics.pulse('door')).toBe(true);
  });

  it('allows the trusted gesture boundary on older touch browsers', () => {
    const vibrate = vi.fn(() => true);
    const f = fixture({ navigator: { maxTouchPoints: 1, vibrate } });
    expect(f.haptics.pulse('pickup')).toBe(false);
    f.haptics.unlock();
    expect(f.haptics.pulse('pickup')).toBe(true);
    expect(vibrate).toHaveBeenCalledExactlyOnceWith(10);
  });

  it('requires touch points, a coarse pointer, or a mobile browser', () => {
    const desktop = fixture();
    desktop.nav.maxTouchPoints = 0;
    desktop.haptics.unlock();
    expect(desktop.haptics.pulse('door')).toBe(false);
    expect(desktop.vibrate).not.toHaveBeenCalled();
    desktop.coarse.matches = true;
    expect(desktop.haptics.pulse('door')).toBe(true);
    const mobile = fixture();
    mobile.nav.maxTouchPoints = 0;
    mobile.nav.userAgent = 'Mozilla/5.0 (Linux; Android 14) Mobile';
    mobile.haptics.unlock();
    expect(mobile.haptics.pulse('door')).toBe(true);
  });

  it('uses browser defaults without explicit environment arguments', () => {
    const f = fixture();
    vi.stubGlobal('navigator', f.nav);
    vi.stubGlobal('document', f.doc);
    vi.stubGlobal('window', { matchMedia: (q: string) => q.includes('reduced-motion') ? f.reduced : f.coarse });
    const haptics = new Haptics();
    expect(haptics.pulse('toggle')).toBe(false);
    haptics.unlock();
    expect(haptics.pulse('toggle')).toBe(true);
    haptics.dispose();
  });

  it('is safe without browser globals or navigator.vibrate', () => {
    vi.stubGlobal('navigator', undefined);
    vi.stubGlobal('document', undefined);
    vi.stubGlobal('window', undefined);
    const server = new Haptics();
    server.unlock();
    expect(server.pulse('door')).toBe(false);
    expect(() => { server.cancel(); server.dispose(); }).not.toThrow();
    const f = fixture({ navigator: { maxTouchPoints: 1 } });
    f.haptics.unlock();
    expect(f.haptics.pulse('door')).toBe(false);
  });

  it.each(['throws', 'declines'] as const)('rate-limits API attempts when vibrate %s, then allows a retry', (failure) => {
    const f = fixture();
    f.haptics.unlock();
    if (failure === 'throws') f.vibrate.mockImplementationOnce(() => { throw new Error('blocked'); });
    else f.vibrate.mockReturnValueOnce(false);
    expect(f.haptics.pulse('door')).toBe(false);
    // A rejected API request still needs a global limit during an event burst.
    for (let i = 0; i < 100; i++) expect(f.haptics.pulse('pickup')).toBe(false);
    expect(f.vibrate).toHaveBeenCalledExactlyOnceWith(12);
    f.advance(179);
    expect(f.haptics.pulse('door')).toBe(false);
    expect(f.vibrate).toHaveBeenCalledTimes(1);
    f.advance(1);
    // The failed effect does not consume its longer per-kind cooldown.
    expect(f.haptics.pulse('door')).toBe(true);
    expect(f.vibrate).toHaveBeenCalledTimes(2);
  });

  it('does not cancel a declined effect through repeated lifecycle changes', () => {
    const f = fixture();
    f.haptics.unlock();
    f.vibrate.mockReturnValue(false);
    expect(f.haptics.pulse('danger')).toBe(false);
    f.visibility(true);
    f.reduce(true);
    f.haptics.setEnabled(false);
    f.haptics.cancel();
    f.haptics.dispose();
    expect(f.vibrate).toHaveBeenCalledExactlyOnceWith([15, 40, 15]);
  });

  it('keeps working if matchMedia is unavailable or throws', () => {
    const f = fixture({ matchMedia: () => { throw new Error('unsupported'); } });
    f.haptics.unlock();
    expect(f.haptics.pulse('door')).toBe(true);
  });
});

describe('Haptics preference and lifecycle boundaries', () => {
  it('honors the user switch and cancels an active effect only once', () => {
    const f = fixture();
    f.haptics.unlock();
    f.haptics.setEnabled(false);
    expect(f.haptics.pulse('danger')).toBe(false);
    expect(f.vibrate).not.toHaveBeenCalled();
    f.haptics.setEnabled(true);
    expect(f.haptics.pulse('danger')).toBe(true);
    f.haptics.setEnabled(false);
    f.haptics.setEnabled(false);
    f.haptics.cancel();
    f.haptics.dispose();
    expect(f.vibrate.mock.calls).toEqual([[[15, 40, 15]], [0]]);
  });

  it('blocks hidden documents and cancels immediately on visibility change', () => {
    const f = fixture();
    f.haptics.unlock();
    expect(f.haptics.pulse('danger')).toBe(true);
    f.visibility(true);
    f.visibility(true);
    expect(f.haptics.pulse('down')).toBe(false);
    expect(f.vibrate.mock.calls).toEqual([[[15, 40, 15]], [0]]);
    f.advance(180);
    f.visibility(false);
    expect(f.haptics.pulse('down')).toBe(true);
  });

  it('honors initial and dynamically changed reduced motion', () => {
    const f = fixture();
    f.haptics.unlock();
    f.reduce(true);
    expect(f.haptics.pulse('danger')).toBe(false);
    expect(f.vibrate).not.toHaveBeenCalled();
    f.reduce(false);
    expect(f.haptics.pulse('danger')).toBe(true);
    f.reduce(true);
    f.reduce(true);
    expect(f.haptics.pulse('down')).toBe(false);
    expect(f.vibrate.mock.calls).toEqual([[[15, 40, 15]], [0]]);
    f.advance(180);
    f.reduce(false);
    expect(f.haptics.pulse('down')).toBe(true);
  });

  it('supports legacy media-query listeners and removes them on disposal', () => {
    const listeners = new Set<() => void>();
    const reduced = {
      matches: false,
      addListener: vi.fn((fn: () => void) => { listeners.add(fn); }),
      removeListener: vi.fn((fn: () => void) => { listeners.delete(fn); }),
    };
    const f = fixture({ matchMedia: (q) => q.includes('reduced-motion') ? reduced : { matches: false } });
    f.haptics.unlock();
    expect(f.haptics.pulse('down')).toBe(true);
    reduced.matches = true;
    for (const fn of listeners) fn();
    expect(f.vibrate).toHaveBeenLastCalledWith(0);
    f.haptics.dispose();
    expect(listeners.size).toBe(0);
    expect(reduced.removeListener).toHaveBeenCalledExactlyOnceWith(reduced.addListener.mock.calls[0][0]);
  });

  it('disposes idempotently, cancels once, and removes both listeners', () => {
    const f = fixture();
    f.haptics.unlock();
    expect(f.haptics.pulse('revive')).toBe(true);
    f.haptics.dispose();
    f.haptics.dispose();
    f.haptics.cancel();
    f.haptics.setEnabled(true);
    f.haptics.unlock();
    f.advance(2000);
    expect(f.haptics.pulse('success')).toBe(false);
    expect(f.vibrate.mock.calls).toEqual([[[12, 30, 18]], [0]]);
    expect(f.visibilityListeners.size).toBe(0);
    expect(f.reducedListeners.size).toBe(0);
    expect(f.doc.removeEventListener).toHaveBeenCalledExactlyOnceWith('visibilitychange', f.doc.addEventListener.mock.calls[0][1]);
    expect(f.reduced.removeEventListener).toHaveBeenCalledExactlyOnceWith('change', f.reduced.addEventListener.mock.calls[0][1]);
  });

  it('does not send cancellation for an expired effect or when never active', () => {
    const f = fixture();
    f.haptics.cancel();
    f.haptics.unlock();
    expect(f.haptics.pulse('toggle')).toBe(true);
    f.advance(8);
    f.haptics.cancel();
    f.visibility(true);
    f.reduce(true);
    f.haptics.setEnabled(false);
    f.haptics.dispose();
    expect(f.vibrate).toHaveBeenCalledExactlyOnceWith(8);
  });

  it('cancellation is safe and remains idempotent if the browser throws', () => {
    const f = fixture();
    f.haptics.unlock();
    expect(f.haptics.pulse('danger')).toBe(true);
    f.vibrate.mockImplementationOnce(() => { throw new Error('revoked'); });
    expect(() => { f.haptics.cancel(); f.haptics.cancel(); f.haptics.dispose(); }).not.toThrow();
    expect(f.vibrate.mock.calls).toEqual([[[15, 40, 15]], [0]]);
  });
});

describe('Haptics restraint', () => {
  it('rate-limits different events globally with an exact boundary', () => {
    const f = fixture();
    f.haptics.unlock();
    expect(f.haptics.pulse('door')).toBe(true);
    f.advance(179);
    expect(f.haptics.pulse('pickup')).toBe(false);
    f.advance(1);
    expect(f.haptics.pulse('pickup')).toBe(true);
    expect(f.vibrate.mock.calls).toEqual([[12], [10]]);
  });

  it('deduplicates the same event beyond the global cooldown without delaying other events', () => {
    const f = fixture();
    f.haptics.unlock();
    expect(f.haptics.pulse('danger')).toBe(true);
    f.advance(180);
    expect(f.haptics.pulse('danger')).toBe(false);
    expect(f.haptics.pulse('pickup')).toBe(true);
    f.advance(1319);
    expect(f.haptics.pulse('danger')).toBe(false);
    f.advance(1);
    expect(f.haptics.pulse('danger')).toBe(true);
    expect(f.vibrate.mock.calls).toEqual([[[15, 40, 15]], [10], [[15, 40, 15]]]);
  });

  it('does not bypass limits through cancel or switching preferences', () => {
    const f = fixture();
    f.haptics.unlock();
    expect(f.haptics.pulse('door')).toBe(true);
    f.haptics.cancel();
    f.haptics.setEnabled(false);
    f.haptics.setEnabled(true);
    expect(f.haptics.pulse('pickup')).toBe(false);
    f.advance(180);
    expect(f.haptics.pulse('door')).toBe(false);
    expect(f.haptics.pulse('pickup')).toBe(true);
  });

  it('uses only bounded short effects and never schedules repeat vibration', () => {
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    const interval = vi.spyOn(globalThis, 'setInterval');
    const f = fixture();
    f.haptics.unlock();
    const kinds: HapticKind[] = ['toggle', 'door', 'pickup', 'danger', 'down', 'revive', 'success'];
    for (const kind of kinds) {
      expect(f.haptics.pulse(kind)).toBe(true);
      const pattern = f.vibrate.mock.calls.at(-1)![0];
      const values = Array.isArray(pattern) ? pattern : [pattern];
      expect(values.length).toBeLessThanOrEqual(3);
      expect(values.every((ms) => ms > 0)).toBe(true);
      expect(values.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(100);
      f.advance(2000);
    }
    expect(f.vibrate).toHaveBeenCalledTimes(kinds.length);
    expect(timeout).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
  });
});
