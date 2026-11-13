/** Direct touch is primary; the action button remains available for hiding and precise aiming. */
export function touchPrompt(p: string): string {
  if (p === 'E 取下镜中钥匙') return '点镜中钥匙 · 取下';
  if (p === 'E 推开镜中门对应的墙') return '点墙 · 推开镜中门';
  if (p === 'E 拾取') return '点物品 · 拾取';
  if (p.startsWith('E 拾取抽屉钥匙')) return '点钥匙 · 拾取抽屉钥匙（铜牌、有齿）';
  if (p === 'E 打开抽屉，取出楼梯钥匙') return '点抽屉 · 取出楼梯钥匙';
  if (p === 'E 打开' || p === 'E 关上') return `点门 · ${p.slice(2)}`;
  if (p === 'E 插入保险丝') return '点配电箱 · 插入保险丝';
  if (p === 'E 揭开贴纸') return '点贴纸 · 揭开数字';
  if (p === 'E 输入停播密码') return '点广播台 · 输入停播密码';
  if (p === 'E 出来') return '轻点画面 · 出来';
  if (/按住 E/.test(p)) return p.replace('按住 E', '按住队友');
  return /^E /.test(p) ? `点互动 · ${p.slice(2)}` : p.replace(/\bE\b/, '互动');
}

/** Mirror clues refer to the object a finger selects, matching direct world interaction. */
export function touchObjectiveText(text: string): string {
  return text.replace('露出钥匙时按 E', '露出钥匙时点镜中钥匙').replace('走近那面墙按 E 推开', '走近后点对应墙推开');
}

/** Battery fraction for the HUD bar's --v, clamped to 0..1. */
export function barFrac(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}
