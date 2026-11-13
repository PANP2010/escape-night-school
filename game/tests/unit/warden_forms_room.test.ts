import { describe, expect, it, vi } from 'vitest';
import { Room, type Conn } from '../../server/room.ts';
import type { WardenAI, WardenEnv } from '../../server/ai/warden.ts';
import { MonitorAI } from '../../server/ai/monitor.ts';
import { NavGraph } from '../../shared/campus/nav.ts';
import { CollisionWorld } from '../../shared/campus/collision.ts';
import { TICK_MS } from '../../shared/constants.ts';
import { F_HIDE, ST_DOWN, ST_OK, type ServerMsg } from '../../shared/protocol.ts';
import { wardenBaseForm, wardenForm, WardenStare } from '../../shared/wardenForms.ts';

type Internals = {
  warden: WardenAI;
  wardenEnv: WardenEnv;
  wardenStare: WardenStare;
  monitors: MonitorAI[];
  barrierWorld: CollisionWorld;
  loadLevel(index: number): void;
};

function setup(level = 0) {
  const nav = new NavGraph();
  nav.chain([{ x: 0, y: 0, z: -8 }, { x: 0, y: 0, z: -30 }]);
  const room = new Room('FORM', 3, nav, level), got: ServerMsg[] = [];
  for (const id of [1, 2]) {
    const conn: Conn = { id, name: `p${id}`, send: m => { if (id === 1) got.push(m); }, sendRaw: s => { if (id === 1) got.push(JSON.parse(s)); } };
    room.add(conn, 0);
    const player = room.players.get(id)!;
    player.p = [0, 0, 0]; player.yaw = id === 1 ? 0 : Math.PI; player.pitch = 0;
  }
  const inner = room as unknown as Internals;
  inner.warden.p = [0, 0, -8];
  inner.wardenEnv.los = () => true;
  const realStep = inner.warden.step.bind(inner.warden);
  // Keep the subject still so these tests measure gaze time, independently of pursuit travel.
  inner.warden.step = vi.fn();
  const run = (ticks: number) => { for (let i = 0; i < ticks; i++) room.step(); };
  const snaps = () => got.filter((m): m is Extract<ServerMsg, { t: 'snap' }> => m.t === 'snap');
  return { room, got, inner, realStep, run, snaps, p1: room.players.get(1)!, p2: room.players.get(2)! };
}

