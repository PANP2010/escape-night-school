import type { ClientMsg, ServerMsg } from '../../shared/protocol.ts';
import type { PublicRoom, GameMode } from '../../shared/lobby.ts';
import { difficultyMode, type DifficultyId } from '../../shared/difficultyModes.ts';
import { isDeveloperName, roomModeLabel } from '../../shared/runMode.ts';

const REFRESH_MS = 3_000;
const MIN_REFRESH_MS = 1_050; // The server accepts at most one list request per second.
const RESPONSE_TIMEOUT_MS = 8_000;
const DISCONNECTED_MESSAGE = '与服务器断开连接，请刷新重连';
type PendingAction = 'create' | 'join' | 'quick';

/** Room levels on the wire are zero based; the directory always speaks in player-facing levels. */
export function roomPresentation(room: PublicRoom) {
  const full = room.n >= room.max;
  const joinable = room.joinable && !full && (room.state === 'waiting' || room.allowLateJoin);
  // Royale runs one continuous round of shrinking zones, so a level counter would mean nothing there.
  const royale = room.mode === 'royale';
  return {
    count: `${room.n}/${room.max}`,
    state: room.state === 'waiting' ? '等待中'
      : royale ? '进行中' : `第 ${room.level + 1} 关进行中`,
    joinable,
    action: full ? '已满员' : !joinable ? '不可加入' : room.state === 'playing' ? '观察加入' : '加入教室',
    note: full ? '教室已满，请选其他房间' : room.state === 'playing'
      ? room.allowLateJoin ? royale ? '观察加入，仅观察本局' : '观察加入，下一关参与' : '房主已关闭中途加入'
      : '等待房主开始',
  };
}

export function normalizeRoomCode(value: string) { return value.replace(/\s+/g, '').toUpperCase().slice(0, 4); }
export function lobbyLatency(ms: number | null) { return ms === null ? '大厅往返 —' : `大厅往返 ${Math.max(1, Math.round(ms))} ms`; }

interface RoomRow {
  root: HTMLLIElement;
  name: HTMLElement;
  count: HTMLElement;
  state: HTMLElement;
  latency: HTMLElement;
  note: HTMLElement;
  join: HTMLButtonElement;
}

/** Directory UI only. Socket lifecycle and the in-level game remain owned by main/Net. */
export class PublicLobby {
  private readonly byCode = new Map<string, RoomRow>();
  private readonly $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  private readonly timer: ReturnType<typeof setInterval>;
  private requestTimeout: ReturnType<typeof setTimeout> | undefined;
  private actionTimeout: ReturnType<typeof setTimeout> | undefined;
  private refreshCooldown: ReturnType<typeof setTimeout> | undefined;
  private pending: PendingAction | null = null;
  private requestAt: number | null = null;
  private lastRequestAt = -Infinity;
  private latency: number | null = null;
  private inRoom = false;
  private disconnected = false;
  private connected = false;
  private hasList = false;
  private rooms: PublicRoom[] = [];
  private readonly send: (m: ClientMsg) => void;
  private readonly hello: () => void;
  private readonly selectedDifficulty?: () => DifficultyId;
  private readonly getNamedMonitors: () => boolean;
  private readonly visibilityChanged = () => { if (!document.hidden) this.refresh(); };

