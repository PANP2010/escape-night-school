import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { Game } from '../../client/src/game.ts';
import { BANNER_FADE_MS, ObjectiveTiming } from '../../client/src/objectiveTiming.ts';
import { TeamActivity } from '../../client/src/teamActivity.ts';
import { L1 } from '../../shared/levels/l1.ts';
import { F_HIDE } from '../../shared/protocol.ts';
import { inactiveGameCollaborators } from './game_fixture.ts';

/** Exercise the real action / snapshot / tutorial bridge without WebGL or a browser. */
const game = () => Object.assign(Object.create(Game.prototype), {
  ...inactiveGameCollaborators(),
  myId: 1, level: { index: 0, seed: 42, def: L1 }, pos: { x: 0, z: 0 },
  input: { yaw: 0, pitch: 0, enabled: true, clear: vi.fn() }, hiding: -1, down: false, spectate: false, spawnSynced: true,
  tutPicks: new Map<number, number>(), tutPicked: false, tutCrouched: false, tutUsed: false,
  tutFrom: { x: 0, z: 0 }, tutLast: '', tutEl: {}, mapOpened: false,
  tut: { tick: vi.fn(), start: vi.fn(), stop: vi.fn() },
  net: { send: vi.fn() }, regionLocked: () => false,
  dropItems: vi.fn(), showBag: vi.fn(), showPrompt: vi.fn(), target: () => null,
  sound: { pickup: vi.fn(), transition: vi.fn() }, haptics: { pulse: vi.fn(), cancel: vi.fn() },
  steps: { reset: vi.fn() }, remoteSteps: new Map(), moves: { clear: vi.fn() },
  peers: new Map(), remotes: new Map(), mobs: { onSnap: vi.fn() }, snapClock: { stamp: (_tick: number, now: number) => now },
  teamActivity: new TeamActivity(), objectiveTiming: new ObjectiveTiming(), objectivePauses: new Set(),
  intro: { id: 0, active: false, reset: vi.fn() }, introShown: false,
  reviveHold: { stop: vi.fn(), sync: vi.fn() }, voice: { cancel: vi.fn() },
  story: { enter: vi.fn(), setAvailable: vi.fn(), setVisible: vi.fn() },
  capture: { reset: vi.fn(), update: vi.fn(), sync: vi.fn() }, renderer: { domElement: { style: {} }, render: vi.fn() },
  scene: new THREE.Scene(), body: { x: 0, y: 0, z: 0, vy: 0, grounded: true }, campus: { world: {}, setLandmarks: vi.fn() },
  jasmine: { reset: vi.fn() }, mirrorDoorBoxes: new Map(), campusVisibility: new Map(),
  loopPlayers: new Map(), warpEpochs: new Map(), seen: new Set(),
  interactionHighlight: { setGroup: vi.fn() }, refreshLevelHighlights: vi.fn(),
  buildBlackout: vi.fn(), buildDoors: vi.fn(), buildBarriers: vi.fn(), refreshDoors: vi.fn(), loadPlan: vi.fn(),
  smooth: { reset: vi.fn() }, corrC: 0, fadeUntil: 0, drawOn: true, last: 0,
}) as any;

function hud() {
  const text = new Map<string, { textContent: string }>();
  const element = () => ({ hidden: true, classList: { remove: vi.fn(), toggle: vi.fn() },
    querySelector: (selector: string) => {
      if (!text.has(selector)) text.set(selector, { textContent: '' });
      return text.get(selector)!;
    } });
  const banner = element(), panel = element();
  vi.stubGlobal('document', { hidden: false, getElementById: (id: string) => id === 'banner' ? banner : id === 'objective' ? panel : null,
    querySelector: () => null });
  return { banner, panel };
}

