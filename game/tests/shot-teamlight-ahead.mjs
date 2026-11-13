// One-off check (not in the gate; review #188 repro): A (torch off) looks ahead; B stands 3 m in front of A facing the
// same way (pitch -0.1) and switches its torch on/off; C is either dark or lit somewhere else. A's frame mean and
// centre-third brightness must rise clearly with B's torch on → test-results/tla-{c}-{b}.png.
// C is a Node ws bot, not a third chromium: three swiftshader browsers OOM on a 3.9 GB box and starve A to ~1 fps.
import { chromium } from '@playwright/test';
import { browserArgs } from './browser-args.mjs';
import { assertDebugAvailable, nearPosition, placeNear } from './helpers.mjs';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import WebSocket from 'ws';
const base = `http://127.0.0.1:${process.env.PORT ?? 4198}`;
const W = 640, H = 360;
const ARGS = browserArgs(['--disable-background-timer-throttling', '--disable-renderer-backgrounding']);
const names = ['甲', '乙'];
const brs = await Promise.all(names.map(() => chromium.launch({ args: ARGS })));
let C, cInput;
try {
const ctxs = await Promise.all(brs.map((b, i) => b.newContext({ baseURL: base, viewport: i ? { width: 320, height: 200 } : { width: W, height: H } })));
const [A, B] = await Promise.all(ctxs.map((c) => c.newPage()));
// A opens ?steady: the 日光灯 flicker (on ~1.2 s of every 7.3 s, scene.ts tubeFlicker) is held off, so bon/boff differ only by B's torch
for (const [i, p] of [A, B].entries()) { await p.goto(i ? '/?nodraw' : '/?nodraw&steady'); await p.fill('#name', names[i]); }
await A.click('#create');
const code = await A.evaluate(async () => { while (!window.__escape.code) await new Promise((r) => setTimeout(r, 50)); return window.__escape.code; });
await B.fill('#code', code);
await B.click('#join');
// C (丙): holds still where the server put it (spawn: its first snap entry; start() sends no correct), re-sending its look
// and torch flag every 50 ms in the current correction epoch; a forced correct (tp) moves it and starts a new epoch
C = { id: -1, p: null, c: 0, light: false, ws: new WebSocket(base.replace('http', 'ws') + '/ws') };
C.ws.on('message', (d) => {
  const m = JSON.parse(String(d));
  if (m.t === 'welcome') C.id = m.id;
  if (m.t === 'snap' && !C.p) C.p = m.players.find((q) => q.id === C.id)?.p ?? null;
  if (m.t === 'correct') { C.p = m.p; C.c = m.c ?? C.c; }
});
await new Promise((r, j) => { C.ws.once('open', r); C.ws.once('error', j); });
C.ws.send(JSON.stringify({ t: 'hello', name: '丙' }));
C.ws.send(JSON.stringify({ t: 'join', code }));
let seq = 0;
cInput = setInterval(() => {
  if (C.p) C.ws.send(JSON.stringify({ t: 'input', seq: ++seq, p: C.p, yaw: -Math.PI / 2, pitch: -0.4, f: C.light ? 4 : 0, c: C.c }));
}, 50);
const cTp = async (x, z) => {
  const area = await A.evaluate(() => window.__escape.game().level.def.area);
  const target = nearPosition({ x: C.p[0], y: C.p[1], z: C.p[2] }, area, x - C.p[0], z - C.p[2]);
  await new Promise((resolve, reject) => {
    let corrected;
    const finish = (error) => { clearTimeout(timer); C.ws.off('message', watch); error ? reject(error) : resolve(); };
    const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 0.08;
    const watch = (data) => {
      const m = JSON.parse(String(data));
      if (m.t === 'correct' && m.forced) {
        if (Math.hypot(m.p[0] - target.x, m.p[2] - target.z) >= 0.08 || Math.round(m.p[1] / 3.6) !== Math.round(target.y / 3.6)) {
          finish(new Error(`C: server refused target ${JSON.stringify(target)}; got ${JSON.stringify(m.p)}`)); return;
        }
        corrected = m.p;
      }
      if (m.t === 'snap' && corrected) {
        const self = m.players.find((p) => p.id === C.id);
        if (self) finish(near(self.p, corrected) ? null : new Error(`C: snapshot did not confirm XYZ placement: ${JSON.stringify(self.p)}`));
      }
    };
    const timer = setTimeout(() => finish(new Error('C: no debug tp confirmation; use NODE_ENV=development')), 2500);
    C.ws.on('message', watch);
    C.ws.send(JSON.stringify({ t: 'debug', op: 'tp', x, z }));
  });
};
await A.waitForSelector('#wait-members li:nth-child(3)');
await A.click('#start');
for (const p of [A, B]) await p.waitForFunction(() => window.__escape.game()?.spawnSynced, null, { timeout: 90_000 });
await assertDebugAvailable(A);
const placeAt = async (page, x, z) => {
  const origin = await page.evaluate(() => { const g = window.__escape.game(); return { x: g.pos.x, z: g.pos.z }; });
  return placeNear(page, x - origin.x, z - origin.z);
};
for (let k = 0; !C.p; k++) { if (k > 200) throw new Error('C: not in any snap'); await new Promise((r) => setTimeout(r, 50)); }
const fps = (p) => p.evaluate(async () => { let fr = 0, on = true; const f = () => { fr++; if (on) requestAnimationFrame(f); }; requestAnimationFrame(f); await new Promise((r) => setTimeout(r, 1000)); on = false; return fr; });
for (let k = 0; k < 60 && (await fps(A)) < 20; k++);
if (process.env.AT) { const [x, z] = process.env.AT.split(',').map(Number); await placeAt(A, x, z); }
await A.waitForTimeout(800);
const a = await A.evaluate(() => { const g = window.__escape.game(); g.input.yaw = 0; g.input.pitch = -0.1; g.light = false; return { x: g.pos.x, z: g.pos.z }; });
await placeAt(B, a.x, a.z - 3);
await B.evaluate(() => { const g = window.__escape.game(); g.input.yaw = 0; g.input.pitch = -0.1; });
// C: 8 m off to A's right-behind, lighting the floor away from A
await cTp(a.x + 6, a.z + 5);
mkdirSync('test-results', { recursive: true });
// exploration: TL='{"k":2,"distance":30,"angle":0.55,"penumbra":0.45}' rescales / reshapes A's team light(s)
if (process.env.TL) await A.evaluate((o) => { const g = window.__escape.game();
  for (const l of g.teamLights) { const k = o.k ?? 1; let v = l.intensity; Object.defineProperty(l, 'intensity', { get: () => v, set: (x) => { v = x * k; }, configurable: true });
    for (const f of ['distance', 'angle', 'penumbra', 'decay']) if (o[f] !== undefined) l[f] = o[f]; } }, JSON.parse(process.env.TL));
const shot = async (name, bLight, cLight) => {
  await B.evaluate((l) => { window.__escape.game().light = l; }, bLight);
  C.light = cLight;
  await A.waitForTimeout(2500);
  const r = await A.evaluate((haze) => {
    const g = window.__escape.game();
    const lights = g.teamLights.map((l) => +l.intensity.toFixed(2));
    const holders = g.teamPick.slots.map((p) => (p.holder === undefined ? '-' : g.names.get(p.holder)));
    const cones = [...g.remotes].map(([id, rm]) => { const c = rm.st.cone; c.updateWorldMatrix(true, false); const e = c.matrixWorld.elements;
      return `${g.names.get(id)}:${c.visible ? 'vis' : 'hid'} s${Math.hypot(e[0], e[1], e[2]).toFixed(2)} o(${e[12].toFixed(1)},${e[13].toFixed(1)},${e[14].toFixed(1)}) par${c.parent ? 1 : 0}`; });
    if (haze) for (const [, rm] of g.remotes) rm.st.cone.material.uniforms.color.value.setScalar(haze);
    g.draw = true;
    const cs = g.campus, tu = cs.world.interior.intTube.value;
    return { holders, lights, env: [cs.blackout, cs.minute, +cs.tod.sample.windows.toFixed(2), +cs.tod.sample.lamps.toFixed(2), +tu.r.toFixed(2), g.level?.def?.id ?? g.levelIdx], cones, cam: g.camera.getWorldPosition(g.camera.position.clone()).toArray().map((v) => +v.toFixed(1)), pos: [+g.pos.x.toFixed(1), +g.pos.z.toFixed(1)] };
  }, +(process.env.HAZE ?? 0));
  await A.waitForTimeout(1200);
  const file = `test-results/tla-${name}.png`;
  await A.screenshot({ path: file, timeout: 90_000 });
  await A.evaluate(() => { window.__escape.game().draw = false; });
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
  const box = (x0, y0, x1, y1) => { let s = 0, n = 0; for (let y = Math.round(y0); y < y1; y++) for (let x = Math.round(x0); x < x1; x++) { s += raw[y * W + x]; n++; } return s / n; };
  const res = { frame: box(0, 0, W, H), centre: box(W / 3, H / 3, (2 * W) / 3, (2 * H) / 3) };
  console.log(name, JSON.stringify(r), 'frame', res.frame.toFixed(2), 'centre', res.centre.toFixed(2));
  return res;
};
if (process.env.OWN) { await A.evaluate(() => { window.__escape.game().light = true; }); await shot('aown', false, false); await A.evaluate(() => { window.__escape.game().light = false; }); }
let ok = true;
for (const c of ['coff', 'con']) {
  const on = await shot(`${c}-bon`, true, c === 'con'), off = await shot(`${c}-boff`, false, c === 'con');
  const df = on.frame - off.frame, dc = on.centre - off.centre;
  console.log(c, 'Δframe', df.toFixed(2), 'Δcentre', dc.toFixed(2), df >= 1 && dc >= 2 ? 'OK' : 'FAIL');
  ok &&= df >= 1 && dc >= 2;
}
// FPS=1: A's drawn fps with both teammates' torches on (2 team SpotLights live) vs both off (0)
if (process.env.FPS) for (const l of [true, false, true, false]) {
  await B.evaluate((l) => { window.__escape.game().light = l; }, l);
  C.light = l;
  await A.evaluate(() => { window.__escape.game().draw = true; });
  await A.waitForTimeout(2500);
  const n = await A.evaluate(() => window.__escape.game().teamLights.filter((t) => t.intensity > 0).length);
  console.log('fps', l ? 'on' : 'off', 'teamLights', n, 'fps', await fps(A), await fps(A), await fps(A));
  await A.evaluate(() => { window.__escape.game().draw = false; });
}
clearInterval(cInput);
C.ws.close();
for (const c of ctxs) await c.close();
for (const b of brs) await b.close();
process.exitCode = ok ? 0 : 1;
} finally {
  clearInterval(cInput);
  C?.ws.close();
  await Promise.allSettled(brs.map((browser) => browser.close()));
}
