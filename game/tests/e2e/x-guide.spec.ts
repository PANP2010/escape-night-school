import { browserArgs } from '../browser-args.mjs';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import type { ClientMsg, ServerMsg } from '../../shared/protocol.ts';
import { clickCanvas, shot } from './draw';

// #221 B 验收: an 「只读 HUD」 bot. Two players clear L1 and L2 within 5 min reading only the objective panel text,
// the goal arrow (#goal-arrow: edge angle data-a / on-screen marker position, the distance) and the E prompt; it
// never reads level coordinates, including when stuck. Its only outputs are what a player has: keys and the look
// (input.yaw / pitch). The setup's safe command isolates navigation from monster attacks, without granting items.
const ARGS = browserArgs(['--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']);
let launched: Browser | undefined;
test.afterEach(async () => { await launched?.close(); launched = undefined; });

const log = (...a: unknown[]) => console.log('GUIDE', new Date().toISOString(), ...a);
const ACT = ['E 拾取抽屉钥匙 · 铜牌、有齿', 'E 打开抽屉，取出楼梯钥匙', 'E 拾取', 'E 打开', 'E 插入保险丝', 'E 搀扶'];
type Debug = Extract<ClientMsg, { t: 'debug' }>;
type Player = Extract<ServerMsg, { t: 'snap' }>['players'][number];
type Wire = {
  urls: string[]; debug: Debug[]; actions: { at: number; message: ClientMsg }[];
  id?: number; rooms: { at: number; level: number; seed: number }[];
  trace: (Pick<Player, 'p' | 'yaw'> & { at: number; tick: number; level: number; st: number })[];
  corrections: ServerMsg[]; advances: number; errors: string[];
};

/** Transport evidence stays outside the bot; it never supplies a target or a position to its steering. */
function observeWire(page: Page): Wire {
  const wire: Wire = { urls: [], debug: [], actions: [], rooms: [], trace: [], corrections: [], advances: 0, errors: [] };
  let level = 0, sampledAt = 0;
  page.on('pageerror', (error) => wire.errors.push(error.message));
  page.on('websocket', (ws) => {
    wire.urls.push(ws.url());
    ws.on('framesent', ({ payload }) => {
      const message = JSON.parse(payload.toString()) as ClientMsg;
      if (message.t === 'debug') wire.debug.push(message);
      if (message.t === 'act' || message.t === 'door' || message.t === 'use') wire.actions.push({ at: Date.now(), message });
    });
    ws.on('framereceived', ({ payload }) => {
      const message = JSON.parse(payload.toString()) as ServerMsg;
      const at = Date.now();
      if (message.t === 'welcome') wire.id = message.id;
      if (message.t === 'room') {
        level = message.level;
        wire.rooms.push({ at, level, seed: message.seed });
      }
      if (message.t === 'snap' && at - sampledAt >= 200) {
        const self = message.players.find((player) => player.id === wire.id);
        if (self) {
          wire.trace.push({ at, tick: message.tick, level, p: self.p, yaw: self.yaw, st: self.st ?? 0 });
          sampledAt = at;
        }
      }
      if (message.t === 'correct' && !message.forced) wire.corrections.push(message);
      if (message.t === 'fade' && !message.restart) wire.advances++;
    });
    ws.on('socketerror', (error) => wire.errors.push(`WebSocket: ${error}`));
  });
  return wire;
}

async function open(browser: Browser, baseURL: string, name: string) {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const wire = observeWire(page);
  page.on('pageerror', (e) => log(name, 'pageerror', e.message));
  await page.goto('/?nodraw');
  await page.fill('#name', name);
  return { page, wire };
}

