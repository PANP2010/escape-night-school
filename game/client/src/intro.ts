import * as THREE from 'three';
import type { IntroEvent } from '../../shared/intro.ts';
import type { Vec3 } from '../../shared/protocol.ts';
import { Warden } from './warden/model.ts';
import { makeMaterials } from './warden/textures.ts';
import { syncWardenMaterialLighting, type WardenLighting } from './warden/lighting.ts';
import './intro.css';

const clamp = (v: number) => Math.max(0, Math.min(1, v));
const ease = (v: number) => { const t = clamp(v); return t * t * (3 - 2 * t); };

/** Arc-length interpolation stays on authoritative nav edges, including corridor corners. */
export function introPoint(route: readonly Vec3[], progress: number): THREE.Vector3 {
  if (!route.length) return new THREE.Vector3();
  const lengths = route.slice(1).map((p, i) => Math.hypot(p[0] - route[i][0], p[1] - route[i][1], p[2] - route[i][2]));
  let distance = lengths.reduce((a, b) => a + b, 0) * clamp(progress);
  for (let i = 0; i < lengths.length; i++) {
    if (distance <= lengths[i]) return new THREE.Vector3(...route[i]).lerp(new THREE.Vector3(...route[i + 1]), lengths[i] ? distance / lengths[i] : 0);
    distance -= lengths[i];
  }
  return new THREE.Vector3(...route.at(-1)!);
}

