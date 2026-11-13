import * as THREE from 'three';

/** Dimensionless modulation: bright plaster gets fine grain, while black stays black. */
export const FILM_GRAIN = 0.032;
/** Only the very corners reach this attenuation; the centre and the path underfoot stay clear. */
export const FILM_VIGNETTE = 0.13;
const GRAIN_HZ = 24;
const SETTINGS_KEY = 'escape.settings';
export const ATMOSPHERE_SETTINGS_EVENT = 'escape:settings-change';

/** Matches GameSettings' postprocessing preference, including its mobile default. */
export function atmosphereEnabled(touch = false, storage?: Pick<Storage, 'getItem'>): boolean {
  try {
    const raw = (storage ?? globalThis.localStorage)?.getItem(SETTINGS_KEY);
    const value: unknown = raw ? JSON.parse(raw) : undefined;
    const p = value && typeof value === 'object' && !Array.isArray(value)
      ? value as { postprocessing?: unknown } : undefined;
    return typeof p?.postprocessing === 'boolean' ? p.postprocessing : !touch;
  } catch {
    return !touch;
  }
}

interface AtmosphereOptions {
  touch?: boolean;
  /** Screenshot mode: stable noise even when frame() renders the scene several times. */
  steady?: boolean;
}

/**
 * One final transparent triangle in the existing world render. No scene copy, render target, texture or second render.
 * DOM HUD is composited later by the browser, so neither grain nor vignette can cover its text.
 *
 * The custom blend is C * positiveGrain + C * (1 - vignette - negativeGrain), or C * (1 - vignette + grain).
 * These are neutral, dimensionless factors rather than scene colours: deliberately skip tone mapping and output
 * conversion here. The world has already applied the renderer's tone mapping/output colour space exactly once.
 */
export class AtmosphereFx {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly viewport = new THREE.Vector4();
  private readonly steady: boolean;
  private readonly settingsChanged: EventListener;
  private disposed = false;

  constructor(scene: THREE.Scene, options: AtmosphereOptions = {}) {
    this.steady = options.steady ?? false;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -1, -1, 0, 3, -1, 0, -1, 3, 0,
    ], 3));
    const material = new THREE.ShaderMaterial({
      name: 'film-atmosphere',
      uniforms: {
        filmViewport: { value: this.viewport },
        filmFrame: { value: 0 },
        filmGrain: { value: FILM_GRAIN },
        filmVignette: { value: FILM_VIGNETTE },
      },
      vertexShader: `void main() {
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }`,
      fragmentShader: `
        uniform vec4 filmViewport;
        uniform float filmFrame;
        uniform float filmGrain;
        uniform float filmVignette;
        float filmNoise(vec2 p) {
          vec3 h = fract(vec3(p.xyx) * 0.1031);
          h += dot(h, h.yzx + 33.33);
          return fract((h.x + h.y) * h.z);
        }
        void main() {
          vec2 uv = (gl_FragCoord.xy - filmViewport.xy) / max(filmViewport.zw, vec2(1.0));
          vec2 lens = uv * 2.0 - 1.0;
          float rim = smoothstep(0.3, 1.0, dot(lens, lens) * 0.5) * filmVignette;
          // Physical framebuffer pixels: never magnify a low-resolution noise tile into visible blocks.
          float grain = (filmNoise(floor(gl_FragCoord.xy) + filmFrame * vec2(17.17, 29.43)) - 0.5) * 2.0 * filmGrain;
          gl_FragColor = vec4(vec3(max(grain, 0.0)), rim + max(-grain, 0.0));
        }
      `,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      fog: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = 'film-atmosphere';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1_000_000;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.onBeforeRender = (renderer) => {
      // Also covers direct renderer.render() screenshots and pixel-ratio/viewport changes outside Game.resize().
      renderer.getCurrentViewport(this.viewport);
      material.uniforms.filmFrame.value = this.steady ? 0 : Math.floor(performance.now() * GRAIN_HZ / 1000) % 4096;
    };
    this.setEnabled(atmosphereEnabled(options.touch));
    scene.add(this.mesh);
    // Compatibility bridge until the settings lane calls setEnabled from its existing onChange callback.
    this.settingsChanged = (event) => {
      const detail: unknown = (event as CustomEvent<unknown>).detail;
      if (detail && typeof detail === 'object' && 'postprocessing' in detail
        && typeof detail.postprocessing === 'boolean') this.setEnabled(detail.postprocessing);
    };
    if (typeof document !== 'undefined') document.addEventListener(ATMOSPHERE_SETTINGS_EVENT, this.settingsChanged);
  }

  get enabled(): boolean { return this.mesh.visible; }

  setEnabled(enabled: boolean): void {
    this.mesh.visible = !this.disposed && enabled;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (typeof document !== 'undefined') document.removeEventListener(ATMOSPHERE_SETTINGS_EVENT, this.settingsChanged);
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.visible = false;
  }
}
