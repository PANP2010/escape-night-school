import { expect, test, type Page } from '@playwright/test';
import WebSocket from 'ws';
import { assertDebugAvailable, nearPosition, placeNear } from '../helpers.mjs';
import { shot } from './draw.ts';

async function authority(page: Page, mode: 'accept' | 'reject' | 'silent' | 'bad-snapshot' | 'wrong-floor' | 'wrong-snapshot-y' | 'ground-y') {
  await page.setContent('<p>Placement helper regression</p>');
  await page.evaluate((mode) => {
    const w = window as any;
    const g = { spawnSynced: true, myId: 7, pos: { x: 5, z: 5 }, body: { y: 3.6 }, level: { index: 1, def: { area: { x0: 0, x1: 10, z0: 0, z1: 10, y0: 3, y1: 9 } } } };
    w.sent = 0; w.messages = [];
    const net = { onMsg: (m: unknown) => w.messages.push(m) };
    w.originalHandler = net.onMsg;
    w.__escape = { game: () => g, net, debug: (_op: string, x: number, z: number) => {
      w.sent++;
      if (mode === 'silent') return;
      const p = mode === 'reject' ? [5, 3.6, 5] : [x, mode === 'wrong-floor' ? 7.2 : mode === 'ground-y' ? 3.8 : 3.6, z];
      setTimeout(() => net.onMsg({ t: 'correct', forced: true, c: 1, p }), 10);
      setTimeout(() => net.onMsg({ t: 'snap', tick: 42, players: [{ id: 7, p: mode === 'bad-snapshot' ? [5, 3.6, 5] : mode === 'wrong-snapshot-y' ? [x, 4.2, z] : p }] }), 80);
    } };
  }, mode);
}

test.describe('development placement helper', () => {

test('placement waits for the server snapshot even when the local player never moves', async ({ page }) => {
  await authority(page, 'accept');
  expect(await placeNear(page, 1, -1)).toEqual({ x: 6, y: 3.6, z: 4, tick: 42 });
  expect(await page.evaluate(() => window.__escape.game()!.pos.x)).toBe(5);
  expect(await page.evaluate(() => (window as any).messages.map((m: any) => m.t))).toEqual(['correct', 'snap']);
  expect(await page.evaluate(() => window.__escape.net.onMsg === (window as any).originalHandler)).toBe(true);
});

test('outside level coordinates fail without sending debug; server rejection and mismatched snapshots fail explicitly', async ({ page }) => {
  await authority(page, 'accept');
  await expect(placeNear(page, 100, 0)).rejects.toThrow('outside the current level');
  expect(await page.evaluate(() => (window as any).sent)).toBe(0);
  await authority(page, 'reject');
  await expect(placeNear(page, 1, 0)).rejects.toThrow('server rejected target');
  await authority(page, 'bad-snapshot');
  await expect(placeNear(page, 1, 0)).rejects.toThrow('server snapshot did not confirm');
  await authority(page, 'wrong-floor');
  await expect(placeNear(page, 1, 0)).rejects.toThrow('server rejected target');
  await authority(page, 'wrong-snapshot-y');
  await expect(placeNear(page, 1, 0)).rejects.toThrow('server snapshot did not confirm');
  expect(await page.evaluate(() => window.__escape.net.onMsg === (window as any).originalHandler)).toBe(true);
  await authority(page, 'ground-y');
  expect((await placeNear(page, 1, 0)).y).toBe(3.8);
});

test('production-style ignored debug fails quickly and restores the network handler', async ({ page }) => {
  await authority(page, 'silent');
  const started = Date.now();
  await expect(assertDebugAvailable(page, { timeout: 150 })).rejects.toThrow('NODE_ENV=production');
  expect(Date.now() - started).toBeLessThan(2000);
  expect(await page.evaluate(() => window.__escape.net.onMsg === (window as any).originalHandler)).toBe(true);
});

test('real development authority confirms a nearby point and rejects another chapter before transmission', async ({ page }) => {
  test.skip(process.env.ESC_SCREEN_SERVER_ENV === 'production', 'requires development authority');
  await page.goto('/?nodraw&steady'); await page.fill('#name', '摆位回归'); await page.click('#create'); await page.click('#start');
  await expect.poll(() => page.evaluate(() => (window.__escape.game() as unknown as { spawnSynced: boolean })?.spawnSynced), { timeout: 15_000 }).toBe(true);
  await page.waitForFunction(() => window.__escape.game()?.presentationReady && !window.__escape.game()!.intro.active);
  await assertDebugAvailable(page);
  await page.evaluate(() => window.__escape.debug('safe', 600, 1));
  const p = await placeNear(page, 0.2, 0);
  expect(p.tick).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__escape.game()!.pos.x)).toBeCloseTo(p.x, 1);
  await expect(placeNear(page, 100, 0)).rejects.toThrow('outside the current level');
});

