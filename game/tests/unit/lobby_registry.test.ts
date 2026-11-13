import { describe, expect, it } from 'vitest';
import { LobbyRegistry, LOBBY_LIST_GAP_MS, LOBBY_MATCH_GAP_MS } from '../../server/lobbyRegistry.ts';
import { RoomManager, type Conn } from '../../server/room.ts';
import { parseClientMsg, ST_OK, ST_SPECTATE, type ServerMsg } from '../../shared/protocol.ts';
import { parseLobbyMsg, sanitizePlayerName, type LobbyClientMsg, type RoomsMsg } from '../../shared/lobby.ts';
import { mulberry32 } from '../../shared/rng.ts';

const setup = () => {
  const manager = new RoomManager(mulberry32(5)), lobby = new LobbyRegistry(manager);
  let id = 0;
  const mk = (name = '玩家') => {
    const got: (ServerMsg | RoomsMsg)[] = [];
    const conn: Conn = { id: ++id, name, send: (m) => got.push(m), sendRaw: (s) => got.push(JSON.parse(s)) };
    return { conn, got };
  };
  const create = (name = '房主', settings: Omit<Extract<LobbyClientMsg, { t: 'create' }>, 't'> = { public: true }) => {
    const peer = mk(name);
    lobby.handle(peer.conn, { t: 'create', ...settings }, 0);
    return { ...peer, room: peer.conn.room! };
  };
  return { manager, lobby, mk, create };
};

describe('public lobby discovery', () => {
  it('lists only occupied public rooms, with live counts, capacity, level and start state', () => {
    const { lobby, create, mk } = setup();
    const pub = create('甲'), hidden = create('私密', { public: false }), oldClient = create('旧客户端', {});
    lobby.handle(mk('乙').conn, { t: 'join', code: pub.room.code }, 1);
    expect(lobby.list()).toEqual([{ code: pub.room.code, name: '甲的教室', n: 2, max: 4, level: 0,
      state: 'waiting', allowLateJoin: true, difficulty: 'standard', guidance: true, namedMonitors: false, mode: 'campaign', joinable: true }]);
    const serialized = JSON.stringify(lobby.list());
    expect(serialized).not.toContain(hidden.room.code);
    expect(serialized).not.toContain(oldClient.room.code);
    pub.room.handle(pub.conn, { t: 'start' }, 2);
    pub.room.levelIndex = 2;
    expect(lobby.list()[0]).toMatchObject({ state: 'playing', level: 2, n: 2 });
  });

  it('derives the title from the current host after host transfer and filters unsafe name characters', () => {
    const { lobby, create, mk } = setup();
    const a = create('<甲>\u202e\u0000'), b = mk('乙');
    lobby.handle(b.conn, { t: 'join', code: a.room.code }, 1);
    expect(lobby.list()[0].name).toBe('甲的教室');
    a.room.remove(a.conn, 2);
    expect(lobby.list()[0]).toMatchObject({ name: '乙的教室', n: 1 });
  });

  it('keeps full rooms visible but disables their admission', () => {
    const { lobby, create, mk } = setup();
    const a = create();
    for (let i = 0; i < 3; i++) lobby.handle(mk().conn, { t: 'join', code: a.room.code }, 1);
    expect(lobby.list()[0]).toMatchObject({ n: 4, max: 4, joinable: false });
    const b = mk();
    lobby.handle(b.conn, { t: 'join', code: a.room.code }, 2);
    expect(b.got.at(-1)).toEqual({ t: 'error', msg: '房间已满' });
    expect(a.room.players.size).toBe(4);
  });

  it('hides empty and completed rooms, and never revives them through a new code join', () => {
    const { lobby, create, mk, manager } = setup();
    const empty = create('空房'), finished = create('通关房');
    empty.room.handle(empty.conn, { t: 'start' }, 1);
    empty.room.remove(empty.conn, 10);
    finished.room.completed = true;
    expect(manager.rooms.size).toBe(2);
    expect(lobby.list()).toEqual([]);
    const b = mk();
    lobby.handle(b.conn, { t: 'join', code: empty.room.code }, 20);
    expect(b.got.at(-1)).toEqual({ t: 'error', msg: '房间已关闭' });
    lobby.handle(b.conn, { t: 'join', code: finished.room.code }, 21);
    expect(b.got.at(-1)).toEqual({ t: 'error', msg: '房间已通关，请创建新房间' });
    expect(b.conn.room).toBeUndefined();
  });

  it('allows private rooms by code while keeping their metadata out of list responses', () => {
    const { lobby, create, mk } = setup();
    const a = create('私密', { public: false }), b = mk();
    lobby.handle(b.conn, { t: 'join', code: a.room.code }, 1);
    expect(b.conn.room).toBe(a.room);
    lobby.handle(b.conn, { t: 'list' }, 2);
    expect(b.got.at(-1)).toEqual({ t: 'rooms', rooms: [] });
  });

  it('broadcasts the same privacy and admission settings to joiners and after start', () => {
    const { lobby, create, mk } = setup();
    const a = create('房主', { public: true, allowLateJoin: false }), b = mk();
    lobby.handle(b.conn, { t: 'join', code: a.room.code }, 1);
    const lastRoom = (got: (ServerMsg | RoomsMsg)[]) => got.filter((m) => m.t === 'room').at(-1);
    expect(lastRoom(a.got)).toMatchObject({ public: true, allowLateJoin: false, started: false });
    expect(lastRoom(b.got)).toMatchObject({ public: true, allowLateJoin: false, started: false });
    a.room.handle(a.conn, { t: 'start' }, 2);
    expect(lastRoom(b.got)).toMatchObject({ public: true, allowLateJoin: false, started: true });
  });

  it('retains an empty room for exactly 30 seconds before reclaiming it, without removing occupied rooms', () => {
    const { manager, create } = setup();
    const empty = create('空房'), active = create('有人的房间');
    empty.room.remove(empty.conn, 10);
    manager.step(30_009);
    expect(manager.get(empty.room.code)).toBe(empty.room);
    manager.step(30_010);
    expect(manager.get(empty.room.code)).toBeUndefined();
    expect(manager.get(active.room.code)).toBe(active.room);
  });
});

