import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { FeedbackLimiter, FeedbackStore, handleFeedback, validateFeedback, type FeedbackOptions } from '../../server/feedback.ts';

const dirs: string[] = [], servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function file(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), 'escape-feedback-')); dirs.push(dir); return join(dir, 'feedback.jsonl'); }

async function serve(overrides: Partial<FeedbackOptions> = {}): Promise<{ url: string; store: FeedbackStore; limiter: FeedbackLimiter; path: string }> {
  const path = await file(), store = new FeedbackStore(path), limiter = overrides.limiter ?? new FeedbackLimiter();
  await store.load();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!handleFeedback(req, res, url, { store, limiter, token: 'secret-token', ...overrides })) { res.writeHead(404).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, store, limiter, path };
}
const post = (url: string, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  fetch(`${url}/api/feedback`, { method: 'POST', headers, body: JSON.stringify(body) });
const valid = { kind: 'bug', text: '教学楼三层的门打不开', name: '同学' };

describe('feedback validation', () => {
  it('accepts the documented shape and trims text', () => {
    expect(validateFeedback({ ...valid, text: '  门打不开  ' })).toEqual({ ok: true, value: { kind: 'bug', text: '门打不开', name: '同学' } });
    expect(validateFeedback({ kind: 'idea', text: '希望增加新地图', contact: 'a@b.c' })).toMatchObject({ ok: true, value: { contact: 'a@b.c' } });
  });

  it('rejects short, long, unknown-kind and malformed input', () => {
    expect(validateFeedback({ ...valid, text: '  短  ' })).toMatchObject({ ok: false });
    expect(validateFeedback({ ...valid, text: '字'.repeat(501) })).toMatchObject({ ok: false });
    expect(validateFeedback({ ...valid, text: '字'.repeat(500) })).toMatchObject({ ok: true });
    expect(validateFeedback({ ...valid, kind: 'spam' })).toMatchObject({ ok: false });
    expect(validateFeedback({ ...valid, contact: 42 })).toMatchObject({ ok: false });
    expect(validateFeedback(null)).toMatchObject({ ok: false });
  });

  it('strips control characters from contact and caps it at 64', () => {
    const checked = validateFeedback({ ...valid, contact: `\u0000${'x'.repeat(80)}` });
    expect(checked.ok && Array.from(checked.value.contact ?? '')).toHaveLength(64);
    expect(checked.ok && checked.value.contact?.includes('\u0000')).toBe(false);
  });
});

describe('feedback HTTP surface', () => {
  it('rejects wrong methods, wrong content type and oversized bodies', async () => {
    const { url } = await serve();
    expect((await fetch(`${url}/api/feedback`)).status).toBe(405);
    expect((await post(url, valid, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await post(url, { ...valid, text: 'x'.repeat(5000) })).status).toBe(413);
    // No content-length: the stream itself must be cut off at 4 KiB.
    const chunked = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ ...valid, text: 'x'.repeat(5000) }))); controller.close(); },
    });
    const lying = await fetch(`${url}/api/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: chunked, duplex: 'half' } as RequestInit);
    expect(lying.status).toBe(413);
    expect((await post(url, valid)).status).toBe(201);
  });

  it('limits each IP to three submissions per ten minutes without touching other addresses', async () => {
    const { url, path } = await serve();
    for (let i = 0; i < 3; i++) expect((await post(url, valid)).status).toBe(201);
    const blocked = await post(url, valid);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    const other = new FeedbackLimiter();
    expect(other.take('10.0.0.2', Date.now())).toEqual({ ok: true });
    const stored = (await readFile(path, 'utf8')).trim().split('\n');
    expect(stored).toHaveLength(3);
  });

  it('enforces the daily and global caps', () => {
    const now = 1_000_000;
    const limiter = new FeedbackLimiter({ burst: 100, daily: 30, global: 2 });
    expect(limiter.take('a', now)).toEqual({ ok: true });
    expect(limiter.take('b', now)).toEqual({ ok: true });
    const global = limiter.take('c', now);
    expect(global.ok).toBe(false);
    const daily = new FeedbackLimiter({ burst: 100, daily: 2 });
    expect(daily.take('a', now)).toEqual({ ok: true }); expect(daily.take('a', now)).toEqual({ ok: true });
    expect(daily.take('a', now).ok).toBe(false);
    // Ten minutes after the first burst token expires, the same address is allowed again.
    expect(new FeedbackLimiter({ burst: 3 }).take('a', now)).toEqual({ ok: true });
  });
});

describe('feedback storage and summary', () => {
  it('round-trips entries, drops the oldest beyond 2000 and stores only a salted IP hash', async () => {
    const path = await file(), store = new FeedbackStore(path);
    for (let i = 0; i < 2001; i++) store.add({ id: `id-${i}`, t: i, ip: 'abcdef0123456789', kind: 'other', text: `第 ${i} 条反馈` });
    await store.flushed();
    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2000);
    expect(JSON.parse(lines[0]).id).toBe('id-1');
    const restored = new FeedbackStore(path); await restored.load();
    expect(restored.summary().total).toBe(2000);
    expect(restored.summary().recent[0].text).toBe('第 2000 条反馈');
  });

  it('hashes the submitter IP instead of persisting it', async () => {
    const { url, path } = await serve();
    expect((await post(url, valid)).status).toBe(201);
    const entry = JSON.parse((await readFile(path, 'utf8')).trim());
    expect(entry.ip).toMatch(/^[a-f0-9]{16}$/);
    expect(entry.ip).not.toContain('127.0.0.1');
    expect(JSON.stringify(entry)).not.toContain('127.0.0.1');
  });

  it('keeps the summary closed when no token is configured and requires the matching token otherwise', async () => {
    const closed = await serve({ token: undefined });
    expect((await fetch(`${closed.url}/api/feedback/summary`)).status).toBe(404);
    const { url } = await serve();
    await post(url, valid);
    expect((await fetch(`${url}/api/feedback/summary`)).status).toBe(401);
    expect((await fetch(`${url}/api/feedback/summary`, { headers: { 'x-feedback-token': 'wrong' } })).status).toBe(401);
    const response = await fetch(`${url}/api/feedback/summary`, { headers: { 'x-feedback-token': 'secret-token' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ total: 1, recent: [{ kind: 'bug', text: valid.text, name: '同学' }] });
  });

  it('truncates summary text to 200 characters', async () => {
    const path = await file(), store = new FeedbackStore(path);
    store.add({ id: 'long', t: 1, ip: 'x', kind: 'idea', text: '字'.repeat(500) });
    await store.flushed();
    expect(Array.from(store.summary().recent[0].text)).toHaveLength(200);
  });
});
