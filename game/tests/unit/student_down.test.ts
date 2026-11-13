import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

// the avatar paints its textures on canvases: a 2D context that swallows every call is enough here
const ctx2d: any = new Proxy(function () {}, { get: (_, k) => (k === 'measureText' ? () => ({ width: 1 }) : ctx2d), apply: () => ctx2d, set: () => true });
vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }) });
const { Student, DOWN_S } = await import('../../client/src/warden/student.ts');
const { downCand, toFrame } = await import('../../shared/interact.ts');

/** World-space bounds of the skinned body as posed now (the root at the origin, feet on y = 0). */
function body(s: InstanceType<typeof Student>) {
  s.root.updateMatrixWorld(true);
  s.warden.mesh.computeBoundingBox();
  return s.warden.mesh.boundingBox!.clone().applyMatrix4(s.warden.mesh.matrixWorld);
}
const run = (s: InstanceType<typeof Student>, secs: number, down: boolean, pitch = 0, each?: () => void) => {
  for (let i = 0; i < Math.round(secs * 60); i++) { s.update(1 / 60, 0, false, true, pitch, 3, down); each?.(); }
};
const beamOrigin = (s: InstanceType<typeof Student>) => {
  const o = new THREE.Vector3(), d = new THREE.Vector3();
  s.root.updateMatrixWorld(true);
  s.beam(o, d);
  return { o, d };
};
const seededStudent = (phase = 0.3) => {
  const random = vi.spyOn(Math, 'random').mockReturnValue(phase);
  try { return new Student(0x3366aa); } finally { random.mockRestore(); }
};

