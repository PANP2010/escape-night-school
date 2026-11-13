import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { Game } from '../../client/src/game.ts';
import { frameSlices, InterpBuffer, PlaybackClock, SnapClock, StepSmoother } from '../../client/src/interp.ts';
import { Mobs } from '../../client/src/mobs.ts';
import { EXTRAP_MAX_MS, INTERP_DELAY_MS, TICK_MS } from '../../shared/constants.ts';
import { WARDEN_PATROL_SPEED } from '../../server/ai/warden.ts';
import { inactiveGameCollaborators } from './game_fixture.ts';

afterEach(() => vi.restoreAllMocks());

function client() {
  const playback = () => ({ mesh: new THREE.Object3D(), buf: new InterpBuffer(),
    clock: new PlaybackClock(INTERP_DELAY_MS), sm: new StepSmoother() });
  const remote = { ...playback(), f: 0, st: { spot: new THREE.Object3D() } };
  const mob = { ...playback(), monitor: false, form: 'normal', anim: 'patrol',
    warden: { update: vi.fn() }, poseTime: 0, at: [0, 0, 0], skipMonitorStep: false };
  // Exercise real mob playback without constructing a skinned figure or a WebGL renderer.
  const mobs = new Mobs(new THREE.Scene());
  mobs.byId.set(1, mob as any);
  const game = Object.assign(Object.create(Game.prototype), {
    ...inactiveGameCollaborators(),
    myId: 1, snaps: 0, lastSnapTick: -1, snapClock: new SnapClock(TICK_MS), peers: new Map(),
    remotes: new Map([[2, remote]]), mobs,
  }) as Game;
  const receive = (tick: number) => {
    const x = tick * TICK_MS / 1000 * WARDEN_PATROL_SPEED;
    game.onMsg({ t: 'snap', tick,
      players: [{ id: 2, p: [x, 3.6, 4], yaw: .7, pitch: -.2 }],
      mobs: [{ id: 1, p: [x, 0, 0], yaw: Math.PI / 2 }],
    });
  };
  return { game, mobs, mob, remote, receive };
}

describe('authoritative snapshot playback time', () => {
  it('keeps live ticks and sampled speed intact after both campus and first-render backlogs', () => {
    const c = client(), now = vi.spyOn(performance, 'now').mockReturnValue(12_000);
    // Campus preparation and its first rendered world frame each queue ordered WS snapshots.
    for (let tick = 0; tick <= 240; tick++) c.receive(tick);
    now.mockReturnValue(15_000);
    for (let tick = 241; tick <= 300; tick++) c.receive(tick);
    const before = [c.mob, c.remote].map(entity => entity.buf.lastT());
    now.mockReturnValue(15_051); c.receive(301);
    for (const [i, entity] of [c.mob, c.remote].entries()) {
      expect(entity.buf.lastT() - before[i]).toBeCloseTo(TICK_MS, 9);
      expect(entity.buf.paceSpeed()).toBeCloseTo(WARDEN_PATROL_SPEED, 9);
    }
    expect(c.remote.buf.at(c.remote.buf.lastT())).toMatchObject({ y: 3.6, z: 4, yaw: .7, pitch: -.2 });
    // The real rendering consumer must stay behind the authority, rather than extrapolating an inflated speed.
    c.mobs.update(15_051, .01);
    expect(c.mob.mesh.position.x).toBeLessThanOrEqual(301 * TICK_MS / 1000 * WARDEN_PATROL_SPEED);
  });

  it('keeps three differently delayed loads together as the real server drifts to 51ms per tick', () => {
    const now = vi.spyOn(performance, 'now'), clients = [client(), client(), client()];
    const preparedAt = [10_000, 11_400, 12_800], visibleAt = preparedAt.map(t => t + 3000);
    const sent = [-1, -1, -1];
    let spread = 0, ahead = 0, tailTravel = 0, previous = 0;
    for (let t = preparedAt[0]; t <= 60_000; t += 10) {
      now.mockReturnValue(t);
      const latestTick = Math.floor(t / 51);
      for (const [i, c] of clients.entries()) {
        // WS frames collected during preparation, and again during its initial expensive render, arrive in bursts.
        if (t < preparedAt[i] || t > preparedAt[i] && t < visibleAt[i]) continue;
        for (let tick = sent[i] + 1; tick <= latestTick; tick++) c.receive(tick);
        sent[i] = latestTick;
        if (t < visibleAt[i]) continue;
        for (const [, dt] of frameSlices(.01)) c.mobs.update(t, dt);
        ahead = Math.max(ahead, c.mob.mesh.position.x - latestTick * TICK_MS / 1000 * WARDEN_PATROL_SPEED);
      }
      if (t >= visibleAt[2]) {
        const xs = clients.map(c => c.mob.mesh.position.x);
        spread = Math.max(spread, Math.max(...xs) - Math.min(...xs));
      }
      if (t > 59_000) tailTravel += clients[0].mob.mesh.position.x - previous;
      previous = clients[0].mob.mesh.position.x;
    }
    expect(spread, 'same authoritative patrol on all three clients').toBeLessThan(.3);
    expect(ahead, 'no velocity inflation while retiring local clock debt')
      .toBeLessThanOrEqual(WARDEN_PATROL_SPEED * EXTRAP_MAX_MS / 1000);
    expect(tailTravel, 'long-running server drift must not freeze playback').toBeGreaterThan(1.2);
  });
});
