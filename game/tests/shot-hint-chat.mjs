// One-off repro (#211): ordinary chat vs bottom #hint after being caught, unlocked mouse.
// Start PORT=4463 HOST=127.0.0.1 NODE_ENV=development node dist-server/index.js separately, then:
// python3 /Users/local-user/escape/loop/parallel_sprint.py gate browser -- node tests/shot-hint-chat.mjs [tag]
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { browserArgs } from './browser-args.mjs';
import { assertDebugAvailable } from './helpers.mjs';

const base = process.env.URL ?? 'http://127.0.0.1:4463';
const tag = process.argv[2] ?? 'hint';
const browser = await chromium.launch({ args: browserArgs(['--mute-audio']) });
try {
for (const [w, h] of [[640, 360], [1280, 720]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const p = await ctx.newPage();
  await p.goto(base + '/');
  await p.fill('#name', '甲');
  await p.click('#create');
  await p.click('#start');
  await p.waitForSelector('#hud:not([hidden])', { timeout: 30_000 });
  await p.waitForFunction(() => (window.__escape.game()?.snaps ?? 0) > 5, null, { timeout: 30_000 });
await assertDebugAvailable(p);
  await p.waitForSelector('#banner[hidden]', { state: 'attached', timeout: 10_000 });
  await p.evaluate(() => window.__escape.debug('warden', 7));
  await p.waitForSelector('#down-overlay:not([hidden])', { timeout: 40_000 });
  assert.equal(await p.locator('#down-overlay .t').textContent(), '你被角色074抓住了');
  assert.doesNotMatch(await p.locator('#chat-log').textContent(), /你被|回到出生点倒地|无人搀扶/);
  await p.evaluate(() => window.__escape.net.send({ t: 'chat', text: '我在走廊这边，大家靠近一点，一起找到楼梯间钥匙再上楼。' }));
  await p.waitForFunction(() => document.getElementById('chat-log').textContent.includes('我在走廊这边'), null, { timeout: 10_000 });
  await p.waitForFunction(() => document.getElementById('hint').getAnimations().length === 0, null, { timeout: 20_000 });
  const r = await p.evaluate(() => {
    const hint = document.getElementById('hint'), log = document.getElementById('chat-log');
    const range = document.createRange(); range.selectNodeContents(hint);
    const a = range.getBoundingClientRect(), b = log.getBoundingClientRect();
    const hit = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const touch = a.left <= b.right && b.left <= a.right && a.top <= b.bottom && b.top <= a.bottom;
    return { hint: [a.left, a.top, a.right, a.bottom].map(Math.round), log: [b.left, b.top, b.right, b.bottom].map(Math.round), hit, touch, logH: b.height, hintOpacity: Number(getComputedStyle(hint).opacity), cls: hint.className };
  });
  console.log(w, h, JSON.stringify(r));
  assert.ok(r.logH > 0, 'Ordinary chat is present');
  assert.equal(r.hintOpacity > 0 && r.touch, false, 'Visible hint and chat must not touch');
  if (w === 1280) assert.ok(r.hintOpacity > 0, 'Wide-screen hint stays readable');
  await p.screenshot({ path: `test-results/${tag}-${w}.png`, timeout: 90_000 });
  await ctx.close();
}
} finally { await browser.close(); }
