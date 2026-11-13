// Wire protocol (JSON over WebSocket at /ws). See docs/design.md「协议」.
import { parseBroadcast, type BroadcastClientMsg, type BroadcastSnap } from './broadcast.ts';
import type { DoorSnap } from './doors.ts';
import type { LoopProgress } from './loop.ts';
import type { GymSnap, GymSound } from './gym.ts';
import { parseCampaignMirrorAct, type CampaignMirrorClientMsg, type CampaignMirrorSnap } from './l7-campaign.ts';
import { parseLobbyMsg, sanitizePlayerName, type LobbyClientMsg, type LobbySettings, type RoomsMsg } from './lobby.ts';
import type { ClearEvent, IntroEvent } from './intro.ts';
import type { DifficultyId } from './difficultyModes.ts';
import type { RunRanking } from './runMode.ts';

export type Vec3 = [number, number, number];

/** Input flag bits. */
export const F_CROUCH = 1;
export const F_RUN = 2;
export const F_LIGHT = 4;
/** Inside a locker / under a desk: invisible to Warden's sight and beam checks unless he watched them go in. */
export const F_HIDE = 8;

/** Player state. */
export const ST_OK = 0;
export const ST_DOWN = 1;
export const ST_SPECTATE = 2;

export type ClientMsg =
  | BroadcastClientMsg
  | CampaignMirrorClientMsg
  | { t: 'hello'; name: string; resume?: string }
  /** Application heartbeat, echoed by the client; WebSocket ping/pong separately proves the transport is alive. */
  | { t: 'heartbeat' }
  | LobbyClientMsg
  | { t: 'join'; code: string }
  | { t: 'start' }
  /** The host may restart a completed finale with the same seed. */
  | { t: 'restart' }
  /** Loaded this server-issued level incarnation. Its first ready / accepted input starts one personal spawn grace. */
  | { t: 'ready'; incarnation: number }
  /** Skip only this client's current intro; the server resumes once every participant skips or its deadline passes. */
  | { t: 'intro-skip'; id: number }
  /** `c`: the last authority epoch applied (`correct` or `warp`); older predicted inputs are look-only. */
  | { t: 'input'; seq: number; p: Vec3; yaw: number; pitch: number; f: number; c?: number }
  | { t: 'chat'; text: string }
  /** R: spend one bag battery to refill your own flashlight (server checks the bag). */
  | { t: 'use'; item: 'battery' }
  | { t: 'ping'; p: Vec3 }
  /** Toggle door `id` (open ↔ closed); the server checks reach and lock. */
  | { t: 'door'; id: number }
  /** E at the crosshair: `use` a door (id = door id), `pick` up a key (item id) or `revive` a downed teammate (player id); the server checks reach (ACT_REACH). */
  | { t: 'act'; kind: 'use' | 'pick' | 'revive' | 'hide' | 'unhide' | 'fuse' | 'gym-switch' | 'rollcall'; id: number }
  /** Host-only development shortcut to the fifth chapter. */
  | { t: 'debug'; op: 'level5' }
  /** Shared paper edits use the current authority revision and require standing beside the lectern. */
  | { t: 'exam'; op: 'answer'; question: number; choice: number; revision: number }
  | { t: 'exam'; op: 'submit'; revision: number }
  /** Release only the sender's matching revive hold. */
  | { t: 'act'; kind: 'revive_cancel'; id: number }
  /** Test commands: production accepts only the bound host of a dedicated developer room. */
  | { t: 'debug'; op: 'tp'; x: number; z: number; /** 0 = ground floor, -1 = basement, 1 = 2F …; default: the sender's current floor */ floor?: number }
  | { t: 'debug'; op: 'warden'; /** metres in front of the sender */ d?: number }
  | { t: 'debug'; op: 'monitor'; /** metres in front of the sender */ d?: number }
  | { t: 'debug'; op: 'boss' }
  | { t: 'debug'; op: 'down'; s?: number }
  /** NPCs ignore every player for s seconds (e2e that walks around without being caught); mob 1: only 角色074 does (the 值日生 still hunts) */
  | { t: 'debug'; op: 'safe'; s?: number; mob?: 1 | 2 }
  | { t: 'debug'; op: 'key'; /** door id; default: the first locked door; -1 = the stairwell key; -2 = the fuses still missing (停电关) */ door?: number }
  /** 跳闸 now around the sender, lights out for s seconds (default 8); s = 0 cancels the current trip. */
  | { t: 'debug'; op: 'power'; s?: number }
  | { t: 'debug'; op: 'level'; level: number };

/** A world pickup or L1 locked drawer. `door` names a door-key lock; optional props never grant inventory. */
export interface WorldItem { id: number; kind: 'door_key' | 'stair_key' | 'drawer_key' | 'battery' | 'fuse'; door?: number; p: Vec3; decoy?: boolean; label?: string }
/** The team's shared bag: how many of each non-door-key item have been picked up. */
export type Bag = Partial<Record<WorldItem['kind'], number>>;

