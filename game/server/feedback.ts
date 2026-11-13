import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sanitizePlayerName } from '../shared/lobby.ts';

export const MAX_FEEDBACK = 2000;
export const MAX_BODY_BYTES = 4096;
const MAX_TEXT = 500;
const MIN_TEXT = 4;
const MAX_CONTACT = 64;
const KINDS = ['bug', 'idea', 'event', 'other'] as const;
export type FeedbackKind = typeof KINDS[number];

export interface FeedbackInput {
  name?: string;
  kind: FeedbackKind;
  text: string;
  contact?: string;
}
export interface FeedbackEntry extends FeedbackInput {
  id: string;
  t: number;
  /** Salted short hash: the file is readable by the maintainer loop, raw player IPs are not needed there. */
  ip: string;
}
export interface FeedbackSummary {
  total: number;
  recent: { id: string; t: number; kind: FeedbackKind; text: string; name?: string }[];
}

export type Validation = { ok: true; value: FeedbackInput } | { ok: false; error: string };

/** Pure input check, shared by the HTTP handler and tests. Text limits count code points, not UTF-16 units. */
export function validateFeedback(value: unknown): Validation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: '反馈格式不正确' };
  const input = value as Record<string, unknown>;
  if (typeof input.kind !== 'string' || !(KINDS as readonly string[]).includes(input.kind)) return { ok: false, error: '请选择反馈类型' };
  if (typeof input.text !== 'string') return { ok: false, error: '请填写反馈内容' };
  const text = input.text.trim();
  const length = Array.from(text).length;
  if (length < MIN_TEXT) return { ok: false, error: '反馈内容至少 4 个字' };
  if (length > MAX_TEXT) return { ok: false, error: '反馈内容最多 500 个字' };
  if (input.name !== undefined && typeof input.name !== 'string') return { ok: false, error: '昵称格式不正确' };
  if (input.contact !== undefined && typeof input.contact !== 'string') return { ok: false, error: '联系方式格式不正确' };
  const name = typeof input.name === 'string' && input.name.trim() ? sanitizePlayerName(input.name) : undefined;
  const contact = typeof input.contact === 'string' ? cleanContact(input.contact) : undefined;
  return { ok: true, value: { kind: input.kind as FeedbackKind, text, ...(name ? { name } : {}), ...(contact ? { contact } : {}) } };
}

function cleanContact(value: string): string {
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  return Array.from(clean).slice(0, MAX_CONTACT).join('');
}

export function hashIp(ip: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 16);
}

/** Append-only JSONL with bounded memory; rewrites go through a temporary file and rename so readers never see half a line. */
export class FeedbackStore {
  private entries: FeedbackEntry[] = [];
  private writes: Promise<void> = Promise.resolve();
  private readonly path: string;
  constructor(path: string) { this.path = path; }

  async load(): Promise<void> {
    try {
      const text = await readFile(this.path, 'utf8');
      this.entries = text.split('\n').filter(Boolean).map(parseLine).filter(validEntry).slice(-MAX_FEEDBACK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('意见箱文件未能读取：', error);
    }
  }

  add(entry: FeedbackEntry): void {
    this.entries = [...this.entries, entry].slice(-MAX_FEEDBACK);
    const snapshot = `${this.entries.map(e => JSON.stringify(e)).join('\n')}\n`;
    this.writes = this.writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await rename(temporary, this.path);
    }).catch(error => { console.error('意见箱保存失败：', error); });
  }

  summary(): FeedbackSummary {
    return {
      total: this.entries.length,
      recent: this.entries.slice(-20).reverse().map(e => ({
        id: e.id, t: e.t, kind: e.kind, text: Array.from(e.text).slice(0, 200).join(''), ...(e.name ? { name: e.name } : {}),
      })),
    };
  }

  async flushed(): Promise<void> { await this.writes; }
}

function parseLine(line: string): unknown {
  try { return JSON.parse(line); } catch { return null; }
}

function validEntry(value: unknown): value is FeedbackEntry {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return typeof e.id === 'string' && e.id.length > 0 && e.id.length <= 64
    && Number.isFinite(e.t) && typeof e.ip === 'string' && e.ip.length <= 64
    && typeof e.kind === 'string' && (KINDS as readonly string[]).includes(e.kind)
    && typeof e.text === 'string' && Array.from(e.text).length <= MAX_TEXT
    && (e.name === undefined || typeof e.name === 'string')
    && (e.contact === undefined || typeof e.contact === 'string');
}

export type LimitDecision = { ok: true } | { ok: false; retryAfter: number };
export interface LimitConfig { burst: number; burstMs: number; daily: number; dayMs: number; global: number; globalMs: number }
const DEFAULT_LIMITS: LimitConfig = { burst: 3, burstMs: 10 * 60_000, daily: 30, dayMs: 24 * 3600_000, global: 200, globalMs: 3600_000 };

/** In-memory token buckets keyed by socket address. A restart forgets them, which is preferable to unbounded storage. */
export class FeedbackLimiter {
  private readonly perIp = new Map<string, number[]>();
  private global: number[] = [];
  private readonly limits: LimitConfig;
  constructor(limits: Partial<LimitConfig> = {}) { this.limits = { ...DEFAULT_LIMITS, ...limits }; }

