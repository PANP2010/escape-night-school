import './settings.css';
import type { FeedbackPreferences, FeedbackSettings } from './feedbackSettings.ts';

/** Preserve the existing sound key while all controls live in one settings dialog. */
export interface GamePreferences {
  sensitivity: number;
  pixelRatio: 1 | 1.5;
  postprocessing: boolean;
  interactionHighlights: boolean;
}

export type SettingsCloseReason = 'button' | 'escape' | 'backdrop' | 'programmatic';
export interface GameSettingsOptions {
  touch?: boolean;
  /** Clear game input before the dialog takes focus. */
  onOpen?: () => void;
  onClose?: (reason: SettingsCloseReason) => void;
  /** Applied immediately at construction, then on every preference change. */
  onChange?: (preferences: GamePreferences) => void;
}

const STORAGE_KEY = 'escape.settings';
const SENSITIVITY_MIN = 0.25, SENSITIVITY_MAX = 2.5;

/** Validate old, malformed, and untrusted storage without coercing strings into settings. */
export function gamePreferencesFrom(value: unknown, touch = false): GamePreferences {
  const p = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<GamePreferences> : {};
  return {
    sensitivity: typeof p.sensitivity === 'number' && Number.isFinite(p.sensitivity)
      ? Math.max(SENSITIVITY_MIN, Math.min(SENSITIVITY_MAX, p.sensitivity)) : 1,
    pixelRatio: p.pixelRatio === 1 || p.pixelRatio === 1.5 ? p.pixelRatio : touch ? 1 : 1.5,
    postprocessing: typeof p.postprocessing === 'boolean' ? p.postprocessing : !touch,
    interactionHighlights: typeof p.interactionHighlights === 'boolean' ? p.interactionHighlights : true,
  };
}

export function readGamePreferences(touch = false): GamePreferences {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return gamePreferencesFrom(raw ? JSON.parse(raw) : undefined, touch);
  } catch {
    return gamePreferencesFrom(undefined, touch);
  }
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]';

/** Native modal settings: keyboard focus stays inside, and closing returns it to the opener. */
export class GameSettings {
  private current: GamePreferences;
  private readonly feedback: FeedbackSettings;
  private readonly options: GameSettingsOptions;
  private readonly touch: boolean;
  private readonly dialog: HTMLDialogElement;
  private readonly opener: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly sensitivity: HTMLInputElement;
  private readonly sensitivityText: HTMLOutputElement;
  private readonly pixelRatio: HTMLSelectElement;
  private readonly postprocessing: HTMLInputElement;
  private readonly interactionHighlights: HTMLInputElement;
  private readonly volume: HTMLInputElement;
  private readonly volumeText: HTMLOutputElement;
  private readonly muted: HTMLInputElement;
  private readonly haptics: HTMLInputElement;
  private readonly cleanups: (() => void)[] = [];
  private readonly subscribers = new Set<(preferences: GamePreferences) => void>();
  private returnFocus: HTMLElement | null = null;
  private opened = false;
  private disposed = false;
  private ignoreEscapeUntil = 0;
  private feedbackPreferences: FeedbackPreferences;

