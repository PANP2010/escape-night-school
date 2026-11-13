import { describe, expect, it } from 'vitest';
import { RoomManager, LEVEL_FADE_S, MONITOR_RESCUE_S, REVIVE_S, SAFE_S, type Conn } from '../../server/room.ts';
import { NavGraph } from '../../shared/campus/nav.ts';
import { BATTERY_S, TPS } from '../../shared/constants.ts';
import { batteryBudget, levelDifficulty, monitorUnlocked, safeMonitorStart } from '../../shared/difficulty.ts';
import { L1 } from '../../shared/levels/l1.ts';
import { L2 } from '../../shared/levels/l2.ts';
import { ST_OK, ST_SPECTATE, type ServerMsg, type Vec3, type WorldItem } from '../../shared/protocol.ts';
import { mulberry32 } from '../../shared/rng.ts';
import type { MonitorAI } from '../../server/ai/monitor.ts';
import { roomIntroReady } from './room-intro-fixture.ts';

function setup(n = 1, index = 0, monsters = false) {
  const graph = new NavGraph();
  graph.chain([{ x: -42, y: 0, z: 73.36 }, { x: -18, y: 0, z: 96 }, { x: -64, y: 0, z: 96 }]);
  graph.chain([{ x: 55.8, y: 3.6, z: 84.2 }, { x: 28, y: 3.6, z: 84.2 }, { x: 20, y: 3.6, z: 84.2 }]);
  const room = new RoomManager(mulberry32(17), monsters ? () => graph : undefined).create(true, index);
  const messages = new Map<number, ServerMsg[]>();
  const join = (id: number) => {
    const got: ServerMsg[] = [];
    messages.set(id, got);
    const c: Conn = { id, name: `p${id}`, send: m => got.push(m), sendRaw: s => got.push(JSON.parse(s)) };
    room.add(c, 0);
    return c;
  };
  const conns = Array.from({ length: n }, (_, i) => join(i + 1));
  const ready = roomIntroReady(conns);
  room.handle(conns[0], { t: 'start' }, 0);
  ready(room);
  const internals = room as unknown as { monitors: MonitorAI[]; loadLevel(index: number): void; difficultyPlayers: number; prey(): { id: number }[] };
  const pick = (id: number, item: WorldItem) => {
    const pl = room.players.get(id)!;
    pl.p = [item.p[0], item.p[1] - 1.15, item.p[2]];
    return room.act(pl, 'pick', item.id);
  };
  const run = (s: number) => { for (let i = 0; i < Math.ceil(s * TPS); i++) room.step(); };
  return { room, messages, conns, join, internals, pick, run };
}

describe('team difficulty and resource budget', () => {
  it('keeps one monitor for solo, two for teams, and one replacement battery per player', () => {
    for (const n of [1, 2, 3, 4]) for (const [index, def] of [[0, L1], [1, L2]] as const) {
      expect(levelDifficulty(index, def, n)).toMatchObject({ teamSize: n, monitors: n === 1 ? 1 : 2, batteries: n });
      const budget = batteryBudget(n);
      expect(budget.secondsPerPlayer).toBe(BATTERY_S * 2);
      expect(budget.runningSecondsPerPlayer).toBeGreaterThanOrEqual(240);
      const t = setup(n, index);
      expect(t.room.items.filter(i => i.kind === 'battery')).toHaveLength(n);
    }
  });

  it('keeps the opening roster and identical supplies on a retry after someone leaves', () => {
    const t = setup(4, 1);
    const incarnation = t.room.incarnation;
    const items = structuredClone(t.room.items);
    t.room.remove(t.conns[3], 10);
    t.room.items = [];
    t.room.bag = { battery: 0, fuse: 3 };
    for (const p of t.room.players.values()) p.st = ST_SPECTATE;
    t.room.step();
    t.run(LEVEL_FADE_S + 0.1);
    expect(t.internals.difficultyPlayers).toBe(4);
    expect(t.room.items).toEqual(items);
    expect(t.room.bag).toEqual({});
    expect(t.room.incarnation).toBe(incarnation + 1);
    expect([...t.room.players.values()].every(p => p.st === ST_OK && p.battery === 1)).toBe(true);
    expect(t.messages.get(1)!.filter(m => m.t === 'room').at(-1)).toMatchObject({ incarnation: incarnation + 1 });
  });
});

describe('L1 drawer authority and harmless props', () => {
  it('requires the shared drawer key and sends the resulting bag to teammates and late observers', () => {
    const t = setup(2), stair = t.room.items.find(i => i.kind === 'stair_key' && !i.decoy)!;
    const drawer = t.room.items.find(i => i.kind === 'drawer_key' && !i.decoy)!;
    expect(t.pick(2, stair)).toBe(false);
    expect(t.room.items).toContain(stair);
    expect(t.pick(1, drawer)).toBe(true);
    expect(t.pick(2, stair)).toBe(true);
    expect(t.room.bag).toMatchObject({ drawer_key: 1, stair_key: 1 });
    t.join(3);
    expect(t.room.players.get(3)!.st).toBe(ST_SPECTATE);
    expect(t.messages.get(3)!.find(m => m.t === 'bag')).toMatchObject({ bag: { drawer_key: 1, stair_key: 1 } });
    expect(t.internals.difficultyPlayers).toBe(2);
  });

  it('preserves decoy labels and refuses props without inventory, noise, or disappearance', () => {
    const t = setup(), decoy = t.room.items.find(i => i.decoy)!;
    let noise = 0;
    t.room.noiseListeners.push(() => noise++);
    expect(decoy.label).toBeTruthy();
    expect(t.pick(1, decoy)).toBe(false);
    expect(t.room.bag).toEqual({});
    expect(t.room.items).toContain(decoy);
    expect(noise).toBe(0);
  });
});

