import { FLOOR_HEIGHT, WALL_T, type BuildingDef, type RoomDef, type Side } from '../../../../shared/campus/campus_schema.ts';
import { PART, rectOf } from './rooms.ts';
import { lampsAndFans, roomFrame, type Face, type FurnBox, type Kind } from './classroom.ts';
import type { LBox } from '../../../../shared/campus/stairs.ts';

/**
 * 厕所陈设 (环境细节①, docs/03_campus.md 室内): a row of 蹲位 against the door wall (the corridor 隔墙), starting at
 * the end away from the door, up one 台阶: painted 隔板 between them, a wooden 隔间门 each (the far one shut, the next
 * one ajar, the rest swung in flat against their 隔板), a white 蹲坑, a 高水箱 with its pull chain on the back wall
 * and a 纸篓 in the corner. Across the aisle a tiled 小便槽 along the far wall (not in a 女厕所), and a 拖把池 in the
 * far corner on the door side with a 拖把 leaning in it. One 日光灯 row, no fan. Pure; the render goes through
 * classroom.ts furnitureGeometry. world/decals.ts stallPoster puts 涂鸦 on the 隔板 faces inside a stall.
 */
export const TOILET = {
  /** 蹲位: pitch along the wall (partition centre to centre), depth out from the door wall, at most this many */
  stall: { pitch: 0.95, d: 1.3, max: 5, clear: 0.35 },
  /** 台阶 under the 蹲位 (walked onto: under the step height) */ step: 0.2,
  /** 隔板: thickness, height above the step, its 立柱's depth, how far the 压条 / stained foot stand proud of it; 隔间门: thickness, gap under it, height, how far the ajar one stands open */
  part: { t: 0.06, h: 1.7, post: 0.06, trim: 0.006, foot: 0.14 }, leaf: { t: 0.03, gap: 0.15, h: 1.5, ajar: 1.25 },
  /** 蹲坑 (across × along), its hole at the back end */ pan: { w: 0.3, d: 0.55, hole: [0.12, 0.16] as [number, number] },
  /** 高水箱: centre height above the step, across × deep × high; pull chain down to */ tank: { y: 1.95, w: 0.4, d: 0.16, h: 0.26, chain: 1.35 },
  /** 小便槽: depth off the far wall, height, the splash tiles behind it (kept under the window sill) */ trough: { d: 0.36, h: 0.14, splash: 0.75 },
  /** 拖把池 (across × deep × high) */ mop: { w: 0.6, d: 0.5, h: 0.45 },
};

export const isToiletRoom = (r: RoomDef) => r.kind === 'toilet';

const vecOf = (s: Side): [number, number] => (s[1] === 'x' ? [s[0] === '+' ? 1 : -1, 0] : [0, s[0] === '+' ? 1 : -1]);
const flip = (s: Side): Side => `${s[0] === '+' ? '-' : '+'}${s[1]}` as Side;

/**
 * The 厕所's frame (classroom.ts roomFrame facing away from its door wall: a from the door wall `ba` to the far wall
 * `fa`, v across between `wl` / `wr`; each a wall face: a 隔墙's is PART.t / 2 in from the room edge, an outer wall's is
 * the edge), the door's span `door` (v), the side `s` (±1) the 蹲位 row runs from (the end away from the door), and the
 * 蹲位: `parts` = the partition centres (v) from that end, stall k between parts[k] and parts[k + 1].
 */
export function toiletPlan(b: BuildingDef, r: RoomDef) {
  const ds: Side = r.doors?.[0]?.side ?? '-z', front = flip(ds), fr = roomFrame(r, front), t = PART.t / 2;
  const R = rectOf(r), hx = b.w / 2 - WALL_T, hz = b.d / 2 - WALL_T;
  const edge = (s: Side) => (s === '+x' ? R.x1 : s === '-x' ? R.x0 : s === '+z' ? R.z1 : R.z0);
  const outer = (s: Side) => Math.abs(Math.abs(edge(s)) - (s[1] === 'x' ? hx : hz)) < 0.05;
  const inset = (k: 'f' | 'b' | 'r' | 'l') => (outer(fr.dir(k)) ? 0 : t);
  const fa = fr.L + t - inset('f'), ba = -fr.L - t + inset('b'), wr = fr.W + t - inset('r'), wl = -fr.W - t + inset('l');
  const d0 = r.doors?.[0], [fx, fz] = vecOf(front), k = ds[1] === 'z' ? -fz : fx; // v = k · u along the door wall
  const door: [number, number] = d0 ? [k * d0.at - d0.width / 2, k * d0.at + d0.width / 2] : [wr, wr];
  const s = (door[0] + door[1]) / 2 > 0 ? 1 : -1, S = TOILET.stall;
  const start = s > 0 ? wl : wr, room = s > 0 ? door[0] - S.clear - wl : wr - door[1] - S.clear;
  const n = Math.max(0, Math.min(S.max, Math.floor(room / S.pitch)));
  const parts = Array.from({ length: n + 1 }, (_, i) => start + s * i * S.pitch);
  return { ...fr, fa, ba, wl, wr, door, s, parts, female: r.name.includes('女') };
}

