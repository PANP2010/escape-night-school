import { floorStack, type BuildingDef, type Side } from '../../../../shared/campus/campus_schema.ts';
import type { Face, FurnBox, Kind } from './classroom.ts';
import { PART, rectOf, storeyRooms } from './rooms.ts';
import { stairPlans } from './interior.ts';
import { Rng } from '../core/rng.ts';
import { seedOf } from './office.ts';
import type { LBox } from '../../../../shared/campus/stairs.ts';

/**
 * 楼梯口走廊扩大段 (the corridor widening out in front of a stairwell, world/rooms.ts bandRooms): against the
 * stairwell's blank enclosure wall (not its door side) the 光荣榜 (red 眉头, rows of small 照片 with name slips under
 * them) and the 宣传栏 beside it (a grey-blue 眉头, a few sheets pinned up), both in a 木框; a 方钟 over them; at the
 * end away from the stair door the 拖把池 (水磨石 tub on a 白瓷砖 base, a tap, two mops hung over it) and two 垃圾桶
 * (可回收 / 其他). Anything that would hit what is already on the storey (`avoid`: 消火栓箱, 灭火器箱) is left out.
 * No school name anywhere. Pure; rendered through furnitureGeometry.
 */
export const HALLWAY = {
  /** a widening counts if the corridor runs this far along the wall and this deep out from it (A's 3 m strip past
   *  the stairwell and OFF's 3 m landing outside the stair door count; a 2.6 m main corridor does not) */ minLen: 3, minDepth: 3,
  /** the landing outside a stair door is at most this deep (deeper, it is a main corridor running off the door) */ landing: 6,
  /** the walkway left clear in front of the 拖把池 / 垃圾桶; narrower than this and only the flat things go up */ clearW: 2.3,
  /** 光荣榜 / 宣传栏: width each, bottom and top above the floor, frame depth off the wall, the 眉头 band height */
  board: { w: 2.0, y0: 1.0, y1: 2.1, d: 0.05, head: 0.2, gap: 0.3 },
  /** 光荣榜 photo grid (columns × rows), photo size */ photo: { cols: 6, rows: 3, w: 0.18, h: 0.22 },
  /** 方钟: centre height, size */ clock: { y: 2.55, s: 0.32 },
  /** 拖把池: along the wall, out from it, rim height */ sink: { w: 0.8, d: 0.55, h: 0.6 },
  /** 垃圾桶: size (square), height */ bin: { s: 0.4, h: 0.65 },
  /** keep clear of the stair-door end */ doorClear: 1.2,
};

const VEC: Record<Side, [number, number]> = { '+x': [1, 0], '-x': [-1, 0], '+z': [0, 1], '-z': [0, -1] };
const flip = (s: Side): Side => `${s[0] === '+' ? '-' : '+'}${s[1]}` as Side;
const hit = (a: LBox, q: LBox) => a.x0 < q.x1 && a.x1 > q.x0 && a.z0 < q.z1 && a.z1 > q.z0 && a.y0 < q.y1 && a.y1 > q.y0;

/** The widening spots of a storey: a stairwell wall face (c, the side it faces `n`, axis along it), the span along it;
 *  and the wall across a landing from the stair door (a dead end on one side, open to the corridor on the other). */
