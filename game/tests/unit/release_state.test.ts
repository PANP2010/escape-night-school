import { describe, expect, it } from 'vitest';
import { parseRelease, ReleaseBaseline, type Release } from '../../client/src/releaseState.ts';
import published from '../../client/public/version.json';

const release = (id: string): Release => ({ ...published, id });

describe('published release metadata', () => {
  it('is valid and describes the published networking hotfix', () => {
    expect(parseRelease(published)).toEqual(published);
    expect(published.id).toBe('0.6.3');
    expect(published.entries.join(' ')).toContain('连接超时');
    expect(published.entries.join(' ')).toContain('大逃杀');
    expect(published.entries.join(' ')).toContain('角色074');
  });
  it.each([
    null, {}, { ...published, id: '' }, { ...published, date: '2026-02-30' },
    { ...published, entries: [] }, { ...published, entries: ['  '] },
    { ...published, entries: [42] }, { ...published, entries: ['x'.repeat(241)] },
  ])('rejects incomplete or malformed server metadata: %j', (value) => {
    expect(parseRelease(value)).toBeNull();
  });
});

describe('client release baseline', () => {
  it('the previous 0.5.0 client detects the published record after its first baseline', () => {
    const cached = new ReleaseBaseline('0.5.0');
    expect(cached.observe(published)).toBeUndefined();
    expect(cached.observe(published)).toEqual(published);
  });
  it('establishes a baseline, then detects a deployment and clears after a rollback to the loaded version', () => {
    const client = new ReleaseBaseline('0.3.0');
    expect(client.observe(release('0.3.0'))).toBeUndefined();
    expect(client.observe(release('0.3.0'))).toBeNull();
    expect(client.observe(release('0.3.1'))?.id).toBe('0.3.1');
    expect(client.observe(release('0.3.2'))?.id).toBe('0.3.2');
    expect(client.observe(release('0.3.0'))).toBeNull();
  });
  it('does not announce on first fetch even for a cached client, but detects its stale version on a later check', () => {
    const cached = new ReleaseBaseline('0.2.0');
    expect(cached.observe(release('0.3.0'))).toBeUndefined();
    expect(cached.observe(release('0.3.0'))?.id).toBe('0.3.0');
    const fresh = new ReleaseBaseline('0.3.0');
    expect(fresh.observe(release('0.3.0'))).toBeUndefined();
    expect(fresh.observe(release('0.3.0'))).toBeNull();
  });
});