  constructor(send: (m: ClientMsg) => void, hello: () => void, selectedDifficulty?: () => DifficultyId, getNamedMonitors: () => boolean = () => false) {
    this.send = send; this.hello = hello; this.selectedDifficulty = selectedDifficulty; this.getNamedMonitors = getNamedMonitors;
    const guidance = this.$<HTMLInputElement>('guidance');
    const modeSelector = this.$<HTMLSelectElement>('mode-selector');
    try { guidance.checked = localStorage.getItem('escape.guidance') !== '0'; } catch { guidance.checked = true; }
    try { const m = localStorage.getItem('escape.mode'); if (m === 'royale') modeSelector.value = 'royale'; } catch { modeSelector.value = 'campaign'; }
    guidance.onchange = () => {
      try { localStorage.setItem('escape.guidance', guidance.checked ? '1' : '0'); } catch { /* Optional preference storage. */ }
      this.updateGuidance();
    };
    modeSelector.onchange = () => {
      try { localStorage.setItem('escape.mode', modeSelector.value); } catch { /* Optional preference storage. */ }
      this.updateModeHint();
    };
    this.$<HTMLInputElement>('name').addEventListener?.('input', () => this.updateGuidance());
    this.updateGuidance();
    this.updateModeHint();
    this.$('create').onclick = () => this.enter('create');
    this.$('join').onclick = () => this.enter('join');
    this.$('quick-join').onclick = () => this.enter('quick');
    this.$('refresh-rooms').onclick = () => this.refresh();
    this.$('reconnect-lobby').onclick = () => location.reload();
    const code = this.$<HTMLInputElement>('code');
    code.oninput = () => { code.value = normalizeRoomCode(code.value); };
    code.onkeydown = (event) => { if (event.key === 'Enter') { event.preventDefault(); this.enter('join'); } };
    for (const id of ['visibility-public', 'visibility-private']) this.$(id).onchange = () => this.updateVisibility();
    this.updateVisibility();
    document.addEventListener('visibilitychange', this.visibilityChanged);
    this.timer = setInterval(() => {
      if (!document.hidden && !this.inRoom && !this.disconnected && !this.pending) this.refresh();
    }, REFRESH_MS);
    this.updateControls();
  }

  /** Returns true only when this UI fully consumes a message. */
  onMessage(m: ServerMsg): boolean {
    if (m.t === 'welcome') {
      // A recovered lobby receives no room message to clear the old warning.
      // Preserve independent room/session errors that may have arrived since the loss.
      if (this.disconnected && this.$('err').textContent === DISCONNECTED_MESSAGE) this.$('err').textContent = '';
      this.connected = true; this.disconnected = false;
      this.$('reconnect-lobby').hidden = true;
      this.renderConnection(); this.updateControls();
      if (!this.inRoom) this.refresh();
    } else if (m.t === 'rooms') {
      if (this.inRoom || this.disconnected) return true;
      // One list request is outstanding at a time; this is the current connection's RTT, not a room ping.
      if (this.requestAt !== null) this.latency = performance.now() - this.requestAt;
      this.requestAt = null; clearTimeout(this.requestTimeout);
      this.connected = true; this.hasList = true; this.rooms = m.rooms;
      this.$('public-rooms').setAttribute('aria-busy', 'false');
      this.$('public-rooms').dataset.state = m.rooms.length ? 'ready' : 'empty';
      this.$('rooms-status').textContent = m.rooms.length ? `${m.rooms.length} 间公开教室 · 自动刷新中` : '当前没有公开房间';
      this.$('rooms-empty').hidden = m.rooms.length !== 0;
      this.renderRooms(); this.renderConnection(); this.updateControls();
      return true;
    } else if (m.t === 'room') {
      this.inRoom = true; this.pending = null;
      clearInterval(this.timer); clearTimeout(this.requestTimeout); clearTimeout(this.actionTimeout);
      this.requestAt = null;
      this.$('lobby-action-status').textContent = '';
      this.$('err').textContent = '';
      // Royale has no levels: a late joiner spectates the current round instead of entering "next level".
      const royale = m.mode === 'royale';
      this.$('wait-visibility').textContent = m.public
        ? royale
          ? `公开教室 · 大逃杀（开发中）· ${m.allowLateJoin !== false ? '开局后可观察加入' : '开局后不再接受加入'}`
          : `公开教室 · ${m.allowLateJoin !== false ? '开局后可观察加入，下一关参与' : '开局后不再接受加入'}`
        : `私密教室 · 只通过房间码加入${royale ? ' · 大逃杀（开发中）' : ''}`;
      this.updateControls();
    } else if (m.t === 'error' && !this.inRoom) {
      if (this.pending) {
        this.pending = null; clearTimeout(this.actionTimeout);
        this.$('lobby-action-status').textContent = '';
        this.$('err').textContent = m.msg;
      } else if (this.requestAt !== null) {
        this.listError(`刷新失败：${m.msg}`);
      } else this.$('err').textContent = m.msg;
      this.renderRooms(); this.updateControls();
      return true;
    }
    return false;
  }

