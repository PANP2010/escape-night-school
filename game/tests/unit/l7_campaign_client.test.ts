import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { mirrorGuideGoal, mirrorKeyReady, mirrorWallCandidates } from '../../client/src/campaignMirror.ts';
import { Game } from '../../client/src/game.ts';
import { goalPoint } from '../../client/src/guide.ts';
import { objective } from '../../client/src/objective.ts';
import { touchObjectiveText } from '../../client/src/hudText.ts';
import { touchHitState, worldTouchHit } from '../../client/src/worldTouch.ts';
import type { CampaignMirrorSnap } from '../../shared/l7-campaign.ts';
import { L7_KEY_GUARD } from '../../shared/l7-key.ts';
import { L7, L7_CAMPUS_DOORS, MIRRORS, l7World } from '../../shared/levels/l7.ts';
import { beamHit } from '../../shared/campus/nav.ts';
import { inactiveGameCollaborators } from './game_fixture.ts';

afterEach(() => vi.unstubAllGlobals());

// Keep the real level and message lifecycle while replacing the WebGL-only view.
vi.mock('../../client/src/l7-view.ts', () => ({
  L7MirrorView: class {
    setDoors = vi.fn();
    setKey = vi.fn();
    dispose = vi.fn();
  },
}));

const snapshot = (taken = false, openDoors: number[] = [], revealedDoors: number[] = []): CampaignMirrorSnap => ({
  t: 'l7', tick: 1, mirrors: [], openDoors, revealedDoors,
  key: { taken, open: !taken, guard: { p: [...L7_KEY_GUARD], yaw: -Math.PI / 2, watched: false } },
});

describe('campaign mirror goals', () => {
  it('keeps the key goal downstairs when the first wall was pushed before the key was taken', () => {
    for (const state of [snapshot(false, [], [1, 2]), snapshot(false, [1], [1, 2])]) {
      expect(objective(L7, { stair_key: 1, door_key: 3 }, 0, state).cur).toBe(0);
      const goal = mirrorGuideGoal(state);
      expect(goal.y).toBe(0);
      expect(Math.hypot(goal.x - MIRRORS[0].center[0], goal.z - MIRRORS[0].center[2])).toBeLessThan(2.15);
    }
  });

  it('names the actual touch targets in idle hints', () => {
    const key = touchObjectiveText(objective(L7, {}, 0, snapshot()).hints[0]);
    const wall = touchObjectiveText(objective(L7, {}, 0, snapshot(true)).hints[0]);
    expect(key).toContain('点镜中钥匙'); expect(wall).toContain('点对应墙');
    expect(key + wall).not.toContain('按 E');
  });

  it('visits each mirror before its corresponding wall and finally waits at the ordinary campaign exit', () => {
    expect(mirrorGuideGoal(snapshot(true)).x).toBeLessThan(-80);
    expect(mirrorGuideGoal(snapshot(true, [], [1])).x).toBeGreaterThan(-80);
    expect(mirrorGuideGoal(snapshot(true, [1], [1]))).toMatchObject({ y: 3.6, x: MIRRORS[1].center[0] + 1.5 });
    expect(mirrorGuideGoal(snapshot(true, [1], [1, 2])).x).toBeGreaterThan(-80);
    const done = objective(L7, {}, 0, snapshot(true, [1, 2]));
    expect(done.cur).toBe(done.steps.length - 1);
    expect(goalPoint(L7, done, [], new Set(), L7.exit)).toMatchObject({ x: L7.exit.x, y: L7.exit.y, z: L7.exit.z, arrived: true });
  });

  it('clears discoveries on the real restart message even when the room repeats the same level and seed', () => {
    vi.stubGlobal('document', { getElementById: () => null });
    const g = Object.assign(Object.create(Game.prototype), {
      ...inactiveGameCollaborators(),
      level: { index: 6, seed: 42, def: L7 }, mirrorState: snapshot(true, [1, 2], [1, 2]), guideAt: 99, guide: {},
      voice: { cancel: vi.fn() }, voiceEpoch: 0,
      sound: { reset: vi.fn(), transition: vi.fn() }, steps: { reset: vi.fn() }, remoteSteps: new Map(),
      haptics: { cancel: vi.fn() }, input: { clear: vi.fn() }, moves: { clear: vi.fn() },
      down: false, spectate: false, jasmine: { reset: vi.fn() },
      capture: { reset: vi.fn(), update: vi.fn(() => ({ phase: 'idle', caught: false })) },
      renderer: { domElement: { style: {} } }, body: { x: -80, y: 0, z: 140 }, scene: new THREE.Scene(),
      campus: { outFloor: null, world: {}, setLandmarks: vi.fn() }, mirrorDoorBoxes: new Map(), campusVisibility: new Map(), campusObjects: [],
      doorOpen: [], doorSwing: [], doorLocked: [], loopPlayers: new Map(), warpEpochs: new Map(), seen: new Set(),
      buildBlackout: vi.fn(), buildDoors: vi.fn(), buildBarriers: vi.fn(), refreshDoors: vi.fn(), loadPlan: vi.fn(), refreshObjective: vi.fn(),
      rebuildMirrorCollision: vi.fn(), showBag: vi.fn(), drawOn: false,
    }) as Game;
    g.onMsg({ t: 'fade', secs: 3, restart: true });
    expect(g.loadLevel(6, 42)).toBe(false); // an ordinary same-seed roster cannot restart the level
    g.onMsg({ t: 'event', kind: 'intro', id: 1, level: 6, startedAt: 0, endsAt: 8000, now: 0,
      skipped: [], ended: false, route: [] });
    expect(g.mirrorState).toBeUndefined();
    expect(g.intro.reset).toHaveBeenCalledOnce();
    g.onMsg(snapshot());
    expect(g.mirrorState?.revealedDoors).toEqual([]);
    expect(mirrorWallCandidates(g.mirrorState!)).toEqual([]);
    const next = mirrorGuideGoal({ ...g.mirrorState!, key: snapshot(true).key, openDoors: [1] });
    expect(next).toMatchObject({ x: MIRRORS[1].center[0] + 1.5, y: 3.6 });
  });
});

