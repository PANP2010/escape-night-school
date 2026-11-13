// Typed WebSocket transport. Commands belong to their live connection and are never replayed after a loss.
import { encode, type ClientMsg, type ServerMsg } from '../../shared/protocol.ts';
import { clearResume, readResume, saveResume, type ResumeSession } from './reconnect.ts';

export type ConnectionState = 'connecting' | 'online' | 'reconnecting' | 'syncing';
/** Must outlast the server's own stale-socket reaping (HEARTBEAT_TIMEOUT_MS), or a mobile client sees
 *  "原会话仍在线" and gives up on a session the server is about to release. */
export const RECONNECT_MS = 20_000;
/** Snapshots arrive 20×/s and the server heartbeats every 2.5 s, so 6 s of utter silence means the link is gone.
 *  Noticing late (15 s) meant the player stood frozen through the lobby's own 8 s "大厅响应超时" and only then saw
 *  "正在重连" — the exact report we got from players ("连接超时"). Recovery must start well before that. */
export const SILENCE_MS = 6_000;
// Campus / carrier NAT links sit at 150-250 ms RTT with retransmits: the TCP + WebSocket handshake plus the
// first `welcome` regularly takes well over a second. Aborting at 1.5 s turned one slow connect into a
// reconnect storm (and, behind a shared NAT IP, into admission rejections for everyone).
const RETRY_MS = 250, CONNECT_MS = 8000, WATCHDOG_MS = 250;
/** A server that keeps refusing us (an exhausted per-IP admission, a restart) must not be hammered at 4 connections a
 *  second per client: every closed attempt without a welcome doubles the wait, capped at a few seconds. */
const MAX_BACKOFF_MS = 4000;

export class Net {
  private ws!: WebSocket;
  private session: ResumeSession | null = readResume();
  private name = this.session?.name ?? '无名';
  private recovering = !!this.session;
  private accepted = false;
  private disposed = false;
  private generation = 0;
  private clockAt = Date.now();
  private frozenMs = 0;
  private lastReceipt = this.clockAt;
  private deadline = this.recovering ? this.clockAt + RECONNECT_MS : 0;
  private pendingSince = 0;
  /** Only the very first connection can retain an early lobby click. A connection loss discards it. */
  private initialQueue: ClientMsg[] = [];
  private initial = !this.session;
  private retry?: ReturnType<typeof setTimeout>;
  private attempt?: ReturnType<typeof setTimeout>;
  /** Consecutive connection attempts that ended before a welcome; reset by the first welcome. */
  private failures = 0;
  private watchdog: ReturnType<typeof setInterval>;
  state: ConnectionState = this.recovering ? 'reconnecting' : 'connecting';
  onMsg: (m: ServerMsg) => void = () => {};
  onClose: () => void = () => {};
  onState: (state: ConnectionState) => void = () => {};
  onResumeFailed: (message: string) => void = () => {};
  private readonly url: string;
  private readonly offline = () => this.reconnect();
  private readonly online = () => {
    if (this.recovering) { this.clearRetry(); this.connect(); }
    else if (!this.connected) this.reconnect();
  };

  /** The watchdog samples this clock every 250 ms, even while the network is silent. A gap over a second
   * therefore means the event loop stalled (shader compilation, suspension), not a slow remote peer.
   * Do not expire a live socket or recovery before its queued messages get a chance to run. */
  private now() {
    const at = Date.now(), gap = at - this.clockAt;
    // Exclude the whole unobserved gap: even a deadline one tick away must let queued socket events run.
    if (gap > 1000) this.frozenMs += gap;
    this.clockAt = at;
    return at - this.frozenMs;
  }

