import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { MonitorName } from '../../client/src/monitorName.ts';
import { Mobs } from '../../client/src/mobs.ts';
import { monitorDisplayName } from '../../shared/studentNames.ts';

const ctx: any = new Proxy(function () {}, { get: (_target, key) => key === 'measureText' ? () => ({ width: 1 }) : ctx, apply: () => ctx, set: () => true });
function canvasDocument() { vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) }); }
afterEach(() => vi.unstubAllGlobals());

describe('visible monitor identities', () => {
  it('keeps an anonymous monitor faceless and clears all named variants when returning to the original model', () => {
    canvasDocument();
    const mobs = new Mobs(new THREE.Scene());
    mobs.onSnap([{ id: 2, name: '角色020', p: [0, 0, 0], yaw: 0 }], 0);
    const figure = mobs.byId.get(2)!;
    expect(figure.namedFace).toBeDefined();
    mobs.onSnap([{ id: 2, name: '值周生', p: [0, 0, 0], yaw: 0 }], 50);
    expect(figure.nameTag).toBeUndefined(); expect(figure.namedFace).toBeUndefined(); expect(figure.outfit).toBeUndefined();
    expect(figure.warden.mesh.scale.toArray()).toEqual([.9, 1.1, .9]);
    expect(figure.warden.bones.head.scale.toArray()).toEqual([1, 1, 1]);
    expect(figure.mesh.children.some(child => child.name === 'MONITOR_NAME')).toBe(false);
  });

  it('retains the server identity across delta snapshots on two independent rendered clients', () => {
    canvasDocument();
    const clients = [new Mobs(new THREE.Scene()), new Mobs(new THREE.Scene())];
    const name = monitorDisplayName(17, 1, 3);
    for (const mobs of clients) {
      mobs.onSnap([{ id: 3, kind: 'monitor', name, p: [0, 0, -3], yaw: 0, anim: 'freeze' }], 0);
      const tag = mobs.byId.get(3)!.nameTag;
      mobs.onSnap([{ id: 3, p: [0, 0, -3], yaw: 0 }], 50);
      expect(mobs.byId.get(3)!.displayName).toBe(name);
      expect(mobs.byId.get(3)!.nameTag).toBe(tag);
      expect(tag!.sprite.userData.displayName).toBe(name);
    }
    expect(clients[0].byId.get(3)!.displayName).toBe(clients[1].byId.get(3)!.displayName);
  });

  it('only shows a nearby, forward, unobstructed name and releases its owned resources', () => {
    canvasDocument();
    const label = new MonitorName('角色047'), scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 1.6, 3); scene.add(label.sprite); camera.updateMatrixWorld(true);
    label.update(camera, () => true); expect(label.sprite.visible).toBe(true);
    expect(label.sprite.material.depthTest).toBe(true);
    label.update(camera, () => false); expect(label.sprite.visible).toBe(false);
    camera.position.z = 20; label.update(camera, () => true); expect(label.sprite.visible).toBe(false);
    camera.position.z = -3; label.update(camera, () => true); expect(label.sprite.visible).toBe(false);
    const material = vi.spyOn(label.sprite.material, 'dispose');
    const texture = vi.spyOn(label.sprite.material.map!, 'dispose');
    label.dispose(); expect(label.sprite.parent).toBeNull();
    expect(material).toHaveBeenCalledOnce(); expect(texture).toHaveBeenCalledOnce();
  });

  it('disposes a removed monitor name instead of leaking one canvas texture per level', () => {
    canvasDocument();
    const mobs = new Mobs(new THREE.Scene());
    mobs.onSnap([{ id: 2, name: '角色117', p: [0, 0, 0], yaw: 0 }], 0);
    const name = mobs.byId.get(2)!.nameTag!, dispose = vi.spyOn(name, 'dispose');
    mobs.onSnap([], 50);
    expect(dispose).toHaveBeenCalledOnce(); expect(mobs.byId.size).toBe(0);
  });

  it('writes each actual identity on an owned face map without changing the other monitor or shared paper material', () => {
    const labels: string[] = [];
    const paper: any = new Proxy(function () {}, { get: (_target, key) => key === 'fillText' ? (text: string) => labels.push(text) : key === 'measureText' ? () => ({ width: 1 }) : paper, apply: () => paper, set: () => true });
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => paper }) });
    const mobs = new Mobs(new THREE.Scene());
    const snap = [{ id: 2, name: '角色039', p: [0, 0, 0] as [number, number, number], yaw: 0 }, { id: 3, name: '角色117', p: [3, 0, 0] as [number, number, number], yaw: 0 }];
    mobs.onSnap(snap, 0);
    const [a, b] = [mobs.byId.get(2)!.namedFace!, mobs.byId.get(3)!.namedFace!];
    expect(a.material).not.toBe(b.material); expect(a.texture).not.toBe(b.texture);
    expect(a.material.userData.displayName).toBe('角色039'); expect(b.material.userData.displayName).toBe('角色117');
    expect(labels.filter(name => name === '角色039')).toHaveLength(2); // face ink plus nearby label
    expect(labels.filter(name => name === '角色117')).toHaveLength(2);
    const painted = labels.length;
    mobs.onSnap(snap.map(({ name: _name, ...delta }) => delta), 50);
    expect(labels).toHaveLength(painted); expect(mobs.byId.get(2)!.namedFace).toBe(a);
    const material = vi.spyOn(a.material, 'dispose'), texture = vi.spyOn(a.texture, 'dispose');
    mobs.onSnap([snap[1]], 100);
    expect(material).toHaveBeenCalledOnce(); expect(texture).toHaveBeenCalledOnce();
    expect(mobs.byId.get(3)!.namedFace).toBe(b);
  });

  it('gives 角色094 squinting eyes and 角色020 an isolated short broad model while preserving root authority', () => {
    const labels: string[] = [], curves: number[][] = [];
    const paper: any = new Proxy(function () {}, { get: (_target, key) => key === 'fillText' ? (text: string) => labels.push(text) : key === 'quadraticCurveTo' ? (...args: number[]) => curves.push(args) : key === 'measureText' ? () => ({ width: 1 }) : paper, apply: () => paper, set: () => true });
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => paper }) });
    const mobs = new Mobs(new THREE.Scene());
    const snap = ['角色020', '角色094', '角色117'].map((name, i) => ({ id: 2 + i, name, p: [i * 3, 0, 0] as [number, number, number], yaw: 0 }));
    mobs.onSnap(snap, 0);
    const [ye, xiao, regular] = [mobs.byId.get(2)!, mobs.byId.get(3)!, mobs.byId.get(4)!];
    expect(labels.filter(text => text === '角色094')).toHaveLength(1); // nearby label only, never inked on the face
    expect(curves.filter(c => c[1] === 115 && c[3] === 120)).toHaveLength(2);
    expect(xiao.namedFace!.material.userData.displayName).toBe('角色094');
    expect(ye.warden.mesh.scale.x).toBeGreaterThan(regular.warden.mesh.scale.x);
    expect(ye.warden.mesh.scale.y).toBeLessThan(regular.warden.mesh.scale.y * .8);
    expect(ye.warden.mesh.scale.z).toBeGreaterThan(regular.warden.mesh.scale.z);
    expect(ye.warden.bones.head.scale.y).toBeGreaterThan(1.3); // compensate the shorter body so its head stays round
    expect(regular.warden.bones.head.scale.toArray()).toEqual([1, 1, 1]);
    expect(ye.mesh.scale.toArray()).toEqual([1, 1, 1]); expect(ye.mesh.position.toArray()).toEqual(snap[0].p);
    expect((ye.warden.mesh.material as THREE.Material[])[2]).toBe((regular.warden.mesh.material as THREE.Material[])[2]);
    const geometry = ye.warden.mesh.geometry;
    mobs.onSnap([{ ...snap[0], name: '角色117' }, snap[1], snap[2]], 50);
    expect(ye.warden.mesh.scale.toArray()).toEqual(regular.warden.mesh.scale.toArray());
    expect(ye.warden.bones.head.scale.toArray()).toEqual([1, 1, 1]);
    expect(ye.warden.mesh.geometry).toBe(geometry); expect(ye.mesh.position.toArray()).toEqual(snap[0].p);
  });
});
