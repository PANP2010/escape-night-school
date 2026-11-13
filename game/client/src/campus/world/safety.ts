import { floorStack, groundEntrances, type BuildingDef, type CampusDef, type RoomDef, type Side } from '../../../../shared/campus/campus_schema.ts';
import { PART, rectOf, storeyPartitions, storeyRooms } from './rooms.ts';
import { STAIR, type LBox } from '../../../../shared/campus/stairs.ts';
import { canopyOf } from './shelter.ts';
import { GATE, gateSpan } from './gate.ts';
import type { Face, FurnBox, Kind } from './classroom.ts';
import type { PropPart } from './props.ts';

/**
 * 消防与监控 (环境细节①): 灭火器箱 standing against the corridor 隔墙 (every ≤ SAFETY.ext.every m, clear of the
 * doors), a 监控摄像头 under the ceiling at each end of every corridor looking down it, one on the wall beside each
 * main entrance's 雨棚 looking out, and one on each 门柱 of the gate. Every camera has an id (`cameraSpots`) for
 * later play (who saw what); nothing about them is shown to the player. Pure: the indoor parts go into
 * classroom.ts storeyFurniture (building-local), the outdoor ones into the PROPS mesh (world/props.ts, world space).
 */
export const SAFETY = {
  /** 灭火器箱: along the wall × deep × high; inset from the corridor ends; at most this far apart; door clearance */
  ext: { w: 0.5, d: 0.2, h: 0.68, end: 3, every: 15, clear: 0.2 },
  /** corridors at least this long get a camera at each end, this far in from the end */ corridorMin: 8, camIn: 0.45,
  /** camera body (across, high, long), ceiling plate, stem; entrances at least this wide get one */
  cam: { w: 0.11, h: 0.1, l: 0.26, plate: 0.13, stem: 0.14 }, entranceMin: 2.4,
};

export interface CameraSpot {
  id: string; where: 'corridor' | 'entrance' | 'gate';
  /** world position of the lens and the way it looks (plan) */ x: number; y: number; z: number; facing: Side;
  building?: string; level?: number;
}

const VEC: Record<Side, [number, number]> = { '+x': [1, 0], '-x': [-1, 0], '+z': [0, 1], '-z': [0, -1] };
const flip = (s: Side): Side => `${s[0] === '+' ? '-' : '+'}${s[1]}` as Side;
const END_NAME: Record<Side, string> = { '+x': 'e', '-x': 'w', '+z': 's', '-z': 'n' };

/** A corridor's long axis, its span along it, and its centre across. */
function corridorAxis(r: RoomDef) {
  const R = rectOf(r), ax: 'x' | 'z' = r.w >= r.d ? 'x' : 'z';
  return ax === 'x' ? { ax, u0: R.x0, u1: R.x1, v: r.z, sides: [[R.z1, '+z'], [R.z0, '-z']] as [number, Side][] }
    : { ax, u0: R.z0, u1: R.z1, v: r.x, sides: [[R.x1, '+x'], [R.x0, '-x']] as [number, Side][] };
}

/**
 * Where a corridor's 灭火器箱 stand (building-local): on the long side with the most solid 隔墙 (the outer wall has
 * the windows and radiators), each centre `u` along the corridor, the wall face at `c`, `n` = the way it faces.
 */
