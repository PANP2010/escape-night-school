// Monsters in the scene: one interpolated 角色074 (warden/model.ts) per snapshot mob.
import * as THREE from 'three';
import { EXTRAP_MAX_MS, EXTRAP_MAX_SPEED, INTERP_DELAY_MS, TICK_MS } from '../../shared/constants.ts';
import type { MobSnap } from '../../shared/protocol.ts';
import { canonicalStudentName } from '../../shared/studentNames.ts';
import { approachYaw, InterpBuffer, PlaybackClock, StepSmoother } from './interp.ts';
import { Warden } from './warden/model.ts';
import { MonitorName } from './monitorName.ts';
import { MonitorFace } from './monitorFace.ts';
import { MonitorOutfit } from './monitorOutfit.ts';
import { BossBadge } from './role_bossBadge.ts';
import { WardenForms, WardenNightLight } from './warden/forms.ts';
import { MonitorAnimator } from './warden/monitorAnim.ts';
import { makeMonitorMaterials } from './warden/textures.ts';
import { syncWardenMaterialLighting, type WardenLighting } from './warden/lighting.ts';

interface Mob { mesh: THREE.Object3D; warden: Warden; forms?: WardenForms; monitor: boolean; monitorAnim?: MonitorAnimator; displayName?: string; nameTag?: MonitorName; namedFace?: MonitorFace; outfit?: MonitorOutfit; bossBadge?: BossBadge; buf: InterpBuffer; clock: PlaybackClock; sm: StepSmoother; form: string; anim: string; poseTime: number; at: [number, number, number]; skipMonitorStep: boolean }

const _fr = new THREE.Frustum(), _pv = new THREE.Matrix4(), _sph = new THREE.Sphere();
/**
 * Skinned meshes opt out of three's frustum culling (their posed bounds drift from the bind pose), so a figure behind
 * the camera still costs its ~15k triangles. Test a generous sphere around the standing figure ourselves.
 */
