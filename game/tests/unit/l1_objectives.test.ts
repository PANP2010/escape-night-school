import { describe, expect, it } from 'vitest';
import { L1_KEY_CLUE, l1ItemPrompt, l1PickState, l1Stage } from '../../shared/l1Objectives.ts';
import { generateLevel } from '../../shared/level.ts';
import { objective } from '../../client/src/objective.ts';
import { goalPoint } from '../../client/src/guide.ts';
import { touchPrompt } from '../../client/src/hudText.ts';
import type { WorldItem } from '../../shared/protocol.ts';

describe('L1 drawer puzzle and fair decoys', () => {
  it('locks the stair key until a real drawer key is shared, keeping the key reusable', () => {
    const stair = { kind: 'stair_key' as const };
    const bag = { drawer_key: 1 };
    expect(l1Stage({})).toBe('drawer_key');
    expect(l1PickState(stair, {})).toBe('locked');
    expect(l1Stage(bag)).toBe('stair_key');
    expect(l1PickState(stair, bag)).toBe('ready');
    expect(bag).toEqual({ drawer_key: 1 });
    expect(l1Stage({ ...bag, stair_key: 1 })).toBe('exit');
    expect(l1PickState({ kind: 'door_key' }, {})).toBe('ready');
    expect(l1PickState({ kind: 'battery' }, {})).toBe('ready');
  });

  it('identifies props before lock checks and explains them without asking players to pick them', () => {
    const prop = { kind: 'stair_key' as const, decoy: true };
    expect(l1PickState(prop, {})).toBe('decoy');
    expect(l1PickState(prop, { drawer_key: 1 })).toBe('decoy');
    expect(l1ItemPrompt(prop, {})).toContain('不用拿');
    expect(l1ItemPrompt({ kind: 'stair_key' }, {})).toContain('需要抽屉钥匙');
    expect(touchPrompt(l1ItemPrompt({ kind: 'stair_key' }, { drawer_key: 1 }))).toBe('点抽屉 · 取出楼梯钥匙');
    expect(touchPrompt(l1ItemPrompt({ kind: 'drawer_key' }, {}))).toContain('点钥匙');
  });

  it('seeds real keys in distinct lecterns and leaves all optional props distinguishable', () => {
    const locations = new Set<string>();
    for (let seed = 0; seed < 80; seed++) {
      const level = generateLevel(0, seed);
      const keys = level.items.filter(item => item.kind === 'drawer_key' && !item.decoy);
      const stair = level.items.find(item => item.kind === 'stair_key' && !item.decoy)!;
      const props = level.items.filter(item => item.decoy);
      expect(keys).toHaveLength(1);
      expect(keys[0].spot).not.toBe(stair.spot);
      expect(keys[0].label).toContain('有齿');
      expect(stair.label).toContain('上锁');
      expect(props).toHaveLength(2);
      expect(props.every(item => item.label?.includes('无齿') && item.label.includes('道具'))).toBe(true);
      expect(new Set(level.items.map(item => item.spot)).size).toBe(level.items.length);
      locations.add(`${keys[0].spot}/${stair.spot}`);
      expect(generateLevel(0, seed)).toEqual(level);
    }
    expect(locations.size).toBeGreaterThan(20);
  });

  it('keeps the identification clue visible and points only to the real item for each step', () => {
    const level = generateLevel(0, 17);
    const items = level.items.map((item): WorldItem => ({ ...item, p: [item.x, item.y, item.z] }));
    const drawer = items.find(item => item.kind === 'drawer_key' && !item.decoy)!;
    const stair = items.find(item => item.kind === 'stair_key')!;
    const from = { x: 0, y: 0, z: 0 };
    const stages = [objective(level.def, {}, 0), objective(level.def, { drawer_key: 1 }, 0), objective(level.def, { drawer_key: 1, stair_key: 1 }, 0)];
    expect(stages.map(stage => stage.cur)).toEqual([0, 1, 2]);
    for (const stage of stages) expect(stage.note).toContain(L1_KEY_CLUE);
    expect(stages[0].note).not.toContain('值日生醒了');
    expect(stages[1].note).toContain('看着它就停');
    expect(stages[2].note).toContain('按住互动救援');
    expect(goalPoint(level.def, stages[0], items, new Set(items.map(item => item.id)), from, null)?.item).toBe(drawer.id);
    expect(goalPoint(level.def, stages[1], items, new Set(), from, null)?.item).toBe(stair.id);
    expect(goalPoint(level.def, stages[2], items, new Set(), from, null)).toMatchObject({ x: level.exit.x, y: level.exit.y, z: level.exit.z, exact: true });
  });
});
