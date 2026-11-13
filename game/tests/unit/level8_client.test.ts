import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { advanceFinaleRoute, completionText, finaleGoalPoint, finaleObjective, finaleStatusText, formatClock } from '../../client/src/finale.ts';
import { L8 } from '../../shared/levels/l8.ts';
import type { FinaleState } from '../../shared/protocol.ts';

const ctx2d: any = new Proxy(function () {}, { get: (_, k) => k === 'measureText' ? () => ({ width: 1 }) : ctx2d, apply: () => ctx2d, set: () => true });
vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }) });
const { Mobs } = await import('../../client/src/mobs.ts');

const state = (extra: Partial<FinaleState> = {}): FinaleState => ({
  t: 'finale', revision: 3, phase: 'rollcall', elapsedMs: 3000, downs: 1,
  members: [{ id: 1, name: '学生甲', crossedOut: true, status: 'playing', downs: 1 }, { id: 2, name: '学生乙', crossedOut: false, status: 'left', downs: 0 }], ...extra,
});

describe('L8 visible objectives and ending', () => {
  it('shows only required names in the progress total and distinguishes pursuit from team extraction', () => {
    expect(finaleObjective(state()).got).toBe('已划名：1/1');
    expect(finaleStatusText(state())).toBe('划掉全队名字 · 1/1');
    expect(finaleStatusText(state({ phase: 'chase', remainingMs: 180000 }))).toContain('追击剩余 03:00');
    expect(finaleStatusText(state({ phase: 'chase', remainingMs: 10000, rescueMs: 45000 }))).toContain('队伍撤离剩余 00:45');
    expect(finaleObjective(state({ phase: 'chase', remainingMs: 10000, rescueMs: 45000 })).got).toContain('撤离剩余 00:45');
    expect(finaleObjective(state({ phase: 'chase' })).cur).toBe(1);
  });

  it('keeps clocks readable through long runs and presents authoritative per-member results', () => {
    expect(formatClock(-100)).toBe('00:00');
    expect(formatClock(65000)).toBe('01:05');
    expect(formatClock(3661000)).toBe('1:01:01');
    expect(completionText({ t: 'completed', elapsedMs: 65000, downs: 2, members: [{ id: 1, name: '<队员>', downs: 2, escaped: true }, { id: 2, name: '队员乙', downs: 0, escaped: false }] })).toEqual({
      time: '01:05', downs: 2, members: [{ id: 1, name: '<队员>', downs: 2, escaped: true, result: '已逃出' }, { id: 2, name: '队员乙', downs: 0, escaped: false, result: '未逃出' }],
    });
  });

  it('does not skip a narrow route corner while the player is still more than one metre away', () => {
    const route = L8.finale!.route;
    expect(advanceFinaleRoute(route, { x: -14, y: 0, z: 90.1 }, 6)).toBe(6);
    expect(advanceFinaleRoute(route, { x: -14, y: 0, z: 88.7 }, 6)).toBe(7);
    expect(finaleGoalPoint('rollcall', L8.finale!)).toEqual(L8.finale!.rollcall);
    expect(finaleGoalPoint('complete', L8.finale!)).toBeNull();
  });

  it.each(['perfect', 'finale'])('uses the existing skeletal teacher for the 2.3 m %s form and updates its pose on 0.3 second steps', (form) => {
    const mobs = new Mobs(new THREE.Scene());
    mobs.onSnap([{ id: 1, kind: 'warden', anim: 'chase', form: 'normal', p: [0, 0, 0], yaw: 0 }], 0);
    const m = mobs.byId.get(1)!;
    const baseScale = m.warden.mesh.scale.clone();
    mobs.onSnap([{ id: 1, kind: 'warden', form, anim: 'chase', p: [0, 0, 0], yaw: 0 }], 0);
    expect(m.mesh.scale.toArray()).toEqual([1, 1, 1]);
    const box = m.warden.mesh.geometry.boundingBox!;
    expect((box.max.y - box.min.y) * m.warden.mesh.scale.y).toBeCloseTo(2.3, 8);
    expect(m.forms!.form).toBe('finale');
    const spy = vi.spyOn(m.warden, 'update');
    for (let i = 1; i <= 2; i++) mobs.update(i * 100, 0.1);
    expect(spy).not.toHaveBeenCalled();
    mobs.update(300, 0.1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBeCloseTo(0.3);
    expect(spy.mock.calls[0][2]).toBe('chase');
    mobs.onSnap([{ id: 1, form: 'normal', p: [0, 0, 0], yaw: 0 }], 350);
    expect(m.warden.mesh.scale.toArray()).toEqual(baseScale.toArray());
    mobs.update(400, 0.1);
    expect(spy).toHaveBeenCalledTimes(2);
    mobs.onSnap([], 450);
  });
});
