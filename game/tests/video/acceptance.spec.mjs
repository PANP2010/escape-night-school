import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGaitSampler } from '../warden-gait-sampler.mjs';

const gameRoot = fileURLToPath(new URL('../../', import.meta.url));
const output = resolve(gameRoot, process.env.ESC_VIDEO_OUTPUT ?? 'test-results/video-acceptance');
const wait = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));
const viewport = { width: 1280, height: 720 };
const phone = { width: 844, height: 390 };
const only = process.env.ESC_VIDEO_ONLY;
const onlyMobile = only === 'mobile', onlyOpening = only === 'opening';
if (only && !onlyMobile && !onlyOpening) throw new Error('ESC_VIDEO_ONLY supports mobile or opening');
const metrics = frames => {
  const times = frames.map(f => f.t), dt = times.slice(1).map((t, i) => t - times[i]);
  const sorted = [...dt].sort((a, b) => a - b), q = p => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? null;
  return { frames: times.length, spanMs: times.at(-1) - times[0],
    averageFps: (times.length - 1) * 1000 / (times.at(-1) - times[0]),
    intervalMs: { p50: q(.5), p95: q(.95), max: sorted.at(-1) },
    above33_33ms: dt.filter(t => t > 1000 / 30).length,
    above50ms: dt.filter(t => t > 50).length, above100ms: dt.filter(t => t > 100).length,
    estimatedMissed60HzVsync: dt.reduce((n, t) => n + Math.max(0, Math.round(t / (1000 / 60)) - 1), 0),
    estimateNote: '60 Hz reference estimate only; rAF timestamps are measured, encoded video fps is a separate property',
    renderFrameDelta: frames.at(-1)?.renderFrame - frames[0]?.renderFrame,
    repeatedRenderFrameSamples: frames.slice(1).filter((f, i) => f.renderFrame === frames[i].renderFrame).length,
    drawEnabledSamples: frames.filter(f => f.draw).length,
  };
};

