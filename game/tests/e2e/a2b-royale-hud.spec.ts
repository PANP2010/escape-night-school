// A2b royale HUD e2e: verify zone panel, fog, map circles visible in a real browser (2 clients).
import { test, expect, type Page } from '@playwright/test';
import { chromium } from '@playwright/test';
import { shot } from './draw';
import { storySites } from '../../shared/storySite.ts';
import { L1 } from '../../shared/levels/l1.ts';

test.describe.configure({ retries: 1 });

test('A2b royale HUD: zone panel, fog, map visible; 1 inside, 1 teleported out', async ({ baseURL }) => {
  test.setTimeout(120_000);
  const browser = await chromium.launch();
  const ctx1 = await browser.newContext({ baseURL, viewport: { width: 640, height: 400 } });
  const ctx2 = await browser.newContext({ baseURL, viewport: { width: 640, height: 400 } });
  const p1 = await ctx1.newPage();
  const p2 = await ctx2.newPage();

  await p1.goto('/');
  await p1.fill('#name', 'PlayerIn');
  await p1.selectOption('#mode-selector', 'royale');
  await p1.click('#create');
  const code = await p1.evaluate(async () => { while (!window.__escape.code) await new Promise(r => setTimeout(r, 50)); return window.__escape.code; });
  
  await p2.goto('/');
  await p2.fill('#name', 'PlayerOut');
  await p2.fill('#code', code);
  await p2.click('#join');

  await expect(p1.locator('#wait-members li')).toHaveCount(2);
  await p1.click('#start');
  
  // Wait for game to be ready and first snap to arrive (royale zone data).
  await p1.waitForFunction(() => {
    const g = window.__escape.game(); return g?.presentationReady && !g.intro.active && g.snaps > 3;
  }, null, { timeout: 30_000 });
  await p2.waitForFunction(() => {
    const g = window.__escape.game(); return g?.presentationReady && !g.intro.active && g.snaps > 3;
  }, null, { timeout: 30_000 });

  // Zone HUD should be visible on both clients.
  await expect(p1.locator('#zone-hud')).toBeVisible({ timeout: 5000 });
  await expect(p2.locator('#zone-hud')).toBeVisible({ timeout: 5000 });

  // Both should show grace countdown and alive 2.
  const head1 = await p1.locator('.zh-head').innerText();
  expect(head1).toMatch(/后安全区开始收缩/);
  const alive1 = await p1.locator('.zh-alive').innerText();
  expect(alive1).toMatch(/存活 2/);

  // Teleport p2 far outside the initial zone (phase 0: center [0,100], radius 145 m).
  // Place p2 at south-west corner of campus: (-120, 0) is ~154 m from center → outside.
  await p2.evaluate(() => { window.__escape.debug('tp', -120, 0, 0); });
  await p2.waitForTimeout(1200);

  // p1 (spawned near [0,100], likely inside) should show safe or warn.
  const status1 = await p1.locator('.zh-status').innerText();
  expect(status1).toMatch(/(圈内|安全|向圈心靠拢)/);

  // p2 (teleported out) should show "圈外" and elimination countdown.
  const status2 = await p2.locator('.zh-status').innerText();
  expect(status2).toMatch(/圈外/);
  expect(status2).toMatch(/被熄灯吞没/);

  // Fog should be visible on p2 (outside), low/zero on p1 (inside).
  const fog1Opacity = await p1.locator('#zone-fog').evaluate((el: HTMLElement) => parseFloat(el.style.opacity || '0'));
  const fog2Opacity = await p2.locator('#zone-fog').evaluate((el: HTMLElement) => parseFloat(el.style.opacity || '0'));
  expect(fog1Opacity).toBeLessThan(0.4); // inside: fog target 0
  expect(fog2Opacity).toBeGreaterThan(0.4); // outside: fog ramps up

  // Open map on p1, verify title and zone HUD still visible.
  await p1.keyboard.press('m');
  await p1.waitForTimeout(600);
  await expect(p1.locator('#map')).toBeVisible();
  const mapTitle = await p1.locator('.mt').innerText();
  expect(mapTitle).toMatch(/校园平面图/);

  // Screenshot: p1 inside with map, p2 outside with fog, p1 HUD only.
  await p1.screenshot({ path: 'test-results/a2b-royale-in-map.png' });
  await p2.screenshot({ path: 'test-results/a2b-royale-out-fog.png' });
  await p1.keyboard.press('m'); // close map
  await p1.waitForTimeout(300);
  await p1.screenshot({ path: 'test-results/a2b-royale-in-hud.png' });

  await ctx1.close();
  await ctx2.close();
  await browser.close();
});