test('a teammate torch lights the same view after authoritative placement', async ({ page, baseURL }, testInfo) => {
  test.skip(process.env.ESC_SCREEN_SERVER_ENV === 'production', 'requires development debug placement');
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 640, height: 360 });
  await page.goto('/?nodraw&steady'); await page.fill('#name', '看灯甲'); await page.click('#create');
  await expect(page.locator('#wait-code')).not.toBeEmpty();
  const code = await page.evaluate(() => window.__escape.code);
  const ws = new WebSocket(baseURL!.replace(/^http/, 'ws') + '/ws');
  let inputTimer: ReturnType<typeof setInterval> | undefined;
  let id = -1, epoch = 0, seq = 0, light = false, position: number[] | undefined;
  let correction: number[] | undefined, snapshot: number[] | undefined;
  ws.on('message', (data) => {
    const m = JSON.parse(String(data));
    if (m.t === 'welcome') id = m.id;
    if (m.t === 'correct') { position = m.p; epoch = m.c; correction = m.p; }
    if (m.t === 'snap') {
      snapshot = m.players.find((p: { id: number }) => p.id === id)?.p;
      position ??= snapshot;
    }
  });
  try {
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({ t: 'hello', name: '照灯乙' })); ws.send(JSON.stringify({ t: 'join', code }));
    await expect(page.locator('#wait-members li')).toHaveCount(2);
    await page.click('#start');
    await expect.poll(() => page.evaluate(() => (window.__escape.game() as any)?.spawnSynced), { timeout: 15_000 }).toBe(true);
    await page.waitForFunction(() => window.__escape.game()?.presentationReady && !window.__escape.game()!.intro.active);
    // The tutorial starts after an actually rendered, readable opening banner.
    await page.evaluate(() => { window.__escape.game()!.draw = true; });
    await page.keyboard.press('Shift');
    await page.waitForFunction(() => window.__escape.game()?.openingComplete);
    await assertDebugAvailable(page);
    await page.evaluate(() => window.__escape.debug('safe', 600));
    const origin = await placeNear(page, 0, 0);
    const area = await page.evaluate(() => window.__escape.game()!.level.def.area);
    const target = nearPosition(origin, area, -3, 0); // same corridor, three metres ahead along -X
    ws.send(JSON.stringify({ t: 'debug', op: 'tp', x: target.x, z: target.z }));
    const near = (p: number[] | undefined, q: number[]) => !!p && Math.hypot(...p.map((v, i) => v - q[i])) < 0.08;
    await expect.poll(() => correction && Math.hypot(correction[0] - target.x, correction[2] - target.z) < 0.08
      && Math.round(correction[1] / 3.6) === Math.round(target.y / 3.6), { timeout: 2500 }).toBe(true);
    await expect.poll(() => near(snapshot, correction!), { timeout: 2500, message: 'teammate placement is confirmed in server XYZ snapshot' }).toBe(true);
    inputTimer = setInterval(() => {
      if (position && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'input', seq: ++seq, c: epoch,
        p: position, yaw: Math.PI / 2, pitch: -0.1, f: light ? 4 : 0 }));
    }, 50);
    await page.evaluate(() => {
      const g = window.__escape.game() as any;
      g.light = false; g.input.yaw = Math.PI / 2; g.input.pitch = -0.1;
      window.__escape.debug('power', 30); // keep the dark corridor stable across both captures
    });
    await expect.poll(() => page.evaluate(() => (window.__escape.game() as any).campus.out), { timeout: 5000 }).toBe(1);
    // The opening title covers the centre for three seconds. Both captures must have the same HUD;
    // otherwise its bright text can make the unlit frame look as bright as the teammate's real beam.
    await expect(page.locator('#banner')).toBeHidden({ timeout: 10_000 });
    await expect(page.locator('#fade-overlay')).toBeHidden({ timeout: 10_000 });
    await expect(page.locator('#tut')).toBeVisible({ timeout: 5000 });
    const hud = () => page.evaluate(() => ['banner', 'tut', 'objective', 'hint', 'goal-arrow'].map((id) => {
      const el = document.getElementById(id)!;
      return { id, hidden: el.hidden, text: el.textContent };
    }));
    const beforeHud = await hud();
    const capture = async (on: boolean) => {
      light = on;
      await expect.poll(() => page.evaluate((id) => !!((window.__escape.game() as any).remotes.get(id)?.f & 4), id)).toBe(on);
      await page.waitForTimeout(700); // the real team light fades between holders
      const png = await shot(page, testInfo.outputPath(`teammate-torch-${on ? 'on' : 'off'}.png`));
      return page.evaluate(async (b64) => {
        const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
        const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
        const context = canvas.getContext('2d', { willReadFrequently: true })!; context.drawImage(img, 0, 0);
        const { data } = context.getImageData(0, 0, img.width, img.height);
        let sum = 0, n = 0;
        for (let y = Math.floor(img.height / 3); y < 2 * img.height / 3; y++) for (let x = Math.floor(img.width / 3); x < 2 * img.width / 3; x++) {
          const i = (y * img.width + x) * 4; sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; n++;
        }
        return sum / n;
      }, png.toString('base64'));
    };
    const off = await capture(false), on = await capture(true);
    const afterHud = await hud();
    await testInfo.attach('teammate-light-measurements', { contentType: 'application/json', body: JSON.stringify({ off, on, ratio: on / off, origin, target, correction, snapshot, beforeHud, afterHud }) });
    expect(afterHud).toEqual(beforeHud);
    expect(off).toBeGreaterThan(0);
    expect(on / off, `same-view centre brightness: off=${off.toFixed(2)}, on=${on.toFixed(2)}`).toBeGreaterThanOrEqual(1.3);
    expect(await page.evaluate((id) => {
      const g = window.__escape.game() as any, remote = g.remotes.get(id);
      return remote.mesh.visible && remote.st.cone.visible && g.teamPick.slots.some((slot: any) => slot.holder === id);
    }, id)).toBe(true);
  } finally {
    clearInterval(inputTimer); ws.close();
  }
});

});

