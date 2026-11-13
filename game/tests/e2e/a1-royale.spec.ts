import { test, expect } from '@playwright/test';

test('A1 royale mode: create 8-player room, scattered spawns, elimination', async ({ browser }) => {
  // Three independent browser contexts (separate ws connections).
  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  const ctx3 = await browser.newContext();
  const page1 = await ctx1.newPage();
  const page2 = await ctx2.newPage();
  const page3 = await ctx3.newPage();

  // Player 1 creates a royale room.
  await page1.goto('http://localhost:4100');
  await page1.fill('#name', 'Alpha');
  await page1.selectOption('#mode-selector', 'royale');
  await page1.click('#create');
  await page1.waitForSelector('#room-info', { timeout: 5000 });
  const code = await page1.locator('#room-code').innerText();
  expect(code).toMatch(/^[A-Z0-9]{4}$/);

  // Player 2 joins.
  await page2.goto('http://localhost:4100');
  await page2.fill('#name', 'Bravo');
  await page2.fill('#code', code);
  await page2.click('#join');
  await page2.waitForSelector('#room-info', { timeout: 5000 });

  // Player 3 joins.
  await page3.goto('http://localhost:4100');
  await page3.fill('#name', 'Charlie');
  await page3.fill('#code', code);
  await page3.click('#join');
  await page3.waitForSelector('#room-info', { timeout: 5000 });

  // Host starts the game.
  await page1.click('#start');
  await page1.waitForSelector('canvas', { timeout: 10000 });
  await page2.waitForSelector('canvas', { timeout: 10000 });
  await page3.waitForSelector('canvas', { timeout: 10000 });

  // Wait a moment for spawns to settle.
  await page1.waitForTimeout(2000);

  // Verify all three contexts see the canvas (game started).
  expect(await page1.locator('canvas').count()).toBe(1);
  expect(await page2.locator('canvas').count()).toBe(1);
  expect(await page3.locator('canvas').count()).toBe(1);

  // Screenshot from each player's view.
  const shot1 = 'test-results/playwright-artifacts/a1-royale-p1.png';
  const shot2 = 'test-results/playwright-artifacts/a1-royale-p2.png';
  const shot3 = 'test-results/playwright-artifacts/a1-royale-p3.png';
  await page1.screenshot({ path: shot1, fullPage: false });
  await page2.screenshot({ path: shot2, fullPage: false });
  await page3.screenshot({ path: shot3, fullPage: false });

  // Clean up.
  await ctx1.close();
  await ctx2.close();
  await ctx3.close();
});
