// Mounts the ported campus (world/campus.ts) into a scene and drives its night lighting (systems/timeofday.ts).
import * as THREE from 'three';
import { classroomRoute, stairRoute } from './world/interior.ts';
import { buildCampus, buildCampusAsync, CAMPUS, FLOOR_HEIGHT, groundlessFootprints, showFurniture, showInteriors, type CampusWorld } from './world/campus.ts';
import type { BuildStageOptions } from './buildStages.ts';
import { buildingHeight, courtRect, floorStack, WALL_T } from '../../../shared/campus/campus_schema.ts';
import { stairPlan, STAIR } from '../../../shared/campus/stairs.ts';
import type { LandmarkDef } from '../../../shared/levels/def.ts';
import { StreetLamps } from './world/lamps.ts';
import { townLit } from './world/outskirts.ts';
import { BRIDGE_LIGHT } from './render/facade.ts';
import { LANDMARK_LIGHT, spinFans, syncInteriorLight, syncStairLamp, TUBE, TUBE_COLOR, tubeState } from './render/interior_light.ts';
import { TimeOfDay } from './systems/timeofday.ts';
import { parseClock } from './core/state.ts';
import { CollisionWorld } from '../../../shared/campus/collision.ts';
import { campusSurfaceTexture } from '../textures.ts';
import { courtOpenings, facadeFrames, frameAxes } from './world/building.ts';
import { rectOf, storeyRooms } from './world/rooms.ts';

/** Default game clock: after 晚自习 (windows dark, street lamps on). */
export const NIGHT_MINUTE = 22 * 60 + 30;

/** `?t=HH:MM` overrides the clock (screenshots / debugging); anything unparsable falls back to the night. */
export function minuteFromQuery(search: string): number {
  const t = new URLSearchParams(search).get('t');
  if (!t) return NIGHT_MINUTE;
  try { return parseClock(t); } catch { return NIGHT_MINUTE; }
}

/** FogExp2 density: ~15 m away a wall is mostly fog (e^-(0.05·15)² ≈ 0.57 left, ~0.1 at 30 m); the flashlight cone is what shows beyond. */
export const NIGHT_FOG_DENSITY = 0.05;

/**
 * Camera far plane, by where the eye is: the fog has swallowed everything past ~60 m (e^-(0.05·60)² ≈ 0), and from
 * under a roof the facade glass is opaque, so only a doorway or the next building's wall beyond ~30 m is left to see.
 * The frustum then culls the distant trees, props and outskirts instead of drawing them into the fog.
 */
export const FAR_OUTDOOR = 60;
export const FAR_INDOOR = 30;

/**
 * 日光灯 flicker (0 or 1): at night the tubes of the few lit rooms are off, with a short irregular stutter now and then
 * (a burst of ~1.2 s every ~7 s, on/off at ~12 Hz inside it). Pure in `t` seconds.
 */
export function tubeFlicker(t: number): 0 | 1 {
  const cycle = 7.3, k = t % cycle;
  if (k > 1.2) return 0;
  return Math.sin(k * 79) + Math.sin(k * 41 + 1) > 0.2 ? 1 : 0;
}

/** The clock a `steady` CampusScene holds: between bursts, so the 日光灯 are off (tubeFlicker(STEADY_T) === 0). */
export const STEADY_T = 3;
/** the 日光灯's input floor at night (tubesOn ≥ 0.25 = full on): every corridor of a 关灯的楼 lit unless the 跳闸 is out */
export const TUBE_FLOOR = 0.3;
/** share of the 日光灯 lost in a tubeFlicker burst (a building-wide brown-out stutter) */
export const TUBE_DIP = 0.35;
/** 停电关 (blackout) × on the 夜里的底光: the emergency circuit */
export const BLACKOUT_AMB = 3;
/**
 * 暗适应 (render/interior_light.ts EYE_LIGHT) on a 停电关 (CampusScene.dark): `blackout` share while its power is out (the
 * 应急 floor is still on), full once a 跳闸 is out, on top of the blackout or after the power is back; nothing elsewhere
 * (an L1 跳闸 stays black). The eye gets there with time constant `s` seconds: a beat of black, then the floor comes back.
 */
export const EYE_ADAPT = { blackout: 0.4, s: 0.6 };
/** The 暗适应 strength (0..1) the eye heads for. */
export function eyeTarget(dark: boolean, blackout: boolean, out: number): number {
  return dark ? Math.max(blackout ? EYE_ADAPT.blackout : 0, out) : 0;
}

