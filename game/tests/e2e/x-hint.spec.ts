import { expect, test } from '@playwright/test';
import { shot } from './draw';
import { FeedbackPeer } from '../team-feedback-peer.ts';

// #211: mouse not locked, ordinary chat in #chat-log (bottom-left) must not overprint the key hint.
// A caught player sees the central message once; the former duplicate caught chat is intentionally absent.
// (#hint, bottom-centre, wraps upward on narrow screens). Visible text boxes must stay apart; the hint fades out when they would touch.
for (const [w, h] of [[640, 360], [1280, 720]] as const) {
  test(`caught message vs key hint don't overlap at ${w}×${h}`, async ({ page, baseURL }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: w, height: h });
    await page.goto('/?nodraw');
    await page.fill('#name', '甲');
    await page.click('#create');
    await expect(page.locator('#wait-code')).toHaveText(/^[A-Z2-9]{4}$/);
    const teammate = await new FeedbackPeer('站立队友', baseURL!.replace(/^http/, 'ws') + '/ws').connect();
    try {
    teammate.send({ t: 'join', code: await page.locator('#wait-code').innerText() });
    await teammate.waitMessage(0, 'room');
    await expect(page.locator('#wait-members li')).toHaveCount(2);
    await page.click('#start');
    await expect(page.locator('#hud')).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => page.evaluate(() => window.__escape.game()?.snaps ?? 0), { timeout: 15_000 }).toBeGreaterThan(5);
    await page.waitForFunction(() => !window.__escape.game()!.intro.active);
    teammate.send({ t: 'debug', op: 'safe', s: 600 });
    await expect(page.locator('#banner')).toBeHidden({ timeout: 10_000 });
    await page.evaluate(() => window.__escape.debug('warden', 7));
    await expect(page.locator('#down-overlay')).toBeVisible({ timeout: 40_000 });
    await expect(page.locator('#down-overlay .t')).toHaveText('你被角色074抓住了');
    await expect(page.locator('#chat-log')).not.toContainText(/你被|回到出生点倒地|无人搀扶/);
    await page.evaluate(() => window.__escape.net.send({ t: 'chat', text: '我在走廊这边，大家靠近一点，一起找到楼梯间钥匙再上楼。' }));
    await expect(page.locator('#chat-log')).toContainText('我在走廊这边');
    // let the hint's opacity transition settle before reading it
    await expect.poll(() => page.evaluate(() => document.getElementById('hint')!.getAnimations().length), { timeout: 20_000 }).toBe(0);
    const r = await page.evaluate(() => {
      const hint = document.getElementById('hint')!, log = document.getElementById('chat-log')!;
      const range = document.createRange();
      range.selectNodeContents(hint);
      const a = range.getBoundingClientRect(), b = log.getBoundingClientRect();
      return {
        hintShown: Number(getComputedStyle(hint).opacity) > 0,
        hit: a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom,
        touch: a.left <= b.right && b.left <= a.right && a.top <= b.bottom && b.top <= a.bottom,
        logH: b.height,
      };
    });
    await shot(page, `test-results/iter-211-hint-${w}.png`);
    expect(r.logH).toBeGreaterThan(0);
    // a shown hint may not even touch the chat column (#210 repro: 640×360 boxes met edge-on and read as one blur)
    expect(r.hintShown && r.touch).toBe(false);
    expect(r.hit && r.hintShown).toBe(false);
    // wide screen: the one-line hint clears the chat column, so it must stay readable rather than be hidden blindly
    if (w === 1280) expect(r.hintShown).toBe(true);
    } finally { await teammate.close(); }
  });
}
