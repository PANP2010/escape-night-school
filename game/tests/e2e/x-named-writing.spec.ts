import { expect, test, type Page } from '@playwright/test';
import { LEVELS } from '../../shared/level.ts';
import { storySites } from '../../shared/storySite.ts';
import { STUDENT_NAMES } from '../../shared/studentNames.ts';
import { browserArgs } from '../browser-args.mjs';

declare global { interface Window { __namedWriting: { boards: Map<HTMLCanvasElement, string[]>; fragments: string[] } } }
test.use({ headless: process.platform !== 'darwin', viewport: { width: 1280, height: 720 }, launchOptions: { args: browserArgs(['--mute-audio']) } });

async function ready(page: Page, level: number) {
  await expect.poll(() => page.evaluate(level => {
    const game = window.__escape.game();
    return game?.presentationReady && game.level.index === level && !game.intro.active;
  }, level), { timeout: 40_000 }).toBe(true);
  await page.evaluate(() => window.__escape.debug('safe', 600));
}

async function read(page: Page, level: number, id: string, namedMonitors: boolean) {
  const site = storySites(level, LEVELS[level], namedMonitors).find(note => note.id === id)!;
  await page.evaluate(site => {
    window.__escape.debug('tp', site.p[0] + site.normal[0] * 1.2, site.p[2] + site.normal[2] * 1.2, Math.round((site.p[1] - 1.5) / 3.6));
    const game = window.__escape.game()!;
    game.input.yaw = Math.atan2(site.normal[0], site.normal[2]); game.input.pitch = 0;
  }, site);
  await expect.poll(() => page.evaluate(() => window.__escape.game()!.story.candidateId)).toBe(id);
  await page.locator('body > canvas').evaluate(canvas => { canvas.tabIndex = -1; canvas.focus(); });
  await page.keyboard.press('KeyE');
  await expect(page.locator('.story-view__panel')).toContainText(site.text);
}

for (const namedMonitors of [false, true]) {
  test(`room namedMonitors=${namedMonitors} consistently controls world writing and the signature achievement`, async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem('escape.progress.v1', JSON.stringify({ achievements: ['difficulty-story', 'difficulty-standard', 'difficulty-challenge', 'difficulty-nightmare'], namedMonitorsUnlocked: true }));
      window.__namedWriting = { boards: new Map(), fragments: [] };
      const fillText = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (...args) {
        if (this.canvas.width === 1024 && this.canvas.height > 1024) {
          const labels = window.__namedWriting.boards.get(this.canvas) ?? [];
          labels.push(args[0]); window.__namedWriting.boards.set(this.canvas, labels);
        }
        if (this.canvas.width === 512 && this.canvas.height === 512) window.__namedWriting.fragments.push(args[0]);
        return fillText.apply(this, args);
      };
    });
    await page.goto('/?steady');
    await expect(page.locator('#named-monitors')).not.toBeChecked();
    if (namedMonitors) await page.locator('#named-monitors').check();
    await page.fill('#name', '环境文字验收'); await page.click('#create');
    await expect(page.locator('#named-monitors')).toBeDisabled();
    await page.click('#start'); await ready(page, 0);
    const boardWriting = await page.evaluate(() => window.__namedWriting.boards.get(window.__escape.game()!.campus.world.boards.texture!.image as HTMLCanvasElement) ?? []);
    expect(boardWriting.length).toBeGreaterThan(0);
    const names = new Set<string>([...STUDENT_NAMES, '角色099']);
    expect(boardWriting.some(text => names.has(text))).toBe(namedMonitors);
    expect(boardWriting.includes('同学甲')).toBe(true); // Prepared campus starts anonymous, before the authoritative room arrives.
    if (!namedMonitors) {
      await page.evaluate(() => window.__escape.debug('level', 2)); await ready(page, 2);
      await read(page, 2, 'chalk-cat', false);
      await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('escape.progress.v1')!).achievements)).toContain('secret-chalk');
      await expect(page.locator('#named-monitors')).toBeDisabled();
      await page.locator('.story-view__close').click();
    }
    await page.evaluate(() => window.__escape.debug('level', 4)); await ready(page, 4);
    await read(page, 4, 'role_boss-signature', namedMonitors);
    const entries = await page.evaluate(() => window.__escape.game()!.story.state.model().entries);
    expect(entries.find(entry => entry.id === '4:note:role_boss-signature')!.text.includes('值周代号025')).toBe(namedMonitors);
    const earned = await page.evaluate(() => JSON.parse(localStorage.getItem('escape.progress.v1')!).achievements as string[]);
    expect(earned.includes('secret-role_boss')).toBe(namedMonitors);
    await expect(page.locator('#named-monitors')).toBeDisabled();
    if (!namedMonitors) expect(await page.evaluate(() => window.__namedWriting.fragments.some(text => text.includes('值周代号025')))).toBe(false);
    await page.screenshot({ path: `test-results/named-writing-${namedMonitors ? 'enabled' : 'anonymous'}.png` });
    expect(errors).toEqual([]);
  });
}
