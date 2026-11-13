import { describe, expect, it } from 'vitest';
import { DIFFICULTY_MODES, difficultyMode, isDifficultyId } from '../../shared/difficultyModes.ts';
import { parseClientMsg } from '../../shared/protocol.ts';

describe('campaign difficulty modes', () => {
  it('orders four modes and keeps older clients at standard intensity', () => {
    expect(DIFFICULTY_MODES.map(m => m.id)).toEqual(['story', 'standard', 'challenge', 'nightmare']);
    expect(difficultyMode(undefined).id).toBe('standard');
    expect(difficultyMode('unknown').id).toBe('standard');
    expect(DIFFICULTY_MODES.map(m => m.monsterSpeed)).toEqual([.8, 1, 1.12, 1.22]);
    expect(DIFFICULTY_MODES.every((m, i, all) => !i || m.bossWindup < all[i - 1].bossWindup)).toBe(true);
  });
  it('accepts valid create/quick modes and rejects forged values', () => {
    for (const mode of DIFFICULTY_MODES) {
      expect(isDifficultyId(mode.id)).toBe(true);
      expect(parseClientMsg(JSON.stringify({ t: 'create', difficulty: mode.id }))).toMatchObject({ t: 'create', difficulty: mode.id });
      expect(parseClientMsg(JSON.stringify({ t: 'quick', difficulty: mode.id }))).toMatchObject({ t: 'quick', difficulty: mode.id });
    }
    expect(parseClientMsg(JSON.stringify({ t: 'create', difficulty: 'cheat' }))).toBeNull();
    expect(parseClientMsg(JSON.stringify({ t: 'quick', difficulty: 5 }))).toBeNull();
  });
});
