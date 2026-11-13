import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BLACKOUT_AMB, CampusScene, EYE_ADAPT, eyeTarget } from '../../client/src/campus/scene.ts';
import { EYE_LIGHT, eyeLight, INDOOR, NIGHT_AMB } from '../../client/src/campus/render/interior_light.ts';

// 第 2 关最暗 (#231, 用户 10-28「第二层要保证最暗也能看到脚底的路」): the 暗适应 eye light of a 停电关
describe('暗适应 (EYE_LIGHT / EYE_ADAPT)', () => {
  it('is on only on a 停电关: part while blacked out, full under a 跳闸, none on other levels', () => {
    expect(eyeTarget(false, false, 0)).toBe(0);
    expect(eyeTarget(false, false, 1)).toBe(0); // an L1 跳闸 stays black
    expect(eyeTarget(true, true, 0)).toBe(EYE_ADAPT.blackout);
    expect(eyeTarget(true, true, 1)).toBe(1); // the darkest: blackout + 跳闸
    expect(eyeTarget(true, false, 1)).toBe(1); // a 跳闸 after the power is back
    expect(eyeTarget(true, false, 0)).toBe(0); // powered: the 日光灯 light it
    expect(EYE_ADAPT.blackout).toBeGreaterThan(0);
    expect(EYE_ADAPT.blackout).toBeLessThan(1);
  });

  it('at the darkest the floor at your feet is lit at least as well as the blackout floor deep in the building', () => {
    const eye = [0, 1.6, 0] as const, up = [0, 1, 0] as const;
    const feet = EYE_LIGHT.level * eyeLight(eye, 1, [0, 0, 0], up) + NIGHT_AMB.level * BLACKOUT_AMB * 0.15;
    expect(feet).toBeGreaterThanOrEqual(NIGHT_AMB.level * BLACKOUT_AMB * INDOOR.deep * 2);
    // a few metres ahead still reads, 2 × reach on is black: the corridor past the pool stays dark
    expect(eyeLight(eye, 1, [0, 0, -3.5], up)).toBeGreaterThan(0.5);
    expect(eyeLight(eye, 1, [0, 0, -2 * EYE_LIGHT.reach], up)).toBeLessThan(0.02);
  });

  it('lights the floor above the wall beside it, the ceiling least, so the floor/wall edge holds', () => {
    const eye = [0, 1.6, 0] as const, p = [1.6, 0.05, -3] as const;
    const floor = eyeLight(eye, 1, p, [0, 1, 0]), wall = eyeLight(eye, 1, p, [-1, 0, 0]), ceil = eyeLight(eye, 1, [p[0], 3.15, p[2]], [0, -1, 0]);
    expect(floor / wall).toBeGreaterThanOrEqual(2);
    expect(ceil).toBeLessThan(wall);
    expect(eyeLight(eye, 0, p, [0, 1, 0])).toBe(0);
  });

  it('CampusScene eases the eye to its target and puts it at the camera', () => {
    const c = new CampusScene(new THREE.Scene()), cam = new THREE.PerspectiveCamera();
    cam.position.set(40, 5.2, 84.2);
    const u = c.world.interior.intEye.value;
    c.update(0.1, cam);
    expect(c.eye).toBe(0);
    expect(u.w).toBe(0);
    c.dark = c.blackout = true;
    for (let i = 0; i < 60; i++) c.update(0.1, cam);
    expect(c.eye).toBeCloseTo(EYE_ADAPT.blackout, 3);
    c.out = 1; // the 跳闸: a beat of black, then the floor comes back
    c.update(0.1, cam);
    expect(c.eye).toBeLessThan(0.6);
    for (let i = 0; i < 19; i++) c.update(0.1, cam);
    expect(c.eye).toBeGreaterThan(0.95);
    expect([u.x, u.y, u.z, u.w]).toEqual([40, 5.2, 84.2, c.eye]);
    c.dark = c.blackout = false; c.out = 0; // the next level: gone again
    for (let i = 0; i < 60; i++) c.update(0.1, cam);
    expect(c.eye).toBeLessThan(0.001);
  });
});
