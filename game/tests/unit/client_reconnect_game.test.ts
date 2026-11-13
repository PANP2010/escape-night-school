import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Game } from '../../client/src/game.ts';
import { MoveLog } from '../../client/src/reconcile.ts';
import { CorrectionSmoother } from '../../client/src/interp.ts';
import { TeamActivity } from '../../client/src/teamActivity.ts';
import { F_HIDE, F_LIGHT } from '../../shared/protocol.ts';
import { inactiveGameCollaborators } from './game_fixture.ts';

let count: { textContent: string };
beforeEach(() => {
  vi.useFakeTimers(); count = { textContent: '20' };
  vi.stubGlobal('document', { querySelector: () => count, getElementById: (id: string) => id === 'down-overlay' ? { hidden: false, querySelector: () => count } : null });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

/** Exercise actual pause/update/correction handlers without constructing a WebGL renderer. */
function pausedGame() {
  const moves = new MoveLog(); moves.push({ seq: 8, dx: 0.4, dz: 0, dt: .1 });
  const input = { enabled: true, keys: new Set(['KeyW', 'KeyE']), clear() { this.keys.clear(); } };
  return Object.assign(Object.create(Game.prototype), {
    ...inactiveGameCollaborators(),
    pausedForNetwork: false, feedbackEpoch: 0, input, moves, smooth: new CorrectionSmoother(),
    body: { x: 2, y: 0, z: 3, vy: 0, grounded: true }, pos: { x: 2, z: 3 },
    route: [[2, 3], [9, 3]], sendAcc: 45, myF: F_LIGHT, corrC: 1, completed: false, down: true,
    sound: { reset: vi.fn(), dispose: vi.fn() }, voice: { silence: vi.fn(), dispose: vi.fn() },
    haptics: { cancel: vi.fn(), pulse: vi.fn(), dispose: vi.fn() },
    steps: { reset: vi.fn() }, remoteSteps: new Map(), remotes: new Map(), mobs: { byId: new Map() },
    jasmine: { update: vi.fn() }, humStop: vi.fn(), campus: {}, net: { send: vi.fn() },
    teamActivity: new TeamActivity(), intro: { active: false },
    reviveHold: { sync: vi.fn(), stop: vi.fn() }, capture: { sync: vi.fn() },
  }) as Game;
}

describe('game connection boundary', () => {
  it('freezes autopilot and held actions, discards prediction, and retains reusable feedback', () => {
    const game = pausedGame(), state = game as any;
    game.setNetworkPaused(true);
    expect(game.networkPaused).toBe(true); expect(game.input.enabled).toBe(false);
    expect(game.input.keys.size).toBe(0); expect(state.route).toBeNull(); expect(state.moves.size).toBe(0);
    expect(count.textContent).toBe('…');
    game.update(.1, 1000);
    expect(game.pos).toEqual({ x: 2, z: 3 }); expect(state.net.send).not.toHaveBeenCalled();
    expect(state.sound.reset).toHaveBeenCalled(); expect(state.voice.silence).toHaveBeenCalled();
    for (const feedback of [state.sound, state.voice, state.haptics]) expect(feedback.dispose).not.toHaveBeenCalled();
    game.onMsg({ t: 'correct', p: [8, 0, 9], c: 12, forced: true });
    expect(game.pos).toEqual({ x: 8, z: 9 }); expect(state.corrC).toBe(12); expect(game.networkPaused).toBe(true);
    game.input.keys.add('KeyE');
    game.setNetworkPaused(false);
    expect(game.input.keys.size).toBe(0); expect(game.input.enabled).toBe(true); expect(game.light).toBe(true);
    expect(game.pos).toEqual({ x: 8, z: 9 });
  });

  it('uses authoritative down time remaining without replaying capture feedback', () => {
    const game = pausedGame(), state = game as any;
    game.setNetworkPaused(true);
    game.onMsg({ t: 'resume', downLeft: 3.2 });
    expect(count.textContent).toBe('4'); expect(game.downHold).toBe(3.2);
    vi.advanceTimersByTime(2000); state.tickDown(performance.now());
    expect(count.textContent).toBe('2'); expect(state.haptics.pulse).not.toHaveBeenCalled();
  });

  it('restores the authoritative locker view on a refreshed page before releasing input', () => {
    const game = pausedGame(), state = game as any;
    Object.assign(state, {
      myId: 7, down: false, spawnSynced: true, snaps: 0, hiding: -1, hideYaw: 0,
      peers: new Map(), level: { def: { hides: [{ kind: 'locker', x: 2, y: 0, z: 3 }] } },
      target: () => null, mobs: { byId: new Map(), onSnap: vi.fn() },
    });
    Object.assign(game.input, { yaw: 0, pitch: 0 });
    game.setNetworkPaused(true);
    game.onMsg({ t: 'snap', tick: 20, players: [{ id: 7, p: [2, 0, 3], yaw: 1.4, pitch: .1, f: F_HIDE }], mobs: [] });
    expect(state.hiding).toBe(0);
    expect(state.hideYaw).toBe(1.4);
    expect(game.input.yaw).toBe(1.4);
    expect(game.input.pitch).toBe(.1);
    expect(game.input.enabled).toBe(false);
    expect(game.networkPaused).toBe(true);
  });
});
