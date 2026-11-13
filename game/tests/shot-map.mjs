// One-off check (#228 C): L1 first-minute tips (#tut) and the 平面图 (M / 地图 button); desktop A + mobile B in one room (real ws).
// Usage: PORT=4228 node dist-server/index.js & URL=http://127.0.0.1:4228 node tests/shot-map.mjs
import { chromium } from '@playwright/test';
import { browserArgs } from './browser-args.mjs';
import { assertDebugAvailable } from './helpers.mjs';

const base = process.env.URL ?? 'http://127.0.0.1:4228';
const out = process.env.OUT ?? 'test-results/v228';
const browser = await chromium.launch({ args: browserArgs() });
try {
const A = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
const B = await (await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })).newPage();
for (const [n, p] of [['A', A], ['B', B]]) p.on('pageerror', (e) => console.log(n, 'pageerror', e.message));
const until = (p, fn, arg, timeout = 300_000) => p.waitForFunction(fn, arg, { timeout });
const ui = (p) => p.evaluate(() => {
  const g = window.__escape.game();
  const r = (id) => { const e = document.getElementById(id); if (!e || e.hidden || getComputedStyle(e).display === 'none' || !e.textContent) return null; const b = e.getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom].map(Math.round); };
  const ids = ['tut', 'objective', 'banner', 'prompt', 'subtitle', 'goal-arrow', 'room-code', 'touch-chat', 'touch-map', 'battery', 'keys', 'team', 'chat-log'];
  const box = Object.fromEntries(ids.map((i) => [i, r(i)]));
  const hit = (a, b) => a && b && a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
  const over = [];
  for (const a of ['tut', 'touch-map']) for (const b of ids) if (a !== b && hit(box[a], box[b])) over.push(`${a}×${b}`);
  const map = document.getElementById('map');
  return {
    tut: document.getElementById('tut').hidden ? '' : document.getElementById('tut').innerText.replace(/\n/g, ' '),
    tutDone: document.getElementById('tut').classList.contains('done'),
    map: map.hidden ? null : { head: map.querySelector('.mh').innerText.replace(/\n/g, ' '), box: (() => { const b = map.getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom].map(Math.round); })() },
    explored: [...g.explored].map((i) => `${g.plan.rooms[i].id}:${g.plan.rooms[i].name}`),
    arrowOn: g.arrowOn, arrowShown: !document.getElementById('goal-arrow').hidden,
    pos: [g.pos.x, g.pos.z].map((v) => +v.toFixed(1)), level: g.level.index, over, tutBox: box.tut, touchMap: box['touch-map'], chat: box['touch-chat'], objBox: box.objective,
  };
});
// two swiftshader pages on 4 busy cores get well under 1 fps each: render a page only for its screenshots (the game ticks on regardless)
const draw = (p, on) => p.evaluate((on) => new Promise((r) => { window.__escape.game().drawOn = on; requestAnimationFrame(() => requestAnimationFrame(() => r())); }), on);
const shot = async (p, tag) => { await draw(p, true); console.log(tag, JSON.stringify(await ui(p))); await p.screenshot({ path: `${out}-${tag}.png`, timeout: 90_000 }); await draw(p, false); };

await A.goto(base + '/'); await A.fill('#name', '甲'); await A.click('#create');
const code = await A.evaluate(async () => { while (!window.__escape.code) await new Promise((r) => setTimeout(r, 50)); return window.__escape.code; });
await B.goto(base + '/'); await B.fill('#name', '乙'); await B.fill('#code', code); await B.click('#join');
await until(A, () => document.getElementById('wait-members').textContent.includes('乙'));
await A.evaluate(() => document.getElementById('start').click());
for (const p of [A, B]) await until(p, () => window.__escape.game()?.spawnSynced);
await assertDebugAvailable(A);
await A.evaluate(() => window.__escape.debug('safe', 900));
// screenshots here take 10-40 s each, longer than the tips' 60 s window: re-open it (the step reached is kept) before each wait
const hold = (p) => p.evaluate(() => { window.__escape.game().tut.t0 = performance.now() / 1000; });
const tutUp = async (n) => { await hold(A); return until(A, (n) => { const e = document.getElementById('tut'); return !e.hidden && getComputedStyle(e).display !== 'none' && e.innerText.includes(`${n}/4`) && !e.classList.contains('done'); }, n); };
const tutUpB = async (n) => { await hold(B); return until(B, (n) => { const e = document.getElementById('tut'); return !e.hidden && getComputedStyle(e).display !== 'none' && e.innerText.includes(`${n}/4`) && !e.classList.contains('done'); }, n); };
await Promise.all([A, B].map((p) => draw(p, false)));
await Promise.all([tutUp(1), tutUpB(1)]);
await shot(A, 'tut1-desk'); await shot(B, 'tut1-mob');

