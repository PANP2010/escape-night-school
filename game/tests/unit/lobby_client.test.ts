import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PublicRoom } from '../../shared/lobby.ts';
import { PublicLobby, lobbyLatency, normalizeRoomCode, roomPresentation } from '../../client/src/lobby.ts';

const room = (extra: Partial<PublicRoom> = {}): PublicRoom => ({
  code: 'ABCD', name: '同学的教室', n: 1, max: 4, level: 0,
  state: 'waiting', allowLateJoin: true, joinable: true, ...extra,
});

describe('public lobby room descriptions', () => {
  it('shows waiting capacity and an ordinary join action', () => {
    expect(roomPresentation(room())).toEqual({ count: '1/4', state: '等待中', joinable: true, action: '加入教室', note: '等待房主开始' });
  });

  it('makes a running room an observer join with next-level participation', () => {
    expect(roomPresentation(room({ level: 2, state: 'playing' }))).toMatchObject({ state: '第 3 关进行中', action: '观察加入', note: '观察加入，下一关参与', joinable: true });
  });

  it('keeps full rooms and closed running rooms visibly unavailable', () => {
    expect(roomPresentation(room({ n: 4 }))).toMatchObject({ count: '4/4', action: '已满员', joinable: false });
    expect(roomPresentation(room({ state: 'playing', allowLateJoin: false, joinable: false }))).toMatchObject({ action: '不可加入', note: '房主已关闭中途加入', joinable: false });
    // A late stale list must never make a full room look joinable.
    expect(roomPresentation(room({ n: 4, state: 'playing', joinable: true }))).toMatchObject({ action: '已满员', joinable: false });
  });

  it('respects an authoritative nonjoinable waiting room', () => {
    expect(roomPresentation(room({ joinable: false }))).toMatchObject({ action: '不可加入', joinable: false });
  });

  it('drops the level counter for a royale room but keeps the state label once', () => {
    expect(roomPresentation(room({ mode: 'royale', n: 3, max: 8 }))).toEqual({ count: '3/8', state: '等待中', joinable: true, action: '加入教室', note: '等待房主开始' });
    expect(roomPresentation(room({ mode: 'royale', state: 'playing' }))).toMatchObject({ state: '进行中' });
  });
});

describe('lobby inputs and connection latency', () => {
  it('preserves pasted lower-case and spaced four-character codes', () => {
    expect(normalizeRoomCode(' ab cd \n')).toBe('ABCD');
    expect(normalizeRoomCode('abcd99')).toBe('ABCD');
    expect(normalizeRoomCode(' a ')).toBe('A');
  });

  it('labels RTT as the lobby connection rather than a per-room ping', () => {
    expect(lobbyLatency(null)).toBe('大厅往返 —');
    expect(lobbyLatency(14.7)).toBe('大厅往返 15 ms');
    expect(lobbyLatency(0.2)).toBe('大厅往返 1 ms');
  });
});

