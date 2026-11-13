import { WALL_T, type BuildingDef, type RoomDef } from '../../../../shared/campus/campus_schema.ts';
import { PART, rectOf } from './rooms.ts';
import { lampsAndFans, type Face, type FurnBox, type Kind } from './classroom.ts';
import { seedOf } from './office.ts';
import { Rng } from '../core/rng.ts';
import type { LBox } from '../../../../shared/campus/stairs.ts';

/**
 * 体育馆 (docs/03_campus.md 体育馆①, data/campus/campus.json GYM): one storey, the full height of the hall.
 * - `court` 篮球馆 (an open room, no walls of its own): 木地板 with its plank seams, a 26 × 14 m court drawn on it
 *   (边线, 中线 + 中圈, the painted 限制区 and 罚球圈, 三分线), a 移动篮架 at each end (base, post, arm, 篮板, 篮圈),
 *   steel 三角桁架 across the span with 檩条 between, a 高处灯 hung under every truss (its lamp glass lit like a 日光灯
 *   tube at night), 肋木 along the north wall, 长凳 along the south wall, the 记分台 with its 翻分牌 by the south 边线.
 * - `equip` 器材室 (a walled room, its door locked with key `equip`): a 吊顶 at 3.2 m on a T-bar grid with its own
 *   日光灯, 体操垫 piled in a stack, a 跳箱, a 球车 of basketballs, a row of 栏架 nested together, two 跳高架 leaned in
 *   the corner, a steel shelf of 实心球 and 跳绳.
 * Building-local boxes (plan x / z straight, the hall runs along x); pure. The render goes through classroom.ts
 * furnitureGeometry.
 */
export const GYM = {
  /** court: length along x, width along z, line width, painted top above the floor (wood top + paint) */
  court: { L: 26, W: 14, line: 0.08, wood: 0.035, circle: 1.8, key: [5.8, 4.9] as [number, number], basket: 1.575, three: 6.75, corner: 6.6 },
  /** plank seams every `plank` across z */
  plank: 1.2,
  /** 篮架: 篮板 face this far in from the baseline, its size and bottom; rim height, radius */
  hoop: { face: 1.2, board: [1.8, 1.05] as [number, number], bottom: 2.9, rim: 3.05, r: 0.23 },
  /** 桁架: bottom / top chord heights, every `pitch` along x; lamps hung `drop` under the bottom chord every `lamp` along z */
  truss: { y0: 8.9, y1: 10.5, pitch: 6, panel: 2.4, lamp: 6, drop: 0.6 },
  /** 器材室 吊顶 height */
  ceiling: 3.2,
};

type Out = { render: FurnBox[]; solid: LBox[] };
const bx = (x0: number, x1: number, z0: number, z1: number, y0: number, y1: number): LBox => ({ x0, x1, z0, z1, y0, y1 });

/** Furniture of a 体育馆 room (building-local, y = its storey floor). */
export function gymFurniture(b: BuildingDef, r: RoomDef, y: number, h: number): Out {
  return r.kind === 'court' ? courtFurniture(b, r, y, h) : equipFurniture(b, r, y);
}

/** Where a walker stands in a 体育馆 room (building-local x, z): 1.2 m inside a 器材室's door; a court's centre. */
export function gymSpot(b: BuildingDef, r: RoomDef): [number, number] {
  const d = r.doors?.[0];
  if (r.kind !== 'equip' || !d) return [r.x, r.z];
  const I = inner(b, r), s = d.side[0] === '+' ? 1 : -1;
  return d.side[1] === 'z' ? [r.x + d.at, (s > 0 ? I.z1 : I.z0) - s * 1.2] : [(s > 0 ? I.x1 : I.x0) - s * 1.2, r.z + d.at];
}

/** The usable rect of a room: the outer wall's inner face, or PART.t / 2 off a shared edge. */
function inner(b: BuildingDef, r: RoomDef) {
  const R = rectOf(r), t = PART.t / 2, hw = b.w / 2 - WALL_T, hd = b.d / 2 - WALL_T, e = 0.05;
  return {
    x0: Math.abs(R.x0 + hw) < e ? R.x0 : R.x0 + t, x1: Math.abs(R.x1 - hw) < e ? R.x1 : R.x1 - t,
    z0: Math.abs(R.z0 + hd) < e ? R.z0 : R.z0 + t, z1: Math.abs(R.z1 - hd) < e ? R.z1 : R.z1 - t,
  };
}

