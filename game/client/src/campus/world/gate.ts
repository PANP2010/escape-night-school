import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { box, type AABB, type CollisionWorld } from '../../../../shared/campus/collision.ts';
import type { WallDef } from '../../../../shared/campus/campus_schema.ts';

/**
 * 南门 (南门②, docs/03_campus.md): the 电动伸缩门 across the gate gap of the perimeter wall, and its two 门柱.
 * Anchored at the east pillar (the 门卫室 side), stretched out west: a row of upright posts on little wheels running in
 * a ground rail, two tiers of crossed 剪刀 bars between each pair (the diamond lattice), and the 机头 at the free end
 * (a box with a dark 显示屏 on both faces). It opens by the clock (`wall.gateOpen`: 上学, 午饭, 晚饭, 放学): the 机头
 * rolls east and the lattice folds up against the anchor pillar (`open` 0 = shut against the west pillar, 1 = folded).
 * Pure parts list for tests; the render is one vertex-coloured mesh rewritten in place as it moves (`SlidingGate`),
 * the 显示屏's scrolling LED line (no school name, ever) one small unlit mesh riding on the 机头; the collision one
 * strip the gate's height from the 机头 to the anchor pillar, plus the pillars.
 */

export const GATE = {
  /** 门柱: plan size, height, cap (overhang, thickness) */ pillar: { w: 0.7, h: 3.0, cap: 0.08, capT: 0.14 },
  /** post spacing when shut (≈ 45° bars over two tiers), post section (along, deep), lattice from this height up */ bay: 0.62, post: [0.04, 0.06], low: 0.2,
  /** post spacing folded up, 机头 speed (m per real second: the lattice crawls, ≈ 20 s end to end) */ fold: 0.1, speed: 0.35,
  /** 剪刀 bar section (in plane, deep), its two layers this far either side of the posts */ bar: [0.032, 0.014], layer: 0.034,
  /** ground rail (wide, high), wheel under each post (along, high, deep) */ rail: [0.1, 0.035], wheel: [0.08, 0.13, 0.09],
  /** 机头 (along, deep, top), its 显示屏 (along, high, centre height) */ head: { w: 0.55, d: 0.42, h: 1.6 }, screen: [0.4, 0.2, 1.3],
  /**
   * the LED line: dots shown (across, high) at `pitch` m, `cell` texels per dot, a loop of `period` dots scrolling at
   * `rate` dots/s; lit / unlit dot and the gaps. Not 纯红 (docs/05: red and blue belong to the police car): an amber.
   */
  led: { dots: [36, 16], pitch: 0.01, cell: 3, period: 384, rate: 10, on: '#f0904c', off: '#3a2b22', gap: '#151110' },
};

export type GateKind = 'pillar' | 'cap' | 'rail' | 'wheel' | 'post' | 'bar' | 'head' | 'lid' | 'screen';
/** A box: centre, size, turned `rz` (rad) about the wall's normal (the 剪刀 bars) */
export interface GatePart { kind: GateKind; c: [number, number, number]; s: [number, number, number]; rz?: number }

const COLOR: Record<GateKind, string> = {
  pillar: '#a59b85', cap: '#c4bba6', rail: '#55534d', wheel: '#3e3d3a',
  post: '#a3a8a6', bar: '#b8bcb8', head: '#c8c5bb', lid: '#9fa3a0', screen: '#2c3133',
};

/** The gate span between the pillars' inner faces (world x), along the wall line z. */
export function gateSpan(w: WallDef): { x0: number; x1: number; z: number } {
  return { x0: w.gate[0] + w.t / 2, x1: w.gate[1] - w.t / 2, z: w.minZ };
}

/** Bays in the lattice: set by the shut gate's length (folding only narrows them). */
export function gateBays(w: WallDef): number {
  const { x0, x1 } = gateSpan(w);
  return Math.max(1, Math.round((x1 - x0 - GATE.head.w) / GATE.bay));
}

/** How far the 机头 rolls from shut to folded up. */
export function gateTravel(w: WallDef): number {
  const { x0, x1 } = gateSpan(w);
  return x1 - x0 - GATE.head.w - gateBays(w) * GATE.fold;
}

