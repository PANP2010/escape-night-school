// The faceless monitor borrows the student's skeleton, never the teacher's action clips or posture layers.
// Its upper body stays at attention; only the legs move while it crosses ground, then every bone stops when seen.
import * as THREE from 'three';
import type { BoneName } from './model.ts';

export interface MonitorRig {
  root: THREE.Object3D;
  mesh: THREE.SkinnedMesh;
  bones: Record<BoneName, THREE.Bone>;
}

/** Model-space metres per full cycle, stance share and ankle lift. Left stance starts at phase 0, right at 0.5. */
export const MONITOR_GAIT = { stride: 2.4, duty: 0.32, lift: 0.18 } as const;

const LEGS = [['thighL', 'shinL', 'footL', 0], ['thighR', 'shinR', 'footR', 0.5]] as const;
const ARMS = [['upperArmL', 'foreArmL', 'handL', 1], ['upperArmR', 'foreArmR', 'handR', -1]] as const;
const TAU = Math.PI * 2;

/** A rigid silhouette with a distance-driven sprint. No mixer, look-at, breathing, smile or finger-curl layer. */
export class MonitorAnimator {
  private readonly rig: MonitorRig;
  private readonly hip: THREE.Vector3;
  private stridePhase = 0;
  private stopped = false;

  constructor(rig: MonitorRig) {
    this.rig = rig;
    this.hip = rig.bones.hips.position.clone();
    this.attention(); // also owns the pose before the first render, including a first snapshot already frozen
  }

  /** Full stride cycles, wrapped to [0, 1). Jumps and freezes never advance it. */
  get phase(): number { return this.stridePhase; }
  get frozen(): boolean { return this.stopped; }

  /** `speed` is the distance the rendered root actually travelled / dt, in world metres per second. */
  update(dt: number, speed: number, anim = 'idle'): void {
    this.stopped = anim === 'freeze';
    if (this.stopped) return; // even the hands and hips retain their exact last transforms
    if (anim !== 'run') { this.attention(); return; }

    // The monitor mesh is scaled .9 × 1.1 × .9. Measure its forward world scale, so taller legs do not lengthen its
    // ground stride and a scaled instance still plants its feet at the same world speed as the rendered root.
    this.rig.mesh.updateWorldMatrix(true, false);
    const e = this.rig.mesh.matrixWorld.elements, scale = Math.hypot(e[8], e[9], e[10]);
    const distance = Number.isFinite(dt) && Number.isFinite(speed) ? Math.max(0, dt) * Math.max(0, speed) : 0;
    this.stridePhase = (this.stridePhase + distance / (Math.max(1e-6, scale) * MONITOR_GAIT.stride)) % 1;

    this.attention();
    const b = this.rig.bones;
    // A lowered pelvis gives the knees room to fold. The torso remains square and the paper face faces straight ahead.
    b.hips.position.y -= 0.14 - 0.015 * Math.cos(2 * TAU * this.stridePhase);
    b.spine.rotation.x = 0.06;
    b.chest.rotation.x = 0.035;
    b.neck.rotation.x = -0.035;
    b.head.rotation.x = -0.06;
    for (const [upper] of ARMS) b[upper].rotation.x = 0.12; // straight arms trail slightly; no pumping or grasping
    for (const [thigh, shin, foot, offset] of LEGS) this.leg(thigh, shin, foot, (this.stridePhase + offset) % 1);
  }

  private attention(): void {
    const b = this.rig.bones;
    for (const bone of Object.values(b)) bone.quaternion.identity();
    b.hips.position.copy(this.hip);
    // Bind-pose hands are at x ±.277; this inward shoulder angle puts the palms at the actual trouser seams (±.20).
    // Keep the elbow, wrist and finger bones straight, including when the borrowed teacher mixer had a curled pose.
    for (const [upper, , , side] of ARMS) b[upper].rotation.z = -side * 0.12;
  }

  private leg(thigh: BoneName, shin: BoneName, foot: BoneName, phase: number): void {
    const b = this.rig.bones, { stride, duty, lift } = MONITOR_GAIT;
    const half = duty * stride / 2;
    let y = this.hip.y + b[thigh].position.y + b[shin].position.y + b[foot].position.y, z: number;
    if (phase < duty) {
      // Flat-foot stance: retreat exactly one model-space ground metre for every metre the body advances.
      z = half - phase * stride;
    } else {
      const u = (phase - duty) / (1 - duty), u2 = u * u, u3 = u2 * u;
      // Hermite return matches the stance velocity at lift-off and touchdown, so the contact never changes speed.
      const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = 1 - h00, h11 = u3 - u2;
      z = -half * h00 + half * h01 - stride * (1 - duty) * (h10 + h11);
      y += lift * Math.sin(Math.PI * u) ** 2;
    }
    const ty = y - b.hips.position.y - b[thigh].position.y;
    const l1 = -b[shin].position.y, l2 = -b[foot].position.y;
    const len2 = Math.min((l1 + l2 - 1e-5) ** 2, Math.max((l1 - l2) ** 2 + 1e-5, ty * ty + z * z));
    const knee = Math.acos(THREE.MathUtils.clamp((len2 - l1 * l1 - l2 * l2) / (2 * l1 * l2), -1, 1));
    const angle = Math.atan2(z, ty) - Math.atan2(-l2 * Math.sin(knee), -(l1 + l2 * Math.cos(knee)));
    const thighAngle = Math.atan2(Math.sin(angle), Math.cos(angle));
    b[thigh].rotation.x = thighAngle;
    b[shin].rotation.x = knee;
    b[foot].rotation.x = -thighAngle - knee; // flat sole in model/world space, despite nonuniform mesh scale
  }
}
