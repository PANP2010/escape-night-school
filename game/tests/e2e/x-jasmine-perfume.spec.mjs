import { expect, test } from '@playwright/test';
import { CollisionWorld } from '../../shared/campus/collision.ts';
import { lineOfSight } from '../../shared/campus/nav.ts';
import { browserArgs } from '../browser-args.mjs';
import { JASMINE_VIEWS, jasminePixels, prepareJasminePage } from '../shot-jasmine.mjs';

test.use({ headless: process.platform !== 'darwin', launchOptions: { args: browserArgs(['--mute-audio']) } });

async function pinWarden(page, yaw, distance) {
  await page.evaluate(angle => { window.__escape.game().input.yaw = angle; }, yaw);
  await page.waitForFunction(angle => {
    const g = window.__escape.game(), me = window.__jasmineSnap?.players.find(player => player.id === g.myId);
    return me && Math.abs(Math.atan2(Math.sin(me.yaw - angle), Math.cos(me.yaw - angle))) < .03;
  }, yaw);
  await page.evaluate(d => {
    clearInterval(window.__perfumePlacement);
    const summon = () => { window.__escape.debug('warden', d); window.__escape.debug('safe', 600, 1); };
    summon(); window.__perfumePlacement = setInterval(summon, 500);
  }, distance);
  await page.waitForFunction(d => {
    const g = window.__escape.game(), warden = [...g.mobs.byId.values()].find(mob => !mob.monitor);
    return warden && Math.abs(warden.mesh.position.distanceTo(g.camera.position) - d) < 1.4;
  }, distance);
  await expect.poll(() => page.evaluate(() => Number(document.getElementById('jasmine').style.opacity))).toBeGreaterThan(.08);
  // Allow the real time-based scent release to reach the new distance before photographing it.
  await page.waitForTimeout(1100);
}

/** Compare composited pixels over the same real rendered campus. The game, mobs, scent and socket keep ticking. */
async function photograph(page, prefix) {
  const prior = await page.evaluate(() => {
    const g = window.__escape.game(), el = document.getElementById('jasmine');
    const previous = { draw: g.drawOn, visibility: el.style.visibility };
    g.drawOn = false;
    return previous;
  });
  const hudRects = () => page.evaluate(() => [...document.querySelectorAll('#hud > *, #touch-base, #touch-btns, #touch-chat, #touch-map')]
    .filter(el => !el.hidden && getComputedStyle(el).display !== 'none')
    .map(el => el.getBoundingClientRect()).filter(r => r.width && r.height && r.width * r.height < innerWidth * innerHeight / 2)
    .map(({ left, right, top, bottom }) => ({ left, right, top, bottom })));
  const pair = {};
  try {
    for (const [name, visibility] of [['off', 'hidden'], ['on', prior.visibility]]) {
      await page.evaluate(value => { document.getElementById('jasmine').style.visibility = value; }, visibility);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const before = await hudRects(), path = `${prefix}-${name}.png`;
      await page.screenshot({ path, animations: 'disabled' });
      pair[name] = { path, hudRects: [...before, ...await hudRects()] };
    }
  } finally {
    await page.evaluate(previous => {
      window.__escape.game().drawOn = previous.draw;
      document.getElementById('jasmine').style.visibility = previous.visibility;
    }, prior);
  }
  const pixels = await jasminePixels(page, pair);
  expect(pixels.rim.changed, 'actual yellow perfume pixels at the rim').toBeGreaterThan(200);
  expect(pixels.rim.mean).toBeGreaterThan(.15);
  expect(pixels.centre.changed, 'view centre stays clear').toBe(0);
  return pixels;
}