describe('quick matching and admission', () => {
  it('chooses the most occupied waiting public room, excluding full, playing and private rooms', () => {
    const { lobby, create, mk } = setup();
    create('一人');
    const chosen = create('两人'), playing = create('进行中'), full = create('满房');
    create('私密', { public: false });
    lobby.handle(mk().conn, { t: 'join', code: chosen.room.code }, 1);
    for (let i = 0; i < 2; i++) lobby.handle(mk().conn, { t: 'join', code: playing.room.code }, 1);
    for (let i = 0; i < 3; i++) lobby.handle(mk().conn, { t: 'join', code: full.room.code }, 1);
    playing.room.handle(playing.conn, { t: 'start' }, 2);
    const b = mk();
    lobby.handle(b.conn, { t: 'quick' }, 3);
    expect(b.conn.room).toBe(chosen.room);
    expect(chosen.room.players.size).toBe(3);
  });

  it('creates a public waiting room if no eligible room exists, including retained empty rooms', () => {
    const { lobby, create, mk } = setup();
    create('私密', { public: false });
    const empty = create('空房');
    empty.room.remove(empty.conn, 1);
    const b = mk('快速玩家');
    lobby.handle(b.conn, { t: 'quick' }, 2);
    expect(b.conn.room).not.toBe(empty.room);
    expect(b.conn.room?.started).toBe(false);
    expect(lobby.list()).toMatchObject([{ code: b.conn.room!.code, name: '快速玩家的教室', allowLateJoin: true }]);
  });

  it('joins running rooms as an observer by default, but rejects code joins when the owner opted out', () => {
    const { lobby, create, mk } = setup();
    const open = create('允许'), closed = create('禁止', { public: true, allowLateJoin: false });
    open.room.handle(open.conn, { t: 'start' }, 1);
    closed.room.handle(closed.conn, { t: 'start' }, 1);
    const b = mk(), c = mk();
    lobby.handle(b.conn, { t: 'join', code: open.room.code }, 2);
    lobby.handle(c.conn, { t: 'join', code: closed.room.code }, 2);
    expect(open.room.players.get(b.conn.id)?.st).toBe(ST_SPECTATE);
    expect(lobby.list().find((room) => room.code === closed.room.code)?.joinable).toBe(false);
    expect(c.got.at(-1)).toEqual({ t: 'error', msg: '本房间不允许中途加入' });
    expect(c.conn.room).toBeUndefined();
  });

  it('also enforces late-join opt out for private rooms and preserves a refused player’s previous room', () => {
    const { lobby, create } = setup();
    const closed = create('私密', { public: false, allowLateJoin: false }), b = create('原房');
    closed.room.handle(closed.conn, { t: 'start' }, 1);
    lobby.handle(b.conn, { t: 'join', code: closed.room.code }, 2);
    expect(b.conn.room).toBe(b.room);
    expect(b.room.players.has(b.conn.id)).toBe(true);
    lobby.handle(b.conn, { t: 'join', code: 'XXXX' }, 3);
    expect(b.conn.room).toBe(b.room);
  });

  it('treats joining or quick matching into the same room as idempotent', () => {
    const { lobby, create } = setup();
    const a = create();
    lobby.handle(a.conn, { t: 'quick' }, LOBBY_MATCH_GAP_MS);
    lobby.handle(a.conn, { t: 'join', code: a.room.code }, 1001);
    expect(a.room.players.size).toBe(1);
    expect(a.room.host).toBe(a.conn.id);
    expect(a.room.players.get(a.conn.id)?.st).toBe(ST_OK);
    a.room.handle(a.conn, { t: 'start' }, 1002);
    lobby.handle(a.conn, { t: 'join', code: a.room.code }, 1003);
    expect(a.room.players.get(a.conn.id)?.st).toBe(ST_OK);
  });

  it('keeps the current public waiting room when it has more players than another candidate', () => {
    const { lobby, create, mk } = setup();
    const a = create('原房主'), other = create('其他房');
    for (let i = 0; i < 2; i++) lobby.handle(mk().conn, { t: 'join', code: a.room.code }, 1);
    lobby.handle(mk().conn, { t: 'join', code: other.room.code }, 1);
    const player = a.room.players.get(a.conn.id);

    lobby.handle(a.conn, { t: 'quick' }, LOBBY_MATCH_GAP_MS);

    expect(a.conn.room).toBe(a.room);
    expect(a.room.players.size).toBe(3);
    expect(a.room.players.get(a.conn.id)).toBe(player);
    expect(a.room.host).toBe(a.conn.id);
    expect(other.room.players.size).toBe(2);
  });

  it('moves an existing host to a more populated public waiting room and transfers the previous host role', () => {
    const { lobby, create, mk } = setup();
    const a = create('原房主'), remaining = mk('接任房主'), chosen = create('三人房');
    lobby.handle(remaining.conn, { t: 'join', code: a.room.code }, 1);
    for (let i = 0; i < 2; i++) lobby.handle(mk().conn, { t: 'join', code: chosen.room.code }, 1);

    lobby.handle(a.conn, { t: 'quick' }, LOBBY_MATCH_GAP_MS);

    expect(a.conn.room).toBe(chosen.room);
    expect(chosen.room.players.size).toBe(4);
    expect(a.room.players.has(a.conn.id)).toBe(false);
    expect(a.room.host).toBe(remaining.conn.id);
    expect(a.room.players.size).toBe(1);
  });
});

