import { ACT_REACH } from './interact.ts';

/** Environmental writing and a personal reading log. This module has no puzzle authority. */
export type StoryTone = 'paper' | 'chalk' | 'sticker' | 'workbook';
export interface StoryFragment { id: string; title: string; source: string; text: string; tone: StoryTone }
/** Keep the physical note and its reading log consistent with the room's optional character Easter eggs. */
export function roomStoryFragment(fragment: StoryFragment, namedMonitors = false): StoryFragment {
  return fragment.id === 'role_boss-signature' && !namedMonitors ? {
    ...fragment, title: '值周提醒',
    text: '今晚值周：值周生。\n四盏灯都亮了，再去出口集合。\n——便签的落款已经被擦掉了。',
  } : fragment;
}
export interface StoryChapter {
  level: number;
  name: string;
  lead: string;
  recap: string;
  note: StoryFragment;
  fragments: readonly StoryFragment[];
  confirmed: string;
}

const chapter = (level: number, name: string, lead: string, recap: string, confirmed: string, fragments: readonly StoryFragment[]): StoryChapter =>
  ({ level, name, lead, recap, confirmed, note: fragments[0], fragments });

/** Eight authored chapters; a catalogue entry neither registers nor unlocks a playable level. */
export const STORY_CHAPTERS: readonly StoryChapter[] = [
  chapter(0, '一楼·晚自习后',
    '正门的铁链没有松动。先找有齿的抽屉钥匙，再去另一间教室打开讲台抽屉。',
    '楼梯间让出了第一段路。正门的铁链仍在，离校还没有结束。',
    '楼梯钥匙已经找到。去西南角楼梯间，等还在路上的同伴。', [
      { id: 'gate', title: '铁链旁的纸条', source: '正门铁栅左侧', tone: 'paper', text: '正门铁链未解。先找铜牌有齿的抽屉钥匙，再去另一间教室打开讲台抽屉取楼梯间钥匙，最后到西南角楼梯间集合。' },
      { id: 'route', title: '离校路线草稿', source: '教室讲台上的作业本', tone: 'workbook', text: '抽屉钥匙 → 另一间教室的讲台抽屉 → 楼梯钥匙 → 西南角楼梯间。\n楼梯钥匙上没有写“校门”。' },
      { id: 'scent', title: '楼梯边的提醒', source: '楼梯间门牌旁的贴纸', tone: 'sticker', text: '闻到茉莉香就躲起来。路通了，也要等一等身后的同伴。' },
    ]),
  chapter(1, '二楼·停电',
    '楼梯钥匙解决不了连廊的红灯。黑暗里，先找断掉的那一段电路。',
    '三根保险丝装回了配电箱，西头连廊门禁恢复。来电只接通这一段路。',
    '三根保险丝已经装回。到西头连廊门口集合，继续找离校的路。', [
      { id: 'repair', title: '门禁检修贴', source: '走廊配电箱左侧', tone: 'sticker', text: '西头连廊门禁：缺三根保险丝。备用件在教室讲台，装回此箱后再去连廊。' },
      { id: 'circuit', title: '电路练习页', source: '教室讲台上的作业本', tone: 'workbook', text: '讲台 → 保险丝 → 配电箱 → 西头连廊。\n拿在手里不算接通，三根都要装回去。' },
      { id: 'red-light', title: '红灯旁的小字', source: '连廊门牌旁的纸条', tone: 'paper', text: '门上没有钥匙孔。等的是电，不是另一把钥匙。' },
    ]),
  chapter(2, '三楼·无尽走廊',
    '连廊有了电，走廊却把脚步送回原处。这次要核对的，是经过哪一扇门。',
    '照着粉笔门序逐间进出，循环才被打破。走到尽头并不总是走出去。',
    '你的门序已经完成。等同伴走完各自的顺序，再到西端绿色出口集合。', [
      { id: 'chalk', title: '没擦净的粉笔字', source: '门序黑板左侧', tone: 'chalk', text: '别只走到头。看黑板门序，进教室，再回走廊；下一扇门从走廊开始。' },
      { id: 'margin', title: '重复的一行', source: '循环尽头门牌旁的纸条', tone: 'paper', text: '每个人都要亲自走完。走错门，从第一步重来；走廊回环不会抹掉已走对的顺序。' },
      { id: 'chalk-cat', title: '粉笔猫', source: '门序黑板右侧的小涂鸦', tone: 'chalk', text: ' /\\_/\\\n( =ω= )\n“我已经在这条走廊跑了九条命。”\n猫爪下还写着：这次记得进门。' },
    ]),
  chapter(3, '广播站',
    '门牌的次序留在身后，广播里却开始叫名字。四张编号贴纸指向停播控制。',
    '按编号拼出的密码让广播停了。耳边安静下来，校门仍在别处。',
    '广播已经停止，当前点名结束。回三楼东侧楼梯口，与同伴集合。', [
      { id: 'duty', title: '广播值班纸', source: '四楼广播室门牌旁', tone: 'paper', text: '先找齐四张编号贴纸。密码按①②③④排列，不按找到的先后；停播控制在四楼广播室。' },
      { id: 'silence', title: '接线旁的标签', source: '四楼广播控制台旁', tone: 'sticker', text: '被点到名字时，位置会暴露。屏蔽柜和隔间能隔开信号；停播后，回三楼集合。' },
      { id: 'stairs', title: '楼梯口的铅笔字', source: '三楼路线牌旁', tone: 'chalk', text: '声音停下，不等于门都开了。二楼封栏仍在，去三楼东侧楼梯口。' },
    ]),
  chapter(4, '体育馆',
    '离开广播的声音，还有体育馆的门禁。四处开关，得在同一刻亮起。',
    '四盏灯同时有效，体育馆出口才开放。配合的时机接上了这一段路。',
    '四处开关的灯已经同时亮起。先确认出口，再与同伴离开。', [
      { id: 'lights', title: '四灯门禁便签', source: '体育馆南墙', tone: 'sticker', text: '四处开关必须同时有效。多人五秒，单人二十秒；先分清位置，再约好动手。' },
      { id: 'timing', title: '体育课记录', source: '器材室墙上的练习页', tone: 'workbook', text: '不是比谁先按下去。最后一盏亮时，前面的灯也得亮着。' },
      { id: 'role_boss-signature', title: '值周生的签名', source: '体育馆南墙不起眼的便签', tone: 'chalk', text: '今晚值周：值周代号025。\n点名可以躲，名字不许写错。\n（“酱”字被描了三遍。）\n——这张纸是他自己贴的。' },
    ]),
  chapter(5, '考场',
    '开关要等同一刻，考卷要等五题核对完。门口的公告还留着答案线索。',
    '五道题核对后交卷，考场的门才打开。答案只决定这一次能否交卷。',
    '试卷已经通过。找到开放的出口，等同伴一起离开考场。', [
      { id: 'exam', title: '考务边条', source: '考场门口的公告边', tone: 'paper', text: '五道题的答案线索在教室门口。核对后再交卷；答错会熄灯，也会把角色074引到附近门后。' },
      { id: 'check', title: '交卷前的勾选框', source: '五楼公告旁的复核页', tone: 'workbook', text: '□ 看公告\n□ 核对五题\n□ 再交卷\n不要把空白当成已经答完。' },
    ]),
  chapter(6, '镜廊',
    '这里的线索不在公告上。镜中值日生背后的空档，露出了一把钥匙。',
    '镜子给出观察的角度，钥匙要从值日生背后的空档取出。看见与拿到之间，还隔着一步。',
    '钥匙已经取出。先认清现实中的出口，再离开镜廊。', [
      { id: 'gap', title: '镜框边的铅笔字', source: '旧实验楼镜框边', tone: 'chalk', text: '看镜子里值日生的背后。钥匙在那道空档里；认准位置，再从空档把它取出来。' },
      { id: 'reflection', title: '观察练习页', source: '二楼镜框边的练习页', tone: 'workbook', text: '镜中看到的，是取钥匙的位置。不要只盯着自己的倒影。' },
      { id: 'mirror-wink', title: '镜角的小勾', source: '一楼镜框外侧的铅笔小字', tone: 'paper', text: '如果倒影比你晚眨一次眼，\n就假装没有发现。\n\n镜角画着一个小小的 ✓。\n旁边的字迹和你很像。' },
    ]),
  chapter(7, '教务处·点名册',
    '走过的门都没有带你离校。教务处还剩一份点名册，校门在楼外。',
    '划掉名字打开最后一段通路；真正离校，要越过校门。',
    '点名册的名字已经划去。门外还有路，照看身后尚未抵达的同伴。', [
      { id: 'rollcall', title: '点名册夹页', source: '教务处南墙', tone: 'paper', text: '划掉全队名字后，冲向校门。划名只是开门；走出校门，才算离校。' },
      { id: 'gate-out', title: '朝外的箭头', source: '校门内侧的贴纸', tone: 'sticker', text: '出口在门外。别停在门内等那声点名。' },
    ]),
] as const;

