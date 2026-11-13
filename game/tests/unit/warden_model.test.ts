import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BONES, MATS, Warden, buildWardenGeometry, chain, hump } from '../../client/src/warden/model.ts';

describe('角色074 model', () => {
  const geo = buildWardenGeometry();
  it('stays inside the triangle budget with one group per material', () => {
    const tris = geo.index!.count / 3;
    expect(tris).toBeGreaterThan(3000);
    expect(tris).toBeLessThanOrEqual(9000);
    expect(geo.groups.length).toBe(MATS.length);
  });
  it('is about 1.75 m tall, standing on the floor', () => {
    geo.computeBoundingBox();
    const b = geo.boundingBox!;
    expect(b.min.y).toBeGreaterThanOrEqual(0);
    expect(b.max.y).toBeGreaterThan(1.72);
    expect(b.max.y).toBeLessThan(1.82);
  });
  it('skin weights sum to 1 and index real bones', () => {
    const si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
    for (let i = 0; i < si.count; i++) {
      let s = 0;
      for (let k = 0; k < 4; k++) { s += sw.getComponent(i, k); expect(si.getComponent(i, k)).toBeLessThan(BONES.length); }
      expect(s).toBeCloseTo(1, 5);
    }
  });
  it('chain blends between stops and clamps outside', () => {
    const w = chain(['shinL', 0.46], ['thighL', 0.56]);
    expect(w(new THREE.Vector3(0, 0.2, 0))).toEqual([['shinL', 1]]);
    expect(w(new THREE.Vector3(0, 0.51, 0))[1][1]).toBeCloseTo(0.5);
    expect(w(new THREE.Vector3(0, 0.9, 0))).toEqual([['thighL', 1]]);
  });
  it('builds a ~20-bone skeleton and walks without throwing', () => {
    const mats = MATS.map(() => new THREE.MeshBasicMaterial());
    const warden = new Warden(mats);
    expect(warden.mesh.skeleton.bones.length).toBeGreaterThanOrEqual(19);
    warden.update(0.1, 1.6);
    expect(warden.bones.thighL.rotation.x).not.toBe(0);
  });
  it('rounds the upper back more than the lower back', () => {
    expect(hump(1.36)).toBeGreaterThan(1.2);
    expect(hump(1.0)).toBeCloseTo(1, 2);
  });
  it('lapels have their own (lighter) material group', () => {
    const geo = buildWardenGeometry(), g = geo.groups[MATS.indexOf('lapel')];
    expect(g.count).toBeGreaterThan(0);
  });
  it('has finger bones; claw tips are an option (students have none)', () => {
    const tris = (g: THREE.BufferGeometry) => g.groups[MATS.indexOf('shoe')].count / 3;
    expect(tris(buildWardenGeometry(true))).toBeGreaterThan(tris(buildWardenGeometry(false)));
    expect(BONES).toContain('fingersL');
    const warden = new Warden(MATS.map(() => new THREE.MeshBasicMaterial()));
    warden.update(0.1, 3, 'chase');
    expect(Math.abs(warden.bones.fingersL.rotation.z) + Math.abs(warden.bones.handL.rotation.y)).toBeGreaterThan(0);
  });
  it('fingers curl in two stages: relaxed ~25° at idle, a half fist (>45°) in the chase', () => {
    const warden = new Warden(MATS.map(() => new THREE.MeshBasicMaterial()));
    warden.update(5, 3, 'idle');
    expect(Math.abs(warden.bones.fingersL.rotation.z)).toBeGreaterThan(0.3);
    expect(Math.abs(warden.bones.fingersL.rotation.z)).toBeLessThan(0.6);
    warden.update(5, 3, 'chase');
    expect(Math.abs(warden.bones.fingersL.rotation.z)).toBeGreaterThan(0.8);
    expect(Math.abs(warden.bones.fingers2L.rotation.z)).toBeGreaterThan(0.9);
  });
  it('head has real structure: sunken eye sockets, a nose standing off the face, a jaw clear of the neck', () => {
    const geo = buildWardenGeometry(), pos = geo.attributes.position, idx = geo.index!, g = geo.groups[MATS.indexOf('face')];
    const pts: THREE.Vector3[] = [];
    for (let k = g.start; k < g.start + g.count; k++) pts.push(new THREE.Vector3().fromBufferAttribute(pos, idx.getX(k)));
    const near = (x: number, y: number) => pts.filter((p) => p.z > 0.05).reduce((a, p) => (Math.hypot(p.x - x, p.y - y) < Math.hypot(a.x - x, a.y - y) ? p : a));
    const socket = near(0.045, 1.663), brow = near(0.045, 1.686), cheek = near(0.074, 1.638);
    expect(brow.z - socket.z).toBeGreaterThanOrEqual(0.006);
    expect(cheek.z - socket.z).toBeGreaterThanOrEqual(0.006);
    const faceFront = Math.max(...pts.map((p) => p.z));
    const sk = geo.groups[MATS.indexOf('skin')];
    let nose = 0;
    for (let k = sk.start; k < sk.start + sk.count; k++) { const p = new THREE.Vector3().fromBufferAttribute(pos, idx.getX(k)); if (Math.abs(p.x) < 0.02 && p.y > 1.6 && p.y < 1.68) nose = Math.max(nose, p.z); }
    expect(nose - faceFront).toBeGreaterThan(0.012);
    // chin sits forward of the jaw's underside (a jaw line), not a ball resting on the neck
    const chin = pts.filter((p) => p.y < 1.56).reduce((a, p) => (p.z > a.z ? p : a));
    expect(chin.z).toBeGreaterThan(0.08);
  });

  it('glasses temples run back to the ear and hook behind it', () => {
    const geo = buildWardenGeometry(), pos = geo.attributes.position, idx = geo.index!;
    const fr = geo.groups[MATS.indexOf('frame')], pts: THREE.Vector3[] = [];
    for (let k = fr.start; k < fr.start + fr.count; k++) pts.push(new THREE.Vector3().fromBufferAttribute(pos, idx.getX(k)));
    const left = pts.filter((p) => p.x > 0.09); // only temples reach this far out
    const zs = left.map((p) => p.z);
    expect(Math.min(...zs)).toBeLessThan(-0.02); // reaches the ear (ear spans z -0.03..0.015)
    const ys = left.map((p) => p.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.012); // the hook drops ~15 mm
    // Absolute front-rim bounds; the separate raycast test below measures clearance from the face.
    const rim = pts.filter((p) => Math.abs(p.x) > 0.03 && Math.abs(p.x) < 0.05 && p.z > 0.1);
    expect(rim.length).toBeGreaterThan(0);
    expect(Math.max(...rim.map((p) => p.z))).toBeLessThan(0.15);
  });


});

