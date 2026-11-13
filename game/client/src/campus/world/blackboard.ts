import * as THREE from 'three';
import data from '../data/classroom.json';
import type { BuildingDef } from '../../../../shared/campus/campus_schema.ts';
import { DESK, storeyBoards, storeyClocks, SURF_BOARD, type BoardFace, type ClockSpot } from './classroom.ts';
import { SURF } from '../render/facade.ts';
import { boardDutyNames } from '../../../../shared/studentNames.ts';
import { Rng } from '../core/rng.ts';

/**
 * 教室② 黑板 (docs/03_campus.md 室内③): what is chalked on a classroom's front board (the day's notes, 值日表, the date
 * and the 高考 countdown) and on its back 黑板报, from data/classroom.json. All boards share one canvas atlas, a slot
 * per content key ('default' + every room the data gives its own board), redrawn when the game day changes; a storey's
 * board faces are one textured mesh under the building's interior material (lit like the room). The 钟 over each front
 * board (教室②b) rides in the same mesh: its dial is a row under the slots, its hands are two thin quads whose
 * vertices are rewritten every game minute. Pure apart from the canvas / mesh builders.
 */

interface FrontDef { notes: string[][]; duty: string[][] }
interface BackDef { title: string; columns: { head: string; lines: string[] }[] }
interface BoardDef { front?: Partial<FrontDef>; back?: BackDef }
interface ClassroomData { calendar: { start: [number, number]; weekday: number; exam: [number, number]; febDays: number }; boards: Record<string, BoardDef> }
export const CLASSROOM = data as unknown as ClassroomData;
type Calendar = ClassroomData['calendar'];