function royalePosition(page: Page) {
  return page.evaluate(() => {
    const g = window.__escape.game() as any;
    const p = g.peers.get(g.myId)?.p as number[] | undefined;
    if (!p) throw new Error('own authoritative position missing from live snapshot');
    return [...p];
  });
}

async function moveInRoyale(page: Page, touch: boolean, pressJournal = false) {
  const before = await royalePosition(page);
  const cdp = touch ? await page.context().newCDPSession(page) : undefined;
  const sy = Math.round(page.viewportSize()!.height * 0.7);
  for (const [key, dx, dy] of [['w', 0, -45], ['s', 0, 45], ['a', -45, 0], ['d', 45, 0]] as const) {
    if (cdp) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 90, y: sy, id: 1 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 90 + dx, y: sy + dy, id: 1 }] });
    } else await page.keyboard.down(key);
    try {
      if (pressJournal) {
        await page.keyboard.press('j');
        expect(await page.evaluate(() => window.__escape.game()!.input.enabled)).toBe(true);
        expect(await page.evaluate(key => window.__escape.game()!.input.keys.has(key),
          `Key${key.toUpperCase()}`), 'J must preserve the held movement input').toBe(true);
        await expect(page.locator('.story-view__panel')).toBeHidden();
      }
      await page.waitForFunction(at => {
        const g = window.__escape.game() as any;
        const p = g.peers.get(g.myId)?.p as number[] | undefined;
        return !!p && Math.hypot(p[0] - at[0], p[1] - at[1], p[2] - at[2]) >= 3;
      }, before, { timeout: 5000 });
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'TimeoutError') throw error;
    } finally {
      if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      else await page.keyboard.up(key);
    }
    const after = await royalePosition(page);
    if (Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]) >= 3) {
      await cdp?.detach();
      return;
    }
  }
  await cdp?.detach();
  const after = await royalePosition(page);
  expect(Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]),
    'server snapshot should accept at least 3 m of actual movement').toBeGreaterThanOrEqual(3);
}

async function expectNoCampaignHud(page: Page) {
  for (const selector of ['.story-view', '.story-view__toggle', '.story-view__read', '.story-view__panel', '.story-view__toast'])
    await expect(page.locator(selector)).toBeHidden();
  expect(await page.evaluate(() => window.__escape.game()!.story.isOpen)).toBe(false);
  expect(await page.evaluate(() => window.__escape.game()!.story.candidateId)).toBeUndefined();
  await expect(page.locator('#hint')).not.toContainText('J 线索记录');
  await expect(page.locator('#objective')).toBeHidden();
  await expect(page.locator('#banner')).toBeHidden();
  await expect(page.locator('#goal-arrow')).toBeHidden();
  await expect(page.locator('#tut')).toBeHidden();
  const text = await page.evaluate(() => ['#objective', '#banner', '#keys', '#prompt', '#goal-arrow', '#tut', '.story-view']
    .map(id => {
      const el = document.querySelector<HTMLElement>(id);
      return el && !el.hidden && el.getClientRects().length ? el.textContent ?? '' : '';
    }).join(' '));
  expect(text).not.toMatch(/抽屉|钥匙|楼梯|目标\s*\d+\s*\/\s*\d+|晚自习后|线索本|阅读线索|查看.*线索/);
}

