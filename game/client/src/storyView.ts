import './story.css';

export interface StoryViewModel {
  chapter: string;
  recap: string;
  lead: string;
  entries: { id: string; chapter: string; title: string; source: string; text: string; kind?: string; level?: number }[];
  notice?: string;
}

export type StoryRecordScope = 'all' | 'current';

export interface StoryDisplayText {
  chapter: string;
  recap: string;
  lead: string;
  entries: StoryViewModel['entries'];
  notice: string;
  count: string;
  button: string;
  result: string;
  empty: string;
}

/** Present only the supplied discoveries: this view never reads the complete story catalogue. */
export function storyViewText(model: StoryViewModel, scope: StoryRecordScope = 'all'): StoryDisplayText {
  const seen = new Set<string>();
  const chapter = model.chapter.trim() || '当前章节';
  const entries = model.entries.filter((entry) => {
    if (!entry.text.trim() || seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  }).map((entry) => ({
    ...entry,
    chapter: entry.chapter.trim() || chapter,
    title: entry.title.trim() || '现场记录',
    source: entry.source.trim() || '来源未署名',
  }));
  const visibleEntries = scope === 'current' ? entries.filter((entry) => entry.chapter === chapter) : entries;
  return {
    chapter,
    recap: model.recap.trim() || '回顾会随着探索更新。',
    lead: model.lead.trim() || '留意身边的纸条、广播和异常。',
    entries: visibleEntries,
    notice: model.notice?.trim() ?? '',
    count: `已发现记录 · ${entries.length}`,
    button: `线索本 [J] · ${entries.length}`,
    result: scope === 'current' ? `显示 ${visibleEntries.length} / ${entries.length} 条` : `显示 ${entries.length} 条`,
    empty: scope === 'current'
      ? entries.length ? '本章还没有记录。切换“全部记录”回看。' : '本章还没有发现记录。'
      : '还没有发现记录。继续探索。',
  };
}

export interface StoryHint { kind: 'notice' | 'recap'; text: string }

/** Ignore repeated snapshots and first-entry recaps; only genuine changes deserve a new short hint. */
export function selectStoryHint(previous: StoryViewModel | undefined, current: StoryViewModel): StoryHint | undefined {
  const notice = current.notice?.trim() ?? '';
  if (notice && notice !== (previous?.notice?.trim() ?? '')) return { kind: 'notice', text: notice };
  const recap = current.recap.trim();
  if (previous && previous.chapter.trim() && current.chapter.trim() !== previous.chapter.trim()
    && recap && recap !== previous.recap.trim() && !/^(尚无|暂无|回顾会随着|还没有上一段通路的记录)/u.test(recap)) {
    return { kind: 'recap', text: recap };
  }
  return undefined;
}

let nextStoryViewId = 0;

export interface StoryReadTarget { id: string; title: string; x?: number; y?: number }

/** A small notebook: the world keeps running, and the game owns movement availability. */
export class StoryView {
  onOpenChange?: (open: boolean) => void;
  onRead?: () => void;
  private readonly root: HTMLDivElement;
  private readonly button: HTMLButtonElement;
  private readonly readButton: HTMLButtonElement;
  private readonly panel: HTMLElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly chapter: HTMLElement;
  private readonly recap: HTMLParagraphElement;
  private readonly lead: HTMLParagraphElement;
  private readonly notice: HTMLParagraphElement;
  private readonly count: HTMLElement;
  private readonly allRecords: HTMLButtonElement;
  private readonly currentRecords: HTMLButtonElement;
  private readonly result: HTMLParagraphElement;
  private readonly entries: HTMLDivElement;
  private readonly scroll: HTMLDivElement;
  private readonly toast: HTMLParagraphElement;
  private readonly document: Document;
  private open = false;
  private destroyed = false;
  private renderedEntries = '';
  private scope: StoryRecordScope = 'all';
  private currentView?: StoryDisplayText;
  private previousModel?: StoryViewModel;
  private hintTimer?: ReturnType<typeof setTimeout>;
  private recordCount = 0;
  private visible = true;
  private candidate?: StoryReadTarget;

  constructor(host: HTMLElement) {
    this.document = host.ownerDocument;
    const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) => {
      const element = this.document.createElement(tag);
      element.className = className;
      if (text !== undefined) element.textContent = text;
      return element;
    };
    const id = `story-view-${++nextStoryViewId}`;
    this.root = make('div', 'story-view');
    this.button = make('button', 'story-view__toggle', '线索本 [J]');
    this.button.type = 'button';
    this.button.setAttribute('aria-label', '打开线索本，快捷键 J');
    this.button.setAttribute('aria-expanded', 'false');
    this.button.setAttribute('aria-controls', id);
    this.toast = make('p', 'story-view__toast');
    this.toast.hidden = true;
    this.toast.setAttribute('role', 'status');
    this.toast.setAttribute('aria-atomic', 'true');
    this.readButton = make('button', 'story-view__read');
    this.readButton.type = 'button';
    this.readButton.hidden = true;

    this.panel = make('section', 'story-view__panel');
    this.panel.id = id;
    this.panel.hidden = true;
    this.panel.tabIndex = -1;
    this.panel.setAttribute('role', 'region');
    this.panel.setAttribute('aria-labelledby', `${id}-title`);
    this.panel.setAttribute('aria-describedby', `${id}-help`);

    const header = make('div', 'story-view__header');
    const title = make('h2', 'story-view__title', '线索本');
    title.id = `${id}-title`;
    this.closeButton = make('button', 'story-view__close', '关闭 ×');
    this.closeButton.type = 'button';
    this.closeButton.setAttribute('aria-label', '关闭记录，继续探索');
    header.append(title, this.closeButton);

    const help = make('p', 'story-view__help', '阅读时学校里的动静仍会继续。关闭后继续探索。');
    help.id = `${id}-help`;
    this.scroll = make('div', 'story-view__scroll');
    this.scroll.tabIndex = 0;
    this.scroll.setAttribute('aria-label', '章节回顾与已发现记录，可滚动阅读');
    this.chapter = make('h3', 'story-view__chapter');
    this.recap = make('p', 'story-view__recap');
    this.lead = make('p', 'story-view__lead');
    this.notice = make('p', 'story-view__notice');
    this.notice.hidden = true;
    this.notice.setAttribute('role', 'status');
    this.count = make('h3', 'story-view__count');
    this.entries = make('div', 'story-view__entries');
    this.entries.id = `${id}-entries`;
    const filters = make('div', 'story-view__filters');
    filters.setAttribute('role', 'group');
    filters.setAttribute('aria-label', '记录范围');
    this.allRecords = make('button', 'story-view__filter', '全部记录');
    this.currentRecords = make('button', 'story-view__filter', '当前章');
    for (const button of [this.allRecords, this.currentRecords]) {
      button.type = 'button';
      button.setAttribute('aria-controls', this.entries.id);
    }
    this.result = make('p', 'story-view__result');
    this.result.setAttribute('role', 'status');
    this.result.setAttribute('aria-atomic', 'true');
    filters.append(this.allRecords, this.currentRecords, this.result);
    const recapLabel = make('h4', 'story-view__label', '来路');
    const leadLabel = make('h4', 'story-view__label', '接下来');
    this.scroll.append(this.chapter, recapLabel, this.recap, leadLabel, this.lead, this.notice, this.count, filters, this.entries);
    this.panel.append(header, help, this.scroll);
    this.root.append(this.button, this.readButton, this.panel, this.toast);
    this.button.addEventListener('click', this.onToggle);
    this.closeButton.addEventListener('click', this.onClose);
    this.allRecords.addEventListener('click', this.onAllRecords);
    this.currentRecords.addEventListener('click', this.onCurrentRecords);
    this.panel.addEventListener('click', this.onPanelClick);
    this.readButton.addEventListener('click', this.onReadClick);
    this.root.addEventListener('keydown', this.onKeyDown);
    this.root.addEventListener('keyup', this.onKeyUp);
    this.root.addEventListener('pointerdown', this.stopEvent);
    this.root.addEventListener('pointerup', this.stopEvent);
    this.root.addEventListener('touchstart', this.stopEvent, { passive: true });
    this.root.addEventListener('touchmove', this.stopEvent, { passive: true });
    this.root.addEventListener('touchend', this.stopEvent, { passive: true });
    host.appendChild(this.root);
    this.update({ chapter: '', recap: '', lead: '', entries: [] });
    // The constructor's empty placeholder is not an actual previously visited chapter.
    this.previousModel = undefined;
  }

  update(model: StoryViewModel): void {
    if (this.destroyed) return;
    const view = storyViewText(model);
    const hint = selectStoryHint(this.previousModel, view);
    this.previousModel = view;
    this.currentView = view;
    this.recordCount = view.entries.length;
    this.button.textContent = view.button;
    this.updateButtonLabel();
    if (hint && !this.open && this.visible) this.showHint(hint);
    this.chapter.textContent = view.chapter;
    this.recap.textContent = view.recap;
    this.lead.textContent = view.lead;
    this.notice.textContent = view.notice;
    this.notice.hidden = !view.notice;
    this.count.textContent = view.count;
    this.renderRecords();
  }

  private renderRecords(): void {
    if (!this.currentView) return;
    const view = storyViewText(this.currentView, this.scope);
    this.allRecords.setAttribute('aria-pressed', String(this.scope === 'all'));
    this.currentRecords.setAttribute('aria-pressed', String(this.scope === 'current'));
    if (this.result.textContent !== view.result) this.result.textContent = view.result;

    // Snapshot updates should not interrupt an ongoing read or reset the scroll position.
    const key = JSON.stringify([this.scope, view.entries, view.empty]);
    if (key === this.renderedEntries) return;
    this.renderedEntries = key;
    const scrollTop = this.scroll.scrollTop;
    const cards = view.entries.map((entry) => {
      const card = this.document.createElement('article');
      card.className = 'story-view__entry';
      card.dataset.storyId = entry.id;
      const chapter = this.document.createElement('p');
      chapter.className = 'story-view__entry-chapter';
      chapter.textContent = entry.chapter;
      const title = this.document.createElement('h4');
      title.className = 'story-view__entry-title';
      title.textContent = entry.title;
      const source = this.document.createElement('p');
      source.className = 'story-view__source';
      source.textContent = `来源：${entry.source}`;
      const text = this.document.createElement('p');
      text.className = 'story-view__text';
      text.textContent = entry.text;
      card.append(chapter, title, source, text);
      return card;
    });
    if (cards.length) this.entries.replaceChildren(...cards);
    else {
      const empty = this.document.createElement('p');
      empty.className = 'story-view__empty';
      empty.textContent = view.empty;
      this.entries.replaceChildren(empty);
    }
    this.scroll.scrollTop = scrollTop;
  }

  toggle(force?: boolean): void {
    if (this.destroyed) return;
    const next = force ?? !this.open;
    if (next && !this.visible) return;
    if (next === this.open) return;
    // Hiding a focused section can move activeElement to body before focus is restored.
    const hadPanelFocus = this.panel.contains(this.document.activeElement);
    this.open = next;
    this.panel.hidden = !next;
    this.button.setAttribute('aria-expanded', String(next));
    this.updateButtonLabel();
    this.button.classList.toggle('is-open', next);
    this.readButton.hidden = next || !this.candidate;
    if (next) {
      this.clearHint();
      // Pointer lock is optional and can reject in inactive documents. Never let that block reading.
      try {
        if (this.document.pointerLockElement && this.document.exitPointerLock) {
          const exit = this.document.exitPointerLock as () => void | Promise<void>;
          void exit.call(this.document)?.catch(() => {});
        }
      } catch { /* Keyboard and touch controls remain owned by the game. */ }
      this.panel.focus({ preventScroll: true });
    } else if (hadPanelFocus) {
      this.button.focus({ preventScroll: true });
    }
    this.onOpenChange?.(next);
  }

  get isOpen(): boolean { return this.open; }

  /** Updates only an eligible nearby fragment, never a list of undiscovered story content. */
  setCandidate(target?: StoryReadTarget): void {
    this.candidate = target;
    this.readButton.hidden = !target || this.open || !this.visible;
    if (!target) return;
    this.readButton.textContent = `查看 · ${target.title}`;
    this.readButton.setAttribute('aria-label', `查看${target.title}，也可按 E`);
    this.readButton.style.left = `${target.x ?? 50}%`;
    this.readButton.style.top = `${target.y ?? 52}%`;
  }

  showEntry(id: string): void {
    if (this.destroyed) return;
    this.setScope('current');
    this.toggle(true);
    const card = Array.from(this.entries.children).find((entry) => (entry as HTMLElement).dataset.storyId === id);
    card?.scrollIntoView?.({ block: 'nearest' });
  }

  setVisible(visible: boolean): void {
    if (this.destroyed) return;
    if (!visible) { this.toggle(false); this.clearHint(); this.setCandidate(); }
    this.visible = visible;
    this.root.hidden = !visible;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.open) this.onOpenChange?.(false);
    this.open = false;
    this.clearHint();
    this.button.removeEventListener('click', this.onToggle);
    this.closeButton.removeEventListener('click', this.onClose);
    this.allRecords.removeEventListener('click', this.onAllRecords);
    this.currentRecords.removeEventListener('click', this.onCurrentRecords);
    this.panel.removeEventListener('click', this.onPanelClick);
    this.readButton.removeEventListener('click', this.onReadClick);
    this.root.removeEventListener('keydown', this.onKeyDown);
    this.root.removeEventListener('keyup', this.onKeyUp);
    this.root.removeEventListener('pointerdown', this.stopEvent);
    this.root.removeEventListener('pointerup', this.stopEvent);
    this.root.removeEventListener('touchstart', this.stopEvent);
    this.root.removeEventListener('touchmove', this.stopEvent);
    this.root.removeEventListener('touchend', this.stopEvent);
    this.root.remove();
  }

  private updateButtonLabel(): void {
    this.button.setAttribute('aria-label', `${this.open ? '关闭' : '打开'}线索本，已发现 ${this.recordCount} 条，快捷键 J`);
  }

  private showHint(hint: StoryHint): void {
    this.clearHint();
    this.toast.textContent = hint.kind === 'recap' ? `回顾：${hint.text}` : hint.text;
    this.toast.hidden = false;
    this.hintTimer = setTimeout(() => {
      this.toast.hidden = true;
      this.hintTimer = undefined;
    }, 6_000);
  }

  private clearHint(): void {
    if (this.hintTimer !== undefined) clearTimeout(this.hintTimer);
    this.hintTimer = undefined;
    this.toast.hidden = true;
  }

  private readonly onToggle = (event: MouseEvent): void => { event.stopPropagation(); this.toggle(); };
  private readonly onClose = (event: MouseEvent): void => { event.stopPropagation(); this.toggle(false); };
  private readonly onAllRecords = (event: MouseEvent): void => { event.stopPropagation(); this.setScope('all'); };
  private readonly onCurrentRecords = (event: MouseEvent): void => { event.stopPropagation(); this.setScope('current'); };
  private readonly onPanelClick = (event: MouseEvent): void => { event.stopPropagation(); };
  private readonly onReadClick = (event: MouseEvent): void => { event.stopPropagation(); if (this.candidate) this.onRead?.(); };
  private readonly stopEvent = (event: Event): void => { event.stopPropagation(); };
  private ownsKey(event: KeyboardEvent): boolean {
    // Closing restores focus to the toggle. Movement and interaction keys must then reach Input again.
    return this.open || event.key === 'Escape' || event.code === 'KeyJ'
      || event.key === 'Enter' || event.code === 'Space' || event.code === 'Tab';
  }
  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (this.ownsKey(event)) event.stopPropagation();
  };
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    // Native Enter/Space still activate controls; their events cannot become chat or game actions.
    if (!this.ownsKey(event)) return;
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); this.toggle(false); }
    else if (event.code === 'KeyJ') { event.preventDefault(); if (!event.repeat) this.toggle(); }
  };

  private setScope(scope: StoryRecordScope): void {
    if (this.destroyed || this.scope === scope) return;
    this.scope = scope;
    this.renderRecords();
  }
}
