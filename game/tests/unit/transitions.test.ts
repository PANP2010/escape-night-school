import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chapterLabel, LevelTransitions } from '../../client/src/transitions.ts';

class Classes {
  values = new Set<string>();
  add(...values: string[]) { values.forEach((v) => this.values.add(v)); }
  remove(...values: string[]) { values.forEach((v) => this.values.delete(v)); }
  contains(value: string) { return this.values.has(value); }
}
class Element {
  hidden = true;
  textContent = '';
  className = '';
  classList = new Classes();
  children: Element[] = [];
  attributes: Record<string, string> = {};
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  append(element: Element) { this.children.push(element); }
  replaceChildren(...elements: Element[]) { this.children = elements; }
}
let body: Element;
let root: Element;
let view: LevelTransitions;
const copy = () => root.children.map((e) => e.textContent).join(' · ');
beforeEach(() => {
  vi.useFakeTimers(); body = new Element(); root = new Element();
  vi.stubGlobal('document', { body, createElement: () => new Element(), createTextNode: (text: string) => Object.assign(new Element(), { textContent: text }) });
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  view = new LevelTransitions(root as unknown as HTMLElement);
});
afterEach(() => { view.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('level presentation handoff', () => {
  it('only describes existing chapters and gives unknown chapters a neutral lead', () => {
    expect(chapterLabel(1, '二楼·停电').detail).toContain('灯熄了');
    expect(chapterLabel(2, '三楼·无尽走廊').detail).toContain('门牌');
    expect(chapterLabel(3, '广播站').detail).toContain('编号贴纸');
    expect(chapterLabel(7, '测试章节').detail).toBe('和队友一起继续探索');
    expect(chapterLabel(0, '一楼', true).detail).toContain('再一起出发');
  });

  it('waits for the next authoritative spawn and restores presentation without owning input', () => {
    view.begin(3, 0, '一楼·晚自习后');
    expect(root.hidden).toBe(false); expect(copy()).toContain('逃出去了');
    view.spawned(); expect(root.hidden).toBe(false); // Last level snapshots do not reveal early.
    view.arrive(1, '二楼·停电'); expect(copy()).toContain('二楼·停电');
    expect(body.classList.contains('level-handoff')).toBe(true);
    view.spawned(); expect(root.hidden).toBe(true);
    expect(body.classList.contains('level-handoff')).toBe(false);
    vi.advanceTimersByTime(10_000); expect(root.hidden).toBe(true);
  });

  it('has a bounded fallback if the next room or snapshot never arrives', () => {
    view.begin(3, 0, '一楼');
    vi.advanceTimersByTime(4199); expect(root.hidden).toBe(false);
    vi.advanceTimersByTime(1); expect(root.hidden).toBe(true);
    expect(body.classList.contains('level-handoff')).toBe(false);
  });

  it('a repeated handoff cancels the older timer; completion stays visible', () => {
    view.begin(3, 0, '一楼'); vi.advanceTimersByTime(3000);
    view.begin(3, 0, '一楼', true); vi.advanceTimersByTime(1200);
    expect(root.hidden).toBe(false); expect(copy()).toContain('全员出局');
    expect(root.classList.contains('wipe')).toBe(true);
    view.complete('三楼通关 · 后续楼层尚未开放'); vi.advanceTimersByTime(10_000);
    expect(root.classList.contains('wipe')).toBe(false);
    expect(root.hidden).toBe(false); expect(copy()).toContain('尚未开放');
    expect(root.classList.contains('complete')).toBe(true);
  });

  it('disposal clears the timer and never displays future messages', () => {
    view.begin(3, 0, '一楼'); view.dispose(); view.dispose();
    expect(vi.getTimerCount()).toBe(0); expect(root.hidden).toBe(true);
    view.begin(3, 1, '二楼'); view.complete('done'); view.arrive(1, '二楼'); view.spawned();
    expect(root.hidden).toBe(true);
  });
});