test('A2b royale keeps campaign guidance suppressed after real movement and later snaps', async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  const recordVideo = process.env.ESC_R57_VIDEO ? { dir: 'test-results/iter-57-video', size: { width: 1280, height: 720 } } : undefined;
  const desktop = await browser.newContext({ baseURL, viewport: { width: 1280, height: 720 }, recordVideo });
  const mobile = await browser.newContext({ baseURL, viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
  for (const ctx of [desktop, mobile]) await ctx.addInitScript(() => {
    localStorage.setItem('escape.settings', JSON.stringify({ pixelRatio: 1, postprocessing: false }));
  });
  const p1 = await desktop.newPage();
  const p2 = await mobile.newPage();
  try {
    await p1.goto('/?nodraw&steady');
    await p1.fill('#name', 'RoyaleDesktop');
    await p1.selectOption('#mode-selector', 'royale');
    await p1.click('#create');
    const code = await p1.evaluate(async () => {
      while (!window.__escape.code) await new Promise(r => setTimeout(r, 50));
      return window.__escape.code;
    });
    await p2.goto('/?nodraw&steady');
    await p2.fill('#name', 'RoyaleMobile');
    await p2.fill('#code', code);
    await p2.click('#join');
    await expect(p1.locator('#wait-members li')).toHaveCount(2);
    await p1.click('#start');
    for (const page of [p1, p2]) {
      await page.waitForFunction(() => {
        const g = window.__escape.game() as any;
        return g?.presentationReady && !g.intro.active && g.royaleZone;
      }, null, { timeout: 45_000 });
      await expect(page.locator('#zone-hud')).toBeVisible();
      await expectNoCampaignHud(page);
      await page.locator('body > canvas').evaluate((canvas: HTMLElement) => { canvas.tabIndex = -1; canvas.focus(); });
      await page.keyboard.press('j');
      await expectNoCampaignHud(page);
      expect(await page.evaluate(() => window.__escape.game()!.input.enabled)).toBe(true);
    }

    // Tap the removed notebook's original touch position, without targeting a hidden DOM node.
    await p2.touchscreen.tap(180, 66);
    await expectNoCampaignHud(p2);
    expect(await p2.evaluate(() => window.__escape.game()!.input.enabled)).toBe(true);

    const before = await Promise.all([royalePosition(p1), royalePosition(p2)]);
    await Promise.all([moveInRoyale(p1, false, true), moveInRoyale(p2, true, true)]);
    const after = await Promise.all([royalePosition(p1), royalePosition(p2)]);
    for (let i = 0; i < 2; i++) {
      expect(Math.hypot(after[i][0] - before[i][0], after[i][1] - before[i][1], after[i][2] - before[i][2]))
        .toBeGreaterThanOrEqual(3);
    }

    // The real server broadcasts late bag/keys messages to both clients, alongside continuing snaps.
    await p1.evaluate(() => { window.__escape.debug('key', -1); window.__escape.debug('key', 0); });
    for (const page of [p1, p2]) await page.waitForFunction(() => {
      const g = window.__escape.game() as any;
      return g.bag.stair_key > 0 && g.heldKeys.includes(0);
    });

    // Stay inside the current circle, outside the next one: directional guidance without elimination.
    for (const page of [p1, p2]) {
      await page.evaluate(() => {
        const g = window.__escape.game() as any, next = g.nextZone;
        const points = [[-110, 100], [110, 100], [0, 5], [0, 205]];
        points.sort((a, b) => Math.hypot(b[0] - next.center[0], b[1] - next.center[1])
          - Math.hypot(a[0] - next.center[0], a[1] - next.center[1]));
        window.__escape.debug('tp', points[0][0], points[0][1], 0);
        g.input.yaw = 0;
      });
      await expect(page.locator('.zh-status')).toContainText('向圈心靠拢');
      await expect(page.locator('.zh-dist')).toContainText(/\d+ m/);
      await expect(page.locator('.zh-arrow')).toHaveCSS('visibility', 'visible');
      await expect(page.locator('.zh-alive')).toContainText('存活 2');
      if (page === p2) await page.locator('#touch-map').tap();
      else await page.keyboard.press('m');
      await expect(page.locator('#map')).toBeVisible();
      await expectNoCampaignHud(page);
      await page.keyboard.press('j');
      await expectNoCampaignHud(page);
      if (page === p2) await page.locator('#touch-map').tap();
      else await page.keyboard.press('m');
      await expect(page.locator('#map')).toBeHidden();
      await expectNoCampaignHud(page);
      const rotation = await page.locator('.zh-arrow').evaluate((el: HTMLElement) => el.style.transform);
      await page.evaluate(() => { window.__escape.game()!.input.yaw += Math.PI / 2; });
      await expect.poll(() => page.locator('.zh-arrow').evaluate((el: HTMLElement) => el.style.transform)).not.toBe(rotation);
    }
    const countdown = await p2.locator('.zh-head').innerText();
    await expect.poll(() => p2.locator('.zh-head').innerText(), { timeout: 5000 }).not.toBe(countdown);

    // Supplement the real deliveries with a populated drawer bag, then let live frames/snaps run again.
    for (const page of [p1, p2]) {
      await page.evaluate(() => {
        const g = window.__escape.game() as any;
        g.onMsg({ t: 'bag', bag: { drawer_key: 1, stair_key: 1, door_key: 1, battery: 1 } });
      });
      const distance = await page.locator('.zh-dist').innerText();
      const snaps = await page.evaluate(() => window.__escape.game()!.snaps);
      await moveInRoyale(page, page === p2, true);
      await expect.poll(() => page.locator('.zh-dist').innerText()).not.toBe(distance);
      await page.waitForFunction(n => window.__escape.game()!.snaps > n + 3, snaps);
      await expectNoCampaignHud(page);
      await expect(page.locator('#zone-hud')).toBeVisible();
      await expect(page.locator('.zh-status')).toContainText('向圈心靠拢');
      await expect(page.locator('.zh-alive')).toContainText('存活 2');
    }
    // Re-arm the pending opening path after the server has announced Royale, with actual rendered frames.
    for (const page of [p1, p2]) await page.evaluate(() => {
      const g = window.__escape.game() as any;
      g.draw = true;
      g.objectiveTiming.input();
    });
    await Promise.all([p1.waitForTimeout(1000), p2.waitForTimeout(1000)]);
    await Promise.all([expectNoCampaignHud(p1), expectNoCampaignHud(p2)]);
    await expect(p1.locator('.zh-head')).toContainText(/\d+:\d+/);
    await expect(p2.locator('.zh-head')).toContainText(/\d+:\d+/);
    await shot(p1, 'test-results/iter-57-desktop.png');
    await shot(p2, 'test-results/iter-57-mobile.png');
    if (recordVideo) {
      // The final 15 seconds are continuous real rendering, movement and map/shortcut interaction.
      await moveInRoyale(p1, false, true);
      await p1.keyboard.press('m');
      await p1.waitForTimeout(3000);
      await p1.keyboard.press('j');
      await p1.keyboard.press('m');
      await p1.keyboard.down('s');
      await p1.keyboard.press('j');
      await p1.waitForTimeout(9000);
      await p1.keyboard.up('s');
      await expectNoCampaignHud(p1);
    }
  } finally {
    await desktop.close();
    await mobile.close();
    if (recordVideo) await p1.video()!.saveAs('test-results/iter-57-royale.webm');
  }
});

test('A2b campaign L1 keeps the notebook and physical clue reading in both viewports', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  for (const touch of [false, true]) {
    const context = await browser.newContext({ baseURL, viewport: touch ? { width: 844, height: 390 } : { width: 1280, height: 720 },
      isMobile: touch, hasTouch: touch });
    const page = await context.newPage();
    try {
      await page.goto('/?nodraw&steady');
      await page.fill('#name', touch ? 'StoryMobile' : 'StoryDesktop');
      await page.click('#create');
      await page.click('#start');
      await page.waitForFunction(() => {
        const g = window.__escape.game() as any;
        return g?.presentationReady && g.spawnSynced && !g.intro.active;
      });
      await page.evaluate(() => window.__escape.debug('safe', 600));
      await expect(page.locator('.story-view__toggle')).toBeVisible();
      await page.locator('body > canvas').evaluate((canvas: HTMLElement) => { canvas.tabIndex = -1; canvas.focus(); });
      if (touch) await page.locator('.story-view__toggle').tap();
      else await page.keyboard.press('j');
      await expect(page.locator('.story-view__panel')).toContainText('第1章');
      await expect(page.locator('.story-view__panel')).toContainText('抽屉钥匙');
      expect(await page.evaluate(() => window.__escape.game()!.input.enabled)).toBe(false);
      if (touch) await page.locator('.story-view__close').tap();
      else await page.keyboard.press('Escape');
      expect(await page.evaluate(() => window.__escape.game()!.input.enabled)).toBe(true);
      const site = storySites(0, L1)[0];
      await page.evaluate(site => {
        const g = window.__escape.game()!;
        window.__escape.debug('tp', site.p[0] + site.normal[0] * 1.5, site.p[2] + site.normal[2] * 1.5, 0);
        g.input.yaw = Math.atan2(site.normal[0], site.normal[2]);
        g.input.pitch = 0;
      }, site);
      await expect.poll(() => page.evaluate(() => window.__escape.game()!.story.candidateId)).toBe(site.id);
      await expect(page.locator('.story-view__read')).toBeVisible();
      await expect(page.locator('#prompt')).toContainText('阅读线索');
      if (touch) await page.locator('.story-view__read').tap();
      else {
        await page.locator('body > canvas').evaluate((canvas: HTMLElement) => canvas.focus());
        await page.keyboard.press('e');
      }
      await expect(page.locator('.story-view__panel')).toBeVisible();
      await expect(page.locator('.story-view__entry')).toContainText(site.text);
      await shot(page, `test-results/iter-57-l1-${touch ? 'mobile' : 'desktop'}.png`);
    } finally { await context.close(); }
  }
});