const target = (kind: 'pick' | 'use', id: number) => ({ kind, id, min: [0, 0, 0], max: [1, 1, 1] });
const gone = (g: ReturnType<typeof game>, ids: number[]) => g.onMsg({ t: 'snap', tick: 1, players: [], mobs: [], gone: ids });

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('local tutorial action confirmation', () => {
  it('a request, shared bag update or teammate pickup cannot complete the local pick step alone', () => {
    const g = game();
    vi.spyOn(performance, 'now').mockReturnValue(100);
    g.onMsg({ t: 'bag', bag: { stair_key: 1 } });
    gone(g, [9]);
    expect(g.tutPicked).toBe(false);
    g.interact(target('pick', 7));
    expect(g.net.send).toHaveBeenCalledWith({ t: 'act', kind: 'pick', id: 7 });
    expect(g.tutPicked).toBe(false);
    gone(g, [8]);
    expect(g.tutPicked).toBe(false);
    gone(g, [7]);
    expect(g.tutPicked).toBe(true);
    expect(g.tutPicks.size).toBe(0);
  });

  it('a later interaction and sound expiry do not lose a still-valid pickup confirmation', () => {
    const g = game(), clock = vi.spyOn(performance, 'now').mockReturnValue(100);
    g.interact(target('pick', 7));
    g.interact(target('pick', 8));
    g.interact(target('use', 3));
    clock.mockReturnValue(2500); // beyond the 1500 ms feedback window
    gone(g, [7]);
    expect(g.tutPicked).toBe(true);
    expect(g.tutPicks.has(7)).toBe(false);
    expect(g.tutPicks.has(8)).toBe(true);
    expect(g.sound.pickup).not.toHaveBeenCalled();
  });

  it('an old failed attempt does not turn a much later removal into a completed pickup', () => {
    const g = game(), clock = vi.spyOn(performance, 'now').mockReturnValue(100);
    g.interact(target('pick', 7));
    clock.mockReturnValue(5101);
    gone(g, [7]);
    expect(g.tutPicked).toBe(false);
    expect(g.tutPicks.size).toBe(0);
  });

  it('new objectives reset local action history and pending ids, with controls only in L1', () => {
    hud();
    const g = game();
    Object.assign(g, { obj: { key: '0', steps: ['目标'], cur: 0 }, idle: { reset: vi.fn() }, refreshObjective: vi.fn() });
    g.objectiveTiming.pending = false; // the opening gate has just accepted a stable frame / input
    g.tutPicks.set(7, 1000); g.tutPicked = g.tutCrouched = g.tutUsed = true;
    g.startObjective();
    expect(g.tutPicks.size).toBe(0);
    expect([g.tutPicked, g.tutCrouched, g.tutUsed]).toEqual([false, false, false]);
    expect(g.tut.start).not.toHaveBeenCalled();
    for (let now = 0; now <= 3000 + BANNER_FADE_MS; now += 100) g.tickObjective(now);
    expect(g.tut.start).toHaveBeenCalledExactlyOnceWith(3.6);
    for (const index of [1, 2, 3, 4, 5, 6, 7]) { g.level.index = index; g.startObjective(); }
    expect(g.openingTutorial).toBe(false);
    expect(g.tut.stop).toHaveBeenCalledTimes(8);
  });

  it('a same-seed wipe waits for the new own spawn before restarting the objective/tutorial', () => {
    const { banner } = hud();
    const g = game();
    Object.assign(g, {
      obj: { key: '0', steps: ['目标'], cur: 0 }, idle: { reset: vi.fn() },
      refreshObjective: (Game.prototype as any).refreshObjective, spawnCampus: vi.fn(),
      setBattery: vi.fn(), setStamina: vi.fn(), setDown: vi.fn(), setSpectate: vi.fn(),
      update: vi.fn(), drawOn: false,
    });
    g.sound.reset = vi.fn();
    const showBanner = vi.spyOn(g, 'showBanner');
    const resetTiming = vi.spyOn(g.objectiveTiming, 'reset');
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
    g.tutPicks.set(7, 1000); g.tutPicked = g.tutCrouched = true;
    let nextFrame: FrameRequestCallback;
    vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => { nextFrame = f; return 1; });
    g.start();
    g.onMsg({ t: 'fade', secs: 3, restart: true });
    expect(showBanner).not.toHaveBeenCalled();
    expect(g.loadLevel(0, 42)).toBe(false); // a roster update during fade cannot reload gameplay
    expect(resetTiming).not.toHaveBeenCalled();
    g.onMsg({ t: 'correct', p: [4, 0, 5], c: 1, forced: true });
    expect(g.loadLevel(0, 42)).toBe(true);
    expect(g.spawnSynced).toBe(false);
    expect(g.objectiveTiming.pending).toBe(true);
    expect(g.loadLevel(0, 42)).toBe(false); // an ordinary repeated room message must not re-arm the reset
    expect(resetTiming).toHaveBeenCalledOnce();
    clock.mockReturnValue(4000);
    nextFrame!(4000);
    expect(g.tut.start).not.toHaveBeenCalled();
    expect(g.objectiveTiming.pending).toBe(true);
    g.onMsg({ t: 'snap', tick: 100, players: [{ id: 1, p: [4, 0, 5], yaw: 0 }], mobs: [] });
    expect(g.spawnSynced).toBe(true);
    expect(g.spawnCampus).toHaveBeenCalledWith([4, 0, 5]);
    g.drawOn = true;
    clock.mockReturnValue(4050); nextFrame!(4050);
    expect(g.tut.start).not.toHaveBeenCalled();
    for (let now = 4150; now <= 7050; now += 100) { clock.mockReturnValue(now); nextFrame!(now); }
    expect(showBanner).toHaveBeenCalledOnce();
    expect(g.tut.start).not.toHaveBeenCalled();
    expect(banner.hidden).toBe(false);
    for (let now = 7150; now <= 10_750; now += 100) { clock.mockReturnValue(now); nextFrame!(now); }
    expect(g.tut.start).toHaveBeenCalledExactlyOnceWith(10.75);
    expect(g.tutFrom).toEqual({ x: 4, z: 5 });
    expect([g.tutPicked, g.tutCrouched]).toEqual([false, false]);
    expect(g.tutPicks.size).toBe(0);
    expect(showBanner).toHaveBeenCalledOnce();
    expect(g.loadLevel(0, 42)).toBe(false);
    expect(g.objectiveTiming.pending).toBe(false);
    expect(resetTiming).toHaveBeenCalledOnce();
  });

  it('hiding completion reflects the current authoritative place, not an earlier visit', () => {
    vi.stubGlobal('document', { body: { classList: { contains: () => false } } });
    const g = game(), h = L1.hides[0], at = [h.x, h.y ?? 0, h.z];
    g.setHiding(F_HIDE, at);
    g.tickTut(100);
    expect(g.tut.tick).toHaveBeenLastCalledWith(.1, expect.objectContaining({ hidden: true }));
    expect(g.tut.tick.mock.calls.at(-1)[1]).not.toHaveProperty('scented');
    g.setHiding(0, at);
    g.tickTut(200);
    expect(g.tut.tick).toHaveBeenLastCalledWith(.2, expect.objectContaining({ hidden: false }));
  });

  it('disabled input, an unsynced spawn, down and spectating do not consume tutorial steps', () => {
    const g = game();
    g.input.enabled = false; g.tickTut(100); g.input.enabled = true;
    for (const state of ['spawnSynced', 'down', 'spectate']) {
      const before = g[state]; g[state] = !before;
      g.tickTut(100); g[state] = before;
    }
    expect(g.tut.tick).not.toHaveBeenCalled();
  });
});
