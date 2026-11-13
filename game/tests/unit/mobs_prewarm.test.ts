import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

// the 值日生 paints its textures on canvases: a 2D context that swallows every call is enough here
const ctx2d: any = new Proxy(function () {}, { get: (_, k) => (k === 'measureText' ? () => ({ width: 1 }) : ctx2d), apply: () => ctx2d, set: () => true });
vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }) });
const { Mobs, materialTextures } = await import('../../client/src/mobs.ts');

function fakeRenderer() {
  const r = { compiled: [] as THREE.Object3D[], textures: new Set<THREE.Texture>(),
    initTexture(t: THREE.Texture) { r.textures.add(t); },
    async compileAsync(o: THREE.Object3D) { r.compiled.push(o); } };
  return r;
}
const cam = new THREE.PerspectiveCamera();

describe('materialTextures', () => {
  it('lists the sampled texture slots and skips empty ones', () => {
    const a = new THREE.Texture(), b = new THREE.Texture();
    expect(materialTextures(new THREE.MeshStandardMaterial({ map: a, emissiveMap: b }))).toEqual([a, b]);
    expect(materialTextures(new THREE.MeshBasicMaterial())).toEqual([]);
  });
});

describe('Mobs.prewarm', () => {
  it('compiles one 角色074 and one 值日生 once, and the first summons reuse those very figures', async () => {
    const scene = new THREE.Scene(), mobs = new Mobs(scene), r = fakeRenderer();
    await mobs.prewarm(r as unknown as THREE.WebGLRenderer, cam);
    await mobs.prewarm(r as unknown as THREE.WebGLRenderer, cam); // level reload: no second pair
    expect(r.compiled).toHaveLength(2);
    expect(r.textures.size).toBeGreaterThan(0);
    expect(scene.children).toHaveLength(0); // off-scene until summoned
    mobs.onSnap([{ id: 1, p: [0, 0, 0], yaw: 0 }, { id: 2, p: [3, 0, 0], yaw: 0 }], 0);
    expect(mobs.byId.get(1)!.mesh).toBe(r.compiled[0]);
    expect(mobs.byId.get(2)!.mesh).toBe(r.compiled[1]);
    expect(mobs.byId.get(2)!.monitor).toBe(true);
    // a second 角色074 has no spare left: built fresh
    mobs.onSnap([{ id: 1, p: [0, 0, 0], yaw: 0 }, { id: 2, p: [3, 0, 0], yaw: 0 }, { id: 3, kind: 'warden', p: [6, 0, 0], yaw: 0 }], 50);
    expect(r.compiled).not.toContain(mobs.byId.get(3)!.mesh);
  });
});
