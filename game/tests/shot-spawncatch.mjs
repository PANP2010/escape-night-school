// One-off check (not in the gate; review #188 / #193 repro): 甲 乙 (chromium) and 丙 (Node ws bot) stand together at the
// spawn; 甲 summons 角色074 7 m ahead. Phase 1 logs every catch (snap st 0 → 1) and 角色074's distance from the spawn for 15 s;
// phase 2 downs everyone (1 s) → team wipe → restart, then logs catches and 角色074's spawn distance for 8 s.
// Prints CATCHES lines and exits 1 if two catches come < 5 s apart, or any catch lands in the first 5 s after the restart.
import { chromium } from '@playwright/test';
import { browserArgs } from './browser-args.mjs';
import { assertDebugAvailable } from './helpers.mjs';
import { mkdirSync } from 'node:fs';
import WebSocket from 'ws';
const base = `http://127.0.0.1:${process.env.PORT ?? 4198}`;
const ARGS = browserArgs(['--disable-background-timer-throttling', '--disable-renderer-backgrounding']);
const names = ['甲', '乙'];
const brs = await Promise.all(names.map(() => chromium.launch({ args: ARGS })));
let C, cInput;
try {
const ctxs = await Promise.all(brs.map((b, i) => b.newContext({ baseURL: base, viewport: i ? { width: 320, height: 200 } : { width: 640, height: 360 } })));
const [A, B] = await Promise.all(ctxs.map((c) => c.newPage()));
for (const [i, p] of [A, B].entries()) { await p.goto(i ? '/?nodraw' : '/?steady'); await p.fill('#name', names[i]); }
await A.click('#create');
const code = await A.evaluate(async () => { while (!window.__escape.code) await new Promise((r) => setTimeout(r, 50)); return window.__escape.code; });
await B.fill('#code', code);
await B.click('#join');
// 丙: holds still at its spawn in the current correction epoch, looking the same way as 甲; also the snap logger
C = { id: -1, p: null, c: 0, ws: new WebSocket(base.replace('http', 'ws') + '/ws') };
const st = new Map(), log = [], names3 = new Map();
let t0 = 0, warden = null, spawn = null;
C.ws.on('message', (d) => {
  const m = JSON.parse(String(d));
  if (m.t === 'welcome') C.id = m.id;
  if (m.t === 'room') for (const q of m.players) names3.set(q.id, q.name);
  if (m.t === 'correct') { C.p = m.p; C.c = m.c ?? C.c; }
  if (m.t !== 'snap') return;
  if (!C.p) C.p = m.players.find((q) => q.id === C.id)?.p ?? null;
  const w = m.mobs.find((q) => q.id === 1);
  if (w) warden = w.p;
  for (const q of m.players) {
    const s = q.st ?? 0, was = st.get(q.id) ?? 0;
    if (s !== was && t0) log.push({ t: (Date.now() - t0) / 1000, who: names3.get(q.id) ?? q.id, from: was, to: s, warden: warden && spawn ? Math.hypot(warden[0] - spawn[0], warden[2] - spawn[2]) : NaN });
    st.set(q.id, s);
  }
});
await new Promise((r, j) => { C.ws.once('open', r); C.ws.once('error', j); });
C.ws.send(JSON.stringify({ t: 'hello', name: '丙' }));
C.ws.send(JSON.stringify({ t: 'join', code }));
let seq = 0, cYaw = 0;
cInput = setInterval(() => { if (C.p) C.ws.send(JSON.stringify({ t: 'input', seq: ++seq, p: C.p, yaw: cYaw, pitch: 0, f: 0, c: C.c })); }, 50);
await A.waitForSelector('#wait-members li:nth-child(3)');
await A.click('#start');
for (const p of [A, B]) await p.waitForFunction(() => window.__escape.game()?.spawnSynced, null, { timeout: 90_000 });
await assertDebugAvailable(A);
for (let k = 0; !C.p; k++) { if (k > 200) throw new Error('C: not in any snap'); await new Promise((r) => setTimeout(r, 50)); }
await A.waitForTimeout(1500);
const a = await A.evaluate(() => { const g = window.__escape.game(); return { x: g.pos.x, z: g.pos.z, yaw: g.input.yaw }; });
spawn = [a.x, 0, a.z];
cYaw = a.yaw;
console.log('spawn A', a, 'B', await B.evaluate(() => { const g = window.__escape.game(); return [g.pos.x, g.pos.z]; }), 'C', C.p);
mkdirSync('test-results', { recursive: true });
const wardenAt = () => (warden ? Math.hypot(warden[0] - spawn[0], warden[2] - spawn[2]).toFixed(1) : '?');
t0 = Date.now();
await A.evaluate(() => window.__escape.debug('warden', 7));
for (let s = 1; s <= 15; s++) {
  await A.waitForTimeout(1000);
  if (s === 3) await A.screenshot({ path: 'test-results/spawncatch-3s.png' });
  console.log(`t=${s}s warden ${wardenAt()} m from spawn, st`, JSON.stringify([...st]));
}
const p1 = log.filter((e) => e.to === 1);
console.log('CATCHES phase1', JSON.stringify(p1));
let ok = p1.length > 0;
for (let i = 1; i < p1.length; i++) if (p1[i].t - p1[i - 1].t < 5) ok = false;
// phase 2: everyone still up goes down for 1 s → spectate → team wipe → LEVEL_FADE_S → restart at the spawns
for (const p of [A, B]) await p.evaluate(() => window.__escape.debug('down', 1));
C.ws.send(JSON.stringify({ t: 'debug', op: 'down', s: 1 }));
const lvl0 = await A.evaluate(() => window.__escape.game()?.spawnSynced);
for (let k = 0; k < 400 && ![...st.values()].every((s) => s !== 0); k++) await A.waitForTimeout(50);
for (let k = 0; k < 400 && ![...st.values()].every((s) => s === 0); k++) await A.waitForTimeout(50);
const t1 = (Date.now() - t0) / 1000;
console.log('restart at', t1.toFixed(1), 's, warden', wardenAt(), 'm from spawn', lvl0);
for (let s = 1; s <= 8; s++) {
  await A.waitForTimeout(1000);
  if (s === 2) await A.screenshot({ path: 'test-results/spawncatch-restart.png' });
  console.log(`restart+${s}s warden ${wardenAt()} m from spawn, st`, JSON.stringify([...st]));
}
const p2 = log.filter((e) => e.to === 1 && e.t > t1);
console.log('CATCHES phase2', JSON.stringify(p2));
if (p2.some((e) => e.t - t1 < 5)) ok = false;
console.log(ok ? 'OK' : 'FAIL');
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
