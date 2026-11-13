import { FLOOR_HEIGHT, type BuildingDef, type RoomDef } from '../../../../shared/campus/campus_schema.ts';
import { lampsAndFans, type Face, type FurnBox, type Kind } from './classroom.ts';
import { toiletPlan } from './toilet.ts';
import { seedOf } from './office.ts';
import { Rng } from '../core/rng.ts';
import type { LBox } from '../../../../shared/campus/stairs.ts';

/**
 * 库房 / 配电间 / 杂物间 (kind 'storage', world/rooms.ts). The 配电间 (r.name, LIB B1 storeE, 钥匙 power: a later scene
 * pulls the 闸 here): a row of 灰绿 铁皮 低压配电柜 out from the far wall facing the door, a 维护通道 left behind them,
 * each with its 柜门 seam, a dark 观察窗, a handle and a red-on-white 「有电危险」 plate; a 电缆桥架 over the row with its
 * drops into the cabinet tops; a 总闸箱 on the side wall with its lever and conduit; a 绝缘胶垫 along the fronts; the
 * 值班记录本 hung on the door wall by the door. The 库房 / 杂物间 below (bookStoreFurniture, junkFurniture, labStoreFurniture,
 * canStoreFurniture). Same frame
 * as the 厕所 (world/toilet.ts toiletPlan: a from the door wall to the far wall, v across, `s` the side the door is on).
 * Pure; rendered through furnitureGeometry.
 */
export const POWER = {
  /** 配电柜: each one's width (v), depth (a), height; how many; the 维护通道 behind the row */
  cab: { w: 0.8, d: 0.6, h: 2.2, n: 8, back: 0.8 },
  /** 观察窗 on each 柜门: width, height, its centre above the floor */ win: { w: 0.36, h: 0.24, y: 1.55 },
  /** 绝缘胶垫 in front of the row: depth (a), thickness */ mat: { d: 1.0, t: 0.012 },
  /** 电缆桥架 over the row: width (a), its underside above the floor */ tray: { w: 0.3, y: 2.75 },
};

/** 图书馆库房 (LIB B1 storeW): 纸箱 (along a × across v × height, rows of stacks, max high), the 旧书架 along the side
 * wall away from the door (bays, depth, height, tier heights), 阅览椅 stacks (how many chairs, the rise per chair), the
 * 待剔旧书推车 (along a × across v, its two shelves' heights). */
export const BOOKSTORE = {
  carton: { a: 0.42, v: 0.55, h: 0.34, max: 4 },
  shelf: { bays: 3, bay: 0.9, d: 0.3, h: 2.0, tiers: [0.1, 0.48, 0.86, 1.24, 1.62] },
  chairs: { n: 6, rise: 0.09, w: 0.42, d: 0.42, seat: 0.45, back: 0.4 },
  cart: { a: 0.9, v: 0.45, decks: [0.25, 0.7], h: 0.95 },
};

export const isStorageRoom = (r: RoomDef) => r.kind === 'storage';
export const isPowerRoom = (r: RoomDef) => isStorageRoom(r) && r.name === '配电间';
export const isBookStore = (b: BuildingDef, r: RoomDef) => isStorageRoom(r) && b.id === 'LIB' && r.name === '库房';
/** 杂物间 (LAB, OFF 1F) and OFF's 储藏室 (2F~4F, the narrow room by the 楼梯间) are the same junk room */
export const isJunkRoom = (r: RoomDef) => isStorageRoom(r) && (r.name === '杂物间' || r.name === '储藏室');
export const isCanStore = (b: BuildingDef, r: RoomDef) => isStorageRoom(r) && b.id === 'CAN';
/** the other 库房 (LAB L3 store3): 旧仪器 boxed up, 实验凳 stacked, an old 黑板 against the wall */
export const isLabStore = (b: BuildingDef, r: RoomDef) => isStorageRoom(r) && b.id === 'LAB' && r.name === '库房';

/** 角钢货架 (depth off the wall, post size, tier heights: the last one is its top), 旧课桌 (along v × deep a × top
 * height), the 拖把桶, and the 食堂库房's 米面袋 (along a × across v × height) on 木托盘 (along a × across v), 油桶 (radius,
 * height) */
export const STORE = {
  rack: { d: 0.45, post: 0.035, tiers: [0.12, 0.6, 1.08, 1.56, 1.9] },
  desk: { w: 0.6, d: 0.42, h: 0.76 },
  sack: { a: 0.75, v: 0.45, h: 0.16 },
  pallet: { a: 1.2, v: 1.0, h: 0.14 },
  drum: { r: 0.2, h: 0.62 },
};

/** Everything in a storage room (building-local, y = its storey floor): render boxes and colliders. */
export function storageFurniture(b: BuildingDef, r: RoomDef, y: number, h = FLOOR_HEIGHT): { render: FurnBox[]; solid: LBox[] } {
  const out = isPowerRoom(r) ? powerFurniture(b, r, y, h) : isBookStore(b, r) ? bookStoreFurniture(b, r, y)
    : isJunkRoom(r) ? junkFurniture(b, r, y) : isLabStore(b, r) ? labStoreFurniture(b, r, y) : isCanStore(b, r) ? canStoreFurniture(b, r, y)
    : { render: [] as FurnBox[], solid: [] as LBox[] };
  out.render.push(...lampsAndFans(r, y, h, 0).out);
  return out;
}

