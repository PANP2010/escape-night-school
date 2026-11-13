import { afterEach, describe, expect, it, vi } from 'vitest';
import { Game } from '../../client/src/game.ts';
import { captureTitle } from '../../shared/studentNames.ts';
import type { ServerMsg } from '../../shared/protocol.ts';

type Caught = Extract<ServerMsg, { t: 'caught' }>;
interface CaptureClient {
  onMsg: Game['onMsg'];
  setDown(down: boolean): void;
  down: boolean;
  capture: { begin: ReturnType<typeof vi.fn> };
  sound: { capture: ReturnType<typeof vi.fn> };
}

const caught = (by: Caught['by'], seq = 1): Caught => ({
  t: 'caught', id: 1, seq, tick: 10, by, hold: 30, at: [0, 0, 0], source: [1, 0, 0], ...(by === 'monitor' ? { name: '角色047', mob: 3 } : {}),
});

function fixture() {
  const title = { textContent: '你被角色074抓住了' };
  vi.stubGlobal('document', {
    querySelector: (selector: string) => selector === '#down-overlay .t' ? title : null,
    getElementById: () => ({ hidden: false }),
  });
  const game = Object.assign(Object.create(Game.prototype), {
    myId: 1, lastCaptureSeq: 0, lastSnapTick: 0, spawnSynced: true,
    down: false, spectate: false, awaitingLevel: false, completed: false, fadeUntil: 0,
    input: { yaw: 0, pitch: 0, clear: vi.fn() }, moves: { clear: vi.fn() },
    capture: { begin: vi.fn(() => true) }, steps: { reset: vi.fn() },
    reviveHold: { stop: vi.fn() },
    haptics: { pulse: vi.fn() }, sound: { tone: vi.fn(), capture: vi.fn() },
  }) as CaptureClient;
  return { game, title };
}

afterEach(() => vi.unstubAllGlobals());

describe('capture penalty title routing', () => {
  it.each(['warden', 'monitor'] as const)('names the accepted %s source and keeps it on repeated down state', (by) => {
    const { game, title } = fixture();
    game.onMsg(caught(by));
    expect(game.down).toBe(true);
    expect(title.textContent).toBe(captureTitle(caught(by)));
    game.setDown(true);
    game.onMsg(caught(by === 'monitor' ? 'warden' : 'monitor'));
    expect(title.textContent).toBe(captureTitle(caught(by)));
    expect(game.sound.capture).toHaveBeenCalledOnce();
  });

  it('resets a later state-only down to neutral instead of retaining the last source', () => {
    const { game, title } = fixture();
    game.onMsg(caught('monitor'));
    game.setDown(false);
    game.setDown(true);
    expect(title.textContent).toBe('你被抓住了');
  });

  it('does not change the title for a rejected capture', () => {
    const { game, title } = fixture();
    game.capture.begin.mockReturnValue(false);
    game.onMsg(caught('monitor'));
    expect(game.down).toBe(false);
    expect(game.sound.capture).not.toHaveBeenCalled();
    expect(title.textContent).toBe('你被角色074抓住了');
  });
});
