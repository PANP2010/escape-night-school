import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { InteractionHighlight, furnitureHighlightTargets, highlightOpacity, type HighlightTarget } from '../../client/src/interactionHighlight.ts';
import { CollisionWorld, box } from '../../shared/campus/collision.ts';
import { CAMPUS } from '../../client/src/campus/world/campus.ts';
import { interiorColliders } from '../../client/src/campus/world/interior.ts';
import { storeyRooms } from '../../client/src/campus/world/rooms.ts';
import { L1 } from '../../shared/levels/l1.ts';
import { L2 } from '../../shared/levels/l2.ts';

function fixture() {
  const scene = new THREE.Scene(), highlight = new InteractionHighlight(scene);
  const material = new THREE.MeshLambertMaterial({ color: 0x987623, emissive: 0x302010 });
  const object = new THREE.Mesh(new THREE.BoxGeometry(.2, .2, .2), material);
  object.position.set(0, 1, -2); scene.add(object);
  const target: HighlightTarget = { key: 'pick:7', position: [0, 1, -2], floorY: 0, sources: [{ object }] };
  highlight.setGroup('items', [target]);
  return { scene, highlight, material, object, target, eye: new THREE.Vector3(0, 1, 0), world: new CollisionWorld() };
}

describe('nearby interaction highlights', () => {
  it('breathes continuously and only shows a real surface within four metres on the same floor', () => {
    expect(highlightOpacity(0)).toBeCloseTo(.16);
    expect(highlightOpacity(1100)).toBeCloseTo(.35);
    expect(highlightOpacity(2200)).toBeCloseTo(.16);
    const f = fixture();
    f.highlight.update(0, f.eye.set(0, 1, 2.09), 0, f.world);
    expect(f.highlight.snapshot().active.map(a => a.key)).toEqual(['pick:7']);
    f.highlight.update(1100, f.eye, 0, f.world);
    expect(f.highlight.snapshot().active[0].opacity).toBeCloseTo(.35);
    f.highlight.update(1200, f.eye.set(0, 1, 2.11), 0, f.world);
    expect(f.highlight.snapshot().active).toEqual([]);
    f.highlight.update(1300, f.eye.set(0, 1, 0), 3.6, f.world);
    expect(f.highlight.snapshot().active).toEqual([]);
    f.highlight.dispose();
  });

  it('turns active overlays off immediately and preserves the opt-out when chapter groups are rebuilt', () => {
    const f = fixture();
    f.highlight.update(0, f.eye, 0, f.world);
    expect(f.highlight.snapshot().active).toHaveLength(1);
    const overlay = f.scene.getObjectByName('interaction-highlight:pick:7')!;
    f.highlight.setEnabled(false);
    expect(overlay.visible).toBe(false);
    expect(f.highlight.snapshot().active).toEqual([]);
    f.highlight.setGroup('items', [f.target]);
    f.highlight.update(1000, f.eye, 0, f.world, true);
    expect(f.highlight.snapshot().active).toEqual([]);
    f.highlight.setEnabled(true);
    f.highlight.update(1001, f.eye, 0, f.world);
    expect(f.highlight.snapshot().active).toHaveLength(1);
    f.highlight.dispose();
  });

  it('rejects a wall and keeps GPU depth testing enabled for partial occlusion', () => {
    const f = fixture(), wall = new CollisionWorld([box(0, -1, 3, .2, 3)]);
    f.highlight.update(0, f.eye, 0, wall);
    expect(f.highlight.snapshot().active).toEqual([]);
    f.highlight.update(100, f.eye, 0, f.world);
    expect(f.highlight.snapshot().active).toHaveLength(1);
    const overlay = f.scene.getObjectByName('interaction-highlight:pick:7') as THREE.Mesh;
    const material = overlay.material as THREE.Material;
    expect(material.depthTest).toBe(true);
    expect(material.depthWrite).toBe(false);
    f.highlight.dispose();
  });

  it('finds a corridor battery from along the corridor, while rejecting a view across its classroom wall', () => {
    const f = fixture(), building = CAMPUS.buildings.find(building => building.id === L1.building)!;
    const world = new CollisionWorld(interiorColliders(building));
    const spots = L1.items.find(item => item.kind === 'battery')!.spots;
    f.object.geometry.dispose();
    f.object.geometry = new THREE.BoxGeometry(.06, .14, .06);
    for (const spot of spots) {
      const y = spot.y ?? L1.exit.y;
      f.object.position.set(spot.x, y + .07, spot.z);
      f.highlight.setGroup('items', [{ key: 'pick:7', position: [spot.x, y, spot.z], floorY: y, sources: [{ object: f.object }] }]);
      f.highlight.update(0, f.eye.set(spot.x + 2, y + 1.2, spot.z), y, world);
      expect(f.highlight.snapshot().active.map(entry => entry.key), JSON.stringify(spot)).toEqual(['pick:7']);
      if (spot === spots[0]) {
        f.highlight.update(100, f.eye.set(spot.x, y + 1.2, spot.z + 2), y, world);
        expect(f.highlight.snapshot().active).toEqual([]);
      }
    }
    f.highlight.dispose();
    f.object.geometry.dispose();
  });

  it('preserves shared source materials and geometry across replacement and teardown', () => {
    const f = fixture(), color = f.material.color.clone(), emissive = f.material.emissive.clone();
    const dispose = vi.spyOn(f.object.geometry, 'dispose');
    f.highlight.update(0, f.eye, 0, f.world);
    f.highlight.update(1100, f.eye, 0, f.world);
    expect(f.object.material).toBe(f.material);
    expect(f.material.color.equals(color)).toBe(true);
    expect(f.material.emissive.equals(emissive)).toBe(true);
    f.highlight.setGroup('items', []);
    expect(f.scene.getObjectByName('interaction-highlight:pick:7')).toBeUndefined();
    expect(f.highlight.snapshot()).toEqual({ registered: 0, active: [] });
    f.highlight.dispose(); f.highlight.dispose();
    expect(dispose).not.toHaveBeenCalled();
  });

  it('retains cached furniture when a pickup disappears and releases owned geometry once at teardown', () => {
    const f = fixture(), geometry = new THREE.BoxGeometry(.6, .7, .4), dispose = vi.spyOn(geometry, 'dispose');
    const object = new THREE.Mesh(geometry, f.material); object.position.set(1, .5, -2);
    const build = vi.fn(() => [{ object, ownedGeometry: true }]);
    f.highlight.setGroup('level', [{ key: 'hide:0', position: [1, .5, -2], floorY: 0, sources: build }]);
    f.highlight.update(0, f.eye, 0, f.world);
    const overlay = f.scene.getObjectByName('interaction-highlight:hide:0');
    expect(f.highlight.snapshot().active.map(entry => entry.key)).toEqual(['pick:7', 'hide:0']);
    f.highlight.setGroup('items', []);
    expect(f.scene.getObjectByName('interaction-highlight:pick:7')).toBeUndefined();
    f.highlight.update(1, f.eye, 0, f.world);
    expect(f.highlight.snapshot().active.map(entry => entry.key)).toEqual(['hide:0']);
    expect(f.scene.getObjectByName('interaction-highlight:hide:0')).toBe(overlay);
    expect(build).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
    f.highlight.dispose(); f.highlight.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(f.scene.getObjectByName('interaction-highlight:hide:0')).toBeUndefined();
  });

  it('shows a real desk top despite the conservative collider that also contains its taller chair', () => {
    const f = fixture(), desk = new THREE.Mesh(new THREE.BoxGeometry(.6, .18, .42), f.material);
    desk.position.set(0, .67, -2);
    f.highlight.setGroup('items', [{ key: 'hide:1', position: [0, .4, -2], floorY: 0,
      occlusionLift: .12, sources: [{ object: desk }] }]);
    const furniture = new CollisionWorld([box(0, -2, 1.2, 1.2, .85)]);
    f.highlight.update(0, f.eye.set(0, 1.6, 0), 0, furniture);
    expect(f.highlight.snapshot().active.map(a => a.key)).toEqual(['hide:1']);
    const wall = box(0, -.6, 3, .2, 3); furniture.add(wall);
    f.highlight.update(100, f.eye, 0, furniture);
    expect(f.highlight.snapshot().active).toEqual([]);
    f.highlight.dispose();
  });

  it('tracks only the selected door instance while the real leaf swings between visibility scans', () => {
    const f = fixture(), door = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 2, .1), f.material, 2);
    door.setMatrixAt(0, new THREE.Matrix4().makeTranslation(30, 1, -2));
    door.setMatrixAt(1, new THREE.Matrix4().makeTranslation(0, 1, -2));
    f.highlight.setGroup('items', [{ key: 'use:1', position: [0, 1, -2], floorY: 0, sources: [{ object: door, instanceId: 1 }] }]);
    f.highlight.update(0, f.eye, 0, f.world);
    const overlay = f.scene.getObjectByName('interaction-highlight:use:1') as THREE.Mesh;
    expect(overlay.geometry).toBe(door.geometry);
    expect(overlay.matrix.elements[12]).toBe(0);
    const swung = new THREE.Matrix4().makeRotationY(.8).setPosition(.6, 1, -2);
    door.setMatrixAt(1, swung);
    f.highlight.update(50, f.eye, 0, f.world);
    const stored = new THREE.Matrix4(); door.getMatrixAt(1, stored);
    expect(overlay.matrix.elements).toEqual(stored.elements);
    f.highlight.dispose();
  });

  it('lazily builds nearby targets and immediately clears disabled presentation', () => {
    const f = fixture(), build = vi.fn(() => [{ object: f.object }]);
    f.highlight.setGroup('level', Array.from({ length: 400 }, (_, i) => ({ key: `hide:${i}`, position: [100 + i, 0, 100] as [number, number, number], floorY: 0, sources: build })));
    f.highlight.update(0, f.eye, 0, f.world);
    expect(build).not.toHaveBeenCalled();
    f.highlight.update(0, f.eye, 0, f.world, false);
    expect(f.highlight.snapshot().active).toEqual([]);
    f.highlight.dispose();
  });
});

