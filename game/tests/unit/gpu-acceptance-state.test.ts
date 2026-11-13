import { afterEach, expect, test, vi } from 'vitest';
import { generateLevel } from '../../shared/level.ts';
import { gpuOpeningReady } from '../gpu-acceptance-state.mjs';

afterEach(() => vi.unstubAllGlobals());

function readyGame(overrides: Record<string, unknown> = {}) {
  const game = { level: generateLevel(0, 42), presentationReady: true, spawnSynced: true,
    intro: { active: false }, snaps: 6, ...overrides };
  vi.stubGlobal('window', { __escape: { game: () => game } });
  return game;
}

test('L1 uses actual zero-based campaign level data, while L2 cannot start the opening sample', () => {
  const game = readyGame();
  expect(gpuOpeningReady()).toBe(true);
  game.level = generateLevel(1, 42);
  expect(gpuOpeningReady()).toBe(false);
});

test.each([
  { presentationReady: false }, { spawnSynced: false }, { intro: { active: true } }, { snaps: 5 },
])('the FPS sample waits until authoritative presentation and intro are complete: %j', (state) => {
  readyGame(state);
  expect(gpuOpeningReady()).toBe(false);
});

test('the readiness poll tolerates the browser before game publication', () => {
  vi.stubGlobal('window', {});
  expect(gpuOpeningReady()).toBe(false);
});
