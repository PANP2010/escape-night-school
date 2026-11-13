import { expect, test, type Page, type CDPSession } from '@playwright/test';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { execFileSync } from 'node:child_process';
import { L1 } from '../../shared/levels/l1.ts';
import { L2 } from '../../shared/levels/l2.ts';
import { L3 } from '../../shared/levels/l3.ts';
import { L4 } from '../../shared/levels/l4.ts';

// Audit only: one browser; two rendered contexts during the stability phase,
// then one rendered context plus Node WebSocket peers for four-player pressure.
// Client rebuild pressure is deliberately separated from actual server wipes.
const OUT = 'test-results/metal-audit';
const defs = [L1, L2, L3, L4];
type Sample = { phase: string; elapsedMs: number; level: number; seed: number; geometries: number; textures: number; programs: number; heapUsed: number; heapTotal: number; calls: number; triangles: number; frameCount: number; body: unknown; camera: unknown };
const samples: Sample[] = [];
const errors: { source: string; text: string }[] = [];
const facts: Record<string, unknown> = {};
let epoch = Date.now();

async function save() {
  await mkdir(OUT, { recursive: true });
  await writeFile(`${OUT}/results.json`, JSON.stringify({ capturedAt: new Date().toISOString(), facts, samples, errors }, null, 2));
}
async function ready(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const g = window.__escape.game() as any;
    return !!g?.presentationReady && g.snaps > 5;
  }), { timeout: 30_000 }).toBe(true);
}
async function frames(page: Page, n = 10) {
  await page.evaluate(async n => { for (let i = 0; i < n; i++) await new Promise<void>(r => requestAnimationFrame(() => r())); }, n);
}
async function countFrames(page: Page) {
  await page.evaluate(() => {
    const w = window as any; w.__auditFrames = 0;
    const f = () => { w.__auditFrames++; requestAnimationFrame(f); };
    requestAnimationFrame(f);
  });
}
async function shot(page: Page, name: string) {
  await frames(page);
  await page.screenshot({ path: `${OUT}/${name}.png`, animations: 'disabled', timeout: 20_000 });
}
async function sample(page: Page, cdp: CDPSession, phase: string) {
  await frames(page, 6);
  await cdp.send('HeapProfiler.collectGarbage');
  await frames(page, 3);
  await cdp.send('HeapProfiler.collectGarbage');
  const heap = await cdp.send('Runtime.getHeapUsage');
  const s = await page.evaluate(() => {
    const w = window as any, g = window.__escape.game()!, info = g.renderer.info;
    return { level: g.level.index + 1, seed: g.level.seed, geometries: info.memory.geometries, textures: info.memory.textures, programs: info.programs?.length ?? 0,
      calls: info.render.calls, triangles: info.render.triangles, frameCount: w.__auditFrames ?? 0,
      body: { x: g.body.x, y: g.body.y, z: g.body.z }, camera: { x: g.camera.position.x, y: g.camera.position.y, z: g.camera.position.z } };
  });
  const row = { phase, elapsedMs: Date.now() - epoch, ...s, heapUsed: heap.usedSize, heapTotal: heap.totalSize };
  const prefix = phase.replace(/\d+s$/, '');
  const previous = samples.findLast(s => s.phase.replace(/\d+s$/, '') === prefix);
  if (previous && phase.endsWith('s')) Object.assign(row, { intervalFps: (row.frameCount - previous.frameCount) * 1000 / (row.elapsedMs - previous.elapsedMs) });
  samples.push(row); console.log('METAL_MEMORY', JSON.stringify(row)); await save(); return row;
}
async function camera(page: Page, x: number, y: number, z: number, yaw: number, pitch = -.12) {
  await page.evaluate(v => { const g = window.__escape.game() as any; g.view = v; g.draw = true; }, { x, y, z, yaw, pitch });
  await frames(page, 8);
}
async function warmItems(page: Page) {
  const items = await page.evaluate(() => (window.__escape.game() as any).items as { p: number[] }[]);
  for (const { p } of items) await camera(page, p[0], p[1] + 1, p[2] + 1.5, 0, -.5);
}
async function warmLevel(page: Page, index: number, seed: number) {
  const d = defs[index];
  await page.evaluate(({ index, seed }) => { const g = window.__escape.game() as any; g.loadLevel(index, seed); g.spawnSynced = true; }, { index, seed });
  const sp = d.spawns[0];
  await camera(page, sp.x, (sp.y ?? 0) + 1.6, sp.z, Math.PI / 2);
  // Render the new barriers/notices, all landmark types, and blackout textures into GPU memory.
  for (const b of d.barriers) {
    const x = (b.x0 + b.x1) / 2, z = (b.z0 + b.z1) / 2;
    const dx = b.face === 'x+' ? 3 : b.face === 'x-' ? -3 : 0;
    const dz = b.face === 'z+' ? 3 : b.face === 'z-' ? -3 : 0;
    await camera(page, x + dx, b.y + 1.55, z + dz, Math.atan2(dx, dz));
  }
  for (const m of d.landmarks) {
    const dx = m.dir === 'x+' ? 2.5 : m.dir === 'x-' ? -2.5 : 0;
    const dz = m.dir === 'z+' ? 2.5 : m.dir === 'z-' ? -2.5 : 0;
    await camera(page, m.x + dx, m.y + 1.6, m.z + dz, Math.atan2(dx, dz), m.kind === 'arrow' ? -.6 : -.12);
  }
  if (d.blackout) {
    const p = d.blackout.fuseBox;
    await camera(page, p.x, p.y + 1.6, p.z - 2.2, Math.PI);
    for (const e of d.blackout.emergency) await camera(page, e.x + 2.5, e.y + 1.7, e.z, Math.PI / 2, .05);
  }
  if (d.broadcast) {
    const p = d.broadcast.console;
    await camera(page, p.x, p.y + 1.6, p.z - 2.2, Math.PI);
    for (const p of d.broadcast.stickers) await camera(page, p.x, p.y + 1.6, p.z + (p.face === 'z+' ? 2 : -2), p.face === 'z+' ? 0 : Math.PI);
  }
  await camera(page, sp.x, (sp.y ?? 0) + 1.6, sp.z, Math.PI / 2);
}

