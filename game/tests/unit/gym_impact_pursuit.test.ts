import { describe, expect, it } from 'vitest';
import { Room, type Conn } from '../../server/room.ts';
import type { TensionDirector } from '../../server/ai/tensionDirector.ts';
import type { WardenAI } from '../../server/ai/warden.ts';
import type { SearchNavGraph } from '../../server/ai/searchPolicy.ts';
import { NavGraph } from '../../shared/campus/nav.ts';
import { BALL_TRIP_NOISE, GYM_TRIP_S } from '../../shared/gym.ts';
import { L5_INDEX } from '../../shared/levels/l5.ts';
import { ST_OK, type ServerMsg, type Vec3 } from '../../shared/protocol.ts';

type Internals = {
  warden: WardenAI;
  tension: TensionDirector;
  searchNav: SearchNavGraph;
  monitorOffUntil: number;
  wardenOffUntil: number;
  huntFrom: number;
};

function setup(playerPosition: Vec3 = [-100, .035, 62], wardenPosition: Vec3 = [-108, .035, 62]) {
  const campus = new NavGraph(); campus.addNode({ x: -100, y: 0, z: 60 });
  const room = new Room('BALL', 42, campus, L5_INDEX);
  const messages: ServerMsg[] = [];
  const conn: Conn = { id: 1, name: 'court target', send: m => messages.push(m), sendRaw: s => messages.push(JSON.parse(s)) };
  room.add(conn, 0);
  room.tick = 800; // past opening / spawn protection and the original ball's first scheduled spawn
  const internal = room as unknown as Internals;
  internal.monitorOffUntil = 10000; // isolate Warden; the real monitor observation and boss rules stay unchanged
  const player = room.players.get(1)!;
  player.p = [...playerPosition]; player.yaw = 0; player.f = 0;
  internal.warden.reset(internal.searchNav.anchor(wardenPosition));
  internal.warden.yaw = Math.PI / 2; // face away: a real impact must draw an investigation before sight earns pursuit
  const now = room.tick / 20;
  internal.tension.observe(now - 2, { state: 'chase', target: 1, p: internal.warden.p, retreating: false });
  internal.tension.observe(now - 1, { state: 'investigate', target: 0, p: internal.warden.p, retreating: false });
  expect(internal.tension.resting(now)).toBe(true);
  room.gym!.step(now, .05, []);
  const ball = room.gym!.balls[0];
  ball.p = [player.p[0] - .7, player.p[1], player.p[2]];
  ball.v = [12, 0];
  messages.length = 0;
  return { room, internal, player, conn, messages, ball };
}

describe('L5 basketball impact threat response', () => {
  it('turns a real audible impact into an investigation and a visible pursuit during a director respite', () => {
    const { room, internal, player, messages } = setup();
    const before: Vec3 = [...internal.warden.p];
    const impact = [...player.p];
    room.step();
    expect(messages).toContainEqual({ t: 'gym-sound', kind: 'trip', p: impact, player: 1 });
    expect(room.gym!.tripped(1, room.tick / 20)).toBe(true);
    expect(internal.tension.resting(room.tick / 20)).toBe(false);
    expect(internal.warden.state).toBe('investigate');
    expect(internal.warden.goal).toEqual(impact);
    expect(Math.hypot(...internal.warden.p.map((value, axis) => value - before[axis]))).toBeLessThan(.2);
    for (let i = 0; i < 20 && internal.warden.state !== 'chase'; i++) room.step();
    expect(internal.warden.state).toBe('chase');
    expect(internal.warden.target).toBe(1);
    expect(player.st).toBe(ST_OK);
    expect(player.p).toEqual(impact);
    expect(room.gym!.snapshot(room.tick / 20).trips).toEqual([{ id: 1, until: 40.05 + GYM_TRIP_S }]);
  });

  it('does not let forged client impact messages bypass the normal director respite', () => {
    const { room, internal, conn, messages, ball } = setup();
    ball.p = [-111.76, .035, 50]; ball.v = [0, 0];
    room.handle(conn, { t: 'gym-sound', kind: 'trip', p: [-100, .035, 62], player: 1 } as never, 40000);
    room.step();
    expect(messages.some(m => m.t === 'gym-sound' && m.kind === 'trip')).toBe(false);
    expect(room.gym!.tripped(1, room.tick / 20)).toBe(false);
    expect(internal.tension.resting(room.tick / 20)).toBe(true);
    expect(internal.warden.state).toBe('patrol');
  });

  it('also alerts on validated player movement into a ball and keeps the corrected player position authoritative', () => {
    const { room, internal, player, ball, messages } = setup();
    const before: Vec3 = [...player.p];
    ball.p = [before[0] + .9, before[1], before[2]]; ball.v = [0, 0];
    const predicted: Vec3 = [before[0] + .5, before[1], before[2]];
    room.applyInput(player, { t: 'input', p: predicted, yaw: 0, pitch: 0, f: 0, c: player.c, seq: 1 }, 40000);
    expect(messages).toContainEqual({ t: 'gym-sound', kind: 'trip', p: predicted, player: 1 });
    expect(room.gym!.tripped(1, room.tick / 20)).toBe(true);
    expect(player.p).toEqual(before);
    expect(internal.tension.resting(room.tick / 20)).toBe(false);
    expect(internal.warden.state).toBe('investigate');
    expect(internal.warden.goal).toEqual(before);
  });

  it.each(['range', 'protection', 'debug-safe'] as const)('respects %s when an actual ball hits', kind => {
    const { room, internal, player, messages } = kind === 'range'
      ? setup([-89, .035, 62], [-114, .035, 62]) : setup();
    if (kind === 'protection') player.safeUntil = room.tick + 100;
    if (kind === 'debug-safe') internal.wardenOffUntil = room.tick + 100;
    room.step();
    expect(messages.some(m => m.t === 'gym-sound' && m.kind === 'trip')).toBe(true);
    expect(internal.tension.resting(room.tick / 20)).toBe(true);
    expect(internal.warden.state).not.toBe('chase');
    expect(Math.hypot(internal.warden.p[0] - player.p[0], internal.warden.p[2] - player.p[2]) > BALL_TRIP_NOISE || kind !== 'range').toBe(true);
  });

  it('investigates a muffled nearby impact behind the equipment wall without seeing through it', () => {
    const { room, internal, messages } = setup([-114, .035, 49.6], [-114, .035, 55]);
    expect(room.noiseBlocked(-114, 1.035, 49.6, -114, 1.035, 55)).toBe(true);
    room.step();
    expect(messages.some(m => m.t === 'gym-sound' && m.kind === 'trip')).toBe(true);
    expect(internal.tension.resting(room.tick / 20)).toBe(false);
    expect(internal.warden.state).toBe('investigate');
    expect(internal.warden.target).toBe(0);
    expect(internal.warden.goal).toEqual([-114, .035, 49.6]);
  });

  it('keeps the equipment wall hearing attenuation for an impact too far behind it', () => {
    const { room, internal, messages } = setup([-114, .035, 49.6], [-114, .035, 59]);
    expect(room.noiseBlocked(-114, 1.035, 49.6, -114, 1.035, 59)).toBe(true);
    room.step();
    expect(messages.some(m => m.t === 'gym-sound' && m.kind === 'trip')).toBe(true);
    expect(internal.tension.resting(room.tick / 20)).toBe(true);
    expect(internal.warden.state).toBe('patrol');
    expect(internal.warden.target).toBe(0);
  });
});
