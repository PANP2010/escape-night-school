import { browserArgs } from '../browser-args.mjs';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import WebSocket from 'ws';
import { networkInterfaces } from 'node:os';
import { frame } from './draw';

const log = (...a: unknown[]) => console.log('REPRO', ...a);

// three campus clients on a 4-core box, one browser (own swiftshader GPU process) each. Three swiftshader renderers
// drew < 1 fps each (iter-167/168), which made movement crawl (≤ 0.3 s per frame) and revive holds go stale, so the
// clients open /?nodraw (game.draw = false: full update/interp/animation, no WebGL draw) and only draw for the screenshots.
// --disable-gpu-compositing (#232): otherwise Chrome composites the page (HUD) through swiftshader GL, 4 rasterizer threads
// per browser at 100 % even with no WebGL draw; 3 browsers on 4 cores starved each other to 2–10 fps (load 7–11), so the
// revive hold's 0.6 s server timeout lapsed and the fps checks at :110 / :277 failed. CPU compositing: 60 fps, load ~1.5
const ARGS = browserArgs(['--disable-gpu-compositing', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']);
const launched: Browser[] = [];
// in parallel: a swiftshader browser that has drawn takes ~25 s to close (#186)
test.afterEach(async () => { await Promise.all(launched.splice(0).map((b) => b.close())); });

/** A filler client with no renderer, only used to fill the room to MAX_PLAYERS for the "full" check. */
function filler(url: string, code: string) {
  // Use a distinct real source so the room-capacity check does not trip the transport limit.
  // macOS does not bind unconfigured 127.0.0.2 aliases; its existing interface address also routes to loopback.
  const localAddress = process.platform === 'darwin'
    ? Object.values(networkInterfaces()).flat().find(a => a?.family === 'IPv4' && !a.internal)?.address
    : '127.0.0.2';
  if (!localAddress) throw new Error('Room capacity acceptance needs a second local IPv4 source');
  const ws = new WebSocket(url, { localAddress });
  return new Promise<WebSocket>((res, reject) => {
    ws.once('error', () => reject(new Error('Room capacity filler failed to connect')));
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'hello', name: '填' }));
      ws.send(JSON.stringify({ t: 'join', code }));
      ws.on('message', (d) => { if (JSON.parse(String(d)).t === 'room') res(ws); });
    });
  });
}

