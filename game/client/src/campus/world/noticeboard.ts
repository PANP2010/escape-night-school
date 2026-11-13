import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import data from '../data/noticeboard.json';
import type { AABB } from '../../../../shared/campus/collision.ts';
import type { Side } from '../../../../shared/campus/campus_schema.ts';
import { Rng } from '../core/rng.ts';

/**
 * 宣传栏 (南门④, docs/03_campus.md): glass-fronted notice cabinets along the 中轴 sidewalks, from data/noticeboard.json.
 * A cabinet = two legs, a shallow steel box with a canopy, a frame with mullions splitting the front into bays; behind
 * the frame (no glass mesh: the glass is a sheen painted onto the paper) each bay shows one sheet. Sheets are drawn on
 * one shared canvas atlas, a slot per bay of every cabinet; the story swaps a bay's sheet (`Noticeboards.set`, e.g.
 * the 寻人启事 over the 校园卡照片栏) and only that slot is redrawn. Two draw calls for all cabinets: the steel
 * (vertex-coloured) and the paper (the atlas). Pure apart from the canvas / mesh builders.
 */

type Kind = 'notice' | 'table' | 'honor' | 'photos' | 'poster' | 'brush';
export interface SheetDef {
  kind: Kind; paper: string; title: string; sub?: string; lines?: string[]; rows?: string[][];
  people?: { name: string; class: string; odd?: boolean }[]; columns?: string[]; sign?: string; date?: string;
  /** game day it went up (negative = before the game starts); ages the paper (GLOW.tau) */
  posted?: number;
}
export interface CabinetDef { id: string; name: string; x: number; z: number; facing: Side; panels: string[] }
interface BoardData { cabinets: CabinetDef[]; sheets: Record<string, SheetDef> }
export const NOTICE = data as unknown as BoardData;

/** Cabinet size (m): bay (wide, high), bay bottom, frame bar, box depth behind the glass line, canopy, legs. */
export const CAB = {
  bay: [1.42, 1.12] as const, y0: 0.82, bar: 0.06, depth: 0.26, recess: 0.045,
  canopy: { h: 0.09, over: 0.16, front: 0.24, gap: 0.12 }, leg: 0.08, plinth: [0.3, 0.06] as const,
  steel: '#66726c', body: '#525c57', canopyC: '#7c8781', legC: '#4a524e', plinthC: '#a29a88',
};
/** Atlas slot (px, aspect of CAB.bay), two slots a row. */
export const SLOT = { w: 512, h: 404, cols: 2 };
/**
 * 夜灯 + 变旧 (打磨批次②⑥). A 日光灯管 under each canopy front, on with the street lamps: no light source, the tube
 * and the paper are emissive (the paper × its own colour, brighter near the tube). The sheets yellow, fade and stain
 * with the days since they went up (age = 1 - e^(-days / tau), all in the paper shader: no atlas redraw); while the
 * ground is wet the paper goes damp and the glass mists from the bottom.
 */
export const GLOW = {
  /** tube box in the cabinet frame: u inset from the cabinet ends, y below the canopy underside, w out of the glass */
  tube: { inset: 0.14, y: [-0.092, -0.06] as [number, number], w: [0.075, 0.105] as [number, number] },
  /** emissive gain: tube, paper at the top / bottom of a bay */
  tubeGain: 3, top: 0.95, bottom: 0.4,
  color: '#e4ecf2', tubeC: '#eef1ec', bracketC: '#8a948e',
  /** days to ~63% aged; a sheet without `posted` went up this many days before day 0 */
  tau: 120, posted: -7,
};
export const sheetAge = (days: number) => days <= 0 ? 0 : 1 - Math.exp(-days / GLOW.tau);

/** A cabinet's frame: outward normal n, viewer's right r (= forward × up), `at(u, y, w)` = world point. */
export function cabinetFrame(c: CabinetDef) {
  const n: [number, number] = c.facing[1] === 'x' ? [c.facing[0] === '+' ? 1 : -1, 0] : [0, c.facing[0] === '+' ? 1 : -1];
  const r: [number, number] = [n[1], -n[0]];
  const at = (u: number, y: number, w: number): [number, number, number] => [c.x + r[0] * u + n[0] * w, y, c.z + r[1] * u + n[1] * w];
  return { n, r, at };
}
/** Total width of a cabinet's front (bays + bars). */
export const cabinetWidth = (c: CabinetDef) => c.panels.length * CAB.bay[0] + (c.panels.length + 1) * CAB.bar;
const topY = () => CAB.y0 + CAB.bay[1] + CAB.bar + CAB.canopy.gap + CAB.canopy.h;

