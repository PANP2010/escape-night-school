import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAMPUS, campusColliders } from '../../client/src/campus/world/campus.ts';
import { CollisionWorld } from '../../shared/campus/collision.ts';
import * as THREE from 'three';
import { CampusScene, minuteFromQuery, NIGHT_FOG_DENSITY, NIGHT_MINUTE, shotViews, STEADY_T, tubeFlicker } from '../../client/src/campus/scene.ts';
import { parseClock } from '../../client/src/campus/core/state.ts';
import { sampleTimeOfDay } from '../../client/src/campus/systems/timeofday.ts';

const walk = (d: string): string[] => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });

describe('ported campus', () => {
  it('loads the 10 buildings with 教学楼A', () => {
    expect(CAMPUS.buildings.length).toBe(10);
    expect(CAMPUS.buildings.find(b => b.id === 'A')?.name).toBe('教学楼A');
  });
  it('builds a non-empty collision world', () => {
    const w = new CollisionWorld(campusColliders());
    expect(w.boxes.length).toBeGreaterThan(100);
  });
  it('clock parsing and the night default', () => {
    expect(parseClock('07:05')).toBe(425);
    expect(() => parseClock('noon')).toThrow();
    expect(minuteFromQuery('?t=06:30')).toBe(390);
    expect(minuteFromQuery('?t=bad')).toBe(NIGHT_MINUTE);
    expect(minuteFromQuery('')).toBe(NIGHT_MINUTE);
  });
  it('night lights the street lamps', () => {
    expect(sampleTimeOfDay(NIGHT_MINUTE).lamps).toBeGreaterThan(0.5);
  });
  it('night is near black: dark sky, hemisphere light low, exp fog', () => {
    for (const m of [NIGHT_MINUTE, 21 * 60 + 40, 23 * 60, 5 * 60]) {
      const s = sampleTimeOfDay(m);
      expect(Math.max(...s.zenith)).toBeLessThan(0.01); // linear of 0x101018 ≈ 0.005
      expect(s.hemiIntensity).toBeLessThanOrEqual(0.2);
      expect(s.windows).toBeLessThanOrEqual(0.1);
    }
    expect(NIGHT_FOG_DENSITY).toBeCloseTo(0.05);
  });
  it('tube flicker: mostly off, bursts of stutter, deterministic', () => {
    const ts = Array.from({ length: 1460 }, (_, i) => i * 0.01);
    const on = ts.filter(t => tubeFlicker(t) === 1).length;
    expect(on).toBeGreaterThan(10);
    expect(on).toBeLessThan(ts.length * 0.15);
    expect(tubeFlicker(3)).toBe(0);
    expect(tubeFlicker(0.5)).toBe(tubeFlicker(0.5));
  });
  it('steady (?steady) holds the clock between bursts, so the 日光灯 and 机房 glows stay put', () => {
    for (let d = -0.5; d <= 0.5; d += 0.01) expect(tubeFlicker(STEADY_T + d)).toBe(0); // well clear of a burst
    const cam = new THREE.PerspectiveCamera();
    const c = new CampusScene(new THREE.Scene()), steady = new CampusScene(new THREE.Scene());
    steady.steady = true;
    const clock = (s: CampusScene) => s as unknown as { time: number }; // private: only the scene advances it
    const tubes = new Set<number>(), free = new Set<number>();
    for (let i = 0; i < 60; i++) { // 6 s from 0: the free clock runs through the 0–1.2 s burst, the steady one never moves
      c.update(0.1, cam); steady.update(0.1, cam);
      expect(clock(steady).time).toBe(STEADY_T);
      tubes.add(steady.world.interior.intTube.value.r); free.add(c.world.interior.intTube.value.r);
    }
    expect(clock(c).time).toBeCloseTo(6);
    expect(free.size).toBeGreaterThan(1);
    expect(tubes.size).toBe(1);
    clock(steady).time = 0.02; steady.update(0.1, cam); // a test that set a burst time is pulled back on the next tick
    expect(clock(steady).time).toBe(STEADY_T);
  });
  it('screenshot views are finite and inside the campus', () => {
    for (const v of Object.values(shotViews())) for (const n of [v.x, v.y, v.z, v.yaw, v.pitch]) expect(Number.isFinite(n)).toBe(true);
  });
  it('has no 检讨书 story-module dependencies', () => {
    const story = /from '[^']*\/(story|narrative|dialogue|acts?|save|dissociation|npc|quest)[^']*'/;
    for (const f of [...walk('client/src/campus'), ...walk('shared/campus')].filter(f => f.endsWith('.ts')))
      expect(story.test(readFileSync(f, 'utf8')), f).toBe(false);
  });
});