/** The 机头's west face (world x) at `open` ∈ [0, 1]. */
export const headX = (w: WallDef, open: number): number => gateSpan(w).x0 + Math.min(1, Math.max(0, open)) * gateTravel(w);

const hm = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
/** Whether the gate stands open at minute-of-day `minute` (one of `wall.gateOpen`'s [from, to) windows). */
export function gateOpenAt(w: WallDef, minute: number): boolean {
  const m = ((Math.floor(minute) % 1440) + 1440) % 1440;
  return (w.gateOpen ?? []).some(([a, b]) => m >= hm(a) && m < hm(b));
}

/** What the 显示屏 scrolls at minute-of-day `minute`: what a 机头 says to everyone, and the time. */
export function ledText(minute: number, daysLeft: number): string {
  const m = ((Math.floor(minute) % 1440) + 1440) % 1440, p = (n: number) => String(n).padStart(2, '0');
  return `进出校门　请下车推行　距高考${daysLeft}天　${p(Math.floor(m / 60))}:${p(m % 60)}`;
}

/** Every box of the gate and its pillars (world space), `open` ∈ [0, 1] (0 = shut). */
export function gateParts(w: WallDef, open = 0): GatePart[] {
  const G = GATE, { x0, x1, z } = gateSpan(w), H = w.gateH, out: GatePart[] = [];
  const add = (kind: GateKind, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, rz?: number) =>
    out.push({ kind, c: [cx, cy, cz], s: [sx, sy, sz], ...(rz ? { rz } : {}) });
  // 门柱 standing over the wall ends, a little proud of the wall either side, with a cap
  const P = G.pillar;
  for (const px of [x0 - P.w / 2, x1 + P.w / 2]) {
    add('pillar', px, P.h / 2, z, P.w, P.h, P.w);
    add('cap', px, P.h + P.capT / 2, z, P.w + 2 * P.cap, P.capT, P.w + 2 * P.cap);
  }
  add('rail', (x0 + x1) / 2, G.rail[1] / 2, z, x1 - x0, G.rail[1], G.rail[0]);
  // 机头 at the free (west) end, on its wheels
  const h0 = headX(w, open), hx = h0 + G.head.w / 2, wy = G.wheel[1];
  add('head', hx, (wy + G.head.h) / 2, z, G.head.w, G.head.h - wy, G.head.d);
  add('lid', hx, G.head.h + 0.02, z, G.head.w + 0.04, 0.04, G.head.d + 0.04);
  for (const s of [-1, 1]) add('screen', hx, G.screen[2], z + s * (G.head.d / 2 + 0.006), G.screen[0], G.screen[1], 0.012);
  for (const s of [-1, 1]) add('wheel', hx + s * G.head.w / 4, wy / 2, z, G.wheel[0], wy, G.wheel[2]);
  // the lattice: posts from the 机头 to the anchor pillar, crossed bars between neighbours in two tiers (steeper as
  // it folds: the same bays squeezed)
  const a = h0 + G.head.w, n = gateBays(w), step = (x1 - a) / n;
  const yb = G.low, yt = H - 0.05, tier = (yt - yb) / 2;
  for (let i = 0; i <= n; i++) {
    const x = a + i * step;
    add('post', x, (wy + H) / 2, z, G.post[0], H - wy, G.post[1]);
    add('wheel', x, wy / 2, z, G.wheel[0], wy, G.wheel[2]);
    if (i === n) break;
    const len = Math.hypot(step, tier), ang = Math.atan2(tier, step);
    for (let k = 0; k < 2; k++) {
      const cy = yb + tier * (k + 0.5);
      add('bar', x + step / 2, cy, z - G.layer, len, G.bar[0], G.bar[1], ang);
      add('bar', x + step / 2, cy, z + G.layer, len, G.bar[0], G.bar[1], -ang);
    }
  }
  return out;
}

/** What stops the walker: the pillars, and one strip the gate's height from the 机头 to the anchor pillar. */
export function gateColliders(w: WallDef, open = 0): AABB[] {
  const { x0, x1, z } = gateSpan(w), P = GATE.pillar, h0 = headX(w, open);
  return [
    box(x0 - P.w / 2, z, P.w, P.w, P.h), box(x1 + P.w / 2, z, P.w, P.w, P.h),
    box((h0 + x1) / 2, z, x1 - h0, 0.25, w.gateH),
  ];
}

