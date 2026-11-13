import { mulberry32 } from './rng.ts';

/** Stable fictional identifiers shared by boards, monsters and capture messages. */
export const STUDENT_NAMES = Object.freeze([
  '角色117', '角色019', '角色047', '角色004', '角色079', '角色026', '角色091', '角色114',
  '角色041', '角色051', '角色016', '角色101', '角色116', '角色115', '角色119', '角色039',
  '角色060', '角色107', '角色008', '角色009', '角色010', '角色018', '角色022', '角色021',
  '值周代号025', '角色046', '角色133', '角色104', '角色078', '角色025', '角色073', '角色020',
  '角色001', '角色002', '角色044', '角色042', '角色100', '角色111', '角色055', '角色112', '角色103', '角色094',
] as const);

/** Normalize the retained anonymous legacy identifier without publishing original spellings. */
export const canonicalStudentName = (name: string): string => name === '角色072' ? '值周代号025' : name;

function shuffled(seed: number, key: string): string[] {
  let hash = seed >>> 0;
  for (const c of key) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619) >>> 0;
  const random = mulberry32(hash), names: string[] = [...STUDENT_NAMES];
  for (let i = names.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [names[i], names[j]] = [names[j], names[i]];
  }
  return names;
}

/** Room seeds vary between games; a monitor's identity stays fixed for every peer and same-seed retry. */
export function monitorDisplayName(seed: number, level: number, mobId: number): string {
  const names = shuffled(seed, `monitor:${level}`);
  return names[((Math.floor(mobId) - 2) % names.length + names.length) % names.length];
}

/** Draw without replacement. A board also rotates through a non-repeating roster over the school week. */
export function boardDutyNames(key: string, day: number, seed = 0, count = 4): string[] {
  const d = Math.max(0, Math.floor(day)), n = Math.max(0, Math.min(STUDENT_NAMES.length, Math.floor(count)));
  const names = shuffled(seed, `board:${key}:${Math.floor(d / 7)}`), start = (d % 7) * n;
  return Array.from({ length: n }, (_, i) => names[(start + i) % names.length]);
}

type CaptureName = { by: 'warden' | 'monitor' | 'mirror'; name?: string };
export function captorDisplayName(event: CaptureName): string {
  return event.by === 'monitor' ? canonicalStudentName(event.name ?? '值周生') : event.by === 'mirror' ? '镜中人' : '角色074';
}

/** The user's exact monitor defeat wording; other enemies keep their established capture wording. */
export function captureTitle(event: CaptureName): string {
  return `你被${captorDisplayName(event)}${event.by === 'monitor' ? '卷死了' : '抓住了'}`;
}
