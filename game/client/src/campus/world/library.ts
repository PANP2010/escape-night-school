import { FLOOR_HEIGHT, floorStack, WALL_T, type BuildingDef, type RoomDef, type Side } from '../../../../shared/campus/campus_schema.ts';
import { PART } from './rooms.ts';
import { lampsAndFans, roomFrame, type Face, type FurnBox, type Kind } from './classroom.ts';
import { seedOf } from './office.ts';
import { Rng } from '../core/rng.ts';
import type { LBox } from '../../../../shared/campus/stairs.ts';

/**
 * 图书馆陈设 (图书馆①, docs/03_campus.md 图书馆): the rooms of the library (data/campus/campus.json LIB), each laid out
 * in its own frame (classroom.ts roomFrame) facing its outer (window) wall, so the light runs down the aisles.
 * - `stacks` 书库: rows of 双面书架 square to the window wall, a side aisle along the windows, the main aisle along the
 *   door wall; every bay of every tier holds runs of books of a few colours and heights (seeded per room, some gaps,
 *   the top tier thinner), a 索书号 card on the aisle end of each row.
 * - `reading` 阅览室: long 阅览桌 with three chairs a side in a grid, 单面靠墙书架 along the door wall (the door kept clear).
 * - the 门厅 (room id `lobby`): an L-shaped 借还台 by the stairs, a 目录柜 with its little drawers, a 存包柜 inside the door.
 * One 日光灯 grid per room, no fans. Pure; the render goes through classroom.ts furnitureGeometry.
 */

/** a book whose top is above this (storey floor up) never shows its top: the standing eye is 1.6 m (actors/player.ts) */
const BOOK_EYE = 1.65;

export const LIB = {
  /** 书架: bay width, depth of one side, tier boards (height of each board's top), overall height, plinth, end panel */
  shelf: { bay: 0.9, side: 0.26, tiers: [0.12, 0.48, 0.84, 1.2, 1.56, 1.92], h: 2.2, plinth: 0.1, board: 0.02, end: 0.03 },
  /** 书库 rows: pitch across, aisle by the window wall, main aisle by the door wall, clear of the end walls */
  stacks: { pitch: 1.65, window: 0.9, main: 1.7, ends: 0.9 },
  /** books: run width range, height range (share of the tier gap), depth range, share of empty runs */
  book: { w: [0.05, 0.2], h: [0.5, 0.92], d: [0.17, 0.23], gap: 0.1 },
  /** 阅览桌 (along × across × height), chair seat/back, the grid pitch across, aisle by the door wall / window wall */
  table: { len: 2.4, w: 1.1, h: 0.76, top: 0.04, pitch: 2.9, door: 2.2, window: 1.0, gapA: 1.3 },
  chair: { w: 0.42, d: 0.42, seat: 0.45, back: 0.86, out: 0.12 },
  /** 密集架 (图书馆② B1): carriage depth across (two sides + the divider), the gap between packed carriages, the one
   *  open aisle of a bank, height, tier board tops, the 书脊 depth; the room: main aisle by the door wall, a cross
   *  aisle between the two blocks along a, clear of the far wall and the end walls, the walkway in line with the door;
   *  rails (under the step height: walked over), the 手摇轮 on the aisle end */
  /** 门厅: the 安检门 panels (across v of each, length along a, thickness, height) */
  lobby: { gate: { at: [-1.5, -0.5, 0.5, 1.5], len: 0.55, t: 0.07, h: 1.65 } },
  /** 中厅 (frame a toward the front wall, the wings beside the stairwell a > -0.4): the 检索电脑台 (a span, depth, height),
   *  the 复印机 (a centre, width along a, depth, height), the 饮水机 (a centre), the 楼层索引牌 (v centre, width, bottom, height) */
  hall: { search: { a: [1.0, 3.8], d: 0.7, h: 0.9 }, copier: { a: 4.2, w: 0.9, d: 0.65, h: 1.05 }, water: { a: 1.4 }, index: { v: -2.0, w: 1.8, y: 1.0, h: 1.3 } },
  compact: {
    depth: 0.6, gap: 0.03, aisle: 0.95, h: 2.3, tiers: [0.14, 0.5, 0.86, 1.22, 1.58, 1.94], board: 0.025, books: 0.2,
    main: 1.7, cross: 1.4, far: 0.5, ends: 0.35, walk: 2.6, rail: 0.025, bay: 0.9,
    wheel: { y: 1.1, r: 0.2, out: 0.09 },
  },
};

/** book cloth colours: muted reds, blues, greens, ochre, the pale paperbacks */
const BOOKS: Kind[] = ['bookR', 'bookB', 'bookG', 'bookY', 'bookW', 'bookB', 'bookR'];

const sideVec = (s: Side): [number, number] => (s[1] === 'x' ? [s[0] === '+' ? 1 : -1, 0] : [0, s[0] === '+' ? 1 : -1]);

/** The side of `r` on the building's outer wall (its windows), preferring the room's long side (rows of shelves then
 *  run square to it, the light down the aisles); `-z` when it has none. */
export function libraryFront(b: BuildingDef, r: RoomDef): Side {
  const e = 0.05, hw = b.w / 2 - WALL_T, hd = b.d / 2 - WALL_T;
  const on: Side[] = [];
  if (Math.abs(r.x - r.w / 2 + hw) < e) on.push('-x');
  if (Math.abs(r.x + r.w / 2 - hw) < e) on.push('+x');
  if (Math.abs(r.z - r.d / 2 + hd) < e) on.push('-z');
  if (Math.abs(r.z + r.d / 2 - hd) < e) on.push('+z');
  const len = (s: Side) => (s[1] === 'x' ? r.d : r.w);
  on.sort((p, q) => len(q) - len(p));
  return on[0] ?? '-z';
}