/** A completed action confirmed by the room. No target id / position: the team panel must not reveal a hiding place. */
export type TeamActivityEvent =
  | { t: 'activity'; from: number; kind: 'open' | 'close' | 'revive' }
  | { t: 'activity'; from: number; kind: 'pick'; item: WorldItem['kind'] };

export type CatchSource = 'warden' | 'monitor' | 'mirror';
/** One capture in a room's lifetime. Only the caught player's teammates receive it. */
export interface TeamCaughtMsg { t: 'team-caught'; id: number; by: CatchSource; episode: number; name?: string }
export interface PlayerInfo { id: number; name: string; online?: false }
export interface PlayerSnap { id: number; p: Vec3; yaw: number; pitch?: number; online?: false; /** input flags; omitted = unchanged (re-sent every second) */ f?: number; /** omitted = ST_OK */ st?: number; /** Authoritative tick when a downed player's rescue window expires. */ downUntil?: number; /** The player reached the final gate and is safe. */ escaped?: boolean; /** flashlight charge 0..1 (own value matters to the client); omitted = unchanged */ bat?: number; /** stamina 0..1 (own value matters); omitted = unchanged */ sta?: number }

/** Sent only to the player actually touched by a mob, before the forced spawn correction.
 * `seq` increases across level loads; `at` / `source` are feet positions at the instant of contact, never interpolated. */
export interface CaughtEvent { t: 'caught'; id: number; seq: number; tick: number; hold: number; by: CatchSource; /** Actual monitor identity, copied before the forced correction. */ mob?: number; name?: string; at: Vec3; source: Vec3 }
/** A monster. `form` is its look variant ('normal', ...), `anim` its action clip ('patrol', ...); both free strings until the AI lands. */
/** kind / form / anim / st / target are sent only when changed (plus a keyframe every MOB_KEY_TICKS); the client keeps the last value. */
export interface MobSnap { id: number; /** Display name; omitted = unchanged. */ name?: string; kind?: string; form?: string; /** omitted = unchanged */ anim?: string; p: Vec3; yaw: number; /** 1 while holding a caught player (omitted = unchanged) */ st?: number; /** player id it chases / holds (0 = none; omitted = unchanged) */ target?: number }

/** A randomly named 值周代号025 monitor's telegraphed attack. Positions lock when the windup begins. */
export interface BossSnap {
  id: number; name: '值周代号025'; phase: 'rest' | 'windup' | 'active' | 'recover';
  skill: 'chalk-circle' | 'rollcall-sweep'; origin: Vec3; target: Vec3;
  remaining: number; radius: number; length: number; width: number;
}