/** A box in the cabinet's frame: u (right), y, w (out of the glass) ranges, its colour. */
export interface CabPart { u: [number, number]; y: [number, number]; w: [number, number]; color: string }
export function cabinetParts(c: CabinetDef): CabPart[] {
  const L = cabinetWidth(c), h = L / 2, b = CAB.bar, y0 = CAB.y0 - b, y1 = CAB.y0 + CAB.bay[1] + b, out: CabPart[] = [];
  const add = (u: [number, number], y: [number, number], w: [number, number], color: string) => out.push({ u, y, w, color });
  // the box behind the paper (its front a hair behind the paper faces), and the header strip up to the canopy
  add([-h, h], [y0, y1], [-CAB.depth, -CAB.recess - 0.012], CAB.body);
  add([-h, h], [y1, y1 + CAB.canopy.gap], [-CAB.depth, -0.02], CAB.steel);
  // frame: top, bottom (a deeper sill), sides and mullions, standing proud of the paper to the glass line
  add([-h, h], [y1 - b, y1], [-CAB.recess - 0.012, 0], CAB.steel);
  add([-h, h], [y0, y0 + b], [-CAB.recess - 0.012, 0.03], CAB.steel);
  for (let i = 0; i <= c.panels.length; i++) { const u = -h + i * (CAB.bay[0] + b); add([u, u + b], [y0 + b, y1 - b], [-CAB.recess - 0.012, 0], CAB.steel); }
  // canopy: overhangs the sides and the front, a drip lip under its front edge
  const o = CAB.canopy.over, cy = y1 + CAB.canopy.gap;
  add([-h - o, h + o], [cy, cy + CAB.canopy.h], [-CAB.depth - 0.04, CAB.canopy.front], CAB.canopyC);
  add([-h - o, h + o], [cy - 0.05, cy], [CAB.canopy.front - 0.03, CAB.canopy.front], CAB.canopyC);
  // 灯管 end caps hung from the canopy (the tube itself is in the paper mesh, emissive)
  const t = GLOW.tube;
  for (const s of [-1, 1]) {
    const u = s * (h - t.inset);
    add(s < 0 ? [u - 0.05, u] : [u, u + 0.05], [cy + t.y[0] - 0.008, cy], [t.w[0] - 0.008, t.w[1] + 0.008], GLOW.bracketC);
  }
  // legs and their concrete plinths
  for (const s of [-1, 1]) {
    const u = s * (h - 0.35), wc = -CAB.depth / 2;
    add([u - CAB.leg / 2, u + CAB.leg / 2], [CAB.plinth[1], y0], [wc - CAB.leg / 2, wc + CAB.leg / 2], CAB.legC);
    add([u - CAB.plinth[0] / 2, u + CAB.plinth[0] / 2], [0, CAB.plinth[1]], [wc - CAB.plinth[0] / 2, wc + CAB.plinth[0] / 2], CAB.plinthC);
  }
  return out;
}

/** World AABB of a part list (min/max over the frame-turned corners). */
function partBox(c: CabinetDef, p: CabPart): AABB {
  const f = cabinetFrame(c), a = f.at(p.u[0], p.y[0], p.w[0]), b = f.at(p.u[1], p.y[1], p.w[1]);
  return { minX: Math.min(a[0], b[0]), minY: p.y[0], minZ: Math.min(a[2], b[2]), maxX: Math.max(a[0], b[0]), maxY: p.y[1], maxZ: Math.max(a[2], b[2]) };
}

/** One collider per cabinet: the box from the ground to the canopy, glass line to back (legs included). */
export function cabinetColliders(cabs: CabinetDef[] = NOTICE.cabinets): AABB[] {
  return cabs.map(c => {
    const h = cabinetWidth(c) / 2;
    return partBox(c, { u: [-h, h], y: [0, topY()], w: [-CAB.depth, 0.03], color: '' });
  });
}

