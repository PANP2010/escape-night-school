/** Level 6's posted clues and team answer sheet. The server owns every answer and the result. */
import * as THREE from 'three';
import { generateExam, type ExamQuestion } from '../../shared/exam.ts';
import { FLOOR_HEIGHT } from '../../shared/campus/campus_schema.ts';
import type { LevelDef } from '../../shared/levels/def.ts';
import type { ClientMsg, ServerMsg } from '../../shared/protocol.ts';
import './exam.css';

type P = { x: number; y: number; z: number };
type ExamDef = NonNullable<LevelDef['exam']>;
export type ExamState = Extract<ServerMsg, { t: 'exam' }>;
type ExamSend = Extract<ClientMsg, { t: 'exam' }>;
export interface ExamTarget { kind: 'paper' | 'notice'; index: number; point: P }

export const answeredCount = (answers: readonly (number | null)[]) => answers.filter((a) => a !== null).length;
export const cooldownLeft = (until: number, now: number) => Math.max(0, Math.ceil((until - now) / 1000));

/** Keep a sheet open only on its storey, within the same reach used to open it, and with a clear sightline. */
export function examReachable(def: ExamDef, target: ExamTarget, feet: P, eye: P, visible: (a: P, b: P) => boolean): boolean {
  const surface = target.kind === 'paper' ? def.paper : def.notices[target.index];
  if (!surface) return false;
  const floorY = surface.y - (target.kind === 'paper' ? 1.15 : 1.45);
  return Number.isFinite(floorY) && Math.abs(feet.y - floorY) <= 0.8
    && Math.hypot(target.point.x - feet.x, target.point.z - feet.z) <= 2 && visible(eye, target.point);
}

/** A forgiving view cone makes a lectern-height paper usable on a phone, while LOS keeps it behind its wall. */
export function examTarget(def: ExamDef, feet: P, eye: P, yaw: number, visible: (a: P, b: P) => boolean): ExamTarget | null {
  const targets: ExamTarget[] = [
    { kind: 'paper', index: 0, point: { ...def.paper, y: def.paper.y + 0.12 } },
    ...def.notices.map((n, index) => ({ kind: 'notice' as const, index, point: { x: n.x, y: n.y, z: n.z } })),
  ];
  let best: ExamTarget | null = null, score = Infinity;
  for (const t of targets) {
    const p = t.point;
    if (!examReachable(def, t, feet, eye, visible)) continue;
    const dx = p.x - feet.x, dz = p.z - feet.z, distance = Math.hypot(dx, dz);
    const facing = distance < 0.35 ? 1 : (-Math.sin(yaw) * dx - Math.cos(yaw) * dz) / distance;
    if (facing < 0.5) continue;
    const value = distance + (1 - facing) * 1.5;
    if (value < score) { best = t; score = value; }
  }
  return best;
}

const YAW = { 'z+': 0, 'z-': Math.PI, 'x+': Math.PI / 2, 'x-': -Math.PI / 2 } as const;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

function wrapped(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, width: number, line: number): number {
  let row = '';
  for (const char of text) {
    if (ctx.measureText(row + char).width > width && row) { ctx.fillText(row, x, y); y += line; row = ''; }
    row += char;
  }
  ctx.fillText(row, x, y);
  return y + line;
}

