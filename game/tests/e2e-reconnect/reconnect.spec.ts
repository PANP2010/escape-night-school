import { expect, test, type Page } from '@playwright/test';
import { ReconnectPeer, delay, near, waitFor } from '../reconnect-peer.mjs';
import { reconnectProxy } from '../reconnect-proxy.mjs';
import { shot } from '../e2e/draw';

// One browser/page and one genuine Node ws teammate. No socket messages or credentials are synthesized.
// The independent config owns 4419. A same-process TCP proxy only controls byte delivery to that server.
const WS_URL = 'ws://127.0.0.1:4419/ws';
const online = (room: any) => room?.players.filter((p: any) => p.online !== false) ?? [];
const view = (page: Page) => page.evaluate(() => {
  const g = window.__escape.game() as any;
  return { code: window.__escape.code, state: window.__escape.net.state, connected: window.__escape.net.connected,
    id: g?.myId, p: g ? [g.pos.x, g.body.y, g.pos.z] : null, c: g?.corrC,
    spawned: !!g?.spawnSynced, paused: g?.networkPaused, down: !!g?.down, spectate: !!g?.spectate };
});

// Persist only safe protocol metadata in the runner. Never retain/log hello.resume or welcome.token.
function observe(page: Page) {
  const log = { welcomes: [] as { id: number; resumed: boolean; failed: boolean }[],
    inputs: [] as { p: number[]; c?: number; seq: number }[], urls: [] as string[],
    sentActions: [] as string[] };
  page.on('websocket', ws => {
    log.urls.push(ws.url());
    ws.on('framereceived', event => {
      try {
        const m = JSON.parse(String(event.payload));
        if (m.t === 'welcome') log.welcomes.push({ id: m.id, resumed: m.resumed === true, failed: m.resumeFailed === true });
      } catch { /* protocol failures are exposed by the awaited state assertions */ }
    });
    ws.on('framesent', event => {
      try {
        const m = JSON.parse(String(event.payload));
        if (m.t === 'input') log.inputs.push({ p: m.p, c: m.c, seq: m.seq });
        else if (m.t === 'act' || m.t === 'chat' || m.t === 'ping') log.sentActions.push(m.t);
      } catch { /* see above */ }
    });
  });
  return log;
}

async function botJoin(name: string, code: string, token?: string) {
  const bot = new ReconnectPeer(WS_URL, name);
  const welcome = await bot.hello(token);
  if (token) expect(welcome.resumed).toBe(true);
  else bot.send({ t: 'join', code });
  await bot.after(0, m => m.t === 'room' && m.code === code, 'real teammate room');
  return bot;
}

async function ready(page: Page) {
  await expect(page.locator('#hud')).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => { const g = await view(page); return g.spawned && !g.paused && g.connected; }, { timeout: 30_000 }).toBe(true);
}