describe('room creation failures', () => {
  it.each(['create', 'quick'] as const)('returns a capacity error for %s without changing the previous room', (action) => {
    const { manager, create } = setup();
    const a = create('原房主', { public: false });
    a.room.handle(a.conn, { t: 'start' }, 1);
    const player = a.room.players.get(a.conn.id)!, position = [...player.p];
    const lobby = new LobbyRegistry({ rooms: manager.rooms, get: (code) => manager.get(code),
      create: () => { throw new Error('房间数量已满，请稍后再试'); } });

    expect(lobby.handle(a.conn, action === 'create' ? { t: 'create', public: true } : { t: 'quick' }, 2)).toBe(true);

    expect(a.got.at(-1)).toEqual({ t: 'error', msg: '房间数量已满，请稍后再试' });
    expect(a.conn.room).toBe(a.room);
    expect(a.room.host).toBe(a.conn.id);
    expect(a.room.players.get(a.conn.id)).toBe(player);
    expect(player.st).toBe(ST_OK);
    expect(player.p).toEqual(position);
    expect(a.room.started).toBe(true);
    expect(manager.rooms.size).toBe(1);
  });

  it.each([
    { kind: 'Error', error: new Error('Failed reading /internal/room-cache.json') },
    { kind: 'non-Error value', error: 'Failed reading /internal/room-cache.json' },
  ])('hides unexpected creation details from a thrown $kind', ({ error }) => {
    const { manager, create } = setup();
    const a = create('原房主', { public: false }), player = a.room.players.get(a.conn.id);
    const lobby = new LobbyRegistry({ rooms: manager.rooms, get: (code) => manager.get(code), create: () => { throw error; } });

    expect(lobby.handle(a.conn, { t: 'create', public: true }, 1)).toBe(true);

    expect(a.got.at(-1)).toEqual({ t: 'error', msg: '创建房间失败，请稍后重试' });
    expect(JSON.stringify(a.got)).not.toContain('/internal/room-cache.json');
    expect(a.conn.room).toBe(a.room);
    expect(a.room.host).toBe(a.conn.id);
    expect(a.room.players.get(a.conn.id)).toBe(player);
    expect(manager.rooms.size).toBe(1);
  });

  it('quick joins an eligible room even when creating another room would fail', () => {
    const { manager, create, mk } = setup();
    const a = create(), b = mk();
    let creates = 0;
    const lobby = new LobbyRegistry({ rooms: manager.rooms, get: (code) => manager.get(code),
      create: () => { creates++; throw new Error('房间数量已满，请稍后再试'); } });

    expect(lobby.handle(b.conn, { t: 'quick' }, 1)).toBe(true);

    expect(creates).toBe(0);
    expect(b.conn.room).toBe(a.room);
    expect(a.room.players.size).toBe(2);
    expect(b.got.some((m) => m.t === 'error')).toBe(false);
  });
});

