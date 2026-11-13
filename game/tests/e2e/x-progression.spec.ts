import { expect, test, type Page } from '@playwright/test';
import { storySites } from '../../shared/storySite.ts';
import { LEVELS } from '../../shared/level.ts';
import type { ServerMsg } from '../../shared/protocol.ts';

async function ready(page: Page, level: number) {
  await expect.poll(() => page.evaluate(level => {
    const game = window.__escape.game();
    return game?.presentationReady && game.level.index === level && !game.intro.active;
  }, level), { timeout: 40_000 }).toBe(true);
  await page.evaluate(() => { window.__escape.debug('safe', 600); });
}
async function start(page: Page) {
  await page.goto('/?steady'); await page.fill('#name', '夜校记录验收');
  await page.click('#create'); await page.click('#start'); await ready(page, 0);
}

test('new players see sequential difficulty locks and functional records with an empty real server board', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#difficulty')).toHaveValue('story');
  await expect(page.locator('#difficulty option:not([disabled])')).toHaveCount(1);
  await expect(page.locator('#difficulty option')).toHaveCount(4);
  await page.click('#progression-open'); await expect(page.locator('#progression-dialog')).toBeVisible();
  await expect(page.locator('.progression-list .earned')).toHaveCount(0);
  await page.locator('#progression-dialog button').click();
  await page.click('#leaderboard-open'); await expect(page.locator('#leaderboard-dialog')).toBeVisible();
  await expect(page.locator('#leaderboard-dialog')).toContainText('还没有成绩');
  await page.selectOption('#leaderboard-difficulty', 'nightmare');
  await page.selectOption('#leaderboard-team', 'team');
  await expect(page.locator('#leaderboard-dialog')).toContainText('还没有成绩');
  await page.screenshot({ path: 'test-results/progression-leaderboard-desktop.png' });
  expect(errors).toEqual([]);
});

test('physical Easter eggs require reaching and reading the actual authored note and persist on reload', async ({ page }) => {
  await start(page);
  await page.evaluate(() => window.__escape.debug('level', 2)); await ready(page, 2);
  const site = storySites(2, LEVELS[2]).find(note => note.id === 'chalk-cat')!;
  await page.evaluate(site => {
    window.__escape.debug('tp', site.p[0], site.p[2] - 1.1, 2);
    const game = window.__escape.game()!; game.input.yaw = Math.PI; game.input.pitch = 0;
  }, site);
  await expect.poll(() => page.evaluate(() => window.__escape.game()!.story.candidateId)).toBe('chalk-cat');
  await page.evaluate(() => { window.__escape.game()!.settings.close(); document.activeElement instanceof HTMLElement && document.activeElement.blur(); });
  await page.keyboard.press('KeyE');
  await expect(page.locator('.story-view__panel')).toContainText('九条命');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('escape.progress.v1') || '{}').achievements)).toContain('secret-chalk');
  await page.reload();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('escape.progress.v1') || '{}').achievements)).toContain('secret-chalk');
});

test('a debug escape never unlocks difficulty, named monitors or a public speedrun result', async ({ page }) => {
  const completed: Extract<ServerMsg, { t: 'completed' }>[] = [];
  page.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
    const message = JSON.parse(String(payload)) as ServerMsg;
    if (message.t === 'completed') completed.push(message);
  }));
  await start(page);
  await page.evaluate(() => window.__escape.debug('level', 7)); await ready(page, 7);
  await page.evaluate(() => {
    const game = window.__escape.game()!;
    const book = game.level.def.finale!.rollcall;
    window.__escape.debug('tp', book.x, book.z + 1.3, 0);
  });
  await expect.poll(() => page.evaluate(() => {
    const game = window.__escape.game()!, book = game.level.def.finale!.rollcall;
    return Math.hypot(game.pos.x - book.x, game.pos.z - book.z);
  })).toBeLessThan(1.6);
  await page.evaluate(() => { const game = window.__escape.game()!; window.__escape.net.send({ t: 'act', kind: 'rollcall', id: game.myId }); });
  await expect.poll(() => page.evaluate(() => window.__escape.game()!.finalState?.phase)).toBe('chase');
  await page.evaluate(() => { const goal = window.__escape.game()!.level.exit; window.__escape.debug('tp', goal.x, goal.z, 0); });
  await expect(page.locator('#finale-result')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => completed.at(-1)).toMatchObject({ ranking: 'debug', namedMonitorsUnlocked: false });
  await expect(page.locator('#completion-records')).toContainText('初见');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('escape.progress.v1') || '{}'));
  expect(saved.unlocked ?? ['story']).toEqual(['story']); expect(saved.achievements ?? []).not.toContain('escape');
  expect(saved.achievements ?? []).not.toContain('difficulty-story'); expect(saved.namedMonitorsUnlocked).not.toBe(true);
  const board = await page.request.get('/api/leaderboard?difficulty=story&team=solo');
  expect((await board.json()).entries).toEqual([]);
});
