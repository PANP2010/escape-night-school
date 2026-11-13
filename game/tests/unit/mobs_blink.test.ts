import { describe, expect, it } from 'vitest';
import { InterpBuffer } from '../../client/src/interp.ts';

describe('InterpBuffer.collapse', () => {
  it('keeps only the newest sample so the entity lands there at once', () => {
    const b = new InterpBuffer();
    b.push({ t: 0, x: 0, y: 0, z: 0, yaw: 0 });
    b.push({ t: 50, x: 0.3, y: 0, z: 0, yaw: 0 });
    b.push({ t: 100, x: 1.2, y: 0, z: 0, yaw: 0 });
    b.collapse();
    expect(b.at(10)!.x).toBe(1.2);
    expect(b.lastT()).toBe(100);
  });
});
