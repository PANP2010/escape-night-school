import * as THREE from 'three';

/** The same analytic indoor light / eye adaptation used by the campus surfaces. No extra scene lights. */
export interface WardenLighting {
  intNightAmb: { value: THREE.Color };
  intTube: { value: THREE.Color };
  intEye: { value: THREE.Vector4 };
}
interface Fill { ambient: { value: THREE.Color }; eye: { value: number } }
const fills = new WeakMap<THREE.Material, Fill>();

/** Keep the original rough, lit material and eye embers. Fill belongs to diffuse light, never emissive glow. */
export function readableWardenMaterial(material: THREE.MeshStandardMaterial): void {
  if (fills.has(material)) return;
  const fill: Fill = { ambient: { value: new THREE.Color(.055, .065, .075) }, eye: { value: 0 } };
  fills.set(material, fill);
  material.onBeforeCompile = shader => {
    shader.uniforms.wardenAmbient = fill.ambient;
    shader.uniforms.wardenEye = fill.eye;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 wardenAmbient;\nuniform float wardenEye;')
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        // Match the campus's cool night fill and local dark adaptation; fog and depth still occlude the figure.
        float wardenNear = exp(-dot(vViewPosition, vViewPosition) / 25.0);
        vec3 wardenFill = wardenAmbient + vec3(0.62, 0.70, 0.85) * (0.12 * wardenEye * wardenNear);
        float wardenEdge = pow(1.0 - max(0.0, dot(normal, normalize(vViewPosition))), 3.0);
        reflectedLight.indirectDiffuse += diffuseColor.rgb * wardenFill * (1.0 + 0.3 * wardenEdge);
      `);
  };
  material.customProgramCacheKey = () => 'warden-campus-fill-v1';
  material.needsUpdate = true;
}

export function syncWardenMaterialLighting(material: THREE.Material, light: WardenLighting): void {
  const fill = fills.get(material);
  if (!fill) return;
  // A small base for the dark fabric, with the campus's actual tube dimming and blackout state layered on it.
  const ambient = light.intNightAmb.value, tube = light.intTube.value;
  fill.ambient.value.setRGB(
    Math.min(.2, ambient.r * 1.8 + tube.r * .065 + .025),
    Math.min(.2, ambient.g * 1.8 + tube.g * .065 + .025),
    Math.min(.2, ambient.b * 1.8 + tube.b * .065 + .025),
  );
  fill.eye.value = Math.max(0, Math.min(1, light.intEye.value.w));
}