function paperTexture(title: string, lines: string[], layout: { width?: number; height?: number; fontSize?: number; gap?: number } = {}): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = layout.width ?? 512; canvas.height = layout.height ?? 512;
  const scale = canvas.width / 512, fontSize = layout.fontSize ?? 24, gap = layout.gap ?? 20;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#ebe6cf'; g.fillRect(0, 0, canvas.width, canvas.height);
  g.strokeStyle = '#66594b'; g.lineWidth = 5 * scale; g.strokeRect(15 * scale, 15 * scale, canvas.width - 30 * scale, canvas.height - 30 * scale);
  g.textBaseline = 'top'; g.fillStyle = '#352f29'; g.font = `bold ${34 * scale}px sans-serif`;
  let y = wrapped(g, title, 36 * scale, 35 * scale, 440 * scale, 44 * scale) + 22 * scale;
  g.font = `${fontSize}px sans-serif`;
  for (const line of lines) y = wrapped(g, line, 36 * scale, y, 440 * scale, fontSize * 1.4) + gap;
  g.font = `bold ${25 * scale}px sans-serif`; g.fillStyle = '#78502d'; g.fillText('靠近 · E / 互动 阅读', 36 * scale, canvas.height - 57 * scale);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export class ExamRoom {
  readonly questions: ExamQuestion[];
  readonly def: ExamDef;
  state: ExamState = { t: 'exam', answers: Array(5).fill(null), passed: false, revision: 0, cooldown: 0, feedback: '' };
  readonly group = new THREE.Group();
  private readonly touchTargets: THREE.Object3D[] = [];
  readonly overlay = el('div');
  private panel = el('section', 'exam-panel');
  private title = el('h2');
  private sub = el('p', 'exam-sub');
  private body = el('div', 'exam-body');
  private status = el('p', 'exam-status');
  private closeButton = el('button', 'exam-close', '退出');
  private submitButton = el('button', 'exam-submit', '交卷');
  private progress = el('nav', 'exam-progress');
  private current = 0;
  private mode: 'paper' | 'notice' | null = null;
  private notice = 0;
  private until = 0;
  private pending?: { question: number; choice: number; until: number };
  private answerConflict = false;
  private send: (msg: ExamSend) => void;
  private modal: (open: boolean, resume?: boolean) => void;
  private keyHandler: (event: KeyboardEvent) => void;
  private pointerHandler: (event: Event) => void;
  private exitSign?: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private exitRing?: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private exitPassed?: boolean;

  constructor(def: ExamDef, seed: number, scene: THREE.Scene, send: (msg: ExamSend) => void, modal: (open: boolean, resume?: boolean) => void, exit?: P) {
    this.def = def; this.questions = generateExam(seed); this.send = send; this.modal = modal;
    this.group.name = 'EXAM_PAPERS';
    this.buildProps(); if (exit) this.buildExit(exit); scene.add(this.group);
    this.overlay.id = 'exam-overlay'; this.overlay.hidden = true;
    this.panel.setAttribute('role', 'dialog'); this.panel.setAttribute('aria-modal', 'true');
    this.panel.setAttribute('aria-labelledby', 'exam-title'); this.panel.tabIndex = -1; this.title.id = 'exam-title';
    this.closeButton.id = 'exam-close'; this.closeButton.type = 'button'; this.closeButton.onclick = () => this.close();
    this.submitButton.id = 'exam-submit'; this.submitButton.type = 'button';
    this.submitButton.onclick = () => {
      if (this.submitButton.disabled) return;
      this.pending = { question: -1, choice: -1, until: performance.now() + 3000 };
      this.send({ t: 'exam', op: 'submit', revision: this.state.revision }); this.syncControls();
    };
    this.progress.setAttribute('aria-label', '全队五题答题进度');
    this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
    const header = el('header', 'exam-header'); header.append(this.title, this.closeButton);
    const footer = el('footer', 'exam-footer'); footer.append(this.status, this.submitButton);
    this.panel.append(header, this.sub, this.progress, this.body, footer); this.overlay.append(this.panel);
    document.body.append(this.overlay);
    this.keyHandler = (event) => {
      if (!this.open) return;
      // Capture before main.ts's Enter/chat listener and Input's movement listener.
      event.stopImmediatePropagation();
      if (event.key === 'Escape') { event.preventDefault(); this.close(); }
      else if (event.key === 'Tab') {
        // `hidden` applies to the notice's submit button as well as its progress container.
        const buttons = [...this.panel.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
          .filter((button) => !button.closest('[hidden]'));
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.shiftKey ? (at <= 0 ? buttons.length - 1 : at - 1) : (at + 1) % buttons.length;
        event.preventDefault(); buttons[next]?.focus();
      }
    };
    this.pointerHandler = (event) => { if (this.open) event.stopPropagation(); };
    addEventListener('keydown', this.keyHandler, true);
    this.overlay.addEventListener('pointerdown', this.pointerHandler);
    this.overlay.addEventListener('touchstart', this.pointerHandler, { passive: true });
  }

  get open() { return this.mode !== null; }
  /** Tap actual paper geometry; range, storey and wall checks remain the Game's responsibility. */
  targetAt(ray: THREE.Raycaster, visible: (point: P) => boolean = () => true): ExamTarget | null {
    const hit = ray.intersectObjects(this.touchTargets, false)[0];
    return hit && visible(hit.point) ? hit.object.userData.examTarget as ExamTarget : null;
  }
  get activeTarget(): ExamTarget | null {
    return this.mode === 'paper' ? { kind: 'paper', index: 0, point: { ...this.def.paper, y: this.def.paper.y + 0.12 } }
      : this.mode === 'notice' ? { kind: 'notice', index: this.notice, point: this.def.notices[this.notice] } : null;
  }

  openPaper() {
    this.current = Math.max(0, this.state.answers.findIndex((a) => a === null));
    this.mode = 'paper'; this.show();
  }
  openNotice(index: number) { if (!this.def.notices[index]) return; this.notice = index; this.mode = 'notice'; this.show(); }
  private show() {
    this.modal(true); this.overlay.hidden = false; document.body.classList.add('exam-open');
    this.render(); this.closeButton.focus();
  }
  close(resume = true) {
    if (!this.open) return;
    this.mode = null; this.overlay.hidden = true; document.body.classList.remove('exam-open'); this.modal(false, resume);
  }

  setState(state: ExamState) {
    if (state.revision < this.state.revision) return;
    const pending = this.pending;
    if (pending && pending.question >= 0) this.answerConflict = state.answers[pending.question] !== pending.choice;
    if (state.passed || (state.revision > this.state.revision && state.answers.every((answer) => answer === null))) this.answerConflict = false;
    this.state = { ...state, answers: [...state.answers] };
    this.until = performance.now() + Math.max(0, state.cooldown) * 1000;
    this.pending = undefined;
    this.updateExit();
    if (this.open) this.render();
  }
  tick(now: number) {
    if (this.pending && now >= this.pending.until) { this.pending = undefined; if (this.open) this.render(); }
    if (this.open) this.syncControls(now);
  }

  private render() {
    // Shared updates replace the answer buttons; retain the keyboard user's place in the dialog.
    const focused = this.panel.contains(document.activeElement) ? document.activeElement as HTMLButtonElement : null;
    const focusQuestion = focused?.dataset.question, focusChoice = focused?.dataset.choice;
    const paper = this.mode === 'paper';
    this.title.textContent = paper ? '全队共用试卷' : `${Math.floor((this.def.notices[this.notice].y - 1.45 + 0.01) / FLOOR_HEIGHT) + 1}F · 考试公告`;
    this.sub.textContent = paper ? '先查4F公告（第1–3题）和5F公告（第4–5题）→ 选完五题 → 交卷 → 5F出口集合'
      : '线索全队通用。记下答案后，回4F高三(7)班讲台填写共用试卷。';
    this.progress.hidden = !paper; this.submitButton.hidden = !paper;
    this.body.replaceChildren(); this.progress.replaceChildren();
    if (!paper) {
      for (const i of this.def.notices[this.notice].questions) {
        const q = this.questions[i], block = el('article', 'exam-clue');
        block.append(el('h3', undefined, `第${i + 1}题 · ${q.prompt}`), el('p', undefined, q.clue));
        this.body.append(block);
      }
      this.body.append(el('p', 'exam-location', this.notice === 0 ? '另两题线索：沿西南楼梯上5F，在同侧教室门口查阅。' : '答卷位置：下西南楼梯回4F，高三(7)班讲台。'));
    } else {
      this.questions.forEach((_q, i) => {
        const done = this.state.answers[i] !== null;
        const button = el('button', `${i === this.current ? 'current ' : ''}${done ? 'done' : ''}`, `${i + 1}${done ? ' ✓' : ''}`);
        button.type = 'button'; button.dataset.question = String(i);
        button.setAttribute('aria-label', `第${i + 1}题，${done ? '已选' : '未选'}`);
        button.setAttribute('aria-current', i === this.current ? 'step' : 'false');
        button.onclick = () => { this.current = i; this.render(); }; this.progress.append(button);
      });
      const q = this.questions[this.current];
      this.body.append(el('h3', 'exam-question', `第${this.current + 1}题 / 5　${q.prompt}`));
      const choices = el('div', 'exam-choices');
      q.choices.forEach((choice, i) => {
        const selected = (this.pending?.question === this.current ? this.pending.choice : this.state.answers[this.current]) === i;
        const button = el('button', `exam-choice${selected ? ' selected' : ''}`);
        button.type = 'button'; button.dataset.choice = String(i); button.setAttribute('aria-pressed', String(selected));
        button.append(el('span', 'exam-letter', String.fromCharCode(65 + i)), el('span', undefined, choice));
        button.onclick = () => {
          if (button.disabled) return;
          this.answerConflict = false;
          this.pending = { question: this.current, choice: i, until: performance.now() + 3000 };
          this.send({ t: 'exam', op: 'answer', question: this.current, choice: i, revision: this.state.revision });
          this.render();
        };
        choices.append(button);
      });
      this.body.append(choices);
    }
    this.syncControls();
    if (focusQuestion !== undefined) this.progress.querySelector<HTMLButtonElement>(`button[data-question="${focusQuestion}"]`)?.focus();
    else if (focusChoice !== undefined) {
      const choice = this.body.querySelector<HTMLButtonElement>(`button[data-choice="${focusChoice}"]:not(:disabled)`);
      (choice ?? this.progress.querySelector<HTMLButtonElement>(`button[data-question="${this.current}"]`))?.focus();
    }
  }

  private syncControls(now = performance.now()) {
    const focused = typeof document === 'undefined' ? null : document.activeElement as HTMLButtonElement | null;
    const left = cooldownLeft(this.until, now), n = answeredCount(this.state.answers);
    const locked = this.state.passed || left > 0 || !!this.pending;
    for (const button of this.body.querySelectorAll<HTMLButtonElement>('.exam-choice')) button.disabled = locked;
    this.submitButton.disabled = locked || n < this.questions.length;
    const submitLabel = this.state.passed ? '已通过' : left ? `${left}s 后可交卷` : `交卷（${n}/5）`;
    if (this.submitButton.textContent !== submitLabel) this.submitButton.textContent = submitLabel;
    this.status.classList.toggle('passed', this.state.passed);
    this.status.classList.toggle('warning', left > 0 || this.answerConflict);
    const message = this.state.passed ? '试卷通过，所有存活队员到5F出口集合。'
      : left ? `交卷有误 · ${this.state.blackout ? `${this.state.blackout.floor + 1}F熄灯` : '交卷冷却'} · ${left}s 后可改答重交`
      : this.pending ? '正在与全队同步…'
      : this.answerConflict && this.mode === 'paper' ? '队友更新了答卷，本次选择未保存，请核对后重选'
      : this.state.feedback || (this.mode === 'paper' ? `全队已选 ${n}/5 · 选择自动共享，填完后请交卷。` : '公告可随时重新阅读；世界仍在运行，注意监考员。');
    // This is a live region. Replacing identical text every frame repeatedly announces the same status.
    if (this.status.textContent !== message) this.status.textContent = message;
    // Disabling a focused submit/choice can move focus to the page body in Chromium.
    if (focused?.disabled && this.panel.contains(focused)) {
      (this.progress.querySelector<HTMLButtonElement>(`button[data-question="${this.current}"]`) ?? this.closeButton).focus();
    }
  }

  private buildProps() {
    const paperLines = this.questions.flatMap((q, i) => [
      `${i + 1}. ${q.prompt}`,
      q.choices.map((choice, j) => `${String.fromCharCode(65 + j)}. ${choice}`).join('　'),
    ]);
    const paper = new THREE.Mesh(new THREE.PlaneGeometry(0.46, 0.65), new THREE.MeshBasicMaterial({
      map: paperTexture('全队共用试卷', paperLines, { width: 362, height: 512, fontSize: 10.6, gap: 2.8 }), side: THREE.DoubleSide,
    }));
    paper.rotation.x = -Math.PI / 2; paper.position.set(this.def.paper.x, this.def.paper.y + 0.018, this.def.paper.z);
    const paperTarget: ExamTarget = { kind: 'paper', index: 0, point: { ...this.def.paper, y: this.def.paper.y + 0.12 } };
    paper.userData.examTarget = paperTarget; this.touchTargets.push(paper);
    this.group.add(paper);
    // A small upright placard makes the existing lectern paper identifiable from the classroom door.
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.34), new THREE.MeshBasicMaterial({ map: paperTexture('答卷 / 交卷', ['E / 互动']), side: THREE.DoubleSide }));
    sign.rotation.y = Math.PI / 2; sign.position.set(this.def.paper.x, this.def.paper.y + 0.3, this.def.paper.z + 0.28); this.group.add(sign);
    sign.userData.examTarget = paperTarget; this.touchTargets.push(sign);
    for (const [index, notice] of this.def.notices.entries()) {
      const floor = Math.floor((notice.y - 1.45 + 0.01) / FLOOR_HEIGHT) + 1;
      const lines = notice.questions.flatMap((i) => [`第${i + 1}题：${this.questions[i].prompt}`, `线索：${this.questions[i].clue}`]);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.8), new THREE.MeshBasicMaterial({
        map: paperTexture(`${floor}F 考试公告`, lines, { width: 512, height: 512, fontSize: 17, gap: 9 }), side: THREE.DoubleSide,
      }));
      mesh.position.set(notice.x, notice.y, notice.z); mesh.rotation.y = YAW[notice.dir]; this.group.add(mesh);
      mesh.userData.examTarget = { kind: 'notice', index, point: { x: notice.x, y: notice.y, z: notice.z } } satisfies ExamTarget;
      this.touchTargets.push(mesh);
    }
  }

  private buildExit(point: P) {
    this.exitSign = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.5), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    this.exitSign.position.set(point.x, point.y + 2.25, point.z - 0.5);
    this.group.add(this.exitSign);
    this.exitRing = new THREE.Mesh(new THREE.RingGeometry(0.75, 0.84, 32), new THREE.MeshBasicMaterial({ color: 0xa85d45, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false }));
    this.exitRing.rotation.x = -Math.PI / 2; this.exitRing.position.set(point.x, point.y + 0.025, point.z); this.group.add(this.exitRing);
    this.updateExit();
  }
  private updateExit() {
    if (!this.exitSign || this.exitPassed === this.state.passed) return;
    this.exitPassed = this.state.passed;
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 192;
    const g = canvas.getContext('2d')!;
    g.fillStyle = this.state.passed ? '#174936' : '#56372d'; g.fillRect(0, 0, 512, 192);
    g.strokeStyle = '#dfe6c5'; g.lineWidth = 5; g.strokeRect(7, 7, 498, 178);
    g.fillStyle = '#f1eedf'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = 'bold 38px sans-serif'; g.fillText(this.state.passed ? '出口已开放 EXIT' : '出口待开放', 256, 65);
    g.font = '29px sans-serif'; g.fillText(this.state.passed ? '全队在此集合' : '请回4F答卷并交卷', 256, 126);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    this.exitSign.material.map?.dispose(); this.exitSign.material.map = texture; this.exitSign.material.needsUpdate = true;
    this.exitRing?.material.color.setHex(this.state.passed ? 0xb8d48b : 0xa85d45);
  }

  dispose(scene: THREE.Scene) {
    this.close(false); removeEventListener('keydown', this.keyHandler, true); this.overlay.remove(); scene.remove(this.group);
    this.group.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      obj.geometry.dispose();
      const material = obj.material as THREE.MeshBasicMaterial; material.map?.dispose(); material.dispose();
    });
  }
}
