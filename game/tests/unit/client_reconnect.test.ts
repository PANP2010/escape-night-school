import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Net, RECONNECT_MS, SILENCE_MS } from '../../client/src/net.ts';
import { HostStatus, RESUME_KEY, clearResume, readResume, reloadWhenOnline, saveReconnectNotice, saveResume, takeReconnectNotice } from '../../client/src/reconnect.ts';
import type { ClientMsg, ServerMsg } from '../../shared/protocol.ts';

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static sockets: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (event: { data: string }) => void;
  sent: ClientMsg[] = [];
  readonly url: string;
  constructor(url: string) { this.url = url; FakeSocket.sockets.push(this); }
  open() { this.readyState = FakeSocket.OPEN; this.onopen?.(); }
  receive(message: ServerMsg) { this.onmessage?.({ data: JSON.stringify(message) }); }
  send(data: string) { if (this.readyState !== FakeSocket.OPEN) throw new Error('closed socket'); this.sent.push(JSON.parse(data) as ClientMsg); }
  close() { if (this.readyState === FakeSocket.CLOSED) return; this.readyState = FakeSocket.CLOSED; this.onclose?.(); }
}

let storage: Map<string, string>, events: EventTarget;
const clients: Net[] = [];
function client() { const net = new Net('ws://game.test/ws'); clients.push(net); return net; }
function current() { return FakeSocket.sockets.at(-1)!; }
function freshSession(net: Net) {
  const socket = current(); socket.open(); socket.receive({ t: 'welcome', id: 7 });
  net.send({ t: 'hello', name: '甲' }); socket.receive({ t: 'welcome', id: 7, token: 'test-session-a' });
  return socket;
}
const input: ClientMsg = { t: 'input', seq: 1, p: [2, 0, 3], yaw: 0, pitch: 0, f: 0 };

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  FakeSocket.sockets = []; storage = new Map(); events = new EventTarget();
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  vi.stubGlobal('addEventListener', events.addEventListener.bind(events));
  vi.stubGlobal('removeEventListener', events.removeEventListener.bind(events));
});
afterEach(() => { for (const net of clients.splice(0)) net.close(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('connection recovery', () => {
  it('allows a first lobby click before welcome, while refusing gameplay commands', () => {
    const net = client(), socket = current();
    expect(net.send({ t: 'hello', name: '甲' })).toBe(true);
    expect(net.send({ t: 'create' })).toBe(true);
    expect(net.send(input)).toBe(false);
    socket.open(); socket.receive({ t: 'welcome', id: 7 });
    expect(socket.sent.map(m => m.t)).toEqual(['hello', 'create']);
    socket.receive({ t: 'welcome', id: 7, token: 'test-session-a' });
    expect(readResume()?.name).toBe('甲');
  });

  it('waits for the forced correction to be applied and never replays offline actions', () => {
    const net = client(), old = freshSession(net);
    const seen: string[] = [];
    net.onMsg = message => { seen.push(message.t); if (message.t === 'correct') expect(net.connected).toBe(false); };
    old.close();
    for (const message of [input, { t: 'act', kind: 'pick', id: 2 }, { t: 'chat', text: 'old' }, { t: 'use', item: 'battery' }, { t: 'start' }, { t: 'create' }, { t: 'join', code: 'ABCD' }] as ClientMsg[]) expect(net.send(message)).toBe(false);
    vi.advanceTimersByTime(250);
    const next = current(); next.open(); next.receive({ t: 'welcome', id: 99 });
    expect(seen).toEqual([]);
    next.receive({ t: 'welcome', id: 7, token: 'test-session-b', resumed: true });
    next.receive({ t: 'snap', tick: 20, players: [], mobs: [] });
    expect(net.state).toBe('syncing'); expect(net.send(input)).toBe(false);
    next.receive({ t: 'correct', p: [4, 0, 5], c: 4, forced: true });
    expect(net.connected).toBe(true);
    expect(next.sent.map(m => m.t)).toEqual(['hello']);
    expect(net.send({ ...input, c: 4 })).toBe(true);
    expect(next.sent.map(m => m.t)).toEqual(['hello', 'input']);
    expect(readResume()?.token === 'test-session-b').toBe(true);
  });

  it('closes an apparently open socket on offline and retries immediately on online', () => {
    const net = client(), old = freshSession(net);
    events.dispatchEvent(new Event('offline'));
    expect(old.readyState).toBe(FakeSocket.CLOSED); expect(net.state).toBe('reconnecting');
    events.dispatchEvent(new Event('online'));
    expect(current()).not.toBe(old); current().open();
    expect(current().sent[0]?.t).toBe('hello');
  });

  it('detects application silence without waiting for a websocket close event', () => {
    const net = client(), old = freshSession(net);
    vi.advanceTimersByTime(SILENCE_MS + 250);
    expect(net.state).toBe('reconnecting'); expect(old.readyState).toBe(FakeSocket.CLOSED);
    vi.advanceTimersByTime(250); expect(current()).not.toBe(old);
  });

  it('replies to heartbeat and keeps a healthy idle lobby connected', () => {
    const net = client(), socket = freshSession(net);
    for (let i = 0; i < 6; i++) { vi.advanceTimersByTime(5000); socket.receive({ t: 'heartbeat' }); }
    expect(net.connected).toBe(true);
    expect(socket.sent.filter(m => m.t === 'heartbeat')).toHaveLength(6);
    expect(FakeSocket.sockets).toHaveLength(1);
  });

  it('lets queued heartbeats run after a frozen event loop, then still detects real silence', () => {
    const net = client(), socket = freshSession(net);
    // Moving wall time without running timers models a shader compile; the watchdog task wins the
    // race against a heartbeat already waiting in the browser's networking task queue.
    vi.setSystemTime(Date.now() + 30_000);
    vi.advanceTimersByTime(250);
    expect(net.connected).toBe(true); expect(current()).toBe(socket);
    socket.receive({ t: 'heartbeat' });
    expect(socket.sent.at(-1)).toEqual({ t: 'heartbeat' });
    vi.advanceTimersByTime(SILENCE_MS + 250);
    expect(net.state).toBe('reconnecting'); expect(socket.readyState).toBe(FakeSocket.CLOSED);
  });

  it('keeps a pending connection alive when its attempt timer runs before a queued welcome after a freeze', () => {
    // Deliver the attempt callback before the equally overdue watchdog, matching independent browser task sources.
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const net = client(), socket = current();
    const attempt = timers.mock.calls.find(([, ms]) => ms === 8000)![0] as () => void;
    vi.advanceTimersByTime(7750);
    vi.setSystemTime(Date.now() + 30_000);
    attempt();
    expect(current()).toBe(socket); expect(socket.readyState).toBe(FakeSocket.CONNECTING);
    socket.open(); socket.receive({ t: 'welcome', id: 7 });
    expect(net.connected).toBe(true);
    timers.mockRestore();
  });

  it('still retires a connection that receives no welcome after eight active seconds', () => {
    client(); const socket = current();
    vi.advanceTimersByTime(8000);
    expect(socket.readyState).toBe(FakeSocket.CLOSED);
    vi.advanceTimersByTime(500);
    expect(current()).not.toBe(socket);
  });

  it('preserves recovery across a frozen event loop so a queued correction can restore authority', () => {
    saveResume({ token: 'test-session-a', name: '甲' });
    const net = client(), socket = current(), failed = vi.fn(); net.onResumeFailed = failed;
    socket.open(); socket.receive({ t: 'welcome', id: 7, token: 'test-session-b', resumed: true });
    for (let i = 0; i < 3; i++) { vi.advanceTimersByTime(5000); socket.receive({ t: 'heartbeat' }); }
    vi.advanceTimersByTime(RECONNECT_MS - 15_000 - 250);
    vi.setSystemTime(Date.now() + 30_000);
    vi.advanceTimersByTime(250);
    expect(failed).not.toHaveBeenCalled(); expect(net.state).toBe('syncing');
    socket.receive({ t: 'correct', p: [4, 0, 5], c: 4, forced: true });
    expect(net.connected).toBe(true); expect(current()).toBe(socket);
  });

  it('waits through pending ownership for the full recovery window', () => {
    saveResume({ token: 'test-session-a', name: '甲' });
    const net = client(), socket = current(), failed = vi.fn(); net.onResumeFailed = failed;
    socket.open(); socket.receive({ t: 'welcome', id: 99 });
    for (let i = 0; i < 24; i++) { socket.receive({ t: 'welcome', id: 99, resumePending: true }); vi.advanceTimersByTime(250); }
    expect(failed).not.toHaveBeenCalled(); expect(net.state).toBe('reconnecting');
    socket.receive({ t: 'welcome', id: 7, token: 'test-session-b', resumed: true });
    socket.receive({ t: 'correct', p: [0, 0, 0], c: 1, forced: true });
    expect(net.connected).toBe(true);
  });

  it('preserves an active token when pending ownership reaches its deadline', () => {
    saveResume({ token: 'test-session-a', name: '甲' });
    const net = client(), socket = current(), failed = vi.fn(); net.onResumeFailed = failed;
    socket.open(); socket.receive({ t: 'welcome', id: 99, resumePending: true });
    vi.advanceTimersByTime(RECONNECT_MS);
    expect(failed).toHaveBeenCalledOnce(); expect(readResume()).not.toBeNull(); expect(net.connected).toBe(true);
  });

  it('bounds synchronization even when a successful welcome is followed by no correction', () => {
    saveResume({ token: 'test-session-a', name: '甲' });
    const net = client(), socket = current(); socket.open();
    socket.receive({ t: 'welcome', id: 7, token: 'test-session-b', resumed: true });
    vi.advanceTimersByTime(RECONNECT_MS + 250);
    expect(net.state).toBe('reconnecting'); expect(current()).not.toBe(socket);
    current().open();
    const hello = current().sent[0]; expect(hello?.t === 'hello' && hello.resume === 'test-session-b').toBe(true);
  });

  it('clears an expired identity and accepts a fresh lobby hello', () => {
    saveResume({ token: 'test-session-a', name: '甲' });
    const net = client(), socket = current(), failed = vi.fn(); net.onResumeFailed = failed;
    socket.open(); socket.receive({ t: 'welcome', id: 99, token: 'unused', resumeFailed: true });
    expect(failed).toHaveBeenCalledOnce(); expect(storage.has(RESUME_KEY)).toBe(false);
    expect(net.send({ t: 'hello', name: '乙' })).toBe(true);
  });

  it.each(['online', 'reconnecting', 'connecting'] as const)('abandons a waiting-room identity while %s without restoring it on the next lobby connection', state => {
    const net = client(), original = freshSession(net);
    if (state !== 'online') original.close();
    if (state === 'connecting') vi.advanceTimersByTime(250);
    const retired = current(), received = vi.fn(), failed = vi.fn(), count = FakeSocket.sockets.length;
    net.onMsg = received; net.onResumeFailed = failed;

    clearResume(); net.close();
    expect(retired.readyState).toBe(FakeSocket.CLOSED);
    retired.receive({ t: 'welcome', id: 7, token: 'late-session', resumed: true });
    retired.onclose?.();
    events.dispatchEvent(new Event('offline')); events.dispatchEvent(new Event('online'));
    vi.advanceTimersByTime(RECONNECT_MS + SILENCE_MS);
    expect(FakeSocket.sockets).toHaveLength(count);
    expect(readResume()).toBeNull();
    expect(received).not.toHaveBeenCalled(); expect(failed).not.toHaveBeenCalled();

    const fresh = client(), socket = current(); socket.open();
    expect(socket.sent).toEqual([]);
    socket.receive({ t: 'welcome', id: 99 });
    expect(fresh.connected).toBe(true);
    expect(fresh.send({ t: 'hello', name: '乙' })).toBe(true);
    expect(fresh.send({ t: 'create' })).toBe(true);
    expect(socket.sent).toEqual([{ t: 'hello', name: '乙' }, { t: 'create' }]);
    socket.receive({ t: 'welcome', id: 99, token: 'fresh-session' });
    retired.receive({ t: 'welcome', id: 7, token: 'late-session', resumed: true });
    expect(readResume()).toEqual({ token: 'fresh-session', name: '乙' });
    expect(received).not.toHaveBeenCalled();
  });

  it('continues in memory when session storage is unavailable', () => {
    vi.stubGlobal('sessionStorage', { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } });
    const net = client(); freshSession(net).close(); vi.advanceTimersByTime(250); current().open();
    const hello = current().sent[0]; expect(hello?.t === 'hello' && !!hello.resume).toBe(true);
  });
});

describe('recovery presentation state', () => {
  it('defers lobby navigation while offline and reloads once on the next online event', () => {
    let online = false; const reload = vi.fn();
    reloadWhenOnline(reload, () => online, events as unknown as Window);
    expect(reload).not.toHaveBeenCalled(); events.dispatchEvent(new Event('online')); expect(reload).not.toHaveBeenCalled();
    online = true; events.dispatchEvent(new Event('online')); events.dispatchEvent(new Event('online'));
    expect(reload).toHaveBeenCalledOnce();
  });

  it('returns to an ordinary lobby once while preserving a still active token', () => {
    saveResume({ token: 'test-session-a', name: '甲' }); saveReconnectNotice('原会话仍在线');
    expect(takeReconnectNotice()).toBe('原会话仍在线'); expect(takeReconnectNotice()).toBe('');
    expect(readResume()).toBeNull(); expect(readResume()).not.toBeNull();
  });

  it('announces host transfer after membership is established and resets for a different room', () => {
    const hosts = new HostStatus(), players = [{ id: 1, name: '甲' }, { id: 2, name: '<img src=x>' }];
    expect(hosts.update('ABCD', 1, players, 2).change).toBe('');
    expect(hosts.update('ABCD', 2, players, 2)).toEqual({ current: '房主：<img src=x>（你）', change: '你已成为房主' });
    expect(hosts.update('ABCD', 2, players, 2).change).toBe('');
    expect(hosts.update('EFGH', 1, players, 2).change).toBe('');
  });
});
