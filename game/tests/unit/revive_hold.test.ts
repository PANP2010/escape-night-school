import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviveHold, REVIVE_REFRESH_MS } from '../../client/src/reviveHold.ts';
import { Input } from '../../client/src/input.ts';
import { Net } from '../../client/src/net.ts';
import { Room, REVIVE_S } from '../../server/room.ts';
import { TICK_MS } from '../../shared/constants.ts';
import { parseClientMsg, ST_DOWN, ST_OK } from '../../shared/protocol.ts';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function fixture() {
  let target: number | null = 2, connected = true;
  const events: [string, number, number][] = [];
  const hold = new ReviveHold({
    target: () => target,
    now: Date.now,
    send: id => { if (!connected) return false; events.push(['send', id, Date.now()]); return true; },
    cancel: id => { events.push(['cancel', id, Date.now()]); },
  });
  return { hold, events, target: (id: number | null) => { target = id; }, disconnect: () => { connected = false; } };
}

describe('render-independent revive hold', () => {
  it('renews a live hold for three seconds without any render callbacks', () => {
    const f = fixture();
    f.hold.sync();
    vi.advanceTimersByTime(3000);
    expect(f.events.filter(e => e[0] === 'send')).toHaveLength(1 + 3000 / REVIVE_REFRESH_MS);
    expect(f.events.at(-1)).toEqual(['send', 2, 3000]);
    expect(f.hold.since).toBe(0);
    f.hold.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a released short tap cancels before a frame, with no later renewal', () => {
    const f = fixture();
    f.hold.sync();
    vi.advanceTimersByTime(40);
    f.target(null); f.hold.sync();
    expect(f.events).toEqual([['send', 2, 0], ['cancel', 2, 40]]);
    vi.advanceTimersByTime(5000);
    expect(f.events).toHaveLength(2);
    expect(f.hold.id).toBeNull(); expect(f.hold.since).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rechecks invalid range or state on its own network clock', () => {
    const f = fixture(); f.hold.sync();
    f.target(null); // no sync/render: the next network pulse still notices
    vi.advanceTimersByTime(1000);
    expect(f.events).toEqual([['send', 2, 0], ['cancel', 2, REVIVE_REFRESH_MS]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('switching targets cancels the old hold before renewing the new one', () => {
    const f = fixture(); f.hold.sync(); vi.advanceTimersByTime(2700);
    f.target(3); f.hold.sync();
    expect(f.events.slice(-2)).toEqual([['cancel', 2, 2700], ['send', 3, 2700]]);
    expect(f.hold.since).toBe(2700);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('a failed transport stops renewal and disposal cannot restart it', () => {
    const f = fixture(); f.hold.sync(); f.disconnect();
    vi.advanceTimersByTime(1000);
    expect(f.events).toEqual([['send', 2, 0], ['cancel', 2, REVIVE_REFRESH_MS]]);
    expect(vi.getTimerCount()).toBe(0);
    f.hold.dispose(); f.hold.sync();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('repeated validity checks do not multiply timers or flood the transport', () => {
    const f = fixture();
    for (let i = 0; i < 100; i++) f.hold.sync();
    expect(f.events).toEqual([['send', 2, 0]]);
    expect(vi.getTimerCount()).toBe(1);
    f.hold.stop(); f.hold.stop();
    expect(f.events.filter(e => e[0] === 'cancel')).toHaveLength(1);
  });

  it('native keyup cancels a short tap before any render can consume its latched E action', () => {
    const listeners: Record<string, (e: unknown) => void> = {};
    vi.stubGlobal('addEventListener', (name: string, fn: (e: unknown) => void) => { listeners[name] = fn; });
    vi.stubGlobal('document', new EventTarget());
    const input = new Input({ addEventListener() {} } as any), f = fixture();
    input.onChange = () => { f.target(input.held('KeyE') ? 2 : null); f.hold.sync(); };
    listeners.keydown({ code: 'KeyE' });
    vi.advanceTimersByTime(40);
    listeners.keyup({ code: 'KeyE' });
    expect(input.down('KeyE')).toBe(true); // movement / one-shot actions still see the short tap
    expect(input.held('KeyE')).toBe(false);
    for (let i = 0; i < 20; i++) f.hold.sync(); // even a later render cannot turn the latch back into a hold
    vi.advanceTimersByTime(4000);
    expect(f.events).toEqual([['send', 2, 0], ['cancel', 2, 40]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['blur', 'disable'])('%s releases the physical hold and stops the network timer without a render', (release) => {
    const listeners: Record<string, (e: unknown) => void> = {};
    vi.stubGlobal('addEventListener', (name: string, fn: (e: unknown) => void) => { listeners[name] = fn; });
    vi.stubGlobal('document', new EventTarget());
    const input = new Input({ addEventListener() {} } as any), f = fixture();
    input.onChange = () => { f.target(input.held('KeyE') ? 2 : null); f.hold.sync(); };
    listeners.keydown({ code: 'KeyE' });
    vi.advanceTimersByTime(2700);
    if (release === 'blur') listeners.blur({});
    else input.enabled = false;
    const sent = f.events.filter(e => e[0] === 'send').length;
    vi.advanceTimersByTime(5000);
    expect(f.events.filter(e => e[0] === 'send')).toHaveLength(sent);
    expect(f.events.at(-1)).toEqual(['cancel', 2, 2700]);
    expect(f.hold.id).toBeNull(); expect(vi.getTimerCount()).toBe(0);
    input.enabled = true;
    f.hold.sync();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('ephemeral revive transport', () => {
  function transport() {
    let socket: FakeSocket;
    class FakeSocket {
      static readonly OPEN = 1;
      readyState = 0;
      sent: string[] = [];
      fail = false;
      onopen?: () => void;
      onclose?: () => void;
      onmessage?: (event: { data: string }) => void;
      constructor(_url: string) { socket = this; }
      send(s: string) { if (this.fail) throw new Error('socket closed during send'); this.sent.push(s); }
      open() { this.readyState = 1; this.onopen?.(); this.onmessage?.({ data: JSON.stringify({ t: 'welcome', id: 1 }) }); }
      close() { this.readyState = 3; this.onclose?.(); }
    }
    const events = new EventTarget();
    vi.stubGlobal('addEventListener', events.addEventListener.bind(events));
    vi.stubGlobal('removeEventListener', events.removeEventListener.bind(events));
    vi.stubGlobal('WebSocket', FakeSocket);
    const net = new Net('ws://test.invalid/ws');
    return { net, socket: socket! };
  }

  it('does not replay failed renewals or cancellations when a connecting socket opens', () => {
    const { net, socket } = transport();
    net.send({ t: 'create' }); // ordinary startup messages still queue
    const hold = new ReviveHold({ target: () => 2, now: Date.now,
      send: id => net.sendNow({ t: 'act', kind: 'revive', id }),
      cancel: id => { net.sendNow({ t: 'act', kind: 'revive_cancel', id }); } });
    hold.sync();
    expect(hold.id).toBeNull(); expect(vi.getTimerCount()).toBe(2); // transport watchdog + connection deadline, no hold timer
    vi.advanceTimersByTime(1000);
    socket.open();
    expect(socket.sent.map(s => JSON.parse(s))).toEqual([{ t: 'create' }]);
    expect(vi.getTimerCount()).toBe(1); // only the transport watchdog remains
    hold.sync();
    expect(hold.since).toBe(1000);
    expect(socket.sent.map(s => JSON.parse(s))).toEqual([{ t: 'create' }, { t: 'act', kind: 'revive', id: 2 }]);
    hold.dispose();
    net.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a send exception stops a hold without throwing or queuing it for a later open', () => {
    const { net, socket } = transport();
    socket.open(); socket.fail = true;
    const hold = new ReviveHold({ target: () => 2, now: Date.now,
      send: id => net.sendNow({ t: 'act', kind: 'revive', id }),
      cancel: id => { net.sendNow({ t: 'act', kind: 'revive_cancel', id }); } });
    expect(() => hold.sync()).not.toThrow();
    expect(hold.id).toBeNull(); expect(hold.since).toBeNull();
    expect(vi.getTimerCount()).toBe(1);
    socket.fail = false; socket.open();
    vi.advanceTimersByTime(5000);
    expect(socket.sent).toEqual([]);
    hold.dispose();
    net.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});

function serverFixture() {
  const room = new Room('HOLD', 7);
  for (let id = 1; id <= 3; id++) room.add({ id, name: `p${id}`, send: () => {}, sendRaw: () => {} }, 0);
  const a = room.players.get(1)!, b = room.players.get(2)!, c = room.players.get(3)!;
  b.p = [a.p[0] + 1, a.p[1], a.p[2]]; c.p = [a.p[0] - 1, a.p[1], a.p[2]];
  b.st = c.st = ST_DOWN; b.heldUntil = c.heldUntil = 9999;
  let target: number | null = 2;
  const hold = new ReviveHold({ target: () => target, now: Date.now,
    send: id => room.act(a, 'revive', id), cancel: id => { room.act(a, 'revive_cancel', id); } });
  setInterval(() => room.step(), TICK_MS);
  return { room, a, b, c, hold, target: (id: number | null) => { target = id; hold.sync(); } };
}

describe('revive hold with the authoritative room', () => {
  it('requires the full three seconds, clears the down deadline and remains OK for two more seconds', () => {
    const f = serverFixture(); f.hold.sync();
    vi.advanceTimersByTime(REVIVE_S * 1000 - TICK_MS);
    expect(f.b.st).toBe(ST_DOWN);
    vi.advanceTimersByTime(TICK_MS);
    expect(f.b.st).toBe(ST_OK); expect(f.b.heldUntil).toBeUndefined();
    f.target(null);
    vi.advanceTimersByTime(2000);
    expect(f.b.st).toBe(ST_OK);
  });

  it('release at 2.7 seconds cannot complete inside the stale window and a re-press starts over', () => {
    const f = serverFixture(); f.hold.sync(); vi.advanceTimersByTime(2700);
    f.target(null); expect(f.a.reviving).toBeUndefined();
    vi.advanceTimersByTime(800); expect(f.b.st).toBe(ST_DOWN);
    f.target(2); vi.advanceTimersByTime(2700); expect(f.b.st).toBe(ST_DOWN);
    vi.advanceTimersByTime(300); expect(f.b.st).toBe(ST_OK);
  });

  it('a switch resets progress and an old target cancellation cannot clear the new hold', () => {
    const f = serverFixture(); f.hold.sync(); vi.advanceTimersByTime(2700);
    f.target(3); f.room.handle(f.a.conn, { t: 'act', kind: 'revive_cancel', id: 2 }, Date.now());
    expect(f.a.reviving?.id).toBe(3);
    vi.advanceTimersByTime(2700); expect(f.b.st).toBe(ST_DOWN); expect(f.c.st).toBe(ST_DOWN);
    vi.advanceTimersByTime(300); expect(f.c.st).toBe(ST_OK); expect(f.b.st).toBe(ST_DOWN);
  });

  it('retains the 0.6 second stale cutoff, range and rescuer state checks', () => {
    const f = serverFixture(); f.hold.sync();
    f.hold.dispose();
    f.room.act(f.a, 'revive', 2);
    vi.advanceTimersByTime(650); expect(f.a.reviving).toBeUndefined();
    f.a.p = [f.b.p[0] + 10, f.b.p[1], f.b.p[2]];
    expect(f.room.act(f.a, 'revive', 2)).toBe(false);
    f.a.p = [...f.b.p]; f.a.st = ST_DOWN;
    expect(f.room.act(f.a, 'revive', 2)).toBe(false);
    expect(f.b.st).toBe(ST_DOWN);
  });

  it('parses only a valid cancellation target and a cancellation affects only its sender', () => {
    expect(parseClientMsg('{"t":"act","kind":"revive_cancel","id":2}')).toEqual({ t: 'act', kind: 'revive_cancel', id: 2 });
    expect(parseClientMsg('{"t":"act","kind":"revive_cancel","id":-1}')).toBeNull();
    const f = serverFixture(); f.hold.sync();
    f.room.handle(f.c.conn, { t: 'act', kind: 'revive_cancel', id: 2 }, 0);
    expect(f.a.reviving?.id).toBe(2);
  });
});
