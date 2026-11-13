// Teammate avatar: the 角色074 skeleton and walk/idle clips in a coloured jacket, with hair, no glasses, a crouch pose,
// a soft haze cone + a spot where the beam lands (the real lights, for the two teammates whose pools A sees most, are game.ts' teamLights)
// and a name tag that shows up at close range.
import * as THREE from 'three';
import { Warden, BONES, type BoneName } from './model.ts';
import { makeStudentMaterials } from './textures.ts';
import { TEAM_LAMP_Y, teammateBeamPitch } from '../teamlight.ts';

const SCALE = 0.93; // a bit shorter than him
/** Horizontal distance (m) under which a teammate is not drawn: the camera would sit inside their hood/head and see it as a screen-wide arc. */
export const HIDE_NEAR = 0.7;
export const tooClose = (dx: number, dz: number) => Math.hypot(dx, dz) < HIDE_NEAR;
const LABEL_NEAR = 9, LABEL_FADE = 3; // m: the tag is fully visible inside LABEL_NEAR - LABEL_FADE and gone at LABEL_NEAR
// crouch offsets on top of the clip's pose (x rotation in rad, his +Z = forward)
const CROUCH_ROT: [BoneName, number][] = [['thighL', -1.1], ['thighR', -1.1], ['shinL', 1.2], ['shinR', 1.2], ['spine', 0.45], ['head', -0.2]];
const CROUCH_DY = -0.23, CROUCH_DZ = -0.4;
/** Seconds to go down (kneel, then topple onto the side) and as long to get back up when revived. */
export const DOWN_S = 0.6;
// A slow breath keeps the waiting teammate alive: flex the upper body by about a degree, then anchor it with GROUND.
const DOWN_BREATH_S = 3.2;
type E = [number, number, number];
// downed: two poses over the clip's (Euler XYZ offsets in rad, +x = bend forward / thigh up), blended by `fall`
const KNEEL: [BoneName, E][] = [['thighL', [-0.15, 0, 0]], ['thighR', [-0.15, 0, 0]], ['shinL', [1.55, 0, 0]], ['shinR', [1.55, 0, 0]],
  ['spine', [0.3, 0, 0]], ['head', [0.25, 0, 0]], ['upperArmL', [-0.3, 0, 0]], ['upperArmR', [-0.3, 0, 0]]];
// slumped face down, rolled a little onto the left side: left knee drawn up, right arm reaching out ahead, head turned to the right
const LIE: [BoneName, E][] = [['hips', [1.45, 0, 0.3]], ['thighL', [-0.2, 0, 0.9]], ['shinL', [0.5, 0, 0]], ['thighR', [0.05, 0, -0.05]], ['shinR', [0.2, 0, 0]],
  ['spine', [-0.1, 0, 0]], ['neck', [-0.25, 0, 0]], ['head', [-0.2, -1.1, 0]],
  ['upperArmR', [-2.5, 0, -0.35]], ['foreArmR', [-0.4, 0, 0]], ['upperArmL', [-0.2, 0, 1.2]], ['foreArmL', [-0.6, 0, 0.8]]];
// body points that end up on the floor and how far (model m) the surface sits past each bone origin: the downed pose is set onto the ground by these
// The drawn-up left knee blends thigh and shin skin, extending farther below its joint than the lower leg's radius.
const GROUND: [BoneName, number][] = [['footL', 0.09], ['footR', 0.09], ['shinL', 0.085], ['shinR', 0.06], ['thighL', 0.1], ['thighR', 0.1], ['hips', 0.12],
  ['spine', 0.13], ['chest', 0.14], ['head', 0.1], ['glasses', 0.04], ['upperArmL', 0.06], ['upperArmR', 0.06], ['foreArmL', 0.05], ['foreArmR', 0.05], ['handL', 0.04], ['handR', 0.04], ['fingers2L', 0.06], ['fingers2R', 0.06]];
const ss = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _ax = new THREE.Vector3(1, 0, 0), _m = new THREE.Matrix4(), _g = new THREE.Vector3();

let hairMat: THREE.Material | undefined;
let coneGeo: THREE.BufferGeometry | undefined;
let coneMat: THREE.Material | undefined;
let spotGeo: THREE.BufferGeometry | undefined;