/** A chapter index and its real definition name must agree. */
export function storyChapter(level: number, name: string): StoryChapter | undefined {
  return STORY_CHAPTERS.find(c => c.level === level && c.name === name);
}

export type StoryEntryKind = 'note' | 'broadcast' | 'confirmed' | 'recap';
export interface StoryEntry { id: string; chapter: string; title: string; source: string; text: string; level?: number; kind?: StoryEntryKind }
export interface StoryModel { chapter: string; recap: string; lead: string; entries: StoryEntry[]; notice?: string }
export interface StorySite { p: [number, number, number]; normal: [number, number, number]; surface?: 'wall' | 'desk' }
export interface StoryNoteSite extends StorySite, StoryFragment {}

/** Callers supply the latest own ST_OK server feet/yaw, plus a static-world/closed-door LOS result. */
export function canReadStory(site: StorySite, p: readonly number[], yaw: number, visible: boolean): boolean {
  if (p.length !== 3 || !p.every(Number.isFinite) || !site.p.every(Number.isFinite) || !site.normal.every(Number.isFinite)
    || Math.hypot(site.normal[0], site.normal[2]) < 0.5 || !Number.isFinite(yaw) || !visible) return false;
  const dx = site.p[0] - p[0], dz = site.p[2] - p[2], d = Math.hypot(dx, dz);
  if (d > ACT_REACH || Math.abs(site.p[1] - (p[1] + 1.5)) > 0.8) return false;
  if (dx * site.normal[0] + dz * site.normal[2] > 0.05) return false;
  return d < 0.15 || (-Math.sin(yaw) * dx - Math.cos(yaw) * dz) / d >= Math.cos(Math.PI / 3);
}