function powerFurniture(b: BuildingDef, r: RoomDef, y: number, h: number): { render: FurnBox[]; solid: LBox[] } {
  const p = toiletPlan(b, r), P = POWER, C = P.cab, render: FurnBox[] = [], solid: LBox[] = [];
  const { box, dir, s, fa, ba, wl, wr } = p, Bk = dir('f'); // the cabinet-side face of a plate on the fronts
  const put = (kind: Kind, q: LBox, skip: Face[] = ['bottom'], more: Partial<FurnBox> = {}) => render.push({ ...q, kind, skip, ...more });
  const vs = (a: number, c: number): [number, number] => (a < c ? [a, c] : [c, a]);
  // ── the row of 配电柜, centred across the room, their fronts (a = c0) facing the door wall
  const c1 = fa - C.back, c0 = c1 - C.d, f = c0 - 0.004, vm = (wl + wr) / 2, v0 = vm - (C.n * C.w) / 2, v1 = vm + (C.n * C.w) / 2;
  put('mouth', box(c0 + 0.03, c1, v0, v1, y, y + 0.1)); // 槽钢底座
  solid.push(box(c0, c1, v0, v1, y, y + C.h));
  for (let i = 0; i < C.n; i++) {
    const u0 = v0 + i * C.w, u1 = u0 + C.w, um = (u0 + u1) / 2;
    put('switchgear', box(c0, c1, u0 + 0.003, u1 - 0.003, y + 0.1, y + C.h));
    put('switchgearHi', box(c0 - 0.01, c1 + 0.01, u0, u1, y + C.h - 0.06, y + C.h)); // 顶部 眉头
    // 柜门 seams: the 仪表门 up top, the main door below it
    put('mouth', box(f, c0, u0 + 0.04, u1 - 0.04, y + 1.85, y + 1.862), ['bottom', Bk]);
    put('mouth', box(f, c0, um - 0.004, um + 0.004, y + 0.18, y + 1.8), ['bottom', Bk]);
    // 观察窗: a dark pane in a pale rim
    const W = P.win;
    put('switchgearHi', box(f, c0, um - W.w / 2 - 0.02, um + W.w / 2 + 0.02, y + W.y - W.h / 2 - 0.02, y + W.y + W.h / 2 + 0.02), ['bottom', Bk]);
    put('crt', box(f - 0.002, f, um - W.w / 2, um + W.w / 2, y + W.y - W.h / 2, y + W.y + W.h / 2), ['bottom', Bk]);
    // two 指示灯 and a 分合闸 knob on the 仪表门
    put('exitSign', box(f - 0.006, f, um - 0.2, um - 0.14, y + 1.95, y + 2.01), ['bottom', Bk]);
    put('valve', box(f - 0.006, f, um - 0.1, um - 0.04, y + 1.95, y + 2.01), ['bottom', Bk]);
    put('ink', box(f - 0.03, f, um + 0.1, um + 0.18, y + 1.94, y + 2.02), ['bottom', Bk]);
    // handle on the main door, the 「有电危险」 plate under the window (red bolt on white)
    put('steel', box(f - 0.03, f, um + 0.12, um + 0.15, y + 1.0, y + 1.2), ['bottom', Bk]);
    put('enamel', box(f - 0.003, f, um - 0.12, um + 0.12, y + 1.08, y + 1.26), ['bottom', Bk]);
    put('valve', box(f - 0.005, f - 0.003, um - 0.1, um + 0.1, y + 1.22, y + 1.245), ['bottom', Bk]);
    put('valve', box(f - 0.005, f - 0.003, um - 0.02, um + 0.02, y + 1.1, y + 1.21), ['bottom', Bk]);
    // a 电缆 drop from the tray into its top
    put('rubber', box(c0 + 0.25, c0 + 0.33, um - 0.04, um + 0.04, y + C.h, y + P.tray.y), ['bottom', 'top']);
  }
  // ── 电缆桥架 over the row, hung on rods, running on to the side wall where the feed comes in
  const T = P.tray, ta0 = c0 + 0.15, ta1 = ta0 + T.w, ceil = y + h - 0.12, side = s > 0 ? wl : wr;
  const [tv0, tv1] = s > 0 ? [side, v1 + 0.2] : [v0 - 0.2, side];
  put('steel', box(ta0, ta1, tv0, tv1, y + T.y, y + T.y + 0.1), ['top']);
  for (const v of [v0 + 0.4, vm, v1 - 0.4]) put('steel', box(ta0 + 0.13, ta0 + 0.17, v - 0.015, v + 0.015, y + T.y + 0.1, ceil), ['bottom', 'top']);
  put('rubber', box(ta0 + 0.04, ta1 - 0.04, tv0 + 0.01, tv1 - 0.01, y + T.y + 0.1, y + T.y + 0.14), ['bottom']); // the cables in it
  // ── 总闸箱 on the side wall away from the door, the tray's end, its lever down in 合闸
  const ga = (c0 + ba) / 2 + 0.6, gy = y + 1.5, [g0, g1] = vs(side, side + s * 0.2);
  put('switchgear', box(ga - 0.3, ga + 0.3, g0, g1, gy - 0.4, gy + 0.4), ['bottom']);
  put('switchgearHi', box(ga - 0.31, ga + 0.31, ...vs(side, side + s * 0.21), gy + 0.36, gy + 0.41), ['bottom']);
  const gf = side + s * 0.2;
  put('ink', box(ga + 0.12, ga + 0.18, ...vs(gf, gf + s * 0.04), gy - 0.05, gy + 0.05));
  put('valve', box(ga + 0.135, ga + 0.165, ...vs(gf + s * 0.04, gf + s * 0.07), gy - 0.3, gy + 0.02)); // 闸把
  put('enamel', box(ga - 0.22, ga + 0.02, ...vs(gf, gf + s * 0.003), gy + 0.05, gy + 0.25));
  put('valve', box(ga - 0.2, ga, ...vs(gf + s * 0.003, gf + s * 0.005), gy + 0.2, gy + 0.23));
  put('steel', box(ga - 0.03, ga + 0.03, ...vs(side, side + s * 0.05), gy + 0.41, ceil), ['bottom', 'top']);
  solid.push(box(ga - 0.3, ga + 0.3, g0, g1, gy - 0.4, gy + 0.4));
  // ── 绝缘胶垫 along the fronts
  put('rubber', box(c0 - P.mat.d, c0 - 0.05, v0 - 0.2, v1 + 0.2, y, y + P.mat.t));
  // ── 值班记录本 on a nail on the door wall, beside the door on the far side from the side wall
  const dv = s > 0 ? p.door[0] - 0.35 : p.door[1] + 0.35, ny = y + 1.4;
  put('file', box(ba, ba + 0.012, dv - 0.11, dv + 0.11, ny - 0.3, ny), ['bottom']);
  put('paper', box(ba + 0.012, ba + 0.016, dv - 0.09, dv + 0.09, ny - 0.28, ny - 0.04), ['bottom']);
  put('steel', box(ba + 0.012, ba + 0.02, dv - 0.05, dv + 0.05, ny - 0.04, ny - 0.01), ['bottom']); // 夹子
  // a 灭火器 in the corner by the door
  const ev = s > 0 ? wr - 0.2 : wl + 0.2, ea = ba + 0.25;
  const q = box(ea - 0.08, ea + 0.08, ev - 0.08, ev + 0.08, y, y + 0.5);
  put('valve', q); solid.push(q);
  put('ink', box(ea - 0.03, ea + 0.03, ev - 0.03, ev + 0.03, y + 0.5, y + 0.58));
  return { render, solid };
}

