// Real-server jasmine evidence. Run only through parallel_sprint.py gate browser.
// node tests/shot-jasmine.mjs baseline --own-server
import { chromium } from '@playwright/test';
import { browserArgs } from './browser-args.mjs';
import { assertDebugAvailable } from './helpers.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const JASMINE_VIEWS = [
  { name: 'desktop', viewport: { width: 1280, height: 720 }, hasTouch: false, isMobile: false },
  { name: 'mobile', viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true },
];
export async function jasmineState(page) {
  return page.evaluate(() => {
    const g = window.__escape.game(), el = document.getElementById('jasmine'), s = getComputedStyle(el);
    const w = [...g.mobs.byId.values()].find((o) => !o.monitor), last = window.__jasmineSnap;
    const sw = last?.mobs?.find((o) => o.id === 1), me = last?.players?.find((p) => p.id === g.myId);
    const ac = g.sound.context, beds = g.sound.beds;
    return {
      wd: w ? w.mesh.position.distanceTo(g.camera.position) : null,
      snapDistance: sw && me ? Math.hypot(sw.p[0] - me.p[0], sw.p[1] - me.p[1] - g.eye, sw.p[2] - me.p[2]) : null,
      camera: g.camera.position.toArray(), player: me?.p, warden: w?.mesh.position.toArray(), serverWarden: sw?.p,
      anim: w?.anim, level: g.level.index, lvl: g.jasmine.lvl, opacity: Number(s.opacity), visibility: s.visibility, mask: s.maskImage,
      bgSize: s.backgroundSize, bg: s.backgroundImage.slice(0, 45), z: s.zIndex, hudZ: getComputedStyle(document.getElementById('hud')).zIndex,
      afterCanvas: !!(g.renderer.domElement.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING),
      draw: g.draw, down: g.down, out: g.campus.out, trip: !!g.trip,
      audio: { state: ac?.state, active: g.sound.frame.active, threat: g.sound.frame.threat, near: beds?.near.gain.gain.value, beat: beds?.beat.gain.gain.value },
      overlayCount: document.querySelectorAll('#jasmine').length, fakeShot: !!document.getElementById('e2e-shot'),
      tile: s.backgroundImage.startsWith('url("data:') ? s.backgroundImage.slice(5, -2) : null,
    };
  });
}
export async function prepareJasminePage(browser, base, view, { withTeammate = false } = {}) {
  const { name: _name, ...device } = view;
  const context = await browser.newContext({ ...device, deviceScaleFactor: 1 });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${base}/?steady`);
  await page.fill('#name', '香水验证'); await page.click('#create');
  // A downed-state capture needs another live player; the last solo player correctly
  // wipes immediately instead of remaining in the rescue presentation.
  let teammate;
  if (withTeammate) {
    await page.waitForFunction(() => !!window.__escape.code);
    const code = await page.evaluate(() => window.__escape.code);
    teammate = new WebSocket(base.replace(/^http/, 'ws') + '/ws');
    context.on('close', () => teammate.close());
    let id = -1, incarnation = 0, ready = 0;
    teammate.on('message', data => {
      const message = JSON.parse(String(data));
      if (message.t === 'welcome') id = message.id;
      if (message.t === 'room' && message.started) incarnation = message.incarnation;
      if (message.t === 'event' && message.kind === 'intro' && !message.ended)
        teammate.send(JSON.stringify({ t: 'intro-skip', id: message.id }));
      if (message.t === 'snap' && incarnation && ready !== incarnation && message.players.some(player => player.id === id && (player.st ?? 0) === 0)) {
        ready = incarnation; teammate.send(JSON.stringify({ t: 'ready', incarnation }));
      }
    });
    await new Promise((resolve, reject) => { teammate.once('open', resolve); teammate.once('error', reject); });
    teammate.send(JSON.stringify({ t: 'hello', name: '香水救援队友' }));
    teammate.send(JSON.stringify({ t: 'join', code }));
    await page.waitForFunction(() => document.querySelectorAll('#wait-members li').length === 2);
  }
  await page.click('#start');
  await page.waitForSelector('#hud:not([hidden])', { timeout: 45_000 });
  await page.waitForFunction(() => {
    const g = window.__escape.game(); return g?.presentationReady && !g.intro.active && g.snaps > 8;
  }, null, { timeout: 45_000 });
  await assertDebugAvailable(page);
  await page.evaluate(() => {
    const e = window.__escape, g = e.game(), receive = e.net.onMsg;
    e.net.onMsg = (m) => { if (m.t === 'snap') window.__jasmineSnap = m; receive(m); };
    // These optical fixtures keep the player still. Coalesce only redundant idle pose
    // inputs to 5 Hz so real server debug placement can coexist with flood protection.
    // All snapshots, authoritative corrections and other messages stay untouched.
    const send = e.net.send.bind(e.net);
    let inputAt = -Infinity;
    e.net.send = message => {
      if (message.t === 'input') {
        const now = performance.now();
        if (now - inputAt < 200) return;
        inputAt = now;
      }
      send(message);
    };
    e.debug('safe', 600); e.debug('safe', 600, 1); e.debug('safe', 600, 2); e.debug('tp', -43.855, 73.36, 0);
    g.input.yaw = -Math.PI / 2; g.input.pitch = -0.08; g.light = false; g.draw = true;
  });
  await page.keyboard.press('KeyH'); // trusted gesture unlocks the unified Sound graph; Chromium is muted.
  await page.waitForFunction(() => window.__jasmineSnap?.players?.some((p) => Math.abs(p.p[0] + 43.855) < 0.05), null, { timeout: 15_000 });
  return { page, context, errors, teammate };
}
export async function placeJasmine(page, distance) {
  await page.evaluate((d) => {
    clearInterval(window.__jasminePlacement);
    const e = window.__escape, g = e.game(); g.input.yaw = -Math.PI / 2; g.input.pitch = -0.08;
    // Server debug d is horizontal; the FX receives camera-to-feet 3D distance. Safe removes prey,
    // but follow() still walks toward the nearest nav node, which can be farther from the player.
    // Use the real server snapshot as feedback instead of assuming every first step closes the gap.
    let command = Math.sqrt(Math.max(0, d * d - g.eye * g.eye)), observedTick = -1;
    const place = () => {
      const snap = window.__jasmineSnap, sw = snap?.mobs?.find((o) => o.id === 1), me = snap?.players?.find((p) => p.id === g.myId);
      if (sw && me && snap.tick !== observedTick) {
        observedTick = snap.tick;
        const horizontal = Math.hypot(sw.p[0] - me.p[0], sw.p[2] - me.p[2]);
        // Ignore the prior distance case's in-flight snapshot; every genuine follow step is <= .23 m.
        if (Math.abs(horizontal - command) < 1.2) {
          const actual = Math.hypot(horizontal, sw.p[1] - me.p[1] - g.eye);
          const correction = Math.max(-0.04, Math.min(0.04, (actual - d) * 0.12));
          command = Math.max(1.5, command - correction);
        }
      }
      e.debug('warden', command); e.debug('safe', 600, 1);
    };
    // 20 debug commands + 5 idle inputs per second fit the actual 30-message limit.
    // The old 60 ms triple loop was a flood and invalidated the optical measurement.
    place(); window.__jasminePlacement = setInterval(place, 100);
  }, distance);
  await page.waitForFunction((d) => {
    const g = window.__escape.game(), w = [...g.mobs.byId.values()].find((o) => !o.monitor);
    const snap = window.__jasmineSnap, sw = snap?.mobs?.find((o) => o.id === 1), me = snap?.players?.find((p) => p.id === g.myId);
    if (!w || !sw || !me) return false;
    const wd = w.mesh.position.distanceTo(g.camera.position);
    const sd = Math.hypot(sw.p[0] - me.p[0], sw.p[1] - me.p[1] - g.eye, sw.p[2] - me.p[2]);
    return Math.abs(wd - d) < 0.3 && Math.abs(sd - d) < 0.3;
  }, distance, { timeout: 20_000 }).catch(async (error) => { console.log('PLACEMENT FAILURE', JSON.stringify(await jasmineState(page))); throw error; });
  await page.waitForTimeout(2200);
  // A real first summon can trigger power failure; wait for the real event to recover.
  await page.waitForFunction(() => { const g = window.__escape.game(); return !g.trip && g.campus.out === 0; }, null, { timeout: 35_000 });
  const state = await jasmineState(page);
  if (Math.abs(state.wd - distance) > 0.3 || Math.abs(state.snapDistance - distance) > 0.3) throw new Error(`Placement drift ${distance}m: ${JSON.stringify(state)}`);
  return state;
}

/** Same genuine rendered background with scent hidden/shown. Stop only rendering, so the server,
 * interpolation, complete monster model and JasmineFx.update continue to run normally. */
export async function captureJasminePair(page, prefix, distance) {
  const previous = await page.evaluate(() => {
    const g = window.__escape.game(), el = document.getElementById('jasmine');
    const prior = { drawOn: g.drawOn, visibility: el.style.visibility };
    g.drawOn = false; // the public draw setter would hide the real WebGL canvas
    return prior;
  });
  const frames = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const hudRects = () => page.evaluate(() => [...document.querySelectorAll('#hud > *, #touch-base, #touch-btns, #touch-chat, #touch-map')]
    .filter((el) => !el.hidden && getComputedStyle(el).display !== 'none')
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width && r.height && r.width * r.height < innerWidth * innerHeight / 2)
    .map(({ left, right, top, bottom }) => ({ left, right, top, bottom })));
  const pair = {};
  try {
    for (const [name, visibility] of [['off', 'hidden'], ['on', previous.visibility]]) {
      await page.evaluate((value) => { document.getElementById('jasmine').style.visibility = value; }, visibility);
      await frames();
      const { tile: _tile, ...state } = await jasmineState(page);
      if (Math.abs(state.wd - distance) > 0.3 || Math.abs(state.snapDistance - distance) > 0.3) throw new Error(`Pair moved away from ${distance}m: ${JSON.stringify(state)}`);
      const path = `${prefix}-${name}.png`;
      const before = await hudRects();
      await page.screenshot({ path, timeout: 30_000, animations: 'disabled' });
      pair[name] = { path, ...state, hudRects: [...before, ...await hudRects()] };
    }
  } finally {
    await page.evaluate((prior) => {
      const g = window.__escape.game(), el = document.getElementById('jasmine');
      el.style.visibility = prior.visibility; g.drawOn = prior.drawOn;
    }, previous);
  }
  return pair;
}

/** Compare real composited pixels, including the straight edge midpoints that the old mask missed.
 * Keep HUD rectangles out of the measurement; they deliberately paint above the scent. */
export async function jasminePixels(page, pair) {
  return page.evaluate(async ({ off, on, hud }) => {
    const load = async (data) => {
      const img = new Image(); img.src = `data:image/png;base64,${data}`; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0);
      return { w: img.width, h: img.height, pixels: ctx.getImageData(0, 0, c.width, c.height).data };
    };
    const a = await load(off), b = await load(on);
    const regions = Object.fromEntries(['centre', 'rim', 'top', 'bottom', 'left', 'right'].map((name) => [name, { count: 0, changed: 0, energy: 0, max: 0 }]));
    // Use the union from before/after both captures. Genuine debug lines can change length, and
    // screenshot's animation fast-forward can set their current opacity to zero after they painted.
    const add = (region, delta) => { region.count++; region.changed += delta >= 6 ? 1 : 0; region.energy += delta; region.max = Math.max(region.max, delta); };
    for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) {
      if (hud.some((r) => x >= r.left - 2 && x < r.right + 2 && y >= r.top - 2 && y < r.bottom + 2)) continue;
      const nx = (x + 0.5) / a.w * 2 - 1, ny = (y + 0.5) / a.h * 2 - 1, radius = Math.hypot(nx, ny), i = (y * a.w + x) * 4;
      const delta = Math.max(...[0, 1, 2].map((c) => Math.abs(a.pixels[i + c] - b.pixels[i + c])));
      if (radius < 0.5) add(regions.centre, delta);
      if (radius > 0.9) add(regions.rim, delta);
      if (Math.abs(nx) < 0.25 && ny < -0.9) add(regions.top, delta);
      if (Math.abs(nx) < 0.25 && ny > 0.9) add(regions.bottom, delta);
      if (Math.abs(ny) < 0.25 && nx < -0.9) add(regions.left, delta);
      if (Math.abs(ny) < 0.25 && nx > 0.9) add(regions.right, delta);
    }
    return Object.fromEntries(Object.entries(regions).map(([name, r]) => [name, { ...r, mean: r.energy / Math.max(1, r.count) }]));
  }, {
    off: (await readFile(pair.off.path)).toString('base64'), on: (await readFile(pair.on.path)).toString('base64'),
    hud: [...pair.off.hudRects, ...pair.on.hudRects],
  });
}

export async function captureJasmine(browser, base, tag, options = {}) {
  const out = `test-results/${tag}`; await mkdir(out, { recursive: true });
  const report = { tag, base, args: browserArgs(['--mute-audio']), views: [] };
  for (const view of options.views ?? JASMINE_VIEWS) {
    const { page, context, errors } = await prepareJasminePage(browser, base, view);
    const row = { device: view.name, viewport: view.viewport, samples: [], errors }; report.views.push(row);
    try {
      for (const d of options.distances ?? [17, 14, 8, 3]) {
        const { tile, ...state } = await placeJasmine(page, d), path = `${out}/${view.name}-${d}m.png`;
        await page.screenshot({ path, timeout: 30_000, animations: 'disabled' });
        const after = await jasmineState(page);
        if (Math.abs(after.wd - d) > 0.3 || Math.abs(after.snapDistance - d) > 0.3) throw new Error(`Screenshot moved away from ${d}m`);
        const pair = options.pairs === false ? undefined : await captureJasminePair(page, `${out}/${view.name}-${d}m`, d);
        const pixels = pair ? await jasminePixels(page, pair) : undefined;
        row.samples.push({ target: d, ...state, afterDistance: after.wd, path, pair, pixels });
        if (tile) await writeFile(`${out}/${view.name}-${d}m-tile.png`, Buffer.from(tile.split(',')[1], 'base64'));
        console.log('JASMINE', view.name, d, JSON.stringify({ ...state, pixels }));
      }
    } finally {
      await page.evaluate(() => clearInterval(window.__jasminePlacement)).catch(() => {});
      await context.close(); await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
    }
  }
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = 4416, base = `http://127.0.0.1:${port}`, tag = process.argv[2] ?? 'jasmine'; let server, browser;
  try {
    if (process.argv.includes('--own-server')) {
      server = spawn(process.execPath, ['dist-server/index.js'], { env: { ...process.env, PORT: String(port), NODE_ENV: 'development' }, stdio: ['ignore', 'pipe', 'pipe'] });
      server.stdout.on('data', (b) => process.stdout.write(b)); server.stderr.on('data', (b) => process.stderr.write(b));
      for (let i = 0; ; i++) {
        if (server.exitCode !== null) throw new Error(`Own server exited ${server.exitCode}`);
        if (await fetch(`${base}/healthz`).then((r) => r.ok).catch(() => false)) break;
        if (i === 100) throw new Error('Own server did not become ready'); await sleep(100);
      }
    }
    browser = await chromium.launch({ headless: true, args: browserArgs(['--mute-audio']) });
    await captureJasmine(browser, base, tag);
  } finally {
    await browser?.close();
    if (server && server.exitCode === null) { server.kill('SIGTERM'); await new Promise((resolve) => server.once('exit', resolve)); }
  }
}
