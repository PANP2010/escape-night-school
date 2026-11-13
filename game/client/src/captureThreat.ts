import * as THREE from 'three';
import { Warden } from './warden/model.ts';
import { faceTexture, makeMaterials } from './warden/textures.ts';
import type { CaptureFrame } from './capturePresentation.ts';

const smooth = (n: number) => { const t = Math.max(0, Math.min(1, n)); return t * t * (3 - 2 * t); };
export const CAPTURE_THREAT_MS = 560;
/** One contact accent at the start of a genuine local catch, followed by the existing shoulder / down animation. */
export function captureThreatBeat(elapsed: number, reduced: boolean) {
  return {
    opacity: smooth(elapsed / (reduced ? 90 : 35)) * (1 - smooth((elapsed - 300) / 260)),
    distance: reduced ? .98 : 1.35 - .72 * smooth(elapsed / 120),
  };
}

/** Reuses the game's code-built teacher. Camera-local contact is cosmetic: the server body never moves. */
export class CaptureThreat {
  readonly warden: Warden;
  private readonly materials: THREE.MeshBasicMaterial[];
  private readonly opacities: number[];
  private readonly textures = new Set<THREE.Texture>();
  private readonly face = faceTexture(.95);
  private readonly camera: THREE.Camera;
  private source?: { figure: THREE.Object3D; visible: boolean };
  private disposed = false;

  constructor(camera: THREE.Camera) {
    this.camera = camera;
    const originals = makeMaterials();
    this.materials = originals.map(material => {
      const source = material as THREE.MeshStandardMaterial;
      for (const texture of [source.map, source.bumpMap, source.emissiveMap]) if (texture) this.textures.add(texture);
      const portrait = new THREE.MeshBasicMaterial({
        color: source.color, map: source.map, side: source.side,
        transparent: true, opacity: source.opacity, depthTest: true, depthWrite: true, fog: false,
      });
      // A soft contact accent reveals the familiar face; it does not change the lighting of the world.
      if (source.map) portrait.color.setRGB(.78, .82, .76);
      material.dispose();
      return portrait;
    });
    this.opacities = this.materials.map(material => material.opacity);
    this.textures.add(this.face);
    this.warden = new Warden(this.materials);
    this.warden.root.name = 'capture-warden-contact';
    this.warden.root.rotation.y = Math.PI;
    this.warden.mesh.renderOrder = 990_000; // under the existing film, above world transparency
    this.warden.root.visible = false;
    camera.add(this.warden.root);
  }

  bindSource(figure?: THREE.Object3D): void {
    this.restoreSource();
    if (figure) this.source = { figure, visible: figure.visible };
  }
  private restoreSource(): void {
    if (this.source) this.source.figure.visible = this.source.visible;
    this.source = undefined;
  }

  /** Compile before contact, so linking a new skinned program cannot consume the short scare beat. */
  prewarm(renderer: THREE.WebGLRenderer, scene: THREE.Scene): Promise<unknown> {
    const visible = this.warden.root.visible;
    this.warden.root.visible = true;
    try { return renderer.compileAsync(this.warden.root, this.camera, scene); }
    finally { this.warden.root.visible = visible; }
  }

  update(frame: CaptureFrame, reduced: boolean): void {
    const show = !this.disposed && frame.caught && frame.by === 'warden' && frame.elapsed < CAPTURE_THREAT_MS;
    this.warden.root.visible = show;
    if (!show) { this.restoreSource(); return; }
    // The close contact replaces the same actor's world pose for this short beat; never display two teachers.
    if (this.source) this.source.figure.visible = false;
    const beat = captureThreatBeat(frame.elapsed, reduced);
    this.warden.anim.pose('catch', .3 + frame.elapsed / 1600);
    this.materials[0].map = this.face;
    this.warden.root.position.set(frame.side === 'left' ? -.09 : .09, -1.62, -beat.distance);
    this.warden.root.rotation.z = reduced ? 0 : frame.side === 'left' ? -.035 : .035;
    this.materials.forEach((material, index) => { material.opacity = this.opacities[index] * beat.opacity; });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.restoreSource();
    this.warden.root.removeFromParent();
    this.warden.mesh.geometry.dispose(); this.warden.mesh.skeleton.dispose();
    this.materials.forEach(material => material.dispose());
    this.textures.forEach(texture => texture.dispose());
  }
}
