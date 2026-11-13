import * as THREE from 'three';

/** How many lamp reflections the shader knows about (the lamps' pooled spot lights, world/lamps.ts). */
export const WET_LAMPS = 4;

/**
 * Where a lamp's reflection sits on wet flat ground, as seen from `cam`: the ground hit of the ray toward the
 * lamp's mirror image (x, -h, z), plus the streak's axis (unit xz vector toward the camera) and its length toward
 * the viewer (a glossy reflection stretches more the further away and the more grazing it is). Pure; the shader
 * does the same maths per fragment, this copy is for tests and docs.
 */
export function lampReflection(cam: [number, number, number], lamp: [number, number, number]) {
  const [cx, cy, cz] = cam, [lx, ly, lz] = lamp;
  const t = cy / (cy + ly);
  const mx = cx + (lx - cx) * t, mz = cz + (lz - cz) * t;
  const dx = cx - mx, dz = cz - mz, dist = Math.hypot(dx, dz) || 1;
  return { x: mx, z: mz, dir: [dx / dist, dz / dist] as [number, number], len: 0.6 + 0.14 * dist };
}

type Rect = { x0: number; x1: number; z0: number; z1: number };
/**
 * A flat ground quad `size` centred on (x, z) = `center`, at y, facing up, with rect holes cut out (world x0..x1,
 * z0..z1: the stairwells down into a 地下室, or for the puddle layer whole building footprints). A hole's `court`
 * (a 天井 inside a footprint) is put back as an island. Holes must not overlap. Plain PlaneGeometry when there are none.
 */
export function groundPlane(size: [number, number], center: [number, number], y: number, holes: (Rect & { court?: Rect })[] = []): THREE.BufferGeometry {
  if (!holes.length) {
    const g = new THREE.PlaneGeometry(size[0], size[1]);
    g.rotateX(-Math.PI / 2);
    return g.translate(center[0], y, center[1]);
  }
  // shapes in (x, -z), then laid flat by the same rotation as the plane
  const [w, d] = [size[0] / 2, size[1] / 2], [cx, cz] = center;
  const quad = (r: Rect) => [new THREE.Vector2(r.x0, -r.z0), new THREE.Vector2(r.x1, -r.z0), new THREE.Vector2(r.x1, -r.z1), new THREE.Vector2(r.x0, -r.z1)];
  const shape = new THREE.Shape(quad({ x0: cx - w, x1: cx + w, z0: cz - d, z1: cz + d }));
  for (const h of holes) shape.holes.push(new THREE.Path(quad(h).reverse()));
  const g = new THREE.ShapeGeometry([shape, ...holes.flatMap(h => (h.court ? [new THREE.Shape(quad(h.court))] : []))]);
  g.rotateX(-Math.PI / 2);
  return g.translate(0, y, 0);
}

/**
 * Wet ground (docs/05 天气细节): one flat quad just above the ground, premultiplied-alpha blended, no depth write
 * (the ink pass never outlines it). Puddles = hard-edged world-space value-noise blobs that grow as `wet` rises;
 * inside they are dark water that mirrors the horizon colour only at grazing angles (Fresnel); the nearest lamps as streaks stretched toward the camera, and wet
 * asphalt between them carries a fainter streak (the long warm smears of a rainy night). Rain wobbles the streaks.
 * Fogged by hand (faded toward the already-fogged ground underneath). Hidden at wet 0: no draw call when dry.
 */
export class WetGround {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private mat: THREE.ShaderMaterial;

  constructor(size: [number, number], center: [number, number], y = 0.015, holes: (Rect & { court?: Rect })[] = []) {
    const geo = groundPlane(size, center, y, holes);
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        wet: { value: 0 },
        rain: { value: 0 },
        time: { value: 0 },
        sky: { value: new THREE.Color() },
        lampColor: { value: new THREE.Color(0xffc987) },
        lamps: { value: Array.from({ length: WET_LAMPS }, () => new THREE.Vector4(0, -100, 0, 0)) },
        fogRange: { value: new THREE.Vector2(30, 220) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vW;
        void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */ `
        uniform float wet; uniform float rain; uniform float time; uniform vec3 sky; uniform vec3 lampColor;
        uniform vec4 lamps[${WET_LAMPS}]; uniform vec2 fogRange;
        varying vec3 vW;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vnoise(vec2 p){
          vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
        }
        void main(){
          vec2 p = vW.xz;
          float n = vnoise(p * 0.32) * 0.7 + vnoise(p * 1.3 + 17.0) * 0.3;
          // puddles open up as the ground soaks (hard edge: a soft one would dither into a halo)
          float puddle = step(1.0 - wet * 0.42, n);
          vec3 streak = vec3(0.0);
          for (int i = 0; i < ${WET_LAMPS}; i++){
            vec4 L = lamps[i];
            if (L.w <= 0.0) continue;
            float t = cameraPosition.y / (cameraPosition.y + L.y);
            vec2 m = mix(cameraPosition.xz, L.xz, t);
            vec2 toCam = cameraPosition.xz - m; float dist = max(length(toCam), 0.001);
            vec2 d = toCam / dist;
            vec2 o = p - m;
            float a = dot(o, d), b = dot(o, vec2(-d.y, d.x));
            b += sin(a * 5.0 + time * 9.0 + float(i) * 2.0) * 0.06 * rain; // raindrops break the mirror up
            float len = a > 0.0 ? 0.6 + 0.14 * dist : 0.45;
            float w = 0.16 + 0.012 * dist;
            streak += lampColor * L.w * exp(-b * b / (w * w)) * exp(-a * a / (len * len));
          }
          // Fresnel: looking down into a near puddle you see dark water, at a grazing angle far off it mirrors the sky
          vec3 v = normalize(cameraPosition - vW);
          float fres = 0.04 + 0.96 * pow(1.0 - clamp(v.y, 0.0, 1.0), 5.0);
          float a = puddle * 0.65 * wet;
          vec3 c = sky * a * fres * 0.8 + streak * wet * mix(0.3, 1.1, puddle);
          float fade = 1.0 - smoothstep(fogRange.x, fogRange.y, distance(vW, cameraPosition));
          gl_FragColor = vec4(c * fade, a * fade);
        }`,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.name = 'WET_GROUND';
    this.mesh.renderOrder = -1; // under the additive lamp pools
    this.mesh.visible = false;
  }

  get wet(): number { return this.mat.uniforms.wet.value; }

  /**
   * wet/rain 0..1; `sky` = horizon colour (linear) mirrored by puddles; `lights` = the lamps' pooled spot lights
   * (their positions + intensity / 9 = how lit); fog range from the scene fog.
   */
  update(wet: number, rain: number, time: number, sky: THREE.Color, lights: readonly { position: THREE.Vector3; intensity: number }[], fog?: THREE.Fog): void {
    const u = this.mat.uniforms;
    u.wet.value = wet; u.rain.value = rain; u.time.value = time;
    u.sky.value.copy(sky);
    if (fog) u.fogRange.value.set(fog.near, fog.far);
    const ls = u.lamps.value as THREE.Vector4[];
    for (let i = 0; i < WET_LAMPS; i++) {
      const l = lights[i];
      // the glowing head sits a little above the point light
      if (l) ls[i].set(l.position.x, l.position.y + 0.2, l.position.z, l.intensity / 9);
      else ls[i].w = 0;
    }
    this.mesh.visible = wet > 0.001;
  }
}