const obj = (m: unknown): m is Record<string, unknown> => !!m && typeof m === 'object' && !Array.isArray(m);

/** Browser-session history. Reading never sends a message, spends an item or opens an exit. */
export class StoryState {
  chapter?: StoryChapter;
  revision = 0;
  private history = new Map<string, StoryEntry>();
  private pending = false;
  private attempt = '';
  private previous = '';
  private notice = '';
  private room = '';
  private namedMonitors = false;
  get namedMonitorsEnabled(): boolean { return this.namedMonitors; }

  enter(level: number, name: string, seed: number): boolean {
    const next = Number.isFinite(seed) ? storyChapter(level, name) : undefined;
    const key = `${level}:${name}:${seed}`;
    if (key === this.attempt) return false;
    const old = this.chapter;
    if (next && old && this.pending && next.level === old.level + 1) {
      this.add('recap', '走过的路', '上一段通路', old.recap);
      this.previous = old.recap;
    } else this.previous = '';
    // A fresh load of this chapter is a new attempt even when no fade reached the client.
    if (next) this.history.delete(`${next.level}:confirmed`);
    this.pending = false;
    this.chapter = next;
    this.attempt = key;
    this.notice = '';
    this.revision++;
    return true;
  }

  readNote(fragmentId?: string): boolean {
    const c = this.chapter;
    const fragment = c && (fragmentId === undefined ? c.note : c.fragments.find(f => f.id === fragmentId));
    const shown = fragment && roomStoryFragment(fragment, this.namedMonitors);
    return shown ? this.add('note', shown.title, shown.source, shown.text, shown.id) : false;
  }