describe('Student downed pose', () => {
  it('lies on the floor once down, lower than 0.6 m and not through it', () => {
    const s = new Student(0x3366aa);
    run(s, 0.2, false);
    expect(body(s).max.y).toBeGreaterThan(1.5);
    run(s, 1, true);
    expect(s.fallen).toBe(1);
    const b = body(s);
    expect(b.max.y).toBeLessThan(0.6);
    expect(b.min.y).toBeGreaterThan(-0.02);
    expect(b.min.y).toBeLessThan(0.03); // resting on it, not floating
    // lying out along the floor, not curled up on the spot
    expect(Math.max(b.max.x - b.min.x, b.max.z - b.min.z)).toBeGreaterThan(1.2);
  });

  it('stays under 0.6 m through the whole idle cycle (glasses push) and while still being moved (walk clip)', () => {
    for (const speed of [0, 0.3, 1.5]) {
      const s = new Student(0x3366aa);
      run(s, 0.2, false);
      for (let i = 0; i < 60; i++) s.update(1 / 60, speed, false, true, 0, 3, true);
      let hi = 0, lo = 0;
      for (let i = 0; i < 8 * 60; i++) { // > one 6.4 s idle loop
        s.update(1 / 60, speed, false, true, 0, 3, true);
        if (i % 6) continue;
        const b = body(s); hi = Math.max(hi, b.max.y); lo = Math.min(lo, b.min.y);
      }
      expect(hi, `speed ${speed}`).toBeLessThan(0.6);
      expect(lo, `speed ${speed}`).toBeGreaterThan(-0.02);
    }
  });

  it('goes down mid glasses-push and still ends up under 0.6 m', () => {
    const s = new Student(0x3366aa);
    run(s, 3.5, false); // idle t ≈ 3.5 s: right hand at the glasses
    run(s, 1, true);
    expect(body(s).max.y).toBeLessThan(0.6);
  });

  it('goes down over DOWN_S, getting lower all the way, and never sinks into the floor', () => {
    const s = new Student(0x3366aa);
    run(s, 0.2, false);
    let prev = body(s).max.y, lowest = 0;
    run(s, DOWN_S, true, 0, () => {
      const b = body(s);
      expect(b.max.y).toBeLessThan(prev + 0.01);
      prev = b.max.y; lowest = Math.min(lowest, b.min.y);
    });
    expect(s.fallen).toBeCloseTo(1, 5);
    expect(prev).toBeLessThan(0.6);
    expect(lowest).toBeGreaterThan(-0.1);
  });

  it('stands back up (≥ 1.5 m) within DOWN_S of being revived', () => {
    const s = new Student(0x3366aa);
    run(s, 1, true);
    let lowest = 0;
    run(s, DOWN_S, false, 0, () => { lowest = Math.min(lowest, body(s).min.y); });
    expect(s.fallen).toBe(0);
    const b = body(s);
    expect(b.max.y).toBeGreaterThan(1.5);
    expect(b.min.y).toBeGreaterThan(-0.02);
    expect(lowest).toBeGreaterThan(-0.1);
  });

  it('drops the torch to the floor beside them, pointing level whatever their pitch', () => {
    const s = new Student(0x3366aa);
    run(s, 0.2, false, 0.8);
    const up = beamOrigin(s);
    expect(up.o.y).toBeGreaterThan(0.8);
    expect(up.d.y).toBeGreaterThan(0.5);
    run(s, 1, true, 0.8);
    const dn = beamOrigin(s);
    expect(dn.o.y).toBeLessThan(0.35);
    expect(dn.o.y).toBeGreaterThan(0);
    expect(Math.abs(dn.d.y)).toBeLessThan(1e-6);
  });

  it('a short down/up blip eases back without jumping', () => {
    const s = new Student(0x3366aa);
    run(s, 0.2, false);
    run(s, 0.1, true);
    const f = s.fallen;
    expect(f).toBeGreaterThan(0.1);
    expect(f).toBeLessThan(0.25);
    let prev = body(s).max.y;
    run(s, DOWN_S, false, 0, () => { const h = body(s).max.y; expect(Math.abs(h - prev)).toBeLessThan(0.08); prev = h; });
    expect(s.fallen).toBe(0);
  });

  it('stays inside the revive box (downCand, in its own frame) at any facing, through the idle cycle and while being moved', () => {
    const v = new THREE.Vector3();
    for (const speed of [0, 1.5]) for (const yaw of [0, 0.7, Math.PI / 4, Math.PI / 2, -2.4]) {
      const s = new Student(0x3366aa);
      s.root.position.set(2, 3.5, -1); s.root.rotation.y = yaw;
      const b = downCand([2, 3.5, -1], yaw), m = s.warden.mesh;
      run(s, 1, true);
      for (let k = 0; k < 8; k++) { // samples over > one 6.4 s idle loop
        for (let i = 0; i < 60; i++) s.update(1 / 60, speed, false, true, 0, 3, true);
        s.root.updateMatrixWorld(true);
        for (let i = 0; i < m.geometry.attributes.position.count; i += 3) {
          m.getVertexPosition(i, v).applyMatrix4(m.matrixWorld);
          const q = toFrame(b.frame, [v.x, v.y, v.z]);
          if (q[0] < b.min[0] || q[0] > b.max[0] || q[2] < b.min[2] || q[2] > b.max[2] || q[1] > b.max[1]) throw new Error(`speed ${speed} yaw ${yaw}: vertex ${q} (own frame) outside`);
        }
      }
    }
  });

  it('breathes visibly through repeated down updates for over 30 s without drifting or leaving the floor', () => {
    const s = new Student(0x3366aa);
    s.root.position.set(2, 3.5, -1); s.root.rotation.y = Math.PI / 4;
    run(s, 1, true);
    const b = s.warden.bones, start = new Map(Object.entries(b).map(([n, bone]) => [n, bone.getWorldPosition(new THREE.Vector3())]));
    const root = s.root.position.clone(), chest = new THREE.Vector3(), hips = new THREE.Vector3();
    let chestLow = Infinity, chestHigh = -Infinity, min = Infinity, max = -Infinity;
    for (let i = 0; i < 32 * 60; i++) { // ten complete breaths, longer than the server's normal down timeout
      s.update(1 / 60, 1.5, false, true, 0.8, 3, true);
      expect(s.fallen).toBe(1); // repeated ST_DOWN updates must never replay the fall
      if (i % 12) continue;
      s.root.updateMatrixWorld(true);
      const rise = b.chest.getWorldPosition(chest).y - b.hips.getWorldPosition(hips).y;
      chestLow = Math.min(chestLow, rise); chestHigh = Math.max(chestHigh, rise);
      const bounds = body(s);
      min = Math.min(min, bounds.min.y - root.y); max = Math.max(max, bounds.max.y - root.y);
      expect(bounds.min.y - root.y).toBeLessThan(0.03);
    }
    expect(chestHigh - chestLow).toBeGreaterThan(0.003); // millimetres of rib/shoulder rise, including at normal remote scale
    expect(chestHigh - chestLow).toBeLessThan(0.02);
    expect(min).toBeGreaterThan(-0.02); expect(max).toBeLessThan(0.6);
    expect(s.root.position.equals(root)).toBe(true);
    s.root.updateMatrixWorld(true);
    for (const [n, bone] of Object.entries(b)) expect(bone.getWorldPosition(chest).distanceTo(start.get(n)!)).toBeLessThan(1e-6);
    s.dispose();
  });

  it('keeps the complete steady downed mesh grounded at yaw zero for a deterministic starting posture', () => {
    for (const phase of [0, 0.3, 0.7]) for (const warm of [false, true]) {
      const s = seededStudent(phase);
      try {
        if (warm) { run(s, 0.2, false); body(s); }
        // Render matrices advance every frame, including the first fall, as they do in the game.
        for (let i = 0; i < 60; i++) {
          s.update(1 / 60, 1.5, false, true, 0.8, 3, true);
          s.root.updateMatrixWorld(true);
        }
        let low = Infinity, high = -Infinity;
        for (let i = 0; i < 384; i++) { // two complete 3.2 s breaths; computeBoundingBox skins every vertex
          s.update(1 / 60, 1.5, false, true, 0.8, 3, true);
          const bounds = body(s);
          low = Math.min(low, bounds.min.y); high = Math.max(high, bounds.max.y);
          expect(s.fallen).toBe(1);
          expect(bounds.min.y, `phase ${phase}, warm ${warm}, frame ${i}`).toBeLessThan(0.03);
        }
        expect(low, `phase ${phase}, warm ${warm}`).toBeGreaterThan(-0.02);
        expect(high, `phase ${phase}, warm ${warm}`).toBeLessThan(0.6);
      } finally { s.dispose(); }
    }
  });

  it('poses the same breath at the same elapsed time at 30 and 60 FPS', () => {
    const a = seededStudent(), b = seededStudent();
    try {
      for (let sample = 0; sample < 20; sample++) {
        for (let i = 0; i < 15; i++) {
          a.update(1 / 30, 1.5, false, true, 0.8, 3, true);
          a.root.updateMatrixWorld(true);
          for (let k = 0; k < 2; k++) {
            b.update(1 / 60, 1.5, false, true, 0.8, 3, true);
            b.root.updateMatrixWorld(true);
          }
        }
        expect(a.fallen).toBeCloseTo(b.fallen, 10);
        for (const n of Object.keys(a.warden.bones) as (keyof typeof a.warden.bones)[]) {
          expect(a.warden.bones[n].quaternion.angleTo(b.warden.bones[n].quaternion), `${sample}: ${n}`).toBeLessThan(1e-7);
          expect(a.warden.bones[n].position.distanceTo(b.warden.bones[n].position), `${sample}: ${n}`).toBeLessThan(1e-7);
        }
        const ab = body(a), bb = body(b);
        expect(ab.min.distanceTo(bb.min)).toBeLessThan(1e-7);
        expect(ab.max.distanceTo(bb.max)).toBeLessThan(1e-7);
      }
    } finally { a.dispose(); b.dispose(); }
  });

  it('keeps the breathing head, chest and hands targetable inside the existing rescue OBB', async () => {
    const { rayTarget, inReachDown } = await import('../../shared/interact.ts');
    const s = new Student(0x3366aa), v = new THREE.Vector3();
    s.root.position.set(-2, 3.5, 4); s.root.rotation.y = -2.4;
    const p: [number, number, number] = [-2, 3.5, 4], yaw = s.root.rotation.y;
    const cand = { kind: 'revive' as const, id: 7, ...downCand(p, yaw) }, m = s.warden.mesh;
    run(s, 1, true);
    for (let k = 0; k < 32; k++) {
      run(s, 0.1, true);
      s.root.updateMatrixWorld(true);
      for (let i = 0; i < m.geometry.attributes.position.count; i++) {
        m.getVertexPosition(i, v).applyMatrix4(m.matrixWorld);
        const q = toFrame(cand.frame, [v.x, v.y, v.z]);
        if (q[0] < cand.min[0] || q[0] > cand.max[0] || q[2] < cand.min[2] || q[2] > cand.max[2] || q[1] > cand.max[1]) {
          throw new Error(`breath sample ${k}: vertex ${i} at ${q} outside the rescue OBB`);
        }
      }
      for (const n of ['head', 'chest', 'handL', 'handR'] as const) {
        const target = s.warden.bones[n].getWorldPosition(v);
        // A nearby helper looks down at each actual body point, at an oblique body heading on an upper storey.
        const eye: [number, number, number] = [target.x, p[1] + 1.6, target.z];
        expect(rayTarget(eye, yaw, -Math.PI / 2, [cand])?.id).toBe(7);
        expect(inReachDown([eye[0], p[1], eye[2]], p, yaw)).toBe(true);
      }
    }
    s.dispose();
  });

  it('holds a paused breath, safely resumes after a long frame, and survives another down/revive cycle', () => {
    const s = new Student(0x3366aa);
    run(s, 2, true);
    const chest = s.warden.bones.chest.quaternion.clone(), hips = s.warden.bones.hips.position.clone(), before = body(s);
    for (let i = 0; i < 90; i++) s.update(0, 0, false, true, 0.8, 3, true);
    expect(s.warden.bones.chest.quaternion.angleTo(chest)).toBeLessThan(1e-7);
    expect(s.warden.bones.hips.position.distanceTo(hips)).toBeLessThan(1e-7);
    expect(body(s).max.distanceTo(before.max)).toBeLessThan(1e-7);
    s.update(120, 0, false, true, 0.8, 3, true); // e.g. a resumed background tab
    expect(s.fallen).toBe(1);
    expect(body(s).max.y).toBeLessThan(0.6); expect(body(s).min.y).toBeGreaterThan(-0.02);
    const beam = beamOrigin(s);
    expect(beam.o.y).toBeGreaterThan(0); expect(beam.o.y).toBeLessThan(0.35); expect(Math.abs(beam.d.y)).toBeLessThan(1e-6);
    run(s, DOWN_S, false);
    expect(s.fallen).toBe(0); expect(body(s).max.y).toBeGreaterThan(1.5);
    run(s, 0.2, true);
    expect(s.fallen).toBeGreaterThan(0.3); expect(s.fallen).toBeLessThan(0.4);
    run(s, DOWN_S - 0.2, true);
    expect(s.fallen).toBe(1); expect(body(s).max.y).toBeLessThan(0.6);
    run(s, DOWN_S, false);
    expect(s.fallen).toBe(0); expect(body(s).max.y).toBeGreaterThan(1.5);
    run(s, 3, false);
    expect(s.fallen).toBe(0); expect(body(s).max.y).toBeGreaterThan(1.5);
    s.dispose();
  });

  it('removes the breathing layer completely when revived back to the standing mixer', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.3);
    let s: InstanceType<typeof Student>, control: InstanceType<typeof Student>;
    try { s = new Student(0x3366aa); control = new Student(0x3366aa); } finally { random.mockRestore(); }
    for (let i = 0; i < 180; i++) {
      s.update(1 / 60, 0, false, true, 0.8, 3, i < 120);
      control.update(1 / 60, 0, false, true, 0.8, 3, false);
    }
    expect(s.fallen).toBe(0);
    for (const n of Object.keys(s.warden.bones) as (keyof typeof s.warden.bones)[]) {
      expect(s.warden.bones[n].quaternion.angleTo(control.warden.bones[n].quaternion), n).toBeLessThan(1e-7);
      expect(s.warden.bones[n].position.distanceTo(control.warden.bones[n].position), n).toBeLessThan(1e-7);
    }
    expect(beamOrigin(s).o.distanceTo(beamOrigin(control).o)).toBeLessThan(1e-7);
    expect(s.coneRotationX).toBeCloseTo(control.coneRotationX, 8);
    s.dispose(); control.dispose();
  });
});
