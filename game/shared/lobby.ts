import { isDifficultyId, type DifficultyId } from './difficultyModes.ts';
export type GameMode = 'campaign' | 'royale';

/** Public lobby metadata. `level` follows the game's zero-based room level index. */
export interface PublicRoom {
  code: string;
  name: string;
  n: number;
  max: number;
  level: number;
  state: 'waiting' | 'playing';
  allowLateJoin: boolean;
  joinable: boolean;
  difficulty?: DifficultyId;
  guidance?: boolean;
  namedMonitors?: boolean;
  mode?: GameMode;
}

export interface LobbySettings {
  public: boolean;
  allowLateJoin: boolean;
}

export type LobbyClientMsg =
  | { t: 'list' }
  | { t: 'quick'; difficulty?: DifficultyId; guidance?: boolean; namedMonitors?: boolean; mode?: GameMode }
  /** Existing clients without `public` keep creating private rooms. */
  | { t: 'create'; public?: boolean; allowLateJoin?: boolean; difficulty?: DifficultyId; guidance?: boolean; namedMonitors?: boolean; mode?: GameMode };

export interface RoomsMsg { t: 'rooms'; rooms: PublicRoom[] }

/** Reject malformed settings instead of interpreting truthy untrusted values as public. */
export function parseLobbyMsg(o: Record<string, unknown>): LobbyClientMsg | null {
  if (o.t === 'list') return { t: 'list' };
  if (o.guidance !== undefined && typeof o.guidance !== 'boolean') return null;
  if (o.namedMonitors !== undefined && typeof o.namedMonitors !== 'boolean') return null;
  if (o.mode !== undefined && o.mode !== 'campaign' && o.mode !== 'royale') return null;
  const guidance = o.guidance === undefined ? {} : { guidance: o.guidance as boolean };
  const namedMonitors = o.namedMonitors === undefined ? {} : { namedMonitors: o.namedMonitors as boolean };
  const mode = o.mode === undefined ? {} : { mode: o.mode as GameMode };
  if (o.difficulty !== undefined && !isDifficultyId(o.difficulty)) return null;
  if (o.t === 'quick') return { t: 'quick', ...guidance, ...namedMonitors, ...mode, ...(o.difficulty === undefined ? {} : { difficulty: o.difficulty as DifficultyId }) };
  if (o.t !== 'create' || (o.public !== undefined && typeof o.public !== 'boolean')
    || (o.allowLateJoin !== undefined && typeof o.allowLateJoin !== 'boolean')) return null;
  return { t: 'create', ...guidance, ...namedMonitors, ...mode, ...(o.public === undefined ? {} : { public: o.public as boolean }),
    ...(o.allowLateJoin === undefined ? {} : { allowLateJoin: o.allowLateJoin as boolean }),
    ...(o.difficulty === undefined ? {} : { difficulty: o.difficulty as DifficultyId }) };
}

/** Names appear in shared room titles: remove controls, direction overrides and markup delimiters. */
export function sanitizePlayerName(name: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff<>]/g, '')
    .replace(/\s+/g, ' ').trim();
  return Array.from(clean).slice(0, 16).join('') || '无名';
}
