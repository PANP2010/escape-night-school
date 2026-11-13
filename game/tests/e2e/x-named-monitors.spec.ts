import { expect, test } from '@playwright/test';
import { browserArgs } from '../browser-args.mjs';

test.use({ headless: process.platform !== 'darwin', viewport: { width: 1280, height: 720 }, launchOptions: { args: browserArgs(['--mute-audio']) } });

test('unfinished progression cannot enable named monitors through a saved preference or a changed checkbox', async ({ page }) => {
  const sent: any[] = [], rooms: any[] = [];
  page.on('websocket', socket => {
    socket.on('framesent', ({ payload }) => sent.push(JSON.parse(String(payload))));
    socket.on('framereceived', ({ payload }) => { const message = JSON.parse(String(payload)); if (message.t === 'room') rooms.push(message); });
  });
  await page.addInitScript(() => {
    localStorage.setItem('escape.namedMonitors', '1');
    localStorage.setItem('escape.progress.v1', JSON.stringify({ achievements: ['difficulty-nightmare'], unlocked: ['nightmare'], namedMonitorsUnlocked: true }));
  });
  await page.goto('/?steady');
  await expect(page.locator('#named-monitors')).toBeDisabled();
  await expect(page.locator('#named-monitors')).not.toBeChecked();
  await expect(page.locator('#named-monitors-hint')).toHaveText('完成无人生还难度后解锁。');
  await page.screenshot({ path: 'test-results/named-monitors-locked.png' });
  await page.locator('#named-monitors').evaluate((input: HTMLInputElement) => { input.disabled = false; input.checked = true; });
  await page.fill('#name', '匿名值周生验收'); await page.click('#create');
  await expect(page.locator('#wait-code')).not.toBeEmpty();
  expect(sent.find(message => message.t === 'create')).toMatchObject({ namedMonitors: false });
  expect(rooms.at(-1)).toMatchObject({ namedMonitors: false });
});

for (const action of ['create', 'quick-join']) {
  test(`restored full nightmare progress enables an opt-in ${action} room with a fixed choice`, async ({ page }) => {
    const sent: any[] = [], rooms: any[] = [];
    page.on('websocket', socket => {
      socket.on('framesent', ({ payload }) => sent.push(JSON.parse(String(payload))));
      socket.on('framereceived', ({ payload }) => { const message = JSON.parse(String(payload)); if (message.t === 'room') rooms.push(message); });
    });
    await page.addInitScript(() => {
      localStorage.setItem('escape.namedMonitors', '1');
      localStorage.setItem('escape.progress.v1', JSON.stringify({ achievements: ['difficulty-story', 'difficulty-standard', 'difficulty-challenge', 'difficulty-nightmare'], namedMonitorsUnlocked: true }));
    });
    await page.goto('/?steady');
    await expect(page.locator('#named-monitors')).toBeEnabled();
    await expect(page.locator('#named-monitors')).not.toBeChecked();
    await page.locator('#named-monitors').check();
    await page.fill('#name', `彩蛋-${action}`); await page.click(`#${action}`);
    await expect(page.locator('#wait-code')).not.toBeEmpty();
    expect(sent.find(message => message.t === (action === 'create' ? 'create' : 'quick'))).toMatchObject({ namedMonitors: true });
    expect(rooms.at(-1)).toMatchObject({ namedMonitors: true });
    await expect(page.locator('#wait-hint')).toContainText('人名彩蛋开启');
    await expect(page.locator('#named-monitors')).toBeDisabled();
  });
}