export function extinguisherSpots(b: BuildingDef, level: number, r: RoomDef): { u: number; c: number; n: Side; ax: 'x' | 'z' }[] {
  const E = SAFETY.ext, { ax, u0, u1, sides } = corridorAxis(r), parts = storeyPartitions(b, level), t = PART.t / 2;
  // the solid stretches (no door) of the 隔墙 on each long side, clipped to the corridor
  const solid = (c: number) => parts.filter(p => p.axis === ax && Math.abs(p.c - c) < 1e-3).flatMap(p => {
    const doors = p.holes.filter(h => h.y0 < E.h).map(h => [h.u0 - E.clear, h.u1 + E.clear]).sort((a, q) => a[0] - q[0]);
    const out: [number, number][] = [];
    let a = Math.max(p.u0, u0);
    for (const [h0, h1] of doors) { if (h0 > a) out.push([a, Math.min(h0, u1)]); a = Math.max(a, h1); }
    if (a < Math.min(p.u1, u1)) out.push([a, Math.min(p.u1, u1)]);
    return out.filter(([x, y]) => y - x >= E.w);
  });
  const best = sides.map(([c, s]) => ({ c, s, spans: solid(c) })).map(o => ({ ...o, len: o.spans.reduce((k, [x, y]) => k + y - x, 0) }))
    .sort((p, q) => q.len - p.len)[0];
  if (!best || !best.len) return [];
  const L = u1 - u0, n = L < 2 * E.end + E.w ? 1 : 1 + Math.ceil((L - 2 * E.end) / E.every);
  const want = n === 1 ? [(u0 + u1) / 2] : Array.from({ length: n }, (_, i) => u0 + E.end + (i * (L - 2 * E.end)) / (n - 1));
  const fits = (u: number) => best.spans.some(([x, y]) => u - E.w / 2 >= x - 1e-6 && u + E.w / 2 <= y + 1e-6);
  const out: { u: number; c: number; n: Side; ax: 'x' | 'z' }[] = [];
  for (const w of want) {
    // nudge along the wall to the nearest place clear of the doors (within 9 m)
    let u: number | undefined;
    for (let k = 0; k <= 60 && u === undefined; k++) for (const s of k ? [1, -1] : [1]) if (u === undefined && fits(w + s * k * 0.15)) u = w + s * k * 0.15;
    if (u !== undefined && !out.some(o => Math.abs(o.u - u!) < 2)) out.push({ u, c: best.c + (best.s[0] === '+' ? -t : t), n: flip(best.s), ax });
  }
  return out;
}
/** A box by centre + size (any frame). */
type Part<K> = { kind: K; c: [number, number, number]; s: [number, number, number] };
/**
 * A 监控摄像头 hung from a mount point (x, y, z) (the underside of a ceiling or an arm), looking `facing`: a plate,
 * a stem down, the bullet body pushed towards where it looks, a black lens hood on its front, a red light on its tail.
 * Returns the parts and the lens point.
 */
function cameraParts(x: number, y: number, z: number, facing: Side): { parts: Part<'mount' | 'body' | 'lens' | 'led'>[]; lens: [number, number, number] } {
  const C = SAFETY.cam, [fx, fz] = VEC[facing], along = fx !== 0;
  const sz = (a: number, h: number, l: number): [number, number, number] => (along ? [l, h, a] : [a, h, l]);
  const at = (k: number, dy: number): [number, number, number] => [x + fx * k, y + dy, z + fz * k];
  const by = y - C.stem - C.h / 2;
  const parts: Part<'mount' | 'body' | 'lens' | 'led'>[] = [
    { kind: 'mount', c: at(0, -0.01), s: sz(C.plate, 0.02, C.plate) },
    { kind: 'mount', c: at(0, -C.stem / 2), s: sz(0.03, C.stem, 0.03) },
    { kind: 'body', c: [x + fx * 0.06, by, z + fz * 0.06], s: sz(C.w, C.h, C.l) },
    // the sun hood over the lens, a dark ring in front of the body
    { kind: 'body', c: [x + fx * (0.06 + C.l / 2 + 0.03), by + C.h / 2 - 0.008, z + fz * (0.06 + C.l / 2 + 0.03)], s: sz(C.w + 0.02, 0.016, 0.07) },
    { kind: 'lens', c: [x + fx * (0.06 + C.l / 2 + 0.005), by - 0.005, z + fz * (0.06 + C.l / 2 + 0.005)], s: sz(C.w * 0.7, C.h * 0.7, 0.012) },
    { kind: 'led', c: [x + fx * (0.06 - C.l / 2 - 0.004), by + 0.02, z + fz * (0.06 - C.l / 2 - 0.004)], s: sz(0.022, 0.022, 0.008) },
  ];
  return { parts, lens: [x + fx * (0.06 + C.l / 2), by, z + fz * (0.06 + C.l / 2)] };
}

/** Each corridor of a storey that is long enough: its two end cameras (building-local mount point, ids). */
function corridorCameras(b: BuildingDef, level: number, ceil: number) {
  const out: { id: string; x: number; y: number; z: number; facing: Side }[] = [];
  for (const r of storeyRooms(b, level)) {
    if (r.kind !== 'corridor') continue;
    const { ax, u0, u1, v } = corridorAxis(r);
    if (u1 - u0 < SAFETY.corridorMin) continue;
    for (const [u, look] of [[u0 + SAFETY.camIn, ax === 'x' ? '+x' : '+z'], [u1 - SAFETY.camIn, ax === 'x' ? '-x' : '-z']] as [number, Side][]) {
      const [x, z] = ax === 'x' ? [u, v] : [v, u];
      out.push({ id: `${b.id}.${level}F.${r.id}.${END_NAME[flip(look)]}`, x, y: ceil, z, facing: look });
    }
  }
  return out;
}