function courtFurniture(b: BuildingDef, r: RoomDef, y: number, h: number): Out {
  const hw = b.w / 2 - WALL_T, hd = b.d / 2 - WALL_T;
  const out: Out = { render: [], solid: [] }, I = { x0: -hw, x1: hw, z0: -hd, z1: hd }, C = GYM.court;
  const put = (kind: Kind, q: LBox, skip: Face[] = ['bottom'], more: Partial<FurnBox> = {}) => out.render.push({ ...q, kind, skip, ...more });
  const wy = y + C.wood, ly0 = wy + 0.004, ly1 = wy + 0.007;
  // 木地板 over this room (the open rooms of the hall butt into each other), plank seams along it
  const F = rectOf(r);
  put('maple', bx(F.x0, F.x1, F.z0, F.z1, y, wy));
  for (let z = Math.ceil((F.z0 + 0.1) / GYM.plank) * GYM.plank; z < F.z1 - 0.1; z += GYM.plank) put('mapleSeam', bx(F.x0, F.x1, z - 0.006, z + 0.006, wy, wy + 0.002), ['bottom', '+x', '-x']);
  // everything else once, from the room the hall's centre is in: the court centred on the building, the roof over
  // all of it (I = the outer walls' inner faces)
  if (Math.abs(r.x) > r.w / 2 || Math.abs(r.z) > r.d / 2) return out;
  const cx = 0, cz = 0, hx = C.L / 2, hz = C.W / 2, lw = C.line / 2;
  /** a painted line from (x0, z0) to (x1, z1) (turned in plan) */
  const seg = (x0: number, z0: number, x1: number, z1: number, kind: Kind = 'courtLine', y0 = ly0, y1 = ly1) => {
    const len = Math.hypot(x1 - x0, z1 - z0), mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
    put(kind, bx(mx - len / 2 - lw, mx + len / 2 + lw, mz - lw, mz + lw, y0, y1), ['bottom'], { rot: Math.atan2(z1 - z0, x1 - x0) });
  };
  /** an arc of radius R about (ox, oz) from angle a0 to a1, in n segments */
  const arc = (ox: number, oz: number, R: number, a0: number, a1: number, n: number) => {
    for (let k = 0; k < n; k++) {
      const p = a0 + ((a1 - a0) * k) / n, q = a0 + ((a1 - a0) * (k + 1)) / n;
      seg(ox + R * Math.cos(p), oz + R * Math.sin(p), ox + R * Math.cos(q), oz + R * Math.sin(q));
    }
  };
  // 边线 / 端线 / 中线 / 中圈
  for (const s of [-1, 1]) {
    seg(cx - hx, cz + s * hz, cx + hx, cz + s * hz);
    seg(cx + s * hx, cz - hz, cx + s * hx, cz + hz);
  }
  seg(cx, cz - hz, cx, cz + hz);
  arc(cx, cz, C.circle, 0, Math.PI * 2, 24);
  for (const s of [-1, 1]) {
    const base = cx + s * hx, ft = base - s * C.key[0], kw = C.key[1] / 2, bk = base - s * C.basket;
    // the painted 限制区 (under its lines), 罚球圈, 三分线 (straight in the corners, an arc round the basket)
    put('keyPaint', bx(Math.min(base, ft), Math.max(base, ft), cz - kw, cz + kw, wy, wy + 0.004), ['bottom', '+x', '-x', '+z', '-z']);
    seg(ft, cz - kw, ft, cz + kw);
    for (const e of [-1, 1]) seg(base, cz + e * kw, ft, cz + e * kw);
    arc(ft, cz, C.circle, s > 0 ? Math.PI / 2 : -Math.PI / 2, s > 0 ? Math.PI * 1.5 : Math.PI / 2, 12);
    const cut = Math.asin(C.corner / C.three), xc = bk - s * C.three * Math.cos(cut);
    for (const e of [-1, 1]) seg(base, cz + e * C.corner, xc, cz + e * C.corner);
    arc(bk, cz, C.three, s > 0 ? Math.PI - cut : -cut, s > 0 ? Math.PI + cut : cut, 18);
    hoopStand(put, out.solid, s, base, cz, y);
  }
  // ── 三角桁架 across the span (along z), 檩条 between them, a 高处灯 under each truss
  const T = GYM.truss, ceil = y + h - 0.2;
  const xs: number[] = [];
  for (let x = cx - Math.floor((I.x1 - cx - 1) / T.pitch) * T.pitch; x < I.x1 - 1; x += T.pitch) if (x > I.x0 + 1) xs.push(x);
  for (const x of xs) {
    put('truss', bx(x - 0.07, x + 0.07, I.z0, I.z1, y + T.y0 - 0.12, y + T.y0), ['+z', '-z']);
    put('truss', bx(x - 0.07, x + 0.07, I.z0, I.z1, y + T.y1 - 0.12, y + T.y1), ['+z', '-z']);
    const n = Math.round((I.z1 - I.z0) / T.panel), pz = (I.z1 - I.z0) / n, dh = T.y1 - T.y0 - 0.12;
    for (let k = 0; k <= n; k++) {
      const z = I.z0 + k * pz;
      put('truss', bx(x - 0.03, x + 0.03, z - 0.03, z + 0.03, y + T.y0, y + T.y1 - 0.12), ['top', 'bottom']);
      if (k === n) continue;
      // the diagonal of the panel, leaning the other way past midspan
      const up = k < n / 2, len = Math.hypot(pz, dh), ang = Math.atan2(up ? dh : -dh, pz), mz = z + pz / 2, my = y + T.y0 + dh / 2;
      put('truss', bx(x - 0.025, x + 0.025, mz - len / 2, mz + len / 2, my - 0.025, my + 0.025), ['+z', '-z'], { spin: { axis: 'x', ang } });
    }
    for (let z = cz - Math.floor((cz - I.z0 - 2) / T.lamp) * T.lamp; z < I.z1 - 2; z += T.lamp) {
      const top = y + T.y0 - 0.12, hy = top - T.drop;
      put('steel', bx(x - 0.01, x + 0.01, z - 0.01, z + 0.01, hy + 0.3, top), ['top', 'bottom']);
      put('lamp', bx(x - 0.28, x + 0.28, z - 0.28, z + 0.28, hy, hy + 0.3), ['bottom']);
      put('tube', bx(x - 0.24, x + 0.24, z - 0.24, z + 0.24, hy - 0.02, hy), ['top']);
    }
  }
  for (let z = I.z0 + 3; z < I.z1 - 1; z += 3) put('truss', bx(xs[0], xs[xs.length - 1], z - 0.05, z + 0.05, ceil - 0.1, ceil), ['top', '+x', '-x']);
  wallBars(put, out.solid, cx, I.z1, y);
  benches(put, out.solid, cx, I.z0, y);
  scoreTable(put, out.solid, cx, cz - hz - 1.5, y + C.wood);
  return out;
}
type Put = (kind: Kind, q: LBox, skip?: Face[], more?: Partial<FurnBox>) => void;