if (!process.env.MAP_ONLY) {
// A walks (real keys), B through the stick's keys; each tip then gives way to the next
// swiftshader runs ~3-10 fps here and frames are dt-clamped: hold W until the tip moves on (it needs 3 m), log how long
const walkTill = async (p, down, up, n) => {
  const t0 = Date.now(), from = (await ui(p)).pos;
  await down();
  await (n === 'A' ? tutUp(2) : tutUpB(2)).finally(up);
  const to = (await ui(p)).pos;
  console.log(n, 'walked', Math.hypot(to[0] - from[0], to[1] - from[1]).toFixed(1), 'm in', Date.now() - t0, 'ms');
};
await A.mouse.click(640, 560); // the renderer's canvas (pointer lock), as a player would
await walkTill(A, () => A.evaluate(() => window.__escape.game().input.press('KeyW')), () => A.evaluate(() => window.__escape.game().input.release('KeyW')), 'A');
await shot(A, 'tut2-desk');
await walkTill(B, () => B.evaluate(() => window.__escape.game().input.press('KeyW')), () => B.evaluate(() => window.__escape.game().input.release('KeyW')), 'B');
await B.locator('.touch-btn', { hasText: '手电' }).tap();
await tutUpB(3); await shot(B, 'tut3-mob');
await A.keyboard.press('KeyF');
await tutUp(3); await shot(A, 'tut3-desk');
// a door: 教室 s1's door (id 1, x -45.15 on its north wall z 72.06); stand 0.9 m north of it facing south (yaw 0 looks -z)
await A.evaluate(() => window.__escape.debug('tp', -45.15, 73.0, 0));
await until(A, () => Math.hypot(window.__escape.game().pos.x + 45.15, window.__escape.game().pos.z - 73) < 0.3);
await A.evaluate(() => { const i = window.__escape.game().input; i.yaw = 0; i.pitch = -0.1; });
await until(A, () => document.getElementById('prompt').textContent.includes('E'));
console.log('prompt at door:', await A.evaluate(() => document.getElementById('prompt').textContent));
await A.keyboard.press('KeyE');
await tutUp(4); await shot(A, 'tut4-desk');
}
await A.keyboard.press('KeyM');
await until(A, () => !document.getElementById('map').hidden);
await A.waitForTimeout(600);
await shot(A, 'map-l1-desk');
console.log('A tut after M:', JSON.stringify((await ui(A)).tut));
await A.keyboard.press('KeyM');

// A goes into 教室 s1: B's plan ticks it (A's position over the ws) and shows 甲 there
await A.evaluate(() => window.__escape.debug('tp', -49, 68, 0));
await until(B, () => { const g = window.__escape.game(); return [...g.explored].some((i) => g.plan.rooms[i].id === 's1'); });
await B.locator('#touch-map').tap();
await until(B, () => !document.getElementById('map').hidden);
await B.waitForTimeout(600);
await shot(B, 'map-l1-mob');
await B.locator('#map .mb.arrow').tap();
await B.waitForTimeout(500);
console.log('B arrow after map toggle:', JSON.stringify(await B.evaluate(() => ({ on: window.__escape.game().arrowOn, ls: localStorage.getItem('escape.arrow'), btn: document.querySelector('#map .mb.arrow').textContent, shown: !document.getElementById('goal-arrow').hidden }))));
await B.locator('#map .mb.arrow').tap();
await B.waitForTimeout(500);
console.log('B arrow back:', JSON.stringify(await B.evaluate(() => ({ on: window.__escape.game().arrowOn, ls: localStorage.getItem('escape.arrow'), btn: document.querySelector('#map .mb.arrow').textContent }))));
await B.locator('#map .mb.close').tap();
await until(B, () => document.getElementById('map').hidden);
console.log('B map closed; tut B:', JSON.stringify((await ui(B)).tut));

// L2: key, everyone to the exit
await A.evaluate(() => window.__escape.debug('key', -1));
const exit = await A.evaluate(() => window.__escape.game().level.exit);
for (const [i, p] of [A, B].entries()) await p.evaluate(([x, z, f]) => window.__escape.debug('tp', x, z, f), [exit.x + 2, exit.z + (i - 0.5) * 0.8, Math.round(exit.y / 3.6)]);
for (const p of [A, B]) await until(p, () => window.__escape.game().level.index === 1 && window.__escape.game().spawnSynced, undefined, 180_000);
await A.evaluate(() => window.__escape.debug('safe', 900));
for (const p of [A, B]) await until(p, () => document.getElementById('banner').hidden);
await A.waitForTimeout(1500);
await A.keyboard.press('KeyM');
await B.locator('#touch-map').tap();
for (const p of [A, B]) await until(p, () => !document.getElementById('map').hidden);
await A.waitForTimeout(600);
await shot(A, 'map-l2-desk'); await shot(B, 'map-l2-mob');
await browser.close();
} finally {
  await browser.close();
}
