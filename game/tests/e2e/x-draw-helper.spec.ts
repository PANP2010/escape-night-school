import { expect, test, type Page } from '@playwright/test';
import { access } from 'node:fs/promises';
import { frame, shot } from './draw.ts';

test.use({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

async function scene(page: Page, blackRenders = 0) {
  await page.setContent('<style>body{margin:0;background:#000}canvas{position:fixed;inset:0;width:100%;height:100%;visibility:hidden}#hud{position:fixed;top:0;color:white;z-index:1}</style><canvas></canvas><div id="hud">HUD stays visible</div>');
  await page.evaluate((blackRenders) => {
    const w = window as any, canvas = document.querySelector('canvas')!;
    canvas.width = 844 * 3; canvas.height = 390 * 3;
    w.renders = 0; w.paintFrames = 0; w.decodedAt = -1;
    const tick = () => { w.paintFrames++; requestAnimationFrame(tick); }; requestAnimationFrame(tick);
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = async function () { await decode.call(this); if (this.id === 'e2e-shot') w.decodedAt = w.paintFrames; };
    w.__escape = { game: () => ({ renderer: { domElement: canvas, render: () => {
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = ++w.renders <= blackRenders ? '#000' : '#357a5c'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (w.darkCentre) { ctx.fillStyle = '#000'; ctx.fillRect(0, canvas.height * 0.46, canvas.width, canvas.height * 0.08); }
    } }, scene: {}, camera: {} }) };
  }, blackRenders);
}

test('DPR 3 frame is decoded and painted twice before returning; shot preserves the scene beneath HUD', async ({ page }) => {
  await scene(page);
  await frame(page, 1);
  expect(await page.evaluate(() => (window as any).paintFrames - (window as any).decodedAt)).toBeGreaterThanOrEqual(2);
  expect(await page.locator('#e2e-shot').evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(2532);
  const png = await shot(page, 'test-results/draw-dpr3.png', 1);
  expect(await page.evaluate(async (b64) => {
    const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(img, 0, 0);
    return [...ctx.getImageData(1200, 800, 1, 1).data]; // beneath the HUD, physical DPR 3 coordinates
  }, png.toString('base64'))).toEqual([53, 122, 92, 255]);
  await expect(page.locator('#e2e-shot')).toHaveCount(0);
});

test('black render retries use scene pixels and stop after three attempts', async ({ page }) => {
  await scene(page, 1);
  await frame(page, 1);
  expect(await page.evaluate(() => (window as any).renders)).toBe(2);
  await scene(page, 100);
  await expect(frame(page, 1)).rejects.toThrow('black render after 3 attempts');
  expect(await page.evaluate(() => (window as any).renders)).toBe(3);
  await expect(page.locator('#e2e-shot')).toHaveCount(0);
});

test('a black capture with visible HUD is retried, and permanent failure leaves no image or stale file', async ({ page }) => {
  await scene(page);
  const original = page.screenshot.bind(page);
  let attempts = 0, alwaysBlack = false;
  page.screenshot = async (options) => {
    const black = alwaysBlack || ++attempts === 1;
    if (black) await page.locator('#e2e-shot').evaluate((img) => { (img as HTMLElement).style.visibility = 'hidden'; });
    try { return await original(options); }
    finally { if (black) await page.locator('#e2e-shot').evaluate((img) => { (img as HTMLElement).style.visibility = ''; }); }
  };
  try {
    await shot(page, 'test-results/draw-capture-retry.png', 1);
    expect(attempts).toBe(2);
    alwaysBlack = true;
    await expect(shot(page, 'test-results/draw-capture-retry.png', 1)).rejects.toThrow('scene stayed black after 3 captures');
    await expect(access('test-results/draw-capture-retry.png')).rejects.toThrow();
    await expect(page.locator('#e2e-shot')).toHaveCount(0);
  } finally { page.screenshot = original; }
});

test('a dark centre still needs captured scene evidence elsewhere', async ({ page }) => {
  await scene(page);
  await page.evaluate(() => { (window as any).darkCentre = true; });
  await shot(page, 'test-results/draw-dark-centre.png', 1);
  const original = page.screenshot.bind(page);
  let attempts = 0;
  page.screenshot = async (options) => {
    attempts++;
    await page.locator('#e2e-shot').evaluate((img) => { (img as HTMLElement).style.visibility = 'hidden'; });
    try { return await original(options); }
    finally { await page.locator('#e2e-shot').evaluate((img) => { (img as HTMLElement).style.visibility = ''; }); }
  };
  try {
    await expect(shot(page, 'test-results/draw-dark-centre.png', 1)).rejects.toThrow('scene stayed black after 3 captures');
    expect(attempts).toBe(3);
    await expect(access('test-results/draw-dark-centre.png')).rejects.toThrow();
  } finally { page.screenshot = original; }
});

test('a painted upper half cannot excuse a black lower half', async ({ page }) => {
  await scene(page);
  const original = page.screenshot.bind(page);
  let attempts = 0;
  page.screenshot = async (options) => {
    attempts++;
    await page.locator('#e2e-shot').evaluate((img) => { (img as HTMLElement).style.clipPath = 'inset(0 0 50% 0)'; });
    try { return await original(options); }
    finally { await page.locator('#e2e-shot').evaluate((img) => { (img as HTMLElement).style.clipPath = ''; }); }
  };
  try {
    await expect(shot(page, 'test-results/draw-partial.png', 1)).rejects.toThrow('scene stayed black after 3 captures');
    expect(attempts).toBe(3);
    await expect(access('test-results/draw-partial.png')).rejects.toThrow();
    await expect(page.locator('#e2e-shot')).toHaveCount(0);
  } finally { page.screenshot = original; }
});

test('real locker and down masks preserve the visible scene checks', async ({ page }) => {
  await scene(page);
  await page.addStyleTag({ content: `
    #hud { inset:0; pointer-events:none }
    #hide-overlay, #down-overlay { position:absolute; inset:0 }
    #hide-overlay.locker { background:linear-gradient(#000 0 43%, #0000 43% 57%, #000 57% 100%), radial-gradient(ellipse at center, #0000 20%, #000d 80%) }
    #down-overlay { background:radial-gradient(ellipse at center, #0000 35%, #3a0608cc 100%), radial-gradient(ellipse at center, #0000 38%, #000d 100%) }
    #down-overlay > div { position:absolute; top:12%; left:25% }
  ` });
  await page.locator('#hud').evaluate((hud) => { hud.innerHTML = '<div id="hide-overlay" class="locker"></div>'; });
  await shot(page, 'test-results/draw-locker-mask.png', 1);
  await page.locator('#hud').evaluate((hud) => { hud.innerHTML = '<div id="down-overlay"><div>倒地中，等待搀扶</div></div>'; });
  // These panels are mounted beside #hud, as in feedback/update-notice specs; the remaining scene still counts.
  await page.evaluate(() => {
    const settings = document.createElement('div'); settings.id = 'game-settings'; settings.textContent = '夜校设置';
    settings.setAttribute('open', '');
    settings.style.cssText = 'position:fixed;left:12px;top:44px;width:240px;height:230px;background:#102019;color:white;z-index:32';
    const notice = document.createElement('div'); notice.id = 'update-available'; notice.textContent = '新版本已上线';
    notice.style.cssText = 'position:fixed;right:12px;top:54px;width:200px;height:60px;background:#12271a;color:white;z-index:4';
    document.body.append(settings, notice);
  });
  await shot(page, 'test-results/draw-down-mask.png', 1);
  await expect(page.locator('#e2e-shot')).toHaveCount(0);
});

test('a visible full-screen portrait notice is a valid covered scene', async ({ page }) => {
  await scene(page);
  await page.addStyleTag({ content: '#rotate{position:fixed;inset:0;z-index:10;background:#000;color:#fff;display:flex;align-items:center;justify-content:center;font-size:24px}' });
  await page.evaluate(() => { const mask = document.createElement('div'); mask.id = 'rotate'; mask.textContent = '请横屏游玩'; document.body.append(mask); });
  await shot(page, 'test-results/draw-portrait-mask.png', 1);
  await expect(page.locator('#e2e-shot')).toHaveCount(0);
  const original = page.screenshot.bind(page);
  let missingScene = false;
  page.screenshot = async (options) => {
    await page.locator(missingScene ? '#rotate, #e2e-shot' : '#rotate').evaluateAll((elements) => elements.forEach((el) => { (el as HTMLElement).style.visibility = 'hidden'; }));
    try { return await original(options); }
    finally { await page.locator('#rotate, #e2e-shot').evaluateAll((elements) => elements.forEach((el) => { (el as HTMLElement).style.visibility = ''; })); }
  };
  try {
    // A green scene without the white notice is missing the intended UI too; its brightness cannot substitute.
    await expect(shot(page, 'test-results/draw-portrait-mask.png', 1)).rejects.toThrow('scene stayed black after 3 captures');
    missingScene = true;
    await expect(shot(page, 'test-results/draw-portrait-mask.png', 1)).rejects.toThrow('scene stayed black after 3 captures');
    await expect(access('test-results/draw-portrait-mask.png')).rejects.toThrow();
  } finally { page.screenshot = original; }
});

test('screenshot errors clean up the temporary scene image', async ({ page }) => {
  await scene(page);
  const original = page.screenshot;
  page.screenshot = async () => { throw new Error('capture failed'); };
  try { await expect(shot(page, 'test-results/draw-error.png')).rejects.toThrow('capture failed'); }
  finally { page.screenshot = original; }
  await expect(page.locator('#e2e-shot')).toHaveCount(0);
});

test('a closed page during screenshot cleanup preserves the capture error', async ({ page }) => {
  await scene(page);
  const original = page.screenshot;
  page.screenshot = async () => { await page.close(); throw new Error('capture failed'); };
  try { await expect(shot(page, 'test-results/draw-closed-error.png')).rejects.toThrow('capture failed'); }
  finally { page.screenshot = original; }
});
