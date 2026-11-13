import { captorDisplayName } from '../../shared/studentNames.ts';
import type * as THREE from 'three';
import { CaptureThreat } from './captureThreat.ts';
import './capturePresentation.css';

export const CAPTURE_DURATION_MS = 1500;
export const CAPTURE_RECOVERY_MS = 600;
/** Server catch radii are below 1 m; allow the actor's shoulder reach, never a remote apparition. */
export const CAPTURE_SOURCE_REACH_M = 3;

export type CapturePhase = 'idle' | 'caught' | 'down' | 'spectate' | 'recover';
export type CaptureSide = 'left' | 'right';
export interface CaptureEvent {
  id: number;
  seq: number;
  tick: number;
  by: 'warden' | 'monitor' | 'mirror';
  name?: string;
  hold: number;
  /** Authoritative feet positions immediately before the caught player's forced correction. */
  at: readonly [number, number, number];
  source: readonly [number, number, number];
}
export interface CaptureFrame {
  readonly phase: CapturePhase;
  readonly caught: boolean;
  readonly elapsed: number;
  readonly progress: number;
  /** Blend normal eye height toward the existing downed eye height; never move the player's body. */
  readonly lowering: number;
  /** Small additive camera offsets, in radians; do not write these back to input. */
  readonly pitch: number;
  readonly roll: number;
  readonly grayscale: number;
  readonly veil: number;
  /** A single fade to black joins the contact animation to the downed pose at the same location. */
  readonly cover: number;
  readonly shoulder: number;
  readonly reach: number;
  readonly side: CaptureSide;
  readonly by: CaptureEvent['by'];
}

const unit = (n: number) => Math.max(0, Math.min(1, n));
const smooth = (n: number) => { const t = unit(n); return t * t * (3 - 2 * t); };
const validPoint = (p: unknown): p is readonly [number, number, number] => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);
const nowMs = () => performance.now();

/** Resolve the contact side from the authoritative source, without snapping the camera or using a remote interpolated pose. */
export function captureSide(at: CaptureEvent['at'], source: CaptureEvent['source'], yaw: number): CaptureSide {
  const right = (source[0] - at[0]) * Math.cos(yaw) - (source[2] - at[2]) * Math.sin(yaw);
  return right < 0 ? 'left' : 'right';
}

/** Pure clock/state model. Snapshots can end a capture, but can never start one. */
export class CaptureTimeline {
  private readonly localId: () => number;
  private state: CapturePhase = 'idle';
  private began = 0;
  private clock = 0;
  private sequence = 0;
  private plays = 0;
  private side: CaptureSide = 'right';
  private by: CaptureEvent['by'] = 'warden';
  private recoverFrom?: CaptureFrame;
  private reduced = false;
  private coveredHandoff = false;

  constructor(localId: () => number, reducedMotion = false) {
    this.localId = localId;
    this.reduced = reducedMotion;
  }

  /** A new local event is consumed even when presentation is suppressed; it cannot replay later. */
  begin(event: CaptureEvent, now: number, yaw = 0, visible = true): boolean {
    if (event.id !== this.localId() || !Number.isSafeInteger(event.seq) || event.seq <= this.sequence) return false;
    this.sequence = event.seq;
    if (!visible || !Number.isFinite(now) || !Number.isFinite(yaw) || this.state === 'caught' || this.state === 'down' || this.state === 'spectate') return false;
    if (!Number.isSafeInteger(event.tick) || event.tick < 0 || !(event.hold > 0) || !Number.isFinite(event.hold)
      || (event.by !== 'warden' && event.by !== 'monitor' && event.by !== 'mirror') || !validPoint(event.at) || !validPoint(event.source)) return false;
    if (Math.hypot(event.source[0] - event.at[0], event.source[2] - event.at[2]) > CAPTURE_SOURCE_REACH_M
      || Math.abs(event.source[1] - event.at[1]) > 1.6) return false;
    this.state = 'caught'; this.began = now; this.clock = now; this.recoverFrom = undefined; this.coveredHandoff = false;
    this.side = captureSide(event.at, event.source, yaw); this.by = event.by; this.plays++;
    return true;
  }

  sync(down: boolean, spectate: boolean, now: number) {
    const current = this.update(now);
    if (spectate) { this.state = 'spectate'; this.recoverFrom = undefined; this.coveredHandoff = false; return; }
    if (down) {
      // First/late down snapshots are already in the penalty. Repeated snapshots preserve the event clock.
      if (this.state !== 'caught' && this.state !== 'down') {
        this.state = 'down'; this.began = this.clock; this.recoverFrom = undefined; this.coveredHandoff = false;
      }
    } else if (this.state === 'caught' || this.state === 'down') {
      this.recoverFrom = current; this.state = 'recover'; this.began = this.clock;
    } else if (this.state === 'spectate') {
      this.state = 'idle'; this.recoverFrom = undefined;
    }
  }

  setReducedMotion(reduced: boolean) { this.reduced = reduced; }

