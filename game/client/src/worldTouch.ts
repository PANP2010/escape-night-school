import * as THREE from 'three';
import { beamHit } from '../../shared/campus/nav.ts';
import type { CollisionWorld } from '../../shared/campus/collision.ts';
import { dirToFrame, inReach, rayBox, toFrame, type Cand } from '../../shared/interact.ts';
import type { Vec3 } from '../../shared/protocol.ts';

export type WorldTouchPhase = 'start' | 'tap' | 'hold' | 'release';
export const TOUCH_DRAG_PX = 10;
export const TOUCH_HOLD_MS = 350;
export const TOUCH_TAP_MS = 320;

/** A finger keeps its identity and intent until release; crossing the threshold is irreversible. */
export class TouchIntent {
  private startX = 0;
  private startY = 0;
  private started = 0;
  private blocked = false;
  dragging = false;
  held = false;
  begin(x: number, y: number, now: number) {
    this.startX = x; this.startY = y; this.started = now;
    this.blocked = this.dragging = this.held = false;
  }
  move(x: number, y: number): boolean {
    if (Math.hypot(x - this.startX, y - this.startY) >= TOUCH_DRAG_PX) this.dragging = true;
    return this.dragging;
  }
  suppress() { this.blocked = true; }
  hold(now: number): boolean {
    if (this.blocked || this.dragging || this.held || now - this.started < TOUCH_HOLD_MS) return false;
    return this.held = true;
  }
  tap(now: number): boolean { return !this.blocked && !this.dragging && !this.held && now - this.started <= TOUCH_TAP_MS; }
}

export interface TouchMesh { object: THREE.Object3D; target: Cand | ((instance: number | undefined) => Cand | null); radius?: number }
export interface TouchHit { target: Cand; point: THREE.Vector3; distance: number }

/** Raycast rendered leaves/items, with a 44 px minimum selection disc for tiny pickups. */
export function worldTouchHit(camera: THREE.PerspectiveCamera, rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  x: number, y: number, meshes: readonly TouchMesh[], boxes: readonly Cand[] = []): TouchHit | null {
  if (!rect.width || !rect.height || x < rect.left || y < rect.top || x > rect.left + rect.width || y > rect.top + rect.height) return null;
  camera.updateMatrixWorld();
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2((x - rect.left) / rect.width * 2 - 1, 1 - (y - rect.top) / rect.height * 2), camera);
  ray.far = 25;
  const hits: TouchHit[] = [];
  for (const entry of meshes) {
    entry.object.updateWorldMatrix(true, true);
    const hit = ray.intersectObject(entry.object, true)[0];
    const target = typeof entry.target === 'function' ? entry.target(hit?.instanceId) : entry.target;
    if (hit && target) hits.push({ target, point: hit.point, distance: hit.distance });
    else if (entry.radius && target) {
      const centre = new THREE.Box3().setFromObject(entry.object).getCenter(new THREE.Vector3());
      const p = centre.clone().project(camera);
      const sx = rect.left + (p.x + 1) * rect.width / 2, sy = rect.top + (1 - p.y) * rect.height / 2;
      if (p.z > -1 && p.z < 1 && Math.hypot(sx - x, sy - y) <= entry.radius)
        hits.push({ target, point: centre, distance: centre.distanceTo(camera.position) });
    }
  }
  const eye = camera.position.toArray() as Vec3, direction = ray.ray.direction.toArray() as Vec3;
  for (const target of boxes) {
    const t = target.frame ? rayBox(toFrame(target.frame, eye), dirToFrame(target.frame, direction), target.min, target.max)
      : rayBox(eye, direction, target.min, target.max);
    if (t !== null && t <= ray.far) hits.push({ target, distance: t, point: ray.ray.at(t, new THREE.Vector3()) });
  }
  return hits.sort((a, b) => a.distance - b.distance)[0] ?? null;
}

export function touchHitState(hit: TouchHit, camera: THREE.Camera, feet: Vec3, world: CollisionWorld): 'ready' | 'far' | 'blocked' {
  const c = hit.target;
  if (!inReach(c.frame ? toFrame(c.frame, feet) : feet, c.min, c.max)) return 'far';
  const direction = hit.point.clone().sub(camera.position), distance = direction.length();
  if (distance > 0.08 && beamHit(world, camera.position, direction.divideScalar(distance), distance - 0.08)) return 'blocked';
  return 'ready';
}

/** HUD panels can have pointer-events:none; their visible rectangles still must not pass a tap to the world. */
export function worldTouchBlocked(x: number, y: number): boolean {
  return [...document.querySelectorAll('#hud > :not(#crosshair):not(#goal-arrow):not(#hide-overlay):not(#revive-ring), #chat-panel, #map, #rotate, #settings-open')].some(el => {
    const style = getComputedStyle(el);
    if ((el as HTMLElement).hidden || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  });
}
