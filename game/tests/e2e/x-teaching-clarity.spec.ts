import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { restoreRealFocus } from './realFocus.ts';
import { browserArgs } from '../browser-args.mjs';
import { frame } from './draw.ts';
import { gateStorageState } from '../gate-settings.ts';

// Native window visibility and pointer lock require real Chromium windows, including under npm run check.
test.use({ headless: false, launchOptions: { args: browserArgs(['--mute-audio']) } });

async function start(page: Page, duringIntro = false, layout = false) {
  await page.goto(layout && process.env.ESC_GPU !== '1' ? '/?nodraw&steady' : '/');
  await page.fill('#name', '新同学');
  await page.click('#create');
  await page.click('#start');
  await expect.poll(() => page.evaluate(() => window.__escape.game()?.presentationReady), { timeout: 30_000 }).toBe(true);
  if (!duringIntro) {
    await page.waitForFunction(() => !window.__escape.game()!.intro.active);
    await expect(page.locator('#hud')).toBeVisible();
    await page.evaluate(() => window.__escape.debug('safe', 600));
  }
  const renderer = await page.evaluate(() => {
    const gl = window.__escape.game()!.renderer.getContext();
    const extension = gl.getExtension('WEBGL_debug_renderer_info');
    return { renderer: String(gl.getParameter(extension?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER)),
      vendor: String(gl.getParameter(extension?.UNMASKED_VENDOR_WEBGL ?? gl.VENDOR)), version: String(gl.getParameter(gl.VERSION)) };
  });
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/teaching-renderer.json', JSON.stringify(renderer, null, 2));
}

async function finishIntro(page: Page, touch = false) {
  await expect(page.locator('#intro-overlay')).toBeVisible();
  await expect(page.locator('#intro-title')).toHaveText('第 1 关 · 一楼·晚自习后');
  await expect(page.locator('#intro-objective')).toHaveText('找到抽屉钥匙');
  expect(await page.evaluate(() => window.__escape.game()!.input.enabled)).toBe(false);
  const before = await page.evaluate(() => ({ ...window.__escape.game()!.pos }));
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(300);
  await page.keyboard.up('KeyW');
  expect(await page.evaluate(before => Math.hypot(window.__escape.game()!.pos.x - before.x,
    window.__escape.game()!.pos.z - before.z), before)).toBeLessThan(0.01);
  await screenshot(page, touch ? 'mobile-intro' : 'desktop-intro');
  if (touch) await page.locator('#intro-skip').tap();
  else await page.locator('#intro-skip').click();
  await page.waitForFunction(() => !window.__escape.game()!.intro.active && window.__escape.game()!.input.enabled);
  await expect(page.locator('#intro-overlay')).toBeHidden();
  await expect(page.locator('#hud')).toBeVisible();
  await page.evaluate(() => window.__escape.debug('safe', 600));
}

