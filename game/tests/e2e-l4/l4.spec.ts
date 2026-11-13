import { test, expect, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import WebSocket from 'ws';
import { L4 } from '../../shared/levels/l4.ts';
import { L5 } from '../../shared/levels/l5.ts';
import { EYE_H } from '../../shared/constants.ts';
import { ST_SPECTATE, type ClientMsg, type ServerMsg } from '../../shared/protocol.ts';
import { shot } from '../e2e/draw.ts';

const def = L4.broadcast!;
type ObserverGameState = {
  myId: number;
  spectate: boolean;
  peers: Map<number, { st: number; p: [number, number, number] }>;
};

async function walkTo(page: Page, at: { x: number; y: number; z: number }) {
  const corrections = await page.evaluate(at => {
    const g = window.__escape.game() as any, nav = g.navGraph;
    const path = nav.astar(nav.nearest(g.body.x, g.body.y, g.body.z), nav.nearest(at.x, at.y, at.z));
    if (!path) throw new Error(`No walking route to ${JSON.stringify(at)}`);
    g.autopilot([[g.body.x, g.body.z], ...path.map((id: number) => [nav.nodes[id].x, nav.nodes[id].z]), [at.x, at.z]]);
    return g.corrections as number;
  }, at);
  await expect.poll(() => page.evaluate(() => window.__escape.game()!.autopilotDone), { timeout: 45_000 }).toBe(true);
  await expect.poll(() => page.evaluate(at => { const b = window.__escape.game()!.body; return Math.hypot(b.x - at.x, b.y - at.y, b.z - at.z); }, at)).toBeLessThan(.4);
  expect(await page.evaluate(() => window.__escape.game()!.corrections)).toBe(corrections);
}

test('L4: walk upstairs, share/read clues, natural roll call + shelter, keypad and team exit over real WS', async ({ page, baseURL }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/?nodraw&steady'); await page.fill('#name', '广播甲'); await page.click('#create');
  await expect(page.locator('#wait-code')).toHaveText(/^[A-Z2-9]{4}$/);
  const code = await page.locator('#wait-code').innerText();
  const bot = new WebSocket(new URL('/ws', baseURL).href.replace(/^http/, 'ws')), received: ServerMsg[] = [];
  bot.on('message', d => received.push(JSON.parse(d.toString())));
  const send = (m: ClientMsg) => bot.send(JSON.stringify(m));
  const latest = <T extends ServerMsg['t']>(t: T) => received.filter((m): m is Extract<ServerMsg, { t: T }> => m.t === t).at(-1);
  try {
    await new Promise<void>((resolve, reject) => { bot.once('open', resolve); bot.once('error', reject); });
    send({ t: 'hello', name: '广播乙' }); send({ t: 'join', code });
    await expect(page.locator('#wait-members')).toContainText('广播乙'); await page.click('#start');
    await expect.poll(() => page.evaluate(() => window.__escape.game()?.snaps ?? 0)).toBeGreaterThan(2);
    await writeFile('test-results/l4-renderer.json', JSON.stringify(await page.evaluate(() => {
      const gl = window.__escape.game()!.renderer.getContext(), info = gl.getExtension('WEBGL_debug_renderer_info');
      return { renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), version: gl.getParameter(gl.VERSION) };
    }), null, 2));
    expect(await page.evaluate(() => window.__escape.game()?.level.index)).toBe(3);
    await expect(page.locator('#room-code')).toContainText('第 4 关'); await expect(page.locator('#objective .g')).toContainText('贴纸 0/4');
    await page.evaluate(() => window.__escape.debug('safe', 180));
    await shot(page, 'test-results/l4-entry.png');
    // No teleport: follow the real server nav across the stair flights and into the 4F station.
    await page.evaluate(at => {
      const g = window.__escape.game() as any, nav = g.navGraph;
      const path = nav.astar(nav.nearest(g.body.x, g.body.y, g.body.z), nav.nearest(at.x, at.y, at.z));
      if (!path) throw new Error('No route upstairs');
      g.autopilot([[g.body.x, g.body.z], ...path.map((id: number) => [nav.nodes[id].x, nav.nodes[id].z])]);
    }, def.console);
    try {
      await expect.poll(() => page.evaluate(() => window.__escape.game()?.body.y ?? 0), { timeout: 45_000 }).toBeGreaterThan(10.5);
    } catch (error) {
      await writeFile('test-results/l4-stair-diag.json', JSON.stringify(await page.evaluate(() => { const g = window.__escape.game() as any; return { body: g.body, corrections: g.corrections, route: g.route, routeAt: g.routeAt, target: g.target(), doors: g.doorOpen, bounds: g.level.def.area }; }), null, 2));
      await shot(page, 'test-results/l4-stair-stuck.png'); throw error;
    }
    await expect.poll(() => page.evaluate(() => window.__escape.game()?.autopilotDone ?? false), { timeout: 30_000 }).toBe(true);
    // The teammate reads the two 3F stickers; both clients must see each update.
    for (const id of [0, 1]) {
      const at = def.stickers[id], n = received.length;
      send({ t: 'debug', op: 'tp', x: at.x, z: at.z + (at.face === 'z+' ? .6 : -.6), floor: 2 });
      await expect.poll(() => received.slice(n).some(m => m.t === 'correct' && Math.abs(m.p[1] - 7.2) < .1)).toBe(true);
      send({ t: 'broadcast', op: 'read', id });
      await expect.poll(() => latest('broadcast')?.clues[id] ?? null).not.toBeNull();
    }
    await expect(page.locator('#objective .g')).toContainText('贴纸 2/4');
    // Browser reads the two 4F stickers with the actual E prompt.
    for (const id of [2, 3]) {
      const at = def.stickers[id], z = at.z + (at.face === 'z+' ? .65 : -.65);
      await walkTo(page, { x: at.x, y: at.y, z });
      await page.evaluate(at => { const g = window.__escape.game()!; g.input.yaw = Math.atan2(g.body.x - at.x, g.body.z - at.z); g.input.pitch = 0; }, at);
      await expect(page.locator('#prompt')).toHaveText('E 揭开贴纸');
      if (id === 2) {
        await page.keyboard.press('KeyF');
        await shot(page, 'test-results/l4-sticker-visible.png');
      }
      await page.keyboard.press('KeyE');
      await expect.poll(() => latest('broadcast')?.clues[id] ?? null).not.toBeNull();
    }
    await expect(page.locator('#objective .g')).toContainText('四楼广播室');
    const clues = latest('broadcast')!.clues; expect(clues.every(c => typeof c === 'string')).toBe(true);
    // Wait for the unmodified 60–90 s server schedule, then hide the selected player via an authoritative act.
    await expect.poll(() => latest('broadcast')?.call?.id ?? 0, { timeout: 95_000, intervals: [200] }).toBeGreaterThan(0);
    const call = latest('broadcast')!.call!;
    const own = await page.evaluate(() => window.__escape.game()!.myId);
    const h = L4.hides[0];
    if (call.id === own) {
      await page.evaluate(h => { window.__escape.debug('tp', h.x, h.z - .7, 2); }, h);
      await expect.poll(() => page.evaluate(() => window.__escape.game()!.body.y)).toBeLessThan(8);
      await page.evaluate(() => window.__escape.net.send({ t: 'act', kind: 'hide', id: 0 }));
    } else {
      const n = received.length; send({ t: 'debug', op: 'tp', x: h.x, z: h.z - .7, floor: 2 });
      await expect.poll(() => received.slice(n).some(m => m.t === 'correct')).toBe(true); send({ t: 'act', kind: 'hide', id: 0 });
    }
    await expect.poll(() => latest('broadcast')?.call?.shielded).toBe(true);
    expect(latest('broadcast')?.call?.p).toBeUndefined(); await expect(page.locator('#broadcast-status')).toContainText('已屏蔽');
    await shot(page, 'test-results/l4-shielded.png');
    if (call.id === own) await page.evaluate(() => window.__escape.net.send({ t: 'act', kind: 'unhide', id: 0 }));
    else send({ t: 'act', kind: 'unhide', id: 0 });
    // Open the real keypad, reject a wrong code, then stop broadcasting with the shared notebook code.
    const at = def.console;
    await expect.poll(() => page.evaluate(() => window.__escape.game()!.hiding)).toBeLessThan(0);
    await walkTo(page, { x: at.x, y: at.y, z: at.z - .8 });
    await page.evaluate(at => { const g = window.__escape.game()!; g.input.yaw = Math.atan2(g.body.x - at.x, g.body.z - at.z); g.input.pitch = -.15; }, at);
    await expect(page.locator('#prompt')).toHaveText('E 输入停播密码'); await page.keyboard.press('KeyE');
    await expect(page.locator('#broadcast-keypad')).toBeVisible();
    const answer = clues.join(''), wrong = String((Number(answer) + 1) % 10000).padStart(4, '0');
    await page.getByLabel('四位停播密码').fill(wrong); await page.getByRole('button', { name: '确认停播' }).click();
    await expect(page.locator('#broadcast-keypad')).toContainText('密码错误'); expect(latest('broadcast')!.off).toBe(false);
    await shot(page, 'test-results/l4-keypad.png');
    // Two submissions in one task must leave a visible retry message rather than a stuck "checking" state.
    await page.evaluate(({ wrong, answer }) => {
      window.__escape.net.send({ t: 'broadcast', op: 'code', code: wrong });
      window.__escape.net.send({ t: 'broadcast', op: 'code', code: answer });
    }, { wrong, answer });
    await expect(page.locator('#broadcast-keypad')).toContainText('稍等一秒'); expect(latest('broadcast')!.off).toBe(false);
    await page.waitForTimeout(1050); await page.getByLabel('四位停播密码').fill(answer); await page.getByRole('button', { name: '确认停播' }).click();
    await expect(page.locator('#broadcast-keypad')).toBeHidden(); await expect(page.locator('#broadcast-status')).toContainText('广播已关闭');
    expect(latest('broadcast')!.off).toBe(true);
    await shot(page, 'test-results/l4-stopped.png');
    // Walk the reverse staircase route as well; the sealed lower flight must not trap or correct us.
    const corrections = await page.evaluate(e => {
      const g = window.__escape.game() as any, nav = g.navGraph;
      const path = nav.astar(nav.nearest(g.body.x, g.body.y, g.body.z), nav.nearest(e.x, e.y, e.z));
      if (!path) throw new Error('No route downstairs');
      g.autopilot([[g.body.x, g.body.z], ...path.map((id: number) => [nav.nodes[id].x, nav.nodes[id].z]), [e.x, e.z]]);
      return g.corrections as number;
    }, L4.exit);
    await expect.poll(() => page.evaluate(() => window.__escape.game()!.body.y), { timeout: 45_000 }).toBeLessThan(8);
    await expect.poll(() => page.evaluate(() => window.__escape.game()!.autopilotDone), { timeout: 30_000 }).toBe(true);
    expect(await page.evaluate(() => window.__escape.game()!.corrections)).toBe(corrections);
    const arrival = await page.evaluate(e => {
      const g = window.__escape.game() as any;
      return { body: g.body, players: [...g.peers], off: g.broadcastView.state.off, distance: Math.hypot(g.body.x - e.x, g.body.z - e.z) };
    }, L4.exit);
    await writeFile('test-results/l4-exit-arrival.json', JSON.stringify(arrival, null, 2));
    expect(arrival.distance).toBeLessThan(.4);
    await expect(page.locator('#fade-overlay')).toBeHidden();
    send({ t: 'debug', op: 'tp', x: L4.exit.x, z: L4.exit.z, floor: 2 });
    await expect(page.locator('#fade-overlay')).toBeVisible(); expect(latest('fade')).toMatchObject({ restart: false });
    await expect.poll(() => page.evaluate(() => window.__escape.game()?.level.index), { timeout: 15_000 }).toBe(4);
    await expect(page.locator('#room-code')).toContainText('第 5 关');
    await expect(page.locator('#objective')).toContainText('记分牌');
    expect(latest('complete')).toBeUndefined();
    expect(latest('room')).toMatchObject({ level: 4 });
    await expect.poll(() => page.evaluate(() => window.__escape.game()?.level.name)).toBe(L5.name);
    expect(errors).toEqual([]);
  } finally { bot.close(); }
});

