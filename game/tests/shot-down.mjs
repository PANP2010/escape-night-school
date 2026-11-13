// One-off check (not in the gate): a downed teammate as A sees them over the real ws server.
// B stands 1.8 m ahead of A, goes down (debug), A screenshots + measures B's skinned body bounds, A holds revive, measures again.
// → test-results/down-{stand,lying,up}.png and test-results/down-video/*.webm (A's view); prints heights and the video time of each step.
import { chromium } from '@playwright/test';
import { browserArgs } from './browser-args.mjs';
import { assertDebugAvailable } from './helpers.mjs';
import { mkdirSync } from 'node:fs';
const base = `http://127.0.0.1:${process.env.PORT ?? 4198}`;
const ARGS = browserArgs(['--disable-background-timer-throttling', '--disable-renderer-backgrounding']);
mkdirSync('test-results/down-video', { recursive: true });
const brs = await Promise.all([0, 1].map(() => chromium.launch({ args: ARGS })));
try {
const ca = await brs[0].newContext({ baseURL: base, viewport: { width: 640, height: 360 }, recordVideo: { dir: "test-results/down-video", size: { width: 640, height: 360 } } });
const cb = await brs[1].newContext({ baseURL: base, viewport: { width: 320, height: 200 } });
const [A, B] = await Promise.all([ca.newPage(), cb.newPage()]);
const t0 = Date.now(), at = () => ((Date.now() - t0) / 1000).toFixed(1);
for (const [p, n] of [[A, '甲'], [B, '乙']]) { await p.goto('/?nodraw'); await p.fill('#name', n); }
await A.click('#create');
const code = await A.evaluate(async () => { while (!window.__escape.code) await new Promise((r) => setTimeout(r, 50)); return window.__escape.code; });
await B.fill('#code', code); await B.click('#join');
await A.waitForSelector('#wait-members li:nth-child(2)');
await A.click('#start');
for (const p of [A, B]) await p.waitForFunction(() => window.__escape.game()?.spawnSynced, null, { timeout: 90_000 });
await assertDebugAvailable(A);
const fps = (p) => p.evaluate(async () => { let fr = 0, on = true; const f = () => { fr++; if (on) requestAnimationFrame(f); }; requestAnimationFrame(f); await new Promise((r) => setTimeout(r, 1000)); on = false; return fr; });
for (let k = 0; k < 60 && (await fps(A)) < 15; k++);
const a = await A.evaluate(() => { const g = window.__escape.game(); g.input.yaw = 0; g.input.pitch = -0.35; g.light = true; g.draw = true; return { x: g.pos.x, z: g.pos.z }; });
await B.evaluate(([x, z]) => window.__escape.debug('tp', x, z), [a.x + 0.3, a.z - 1.8]);
await B.evaluate(() => { const g = window.__escape.game(); g.input.yaw = Math.PI / 2; g.input.pitch = 0; g.light = true; });
await A.waitForTimeout(1500);
// B's skinned bounds in A's scene, relative to B's feet; also where B's torch and name tag are
const measure = () => A.evaluate(() => {
  const g = window.__escape.game(), id = [...g.names].find(([, n]) => n === '乙')[0], r = g.remotes.get(id);
  r.mesh.updateMatrixWorld(true);
  const m = r.st.warden.mesh; m.computeBoundingBox();
  const b = m.boundingBox.clone().applyMatrix4(m.matrixWorld), y0 = r.mesh.position.y;
  const o = new window.__escape.THREE.Vector3(), d = o.clone(); r.st.beam(o, d);
  return { id, down: r.down, fallen: +r.st.fallen.toFixed(2), h: +(b.max.y - y0).toFixed(3), low: +(b.min.y - y0).toFixed(3), torchY: +(o.y - y0).toFixed(2), marker: r.marker ? +r.marker.position.y.toFixed(2) : null };
});
const stand = await measure(); console.log(at(), 'stand', JSON.stringify(stand));
await A.screenshot({ path: 'test-results/down-stand.png' });
console.log(at(), 'down');
// per-frame trace of B's fall in A's renderer: [ms since start, fallen, down]
await A.evaluate(() => { const g = window.__escape.game(), id = [...g.names].find(([, n]) => n === '乙')[0], t = performance.now(); window.__tr = []; const f = () => { const r = g.remotes.get(id); window.__tr.push([Math.round(performance.now() - t), +r.st.fallen.toFixed(2), r.down]); requestAnimationFrame(f); }; requestAnimationFrame(f); });
await B.evaluate(() => window.__escape.debug('down'));
await A.waitForTimeout(2500);
const lying = await measure(); console.log(at(), 'lying', JSON.stringify(lying));
await A.screenshot({ path: 'test-results/down-lying.png' });
await A.waitForTimeout(1500);
console.log(at(), 'revive hold');
const held = await A.evaluate(async (id) => {
  const g = window.__escape.game(), t = performance.now();
  while (performance.now() - t < 12000 && g.remotes.get(id).down) { window.__escape.net.send({ t: 'act', kind: 'revive', id }); await new Promise((r) => setTimeout(r, 50)); }
  return Math.round(performance.now() - t);
}, lying.id);
console.log(at(), 'revived after', held, 'ms');
await A.waitForTimeout(2500);
const tr = await A.evaluate(() => window.__tr); const flips = tr.filter((e, i) => i === 0 || e[1] !== tr[i - 1][1]); console.log('trace', JSON.stringify(flips.filter((e) => e[1] > 0 && e[1] < 1 || flips.indexOf(e) < 3).slice(0, 80)), 'frames', tr.length, 'span', tr.at(-1)[0]);
const up = await measure(); console.log(at(), 'up', JSON.stringify(up));
await A.screenshot({ path: 'test-results/down-up.png' });
await A.waitForTimeout(1000);
console.log('RESULT', lying.h < 0.6 && up.h >= 1.5 && lying.down && !up.down ? 'PASS' : 'FAIL');
await ca.close(); await cb.close();
console.log('video', await A.video().path());
for (const b of brs) await b.close();
} finally {
  await Promise.allSettled(brs.map((browser) => browser.close()));
}
