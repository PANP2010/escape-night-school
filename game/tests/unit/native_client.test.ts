import { describe, expect, it } from 'vitest';
import { nativePlatform } from '../../client/src/nativeClient.ts';

describe('installed client presentation', () => {
  it('identifies the desktop bridge and Android bundled origin', () => {
    expect(nativePlatform('http://127.0.0.1:4100', Object.freeze({ platform: 'desktop' }))).toBe('desktop');
    expect(nativePlatform('https://school.example', { platform: 'desktop' })).toBe('desktop');
    expect(nativePlatform('http://night-school.local')).toBe('android');
  });
  it('keeps ordinary desktop/mobile browsers and lookalike native parameters on the browser UI', () => {
    for (const origin of ['http://127.0.0.1:4100', 'http://192.168.1.10:52123', 'https://school.example',
      'http://night-school.local.example', 'http://night-school.local:4100', 'https://night-school.local', 'null']) {
      expect(nativePlatform(origin)).toBeUndefined();
      expect(nativePlatform(origin, { platform: 'browser', native: true })).toBeUndefined();
    }
  });
});