  constructor(url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`) {
    this.url = url;
    addEventListener('offline', this.offline);
    addEventListener('online', this.online);
    this.watchdog = setInterval(() => {
      if (this.disposed) return;
      const now = this.now();
      if (this.recovering && now >= this.deadline) {
        if (this.accepted) this.reconnect();
        else if (this.pendingSince) this.failResume('原会话仍在线，请回到原页面，或重新创建、加入房间。', true);
        else this.failResume();
      } else if ((this.connected || this.state === 'syncing') && now - this.lastReceipt > SILENCE_MS) this.reconnect();
    }, WATCHDOG_MS);
    this.connect();
  }

  get connected() { return this.state === 'online' && this.ws?.readyState === WebSocket.OPEN; }

  private setState(state: ConnectionState) { this.state = state; this.onState(state); }
  private clearRetry() { if (this.retry !== undefined) clearTimeout(this.retry); this.retry = undefined; }
  private clearAttempt() { if (this.attempt !== undefined) clearTimeout(this.attempt); this.attempt = undefined; }

  private connect() {
    if (this.disposed) return;
    this.clearRetry(); this.clearAttempt();
    const generation = ++this.generation;
    this.ws?.close();
    const now = this.now();
    if (this.recovering && !this.accepted && now >= this.deadline) { this.failResume(); return; }
    const ws = this.ws = new WebSocket(this.url);
    const current = () => !this.disposed && generation === this.generation;
    // A socket that never said welcome means the server refused or dropped us; schedule() backs off on those.
    let greeted = false;
    const connectUntil = now + CONNECT_MS;
    const checkAttempt = () => {
      if (!current() || this.state === 'online' || this.accepted) return;
      const left = connectUntil - this.now();
      if (left > 0) { this.attempt = setTimeout(checkAttempt, left); return; }
      if (!greeted) this.failures++;
      this.schedule();
    };
    this.attempt = setTimeout(checkAttempt, CONNECT_MS);
    ws.onopen = () => {
      if (!current()) return;
      this.lastReceipt = this.now();
      if (this.recovering && this.session) this.sendResume();
    };
    ws.onmessage = (event) => {
      if (!current()) return;
      this.lastReceipt = this.now();
      let m: ServerMsg;
      try { m = JSON.parse(event.data as string) as ServerMsg; } catch { return; }
      if (m.t === 'heartbeat') { ws.send(encode({ t: 'heartbeat' })); return; }
      if (m.t === 'welcome') {
        // The provisional identity precedes hello. Never apply it over a returning player.
        if (this.recovering && this.session && !m.token && !m.resumed && !m.resumeFailed && !m.resumePending) return;
        greeted = true; this.failures = 0;
        if (m.resumePending) {
          this.clearAttempt();
          this.pendingSince ||= this.now();
          this.retry = setTimeout(() => this.sendResume(), RETRY_MS);
          return;
        }
        if (m.resumeFailed) { this.onMsg(m); this.failResume(); return; }
        if (m.token) { this.session = { token: m.token, name: this.name }; saveResume(this.session); }
        this.clearAttempt();
        if (m.resumed) { this.accepted = true; this.deadline = this.now() + RECONNECT_MS; this.setState('syncing'); }
        else {
          this.recovering = false; this.setState('online');
          const queue = this.initialQueue; this.initialQueue = [];
          for (const queued of queue) this.send(queued);
        }
      }
      if (m.t === 'room') this.initial = false;
      this.onMsg(m);
      // Apply the authority's new correction epoch before allowing any fresh input.
      if (m.t === 'correct' && m.forced && this.accepted) {
        this.accepted = false; this.recovering = false; this.pendingSince = 0;
        this.clearRetry(); this.clearAttempt(); this.setState('online');
      }
    };
    ws.onclose = () => { if (current()) { this.now(); if (!greeted) this.failures++; this.reconnect(); } };
    ws.onerror = () => { /* close or the bounded attempt timer owns retries */ };
  }

  private sendResume() {
    if (!this.recovering || !this.session || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(encode({ t: 'hello', name: this.name, resume: this.session.token }));
  }

  private schedule() {
    if (this.disposed) return;
    ++this.generation; this.ws?.close(); this.clearAttempt(); this.clearRetry();
    this.retry = setTimeout(() => this.connect(), Math.min(MAX_BACKOFF_MS, RETRY_MS * 2 ** this.failures));
  }

  private reconnect() {
    if (this.disposed) return;
    this.initial = false; this.initialQueue = [];
    if (!this.recovering || this.accepted) {
      this.recovering = true; this.accepted = false; this.pendingSince = 0;
      this.deadline = this.now() + RECONNECT_MS;
      this.setState('reconnecting'); this.onClose();
    }
    this.schedule();
  }

  private failResume(message = '连接已过期，请重新创建或加入房间。', keepSession = false) {
    this.clearRetry(); this.clearAttempt();
    this.recovering = false; this.accepted = false; this.pendingSince = 0;
    if (!keepSession) { this.session = null; clearResume(); }
    if (this.ws?.readyState === WebSocket.OPEN) this.setState('online');
    else { this.setState('connecting'); this.connect(); }
    this.onResumeFailed(message);
  }

  send(m: ClientMsg): boolean {
    if (!this.connected) {
      if (this.initial && (m.t === 'hello' || m.t === 'create' || m.t === 'join')) {
        if (this.initialQueue.length < 3) this.initialQueue.push(m);
        return true;
      }
      return false;
    }
    if (m.t === 'hello') this.name = m.name;
    this.ws.send(encode(m));
    return true;
  }

  close() {
    this.disposed = true; ++this.generation;
    clearInterval(this.watchdog); this.clearRetry(); this.clearAttempt();
    removeEventListener('offline', this.offline); removeEventListener('online', this.online);
    this.ws?.close();
  }

  /** Ephemeral held actions expire on disconnect and must never enter the startup queue. */
  sendNow(m: ClientMsg): boolean {
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(encode(m));
      return true;
    } catch {
      return false;
    }
  }
}