async function drawerStep(page: Page, touch = false, layout = false) {
  const item = await page.evaluate(() => {
    const g = window.__escape.game() as any;
    return g.items.find((i: any) => i.kind === 'drawer_key' && !i.decoy) as { id: number; p: number[] };
  });
  await page.evaluate(p => window.__escape.debug('tp', p[0] - 1, p[2]), item.p);
  await expect.poll(() => page.evaluate(p => Math.hypot(window.__escape.game()!.pos.x - p[0] + 1,
    window.__escape.game()!.pos.z - p[2]), item.p)).toBeLessThan(0.2);
  await expect.poll(() => page.evaluate(p => Math.hypot(window.__escape.game()!.camera.position.x - p[0] + 1,
    window.__escape.game()!.camera.position.z - p[2]), item.p)).toBeLessThan(0.2);
  await page.evaluate(p => {
    const g = window.__escape.game()!;
    g.input.yaw = Math.atan2(g.pos.x - p[0], g.pos.z - p[2]);
    g.input.pitch = Math.atan2(p[1] + 0.05 - g.camera.position.y, Math.hypot(g.pos.x - p[0], g.pos.z - p[2]));
  }, item.p);
  await expect.poll(() => page.evaluate(() => {
    const t = window.__escape.game()!.target(); return t && { kind: t.kind, id: t.id };
  })).toEqual({ kind: 'pick', id: item.id });
  if (layout && process.env.ESC_GPU !== '1') await frame(page, 1);
  if (touch) {
    await page.waitForFunction(() => {
      const g = window.__escape.game()!;
      return Math.abs(g.camera.rotation.y - g.input.yaw) < 0.01 && Math.abs(g.camera.rotation.x - g.input.pitch) < 0.01;
    });
    const point = await page.evaluate(id => {
      const g = window.__escape.game() as any;
      g.camera.updateMatrixWorld();
      const mesh = g.itemMeshes.get(id);
      mesh.updateWorldMatrix(true, true);
      const v = new window.__escape.THREE.Box3().setFromObject(mesh).getCenter(new window.__escape.THREE.Vector3()).project(g.camera);
      return { x: (v.x + 1) * innerWidth / 2, y: (1 - v.y) * innerHeight / 2 };
    }, item.id);
    const vp = page.viewportSize()!;
    expect(point.x).toBeGreaterThan(0); expect(point.x).toBeLessThan(vp.width);
    expect(point.y).toBeGreaterThan(0); expect(point.y).toBeLessThan(vp.height);
    await page.touchscreen.tap(point.x, point.y);
  } else {
    await page.locator('body > canvas').evaluate(canvas => { canvas.tabIndex = -1; canvas.focus(); });
    await page.keyboard.press('KeyE');
  }
  await expect.poll(() => page.evaluate(() => (window.__escape.game() as any).bag.drawer_key)).toBe(1);
  await expect.poll(() => page.evaluate(id => (window.__escape.game() as any).items.some((i: any) => i.id === id), item.id)).toBe(false);
  await expect(page.locator('#banner')).toBeVisible();
  await expect(page.locator('#banner .g')).toHaveText('打开上锁讲台抽屉，取出楼梯钥匙');
  return item;
}

async function overlay(page: Page, id: string, on: boolean) {
  await page.evaluate(({ id, on }) => {
    document.getElementById(id)?.remove();
    if (on) {
      const el = document.createElement('div');
      el.id = id; el.textContent = id === 'intro-overlay' ? '开场准备' : '被抓过场';
      Object.assign(el.style, { position: 'fixed', inset: '0', zIndex: '100', background: '#051009', color: '#fff' });
      document.body.append(el);
    }
  }, { id, on });
}

async function screenshot(page: Page, name: string) {
  mkdirSync('test-results', { recursive: true });
  if (name.endsWith('opening') || name.endsWith('resumed')) {
    await expect(page.locator('#banner')).not.toHaveClass(/out/);
    await expect(page.locator('#banner')).toHaveCSS('opacity', '1');
  }
  await page.screenshot({ path: `test-results/teaching-${name}.png` });
}

async function prepareLayoutScene(page: Page) {
  if (process.env.ESC_GPU === '1') return;
  // Draw the real scene once; keep simulation, WS, input and HUD rAF running over that image.
  // Software WebGL stalls can otherwise consume the entire 600ms CSS fade between paints.
  await frame(page, 1);
  await page.evaluate(() => {
    const g = window.__escape.game()!;
    g.renderFrame = () => {};
    g.draw = true;
  });
}