async function instrument(page, label) {
  await page.addInitScript(() => {
    window.__videoEvidence = { frames: [], messages: [], marks: [], active: false };
    function sample(t) {
      const p = window.__videoEvidence, g = window.__escape?.game();
      if (p.active && g) {
        const mobs = [...g.mobs.byId].map(([id, m]) => ({ id, anim: m.anim,
          p: m.mesh.position.toArray(), scale: m.mesh.scale.toArray(), monitor: m.monitor }));
        p.frames.push({ t, wall: Date.now(), p: [g.body.x, g.body.y, g.body.z], yaw: g.input.yaw,
          crouch: g.input.down('KeyC') || g.input.down('ControlLeft'), run: g.input.down('ShiftLeft'),
          light: g.light, down: g.down, spectate: g.spectate, corrections: g.corrections,
          calls: g.renderer.info.render.calls, triangles: g.renderer.info.render.triangles,
          renderFrame: g.renderer.info.render.frame, draw: g.draw,
          eye: g.campus.eye, out: g.campus.out, blackout: g.campus.blackout,
          capture: g.captureFrame?.phase, mobs,
          remotes: [...g.remotes].map(([id, r]) => ({ id, p: r.mesh.position.toArray(), yaw: r.mesh.rotation.y,
            flags: r.f, visible: r.mesh.visible, down: r.down })) });
        const teacher = g.mobs.byId.get(1);
        if (teacher && window.__gaitSampler) window.__gaitSampler.add(teacher.warden,
          { time: t / 1000, segment: `${p.segment}:${teacher.anim}` });
      }
      requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.__errors = errors; page.__label = label; page.__created = Date.now();
}
async function context(browser, baseURL, label, mobile = false) {
  const size = mobile ? phone : viewport;
  const ctx = await browser.newContext({ baseURL, viewport: size, deviceScaleFactor: 1,
    // Start touch recording after viewport initialization; automatic recordVideo
    // starts too early and can lock Chromium's initial 800x600 surface scale.
    hasTouch: mobile, isMobile: false,
    ...(mobile ? {} : { recordVideo: { dir: resolve(output, 'raw'), size } }) });
  const p = await ctx.newPage(); await instrument(p, label);
  return { ctx, p };
}
function jpegSize(data) {
  for (let i = 2; i + 8 < data.length;) {
    if (data[i] !== 0xff) throw new Error('Invalid screencast JPEG marker');
    const marker = data[i + 1], length = data.readUInt16BE(i + 2);
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker))
      return { width: data.readUInt16BE(i + 7), height: data.readUInt16BE(i + 5) };
    i += length + 2;
  }
  throw new Error('Screencast JPEG dimensions missing');
}
async function startTouchRecording(page) {
  const file = resolve(output, 'mobile.webm');
  page.__screencast = { file, firstJpeg: resolve(output, 'mobile-first-capture.jpg'), frames: [] };
  page.__created = Date.now();
  await page.screencast.start({ path: file, size: phone, onFrame: frame => {
    const evidence = page.__screencast;
    if (!evidence.frames.length) {
      evidence.firstJpegSize = jpegSize(frame.data);
      writeFileSync(evidence.firstJpeg, frame.data);
    }
    evidence.frames.push({ wall: frame.timestamp, viewportWidth: frame.viewportWidth, viewportHeight: frame.viewportHeight });
  } });
  await expect.poll(() => page.__screencast.frames.length).toBeGreaterThan(0);
  expect(page.__screencast.firstJpegSize).toEqual(phone);
}
async function enter(page, name, code) {
  await page.goto('/'); await page.fill('#name', name);
  if (code) { await page.fill('#code', code); await page.click('#join'); }
  else await page.click('#create');
  await expect(page.locator('#wait-code')).not.toBeEmpty();
  return page.locator('#wait-code').innerText();
}
async function ready(page) {
  await page.waitForFunction(() => window.__escape?.game()?.spawnSynced && window.__escape.game().presentationReady, null, { timeout: 90_000 });
  await page.evaluate(() => {
    const net = window.__escape.net, original = net.onMsg.bind(net);
    net.onMsg = m => { if (['caught', 'correct', 'fade', 'power', 'trip'].includes(m.t)) {
      const { t, forced, by, seq, n, omen, off, at } = m;
      window.__videoEvidence.messages.push({ receivedAt: performance.now(), t, forced, by, seq, n, omen, off, location: at });
    } original(m); };
    window.__escape.debug('safe', 600);
  });
  const source = JSON.parse(readFileSync(resolve(output, 'source.json'), 'utf8'));
  const sourceText = readFileSync(resolve(source.snapshot, 'game/client/src/warden/anim.ts'), 'utf8');
  const literal = sourceText.match(/const SOLE\s*=\s*\{([^}]+)\}/)?.[1];
  if (!literal) throw new Error('Production SOLE definition is missing');
  const sole = Object.fromEntries(literal.split(',').filter(s => s.trim()).map(s => {
    const [k, v] = s.split(':'); return [k.trim(), Number(v)];
  }));
  await page.evaluate(async ({ file, factory, sole }) => {
    const { GAIT } = await import(file);
    window.__gaitSampler = (0, eval)(`(${factory})`)(GAIT, sole);
    const gl = window.__escape.game().renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    window.__videoEvidence.webgl = { vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER),
      unmaskedVendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null,
      unmaskedRenderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null };
  }, { file: `/@fs/${resolve(source.snapshot, 'game/client/src/warden/anim.ts')}`, factory: createGaitSampler.toString(), sole });
}
async function place(page, x, z, yaw = -Math.PI / 2) {
  await page.evaluate(([x, z]) => window.__escape.debug('tp', x, z), [x, z]);
  await page.waitForFunction(([x, z]) => { const g = window.__escape.game(); return Math.hypot(g.body.x - x, g.body.z - z) < .2; }, [x, z]);
  await page.evaluate(yaw => { const g = window.__escape.game(); g.input.yaw = yaw; g.input.pitch = -.08; }, yaw);
}
async function keys(page, down = [], up = []) {
  await page.evaluate(([down, up]) => { const i = window.__escape.game().input; up.forEach(k => i.release(k)); down.forEach(k => i.press(k)); }, [down, up]);
}
async function turn(page, radians, durationMs = 500) {
  await page.evaluate(({ radians, durationMs }) => new Promise(resolve => {
    const input = window.__escape.game().input, start = performance.now(); let previous = 0;
    const step = now => {
      const progress = Math.min(1, (now - start) / durationMs);
      input.look(-radians * (progress - previous) / input.sensitivity, 0); previous = progress;
      if (progress < 1) requestAnimationFrame(step); else resolve();
    };
    requestAnimationFrame(step);
  }), { radians, durationMs });
}
async function mark(page, label) {
  return page.evaluate(label => {
    const tut = document.getElementById('tut'), objective = document.getElementById('objective');
    const m = { label, t: performance.now(), wall: Date.now(),
      tutorial: { hidden: tut?.hidden, text: tut?.textContent }, objective: objective?.textContent };
    window.__videoEvidence.marks.push(m); return m;
  }, label);
}
async function shot(page, tag) {
  const before = await mark(page, `screenshot:${tag}:begin`);
  const file = resolve(output, `${tag}.png`);
  const png = await page.screenshot({ path: file, animations: 'allow' });
  const after = await mark(page, `screenshot:${tag}:end`);
  let luma;
  if (tag.startsWith('l2-') || tag.startsWith('torch-')) luma = await page.evaluate(async b64 => {
    const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0); const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const mean = (x0, y0, x1, y1) => {
      let s = 0, n = 0;
      for (let y = Math.round(y0 * c.height); y < Math.round(y1 * c.height); y++)
        for (let x = Math.round(x0 * c.width); x < Math.round(x1 * c.width); x++) {
          const i = (y * c.width + x) * 4; s += .299 * d[i] + .587 * d[i + 1] + .114 * d[i + 2]; n++;
        }
      return s / n;
    };
    return { whole: mean(0, 0, 1, 1), floor: mean(1 / 3, 2 / 3, 2 / 3, 1),
      wall: (mean(.27, .66, .32, .76) + mean(.68, .66, .73, .76)) / 2 };
  }, png.toString('base64'));
  return { file, before, after, captureMs: after.t - before.t, luma };
}
async function segment(pages, label, actions) {
  for (const p of pages) await p.evaluate(label => { window.__videoEvidence.active = true; window.__videoEvidence.segment = label; }, label);
  const begin = await Promise.all(pages.map(p => mark(p, `${label}:begin`)));
  const start = Date.now(), until = ms => wait(start + ms - Date.now());
  const screenshots = [];
  for (const [at, name, action] of actions) {
    await until(at); await Promise.all(pages.map(p => mark(p, name)));
    const result = await action(); if (result?.file) screenshots.push(result);
  }
  await until(20_000);
  const end = await Promise.all(pages.map(p => mark(p, `${label}:end`)));
  const result = [];
  for (const [i, p] of pages.entries()) {
    const all = await p.evaluate(() => { window.__videoEvidence.active = false;
      return { ...window.__videoEvidence, gait: window.__gaitSampler?.report() }; });
    const frames = all.frames.filter(f => f.t >= begin[i].t && f.t <= end[i].t);
    let travelled = 0;
    for (let j = 1; j < frames.length; j++) {
      // Forced placement/penalty transport is reported separately, never counted as normal movement.
      const d = Math.hypot(frames[j].p[0] - frames[j - 1].p[0], frames[j].p[2] - frames[j - 1].p[2]);
      if (d < .8 && !frames[j].down && !frames[j - 1].down) travelled += d;
    }
    result.push({ label: `${label}/${p.__label}`, begin: begin[i], end: end[i],
      wallDurationMs: end[i].wall - begin[i].wall, metrics: metrics(frames), travelledM: travelled,
      approximateVideoOffsetSeconds: (begin[i].wall - p.__created) / 1000,
      videoOffsetNote: 'Relative to page creation or explicit screencast start wall clock; first encoded frame may start slightly later. Native rAF timestamps remain authoritative.',
      messages: all.messages.filter(m => m.receivedAt >= begin[i].t && m.receivedAt <= end[i].t),
      marks: all.marks.filter(m => m.t >= begin[i].t && m.t <= end[i].t),
      screenshotMarks: screenshots, errors: p.__errors, frames, webgl: all.webgl,
      capture: p.__screencast ? { ...p.__screencast,
        frames: p.__screencast.frames.filter(f => f.wall >= begin[i].wall && f.wall <= end[i].wall),
        note: 'Received native JPEG callbacks; no recorder drop counter is exposed. Encoded output remains 25 fps.' } : undefined,
      display: await p.evaluate(() => ({ viewport: { width: innerWidth, height: innerHeight },
        dpr: devicePixelRatio, coarsePointer: matchMedia('(pointer: coarse)').matches,
        touchPoints: navigator.maxTouchPoints, visibility: document.visibilityState,
        canvas: { width: window.__escape.game().renderer.domElement.width, height: window.__escape.game().renderer.domElement.height } })),
      gait: Object.fromEntries(Object.entries(all.gait ?? {}).filter(([k]) => k.startsWith(label + ':'))),
      coverage: { crouch: frames.some(f => f.crouch), run: frames.some(f => f.run),
        chase: frames.some(f => f.mobs.some(m => m.anim === 'chase')),
        caught: frames.some(f => f.capture === 'caught'),
        yawRange: Math.max(...frames.map(f => f.yaw)) - Math.min(...frames.map(f => f.yaw)),
        maxPeers: Math.max(...frames.map(f => f.remotes.length)) } });
  }
  return result;
}
async function close(record, label) {
  if (record.p.__screencast) {
    await record.p.screencast.stop(); await record.ctx.close(); return record.p.__screencast.file;
  }
  const video = record.p.video(); await record.ctx.close();
  const file = resolve(output, `${label}.webm`); await video.saveAs(file); return file;
}