/** An eight-second local presentation. Only an authoritative ended event releases the lock. */
export class LevelIntro {
  id = -1;
  active = false;
  skipped = false;
  get presenting() { return this.active && !this.skipped && this.remaining > 0; }
  get remaining() { return this.active ? Math.max(0, (this.deadline - performance.now()) / 1000) : 0; }
  get reducedMotion() { return !!this.reduced?.matches; }
  private readonly reduced = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined;
  private deadline = 0;
  private started = 0;
  private event?: IntroEvent;
  private saved?: { position: THREE.Vector3; rotation: THREE.Quaternion };
  private figure?: Warden;
  private readonly figureTextures = new Set<THREE.Texture>();
  private cue = false;
  private disposed = false;
  private readonly skipTouches = new Set<number>();
  private readonly liveTouches = new Set<number>();
  private readonly blockedTouches = new Set<number>();
  private readonly root = document.createElement('section');
  private readonly title = document.createElement('h1');
  private readonly goal = document.createElement('p');
  private readonly wait = document.createElement('p');
  private readonly skipButton = document.createElement('button');
  private readonly veil = document.createElement('div');
  private readonly frame = document.createElement('div');
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly sendSkip: (id: number) => void;
  private readonly lock: () => void;
  private readonly unlock: () => void;
  private readonly stinger: () => void;

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, sendSkip: (id: number) => void,
    lock: () => void, unlock: () => void, stinger: () => void) {
    this.scene = scene; this.camera = camera; this.sendSkip = sendSkip; this.lock = lock; this.unlock = unlock; this.stinger = stinger;
    this.root.id = 'intro-overlay'; this.root.hidden = true;
    this.root.setAttribute('role', 'dialog'); this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-labelledby', 'intro-title'); this.root.setAttribute('aria-describedby', 'intro-objective');
    this.veil.className = 'intro-veil'; this.frame.className = 'intro-card';
    const kicker = document.createElement('p'); kicker.className = 'intro-kicker'; kicker.textContent = '逃离夜校';
    this.title.id = 'intro-title'; this.goal.id = 'intro-objective';
    this.wait.id = 'intro-wait'; this.wait.setAttribute('role', 'status');
    this.skipButton.id = 'intro-skip'; this.skipButton.type = 'button';
    this.skipButton.textContent = document.body.classList.contains('touch') ? '跳过' : '跳过 · Space';
    this.skipButton.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); this.skip(); });
    this.frame.append(kicker, this.title, this.goal);
    this.root.append(this.veil, this.frame, this.wait, this.skipButton); document.body.append(this.root);
    addEventListener('keydown', this.key, { capture: true });
    for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) addEventListener(type, this.touch, { capture: true, passive: false });
  }

  private key = (e: KeyboardEvent) => {
    if (e.target instanceof Element && ['#developer-tools-open', '#developer-tools'].some(selector => e.target instanceof Element && e.target.closest(selector))) return;
    if (!this.active || e.code !== 'Space') return;
    e.preventDefault(); e.stopPropagation();
    if (!e.repeat) this.skip();
  };

  /** Consume the whole gesture, including a touch begun on controls before the intro arrived. */
  private touch = (event: Event) => {
    if (event.target instanceof Element && ['#update-available', '#developer-tools-open', '#developer-tools'].some(selector => event.target instanceof Element && event.target.closest(selector))) return;
    const e = event as TouchEvent;
    const changed = Array.from(e.changedTouches);
    const ending = e.type === 'touchend' || e.type === 'touchcancel';
    if (e.type === 'touchstart') for (const t of changed) this.liveTouches.add(t.identifier);
    if (this.active && !ending) for (const t of changed) this.blockedTouches.add(t.identifier);
    // A new finger can use controls while an old one is still down. Mixed move/end events
    // reach the reset controls, which only recognize the new identifiers they accepted.
    const consume = this.active || (changed.length > 0 && changed.every((t) => this.blockedTouches.has(t.identifier)));
    if (ending) for (const t of changed) { this.liveTouches.delete(t.identifier); this.blockedTouches.delete(t.identifier); }
    if (!consume) return;
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
    const button = event.target instanceof Node && this.skipButton.contains(event.target);
    if (e.type === 'touchstart' && button) for (const t of Array.from(e.changedTouches)) this.skipTouches.add(t.identifier);
    let skip = false;
    for (const t of changed) {
      if (e.type === 'touchend' && this.skipTouches.has(t.identifier)) skip = true;
      if (e.type === 'touchend' || e.type === 'touchcancel') this.skipTouches.delete(t.identifier);
    }
    // Sending only after touchend prevents a fast all-skipped reply from exposing gameplay to this finger.
    if (skip) this.skip();
  };

  receive(event: IntroEvent, name: string, goal: string, player: number) {
    if (this.disposed || event.id < this.id) return;
    if (event.id === this.id && !this.active) return; // a delayed old update cannot reopen a finished introduction
    if (event.ended) { this.id = event.id; this.finish(); return; }
    const fresh = event.id !== this.id;
    if (fresh) {
      this.restore(); this.id = event.id; this.active = true; this.skipped = false; this.saved = undefined; this.cue = false;
      this.title.textContent = `第 ${event.level + 1} 关 · ${name}`; this.goal.textContent = goal;
      this.skipButton.disabled = false; this.skipButton.hidden = false;
      this.frame.style.opacity = ''; this.veil.style.opacity = '1'; this.skipTouches.clear(); this.lock();
      for (const id of this.liveTouches) this.blockedTouches.add(id);
      if (document.pointerLockElement) document.exitPointerLock();
    }
    this.event = event;
    // Map server wall time to the monotonic local clock; late arrivals start at the remaining beat.
    const now = performance.now(); this.deadline = now + Math.max(0, event.endsAt - event.now); this.started = now - Math.max(0, event.now - event.startedAt);
    this.skipped ||= event.skipped.includes(player);
    this.root.hidden = false; document.body.classList.add('intro-active');
    this.root.classList.toggle('intro-reduced', this.reducedMotion);
    this.updateWait();
    if (fresh && !this.skipped) this.skipButton.focus({ preventScroll: true });
  }

  skip() {
    if (!this.active || this.skipped) return;
    this.skipped = true; this.restore(); this.updateWait(); this.sendSkip(this.id);
  }

  private updateWait() {
    const waiting = this.skipped || this.remaining === 0;
    this.root.classList.toggle('intro-waiting', waiting);
    const message = this.skipped ? '已跳过，等待队友…' : waiting ? '等待队友准备好…' : '';
    if (this.wait.textContent !== message) this.wait.textContent = message;
    this.skipButton.hidden = waiting; this.skipButton.disabled = waiting;
    this.frame.style.opacity = waiting ? '0' : '';
    if (waiting) this.veil.style.opacity = '0.42';
  }

  /** Run even while simulation is frozen, after the player's authoritative spawn is known. */
  update(ready: boolean) {
    if (!this.active || !this.event) return;
    this.updateWait();
    if (!this.presenting) { this.restore(); return; }
    const elapsed = Math.max(0, (performance.now() - this.started) / 1000);
    if (!ready) { this.veil.style.opacity = '1'; return; }
    this.saved ??= { position: this.camera.position.clone(), rotation: this.camera.quaternion.clone() };
    if (this.reducedMotion) {
      this.restore(false); this.veil.style.opacity = '0.45'; this.frame.style.opacity = '1'; return;
    }
    // Prepare the existing model under the opening black beat, before its distant reveal.
    if (this.event.silhouette && !this.figure) this.figure = this.makeFigure();
    this.veil.style.opacity = String(elapsed < 1.3 ? 1 - ease(elapsed / 1.3) : elapsed > 6.4 ? (elapsed < 7.15 ? ease((elapsed - 6.4) / 0.75) : 1 - ease((elapsed - 7.15) / 0.85)) : 0);
    this.frame.style.opacity = String(elapsed < 4.5 ? 1 : 1 - ease((elapsed - 4.5) / 0.8));
    const route = this.event.route;
    if (route.length > 1 && elapsed < 7.15) {
      const progress = ease((elapsed - 0.6) / 5.4), point = introPoint(route, progress);
      point.y += 1.55; this.camera.position.copy(point);
      const ahead = introPoint(route, Math.min(1, progress + 0.08)); ahead.y += 1.55;
      const end = this.event.silhouette;
      if (end && progress > 0.8) ahead.set(end[0], end[1] + 1.45, end[2]);
      if (ahead.distanceToSquared(point) > 0.0001) this.camera.lookAt(ahead);
      // The opening black beat covers the cut from the player's spawn to the first nav edge.
    } else this.restore(false);
    const reveal = elapsed >= 5 && elapsed < 6.55 && !!this.event.silhouette;
    if (reveal) {
      const figure = this.figure ??= this.makeFigure();
      figure.root.position.set(...this.event.silhouette!);
      // Warden faces local -Z; Object3D.lookAt would turn his back toward the camera.
      figure.root.rotation.y = Math.atan2(figure.root.position.x - this.camera.position.x, figure.root.position.z - this.camera.position.z);
      figure.root.visible = true;
      if (!this.cue) { this.cue = true; this.stinger(); }
    } else if (this.figure) this.figure.root.visible = false;
  }

  private makeFigure() {
    // Reuse the established bald, glasses-and-jacket silhouette; no separate monster design or gameplay entity.
    // Independent, slightly subdued materials follow the room's light instead of painting a black cutout on it.
    const materials = makeMaterials();
    for (const material of materials) {
      const surface = material as THREE.MeshStandardMaterial;
      surface.color.multiplyScalar(.9);
      for (const texture of [surface.map, surface.bumpMap, surface.emissiveMap]) if (texture) this.figureTextures.add(texture);
    }
    const figure = new Warden(materials);
    figure.anim.update(0, 'idle', 0); figure.root.visible = false; this.scene.add(figure.root); return figure;
  }

  syncLighting(light: WardenLighting): void {
    if (this.figure) for (const material of this.figure.mesh.material as THREE.Material[]) syncWardenMaterialLighting(material, light);
  }

  private restore(clear = true) {
    if (this.saved) { this.camera.position.copy(this.saved.position); this.camera.quaternion.copy(this.saved.rotation); }
    if (this.figure) this.figure.root.visible = false;
    if (clear) this.saved = undefined;
  }

  private finish(notify = true) {
    const active = this.active; this.restore(); this.active = false; this.root.hidden = true; this.event = undefined;
    this.skipTouches.clear();
    if (this.root.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    document.body.classList.remove('intro-active');
    if (active && notify) this.unlock();
  }

  /** A level replacement cancels presentation without releasing the new level's input lock. */
  reset() { this.finish(false); }

  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.finish(false); removeEventListener('keydown', this.key, true);
    for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) removeEventListener(type, this.touch, true);
    this.root.remove();
    this.liveTouches.clear(); this.blockedTouches.clear();
    if (this.figure) {
      this.scene.remove(this.figure.root); this.figure.anim.mixer.stopAllAction();
      this.figure.mesh.geometry.dispose(); this.figure.mesh.skeleton.dispose();
      for (const mat of this.figure.mesh.material as THREE.Material[]) mat.dispose();
      for (const texture of this.figureTextures) texture.dispose();
    }
  }
}
