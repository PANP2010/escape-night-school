import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { RESUME_KEY } from '../../client/src/reconnect.ts';

interface RoomWire {
  t: 'room'; code: string; host: number; level: number; started: boolean;
  public?: boolean; allowLateJoin?: boolean; players: { id: number; name: string }[];
}
interface WireState {
  id?: number;
  room?: RoomWire;
  players: { id: number; st?: number }[];
  snapshots: number;
  lists: number;
}
interface Peer { page: Page; context: BrowserContext; wire: WireState; name: string }

const evidenceDir = 'test-results';
const freshWire = (): WireState => ({ players: [], snapshots: 0, lists: 0 });

function observe(peer: Peer, faults: string[]) {
  peer.page.on('pageerror', error => faults.push(`${peer.name}: ${error.message}`));
  peer.page.on('console', message => {
    if (message.type() === 'error') faults.push(`${peer.name}: ${message.text()}`);
  });
  peer.page.on('websocket', socket => socket.on('framereceived', frame => {
    const message = JSON.parse(frame.payload.toString()) as {
      t: string; id?: number; players?: WireState['players'];
    };
    if (message.t === 'welcome') peer.wire.id = message.id;
    if (message.t === 'room') peer.wire.room = message as RoomWire;
    if (message.t === 'rooms') peer.wire.lists += 1;
    if (message.t === 'snap') {
      peer.wire.snapshots += 1;
      peer.wire.players = message.players ?? [];
    }
  }));
}

async function enter(peers: Peer[], baseURL: string) {
  // Closing a document now reserves its seat for reconnect. Leave each scenario's public room explicitly
  // through ordinary private-room creation, so the next privacy check has no unrelated reserved public room.
  if (peers.some(peer => peer.page.url().startsWith(baseURL) && peer.wire.room)) {
    await peers[0].page.waitForTimeout(1100); // respect the server's shared create / quick cooldown
    await Promise.all(peers.map(async peer => {
      if (!peer.page.url().startsWith(baseURL) || !peer.wire.room) return;
      const previous = peer.wire.room.code;
      await peer.page.evaluate(() => window.__escape.net.send({ t: 'create', public: false }));
      await expect.poll(() => peer.wire.room?.code).not.toBe(previous);
      expect(peer.wire.room?.public).toBe(false);
    }));
  }
  // Reuse the same three contexts while discarding the deliberately abandoned private-room identity.
  for (const peer of peers) if (peer.page.url().startsWith(baseURL)) {
    await peer.page.evaluate(key => sessionStorage.removeItem(key), RESUME_KEY);
  }
  await Promise.all(peers.map(peer => peer.page.goto('about:blank')));
  for (const peer of peers) peer.wire = freshWire();
  await Promise.all(peers.map(async peer => {
    await peer.page.goto(`${baseURL}/?nodraw&steady`);
    await expect(peer.page.locator('#quick-join')).toBeEnabled();
    await primaryActionsOnFirstScreen(peer);
    await peer.page.fill('#name', peer.name);
    await expect.poll(() => peer.wire.id).toBeGreaterThan(0);
  }));
}

async function primaryActionsOnFirstScreen(peer: Peer) {
  // Measured before any click, fill or scrollIntoView: the long create settings must not push the main actions below the fold.
  const layout = await peer.page.evaluate(() => {
    const lobby = document.getElementById('lobby')!;
    return {
      scrollTop: lobby.scrollTop,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth || lobby.scrollWidth > lobby.clientWidth,
      actions: ['create', 'quick-join', 'join'].map(id => {
        const element = document.getElementById(id)!;
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return { id, inside: box.top >= 0 && box.left >= 0 && box.bottom <= innerHeight && box.right <= innerWidth, hit: !!hit && element.contains(hit), touch44: box.height >= 44 };
      }),
    };
  });
  expect(layout).toEqual({
    scrollTop: 0, horizontalOverflow: false,
    actions: ['create', 'quick-join', 'join'].map(id => ({ id, inside: true, hit: true, touch44: true })),
  });
}

async function create(peer: Peer, visibility: 'public' | 'private', lateJoin = true) {
  await peer.page.check(`#visibility-${visibility}`);
  if (visibility === 'public') await peer.page.locator('#allow-late-join').setChecked(lateJoin);
  await peer.page.click('#create');
  await expect(peer.page.locator('#waiting')).toBeVisible();
  const code = (await peer.page.locator('#wait-code').textContent())!.trim();
  expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);
  return code;
}

