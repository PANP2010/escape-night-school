import { afterEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { Mobs } from '../../client/src/mobs.ts';

const ctx: any = new Proxy(function () {}, { get: (_target, key) => key === 'measureText' ? () => ({ width: 1 }) : ctx, apply: () => ctx, set: () => true });
afterEach(() => vi.unstubAllGlobals());
it('keeps 角色078 black clothes and bone-following hood/mask isolated, retains the actual name, and disposes them', () => {
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) });
  const mobs = new Mobs(new THREE.Scene());
  const snaps = ['角色078', '角色117'].map((name, i) => ({ id: i + 2, name, p: [i * 3, 0, -3] as [number, number, number], yaw: 0, anim: 'idle' }));
  mobs.onSnap(snaps, 0);
  const a = mobs.byId.get(2)!, b = mobs.byId.get(3)!, outfit = a.outfit!;
  expect(a.displayName).toBe('角色078'); expect(a.namedFace!.name).toBe('角色078'); expect(a.nameTag!.text).toBe('角色078'); expect(b.outfit).toBeUndefined();
  for (const index of [2, 3, 9]) {
    const black = (a.warden.mesh.material as THREE.MeshStandardMaterial[])[index], normal = (b.warden.mesh.material as THREE.MeshStandardMaterial[])[index];
    expect(Math.max(black.color.r, black.color.g, black.color.b)).toBeLessThan(.04);
    expect(normal.color.r).toBeGreaterThan(.5); expect(black).not.toBe(normal);
  }
  expect(outfit.hood.parent).toBe(a.warden.bones.head); expect(outfit.mask.parent).toBe(a.warden.bones.head);
  a.mesh.updateMatrixWorld(true); const before = outfit.mask.getWorldQuaternion(new THREE.Quaternion());
  a.warden.bones.head.rotation.y = .3; a.mesh.updateMatrixWorld(true);
  expect(outfit.mask.getWorldQuaternion(new THREE.Quaternion()).angleTo(before)).toBeGreaterThan(.29);
  const texture = a.namedFace!.texture;
  mobs.onSnap(snaps.map(({ name: _name, ...delta }) => delta), 50);
  expect(a.outfit).toBe(outfit); expect(a.namedFace!.texture).toBe(texture);
  const hood = vi.spyOn(outfit.hood.geometry, 'dispose'), mask = vi.spyOn(outfit.mask.geometry, 'dispose');
  mobs.onSnap([snaps[1]], 100);
  expect(hood).toHaveBeenCalledOnce(); expect(mask).toHaveBeenCalledOnce(); expect(outfit.hood.parent).toBeNull();
});