test('network offline/online, refresh and expiry preserve identity safely and announce host changes', async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  expect(baseURL).toBe('http://127.0.0.1:4419');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const seen = observe(page);
  const proxy = await reconnectProxy(4419);
  let bot: ReconnectPeer | undefined;
  try {
    const origin = `http://127.0.0.1:${proxy.port}`;
    await page.goto(`${origin}/?nodraw&steady`);
    await page.fill('#name', '续接玩家');
    await page.click('#create');
    await expect(page.locator('#waiting')).toBeVisible();
    await waitFor(() => seen.welcomes.length > 0, 'browser received its actual welcome');
    const code = await page.evaluate(() => window.__escape.code);
    const id = seen.welcomes.at(-1)!.id;
    bot = await botJoin('续接队友', code);
    await expect(page.locator('#wait-members li')).toHaveCount(2);
    expect(await page.evaluate(() => !!sessionStorage.getItem('escape.resume'))).toBe(true);
    expect(seen.urls.every(url => url === origin.replace('http:', 'ws:') + '/ws')).toBe(true);

    // Real browser network loss in the waiting room immediately releases the host transport.
    await context.setOffline(true);
    await expect(page.locator('#reconnect-status')).toBeVisible();
    await waitFor(() => bot!.last('room')?.host === bot!.id && bot!.last('room')?.players.some((p: any) => p.id === id && p.online === false), 'offline lobby host transferred');
    await page.screenshot({ path: testInfo.outputPath('lobby-reconnecting.png') });
    const lobbyWelcome = seen.welcomes.length;
    await context.setOffline(false);
    await expect.poll(() => seen.welcomes.slice(lobbyWelcome).some(m => m.id === id && m.resumed), { timeout: 8000 }).toBe(true);
    await expect(page.locator('#reconnect-status')).toBeHidden();
    await expect(page.locator('#waiting')).toBeVisible();
    await expect(page.locator('#host-change')).toBeVisible();
    await expect(page.locator('#host-change')).toContainText('房主');
    expect((await view(page)).code).toBe(code);
    expect(bot.last('room').host).toBe(bot.id);

    // Former host comes back under the same id; when the new host leaves, the lobby announces the transfer.
    const botToken = bot.token;
    await bot.terminate();
    await expect(page.locator('#start')).toBeVisible();
    await expect(page.locator('#host-change')).toContainText('房主');
    await page.screenshot({ path: testInfo.outputPath('lobby-host-change.png') });
    bot = await botJoin('续接队友', code, botToken);
    await waitFor(() => online(bot!.last('room')).length === 2, 'both lobby transports online');
    await page.click('#start');
    await ready(page);
    await page.evaluate(() => window.__escape.debug('safe', 180));
    await waitFor(() => bot!.players.has(id), 'authoritative browser spawn');
    const before = await view(page);

    // Hold a real key across the outage, release while offline, and queue a deliberately stale action.
    await page.keyboard.down('w');
    await page.waitForTimeout(180);
    await context.setOffline(true);
    await expect(page.locator('#reconnect-status')).toBeVisible();
    await expect.poll(async () => (await view(page)).paused).toBe(true);
    const pausedPosition = (await view(page)).p!;
    await waitFor(() => bot!.last('room')?.players.some((p: any) => p.id === id && p.online === false), 'game transport actually detached');
    const preserved = [...bot.players.get(id).p];
    await page.keyboard.up('w');
    await page.keyboard.press('e');
    await page.evaluate(() => window.__escape.net.send({ t: 'chat', text: '此离线动作不应重放' }));
    await page.waitForTimeout(250);
    expect(near((await view(page)).p ?? undefined, pausedPosition, .001)).toBe(true);
    await shot(page, testInfo.outputPath('game-reconnecting.png'));
    const reconnectAt = seen.welcomes.length, inputAt = seen.inputs.length, actionAt = seen.sentActions.length;
    const roomMark = bot.mark();
    await context.setOffline(false);
    await expect.poll(() => seen.welcomes.slice(reconnectAt).some(m => m.id === id && m.resumed), { timeout: 8000 }).toBe(true);
    await ready(page);
    const restored = await view(page);
    expect(restored.id).toBe(id); expect(restored.code).toBe(code); expect(restored.spectate).toBe(false);
    expect(near(restored.p ?? undefined, preserved, .05)).toBe(true);
    expect(restored.c > before.c).toBe(true);
    await expect(page.locator('#host-status')).toContainText('续接队友');
    await expect(page.locator('#host-change')).toContainText('房主');
    await page.waitForTimeout(350);
    expect(seen.inputs.slice(inputAt).length).toBeGreaterThan(0);
    expect(seen.inputs.slice(inputAt).every(m => m.c === restored.c && near(m.p, preserved, .05))).toBe(true);
    expect(seen.sentActions.slice(actionAt)).toEqual([]);
    expect(bot.since(roomMark, m => m.t === 'chat' && m.text === '此离线动作不应重放').length).toBe(0);

    // Refresh keeps sessionStorage and has to recover an active player rather than rejoin as spectator.
    const reloadAt = seen.welcomes.length;
    await page.reload();
    await expect.poll(() => seen.welcomes.slice(reloadAt).some(m => m.id === id && m.resumed), { timeout: 12_000 }).toBe(true);
    await ready(page);
    const refreshed = await view(page);
    expect(refreshed.id).toBe(id); expect(refreshed.code).toBe(code); expect(refreshed.spectate).toBe(false);
    expect(near(refreshed.p ?? undefined, preserved, .05)).toBe(true);
    expect(refreshed.c > restored.c).toBe(true);

    // The in-game host leaves too: the visible prompt and status must identify the new host.
    const gameBotToken = bot.token;
    await bot.terminate();
    await expect(page.locator('#host-status')).toContainText('续接玩家');
    await expect(page.locator('#host-change')).toBeVisible();
    await expect(page.locator('#host-change')).toContainText('房主');
    await shot(page, testInfo.outputPath('game-host-change.png'));
    bot = await botJoin('续接队友', code, gameBotToken);
    await waitFor(() => online(bot!.last('room')).length === 2, 'in-game teammate resumed');

    // A prolonged real offline period must expire on the server, then return to entry with no ghost rejoin.
    await context.setOffline(true);
    await expect(page.locator('#reconnect-status')).toBeVisible();
    await waitFor(() => bot!.last('room')?.players.some((p: any) => p.id === id && p.online === false), 'long offline detach');
    await delay(10_300);
    await waitFor(() => !bot!.last('room')?.players.some((p: any) => p.id === id), 'server expires the old browser slot');
    await context.setOffline(false);
    await expect(page.locator('#entry')).toBeVisible({ timeout: 12_000 });
    await expect(page.locator('#hud')).toBeHidden();
    expect((await view(page)).code).toBe('');
    expect(await page.evaluate(() => !!sessionStorage.getItem('escape.resume'))).toBe(false);
    await delay(250);
    expect(bot.last('room').players.some((p: any) => p.id === id)).toBe(false);
    expect(bot.players.has(id)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath('expired-entry.png') });
    expect(errors).toEqual([]);
  } finally {
    await context.setOffline(false);
    await bot?.terminate();
    await proxy.close();
  }
});

