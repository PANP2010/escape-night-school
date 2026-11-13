// Preserved original low-fps scenario; sole launch-argument addition is --mute-audio.
import { browserArgs } from '../browser-args.mjs';
import { expect, test } from '@playwright/test';
import WebSocket from 'ws';
import { EXTRAP_MAX_MS, SPEED as MOVE } from '../../shared/constants.ts';

// One throttled page (≤10 fps) + a Node ws bot walking at constant speed: the remote's rendered position must not jump
// (verifies SnapClock). Two campus pages OOM, hence the bot.
test.use({ launchOptions: { args: browserArgs(['--renderer-process-limit=1', '--disable-gpu-vsync', '--mute-audio']) } });
test('low-fps page: remote bot position steps stay within speed·dt per frame', async ({ page, baseURL }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await page.fill('#name', '甲');
  await page.click('#create');
  const code = await page.evaluate(async () => { while (!window.__escape.code) await new Promise((r) => setTimeout(r, 50)); return window.__escape.code; });

  const ws = new WebSocket(baseURL!.replace('http', 'ws') + '/ws');
  let me: [number, number, number] | null = null;
  let myId = -1;
  const srv: { tick: number; x: number }[] = []; // authoritative bot x per snap: tells server-side bursts from client jumps
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.t === 'welcome') myId = m.id;
    if (m.t === 'snap' && !me) { const p = m.players.find((q: { id: number }) => q.id === myId); if (p) me = p.p; }
    if (m.t === 'snap' && me) { const p = m.players.find((q: { id: number }) => q.id === myId); if (p) srv.push({ tick: m.tick, x: p.p[0] }); }
  });
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ t: 'hello', name: 'bot' }));
  ws.send(JSON.stringify({ t: 'join', code }));
  await expect.poll(() => page.locator('#wait-members li').count()).toBe(2);
  await page.click('#start');
  await expect(page.locator('#hud')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => me, { timeout: 10_000 }).not.toBeNull();

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 10 });
  // sample every rAF: page frame rate is what matters
  await page.evaluate(() => {
    const w = window as unknown as { __s: { t: number; x: number; z: number }[] };
    w.__s = [];
    const loop = () => {
      const r = [...window.__escape.game()!.remotes.values()][0];
      if (r) w.__s.push({ t: performance.now(), x: r.mesh.position.x, z: r.mesh.position.z });
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });

  const [x0, y0, z0] = me!;
  const SPEED = MOVE.walk, STEP = 50, DIST = 8; // ~2.4 s walk: at walk 3.4 m/s a 6 m walk left only ~11 throttled frames
  let seq = 0;
  await new Promise<void>((res) => {
    const iv = setInterval(() => {
      // advance per sent input, not per wall-clock: a stalled test worker (full suite) then slows the bot instead of
      // teleporting it ~1 m in one tick, which the rendered remote would faithfully (and legitimately) show as a jump
      const d = Math.min(DIST, ((++seq * STEP) / 1000) * SPEED);
      ws.send(JSON.stringify({ t: 'input', seq, p: [x0 + d, y0, z0], yaw: 0, pitch: 0, f: 0 }));
      if (d >= DIST) { clearInterval(iv); res(); }
    }, STEP);
  });
  // wait until the remote has actually started/finished moving on screen (snapshots may lag at 10x CPU throttle)
  await expect.poll(() => page.evaluate(() => {
    const w = window as unknown as { __s: { x: number }[] };
    return w.__s.length ? w.__s[w.__s.length - 1].x : null;
  }), { timeout: 20000 }).toBeGreaterThan(x0 + DIST - 0.5);
  await page.waitForTimeout(1000);
  ws.close();
  const s = await page.evaluate(() => (window as unknown as { __s: { t: number; x: number; z: number }[] }).__s);
  const steps = s.slice(1).map((p, i) => Math.hypot(p.x - s[i].x, p.z - s[i].z));
  // a frame may legitimately cover SPEED·dt (swiftshader fps varies 1–15); a snap jump is far larger
  // swiftshader sometimes freezes the throttled page for ~2 s; ws messages queued meanwhile drain a frame or two late,
  // so the catch-up step right after a freeze is event-loop backlog, not SnapClock — skip 400 ms after any > 500 ms gap
  let stallEnd = -Infinity;
  const excess = s.slice(1).map((p, i) => {
    if (p.t - s[i].t > 500) stallEnd = p.t + 400;
    return p.t <= stallEnd ? 0 : steps[i] - (SPEED * (p.t - s[i].t)) / 1000 * 1.5;
  });
  const fps = (s.length - 1) / ((s[s.length - 1].t - s[0].t) / 1000);
  console.log('lowfps', JSON.stringify({ frames: s.length, fps: +fps.toFixed(1), maxStep: Math.max(...steps), maxExcess: +Math.max(...excess).toFixed(2), travelled: s[s.length - 1].x - s[0].x, srvMaxTickStep: +Math.max(0, ...srv.slice(1).map((q, i) => (q.x - srv[i].x) / Math.max(1, q.tick - srv[i].tick))).toFixed(2) }));
  expect(excess.filter((e) => e !== 0).length).toBeGreaterThan(8); // enough non-stall frames checked
  // alone this stays < 0.2 m; in the full suite hitches of 200–500 ms give up to ~1.6 m catch-up steps (see todo).
  // The bug this guards (receive-time stamps) jumped 8.6 m in a 150 ms frame.
  // + SPEED·EXTRAP_MAX_MS: a late snapshot is extrapolated ≤ 100 ms, then the frame after its arrival may pull back by that much
  expect(Math.max(...excess)).toBeLessThan(0.5 + (SPEED * EXTRAP_MAX_MS) / 1000);
  expect(s[s.length - 1].x - s[0].x).toBeGreaterThan(4); // the bot actually moved
});