export type ServerMsg =
  | BroadcastSnap
  | GymSnap | GymSound
  | CampaignMirrorSnap
  | RoomsMsg
  | TeamActivityEvent
  /** Authoritative per-player puzzle state, full table on join / change. */
  | { t: 'loop'; players: ({ id: number } & LoopProgress)[] }
  /** A loop seam is a world translation, not a rejected input. All peers discard old interpolation samples. */
  | { t: 'warp'; id: number; p: Vec3; c: number; yaw: number }
  /** End of the currently available chapters; do not manufacture a later chapter by clamping its definition. */
  | { t: 'complete'; level: number }
  | { t: 'welcome'; id: number; token?: string; resumed?: boolean; resumeFailed?: boolean; /** Original socket has not closed yet: retry without discarding its token. */ resumePending?: boolean }
  | { t: 'heartbeat' }
  /** Restored down timer, without replaying the capture effects. Zero when not downed. */
  | { t: 'resume'; downLeft: number }
  | ({ t: 'room'; code: string; host: number; guidance?: boolean; developerMode?: boolean; namedMonitors?: boolean; mode?: 'campaign' | 'royale'; started: boolean; level: number; seed: number; difficulty?: DifficultyId; incarnation: number; players: PlayerInfo[] } & Partial<LobbySettings>)
  | { t: 'snap'; tick: number; difficulty?: DifficultyId; boss?: BossSnap; players: PlayerSnap[]; mobs: MobSnap[]; doors?: DoorSnap[]; gone?: number[]; zone?: { phase: number; center: [number, number]; radius: number; remainingMs: number; alive: number } }
  /** Full door table, sent to a player right after they join. */
  | { t: 'doors'; doors: DoorSnap[] }
  /** Items still lying around (full list, sent on join; pick-ups follow as `snap.gone`). */
  | { t: 'items'; items: WorldItem[] }
  /** Door ids the team holds keys for (shared; sent on join and on change). */
  | { t: 'keys'; keys: number[] }
  /** The team's bag (sent on join and on change). */
  | { t: 'bag'; bag: Bag }
  /** 停电关 fuse box: how many fuses are back in (power is on when n reaches the level's need). */
  | { t: 'power'; n: number }
  /** Full shared paper, also sent on join. Remaining times are seconds; floor is zero-based (3 = 4F). */
  | { t: 'exam'; answers: (number | null)[]; passed: boolean; revision: number; cooldown: number; feedback: string; blackout?: { floor: number; seconds: number } }
  /** The level area's nav graph for the 目标箭头 (sent after 'room'): x, y, z per node flat (cm), `adj` its links. */
  | { t: 'nav'; n: number[]; adj: number[][] }
  /** Snap the player to `p`. `forced`: the server moved them (spawn, caught, debug tp, frozen) rather than rejecting a predicted input.
   *  `c`: the new correction epoch for the client to echo in its inputs; `ack`: the rejected input's seq (later moves get replayed). */
  | { t: 'correct'; p: Vec3; c?: number; ack?: number; forced?: true; /** Flags accompanying an authoritative relocation, applied before the next input. */ f?: number }
  /** A real local capture; snapshots and debug down never manufacture this event. */
  | CaughtEvent
  /** Short teammate notice; episode is room-wide and independent of the victim's capture seq. */
  | TeamCaughtMsg
  /** 无脸值日生 level: everyone blinks, screen black for `secs`. */
  | { t: 'blink'; secs: number }
  /** 跳闸: the 日光灯 stutter for `omen` s, then die outward from `at` (x, z) and stay out `off` s before they buzz back; omen = off = 0: lights on now */
  | { t: 'trip'; at: [number, number]; omen: number; off: number }
  | { t: 'chat'; from: number; text: string }
  | { t: 'ping'; from: number; p: Vec3 }
  /** 角色074 says a line (text from shared/lines.ts); `mob` = the speaking mob id, whose position the client uses for distance. */
  | LineEvent
  | FinaleState
  | CompletionStats
  | IntroEvent
  | ClearEvent
  /** Level over: black screen for `secs`, then a fresh 'room' (next level, or the same one when `restart`). */
  | { t: 'fade'; secs: number; restart: boolean }
  | { t: 'error'; msg: string }
  | { t: 'royale-eliminated'; id: number; rank: number; alive: number }
  | { t: 'royale-settle'; ranking: { id: number; rank: number }[] };

export interface LineEvent { t: 'event'; kind: 'line'; id: string; text: string; mob: number }

/** Authoritative 第 8 关 roll-call / chase state. `revision` changes whenever a member or phase changes. */
export type FinalePhase = 'rollcall' | 'chase' | 'complete';
export type FinaleMemberStatus = 'playing' | 'down' | 'out' | 'escaped' | 'left';
export interface FinaleMember { id: number; name: string; crossedOut: boolean; status: FinaleMemberStatus; downs: number }
export interface FinaleState {
  t: 'finale'; revision: number; phase: FinalePhase; members: FinaleMember[];
  elapsedMs: number; downs: number; /** unassisted chase deadline in milliseconds from now; rescueMs supersedes it after first extraction */
  remainingMs?: number;
  /** present after the first escape: remaining team extraction window; standing stragglers also time out */
  rescueMs?: number;
}
export interface CompletionStats {
  t: 'completed'; elapsedMs: number; downs: number; difficulty?: DifficultyId;
  ranking?: RunRanking;
  /** Earned only by a genuine complete nightmare campaign; the local escaped member may save the cosmetic unlock. */
  namedMonitorsUnlocked?: boolean;
  members: Array<{ id: number; name: string; downs: number; escaped: boolean }>;
}

/** Validate an untrusted-shape server event (client side, before showing it). */
export function isLineEvent(m: unknown): m is LineEvent {
  if (!m || typeof m !== 'object') return false;
  const o = m as Record<string, unknown>;
  return o.t === 'event' && o.kind === 'line' && typeof o.id === 'string' && typeof o.text === 'string' && o.text.length > 0 && o.text.length <= 100
    && Number.isInteger(o.mob);
}

export const encode = (m: ClientMsg | ServerMsg): string => JSON.stringify(m);