// Hit testing omits the pointer-events:none banner. Observe painted text and actual boxes instead,
// starting before the real pickup so the first readable frame and the entire fade are covered.
async function watchStepBanner(page: Page) {
  await page.evaluate(() => {
    const samples: any[] = [];
    (window as any).__stepBanner = samples;
    const banner = document.getElementById('banner')!;
    const panel = document.getElementById('objective')!;
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
    };
    const sample = () => {
      if (!banner.hidden && banner.querySelector('.g')!.textContent === '打开上锁讲台抽屉，取出楼梯钥匙') {
        const opacity = Number(getComputedStyle(banner).opacity);
        const phase = banner.classList.contains('out') ? 'fading' : 'readable';
        const visible = panel.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
        const b = box(banner), p = box(panel);
        const gap = visible ? Math.max(p.x - b.right, b.x - p.right, p.y - b.bottom, b.y - p.bottom) : null;
        const clipped: string[] = [];
        for (const root of [banner, ...(visible ? [panel] : [])]) {
          const bounds = box(root);
          // The goal element also bounds the generated “目标 · ” prefix, which Range omits.
          const rects = [box(root.querySelector('.g')!)];
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const node = walker.currentNode;
            if (!node.textContent?.trim() || !node.parentElement!.checkVisibility({ checkVisibilityCSS: true })) continue;
            const range = document.createRange(); range.selectNodeContents(node);
            rects.push(...Array.from(range.getClientRects()).map(r => ({ x: r.x, y: r.y, right: r.right, bottom: r.bottom })));
          }
          if (rects.some(r => r.x < Math.max(0, bounds.x) - .5 || r.y < Math.max(0, bounds.y) - .5
            || r.right > Math.min(innerWidth, bounds.right) + .5 || r.bottom > Math.min(innerHeight, bounds.bottom) + .5)) {
            clipped.push(root.id);
          }
        }
        samples.push({ at: performance.now(), phase, opacity, visible, gap, banner: b, panel: p, clipped });
      } else if (samples.length && banner.hidden) return;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

async function checkStepBanner(page: Page, name: string, touch = false) {
  await expect(page.locator('#banner')).toHaveCSS('opacity', '1');
  await screenshot(page, `${name}-step-full`);
  if (touch) {
    const light = await page.evaluate(() => window.__escape.game()!.light);
    await page.locator('.touch-btn', { hasText: '手电' }).tap();
    await expect.poll(() => page.evaluate(() => window.__escape.game()!.light)).toBe(!light);
    // A real drag must still reach the stick while the objective banner is showing.
    const cdp = await page.context().newCDPSession(page);
    const origin = { x: 88, y: page.viewportSize()!.height - 90 };
    try {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...origin, id: 1 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: origin.x, y: origin.y - 40, id: 1 }] });
      expect(await page.evaluate(() => [...window.__escape.game()!.input.keys])).toContain('KeyW');
      await expect(page.locator('#banner')).toBeVisible();
    } finally {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
    }
    await expect.poll(() => page.evaluate(() => [...window.__escape.game()!.input.keys])).toEqual([]);
  }
  await page.waitForFunction(() => {
    const b = document.getElementById('banner')!;
    const opacity = Number(getComputedStyle(b).opacity);
    return !b.hidden && b.classList.contains('out') && opacity > .05 && opacity < .95;
  });
  await screenshot(page, `${name}-step-fading`);
  await expect(page.locator('#banner')).toBeHidden({ timeout: 12_000 });
  const samples = await page.evaluate(() => (window as any).__stepBanner as {
    phase: string; opacity: number; visible: boolean; gap: number | null; clipped: string[];
  }[]);
  writeFileSync(`test-results/teaching-${name}-step-layout.json`, JSON.stringify(samples, null, 2));
  expect(samples.some(s => s.phase === 'readable' && s.opacity === 1)).toBe(true);
  expect(samples.some(s => s.phase === 'fading' && s.opacity > 0 && s.opacity < 1)).toBe(true);
  expect(samples.filter(s => s.visible && s.gap! < 4), 'banner and task card must have a 4px gap whenever both are painted').toEqual([]);
  expect(samples.filter(s => s.clipped.length), 'all painted objective text must fit its box and viewport').toEqual([]);
  await expect(page.locator('#objective')).toBeVisible();
  await expect(page.locator('#objective .h')).toHaveText('目标 2/3');
  await expect(page.locator('#objective .g')).toHaveText('打开上锁讲台抽屉，取出楼梯钥匙');
  await expect(page.locator('#objective .got')).toHaveText('已收集：抽屉钥匙 1/1 · 楼梯钥匙 0/1');
  await screenshot(page, `${name}-step-restored`);
}

