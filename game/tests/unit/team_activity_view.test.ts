import { describe, expect, it } from 'vitest';
import { F_CROUCH, F_HIDE, F_RUN, ST_DOWN, ST_SPECTATE, type PlayerSnap } from '../../shared/protocol.ts';
import { TEAM_ACTIVITY_MS, TeamActivity } from '../../client/src/teamActivity.ts';

const player = (x = 0, f?: number, st?: number): PlayerSnap => ({ id: 1, p: [x, 0, 0], yaw: 0, ...(f === undefined ? {} : { f }), ...(st === undefined ? {} : { st }) });

describe('team activity presentation', () => {
  it('starts idle and never treats being alive, a run flag or a stationary snapshot as movement', () => {
    const view = new TeamActivity();
    view.observe([player(0, F_RUN)], 1, 0);
    expect(view.status(1, 0)).toBe('暂未行动');
    view.observe([player(0)], 2, 50);
    expect(view.status(1, 50)).toBe('暂未行动');
    view.observe([player(0.01)], 3, 100); // snapshot rounding / a tiny correction
    expect(view.status(1, 100)).toBe('暂未行动');
  });

  it('uses actual authoritative displacement and remembers delta flags, then expires movement by current time', () => {
    const view = new TeamActivity();
    view.observe([player(0, 0)], 1, 0);
    view.observe([player(0.15)], 2, 50);
    expect(view.status(1, 50)).toBe('移动中');
    view.observe([player(0.2, F_CROUCH)], 3, 100);
    view.observe([player(0.25)], 4, 150);
    expect(view.status(1, 150)).toBe('蹲行中');
    expect(view.status(1, 1000)).toBe('蹲伏中');
    view.observe([player(0.25, 0)], 5, 1050);
    expect(view.status(1, 1050)).toBe('暂未行动');
  });

  it('expires success text while the panel is closed or a page has been in the background', () => {
    const view = new TeamActivity();
    view.observe([player()], 1, 0);
    view.record({ t: 'activity', from: 1, kind: 'open' }, 100);
    expect(view.status(1, 100 + TEAM_ACTIVITY_MS - 1)).toBe('刚开门');
    expect(view.status(1, 100 + TEAM_ACTIVITY_MS)).toBe('暂未行动');
    view.record({ t: 'activity', from: 1, kind: 'pick', item: 'fuse' }, 6000);
    view.observe([player(0.1, F_CROUCH)], 2, 10_990);
    expect(view.status(1, 11_000)).toBe('蹲行中');
    view.record({ t: 'activity', from: 1, kind: 'close' }, 12_000);
    expect(view.status(1, 12_000)).toBe('刚关门');
    expect(view.status(1, 120_000)).toBe('蹲伏中');
  });

  it('shows confirmed pickup and completed rescue, with hiding / down / out taking precedence', () => {
    const view = new TeamActivity();
    view.observe([player()], 1, 0);
    view.record({ t: 'activity', from: 1, kind: 'pick', item: 'battery' }, 0);
    expect(view.status(1, 0)).toBe('刚拾取电池');
    view.record({ t: 'activity', from: 1, kind: 'revive' }, 1);
    expect(view.status(1, 1)).toBe('刚扶起队友');
    view.observe([player(0, F_HIDE)], 2, 50);
    expect(view.hidden(1)).toBe(true);
    expect(view.status(1, 50)).toBe('躲藏中');
    view.observe([player(0, 0, ST_DOWN)], 3, 100);
    expect(view.status(1, 100)).toBe('倒地待救');
    view.observe([player(0, 0, ST_SPECTATE)], 4, 150);
    expect(view.status(1, 150)).toBe('已出局');
  });

  it('does not turn a large teleport, a forced relocation or the first snapshot into movement', () => {
    const view = new TeamActivity();
    view.observe([player(100)], 1, 0);
    expect(view.status(1, 0)).toBe('暂未行动');
    view.observe([player(200)], 2, 50);
    expect(view.status(1, 50)).toBe('暂未行动');
    view.relocate(1);
    view.observe([player(200.1)], 3, 100);
    expect(view.status(1, 100)).toBe('暂未行动');
    view.observe([player(200.2)], 4, 150);
    expect(view.status(1, 150)).toBe('移动中');
  });

  it('does not count entering or leaving a hiding place as walking, or retain movement across it', () => {
    const view = new TeamActivity();
    view.observe([player(0, 0)], 1, 0);
    view.observe([player(0.1)], 2, 50);
    expect(view.status(1, 50)).toBe('移动中');
    // A nearby locker pins the player, then returns them to the entry point. Both are server moves.
    view.observe([player(0.2, F_HIDE)], 3, 100);
    expect(view.status(1, 100)).toBe('躲藏中');
    view.observe([player(0.1, 0)], 4, 150);
    expect(view.status(1, 150)).toBe('暂未行动');
    view.observe([player(0.2)], 5, 200);
    expect(view.status(1, 200)).toBe('移动中');
  });

  it('does not carry movement through being downed and revived at the same spot', () => {
    const view = new TeamActivity();
    view.observe([player(0, 0)], 1, 0);
    view.observe([player(0.1)], 2, 50);
    view.observe([player(0.1, 0, ST_DOWN)], 3, 100);
    expect(view.status(1, 100)).toBe('倒地待救');
    view.observe([player(0.1)], 4, 150);
    expect(view.status(1, 150)).toBe('暂未行动');
    view.observe([player(0.2)], 5, 200);
    expect(view.status(1, 200)).toBe('移动中');
  });

  it('drops old activity on departure and level changes', () => {
    const view = new TeamActivity();
    view.observe([player(0, F_HIDE)], 1, 0);
    view.record({ t: 'activity', from: 1, kind: 'open' }, 0);
    view.observe([], 2, 50);
    expect(view.status(1, 50)).toBe('暂未行动');
    expect(view.hidden(1)).toBe(false);
    view.observe([player()], 3, 100);
    view.record({ t: 'activity', from: 1, kind: 'open' }, 100);
    view.clear();
    expect(view.status(1, 101)).toBe('暂未行动');
  });
});