/**
 * The 图书馆库房 (LIB B1 storeW): 纸箱 of 旧书 stacked two rows deep along the far wall (taped, some labelled, a gap or
 * two, the top ones knocked askew); an old 书架 along the side wall away from the door, half empty, the middle bay's
 * board fallen out onto the floor with the books that were on it; 报废的阅览椅 stacked in threes in the middle and one
 * tipped over; the 待剔旧书推车 parked inside the door, loaded. Same frame as powerFurniture (toiletPlan).
 */
function bookStoreFurniture(b: BuildingDef, r: RoomDef, y: number): { render: FurnBox[]; solid: LBox[] } {
  const p = toiletPlan(b, r), K = BOOKSTORE, render: FurnBox[] = [], solid: LBox[] = [];
  const { box, dir, s, fa, ba, wl, wr } = p, Fd = dir('f'), rng = new Rng(seedOf(`${b.id}.${r.id}.store`));
  const put = (kind: Kind, q: LBox, skip: Face[] = ['bottom'], more: Partial<FurnBox> = {}) => render.push({ ...q, kind, skip, ...more });
  const vs = (a: number, c: number): [number, number] => (a < c ? [a, c] : [c, a]);
  const BOOK: Kind[] = ['bookR', 'bookB', 'bookG', 'bookY', 'bookW'], pick = () => BOOK[Math.floor(rng.next() * BOOK.length)];
  // ── 纸箱 along the far wall, two rows deep
  const C = K.carton, step = C.v + 0.03;
  for (let row = 0; row < 2; row++) {
    const a1 = fa - 0.05 - row * (C.a + 0.03), a0 = a1 - C.a;
    for (let v = wl + 0.1; v + C.v <= wr - 0.13; v += step) {
      if (rng.next() < 0.12) continue;
      const n = 1 + Math.floor(rng.next() * (row ? C.max - 1 : C.max));
      for (let i = 0; i < n; i++) {
        const j = (rng.next() - 0.5) * 0.06, y0 = y + i * C.h, top = i === n - 1;
        const q = box(a0 + j, a1 + j, v + j, v + C.v + j, y0, y0 + C.h);
        const rot = top && rng.next() < 0.4 ? (rng.next() - 0.5) * 0.5 : 0, kind: Kind = rng.next() < 0.5 ? 'box' : 'boxB';
        put(kind, q, i ? [] : ['bottom'], { rot });
        // the packing tape over the top, a 标签 on the door side now and then (straight boxes only: a turned one's would float)
        if (!rot) {
          if (top) put('crateLid', box(a0 + j, a1 + j, v + C.v / 2 + j - 0.025, v + C.v / 2 + j + 0.025, y0 + C.h, y0 + C.h + 0.003));
          if (row && rng.next() < 0.5) put('paper', box(a0 + j - 0.003, a0 + j, v + 0.12 + j, v + 0.3 + j, y0 + 0.12, y0 + 0.24), ['bottom', Fd]);
        }
      }
      solid.push(box(a0, a1, v, v + C.v, y, y + n * C.h));
    }
  }
  // ── the 旧书架 along the side wall away from the door, facing in (+s across)
  const S = K.shelf, side = s > 0 ? wl : wr, sa0 = ba + 2.2, sa1 = sa0 + S.bays * S.bay;
  const [c0, c1] = vs(side, side + s * S.d), back = side + s * 0.02, face = side + s * S.d;
  put('shelf', box(sa0, sa1, c0, c1, y, y + 0.1), ['bottom']);
  put('shelf', box(sa0, sa1, c0, c1, y + S.h - 0.02, y + S.h));
  put('shelfBack', box(sa0, sa1, ...vs(side, back), y + 0.1, y + S.h - 0.02), ['bottom', 'top']);
  for (let k = 0; k <= S.bays; k++) { const q = sa0 + k * S.bay; put('shelf', box(Math.max(sa0, q - 0.015), Math.min(sa1, q + 0.015), c0, c1, y, y + S.h)); }
  solid.push(box(sa0, sa1, c0, c1, y, y + S.h));
  for (let k = 0; k < S.bays; k++) {
    const u0 = sa0 + k * S.bay + 0.02, u1 = u0 + S.bay - 0.04;
    for (let i = 0; i < S.tiers.length; i++) {
      const ty = y + S.tiers[i], broken = k === 1 && i === 2;
      if (i > 0 && !broken) put('shelf', box(u0, u1, ...vs(back, face), ty - 0.02, ty), ['bottom']);
      if (broken || (k === 1 && i === 3) || rng.next() < 0.3) continue; // empty tier (and the one that lost its board)
      // a run or two of books, leaning into the gap at its end
      let u = u0 + rng.range(0, 0.25);
      while (u < u1 - 0.06) {
        const w = Math.min(u1 - u, rng.range(0.04, 0.09)), bh = rng.range(0.2, 0.32);
        if (rng.next() < 0.15) { u += rng.range(0.1, 0.25); continue; }
        put(pick(), box(u, u + w - 0.003, ...vs(back, back + s * rng.range(0.17, 0.24)), ty, ty + bh));
        u += w;
      }
    }
  }
  // the fallen board on the floor in front of the middle bay and the books that slid off it, flat
  const fb = sa0 + S.bay * 1.5, fv = face + s * 0.35;
  put('shelf', box(fb - S.bay / 2 + 0.05, fb + S.bay / 2 - 0.05, fv - 0.13, fv + 0.13, y, y + 0.02), ['bottom'], { rot: 0.35 });
  for (let i = 0; i < 7; i++) {
    const a = fb + rng.range(-0.6, 0.6), v = face + s * rng.range(0.15, 0.9), bh = rng.range(0.03, 0.05);
    put(pick(), box(a - 0.1, a + 0.1, v - 0.14, v + 0.14, y, y + bh), ['bottom'], { rot: rng.range(-1.2, 1.2) });
  }
  // ── 阅览椅 stacked in the middle, backs toward the far wall; one tipped over beside them
  const H = K.chairs, am = (sa1 + fa - 1) / 2, vm = (wl + wr) / 2;
  const stacks = [vm - s * 1.2, vm + s * 0.1, vm + s * 1.4];
  stacks.forEach((cv, k) => {
    const n = H.n - k, a0 = am - H.d / 2 + k * 0.08, a1 = a0 + H.d, v0 = cv - H.w / 2, v1 = cv + H.w / 2;
    for (const [la, lv] of [[a0, v0], [a0, v1 - 0.03], [a1 - 0.03, v0], [a1 - 0.03, v1 - 0.03]]) put('steel', box(la, la + 0.03, lv, lv + 0.03, y, y + H.seat - 0.04), ['bottom', 'top']);
    for (let i = 0; i < n; i++) {
      const sy = y + H.seat + i * H.rise;
      put('chair', box(a0, a1, v0, v1, sy - 0.04, sy), i ? [] : ['bottom']);
      put('chair', box(a1 - 0.03, a1, v0, v1, sy, sy + (i === n - 1 ? H.back : H.rise - 0.04)), ['bottom']);
      // the next one's legs sit outside this seat's sides: a steel rail each side
      if (i) for (const lv of [v0 - 0.015, v1]) put('steel', box(a0 + 0.02, a1 - 0.02, lv, lv + 0.015, sy - H.rise, sy - 0.04));
    }
    solid.push(box(a0, a1, v0 - 0.015, v1 + 0.015, y, y + H.seat + (n - 1) * H.rise + H.back));
  });
  // the tipped one: on its back, seat standing up, legs out toward the door
  const ta = am - 1.1, tv = vm - s * 0.3;
  put('chair', box(ta - 0.02, ta + 0.02, tv - H.w / 2, tv + H.w / 2, y + 0.02, y + H.d + 0.02));
  put('chair', box(ta, ta + H.back + 0.04, tv - H.w / 2, tv + H.w / 2, y, y + 0.03));
  for (const lv of [tv - H.w / 2, tv + H.w / 2 - 0.03]) for (const ly of [y + 0.05, y + H.d - 0.03]) put('steel', box(ta - H.seat + 0.04, ta - 0.02, lv, lv + 0.03, ly, ly + 0.03), []);
  solid.push(box(ta - H.seat, ta + H.back + 0.04, tv - H.w / 2, tv + H.w / 2, y, y + H.d + 0.02));
  // ── two 木托盘 out on the floor, 旧书 tied in bundles (纸绳 crossed over the top), stacked three or four high
  for (const [pa, pv] of [[-1.2, vm - s * 2.0], [-1.2, vm - s * 0.4]]) {
    const P = 0.6;
    put('crateLid', box(pa - P, pa + P, pv - 0.5, pv + 0.5, y, y + 0.12));
    for (const sa of [-1, 0, 1]) put('crate', box(pa + sa * (P - 0.05) - 0.05, pa + sa * (P - 0.05) + 0.05, pv - 0.5, pv + 0.5, y + 0.12, y + 0.14), ['bottom']);
    let top = y + 0.14;
    for (const [ba0, bv0] of [[-1, -1], [-1, 0], [0, -1], [0, 0]]) {
      const n = 2 + Math.floor(rng.next() * 3);
      for (let i = 0; i < n; i++) {
        const j = (rng.next() - 0.5) * 0.04, a0 = pa + ba0 * 0.56 + 0.03 + j, v0 = pv + bv0 * 0.48 + 0.03 + j, y0 = y + 0.14 + i * 0.2;
        put(rng.next() < 0.6 ? 'bookW' : 'paper', box(a0, a0 + 0.5, v0, v0 + 0.42, y0, y0 + 0.2), ['bottom']);
        put('ink', box(a0 + 0.24, a0 + 0.26, v0 - 0.003, v0 + 0.423, y0 + 0.2, y0 + 0.203), ['bottom']);
        put('ink', box(a0 - 0.003, a0 + 0.503, v0 + 0.2, v0 + 0.22, y0 + 0.2, y0 + 0.203), ['bottom']);
        top = Math.max(top, y0 + 0.2);
      }
    }
    solid.push(box(pa - P, pa + P, pv - 0.5, pv + 0.5, y, top));
  }
  // ── 待剔旧书推车 inside the door, off the lane in toward the room
  const T = K.cart, dvm = (p.door[0] + p.door[1]) / 2, cvm = dvm - s * 1.15, ka0 = ba + 0.55, ka1 = ka0 + T.a;
  const kv0 = cvm - T.v / 2, kv1 = cvm + T.v / 2;
  for (const [la, lv] of [[ka0, kv0], [ka0, kv1 - 0.025], [ka1 - 0.025, kv0], [ka1 - 0.025, kv1 - 0.025]]) {
    put('steel', box(la, la + 0.025, lv, lv + 0.025, y + 0.1, y + T.decks[1]), ['bottom', 'top']);
    put('rubber', box(la - 0.01, la + 0.035, lv - 0.005, lv + 0.03, y, y + 0.1));
  }
  for (const d of T.decks) put('steel', box(ka0, ka1, kv0, kv1, y + d - 0.025, y + d));
  // the push handle at the door end
  put('steel', box(ka0 - 0.02, ka0, kv0, kv0 + 0.02, y + T.decks[1], y + T.h), ['bottom']);
  put('steel', box(ka0 - 0.02, ka0, kv1 - 0.02, kv1, y + T.decks[1], y + T.h), ['bottom']);
  put('rubber', box(ka0 - 0.03, ka0 + 0.01, kv0, kv1, y + T.h - 0.03, y + T.h));
  // books: a standing row along the top deck, flat piles on the bottom one
  let u = ka0 + 0.03;
  while (u < ka1 - 0.08) { const w = rng.range(0.03, 0.07); put(pick(), box(u, u + w - 0.003, kv0 + 0.04, kv0 + 0.04 + rng.range(0.15, 0.22), y + T.decks[1], y + T.decks[1] + rng.range(0.18, 0.28))); u += w; }
  for (const pa of [ka0 + 0.25, ka0 + 0.62]) {
    let py = y + T.decks[0];
    for (let i = 0; i < 4 + Math.floor(rng.next() * 3); i++) { const bh = rng.range(0.025, 0.045), j = (rng.next() - 0.5) * 0.03; put(pick(), box(pa - 0.12 + j, pa + 0.12 + j, cvm - 0.15 + j, cvm + 0.15 + j, py, py + bh)); py += bh; }
  }
  // the 剔旧单 tucked under the books on top
  put('paper', box(ka1 - 0.25, ka1 - 0.04, kv1 - 0.2, kv1 - 0.03, y + T.decks[1], y + T.decks[1] + 0.003), ['bottom'], { rot: 0.2 });
  solid.push(box(ka0 - 0.03, ka1, kv0, kv1, y, y + T.h));
  return { render, solid };
}