/** Parse an untrusted client message; returns null for anything malformed. */
export function parseClientMsg(raw: string): ClientMsg | null {
  let m: unknown;
  try { m = JSON.parse(raw); } catch { return null; }
  if (!m || typeof m !== 'object') return null;
  const o = m as Record<string, unknown>;
  const isVec = (v: unknown): v is Vec3 =>
    Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
  const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  switch (o.t) {
    case 'broadcast': return parseBroadcast(o);
    case 'hello': return typeof o.name === 'string' && (o.resume === undefined || (typeof o.resume === 'string' && /^[A-Za-z0-9_-]{43}$/.test(o.resume)))
      ? { t: 'hello', name: sanitizePlayerName(o.name), ...(o.resume === undefined ? {} : { resume: o.resume as string }) } : null;
    case 'heartbeat': return { t: 'heartbeat' };
    case 'list':
    case 'quick':
    case 'create': return parseLobbyMsg(o);
    case 'start': return { t: 'start' };
    case 'restart': return { t: 'restart' };
    case 'ready': return Number.isSafeInteger(o.incarnation) && (o.incarnation as number) > 0 ? { t: 'ready', incarnation: o.incarnation as number } : null;
    case 'intro-skip': return Number.isSafeInteger(o.id) && (o.id as number) > 0 ? { t: 'intro-skip', id: o.id as number } : null;
    case 'join': return typeof o.code === 'string' ? { t: 'join', code: o.code.replace(/\s+/g, '').toUpperCase().slice(0, 8) } : null;
    case 'input':
      if (o.c !== undefined && (!Number.isSafeInteger(o.c) || (o.c as number) < 0)) return null;
      return isNum(o.seq) && Number.isSafeInteger(o.seq) && o.seq >= 0 && isVec(o.p) && isNum(o.yaw) && isNum(o.pitch) && isNum(o.f)
        ? { t: 'input', seq: o.seq, p: o.p, yaw: o.yaw, pitch: o.pitch, f: o.f | 0, ...(Number.isInteger(o.c) ? { c: o.c as number } : {}) } : null;
    case 'chat': return typeof o.text === 'string' && o.text.trim() ? { t: 'chat', text: o.text.trim().slice(0, 200) } : null;
    case 'use': return o.item === 'battery' ? { t: 'use', item: 'battery' } : null;
    case 'door': return Number.isInteger(o.id) && (o.id as number) >= 0 ? { t: 'door', id: o.id as number } : null;
    case 'act':
      if (o.kind === 'mirror-push' || o.kind === 'mirror-key') return parseCampaignMirrorAct(o);
      return (o.kind === 'use' || o.kind === 'pick' || o.kind === 'revive' || o.kind === 'revive_cancel' || o.kind === 'hide' || o.kind === 'unhide' || o.kind === 'fuse' || o.kind === 'gym-switch' || o.kind === 'rollcall') && Number.isInteger(o.id) && (o.id as number) >= 0
        ? { t: 'act', kind: o.kind, id: o.id as number } : null;
    case 'exam': {
      if (!Number.isSafeInteger(o.revision) || (o.revision as number) < 0) return null;
      if (o.op === 'submit') return { t: 'exam', op: 'submit', revision: o.revision as number };
      return o.op === 'answer' && Number.isInteger(o.question) && (o.question as number) >= 0 && (o.question as number) < 5
        && Number.isInteger(o.choice) && (o.choice as number) >= 0 && (o.choice as number) < 4
        ? { t: 'exam', op: 'answer', question: o.question as number, choice: o.choice as number, revision: o.revision as number } : null;
    }
    case 'debug': {
      if (o.op === 'level5') return { t: 'debug', op: 'level5' };
      if (o.op === 'boss') return { t: 'debug', op: 'boss' };
      const opt = (v: unknown) => v === undefined || isNum(v);
      if (o.op === 'tp') return isNum(o.x) && isNum(o.z) && opt(o.floor) ? { t: 'debug', op: 'tp', x: o.x, z: o.z, floor: o.floor as number | undefined } : null;
      if (o.op === 'warden') return opt(o.d) ? { t: 'debug', op: 'warden', d: o.d as number | undefined } : null;
      if (o.op === 'monitor') return opt(o.d) ? { t: 'debug', op: 'monitor', d: o.d as number | undefined } : null;
      if (o.op === 'down') return opt(o.s) ? (o.s === undefined ? { t: 'debug', op: 'down' } : { t: 'debug', op: 'down', s: o.s as number }) : null;
      if (o.op === 'safe') return opt(o.s) && (o.mob === undefined || o.mob === 1 || o.mob === 2) ? { t: 'debug', op: 'safe', ...(o.s === undefined ? {} : { s: o.s as number }), ...(o.mob === undefined ? {} : { mob: o.mob as 1 | 2 }) } : null;
      if (o.op === 'power') return opt(o.s) ? (o.s === undefined ? { t: 'debug', op: 'power' } : { t: 'debug', op: 'power', s: o.s as number }) : null;
      if (o.op === 'level') return Number.isInteger(o.level) && (o.level as number) >= 0 && (o.level as number) <= 7 ? { t: 'debug', op: 'level', level: o.level as number } : null;
      if (o.op === 'key') return opt(o.door) ? { t: 'debug', op: 'key', door: o.door as number | undefined } : null;
      return null;
    }
    case 'ping': return isVec(o.p) ? { t: 'ping', p: o.p } : null;
    default: return null;
  }
}