/** One look reads only the HUD. In particular, its E prompt still belongs to this unchanged view. */
const look = (p: Page) => p.evaluate(() => {
  const el = document.getElementById('goal-arrow')!, r = el.getBoundingClientRect(), w = innerWidth, h = innerHeight;
  const on = el.classList.contains('on'), a = Number(el.dataset.a ?? 0), m = /(\d+) m/.exec(el.querySelector('.d')!.textContent ?? '');
  const fade = document.getElementById('fade-overlay')!;
  return { arrow: !el.hidden, on, a, d: m ? Number(m[1]) : NaN, rough: (el.querySelector('.d')!.textContent ?? '').startsWith('约'),
    dx: (r.left + r.width / 2 - w / 2) / (w / 2), dy: (r.top + r.height / 2 - h / 2) / (h / 2),
    here: (el.querySelector('.d')!.textContent ?? '') === '到了，等队友',
    goal: document.querySelector('#objective .g')!.textContent ?? '', head: document.querySelector('#objective .h')!.textContent ?? '',
    prompt: document.getElementById('prompt')!.textContent ?? '', fade: fade.hidden ? '' : fade.textContent ?? '' };
});

type Hud = Awaited<ReturnType<typeof look>>;

/** Turning is an output, after handling the prompt read at the old view. */
const turn = (p: Page, hud: Hud) => p.evaluate((hud) => {
  const inp = (window.__escape.game() as any).input;
  if (hud.arrow && hud.on) {
    inp.yaw -= hud.dx * 0.5;
    inp.pitch = Math.max(-1.2, Math.min(1.2, inp.pitch - hud.dy * 0.3));
  } else if (hud.arrow) {
    inp.yaw -= Math.max(-0.6, Math.min(0.6, (hud.a * Math.PI) / 180 * 0.5));
    inp.pitch *= 0.7;
  }
}, hud);

/** Follows the arrow until the authoritative chapter-clear presentation; returns the HUD history's step texts. */
async function bot(p: Page, name: string, until: number, onStep?: (n: number) => Promise<void>): Promise<string[]> {
  const steps: string[] = [];
  let best = Infinity, bestAt = Date.now(), goalAt = bestAt, goal = '', unstick = 0;
  const kb = p.keyboard;
  const stop = async () => { await kb.up('KeyW'); await kb.up('ShiftLeft'); };
  try {
    while (Date.now() < until) {
      const h: Hud = await look(p);
      if (/第\s*\d+\s*关\s*通过/.test(h.fade)) return steps;
      if (h.goal !== goal) {
        goal = h.goal; goalAt = Date.now(); steps.push(`${h.head} ${h.goal}`); log(name, h.head, h.goal);
        await stop();
        await onStep?.(steps.length);
        // The panel can advance before the arrow's 250 ms update. Read a fresh HUD next iteration so the old
        // target's short distance cannot seed this goal's progress baseline. The 4 s stall check is unchanged,
        // and this refresh wait (like screenshot rendering) still counts towards the shared 300 s budget.
        await p.waitForTimeout(300);
        best = Infinity; bestAt = Date.now();
        continue;
      }
      // in the exit zone (the arrow says so): stand and wait for the others
      if (h.here) { await stop(); bestAt = Date.now(); await p.waitForTimeout(150); continue; }
      // Stop, let the visible prompt refresh, then press E without changing the view or crossing the target.
      if (h.prompt === 'E 出来' || ACT.includes(h.prompt)) {
        await stop();
        await p.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
        const fresh = await look(p);
        if (fresh.prompt === 'E 出来' || ACT.includes(fresh.prompt)) {
          await kb.press('KeyE'); log(name, 'E', fresh.prompt, fresh.d); await p.waitForTimeout(300);
        }
        continue;
      }
      await turn(p, h);
      // near an item / the fuse box: stop and aim at it (the marker), creep in if no prompt yet
      const near = h.arrow && h.on && !h.rough && h.d <= 2;
      if (near) { await kb.up('KeyW'); await kb.up('ShiftLeft'); await p.waitForTimeout(80); await kb.press('KeyW', { delay: 60 }); }
      else { await kb.down('KeyW'); if (h.d > 6) await kb.down('ShiftLeft'); else await kb.up('ShiftLeft'); }
      if (h.d < best - 0.9) { best = h.d; bestAt = Date.now(); }
      else if (Date.now() - bestAt > (h.rough ? 7000 : 4000)) { // no closer for a while: back off and sidestep
        log(name, 'stuck', h.goal, h.d, { sinceGoalMs: Date.now() - goalAt, noProgressMs: Date.now() - bestAt,
          rough: h.rough, on: h.on, a: h.a, dx: h.dx, dy: h.dy, prompt: h.prompt });
        await kb.up('KeyW');
        await kb.down('KeyS'); await p.waitForTimeout(500); await kb.up('KeyS');
        const side = unstick++ % 2 ? 'KeyA' : 'KeyD';
        await kb.down(side); await p.waitForTimeout(700); await kb.up(side);
        await kb.down('KeyW');
        best = Infinity; bestAt = Date.now();
      }
      await p.waitForTimeout(near ? 60 : 100);
    }
    throw new Error(`${name}: out of time at ${goal}`);
  } finally { await kb.up('KeyW'); await kb.up('ShiftLeft'); }
}