/** A library room's frame + its wall faces along (`fa` front, `ba` back) and across (`wl`, `wr`), and the door's across spans on the back wall. */
export function libraryPlan(b: BuildingDef, r: RoomDef) {
  const front = libraryFront(b, r), fr = roomFrame(r, front), t = PART.t / 2;
  const [fx, fz] = sideVec(front), rt: [number, number] = [-fz, fx];
  const back = (front[0] === '+' ? '-' : '+') + front[1] as Side;
  const k = front[1] === 'x' ? rt[1] : rt[0];
  const doors = (r.doors ?? []).filter(d => d.side === back).map(d => [k * (d.at - d.width / 2), k * (d.at + d.width / 2)].sort((p, q) => p - q) as [number, number]);
  // a room edge on the outer wall's inner face is the wall face; elsewhere a 隔墙 stands PART.t / 2 in from it
  const e = 0.05, hw = b.w / 2 - WALL_T, hd = b.d / 2 - WALL_T;
  const outer = (s: Side) => { const [x, z] = sideVec(s); return x ? Math.abs(r.x + x * r.w / 2 - x * hw) < e : Math.abs(r.z + z * r.d / 2 - z * hd) < e; };
  const face = (k: 'f' | 'b' | 'r' | 'l', half: number) => half + (outer(fr.dir(k)) ? t : 0);
  return { ...fr, fa: face('f', fr.L), ba: -face('b', fr.L), wl: -face('l', fr.W), wr: face('r', fr.W), doors };
}

/** Whether a room is furnished here: 书库, 密集书库, 阅览室, and the 图书馆's own 门厅 (a corridor with id `lobby`) and
 *  2F/3F 中厅 (id `hall`; the B1 前室 shares the id, not the name). */
export const isLibraryRoom = (r: RoomDef, b?: BuildingDef) =>
  r.kind === 'stacks' || r.kind === 'compact' || r.kind === 'reading' ||
  (r.kind === 'corridor' && b?.id === 'LIB' && (r.id === 'lobby' || (r.id === 'hall' && r.name === '中厅')));

/** One 密集架 bank: carriages on rails across v in [v0, v1], a block along a in [a0, a1] (its aisle end at a0). */
export interface CompactBank {
  a0: number; a1: number; v0: number; v1: number;
  /** carriage i spans across [c[i], c[i] + depth]; `open` = the aisle is before carriage `open` (0..n) */
  c: number[]; open: number;
}

/**
 * The 密集书库's banks (room frame of libraryPlan): two blocks along a (main aisle by the door wall, a cross aisle
 * between), each split left and right of the walkway in line with the door: four banks of carriages packed against
 * both ends of their rails with one aisle open. `open[k]` picks bank k's aisle (default seeded per room); `c` are
 * the carriages' across positions (③ pushes them: recompute with another `open`, or move `c` between two layouts).
 */
export function compactLayout(b: BuildingDef, r: RoomDef, open?: number[]): CompactBank[] {
  const p = libraryPlan(b, r), T = LIB.compact;
  const dv = p.doors[0] ? (p.doors[0][0] + p.doors[0][1]) / 2 : (p.wl + p.wr) / 2;
  const a0 = p.ba + T.main, a1 = p.fa - T.far, len = (a1 - a0 - T.cross) / 2;
  const rng = new Rng(seedOf(`${b.id}.${r.id}.compact`));
  const banks: CompactBank[] = [];
  for (const [ba0, ba1] of [[a0, a0 + len], [a1 - len, a1]]) {
    for (const [v0, v1] of [[p.wl + T.ends, dv - T.walk / 2], [dv + T.walk / 2, p.wr - T.ends]]) {
      const n = Math.max(1, Math.floor((v1 - v0 - T.aisle + T.gap) / (T.depth + T.gap)));
      const k = Math.min(n, Math.max(0, open?.[banks.length] ?? 1 + Math.floor(rng.next() * (n - 1))));
      const c: number[] = [];
      for (let i = 0; i < n; i++) c.push(i < k ? v0 + i * (T.depth + T.gap) : v1 - (n - i) * (T.depth + T.gap) + T.gap);
      banks.push({ a0: ba0, a1: ba1, v0, v1, c, open: k });
    }
  }
  return banks;
}

/**
 * A 密集架 carriage (room frame of libraryPlan): along a in [a0, a1], across [v0, v0 + depth]; books both sides, the
 * cream 端板 + 手摇轮 on the a0 end; its collider. `seed` keeps its 书脊 painting its own while it moves (FurnBox.seed).
 */
