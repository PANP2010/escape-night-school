import { browserArgs } from '../browser-args.mjs';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { delayProxy } from './delay-proxy.mjs';
import { SPEED } from '../../shared/constants.ts';

const log = (...a: unknown[]) => console.log('REPRO', ...a);

// Movement rubber-banding (#184) at 150 ms RTT: two separate browsers behind a TCP delay proxy (CDP network emulation
// does not delay WebSocket frames) walk and run through doors, up/down stairs and slide along a wall. A clean prediction must
// never be corrected, B must see A move without jumps, and a 10 m teleport input must still be refused.
const ARGS = browserArgs(['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']);
const launched: Browser[] = [];
test.afterEach(async () => { await Promise.all(launched.splice(0).map((b) => b.close())); });

async function open(baseURL: string, name: string): Promise<Page> {
  const browser = await chromium.launch({ args: ARGS });
  launched.push(browser);
  browser.on('disconnected', () => log(name, 'browser disconnected'));
  const ctx = await browser.newContext({ baseURL, viewport: { width: 400, height: 260 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log(name, 'pageerror', e.message));
  page.on('crash', () => log(name, 'page crashed')); page.on('close', () => log(name, 'page closed'));
  await page.addInitScript(() => {
    const W = window.WebSocket, w = window as any;
    w.__corr = [];
    w.WebSocket = class extends W {
      constructor(u: string | URL) {
        super(u);
        w.__ws = this;
        this.addEventListener('message', (e) => { const s = String(e.data); if (s.includes('"correct"')) w.__corr.push(JSON.parse(s)); });
      }
      send(d: string) { // the last door presses, for the autopilot-stuck dump
        if (String(d).includes('"door"')) (w.__doorSends ??= []).push([Math.round(performance.now()), String(d)]), w.__doorSends.splice(0, w.__doorSends.length - 8);
        super.send(d);
      }
    };
  });
  await page.goto('/?nodraw');
  await page.fill('#name', name);
  return page;
}

test('150 ms RTT: walk/run doors/stairs/wall slide with 0 non-forced corrections, smooth remote, 10 m cheat refused', async ({ baseURL }) => {
  test.setTimeout(180_000);
  const port = Number(new URL(baseURL!).port);
  const proxy = await delayProxy('127.0.0.1', port, 75);
  try {
    const via = `http://127.0.0.1:${proxy.port}`;
    const [A, B] = await Promise.all([open(via, '甲'), open(via, '乙')]);
    await A.click('#create');
    const code = await A.evaluate(async () => { while (!window.__escape.code) await new Promise((r) => setTimeout(r, 50)); return window.__escape.code; });
    await B.fill('#code', code); await B.click('#join');
    await expect(A.locator('#wait-members li')).toHaveCount(2);
    await A.evaluate(() => document.getElementById('start')!.click());
    for (const p of [A, B]) await p.waitForFunction(() => {
      const g = window.__escape.game(); return g?.presentationReady && !g.intro.active;
    }, null, { timeout: 60_000 });
    const aId = await A.evaluate(() => window.__escape.game()!.myId);
    // the tour is about movement: the NPCs leave both alone (a catch is a punish teleport, not a smooth path)
    await A.evaluate(() => window.__escape.debug('safe', 600));

    // B: every animation frame, how far A's remote mesh moved since the last one (paused around A's teleports)
    await B.evaluate((id) => {
      const w = window as any;
      w.__jump = { max: 0, frames: 0, maxDt: 0, at: -1, maxRate: 0, slow: 0, top: [] as number[][] }; w.__pause = true; w.__unp = 0;
      let last: { x: number; z: number; t: number; ct: number; nt: number } | undefined;
      const tick = (t: number) => {
        const r = (window.__escape.game() as any).remotes.get(id);
        if (w.__pause || !r) last = undefined;
        else {
          const { x, z } = r.mesh.position;
          if (last) {
            const d = Math.hypot(x - last.x, z - last.z);
            w.__jump.frames++; w.__jump.maxDt = Math.max(w.__jump.maxDt, t - last.t);
            // a frame B itself took > 70 ms to draw legitimately carries a longer step: the remote StepSmoother allows
            // 1.3× run speed·dt (game.ts sm), i.e. 0.6 m on the exact 100 ms frames swiftshader settles at under gate
            // load (#190 gate failed there with 0.598 at > 100). On those only the speed counts (maxRate below);
            // at ≤ 70 ms the cap is ≤ 0.42 m, so 0.5 still catches a real jump
            if (t - last.t > 70) w.__jump.slow++;
            else if (d > w.__jump.max) { w.__jump.max = d; w.__jump.at = w.__jump.frames; }
            w.__jump.maxRate = Math.max(w.__jump.maxRate, d / ((t - last.t) / 1000));
            // [step m, frame ms, ms since unpause, playback-clock step ms, newest-sample step ms]
            if (d > 0.3) w.__jump.top.push([+d.toFixed(2), Math.round(t - last.t), Math.round(t - w.__unp), Math.round(r.clock.t - last.ct), Math.round(r.buf.lastT() - last.nt)]);
          }
          last = { x, z, t, ct: r.clock.t, nt: r.buf.lastT() };
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, aId);
    const pause = (on: boolean) => B.evaluate((v) => { (window as any).__pause = v; if (!v) (window as any).__unp = performance.now(); }, on);

    const sr = await A.evaluate(() => window.__escape.spawnRoute());
    // 第 1 关's area: the 正门 is barred (stairRoute's first point is outside it, a tp there is refused) and a grate
    // shuts flight 2 up to 2F: from the 门厅 in through the stairwell door, up flight 1 and across the 休息平台
    const st = (await A.evaluate(() => window.__escape.stairRoute(2))).slice(1, -1);
    const keys = (p: Page, down: string[], up: string[] = []) => p.evaluate(([d, u]) => {
      const i = window.__escape.game()!.input; for (const k of u) i.release(k); for (const k of d) i.press(k);
    }, [down, up]);
    const auto = async (p: Page, route: [number, number][], held: string[]) => {
      await keys(p, held);
      await p.evaluate((r) => window.__escape.autopilot(r), route);
      const done = () => p.waitForFunction(() => window.__escape.game()!.autopilotDone, null, { timeout: 30_000, polling: 200 });
      await done().catch(async (e) => {
        log('autopilot wait failed', p === A ? 'A' : 'B', String(e).split('\n')[0]); // a normal run takes ≲ 15 s: dump where it is stuck and why, then give it the rest of the 60 s
        log('autopilot slow', p === A ? 'A' : 'B', JSON.stringify(await p.evaluate(() => {
          const g = window.__escape.game() as any;
          const near = g.doors.map((d: any, i: number) => ({ i, d: +Math.hypot(d.x - g.pos.x, d.z - g.pos.z).toFixed(2), open: g.doorOpen[i] })).filter((d: any) => d.d < 4);
          return { t: Math.round(performance.now()), pos: g.pos, yaw: g.input.yaw, at: g.routeAt, wp: g.route?.[g.routeAt], n: g.route?.length, near, sends: (window as any).__doorSends };
        })));
        await done();
      });
      await keys(p, [], held);
    };
    const tp = async (p: Page, x: number, z: number) => {
      if (p === A) await pause(true);
      await p.evaluate(([x, z]) => window.__escape.debug('tp', x, z, 0), [x, z]);
      await p.waitForTimeout(1000);
      if (p === A) await pause(false);
    };
    const tour = async (p: Page, k: number) => {
      const t0 = Date.now();
      await tp(p, sr[0][0] + k * 0.8, sr[0][1]);
      await auto(p, sr, []); // walking through the entrance doors and corners
      await tp(p, sr[0][0] + k * 0.8, sr[0][1]);
      await auto(p, sr, ['ShiftLeft']); // and running
      await tp(p, st[0][0] + k * 0.8, st[0][1]);
      await auto(p, st, ['ShiftLeft']); // up the stairs
      await auto(p, [...st].reverse(), ['ShiftLeft']); // and down again
      // wall slide: push into the wall 40° off it at a run
      const yaw = await p.evaluate(() => window.__escape.game()!.input.yaw);
      await p.evaluate((y) => { window.__escape.game()!.input.yaw = y; }, yaw + Math.PI + 0.7);
      await keys(p, ['KeyW', 'ShiftLeft']); await p.waitForTimeout(3000); await keys(p, [], ['KeyW', 'ShiftLeft']);
      return (Date.now() - t0) / 1000;
    };
    const secs = await Promise.all([tour(A, 0), tour(B, 1)]);
    await A.waitForTimeout(500);
    const st8 = await Promise.all([A, B].map((p) => p.evaluate(() => ({ n: window.__escape.game()!.corrections, corr: (window as any).__corr }))));
    const jump = await B.evaluate(() => (window as any).__jump);
    log('tour s', secs, 'corrections', st8.map((s) => s.n), 'forced', st8.map((s) => s.corr.filter((m: any) => m.forced).length), 'B sees A', JSON.stringify(jump));
    expect(Math.min(...secs)).toBeGreaterThan(20);
    expect(st8.map((s) => s.n)).toEqual([0, 0]);
    expect(jump.frames).toBeGreaterThan(200);
    expect(jump.max).toBeLessThan(0.5);
    expect(jump.maxRate).toBeLessThan(1.5 * SPEED.run); // never faster than 1.5× run speed, slow frames included

    // cheat: a hand-made input 10 m away (in the current correction epoch) is refused and A is put back
    const cheat = await A.evaluate(async () => {
      const g = window.__escape.game() as any, w = window as any;
      const from = [g.pos.x, g.body.y, g.pos.z], n = w.__corr.length;
      w.__ws.send(JSON.stringify({ t: 'input', seq: 1e6, p: [from[0] + 10, from[1], from[2]], yaw: 0, pitch: 0, f: 0, c: g.corrC }));
      while (w.__corr.length === n) await new Promise((r) => setTimeout(r, 20));
      return { from, m: w.__corr[n] };
    });
    log('cheat', JSON.stringify(cheat));
    expect(cheat.m.ack).toBe(1e6);
    expect(Math.hypot(cheat.m.p[0] - cheat.from[0], cheat.m.p[2] - cheat.from[2])).toBeLessThan(1);
  } finally {
    proxy.close();
  }
});
