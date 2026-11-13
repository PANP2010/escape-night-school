import { expect, test } from '@playwright/test';

test('lobby and active-room recovery clear stale disconnect warnings after genuine reconnection', async ({ page, context }) => {
  const received = { lists: 0, snapshots: 0, resumed: [] as number[], epochs: [] as number[] };
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => socket.on('framereceived', event => {
    // Record only safe metadata, never resume credentials.
    const message = JSON.parse(String(event.payload)) as { t: string; id?: number; resumed?: boolean; c?: number; forced?: boolean };
    if (message.t === 'rooms') received.lists++;
    if (message.t === 'snap') received.snapshots++;
    if (message.t === 'welcome' && message.resumed) received.resumed.push(message.id!);
    if (message.t === 'correct' && message.forced) received.epochs.push(message.c!);
  }));
  const view = () => page.evaluate(() => {
    const game = window.__escape.game();
    return {
      state: window.__escape.net.state, connected: window.__escape.net.connected,
      code: window.__escape.code, id: game?.myId,
      ready: !!game?.presentationReady, paused: game?.networkPaused,
    };
  });

  try {
    await page.goto('/?nodraw&steady');
    await expect(page.locator('#lobby-connection')).toHaveAttribute('data-state', 'connected');
    await expect.poll(() => received.lists).toBeGreaterThan(0);
    expect(await page.evaluate(() => sessionStorage.getItem('escape.resume'))).toBeNull();

    // No hello or room exists yet: successful recovery sends welcome + rooms, not a room message.
    await context.setOffline(true);
    await expect(page.locator('#lobby-connection')).toHaveAttribute('data-state', 'disconnected');
    await expect(page.locator('#err')).toContainText('与服务器断开连接');
    await expect(page.locator('#create')).toBeDisabled();
    await expect(page.locator('#reconnect-status')).toBeVisible();
    const previousLists = received.lists;
    await context.setOffline(false);
    await expect.poll(async () => (await view()).connected).toBe(true);
    await expect(page.locator('#lobby-connection')).toHaveAttribute('data-state', 'connected');
    await expect(page.locator('#err')).toHaveText('');
    await expect(page.locator('#reconnect-status')).toBeHidden();
    await expect(page.locator('#reconnect-lobby')).toBeHidden();
    await expect(page.locator('#create')).toBeEnabled();
    await expect.poll(() => received.lists).toBeGreaterThan(previousLists);

    await page.fill('#name', '重连验收');
    await page.click('#create');
    await expect(page.locator('#waiting')).toBeVisible();
    await page.click('#start');
    await expect(page.locator('#hud')).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => { const state = await view(); return state.connected && state.ready && !state.paused; }, { timeout: 30_000 }).toBe(true);
    const original = await view();
    const originalEpoch = received.epochs.at(-1)!;

    await context.setOffline(true);
    await expect(page.locator('#reconnect-status')).toBeVisible();
    await expect.poll(async () => (await view()).paused).toBe(true);
    expect(await page.locator('#err').textContent()).toContain('与服务器断开连接');
    const previousSnapshots = received.snapshots;
    await context.setOffline(false);
    await expect.poll(() => received.resumed).toContain(original.id!);
    await expect.poll(async () => { const state = await view(); return state.connected && !state.paused; }).toBe(true);
    const restored = await view();
    expect(restored.id).toBe(original.id);
    expect(restored.code).toBe(original.code);
    expect(received.epochs.at(-1)!).toBeGreaterThan(originalEpoch);
    await expect(page.locator('#reconnect-status')).toBeHidden();
    expect(await page.locator('#err').textContent()).toBe('');
    await expect.poll(() => received.snapshots).toBeGreaterThan(previousSnapshots);
    expect(errors).toEqual([]);
  } finally {
    await context.setOffline(false);
  }
});