export function carriageBoxes(b: BuildingDef, r: RoomDef, y: number, a0: number, a1: number, v0: number, seed: number): { render: FurnBox[]; solid: LBox }  {
  const p = libraryPlan(b, r), render: FurnBox[] = [], solid: LBox[] = [];
  const put = (kind: Kind, q: LBox, skip: Face[] = ['bottom']) => render.push({ ...q, kind, skip });
  const { box, dir } = p, F = dir('f'), B = dir('b'), Rt = dir('r'), Lf = dir('l');
  const v1 = v0 + LIB.compact.depth;
  const T = LIB.compact, vm = (v0 + v1) / 2, top = y + T.h;
  put('compact', box(a0, a1, v0, v1, y + T.rail, y + T.tiers[0]));
  put('compact', box(a0, a1, v0, v1, top - T.board, top), ['bottom']);
  put('compactEnd', box(a0, a0 + 0.04, v0 - 0.01, v1 + 0.01, y + T.rail, top + 0.02));
  put('compact', box(a1 - 0.03, a1, v0, v1, y + T.rail, top), ['bottom', 'top']);
  put('shelfBack', box(a0 + 0.04, a1 - 0.03, vm - 0.006, vm + 0.006, y + T.tiers[0], top - T.board), ['bottom', 'top']);
  const nb = Math.max(1, Math.round((a1 - a0) / T.bay)), bay = (a1 - a0) / nb;
  for (const s of [-1, 1] as const) {
    const face = s < 0 ? v0 : v1, back = vm + s * 0.006;
    const [b0, b1] = [Math.min(back, back + s * T.books), Math.max(back, back + s * T.books)];
    for (let i = 0; i < T.tiers.length; i++) {
      const ty = y + T.tiers[i], next = (i + 1 < T.tiers.length ? y + T.tiers[i + 1] : top) - T.board;
      if (i > 0) put('compact', box(a0 + 0.04, a1 - 0.03, Math.min(vm, face), Math.max(vm, face), ty - T.board, ty), ['bottom']);
      // the tier's books as one face: the shader paints spines of a few colours, heights and gaps (FurnBox.spine)
      render.push({ ...box(a0 + 0.04, a1 - 0.03, b0, b1, ty, next), kind: 'spines', spine: next - ty, seed: 1 + ((seed * 2 + (s < 0 ? 0 : 1)) % 255), skip: ['bottom', 'top', F, B, s < 0 ? Rt : Lf] });
    }
    // bay uprights along the front edge
    for (let k = 1; k < nb; k++) { const q = a0 + k * bay; put('compact', box(q - 0.012, q + 0.012, Math.min(face, face - s * 0.03), Math.max(face, face - s * 0.03), y + T.tiers[0], top - T.board), ['bottom', 'top']); }
  }
  // the 手摇轮 on the 端板: hub, three spokes, a rim of segments, a handle knob; a 号牌 above it
  const W = T.wheel, wy = y + W.y, wa = a0 - W.out, axis = F[1] as 'x' | 'z';
  // the frame's v runs along +x or +z or against it: spin by the angle as seen with v to the right
  const sgn = axis === 'z' ? -p.f[1] : p.f[0];
  put('knob', box(wa, a0, vm - 0.04, vm + 0.04, wy - 0.04, wy + 0.04), []);
  for (let i = 0; i < 3; i++) {
    const ang = (i * 2 * Math.PI) / 3 + 0.3, ca = Math.cos(ang), sa = Math.sin(ang);
    const cv = vm + ca * W.r / 2, cy = wy + sa * W.r / 2;
    render.push({ ...box(wa, wa + 0.02, cv - W.r / 2, cv + W.r / 2, cy - 0.012, cy + 0.012), kind: 'steel', spin: { axis, ang: sgn * ang } });
  }
  for (let i = 0; i < 10; i++) {
    const ang = (i * 2 * Math.PI) / 10, cv = vm + Math.cos(ang) * W.r, cy = wy + Math.sin(ang) * W.r, half = W.r * Math.sin(Math.PI / 10) + 0.004;
    render.push({ ...box(wa - 0.005, wa + 0.025, cv - 0.014, cv + 0.014, cy - half, cy + half), kind: 'steel', spin: { axis, ang: sgn * ang } });
  }
  const hv = vm + Math.cos(0.3) * W.r, hy = wy + Math.sin(0.3) * W.r;
  put('knob', box(wa - 0.08, wa, hv - 0.017, hv + 0.017, hy - 0.017, hy + 0.017), []);
  put('paper', box(a0 - 0.004, a0, vm - 0.11, vm + 0.11, y + 1.7, y + 1.86), ['bottom', 'top', F]);
  solid.push(box(a0 - W.out - 0.08, a1, v0, v1, y, top));
  return { render, solid: solid[0] };
}

/** Where a walker stands in a library room (building-local x, z): 1.2 m in from its (first) door. */
export function librarySpot(b: BuildingDef, r: RoomDef): [number, number] {
  const p = libraryPlan(b, r);
  const dv = p.doors[0] ? (p.doors[0][0] + p.doors[0][1]) / 2 : 0;
  const [x, , z] = p.pt(p.ba + 1.2, dv, 0);
  return [x, z];
}

/**
 * Everything in a library room (building-local, y = its storey floor): render boxes and colliders. `stacks` and
 * `reading` rooms by kind, the 门厅 by id; any other room only gets its 日光灯.
 */
