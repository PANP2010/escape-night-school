import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LobbyRegistry } from '../../server/lobbyRegistry.ts';
import { LEVEL_FADE_S, RoomManager, type Conn, type Room } from '../../server/room.ts';
import { NavGraph } from '../../shared/campus/nav.ts';
import { TICK_MS } from '../../shared/constants.ts';
import { parseLobbyMsg, type LobbyClientMsg } from '../../shared/lobby.ts';
import { parseClientMsg, ST_SPECTATE, type ServerMsg } from '../../shared/protocol.ts';
import { mulberry32 } from '../../shared/rng.ts';
import { DEVELOPER_NAME, type RoomOptions } from '../../shared/runMode.ts';

beforeEach(() => vi.stubEnv('NODE_ENV', 'production'));
afterEach(() => vi.unstubAllEnvs());

function setup(nav?: NavGraph) {
  const manager = new RoomManager(mulberry32(71), nav ? () => nav : undefined);
  const lobby = new LobbyRegistry(manager);
  let nextId = 0;
  const peer = (name = '同学') => {
    const messages: ServerMsg[] = [];
    const conn: Conn = { id: ++nextId, name, send: m => messages.push(m), sendRaw: s => messages.push(JSON.parse(s)) };
    return { conn, messages };
  };
  const create = (name = '房主', options: Omit<Extract<LobbyClientMsg, { t: 'create' }>, 't'> = {}) => {
    const player = peer(name);
    lobby.handle(player.conn, { t: 'create', ...options }, 0);
    return { ...player, room: player.conn.room! };
  };
  return { manager, lobby, peer, create };
}

function run(room: Room, seconds: number) {
  for (let i = 0; i < Math.ceil(seconds * 1000 / TICK_MS) + 2; i++) room.step();
}

describe('pre-game guidance requests and matching', () => {
  it('defaults old requests to anonymous monitors and separates optional name rooms in quick match', () => {
    const { lobby, create, peer } = setup();
    const named = create('彩蛋', { public: true, namedMonitors: true });
    const plain = create('原版', { public: true });
    expect(plain.room.namedMonitors).toBe(false);
    const a = peer(), b = peer();
    lobby.handle(a.conn, { t: 'quick' }, 1);
    lobby.handle(b.conn, { t: 'quick', namedMonitors: true }, 1);
    expect(a.conn.room).toBe(plain.room); expect(b.conn.room).toBe(named.room);
    expect(lobby.list().find(r => r.code === named.room.code)?.namedMonitors).toBe(true);
  });

  it('accepts only exact named-monitor booleans and preserves omission for old clients', () => {
    for (const t of ['create', 'quick']) {
      for (const namedMonitors of [true, false]) expect(parseLobbyMsg({ t, namedMonitors })).toEqual({ t, namedMonitors });
      for (const namedMonitors of ['true', 'false', 1, null]) expect(parseLobbyMsg({ t, namedMonitors })).toBeNull();
      expect(parseLobbyMsg({ t })).toEqual({ t });
    }
  });

  it.each(['create', 'quick'] as const)('preserves exact guidance booleans and legacy omission in %s', t => {
    for (const guidance of [false, true]) {
      expect(parseLobbyMsg({ t, guidance })).toEqual({ t, guidance });
      expect(parseClientMsg(JSON.stringify({ t, guidance }))).toEqual({ t, guidance });
    }
    expect(parseLobbyMsg({ t })).toEqual({ t });
  });

  it.each(['false', 'true', 0, 1, null, {}, []])('rejects invalid guidance value %j before lobby handling', guidance => {
    for (const t of ['create', 'quick']) {
      expect(parseLobbyMsg({ t, guidance })).toBeNull();
      expect(parseClientMsg(JSON.stringify({ t, guidance }))).toBeNull();
    }
  });

  it('ignores client claims of developer mode when creating an ordinary room', () => {
    const { lobby, peer } = setup(), player = peer();
    const request = parseClientMsg(JSON.stringify({ t: 'create', public: true, guidance: false, developerMode: true }))!;
    expect(request).toEqual({ t: 'create', public: true, guidance: false });
    lobby.handle(player.conn, request, 0);
    expect(player.conn.room).toMatchObject({ guidance: false, developerMode: false });
    expect(player.conn.room!.canDebug(player.conn)).toBe(false);
  });

  it.each([false, true])('matches explicit difficulty and guidance=%s despite fuller incompatible rooms', guidance => {
    const { lobby, peer, create } = setup();
    const otherGuidance = create('另一指引', { public: true, difficulty: 'standard', guidance: !guidance });
    const otherDifficulty = create('另一难度', { public: true, difficulty: 'nightmare', guidance });
    const chosen = create('匹配房间', { public: true, difficulty: 'standard', guidance });
    for (const room of [otherGuidance.room, otherDifficulty.room]) {
      for (let i = 0; i < 2; i++) lobby.handle(peer().conn, { t: 'join', code: room.code }, 1);
    }
    const joining = peer();
    lobby.handle(joining.conn, { t: 'quick', difficulty: 'standard', guidance }, 2);
    expect(joining.conn.room).toBe(chosen.room);
    expect(lobby.list().find(room => room.code === chosen.room.code)).toMatchObject({ guidance, difficulty: 'standard', n: 2 });
  });

  it('creates a new public room when only an incompatible guidance room exists', () => {
    const { lobby, peer, create } = setup();
    const guided = create('指引房', { public: true, guidance: true }), joining = peer();
    lobby.handle(joining.conn, { t: 'quick', guidance: false }, 1);
    expect(joining.conn.room).not.toBe(guided.room);
    expect(joining.conn.room).toMatchObject({ guidance: false, developerMode: false });
    expect(lobby.list().find(room => room.code === joining.conn.room!.code)).toMatchObject({ guidance: false });
  });

  it('keeps legacy quick matching in guidance rooms and defaults legacy creation to guidance', () => {
    const { lobby, peer, create } = setup();
    const unguided = create('速通房', { public: true, guidance: false });
    const legacy = create('旧客户端', { public: true }), joining = peer();
    lobby.handle(peer().conn, { t: 'join', code: unguided.room.code }, 1);
    lobby.handle(joining.conn, { t: 'quick' }, 2);
    expect(legacy.room.guidance).toBe(true);
    expect(joining.conn.room).toBe(legacy.room);
    expect(legacy.messages.filter(m => m.t === 'room').at(-1)).toMatchObject({ guidance: true, developerMode: false });
  });
});

