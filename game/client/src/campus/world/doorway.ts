import type { BuildingDef, DoorDef, RoomDef, Side } from '../../../../shared/campus/campus_schema.ts';
import { floorStack } from '../../../../shared/campus/campus_schema.ts';
import { OPEN, PART, rectOf, storeyPartitions, storeyRooms } from './rooms.ts';
import type { DoorSpot } from '../../../../shared/doors.ts';
import type { FurnBox } from './classroom.ts';
import { seedOf } from './office.ts';
import type { LBox } from '../../../../shared/campus/stairs.ts';

/**
 * 门套 + 常开的办公室门扇 (todo 打磨批次②③a). Every door hole through a 隔墙 gets a painted wooden 门套: each jamb one box
 * wrapping the pier's edge (the 门套线 standing `proud` off both wall faces, `w` wide, and the 包边 lining the reveal
 * `lining` deep into the hole), a head box the same over the top. An unlocked 办公室 door stands open on its leaf (the
 * same slab, 把手 and 锁 plate as world/doors.ts LEAF), hinged at the hole's end nearer the room's side wall and pushed
 * open into the room a little past square, each office's its own way (`ajar`, hashed on the room; never so far that its
 * free edge meets that wall): wide open, as they stand all day, so a walker (radius 0.3) through the hole's middle
 * clears it (half open would leave the doorway half shut). Building-local boxes for the storey's furniture mesh
 * (0 new draw calls); the leaf is solid.
 */
export const DOORWAY = {
  /** 门套线 width, how far it stands off the wall face, how far the 包边 reaches into the hole (m) */ w: 0.06, proud: 0.012, lining: 0.02,
  /** leaf slab thickness, its inset from the room-side face, clearance in the hole (as doors.ts LEAF) */ t: 0.05, inset: 0.02, gap: 0.01,
  /** an 办公室 leaf's open angle range (rad from shut), and the least gap between its free edge and the side wall (m) */
  ajar: [1.6, 2.0] as const, wallGap: 0.12,
};

export const inward = (s: Side): [number, number] => (s === '+x' ? [-1, 0] : s === '-x' ? [1, 0] : s === '+z' ? [0, -1] : [0, 1]);

/** A door in world x, z: its along unit `u` (+x or +z), into-room `n`, the hole's middle (along, building-local) and
 * `at(v)`: the point v along the wall on the room-side face of the 隔墙. */
export function doorFrame(b: BuildingDef, r: RoomDef, d: DoorDef) {
  const R = rectOf(r), n = inward(d.side), alongX = d.side[1] === 'z';
  const c = d.side === '+x' ? R.x1 : d.side === '-x' ? R.x0 : d.side === '+z' ? R.z1 : R.z0;
  const mid = (alongX ? r.x : r.z) + d.at, face = c + (alongX ? n[1] : n[0]) * PART.t / 2;
  const at = (v: number): [number, number] => (alongX ? [b.x + v, b.z + face] : [b.x + face, b.z + v]);
  const u: [number, number] = alongX ? [1, 0] : [0, 1];
  return { mid, at, u, n };
}