for (const view of JASMINE_VIEWS) {
  test(`perfume stays visual with low effects, walls and blackouts on ${view.name}`, async ({ browser, baseURL }) => {
    test.setTimeout(120_000);
    const { page, context, errors } = await prepareJasminePage(browser, baseURL, view);
    try {
      await page.waitForFunction(() => !window.__escape.game().intro.active);
      const geometry = await page.evaluate(() => {
        const g = window.__escape.game();
        return { p: { ...g.body }, area: g.level.def.area, boxes: g.collision.query(g.body.x - 16, g.body.z - 16, g.body.x + 16, g.body.z + 16) };
      });
      const world = new CollisionWorld(geometry.boxes), from = { x: geometry.p.x, y: geometry.p.y + 1.4, z: geometry.p.z };
      const blockedYaw = [0, Math.PI, -Math.PI / 2, Math.PI / 2, .4, -.4].find(angle => {
        const x = geometry.p.x - Math.sin(angle) * 7, z = geometry.p.z - Math.cos(angle) * 7;
        return x > geometry.area.x0 && x < geometry.area.x1 && z > geometry.area.z0 && z < geometry.area.z1
          && !lineOfSight(world, from, { x, y: from.y, z });
      });
      expect(blockedYaw).toBeDefined();
      await pinWarden(page, blockedYaw, 7);
      const occluded = await page.evaluate(() => {
        const g = window.__escape.game(), warden = [...g.mobs.byId.values()].find(mob => !mob.monitor);
        return { me: { x: g.body.x, y: g.body.y + 1.4, z: g.body.z }, warden: { x: warden.mesh.position.x, y: warden.mesh.position.y + 1.4, z: warden.mesh.position.z },
          boxes: g.collision.query(g.body.x - 16, g.body.z - 16, g.body.x + 16, g.body.z + 16) };
      });
      expect(lineOfSight(new CollisionWorld(occluded.boxes), occluded.me, occluded.warden)).toBe(false);
      await expect(page.locator('#jasmine-cue')).toHaveCount(0);
      await expect(page.locator('#jasmine')).toHaveText('');
      await expect(page.locator('#tut')).not.toContainText(/茉莉香|角色074|避险/);
      if (view.name === 'mobile') await expect(page.locator('#jasmine')).toHaveAttribute('data-quality', 'low');
      await page.locator('#settings-open').click();
      await page.locator('#settings-postprocessing').uncheck();
      await page.locator('#settings-close').click();
      await expect(page.locator('#jasmine')).not.toHaveAttribute('hidden');
      await expect(page.locator('#jasmine')).toHaveAttribute('data-quality', 'low');
      const middle = await photograph(page, `test-results/perfume-${view.name}-middle-low`);
      await pinWarden(page, -Math.PI / 2, 14);
      const far = await photograph(page, `test-results/perfume-${view.name}-far-low`);
      await pinWarden(page, -Math.PI / 2, 3);
      await page.evaluate(() => window.__escape.debug('power', 30));
      await page.waitForFunction(() => window.__escape.game().campus.out > 0);
      const near = await photograph(page, `test-results/perfume-${view.name}-near-blackout-low`);
      console.log('PERFUME PIXELS', view.name, JSON.stringify({ far: far.rim, middle: middle.rim, near: near.rim }));
      await page.evaluate(() => clearInterval(window.__perfumePlacement));
      await page.evaluate(() => { const e = window.__escape; e.debug('warden', 24); e.debug('safe', 600, 1); });
      await expect.poll(() => page.evaluate(() => Number(document.getElementById('jasmine').style.opacity))).toBe(0);
      await pinWarden(page, -Math.PI / 2, 7);
      await page.evaluate(() => {
        clearInterval(window.__perfumePlacement);
        const e = window.__escape, receive = e.net.onMsg;
        window.__perfumeReceive = receive;
        e.net.onMsg = message => { if (message.t !== 'snap') receive(message); };
        e.game().lastFeedbackSnap = -Infinity;
      });
      await expect.poll(() => page.evaluate(() => Number(document.getElementById('jasmine').style.opacity))).toBe(0);
      await page.evaluate(() => { window.__escape.net.onMsg = window.__perfumeReceive; });
      await expect.poll(() => page.evaluate(() => Number(document.getElementById('jasmine').style.opacity))).toBeGreaterThan(.08);
      await context.setOffline(true);
      await page.evaluate(() => window.__escape.net.ws.close());
      await expect.poll(() => page.evaluate(() => window.__escape.game().networkPaused)).toBe(true);
      await expect.poll(() => page.evaluate(() => Number(document.getElementById('jasmine').style.opacity))).toBe(0);
      expect(errors.filter(message => !/WebSocket|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/.test(message))).toEqual([]);
    } finally {
      await page.evaluate(() => clearInterval(window.__perfumePlacement)).catch(() => {});
      await context.close();
    }
  });
}
