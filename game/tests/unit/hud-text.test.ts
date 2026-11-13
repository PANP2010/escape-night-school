import { describe, expect, it } from 'vitest';
import { barFrac, touchPrompt } from '../../client/src/hudText.ts';

describe('hud text', () => {
  it('rewrites the E key prompt for touch', () => {
    expect(touchPrompt('E 拾取')).toBe('点物品 · 拾取');
    expect(touchPrompt('按住 E 救人')).toBe('按住队友 救人');
    expect(touchPrompt('')).toBe('');
    expect(touchPrompt('门锁着')).toBe('门锁着');
  });
  it('clamps the bar fraction', () => {
    expect(barFrac(0.62)).toBe(0.62);
    expect(barFrac(1.4)).toBe(1);
    expect(barFrac(-1)).toBe(0);
    expect(barFrac(NaN)).toBe(0);
  });
});