describe('per-connection lobby throttling', () => {
  it('allows an initial anonymous list and applies the 1 second limit independently to each connection', () => {
    const { lobby, mk } = setup();
    const a = mk(), b = mk();
    lobby.handle(a.conn, { t: 'list' }, 0);
    expect(a.got.at(-1)).toEqual({ t: 'rooms', rooms: [] });
    lobby.handle(a.conn, { t: 'list' }, LOBBY_LIST_GAP_MS - 1);
    expect(a.got.at(-1)).toEqual({ t: 'error', msg: '刷新太快，请稍后重试' });
    lobby.handle(b.conn, { t: 'list' }, 1);
    expect(b.got.at(-1)).toEqual({ t: 'rooms', rooms: [] });
    lobby.handle(a.conn, { t: 'list' }, LOBBY_LIST_GAP_MS);
    expect(a.got.at(-1)).toEqual({ t: 'rooms', rooms: [] });
  });

  it('shares create/quick cooldown while leaving browsing and code joins independent', () => {
    const { lobby, mk, manager } = setup();
    const a = mk(), b = mk();
    lobby.handle(a.conn, { t: 'list' }, 0);
    lobby.handle(a.conn, { t: 'create', public: true }, 0);
    const first = a.conn.room;
    lobby.handle(a.conn, { t: 'quick' }, LOBBY_MATCH_GAP_MS - 1);
    expect(a.got.at(-1)).toEqual({ t: 'error', msg: '操作太快，请稍后重试' });
    expect(manager.rooms.size).toBe(1);
    lobby.handle(b.conn, { t: 'join', code: first!.code }, 1);
    expect(b.conn.room).toBe(first);
    lobby.handle(a.conn, { t: 'create', public: true }, LOBBY_MATCH_GAP_MS);
    expect(a.conn.room).not.toBe(first);
    expect(manager.rooms.size).toBe(2);
    expect(first!.players.has(b.conn.id)).toBe(true);
  });
});

describe('lobby request parsing and display names', () => {
  it('accepts exact boolean options and keeps a legacy create private by omission', () => {
    expect(parseLobbyMsg({ t: 'create' })).toEqual({ t: 'create' });
    expect(parseLobbyMsg({ t: 'create', public: true, allowLateJoin: false })).toEqual({ t: 'create', public: true, allowLateJoin: false });
    expect(parseLobbyMsg({ t: 'create', public: 'true' })).toBeNull();
    expect(parseLobbyMsg({ t: 'create', allowLateJoin: 0 })).toBeNull();
    expect(parseLobbyMsg({ t: 'list' })).toEqual({ t: 'list' });
    expect(parseLobbyMsg({ t: 'quick' })).toEqual({ t: 'quick' });
  });

  it('routes lobby messages and filtered names through the actual untrusted JSON parser', () => {
    expect(parseClientMsg('{"t":"list"}')).toEqual({ t: 'list' });
    expect(parseClientMsg('{"t":"quick"}')).toEqual({ t: 'quick' });
    expect(parseClientMsg('{"t":"create","public":true,"allowLateJoin":false}'))
      .toEqual({ t: 'create', public: true, allowLateJoin: false });
    expect(parseClientMsg('{"t":"create","public":"false"}')).toBeNull();
    expect(parseClientMsg(JSON.stringify({ t: 'hello', name: '<甲>\u202e\u0000' }))).toEqual({ t: 'hello', name: '甲' });
  });

  it('removes controls, bidi overrides and angle brackets, bounds Unicode names and supplies a fallback', () => {
    expect(sanitizePlayerName('  <甲>\u202e\u0000\n 乙  ')).toBe('甲 乙');
    expect(sanitizePlayerName('\u0000\u202e<>')).toBe('无名');
    expect(Array.from(sanitizePlayerName('😀'.repeat(20)))).toHaveLength(16);
  });
});
