import { describe, expect, it } from 'vitest';
import { caughtTitle, TeamFeedback } from '../../client/src/teamFeedback.ts';
import { CAUGHT_HOLD_S, REVIVE_S, Room, type Conn } from '../../server/room.ts';
import { TICK_MS } from '../../shared/constants.ts';
import { F_CROUCH, F_LIGHT, F_RUN, ST_DOWN, ST_OK, ST_SPECTATE, type CatchSource, type ServerMsg, type TeamCaughtMsg, type Vec3 } from '../../shared/protocol.ts';

const notice = (episode: number, by: CatchSource = 'warden', id = 2): TeamCaughtMsg => ({ t: 'team-caught', id, by, episode });
const names = new Map([[1, '甲'], [2, '乙'], [3, '丙']]);
const source: Vec3 = [22, 0, 81];
const caught = (seq: number, tick: number, by: CatchSource, at: Vec3): Extract<ServerMsg, { t: 'caught' }> =>
  ({ t: 'caught', id: 2, seq, tick, hold: CAUGHT_HOLD_S, by, at, source });

describe('capture feedback', () => {
  it('uses the actual catcher in the existing central title and the short teammate notice', () => {
    const feedback = new TeamFeedback();
    expect(caughtTitle('warden')).toBe('你被角色074抓住了');
    expect(caughtTitle('monitor')).toBe('你被无脸值日生抓住了');
    expect(caughtTitle('mirror')).toBe('你被镜中人抓住了');
    expect(feedback.notice(notice(1), 1, names)).toBe('乙被角色074抓住了');
    expect(feedback.notice(notice(2, 'monitor'), 1, names)).toBe('乙被无脸值日生抓住了');
    expect(feedback.notice({ ...notice(3, 'monitor'), name: '同学甲' }, 1, names)).toBe('乙被同学甲抓住了');
    expect(feedback.notice(notice(4, 'mirror'), 1, names)).toBe('乙被镜中人抓住了');
  });

  it('drops duplicate / stale episodes but immediately accepts the same player being caught again', () => {
    const feedback = new TeamFeedback();
    expect(feedback.notice(notice(4), 1, names)).toBe('乙被角色074抓住了');
    expect(feedback.notice(notice(4), 1, names)).toBeNull();
    expect(feedback.notice(notice(3, 'monitor', 3), 1, names)).toBeNull();
    expect(feedback.notice(notice(5), 1, names)).toBe('乙被角色074抓住了');
  });

  it('keeps deduplication across member updates and level changes, and resets for a new room / connection', () => {
    const feedback = new TeamFeedback();
    feedback.enterRoom('ABCD');
    expect(feedback.notice(notice(1), 1, names)).toBeTruthy();
    feedback.enterRoom('ABCD'); // the server sends room again for membership / level changes and restarts
    expect(feedback.notice(notice(1), 1, names)).toBeNull();
    expect(feedback.notice(notice(2), 1, names)).toBeTruthy();
    feedback.enterRoom('EFGH');
    expect(feedback.notice(notice(1), 1, names)).toBeTruthy();
    feedback.reset(); // a new welcome can lead to the same room code with a fresh server sequence
    feedback.enterRoom('EFGH');
    expect(feedback.notice(notice(1), 1, names)).toBeTruthy();
  });

  it('suppresses an accidental self notice without suppressing the next teammate capture', () => {
    const feedback = new TeamFeedback();
    expect(feedback.notice(notice(1, 'warden', 1), 1, names)).toBeNull();
    expect(feedback.notice(notice(2, 'monitor'), 1, names)).toBe('乙被无脸值日生抓住了');
  });

  it('rejects unusable sequence numbers without poisoning the next valid notice', () => {
    const feedback = new TeamFeedback();
    for (const n of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(feedback.notice(notice(n), 1, names)).toBeNull();
    }
    expect(feedback.notice(notice(1), 1, new Map())).toBe('队友被角色074抓住了');
  });
});

function roomWithPeers() {
  const room = new Room('TEAM', 7);
  const received = new Map<number, ServerMsg[]>();
  for (const [id, name] of names) {
    const messages: ServerMsg[] = [];
    received.set(id, messages);
    const conn: Conn = { id, name, send: (m) => messages.push(m), sendRaw: (s) => messages.push(JSON.parse(s)) };
    room.add(conn, 0);
  }
  type Player = NonNullable<ReturnType<typeof room.players.get>>;
  // Exercise the state transition shared by both AI catch paths, including repeated calls by different mobs.
  const authority = room as unknown as { punish(pl: Player, by: CatchSource, source: Vec3): void; loadLevel(index: number): void };
  const captures = (id: number) => received.get(id)!.filter((m) => m.t === 'caught' || m.t === 'team-caught');
  for (const messages of received.values()) messages.length = 0;
  return { room, authority, received, captures, victim: room.players.get(2)! };
}

