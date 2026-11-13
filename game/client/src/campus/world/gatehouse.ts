import { FLOOR_HEIGHT, floorStack, type BuildingDef, type RoomDef, type Side } from '../../../../shared/campus/campus_schema.ts';
import { PART } from './rooms.ts';
import { lampsAndFans, roomFrame, type Face, type FurnBox, type Kind } from './classroom.ts';
import type { LBox } from '../../../../shared/campus/stairs.ts';

/**
 * 门卫室陈设 (南门①, docs/03_campus.md 室内③): the one room of a walk-in 门卫室 (`kind: 'guard'`), laid out in its own
 * frame facing the window it watches the gate from (its first window: the road side). Under that window the 值班桌,
 * pushed against the wall: the 登记本 open in front of the chair, a 收音机 on the sill end with its aerial up, the
 * 电话, a 搪瓷缸, a small 电视 on the far corner turned toward the chair; a 暖壶 on the floor at the desk's door end. Along
 * the back wall a 铁架床 with a folded 被子, a 衣柜 in the corner away from the window; on the blank side wall a 钟
 * (hands stopped where they are drawn), the 值班表 and a 挂历. One 日光灯 over the middle, no fan. Pure; the render goes
 * through classroom.ts furnitureGeometry with the 教室's and 办公室's.
 */

export const GUARD = {
  /** 值班桌 (across × deep, height, top board) */ desk: { w: 1.3, d: 0.6, h: 0.76, top: 0.03 },
  /** chair (across × along, seat height, back top), its front edge this far off the desk */ chair: { w: 0.42, d: 0.4, seat: 0.45, back: 0.88, out: 0.18 },
  /** 铁架床 (along the back wall × out from it, frame top, mattress) */ bed: { len: 1.9, w: 0.9, h: 0.42, mat: 0.08 },
  /** 衣柜 (across × deep × high) */ wardrobe: { w: 0.56, d: 0.48, h: 1.8 },
  /** 钟 on the side wall: centre height, half size (a square dial reads as round at this size under the ink) */ clock: { y: 2.25, r: 0.15 },
  /** wall sheets (across, height, centre height): 值班表, 挂历 */ sheet: { duty: [0.5, 0.62, 1.55], calendar: [0.34, 0.48, 1.6] },
  /** 窗台 ledge (into the room, thickness), sticking out `over` past the jambs */ sill: { d: 0.14, t: 0.04, over: 0.06 },
};

const vecOf = (s: Side): [number, number] => (s[1] === 'x' ? [s[0] === '+' ? 1 : -1, 0] : [0, s[0] === '+' ? 1 : -1]);

/**
 * The 门卫室's frame (classroom.ts roomFrame facing its watch window) and the spans that matter in it (across, v): the
 * window `win`, the doorway `door` (an entrance in the same wall, or the room's own door there; null when the door is
 * elsewhere), the wall faces `fa` (front), `ba` (back), `wl` / `wr` (left / right side walls; the room is the clear
 * floor inside the outer walls, so its edges are the faces).
 */
export function guardPlan(b: BuildingDef, r: RoomDef) {
  const w0 = r.windows?.[0], front: Side = w0?.side ?? '-z', fr = roomFrame(r, front), t = PART.t / 2;
  const [fx, fz] = vecOf(front), rt: [number, number] = [-fz, fx];
  // a span along the front wall (building-local u, centred on the wall) → across v
  const toV = (u0: number, u1: number, mid: number): [number, number] => {
    const k = front[1] === 'x' ? rt[1] : rt[0], [p, q] = [k * (u0 - mid), k * (u1 - mid)];
    return [Math.min(p, q), Math.max(p, q)];
  };
  const mid = front[1] === 'x' ? r.z : r.x, rmid = mid;
  const win = w0 ? toV(rmid + w0.at - w0.width / 2, rmid + w0.at + w0.width / 2, mid) : [-0.6, 0.6] as [number, number];
  const ent = (b.entrances ?? []).find(e => e.side === front && (e.level ?? 1) === 1);
  const own = r.doors?.find(d => d.side === front);
  const door = ent ? toV(ent.at - ent.width / 2, ent.at + ent.width / 2, mid) : own ? toV(rmid + own.at - own.width / 2, rmid + own.at + own.width / 2, mid) : null;
  return { ...fr, fa: fr.L + t, ba: -fr.L - t, wl: -fr.W - t, wr: fr.W + t, win, door };
}

