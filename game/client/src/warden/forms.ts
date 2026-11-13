// Snapshot variants of the same teacher. Accessories use the posed bones, including the model's own scale / π turn.
import * as THREE from 'three';
import type { WardenForm } from '../../../shared/wardenForms.ts';
import { MATS, type BoneName, type Warden } from './model.ts';
import { readableWardenMaterial } from './lighting.ts';

export const NIGHT_LIGHT_INTENSITY = 48, NIGHT_LIGHT_DISTANCE = 18, NIGHT_LIGHT_ANGLE = 0.43;
export const NIGHT_LIGHT_DECAY = 2; // interior_light.ts admits torches at decay >= TORCH_DECAY (1.9)
export const CHANGED_NECK_S = 1.15;
const BEAM_LENGTH = 9;
const FORMS: readonly string[] = ['normal', 'changed', 'night', 'rollcall', 'finale'];
// The finale Room still emits the original wire name while shared level forms use `finale`.
export const asWardenForm = (form: string): WardenForm => form === 'perfect' ? 'finale' : FORMS.includes(form) ? form as WardenForm : 'normal';
const smooth = (a: number, b: number, t: number) => { const x = Math.min(1, Math.max(0, (t - a) / (b - a))); return x * x * (3 - 2 * x); };
/** One deliberate tilt, held long enough to read, then returned to the ordinary pose. No random pose jumps. */
export const changedNeck = (t: number) => smooth(0, 0.22, t) * (1 - smooth(0.42, CHANGED_NECK_S, t));
const faceIndex = MATS.indexOf('face'), lensIndex = MATS.indexOf('lens');
type E = [number, number, number];

function changedTexture(base: THREE.Texture | null): THREE.Texture {
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 256;
  const g = canvas.getContext('2d')!;
  if (base?.image) g.drawImage(base.image as CanvasImageSource, 0, 0, 512, 256);
  // The dark opening covers the ordinary mouth. Its corners extend beyond the eyes, but the scalp / brows stay his.
  g.fillStyle = '#161713'; g.strokeStyle = '#4c4336'; g.lineWidth = 2; g.lineJoin = 'round';
  g.beginPath(); g.moveTo(76, 147); g.quadraticCurveTo(128, 161, 182, 145); g.quadraticCurveTo(130, 187, 76, 147); g.closePath();
  g.fill(); g.stroke(); g.save(); g.clip();
  g.fillStyle = '#dedcc9'; g.fillRect(76, 145, 108, 14);
  g.strokeStyle = '#716f60'; g.lineWidth = 1;
  for (let x = 89; x < 180; x += 13) { g.beginPath(); g.moveTo(x, 148); g.lineTo(x + 1, 160); g.stroke(); }
  g.restore();
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4;
  texture.name = 'warden-changed-smile'; return texture;
}

function beamMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.FrontSide,
    vertexShader: `varying vec3 w, n; varying float depth;
      void main() { vec4 p = modelMatrix * vec4(position, 1.0); w = p.xyz;
        n = normalize(mat3(modelMatrix) * normal); depth = position.z;
        gl_Position = projectionMatrix * viewMatrix * p; }`,
    fragmentShader: `varying vec3 w, n; varying float depth;
      void main() { float edge = pow(abs(dot(normalize(n), normalize(cameraPosition - w))), 0.7);
        float a = 0.045 * edge * smoothstep(0.0, 0.4, depth) * (1.0 - smoothstep(4.0, 9.0, depth));
        gl_FragColor = vec4(vec3(0.72, 0.78, 0.62), a); }`,
    toneMapped: false,
  });
}