/** 移动篮架 at the end `s` (±1 along x) of the court, its baseline at x = base: a weighted base out past the baseline,
 *  the padded post, the arm over the line with its brace, the 篮板 (target square), the 篮圈 and a few net strings. */
function hoopStand(put: Put, solid: LBox[], s: number, base: number, cz: number, y: number): void {
  const H = GYM.hoop, face = base - s * H.face, out = (a: number) => base + s * a;
  const xr = (p: number, q: number): [number, number] => [Math.min(p, q), Math.max(p, q)];
  put('hoopBase', bx(...xr(out(0.9), out(2.9)), cz - 0.6, cz + 0.6, y, y + 0.45));
  put('hoopPad', bx(...xr(out(0.9), out(0.75)), cz - 0.6, cz + 0.6, y, y + 0.45), ['bottom']);
  solid.push(bx(...xr(out(0.75), out(2.9)), cz - 0.6, cz + 0.6, y, y + 0.45));
  // the post (padded to head height), the arm out to the board, a brace under it
  put('hoopPad', bx(...xr(out(1.0), out(1.3)), cz - 0.15, cz + 0.15, y + 0.45, y + 2.0));
  put('hoopPost', bx(...xr(out(1.05), out(1.25)), cz - 0.1, cz + 0.1, y + 2.0, y + 3.6), ['bottom']);
  solid.push(bx(...xr(out(1.0), out(1.3)), cz - 0.15, cz + 0.15, y, y + 3.6));
  put('hoopPost', bx(...xr(out(1.25), face + s * 0.03), cz - 0.07, cz + 0.07, y + 3.35, y + 3.5));
  const bl = Math.hypot(1.25 + H.face - 0.6, 0.8), bm = (out(1.25) + face + s * 0.6) / 2;
  put('hoopPost', bx(bm - bl / 2, bm + bl / 2, cz - 0.04, cz + 0.04, y + 2.95, y + 3.03), ['+x', '-x'], { spin: { axis: 'z', ang: -s * Math.atan2(0.8, 1.25 + H.face - 0.6) } });
  // 篮板: white glass with a black frame and the 小方框 over the rim
  const [bw, bh] = H.board, b0 = y + H.bottom, fx = xr(face, face + s * 0.03);
  put('backboard', bx(...fx, cz - bw / 2, cz + bw / 2, b0, b0 + bh), []);
  const fl = xr(face - s * 0.002, face);
  for (const [z0, z1, y0, y1] of [[-bw / 2, bw / 2, bh - 0.05, bh], [-bw / 2, bw / 2, 0, 0.05], [-bw / 2, -bw / 2 + 0.05, 0, bh], [bw / 2 - 0.05, bw / 2, 0, bh],
    [-0.295, 0.295, 0.15, 0.2], [-0.295, 0.295, 0.6, 0.65], [-0.295, -0.245, 0.15, 0.65], [0.245, 0.295, 0.15, 0.65]] as [number, number, number, number][])
    put('ink', bx(...fl, cz + z0, cz + z1, b0 + y0, b0 + y1), only('+x', '-x'));
  // 篮圈: eight bars round the ring, its bracket to the board, net strings hanging off it
  const rc = face - s * (H.r + 0.15), ry = y + H.rim;
  put('rim', bx(...xr(face, rc + s * H.r), cz - 0.03, cz + 0.03, ry - 0.06, ry));
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2, mx = rc + Math.cos(a) * H.r, mz = cz + Math.sin(a) * H.r, len = 2 * H.r * Math.tan(Math.PI / 8) + 0.02;
    put('rim', bx(mx - 0.012, mx + 0.012, mz - len / 2, mz + len / 2, ry - 0.02, ry), [], { rot: a });
    put('net', bx(mx - 0.004, mx + 0.004, mz - 0.004, mz + 0.004, ry - 0.42, ry - 0.02), ['top', 'bottom']);
  }
}
const ALL: Face[] = ['+x', '-x', '+z', '-z', 'top', 'bottom'];
const only = (...keep: Face[]) => ALL.filter(q => !keep.includes(q));

