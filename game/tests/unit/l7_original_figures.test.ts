import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { L7_KEY_GUARD } from '../../shared/l7-key.ts';
import { MIRRORS } from '../../shared/levels/l7.ts';

// Build the actual rigs; canvas painting is the only browser facility replaced here.
const ctx2d: any = new Proxy(function () {}, { get: (_, key) => key === 'measureText' ? () => ({ width: 1 }) : ctx2d, apply: () => ctx2d, set: () => true });
vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }) });
const { L7MirrorView } = await import('../../client/src/l7-view.ts');
const { Student } = await import('../../client/src/warden/student.ts');
const { Warden, BONES } = await import('../../client/src/warden/model.ts');
const { makeMonitorMaterials } = await import('../../client/src/warden/textures.ts');
afterEach(() => vi.restoreAllMocks());

function setup() {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  const view = new L7MirrorView(scene, camera, {} as THREE.WebGLRenderer);
  const passes = (view as any).mirrors as { root: THREE.Group; avatars: { group: THREE.Group } }[];
  return { scene, view, passes };
}
const skinned = (root: THREE.Object3D) => { const meshes: THREE.SkinnedMesh[] = []; root.traverse(o => { if (o instanceof THREE.SkinnedMesh) meshes.push(o); }); return meshes; };
const geometry = (mesh: THREE.SkinnedMesh) => Array.from(mesh.geometry.getAttribute('position').array);

describe('L7 original campaign figures', () => {
  it('uses the ordinary Student body, hair and team colour for delayed and chasing reflections', () => {
    const { view, passes } = setup(), ordinary = new Student(0x3a6ab0);
    const actor = { id: 1, mirrorId: MIRRORS[0].id, p: [-80, 0, 143] as [number, number, number], yaw: 0, pitch: .2, phase: 'follow' as const, stillFor: 0, chaseLeft: 0 };
    view.update([], [actor], 1, 1);
    const mesh = skinned(passes[0].avatars.group)[0];
    expect(geometry(mesh)).toEqual(geometry(ordinary.warden.mesh));
    expect(mesh.skeleton.bones.map(b => b.name)).toEqual([...BONES]);
    expect(mesh.skeleton.bones.find(b => b.name === 'head')!.children.some(o => o instanceof THREE.Mesh)).toBe(true);
    for (const material of mesh.material as THREE.Material[]) {
      expect(material.stencilFunc).toBe(THREE.EqualStencilFunc);
      expect(material.clippingPlanes).toHaveLength(1);
    }
    view.update([], [{ ...actor, phase: 'chase' }], 1, 1.05);
    expect(skinned(passes[0].avatars.group)).toHaveLength(0);
    const chasing = skinned((view as any).avatars.group)[0];
    expect(geometry(chasing)).toEqual(geometry(ordinary.warden.mesh));
    expect((chasing.material as THREE.Material[])[0].clippingPlanes).toBeNull();
    view.dispose(); ordinary.dispose();
  });

  it('keeps an anonymous original monitor rig, independent reflected skeletons and the authoritative key window', () => {
    const { view, passes } = setup(), ordinary = new Warden(makeMonitorMaterials(), false, 'monitor');
    const duty = view.root.getObjectByName('mirror-key-duty-student')!;
    const figures = [duty, ...passes.map(pass => pass.root.getObjectByName('mirror-key-duty-student')!)];
    const meshes = figures.map(root => skinned(root)[0]);
    for (const mesh of meshes) {
      expect(geometry(mesh)).toEqual(geometry(ordinary.mesh));
      expect(mesh.skeleton.bones.map(b => b.name)).toEqual([...BONES]);
    }
    expect(new Set(meshes.map(mesh => mesh.skeleton.bones[0])).size).toBe(figures.length);
    expect(duty.getObjectByName('red-duty-armband')).toBeDefined();
    expect(duty.getObjectByName('paper-face')).toBeUndefined();
    const state = { taken: false, open: true, guard: { p: [...L7_KEY_GUARD] as [number, number, number], yaw: -.4, watched: false } };
    view.setKey(state);
    for (const root of figures) {
      expect(root.position.toArray()).toEqual(state.guard.p);
      expect(root.rotation.y).toBe(state.guard.yaw);
      expect(root.getObjectByName('mirror-back-key')!.visible).toBe(true);
      expect(root.getObjectByName('back-pocket-left-flap')!.position.x).toBe(-.22);
    }
    view.setKey({ ...state, taken: true, open: false });
    for (const root of figures) expect(root.getObjectByName('mirror-back-key')!.visible).toBe(false);
    const sharedTexture = (ordinary.mesh.material as THREE.MeshStandardMaterial[])[0].map!;
    const disposeTexture = vi.spyOn(sharedTexture, 'dispose');
    view.dispose();
    expect(disposeTexture).not.toHaveBeenCalled();
    ordinary.mesh.geometry.dispose(); ordinary.mesh.skeleton.dispose();
  });
});
