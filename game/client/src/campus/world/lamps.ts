import * as THREE from 'three';
import { CAMPUS } from './campus.ts';
import { streetLamps } from './paving.ts';

export const LAMP_HEIGHT = 4.2;
/**
 * The lamp light cone: a 灯罩 pressing the light onto the ground and the wall feet. Half-angle 70°: from a 4 m head the
 * ground is fully lit to ~4 m and fades out by ~11 m, well past the pool (r 5.5 m); with penumbra 0.35 a wall 3 m off is lit
 * only below ~2.9 m, fully below ~1.1 m, and nothing above the head.
 */
const LAMP_ANGLE = THREE.MathUtils.degToRad(70), LAMP_PENUMBRA = 0.35;
/** Real spot lights pointing straight down, re-assigned to the lamps nearest the camera; constant count = no shader recompiles. */
export const LAMP_LIGHTS = 4;
const POOL_RADIUS = 4;
/** 高杆路灯's pool, as a multiple of POOL_RADIUS: the far lanes, the 斑马线 and the 门口 sidewalk */
const STREET_POOL = 2;
const LAMP_COLOR = new THREE.Color(0xffc987);

/** 门头壁灯: how far the head stands off the wall on its bracket, and the head's size against a pole lamp's */
export const WALL_LAMP_ARM = 0.35;
const WALL_HEAD = 0.6, WALL_POOL = 0.8;
/** a 门头壁灯's light (pool centre, spot target) is thrown this far out from the wall: the 灯罩 faces away from it */
const WALL_THROW = 1.2;
const SIDE: Record<string, [number, number]> = { '+x': [1, 0], '-x': [-1, 0], '+z': [0, 1], '-z': [0, -1] };

/** Lamp head positions (x, z): data/campus/campus.json `lamps`, then the 门外 高杆路灯 (`street.lamps`), then the 门头壁灯 (`wallLamps`). */
export function lampPositions(): [number, number][] {
  return [...CAMPUS.lamps.map(([x, z]) => [x, z] as [number, number]), ...streetHeads().map(l => [l.x, l.headZ] as [number, number]),
    ...wallHeads().map(l => [l.x, l.z] as [number, number])];
}
const streetHeads = () => CAMPUS.street ? streetLamps(CAMPUS.wall, CAMPUS.street) : [];
/** 门头壁灯 heads: (x, z) out along the wall's facing by the bracket, head top at y; n = facing (0, 0 under a canopy). */
export function wallHeads(): { x: number; z: number; y: number; nx: number; nz: number }[] {
  return (CAMPUS.wallLamps ?? []).map(([x, z, y, side]) => {
    const [nx, nz] = side ? SIDE[side] : [0, 0];
    return { x: x + nx * WALL_LAMP_ARM, z: z + nz * WALL_LAMP_ARM, y, nx, nz };
  });
}
/** Head height of each lamp in lampPositions() order (campus LAMP_HEIGHT, street ones their pole height, wall ones their own). */
export function lampHeights(): number[] {
  return [...CAMPUS.lamps.map(() => LAMP_HEIGHT), ...streetHeads().map(l => l.h), ...wallHeads().map(l => l.y)];
}

/** Indices of the `n` lamps nearest (x, z), nearest first. Pure, for the light pool and tests. */
export function nearestLamps(lamps: [number, number][], x: number, z: number, n = LAMP_LIGHTS): number[] {
  return lamps.map((p, i) => [i, (p[0] - x) ** 2 + (p[1] - z) ** 2] as const)
    .sort((a, b) => a[1] - b[1]).slice(0, n).map(([i]) => i);
}

/**
 * Street lamps: instanced poles + heads (2 draw calls), instanced additive light pools on the ground (1 draw
 * call, no depth write so the ink pass never outlines them), and LAMP_LIGHTS downward spot lights that follow the
 * camera's nearest lamps so walls and the player's surroundings pick up the warm light. set(on) is driven by
 * systems/timeofday.ts; at 0 everything is hidden or zero-intensity (no cost in daytime beyond the poles).
 * The 门外 高杆路灯 share the instances: a stretched, thicker pole, the head turned along its arm (one more
 * instanced mesh), a wider pool, and a spot light pushed brighter / further for its height when it is near.
 */