/** Beam reach (m): the cone is cut at what it hits within this, the spot shows up only there. */
export const BEAM_LEN = 9;
/** Half-angle (rad) of the visible beam core and its spot; the real light adds wider, soft spill. */
export const BEAM_HALF = 0.28;
const BEAM_FADE = 8; // m: the haze is gone this far along the beam

/**
 * Haze cone from the hand along -Z (the avatar's facing), apex at the origin, scaled uniformly to the hit distance.
 * Additive, no depth write, closed and convex: each ray is shaded once, on the face where it enters (or on the back face
 * when the eye is inside), so a far end sunk in the floor still shows; each pixel adds the haze along the view ray's chord through the cone (4 samples), so the beam is thick seen side-on and long and
 * bright seen along its length, from behind the holder as well; in at the lens and out along it in world metres
 * (the scale is read back from modelMatrix), brightest on the axis, nothing at the rim (soft edges).
 */
function lightCone() {
  if (!coneGeo) {
    const g = new THREE.ConeGeometry(BEAM_LEN * Math.tan(BEAM_HALF), BEAM_LEN, 24, 1, false);
    g.rotateX(-Math.PI / 2); // apex was +Y → now +Z; flip so the apex sits at the origin and the opening is at -Z
    g.rotateY(Math.PI);
    g.translate(0, 0, -BEAM_LEN / 2); // apex at the origin
    coneGeo = g;
    const tan = Math.tan(BEAM_HALF).toFixed(5), cos2 = (Math.cos(BEAM_HALF) ** 2).toFixed(5);
    coneMat = new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color(0.09, 0.08, 0.06) } },
      vertexShader: `varying vec3 vW, vP, vA; varying float vL;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vW = w.xyz;
          vP = modelMatrix[3].xyz;
          vA = -normalize(modelMatrix[2].xyz);
          vL = ${BEAM_LEN.toFixed(1)} * length(modelMatrix[0].xyz);
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: `uniform vec3 color; varying vec3 vW, vP, vA; varying float vL;
        void main() {
          vec3 v = vW - cameraPosition;
          float tf = length(v);
          v /= tf;
          // the stretch of the view ray inside the cone (w.a)² ≥ cos²θ |w|², 0 ≤ w.a ≤ L: from a front face to the analytic exit,
          // or from the eye to a back face when the eye is inside. (Back faces alone go missing where the far end dips into the floor.)
          vec3 co = cameraPosition - vP;
          float dv = dot(v, vA), ca = dot(co, vA);
          bool inside = ca >= 0.0 && ca <= vL && ca * ca >= ${cos2} * dot(co, co);
          float t0 = 0.0, t1 = tf;
          if (gl_FrontFacing) {
            if (inside) discard;
            t0 = tf;
            t1 = abs(dv) > 1e-4 ? max(-ca / dv, (vL - ca) / dv) : 1e4;
            float qa = dv * dv - ${cos2}, qb = dv * ca - ${cos2} * dot(v, co), qc = ca * ca - ${cos2} * dot(co, co);
            float disc = qb * qb - qa * qc;
            if (disc > 0.0 && abs(qa) > 1e-5) {
              float r1 = (-qb - sqrt(disc)) / qa, r2 = (-qb + sqrt(disc)) / qa;
              if (r1 > r2) { float x = r1; r1 = r2; r2 = x; }
              // qa < 0: inside between the roots; qa > 0: inside outside them, so entering before r1 leaves at r1
              if (qa < 0.0) t1 = min(t1, r2); else if (t0 < r1) t1 = min(t1, r1);
            }
          } else if (!inside) discard;
          float dt = max(0.0, t1 - t0) / 4.0, sum = 0.0;
          for (int i = 0; i < 4; i++) {
            vec3 w = co + v * (t0 + (float(i) + 0.5) * dt);
            float h = dot(w, vA), rr = dot(w, w) - h * h, R = h * ${tan};
            float prof = max(0.0, 1.0 - rr / (R * R + 1e-4));
            sum += prof * prof * smoothstep(0.0, 0.25, h) * pow(max(0.0, 1.0 - h / ${BEAM_FADE.toFixed(1)}), 1.6);
          }
          // a little brighter facing the lens than from behind it (forward scatter), saturating along the length
          float phase = 0.8 + 0.4 * max(0.0, -dv);
          gl_FragColor = vec4(color * phase * (1.0 - exp(-sum * dt * 1.2)), 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      // A single DoubleSide pass preserves gl_FrontFacing for the analytic entry/exit test. Three's default two-pass
      // transparent rendering flips the back-face winding, which otherwise also makes beams disappear from inside.
      transparent: true, blending: THREE.AdditiveBlending, depthTest: true, depthWrite: false,
      side: THREE.DoubleSide, forceSinglePass: true, fog: false,
    });
  }
  const m = new THREE.Mesh(coneGeo, coneMat);
  m.frustumCulled = false;
  return m;
}

