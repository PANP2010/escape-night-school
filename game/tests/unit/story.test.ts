import { describe, expect, it } from 'vitest';
import { STORY_CHAPTERS, StoryState, canReadStory, storyChapter, type StorySite } from '../../shared/story.ts';
import { generateLevel, LEVELS } from '../../shared/level.ts';
import { WARDEN_LINES } from '../../shared/lines.ts';

const MY_ID = 17;
const names = STORY_CHAPTERS.map(c => c.name);
const confirmations = [
  { t: 'bag', bag: { stair_key: 1 } },
  { t: 'power', n: 3 },
  { t: 'loop', players: [{ id: MY_ID, step: 4 }] },
  { t: 'broadcast', off: true },
];
const at = (level: number) => { const s = new StoryState(); s.enter(level, names[level], 71); return s; };
const kind = (s: StoryState, k: string) => s.model().entries.filter(e => e.kind === k);

describe('environmental writing follows the real route', () => {
  it('matches all eight registered chapters and rejects clamped identities beyond the campaign', () => {
    expect(STORY_CHAPTERS).toHaveLength(8);
    expect(LEVELS.map(d => d.name)).toEqual(names);
    LEVELS.forEach((d, i) => expect(storyChapter(i, d.name)).toBe(STORY_CHAPTERS[i]));
    for (let i = LEVELS.length; i < 10; i++) {
      expect(() => generateLevel(i, 71)).toThrow(RangeError);
      expect(storyChapter(i, names.at(-1)!)).toBeUndefined();
    }
    expect(storyChapter(1, names[0])).toBeUndefined();
    expect(storyChapter(0, `${names[0]} `)).toBeUndefined();
  });

  it('uses short, distinct fragments with different physical voices instead of repeating the objective', () => {
    const prose = new Set<string>(), tones = new Set<string>();
    for (const c of STORY_CHAPTERS) {
      expect(c.fragments.length).toBeGreaterThanOrEqual(2);
      expect(c.note).toBe(c.fragments[0]);
      expect(new Set(c.fragments.map(f => f.id)).size).toBe(c.fragments.length);
      for (const f of c.fragments) {
        expect([...f.text].length).toBeLessThanOrEqual(100);
        expect(prose.has(f.text)).toBe(false);
        expect(f.text).not.toBe(c.lead);
        expect(f.text).not.toMatch(/TODO|TBD|待补|待定|占位|undefined|NaN|服务器|客户端|快照|协议/);
        prose.add(f.text); tones.add(f.tone);
      }
    }
    expect(tones).toEqual(new Set(['paper', 'workbook', 'sticker', 'chalk']));
    expect(STORY_CHAPTERS[0].note.text).toMatch(/有齿的抽屉钥匙.*另一间教室.*讲台抽屉.*楼梯间钥匙.*西南角楼梯间/);
    expect(STORY_CHAPTERS[1].note.text).toMatch(/三根保险丝.*讲台.*此箱/);
    expect(STORY_CHAPTERS[2].fragments[1].text).toMatch(/每个人.*走错门.*重来.*回环.*不会抹掉/);
    expect(STORY_CHAPTERS[3].note.text).toMatch(/①②③④.*不按找到.*四楼广播室/);
    expect(STORY_CHAPTERS[3].confirmed).toContain('三楼东侧楼梯口');
  });

  it('uses the latest mirror-key concept and never restores the discarded push-wall objective', () => {
    const mirror = STORY_CHAPTERS[6];
    const prose = [mirror.lead, mirror.recap, mirror.confirmed, ...mirror.fragments.map(f => f.text)].join('');
    expect(prose).toMatch(/镜.*值日生.*背后.*空档.*钥匙/);
    expect(prose).not.toMatch(/推.*墙|两.*门|二楼.*出口|二楼.*标本/);
    expect(STORY_CHAPTERS[7].note.text).toMatch(/划掉全队名字.*校门.*走出校门.*离校/);
  });

  it('keeps canonical Warden dialogue intact and adds no invented speaker or origin story', () => {
    expect(WARDEN_LINES.map(l => l.text)).toEqual([
      '我感觉这不是{xx}应有的态度', '我们要找到自己的节奏', '你缺乏青春舒展的姿态', '粗疏',
      '心中有一片尚未崩坏的地方', '你没有人格', '这真是浮乎江湖之上的瞬间', '你有担当吗',
      '你喜欢我吗？看着我的眼睛，你真的喜欢我吗？！',
    ]);
    const prose = STORY_CHAPTERS.map(c => [c.lead, c.recap, c.confirmed, ...c.fragments.map(f => f.text)].join('')).join('');
    expect(prose).not.toMatch(/角色074(?:说|喊|：|:)|班主任(?:说|喊|：|:)|身世|诅咒|失踪|当年|真相/);
    for (const line of WARDEN_LINES) expect(prose).not.toContain(line.text);
  });
});

