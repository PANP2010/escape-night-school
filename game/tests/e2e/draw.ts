import type { Page } from '@playwright/test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// Swiftshader draws these scenes at 1-5 fps; with /?nodraw (game.draw = false: full update/interp/animation, no WebGL
// draw, canvas hidden) the same page runs at ~50 fps, so waits, movement and server round trips stop crawling (#185).
// Specs open /?nodraw and only render for screenshots; canvas clicks/taps go to the visible, undrawn canvas.
export const setDraw = (page: Page, on: boolean) =>
  page.evaluate((v) => { (window.__escape.game() as unknown as { draw: boolean }).draw = v; }, on);

// visibility only, still no WebGL draw: clicks/taps hit the canvas (a hidden one gets none) and composite in ~0.2 s
export const showCanvas = (page: Page, on: boolean) =>
  page.evaluate((v) => { (window.__escape.game() as unknown as { renderer: { domElement: HTMLCanvasElement } }).renderer.domElement.style.visibility = v ? '' : 'hidden'; }, on);

export async function clickCanvas(page: Page) {
  // A synchronized chapter intro owns the screen and authority until all voters skip or its deadline expires.
  await page.waitForFunction(() => {
    const g = window.__escape.game() as unknown as { intro?: { active: boolean } } | null;
    return !!g && !g.intro?.active;
  }, null, { timeout: 15_000 });
  await showCanvas(page, true);
  await page.locator('body > canvas').click(); // the game's WebGL canvas, not #map's 2D one
  await page.waitForFunction(() => !!document.pointerLockElement, null, { timeout: 3_000 }).catch(() => {});
  // hiding the locked canvas makes Chrome send one hover mousemove ~0.3 s later whose movement is minus the cursor
  // position (~(-240,-150) px → ~0.5 rad of yaw); swallow it so it cannot turn a view a spec has just aimed (#185)
  await page.evaluate(() => new Promise<void>((resolve) => {
    const c = (window.__escape.game() as unknown as { renderer: { domElement: HTMLCanvasElement } }).renderer.domElement;
    const done = () => { removeEventListener('mousemove', eat, true); resolve(); };
    const eat = (e: MouseEvent) => { if (document.pointerLockElement) { e.stopImmediatePropagation(); done(); } };
    addEventListener('mousemove', eat, true);
    setTimeout(done, 1_500);
    c.style.visibility = 'hidden';
  }));
  // showing then re-hiding the never-drawn canvas can stall swiftshader's frame production for ~10 s (no rAF, so no
  // update: camera.position/target()/#prompt stay stale while the main thread is idle); return once frames tick again so
  // a spec's timed waits measure the game, not the compositor (#190: x-interact's 20 s prompt wait flaked under load)
  await page.evaluate(() => new Promise<void>((resolve) => {
    let n = 0;
    const tick = () => { if (++n >= 3) resolve(); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }));
}

// Screenshot of the current frame with the HUD: a page.screenshot over a drawn swiftshader canvas takes 8-20 s, so render
// the scene ourselves right after the game's own update in a rAF (n renders: the first compiles shaders, mobs.prewarm is
// skipped under nodraw), copy the backbuffer into an <img> laid over the hidden canvas, screenshot, drop the img.
export async function shot(page: Page, path: string, n = 2) {
  const log = (stage: string) => { if (process.env.ESC_DRAW_TRACE) console.log(`[draw ${Date.now()}] ${stage}`); };
  log('shot begin');
  await mkdir(dirname(path), { recursive: true });
  await rm(path, { force: true });
  let last = '';
  let failed = false;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      log(`frame ${attempt} begin`);
      await frame(page, n);
      log('frame done');
      const png = await page.screenshot();
      log('screenshot done');
      // Compare scene pixels across the view, including the floor: a painted centre alone can hide a partly black
      // phone capture. HUD text and real masks must not count as evidence that the scene reached the screenshot.
      const visible = await page.evaluate(async (b64) => {
        const source = document.getElementById('e2e-shot');
        if (!(source instanceof HTMLImageElement)) {
          throw new Error(`#e2e-shot missing or wrong type: ${source?.constructor.name ?? 'null'}`);
        }
        const capture = document.createElement('img');
        capture.src = `data:image/png;base64,${b64}`;
        await capture.decode();
        if (!(capture instanceof HTMLImageElement) || !capture.complete || !capture.naturalWidth) {
          throw new Error(`screenshot img invalid: instanceof=${capture instanceof HTMLImageElement} complete=${capture.complete} natural=${capture.naturalWidth}x${capture.naturalHeight}`);
        }
        const c = document.createElement('canvas'); c.width = 160; c.height = 90;
        const ctx = c.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(source, 0, 0, 160, 90);
        const expectedPixels = ctx.getImageData(0, 0, 160, 90).data;
        const r = source.getBoundingClientRect(), sx = capture.width / innerWidth, sy = capture.height / innerHeight;
        ctx.clearRect(0, 0, 160, 90);
        ctx.drawImage(capture, r.left * sx, r.top * sy, r.width * sx, r.height * sy, 0, 0, 160, 90);
        const actual = ctx.getImageData(0, 0, 160, 90).data;
        const shown = (el: Element) => {
          if (!el.getClientRects().length) return false;
          for (let e: Element | null = el; e; e = e.parentElement) {
            const s = getComputedStyle(e);
            if (s.visibility === 'hidden' || +s.opacity === 0) return false;
          }
          return true;
        };
        const fullMask = ['blink-overlay', 'fade-overlay', 'rotate'].map((id) => document.getElementById(id)).find((el) => {
          if (!el || !shown(el)) return false;
          const b = el.getBoundingClientRect();
          return b.left <= r.left && b.top <= r.top && b.right >= r.right && b.bottom >= r.bottom;
        });
        if (fullMask) {
          // Scene shots retry transient blinks/transitions instead of approving a black capture. Portrait shots
          // intentionally show the rotate gate: require bright pixels where its own text should appear.
          if (fullMask.id !== 'rotate') return { ok: false, mask: fullMask.id };
          const textRects: { rect: DOMRect; rgb: number[] }[] = [];
          const walker = document.createTreeWalker(fullMask, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            if (!walker.currentNode.textContent?.trim()) continue;
            const range = document.createRange(); range.selectNodeContents(walker.currentNode);
            const rgb = getComputedStyle(walker.currentNode.parentElement!).color.match(/[\d.]+/g)!.slice(0, 3).map(Number);
            for (const rect of range.getClientRects()) textRects.push({ rect, rgb });
          }
          let lit = 0;
          // Read each text crop at the screenshot's native resolution. Shrinking a DPR 3 notice to 160×90
          // can erase nearly every glyph stroke, even though the physical screenshot contains clear text.
          for (const { rect: b, rgb } of textRects) {
            const x0 = Math.max(0, Math.floor(b.left * sx)), y0 = Math.max(0, Math.floor(b.top * sy));
            const x1 = Math.min(capture.width, Math.ceil(b.right * sx)), y1 = Math.min(capture.height, Math.ceil(b.bottom * sy));
            if (x1 <= x0 || y1 <= y0) continue;
            c.width = x1 - x0; c.height = y1 - y0;
            ctx.drawImage(capture, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
            const textPixels = ctx.getImageData(0, 0, c.width, c.height).data;
            for (let i = 0; i < textPixels.length; i += 4) {
              if (Math.max(textPixels[i], textPixels[i + 1], textPixels[i + 2]) >= 32 &&
                rgb.every((v, channel) => Math.abs(textPixels[i + channel] - v) <= 64)) lit++;
            }
          }
          return { ok: lit >= 8, mask: fullMask.id, lit };
        }

        const blockers = [...document.querySelectorAll(
          '#hud > :not(#hide-overlay):not(#down-overlay), #hud:not(:has(*)), #down-overlay > *, #map, #touch > :not(.touch-zone), #settings-open, #game-settings, #update-available, #broadcast-keypad',
        )].filter(shown).map((el) => el.getBoundingClientRect());
        const hide = document.getElementById('hide-overlay');
        const slit = hide && shown(hide) && hide.classList.contains('locker') ? hide.getBoundingClientRect() : null;
        const regions = [];
        let expectedLit = 0;
        // Sixteen separate regions prevent a bright upper half, HUD badge, or lamp from excusing a missing floor.
        // The inset avoids the strongest part of the desk/down vignette; locker masks restrict this to their slit.
        for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
          let expected = 0, captured = 0;
          for (let y = 9 + row * 18; y < 27 + row * 18; y++) for (let x = 24 + col * 28; x < 52 + col * 28; x++) {
            const px = r.left + (x + 0.5) * r.width / 160, py = r.top + (y + 0.5) * r.height / 90;
            if (px < 0 || px >= innerWidth || py < 0 || py >= innerHeight) continue;
            if (slit && (py <= slit.top + slit.height * 0.44 || py >= slit.top + slit.height * 0.56)) continue;
            if (blockers.some((b) => px >= b.left - 2 && px <= b.right + 2 && py >= b.top - 2 && py <= b.bottom + 2)) continue;
            const i = (y * 160 + x) * 4;
            if (Math.max(expectedPixels[i], expectedPixels[i + 1], expectedPixels[i + 2]) < 8) continue;
            expected++;
            if (Math.max(actual[i], actual[i + 1], actual[i + 2]) >= 2) captured++;
          }
          expectedLit += expected;
          if (expected) regions.push({ row, col, expected, captured });
        }
        // No evidence is a failed capture too, even if the old centre strip happened to be naturally dark.
        return { ok: expectedLit > 0 && regions.every((a) => a.captured >= a.expected / 4), expectedLit, regions };
      }, png.toString('base64'));
      log(`pixels ${JSON.stringify(visible)}`);
      if (visible.ok) {
        await writeFile(path, png);
        return png;
      }
      last = JSON.stringify(visible);
    }
    throw new Error(`Screenshot scene stayed black after 3 captures (${last})`);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try { await page.evaluate(() => document.getElementById('e2e-shot')?.remove()); }
    catch (error) { if (!failed) throw error; } // teardown must preserve the failing capture's actual stage
  }
}

