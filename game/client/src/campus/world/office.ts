import { FLOOR_HEIGHT, floorStack, WALL_T, type BuildingDef, type RoomDef, type Side } from '../../../../shared/campus/campus_schema.ts';
import { facadeOpenings } from './building.ts';
import { PART, rectOf } from './rooms.ts';
import { lampsAndFans, roomFrame, type Face, type FurnBox, type Kind } from './classroom.ts';
import type { LBox } from '../../../../shared/campus/stairs.ts';
import { Rng } from '../core/rng.ts';

/**
 * 办公室陈设 (旧办公楼②, docs/03_campus.md 室内③): every 办公室 laid out in its own frame facing its window wall (the
 * door behind): the 办公桌 pushed together into one island of two facing rows across the room, a chair at each (pulled
 * out a little, each its own way), the 档案柜 against the side wall farther from the door, a 窗台 ledge under each window
 * and papers on the walls. 语文组 is the full version: four desks a row, every desk top piled with 作业本 /
 * 教案, a 茶杯 and a 台灯 on some, 饭盒 and 暖壶, 绿萝 on the sill, 课表 / 值日表 / 挂历 on the walls; every 教研组
 * (`officeClass` group) is dressed so, any other 办公室 is the same prefab with at most two desks a row and little on them. Pure; the render goes through classroom.ts
 * furnitureGeometry with the 教室's.
 */

export const OFFICE = {
  /** one 办公桌 (across the room × along, height), its top board, the 抽屉 pedestal at one end, the leg panel at the other */
  desk: { w: 1.2, d: 0.6, h: 0.76, top: 0.03, ped: 0.4, panel: 0.03 },
  /** chair: seat (across × along), seat height, backrest top; pulled out `out` ± `jitter` m from the desk edge */
  chair: { w: 0.42, d: 0.4, seat: 0.45, back: 0.9, out: 0.12, jitter: 0.12 },
  /** desks per row (语文组 / a 处室 / any other), aisle kept at the island's door end, space for the 档案柜 at its other end */
  perRow: { dressed: 4, admin: 3, plain: 2 }, doorAisle: 0.6, cabAisle: 0.8,
  /** 档案柜 units side by side on the side wall (width along it, depth, height); shelves (open, 档案盒 on them) above `split` */
  cabinet: { w: 0.9, d: 0.42, h: 1.85, split: 0.95, gap: 0.012, units: { dressed: 2, plain: 1 } },
  /** 窗台 ledge (into the room, thickness) under each window, sticking out `over` past its jambs */
  sill: { d: 0.16, t: 0.05, over: 0.08 },
  /** wall sheets: (across, height, centre height above the floor) */
  sheet: { timetable: [0.62, 0.46, 1.62], duty: [0.42, 0.56, 1.58], calendar: [0.36, 0.5, 1.6] },
  /** 吊扇 per 办公室 */ fans: 1,
  /** 校长室 / 接待室 (head) and 会议室 (meeting): the 大班台 (across the room × along, height), the 老板椅's seat / back
   *  top, the 皮沙发 (depth, back thickness, seat, back and arm heights, feet), the 茶几, the 锦旗 (width, height,
   *  gap, top edge), the 书柜 (unit width, depth, height, closed doors up to `split`); the 会议桌 (width, height,
   *  end clearance to the side walls, chair pitch), the 横幅's longest length */
  head: {
    desk: { w: 1.6, d: 0.8, h: 0.78 }, boss: { seat: 0.5, back: 1.25 },
    sofa: { d: 0.85, back: 0.22, seat: 0.44, high: 0.88, arm: 0.2, armH: 0.62, foot: 0.08 },
    tea: { h: 0.45 }, pennant: { w: 0.55, h: 0.95, gap: 0.12, top: 2.35 },
    case: { w: 0.9, d: 0.4, h: 2.0, split: 0.8 },
    meeting: { w: 1.2, h: 0.76, end: 0.95, pitch: 0.68, banner: 4.2 },
  },
  /** 处室 / 财务室 / 档案室 铁皮柜: unit width (along the wall), depth, height, a low one's (under a window), the dark
   *  踢脚 at its foot; the 档案室's 角钢铁架 (depth, height, post, decks) and its 登记本 (thickness, height, depth) */
  steel: { w: 0.9, d: 0.42, h: 1.85, low: 0.85, kick: 0.06, gap: 0.012 },
  rack: { d: 0.4, h: 2.0, post: 0.04, decks: [0.1, 0.6, 1.1, 1.6, 1.97], ledger: { t: 0.034, h: 0.31, d: 0.24 } },
  /** 复印室: the 复印机 (along the wall, depth, height), the 速印机 on its stand, a 复印纸 carton */
  print: { copier: { w: 0.62, d: 0.66, h: 1.06 }, dup: { w: 0.72, d: 0.62, h: 0.98 }, carton: { a: 0.45, v: 0.3, h: 0.25 } },
};

/**
 * What an 办公室 is for, by the function on its 门牌 (its name; docs/03_campus.md OFF 房间表): 教研组 (`group`, the
 * 语文组's 拼桌 dressed in full), 处室 (`admin`), 校长室 / 接待室 (`head`), 会议室 (`meeting`), 档案室 / 资料室
 * (`archive`), 复印室 (`print`), 财务室 (`finance`), a bare 「办公室」 (`plain`). Each class gets its own set; until
 * those are built every class but `group` uses the plain prefab.
 */
export type OfficeClass = 'group' | 'admin' | 'head' | 'meeting' | 'archive' | 'print' | 'finance' | 'plain';
export function officeClass(r: RoomDef): OfficeClass {
  const n = r.name;
  if (n === '办公室') return 'plain';
  if (/组(办公室)?$/.test(n)) return 'group';
  if (/(校长室|接待室)$/.test(n)) return 'head';
  if (/(会议室|教研活动室)$/.test(n)) return 'meeting';
  if (/(档案室|资料室)$/.test(n)) return 'archive';
  if (/(复印室|文印室)$/.test(n)) return 'print';
  if (n.endsWith('财务室')) return 'finance';
  return 'admin';
}

const vecOf = (s: Side): [number, number] => (s[1] === 'x' ? [s[0] === '+' ? 1 : -1, 0] : [0, s[0] === '+' ? 1 : -1]);
const opposite = (s: Side): Side => `${s[0] === '+' ? '-' : '+'}${s[1]}` as Side;
/** A small stable hash of the room id: its own seed, so every 办公室 is untidy in its own way. */
export const seedOf = (id: string) => [...id].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);

/**
 * An 办公室's frame (classroom.ts roomFrame facing away from its door) plus where things stand in it: the door's
 * across offset `dv`, the walls' real faces (`fa`: the window wall's along; `wl` / `wr`: the left / right walls' across;
 * a partition stands PART.t / 2 in from the room edge, an outer wall's face is the edge), the island (along extent
 * ±`ia`, across [i0, i1], desks per row) and the side the 档案柜 is on (`cs` = ±1, 0 = none).
 */
export function officePlan(b: BuildingDef, r: RoomDef) {
  const door = r.doors?.[0]?.side ?? '+z', front = opposite(door), fr = roomFrame(r, front), O = OFFICE;
  const [fx, fz] = vecOf(front), rt: [number, number] = [-fz, fx];
  const R = rectOf(r), ix = b.w / 2 - WALL_T, iz = b.d / 2 - WALL_T, t = PART.t / 2;
  /** the room edge on side s is on the outer wall */
  const outer = (s: Side) => {
    const e = s === '+x' ? R.x1 : s === '-x' ? R.x0 : s === '+z' ? R.z1 : R.z0;
    return Math.abs(Math.abs(e) - (s[1] === 'x' ? ix : iz)) < 0.05;
  };
  const fa = fr.L + (outer(front) ? t : 0), wr = fr.W + (outer(fr.dir('r')) ? t : 0), wl = -fr.W - (outer(fr.dir('l')) ? t : 0);
  const d0 = r.doors?.[0], dv = d0 ? (door[1] === 'z' ? rt[0] * d0.at : rt[1] * d0.at) : 0;
  const cls = officeClass(r), dressed = cls === 'group', D = O.desk, C = O.cabinet;
  // the 档案柜 on the side wall farther from the door, if the island still gets a desk a row beside it
  let cs = dv > 0 ? -1 : 1;
  const room = (cab: boolean) => wr - wl - O.doorAisle - (cab ? C.d + O.cabAisle : 0.3);
  if (Math.floor(room(true) / D.w) < 1) cs = 0;
  const n = Math.max(0, Math.min(dressed ? O.perRow.dressed : cls === 'admin' ? O.perRow.admin : O.perRow.plain, Math.floor(room(cs !== 0) / D.w)));
  // the island centred in what is left between the door end's aisle and the 档案柜 (or the far wall)
  const lo = cs < 0 ? wl + C.d + O.cabAisle : wl + (dv < 0 ? O.doorAisle : 0.3);
  const hi = cs > 0 ? wr - C.d - O.cabAisle : wr - (dv > 0 ? O.doorAisle : 0.3);
  const ic = (lo + hi) / 2, i0 = ic - (n * D.w) / 2, i1 = ic + (n * D.w) / 2;
  const reach = D.d + O.chair.out + O.chair.jitter + O.chair.d; // island centre → a chair's back, at the most
  return { ...fr, front, dv, fa, wl, wr, n, i0, i1, ia: reach, cs, dressed };
}