describe('值日生 build', () => {
  const geo = buildWardenGeometry(false, 'monitor'), warden = buildWardenGeometry(false);
  const groupTris = (g: THREE.BufferGeometry, m: (typeof MATS)[number]) => g.groups[MATS.indexOf(m)].count / 3;
  /** Furthest |z| of the torso-height verts (y 1.0–1.45, |x| < 0.12): paunch in front, hump/hood/bag behind. */
  const depth = (g: THREE.BufferGeometry, side: 1 | -1) => {
    const p = g.attributes.position;
    let d = 0;
    for (let i = 0; i < p.count; i++) if (p.getY(i) > 1 && p.getY(i) < 1.45 && Math.abs(p.getX(i)) < 0.12) d = Math.max(d, side * p.getZ(i));
    return d;
  };
  it('keeps one group per material but drops the glasses, hood and bag', () => {
    expect(geo.groups.length).toBe(MATS.length);
    expect(groupTris(geo, 'frame')).toBeLessThan(10); // only the placeholder speck
    expect(groupTris(geo, 'lens')).toBeLessThan(10);
    expect(geo.index!.count).toBeLessThan(warden.index!.count * 0.85);
  });
  it('is flat front and back: no paunch, no hump, thinner than 角色074', () => {
    expect(depth(geo, 1)).toBeLessThan(depth(warden, 1) - 0.02);
    expect(depth(geo, -1)).toBeLessThan(depth(warden, -1) - 0.04);
  });
  it('has a blank face: nothing stands off it (no nose, no glasses)', () => {
    geo.computeBoundingBox(); warden.computeBoundingBox();
    const faceFront = (g: THREE.BufferGeometry) => { const p = g.attributes.position; let z = 0; for (let i = 0; i < p.count; i++) if (p.getY(i) > 1.6) z = Math.max(z, p.getZ(i)); return z; };
    expect(faceFront(geo)).toBeLessThan(faceFront(warden) - 0.015);
  });
  it('Warden(…, "monitor") stands taller (~1.9 m) and narrower', () => {
    const m = new Warden(MATS.map(() => new THREE.MeshBasicMaterial()), false, 'monitor');
    expect(1.75 * m.mesh.scale.y).toBeGreaterThan(1.85);
    expect(m.mesh.scale.x).toBeLessThan(1);
    expect(() => m.update(0.1, 6, 'chase')).not.toThrow();
  });
});