/** Everything in a 厕所 (building-local, y = its storey floor): render boxes and colliders (隔板, shut 门, 台阶, 拖把池). */
export function toiletFurniture(b: BuildingDef, r: RoomDef, y: number, h = FLOOR_HEIGHT): { render: FurnBox[]; solid: LBox[] } {
  const p = toiletPlan(b, r), T = TOILET, render: FurnBox[] = [], solid: LBox[] = [];
  const { box, dir, s } = p, F = dir('f'), B = dir('b');
  const put = (kind: Kind, q: LBox, skip: Face[] = ['bottom'], more: Partial<FurnBox> = {}) => render.push({ ...q, kind, skip, ...more });
  const vs = (a: number, c: number): [number, number] => (a < c ? [a, c] : [c, a]);
  const n = p.parts.length - 1, a0 = p.ba, a1 = p.ba + T.stall.d, sy = y + T.step;
  if (n > 0) {
    // ── 台阶 under the row, its front edge a darker nosing
    const [r0, r1] = vs(p.parts[0], p.parts[n]);
    put('stallStep', box(a0, a1, r0, r1, y, sy), ['bottom', B]);
    put('stageEdge', box(a1 - 0.02, a1 + 0.002, r0, r1, sy - 0.03, sy + 0.002), ['bottom', B]);
    solid.push(box(a0, a1, r0, r1, y, sy));
    // ── 隔板 (the first one stands against the side wall: none there), each out to a front post
    const P = T.part;
    p.parts.forEach((v, i) => {
      if (i === 0) return;
      const q = box(a0, a1, v - P.t / 2, v + P.t / 2, y, sy + P.h), w = P.t / 2 + P.trim;
      put('stall', q, ['bottom', B]);
      solid.push(q);
      // its 立柱 at the aisle end, a 压条 capping the top, the foot stained dark where the mop goes
      put('stallTrim', box(a1 - P.post, a1 + 0.01, v - w - 0.008, v + w + 0.008, y, sy + P.h + 0.02), ['bottom', 'top', B]); // top over eye height, back into the 隔板
      put('stallTrim', box(a0, a1 - P.post, v - w, v + w, sy + P.h - 0.004, sy + P.h + 0.025), ['bottom', 'top', B, F]); // its end butts the 立柱
      put('stallFoot', box(a0, a1 - P.post, v - w, v + w, sy, sy + P.foot), ['bottom', 'top', B]);
    });
    // ── each 蹲位: its door, 蹲坑, 高水箱 + chain, 纸篓
    const L = T.leaf, lt = L.t, ly0 = sy + L.gap, ly1 = ly0 + L.h;
    for (let k = 0; k < n; k++) {
      const c0 = p.parts[k] + s * (k === 0 ? 0 : P.t / 2), c1 = p.parts[k + 1] - s * P.t / 2, [v0, v1] = vs(c0, c1), vm = (v0 + v1) / 2, w = v1 - v0;
      // the leaf hangs on the post at c1 (toward the door end) and swings in
      const hinge = c1;
      if (k === 0) {
        const q = box(a1 - lt, a1, v0, v1, ly0, ly1);
        put('doorLeaf', q, ['bottom']); solid.push(q);
        put('steel', box(a1, a1 + 0.012, hinge - s * (w - 0.08) - 0.03, hinge - s * (w - 0.08) + 0.03, ly0 + 0.75, ly0 + 0.79)); // 插销
      } else if (k === 1) {
        // ajar: turned `ajar` rad in about the hinge, its centre half a leaf out along the turned line
        const ang = T.leaf.ajar, ca = a1 - lt / 2 - Math.sin(ang) * w / 2, cv = hinge - s * Math.cos(ang) * w / 2;
        const [cx, , cz] = p.pt(ca, cv, 0), vh = p.pt(0, 1, 0), o = p.pt(0, 0, 0), vx = vh[0] - o[0], vz = vh[2] - o[2];
        // direction of the leaf (hinge → free edge) in building plan, and the turn that takes v̂ onto it
        const fd = p.pt(-Math.sin(ang), -s * Math.cos(ang), 0), dx = fd[0] - o[0], dz = fd[2] - o[2];
        const rot = Math.atan2(vx * dz - vz * dx, vx * dx + vz * dz);
        const half = box(-lt / 2, lt / 2, -w / 2, w / 2, ly0, ly1), hx = (half.x1 - half.x0) / 2, hz = (half.z1 - half.z0) / 2;
        put('doorLeaf', { x0: cx - hx, x1: cx + hx, z0: cz - hz, z1: cz + hz, y0: ly0, y1: ly1 }, ['bottom'], { rot });
        // collide as a few short boxes along the turned leaf (one AABB round it would fill the 蹲位)
        for (let j = 0; j < 4; j++) {
          const t0 = (j * w) / 4, t1 = ((j + 1) * w) / 4, e0 = p.pt(a1 - lt / 2 - Math.sin(ang) * t0, hinge - s * Math.cos(ang) * t0, 0), e1 = p.pt(a1 - lt / 2 - Math.sin(ang) * t1, hinge - s * Math.cos(ang) * t1, 0);
          solid.push({ x0: Math.min(e0[0], e1[0]) - lt / 2, x1: Math.max(e0[0], e1[0]) + lt / 2, z0: Math.min(e0[2], e1[2]) - lt / 2, z1: Math.max(e0[2], e1[2]) + lt / 2, y0: ly0, y1: ly1 });
        }
      } else {
        // swung right in, flat against the 隔板 it hangs on
        const [l0, l1] = vs(hinge, hinge - s * lt), q = box(a1 - w, a1, l0, l1, ly0, ly1);
        put('doorLeaf', q, ['bottom']); solid.push(q);
      }
      // 蹲坑: a white slot in the step, its hole at the back end
      const pa = (a0 + a1) / 2 + 0.05, Pn = T.pan;
      put('porcelain', box(pa - Pn.d / 2, pa + Pn.d / 2, vm - Pn.w / 2, vm + Pn.w / 2, sy, sy + 0.006), ['bottom']);
      put('ink', box(pa - Pn.d / 2 + 0.05, pa - Pn.d / 2 + 0.05 + Pn.hole[1], vm - Pn.hole[0] / 2, vm + Pn.hole[0] / 2, sy + 0.006, sy + 0.008), ['bottom']);
      // 高水箱 on the back wall, a pipe down to the pan, its chain
      const Tk = T.tank, ty = sy + Tk.y;
      put('enamel', box(a0, a0 + Tk.d, vm - Tk.w / 2, vm + Tk.w / 2, ty - Tk.h / 2, ty + Tk.h / 2), ['bottom', B]);
      put('steel', box(a0, a0 + 0.035, vm - 0.016, vm + 0.016, sy, ty - Tk.h / 2), ['top', 'bottom', B]);
      put('steel', box(a0 + Tk.d - 0.012, a0 + Tk.d, vm + Tk.w / 2 - 0.05, vm + Tk.w / 2 - 0.04, sy + Tk.chain, ty - Tk.h / 2), ['top', 'bottom']);
      put('knob', box(a0 + Tk.d - 0.02, a0 + Tk.d + 0.008, vm + Tk.w / 2 - 0.06, vm + Tk.w / 2 - 0.03, sy + Tk.chain - 0.06, sy + Tk.chain));
      // 纸篓 in the back corner by the hinge-side 隔板
      const bv = c1 - s * 0.14;
      put('cabinet', box(a0 + 0.03, a0 + 0.25, bv - 0.11, bv + 0.11, sy, sy + 0.26), ['bottom']);
    }
  }
  // ── 小便槽 along the far wall (男厕所, 厕所), short of the 拖把池 corner on the door side
  const M = T.mop, mv1 = p.s > 0 ? p.wr : p.wl, [m0, m1] = vs(mv1, mv1 - s * M.w);
  if (!p.female) {
    const Tr = T.trough, [t0, t1] = vs(p.s > 0 ? p.wl + 0.3 : p.wr - 0.3, mv1 - s * (M.w + 0.25));
    put('tileWhite', box(p.fa - Tr.d, p.fa, t0, t1, y, y + Tr.h), ['bottom', F]);
    put('trayStop', box(p.fa - Tr.d + 0.08, p.fa - 0.06, t0 + 0.04, t1 - 0.04, y + Tr.h, y + Tr.h + 0.002), ['bottom']); // the wet channel
    put('tileWhite', box(p.fa - 0.012, p.fa, t0, t1, y + Tr.h, y + Tr.splash), ['bottom', F]);
    put('steel', box(p.fa - 0.05, p.fa, t0, t1, y + Tr.splash - 0.03, y + Tr.splash), ['bottom', F]); // 冲水管 along the top
  }
  // ── 拖把池 in the far corner on the door side, a 拖把 leaning in it, a 水龙头 over it
  const ma0 = p.fa - M.d;
  put('tileWhite', box(ma0, p.fa, m0, m1, y, y + M.h), ['bottom', F]);
  put('ink', box(ma0 + 0.05, p.fa - 0.05, m0 + 0.05, m1 - 0.05, y + M.h, y + M.h + 0.002), ['bottom']);
  solid.push(box(ma0, p.fa, m0, m1, y, y + M.h));
  const mv = (m0 + m1) / 2;
  put('steel', box(p.fa - 0.12, p.fa, mv - 0.015, mv + 0.015, y + 0.78, y + 0.81), ['bottom', F]);
  // the 拖把 stood in the corner of the pool, its handle up against the wall
  const sv = mv + s * 0.16, sa = p.fa - 0.1;
  put('cloth', box(sa - 0.08, sa + 0.08, sv - 0.09, sv + 0.09, y + M.h - 0.2, y + M.h - 0.02), ['bottom']);
  put('peg', box(sa - 0.015, sa + 0.015, sv - 0.015, sv + 0.015, y + M.h - 0.05, y + M.h + 1.15), ['bottom']);
  solid.push(box(sa - 0.1, p.fa, sv - 0.1, sv + 0.1, y, y + M.h + 1.15));
  render.push(...lampsAndFans(r, y, h, 0).out);
  return { render, solid };
}