// 夜外脚下 (R13-2, 用户 10-28「最暗也要看清脚底的路」): the royale spawn at 22:30, torch off, low tier, every HUD layer
// hidden — only scene pixels count. The ground band underfoot (bottom 40 %, centre 70 %) must be lit enough to see at
// all, the night must stay night (no blown-out frame), and the horizon must separate sky from ground. Baseline before
// the lighting fix: band mean 5.9 (black). Paving/curb geometry is covered separately by campus_spawn_paving.test.ts.
test('A2b royale night ground: spawn underfoot readable with HUD hidden', async ({ baseURL }) => {
  test.setTimeout(120_000);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ baseURL, viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(() => localStorage.setItem('escape.settings', JSON.stringify({ pixelRatio: 1, postprocessing: false, sensitivity: 1 })));
  const page = await ctx.newPage();
  try {
    await page.goto('/');
    await page.fill('#name', 'NightGround');
    await page.selectOption('#mode-selector', 'royale');
    await page.click('#create');
    await page.click('#start');
    await page.waitForFunction(() => window.__escape?.game()?.presentationReady && (window.__escape.game()?.snaps ?? 0) > 0, null, { timeout: 60_000 });
    const stats = await page.evaluate(async () => {
      const g = window.__escape.game() as any;
      // The review's spawn pose (6, 1.63, 192.3), looking north at the boiler house: torch off, HUD invisible.
      g.view = { x: 6, y: 1.63, z: 192.3, yaw: 0, pitch: -0.12 };
      g.light = false;
      for (const sel of ['#hud', '#touch', '#map', '#loading', '#fade-overlay', '#blink-overlay']) {
        for (const el of document.querySelectorAll<HTMLElement>(sel)) el.style.visibility = 'hidden';
      }
      const raf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
      for (let i = 0; i < 3; i++) await raf();
      for (let i = 0; i < 2; i++) g.renderer.render(g.scene, g.camera);
      const cv = document.createElement('canvas'); cv.width = innerWidth; cv.height = innerHeight;
      const x = cv.getContext('2d', { willReadFrequently: true })!;
      x.drawImage(g.renderer.domElement, 0, 0, innerWidth, innerHeight);
      const luma = (d: Uint8ClampedArray, i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const all = x.getImageData(0, 0, innerWidth, innerHeight).data;
      let sum = 0, white = 0, n = 0;
      for (let i = 0; i < all.length; i += 4) { sum += luma(all, i); n++; if (all[i] > 245 && all[i + 1] > 245 && all[i + 2] > 245) white++; }
      // ground underfoot: bottom 40 %, centre 70 %; sky right above the horizon for the sky/ground step
      const band = x.getImageData(Math.round(innerWidth * 0.15), Math.round(innerHeight * 0.58), Math.round(innerWidth * 0.7), Math.round(innerHeight * 0.4)).data;
      let bs = 0, bn = 0; const lums: number[] = [];
      for (let i = 0; i < band.length; i += 4) { const l = luma(band, i); bs += l; bn++; lums.push(l); }
      const bandMean = bs / bn, sd = Math.sqrt(lums.reduce((a, b) => a + (b - bandMean) ** 2, 0) / bn);
      const sky = x.getImageData(Math.round(innerWidth * 0.15), Math.round(innerHeight * 0.3), Math.round(innerWidth * 0.7), Math.round(innerHeight * 0.2)).data;
      let ss = 0, sn = 0;
      for (let i = 0; i < sky.length; i += 4) { ss += luma(sky, i); sn++; }
      return { frame: +(sum / n).toFixed(1), whitePct: +(100 * white / n).toFixed(2), band: +bandMean.toFixed(1), sd: +sd.toFixed(1), sky: +(ss / sn).toFixed(1) };
    });
    console.log('NIGHTGROUND', JSON.stringify(stats));
    await shot(page, 'test-results/r13-2-night-ground.png');
    // Lit enough to walk, still night: the pre-fix band sat at ~6 (indistinguishable from black).
    expect(stats.band, 'ground band mean luma (sRGB)').toBeGreaterThanOrEqual(16);
    expect(stats.band).toBeLessThanOrEqual(60);
    // Night keeps its character: nothing is blown out.
    expect(stats.whitePct).toBeLessThan(1);
    expect(stats.frame).toBeLessThan(80);
    // Sky and ground separate at the horizon instead of merging into one black field.
    expect(stats.band - stats.sky).toBeGreaterThanOrEqual(6);
    // Keep a tree-lined view too: brighter ground must not turn the crowns or falling leaves into a night glow.
    await page.evaluate(() => { window.__escape.game()!.view = { x: 4, y: 1.63, z: 18, yaw: 0, pitch: -0.12 }; });
    await shot(page, 'test-results/r13-2-night-trees.png');
  } finally {
    await ctx.close();
    await browser.close();
  }
});

// R13-5 (审查 #13/#41/#51): the royale hides the task card, so the safe-zone card takes that top-right slot. Both viewports,
// plan open and closed, all three zone states: the card keeps 4 px clear of the room line, tutorial bar, map/chat
// buttons, gauges and the open plan, its lines do not collide, and nothing painted sits on top of its text.
type Box = { id: string; x: number; y: number; w: number; h: number };
function zoneLayout(page: Page) {
  return page.evaluate(() => {
    const shown = (el: Element | null): el is HTMLElement => {
      if (!(el instanceof HTMLElement) || !el.getClientRects().length || getComputedStyle(el).visibility === 'hidden') return false;
      for (let n: HTMLElement | null = el; n; n = n.parentElement) if (+getComputedStyle(n).opacity === 0) return false;
      return true;
    };
    const box = (id: string, el: Element): Box => { const r = el.getBoundingClientRect(); return { id, x: r.left, y: r.top, w: r.width, h: r.height }; };
    const hud = document.getElementById('zone-hud')!;
    const parts = Array.from(hud.querySelectorAll('.zh-alive, .zh-head, .zh-status, .zh-dist, .zh-bar')).filter(shown).map(el => box(el.className, el));
    const others = ['#room-code', '#tut', '#host-status', '.story-view__toggle', '#settings-open', '#touch-map', '#touch-chat', '#battery', '#stamina', '#map']
      .map(sel => [sel, document.querySelector(sel)] as const).filter(([, el]) => shown(el)).map(([sel, el]) => box(sel, el!));
    // Hit-test in paint order: the HUD layers are pointer-events:none, so lift that for the probe only.
    const force = document.createElement('style');
    force.textContent = '* { pointer-events: auto !important; }';
    document.head.append(force);
    const paints = (el: Element) => {
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && +s.opacity > 0 && (!/^rgba\(.*, 0\)$|^transparent$/.test(s.backgroundColor) || s.backgroundImage !== 'none'
        || Array.from(el.childNodes).some(n => n.nodeType === Node.TEXT_NODE && !!n.textContent?.trim()));
    };
    const covered: string[] = [];
    for (const el of Array.from(hud.querySelectorAll('.zh-alive, .zh-head, .zh-status, .zh-dist'))) {
      const r = el.getBoundingClientRect();
      for (const [x, y] of [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 2, r.top + 2], [r.right - 2, r.top + 2], [r.left + 2, r.bottom - 2], [r.right - 2, r.bottom - 2]]) {
        const top = document.elementsFromPoint(x, y).find(e => hud.contains(e) || paints(e));
        if (!top || !hud.contains(top)) covered.push(`${el.className} @${Math.round(x)},${Math.round(y)} under ${top ? top.id || top.className || top.tagName : 'nothing'}`);
      }
    }
    force.remove();
    return { vw: innerWidth, vh: innerHeight, card: box('#zone-hud', hud), parts, others, covered };
  });
}

