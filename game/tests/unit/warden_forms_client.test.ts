import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { TORCH_DECAY } from '../../client/src/campus/render/interior_light.ts';

const ctx2d: any = new Proxy(function () {}, { get: (_, k) => (k === 'measureText' ? () => ({ width: 1 }) : ctx2d), apply: () => ctx2d, set: () => true });
vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }) });
const { Mobs } = await import('../../client/src/mobs.ts');
const { Warden } = await import('../../client/src/warden/model.ts');
const { WardenForms, WardenNightLight, CHANGED_NECK_S } = await import('../../client/src/warden/forms.ts');

describe('snapshot teacher forms', () => {
  it('hides prewarming accessories immediately if a normal snapshot claims the spare mid-compile', async () => {
    const scene = new THREE.Scene(), mobs = new Mobs(scene);
    let release!: () => void, compiled = 0;
    const firstCompile = new Promise<void>((resolve) => { release = resolve; });
    const renderer = { initTexture() {}, async compileAsync() { if (++compiled === 1) await firstCompile; } };
    const warming = mobs.prewarm(renderer as unknown as THREE.WebGLRenderer, new THREE.PerspectiveCamera());
    mobs.onSnap([{ id: 1, p: [0, 0, 0], yaw: 0, form: 'normal' }], 0);
    const forms = mobs.byId.get(1)!.forms!;
    expect([forms.hat.visible, forms.flashlight.visible, forms.book.visible]).toEqual([false, false, false]);
    release(); await warming;
    expect(compiled).toBe(2);
    expect([forms.hat.visible, forms.flashlight.visible, forms.book.visible]).toEqual([false, false, false]);
  });

  it('applies the wire form, retains it across omitted deltas and leaves monitors untouched', () => {
    const scene = new THREE.Scene(), mobs = new Mobs(scene);
    mobs.onSnap([{ id: 1, p: [0, 0, 0], yaw: 0, form: 'night' }, { id: 2, p: [4, 0, 0], yaw: 0, form: 'night', anim: 'freeze' }], 0);
    const teacher = mobs.byId.get(1)!, monitor = mobs.byId.get(2)!;
    expect(teacher.forms!.hat.visible).toBe(true);
    expect(monitor.forms).toBeUndefined();
    const monitorHead = monitor.warden.bones.head.quaternion.clone();
    mobs.onSnap([{ id: 1, p: [0, 0, 0], yaw: 0 }, { id: 2, p: [4, 0, 0], yaw: 0 }], 50);
    mobs.update(50, 0.1);
    expect(teacher.forms!.form).toBe('night');
    expect(teacher.forms!.flashlight.visible).toBe(true);
    expect(monitor.warden.bones.head.quaternion.angleTo(monitorHead)).toBeLessThan(1e-8);
    expect(scene.children.filter((o) => o instanceof THREE.SpotLight)).toHaveLength(1);
    mobs.onSnap([{ id: 1, p: [0, 0, 0], yaw: 0, form: 'rollcall' }, { id: 2, p: [4, 0, 0], yaw: 0 }], 100);
    expect(teacher.forms!.book.visible).toBe(true);
    expect(teacher.forms!.hat.visible).toBe(false);
    expect((scene.getObjectByName('warden-night-light') as THREE.SpotLight).intensity).toBe(0);
  });

  it('uses one real torch with an animated world ray, including a scaled / turned skeleton', () => {
    const scene = new THREE.Scene(), w = new Warden(), light = new WardenNightLight(scene);
    w.mesh.scale.setScalar(1.14); w.root.position.set(3, 3.6, -2); w.root.rotation.y = 0.9; scene.add(w.root);
    const f = new WardenForms(w);
    f.setForm('night'); f.update(0.6, 0, 'idle'); light.update(f);
    expect(w.mesh.scale.toArray()).toEqual([1.14, 1.14, 1.14]);
    const first = light.light.target.position.clone().sub(light.light.position).normalize();
    const origin = new THREE.Vector3(), target = new THREE.Vector3(); f.beamRay(origin, target);
    expect(light.light.position.distanceTo(origin)).toBeLessThan(1e-8);
    expect(origin.y).toBeGreaterThan(4.5); // the first-floor hand must not light the ground floor
    expect(light.light.decay).toBeGreaterThanOrEqual(TORCH_DECAY);
    expect(light.light.castShadow).toBe(false);
    expect(light.light.intensity).toBeGreaterThan(0);
    f.update(1.4, 0, 'idle'); light.update(f);
    const second = light.light.target.position.clone().sub(light.light.position).normalize();
    expect(first.angleTo(second)).toBeGreaterThan(0.1);
    light.update(); expect(light.light.intensity).toBe(0);
    f.dispose(); light.dispose();
  });

  it('returns the neck, face, lenses and exact base scale after leaving a form', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5); // identical breathing / posture phases for the control
    const w = new Warden(), control = new Warden();
    random.mockRestore();
    w.mesh.scale.set(1.14, 1.14, 1.14); control.mesh.scale.copy(w.mesh.scale);
    const baseScale = w.mesh.scale.clone(), f = new WardenForms(w);
    const materials = w.mesh.material as THREE.Material[], face = materials[0], lens = materials[7];
    f.setForm('changed'); f.update(0.25, 0, 'idle'); control.update(0.25, 0, 'idle');
    expect(w.bones.neck.quaternion.angleTo(control.bones.neck.quaternion)).toBeGreaterThan(0.5);
    expect(materials[0]).not.toBe(face);
    expect((materials[7] as THREE.MeshPhongMaterial).emissive.getHex()).toBe(0xffffff);
    expect((materials[7] as THREE.MeshPhongMaterial).opacity).toBe(1);
    f.update(CHANGED_NECK_S, 0, 'idle'); control.update(CHANGED_NECK_S, 0, 'idle');
    expect(w.bones.neck.quaternion.angleTo(control.bones.neck.quaternion)).toBeLessThan(1e-6);
    f.setForm('rollcall');
    for (let i = 0; i < 120; i++) { f.update(1 / 60, 0, 'idle'); control.update(1 / 60, 0, 'idle'); }
    f.setForm('normal');
    expect(materials[0]).toBe(face); expect(materials[7]).toBe(lens);
    expect(f.book.visible).toBe(false);
    expect(w.bones.head.quaternion.angleTo(control.bones.head.quaternion)).toBeLessThan(1e-6);
    f.setForm('finale');
    const box = w.mesh.geometry.boundingBox!;
    expect((box.max.y - box.min.y) * w.mesh.scale.y).toBeCloseTo(2.3, 8);
    f.setForm('normal'); expect(w.mesh.scale.toArray()).toEqual(baseScale.toArray());
    f.dispose();
  });

  it('disposes owned attachments once when a mob disappears and restores the original materials', () => {
    const scene = new THREE.Scene(), mobs = new Mobs(scene);
    mobs.onSnap([{ id: 1, p: [0, 0, 0], yaw: 0, form: 'night' }], 0);
    const teacher = mobs.byId.get(1)!, forms = teacher.forms!;
    const meshes: THREE.Mesh[] = []; forms.hat.traverse((o) => { if (o instanceof THREE.Mesh) meshes.push(o); });
    const disposals = meshes.map((o) => vi.spyOn(o.geometry, 'dispose'));
    const material = vi.spyOn(meshes[0].material as THREE.Material, 'dispose');
    mobs.onSnap([], 50); forms.dispose();
    for (const dispose of disposals) expect(dispose).toHaveBeenCalledTimes(1);
    expect(material).toHaveBeenCalledTimes(1);
    expect(forms.hat.parent).toBeNull(); expect(forms.flashlight.parent).toBeNull(); expect(forms.book.parent).toBeNull();
    expect((scene.getObjectByName('warden-night-light') as THREE.SpotLight).intensity).toBe(0);
  });
});
