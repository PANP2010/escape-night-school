import * as THREE from 'three';
import { beamHit, type BeamHit } from '../../shared/campus/nav.ts';
import type { CollisionWorld } from '../../shared/campus/collision.ts';
import { floorStack, type BuildingDef } from '../../shared/campus/campus_schema.ts';
import type { HideSpotDef } from '../../shared/levels/def.ts';
import type { Vec3 } from '../../shared/protocol.ts';
import { furnitureGeometry, storeyFurniture, type FurnBox } from './campus/world/classroom.ts';

export const HIGHLIGHT_REACH = 4;
const CELL = 4, SCAN_MS = 100;

/** The source stays authoritative: an instanced door uses its current leaf matrix. */
export interface HighlightSource { object: THREE.Object3D; instanceId?: number; ownedGeometry?: boolean }
export interface HighlightTarget {
  key: string;
  position: Vec3;
  floorY: number;
  sources: readonly HighlightSource[] | (() => readonly HighlightSource[]);
  enabled?: () => boolean;
  /** Merged desk colliders include the taller chair; sample just above that conservative collider. */
  occlusionLift?: number;
}
interface Part { source: THREE.Mesh; instanceId?: number; overlay: THREE.Mesh; ownedGeometry: boolean }
interface Entry { target: HighlightTarget; parts?: Part[]; bounds: THREE.Box3 }

/** One slow, continuous breath; neither a flashing beacon nor dependent on frame rate. */
export function highlightOpacity(now: number): number {
  return 0.16 + 0.19 * (0.5 - 0.5 * Math.cos(now * Math.PI * 2 / 2200));
}

/**
 * Cache only registered interactables in spatial cells. Visibility scans run at 10 Hz; frames update only the
 * visible sources' transforms and one shared opacity. The extra pass uses the original geometry with depth
 * testing, never mutates source materials and cannot draw through a rendered wall.
 */