const MONTH_DAYS = (feb: number) => [31, feb, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const WEEK = ['一', '二', '三', '四', '五', '六', '日'];

/** Game day (0 = 9 月第 1 周周一 = the calendar's `start`) → month, day of month, weekday (0 = 周一). */
export function calendarDate(day: number, c: Calendar = CLASSROOM.calendar): { month: number; date: number; weekday: number } {
  const md = MONTH_DAYS(c.febDays), n = Math.max(0, Math.floor(day));
  let m = c.start[0], d = c.start[1] + n;
  while (d > md[m - 1]) { d -= md[m - 1]; m = (m % 12) + 1; }
  return { month: m, date: d, weekday: (c.weekday - 1 + n) % 7 };
}

/** Days left until 高考 (the first `exam` date after the start; 0 on the day and after). */
export function examCountdown(day: number, c: Calendar = CLASSROOM.calendar): number {
  const md = MONTH_DAYS(c.febDays);
  let n = 0, m = c.start[0], d = c.start[1];
  while (!(m === c.exam[0] && d === c.exam[1]) && n < 366) { n++; d++; if (d > md[m - 1]) { d = 1; m = (m % 12) + 1; } }
  return Math.max(0, n - Math.max(0, Math.floor(day)));
}

/** Which slot a room uses: its own key if the data gives it a board, else 'default'. */
export const boardKey = (key: string) => (key in CLASSROOM.boards ? key : 'default');
/** The board of a content key: the default's fields, the key's own over them. */
export function boardDef(key: string): { front: FrontDef; back: BackDef } {
  const base = CLASSROOM.boards.default, own = CLASSROOM.boards[boardKey(key)];
  return { front: { ...(base.front as FrontDef), ...own.front }, back: own.back ?? base.back! };
}

/** Everything on a front board on `day`: the notes page (rotating one a day), the day's 值日 (school days), date, countdown. */
export function frontText(key: string, day: number, seed = 0, namedMonitors = false) {
  const f = boardDef(key).front, cd = calendarDate(day), n = Math.max(0, Math.floor(day));
  const count = f.duty[cd.weekday % f.duty.length]?.length ?? 4;
  return {
    notes: f.notes[n % f.notes.length],
    duty: cd.weekday < 5 ? namedMonitors ? boardDutyNames(key, n, seed, count)
      : Array.from({ length: count }, (_, i) => `同学${'甲乙丙丁戊己庚辛壬癸'[i] ?? i + 1}`) : [],
    date: `${cd.month}月${cd.date}日 星期${WEEK[cd.weekday]}`,
    countdown: `距高考 ${examCountdown(day)} 天`,
  };
}

/**
 * Atlas layout (px): slots stacked down the canvas, each the front board (aspect of DESK.board, 4.2 × 1.2 m) over the
 * 黑板报 (3.6 × 1.2 m); under the last slot a `dial`-px row: the 钟 face, then a block of hand ink and one of rim
 * colour (sampled at a single texel, so they stay solid at any distance).
 */
export const ATLAS = { w: 1024, front: 292, backY: 300, back: 341, slot: 648, dial: 128 };
/** Canvas height for `n` slots + the dial row. */
export const atlasHeight = (n: number) => n * ATLAS.slot + ATLAS.dial;
/** Texel centres (canvas px) of the hand / rim blocks in the dial row (y from the row top). */
const HAND_TEXEL: [number, number] = [ATLAS.dial + 32, 32], RIM_TEXEL: [number, number] = [ATLAS.dial + 96, 32];
const FONT = '"WenQuanYi Zen Hei", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
const DIAL = '#ece7d9', HAND = '#262522', RIM = '#4d4a43';
const CHALK = '#f2f0e6', YELLOW = '#efdc8a', PINK = '#eab0a4', BLUE = '#b4cfe0', SLATE = '#4a6680', SLATE_B = '#46627c';

/** Chalk text: a hair off level and not quite opaque, as written by hand. */
function chalk(g: CanvasRenderingContext2D, rng: Rng, s: string, x: number, y: number, px: number, color = CHALK, bold = false): number {
  g.save();
  g.font = `${bold ? 'bold ' : ''}${px}px ${FONT}`;
  g.fillStyle = color; g.globalAlpha = 0.94;
  g.translate(x, y); g.rotate(rng.range(-0.008, 0.008));
  g.fillText(s, 0, 0);
  const w = g.measureText(s).width;
  g.restore();
  return w;
}

/**
 * Slate with eraser wipes (seeded: the same board every day, only the writing changes): soft-edged arcs of chalk dust
 * (a hard-edged faint box dithers into a visible rectangle under the palette pass).
 */
function slate(g: CanvasRenderingContext2D, rng: Rng, x: number, y: number, w: number, h: number, base: string): void {
  g.fillStyle = base; g.fillRect(x, y, w, h);
  g.save();
  g.beginPath(); g.rect(x, y, w, h); g.clip();
  g.filter = 'blur(10px)';
  g.strokeStyle = CHALK; g.lineCap = 'round';
  for (let i = 0; i < 10; i++) {
    g.globalAlpha = rng.range(0.035, 0.07); g.lineWidth = rng.range(22, 40);
    const cx = x + rng.range(60, w - 60), cy = y + rng.range(30, h - 30), r = rng.range(60, 140);
    g.beginPath(); g.arc(cx, cy + r * 0.6, r, Math.PI * 1.15, Math.PI * 1.85); g.stroke();
  }
  g.restore();
}

/** Draw one slot (front board + 黑板报 of content key `key` on game day `day`) with its top-left at canvas y `oy`. */
export function drawSlot(g: CanvasRenderingContext2D, key: string, day: number, oy: number, seed = 0, namedMonitors = false): void {
  const W = ATLAS.w, t = frontText(key, day, seed, namedMonitors), back = boardDef(key).back, rng = new Rng(7 + oy);
  g.textBaseline = 'top';
  // front: the lesson on the left two thirds (heading underlined), countdown / date / 值日 on the right
  slate(g, rng, 0, oy, W, ATLAS.front, SLATE);
  const hw = chalk(g, rng, t.notes[0], 28, oy + 14, 42, CHALK, true);
  g.fillStyle = CHALK; g.globalAlpha = 0.7; g.fillRect(28, oy + 62, Math.min(640, hw), 3); g.globalAlpha = 1;
  t.notes.slice(1, 6).forEach((s, i) => chalk(g, rng, s, 40, oy + 76 + i * 43, 36));
  const rx = 712;
  g.globalAlpha = 0.6; g.fillStyle = CHALK; g.fillRect(rx - 18, oy + 14, 2, ATLAS.front - 28); g.globalAlpha = 1;
  chalk(g, rng, t.countdown, rx, oy + 18, 38, YELLOW, true);
  g.strokeStyle = YELLOW; g.lineWidth = 3; g.globalAlpha = 0.8; g.strokeRect(rx - 8, oy + 10, 300, 56); g.globalAlpha = 1;
  chalk(g, rng, t.date, rx, oy + 82, 28);
  if (t.duty.length) {
    chalk(g, rng, '值日', rx, oy + 132, 30, PINK, true);
    t.duty.forEach((n, i) => chalk(g, rng, n, rx + (i % 2) * 130, oy + 176 + Math.floor(i / 2) * 44, 30));
  }
  // back: 黑板报, coloured chalk border, the title across the top, a column per piece with a coloured head
  const by = oy + ATLAS.backY, bh = ATLAS.back;
  slate(g, rng, 0, by, W, bh, SLATE_B);
  g.strokeStyle = PINK; g.lineWidth = 6; g.globalAlpha = 0.85; g.strokeRect(14, by + 14, W - 28, bh - 28); g.globalAlpha = 1;
  g.font = `bold 52px ${FONT}`;
  chalk(g, rng, back.title, (W - g.measureText(back.title).width) / 2, by + 30, 52, YELLOW, true);
  const cw = (W - 60) / back.columns.length;
  back.columns.forEach((c, k) => {
    const x = 30 + k * cw + 24;
    chalk(g, rng, c.head, x, by + 106, 34, [PINK, BLUE, YELLOW][k % 3], true);
    c.lines.forEach((s, i) => chalk(g, rng, !namedMonitors && c.head === '本周之星' && i === 0 ? '本班同学' : s, x, by + 156 + i * 40, 28));
    if (k > 0) { g.fillStyle = CHALK; g.globalAlpha = 0.45; g.fillRect(30 + k * cw, by + 108, 2, bh - 140); g.globalAlpha = 1; }
  });
}

/** The 钟 face (white dial, 60 minute ticks, heavier hours and quarters, dark rim, hub) at canvas y `oy`. */
export function drawDial(g: CanvasRenderingContext2D, oy: number): void {
  const D = ATLAS.dial, c = D / 2, R = D / 2;
  g.save();
  g.fillStyle = RIM; g.fillRect(0, oy, D, D);
  g.beginPath(); g.arc(c, oy + c, R * 0.88, 0, Math.PI * 2); g.fillStyle = DIAL; g.fill();
  g.strokeStyle = HAND; g.lineCap = 'butt';
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2, s = Math.sin(a), k = -Math.cos(a);
    const major = i % 5 === 0, quarter = i % 15 === 0;
    if (!major && D < 128) continue;
    const r0 = R * (quarter ? 0.62 : major ? 0.68 : 0.78), r1 = R * 0.82;
    g.lineWidth = quarter ? 6 : major ? 4 : 1.5;
    g.beginPath(); g.moveTo(c + s * r0, oy + c + k * r0); g.lineTo(c + s * r1, oy + c + k * r1); g.stroke();
  }
  g.beginPath(); g.arc(c, oy + c, R * 0.07, 0, Math.PI * 2); g.fillStyle = HAND; g.fill();
  // solid blocks the hands and the rim's edge sample
  g.fillStyle = HAND; g.fillRect(D, oy, 64, 64);
  g.fillStyle = RIM; g.fillRect(D + 64, oy, 64, 64);
  g.restore();
}

