import { expect, test, type Page } from '@playwright/test';
import type { ClientMsg, ServerMsg, WorldItem } from '../../shared/protocol.ts';
import { storySites } from '../../shared/storySite.ts';
import { canReadStory, type StoryNoteSite } from '../../shared/story.ts';
import { LEVELS } from '../../shared/level.ts';
import { L1 } from '../../shared/levels/l1.ts';
import { L2 } from '../../shared/levels/l2.ts';
import { L3 } from '../../shared/levels/l3.ts';
import { L4 } from '../../shared/levels/l4.ts';
import published from '../../client/public/version.json' with { type: 'json' };

const panel = (p: Page) => p.locator('.story-view__panel');
const entries = (p: Page) => p.evaluate(() => window.__escape.game()!.story.state.model().entries);
const noteId = (level: number, site: StoryNoteSite) => `${level}:note:${site.id}`;
type StoryFixture = { spawnSynced: boolean; items: WorldItem[]; bag: Partial<Record<WorldItem['kind'], number>>; fusesIn: number };

function wire(p: Page) {
  const received: ServerMsg[] = [], sent: ClientMsg[] = [], errors: string[] = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('websocket', (ws) => {
    ws.on('framereceived', ({ payload }) => {
      const m = JSON.parse(payload.toString()) as ServerMsg;
      if (m.t !== 'snap' && m.t !== 'nav') received.push(m);
    });
    ws.on('framesent', ({ payload }) => sent.push(JSON.parse(payload.toString()) as ClientMsg));
  });
  return { received, sent, errors };
}

async function ready(p: Page, level: number) {
  await expect(p.locator('#room-code')).toContainText(`第 ${level + 1} 关`, { timeout: 30_000 });
  await p.waitForFunction((level) => {
    const g = window.__escape.game();
    return g?.presentationReady && (g as unknown as StoryFixture).spawnSynced && g.level.index === level && !g.intro.active;
  }, level);
  await expect(p.locator('#fade-overlay')).toBeHidden({ timeout: 15_000 });
  await p.evaluate(() => window.__escape.debug('safe', 600));
  await p.keyboard.press('Shift'); // A real first input starts the readable opening without moving the player.
  await p.waitForFunction(() => window.__escape.game()!.openingComplete);
  await expect(p.locator('#banner')).toBeHidden({ timeout: 15_000 });
  await expect(p.locator('#settings-open')).toBeVisible();
  await expect(p.locator('.story-view__toggle')).toBeVisible();
}

async function create(p: Page) {
  await p.goto('/?steady');
  await p.locator('#name').fill('夜路摘录');
  await p.locator('#create').click();
  await p.locator('#start').click();
  await ready(p, 0);
}

async function tp(p: Page, x: number, z: number, floor?: number) {
  await p.waitForTimeout(350); // Budget fixture commands alongside the client's real 20 Hz inputs.
  await p.evaluate(({ x, z, floor }) => {
    if (floor === undefined) window.__escape.debug('tp', x, z);
    else window.__escape.debug('tp', x, z, floor);
  }, { x, z, floor });
  await expect.poll(() => p.evaluate(({ x, z }) => {
    const g = window.__escape.game()!;
    return Math.hypot(g.pos.x - x, g.pos.z - z);
  }, { x, z }), { timeout: 10_000 }).toBeLessThan(0.4);
}

async function exitTo(p: Page, x: number, z: number, floor: number, nextLevel: number) {
  expect(await p.evaluate(() => window.__escape.game()!.level.index)).toBe(nextLevel - 1);
  await p.waitForTimeout(350);
  await p.evaluate(({ x, z, floor }) => window.__escape.debug('tp', x, z, floor), { x, z, floor });
  // Entering the exit can immediately replace the old pose with the next chapter's spawn.
  // Confirm the exact real chapter handoff rather than wait for that obsolete exit pose.
  await ready(p, nextLevel);
}