describe('Warden forms in authoritative rooms', () => {
  it('includes the full form and animation for a reconnect between metadata keyframes', () => {
    const { room, inner, run, snaps, p1 } = setup(1);
    inner.monitors.push(new MonitorAI({ graph: inner.wardenEnv.graph, los: () => true }, [0, 0, -20]));
    run(2);
    expect(snaps().at(-1)!.mobs.every(m => m.form === undefined && m.anim === undefined)).toBe(true);
    const restored: ServerMsg[] = [], previous = p1.conn;
    room.disconnect(previous);
    expect(room.resume(previous, { id: 9, name: 'restored', send: m => { restored.push(m); }, sendRaw: raw => { restored.push(JSON.parse(raw)); } }, 100)).toBe(true);
    const full = restored.find((m): m is Extract<ServerMsg, { t: 'snap' }> => m.t === 'snap')!;
    expect(full.mobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 1, kind: 'warden', form: 'night', anim: inner.warden.anim, target: 0, st: 0 }),
      expect.objectContaining({ id: 2, kind: 'monitor', form: 'normal', anim: 'idle', target: 0, st: 0 }),
    ]));
  });

  it('uses night on L2 and preserves rollcall / finale', () => {
    expect([0, 1, 2, 3, 7].map(wardenBaseForm)).toEqual(['normal', 'night', 'normal', 'rollcall', 'finale']);
    expect(wardenForm(3, true)).toBe('rollcall');
    expect(wardenForm(7, true)).toBe('finale');
    for (const [level, form] of [[0, 'normal'], [1, 'night'], [3, 'rollcall'], [7, 'finale']] as const) {
      const { run, snaps } = setup(level);
      run(1);
      if (level === 7) expect(snaps()[0].mobs).toEqual([]); // finale appears only when the register starts its pursuit
      else expect(snaps()[0].mobs[0].form).toBe(form);
    }
  });

  it.each([3, 7])('does not replace level %i’s authored form after two seconds of gaze', level => {
    const { run, snaps, inner, got } = setup(level);
    run(60);
    expect(inner.wardenStare.changed).toBe(false);
    expect(snaps().flatMap(s => s.mobs).filter(m => m.id === 1 && m.form).every(m => m.form === wardenBaseForm(level))).toBe(true);
    expect(got.filter(m => m.t === 'event' && m.kind === 'line')).toEqual([]);
  });

  it('changes at two seconds, enters pursuit without teleporting and sends the exact stare line once', () => {
    const { inner, run, snaps, got, p1 } = setup();
    run(2000 / TICK_MS - 1);
    expect(inner.wardenStare.changed).toBe(false);
    // A natural detection may queue spot earlier in the same tick; only the form's stare must be heard.
    inner.warden.step = () => inner.warden.forceChase(inner.warden.p, inner.warden.yaw, 1, p1.p);
    run(1);
    inner.warden.step = vi.fn();
    expect(inner.warden.p).toEqual([0, 0, -8]);
    expect(inner.warden.state).toBe('chase');
    expect(inner.warden.target).toBe(1);
    expect(snaps().at(-1)!.mobs[0]).toMatchObject({ form: 'changed', target: 1 });
    const stare = { t: 'event', kind: 'line', id: 'likeme', text: '你喜欢我吗？看着我的眼睛，你真的喜欢我吗？！', mob: 1 };
    expect(got.filter(m => m.t === 'event')).toEqual([stare]);
    run(80);
    expect(got.filter(m => m.t === 'event')).toEqual([stare]);
  });

  it('does not add together separate players’ short looks', () => {
    const { p1, p2, inner, run } = setup();
    run(20);
    p1.yaw = Math.PI; p2.yaw = 0;
    run(20);
    expect(inner.wardenStare.changed).toBe(false);
    run(19);
    expect(inner.wardenStare.changed).toBe(false);
    run(1);
    expect(inner.warden.target).toBe(2);
  });

  it('starts real AI pursuit after the gaze and physically advances toward the viewer', () => {
    const { inner, realStep, run } = setup();
    inner.warden.step = realStep;
    inner.wardenEnv.walkable = () => true;
    // He patrols away down the empty corridor, with his back to the viewer: no ordinary sight trigger.
    run(39);
    expect(inner.warden.state).toBe('patrol');
    expect(inner.wardenStare.changed).toBe(false);
    run(1);
    expect(inner.wardenStare.changed).toBe(true);
    expect(inner.warden.state).toBe('chase');
    expect(inner.warden.target).toBe(1);
    const before = inner.warden.p[2];
    run(5);
    expect(inner.warden.p[2]).toBeGreaterThan(before + 0.9);
    expect(inner.warden.state).toBe('chase');
  });

  it.each(['yaw', 'pitch', 'wall', 'hidden', 'down'] as const)('resets the uninterrupted timer when %s breaks the gaze', kind => {
    const { p1, inner, run } = setup();
    run(20);
    if (kind === 'yaw') p1.yaw = Math.PI / 3;
    if (kind === 'pitch') p1.pitch = Math.PI / 2;
    if (kind === 'wall') inner.wardenEnv.los = () => false;
    if (kind === 'hidden') p1.f = F_HIDE;
    if (kind === 'down') p1.st = ST_DOWN;
    run(1);
    p1.yaw = 0; p1.pitch = 0; p1.f = 0; p1.st = ST_OK; inner.wardenEnv.los = () => true;
    run(39);
    expect(inner.wardenStare.changed).toBe(false);
    run(1);
    expect(inner.wardenStare.changed).toBe(true);
  });

  it('requires a central head / upper chest view at a readable distance', () => {
    const { p1, inner, run } = setup();
    p1.yaw = Math.PI / 6; // inside the monitor's broad cone, outside a deliberate stare
    run(60);
    p1.yaw = 0; inner.warden.p = [0, 0, -21];
    run(60);
    expect(inner.wardenStare.changed).toBe(false);
    // Knees alone visible under an obstacle do not count as looking at his face.
    inner.warden.p = [0, 0, -8]; inner.wardenEnv.los = (_a, b) => b.y < 1;
    run(60);
    expect(inner.wardenStare.changed).toBe(false);
  });

  it('a monitor blink interrupts the gaze on the tick the screen goes black', () => {
    const { inner, run } = setup(1);
    const monitor = new MonitorAI({ graph: inner.wardenEnv.graph, los: () => true }, [0, 0, -8]);
    inner.monitors.push(monitor);
    monitor.step = vi.fn();
    run(39);
    monitor.step = () => { monitor.blinking = true; };
    run(1);
    expect(inner.wardenStare.changed).toBe(false);
    monitor.step = vi.fn();
    monitor.blinking = false;
    run(39);
    expect(inner.wardenStare.changed).toBe(false);
    run(1);
    expect(inner.wardenStare.changed).toBe(true);
  });

  it('does not see through level barriers even when the campus / door ray is clear', () => {
    const { inner, run } = setup();
    run(20);
    inner.barrierWorld = new CollisionWorld([{ minX: -1, maxX: 1, minY: 0, maxY: 2, minZ: -4.1, maxZ: -3.9 }]);
    run(40);
    expect(inner.wardenStare.changed).toBe(false);
    inner.barrierWorld = new CollisionWorld();
    run(39);
    expect(inner.wardenStare.changed).toBe(false);
    run(1);
    expect(inner.wardenStare.changed).toBe(true);
  });

  it('resets changed and stale gaze timers when a level reloads', () => {
    const { inner, run, room, p1 } = setup();
    run(40);
    expect(inner.wardenStare.changed).toBe(true);
    inner.loadLevel(1);
    expect(inner.wardenStare.changed).toBe(false);
    expect(wardenForm(room.levelIndex, inner.wardenStare.changed)).toBe('night');
    expect(p1.st).toBe(ST_OK);
  });

  it('composes team and night hearing once without changing the shared noise event', () => {
    const { room, inner } = setup(1);
    room.noiseBlocked = () => false;
    const hear = vi.spyOn(inner.warden, 'hear'), others: number[] = [];
    room.noise.subscribe(events => others.push(events[0].r));
    const event = { kind: 'walk' as const, x: 0, y: 0, z: -14.8, r: 4 };
    room.noise.emit(event); room.noise.flush(1);
    expect(hear.mock.calls[0][0].r).toBeCloseTo(4 * 1.15);
    expect(inner.warden.state).toBe('investigate'); // 6.8 m is audible only with both factors
    expect(event.r).toBe(4); expect(others).toEqual([4]);
    inner.warden.reset(0);
    room.noise.emit({ ...event, z: -15 }); room.noise.flush(2);
    expect(inner.warden.state).toBe('patrol'); // 7 m exceeds 4 × 1.15 × 1.5
  });

  it('amplifies only Warden’s L2 hearing, leaves the shared event untouched and retains wall attenuation', () => {
    const { room, inner, p2 } = setup(1);
    p2.st = ST_DOWN; // isolate the form multiplier from the independently tested team-size multiplier
    room.noiseBlocked = () => false;
    // The baseline AI consumes the scaled event; the noise bus still gives other subscribers the original.
    const hear = vi.spyOn(inner.warden, 'hear');
    const original = { kind: 'walk' as const, x: 0, y: 0, z: -13, r: 4 };
    const others: number[] = [];
    room.noise.subscribe(events => others.push(events[0].r));
    room.noise.emit(original); room.noise.flush(1);
    expect(hear.mock.calls[0][0].r).toBe(4); // the original AI applies the form multiplier once
    expect(original.r).toBe(4);
    expect(others).toEqual([4]);
    expect(inner.warden.state).toBe('investigate'); // five metres: outside normal hearing, inside night hearing
    inner.warden.reset(0);
    room.noise.emit({ ...original, z: -15 }); room.noise.flush(2);
    expect(inner.warden.state).toBe('patrol'); // seven metres: catches accidental double amplification after AI integration
    hear.mockRestore();
    inner.warden.hear({ ...original, r: 6 }, () => true);
    expect(inner.warden.state).toBe('patrol'); // through a wall the six metre radius remains halved
    inner.loadLevel(0);
    room.tick += 30 * 20;
    inner.warden.reset(0);
    room.noise.emit(original); room.noise.flush(3);
    expect(inner.warden.state).toBe('patrol'); // the very same listener returns to normal hearing after a level change
  });
});