/** 肋木 along the north wall (its inner face at z = wz): 1 m sections of two uprights and round rungs. */
function wallBars(put: Put, solid: LBox[], cx: number, wz: number, y: number): void {
  const n = 10, x0 = cx - n / 2, z0 = wz - 0.16, top = y + 2.6;
  for (let i = 0; i <= n; i++) put('wood', bx(x0 + i - 0.04, x0 + i + 0.04, z0, wz, y, top), ['bottom', '+z']);
  for (let i = 0; i < n; i++) for (let ry = y + 0.15; ry < top - 0.05; ry += 0.15) put('wood', bx(x0 + i + 0.04, x0 + i + 0.96, z0 + 0.03, z0 + 0.07, ry - 0.02, ry + 0.02), ['+x', '-x']);
  solid.push(bx(x0 - 0.04, x0 + n + 0.04, z0, wz, y, top));
}

/** 长凳 along the south wall (inner face at z = wz), east of the 器材室. */
function benches(put: Put, solid: LBox[], cx: number, wz: number, y: number): void {
  for (const x of [cx - 7, cx - 2.5, cx + 2, cx + 6.5]) {
    const z0 = wz + 0.25, z1 = z0 + 0.3, sy = y + 0.42;
    put('wood', bx(x - 1.5, x + 1.5, z0, z1, sy - 0.04, sy));
    for (const lx of [x - 1.35, x + 1.35]) put('steel', bx(lx - 0.025, lx + 0.025, z0 + 0.03, z1 - 0.03, y, sy - 0.04), ['bottom', 'top']);
    solid.push(bx(x - 1.5, x + 1.5, z0, z1, y, sy));
  }
}

