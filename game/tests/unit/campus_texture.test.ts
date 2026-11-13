import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { campusSurfaceTexture } from '../../client/src/textures.ts';

function pixelData(texture: THREE.DataTexture): Uint8Array {
  const data = texture.image.data;
  if (!(data instanceof Uint8Array)) throw new Error('Expected campus surface pixels to be a Uint8Array');
  return data;
}

describe('campus surface data texture', () => {
  it('constructs without a DOM, has mipmapped repeat sampling and disposes normally', () => {
    expect(typeof document).toBe('undefined');
    const texture = campusSurfaceTexture();
    expect(texture.image.width).toBe(256);
    expect(texture.image.height).toBe(256);
    expect(texture.image.data).toBeInstanceOf(Uint8Array);
    expect(pixelData(texture).length).toBe(256 * 256 * 4);
    expect(texture.format).toBe(THREE.RGBAFormat);
    expect(texture.type).toBe(THREE.UnsignedByteType);
    expect(texture.colorSpace).toBe(THREE.NoColorSpace);
    expect([texture.wrapS, texture.wrapT]).toEqual([THREE.RepeatWrapping, THREE.RepeatWrapping]);
    expect(texture.generateMipmaps).toBe(true);
    expect(texture.minFilter).toBe(THREE.LinearMipmapLinearFilter);
    expect(texture.magFilter).toBe(THREE.LinearFilter);
    expect(texture.anisotropy).toBe(4);
    let disposed = false;
    texture.addEventListener('dispose', () => { disposed = true; });
    texture.dispose();
    expect(disposed).toBe(true);
  });

  it('regenerates identical data without sharing mutable pixels', () => {
    const a = campusSurfaceTexture(), b = campusSurfaceTexture();
    expect(a.image.data).not.toBe(b.image.data);
    const aData = pixelData(a), bData = pixelData(b);
    expect(aData.every((value, i) => value === bData[i])).toBe(true);
    a.dispose(); b.dispose();
  });

  it('keeps centred mottling and grain while damp trails remain sparse', () => {
    const texture = campusSurfaceTexture(), data = pixelData(texture);
    const values = (channel: number) => Array.from({ length: 256 * 256 }, (_, i) => data[i * 4 + channel] / 255);
    const red = values(0), green = values(1), blue = values(2);
    const mean = (v: number[]) => v.reduce((sum, value) => sum + value, 0) / v.length;
    const deviation = (v: number[]) => {
      const average = mean(v);
      return Math.sqrt(mean(v.map(value => (value - average) ** 2)));
    };
    expect(mean(red)).toBeGreaterThan(0.46);
    expect(mean(red)).toBeLessThan(0.54);
    expect(mean(green)).toBeGreaterThan(0.48);
    expect(mean(green)).toBeLessThan(0.52);
    expect(deviation(red)).toBeGreaterThan(0.09);
    expect(deviation(green)).toBeGreaterThan(0.2);
    expect(blue.filter(v => v === 0).length / blue.length).toBeGreaterThan(0.7);
    expect(blue.filter(v => v > 0.3).length / blue.length).toBeGreaterThan(0.01);
    expect(blue.filter(v => v > 0.3).length / blue.length).toBeLessThan(0.18);
    expect(data.every((value, i) => i % 4 !== 3 || value === 255)).toBe(true);
    texture.dispose();
  });

  it('wraps broad mottling and drips without a discontinuous tile border', () => {
    const texture = campusSurfaceTexture(), data = pixelData(texture), size = 256;
    for (const channel of [0, 2]) {
      let seams = 0, neighbours = 0;
      for (let i = 0; i < size; i++) {
        seams += Math.abs(data[(i * size) * 4 + channel] - data[(i * size + size - 1) * 4 + channel]);
        seams += Math.abs(data[i * 4 + channel] - data[((size - 1) * size + i) * 4 + channel]);
        for (let j = 0; j < size - 1; j++) {
          neighbours += Math.abs(data[(i * size + j) * 4 + channel] - data[(i * size + j + 1) * 4 + channel]);
          neighbours += Math.abs(data[(j * size + i) * 4 + channel] - data[((j + 1) * size + i) * 4 + channel]);
        }
      }
      const seamMean = seams / (2 * size), neighbourMean = neighbours / (2 * size * (size - 1));
      expect(seamMean).toBeLessThan(neighbourMean * 2 + 0.5);
    }
    texture.dispose();
  });
});
