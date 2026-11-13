import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { Game } from '../../client/src/game.ts';
import { goalPoint } from '../../client/src/guide.ts';
import { InterpBuffer, PlaybackClock, StepSmoother } from '../../client/src/interp.ts';
import { objective, panelFor } from '../../client/src/objective.ts';
import { ObjectiveTiming } from '../../client/src/objectiveTiming.ts';
import { TeamActivity } from '../../client/src/teamActivity.ts';
import { L3 } from '../../shared/levels/l3.ts';
import { F_CROUCH } from '../../shared/protocol.ts';
import { inactiveGameCollaborators } from './game_fixture.ts';

/** Exercise the actual message handler without creating a WebGL renderer or campus scene. */
const game = () => Object.assign(Object.create(Game.prototype), {
  ...inactiveGameCollaborators(),
  myId: 1, worldReady: true, level: { index: 2, def: L3 }, pos: { x: 19.4, z: 84.2 },
  camera: new THREE.PerspectiveCamera(), campus: { collision: {}, world: {}, setLandmarks: vi.fn() },
  body: { x: 19.4, y: 7.2, z: 84.2, vy: -1, grounded: false },
  input: { yaw: 0, pitch: 0.2, keys: new Set(['KeyW']), enabled: true, endFrame: vi.fn(), clear() { this.keys.clear(); } },
  sound: { reset: vi.fn(), transition: vi.fn() }, haptics: { cancel: vi.fn() }, jasmine: { reset: vi.fn() },
  capture: { reset: vi.fn(), update: vi.fn(() => ({ phase: 'idle', caught: false })) }, renderer: { domElement: { style: {} } }, down: false, spectate: false,
  voice: { cancel: vi.fn() }, voiceEpoch: 0,
  // This fixture bypasses Game's constructor, so provide its required inactive LevelIntro collaborator.
  intro: { id: -1, active: false, presenting: false, skipped: false, reset: vi.fn(), receive: vi.fn(), dispose: vi.fn() },
  objectiveTiming: new ObjectiveTiming(), objectivePauses: new Set(), tut: { stop: vi.fn() },
  teamActivity: new TeamActivity(), interactionHighlight: { setGroup: vi.fn(), update: vi.fn() }, refreshLevelHighlights: vi.fn(),
  reviveHold: { stop: vi.fn(), sync: vi.fn() },
  story: { enter: vi.fn(), setAvailable: vi.fn(), setVisible: vi.fn() },

  steps: { reset: vi.fn() }, remoteSteps: new Map(),
  corrC: 2, corrections: 0, moves: { clear: vi.fn() }, smooth: { reset: vi.fn() },
  loopPlayers: new Map(), warpEpochs: new Map(), peers: new Map(), remotes: new Map(),
  mirrorDoorBoxes: new Map(), campusVisibility: new Map(),
  refreshObjective: vi.fn(), toast: vi.fn(), route: [[19.4, 84.2], [18, 84.2]],
}) as Game;

afterEach(() => vi.unstubAllGlobals());

describe('L3 client objective and guide', () => {
  it('HUD always shows the clue, next real doorway, personal loops and unlocked exit', () => {
    // Keep the original L3 HUD/guide regression coverage alongside the client tests.
    const o = objective(L3, {}, 0, { step: 1, loops: 2, mistakes: 0 });
    expect(panelFor(o).got).toBe('个人进度：门序 1/4 · 回环 2 次');
    expect(panelFor(o).goal).toContain('301');
    expect(o.note).toContain('303 → 301 → 304 → 302');
    expect(goalPoint(L3, o, [], new Set(), { x: 55, y: 7.2, z: 84.2 })).toMatchObject({ x: 22.85, z: 81.69, exact: true });
    const done = objective(L3, {}, 0, { step: 4, loops: 2, mistakes: 0 });
    expect(done.cur).toBe(1); expect(done.note).toContain('解除');
    expect(goalPoint(L3, done, [], new Set(), L3.exit)).toEqual({ x: L3.exit.x, y: L3.exit.y, z: L3.exit.z, exact: true, arrived: true });
  });

  it('each personal step leads inside the matching real doorway and a mistake restarts its hint clock', () => {
    for (const [step, label] of L3.loop!.sequence.entries()) {
      const o = objective(L3, {}, 0, { step, loops: 0, mistakes: 0 });
      const d = L3.loop!.doors.filter((door) => door.label === label).at(-1)!;
      expect(panelFor(o).goal).toContain(label);
      expect(o.target).toEqual({ x: d.x, y: d.y, z: d.z - 0.95 });
      expect(o.note).toContain('303 → 301 → 304 → 302');
    }
    const initial = objective(L3, {}, 0);
    expect(panelFor(initial).got).toContain('门序 0/4');
    const wrong = objective(L3, {}, 0, { step: 0, loops: 0, mistakes: 1 });
    expect(wrong.key).not.toBe(initial.key);
    expect(wrong.target).toEqual(initial.target);
    expect(objective(L3, {}, 0, { step: 0, loops: 1, mistakes: 0 }).key).not.toBe(initial.key);
  });
});