describe('personal excerpts and authority boundaries', () => {
  it('reading every fragment is local, deduplicated and cannot confirm a puzzle', () => {
    const one = at(0), two = at(0), c = STORY_CHAPTERS[0];
    expect(one.readNote('missing')).toBe(false);
    expect(one.readNote()).toBe(true);
    const revision = one.revision;
    expect(one.readNote(c.note.id)).toBe(false);
    expect(one.revision).toBe(revision);
    c.fragments.forEach(f => one.readNote(f.id));
    expect(one.model().entries.map(e => e.id)).toEqual(c.fragments.map(f => `0:note:${f.id}`));
    expect(kind(one, 'confirmed')).toEqual([]);
    expect(two.model().entries).toEqual([]);
    expect(one.model().entries.every(e => e.chapter === `第1章 · ${c.name}`)).toBe(true);
  });

  it.each([0, 1, 2, 3])('only chapter %i accepts its own authoritative state', level => {
    const s = at(level);
    expect(s.model().lead).toBe(STORY_CHAPTERS[level].lead);
    confirmations.forEach((m, i) => { if (i !== level) s.receive(m, MY_ID); });
    [
      { t: 'act', kind: 'pick', id: 1 }, { t: 'act', kind: 'fuse', id: 0 },
      { t: 'door', id: 112 }, { t: 'broadcast', op: 'code', code: '1234' },
      { t: 'gym', complete: true }, { t: 'exam', passed: true }, { t: 'completed', members: [{ id: MY_ID, escaped: true }] },
    ].forEach(m => s.receive(m, MY_ID));
    expect(s.model().entries).toEqual([]);
    expect(s.model().lead).toBe(STORY_CHAPTERS[level].lead);
    s.receive(confirmations[level], MY_ID); s.receive(confirmations[level], MY_ID);
    expect(kind(s, 'confirmed')).toEqual([expect.objectContaining({ id: `${level}:confirmed`, text: STORY_CHAPTERS[level].confirmed })]);
    expect(s.model().lead).toBe(STORY_CHAPTERS[level].confirmed);
    expect(s.model().entries[0].source).not.toMatch(/服务器|快照|协议/);
  });

  it('distinguishes possession, installed power, personal door progress, and actual stop state', () => {
    const partials = [
      [{ t: 'bag', bag: { door_key: 3, stair_key: 0 } }, { t: 'bag', bag: { stair_key: Infinity } }],
      [{ t: 'bag', bag: { fuse: 3 } }, { t: 'power', n: 2 }, { t: 'power', n: Infinity }],
      [{ t: 'loop', players: [{ id: 99, step: 4 }, { id: MY_ID, step: 3 }] }],
      [{ t: 'broadcast', off: false, clues: ['1', '2', '3', '4'] }],
    ];
    partials.forEach((messages, level) => {
      const s = at(level); messages.forEach(m => s.receive(m, MY_ID));
      expect(kind(s, 'confirmed')).toEqual([]);
    });
  });

  it('later chapters confirm only their own actual authority message and retain the final exit record', () => {
    const later = [
      { t: 'gym', complete: true }, { t: 'exam', passed: true },
      { t: 'l7', key: { taken: true } }, { t: 'finale', phase: 'chase' },
    ];
    for (let i = 4; i < 8; i++) {
      const s = at(i);
      confirmations.forEach(m => s.receive(m, MY_ID));
      [
        ...later.filter((_, j) => j !== i - 4),
        { t: 'gym', complete: false }, { t: 'exam', passed: false },
        { t: 'l7', key: { taken: false } }, { t: 'finale', phase: 'rollcall' },
        { t: 'act', kind: 'gym-switch', id: 0 }, { t: 'act', kind: 'mirror-key', id: 0 },
      ].forEach(m => s.receive(m, MY_ID));
      expect(s.model().entries).toEqual([]);
      s.receive(later[i - 4], MY_ID); s.receive(later[i - 4], MY_ID);
      expect(kind(s, 'confirmed')).toEqual([expect.objectContaining({ text: STORY_CHAPTERS[i].confirmed })]);
      if (i === 7) {
        s.receive({ t: 'completed', members: [{ id: MY_ID, escaped: true }] }, MY_ID);
        expect(s.model().notice).toContain('已经越过校门');
      }
    }
  });

  it('records an actual L4 point-name event once, separately from paper and password progress', () => {
    const s = at(3);
    s.receive({ t: 'broadcast', op: 'read', id: 1 }, MY_ID);
    s.receive({ t: 'broadcast', off: false, call: null }, MY_ID);
    s.receive({ t: 'broadcast', off: false, call: { id: MY_ID, left: 0, shielded: false } }, MY_ID);
    expect(s.model().entries).toEqual([]);
    const call = { t: 'broadcast', off: false, clues: ['9', null, null, null], nextIn: 70, call: { id: MY_ID, left: 10, shielded: false } };
    s.receive(call, MY_ID); s.receive(call, MY_ID);
    expect(kind(s, 'broadcast')).toEqual([expect.objectContaining({ id: '3:broadcast', source: '刚才的广播', text: expect.stringContaining('你的名字') })]);
    expect(kind(s, 'note')).toEqual([]);
    expect(kind(s, 'confirmed')).toEqual([]);
    expect(s.model().lead).toBe(STORY_CHAPTERS[3].lead);
    expect(kind(s, 'broadcast')[0].text).not.toMatch(/9|密码|角色074说/);
    const other = at(2); other.receive(call, MY_ID);
    expect(other.model().entries).toEqual([]);
    const shielded = at(3); shielded.receive({ ...call, call: { id: 99, left: 8, shielded: true } }, MY_ID);
    expect(kind(shielded, 'broadcast')[0].text).toContain('挡住了这次信号');
  });

  it('ignores malformed input and never turns the last available chapter into an escape ending', () => {
    const s = at(3);
    [null, undefined, 1, [], {}, { t: 'power', n: '3' }, { t: 'loop', players: [null] }].forEach(m => s.receive(m, MY_ID));
    s.receive({ t: 'complete', level: 2 }, MY_ID);
    expect(s.model().entries).toEqual([]);
    expect(s.model().notice).toBeUndefined();
    s.receive({ t: 'complete', level: 3 }, MY_ID);
    expect(s.model().notice).toContain('校门还在前面');
    expect(s.model().entries).toEqual([]);
    expect(s.model().recap).not.toMatch(/逃出|离校完成|结局/);
  });
});

