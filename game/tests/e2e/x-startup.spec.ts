import { expect, test } from '@playwright/test';
import { browserArgs } from '../browser-args.mjs';
import { DEVELOPER_NAME } from '../../shared/runMode.ts';

test.use({ launchOptions: { args: browserArgs(['--mute-audio']) } });

test('loading stays responsive and cancels an obsolete chapter before publishing its world', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const probe = (window as any).__buildProbe = { inputs: [] as unknown[], rooms: [] as unknown[],
      progress: [] as number[], paintCount: 0, obsoletePaints: 0, slow: true,
      id: 0, epoch: 0, authoritativePosition: null as number[] | null };
    // Simulate a slow loading tab using actual browser tasks. The next chapter removes the delay, so this
    // exercises cancellation while an old scheduled slice is pending without slowing the final game loop.
    const timer = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, delay = 0, ...args: unknown[]) =>
      timer(handler, probe.slow && delay <= 40 ? 180 : delay, ...args)) as typeof window.setTimeout;
    const Socket = window.WebSocket;
    window.WebSocket = class extends Socket {
      constructor(...args: ConstructorParameters<typeof WebSocket>) {
        super(...args);
        this.addEventListener('message', event => {
          const message = JSON.parse(event.data);
          if (message.t === 'welcome') probe.id = message.id;
          if (message.t === 'correct') probe.epoch = message.c;
          if (message.t === 'snap') {
            const own = message.players.find((player: any) => player.id === probe.id);
            if (own) probe.authoritativePosition = own.p;
          }
          if (message.t === 'room' && message.started) {
            probe.rooms.push(message.level);
            if (message.level === 1) probe.slow = false;
          }
        });
      }
      send(data: Parameters<WebSocket['send']>[0]) {
        if (typeof data === 'string') {
          const message = JSON.parse(data);
          if (message.t === 'input') {
            const game = window.__escape?.game();
            probe.inputs.push({ level: game?.level.index, ready: game?.presentationReady,
              world: game?.worldReady, epoch: message.c, loading: !document.getElementById('campus-loading')?.hidden });
          }
        }
        super.send(data);
      }
    };
    function frame() {
      const root = document.getElementById('campus-loading');
      if (root && !root.hidden) {
        probe.paintCount++;
        const progress = root.querySelector('progress')!.value;
        if (probe.progress.at(-1) !== progress) probe.progress.push(progress);
        if (document.querySelector('body > canvas')) probe.obsoletePaints++;
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });
  await page.goto('/');
  await page.fill('#name', DEVELOPER_NAME);
  await page.click('#create');
  await page.click('#start');
  const loading = page.locator('#campus-loading');
  await expect(loading).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__buildProbe.progress.some((n: number) => n > 0))).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('loading.png') });
  // The public, unranked developer room can change chapters during its intro. Drive that real
  // authority handoff while the first world is still building, before any Game can upload input.
  await page.evaluate(() => {
    const api = window.__escape;
    api.debug('safe', 120);
    api.debug('level', 1);
  });
  await expect.poll(() => page.evaluate(() => (window as any).__buildProbe.rooms.includes(1)), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__escape.game()?.presentationReady), { timeout: 30_000 }).toBe(true);
  await page.waitForFunction(() => !window.__escape.game()!.intro.active);
  await expect(loading).toBeHidden();
  await expect(page.locator('#fade-overlay')).toBeHidden();
  await expect(page.locator('#room-code')).toContainText('第 2 关');
  await expect.poll(() => page.evaluate(() => (window as any).__buildProbe.inputs.length)).toBeGreaterThan(2);
  const state = await page.evaluate(() => {
    const game = window.__escape.game()!;
    const probe = (window as any).__buildProbe;
    return { ...probe, level: game.level.index, collisionCount: game.campus.collision.boxes.length,
      campuses: game.scene.children.filter(object => object.name === 'A').length,
      grounds: game.scene.children.filter(object => object.name === 'GROUND').length,
      stats: window.__escape.stats() };
  });
  expect(state.rooms).toEqual([0, 1]);
  expect(state.level).toBe(1);
  expect(state.campuses).toBe(1);
  expect(state.grounds).toBe(1);
  expect(state.collisionCount).toBeGreaterThan(1000);
  expect(state.paintCount).toBeGreaterThan(10);
  expect(state.progress.length).toBeGreaterThan(3);
  expect(state.obsoletePaints).toBe(0);
  expect(state.inputs.every((input: any) => input.level === 1 && input.ready && input.world && !input.loading)).toBe(true);
  expect(state.epoch).toBeGreaterThan(0);
  expect(state.inputs.every((input: any) => input.epoch === state.epoch)).toBe(true);
  expect(state.stats.calls).toBeGreaterThan(0);
  expect(state.stats.triangles).toBeGreaterThan(0);
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('chapter-ready.png') });
  const before = state.authoritativePosition;
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(300);
  await page.keyboard.up('KeyW');
  await expect.poll(() => page.evaluate(([x, , z]) => {
    const p = (window as any).__buildProbe.authoritativePosition;
    return p ? Math.hypot(p[0] - x, p[2] - z) : 0;
  }, before), { timeout: 10_000 }).toBeGreaterThan(0.05);
  await testInfo.attach('startup-handoff', { body: JSON.stringify(state, null, 2), contentType: 'application/json' });
});