async function takeItem(p: Page, item: WorldItem) {
  // Every L1 lectern has a clear standing space west of its drawer.
  await tp(p, item.p[0] - 1, item.p[2], Math.round(item.p[1] / 3.6));
  await expect.poll(() => p.evaluate(item => {
    const g = window.__escape.game()!;
    return Math.hypot(g.camera.position.x - item.p[0] + 1, g.camera.position.z - item.p[2]);
  }, item)).toBeLessThan(0.2);
  await p.evaluate(item => {
    const g = window.__escape.game()!;
    g.input.yaw = Math.atan2(g.pos.x - item.p[0], g.pos.z - item.p[2]);
    g.input.pitch = Math.atan2(item.p[1] + 0.05 - g.camera.position.y,
      Math.hypot(g.pos.x - item.p[0], g.pos.z - item.p[2]));
  }, item);
  await expect.poll(() => p.evaluate(() => {
    const t = window.__escape.game()!.target();
    return t && { kind: t.kind, id: t.id };
  })).toEqual({ kind: 'pick', id: item.id });
  await focusPlay(p);
  await p.keyboard.press('e');
  await expect.poll(() => p.evaluate(id => (window.__escape.game() as unknown as StoryFixture).items.some(i => i.id === id), item.id)).toBe(false);
}

async function faceSite(p: Page, site: StoryNoteSite, floor: number, distance: number) {
  const [x, , z] = site.p, [nx, , nz] = site.normal;
  await tp(p, x + nx * distance, z + nz * distance, floor);
  await p.evaluate(({ x, y, z }) => {
    const g = window.__escape.game()!;
    g.input.yaw = Math.atan2(g.pos.x - x, g.pos.z - z);
    g.input.pitch = Math.atan2(y - (g.body.y + g.eye), Math.hypot(g.pos.x - x, g.pos.z - z));
  }, { x, y: site.p[1], z });
}

async function approach(p: Page, site: StoryNoteSite, floor: number) {
  // Keep feet on the clear floor: the broadcast room has chairs; the stair sign has nearby furniture.
  const distance = site.id === 'silence' ? 0.78 : site.id === 'scent' ? 1.2 : 1.5;
  await faceSite(p, site, floor, distance);
  if (site.surface === 'desk' && await p.evaluate(() => window.__escape.game()!.target()?.kind === 'pick')) {
    const item = await p.evaluate(() => {
      const g = window.__escape.game()!;
      return (g as unknown as StoryFixture).items.find(i => i.id === g.target()!.id)!;
    });
    if (item.decoy) {
      // A prop must remain a prop. Look across the workbook from the clear west side,
      // with the central prop outside the normal pickup cone, just as a player can.
      await tp(p, site.p[0] - 0.9, site.p[2] + 0.3, floor);
      await p.evaluate(site => {
        const g = window.__escape.game()!;
        g.input.yaw = -Math.PI * 2 / 3;
        g.input.pitch = Math.atan2(site.p[1] - g.camera.position.y, 0.9);
      }, site);
      expect(await p.evaluate(id => (window.__escape.game() as unknown as StoryFixture).items.some(i => i.id === id), item.id)).toBe(true);
    } else {
      if (item.kind === 'stair_key' && !await p.evaluate(() => (window.__escape.game() as unknown as StoryFixture).bag.drawer_key)) {
        const key = await p.evaluate(() => (window.__escape.game() as unknown as StoryFixture).items.find(i => i.kind === 'drawer_key' && !i.decoy)!);
        await takeItem(p, key);
        await expect.poll(() => p.evaluate(() => (window.__escape.game() as unknown as StoryFixture).bag.drawer_key)).toBe(1);
      }
      await takeItem(p, item);
      await faceSite(p, site, floor, distance);
    }
    await expect.poll(() => p.evaluate(() => window.__escape.game()!.target()?.kind)).not.toBe('pick');
  }
  // The adapter grants candidates only after the pose is received back from the real server.
  try {
    await expect.poll(() => p.evaluate(() => window.__escape.game()!.story.candidateId)).toBe(site.id);
  } catch (error) {
    const diagnostic = await p.evaluate(site => {
      const g = window.__escape.game()!;
      const journal = g.story as unknown as {
        own?: { p: [number, number, number]; yaw: number }; available: boolean; shown: boolean; ready: boolean;
      };
      const from = journal.own ? [journal.own.p[0], journal.own.p[1] + 1.5, journal.own.p[2]] : [];
      const to = site.p.map((v, i) => v + site.normal[i] * 0.04);
      const nearbyBoxes = g.campus.collision.boxes.filter(b => from.length && b.minX <= Math.max(from[0], to[0])
        && b.maxX >= Math.min(from[0], to[0]) && b.minY <= Math.max(from[1], to[1])
        && b.maxY >= Math.min(from[1], to[1]) && b.minZ <= Math.max(from[2], to[2])
        && b.maxZ >= Math.min(from[2], to[2]));
      return { site, own: journal.own, available: journal.available, shown: journal.shown, ready: journal.ready,
        candidate: g.story.candidateId, target: g.target(), feet: { ...g.body }, yaw: g.input.yaw,
        camera: g.camera.position.toArray(), from, to, nearbyBoxes };
    }, site);
    console.log('NARRATIVE_CANDIDATE_FAILURE', JSON.stringify(diagnostic));
    await p.screenshot({ path: `test-results/narrative-${site.id}-candidate-failure.png` });
    throw error;
  }
  await expect(p.locator('#prompt')).toContainText('阅读线索');
}