test('an online browser detects a silent one-way WS blackhole and resumes the same active slot', async ({ page, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  expect(baseURL).toBe('http://127.0.0.1:4419');
  const seen = observe(page);
  const proxy = await reconnectProxy(4419);
  let bot: ReconnectPeer | undefined;
  try {
    await page.goto(`http://127.0.0.1:${proxy.port}/?nodraw&steady`);
    await page.fill('#name', '静默续接玩家');
    await page.click('#create');
    await expect(page.locator('#waiting')).toBeVisible();
    const code = await page.evaluate(() => window.__escape.code);
    bot = await botJoin('静默队友', code);
    await expect(page.locator('#wait-members li')).toHaveCount(2);
    await page.click('#start');
    await ready(page);
    await page.evaluate(() => window.__escape.debug('safe', 180));
    const original = await view(page);
    await waitFor(() => bot!.players.has(original.id), 'both real players running');
    // The restored transport can complete in one frame. Record the actual visible UI transition so polling
    // cannot miss a brief, legitimate reconnect prompt between the two network events.
    await page.evaluate(() => {
      const net = window.__escape.net, deliver = net.onState;
      (window as any).__reconnectStates = [];
      net.onState = state => {
        deliver(state);
        (window as any).__reconnectStates.push({ state, visible: !document.getElementById('reconnect-status')!.hidden });
      };
    });
    const mark = seen.welcomes.length;
    const outageAt = Date.now();
    proxy.blackholeExisting(); // no browser offline event or synthetic close, only actual downstream byte loss
    expect(await page.evaluate(() => navigator.onLine)).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as any).__reconnectStates.some((s: any) => s.state === 'reconnecting' && s.visible)), { timeout: 18_000 }).toBe(true);
    await expect.poll(() => seen.welcomes.slice(mark).some(m => m.id === original.id && m.resumed), { timeout: 10_000 }).toBe(true);
    await ready(page);
    const elapsedMs = Date.now() - outageAt, restored = await view(page);
    expect(elapsedMs).toBeGreaterThanOrEqual(14_000);
    expect(elapsedMs).toBeLessThan(25_000);
    expect(restored.id).toBe(original.id); expect(restored.code).toBe(code); expect(restored.spectate).toBe(false);
    expect(near(restored.p ?? undefined, original.p ?? undefined, .05)).toBe(true);
    expect(restored.c > original.c).toBe(true);
    expect(await page.evaluate(() => navigator.onLine)).toBe(true);
    expect(bot.last('room').players.filter((p: any) => p.id === original.id).length).toBe(1);
    await shot(page, testInfo.outputPath('silent-resumed.png'));
    await testInfo.attach('silent-reconnect-evidence', { body: JSON.stringify({ elapsedMs, id: restored.id, code, position: restored.p, freshEpoch: true }), contentType: 'application/json' });
  } finally {
    await bot?.terminate();
    await proxy.close();
  }
});
