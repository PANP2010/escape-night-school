import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { cullSkinned, figureInView, viewFrustum } from '../../client/src/mobs.ts';

describe('cullSkinned', () => {
  it('hides figures outside the view frustum and shows the ones inside', () => {
    const cam = new THREE.PerspectiveCamera(75, 1, 0.05, 60);
    cam.updateMatrixWorld(true);
    const ahead = new THREE.Group(), behind = new THREE.Group(), far = new THREE.Group();
    ahead.position.set(0, 0, -10);
    behind.position.set(0, 0, 10);
    far.position.set(0, 0, -100);
    cullSkinned(cam, [ahead, behind, far]);
    expect([ahead.visible, behind.visible, far.visible]).toEqual([true, false, false]);
  });
});

describe('figureInView', () => {
  it('keeps a figure whose feet are just below the view but whose body is in it', () => {
    const cam = new THREE.PerspectiveCamera(60, 1, 0.05, 60);
    cam.position.set(0, 1.6, 0);
    cam.rotation.x = 0.5; // looking up: the feet 4 m ahead are below the frustum, the head is not
    cam.updateMatrixWorld(true);
    const fr = viewFrustum(cam);
    expect(figureInView(fr, new THREE.Vector3(0, 0, -4))).toBe(true);
    expect(figureInView(fr, new THREE.Vector3(0, 0, 6))).toBe(false);
    expect(figureInView(fr, new THREE.Vector3(-20, 0, -4))).toBe(false);
  });
});