/** Where the beam lands: an additive radial gradient on a unit quad (normal +Z), its own material for the brightness. */
function lightSpot() {
  spotGeo ??= new THREE.PlaneGeometry(2, 2);
  const m = new THREE.Mesh(spotGeo, new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color() } },
    vertexShader: 'varying vec2 vP; void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 color; varying vec2 vP;
      void main() {
        float r = 1.0 - dot(vP, vP);
        gl_FragColor = vec4(color * r * r * step(0.0, r), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  }));
  m.visible = false;
  return m;
}

/** A faint landing cue; real lights provide surface detail. Keep additive spots dim when two beams overlap. */
export const spotGain = (t: number, cosI: number) => 0.045 / (1 + 0.12 * t * t) * (0.45 + 0.55 * cosI);

function labelSprite(text: string) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d')!;
  g.font = 'bold 34px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,0.85)'; g.strokeText(text, 128, 34);
  g.fillStyle = '#fff'; g.fillText(text, 128, 34);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false }));
  s.scale.set(1, 0.25, 1);
  return s;
}

const _n = new THREE.Vector3(), _x = new THREE.Vector3(), _y = new THREE.Vector3(), _p = new THREE.Vector3(), _s = new THREE.Vector3();

const readableMaterials = new WeakSet<THREE.Material>();
const STUDENT_COLOUR_FLOOR = 0.045;
/** A low colour floor and soft edge preserve the existing materials and draw calls in a blackout. */
function readableStudentMaterial(material: THREE.Material) {
  if (!(material instanceof THREE.MeshStandardMaterial) || !material.visible || readableMaterials.has(material)) return;
  readableMaterials.add(material);
  material.emissive.copy(material.color);
  material.emissiveMap = material.map;
  material.emissiveIntensity = STUDENT_COLOUR_FLOOR;
  // View-space normals include skinning. Tint the edge with the surface so dark cloth/hair never gets a bright outline.
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      float studentRim = 1.0 - max(0.0, dot(normal, normalize(vViewPosition)));
      vec3 studentEdge = mix(diffuseColor.rgb, vec3(0.06, 0.07, 0.08), 0.2);
      totalEmissiveRadiance += studentEdge * (0.025 * studentRim * studentRim * studentRim);
    `);
  };
  material.customProgramCacheKey = () => 'student-readable-v2';
  material.needsUpdate = true;
}

function readableStudentMaterials(color: number) {
  const materials = makeStudentMaterials(color);
  materials.forEach(readableStudentMaterial);
  return materials;
}

export class Student {
  /** Place this in the scene; origin at the feet, faces -Z at rotation.y = 0. */
  readonly root = new THREE.Group();
  readonly warden: Warden;
  private readonly faceMaterial: THREE.MeshStandardMaterial;
  private readonly cone = lightCone();
  /** The beam's spot on whatever it hits: not under `root` (put it in the scene) so culling the body keeps it. */
  readonly spot = lightSpot();
  private readonly beamO = new THREE.Vector3();
  private readonly beamD = new THREE.Vector3();
  private lit = false;
  private readonly lamp: THREE.Mesh;
  private label?: THREE.Sprite;
  private crouch = 0;
  /** 0 standing … 1 lying downed (linear in time over DOWN_S). */
  private fall = 0;
  private downTime = 0;
  private readonly saved = new Map<BoneName, THREE.Quaternion>();
  private readonly savedHips = new THREE.Vector3();
  /** The idle clip's pose at t = 0: going down blends every bone to it first, so the downed pose is the same whatever the clip was doing (glasses push, walk). */
  private readonly base = new Map<BoneName, THREE.Quaternion>();
  private readonly baseHips = new THREE.Vector3();

  constructor(color: number) {
    const materials = readableStudentMaterials(color);
    this.faceMaterial = materials[0] as THREE.MeshStandardMaterial;
    this.warden = new Warden(materials, false);
    this.warden.root.scale.setScalar(SCALE);
    // hair: a cap tilted back so the forehead shows, parented to the head bone (plain mesh, not skinned)
    hairMat ??= new THREE.MeshStandardMaterial({ color: 0x24201d, roughness: 0.8 });
    readableStudentMaterial(hairMat);
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.133, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.6), hairMat);
    hair.position.set(0, 0.098, -0.012);
    hair.rotation.x = -0.45;
    this.warden.bones.head.add(hair);
    // the flashlight: a small lit lens + cone in front of the right hand
    this.lamp = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), new THREE.MeshBasicMaterial({ color: 0xfff2c0 }));
    this.cone.position.set(0.22, TEAM_LAMP_Y, -0.35);
    this.lamp.position.copy(this.cone.position);
    this.cone.visible = this.lamp.visible = false;
    this.root.add(this.warden.root, this.cone, this.lamp);
    this.warden.update(0, 0, 'idle');
    this.faceMaterial.emissiveIntensity = STUDENT_COLOUR_FLOOR;
    for (const n of BONES) { this.saved.set(n, this.warden.bones[n].quaternion.clone()); this.base.set(n, this.warden.bones[n].quaternion.clone()); }
    this.savedHips.copy(this.warden.bones.hips.position); this.baseHips.copy(this.savedHips);
  }

  setName(name: string) {
    if (this.label) { this.root.remove(this.label); (this.label.material as THREE.SpriteMaterial).map?.dispose(); this.label.material.dispose(); }
    this.label = labelSprite(name);
    this.root.add(this.label);
  }
  get named() { return !!this.label; }

  /** Free this instance's GPU resources (materials are cached per colour, the cone and hair material are shared). */
  dispose() {
    this.warden.mesh.geometry.dispose();
    this.warden.mesh.skeleton.dispose();
    this.root.traverse((o) => { if (o instanceof THREE.Mesh && o !== this.warden.mesh && o !== this.cone) o.geometry.dispose(); });
    (this.lamp.material as THREE.Material).dispose();
    this.spot.removeFromParent();
    (this.spot.material as THREE.Material).dispose();
    if (this.label) { (this.label.material as THREE.SpriteMaterial).map?.dispose(); this.label.material.dispose(); }
  }
  /** Beam pitch (rad) as last applied; for tests. */
  get coneRotationX() { return this.cone.rotation.x; }
  /** 0 standing … 1 lying downed; for tests. */
  get fallen() { return this.fall; }

  /** Hand position and unit direction of the beam in world space, as of the last update (root placed). */
  beam(o: THREE.Vector3, d: THREE.Vector3) {
    this.cone.updateWorldMatrix(true, false);
    o.setFromMatrixPosition(this.cone.matrixWorld);
    d.set(0, 0, -1).transformDirection(this.cone.matrixWorld);
    this.beamO.copy(o); this.beamD.copy(d);
  }
  /** Cut the cone where the beam (see beam()) hits: `t` m along it, surface normal n; null = nothing within BEAM_LEN. */
  land(hit: { t: number; nx: number; ny: number; nz: number } | null) {
    this.spot.visible = this.lit && !!hit;
    this.cone.scale.setScalar(Math.max(0.05, (hit?.t ?? BEAM_LEN) / BEAM_LEN));
    if (!hit || !this.lit) return;
    const d = this.beamD, z = _n.set(hit.nx, hit.ny, hit.nz), cosI = Math.abs(d.dot(z));
    // x: the beam projected on the surface (the spot stretches along it), y completes the frame
    _x.copy(d).addScaledVector(z, -d.dot(z));
    if (_x.lengthSq() < 1e-6) _x.set(z.y, z.z, z.x);
    _x.normalize();
    _y.crossVectors(z, _x);
    const r = 0.06 + hit.t * Math.tan(BEAM_HALF) * 1.15;
    this.spot.matrix.makeBasis(_x, _y, z).scale(_s.set(r / Math.max(0.35, cosI), r, 1))
      .setPosition(_p.copy(this.beamO).addScaledVector(d, hit.t).addScaledVector(z, 0.01));
    this.spot.matrixAutoUpdate = false;
    this.spot.matrixWorldNeedsUpdate = true;
    (this.spot.material as THREE.ShaderMaterial).uniforms.color.value.setRGB(1, 0.9, 0.68).multiplyScalar(spotGain(hit.t, cosI));
  }

  /** `speed` ground speed (m/s), `dist` to the camera (m) for the name tag, `down` = downed (falls over / gets up in DOWN_S). */
  update(dt: number, speed: number, crouch: boolean, light: boolean, pitch: number, dist: number, down = false) {
    // The render loop normally caps remote dt at 1 s; keep a resumed tab (or a paused/invalid clock) bounded here too.
    dt = Number.isFinite(dt) ? Math.min(1, Math.max(0, dt)) : 0;
    const b = this.warden.bones;
    // the mixer skips bones whose blended value did not change: undo last frame's offsets first
    for (const [n, q] of this.saved) b[n].quaternion.copy(q);
    b.hips.position.copy(this.savedHips);
    this.warden.update(dt, down ? 0 : speed, 'run');
    // Warden animates its glowing eyes each frame; a student's face uses the whole colour map instead.
    this.faceMaterial.emissiveIntensity = STUDENT_COLOUR_FLOOR;
    for (const [n, q] of this.saved) q.copy(b[n].quaternion);
    this.savedHips.copy(b.hips.position);
    this.crouch += ((crouch ? 1 : 0) - this.crouch) * (1 - Math.exp(-dt * 8));
    const c = this.crouch;
    if (c > 0.005) {
      for (const [n, a] of CROUCH_ROT) b[n].quaternion.premultiply(_q.setFromAxisAngle(_ax, a * c));
      b.hips.position.y += CROUCH_DY * c; b.hips.position.z += CROUCH_DZ * c;
    }
    this.fall = Math.min(1, Math.max(0, this.fall + (down ? dt : -dt) / DOWN_S));
    // kneel over the first half, topple onto the side over the second (getting up runs it backwards)
    const kn = ss(0, 0.5, this.fall), lie = ss(0.4, 1, this.fall), k = kn * (1 - lie);
    if (this.fall > 0) {
      for (const [n, q] of this.base) b[n].quaternion.slerp(q, kn);
      b.hips.position.lerp(this.baseHips, kn);
      for (const [n, r] of KNEEL) b[n].quaternion.premultiply(_q.setFromEuler(_e.set(r[0] * k, r[1] * k, r[2] * k)));
      for (const [n, r] of LIE) b[n].quaternion.premultiply(_q.setFromEuler(_e.set(r[0] * lie, r[1] * lie, r[2] * lie)));
      // Rebuilt from the lying pose on every frame: repeated down snapshots neither restart the breath nor accumulate it.
      // The same lie weight fades it in during the fall and out during revival, leaving the standing mixer untouched.
      this.downTime = (this.downTime + dt) % DOWN_BREATH_S;
      const breath = Math.sin(this.downTime * Math.PI * 2 / DOWN_BREATH_S) * lie;
      b.spine.quaternion.premultiply(_q.setFromAxisAngle(_ax, -0.012 * breath));
      b.chest.quaternion.premultiply(_q.setFromAxisAngle(_ax, 0.024 * breath));
      b.head.quaternion.premultiply(_q.setFromAxisAngle(_ax, -0.008 * breath));
      // drop (or lift) the hips so the lowest body point rests on the floor: kneeling on the knees, then lying flat, never through it
      b.hips.updateMatrixWorld(true);
      _m.copy(this.warden.mesh.matrixWorld).invert();
      let low = Infinity;
      for (const [n, pad] of GROUND) low = Math.min(low, _g.setFromMatrixPosition(b[n].matrixWorld).applyMatrix4(_m).y - pad);
      b.hips.position.y -= low * Math.min(1, this.fall * 8);
    }
    this.cone.visible = this.lamp.visible = this.lit = light;
    if (!light) this.spot.visible = false;
    // the torch drops with them and ends up on the floor beside them, pointing level
    this.cone.position.y = this.lamp.position.y = TEAM_LAMP_Y - 0.25 * c - 0.6 * kn - 0.43 * lie;
    this.cone.position.z = this.lamp.position.z = -0.35 - 0.9 * lie;
    this.cone.rotation.x = teammateBeamPitch(pitch) * (1 - kn); // +pitch = up; beam/landing spot/real light share this axis
    if (this.label) {
      const m = this.label.material as THREE.SpriteMaterial;
      m.opacity = Math.min(1, Math.max(0, (LABEL_NEAR - dist) / LABEL_FADE));
      this.label.visible = m.opacity > 0.01;
      this.label.position.y = 1.95 * SCALE - 0.3 * c - 0.55 * kn - 0.55 * lie;
    }
  }
}
