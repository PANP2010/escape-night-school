import type { RunRanking } from '../../shared/runMode.ts';

/** Local progression for the campaign lobby.  Only server-confirmed events call record(). */

export type ProgressionDifficulty = 'story' | 'standard' | 'challenge' | 'nightmare';
export const PROGRESSION_DIFFICULTIES: readonly ProgressionDifficulty[] = ['story', 'standard', 'challenge', 'nightmare'];

export type AchievementId =
  | 'first-pick' | 'first-open' | 'first-revive'
  | 'chapter-1' | 'chapter-2' | 'chapter-3' | 'chapter-4'
  | 'chapter-5' | 'chapter-6' | 'chapter-7' | 'chapter-8'
  | 'escape' | 'no-down-escape'
  | 'difficulty-story' | 'difficulty-standard' | 'difficulty-challenge' | 'difficulty-nightmare'
  | 'secret-chalk' | 'secret-mirror' | 'secret-role_boss';

export interface AchievementInfo { id: AchievementId; title: string; detail: string; secret?: boolean }
export const ACHIEVEMENTS: readonly AchievementInfo[] = [
  { id: 'first-pick', title: '拾起第一件东西', detail: '亲手拿到一件由服务器确认的物品。' },
  { id: 'first-open', title: '门轴轻响', detail: '亲手打开一扇由服务器确认的门。' },
  { id: 'first-revive', title: '把同伴拉起来', detail: '完成一次由服务器确认的搀扶。' },
  { id: 'chapter-1', title: '走出一楼', detail: '完成第一章。' },
  { id: 'chapter-2', title: '接通红灯', detail: '完成第二章。' },
  { id: 'chapter-3', title: '走出回环', detail: '完成第三章。' },
  { id: 'chapter-4', title: '让广播安静', detail: '完成第四章。' },
  { id: 'chapter-5', title: '体育馆的四盏灯', detail: '完成第五章。' },
  { id: 'chapter-6', title: '交上考卷', detail: '完成第六章。' },
  { id: 'chapter-7', title: '镜后取钥', detail: '完成第七章。' },
  { id: 'chapter-8', title: '越过校门', detail: '完成最终章并离校。' },
  { id: 'escape', title: '今夜离校', detail: '在结算中被记录为已逃出。' },
  { id: 'no-down-escape', title: '无伤离校', detail: '完成结算且整局没有倒地。' },
  { id: 'difficulty-story', title: '初见夜校', detail: '完成故事档位。' },
  { id: 'difficulty-standard', title: '夜巡完成', detail: '完成标准档位。' },
  { id: 'difficulty-challenge', title: '禁校通行', detail: '完成挑战档位。' },
  { id: 'difficulty-nightmare', title: '无人生还？', detail: '完成噩梦档位并离校。' },
  { id: 'secret-chalk', title: '九条命的同学', detail: '找到循环走廊的粉笔猫。', secret: true },
  { id: 'secret-mirror', title: '倒影晚了一拍', detail: '找到镜角里和你字迹相似的小勾。', secret: true },
  { id: 'secret-role_boss', title: '不许写错', detail: '读到值周代号025自己贴上的值周签名。', secret: true },
];
const INFO = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));
const STORAGE_KEY = 'escape.progress.v1';

interface PersistedProgress { achievements: AchievementId[]; unlocked: ProgressionDifficulty[]; namedMonitorsUnlocked: boolean }
const empty = (): PersistedProgress => ({ achievements: [], unlocked: ['story'], namedMonitorsUnlocked: false });
const validAchievement = (v: unknown): v is AchievementId => typeof v === 'string' && INFO.has(v as AchievementId);
const validDifficulty = (v: unknown): v is ProgressionDifficulty => PROGRESSION_DIFFICULTIES.includes(v as ProgressionDifficulty);

function load(): PersistedProgress {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return empty();
    const value = JSON.parse(raw) as Partial<PersistedProgress>;
    const achievements = Array.isArray(value.achievements) ? [...new Set(value.achievements.filter(validAchievement))] : [];
    const unlocked: ProgressionDifficulty[] = ['story'];
    // Reconstruct sequential unlocks from actual completed tiers, including a write interrupted at unlock.
    for (let i = 0; i < PROGRESSION_DIFFICULTIES.length - 1; i++) {
      if (!achievements.includes(`difficulty-${PROGRESSION_DIFFICULTIES[i]}`)) break;
      unlocked.push(PROGRESSION_DIFFICULTIES[i + 1]);
    }
    const namedMonitorsUnlocked = value.namedMonitorsUnlocked === true && unlocked.includes('nightmare') && achievements.includes('difficulty-nightmare');
    return { achievements, unlocked, namedMonitorsUnlocked };
  } catch { return empty(); }
}

