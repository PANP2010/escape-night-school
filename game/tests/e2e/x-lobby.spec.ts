import { browserArgs } from '../browser-args.mjs';
import { expect, test, type Page, type WebSocket as BrowserSocket } from '@playwright/test';
import WebSocket from 'ws';

test.use({ launchOptions: { args: browserArgs(['--renderer-process-limit=1']) } });

for (const hostView of ['desktop', 'mobile'] as const) {
  test(`waiting room return clears the host and guest session (${hostView} host)`, async ({ browser, baseURL }) => {
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const mobile = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
    const faults: string[] = [];
    const sockets = new Map<Page, BrowserSocket>();
    const sent: string[] = [];
    const closed = new Set<BrowserSocket>();
    const desktopPage = await desktop.newPage(), mobilePage = await mobile.newPage();
    const host = hostView === 'desktop' ? desktopPage : mobilePage;
    const guest = hostView === 'desktop' ? mobilePage : desktopPage;
    const code = (page: Page) => page.evaluate(() => window.__escape.code);
    const lobby = async (page: Page) => {
      await expect(page.locator('#entry')).toBeVisible();
      await expect(page.locator('#waiting')).toBeHidden();
      await expect(page.locator('#create')).toBeEnabled();
      expect(await code(page)).toBe('');
      expect(await page.evaluate(() => sessionStorage.getItem('escape.resume'))).toBeNull();
    };
    const returnToLobby = async (page: Page, role: string) => {
      const socket = sockets.get(page)!;
      const back = page.getByRole('button', { name: '返回大厅', exact: true });
      await expect(back).toHaveCount(1);
      await back.scrollIntoViewIfNeeded();
      const target = await back.evaluate(button => {
        const box = button.getBoundingClientRect();
        return { height: box.height, width: box.width, inView: box.top >= 0 && box.bottom <= innerHeight,
          hit: document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === button };
      });
      expect(target.height).toBeGreaterThanOrEqual(44);
      expect(target.width).toBeGreaterThanOrEqual(44);
      expect(target.inView).toBe(true);
      expect(target.hit).toBe(true);
      await page.screenshot({ path: `test-results/iter-52-${hostView}-host-${role}-waiting.png` });
      await Promise.all([page.waitForEvent('load'), page === mobilePage ? back.tap() : back.click()]);
      await expect.poll(() => closed.has(socket)).toBe(true);
      await lobby(page);
      await page.reload();
      await lobby(page);
    };
    try {
      for (const page of [host, guest]) {
        page.on('pageerror', error => faults.push(error.message));
        page.on('websocket', socket => {
          sockets.set(page, socket);
          socket.on('close', () => closed.add(socket));
          socket.on('framesent', frame => sent.push((JSON.parse(String(frame.payload)) as { t: string }).t));
        });
        await page.goto(baseURL!);
        await expect(page.locator('#create')).toBeEnabled();
      }
      await host.fill('#name', '原房主');
      await host.selectOption('#mode-selector', 'campaign');
      await host.check('#visibility-private');
      await host.click('#create');
      await expect(host.locator('#waiting')).toBeVisible();
      const oldCode = await code(host);
      expect(oldCode).toMatch(/^[A-Z0-9]{4}$/);
      await guest.fill('#name', '原客人');
      await guest.fill('#code', oldCode);
      await guest.click('#join');
      for (const page of [host, guest]) {
        await expect(page.locator('#wait-members li')).toHaveCount(2);
        // A normal refresh must still restore an active waiting session.
        await page.reload();
        await expect(page.locator('#waiting')).toBeVisible();
        await expect(page.locator('#wait-code')).toHaveText(oldCode);
      }
      await expect(host.locator('#start')).toBeVisible();
      await expect(guest.locator('#start')).toBeHidden();
      await Promise.all([host.screenshot({ path: `test-results/iter-52-${hostView}-host-before-return.png` }),
        guest.screenshot({ path: `test-results/iter-52-${hostView}-guest-before-return.png` })]);

      await returnToLobby(guest, 'guest');
      // No leave protocol: the old room keeps its disconnected seat until the normal timeout.
      await expect(host.locator('#wait-members li[data-online="false"]')).toHaveCount(1);
      await guest.selectOption('#mode-selector', 'royale');
      await guest.click('#create');
      await expect(guest.locator('#waiting')).toBeVisible();
      const newCode = await code(guest);
      expect(newCode).not.toBe(oldCode);
      await expect(guest.locator('#wait-hint')).toContainText('大逃杀');
      await expect(guest.locator('#start')).toBeVisible();

      await returnToLobby(host, 'host');
      await host.selectOption('#mode-selector', 'royale');
      await host.fill('#code', newCode);
      await host.click('#join');
      await expect(host.locator('#wait-code')).toHaveText(newCode);
      await expect(host.locator('#start')).toBeHidden();
      await expect(guest.locator('#wait-members li')).toHaveCount(2);
      await host.reload();
      await expect(host.locator('#wait-code')).toHaveText(newCode);
      await expect(host.locator('#waiting')).toBeVisible();
      expect(sent).not.toContain('leave');
      expect(faults).toEqual([]);
    } finally {
      await desktop.close();
      await mobile.close();
    }
  });
}

// 等待大厅: two players (page + ws bot) wait in the lobby, the host starts, the page sees the bot's remote model, crouching.
test('lobby lists members, host starts, bot shows as a crouching remote model', async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await page.fill('#name', '甲');
  await page.click('#create');
  await expect(page.locator('#waiting')).toBeVisible();
  await expect(page.locator('#hud')).toBeHidden();
  const code = await page.evaluate(async () => { while (!window.__escape.code) await new Promise((r) => setTimeout(r, 50)); return window.__escape.code; });
  await expect(page.locator('#wait-code')).toHaveText(code);

  const ws = new WebSocket(baseURL!.replace('http', 'ws') + '/ws');
  let myId = -1;
  let spawn: [number, number, number] | null = null;
  let sendF = 0;
  let epoch = 0;
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.t === 'welcome') myId = m.id;
    if (m.t === 'correct' && m.c !== undefined) epoch = m.c;
    if (m.t === 'snap' && !spawn) { const p = m.players.find((q: { id: number }) => q.id === myId); if (p) spawn = p.p; }
  });
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ t: 'hello', name: '机器人' }));
  ws.send(JSON.stringify({ t: 'join', code }));
  await expect(page.locator('#wait-members li')).toHaveCount(2);
  await expect(page.locator('#wait-members')).toContainText('机器人');
  await page.screenshot({ path: 'test-results/lobby.png' });
  await page.click('#start');
  await expect(page.locator('#hud')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => spawn, { timeout: 10_000 }).not.toBeNull();
  const sp = spawn!;
  const iv = setInterval(() => ws.send(JSON.stringify({ t: 'input', seq: ++sendF, p: sp, yaw: 0, pitch: 0, f: 1 /* F_CROUCH */, c: epoch })), 100);
  await expect.poll(() => page.evaluate(() => { const r = [...window.__escape.game()!.remotes.values()][0]; return !!r && r.mesh.visible && (r.f & 1) === 1; }), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__escape.game()!.remotes.size)).toBe(1);
  clearInterval(iv);
  ws.close();
});
