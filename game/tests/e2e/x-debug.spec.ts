import { expect, test } from '@playwright/test';
import { shot } from './draw';

// window.__escape.debug('warden') puts 角色074 in front of us and straight into chase (server dev mode only).
test('debug warden → mob chases within 3 s', async ({ page }) => {
  test.setTimeout(75_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?nodraw');
  await page.fill('#name', '甲');
  await page.click('#create');
  await page.click('#start');
  await expect(page.locator('#hud')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => window.__escape.game()?.snaps ?? 0), { timeout: 15_000 }).toBeGreaterThan(5);
  // Under swiftshader load (right after the campus specs) the page stalls for ~8 s: the server's whole chase (2 s) can pass between
  // two polls. So latch every anim that reaches the client (mobs.onSnap) and the subtitle text (observer), then wait up to 20 s.
  await expect.poll(() => page.evaluate(() => (window.__escape.game() as any).mobs.byId.size), { timeout: 20_000 }).toBeGreaterThan(0);
  await page.evaluate(() => {
    const w = window as any, mobs = (window.__escape.game() as any).mobs, el = document.getElementById('subtitle')!;
    w.__anims = [] as string[]; w.__subSeen = '';
    const onSnap = mobs.onSnap.bind(mobs);
    mobs.onSnap = (list: { anim: string }[], t: number) => { for (const m of list) w.__anims.push(m.anim); onSnap(list, t); };
    new MutationObserver(() => { if (el.textContent) w.__subSeen = el.textContent; }).observe(el, { childList: true, characterData: true, subtree: true });
    window.__escape.debug('warden', 6);
  });
  await expect.poll(() => page.evaluate(() => (window as any).__anims.join()), { timeout: 20_000 }).toContain('chase');
  // the spot line shows as a subtitle
  await expect.poll(() => page.evaluate(() => (window as any).__subSeen as string), { timeout: 20_000 }).not.toBe('');
  await shot(page, 'test-results/iter-107-subtitle.png');
  expect(errors).toEqual([]);
});

// Level flow: debug key(-1) = stairwell key, tp into the exit zone → 3 s black screen → level 2 loads.
test('debug key + tp to exit → fade → 第 2 关', async ({ page }) => {
  test.setTimeout(150_000); // cold swiftshader page load alone can take ~40 s; 2 levels + 7 screenshots with the torch-light shader valid again (#176) ≈ 90 s
  await page.goto('/?nodraw');
  await page.fill('#name', '甲');
  await page.click('#create');
  await page.click('#start');
  await expect(page.locator('#hud')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => window.__escape.game()?.snaps ?? 0), { timeout: 15_000 }).toBeGreaterThan(1);
  await page.evaluate(() => { window.__escape.debug('key', -1); window.__escape.debug('tp', -61, 66); });
  await expect(page.locator('#fade-overlay')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#room-code')).toContainText('第 2 关', { timeout: 20_000 });
  await page.waitForFunction(() => {
    const g = window.__escape.game(); return g?.presentationReady && g.level.index === 1 && !g.intro.active;
  });
  // L2's area is one corridor now: 角色074 patrols into the shots below and catches the player (downed = no prey for the
  // 值日生 either); this tests the shots and the 值日生, so only he stands down. The natural 值日生 also hunts after its
  // 15 s start delay and downs the player before the summon when the full suite makes the shots slow (#200): it stands
  // down too, until debug('monitor') summons it
  await page.evaluate(() => { window.__escape.debug('safe', 600, 1); window.__escape.debug('safe', 600, 2); });
  await expect(page.locator('#fade-overlay')).toBeHidden({ timeout: 5_000 });
  // 第 2 关 is a blackout on 教学楼B 2F: the campus lights are off until the fuses are in
  await expect.poll(() => page.evaluate(() => { const g = window.__escape.game() as any; return g.campus.blackout && g.body.y > 3; }), { timeout: 15_000 }).toBe(true);
  await page.evaluate(() => { const g = window.__escape.game() as any; g.input.yaw = Math.PI / 2; g.input.pitch = 0; });
  await page.waitForTimeout(600);
  await shot(page, 'test-results/iter-154-blackout.png');
  // close-ups: the 配电箱 on the corridor wall, then the west 出口 sign
  await page.evaluate(() => { window.__escape.debug('tp', 40, 83.4); const g = window.__escape.game() as any; g.input.yaw = Math.PI; g.input.pitch = 0.1; });
  await page.waitForTimeout(800);
  await shot(page, 'test-results/iter-155-fusebox.png');
  await page.evaluate(() => { window.__escape.debug('tp', 22, 84.2); const g = window.__escape.game() as any; g.input.yaw = Math.PI / 2; g.input.pitch = 0.15; });
  await page.waitForTimeout(800);
  await shot(page, 'test-results/iter-155-exitsign.png');
  // 无脸值日生: summoned 6 m ahead of a player who faces it → server freezes it ('freeze'), blank paper face + red armband
  await page.evaluate(() => { window.__escape.debug('tp', 40, 84.2); const g = window.__escape.game() as any; g.input.yaw = Math.PI / 2; g.input.pitch = 0; });
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__escape.debug('monitor', 6));
  await expect.poll(() => page.evaluate(() => { const m = (window.__escape.game() as any).mobs.byId.get(2); return m?.monitor && m.anim; }), { timeout: 10_000 }).toBe('freeze');
  await page.waitForTimeout(800);
  await shot(page, 'test-results/iter-156-monitor.png');
  // look away → it sprints (dedicated 6 m/s clip); turn back → it freezes mid-stride
  // 6 m/s from 6 m leaves < 1 s before it touches (→ caught, not frozen), less than one input round trip once the torch
  // shader is valid (#176) and swiftshader frames slow down: re-summon it 12 m off (≈ 2 s), watch for 'run' and turn back
  // page-side, every 16 ms, ~100 ms after it starts, instead of through expect.poll's 100→1000 ms backoff
  await page.evaluate(() => window.__escape.debug('monitor', 12));
  await expect.poll(() => page.evaluate(() => (window.__escape.game() as any).mobs.byId.get(2)?.anim), { timeout: 10_000 }).toBe('freeze');
  const sprint = await page.evaluate(async () => {
    const g = window.__escape.game() as any, t = performance.now(), sl = (ms: number) => new Promise((r) => setTimeout(r, ms));
    g.input.yaw = -Math.PI / 2;
    while (performance.now() - t < 10_000 && g.mobs.byId.get(2)?.anim !== 'run') await sl(16);
    const seen = g.mobs.byId.get(2)?.anim;
    await sl(100);
    g.input.yaw = Math.PI / 2;
    return seen;
  });
  expect(sprint).toBe('run');
  await expect.poll(() => page.evaluate(() => (window.__escape.game() as any).mobs.byId.get(2)?.anim), { timeout: 10_000 }).toBe('freeze');
  await shot(page, 'test-results/iter-157-sprint.png');
  await page.evaluate(() => { const g = window.__escape.game() as any; g.setPower(3); });
  await expect.poll(() => page.evaluate(() => (window.__escape.game() as any).campus.blackout)).toBe(false);
  await page.waitForTimeout(600);
  await shot(page, 'test-results/iter-154-powered.png');
});