/** Where a walker stands "in" an 办公室 (building-local x, z): just inside the door, between it and the chairs. */
export function officeSpot(b: BuildingDef, r: RoomDef): [number, number] {
  const p = officePlan(b, r), a = (-p.L + -p.ia) / 2;
  const [x, , z] = p.pt(a, p.dv, 0);
  return [x, z];
}

/** The 办公室's windows on its window wall at this storey, as across spans [v0, v1] and the sill height (building-local y). */
function windowSpans(b: BuildingDef, r: RoomDef, p: ReturnType<typeof officePlan>, y: number) {
  const rt: [number, number] = [-p.f[1], p.f[0]];
  const toV = (u: number) => (p.front[1] === 'z' ? rt[0] * (u - r.x) : rt[1] * (u - r.z));
  return facadeOpenings(b).filter(o => o.kind === 'window' && !o.court && o.side === p.front && o.y0 >= y && o.y0 < y + 3)
    .map(o => { const [v0, v1] = [toV(o.u0), toV(o.u1)].sort((q, s) => q - s); return { v0, v1, y0: o.y0 }; })
    .filter(w => w.v0 > p.wl && w.v1 < p.wr);
}

/**
 * Everything in one 办公室 (building-local, y from the storey floor `y`): render boxes and colliders (the desk island,
 * each chair, the 档案柜). Desk tops and the sill get their clutter from the room's own seed (stable run to run).
 */