describe('L3 authoritative client messages', () => {
  it('keeps each player progress independent and replaces the complete loop table', () => {
    const g = game();
    g.onMsg({ t: 'loop', players: [{ id: 1, step: 1, loops: 0, mistakes: 0 }, { id: 2, step: 0, loops: 2, mistakes: 1 }] });
    expect([...g.loopPlayers]).toEqual([[1, { step: 1, loops: 0, mistakes: 0 }], [2, { step: 0, loops: 2, mistakes: 1 }]]);
    g.onMsg({ t: 'loop', players: [{ id: 1, step: 1, loops: 1, mistakes: 0 }, { id: 2, step: 4, loops: 2, mistakes: 1 }] });
    expect(g.loopPlayers.get(1)).toEqual({ step: 1, loops: 1, mistakes: 0 });
    expect(g.loopPlayers.get(2)?.step).toBe(4);
    expect((g as any).toast).toHaveBeenLastCalledWith('越过走廊尽头，触发回环 · 门序 1/4 保留', 4000);
    g.onMsg({ t: 'loop', players: [{ id: 1, step: 0, loops: 1, mistakes: 1 }] });
    expect(g.loopPlayers.has(2)).toBe(false);
    expect((g as any).toast).toHaveBeenLastCalledWith('门序错了，从 303 重新开始');
    expect((g as any).refreshObjective).toHaveBeenCalledTimes(3);
  });

  it('applies a local warp as one authoritative jump, retains view pitch, and rejects older correction epochs', () => {
    const g = game();
    g.onMsg({ t: 'warp', id: 1, p: [55.4, 7.2, 84.2], c: 3, yaw: Math.PI / 2 });
    expect(g.pos).toEqual({ x: 55.4, z: 84.2 });
    expect(g.body).toEqual({ x: 55.4, y: 7.2, z: 84.2, vy: 0, grounded: true });
    expect(g.input.yaw).toBe(Math.PI / 2); expect(g.input.pitch).toBe(0.2);
    expect((g as any).corrC).toBe(3);
    expect((g as any).moves.clear).toHaveBeenCalledOnce();
    expect((g as any).smooth.reset).toHaveBeenCalledOnce();
    expect(g.corrections).toBe(0);
    g.onMsg({ t: 'correct', p: [19.4, 7.2, 84.2], c: 2, forced: true });
    g.onMsg({ t: 'warp', id: 1, p: [19.4, 7.2, 84.2], c: 2, yaw: 0 });
    expect(g.pos.x).toBe(55.4); expect((g as any).corrC).toBe(3);
    expect((g as any).moves.clear).toHaveBeenCalledOnce();
  });

  it('retains the new correction epoch when a level room message follows its authoritative spawn correction', () => {
    const g = game(), context = { fillRect() {}, strokeRect() {}, fillText() {} };
    vi.stubGlobal('document', { getElementById: () => null, createElement: () => ({ width: 0, height: 0, getContext: () => context }) });
    Object.assign(g, {
      scene: new THREE.Scene(), seen: new Set(), drawOn: false,
      tut: { stop: vi.fn() }, bannerTimers: [],
      buildBlackout: vi.fn(), buildDoors: vi.fn(), buildBarriers: vi.fn(), loadPlan: vi.fn(),
    });
    g.onMsg({ t: 'correct', p: [55.2, 7.2, 84.2], c: 5, forced: true });
    expect(g.loadLevel(2, 42, false, false, 0)).toBe(true);
    expect((g as any).jasmine.reset).toHaveBeenCalledOnce();
    expect(g.intro.reset).toHaveBeenCalledOnce();
    expect((g as any).corrC).toBe(5);
    expect((g as any).spawnSynced).toBe(false);
    expect(g.level.index).toBe(2); expect(g.level.seed).toBe(42);
    expect(g.body).toEqual({ x: 55.2, y: 7.2, z: 84.2, vy: 0, grounded: true });
    expect((g as any).loopView.root.children.length).toBeGreaterThan(0);
    // A roster update during the wipe fade must not count as arrival at a new attempt.
    const view = (g as any).loopView, fadeUntil = performance.now() + 3000;
    Object.assign(g, { spawnSynced: true, fadeUntil });
    (g as any).seen.add(999);
    g.loopPlayers.set(1, { step: 2, loops: 1, mistakes: 0 });
    expect(g.loadLevel(2, 42, false, false, 0)).toBe(false);
    expect((g as any).loopView).toBe(view);
    expect(g.presentationReady).toBe(true);
    expect((g as any).fadeUntil).toBe(fadeUntil);
    expect((g as any).seen.has(999)).toBe(true);
    expect(g.loopPlayers.get(1)?.step).toBe(2);
    expect((g as any).sound.reset).toHaveBeenCalledOnce();
    expect(g.loadLevel(2, 42, false, false, 1)).toBe(true);
    expect(g.presentationReady).toBe(false);
    expect((g as any).fadeUntil).toBe(0);
    expect((g as any).seen.size).toBe(0);
    expect(g.loopPlayers.size).toBe(0);
    expect((g as any).corrC).toBe(5);
    expect((g as any).sound.reset).toHaveBeenCalledTimes(2);
    (g as any).loopView.dispose();
  });

  it('resets a remote clock, smoothing and samples at the seam instead of interpolating across the corridor', () => {
    const g = game(), buf = new InterpBuffer(), clock = new PlaybackClock(100), sm = new StepSmoother();
    buf.push({ t: 0, x: 20, y: 7.2, z: 84.2, yaw: 0 });
    buf.push({ t: 50, x: 19.4, y: 7.2, z: 84.2, yaw: 0 });
    clock.advance(50, 50); sm.step(19.4, 84.2, 0.05, 3.4);
    const mesh = new THREE.Object3D(); mesh.position.set(19.4, 7.2, 84.2);
    const remote = { buf, clock, sm, mesh, f: F_CROUCH };
    g.remotes.set(2, remote as any);
    (g as any).peers.set(2, { st: 0, p: [19.4, 7.2, 84.2] });
    g.onMsg({ t: 'warp', id: 2, p: [55.4, 7.2, 84.2], c: 4, yaw: Math.PI / 2 });
    expect(remote.buf).not.toBe(buf); expect(remote.clock).not.toBe(clock);
    expect(remote.buf.at(0)).toBeNull(); expect(remote.clock.t).toBeNaN();
    expect(mesh.position.toArray()).toEqual([55.4, 7.2, 84.2]);
    expect(mesh.rotation.y).toBe(Math.PI / 2);
    expect((g as any).peers.get(2).p).toEqual([55.4, 7.2, 84.2]);
    remote.buf.push({ t: 100, x: 55.3, y: 7.2, z: 84.2, yaw: Math.PI / 2 });
    remote.clock.advance(16, remote.buf.lastT());
    const p = remote.buf.at(remote.clock.t)!;
    remote.sm.step(p.x, p.z, 0.016, remote.buf.paceSpeed());
    expect(remote.sm.x).toBe(55.3);
    g.onMsg({ t: 'warp', id: 2, p: [19.4, 7.2, 84.2], c: 3, yaw: 0 });
    expect(mesh.position.x).toBe(55.4);
    expect(remote.buf.at(100)?.x).toBe(55.3);
  });

  it('stops prediction during fade and completion, clearing held movement and routes', () => {
    const g = game();
    g.onMsg({ t: 'fade', secs: 3, restart: false });
    expect((g as any).jasmine.reset).toHaveBeenCalledOnce();
    expect(g.input.keys.size).toBe(0); expect((g as any).route).toBeNull();
    g.update(0.05, performance.now());
    expect(g.input.endFrame).toHaveBeenCalledOnce();
    g.onMsg({ t: 'complete', level: 2 });
    expect((g as any).jasmine.reset).toHaveBeenCalledTimes(2);
    expect(g.completed).toBe(true); expect(g.input.enabled).toBe(false);
    g.update(0.05, performance.now() + 10_000);
    expect(g.input.endFrame).toHaveBeenCalledTimes(2);
  });
});