  constructor(feedback: FeedbackSettings, options: GameSettingsOptions = {}) {
    this.feedback = feedback;
    this.options = options;
    this.touch = options.touch ?? ((typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches)
      || (typeof window !== 'undefined' && 'ontouchstart' in window));
    this.current = readGamePreferences(this.touch);
    this.feedbackPreferences = feedback.preferences;

    this.opener = document.createElement('button');
    this.opener.id = 'settings-open';
    this.opener.type = 'button';
    this.opener.textContent = '设置';
    this.opener.setAttribute('aria-haspopup', 'dialog');
    this.opener.setAttribute('aria-controls', 'game-settings');
    this.opener.setAttribute('aria-expanded', 'false');
    this.opener.title = this.touch ? '设置' : '设置（Esc）';

    this.dialog = document.createElement('dialog');
    this.dialog.id = 'game-settings';
    this.dialog.setAttribute('aria-labelledby', 'settings-title');
    this.dialog.setAttribute('aria-describedby', 'settings-description');
    this.dialog.setAttribute('aria-modal', 'true');
    this.dialog.tabIndex = -1;
    const heading = document.createElement('header');
    heading.className = 'settings-heading';
    const title = document.createElement('h2');
    title.id = 'settings-title';
    title.textContent = '夜校设置';
    this.closeButton = document.createElement('button');
    this.closeButton.id = 'settings-close';
    this.closeButton.type = 'button';
    this.closeButton.textContent = '返回游戏';
    heading.append(title, this.closeButton);
    const description = document.createElement('p');
    description.id = 'settings-description';
    description.textContent = '调整立即生效，并自动保存在这台设备。';
    const content = document.createElement('div');
    content.className = 'settings-content';

    const controls = this.section('操作');
    const sensitivityRow = this.range(controls, 'settings-sensitivity', '视角灵敏度',
      String(SENSITIVITY_MIN), String(SENSITIVITY_MAX), '0.05');
    this.sensitivity = sensitivityRow.input;
    this.sensitivityText = sensitivityRow.output;
    this.note(controls, '数值越大，鼠标移动或触屏拖动时转向越快。');

    const audio = this.section('声音与触感');
    const volumeRow = this.range(audio, 'settings-volume', '音效音量', '0', '1', '0.01');
    this.volume = volumeRow.input;
    this.volumeText = volumeRow.output;
    this.muted = this.checkbox(audio, 'settings-muted', '静音音效');
    this.haptics = this.checkbox(audio, 'settings-haptics', '开启触感');
    const hapticsNote = this.note(audio, '减少动态效果开启时不振动；部分设备不支持触感。');
    hapticsNote.id = 'settings-haptics-note';
    this.haptics.setAttribute('aria-describedby', hapticsNote.id);

    const graphics = this.section('画面');
    const ratioRow = document.createElement('label');
    ratioRow.className = 'settings-select';
    ratioRow.htmlFor = 'settings-pixel-ratio';
    ratioRow.textContent = '渲染像素比';
    this.pixelRatio = document.createElement('select');
    this.pixelRatio.id = 'settings-pixel-ratio';
    for (const [value, label] of [['1', '1 · 流畅'], ['1.5', '1.5 · 清晰']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      this.pixelRatio.append(option);
    }
    ratioRow.append(this.pixelRatio);
    graphics.append(ratioRow);
    this.interactionHighlights = this.checkbox(graphics, 'settings-interaction-highlights', '可交互物体高亮');
    const highlightNote = this.note(graphics, '附近可交互物体显示柔和提示；关闭后仍可正常互动。');
    highlightNote.id = 'settings-interaction-highlights-note';
    this.interactionHighlights.setAttribute('aria-describedby', highlightNote.id);
    this.postprocessing = this.checkbox(graphics, 'settings-postprocessing', '开启后处理');
    const effectsNote = this.note(graphics, '调节装饰效果；香水粒子、黑屏与眨眼始终保留。');
    effectsNote.id = 'settings-effects-note';
    this.postprocessing.setAttribute('aria-describedby', effectsNote.id);

    content.append(controls, audio, graphics);
    const footer = document.createElement('p');
    footer.className = 'settings-footer';
    footer.textContent = '联机仍在继续，请留意周围。';
    this.dialog.append(heading, description, content, footer);
    document.body.append(this.opener, this.dialog);

    this.listen(this.opener, 'click', () => this.open(this.opener));
    this.listen(this.opener, 'keydown', (event) => {
      // Keep native activation and focus traversal; restored focus must still allow game keys.
      if (['Enter', ' ', 'Tab'].includes((event as KeyboardEvent).key)) event.stopPropagation();
    });
    this.listen(this.closeButton, 'click', () => this.close('button'));
    this.listen(this.sensitivity, 'input', () => this.update({ sensitivity: Number(this.sensitivity.value) }));
    this.listen(this.pixelRatio, 'change', () => this.update({ pixelRatio: Number(this.pixelRatio.value) as 1 | 1.5 }));
    this.listen(this.interactionHighlights, 'change', () => this.update({ interactionHighlights: this.interactionHighlights.checked }));
    this.listen(this.postprocessing, 'change', () => this.update({ postprocessing: this.postprocessing.checked }));
    this.listen(this.volume, 'input', () => this.feedback.update({ volume: Number(this.volume.value) }));
    this.listen(this.muted, 'change', () => this.feedback.update({ muted: this.muted.checked }));
    this.listen(this.haptics, 'change', () => this.feedback.update({ haptics: this.haptics.checked }));
    this.listen(this.dialog, 'cancel', (event) => {
      event.preventDefault();
      if (performance.now() >= this.ignoreEscapeUntil) this.close('escape');
    });
    this.listen(this.dialog, 'keydown', (event) => this.onKeydown(event as KeyboardEvent));
    this.listen(this.dialog, 'click', (event) => {
      if (event.target !== this.dialog) return;
      const e = event as MouseEvent, box = this.dialog.getBoundingClientRect();
      if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) this.close('backdrop');
    });
    this.listen(document, 'focusin', (event) => {
      if (this.opened && !this.dialog.contains(event.target as Node)) this.closeButton.focus();
    });
    this.listen(this.dialog, 'close', () => {
      // A native close event is queued and may arrive after this dialog has reopened.
      if (this.opened && !this.dialog.open) this.finishClose('programmatic');
    });
    // Native form controls own their keys, ranges, and touch gestures; none reach game input.
    for (const target of [this.opener, this.dialog]) {
      for (const event of ['keyup', 'keypress', 'pointerdown', 'pointerup', 'pointermove', 'pointercancel',
        'touchstart', 'touchmove', 'touchend', 'touchcancel', 'mousedown', 'mouseup', 'mousemove', 'click', 'dblclick', 'wheel']) {
        this.listen(target, event, (e) => e.stopPropagation());
      }
    }
    this.cleanups.push(this.feedback.subscribe((preferences) => {
      this.feedbackPreferences = preferences;
      this.renderFeedback();
    }));
    this.render();
    options.onChange?.(this.preferences);
  }