type Put = (kind: Kind, q: LBox, skip?: Face[], more?: Partial<FurnBox>) => void;
/** A box against a wall: u along it, w out from it (inn = +1 / -1 the way into the room), in the toiletPlan frame. */
type At = (u0: number, u1: number, w0: number, w1: number, y0: number, y1: number) => LBox;
type Plan = ReturnType<typeof toiletPlan>;
const vs = (a: number, c: number): [number, number] => (a < c ? [a, c] : [c, a]);
function wallAt(p: Plan, along: 'a' | 'v', wall: number, inn: number): At {
  return (u0, u1, w0, w1, y0, y1) => (along === 'a' ? p.box(u0, u1, ...vs(wall + inn * w0, wall + inn * w1), y0, y1) : p.box(...vs(wall + inn * w0, wall + inn * w1), u0, u1, y0, y1));
}
function kit(b: BuildingDef, r: RoomDef, tag: string) {
  const p = toiletPlan(b, r), render: FurnBox[] = [], solid: LBox[] = [], rng = new Rng(seedOf(`${b.id}.${r.id}.${tag}`));
  const put: Put = (kind, q, skip = ['bottom'], more = {}) => { render.push({ ...q, kind, skip, ...more }); };
  return { p, render, solid, rng, put };
}

/** 角钢货架 against a wall, u0..u1 in `bays` bays, each tier filled by `fill(u0, u1, w0, w1, y, clear)`. */
function rack(put: Put, solid: LBox[], at: At, u0: number, u1: number, bays: number, y: number, fill: (u0: number, u1: number, w0: number, w1: number, ty: number, clear: number) => void) {
  const R = STORE.rack, w0 = 0.02, w1 = w0 + R.d, top = y + R.tiers[R.tiers.length - 1], bay = (u1 - u0) / bays;
  for (let k = 0; k <= bays; k++) {
    const u = Math.min(u1 - R.post, u0 + k * bay - (k ? R.post / 2 : 0));
    for (const w of [w0, w1 - R.post]) put('rackSteel', at(u, u + R.post, w, w + R.post, y, top + 0.02), ['bottom']);
  }
  R.tiers.forEach((t, i) => {
    put('rackSteel', at(u0, u1, w0, w1, y + t - 0.025, y + t));
    const clear = i < R.tiers.length - 1 ? R.tiers[i + 1] - t - 0.04 : 0.32;
    for (let k = 0; k < bays; k++) fill(u0 + k * bay + R.post, u0 + (k + 1) * bay - R.post, w0 + 0.02, w1 - 0.02, y + t, clear);
  });
  solid.push(at(u0, u1, w0, w1, y, top + 0.02));
}