/** Bay `i` of a cabinet: its centre u and the paper's four corners (world, bottom-left, bottom-right, top-right, top-left). */
export function bayQuad(c: CabinetDef, i: number): [number, number, number][] {
  const f = cabinetFrame(c), h = cabinetWidth(c) / 2, u0 = -h + CAB.bar + i * (CAB.bay[0] + CAB.bar), u1 = u0 + CAB.bay[0];
  const y0 = CAB.y0, y1 = CAB.y0 + CAB.bay[1], w = -CAB.recess;
  return [f.at(u0, y0, w), f.at(u1, y0, w), f.at(u1, y1, w), f.at(u0, y1, w)];
}

/** Slot list: one per bay of every cabinet, in data order. */
export function slots(cabs: CabinetDef[] = NOTICE.cabinets): { cab: string; bay: number }[] {
  return cabs.flatMap(c => c.panels.map((_, bay) => ({ cab: c.id, bay })));
}
export const atlasSize = (n: number) => ({ w: SLOT.w * SLOT.cols, h: SLOT.h * Math.ceil(n / SLOT.cols) });
/** A cabinet's 灯管 as a frame part: between the end caps, under the canopy, in front of the glass. */
export function tubePart(c: CabinetDef): CabPart {
  const h = cabinetWidth(c) / 2, t = GLOW.tube, cy = topY() - CAB.canopy.h;
  return { u: [-h + t.inset, h - t.inset], y: [cy + t.y[0], cy + t.y[1]], w: t.w, color: GLOW.tubeC };
}
/** Top-left (px) of slot `k`. */
export const slotOrigin = (k: number): [number, number] => [(k % SLOT.cols) * SLOT.w, Math.floor(k / SLOT.cols) * SLOT.h];
const FONT = '"WenQuanYi Zen Hei", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
const INK = '#2b2a27', INK_SOFT = '#55524b', RED = '#8e3b30', BACKING = '#5e6b62', TAPE = '#d8cfae';

/** Text at a px size, left-aligned unless `align`; returns its width. */
function text(g: CanvasRenderingContext2D, s: string, x: number, y: number, px: number, color = INK, opts: { bold?: boolean; align?: CanvasTextAlign } = {}): number {
  g.font = `${opts.bold ? 'bold ' : ''}${px}px ${FONT}`;
  g.fillStyle = color; g.textAlign = opts.align ?? 'left';
  g.fillText(s, x, y);
  return g.measureText(s).width;
}

/** A sheet's paper rect inside the slot (px from the slot's top-left): a margin of backing board shows round it. */
export const PAPER = { x: 22, y: 18, w: SLOT.w - 44, h: SLOT.h - 34 };

/**
 * Draw one bay at slot origin (ox, oy): the backing board, the sheet (paper, taped corners, slightly askew, its
 * content by kind), and the glass: a soft diagonal sheen over everything. Ageing and the night glow are in the
 * paper shader (patchPaper), not redrawn here.
 * `seed` keeps tilt and tape the same every redraw.
 */
