import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CampusScene, finishCampusMaterial, shotViews } from '../../client/src/campus/scene.ts';
import { campusSurfaceTexture } from '../../client/src/textures.ts';

function compiled(material: THREE.Material) {
  const base = THREE.ShaderLib.lambert;
  const shader = { uniforms: THREE.UniformsUtils.clone(base.uniforms), vertexShader: base.vertexShader, fragmentShader: base.fragmentShader };
  material.onBeforeCompile(shader as Parameters<THREE.Material['onBeforeCompile']>[0], {} as THREE.WebGLRenderer);
  return shader;
}

describe('campus surface finish', () => {
  it('chains original lighting and shares one data texture without touching mapped signs', () => {
    const scene = new THREE.Scene(), campus = new CampusScene(scene);
    const a = campus.world.interiors.find(it => it.b.id === 'A')!.mesh.material as THREE.MeshLambertMaterial;
    const b = campus.world.interiors.find(it => it.b.id === 'B')!.mesh.material as THREE.MeshLambertMaterial;
    const shaderA = compiled(a), shaderB = compiled(b);
    expect(shaderA.fragmentShader).toContain('intAmbient( hemisphereLights');
    expect(shaderA.fragmentShader).toContain('step( length( spotLight.position ), 1.0 ), step(');
    expect(shaderA.fragmentShader).toContain('intLive(vIntW)');
    expect(shaderA.fragmentShader).toContain('finishWallFace');
    expect(shaderA.fragmentShader).toContain('finishPool');
    expect(shaderA.uniforms.intEye).toBe(campus.world.interior.intEye);
    expect(shaderA.uniforms.campusSurface.value).toBe(shaderB.uniforms.campusSurface.value);
    expect(a.customProgramCacheKey()).toContain('interior-light:A');
    const key = a.customProgramCacheKey();
    const spare = campusSurfaceTexture();
    finishCampusMaterial(a, spare, 'interior');
    expect(a.customProgramCacheKey()).toBe(key);
    const mapped = new THREE.MeshLambertMaterial({ map: new THREE.Texture() });
    const hook = mapped.onBeforeCompile;
    finishCampusMaterial(mapped, spare, 'interior');
    expect(mapped.onBeforeCompile).toBe(hook);
    expect(mapped.userData.campusFinish).toBeUndefined();
    spare.dispose();
    const facade = (scene.getObjectByName('A') as THREE.Mesh).material as THREE.Material;
    const shaderFacade = compiled(facade);
    expect(shaderFacade.fragmentShader).toContain('finishBase');
    expect(shaderFacade.uniforms.glassZenith).toBe(campus.world.facade.glassZenith);
    expect(facade.customProgramCacheKey()).toContain('facade|bridge-lamps:');
  });

  it('keeps paper on its storey under indoor blackout lighting and leaves colliders alone', () => {
    const scene = new THREE.Scene(), campus = new CampusScene(scene), camera = new THREE.PerspectiveCamera();
    const a = scene.getObjectByName('A.corridor.paper') as THREE.Mesh;
    const b = scene.getObjectByName('B.corridor.paper') as THREE.Mesh;
    expect(a.material).toBe(campus.world.interiors.find(it => it.b.id === 'A')!.mesh.material);
    expect(b.material).toBe(campus.world.interiors.find(it => it.b.id === 'B')!.mesh.material);
    const p = a.geometry.getAttribute('position');
    expect(p.count).toBe(8 * 9);
    expect(a.geometry.getAttribute('surf').getY(0)).toBe(-4);
    for (let i = 0; i < p.count; i++) expect(p.getY(i)).toBeGreaterThanOrEqual(0.025 - 1e-5);
    const count = campus.world.colliders.length;
    camera.position.set(-40, 1.6, 73.3); campus.update(0.1, camera);
    expect(a.visible).toBe(true); expect(b.visible).toBe(false);
    camera.position.set(40, 5.2, 84.2); campus.dark = campus.blackout = true; campus.update(0.1, camera);
    expect(a.visible).toBe(false); expect(b.visible).toBe(true);
    expect(campus.world.colliders.length).toBe(count);
  });

  it('keeps board clock hands writable after GPU upload while releasing static colour data', () => {
    const scene = new THREE.Scene(), campus = new CampusScene(scene);
    const board = scene.getObjectByName('A.1F.boards') as THREE.Mesh<THREE.BufferGeometry>;
    expect(board).toBeInstanceOf(THREE.Mesh);
    const geometry = board.geometry;
    expect(geometry.userData.clocks.length).toBeGreaterThan(0);
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    const normal = geometry.getAttribute('normal') as THREE.BufferAttribute;
    const color = geometry.getAttribute('color') as THREE.BufferAttribute;
    const handsStart = (geometry.userData.hands as number) * position.itemSize;
    campus.world.boards.syncTime(0);
    const before = Array.from(position.array).slice(handsStart);
    const positionVersion = position.version, normalVersion = normal.version;
    // Run the real release callbacks installed during construction, just as the renderer does after upload.
    position.onUploadCallback(); normal.onUploadCallback(); color.onUploadCallback();
    expect(position.array).not.toBeNull();
    expect(normal.array).not.toBeNull();
    expect(color.usage).toBe(THREE.StaticDrawUsage);
    expect(color.array).toBeNull();
    expect(() => campus.world.boards.syncTime(9 * 60 + 17)).not.toThrow();
    const after = Array.from(position.array).slice(handsStart);
    expect(after.some((value, i) => value !== before[i])).toBe(true);
    expect(after.every(Number.isFinite)).toBe(true);
    expect(position.version).toBeGreaterThan(positionVersion);
    expect(normal.version).toBeGreaterThan(normalVersion);
    expect(position.array).not.toBeNull();
    expect(normal.array).not.toBeNull();
  });

  it('culls split outdoor cells deep indoors and restores them at the entrance view', () => {
    const scene = new THREE.Scene(), campus = new CampusScene(scene), camera = new THREE.PerspectiveCamera();
    const cells: THREE.Object3D[] = [];
    scene.traverse(o => { if (/^(?:OUTSKIRTS|PAVING|PROPS)@/.test(o.name)) cells.push(o); });
    expect(cells.length).toBeGreaterThan(10);
    // This part of the south corridor is far from both the street entrance and the courtyard doorway.
    camera.position.set(-52, 1.6, 73.3); campus.update(0.1, camera);
    expect(cells.every(o => !o.visible)).toBe(true);
    expect(scene.getObjectByName('CAMPUS_SKY')!.visible).toBe(false);
    expect(camera.far).toBe(30);
    const view = shotViews().outdoor;
    camera.position.set(view.x, view.y, view.z); campus.update(0.1, camera);
    expect(cells.every(o => o.visible)).toBe(true);
    expect(scene.getObjectByName('CAMPUS_SKY')!.visible).toBe(true);
  });

  it('keeps the outdoor sky visible on both sides of the entrance threshold', () => {
    const scene = new THREE.Scene(), campus = new CampusScene(scene), camera = new THREE.PerspectiveCamera();
    const cells: THREE.Object3D[] = [];
    scene.traverse(o => { if (/^(?:OUTSKIRTS|PAVING|PROPS)@/.test(o.name)) cells.push(o); });
    expect(cells.length).toBeGreaterThan(10);
    // A's south entrance is centred at (-40, 63). Looking out must keep the same sky across the doorway.
    camera.rotation.set(0, 0, 0);
    for (const z of [62.8, 63.2, 62.8]) {
      camera.position.set(-40, 1.6, z); campus.update(0.1, camera);
      expect(scene.getObjectByName('CAMPUS_SKY')!.visible, `entrance z=${z}`).toBe(true);
      expect(cells.every(o => o.visible), `entrance z=${z}`).toBe(true);
    }
  });

  it('restores the open courtyard sky, outdoor cells and outdoor view distance', () => {
    const scene = new THREE.Scene(), campus = new CampusScene(scene), camera = new THREE.PerspectiveCamera();
    const cells: THREE.Object3D[] = [];
    scene.traverse(o => { if (/^(?:OUTSKIRTS|PAVING|PROPS)@/.test(o.name)) cells.push(o); });
    expect(cells.length).toBeGreaterThan(10);
    camera.position.set(-52, 1.6, 73.3); campus.update(0.1, camera);
    expect(cells.every(o => !o.visible)).toBe(true);
    // A's courtyard has no roof: its centre is exposed even though it is within the building's outer footprint.
    camera.position.set(-40, 1.6, 82.95); campus.update(0.1, camera);
    expect(scene.getObjectByName('CAMPUS_SKY')!.visible).toBe(true);
    expect(cells.every(o => o.visible)).toBe(true);
    expect(camera.far).toBe(60);
  });

  it('keeps the courtyard sky visible across its doorway from the south corridor', () => {
    const scene = new THREE.Scene(), campus = new CampusScene(scene), camera = new THREE.PerspectiveCamera();
    const cells: THREE.Object3D[] = [];
    scene.traverse(o => { if (/^(?:OUTSKIRTS|PAVING|PROPS)@/.test(o.name)) cells.push(o); });
    expect(cells.length).toBeGreaterThan(10);
    // The courtyard's +z-facing doorway is in its south wall at (-40, 74.9), facing into the open well.
    camera.rotation.set(0, Math.PI, 0);
    for (const z of [73.3, 74.7, 75.1, 74.7, 73.3]) {
      camera.position.set(-40, 1.6, z); campus.update(0.1, camera);
      expect(scene.getObjectByName('CAMPUS_SKY')!.visible, `courtyard doorway z=${z}`).toBe(true);
      expect(cells.every(o => o.visible), `courtyard doorway z=${z}`).toBe(true);
      expect(camera.far, `courtyard doorway z=${z}`).toBe(60);
    }
  });

  it('culls the outdoor backdrop when a nearby courtyard doorway is outside the view', () => {
    const scene = new THREE.Scene(), campus = new CampusScene(scene), camera = new THREE.PerspectiveCamera(75, 1.6);
    const view = shotViews().corridor;
    camera.position.set(view.x, view.y, view.z);
    camera.rotation.set(view.pitch, view.yaw, 0);
    campus.update(0.1, camera);
    expect(scene.getObjectByName('CAMPUS_SKY')!.visible).toBe(false);
    expect(camera.far).toBe(30);
    // The same corridor position must restore the well's sky before its doorway crosses the threshold.
    camera.rotation.set(0, Math.PI, 0);
    campus.update(0.1, camera);
    expect(scene.getObjectByName('CAMPUS_SKY')!.visible).toBe(true);
    expect(camera.far).toBe(60);
    camera.rotation.set(view.pitch, view.yaw, 0);
    campus.update(0.1, camera);
    expect(scene.getObjectByName('CAMPUS_SKY')!.visible).toBe(false);
    expect(camera.far).toBe(30);
  });

  it('culls outdoor cells deep in B while keeping its nearby west doorway backdrop', () => {
    const scene = new THREE.Scene(), campus = new CampusScene(scene), camera = new THREE.PerspectiveCamera();
    const cells: THREE.Object3D[] = [];
    scene.traverse(o => { if (/^(?:OUTSKIRTS|PAVING|PROPS)@/.test(o.name)) cells.push(o); });
    expect(cells.length).toBeGreaterThan(10);
    // B is only 12 m deep: distance from an actual doorway still makes this central corridor deep indoors.
    camera.position.set(40, 5.2, 84.2); campus.update(0.1, camera);
    expect(cells.every(o => !o.visible)).toBe(true);
    expect(scene.getObjectByName('CAMPUS_SKY')!.visible).toBe(false);
    expect(camera.far).toBe(30);
    // Its second-storey west doorway is centred at (15, 84.25), opening onto the bridge to A.
    camera.rotation.set(0, Math.PI / 2, 0);
    camera.position.set(16, 5.2, 84.2); campus.update(0.1, camera);
    expect(cells.every(o => o.visible)).toBe(true);
    expect(scene.getObjectByName('CAMPUS_SKY')!.visible).toBe(true);
    expect(camera.far).toBe(60);
    // At the same horizontal point one storey above, there is no bridge doorway through the wall.
    camera.position.set(16, 8.8, 84.2); campus.update(0.1, camera);
    expect(cells.every(o => !o.visible)).toBe(true);
    expect(scene.getObjectByName('CAMPUS_SKY')!.visible).toBe(false);
    expect(camera.far).toBe(30);
  });

  it('returns fog and horizon to their sampled daylight colours after a night frame', () => {
    const scene = new THREE.Scene(), campus = new CampusScene(scene), camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 1.6, 42); campus.update(0.1, camera);
    campus.minute = 12 * 60; campus.update(0.1, camera);
    expect(scene.fog).toBeInstanceOf(THREE.FogExp2);
    const fog = scene.fog as THREE.FogExp2, horizon = campus.tod.sample.horizon;
    expect(fog.color.r).toBeCloseTo(horizon[0], 8);
    expect(fog.color.g).toBeCloseTo(horizon[1], 8);
    expect(fog.color.b).toBeCloseTo(horizon[2], 8);
    expect(fog.density).toBe(0.05);
    const sky = scene.getObjectByName('CAMPUS_SKY') as THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
    const skyHorizon = sky.material.uniforms.skyHorizon.value as THREE.Color;
    expect(skyHorizon.r).toBeCloseTo(horizon[0], 8);
    expect(skyHorizon.g).toBeCloseTo(horizon[1], 8);
    expect(skyHorizon.b).toBeCloseTo(horizon[2], 8);
  });

  it('drives leaf motion and scattering from the clock instead of the default white glow at night', () => {
    const scene = new THREE.Scene(), campus = new CampusScene(scene), camera = new THREE.PerspectiveCamera();
    campus.steady = true;
    camera.position.set(0, 1.6, 42); campus.update(0.1, camera);
    const uniforms = campus.world.trees.leaves.material.uniforms;
    expect(uniforms.time.value).toBe(3);
    const crown = scene.getObjectByName('TREES.crowns') as THREE.Mesh;
    const shader = compiled(crown.material as THREE.Material);
    for (const minute of [19 * 60, 21 * 60 + 40, 22 * 60 + 30, 23 * 60, 0, 5 * 60]) {
      campus.minute = minute; campus.update(0.1, camera);
      const night = uniforms.light.value as THREE.Color;
      expect(Math.max(night.r, night.g, night.b), `leaf light at minute ${minute}`).toBeLessThan(0.02);
      expect(Math.max(shader.uniforms.glow.value.r, shader.uniforms.glow.value.g, shader.uniforms.glow.value.b), `crown glow at minute ${minute}`).toBeLessThan(0.01);
    }
    campus.minute = 12 * 60; campus.update(0.1, camera);
    const day = uniforms.light.value as THREE.Color;
    expect(Math.min(day.r, day.g, day.b)).toBeGreaterThan(0.2);
  });
});
