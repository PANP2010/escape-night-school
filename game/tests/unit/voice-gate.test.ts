import { describe, expect, it } from 'vitest';
import { Voice, subtitleVisible } from '../../client/src/voice.ts';

describe('subtitle gating', () => {
  it('hides beyond 20 m', () => {
    expect(subtitleVisible(5)).toBe(true);
    expect(subtitleVisible(20)).toBe(true);
    expect(subtitleVisible(50)).toBe(false);
    expect(subtitleVisible(Infinity)).toBe(false);
  });
  it('far line leaves the subtitle empty', () => {
    const el = { textContent: '', dataset: {}, classList: { toggle() {}, remove() {}, add() {} }, style: {}, offsetWidth: 0 } as unknown as HTMLElement;
    new Voice(el).say('x', 50);
    expect(el.textContent).toBe('');
  });
});
