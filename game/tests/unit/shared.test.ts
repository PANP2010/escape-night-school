import { describe, expect, it } from 'vitest';
import { parseClientMsg } from '../../shared/protocol.ts';
import { InterpBuffer } from '../../client/src/interp.ts';

describe('protocol', () => {
  it('validates and sanitizes client messages', () => {
    expect(parseClientMsg('nope')).toBeNull();
    expect(parseClientMsg('{"t":"input","seq":1,"p":[1,0,"x"],"yaw":0,"pitch":0,"f":0}')).toBeNull();
    expect(parseClientMsg('{"t":"join","code":" ab2c "}')).toEqual({ t: 'join', code: 'AB2C' });
    expect(parseClientMsg('{"t":"join","code":"ab 2c"}')).toEqual({ t: 'join', code: 'AB2C' }); // pasted with a space
    const h = parseClientMsg(JSON.stringify({ t: 'hello', name: 'x'.repeat(40) }));
    expect(h?.t === 'hello' && h.name.length).toBe(16);
  });
});

describe('interp', () => {
  it('lerps between samples and clamps at ends', () => {
    const b = new InterpBuffer();
    b.push({ t: 0, x: 0, y: 0, z: 0, yaw: 0 });
    b.push({ t: 100, x: 10, y: 0, z: 0, yaw: 0 });
    expect(b.at(50)?.x).toBeCloseTo(5);
    expect(b.at(-10)?.x).toBe(0);
    expect(b.at(500)?.x).toBe(10);
  });
});

describe('InterpBuffer pitch', () => {
  it('lerps pitch and tolerates snapshots without it', () => {
    const b = new InterpBuffer();
    b.push({ t: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: -0.5 });
    b.push({ t: 100, x: 0, y: 0, z: 0, yaw: 0, pitch: 0.5 });
    expect(b.at(50)!.pitch).toBeCloseTo(0, 6);
    const c = new InterpBuffer();
    c.push({ t: 0, x: 0, y: 0, z: 0, yaw: 0 });
    c.push({ t: 100, x: 0, y: 0, z: 0, yaw: 0 });
    expect(c.at(50)!.pitch).toBeUndefined();
  });
});

describe('InterpBuffer burst delivery (low-fps receiver)', () => {
  it('snapshots stamped with the same receive time yield one jump, not a lerp', () => {
    const b = new InterpBuffer();
    b.push({ t: 0, x: 0, y: 0, z: 0, yaw: 0 });
    for (let k = 1; k <= 20; k++) b.push({ t: 1000, x: k * 0.43, y: 0, z: 0, yaw: 0 }); // 20 snapshots handled in one stalled frame
    expect(b.at(1100)!.x - b.at(900)!.x).toBeGreaterThan(8);
  });
});
