import { expect, test, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { SPEED } from '../../shared/constants.ts';

const OUT = 'test-results/clock-monotonic';

async function captureReceives(page: Page) {
  await page.addInitScript(() => {
    const w = window as any, NativeWS = window.WebSocket;
    w.__clockCapture = { arrivals: [], stamps: [], frames: [], slices: [], corrections: [] };
    w.WebSocket = class extends NativeWS {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener('message', e => {
          const m = JSON.parse(String(e.data)), now = performance.now();
          if (m.t === 'snap') w.__clockCapture.arrivals.push({ now, tick: m.tick, players: m.players });
          if (m.t === 'correct') w.__clockCapture.corrections.push({ now, ...m });
        });
      }
    };
  });
}

test('two real rendered WS clients keep ordered stamps and bounded movement through a receiver backlog', async ({ browser, baseURL }) => {
  await mkdir(OUT, { recursive: true });
  const observer = await browser.newContext({ baseURL, viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
  const sender = await browser.newContext({ baseURL, viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 });
  const a = await observer.newPage(), b = await sender.newPage();
  const errors: string[] = [];
  for (const p of [a, b]) p.on('pageerror', e => errors.push(e.message));
  try {
    await captureReceives(a); await captureReceives(b);
    await a.goto('/?steady'); await a.fill('#name', '时钟观察'); await a.click('#create');
    const code = await a.evaluate(async () => {
      while (!window.__escape.code) await new Promise(r => setTimeout(r, 50));
      return window.__escape.code;
    });
    await b.goto('/?steady'); await b.fill('#name', '真实移动'); await b.fill('#code', code); await b.click('#join');
    await expect(a.locator('#wait-members li')).toHaveCount(2);
    await a.click('#start');
    for (const p of [a, b]) await p.waitForFunction(() => {
      const g = window.__escape.game() as any;
      return g?.spawnSynced && g.presentationReady && g.snaps > 10;
    }, null, { timeout: 40_000 });
    await a.evaluate(() => window.__escape.debug('safe', 600));
    const senderId = await b.evaluate(() => window.__escape.game()!.myId);
    const renderer = await a.evaluate(() => {
      const gl = window.__escape.game()!.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
      return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    });
    expect(renderer).toContain('Metal'); expect(renderer).not.toContain('SwiftShader');
    const cdp = await observer.newCDPSession(a);
    let throttle = 60, measuredFps = Infinity;
    for (const rate of [60, 100, 200]) {
      throttle = rate; await cdp.send('Emulation.setCPUThrottlingRate', { rate });
      measuredFps = await a.evaluate(async () => {
        const ts: number[] = [];
        await new Promise<void>(resolve => {
          const f = (t: number) => { ts.push(t); if (t - ts[0] < 1200) requestAnimationFrame(f); else resolve(); };
          requestAnimationFrame(f);
        });
        return (ts.length - 1) * 1000 / (ts.at(-1)! - ts[0]);
      });
      if (measuredFps <= 10) break;
    }
    expect(measuredFps).toBeLessThanOrEqual(10);
    await a.evaluate(id => {
      const w = window as any, g = window.__escape.game() as any, capture = w.__clockCapture;
      capture.stamps = []; capture.frames = []; capture.startedAt = performance.now();
      const original = g.snapClock.stamp.bind(g.snapClock);
      g.snapClock.stamp = (tick: number, now: number) => {
        const stamp = original(tick, now); capture.stamps.push({ tick, now, stamp }); return stamp;
      };
      const remote = g.remotes.get(id), originalStep = remote.sm.step.bind(remote.sm);
      remote.sm.step = (x: number, z: number, dt: number, referenceSpeed: number) => {
        const sm = remote.sm, catching = sm.catching;
        const budget = Math.max(sm.floor, sm.k * Math.min(referenceSpeed, sm.maxV)) * (catching ? 1.5 : 1) * dt;
        const snapped = originalStep(x, z, dt, referenceSpeed);
        capture.slices.push({ frameT: g.last, dt, referenceSpeed, catching, budget, snapped });
        return snapped;
      };
      g.view = { x: -36, y: 1.6, z: 73.36, yaw: Math.PI / 2, pitch: -.08 };
      const frame = (t: number) => {
        const r = g.remotes.get(id);
        if (r) capture.frames.push({ t, now: performance.now(), arrivalCount: capture.arrivals.length, x: r.mesh.position.x, z: r.mesh.position.z, latest: r.buf.lastT(), clock: r.clock.t, sliceCount: capture.slices.length });
        if (!capture.done) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }, senderId);
    // Real client input travels over its own WebSocket. The other renderer alone
    // stalls, so its queued server snapshots form a genuine delivery backlog.
    await b.evaluate(() => { const i = window.__escape.game()!.input; i.yaw = 0; i.press('KeyD'); });
    await a.waitForTimeout(900);
    await a.evaluate(() => {
      const capture = (window as any).__clockCapture;
      capture.stallStart = performance.now();
      while (performance.now() - capture.stallStart < 1300) { /* receiver main thread blocked */ }
      capture.stallEnd = performance.now();
    });
    await a.waitForTimeout(1200);
    await b.evaluate(() => { const i = window.__escape.game()!.input; i.release('KeyD'); i.press('KeyA'); });
    await a.waitForTimeout(3000);
    await b.evaluate(() => window.__escape.game()!.input.release('KeyA'));
    await a.waitForTimeout(2200);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await a.waitForTimeout(600);
    const raw = await a.evaluate(() => { const c = (window as any).__clockCapture; c.done = true; return c; });
    const senderCapture = await b.evaluate(() => (window as any).__clockCapture);
    const frames = raw.frames as { t: number; x: number; z: number; latest: number; clock: number; sliceCount: number }[];
    const stamps = raw.stamps as { tick: number; now: number; stamp: number }[];
    const slices = raw.slices as { frameT: number; dt: number; budget: number; snapped: boolean }[];
    const steps = frames.slice(1).map((f, i) => {
      const prev = frames[i], dtMs = f.t - prev.t, distance = Math.hypot(f.x - prev.x, f.z - prev.z);
      const budget = slices.slice(prev.sliceCount, f.sliceCount).reduce((sum, s) => sum + s.budget, 0);
      return { dtMs, distance, budget, excess: distance - 1.5 * SPEED.walk * dtMs / 1000, budgetExcess: distance - budget };
    });
    const postStall = raw.arrivals.filter((r: { now: number }) => r.now >= raw.stallEnd) as { now: number; tick: number }[];
    let maximumBurst = 0;
    for (let i = 0; i < postStall.length; i++) {
      maximumBurst = Math.max(maximumBurst, postStall.filter(r => r.now >= postStall[i].now && r.now <= postStall[i].now + 50).length);
    }
    const summary = {
      renderer, throttle, calibrationFps: measuredFps,
      frames: frames.length, movingFrames: steps.filter(s => s.distance > .005).length,
      actualFps: (frames.length - 1) * 1000 / (frames.at(-1)!.t - frames[0].t),
      minimumStampStep: Math.min(...stamps.slice(1).map((s, i) => s.stamp - stamps[i].stamp)),
      maxExcess: Math.max(...steps.map(s => s.excess)), maxFrameGapMs: Math.max(...steps.map(s => s.dtMs)),
      maxBudgetExcess: Math.max(...steps.map(s => s.budgetExcess)), lateSmootherSnaps: slices.filter(s => s.snapped).length, maximumBurst,
      totalDistance: steps.reduce((sum, s) => sum + s.distance, 0),
      finalTargetGap: Math.abs(frames.at(-1)!.latest - frames.at(-1)!.clock), errors,
      framePhaseErrors: frames.filter((f, i) => i > 0 && f.sliceCount > frames[i - 1].sliceCount && slices[f.sliceCount - 1].frameT !== f.t).length,
    };
    const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    await writeFile(`${OUT}/two-ws-raw.json`, JSON.stringify({ sourceCommit, summary, senderId, observer: raw, sender: senderCapture }, null, 2));
    await a.screenshot({ path: `${OUT}/two-ws-metal.png`, animations: 'disabled' });
    console.log('CLOCK_MONOTONIC', JSON.stringify(summary));
    expect(stamps.length).toBeGreaterThan(100);
    expect(summary.actualFps).toBeLessThanOrEqual(10);
    expect(summary.minimumStampStep).toBeGreaterThan(0);
    expect(summary.movingFrames).toBeGreaterThan(12);
    expect(summary.totalDistance).toBeGreaterThan(10);
    // The product caps each slice at 1.3*paceSpeed (1.5 times that while catching
    // up), rather than at 1.5*walk. Assert that exact budget without any fixed
    // distance allowance, and keep the original low-fps regression's 0.84 m
    // excess threshold on every frame, including the full receiver stall.
    expect(summary.maxBudgetExcess).toBeLessThanOrEqual(1e-6);
    expect(summary.lateSmootherSnaps).toBe(0);
    expect(summary.maxExcess).toBeLessThan(.84);
    expect(summary.maximumBurst).toBeGreaterThanOrEqual(22);
    expect(summary.framePhaseErrors).toBe(0);
    expect(summary.finalTargetGap).toBeLessThan(250);
    expect(errors).toEqual([]);
  } finally {
    await observer.close(); await sender.close();
  }
});
