import { describe, expect, it } from 'vitest';
import { selectStoryHint, storyViewText } from '../../client/src/storyView.ts';
import type { StoryViewModel } from '../../client/src/storyView.ts';

const record = (id: string, chapter = '第一章 · 夜校') => ({
  id, chapter, title: '值日簿', source: '讲台', text: '最后一页写着：先去楼梯。',
});
const model = (entries: StoryViewModel['entries']): StoryViewModel => ({
  chapter: '第二章 · 借来的钥匙', recap: '我们离开了教室。', lead: '钥匙上的编号与门牌一致。', entries,
});

describe('storyViewText', () => {
  it('only presents discoveries supplied by the model, with their original chapter labels', () => {
    const view = storyViewText(model([record('found-in-classroom')]));
    expect(view.chapter).toBe('第二章 · 借来的钥匙');
    expect(view.entries).toHaveLength(1);
    expect(view.entries[0]).toEqual(record('found-in-classroom'));
    expect(view.count).toBe('已发现记录 · 1');
    expect(view.button).toBe('线索本 [J] · 1');
    expect(view.recap).toBe('我们离开了教室。');
    expect(view.lead).toBe('钥匙上的编号与门牌一致。');
  });

  it('deduplicates discovered record ids without reordering or mutating the model', () => {
    const input = model([record('b'), record('a'), { ...record('b'), text: '重复收到的快照' }]);
    const before = structuredClone(input);
    const view = storyViewText(input);
    expect(view.entries.map((entry) => entry.id)).toEqual(['b', 'a']);
    expect(view.button).toBe('线索本 [J] · 2');
    expect(view.entries[0]?.text).toBe('最后一页写着：先去楼梯。');
    expect(input).toEqual(before);
    expect(view.entries[0]).not.toBe(input.entries[0]);
  });

  it('does not count empty records and gives a discovery-neutral empty state', () => {
    const view = storyViewText({ chapter: ' ', recap: '', lead: ' ', entries: [{ ...record('blank'), text: '\n  ' }] });
    expect(view.entries).toEqual([]);
    expect(view.count).toBe('已发现记录 · 0');
    expect(view.button).toBe('线索本 [J] · 0');
    expect(view.chapter).toBe('当前章节');
    expect(view.recap).toBeTruthy();
    expect(view.lead).toBeTruthy();
    expect(view.notice).toBe('');
  });

  it('keeps narrative text and markup literal for the textContent renderer', () => {
    const text = '<img src=x onerror=alert(1)>\n  纸条没有署名。';
    const view = storyViewText({ ...model([{ ...record('paper'), text }]), notice: '  新的记录已保存。  ' });
    expect(view.entries[0]?.text).toBe(text);
    expect(view.notice).toBe('新的记录已保存。');
  });

  it('falls back to the current chapter only when a supplied record has no chapter label', () => {
    const view = storyViewText(model([{ ...record('paper', ' '), title: ' ', source: ' ' }]));
    expect(view.entries[0]?.chapter).toBe(view.chapter);
    expect(view.entries[0]?.title).toBe('现场记录');
    expect(view.entries[0]?.source).toBe('来源未署名');
  });

  it('defaults to all discoveries and filters the current chapter without changing discovery counts or the recap', () => {
    const input = model([record('old'), record('here', '第二章 · 借来的钥匙')]);
    const before = structuredClone(input);
    const all = storyViewText(input);
    const current = storyViewText(input, 'current');
    expect(all.entries.map((entry) => entry.id)).toEqual(['old', 'here']);
    expect(all.result).toBe('显示 2 条');
    expect(current.entries.map((entry) => entry.id)).toEqual(['here']);
    expect(current.result).toBe('显示 1 / 2 条');
    expect(current.count).toBe(all.count);
    expect(current.button).toBe(all.button);
    expect(current.recap).toBe(all.recap);
    expect(current.lead).toBe(all.lead);
    expect(storyViewText(input, 'all').entries).toEqual(all.entries);
    expect(input).toEqual(before);
  });

  it('distinguishes no current discoveries from no discoveries anywhere and never invents future entries', () => {
    const input = model([record('old')]);
    const current = storyViewText(input, 'current');
    expect(current.entries).toEqual([]);
    expect(current.result).toBe('显示 0 / 1 条');
    expect(current.empty).toBe('本章还没有记录。切换“全部记录”回看。');
    expect(current.button).toBe('线索本 [J] · 1');
    expect(storyViewText(input, 'all').entries).toEqual([record('old')]);
    expect(storyViewText(model([]), 'current').empty).toBe('本章还没有发现记录。');
    expect(storyViewText(model([]), 'all').empty).toBe('还没有发现记录。继续探索。');
  });

  it('matches normalized chapter labels after validation and deduplication, including the existing blank-label fallback', () => {
    const currentChapter = '第二章 · 借来的钥匙';
    const input = { ...model([
      record('same', '第一章 · 夜校'),
      record('same', currentChapter),
      { ...record('empty', currentChapter), text: '  ' },
      record('trimmed', ` ${currentChapter} `),
      record('fallback', ' '),
    ]), chapter: ` ${currentChapter} ` };
    const current = storyViewText(input, 'current');
    expect(current.entries.map((entry) => entry.id)).toEqual(['trimmed', 'fallback']);
    expect(current.entries.every((entry) => entry.chapter === currentChapter)).toBe(true);
    expect(current.count).toBe('已发现记录 · 3');
    expect(current.result).toBe('显示 2 / 3 条');
  });

  it('re-evaluates a retained current-chapter selection against the new model while keeping old discoveries available', () => {
    const known = [record('one'), record('two', '第二章 · 借来的钥匙')];
    const second = model(known);
    expect(storyViewText(second, 'current').entries.map((entry) => entry.id)).toEqual(['two']);
    const third = { ...second, chapter: '第三章 · 走廊' };
    expect(storyViewText(third, 'current').entries).toEqual([]);
    expect(storyViewText(third, 'current').button).toBe('线索本 [J] · 2');
    expect(storyViewText(third, 'all').entries.map((entry) => entry.id)).toEqual(['one', 'two']);
    const discovery = { ...third, entries: [...known, record('three', third.chapter)] };
    expect(storyViewText(discovery, 'current').entries.map((entry) => entry.id)).toEqual(['three']);
    expect(storyViewText(discovery, 'current').result).toBe('显示 1 / 3 条');
  });
});

