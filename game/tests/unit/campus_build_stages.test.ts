import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runBuildStages, type BuildStageProgress } from '../../client/src/campus/buildStages.ts';
import { buildCampus, buildCampusAsync, buildCampusStages, CAMPUS_BUILD_MILESTONES } from '../../client/src/campus/world/campus.ts';
import { CampusScene, discardPreparedCampus } from '../../client/src/campus/scene.ts';
import { Game } from '../../client/src/game.ts';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('campus build scheduler', () => {
  it('allows the loading UI to paint before starting, then yields after its work budget', async () => {
    vi.useFakeTimers();
    const frames: FrameRequestCallback[] = [], calls: string[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    function* pieces() { calls.push('ground'); yield 'ground'; calls.push('walls'); yield 'walls'; return 42; }
    const progress: BuildStageProgress[] = [];
    const running = runBuildStages(pieces(), { budgetMs: 0, onProgress: stage => progress.push(stage) });
    expect(calls).toEqual([]);
    frames.shift()!(0);
    await Promise.resolve();
    expect(calls).toEqual([]); // rAF itself still precedes paint; construction waits for its following task
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['ground']);
    await vi.runAllTimersAsync();
    expect(await running).toBe(42);
    expect(progress.map(p => [p.stage, p.completed])).toEqual([['ground', 1], ['walls', 2]]);
    expect(progress.every(p => p.durationMs >= 0 && p.elapsedMs >= p.durationMs)).toBe(true);
  });

  it('closes a cancelled generator before it can attach its next object', async () => {
    const controller = new AbortController(), scene = new THREE.Scene();
    let closed = false;
    function* pieces() {
      try {
        scene.add(new THREE.Group()); yield 'first';
        scene.add(new THREE.Group()); yield 'stale';
        return 1;
      } finally { closed = true; }
    }
    const stages = pieces();
    await expect(runBuildStages(stages, { signal: controller.signal, onProgress: () => controller.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(closed).toBe(true);
    expect(scene.children).toHaveLength(1);
    expect(stages.next().done).toBe(true);
    expect(scene.children).toHaveLength(1);
  });

  it('cancels while waiting for a frame without waiting for its timer fallback', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    vi.stubGlobal('requestAnimationFrame', () => 7);
    vi.stubGlobal('cancelAnimationFrame', cancel);
    const controller = new AbortController(), next = vi.fn();
    function* pieces() { next(); yield 'stale'; return 1; }
    const stages = pieces(), running = runBuildStages(stages, { signal: controller.signal });
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(next).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith(7);
    expect(vi.getTimerCount()).toBe(0);
    expect(stages.next().done).toBe(true);
  });

  it('closes the generator if a progress consumer fails', async () => {
    let closed = false;
    function* pieces() { try { yield 'first'; yield 'stale'; return 1; } finally { closed = true; } }
    await expect(runBuildStages(pieces(), { onProgress: () => { throw new Error('progress failed'); } })).rejects.toThrow('progress failed');
    expect(closed).toBe(true);
  });
});

/** Hash actual vertex/index bytes, object order and bounds; a matching mesh count alone can hide missing rooms. */
function sceneSignature(scene: THREE.Scene) {
  const result: unknown[] = [];
  scene.traverse(object => {
    const mesh = object as THREE.Mesh;
    const geometry = mesh.geometry;
    if (!geometry) { result.push([object.name, object.type]); return; }
    const attributes = [...Object.entries(geometry.attributes), ...(geometry.index ? [['index', geometry.index] as const] : [])];
    const data = attributes.map(([name, attribute]) => {
      const a = attribute.array;
      return [name, attribute.itemSize, attribute.count, createHash('sha256').update(Buffer.from(a.buffer, a.byteOffset, a.byteLength)).digest('hex')];
    });
    result.push([object.name, object.type, data, geometry.groups, geometry.boundingBox?.min.toArray(), geometry.boundingBox?.max.toArray()]);
  });
  return result;
}

function releaseScene(scene: THREE.Scene) {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
  scene.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    if (mesh.material) for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  scene.clear();
}

describe('campus build stages', () => {
  it('produces the same complete geometry and colliders through the synchronous and scheduled APIs', async () => {
    const syncScene = new THREE.Scene(), asyncScene = new THREE.Scene(), progress: BuildStageProgress[] = [];
    try {
      const sync = buildCampus(syncScene);
      const asyncWorld = await buildCampusAsync(asyncScene, { budgetMs: 0, onProgress: p => progress.push(p) });
      expect(sceneSignature(asyncScene)).toEqual(sceneSignature(syncScene));
      expect(asyncWorld.colliders).toEqual(sync.colliders);
      expect(asyncWorld.buildings).toBe(sync.buildings);
      expect(asyncWorld.furniture.map(f => [f.b.id, f.y0, f.y1, f.mesh.name])).toEqual(sync.furniture.map(f => [f.b.id, f.y0, f.y1, f.mesh.name]));
      expect(progress.filter(p => p.stage.endsWith(':facade'))).toHaveLength(sync.buildings.length);
      expect(progress.some(p => p.stage.startsWith('A:1F:furniture@'))).toBe(true);
      expect(progress.map(p => p.stage).filter(stage => CAMPUS_BUILD_MILESTONES.includes(stage))).toEqual(CAMPUS_BUILD_MILESTONES);
      expect(progress.at(-1)?.stage).toBe('colliders');
    } finally { releaseScene(syncScene); releaseScene(asyncScene); }
  });

  it('owns partial furniture cells in the staging scene and stops all later additions after cancellation', async () => {
    const scene = new THREE.Scene(), controller = new AbortController();
    const stages = buildCampusStages(scene);
    try {
      await expect(runBuildStages(stages, { signal: controller.signal, onProgress: ({ stage }) => {
        if (stage.startsWith('A:1F:furniture@')) controller.abort();
      } })).rejects.toMatchObject({ name: 'AbortError' });
      const furniture = scene.getObjectByName('A.1F.furniture');
      expect(furniture?.children).toHaveLength(1);
      const count = sceneSignature(scene).length;
      expect(stages.next().done).toBe(true);
      expect(sceneSignature(scene)).toHaveLength(count);
      expect(scene.getObjectByName('B')).toBeUndefined();
    } finally { releaseScene(scene); }
  });
});

describe('campus publication', () => {
  it('moves a complete staging world into the live scene once, with all collision boxes present', async () => {
    const prepared = await CampusScene.prepare(), scene = new THREE.Scene();
    try {
      const objects = prepared.scene.children.slice();
      const campus = new CampusScene(scene, undefined, prepared);
      expect(campus.world).toBe(prepared.world);
      expect(prepared.scene.children).toHaveLength(0);
      expect(objects.every(object => object.parent === scene)).toBe(true);
      expect(scene.children.filter(object => object.name === 'A')).toHaveLength(1);
      expect(scene.children.filter(object => object.name === 'GROUND')).toHaveLength(1);
      // The gate attaches its own movable colliders after the static boxes.
      expect(campus.collision.boxes.slice(0, prepared.world.colliders.length)).toEqual(prepared.world.colliders);
    } finally { discardPreparedCampus(scene); }
  });

  it('disposes a cancelled staging scene before rejecting the build', async () => {
    const controller = new AbortController();
    const dispose = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    try {
      await expect(CampusScene.prepare({ signal: controller.signal, onProgress: ({ stage }) => {
        if (stage.startsWith('A:1F:furniture@')) controller.abort();
      } })).rejects.toMatchObject({ name: 'AbortError' });
      expect(dispose.mock.calls.length).toBeGreaterThan(1);
    } finally { dispose.mockRestore(); }
  });

  it('keeps all prediction and input transport stopped until the authoritative world frame exists', () => {
    const input = { clear: vi.fn(), endFrame: vi.fn() };
    const game = Object.assign(Object.create(Game.prototype), { worldReady: false, spawnSynced: false, input });
    // No renderer, collision world or transport exists: touching any of them before readiness would fail.
    game.update(0.05, performance.now());
    expect(input.clear).toHaveBeenCalledOnce();
    expect(game.presentationReady).toBe(false);
    expect(game.presentWorld()).toBe(false);
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
    const render = vi.fn(() => {
      expect(game.presentationReady).toBe(false);
      expect(camera.position.toArray()).toEqual([-41, 1.6, 73]);
    });
    Object.assign(game, { spawnSynced: true, pos: { x: -41, z: 73 }, body: { y: 0 }, eye: 1.6,
      input: { ...input, yaw: 0, pitch: 0 }, campus: { update: vi.fn() }, scene, camera,
      renderer: { render }, drawOn: true });
    expect(game.presentWorld()).toBe(true);
    expect(render).toHaveBeenCalledOnce();
    expect(game.presentationReady).toBe(true);
    expect(game.presentWorld()).toBe(false);
    expect(render).toHaveBeenCalledOnce();
  });
});