async function expectZoneClear(page: Page, label: string) {
  const L = await zoneLayout(page), c = L.card;
  const near = (a: Box, b: Box, gap: number) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
  console.log('R13-5', label, JSON.stringify(c));
  expect.soft(c.x >= 0 && c.y >= 0 && c.x + c.w <= L.vw && c.y + c.h <= L.vh, `${label}: card inside the viewport ${JSON.stringify(c)}`).toBe(true);
  expect.soft(L.others.filter(o => near(c, o, 4)).map(o => JSON.stringify(o)), `${label}: card ${JSON.stringify(c)} overlaps`).toEqual([]);
  expect.soft(L.parts.filter(p => p.x < c.x - 0.5 || p.y < c.y - 0.5 || p.x + p.w > c.x + c.w + 0.5 || p.y + p.h > c.y + c.h + 0.5).map(p => p.id), `${label}: text spills out of the card`).toEqual([]);
  expect.soft(L.parts.flatMap((a, i) => L.parts.slice(i + 1).filter(b => near(a, b, -1)).map(b => `${a.id}/${b.id}`)), `${label}: card lines collide`).toEqual([]);
  expect.soft(L.covered, `${label}: something painted over the card text`).toEqual([]);
}

test('R13-5 royale zone card stays readable beside the room line, map buttons and the open campus plan', async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  const desktop = await browser.newContext({ baseURL, viewport: { width: 1280, height: 720 } });
  const mobile = await browser.newContext({ baseURL, viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
  for (const ctx of [desktop, mobile]) await ctx.addInitScript(() => {
    localStorage.setItem('escape.settings', JSON.stringify({ pixelRatio: 1, postprocessing: false }));
  });
  const p1 = await desktop.newPage();
  const p2 = await mobile.newPage();
  try {
    await p1.goto('/?nodraw&steady');
    await p1.fill('#name', '审查13桌面');
    await p1.selectOption('#mode-selector', 'royale');
    await p1.click('#create');
    const code = await p1.evaluate(async () => {
      while (!window.__escape.code) await new Promise(r => setTimeout(r, 50));
      return window.__escape.code;
    });
    await p2.goto('/?nodraw&steady');
    await p2.fill('#name', '审查13手机');
    await p2.fill('#code', code);
    await p2.click('#join');
    await expect(p1.locator('#wait-members li')).toHaveCount(2);
    await p1.click('#start');
    for (const page of [p1, p2]) await page.waitForFunction(() => {
      const g = window.__escape.game() as any;
      return g?.presentationReady && !g.intro.active && g.snaps > 3 && g.royaleZone;
    }, null, { timeout: 45_000 });
    // safe: centre of the next circle; warn: inside this circle, outside the next; out: the south-west corner.
    const place = (page: Page, state: 'safe' | 'warn' | 'out') => page.evaluate(s => {
      const g = window.__escape.game() as any, next = g.nextZone ?? g.royaleZone;
      const far = [[-110, 100], [110, 100], [0, 5], [0, 205]].sort((a, b) => Math.hypot(b[0] - next.center[0], b[1] - next.center[1])
        - Math.hypot(a[0] - next.center[0], a[1] - next.center[1]))[0];
      const [x, z] = s === 'safe' ? next.center : s === 'warn' ? far : [-120, 0];
      window.__escape.debug('tp', x, z, 0);
    }, state);
    for (const [page, view] of [[p1, 'desktop'], [p2, 'mobile']] as const) {
      const setMap = async (open: boolean) => {
        if (await page.locator('#map').isVisible() !== open) {
          if (view === 'mobile') await page.locator('#touch-map').tap(); else await page.keyboard.press('m');
        }
        await expect(page.locator('#map')).toBeVisible({ visible: open });
      };
      for (const [state, text] of [['safe', '圈内'], ['warn', '向圈心靠拢'], ['out', '被熄灯吞没']] as const) {
        for (const open of [false, true]) {
          await setMap(open);
          await place(page, state);
          await expect(page.locator('#zone-hud')).toHaveAttribute('data-state', state);
          await expect(page.locator('.zh-status')).toContainText(text);
          await page.waitForTimeout(250);
          const label = `${view}-${state}-${open ? 'map' : 'hud'}`;
          await expectZoneClear(page, label);
          await page.screenshot({ path: `test-results/r13-5-${label}.png` });
          // The server eliminates after 8 s outside: step back in before the next pose.
          if (state === 'out') { await place(page, 'safe'); await expect(page.locator('#zone-hud')).toHaveAttribute('data-state', 'safe'); }
        }
      }
      if (view === 'desktop') {
        await setMap(true);
        for (const [width, height] of [[1280, 720], [960, 540], [800, 600], [640, 400], [1280, 720]]) {
          await page.evaluate(async () => { if (document.fullscreenElement) await document.exitFullscreen(); });
          await page.setViewportSize({ width, height });
          await page.waitForTimeout(250);
          const label = `desktop-${width}x${height}-map`, L = await zoneLayout(page);
          const panel = L.others.find(o => o.id === '#map')!;
          console.log('R13-5 desktop avoidance', label, JSON.stringify({ panel, zone: L.card, gap: L.card.x - panel.x - panel.w }));
          await page.screenshot({ path: `test-results/r13-5-${label}.png` });
          expect.soft(panel.x, `${label}: map clears left edge`).toBeGreaterThanOrEqual(12);
          expect.soft(panel.y, `${label}: map clears top edge`).toBeGreaterThanOrEqual(12);
          expect.soft(panel.y + panel.h, `${label}: map clears bottom edge`).toBeLessThanOrEqual(height - 12);
          expect.soft(panel.x + panel.w, `${label}: map reserves the zone card column`).toBeLessThanOrEqual(L.card.x - 12);
          expect.soft(L.covered, `${label}: zone card text stays readable beside the map`).toEqual([]);
        }
      }
      await setMap(false);
    }
  } finally {
    await desktop.close();
    await mobile.close();
  }
});
