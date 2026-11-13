import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { browserArgs } from './browser-args.mjs';
import { DEVELOPER_NAME } from '../shared/runMode.ts';

const out = 'test-results/role_boss-smoke';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, args: browserArgs(['--mute-audio']) });
const context = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
const page = await context.newPage(), errors = [], history = [];
page.on('pageerror', error => errors.push(error.message));
page.on('websocket', socket => socket.on('framereceived', event => {
  try { const message = JSON.parse(String(event.payload)); if (message.t === 'snap' || message.t === 'caught') history.push(message); } catch {}
}));
try {
  await page.goto(`${process.env.ESC_TEST_URL ?? 'http://127.0.0.1:4438'}/?nodraw&steady`);
  // Exercise the explicit developer summon; ordinary rooms deliberately have no named Boss by default.
  await page.fill('#name', DEVELOPER_NAME); await page.click('#create');
  await page.locator('#wait-hint').filter({ hasText: '开发者测试' }).waitFor();
  await page.click('#start');
  await page.waitForFunction(() => (window.__escape.game()?.snaps ?? 0) > 1);
  await page.evaluate(() => { const g = window.__escape.game(); if (g.intro?.active) window.__escape.net.send({ t: 'intro-skip', id: g.intro.id }); });
  await page.waitForFunction(() => !window.__escape.game().intro?.active);
  await page.evaluate(() => window.__escape.debug('level5'));
  await page.waitForFunction(() => window.__escape.game()?.level.index === 4 && window.__escape.game()?.mobs.byId.has(3));
  await page.evaluate(() => {
    const g = window.__escape.game();
    if (g.intro?.active) window.__escape.net.send({ t: 'intro-skip', id: g.intro.id });
    window.__escape.debug('safe', 120, 1);
    window.__escape.debug('tp', -100, 62, 0);
    g.input.yaw = Math.atan2(-6, -11.65); g.input.pitch = 0;
  });
  await page.waitForFunction(() => !window.__escape.game().intro?.active);
  await page.evaluate(() => window.__escape.net.send({ t: 'debug', op: 'boss' }));
  await expect.poll(() => history.at(-1)?.boss?.name).toBe('值周代号025');
  await page.waitForFunction(() => {
    const warning = document.getElementById('role_boss-warning');
    return warning && !warning.hidden && warning.textContent.includes('粉笔圈');
  }, null, { timeout: 25000, polling: 20 });
  const before = await page.evaluate(() => {
    const g = window.__escape.game(), warning = document.getElementById('role_boss-warning');
    const a = warning.getBoundingClientRect(), b = document.getElementById('objective').getBoundingClientRect();
    const mob = g.mobs.byId.get(2);
    return { p: [g.body.x, g.body.y, g.body.z], text: warning.textContent, live: warning.getAttribute('aria-live'),
      badge: !!mob.mesh.getObjectByName('ROLE_BOSS_CHALK_BADGE'), sash: !!mob.mesh.getObjectByName('ROLE_BOSS_DUTY_SASH'),
      overlapsObjective: a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top };
  });
  assert.equal(before.badge, true); assert.equal(before.sash, true); assert.equal(before.live, 'polite');
  assert.equal(before.overlapsObjective, false);
  const cast = history.filter(m => m.boss?.phase === 'windup').at(-1).boss;
  await page.keyboard.down('Shift'); await page.keyboard.down('d');
  await page.waitForFunction(target => {
    const g = window.__escape.game();
    return Math.hypot(g.body.x - target[0], g.body.z - target[2]) > 3.1;
  }, cast.target, { timeout: 1300, polling: 20 });
  await page.keyboard.up('d'); await page.keyboard.up('Shift');
  await page.waitForFunction(() => document.getElementById('role_boss-warning').textContent.includes('点名生效'), null, { timeout: 3000, polling: 20 });
  const after = await page.evaluate(() => { const g = window.__escape.game(); return { p: [g.body.x, g.body.y, g.body.z], down: g.down, spectate: g.spectate }; });
  const resolved = history.filter(m => m.boss?.phase === 'active').at(-1);
  assert.ok(resolved); assert.equal(after.down, false); assert.equal(after.spectate, false);
  assert.equal(history.some(m => m.t === 'caught'), false);
  await page.evaluate(() => window.__escape.debug('safe', 120));
  await page.evaluate(() => {
    const g = window.__escape.game();
    g.view = { x: -104.5, y: 2, z: 70.6, yaw: Math.atan2(1.5, -3.05), pitch: -.02 };
    g.light = true; g.draw = true;
  });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${out}/phone-boss.png` });
  assert.deepEqual(errors, []);
  const report = { status: 'passed', viewport: '844x390 touch', before, cast, after, authoritativeTick: resolved.tick, errors,
    limitations: 'A private developer room explicitly summons the Boss in L5 and disables Warden; dodge uses ordinary browser keyboard movement and server snapshots.' };
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
