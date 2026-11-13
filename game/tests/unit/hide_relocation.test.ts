import { afterEach, describe, expect, it, vi } from 'vitest';
import { Game } from '../../client/src/game.ts';
import { MoveLog } from '../../client/src/reconcile.ts';
import { CorrectionSmoother } from '../../client/src/interp.ts';
import { RoomManager, type Conn } from '../../server/room.ts';
import { F_HIDE, type ServerMsg, type Vec3 } from '../../shared/protocol.ts';
import { mulberry32 } from '../../shared/rng.ts';
import { inactiveGameCollaborators } from './game_fixture.ts';
import { roomIntroReady } from './room-intro-fixture.ts';

afterEach(() => vi.unstubAllGlobals());

function setup() {
  vi.stubGlobal('document', { getElementById: () => null, querySelector: () => null });
  const messages: ServerMsg[] = [];
  const conn: Conn = { id: 1, name: '柜子同步验收', send: m => messages.push(structuredClone(m)),
    sendRaw: raw => messages.push(JSON.parse(raw)) };
  const ready = roomIntroReady([conn]);
  const room = new RoomManager(mulberry32(71)).create(true, 3);
  room.add(conn, 0); room.handle(conn, { t: 'start' }, 0); ready(room);
  const player = room.players.get(1)!;
  // The actual L4 fullflow entrance, in the clear corridor outside locker zero.
  const entrance: Vec3 = [-33.24882184509582, 7.2, 129.74292171861143];
  player.p = [...entrance];
  const game = Object.assign(Object.create(Game.prototype), {
    ...inactiveGameCollaborators(), level: room.level, myId: 1, myF: 0, hiding: -1, hideYaw: 0,
    corrC: player.c, corrections: 0, input: { yaw: 0, pitch: 0 },
    body: { x: entrance[0], y: entrance[1], z: entrance[2], vy: 0, grounded: true },
    pos: { x: entrance[0], z: entrance[2] }, moves: new MoveLog(), smooth: new CorrectionSmoother(),
    target: () => null,
  }) as Game;
  const correct = () => {
    const msg = messages.findLast(m => m.t === 'correct');
    if (msg?.t !== 'correct') throw new Error('Expected a real Room relocation');
    return msg;
  };
  return { room, player, conn, messages, game, state: game as any, correct, entrance };
}

describe('hiding relocation is atomic before the next snapshot', () => {
  it('applies the actual hide and unhide flags with their position and epoch, without an intervening snapshot', () => {
    const f = setup();
    expect(f.room.hideIn(f.player, 0)).toBe(true);
    const hidden = f.correct();
    expect(hidden.f! & F_HIDE).toBe(F_HIDE);
    f.game.onMsg(hidden);
    expect(f.state.hiding).toBe(0);
    expect(f.game.pos).toEqual({ x: hidden.p[0], z: hidden.p[2] });

    expect(f.room.unhide(f.player)).toBe(true);
    const out = f.correct();
    expect(out.f! & F_HIDE).toBe(0);
    f.game.onMsg(out);
    // A render frame before the next snapshot must have no old locker pin to restore.
    expect(f.state.hiding).toBe(-1);
    expect(f.state.myF & F_HIDE).toBe(0);
    expect(f.game.pos).toEqual({ x: f.entrance[0], z: f.entrance[2] });
    expect(f.state.body).toMatchObject({ x: f.entrance[0], y: f.entrance[1], z: f.entrance[2] });
    expect(f.state.corrC).toBe(out.c);
    f.game.onMsg(hidden); // A delayed older epoch cannot re-enter the locker.
    expect(f.state.hiding).toBe(-1);
    expect(f.state.corrC).toBe(out.c);
  });

  it('ignores an in-flight hidden input from the old epoch and accepts the first real movement after unhide', () => {
    const f = setup();
    expect(f.room.hideIn(f.player, 0)).toBe(true);
    const hidden = f.correct(); f.game.onMsg(hidden);
    expect(f.room.unhide(f.player)).toBe(true);
    const out = f.correct(); f.game.onMsg(out);
    f.messages.length = 0;
    f.room.applyInput(f.player, { t: 'input', seq: 10, c: hidden.c, p: hidden.p, yaw: 0, pitch: 0, f: 0 }, 50);
    expect(f.player.p).toEqual(f.entrance);
    expect(f.messages.filter(m => m.t === 'correct')).toEqual([]);
    const walked: Vec3 = [f.game.pos.x + .1, f.state.body.y, f.game.pos.z];
    f.room.applyInput(f.player, { t: 'input', seq: 11, c: out.c, p: walked, yaw: 0, pitch: 0, f: 0 }, 100);
    expect(f.player.p).toEqual(walked);
    expect(f.messages.filter(m => m.t === 'correct')).toEqual([]);
    expect(f.state.corrections).toBe(0);
  });
});