describe('selectStoryHint', () => {
  it('stays quiet with no discovery and ignores repeated snapshots of the same notice', () => {
    const empty = model([]);
    expect(selectStoryHint(undefined, empty)).toBeUndefined();
    expect(selectStoryHint(empty, structuredClone(empty))).toBeUndefined();
    const found = { ...model([record('paper')]), notice: '已摘录 · 值日簿' };
    expect(selectStoryHint(empty, found)).toEqual({ kind: 'notice', text: '已摘录 · 值日簿' });
    expect(selectStoryHint(found, structuredClone(found))).toBeUndefined();
  });

  it('does not re-announce duplicated records or inflate their button count', () => {
    const previous = { ...model([record('paper')]), notice: '已摘录 · 值日簿' };
    const duplicate = { ...previous, entries: [record('paper'), record('paper')] };
    expect(selectStoryHint(previous, duplicate)).toBeUndefined();
    expect(storyViewText(duplicate).button).toBe('线索本 [J] · 1');
  });

  it('does not fabricate a recap on the first real model, even if it contains recap text', () => {
    expect(selectStoryHint(undefined, model([record('old-record')]))).toBeUndefined();
  });

  it('selects a changed confirmed recap only after the chapter has changed', () => {
    const previous = { ...model([]), chapter: '第一章 · 夜校', recap: '尚无已确认的上一章记录。' };
    const next = model([record('recap')]);
    expect(selectStoryHint(previous, next)).toEqual({ kind: 'recap', text: '我们离开了教室。' });
    expect(selectStoryHint(next, structuredClone(next))).toBeUndefined();
    expect(selectStoryHint(next, { ...next, recap: '尚无已确认的上一章记录。' })).toBeUndefined();
    expect(selectStoryHint(next, { ...next, recap: '同章内更新了回顾。' })).toBeUndefined();
  });

  it('ignores empty or default recaps on a chapter change', () => {
    const previous = { ...model([]), chapter: '第一章 · 夜校' };
    for (const recap of ['', ' ', '尚无已确认的上一章记录。', '暂无回顾。', '回顾会随着探索更新。', '还没有上一段通路的记录。']) {
      expect(selectStoryHint(previous, { ...model([]), recap })).toBeUndefined();
    }
  });

  it('prioritizes a fresh notice over a simultaneous recap and trims display whitespace', () => {
    const previous = { ...model([]), chapter: '第一章 · 夜校' };
    const current = { ...model([record('paper')]), notice: '  已摘录 · 新纸条  ', recap: '刚刚确认了新的通路。' };
    expect(selectStoryHint(previous, current)).toEqual({ kind: 'notice', text: '已摘录 · 新纸条' });
    expect(selectStoryHint(current, { ...current, notice: '' })).toBeUndefined();
  });
});