describe('chapter, attempt and room continuity', () => {
  it('joining a later chapter does not manufacture past reading or completions', () => {
    const s = at(3);
    expect(s.model().entries).toEqual([]);
    expect(s.model().recap).toBe('还没有上一段通路的记录。');
    expect(JSON.stringify(s.model())).not.toContain(STORY_CHAPTERS[4].name);
  });

  it('recaps only a successful fade followed by the exact adjacent real chapter', () => {
    const s = at(0);
    s.receive({ t: 'fade', restart: false }, MY_ID);
    expect(kind(s, 'recap')).toEqual([]);
    expect(s.enter(0, names[0], 71)).toBe(false);
    s.enter(1, names[1], 71);
    expect(s.model().recap).toBe(STORY_CHAPTERS[0].recap);
    expect(kind(s, 'recap')).toEqual([expect.objectContaining({ id: '0:recap', chapter: `第1章 · ${names[0]}` })]);
    expect(s.enter(1, names[1], 71)).toBe(false);
    expect(kind(s, 'recap')).toHaveLength(1);
  });

  it.each(['no-fade', 'restart', 'skip', 'unknown', 'new-seed', 'complete'])('does not turn %s into an adjacent recap', condition => {
    const s = at(0);
    if (condition !== 'no-fade' && condition !== 'complete') s.receive({ t: 'fade', restart: condition === 'restart' }, MY_ID);
    if (condition === 'complete') s.receive({ t: 'complete', level: 0 }, MY_ID);
    if (condition === 'skip') s.enter(2, names[2], 71);
    else if (condition === 'unknown') { s.enter(99, names[1], 71); s.enter(1, names[1], 71); }
    else if (condition === 'new-seed') { s.enter(0, names[0], 72); s.enter(1, names[1], 72); }
    else s.enter(1, names[1], 71);
    expect(kind(s, 'recap')).toEqual([]);
  });

  it('a restart preserves excerpts and clears the current confirmation even with the same seed', () => {
    const s = at(1);
    s.readNote(); s.receive(confirmations[1], MY_ID);
    s.receive({ t: 'fade', restart: true }, MY_ID);
    expect(s.enter(1, names[1], 71)).toBe(false);
    expect(kind(s, 'note')).toHaveLength(1);
    expect(kind(s, 'confirmed')).toEqual([]);
    expect(s.model().lead).toBe(STORY_CHAPTERS[1].lead);
    expect(s.model().notice).toContain('重新走完');
    s.receive(confirmations[1], MY_ID);
    expect(kind(s, 'confirmed')).toHaveLength(1);
    expect(s.model().lead).toBe(STORY_CHAPTERS[1].confirmed);
    s.enter(1, names[1], 72);
    expect(kind(s, 'confirmed')).toEqual([]);
    expect(kind(s, 'note')).toHaveLength(1);
    expect(s.model().lead).toBe(STORY_CHAPTERS[1].lead);
  });

  it('same-room messages preserve records; another room clears records and pending transitions', () => {
    const s = at(0);
    s.receive({ t: 'room', code: 'ABCD' }, MY_ID); s.readNote();
    s.receive({ t: 'fade', restart: false }, MY_ID);
    s.receive({ t: 'room', code: 'ABCD' }, MY_ID);
    expect(kind(s, 'note')).toHaveLength(1);
    s.receive({ t: 'room', code: 'WXYZ' }, MY_ID);
    s.enter(1, names[1], 71);
    expect(s.model().entries).toEqual([]);
    expect(s.model().recap).toBe('还没有上一段通路的记录。');
  });
});