/** The 门套 of every door hole through the storey's 隔墙 (building-local, render only: the lining narrows a hole by 4 cm). */
export function doorTrims(b: BuildingDef, level: number): FurnBox[] {
  const D = DOORWAY, out: FurnBox[] = [], t = PART.t / 2 + D.proud;
  for (const p of storeyPartitions(b, level)) for (const h of p.holes) {
    if (h.kind !== 'door') continue;
    const H = p.y1 - p.y0, top = Math.min(h.y1, H), cap = Math.min(top + D.w, H), y = p.y0;
    const put = (u0: number, u1: number, y0: number, y1: number, skip: FurnBox['skip']) => out.push(p.axis === 'x'
      ? { kind: 'doorTrim', x0: u0, x1: u1, z0: p.c - t, z1: p.c + t, y0: y + y0, y1: y + y1, skip }
      : { kind: 'doorTrim', x0: p.c - t, x1: p.c + t, z0: u0, z1: u1, y0: y + y0, y1: y + y1, skip });
    // never seen: tops (over the eye, flush with the head's), a jamb's foot and its outer edge (a 1.2 cm sliver the ink
    // pass outlines anyway), the head's ends (in the jambs); a hole at the very end of a partition keeps its 门套线 on it
    const [lo, hi]: Side[] = p.axis === 'x' ? ['-x', '+x'] : ['-z', '+z'];
    put(Math.max(p.u0, h.u0 - D.w), h.u0 + D.lining, 0, cap, ['top', 'bottom', lo]);
    put(h.u1 - D.lining, Math.min(p.u1, h.u1 + D.w), 0, cap, ['top', 'bottom', hi]);
    if (top < H) put(h.u0 + D.lining, h.u1 - D.lining, top - D.lining, cap, ['top', lo, hi]);
  }
  return out;
}

/** World plan of every unlocked 办公室 door's open leaf: hinge (x, z), along-shut `u` from the hinge, into-room `n`, width,
 * height, the angle it stands open at. */
export function officeLeafPlans(b: BuildingDef, level: number): { room: string; hinge: [number, number]; u: [number, number]; n: [number, number]; w: number; h: number; ajar: number }[] {
  const out: ReturnType<typeof officeLeafPlans> = [];
  for (const r of storeyRooms(b, level)) {
    if (r.kind !== 'office') continue;
    (r.doors ?? []).forEach((d, i) => {
      if (d.key) return;
      const { mid, at, u, n } = doorFrame(b, r, d), R = rectOf(r);
      const [lo, hi] = d.side[1] === 'z' ? [R.x0, R.x1] : [R.z0, R.z1];
      // hinged at the end nearer the room's side wall, the leaf (shut) running from there back across the hole
      const e = mid - lo < hi - mid ? -1 : 1, hv = mid + e * d.width / 2;
      // that wall's face (a 隔墙's, the nearer of the two an outer wall's could be), and the widest the leaf may stand open
      const jamb = Math.abs((e < 0 ? lo : hi) - hv) - PART.t / 2;
      const most = Math.acos(Math.max(-1, Math.min(1, -(jamb - DOORWAY.wallGap) / d.width)));
      const [a0, a1] = DOORWAY.ajar, f = (seedOf(`${b.id}.${level}F.${r.id}.door${i}`) % 1024) / 1023;
      out.push({ room: r.id, hinge: at(hv), u: [-e * u[0], -e * u[1]], n, w: d.width, h: d.height ?? PART.door.height, ajar: Math.min(most, a0 + (a1 - a0) * f) });
    });
  }
  return out;
}