/** Clock hand angles (rad, clockwise from 12) at minute-of-day `minute`: hour = (h % 12 + m / 60)·30°, minute = m·6°. */
export function handAngles(minute: number): { hour: number; minute: number } {
  const t = ((Math.floor(minute) % 1440) + 1440) % 1440, h = Math.floor(t / 60), m = t % 60;
  return { hour: ((h % 12) + m / 60) * (Math.PI / 6), minute: m * (Math.PI / 30) };
}

/** The hands (DESK.clock radius r): length, width at the hub, how far they stand off the dial (m). */
export const HANDS = { hour: { len: 0.55, w: 0.034, z: 0.006 }, minute: { len: 0.85, w: 0.022, z: 0.011 }, tail: 0.16 };
const DIAL_SEGS = 24;

/** Content keys with a slot, in atlas order. */
export const atlasKeys = (): string[] => ['default', ...Object.keys(CLASSROOM.boards).filter(k => k !== 'default')];

/**
 * A storey's board faces as one mesh's attributes (building-local → world): UVs into the key's slot (front or back
 * half), white vertex colour (the texture is the colour), `surf` plain, normals from the face's side. Then each 钟:
 * the dial (a fan into the dial row), its rim (a band back to the wall, so the ink pass rings it), and last, from
 * `userData.hands` on, its two hands (`setHands` moves them).
 */