describe('public lobby connection and refresh lifecycle', () => {
  let lobby: PublicLobby | undefined;
  afterEach(() => { lobby?.dispose(); lobby = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  function mount(getNamedMonitors: () => boolean = () => false) {
    vi.useFakeTimers(); vi.setSystemTime(0);
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
    interface Element {
      textContent: string; value: string; hidden: boolean; checked: boolean; disabled: boolean;
      className: string; dataset: Record<string, string>; children: Element[]; setAttribute: ReturnType<typeof vi.fn>;
      append: (...children: Element[]) => void;
      insertBefore: (child: Element, before: Element | null) => void;
      onclick?: () => void;
    }
    const createElement = (): Element => {
      const node: Element = { textContent: '', value: '', hidden: false, checked: false, disabled: false,
        className: '', dataset: {}, children: [], setAttribute: vi.fn(),
        append: (...children) => { node.children.push(...children); },
        insertBefore: (child, before) => {
          const oldIndex = node.children.indexOf(child);
          if (oldIndex !== -1) node.children.splice(oldIndex, 1);
          const index = before === null ? -1 : node.children.indexOf(before);
          node.children.splice(index === -1 ? node.children.length : index, 0, child);
        },
      };
      return node;
    };
    const elements = new Map<string, Element>();
    const element = (id: string) => {
      if (!elements.has(id)) { const node = createElement(); node.checked = id === 'visibility-public'; elements.set(id, node); }
      return elements.get(id)!;
    };
    const visibilityListeners = new Set<() => void>();
    const doc = { hidden: false, getElementById: element, createElement,
      addEventListener: (_: string, listener: () => void) => visibilityListeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => visibilityListeners.delete(listener),
    };
    vi.stubGlobal('document', doc);
    const send = vi.fn();
    lobby = new PublicLobby(send, vi.fn(), () => 'story', getNamedMonitors);
    return { element, send, doc, visibilityListeners };
  }

  const modes = [
    { mode: undefined, label: 'legacy campaign', max: 4, playing: '第 3 关进行中', note: '观察加入，下一关参与', suffix: '，下一关参与' },
    { mode: 'campaign' as const, label: 'campaign', max: 4, playing: '第 3 关进行中', note: '观察加入，下一关参与', suffix: '，下一关参与' },
    { mode: 'royale' as const, label: 'royale', max: 8, playing: '进行中', note: '观察加入，仅观察本局', suffix: '，仅观察本局' },
  ];
  const states: { label: string; extra: Partial<PublicRoom>; full?: boolean; action: string; note?: string; joinable: boolean; suffix?: boolean }[] = [
    { label: 'waiting', extra: {}, action: '加入教室', note: '等待房主开始', joinable: true },
    { label: 'waiting with late joins disabled', extra: { allowLateJoin: false }, action: '加入教室', note: '等待房主开始', joinable: true },
    { label: 'playing with observer joins', extra: { state: 'playing' }, action: '观察加入', joinable: true, suffix: true },
    { label: 'full waiting room', extra: {}, full: true, action: '已满员', note: '教室已满，请选其他房间', joinable: false },
    { label: 'full playing room with a stale joinable flag', extra: { state: 'playing' }, full: true, action: '已满员', note: '教室已满，请选其他房间', joinable: false },
    { label: 'playing with late joins disabled', extra: { state: 'playing', allowLateJoin: false, joinable: false }, action: '不可加入', note: '房主已关闭中途加入', joinable: false },
    { label: 'playing with late joins disabled and a stale joinable flag', extra: { state: 'playing', allowLateJoin: false }, action: '不可加入', note: '房主已关闭中途加入', joinable: false },
    { label: 'authoritatively unavailable waiting room', extra: { joinable: false }, action: '不可加入', note: '等待房主开始', joinable: false },
    { label: 'authoritatively unavailable playing room', extra: { state: 'playing', joinable: false }, action: '不可加入', joinable: false },
  ];

  it.each(modes.flatMap(mode => states.map(state => ({ ...state, mode, label: `${mode.label}: ${state.label}` }))))('renders accurate room notes and accessible join actions for $label', ({ mode, extra, full, action, note, joinable, suffix }) => {
    const { element } = mount();
    const entry = room({ mode: mode.mode, level: 2, max: mode.max, n: full ? mode.max : 1, ...extra });
    const expected = { count: `${entry.n}/${mode.max}`, state: entry.state === 'playing' ? mode.playing : '等待中', action, note: note ?? mode.note, joinable };
    expect(roomPresentation(entry)).toEqual(expected);
    lobby!.onMessage({ t: 'welcome', id: 1 });
    lobby!.onMessage({ t: 'rooms', rooms: [room({ mode: mode.mode })] });
    // The directory reuses each row as a room starts or its admission state changes.
    lobby!.onMessage({ t: 'rooms', rooms: [entry] });
    const [row] = element('public-rooms').children;
    expect(row.dataset.joinable).toBe(String(joinable));
    expect(row.children.find(child => child.className === 'room-note')!.textContent).toBe(expected.note);
    const button = row.children.find(child => child.className === 'room-join')!;
    expect(button.textContent).toBe(action);
    expect(button.disabled).toBe(!joinable);
    expect(button.setAttribute).toHaveBeenLastCalledWith('aria-label', `${action}：同学的教室，${expected.count} 人，${expected.state}${suffix ? mode.suffix : ''}`);
  });

  it('starts the RTT after welcome, refreshes every three seconds, and refreshes on returning to the page', () => {
    const { send, doc, visibilityListeners } = mount();
    vi.advanceTimersByTime(12_000);
    expect(send).not.toHaveBeenCalled();
    lobby!.onMessage({ t: 'welcome', id: 1 });
    expect(send).toHaveBeenLastCalledWith({ t: 'list' });
    vi.advanceTimersByTime(24);
    lobby!.onMessage({ t: 'rooms', rooms: [] });
    vi.advanceTimersByTime(2_976);
    expect(send).toHaveBeenCalledTimes(2);
    lobby!.onMessage({ t: 'rooms', rooms: [] });
    doc.hidden = true;
    vi.advanceTimersByTime(3_000);
    expect(send).toHaveBeenCalledTimes(2);
    doc.hidden = false;
    for (const listener of visibilityListeners) listener();
    expect(send).toHaveBeenCalledTimes(3);
    lobby!.dispose();
    expect(visibilityListeners.size).toBe(0);
  });

  it('clears stale latency on a list error and stops actions and refreshes after disconnection', () => {
    const { send, element } = mount();
    lobby!.onMessage({ t: 'welcome', id: 1 });
    vi.advanceTimersByTime(24);
    lobby!.onMessage({ t: 'rooms', rooms: [] });
    expect(element('lobby-connection').textContent).toContain('24 ms');
    vi.advanceTimersByTime(2_976);
    expect(lobby!.onMessage({ t: 'error', msg: '稍后重试' })).toBe(true);
    expect(element('rooms-status').textContent).toContain('上次刷新时没有公开房间');
    expect(element('lobby-connection').textContent).toContain('大厅往返 —');
    expect(element('err').textContent).toBe('');
    lobby!.disconnect();
    const sent = send.mock.calls.length;
    element('quick-join').onclick!();
    vi.advanceTimersByTime(12_000);
    expect(send).toHaveBeenCalledTimes(sent);
    expect(element('create').disabled).toBe(true);
    expect(element('named-monitors').dataset.lobbyLocked).toBe('true');
    expect(element('reconnect-lobby').hidden).toBe(false);
  });

  it('clears the disconnect warning after the lobby reconnects and resumes actions and refreshes', () => {
    const { send, element } = mount();
    lobby!.onMessage({ t: 'welcome', id: 1 });
    lobby!.onMessage({ t: 'rooms', rooms: [] });
    lobby!.disconnect();
    expect(element('err').textContent).toContain('与服务器断开连接');
    expect(element('create').disabled).toBe(true);

    vi.advanceTimersByTime(1_500);
    const sent = send.mock.calls.length;
    lobby!.onMessage({ t: 'welcome', id: 2 });
    expect(element('lobby-connection').dataset.state).toBe('connected');
    expect(element('err').textContent).toBe('');
    expect(element('reconnect-lobby').hidden).toBe(true);
    expect(element('create').disabled).toBe(false);
    expect(element('quick-join').disabled).toBe(false);
    expect(element('named-monitors').dataset.lobbyLocked).toBe('false');
    expect(send.mock.calls.length).toBe(sent + 1);
    expect(send).toHaveBeenLastCalledWith({ t: 'list' });
    lobby!.onMessage({ t: 'rooms', rooms: [] });
    vi.advanceTimersByTime(1_500);
    expect(send.mock.calls.length).toBe(sent + 2);
  });

  it('does not erase a room error when a welcome is received', () => {
    const { element } = mount();
    lobby!.onMessage({ t: 'welcome', id: 1 });
    lobby!.onMessage({ t: 'rooms', rooms: [] });
    lobby!.onMessage({ t: 'error', msg: '房间不存在' });
    lobby!.onMessage({ t: 'welcome', id: 1 });
    expect(element('err').textContent).toBe('房间不存在');

    lobby!.disconnect();
    lobby!.onMessage({ t: 'error', msg: '原会话仍在线' });
    lobby!.onMessage({ t: 'welcome', id: 2 });
    expect(element('err').textContent).toBe('原会话仍在线');
  });

  it.each(['create', 'quick-join'])('sends the gated named-monitor choice through %s', action => {
    let allowed = false;
    const { send, element } = mount(() => allowed);
    element('named-monitors').checked = true; // A stale DOM preference cannot bypass the progression callback.
    lobby!.onMessage({ t: 'welcome', id: 1 });
    element(action).onclick!();
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ namedMonitors: false }));
    lobby!.onMessage({ t: 'error', msg: 'retry' });
    allowed = true;
    element(action).onclick!();
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ namedMonitors: true }));
  });

});