export function libraryFurniture(b: BuildingDef, r: RoomDef, y: number): { render: FurnBox[]; solid: LBox[] } {
  const p = libraryPlan(b, r), render: FurnBox[] = [], solid: LBox[] = [];
  const rng = new Rng(seedOf(`${b.id}.${r.id}@${y.toFixed(1)}`));
  const put = (kind: Kind, q: LBox, skip: Face[] = ['bottom']) => render.push({ ...q, kind, skip });
  const { box, dir } = p, F = dir('f'), B = dir('b'), Rt = dir('r'), Lf = dir('l');
  const S = LIB.shelf, Bk = LIB.book;
  const clearOfDoors = (v0: number, v1: number) => !p.doors.some(([d0, d1]) => v0 < d1 + 0.3 && d0 - 0.3 < v1);

  /** books on one tier: runs of one colour filling [u0, u1] along the shelf (the frame's a when `alongA`, else v),
   *  standing on y0 under the next board at y1, backs against `back` (across), spines facing `face` */
  const books = (alongA: boolean, u0: number, u1: number, back: number, face: 1 | -1, y0: number, y1: number, thin: boolean) => {
    let u = u0 + 0.01, last: Kind | undefined;
    const runs: { u: number; w: number; h: number; d: number; kind: Kind }[] = [];
    while (u < u1 - 0.06) {
      const w = Math.min(u1 - 0.01 - u, rng.range(Bk.w[0], thin ? Bk.w[1] * 0.6 : Bk.w[1]));
      if (rng.next() < (thin ? Bk.gap * 3 : Bk.gap)) { u += w; continue; }
      const hk = rng.range(Bk.h[0], Bk.h[1]), h = (y1 - y0) * hk;
      rng.next(); // was the depth's own draw (keeps every later run where it was)
      // a taller book is a bigger one, so deeper too: then a run's side against a taller neighbour is inside it
      const d = Bk.d[0] + ((Bk.d[1] - Bk.d[0]) * (hk - Bk.h[0])) / (Bk.h[1] - Bk.h[0]);
      // never the colour of the run before it, so every run reads as its own
      let kind = BOOKS[Math.floor(rng.next() * BOOKS.length) % BOOKS.length];
      if (kind === last) kind = BOOKS[(BOOKS.indexOf(kind) + 1 + Math.floor(rng.next() * (BOOKS.length - 1))) % BOOKS.length];
      last = kind;
      runs.push({ u, w, h, d, kind });
      u += w;
    }
    // the faces nobody can see are left out (LIB.1F was ~98k triangles of books): the end of a run pressed against a
    // taller (so deeper) neighbour, and the top of a run above the highest eye (Player: stand 1.6 m)
    runs.forEach((q, i) => {
      const prev = runs[i - 1], next = runs[i + 1];
      const touch = (o: typeof q | undefined, at: number) => !!o && Math.abs(at) < 1e-6 && o.h >= q.h;
      const c0 = back, c1 = back + face * q.d, [x0, x1] = [Math.min(c0, c1), Math.max(c0, c1)];
      // skip the bottom and the back (against the divider); the ends between neighbouring runs read as spine edges
      const backF: Face = alongA ? (face > 0 ? Lf : Rt) : (face > 0 ? B : F);
      const skip: Face[] = ['bottom', backF];
      if (y0 + q.h > y + BOOK_EYE) skip.push('top');
      // the frame's a runs toward F, v toward Rt: a run's low end faces B / Lf, its high end F / Rt
      if (touch(prev, prev ? prev.u + prev.w - q.u : 1)) skip.push(alongA ? B : Lf);
      if (touch(next, next ? next.u - (q.u + q.w) : 1)) skip.push(alongA ? F : Rt);
      put(q.kind, alongA ? box(q.u, q.u + q.w, x0, x1, y0, y0 + q.h) : box(x0, x1, q.u, q.u + q.w, y0, y0 + q.h), skip);
    });
  };

  /** a 书架 run along a (alongA) or v from u0 to u1, its back face at `back` across, one side deep toward `face`;
   *  `two` = a 双面书架 (a second side mirrored behind the back) */
  const shelf = (alongA: boolean, u0: number, u1: number, back: number, face: 1 | -1, two: boolean) => {
    const sides: [number, 1 | -1][] = two ? [[back, face], [back, (-face) as 1 | -1]] : [[back, face]];
    const deep = (c: number, f: number, d: number) => [Math.min(c, c + f * d), Math.max(c, c + f * d)] as [number, number];
    const span = (q0: number, q1: number, c0: number, c1: number, y0: number, y1: number) => (alongA ? box(q0, q1, c0, c1, y0, y1) : box(c0, c1, q0, q1, y0, y1));
    const all = two ? [back - S.side, back + S.side] as [number, number] : deep(back, face, S.side);
    // end panels, the plinth, a back divider (two-sided) and the top
    for (const e of [u0, u1 - S.end]) put('shelf', span(e, e + S.end, all[0], all[1], y, y + S.h));
    put('shelf', span(u0, u1, all[0], all[1], y, y + S.plinth), ['bottom', 'top']);
    put('shelf', span(u0, u1, all[0], all[1], y + S.h - S.board, y + S.h));
    // the back: a steel divider down the middle of a 双面书架, a back panel against the wall for a 靠墙书架
    put('shelfBack', span(u0 + S.end, u1 - S.end, back - 0.006, back + 0.006, y + S.plinth, y + S.h - S.board), ['bottom', 'top']);
    const n = Math.max(1, Math.round((u1 - u0) / S.bay)), bay = (u1 - u0) / n;
    for (const [c, f] of sides) {
      const [c0, c1] = deep(c, f, S.side);
      for (let i = 0; i < S.tiers.length; i++) {
        const ty = y + S.tiers[i];
        if (i > 0) put('shelf', span(u0 + S.end, u1 - S.end, c0, c1, ty - S.board, ty), ['bottom']);
        const next = i + 1 < S.tiers.length ? y + S.tiers[i + 1] - S.board : y + S.h - S.board;
        for (let k = 0; k < n; k++) {
          const q0 = u0 + k * bay + (k === 0 ? S.end : 0.01), q1 = u0 + (k + 1) * bay - (k === n - 1 ? S.end : 0.01);
          books(alongA, q0, q1, c + f * 0.02, f, i === 0 ? y + S.plinth : ty, next, i === S.tiers.length - 1);
        }
      }
      // bay uprights between the runs, the front edge only
      for (let k = 1; k < n; k++) { const q = u0 + k * bay; put('shelf', span(q - 0.01, q + 0.01, Math.min(c0, c1), Math.max(c0, c1), y + S.plinth, y + S.h - S.board), ['bottom', 'top']); }
    }
    solid.push(span(u0, u1, all[0], all[1], y, y + S.h));
  };

  if (r.kind === 'compact') {
    for (const k of compactLayout(b, r)) {
      // rails across the bank, flush with the floor (walked over), a carriage on each block of them
      const T = LIB.compact;
      for (const a of [k.a0 + 0.35, (k.a0 + k.a1) / 2, k.a1 - 0.35]) put('steel', box(a - 0.03, a + 0.03, k.v0, k.v1, y, y + T.rail));
      // the carriages themselves move (图书馆③): world/compact.ts draws them and keeps their colliders
    }
  } else if (r.kind === 'stacks') {
    // ── 书库: 双面书架 rows along a, from the main aisle (door wall) to the window aisle; a 索书号 card on the aisle end
    const T = LIB.stacks, a0 = p.ba + T.main, a1 = p.fa - T.window;
    const span = p.wr - p.wl - 2 * T.ends, n = Math.max(1, Math.floor((span - 2 * S.side) / T.pitch) + 1);
    const v0 = (p.wl + p.wr) / 2 - ((n - 1) * T.pitch) / 2;
    for (let i = 0; i < n; i++) {
      const v = v0 + i * T.pitch;
      shelf(true, a0, a1, v, 1, true);
      put('paper', box(a0 - 0.006, a0, v - 0.1, v + 0.1, y + 1.3, y + 1.45), ['bottom', 'top', F]);
    }
  } else if (r.kind === 'reading') {
    // ── 阅览室: a grid of long 阅览桌 (three chairs a side), 靠墙书架 along the door wall either side of each door
    const T = LIB.table, C = LIB.chair, a0 = p.ba + T.door, a1 = p.fa - T.window;
    const na = Math.max(1, Math.floor((a1 - a0 + T.gapA) / (T.len + T.gapA)));
    const nv = Math.max(1, Math.floor((p.wr - p.wl - 1.2) / T.pitch));
    const aMid = (a0 + a1) / 2, vMid = (p.wl + p.wr) / 2;
    for (let i = 0; i < na; i++) for (let j = 0; j < nv; j++) {
      const ac = aMid + (i - (na - 1) / 2) * (T.len + T.gapA), vc = vMid + (j - (nv - 1) / 2) * T.pitch, top = y + T.h;
      put('desk', box(ac - T.len / 2, ac + T.len / 2, vc - T.w / 2, vc + T.w / 2, top - T.top, top));
      for (const [ea, ev] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) put('desk', box(ac + ea * (T.len / 2 - 0.12) - 0.03, ac + ea * (T.len / 2 - 0.12) + 0.03, vc + ev * (T.w / 2 - 0.1) - 0.03, vc + ev * (T.w / 2 - 0.1) + 0.03, y, top - T.top), ['bottom', 'top']);
      solid.push(box(ac - T.len / 2, ac + T.len / 2, vc - T.w / 2, vc + T.w / 2, y, top));
      for (const s of [-1, 1]) for (let k = -1; k <= 1; k++) {
        if (rng.next() < 0.12) continue; // a chair or two taken to another table
        const ca = ac + k * (T.len / 3) + rng.range(-0.05, 0.05), cv = vc + s * (T.w / 2 + C.out + C.d / 2) + rng.range(0, 0.08) * s;
        put('chair', box(ca - C.w / 2, ca + C.w / 2, cv - C.d / 2, cv + C.d / 2, y + C.seat - 0.04, y + C.seat));
        const bv = cv + s * (C.d / 2 - 0.02);
        put('chair', box(ca - C.w / 2, ca + C.w / 2, bv - 0.02, bv + 0.02, y + C.seat, y + C.back), ['bottom']);
        for (const e of [-1, 1]) put('steel', box(ca + e * (C.w / 2 - 0.03) - 0.012, ca + e * (C.w / 2 - 0.03) + 0.012, cv - 0.012, cv + 0.012, y, y + C.seat - 0.04), ['bottom', 'top']);
        solid.push(box(ca - C.w / 2 - 0.05, ca + C.w / 2 + 0.05, cv - C.d / 2 - 0.05, cv + C.d / 2 + 0.05, y, y + C.back));
        // now and then a book left open on the table in front of it
        if (rng.next() < 0.18) put('paper', box(ca - 0.15, ca + 0.15, vc + s * 0.2 - 0.11, vc + s * 0.2 + 0.11, top, top + 0.012));
      }
    }
    // 靠墙书架 along the back (door) wall, in the stretches between doors
    const cuts = [p.wl + 0.4, ...p.doors.flatMap(([d0, d1]) => [d0 - 0.3, d1 + 0.3]), p.wr - 0.4].sort((q, w) => q - w);
    for (let k = 0; k + 1 < cuts.length; k += 2) if (cuts[k + 1] - cuts[k] > 1.2 && clearOfDoors(cuts[k], cuts[k + 1])) shelf(false, cuts[k], cuts[k + 1], p.ba, 1, false);
  } else if (r.id === 'lobby') lobby(b, r, y, put, solid);
  else if (r.id === 'hall') hall(b, r, y, put, solid);

  const h = floorStack(b).find(st => Math.abs(st.y - y) < 1e-6)?.h ?? b.floorHeight ?? FLOOR_HEIGHT;
  render.push(...lampsAndFans(r, y, h, 0).out);
  return { render, solid };
}

