import type { CatchSource, TeamCaughtMsg } from '../../shared/protocol.ts';

const catcherName = (by: CatchSource, name?: string) => by === 'monitor' ? name || '无脸值日生' : by === 'mirror' ? '镜中人' : '角色074';

/** The existing central downed overlay is the caught player's only capture text. */
export const caughtTitle = (by: CatchSource): string => `你被${catcherName(by)}抓住了`;

/** WebSocket messages are ordered; a room-wide sequence distinguishes a duplicate from the next real capture. */
export class TeamFeedback {
  private code = '';
  private episode = 0;

  reset() { this.code = ''; this.episode = 0; }

  /** Member updates, level changes and restarts keep the same sequence. A new room starts a fresh one. */
  enterRoom(code: string) {
    if (code === this.code) return;
    this.code = code;
    this.episode = 0;
  }

  notice(m: TeamCaughtMsg, myId: number, names: ReadonlyMap<number, string>): string | null {
    if (!Number.isSafeInteger(m.episode) || m.episode <= this.episode) return null;
    this.episode = m.episode;
    if (m.id === myId) return null;
    return `${names.get(m.id) ?? '队友'}被${catcherName(m.by, m.name)}抓住了`;
  }
}
