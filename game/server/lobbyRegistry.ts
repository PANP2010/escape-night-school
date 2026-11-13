import { maxPlayers } from '../shared/constants.ts';
import { sanitizePlayerName, type LobbySettings, type PublicRoom } from '../shared/lobby.ts';
import type { ClientMsg } from '../shared/protocol.ts';
import type { Conn, Room } from './room.ts';
import type { DifficultyId } from '../shared/difficultyModes.ts';
import { isDeveloperName, type RoomOptions } from '../shared/runMode.ts';

export const LOBBY_LIST_GAP_MS = 1000;
/** Create and quick share a budget, so alternating them cannot create a room flood. */
export const LOBBY_MATCH_GAP_MS = 1000;

type LobbyRoom = Pick<Room, 'code' | 'players' | 'host' | 'started' | 'completed' | 'levelIndex' | 'difficulty' | 'guidance' | 'developerMode' | 'namedMonitors' | 'mode' | 'full' | 'add' | 'broadcastRoom'>
  & { lobbySettings?: LobbySettings };
interface RoomDirectory {
  readonly rooms: ReadonlyMap<string, LobbyRoom>;
  create(lobby: boolean, initialLevel: number, difficulty?: DifficultyId, options?: RoomOptions): LobbyRoom;
  get(code: string): LobbyRoom | undefined;
}
interface RateState { list?: number; match?: number }

/** Server-owned discovery, matching and admission. Private room codes never enter discovery responses. */
export class LobbyRegistry {
  private readonly directory: RoomDirectory;
  private readonly rates = new WeakMap<Conn, RateState>();

  constructor(directory: RoomDirectory) { this.directory = directory; }

  list(): PublicRoom[] {
    const result: PublicRoom[] = [];
    for (const room of this.directory.rooms.values()) {
      // Empty rooms remain in RoomManager for their TTL, but must never be rediscovered or matched.
      if (!room.lobbySettings?.public || room.developerMode || !room.players.size || room.completed) continue;
      const allowLateJoin = room.lobbySettings.allowLateJoin;
      result.push({ code: room.code, name: `${sanitizePlayerName(room.players.get(room.host)?.conn.name ?? '无名')}的教室`,
        n: room.players.size, max: maxPlayers(room.mode), mode: room.mode, level: room.levelIndex, state: room.started ? 'playing' : 'waiting',
        allowLateJoin, difficulty: room.difficulty, guidance: room.guidance, namedMonitors: room.namedMonitors, joinable: !room.full && (!room.started || allowLateJoin) });
    }
    return result.sort((a, b) => Number(a.state === 'playing') - Number(b.state === 'playing') || b.n - a.n || a.code.localeCompare(b.code));
  }

  /** Return true only for lobby messages, leaving gameplay and reconnect routing to the existing server. */
  handle(conn: Conn, m: ClientMsg, now: number, initialLevel = 0): boolean {
    switch (m.t) {
      case 'list': {
        if (!this.allow(conn, 'list', now, LOBBY_LIST_GAP_MS)) {
          this.error(conn, '刷新太快，请稍后重试');
          return true;
        }
        conn.send({ t: 'rooms', rooms: this.list() });
        return true;
      }
      case 'create':
      case 'quick': {
        if (!this.allow(conn, 'match', now, LOBBY_MATCH_GAP_MS)) {
          this.error(conn, '操作太快，请稍后重试');
          return true;
        }
        const developerMode = isDeveloperName(conn.name), guidance = m.guidance !== false, namedMonitors = m.namedMonitors === true, mode = m.mode ?? 'campaign';
        if (m.t === 'quick' && !developerMode) {
          // Old clients may join rooms created by new server or vice versa: `mode` undefined matches `mode: 'campaign'`.
          const modeMatch = (roomMode: 'campaign' | 'royale' | undefined) => (roomMode ?? 'campaign') === mode;
          const candidate = this.list().find((room) => room.state === 'waiting' && room.joinable && room.guidance === guidance &&
            room.namedMonitors === namedMonitors && modeMatch(room.mode) && (m.difficulty === undefined || room.difficulty === m.difficulty));
          if (candidate) {
            this.join(conn, candidate.code, now);
            return true;
          }
        }
        // Create succeeds before leaving an old room. A failed admission must not evict that player.
        let room: LobbyRoom;
        try { room = this.directory.create(true, initialLevel, m.difficulty, { guidance, developerMode, namedMonitors, mode }); }
        catch (error) {
          this.error(conn, error instanceof Error && error.message === '房间数量已满，请稍后再试'
            ? error.message : '创建房间失败，请稍后重试');
          return true;
        }
        room.lobbySettings = { public: !developerMode && (m.t === 'quick' || m.public === true), allowLateJoin: m.t === 'quick' || m.allowLateJoin !== false };
        this.enter(conn, room, now);
        return true;
      }
      case 'join':
        this.join(conn, m.code, now);
        return true;
      default: return false;
    }
  }

  private join(conn: Conn, code: string, now: number) {
    const room = this.directory.get(code);
    if (!room) return this.error(conn, '房间不存在');
    if (isDeveloperName(conn.name) && !room.developerMode) return this.error(conn, '开发者昵称请创建专用测试房间；使用普通昵称可加入此房间');
    if (conn.room === room) { room.broadcastRoom(); return; }
    if (!room.players.size) return this.error(conn, '房间已关闭');
    if (room.completed) return this.error(conn, '房间已通关，请创建新房间');
    if (room.full) return this.error(conn, '房间已满');
    if (room.started && room.lobbySettings?.allowLateJoin === false) return this.error(conn, '本房间不允许中途加入');
    this.enter(conn, room, now);
  }

  private enter(conn: Conn, room: LobbyRoom, now: number) {
    if (conn.room === room) { room.broadcastRoom(); return; }
    conn.room?.remove(conn, now);
    room.add(conn, now);
  }

  private allow(conn: Conn, key: keyof RateState, now: number, gap: number): boolean {
    let state = this.rates.get(conn);
    if (!state) { state = {}; this.rates.set(conn, state); }
    const last = state[key];
    if (last !== undefined && now - last < gap) return false;
    state[key] = now;
    return true;
  }

  private error(conn: Conn, msg: string) { conn.send({ t: 'error', msg }); }
}