export function boardGeometry(b: BuildingDef, faces: (BoardFace & { key: string })[], keys = atlasKeys(), clocks: ClockSpot[] = []): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], col: number[] = [], uv: number[] = [], surf: number[] = [];
  const H = atlasHeight(keys.length);
  for (const f of faces) {
    const k = Math.max(0, keys.indexOf(boardKey(f.key))), y0 = k * ATLAS.slot + (f.part === 'front' ? 0 : ATLAS.backY);
    const y1 = y0 + (f.part === 'front' ? ATLAS.front : ATLAS.back);
    // canvas y down, texture v up (flipY): bottom-left, bottom-right, top-right, top-left
    const uvs = [[0, 1 - y1 / H], [1, 1 - y1 / H], [1, 1 - y0 / H], [0, 1 - y0 / H]];
    // the front 黑板 is tagged for its 黑板灯 (lit at night with the 日光灯); the back 黑板报 has none
    const n = sideNormal(f.n), tag = f.part === 'front' ? SURF_BOARD : 0;
    for (const i of [0, 1, 2, 0, 2, 3]) {
      const p = f.p[i];
      pos.push(b.x + p[0], p[1], b.z + p[2]); nor.push(...n); col.push(1, 1, 1); uv.push(...uvs[i]); surf.push(SURF.plain, tag);
    }
  }
  /** one triangle (world), wound to face `n` */
  const tri = (p: V3[], n: V3, t: [number, number][]) => {
    const e1 = sub(p[1], p[0]), e2 = sub(p[2], p[0]);
    const cx = e1[1] * e2[2] - e1[2] * e2[1], cy = e1[2] * e2[0] - e1[0] * e2[2], cz = e1[0] * e2[1] - e1[1] * e2[0];
    const order = cx * n[0] + cy * n[1] + cz * n[2] < 0 ? [0, 2, 1] : [0, 1, 2];
    for (const i of order) { pos.push(...p[i]); nor.push(...n); col.push(1, 1, 1); uv.push(...t[i]); surf.push(SURF.plain, 0); }
  };
  const tx = (x: number, y: number): [number, number] => [x / ATLAS.w, 1 - (keys.length * ATLAS.slot + y) / H];
  const D = ATLAS.dial, R = DESK.clock.r, off = DESK.clock.off, rim = tx(...RIM_TEXEL);
  for (const c of clocks) {
    const f = frameOf(b, c), face = f.at(0, 0, off);
    for (let i = 0; i < DIAL_SEGS; i++) {
      const a0 = (i / DIAL_SEGS) * Math.PI * 2, a1 = ((i + 1) / DIAL_SEGS) * Math.PI * 2;
      const dt = (a: number) => tx(D / 2 + Math.sin(a) * D / 2, D / 2 - Math.cos(a) * D / 2);
      tri([face, f.at(Math.sin(a0) * R, Math.cos(a0) * R, off), f.at(Math.sin(a1) * R, Math.cos(a1) * R, off)], f.n, [tx(D / 2, D / 2), dt(a0), dt(a1)]);
      // rim band: wall → face, normal outwards at the segment's middle
      const am = (a0 + a1) / 2, rn: V3 = [f.r[0] * Math.sin(am), Math.cos(am), f.r[2] * Math.sin(am)];
      const q = [f.at(Math.sin(a0) * R, Math.cos(a0) * R, 0), f.at(Math.sin(a1) * R, Math.cos(a1) * R, 0), f.at(Math.sin(a1) * R, Math.cos(a1) * R, off), f.at(Math.sin(a0) * R, Math.cos(a0) * R, off)];
      tri([q[0], q[1], q[2]], rn, [rim, rim, rim]); tri([q[0], q[2], q[3]], rn, [rim, rim, rim]);
    }
  }
  const hands = pos.length / 3, hand = tx(...HAND_TEXEL);
  for (let i = 0; i < clocks.length * 12; i++) { pos.push(0, 0, 0); nor.push(0, 0, 1); col.push(1, 1, 1); uv.push(...hand); surf.push(SURF.plain, 0); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('surf', new THREE.Float32BufferAttribute(surf, 2));
  g.userData.hands = hands;
  g.userData.clocks = clocks;
  g.userData.b = b;
  setHands(g, 0);
  g.computeBoundingSphere();
  return g;
}

