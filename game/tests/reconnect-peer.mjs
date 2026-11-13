// A real ws peer shared by reconnect acceptance probes. Tokens stay in memory only.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function waitFor(read, label, timeout = 8000) {
  const until = performance.now() + timeout;
  while (performance.now() < until) {
    const result = read();
    if (result) return result;
    await delay(20);
  }
  throw new Error(`Timed out: ${label} (${timeout} ms)`);
}
export const near = (a, b, tolerance = .025) => Array.isArray(a) && Array.isArray(b)
  && Math.hypot(...a.map((v, i) => v - b[i])) <= tolerance;

export class ReconnectPeer {
  constructor(url, name, { autoPong = true } = {}) {
    this.name = name;
    this.history = [];
    this.latest = new Map();
    this.players = new Map();
    this.seq = 0;
    this.socket = new WebSocket(url, { handshakeTimeout: 8000, autoPong });
    this.opened = new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', () => reject(new Error(`${name}: WebSocket handshake failed`)));
    });
    // Do not include received payloads/errors in failure output: hello/welcome carry credentials.
    this.socket.on('error', () => { this.fault = 'WebSocket transport error'; });
    this.socket.on('close', code => { this.closed = { code, at: performance.now() }; });
    this.socket.on('message', raw => {
      let m;
      try { m = JSON.parse(String(raw)); }
      catch { this.fault = 'Invalid server JSON'; return; }
      this.history.push(m);
      this.latest.set(m.t, m);
      if (m.t === 'heartbeat' && this.socket.readyState === WebSocket.OPEN) this.send({ t: 'heartbeat' });
      if (m.t === 'welcome') {
        this.id = m.id;
        if (typeof m.token === 'string') this.token = m.token;
      }
      if (m.t === 'correct') this.correction = m;
      if (m.t === 'snap') {
        // Membership is authoritative on each full player list; departed peers cannot remain as ghosts.
        const present = new Set(m.players.map(p => p.id));
        for (const id of this.players.keys()) if (!present.has(id)) this.players.delete(id);
        for (const p of m.players) {
          const old = this.players.get(p.id);
          this.players.set(p.id, { ...old, ...p, st: p.st ?? 0, f: p.f ?? old?.f ?? 0, online: p.online !== false });
        }
      }
    });
  }
  mark() { return this.history.length; }
  last(type) { return this.latest.get(type); }
  since(mark, read) { return this.history.slice(mark).filter(read); }
  send(message) {
    assert.equal(this.socket.readyState, WebSocket.OPEN, `${this.name}: socket must be open`);
    this.socket.send(JSON.stringify(message));
  }
  async after(mark, read, label, timeout = 8000) {
    return waitFor(() => this.since(mark, read)[0], `${this.name}: ${label}`, timeout);
  }
  async hello(resume) {
    await this.opened;
    const initial = await this.after(0, m => m.t === 'welcome', 'initial welcome');
    assert.equal(Object.hasOwn(initial, 'token'), false, 'The unauthenticated welcome must not disclose a token');
    const mark = this.mark();
    this.send({ t: 'hello', name: this.name, ...(resume === undefined ? {} : { resume }) });
    const welcome = await this.after(mark, m => m.t === 'welcome', 'hello welcome');
    if (!welcome.resumePending) {
      assert.ok(typeof welcome.token === 'string' && welcome.token.length >= 24, 'Hello must issue an opaque resume token');
    }
    return welcome;
  }
  input(p, c = this.correction?.c, extra = {}) {
    this.send({ t: 'input', seq: ++this.seq, p: [...p], yaw: 0, pitch: 0, f: 0, ...(c === undefined ? {} : { c }), ...extra });
  }
  async terminate() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise(resolve => this.socket.once('close', resolve));
    this.socket.terminate();
    await closed;
  }
}