/**
 * The 门厅 (room frame facing the entrance wall, a toward the doors): the 借还台 on the right of the hall in front of
 * the stairs with a return leg back toward them, a 目录柜 of little drawers against the west wall, a 存包柜 inside the door on
 * the east. Placed by the frame, so it only assumes the entrance wall is the room's front.
 */
function lobby(b: BuildingDef, r: RoomDef, y: number, put: (k: Kind, q: LBox, skip?: Face[]) => void, solid: LBox[]) {
  const p = libraryPlan(b, r), { box } = p;
  const ad = p.ba + 9.2, D = 0.62, H = 1.05;
  // 借还台: the counter on the right of the hall, a top board proud of it, a return leg back toward the stairs (the staff side)
  const cv0 = 1.6, cv1 = 6.6;
  put('counter', box(ad - D, ad, cv0, cv1, y, y + H - 0.04));
  put('desk', box(ad - D - 0.04, ad + 0.04, cv0 - 0.04, cv1 + 0.04, y + H - 0.04, y + H));
  put('counter', box(ad - D - 1.6, ad - D, cv1 - D, cv1, y, y + H - 0.04));
  put('desk', box(ad - D - 1.64, ad - D, cv1 - D - 0.04, cv1 + 0.04, y + H - 0.04, y + H));
  solid.push(box(ad - D, ad, cv0, cv1, y, y + H), box(ad - D - 1.6, ad - D, cv1 - D, cv1, y, y + H));
  // on it: a 借书卡 tray, a 登记本, a stamp pad; a 台灯 at the far end
  put('cabinet', box(ad - 0.3, ad - 0.06, 2.0, 2.5, y + H, y + H + 0.1));
  put('paper', box(ad - 0.4, ad - 0.1, 3.5, 4.1, y + H, y + H + 0.012));
  put('ink', box(ad - 0.25, ad - 0.15, 4.4, 4.52, y + H, y + H + 0.03));
  put('shade', box(ad - 0.5, ad - 0.3, 6.0, 6.2, y + H + 0.3, y + H + 0.45));
  put('steel', box(ad - 0.42, ad - 0.38, 6.08, 6.12, y + H, y + H + 0.3), ['bottom', 'top']);
  // a chair behind it (the stairs side)
  put('chair', box(ad - D - 0.62, ad - D - 0.2, 3.6, 4.0, y + 0.41, y + 0.45));
  put('chair', box(ad - D - 0.62, ad - D - 0.58, 3.6, 4.0, y + 0.45, y + 0.86), ['bottom']);
  // 目录柜 against the left wall, between the 书库 door and the counter: a cabinet of 6 × 5 drawers on legs
  const ka0 = ad + 1.8, ka1 = ka0 + 1.5, kv0 = p.wl, kv1 = p.wl + 0.5, k0 = y + 0.35, k1 = y + 1.3;
  put('catalog', box(ka0, ka1, kv0, kv1, k0, k1));
  for (const [ea, ev] of [[ka0 + 0.05, kv1 - 0.05], [ka1 - 0.05, kv1 - 0.05]]) put('catalog', box(ea - 0.03, ea + 0.03, ev - 0.03, ev + 0.03, y, k0), ['bottom', 'top']);
  for (let i = 0; i < 6; i++) for (let j = 0; j < 5; j++) {
    const a = ka0 + 0.05 + i * 0.235, z = k0 + 0.05 + j * 0.18;
    put('paper', box(a + 0.07, a + 0.15, kv1, kv1 + 0.004, z + 0.09, z + 0.12), ['bottom', 'top']);
  }
  solid.push(box(ka0, ka1, kv0, kv1, y, k1));
  // 存包柜 inside the doors on the right: 3 × 4 little steel doors, a key in some
  const la1 = p.fa - 1.2, la0 = la1 - 1.6, lv1 = p.wr, lv0 = p.wr - 0.45;
  put('locker', box(la0, la1, lv0, lv1, y, y + 1.8));
  for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) {
    const a = la0 + 0.05 + i * 0.39, z = y + 0.1 + j * 0.56;
    put('ink', box(a, a + 0.3, lv0 - 0.004, lv0, z + 0.48, z + 0.5), ['bottom', 'top']);
    if ((i + j) % 3 === 0) put('steel', box(a + 0.26, a + 0.28, lv0 - 0.02, lv0, z + 0.25, z + 0.3), ['bottom', 'top']);
  }
  solid.push(box(la0, la1, lv0, lv1, y, y + 1.8));
  // 新书展架 in the middle of the hall (a low two-sided slope of covers face out) and two 长椅 facing it
  const na = ad + 4.2, nh = 1.1;
  put('shelf', box(na - 0.35, na + 0.35, -1.2, 1.2, y, y + 0.12));
  for (const e of [-1, 1]) {
    put('shelf', box(na + e * 0.05 - 0.2, na + e * 0.05 + 0.2, -1.2, -1.17, y, y + nh), ['bottom']);
    put('shelf', box(na + e * 0.05 - 0.2, na + e * 0.05 + 0.2, 1.17, 1.2, y, y + nh), ['bottom']);
    for (let t = 0; t < 3; t++) for (let k = 0; k < 4; k++) {
      const cy = y + 0.3 + t * 0.3, va = -1.1 + k * 0.56, ca = na + e * (0.24 - t * 0.07);
      put(BOOKS[(t * 4 + k + (e > 0 ? 2 : 0)) % BOOKS.length], box(ca - 0.02, ca + 0.02, va + 0.06, va + 0.44, cy, cy + 0.26), ['bottom']);
    }
  }
  solid.push(box(na - 0.35, na + 0.35, -1.2, 1.2, y, y + nh));
  for (const e of [-1, 1]) {
    const ba = na + e * 2.2;
    put('wood', box(ba - 0.2, ba + 0.2, -1.0, 1.0, y + 0.42, y + 0.46));
    for (const v of [-0.85, 0.85]) put('steel', box(ba - 0.18, ba + 0.18, v - 0.02, v + 0.02, y, y + 0.42), ['bottom', 'top']);
    solid.push(box(ba - 0.2, ba + 0.2, -1.0, 1.0, y, y + 0.46));
  }
  // ── inside the doors (frame a toward the entrance, the doors' 4 m across v ∈ [-2, 2]):
  // 安检门 (the 防盗检测门 every 借阅 walks through): four cream panels across the way in, three lanes, the middle one on
  // the doors' axis; a dark band of the detector head on top, a little red lamp on the outer two
  const ga = p.fa - 3.2, G = LIB.lobby.gate;
  for (const v of G.at) {
    put('aircon', box(ga - G.len / 2, ga + G.len / 2, v - G.t / 2, v + G.t / 2, y + 0.04, y + G.h));
    put('ink', box(ga - G.len / 2 - 0.01, ga + G.len / 2 + 0.01, v - G.t / 2 - 0.01, v + G.t / 2 + 0.01, y + G.h - 0.12, y + G.h + 0.02), ['bottom']);
    put('steel', box(ga - G.len / 2 + 0.03, ga + G.len / 2 - 0.03, v - 0.06, v + 0.06, y, y + 0.04), ['bottom']);
    if (Math.abs(v) > 1) put('ledA', box(ga + G.len / 2 - 0.08, ga + G.len / 2 - 0.02, v - 0.02, v + 0.02, y + G.h + 0.02, y + G.h + 0.05), ['bottom']);
    solid.push(box(ga - G.len / 2, ga + G.len / 2, v - G.t / 2, v + G.t / 2, y, y + G.h));
  }
  // 入馆须知 on the left wall across from the 存包柜: a framed board, a title strip and rows of rules (ink lines)
  const na0 = p.fa - 4.6, na1 = na0 + 1.6, nv = p.wl, n0 = y + 1.0, n1 = y + 2.1;
  put('frame', box(na0, na1, nv, nv + 0.03, n0, n1), ['bottom']);
  put('paper', box(na0 + 0.05, na1 - 0.05, nv + 0.03, nv + 0.035, n0 + 0.05, n1 - 0.05), ['bottom', 'top']);
  put('chair', box(na0 + 0.35, na1 - 0.35, nv + 0.035, nv + 0.04, n1 - 0.2, n1 - 0.11), ['bottom', 'top']);
  for (let i = 0; i < 7; i++) {
    const ly = n1 - 0.3 - i * 0.1, w = i % 3 === 2 ? 0.7 : 1.15;
    put('ink', box(na0 + 0.18, na0 + 0.18 + w, nv + 0.035, nv + 0.04, ly - 0.012, ly), ['bottom', 'top']);
  }
  // 新书推荐 on the same wall nearer the hall: a slope of covers face out on a low cabinet, a paper card over it
  const sa1 = na0 - 0.8, sa0 = sa1 - 2.0, sv = p.wl;
  put('wood', box(sa0, sa1, sv, sv + 0.45, y, y + 0.75));
  put('desk', box(sa0 - 0.02, sa1 + 0.02, sv, sv + 0.47, y + 0.75, y + 0.78));
  put('shelf', box(sa0, sa1, sv, sv + 0.06, y + 0.78, y + 1.55), ['bottom']);
  for (let t = 0; t < 2; t++) for (let k = 0; k < 6; k++) {
    const cy = y + 0.86 + t * 0.34, ca = sa0 + 0.08 + k * 0.32, cv = sv + 0.07 + t * 0.0 + 0.04;
    put(BOOKS[(k * 3 + t) % BOOKS.length], box(ca, ca + 0.24, cv, cv + 0.03, cy, cy + 0.3), ['bottom']);
  }
  put('paper', box(sa0 + 0.6, sa1 - 0.6, sv + 0.06, sv + 0.065, y + 1.62, y + 1.82), ['bottom', 'top']);
  put('ink', box(sa0 + 0.7, sa1 - 0.7, sv + 0.065, sv + 0.07, y + 1.7, y + 1.74), ['bottom', 'top']);
  solid.push(box(sa0, sa1, sv, sv + 0.47, y, y + 1.55));
  // a 长椅 along the right wall between the 存包柜 and the counter (people waiting for someone), a 绿萝 either side of the doors
  const ba1 = p.fa - 4.0, ba0 = ba1 - 2.4, bv = p.wr;
  put('wood', box(ba0, ba1, bv - 0.45, bv - 0.05, y + 0.42, y + 0.46));
  put('wood', box(ba0, ba1, bv - 0.1, bv - 0.06, y + 0.5, y + 0.85), ['bottom']);
  for (const a of [ba0 + 0.15, ba1 - 0.15]) put('steel', box(a - 0.02, a + 0.02, bv - 0.42, bv - 0.08, y, y + 0.42), ['bottom', 'top']);
  solid.push(box(ba0, ba1, bv - 0.45, bv, y, y + 0.85));
  // 报架 in the open floor between the doors and the 新书展架: a two-sided wooden rack, the day's papers folded over
  // its rods (one sheet hanging off each side), the 夹 of each a dark bar at the top
  const ra = 6.2, rv = -3.4, R = 1.8;
  for (const e of [-1, 1]) put('wood', box(ra - R / 2 + (e > 0 ? R - 0.05 : 0), ra - R / 2 + (e > 0 ? R : 0.05), rv - 0.3, rv + 0.3, y, y + 1.35), ['bottom']);
  put('wood', box(ra - R / 2, ra + R / 2, rv - 0.32, rv + 0.32, y + 0.12, y + 0.16));
  for (let k = 0; k < 4; k++) for (const e of [-1, 1]) {
    const a0 = ra - R / 2 + 0.1 + k * 0.4, top = y + 1.25 - (k % 2) * 0.06, v = rv + e * 0.08;
    put('ink', box(a0 - 0.02, a0 + 0.38, v - 0.015, v + 0.015, top, top + 0.03));
    put('paper', box(a0, a0 + 0.36, v + e * 0.015, v + e * 0.02, top - 0.55, top), ['bottom', 'top']);
    if ((k + (e > 0 ? 1 : 0)) % 2) put('ink', box(a0 + 0.04, a0 + 0.3, v + e * 0.02, v + e * 0.024, top - 0.12, top - 0.07), ['bottom', 'top']);
  }
  solid.push(box(ra - R / 2, ra + R / 2, rv - 0.32, rv + 0.32, y, y + 1.35));
  for (const v of [-2.7, 2.7]) {
    const a = p.fa - 0.5;
    put('pot', box(a - 0.18, a + 0.18, v - 0.18, v + 0.18, y, y + 0.4));
    put('leaf', box(a - 0.3, a + 0.3, v - 0.3, v + 0.3, y + 0.4, y + 0.85));
    put('leaf', box(a - 0.16, a + 0.16, v - 0.16, v + 0.16, y + 0.85, y + 1.1));
    solid.push(box(a - 0.3, a + 0.3, v - 0.3, v + 0.3, y, y + 1.1));
  }
}

