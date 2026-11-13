import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { ATMOSPHERE_SETTINGS_EVENT, AtmosphereFx, atmosphereEnabled } from '../../client/src/atmosphere.ts';

afterEach(() => vi.unstubAllGlobals());

describe('film atmosphere preferences', () => {
  it('uses the same desktop/mobile defaults and only accepts a stored boolean', () => {
    for (const raw of [null, '{', 'null', '[]', 'true', '{"postprocessing":"false"}']) {
      const storage = { getItem: () => raw };
      expect(atmosphereEnabled(false, storage)).toBe(true);
      expect(atmosphereEnabled(true, storage)).toBe(false);
    }
    expect(atmosphereEnabled(false, { getItem: () => '{"postprocessing":false}' })).toBe(false);
    expect(atmosphereEnabled(true, { getItem: () => '{"postprocessing":true}' })).toBe(true);
    const denied = { getItem: (): string | null => { throw new Error('storage denied'); } };
    expect(atmosphereEnabled(false, denied)).toBe(true);
    expect(atmosphereEnabled(true, denied)).toBe(false);
  });

  it('removes the draw when disabled, responds to preferences, and releases resources once', () => {
    const events = new EventTarget();
    vi.stubGlobal('document', events);
    vi.stubGlobal('localStorage', { getItem: () => '{"postprocessing":false}' });
    const scene = new THREE.Scene(), film = new AtmosphereFx(scene);
    const geometryDisposed = vi.fn(), materialDisposed = vi.fn();
    film.mesh.geometry.addEventListener('dispose', geometryDisposed);
    film.mesh.material.addEventListener('dispose', materialDisposed);
    const change = (postprocessing: unknown) => events.dispatchEvent(
      new CustomEvent(ATMOSPHERE_SETTINGS_EVENT, { detail: { postprocessing } }));
    expect(film.enabled).toBe(false);
    change(true);
    expect(film.enabled).toBe(true);
    change('false'); // malformed event must not silently disable or enable graphics
    expect(film.enabled).toBe(true);
    change(false);
    expect(film.mesh.visible).toBe(false); // Three skips invisible meshes, including their shader draw
    film.setEnabled(true);
    expect(film.enabled).toBe(true);
    film.dispose(); film.dispose();
    expect(scene.children).toHaveLength(0);
    expect(geometryDisposed).toHaveBeenCalledOnce();
    expect(materialDisposed).toHaveBeenCalledOnce();
    change(true); film.setEnabled(true);
    expect(film.enabled).toBe(false);
  });
});

describe('film atmosphere direct renders', () => {
  it('uses the active physical viewport on every render, including after resize and pixel-ratio changes', () => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    const scene = new THREE.Scene(), film = new AtmosphereFx(scene, { steady: true });
    const current = new THREE.Vector4(0, 0, 1280, 720);
    const renderer = { getCurrentViewport: (out: THREE.Vector4) => out.copy(current) };
    const render = () => film.mesh.onBeforeRender(renderer as THREE.WebGLRenderer, scene,
      new THREE.PerspectiveCamera(), film.mesh.geometry, film.mesh.material, new THREE.Group());
    render();
    expect(film.mesh.material.uniforms.filmViewport.value.toArray()).toEqual([0, 0, 1280, 720]);
    current.set(12, 4, 1266, 585); // e.g. a phone viewport rendered at a changed DPR
    render();
    expect(film.mesh.material.uniforms.filmViewport.value.toArray()).toEqual([12, 4, 1266, 585]);
    expect(film.mesh.material.uniforms.filmFrame.value).toBe(0); // frame() captures are repeatable under ?steady
    film.dispose();
  });
});
