/** This nickname is a public testing shortcut, never an administrator credential. */
export const DEVELOPER_NAME = 'DEV-LOCAL#';
export const isDeveloperName = (name: string) => name === DEVELOPER_NAME;

export interface RoomOptions {
  /** Omitted by older clients: keep their existing navigation, and exclude their runs from ranking. */
  guidance?: boolean;
  developerMode?: boolean;
  /** Optional names and character variants. Normal rooms keep the original anonymous monitor. */
  namedMonitors?: boolean;
  mode?: 'campaign' | 'royale';
}

export type RunRanking = 'eligible' | 'guidance' | 'developer' | 'debug' | 'incomplete' | 'unescaped';
export function roomModeLabel(guidance = true, developerMode = false): string {
  return developerMode ? '开发者测试 · 不计排行' : guidance ? '指引开启 · 不计排行' : '指引关闭 · 可参与排行';
}
export function rankingNote(ranking: RunRanking): string {
  return {
    eligible: '已按服务器计时提交速通榜',
    guidance: '本局开启指引，不计入速通排行',
    developer: '开发者测试房间，不计入速通排行',
    debug: '本局使用过测试功能，不计入速通排行',
    incomplete: '本次未从第一关开始，不计入速通排行',
    unescaped: '全员离校后才可计入速通排行',
  }[ranking];
}