describe('campaign mirror world interaction', () => {
  it('offers walls only after the team has discovered them, and keeps the upstairs wall locked until the key is taken', () => {
    expect(mirrorWallCandidates(snapshot(true))).toEqual([]);
    expect(mirrorWallCandidates(snapshot(false, [], [1, 2])).map(c => c.id)).toEqual([1]);
    expect(mirrorWallCandidates(snapshot(true, [], [1, 2])).map(c => c.id)).toEqual([1, 2]);
    expect(mirrorWallCandidates(snapshot(true, [1], [1, 2])).map(c => c.id)).toEqual([2]);
  });
  it('only offers the reflected key during the live turn window with clear wall visibility', () => {
    const world = l7World(), state = snapshot();
    const viewer = { p: [-80.4, 0, 143.4] as [number, number, number], yaw: Math.PI / 2, pitch: -.1, st: 0 };
    expect(mirrorKeyReady(viewer, state, world)).toBe(true);
    expect(mirrorKeyReady(viewer, { ...state, key: { ...state.key, open: false } }, world)).toBe(false);
    expect(mirrorKeyReady({ ...viewer, st: 2 }, state, world)).toBe(false);
    world.add({ minX: -81.6, maxX: -81.4, minZ: 142.6, maxZ: 144.2, minY: 0, maxY: 2.5 });
    expect(mirrorKeyReady(viewer, state, world)).toBe(false);
  });

  it('selects the real secret wall from a screen tap and accepts its visible pushing surface', () => {
    const camera = new THREE.PerspectiveCamera(73, 844 / 390, .04, 60);
    camera.position.set(-79, 1.55, 143.4); camera.rotation.set(0, -Math.PI / 2, 0, 'YXZ');
    const hit = worldTouchHit(camera, { left: 0, top: 0, width: 844, height: 390 }, 422, 195, [], mirrorWallCandidates(snapshot(true, [], [1])));
    expect(hit?.target).toMatchObject({ kind: 'mirror-push', id: 1 });
    expect(touchHitState(hit!, camera, [-79, 0, 143.4], l7World())).toBe('ready');
  });

  it('retains ordinary closed LAB door collision when a secret wall snapshot rebuilds the world', () => {
    const d = L7_CAMPUS_DOORS.find(q => q.y0 === 0)!;
    const g = Object.assign(Object.create(Game.prototype), {
      mirrorDoorBoxes: new Map(), doorOpen: [], doorSwing: [],
    }) as Game;
    const rebuild = (g as unknown as { rebuildMirrorCollision(open: number[]): void }).rebuildMirrorCollision.bind(g);
    const alongX = d.box.x1 - d.box.x0 > d.box.z1 - d.box.z0;
    const origin = { x: d.x + (alongX ? 0 : -1), y: 1.2, z: d.z + (alongX ? -1 : 0) };
    const dir = { x: alongX ? 0 : 1, y: 0, z: alongX ? 1 : 0 };
    for (const open of [[], [1]]) {
      rebuild(open);
      expect(beamHit(g.collision, origin, dir, 2)?.t).toBeLessThan(1.1);
    }
    Object.assign(g, { doorOpen: Object.assign([], { [d.id]: true }), doorSwing: Object.assign([], { [d.id]: 1 }) });
    rebuild([1]);
    const ray = beamHit(g.collision, origin, dir, 2);
    expect(ray === null || ray.t > 1.1).toBe(true);
  });
});