test('只读 HUD bot: two players follow the goal arrow through L1 and L2 in 5 min', async ({ baseURL }) => {
  test.setTimeout(420_000);
  const evidence = `guide-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  log('evidence', evidence);
  launched = await chromium.launch({ headless: true, args: ARGS });
  const [a, b] = await Promise.all([open(launched, baseURL!, '甲'), open(launched, baseURL!, '乙')]);
  const [A, B] = [a.page, b.page], wires = [a.wire, b.wire];
  await A.click('#create');
  await expect(A.locator('#wait-code')).not.toBeEmpty();
  const code = await A.locator('#wait-code').innerText();
  await B.fill('#code', code);
  await B.click('#join');
  await expect(A.locator('#wait-members li')).toHaveCount(2);
  await A.click('#start');
  for (const p of [A, B]) {
    await expect(p.locator('#hud')).toBeVisible({ timeout: 30_000 });
    await expect(p.locator('#goal-arrow')).not.toHaveAttribute('hidden', { timeout: 30_000 }); // 0×0 anchor: never 'visible'
    await clickCanvas(p);
  }
  const safe = () => Promise.all([A, B].map((p) => p.evaluate(() => window.__escape.debug('safe', 600))));
  const t0 = Date.now(), until = t0 + 300_000;
  const levels: { level: string; ms: number; steps: string[][] }[] = [];
  try {
    for (const [lv, next] of [['L1', 2], ['L2', 3]] as const) {
      const lvAt = Date.now();
      await safe();
      const snap = async (n: number) => { if (n <= 2) await shot(A, `test-results/${evidence}-${lv}-${n}.png`, 1); };
      const steps = await Promise.all([bot(A, '甲', until, snap), bot(B, '乙', until)]);
      levels.push({ level: lv, ms: Date.now() - lvAt, steps });
      log(lv, 'cleared in', Math.round((Date.now() - lvAt) / 1000), 's; total', Math.round((Date.now() - t0) / 1000), 's', steps);
      // the next level's start (the fade is LEVEL_FADE_S): the panel restarts at step 1
      for (const p of [A, B]) {
        await expect(p.locator('#fade-overlay')).toBeHidden({ timeout: 15_000 });
        // Each fade must advance the visible level header; L2 only counts once both players really enter L3.
        await expect(p.locator('#room-code')).toContainText(`第 ${next} 关`, { timeout: 15_000 });
        await p.waitForFunction(() => {
          const g = window.__escape.game(); return g?.presentationReady && !g.intro.active;
        });
      }
    }
    expect(Date.now() - t0).toBeLessThan(300_000);
    for (const wire of wires) {
      expect(wire.urls).toEqual([`${baseURL!.replace(/^http/, 'ws')}/ws`]);
      expect(wire.debug).toEqual([{ t: 'debug', op: 'safe', s: 600 }, { t: 'debug', op: 'safe', s: 600 }]);
      expect(wire.advances).toBe(2);
      expect(wire.corrections).toEqual([]);
      expect(wire.errors).toEqual([]);
    }
  } finally {
    writeFileSync(`test-results/${evidence}-wire.json`, JSON.stringify({ args: ARGS, ms: Date.now() - t0, levels, wires }, null, 2));
  }
});