async function focusPlay(p: Page) {
  await p.locator('body > canvas').evaluate((canvas) => { canvas.tabIndex = -1; canvas.focus(); });
}

async function walkAfterClosingNotebook(p: Page) {
  const before = await p.evaluate(() => ({ ...window.__escape.game()!.pos }));
  await p.keyboard.down('w');
  expect(await p.evaluate(() => window.__escape.game()!.input.keys.has('KeyW'))).toBe(true);
  await p.waitForTimeout(300);
  await p.keyboard.up('w');
  expect(await p.evaluate(() => window.__escape.game()!.input.keys.has('KeyW'))).toBe(false);
  await expect.poll(() => p.evaluate(before => {
    const g = window.__escape.game()!;
    return Math.hypot(g.pos.x - before.x, g.pos.z - before.z);
  }, before)).toBeGreaterThan(0.1);
}

async function settingsRemainReachable(p: Page, label: string) {
  const layout = await p.evaluate(() => {
    const summary = document.querySelector('#settings-open')!;
    const toggle = document.querySelector('.story-view__toggle')!;
    const s = summary.getBoundingClientRect(), t = toggle.getBoundingClientRect();
    const hit = document.elementFromPoint(s.left + s.width / 2, s.top + s.height / 2);
    const broadcast = document.querySelector('#broadcast-status');
    const b = broadcast?.getBoundingClientRect();
    return { summary: s.toJSON(), toggle: t.toJSON(), hit: hit?.className,
      reachable: hit === summary || summary.contains(hit),
      overlaps: s.left < t.right && s.right > t.left && s.top < t.bottom && s.bottom > t.top,
      broadcastOverlap: !!b && !broadcast?.hasAttribute('hidden') && b.width > 0 && b.height > 0
        && b.left < t.right && b.right > t.left && b.top < t.bottom && b.bottom > t.top };
  });
  console.log('NARRATIVE_SETTINGS_LAYOUT', label, JSON.stringify(layout));
  await p.screenshot({ path: `test-results/narrative-settings-${label}.png` });
  expect.soft(layout.reachable, `${label}: unified settings must remain reachable`).toBe(true);
  expect.soft(layout.overlaps, `${label}: notebook must leave the unified settings entry exposed`).toBe(false);
  expect.soft(layout.broadcastOverlap, `${label}: notebook must leave broadcast clues exposed`).toBe(false);
}

