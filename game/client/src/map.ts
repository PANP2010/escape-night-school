import { FLOOR_HEIGHT, floorStack, type BuildingDef, type CampusDef, type RoomDef } from '../../shared/campus/campus_schema.ts';
import type { ZonePhase } from '../../shared/royale.ts';
import type { LevelDef } from '../../shared/levels/def.ts';
import { storeyRooms } from './campus/world/rooms.ts';

/** 平面图 (M key / 地图 button): the level's storey of its building, north (+z) up, in world metres. */
export interface MapRect { x0: number; x1: number; z0: number; z1: number }
export interface MapFloor { level: number; y: number; h: number }
export interface MapRoom extends MapRect { id: string; name: string; kind: RoomDef['kind']; level: number; y: number }
/** Room indices stay stable across storey changes so exploration never ticks the room directly above/below. */
export interface LevelMap { area: MapRect; floors: MapFloor[]; rooms: MapRoom[]; route?: { x: number; y?: number; z: number }[] }

/** A room counts as the level's once this much of it lies in `def.area` (a classroom the area edge only grazes is not). */
const IN_AREA = 0.5;

/** The rooms, corridors and stairwells of `def`'s storey of `b`, clipped to `def.area`; rooms mostly outside it are left out. */
export function levelMap(def: LevelDef, b: BuildingDef): LevelMap {
  const a = def.area, area = { x0: a.x0, x1: a.x1, z0: a.z0, z1: a.z1 }, rooms: MapRoom[] = [];
  const masks = def.regions ?? [a];
  const floors = floorStack(b).filter((f) => def.floors.includes(f.level));
  const add = (id: string, name: string, kind: RoomDef['kind'], r: MapRect, floor: MapFloor) => {
    const cuts = masks.filter(m => floor.y >= m.y0 - 0.1 && floor.y <= m.y1).map(m => ({ x0: Math.max(r.x0, m.x0), x1: Math.min(r.x1, m.x1), z0: Math.max(r.z0, m.z0), z1: Math.min(r.z1, m.z1) }))
      .filter(c => c.x1 - c.x0 > 0.5 && c.z1 - c.z0 > 0.5);
    const covered = cuts.reduce((sum, c) => sum + (c.x1 - c.x0) * (c.z1 - c.z0), 0);
    if (covered < IN_AREA * (r.x1 - r.x0) * (r.z1 - r.z0)) return;
    const c = { x0: Math.min(...cuts.map(q => q.x0)), x1: Math.max(...cuts.map(q => q.x1)), z0: Math.min(...cuts.map(q => q.z0)), z1: Math.max(...cuts.map(q => q.z1)) };
    rooms.push({ id, name, kind, level: floor.level, y: floor.y, ...c });
  };
  const world = (r: { x: number; z: number; w: number; d: number }) =>
    ({ x0: b.x + r.x - r.w / 2, x1: b.x + r.x + r.w / 2, z0: b.z + r.z - r.d / 2, z1: b.z + r.z + r.d / 2 });
  for (const level of def.floors) {
    const floor = floors.find((f) => f.level === level);
    if (!floor) continue;
    for (const r of storeyRooms(b, level)) add(r.id, r.name, r.kind, world(r), floor);
    for (const s of b.stairwells ?? []) if (level >= s.from && level <= s.to) add(s.id, '楼梯', 'stairs', world(s), floor);
  }
  return { area, floors, rooms, ...(def.finale ? { route: def.finale.route } : {}) };
}

/** Royale's plan: the whole walled campus on one storey, each building a single named block (no interior, no doors). */
export function campusMap(c: CampusDef): LevelMap {
  const w = c.wall, floor: MapFloor = { level: 0, y: 0, h: FLOOR_HEIGHT };
  const rooms: MapRoom[] = c.buildings.map((b) => ({ id: b.id, name: b.name, kind: 'other', level: 0, y: 0, x0: b.x - b.w / 2, x1: b.x + b.w / 2, z0: b.z - b.d / 2, z1: b.z + b.d / 2 }));
  return { area: { x0: w.minX, x1: w.maxX, z0: w.minZ, z1: w.maxZ }, floors: [floor], rooms };
}

/** Nearest active storey to feet height; stair landings switch halfway between floors. Omitted height keeps single-storey callers compatible. */
export function mapFloorAt(m: LevelMap, y?: number): MapFloor | undefined {
  if (y === undefined || !Number.isFinite(y)) return m.floors[0];
  return m.floors.reduce<MapFloor | undefined>((best, f) => !best || Math.abs(f.y - y) < Math.abs(best.y - y) ? f : best, undefined);
}

