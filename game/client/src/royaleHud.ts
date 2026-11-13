// Royale safe-zone HUD: phase countdown, alive count, in/out state, a bearing arrow, and the fog that closes in at the
// screen edge while you stand outside. The server decides who is out (room.ts stepRoyaleZone); this only mirrors it.
import './royale.css';
import { ZONE_OUT_ELIM_S, ZONE_PHASES, distToZoneCenter, inZone, type ZonePhase } from '../../shared/royale.ts';

/** What `snap.zone` carries: the zone in force now and when the next shrink lands. */
export interface ZoneSnap { phase: number; center: [number, number]; radius: number; remainingMs: number; alive: number }
export type ZoneState = 'out' | 'warn' | 'safe';
export interface ZoneGuide {
  state: ZoneState;
  /** The zone the arrow points at: the current one when outside it, otherwise the next one if it leaves you out. */
  target?: ZonePhase;
  /** Metres to walk until inside `target` (out/warn) or to the nearest zone edge (safe). */
  metres: number;
}

/** `m:ss`, rounded up so the last second reads 0:01, never 0:00 while time remains. */
export function formatClock(ms: number): string {
  const s = Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / 1000)) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Top line of the panel: first shrink, each later shrink, then the final circle that no longer moves. */
export function zoneHeadline(z: Pick<ZoneSnap, 'phase' | 'remainingMs'>): string {
  if (z.phase <= 0) return `${formatClock(z.remainingMs)} 后安全区开始收缩`;
  if (z.phase >= ZONE_PHASES) return '最终圈 · 不再缩小';
  return `第 ${z.phase}/${ZONE_PHASES} 圈 · ${formatClock(z.remainingMs)} 后再缩`;
}

/** The zone after `snap`'s, if the locally generated table (same seed as the server) agrees with what the server sent. */
export function nextZoneOf(phases: readonly ZonePhase[], snap: Pick<ZoneSnap, 'phase' | 'center' | 'radius'>): ZonePhase | undefined {
  const here = phases[snap.phase];
  if (!here || Math.abs(here.center[0] - snap.center[0]) > 0.5 || Math.abs(here.center[1] - snap.center[1]) > 0.5 || Math.abs(here.radius - snap.radius) > 0.5) return undefined;
  return phases[snap.phase + 1];
}

/** In/out of the current circle, and while in, whether the circle after it will leave you out. */
export function zoneGuide(cur: ZonePhase, next: ZonePhase | undefined, me: { x: number; z: number }): ZoneGuide {
  if (!inZone(me.x, me.z, cur)) return { state: 'out', target: cur, metres: distToZoneCenter(me.x, me.z, cur) - cur.radius };
  if (next && !inZone(me.x, me.z, next)) return { state: 'warn', target: next, metres: distToZoneCenter(me.x, me.z, next) - next.radius };
  const edge = cur.radius - distToZoneCenter(me.x, me.z, cur);
  return { state: 'safe', metres: next ? Math.min(edge, next.radius - distToZoneCenter(me.x, me.z, next)) : edge };
}

/** Degrees from straight ahead to the zone centre, clockwise positive, in (-180, 180]. yaw 0 looks along -z. */
export function bearingDeg(me: { x: number; z: number }, yaw: number, center: readonly [number, number]): number {
  const world = Math.atan2(center[0] - me.x, center[1] - me.z); // 0 = +z, clockwise towards +x
  const ahead = Math.atan2(-Math.sin(yaw), -Math.cos(yaw));
  let d = ((world - ahead) * 180) / Math.PI;
  d = ((((d + 180) % 360) + 360) % 360) - 180;
  return d === -180 ? 180 : d;
}

/** Seconds spent outside the circle in one go; the server's own clock decides the kill, this one only drives the display. */
export class OutTimer {
  seconds = 0;
  step(dt: number, outside: boolean) {
    this.seconds = outside ? Math.min(ZONE_OUT_ELIM_S, this.seconds + Math.max(0, dt)) : 0;
  }
  get remaining() { return Math.max(0, ZONE_OUT_ELIM_S - this.seconds); }
}

/** 0..1 fog target: a clear first warning the moment you step out, closing to full as the 8 s run down; none inside. */
export function fogTarget(outSeconds: number, outside: boolean): number {
  return outside ? 0.3 + 0.7 * Math.min(1, Math.max(0, outSeconds) / ZONE_OUT_ELIM_S) : 0;
}

/** Fog closes quickly (0.25 s) and lifts slowly (0.9 s): entering the circle should feel like exhaling. */
export function fogLevel(current: number, target: number, dt: number): number {
  const s = Math.max(0, dt);
  return target + (current - target) * Math.exp(-s / (target > current ? 0.25 : 0.9));
}

