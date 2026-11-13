import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { devices, expect, test, type Page } from '@playwright/test';

const phase = process.env.ESC_VISUAL_PHASE ?? 'after';
const dir = `test-results/visual-atmosphere-${phase}`;
const quantiles = (a: number[]) => {
  a.sort((x, y) => x - y);
  return Object.fromEntries([50, 95, 99].map((p) => [`p${p}`, +(a[Math.min(a.length - 1, Math.floor(a.length * p / 100))] ?? 0).toFixed(2)]));
};
async function place(p: Page, x: number, z: number, yaw: number, pitch = -0.08) {
  await p.evaluate(([x, z]) => window.__escape.debug('tp', x, z), [x, z]);
  await expect.poll(() => p.evaluate(([x, z]) => {
    const g = window.__escape.game()!; return Math.hypot(g.pos.x - x, g.pos.z - z);
  }, [x, z]), { timeout: 15_000 }).toBeLessThan(0.3);
  await p.evaluate(([yaw, pitch]) => {
    const g = window.__escape.game()!; g.input.yaw = yaw; g.input.pitch = pitch; g.light = false;
  }, [yaw, pitch]);
  await p.waitForTimeout(250);
}
async function effect(p: Page, on: boolean) {
  return p.evaluate((on) => {
    const g = window.__escape.game() as any;
    document.dispatchEvent(new CustomEvent('escape:settings-change', { detail: { postprocessing: on } }));
    g.atmosphere?.setEnabled(on);
    return !!g.atmosphere;
  }, on);
}
async function sampleFrames(p: Page) {
  const timing = await p.evaluate(async () => {
    const g = window.__escape.game()!, a: number[] = [], start = performance.now(), f0 = g.renderer.info.render.frame;
    let prev = 0;
    await new Promise<void>((resolve) => {
      const tick = (t: number) => { if (prev) a.push(t - prev); prev = t;
        if (t - start >= 2000) resolve(); else requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    return { intervals: a, elapsedMs: performance.now() - start, renderFrames: g.renderer.info.render.frame - f0,
      draw: g.draw, calls: g.renderer.info.render.calls, triangles: g.renderer.info.render.triangles,
      out: g.campus.out, blackout: g.campus.blackout, eye: g.campus.eye,
      buffer: [g.renderer.domElement.width, g.renderer.domElement.height], css: [innerWidth, innerHeight], pixelRatio: g.renderer.getPixelRatio() };
  });
  expect(timing.draw).toBe(true); expect(timing.renderFrames).toBeGreaterThan(10); expect(timing.intervals.length).toBeGreaterThan(10);
  const observedFps = +(timing.renderFrames / timing.elapsedMs * 1000).toFixed(2);
  return { ...timing, intervals: undefined, samples: timing.intervals.length, frameMs: quantiles(timing.intervals),
    observedFps, budget50FpsOnThisRun: observedFps >= 50 };
}
async function capture(p: Page, label: string, perf = false) {
  await expect(p.locator('#fade-overlay')).toBeHidden();
  await expect.poll(() => p.evaluate(() => document.getElementById('blink-overlay')?.hidden !== false)).toBe(true);
  const png = await p.screenshot({ path: `${dir}/${label}.png` });
  const image = await p.evaluate(async (b64) => {
    const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0);
    let d = ctx.getImageData(0, 0, c.width, c.height).data;
    const roi = (x0: number, y0: number, x1: number, y1: number) => {
      const a: number[] = []; let above22 = 0, clipped = 0;
      for (let y = Math.round(y0 * c.height); y < Math.round(y1 * c.height); y++)
        for (let x = Math.round(x0 * c.width); x < Math.round(x1 * c.width); x++) {
          const i = (y * c.width + x) * 4, l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          a.push(l); if (l >= 22) above22++; if (l >= 250) clipped++;
        }
      a.sort((x, y) => x - y);
      return { mean: +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(2),
        p10: +a[Math.floor(a.length * .1)].toFixed(2), p50: +a[Math.floor(a.length * .5)].toFixed(2),
        p90: +a[Math.floor(a.length * .9)].toFixed(2), readable: +(above22 / a.length).toFixed(3), clipped: +(clipped / a.length).toFixed(5) };
    };
    const pageStats = { frame: roi(0, 0, 1, 1), floor: roi(1 / 3, 2 / 3, 2 / 3, 1),
      wallLeft: roi(.27, .66, .32, .76), wallRight: roi(.68, .66, .73, .76) };
    const g = window.__escape.game() as any, gl = g.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    // One direct capture render outside the timing window; physical canvas pixels exclude every DOM HUD element.
    g.renderer.render(g.scene, g.camera);
    const rawSceneBase64 = g.renderer.domElement.toDataURL('image/png').split(',')[1];
    const world = new Image(); world.src = `data:image/png;base64,${rawSceneBase64}`; await world.decode();
    c.width = world.width; c.height = world.height; ctx.drawImage(world, 0, 0); d = ctx.getImageData(0, 0, c.width, c.height).data;
    const sceneStats = { width: c.width, height: c.height, frame: roi(0, 0, 1, 1), floor: roi(1 / 3, 2 / 3, 2 / 3, 1),
      wallLeft: roi(.27, .66, .32, .76), wallRight: roi(.68, .66, .73, .76) };
    const hud = ['room-code', 'battery', 'prompt', 'objective'].map((id) => {
      const el = document.getElementById(id)!, s = getComputedStyle(el), r = el.getBoundingClientRect();
      return { id, hidden: el.hidden, text: el.textContent, opacity: s.opacity, zIndex: s.zIndex, x: r.x, y: r.y, width: r.width, height: r.height };
    });
    return { ...pageStats, scene: sceneStats, rawSceneBase64,
      renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '',
      calls: g.renderer.info.render.calls, triangles: g.renderer.info.render.triangles, programs: g.renderer.info.programs.length,
      pixelRatio: g.renderer.getPixelRatio(), drawing: g.draw, contextLost: gl.isContextLost(),
      position: [g.pos.x, g.body.y, g.pos.z], yaw: g.input.yaw, pitch: g.input.pitch,
      blackout: g.campus.blackout, out: g.campus.out, eye: g.campus.eye, hud,
      torch: g.light,
      atmosphere: g.atmosphere?.diagnostics ?? null,
    };
  }, png.toString('base64'));
  const { rawSceneBase64, ...metrics } = image;
  writeFileSync(`${dir}/${label}-scene.png`, Buffer.from(rawSceneBase64, 'base64'));
  const timing = perf ? await sampleFrames(p) : null;
  if (timing) expect(timing.out).toBe(metrics.out);
  return { label, ...metrics, timing };
}

test('same-camera lighting, grain/HUD and continuous Metal frames on desktop and phone', async ({ browser, baseURL }) => {
  mkdirSync(dir, { recursive: true });
  const evidence: any = { phase, at: new Date().toISOString(), browser: browser.version(),
    buildRevision: phase === 'baseline' ? '2174268' : execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    samples: [], errors: [], consoleErrors: [] };
  try {
    for (const device of ['desktop', 'phone'] as const) {
      const { defaultBrowserType: _b, ...iphone } = devices['iPhone 13 landscape'];
      const context = await browser.newContext({ ...(device === 'phone' ? iphone : {}), baseURL,
        viewport: device === 'phone' ? { width: 844, height: 390 } : { width: 1280, height: 720 } });
      const p = await context.newPage();
      p.on('pageerror', (e) => evidence.errors.push(e.message));
      p.on('console', (m) => { if (m.type() === 'error') evidence.consoleErrors.push(m.text()); });
      await p.goto('/?steady');
      await p.fill('#name', `视觉${device}`);
      await p.dispatchEvent('#create', 'click');
      await expect(p.locator('#wait-code')).not.toBeEmpty();
      await p.dispatchEvent('#start', 'click');
      await p.waitForFunction(() => window.__escape.game()?.presentationReady, null, { timeout: 60_000 });
      await p.evaluate(() => { window.__escape.debug('safe', 600, 1); window.__escape.debug('safe', 600, 2); });
      await p.waitForTimeout(3500);
      evidence.defaults ??= {};
      evidence.defaults[device] = await p.evaluate(() => (window.__escape.game() as any).atmosphere?.enabled ?? null);
      if (phase !== 'baseline') expect(evidence.defaults[device]).toBe(device === 'desktop');
      else expect(evidence.defaults[device]).toBeNull();
      for (const [spot, x, z, yaw, pitch] of [
        ['l1-5', -56.2, 70.5, Math.PI / 2, -.15], ['l1-lit-back', -62.6, 69.2, -Math.PI / 2, -.12],
      ] as const) {
        await place(p, x, z, yaw, pitch);
        await p.evaluate(() => { const g = window.__escape.game() as any; g.trip = undefined; g.campus.out = 0; });
        await p.waitForFunction(() => { const g = window.__escape.game() as any; return !g.campus.blackout && g.campus.out === 0 && !g.light; });
        if (phase !== 'baseline' && spot === 'l1-5') {
          await effect(p, false);
          await p.evaluate(() => (window.__escape.game() as any).campus.setLandmarks(undefined));
          await p.waitForTimeout(100);
          const unlit = await capture(p, `${device}-${spot}-landmark-off`);
          expect(unlit.out).toBe(0); expect(unlit.blackout).toBe(false); evidence.samples.push(unlit);
          await p.evaluate(() => { const g = window.__escape.game() as any; g.campus.setLandmarks(g.level.def.landmarks); });
          await p.waitForTimeout(100);
        }
        for (const on of phase === 'baseline' ? [false] : [false, true]) {
          const exists = await effect(p, on);
          if (phase !== 'baseline') expect(exists).toBe(true);
          await p.waitForTimeout(100);
          const s = await capture(p, `${device}-${spot}-fx-${on ? 'on' : 'off'}`, spot === 'l1-5');
          expect(s.out).toBe(0); expect(s.blackout).toBe(false); evidence.samples.push(s);
        }
        if (device === 'desktop' && spot === 'l1-5') {
          await p.setViewportSize({ width: 1920, height: 1080 });
          await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
          evidence.perf1080 = [];
          for (const on of phase === 'baseline' ? [false] : [false, true]) {
            await effect(p, on);
            await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
            const timing = await sampleFrames(p); expect(timing.out).toBe(0); expect(timing.blackout).toBe(false);
            evidence.perf1080.push({ effects: on, ...timing });
          }
          await p.setViewportSize({ width: 1280, height: 720 });
          await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        }
      }
      await p.evaluate(() => { window.__escape.debug('key', -1); window.__escape.debug('tp', -61, 66); });
      await p.waitForFunction(() => window.__escape.game()?.level.index === 1, null, { timeout: 30_000 });
      await p.evaluate(() => { window.__escape.debug('safe', 600, 1); window.__escape.debug('safe', 600, 2); });
      await expect(p.locator('#fade-overlay')).toBeHidden({ timeout: 15_000 });
      for (const [spot, x, z, yaw] of [['corridor', 46, 84.2, Math.PI / 2], ['classroom', 36.4, 77.3, -Math.PI / 2]] as const) {
        await place(p, x, z, yaw);
        for (const dark of [false, true]) {
          if (dark) {
            await p.evaluate(() => window.__escape.debug('power', 90));
            await p.waitForFunction(() => { const g = window.__escape.game() as any; return g.campus.out === 1 && g.campus.eye > .97; });
          } else {
            await p.evaluate(() => { const g = window.__escape.game() as any; g.trip = undefined; g.campus.out = 0; });
            await p.waitForFunction(() => { const g = window.__escape.game() as any;
              return g.campus.blackout && g.campus.out === 0 && !g.light && Math.abs(g.campus.eye - .4) < .01;
            });
          }
          for (const on of phase === 'baseline' ? [false] : [false, true]) {
            await effect(p, on); await p.waitForTimeout(100);
            const s = await capture(p, `${device}-l2-${spot}-${dark ? 'darkest' : 'blackout'}-fx-${on ? 'on' : 'off'}`, spot === 'corridor');
            evidence.samples.push(s);
            expect(s.blackout).toBe(true); expect(s.torch).toBe(false); expect(s.out).toBe(dark ? 1 : 0);
            expect(Math.abs(s.eye - (dark ? 1 : .4))).toBeLessThan(dark ? .03 : .01);
            if (dark) {
              expect(s.floor.mean).toBeGreaterThanOrEqual(22); expect(s.frame.mean).toBeLessThanOrEqual(45);
              expect(s.scene.floor.mean).toBeGreaterThanOrEqual(22); expect(s.scene.frame.mean).toBeLessThanOrEqual(45);
              if (spot === 'corridor') expect(s.floor.mean).toBeGreaterThan((s.wallLeft.mean + s.wallRight.mean) / 2 * 1.15);
            }
          }
        }
      }
      if (phase !== 'baseline') {
        // Verify the documented settings bridge independently of the direct A/B helper.
        for (const on of [false, true]) {
          const enabled = await p.evaluate((on) => {
            document.dispatchEvent(new CustomEvent('escape:settings-change', { detail: { postprocessing: on } }));
            return (window.__escape.game() as any).atmosphere.enabled;
          }, on);
          expect(enabled).toBe(on);
        }
        await p.waitForTimeout(100);
        evidence.programSwitches ??= {};
        const compiled = await p.evaluate(() => (window.__escape.game() as any).renderer.info.programs.length);
        evidence.programSwitches[device] = [];
        for (const on of [false, true, false, true]) {
          await effect(p, on); await p.waitForTimeout(100);
          const programs = await p.evaluate(() => (window.__escape.game() as any).renderer.info.programs.length);
          evidence.programSwitches[device].push({ enabled: on, programs }); expect(programs).toBe(compiled);
        }
        if (device === 'desktop') {
          evidence.storage = [];
          for (const on of [false, true]) {
            await p.evaluate((on) => localStorage.setItem('escape.settings', JSON.stringify({ postprocessing: on })), on);
            await p.reload(); await p.fill('#name', '持久化');
            await p.dispatchEvent('#create', 'click'); await expect(p.locator('#wait-code')).not.toBeEmpty();
            await p.dispatchEvent('#start', 'click');
            await p.waitForFunction(() => window.__escape.game()?.presentationReady, null, { timeout: 60_000 });
            const enabled = await p.evaluate(() => (window.__escape.game() as any).atmosphere.enabled);
            evidence.storage.push({ requested: on, enabled }); expect(enabled).toBe(on);
          }
        }
      }
      await context.close();
    }
    expect(evidence.errors).toEqual([]);
    expect(evidence.consoleErrors).toEqual([]);
    for (const s of evidence.samples) { expect(s.renderer).toMatch(/Apple.*Metal|Metal.*Apple/); expect(s.contextLost).toBe(false); }
    if (phase !== 'baseline') {
      evidence.comparisons = [];
      for (const device of ['desktop', 'phone']) {
        const off = evidence.samples.find((s: any) => s.label === `${device}-l1-5-fx-off`);
        const on = evidence.samples.find((s: any) => s.label === `${device}-l1-5-fx-on`);
        const unlit = evidence.samples.find((s: any) => s.label === `${device}-l1-5-landmark-off`);
        expect(on.calls - off.calls).toBe(1); expect(on.triangles - off.triangles).toBe(1);
        expect(off.calls).toBe(unlit.calls); expect(off.triangles).toBe(unlit.triangles);
        expect(on.hud).toEqual(off.hud);
        evidence.comparisons.push({ device, extraCalls: on.calls - off.calls, extraTriangles: on.triangles - off.triangles,
          lightFloorRatio: +(off.scene.floor.mean / unlit.scene.floor.mean).toFixed(3),
          lightWallRatio: +((off.scene.wallLeft.mean + off.scene.wallRight.mean) / (unlit.scene.wallLeft.mean + unlit.scene.wallRight.mean)).toFixed(3),
          hudIdenticalDOM: true });
      }
    }
    evidence.passed = true;
  } finally { writeFileSync(`${dir}/evidence.json`, JSON.stringify(evidence, null, 2)); }
});