const FB = (kind: Kind, q: Part<unknown>, more: Partial<FurnBox> = {}): FurnBox => ({
  x0: q.c[0] - q.s[0] / 2, x1: q.c[0] + q.s[0] / 2, y0: q.c[1] - q.s[1] / 2, y1: q.c[1] + q.s[1] / 2,
  z0: q.c[2] - q.s[2] / 2, z1: q.c[2] + q.s[2] / 2, kind, ...more,
});
const CAM_KIND: Record<'mount' | 'body' | 'lens' | 'led', Kind> = { mount: 'camMount', body: 'camBody', lens: 'camLens', led: 'camLed' };

/** A storey's 灭火器箱 and corridor cameras (building-local, y = world height): render boxes and colliders (箱子). */
export function safetyFurniture(b: BuildingDef, level: number): { render: FurnBox[]; solid: LBox[] } {
  const st = floorStack(b).find(s => s.level === level), render: FurnBox[] = [], solid: LBox[] = [];
  if (!st) return { render, solid };
  const E = SAFETY.ext, y = st.y;
  for (const r of storeyRooms(b, level)) {
    if (r.kind !== 'corridor') continue;
    for (const s of extinguisherSpots(b, level, r)) {
      const [nx, nz] = VEC[s.n], along = s.ax === 'x';
      // a box in the cabinet's frame: k out from the wall face, sizes (along the wall, high, out)
      const put = (kind: Kind, u: number, k: number, y0: number, y1: number, w: number, d: number, more: Partial<FurnBox> = {}) => {
        const cu = s.u + u, ck = s.c + (nx + nz) * k, h = (along ? [w, d] : [d, w]);
        const [cx, cz] = along ? [cu, ck] : [ck, cu];
        // a thin panel on the front (≤ 1.2 cm proud) shows only its face: the ink pass outlines it anyway
        const sides: Side[] = along ? ['+x', '-x'] : ['+z', '-z'], skip: Face[] = d <= 0.012 ? ['bottom', 'top', flip(s.n), ...sides] : ['bottom', flip(s.n)];
        render.push({ x0: cx - h[0] / 2, x1: cx + h[0] / 2, z0: cz - h[1] / 2, z1: cz + h[1] / 2, y0: y + y0, y1: y + y1, kind, skip, ...more });
      };
      put('extBox', 0, E.d / 2, 0.04, E.h, E.w, E.d);
      put('stallStep', 0, E.d / 2, 0, 0.04, E.w - 0.02, E.d - 0.02);
      // the door's glass panel, the two red bottles behind it (their shoulders and black valves), the white 标识 band
      put('extGlass', 0, E.d + 0.004, 0.2, E.h - 0.06, E.w - 0.1, 0.008);
      for (const o of [-0.1, 0.1]) {
        put('extBottle', o, E.d + 0.009, 0.24, 0.5, 0.11, 0.004);
        put('camBody', o, E.d + 0.01, 0.5, 0.56, 0.05, 0.004);
      }
      put('extLabel', 0, E.d + 0.004, 0.07, 0.16, E.w - 0.08, 0.008);
      put('extLabel', 0, E.d + 0.004, 0.105, 0.125, E.w * 0.4, 0.012, { kind: 'extBox' });
      // the 灭火器 sign on the wall above it (red on white)
      put('extLabel', 0, 0.006, 1.5, 1.72, 0.3, 0.012);
      put('extBox', 0, 0.01, 1.53, 1.69, 0.12, 0.008);
      const [cx, cz] = along ? [s.u, s.c + (nx + nz) * E.d / 2] : [s.c + (nx + nz) * E.d / 2, s.u];
      solid.push({ x0: cx - (along ? E.w : E.d) / 2, x1: cx + (along ? E.w : E.d) / 2, z0: cz - (along ? E.d : E.w) / 2, z1: cz + (along ? E.d : E.w) / 2, y0: y, y1: y + E.h });
    }
  }
  for (const c of corridorCameras(b, level, st.y + st.h - STAIR.slab)) {
    // seen from below: the plate's and stem's tops are against the ceiling, the lens and the light are flat discs
    for (const q of cameraParts(c.x, c.y, c.z, c.facing).parts) {
      const flat = q.kind === 'lens' || q.kind === 'led', back = flat ? (q.kind === 'lens' ? flip(c.facing) : c.facing) : undefined;
      const skip: Face[] = q.kind === 'mount' ? ['top'] : flat ? ['top', 'bottom', back!, ...(c.facing[1] === 'x' ? ['+z', '-z'] : ['+x', '-x']) as Side[]] : [];
      render.push(FB(CAM_KIND[q.kind], q, { skip, ...(q.kind === 'led' ? { glow: 'led' as const, phase: 1 } : {}) }));
    }
  }
  return { render, solid };
}