const ARROW_STEP = 3; // degrees: snapping avoids a style write every frame

export class ZoneHud {
  private readonly panel = document.createElement('div');
  private readonly fog = document.createElement('div');
  private readonly head = document.createElement('div');
  private readonly alive = document.createElement('span');
  private readonly status = document.createElement('span');
  private readonly dist = document.createElement('span');
  private readonly arrow = document.createElement('i');
  private readonly bar = document.createElement('b');
  private readonly out = new OutTimer();
  private level = 0;
  /** Last values written to the DOM, so an unchanged frame touches nothing. */
  private last = { head: '', alive: '', status: '', dist: '', state: '', deg: NaN, bar: -1, fog: -1 };
  constructor(parent: HTMLElement = document.getElementById('hud') ?? document.body) {
    this.panel.id = 'zone-hud';
    this.panel.hidden = true;
    this.panel.setAttribute('aria-live', 'off');
    this.head.className = 'zh-head';
    const row = document.createElement('div');
    row.className = 'zh-row';
    this.arrow.className = 'zh-arrow';
    this.status.className = 'zh-status';
    this.dist.className = 'zh-dist';
    this.alive.className = 'zh-alive';
    row.append(this.arrow, this.status, this.dist);
    const barWrap = document.createElement('div');
    barWrap.className = 'zh-bar';
    barWrap.append(this.bar);
    this.panel.append(this.alive, this.head, row, barWrap);
    this.fog.id = 'zone-fog';
    this.fog.setAttribute('aria-hidden', 'true');
    parent.prepend(this.fog); // under every other HUD element
    parent.append(this.panel);
  }
  /** `me` is absent when spectating or eliminated; `zone` before the first royale snap. */
  update(zone: ZoneSnap | undefined, next: ZonePhase | undefined, me: { x: number; z: number; yaw: number } | undefined, dt: number) {
    if (!zone || !me) {
      this.out.step(dt, false);
      this.level = fogLevel(this.level, 0, dt);
      this.setFog();
      this.hide();
      return;
    }
    const cur: ZonePhase = { center: zone.center, radius: zone.radius };
    const g = zoneGuide(cur, next, me);
    this.out.step(dt, g.state === 'out');
    this.level = fogLevel(this.level, fogTarget(this.out.seconds, g.state === 'out'), dt);
    this.setFog();
    this.panel.hidden = false;
    const L = this.last;
    const set = <K extends 'head' | 'alive' | 'status' | 'dist'>(k: K, el: HTMLElement, v: string) => { if (L[k] !== v) { L[k] = v; el.textContent = v; } };
    set('head', this.head, zoneHeadline(zone));
    set('alive', this.alive, `存活 ${zone.alive}`);
    const metres = Math.max(0, Math.ceil(g.metres));
    set('status', this.status, g.state === 'out' ? `圈外 · ${Math.ceil(this.out.remaining)} 秒后被熄灯吞没` : g.state === 'warn' ? '下一圈外 · 向圈心靠拢' : '圈内 · 安全');
    set('dist', this.dist, g.state === 'safe' ? `距圈边 ${metres} m` : `${metres} m`);
    if (L.state !== g.state) { L.state = g.state; this.panel.dataset.state = g.state; }
    const arrow = g.target ?? cur;
    if (g.state === 'safe') {
      this.arrow.style.visibility = 'hidden';
    } else {
      this.arrow.style.visibility = '';
      const deg = Math.round(bearingDeg(me, me.yaw, arrow.center) / ARROW_STEP) * ARROW_STEP;
      if (deg !== L.deg) { L.deg = deg; this.arrow.style.transform = `rotate(${deg}deg)`; }
    }
    const bar = g.state === 'out' ? Math.round((this.out.remaining / ZONE_OUT_ELIM_S) * 50) / 50 : -1;
    if (bar !== L.bar) { L.bar = bar; this.bar.style.width = bar < 0 ? '0' : `${bar * 100}%`; this.bar.parentElement!.style.opacity = bar < 0 ? '0' : '1'; }
  }
  private hide() { if (!this.panel.hidden) this.panel.hidden = true; this.last.head = this.last.status = ''; this.last.bar = -1; }
  private setFog() {
    const q = Math.round(this.level * 40) / 40; // 40 steps: no style write per frame
    if (q === this.last.fog) return;
    this.last.fog = q;
    this.fog.style.setProperty('--zf', String(q));
    this.fog.style.opacity = q > 0 ? '1' : '0';
  }
  /** The fog level 0..1, for tests and screenshots. */
  get fogStrength() { return this.level; }
  dispose() { this.panel.remove(); this.fog.remove(); }
}