/** A tier's worth of things along u: boxes of `kinds`, sized to the clear height, a gap now and then. */
function stock(put: Put, at: At, rng: Rng, kinds: Kind[], u0: number, u1: number, w0: number, w1: number, ty: number, clear: number, full = 0.85) {
  let u = u0 + rng.range(0, 0.08);
  while (u < u1 - 0.12) {
    const w = Math.min(u1 - u, rng.range(0.18, 0.42));
    if (rng.next() > full) { u += w; continue; }
    const k = kinds[Math.floor(rng.next() * kinds.length)], h = clear * rng.range(0.45, 0.9), d = (w1 - w0) * rng.range(0.6, 1);
    put(k, at(u, u + w - 0.02, w0, w0 + d, ty, ty + h));
    u += w;
  }
}

/** Stools stacked upside down (seat on seat, legs up): `n` high at (u, w) against a wall, the top one's legs in the air. */
function stoolStack(put: Put, solid: LBox[], at: At, u: number, w: number, y: number, n: number, kind: Kind) {
  const r = 0.16, rise = 0.07, L = 0.42;
  for (let i = 0; i < n; i++) {
    const sy = y + L + i * rise;
    put(kind, at(u - r, u + r, w - r, w + r, sy - 0.035, sy), i ? [] : ['bottom'], { rot: i % 2 ? 0.12 : 0 });
  }
  const t = y + L + (n - 1) * rise;
  // the bottom one's legs on the floor, the top one's up in the air (the ones between are nested out of sight)
  for (const [du, dw] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
    const lu = u + du * (r - 0.04), lw = w + dw * (r - 0.04);
    put('steel', at(lu - 0.012, lu + 0.012, lw - 0.012, lw + 0.012, y, y + L - 0.035), ['bottom', 'top']);
    put('steel', at(lu - 0.012, lu + 0.012, lw - 0.012, lw + 0.012, t, t + L - 0.03), ['bottom']);
  }
  solid.push(at(u - r, u + r, w - r, w + r, y, t + L - 0.03));
}

