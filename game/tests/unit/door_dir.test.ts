import { describe, it, expect } from 'vitest';
import { doorSwingDir } from '../../client/src/doorDir';
describe('doorSwingDir', () => {
  it('opens away from the player', () => {
    expect(doorSwingDir({ alongX: true, x: 0, z: 0 }, { x: 0, z: 2 })).toBe(1);
    expect(doorSwingDir({ alongX: true, x: 0, z: 0 }, { x: 0, z: -2 })).toBe(-1);
    expect(doorSwingDir({ alongX: false, x: 0, z: 0 }, { x: -2, z: 0 })).toBe(1);
    expect(doorSwingDir({ alongX: false, x: 0, z: 0 }, { x: 2, z: 0 })).toBe(-1);
  });
});
