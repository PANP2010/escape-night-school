import { LEVELS } from '../../shared/level.ts';

/** Exercise the no-successor fallback without treating an intermediate release chapter as the real ending. */
export function withCampaignEndingAt(index: number, run: () => void): void {
  const registered = [...LEVELS];
  try {
    LEVELS.splice(index + 1);
    run();
  } finally {
    LEVELS.splice(0, LEVELS.length, ...registered);
  }
}