/** 旧课桌 pair against a wall at u: one upside down on the floor, one upright on it, a chair upturned on top. */
function deskStack(put: Put, solid: LBox[], at: At, u: number, y: number, chair: boolean) {
  const D = STORE.desk, u0 = u - D.w / 2, u1 = u + D.w / 2, w0 = 0.04, w1 = w0 + D.d;
  const desk = (y0: number, up: boolean) => {
    // up: its top lies on the floor, the 桌肚 and legs up; else the right way up
    const [t0, t1] = up ? [y0, y0 + 0.03] : [y0 + D.h - 0.03, y0 + D.h], [m0, m1] = up ? [t1, t1 + 0.15] : [t0 - 0.15, t0];
    const [l0, l1] = up ? [t1, y0 + D.h] : [y0, t0];
    put('wood', at(u0, u1, w0, w1, t0, t1), up ? ['bottom'] : []);
    put('steel', at(u0 + 0.03, u1 - 0.03, w0 + 0.02, w1 - 0.02, m0, m1));
    for (const lu of [u0 + 0.02, u1 - 0.045]) for (const lw of [w0 + 0.02, w1 - 0.045]) put('steel', at(lu, lu + 0.025, lw, lw + 0.025, l0, l1), ['bottom', 'top']);
  };
  desk(y, true);
  desk(y + D.h, false);
  let top = y + 2 * D.h;
  if (chair) {
    const s = 0.19, cu = u + 0.04, cw = (w0 + w1) / 2;
    put('chair', at(cu - s, cu + s, cw - s, cw + s, top, top + 0.025));
    for (const du of [-1, 1]) for (const dw of [-1, 1]) {
      const lu = cu + du * (s - 0.03), lw = cw + dw * (s - 0.03);
      put('steel', at(lu - 0.012, lu + 0.012, lw - 0.012, lw + 0.012, top + 0.025, top + 0.45), ['bottom']);
    }
    top += 0.45;
  }
  solid.push(at(u0, u1, w0, w1, y, top));
}

/** 拖把桶 with a mop stood in it, two 扫帚 and a 簸箕 against a wall at u (at: wallAt). */
function mopCorner(put: Put, solid: LBox[], at: At, u: number, y: number) {
  put('pail', at(u - 0.16, u + 0.16, 0.06, 0.38, y, y + 0.34), ['bottom'], { rot: 0.4 });
  put('ink', at(u - 0.13, u + 0.13, 0.09, 0.35, y + 0.3, y + 0.31), ['bottom'], { rot: 0.4 });
  put('cloth', at(u - 0.1, u + 0.1, 0.12, 0.32, y + 0.31, y + 0.42), ['bottom'], { rot: 0.9 });
  put('bamboo', at(u - 0.015, u + 0.015, 0.205, 0.235, y + 0.42, y + 1.45), ['bottom']);
  for (const [k, du] of [[0, 0.42], [1, 0.62]] as const) {
    const bu = u + du;
    put('straw', at(bu - 0.13, bu + 0.13, 0, 0.07, y, y + 0.3), ['bottom']);
    put('twine', at(bu - 0.05, bu + 0.05, 0, 0.08, y + 0.28, y + 0.36), ['bottom']);
    put('bamboo', at(bu - 0.015, bu + 0.015, 0.02, 0.05, y + 0.36, y + 1.25 + k * 0.08), ['bottom']);
  }
  // the 簸箕 stood on its edge, handle up
  put('pail', at(u + 0.85, u + 1.13, 0.01, 0.04, y, y + 0.26), ['bottom']);
  put('bamboo', at(u + 0.975, u + 1.005, 0.015, 0.035, y + 0.26, y + 0.72), ['bottom']);
  solid.push(at(u - 0.17, u + 1.14, 0, 0.39, y, y + 1.4));
}

/**
 * 杂物间 (LAB L2/L3 junk, 3.2 × 5.46, door in the middle of the short wall): 拖把桶 / 扫帚 / 簸箕 on one side just inside
 * the door, the old 课桌 stacked in pairs further in on that side; a 角钢货架 down the other wall (油漆桶, 纸箱, 旧灯管
 * and 抹布); 方凳 stacked upside down against the far wall. A lane down the middle.
 */
