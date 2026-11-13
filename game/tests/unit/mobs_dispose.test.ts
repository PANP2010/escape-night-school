import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { MobSnap } from '../../shared/protocol.ts';

const ctx2d: any = new Proxy(function () {}, { get: (_, k) => (k === 'measureText' ? () => ({ width: 1 }) : ctx2d), apply: () => ctx2d, set: () => true });
vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }) });
const { Mobs, materialTextures } = await import('../../client/src/mobs.ts');
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('removed mob GPU resources', () => {
  it('disposes only the removed figure geometry and skeleton, retaining monitor caches for later figures', () => {
    const scene = new THREE.Scene(), mobs = new Mobs(scene);
    const warden: MobSnap = { id: 1, p: [0, 0, 0], yaw: 0 }, monitor: MobSnap = { id: 2, p: [3, 0, 0], yaw: 0 };
    mobs.onSnap([warden, monitor], 0);
    const active = mobs.byId.get(1)!, removed = mobs.byId.get(2)!;
    const activeGeometryDispose = vi.spyOn(active.warden.mesh.geometry, 'dispose'), activeSkeletonDispose = vi.spyOn(active.warden.mesh.skeleton, 'dispose');
    const geometryDispose = vi.spyOn(removed.warden.mesh.geometry, 'dispose'), skeletonDispose = vi.spyOn(removed.warden.mesh.skeleton, 'dispose');
    removed.warden.mesh.skeleton.computeBoneTexture();
    const boneTextureDispose = vi.spyOn(removed.warden.mesh.skeleton.boneTexture!, 'dispose');
    const band = removed.warden.bones.upperArmL.children.find((o): o is THREE.Mesh => o instanceof THREE.Mesh)!;
    const materials = removed.warden.mesh.material as THREE.Material[];
    const shared = new Set<{ dispose(): void }>([band.geometry, band.material as THREE.Material, ...materials, ...materials.flatMap(materialTextures)]);
    const sharedDisposals = [...shared].map((r) => vi.spyOn(r, 'dispose'));
    mobs.onSnap([warden], 50); mobs.onSnap([warden], 100);
    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(skeletonDispose).toHaveBeenCalledOnce();
    expect(boneTextureDispose).toHaveBeenCalledOnce();
    expect(removed.mesh.parent).toBeNull();
    expect(mobs.byId.has(2)).toBe(false);
    expect(active.mesh.parent).toBe(scene);
    expect(activeGeometryDispose).not.toHaveBeenCalled();
    expect(activeSkeletonDispose).not.toHaveBeenCalled();
    mobs.onSnap([warden, monitor], 150);
    const next = mobs.byId.get(2)!, nextBand = next.warden.bones.upperArmL.children.find((o): o is THREE.Mesh => o instanceof THREE.Mesh)!;
    expect(next.warden.mesh.geometry).not.toBe(removed.warden.mesh.geometry);
    expect(next.warden.mesh.skeleton).not.toBe(removed.warden.mesh.skeleton);
    expect(next.warden.mesh.material).toBe(materials);
    expect(nextBand.geometry).toBe(band.geometry);
    expect(nextBand.material).toBe(band.material);
    for (const dispose of sharedDisposals) expect(dispose).not.toHaveBeenCalled();
  });
});