  /** Only inbound authority messages from the current room are passed here. */
  receive(m: unknown, myId: number): void {
    if (!obj(m)) return;
    if (m.t === 'room' && typeof m.code === 'string' && m.code) {
      if (this.room && this.room !== m.code) {
        this.chapter = undefined;
        this.history.clear();
        this.pending = false;
        this.attempt = this.previous = this.notice = '';
        this.revision++;
      }
      this.room = m.code;
      const namedMonitors = m.namedMonitors === true;
      if (this.namedMonitors !== namedMonitors) {
        this.namedMonitors = namedMonitors;
        const entry = this.history.get('4:note:role_boss-signature');
        const fragment = STORY_CHAPTERS[4].fragments.find(f => f.id === 'role_boss-signature')!;
        if (entry) {
          const shown = roomStoryFragment(fragment, namedMonitors);
          this.history.set(entry.id, { ...entry, title: shown.title, source: shown.source, text: shown.text });
        }
        this.revision++;
      }
      return;
    }
    const c = this.chapter;
    if (!c) return;
    if (m.t === 'fade' && typeof m.restart === 'boolean') {
      this.pending = !m.restart;
      if (m.restart) {
        this.history.delete(`${c.level}:confirmed`);
        this.notice = '本关重来；读过的文字保留，这段路需要重新走完。';
        this.revision++;
      }
      return;
    }
    let confirmed = false;
    if (c.level === 0 && m.t === 'bag' && obj(m.bag)) confirmed = typeof m.bag.stair_key === 'number' && Number.isFinite(m.bag.stair_key) && m.bag.stair_key >= 1;
    if (c.level === 1 && m.t === 'power') confirmed = typeof m.n === 'number' && Number.isFinite(m.n) && m.n >= 3;
    if (c.level === 2 && m.t === 'loop' && Array.isArray(m.players)) confirmed = m.players.some(p => obj(p) && p.id === myId && typeof p.step === 'number' && Number.isFinite(p.step) && p.step >= 4);
    if (c.level === 3 && m.t === 'broadcast') confirmed = m.off === true;
    if (c.level === 4 && m.t === 'gym') confirmed = m.complete === true;
    if (c.level === 5 && m.t === 'exam') confirmed = m.passed === true;
    if (c.level === 6 && m.t === 'l7' && obj(m.key)) confirmed = m.key.taken === true;
    if (c.level === 7 && m.t === 'finale') confirmed = m.phase === 'chase' || m.phase === 'complete';
    if (c.level === 3 && m.t === 'broadcast' && m.off === false && obj(m.call)
      && Number.isInteger(m.call.id) && (m.call.id as number) > 0
      && typeof m.call.left === 'number' && Number.isFinite(m.call.left) && m.call.left > 0
      && typeof m.call.shielded === 'boolean') {
      const heard = m.call.shielded
        ? '广播正在点名，屏蔽柜或隔间挡住了这次信号。'
        : `广播点到了${m.call.id === myId ? '你' : '同伴'}的名字，位置正在暴露。屏蔽柜和隔间可以隔开信号。`;
      this.add('broadcast', '点名声留下的提醒', '刚才的广播', heard);
    }
    if (confirmed) this.add('confirmed', '通路有了变化', '路上记下的事', c.confirmed);
    if (c.level === 7 && m.t === 'completed') {
      this.notice = '已经越过校门。今夜的记录，到这里合上。';
      this.pending = false;
      this.revision++;
    }
    if (m.t === 'complete' && m.level === c.level) {
      const notice = '当前开放的章节已结束。校门还在前面，这次记录先留在这里。';
      if (this.notice !== notice) { this.notice = notice; this.revision++; }
      this.pending = false;
    }
  }

  model(): StoryModel {
    const c = this.chapter;
    return {
      chapter: c ? `第${c.level + 1}章 · ${c.name}` : '个人记录',
      recap: this.previous || '还没有上一段通路的记录。',
      lead: c ? (this.history.has(`${c.level}:confirmed`) ? c.confirmed : c.lead) : '靠近现场的文字，留下自己的摘录。',
      entries: [...this.history.values()],
      ...(this.notice ? { notice: this.notice } : {}),
    };
  }

  private add(kind: StoryEntryKind, title: string, source: string, text: string, fragmentId?: string): boolean {
    const c = this.chapter;
    if (!c) return false;
    const id = `${c.level}:${kind}${fragmentId ? `:${fragmentId}` : ''}`;
    if (this.history.has(id)) return false;
    this.history.set(id, { id, level: c.level, kind, chapter: `第${c.level + 1}章 · ${c.name}`, title, source, text });
    this.notice = `已摘录 · ${title}`;
    this.revision++;
    return true;
  }
}