/** Rooms that get a tick once someone has been in them (not the corridors / stairs you walk through anyway). */
export const tickable = (r: MapRoom) => r.kind !== 'corridor' && r.kind !== 'stairs';

/** Stable index of the tickable room at (x, feet y, z), -1 if none. */
export function roomAt(m: LevelMap, x: number, z: number, y?: number): number {
  const floor = mapFloorAt(m, y);
  return m.rooms.findIndex((r) => r.level === floor?.level && tickable(r) && x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1);
}

/** World → canvas (CSS px) for a w × h canvas with `pad` px kept free round the area: north up, east right. */
export function mapFit(area: MapRect, w: number, h: number, pad: number) {
  const s = Math.min((w - 2 * pad) / (area.x1 - area.x0), (h - 2 * pad) / (area.z1 - area.z0));
  const ox = (w - s * (area.x1 - area.x0)) / 2, oy = (h - s * (area.z1 - area.z0)) / 2;
  return { s, x: (x: number) => ox + (x - area.x0) * s, y: (z: number) => oy + (area.z1 - z) * s };
}

/** Canvas size (CSS px) for the area in a box of at most maxW × maxH: the area's aspect plus `pad` round it. */
export function mapSize(area: MapRect, maxW: number, maxH: number, pad: number) {
  const s = Math.min((maxW - 2 * pad) / (area.x1 - area.x0), (maxH - 2 * pad) / (area.z1 - area.z0));
  return { w: Math.round(s * (area.x1 - area.x0) + 2 * pad), h: Math.round(s * (area.z1 - area.z0) + 2 * pad) };
}

/** Canvas angle (rad, 0 = up/north, clockwise) of the way a player with `yaw` faces: yaw 0 looks along -z (south). */
export const headingOnMap = (yaw: number) => Math.atan2(-Math.sin(yaw), -Math.cos(yaw));

/** What moves on the plan: redrawn while it is open. Doors and barriers in world boxes, colours as CSS strings. */
export interface MapState {
  guidance?: boolean;
  /** Viewer's feet height, also supplied while spectating without a local player marker. */
  floorY?: number;
  me?: { x: number; y?: number; z: number; yaw: number };
  mates: { x: number; y?: number; z: number; name: string; color: string; down: boolean }[];
  explored: ReadonlySet<number>;
  doors: (MapRect & { y?: number; open: boolean; locked: boolean })[];
  barriers: (MapRect & { y?: number })[];
  exit: { x: number; y?: number; z: number; r: number };
  route?: readonly { x: number; y?: number; z: number }[];
  rollcall?: { x: number; y?: number; z: number };
  fuseBox?: { x: number; y?: number; z: number };
  gymSwitches?: { x: number; y?: number; z: number; active: boolean }[];
  /** Royale safe zone: the circle in force (solid) and the one after it (dashed preview). */
  zone?: { cur: ZonePhase; next?: ZonePhase };
}

const INK = '#e8e4d8', DIM = '#c9c4b4', GREEN = '#4fd08a', RED = '#ff5a4a', SLATE = '#0f1d17';

/** Keep the exit name outside its ring, toward the adjoining corridor and clear of the grate's cross. */
function exitLabelOffset(m: LevelMap, level: number | undefined, exit: MapState['exit'], radius: number, width: number, fs: number) {
  let dx = 1, dz = 0, nearest = Infinity;
  for (const room of m.rooms) {
    if (room.level !== level || room.kind !== 'corridor') continue;
    const x = Math.max(room.x0, Math.min(room.x1, exit.x)), z = Math.max(room.z0, Math.min(room.z1, exit.z));
    const d = (x - exit.x) ** 2 + (z - exit.z) ** 2;
    if (d >= nearest) continue;
    nearest = d;
    dx = d ? x - exit.x : (room.x0 + room.x1) / 2 - exit.x;
    dz = d ? z - exit.z : (room.z0 + room.z1) / 2 - exit.z;
  }
  return Math.abs(dx) >= Math.abs(dz)
    ? { x: Math.sign(dx || 1) * (radius + width / 2 + 6), y: 0 }
    : { x: 0, y: -Math.sign(dz) * (radius + fs / 2 + 6) };
}

