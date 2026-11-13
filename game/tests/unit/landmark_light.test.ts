import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CampusScene } from '../../client/src/campus/scene.ts';
import { LANDMARK_LIGHT, landmarkLight } from '../../client/src/campus/render/interior_light.ts';
import { L1 } from '../../shared/levels/l1.ts';
import { L2 } from '../../shared/levels/l2.ts';

describe('lit-room landmark illumination', () => {
  it('lights the real L1 anteroom walls and floor, stays in its room/storey, and reuses uniforms on level changes', () => {
    const scene = new THREE.Scene(), campus = new CampusScene(scene), camera = new THREE.PerspectiveCamera();
    const u = campus.world.interior;
    const material = campus.world.interiors.find(i => i.b.id === 'A')!.mesh.material as THREE.Material;
    const initialVersion = material.version, key = material.customProgramCacheKey();
    const objects: THREE.Object3D[] = [];
    scene.traverse(o => objects.push(o));
    const lamps = objects.filter(o => (o as THREE.Light).isLight);
    const uniforms = [u.intLandmark, u.intLandmarkRect, u.intLandmarkY, u.intLandmarkAxis];
    camera.position.set(-56.2, 1.6, 70.5);
    campus.steady = true;
    campus.setLandmarks(L1.landmarks);
    campus.update(0.1, camera);
    // L1's historical "lit classroom" is actually room sc0, the short hall before the southwest stairwell.
    expect(u.intLandmarkRect.value.toArray()).toEqual([-64.76, 69, -53.95, 72.06].map(v => expect.closeTo(v, 8)));
    expect(u.intLandmarkY.value.toArray()).toEqual([0, 3.4]);
    expect(u.intLandmark.value.toArray()).toEqual([-60, LANDMARK_LIGHT.height, 70.4, 1]);
    const floor = landmarkLight(u, [-60, 0.02, 70.4], [0, 1, 0]);
    const westWall = landmarkLight(u, [-64.76, 1.6, 70.4], [1, 0, 0]);
    const stairWall = landmarkLight(u, [-60, 1.6, 69], [0, 0, 1]);
    expect(floor).toBeGreaterThan(0.5);
    expect(westWall).toBeGreaterThan(0.18);
    expect(stairWall).toBeGreaterThan(westWall);
    expect(landmarkLight(u, [-60, 3.4, 70.4], [0, -1, 0])).toBeLessThan(westWall);
    expect(landmarkLight(u, [-60, 1.6, 68.8], [0, 0, -1])).toBe(0); // opposite face of stair enclosure
    expect(landmarkLight(u, [-60, 1.6, 72.16], [0, 0, -1])).toBe(0); // neighbouring classroom
    expect(landmarkLight(u, [-60, 3.6, 70.4], [0, 1, 0])).toBe(0); // floor above
    expect(landmarkLight(u, [-65, 1.6, 70.4], [1, 0, 0])).toBe(0); // outside facade

    const base = THREE.ShaderLib.lambert;
    const shader = { uniforms: THREE.UniformsUtils.clone(base.uniforms), vertexShader: base.vertexShader, fragmentShader: base.fragmentShader };
    material.onBeforeCompile(shader as Parameters<THREE.Material['onBeforeCompile']>[0], {} as THREE.WebGLRenderer);
    expect(shader.uniforms.intLandmark).toBe(u.intLandmark);
    expect(shader.fragmentShader).toContain('intLandmarkAt(vIntW, vIntN) * intLive(vIntW)');
    expect(shader.fragmentShader).toContain('finishWallFace');
    expect(shader.fragmentShader).toContain('step( length( spotLight.position ), 1.0 ), step(');
    expect(shader.fragmentShader).not.toContain('${');

    campus.blackout = true;
    campus.setLandmarks(L2.landmarks);
    campus.update(0.1, camera);
    expect(u.intLandmarkRect.value.toArray()).toEqual([15.24, 74.24, 23.95, 82.64].map(v => expect.closeTo(v, 8)));
    expect(landmarkLight(u, [18.5, 3.62, 78.5], [0, 1, 0])).toBe(0);
    campus.blackout = false; // fuses restored: the same lamp comes back without replacing a material
    campus.update(0.1, camera);
    expect(landmarkLight(u, [18.5, 3.62, 78.5], [0, 1, 0])).toBeGreaterThan(0.5);
    campus.setLandmarks(undefined);
    campus.update(0.1, camera);
    expect(landmarkLight(u, [18.5, 3.62, 78.5], [0, 1, 0])).toBe(0);
    expect([u.intLandmark, u.intLandmarkRect, u.intLandmarkY, u.intLandmarkAxis]).toEqual(uniforms);
    expect(material.version).toBe(initialVersion);
    expect(material.customProgramCacheKey()).toBe(key);
    const after: THREE.Object3D[] = [];
    scene.traverse(o => after.push(o));
    expect(after).toEqual(objects);
    expect(after.filter(o => (o as THREE.Light).isLight)).toEqual(lamps);
  });
});
