import { describe, expect, it } from 'vitest';
import { bannerFor, IDLE_HINT_S, IdleHint, objective, panelFor } from '../../client/src/objective.ts';
import { LEVELS } from '../../shared/level.ts';

const [L1, L2, L3, L4] = LEVELS;

describe('objective steps', () => {
  it('L1: drawer key → locked lectern drawer → everyone to the stairwell', () => {
    const o0 = objective(L1, {}, 0);
    expect(o0.steps).toEqual(['找到抽屉钥匙', '打开上锁讲台抽屉，取出楼梯钥匙', '所有人到西南角楼梯间集合']);
    expect(o0.cur).toBe(0);
    expect(panelFor(o0)).toEqual({ head: '目标 1/3', goal: '找到抽屉钥匙', got: '已收集：抽屉钥匙 0/1 · 楼梯钥匙 0/1' });
    expect(bannerFor(L1, o0)).toEqual({ title: '一楼·晚自习后', goal: '找到抽屉钥匙' });
    expect(o0.note).toMatch(/铜牌.*有齿.*真钥匙.*无齿.*戏剧道具/);
    // Ordinary door keys and batteries never skip the locked drawer.
    expect(objective(L1, { door_key: 2, battery: 1 }, 0).key).toBe(o0.key);
    const o1 = objective(L1, { drawer_key: 1 }, 0);
    expect(o1.cur).toBe(1);
    expect(o1.key).not.toBe(o0.key);
    expect(panelFor(o1)).toEqual({ head: '目标 2/3', goal: o0.steps[1], got: '已收集：抽屉钥匙 1/1 · 楼梯钥匙 0/1' });
    const o2 = objective(L1, { drawer_key: 1, stair_key: 1, door_key: 1 }, 0);
    expect(o2.cur).toBe(2);
    expect(o2.key).not.toBe(o1.key);
    expect(panelFor(o2)).toEqual({ head: '目标 3/3', goal: '所有人到西南角楼梯间集合', got: '已收集：抽屉钥匙 1/1 · 楼梯钥匙 1/1' });
  });

  it('L2: find 3 fuses → put them in the box → everyone to the exit', () => {
    const at = (fuse: number, fusesIn: number) => objective(L2, { fuse }, fusesIn);
    expect(at(0, 0).steps).toEqual(['找齐保险丝 0/3', '把保险丝插进走廊配电箱 0/3', '所有人到西头连廊门口集合']);
    expect([at(0, 0), at(1, 0), at(2, 0)].map((o) => [o.cur, o.got])).toEqual([[0, '包里 0 · 已插 0/3'], [0, '包里 1 · 已插 0/3'], [0, '包里 2 · 已插 0/3']]);
    // fuses already in the box count as found: 2 in + 1 carried = all found, step 2
    expect(at(1, 2)).toMatchObject({ cur: 1, got: '包里 1 · 已插 2/3' });
    expect(panelFor(at(1, 2))).toEqual({ head: '目标 2/3', goal: '把保险丝插进走廊配电箱 2/3', got: '保险丝：包里 1 · 已插 2/3' });
    expect(at(3, 0).cur).toBe(1);
    expect(panelFor(at(0, 3))).toMatchObject({ head: '目标 3/3', goal: '所有人到西头连廊门口集合' });
    // inserting one (bag -1, box +1) is progress even though "found" stays the same
    expect(at(2, 1).key).not.toBe(at(3, 0).key);
    // fewer found than needed with some already in: still finding
    expect(at(0, 1)).toMatchObject({ cur: 0, got: '包里 0 · 已插 1/3' });
  });

  it('L2 distinguishes the shared bag from installed fuses through every installation', () => {
    for (let installed = 0; installed <= 3; installed++) {
      const o = objective(L2, { fuse: 3 - installed }, installed);
      expect(panelFor(o).got).toBe(`保险丝：包里 ${3 - installed} · 已插 ${installed}/3`);
      expect(o.cur).toBe(installed === 3 ? 2 : 1);
      if (installed < 3) expect(o.hints.join(' ')).toContain('包里剩下');
    }
  });

  it('keeps L3 personal progress and L4 team clues labelled for their own puzzles', () => {
    const loop = objective(L3, { fuse: 3 }, 2, { step: 1, loops: 2, mistakes: 0 });
    expect(panelFor(loop)).toMatchObject({ head: '目标 1/2', got: '个人进度：门序 1/4 · 回环 2 次' });
    expect(panelFor(objective(L4, {}, 0))).toEqual({ head: '目标 1/3', goal: '阅读三、四楼编号贴纸 0/4', got: '已收集：贴纸 0/4 · □ □ □ □' });
    const state = { t: 'broadcast' as const, clues: ['1', '2', '3', '4'], off: false, nextIn: 50, call: null };
    expect(panelFor(objective(L4, { fuse: 3 }, 2, state))).toEqual({ head: '目标 2/3', goal: '到四楼广播室按编号输入密码，关闭广播', got: '已收集：贴纸 4/4 · 1 2 3 4' });
    expect(panelFor(objective(L4, {}, 0, { ...state, off: true }))).toMatchObject({ head: '目标 3/3', goal: '所有人到三楼东侧楼梯口集合' });
  });

  it('every step has neutral hints (no 角色074 voice, no keyboard-only wording)', () => {
    const all = [objective(L1, {}, 0), objective(L1, { drawer_key: 1 }, 0), objective(L1, { drawer_key: 1, stair_key: 1 }, 0), objective(L2, {}, 0), objective(L2, { fuse: 3 }, 0), objective(L2, {}, 3)];
    for (const o of all) {
      expect(o.hints.length).toBeGreaterThan(0);
      for (const h of o.hints) expect(h).not.toMatch(/角色074|同学们|\bE\b/);
    }
  });
});

