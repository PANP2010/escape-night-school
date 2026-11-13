import { expect, test } from 'vitest';
import { gateStorageState } from '../gate-settings.ts';
import { gamePreferencesFrom } from '../../client/src/settings.ts';

test('gate storage selects existing low settings without a room or resume identity', () => {
  const state = gateStorageState('http://127.0.0.1:4199/?nodraw');
  expect(state).toEqual({
    cookies: [],
    origins: [{
      origin: 'http://127.0.0.1:4199',
      localStorage: [{ name: 'escape.settings', value: JSON.stringify({ pixelRatio: 1, postprocessing: false }) }],
    }],
  });
  const saved = typeof state === 'object' ? state.origins[0].localStorage[0].value : '';
  expect(gamePreferencesFrom(JSON.parse(saved))).toEqual({
    pixelRatio: 1, postprocessing: false, sensitivity: 1, interactionHighlights: true,
  });
});