  /** Visibility loss suppresses contact immediately without inventing future clock time. */
  suppressContact(now: number) {
    this.update(now);
    if (this.state === 'caught') { this.state = 'down'; this.began = this.clock; }
    this.coveredHandoff = false;
  }

  /** Fast frames and suspended tabs share one monotonic wall clock; a long frame never replays a beat. */
  update(now: number): CaptureFrame {
    if (Number.isFinite(now)) this.clock = Math.max(this.clock, now);
    let elapsed = Math.max(0, this.clock - this.began);
    if (this.state === 'caught' && elapsed >= CAPTURE_DURATION_MS) {
      this.state = 'down'; this.began += CAPTURE_DURATION_MS; elapsed -= CAPTURE_DURATION_MS;
      this.coveredHandoff = true;
    }
    if (this.state === 'recover' && elapsed >= CAPTURE_RECOVERY_MS) {
      this.state = 'idle'; this.recoverFrom = undefined; elapsed = 0;
    }
    const idle = this.state === 'idle' || this.state === 'spectate';
    const phase = this.state;
    const progress = phase === 'caught' ? unit(elapsed / CAPTURE_DURATION_MS) : phase === 'recover' ? unit(elapsed / CAPTURE_RECOVERY_MS) : 0;
    let lowering = 0, pitch = 0, roll = 0, grayscale = 0, veil = 0, cover = 0, shoulder = 0, reach = 0;
    if (phase === 'caught') {
      // One deliberate downward pressure, no shaking or flashing. The last frame joins the down pose exactly.
      lowering = smooth((elapsed - 100) / 1300);
      const contact = smooth(elapsed / 260) * (1 - smooth((elapsed - 950) / 500));
      pitch = this.reduced ? 0 : -0.14 * Math.sin(Math.PI * progress);
      roll = this.reduced ? 0 : (this.side === 'left' ? -1 : 1) * 0.018 * Math.sin(Math.PI * progress);
      grayscale = 0.9 * smooth(elapsed / 700);
      veil = 0.18 + 0.44 * smooth(elapsed / 800);
      cover = smooth((elapsed - 1170) / 330);
      shoulder = contact * 0.92;
      reach = this.reduced ? 1 : smooth(elapsed / 420);
    } else if (phase === 'down') {
      lowering = 1; grayscale = 0.9;
      // Understated peripheral breathing, not a flash. The audible heartbeat remains in Sound.update.
      veil = this.reduced ? 0.62 : 0.62 + 0.025 * Math.sin(elapsed / 950 * Math.PI * 2);
      cover = this.coveredHandoff ? 1 - smooth(elapsed / 220) : 0;
    } else if (phase === 'recover' && this.recoverFrom) {
      const weight = 1 - smooth(progress), from = this.recoverFrom;
      lowering = from.lowering * weight;
      pitch = this.reduced ? 0 : from.pitch * weight;
      roll = this.reduced ? 0 : from.roll * weight;
      grayscale = from.grayscale * weight; veil = from.veil * weight;
      cover = from.cover * weight;
      shoulder = from.shoulder * weight; reach = from.reach;
    }
    return {
      phase, caught: phase === 'caught', elapsed: idle ? 0 : elapsed, progress,
      lowering, pitch, roll, grayscale, veil, cover, shoulder, reach, side: this.side, by: this.by,
    };
  }

  /** Level changes preserve the per-connection sequence watermark so stale events stay stale. */
  reset() { this.state = 'idle'; this.began = this.clock; this.recoverFrom = undefined; this.coveredHandoff = false; }

  get diagnostics() {
    const frame = this.update(this.clock);
    return {
      starts: this.plays, lastSeq: this.sequence, phase: frame.phase, elapsed: frame.elapsed,
      progress: frame.progress, reduced: this.reduced, durationMs: CAPTURE_DURATION_MS,
      side: frame.side, by: frame.by,
    };
  }
}

export interface CapturePresentationOptions {
  root?: HTMLElement;
  reducedMotion?: boolean;
  camera?: THREE.Camera;
  worldCaptor?: (event: CaptureEvent) => THREE.Object3D | undefined;
}

/** Lightweight foreground, separately disposable from the server-owned down/spectator state. */
export class CapturePresentation {
  private readonly timeline: CaptureTimeline;
  private readonly root: HTMLElement;
  private readonly veil: HTMLElement;
  private readonly cover: HTMLElement;
  private readonly pressure: HTMLElement;
  private readonly status: HTMLElement;
  private readonly media?: MediaQueryList;
  private readonly ownsRoot: boolean;
  private readonly threat?: CaptureThreat;
  private readonly worldCaptor?: CapturePresentationOptions['worldCaptor'];
  private phase: CapturePhase = 'idle';
  private disposed = false;
  private readonly visibility = () => {
    if (document.hidden) {
      // A returning tab sees the current penalty, never an old near-face event played late.
      this.timeline.suppressContact(nowMs());
      this.paint(this.timeline.update(nowMs()));
    }
  };
  private readonly motion = () => {
    this.timeline.setReducedMotion(this.media?.matches ?? false);
    this.paint(this.timeline.update(nowMs()));
  };