test('L4: map follows the current floor, separates exploration and keeps the exit on 3F', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/?nodraw&steady'); await page.fill('#name', '分层地图'); await page.click('#create'); await page.click('#start');
  await expect.poll(() => page.evaluate(() => window.__escape.game()?.snaps ?? 0)).toBeGreaterThan(2);
  await page.evaluate(() => {
    window.__escape.debug('safe', 60);
    const canvas = document.querySelector<HTMLCanvasElement>('#map canvas')!, ctx = canvas.getContext('2d')!;
    const labels: string[] = []; (canvas as any).__l4Labels = labels;
    const clear = ctx.clearRect.bind(ctx), fill = ctx.fillText.bind(ctx);
    ctx.clearRect = (...args) => { labels.length = 0; clear(...args); };
    ctx.fillText = (text, x, y, maxWidth) => { labels.push(text); if (maxWidth === undefined) fill(text, x, y); else fill(text, x, y, maxWidth); };
  });
  const labels = () => page.evaluate(() => [...((document.querySelector('#map canvas') as any).__l4Labels as string[])]);
  await page.keyboard.press('KeyM'); await expect(page.locator('#map')).toBeVisible();
  await expect.poll(labels).toContain('历史组');
  await expect(page.locator('#map .mt')).toHaveText('平面图 · 广播站 · 3F');
  expect(await labels()).toContain('团委'); expect(await labels()).toContain('出口');
  expect(await labels()).not.toContain('工会'); expect(await labels()).not.toContain('接待室');
  await shot(page, 'test-results/l4-map-3f.png');
  // Read the actual canvas labels after entering 4F's broadcast room; no page reload or map re-opening.
  await page.evaluate(at => window.__escape.debug('tp', at.x, at.z + 1, 3), def.console);
  await expect.poll(() => page.evaluate(() => window.__escape.game()!.body.y)).toBeGreaterThan(10.5);
  await expect.poll(labels).toContain('工会');
  await expect(page.locator('#map .mt')).toHaveText('平面图 · 广播站 · 4F');
  const upper = await labels();
  expect(upper).toContain('接待室'); expect(upper).not.toContain('历史组'); expect(upper).not.toContain('团委');
  expect(upper).not.toContain('出口'); expect(upper.some(t => /出口.*3|出口.*三/.test(t))).toBe(true);
  await expect.poll(() => page.evaluate(() => {
    const g = window.__escape.game() as any;
    return [...g.explored].map((i: any) => ({ name: g.plan.rooms[i].name, y: g.plan.rooms[i].y }));
  })).toContainEqual({ name: '工会', y: 10.8 });
  expect(await page.evaluate(() => {
    const g = window.__escape.game() as any; return [...g.explored].some((i: any) => g.plan.rooms[i].name === '团委');
  })).toBe(false);
  await shot(page, 'test-results/l4-map-4f.png'); expect(errors).toEqual([]);
});

