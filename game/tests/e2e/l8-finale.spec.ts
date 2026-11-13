import { expect, test, type Page } from '@playwright/test';
import { shot, showCanvas } from './draw.ts';
import { writeFile } from 'node:fs/promises';
import type { Vec3 } from '../../shared/protocol.ts';
import { INTRO_S } from '../../shared/intro.ts';

test.setTimeout(180_000);

async function ready(page: Page, name: string, code?: string) {
  await page.goto('/?nodraw&steady');
  await page.fill('#name', name);
  if (code) { await page.fill('#code', code); await page.click('#join'); }
  else await page.click('#create');
  await expect(page.locator('#waiting')).toBeVisible();
}

async function observe(page: Page, code: string) {
  await page.goto('/?nodraw&steady');
  await page.fill('#name', '点名观察者');
  await page.fill('#code', code);
  await page.click('#join');
  await expect(page.locator('#hud')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => ({
    phase: window.__escape.game()?.finalState?.phase,
    spectate: window.__escape.game()?.spectate,
  }))).toEqual({ phase: 'chase', spectate: true });
  await expect(page.locator('#spec-bar')).toBeVisible();
  expect(await page.evaluate(() => window.__escape.game()?.finalState?.members.some(m => m.id === window.__escape.game()?.myId))).toBe(false);
}

async function atBook(page: Page) {
  await expect.poll(() => page.evaluate(() => (window.__escape.game() as any)?.spawnSynced)).toBe(true);
  await page.evaluate(() => {
    const g = window.__escape.game()!, fin = g.level.def.finale!;
    const [door, corridor] = fin.route, book = fin.rollcall;
    window.__escape.autopilot([[g.pos.x, g.pos.z], [corridor.x, corridor.z], [door.x, door.z], [book.x, book.z + 1.45]]);
  });
  await expect.poll(() => page.evaluate(() => window.__escape.game()?.autopilotDone), { timeout: 15_000 }).toBe(true);
  await page.evaluate(() => {
    const g = window.__escape.game()!, book = g.level.def.finale!.rollcall;
    g.input.yaw = Math.atan2(g.pos.x - book.x, g.pos.z - book.z);
    g.input.pitch = Math.atan2(book.y + 0.86 - (g.body.y + g.eye), Math.hypot(g.pos.x - book.x, g.pos.z - book.z));
    if (!g.light) { g.input.press('KeyF'); g.input.release('KeyF'); }
  });
}

async function tapVisibleBook(page: Page) {
  await showCanvas(page, true);
  const point = await page.evaluate(() => {
    const g = window.__escape.game()!, b = g.level.def.finale!.rollcall;
    g.camera.updateMatrixWorld();
    const p = new window.__escape.THREE.Vector3(b.x, b.y + 0.86, b.z).project(g.camera);
    const r = g.renderer.domElement.getBoundingClientRect();
    return { x: r.left + (p.x + 1) * r.width / 2, y: r.top + (1 - p.y) * r.height / 2, visible: p.z < 1 };
  });
  expect(point.visible).toBe(true);
  const viewport = page.viewportSize()!;
  expect(point.x).toBeGreaterThan(viewport.width * 0.45);
  expect(point.x).toBeLessThan(viewport.width);
  expect(point.y).toBeGreaterThan(0);
  expect(point.y).toBeLessThan(viewport.height);
  // The real touch lands on the projected scene object through #touch-look.
  // It does not call the interaction method or the HUD interaction button.
  await page.touchscreen.tap(point.x, point.y);
}

async function renderShot(page: Page, path: string) {
  await shot(page, path);
  // Confirm a real rendered backbuffer was captured, rather than an empty HUD-only screenshot.
  await expect.poll(() => page.evaluate(() => window.__escape.stats().triangles)).toBeGreaterThan(1000);
}