test('real-time desktop, touch, peers, light and opening evidence', async ({ browser, baseURL }) => {
  mkdirSync(output, { recursive: true });
  const report = { source: JSON.parse(readFileSync(resolve(output, 'source.json'), 'utf8')),
    startedAt: new Date().toISOString(), network: 'loopback; no bandwidth throttling or loss injection; no latency simulation',
    renderer: 'headless Chromium ANGLE Metal; one browser, independent contexts; --mute-audio',
    timing: 'real wall clock and native rAF; no virtual time, replay, __step, nodraw or motion speed changes',
    encodedVideoFps: 'Playwright WebM encoder metadata must be inspected separately; never used as game FPS',
    externalReview: 'No Gemini tool exposed; no external score obtained', segments: [], videos: [] };
  report.selection = onlyMobile ? 'mobile only; recovery of cropped mobile WebM'
    : onlyOpening ? 'opening only; show each tutorial step before performing its action' : 'all';
  report.touchEmulation = 'Chromium 844x390, DPR 1, hasTouch=true, isMobile=false; coarse pointer verified in display metadata';
  const flush = () => writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const records = [];
  try {
    if (!only) {
    const desktop = await context(browser, baseURL, 'desktop'); records.push(desktop);
    await enter(desktop.p, '桌面验收'); await desktop.p.click('#start'); await ready(desktop.p);
    await place(desktop.p, -48, 73.4);
    report.segments.push(...await segment([desktop.p], 'desktop-walk-run-chase', [
      [0, 'walk', () => keys(desktop.p, ['KeyW'])],
      [2900, 'run-back', () => keys(desktop.p, ['KeyS', 'ShiftLeft'], ['KeyW'])],
      [4800, 'crouch-forward', () => keys(desktop.p, ['KeyW', 'KeyC'], ['KeyS', 'ShiftLeft'])],
      [6700, 'stop-turn', async () => { await keys(desktop.p, [], ['KeyW', 'KeyC']); await desktop.p.evaluate(() => { window.__escape.game().input.yaw -= .7; }); }],
      [8000, 'chase-summon', () => desktop.p.evaluate(() => { window.__escape.game().input.yaw = -Math.PI / 2; window.__escape.debug('warden', 8); })],
      [8400, 'chase-frame', () => shot(desktop.p, 'desktop-chase')],
      [8900, 'retreat', () => keys(desktop.p, ['KeyS'])],
      [10500, 'stop-for-capture', () => keys(desktop.p, [], ['KeyS'])],
      [14300, 'penalty-frame', () => shot(desktop.p, 'desktop-penalty')],
    ]));
    report.videos.push(await close(desktop, 'desktop')); records.pop(); flush();
    }

    if (!onlyOpening) {
    const mobile = await context(browser, baseURL, 'mobile', true); records.push(mobile);
    await enter(mobile.p, '手机验收'); await mobile.p.click('#start'); await ready(mobile.p);
    expect(await mobile.p.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    expect(await mobile.p.evaluate(() => [innerWidth, innerHeight])).toEqual([phone.width, phone.height]);
    await place(mobile.p, -48, 73.4);
    await startTouchRecording(mobile.p);
    const cdp = await mobile.ctx.newCDPSession(mobile.p);
    const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y]) => ({ x, y, id: 1 })) });
    const stick = async dy => { await touch('touchStart', [[110, 280]]); await touch('touchMove', [[110, 280 + dy]]); };
    const release = () => touch('touchEnd', []);
    const button = text => mobile.p.locator('.touch-btn').filter({ hasText: new RegExp(`^${text}$`) }).tap();
    report.segments.push(...await segment([mobile.p], 'mobile-landscape', [
      [0, 'touch-walk', () => stick(-35)], [2600, 'touch-stop', release],
      [3000, 'touch-crouch', () => button('蹲')], [3300, 'touch-crouch-walk', () => stick(35)],
      [5100, 'touch-stop-crouch', release], [5500, 'touch-stand', () => button('蹲')],
      [5800, 'touch-run', () => stick(-60)], [7600, 'touch-run-stop', release],
      [8200, 'touch-look', async () => { await touch('touchStart', [[560, 180]]); await touch('touchMove', [[650, 180]]); await release(); }],
      [9000, 'touch-torch', () => button('手电')], [10400, 'mobile-frame', () => shot(mobile.p, 'mobile-motion')],
      [12500, 'touch-map', () => mobile.p.locator('#touch-map').tap()], [14000, 'mobile-map-frame', () => shot(mobile.p, 'mobile-map')],
      [16000, 'touch-close-map', () => mobile.p.locator('#touch-map').tap()],
    ]));
    report.videos.push(await close(mobile, 'mobile')); records.pop(); flush();
    }

    if (!only) {
    const peerA = await context(browser, baseURL, 'peer-A'), peerB = await context(browser, baseURL, 'peer-B'); records.push(peerA, peerB);
    const code = await enter(peerA.p, '互看甲'); await enter(peerB.p, '互看乙', code);
    await expect(peerA.p.locator('#wait-members li')).toHaveCount(2); await peerA.p.click('#start');
    await Promise.all([peerA.p, peerB.p].map(ready));
    await place(peerA.p, -47, 73.4, -Math.PI / 2); await place(peerB.p, -40, 73.4, Math.PI / 2);
    report.segments.push(...await segment([peerA.p, peerB.p], 'two-peer-motion', [
      [0, 'peer-B-walk', () => keys(peerB.p, ['KeyW'])],
      [900, 'peer-B-stop', () => keys(peerB.p, [], ['KeyW'])],
      [2400, 'peer-B-turn', () => peerB.p.evaluate(() => { window.__escape.game().input.yaw -= Math.PI; })],
      [3400, 'peer-B-crouch-back', () => keys(peerB.p, ['KeyS', 'KeyC'])],
      [4600, 'peer-B-stop-stand', () => keys(peerB.p, [], ['KeyS', 'KeyC'])],
      [5500, 'peer-B-run', () => keys(peerB.p, ['KeyW', 'ShiftLeft'])],
      [6500, 'peer-B-run-stop', () => keys(peerB.p, [], ['KeyW', 'ShiftLeft'])],
      [7500, 'peer-A-approach', () => keys(peerA.p, ['KeyW'])],
      [8500, 'peer-A-stop', () => keys(peerA.p, [], ['KeyW'])],
      [8800, 'peer-A-turn', () => turn(peerA.p, .8)],
      [9500, 'peer-B-look-back', () => peerB.p.evaluate(() => { window.__escape.game().input.yaw -= Math.PI; })],
      [9700, 'peer-A-return-look', () => turn(peerA.p, -.8)],
      [10500, 'peer-A-frame', () => shot(peerA.p, 'peers-A')], [11200, 'peer-B-frame', () => shot(peerB.p, 'peers-B')],
      [12500, 'peer-A-crouch', () => keys(peerA.p, ['KeyC'])],
      [14500, 'peer-A-stand-torch', async () => { await keys(peerA.p, [], ['KeyC']); await peerA.p.keyboard.press('KeyF'); }],
    ]));
    report.videos.push(await close(peerA, 'peer-A'), await close(peerB, 'peer-B')); records.splice(-2); flush();

    const light = await context(browser, baseURL, 'light'); records.push(light);
    await enter(light.p, '光照验收'); await light.p.click('#start'); await ready(light.p);
    await place(light.p, -45.15, 73.4, 0);
    report.segments.push(...await segment([light.p], 'flashlight-sweep', [
      [1000, 'light-off-frame', () => shot(light.p, 'torch-off')],
      [3000, 'torch-on', () => light.p.keyboard.press('KeyF')],
      [4500, 'light-on-frame', () => shot(light.p, 'torch-on')],
      [6000, 'sweep-left', () => turn(light.p, -.5, 1500)],
      [8000, 'sweep-right', () => turn(light.p, 1, 3000)],
      [14000, 'torch-off', () => light.p.keyboard.press('KeyF')],
      [16000, 'torch-on-again', () => light.p.keyboard.press('KeyF')],
    ]));
    await light.p.evaluate(() => { window.__escape.debug('key', -1); window.__escape.debug('tp', -61, 66); });
    await light.p.waitForFunction(() => window.__escape.game().level.index === 1 && window.__escape.game().spawnSynced, null, { timeout: 60_000 });
    await light.p.evaluate(() => { window.__escape.debug('safe', 600, 1); window.__escape.debug('safe', 600, 2); window.__escape.game().light = false; });
    await expect(light.p.locator('#fade-overlay')).toBeHidden({ timeout: 30_000 });
    await place(light.p, 46, 84.2, Math.PI / 2);
    report.segments.push(...await segment([light.p], 'L2-dark-adaptation', [
      [1500, 'ordinary-blackout-frame', () => shot(light.p, 'l2-ordinary')],
      [4000, 'trip', () => light.p.evaluate(() => window.__escape.debug('power', 6))],
      [5700, 'trip-dark-frame', () => shot(light.p, 'l2-first-dark')],
      [7200, 'adapted-frame', () => shot(light.p, 'l2-adapted')],
      [14000, 'restored-frame', () => shot(light.p, 'l2-restored')],
    ]));
    report.videos.push(await close(light, 'light-and-L2')); records.pop(); flush();
    }

    if (!onlyMobile) {
    const intro = await context(browser, baseURL, 'opening'); records.push(intro);
    await enter(intro.p, '初次来校'); await intro.p.click('#start'); await ready(intro.p);
    await intro.p.evaluate(() => { const g = window.__escape.game(); g.input.yaw = Math.PI / 2; g.input.pitch = -.08; });
    report.segments.push(...await segment([intro.p], 'opening-guidance', [
      [100, 'opening-frame', () => shot(intro.p, 'opening-objective')],
      [1000, 'first-walk', () => keys(intro.p, ['KeyW'])],
      [2200, 'first-stop', () => keys(intro.p, [], ['KeyW'])],
      [3500, 'operation-1-frame', async () => {
        await expect(intro.p.locator('#tut')).toBeVisible();
        await expect(intro.p.locator('#tut .n')).toHaveText('操作 1/4');
        return shot(intro.p, 'opening-step-1');
      }],
      [4000, 'wait-operation-2', async () => {
        await expect(intro.p.locator('#tut .n')).toHaveText('操作 2/4', { timeout: 6500 });
        await expect(intro.p.locator('#tut')).toBeVisible();
        return shot(intro.p, 'opening-step-2');
      }],
      [7000, 'first-torch', () => intro.p.keyboard.press('KeyF')],
      [8000, 'wait-operation-3', async () => {
        await expect(intro.p.locator('#tut .n')).toHaveText('操作 3/4', { timeout: 6500 });
        await expect(intro.p.locator('#tut')).toBeVisible();
        await intro.p.evaluate(() => { window.__escape.game().input.yaw = 0; });
        await expect(intro.p.locator('#prompt')).toContainText('E 打开', { timeout: 2000 });
        return shot(intro.p, 'opening-step-3');
      }],
      [11000, 'first-door', async () => {
        await intro.p.keyboard.press('KeyE');
        await expect(intro.p.locator('#prompt')).toContainText('E 关上', { timeout: 2000 });
      }],
      [12000, 'wait-operation-4', async () => {
        await expect(intro.p.locator('#tut .n')).toHaveText('操作 4/4', { timeout: 6500 });
        await expect(intro.p.locator('#tut')).toBeVisible();
        return shot(intro.p, 'opening-step-4');
      }],
      [15000, 'open-map', async () => {
        await intro.p.keyboard.press('KeyM'); await expect(intro.p.locator('#map')).toBeVisible();
      }],
      [16000, 'map-frame', () => shot(intro.p, 'opening-map')],
      [18000, 'close-map', () => intro.p.keyboard.press('KeyM')],
    ]));
    report.videos.push(await close(intro, 'opening')); records.pop();
    }
  } catch (error) {
    report.failure = { message: error.message, stack: error.stack, at: new Date().toISOString() };
    throw error;
  } finally {
    for (const record of records) {
      if (record.p.__screencast) await record.p.screencast.stop().catch(() => {});
      await record.ctx.close().catch(() => {});
    }
    report.finishedAt = new Date().toISOString(); flush();
  }
  for (const s of report.segments) {
    expect(s.metrics.frames, s.label).toBeGreaterThan(200);
    expect(s.metrics.averageFps, s.label).toBeGreaterThanOrEqual(30);
    expect(s.metrics.renderFrameDelta, s.label + ' rendered frames').toBeGreaterThan(500);
    expect(s.metrics.drawEnabledSamples, s.label + ' drawing enabled').toBe(s.metrics.frames);
    expect(s.webgl.unmaskedRenderer, s.label).toContain('Metal');
    expect(s.wallDurationMs, s.label).toBeGreaterThanOrEqual(19_900);
    expect(s.errors, s.label).toEqual([]);
  }
  expect(report.segments.map(s => s.label)).toEqual(onlyMobile ? ['mobile-landscape/mobile']
    : onlyOpening ? ['opening-guidance/opening'] : [
    'desktop-walk-run-chase/desktop', 'mobile-landscape/mobile', 'two-peer-motion/peer-A',
    'two-peer-motion/peer-B', 'flashlight-sweep/light', 'L2-dark-adaptation/light', 'opening-guidance/opening',
  ]);
  const desktop = report.segments.find(s => s.label.startsWith('desktop-walk-run-chase'));
  if (desktop) {
    expect(desktop.travelledM).toBeGreaterThan(10);
    expect(desktop.coverage.run && desktop.coverage.crouch && desktop.coverage.chase && desktop.coverage.caught).toBe(true);
  }
  const mobile = report.segments.find(s => s.label.startsWith('mobile-landscape'));
  if (mobile) { expect(mobile.travelledM).toBeGreaterThan(5); expect(mobile.coverage.crouch && mobile.coverage.run).toBe(true); }
  const peers = report.segments.filter(s => s.label.startsWith('two-peer-motion'));
  expect(peers).toHaveLength(only ? 0 : 2); for (const p of peers) {
    expect(p.coverage.maxPeers).toBe(1);
    const samples = p.frames.flatMap(f => f.remotes);
    expect(samples.some(r => r.flags & 1), p.label + ' sees peer crouch').toBe(true);
    const xs = samples.map(r => r.p[0]), yaws = samples.map(r => r.yaw);
    expect(Math.max(...xs) - Math.min(...xs), p.label + ' sees peer move').toBeGreaterThan(.5);
    expect(Math.max(...yaws) - Math.min(...yaws), p.label + ' sees peer turn').toBeGreaterThan(.5);
  }
  const opening = report.segments.find(s => s.label.startsWith('opening-guidance'));
  if (opening) for (const n of [1, 2, 3, 4])
    expect(opening.marks.some(m => m.tutorial?.text?.includes(`操作 ${n}/4`)), `opening shows step ${n}`).toBe(true);
});
