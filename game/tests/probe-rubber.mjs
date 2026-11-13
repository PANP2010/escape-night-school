// One-off probe (not in the gate): 2 separate chromiums on the real ws server, each behind
// a TCP delay proxy (LAT ms round trip, default 150), drive a scripted tour (walk / run / crouch / doors / stairs up+down
// / wall slide / run until exhausted / corners) and count the `correct`s each phase receives. With CORR_LOG=1 on the
// server its stdout lists each rejection's cause (dist = the sliding-window distance budget, collide = campusMoveOk).
// PORT=4179 LAT=150 node tests/probe-rubber.mjs   (URL=http://host:port overrides the target)
import { chromium } from '@playwright/test';
import { browserArgs } from './browser-args.mjs';
import { assertDebugAvailable } from './helpers.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { delayProxy } from './e2e/delay-proxy.mjs';
const target = new URL(process.env.URL ?? `http://127.0.0.1:${process.env.PORT ?? 4179}`);
const LAT = Number(process.env.LAT ?? 150);
// CDP emulateNetworkConditions does not delay WebSocket frames (measured RTT stayed ~10 ms), so a TCP proxy adds LAT/2 each way
const proxy = LAT ? await delayProxy(target.hostname, Number(target.port || 80), LAT / 2) : undefined;
const base = proxy ? `http://127.0.0.1:${proxy.port}` : target.origin;
const ARGS = browserArgs(['--disable-background-timer-throttling', '--disable-renderer-backgrounding']);
const br = await Promise.all([0, 1].map(() => chromium.launch({ args: ARGS })));
try {
mkdirSync('test-results/probe-rubber', { recursive: true });
const ctx = await Promise.all(br.map((b) => b.newContext({ baseURL: base, viewport: { width: 640, height: 360 } })));
const pages = await Promise.all(ctx.map((c) => c.newPage()));
for (const p of pages) {
  await p.addInitScript(() => {
    const W = window.WebSocket; window.__corr = []; window.__phase = 'lobby'; window.__tpAt = 0; window.__rtt = [];
    window.WebSocket = class extends W {
      constructor(u) {
        super(u);
        this.addEventListener('message', (e) => {
          const s = String(e.data);
          if (!s.includes('"correct"')) return;
          const m = JSON.parse(s), g = window.__escape.game();
          if (m.forced && window.__tpAt) { window.__rtt.push(performance.now() - window.__tpAt); window.__tpAt = 0; }
          window.__corr.push({ t: performance.now(), phase: window.__phase, forced: !!m.forced, err: g ? Math.hypot(g.pos.x - m.p[0], g.pos.z - m.p[2]) : -1, sta: g?.stamina });
        });
      }
    };
  });
}
const [A, B] = pages;
for (const p of pages) await p.goto('/?nodraw');
await A.fill('#name', '甲'); await B.fill('#name', '乙');
await A.click('#create');
const code = await A.evaluate(async () => { while (!window.__escape.code) await new Promise((r) => setTimeout(r, 50)); return window.__escape.code; });
await B.fill('#code', code); await B.click('#join');
await A.waitForSelector('#wait-members li:nth-child(2)');
await A.evaluate(() => document.getElementById('start').click());
for (const p of pages) await p.waitForFunction(() => window.__escape.game()?.spawnSynced, null, { timeout: 60_000 });
await assertDebugAvailable(A);
await A.waitForTimeout(1500);

const ev = (p, f, a) => p.evaluate(f, a);
const phase = (p, name) => ev(p, (n) => { window.__phase = n; }, name);
const tp = async (p, x, z, floor = 0) => {
  await phase(p, 'tp');
  await ev(p, ([x, z, f]) => { window.__tpAt = performance.now(); window.__escape.debug('tp', x, z, f); }, [x, z, floor]);
  await p.waitForTimeout(1200);
};
const keys = (p, down, up = []) => ev(p, ([d, u]) => { const i = window.__escape.game().input; for (const k of u) i.release(k); for (const k of d) i.press(k); }, [down, up]);
const auto = async (p, name, route, held = []) => {
  await phase(p, name); await keys(p, held);
  await ev(p, (r) => window.__escape.autopilot(r), route);
  await p.waitForFunction(() => window.__escape.game().autopilotDone, null, { timeout: 90_000, polling: 200 });
  await keys(p, [], held);
};
const hold = async (p, name, yaw, held, ms) => {
  await phase(p, name);
  await ev(p, (y) => { window.__escape.game().input.yaw = y; }, yaw);
  await keys(p, held); await p.waitForTimeout(ms); await keys(p, [], held);
};
const sr = await A.evaluate(() => window.__escape.spawnRoute()), st = await A.evaluate(() => window.__escape.stairRoute(2));
const tour = async (p, k) => {
  const t0 = Date.now(), log = [];
  const mark = (n) => log.push([n, (Date.now() - t0) / 1000]);
  await tp(p, sr[0][0] + k * 0.8, sr[0][1]);
  await auto(p, 'walk+door+corner', sr); mark('walk');
  await auto(p, 'run back', [...sr].reverse(), ['ShiftLeft']); mark('runback');
  await auto(p, 'crouch', sr.slice(0, 3), ['KeyC']); mark('crouch');
  await tp(p, st[0][0] + k * 0.8, st[0][1]);
  await auto(p, 'stairs up (walk)', st); mark('up');
  await auto(p, 'stairs down (run)', [...st].reverse(), ['ShiftLeft']); mark('down');
  await auto(p, 'stairs up (run)', st, ['ShiftLeft']); mark('uprun');
  await auto(p, 'stairs down (walk)', [...st].reverse()); mark('downwalk');
  // wall slide: from outside the entrance, face 40° off the wall and push into it
  const yaw = await ev(p, () => window.__escape.game().input.yaw);
  await hold(p, 'wall slide', yaw + Math.PI + 0.7, ['KeyW', 'ShiftLeft'], 4000); mark('wall');
  await hold(p, 'run till exhausted', yaw + Math.PI, ['KeyW', 'ShiftLeft'], 14000); mark('exhaust');
  await hold(p, 'zigzag', yaw + Math.PI * 0.5, ['KeyW', 'KeyA'], 2000); mark('zigzag');
  return log;
};
const t0 = Date.now();
const logs = await Promise.all([tour(A, 0), tour(B, 1)]);
const res = await Promise.all(pages.map((p) => ev(p, () => ({ corr: window.__corr, rtt: window.__rtt, n: window.__escape.game().corrections, id: window.__escape.game().myId }))));
for (const c of ctx) await c.close();
for (const b of br) await b.close();
proxy?.close();
writeFileSync('test-results/probe-rubber/data.json', JSON.stringify({ logs, res }));
for (const [i, r] of res.entries()) {
  const by = {};
  for (const c of r.corr) { const k = c.phase + (c.forced ? ' (forced)' : ''); by[k] ??= { n: 0, maxErr: 0 }; by[k].n++; by[k].maxErr = Math.max(by[k].maxErr, +c.err.toFixed(2)); }
  console.log(JSON.stringify({ client: 'AB'[i], lat: LAT, rttMs: r.rtt.map(Math.round), nonForced: r.n, secs: (Date.now() - t0) / 1000, phases: logs[i], by }));
}
} finally {
  proxy?.close();
  await Promise.allSettled(br.map((browser) => browser.close()));
}
