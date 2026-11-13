import { describe, expect, it } from 'vitest';
import { BossAI, type BossPlayer } from '../../server/ai/role_boss.ts';
import { F_HIDE, type ServerMsg, type Vec3 } from '../../shared/protocol.ts';
import { NavGraph } from '../../shared/campus/nav.ts';
import { Room, type Conn } from '../../server/room.ts';
import { monitorDisplayName } from '../../shared/studentNames.ts';

const player = (p: Vec3, id = 1): BossPlayer => ({ id, p, f: 0 });
const target = player([0, 0, 8]);
const begin = (los = () => true) => {
  const boss = new BossAI([0, 0, 0], 'standard', los);
  boss.step(3, [target]);
  return boss;
};

describe('值周代号025 authoritative gym attacks', () => {
  it('keeps the default room anonymous and never draws a boss even with a known boss seed', () => {
    const nav = new NavGraph(); nav.addNode({ x: -100, y: 0, z: 60 });
    expect(monitorDisplayName(21, 4, 2)).toBe('值周代号025');
    const got: ServerMsg[] = [];
    const conn: Conn = { id: 1, name: '同学', send: m => got.push(m), sendRaw: s => got.push(JSON.parse(s)) };
    const room = new Room('PLAIN', 21, nav, 4); room.add(conn, 0); room.step();
    const snap = got.filter(m => m.t === 'snap').at(-1)!;
    expect(snap).not.toHaveProperty('boss');
    expect(snap.mobs.filter(m => m.kind === 'monitor')).toHaveLength(2);
    expect(snap.mobs.filter(m => m.kind === 'monitor').every(m => m.name === '值周生' && m.form === 'normal')).toBe(true);
    expect(got.find(m => m.t === 'room')).toMatchObject({ namedMonitors: false });
  });

  it('telegraphs a locked circle and only catches when its windup ends', () => {
    const boss = begin();
    expect(boss.snapshot()).toMatchObject({ name: '值周代号025', phase: 'windup', skill: 'chalk-circle', target: target.p });
    expect(boss.caught).toEqual([]);
    boss.step(1.7, [target]); expect(boss.caught).toEqual([]);
    boss.step(.1, [target]); expect(boss.caught).toEqual([1]);
    expect(boss.phase).toBe('active');
  });

  it('allows leaving the circle and ignores hidden or other-floor players', () => {
    const boss = begin();
    boss.step(1.8, [player([4, 0, 8]), player([0, 3.6, 8], 2), { ...target, id: 3, f: F_HIDE }]);
    expect(boss.caught).toEqual([]);
    expect(boss.snapshot().target).toEqual([0, 0, 8]);
    expect(boss.p).toEqual([0, 0, 0]);
  });

  it('rechecks walls at the hit boundary and does not cast through a wall', () => {
    let clear = true;
    const boss = begin(() => clear);
    clear = false; boss.step(1.8, [target]); expect(boss.caught).toEqual([]);
    const blocked = begin(() => false); expect(blocked.phase).toBe('rest');
  });

  it('keeps recovery and cooldown, then alternates to a finite sweep', () => {
    const boss = begin();
    boss.step(1.8, []); boss.step(.4, []); boss.step(1.6, [target]);
    expect(boss.phase).toBe('rest');
    boss.step(9, [target]); expect(boss.phase).toBe('rest'); expect(boss.caught).toEqual([]);
    boss.step(1, [target]); expect(boss.snapshot()).toMatchObject({ phase: 'windup', skill: 'rollcall-sweep' });
    boss.step(1.8, [player([1, 0, 20]), player([2, 0, 10], 2), player([0, 0, -1], 3), player([0, 0, 25], 4)]);
    expect(boss.caught).toEqual([1]);
  });

  it.each([2, 3])('turns only a randomly drawn 值周代号025 name into the boss in slot %i, preserving other identities and retries', mob => {
    let seed = 0;
    while (monitorDisplayName(seed, 4, mob) !== '值周代号025') seed++;
    const nav = new NavGraph(); nav.addNode({ x: -100, y: 0, z: 60 });
    const got: ServerMsg[] = [];
    const conn: Conn = { id: 1, name: '同学', send: m => got.push(m), sendRaw: s => got.push(JSON.parse(s)) };
    const room = new Room('ABCD', seed, nav, 4, 'story', { namedMonitors: true });
    room.add(conn, 0); room.step();
    const snap = got.filter(m => m.t === 'snap').at(-1)!;
    expect(got.filter(m => m.t === 'room').at(-1)).toMatchObject({ difficulty: 'story' });
    expect(snap).toMatchObject({ boss: { id: mob, name: '值周代号025' } });
    if (snap.t !== 'snap') throw new Error('missing snap');
    expect(snap.mobs.filter(m => m.kind === 'monitor').map(m => m.id).sort()).toEqual([2, 3]);
    expect(snap.mobs.find(m => m.id === (mob === 2 ? 3 : 2))).toMatchObject({ form: 'normal', name: monitorDisplayName(seed, 4, mob === 2 ? 3 : 2) });
    (room as unknown as { loadLevel(level: number): void }).loadLevel(4);
    room.step();
    expect(got.filter(m => m.t === 'snap').at(-1)).toMatchObject({ boss: { id: mob, name: '值周代号025' } });
  });

  it('keeps both L5 monitors ordinary when neither random name is 值周代号025', () => {
    const nav = new NavGraph(); nav.addNode({ x: -100, y: 0, z: 60 });
    let seed = 0;
    while ([2, 3].some(id => monitorDisplayName(seed, 4, id) === '值周代号025')) seed++;
    const got: ServerMsg[] = [];
    const conn: Conn = { id: 1, name: '同学', send: m => got.push(m), sendRaw: s => got.push(JSON.parse(s)) };
    const other = new Room('EFGH', seed, nav, 4, 'standard', { namedMonitors: true });
    const peer: Conn = { ...conn, id: 2 }; other.add(peer, 0); other.step();
    expect(got.filter(m => m.t === 'snap').at(-1)).not.toHaveProperty('boss');
    const snap = got.filter(m => m.t === 'snap').at(-1)!;
    expect(snap.mobs.filter(m => m.kind === 'monitor')).toEqual(expect.arrayContaining([2, 3].map(id => expect.objectContaining({ id, form: 'normal', name: monitorDisplayName(seed, 4, id) }))));
  });

  it('also activates a drawn name outside the gym, using the same identity and skills', () => {
    let seed = 0;
    while (monitorDisplayName(seed, 5, 2) !== '值周代号025') seed++;
    const nav = new NavGraph(); nav.addNode({ x: -30, y: 14.4, z: 92.3 });
    const got: ServerMsg[] = [];
    const conn: Conn = { id: 1, name: '同学', send: m => got.push(m), sendRaw: s => got.push(JSON.parse(s)) };
    const room = new Room('ABCD', seed, nav, 5, 'standard', { namedMonitors: true }); room.add(conn, 0); room.step();
    expect(got.filter(m => m.t === 'snap').at(-1)).toMatchObject({ boss: { id: 2, name: '值周代号025' }, mobs: expect.arrayContaining([expect.objectContaining({ id: 2, form: 'role_boss', name: '值周代号025' })]) });
  });
});