/** Outdoor camera mounts (world): beside every main entrance's 雨棚, and on top of each gate 门柱. */
function outdoorCameras(c: CampusDef): { id: string; where: 'entrance' | 'gate'; x: number; y: number; z: number; facing: Side; building?: string; arm?: [number, number] }[] {
  const out: ReturnType<typeof outdoorCameras> = [];
  for (const b of c.buildings) {
    groundEntrances(b).filter(e => e.width >= SAFETY.entranceMin).forEach((e, i) => {
      const C = canopyOf(e), [fx, fz] = VEC[e.side], u = e.at + e.width / 2 + C.side + 0.35, y = e.height + C.gap + C.t + 0.55;
      const face = e.side[1] === 'z' ? [b.x + u, b.z + fz * b.d / 2] : [b.x + fx * b.w / 2, b.z + u];
      // on an arm 0.35 m out from the wall
      out.push({ id: `${b.id}.door${i}`, where: 'entrance', x: face[0] + fx * 0.35, y, z: face[1] + fz * 0.35, facing: e.side, building: b.id, arm: [face[0], face[1]] });
    });
  }
  const g = gateSpan(c.wall), P = GATE.pillar, top = P.h + P.capT + 0.32;
  out.push({ id: 'gate.w', where: 'gate', x: g.x0 - P.w / 2, y: top, z: g.z, facing: '-z' });
  out.push({ id: 'gate.e', where: 'gate', x: g.x1 + P.w / 2, y: top, z: g.z, facing: '+z' });
  return out;
}

/** The outdoor cameras' boxes (world), for the PROPS mesh: the arm or the pole, then the camera. */
export function outdoorCameraParts(c: CampusDef): PropPart[] {
  const out: PropPart[] = [], KIND = { mount: 'camMount', body: 'camBody', lens: 'camLens', led: 'camLed' } as const;
  for (const m of outdoorCameras(c)) {
    if (m.arm) {
      const [ax, az] = m.arm;
      out.push({ kind: 'camMount', c: [(ax + m.x) / 2, m.y + 0.01, (az + m.z) / 2], s: [Math.abs(m.x - ax) + 0.04, 0.04, Math.abs(m.z - az) + 0.04] });
      out.push({ kind: 'camMount', c: [ax, m.y - 0.04, az], s: [0.14, 0.18, 0.14] });
    } else out.push({ kind: 'camMount', c: [m.x, m.y - 0.16, m.z], s: [0.05, 0.32, 0.05] });
    for (const q of cameraParts(m.x, m.y, m.z, m.facing).parts) out.push({ kind: KIND[q.kind], c: q.c, s: q.s });
  }
  return out;
}

/** Every 监控摄像头 on the campus with its id (world lens position, the way it looks). */
export function cameraSpots(c: CampusDef): CameraSpot[] {
  const out: CameraSpot[] = [];
  for (const b of c.buildings) for (const st of floorStack(b)) {
    for (const m of corridorCameras(b, st.level, st.y + st.h - STAIR.slab)) {
      const [x, y, z] = cameraParts(m.x, m.y, m.z, m.facing).lens;
      out.push({ id: m.id, where: 'corridor', x: b.x + x, y, z: b.z + z, facing: m.facing, building: b.id, level: st.level });
    }
  }
  for (const m of outdoorCameras(c)) {
    const [x, y, z] = cameraParts(m.x, m.y, m.z, m.facing).lens;
    out.push({ id: m.id, where: m.where, x, y, z, facing: m.facing, ...(m.building ? { building: m.building, level: 1 } : {}) });
  }
  return out;
}
