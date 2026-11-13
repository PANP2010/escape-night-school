import './transitions.css';

export interface ChapterLabel { title: string; detail: string }
/** Copy only describes the chapters currently playable. Unknown chapters stay generic. */
export function chapterLabel(index: number, name: string, restart = false): ChapterLabel {
  const detail = restart ? '整理呼吸，再一起出发' : [
    '晚自习结束了，走廊里还有脚步声',
    '灯熄了，沿着连廊继续找出口',
    '熟悉的门牌，又出现在前方',
    '午夜广播响起，先找齐墙上的编号贴纸',
  ][index] ?? (index === 6 ? '镜子里的人，比你慢了半拍' : '和队友一起继续探索');
  return { title: name, detail };
}

/** Presentation only: never changes the server handoff duration, player state, focus or input. */
export class LevelTransitions {
  private animation?: Animation;
  private timer?: ReturnType<typeof setTimeout>;
  private active = false;
  private waitingForSpawn = false;
  private disposed = false;
  private restart = false;
  private index = -1;
  private clear?: { index: number; elapsed: number };
  private readonly reduced = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined;

  private readonly root: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    // Above the touch controls and independent of the HUD's stacking context.
    document.body.append(root);
    root.classList.add('chapter-handoff');
    root.setAttribute('role', 'status');
    root.setAttribute('aria-live', 'polite');
    root.setAttribute('aria-atomic', 'true');
  }

  begin(seconds: number, index: number, name: string, restart = false) {
    if (this.disposed) return;
    this.cancel(); this.active = true; this.waitingForSpawn = false; this.restart = restart; this.index = index;
    if (restart) this.clear = undefined;
    this.root.classList.remove('complete');
    if (restart) this.root.classList.add('wipe');
    else this.root.classList.remove('wipe');
    if (!restart && this.clear?.index === index) this.renderClear(index, this.clear.elapsed);
    else this.render(restart ? '全员出局，本关重来' : '逃出去了……', chapterLabel(index, name, restart));
    this.root.hidden = false;
    document.body.classList.add('level-handoff');
    this.animate(restart ? [{ opacity: 0 }, { opacity: 1 }] : [
      { opacity: 0.35, filter: 'brightness(1.45)' }, { opacity: 1, filter: 'brightness(1)' },
    ], 180);
    // The server still owns the handoff. A delayed new snapshot must not trap this presentation forever.
    const duration = Number.isFinite(seconds) ? Math.max(0, Math.min(30, seconds)) * 1000 : 0;
    this.timer = setTimeout(() => this.reveal(), duration + 1200);
  }

  /** Adds the authoritative result to the existing three-second handoff without restarting it. */
  cleared(index: number, elapsed: number) {
    if (this.disposed || (this.active && this.index !== index)) return;
    this.clear = { index, elapsed };
    if (this.active && !this.restart) this.renderClear(index, elapsed);
  }

  private renderClear(index: number, elapsed: number) {
    const seconds = Math.max(0, Math.floor(Number.isFinite(elapsed) ? elapsed : 0));
    const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    this.render('出口已开启', { title: `第 ${index + 1} 关 通过`, detail: `用时 ${time} · 和队友一起继续向前` });
  }

  arrive(index: number, name: string) {
    if (!this.active || this.disposed) return;
    this.waitingForSpawn = true;
    this.clear = undefined;
    this.render(this.restart ? '再试一次' : '继续向前', chapterLabel(index, name, this.restart));
  }

  /** Called only after the new level's own authoritative spawn has reached the client. */
  spawned() { if (this.waitingForSpawn) this.reveal(); }

  complete(text: string) {
    if (this.disposed) return;
    this.cancel(); this.active = false; this.waitingForSpawn = false;
    document.body.classList.remove('level-handoff');
    this.root.classList.add('complete');
    this.root.classList.remove('wipe');
    this.root.replaceChildren(document.createTextNode(text));
    this.root.hidden = false;
    this.animate([{ opacity: 0.7 }, { opacity: 1 }], 220);
  }

  private reveal() {
    if (!this.active || this.disposed) return;
    this.cancel(); this.active = false; this.waitingForSpawn = false;
    document.body.classList.remove('level-handoff');
    this.root.classList.add('revealing');
    const animation = this.animate([{ opacity: 1 }, { opacity: 0 }], 280);
    const finish = () => {
      if (!this.active && !this.root.classList.contains('complete')) this.root.hidden = true;
      this.root.classList.remove('revealing');
      this.root.classList.remove('wipe');
    };
    if (animation) animation.finished.then(finish, () => {});
    else finish();
  }

  private render(kicker: string, label: ChapterLabel) {
    const make = (className: string, text: string) => {
      const el = document.createElement('div'); el.className = className; el.textContent = text;
      if (className === 'handoff-title') el.id = 'transition-title';
      if (className === 'handoff-detail') el.id = 'transition-detail';
      return el;
    };
    this.root.replaceChildren(make('handoff-kicker', kicker), make('handoff-title', label.title), make('handoff-detail', label.detail));
  }

  private animate(keyframes: Keyframe[], duration: number) {
    if (this.reduced?.matches || typeof this.root.animate !== 'function') return;
    this.animation = this.root.animate(keyframes, { duration, easing: 'ease-out', fill: 'both' });
    return this.animation;
  }

  private cancel() {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined; this.animation?.cancel(); this.animation = undefined;
    this.root.classList.remove('revealing');
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.active = false; this.cancel();
    document.body.classList.remove('level-handoff');
    this.root.hidden = true;
    this.root.classList.remove('wipe');
  }
}