describe('progress-gated monitor encounters', () => {
  it('has no L1 monitor before a real key, fills scaled slots afterwards, and removes them on retry', () => {
    for (const n of [1, 2, 3, 4]) {
      const t = setup(n, 0, true);
      expect(t.internals.monitors).toHaveLength(0);
      t.room.bag = { drawer_key: 1 };
      t.room.step();
      expect(t.internals.monitors).toHaveLength(n === 1 ? 1 : 2);
      for (const m of t.internals.monitors) {
        expect(safeMonitorStart({ x: m.p[0], z: m.p[2] }, t.room.level.spawns, [...t.room.players.values()].map(p => ({ x: p.p[0], z: p.p[2] })))).toBe(true);
      }
      t.internals.loadLevel(0);
      expect(t.internals.monitors).toHaveLength(0);
      expect(t.room.bag).toEqual({});
      t.run(1);
      expect(t.internals.monitors).toHaveLength(0);
    }
  });

  it('waits for a safe location when players cover all candidate points; a late observer never adds a slot', () => {
    const t = setup(2, 0, true);
    t.room.players.get(1)!.p = [-18, 0, 96];
    t.room.players.get(2)!.p = [-64, 0, 96];
    t.room.bag = { drawer_key: 1 };
    t.room.step();
    expect(t.internals.monitors).toHaveLength(0);
    for (const p of t.room.players.values()) p.p = [-42, 0, 73.36];
    t.run(0.5);
    expect(t.internals.monitors).toHaveLength(2);
    const positions = t.internals.monitors.map(m => [...m.p]);
    t.join(3);
    expect(t.internals.monitors.map(m => m.p)).toEqual(positions);
    expect(t.internals.difficultyPlayers).toBe(2);
    expect(t.room.players.get(3)!.st).toBe(ST_SPECTATE);
  });

  it('scales L2 at its opening and permits stair-key debug progress without a drawer softlock', () => {
    for (const n of [1, 2, 3, 4]) expect(setup(n, 1, true).internals.monitors).toHaveLength(n === 1 ? 1 : 2);
    expect(monitorUnlocked(L1.monitor, {})).toBe(false);
    expect(monitorUnlocked(L1.monitor, { drawer_key: 1 })).toBe(true);
    expect(monitorUnlocked(L1.monitor, { stair_key: 1 })).toBe(true);
  });

  it('retains the five-second rescue protection with two monitors', () => {
    const t = setup(2, 1, true), a = t.room.players.get(1)!, b = t.room.players.get(2)!;
    t.room.handle(t.conns[0], { t: 'debug', op: 'down', s: 30 }, 0);
    b.p = [a.p[0] + 0.4, a.p[1], a.p[2]] as Vec3;
    for (let i = 0; i <= REVIVE_S * TPS; i++) { t.room.act(b, 'revive', 1); t.room.step(); }
    expect(a.st).toBe(ST_OK);
    expect(a.heldUntil).toBeUndefined();
    expect(a.safeUntil! - t.room.tick).toBeGreaterThanOrEqual(SAFE_S * TPS - 1);
    expect(t.internals.prey().some(p => p.id === 1)).toBe(false);
  });

  it('two monitors touching a huddle down only one player and leave time for a full rescue', () => {
    const t = setup(3, 1, true), a = t.room.players.get(1)!, b = t.room.players.get(2)!;
    t.run(15.1); // the real room opening and every player's ten-second ready grace must expire first
    for (const p of t.room.players.values()) p.p = [...a.p];
    // Both NPCs report the same simultaneous collision. Room authority must preserve a rescuer.
    for (const m of t.internals.monitors) m.step = () => { m.caught = [1, 2, 3]; };
    t.room.step();
    expect([...t.room.players.values()].filter(p => p.st !== ST_OK)).toHaveLength(1);
    expect(b.safeUntil! - t.room.tick).toBe(Math.ceil(MONITOR_RESCUE_S * TPS));
    for (let i = 0; i <= REVIVE_S * TPS + 1 && a.st !== ST_OK; i++) { expect(t.room.act(b, 'revive', 1)).toBe(true); t.room.step(); }
    expect(a.st).toBe(ST_OK);
    expect(b.st).toBe(ST_OK);
    for (const m of t.internals.monitors) m.step = () => { m.caught = [1]; };
    t.run(SAFE_S - 0.1);
    expect(a.st).toBe(ST_OK);
    t.run(0.2);
    expect(a.st).not.toBe(ST_OK); // protection expires; this is a rescue window, not immunity
  });
});
