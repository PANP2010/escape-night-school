import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import WebSocket from 'ws';
import type { ServerMsg } from '../../shared/protocol.ts';
import { frame } from './draw.ts';

const evidence = 'test-results/level-difficulty';
type Item = { id: number; kind: string; decoy?: boolean; p: number[] };

async function screenshot(page: Page, name: string) {
  await expect(page.locator('#banner')).toBeHidden({ timeout: 12_000 });
  await expect(page.locator('#subtitle')).toHaveText('');
  await frame(page, 2);
  await page.evaluate(async () => { const i = document.getElementById('e2e-shot') as HTMLImageElement; await i.decode(); await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))); });
  await page.screenshot({ path: `${evidence}/${name}.png` });
  await page.evaluate(() => document.getElementById('e2e-shot')?.remove());
}

async function standAt(page: Page, item: Item) {
  // All eight L1 lecterns have a clear stance 1 m west. The east side of s1/s2/s3 is a solid wall.
  await page.evaluate(p => window.__escape.debug('tp', p[0] - 1, p[2]), item.p);
  await expect.poll(() => page.evaluate(p => { const g = window.__escape.game()!; return Math.hypot(g.pos.x - p[0] + 1, g.pos.z - p[2]); }, item.p)).toBeLessThan(.2);
  await expect.poll(() => page.evaluate(p => { const g = window.__escape.game()!; return Math.hypot(g.camera.position.x - p[0] + 1, g.camera.position.z - p[2]); }, item.p)).toBeLessThan(.2);
  await page.evaluate(p => { const g = window.__escape.game() as any; const dx = p[0] - g.camera.position.x, dz = p[2] - g.camera.position.z; g.input.yaw = Math.atan2(-dx, -dz); g.input.pitch = Math.atan2(p[1] + .05 - g.camera.position.y, Math.hypot(dx, dz)); }, item.p);
  await expect.poll(() => page.evaluate(() => { const target = (window.__escape.game() as any).target(); return target ? { kind: target.kind, id: target.id } : null; })).toEqual({ kind: 'pick', id: item.id });
}

function wsClient(url: string, name: string) {
  const ws = new WebSocket(url), messages: any[] = [], players = new Map<number, { p: number[]; st: number }>();
  let id = -1, incarnation = 0, readyIncarnation = 0, introActive = false;
  ws.on('message', d => {
    const m = JSON.parse(String(d)); messages.push(m);
    if (m.t === 'welcome') id = m.id;
    if (m.t === 'room' && m.started) incarnation = m.incarnation;
    if (m.t === 'event' && m.kind === 'intro') {
      introActive = !m.ended;
      if (!m.ended) ws.send(JSON.stringify({ t: 'intro-skip', id: m.id }));
    }
    if (m.t === 'snap') {
      for (const p of m.players) players.set(p.id, { p: p.p, st: p.st ?? 0 });
      if (incarnation && readyIncarnation !== incarnation && players.get(id)?.st === 0) {
        readyIncarnation = incarnation; ws.send(JSON.stringify({ t: 'ready', incarnation }));
      }
    }
  });
  const send = (m: object) => ws.send(JSON.stringify(m));
  const ready = new Promise<void>(r => ws.once('open', () => { send({ t: 'hello', name }); r(); }));
  return { ws, ready, send, messages, players, get id() { return id; }, get introActive() { return introActive; } };
}

