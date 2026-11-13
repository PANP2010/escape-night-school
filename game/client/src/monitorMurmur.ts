import * as THREE from 'three';
import { Voice, VOICE_MAX_M } from './voice.ts';
import './monitorMurmur.css';

export const MONITOR_MURMUR_RANGE = 10;
export const MONITOR_LETTER_S = .32;
const HEAD_Y = 1.85;
const direction = new THREE.Vector3(), part = new THREE.Vector3(), to = new THREE.Vector3();
type Sight = (from: THREE.Vector3, to: THREE.Vector3) => boolean;
export interface MurmurSource {
  monitor: boolean; displayName?: string; anim: string; mesh: THREE.Object3D;
}

export function monitorMurmurLine(name: string, random = Math.random): string {
  if (name === '角色078') return ['这波看我操作。', '拿捏了。', '问题不大。', '我想角色070了…………孤独……'][Math.min(3, Math.max(0, Math.floor(random() * 4)))];
  if (name === '角色039') return '我卷在哪了…………';
  if (name === '角色021' || name === '角色026') return '可以可以，不赖不赖';
  if (name === '角色020') return '嗯～你看看，你和我谁更糖一点？';
  if (name === '角色094') {
    const lines = ['区完了…………', '别…………见证', '行。', '对。'];
    return lines[Math.min(3, Math.max(0, Math.floor(random() * 4)))];
  }
  const lines = [`${name}没错…………为什么要写检讨`, '检讨…………必须写吗', '我已经…………深刻检讨'];
  const line = lines[Math.min(2, Math.max(0, Math.floor(random() * 3)))];
  return `角色081…………\n${line}`;
}

/** One continuous local typewriter clock, deliberately independent of snapshot frequency. */
export class MonitorMurmurLine {
  readonly name: string;
  private readonly random: () => number;
  private line: string;
  private elapsed = 0;
  private index = 0;
  private hold = 0;
  constructor(name: string, random = Math.random) { this.name = name; this.random = random; this.line = monitorMurmurLine(name, random); }
  get text(): string { return this.line.slice(0, this.index); }
  step(dt: number): { text: string; letter: string } {
    let letter = '';
    // A stalled/background frame must never dump a completed sentence or a backlog of sound.
    const delta = Number.isFinite(dt) ? Math.max(0, Math.min(.1, dt)) : 0;
    if (this.index === this.line.length) {
      this.hold += delta;
      if (this.hold >= 2.3) { this.line = monitorMurmurLine(this.name, this.random); this.index = 0; this.elapsed = 0; this.hold = 0; }
    } else {
      this.elapsed += delta;
      const next = this.line[this.index];
      const interval = next === '\n' ? .65 : next === '…' ? .25 : MONITOR_LETTER_S;
      if (this.elapsed >= interval) { this.elapsed -= interval; letter = next; ++this.index; }
    }
    return { text: this.text, letter };
  }
}

/** Match the server's 55° view cone and body samples, before the next freeze snapshot arrives. */
export function monitorObserved(camera: THREE.Camera, feet: THREE.Vector3, sight: Sight): boolean {
  camera.getWorldDirection(direction);
  for (const height of [1.65, 1, .35]) {
    part.copy(feet); part.y += height;
    to.copy(part).sub(camera.position);
    const distance = to.length();
    if (distance > 40 || (distance > 1e-6 && direction.dot(to.multiplyScalar(1 / distance)) < Math.cos(55 * Math.PI / 180))) continue;
    if (sight(camera.position, part)) return true;
  }
  return false;
}

/** At most one nearby monitor gets the caption and the quiet, higher wordless voice bus. */
export class MonitorMurmurs {
  private readonly lines = new Map<number, MonitorMurmurLine>();
  private readonly voice: Voice;
  private readonly el: HTMLElement;
  private selected?: number;
  private disposed = false;
  private readonly onHide = () => this.pause();
  private readonly onVisibility = () => { if (document.hidden) this.pause(); };

  constructor(el?: HTMLElement, voice?: Voice) {
    this.el = el ?? document.createElement('div');
    this.el.classList.add('monitor-murmur'); this.el.hidden = true;
    if (!el) (document.getElementById('hud') ?? document.body).appendChild(this.el);
    this.voice = voice ?? new Voice(null, { pitch: () => 190 + Math.random() * 65, syllableLimit: 2 });
    window.addEventListener('pagehide', this.onHide);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  setPreferences(volume: number, muted: boolean): void { this.voice.setPreferences(volume, muted); }

  update(dt: number, camera: THREE.Camera, mobs: ReadonlyMap<number, MurmurSource>, sight: Sight, active: boolean): void {
    if (this.disposed) return;
    for (const [id, line] of this.lines) if (mobs.get(id)?.displayName !== line.name) this.lines.delete(id);
    if (!active || document.hidden) { this.pause(); return; }
    let selected: { id: number; source: MurmurSource; distance: number } | undefined;
    let previous: typeof selected;
    for (const [id, source] of mobs) {
      if (!source.monitor || !source.displayName || source.anim === 'freeze' || monitorObserved(camera, source.mesh.position, sight)) continue;
      part.copy(source.mesh.position); part.y += source.displayName === '角色020' ? 1.5 : HEAD_Y;
      const distance = camera.position.distanceTo(part);
      if (distance >= MONITOR_MURMUR_RANGE || Math.abs(camera.position.y - part.y) > 2.5 || !sight(camera.position, part)) continue;
      const item = { id, source, distance };
      if (id === this.selected) previous = item;
      if (!selected || distance < selected.distance) selected = item;
    }
    // Small changes in interpolation cannot make two close murmurers fight over every frame.
    if (previous && selected && previous.distance <= selected.distance + 1.2) selected = previous;
    if (!selected) { this.pause(); return; }
    if (this.selected !== selected.id) { this.voice.cancel(); this.selected = selected.id; }
    let line = this.lines.get(selected.id);
    if (!line) { line = new MonitorMurmurLine(selected.source.displayName!); this.lines.set(selected.id, line); }
    const frame = line.step(dt);
    this.el.textContent = frame.text;
    this.el.dataset.speaker = line.name;
    this.el.hidden = !frame.text;
    this.el.style.opacity = String(Math.min(1, (MONITOR_MURMUR_RANGE - selected.distance) / 3));
    if (frame.letter.trim()) {
      // Reuse the tested gesture/mute/background lifecycle; distance is mapped to its 40 m attenuation curve.
      const gain = .35 * (1 - selected.distance / MONITOR_MURMUR_RANGE) ** 2;
      this.voice.say(frame.letter, 4 + (VOICE_MAX_M - 4) * (1 - gain));
    }
  }

  /** Pause preserves letter progress; network/frame recovery never replays missed characters. */
  pause(): void {
    this.voice.cancel(); this.el.hidden = true; this.el.textContent = ''; delete this.el.dataset.speaker;
    this.selected = undefined;
  }
  reset(): void { this.pause(); this.lines.clear(); }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.reset(); this.voice.dispose(); this.el.remove();
    window.removeEventListener('pagehide', this.onHide);
    document.removeEventListener('visibilitychange', this.onVisibility);
  }
}