describe('room guidance authority and lifetime', () => {
  it.each([
    { label: 'legacy', options: {}, guidance: true },
    { label: 'enabled', options: { guidance: true }, guidance: true },
    { label: 'disabled', options: { guidance: false }, guidance: false },
  ])('sends navigation only for $label guidance on join and reconnect', ({ options, guidance }) => {
    const graph = new NavGraph();
    graph.chain([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 1 }]);
    const { manager, peer } = setup(graph), room = manager.create(false, 0, 'standard', options);
    const host = peer(); room.add(host.conn, 0);
    expect(host.messages.some(m => m.t === 'nav')).toBe(guidance);
    expect(host.messages.find(m => m.t === 'room')).toMatchObject({ guidance });
    room.disconnect(host.conn);
    const reconnected = peer();
    expect(room.resume(host.conn, reconnected.conn, 100)).toBe(true);
    expect(reconnected.messages.some(m => m.t === 'nav')).toBe(guidance);
    expect(reconnected.messages.find(m => m.t === 'room')).toMatchObject({ guidance });
  });

  it.each([
    { guidance: true, developerMode: false },
    { guidance: false, developerMode: false },
    { guidance: false, developerMode: true },
  ] satisfies RoomOptions[])('retains mode $guidance/$developerMode through natural advancement, retry and reconnect', options => {
    const { manager, peer } = setup(), room = manager.create(false, 0, 'challenge', options);
    const host = peer(options.developerMode ? DEVELOPER_NAME : '房主'); room.add(host.conn, 0);
    const player = room.players.get(host.conn.id)!;
    room.bag = { stair_key: 1 };
    player.p = [room.level.exit.x, room.level.exit.y, room.level.exit.z];
    room.step(); run(room, LEVEL_FADE_S);
    expect(room.levelIndex).toBe(1);
    expect(room).toMatchObject({ ...options, difficulty: 'challenge' });
    const incarnation = room.incarnation;
    player.st = ST_SPECTATE;
    room.step(); run(room, LEVEL_FADE_S);
    expect(room.levelIndex).toBe(1);
    expect(room.incarnation).toBe(incarnation + 1);
    expect(room).toMatchObject(options);
    room.disconnect(host.conn);
    const reconnected = peer();
    expect(room.resume(host.conn, reconnected.conn, 10000)).toBe(true);
    expect(reconnected.messages.find(m => m.t === 'room')).toMatchObject({ ...options, difficulty: 'challenge', level: 1 });
  });
});