type V3 = [number, number, number];
const sub = (p: V3, q: V3): V3 => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
const sideNormal = (n: ClockSpot['n']): V3 => (n[1] === 'x' ? [n[0] === '+' ? 1 : -1, 0, 0] : [0, 0, n[0] === '+' ? 1 : -1]);
/** A 钟's world frame: right r, normal n; `at(x, y, z)` = centre + x·right + y·up + z·normal (world). */
function frameOf(b: BuildingDef, c: ClockSpot) {
  const r: V3 = [c.r[0], 0, c.r[1]], n = sideNormal(c.n);
  const at = (x: number, y: number, z: number): V3 => [b.x + c.c[0] + r[0] * x + n[0] * z, c.c[1] + y, b.z + c.c[2] + r[2] * x + n[2] * z];
  return { r, n, at };
}

/**
 * Point every 钟 of a board geometry at minute-of-day `minute`: per hand one quad (tail → tip) in front of the dial,
 * the minute hand over the hour hand. Marks the attribute for upload; the bounds do not change.
 */
export function setHands(g: THREE.BufferGeometry, minute: number): void {
  const clocks = g.userData.clocks as ClockSpot[], b = g.userData.b as BuildingDef, start = g.userData.hands as number;
  if (!clocks?.length) return;
  const pos = g.getAttribute('position') as THREE.BufferAttribute, nor = g.getAttribute('normal') as THREE.BufferAttribute;
  const ang = handAngles(minute), R = DESK.clock.r, off = DESK.clock.off;
  let v = start;
  for (const c of clocks) {
    const f = frameOf(b, c);
    for (const [a, h] of [[ang.hour, HANDS.hour], [ang.minute, HANDS.minute]] as const) {
      // along the hand (dx, dy) and across it (its right, seen from the front), in the dial's right/up plane
      const dx = Math.sin(a), dy = Math.cos(a), px = Math.cos(a), py = -Math.sin(a);
      const w = h.w / 2, t0 = -HANDS.tail * R, t1 = h.len * R, z = off + h.z;
      const q = [[-w, t0], [w, t0], [w, t1], [-w, t1]].map(([u, s]) => f.at(px * u + dx * s, py * u + dy * s, z));
      for (const i of [0, 1, 2, 0, 2, 3]) { pos.setXYZ(v, ...q[i]); nor.setXYZ(v, ...f.n); v++; }
    }
  }
  pos.needsUpdate = true; nor.needsUpdate = true;
}