/** Meshes only ever seen from outside (glass is opaque, doorways aside): hidden while the eye is deep inside a building. */
const OUTDOOR_ONLY = /^(?:(?:OUTSKIRTS|ROOF_DRAINS|SHEDS|PAVING|PROPS)(?:[.@].*)?|TREES\..*)$/;
/** An actual open portal within this many metres of the eye keeps its outdoor backdrop drawn. */
export const DOORWAY_REACH = 9;

/**
 * Surface finishing stays on the existing merged geometry: one small, shared data texture, no UV seam, extra
 * light, render target or per-frame allocation. Chain the campus light shaders rather than replacing them (they
 * own blackout, torch occlusion, furniture shadows and signs). Mapped chalkboards/labels keep their crisp artwork.
 */
export function finishCampusMaterial(mat: THREE.MeshLambertMaterial, surface: THREE.DataTexture,
  kind: 'interior' | 'facade', storey = FLOOR_HEIGHT): void {
  if (mat.userData.campusFinish || mat.map) return;
  const compile = mat.onBeforeCompile, cacheKey = mat.customProgramCacheKey.bind(mat);
  const originalKey = cacheKey();
  mat.userData.campusFinish = kind;
  mat.onBeforeCompile = (shader, renderer) => {
    compile.call(mat, shader, renderer);
    shader.uniforms.campusSurface = { value: surface };
    if (kind === 'interior') {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D campusSurface;')
        .replace('#include <color_fragment>', `#include <color_fragment>
          // Metres, not box UVs: painted plaster keeps the same scale on a jamb, a long wall and a stairwell.
          vec3 finishN = normalize(vIntN);
          float finishY = mod(vIntW.y + 0.035, ${storey.toFixed(4)}) - 0.035;
          vec2 finishWall = vec2(abs(finishN.x) > 0.5 ? vIntW.z : vIntW.x, vIntW.y);
          vec2 finishUV = abs(finishN.y) > 0.5 ? vIntW.xz : finishWall;
          vec3 finishTex = texture2D(campusSurface, finishUV * 0.24).rgb;
          vec3 finishFine = texture2D(campusSurface, finishUV * 1.7).rgb;
          vec3 finishFootprint = max(fwidth(vIntW), vec3(0.001));
          vec2 finishFoot = finishFootprint.xz;
          float finishNear = 1.0 - smoothstep(7.0, 19.0, length(vViewPosition));
          bool finishWallFace = vIntDado > 0.5 && vIntDado < 1.5 && abs(finishN.y) < 0.5;
          bool finishFloor = finishN.y > 0.9 && finishY < 0.09 && finishY > -0.04 && abs(vIntDado) < 0.5;
          if (finishWallFace) {
            // Old lime paint, intermittent damp below the cornice and rubbed skirting. No black painted-on cracks.
            float finishWear = 0.8 + 0.38 * finishTex.r + 0.045 * (finishFine.g - 0.5);
            float finishDamp = finishTex.b * smoothstep(1.1, 2.9, finishY) * 0.12;
            float finishSkirt = 1.0 - smoothstep(0.045, 0.16, mod(vIntW.y - intDadoFloor(vIntW) + 0.035, ${storey.toFixed(4)}) - 0.035);
            float finishCornice = smoothstep(${(storey - 0.5).toFixed(4)}, ${(storey - 0.2).toFixed(4)}, finishY);
            diffuseColor.rgb *= finishWear * (1.0 - finishDamp) * (1.0 - 0.35 * finishSkirt - 0.17 * finishCornice);
            // Subtle roller stipple and rubbed lower paint; neither changes the silhouette of a door or sign.
            vec2 finishPlasterUV = vec2(abs(finishN.x) > 0.5 ? vIntW.z : vIntW.x, vIntW.y);
            float finishPaint = texture2D(campusSurface, finishPlasterUV * 4.1).g;
            float finishPaintFade = 1.0 - smoothstep(0.012, 0.045, max(abs(finishN.x) > 0.5 ? finishFootprint.z : finishFootprint.x, finishFootprint.y));
            diffuseColor.rgb *= 1.0 + (finishPaint - 0.5) * 0.11 * finishPaintFade;
            float finishScuff = smoothstep(0.48, 0.78, finishTex.b + finishFine.g * 0.32) * (1.0 - smoothstep(0.08, 0.65, finishY));
            diffuseColor.rgb *= 1.0 - finishScuff * 0.13;
            // Rubbed paint at hand height is lower contrast than the navigation signs.
            diffuseColor.rgb *= 1.0 - finishFine.b * 0.065 * exp(-pow((finishY - 1.0) * 4.0, 2.0)) * finishNear;
          } else if (finishFloor) {
            // 1.2 m terrazzo bays with anti-aliased brass/stone divider joints and irregular aggregate.
            vec2 finishJointD = abs(fract((vIntW.xz + 0.37) / 1.2 + 0.5) - 0.5) * 1.2;
            vec2 finishJoint = 1.0 - smoothstep(vec2(0.004), vec2(0.004) + finishFoot, finishJointD);
            float finishSeam = max(finishJoint.x, finishJoint.y) * finishNear;
            float finishChip = smoothstep(0.64, 0.73, finishFine.g) - smoothstep(0.18, 0.28, 1.0 - finishFine.g) * 0.25;
            diffuseColor.rgb *= (0.96 + 0.12 * finishTex.r + 0.13 * (finishFine.g - 0.5) * finishNear) * (1.0 - 0.23 * finishSeam);
            diffuseColor.rgb *= vec3(0.96, 1.0, 1.035);
            diffuseColor.rgb += vec3(0.012) * finishChip * finishNear;
            // Centimetre stone aggregate disappears into its average before it becomes subpixel shimmer.
            uvec2 finishCell = uvec2(floor(mod(vIntW.xz, 64.0) * 43.0));
            uint finishHash = (finishCell.x * 1597334677u) ^ (finishCell.y * 3812015801u);
            finishHash ^= finishHash >> 16; finishHash *= 2246822519u; finishHash ^= finishHash >> 13;
            float finishStone = float(finishHash >> 8) / 16777216.0;
            float finishStoneK = finishStone < 0.19 ? 0.78 : (finishStone > 0.87 ? 1.17 : 1.0);
            float finishStoneShape = 1.0 - smoothstep(0.19, 0.45, length(fract(mod(vIntW.xz, 64.0) * 43.0) - 0.5));
            float finishStoneFade = 1.0 - smoothstep(0.012, 0.042, max(finishFoot.x, finishFoot.y));
            diffuseColor.rgb *= mix(1.0, finishStoneK, finishStoneShape * finishStoneFade);
            // Existing furniture height map supplies contact shade without shadow maps or a second geometry pass.
            float finishBand = floor((vIntW.y + 0.05) / ${storey.toFixed(4)});
            float finishOcc = intFurnAt(finishBand, vIntW.xz);
            diffuseColor.rgb *= 1.0 - 0.2 * smoothstep(0.1, 0.65, finishOcc);
          } else if (finishN.y < -0.9 && vIntDado > -0.5 && vIntDado < 0.5) {
            diffuseColor.rgb *= 0.83 + 0.17 * finishTex.r + 0.035 * (finishFine.g - 0.5);
          } else if (vIntDado > -0.5 && vIntDado < 0.5 && finishY > 0.4 && finishY < 1.5) {
            // Varnished desk tops: directional grain instead of the plaster's isotropic noise. Restrict the warm
            // ochre hue so steel, paper, red fire cabinets and all tagged artwork keep their original surfaces.
            float finishWood = smoothstep(1.9, 2.8, diffuseColor.r / max(diffuseColor.b, 0.025))
              * smoothstep(0.42, 0.68, diffuseColor.g / max(diffuseColor.r, 0.025));
            vec2 finishGrainUV = abs(finishN.y) > 0.5 ? vIntW.xz : finishWall;
            float finishGrain = texture2D(campusSurface, finishGrainUV * vec2(0.7, 11.0) + vec2(0.0, finishTex.r * 0.09)).r;
            vec2 finishGrainFoot = abs(finishN.y) > 0.5 ? finishFootprint.xz
              : vec2(abs(finishN.x) > 0.5 ? finishFootprint.z : finishFootprint.x, finishFootprint.y);
            float finishGrainFade = 1.0 - smoothstep(0.008, 0.035, max(finishGrainFoot.x, finishGrainFoot.y));
            diffuseColor.rgb *= 1.0 + finishWood * ((finishGrain - 0.5) * 0.28 * finishGrainFade + (finishTex.r - 0.5) * 0.12) * finishNear;
            diffuseColor.rgb *= mix(vec3(1.0), vec3(1.025, 0.985, 0.95), finishWood);
          }`)
        // Keep the established emergency/eye floor intact; only powered fluorescent light gets alternating pools.
        .replace('// 黑板灯 on the front', `
          vec2 finishLamp = abs(mod(vIntW.xz - intBox.xy + vec2(${TUBE.px / 2}, ${TUBE.pz / 2}), vec2(${TUBE.px.toFixed(1)}, ${TUBE.pz.toFixed(1)})) - vec2(${TUBE.px / 2}, ${TUBE.pz / 2}));
          float finishPool = exp(-dot(finishLamp, finishLamp) * 0.62);
          tube *= mix(vec3(0.67, 0.78, 0.81) * (0.38 + 0.62 * finishPool), vec3(1.0), intDayShare);
          // 黑板灯 on the front`);
      shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if (finishFloor && intFurnAt(floor((vIntW.y + 0.05) / ${storey.toFixed(4)}), vIntW.xz) < 0.1) {
          // A rough waxed-floor reflection: ceiling strips reflected about the eye, blurred in world metres.
          // It uses the real tube state, so it vanishes under blackout/trip and never substitutes for the eye light.
          vec3 finishView = normalize(cameraPosition - vIntW);
          vec3 finishRay = reflect(-finishView, vec3(0.0, 1.0, 0.0));
          vec2 finishHit = vIntW.xz + finishRay.xz * (intCeil(vIntW.y) - vIntW.y) / max(finishRay.y, 0.06);
          vec2 finishRef = abs(mod(finishHit - intBox.xy + vec2(${TUBE.px / 2}, ${TUBE.pz / 2}), vec2(${TUBE.px.toFixed(1)}, ${TUBE.pz.toFixed(1)})) - vec2(${TUBE.px / 2}, ${TUBE.pz / 2}));
          float finishSheen = exp(-pow(max(finishRef.x - 0.42, 0.0), 2.0) * 4.0 - finishRef.y * finishRef.y * 7.0);
          finishSheen *= (0.4 + finishTex.r) * (0.25 + 0.75 * pow(1.0 - finishView.y, 2.0));
          vec3 finishCeilingHit = vec3(finishHit.x, intCeil(vIntW.y), finishHit.y);
          finishSheen *= intNightLit(finishCeilingHit) * intLive(finishCeilingHit) * intTubeSick(finishCeilingHit);
          totalEmissiveRadiance += intTube * intNightLit(vIntW) * intLive(vIntW) * finishSheen * 0.022;
        }`);
      if (!shader.fragmentShader.includes('finishPool') || !shader.fragmentShader.includes('finishWallFace'))
        throw new Error('campus finish: interior shader hooks moved');
    } else {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D campusSurface;')
        .replace('#include <color_fragment>', `#include <color_fragment>
          // Concrete weathering is excluded from glass, roof sealant and luminous fixture faces.
          if (vSurf.x < 1.5) {
            vec2 finishUV = vec2(dot(vFacW.xz, vec2(-vFacN.z, vFacN.x)), vFacW.y) * 0.18;
            vec3 finishTex = texture2D(campusSurface, finishUV).rgb;
            float finishBase = 1.0 - smoothstep(0.0, 0.75, vFacW.y);
            diffuseColor.rgb *= (0.88 + 0.22 * finishTex.r) * (1.0 - finishTex.b * 0.2 - finishBase * 0.2);
          }`);
      if (!shader.fragmentShader.includes('finishBase')) throw new Error('campus finish: facade shader hook moved');
    }
  };
  mat.customProgramCacheKey = () => `${originalKey}|campus-finish-v4:${kind}:${storey}`;
  mat.needsUpdate = true;
}

/** A few folded exam sheets at corridor edges: one merged draw per occupied storey, never a collider. */
function corridorLitter(scene: THREE.Scene, interiors: ReturnType<typeof buildCampus>['interiors']) {
  const paper = [
    -0.105, 0, -0.145, 0.105, 0, -0.145, -0.105, 0, 0.145,
    0.105, 0, -0.145, 0.055, 0.012, 0.105, -0.105, 0, 0.145,
    0.055, 0.012, 0.105, 0.105, 0.03, 0.145, -0.105, 0, 0.145,
  ];
  const placements = [
    { building: 'A', y: 0.025, points: [[-51.7, 72.7], [-46.1, 74.5], [-32.8, 72.6], [-24.8, 74.7], [-62.8, 78.1], [-60.8, 90.8], [-49.8, 69.7], [-20.6, 83.8]] },
    { building: 'B', y: 3.625, points: [[21.7, 85.1], [30.3, 83.1], [41.1, 85.2], [50.6, 83.3], [37.8, 80.8], [27.5, 77.6]] },
  ];
  return placements.map(({ building, y, points }) => {
    const it = interiors.find(it => it.b.id === building)!, positions: number[] = [], colors: number[] = [], tags: number[] = [];
    const vertex = new THREE.Vector3(), matrix = new THREE.Matrix4(), color = new THREE.Color(0xaaa48f);
    points.forEach(([x, z], i) => {
      matrix.makeRotationY(i * 2.39 + 0.3); matrix.setPosition(x, y, z);
      // Reverse the winding so the folded sheets face up, sharing the actual indoor lighting and outage uniforms.
      for (let t = 0; t < paper.length; t += 9) for (const v of [0, 2, 1]) {
        vertex.fromArray(paper, t + v * 3).applyMatrix4(matrix);
        positions.push(vertex.x, vertex.y, vertex.z); colors.push(color.r, color.g, color.b); tags.push(0, -4);
      }
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setAttribute('surf', new THREE.Float32BufferAttribute(tags, 2));
    geometry.computeVertexNormals(); geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, it.mesh.material);
    mesh.name = `${building}.corridor.paper`;
    scene.add(mesh);
    return { mesh, y, b: it.b };
  });
}

/** Quiet horizon haze gives the silhouette a backdrop; no full-screen post processing or bright star noise. */
function campusSky(): THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial> {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { skyTop: { value: new THREE.Color() }, skyHorizon: { value: new THREE.Color() }, skyMoon: { value: new THREE.Vector3() }, skyNight: { value: 0 } },
    vertexShader: `varying vec3 skyDirection;
      void main() { skyDirection = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying vec3 skyDirection;
      uniform vec3 skyTop; uniform vec3 skyHorizon; uniform vec3 skyMoon; uniform float skyNight;
      void main() {
        vec3 d = normalize(skyDirection);
        float h = smoothstep(-0.04, 0.65, d.y);
        vec3 c = mix(skyHorizon, skyTop, h);
        float cloud = sin(d.x * 11.0 + d.z * 6.0 + sin(d.z * 17.0) * 0.6) * sin(d.z * 8.0 - d.y * 13.0);
        c *= 0.9 + cloud * 0.09;
        float moon = max(0.0, dot(d, skyMoon));
        c += vec3(0.018, 0.023, 0.029) * pow(moon, 45.0) * skyNight;
        c += vec3(0.18, 0.21, 0.24) * smoothstep(0.99975, 0.99993, moon) * skyNight;
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), mat);
  sky.name = 'CAMPUS_SKY'; sky.renderOrder = -10; sky.frustumCulled = false;
  return sky;
}

export interface PreparedCampus {
  scene: THREE.Scene;
  world: CampusWorld;
}

/** Only the temporary scene owns these resources; a cancelled build never touches the live world. */
export function discardPreparedCampus(scene: THREE.Scene): void {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  scene.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    if (mesh.material) for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      materials.add(material);
      for (const value of Object.values(material)) if ((value as THREE.Texture | null)?.isTexture) textures.add(value as THREE.Texture);
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
  scene.clear();
}

export class CampusScene {
  /** Build away from the live renderer: no incomplete floors, missing collisions or duplicate draw layers. */
  static async prepare(options: BuildStageOptions = {}): Promise<PreparedCampus> {
    const scene = new THREE.Scene();
    try { return { scene, world: await buildCampusAsync(scene, options) }; }
    catch (error) { discardPreparedCampus(scene); throw error; }
  }
  readonly world: ReturnType<typeof buildCampus>;
  readonly collision: CollisionWorld;
  readonly tod: TimeOfDay;
  readonly lamps = new StreetLamps();
  readonly hemi = new THREE.HemisphereLight();
  readonly sun = new THREE.DirectionalLight();
  minute: number;
  /** 停电关: every 日光灯 / 声控灯 / lit window is off (the level's emergency lamps are the game's own). */
  blackout = false;
  /** on a 停电关 level, also once its power is back: the 暗适应 (EYE_ADAPT) comes on with the blackout or a 跳闸 */
  dark = false;
  /** 暗适应 strength now (0..1), easing to eyeTarget */
  eye = 0;
  /**
   * e2e (`?steady`): the scene clock holds at STEADY_T, so the 日光灯 stutter (a burst lifts a corridor frame's mean
   * ~11 → ~70) and the 机房 指示灯/监控 stay put and a brightness comparison sees only what the test itself changed.
   */
  steady = false;
  /**
   * 跳闸 (server 'trip', client game.ts): `out` = how far the 日光灯 are out (0 on … 1 every tube on the floor dark), spread
   * outward from `outAt` (x, z) to radius `outR` m so tubes die one after another; `stutter` 0/1 the 预兆 / restart flicker.
   */
  out = 0;
  /** Exam penalties can cut one storey; null keeps ordinary trips building-wide. */
  outFloor: number | null = null;
  outR = 999;
  readonly outAt = new THREE.Vector2();
  stutter: 0 | 1 = 0;
  private time = 0;
  private outdoor: THREE.Object3D[] = [];
  private readonly sky = campusSky();
  private readonly litter: ReturnType<typeof corridorLitter>;
  private readonly fogTint = new THREE.Color(0.92, 1.2, 1.35);
  private readonly atmosphere = new THREE.Color();
  private readonly treeLight = new THREE.Color();
  private readonly outdoorFrustum = new THREE.Frustum();
  private readonly outdoorProjection = new THREE.Matrix4();
  private landmarkOn = false;
  private readonly scene: THREE.Scene;
  private readonly exposure: {
    interior: ReturnType<typeof buildCampus>['interiors'][number];
    roof: number;
    court: ReturnType<typeof courtRect>;
    doors: THREE.Box3[];
  }[];

  constructor(scene: THREE.Scene, minute = NIGHT_MINUTE, prepared?: PreparedCampus) {
    this.scene = scene;
    this.minute = minute;
    scene.background = new THREE.Color();
    scene.fog = new THREE.FogExp2(0, NIGHT_FOG_DENSITY);
    scene.add(this.hemi, this.sun, this.lamps.group);
    if (prepared) scene.add(...prepared.scene.children.slice());
    this.world = prepared?.world ?? buildCampus(scene);
    // The board clocks really move when ?t/the scene minute changes. buildCampus has already installed static
    // upload-release callbacks; retain only these two animated attributes so a later clock change cannot write
    // into null CPU arrays. Atlas UVs/colours and the rest of the campus still release normally after upload.
    scene.traverse(object => {
      const geometry = (object as THREE.Mesh).geometry;
      if (!geometry?.userData.clocks?.length) return;
      for (const name of ['position', 'normal']) {
        const attribute = geometry.getAttribute(name) as THREE.BufferAttribute;
        attribute.setUsage(THREE.DynamicDrawUsage);
        attribute.onUpload(() => {});
      }
    });
    // Cache static geometry once. A footprint alone incorrectly treats A's open courtyard as roofed, and
    // shrinking B's 12 m depth by 9 m on both sides can never recognise its corridor as deep indoors.
    this.exposure = this.world.interiors.map(interior => {
      const b = interior.b, doors = interior.portals.map(portal => portal.box);
      // Interior visibility portals omit courtyard doors because they are inside the building's outer box;
      // atmosphere exposure must include them, otherwise the open sky still pops at the courtyard threshold.
      const openings = courtOpenings(b).filter(opening => opening.kind === 'entrance');
      for (const frame of facadeFrames(b).filter(frame => frame.court)) {
        const { at } = frameAxes(frame);
        for (const opening of openings.filter(opening => opening.side === frame.side))
          doors.push(new THREE.Box3().setFromPoints([at(opening.u0, opening.y0), at(opening.u1, opening.y1)]));
      }
      return { interior, roof: buildingHeight(b) - 0.2, court: courtRect(b), doors };
    });
    const surface = campusSurfaceTexture();
    for (const it of this.world.interiors) {
      // A/B supply the playable L1/L2 spaces. Other buildings keep their specialised material treatment.
      if (it.b.id === 'A' || it.b.id === 'B') finishCampusMaterial(it.mesh.material as THREE.MeshLambertMaterial, surface, 'interior', it.b.floorHeight ?? FLOOR_HEIGHT);
    }
    const facade = scene.getObjectByName('A') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
    finishCampusMaterial(facade.material, surface, 'facade');
    this.litter = corridorLitter(scene, this.world.interiors);
    scene.add(this.sky);
    scene.onBeforeRender = (_r, _s, cam) => showInteriors(this.world.interiors, cam);
    scene.traverse(o => { if ((o as THREE.Mesh).isMesh && OUTDOOR_ONLY.test(o.name || o.parent?.name || '')) this.outdoor.push(o); });
    this.collision = new CollisionWorld(this.world.colliders);
    this.world.gate.attach(this.collision);
    for (const h of groundlessFootprints()) this.collision.addHole(h.x0, h.x1, h.z0, h.z1);
    this.tod = new TimeOfDay({ scene, hemi: this.hemi, sun: this.sun, lamps: this.lamps, ground: this.world.ground.material, tinted: [this.world.paving.material] });
    this.world.boards.sync(1);
    this.world.decals.sync(1);
  }

  /** Move the one persistent analytic lamp to this level's lit room; no light/material is added on level changes. */
  setLandmarks(landmarks: readonly LandmarkDef[] | undefined): void {
    const u = this.world.interior;
    this.landmarkOn = false;
    u.intLandmark.value.w = 0;
    const m = landmarks?.find(m => m.kind === 'lit');
    if (!m) return;
    const b = this.world.buildings.find(b => Math.abs(m.x - b.x) < b.w / 2 && Math.abs(m.z - b.z) < b.d / 2);
    if (!b) return;
    const st = floorStack(b).find(st => Math.abs(st.y - m.y) < 0.1);
    if (!st) return;
    const x = m.x - b.x, z = m.z - b.z;
    const contains = (r: { x0: number; x1: number; z0: number; z1: number }) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1;
    const room = storeyRooms(b, st.level).find(room => contains(rectOf(room)));
    const stair = b.stairwells?.filter(s => st.level >= s.from && st.level <= s.to).map(s => stairPlan(b, s, WALL_T)).find(p => contains(p.clear));
    const r = room ? rectOf(room) : stair?.clear;
    if (!r) return;
    u.intLandmark.value.set(m.x, m.y + LANDMARK_LIGHT.height, m.z, this.blackout ? 0 : 1);
    u.intLandmarkRect.value.set(b.x + r.x0, b.z + r.z0, b.x + r.x1, b.z + r.z1);
    u.intLandmarkY.value.set(st.y, st.y + st.h - STAIR.slab);
    // The existing landmark mesh has its tube along local X, turned with the sign's facing direction.
    u.intLandmarkAxis.value.set(m.dir[0] === 'x' ? 0 : 1, m.dir[0] === 'x' ? 1 : 0);
    this.landmarkOn = true;
  }

  /** Per frame: light for the clock, interiors/furniture near the camera. */
  update(dt: number, cam: THREE.Camera): void {
    this.time = this.steady ? STEADY_T : this.time + dt;
    this.tod.update(this.minute);
    const s = this.tod.sample, f = this.world.facade, w = this.world;
    // Blend by sky luminance, rather than the sun/moon enum which switches discretely during dusk/dawn.
    const horizonLuma = s.horizon[0] * 0.2126 + s.horizon[1] * 0.7152 + s.horizon[2] * 0.0722;
    const night = 1 - THREE.MathUtils.smoothstep(horizonLuma, 0.015, 0.12);
    const sky = this.sky.material.uniforms;
    sky.skyTop.value.setRGB(...s.zenith);
    sky.skyHorizon.value.setRGB(...s.horizon).multiplyScalar(1 + 0.35 * night);
    sky.skyMoon.value.set(...s.sunDir);
    sky.skyNight.value = s.body === 'moon' ? s.disc : 0;
    // Cool atmospheric separation at night; the sodium entrance pools retain the only warm outdoor accent.
    if (this.scene.fog instanceof THREE.FogExp2) {
      this.atmosphere.setRGB(1, 1, 1).lerp(this.fogTint, night);
      this.scene.fog.color.setRGB(...s.horizon).multiply(this.atmosphere);
    }
    f.glassZenith.value.setRGB(...s.zenith);
    f.glassHorizon.value.setRGB(...s.horizon);
    f.windowsLit.value = s.windows;
    const win = this.blackout ? 0 : s.windows, lamps = this.blackout ? 0 : s.lamps;
    const tubes = tubeState(win, 0, lamps);
    f.windowsDay.value = tubes.on * tubes.day;
    f.bridgeLamp.value.copy(BRIDGE_LIGHT.color).lerp(TUBE_COLOR, tubes.day).multiplyScalar(BRIDGE_LIGHT.level * tubes.on);
    w.outskirtsLit.value = townLit(this.minute, s.lamps);
    // 日光灯 on at night in the 关灯的楼 too (TUBE_FLOOR): the corridor is visible but uneasy; darkness is the 跳闸 event
    const tubeIn = this.blackout ? win + tubeFlicker(this.time) * 0.25 * lamps : Math.max(win, TUBE_FLOOR * lamps);
    syncInteriorLight(w.interior, s.sunDir, this.sun, tubeIn * (this.stutter ? 0.15 : 1), this.hemi, lamps, 0);
    // the building-wide stutter (tubeFlicker) is now a dip, not a lift; per-tube flicker / dead tubes are in the shader
    if (!this.blackout) w.interior.intTube.value.multiplyScalar(1 - TUBE_DIP * tubeFlicker(this.time));
    w.interior.intLandmark.value.w = this.landmarkOn && !this.blackout ? 1 : 0;
    w.interior.intOut.value.set(this.outAt.x, this.outAt.y, this.outR, this.out);
    w.interior.intOutFloor.value = this.outFloor ?? -999;
    const cameraOut = this.outFloor === null || Math.floor((cam.position.y + 0.01) / FLOOR_HEIGHT) === this.outFloor ? this.out : 0;
    // 停电关: the 应急照明 circuit lifts the floor so the level reads dark-but-legible (the fuses still matter)
    w.interior.intNightAmb.value.multiplyScalar((this.blackout ? BLACKOUT_AMB : 1) * (1 - 0.85 * (this.outFloor === null ? this.out : 0)));
    const eyeTo = eyeTarget(this.dark, this.blackout, cameraOut);
    this.eye = eyeTo + (this.eye - eyeTo) * Math.exp(-dt / EYE_ADAPT.s);
    w.interior.intEye.value.set(cam.position.x, cam.position.y, cam.position.z, this.eye);
    w.interior.intTime.value = this.time % 3600;
    syncStairLamp(w.interior, false);
    spinFans(w.interior, dt, win, 0, lamps);
    w.boards.syncTime(this.minute);
    // The tree renderer's default scattering uniform is white. Feed the actual night light so crowns do not
    // glow over a black avenue, and advance the existing wind/falling-leaf animation without another draw pass.
    this.treeLight.setRGB(...s.hemiSky).multiplyScalar(s.hemiIntensity);
    this.treeLight.r += s.sunColor[0] * this.sun.intensity * 0.15;
    this.treeLight.g += s.sunColor[1] * this.sun.intensity * 0.15;
    this.treeLight.b += s.sunColor[2] * this.sun.intensity * 0.15;
    // Crowns already receive the direct moon through Lambert lighting. Keep the extra scattering and leaf
    // particles subdued at night as moonlight is raised for the path; fade smoothly with the rest of the night palette.
    this.treeLight.multiplyScalar(1 - 0.8 * night);
    w.trees.update(this.time, this.treeLight);
    const p = cam.position;
    this.sky.position.copy(p);
    showFurniture(w.furniture, p.x, p.y, p.z);
    for (const it of this.litter) {
      const b = it.b;
      it.mesh.visible = Math.abs(p.x - b.x) < b.w / 2 && Math.abs(p.z - b.z) < b.d / 2 && p.y >= it.y && p.y < it.y + FLOOR_HEIGHT;
    }
    this.lamps.follow(p.x, p.z);
    if (cam instanceof THREE.PerspectiveCamera) {
      // A nearby doorway only exposes the outdoor backdrop while it is actually in view. In the south
      // corridor the courtyard door can be beside/behind the eye; keeping the whole campus alive there
      // draws the shader-displaced leaves (which cannot use ordinary mesh frustum culling) into solid walls.
      cam.updateMatrixWorld();
      this.outdoorFrustum.setFromProjectionMatrix(this.outdoorProjection.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
      const roofed = this.exposure.find(({ interior: { b }, roof, court }) => {
        if (Math.abs(p.x - b.x) >= b.w / 2 || Math.abs(p.z - b.z) >= b.d / 2 || p.y >= roof) return false;
        return !(court && p.y >= 0 && p.x > b.x + court.x0 && p.x < b.x + court.x1 && p.z > b.z + court.z0 && p.z < b.z + court.z1);
      });
      const doorway = roofed?.doors.some(box => p.y >= box.min.y - 0.25
        && p.y <= box.max.y + 0.25 && box.distanceToPoint(p) < DOORWAY_REACH && this.outdoorFrustum.intersectsBox(box));
      const outsideVisible = !roofed || !!doorway;
      for (const o of this.outdoor) o.visible = outsideVisible;
      const far = outsideVisible ? FAR_OUTDOOR : FAR_INDOOR;
      // Use the same exposure decision for the sky, its clip distance and the outdoor geometry, so a doorway
      // never turns the sky into a flat background while the avenue is still being drawn through it.
      this.sky.visible = outsideVisible;
      this.sky.scale.setScalar(far * 0.94);
      if (cam.far !== far) { cam.far = far; cam.updateProjectionMatrix(); }
    }
  }
}

export interface View { x: number; y: number; z: number; yaw: number; pitch: number }

/** Camera at `a` (eye height `y`) looking towards `b` (the game camera looks down −Z at yaw 0). */
function look(a: [number, number], b: [number, number], y = 1.6, pitch = 0): View {
  return { x: a[0], y, z: a[1], yaw: Math.atan2(-(b[0] - a[0]), -(b[1] - a[1])), pitch };
}

/** Fixed screenshot views of 教学楼A (docs/shots/campus/): outdoor, main corridor, a classroom, the stairwell. */
export function shotViews(): Record<'outdoor' | 'corridor' | 'classroom' | 'stairs', View> {
  const a = CAMPUS.buildings.find(b => b.id === 'A')!;
  const c = classroomRoute(a, 1), s = stairRoute(a, 2);
  const out: [number, number] = [c[0][0] + (c[0][0] - a.x) * 0.9, c[0][1] + (c[0][1] - a.z) * 0.9];
  return {
    outdoor: look(out, [a.x, a.z], 5, -0.12),
    corridor: look(c[2], c[3]),
    classroom: look(c[4], c[5], 1.6, -0.15),
    stairs: look(s[s.length - 3], s[s.length - 2], 1.6, 0.2),
  };
}