describe('isolated developer rooms in production', () => {
  it.each(['create', 'quick'] as const)('%s creates a private developer room instead of joining the public pool', t => {
    const { lobby, peer, create } = setup();
    const ordinary = create('公开房主', { public: true, guidance: false });
    const developer = peer(DEVELOPER_NAME);
    lobby.handle(developer.conn, t === 'create' ? { t, public: true, guidance: false } : { t, guidance: false }, 1);
    const room = developer.conn.room!;
    expect(room).not.toBe(ordinary.room);
    expect(room).toMatchObject({ developerMode: true, guidance: false, lobbySettings: { public: false } });
    expect(room.canDebug(developer.conn)).toBe(true);
    expect(lobby.list().map(r => r.code)).toEqual([ordinary.room.code]);
    expect(developer.messages.filter(m => m.t === 'room').at(-1)).toMatchObject({ developerMode: true, public: false });
    room.lobbySettings = { public: true, allowLateJoin: true };
    expect(lobby.list().map(r => r.code)).toEqual([ordinary.room.code]);
  });

  it('refuses a developer-named player joining an ordinary room without leaving their current room', () => {
    const { lobby, create } = setup();
    const ordinary = create('普通房主', { public: true, guidance: false }), developer = create(DEVELOPER_NAME);
    lobby.handle(developer.conn, { t: 'join', code: ordinary.room.code }, 1);
    expect(developer.conn.room).toBe(developer.room);
    expect(ordinary.room.players.has(developer.conn.id)).toBe(false);
    expect(developer.messages.at(-1)).toMatchObject({ t: 'error' });
  });

  it('lets a normal guest join by code while reserving cheats for the developer host', () => {
    const { lobby, create, peer } = setup(), developer = create(DEVELOPER_NAME, { guidance: false });
    const guest = peer('访客');
    lobby.handle(guest.conn, { t: 'join', code: developer.room.code }, 1);
    expect(guest.conn.room).toBe(developer.room);
    expect(developer.room.canDebug(guest.conn)).toBe(false);
    developer.room.handle(developer.conn, { t: 'start' }, 2);
    developer.room.handle(guest.conn, { t: 'debug', op: 'key', door: -1 }, 3);
    expect(developer.room.bag.stair_key).toBeUndefined();
    developer.room.handle(developer.conn, { t: 'debug', op: 'key', door: -1 }, 4);
    expect(developer.room.bag.stair_key).toBe(1);
  });

  it.each(['DEV-LOCAL', 'dev-local#', 'DEV-LOCAL#x'])('does not grant production debugging to near-match nickname %s', name => {
    const { create } = setup(), ordinary = create(name, { guidance: false });
    expect(ordinary.room.developerMode).toBe(false);
    expect(ordinary.room.canDebug(ordinary.conn)).toBe(false);
  });

  it('denies an exact nickname spoof inside an ordinary production room', () => {
    const { manager, peer } = setup(), room = manager.create(false, 0, 'standard', { guidance: false });
    const spoof = peer(DEVELOPER_NAME); room.add(spoof.conn, 0);
    expect(room.canDebug(spoof.conn)).toBe(false);
    room.handle(spoof.conn, { t: 'debug', op: 'key', door: -1 }, 1);
    expect(room.bag.stair_key).toBeUndefined();
    expect(room.badMsgs).toBe(1);
  });

  it('denies disconnected and stale transports after the developer host resumes', () => {
    const { manager, peer } = setup(), room = manager.create(false, 0, 'standard', { guidance: false, developerMode: true });
    const previous = peer(DEVELOPER_NAME); room.add(previous.conn, 0);
    expect(room.canDebug(previous.conn)).toBe(true);
    room.disconnect(previous.conn);
    expect(room.canDebug(previous.conn)).toBe(false);
    const resumed = peer('replacement');
    expect(room.resume(previous.conn, resumed.conn, 100)).toBe(true);
    expect(resumed.conn.name).toBe(DEVELOPER_NAME);
    expect(room.canDebug(resumed.conn)).toBe(true);
    expect(room.canDebug(previous.conn)).toBe(false);
    room.handle(previous.conn, { t: 'debug', op: 'key', door: -1 }, 101);
    expect(room.bag.stair_key).toBeUndefined();
    room.handle(resumed.conn, { t: 'debug', op: 'key', door: -1 }, 102);
    expect(room.bag.stair_key).toBe(1);
  });

  it('requires the exact developer nickname and current host even inside a developer room', () => {
    const { manager, peer } = setup(), room = manager.create(false, 0, 'standard', { developerMode: true });
    const ordinaryHost = peer(), namedGuest = peer(DEVELOPER_NAME);
    room.add(ordinaryHost.conn, 0); room.add(namedGuest.conn, 0);
    expect(room.canDebug(ordinaryHost.conn)).toBe(false);
    expect(room.canDebug(namedGuest.conn)).toBe(false);
    room.remove(ordinaryHost.conn, 1);
    expect(room.host).toBe(namedGuest.conn.id);
    expect(room.canDebug(namedGuest.conn)).toBe(true);
  });
});