const UNIT = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
const UP = UNIT.getAttribute('position').array as Float32Array, UN = UNIT.getAttribute('normal').array as Float32Array;
/** Lay the parts' boxes (36 vertices each) into position/normal arrays: a BoxGeometry of size `s`, turned `rz`, at `c`. */
function writeParts(parts: GatePart[], pos: Float32Array, nor: Float32Array): void {
  let o = 0;
  for (const p of parts) {
    const cs = Math.cos(p.rz ?? 0), sn = Math.sin(p.rz ?? 0);
    for (let i = 0; i < UP.length; i += 3, o += 3) {
      const x = UP[i] * p.s[0], y = UP[i + 1] * p.s[1];
      pos[o] = p.c[0] + x * cs - y * sn; pos[o + 1] = p.c[1] + x * sn + y * cs; pos[o + 2] = p.c[2] + UP[i + 2] * p.s[2];
      nor[o] = UN[i] * cs - UN[i + 1] * sn; nor[o + 1] = UN[i] * sn + UN[i + 1] * cs; nor[o + 2] = UN[i + 2];
    }
  }
}

/** The gate as one vertex-coloured geometry (one draw call); same vertex count at any `open`. */
export function gateGeometry(w: WallDef, open = 0): THREE.BufferGeometry {
  const parts = gateParts(w, open), n = parts.length * 36, c = new THREE.Color();
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3);
  writeParts(parts, pos, nor);
  parts.forEach((p, k) => { c.set(COLOR[p.kind]); for (let i = 0; i < 36; i++) col.set([c.r, c.g, c.b], (k * 36 + i) * 3); });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeBoundingSphere(); // the shut gate's: pillar to pillar, so it holds the 机头 wherever it rolls
  return g;
}

const FONT = '"WenQuanYi Zen Hei", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));

/**
 * The 电动伸缩门 in the scene. The clock says open or shut (`gateOpenAt`); the 机头 crawls there at `GATE.speed` (a
 * jump in game time snaps it), the mesh rewritten in place, the strip collider following the 机头: shrinking as it
 * opens, and while it shuts it stops short of anyone standing in its way (红外防夹). The 显示屏 dot matrix steps
 * one dot at a time; its text is redrawn when the minute changes.
 */
export class SlidingGate {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
  /** the LED line on both 显示屏, unlit (null without a DOM) */
  readonly led: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null = null;
  /** 0 = shut … 1 = folded up */
  open = 0;
  target = 0;
  text = '';
  private minute = NaN;
  private scroll = 0;
  private collision?: CollisionWorld;
  private strip = -1;
  private dots: CanvasRenderingContext2D | null = null;
  private img: { g: CanvasRenderingContext2D; data: ImageData } | null = null;
  /** `countdown`: game day → days to 高考 (world/blackboard.ts examCountdown; passed in, no import cycle) */
  readonly wall: WallDef;
  private countdown: (day: number) => number;

