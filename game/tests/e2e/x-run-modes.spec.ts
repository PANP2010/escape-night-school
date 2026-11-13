import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test, type BrowserContextOptions, type Locator, type Page } from '@playwright/test';
import type { ClientMsg, ServerMsg } from '../../shared/protocol.ts';

type Room = Extract<ServerMsg, { t: 'room' }>;
type Rooms = Extract<ServerMsg, { t: 'rooms' }>;
type Wire = { room?: Room; rooms?: Rooms; boss?: Extract<ServerMsg, { t: 'snap' }>['boss']; snapshots: number; sent: ClientMsg[]; received: ServerMsg[]; errors: string[] };
declare global {
  interface Window { __runModeMap: { frames: number; labels: string[] } }
}
const evidence = 'test-results/run-modes';
const devices = [
  { name: 'desktop', touch: false, options: { viewport: { width: 1280, height: 720 }, hasTouch: false, isMobile: false } },
  { name: 'touch', touch: true, options: { viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 } },
] satisfies { name: string; touch: boolean; options: BrowserContextOptions }[];

async function prepare(page: Page, name: string): Promise<Wire> {
  const wire: Wire = { snapshots: 0, sent: [], received: [], errors: [] };
  page.on('pageerror', error => wire.errors.push(error.message));
  page.on('websocket', ws => {
    ws.on('framereceived', ({ payload }) => {
      const m = JSON.parse(String(payload)) as ServerMsg;
      if (m.t === 'snap') { wire.snapshots++; wire.boss = m.boss; }
      else if (m.t !== 'nav') wire.received.push(m);
      if (m.t === 'room') wire.room = m;
      if (m.t === 'rooms') wire.rooms = m;
    });
    ws.on('framesent', ({ payload }) => {
      const m = JSON.parse(String(payload)) as ClientMsg;
      if (m.t !== 'input' && m.t !== 'heartbeat') wire.sent.push(m);
    });
    ws.on('socketerror', error => wire.errors.push(`WebSocket: ${error}`));
  });
  // Observe the labels the actual game paints; do not replace map state or inject a target.
  await page.addInitScript(() => {
    window.__runModeMap = { frames: 0, labels: [] };
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (this.canvas.closest('#map')) { window.__runModeMap.frames++; window.__runModeMap.labels = []; }
      return clear.apply(this, args);
    };
    const fill = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (...args) {
      if (this.canvas.closest('#map')) window.__runModeMap.labels.push(args[0]);
      return fill.apply(this, args);
    };
  });
  await page.goto('/?nodraw&steady');
  await page.fill('#name', name);
  await expect(page.locator('#create')).toBeEnabled();
  return wire;
}
async function activate(locator: Locator, touch: boolean) {
  if (touch) await locator.tap(); else await locator.click();
}
async function guidance(page: Page, enabled: boolean, touch: boolean) {
  if (await page.locator('#guidance').isChecked() !== enabled) await activate(page.locator('#guidance'), touch);
  await expect(page.locator('#guidance')).toBeChecked({ checked: enabled });
}
async function ready(page: Page, level: number, device: typeof devices[number]) {
  await expect.poll(() => page.evaluate(level => {
    const g = window.__escape.game(); return !!g?.presentationReady && g.level.index === level;
  }, level), { timeout: 30_000 }).toBe(true);
  if (await page.locator('#intro-skip').isVisible()) await activate(page.locator('#intro-skip'), device.touch);
  await page.waitForFunction(() => !window.__escape.game()!.intro.active, null, { timeout: 15_000 });
  await page.evaluate(async () => { if (document.fullscreenElement) await document.exitFullscreen(); });
  await page.setViewportSize(device.options.viewport!);
}
async function map(page: Page, on: boolean, touch: boolean) {
  if (touch) await page.locator(on ? '#touch-map' : '#map .mb.close').tap();
  else await page.keyboard.press('KeyM');
  if (on) {
    await expect(page.locator('#map')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__runModeMap.frames)).toBeGreaterThan(1);
  } else await expect(page.locator('#map')).toBeHidden();
}
async function save(name: string, data: unknown) {
  await mkdir(evidence, { recursive: true });
  await writeFile(`${evidence}/${name}.json`, JSON.stringify(data, null, 2));
}