async function peer(baseURL: string, code: string, name: string) {
  const ws = new WebSocket(baseURL.replace(/^http/, 'ws') + '/ws');
  let id = -1, at: number[] = [], c = 0, seq = 0;
  const received: any[] = [];
  ws.on('message', d => {
    const m = JSON.parse(String(d)); received.push(m);
    if (m.t === 'welcome') id = m.id;
    if (m.t === 'correct') { at = m.p; c = m.c ?? c; }
    if (m.t === 'snap' && !at.length) at = m.players.find((p: any) => p.id === id)?.p ?? at;
  });
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const send = (m: unknown) => ws.send(JSON.stringify(m));
  send({ t: 'hello', name }); send({ t: 'join', code });
  return { ws, send, received, get id() { return id; }, get at() { return [...at]; }, input(p: number[], f = 0) { at = p; send({ t: 'input', seq: ++seq, p, yaw: 0, pitch: 0, f, c }); } };
}

test('Metal lifecycle audit: real wipe, steady memory, rebuilt L1–L4, low-fps peers, touch', async ({ browser, baseURL }) => {
  await mkdir(OUT, { recursive: true }); epoch = Date.now();
  facts.revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const indexHTML = await readFile('dist/index.html', 'utf8');
  facts.build = {
    clientAssets: [...indexHTML.matchAll(/(?:src|href)="([^"]*\/assets\/[^"]+)"/g)].map(m => m[1]),
    indexSha256: createHash('sha256').update(indexHTML).digest('hex'),
    serverSha256: createHash('sha256').update(await readFile('dist-server/index.js')).digest('hex'),
    clientMtime: (await stat('dist/index.html')).mtime.toISOString(),
    serverMtime: (await stat('dist-server/index.js')).mtime.toISOString(),
    productVersion: JSON.parse(await readFile('dist/version.json', 'utf8')),
  };
  facts.captureStatus = 'running';
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await desktop.newPage();
  page.on('pageerror', e => errors.push({ source: 'page', text: e.message }));
  page.on('console', m => { if (m.type() === 'error') errors.push({ source: 'console', text: m.text() }); });
  const peers: Awaited<ReturnType<typeof peer>>[] = [];
  try {
    await page.goto(`${baseURL}/?steady`); await page.fill('#name', 'Metal审计'); await page.click('#create'); await page.click('#start'); await ready(page);
    const cdp = await desktop.newCDPSession(page);
    facts.renderer = await page.evaluate(() => { const g = window.__escape.game()!, gl = g.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info'); return { renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR), version: gl.getParameter(gl.VERSION), viewport: [innerWidth, innerHeight], dpr: g.renderer.getPixelRatio() }; });
    expect(JSON.stringify(facts.renderer)).toMatch(/Metal/); expect(JSON.stringify(facts.renderer)).not.toMatch(/SwiftShader/);
    await countFrames(page);
    await page.evaluate(() => window.__escape.debug('safe', 600));
    const seed = await page.evaluate(() => window.__escape.game()!.level.seed); facts.seed = seed;
    await warmLevel(page, 0, seed); await warmItems(page); await camera(page, L1.spawns[0].x, (L1.spawns[0].y ?? 0) + 1.6, L1.spawns[0].z, Math.PI / 2); await shot(page, 'desktop-l1-before'); await sample(page, cdp, 'real-wipe-before');
    // A trusted gesture unlocks the real graph; Chromium remains muted at the process level.
    await page.mouse.click(640, 360); await frames(page, 12);
    const audioState = () => page.evaluate(() => {
      const s = (window.__escape.game() as any).sound;
      return { context: s.context?.state, gain: s.master?.gain.value, transitioning: s.transitioning, active: s.frame?.active };
    });
    facts.audioBeforeWipe = await audioState();
    // Actual authoritative whole-team wipe, same room/seed; no direct loadLevel call in this step.
    await page.evaluate(() => { const w = window as any; w.__roomEvents = []; const net = window.__escape.net, original = net.onMsg; net.onMsg = m => { if (['room', 'fade', 'items'].includes(m.t)) w.__roomEvents.push(m); original(m); }; });
    for (let restart = 1; restart <= 4; restart++) {
      await page.evaluate(() => window.__escape.debug('down', 1));
      await expect(page.locator('#fade-overlay')).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('#fade-overlay')).toBeHidden({ timeout: 20_000 }); await ready(page);
      await page.evaluate(() => window.__escape.debug('safe', 600));
      await warmItems(page);
      await camera(page, L1.spawns[0].x, (L1.spawns[0].y ?? 0) + 1.6, L1.spawns[0].z, Math.PI / 2);
      await sample(page, cdp, `real-wipe-after-${restart}`);
    }
    facts.realWipe = await page.evaluate(() => ({ events: (window as any).__roomEvents, down: (window.__escape.game() as any).down, spectate: (window.__escape.game() as any).spectate }));
    facts.audioAfterWipes = await audioState();
    await shot(page, 'desktop-l1-after-real-wipe');
    for (let i = 0; i <= 6; i++) { if (i) await page.waitForTimeout(20_000); await sample(page, cdp, `steady-l1-${i * 20}s`); }
    // Two genuine rendered clients in one browser session: no Node peer substitutes in this phase.
    const second = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 1 });
    const secondPage = await second.newPage();
    secondPage.on('pageerror', e => errors.push({ source: 'second-page', text: e.message }));
    secondPage.on('console', m => { if (m.type() === 'error') errors.push({ source: 'second-console', text: m.text() }); });
    const browserCDP = await browser.newBrowserCDPSession();
    try {
      const code = await page.evaluate(() => window.__escape.code);
      await secondPage.goto(`${baseURL}/?steady`); await secondPage.fill('#name', '双页审计');
      await secondPage.fill('#code', code); await secondPage.click('#join'); await ready(secondPage);
      await countFrames(secondPage);
      // Late joins spectate; an authoritative team wipe starts both rendered clients as active players.
      await page.evaluate(() => window.__escape.debug('down', 1));
      await expect(page.locator('#fade-overlay')).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('#fade-overlay')).toBeHidden({ timeout: 20_000 });
      await ready(page); await ready(secondPage);
      await page.evaluate(() => window.__escape.debug('safe', 600));
      await expect.poll(() => secondPage.evaluate(() => window.__escape.game()!.spectate)).toBe(false);
      const secondCDP = await second.newCDPSession(secondPage);
      facts.dualRendered = [];
      for (let i = 0; i <= 6; i++) {
        if (i) await page.waitForTimeout(20_000);
        const a = await sample(page, cdp, `dual-rendered-a-${i * 20}s`);
        const b = await sample(secondPage, secondCDP, `dual-rendered-b-${i * 20}s`);
        const processes = await browserCDP.send('SystemInfo.getProcessInfo');
        const ids = processes.processInfo.map(p => p.id).join(',');
        const rss = execFileSync('/bin/ps', ['-p', ids, '-o', 'pid=,rss=,comm='], { encoding: 'utf8' }).trim();
        const totalRssKiB = rss.split('\n').reduce((sum, row) => sum + Number(row.trim().split(/\s+/)[1] ?? 0), 0);
        (facts.dualRendered as unknown[]).push({ seconds: i * 20, aHeap: a.heapUsed, bHeap: b.heapUsed, totalRssKiB, processes: rss });
        await save();
      }
      await shot(page, 'desktop-dual-rendered');
    } finally { await second.close(); await browserCDP.detach(); }
    // Four real WS participants; bots avoid extra rendered pages/GPU contexts.
    const code = await page.evaluate(() => window.__escape.code);
    for (let i = 0; i < 3; i++) peers.push(await peer(baseURL!, code, `审计机器人${i + 1}`));
    await expect.poll(() => page.evaluate(() => window.__escape.game()!.remotes.size)).toBe(3);
    await page.evaluate(() => window.__escape.debug('safe', 600));
    await page.waitForTimeout(500);
    facts.peerIds = peers.map(p => p.id);
    // Mid-level joins spectate until the authoritative wipe puts all four players into ST_OK.
    await page.evaluate(() => window.__escape.debug('down', 1));
    await expect(page.locator('#fade-overlay')).toBeVisible({ timeout: 20_000 }); await expect(page.locator('#fade-overlay')).toBeHidden({ timeout: 20_000 }); await ready(page);
    await page.evaluate(() => window.__escape.debug('safe', 600));
    await expect.poll(() => peers.every(p => p.at.length === 3)).toBe(true);
    facts.lowfpsCalibration = [];
    let throttle = 100;
    for (const rate of [100, 200, 400]) {
      throttle = rate;
      await cdp.send('Emulation.setCPUThrottlingRate', { rate });
      const timing = await page.evaluate(async () => {
        const timestamps: number[] = [];
        await new Promise<void>(resolve => {
          const f = (t: number) => { timestamps.push(t); if (t - timestamps[0] < 1800) requestAnimationFrame(f); else resolve(); };
          requestAnimationFrame(f);
        });
        return { frames: timestamps.length, fps: (timestamps.length - 1) * 1000 / (timestamps.at(-1)! - timestamps[0]) };
      });
      (facts.lowfpsCalibration as unknown[]).push({ rate, ...timing });
      if (timing.fps <= 9) break;
    }
    await save();
    await page.evaluate(() => {
      const w = window as any; w.__sync = []; w.__syncUntil = performance.now() + 12_000;
      const f = (t: number) => { const g = window.__escape.game() as any; w.__sync.push({ t, snapOffset: g.snapClock?.off, remotes: [...g.remotes].map(([id, r]: any) => ({ id, x: r.mesh.position.x, y: r.mesh.position.y, z: r.mesh.position.z, latest: r.buf?.lastT?.(), clock: r.clock?.t, lead: r.clock?.lead, catchingUp: r.sm?.catching, lastSampleTimes: r.buf?.s?.slice(-4).map((s: any) => s.t) })) }); if (t < w.__syncUntil) requestAnimationFrame(f); }; requestAnimationFrame(f);
    });
    const moving = peers[0], origin = moving.at;
    // Keep the authority moving through the whole sample window, rather than
    // averaging a short movement over ten idle seconds. Reversal stays in L1.
    const movementStartedAt = Date.now();
    for (let i = 1; i <= 240; i++) {
      const leg = i % 96, offset = (leg <= 48 ? leg : 96 - leg) * (8 / 48);
      moving.input([origin[0] + offset, origin[1], origin[2]]);
      await new Promise(r => setTimeout(r, 50));
    }
    facts.lowfpsMovementMs = Date.now() - movementStartedAt;
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    const raw = await page.evaluate(() => (window as any).__sync as any[]);
    await writeFile(`${OUT}/lowfps-raw.json`, JSON.stringify({ peerIds: peers.map(p => p.id), rendererFrames: raw, authoritative: moving.received.filter(m => m.t === 'snap').map(m => ({ tick: m.tick, p: m.players.find((p: any) => p.id === moving.id)?.p })) }, null, 2));
    const positions = raw.map(r => ({ t: r.t, p: r.remotes.find((p: any) => p.id === moving.id) })).filter(r => r.p);
    const steps = positions.slice(1).map((r, i) => { const prev = positions[i], dt = r.t - prev.t, step = Math.hypot(r.p.x - prev.p.x, r.p.z - prev.p.z); return { dt, step, excess: step - 3.4 * dt / 1000 * 1.5 }; });
    const actualFps = (positions.length - 1) / ((positions.at(-1)!.t - positions[0].t) / 1000);
    facts.lowfps = { throttle, frames: positions.length, movingFrames: steps.filter(s => s.step > .005).length, fps: actualFps, maxGapMs: Math.max(...steps.map(s => s.dt)), maxStep: Math.max(...steps.map(s => s.step)), maxExcessAllFrames: Math.max(...steps.map(s => s.excess)), netTravelled: positions.at(-1)!.p.x - positions[0].p.x, totalTravelled: steps.reduce((sum, s) => sum + s.step, 0), threshold: .84, note: 'All raw frames retained, including >500ms frames; no stall exclusion applied. Moving peer reverses inside the same walkable corridor.' };
    expect(actualFps, 'capture must actually cover <=10 fps').toBeLessThanOrEqual(10);
    expect(steps.filter(s => s.step > .005).length, 'low-fps capture must include actual movement').toBeGreaterThan(8);
    console.log('METAL_LOWFPS', JSON.stringify(facts.lowfps)); await shot(page, 'desktop-four-players');
    for (const p of peers) p.ws.close(); peers.length = 0;
    // Isolated client lifecycle stress. Suspend network delivery/upload so the L1 server cannot override local L2–L4 views.
    await page.evaluate(() => { window.__escape.net.onMsg = () => {}; window.__escape.net.send = () => false; });
    for (let index = 0; index < 4; index++) { await warmLevel(page, index, seed); await sample(page, cdp, `first-warmup-l${index + 1}`); await shot(page, `desktop-l${index + 1}-warmup`); }
    for (let cycle = 1; cycle <= 4; cycle++) {
      for (let index = 0; index < 4; index++) { await warmLevel(page, index, seed); await sample(page, cdp, `cross-level-cycle-${cycle}-l${index + 1}`); }
    }
    for (let i = 1; i <= 4; i++) { await warmLevel(page, 0, seed + i); await sample(page, cdp, `same-level-new-seed-${i}`); }
    await warmLevel(page, 0, seed); await sample(page, cdp, 'desktop-final-return-l1');
    await desktop.close();
    const touch = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
    const mobile = await touch.newPage(); mobile.on('pageerror', e => errors.push({ source: 'touch-page', text: e.message }));
    mobile.on('console', m => { if (m.type() === 'error') errors.push({ source: 'touch-console', text: m.text() }); });
    await mobile.goto(`${baseURL}/?steady`); await mobile.fill('#name', '触屏审计'); await mobile.click('#create'); await mobile.click('#start'); await ready(mobile);
    const mobileCDP = await touch.newCDPSession(mobile);
    await mobile.evaluate(() => { window.__escape.debug('safe', 600); window.__escape.net.onMsg = () => {}; window.__escape.net.send = () => false; });
    for (let index = 0; index < 4; index++) { await warmLevel(mobile, index, seed); await sample(mobile, mobileCDP, `touch-first-warmup-l${index + 1}`); await shot(mobile, `touch-l${index + 1}`); }
    for (let index = 0; index < 4; index++) { await warmLevel(mobile, index, seed); await sample(mobile, mobileCDP, `touch-cycle-1-l${index + 1}`); }
    await touch.close(); await save();
    // Report measurements even when growth is found; this is an audit, not a weakened existing regression test.
    expect(errors).toEqual([]);
    facts.captureStatus = 'complete';
    facts.elapsedMs = Date.now() - epoch;
  } finally { for (const p of peers) p.ws.close(); await desktop.close().catch(() => {}); await save(); }
});
