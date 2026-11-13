// Shared procedural surface data and canvas textures.
import * as THREE from 'three';
import { mulberry32 } from '../../shared/rng.ts';

function canvasTex(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void, repeat = 1) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d')!, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 4;
  return t;
}

function noise(g: CanvasRenderingContext2D, s: number, amount: number, seed: number) {
  const rng = mulberry32(seed);
  const img = g.getImageData(0, 0, s, s);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rng() - 0.5) * amount;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
}

/** A smooth periodic field: lattice wrapping keeps both the value and slope continuous across a repeat. */
function periodicNoise(cells: number, seed: number) {
  const random = mulberry32(seed), values = Float32Array.from({ length: cells * cells }, random);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const at = (x: number, y: number) => values[((y % cells + cells) % cells) * cells + (x % cells + cells) % cells];
  const smooth = (v: number) => v * v * v * (v * (v * 6 - 15) + 10);
  return (u: number, v: number) => {
    const x = u * cells, y = v * cells, x0 = Math.floor(x), y0 = Math.floor(y);
    const tx = smooth(x - x0), ty = smooth(y - y0);
    const a = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
    const b = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
    return a * (1 - ty) + b * ty - mean + 0.5;
  };
}

/**
 * Campus surface data, sampled in world coordinates rather than requiring geometry UVs.
 * R = centred, broad plaster/worn-floor mottling; G = centred fine aggregate; B = sparse vertical damp trails.
 * All channels are linear data. Generation uses no DOM so the scene also constructs in Node unit tests.
 */
export function campusSurfaceTexture(): THREE.DataTexture {
  const size = 256, data = new Uint8Array(size * size * 4);
  const broad = periodicNoise(4, 0x53434f4c), medium = periodicNoise(8, 0x504c4153);
  const fine = periodicNoise(32, 0x54455252), warp = periodicNoise(4, 0x44414d50);
  const random = mulberry32(0x46494e45), dripRandom = mulberry32(0x4c45414b);
  const tau = Math.PI * 2;
  const drips = Array.from({ length: 18 }, () => ({
    x: dripRandom(), start: dripRandom(), length: 0.22 + dripRandom() * 0.48,
    width: 0.003 + dripRandom() * 0.008, phase: dripRandom(),
    bend: 1 + Math.floor(dripRandom() * 3), strength: 0.45 + dripRandom() * 0.55,
  }));
  const smoothstep = (a: number, b: number, x: number) => {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const byte = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size;
    const bend = (warp(u, v) - 0.5) * 0.08;
    const m = medium(u + bend, v - bend), b = broad(u, v), f = fine(u, v);
    let damp = 0;
    for (const drip of drips) {
      const age = (v - drip.start + 1) % 1;
      if (age >= drip.length) continue;
      const centre = drip.x + Math.sin(tau * (v * drip.bend + drip.phase)) * drip.width * 0.8;
      const raw = u - centre, dx = Math.abs(raw - Math.round(raw));
      const width = drip.width * (0.65 + m * 0.7);
      const edge = 1 - smoothstep(width * 0.2, width * 1.8, dx);
      const ends = smoothstep(0, 0.045, age) * (1 - smoothstep(drip.length - 0.12, drip.length, age));
      damp = Math.max(damp, edge * ends * drip.strength * (0.7 + f * 0.3));
    }
    const i = (y * size + x) * 4;
    data[i] = byte(0.5 + (b - 0.5) * 0.5 + (m - 0.5) * 0.55 + (f - 0.5) * 0.12);
    data[i + 1] = byte(0.5 + (random() - 0.5) * 0.85 + (f - 0.5) * 0.15);
    data[i + 2] = byte(damp);
    data[i + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.name = 'campus-surface-data';
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

/** School wall: off-white plaster above, pale green 墙裙 below with a dark stripe. */
export const wallTexture = () => canvasTex(256, (g, s) => {
  g.fillStyle = '#c9c7bb'; g.fillRect(0, 0, s, s);
  g.fillStyle = '#6f8a6e'; g.fillRect(0, s * 0.62, s, s * 0.38);
  g.fillStyle = '#3d4a3c'; g.fillRect(0, s * 0.6, s, s * 0.025);
  noise(g, s, 26, 7);
});

export const floorTexture = () => canvasTex(256, (g, s) => {
  g.fillStyle = '#8c8a80'; g.fillRect(0, 0, s, s);
  g.strokeStyle = '#5d5b54'; g.lineWidth = 2;
  for (let k = 0; k <= 4; k++) {
    g.beginPath(); g.moveTo(0, (k * s) / 4); g.lineTo(s, (k * s) / 4); g.stroke();
    g.beginPath(); g.moveTo((k * s) / 4, 0); g.lineTo((k * s) / 4, s); g.stroke();
  }
  noise(g, s, 30, 11);
}, 1);

export const ceilingTexture = () => canvasTex(128, (g, s) => {
  g.fillStyle = '#a9a89f'; g.fillRect(0, 0, s, s);
  noise(g, s, 18, 3);
});
