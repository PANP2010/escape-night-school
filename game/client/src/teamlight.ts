// Which teammates get the real 手电 SpotLights (game.ts teamLights); the rest only show the haze cone + landing spot.
// Pick by how much of the screen the beam's pool covers, not by body distance: a teammate at A's elbow whose beam
// points behind A lights nothing A can see, while one 5 m ahead lighting the corridor floor is what the light is for.
import * as THREE from 'three';

/** Pool radius / distance² weights: pool in view and unoccluded, pool behind a wall, only the beam's shaft in view, nothing in view. */
export const VIS_POOL = 1, VIS_OCCLUDED = 0.15, VIS_SHAFT = 0.3, VIS_NONE = 0.02;
/** A challenger must beat the current holder's score by this factor (no flicker between two similar beams). */
export const SWITCH_RATIO = 1.5;
/** Seconds to fade the light out of the old holder / into the new one on a switch. */
export const FADE_OUT_S = 0.15, FADE_IN_S = 0.2;

/**
 * The player's own 手电 (game.ts flashlight, decay 2): candela, cone, rim softness, and how far behind the eye the source
 * sits. 4 cd / 0.55 rad at the eye barely showed (审查 #205: L1 spawn corridor only 1.29× frame / 1.77× centre over the
 * light off); 10 cd with a wider, softer cone lights the walls and doors to the 铁栅门 (2.4× / 3.1×, shot-torch-own.mjs),
 * and pulling the source 0.3 m back flattens the near falloff so a wall at arm's length stays below white (max 229 /255).
 */
export const FLASH_LIGHT = 10, FLASH_ANGLE = 0.7, FLASH_PENUMBRA = 0.8, FLASH_BACK = 0.3;
/** Its offset from the camera (right, down, back): kept inside 1 m so interior_light.ts still counts it as the eye's torch. */
export const FLASH_POS = [0.15, -0.15, FLASH_BACK] as const;

/** Two existing slots: a 0.26-rad core matches the visible beam; broad soft spill lights corridor walls and doors. */
export const TEAM_LIGHT = 29, TEAM_ANGLE = 1.3, TEAM_PENUMBRA = 0.8, TEAM_REACH = 20;
/** Standing hand-held torch height, m. Crouching/downed offsets live with the avatar pose. */
export const TEAM_LAMP_Y = 1.15;

export interface TeamBeam { o: THREE.Vector3; d: THREE.Vector3; t: number }
const TEAM_NEAR_M = 3.5;
/** Halfway through the soft angular falloff: the useful spill, beyond the small visible haze core. */
const TEAM_SPILL_TAN = Math.tan(TEAM_ANGLE * (1 - TEAM_PENUMBRA / 2));

/**
 * Limit near-surface glare without weakening a pool farther down the corridor. Squared smoothstep removes the
 * inverse-square hotspot at the hand and joins full strength without a brightness jump at TEAM_NEAR_M.
 * Overlapping selected beams share some headroom; an absent or fully faded second light contributes no overlap.
 */
export function teammateLightGain(t: number, overlap = 0): number {
  const u = Math.max(0, Math.min(1, t / TEAM_NEAR_M)), near = u * u * (3 - 2 * u);
  return near * near / (1 + 0.5 * Math.max(0, Math.min(1, overlap)));
}

/** Continuous overlap estimate from the actual landing points and useful soft-spill radii; no frame allocations. */
export function teammatePoolOverlap(a: TeamBeam, b: TeamBeam): number {
  const dx = a.o.x + a.d.x * a.t - b.o.x - b.d.x * b.t;
  const dy = a.o.y + a.d.y * a.t - b.o.y - b.d.y * b.t;
  const dz = a.o.z + a.d.z * a.t - b.o.z - b.d.z * b.t;
  const radius = Math.max(0.1, (a.t + b.t) * TEAM_SPILL_TAN);
  const u = Math.min(1, Math.hypot(dx, dy, dz) / radius);
  return 1 - u * u * (3 - 2 * u);
}

/**
 * A teammate holds the torch forward rather than tying it rigidly to their eye. Ease ordinary downward glances so
 * pitch -0.4 lands around 4.7 m ahead (including the hand offset), instead of the old waist torch's 2.6 m.
 * Beyond that ordinary glance, smoothly give the full pitch back: looking at the feet or ceiling still works.
 */