/** Every 办公室's open leaf on a storey as building-local boxes: the slab, a 把手 each face, the 锁 plate (all turned). */
export function officeLeaves(b: BuildingDef, level: number): { render: FurnBox[]; solid: LBox[] } {
  const st = floorStack(b).find(s => s.level === level), render: FurnBox[] = [], solid: LBox[] = [];
  if (!st) return { render, solid };
  const D = DOORWAY, back = D.inset + D.t;
  for (const q of officeLeafPlans(b, level)) {
    // the leaf's along and across (toward the room) axes after turning u toward n
    const c = Math.cos(q.ajar), s = Math.sin(q.ajar);
    const ax = [q.u[0] * c + q.n[0] * s, q.u[1] * c + q.n[1] * s], nx = [q.n[0] * c - q.u[0] * s, q.n[1] * c - q.u[1] * s];
    const rot = Math.atan2(ax[1], ax[0]);
    /** building-local (x, z) of the point `a` along the leaf from the hinge, `d` back from its room-side face */
    const pt = (a: number, d: number) => [q.hinge[0] - b.x + ax[0] * a - nx[0] * d, q.hinge[1] - b.z + ax[1] * a - nx[1] * d];
    /** a part along [a0, a1], [d0, d1] back (as doors.ts leafBoxes: the corridor face is the back one) */
    const part = (kind: FurnBox['kind'], a0: number, a1: number, d0: number, d1: number, y0: number, y1: number, skip: FurnBox['skip'] = ['bottom']) => {
      const [cx, cz] = pt((a0 + a1) / 2, (d0 + d1) / 2), ha = (a1 - a0) / 2, hd = (d1 - d0) / 2;
      render.push({ kind, x0: cx - ha, x1: cx + ha, z0: cz - hd, z1: cz + hd, y0: st.y + y0, y1: st.y + y1, rot, skip });
    };
    part('doorLeaf', D.gap, q.w - D.gap, D.inset, back, 0, q.h - D.gap, ['bottom', 'top']);
    part('knob', q.w - 0.2, q.w - 0.08, back, back + 0.05, 0.98, 1.02);
    part('steel', q.w - 0.17, q.w - 0.11, back, back + 0.008, 0.84, 0.96);
    part('knob', q.w - 0.2, q.w - 0.08, D.inset - 0.05, D.inset, 0.98, 1.02);
    // the collider: the turned slab's footprint (axis-aligned: near square it hugs the leaf; the pocket it boxes in
    // between the leaf and the side wall is nowhere anyone walks)
    const ps = [D.gap, q.w - D.gap].flatMap(a => [D.inset, back].map(d => pt(a, d)));
    solid.push({ x0: Math.min(...ps.map(p => p[0])), x1: Math.max(...ps.map(p => p[0])), z0: Math.min(...ps.map(p => p[1])), z1: Math.max(...ps.map(p => p[1])), y0: st.y, y1: st.y + q.h - D.gap });
  }
  return { render, solid };
}

/** Thickness of a closable door's slab (m): thinner than its 隔墙 (PART.t), so it sits inside the hole. */
export const CAMPUS_DOOR_T = 0.1;

/**
 * The closable doors of the campus: every door hole in a 隔墙 except the 办公室's unlocked ones (they stand open on their
 * leaf for good, officeLeafPlans). The index is the wire id (server and client both read the same order; the server's
 * copy is shared/campus/colliders.json). A keyed door starts locked. `y0`..`y1` = the hole's height span in world y.
 */
export function campusDoors(campus: { buildings: BuildingDef[] }): DoorSpot[] {
  const out: DoorSpot[] = [], seen = new Set<string>(), r3 = (v: number) => Math.round(v * 1000) / 1000;
  for (const b of campus.buildings) for (const st of floorStack(b)) for (const r of storeyRooms(b, st.level)) {
    if (OPEN.includes(r.kind)) continue;
    const R = rectOf(r);
    for (const d of r.doors ?? []) {
      if (r.kind === 'office' && !d.key) continue;
      const alongX = d.side[1] === 'z';
      const c = d.side === '+x' ? R.x1 : d.side === '-x' ? R.x0 : d.side === '+z' ? R.z1 : R.z0;
      if (Math.abs(Math.abs(c) - (alongX ? b.d : b.w) / 2) < 0.3) continue; // in the outer wall: an entrance, not a 隔墙 hole
      const mid = (alongX ? r.x : r.z) + d.at, h = d.height ?? PART.door.height;
      const x = alongX ? b.x + mid : b.x + c, z = alongX ? b.z + c : b.z + mid, hw = d.width / 2, ht = CAMPUS_DOOR_T / 2;
      const key = `${r3(x)},${r3(z)},${st.level}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const box = alongX ? { x0: x - hw, x1: x + hw, z0: z - ht, z1: z + ht } : { x0: x - ht, x1: x + ht, z0: z - hw, z1: z + hw };
      out.push({ id: out.length, x, z, alongX, box, y0: st.y, y1: st.y + h, locked: !!d.key });
    }
  }
  return out;
}
