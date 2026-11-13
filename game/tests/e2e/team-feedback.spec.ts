import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { F_CROUCH, F_LIGHT, F_RUN, ST_DOWN, ST_OK, type ServerMsg, type Vec3 } from '../../shared/protocol.ts';
import { assertActiveSince, assertPrivateCapture, FeedbackPeer, reviveWith, waitFor } from '../team-feedback-peer.ts';

test.use({ isMobile: true, hasTouch: true });

test('small touch screen: private caught UI, short teammate notice, breathing and sustained rescue', async ({ page, baseURL }, testInfo) => {
  test.setTimeout(100_000);
  await page.setViewportSize({ width: 640, height: 360 });
  const errors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  const peers: FeedbackPeer[] = [];
  const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), baseURL, viewport: { width: 640, height: 360 } };
  await mkdir('test-results', { recursive: true });
  try {
    await page.goto('/?nodraw&steady');
    await page.fill('#name', '手机甲');
    await page.tap('#create');
    await expect.poll(() => page.evaluate(() => window.__escape.code), { timeout: 30_000 }).toMatch(/^[A-Z2-9]{4}$/);
    const code = await page.evaluate(() => window.__escape.code);
    for (const name of ['队友乙', '救援丙']) {
      const p = await new FeedbackPeer(name, baseURL!.replace('http', 'ws') + '/ws').connect();
      peers.push(p); p.send({ t: 'join', code }); await p.waitMessage(0, 'room');
    }
    const [b, c] = peers;
    await expect(page.locator('#wait-members li')).toHaveCount(3);
    await page.tap('#start');
    await expect.poll(() => page.evaluate(() => (window.__escape.game() as any)?.spawnSynced), { timeout: 45_000 }).toBe(true);
    const device = await page.evaluate(() => ({ width: innerWidth, height: innerHeight,
      touchPoints: navigator.maxTouchPoints, coarsePointer: matchMedia('(pointer: coarse)').matches,
      touchUI: document.body.classList.contains('touch') }));
    expect(device).toMatchObject({ width: 640, height: 360, coarsePointer: true, touchUI: true });
    expect(device.touchPoints).toBeGreaterThan(0);
    evidence.device = device;
    await waitFor(() => peers.every((p) => p.players.size === 3), 'bots have all authoritative players');
    await page.waitForFunction(() => !(window.__escape.game() as any).intro.active, null, { timeout: 15_000 });
    await expect(page.locator('#touch-btns')).toBeVisible();
    b.send({ t: 'debug', op: 'safe', s: 600 });
    b.send({ t: 'debug', op: 'safe', s: 600, mob: 1 });
    await expect.poll(() => page.evaluate(() => window.__escape.game()?.snaps ?? 0)).toBeGreaterThan(8);
    await expect(page.locator('#banner')).toBeHidden({ timeout: 10_000 });
    const ownId = await page.evaluate(() => (window.__escape.game() as any).myId as number);
    await page.evaluate(() => {
      const n = window.__escape.net, original = n.onMsg;
      (window as any).__feedbackWire = [];
      (window as any).__feedbackStates = [];
      n.onMsg = (m) => {
        if (m.t === 'caught' || m.t === 'team-caught') (window as any).__feedbackWire.push(m);
        if (m.t === 'snap') (window as any).__feedbackStates.push({ tick: m.tick, players: m.players.map((p) => ({ id: p.id, st: p.st ?? 0 })) });
        original?.(m);
      };
      const g = window.__escape.game() as any;
      g.input.yaw = Math.PI / 2; g.input.pitch = -.25;
    });
    await page.waitForTimeout(150);
    const ownContact: Vec3 = await page.evaluate(() => {
      const g = window.__escape.game() as any;
      return [g.body.x, g.body.y, g.body.z] as Vec3;
    });
    await page.evaluate(() => window.__escape.debug('warden', 1.5));
    await expect(page.locator('#down-overlay')).toBeVisible({ timeout: 15_000 });
    b.send({ t: 'debug', op: 'safe', s: 600, mob: 1 });
    b.send({ t: 'debug', op: 'safe', s: 600 });
    await expect(page.locator('#down-overlay .t')).toHaveText('你被角色074抓住了');
    await expect(page.locator('#down-overlay .n')).toHaveText(/^(?:[1-9]|[12]\d|30)$/);
    await expect(page.locator('#chat-log')).not.toContainText(/你被|手机甲被|回到出生点倒地/);
    await page.evaluate(() => { (window.__escape.game() as any).draw = true; });
    await page.waitForTimeout(250);
    const penaltyLayout = await page.evaluate(() => {
      const rect = (selector: string) => {
        const r = document.querySelector(selector)!.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      };
      return { title: rect('#down-overlay .t'), timer: rect('#down-overlay .n'),
        countdownLine: rect('#down-overlay > div:last-child'), width: innerWidth, height: innerHeight,
        overflow: document.documentElement.scrollWidth > innerWidth };
    });
    expect(penaltyLayout.title.top).toBeGreaterThanOrEqual(12);
    expect(penaltyLayout.title.left).toBeGreaterThanOrEqual(20);
    expect(penaltyLayout.title.right).toBeLessThanOrEqual(penaltyLayout.width - 20);
    expect(penaltyLayout.title.bottom).toBeLessThanOrEqual(penaltyLayout.countdownLine.top);
    expect(penaltyLayout.timer.top).toBeGreaterThanOrEqual(penaltyLayout.countdownLine.top);
    expect(penaltyLayout.timer.bottom).toBeLessThanOrEqual(penaltyLayout.countdownLine.bottom);
    expect(penaltyLayout.countdownLine.bottom).toBeLessThanOrEqual(penaltyLayout.height - 16);
    expect(penaltyLayout.overflow).toBe(false);
    await expect(page.locator('#objective')).toHaveCSS('visibility', 'hidden');
    await expect(page.locator('.story-view')).toHaveCSS('visibility', 'hidden');
    await expect(page.locator('#touch-btns')).toHaveCSS('visibility', 'hidden');
    await expect(page.locator('#touch-chat')).toBeVisible();
    evidence.penaltyLayout = penaltyLayout;
    await page.screenshot({ path: 'test-results/team-feedback-mobile-self.png' });
    await waitFor(() => peers.every((p) => p.state(ownId)?.st === ST_DOWN), 'private victim down snapshot reaches both real clients');
    const own = b.state(ownId)!;
    expect(Math.hypot(...own.p.map((v, axis) => v - ownContact[axis]))).toBeLessThan(.015);
    await b.teleport(own.p[0] + .9, own.p[2]);
    await reviveWith(b, ownId, peers);
    const ownUpTick = b.tick;
    await expect(page.locator('#down-overlay')).toBeHidden({ timeout: 5000 });
    await expect.poll(() => page.evaluate(() => {
      const g = window.__escape.game() as any; return !g.down && !g.spectate;
    })).toBe(true);
    await expect(page.locator('#objective')).toBeVisible();
    await expect(page.locator('.story-view')).toBeVisible();
    await expect(page.locator('#touch-btns')).toBeVisible();
    const wire: ServerMsg[] = await page.evaluate(() => (window as any).__feedbackWire);
    expect(wire).toHaveLength(1);
    const ownCapture = assertPrivateCapture(wire[0], { id: ownId, seq: 1, by: 'warden', at: ownContact }, b.snapshots);
    expect(wire).toEqual([ownCapture]);
    for (const p of peers) {
      expect(p.messages(0, 'caught')).toHaveLength(0);
      const notices = p.messages(0, 'team-caught').map(({ m }) => m);
      expect(notices).toEqual([{ t: 'team-caught', id: ownId, by: 'warden', episode: 1 }]);
    }
    evidence.self = { ownId, ownUpTick, wire };

    // Catch farther down the real corridor, then bring the real observer to the unchanged contact position.
    await b.teleport(-30, 73.36);
    const peerContact: Vec3 = [...b.state()!.p];
    const peerMarks = peers.map((p) => p.mark());
    b.look(Math.PI / 2, 0, F_CROUCH | F_RUN | F_LIGHT); b.send({ t: 'debug', op: 'warden', d: 1.5 });
    const notice = '队友乙被角色074抓住了';
    await expect(page.locator('#chat-log')).toContainText(notice, { timeout: 15_000 });
    c.send({ t: 'debug', op: 'safe', s: 600, mob: 1 });
    const noticeLine = page.locator('#chat-log div').filter({ hasText: notice });
    await expect(noticeLine).toHaveCount(1);
    await expect(noticeLine).toHaveText(notice);
    await waitFor(() => peers.every((p) => p.state(b.id)?.st === ST_DOWN), 'teammate down snapshot reaches both real clients');
    const caughtTick = b.tick;
    expect(Math.hypot(...b.state()!.p.map((v, axis) => v - peerContact[axis]))).toBeLessThan(.015);
    await page.evaluate(([x, y, z]) => window.__escape.debug('tp', x + 3, z, Math.round(y / 3.6)), peerContact);
    await expect.poll(() => page.evaluate(([x, z]) => {
      const g = window.__escape.game() as any;
      return Math.hypot(g.body.x - x - 3, g.body.z - z);
    }, [peerContact[0], peerContact[2]])).toBeLessThan(.08);
    await expect(page.locator('#chat-log')).not.toContainText('无人搀扶');
    await expect.poll(() => page.evaluate((id) => {
      const r = (window.__escape.game() as any).remotes.get(id);
      return !!r?.down && r.st.fallen === 1;
    }, b.id)).toBe(true);
    expect(b.state()!.f).toBe(F_LIGHT);
    evidence.downedFlags = { before: F_CROUCH | F_RUN | F_LIGHT, after: b.state()!.f };
    // The crouch-to-down transition must finish at the authoritative floor, never half a metre below it.
    await expect.poll(() => page.evaluate(([id, floorY]) => {
      const r = (window.__escape.game() as any).remotes.get(id);
      return Math.abs(r.mesh.position.y - floorY);
    }, [b.id, b.state()!.p[1]]), { timeout: 5000 }).toBeLessThan(.001);
    await page.evaluate(() => { const g = window.__escape.game() as any; g.input.yaw = Math.PI / 2; g.input.pitch = -.4; g.light = true; });

    const breathing = await page.evaluate(async (id) => {
      const g = window.__escape.game() as any, THREE = window.__escape.THREE;
      const samples: { at: number; chest: number; chestY: number; root: number[]; top: number; bottom: number; horizontal: number; visible: boolean; screen: number[] }[] = [];
      let started: number | undefined;
      await new Promise<void>((resolve) => {
        const sample = () => {
          const now = performance.now();
          started ??= now;
          const elapsed = now - started;
          const r = g.remotes.get(id), s = r.st;
          r.mesh.updateMatrixWorld(true);
          const chest = s.warden.bones.chest.getWorldPosition(new THREE.Vector3());
          const hips = s.warden.bones.hips.getWorldPosition(new THREE.Vector3());
          s.warden.mesh.computeBoundingBox();
          const box = s.warden.mesh.boundingBox.clone().applyMatrix4(s.warden.mesh.matrixWorld);
          const screen = box.getCenter(new THREE.Vector3()).project(g.camera);
          samples.push({ at: elapsed, chest: s.warden.bones.chest.rotation.x, chestY: chest.y - hips.y,
            root: r.mesh.position.toArray(), top: box.max.y - r.mesh.position.y, bottom: box.min.y - r.mesh.position.y,
            horizontal: Math.max(box.max.x - box.min.x, box.max.z - box.min.z),
            visible: r.mesh.visible && s.warden.root.visible, screen: screen.toArray() });
          if (elapsed >= 3500) resolve(); else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      return samples;
    }, b.id);
    const range = (values: number[]) => Math.max(...values) - Math.min(...values);
    const chestRange = range(breathing.map((s) => s.chest)), chestYRange = range(breathing.map((s) => s.chestY));
    evidence.breathing = { frames: breathing.length, chestRange, chestYRange, samples: breathing };
    expect(breathing.length).toBeGreaterThan(20);
    expect(breathing.at(-1)!.at - breathing[0].at).toBeGreaterThanOrEqual(3500);
    expect(chestRange).toBeGreaterThan(.03);
    expect(chestRange).toBeLessThan(.07);
    expect(chestYRange).toBeGreaterThan(.003);
    expect(Math.max(...breathing.map((s) => s.top))).toBeLessThan(.6);
    expect(Math.min(...breathing.map((s) => s.bottom))).toBeGreaterThan(-.02);
    expect(Math.max(...breathing.map((s) => s.bottom))).toBeLessThan(.03);
    expect(Math.min(...breathing.map((s) => s.horizontal))).toBeGreaterThan(1.2);
    // The animated body must remain in the actual camera view throughout the measured frames.
    for (const sample of breathing) {
      expect(sample.visible).toBe(true);
      expect(Math.abs(sample.screen[0])).toBeLessThan(1);
      expect(Math.abs(sample.screen[1])).toBeLessThan(1);
      expect(Math.abs(sample.screen[2])).toBeLessThan(1);
    }
    for (const axis of [0, 1, 2]) expect(range(breathing.map((s) => s.root[axis]))).toBeLessThan(.001);
    for (const sample of breathing) expect(Math.abs(sample.root[1] - b.state()!.p[1])).toBeLessThan(.001);
    await page.screenshot({ path: 'test-results/team-feedback-mobile-down.png' });

    // A real WS rescue, observed by the mobile page and both renderer-free clients.
    const down = b.state()!;
    await c.teleport(down.p[0] + .9, down.p[2]);
    const holdMs = await reviveWith(c, b.id, peers);
    const upTick = c.tick;
    await c.teleport(down.p[0] - 3, down.p[2]);
    await waitFor(() => c.tick >= upTick + 45, 'rescued teammate stays ST_OK for over two seconds');
    const immediateSamples = assertActiveSince(peers, b.id, upTick);
    await expect(page.locator('#down-overlay')).toBeHidden();
    const up = await page.evaluate((id) => {
      const g = window.__escape.game() as any, r = g.remotes.get(id);
      r.mesh.updateMatrixWorld(true); r.st.warden.mesh.computeBoundingBox();
      const box = r.st.warden.mesh.boundingBox.clone().applyMatrix4(r.st.warden.mesh.matrixWorld);
      const gl = g.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
      return { down: r.down, out: r.out, visible: r.mesh.visible, fallen: r.st.fallen,
        height: box.max.y - r.mesh.position.y, ownSpectate: g.spectate,
        renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        overflow: document.documentElement.scrollWidth > innerWidth };
    }, b.id);
    expect(up).toMatchObject({ down: false, out: false, visible: true, fallen: 0, ownSpectate: false, overflow: false });
    expect(up.height).toBeGreaterThanOrEqual(1.5);
    expect(up.renderer).toMatch(/Apple|Metal/i);
    await page.screenshot({ path: 'test-results/team-feedback-mobile-revived.png' });
    await waitFor(() => peers.every((p) => p.tick >= caughtTick + 625), 'mobile rescue remains active beyond the original thirty-second expiry', 40_000);
    const activeSamples = assertActiveSince(peers, b.id, upTick);
    const browserStates: { tick: number; players: { id: number; st: number }[] }[] = await page.evaluate(() => (window as any).__feedbackStates);
    const browserActive = browserStates.filter((s) => s.tick >= upTick);
    const ownActive = browserStates.filter((s) => s.tick >= ownUpTick);
    expect(browserActive.length).toBeGreaterThan(40);
    expect(browserActive.at(-1)!.tick).toBeGreaterThanOrEqual(caughtTick + 625);
    for (const s of browserActive) expect(s.players.find((p) => p.id === b.id)?.st, `mobile teammate state at tick ${s.tick}`).toBe(ST_OK);
    for (const s of ownActive) expect(s.players.find((p) => p.id === ownId)?.st, `mobile self state at tick ${s.tick}`).toBe(ST_OK);
    const ownActiveSamples = assertActiveSince(peers, ownId, ownUpTick);
    await expect(page.locator('#spec-bar')).toBeHidden();
    await expect(page.locator('#down-overlay')).toBeHidden();
    await expect.poll(() => page.evaluate((id) => {
      const g = window.__escape.game() as any, r = g.remotes.get(id);
      return !g.down && !g.spectate && !r.down && !r.out && r.st.fallen === 0;
    }, b.id)).toBe(true);
    const finalWire: ServerMsg[] = await page.evaluate(() => (window as any).__feedbackWire);
    expect(finalWire).toEqual([
      ownCapture,
      { t: 'team-caught', id: b.id, by: 'warden', episode: 2 },
    ]);
    const peerCaught = b.messages(peerMarks[0], 'caught').map(({ m }) => m);
    expect(peerCaught).toHaveLength(1);
    expect(peerCaught).toEqual([assertPrivateCapture(peerCaught[0], { id: b.id, seq: 1, by: 'warden', at: peerContact }, b.snapshots)]);
    expect(b.messages(peerMarks[0], 'team-caught')).toHaveLength(0);
    expect(c.messages(peerMarks[1], 'caught')).toHaveLength(0);
    expect(c.messages(peerMarks[1], 'team-caught').map(({ m }) => m)).toEqual([{ t: 'team-caught', id: b.id, by: 'warden', episode: 2 }]);
    evidence.revived = { ...up, holdMs, caughtTick, upTick, finalTick: c.tick, immediateSamples, activeSamples, ownActiveSamples,
      browserSamples: browserActive.length, browserSelfSamples: ownActive.length };
    evidence.wire = finalWire;
    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    evidence.status = 'passed';
  } catch (error) {
    evidence.status = 'failed'; evidence.error = error instanceof Error ? error.stack : String(error);
    throw error;
  } finally {
    evidence.pageErrors = errors;
    evidence.consoleErrors = consoleErrors;
    evidence.finishedAt = new Date().toISOString();
    evidence.video = 'Playwright artifact; no external Gemini score is available in this session';
    await writeFile('test-results/team-feedback-mobile.json', JSON.stringify(evidence, null, 2));
    await testInfo.attach('team-feedback-mobile', { path: 'test-results/team-feedback-mobile.json', contentType: 'application/json' });
    await Promise.all(peers.map((p) => p.close()));
  }
});