export class InteractionHighlight {
  private readonly material = new THREE.MeshBasicMaterial({ color: 0x98ead3, transparent: true, opacity: 0.2,
    blending: THREE.AdditiveBlending, depthTest: true, depthWrite: false, polygonOffset: true,
    polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  private readonly groups = new Map<string, Entry[]>();
  private readonly cells = new Map<string, Entry[]>();
  private readonly candidates = new Set<Entry>();
  private readonly active: Entry[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly bounds = new THREE.Box3();
  private readonly point = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly hit: BeamHit = { t: 0, nx: 0, ny: 0, nz: 0 };
  private nextScan = 0;
  private disposed = false;
  private enabled = true;
  private readonly scene: THREE.Scene;

  constructor(scene: THREE.Scene) { this.scene = scene; }

  /** User preference persists while groups, chapters and network state change. */
  setEnabled(enabled: boolean) {
    if (this.disposed) return;
    this.enabled = enabled;
    if (!enabled) this.hide();
    this.nextScan = 0;
  }

  /** Replacing pickups does not rebuild the level's cached furniture/door overlays. */
  setGroup(group: string, targets: readonly HighlightTarget[]) {
    if (this.disposed) return;
    for (const entry of this.groups.get(group) ?? []) this.release(entry);
    this.groups.set(group, targets.map(target => ({ target, bounds: new THREE.Box3() })));
    this.cells.clear();
    for (const entries of this.groups.values()) for (const entry of entries) {
      const p = entry.target.position, key = this.cellKey(Math.floor(p[0] / CELL), Math.floor(p[2] / CELL));
      (this.cells.get(key) ?? this.cells.set(key, []).get(key)!).push(entry);
    }
    this.hide();
    this.nextScan = 0;
  }

  update(now: number, eye: THREE.Vector3, floorY: number, world: CollisionWorld, enabled = true) {
    if (this.disposed) return;
    if (!this.enabled || !enabled) { this.hide(); this.nextScan = 0; return; }
    this.material.opacity = highlightOpacity(now);
    if (now >= this.nextScan) {
      this.nextScan = now + SCAN_MS;
      this.hide();
      this.candidates.clear();
      const cx = Math.floor(eye.x / CELL), cz = Math.floor(eye.z / CELL);
      // Two cells also cover a swung leaf or a cabinet whose anchor is near the edge of its geometry.
      for (let x = cx - 2; x <= cx + 2; x++) for (let z = cz - 2; z <= cz + 2; z++)
        for (const entry of this.cells.get(this.cellKey(x, z)) ?? []) this.candidates.add(entry);
      for (const entry of this.candidates) {
        const target = entry.target;
        if (Math.abs(target.floorY - floorY) >= 1.5 || target.enabled?.() === false) continue;
        // Avoid even constructing geometry for distant registered targets in the surrounding grid cells.
        if (Math.hypot(target.position[0] - eye.x, target.position[2] - eye.z) > HIGHLIGHT_REACH + 2) continue;
        this.prepare(entry);
        this.sync(entry);
        if (entry.bounds.isEmpty() || entry.bounds.distanceToPoint(eye) > HIGHLIGHT_REACH) continue;
        entry.bounds.clampPoint(eye, this.point);
        this.point.y += target.occlusionLift ?? 0;
        this.direction.subVectors(this.point, eye);
        const distance = this.direction.length();
        if (distance > 0.08 && beamHit(world, eye, this.direction.divideScalar(distance), distance - 0.06, this.hit)) continue;
        for (const part of entry.parts!) part.overlay.visible = true;
        this.active.push(entry);
      }
    }
    for (const entry of this.active) this.sync(entry);
  }

  /** Debug/e2e inspection allocates only when explicitly requested, outside the render path. */
  snapshot() {
    let registered = 0;
    for (const entries of this.groups.values()) registered += entries.length;
    return { registered, active: this.active.map(entry => ({ key: entry.target.key, opacity: this.material.opacity })) };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const entries of this.groups.values()) for (const entry of entries) this.release(entry);
    this.groups.clear(); this.cells.clear(); this.candidates.clear(); this.active.length = 0;
    this.material.dispose();
  }

  private cellKey(x: number, z: number) { return `${x},${z}`; }
  private hide() {
    for (const entry of this.active) for (const part of entry.parts ?? []) part.overlay.visible = false;
    this.active.length = 0;
  }
  private prepare(entry: Entry) {
    if (entry.parts) return;
    entry.parts = [];
    const sources = typeof entry.target.sources === 'function' ? entry.target.sources() : entry.target.sources;
    for (const source of sources) source.object.traverse(object => {
      if (!(object instanceof THREE.Mesh) || !object.geometry.getAttribute('position')?.count) return;
      const overlay = new THREE.Mesh(object.geometry, this.material);
      overlay.name = `interaction-highlight:${entry.target.key}`;
      overlay.matrixAutoUpdate = false;
      overlay.visible = false;
      // A single instance's geometry is reused in an ordinary mesh, with only that instance's matrix.
      entry.parts!.push({ source: object, instanceId: source.instanceId, overlay, ownedGeometry: !!source.ownedGeometry });
      this.scene.add(overlay);
    });
  }
  private sync(entry: Entry) {
    entry.bounds.makeEmpty();
    for (const part of entry.parts!) {
      const source = part.source;
      source.updateWorldMatrix(true, false);
      part.overlay.matrix.copy(source.matrixWorld);
      if (source instanceof THREE.InstancedMesh && part.instanceId !== undefined) {
        source.getMatrixAt(part.instanceId, this.matrix);
        part.overlay.matrix.multiply(this.matrix);
      }
      part.overlay.matrixWorldNeedsUpdate = true;
      if (!source.geometry.boundingBox) source.geometry.computeBoundingBox();
      this.bounds.copy(source.geometry.boundingBox!).applyMatrix4(part.overlay.matrix);
      entry.bounds.union(this.bounds);
    }
  }
  private release(entry: Entry) {
    for (const part of entry.parts ?? []) {
      this.scene.remove(part.overlay);
      if (part.ownedGeometry) part.source.geometry.dispose();
    }
  }
}

/**
 * Campus desks/cabinets are merged and may release CPU vertex arrays after upload. Select their small render
 * boxes from the same furniture definition once per level, and lazily rebuild only those exact surfaces.
 */
export function furnitureHighlightTargets(building: BuildingDef, hides: readonly HideSpotDef[], defaultFloorY = 0): HighlightTarget[] {
  const floors = new Map<number, FurnBox[]>();
  return hides.flatMap((hide, id): HighlightTarget[] => {
    if (hide.kind === 'booth') return [];
    const y = hide.y ?? defaultFloorY, floor = floorStack(building).find(floor => Math.abs(floor.y - y) < 0.1);
    if (!floor) return [];
    let boxes = floors.get(floor.level);
    if (!boxes) { boxes = storeyFurniture(building, floor.level).render; floors.set(floor.level, boxes); }
    const x = hide.x - building.x, z = hide.z - building.z;
    const body = boxes.filter(box => box.kind === (hide.kind === 'desk' ? 'wood' : 'locker')
      && (hide.kind !== 'desk' || Math.abs(box.y1 - y - 0.76) < 0.02)
      && Math.abs((box.x0 + box.x1) / 2 - x) < 0.12 && Math.abs((box.z0 + box.z1) / 2 - z) < 0.12);
    if (!body.length) return [];
    const minX = Math.min(...body.map(box => box.x0)), maxX = Math.max(...body.map(box => box.x1));
    const minZ = Math.min(...body.map(box => box.z0)), maxZ = Math.max(...body.map(box => box.z1));
    const parts = boxes.filter(box => (hide.kind === 'desk' ? box.kind === 'wood' || box.kind === 'steel' : box.kind === 'locker' || box.kind === 'mouth')
      && box.y0 >= y - 0.01 && box.y1 <= y + 0.86
      && (box.x0 + box.x1) / 2 >= minX - 0.025 && (box.x0 + box.x1) / 2 <= maxX + 0.025
      && (box.z0 + box.z1) / 2 >= minZ - 0.025 && (box.z0 + box.z1) / 2 <= maxZ + 0.025);
    return [{ key: `hide:${id}`, position: [hide.x, y + 0.4, hide.z], floorY: y, occlusionLift: hide.kind === 'desk' ? 0.12 : 0.03,
      sources: () => [{ object: new THREE.Mesh(furnitureGeometry(building, parts), []), ownedGeometry: true }] }];
  });
}
