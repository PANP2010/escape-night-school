// One-off check (not in the gate, #218 光照节奏): two real contexts over ws. A grabs real frames (recordVideo starves its screenshots under swiftshader); A fires debug('power', OFF)
// at ~5 s into the clip and both A and B must see the 跳闸 (omen → out → back). Prints the trimmed clip offset.
import { chromium } from '@playwright/test';
import { browserArgs } from './browser-args.mjs';
import { assertDebugAvailable } from './helpers.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
const base = `http://127.0.0.1:${process.env.PORT ?? 4218}`, OFF = +(process.env.OFF ?? 8);
const ARGS = browserArgs(['--disable-background-timer-throttling', '--disable-renderer-backgrounding']);
mkdirSync('test-results/trip', { recursive: true });
const br = await chromium.launch({ args: ARGS }), br2 = await chromium.launch({ args: ARGS }); // B apart: A's GPU process only renders the clip
try {
const cA = await br.newContext({ baseURL: base, viewport: { width: 1280, height: 720 } });
const cB = await br2.newContext({ baseURL: base, viewport: { width: 640, height: 360 } });
const tv = Date.now();
const A = await cA.newPage(), B = await cB.newPage();
for (const p of [A, B]) p.on('pageerror', (e) => console.log('pageerror', e.message));
await A.goto('/'); await B.goto('/?nodraw');
await A.fill('#name', '甲'); await B.fill('#name', '乙');
await A.click('#create');
const code = await A.evaluate(async () => { while (!window.__escape.code) await new Promise((r) => setTimeout(r, 50)); return window.__escape.code; });
await B.fill('#code', code); await B.click('#join');
await A.waitForSelector('#wait-members li:nth-child(2)');
await A.evaluate(() => document.getElementById('start').click());
for (const p of [A, B]) await p.waitForFunction(() => window.__escape.game()?.spawnSynced, null, { timeout: 90_000 });
await assertDebugAvailable(A);
await A.evaluate(() => { window.__escape.debug('safe', 900, 1); window.__escape.debug('safe', 900, 2); const g = window.__escape.game(); g.light = false; g.input.yaw = 0; g.input.pitch = -0.05; });
await A.waitForTimeout(6000);
// a slow look-around so the clip is not a still frame
mkdirSync('test-results/trip/f', { recursive: true });
const cdp = await cA.newCDPSession(A); // page.screenshot hangs on 'fonts loaded' here: raw CDP capture
const frames = [], t00 = Date.now(); // the screencast drops most frames under swiftshader: also grab real ones (time, file) for the clip
const grab = async () => { const f = `test-results/trip/f/${String(frames.length).padStart(4, '0')}.jpg`; await A.evaluate((t) => { window.__escape.game().input.yaw = Math.sin(t / 4) * 0.6; }, (Date.now() - t00) / 1000); const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 80 }); writeFileSync(f, Buffer.from(data, 'base64')); frames.push([(Date.now() - t00) / 1000, f]); };
while (Date.now() - t00 < 5000) await grab();
const tTrip = (Date.now() - tv) / 1000;
await A.evaluate((s) => window.__escape.debug('power', s), OFF);
const sample = (p) => p.evaluate(() => { const g = window.__escape.game(); return { trip: !!g.trip, out: g.campus.out, stutter: g.campus.stutter }; });
const log = [], ts = Date.now(); // real seconds since the trip (a swiftshader frame can stall an evaluate for a while)
while (Date.now() - ts < (OFF + 6) * 1000 || log.at(-1)[2].trip) { const [a, b] = await Promise.all([sample(A), sample(B)]); log.push([+((Date.now() - ts) / 1000).toFixed(1), a, b]); await grab(); }
const tEnd = Date.now() + 4000; while (Date.now() < tEnd) await grab();
// ffconcat with the real gaps: ffmpeg -f concat -i test-results/trip/f/list.txt …
writeFileSync('test-results/trip/f/list.txt', 'ffconcat version 1.0\n' + frames.map(([t, f], i) => `file '${f.split('/').pop()}'\nduration ${((frames[i + 1]?.[0] ?? t + 0.1) - t).toFixed(3)}`).join('\n') + '\n');
console.log('frames', frames.length, 'over', frames.at(-1)[0].toFixed(1), 's');
for (const [t, a, b] of log) console.log(t, JSON.stringify(a), JSON.stringify(b));
const sawB = { omen: log.some(([, , b]) => b.trip && b.out === 0), out: log.some(([, , b]) => b.out === 1), back: log.at(-1)[2].trip === false && log.at(-1)[2].out === 0 };
console.log('B saw', JSON.stringify(sawB));
await cA.close(); await cB.close(); await br.close(); await br2.close();
console.log('trip at', tTrip.toFixed(1));
} finally {
  await Promise.allSettled([br, br2].map((browser) => browser.close()));
}