test('slow real rAF keeps real intro and subsequent step readable through cover and background; H respects text entry', async ({ page }) => {
  const errors: string[] = [];
  const checkpoints: { step: string; at: string; detail?: unknown }[] = [];
  let frozenFrameCount: number | undefined;
  let resumedFrame: { index: number; at: number } | undefined;
  let diagnostics: unknown;
  const windowSnapshots: { step: string; windowId: number; bounds: unknown }[] = [];
  let readableMs: number | null = null;
  const record = (step: string, detail?: unknown) => {
    checkpoints.push({ step, at: new Date().toISOString(), detail });
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/teaching-timing.json', JSON.stringify({ checkpoints, errors, frozenFrameCount,
      resumedFrame, readableMs, windowSnapshots, diagnostics }, null, 2));
  };
  const bounded = async <T>(step: string, run: () => Promise<T>, timeout = 10_000): Promise<T> => {
    record(`${step}:start`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([run(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${step} exceeded ${timeout}ms`)), timeout);
      })]);
      record(`${step}:done`);
      return result;
    } catch (error) {
      record(`${step}:failed`, String(error));
      throw error;
    } finally { clearTimeout(timer); }
  };
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const native = requestAnimationFrame.bind(window);
    (window as any).__teachingRAF = [];
    (window as any).__teachingVisibility = [];
    const focusEvents: unknown[] = [];
    (window as any).__teachingFocus = focusEvents;
    const focusState = () => ({ focused: document.hasFocus(), visibility: document.visibilityState,
      locked: document.pointerLockElement === document.querySelector('body > canvas'),
      lockTarget: document.pointerLockElement?.tagName, hint: document.getElementById('hint')?.className,
      activeElement: { tag: document.activeElement?.tagName, id: document.activeElement?.id } });
    const focusEvent = (type: string, event?: Event) => {
      focusEvents.push({ type, at: performance.now(), ...focusState(), trusted: event?.isTrusted,
        target: (event?.target as Element | null)?.tagName, bubbles: event?.bubbles });
      if (focusEvents.length > 100) focusEvents.shift();
    };
    for (const type of ['focus', 'blur', 'pointerdown', 'click', 'keydown']) {
      addEventListener(type, (event) => focusEvent(`window:${type}`, event), true);
    }
    document.addEventListener('pointerlockchange', (event) => focusEvent('document:pointerlockchange', event));
    document.addEventListener('pointerlockerror', (event) => focusEvent('document:pointerlockerror', event));
    addEventListener('pointerlockchange', (event) => focusEvent('window:pointerlockchange', event));
    document.addEventListener('visibilitychange', () => {
      (window as any).__teachingVisibility.push({ at: performance.now(), state: document.visibilityState });
    });
    window.requestAnimationFrame = (callback) => native(() => {
      setTimeout(() => {
        native((now) => {
          callback(now);
          // Record after the game's draw and HUD update, so render time cannot inflate reading time.
          (window as any).__teachingRAF.push(performance.now());
        });
      }, 450);
    });
    addEventListener('DOMContentLoaded', () => {
      (window as any).__teachingBanner = [];
      const banner = document.getElementById('banner')!;
      new MutationObserver(() => {
        (window as any).__teachingBanner.push({ at: performance.now(), hidden: banner.hidden, out: banner.classList.contains('out') });
      }).observe(banner, { attributes: true, attributeFilter: ['hidden', 'class'] });
      new MutationObserver(() => focusEvent('hint:class')).observe(document.getElementById('hint')!, {
        attributes: true, attributeFilter: ['class'],
      });
    });
  });
  await start(page, true);
  record('spawned');
  await finishIntro(page);
  await page.keyboard.press('Shift');
  await page.waitForFunction(() => window.__escape.game()!.openingComplete);
  await drawerStep(page);
  // Intro already taught the opening goal. Exercise pause/resume on the next real two-second
  // objective step, retaining the full readable interval through both cover and background.
  await overlay(page, 'intro-overlay', true);
  await page.keyboard.press('KeyH');
  await page.waitForTimeout(3600);
  await expect(page.locator('#banner')).toBeHidden();
  await overlay(page, 'intro-overlay', false);
  await expect(page.locator('#banner')).toBeVisible();
  await expect(page.locator('#banner .g')).toHaveText('打开上锁讲台抽屉，取出楼梯钥匙');
  await screenshot(page, 'desktop-opening');
  record('intro completed');
  await overlay(page, 'capture-overlay', true);
  await expect(page.locator('#banner')).toBeHidden();
  await page.waitForTimeout(3600);
  await overlay(page, 'capture-overlay', false);
  await expect(page.locator('#banner')).toBeVisible();
  record('capture completed');
  frozenFrameCount = await page.evaluate(() => {
    (window as any).__teachingBanner = [];
    return (window as any).__teachingRAF.length as number;
  });
  let restoreWindow: (() => Promise<unknown>) | undefined;
  try {
    // Playwright normally emulates the page as focused. Let Chromium report real window visibility.
    const gameFocus = await bounded('game focus session', () => page.context().newCDPSession(page));
    await bounded('disable game focus emulation', () => restoreRealFocus(page));
    await bounded('initial game foreground', () => page.bringToFront());
    await bounded('initial game visible', () => page.waitForFunction(() => document.visibilityState === 'visible',
      undefined, { polling: 100, timeout: 5000 }));
    const { targetInfo } = await bounded('game target info', () => gameFocus.send('Target.getTargetInfo'));
    const gameWindow = await bounded('game window info', () => gameFocus.send('Browser.getWindowForTarget', { targetId: targetInfo.targetId }));
    windowSnapshots.push({ step: 'initial', windowId: gameWindow.windowId, bounds: gameWindow.bounds });
    record('game window identified', { targetId: targetInfo.targetId, windowId: gameWindow.windowId });
    const snapshotWindow = async (step: string) => {
      const { bounds } = await bounded(`${step} window bounds`, () => gameFocus.send('Browser.getWindowBounds', { windowId: gameWindow.windowId }));
      windowSnapshots.push({ step, windowId: gameWindow.windowId, bounds });
      record('window snapshot', { step, windowId: gameWindow.windowId, bounds });
    };
    restoreWindow = () => gameFocus.send('Browser.setWindowBounds', { windowId: gameWindow.windowId, bounds: { windowState: 'normal' } });
    // Minimize only this game's browser window; tab activation does not hide sibling headless windows.
    await bounded('minimize game window', () => gameFocus.send('Browser.setWindowBounds', { windowId: gameWindow.windowId, bounds: { windowState: 'minimized' } }));
    await snapshotWindow('minimized');
    await bounded('game hidden', () => page.waitForFunction(() => document.hidden && document.visibilityState === 'hidden',
      undefined, { polling: 100, timeout: 5000 }));
    record('background interval:start');
    await new Promise((resolve) => setTimeout(resolve, 3600));
    record('background interval:done');
    await bounded('restore game window', restoreWindow);
    await bounded('game foreground', () => page.bringToFront());
    await snapshotWindow('foreground');
    await bounded('game visible', () => page.waitForFunction(() => document.visibilityState === 'visible',
      undefined, { polling: 100, timeout: 5000 }));
    // The actual long frame gap identifies the first resumed frame. A frame from before the
    // background transition cannot accidentally satisfy this wait. Timer polling also diagnoses a stalled rAF.
    resumedFrame = await (await bounded('resumed frame', () => page.waitForFunction((count) => {
      const frames = (window as any).__teachingRAF as number[];
      const index = frames.findIndex((at, i) => i >= count && i > 0 && at - frames[i - 1] >= 3500);
      return index < 0 ? null : { index, at: frames[index] };
    }, frozenFrameCount!, { polling: 100, timeout: 10_000 }))).jsonValue() as { index: number; at: number };
    record('resumed frame measured', resumedFrame);
    await expect(page.locator('#banner')).toBeVisible();
    await expect(page.locator('#banner')).not.toHaveClass(/out/);
    await screenshot(page, 'desktop-resumed');
    // A screenshot can outlast the 600 ms fade on a loaded real renderer. Require the
    // actual DOM transition recorded by the existing observer, even if the fade has ended.
    await expect.poll(() => page.evaluate(at => ((window as any).__teachingBanner as {
      at: number; hidden: boolean; out: boolean;
    }[]).some(entry => entry.at >= at && !entry.hidden && entry.out), resumedFrame!.at), { timeout: 12_000 }).toBe(true);
    const timing = await page.evaluate((at) => {
      const log = (window as any).__teachingBanner as { at: number; hidden: boolean; out: boolean }[];
      const faded = log.find((entry) => entry.at >= at && !entry.hidden && entry.out)!;
      const frames = (window as any).__teachingRAF as number[];
      return { readableMs: faded.at - at, frameGaps: frames.slice(1).map((time, index) => time - frames[index]) };
    }, resumedFrame.at);
    readableMs = timing.readableMs;
    record('readable interval measured', timing);
    expect(timing.readableMs).toBeGreaterThanOrEqual(2000);
    expect(timing.frameGaps.filter((gap) => gap >= 400).length).toBeGreaterThan(5);
    expect(Math.max(...timing.frameGaps)).toBeGreaterThanOrEqual(3500);
  } finally {
    if (restoreWindow) await bounded('cleanup window normal', restoreWindow, 2000).catch(() => {});
    await bounded('cleanup foreground', () => page.bringToFront(), 2000).catch(() => {});
    diagnostics = await bounded('collect diagnostics', () => page.evaluate(() => ({ lifecycle: 'real minimized/restored game window',
      visibility: document.visibilityState, visibilityChanges: (window as any).__teachingVisibility,
      log: (window as any).__teachingBanner, frames: (window as any).__teachingRAF })), 2000).catch((error) => ({ error: String(error) }));
    record('diagnostics saved');
  }
  await expect(page.locator('#banner')).toBeHidden();
  await expect(page.locator('#tut')).toBeVisible();
  const captureState = () => page.evaluate(() => ({ focused: document.hasFocus(),
    locked: document.pointerLockElement === document.querySelector('body > canvas'),
    hintOff: document.getElementById('hint')!.classList.contains('off') }));
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await page.bringToFront();
      await page.locator('body > canvas').click();
      try {
        await expect.poll(captureState, { timeout: 2000,
          message: 'H starts from a focused game canvas with captured mouse and automatically hidden help' })
          .toEqual({ focused: true, locked: true, hintOff: true });
        break;
      } catch (error) {
        const state = await captureState();
        record('H capture attempt failed', { attempt, ...state });
        // A retained capture with a missing help update is a product failure, so never retry it.
        if ((state.focused && state.locked) || attempt === 3) throw error;
      }
    }
    await expect.poll(captureState).toEqual({ focused: true, locked: true, hintOff: true });
    await page.keyboard.press('KeyH');
    await expect(page.locator('#hint')).not.toHaveClass(/off/);
    const chatUnlockAfter = await page.evaluate(() => performance.now());
    await page.keyboard.press('Enter');
    await expect(page.locator('#chat-input')).toBeFocused();
    // Native pointerlockchange is asynchronous; finish the chat unlock before testing its H boundary.
    await page.waitForFunction((after) => ((window as any).__teachingFocus as {
      type: string; at: number; trusted?: boolean; locked: boolean;
    }[]).some((event) => event.at >= after && event.type === 'document:pointerlockchange'
      && event.trusted === true && event.locked === false), chatUnlockAfter);
    await expect.poll(() => page.evaluate(() => document.pointerLockElement === null)).toBe(true);
    await expect(page.locator('#hint')).not.toHaveClass(/off/);
    await page.evaluate(() => document.getElementById('hint')!.classList.add('off'));
    await page.keyboard.type('h');
    await expect(page.locator('#chat-input')).toHaveValue('h');
    await expect(page.locator('#hint')).toHaveClass(/off/);
    await page.keyboard.press('Enter');
    await page.keyboard.press('KeyH');
    await expect(page.locator('#hint')).not.toHaveClass(/off/);
  } finally {
    const focus = await page.evaluate(() => ({ focused: document.hasFocus(), visibility: document.visibilityState,
      lockTarget: document.pointerLockElement?.tagName, hint: document.getElementById('hint')?.className,
      events: (window as any).__teachingFocus })).catch((error) => ({ error: String(error) }));
    writeFileSync('test-results/teaching-focus.json', JSON.stringify(focus, null, 2));
  }
  expect(errors).toEqual([]);
});

test('nearby item highlight breathes, stops at 4m and respects wall depth', async ({ page }) => {
  await start(page);
  const item = await page.evaluate(() => {
    const g = window.__escape.game() as any;
    const item = g.items.find((entry: any) => entry.kind === 'battery');
    // Battery candidates lie along the corridor. Looking across z can put a real wall between camera and item.
    g.view = { x: item.p[0] + 2, y: item.p[1] + 1.2, z: item.p[2], yaw: Math.PI / 2, pitch: -0.45 };
    g.body.y = item.p[1];
    g.input.press('KeyF'); g.input.release('KeyF');
    return { id: item.id, p: item.p as number[] };
  });
  const active = () => page.evaluate((id) => {
    const g = window.__escape.game() as any;
    return g.interactionHighlight.snapshot().active.find((entry: any) => entry.key === `pick:${id}`)?.opacity ?? null;
  }, item.id);
  await expect.poll(active).not.toBeNull();
  const first = await active();
  await expect.poll(active).not.toBe(first);
  const depth = await page.evaluate((id) => {
    const g = window.__escape.game() as any;
    const mesh = g.scene.getObjectByName(`interaction-highlight:pick:${id}`);
    return { depthTest: mesh.material.depthTest, depthWrite: mesh.material.depthWrite };
  }, item.id);
  expect(depth).toEqual({ depthTest: true, depthWrite: false });
  await screenshot(page, 'desktop-highlight');
  await page.evaluate((p) => { (window.__escape.game() as any).view.x = p[0] + 6; }, item.p);
  await expect.poll(active).toBeNull();
  await page.evaluate((p) => {
    const g = window.__escape.game() as any;
    g.campus.collision.add({ minX: p[0] + 0.8, maxX: p[0] + 1, minY: p[1], maxY: p[1] + 3, minZ: p[2] - 1, maxZ: p[2] + 1 });
    g.view.x = p[0] + 2;
  }, item.p);
  await expect.poll(active).toBeNull();
});

test.describe('touch HUD', () => {
  test.use({ viewport: { width: 740, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  test('real intro, objective step and map remain readable with touch controls', async ({ page }) => {
    const picked: number[] = [];
    page.on('websocket', (socket) => socket.on('framesent', (frame) => {
      try {
        const message = JSON.parse(String(frame.payload));
        if (message.t === 'act' && message.kind === 'pick') picked.push(message.id);
      } catch { /* Ignore non-JSON protocol frames. */ }
    }));
    await start(page, true);
    await finishIntro(page, true);
    const pendingBeforeTouch = await page.evaluate(() => (window.__escape.game() as any).objectiveTiming.pending as boolean);
    await page.touchscreen.tap(400, 190);
    await expect(page.locator('#banner')).toBeHidden();
    await expect.poll(() => page.evaluate(() => (window.__escape.game() as any).objectiveTiming.pending)).toBe(false);
    const pendingAfterTouch = await page.evaluate(() => (window.__escape.game() as any).objectiveTiming.pending as boolean);
    expect(pendingAfterTouch).toBe(false);
    await screenshot(page, 'mobile-opening-objective');
    await expect(page.locator('#banner')).toBeHidden({ timeout: 12_000 });
    await expect(page.locator('#objective')).toBeVisible();
    await expect(page.locator('#touch-map')).toBeVisible();
    await expect(page.locator('#objective .g')).toHaveText('找到抽屉钥匙');
    await screenshot(page, 'mobile-objective');
    await page.locator('#touch-map').tap();
    await expect(page.locator('#map')).toBeVisible();
    await screenshot(page, 'mobile-map');
    const boxes = await page.evaluate(() => {
      const ids = ['objective', 'touch-map', 'touch-chat'];
      return ids.map((id) => { const r = document.getElementById(id)!.getBoundingClientRect(); return { id, x: r.x, y: r.y, right: r.right, bottom: r.bottom }; });
    });
    for (const box of boxes) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(740);
      expect(box.bottom).toBeLessThanOrEqual(390);
    }
    await page.locator('#touch-map').tap();
    await expect(page.locator('#map')).toBeHidden();
    const item = await page.evaluate(() => {
      const g = window.__escape.game() as any;
      const item = g.items.find((entry: any) => entry.kind === 'battery');
      window.__escape.debug('tp', item.p[0] + 0.8, item.p[2]);
      return { id: item.id as number, p: item.p as number[] };
    });
    await expect.poll(() => page.evaluate((p) => Math.hypot(window.__escape.game()!.pos.x - p[0] - 0.8,
      window.__escape.game()!.pos.z - p[2]), item.p)).toBeLessThan(0.2);
    await page.evaluate((p) => {
      const g = window.__escape.game()!;
      const dx = p[0] - g.camera.position.x, dz = p[2] - g.camera.position.z;
      g.input.yaw = Math.atan2(-dx, -dz) + 0.45;
      g.input.pitch = Math.atan2(p[1] + 0.03 - g.camera.position.y, Math.hypot(dx, dz));
    }, item.p);
    await page.waitForTimeout(300);
    const point = await page.evaluate((id) => {
      const g = window.__escape.game() as any;
      g.camera.updateMatrixWorld();
      const projected = g.itemMeshes.get(id).position.clone().project(g.camera);
      return { x: (projected.x + 1) * innerWidth / 2, y: (1 - projected.y) * innerHeight / 2 };
    }, item.id);
    expect(point.x).toBeGreaterThan(370);
    expect(point.x).toBeLessThan(740);
    expect(point.y).toBeGreaterThan(0);
    expect(point.y).toBeLessThan(390);
    const yaw = await page.evaluate(() => window.__escape.game()!.input.yaw);
    await page.touchscreen.tap(point.x, point.y);
    await expect.poll(() => page.evaluate((id) => (window.__escape.game() as any).items.some((entry: any) => entry.id === id), item.id)).toBe(false);
    expect(picked).toContain(item.id);
    expect(await page.evaluate(() => window.__escape.game()!.input.yaw)).toBe(yaw);
    await watchStepBanner(page);
    const key = await drawerStep(page, true);
    expect(picked).toContain(key.id);
    await checkStepBanner(page, 'mobile', true);
    writeFileSync('test-results/teaching-touch.json', JSON.stringify({ pendingBeforeTouch, pendingAfterTouch, item, point, picked, yaw, key }, null, 2));
  });
});

for (const viewport of [{ width: 1280, height: 720 }, { width: 844, height: 390 }]) {
  test(`real pickup keeps the objective readable throughout the banner and fade at ${viewport.width}x${viewport.height}`, async ({ browser, baseURL }) => {
    const touch = viewport.width === 844, name = touch ? 'mobile' : 'desktop';
    const context = await browser.newContext({ baseURL, viewport, hasTouch: touch, isMobile: touch,
      deviceScaleFactor: 1, storageState: gateStorageState(baseURL!),
      recordVideo: { dir: 'test-results/teaching-video', size: viewport } });
    const page = await context.newPage();
    const picked: number[] = [];
    page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
      const m = JSON.parse(String(payload));
      if (m.t === 'act' && m.kind === 'pick') picked.push(m.id);
    }));
    try {
      await start(page, false, true);
      await prepareLayoutScene(page);
      if (touch) await page.touchscreen.tap(500, 190);
      else await page.keyboard.press('Shift');
      await page.waitForFunction(() => window.__escape.game()!.openingComplete);
      await watchStepBanner(page);
      const key = await drawerStep(page, touch, true);
      expect(picked).toContain(key.id);
      await checkStepBanner(page, name, touch);
    } finally {
      await context.close();
      await page.video()!.saveAs(`test-results/teaching-${name}-step.webm`);
    }
  });
}
