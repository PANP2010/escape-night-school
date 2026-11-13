// One-off check (not in the gate): can A target / revive a downed B by aiming at B's head, upper body or legs, over the real ws server?
// B goes down facing yaw PSI; A is put at points around B's body, looks at a body part and reports what its crosshair targets
// (client ray) and, at the head end, holds E until B is up (server reach). → test-results/revive-*.png
import { chromium } from '@playwright/test';
import { browserArgs } from './browser-args.mjs';
import { assertDebugAvailable } from './helpers.mjs';
import { mkdirSync } from 'node:fs';
const base = `http://127.0.0.1:${process.env.PORT ?? 4198}`;
const ARGS = browserArgs(['--disable-background-timer-throttling', '--disable-renderer-backgrounding']);
const PSI = +(process.env.PSI ?? 0.7); // B's facing while down (not axis-aligned on purpose; PSI=0.785 → 45°, where a world AABB is widest)
mkdirSync('test-results', { recursive: true });
const brs = await Promise.all([0, 1].map(() => chromium.launch({ args: ARGS })));
try {
const ca = await brs[0].newContext({ baseURL: base, viewport: { width: 640, height: 360 } });
const cb = await brs[1].newContext({ baseURL: base, viewport: { width: 320, height: 200 } });
const [A, B] = await Promise.all([ca.newPage(), cb.newPage()]);
for (const [p, n] of [[A, '甲'], [B, '乙']]) { await p.goto('/?nodraw'); await p.fill('#name', n); }
await A.click('#create');
const code = await A.evaluate(async () => { while (!window.__escape.code) await new Promise((r) => setTimeout(r, 50)); return window.__escape.code; });
await B.fill('#code', code); await B.click('#join');
await A.waitForSelector('#wait-members li:nth-child(2)');
await A.click('#start');
for (const p of [A, B]) await p.waitForFunction(() => window.__escape.game()?.spawnSynced, null, { timeout: 90_000 });
await assertDebugAvailable(B);
const fps = (p) => p.evaluate(async () => { let fr = 0, on = true; const f = () => { fr++; if (on) requestAnimationFrame(f); }; requestAnimationFrame(f); await new Promise((r) => setTimeout(r, 1000)); on = false; return fr; });
for (let k = 0; k < 60 && (await fps(A)) < 15; k++);
const a = await A.evaluate(() => { const g = window.__escape.game(); g.light = true; g.draw = true; return { x: g.pos.x, z: g.pos.z }; });
await B.evaluate(([x, z]) => window.__escape.debug('tp', x, z), [a.x, a.z - 2.5]);
await B.evaluate((psi) => { const g = window.__escape.game(); g.input.yaw = psi; g.input.pitch = 0; g.light = true; }, PSI);
await A.waitForTimeout(1200);
await B.waitForFunction((psi) => Math.abs(window.__escape.game().input.yaw - psi) < 1e-3, PSI);
await A.waitForFunction((psi) => { const g = window.__escape.game(), id = [...g.names].find(([, n]) => n === '乙')?.[0], r = g.remotes.get(id); return r && Math.abs(r.mesh.rotation.y - psi) < 0.02; }, PSI, { timeout: 30_000 });
await B.evaluate(() => window.__escape.debug('down'));
await A.waitForFunction(() => { const g = window.__escape.game(), id = [...g.names].find(([, n]) => n === '乙')[0], r = g.remotes.get(id); return r.down && r.st.fallen >= 1; }, null, { timeout: 30_000 });
const bInfo = await A.evaluate(() => { const g = window.__escape.game(), id = [...g.names].find(([, n]) => n === '乙')[0], r = g.remotes.get(id); return { id, x: r.mesh.position.x, y: r.mesh.position.y, z: r.mesh.position.z, yaw: r.mesh.rotation.y, down: r.down }; });
console.log('B', JSON.stringify(bInfo));
await A.evaluate((id) => { window.__bid = id; }, bInfo.id);
// B's frame: forward f = (-sin, -cos) of its yaw, right r = (cos, -sin)
const fx = -Math.sin(bInfo.yaw), fz = -Math.cos(bInfo.yaw), rx = Math.cos(bInfo.yaw), rz = -Math.sin(bInfo.yaw);
const at = (fwd, right) => [bInfo.x + fx * fwd + rx * right, bInfo.z + fz * fwd + rz * right];
// [name, A stands at (fwd, right) in B's frame, aims at (fwd, right, height)]
const CASES = [
  ['head-front-1.6', [1.6 + 0.6, 0], [0.65, 0.15, 0.25]],
  ['head-front-1.2', [1.2 + 0.6, 0], [0.65, 0.15, 0.25]],
  ['chest-side-1.2', [0.3, 1.2 + 0.4], [0.3, 0.1, 0.3]],
  ['hand-right-1.2', [0.7, 1.2 + 0.7], [0.7, 0.66, 0.12]],
  ['feet-back-1.2', [-1.2 - 0.85, 0], [-0.8, -0.1, 0.25]],
  ['beside-hips-1.0', [0, -1.0 - 0.3], [0, 0, 0.25]],
];
const results = {};
// teleport A, wait till its camera is there, then re-aim a few frames running (the camera follows pos one frame late)
const place = (x, z, t) => A.evaluate(async ([x, z, [tx, ty, tz]]) => {
  const g = window.__escape.game(), sl = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__escape.debug('tp', x, z);
  for (let k = 0; k < 100 && Math.hypot(g.camera.position.x - x, g.camera.position.z - z) > 0.05; k++) await sl(50);
  for (let k = 0; k < 4; k++) { const c = g.camera.position, dx = tx - c.x, dz = tz - c.z; g.input.yaw = Math.atan2(-dx, -dz); g.input.pitch = Math.atan2(ty - c.y, Math.hypot(dx, dz)); await sl(150); }
  const c = g.camera.position;
  return +Math.hypot(tx - c.x, ty - c.y, tz - c.z).toFixed(2);
}, [x, z, t]);
for (const [name, st, aim] of CASES) {
  const [x, z] = at(st[0], st[1]);
  await B.evaluate(() => window.__escape.debug('down')); // re-arm the 30 s hold: screenshots under swiftshader are slow
  const [tx, tz] = at(aim[0], aim[1]);
  const dist = await place(x, z, [tx, bInfo.y + aim[2], tz]);
  const r = await A.evaluate(() => { const g = window.__escape.game(), t = g.target(); return { aOk: !g.down && !g.spectate, bDown: g.remotes.get(window.__bid).down, at: [+g.pos.x.toFixed(2), +g.pos.z.toFixed(2)], target: t ? `${t.kind}:${t.id}` : null, prompt: document.getElementById('prompt')?.textContent ?? '' }; });
  r.dist = dist;
  results[name] = r;
  console.log(name, JSON.stringify(r));
  await A.screenshot({ path: `test-results/revive-${name}.png`, timeout: 90_000 });
}
// hold E aiming at the head from 1.6 m in front of it: B must get up (early: on a long run 角色074 finds A standing still)
await B.evaluate(() => window.__escape.debug('down'));
const [x, z] = at(2.2, 0), [hx, hz] = at(0.65, 0.15);
console.log('hold from', await place(x, z, [hx, bInfo.y + 0.25, hz]), 'm');
await A.screenshot({ path: 'test-results/revive-hold.png', timeout: 90_000 });
// the client re-sends the hold once per rendered frame; swiftshader on a busy box drops to ~1 fps with drawing on, which is past the
// server's stale window, so hold with drawing off (targeting and the ring don't need it) and turn it back on for the screenshot
await A.evaluate(() => { window.__escape.game().draw = false; });
let fa = 0; for (let k = 0; k < 30 && (fa = await fps(A)) < 10; k++);
console.log('A fps before hold', fa);
await B.evaluate(() => window.__escape.debug('down')); // fresh 30 s
await A.waitForFunction((id) => window.__escape.game().remotes.get(id).down, bInfo.id);
const held = await A.evaluate(async (id) => {
  const g = window.__escape.game(), t = performance.now(), was = g.remotes.get(id).down, tg = g.target()?.kind;
  let acts = 0; const send = g.net.send.bind(g.net); g.net.send = (m) => { if (m.t === 'act') acts++; return send(m); };
  g.input.press('KeyE');
  while (performance.now() - t < 9000 && g.remotes.get(id).down) await new Promise((r) => setTimeout(r, 50));
  g.input.release('KeyE');
  return { was, tg, ms: Math.round(performance.now() - t), up: !g.remotes.get(id).down, hiding: g.hiding, acts, aDown: g.down, aOut: g.spectate, ring: !document.getElementById('revive-ring')?.hidden, at: [+g.pos.x.toFixed(2), +g.pos.z.toFixed(2)] };
}, bInfo.id);
await A.evaluate(() => { window.__escape.game().draw = true; });
const bSelf = await B.evaluate(() => { const g = window.__escape.game(); return g.down || g.spectate; });
console.log('hold at head', JSON.stringify(held), 'B sees itself down:', bSelf);
await A.waitForTimeout(1500);
await A.screenshot({ path: 'test-results/revive-up.png', timeout: 90_000 });
// bare floor off the body that a world AABB around it would take at 45° (0.4 m past the head end, 0.35 m off the right side):
// no prompt, and holding E there for 4 s leaves B down
const GAPS = [['gap-head-end', [2.45, 0], [1.25, 0, 0.05]], ['gap-right-side', [0, 2.3], [0, 1.1, 0.05]]];
for (const [name, st, aim] of GAPS) {
  await B.evaluate(() => window.__escape.debug('down'));
  const [x, z] = at(st[0], st[1]), [tx, tz] = at(aim[0], aim[1]);
  const dist = await place(x, z, [tx, bInfo.y + aim[2], tz]);
  await A.screenshot({ path: `test-results/revive-${name}.png`, timeout: 90_000 });
  const r = await A.evaluate(async (id) => {
    const g = window.__escape.game(), t = g.target(), prompt = document.getElementById('prompt')?.textContent ?? '';
    g.input.press('KeyE'); await new Promise((r) => setTimeout(r, 4000)); g.input.release('KeyE');
    return { target: t ? `${t.kind}:${t.id}` : null, prompt, stillDown: g.remotes.get(id).down };
  }, bInfo.id);
  r.dist = dist;
  results[name] = r;
  console.log(name, JSON.stringify(r));
}
// server reach: stand 2.1 m past the head end (the old AABB put it ≈ 1.3 m away) and send revive acts by hand for 4 s → refused
await B.evaluate(() => window.__escape.debug('down'));
{
  const [x, z] = at(2.95, 0), [hx, hz] = at(0.65, 0.15);
  await place(x, z, [hx, bInfo.y + 0.25, hz]);
  const r = await A.evaluate(async (id) => {
    const g = window.__escape.game(), t = performance.now();
    while (performance.now() - t < 4000) { g.net.send({ t: 'act', kind: 'revive', id }); await new Promise((r) => setTimeout(r, 50)); }
    return { at: [+g.pos.x.toFixed(2), +g.pos.z.toFixed(2)], stillDown: g.remotes.get(id).down };
  }, bInfo.id);
  results['server-far-2.1'] = r;
  console.log('server-far-2.1', JSON.stringify(r));
}
console.log('RESULT', held.was && held.up && !bSelf && Object.entries(results).every(([n, r]) => n.startsWith('gap-') ? r.target === null && r.stillDown : n.startsWith('server-') ? r.stillDown : r.target === `revive:${bInfo.id}`) ? 'PASS' : 'FAIL');
await ca.close(); await cb.close();
for (const b of brs) await b.close();
} finally {
  await Promise.allSettled(brs.map((browser) => browser.close()));
}