describe('actual merged furniture surfaces', () => {
  it('shows native L1/L2 desks and lockers with their real conservative colliders present', () => {
    const f = fixture();
    f.highlight.setGroup('items', []);
    for (const level of [L1, L2]) {
      const building = CAMPUS.buildings.find(building => building.id === level.building)!;
      const targets = furnitureHighlightTargets(building, level.hides, level.exit.y);
      const world = new CollisionWorld(interiorColliders(building));
      const rooms = storeyRooms(building, level.floors[0]);
      for (const kind of ['locker', 'desk']) {
        const id = level.hides.findIndex(hide => hide.kind === kind), target = targets.find(target => target.key === `hide:${id}`)!;
        const room = rooms.find(room => room.kind === 'classroom'
          && Math.abs(target.position[0] - building.x - room.x) <= room.w / 2
          && Math.abs(target.position[2] - building.z - room.z) <= room.d / 2)!;
        const inward = new THREE.Vector3(building.x + room.x - target.position[0], 0, building.z + room.z - target.position[2]).normalize();
        f.eye.set(target.position[0], target.floorY + 1.6, target.position[2]).addScaledVector(inward, 1.5);
        f.highlight.setGroup('level', [target]);
        f.highlight.update(0, f.eye, target.floorY, world);
        expect(f.highlight.snapshot().active.map(entry => entry.key), `${level.name} ${kind}`).toEqual([target.key]);
        f.highlight.update(100, f.eye, target.floorY + 3.6, world);
        expect(f.highlight.snapshot().active).toEqual([]);
      }
    }
    f.highlight.dispose();
  });

  it('matches the L1/L2 hiding places to native furniture, including L2 default floor height', () => {
    for (const level of [L1, L2]) {
      const building = CAMPUS.buildings.find(b => b.id === level.building)!;
      const targets = furnitureHighlightTargets(building, level.hides, level.exit.y);
      expect(targets.length).toBe(level.hides.length);
      expect(targets.every(target => target.floorY === level.exit.y)).toBe(true);
      for (const kind of ['locker', 'desk']) {
        const id = level.hides.findIndex(hide => hide.kind === kind);
        const target = targets.find(target => target.key === `hide:${id}`)!;
        const sources = typeof target.sources === 'function' ? target.sources() : target.sources;
        const mesh = sources[0].object as THREE.Mesh;
        mesh.geometry.computeBoundingBox();
        const bounds = mesh.geometry.boundingBox!;
        expect(bounds.min.y).toBeGreaterThanOrEqual(level.exit.y - .01);
        expect(bounds.max.y).toBeLessThan(level.exit.y + .87);
        expect(bounds.getSize(new THREE.Vector3()).length()).toBeLessThan(1.5);
        mesh.geometry.dispose();
      }
    }
  });
});
