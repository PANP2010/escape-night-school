import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { Game } from '../../client/src/game.ts';
import { CorrectionSmoother } from '../../client/src/interp.ts';
import { MoveLog } from '../../client/src/reconcile.ts';
import { RESUME_KEY } from '../../client/src/reconnect.ts';
import type { CompletionStats, ServerMsg } from '../../shared/protocol.ts';
import { inactiveGameCollaborators } from './game_fixture.ts';

/** Keep the real message, movement and interaction handlers; only omit WebGL and result markup. */
function fixture(myId: number) {
  const storage = new Map([[RESUME_KEY, 'ended-room-session']]);
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    removeItem: (key: string) => { storage.delete(key); },
  });
  vi.stubGlobal('document', { getElementById: () => null, querySelector: () => null });
  const moves = new MoveLog(); moves.push({ seq: 7, dx: .3, dz: 0, dt: .05 });
  const game = Object.assign(Object.create(Game.prototype), {
    ...inactiveGameCollaborators(),
    myId, hostId: 1, level: { index: 0 }, completed: false, fadeUntil: 0,
    spawnSynced: true, pausedForNetwork: false, down: false, spectate: myId === 2,
    camera: new THREE.PerspectiveCamera(), campus: { collision: {} },
    pos: { x: 2, z: 3 }, body: { x: 2, y: 0, z: 3, vy: 0, grounded: true },
    input: {
      enabled: true, keys: new Set(['KeyW', 'KeyE']), yaw: 0, pitch: 0,
      clear() { this.keys.clear(); }, consume: vi.fn(() => true), endFrame: vi.fn(),
    },
    moves, smooth: new CorrectionSmoother(), route: [[2, 3], [8, 3]],
    touchPending: { x: 10, y: 20 }, touchRevive: { id: 3, x: 10, y: 20 },
    sound: { reset: vi.fn() }, haptics: { cancel: vi.fn() }, steps: { reset: vi.fn() }, remoteSteps: new Map(),
    voice: { cancel: vi.fn(), silence: vi.fn() }, voiceEpoch: 0, jasmine: { reset: vi.fn() },
    capture: { reset: vi.fn(), update: vi.fn(() => ({ phase: 'idle', caught: false })) },
    renderer: { domElement: { style: {} } },
    remotes: new Map(), mobs: { byId: new Map() },
    net: { send: vi.fn(), close: vi.fn() }, renderCompletion: vi.fn(), refreshObjective: vi.fn(),
  }) as Game;
  return { game, storage, state: game as any };
}

afterEach(() => vi.unstubAllGlobals());

describe('royale settlement client boundary', () => {
  it.each([1, 2])('freezes winner and eliminated player %i and forgets the ended room before returning', (myId) => {
    const { game, storage, state } = fixture(myId);
    const settlement: Extract<ServerMsg, { t: 'royale-settle' }> = {
      t: 'royale-settle', ranking: [{ id: 2, rank: 2 }, { id: 1, rank: 1 }],
    };
    expect(game.canControl).toBe(true);

    game.onMsg(settlement);

    expect(game.completed).toBe(true);
    expect(game.canControl).toBe(false);
    expect(game.input.enabled).toBe(false);
    expect(game.input.keys.size).toBe(0);
    expect(state.route).toBeNull();
    expect(state.moves.size).toBe(0);
    expect(state.touchPending).toBeNull();
    expect(state.touchRevive).toBeNull();
    expect(state.reviveHold.stop).toHaveBeenCalled();
    expect(storage.has(RESUME_KEY), 'refresh must not resume the ended room').toBe(false);
    expect(state.renderCompletion).toHaveBeenCalledWith(settlement);
    expect(state.net.close).toHaveBeenCalledOnce();

    const before = { ...game.pos };
    game.update(.1, performance.now() + 1000);
    state.interactPressed(performance.now());
    state.interact({ kind: 'pick', id: 7, min: [0, 0, 0], max: [1, 1, 1] });
    state.onWorldTouch('tap', 10, 20);
    expect(game.pos).toEqual(before);
    expect(state.net.send).not.toHaveBeenCalled();

    // A subsequent online callback must not restore the controls of a finished match.
    game.setNetworkPaused(false);
    expect(game.input.enabled).toBe(false);
    expect(game.canControl).toBe(false);
    expect(state.net.send).not.toHaveBeenCalled();
  });

  it('preserves campaign completion statistics and the existing replay session', () => {
    const { game, storage, state } = fixture(1);
    const completed: CompletionStats = {
      t: 'completed', elapsedMs: 65000, downs: 2,
      members: [{ id: 1, name: '队员甲', downs: 2, escaped: true }],
    };
    game.onMsg({ t: 'complete', level: 7 });
    game.onMsg(completed);
    expect(game.completed).toBe(true);
    expect(game.input.enabled).toBe(false);
    expect(game.completion).toBe(completed);
    expect(game.finalState).toMatchObject({ phase: 'complete', elapsedMs: 65000, downs: 2 });
    expect(state.renderCompletion).toHaveBeenCalledWith(completed);
    expect(storage.has(RESUME_KEY)).toBe(true);
    expect(state.net.close).not.toHaveBeenCalled();
  });
});
