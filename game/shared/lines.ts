// 角色074语录 (user-provided, 2026-10-23): his canonical voice lines. Text is verbatim except the 「xx者」 slot,
// which is filled per situation. The server picks a line (event kind 'line'), the client shows a subtitle + voice.
// Pure data + a deterministic picker so tests and server agree.

/** When a line may be said. */
export type LineTrigger =
  | 'patrol'   // ambient, while walking the corridors
  | 'spot'     // first sees a player (→ chase)
  | 'chase'    // during a chase
  | 'lost'     // lost sight of the player he chased
  | 'catch'    // caught a player (罚站)
  | 'stare'    // a player has been looking at him (变脸 trigger)
  | 'sprint'   // heard / saw a player running
  | 'crouch'   // saw a crouching / hiding player
  | 'noise'    // investigating a loud noise (dropped item, door slam)
  | 'fail';    // a puzzle answer was wrong

export interface WardenLine { id: string; text: string; when: readonly LineTrigger[]; /** relative weight, default 1 */ w?: number }

/** Fills the 「xx者」 slot; picked by the trigger (running → 逃跑者 etc). */
export const ROLE_SLOT = '{xx}';
const ROLES: Partial<Record<LineTrigger, readonly string[]>> & { default: readonly string[] } = {
  default: ['学习者', '奋斗者', '追梦者'],
  sprint: ['逃跑者', '奔跑者'],
  chase: ['逃跑者'],
  crouch: ['躲藏者', '旁观者'],
  catch: ['值日者', '学习者'],
};

export const WARDEN_LINES: readonly WardenLine[] = [
  { id: 'attitude', text: `我感觉这不是${ROLE_SLOT}应有的态度`, when: ['spot', 'catch', 'sprint', 'crouch'], w: 2 },
  { id: 'rhythm', text: '我们要找到自己的节奏', when: ['patrol', 'sprint', 'chase'] },
  { id: 'posture', text: '你缺乏青春舒展的姿态', when: ['crouch', 'spot'], w: 2 },
  { id: 'careless', text: '粗疏', when: ['noise', 'fail', 'catch'] },
  { id: 'unbroken', text: '心中有一片尚未崩坏的地方', when: ['patrol', 'lost'] },
  { id: 'nopersona', text: '你没有人格', when: ['catch', 'fail'] },
  { id: 'jianghu', text: '这真是浮乎江湖之上的瞬间', when: ['lost', 'patrol'] },
  { id: 'duty', text: '你有担当吗', when: ['catch', 'chase', 'noise'] },
  { id: 'likeme', text: '你喜欢我吗？看着我的眼睛，你真的喜欢我吗？！', when: ['stare'], w: 3 },
];

/** Lines allowed for a trigger. */
export const linesFor = (t: LineTrigger): WardenLine[] => WARDEN_LINES.filter(l => l.when.includes(t));

/** Text with the 「xx者」 slot filled for this trigger. */
export function renderLine(l: WardenLine, t: LineTrigger, rng: () => number): string {
  if (!l.text.includes(ROLE_SLOT)) return l.text;
  const roles = ROLES[t] ?? ROLES.default;
  return l.text.replace(ROLE_SLOT, roles[Math.floor(rng() * roles.length)]);
}

/**
 * Weighted pick for a trigger, skipping ids in `recent` (unless that leaves nothing). Returns null if the
 * trigger has no lines. The caller keeps `recent` (e.g. last 3 ids) and its own cooldown.
 */
export function pickLine(t: LineTrigger, rng: () => number, recent: readonly string[] = []): { id: string; text: string } | null {
  const all = linesFor(t);
  if (!all.length) return null;
  const pool = all.filter(l => !recent.includes(l.id));
  const from = pool.length ? pool : all;
  let r = rng() * from.reduce((s, l) => s + (l.w ?? 1), 0);
  let l = from[from.length - 1];
  for (const c of from) { r -= c.w ?? 1; if (r < 0) { l = c; break; } }
  return { id: l.id, text: renderLine(l, t, rng) };
}
