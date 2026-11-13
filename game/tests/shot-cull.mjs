// One-off check (not in the gate): a teammate's skinned body is frustum-culled on A's screen, its torch is not.
// Real ws server (dist-server on PORT), two browsers. B stands 3.5 m in front of A, then 5.5 m behind A shining forward.
import { chromium } from '@playwright/test';
import { browserArgs } from './browser-args.mjs';
import { assertDebugAvailable, placeNear } from './helpers.mjs';
import { mkdirSync } from 'node:fs';
const base = `http://127.0.0.1:${process.env.PORT ?? 4198}`;
const ARGS = browserArgs(['--disable-background-timer-throttling', '--disable-renderer-backgrounding']);
const ba = await chromium.launch({ args: ARGS }), bb = await chromium.launch({ args: ARGS });
try {
const ctxA = await ba.newContext({ baseURL: base, viewport: { width: 640, height: 360 } });
const ctxB = await bb.newContext({ baseURL: base, viewport: { width: 400, height: 260 } });
const A = await ctxA.newPage(), B = await ctxB.newPage();
await A.goto('/?nodraw'); await B.goto('/?nodraw');
await A.fill('#name', '甲'); await B.fill('#name', '乙');
await A.click('#create');
const code = await A.evaluate(async () => { while (!window.__escape.code) await new Promise((r) => setTimeout(r, 50)); return window.__escape.code; });
await B.fill('#code', code); await B.click('#join');
await A.waitForSelector('#wait-members li:nth-child(2)');
await A.click('#start');
for (const p of [A, B]) await p.waitForFunction(() => window.__escape.game()?.spawnSynced, null, { timeout: 60_000 });
await assertDebugAvailable(B);
const placeAt = async (page, x, z) => {
  const origin = await page.evaluate(() => { const g = window.__escape.game(); return { x: g.pos.x, z: g.pos.z }; });
  return placeNear(page, x - origin.x, z - origin.z);
};
await A.waitForTimeout(3000);
const a = await A.evaluate(() => { const g = window.__escape.game(); g.input.yaw = 0; g.input.pitch = -0.12; g.light = false; return { x: g.pos.x, z: g.pos.z }; });
mkdirSync('test-results', { recursive: true });
const pose = async (name, dz) => {
  await placeAt(B, a.x, a.z + dz);
  await B.evaluate(() => { const g = window.__escape.game(); g.input.yaw = 0; g.input.pitch = -0.35; g.light = true; });
  await A.waitForTimeout(2500);
  await A.evaluate(() => { window.__escape.game().draw = true; });
  await A.waitForFunction(() => window.__escape.stats().calls > 0, null, { timeout: 60_000 });
  await A.waitForTimeout(1500);
  const r = await A.evaluate(() => { const g = window.__escape.game(); const r = [...g.remotes.values()][0]; const c = g.camera;
    return { cam: [+c.position.x.toFixed(2), +c.position.z.toFixed(2), +c.rotation.y.toFixed(2)], root: r.mesh.visible, body: r.st.warden.root.visible, spot: r.st.spot.visible, b: [+r.mesh.position.x.toFixed(2), +r.mesh.position.z.toFixed(2)], ...window.__escape.stats() }; });
  await A.screenshot({ path: `test-results/cull-${name}.png` });
  await A.evaluate(() => { window.__escape.game().draw = false; });
  console.log(name, JSON.stringify(r));
};
await pose('front', -3.5);
await pose('behind', 5.5);
await ctxA.close(); await ctxB.close(); await ba.close(); await bb.close();
} finally {
  await Promise.allSettled([ba, bb].map((browser) => browser.close()));
}