async function replayReady(clients: Page[], previousIntros: number[], downs: number) {
  return Promise.all(clients.map(async (page, i) => {
    await expect(page.locator('#finale-result')).toBeHidden({ timeout: 10_000 });
    // A same-seed retry creates a fresh intro epoch. Input stays locked while its
    // presentation runs; the rollcall phase alone does not mean play has resumed.
    await expect.poll(() => page.evaluate(previous => {
      const g = window.__escape.game();
      return !!g && g.intro.id > previous && g.intro.active && g.presentationReady;
    }, previousIntros[i]), { timeout: 10_000 }).toBe(true);
    await expect(page.locator('#intro-overlay')).toBeVisible();
    const intro = await page.evaluate(() => {
      const g = window.__escape.game()!;
      return { id: g.intro.id, active: g.intro.active, enabled: g.input.enabled };
    });
    expect(intro.active).toBe(true);
    expect(intro.enabled).toBe(false);
    // Observe the natural end, and fail if input unlocks during the intro. The
    // deadline follows the shared presentation duration rather than a sleep.
    await page.waitForFunction(id => {
      const g = window.__escape.game();
      if (!g || g.intro.id !== id) return false;
      if (g.intro.active) {
        if (g.input.enabled) throw new Error('Replay input unlocked before the intro ended');
        return false;
      }
      return g.presentationReady;
    }, intro.id, { timeout: INTRO_S * 1000 + 5_000 });
    await expect(page.locator('#intro-overlay')).toBeHidden();
    await expect.poll(() => page.evaluate(() => {
      const g = window.__escape.game();
      return { phase: g?.finalState?.phase, enabled: g?.input.enabled, ready: g?.presentationReady,
        down: g?.down, spectate: g?.spectate, escaped: g?.escaped, completion: g?.completion, downs: g?.finalState?.downs };
    })).toEqual({ phase: 'rollcall', enabled: true, ready: true, down: false, spectate: false,
      escaped: false, completion: null, downs });
    return intro;
  }));
}