for (const device of devices) test.describe(device.name, () => {
  test.use(device.options);

  test('default guided room announces exclusion and keeps local arrow controls functional', async ({ page }) => {
    const wire = await prepare(page, `指引默认-${device.name}`);
    try {
      await expect(page.locator('#guidance')).toBeChecked();
      await expect(page.locator('#guidance-hint')).toContainText('不计入速通排行');
      await activate(page.locator('#create'), device.touch);
      await expect.poll(() => wire.room).toMatchObject({ guidance: true, developerMode: false, started: false });
      await expect(page.locator('#wait-hint')).toContainText('指引开启 · 不计排行');
      expect(wire.sent.find(m => m.t === 'create')).toMatchObject({ guidance: true });
      await activate(page.locator('#start'), device.touch); await ready(page, 0, device);
      await expect(page.locator('#room-code')).toContainText('指引开启 · 不计排行');
      await expect(page.locator('#developer-tools-open')).toBeHidden();
      await expect(page.locator('#goal-arrow')).not.toHaveAttribute('hidden', { timeout: 15_000 });
      await map(page, true, device.touch);
      await expect.poll(() => page.evaluate(() => window.__runModeMap.labels.filter(s => /^(出口|出口在)/.test(s)))).not.toEqual([]);
      if (device.touch) {
        await expect(page.locator('#map .mb.arrow')).toBeEnabled();
        await page.locator('#map .mb.arrow').tap();
        await expect(page.locator('#map .mb.arrow')).toContainText('目标箭头：关');
        await page.locator('#map .mb.arrow').tap();
        await expect(page.locator('#map .mb.arrow')).toContainText('目标箭头：开');
      } else {
        await page.keyboard.press('KeyG');
        await expect(page.locator('#map .mk')).toContainText('目标箭头：关');
        await page.keyboard.press('KeyG');
        await expect(page.locator('#map .mk')).toContainText('目标箭头：开');
      }
      await map(page, false, device.touch);
      await expect(page.locator('#goal-arrow')).not.toHaveAttribute('hidden');
      expect(wire.errors).toEqual([]);
    } finally { await save(`${device.name}-guided`, wire); }
  });

  test('guidance disabled before creation stays off through keyboard and touch attempts', async ({ page }) => {
    const wire = await prepare(page, `无指引-${device.name}`);
    try {
      await guidance(page, false, device.touch);
      await expect(page.locator('#guidance-hint')).toContainText('可参与速通排行');
      await activate(page.locator('#create'), device.touch);
      await expect.poll(() => wire.room).toMatchObject({ guidance: false, developerMode: false, started: false });
      await expect(page.locator('#wait-hint')).toContainText('指引关闭 · 可参与排行');
      expect(wire.sent.find(m => m.t === 'create')).toMatchObject({ guidance: false });
      await activate(page.locator('#start'), device.touch); await ready(page, 0, device);
      await expect(page.locator('#room-code')).toContainText('指引关闭 · 可参与排行');
      await expect(page.locator('#developer-tools-open')).toBeHidden();
      await expect(page.locator('#goal-arrow')).toHaveAttribute('hidden');
      for (let i = 0; i < 3; i++) await page.keyboard.press('KeyG');
      await map(page, true, device.touch);
      const button = page.locator('#map .mb.arrow');
      await expect(button).toBeDisabled(); await expect(button).toContainText('已关闭');
      if (device.touch) {
        const r = await button.boundingBox();
        await page.touchscreen.tap(r!.x + r!.width / 2, r!.y + r!.height / 2);
      }
      const painted = await page.evaluate(() => window.__runModeMap.frames);
      await expect.poll(() => page.evaluate(() => window.__runModeMap.frames)).toBeGreaterThan(painted + 2);
      expect(await page.evaluate(() => window.__runModeMap.labels.filter(s => /^(出口|出口在|配电箱|逃生路线|点名册|\d+[亮待])/.test(s)))).toEqual([]);
      await mkdir(evidence, { recursive: true });
      await page.screenshot({ path: `${evidence}/${device.name}-no-guidance-map.png` });
      await map(page, false, device.touch);
      await page.keyboard.press('KeyG');
      const snap = wire.snapshots;
      await expect.poll(() => wire.snapshots).toBeGreaterThan(snap + 2);
      await expect(page.locator('#goal-arrow')).toHaveAttribute('hidden');
      expect(wire.room).toMatchObject({ guidance: false, developerMode: false });
      expect(wire.errors).toEqual([]);
    } finally {
      await save(`${device.name}-no-guidance`, { ...wire, map: await page.evaluate(() => window.__runModeMap).catch(() => null) });
    }
  });

  test('quick match separates room modes and developer quick join creates a private test room', async ({ page, browser, baseURL }) => {
    const contexts = await Promise.all([0, 1, 2].map(() => browser.newContext({ ...device.options, baseURL })));
    const [ranked, match, dev] = await Promise.all(contexts.map(c => c.newPage()));
    const wires: Wire[] = [];
    try {
      const hostWire = await prepare(page, `有指引公开-${device.name}`); wires.push(hostWire);
      await activate(page.locator('#create'), device.touch);
      await expect.poll(() => hostWire.room?.public).toBe(true);
      const guidedCode = hostWire.room!.code;
      const rankedWire = await prepare(ranked, `无指引快速-${device.name}`); wires.push(rankedWire);
      await guidance(ranked, false, device.touch); await activate(ranked.locator('#quick-join'), device.touch);
      await expect.poll(() => rankedWire.room).toMatchObject({ guidance: false, developerMode: false, public: true });
      const rankedCode = rankedWire.room!.code; expect(rankedCode).not.toBe(guidedCode);
      const matchWire = await prepare(match, `无指引匹配-${device.name}`); wires.push(matchWire);
      await guidance(match, false, device.touch); await activate(match.locator('#quick-join'), device.touch);
      await expect.poll(() => matchWire.room?.code).toBe(rankedCode);
      expect(matchWire.sent.find(m => m.t === 'quick')).toMatchObject({ guidance: false });
      await expect(ranked.locator('#wait-members li')).toHaveCount(2);
      const devWire = await prepare(dev, 'DEV-LOCAL#'); wires.push(devWire);
      await expect(dev.locator('#guidance-hint')).toContainText('开发者模式');
      await activate(dev.locator('#quick-join'), device.touch);
      await expect.poll(() => devWire.room).toMatchObject({ developerMode: true, guidance: true, public: false, started: false });
      expect([guidedCode, rankedCode]).not.toContain(devWire.room!.code);
      await expect(dev.locator('#wait-hint')).toContainText('开发者测试 · 不计排行');
      await expect(dev.locator('#wait-visibility')).toContainText('私密');
      await expect(dev.locator('#wait-members li')).toHaveCount(1);
      expect(wires.flatMap(w => w.errors)).toEqual([]);
    } finally {
      await save(`${device.name}-quick-modes`, wires);
      await Promise.all(contexts.map(context => context.close()));
    }
  });

  test('developer create exposes working touch and desktop chapter and cheat controls in its isolated room', async ({ page }) => {
    const wire = await prepare(page, 'DEV-LOCAL#');
    try {
      await guidance(page, false, device.touch);
      await activate(page.locator('#create'), device.touch);
      await expect.poll(() => wire.room).toMatchObject({ developerMode: true, guidance: false, public: false });
      await expect(page.locator('#wait-hint')).toContainText('开发者测试 · 不计排行');
      await activate(page.locator('#start'), device.touch); await ready(page, 0, device);
      const open = page.locator('#developer-tools-open'), panel = page.locator('#developer-tools');
      await expect(open).toBeVisible();
      await activate(open, device.touch); await expect(panel).toBeVisible();
      await expect(panel).toContainText('不计');
      await activate(panel.getByRole('button', { name: '免抓 600 秒', exact: true }), device.touch);
      await expect.poll(() => wire.sent.filter(m => m.t === 'debug' && m.op === 'safe')).toContainEqual({ t: 'debug', op: 'safe', s: 600 });
      await activate(panel.getByRole('button', { name: '获得楼梯钥匙', exact: true }), device.touch);
      await expect.poll(() => wire.received.filter((m): m is Extract<ServerMsg, { t: 'bag' }> => m.t === 'bag').at(-1)?.bag.stair_key).toBe(1);
      expect(wire.sent).toContainEqual({ t: 'debug', op: 'key', door: -1 });
      // Choose L5 through its real panel button, then skip the new intro through the same UI.
      await activate(panel.locator('button[data-level="4"]'), device.touch);
      await expect.poll(() => wire.room?.level, { timeout: 15_000 }).toBe(4);
      await expect.poll(() => page.evaluate(() => window.__escape.game()?.level.index), { timeout: 15_000 }).toBe(4);
      await page.waitForFunction(() => {
        const g = window.__escape.game(); return g?.presentationReady && g.intro.active;
      }, null, { timeout: 15_000 });
      if (!await panel.isVisible()) await activate(open, device.touch);
      await activate(panel.getByRole('button', { name: '跳过当前过场', exact: true }), device.touch);
      await activate(page.locator('#developer-tools-close'), device.touch);
      await expect(panel).toBeHidden(); await ready(page, 4, device);
      expect(wire.sent).toContainEqual({ t: 'debug', op: 'level', level: 4 });
      await expect(page.locator('#room-code')).toContainText('开发者测试 · 不计排行');
      expect(wire.room).toMatchObject({ guidance: false, developerMode: true, public: false });
      await expect(page.locator('#goal-arrow')).toHaveAttribute('hidden');
      await activate(open, device.touch);
      await activate(panel.getByRole('button', { name: '免抓 600 秒', exact: true }), device.touch);
      await activate(panel.getByRole('button', { name: '召唤值周代号025（测试）', exact: true }), device.touch);
      await expect.poll(() => wire.boss?.name, { timeout: 10_000 }).toBe('值周代号025');
      expect(wire.sent).toContainEqual({ t: 'debug', op: 'boss' });
      const box = await panel.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(device.options.viewport!.width + 1);
      expect(box!.y + box!.height).toBeLessThanOrEqual(device.options.viewport!.height + 1);
      await mkdir(evidence, { recursive: true });
      await page.screenshot({ path: `${evidence}/${device.name}-developer-panel.png` });
      if (device.touch) await page.locator('#developer-tools-close').tap();
      else await page.keyboard.press('Escape');
      await expect(panel).toBeHidden();
      expect(wire.errors).toEqual([]);
    } finally { await save(`${device.name}-developer`, wire); }
  });
});