describe('IdleHint (45 s without progress)', () => {
  it('nothing before 45 s, a hint at 45 s, then every 45 s cycling the hints', () => {
    expect(IDLE_HINT_S).toBe(45);
    const o = objective(L1, {}, 0), h = new IdleHint();
    h.reset(100, o.key);
    expect(h.tick(100, o)).toBeUndefined();
    expect(h.tick(144.9, o)).toBeUndefined();
    expect(h.tick(145, o)).toBe(o.hints[0]);
    expect(h.tick(146, o)).toBeUndefined(); // not every frame
    expect(h.tick(189.9, o)).toBeUndefined();
    expect(h.tick(190, o)).toBe(o.hints[1]);
    expect(h.tick(235, o)).toBe(o.hints[2]);
    expect(h.tick(280, o)).toBe(o.hints[0]);
  });

  it('progress restarts the clock and switches to the new step\'s hints', () => {
    const o0 = objective(L1, {}, 0), o1 = objective(L1, { stair_key: 1 }, 0), h = new IdleHint();
    h.reset(0, o0.key);
    expect(h.tick(40, o0)).toBeUndefined();
    expect(h.tick(41, o1)).toBeUndefined(); // the key was found at 41 s
    expect(h.tick(85, o1)).toBeUndefined(); // 44 s after progress, 85 s after start
    expect(h.tick(86, o1)).toBe(o1.hints[0]);
  });

  it('reset (new level) restarts the clock and the hint cycle', () => {
    const a = objective(L2, {}, 0), h = new IdleHint();
    h.reset(0, a.key);
    expect(h.tick(45, a)).toBe(a.hints[0]);
    h.reset(50, a.key);
    expect(h.tick(94, a)).toBeUndefined();
    expect(h.tick(95, a)).toBe(a.hints[0]);
  });

  it('a hint resets the clock even when the frame arrives late', () => {
    const o = objective(L1, {}, 0), h = new IdleHint(10);
    h.reset(0, o.key);
    expect(h.tick(25, o)).toBe(o.hints[0]); // tab was in the background
    expect(h.tick(34, o)).toBeUndefined();
    expect(h.tick(35, o)).toBe(o.hints[1]);
  });
});
