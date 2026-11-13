/** One release record is both bundled into the client and published at /version.json. */
export interface Release { id: string; date: string; entries: string[] }

export function parseRelease(value: unknown): Release | null {
  if (!value || typeof value !== 'object') return null;
  const { id, date, entries } = value as Partial<Release>;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) return null;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(date);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return null;
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 6 ||
      entries.some((entry) => typeof entry !== 'string' || !entry.trim() || entry.length > 240)) return null;
  return { id, date, entries: entries.map((entry) => entry.trim()) };
}

/** The first successful response establishes a baseline without announcing a deployment.
 * Later checks also detect a client that opened from an older cached page. A failed request
 * must never reach observe(), so it cannot consume this first successful response. */
export class ReleaseBaseline {
  private ready = false;
  private readonly loadedId: string;
  constructor(loadedId: string) { this.loadedId = loadedId; }
  observe(release: Release): Release | null | undefined {
    if (!this.ready) { this.ready = true; return undefined; }
    return release.id === this.loadedId ? null : release;
  }
}