test('L4: a real late observer maps the followed teammate floor and then the freely flown camera floor', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(`host: ${e.message}`));
  await page.goto('/?nodraw&steady'); await page.fill('#name', '四楼队友'); await page.click('#create');
  await expect(page.locator('#wait-code')).toHaveText(/^[A-Z2-9]{4}$/);
  const code = await page.locator('#wait-code').innerText(); await page.click('#start');
  await expect.poll(() => page.evaluate(() => window.__escape.game()?.snaps ?? 0)).toBeGreaterThan(2);
  await page.evaluate(at => { window.__escape.debug('safe', 60); window.__escape.debug('tp', at.x, at.z - .8, 3); }, def.console);
  await expect.poll(() => page.evaluate(() => window.__escape.game()!.body.y)).toBeCloseTo(10.8, 1);
  const hostId = await page.evaluate(() => window.__escape.game()!.myId);

  // Join an already running room through the real lobby/WS flow; never inject spectator or map state.
  const observer = await context.newPage(); observer.on('pageerror', e => errors.push(`observer: ${e.message}`));
  try {
    await observer.goto('/?nodraw&steady'); await observer.fill('#name', '晚入观察者');
    await observer.fill('#code', code); await observer.click('#join');
    await expect.poll(() => observer.evaluate(status => {
      const g = window.__escape.game() as unknown as ObserverGameState | undefined;
      return !!g?.spectate && g.peers.get(g.myId)?.st === status;
    }, ST_SPECTATE)).toBe(true);
    await expect.poll(() => observer.evaluate(id => {
      const g = window.__escape.game() as unknown as ObserverGameState;
      return g.peers.get(id)?.p[1] ?? 0;
    }, hostId)).toBeCloseTo(10.8, 1);
    expect(await observer.evaluate(() => window.__escape.game()!.body.y)).toBeCloseTo(7.2, 1);
    await observer.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('#map canvas')!, ctx = canvas.getContext('2d')!;
      const labels: string[] = []; (canvas as any).__l4ObserverLabels = labels;
      const clear = ctx.clearRect.bind(ctx), fill = ctx.fillText.bind(ctx);
      ctx.clearRect = (...args) => { labels.length = 0; clear(...args); };
      ctx.fillText = (text, x, y, maxWidth) => { labels.push(text); if (maxWidth === undefined) fill(text, x, y); else fill(text, x, y, maxWidth); };
    });
    const labels = () => observer.evaluate(() => [...((document.querySelector('#map canvas') as any).__l4ObserverLabels as string[])]);
    await observer.keyboard.press('KeyM'); await expect(observer.locator('#map')).toBeVisible();
    await expect(observer.locator('#map .mt')).toHaveText('平面图 · 广播站 · 3F');

    await observer.keyboard.press('Tab'); await expect(observer.locator('#spec-bar')).toContainText('观察：四楼队友');
    await expect.poll(() => observer.evaluate(() => (window.__escape.game() as any).follow)).toBe(hostId);
    await expect(observer.locator('#map .mt')).toHaveText('平面图 · 广播站 · 4F');
    await expect.poll(labels).toContain('工会');
    expect(await labels()).toContain('接待室'); expect(await labels()).not.toContain('历史组');
    expect(await observer.evaluate(() => window.__escape.game()!.body.y)).toBeCloseTo(7.2, 1);
    expect(await observer.evaluate(() => window.__escape.game()!.camera.position.y)).toBeGreaterThan(10.8);

    // Actual Tab cycling and held WASD change the free camera; tickMap must update an already open map.
    await observer.keyboard.press('Tab'); await expect(observer.locator('#spec-bar')).toContainText('WASD 自由飞行');
    await expect.poll(() => observer.evaluate(() => (window.__escape.game() as any).follow)).toBe(0);
    await expect(observer.locator('#map .mt')).toHaveText('平面图 · 广播站 · 3F');
    await observer.evaluate(() => window.__escape.game()!.input.look(0, -1000));
    await observer.keyboard.down('KeyW');
    try {
      await expect.poll(() => observer.evaluate(() => window.__escape.game()!.camera.position.y), { timeout: 5000 }).toBeGreaterThan(10.8 + EYE_H);
    } finally { await observer.keyboard.up('KeyW'); }
    await expect(observer.locator('#map .mt')).toHaveText('平面图 · 广播站 · 4F');
    await expect.poll(labels).toContain('工会'); expect(await labels()).not.toContain('历史组');
    expect(await observer.evaluate(() => window.__escape.game()!.body.y)).toBeCloseTo(7.2, 1);

    await observer.evaluate(() => window.__escape.game()!.input.look(0, 2000));
    await observer.keyboard.down('KeyW');
    try {
      await expect.poll(() => observer.evaluate(() => window.__escape.game()!.camera.position.y), { timeout: 5000 }).toBeLessThan(7.2 + EYE_H);
    } finally { await observer.keyboard.up('KeyW'); }
    await expect(observer.locator('#map .mt')).toHaveText('平面图 · 广播站 · 3F');
    await expect.poll(labels).toContain('历史组'); expect(await labels()).not.toContain('工会');
    expect(await observer.evaluate(() => window.__escape.game()!.body.y)).toBeCloseTo(7.2, 1);
    expect(await observer.evaluate(() => (window.__escape.game() as any).follow)).toBe(0);
    expect(errors).toEqual([]);
  } finally { await observer.close(); }
});

