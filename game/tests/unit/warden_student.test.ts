import { describe, expect, it } from 'vitest';
import { HIDE_NEAR, tooClose } from '../../client/src/warden/student.ts';

describe('tooClose', () => {
  it('hides a teammate whose head would contain the camera', () => {
    expect(tooClose(0, 0)).toBe(true);
    expect(tooClose(0.3, 0.3)).toBe(true);
  });
  it('keeps them drawn at arm length and beyond', () => {
    expect(tooClose(HIDE_NEAR, 0)).toBe(false);
    expect(tooClose(2, 2)).toBe(false);
  });
});