  take(ip: string, now: number): LimitDecision {
    const { burst, burstMs, daily, dayMs, global, globalMs } = this.limits;
    while (this.global.length && this.global[0] <= now - globalMs) this.global.shift();
    const recent = (this.perIp.get(ip) ?? []).filter(t => t > now - dayMs);
    const burstTimes = recent.filter(t => t > now - burstMs);
    if (burstTimes.length >= burst) return this.reject(burstTimes[burstTimes.length - burst] + burstMs - now);
    if (recent.length >= daily) return this.reject(recent[recent.length - daily] + dayMs - now);
    if (this.global.length >= global) return this.reject(this.global[this.global.length - global] + globalMs - now);
    recent.push(now); this.perIp.set(ip, recent); this.global.push(now);
    if (this.perIp.size > 5000) this.sweep(now);
    return { ok: true };
  }

  private reject(waitMs: number): LimitDecision { return { ok: false, retryAfter: Math.max(1, Math.ceil(waitMs / 1000)) }; }

  private sweep(now: number): void {
    for (const [ip, times] of this.perIp) if ((times[times.length - 1] ?? 0) <= now - this.limits.dayMs) this.perIp.delete(ip);
    // A spray of one-shot addresses can still exceed 5000 within a day; evict insertion-order oldest until bounded.
    for (const ip of this.perIp.keys()) { if (this.perIp.size <= 5000) break; this.perIp.delete(ip); }
  }
}

export interface FeedbackOptions {
  store: FeedbackStore;
  limiter: FeedbackLimiter;
  /** Unset means the summary route does not exist (fail closed). */
  token?: string;
  salt?: string;
  ready?: Promise<void>;
  now?: () => number;
}

const DEFAULT_SALT = process.env.FEEDBACK_SALT ?? randomUUID();

/** Owns /api/feedback and /api/feedback/summary, mirroring handleDownloads' boolean ownership contract. */
export function handleFeedback(req: IncomingMessage, res: ServerResponse, url: URL, options: FeedbackOptions): boolean {
  if (url.pathname === '/api/feedback/summary') { void serveSummary(req, res, options).catch(error => fail(res, error)); return true; }
  if (url.pathname !== '/api/feedback') return false;
  void serveSubmit(req, res, options).catch(error => fail(res, error));
  return true;
}

async function serveSummary(req: IncomingMessage, res: ServerResponse, options: FeedbackOptions): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' }).end(); return; }
  if (!options.token) { res.writeHead(404, { 'cache-control': 'no-store' }).end(); return; }
  if (!tokenMatches(req.headers['x-feedback-token'], options.token)) { res.writeHead(401, { 'cache-control': 'no-store' }).end(); return; }
  await options.ready;
  const body = JSON.stringify(options.store.summary());
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(req.method === 'HEAD' ? undefined : body);
}

async function serveSubmit(req: IncomingMessage, res: ServerResponse, options: FeedbackOptions): Promise<void> {
  if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' }).end(); return; }
  const type = req.headers['content-type'];
  if (typeof type !== 'string' || type.split(';')[0].trim().toLowerCase() !== 'application/json') {
    res.writeHead(415, { 'cache-control': 'no-store' }).end(); return;
  }
  const declared = req.headers['content-length'];
  if (declared !== undefined) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) { res.writeHead(400, { 'cache-control': 'no-store' }).end(); return; }
    if (length > MAX_BODY_BYTES) { res.writeHead(413, { 'cache-control': 'no-store' }).end(); req.resume(); return; }
  }
  const body = await readLimitedBody(req);
  // The unread remainder is discarded by closing the socket, not by buffering it.
  if (body === null) { res.writeHead(413, { 'cache-control': 'no-store', connection: 'close' }).end(); return; }
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { res.writeHead(400, { 'cache-control': 'no-store' }).end(); return; }
  const checked = validateFeedback(parsed);
  if (!checked.ok) { sendJson(res, 400, { ok: false, error: checked.error }); return; }
  await options.ready;
  const now = options.now?.() ?? Date.now();
  const address = req.socket.remoteAddress ?? 'unknown';
  const decision = options.limiter.take(address, now);
  if (!decision.ok) { sendJson(res, 429, { ok: false, error: '提交太频繁了，请稍后再试' }, { 'retry-after': String(decision.retryAfter) }); return; }
  const entry: FeedbackEntry = { id: randomUUID(), t: now, ip: hashIp(address, options.salt ?? DEFAULT_SALT), ...checked.value };
  options.store.add(entry);
  // 201 means the line is on disk, so a crash right after the response cannot lose a submitted report.
  await options.store.flushed();
  sendJson(res, 201, { ok: true, id: entry.id });
}

/** Resolves null when the stream exceeds the cap, so a missing or lying content-length cannot grow memory. */
export function readLimitedBody(req: Pick<IncomingMessage, 'on' | 'off' | 'resume'>): Promise<string | null> {
  return new Promise(resolve => {
    let size = 0, done = false;
    const chunks: Buffer[] = [];
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      req.off('data', onData); req.off('end', onEnd); req.off('error', onError);
      resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      if (size > MAX_BODY_BYTES) { finish(null); req.resume(); return; }
      chunks.push(buffer);
    };
    const onEnd = () => finish(Buffer.concat(chunks).toString('utf8'));
    const onError = () => finish(null);
    req.on('data', onData); req.on('end', onEnd); req.on('error', onError);
  });
}

function tokenMatches(provided: string | string[] | undefined, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(text);
}

function fail(res: ServerResponse, error: unknown): void {
  console.error('意见箱处理失败：', error);
  if (res.headersSent) res.destroy();
  else res.writeHead(500, { 'cache-control': 'no-store' }).end();
}
