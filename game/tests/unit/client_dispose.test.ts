import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { Game } from '../../client/src/game.ts';
import { generateLevel } from '../../shared/level.ts';
import { L1 } from '../../shared/levels/l1.ts';
import type { WorldItem } from '../../shared/protocol.ts';

const ctx2d: any = new Proxy(function () {}, { get: (_, k) => (k === 'measureText' ? () => ({ width: 1 }) : ctx2d), apply: () => ctx2d, set: () => true });
beforeEach(() => vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }) }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** Exercise the real resource owners without constructing a renderer or the campus. */
function game() {
  return Object.assign(Object.create(Game.prototype), {
    scene: new THREE.Scene(), level: generateLevel(1, 42),
    campus: { collision: { add: vi.fn().mockReturnValue(0), move: vi.fn() } },
    blackoutObjs: [], barrierObjs: [], barrierIds: [],
    items: [], itemMeshes: new Map<number, THREE.Object3D>(),
    interactionHighlight: { setGroup: vi.fn() },
    itemMat: { key: new THREE.MeshBasicMaterial(), battery: new THREE.MeshBasicMaterial(), fuse: new THREE.MeshBasicMaterial(),
      drawer: new THREE.MeshBasicMaterial(), metal: new THREE.MeshBasicMaterial(), decoy: new THREE.MeshBasicMaterial() },
  }) as any;
}

function watchProps(roots: THREE.Object3D[], sharedMaterials = new Set<THREE.Material>()) {
  const resources = new Set<{ dispose(): void }>();
  for (const root of roots) root.traverse((o) => {
    if (o instanceof THREE.Mesh) resources.add(o.geometry);
    if (o instanceof THREE.Mesh || o instanceof THREE.Sprite) {
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (sharedMaterials.has(m)) continue;
        resources.add(m);
        const map = (m as THREE.MeshBasicMaterial).map;
        if (map) resources.add(map);
      }
    }
  });
  return [...resources].map((r) => vi.spyOn(r, 'dispose'));
}

describe('client GPU resource ownership', () => {
  it('disposes replaced and picked-up item geometry once while retaining shared materials', () => {
    const g = game(), items: WorldItem[] = [
      { id: 1, kind: 'stair_key', p: [0, 0, 0] },
      { id: 2, kind: 'battery', p: [1, 0, 0] },
      { id: 3, kind: 'fuse', p: [2, 0, 0] },
    ];
    g.level = generateLevel(0, 42); // exercise the new drawer's owned label material and texture too
    const materialDisposals = Object.values(g.itemMat as Record<string, THREE.Material>).map((m) => vi.spyOn(m, 'dispose'));
    const sharedMaterials = new Set(Object.values(g.itemMat as Record<string, THREE.Material>));
    const unrelated = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    g.scene.add(unrelated);
    const unrelatedDispose = vi.spyOn(unrelated.geometry, 'dispose');
    g.showItems(items);
    const old = [...g.itemMeshes.values()] as THREE.Object3D[], oldDispose = old.map((m) => watchProps([m], sharedMaterials));
    for (const resources of oldDispose) expect(resources.length).toBeGreaterThan(0);
    g.showItems(items); // same-seed restart still sends the complete item list
    for (const resources of oldDispose) for (const dispose of resources) expect(dispose).toHaveBeenCalledOnce();
    for (const mesh of old) expect(mesh.parent).toBeNull();
    const current = [...g.itemMeshes.values()] as THREE.Object3D[], currentDispose = current.map((m) => watchProps([m], sharedMaterials));
    for (const resources of currentDispose) for (const dispose of resources) expect(dispose).not.toHaveBeenCalled();
    g.dropItems([2, 2, 99]);
    for (const dispose of currentDispose[1]) expect(dispose).toHaveBeenCalledOnce();
    for (const index of [0, 2]) for (const dispose of currentDispose[index]) expect(dispose).not.toHaveBeenCalled();
    expect(g.items.map((it: WorldItem) => it.id)).toEqual([1, 3]);
    g.showItems([]); g.showItems([]); g.dropItems([1, 2, 3]);
    for (const resources of currentDispose) for (const dispose of resources) expect(dispose).toHaveBeenCalledOnce();
    for (const dispose of materialDisposals) expect(dispose).not.toHaveBeenCalled();
    expect(unrelatedDispose).not.toHaveBeenCalled();
    expect(g.scene.children).toEqual([unrelated]);
  });

  it('clears blackout props once, including materials and maps shared by emergency signs', () => {
    const g = game();
    g.buildBlackout();
    const old = [...g.blackoutObjs] as THREE.Object3D[], lamp = g.fuseLamp;
    const signs = old.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh);
    expect(signs).toHaveLength(2);
    expect((signs[0].material as THREE.Material[])[5]).toBe((signs[1].material as THREE.Material[])[5]);
    expect((signs[0].material as THREE.Material[])[0]).toBe((signs[0].material as THREE.Material[])[1]);
    const disposals = watchProps(old);
    g.level = { ...g.level, def: L1 };
    g.buildBlackout(); g.buildBlackout();
    expect(disposals.length).toBeGreaterThan(0);
    for (const dispose of disposals) expect(dispose).toHaveBeenCalledOnce();
    for (const root of old) expect(root.parent).toBeNull();
    expect(lamp.parent).not.toBe(g.scene);
    expect(g.fuseLamp).toBeUndefined();
    expect(g.blackoutObjs).toEqual([]);
    expect(g.campus.blackout).toBe(false);
    expect(g.campus.dark).toBe(false);
  });

  it('clears barrier trees and cloned light pools once, preserving global sprite geometry and other scene resources', () => {
    const g = game(), unrelatedMap = new THREE.Texture();
    const unrelated = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ map: unrelatedMap }));
    g.scene.add(unrelated);
    const unrelatedDisposals = watchProps([unrelated]);
    g.buildBarriers();
    const old = [...g.barrierObjs] as THREE.Object3D[], ids = [...g.barrierIds];
    const lit = old[g.level.def.barriers.length + g.level.def.landmarks.findIndex((m: { kind: string }) => m.kind === 'lit')];
    const pools = lit.children.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh && o.geometry.type === 'PlaneGeometry');
    expect(pools).toHaveLength(2);
    expect(pools[0].geometry).toBe(pools[1].geometry);
    expect(pools[0].material).toBe(pools[1].material);
    const halo = lit.children.find((o): o is THREE.Sprite => o instanceof THREE.Sprite)!;
    const spriteGeometryDispose = vi.spyOn(halo.geometry, 'dispose');
    const disposals = watchProps(old);
    g.level = { ...g.level, def: { ...L1, barriers: [], landmarks: [] } };
    g.buildBarriers(); g.buildBarriers();
    for (const dispose of disposals) expect(dispose).toHaveBeenCalledOnce();
    for (const root of old) expect(root.parent).toBeNull();
    expect(spriteGeometryDispose).not.toHaveBeenCalled();
    for (const dispose of unrelatedDisposals) expect(dispose).not.toHaveBeenCalled();
    expect(g.barrierObjs).toEqual([]);
    expect(g.barrierIds).toEqual(ids);
    expect(g.campus.collision.add).toHaveBeenCalledTimes(ids.length);
    expect(g.campus.collision.move).toHaveBeenCalledTimes(ids.length * 2);
    expect(g.scene.children).toEqual([unrelated]);
  });
});