export function drawBay(g: CanvasRenderingContext2D, s: SheetDef | undefined, ox: number, oy: number, seed: number): void {
  const rng = new Rng(seed * 7919 + 13);
  g.save();
  g.beginPath(); g.rect(ox, oy, SLOT.w, SLOT.h); g.clip();
  g.fillStyle = BACKING; g.fillRect(ox, oy, SLOT.w, SLOT.h);
  // pin holes and pale squares where older sheets were
  g.fillStyle = '#6b786e';
  for (let i = 0; i < 3; i++) g.fillRect(ox + rng.range(10, SLOT.w - 120), oy + rng.range(10, SLOT.h - 120), rng.range(60, 140), rng.range(40, 110));
  if (s) {
    const { x, y, w, h } = PAPER;
    g.save();
    g.translate(ox + x + w / 2, oy + y + h / 2); g.rotate(rng.range(-0.012, 0.012)); g.translate(-w / 2, -h / 2);
    g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(4, 5, w, h);
    g.fillStyle = s.paper; g.fillRect(0, 0, w, h);
    g.textBaseline = 'top';
    CONTENT[s.kind](g, s, w, h, rng);
    // 胶带 at the corners
    g.fillStyle = TAPE; g.globalAlpha = 0.8;
    // short strips across the two top corners, one lower corner (the other has come unstuck)
    for (const [cx, cy, a] of [[0, 0, -0.75], [w, 0, 0.75], rng.next() < 0.5 ? [0, h, 0.75] : [w, h, -0.75]]) {
      g.save(); g.translate(cx, cy); g.rotate(a + rng.range(-0.15, 0.15)); g.fillRect(-14, -5, 28, 10); g.restore();
    }
    g.restore();
  }
  // glass: a broad soft sheen across the bay, and a darker band at the top under the canopy
  const sh = g.createLinearGradient(ox, oy, ox + SLOT.w, oy + SLOT.h);
  sh.addColorStop(0.0, 'rgba(255,255,255,0)'); sh.addColorStop(0.32, 'rgba(255,255,255,0)');
  sh.addColorStop(0.42, 'rgba(255,255,255,0.13)'); sh.addColorStop(0.5, 'rgba(255,255,255,0.04)'); sh.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = sh; g.globalAlpha = 1; g.fillRect(ox, oy, SLOT.w, SLOT.h);
  const top = g.createLinearGradient(0, oy, 0, oy + 50);
  top.addColorStop(0, 'rgba(20,24,22,0.35)'); top.addColorStop(1, 'rgba(20,24,22,0)');
  g.fillStyle = top; g.fillRect(ox, oy, SLOT.w, 50);
  g.restore();
}

