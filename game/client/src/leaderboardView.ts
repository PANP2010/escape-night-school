import { DIFFICULTY_MODES, type DifficultyId } from '../../shared/difficultyModes.ts';
import { speedrunTime, type LeaderboardResponse, type SpeedrunTeam } from '../../shared/leaderboard.ts';

/** Read-only public ranking; the game server alone submits a run on campaign completion. */
export class LeaderboardView {
  private readonly dialog: HTMLDialogElement;
  private readonly button: HTMLButtonElement;
  private readonly difficulty: HTMLSelectElement;
  private readonly team: HTMLSelectElement;
  private readonly status: HTMLParagraphElement;
  private readonly list: HTMLOListElement;
  private request?: AbortController;

  constructor() {
    this.button = document.createElement('button'); this.button.id = 'leaderboard-open'; this.button.type = 'button'; this.button.textContent = '速通榜';
    this.button.setAttribute('aria-haspopup', 'dialog'); this.button.setAttribute('aria-controls', 'leaderboard-dialog');
    this.dialog = document.createElement('dialog'); this.dialog.id = 'leaderboard-dialog';
    this.dialog.setAttribute('aria-labelledby', 'leaderboard-title');
    const header = document.createElement('header'), title = document.createElement('h2'); title.id = 'leaderboard-title'; title.textContent = '夜校速通榜';
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '返回'; close.onclick = () => this.dialog.close(); header.append(title, close);
    const filters = document.createElement('div'); filters.className = 'leaderboard-filters';
    const difficultyLabel = document.createElement('label'); difficultyLabel.textContent = '难度';
    this.difficulty = document.createElement('select'); this.difficulty.id = 'leaderboard-difficulty';
    for (const mode of DIFFICULTY_MODES) { const option = document.createElement('option'); option.value = mode.id; option.textContent = mode.name; this.difficulty.append(option); }
    difficultyLabel.append(this.difficulty);
    const teamLabel = document.createElement('label'); teamLabel.textContent = '队伍';
    this.team = document.createElement('select'); this.team.id = 'leaderboard-team';
    for (const [value, text] of [['solo', '单人'], ['team', '多人']]) { const option = document.createElement('option'); option.value = value; option.textContent = text; this.team.append(option); }
    teamLabel.append(this.team); filters.append(difficultyLabel, teamLabel);
    this.status = document.createElement('p'); this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
    this.list = document.createElement('ol'); this.list.className = 'leaderboard-list';
    const note = document.createElement('p'); note.className = 'records-note';
    note.textContent = '创建房间前关闭指引，从第一章开始，八章全员离校后自动入榜。开启指引或开发者测试均不入榜。服务器计时含过场、重试与断线时间；同时间按倒地次数排序。旧版成绩保留存档，新榜按关闭指引规则计分。';
    this.dialog.append(header, filters, this.status, this.list, note);
    (document.getElementById('lobby-records') ?? document.body).append(this.button); document.body.append(this.dialog);
    this.button.onclick = () => this.open();
    this.difficulty.onchange = this.team.onchange = () => { void this.refresh(); };
    this.dialog.addEventListener('close', () => this.request?.abort());
  }

  open(difficulty?: DifficultyId): void {
    if (difficulty) this.difficulty.value = difficulty;
    this.dialog.showModal(); void this.refresh();
  }
  dispose(): void { this.request?.abort(); this.button.remove(); this.dialog.remove(); }
  private async refresh(): Promise<void> {
    this.request?.abort(); const request = this.request = new AbortController();
    this.status.textContent = '正在读取云端成绩……'; this.list.replaceChildren();
    const difficulty = this.difficulty.value as DifficultyId, team = this.team.value as SpeedrunTeam;
    try {
      // Android bundles the page at night-school.local and selects a cloud/LAN server at launch.
      const nativeServer = location.hostname === 'night-school.local' ? new URLSearchParams(location.search).get('server') : null;
      const endpoint = new URL('/api/leaderboard', nativeServer || location.origin);
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('Invalid leaderboard server');
      endpoint.searchParams.set('difficulty', difficulty); endpoint.searchParams.set('team', team);
      const response = await fetch(endpoint, { signal: request.signal, cache: 'no-store' });
      if (!response.ok) throw new Error('榜单暂时不可用');
      const result = await response.json() as LeaderboardResponse;
      if (request !== this.request || request.signal.aborted) return;
      if (!Array.isArray(result.entries)) throw new Error('榜单暂时不可用');
      this.status.textContent = result.entries.length ? `最快的 ${result.entries.length} 次离校` : '还没有成绩，来留下第一条离校记录。';
      this.list.replaceChildren(...result.entries.slice(0, 20).map((entry, index) => {
        const row = document.createElement('li'), rank = document.createElement('span'), players = document.createElement('span'), time = document.createElement('strong');
        rank.className = 'run-rank'; rank.textContent = `${index + 1}`;
        players.className = 'run-players'; players.textContent = entry.players.join(' / ');
        time.textContent = speedrunTime(entry.elapsedMs);
        row.title = `${entry.downs} 次倒地 · ${new Date(entry.finishedAt).toLocaleDateString('zh-CN')}`;
        row.append(rank, players, time); return row;
      }));
    } catch {
      if (!request.signal.aborted) this.status.textContent = '暂时没能读取榜单，请稍后重新打开。';
    }
  }
}