/** 记分台 by the south 边线 (its front edge at z = fz, y = the wood top): a table, two chairs behind it, the 翻分牌. */
function scoreTable(put: Put, solid: LBox[], cx: number, fz: number, y: number): void {
  const z0 = fz - 0.6, top = y + 0.76;
  put('desk', bx(cx - 1.2, cx + 1.2, z0, fz, top - 0.04, top));
  put('desk', bx(cx - 1.2, cx + 1.2, fz - 0.03, fz, y + 0.3, top - 0.04), ['bottom', '-z']); // 前挡板
  for (const x of [cx - 1.15, cx + 1.15]) put('steel', bx(x - 0.025, x + 0.025, z0 + 0.03, z0 + 0.08, y, top - 0.04), ['bottom', 'top']);
  solid.push(bx(cx - 1.2, cx + 1.2, z0, fz, y, top));
  // 翻分牌: an A-frame stand, two cards up a side (the ink pass draws the numerals' edges: plain cards, no digits)
  put('steel', bx(cx - 0.32, cx + 0.32, fz - 0.24, fz - 0.2, top, top + 0.02));
  for (const x of [cx - 0.3, cx + 0.3]) put('steel', bx(x - 0.012, x + 0.012, fz - 0.23, fz - 0.21, top, top + 0.42), ['bottom']);
  for (const [x0, x1] of [[cx - 0.27, cx - 0.02], [cx + 0.02, cx + 0.27]]) {
    put('paper', bx(x0, x1, fz - 0.21, fz - 0.2, top + 0.06, top + 0.4), ['bottom']);
    put('ink', bx(x0 + 0.08, x1 - 0.08, fz - 0.2, fz - 0.198, top + 0.12, top + 0.34), only('+z'));
  }
  for (const x of [cx - 0.6, cx + 0.6]) {
    const cz = z0 - 0.35;
    put('chair', bx(x - 0.21, x + 0.21, cz - 0.21, cz + 0.21, y + 0.41, y + 0.45));
    put('chair', bx(x - 0.21, x + 0.21, cz - 0.23, cz - 0.19, y + 0.45, y + 0.86), ['bottom']);
    put('steel', bx(x - 0.02, x + 0.02, cz - 0.02, cz + 0.02, y, y + 0.41), ['bottom', 'top']);
    solid.push(bx(x - 0.26, x + 0.26, cz - 0.26, cz + 0.26, y, y + 0.86));
  }
}

/**
 * The 器材室's 吊顶 board (building-local, y = its storey floor). It also stops the sun: the hall's high windows
 * (6.4 m up) are above it, so no patch falls through it onto the room's walls (render/interior_light.ts occluders).
 */
export function equipCeiling(b: BuildingDef, r: RoomDef, y: number): LBox {
  const I = inner(b, r), cy = y + GYM.ceiling;
  return bx(I.x0, I.x1, I.z0, I.z1, cy, cy + 0.02);
}

/**
 * 器材室: its 吊顶 on a T-bar grid at GYM.ceiling with 日光灯 under it; 体操垫 piled against the back wall (the top
 * one folded over: 角色061's 被子 goes on it later), a 跳箱, a 球车 of basketballs by the door, nested 栏架, two 跳高架
 * and their 横杆 in the corner, a steel shelf of 实心球 and coiled 跳绳. Laid out from the room's back wall (away from
 * its door) and its left / right ends.
 */