/** Royale: shade everything outside the current circle, ring it solid, and ring the next circle dashed. Clipped to the plan. */
function drawZone(ctx: CanvasRenderingContext2D, area: MapRect, zone: NonNullable<MapState['zone']>, f: ReturnType<typeof mapFit>, fs: number) {
  const x0 = f.x(area.x0), y0 = f.y(area.z1), aw = (area.x1 - area.x0) * f.s, ah = (area.z1 - area.z0) * f.s;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, aw, ah);
  ctx.clip();
  const circle = (z: ZonePhase) => ctx.arc(f.x(z.center[0]), f.y(z.center[1]), z.radius * f.s, 0, Math.PI * 2);
  ctx.beginPath();
  ctx.rect(x0, y0, aw, ah);
  ctx.moveTo(f.x(zone.cur.center[0]) + zone.cur.radius * f.s, f.y(zone.cur.center[1]));
  circle(zone.cur);
  ctx.fillStyle = 'rgba(122, 22, 66, 0.42)';
  ctx.fill('evenodd');
  ctx.beginPath();
  circle(zone.cur);
  ctx.strokeStyle = '#8be8b4';
  ctx.lineWidth = 2.5;
  ctx.stroke();
  if (zone.next) {
    ctx.beginPath();
    circle(zone.next);
    ctx.setLineDash([7, 5]);
    ctx.strokeStyle = '#ffffffe6';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.setLineDash([]);
    const nx = f.x(zone.next.center[0]), ny = f.y(zone.next.center[1]);
    ctx.fillStyle = '#ffffffe6';
    ctx.beginPath();
    ctx.arc(nx, ny, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = `700 ${fs}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = SLATE;
    ctx.strokeText('下一圈', nx, ny - fs - 2);
    ctx.fillStyle = '#ffffff';
    ctx.fillText('下一圈', nx, ny - fs - 2);
  }
  ctx.restore();
}

/** Draws the plan into a w × h (CSS px) context already scaled for the device pixel ratio. */
export function drawMap(ctx: CanvasRenderingContext2D, m: LevelMap, st: MapState, w: number, h: number) {
  const f = mapFit(m.area, w, h, 14), X = f.x, Y = f.y, s = f.s;
  const floor = mapFloorAt(m, st.floorY ?? st.me?.y);
  const onFloor = (y?: number) => y === undefined || mapFloorAt(m, y)?.level === floor?.level;
  const rooms = [...m.rooms.entries()].filter(([, r]) => r.level === floor?.level);
  ctx.clearRect(0, 0, w, h);
  const rect = (r: MapRect) => [X(r.x0), Y(r.z1), (r.x1 - r.x0) * s, (r.z1 - r.z0) * s] as const;
  for (const [i, r] of rooms) {
    ctx.fillStyle = st.explored.has(i) ? '#4fd08a24' : tickable(r) ? '#e8e4d80c' : '#e8e4d81e';
    ctx.fillRect(...rect(r));
  }
  ctx.strokeStyle = '#e8e4d8a0';
  ctx.lineWidth = 1.5;
  for (const [, r] of rooms) ctx.strokeRect(...rect(r));
  // doors: a gap in the wall when open, a chalk bar when shut, red when locked
  for (const d of st.doors) {
    if (!onFloor(d.y)) continue;
    const [x, y, dw, dh] = rect(d), t = 4;
    const bx = dw > dh ? x : x + dw / 2 - t / 2, by = dw > dh ? y + dh / 2 - t / 2 : y, bw = dw > dh ? dw : t, bh = dw > dh ? t : dh;
    ctx.fillStyle = d.locked ? RED : d.open ? SLATE : INK;
    ctx.fillRect(bx, by, bw, bh);
    if (d.open) { ctx.fillStyle = '#4fd08a88'; ctx.fillRect(bx, by + bh / 2 - 0.5, bw, 1); }
  }
  for (const b of st.barriers) {
    if (!onFloor(b.y)) continue;
    const [x, y, bw, bh] = rect(b), c = { x: x + bw / 2, y: y + bh / 2 }, r = Math.max(4, Math.min(8, Math.max(bw, bh) / 3));
    ctx.strokeStyle = RED;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(c.x - r, c.y - r); ctx.lineTo(c.x + r, c.y + r); ctx.moveTo(c.x + r, c.y - r); ctx.lineTo(c.x - r, c.y + r);
    ctx.stroke();
  }
  // room names (the corridors go without), a tick in the rooms someone has been in
  const fs = Math.round(Math.max(10, Math.min(14, s * 0.8)));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const [i, r] of rooms) {
    if (r.kind === 'corridor') continue;
    const cx = X((r.x0 + r.x1) / 2), cy = Y((r.z0 + r.z1) / 2), seen = st.explored.has(i);
    ctx.font = `${fs}px sans-serif`;
    const tw = ctx.measureText(r.name).width, roomW = (r.x1 - r.x0) * s;
    if (tw < roomW - 4) { ctx.fillStyle = seen ? INK : DIM; ctx.fillText(r.name, cx, cy); }
    if (seen) { // in the room's top right corner: a player standing mid-room would hide it
      ctx.font = `700 ${Math.round(fs * 1.3)}px sans-serif`;
      ctx.fillStyle = GREEN;
      ctx.fillText('✓', X(r.x1) - fs * 0.9, Y(r.z1) + fs * 0.95);
    }
  }
  const label = (t: string, x: number, y: number, color: string, size = fs) => {
    ctx.font = `700 ${size}px sans-serif`;
    ctx.lineWidth = 3;
    ctx.strokeStyle = SLATE;
    ctx.strokeText(t, x, y);
    ctx.fillStyle = color;
    ctx.fillText(t, x, y);
  };
  // the exit: a dashed green ring; 停电关's 配电箱 a red square
  if (st.guidance !== false) {
  const ex = X(st.exit.x), ey = Y(st.exit.z), er = Math.max(8, st.exit.r * s * 0.6);
  if (onFloor(st.exit.y)) {
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = GREEN;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(ex, ey, er, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = `700 ${fs}px sans-serif`;
    const ep = exitLabelOffset(m, floor?.level, st.exit, er, ctx.measureText('出口').width, fs);
    label('出口', ex + ep.x, ey + ep.y, GREEN);
  } else {
    const exitFloor = mapFloorAt(m, st.exit.y);
    if (exitFloor) {
      const n = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'][Math.abs(exitFloor.level)] ?? String(Math.abs(exitFloor.level));
      label(`出口在${exitFloor.level < 0 ? `地下${n}层` : `${n}楼`}`, w / 2, 7, DIM, fs - 1);
    }
  }
  if (st.fuseBox && onFloor(st.fuseBox.y)) {
    const fx = X(st.fuseBox.x), fy = Y(st.fuseBox.z);
    ctx.fillStyle = RED;
    ctx.fillRect(fx - 5, fy - 5, 10, 10);
    label('配电箱', fx, fy + fs + 2, RED, fs - 1);
  }
  st.gymSwitches?.forEach((station, i) => {
    if (onFloor(station.y)) label(`${i + 1}${station.active ? '亮' : '待按'}`, X(station.x), Y(station.z), station.active ? GREEN : RED);
  });
  if (st.route?.length) {
    ctx.save();
    ctx.beginPath();
    st.route.forEach((p, i) => { const x = X(p.x), y = Y(p.z); if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.strokeStyle = '#64dc9b'; ctx.lineWidth = Math.max(2, s * 0.13); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.setLineDash([5, 4]); ctx.stroke(); ctx.setLineDash([]);
    const end = st.route[st.route.length - 1];
    label('逃生路线', X((st.route[0].x + end.x) / 2), Y((st.route[0].z + end.z) / 2), GREEN, fs - 1);
    ctx.restore();
  }
  if (st.rollcall && onFloor(st.rollcall.y)) {
    const x = X(st.rollcall.x), y = Y(st.rollcall.z);
    ctx.fillStyle = '#df665a'; ctx.fillRect(x - 5, y - 5, 10, 10);
    label('点名册', x, y - fs, '#ff9b83', fs - 1);
  }
  }
  if (st.zone) drawZone(ctx, m.area, st.zone, f, fs);
  for (const p of st.mates) {
    if (!onFloor(p.y)) continue;
    const px = X(p.x), py = Y(p.z);
    ctx.fillStyle = p.color;
    ctx.strokeStyle = p.down ? RED : INK;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(px, py, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    label(p.down ? `${p.name}（倒地）` : p.name, px, py - 14, p.down ? RED : INK, fs - 1);
  }
  if (st.me && onFloor(st.me.y)) { // a chalk arrowhead pointing the way you face
    const px = X(st.me.x), py = Y(st.me.z), a = headingOnMap(st.me.yaw), r = Math.max(9, fs);
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(a);
    ctx.beginPath();
    ctx.moveTo(0, -r); ctx.lineTo(r * 0.7, r * 0.75); ctx.lineTo(0, r * 0.35); ctx.lineTo(-r * 0.7, r * 0.75); ctx.closePath();
    ctx.fillStyle = INK;
    ctx.strokeStyle = SLATE;
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    label('你', px, py + r + fs * 0.6, INK, fs - 1);
  }
  const otherFloors = st.mates.filter((p) => !onFloor(p.y));
  if (otherFloors.length) {
    ctx.save();
    ctx.textAlign = 'left';
    otherFloors.forEach((p, i) => label(`${p.name} · ${mapFloorAt(m, p.y)?.level}F${p.down ? '（倒地）' : ''}`, 14, 14 + i * (fs + 5), p.down ? RED : INK, fs - 1));
    ctx.restore();
  }
}