async function swipeUp(peer: Peer) {
  // The room list scrolls independently. Swipe the outer cover's left gutter to reveal
  // the detailed create settings and updates, rather than consuming the gesture inside #public-rooms.
  const { x, start, end } = await peer.page.evaluate(() => {
    const entry = document.getElementById('entry')!.getBoundingClientRect();
    return { x: Math.max(18, entry.left / 2), start: innerHeight - 44, end: 80 };
  });
  const session = await peer.context.newCDPSession(peer.page);
  try {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: start }] });
    for (let y = start - 24; y >= end; y -= 24) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
      await peer.page.waitForTimeout(16);
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await session.detach();
  }
}

async function activeL1(peer: Peer, count: number, spectator = false) {
  await expect(peer.page.locator('#hud')).toBeVisible({ timeout: 45_000 });
  await expect(peer.page.locator('#room-code')).toContainText(`· ${count} 人 · 第 1 关`);
  await expect.poll(() => ({
    started: peer.wire.room?.started,
    level: peer.wire.room?.level,
    members: peer.wire.room?.players.length,
    snapshots: peer.wire.snapshots > 0,
    snapshotMembers: peer.wire.players.length,
    selfPresent: peer.wire.players.some(player => player.id === peer.wire.id),
    selfState: peer.wire.players.find(player => player.id === peer.wire.id)?.st ?? 0,
  }), { timeout: 45_000 }).toEqual({ started: true, level: 0, members: count, snapshots: true, snapshotMembers: count, selfPresent: true, selfState: spectator ? 2 : 0 });
  await expect.poll(() => peer.page.evaluate(() => {
    const game = window.__escape.game();
    return { ready: !!game?.presentationReady, level: game?.level.index, spectator: game?.spectate };
  }), { timeout: 45_000 }).toEqual({ ready: true, level: 0, spectator });
}