export function hallwaySpots(b: BuildingDef, level: number): { stair: string; room: string; n: Side; ax: 'x' | 'z'; c: number; u0: number; u1: number; deep: 1 | -1; depth: number }[] {
  const H = HALLWAY, out: ReturnType<typeof hallwaySpots> = [];
  const rooms = storeyRooms(b, level).filter(r => r.kind === 'corridor');
  for (const p of stairPlans(b)) {
    if (level < p.def.from || level > p.def.to) continue;
    const R = p.rect;
    for (const side of p.walls) {
      if (side === p.doorSide) continue;
      const ax: 'x' | 'z' = side[1] === 'z' ? 'x' : 'z', [nx, nz] = VEC[side];
      const c = side === '+x' ? R.x1 : side === '-x' ? R.x0 : side === '+z' ? R.z1 : R.z0;
      const [w0, w1] = ax === 'x' ? [R.x0, R.x1] : [R.z0, R.z1];
      for (const r of rooms) {
        const Q = rectOf(r);
        // the corridor's edge on the wall face, and its depth out from it
        const edge = (nx + nz) > 0 ? (ax === 'x' ? Q.z0 : Q.x0) : (ax === 'x' ? Q.z1 : Q.x1);
        if (Math.abs(edge - c) > 0.05) continue;
        const depth = ax === 'x' ? Q.z1 - Q.z0 : Q.x1 - Q.x0;
        const [q0, q1] = ax === 'x' ? [Q.x0, Q.x1] : [Q.z0, Q.z1];
        const u0 = Math.max(w0, q0), u1 = Math.min(w1, q1);
        if (u1 - u0 < H.minLen || depth < H.minDepth) continue;
        // the end away from the stair door (along this wall's axis)
        const [dx, dz] = VEC[p.doorSide], d = ax === 'x' ? dx : dz;
        out.push({ stair: p.def.id, room: r.id, n: side, ax, c, u0, u1, deep: d > 0 ? -1 : 1, depth });
      }
    }
    // the landing straight outside the stair door (OFF nc0): the wall facing the door across it, its far end the one
    // away from the corridor it opens off
    {
      const side = p.doorSide, ax: 'x' | 'z' = side[1] === 'z' ? 'x' : 'z', [nx, nz] = VEC[side], k = nx + nz;
      const c = side === '+x' ? R.x1 : side === '-x' ? R.x0 : side === '+z' ? R.z1 : R.z0;
      const [w0, w1] = ax === 'x' ? [R.x0, R.x1] : [R.z0, R.z1];
      for (const r of rooms) {
        const Q = rectOf(r);
        const edge = k > 0 ? (ax === 'x' ? Q.z0 : Q.x0) : (ax === 'x' ? Q.z1 : Q.x1);
        if (Math.abs(edge - c) > 0.05) continue;
        const depth = ax === 'x' ? Q.z1 - Q.z0 : Q.x1 - Q.x0;
        const [q0, q1] = ax === 'x' ? [Q.x0, Q.x1] : [Q.z0, Q.z1];
        // only a landing that sits wholly in front of the door wall (not a main corridor running past it)
        if (q0 < w0 - 0.3 || q1 > w1 + 0.3 || q1 - q0 < H.minLen || depth < H.minDepth || depth > H.landing) continue;
        const touch = (u: number) => rooms.some(o => o !== r && (() => {
          const O = rectOf(o);
          return ax === 'x' ? Math.abs((u === q0 ? O.x1 : O.x0) - u) < 0.05 && O.z0 < Q.z1 && O.z1 > Q.z0
            : Math.abs((u === q0 ? O.z1 : O.z0) - u) < 0.05 && O.x0 < Q.x1 && O.x1 > Q.x0;
        })());
        const open0 = touch(q0), open1 = touch(q1);
        if (open0 === open1) continue; // a through-way, or nothing to tell the ends apart by
        // the wall across is a 隔墙 centred on the room edge: hang things on its face
        out.push({ stair: p.def.id, room: r.id, n: flip(side), ax, c: c + k * (depth - PART.t / 2), u0: q0, u1: q1, deep: open0 ? 1 : -1, depth: depth - PART.t / 2 });
      }
    }
  }
  return out;
}