/** Where a walker stands in the 门卫室 (building-local x, z): in line with the door, between the chair and the 衣柜. */
export function guardSpot(b: BuildingDef, r: RoomDef): [number, number] {
  const p = guardPlan(b, r), dv = p.door ? (p.door[0] + p.door[1]) / 2 : 0;
  const [x, , z] = p.pt((p.fa + p.ba) / 2 + 0.05, dv, 0);
  return [x, z];
}

/**
 * Everything in the 门卫室 (building-local, y = its storey floor): render boxes and colliders (desk, chair, bed,
 * 衣柜). The desk goes under the window on the side away from the door, the bed along the back wall on the same
 * side, the 衣柜 in the back corner on the door side.
 */
export function guardFurniture(b: BuildingDef, r: RoomDef, y: number): { render: FurnBox[]; solid: LBox[] } {
  const p = guardPlan(b, r), G = GUARD, D = G.desk, render: FurnBox[] = [], solid: LBox[] = [];
  const { box, dir } = p, F = dir('f'), B = dir('b'), Rt = dir('r'), Lf = dir('l');
  const put = (kind: Kind, q: LBox, more: Partial<FurnBox> = {}) => render.push({ ...q, kind, ...more });
  /** a box (half sizes ha along, hv across) turned by `rot` about the point (a, v), its centre offset (da, dv) from
   *  there turned with it (as world/office.ts) */
  const turned = (kind: Kind, a: number, v: number, rot: number, ha: number, hv: number, y0: number, y1: number, skip: Face[] = ['bottom'], da = 0, dv = 0) => {
    const [cx, , cz] = p.pt(a, v, 0), [ox, , oz] = p.pt(a + da, v + dv, 0), dx = ox - cx, dz = oz - cz;
    const c = Math.cos(rot), sn = Math.sin(rot), nx = cx + dx * c - dz * sn, nz = cz + dx * sn + dz * c;
    const q = box(-ha, ha, -hv, hv, y0, y1), hx = (q.x1 - q.x0) / 2, hz = (q.z1 - q.z0) / 2;
    put(kind, { x0: nx - hx, x1: nx + hx, z0: nz - hz, z1: nz + hz, y0, y1 }, rot ? { rot, skip } : { skip });
  };
  // which side of the front wall the door is on: +1 = right (v > 0), −1 = left; the desk takes the other side
  const dc = p.door ? (p.door[0] + p.door[1]) / 2 : p.wl, ds = dc > 0 ? 1 : -1, s = -ds;
  const wallS = s > 0 ? p.wr : p.wl, sideS = s > 0 ? Rt : Lf, sideD = s > 0 ? Lf : Rt;

  // ── 值班桌 under the window, from the side wall to just past the window's door-side jamb
  const dv1 = wallS, dv0 = wallS - s * D.w, [v0, v1] = [dv0, dv1].sort((q, w) => q - w);
  const a1 = p.fa, a0 = a1 - D.d, top = y + D.h;
  put('desk', box(a0, a1, v0, v1, top - D.top, top), { skip: ['bottom', F] });
  // a drawer pedestal at the side-wall end, a leg panel at the other, a modesty board along the wall
  const pv = [wallS - s * 0.4, wallS].sort((q, w) => q - w) as [number, number];
  put('desk', box(a0 + 0.02, a1, pv[0], pv[1], y, top - D.top), { skip: ['bottom', 'top', F, sideS] });
  for (const dy of [0.17, 0.36]) put('ink', box(a0 + 0.016, a0 + 0.02, pv[0] + 0.02, pv[1] - 0.02, top - D.top - dy - 0.01, top - D.top - dy), { skip: ['bottom', 'top', F, Rt, Lf] });
  const lv = dv0 + s * 0.02, [l0, l1] = [lv, lv + s * 0.03].sort((q, w) => q - w);
  put('desk', box(a0 + 0.04, a1, l0, l1, y, top - D.top), { skip: ['bottom', 'top', F] });
  solid.push(box(a0, a1, v0, v1, y, top));

  // ── on the desk: 登记本 open in front of the chair, 收音机 at the window end, 电话, 搪瓷缸, the little 电视
  const vm = (dv0 + dv1) / 2, near = a0 + 0.2;
  // 登记本: two open pages on a cover a hair under them, the spine a dark line; a pen across it
  turned('cover', near, vm - s * 0.05, 0.06, 0.15, 0.22, top, top + 0.008);
  turned('paper', near, vm - s * 0.05, 0.06, 0.14, 0.21, top + 0.008, top + 0.014);
  turned('ink', near, vm - s * 0.05, 0.06, 0.13, 0.004, top + 0.014, top + 0.016, ['bottom']);
  for (let l = 0; l < 4; l++) for (const e of [-1, 1]) turned('steel', near - 0.08 + l * 0.05, vm - s * 0.05 + e * 0.11, 0.06, 0.003, 0.08, top + 0.014, top + 0.0155, ['bottom']); // ruled lines
  turned('coverR', near + 0.03, vm + s * 0.17, 0.5, 0.07, 0.005, top + 0.014, top + 0.022);
  // 收音机: a brown wooden case, its speaker cloth on the front, a dial window, the aerial pulled out at a slant
  const ra = a1 - 0.12, rv = dv0 + s * 0.2;
  turned('radio', ra, rv, 0, 0.06, 0.14, top, top + 0.17);
  turned('cloth', ra - 0.061, rv - s * 0.03, 0, 0.002, 0.07, top + 0.03, top + 0.14, ['bottom', 'top']);
  turned('paper', ra - 0.061, rv + s * 0.08, 0, 0.002, 0.035, top + 0.1, top + 0.13, ['bottom', 'top']);
  turned('steel', ra, rv + s * 0.1, 0.4, 0.006, 0.006, top + 0.17, top + 0.62, ['bottom']);
  // 电话: body, the handset lying in its cradle
  const pa = a1 - 0.12, pvv = vm + s * 0.12;
  turned('phone', pa, pvv, -0.2, 0.1, 0.11, top, top + 0.07);
  turned('phone', pa - 0.02, pvv, -0.2, 0.035, 0.12, top + 0.07, top + 0.11);
  // 搪瓷缸 with its red rim, by the 登记本
  turned('enamel', near - 0.04, vm - s * 0.36, Math.PI / 4, 0.04, 0.04, top, top + 0.1);
  turned('coverR', near - 0.04, vm - s * 0.36, Math.PI / 4, 0.042, 0.042, top + 0.09, top + 0.105, ['bottom']);
  // 电视: a deep little CRT on the side-wall corner, turned toward the chair; the screen on its front
  const ta = a1 - 0.22, tv = wallS - s * 0.2, tr = s * 0.35;
  turned('tv', ta, tv, tr, 0.17, 0.18, top, top + 0.3);
  turned('crt', ta, tv, tr, 0.004, 0.14, top + 0.05, top + 0.26, ['bottom', 'top'], -0.172, 0);
  // the rabbit-ear aerial: a little base, two rods splayed
  turned('steel', ta, tv, tr, 0.03, 0.04, top + 0.3, top + 0.32, ['bottom'], 0.05, 0);
  for (const e of [-1, 1]) turned('steel', ta, tv, tr + e * 0.5, 0.005, 0.005, top + 0.32, top + 0.58, ['bottom'], 0.05, e * 0.06);

  // ── the chair, pulled out from the desk and turned a little toward the door
  const C = G.chair, ca = a0 - C.out - C.d / 2, cv = vm - s * 0.05, rot = -s * 0.25, cw = C.w / 2, cd = C.d / 2;
  turned('chair', ca, cv, rot, cd, cw, y + C.seat - 0.04, y + C.seat);
  turned('chair', ca, cv, rot, 0.015, cw, y + C.seat, y + C.back, ['bottom'], -(cd - 0.015), 0); // the back, away from the desk
  for (const e of [-1, 1]) turned('steel', ca, cv, rot, cd - 0.03, 0.012, y, y + C.seat - 0.04, ['bottom', 'top'], 0, e * (cw - 0.03));
  solid.push(box(ca - cd - 0.06, ca + cd + 0.06, cv - cw - 0.06, cv + cw + 0.06, y, y + C.back));

  // ── 暖壶 on the floor at the desk's door end, against the front wall
  const fa = a1 - 0.1, fv = dv0 - s * 0.12;
  turned('thermosR', fa, fv, Math.PI / 4, 0.065, 0.065, y, y + 0.34);
  turned('cup', fa, fv, Math.PI / 4, 0.04, 0.04, y + 0.34, y + 0.4);

  // ── 铁架床 along the back wall on the desk's side: steel frame and legs, the board, a thin mattress, the 被子 folded
  // into a block at the head (side-wall end), a pillow by it
  const Bd = G.bed, ba0 = p.ba, ba1 = p.ba + Bd.w, bv1 = wallS, bv0 = wallS - s * Bd.len, [bl0, bl1] = [bv0, bv1].sort((q, w) => q - w);
  put('steel', box(ba0, ba1, bl0, bl1, y + Bd.h - 0.05, y + Bd.h), { skip: ['bottom', B, sideS] });
  for (const [la, lv2] of [[ba0 + 0.03, bv0 + s * 0.03], [ba1 - 0.03, bv0 + s * 0.03], [ba1 - 0.03, bv1 - s * 0.03]]) turned('steel', la, lv2, 0, 0.02, 0.02, y, y + Bd.h - 0.05, ['bottom', 'top']);
  // head and foot rails (the head one taller), as flat plates edge-on to the ink
  const rails: [number, number][] = [[bv1 - s * 0.02, 0.85], [bv0 + s * 0.02, 0.62]];
  for (const [rv2, h] of rails) {
    const [r0, r1] = [rv2 - 0.012, rv2 + 0.012];
    put('steel', box(ba0, ba1, r0, r1, y + h - 0.04, y + h), { skip: ['bottom', B] });
    turned('steel', ba1 - 0.03, rv2, 0, 0.015, 0.015, y + Bd.h, y + h - 0.04, ['bottom', 'top']);
  }
  put('quilt', box(ba0, ba1 - 0.02, Math.min(bv0 + s * 0.04, bv1 - s * 0.04), Math.max(bv0 + s * 0.04, bv1 - s * 0.04), y + Bd.h, y + Bd.h + Bd.mat), { skip: ['bottom', B] });
  // the 蓝白格 床单's white checks: paper strips both ways on the mattress top, under the 被子 and pillow
  const mt = y + Bd.h + Bd.mat, mv0 = Math.min(bv0 + s * 0.04, bv1 - s * 0.04), mv1 = Math.max(bv0 + s * 0.04, bv1 - s * 0.04);
  for (let k = 1; k <= 6; k++) { const ca2 = ba0 + (k * (Bd.w - 0.02)) / 7; put('paper', box(ca2 - 0.016, ca2 + 0.016, mv0, mv1, mt, mt + 0.003), { skip: ['bottom'] }); }
  for (let k = 1; k <= 13; k++) { const cv2 = mv0 + (k * (mv1 - mv0)) / 14; put('paper', box(ba0, ba1 - 0.02, cv2 - 0.016, cv2 + 0.016, mt, mt + 0.003), { skip: ['bottom'] }); }
  // the 被子 folded into a block (the ink draws its two folds), then the pillow
  const qv = bv1 - s * 0.32;
  turned('blanket', ba0 + Bd.w / 2 - 0.02, qv, 0, 0.32, 0.22, y + Bd.h + Bd.mat, y + Bd.h + Bd.mat + 0.11);
  turned('blanket', ba0 + Bd.w / 2 - 0.02, qv, 0, 0.3, 0.2, y + Bd.h + Bd.mat + 0.11, y + Bd.h + Bd.mat + 0.2);
  turned('enamel', ba0 + Bd.w / 2 - 0.02, qv - s * 0.36, 0.05, 0.26, 0.13, y + Bd.h + Bd.mat, y + Bd.h + Bd.mat + 0.09);
  solid.push(box(ba0, ba1, bl0, bl1, y, y + Bd.h + Bd.mat));

  // ── 衣柜 in the back corner on the door side: two doors, the seam and two handles
  const W = G.wardrobe, wv0 = ds > 0 ? p.wr - W.w : p.wl, wv1 = wv0 + W.w;
  const wa0 = p.ba, wa1 = p.ba + W.d, half = (wv0 + wv1) / 2;
  for (const [q0, q1] of [[wv0, half - 0.006], [half + 0.006, wv1]]) put('cabinet', box(wa0, wa1, q0, q1, y, y + W.h), { skip: ['bottom', B, ...(ds > 0 ? [Rt] : [Lf]) as Face[]] });
  for (const e of [-1, 1]) put('ink', box(wa1, wa1 + 0.012, half + e * 0.03 - 0.01, half + e * 0.03 + 0.01, y + 0.95, y + 1.1), { skip: ['bottom', B, Rt, Lf] });
  solid.push(box(wa0, wa1, wv0, wv1, y, y + W.h));

  // ── the side wall away from the desk (the door side): 钟 up high, 值班表 and 挂历 at eye height, between the
  // 衣柜 and the front wall
  const wallD = ds > 0 ? p.wr : p.wl, off = -ds * 0.006, inD = wallD + off;
  const [k0, k1] = [wallD, inD].sort((q, w) => q - w), sk: Face[] = ['bottom', sideD];
  const fit0 = wa1 + 0.3, fit1 = p.fa - 0.3, cxa = (fit0 + fit1) / 2;
  const Ck = G.clock;
  put('paper', box(cxa - Ck.r, cxa + Ck.r, k0, k1, y + Ck.y - Ck.r, y + Ck.y + Ck.r), { skip: sk });
  const [kk0, kk1] = [inD, inD + off * 0.5].sort((q, w) => q - w);
  put('ink', box(cxa - 0.008, cxa + 0.008, kk0, kk1, y + Ck.y, y + Ck.y + Ck.r * 0.8), { skip: sk }); // minute hand on 12
  put('ink', box(cxa, cxa + Ck.r * 0.55, kk0, kk1, y + Ck.y - 0.008, y + Ck.y + 0.008), { skip: sk }); // hour hand toward 3
  for (const [w, h, cy, a] of [[...G.sheet.duty, cxa - 0.32], [...G.sheet.calendar, cxa + 0.34]] as [number, number, number, number][]) {
    put('paper', box(a - w / 2, a + w / 2, k0, k1, y + cy - h / 2, y + cy + h / 2), { skip: sk });
    const duty = w === G.sheet.duty[0], lines = duty ? 6 : 1, top = y + cy + h / 2;
    if (duty) {
      // 值班表: a red title band, two column rules down the grid
      put('coverR', box(a - w / 2 + 0.03, a + w / 2 - 0.03, kk0, kk1, top - 0.1, top - 0.03), { skip: sk });
      for (const e of [-0.12, 0.08]) put('ink', box(a + e - 0.004, a + e + 0.004, kk0, kk1, y + cy - h / 2 + 0.04, top - 0.1), { skip: sk });
    } else {
      // 挂历: a colour picture (blue sky over a 军绿 hill) on the top half, the month's grid of dates below
      put('quilt', box(a - w / 2 + 0.02, a + w / 2 - 0.02, kk0, kk1, top - 0.14, top - 0.02), { skip: sk });
      put('blanket', box(a - w / 2 + 0.02, a + w / 2 - 0.02, kk0, kk1, top - 0.24, top - 0.14), { skip: sk });
      for (let l = 0; l < 4; l++) put('ink', box(a - w / 2 + 0.03, a + w / 2 - 0.03, kk0, kk1, top - 0.31 - l * 0.045, top - 0.304 - l * 0.045), { skip: sk });
    }
    if (duty) for (let l = 1; l <= lines; l++) {
      const ly = top - 0.1 - (l * (h - 0.14)) / lines;
      put('ink', box(a - w / 2 + 0.03, a + w / 2 - 0.03, kk0, kk1, ly - 0.006, ly), { skip: sk });
    }
  }

  // ── 窗台 under the watch window
  const S = G.sill, w0 = r.windows?.[0];
  if (w0) put('sill', box(p.fa - S.d, p.fa, p.win[0] - S.over, p.win[1] + S.over, y + w0.sill - S.t, y + w0.sill), { skip: [F] });

  // ── ceiling: one 日光灯, no fan
  const h = floorStack(b).find(st => Math.abs(st.y - y) < 1e-6)?.h ?? b.floorHeight ?? FLOOR_HEIGHT;
  render.push(...lampsAndFans(r, y, h, 0).out);
  return { render, solid };
}
