import { expect, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { frame, showCanvas } from '../e2e/draw.ts';
import { CollisionWorld } from '../../shared/campus/collision.ts';
import { NavGraph, lineOfSight, walk as capsuleWalk } from '../../shared/campus/nav.ts';
import { ACT_REACH, boxAt, inReach, KEY_H } from '../../shared/interact.ts';
import { MIRROR_DOORS } from '../../shared/levels/l7.ts';

export type Point = { x: number; y: number; z: number };
export type Message = { t: string; [key: string]: any };
export type Mode = 'desktop' | 'mobile';
export class Flow {
  readonly journal: { at: number; label: string; data: unknown }[] = [];
  readonly messages: Message[] = [];
  readonly sent: Message[] = [];
  readonly errors: string[] = [];
  readonly mobs = new Map<number, any>();
  readonly players = new Map<number, any>();
  private readonly recentInputs: { seq: number; c?: number; p: number[]; f: number }[] = [];
  transportCount = 0;
  transportClosures = 0;
  snap?: Message;
  private begun = Date.now();
  private campaign?: { code: string; seed: number; id: number };
  readonly page: Page;
  readonly info: TestInfo;
  readonly mode: Mode;
  constructor(page: Page, info: TestInfo, mode: Mode) {
    this.page = page; this.info = info; this.mode = mode;
    page.on('pageerror', e => this.errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') this.errors.push(m.text()); });
    page.on('websocket', ws => {
      const transport = new URL(ws.url());
      const number = ++this.transportCount;
      this.note('transport', { number, origin: transport.origin, path: transport.pathname });
      expect(new URL(ws.url()).pathname, 'campaign must keep the ordinary /ws transport').toBe('/ws');
      ws.on('socketerror', e => this.errors.push(`WebSocket: ${e}`));
      ws.on('close', () => { this.transportClosures++; this.note('transport-closed', { number }); });
      ws.on('framereceived', ({ payload }) => {
        const m = JSON.parse(payload.toString()) as Message;
        // Allowlist: never persist welcome/resume credentials added by reconnect work.
        if (m.t === 'snap') {
          this.snap = m;
          for (const p of m.players ?? []) this.players.set(p.id, { ...this.players.get(p.id), ...p, st: p.st ?? 0 });
          if (m.gone?.length || m.doors?.length) this.messages.push({ t: 'snap', tick: m.tick, gone: m.gone, doors: m.doors });
          for (const mob of m.mobs ?? []) this.mobs.set(mob.id, { ...this.mobs.get(mob.id), ...mob });
        } else if (m.t === 'event' && ['intro', 'clear'].includes(m.kind)) {
          this.messages.push(m);
        } else if (['room', 'items', 'keys', 'bag', 'power', 'doors', 'loop', 'warp', 'broadcast', 'fade',
          'complete', 'completed', 'finale', 'gym', 'gym-sound', 'exam', 'l7', 'caught', 'blink', 'trip', 'correct', 'error', 'intro'].includes(m.t)) {
          const previousRoom = m.t === 'room' ? this.latest('room') : undefined;
          this.messages.push(m);
          if (m.t === 'room' && (!previousRoom || previousRoom.level !== m.level || previousRoom.seed !== m.seed
            || previousRoom.incarnation !== m.incarnation)) { this.mobs.clear(); this.players.clear(); }
          if (m.t === 'correct' && !m.forced) this.note('movement-rejected', { correction: m, inputs: [...this.recentInputs] });
        }
      });
      ws.on('framesent', ({ payload }) => {
        const m = JSON.parse(payload.toString()) as Message;
        if (m.t === 'input') {
          this.recentInputs.push({ seq: m.seq, c: m.c, p: m.p, f: m.f });
          if (this.recentInputs.length > 20) this.recentInputs.shift();
        }
        if (['act', 'door', 'debug', 'broadcast', 'exam', 'l7', 'rollcall', 'push', 'take-key', 'intro-skip', 'ready'].includes(m.t)) this.sent.push(m);
      });
    });
  }
  note(label: string, data: unknown = {}) {
    this.journal.push({ at: Date.now() - this.begun, label, data });
    console.log(`FULLFLOW ${this.mode} ${label}`, JSON.stringify(data));
  }
  latest(t: string) { return this.messages.findLast(m => m.t === t); }
  assertTransport() {
    expect(this.transportCount, 'the complete campaign must retain its single original /ws connection').toBe(1);
    expect(this.transportClosures, 'the original /ws must remain connected through the campaign ending').toBe(0);
  }
  async state() {
    return this.page.evaluate(() => {
      const g = window.__escape.game() as any;
      return { p: [g.body.x, g.body.y, g.body.z], id: g.myId, level: g.level.index, seed: g.level.seed,
        corrections: g.corrections, down: g.down, spectate: g.spectate, hiding: g.hiding,
        target: g.target(), route: g.route, routeAt: g.routeAt, completed: g.completed };
    });
  }
  async save() {
    await writeFile(this.info.outputPath('authority-journal.json'), JSON.stringify({
      mode: this.mode, puzzleIsolation: process.env.ESC_FULLFLOW_NATURAL !== '1',
      runId: process.env.ESC_FULLFLOW_RUN_ID, head: process.env.ESC_FULLFLOW_HEAD,
      transportCount: this.transportCount, transportClosures: this.transportClosures,
      journal: this.journal, messages: this.messages, sent: this.sent, errors: this.errors,
      snap: this.snap, state: await this.state().catch(() => null),
    }, null, 2));
  }
  async checkpoint(label: string) {
    const state = await this.state();
    await expect.poll(() => {
      const p = this.snap?.players?.find((p: any) => p.id === state.id)?.p;
      return p ? Math.hypot(...p.map((v: number, i: number) => v - state.p[i]) as [number, number, number]) : Infinity;
    }, { timeout: 5000, message: `${label}: latest authority must accept the walked position` }).toBeLessThan(.7);
    expect(this.errors, label).toEqual([]);
    expect(this.messages.filter(m => m.t === 'correct' && !m.forced), `${label}: rejected movement`).toEqual([]);
    this.note(label, state);
  }
  async photo(label: string) {
    await frame(this.page);
    try {
      const render = await this.page.evaluate(async () => {
        const img = document.getElementById('e2e-shot') as HTMLImageElement;
        await img.decode();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const c = document.createElement('canvas'); c.width = 160; c.height = 90;
        const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0, c.width, c.height);
        const pixels = ctx.getImageData(0, 0, c.width, c.height).data;
        let max = 0, lit = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          const v = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]);
          max = Math.max(max, v); if (v > 8) lit++;
        }
        return { max, litFraction: lit / (pixels.length / 4) };
      });
      expect(render.max, `${label}: the actual WebGL render must contain visible pixels`).toBeGreaterThan(8);
      expect(render.litFraction, `${label}: a black WebGL frame cannot be evidence`).toBeGreaterThan(.001);
      const png = await this.page.screenshot({ path: this.info.outputPath(`${label}.png`) });
      const pagePixels = await this.page.evaluate(async b64 => {
        const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
        const c = document.createElement('canvas'); c.width = 160; c.height = 90;
        const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0, c.width, c.height);
        const pixels = ctx.getImageData(0, 0, c.width, c.height).data;
        let sum = 0, max = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          const v = .299 * pixels[i] + .587 * pixels[i + 1] + .114 * pixels[i + 2];
          sum += v; max = Math.max(max, v);
        }
        return { max, mean: sum / (pixels.length / 4) };
      }, png.toString('base64'));
      expect(pagePixels.max, `${label}: saved PNG must contain the painted page`).toBeGreaterThan(8);
      expect(pagePixels.mean, `${label}: saved PNG cannot be an empty compositor frame`).toBeGreaterThan(.5);
      this.note('screenshot-evidence', { label, render, page: pagePixels });
    } finally { await this.page.evaluate(() => document.getElementById('e2e-shot')?.remove()); }
  }
  async ready(level: number) {
    await expect(this.page.locator('#room-code')).toContainText(`第 ${level + 1} 关`, { timeout: 25_000 });
    await this.page.waitForFunction(level => {
      const g = window.__escape.game() as any;
      return g?.spawnSynced && g.level.index === level && g.presentationReady && !g.intro?.active;
    }, level, { timeout: 25_000 });
    await expect(this.page.locator('#fade-overlay')).toBeHidden({ timeout: 15_000 });
    expect(this.latest('room')?.level).toBe(level);
    this.assertTransport();
    const state = await this.state(), room = this.latest('room')!;
    const identity = { code: room.code, seed: room.seed, id: state.id };
    if (!this.campaign) this.campaign = identity;
    expect(identity, 'every chapter must preserve the original room, seed and player').toEqual(this.campaign);
    expect(state.seed).toBe(room.seed);
    if (level !== 7 && process.env.ESC_FULLFLOW_NATURAL !== '1') {
      // Per-NPC isolation leaves the player in the AI viewers table. The all-player grace would make the
      // directed monitor test incapable of seeing its watcher even after debug monitor enables that NPC.
      await this.page.evaluate(() => { window.__escape.debug('safe', 600, 1); window.__escape.debug('safe', 600, 2); });
      this.note(`L${level + 1}-puzzle-isolation`, 'debug safe mob 1/2 disables each NPC until its directed check; this is not a difficulty playtest');
    }
    await this.checkpoint(`L${level + 1}-entry`);
  }
  async walk(points: [number, number][], arrival?: Point) {
    const before = await this.state();
    await this.page.evaluate(points => {
      const g = window.__escape.game()!;
      g.autopilot([[g.pos.x, g.pos.z], ...points]);
    }, points);
    await expect.poll(() => this.page.evaluate(() => window.__escape.game()!.autopilotDone),
      { timeout: 55_000, message: `walk timed out: ${JSON.stringify(points)}` }).toBe(true);
    const after = await this.state();
    expect(after.corrections, 'autopilot uses normal collision and authority').toBe(before.corrections);
    expect(after.down || after.spectate, 'a captured player did not finish the route').toBe(false);
    if (arrival) expect(Math.hypot(after.p[0] - arrival.x, after.p[1] - arrival.y, after.p[2] - arrival.z)).toBeLessThan(.45);
    await this.checkpoint('walk-authorized');
  }
  private async pathTo(at: Point, exitRadius?: number, keepClosed?: number): Promise<[number, number][]> {
    const data = await this.page.evaluate(keepClosed => {
      const g = window.__escape.game() as any, col = g.collision ?? g.campus.collision;
      if (!g.navGraph?.nodes.length) throw new Error('No authoritative nav graph received');
      // Planning can cross a door that ordinary autopilot will open. Locked doors and every wall remain solid.
      const passable = new Set((g.campusDoorBox ?? []).filter((_: number, id: number) =>
        id !== keepClosed && (!g.doorLocked[id] || g.heldKeys.includes(id)) && !g.regionLocked(id)));
      return { nodes: g.navGraph.nodes, adj: g.navGraph.adj, from: { x: g.body.x, y: g.body.y, z: g.body.z },
        boxes: col.boxes.filter((_: unknown, id: number) => col !== g.campus.collision || !passable.has(id)), holes: col.holes,
        closedDoor: keepClosed === undefined ? undefined : g.doors[keepClosed] };
    }, keepClosed);
    const col = new CollisionWorld(data.boxes);
    for (const hole of data.holes) col.addHole(...hole as [number, number, number, number]);
    const nav = new NavGraph(); nav.nodes.push(...data.nodes); nav.adj.push(...data.adj);
    if (data.closedDoor) {
      const d = data.closedDoor, r = .3;
      const portal = new CollisionWorld([{ minX: d.box.x0 - r, maxX: d.box.x1 + r, minZ: d.box.z0 - r, maxZ: d.box.z1 + r,
        minY: d.y0 ?? 0, maxY: d.y1 ?? (d.y0 ?? 0) + 3 }]);
      for (let id = 0; id < nav.nodes.length; id++) nav.adj[id] = nav.adj[id].filter(next =>
        lineOfSight(portal, { ...nav.nodes[id], y: nav.nodes[id].y + .85 }, { ...nav.nodes[next], y: nav.nodes[next].y + .85 }));
    }
    const ordered = (p: Point) => nav.nodes.map((n, id) => ({ id, d: Math.hypot(n.x - p.x, (n.y - p.y) * 3, n.z - p.z) }))
      .sort((a, b) => a.d - b.d).slice(0, 64);
    const start = ordered(data.from).find(({ id }) => {
      const n = nav.nodes[id], ys = capsuleWalk(col, data.from, [[n.x, n.z]]);
      return ys && Math.abs(ys[0] - n.y) < .4;
    });
    if (!start) throw new Error(`No walkable connector from player to nav: ${JSON.stringify(data.from)}`);
    // The authority graph is static across ordinary region barriers. Validate only candidate A* edges
    // against the current collision snapshot, pruning blocked directions in this planning copy and retrying.
    const checked = new Set<string>();
    const walkablePath = (target: number) => {
      for (;;) {
        const ids = nav.astar(start.id, target);
        if (!ids) return null;
        let blocked = false;
        for (let i = 1; i < ids.length; i++) {
          const a = ids[i - 1], b = ids[i], edge = `${a}:${b}`;
          if (checked.has(edge)) continue;
          const to = nav.nodes[b], ys = capsuleWalk(col, nav.nodes[a], [[to.x, to.z]]);
          if (ys && Math.abs(ys[0] - to.y) < .4) checked.add(edge);
          else { nav.adj[a] = nav.adj[a].filter(next => next !== b); blocked = true; }
        }
        if (!blocked) return ids;
      }
    };
    for (const { id } of ordered(at)) {
      const n = nav.nodes[id], ids = walkablePath(id);
      if (!ids) continue;
      const ys = capsuleWalk(col, n, [[at.x, at.z]]);
      const path = ids.map(i => [nav.nodes[i].x, nav.nodes[i].z] as [number, number]);
      if (ys && Math.abs(ys[0] - at.y) < .4) return [...path, [at.x, at.z]];
      // Exit centers can sit behind stair geometry. A physically reached node inside the real zone suffices.
      if (exitRadius !== undefined && Math.hypot(n.x - at.x, n.z - at.z) <= exitRadius && Math.abs(n.y - at.y) < 1.5) return path;
    }
    throw new Error(`No walkable authoritative navigation connector to ${JSON.stringify(at)}`);
  }
  async go(at: Point) {
    await this.walk(await this.pathTo(at), at);
  }
  /** Reach a closed keyed door from a physically connected side without autopilot opening it before the real interaction. */
  async approachDoor(id: number) {
    const before = await this.state();
    const door = await this.page.evaluate(id => {
      const g = window.__escape.game() as any, d = g.doors[id];
      if (!d) throw new Error(`No campaign door ${id}`);
      return { x: d.x, z: d.z, y: d.y0 ?? 0, alongX: d.alongX, open: g.doorOpen[id], locked: g.doorLocked[id] };
    }, id);
    expect(door.open, 'the explicit unlock interaction must begin with a closed door').toBe(false);
    expect(door.locked, 'the explicit unlock interaction must begin with an authoritative lock').toBe(true);
    const stands = [-1, 1].map(side => ({ x: door.x + (door.alongX ? 0 : side * 1.15), y: door.y,
      z: door.z + (door.alongX ? side * 1.15 : 0) })).sort((a, b) =>
      Math.hypot(a.x - before.p[0], a.z - before.p[2]) - Math.hypot(b.x - before.p[0], b.z - before.p[2]));
    let route: [number, number][] | undefined;
    const refused: string[] = [];
    for (const at of stands) {
      try { route = await this.pathTo(at, undefined, id); break; }
      catch (error) { refused.push(String(error)); }
    }
    if (!route) throw new Error(`Neither side of closed door ${id} is walkable: ${refused.join('; ')}`);
    // Keep ordinary autopilot on the distant route. Every prefix segment stays outside the door's
    // 1.8 m automatic-opening reach, including 0.6 m for waypoint tolerance and frame movement.
    let previous: [number, number] = [before.p[0], before.p[2]], prefix = 0;
    for (const next of route) {
      const dx = next[0] - previous[0], dz = next[1] - previous[1], length2 = dx * dx + dz * dz;
      const t = length2 ? Math.max(0, Math.min(1, ((door.x - previous[0]) * dx + (door.z - previous[1]) * dz) / length2)) : 0;
      if (Math.hypot(previous[0] + t * dx - door.x, previous[1] + t * dz - door.z) < 2.4) break;
      prefix++; previous = next;
    }
    if (prefix) await this.walk(route.slice(0, prefix));
    route = route.slice(prefix);
    await this.page.evaluate(async ({ route, id }) => {
      const g = window.__escape.game() as any, until = performance.now() + 55_000;
      let openedAt = -Infinity;
      g.route = null; // Stop the optional automation; the door approach below uses ordinary movement/action input.
      try {
        for (const [x, z] of route) while (Math.hypot(g.body.x - x, g.body.z - z) >= .3) {
          if (performance.now() > until) throw new Error(`Closed-door approach ${id} timed out`);
          if (g.down || g.spectate) throw new Error(`Captured during closed-door approach ${id}`);
          g.input.yaw = Math.atan2(g.body.x - x, g.body.z - z); g.input.pitch = 0;
          const target = g.target();
          if (target?.kind === 'use' && target.id >= 0 && target.id !== id && !g.doorOpen[target.id] && performance.now() - openedAt > 500) {
            g.input.press('KeyE'); g.input.release('KeyE'); openedAt = performance.now();
          }
          g.input.press('KeyW');
          await new Promise(resolve => requestAnimationFrame(resolve));
        }
      } finally { g.input.release('KeyW'); g.input.release('KeyE'); }
    }, { route, id });
    expect((await this.state()).corrections).toBe(before.corrections);
    expect(await this.page.evaluate(id => {
      const g = window.__escape.game() as any; return { open: g.doorOpen[id], locked: g.doorLocked[id] };
    }, id), 'movement must leave the target closed and locked for the real E/object tap').toEqual({ open: false, locked: true });
    await this.aim({ x: door.x, y: door.y + 1.2, z: door.z });
    await this.checkpoint('closed-keyed-door-approach');
  }
  async aim(at: Point) {
    await this.page.evaluate(at => {
      const g = window.__escape.game() as any;
      const dx = at.x - g.body.x, dz = at.z - g.body.z;
      g.input.yaw = Math.atan2(-dx, -dz);
      g.input.pitch = Math.atan2(at.y - (g.body.y + g.eye), Math.hypot(dx, dz));
    }, at);
    await this.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  /** Find a clear standing point near a prop, then walk the actual server graph. No position mutation/teleport. */
  async approach(at: Point, floor: number, itemBoxRadius = 0) {
    const data = await this.page.evaluate(({ at, itemBoxRadius }) => {
      const g = window.__escape.game() as any, nav = g.navGraph, col = g.collision ?? g.campus.collision;
      const item = itemBoxRadius > 0 ? g.items.find((i: any) => Math.hypot(i.p[0] - at.x, i.p[2] - at.z) < .01) : undefined;
      const mesh = item && g.itemMeshes.get(item.id);
      let visiblePoint: Point | undefined;
      if (mesh) {
        mesh.updateWorldMatrix(true, true);
        const centre = new window.__escape.THREE.Box3().setFromObject(mesh).getCenter(new window.__escape.THREE.Vector3());
        visiblePoint = { x: centre.x, y: centre.y, z: centre.z };
      }
      return { nodes: nav.nodes as Point[], boxes: col.boxes, holes: col.holes, visiblePoint,
        from: { x: g.body.x, z: g.body.z } };
    }, { at, itemBoxRadius });
    const col = new CollisionWorld(data.boxes);
    for (const hole of data.holes) col.addHole(...hole as [number, number, number, number]);
    const candidates: (Point & { score: number })[] = [];
    // Pick callers supply the real item box's half-width: reach is measured from its face.
    // Generic props retain the centre search; real crosshair and server act validate every use.
    const radii = [.85, 1.15, 1.5, ACT_REACH - .2, ACT_REACH,
      ...(itemBoxRadius > .1 ? [ACT_REACH + itemBoxRadius - .1] : [])];
    for (const radius of radii) for (let i = 0; i < 32; i++) {
      const stand = { x: at.x + Math.cos(i * Math.PI / 16) * radius, y: floor,
        z: at.z + Math.sin(i * Math.PI / 16) * radius };
      if (!capsuleWalk(col, stand, [])) continue;
      // A nearby lectern can sit behind the locker row. Pick reach alone does not make its real key visible.
      if (data.visiblePoint && !lineOfSight(col, { ...stand, y: stand.y + 1.5 }, data.visiblePoint)) continue;
      const nearby = data.nodes.filter(n => Math.abs(n.y - floor) < .4).map(n =>
        ({ n, d: Math.hypot(n.x - stand.x, n.z - stand.z) })).sort((a, b) => a.d - b.d).slice(0, 32);
      for (const { n, d } of nearby) {
        const ys = capsuleWalk(col, n, [[stand.x, stand.z]]);
        if (!ys || Math.abs(ys[0] - floor) >= .4) continue;
        candidates.push({ ...stand, score: d + radius * .02 + Math.hypot(stand.x - data.from.x, stand.z - data.from.z) * .01 });
        break;
      }
    }
    candidates.sort((a, b) => a.score - b.score);
    for (const stand of candidates) {
      let route: [number, number][];
      try { route = await this.pathTo(stand); } catch { continue; }
      await this.walk(route, stand);
      if (itemBoxRadius > 0) {
        const before = await this.state();
        // Autopilot stops up to .3 m before its last waypoint. Finish the already capsule-tested
        // connector through ordinary input so a pick-box edge stand stays inside real act reach.
        await this.page.evaluate(async stand => {
          const g = window.__escape.game() as any, until = performance.now() + 3000;
          try {
            while (Math.hypot(g.body.x - stand.x, g.body.z - stand.z) >= .06) {
              if (performance.now() > until) throw new Error('Item standing-point approach timed out');
              if (g.down || g.spectate) throw new Error('Captured during item standing-point approach');
              g.input.yaw = Math.atan2(g.body.x - stand.x, g.body.z - stand.z);
              g.input.press('KeyW');
              await new Promise(resolve => requestAnimationFrame(resolve));
            }
          } finally { g.input.release('KeyW'); }
        }, stand);
        const after = await this.state(), itemBox = boxAt([at.x, at.y - KEY_H / 2, at.z], itemBoxRadius, KEY_H);
        expect(after.corrections, 'the final item connector uses normal collision and authority').toBe(before.corrections);
        expect(inReach(after.p as [number, number, number], itemBox.min, itemBox.max), 'actual item standing point must be in authoritative act reach').toBe(true);
        await this.checkpoint('item-standing-point-authorized');
      }
      await this.aim(at);
      return;
    }
    throw new Error(`No reachable standing point within ${ACT_REACH}m of the target box around ${JSON.stringify(at)}`);
  }
  async use(kind?: string, id?: number, at?: Point) {
    if (kind === 'hide') {
      // Hiding is the real KeyE fallback, not a member of Game.target()'s crosshair candidates.
      await expect.poll(() => this.page.evaluate(() => {
        const g = window.__escape.game() as any;
        return { target: g.target(), hide: g.hideCand() };
      }), { message: `real hide fallback must select ${id}` }).toMatchObject({ target: null, hide: id });
      await expect(this.page.locator('#prompt')).toContainText('躲藏');
      if (!at) at = await this.page.evaluate(id => {
        const h = window.__escape.game()!.level.def.hides[id!];
        return { x: h.x, y: (h.y ?? 0) + 1, z: h.z };
      }, id);
    } else if (kind && (this.mode !== 'mobile' || !['pick', 'fuse', 'sticker', 'keypad'].includes(kind)))
      await expect.poll(() => this.page.evaluate(() => (window.__escape.game() as any).target()),
      { message: `real crosshair must select ${kind}:${id}` }).toMatchObject({ kind, ...(id === undefined ? {} : { id }) });
    const mark = this.sent.length;
    if (this.mode === 'mobile') {
      const renderedPoint = await this.page.evaluate(({ kind, id }) => {
        const g = window.__escape.game() as any;
        const object = kind === 'pick' ? g.itemMeshes.get(id) :
          kind === 'fuse' ? g.blackoutObjs.find((o: any) => o.userData.touchFuse) ?? g.blackoutObjs[0] :
          kind === 'sticker' ? g.broadcastView?.stickers[id!] : kind === 'keypad' ? g.broadcastView?.screen : undefined;
        if (!object) return null;
        object.updateWorldMatrix(true, true);
        const point = new window.__escape.THREE.Box3().setFromObject(object).getCenter(new window.__escape.THREE.Vector3());
        return { x: point.x, y: point.y, z: point.z };
      }, { kind, id });
      // Put tiny pickups themselves in the clear centre of the view, not their much taller interaction boxes.
      if (renderedPoint) await this.aim(renderedPoint);
      await showCanvas(this.page, true);
      // Aim first, then tap the object's real projected location. Never tap the generic E button as a substitute.
      const point = await this.page.evaluate(({ at, kind, id, mirrorDoor }) => {
        const g = window.__escape.game() as any, t = g.target();
        // Interaction boxes deliberately exceed tiny visual props. Tap the rendered geometry, not their box centres.
        const object = kind === 'pick' ? g.itemMeshes.get(id ?? t?.id) :
          kind === 'fuse' ? g.blackoutObjs.find((o: any) => o.userData.touchFuse) ?? g.blackoutObjs[0] :
          kind === 'sticker' ? g.broadcastView?.stickers[id!] : kind === 'keypad' ? g.broadcastView?.screen : undefined;
        if (['pick', 'fuse', 'sticker', 'keypad'].includes(kind ?? '') && !object)
          throw new Error(`No rendered geometry for ${kind}:${id}`);
        if (!object && !t && !at) throw new Error('No world target to tap');
        const v = new window.__escape.THREE.Vector3();
        if (kind === 'use' && (id ?? t?.id) >= 0 && g.doorMesh) {
          // The old interaction-box centre sat behind the visible "点门 · 打开" HUD prompt.
          // Use a real point on this leaf instance above the prompt, retaining ordinary touch hit tests.
          const mesh = g.doorMesh, matrix = new window.__escape.THREE.Matrix4();
          mesh.updateWorldMatrix(true, false); mesh.getMatrixAt(id ?? t.id, matrix);
          v.set(0, .18, 0).applyMatrix4(matrix).applyMatrix4(mesh.matrixWorld);
        } else if (kind === 'mirror-push' && t?.kind === kind) {
          // The box centre projects under the mobile prompt. Raycast an upper point on the
          // actual merged wall/cabinet, retaining the normal touch-target and HUD checks below.
          if (!mirrorDoor) throw new Error('No matching secret-wall definition');
          v.set(mirrorDoor.wall[0], mirrorDoor.wall[1] + mirrorDoor.height - .45, mirrorDoor.wall[2]);
          const wall = g.mirrorView?.root.getObjectByName('LAB.exact-server-solids');
          if (!wall) throw new Error('No rendered secret-wall geometry');
          wall.updateWorldMatrix(true, false);
          const ray = new window.__escape.THREE.Raycaster(g.camera.position, v.clone().sub(g.camera.position).normalize());
          const hit = ray.intersectObject(wall, false)[0];
          if (!hit || hit.point.x < t.min[0] - .1 || hit.point.x > t.max[0] + .1
            || hit.point.y < t.min[1] || hit.point.y > t.max[1] || hit.point.z < t.min[2] || hit.point.z > t.max[2])
            throw new Error('The selected secret-wall surface is not visible inside its target');
          v.copy(hit.point);
        } else if (object) { object.updateWorldMatrix(true, true); new window.__escape.THREE.Box3().setFromObject(object).getCenter(v); }
        else if (at) v.set(at.x, at.y, at.z);
        else v.set(t.min[0], t.min[1], t.min[2]).add(new window.__escape.THREE.Vector3(...t.max)).multiplyScalar(.5);
        v.project(g.camera);
        const rect = g.renderer.domElement.getBoundingClientRect();
        if (![v.x, v.y, v.z].every(Number.isFinite) || Math.abs(v.x) > 1 || Math.abs(v.y) > 1 || Math.abs(v.z) > 1)
          throw new Error('World object is outside the visible camera projection');
        const x = rect.left + (v.x + 1) * rect.width / 2, y = rect.top + (1 - v.y) * rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        if (!hit || hit.closest('button,input,textarea,select,.touch-btn,#touch-stick'))
          throw new Error(`Object tap is covered by a control: ${hit?.id ?? hit?.className ?? 'none'}`);
        if (kind) {
          const target = g.touchTarget(x, y)?.target;
          if (target?.kind !== kind || id !== undefined && target.id !== id)
            throw new Error(`Projected ${kind}:${id} tap selects ${JSON.stringify(target)}`);
          for (const el of document.querySelectorAll('#hud > :not(#crosshair):not(#goal-arrow):not(#hide-overlay):not(#revive-ring), #chat-panel, #map, #rotate, #settings-open')) {
            const s = getComputedStyle(el), r = el.getBoundingClientRect();
            if (!(el as HTMLElement).hidden && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0'
              && r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)
              throw new Error(`Projected ${kind}:${id} tap is behind visible HUD: ${el.id}`);
          }
        }
        return { x, y, receiver: hit.id || hit.tagName, projected: object || kind === 'use' || kind === 'mirror-push' ? 'rendered-geometry' : 'interaction-point' };
      }, { at, kind, id, mirrorDoor: kind === 'mirror-push' ? MIRROR_DOORS.find(d => d.id === id) : undefined });
      await this.page.touchscreen.tap(point.x, point.y);
      this.note('object-tap-projection', point);
      expect(await this.page.evaluate(() => document.pointerLockElement)).toBeNull();
    } else await this.page.keyboard.press('KeyE');
    if (kind && kind !== 'keypad') await expect.poll(() => this.sent.slice(mark).some(m =>
      kind === 'sticker' ? m.t === 'broadcast' && m.op === 'read' && m.id === id :
        m.t === 'act' && m.kind === kind && (id === undefined || m.id === id)),
    { message: `${kind}:${id} must produce the real player interaction message` }).toBe(true);
    this.note('world-interaction', { kind, id, input: this.mode === 'mobile' ? 'canvas-object-tap' : 'keyboard-E', sentAt: mark });
  }
  async exit(level: number, last: boolean | 'prefix') {
    const at = await this.page.evaluate(() => window.__escape.game()!.level.exit);
    // Progression may begin during the last walking frame. Wait for server fade, never teleport into the exit.
    const before = this.messages.length, initial = await this.state();
    expect(initial.level).toBe(level);
    expect(initial.down || initial.spectate).toBe(false);
    const path = await this.pathTo(at, at.r);
    await this.page.evaluate(points => { const g = window.__escape.game()!; g.autopilot([[g.pos.x, g.pos.z], ...points]); }, path);
    await expect.poll(() => this.messages.slice(before).some(m => m.t === 'fade' && m.restart === false),
      { timeout: 55_000, message: `L${level + 1} must clear through the authoritative exit zone` }).toBe(true);
    const after = await this.state();
    expect(after.corrections, 'exit walk must preserve normal collision/authority').toBe(initial.corrections);
    expect(this.messages.slice(before).filter(m => m.t === 'correct' && !m.forced), 'exit walk rejected movement').toEqual([]);
    expect(this.messages.slice(before).filter(m => m.t === 'fade' && m.restart), 'a wipe must never count as a chapter clear').toEqual([]);
    expect(after.down || after.spectate, 'captured players cannot claim the exit walk').toBe(false);
    this.note(`L${level + 1}-exit-authorized`, this.latest('fade'));
    if (last === 'prefix') {
      await expect.poll(() => this.latest('complete')?.level === level || this.latest('room')?.level === level + 1,
        { timeout: 15_000, message: `L${level + 1} prefix must end at current-content completion or the next real chapter` }).toBe(true);
      if (this.latest('complete')?.level === level) {
        await expect(this.page.locator('#fade-overlay.complete')).toBeVisible();
        this.note('prefix-current-content-complete', { clearedThrough: level + 1 });
      } else {
        await this.ready(level + 1);
        this.note('prefix-next-chapter-ready', { clearedThrough: level + 1, readyChapter: level + 2 });
      }
    } else if (last) {
      await expect.poll(() => this.latest('complete')?.level, { timeout: 15_000 }).toBe(level);
      await expect(this.page.locator('#fade-overlay.complete')).toBeVisible();
    } else await this.ready(level + 1);
  }
}