async function readableMobilePanel(p: Page) {
  const layout = await panel(p).evaluate(el => {
    const r = el.getBoundingClientRect(), scroll = el.querySelector('.story-view__scroll')!;
    const overlaps = ['#touch-base', '#touch-btns', '#objective'].filter(selector => {
      const other = document.querySelector(selector)!;
      const b = other.getBoundingClientRect();
      return getComputedStyle(other).visibility !== 'hidden' && b.width > 0 && b.height > 0
        && r.left < b.right && r.right > b.left && r.top < b.bottom && r.bottom > b.top;
    });
    return { fits: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      font: parseFloat(getComputedStyle(el.querySelector('.story-view__text')!).fontSize),
      horizontalOverflow: scroll.scrollWidth > scroll.clientWidth + 1,
      scrollHeight: scroll.clientHeight, overlaps };
  });
  console.log('NARRATIVE_PANEL_LAYOUT', JSON.stringify({ viewport: p.viewportSize(), ...layout }));
  expect.soft(layout.fits).toBe(true);
  expect.soft(layout.font).toBeGreaterThanOrEqual(16);
  expect.soft(layout.horizontalOverflow).toBe(false);
  expect.soft(layout.scrollHeight).toBeGreaterThanOrEqual(120);
  expect.soft(layout.overlaps).toEqual([]);
}

async function blockedWorkbook(p: Page, site: StoryNoteSite) {
  // This real standing space is beside the lectern, behind the classroom wall.
  // Reach, floor and facing pass; campus LOS alone must deny the read.
  const x = site.p[0] + 1.1, z = site.p[2] + 0.1;
  const yaw = Math.atan2(x - site.p[0], z - site.p[2]);
  await tp(p, x, z, 0);
  await p.evaluate(yaw => { window.__escape.game()!.input.yaw = yaw; }, yaw);
  await expect.poll(() => p.evaluate(({ x, z, yaw }) => {
    const journal = window.__escape.game()!.story as unknown as { own?: { p: [number, number, number]; yaw: number } };
    return journal.own && Math.hypot(journal.own.p[0] - x, journal.own.p[2] - z) < 0.05
      && Math.abs(journal.own.yaw - yaw) < 0.02;
  }, { x, z, yaw })).toBe(true);
  const sight = await p.evaluate(site => {
    const g = window.__escape.game()!;
    const journal = g.story as unknown as {
      own: { p: [number, number, number]; yaw: number };
      visible: (from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }) => boolean;
    };
    const { p, yaw } = journal.own;
    return { p, yaw, visible: journal.visible({ x: p[0], y: p[1] + 1.5, z: p[2] },
      { x: site.p[0], y: site.p[1] + 0.025, z: site.p[2] }) };
  }, site);
  expect(canReadStory(site, sight.p, sight.yaw, true)).toBe(true);
  expect(sight.visible).toBe(false);
  expect(await p.evaluate(() => window.__escape.game()!.story.candidateId)).toBeUndefined();
  await expect(p.locator('.story-view__read')).toBeHidden();
  expect(await p.evaluate(() => window.__escape.game()!.story.readCandidate())).toBe(false);
  expect((await entries(p)).some(e => e.id === noteId(0, site))).toBe(false);
  await expect(panel(p)).toBeHidden();
  await p.screenshot({ path: 'test-results/narrative-occluded-workbook.png' });
}

async function read(p: Page, level: number, site: StoryNoteSite, floor: number, w: ReturnType<typeof wire>, worldShot?: string) {
  await approach(p, site, floor);
  expect((await entries(p)).some(e => e.id === noteId(level, site))).toBe(false);
  if (worldShot) {
    await p.screenshot({ path: `test-results/${worldShot}.png`, style: '.story-view__read, #prompt { visibility: hidden; }' });
  }
  await focusPlay(p);
  const writesBeforeRead = w.sent.filter(m => m.t === 'act' || m.t === 'broadcast').length;
  await p.keyboard.press('e');
  await expect(panel(p)).toBeVisible();
  await expect(panel(p)).toContainText(site.title);
  expect(await p.evaluate(() => window.__escape.game()!.input.enabled)).toBe(false);
  await expect.poll(async () => (await entries(p)).some(e => e.id === noteId(level, site))).toBe(true);
  expect(w.sent.filter(m => m.t === 'act' || m.t === 'broadcast')).toHaveLength(writesBeforeRead);
  await p.keyboard.press('Escape');
  await expect(panel(p)).toBeHidden();
  expect(await p.evaluate(() => window.__escape.game()!.input.enabled)).toBe(true);
}

