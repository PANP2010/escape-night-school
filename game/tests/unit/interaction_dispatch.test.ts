import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Game } from '../../client/src/game.ts';
import { Input } from '../../client/src/input.ts';
import { TICK_MS } from '../../shared/constants.ts';
import { ST_DOWN } from '../../shared/protocol.ts';
import { REVIVE_REFRESH_MS, ReviveHold } from '../../client/src/reviveHold.ts';
import { inactiveGameCollaborators } from './game_fixture.ts';
import * as THREE from 'three';

const door = { kind: 'use', id: 1, min: [0, 0, 0], max: [1, 2, 1] };
let now = 1000;
const holds: ReviveHold[] = [];
const fixture = () => {
  const input = new Input({ addEventListener() {} } as unknown as HTMLElement);
  const g = Object.assign(Object.create(Game.prototype), {
    ...inactiveGameCollaborators(),
    input, net: { send: vi.fn(() => true), sendNow: vi.fn(() => true) }, target: vi.fn(() => door),
    spawnSynced: true, fadeUntil: 0, completed: false, down: false, spectate: false,
    feedbackDisposed: false, hiding: -1, regionLocked: () => false, doorOpen: [],
    promptEl: { textContent: '' }, haptics: { pulse: vi.fn() }, sound: { door: vi.fn() },
    myId: 1, body: { x: 0, y: 0, z: 0 }, eye: 1.55,
    peers: new Map([[2, { p: [1, 0, 0], yaw: 0, st: ST_DOWN, online: true }]]),
  }) as any;
  g.reviveHold = new ReviveHold({ target: () => g.heldReviveTarget(), now: () => now,
    send: id => g.net.sendNow({ t: 'act', kind: 'revive', id }),
    cancel: id => { g.net.sendNow({ t: 'act', kind: 'revive_cancel', id }); } });
  holds.push(g.reviveHold);
  input.onInteract = () => g.interactPressed(now);
  input.onChange = () => g.reviveHold.sync();
  return g;
};
beforeEach(() => {
  now = 1000;
  vi.useFakeTimers();
  vi.stubGlobal('addEventListener', vi.fn());
  vi.stubGlobal('document', Object.assign(new EventTarget(), { body: { classList: { contains: () => false } }, getElementById: () => null }));
  vi.spyOn(performance, 'now').mockImplementation(() => now);
});
afterEach(() => { for (const hold of holds.splice(0)) hold.dispose(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('interaction dispatch without a rendered frame', () => {
  it('picks a visible locker directly and requests its real hide id without predicting entry', () => {
    const g = fixture();
    g.camera = new THREE.PerspectiveCamera(75, 1, .1, 30);
    g.camera.position.set(0, 1.55, 0);
    g.renderer = { domElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 200 }) } };
    g.level = { index: 3, exit: { y: 0 }, def: { hides: [{ kind: 'locker', x: 0, y: 0, z: -1 }], barriers: [] } };
    g.items = []; g.blackoutObjs = []; g.peers = new Map(); g.pos = { x: 0, z: 0 };
    g.input.yaw = .4;
    const hit = g.touchTarget(100, 100);
    expect(hit?.target).toMatchObject({ kind: 'hide', id: 0 });
    g.interact(hit.target);
    expect(g.net.send).toHaveBeenCalledExactlyOnceWith({ t: 'act', kind: 'hide', id: 0 });
    expect(g.hideYaw).toBeCloseTo(.4 + Math.PI, 12);
    expect(g.hiding).toBe(-1);
    g.net.send.mockClear(); g.pos.z = 1; g.toast = vi.fn();
    g.interact(hit.target);
    expect(g.net.send).not.toHaveBeenCalled();
    expect(g.toast).toHaveBeenCalledWith('再靠近一点');
  });
  it('sends on press, consumes the edge once and displays a pending request without predicting success', () => {
    const g = fixture();
    g.input.press('KeyE');
    expect(g.net.send).toHaveBeenCalledExactlyOnceWith({ t: 'act', kind: 'use', id: 1 });
    expect(g.input.consume('KeyE')).toBe(false);
    expect(g.input.down('KeyE')).toBe(true);
    expect(g.promptEl.textContent).toBe('请求已发出，等待确认…');
    expect(g.doorOpen[1]).toBeUndefined();
    expect(g.sound.door).not.toHaveBeenCalled();
    expect(g.haptics.pulse).not.toHaveBeenCalled();
    g.input.press('KeyE');
    g.input.release('KeyE'); g.input.press('KeyE');
    expect(g.net.send).toHaveBeenCalledTimes(1);
    now += 1501; g.input.release('KeyE'); g.input.press('KeyE');
    expect(g.net.send).toHaveBeenCalledTimes(2);
  });

  it.each([
    { completed: true }, { down: true }, { spectate: true }, { spawnSynced: false },
    { fadeUntil: 2000 }, { feedbackDisposed: true }, { awaitingLevel: true },
  ])('discards interaction edges while unavailable: %j', (state) => {
    const g = Object.assign(fixture(), state);
    g.input.press('KeyE');
    expect(g.net.send).not.toHaveBeenCalled();
    expect(g.input.consume('KeyE')).toBe(false);
  });

  it('discards a disabled edge and starts a fresh interaction after re-enabling', () => {
    const g = fixture(); g.input.enabled = false; g.input.press('KeyE');
    expect(g.net.send).not.toHaveBeenCalled();
    g.input.enabled = true; expect(g.input.consume('KeyE')).toBe(false);
    g.input.release('KeyE'); g.input.press('KeyE'); expect(g.net.send).toHaveBeenCalledTimes(1);
  });

  it('starts rescue immediately, retains the held key and requires subsequent hold refreshes', () => {
    const g = fixture(), target = { ...door, kind: 'revive', id: 2 };
    g.target.mockReturnValue(target); g.input.press('KeyE');
    expect(g.net.sendNow).toHaveBeenCalledExactlyOnceWith({ t: 'act', kind: 'revive', id: 2 });
    expect(g.net.send).not.toHaveBeenCalled();
    expect(g.input.down('KeyE')).toBe(true);
    expect(g.input.held('KeyE')).toBe(true);
    expect(g.input.consume('KeyE')).toBe(false);
    now += TICK_MS; g.tickRevive(now);
    expect(g.net.sendNow).toHaveBeenCalledTimes(1);
    now += REVIVE_REFRESH_MS - TICK_MS; vi.advanceTimersByTime(REVIVE_REFRESH_MS);
    expect(g.net.sendNow).toHaveBeenNthCalledWith(2, { t: 'act', kind: 'revive', id: 2 });
    g.input.release('KeyE'); g.input.endFrame();
    expect(g.net.sendNow).toHaveBeenNthCalledWith(3, { t: 'act', kind: 'revive_cancel', id: 2 });
    vi.advanceTimersByTime(3 * REVIVE_REFRESH_MS); g.tickRevive(now);
    expect(g.net.sendNow).toHaveBeenCalledTimes(3);
    expect(g.reviveHold.id).toBeNull();
  });
});