// One Playwright browser owns sequential desktop/mobile contexts. Debug tp/safe isolate interaction and reset
// correctness; this test is deliberately not counted as a natural-threat playthrough.
test('desktop and phone: three L1 steps, locked drawer, decoy, same-seed wipe and three-client rescue', async ({ browser, baseURL }) => {
  test.setTimeout(240_000);
  mkdirSync(evidence, { recursive: true });
  const results: unknown[] = [], errors: string[] = [];
  for (const phone of [false, true]) {
    const context = await browser.newContext({ baseURL, viewport: phone ? { width: 844, height: 390 } : { width: 1280, height: 720 }, hasTouch: phone, isMobile: phone, deviceScaleFactor: 1 });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    const wipe: { restarts: number; seconds?: number } = { restarts: 0 };
    // The last live player's elimination starts fade before another snapshot is sent. Observe its
    // authoritative restart event: the client intentionally clears its local spectator flag during fade.
    page.on('websocket', ws => ws.on('framereceived', ({ payload }) => {
      const m = JSON.parse(payload.toString()) as ServerMsg;
      if (m.t === 'fade' && m.restart) { wipe.restarts++; wipe.seconds = m.secs; }
    }));
    await page.goto('/?steady'); await page.fill('#name', phone ? '手机验证' : '桌面验证'); await page.click('#create'); await page.click('#start');
    await page.waitForFunction(() => {
      const g = window.__escape.game(); return g?.presentationReady && !g.intro.active;
    });
    await page.evaluate(async () => { if (document.fullscreenElement) await document.exitFullscreen(); window.__escape.debug('safe', 600); });
    await page.setViewportSize(phone ? { width: 844, height: 390 } : { width: 1280, height: 720 });
    const items = await page.evaluate(() => (window.__escape.game() as any).items as Item[]);
    const key = items.find(i => i.kind === 'drawer_key' && !i.decoy)!, drawer = items.find(i => i.kind === 'stair_key')!, decoy = items.find(i => i.decoy)!;
    const label = phone ? 'phone' : 'desktop';
    await expect(page.locator('#objective .h')).toHaveText('目标 1/3');
    await expect(page.locator('#objective')).toContainText('铜牌、有齿');
    await standAt(page, drawer);
    await expect(page.locator('#prompt')).toContainText('抽屉锁着，需要抽屉钥匙');
    await screenshot(page, `${label}-locked-drawer`);
    const interact = async () => {
      if (phone) { const vp = page.viewportSize()!; await page.touchscreen.tap(vp.width / 2, vp.height / 2); }
      else await page.keyboard.press('KeyE');
    };
    await interact(); await page.waitForTimeout(200);
    expect(await page.evaluate(id => (window.__escape.game() as any).items.some((i: Item) => i.id === id), drawer.id)).toBe(true);
    await standAt(page, decoy); await expect(page.locator('#prompt')).toContainText('戏剧道具'); await interact();
    expect(await page.evaluate(() => (window.__escape.game() as any).bag.drawer_key ?? 0)).toBe(0);
    await standAt(page, key); await screenshot(page, `${label}-step-1`); await interact();
    await expect(page.locator('#objective .h')).toHaveText('目标 2/3'); await expect(page.locator('#objective .g')).toContainText('上锁讲台抽屉');
    await standAt(page, drawer); await screenshot(page, `${label}-step-2`); await interact();
    await expect(page.locator('#objective .h')).toHaveText('目标 3/3'); await expect(page.locator('#objective .g')).toContainText('集合');
    await screenshot(page, `${label}-step-3`);
    const bounds = await page.locator('#objective').boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    const before = await page.evaluate(() => { const g = window.__escape.game() as any; return { seed: g.level.seed, index: g.level.index, attempt: g.loadedIncarnation, items: g.items.map((i: Item) => i.id) }; });
    // Add a spectator, then remove it during the wipe fade: that room roster update must not consume a reset.
    const peer = wsClient(baseURL!.replace('http', 'ws') + '/ws', '过场离开'); await peer.ready;
    peer.send({ t: 'join', code: await page.evaluate(() => window.__escape.code) });
    await expect.poll(() => peer.messages.some(m => m.t === 'room')).toBe(true);
    await expect(page.locator('#room-code')).toContainText('· 2 人 ·');
    await page.evaluate(() => { const g = window.__escape.game() as any; g.seen.add(9999); g.tutUsed = true; g.mapOpened = true; g.explored.add(9999); });
    await page.evaluate(() => window.__escape.debug('down', .2));
    await expect.poll(() => wipe).toEqual({ restarts: 1, seconds: 3 });
    peer.ws.close();
    await expect(page.locator('#room-code')).toContainText('· 1 人 ·');
    await expect(page.locator('#fade-overlay')).toBeVisible();
    // Let several old snapshots arrive after the roster message: they must not uncover the old attempt.
    await page.waitForTimeout(250);
    await expect(page.locator('#fade-overlay')).toBeVisible();
    await expect(page.locator('body')).toHaveClass(/level-handoff/);
    await expect.poll(() => page.evaluate(() => (window.__escape.game() as any).seen.has(9999))).toBe(true);
    expect(await page.evaluate(() => (window.__escape.game() as any).loadedIncarnation)).toBe(before.attempt);
    await expect.poll(() => page.evaluate(() => document.querySelector('#objective .h')?.textContent), { timeout: 12_000 }).toBe('目标 1/3');
    await page.waitForFunction(() => !(window.__escape.game() as any).spectate && !(window.__escape.game() as any).down);
    const reset = await page.evaluate(() => { const g = window.__escape.game() as any; return { seed: g.level.seed, index: g.level.index, attempt: g.loadedIncarnation, seenOld: g.seen.has(9999), used: g.tutUsed, exploredOld: g.explored.has(9999), mapped: g.mapOpened, bag: g.bag, keys: g.items.filter((i: Item) => i.kind === 'drawer_key' && !i.decoy).length, drawers: g.items.filter((i: Item) => i.kind === 'stair_key').length }; });
    expect(reset).toMatchObject({ seed: before.seed, index: before.index, seenOld: false, used: false, exploredOld: false, mapped: false, bag: {}, keys: 1, drawers: 1 });
    expect(reset.attempt).toBe(before.attempt + 1);
    // A retry has its own server intro and readable opening banner. Start that presentation
    // with real input before checking the newly restarted movement tutorial.
    await page.waitForFunction(() => {
      const g = window.__escape.game(); return g?.presentationReady && !g.intro.active;
    });
    await page.keyboard.press('Shift');
    await page.waitForFunction(() => window.__escape.game()?.openingComplete);
    await expect(page.locator('#tut')).toBeVisible();
    await expect(page.locator('#tut')).toContainText(phone ? '拖动走路' : '走动', { timeout: 10_000 });
    await screenshot(page, `${label}-wipe-reset`); results.push({ label, reset, wipe });
    await context.close();
  }
  // Three real websocket clients; no screenshots/delays between down and the revive hold.
  const clients = ['甲', '乙', '丙'].map(n => wsClient(baseURL!.replace('http', 'ws') + '/ws', n));
  try {
    await Promise.all(clients.map(c => c.ready)); const [a, b, c] = clients;
    a.send({ t: 'create' }); await expect.poll(() => a.messages.some(m => m.t === 'room')).toBe(true);
    const code = a.messages.find(m => m.t === 'room').code;
    b.send({ t: 'join', code }); c.send({ t: 'join', code });
    await expect.poll(() => a.messages.filter(m => m.t === 'room').at(-1)?.players.length).toBe(3);
    a.send({ t: 'start' }); await expect.poll(() => a.players.size).toBe(3);
    await expect.poll(() => clients.every(client => !client.introActive)).toBe(true);
    a.send({ t: 'debug', op: 'safe', s: 600 });
    const [x, , z] = a.players.get(c.id)!.p;
    b.send({ t: 'debug', op: 'tp', x: x + 1, z }); c.send({ t: 'debug', op: 'down', s: 30 });
    await expect.poll(() => a.players.get(c.id)?.st).toBe(1);
    await expect.poll(() => Math.hypot(a.players.get(b.id)!.p[0] - x, a.players.get(b.id)!.p[2] - z)).toBeLessThan(1.5);
    const start = Date.now();
    while (Date.now() - start < 4_500 && a.players.get(c.id)?.st === 1) { b.send({ t: 'act', kind: 'revive', id: c.id }); await new Promise(r => setTimeout(r, 50)); }
    expect(Date.now() - start).toBeGreaterThanOrEqual(2_800);
    for (const client of clients) await expect.poll(() => client.players.get(c.id)?.st).toBe(0);
    const holdMs = Date.now() - start;
    // Stay alive beyond the original bug's 1.5 s delay.
    const until = Date.now() + 2_100;
    while (Date.now() < until) { for (const client of clients) expect(client.players.get(c.id)?.st).toBe(0); await new Promise(r => setTimeout(r, 50)); }
    results.push({ rescueClients: 3, holdMs, stableAliveMs: 2_100 });
  } finally { clients.forEach(c => c.ws.close()); }
  writeFileSync(`${evidence}/functional-results.json`, JSON.stringify({ results, errors }, null, 2));
  expect(errors).toEqual([]);
});