export function teammateBeamPitch(pitch: number): number {
  const p = Math.max(-1.2, Math.min(1.2, pitch));
  const t = Math.min(1, Math.max(0, (Math.abs(p) - 0.4) / 0.8));
  return p * (0.65 + 0.35 * t * t * (3 - 2 * t));
}

const _sph = new THREE.Sphere(), _hit = new THREE.Vector3(), _mid = new THREE.Vector3();

/**
 * Screen-share estimate of a beam pool: (pool radius / its distance from the eye)², times how visible it is.
 * `o`,`d` beam origin and unit direction, `t` m to where it lands, `r` pool radius; `occluded(hit, dist)` says
 * whether the line from the eye to the pool is blocked.
 */
export function beamScore(fr: THREE.Frustum, eye: THREE.Vector3, o: THREE.Vector3, d: THREE.Vector3, t: number, r: number,
  occluded: (hit: THREE.Vector3, dist: number) => boolean): number {
  _hit.copy(o).addScaledVector(d, t);
  const dist = _hit.distanceTo(eye);
  let vis = VIS_NONE;
  if (fr.intersectsSphere(_sph.set(_hit, r + 0.3))) vis = occluded(_hit, dist) ? VIS_OCCLUDED : VIS_POOL;
  else if (fr.intersectsSphere(_sph.set(_mid.copy(o).addScaledVector(d, t / 2), t / 2))) vis = VIS_SHAFT;
  return vis * (r / Math.max(1, dist)) ** 2;
}

/** One real light: whose beam it sits on (`holder`), whom it is fading over to (`want`), its strength 0..1 (`level`). */
export interface TeamLightSlot<K> { holder: K | undefined; want: K | undefined; level: number }

/**
 * Hysteresis + cross-fade over the per-frame scores for `n` real lights: each sits on a different lit teammate, the n
 * best beams get them, and a challenger takes only the weakest held one, by beating its score by SWITCH_RATIO.
 * `holder` / `level` are slot 0's (the n = 1 case).
 */
export class TeamLightPick<K> {
  readonly slots: TeamLightSlot<K>[];
  constructor(n = 1) { this.slots = Array.from({ length: n }, () => ({ holder: undefined, want: undefined, level: 0 })); }
  get holder() { return this.slots[0].holder; }
  get level() { return this.slots[0].level; }

  /** `scores`: lit teammates only. Returns slot 0's holder this frame (undefined = that light off). */
  update(dt: number, scores: ReadonlyMap<K, number>): K | undefined {
    const taken = (k: K) => this.slots.some((s) => s.holder === k || s.want === k);
    const best = () => {
      let b: K | undefined, bs = -1;
      for (const [k, v] of scores) if (v > bs && !taken(k)) { b = k; bs = v; }
      return b;
    };
    for (const s of this.slots) {
      if (s.holder !== undefined && scores.has(s.holder)) continue;
      // holder's torch went off (or none yet): its light goes with it; a fresh pick with nothing lit before comes on at once
      const was = s.holder !== undefined;
      s.holder = s.want = undefined;
      s.holder = s.want = best();
      s.level = s.holder === undefined ? 0 : was ? 0 : 1;
    }
    for (const s of this.slots) if (s.want !== s.holder && s.want !== undefined && !scores.has(s.want)) s.want = s.holder;
    // the weakest settled slot is the one a challenger may take
    let weak: TeamLightSlot<K> | undefined;
    for (const s of this.slots) if (s.holder !== undefined && s.want === s.holder && (!weak || scores.get(s.holder)! < scores.get(weak.holder!)!)) weak = s;
    const c = best();
    if (weak && c !== undefined && scores.get(c)! > scores.get(weak.holder!)! * SWITCH_RATIO) weak.want = c;
    for (const s of this.slots) {
      if (s.want !== s.holder) {
        s.level -= dt / FADE_OUT_S;
        if (s.level <= 0) { s.level = 0; s.holder = s.want; }
      } else if (s.holder !== undefined) s.level = Math.min(1, s.level + dt / FADE_IN_S);
    }
    return this.slots[0].holder;
  }
}