function junkFurniture(b: BuildingDef, r: RoomDef, y: number): { render: FurnBox[]; solid: LBox[] } {
  const { p, render, solid, rng, put } = kit(b, r, 'junk'), { ba, fa, wl, wr } = p;
  const L = wallAt(p, 'a', wl, 1), R = wallAt(p, 'a', wr, -1), F = wallAt(p, 'v', fa, -1);
  mopCorner(put, solid, R, ba + 0.35, y);
  deskStack(put, solid, R, ba + 2.0, y, true);
  deskStack(put, solid, R, ba + 2.7, y, false);
  rack(put, solid, L, ba + 0.6, fa - 0.05, 3, y, (u0, u1, w0, w1, ty, clear) => {
    if (ty - y < 0.3) { // the bottom tier: 油漆桶, two or three, one with its lid off
      for (let u = u0 + 0.05; u < u1 - 0.3; u += rng.range(0.3, 0.45)) put(rng.next() < 0.5 ? 'paintCan' : 'pail', L(u, u + 0.26, w0 + 0.05, w0 + 0.31, ty, ty + 0.3));
      return;
    }
    stock(put, L, rng, ['box', 'boxB', 'paper', 'cloth'], u0, u1, w0, w1, ty, clear, 0.7);
  });
  // 旧灯管 laid along the rack's top, a bundle
  put('enamel', L(ba + 0.7, ba + 1.9, 0.1, 0.16, y + STORE.rack.tiers[4], y + STORE.rack.tiers[4] + 0.03));
  for (let i = 0; i < 3; i++) stoolStack(put, solid, F, wl + 0.75 + i * 0.42 + (i === 2 ? 0.05 : 0), 0.3, y, 4 - i, 'labStool');
  return { render, solid };
}

/**
 * 库房 (LAB L3 store3): 角钢货架 along the far wall and down the side away from the door, 旧仪器 boxed up (纸箱, 铜件,
 * 玻璃器皿 in 标本罐 jars, brown 试剂瓶 left over), an old 黑板 stood against the door-side wall, 实验凳 stacked.
 */
function labStoreFurniture(b: BuildingDef, r: RoomDef, y: number): { render: FurnBox[]; solid: LBox[] } {
  const { p, render, solid, rng, put } = kit(b, r, 'store'), { ba, fa, wl, wr, s } = p;
  const away = s > 0 ? wl : wr, near = s > 0 ? wr : wl, F = wallAt(p, 'v', fa, -1), A = wallAt(p, 'a', away, s), N = wallAt(p, 'a', near, -s);
  const fill = (at: At) => (u0: number, u1: number, w0: number, w1: number, ty: number, clear: number) =>
    stock(put, at, rng, ['box', 'boxB', 'box', 'brass', 'jar', 'reagentB', 'reagentC'], u0, u1, w0, w1, ty, clear, 0.8);
  rack(put, solid, F, wl + 0.05, wr - 0.05, 3, y, fill(F));
  rack(put, solid, A, ba + 0.4, fa - 0.55, 2, y, fill(A));
  // the old 黑板: green-black board in its wooden frame, stood on the floor against the door-side wall, a little out at the foot
  const b0 = ba + 1.7, b1 = b0 + 1.8, BH = 1.15;
  put('frame', N(b0, b1, 0.03, 0.1, y, y + BH));
  put('board', N(b0 + 0.05, b1 - 0.05, 0.1, 0.105, y + 0.05, y + BH - 0.05), ['bottom']);
  put('frame', N(b0, b1, 0.1, 0.16, y + 0.05, y + 0.1), ['bottom']); // 粉笔槽
  solid.push(N(b0, b1, 0.03, 0.16, y, y + BH));
  const vm = (wl + wr) / 2;
  for (const [k, dv] of [[0, -0.55], [1, 0.0]] as const) stoolStack(put, solid, F, vm + dv * s, 0.47 + 0.35, y, 5 - k * 2, 'labStool');
  return { render, solid };
}

/**
 * 食堂库房 (CAN 2F store, 6.76 × 6.26): 米面袋 stacked on 木托盘 along the far wall (白面袋 / 编织米袋, criss-crossed, the
 * top ones slumped), a 调料架 (角钢货架) down the side wall away from the door with 酱油 / 醋 tubs, 盐 and 味精 cartons,
 * 油桶 in a row by the door-side wall, a broken 连体餐桌's stools stacked upside down, a 磅秤 by the door.
 */