export class WardenForms {
  readonly hat = new THREE.Group();
  readonly flashlight = new THREE.Group();
  readonly book = new THREE.Group();
  form: WardenForm = 'normal';
  private readonly warden: Warden;
  private readonly baseScale: THREE.Vector3;
  private readonly finaleScaleY: number;
  private readonly materials: THREE.Material[];
  private readonly face: THREE.Material;
  private readonly lens: THREE.Material;
  private readonly changedFace: THREE.MeshStandardMaterial;
  private readonly changedLens: THREE.MeshPhongMaterial;
  private readonly geometries = new Set<THREE.BufferGeometry>();
  private readonly ownedMaterials = new Set<THREE.Material>();
  private readonly textures = new Set<THREE.Texture>();
  private readonly saved = new Map<BoneName, THREE.Quaternion>();
  private readonly applied = new Set<BoneName>();
  private readonly euler = new THREE.Euler();
  private readonly q = new THREE.Quaternion();
  private readonly parentQ = new THREE.Quaternion();
  private readonly desiredQ = new THREE.Quaternion();
  private readonly origin = new THREE.Vector3(0, 0, 0.11);
  private age = 0;
  private time = 0;
  private disposed = false;

  constructor(warden: Warden) {
    this.warden = warden; this.baseScale = warden.mesh.scale.clone();
    warden.mesh.geometry.computeBoundingBox();
    const height = warden.mesh.geometry.boundingBox!.max.y - warden.mesh.geometry.boundingBox!.min.y;
    this.finaleScaleY = 2.3 / height;
    // Warden owns this material array. The animator keeps updating the original face material while the variant is shown.
    this.materials = warden.mesh.material as THREE.Material[];
    this.face = this.materials[faceIndex]; this.lens = this.materials[lensIndex];
    this.changedFace = (this.face as THREE.MeshStandardMaterial).clone();
    readableWardenMaterial(this.changedFace);
    this.changedFace.map = changedTexture(this.changedFace.map); this.textures.add(this.changedFace.map);
    this.changedLens = (this.lens as THREE.MeshPhongMaterial).clone();
    this.ownedMaterials.add(this.changedFace); this.ownedMaterials.add(this.changedLens);

    const knit = this.material(new THREE.MeshStandardMaterial({ color: 0x66715a, roughness: 1 }));
    const cap = new THREE.LatheGeometry([[0.116, 0], [0.123, 0.02], [0.12, 0.055], [0.1, 0.09], [0.06, 0.112], [0, 0.12]].map(([x, y]) => new THREE.Vector2(x, y)), 20);
    this.hat.name = 'warden-night-hat'; this.hat.position.set(0, 0.135, -0.006); this.hat.scale.z = 1.1;
    this.hat.add(this.mesh(cap, knit));
    const cuff = new THREE.CylinderGeometry(0.123, 0.12, 0.032, 48, 1, true); cuff.translate(0, 0.012, 0);
    // Closely spaced ridges catch the torch like a cheap rib-knit cuff, without another texture or a translucent shell.
    const cp = cuff.attributes.position;
    for (let i = 0; i < cp.count; i++) { const f = 1 + 0.012 * Math.cos(Math.atan2(cp.getZ(i), cp.getX(i)) * 24); cp.setX(i, cp.getX(i) * f); cp.setZ(i, cp.getZ(i) * f); }
    cuff.computeVertexNormals(); this.hat.add(this.mesh(cuff, knit)); warden.bones.head.add(this.hat);

    const black = this.material(new THREE.MeshStandardMaterial({ color: 0x262a25, roughness: 0.7, metalness: 0.25 }));
    const rim = this.material(new THREE.MeshStandardMaterial({ color: 0x777d70, roughness: 0.45, metalness: 0.5 }));
    const glow = this.material(new THREE.MeshBasicMaterial({ color: 0xdbe6c6, toneMapped: false }));
    this.flashlight.name = 'warden-night-flashlight'; this.flashlight.position.set(0, -0.04, 0.02);
    this.flashlight.add(this.mesh(new THREE.CylinderGeometry(0.026, 0.022, 0.15, 10).rotateX(Math.PI / 2).translate(0, 0, 0.02), black));
    this.flashlight.add(this.mesh(new THREE.CylinderGeometry(0.039, 0.027, 0.045, 12).rotateX(Math.PI / 2).translate(0, 0, 0.095), rim));
    this.flashlight.add(this.mesh(new THREE.CircleGeometry(0.033, 12).translate(0, 0, 0.119), glow));
    const beam = this.mesh(new THREE.ConeGeometry(BEAM_LENGTH * Math.tan(NIGHT_LIGHT_ANGLE), BEAM_LENGTH, 20, 1, true).rotateX(-Math.PI / 2).translate(0, 0, BEAM_LENGTH / 2 + 0.12), this.material(beamMaterial()));
    beam.name = 'warden-night-beam'; beam.renderOrder = 2; this.flashlight.add(beam); warden.bones.handR.add(this.flashlight);

    const cover = this.material(new THREE.MeshStandardMaterial({ color: 0x283c36, roughness: 0.95 }));
    const paper = this.material(new THREE.MeshStandardMaterial({ color: 0xc8c2a8, roughness: 1 }));
    this.book.name = 'warden-rollcall-book'; this.book.position.set(-0.05, -0.015, 0.025);
    this.book.add(this.mesh(new THREE.BoxGeometry(0.23, 0.02, 0.3), cover));
    this.book.add(this.mesh(new THREE.BoxGeometry(0.214, 0.012, 0.284).translate(0, 0.015, 0), paper));
    const lines = new THREE.BufferGeometry(), p: number[] = [];
    for (let z = -0.09; z <= 0.1; z += 0.03) p.push(-0.085, 0.022, z, 0.085, 0.022, z);
    lines.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); this.geometries.add(lines);
    this.book.add(new THREE.LineSegments(lines, this.material(new THREE.LineBasicMaterial({ color: 0x737567 }))));
    warden.bones.handL.add(this.book);
    this.hat.visible = this.flashlight.visible = this.book.visible = false;
  }

  private material<T extends THREE.Material>(m: T): T { this.ownedMaterials.add(m); return m; }
  private mesh(g: THREE.BufferGeometry, m: THREE.Material) { this.geometries.add(g); return new THREE.Mesh(g, m); }

  /** Include the accessory shaders in Mobs' existing off-scene compile, then restore the actual snapshot form. */
  warmAccessories(): () => void {
    this.hat.visible = this.flashlight.visible = this.book.visible = true;
    return () => {
      this.hat.visible = this.flashlight.visible = this.form === 'night'; this.book.visible = this.form === 'rollcall';
    };
  }

  setForm(form: string): void {
    const next = asWardenForm(form);
    if (this.disposed) return;
    // A snapshot may claim the spare while compileAsync is still pending with all accessories temporarily shown.
    this.hat.visible = this.flashlight.visible = next === 'night'; this.book.visible = next === 'rollcall';
    if (next === this.form) return;
    this.restore(); this.form = next; this.age = 0;
    this.materials[faceIndex] = next === 'changed' ? this.changedFace : this.face;
    this.materials[lensIndex] = next === 'changed' ? this.changedLens : this.lens;
    this.warden.mesh.scale.copy(this.baseScale);
    if (next === 'finale') this.warden.mesh.scale.y = this.finaleScaleY;
  }

  /** Undo our previous layer before the mixer reads the bones again, including bones its current clip may omit. */
  private restore() {
    for (const name of this.applied) this.warden.bones[name].quaternion.copy(this.saved.get(name)!);
    this.applied.clear();
  }
  private save(name: BoneName) {
    if (this.applied.has(name)) return;
    let q = this.saved.get(name); if (!q) this.saved.set(name, q = new THREE.Quaternion());
    q.copy(this.warden.bones[name].quaternion); this.applied.add(name);
  }
  private rotate(name: BoneName, e: E) { this.save(name); this.warden.bones[name].quaternion.multiply(this.q.setFromEuler(this.euler.set(...e))); }
  private pose(name: BoneName, e: E, weight: number) { this.save(name); this.warden.bones[name].quaternion.slerp(this.q.setFromEuler(this.euler.set(...e)), weight); }

  update(dt: number, speed: number, anim: string, look?: THREE.Vector3 | null): void {
    if (this.disposed) return;
    this.restore(); this.warden.update(dt, speed, anim, this.form === 'rollcall' ? null : look);
    this.age += Math.max(0, dt); this.time += Math.max(0, dt);
    if (this.form === 'changed') {
      const k = changedNeck(this.age); this.rotate('neck', [0.1 * k, 0.36 * k, 0.72 * k]); this.rotate('head', [0, 0, -0.16 * k]);
      this.changedLens.color.setHex(0xffffff); this.changedLens.emissive.setHex(0xffffff);
      this.changedLens.emissiveIntensity = 1; this.changedLens.opacity = 1; this.changedLens.transparent = false;
    }
    const k = smooth(0, 0.45, this.age);
    if (this.form === 'night') {
      this.pose('upperArmR', [-0.25, 0, -0.13], k); this.pose('foreArmR', [-1.2, 0, 0], k); this.pose('handR', [0, 0, 0], k);
      this.warden.root.updateMatrixWorld(true);
      this.aim(this.flashlight, this.warden.bones.handR, [0.23 + 0.04 * Math.sin(this.time * 0.43), 0.42 * Math.sin(this.time * 0.62), 0]);
    } else if (this.form === 'rollcall') {
      this.pose('upperArmL', [-0.4, 0.05, -0.25], k); this.pose('foreArmL', [-1.15, 0.05, 0], k); this.pose('handL', [0, 0, 0.1], k);
      this.rotate('neck', [0.16 * k, 0, 0]); this.rotate('head', [(0.33 + 0.018 * Math.sin(this.time * 1.3)) * k, 0, 0]);
      this.warden.root.updateMatrixWorld(true); this.aim(this.book, this.warden.bones.handL, [0.08, -0.1, 0]);
    }
    this.warden.root.updateMatrixWorld(true);
  }

  private aim(object: THREE.Object3D, hand: THREE.Bone, rotation: E) {
    hand.getWorldQuaternion(this.parentQ).invert(); this.warden.mesh.getWorldQuaternion(this.desiredQ);
    this.desiredQ.multiply(this.q.setFromEuler(this.euler.set(...rotation)));
    object.quaternion.copy(this.parentQ).multiply(this.desiredQ);
  }
  /** Real world ray after the posed hand and model scale have been applied. */
  beamRay(origin: THREE.Vector3, target: THREE.Vector3): void {
    origin.copy(this.origin); this.flashlight.localToWorld(origin);
    target.set(0, 0, BEAM_LENGTH + 0.11); this.flashlight.localToWorld(target);
  }

  dispose(): void {
    if (this.disposed) return;
    this.restore(); this.materials[faceIndex] = this.face; this.materials[lensIndex] = this.lens; this.warden.mesh.scale.copy(this.baseScale);
    this.hat.removeFromParent(); this.flashlight.removeFromParent(); this.book.removeFromParent();
    for (const g of this.geometries) g.dispose();
    for (const m of this.ownedMaterials) m.dispose();
    for (const t of this.textures) t.dispose();
    this.disposed = true;
  }
}

/** One real light for all teacher figures. Kept in the scene at intensity zero between forms to keep light counts stable. */
export class WardenNightLight {
  readonly light = new THREE.SpotLight(0xe2ebcc, 0, NIGHT_LIGHT_DISTANCE, NIGHT_LIGHT_ANGLE, 0.8, NIGHT_LIGHT_DECAY);
  constructor(scene: THREE.Scene) { this.light.name = 'warden-night-light'; this.light.castShadow = false; scene.add(this.light, this.light.target); }
  update(forms?: WardenForms): void {
    this.light.intensity = forms ? NIGHT_LIGHT_INTENSITY : 0;
    if (forms) forms.beamRay(this.light.position, this.light.target.position);
  }
  dispose(): void { this.light.removeFromParent(); this.light.target.removeFromParent(); this.light.dispose(); }
}