  disconnect() {
    this.disconnected = true; this.connected = false; this.pending = null;
    this.latency = null;
    clearTimeout(this.requestTimeout); clearTimeout(this.actionTimeout); clearTimeout(this.refreshCooldown);
    this.requestAt = null;
    this.$('public-rooms').setAttribute('aria-busy', 'false');
    this.$('public-rooms').dataset.state = 'disconnected';
    this.$('rooms-status').textContent = '连接已断开，列表已停止更新';
    this.$('rooms-empty').hidden = true;
    this.$('lobby-action-status').textContent = '';
    this.$('err').textContent = DISCONNECTED_MESSAGE;
    this.$('reconnect-lobby').hidden = false;
    this.renderConnection(); this.renderRooms(); this.updateControls();
  }

  dispose() {
    clearInterval(this.timer); clearTimeout(this.requestTimeout); clearTimeout(this.actionTimeout); clearTimeout(this.refreshCooldown);
    document.removeEventListener('visibilitychange', this.visibilityChanged);
  }

  private updateVisibility() {
    this.$('visibility-hint').textContent = this.$<HTMLInputElement>('visibility-public').checked
      ? '所有同学都能在列表中找到你' : '不在公开列表显示，只通过房间码邀请';
  }

  private updateGuidance() {
    const dev = isDeveloperName(this.$<HTMLInputElement>('name').value.trim());
    this.$('guidance-hint').textContent = dev ? '开发者模式：创建专用私密测试房，可作弊；整局不计入速通排行。'
      : this.$<HTMLInputElement>('guidance').checked
        ? '显示目标箭头和地图标记，本局不计入速通排行。创建后整局固定。'
        : '关闭目标箭头和地图标记，可参与速通排行。创建后整局固定。';
  }

  private updateModeHint() {
    this.$('mode-hint').textContent = this.$<HTMLSelectElement>('mode-selector').value === 'royale'
      ? '8 人分散在校园各处，安全区逐圈收缩，最后留下的人获胜。开发中，玩法仍在调整。'
      : '八关剧情，全队撤离。';
  }

  private enter(action: PendingAction, publicCode?: string) {
    if (this.pending || this.inRoom || this.disconnected) return;
    const code = normalizeRoomCode(publicCode ?? this.$<HTMLInputElement>('code').value);
    if (action === 'join' && code.length !== 4) {
      this.$('err').textContent = '请输入完整的 4 位房间码';
      this.$<HTMLInputElement>('code').focus(); return;
    }
    this.$('err').textContent = '';
    this.pending = action;
    this.$('lobby-action-status').textContent = action === 'quick' ? '正在寻找教室……' : action === 'create' ? '正在创建教室……' : '正在加入教室……';
    this.updateControls(); this.renderRooms();
    this.hello();
    const mode: GameMode = this.$<HTMLSelectElement>('mode-selector').value === 'royale' ? 'royale' : 'campaign';
    const difficulty = { ...(this.selectedDifficulty ? { difficulty: this.selectedDifficulty() } : {}), guidance: this.$<HTMLInputElement>('guidance').checked, namedMonitors: this.getNamedMonitors(), mode };
    if (action === 'create') this.send({ t: 'create', public: this.$<HTMLInputElement>('visibility-public').checked, allowLateJoin: this.$<HTMLInputElement>('allow-late-join').checked, ...difficulty });
    else if (action === 'quick') this.send({ t: 'quick', ...difficulty });
    else this.send({ t: 'join', code });
    this.actionTimeout = setTimeout(() => {
      if (this.pending) this.$('lobby-action-status').textContent = '服务器响应较慢，仍在处理，请稍候……';
    }, 15_000);
  }

  private refresh() {
    const now = performance.now();
    if (!this.connected || this.inRoom || this.disconnected || this.pending || this.requestAt !== null || now - this.lastRequestAt < MIN_REFRESH_MS) return;
    this.lastRequestAt = now; this.requestAt = now;
    this.$('public-rooms').setAttribute('aria-busy', 'true');
    this.$('public-rooms').dataset.state = 'loading';
    this.$('rooms-status').textContent = this.hasList ? '正在刷新公开房间……' : '正在加载公开房间……';
    this.$('rooms-empty').hidden = true;
    this.updateControls();
    this.send({ t: 'list' });
    this.requestTimeout = setTimeout(() => { if (this.requestAt !== null) this.listError('大厅响应超时，请刷新重试'); }, RESPONSE_TIMEOUT_MS);
    clearTimeout(this.refreshCooldown);
    this.refreshCooldown = setTimeout(() => this.updateControls(), MIN_REFRESH_MS);
  }