  get preferences(): GamePreferences { return { ...this.current }; }
  get isOpen(): boolean { return this.opened; }

  subscribe(listener: (preferences: GamePreferences) => void): () => void {
    this.subscribers.add(listener);
    listener(this.preferences);
    return () => this.subscribers.delete(listener);
  }

  update(patch: Partial<GamePreferences>): void {
    if (this.disposed) return;
    this.current = gamePreferencesFrom({ ...this.current, ...patch }, this.touch);
    this.render();
    try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(this.current)); }
    catch { /* Live controls remain usable when storage is denied or full. */ }
    this.options.onChange?.(this.preferences);
    for (const listener of this.subscribers) listener(this.preferences);
  }

  /** A pointer-lock Escape can open the menu before its keydown arrives; ignore only that same key. */
  open(opener?: HTMLElement, ignoreEscapeMs = 0): void {
    if (this.disposed || this.opened) return;
    this.returnFocus = opener ?? (document.activeElement instanceof HTMLElement
      && document.activeElement !== document.body ? document.activeElement : this.opener);
    this.ignoreEscapeUntil = performance.now() + Math.max(0, ignoreEscapeMs);
    this.options.onOpen?.();
    try {
      if (document.pointerLockElement) document.exitPointerLock?.();
    } catch { /* Browsers can deny capture changes; the native modal still takes focus. */ }
    this.opened = true;
    this.opener.setAttribute('aria-expanded', 'true');
    if (typeof this.dialog.showModal === 'function') this.dialog.showModal();
    else this.dialog.open = true;
    this.closeButton.focus({ preventScroll: true });
  }

  close(reason: SettingsCloseReason = 'programmatic'): void {
    if (!this.opened) return;
    if (typeof this.dialog.close === 'function') this.dialog.close();
    else this.dialog.open = false;
    // The native close event is queued; finish now so a following game click sees the right state.
    this.finishClose(reason);
  }

  dispose(): void {
    if (this.disposed) return;
    this.close();
    this.disposed = true;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.subscribers.clear();
    this.dialog.remove();
    this.opener.remove();
  }

  private finishClose(reason: SettingsCloseReason): void {
    if (!this.opened) return;
    this.opened = false;
    this.opener.setAttribute('aria-expanded', 'false');
    const target = this.returnFocus?.isConnected ? this.returnFocus : this.opener;
    this.returnFocus = null;
    target.focus({ preventScroll: true });
    this.options.onClose?.(reason);
  }

  private onKeydown(event: KeyboardEvent): void {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      if (performance.now() >= this.ignoreEscapeUntil) this.close('escape');
    } else if (event.key === 'Tab') {
      const controls = Array.from(this.dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = controls[0], last = controls.at(-1);
      if (!first || !last) { event.preventDefault(); this.dialog.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === this.dialog)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !this.dialog.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    }
  }

  private listen(target: EventTarget, event: string, handler: (event: Event) => void): void {
    target.addEventListener(event, handler);
    this.cleanups.push(() => target.removeEventListener(event, handler));
  }

  private section(title: string): HTMLFieldSetElement {
    const section = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = title;
    section.append(legend);
    return section;
  }

  private note(parent: HTMLElement, text: string): HTMLParagraphElement {
    const note = document.createElement('p');
    note.className = 'settings-note';
    note.textContent = text;
    parent.append(note);
    return note;
  }

  private range(parent: HTMLElement, id: string, text: string, min: string, max: string, step: string) {
    const label = document.createElement('label');
    label.className = 'settings-range-label';
    label.htmlFor = id;
    label.textContent = text;
    const output = document.createElement('output');
    output.htmlFor.value = id;
    output.setAttribute('aria-hidden', 'true');
    label.append(output);
    const input = document.createElement('input');
    input.type = 'range';
    input.id = id;
    input.min = min;
    input.max = max;
    input.step = step;
    parent.append(label, input);
    return { input, output };
  }

  private checkbox(parent: HTMLElement, id: string, text: string): HTMLInputElement {
    const label = document.createElement('label');
    label.className = 'settings-check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    label.append(input, document.createTextNode(text));
    parent.append(label);
    return input;
  }

  private render(): void {
    const sensitivity = `${this.current.sensitivity.toFixed(2).replace(/0$/, '')}×`;
    this.sensitivity.value = String(this.current.sensitivity);
    this.sensitivityText.textContent = sensitivity;
    this.sensitivity.setAttribute('aria-valuetext', sensitivity);
    this.pixelRatio.value = String(this.current.pixelRatio);
    this.postprocessing.checked = this.current.postprocessing;
    this.interactionHighlights.checked = this.current.interactionHighlights;
  }

  private renderFeedback(): void {
    const p = this.feedbackPreferences;
    const volume = `${Math.round(p.volume * 100)}%`;
    this.volume.value = String(p.volume);
    this.volumeText.textContent = volume;
    this.volume.setAttribute('aria-valuetext', volume);
    this.muted.checked = p.muted;
    this.haptics.checked = p.haptics;
  }
}