export function officeFurniture(b: BuildingDef, r: RoomDef, y: number): { render: FurnBox[]; solid: LBox[] } {
  const p = officePlan(b, r), O = OFFICE, D = O.desk, C = O.chair, render: FurnBox[] = [], solid: LBox[] = [];
  const { box, dir } = p, ac = 0, rng = new Rng(seedOf(`${r.id}@${y.toFixed(1)}`)), dressed = p.dressed;
  const put = (kind: Kind, q: LBox, more: Partial<FurnBox> = {}) => render.push({ ...q, kind, ...more });
  const F = dir('f'), B = dir('b'), Rt = dir('r'), Lf = dir('l');
  /** a box in the frame turned by `rot` about the point (a, v) (its centre offset (da, dv) from there turned with it) */
  const turned = (kind: Kind, a: number, v: number, rot: number, da: number, dv: number, ha: number, hv: number, y0: number, y1: number, skip: Face[] = ['bottom'], more: Partial<FurnBox> = {}) => {
    const [cx, , cz] = p.pt(a, v, 0), [ox, , oz] = p.pt(a + da, v + dv, 0), dx = ox - cx, dz = oz - cz;
    const c = Math.cos(rot), s = Math.sin(rot), nx = cx + dx * c - dz * s, nz = cz + dx * s + dz * c;
    const q = box(-ha, ha, -hv, hv, y0, y1), hx = (q.x1 - q.x0) / 2, hz = (q.z1 - q.z0) / 2;
    put(kind, { x0: nx - hx, x1: nx + hx, z0: nz - hz, z1: nz + hz, y0, y1 }, rot ? { rot, skip, ...more } : { skip, ...more });
  };
  const pick = <T,>(xs: T[]) => xs[Math.floor(rng.next() * xs.length) % xs.length];
  // the 校长室 / 会议室 / 档案室 / 复印室 have no 拼桌; the 处室 and the 财务室 keep it with 铁皮柜 in place of the wooden 档案柜
  const cls = officeClass(r), special = cls === 'head' || cls === 'meeting' || cls === 'archive' || cls === 'print';
  const steel = cls === 'admin' || cls === 'finance';

  // ── the island: two rows of 办公桌 back to back across the room, the chair side of each row facing out
  const top = y + D.h;
  if (p.n > 0 && !special) for (const s of [-1, 1]) for (let k = 0; k < p.n; k++) {
    const v0 = p.i0 + k * D.w + 0.005, v1 = v0 + D.w - 0.01, a0 = s < 0 ? ac - D.d : ac, a1 = s < 0 ? ac : ac + D.d;
    const inner = s < 0 ? F : B, edge = s < 0 ? a0 : a1;
    put('desk', box(a0, a1, v0, v1, top - D.top, top), { skip: ['bottom', inner] });
    // 抽屉 pedestal at one end (alternating along the row), a leg panel at the other
    const pr = (k + (s > 0 ? 1 : 0)) % 2 === 0, pv0 = pr ? v1 - D.ped : v0, pv1 = pr ? v1 : v0 + D.ped;
    put('desk', box(a0 + 0.02, a1 - 0.02, pv0, pv1, y, top - D.top), { skip: ['bottom', 'top', inner] });
    // the 抽屉 fronts' seams (a dark line just proud of the pedestal face)
    const pf = edge - s * 0.02;
    for (const dy of [0.17, 0.36]) put('ink', box(pf, pf + s * 0.004, pv0 + 0.02, pv1 - 0.02, top - D.top - dy - 0.01, top - D.top - dy), { skip: ['bottom', 'top', inner, Rt, Lf] });
    const lv = pr ? v0 + 0.02 : v1 - 0.02 - D.panel;
    put('desk', box(a0 + 0.04, a1 - 0.04, lv, lv + D.panel, y, top - D.top), { skip: ['bottom', 'top', inner] });
    // the chair: pulled out its own way, turned a little (whoever sat there last)
    const ca = edge + s * (C.out + rng.range(0, C.jitter) + C.d / 2), cv = (v0 + v1) / 2 + rng.range(-0.15, 0.15), rot = rng.range(-0.3, 0.3);
    const cw = C.w / 2, cd = C.d / 2;
    turned('chair', ca, cv, rot, 0, 0, cd, cw, y + C.seat - 0.04, y + C.seat, ['bottom']);
    turned('chair', ca, cv, rot, s * (C.d / 2 - 0.015), 0, 0.015, cw, y + C.seat, y + C.back, ['bottom']);
    // its two steel side frames (front + back legs as one plate: edge-on in the ink they read as the legs)
    for (const e of [-1, 1]) turned('steel', ca, cv, rot, 0, e * (cw - 0.03), cd - 0.03, 0.012, y, y + C.seat - 0.04, ['bottom', 'top']);
    solid.push(box(ca - cd - 0.05, ca + cd + 0.05, cv - cw - 0.05, cv + cw + 0.05, y, y + C.back));
    deskTop(s, a0, a1, v0, v1, k);
    if (steel && k === 0) crt(s, v0);
  }
  if (p.n > 0 && !special) solid.push(box(ac - D.d, ac + D.d, p.i0, p.i1, y, top));

  /** 作业本 / 教案 / 茶杯 / 台灯 / 笔筒 / 饭盒 on one desk: the piles on the far half, the rest by the chair */
  function deskTop(s: number, a0: number, a1: number, v0: number, v1: number, k: number) {
    const far = s < 0 ? a0 + 0.17 : a1 - 0.17, near = s < 0 ? a0 + 0.42 : a1 - 0.42;
    const stacks = dressed ? 1 + Math.floor(rng.next() * 3) : rng.next() < 0.5 ? 1 : 0;
    for (let i = 0; i < stacks; i++) {
      // a pile of 作业本 in a few handed-in batches, each squared up a little differently: the ink draws every step
      let h = top;
      const sv = v0 + 0.2 + i * 0.3 + rng.range(-0.03, 0.03), layers = dressed ? 2 + Math.floor(rng.next() * 3) : 1 + Math.floor(rng.next() * 2);
      for (let l = 0; l < layers; l++) {
        const t = rng.range(0.02, 0.05), kind: Kind = l % 2 ? pick(['cover', 'coverR', 'coverG'] as Kind[]) : 'paper';
        turned(kind, far + rng.range(-0.012, 0.012), sv + rng.range(-0.012, 0.012), rng.range(-0.12, 0.12), 0, 0, 0.09, 0.13, h, h + t, ['bottom'], { pile: true });
        h += t;
      }
    }
    if (dressed && rng.next() < 0.7) turned('paper', near, v0 + 0.35 + rng.range(0, 0.25), rng.range(-0.25, 0.25), 0, 0, 0.1, 0.15, top, top + 0.012); // 教案, open
    const cv = v1 - 0.12 - rng.range(0, 0.12);
    if (rng.next() < (dressed ? 0.75 : 0.4)) turned('cup', near - s * 0.1, cv, Math.PI / 4, 0, 0, 0.038, 0.038, top, top + 0.11);
    if (dressed && rng.next() < 0.4) {
      // 台灯: base, stem, the shade over the work
      const la = far, lv = v1 - 0.12;
      turned('shade', la, lv, 0, 0, 0, 0.07, 0.07, top, top + 0.03);
      turned('steel', la, lv, 0, 0, 0, 0.01, 0.01, top + 0.03, top + 0.4, ['bottom', 'top']);
      turned('shade', la - s * 0.08, lv, 0, 0, 0, 0.12, 0.07, top + 0.34, top + 0.42, ['top']);
    }
    if (dressed && rng.next() < 0.5) { // 笔筒, a red pen in it
      const pa = far, pv = v1 - 0.33;
      turned('ink', pa, pv, 0.3, 0, 0, 0.04, 0.04, top, top + 0.11);
      turned('coverR', pa, pv, 0.3, 0.01, 0, 0.006, 0.006, top + 0.11, top + 0.17, ['bottom']);
    }
    if (dressed && k % 3 === 1 && rng.next() < 0.6) turned('steel', near - s * 0.06, v0 + 0.25, rng.range(-0.2, 0.2), 0, 0, 0.07, 0.1, top, top + 0.07); // 饭盒
  }

  // ── 档案柜 on the side wall farther from the door: closed steel doors below, open shelves of 档案盒 above
  const K = O.cabinet;
  if (p.cs !== 0 && !special && !steel) {
    const units = dressed ? K.units.dressed : K.units.plain, wall = p.cs < 0 ? p.wl : p.wr, face = wall - p.cs * K.d;
    const side = p.cs < 0 ? Lf : Rt;
    const a1 = Math.min(p.fa - 0.35, (units * K.w) / 2), a0 = a1 - units * K.w;
    for (let u = 0; u < units; u++) {
      const ua0 = a0 + u * K.w, ua1 = ua0 + K.w - K.gap;
      const [v0, v1] = [wall, face].sort((q, s) => q - s);
      // the doors' handles by their seam
      const hv = face - p.cs * 0.012, [hv0, hv1] = [face, hv].sort((q, s) => q - s), mid = ua0 + K.w / 2 - K.gap / 2;
      for (const e of [-1, 1]) put('ink', box(mid + e * 0.04 - 0.01, mid + e * 0.04 + 0.01, hv0, hv1, y + K.split - 0.32, y + K.split - 0.2), { skip: ['bottom', side] });
      // lower body (two doors, the seam between them a real gap), the shelf case above, its back and shelves
      for (const h of [0, 1]) put('cabinet', box(ua0 + h * (K.w / 2), ua0 + (h + 1) * (K.w / 2) - K.gap, v0, v1, y, y + K.split), { skip: ['bottom', side] });
      // a plain 办公室's 档案柜 is closed all the way up (a second pair of doors over the first)
      if (!dressed) {
        for (const h of [0, 1]) put('cabinet', box(ua0 + h * (K.w / 2), ua0 + (h + 1) * (K.w / 2) - K.gap, v0, v1, y + K.split + K.gap, y + K.h), { skip: ['bottom', side] });
        continue;
      }
      const sy = y + K.split, st = 0.02;
      for (const e of [ua0, ua1 - st]) put('cabinet', box(e, e + st, v0, v1, sy, y + K.h), { skip: ['bottom', side] });
      put('cabinet', box(ua0, ua1, v0, v1, y + K.h - st, y + K.h), { skip: ['bottom', side] });
      const shelves = 3, sh = (K.h - K.split - st) / shelves;
      for (let i = 0; i < shelves; i++) {
        const by = sy + i * sh;
        if (i) put('cabinet', box(ua0 + st, ua1 - st, v0, v1, by, by + st), { skip: ['bottom', side] });
        // a row of 档案盒 standing on it, spines out, a few leaning or taken out (gaps)
        let a = ua0 + st + 0.01;
        while (a < ua1 - st - 0.08) {
          const w = rng.range(0.06, 0.1), hh = sh - rng.range(0.05, 0.12);
          if (rng.next() < 0.88) {
            const kind: Kind = rng.next() < 0.75 ? 'file' : pick(['cover', 'coverR', 'paper'] as Kind[]);
            const [bv0, bv1] = [wall - p.cs * 0.03, face + p.cs * 0.03].sort((q, s) => q - s);
            // a 档案盒's spine (the face out of the shelf): its 标签 and 指孔 painted by the interior shader (seed off the
            // layout, not the rng: the rest of the room stays as it was)
            const spine = kind === 'file' ? { label: p.cs < 0 ? Rt : Lf, labelSeed: (Math.floor(a * 97) + i * 5) & 15 } : {};
            put(kind, box(a, a + w - 0.004, bv0, bv1, by + (i ? st : 0), by + (i ? st : 0) + hh), { skip: ['bottom', side], ...spine });
          }
          a += w;
        }
      }
    }
    solid.push(box(a0, a1, ...([wall, face].sort((q, s) => q - s) as [number, number]), y, y + K.h));
    // two 暖壶 on the floor at the 档案柜's window end, and (语文组) a 饭盒 stack on top of it
    const ta = a1 + 0.18;
    if (ta < p.fa - 0.1) for (let i = 0; i < (dressed ? 2 : 1); i++) {
      const tv = face + p.cs * (0.12 + i * 0.2);
      turned(i ? 'thermos' : 'coverG', ta, tv, Math.PI / 4, 0, 0, 0.065, 0.065, y, y + 0.36);
      turned('cup', ta, tv, Math.PI / 4, 0, 0, 0.045, 0.045, y + 0.36, y + 0.42);
    }
    if (dressed) for (let i = 0; i < 2; i++) turned('steel', a0 + 0.3, (wall + face) / 2, rng.range(-0.2, 0.2), 0, 0, 0.1, 0.07, y + K.h + i * 0.07, y + K.h + (i + 1) * 0.07);
  }

  // ── 窗台 under each window of the window wall (语文组: a 绿萝 on one)
  const S = O.sill, wins = windowSpans(b, r, p, y);
  wins.forEach((w, i) => {
    const sy = w.y0;
    put('sill', box(p.fa - S.d, p.fa, w.v0 - S.over, w.v1 + S.over, sy - S.t, sy), { skip: [F] });
    if (dressed && i === wins.length - 1) {
      const pa = p.fa - 0.09, pv = (w.v0 + w.v1) / 2 + 0.3;
      turned('pot', pa, pv, 0, 0, 0, 0.07, 0.08, sy, sy + 0.13);
      // a mound of leaves
      for (const [da, dv, rot, ha, hv, y0, y1] of [[0, 0, 0.4, 0.12, 0.15, 0.12, 0.2], [0.02, -0.08, 1.1, 0.09, 0.1, 0.17, 0.25], [-0.02, 0.09, 0.2, 0.08, 0.09, 0.19, 0.29]])
        turned('leaf', pa + da, pv + dv, rot, 0, 0, ha, hv, sy + y0, sy + y1, []);
      // a few leaves spilling over the sill's front edge (vines would read as legs at this size)
      for (const [dv, dy] of [[-0.12, 0.06], [0.1, 0.02]]) turned('leaf', p.fa - S.d + 0.02, pv + dv, 0.6, 0, 0, 0.05, 0.07, sy - dy - 0.05, sy + 0.08, []);
    }
  });

  // ── papers on the back (corridor) wall, in the longer stretch beside the door: 课表, 值日表, (语文组) 挂历
  const Sh = O.sheet, wa = -p.L + 0.006, dv0 = p.dv - 0.65, dv1 = p.dv + 0.65;
  const [s0, s1] = dv0 - p.wl > p.wr - dv1 ? [p.wl + 0.4, dv0] : [dv1, p.wr - 0.4];
  const list = (dressed ? ['timetable', 'duty', 'calendar'] : ['timetable']) as (keyof typeof Sh)[];
  const total = list.reduce((t, k) => t + Sh[k][0] + 0.25, -0.25);
  if (total < s1 - s0 && cls !== 'head') {
    let v = (s0 + s1) / 2 - total / 2;
    for (const k of list) {
      const [w, h, cy] = Sh[k], q = box(-p.L, wa, v, v + w, y + cy - h / 2, y + cy + h / 2);
      put('paper', q, { skip: [B, 'bottom'] });
      // its ruled grid / header: thin dark strips just proud of the sheet
      const lines = k === 'timetable' ? 5 : k === 'duty' ? 6 : 1;
      for (let l = 1; l <= lines; l++) {
        const ly = y + cy + h / 2 - (k === 'calendar' ? 0.12 : (l * h) / (lines + 1));
        put('ink', box(wa, wa + 0.002, v + 0.03, v + w - 0.03, ly - 0.006, ly), { skip: [B, 'bottom', 'top', Rt, Lf] });
      }
      if (k === 'calendar') put('coverR', box(wa, wa + 0.002, v + 0.03, v + w - 0.03, y + cy + h / 2 - 0.1, y + cy + h / 2 - 0.03), { skip: [B, 'bottom', 'top', Rt, Lf] });
      v += w + 0.25;
    }
  }

  /** a box from two unsorted spans of the frame (a, v) */
  function bx(kind: Kind, a0: number, a1: number, v0: number, v1: number, y0: number, y1: number, skip: Face[] = ['bottom'], more: Partial<FurnBox> = {}) {
    put(kind, box(Math.min(a0, a1), Math.max(a0, a1), Math.min(v0, v1), Math.max(v0, v1), y + y0, y + y1), { skip, ...more });
  }
  /** the side wall away from the door (-1 = the left wall) and its face; the door's side wall */
  const sv = p.dv > 0 ? -1 : 1, wallS = sv < 0 ? p.wl : p.wr, wallD = sv < 0 ? p.wr : p.wl, faceS = sv < 0 ? Lf : Rt, faceD = sv < 0 ? Rt : Lf;
  const H = O.head;

  /**
   * A 皮沙发 (lc: its middle along its length, len, along a or v), its back against `back` with the seat toward `dir`
   * (±1 on the other axis): a low base, a seat cushion per place, a high back, two fat arms, a white 蕾丝 巾 over the
   * back of each place (the 校长室 look of the 2000s).
   */
  function sofa(lc: number, len: number, axis: 'a' | 'v', back: number, dir: number) {
    const S = H.sofa, l0 = lc - len / 2, l1 = lc + len / 2, d = (t: number) => back + dir * t;
    const M = (kind: Kind, p0: number, p1: number, q0: number, q1: number, y0: number, y1: number, skip: Face[] = ['bottom']) =>
      axis === 'a' ? bx(kind, p0, p1, q0, q1, y0, y1, skip) : bx(kind, q0, q1, p0, p1, y0, y1, skip);
    M('leather', l0 + S.arm, l1 - S.arm, d(S.back), d(S.d - 0.02), S.foot, S.seat - 0.06);
    const places = Math.max(1, Math.round((len - 2 * S.arm) / 0.62)), pw = (len - 2 * S.arm) / places;
    for (let i = 0; i < places; i++) {
      const c0 = l0 + S.arm + i * pw + 0.008, c1 = c0 + pw - 0.016;
      M('leather', c0, c1, d(S.back), d(S.d), S.seat - 0.06, S.seat);
      // the 蕾丝 巾 over this place's back: a strip on top and its fall down the front
      const m = (c0 + c1) / 2;
      M('lace', m - 0.2, m + 0.2, d(-0.01), d(S.back + 0.01), S.high, S.high + 0.01);
      M('lace', m - 0.2, m + 0.2, d(S.back + 0.004), d(S.back + 0.012), S.high - 0.22, S.high);
    }
    M('leather', l0 + S.arm, l1 - S.arm, d(0), d(S.back), S.foot, S.high);
    for (const [e0, e1] of [[l0, l0 + S.arm], [l1 - S.arm, l1]]) M('leather', e0, e1, d(0), d(S.d), S.foot, S.armH);
    // short dark feet under the corners
    for (const e of [l0 + 0.05, l1 - 0.09]) for (const t of [0.05, S.d - 0.09]) M('ink', e, e + 0.04, d(t), d(t + 0.04), 0, S.foot, ['bottom', 'top']);
    const q = axis === 'a' ? box(l0, l1, Math.min(back, d(S.d)), Math.max(back, d(S.d)), y, y + S.high) : box(Math.min(back, d(S.d)), Math.max(back, d(S.d)), l0, l1, y, y + S.high);
    solid.push(q);
  }

  /** a 茶几: a glass top on a wood apron and four legs, 茶杯 on it (a, v its middle; ha / hv half sizes) */
  function teaTable(a: number, v: number, ha: number, hv: number, cups: number) {
    const T = H.tea;
    bx('glassTop', a - ha, a + ha, v - hv, v + hv, T.h - 0.012, T.h);
    bx('desk', a - ha + 0.03, a + ha - 0.03, v - hv + 0.03, v + hv - 0.03, T.h - 0.1, T.h - 0.012);
    for (const ea of [-1, 1]) for (const ev of [-1, 1]) bx('desk', a + ea * (ha - 0.05) - 0.025, a + ea * (ha - 0.05) + 0.025, v + ev * (hv - 0.05) - 0.025, v + ev * (hv - 0.05) + 0.025, 0, T.h - 0.1, ['bottom', 'top']);
    for (let i = 0; i < cups; i++) turned('cup', a + rng.range(-ha + 0.12, ha - 0.12), v + rng.range(-hv + 0.1, hv - 0.1), Math.PI / 4, 0, 0, 0.035, 0.035, y + T.h, y + T.h + 0.1);
    solid.push(box(a - ha, a + ha, v - hv, v + hv, y, y + T.h));
  }

  /** 锦旗 hung in a row on the side wall away from the door, centred at a = ac0: red cloth, a gold 题字 column each side of a big one, a fringe, the rod */
  function pennants(ac0: number, n: number) {
    const P = H.pennant;
    // a 校长室 at the end of the building has a window in that side wall: then they go on the widest blank stretch
    // of the window wall (behind the 大班台) instead
    const sideWin = facadeOpenings(b).some(o => o.kind === 'window' && o.side === (sv < 0 ? dir('l') : dir('r')) && o.y0 >= y && o.y0 < y + 3);
    let onFront = false, vc0 = 0;
    if (sideWin) {
      const ws = windowSpans(b, r, p, y).sort((q, s) => q.v0 - s.v0), edges = [p.wl + 0.2, ...ws.flatMap(w => [w.v0 - 0.15, w.v1 + 0.15]), p.wr - 0.2];
      let best = 0;
      for (let i = 0; i < edges.length; i += 2) if (edges[i + 1] - edges[i] > best) { best = edges[i + 1] - edges[i]; vc0 = (edges[i] + edges[i + 1]) / 2; }
      while (n > 1 && n * (P.w + P.gap) > best) n--;
      onFront = n * (P.w + P.gap) <= best;
    }
    const W = (kind: Kind, c0: number, c1: number, t0: number, t1: number, y0: number, y1: number, skip: Face[]) => onFront
      ? bx(kind, p.fa - t0, p.fa - t1, vc0 + c0, vc0 + c1, y0, y1, skip.map(f => (f === faceS ? F : f)))
      : bx(kind, ac0 + c0, ac0 + c1, wallS - sv * t0, wallS - sv * t1, y0, y1, skip);
    for (let i = 0; i < n; i++) {
      const c = (i - (n - 1) / 2) * (P.w + P.gap), top = P.top - (i % 2) * 0.04, bot = top - P.h;
      W('pennant', c - P.w / 2, c + P.w / 2, 0, 0.012, bot, top, ['bottom', faceS]);
      W('pennantGold', c - P.w / 2 - 0.04, c + P.w / 2 + 0.04, 0, 0.016, top, top + 0.025, ['bottom', faceS]);
      W('pennantGold', c - P.w / 2, c + P.w / 2, 0, 0.016, bot - 0.06, bot, ['top', faceS]);
      // the 题字: a column of big characters down the middle, the small 赠 lines either side
      for (let k = 0; k < 4; k++) W('pennantGold', c - 0.07, c + 0.07, 0.012, 0.016, top - 0.18 - k * 0.15, top - 0.06 - k * 0.15, ['bottom', 'top', faceS]);
      for (const e of [-1, 1]) W('pennantGold', c + e * 0.17 - 0.015, c + e * 0.17 + 0.015, 0.012, 0.016, bot + 0.12, top - 0.1 - (e > 0 ? 0 : 0.25), ['bottom', 'top', faceS]);
    }
  }

  /** a 书柜 against the door's side wall, a ∈ [a0, a0 + units × w]: closed doors below, open shelves of books above */
  function bookcase(a0: number, units: number, trophies: boolean) {
    const K = H.case, face = wallD + sv * K.d, [v0, v1] = [wallD, face].sort((q, s) => q - s), st = 0.02;
    for (let u = 0; u < units; u++) {
      const ua0 = a0 + u * K.w, ua1 = ua0 + K.w - 0.012;
      for (const h of [0, 1]) bx('cabinet', ua0 + h * (K.w / 2), ua0 + (h + 1) * (K.w / 2) - 0.012, v0, v1, 0, K.split, ['bottom', faceD]);
      for (const e of [ua0, ua1 - st]) bx('cabinet', e, e + st, v0, v1, K.split, K.h, ['bottom', faceD]);
      bx('cabinet', ua0, ua1, v0, v1, K.h - st, K.h, ['bottom', faceD]);
      bx('shelfBack', ua0 + st, ua1 - st, wallD, wallD + sv * 0.01, K.split, K.h - st, ['bottom', faceD]);
      const sh = (K.h - K.split - st) / 3;
      for (let i = 0; i < 3; i++) {
        const by = K.split + i * sh;
        if (i) bx('cabinet', ua0 + st, ua1 - st, v0, v1, by, by + st, ['bottom', faceD]);
        if (trophies && i === 1) { // a 奖杯 and a 奖状 frame on the middle shelf
          const m = (ua0 + ua1) / 2;
          bx('pennantGold', m - 0.2, m - 0.1, wallD + sv * 0.12, wallD + sv * 0.22, by + st, by + st + 0.22);
          bx('frame', m + 0.02, m + 0.3, wallD + sv * 0.03, wallD + sv * 0.05, by + st, by + st + 0.24, ['bottom', faceD]);
          continue;
        }
        let a = ua0 + st + 0.01;
        while (a < ua1 - st - 0.06) {
          const w = rng.range(0.05, 0.1);
          if (rng.next() < 0.9) bx(pick(['bookR', 'bookB', 'bookG', 'bookY', 'bookW', 'bookR'] as Kind[]), a, a + w - 0.003, wallD + sv * 0.04, face - sv * 0.03, by + (i ? st : 0), by + (i ? st : 0) + sh - rng.range(0.06, 0.12), ['bottom', faceD]);
          a += w;
        }
      }
    }
    solid.push(box(a0, a0 + units * K.w, v0, v1, y, y + K.h));
  }

  /** a 发财树 in a pot (a, v): pot, trunk, three mounds of leaves */
  function moneyTree(a: number, v: number) {
    bx('pot', a - 0.16, a + 0.16, v - 0.16, v + 0.16, 0, 0.32);
    bx('frame', a - 0.03, a + 0.03, v - 0.03, v + 0.03, 0.32, 1.1, ['bottom', 'top']);
    // five 掌状 clumps of leaves fanning out at different heights (one dark mound read as a 台灯 shade)
    for (let i = 0; i < 5; i++) {
      const t = (i / 5) * Math.PI * 2 + 0.4, rr = i % 2 ? 0.2 : 0.14, y0 = 0.85 + (i % 3) * 0.14;
      turned('leafHi', a + Math.cos(t) * rr, v + Math.sin(t) * rr, t, 0, 0, 0.17, 0.08, y + y0, y + y0 + 0.07, []);
      turned('leaf', a + Math.cos(t) * rr * 0.6, v + Math.sin(t) * rr * 0.6, t + 0.6, 0, 0, 0.12, 0.07, y + y0 + 0.06, y + y0 + 0.14, []);
    }
    solid.push(box(a - 0.18, a + 0.18, v - 0.18, v + 0.18, y, y + 1.4));
  }

  /** an office chair at (a, v), its back toward `s` (±1 along a, or `ev` ±1 along v with s = 0): seat, back, steel side frames */
  function seatAt(ca: number, cv: number, rot: number, s: number, ev = 0, kind: Kind = 'chair') {
    const cw = C.w / 2, cd = C.d / 2, alongV = s === 0, ha = alongV ? cw : cd, hv = alongV ? cd : cw;
    turned(kind, ca, cv, rot, 0, 0, ha, hv, y + C.seat - 0.04, y + C.seat, ['bottom']);
    if (alongV) turned(kind, ca, cv, rot, 0, ev * (cd - 0.015), cw, 0.015, y + C.seat, y + C.back, ['bottom']);
    else turned(kind, ca, cv, rot, s * (cd - 0.015), 0, 0.015, cw, y + C.seat, y + C.back, ['bottom']);
    for (const e of [-1, 1]) {
      if (alongV) turned('steel', ca, cv, rot, e * (cw - 0.03), 0, 0.012, cd - 0.03, y, y + C.seat - 0.04, ['bottom', 'top']);
      else turned('steel', ca, cv, rot, 0, e * (cw - 0.03), cd - 0.03, 0.012, y, y + C.seat - 0.04, ['bottom', 'top']);
    }
    solid.push(box(ca - ha - 0.05, ca + ha + 0.05, cv - hv - 0.05, cv + hv + 0.05, y, y + C.back));
  }

  /**
   * 校长室 / 副校长室 / 接待室: a 大班台 by the window with the 老板椅 behind it (its back to the window, facing the
   * door), a 皮沙发 on the side wall away from the door with a glass 茶几 before it and 锦旗 over it, a 书柜 on the door's
   * side wall, a 发财树 in the window corner. The 接待室 has no desk: two 单人沙发 face the long one across the 茶几, and
   * the 书柜 is a 荣誉柜 (a 奖杯, a 奖状).
   */
  function headSet() {
    const reception = r.name.endsWith('接待室'), Sf = H.sofa, wide = p.wr - p.wl;
    const sofaLen = Math.min(2.0, p.L * 2 - 1.3), sofaA = -p.L + 0.95 + sofaLen / 2 - 0.3;
    sofa(sofaA, sofaLen, 'a', wallS, -sv);
    const tv = wallS - sv * (Sf.d + 0.45);
    teaTable(sofaA, tv, Math.min(0.55, sofaLen / 2 - 0.2), 0.28, reception ? 3 : 2);
    if (reception) for (const e of [-0.55, 0.55]) sofa(sofaA + e, 0.95, 'a', tv - sv * (0.28 + 0.2 + Sf.d), sv);
    pennants(sofaA, reception ? 4 : wide > 4.5 ? 3 : 2);
    bookcase(Math.max(-p.L + 1.6, p.fa - 0.5 - 2 * H.case.w - (reception ? 0 : 0.9)), 2, reception);
    moneyTree(p.fa - 0.35, wallS - sv * 0.35);
    if (reception) return;
    // the 大班台: a deep top on two pedestals and a modesty panel, the 老板椅 behind it
    const K = H.desk, vc = -sv * Math.min(0.45, wide / 2 - K.w / 2 - 0.55), a0 = p.fa - 1.35 - K.d, a1 = a0 + K.d;
    bx('desk', a0, a1, vc - K.w / 2, vc + K.w / 2, K.h - 0.04, K.h);
    for (const e of [-1, 1]) bx('desk', a0 + 0.03, a1 - 0.03, vc + e * (K.w / 2 - 0.22) - 0.2, vc + e * (K.w / 2 - 0.22) + 0.2, 0, K.h - 0.04, ['bottom', 'top']);
    bx('desk', a0 + 0.08, a0 + 0.11, vc - K.w / 2 + 0.43, vc + K.w / 2 - 0.43, 0.12, K.h - 0.04, ['bottom', 'top']);
    for (const e of [-1, 1]) for (const dy of [0.2, 0.42]) bx('ink', a1 + 0.002, a1 - 0.004, vc + e * (K.w / 2 - 0.22) - 0.18, vc + e * (K.w / 2 - 0.22) + 0.18, K.h - 0.04 - dy - 0.008, K.h - 0.04 - dy, ['bottom', 'top']);
    solid.push(box(a0, a1, vc - K.w / 2, vc + K.w / 2, y, y + K.h));
    // on the desk: a 台签-less top, a black 电话, a 茶杯, a pile of 文件, a pen set
    const t = K.h;
    turned('phone', a0 + 0.2, vc + sv * 0.6, 0.2, 0, 0, 0.1, 0.12, y + t, y + t + 0.07);
    turned('cup', a1 - 0.2, vc - sv * 0.55, Math.PI / 4, 0, 0, 0.04, 0.04, y + t, y + t + 0.12);
    let h = y + t;
    for (let l = 0; l < 3; l++) { const th = rng.range(0.015, 0.03); turned(l % 2 ? 'cover' : 'paper', a0 + 0.25, vc - sv * 0.2, rng.range(-0.1, 0.1), 0, 0, 0.11, 0.16, h, h + th, ['bottom'], { pile: true }); h += th; }
    turned('paper', a1 - 0.25, vc + sv * 0.05, rng.range(-0.2, 0.2), 0, 0, 0.12, 0.17, y + t, y + t + 0.01);
    bx('ink', a1 - 0.18, a1 - 0.08, vc + sv * 0.35 - 0.1, vc + sv * 0.35 + 0.1, t, t + 0.04);
    // the 老板椅: a high leather back, arms, on a 五星脚 (a dark disc of a base here)
    const ca = a1 + 0.48, cv = vc + rng.range(-0.15, 0.15), rot = rng.range(-0.25, 0.25), L2 = H.boss;
    turned('ink', ca, cv, rot, 0, 0, 0.3, 0.3, y, y + 0.05);
    turned('steel', ca, cv, rot, 0, 0, 0.03, 0.03, y + 0.05, y + L2.seat - 0.08, ['bottom', 'top']);
    turned('leather', ca, cv, rot, 0, 0, 0.28, 0.3, y + L2.seat - 0.08, y + L2.seat);
    turned('leather', ca, cv, rot, 0.25, 0, 0.06, 0.28, y + L2.seat, y + L2.back);
    for (const e of [-1, 1]) turned('leather', ca, cv, rot, -0.02, e * 0.27, 0.2, 0.04, y + L2.seat, y + L2.seat + 0.22);
    solid.push(box(ca - 0.35, ca + 0.35, cv - 0.35, cv + 0.35, y, y + L2.back));
  }

  /**
   * 会议室 / 教研活动室: one long table down the room's length (pushed-together 会议桌, a green 台布 on the 会议室's),
   * chairs a pitch apart down both sides and one at each end, a 茶杯 at most places, 暖壶 on the table, and a red 横幅
   * (pale 字 squares) on the side wall away from the door. 教研活动室 is plainer: bare wood, fewer cups.
   */
  function meetingSet() {
    const M = H.meeting, full = r.name.endsWith('会议室');
    const v0 = p.wl + M.end, v1 = p.wr - M.end, ha = M.w / 2, tt = M.h;
    bx(full ? 'tableCloth' : 'desk', -ha, ha, v0, v1, tt - 0.03, tt);
    if (full) bx('tableCloth', -ha - 0.005, ha + 0.005, v0 - 0.005, v1 + 0.005, tt - 0.22, tt - 0.03, ['bottom', 'top']);
    else for (const e of [v0 + 0.05, v1 - 0.09]) for (const s of [-1, 1]) bx('desk', s * (ha - 0.05) - 0.02, s * (ha - 0.05) + 0.02, e, e + 0.04, 0, tt - 0.03, ['bottom', 'top']);
    // the seams where the tables meet
    const units = Math.max(1, Math.round((v1 - v0) / 1.6));
    for (let i = 1; i < units; i++) { const sv0 = v0 + (i * (v1 - v0)) / units; bx('ink', -ha, ha, sv0 - 0.004, sv0 + 0.004, tt, tt + 0.002, ['bottom']); }
    solid.push(box(-ha, ha, v0, v1, y, y + tt));
    const n = Math.floor((v1 - v0 - 0.2) / M.pitch), first = (v0 + v1) / 2 - ((n - 1) * M.pitch) / 2;
    for (const s of [-1, 1]) for (let k = 0; k < n; k++) {
      const cv = first + k * M.pitch + rng.range(-0.06, 0.06), ca = s * (ha + 0.1 + C.d / 2 + rng.range(0, 0.1));
      seatAt(ca, cv, rng.range(-0.15, 0.15), s);
      if (rng.next() < (full ? 0.8 : 0.5)) turned('cup', s * (ha - 0.15), cv + 0.12, Math.PI / 4, 0, 0, 0.035, 0.035, y + tt, y + tt + 0.1);
      if (rng.next() < 0.35) turned('paper', s * (ha - 0.2), cv - 0.08, rng.range(-0.3, 0.3), 0, 0, 0.11, 0.15, y + tt, y + tt + 0.01);
    }
    // one at each end of the table (the ends face the side walls)
    for (const e of [-1, 1]) seatAt(0, e < 0 ? v0 - 0.1 - C.d / 2 : v1 + 0.1 + C.d / 2, 0, 0, e);
    for (const fv of [0.3, 0.7]) {
      const tv = v0 + fv * (v1 - v0), kind: Kind = fv < 0.5 ? 'thermos' : 'thermosR';
      turned(kind, 0, tv, Math.PI / 4, 0, 0, 0.065, 0.065, y + tt, y + tt + 0.36);
      turned('cup', 0, tv, Math.PI / 4, 0, 0, 0.045, 0.045, y + tt + 0.36, y + tt + 0.42);
    }
    // the 横幅 over the table's far end, on the side wall away from the door: red cloth, a row of pale 字
    const bw = Math.min(M.banner, p.L * 2 - 1.2), bv = wallS - sv * 0.012, gv = wallS - sv * 0.016, by0 = 2.05, by1 = by0 + 0.5;
    bx('banner', -bw / 2, bw / 2, wallS, bv, by0, by1, ['bottom', faceS]);
    const chars = Math.floor((bw - 0.3) / 0.36);
    // each 字 a few strokes (a bar across, two down), not a solid tile: solid pale squares read as holes in the cloth
    for (let i = 0; i < chars; i++) {
      const c = -bw / 2 + 0.15 + 0.18 + i * ((bw - 0.66) / Math.max(1, chars - 1)), m = by0 + 0.25;
      bx('pennantGold', c - 0.12, c + 0.12, bv, gv, m + 0.04 - (i % 2) * 0.1, m + 0.07 - (i % 2) * 0.1, ['bottom', 'top', faceS]);
      for (const e of [-0.06, 0.05 + (i % 3) * 0.02]) bx('pennantGold', c + e - 0.016, c + e + 0.016, bv, gv, m - 0.15, m + 0.15, ['bottom', 'top', faceS]);
    }
  }

  /** this storey's windows in the left / right side wall (an end room's outer wall) as along spans [a0, a1], a margin each end */
  function sideWins(s: 'l' | 'r'): [number, number][] {
    // an inner 隔墙 has no windows (the facade's openings on that side belong to the end room)
    if (Math.abs(s === 'l' ? p.wl : p.wr) < p.W + 0.01) return [];
    const c = p.front[1] === 'z' ? r.z : r.x, f = p.front[1] === 'z' ? p.f[1] : p.f[0];
    return facadeOpenings(b).filter(o => o.kind === 'window' && o.side === dir(s) && o.y0 >= y && o.y0 < y + 3)
      .map(o => { const q = [f * (o.u0 - c), f * (o.u1 - c)].sort((m, n) => m - n); return [q[0] - 0.1, q[1] + 0.1] as [number, number]; })
      .filter(([a0, a1]) => a1 > -p.L && a0 < p.fa);
  }

  const ST = O.steel;
  /**
   * A 铁皮柜 standing along a (a0 to a0 + w) with its back at v = wv, its front toward `ds` (±1 across): the blue-grey
   * body on a dark 踢脚; `drawers` = a five-drawer 文件柜 (1.32 m: seams, a 标签卡 and a pull each), `doors` = the tall
   * 对开门 kind (seam, two handles, a glass upper pair), `low` = a two-drawer one that fits under a window.
   */
  function steelUnit(a0: number, wv: number, ds: number, style: 'drawers' | 'doors' | 'low') {
    const a1 = a0 + ST.w - ST.gap, back = ds > 0 ? Lf : Rt, fv = wv + ds * ST.d, pv = fv + ds * 0.004;
    const h = style === 'low' ? ST.low : style === 'drawers' ? 1.32 : ST.h;
    bx('steelCab', a0, a1, wv, fv, ST.kick, h, ['bottom', back]);
    bx('ink', a0 + 0.015, a1 - 0.015, wv, fv - ds * 0.02, 0, ST.kick, ['bottom', 'top', back]);
    const D2: Face[] = ['bottom', 'top', back];
    if (style === 'doors') {
      const m = (a0 + a1) / 2;
      bx('ink', m - 0.004, m + 0.004, fv, pv, ST.kick + 0.02, h - 0.02, D2);
      for (const e of [-1, 1]) bx('ink', m + e * 0.05 - 0.01, m + e * 0.05 + 0.01, fv, pv + ds * 0.01, 0.95, 1.1, D2);
      // the upper pair glazed: 档案盒 behind it are not modelled, the glass reads darker than the enamel
      for (const e of [-1, 1]) bx('hoodGlass', e < 0 ? a0 + 0.06 : m + 0.03, e < 0 ? m - 0.03 : a1 - 0.06, fv, pv, 1.25, h - 0.08, D2);
      bx('paper', a0 + 0.08, a0 + 0.2, fv, pv + ds * 0.002, 1.12, 1.18, D2);
    } else {
      const n = style === 'low' ? 2 : 4, dh = (h - ST.kick - 0.03) / n;
      for (let i = 0; i < n; i++) {
        const d0 = ST.kick + 0.015 + i * dh, m = (a0 + a1) / 2;
        if (i) bx('ink', a0 + 0.01, a1 - 0.01, fv, pv, d0 - 0.006, d0, D2);
        bx('paper', m - 0.07, m + 0.07, fv, pv + ds * 0.002, d0 + dh - 0.12, d0 + dh - 0.06, D2); // 标签卡
        bx('ink', m - 0.08, m + 0.08, fv, pv + ds * 0.012, d0 + dh - 0.2, d0 + dh - 0.17, D2); // the pull
      }
    }
    solid.push(box(a0, a1, ...([wv, fv].sort((q, s) => q - s) as [number, number]), y, y + h));
    return h;
  }
  /** a row of 铁皮柜 along a from a0 (n units) against v = wv, facing ds; a unit under a side window goes low */
  function steelRow(a0: number, n: number, wv: number, ds: number, styleOf: (u: number) => 'drawers' | 'doors', wins: [number, number][] = []) {
    const tops: [number, number][] = [];
    for (let u = 0; u < n; u++) {
      const ua = a0 + u * ST.w, low = wins.some(([w0, w1]) => ua < w1 && ua + ST.w > w0);
      tops.push([ua, steelUnit(ua, wv, ds, low ? 'low' : styleOf(u))]);
    }
    return tops;
  }
  /** 纸箱 / 档案盒 piled on a cabinet top at (a, v), h its top */
  function cartons(a: number, v: number, h: number, n: number) {
    let t = h;
    for (let i = 0; i < n; i++) {
      const th = rng.range(0.22, 0.3);
      turned(i % 2 ? 'boxB' : 'box', a + rng.range(-0.04, 0.04), v + rng.range(-0.03, 0.03), rng.range(-0.15, 0.15), 0, 0, 0.2 - i * 0.03, 0.16 - i * 0.02, y + t, y + t + th);
      t += th;
    }
  }

  /**
   * 处室 (教务处 / 总务处 / 招生办 / 教科室 / 团委 / 工会 / 行政办公室) and the 财务室 keep the plain 拼桌 (a 处室 three
   * desks a row): the side wall away from the door is a row of 铁皮柜 instead (five-drawer and 对开门 mixed, low under a
   * side window, 纸箱 on some), a beige 显像管 电脑 on the first desk of each row. 教务处 hangs the 总课表 (a big ruled
   * sheet) on the back wall.
   */
  function adminSet() {
    // the 财务室's 保险柜 takes the window end of that wall
    const units = Math.min(5, Math.floor((p.fa - (cls === 'finance' ? 0.7 : 0.4) + p.L - 0.3) / ST.w)), a0 = -p.L + 0.3;
    const tops = steelRow(a0, units, wallS, -sv, u => (u % 3 === 1 ? 'doors' : 'drawers'), sideWins(sv < 0 ? 'l' : 'r'));
    tops.forEach(([ua, h], u) => { if (h < ST.h && u % 2 === 0) cartons(ua + ST.w / 2, wallS - sv * ST.d / 2, h, 1 + (u % 3)); });
    if (r.name === '教务处') {
      // the 总课表: every class × every period, a grid of thin lines
      const w = 1.6, hh = 1.0, cy = 1.55, wa = -p.L + 0.006, v0 = p.dv > 0 ? p.wl + 0.5 : p.wr - 0.5 - w;
      put('paper', box(-p.L, wa, v0, v0 + w, y + cy - hh / 2, y + cy + hh / 2), { skip: [B, 'bottom'] });
      for (let l = 1; l < 8; l++) put('ink', box(wa, wa + 0.002, v0 + 0.03, v0 + w - 0.03, y + cy + hh / 2 - l * (hh / 8) - 0.004, y + cy + hh / 2 - l * (hh / 8)), { skip: [B, 'bottom', 'top', Rt, Lf] });
      for (let l = 1; l < 7; l++) put('ink', box(wa, wa + 0.002, v0 + l * (w / 7) - 0.003, v0 + l * (w / 7) + 0.003, y + cy - hh / 2 + 0.03, y + cy + hh / 2 - 0.03), { skip: [B, 'bottom', 'top', Rt, Lf] });
    }
  }
  /** a beige 显像管 显示器 + 键盘 on the desk of row s at (v0..v1), its screen toward the chair */
  function crt(s: number, v0: number) {
    const vc = v0 + 0.55, t = top - y;
    bx('switch', s * 0.05, s * 0.41, vc - 0.19, vc + 0.19, t, t + 0.36);
    bx('crt', s * 0.41, s * 0.414, vc - 0.15, vc + 0.15, t + 0.06, t + 0.31, ['bottom', 'top']);
    bx('switch', s * 0.44, s * 0.56, vc - 0.22, vc + 0.22, t, t + 0.025);
  }

  /** a plain worktable across v (v0..v1) at a0..a1: top, two leg panels */
  function table(a0: number, a1: number, v0: number, v1: number, h = 0.76) {
    bx('desk', a0, a1, v0, v1, h - 0.03, h);
    for (const e of [v0 + 0.04, v1 - 0.07]) bx('desk', a0 + 0.04, a1 - 0.04, e, e + 0.03, 0, h - 0.03, ['bottom', 'top']);
    solid.push(box(Math.min(a0, a1), Math.max(a0, a1), Math.min(v0, v1), Math.max(v0, v1), y, y + h));
  }

  /**
   * 档案室 (2F, over the 杂物间; 08 S4.6): the side wall away from the door is a row of tall 对开门 铁皮柜 (low under its
   * window), a back-to-back pair of five-drawer rows down the middle, and on the door's side wall the 角钢铁架 with the
   * 三十本 门卫登记本 on the eye-level deck (three decades' cloth covers in runs, a paper label on each spine, this year's
   * at the door end pulled out a finger's width), 档案盒 and 纸箱 on the others; the 档案员's table under the window.
   */
  function archiveSet() {
    const n = Math.floor((p.fa - 0.4 + p.L - 0.3) / ST.w), a0 = -p.L + 0.3;
    steelRow(a0, n, wallS, -sv, () => 'doors', sideWins(sv < 0 ? 'l' : 'r'));
    // the middle pair, back to back, an 0.8 m aisle each side; it stops short of the window for the 档案员
    const vm = wallS - sv * (2 * ST.d + 0.8), m0 = -p.L + 1.3, mn = Math.max(1, Math.floor((p.fa - 1.4 - m0) / ST.w));
    for (const ds of [-1, 1]) steelRow(m0, mn, vm, ds * sv, () => 'drawers').forEach(([ua, h], u) => { if (u === 1 && ds > 0) cartons(ua + ST.w / 2, vm + sv * ST.d / 2, h, 2); });
    // the 角钢铁架 on the door's side wall, past the door's swing
    const K = O.rack, ra0 = -p.L + 1.2, ra1 = Math.min(m0 + mn * ST.w, ra0 + 1.8), rv = wallD + sv * K.d;
    for (const a of [ra0, (ra0 + ra1) / 2 - K.post / 2, ra1 - K.post]) for (const v of [wallD + sv * 0.01, rv - sv * K.post])
      bx('rackSteel', a, a + K.post, v, v + sv * K.post, 0, K.h, ['bottom']);
    for (const d of K.decks) bx('rackSteel', ra0, ra1, wallD + sv * 0.01, rv, d - 0.02, d, ['bottom']);
    solid.push(box(ra0, ra1, ...([wallD, rv].sort((q, s) => q - s) as [number, number]), y, y + K.h));
    const Lg = K.ledger, eye = K.decks[2];
    let a = ra0 + K.post + 0.02;
    for (let i = 0; i < 30 && a < ra1 - K.post - Lg.t; i++) {
      // 1994~2023: a decade a colour (the 文具店 changed its stock), the newest at the door end, pulled out
      const kind: Kind = i < 10 ? 'bookR' : i < 20 ? 'bookB' : 'bookG', out = i === 0 ? 0.03 : rng.range(0, 0.008);
      const f0 = rv - sv * (0.02 - out), b0 = f0 - sv * Lg.d, hh = Lg.h - (i % 7 === 3 ? 0.02 : 0);
      bx(kind, a, a + Lg.t - 0.003, b0, f0, eye, eye + hh, ['bottom', faceD]);
      bx('paper', a + 0.005, a + Lg.t - 0.008, f0, f0 + sv * 0.002, eye + hh - 0.1, eye + hh - 0.04, ['bottom', 'top', faceD]);
      a += Lg.t;
    }
    // the other decks: 档案盒 standing, a 纸箱 or two
    for (const [d, n2] of [[K.decks[1], 9], [K.decks[3], 7]] as const) {
      let fa2 = ra0 + K.post + 0.02;
      for (let i = 0; i < n2 && fa2 < ra1 - 0.12; i++) { const w = rng.range(0.07, 0.1); bx('file', fa2, fa2 + w - 0.004, wallD + sv * 0.04, rv - sv * 0.03, d, d + 0.3 - rng.range(0, 0.04), ['bottom', faceD]); fa2 += w; }
    }
    for (const c of [0.3, 0.9]) if (ra0 + c + 0.25 < ra1) bx(c < 0.5 ? 'box' : 'boxB', ra0 + c - 0.22, ra0 + c + 0.22, wallD + sv * 0.04, rv - sv * 0.02, K.decks[0], K.decks[0] + 0.32);
    // the 档案员's table under the window, between the door-side wall and the middle pair, a chair, a 台灯, a 登记簿 open
    const tv0 = wallD + sv * 0.35, tv1 = vm - sv * (ST.d + 0.35), ta1 = p.fa - 0.2, ta0 = ta1 - 0.6;
    if (Math.abs(tv1 - tv0) > 0.9) {
      table(ta0, ta1, tv0, tv1);
      const tc = (tv0 + tv1) / 2;
      seatAt(ta0 - 0.3, tc + rng.range(-0.1, 0.1), rng.range(-0.2, 0.2), -1);
      turned('paper', ta0 + 0.3, tc, 0.1, 0, 0, 0.16, 0.22, y + 0.76, y + 0.775);
      bx('shade', ta1 - 0.15, ta1 - 0.05, tv0 + sv * 0.1, tv0 + sv * 0.2, 0.76, 0.79);
      bx('steel', ta1 - 0.11, ta1 - 0.09, tv0 + sv * 0.14, tv0 + sv * 0.16, 0.79, 1.15, ['bottom', 'top']);
      bx('shade', ta1 - 0.26, ta1 - 0.06, tv0 + sv * 0.08, tv0 + sv * 0.22, 1.09, 1.17, ['top']);
    }
  }

  /**
   * 复印室 (2F 西头; S3.6 角色099印题面): the 复印机 against the side wall away from the door (beige body, charcoal lid
   * and base, its control panel, the output tray sticking out), a 速印机 on its stand beside it, 复印纸 cartons stacked
   * in the window corner (one open, reams in it), the worktable under the window with 试卷 piles and the 裁纸刀 (a board,
   * the long steel blade lifted on its hinge, a black grip), a 方凳, and a 铁皮柜 of masters by the door.
   */
  function printSet() {
    const P = O.print, Cp = P.copier, Dp = P.dup, fv = (t: number) => wallS - sv * t;
    // the 复印机, a pace in from the back wall
    const c0 = -p.L + 1.0, c1 = c0 + Cp.w;
    bx('copierTop', c0, c1, fv(0.02), fv(Cp.d), 0, 0.12);
    bx('copier', c0 + 0.01, c1 - 0.01, fv(0.03), fv(Cp.d - 0.01), 0.12, Cp.h - 0.06);
    bx('copierTop', c0, c1, fv(0.03), fv(Cp.d - 0.02), Cp.h - 0.06, Cp.h); // 稿台盖
    bx('ink', c0 + 0.04, c0 + 0.3, fv(Cp.d - 0.1), fv(Cp.d + 0.005), Cp.h - 0.12, Cp.h - 0.07, ['bottom']); // 操作面板
    bx('ledG', c0 + 0.05, c0 + 0.08, fv(Cp.d + 0.005), fv(Cp.d + 0.008), Cp.h - 0.1, Cp.h - 0.09, ['bottom', 'top'], { glow: 'led' });
    for (const dy of [0.32, 0.58]) bx('ink', c0 + 0.03, c1 - 0.03, fv(Cp.d - 0.01), fv(Cp.d - 0.004), dy, dy + 0.008, ['bottom', 'top']); // 纸盒 seams
    bx('copier', c1, c1 + 0.28, fv(0.15), fv(Cp.d - 0.12), 0.78, 0.8); // 出纸托盘
    bx('paper', c1 + 0.02, c1 + 0.26, fv(0.18), fv(Cp.d - 0.15), 0.8, 0.83, ['bottom'], { pile: true });
    solid.push(box(c0, c1 + 0.28, ...([fv(0), fv(Cp.d)].sort((q, s) => q - s) as [number, number]), y, y + Cp.h));
    // the 速印机 on its steel stand
    const d0 = c1 + 0.45, d1 = d0 + Dp.w;
    if (d1 < p.fa - 0.7) {
      for (const e of [d0 + 0.02, d1 - 0.05]) for (const t of [0.05, Dp.d - 0.08]) bx('steel', e, e + 0.03, fv(t), fv(t + 0.03), 0, 0.55, ['bottom', 'top']);
      bx('steel', d0, d1, fv(0.03), fv(Dp.d), 0.53, 0.56);
      bx('copier', d0 + 0.04, d1 - 0.04, fv(0.06), fv(Dp.d - 0.04), 0.56, Dp.h - 0.08);
      bx('copierTop', d0 + 0.08, d1 - 0.08, fv(0.1), fv(Dp.d - 0.1), Dp.h - 0.08, Dp.h);
      bx('paper', d0 + 0.12, d1 - 0.12, fv(Dp.d - 0.04), fv(Dp.d + 0.12), 0.7, 0.72);
      solid.push(box(d0, d1, ...([fv(0), fv(Dp.d)].sort((q, s) => q - s) as [number, number]), y, y + Dp.h));
    }
    // 复印纸 cartons in the window corner of that wall: a stack of three, one opened on the floor beside it
    const K = P.carton, ka = p.fa - 0.35;
    for (let i = 0; i < 3; i++) turned(i % 2 ? 'boxB' : 'box', ka, fv(0.3), rng.range(-0.08, 0.08), 0, 0, K.a / 2, K.v / 2, y + i * K.h, y + (i + 1) * K.h);
    bx('box', ka - 0.22, ka + 0.22, fv(0.62), fv(0.92), 0, K.h, ['bottom', 'top']);
    for (let i = 0; i < 3; i++) bx(i % 2 ? 'paper' : 'tileWhite', ka - 0.19, ka + 0.19, fv(0.64 + i * 0.09), fv(0.71 + i * 0.09), 0, K.h - 0.03 - i * 0.02);
    solid.push(box(ka - 0.25, ka + 0.25, ...([fv(0.1), fv(0.95)].sort((q, s) => q - s) as [number, number]), y, y + 3 * K.h));
    // the worktable under the window, across the rest of the window wall
    const tv0 = fv(1.15), tv1 = wallD + sv * 0.3, ta1 = p.fa - 0.15, ta0 = ta1 - 0.7, th = 0.78;
    table(ta0, ta1, tv0, tv1, th);
    // 试卷 piles (a fresh-printed batch, squared up), one turned to a 黑边 sheet
    let tv = Math.min(tv0, tv1) + 0.3;
    for (let i = 0; i < 3 && tv < Math.max(tv0, tv1) - 0.8; i++, tv += 0.4) {
      let h = y + th;
      for (let l = 0; l < 2 + i; l++) { const t = rng.range(0.03, 0.06); turned('paper', ta0 + 0.3, tv, rng.range(-0.06, 0.06), 0, 0, 0.15, 0.2, h, h + t, ['bottom'], { pile: true }); h += t; }
    }
    // the 裁纸刀 at the far end: a pale board, the blade raised at an angle (a stepped bar), the grip at its end
    const kv = tv1 + sv * 0.4, ka2 = (ta0 + ta1) / 2;
    turned('tableTop', ka2, kv, 0, 0, 0, 0.24, 0.2, y + th, y + th + 0.03);
    for (let i = 0; i < 4; i++) turned('steel', ka2 - 0.22 + i * 0.1, kv + 0.18, 0, 0.05, 0, 0.06, 0.012, y + th + 0.03 + i * 0.05, y + th + 0.06 + i * 0.05, ['bottom']);
    turned('ink', ka2 + 0.2, kv + 0.18, 0, 0, 0, 0.05, 0.02, y + th + 0.2, y + th + 0.26);
    seatAt(ta0 - 0.3, (tv0 + tv1) / 2, rng.range(-0.3, 0.3), -1);
    // a 铁皮柜 (the 蜡纸 masters, toner) on the door's side wall past the door
    steelUnit(-p.L + 1.25, wallD, sv, 'drawers');
  }

  /**
   * 财务室: a 处室's 拼桌 and 铁皮柜 plus a 保险柜 in the window corner of the side wall away from the door (dark green,
   * a 密码盘 and a T 把手), a 铁栅门 folded open against the back wall beside the door (the 财务室's second door: a frame
   * of flat bar, bars a hand apart), and 防盗栏 over every window.
   */
  function financeSet() {
    const sa0 = p.fa - 0.6, sa1 = p.fa - 0.05, fv = (t: number) => wallS - sv * t;
    bx('safe', sa0, sa1, fv(0.05), fv(0.6), 0, 0.95);
    bx('ink', sa0 + 0.03, sa1 - 0.03, fv(0.6), fv(0.604), 0.06, 0.9, ['bottom', 'top']);
    bx('safe', sa0 + 0.05, sa1 - 0.05, fv(0.604), fv(0.62), 0.08, 0.88, ['bottom']);
    bx('steel', sa0 + 0.22, sa0 + 0.34, fv(0.62), fv(0.65), 0.58, 0.7, ['bottom']); // 密码盘
    bx('steel', sa0 + 0.25, sa0 + 0.31, fv(0.62), fv(0.69), 0.44, 0.47, ['bottom']); // 把手
    solid.push(box(sa0, sa1, ...([fv(0.05), fv(0.7)].sort((q, s) => q - s) as [number, number]), y, y + 0.95));
    // the 铁栅门: folded back flat against the back wall on the side away from the 档案柜 row, beside the door
    const gw = 1.0, gv0 = p.dv + sv * 0.6, gv1 = gv0 + sv * gw, ga = -p.L + 0.02, gh = 2.05;
    for (const e of [gv0, gv1]) bx('steel', ga, ga + 0.04, e - 0.02, e + 0.02, 0, gh, ['bottom']);
    for (const h of [0.05, 1.0, gh - 0.04]) bx('steel', ga, ga + 0.04, gv0, gv1, h, h + 0.04, ['bottom']);
    for (let i = 1; i < 9; i++) { const v = gv0 + sv * (i * gw / 9); bx('steel', ga + 0.01, ga + 0.03, v - 0.008, v + 0.008, 0.05, gh - 0.04, ['bottom', 'top']); }
    // 防盗栏 over the windows: four bars and two rails just inside the glass
    for (const w of windowSpans(b, r, p, y)) {
      const wa = p.fa - 0.06, nb = 5;
      for (let i = 1; i < nb; i++) { const v = w.v0 + (i * (w.v1 - w.v0)) / nb; bx('steel', wa - 0.016, wa, v - 0.008, v + 0.008, w.y0 - y, w.y0 - y + 1.7, ['bottom', 'top']); }
      for (const h of [0.05, 1.6]) bx('steel', wa - 0.02, wa, w.v0, w.v1, w.y0 - y + h, w.y0 - y + h + 0.03);
    }
  }

  if (cls === 'head') headSet();
  if (cls === 'meeting') meetingSet();
  if (steel) adminSet();
  if (cls === 'finance') financeSet();
  if (cls === 'archive') archiveSet();
  if (cls === 'print') printSet();

  // ── ceiling: 日光灯 over the island, one 吊扇
  const h = floorStack(b).find(s => Math.abs(s.y - y) < 1e-6)?.h ?? b.floorHeight ?? FLOOR_HEIGHT;
  render.push(...lampsAndFans(r, y, h, O.fans).out);
  return { render, solid };
}
