// Bottom-of-screen HUD arbitration: the centred key hint (#hint) wraps upward on narrow screens and collides with the
// chat column (#chat-log / #chat-input, bottom-left). Whenever their boxes would touch, the hint fades out (.covered).

export interface Box { left: number; top: number; right: number; bottom: number }

/** Boxes closer than `gap` px count as overlapping: text-shadowed lines that merely touch still read as one blur. */
export function boxesOverlap(a: Box, b: Box, gap = 0): boolean {
  if (a.right <= a.left || a.bottom <= a.top || b.right <= b.left || b.bottom <= b.top) return false; // empty / hidden
  return a.left < b.right + gap && b.left < a.right + gap && a.top < b.bottom + gap && b.top < a.bottom + gap;
}

/** Chat lines older than this hide (shown again while the chat input is open), so the hint can come back. */
export const CHAT_LINE_S = 20;
const GAP_PX = 6;

/** Box of the hint's text, not its full-width block: on wide screens the one-line hint clears the chat column. */
function textBox(el: HTMLElement): Box {
  const r = document.createRange();
  r.selectNodeContents(el);
  return r.getBoundingClientRect();
}

/** Keep #hint.covered in sync with the chat column's size; returns a function to call after any chat change. */
export function watchHintOverlap(hint: HTMLElement, chat: HTMLElement[]): () => void {
  const sync = () => hint.classList.toggle('covered', chat.some((c) => boxesOverlap(textBox(hint), c.getBoundingClientRect(), GAP_PX)));
  const ro = new ResizeObserver(sync);
  for (const el of [hint, ...chat]) ro.observe(el);
  addEventListener('resize', sync);
  return sync;
}

export interface VisibleViewport { width: number; height: number; offsetLeft: number; offsetTop: number }
export interface ViewportInsets { top: number; right: number; bottom: number; left: number; width: number; height: number }

/** Keyboard resize and Safari's subsequent viewport pan both move the usable rectangle. */
export function viewportInsets(width: number, height: number, visual?: VisibleViewport | null): ViewportInsets {
  const finite = (n: number, fallback: number) => Number.isFinite(n) ? n : fallback;
  width = Math.max(0, finite(width, 0)); height = Math.max(0, finite(height, 0));
  const left = Math.min(width, Math.max(0, finite(visual?.offsetLeft ?? 0, 0)));
  const top = Math.min(height, Math.max(0, finite(visual?.offsetTop ?? 0, 0)));
  const visibleWidth = Math.min(width - left, Math.max(0, finite(visual?.width ?? width, width)));
  const visibleHeight = Math.min(height - top, Math.max(0, finite(visual?.height ?? height, height)));
  return { top, left, right: width - left - visibleWidth, bottom: height - top - visibleHeight, width: visibleWidth, height: visibleHeight };
}

/** Scoped variables only reposition chat and the result screen; the canvas keeps its existing resize behavior. */
export function watchChatViewport(root: HTMLElement, onChange: () => void, view: Window = window) {
  const sync = () => {
    const bounds = viewportInsets(view.innerWidth, view.innerHeight, view.visualViewport);
    for (const [edge, value] of Object.entries(bounds)) root.style.setProperty(`--chat-viewport-${edge}`, `${value}px`);
    onChange();
  };
  const visual = view.visualViewport;
  view.addEventListener('resize', sync); view.addEventListener('scroll', sync);
  visual?.addEventListener('resize', sync); visual?.addEventListener('scroll', sync);
  sync();
  return { sync, dispose: () => {
    view.removeEventListener('resize', sync); view.removeEventListener('scroll', sync);
    visual?.removeEventListener('resize', sync); visual?.removeEventListener('scroll', sync);
  } };
}

interface ChatSession { input: { enabled: boolean; clear: () => void }; completed: boolean }
interface ChatPanelOptions {
  session: () => ChatSession | null;
  blocked: () => boolean;
  send: (text: string) => void;
  changed: () => void;
}

