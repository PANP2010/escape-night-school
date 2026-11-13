import type { Vec3 } from './protocol.ts';

/** No password is included in snapshots: only digits that the team has actually read. */
export interface BroadcastSnap {
  t: 'broadcast'; off: boolean; clues: (string | null)[];
  nextIn: number; call: { id: number; left: number; shielded: boolean; p?: Vec3 } | null;
}
export type BroadcastClientMsg = { t: 'broadcast'; op: 'read'; id: number } | { t: 'broadcast'; op: 'code'; code: string };

export function parseBroadcast(o: Record<string, unknown>): BroadcastClientMsg | null {
  if (o.op === 'read' && Number.isInteger(o.id) && (o.id as number) >= 0 && (o.id as number) < 4) return { t: 'broadcast', op: 'read', id: o.id as number };
  if (o.op === 'code' && typeof o.code === 'string' && /^\d{4}$/.test(o.code)) return { t: 'broadcast', op: 'code', code: o.code };
  return null;
}