/**
 * The shared atlas: one canvas, every slot redrawn when the game day changes (`sync`), the dial row drawn once; the
 * 钟 hands of every storey mesh follow the game minute (`syncTime`). Without a DOM (unit tests) there is no canvas and
 * no texture: the boards then draw as their material's plain colour.
 */
export class Blackboards {
  readonly keys = atlasKeys();
  readonly texture: THREE.CanvasTexture | null = null;
  private g: CanvasRenderingContext2D | null = null;
  day = -1;
  private rosterSeed = 0;
  private namedMonitors = false;
  minute = -1;
  private geoms: THREE.BufferGeometry[] = [];
  constructor() {
    if (typeof document === 'undefined') return;
    const c = document.createElement('canvas');
    c.width = ATLAS.w; c.height = atlasHeight(this.keys.length);
    this.g = c.getContext('2d');
    if (!this.g) return;
    drawDial(this.g, this.keys.length * ATLAS.slot);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    this.texture = tex;
  }
  /** Repaint a shared room roster even when its calendar day did not change. */
  setRosterSeed(seed: number): void {
    if (this.rosterSeed === (seed >>> 0)) return;
    this.rosterSeed = seed >>> 0;
    this.redraw();
  }
  /** The authoritative room choice also applies to writing already prepared on the shared campus. */
  setNamedMonitors(enabled: boolean): void {
    if (this.namedMonitors === enabled) return;
    this.namedMonitors = enabled;
    this.redraw();
  }
  private redraw(): void {
    const day = this.day;
    this.day = -1;
    if (day >= 0) this.sync(day);
  }
  /** Redraw for game day `day` (no-op if unchanged). */
  sync(day: number): void {
    if (day === this.day || !this.g || !this.texture) return;
    this.day = day;
    this.keys.forEach((k, i) => drawSlot(this.g!, k, day, i * ATLAS.slot, this.rosterSeed, this.namedMonitors));
    this.texture.needsUpdate = true;
  }
  /** Turn the 钟 hands to minute-of-day `minute` (no-op if unchanged; hands move in whole minutes). */
  syncTime(minute: number): void {
    const m = Math.floor(minute);
    if (m === this.minute) return;
    this.minute = m;
    for (const g of this.geoms) setHands(g, m);
  }
  /**
   * The board mesh of one storey (null if it has no boards): its 黑板 / 黑板报 and 钟, under a copy of the interior
   * material with the atlas.
   */
  storeyMesh(b: BuildingDef, level: number, interior: THREE.MeshLambertMaterial): THREE.Mesh | null {
    const faces = storeyBoards(b, level);
    if (!faces.length) return null;
    const g = boardGeometry(b, faces, this.keys, storeyClocks(b, level));
    if (this.minute >= 0) setHands(g, this.minute);
    this.geoms.push(g);
    return new THREE.Mesh(g, this.material(interior));
  }
  private mats = new Map<THREE.Material, THREE.MeshLambertMaterial>();
  /** The building's interior material (same uniforms, same window-light patch) + the atlas as its map. */
  private material(interior: THREE.MeshLambertMaterial): THREE.MeshLambertMaterial {
    let m = this.mats.get(interior);
    if (!m) {
      m = new THREE.MeshLambertMaterial({ vertexColors: true, map: this.texture, color: this.texture ? 0xffffff : 0x38483e });
      m.onBeforeCompile = interior.onBeforeCompile;
      m.customProgramCacheKey = interior.customProgramCacheKey;
      m.userData.noSnow = true;
      this.mats.set(interior, m);
    }
    return m;
  }
}