test('L4: landscape touch HUD and keypad stay readable and touch controls enter the code', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  const page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto('/?nodraw&steady'); await page.fill('#name', '横屏键盘'); await page.tap('#create'); await page.tap('#start');
    await expect.poll(() => page.evaluate(() => window.__escape.game()?.snaps ?? 0)).toBeGreaterThan(2);
    await expect(page.locator('body')).toHaveClass(/touch/);
    await expect(page.locator('#objective')).toBeVisible();
    const layout = await page.evaluate(() => {
      const status = document.getElementById('broadcast-status')!.getBoundingClientRect(), objective = document.getElementById('objective')!.getBoundingClientRect();
      const settings = document.getElementById('settings-open')!.getBoundingClientRect();
      return { separate: status.right <= objective.left || status.bottom <= objective.top || status.top >= objective.bottom,
        clearSettings: settings.bottom <= status.top, inside: status.left >= 0 && status.right <= innerWidth };
    });
    expect(layout).toEqual({ separate: true, clearSettings: true, inside: true });
    await shot(page, 'test-results/l4-touch-entry.png');
    await expect(page.locator('#banner')).toBeHidden();
    // Tap an actual wall sticker away from the crosshair; the real server publishes the digit.
    const sticker = def.stickers[0];
    await page.evaluate(at => { window.__escape.debug('safe', 60); window.__escape.debug('tp', at.x, at.z + .8, 2); }, sticker);
    await expect.poll(() => page.evaluate(at => { const g = window.__escape.game()!; return Math.abs(g.body.y - at.y) < .1 && Math.hypot(g.body.x - at.x, g.body.z - (at.z + .8)) < .2; }, sticker)).toBe(true);
    // Keep the paper beside the central interaction prompt, whose visible HUD rectangle must block world taps.
    await page.evaluate(at => { const g = window.__escape.game()!; g.input.yaw = Math.atan2(g.body.x - at.x, g.body.z - at.z) + .55; g.input.pitch = 0; }, sticker);
    const stickerPoint = await page.evaluate(async at => {
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const g = window.__escape.game()!; g.camera.updateMatrixWorld();
      const v = new window.__escape.THREE.Vector3(at.x, at.y + 1.45, at.z).project(g.camera);
      return { x: (v.x + 1) * innerWidth / 2, y: (1 - v.y) * innerHeight / 2 };
    }, sticker);
    await page.touchscreen.tap(stickerPoint.x, stickerPoint.y);
    await expect(page.locator('#objective .g')).toContainText('贴纸 1/4');
    await shot(page, 'test-results/l4-touch-sticker.png');
    await page.evaluate(at => { window.__escape.debug('safe', 60); window.__escape.debug('tp', at.x, at.z - .8, 3); }, def.console);
    await expect.poll(() => page.evaluate(at => { const g = window.__escape.game()!; return Math.abs(g.body.y - at.y) < .1 && Math.hypot(g.body.x - at.x, g.body.z - (at.z - .8)) < .2; }, def.console)).toBe(true);
    await page.evaluate(at => { const g = window.__escape.game()!; g.input.yaw = Math.atan2(g.body.x - at.x, g.body.z - at.z) + .6; g.input.pitch = -.15; }, def.console);
    await expect(page.locator('#prompt')).toHaveText('点广播台 · 输入停播密码');
    const consolePoint = await page.evaluate(at => {
      const g = window.__escape.game()!; g.camera.updateMatrixWorld();
      const v = new window.__escape.THREE.Vector3(at.x, at.y + 1.25, at.z - .18).project(g.camera);
      return { x: (v.x + 1) * innerWidth / 2, y: (1 - v.y) * innerHeight / 2 };
    }, def.console);
    await page.touchscreen.tap(consolePoint.x, consolePoint.y);
    const dialog = page.getByRole('dialog', { name: '广播室控制键盘' }); await expect(dialog).toBeVisible();
    for (const digit of ['0', '0', '1', '2']) await dialog.getByRole('button', { name: digit, exact: true }).tap();
    await expect(page.getByLabel('四位停播密码')).toHaveValue('0012');
    await dialog.getByRole('button', { name: '退格', exact: true }).tap(); await expect(page.getByLabel('四位停播密码')).toHaveValue('001');
    await dialog.getByRole('button', { name: '2', exact: true }).tap();
    await dialog.getByRole('button', { name: '确认停播', exact: true }).tap();
    await expect(dialog).toContainText('先读齐四张编号贴纸');
    await shot(page, 'test-results/l4-touch-keypad.png');
    const box = await dialog.boundingBox(); expect(box).not.toBeNull(); expect(box!.y).toBeGreaterThanOrEqual(0); expect(box!.y + box!.height).toBeLessThanOrEqual(390);
    await dialog.getByRole('button', { name: '返回 / Esc', exact: true }).tap(); await expect(dialog).toBeHidden();
    expect(await page.evaluate(() => window.__escape.game()!.input.enabled)).toBe(true); expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('L4: being caught closes the keypad and returns control to downed/spectator mode', async ({ page }) => {
  await page.goto('/?nodraw&steady'); await page.fill('#name', '键盘测试'); await page.click('#create'); await page.click('#start');
  await expect.poll(() => page.evaluate(() => window.__escape.game()?.snaps ?? 0)).toBeGreaterThan(2);
  await page.evaluate(at => { window.__escape.debug('safe', 30); window.__escape.debug('tp', at.x, at.z - .8, 3); }, def.console);
  await expect.poll(() => page.evaluate(at => { const g = window.__escape.game()!; return Math.abs(g.body.y - at.y) < .1 && Math.hypot(g.body.x - at.x, g.body.z - (at.z - .8)) < .2; }, def.console)).toBe(true);
  await page.evaluate(at => { const g = window.__escape.game()!; g.input.yaw = Math.atan2(g.body.x - at.x, g.body.z - at.z); g.input.pitch = -.15; }, def.console);
  await expect(page.locator('#prompt')).toHaveText('E 输入停播密码'); await page.keyboard.press('KeyE');
  await expect(page.locator('#broadcast-keypad')).toBeVisible();
  await page.evaluate(() => window.__escape.debug('down', 1));
  await expect(page.locator('#broadcast-keypad')).toBeHidden();
  expect(await page.evaluate(() => window.__escape.game()!.input.enabled)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__escape.game()!.down || window.__escape.game()!.spectate)).toBe(true);
});