async function open(baseURL: string, name: string): Promise<Page> {
  const browser = await chromium.launch({ args: ARGS });
  launched.push(browser);
  const ctx = await browser.newContext({ baseURL, viewport: { width: 400, height: 260 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log(name, 'pageerror', e.message));
  page.on('crash', () => log(name, 'page crashed'));
  await page.goto('/?nodraw');
  await page.fill('#name', name);
  return page;
}

const G = (p: Page) => p.evaluate(() => {
  const g = window.__escape.game() as any;
  return { id: g.myId, level: g.level.index, x: g.pos.x, z: g.pos.z, y: g.body.y, yaw: g.input.yaw,
    remotes: [...g.remotes].map(([id, r]: [number, any]) => {
      let skinned = 0; r.mesh.traverse((o: any) => { if (o.isSkinnedMesh) skinned++; });
      return { id, x: r.mesh.position.x, z: r.mesh.position.z, yaw: r.mesh.rotation.y, f: r.f, down: r.down, skinned, visible: r.mesh.visible };
    }) };
});
const remoteOf = async (p: Page, id: number) => (await G(p)).remotes.find((r) => r.id === id);
const members = (p: Page) => p.locator('#wait-members li');
const tp = (p: Page, x: number, z: number, f: number) => p.evaluate(([x, z, f]) => window.__escape.debug('tp', x, z, f), [x, z, f]);
const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

// 联机实测: three real browsers over the real ws server (dist-server).
// 3 swiftshader browsers on a 4-core 3.9 GB box: a browser occasionally dies or starves mid-run; one extra retry (supervisor #168)
test.describe.configure({ retries: 2 });

test('3 browsers: join, see each other, sync, interact, revive, level, leave/rejoin, host transfer', async ({ baseURL }) => {
  test.setTimeout(360_000);
  const url = baseURL!.replace('http', 'ws') + '/ws';
  const readCode = (p: Page) => p.evaluate(async () => { while (!window.__escape.code) await new Promise((r) => setTimeout(r, 50)); return window.__escape.code; });
  const joinBy = async (p: Page, code: string) => { await p.fill('#code', code); await p.click('#join'); };

  // A: a wrong code says so; then A creates the room
  const A = await open(baseURL!, '甲');
  await joinBy(A, 'ZZZZ');
  await expect(A.locator('#err')).toHaveText('房间不存在');
  log('A wrong code ->', await A.locator('#err').textContent());
  await A.click('#create');
  const code = await readCode(A);
  // B: lower case with spaces around and between the letters
  const B = await open(baseURL!, '乙');
  await joinBy(B, ' ' + code.toLowerCase().split('').join(' ') + ' ');
  await expect(members(B)).toHaveCount(2);
  log('B joined with', JSON.stringify(' ' + code.toLowerCase().split('').join(' ') + ' '));
  // C: the room is full while two fillers sit in it; it gets in once they leave
  const fill = [await filler(url, code), await filler(url, code)];
  const C = await open(baseURL!, '丙');
  await joinBy(C, code);
  await expect(C.locator('#err')).toHaveText('房间已满');
  log('C full ->', await C.locator('#err').textContent());
  for (const w of fill) w.close();
  // A disconnected seat is reserved for the new ten-second resume window, then actually removed.
  await expect(A.locator('#wait-members li[data-online="false"]')).toHaveCount(2);
  await expect(A.locator('#wait-members li[data-online="false"]')).toContainText(['断线中', '断线中']);
  await expect(members(A)).toHaveCount(2, { timeout: 15_000 });
  await joinBy(C, code);
  const pages = [A, B, C];
  for (const p of pages) await expect(members(p)).toHaveCount(3);
  const lists = await Promise.all(pages.map(async (p) => (await members(p).allTextContents()).map((t) => t.replace(' · 你', ''))));
  log('lobby lists', JSON.stringify(lists));
  expect(lists[1]).toEqual(lists[0]);
  expect(lists[2]).toEqual(lists[0]);
  expect(lists[0][0]).toBe('甲（房主）');
  await expect(B.locator('#start')).toBeHidden();
  await expect(C.locator('#start')).toBeHidden();

  // host starts: all three in L1, spawns apart
  await A.click('#start');
  // three clients build the campus at once (each freezes 7–10 s alone, far longer together on 4 cores, and a frozen page
  // cannot even answer evaluate): generous waits for that and for the L2 build (gate iter-168 / supervisor runs)
  for (const p of pages) await expect(p.locator('#hud')).toBeVisible({ timeout: 90_000 });
  for (const p of pages) await expect.poll(() => p.evaluate(() => (window.__escape.game() as any).spawnSynced), { timeout: 90_000 }).toBe(true);
  // 第 1 关 is one closed floor now: 角色074 would catch someone before the revive / on-screen checks (punish = a teleport
  // to spawn, ST_DOWN); he is held off until C calls him below ('warden' ends the hold-off)
  await A.evaluate(() => window.__escape.debug('safe', 600));
  const st0 = await Promise.all(pages.map(G));
  log('spawns', JSON.stringify(st0.map((s) => [s.id, s.level, +s.x.toFixed(2), +s.z.toFixed(2)])));
  for (const s of st0) expect(s.level).toBe(0);
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) expect(Math.hypot(st0[i].x - st0[j].x, st0[i].z - st0[j].z)).toBeGreaterThan(0.5);
  const [idA, idB, idC] = st0.map((s) => s.id as number);
  // everyone sees the other two as the skinned 角色074-style character (not a box, not missing)
  for (const p of pages) await expect.poll(async () => (await G(p)).remotes.filter((r) => r.skinned > 0 && r.visible).length, { timeout: 20_000 }).toBe(2);
  log('remotes', JSON.stringify((await Promise.all(pages.map(G))).map((s) => s.remotes.map((r) => [r.id, r.skinned]))));

  const fps = (p: Page) => p.evaluate(async () => { let fr = 0, on = true; const f = () => { fr++; if (on) requestAnimationFrame(f); }; requestAnimationFrame(f); await new Promise((r) => setTimeout(r, 1000)); on = false; return fr; });
  for (const p of pages) await expect.poll(() => fps(p), { timeout: 30_000, intervals: [0] }).toBeGreaterThanOrEqual(15);
  log('fps (no draw)', JSON.stringify(await Promise.all(pages.map(fps))));

  // B walks: A's copy of B ends where B is, facing B's way (≤ 100 ms interp lag, then settles)
  const hold = async (p: Page, keys: string[], ms: number) => {
    await p.evaluate((k) => { const i = (window.__escape.game() as any).input; for (const c of k) i.press(c); }, keys);
    await p.waitForTimeout(ms);
    await p.evaluate((k) => { const i = (window.__escape.game() as any).input; for (const c of k) i.release(c); }, keys);
  };
  const setYaw = (p: Page, yaw: number, pitch = 0) => p.evaluate(([y, q]) => { const i = (window.__escape.game() as any).input; i.yaw = y; i.pitch = q; }, [yaw, pitch]);
  let moved = 0;
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const b0 = await G(B);
    await setYaw(B, yaw);
    await hold(B, ['KeyW'], 1500);
    const b1 = await G(B);
    moved = Math.hypot(b1.x - b0.x, b1.z - b0.z);
    log('B walk yaw', yaw.toFixed(2), moved.toFixed(2));
    if (moved > 1) break;
  }
  log('B walked', moved.toFixed(2));
  expect(moved).toBeGreaterThan(1);
  // B stands still now: A's and C's copies must settle onto B's pose (each page renders on its own clock, so poll)
  const bNow = await G(B);
  const off = async (p: Page) => { const r = (await remoteOf(p, idB))!; return Math.max(Math.hypot(r.x - bNow.x, r.z - bNow.z) / 0.35, Math.abs(wrapPi(r.yaw - bNow.yaw)) / 0.15); };
  for (const p of [A, C]) await expect.poll(() => off(p), { timeout: 3_000 }).toBeLessThan(1);
  const bOnA = (await remoteOf(A, idB))!, bOnC = (await remoteOf(C, idB))!;
  log('B pos', bNow.x.toFixed(2), bNow.z.toFixed(2), bNow.yaw.toFixed(2), 'on A', bOnA.x.toFixed(2), bOnA.z.toFixed(2), bOnA.yaw.toFixed(2), 'on C', bOnC.x.toFixed(2), bOnC.z.toFixed(2));
  // run and crouch flags reach the others (they drive the run / crouch animations)
  await B.evaluate(() => { const i = (window.__escape.game() as any).input; i.press('ShiftLeft'); i.press('KeyW'); });
  await expect.poll(async () => ((await remoteOf(A, idB))!.f & 2), { timeout: 5_000 }).toBe(2);
  // health probe: snapshots received and frames drawn per second on each client
  const rate = (p: Page) => p.evaluate(async () => { const g = window.__escape.game() as any; let fr = 0, on = true; const f = () => { fr++; if (on) requestAnimationFrame(f); }; requestAnimationFrame(f); const s0 = g.snaps, t0 = performance.now(); await new Promise((r) => setTimeout(r, 1000)); on = false; return [g.snaps - s0, fr, Math.round(performance.now() - t0)]; });
  log('snaps/frames per s', JSON.stringify(await Promise.all(pages.map(rate))));
  await B.evaluate(() => { const i = (window.__escape.game() as any).input; i.release('ShiftLeft'); i.release('KeyW'); i.press('KeyC'); });
  await expect.poll(async () => ((await remoteOf(A, idB))!.f & 1), { timeout: 5_000 }).toBe(1);
  await expect.poll(async () => ((await remoteOf(C, idB))!.f & 1), { timeout: 5_000 }).toBe(1);
  await B.evaluate(() => (window.__escape.game() as any).input.release('KeyC'));
  await expect.poll(async () => ((await remoteOf(A, idB))!.f & 1), { timeout: 5_000 }).toBe(0);
  log('run/crouch flags seen by A and C');
  // B opens a door: everyone's copy of that door is open
  const door = await B.evaluate(() => { const g = window.__escape.game() as any; const d = g.doors.find((d: any) => g.doorLocked[d.id] === false && !g.doorOpen[d.id]); return { id: d.id, x: d.x, z: d.z, alongX: d.alongX, y0: d.y0 ?? 0 }; });
  await tp(B, door.x + (door.alongX ? 0 : 1), door.z + (door.alongX ? 1 : 0), Math.round(door.y0 / 3.6));
  await B.waitForTimeout(500);
  log('door', JSON.stringify(door), 'B at', JSON.stringify(await B.evaluate(() => { const g = window.__escape.game() as any; return [g.pos.x, g.body.y, g.pos.z]; })));
  // The server has B at the door once A sees B there; then press E once (a repeated press would close it again)
  await expect.poll(async () => { const r = (await remoteOf(A, idB))!; return Math.hypot(r.x - door.x, r.z - door.z); }, { timeout: 10_000, message: 'A sees B at the door' }).toBeLessThan(2);
  // record every door update each client receives (diagnostics if one of them misses it)
  for (const p of pages) await p.evaluate(() => { const n = window.__escape.net as any, prev = n.onMsg; (window as any).__dlog = []; n.onMsg = (m: any) => { if (m.doors) (window as any).__dlog.push([m.t, m.tick, JSON.stringify(m.doors)]); if (m.t === 'snap') (window as any).__tick = m.tick; prev(m); }; });
  await B.evaluate((id) => window.__escape.net.send({ t: 'door', id }), door.id);
  await B.waitForTimeout(1500);
  for (const [i, p] of pages.entries()) log('doorlog', 'ABC'[i], JSON.stringify(await p.evaluate((id) => [(window.__escape.game() as any).doorOpen[id], (window as any).__tick, (window as any).__dlog], door.id)));
  for (const [i, p] of pages.entries()) await expect.poll(() => p.evaluate((id) => (window.__escape.game() as any).doorOpen[id], door.id), { timeout: 5_000, message: `door ${door.id} open on ${'ABC'[i]}` }).toBe(true);
  log('door', door.id, 'open on all three');

  // chat typed by B shows on all three
  await B.keyboard.press('Enter');
  await expect(B.locator('#chat-input')).toBeVisible();
  await B.keyboard.type('快来三楼');
  await B.keyboard.press('Enter');
  await expect(B.locator('#chat-input')).toBeHidden();
  for (const p of pages) await expect(p.locator('#chat-log')).toContainText('乙：快来三楼');
  // A's ping marker reaches all three (chat line + world marker)
  await setYaw(A, 0, -0.3);
  await A.evaluate(() => (window.__escape.game() as any).sendPing());
  for (const p of pages) {
    await expect(p.locator('#chat-log')).toContainText('甲 标记了一个位置');
    await expect.poll(() => p.evaluate(() => (window.__escape.game() as any).pingCount), { timeout: 5_000 }).toBeGreaterThan(0);
  }
  log('chat + ping on all three');

  // B and C grab the same item in the same moment: it is gone everywhere and the team bag got exactly one
  const item = await B.evaluate(() => { const g = window.__escape.game() as any; const k = g.items.find((o: any) => o.kind === 'drawer_key' && !o.decoy)!; return { id: k.id, kind: k.kind, door: k.door, p: k.p }; });
  const bagOf = (p: Page, kind: string) => p.evaluate((k) => ((window.__escape.game() as any).bag[k] ?? 0) as number, kind);
  const keysOf = (p: Page) => p.evaluate(() => ((window.__escape.game() as any).heldKeys as number[]).length);
  const before = item.kind === 'door_key' ? await keysOf(A) : await bagOf(A, item.kind);
  await tp(B, item.p[0], item.p[2], Math.round(item.p[1] / 3.6));
  await tp(C, item.p[0], item.p[2], Math.round(item.p[1] / 3.6));
  await B.waitForTimeout(600);
  await Promise.all([B, C].map((p) => p.evaluate((id) => window.__escape.net.send({ t: 'act', kind: 'pick', id }), item.id)));
  for (const p of pages) await expect.poll(() => p.evaluate((id) => (window.__escape.game() as any).items.some((o: any) => o.id === id), item.id), { timeout: 5_000 }).toBe(false);
  await A.waitForTimeout(500);
  const after = await Promise.all(pages.map((p) => item.kind === 'door_key' ? keysOf(p) : bagOf(p, item.kind)));
  log('pick', item.kind, item.id, 'before', before, 'after', JSON.stringify(after));
  for (const n of after) expect(n).toBe(before + 1);

  // B goes down: A and C see it; A walks up, looks at B and holds E until B is back on their feet
  await B.evaluate(() => window.__escape.debug('down', 20));
  for (const p of [A, C]) await expect.poll(async () => (await remoteOf(p, idB))!.down, { timeout: 5_000 }).toBe(true);
  await expect(B.locator('#down-overlay')).toBeVisible();
  const bDown = await G(B);
  await tp(A, bDown.x + 0.9, bDown.z, Math.round(bDown.y / 3.6));
  await A.waitForTimeout(800);
  const a1 = await G(A), bOnA2 = (await remoteOf(A, idB))!;
  const dx = bOnA2.x - a1.x, dz = bOnA2.z - a1.z;
  await setYaw(A, Math.atan2(-dx, -dz), Math.atan2(bDown.y + 0.5 - (a1.y + 1.6), Math.hypot(dx, dz)));
  await A.waitForTimeout(200);
  log('revive target', JSON.stringify(await A.evaluate(() => { const t = (window.__escape.game() as any).target(); return t && { kind: t.kind, id: t.id }; })));
  // hold E until B is up (3 s of holding; a starved test client may need longer than one 4.5 s hold)
  // diagnostics if the hold never completes: every 250 ms what A aims at, whether E is held, revive acts sent, where A is
  await A.evaluate(() => {
    const w = window as any, g = window.__escape.game() as any, n = window.__escape.net as any, send = n.send.bind(n);
    w.__rev = { sent: 0, s: [] };
    n.send = (m: any) => { if (m.t === 'act' && m.kind === 'revive') w.__rev.sent++; return send(m); };
    w.__revT = setInterval(() => { const t = g.target(); w.__rev.s.push([Math.round(performance.now()), t && t.kind + t.id, g.input.down('KeyE'), w.__rev.sent, +g.pos.x.toFixed(2), +g.pos.z.toFixed(2), g.down, g.spectate]); }, 250);
  });
  await A.evaluate(() => (window.__escape.game() as any).input.press('KeyE'));
  try {
    await expect.poll(async () => (await remoteOf(A, idB))!.down, { timeout: 15_000 }).toBe(false);
  } catch (e) {
    log('revive samples on A', JSON.stringify(await A.evaluate(() => (window as any).__rev)));
    const c = await G(C);
    log('revive C sees', JSON.stringify(c.remotes.map((r) => [r.id, +r.x.toFixed(2), +r.z.toFixed(2), +r.yaw.toFixed(2), r.down])), 'B self', JSON.stringify(await G(B).then((b) => [b.x, b.y, b.z, b.yaw])));
    throw e;
  }
  await A.evaluate(() => clearInterval((window as any).__revT));
  await A.evaluate(() => (window.__escape.game() as any).input.release('KeyE'));
  for (const p of [A, C]) await expect.poll(async () => (await remoteOf(p, idB))!.down, { timeout: 5_000 }).toBe(false);
  await expect(B.locator('#down-overlay')).toBeHidden();
  log('B revived by A, seen by A and C');

  // the stair key + everyone at the exit: all three move to the next level together
  await A.evaluate(() => window.__escape.debug('key', -1));
  const exit = await A.evaluate(() => (window.__escape.game() as any).level.exit as { x: number; z: number; y: number });
  // the exit circle overlaps the stair flight (ground rises toward -x): stand on its landing side, the in-exit check needs |y - exit.y| < 1.5
  for (const [i, p] of pages.entries()) await tp(p, exit.x + 2, exit.z + (i - 1) * 0.8, Math.round(exit.y / 3.6));
  for (const p of pages) await expect.poll(async () => (await G(p)).level, { timeout: 60_000 }).toBe(1);
  for (const p of pages) await expect(p.locator('#room-code')).toContainText('第 2 关');
  for (const p of pages) await expect.poll(() => p.evaluate(() => (window.__escape.game() as any).spawnSynced), { timeout: 60_000 }).toBe(true);
  for (const p of pages) await expect.poll(async () => (await G(p)).remotes.filter((r) => r.skinned > 0 && r.visible).length, { timeout: 20_000 }).toBe(2);
  log('all three in level 1', JSON.stringify((await Promise.all(pages.map(G))).map((s) => [s.level, +s.x.toFixed(1), +s.z.toFixed(1)])));
  // screenshots: each faces the other two and must have both on screen. L2 spawns are a row along x (1.4 m apart),
  // so the middle one steps 1.8 m off the row (toward the corridor's middle); otherwise the other two flank it
  const row = await Promise.all(pages.map(G)), mid = row.findIndex((s) => row.filter((o) => o.x < s.x).length === 1);
  await tp(pages[mid], row[mid].x, row[mid].z - 1.8, Math.round(row[mid].y / 3.6));
  await expect.poll(async () => Math.abs((await G(pages[mid])).z - (row[mid].z - 1.8)), { timeout: 5_000 }).toBeLessThan(0.2);
  const sp = await Promise.all(pages.map(G));
  for (const [i, p] of pages.entries()) {
    const o = sp.filter((_, j) => j !== i), cx = (o[0].x + o[1].x) / 2 - sp[i].x, cz = (o[0].z + o[1].z) / 2 - sp[i].z;
    await setYaw(p, Math.atan2(-cx, -cz), -0.05);
  }
  // shot() renders just this frame (drawing at 1-2 fps took ~95 s for the three and once killed the browser
  // mid-screenshot, #186); its render also updates camera.matrixWorldInverse, which project() below needs. The first
  // render compiles the shaders (~40 s each in swiftshader), so the three browsers (own GPU processes) render at once,
  // then screenshot one by one
  await Promise.all(pages.map((p) => frame(p)));
  for (const [i, p] of pages.entries()) {
    await p.screenshot({ path: `test-results/x-multi-${'ABC'[i]}.png` });
    await p.evaluate(() => document.getElementById('e2e-shot')?.remove());
  }
  for (const [i, p] of pages.entries()) {
    const onScreen = await p.evaluate(() => { const g = window.__escape.game() as any, T = window.__escape.THREE;
      return [...g.remotes.values()].filter((r: any) => { const v = new T.Vector3(r.mesh.position.x, r.mesh.position.y + 1, r.mesh.position.z).project(g.camera); return r.mesh.visible && Math.abs(v.x) < 1 && Math.abs(v.y) < 1 && v.z < 1; }).length; });
    log('on screen', 'ABC'[i], onScreen);
    expect(onScreen).toBe(2);
  }

  // C closes the page mid-level: A/B drop C from the list and 角色074 stops chasing C's ghost
  // __wardenT: his latest target; __wardenSeen: every target he had (he can catch C and give up within a second)
  const wardenTarget = (p: Page) => p.evaluate(() => (window as any).__wardenT as number);
  for (const p of [A, B]) await p.evaluate(() => { const n = window.__escape.net as any, o = n.onMsg.bind(n); (window as any).__wardenT = 0; (window as any).__wardenSeen = [];
    n.onMsg = (m: any) => { if (m.t === 'snap') for (const w of m.mobs) if (w.id === 1 && w.target !== undefined) { (window as any).__wardenT = w.target; (window as any).__wardenSeen.push(w.target); }
      if (m.t === 'room') (window as any).__host = m.host; o(m); }; });
  // 角色074 chases the nearest player he sees, so A and B first go far away (the L2 exit; the stair key is spent, nobody advances)
  const exit2 = await A.evaluate(() => (window.__escape.game() as any).level.exit as { x: number; z: number; y: number });
  for (const [i, p] of [A, B].entries()) await tp(p, exit2.x + 2, exit2.z + i * 0.8, Math.round(exit2.y / 3.6));
  await expect.poll(async () => { const a = await G(A); return Math.hypot(a.x - sp[2].x, a.z - sp[2].z); }, { timeout: 5_000 }).toBeGreaterThan(15);
  for (const p of pages) await expect.poll(() => fps(p), { timeout: 30_000, intervals: [0] }).toBeGreaterThanOrEqual(15);
  log('before warden: snaps/frames per s', JSON.stringify(await Promise.all(pages.map(rate))));
  await C.evaluate(() => window.__escape.debug('warden', 12));
  for (const p of [A, B]) await expect.poll(() => p.evaluate((id) => ((window as any).__wardenSeen as number[]).includes(id), idC), { timeout: 30_000, message: 'warden chases C' }).toBe(true);
  log('warden targets seen on A', JSON.stringify([...new Set(await A.evaluate(() => (window as any).__wardenSeen as number[]))]));
  // Observe a real transport loss while the page remains alive. Closing a rendering context may
  // itself take longer than the reservation window, so it cannot locate the offline-state boundary.
  await C.context().setOffline(true);
  await expect(C.locator('#reconnect-status')).toBeVisible();
  await Promise.all([A, B].map(async p => {
    await expect(p.locator('#room-code')).toContainText('· 2 人'); // the UI counts online members
    await expect(p.locator('#room-code')).toContainText('1 人重连中');
    await expect.poll(() => p.evaluate((id) => {
      const r = window.__escape.game()!.remotes.get(id) as any;
      return !!r && r.offline === true && r.mesh.visible === false;
    }, idC)).toBe(true);
  }));
  await C.context().close();
  // Check both observers during the reservation above, then both after it expires below.
  await Promise.all([A, B].map(async p => {
    await expect.poll(async () => (await G(p)).remotes.map((r) => r.id), { timeout: 20_000 }).toEqual([p === A ? idB : idA]);
    await expect(p.locator('#room-code')).toContainText('· 2 人');
    await expect(p.locator('#room-code')).not.toContainText('重连中');
    await expect.poll(() => wardenTarget(p), { timeout: 30_000 }).not.toBe(idC);
  }));
  log('C left; warden target now', await wardenTarget(A));

  // C reloads and joins again: mid-level joiners watch (spectate) until the next level; everyone counts 3
  const C2 = await open(baseURL!, '丙');
  await joinBy(C2, code);
  for (const p of [A, B, C2]) await expect(p.locator('#room-code')).toContainText('· 3 人', { timeout: 15_000 });
  await expect.poll(async () => (await G(C2)).remotes.filter((r) => r.skinned > 0 && r.visible).length, { timeout: 20_000 }).toBe(2);
  for (const p of [A, B]) await expect.poll(async () => (await G(p)).remotes.length, { timeout: 10_000 }).toBe(2);
  log('C rejoined as', (await G(C2)).id);

  // the host leaves: B becomes host
  await A.context().setOffline(true);
  await expect(A.locator('#reconnect-status')).toBeVisible();
  await expect.poll(() => B.evaluate(() => (window as any).__host as number), { timeout: 10_000 }).toBe(idB);
  await expect(B.locator('#room-code')).toContainText('· 2 人');
  await expect(B.locator('#room-code')).toContainText('1 人重连中');
  await expect(B.locator('#host-change')).toBeVisible();
  await expect(B.locator('#host-change')).toContainText('房主');
  await A.context().close();
  log('host ->', idB);
});
