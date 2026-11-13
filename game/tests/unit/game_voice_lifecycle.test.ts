import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Game } from '../../client/src/game.ts';
import { BroadcastView } from '../../client/src/broadcast.ts';
import type { BroadcastSnap } from '../../shared/broadcast.ts';
import { generateLevel } from '../../shared/level.ts';
import type { LineEvent } from '../../shared/protocol.ts';
import { inactiveGameCollaborators } from './game_fixture.ts';

const line: LineEvent = { t: 'event', kind: 'line', id: 'voice-lifecycle', text: '我们要找到自己的节奏', mob: 1 };

/** Exercise the real delayed message path without constructing a renderer or input devices. */
function game() {
  const voice = { say: vi.fn(), capturePlayback: vi.fn(() => 7), cancel: vi.fn(), dispose: vi.fn() };
  const monitorMurmurs = { reset: vi.fn(), dispose: vi.fn() };
  const g = Object.assign(Object.create(Game.prototype), {
    ...inactiveGameCollaborators(),
    voice, monitorMurmurs, voiceEpoch: 0, completed: false, fadeUntil: 0, feedbackDisposed: false, feedbackCleanups: [],
    level: generateLevel(0, 1), camera: { position: { x: 0, y: 1.6, z: 0 } },
    mobs: { byId: new Map([[1, { at: [3, 0, 4] }]]) },
    down: false, spectate: false, awaitingLevel: false,
    jasmine: { reset: vi.fn(), dispose: vi.fn() },
    capture: { reset: vi.fn(), update: vi.fn(() => ({ phase: 'idle', caught: false })), dispose: vi.fn() },
    renderer: { domElement: { style: {} } },
    sound: { reset: vi.fn(), transition: vi.fn(), dispose: vi.fn() },
    haptics: { cancel: vi.fn(), dispose: vi.fn() }, feedbackSettings: { dispose: vi.fn() },
    steps: { reset: vi.fn() }, remoteSteps: new Map(), moves: { clear: vi.fn() },
    input: { clear: vi.fn(), enabled: true },
    body: { x: 0, y: 0, z: 0 }, scene: { add: vi.fn(), remove: vi.fn() },
    campus: { outFloor: null, world: {}, setLandmarks: vi.fn() }, campusVisibility: new Map(), mirrorDoorBoxes: new Map(),
    loopPlayers: new Map(), warpEpochs: new Map(), seen: new Set(), drawOn: false,
    buildBlackout: vi.fn(), buildDoors: vi.fn(), buildBarriers: vi.fn(), refreshDoors: vi.fn(), loadPlan: vi.fn(), refreshObjective: vi.fn(),
  }) as Game;
  return { g, voice, monitorMurmurs };
}

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('document', { getElementById: () => null }); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

/** Keep the real broadcast receive/dispose path, without constructing its 3D props or DOM. */
function broadcastView(voice: ReturnType<typeof game>['voice']) {
  return Object.assign(Object.create(BroadcastView.prototype), {
    voice, state: { call: null }, stickers: [], screen: { userData: {} }, opened: false,
    panel: { textContent: '', classList: { toggle: vi.fn() }, remove: vi.fn() }, dialog: { remove: vi.fn() },
    lamp: { material: { color: { set: vi.fn() } } }, marker: { position: { set: vi.fn() } },
    scene: { remove: vi.fn() }, root: { traverse: vi.fn() },
  }) as BroadcastView;
}

describe('delayed game dialogue lifecycle', () => {
  it('waits 300 ms, then uses the latest mob position and the playback eligibility captured on receipt', () => {
    const { g, voice } = game();
    g.onMsg(line);
    expect(voice.capturePlayback).toHaveBeenCalledTimes(1);
    expect(voice.say).not.toHaveBeenCalled();
    vi.advanceTimersByTime(299);
    expect(voice.say).not.toHaveBeenCalled();
    g.mobs.byId.get(1)!.at = [6, 0, 8];
    voice.capturePlayback.mockReturnValue(8);
    vi.advanceTimersByTime(1);
    expect(voice.say).toHaveBeenCalledExactlyOnceWith(line.text, 10, 7);
    vi.advanceTimersByTime(1000);
    expect(voice.say).toHaveBeenCalledTimes(1);
  });

  it.each(['fade', 'complete', 'dispose', 'load'] as const)('%s drops every pending line before it can restore old captions or audio', (boundary) => {
    const { g, voice, monitorMurmurs } = game();
    g.onMsg(line);
    vi.advanceTimersByTime(100);
    g.onMsg({ ...line, id: 'second-pending-line', text: '你缺乏青春舒展的姿态' });
    if (boundary === 'fade') g.onMsg({ t: 'fade', secs: 0.05, restart: false });
    else if (boundary === 'complete') g.onMsg({ t: 'complete', level: 0 });
    else if (boundary === 'dispose') g.disposeFeedback();
    else g.loadLevel(0, 2);
    vi.advanceTimersByTime(1000);
    expect(voice.say).not.toHaveBeenCalled();
    expect(boundary === 'dispose' ? monitorMurmurs.dispose : monitorMurmurs.reset).toHaveBeenCalledOnce();

    // A finished transition and a new room must still accept their own fresh dialogue.
    if (boundary === 'fade' || boundary === 'load') {
      if (boundary === 'fade') {
        g.onMsg({ ...line, id: 'handoff-line' });
        vi.advanceTimersByTime(300);
        expect(voice.say).not.toHaveBeenCalled(); // elapsed black screen still waits for its authoritative room
        g.loadLevel(0, 2);
      }
      g.onMsg({ ...line, id: 'fresh-line', text: '粗疏' });
      vi.advanceTimersByTime(300);
      expect(voice.say).toHaveBeenCalledExactlyOnceWith('粗疏', 5, 7);
    }
  });
});

describe('broadcast dialogue uses game-owned feedback', () => {
  const call: BroadcastSnap = { t: 'broadcast', off: false, clues: [null, null, null, null], nextIn: 60,
    call: { id: 1, left: 10, shielded: false } };

  it.each(['fade', 'complete', 'dispose'] as const)('%s silences broadcasts while still applying station state updates', (boundary) => {
    const { g, voice } = game();
    g.names = new Map([[1, '甲'], [2, '乙']]);
    const view = g.broadcastView = broadcastView(voice);
    g.onMsg(call);
    expect(voice.say).toHaveBeenCalledExactlyOnceWith('午夜点名，甲同学。你的位置正在广播。', 0);
    voice.say.mockClear();

    if (boundary === 'fade') g.onMsg({ t: 'fade', secs: 3, restart: false });
    else if (boundary === 'complete') g.onMsg({ t: 'complete', level: 3 });
    else g.disposeFeedback();
    expect(boundary === 'dispose' ? voice.dispose : voice.cancel).toHaveBeenCalledOnce();
    g.onMsg({ ...call, call: { id: 2, left: 8, shielded: false } });
    g.onMsg({ ...call, call: { id: 2, left: 7, shielded: true } });
    expect(view.state.call).toEqual({ id: 2, left: 7, shielded: true });
    expect(voice.say).not.toHaveBeenCalled();
  });

  it('leaves the shared voice available when disposing the old station on a level change', () => {
    const { voice } = game();
    broadcastView(voice).dispose();
    expect(voice.dispose).not.toHaveBeenCalled();
  });
});