test('real production authority rejects debug while snapshots continue', async ({ page }) => {
  test.skip(process.env.ESC_SCREEN_SERVER_ENV !== 'production', 'run against NODE_ENV=production');
  await page.goto('/?nodraw&steady');
  await page.fill('#name', '生产拒绝回归');
  await page.click('#create'); await page.click('#start');
  await expect.poll(() => page.evaluate(() => (window.__escape.game() as unknown as { spawnSynced: boolean })?.spawnSynced), { timeout: 15_000 }).toBe(true);
  const before = await page.evaluate(() => {
    const e = window.__escape, g = e.game()!;
    (window as any).originalHandler = e.net.onMsg;
    return { x: g.pos.x, z: g.pos.z, snaps: g.snaps };
  });
  const started = Date.now();
  await expect(assertDebugAvailable(page, { timeout: 750 })).rejects.toThrow('NODE_ENV=production');
  expect(Date.now() - started).toBeLessThan(5000);
  const after = await page.evaluate(() => {
    const g = window.__escape.game()!;
    return { x: g.pos.x, z: g.pos.z, snaps: g.snaps, restored: window.__escape.net.onMsg === (window as any).originalHandler };
  });
  expect(after.snaps).toBeGreaterThan(before.snaps);
  expect(after.x).toBeCloseTo(before.x, 1); expect(after.z).toBeCloseTo(before.z, 1);
  expect(after.restored).toBe(true);
});