type Draw = (g: CanvasRenderingContext2D, s: SheetDef, w: number, h: number, rng: Rng) => void;
const CONTENT: Record<Kind, Draw> = {
  // 通知: title centred, body lines, the issuing office and date bottom right with a red stamp ring
  notice(g, s, w, h) {
    text(g, s.title, w / 2, 26, 26, INK, { bold: true, align: 'center' });
    (s.lines ?? []).forEach((l, i) => text(g, l, 26, 80 + i * 36, 22));
    const sy = h - 74;
    text(g, s.sign ?? '', w - 40, sy, 22, INK, { align: 'right' });
    text(g, s.date ?? '', w - 40, sy + 32, 20, INK_SOFT, { align: 'right' });
    g.strokeStyle = RED; g.globalAlpha = 0.7; g.lineWidth = 3;
    g.beginPath(); g.arc(w - 82, sy + 22, 34, 0, Math.PI * 2); g.stroke(); g.globalAlpha = 1;
  },
  // 表格: title, a ruled two-column table
  table(g, s, w) {
    text(g, s.title, w / 2, 22, 26, INK, { bold: true, align: 'center' });
    const rows = s.rows ?? [], x0 = 40, x1 = w - 40, xm = x0 + (x1 - x0) * 0.42, y0 = 70, rh = 38;
    g.strokeStyle = INK_SOFT; g.lineWidth = 1.5;
    for (let i = 0; i <= rows.length; i++) { g.beginPath(); g.moveTo(x0, y0 + i * rh); g.lineTo(x1, y0 + i * rh); g.stroke(); }
    for (const x of [x0, xm, x1]) { g.beginPath(); g.moveTo(x, y0); g.lineTo(x, y0 + rows.length * rh); g.stroke(); }
    rows.forEach((r, i) => { text(g, r[0], (x0 + xm) / 2, y0 + i * rh + 8, 22, INK, { align: 'center' }); text(g, r[1], (xm + x1) / 2, y0 + i * rh + 8, 22, INK, { align: 'center' }); });
  },
  // 光荣榜: red paper, gold-ish title, a ranked list in two columns of five
  honor(g, s, w, h) {
    g.strokeStyle = '#e1c27a'; g.lineWidth = 4; g.strokeRect(10, 10, w - 20, h - 20);
    text(g, s.title, w / 2, 22, 40, '#f0d68f', { bold: true, align: 'center' });
    text(g, s.sub ?? '', w / 2, 74, 18, '#f3e7cf', { align: 'center' });
    const rows = s.rows ?? [], cw = (w - 40) / 2;
    rows.forEach((r, i) => {
      const col = Math.floor(i / 5), x = 26 + col * cw, y = 112 + (i % 5) * 46;
      text(g, r[0], x + 14, y, 22, '#f0d68f', { bold: true, align: 'center' });
      text(g, r[1], x + 36, y, 22, '#fbf3e2', { bold: true });
      text(g, r[2], x + 36, y + 25, 15, '#fbf3e2');
      text(g, r[3], x + cw - 22, y + 4, 20, '#f6e2a6', { bold: true, align: 'right' });
    });
  },
  // 校园卡照片栏: a grid of ID photos (faceless head-and-shoulders on a pale blue ground), name and class under each
  photos(g, s, w, h, rng) {
    text(g, s.title, w / 2, 14, 24, INK, { bold: true, align: 'center' });
    text(g, s.sub ?? '', w / 2, 46, 14, INK_SOFT, { align: 'center' });
    const ps = s.people ?? [], cols = 6, pw = 58, ph = 76, gx = (w - cols * pw) / (cols + 1), y0 = 72;
    const gy = (h - y0 - 2 * (ph + 30)) / 2.2;
    ps.forEach((p, i) => {
      const cx = gx + (i % cols) * (pw + gx), cy = y0 + Math.floor(i / cols) * (ph + 30 + gy);
      idPhoto(g, cx, cy, pw, ph, rng, !!p.odd);
      text(g, p.name, cx + pw / 2, cy + ph + 4, 15, INK, { align: 'center' });
      text(g, p.class, cx + pw / 2, cy + ph + 21, 11, INK_SOFT, { align: 'center' });
    });
  },
  // 标语: a red head band, big lines
  poster(g, s, w, h) {
    g.fillStyle = RED; g.fillRect(0, 0, w, 66);
    text(g, s.title, w / 2, 16, 32, '#f3ead6', { bold: true, align: 'center' });
    (s.lines ?? []).forEach((l, i) => {
      g.fillStyle = INK; g.fillRect(40, 104 + i * 58, 10, 10);
      text(g, l, 66, 94 + i * 58, 26, INK);
    });
    text(g, s.sign ?? '', w - 30, h - 40, 18, INK_SOFT, { align: 'right' });
  },
  // 书法: columns right to left, brush-heavy (bold, slightly uneven), a small red seal
  brush(g, s, w, h, rng) {
    const cols = s.columns ?? [], px = 30, top = 34;
    cols.forEach((c, k) => {
      const x = w - 90 - k * 92;
      [...c].forEach((ch, i) => {
        g.save(); g.translate(x, top + i * (px + 6)); g.rotate(rng.range(-0.05, 0.05));
        text(g, ch, 0, 0, px + rng.range(-2, 3), '#1f1e1b', { bold: true, align: 'center' }); g.restore();
      });
    });
    text(g, s.title, 30, 30, 16, INK_SOFT);
    const sx = 40, sy = h - 120;
    [...(s.sign ?? '')].forEach((ch, i) => text(g, ch, sx + 10, sy - 140 + i * 18, 15, INK_SOFT, { align: 'center' }));
    g.fillStyle = RED; g.globalAlpha = 0.8; g.fillRect(sx, sy + 20, 26, 26); g.globalAlpha = 1;
  },
};

/**
 * One ID photo: pale blue ground, a faceless silhouette (head + shoulders, uniform collar). The `odd` one (角色122's)
 * was taken mid-blink-and-sneeze: the head cut off at the top of the frame, tilted, the whole photo overexposed.
 */
