import { describe, expect, it, vi } from 'vitest';
import { boxesOverlap, viewportInsets, watchChatViewport } from '../../client/src/hudLayout.ts';

const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

describe('boxesOverlap (hint vs chat column)', () => {
  it('640×360 repro: two-line hint touching the caught message counts as overlap with a gap', () => {
    const hint = box(13, 320, 627, 353), log = box(12, 284, 268, 320); // measured in #211 before the fix
    expect(boxesOverlap(hint, log)).toBe(false); // edges only touch…
    expect(boxesOverlap(hint, log, 6)).toBe(true); // …but they read as one block
  });
  it('1280×720: one-line centred hint clears the chat column', () => {
    expect(boxesOverlap(box(243, 693, 1037, 709), box(12, 644, 372, 680), 6)).toBe(false);
  });
  it('hidden / empty boxes never overlap', () => {
    expect(boxesOverlap(box(13, 320, 627, 353), box(0, 0, 0, 0), 6)).toBe(false);
    expect(boxesOverlap(box(13, 320, 627, 353), box(12, 340, 268, 340), 6)).toBe(false);
  });
  it('real overlap', () => {
    expect(boxesOverlap(box(0, 0, 100, 100), box(50, 50, 150, 150))).toBe(true);
  });
});

describe('chat visible viewport', () => {
  it('keeps the full screen available when visualViewport is unsupported', () => {
    expect(viewportInsets(844, 390)).toEqual({ top: 0, right: 0, bottom: 0, left: 0, width: 844, height: 390 });
  });

  it('raises landscape chat above the keyboard without changing the game viewport', () => {
    expect(viewportInsets(844, 390, { width: 844, height: 162, offsetLeft: 0, offsetTop: 0 }))
      .toEqual({ top: 0, right: 0, bottom: 228, left: 0, width: 844, height: 162 });
  });

  it('accounts for Safari panning the visible rectangle after a portrait keyboard opens', () => {
    expect(viewportInsets(390, 844, { width: 354, height: 320, offsetLeft: 18, offsetTop: 130 }))
      .toEqual({ top: 130, right: 18, bottom: 394, left: 18, width: 354, height: 320 });
  });

  it('bounds transient viewport values during rotation and rejects non-finite dimensions', () => {
    expect(viewportInsets(390, 844, { width: 844, height: 390, offsetLeft: -10, offsetTop: 800 }))
      .toEqual({ top: 800, right: 0, bottom: 0, left: 0, width: 390, height: 44 });
    expect(viewportInsets(390, 844, { width: NaN, height: Infinity, offsetLeft: NaN, offsetTop: -4 }))
      .toEqual({ top: 0, right: 0, bottom: 0, left: 0, width: 390, height: 844 });
  });

  it('updates scoped CSS variables on keyboard resize, viewport pan and rotation, then removes all listeners', () => {
    const visual = Object.assign(new EventTarget(), { width: 844, height: 390, offsetLeft: 0, offsetTop: 0 });
    const view = Object.assign(new EventTarget(), { innerWidth: 844, innerHeight: 390, visualViewport: visual });
    const values = new Map<string, string>();
    const root = { style: { setProperty: (name: string, value: string) => values.set(name, value) } } as unknown as HTMLElement;
    const changed = vi.fn();
    const watcher = watchChatViewport(root, changed, view as unknown as Window);
    expect(values.get('--chat-viewport-bottom')).toBe('0px');
    visual.height = 162; visual.dispatchEvent(new Event('resize'));
    expect(values.get('--chat-viewport-bottom')).toBe('228px');
    visual.offsetTop = 40; visual.dispatchEvent(new Event('scroll'));
    expect(values.get('--chat-viewport-top')).toBe('40px');
    expect(values.get('--chat-viewport-bottom')).toBe('188px');
    Object.assign(view, { innerWidth: 390, innerHeight: 844 });
    Object.assign(visual, { width: 354, height: 320, offsetLeft: 18, offsetTop: 130 });
    view.dispatchEvent(new Event('resize'));
    expect(values.get('--chat-viewport-width')).toBe('354px');
    expect(values.get('--chat-viewport-left')).toBe('18px');
    expect(values.get('--chat-viewport-bottom')).toBe('394px');
    expect(changed).toHaveBeenCalledTimes(4);
    watcher.dispose();
    visual.dispatchEvent(new Event('resize')); visual.dispatchEvent(new Event('scroll'));
    view.dispatchEvent(new Event('resize')); view.dispatchEvent(new Event('scroll'));
    expect(changed).toHaveBeenCalledTimes(4);
  });
});