describe('nearby physical reading', () => {
  const site: StorySite = { p: [0, 1.5, 0], normal: [0, 0, -1] };
  it('requires server position, correct floor, written face, gaze and unblocked sight', () => {
    expect(canReadStory(site, [0, 0, -2], Math.PI, true)).toBe(true);
    expect(canReadStory(site, [0, 0, -2.1], Math.PI, true)).toBe(false);
    expect(canReadStory(site, [0, 3.6, -1], Math.PI, true)).toBe(false);
    expect(canReadStory(site, [0, 0, 1], 0, true)).toBe(false);
    expect(canReadStory(site, [0, 0, -1], 0, true)).toBe(false);
    expect(canReadStory(site, [0, 0, -1], Math.PI, false)).toBe(false);
  });
  it('works for every wall direction and rejects nonfinite positions and angles', () => {
    for (const n of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]] as const) {
      const s: StorySite = { p: [10, 5.1, 20], normal: [...n] };
      expect(canReadStory(s, [10 + n[0], 3.6, 20 + n[2]], Math.atan2(n[0], n[2]), true)).toBe(true);
    }
    for (const v of [NaN, Infinity, -Infinity]) {
      expect(canReadStory(site, [v, 0, -1], Math.PI, true)).toBe(false);
      expect(canReadStory(site, [0, 0, -1], v, true)).toBe(false);
    }
    expect(canReadStory(site, [0, 0], Math.PI, true)).toBe(false);
  });
});