async function walk(p: Page, points: [number, number][]) {
  await p.evaluate((points) => {
    const g = window.__escape.game()!;
    g.autopilot([[g.pos.x, g.pos.z], ...points]);
  }, points);
  await expect.poll(() => p.evaluate(() => window.__escape.game()!.autopilotDone), { timeout: 25_000 }).toBe(true);
}

test('physical excerpts survive a retry, follow real L1–L4 progress into L5 and never claim the school ending', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(300_000);
  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 720 } });
  const p = await context.newPage(), w = wire(p);
  try {
    expect(LEVELS).toHaveLength(8);
    const prefix = [L1, L2, L3, L4];
    expect(LEVELS.slice(0, 4)).toEqual(prefix);
    await create(p);
    await settingsRemainReachable(p, 'desktop');
    const renderer = await p.evaluate(() => {
      const gl = window.__escape.game()!.renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return String(gl.getParameter(ext?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER));
    });
    console.log('NARRATIVE_RENDERER', renderer);
    if (testInfo.config.metadata.narrativeMetal) {
      expect(renderer).not.toMatch(/SwiftShader/i);
      expect(renderer).toMatch(/Metal/i);
    }
    expect(await entries(p)).toEqual([]);
    await p.keyboard.press('j');
    await expect(panel(p)).toBeVisible();
    await expect(panel(p)).not.toContainText('点名册');
    const whileReading = await p.evaluate(() => ({ ...window.__escape.game()!.pos }));
    await p.keyboard.down('w');
    await p.waitForTimeout(300);
    expect(await p.evaluate(() => window.__escape.game()!.input.keys.has('KeyW'))).toBe(false);
    await p.keyboard.up('w');
    expect(await p.evaluate(before => {
      const g = window.__escape.game()!;
      return Math.hypot(g.pos.x - before.x, g.pos.z - before.z);
    }, whileReading)).toBeLessThan(0.01);
    await p.getByRole('button', { name: '当前章', exact: true }).focus();
    await p.keyboard.press('Enter');
    await expect(p.locator('#chat-input')).toBeHidden();
    await expect(p.getByRole('button', { name: '当前章', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await p.keyboard.press('Escape');
    await expect(panel(p)).toBeHidden();
    await walkAfterClosingNotebook(p);
    await p.locator('.story-view__toggle').click();
    await expect(panel(p)).toBeVisible();
    await p.locator('.story-view__close').click();
    await walkAfterClosingNotebook(p);

    const first = storySites(0, L1)[0];
    await read(p, 0, first, 0, w, 'narrative-l1-gate-world');
    const workbook = storySites(0, L1).find(site => site.surface === 'desk')!;
    await blockedWorkbook(p, workbook);
    await read(p, 0, workbook, 0, w, 'narrative-l1-workbook-world');
    await read(p, 0, storySites(0, L1).find(site => site.id === 'scent')!, 0, w, 'narrative-l1-sticker-world');
    await p.evaluate(() => window.__escape.debug('key', -1));
    await expect.poll(async () => (await entries(p)).some(e => e.id === '0:confirmed')).toBe(true);
    const fadeBefore = w.received.filter(m => m.t === 'fade').length;
    await p.evaluate(() => window.__escape.debug('down', 1));
    await expect.poll(() => w.received.filter(m => m.t === 'fade' && m.restart).length, { timeout: 15_000 }).toBeGreaterThan(0);
    await expect(p.locator('.story-view')).toBeHidden();
    await ready(p, 0);
    await expect.poll(() => p.evaluate(() => !window.__escape.game()!.down && !window.__escape.game()!.spectate)).toBe(true);
    expect(w.received.filter(m => m.t === 'fade').length).toBeGreaterThan(fadeBefore);
    expect((await entries(p)).filter(e => e.id === noteId(0, first))).toHaveLength(1);
    expect((await entries(p)).some(e => e.id === '0:confirmed')).toBe(false);

    await p.evaluate(() => window.__escape.debug('key', -1));
    await exitTo(p, L1.exit.x, L1.exit.z, 0, 1);
    expect((await entries(p)).filter(e => e.id === '0:recap')).toHaveLength(1);
    await p.locator('.story-view__toggle').click();
    await expect(panel(p)).toBeVisible();
    await expect(p.locator('.story-view__entry').filter({ hasText: first.title })).toHaveCount(0);
    await p.getByRole('button', { name: '全部记录', exact: true }).click();
    await expect(p.locator('.story-view__entry').filter({ hasText: first.title })).toContainText(first.text);
    await expect(p.locator('.story-view__entry').filter({ hasText: workbook.title })).toContainText(workbook.text);
    await p.screenshot({ path: 'test-results/narrative-l2-review-l1.png' });
    await p.locator('.story-view__close').click();
    for (const site of storySites(1, L2)) {
      await read(p, 1, site, 1, w, `narrative-l2-${site.id}-world`);
    }
    await p.evaluate(() => window.__escape.debug('key', -2));
    await tp(p, 40, 84.5, 1);
    for (let i = 0; i < 3; i++) {
      await p.waitForTimeout(350);
      await p.evaluate(() => window.__escape.net.send({ t: 'act', kind: 'fuse', id: 0 }));
      await expect.poll(() => p.evaluate(() => (window.__escape.game() as unknown as StoryFixture).fusesIn)).toBe(i + 1);
    }
    await expect.poll(async () => (await entries(p)).some(e => e.id === '1:confirmed')).toBe(true);
    await exitTo(p, 17, 84.2, 1, 2);
    expect((await entries(p)).filter(e => e.id === '1:recap')).toHaveLength(1);

    await read(p, 2, storySites(2, L3)[0], 2, w, 'narrative-l3-chalk-world');
    await expect(p.locator('#objective .tip')).toContainText('303 → 301 → 304 → 302');
    expect(await p.evaluate(() => window.__escape.game()!.loopPlayers.get(window.__escape.game()!.myId)?.step)).toBe(0);
    await p.screenshot({ path: 'test-results/narrative-l3-chalk.png' });
    for (const site of storySites(2, L3).slice(1)) {
      await read(p, 2, site, 2, w, `narrative-l3-${site.id}-world`);
    }
    for (const [i, label] of L3.loop!.sequence.entries()) {
      const d = L3.loop!.doors.filter(d => d.label === label).at(-1)!;
      await tp(p, d.x, 84.2, 2);
      await walk(p, [[d.x, d.z - 1], [d.x, 84.2]]);
      await expect.poll(() => p.evaluate(() => window.__escape.game()!.loopPlayers.get(window.__escape.game()!.myId)?.step)).toBe(i + 1);
    }
    await exitTo(p, L3.exit.x, L3.exit.z, 2, 3);
    await settingsRemainReachable(p, 'l4-broadcast');
    expect((await entries(p)).filter(e => e.id === '2:recap')).toHaveLength(1);
    expect(w.received.filter(m => m.t === 'complete')).toHaveLength(0);
    for (const site of storySites(3, L4)) {
      await read(p, 3, site, Math.round((site.p[1] - 1.5) / 3.6), w, `narrative-l4-${site.id}-world`);
    }
    expect(await p.evaluate(() => window.__escape.game()!.broadcastView!.state.clues)).toEqual([null, null, null, null]);
    await p.screenshot({ path: 'test-results/narrative-l4-note.png' });

    for (const [id, s] of L4.broadcast!.stickers.entries()) {
      await tp(p, s.x, s.z + (s.face === 'z+' ? 1 : -1), Math.round(s.y / 3.6));
      await p.evaluate(id => window.__escape.net.send({ t: 'broadcast', op: 'read', id }), id);
      await expect.poll(() => p.evaluate(id => window.__escape.game()!.broadcastView!.state.clues[id], id)).not.toBeNull();
      // The real client also uploads 20 inputs/s. Keep these fixture placements/reads below
      // the authority's rolling 30-message limit so the next placement cannot be dropped.
      await p.waitForTimeout(350);
    }
    const station = L4.broadcast!.console;
    // The console's front aisle starts south of the corridor partition at z=131.1.
    await tp(p, station.x, station.z - 0.8, 3);
    await p.evaluate(() => { const g = window.__escape.game()!; g.input.yaw = Math.PI; g.input.pitch = 0; });
    await expect(p.locator('#prompt')).toContainText('输入');
    await focusPlay(p);
    await p.keyboard.press('e');
    await expect(p.locator('#broadcast-keypad')).toBeVisible();
    await expect(p.locator('.story-view')).toBeHidden();
    expect(await p.evaluate(() => window.__escape.game()!.input.enabled)).toBe(false);
    const code = await p.evaluate(() => window.__escape.game()!.broadcastView!.state.clues.join(''));
    await p.getByRole('textbox', { name: '四位停播密码' }).fill(code);
    await p.getByRole('button', { name: '确认停播', exact: true }).click();
    await expect.poll(async () => (await entries(p)).some(e => e.id === '3:confirmed')).toBe(true);
    await expect(p.locator('#broadcast-keypad')).toBeHidden();
    await exitTo(p, L4.exit.x, L4.exit.z, 2, 4);
    expect(w.received.filter(m => m.t === 'complete' || m.t === 'completed')).toHaveLength(0);
    await expect(panel(p)).toBeHidden();
    await expect(p.locator('.story-view__toggle')).toBeVisible();
    const model = await p.evaluate(() => window.__escape.game()!.story.state.model());
    const discoveredNotes = model.entries.filter(e => e.kind === 'note').map(e => e.id);
    expect(discoveredNotes).toEqual(prefix.flatMap((def, level) => storySites(level, def).map(site => noteId(level, site))));
    expect(model.chapter).toBe(`第5章 · ${LEVELS[4].name}`);
    expect(model.notice ?? '').not.toMatch(/当前开放的章节已结束|已经越过校门/);
    expect(model.entries.some(e => e.id.includes('ending') || e.level! >= 4)).toBe(false);
    expect(w.received.filter(m => m.t === 'room').at(-1)).toMatchObject({ level: 4 });
    console.log('NARRATIVE_COMPLETED_SCOPE', JSON.stringify({ notes: discoveredNotes, finalLevel: 4,
      completeMessages: w.received.filter(m => m.t === 'complete') }));
    expect(w.errors).toEqual([]);
  } finally { await context.close(); }
});

test('mobile taps the physical clue, reads at 844×390 and smaller widths, and leaves touch controls and chat usable', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  const p = await context.newPage(), w = wire(p);
  let release = published;
  let releaseRequests = 0;
  await p.route('**/version.json', (route) => {
    releaseRequests++;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(release) });
  });
  try {
    await create(p);
    await settingsRemainReachable(p, 'mobile-844');
    await expect.poll(() => releaseRequests).toBeGreaterThan(0);
    const site = storySites(0, L1)[0];
    await faceSite(p, site, 0, 2.2);
    await expect.poll(() => p.evaluate(() => window.__escape.game()!.story.candidateId)).toBeUndefined();
    await expect(p.locator('.story-view__read')).toBeHidden();
    await expect(p.locator('#prompt')).not.toContainText('阅读线索');
    expect(await entries(p)).toEqual([]);
    await approach(p, site, 0);
    expect(await entries(p)).toEqual([]);
    const button = p.locator('.story-view__read');
    await expect(button).toBeVisible();
    const tapBox = await button.boundingBox();
    expect(tapBox!.width).toBeGreaterThanOrEqual(44);
    expect(tapBox!.height).toBeGreaterThanOrEqual(44);
    await button.tap();
    await expect(panel(p)).toBeVisible();
    await expect(panel(p)).toContainText(site.text);
    await expect.poll(async () => (await entries(p)).some(e => e.id === noteId(0, site))).toBe(true);
    await readableMobilePanel(p);
    await p.screenshot({ path: 'test-results/narrative-mobile-844.png' });
    await p.evaluate(async () => { if (document.fullscreenElement) await document.exitFullscreen(); });
    await p.setViewportSize({ width: 667, height: 375 });
    await readableMobilePanel(p);
    await p.screenshot({ path: 'test-results/narrative-mobile-667.png' });
    await p.setViewportSize({ width: 750, height: 342 });
    await readableMobilePanel(p);
    await p.screenshot({ path: 'test-results/narrative-mobile-750.png' });
    await p.setViewportSize({ width: 640, height: 360 });
    await readableMobilePanel(p);
    await p.screenshot({ path: 'test-results/narrative-mobile-640.png' });
    await p.setViewportSize({ width: 480, height: 320 });
    const compact = await panel(p).evaluate(el => {
      const r = el.getBoundingClientRect(), scroll = el.querySelector('.story-view__scroll')!;
      return { fits: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
        width: r.width, horizontalOverflow: scroll.scrollWidth > scroll.clientWidth + 1 };
    });
    expect(compact.fits).toBe(true);
    expect(compact.width).toBeGreaterThanOrEqual(240);
    expect(compact.horizontalOverflow).toBe(false);
    await p.screenshot({ path: 'test-results/narrative-mobile-480.png' });
    await p.setViewportSize({ width: 844, height: 390 });
    await p.locator('.story-view__close').tap();
    await expect(panel(p)).toBeHidden();
    await settingsRemainReachable(p, 'mobile-844-after-close');
    release = { ...published, id: `${published.id}-narrative-layout` };
    const response = p.waitForResponse(r => new URL(r.url()).pathname === '/version.json');
    await p.evaluate(() => dispatchEvent(new Event('online')));
    await (await response).finished();
    const notice = p.locator('#update-available.in-session');
    await expect(notice).toBeVisible();
    await expect(notice.locator('[role="status"]')).toHaveText('新版本已上线，本局结束后刷新体验。');
    const noticeBox = await notice.boundingBox(), toggleBox = await p.locator('.story-view__toggle').boundingBox();
    expect(noticeBox).not.toBeNull();
    expect(toggleBox).not.toBeNull();
    const overlaps = noticeBox!.x < toggleBox!.x + toggleBox!.width && noticeBox!.x + noticeBox!.width > toggleBox!.x
      && noticeBox!.y < toggleBox!.y + toggleBox!.height && noticeBox!.y + noticeBox!.height > toggleBox!.y;
    expect(overlaps, 'passive deployment notice must leave the notebook button visible').toBe(false);
    await p.screenshot({ path: 'test-results/narrative-mobile-update-notice.png' });
    await p.locator('.story-view__toggle').tap();
    await expect(panel(p)).toBeVisible();
    console.log('NARRATIVE_NOTICE_LAYOUT', JSON.stringify(await panel(p).evaluate(el => ({
      viewport: [innerWidth, innerHeight], top: el.getBoundingClientRect().top,
      height: el.getBoundingClientRect().height, scroll: el.querySelector('.story-view__scroll')!.clientHeight,
    }))));
    await p.screenshot({ path: 'test-results/narrative-mobile-notice-panel-844.png' });
    await readableMobilePanel(p);
    await p.setViewportSize({ width: 667, height: 375 });
    await p.screenshot({ path: 'test-results/narrative-mobile-notice-panel-667.png' });
    await readableMobilePanel(p);
    await p.setViewportSize({ width: 750, height: 342 });
    await readableMobilePanel(p);
    await p.screenshot({ path: 'test-results/narrative-mobile-notice-panel-750.png' });
    await p.setViewportSize({ width: 640, height: 360 });
    await readableMobilePanel(p);
    await p.screenshot({ path: 'test-results/narrative-mobile-notice-panel-640.png' });
    await p.setViewportSize({ width: 667, height: 375 });
    await p.locator('.story-view__close').tap();
    await settingsRemainReachable(p, 'mobile-667-notice');
    await expect(p.locator('#touch-btns')).toBeVisible();
    await p.locator('#touch-chat').tap();
    await expect(p.locator('#chat-input')).toBeVisible();
    await p.locator('#chat-input').fill('j');
    await p.keyboard.press('j');
    await expect(panel(p)).toBeHidden();
    expect(w.sent.some(m => m.t === 'act' || m.t === 'broadcast')).toBe(false);
    expect(w.errors).toEqual([]);
  } finally { await context.close(); }
});