function idPhoto(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, rng: Rng, odd: boolean): void {
  g.save();
  g.beginPath(); g.rect(x, y, w, h); g.clip();
  g.fillStyle = odd ? '#c4d3da' : '#8fa6b4'; g.fillRect(x, y, w, h);
  const cx = x + w / 2 + (odd ? 9 : rng.range(-1.5, 1.5)), hy = y + (odd ? h * 0.2 : h * 0.4), r = w * 0.24;
  g.translate(cx, hy); g.rotate(odd ? 0.28 : 0); g.translate(-cx, -hy);
  const skin = odd ? '#d8c4b0' : '#b39a84', hair = odd ? '#4a443e' : '#2c2a27';
  // shoulders (校服) then neck, head, hair
  g.fillStyle = odd ? '#7287a0' : '#3f526a';
  g.beginPath(); g.ellipse(cx, y + h + 6, w * 0.5, h * 0.36, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#e8e6df'; g.beginPath(); g.moveTo(cx - 8, y + h * 0.74); g.lineTo(cx, y + h * 0.86); g.lineTo(cx + 8, y + h * 0.74); g.fill();
  g.fillStyle = skin; g.fillRect(cx - 6, hy + r * 0.6, 12, h * 0.2);
  g.beginPath(); g.ellipse(cx, hy, r, r * 1.2, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = hair; g.beginPath(); g.ellipse(cx, hy - r * 0.45, r * 1.05, r * 0.8, 0, Math.PI, Math.PI * 2); g.fill();
  if (odd) {
    // two squeezed-shut eye lines and a mouth caught open (still no face: three strokes)
    g.strokeStyle = '#5a4a3e'; g.lineWidth = 1.5;
    for (const s of [-1, 1]) { g.beginPath(); g.moveTo(cx + s * r * 0.55, hy + 1); g.lineTo(cx + s * r * 0.15, hy + 3); g.stroke(); }
    g.fillStyle = '#5a4a3e'; g.beginPath(); g.ellipse(cx, hy + r * 0.62, 3, 4, 0, 0, Math.PI * 2); g.fill();
  }
  g.restore();
  g.strokeStyle = '#d9d6cc'; g.lineWidth = 2; g.strokeRect(x, y, w, h);
}

/** The steel of every cabinet as one vertex-coloured geometry. */
export function cabinetGeometry(cabs: CabinetDef[] = NOTICE.cabinets): THREE.BufferGeometry {
  const geos = cabs.flatMap(c => cabinetParts(c).map(p => {
    const b = partBox(c, p), g = new THREE.BoxGeometry(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ).toNonIndexed();
    g.translate((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2);
    g.deleteAttribute('uv');
    const col = new THREE.Color(p.color), n = g.getAttribute('position').count, a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) a.set([col.r, col.g, col.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    return g;
  }));
  return mergeGeometries(geos)!;
}

/**
 * The paper faces: a quad per bay, UVs into its atlas slot (canvas y down, texture v up); then each cabinet's 灯管 box.
 * `nb` = (tube 0|1, slot k + bay u, bay v, age): the paper shader's mask, stain seed, glow gradient (patchPaper);
 * age is filled per slot by Noticeboards (vertices 6k..6k+5).
 */
export function paperGeometry(cabs: CabinetDef[] = NOTICE.cabinets): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], nb: number[] = [], all = slots(cabs), A = atlasSize(all.length);
  all.forEach(({ cab, bay }, k) => {
    const c = cabs.find(q => q.id === cab)!, q = bayQuad(c, bay), f = cabinetFrame(c), [ox, oy] = slotOrigin(k);
    const u0 = ox / A.w, u1 = (ox + SLOT.w) / A.w, v0 = 1 - (oy + SLOT.h) / A.h, v1 = 1 - oy / A.h;
    const t = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]], local = [[0, 0], [1, 0], [1, 1], [0, 1]];
    for (const i of [0, 1, 2, 0, 2, 3]) {
      pos.push(...q[i]); nor.push(f.n[0], 0, f.n[1]); uv.push(...t[i]); nb.push(0, k + local[i][0] * 0.998, local[i][1], 0);
    }
  });
  for (const c of cabs) {
    const b = partBox(c, tubePart(c)), g = new THREE.BoxGeometry(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ).toNonIndexed();
    g.translate((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2);
    pos.push(...g.getAttribute('position').array); nor.push(...g.getAttribute('normal').array);
    for (let i = 0; i < g.getAttribute('position').count; i++) { uv.push(0, 0); nb.push(1, 0, 0, 0); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('nb', new THREE.Float32BufferAttribute(nb, 4));
  return g;
}

/** sRGB hex → linear GLSL vec3 literal. */
const vec3 = (hex: string) => { const c = new THREE.Color(hex); return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`; };
/**
 * Patch the paper material (GLOW): sun-faded, yellowed, tide-marked and foxed by `nb.w` (age) on the sheet only (not
 * the backing board round it); damp and misted glass by `nbDamp`; at night (`nbLamp`) the bay glows by its own colour,
 * brightest under the tube, and the tube itself shines. Returns the uniforms.
 */
export function patchPaper(mat: THREE.MeshLambertMaterial): { nbLamp: { value: number }; nbDamp: { value: number } } {
  const u = { nbLamp: { value: 0 }, nbDamp: { value: 0 } }, f = (v: number) => v.toFixed(4);
  const px = [PAPER.x / SLOT.w, (PAPER.x + PAPER.w) / SLOT.w, 1 - (PAPER.y + PAPER.h) / SLOT.h, 1 - PAPER.y / SLOT.h];
  mat.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 nb; varying vec4 vNb;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvNb = nb;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float nbLamp, nbDamp; varying vec4 vNb;
        float nbHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float nbNoise(vec2 p){ vec2 i = floor(p), q = fract(p); q = q * q * (3.0 - 2.0 * q);
          return mix(mix(nbHash(i), nbHash(i + vec2(1, 0)), q.x), mix(nbHash(i + vec2(0, 1)), nbHash(i + vec2(1, 1)), q.x), q.y); }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        if (vNb.x > 0.5) diffuseColor.rgb = ${vec3(GLOW.tubeC)};
        else {
          float bu = fract(vNb.y), bv = vNb.z, age = vNb.w;
          vec2 p = vec2(bu, bv) + floor(vNb.y) * 17.31;
          float sheet = step(${f(px[0])}, bu) * step(bu, ${f(px[1])}) * step(${f(px[2])}, bv) * step(bv, ${f(px[3])});
          vec3 c = diffuseColor.rgb, a = c;
          // sun-faded: colours wash toward grey, ink toward the paper, the whole sheet yellows
          a = mix(a, vec3(dot(a, vec3(0.2126, 0.7152, 0.0722))), 0.3 * age);
          a += (vec3(0.5) - a) * 0.15 * age;
          a *= mix(vec3(1.0), vec3(1.0, 0.78, 0.48), age);
          // rain seeps in under the frame: irregular blotches rising from the bottom edge, paler inside, a brown tide ring
          float st = nbNoise(p * vec2(5.0, 4.0)) * 0.55 + nbNoise(p * vec2(13.0, 11.0)) * 0.25 - (bv - ${f(px[2])}) * 1.6;
          float T = 0.62 - 0.42 * age;
          a *= mix(vec3(1.0), vec3(0.93, 0.85, 0.7), smoothstep(T - 0.01, T + 0.01, st) * age);
          a *= mix(vec3(1.0), vec3(0.66, 0.53, 0.38), smoothstep(0.025, 0.0, abs(st - T)) * min(1.0, age * 1.6));
          // foxing: rust spots
          a *= mix(vec3(1.0), vec3(0.72, 0.58, 0.42), smoothstep(0.8, 0.86, nbNoise(p * vec2(60.0, 47.0) + 5.0)) * age);
          // damp while the ground is wet
          a *= 1.0 - 0.12 * nbDamp;
          diffuseColor.rgb = mix(c, a, sheet);
          // the glass mists up from the bottom in the wet
          diffuseColor.rgb = mix(diffuseColor.rgb, ${vec3('#b8bfc2')}, nbDamp * 0.5 * smoothstep(0.6, 0.0, bv));
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if (vNb.x > 0.5) totalEmissiveRadiance += ${vec3(GLOW.tubeC)} * nbLamp * ${f(GLOW.tubeGain)};
        else totalEmissiveRadiance += diffuseColor.rgb * ${vec3(GLOW.color)} * nbLamp * mix(${f(GLOW.bottom)}, ${f(GLOW.top)}, pow(vNb.z, 1.6));`);
  };
  mat.customProgramCacheKey = () => 'noticeboard-paper';
  return u;
}

/**
 * The cabinets in the scene: steel mesh + paper mesh (2 draw calls), the atlas drawn once at build and per slot on
 * `set`. Without a DOM (unit tests) there is no canvas: the paper draws as a plain pale colour.
 */
export class Noticeboards {
  readonly group = new THREE.Group();
  readonly texture: THREE.CanvasTexture | null = null;
  private g: CanvasRenderingContext2D | null = null;
  private readonly slots: { cab: string; bay: number }[];
  /** current sheet key per slot, and the game day it went up */
  readonly sheets: (string | null)[];
  readonly posted: number[];
  /** paper shader uniforms (patchPaper): 夜灯 0|1, damp 0..1 */
  readonly glow: { nbLamp: { value: number }; nbDamp: { value: number } };
  private readonly paperGeo: THREE.BufferGeometry;
  /** last synced game day */
  day = 0;
  readonly cabs: CabinetDef[];
  readonly sheetDefs: Record<string, SheetDef>;

  constructor(cabs: CabinetDef[] = NOTICE.cabinets, sheetDefs: Record<string, SheetDef> = NOTICE.sheets) {
    this.cabs = cabs; this.sheetDefs = sheetDefs;
    this.slots = slots(cabs);
    this.sheets = this.slots.map(({ cab, bay }) => cabs.find(c => c.id === cab)!.panels[bay] ?? null);
    this.posted = this.sheets.map(k => (k ? sheetDefs[k]?.posted : undefined) ?? GLOW.posted);
    const steel = new THREE.Mesh(cabinetGeometry(cabs), new THREE.MeshLambertMaterial({ vertexColors: true }));
    steel.name = 'NOTICEBOARDS';
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas'), A = atlasSize(this.slots.length);
      c.width = A.w; c.height = A.h;
      this.g = c.getContext('2d');
      if (this.g) {
        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
        this.texture = tex;
        this.slots.forEach((_, k) => this.draw(k));
      }
    }
    const mat = new THREE.MeshLambertMaterial({ map: this.texture, color: this.texture ? 0xffffff : 0xd8d2c2 });
    // behind glass under a canopy: never snowed on
    mat.userData.noSnow = true;
    this.glow = patchPaper(mat);
    this.paperGeo = paperGeometry(cabs);
    this.age();
    const paper = new THREE.Mesh(this.paperGeo, mat);
    paper.name = 'NOTICEBOARDS.paper';
    this.group.add(steel, paper);
  }
  private draw(k: number): void {
    if (!this.g || !this.texture) return;
    const key = this.sheets[k], [ox, oy] = slotOrigin(k);
    drawBay(this.g, key ? this.sheetDefs[key] : undefined, ox, oy, k);
    this.texture.needsUpdate = true;
  }
  /**
   * Put sheet `key` (null = take it down) in bay `bay` of cabinet `cab`, posted on game day `posted` (default: the
   * sheet's own `posted`, else the last synced day: a fresh sheet); redraws that slot only.
   */
  set(cab: string, bay: number, key: string | null, posted?: number): void {
    const k = this.slots.findIndex(s => s.cab === cab && s.bay === bay);
    if (k < 0) throw new Error(`noticeboard: no bay ${cab}[${bay}]`);
    if (key !== null && !(key in this.sheetDefs)) throw new Error(`noticeboard: no sheet ${key}`);
    this.sheets[k] = key;
    this.posted[k] = posted ?? (key ? this.sheetDefs[key].posted : undefined) ?? this.day;
    this.draw(k);
    this.age();
  }
  /** Age of slot `k`'s sheet today, 0..1 (0 for an empty bay). */
  ageOf(k: number): number { return this.sheets[k] ? sheetAge(this.day - this.posted[k]) : 0; }
  /** Per frame: 夜灯 on with the street lamps (tod `lamps` 0..1, a tube is on or off), damp with the ground (weather `wet`), aged by game day. */
  update(lamps: number, wet: number, day: number): void {
    this.glow.nbLamp.value = lamps > 0.5 ? 1 : 0;
    this.glow.nbDamp.value = wet;
    if (day !== this.day) { this.day = day; this.age(); }
  }
  /** The age written into slot `k`'s vertices (tests). */
  geoAge(k: number): number { return this.paperGeo.getAttribute('nb').getW(k * 6); }
  /** Write each slot's age into its six paper vertices. */
  private age(): void {
    const a = this.paperGeo.getAttribute('nb') as THREE.BufferAttribute;
    this.slots.forEach((_, k) => { const v = this.ageOf(k); for (let i = 0; i < 6; i++) a.setW(k * 6 + i, v); });
    a.needsUpdate = true;
  }
}