export class ProgressionStore {
  private state = load();
  private listeners = new Set<() => void>();
  private room = '';
  private difficulty: ProgressionDifficulty = 'story';
  private eligible = false;
  private developerMode = false;
  private namedMonitors = false;
  private downs = 0;

  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  get achievements(): readonly AchievementId[] { return this.state.achievements; }
  get unlocked(): readonly ProgressionDifficulty[] { return this.state.unlocked; }
  get currentDifficulty(): ProgressionDifficulty { return this.difficulty; }
  get canEnableNamedMonitors(): boolean {
    return this.state.namedMonitorsUnlocked && this.isUnlocked('nightmare') && this.state.achievements.includes('difficulty-nightmare');
  }
  isUnlocked(id: ProgressionDifficulty): boolean { return this.state.unlocked.includes(id); }
  info(id: AchievementId): AchievementInfo { return INFO.get(id)!; }

  setRoom(code: string, difficulty: ProgressionDifficulty | string | undefined, started: boolean, ownListed = true, developerMode = false, namedMonitors = false): void {
    const changed = !!this.room && this.room !== code;
    if (changed) { this.eligible = false; this.downs = 0; }
    this.room = code;
    this.developerMode = developerMode;
    this.namedMonitors = namedMonitors;
    this.difficulty = validDifficulty(difficulty) ? difficulty : 'standard';
    // A room member is eligible until the server identifies a late joiner as a spectator.
    // The UI only offers unlocked tiers; a forged wire value never unlocks a tier locally.
    if (changed || !started) this.eligible = ownListed;
    if (this.developerMode) this.eligible = false;
  }

  observeSnap(ownState: number | undefined, downCount?: number): void {
    if (ownState !== undefined) this.eligible = !this.developerMode && ownState !== 2;
    if (typeof downCount === 'number' && Number.isFinite(downCount)) this.downs = Math.max(this.downs, downCount);
  }

  activity(from: number, kind: 'pick' | 'open' | 'close' | 'revive', ownId: number): void {
    if (!this.eligible || from !== ownId) return;
    if (kind === 'pick') this.record('first-pick');
    if (kind === 'open') this.record('first-open');
    if (kind === 'revive') this.record('first-revive');
  }

  chapterCleared(level: number): void {
    if (!this.eligible || level < 0 || level > 7) return;
    this.record(`chapter-${level + 1}` as AchievementId);
  }

  storyRead(id: string): void {
    if (!this.eligible) return;
    if (id === '2:note:chalk-cat') this.record('secret-chalk');
    if (id === '6:note:mirror-wink') this.record('secret-mirror');
    if (id === '4:note:role_boss-signature' && this.namedMonitors) this.record('secret-role_boss');
  }

  completed(members: readonly { id: number; downs: number; escaped: boolean }[], ownId: number, namedMonitorsUnlocked = false, ranking?: RunRanking): void {
    if (this.developerMode || ranking === 'developer' || ranking === 'debug' || ranking === 'incomplete') return;
    const own = members.find((m) => m.id === ownId);
    // Restored completion can precede the first snapshot. Escaped finale members are authoritative;
    // late observers never belong to that list and cannot receive another player's reward.
    if (!own?.escaped) return;
    this.record('chapter-8');
    this.record('escape');
    if (own.downs === 0 && this.downs === 0) this.record('no-down-escape');
    this.record(`difficulty-${this.difficulty}` as AchievementId);
    const index = PROGRESSION_DIFFICULTIES.indexOf(this.difficulty);
    if (this.isUnlocked(this.difficulty) && index >= 0 && index + 1 < PROGRESSION_DIFFICULTIES.length) this.unlockThrough(PROGRESSION_DIFFICULTIES[index + 1]);
    if (namedMonitorsUnlocked && this.difficulty === 'nightmare' && this.isUnlocked('nightmare')) {
      this.state.namedMonitorsUnlocked = true; this.persist(); this.notify();
    }
    this.eligible = false;
  }

  record(id: AchievementId): boolean {
    if (this.developerMode || this.state.achievements.includes(id)) return false;
    this.state.achievements = [...this.state.achievements, id];
    this.persist(); this.notify(); return true;
  }

  private unlockThrough(id: ProgressionDifficulty): void {
    const index = PROGRESSION_DIFFICULTIES.indexOf(id);
    if (index < 0) return;
    const next = PROGRESSION_DIFFICULTIES.slice(0, index + 1);
    if (next.every((item) => this.state.unlocked.includes(item))) return;
    this.state.unlocked = next; this.persist(); this.notify();
  }
  private persist(): void { try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(this.state)); } catch { /* private mode */ } }
  private notify(): void { for (const listener of this.listeners) listener(); }
}