export class StreetLamps {
  readonly group = new THREE.Group();
  readonly positions = lampPositions();
  readonly heights = lampHeights();
  readonly lights: THREE.SpotLight[] = [];
  on = 0;
  /** per spot light: intensity multiplier for the height of the lamp it sits on (follow) */
  /** per lamp: spot target offset from under the head (门头壁灯 throw it off the wall), and whether it is a wall lamp */
  private aim: [number, number][] = this.positions.map(() => [0, 0]);
  private wall: boolean[] = this.positions.map(() => false);
  private gain = Array.from({ length: LAMP_LIGHTS }, () => 1);
  private headMat = new THREE.MeshBasicMaterial({ color: 0x8a8272 });
  private poolMat: THREE.ShaderMaterial;
  private pools: THREE.InstancedMesh;

  constructor() {
    const n = this.positions.length;
    const pole = new THREE.CylinderGeometry(0.07, 0.09, LAMP_HEIGHT, 5);
    pole.translate(0, LAMP_HEIGHT / 2, 0);
    const head = new THREE.BoxGeometry(0.55, 0.16, 0.3);
    head.translate(0, LAMP_HEIGHT + 0.05, 0);
    const poleMat = new THREE.MeshLambertMaterial({ color: 0x5d5a55 });
    const poles = new THREE.InstancedMesh(pole, poleMat, n);
    const heads = new THREE.InstancedMesh(head, this.headMat, n);
    poles.name = 'LAMP_POLES'; heads.name = 'LAMP_HEADS';
    const disc = new THREE.CircleGeometry(POOL_RADIUS, 20);
    disc.rotateX(-Math.PI / 2);
    disc.translate(0, 0.03, 0);
    this.poolMat = new THREE.ShaderMaterial({
      uniforms: { color: { value: LAMP_COLOR.clone() }, on: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec2 vP;
        void main(){ vP = position.xz / ${POOL_RADIUS.toFixed(1)}; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform vec3 color; uniform float on; varying vec2 vP;
        void main(){ float r = length(vP); float a = (1.0 - smoothstep(0.0, 1.0, r)); gl_FragColor = vec4(color * a * a * 0.22 * on, 1.0); }`,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    this.pools = new THREE.InstancedMesh(disc, this.poolMat, n);
    this.pools.name = 'LAMP_POOLS';
    const mtx = new THREE.Matrix4(), m = new THREE.Matrix4(), base = CAMPUS.lamps.length;
    this.positions.slice(0, base).forEach(([x, z], i) => {
      mtx.makeTranslation(x, 0, z);
      poles.setMatrixAt(i, mtx); heads.setMatrixAt(i, mtx); this.pools.setMatrixAt(i, mtx);
    });
    this.group.add(poles, heads, this.pools);
    const street = streetHeads(), wall = wallHeads(), wallBase = base + street.length;
    // 门头壁灯: no pole (scaled to nothing), a smaller head with its top at y, a short bracket back to the wall
    wall.forEach((l, j) => {
      const i = wallBase + j;
      poles.setMatrixAt(i, mtx.makeScale(0, 0, 0));
      heads.setMatrixAt(i, mtx.makeTranslation(l.x, l.y - 0.13 * WALL_HEAD, l.z).multiply(m.makeRotationY(l.nx ? Math.PI / 2 : 0))
        .multiply(m.makeScale(WALL_HEAD, WALL_HEAD, WALL_HEAD)).multiply(m.makeTranslation(0, -(LAMP_HEIGHT + 0.05), 0)));
      this.pools.setMatrixAt(i, mtx.makeTranslation(l.x + l.nx * WALL_THROW, 0, l.z + l.nz * WALL_THROW).multiply(m.makeScale(WALL_POOL, 1, WALL_POOL)));
      this.aim[i] = [l.nx * WALL_THROW, l.nz * WALL_THROW]; this.wall[i] = true;
    });
    const brackets = wall.filter(l => l.nx || l.nz);
    if (street.length || brackets.length) {
      const arm = new THREE.BoxGeometry(0.09, 0.09, 1);
      arm.translate(0, 0, 0.5);
      const arms = new THREE.InstancedMesh(arm, poleMat, street.length + brackets.length);
      arms.name = 'LAMP_ARMS';
      street.forEach((l, j) => {
        const i = base + j, k = l.h / LAMP_HEIGHT;
        poles.setMatrixAt(i, mtx.makeTranslation(l.x, 0, l.z).multiply(m.makeScale(1.6, k, 1.6)));
        // head: turned to lie along the arm, a little bigger, its top at the arm's end
        heads.setMatrixAt(i, mtx.makeTranslation(l.x, l.h - 0.12, l.headZ).multiply(m.makeRotationY(Math.PI / 2))
          .multiply(m.makeScale(1.3, 1.2, 1.3)).multiply(m.makeTranslation(0, -(LAMP_HEIGHT + 0.05), 0)));
        arms.setMatrixAt(i - base, mtx.makeTranslation(l.x, l.h - 0.05, l.z).multiply(m.makeScale(1, 1, l.headZ - l.z)));
        this.pools.setMatrixAt(i, mtx.makeTranslation(l.x, 0, l.headZ).multiply(m.makeScale(STREET_POOL, 1, STREET_POOL)));
      });
      // the bracket: from the wall face out to the head, just under its top, along the wall's facing
      brackets.forEach((l, j) => arms.setMatrixAt(street.length + j, mtx.makeTranslation(l.x, l.y - 0.05, l.z)
        .multiply(m.makeRotationY(Math.atan2(-l.nx, -l.nz))).multiply(m.makeScale(0.6, 0.6, WALL_LAMP_ARM))));
      this.group.add(arms);
    }
    this.pools.visible = false;
    for (let i = 0; i < LAMP_LIGHTS; i++) {
      const l = new THREE.SpotLight(LAMP_COLOR, 0, 14, LAMP_ANGLE, LAMP_PENUMBRA, 1.6);
      l.position.set(0, -100, 0);
      l.target.position.set(0, -101, 0);
      this.lights.push(l);
      this.group.add(l, l.target);
    }
  }

  /** 0 = off (day), 1 = full night. */
  set(on: number): void {
    this.on = on;
    this.poolMat.uniforms.on.value = on;
    this.pools.visible = on > 0.001;
    // unlit grey head by day, glowing (over-bright, so the palette picks its lightest warm colour) by night
    this.headMat.color.set(0x8a8272).lerp(new THREE.Color(0xffe2a8).multiplyScalar(2.2), on);
    this.lights.forEach((l, i) => { l.intensity = on * 5 * this.gain[i]; });
  }

  /** Move the spot lights onto the lamps nearest the viewer (cheap: ~20 lamps). */
  follow(x: number, z: number): void {
    if (this.on <= 0.001) return;
    nearestLamps(this.positions, x, z, this.lights.length).forEach((idx, i) => {
      const [lx, lz] = this.positions[idx], k = this.heights[idx] / LAMP_HEIGHT, l = this.lights[i];
      // a higher head: as bright at its foot as a campus lamp is at its own, reaching proportionally further
      l.position.set(lx, this.heights[idx] - 0.2, lz);
      l.target.position.set(lx + this.aim[idx][0], 0, lz + this.aim[idx][1]);
      // a 门头壁灯 hangs low but is no dimmer a bulb: full strength, so its foot is brighter than a pole lamp's
      const w = this.wall[idx];
      this.gain[i] = w ? 1 : k ** l.decay; l.intensity = this.on * 5 * this.gain[i]; l.distance = w ? 8 : 9 * k;
    });
  }
}
