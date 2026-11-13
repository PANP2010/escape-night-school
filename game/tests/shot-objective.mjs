// One-off check (#219): level banner → objective panel, step banners, idle hint; desktop A + mobile B in one room (real ws).
// Usage: PORT=4211 node dist-server/index.js & node tests/shot-objective.mjs
import { chromium } from '@playwright/test';
import { browserArgs } from './browser-args.mjs';
import { assertDebugAvailable } from './helpers.mjs';

const base = process.env.URL ?? 'http://127.0.0.1:4211';
const browser = await chromium.launch({ args: browserArgs() });
try {
const A = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
const B = await (await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })).newPage();
for (const [n, p] of [['A', A], ['B', B]]) p.on('pageerror', (e) => console.log(n, 'pageerror', e.message));
const pages = { A, B };
const ui = (p) => p.evaluate(() => {
  const r = (id) => { const e = document.getElementById(id); if (!e || e.hidden || getComputedStyle(e).display === 'none') return null; const b = e.getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom].map(Math.round); };
  const ids = ['objective', 'banner', 'room-code', 'touch-chat', 'team', 'prompt', 'battery', 'keys', 'stamina', 'hint', 'chat-log'];
  const box = Object.fromEntries(ids.map((i) => [i, r(i)]));
  const hit = (a, b) => a && b && a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
  const over = [];
  for (const a of ['objective', 'banner']) for (const b of ids) if (a !== b && hit(box[a], box[b])) over.push(`${a}×${b}`);
  return { panel: document.getElementById('objective').innerText.replace(/\n/g, ' | '), banner: document.getElementById('banner').hidden ? '' : document.getElementById('banner').innerText.replace(/\n/g, ' | '), sub: document.getElementById('subtitle').textContent, over, obj: box.objective, ban: box.banner };
});
const shot = async (tag) => {
  for (const [n, p] of Object.entries(pages)) {
    console.log(tag, n, JSON.stringify(await ui(p)));
    await p.screenshot({ path: `test-results/iter-219-${tag}-${n === 'A' ? 'desk' : 'mob'}.png`, timeout: 90_000 });
  }
};
const until = (p, fn, arg) => p.waitForFunction(fn, arg, { timeout: 120_000 });
// the banner is up for 3 s and a ui() eval + screenshot under swiftshader takes about that long: shoot each page the moment its banner shows
// the predicate freezes the banner's hide timers the moment it is seen (screenshot latency only); they are re-armed right after the shot
const freeze = (cond) => `(() => { const t = (${cond})(); if (t) window.__escape.game().bannerTimers.forEach(clearTimeout); return t; })()`;
const bannerShot = (tag, cond) => Promise.all(Object.entries(pages).map(async ([n, p]) => {
  const t = await (await until(p, freeze(cond)).catch(async (e) => {
    console.log(tag, n, 'no banner:', await p.evaluate(() => { const g = window.__escape.game(); return JSON.stringify({ pending: g.objPending, synced: g.spawnSynced, hidden: document.getElementById('banner').hidden, cls: document.getElementById('banner').className, lvl: g.level.index }); }));
    throw e;
  })).jsonValue();
  await p.screenshot({ path: `test-results/iter-219-${tag}-${n === 'A' ? 'desk' : 'mob'}.png`, timeout: 90_000 });
  await p.evaluate(() => { const g = window.__escape.game(), el = document.getElementById('banner'); g.bannerTimers = [setTimeout(() => { el.classList.add('out'); document.getElementById('objective').hidden = false; }, 0), setTimeout(() => { el.hidden = true; }, 600)]; });
  console.log(tag, n, 'banner:', t, '| after shot:', JSON.stringify(await ui(p)));
}));

await A.goto(base + '/'); await A.fill('#name', '甲'); await A.click('#create');
const code = await A.evaluate(async () => { while (!window.__escape.code) await new Promise((r) => setTimeout(r, 50)); return window.__escape.code; });
await B.goto(base + '/'); await B.fill('#name', '乙'); await B.fill('#code', code); await B.click('#join');
await until(A, () => document.getElementById('wait-members').textContent.includes('乙'));
// arm the banner wait before starting: the pages load at different speeds and one page's 3 s banner can be over while waiting for the other
const bannerUp = () => !document.getElementById('banner').hidden && document.getElementById('banner').innerText;
const l1Banner = bannerShot('l1-banner', bannerUp);
await A.evaluate(() => document.getElementById('start').click());
await l1Banner;
await until(A, () => window.__escape.game()?.spawnSynced);
await assertDebugAvailable(A);
await A.evaluate(() => window.__escape.debug('safe', 600));
for (const p of [A, B]) await until(p, () => document.getElementById('banner').hidden);
await shot('l1-panel');

// idle hint: pretend 46 s passed without progress
await A.evaluate(() => { window.__escape.game().idle.since -= 46; });
console.log('idle hint A:', await (await until(A, () => document.querySelector('#objective .tip').textContent)).jsonValue(), JSON.stringify(await ui(A)));
await A.screenshot({ path: 'test-results/iter-219-l1-idle-desk.png', timeout: 90_000 });

await A.evaluate(() => window.__escape.debug('key', -1));
await bannerShot('l1-step', () => document.getElementById('objective').innerText.includes('2/2') && !document.getElementById('banner').hidden && document.getElementById('banner').innerText);

const exit = await A.evaluate(() => window.__escape.game().level.exit);
for (const [i, p] of [A, B].entries()) await p.evaluate(([x, z, f]) => window.__escape.debug('tp', x, z, f), [exit.x + 2, exit.z + (i - 0.5) * 0.8, Math.round(exit.y / 3.6)]);
const l2Safe = until(A, () => window.__escape.game().level.index === 1).then(() => A.evaluate(() => window.__escape.debug('safe', 600)));
await bannerShot('l2-banner', () => window.__escape.game().level.index === 1 && !document.getElementById('banner').hidden && document.getElementById('banner').innerText);
await l2Safe;
for (const p of [A, B]) await until(p, () => document.getElementById('banner').hidden);
await shot('l2-panel');
await A.evaluate(() => window.__escape.debug('key', -2));
await bannerShot('l2-step', () => document.getElementById('objective').innerText.includes('目标 2/3') && !document.getElementById('banner').hidden && document.getElementById('banner').innerText);
await browser.close();
} finally {
  await browser.close();
}