function canStoreFurniture(b: BuildingDef, r: RoomDef, y: number): { render: FurnBox[]; solid: LBox[] } {
  const { p, render, solid, rng, put } = kit(b, r, 'store'), { ba, fa, wl, wr, s } = p, S = STORE;
  const away = s > 0 ? wl : wr, near = s > 0 ? wr : wl, A = wallAt(p, 'a', away, s), N = wallAt(p, 'a', near, -s), F = wallAt(p, 'v', fa, -1);
  // ── 木托盘 of 米面袋 along the far wall (u along v from the side rack's end), 4 sacks a layer, layers crossed
  const P = S.pallet, K = S.sack, u0 = Math.min(wl, wr) + 0.6, u1 = Math.max(wl, wr) - 0.1;
  for (let u = u0; u + P.v <= u1 + 1e-6; u += P.v + 0.12) {
    put('crateLid', F(u, u + P.v, 0.05, 0.05 + P.a, y, y + 0.04));
    for (const k of [0.02, 0.48, 0.94]) put('crateLid', F(u + k * (P.v - 0.06), u + k * (P.v - 0.06) + 0.06, 0.05, 0.05 + P.a, y + 0.04, y + 0.1), ['bottom']);
    put('crate', F(u, u + P.v, 0.05, 0.05 + P.a, y + 0.1, y + P.h), ['bottom']);
    const n = 3 + Math.floor(rng.next() * 3), rice = rng.next() < 0.5;
    let top = y + P.h;
    for (let i = 0; i < n; i++) {
      const y0 = y + P.h + i * K.h, kind: Kind = (rice ? i % 3 !== 2 : i % 3 === 2) ? 'sackB' : 'sack', last = i === n - 1;
      // two sacks a layer, alternating which way they run; the top layer slumped and a bit askew
      for (const h of [0, 1]) {
        const rot = last ? (rng.next() - 0.5) * 0.3 : 0, sq = last ? 0.85 : 1;
        if (i % 2 === 0) put(kind, F(u + 0.03 + h * (P.v / 2), u + (h + 1) * (P.v / 2) - 0.03, 0.08, 0.05 + P.a - 0.03, y0, y0 + K.h * sq), [], { rot });
        else put(kind, F(u + 0.04, u + P.v - 0.04, 0.08 + h * (P.a / 2), 0.05 + (h + 1) * (P.a / 2) - 0.03, y0, y0 + K.h * sq), [], { rot });
      }
      // the printed band round the room-facing end of the layer (面粉 red, 大米 blue), the sacks' tied ears at their corners
      const yb = y0 + K.h * 0.35, band: Kind = kind === 'sack' ? 'valve' : 'oilCan', fw = 0.05 + P.a - 0.03;
      put(band, F(u + 0.06, u + P.v - 0.06, fw, fw + 0.004, yb, yb + 0.05), ['bottom', 'top']);
      if (i % 2 === 0) for (const e of [u + 0.03, u + P.v - 0.03]) put(kind, F(e - 0.02, e + 0.02, fw - 0.05, fw + 0.02, y0 + K.h * 0.3, y0 + K.h * 0.7), ['bottom']);
      // the stitched top seam of each layer, a darker line
      put('ink', F(u + 0.1, u + P.v - 0.1, 0.05 + P.a / 2 - 0.01, 0.05 + P.a / 2 + 0.01, y0 + K.h * (last ? 0.85 : 1), y0 + K.h * (last ? 0.85 : 1) + 0.003));
      top = y0 + K.h;
    }
    solid.push(F(u, u + P.v, 0.05, 0.05 + P.a, y, top));
  }
  // ── 调料架 down the side wall away from the door
  rack(put, solid, A, ba + 0.5, fa - 0.05 - P.a - 0.25, 3, y, (u0, u1, w0, w1, ty, clear) => {
    if (ty - y < 0.3) { // bottom tier: 酱油 / 醋 tubs (white plastic, a dark cap), one red 辣酱 tub
      for (let u = u0 + 0.03; u < u1 - 0.24; u += 0.27) {
        put(rng.next() < 0.2 ? 'drum' : 'tub', A(u, u + 0.24, w0 + 0.05, w0 + 0.33, ty, ty + 0.38));
        put('ink', A(u + 0.08, u + 0.14, w0 + 0.1, w0 + 0.16, ty + 0.38, ty + 0.42));
      }
      return;
    }
    stock(put, A, rng, ['box', 'boxB', 'enamel', 'tub', 'sackB'], u0, u1, w0, w1, ty, clear, 0.85);
  });
  // ── 油桶 in a row against the door-side wall, beyond the door; one on its side on a chock
  const D = S.drum, dr = D.r;
  for (let i = 0; i < 3; i++) {
    const u = fa - 0.35 - P.a - 0.25 - i * (2 * dr + 0.06) - dr;
    put('oilCan', N(u - dr, u + dr, 0.05, 0.05 + 2 * dr, y, y + D.h), ['bottom'], { rot: Math.PI / 4 });
    put('oilCan', N(u - dr * 0.72, u + dr * 0.72, 0.05 + dr * 0.28, 0.05 + dr * 1.72, y, y + D.h + 0.012), ['bottom']);
    put('ink', N(u - dr * 0.6, u + dr * 0.6, 0.05 + dr * 0.4, 0.05 + dr * 1.6, y + 0.3, y + 0.33), ['bottom'], { rot: Math.PI / 4 });
    put('steel', N(u + 0.06, u + 0.1, 0.05 + dr * 1.2, 0.05 + dr * 1.24 + 0.04, y + D.h + 0.012, y + D.h + 0.03));
    solid.push(N(u - dr, u + dr, 0.05, 0.05 + 2 * dr, y, y + D.h));
  }
  // ── the stools of a broken 餐桌, stacked upside down in the middle
  const vm = (wl + wr) / 2, M = wallAt(p, 'v', fa - P.a - 0.05, -1);
  for (const [k, dv] of [[0, -0.9], [1, -0.5]] as const) stoolStack(put, solid, M, vm + dv * s, 1.1 + k * 0.08, y, 5 - k, 'stool');
  // ── 磅秤 inside the door on the far side from the door wall's corner
  const dv = s > 0 ? p.door[0] - 0.55 : p.door[1] + 0.55, Bw = wallAt(p, 'v', ba, 1);
  put('steel', Bw(dv - 0.3, dv + 0.3, 0.35, 0.75, y, y + 0.12));
  put('rubber', Bw(dv - 0.27, dv + 0.27, 0.38, 0.72, y + 0.12, y + 0.13), ['bottom']);
  put('steel', Bw(dv - 0.03, dv + 0.03, 0.72, 0.75, y + 0.12, y + 1.0), ['bottom']);
  put('enamel', Bw(dv - 0.12, dv + 0.12, 0.69, 0.75, y + 0.9, y + 1.1));
  solid.push(Bw(dv - 0.3, dv + 0.3, 0.35, 0.75, y, y + 1.1));
  return { render, solid };
}