  constructor(wall: WallDef, countdown: (day: number) => number = () => 0) {
    this.wall = wall; this.countdown = countdown;
    this.mesh = new THREE.Mesh(gateGeometry(wall), new THREE.MeshLambertMaterial({ vertexColors: true }));
    if (typeof document === 'undefined') return;
    const L = GATE.led, W = L.period, H = L.dots[1], k = L.cell;
    const small = document.createElement('canvas'), big = document.createElement('canvas');
    small.width = W; small.height = H; big.width = W * k; big.height = H * k;
    const gs = small.getContext('2d', { willReadFrequently: true }), gb = big.getContext('2d');
    if (!gs || !gb) return;
    this.dots = gs; this.img = { g: gb, data: gb.createImageData(W * k, H * k) };
    const tex = new THREE.CanvasTexture(big);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.repeat.set(L.dots[0] / W, 1);
    tex.magFilter = THREE.NearestFilter;
    const w = L.dots[0] * L.pitch, h = L.dots[1] * L.pitch, zf = GATE.head.d / 2 + 0.014;
    const geo = mergeGeometries([
      new THREE.PlaneGeometry(w, h).translate(0, GATE.screen[2], zf),
      new THREE.PlaneGeometry(w, h).rotateY(Math.PI).translate(0, GATE.screen[2], -zf),
    ])!;
    this.led = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex }));
    this.led.name = 'GATE.led';
    this.place();
  }

  /** Hook up the collision world built from campusColliders (which holds the shut gate's strip). */
  attach(collision: CollisionWorld): void {
    const s = gateColliders(this.wall, 0)[2];
    this.strip = collision.boxes.findIndex(b => b.minX === s.minX && b.maxX === s.maxX && b.minZ === s.minZ && b.maxZ === s.maxZ && b.maxY === s.maxY);
    this.collision = collision;
    this.place();
  }

  /** One sim step: game day/minute-of-day, and who might be in the way (x, z, radius). */
  update(dt: number, day: number, minute: number, body?: { x: number; z: number; r: number }): void {
    const m = Math.floor(minute);
    if (m !== this.minute) {
      const d = ((m - this.minute) % 1440 + 1440) % 1440, jump = !(d <= 2 || d >= 1438);
      this.minute = m;
      this.target = gateOpenAt(this.wall, m) ? 1 : 0;
      if (jump && this.open !== this.target) { this.open = this.target; this.place(); }
      this.redraw(ledText(m, this.countdown(day)));
    }
    if (this.open !== this.target) {
      const step = GATE.speed * dt / gateTravel(this.wall);
      let next = this.target > this.open ? Math.min(this.target, this.open + step) : Math.max(this.target, this.open - step);
      if (next < this.open && body && this.pinches(next, body)) next = this.open;
      if (next !== this.open) { this.open = next; this.place(); }
    }
    this.scroll = (this.scroll + dt * GATE.led.rate / GATE.led.period) % 1;
    if (this.led) this.led.material.map!.offset.x = Math.floor(this.scroll * GATE.led.period) / GATE.led.period;
  }

  /** Would the 机头 rolling west to `next` sweep through the body? */
  private pinches(next: number, b: { x: number; z: number; r: number }): boolean {
    const { z } = gateSpan(this.wall);
    return b.x + b.r > headX(this.wall, next) - 0.05 && b.x - b.r < headX(this.wall, this.open) && Math.abs(b.z - z) < GATE.head.d / 2 + b.r;
  }

  private place(): void {
    const g = this.mesh.geometry, pos = g.getAttribute('position') as THREE.BufferAttribute, nor = g.getAttribute('normal') as THREE.BufferAttribute;
    writeParts(gateParts(this.wall, this.open), pos.array as Float32Array, nor.array as Float32Array);
    pos.needsUpdate = true; nor.needsUpdate = true;
    if (this.collision && this.strip >= 0) this.collision.move(this.strip, gateColliders(this.wall, this.open)[2]);
    this.led?.position.set(headX(this.wall, this.open) + GATE.head.w / 2, 0, gateSpan(this.wall).z);
  }

  /** Render `text` into the dot matrix: thresholded glyph pixels → lit / unlit dots with dark gaps between. */
  private redraw(text: string): void {
    if (text === this.text) return;
    this.text = text;
    if (!this.dots || !this.img || !this.led) return;
    const L = GATE.led, W = L.period, H = L.dots[1], k = L.cell, g = this.dots;
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#fff'; g.font = `${H - 2}px ${FONT}`; g.textBaseline = 'middle';
    g.fillText(text, 2, H / 2 + 1);
    const px = g.getImageData(0, 0, W, H).data, d = this.img.data.data, BW = W * k, ON = rgb(L.on), OFF = rgb(L.off), GAP = rgb(L.gap);
    for (let y = 0; y < H * k; y++) for (let x = 0; x < BW; x++) {
      const c = x % k === k - 1 || y % k === k - 1 ? GAP : px[((y / k | 0) * W + (x / k | 0)) * 4] > 110 ? ON : OFF, o = (y * BW + x) * 4;
      d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
    }
    this.img.g.putImageData(this.img.data, 0, 0);
    this.led.material.map!.needsUpdate = true;
  }
}
