import { describe, expect, it } from 'vitest';
import { IntroSession } from '../../server/intro.ts';
import { INTRO_S } from '../../shared/intro.ts';
import { parseClientMsg, type Vec3 } from '../../shared/protocol.ts';

const route: Vec3[] = [[0, 0, 0], [8, 0, 0]];

describe('intro voting and deadline', () => {
  it('keeps an eight-second deadline while each participant skips independently', () => {
    const intro = new IntroSession(7, 2, 1000, [11, 12], route, [16, 0, 0]);
    expect(intro.endsAt).toBe(1000 + INTRO_S * 1000);
    expect(intro.skip(11, 6, 1200)).toBe(false);
    expect(intro.skip(99, 7, 1200)).toBe(false); // a late observer has no vote
    expect(intro.skip(11, 7, 1500)).toBe(true);
    expect(intro.ended).toBe(false);
    expect(intro.skip(11, 7, 1600)).toBe(false);
    expect(intro.event(1800)).toEqual({
      t: 'event', kind: 'intro', id: 7, level: 2, startedAt: 1000, endsAt: 9000,
      now: 1800, skipped: [11], ended: false, route, silhouette: [16, 0, 0],
    });
    expect(intro.skip(12, 7, 2000)).toBe(true);
    expect(intro.ended).toBe(true);
    expect(intro.skip(12, 7, 2100)).toBe(false);
    expect(intro.expire(10_000)).toBe(false);
  });

  it('expires at the fixed deadline even if nobody skips', () => {
    const intro = new IntroSession(1, 0, 500, [1, 2], route);
    expect(intro.expire(8499)).toBe(false);
    expect(intro.event(8499)).toMatchObject({ startedAt: 500, endsAt: 8500, ended: false });
    expect(intro.expire(8500)).toBe(true);
    expect(intro.event(8500)).toMatchObject({ ended: true, skipped: [] });
    expect(intro.expire(9000)).toBe(false);
    const skippedAtDeadline = new IntroSession(2, 0, 500, [1], route);
    expect(skippedAtDeadline.skip(1, 2, 8500)).toBe(true);
    expect(skippedAtDeadline.event(8500)).toMatchObject({ ended: true, skipped: [] });
  });

  it('disconnects only remove votes and never move the deadline', () => {
    const intro = new IntroSession(3, 0, 0, [1, 2, 3], route);
    intro.skip(1, 3, 100);
    expect(intro.leave(99)).toBe(false);
    expect(intro.leave(2)).toBe(true);
    expect(intro.ended).toBe(false);
    expect(intro.endsAt).toBe(8000);
    expect(intro.leave(3)).toBe(true);
    expect(intro.ended).toBe(true);
    expect(intro.leave(1)).toBe(false);
    const empty = new IntroSession(4, 0, 0, [], route);
    expect(empty.ended).toBe(true);
  });
});

describe('intro skip protocol', () => {
  it('accepts a positive safe epoch and rejects missing, stale-shape or unsafe values', () => {
    expect(parseClientMsg('{"t":"intro-skip","id":3}')).toEqual({ t: 'intro-skip', id: 3 });
    for (const id of [undefined, null, 0, -1, 1.5, '3', Number.MAX_SAFE_INTEGER + 1]) {
      expect(parseClientMsg(JSON.stringify({ t: 'intro-skip', id }))).toBeNull();
    }
  });
});