test('one browser and three real contexts cover the public lobby and privacy rules', async ({ browser, baseURL }) => {
  await mkdir(evidenceDir, { recursive: true });
  const faults: string[] = [];
  const cases: string[] = [];
  let status: 'running' | 'passed' | 'failed' = 'running';
  let failure: string | undefined;
  // Exactly one fixture browser and three independently isolated users.
  const contexts = await Promise.all([
    browser.newContext({ viewport: { width: 1280, height: 720 } }),
    browser.newContext({ viewport: { width: 1280, height: 720 } }),
    browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 }),
  ]);
  const peers = await Promise.all(contexts.map(async (context, index): Promise<Peer> => ({
    context, page: await context.newPage(), wire: freshWire(), name: ['大厅甲', '大厅乙', '大厅丙'][index]!,
  })));
  const [a, b, c] = peers as [Peer, Peer, Peer];
  peers.forEach(peer => observe(peer, faults));
  const row = (peer: Peer, code: string) => peer.page.locator(`#public-rooms .public-room[data-code="${code}"]`);
  const allRows = (peer: Peer) => peer.page.locator('#public-rooms .public-room');
  try {
    await enter(peers, baseURL!);
    const code = await create(a, 'public');
    await expect(row(b, code)).toBeVisible();
    await expect(row(b, code).locator('.room-name')).toHaveText('大厅甲的教室');
    await expect(row(b, code).locator('.room-count')).toContainText('1/4');
    await expect(row(b, code).locator('.room-state')).toHaveText('初见 · 等待中 · 指引开启 · 不计排行');
    await expect(row(b, code).locator('.room-latency')).toContainText(/\d+\s*ms/);
    await b.page.screenshot({ path: `${evidenceDir}/public-lobby-desktop.png` });
    await expect(row(c, code)).toBeVisible();
    await expect.poll(() => c.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await c.page.screenshot({ path: `${evidenceDir}/public-lobby-mobile-844x390.png` });
    await swipeUp(c);
    await expect.poll(() => c.page.locator('#lobby').evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await expect(c.page.locator('#mode-selector')).toBeInViewport({ ratio: 1 });
    await swipeUp(c);
    for (const setting of ['.visibility-options', '.late-join-option']) await expect(c.page.locator(setting)).toBeInViewport({ ratio: 1 });
    await expect(c.page.locator('#updates')).toBeInViewport();
    await c.page.screenshot({ path: `${evidenceDir}/public-lobby-mobile-scrolled-844x390.png` });
    cases.push('Create, quick join and code join start on the first screen; landscape touch swipes reveal mode, visibility, late join and the update notice');
    await row(b, code).locator('.room-join').click();
    await expect(b.page.locator('#wait-code')).toHaveText(code);
    await c.page.locator('#quick-join').tap();
    await expect(c.page.locator('#wait-code')).toHaveText(code);
    const expectedIds = peers.map(peer => peer.wire.id).sort((left, right) => left! - right!);
    expect(new Set(expectedIds).size).toBe(3);
    for (const peer of peers) {
      await expect(peer.page.locator('#wait-members li')).toHaveCount(3);
      for (const member of peers) await expect(peer.page.locator('#wait-members')).toContainText(member.name);
      expect(peer.wire.room?.code).toBe(code);
      expect(peer.wire.room?.players.map(player => player.id).sort((left, right) => left - right)).toEqual(expectedIds);
    }
    await a.page.click('#start');
    await Promise.all(peers.map(peer => activeL1(peer, 3)));
    for (const peer of peers) {
      expect(peer.wire.room?.code).toBe(code);
      expect(peer.wire.players.map(player => player.id).sort((left, right) => left - right)).toEqual(expectedIds);
    }
    cases.push('A creates public; B joins its list row; C quick joins; all three enter L1 over real WS');

    await enter(peers, baseURL!);
    const secret = await create(a, 'private');
    // Each other client receives a complete list after the private room exists.
    for (const peer of [b, c]) {
      const listsBefore = peer.wire.lists;
      await peer.page.click('#refresh-rooms');
      await expect.poll(() => peer.wire.lists).toBeGreaterThan(listsBefore);
      await expect(row(peer, secret)).toHaveCount(0);
      await expect(allRows(peer)).toHaveCount(0);
    }
    await b.page.fill('#code', secret.toLowerCase());
    await b.page.click('#join');
    await expect(b.page.locator('#wait-code')).toHaveText(secret);
    await expect(a.page.locator('#wait-members li')).toHaveCount(2);
    // A private room does not become the target of quick join.
    await c.page.locator('#quick-join').tap();
    await expect(c.page.locator('#waiting')).toBeVisible();
    const quickCode = (await c.page.locator('#wait-code').textContent())!.trim();
    expect(quickCode).not.toBe(secret);
    expect(c.wire.room?.public).toBe(true);
    await expect(c.page.locator('#wait-members li')).toHaveCount(1);
    cases.push('Private room is absent from both other lists, remains joinable by code, and quick creates public when no public room exists');

    await enter(peers, baseURL!);
    const playing = await create(a, 'public', true);
    await a.page.click('#start');
    await activeL1(a, 1);
    await expect(row(b, playing).locator('.room-state')).toHaveText('初见 · 第 1 关进行中 · 指引开启 · 不计排行');
    await expect(row(b, playing).locator('.room-join')).toHaveText('观察加入');
    await expect(row(b, playing)).toContainText('下一关参与');
    await row(b, playing).locator('.room-join').click();
    await activeL1(b, 2, true);
    await expect(b.page.locator('#spec-bar')).toBeVisible();
    cases.push('A playing public room accepts late join as spectator for the current level');

    await enter(peers, baseURL!);
    const closed = await create(a, 'public', false);
    await a.page.click('#start');
    await activeL1(a, 1);
    await expect(row(b, closed).locator('.room-state')).toHaveText('初见 · 第 1 关进行中 · 指引开启 · 不计排行');
    await expect(row(b, closed).locator('.room-join')).toBeDisabled();
    await c.page.fill('#code', closed);
    await c.page.click('#join');
    await expect(c.page.locator('#err')).toContainText(/不允许|关闭|禁止|不能|不接受/);
    await expect(c.page.locator('#hud')).toBeHidden();
    await expect(c.page.locator('#waiting')).toBeHidden();
    expect(a.wire.room?.players.length).toBe(1);
    cases.push('A playing room with late join disabled is disabled in the list and server rejects its room code');
    expect(faults).toEqual([]);
    status = 'passed';
  } catch (error) {
    status = 'failed';
    failure = error instanceof Error ? error.stack ?? error.message : String(error);
    throw error;
  } finally {
    try {
      await writeFile(`${evidenceDir}/public-lobby-browser.json`, JSON.stringify({
        status, failure, baseURL, browserContexts: 3,
        viewport: { desktop: '1280x720', mobile: '844x390' }, cases, faults,
        peers: peers.map(peer => ({ name: peer.name, ...peer.wire })),
      }, null, 2));
    } finally {
      await Promise.all(contexts.map(context => context.close()));
    }
  }
});