/** A storey's widening furniture (building-local, y = world height): render boxes and colliders. */
export function hallwayFurniture(b: BuildingDef, level: number, avoid: LBox[] = []): { render: FurnBox[]; solid: LBox[] } {
  const st = floorStack(b).find(s => s.level === level), render: FurnBox[] = [], solid: LBox[] = [];
  if (!st) return { render, solid };
  const H = HALLWAY, y = st.y;
  let mopped = false; // one 拖把池 a storey
  for (const sp of hallwaySpots(b, level)) {
    const [nx, nz] = VEC[sp.n], k = nx + nz, back = flip(sp.n), rng = new Rng(seedOf(`${b.id}.${level}.${sp.room}.hall`));
    // a box against the wall: u along it, w out from it
    const at = (u0: number, u1: number, w0: number, w1: number, y0: number, y1: number): LBox => {
      const [a, c] = [sp.c + k * w0, sp.c + k * w1].sort((p, q) => p - q);
      return sp.ax === 'x' ? { x0: u0, x1: u1, z0: a, z1: c, y0: y + y0, y1: y + y1 } : { x0: a, x1: c, z0: u0, z1: u1, y0: y + y0, y1: y + y1 };
    };
    const put = (kind: Kind, q: LBox, skip: Face[] = ['bottom', back]) => render.push({ ...q, kind, skip });
    // a flat thing on the wall face (shows only its front)
    const sides: Face[] = sp.ax === 'x' ? ['+x', '-x'] : ['+z', '-z'];
    const flat = (kind: Kind, u0: number, u1: number, w: number, y0: number, y1: number, t = 0.006) => put(kind, at(u0, u1, w, w + t, y0, y1), ['bottom', 'top', back, ...sides]);
    // u at s in from the end of the span away from the stair door
    const far = (s: number) => (sp.deep > 0 ? sp.u1 - s : sp.u0 + s);
    const mid = (sp.u0 + sp.u1) / 2, Bd = H.board, free = (q: LBox) => !avoid.some(a => hit(a, q));
    // ── 光荣榜 + 宣传栏 side by side, centred on the wall (shifted off the door end)
    const two = 2 * Bd.w + Bd.gap, room = sp.u1 - sp.u0 - H.doorClear - 2 * (H.sink.w + 0.2);
    const n = room >= two ? 2 : room >= Bd.w ? 1 : 0;
    // 拖把池 / 垃圾桶 only where they leave the walkway clear; the boards centred on what they leave of the wall
    const tubs = !mopped && sp.depth - H.sink.d >= H.clearW, keep = H.sink.w + 0.45; // the boards hang over the bins, not the mops
    const lo = sp.deep > 0 ? sp.u0 + H.doorClear : sp.u0 + (tubs ? keep : 0.2), hi = sp.deep > 0 ? sp.u1 - (tubs ? keep : 0.2) : sp.u1 - H.doorClear;
    let span = (c: number) => Array.from({ length: n }, (_, i) => n === 2 ? c - two / 2 + i * (Bd.w + Bd.gap) : c - Bd.w / 2);
    // slid along the wall, nearest first, clear of a 消火栓箱 / 报警按钮 already on it; one board if two will not go
    let c0 = mid;
    for (let m = n, found = false; m > 0 && !found; m--) {
      const half = (m === 2 ? two : Bd.w) / 2, want = hi - lo >= 2 * half ? Math.min(Math.max(mid, lo + half), hi - half) : mid;
      const sp_ = (c: number) => Array.from({ length: m }, (_, i) => m === 2 ? c - two / 2 + i * (Bd.w + Bd.gap) : c - Bd.w / 2);
      for (let s = 0; s <= 20 * (hi - lo); s++) {
        const c = want + (s % 2 ? 1 : -1) * Math.ceil(s / 2) * 0.1;
        if (c - half < lo - 1e-6 || c + half > hi + 1e-6) continue;
        if (sp_(c).every(u => free(at(u - 0.1, u + Bd.w + 0.1, 0, Bd.d + 0.3, 0, Bd.y1 + 0.75)))) { c0 = c; span = sp_; found = true; break; }
      }
    }
    const r0 = render.length;
    for (const bu0 of span(c0)) {
      const bu1 = bu0 + Bd.w, i = bu0 === span(c0)[0] ? 0 : 1;
      const q = at(bu0, bu1, 0, Bd.d, Bd.y0, Bd.y1);
      if (!free(q)) continue;
      put('frame', q);
      const honor = i === 0, f = Bd.d;
      flat(honor ? 'banner' : 'board', bu0 + 0.04, bu1 - 0.04, f, Bd.y1 - Bd.head - 0.03, Bd.y1 - 0.03); // 眉头
      flat('bannerText', bu0 + 0.5, bu1 - 0.5, f + 0.006, Bd.y1 - Bd.head + 0.03, Bd.y1 - 0.06); // the title strip (no words: a pale band)
      flat('plaster', bu0 + 0.04, bu1 - 0.04, f, Bd.y0 + 0.04, Bd.y1 - Bd.head - 0.04); // 背板
      if (honor) {
        const P = H.photo, gu = (Bd.w - 0.08 - P.cols * P.w) / (P.cols + 1), top = Bd.y1 - Bd.head - 0.08, gy = (top - Bd.y0 - 0.06 - P.rows * (P.h + 0.05)) / P.rows;
        for (let r = 0; r < P.rows; r++) for (let cc = 0; cc < P.cols; cc++) {
          if (rng.next() < 0.08) continue; // a photo taken down
          const u = bu0 + 0.04 + gu + cc * (P.w + gu), py1 = top - r * (P.h + 0.05 + gy), py0 = py1 - P.h;
          flat('bookB', u, u + P.w, f + 0.006, py0, py1); // 照片 (the blue 证件照 ground)
          flat('radio', u + P.w * 0.18, u + P.w * 0.82, f + 0.009, py0, py0 + P.h * 0.3); // shoulders
          flat('cloth', u + P.w * 0.34, u + P.w * 0.66, f + 0.009, py0 + P.h * 0.36, py1 - 0.04); // head
          flat('paper', u, u + P.w, f + 0.006, py0 - 0.045, py0 - 0.01); // name slip
        }
      } else {
        let u = bu0 + 0.1;
        while (u < bu1 - 0.35) {
          const w = rng.range(0.3, 0.5), h = rng.range(0.45, 0.7), top = Bd.y1 - Bd.head - rng.range(0.08, 0.16);
          if (u + w > bu1 - 0.08) break;
          flat(rng.next() < 0.25 ? 'sackB' : 'paper', u, u + w, f + 0.006, top - h, top);
          for (let j = 0; j < 3; j++) flat('ink', u + 0.04, u + w * rng.range(0.5, 0.9), f + 0.009, top - 0.08 - j * 0.07, top - 0.065 - j * 0.07, 0.003);
          u += w + rng.range(0.06, 0.14);
        }
      }
      solid.push(q);
    }
    // ── 方钟 over the middle
    const C = H.clock;
    if (render.length > r0) {
      put('frame', at(c0 - C.s / 2, c0 + C.s / 2, 0, 0.05, C.y - C.s / 2, C.y + C.s / 2));
      flat('enamel', c0 - C.s / 2 + 0.03, c0 + C.s / 2 - 0.03, 0.05, C.y - C.s / 2 + 0.03, C.y + C.s / 2 - 0.03);
      flat('ink', c0 - 0.008, c0 + 0.008, 0.056, C.y - 0.01, C.y + 0.1); // 时针 / 分针
      flat('ink', c0 - 0.008, c0 + 0.09, 0.056, C.y - 0.008, C.y + 0.008);
    }
    // ── 拖把池 at the far end
    const S = H.sink, su1 = far(0.15), su0 = far(0.15 + S.w), [s0, s1] = [Math.min(su0, su1), Math.max(su0, su1)];
    const sq = at(s0, s1, 0, S.d, 0, S.h);
    if (tubs && free(sq)) {
      put('tileWhite', at(s0, s1, 0, S.d, 0, S.h - 0.12));
      put('cement', at(s0 - 0.03, s1 + 0.03, 0, S.d + 0.03, S.h - 0.12, S.h)); // 水磨石 rim
      put('mouth', at(s0 + 0.06, s1 - 0.06, 0.06, S.d - 0.06, S.h - 0.005, S.h + 0.002), ['bottom', back, ...sides]); // the tub's dark inside
      flat('tileWhite', s0 - 0.03, s1 + 0.03, 0, S.h, S.h + 0.6); // 瓷砖 splash-back
      put('steel', at((s0 + s1) / 2 - 0.02, (s0 + s1) / 2 + 0.02, 0, 0.16, S.h + 0.38, S.h + 0.42)); // 龙头
      put('valve', at((s0 + s1) / 2 - 0.03, (s0 + s1) / 2 + 0.03, 0.02, 0.06, S.h + 0.42, S.h + 0.47));
      // two mops hung on a nail over the tub, their heads down by the rim
      for (const o of [-0.18, 0.18]) {
        const u = (s0 + s1) / 2 + o;
        put('wood', at(u - 0.012, u + 0.012, 0.03, 0.055, S.h + 0.3, S.h + 1.5));
        put('cloth', at(u - 0.07, u + 0.07, 0.02, 0.1, S.h + 0.02, S.h + 0.32));
      }
      solid.push(sq);
      mopped = true;
    }
    // ── 垃圾桶 ×2 beside it, toward the boards
    const Bn = H.bin;
    ['snackB', 'snackG'].forEach((kind, i) => {
      const u1 = far(0.15 + S.w + 0.15 + i * (Bn.s + 0.06)), u0 = u1 - sp.deep * Bn.s, [b0, b1] = [Math.min(u0, u1), Math.max(u0, u1)];
      const q = at(b0, b1, 0.03, 0.03 + Bn.s, 0, Bn.h);
      if (!tubs || !free(q)) return;
      put(kind as Kind, at(b0, b1, 0.03, 0.03 + Bn.s, 0, Bn.h - 0.06), ['bottom']);
      put(kind as Kind, at(b0 - 0.01, b1 + 0.01, 0.02, 0.04 + Bn.s, Bn.h - 0.06, Bn.h), ['bottom']); // lid
      put('mouth', at((b0 + b1) / 2 - 0.1, (b0 + b1) / 2 + 0.1, 0.03 + Bn.s - 0.004, 0.03 + Bn.s + 0.002, Bn.h - 0.05, Bn.h - 0.01), ['bottom', back]); // 投口
      solid.push(q);
    });
  }
  return { render, solid };
}
