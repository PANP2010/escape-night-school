import type { ItemKind } from './levels/def.ts';

type ObjectiveBag = Partial<Record<ItemKind, number>>;
type ObjectiveItem = { kind: ItemKind; decoy?: boolean; label?: string };

/** Every real key has teeth and a brass tag; the harmless theatre props have neither. */
export const L1_KEY_CLUE = '铜牌、有齿的是真钥匙；无齿的是戏剧道具，不用拿';
export type L1Stage = 'drawer_key' | 'stair_key' | 'exit';

/** Shared team progress; the drawer key remains in the bag after opening the drawer. */
export function l1Stage(bag: ObjectiveBag): L1Stage {
  return (bag.stair_key ?? 0) > 0 ? 'exit' : (bag.drawer_key ?? 0) > 0 ? 'stair_key' : 'drawer_key';
}

/** Server authority and client prompts use the same lock and decoy rules. */
export function l1PickState(item: ObjectiveItem, bag: ObjectiveBag): 'ready' | 'locked' | 'decoy' {
  if (item.decoy) return 'decoy';
  return item.kind === 'stair_key' && (bag.drawer_key ?? 0) <= 0 ? 'locked' : 'ready';
}

export function l1ItemPrompt(item: ObjectiveItem, bag: ObjectiveBag): string {
  const state = l1PickState(item, bag);
  if (state === 'decoy') return '无齿仿制钥匙 · 戏剧道具，不用拿';
  if (state === 'locked') return '讲台抽屉锁着，需要抽屉钥匙';
  if (item.kind === 'stair_key') return 'E 打开抽屉，取出楼梯钥匙';
  if (item.kind === 'drawer_key') return 'E 拾取抽屉钥匙 · 铜牌、有齿';
  return 'E 拾取';
}