for (const mobile of [false, true]) {
  test(`${mobile ? 'mobile' : 'desktop'} two-player authoritative register, real chase to gate, ending and replay`, async ({ browser, baseURL }, testInfo) => {
    const context = await browser.newContext({ baseURL, viewport: mobile ? { width: 844, height: 390 } : { width: 1100, height: 700 }, isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage(), teammate = await context.newPage(), observer = await context.newPage();
    const clients = [page, teammate, observer];
    const errors: string[] = [];
    const rejectedMoves: unknown[] = [];
    const wire: unknown[] = [];
    for (const p of clients) p.on('websocket', ws => ws.on('framereceived', ({ payload }) => {
      const m = JSON.parse(String(payload));
      if (m.t === 'correct' && !m.forced) rejectedMoves.push(m);
      if (['correct', 'caught', 'fade', 'room', 'finale', 'completed', 'error'].includes(m.t) || m.t === 'event' && m.kind === 'intro') {
        wire.push({ at: Date.now(), peer: p === page ? 'host' : p === teammate ? 'teammate' : 'observer', m });
        if (wire.length > 300) wire.shift();
      }
    }));
    for (const p of clients) {
      p.on('pageerror', e => errors.push(e.message));
      p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    }
    try {
    await ready(page, '点名甲');
    const code = await page.locator('#wait-code').textContent();
    await ready(teammate, '点名乙', code!);
    await expect(page.locator('#wait-members')).toContainText('点名乙');
    await page.click('#start');
    for (const p of [page, teammate]) await expect(p.locator('#hud')).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => window.__escape.debug('level', 7));
    for (const p of [page, teammate]) {
      await expect(p.locator('#room-code')).toContainText('第 8 关');
      await expect.poll(() => p.evaluate(() => window.__escape.game()?.finalState?.phase)).toBe('rollcall');
    }
    await Promise.all([atBook(page), atBook(teammate)]);
    await expect(page.locator('#banner')).toBeHidden();
    await renderShot(page, `test-results/l8-${mobile ? 'mobile' : 'desktop'}-book.png`);
    const use = async () => {
      if (mobile) await tapVisibleBook(page);
      else await page.keyboard.press('e');
    };
    await use();
    await expect(page.locator('#rollcall-panel')).toBeVisible();
    await expect(page.locator('#rollcall-list')).toContainText('点名甲');
    await expect(page.locator('#rollcall-list')).toContainText('点名乙');
    const close = page.locator('#rollcall-close');
    if (mobile) await close.tap(); else await close.click();
    await expect(page.locator('#rollcall-panel')).toBeHidden();
    await use();
    await expect(page.locator('#rollcall-panel')).toBeVisible();
    await renderShot(page, `test-results/l8-${mobile ? 'mobile' : 'desktop'}-rollcall.png`);
    const buttons = page.locator('#rollcall-list button');
    const rect = await buttons.first().boundingBox();
    expect(rect!.height).toBeGreaterThanOrEqual(48);
    expect(rect!.y + rect!.height).toBeLessThan(mobile ? 390 : 700);
    if (mobile) await buttons.first().tap(); else await buttons.first().click();
    await expect.poll(() => teammate.evaluate(() => window.__escape.game()?.finalState?.members.filter(m => m.crossedOut).length)).toBe(1);
    await expect(buttons.first()).toBeDisabled();
    if (mobile) await buttons.nth(1).tap(); else await buttons.nth(1).click();
    for (const p of [page, teammate]) await expect.poll(() => p.evaluate(() => window.__escape.game()?.finalState?.phase)).toBe('chase');
    await expect.poll(() => page.evaluate(() => window.__escape.game()?.mobs.byId.get(1)?.form)).toBe('perfect');
    const seed = await page.evaluate(() => window.__escape.game()!.level.seed);
    const mobStart = await page.evaluate(() => [...window.__escape.game()!.mobs.byId.get(1)!.at]);
    // No debug invulnerability, teleport, key or state injection: local capsule movement + ordinary run/rest stamina,
    // accepted over the real WebSocket connection, while the authoritative pursuer is running.
    await Promise.all([page, teammate].map(p => p.evaluate(() => {
      const g = window.__escape.game()!;
      const trace: unknown[] = [];
      const timer = setInterval(() => {
        const at = g.mobs.byId.get(1)?.at;
        const state = g as any;
        trace.push({ at: performance.now(), p: [g.pos.x, g.pos.z], feetY: g.body.y, mob: at ? [...at] : null,
          phase: g.finalState?.phase, down: g.down, spectate: g.spectate, escaped: g.escaped,
          enabled: g.input.enabled, keys: [...g.input.keys], stamina: state.stamina, exhausted: state.exhausted,
          yaw: g.input.yaw, routeAt: state.routeAt, target: state.route?.[state.routeAt], corrections: g.corrections,
          nearby: g.campus.collision.boxes.filter((b: any) => g.pos.x > b.minX - .5 && g.pos.x < b.maxX + .5 && g.pos.z > b.minZ - .5 && g.pos.z < b.maxZ + .5 && g.body.y < b.maxY && g.body.y + 1.6 > b.minY).slice(0, 12),
        });
      }, 200);
      (g as any).__l8Trace = { trace, timer };
      const route = g.level.def.finale!.route.map(p => [p.x, p.z] as [number, number]);
      window.__escape.autopilot([[g.pos.x, g.pos.z], ...route]);
      g.input.press('ShiftLeft');
    })));
    await observe(observer, code!);
    for (const p of [page, teammate]) await expect(p.locator('#finale-result')).toBeVisible({ timeout: 75_000 });
    await expect.poll(() => page.evaluate(() => window.__escape.game()?.completion?.members.filter(m => m.escaped).length)).toBe(2);
    expect(await page.evaluate(() => window.__escape.game()?.completion)).toEqual(await teammate.evaluate(() => window.__escape.game()?.completion));
    await expect(observer.locator('#finale-result')).toBeVisible();
    expect(await observer.evaluate(() => window.__escape.game()?.completion)).toEqual(await page.evaluate(() => window.__escape.game()?.completion));
    await expect(observer.locator('#finale-members')).not.toContainText('点名观察者');
    await expect(observer.locator('#finale-restart')).toBeHidden();
    expect(mobStart).toHaveLength(3);
    expect(mobStart[1]).toBeCloseTo(0, 2); // Mobs.at is the authoritative [x, y, z] position.
    expect(mobStart[2]).toBeGreaterThan(125);
    const trace = await page.evaluate(() => {
      const value = (window.__escape.game() as any).__l8Trace;
      clearInterval(value.timer);
      return value.trace as { p: [number, number]; mob: Vec3 | null; phase: string; stamina: number; exhausted: boolean }[];
    });
    expect(trace.some(v => v.p[1] > 123)).toBe(true); // inside OFF
    expect(trace.some(v => v.p[1] < 122 && v.p[1] > 116)).toBe(true); // OFF entrance to outdoor road
    expect(trace.some(v => v.p[1] < 0 && v.p[1] > -8.2)).toBe(true); // school gate / guard-room frontage
    expect(trace.some(v => v.p[1] < -8.2)).toBe(true); // beyond the perimeter, not merely the gate leaf
    // The completed phase removes the pursuer. Every sample during the actual chase must still
    // contain him, including the long outdoor legs when he is outside the local player's view.
    const chase = trace.filter(v => v.phase === 'chase');
    expect(chase.length).toBeGreaterThan(1);
    expect(chase.every(v => v.mob !== null && v.mob.length === 3 && v.mob.every(Number.isFinite))).toBe(true);
    expect(trace.some(v => v.exhausted && v.stamina < 0.15)).toBe(true);
    expect(trace.some((v, i) => i > 0 && v.stamina > trace[i - 1].stamina)).toBe(true);
    let pursuitMetres = 0;
    for (let i = 1; i < chase.length; i++) pursuitMetres += Math.hypot(chase[i].mob![0] - chase[i - 1].mob![0], chase[i].mob![2] - chase[i - 1].mob![2]);
    expect(pursuitMetres).toBeGreaterThan(100);
    expect(rejectedMoves).toEqual([]);
    const evidence = {
      viewport: mobile ? 'mobile' : 'desktop', seed, mobStart, pursuitMetres, rejectedMoves,
      completion: await page.evaluate(() => window.__escape.game()?.completion),
      observer: await observer.evaluate(() => ({ spectate: window.__escape.game()?.spectate, completion: window.__escape.game()?.completion })),
      trace,
    };
    for (const p of [page, teammate]) {
      await expect(p.locator('#finale-summary')).toContainText('用时');
      await expect(p.locator('#finale-summary')).toContainText('全队倒地');
      await expect(p.locator('#finale-members')).toContainText('点名甲');
      await expect(p.locator('#finale-members')).toContainText('点名乙');
      expect(await p.evaluate(() => window.__escape.game()?.completion?.downs)).toBe(0);
      expect(await p.evaluate(() => window.__escape.game()?.pos.z)).toBeLessThan(-8.2);
    }
    await renderShot(page, `test-results/l8-${mobile ? 'mobile' : 'desktop'}-ending.png`);
    await expect(teammate.locator('#finale-restart')).toBeHidden();
    const completedIntros = await Promise.all(clients.map(p => p.evaluate(() => window.__escape.game()!.intro.id)));
    if (mobile) await page.locator('#finale-restart').tap(); else await page.locator('#finale-restart').click();
    const replayIntros = await replayReady(clients, completedIntros, 0);
    for (const p of clients) {
      expect(await p.evaluate(() => window.__escape.game()!.level.seed)).toBe(seed);
      expect(await p.evaluate(() => window.__escape.game()?.finalState?.members.length)).toBe(3);
    }
    // All participants down means no rescuer: the same-seed wipe starts immediately,
    // then its fresh intro must finish before input becomes playable again.
    const playingIntros = await Promise.all(clients.map(p => p.evaluate(() => window.__escape.game()!.intro.id)));
    await Promise.all(clients.map(p => p.evaluate(() => window.__escape.debug('down', 1))));
    for (const p of clients) await expect.poll(() => p.evaluate(() => !!window.__escape.game()?.down || !!window.__escape.game()?.spectate)).toBe(true);
    for (const p of clients) await expect(p.locator('#fade-overlay')).toBeVisible({ timeout: 5_000 });
    const wipeIntros = await replayReady(clients, playingIntros, 3);
    for (const p of clients) expect(await p.evaluate(() => window.__escape.game()!.level.seed)).toBe(seed);
    const x = await page.evaluate(() => window.__escape.game()!.pos.x);
    await page.keyboard.down('a');
    await expect.poll(() => page.evaluate(() => window.__escape.game()!.pos.x), { timeout: 3_000 }).not.toBe(x);
    await page.keyboard.up('a');
    expect(errors).toEqual([]);
    await writeFile(`test-results/l8-${mobile ? 'mobile' : 'desktop'}-success.json`, JSON.stringify({
      ...evidence,
      replayIntros, wipeIntros,
      replay: await page.evaluate(() => ({ seed: window.__escape.game()?.level.seed, state: window.__escape.game()?.finalState, enabled: window.__escape.game()?.input.enabled })),
      errors,
    }, null, 2) + '\n');
    } catch (error) {
      const clientStates = await Promise.all(clients.map(async (p, i) => {
        try { return await p.evaluate((peer) => {
          const g = window.__escape.game() as any;
          if (!g) return { peer, game: null };
          if (g.__l8Trace) clearInterval(g.__l8Trace.timer);
          return { peer, p: g.pos, body: g.body, level: { index: g.level.index, seed: g.level.seed },
            finalState: g.finalState, completion: g.completion, down: g.down, spectate: g.spectate, escaped: g.escaped,
            intro: { id: g.intro.id, active: g.intro.active }, presentationReady: g.presentationReady,
            input: { enabled: g.input.enabled, keys: [...g.input.keys], yaw: g.input.yaw, pitch: g.input.pitch },
            stamina: g.stamina, exhausted: g.exhausted, route: g.route, routeAt: g.routeAt, corrections: g.corrections,
            mobs: [...g.mobs.byId].map(([id, m]: [number, any]) => ({ id, at: m.at, form: m.form, anim: m.anim })),
            trace: g.__l8Trace?.trace ?? [] };
        }, i === 0 ? 'host' : i === 1 ? 'teammate' : 'observer'); }
        catch (diagnosticError) { return { peer: i, error: String(diagnosticError) }; }
      }));
      const report = JSON.stringify({ error: String(error), errors, rejectedMoves, wire, clients: clientStates }, null, 2);
      await writeFile(`test-results/l8-${mobile ? 'mobile' : 'desktop'}-failure.json`, report + '\n');
      await testInfo.attach('L8 failure state and route trace', { body: Buffer.from(report), contentType: 'application/json' });
      throw error;
    } finally {
      await context.close();
    }
  });
}