function equipFurniture(b: BuildingDef, r: RoomDef, y: number): Out {
  const out: Out = { render: [], solid: [] }, I = inner(b, r), rng = new Rng(seedOf(`${b.id}.${r.id}@${y.toFixed(1)}`));
  const put = (kind: Kind, q: LBox, skip: Face[] = ['bottom'], more: Partial<FurnBox> = {}) => out.render.push({ ...q, kind, skip, ...more });
  const cy = y + GYM.ceiling;
  // 吊顶: one board, the T-bar grid under it (0.6 m)
  put('ceiling', equipCeiling(b, r, y), ['top']);
  for (let x = I.x0 + 0.6; x < I.x1 - 0.1; x += 0.6) put('steel', bx(x - 0.012, x + 0.012, I.z0, I.z1, cy - 0.01, cy), ['top', '+z', '-z']);
  for (let z = I.z0 + 0.6; z < I.z1 - 0.1; z += 0.6) put('steel', bx(I.x0, I.x1, z - 0.012, z + 0.012, cy - 0.01, cy), ['top', '+x', '-x']);
  out.render.push(...lampsAndFans(r, y, GYM.ceiling + 0.2, 0).out);
  // the door's wall (+z / -z) sets the back: things stand along the far wall and the two ends
  const door = r.doors?.[0], dz = door?.side === '-z' ? -1 : 1, back = dz > 0 ? I.z0 : I.z1, front = dz > 0 ? I.z1 : I.z0;
  const zz = (a: number, d: number): [number, number] => (dz > 0 ? [back + a, back + a + d] : [back - a - d, back - a]);
  const doorX = r.x + (door?.at ?? 0);
  const solid = (q: LBox) => out.solid.push(q);
  // ── 体操垫: a pile of blue-grey mats along the back wall, each a little off the one under it
  let my = y;
  const mx0 = I.x0 + 0.3;
  for (let k = 0; k < 6; k++) {
    const o = rng.range(-0.06, 0.06), t = 0.1;
    put(k % 2 ? 'mat' : 'matB', bx(mx0 + o, mx0 + 2 + o, ...zz(0.1 + Math.abs(o), 1.0), my, my + t));
    put('matEdge', bx(mx0 + o, mx0 + 2 + o, ...zz(0.1 + Math.abs(o), 1.0), my + t * 0.45, my + t * 0.55), ['bottom', 'top']);
    my += t;
  }
  // the top one folded over on itself at one end
  put('mat', bx(mx0 + 1.1, mx0 + 2, ...zz(0.12, 0.96), my, my + 0.1));
  solid(bx(mx0 - 0.1, mx0 + 2.1, ...zz(0, 1.2), y, my + 0.1));
  // ── 跳箱 (five tiers narrowing up, a leather top) next to the mats
  const vx = mx0 + 2.6;
  for (let k = 0; k < 5; k++) {
    const w = 0.7 - k * 0.04, l = 1.4 - k * 0.04, y0 = y + k * 0.2;
    put('vault', bx(vx + (1.4 - l) / 2, vx + (1.4 + l) / 2, ...zz(0.4 + (0.7 - w) / 2, w), y0, y0 + 0.19), ['bottom']);
    put('mouth', bx(vx + 0.45, vx + 0.95, ...zz(0.4 + (0.7 - w) / 2 - 0.004, 0.004), y0 + 0.06, y0 + 0.12), only(dz > 0 ? '-z' : '+z'));
  }
  put('vaultTop', bx(vx + 0.18, vx + 1.22, ...zz(0.4 + 0.08, 0.54), y + 1.0, y + 1.06));
  solid(bx(vx, vx + 1.4, ...zz(0.4, 0.7), y, y + 1.06));
  // ── steel shelf against the far end wall: three boards, 实心球 on two, coiled 跳绳 on the top
  const sx1 = I.x1, sx0 = sx1 - 0.45, sz: [number, number] = zz(0.2, 1.6);
  for (const lv of [0.1, 0.65, 1.2, 1.75]) put('steel', bx(sx0, sx1, ...sz, y + lv, y + lv + 0.02));
  for (const [ex, ez] of [[sx0, sz[0]], [sx0, sz[1]], [sx1, sz[0]], [sx1, sz[1]]]) put('steel', bx(ex - 0.02, ex + 0.02, ez - 0.02, ez + 0.02, y, y + 1.8), ['bottom']);
  for (const lv of [0.12, 0.67]) for (let z = sz[0] + 0.2; z < sz[1] - 0.1; z += 0.3) {
    if (rng.next() < 0.2) continue;
    const ry = y + lv + 0.02, s = 0.11;
    put('medBall', bx(sx0 + 0.22 - s, sx0 + 0.22 + s, z - s, z + s, ry, ry + 2 * s), ['bottom'], { rot: rng.range(0, 1.5) });
  }
  for (let z = sz[0] + 0.25; z < sz[1] - 0.2; z += 0.4) put('rope', bx(sx0 + 0.1, sx0 + 0.36, z - 0.13, z + 0.13, y + 1.24, y + 1.29), ['bottom'], { rot: Math.PI / 4 });
  solid(bx(sx0, sx1, ...sz, y, y + 1.8));
  // ── 跳高架 + 横杆 leaned in the corner by the shelf (front side), 栏架 nested in a row along the front wall
  const hz = dz > 0 ? front - 0.25 : front + 0.25;
  for (const x of [sx1 - 0.25, sx1 - 0.55]) {
    put('hurdle', bx(x - 0.2, x + 0.2, hz - 0.2, hz + 0.2, y, y + 0.03));
    put('hurdle', bx(x - 0.02, x + 0.02, hz - 0.02, hz + 0.02, y + 0.03, y + 2.0), ['bottom']);
    for (let k = 1; k < 8; k++) put('ink', bx(x - 0.021, x + 0.021, hz - 0.021, hz + 0.021, y + k * 0.25, y + k * 0.25 + 0.012), ['top', 'bottom']);
  }
  solid(bx(sx1 - 0.75, sx1, hz - 0.22, hz + 0.22, y, y + 2));
  const hx0 = I.x0 + 0.4;
  for (let k = 0; k < 6; k++) {
    const x = hx0 + k * 0.12, h = 0.76, zf: [number, number] = dz > 0 ? [front - 0.9, front - 0.1] : [front + 0.1, front + 0.9];
    for (const z of zf) put('hurdle', bx(x - 0.015, x + 0.015, z - 0.015, z + 0.015, y + 0.04, y + h), ['bottom']);
    put('hurdle', bx(x - 0.3, x + 0.3, zf[0] - 0.02, zf[0] + 0.02, y, y + 0.03)); // the foot
    put('hurdle', bx(x - 0.3, x + 0.3, zf[1] - 0.02, zf[1] + 0.02, y, y + 0.03));
    put('hurdleBar', bx(x - 0.012, x + 0.012, zf[0], zf[1], y + h - 0.1, y + h), ['bottom']);
  }
  solid(bx(hx0 - 0.3, hx0 + 0.9, ...(dz > 0 ? [front - 0.95, front - 0.05] : [front + 0.05, front + 0.95]) as [number, number], y, y + 0.8));
  // ── 球车: a steel cage on castors by the door, basketballs heaped in it
  const bcx = doorX - 1.6 * Math.sign(doorX - r.x || 1), bcz = front - dz * 0.75;
  put('steel', bx(bcx - 0.5, bcx + 0.5, bcz - 0.35, bcz + 0.35, y + 0.15, y + 0.18));
  for (const ex of [-0.5, 0.5]) for (const ez of [-0.35, 0.35]) {
    put('steel', bx(bcx + ex - 0.012, bcx + ex + 0.012, bcz + ez - 0.012, bcz + ez + 0.012, y + 0.1, y + 0.9), ['bottom']);
    put('knob', bx(bcx + ex - 0.04, bcx + ex + 0.04, bcz + ez - 0.04, bcz + ez + 0.04, y, y + 0.1));
  }
  for (const yy of [0.5, 0.88]) for (const ez of [-0.35, 0.35]) put('steel', bx(bcx - 0.5, bcx + 0.5, bcz + ez - 0.01, bcz + ez + 0.01, y + yy, y + yy + 0.02), ['bottom']);
  for (const yy of [0.5, 0.88]) for (const ex of [-0.5, 0.5]) put('steel', bx(bcx + ex - 0.01, bcx + ex + 0.01, bcz - 0.35, bcz + 0.35, y + yy, y + yy + 0.02), ['bottom']);
  for (let k = 0; k < 14; k++) {
    const s = 0.12, x = bcx + rng.range(-0.36, 0.36), z = bcz + rng.range(-0.22, 0.22), yy = y + 0.18 + (k < 8 ? 0 : 0.2) + rng.range(0, 0.06);
    put('ball', bx(x - s, x + s, z - s, z + s, yy, yy + 2 * s), ['bottom'], { rot: rng.range(0, 1.5) });
  }
  solid(bx(bcx - 0.55, bcx + 0.55, bcz - 0.4, bcz + 0.4, y, y + 0.92));
  return out;
}