/**
 * The 2F/3F 中厅 (room frame facing +z, the stairwell's box filling the middle of the far half, its door toward the
 * back wall): the walkway in front of the stairs stays clear (every door is on it); the two wings beside the stairwell
 * take a 检索电脑台 (east, three old monitors and keyboards, a 书目检索 card over them) and a 复印机 + 饮水机 (west), and
 * a 楼层索引牌 on the back wall faces whoever comes out of the stairs.
 */
function hall(b: BuildingDef, r: RoomDef, y: number, put: (k: Kind, q: LBox, skip?: Face[]) => void, solid: LBox[]) {
  const p = libraryPlan(b, r), { box } = p, H = LIB.hall;
  // 检索电脑台 against the east (left) wall: a standing-height desk, three monitors back to the wall, keyboards before them
  const [ka0, ka1] = H.search.a, kv = p.wl, kd = H.search.d, kh = H.search.h;
  put('counter', box(ka0, ka1, kv, kv + kd - 0.04, y, y + kh - 0.03));
  put('desk', box(ka0 - 0.03, ka1 + 0.03, kv, kv + kd, y + kh - 0.03, y + kh));
  solid.push(box(ka0, ka1, kv, kv + kd, y, y + kh));
  const n = 3, step = (ka1 - ka0) / n;
  for (let i = 0; i < n; i++) {
    const am = ka0 + step * (i + 0.5), top = y + kh;
    // the monitor: a deep beige case on a little foot, its dark screen toward the room; the keyboard in front
    put('tv', box(am - 0.03, am + 0.03, kv + 0.12, kv + 0.22, top, top + 0.08));
    put('tv', box(am - 0.2, am + 0.2, kv + 0.05, kv + 0.4, top + 0.08, top + 0.42));
    put('crt', box(am - 0.17, am + 0.17, kv + 0.4, kv + 0.405, top + 0.11, top + 0.39), ['bottom', 'top']);
    put('enamel', box(am - 0.22, am + 0.22, kv + 0.44, kv + 0.6, top, top + 0.025));
    put('ink', box(am + 0.28, am + 0.34, kv + 0.46, kv + 0.55, top, top + 0.03));
  }
  // the 书目检索 card on the wall over them (paper, a red title strip, a line of ink)
  const cm = (ka0 + ka1) / 2;
  put('frame', box(cm - 0.6, cm + 0.6, kv, kv + 0.02, y + 1.75, y + 2.1), ['bottom']);
  put('paper', box(cm - 0.56, cm + 0.56, kv + 0.02, kv + 0.025, y + 1.79, y + 2.06), ['bottom', 'top']);
  put('bookR', box(cm - 0.4, cm + 0.4, kv + 0.025, kv + 0.03, y + 1.94, y + 2.01), ['bottom', 'top']);
  put('ink', box(cm - 0.45, cm + 0.3, kv + 0.025, kv + 0.03, y + 1.85, y + 1.87), ['bottom', 'top']);
  // 复印机 against the west (right) wall: the beige body, its dark platen glass under a lid, the paper out of the tray
  const C = H.copier, cv = p.wr, [ca0, ca1] = [C.a - C.w / 2, C.a + C.w / 2];
  put('switch', box(ca0, ca1, cv - C.d, cv, y + 0.06, y + C.h));
  put('ink', box(ca0 + 0.04, ca1 - 0.04, cv - C.d + 0.002, cv - C.d, y + 0.25, y + 0.27), ['bottom', 'top']);
  put('ink', box(ca0 + 0.04, ca1 - 0.04, cv - C.d + 0.002, cv - C.d, y + 0.5, y + 0.52), ['bottom', 'top']);
  for (const a of [ca0 + 0.05, ca1 - 0.05]) put('ink', box(a - 0.03, a + 0.03, cv - C.d + 0.05, cv - C.d + 0.11, y, y + 0.06), ['bottom']);
  put('aircon', box(ca0 + 0.02, ca1 - 0.02, cv - C.d + 0.02, cv - 0.02, y + C.h, y + C.h + 0.05));
  put('ledG', box(ca0 + 0.06, ca0 + 0.1, cv - C.d - 0.003, cv - C.d, y + C.h - 0.08, y + C.h - 0.05), ['bottom', 'top']);
  put('paper', box(ca1, ca1 + 0.26, cv - C.d + 0.08, cv - 0.12, y + C.h - 0.2, y + C.h - 0.18));
  put('aircon', box(ca1, ca1 + 0.3, cv - C.d + 0.06, cv - 0.1, y + C.h - 0.23, y + C.h - 0.2));
  solid.push(box(ca0, ca1 + 0.3, cv - C.d, cv, y, y + C.h + 0.05));
  // a 纸箱 of 复印纸 beside it and the 废纸篓
  put('file', box(ca0 - 0.5, ca0 - 0.1, cv - 0.32, cv - 0.02, y, y + 0.28));
  put('steel', box(ca1 + 0.45, ca1 + 0.75, cv - 0.32, cv - 0.02, y, y + 0.32), ['bottom']);
  solid.push(box(ca0 - 0.5, ca0 - 0.1, cv - 0.32, cv, y, y + 0.28), box(ca1 + 0.45, ca1 + 0.75, cv - 0.32, cv, y, y + 0.32));
  // 饮水机 nearer the walkway: a cream cabinet, the blue 水桶 upside down on it, two taps, a 纸杯 tube on its side
  const W = H.water, wv = p.wr;
  put('aircon', box(W.a - 0.16, W.a + 0.16, wv - 0.34, wv - 0.02, y, y + 0.95));
  put('quilt', box(W.a - 0.13, W.a + 0.13, wv - 0.31, wv - 0.05, y + 0.95, y + 1.4));
  put('quilt', box(W.a - 0.06, W.a + 0.06, wv - 0.24, wv - 0.12, y + 1.4, y + 1.46));
  put('ink', box(W.a - 0.13, W.a + 0.13, wv - 0.345, wv - 0.34, y + 0.62, y + 0.85), ['bottom', 'top']);
  put('thermosR', box(W.a - 0.09, W.a - 0.05, wv - 0.37, wv - 0.34, y + 0.72, y + 0.76));
  put('cover', box(W.a + 0.05, W.a + 0.09, wv - 0.37, wv - 0.34, y + 0.72, y + 0.76));
  put('enamel', box(W.a + 0.17, W.a + 0.25, wv - 0.12, wv - 0.04, y + 0.9, y + 1.3), ['bottom']);
  solid.push(box(W.a - 0.16, W.a + 0.25, wv - 0.37, wv, y, y + 1.46));
  // 楼层索引牌 on the back wall facing the stairwell door: a framed board, the storey number big on top, a row for each
  // storey (a colour tab, its rooms in ink), this storey's row marked
  const I = H.index, iv0 = I.v - I.w / 2, iv1 = I.v + I.w / 2, ia = p.ba, i0 = y + I.y, i1 = i0 + I.h;
  put('frame', box(ia, ia + 0.03, iv0, iv1, i0, i1), ['bottom']);
  put('paper', box(ia + 0.03, ia + 0.035, iv0 + 0.05, iv1 - 0.05, i0 + 0.05, i1 - 0.05), ['bottom', 'top']);
  put('ink', box(ia + 0.035, ia + 0.04, iv1 - 0.45, iv1 - 0.15, i1 - 0.35, i1 - 0.1), ['bottom', 'top']);
  put('ink', box(ia + 0.035, ia + 0.04, iv0 + 0.2, iv1 - 0.6, i1 - 0.25, i1 - 0.2), ['bottom', 'top']);
  const levels = floorStack(b).map(st => st.level).sort((q, w) => w - q), here = floorStack(b).find(st => Math.abs(st.y - y) < 1e-6)?.level;
  const tabs: Kind[] = ['bookY', 'bookG', 'bookB', 'bookR', 'bookW'];
  for (let k = 0; k < levels.length; k++) {
    const ly = i1 - 0.5 - k * 0.2;
    put(tabs[k % tabs.length], box(ia + 0.035, ia + 0.04, iv1 - 0.32, iv1 - 0.15, ly - 0.1, ly), ['bottom', 'top']);
    put('ink', box(ia + 0.035, ia + 0.04, iv1 - 0.42 - (k % 2 ? 0.8 : 1.15), iv1 - 0.42, ly - 0.06, ly - 0.035), ['bottom', 'top']);
    if (levels[k] === here) put('thermosR', box(ia + 0.035, ia + 0.045, iv0 + 0.15, iv0 + 0.3, ly - 0.09, ly - 0.01), ['bottom', 'top']);
  }
}
