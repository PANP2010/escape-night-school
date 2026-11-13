/** L1's control tips. Enemy proximity is expressed by perfume particles, never a text alert. */
export type TutStep = 'move' | 'light' | 'crouch' | 'use' | 'map' | 'pick' | 'hide';
export const TUT_STEPS: readonly TutStep[] = ['move', 'light', 'crouch', 'use', 'map', 'pick'];
/** Basic controls run in the first minute. */
export const TUT_S = 60;
/** Each tip stays up at least this long, so one done at once is still read; then a tick for TUT_DONE_S. */
export const TUT_MIN_S = 2.5;
export const TUT_DONE_S = 0.8;
/** Metres from the spawn that count as having walked. */
export const TUT_MOVE_M = 3;

/** What the player has done so far this level. */
export interface TutDid {
  moved: number; light: boolean; crouched: boolean; used: boolean; mapped: boolean;
  /** Only a local pick request confirmed by snap.gone counts. */
  picked: boolean;
  /** Our own server snapshot currently confirms a real hiding place. */
  hidden: boolean;
}
const did = (s: TutStep, d: TutDid) => ({ move: d.moved >= TUT_MOVE_M, light: d.light, crouch: d.crouched,
  use: d.used, map: d.mapped, pick: d.picked, hide: d.hidden })[s];

interface TutTip { step: TutStep; n: number; m: number; done: boolean }

/** The tip text; `[X]` marks a key cap / an on-screen button. */
export function tutText(s: TutStep, touch: boolean): string {
  if (touch) return { move: '左边拖动走路 · 右边拖动转头', light: '点 [手电] 打开手电', crouch: '点 [蹲]，蹲行没有脚步声',
    use: '直接点门或物品互动，拖动只转头', map: '点 [地图] 看路，去过的房间会打勾', pick: '靠近物品，直接点它拿起',
    hide: '关 [手电]，靠近柜子点 [互动] 躲藏' }[s];
  return { move: '[W][A][S][D] 走动 · 鼠标转头', light: '[F] 打开手电', crouch: '[C] 或 [Ctrl] 蹲行，没有脚步声',
    use: '准星对准门或讲台，按 [E]', map: '[M] 看平面图，去过的房间会打勾', pick: '靠近物品，对准按 [E] 拿起',
    hide: '[F] 关灯，靠近柜子按 [E] 躲藏' }[s];
}

/** `tutText` split into plain runs and key caps. */
export function tutParts(t: string): { t: string; key: boolean }[] {
  return t.split(/(\[[^\]]+\])/).filter(Boolean).map((p) => p.startsWith('[') ? { t: p.slice(1, -1), key: true } : { t: p, key: false });
}

export class Tutorial {
  private t0 = -1;
  private i = 0;
  private shownAt = 0;
  private doneAt?: number;
  private readonly steps: readonly TutStep[];
  constructor(steps = TUT_STEPS) { this.steps = steps; }
  /** A new L1 (or a restart): the first tip from `now` (s). */
  start(now: number) { this.t0 = now; this.i = 0; this.shownAt = now; this.doneAt = undefined; }
  /** Any other level: no tips. */
  stop() { this.t0 = -1; }
  /** `done` shows a short tick. */
  tick(now: number, d: TutDid): TutTip | undefined {
    if (this.t0 < 0) return undefined;
    if (now - this.t0 > TUT_S || this.i >= this.steps.length) return undefined;
    if (this.doneAt === undefined && did(this.steps[this.i], d) && now - this.shownAt >= TUT_MIN_S) this.doneAt = now;
    if (this.doneAt !== undefined && now - this.doneAt >= TUT_DONE_S) {
      this.doneAt = undefined;
      do this.i++; while (this.i < this.steps.length && did(this.steps[this.i], d)); // already done before its turn: skipped
      this.shownAt = now;
    }
    if (this.i >= this.steps.length) return undefined;
    return { step: this.steps[this.i], n: this.i + 1, m: this.steps.length, done: this.doneAt !== undefined };
  }
}