  private listError(message: string) {
    this.requestAt = null; clearTimeout(this.requestTimeout);
    this.latency = null;
    this.$('public-rooms').setAttribute('aria-busy', 'false');
    this.$('public-rooms').dataset.state = 'error';
    const previous = this.hasList ? this.rooms.length ? '（下方为上次结果）' : '（上次刷新时没有公开房间）' : '';
    this.$('rooms-status').textContent = `${message}${previous}`;
    this.$('rooms-empty').hidden = true;
    this.renderRooms(); this.renderConnection();
    this.updateControls();
  }

  private renderConnection() {
    this.$('lobby-connection').textContent = this.disconnected ? '连接已断开' : this.connected
      ? `已连接 · ${lobbyLatency(this.latency)}` : '正在连接大厅……';
    this.$('lobby-connection').dataset.state = this.disconnected ? 'disconnected' : this.connected ? 'connected' : 'connecting';
  }

  private updateControls() {
    const locked = !!this.pending || this.disconnected;
    for (const id of ['name', 'code', 'create', 'join', 'quick-join', 'visibility-public', 'visibility-private', 'allow-late-join', 'guidance']) this.$<HTMLInputElement | HTMLButtonElement>(id).disabled = locked;
    if (this.selectedDifficulty) this.$<HTMLSelectElement>('difficulty').disabled = locked;
    const named = this.$<HTMLInputElement>('named-monitors');
    named.dataset.lobbyLocked = String(locked || this.inRoom);
    named.disabled = locked || this.inRoom || named.dataset.unlocked !== 'true';
    this.$<HTMLButtonElement>('refresh-rooms').disabled = locked || this.inRoom || this.requestAt !== null || performance.now() - this.lastRequestAt < MIN_REFRESH_MS;
    this.$<HTMLButtonElement>('start').disabled = this.disconnected;
  }

  private renderRooms() {
    const list = this.$('public-rooms');
    const liveCodes = new Set(this.rooms.map((room) => room.code));
    for (const [code, row] of this.byCode) if (!liveCodes.has(code)) { row.root.remove(); this.byCode.delete(code); }
    for (const [index, room] of this.rooms.entries()) {
      let row = this.byCode.get(room.code);
      if (!row) {
        const root = document.createElement('li'); root.className = 'public-room'; root.dataset.code = room.code; root.dataset.testid = 'public-room';
        const name = document.createElement('h3'); name.className = 'room-name';
        const count = document.createElement('span'); count.className = 'room-count';
        const state = document.createElement('span'); state.className = 'room-state';
        const latency = document.createElement('span'); latency.className = 'room-latency';
        const note = document.createElement('p'); note.className = 'room-note';
        const join = document.createElement('button'); join.type = 'button'; join.className = 'room-join'; join.dataset.testid = 'join-public-room';
        join.onclick = () => this.enter('join', room.code);
        root.onclick = (event) => { if (!join.contains(event.target as Node)) join.click(); };
        root.append(name, count, state, latency, note, join);
        row = { root, name, count, state, latency, note, join }; this.byCode.set(room.code, row);
      }
      const view = roomPresentation(room);
      row.name.textContent = room.name; row.count.textContent = view.count; row.state.textContent = `${room.mode === 'royale' ? '大逃杀' : difficultyMode(room.difficulty).name} · ${view.state} · ${roomModeLabel(room.guidance)}${room.namedMonitors ? ' · 人名彩蛋开启' : ''}`;
      row.latency.textContent = lobbyLatency(this.latency); row.note.textContent = view.note;
      row.join.textContent = view.action;
      row.join.disabled = !view.joinable || !!this.pending || this.disconnected;
      row.join.setAttribute('aria-label', `${view.action}：${room.name}，${view.count} 人，${view.state}${room.namedMonitors ? '，人名彩蛋开启' : ''}${room.state === 'playing' && view.joinable ? room.mode === 'royale' ? '，仅观察本局' : '，下一关参与' : ''}`);
      row.root.dataset.joinable = String(view.joinable); row.root.dataset.state = room.state;
      if (list.children[index] !== row.root) list.insertBefore(row.root, list.children[index] ?? null);
    }
  }
}