  constructor(localId: () => number, options: CapturePresentationOptions = {}) {
    this.ownsRoot = !options.root;
    this.root = options.root ?? document.createElement('div');
    this.root.id = 'capture-presentation'; this.root.classList.add('capture-presentation');
    this.root.hidden = true;
    this.root.setAttribute('aria-hidden', 'false');
    const make = (name: string) => { const el = document.createElement('div'); el.className = name; return el; };
    this.veil = make('capture-veil'); this.veil.setAttribute('aria-hidden', 'true');
    this.cover = make('capture-cover'); this.cover.setAttribute('aria-hidden', 'true');
    const edge = make('capture-edge'); edge.setAttribute('aria-hidden', 'true');
    this.pressure = make('capture-pressure');
    this.pressure.append(make('capture-sleeve'), make('capture-palm'), ...Array.from({ length: 4 }, () => make('capture-finger')));
    edge.append(this.pressure);
    this.status = make('capture-status'); this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
    this.root.replaceChildren(this.veil, edge, this.cover, this.status); document.body.append(this.root);
    this.media = options.reducedMotion === undefined && typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined;
    this.timeline = new CaptureTimeline(localId, options.reducedMotion ?? this.media?.matches ?? false);
    if (options.camera) this.threat = new CaptureThreat(options.camera);
    this.worldCaptor = options.worldCaptor;
    this.media?.addEventListener?.('change', this.motion);
    document.addEventListener('visibilitychange', this.visibility);
    this.paint(this.timeline.update(nowMs()));
  }

  begin(event: CaptureEvent, now = nowMs(), yaw = 0): boolean {
    if (this.disposed) return false;
    const started = this.timeline.begin(event, now, yaw, !document.hidden);
    if (started) {
      this.status.textContent = `${captorDisplayName(event)}扣住了你的肩膀`;
      this.threat?.bindSource(event.by === 'warden' ? this.worldCaptor?.(event) : undefined);
    }
    this.paint(this.timeline.update(now)); return started;
  }
  sync(down: boolean, spectate: boolean, now = nowMs()) {
    if (this.disposed) return;
    this.timeline.sync(down, spectate, now); this.paint(this.timeline.update(now));
  }
  update(now = nowMs()): CaptureFrame {
    const frame = this.timeline.update(now);
    if (!this.disposed) this.paint(frame);
    return frame;
  }
  reset() {
    if (this.disposed) return;
    this.timeline.reset(); this.status.textContent = ''; this.paint(this.timeline.update(nowMs()));
  }
  private paint(frame: CaptureFrame) {
    const reduced = this.timeline.diagnostics.reduced;
    this.threat?.update(frame, reduced);
    const hidden = frame.phase === 'idle' || frame.phase === 'spectate';
    if (this.root.hidden !== hidden) this.root.hidden = hidden;
    const data = { phase: frame.phase, side: frame.side, by: frame.by, reduced: String(reduced) };
    for (const [key, value] of Object.entries(data)) if (this.root.dataset[key] !== value) this.root.dataset[key] = value;
    const veil = frame.veil.toFixed(3), cover = frame.cover.toFixed(3), shoulder = frame.shoulder.toFixed(3);
    const transform = `translate3d(${((1 - frame.reach) * 75).toFixed(2)}%, ${((1 - frame.reach) * 20).toFixed(2)}%, 0)`;
    if (this.veil.style.opacity !== veil) this.veil.style.opacity = veil;
    if (this.cover.style.opacity !== cover) this.cover.style.opacity = cover;
    if (this.pressure.style.opacity !== shoulder) this.pressure.style.opacity = shoulder;
    if (this.pressure.style.transform !== transform) this.pressure.style.transform = transform;
    if (this.phase !== frame.phase) {
      document.body.classList.toggle('capture-caught', frame.caught);
      document.body.classList.toggle('capture-penalty', frame.phase === 'caught' || frame.phase === 'down' || frame.phase === 'recover');
      this.phase = frame.phase;
      if (!frame.caught) this.status.textContent = '';
    }
  }
  get diagnostics() { return this.timeline.diagnostics; }
  prewarm(renderer: THREE.WebGLRenderer, scene: THREE.Scene): Promise<unknown> { return this.threat?.prewarm(renderer, scene) ?? Promise.resolve(); }
  dispose() {
    if (this.disposed) return;
    this.timeline.reset(); this.paint(this.timeline.update(nowMs())); this.disposed = true;
    this.threat?.dispose();
    this.media?.removeEventListener?.('change', this.motion);
    document.removeEventListener('visibilitychange', this.visibility);
    document.body.classList.remove('capture-caught', 'capture-penalty');
    if (this.ownsRoot) this.root.remove();
    else this.root.hidden = true;
  }
}