/** Native chat controls own focus only inside their panel. An outside tap closes it and continues to the game. */
export class ChatPanel {
  readonly root: HTMLElement;
  private readonly composer: HTMLFormElement;
  private paused?: ChatSession;
  private wasEnabled = false;
  private composing = false;
  private cleanups: (() => void)[] = [];
  private readonly field: HTMLInputElement;
  private readonly log: HTMLElement;
  private readonly options: ChatPanelOptions;

  constructor(field: HTMLInputElement, log: HTMLElement, options: ChatPanelOptions) {
    this.field = field; this.log = log; this.options = options;
    this.root = document.createElement('section'); this.root.id = 'chat-panel';
    this.root.setAttribute('aria-label', '队伍聊天');
    log.setAttribute('role', 'log'); log.setAttribute('aria-live', 'polite'); log.setAttribute('aria-relevant', 'additions text');
    this.composer = document.createElement('form'); this.composer.id = 'chat-composer'; this.composer.hidden = true;
    field.setAttribute('aria-label', '聊天消息'); field.placeholder = '和队友说句话'; field.autocomplete = 'off';
    field.setAttribute('enterkeyhint', 'send');
    const send = document.createElement('button'); send.id = 'chat-send'; send.type = 'submit'; send.textContent = '发送';
    const cancel = document.createElement('button'); cancel.id = 'chat-cancel'; cancel.type = 'button'; cancel.textContent = '取消';
    this.composer.append(field, send, cancel); this.root.append(log, this.composer); document.body.append(this.root);
    this.listen(field, 'compositionstart', () => { this.composing = true; });
    this.listen(field, 'compositionend', () => { this.composing = false; });
    this.listen(this.composer, 'submit', e => { e.preventDefault(); if (!this.composing) this.close(true); });
    this.listen(cancel, 'click', () => this.close(false));
    this.listen(this.composer, 'keydown', event => {
      event.stopPropagation();
      const e = event as KeyboardEvent;
      if (e.isComposing || e.keyCode === 229 || this.composing) return;
      if (e.key === 'Escape') { e.preventDefault(); this.close(false); }
      else if (e.key === 'Enter' && e.target === field) { e.preventDefault(); this.close(true); }
    });
    for (const name of ['keyup', 'keypress', 'pointerdown', 'pointerup', 'touchstart', 'touchmove', 'touchend', 'click', 'wheel']) {
      this.listen(this.root, name, e => e.stopPropagation());
    }
    const outside = (e: Event) => {
      if (!this.open || !(e.target instanceof Node) || this.root.contains(e.target)) return;
      if (e.target instanceof Element && e.target.closest('#touch-chat')) return;
      this.close(false);
    };
    this.listen(window, 'pointerdown', outside, true);
    this.listen(window, 'touchstart', outside, true);
    this.listen(window, 'focusin', outside, true);
  }

  get open() { return !this.composer.hidden; }

  show() {
    const session = this.options.session();
    if (this.open || !session || !session.input.enabled || session.completed || this.options.blocked()) return;
    this.paused = session; this.wasEnabled = session.input.enabled;
    session.input.clear(); session.input.enabled = false;
    this.field.hidden = false; this.composer.hidden = false;
    document.body.classList.add('chat-open');
    document.exitPointerLock?.();
    this.field.focus({ preventScroll: true }); this.scrollToLatest(); this.options.changed();
  }

  close(send: boolean) {
    if (!this.open) return;
    const text = this.field.value.trim();
    if (send && text && !this.composing) this.options.send(text);
    this.field.value = ''; this.field.hidden = true; this.composer.hidden = true; this.composing = false;
    document.body.classList.remove('chat-open'); this.field.blur();
    if (this.paused) {
      this.paused.input.clear();
      this.paused.input.enabled = this.wasEnabled && !this.paused.completed && !this.options.blocked();
    }
    this.paused = undefined; this.options.changed();
  }

  scrollToLatest() { this.log.scrollTop = this.log.scrollHeight; }

  dispose() {
    this.close(false);
    for (const cleanup of this.cleanups.splice(0)) cleanup();
  }

  private listen(target: EventTarget, name: string, handler: (e: Event) => void, capture = false) {
    target.addEventListener(name, handler, capture);
    this.cleanups.push(() => target.removeEventListener(name, handler, capture));
  }
}