export function cullSkinned(cam: THREE.Camera, figures: Iterable<THREE.Object3D>): void {
  const fr = viewFrustum(cam);
  for (const f of figures) f.visible = figureInView(fr, f.position);
}
/** `cam`'s view frustum from its current matrices (shared scratch: valid until the next call). */
export const viewFrustum = (cam: THREE.Camera) => _fr.setFromProjectionMatrix(_pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
/** Whether a standing figure with its feet at `feet` (world space) may show in `fr`. */
export const figureInView = (fr: THREE.Frustum, feet: THREE.Vector3) => fr.intersectsSphere(_sph.set(feet, 3).translate(_up));
const BLINK_SLACK_MS = 80; // snapshots of the blink's last ticks still in flight
const TELEPORT_M = 3; // one tick's move beyond this is a teleport (summon / respawn): 7.8 m/s covers 0.4 m
const _up = new THREE.Vector3(0, 1, 0);

/** Server mob ids: 1 = 角色074, 2.. = 无脸值日生 (room.ts mobSnaps); `kind` on the wire wins when present. */
export const isMonitor = (m: Pick<MobSnap, 'id' | 'kind'>) => (m.kind ?? (m.id >= 2 ? 'monitor' : 'warden')) === 'monitor';

/** Temporary adapter until the shared Warden rig exposes setForm; only the L8 perfect form is changed. */
export const FINALE_HEIGHT_M = 2.3;
const NORMAL_HEIGHT_M = 1.75;
export const formHeightScale = (form: string) => form === 'perfect' ? FINALE_HEIGHT_M / NORMAL_HEIGHT_M : 1;

let armbandGeo: THREE.BufferGeometry | undefined;
let armbandMat: THREE.Material | undefined;
/** The 值日生 in the scene: its own tall, thin, upright build in a white shirt, blank paper face and a red armband on the left upper arm. */
function monitorFigure(): Warden {
  const w = new Warden(makeMonitorMaterials(), false, 'monitor');
  armbandGeo ??= new THREE.CylinderGeometry(0.082, 0.082, 0.085, 14, 1, true);
  armbandMat ??= new THREE.MeshStandardMaterial({ color: 0xb01818, roughness: 0.7, side: THREE.DoubleSide });
  const band = new THREE.Mesh(armbandGeo, armbandMat);
  band.position.set(0, -0.14, -0.012);
  w.bones.upperArmL.add(band);
  return w;
}

const TEX_SLOTS = ['map', 'emissiveMap', 'bumpMap', 'normalMap', 'roughnessMap', 'alphaMap'] as const;
/** The textures a material samples (the slots our figures use). */
export function materialTextures(m: THREE.Material): THREE.Texture[] {
  const r = m as unknown as Record<string, unknown>;
  return TEX_SLOTS.map((k) => r[k]).filter((t): t is THREE.Texture => t instanceof THREE.Texture);
}

export class Mobs {
  readonly byId = new Map<number, Mob>();
  private scene: THREE.Scene;
  private warpUntil = 0;
  /** Figures built (and their shaders compiled) ahead of the first summon, taken by onSnap before it builds new ones. */
  private spare: { warden: Warden[]; monitor: Warden[] } = { warden: [], monitor: [] };
  private warming?: Promise<void>;
  private nightLight?: WardenNightLight;
  private readonly formControllers = new WeakMap<Warden, WardenForms>();

  constructor(scene: THREE.Scene) { this.scene = scene; }

  /** Buildings use analytic tube lighting; give the teacher the matching diffuse fill instead of a black silhouette. */
  syncLighting(light: WardenLighting): void {
    for (const mob of this.byId.values()) if (!mob.monitor) {
      for (const material of mob.warden.mesh.material as THREE.Material[]) syncWardenMaterialLighting(material, light);
    }
  }

  /** Build one 角色074 and one 值日生 off-scene and compile their programs against the scene's lights (KHR_parallel_shader_compile:
   *  in the background) and upload their textures, so the first summon doesn't stall the page on a link (swiftshader: 6–7 s). Once. */
  prewarm(renderer: THREE.WebGLRenderer, cam: THREE.Camera): Promise<void> {
    return this.warming ??= (async () => {
      const figs = [new Warden(), monitorFigure()];
      this.spare.warden.push(figs[0]); this.spare.monitor.push(figs[1]);
      const forms = this.formsFor(figs[0]);
      for (const f of figs) {
        const restore = f === figs[0] ? forms.warmAccessories() : undefined;
        try {
          f.root.updateMatrixWorld(true);
          for (const m of f.mesh.material as THREE.Material[]) for (const t of materialTextures(m)) renderer.initTexture(t);
          await renderer.compileAsync(f.root, cam, this.scene);
        } finally { restore?.(); }
      }
    })();
  }

  /** A prewarmed figure of that kind if one is left, else a fresh one. */
  private figure(monitor: boolean): Warden {
    return (monitor ? this.spare.monitor : this.spare.warden).pop() ?? (monitor ? monitorFigure() : new Warden());
  }
  private formsFor(warden: Warden): WardenForms {
    let forms = this.formControllers.get(warden);
    if (!forms) { forms = new WardenForms(warden); this.formControllers.set(warden, forms); }
    return forms;
  }

  /** Apply a snapshot's mob list stamped `t` (server tick clock, ms); mobs missing from it are removed. */
  onSnap(mobs: MobSnap[], t: number) {
    const seen = new Set<number>();
    for (const m of mobs) {
      seen.add(m.id);
      let o = this.byId.get(m.id);
      const created = !o;
      if (!o) {
        const monitor = isMonitor(m), warden = this.figure(monitor);
        o = { mesh: warden.root, warden, forms: monitor ? undefined : this.formsFor(warden), monitor, monitorAnim: monitor ? new MonitorAnimator(warden) : undefined, buf: new InterpBuffer(), clock: new PlaybackClock(INTERP_DELAY_MS), sm: new StepSmoother(), form: m.form ?? 'normal', anim: m.anim ?? 'idle', poseTime: 0, at: [...m.p], skipMonitorStep: false };
        if (!monitor) this.nightLight ??= new WardenNightLight(this.scene);
        o.mesh.position.set(m.p[0], m.p[1], m.p[2]);
        this.scene.add(o.mesh);
        this.byId.set(m.id, o);
      }
      const displayName = m.name === undefined ? undefined : canonicalStudentName(m.name);
      if (o.monitor && displayName !== undefined && displayName !== o.displayName) {
        o.nameTag?.dispose(); o.namedFace?.dispose(); o.outfit?.dispose();
        o.nameTag = undefined; o.namedFace = undefined; o.outfit = undefined; o.displayName = displayName;
        if (displayName !== '值周生') {
          o.nameTag = new MonitorName(displayName); o.mesh.add(o.nameTag.sprite);
          o.namedFace = new MonitorFace(o.warden, displayName);
          if (displayName === '角色078') o.outfit = new MonitorOutfit(o.warden);
          if (displayName === '角色020') o.nameTag.sprite.position.y = 1.82;
        }
        o.mesh.userData.displayName = displayName;
      }
      if (m.form !== undefined && m.form !== o.form) { o.form = m.form; o.poseTime = 0; }
      if (o.form === 'role_boss' && !o.bossBadge) o.bossBadge = new BossBadge(o.warden);
      else if (o.form !== 'role_boss' && o.bossBadge) { o.bossBadge.dispose(); o.bossBadge = undefined; }
      o.mesh.scale.y = o.forms ? 1 : formHeightScale(o.form);
      o.forms?.setForm(o.form);
      if (m.anim !== undefined) o.anim = m.anim;
      const tp = Math.hypot(m.p[0] - o.at[0], o.monitor ? m.p[1] - o.at[1] : 0, m.p[2] - o.at[2]) > TELEPORT_M;
      o.at = [...m.p];
      o.buf.push({ t, x: m.p[0], y: m.p[1], z: m.p[2], yaw: m.yaw });
      if (o.monitor) {
        // A stopped monitor lands at the authoritative point immediately, including yaw. Keep only stationary samples
        // while frozen or idle, so it cannot replay the run-up through the position filter or extrapolator.
        if (created || tp || o.anim === 'freeze' || o.anim === 'idle') this.placeMonitor(o);
        if (created || m.anim !== undefined) o.monitorAnim!.update(0, 0, o.anim);
      } else if (tp) { o.buf.collapse(); o.clock.t = NaN; } // pop there, don't let the box filter streak it across the gap
    }
    for (const [id, o] of this.byId) if (!seen.has(id)) {
      o.nameTag?.dispose(); o.namedFace?.dispose(); o.outfit?.dispose();
      o.bossBadge?.dispose();
      o.forms?.dispose();
      this.scene.remove(o.mesh);
      o.warden.mesh.geometry.dispose();
      o.warden.mesh.skeleton.dispose();
      this.byId.delete(id);
    }
    if (![...this.byId.values()].some((o) => o.forms?.form === 'night')) this.nightLight?.update();
  }

  /** 眨眼 (screens black for `secs`): until it ends the 值日生 sit at their newest server position, no sliding (it may have moved ≥1.2 m meanwhile). */
  blink(now: number, secs: number) {
    this.warpUntil = now + secs * 1000 + BLINK_SLACK_MS;
    for (const o of this.byId.values()) if (o.monitor) this.placeMonitor(o);
  }

  /** Discontinuities move the statue, never its stride clock. The ordinary 角色074 playback is kept separate. */
  private placeMonitor(o: Mob): void {
    o.buf.collapse();
    o.clock.t = NaN;
    o.sm.reset();
    const s = o.buf.at(o.buf.lastT());
    if (!s) return;
    o.sm.step(s.x, s.z, 0, 0);
    o.mesh.position.set(s.x, s.y, s.z);
    o.mesh.rotation.y = s.yaw;
    o.skipMonitorStep = true;
  }

  /** Move the meshes to their interpolated state; `heads` = player head positions for the look-at; `now`/`dt` as in Game.frame.
   *  Same playback as Game's remotes (#180): a per-mob clock ~INTERP_DELAY_MS behind the newest snapshot (server ticks run
   *  ~52 ms with bursty arrival, so `now − delay` ran dry and caught up in leaps), xz box-filtered over 2 ticks and each
   *  frame's step capped near the sampled speed; the yaw eases instead of popping. */
  update(now: number, dt: number, heads: THREE.Vector3[] = [], cam?: THREE.Camera, visible?: (from: THREE.Vector3, to: THREE.Vector3) => boolean) {
    const warp = now < this.warpUntil;
    let night: WardenForms | undefined, nightDistance = Infinity;
    for (const o of this.byId.values()) {
      o.nameTag?.update(cam, visible);
      if (o.monitor && o.anim === 'freeze') {
        o.monitorAnim!.update(0, 0, 'freeze');
        continue; // root, yaw, bones and gait phase all stay still while watched
      }
      if (warp && o.monitor) {
        this.placeMonitor(o);
        o.monitorAnim!.update(0, 0, o.anim);
        continue;
      }
      const first = Number.isNaN(o.clock.t);
      const fresh = o.clock.advance(dt * 1000, o.buf.lastT(), o.buf.lastT() + EXTRAP_MAX_MS); // as Game's remotes: ≤ EXTRAP_MAX_MS past the newest
      const rt = o.clock.t;
      const s = o.buf.at(rt, EXTRAP_MAX_MS, EXTRAP_MAX_SPEED);
      if (!s) continue;
      const g = o.buf.avgAt(rt, 2 * TICK_MS, 5, EXTRAP_MAX_MS, EXTRAP_MAX_SPEED)!;
      // A hidden figure has no visible position to preserve across a playback-clock jump (intro / offscreen load).
      // Only an already visible body needs to slide from its old spot within the existing catch-up budget.
      if (fresh) { if (first || o.monitor || !o.mesh.visible) o.sm.reset(); else o.sm.catchUp(); }
      const jumped = o.sm.step(g.x, g.z, dt, o.buf.paceSpeed());
      const skipStride = o.monitor && (o.skipMonitorStep || fresh || jumped);
      const speed = dt > 0 && !skipStride ? Math.hypot(o.sm.x - o.mesh.position.x, o.sm.z - o.mesh.position.z) / dt : 0;
      o.mesh.position.set(o.sm.x, s.y, o.sm.z);
      o.mesh.rotation.y = fresh && (first || o.monitor) ? s.yaw : approachYaw(o.mesh.rotation.y, s.yaw, dt);
      if (o.monitor) {
        o.monitorAnim!.update(dt, speed, o.anim);
        o.skipMonitorStep = false;
        continue;
      }
      let near: THREE.Vector3 | null = null, best = Infinity;
      for (const h of heads) { const d = h.distanceToSquared(o.mesh.position); if (d < best) { best = d; near = h; } }
      if (o.form === 'perfect' || o.form === 'finale') {
        o.poseTime += dt;
        if (o.poseTime >= 0.3) {
          const step = Math.floor(o.poseTime / 0.3) * 0.3;
          o.poseTime -= step;
          (o.forms ?? o.warden).update(step, Math.min(speed, 6), o.anim, near);
        }
      } else (o.forms ?? o.warden).update(dt, Math.min(speed, 6), o.anim, near);
      if (o.forms?.form === 'night') {
        const d = cam ? cam.position.distanceToSquared(o.mesh.position) : 0;
        if (d < nightDistance) { nightDistance = d; night = o.forms; }
      }
    }
    this.nightLight?.update(night);
  }
}
