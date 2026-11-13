const KINDS = new Set(['bug', 'idea', 'event', 'other']);
const MAX_TEXT = 500;
const MIN_TEXT = 4;

export interface FeedbackPayload { kind: string; text: string; name?: string; contact?: string }
export type FeedbackCheck = { ok: true; value: FeedbackPayload } | { ok: false; error: string };

/** Mirrors server/feedback.ts limits so most mistakes never leave the browser. The server stays authoritative. */
export function checkFeedback(kind: string, text: string, name: string, contact: string): FeedbackCheck {
  if (!KINDS.has(kind)) return { ok: false, error: '请选择反馈类型' };
  const trimmed = text.trim(), length = Array.from(trimmed).length;
  if (length < MIN_TEXT) return { ok: false, error: '反馈内容至少 4 个字' };
  if (length > MAX_TEXT) return { ok: false, error: '反馈内容最多 500 个字' };
  const cleanName = name.trim(), cleanContact = contact.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  if (Array.from(cleanContact).length > 64) return { ok: false, error: '联系方式最多 64 个字符' };
  return { ok: true, value: { kind, text: trimmed, ...(cleanName ? { name: cleanName } : {}), ...(cleanContact ? { contact: cleanContact } : {}) } };
}

/** Lobby 意见箱. Binds the markup in index.html; every user-supplied string goes in through textContent. */
export class FeedbackBox {
  private readonly button: HTMLButtonElement;
  private readonly dialog: HTMLDialogElement;
  private readonly form: HTMLFormElement;
  private readonly kind: HTMLSelectElement;
  private readonly text: HTMLTextAreaElement;
  private readonly name: HTMLInputElement;
  private readonly contact: HTMLInputElement;
  private readonly counter: HTMLElement;
  private readonly status: HTMLElement;
  private readonly submit: HTMLButtonElement;
  private busy = false;

  constructor(openButtonId = 'feedback-open') {
    const button = document.getElementById(openButtonId), dialog = document.getElementById('feedback-dialog');
    if (!(button instanceof HTMLButtonElement) || !(dialog instanceof HTMLDialogElement)) throw new Error('意见箱界面缺失');
    this.button = button; this.dialog = dialog;
    this.form = this.need('feedback-form');
    this.kind = this.need('feedback-kind');
    this.text = this.need('feedback-text');
    this.name = this.need('feedback-name');
    this.contact = this.need('feedback-contact');
    this.counter = this.need('feedback-counter');
    this.status = this.need('feedback-status');
    this.submit = this.need('feedback-submit');
    this.button.setAttribute('aria-haspopup', 'dialog'); this.button.setAttribute('aria-controls', 'feedback-dialog');
    this.need<HTMLButtonElement>('feedback-close').onclick = () => this.dialog.close();

    try { this.name.value = localStorage.getItem('escape.feedback.name') ?? ''; } catch { this.name.value = ''; }
    this.counter.textContent = `已输入 0/${MAX_TEXT}`;
    this.text.addEventListener('input', () => { this.counter.textContent = `已输入 ${Array.from(this.text.value).length}/${MAX_TEXT}`; });
    this.form.addEventListener('submit', (event) => { event.preventDefault(); void this.send(); });
    this.button.onclick = () => this.open();
    this.dialog.addEventListener('close', () => this.button.focus());
    // Esc is the browser's native cancel; only prevent the default double-close, never trap focus in a lobby form.
    this.dialog.addEventListener('cancel', (event) => { event.preventDefault(); this.dialog.close(); });
  }

  // preventScroll keeps the title and 返回 visible on short landscape screens; the form scrolls instead.
  open(): void { this.status.textContent = ''; delete this.status.dataset.state; this.dialog.showModal(); this.dialog.scrollTop = 0; this.text.focus({ preventScroll: true }); }
  dispose(): void { this.button.onclick = null; this.dialog.close(); }

  private need<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) throw new Error(`意见箱界面缺失：${id}`);
    return element as T;
  }

  private async send(): Promise<void> {
    if (this.busy) return;
    const checked = checkFeedback(this.kind.value, this.text.value, this.name.value, this.contact.value);
    if (!checked.ok) { this.setStatus(checked.error, 'error'); return; }
    this.busy = true; this.submit.disabled = true; this.setStatus('正在提交……', 'pending');
    try { localStorage.setItem('escape.feedback.name', this.name.value.trim()); } catch { /* private mode */ }
    try {
      const response = await fetch('/api/feedback', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(checked.value),
      });
      if (response.status === 201) {
        this.setStatus('收到啦，谢谢你让夜校变得更好。', 'ok');
        this.text.value = ''; this.counter.textContent = `已输入 0/${MAX_TEXT}`;
      } else if (response.status === 429) {
        this.setStatus('提交太频繁了，请稍后再试', 'error');
      } else if (response.status === 413) {
        this.setStatus('内容太长了，请精简后再试', 'error');
      } else {
        this.setStatus('暂时没能提交，请稍后再试', 'error');
      }
    } catch {
      this.setStatus('网络不太稳定，请检查连接后再试一次', 'error');
    } finally {
      this.busy = false; this.submit.disabled = false;
    }
  }

  private setStatus(message: string, state: 'ok' | 'error' | 'pending'): void {
    this.status.textContent = message; this.status.dataset.state = state;
  }
}