describe('room capture recipients and identity', () => {
  it.each(['warden', 'monitor', 'debug'] as const)('%s clears crouch / run when going down, keeps the light, and accepts crouch again after rescue', (by) => {
    const { room, authority, received, captures, victim } = roomWithPeers();
    const flags = F_CROUCH | F_RUN | F_LIGHT;
    const input = (f: number, seq: number) => room.applyInput(victim, {
      t: 'input', seq, p: [...victim.p], yaw: 0.7, pitch: 0, f, c: victim.c,
    }, room.tick * TICK_MS + 50);
    const snap = () => received.get(1)!.findLast((m): m is Extract<ServerMsg, { t: 'snap' }> => m.t === 'snap')!;
    input(flags, 1);
    expect(victim.f).toBe(flags);
    room.step(); // First publish the crouch: the downed snap must explicitly replace the flags, not omit them.
    expect(snap().players.find((p) => p.id === 2)?.f).toBe(flags);
    const down = () => by === 'debug'
      ? room.handle(victim.conn, { t: 'debug', op: 'down' }, room.tick * TICK_MS)
      : authority.punish(victim, by, source);
    down();
    const deadline = victim.heldUntil;
    expect(deadline).toBe(room.tick + CAUGHT_HOLD_S * 1000 / TICK_MS);
    room.step();
    expect(snap().players.find((p) => p.id === 2)).toMatchObject({ st: ST_DOWN, f: F_LIGHT });
    expect(victim.f & (F_CROUCH | F_RUN)).toBe(0);
    // Even a client still holding the old keys cannot put the downed avatar back under the floor.
    input(flags, 2);
    expect(victim.f).toBe(F_LIGHT);
    if (by !== 'debug') down();
    expect(victim.heldUntil).toBe(deadline);
    for (const id of names.keys()) expect(captures(id)).toHaveLength(by === 'debug' ? 0 : 1);
    const rescuer = room.players.get(1)!;
    rescuer.p = [victim.p[0] + 0.5, victim.p[1], victim.p[2]];
    for (let i = 0; i <= Math.ceil(REVIVE_S * 1000 / TICK_MS); i++) {
      room.act(rescuer, 'revive', 2);
      room.step();
    }
    expect(victim.st).toBe(ST_OK);
    expect(victim.heldUntil).toBeUndefined();
    input(F_CROUCH | F_LIGHT, 3);
    expect(victim.f).toBe(F_CROUCH | F_LIGHT);
    room.step();
    expect(snap().players.find((p) => p.id === 2)?.f).toBe(F_CROUCH | F_LIGHT);
    for (const id of names.keys()) expect(captures(id)).toHaveLength(by === 'debug' ? 0 : 1);
  });

  it.each(['warden', 'monitor', 'mirror'] as const)('%s: keeps caught private and sends exactly one notice to each other player', (by) => {
    const { room, authority, captures, victim } = roomWithPeers();
    const at: Vec3 = [...victim.p];
    authority.punish(victim, by, source);
    expect(captures(2)).toEqual([caught(1, 0, by, at)]);
    expect(captures(1)).toEqual([notice(1, by)]);
    expect(captures(3)).toEqual([notice(1, by)]);
    expect(victim.st).toBe(ST_DOWN);
    const deadline = victim.heldUntil;
    room.tick += 2;
    authority.punish(victim, by, source);
    authority.punish(victim, by === 'warden' ? 'monitor' : 'warden', source);
    expect(victim.heldUntil).toBe(deadline); // duplicate detections cannot extend the rescue window
    expect(captures(1)).toHaveLength(1);
    expect(captures(2)).toHaveLength(1);
    expect(captures(3)).toHaveLength(1);
    victim.st = ST_SPECTATE;
    authority.punish(victim, by, source);
    expect(victim.st).toBe(ST_SPECTATE);
    expect(captures(1)).toHaveLength(1);
  });

  it('gives a fresh episode after a real rescue, including the same player and catcher', () => {
    const { room, authority, captures, victim } = roomWithPeers();
    authority.punish(victim, 'warden', source);
    const rescuer = room.players.get(1)!;
    rescuer.p = [victim.p[0] + 0.5, victim.p[1], victim.p[2]];
    for (let i = 0; i <= Math.ceil(REVIVE_S * 1000 / TICK_MS); i++) {
      room.act(rescuer, 'revive', 2);
      room.step();
    }
    expect(victim.st).toBe(ST_OK);
    expect(victim.heldUntil).toBeUndefined();
    authority.punish(victim, 'warden', source);
    expect(captures(1)).toEqual([notice(1), notice(2)]);
    expect(captures(2)).toHaveLength(2);
    expect(captures(3)).toEqual([notice(1), notice(2)]);
  });

  it('keeps episodes increasing after a level restart and the next level', () => {
    const { authority, captures, victim } = roomWithPeers();
    const firstAt: Vec3 = [...victim.p];
    authority.punish(victim, 'warden', source);
    authority.loadLevel(0);
    const retryAt: Vec3 = [...victim.p];
    authority.punish(victim, 'warden', source);
    authority.loadLevel(1);
    const nextAt: Vec3 = [...victim.p];
    authority.punish(victim, 'monitor', source);
    expect(captures(1)).toEqual([notice(1), notice(2), notice(3, 'monitor')]);
    expect(captures(2)).toEqual([
      caught(1, 0, 'warden', firstAt),
      caught(2, 0, 'warden', retryAt),
      caught(3, 0, 'monitor', nextAt),
    ]);
    expect(captures(3)).toEqual([notice(1), notice(2), notice(3, 'monitor')]);
  });
});