// shot()'s render step alone (the caller screenshots and removes #e2e-shot): several browsers rendering at once is fine,
// but page.screenshot of several browsers at once came back blank (911 B) for all but one (#186)
export async function frame(page: Page, n = 2) {
  if (!Number.isInteger(n) || n < 1) throw new Error('frame: render count must be a positive integer');
  await page.evaluate(async (k) => {
    const raf = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    let peak = 0;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        document.getElementById('e2e-shot')?.remove();
        console.debug('[frame]', performance.now(), 'before raf');
        await raf();
        console.debug('[frame]', performance.now(), 'before render');
        const g = window.__escape.game() as unknown as { renderer: { domElement: HTMLCanvasElement; render(s: unknown, c: unknown): void }; scene: unknown; camera: unknown };
        const c = g.renderer.domElement;
        for (let i = 0; i < k; i++) g.renderer.render(g.scene, g.camera);
        console.debug('[frame]', performance.now(), 'before dataURL');
        const url = c.toDataURL();
        console.debug('[frame]', performance.now(), 'after dataURL'); // copy in the render task, before WebGL clears its backbuffer
        const img = document.createElement('img'); img.id = 'e2e-shot';
        const r = c.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) throw new Error('frame: game canvas has no visible area');
        Object.assign(img.style, { position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, pointerEvents: 'none' });
        img.src = url;
        c.after(img);
        await img.decode();
        console.debug('[frame]', performance.now(), 'decoded');
        const sample = document.createElement('canvas'); sample.width = 160; sample.height = 90;
        const ctx = sample.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(img, 0, 0, 160, 90);
        const pixels = ctx.getImageData(0, 0, 160, 90).data;
        peak = 0;
        for (let i = 0; i < pixels.length; i += 4) peak = Math.max(peak, pixels[i], pixels[i + 1], pixels[i + 2]);
        if (peak < 8) continue; // a genuinely black backbuffer, even if the page still has a bright HUD
        // load alone is insufficient on a DPR 3 phone: decode, then give layout and paint two separate frames.
        console.debug('[frame]', performance.now(), 'before paint rafs');
        await raf(); await raf();
        console.debug('[frame]', performance.now(), 'after paint rafs');
        return;
      }
      throw new Error(`frame: black render after 3 attempts (brightest channel ${peak})`);
    } catch (error) {
      document.getElementById('e2e-shot')?.remove();
      throw error;
    }
  }, n);
}
