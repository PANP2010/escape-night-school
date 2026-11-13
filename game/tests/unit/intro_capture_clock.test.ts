import { afterEach, describe, expect, it, vi } from 'vitest';
import { Game } from '../../client/src/game.ts';
import { CAUGHT_HOLD_S, RoomManager, type Conn } from '../../server/room.ts';
import { TICK_MS } from '../../shared/constants.ts';
import { ST_DOWN, type CatchSource, type ServerMsg, type Vec3 } from '../../shared/protocol.ts';
import { mulberry32 } from '../../shared/rng.ts';

const peer = (id: number) => {
  const messages: ServerMsg[] = [];
  const conn: Conn = { id, name: `p${id}`, send: m => messages.push(structuredClone(m)), sendRaw: raw => messages.push(JSON.parse(raw)) };
  return { conn, messages };
};
const setup = () => {
  const room = new RoomManager(mulberry32(8)).create(true), a = peer(1), b = peer(2);
  room.add(a.conn, 1000); room.add(b.conn, 1000);
  room.handle(a.conn, { t: 'start' }, 1000);
  const intro = a.messages.findLast(m => m.t === 'event' && m.kind === 'intro');
  if (intro?.t !== 'event' || intro.kind !== 'intro') throw new Error('Expected lobby intro');
  return { room, a, b, intro };
};
const latestSnap = (messages: ServerMsg[]) => {
  const snap = messages.findLast(m => m.t === 'snap');
  if (snap?.t !== 'snap') throw new Error('Expected snapshot');
  return snap;
};

afterEach(() => vi.unstubAllGlobals());

describe('intro and capture clock integration', () => {
  it('accepts a post-intro capture as current and retains the complete down deadline through snapshots and resume', () => {
    const { room, a, b, intro } = setup();
    for (let now = intro.startedAt + TICK_MS; now < intro.endsAt; now += TICK_MS) room.step(now);
    expect(room.tick).toBe(0);
    expect(latestSnap(b.messages).tick).toBe(159);
    room.step(intro.endsAt);
    expect(room.tick).toBe(1);
    const current = latestSnap(b.messages).tick;
    expect(current).toBe(160);
    const victim = room.players.get(2)!, at: Vec3 = [...victim.p], source: Vec3 = [at[0] + 0.5, at[1], at[2]];
    (room as unknown as { punish(p: typeof victim, by: CatchSource, source: Vec3): void }).punish(victim, 'warden', source);
    const event = b.messages.find(m => m.t === 'caught');
    if (event?.t !== 'caught') throw new Error('Expected private capture');
    expect(event).toEqual({ t: 'caught', id: 2, seq: 1, tick: current, hold: CAUGHT_HOLD_S, by: 'warden', at, source });
    expect(victim.heldUntil).toBe(room.tick + CAUGHT_HOLD_S * 1000 / TICK_MS);

    const title = { textContent: '' };
    vi.stubGlobal('document', { querySelector: () => title });
    const begin = vi.fn(() => true);
    const client = Object.assign(Object.create(Game.prototype), {
      myId: 2, lastCaptureSeq: 0, lastSnapTick: current, spawnSynced: true,
      down: false, spectate: false, awaitingLevel: false, completed: false, fadeUntil: 0,
      input: { yaw: 0, pitch: 0, clear: vi.fn() }, moves: { clear: vi.fn() },
      capture: { begin }, reviveHold: { stop: vi.fn() },
      steps: { reset: vi.fn() }, haptics: { pulse: vi.fn() }, sound: { tone: vi.fn(), capture: vi.fn() },
    }) as Game;
    client.onMsg(event);
    expect(client.down).toBe(true);
    expect(begin).toHaveBeenCalledOnce();

    room.step(intro.endsAt + TICK_MS);
    const down = latestSnap(b.messages), state = down.players.find(p => p.id === 2)!;
    expect(state.st).toBe(ST_DOWN);
    expect(state.downUntil).toBe(current + CAUGHT_HOLD_S * 1000 / TICK_MS);
    expect((state.downUntil! - down.tick) * TICK_MS).toBe(29_950);
    room.disconnect(b.conn);
    const resumed = peer(9);
    expect(room.resume(b.conn, resumed.conn, intro.endsAt + TICK_MS + 1)).toBe(true);
    const full = latestSnap(resumed.messages), restored = full.players.find(p => p.id === 2)!;
    expect(full.tick).toBe(down.tick);
    expect(restored.downUntil).toBe(state.downUntil);
    expect(resumed.messages.find(m => m.t === 'resume')).toEqual({ t: 'resume', downLeft: 29.95 });
    expect(resumed.messages.filter(m => m.t === 'caught')).toEqual([]);
    expect(a.messages.filter(m => m.t === 'team-caught')).toEqual([{ t: 'team-caught', id: 2, by: 'warden', episode: 1 }]);
  });

  it('removes a reserved offline voter so a skipped survivor can finish the intro', () => {
    const { room, a, b, intro } = setup();
    room.handle(a.conn, { t: 'intro-skip', id: intro.id }, 2000);
    expect(room.introFrozen).toBe(true);
    room.disconnect(b.conn);
    expect(room.introFrozen).toBe(false);
    expect(a.messages.findLast(m => m.t === 'event' && m.kind === 'intro')).toEqual({ ...intro, now: 2000, skipped: [1], ended: true });
    expect(room.players.get(2)!.offline).toBe(true);
  });

  it('expires an intro before reconnect sync and keeps the continuous snapshot tick', () => {
    const { room, a, b, intro } = setup();
    room.step(2000); room.step(2050);
    const tick = latestSnap(a.messages).tick;
    room.disconnect(b.conn);
    const resumed = peer(9);
    expect(room.resume(b.conn, resumed.conn, intro.endsAt + 100)).toBe(true);
    expect(room.introFrozen).toBe(false);
    expect(latestSnap(resumed.messages).tick).toBe(tick);
    expect(resumed.messages.findLast(m => m.t === 'event' && m.kind === 'intro')).toMatchObject({ ended: true, now: intro.endsAt + 100 });
    room.step(intro.endsAt + 150);
    expect(latestSnap(resumed.messages).tick).toBe(tick + 1);
  });
});
