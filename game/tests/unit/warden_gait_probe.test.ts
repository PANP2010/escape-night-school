import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GAIT } from '../../client/src/warden/anim.ts';
import { Warden, MATS } from '../../client/src/warden/model.ts';
import { createGaitSampler } from '../warden-gait-sampler.mjs';

const sole = { y: -0.045, z: 0.035, a: 0.13, b: 0.048 };
const make = () => new Warden(MATS.map(() => new THREE.MeshBasicMaterial()), false);
const close = (w: Warden) => { w.mesh.geometry.dispose(); (w.mesh.material as THREE.Material[]).forEach((m) => m.dispose()); };

describe('gait acceptance measurements', () => {
  it('CLI measures the requested source commit with live gait weights and rejects a stale expected commit', () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const script = fileURLToPath(new URL('../probe-warden-gait.mjs', import.meta.url));
    const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const report = JSON.parse(execFileSync(process.execPath, [script, '--source-root', root, '--expected-commit', commit], { encoding: 'utf8' }));
    expect(report.source.commit).toBe(commit);
    expect(report.steady.walk.gaitDutyMin).toBe(GAIT.walk.duty);
    expect(report.steady.chase.interior.samples).toBeGreaterThan(100);
    expect(report.steady.chase.edges.samples).toBeGreaterThan(10);
    expect(report.steady.chase.airborneFrames).toBeGreaterThan(0);
    expect(report.steady.walk.worldScale).toHaveLength(3);
    expect(() => execFileSync(process.execPath, [script, '--source-root', root, '--expected-commit', `${commit}~1`], { stdio: 'pipe' })).toThrow();
  });

  it('excludes both airborne feet even if one is lower; empty support reports null rather than a zero slip pass', () => {
    const w = make(), sampler = createGaitSampler(GAIT, sole);
    try {
      w.anim.planted = () => false;
      for (let i = 0; i < 8; i++) {
        w.root.position.z = i; w.bones.footL.position.y = -i;
        sampler.add(w, { time: i / 60, segment: 'flight' });
      }
      const r = sampler.report().flight;
      expect(r.airborneFrames).toBe(6);
      expect(r.unplantedFootSamples).toBe(12);
      expect(r.full).toEqual({ samples: 0, medianMps: null, p90Mps: null, maxMps: null });
    } finally { close(w); }
  });

  it('uses only scheduled gait weights and their actual duty, and exposes central versus edge stance', () => {
    const w = make(), config = { ...GAIT, chase: { ...GAIT.chase, duty: 0.2 } }, sampler = createGaitSampler(config, sole);
    try {
      w.anim.actions.idle.stop(); w.anim.actions.chase.play().setEffectiveWeight(1);
      w.anim.planted = () => true;
      // Left q = 0.01 (edge), 0.1 (interior), 0.3 (flight); right q is outside duty in every case.
      let frame = 0;
      for (const [segment, phase] of [['edge', 0.26], ['interior', 0.35], ['phase-flight', 0.55]] as const) {
        for (let i = 0; i < 5; i++) {
          w.anim.actions.chase.time = phase;
          sampler.add(w, { time: frame++ / 60, segment });
        }
      }
      const r = sampler.report();
      expect(r.edge.gaitDutyMin).toBe(0.2); // idle / unscheduled walk and sprint must not dilute chase's duty
      expect(r.edge.full.samples).toBeGreaterThan(0); expect(r.edge.edges.samples).toBe(r.edge.full.samples);
      expect(r.interior.interior.samples).toBe(r.interior.full.samples);
      expect(r['phase-flight'].phaseFlightFootSamples).toBeGreaterThan(0); expect(r['phase-flight'].full.samples).toBe(0);
    } finally { close(w); }
  });

  it('accounts for actual root/mesh scale and moving tracking-grid displacement in world metres', () => {
    const w = make(), sampler = createGaitSampler(GAIT, sole), tracking = createGaitSampler(GAIT, sole);
    try {
      w.anim.planted = () => true;
      w.root.scale.set(2, 3, 4); w.mesh.scale.set(0.9, 1.1, 0.9);
      for (let i = 0; i < 10; i++) {
        const time = i / 60;
        w.root.position.z = 2 * time;
        sampler.add(w, { time, segment: 'moving' });
        tracking.add(w, { time, segment: 'tracking', ground: [0, 2 * time] });
      }
      expect(sampler.report().moving.full.maxMps).toBeCloseTo(2, 10);
      sampler.report().moving.worldScale.forEach((v, i) => expect(v).toBeCloseTo([1.8, 3.3, 3.6][i], 10));
      expect(tracking.report().tracking.full.maxMps).toBeCloseTo(0, 10);
    } finally { close(w); }
  });

  it('collects real chase support and flight independently without weakening the existing 10% slip assertion', () => {
    const w = make(), sampler = createGaitSampler(GAIT, sole), dt = 1 / 60;
    try {
      for (let i = 0; i < 360; i++) {
        w.root.position.z -= 4.6 * dt; w.update(dt, 4.6, 'chase', null);
        if (i > 180) sampler.add(w, { time: i * dt, segment: 'chase' });
      }
      const r = sampler.report().chase;
      expect(r.gaitDutyMin).toBeCloseTo(GAIT.chase.duty, 6);
      expect(r.airborneFrames).toBeGreaterThan(0);
      expect(r.unplantedFootSamples).toBeGreaterThan(0);
      expect(r.full.samples).toBeGreaterThan(50);
      expect(r.interior.samples).toBeGreaterThan(30);
      expect(r.edges.samples).toBeGreaterThan(0);
      expect(r.full.samples).toBe(r.interior.samples + r.edges.samples);
      expect(r.interior.maxMps).not.toBeNull();
      expect(r.interior.maxMps!).toBeLessThan(0.1 * 4.6);
    } finally { close(w); }
  });
});
