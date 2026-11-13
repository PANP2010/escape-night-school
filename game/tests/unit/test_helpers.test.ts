import { expect, test } from 'vitest';
import { nearPosition } from '../helpers.mjs';
import { generateLevel, inBounds, LEVELS } from '../../shared/level.ts';

test('placement coordinates belong to the current chapter, including upper storeys', () => {
  for (let i = 0; i < LEVELS.length; i++) {
    const level = generateLevel(i, 1), area = level.def.area;
    // A chapter may be a narrow union of regions, so its enclosing AABB centre is not a playable point.
    const region = level.def.regions?.[0] ?? area;
    const p = { x: (region.x0 + region.x1) / 2, y: region.y0 + 0.5, z: (region.z0 + region.z1) / 2 };
    const near = nearPosition(p, area, 0.1, 0.1);
    expect(inBounds(level, near.x, near.y, near.z)).toBe(true);
    expect(() => nearPosition(p, area, area.x1 - p.x + 1, 0)).toThrow('outside the current level');
    expect(() => nearPosition({ ...p, y: area.y0 - 1 }, area, 0, 0)).toThrow('outside the current level');
  }
});

test('invalid and infinite offsets fail before sending a teleport', () => {
  const area = { x0: 0, x1: 10, y0: 0, y1: 2, z0: 0, z1: 10 }, origin = { x: 5, y: 0, z: 5 };
  for (const n of [NaN, Infinity, -Infinity]) expect(() => nearPosition(origin, area, n, 0)).toThrow('outside');
  expect(() => nearPosition(origin, area, 0, NaN)).toThrow('outside');
  expect(() => nearPosition({ ...origin, y: Infinity }, area, 0, 0)).toThrow('outside');
  expect(() => nearPosition(origin, { ...area, z1: NaN }, 0, 0)).toThrow('outside');
});
