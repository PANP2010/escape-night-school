import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import type { MobSnap, ServerMsg } from '../../shared/protocol.ts';

test('L4 rollcall keeps the book and bowed head while real scheduled calls identify the player', async ({ page }, info) => {
  const errors: string[] = [], calls: Extract<ServerMsg, { t: 'broadcast' }>[] = [];
  const teacher: MobSnap = { id: 1, p: [0, 0, 0], yaw: 0 };
  let ownId = 0;
  page.on('pageerror', e => errors.push(e.message));
  page.on('websocket', ws => ws.on('framereceived', ({ payload }) => {
    const msg = JSON.parse(String(payload)) as ServerMsg;
    if (msg.t === 'welcome') ownId = msg.id;
    if (msg.t === 'broadcast' && msg.call) calls.push(msg);
    if (msg.t === 'snap') {
      const mob = msg.mobs.find(m => m.id === 1);
      if (mob) Object.assign(teacher, mob);
    }
  }));
  await page.goto('/?nodraw&steady');
  await page.fill('#name', '点名形态验收');
  await page.click('#create');
  await page.click('#start');
  await expect(page.locator('#room-code')).toContainText('第 4 关');
  await expect.poll(() => page.evaluate(() => window.__escape.game()?.presentationReady), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => teacher.form).toBe('rollcall');
  await page.waitForTimeout(3_500); // let the real opening title finish before framing the teacher
  await page.evaluate(() => {
    const g = window.__escape.game()!;
    g.input.yaw = Math.PI / 2; g.input.pitch = 0; g.light = true;
  });
  // Let the real input reach the server before placing the teacher in front of the camera.
  await expect.poll(() => page.evaluate(() => window.__escape.game()!.snaps)).toBeGreaterThan(6);
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    window.__escape.debug('warden', 4);
    window.__escape.debug('safe', 600, 1);
    const g = window.__escape.game()!;
    g.draw = true; g.renderer.domElement.style.visibility = '';
  });
  await page.waitForTimeout(800);
  const pose = await page.evaluate(() => {
    const g = window.__escape.game() as any, T = window.__escape.THREE, m = g.mobs.byId.get(1);
    const book = g.scene.getObjectByName('warden-rollcall-book'), head = m.warden.bones.head;
    const bookAt = book.getWorldPosition(new T.Vector3()), headAt = head.getWorldPosition(new T.Vector3());
    const facing = new T.Vector3(0, 0, 1).applyQuaternion(head.getWorldQuaternion(new T.Quaternion()));
    const gl = g.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      form: m.form, bookVisible: book.visible, bookAt: bookAt.toArray(), headAt: headAt.toArray(),
      projected: bookAt.clone().project(g.camera).toArray(), headDirection: facing.toArray(),
      hatVisible: m.forms.hat.visible, flashlightVisible: m.forms.flashlight.visible,
      lightIntensity: g.scene.getObjectByName('warden-night-light').intensity,
      renderer: ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '',
    };
  });
  expect(pose.renderer).toContain('Metal');
  expect(pose.form).toBe('rollcall');
  expect(pose.bookVisible).toBe(true);
  expect(pose.hatVisible).toBe(false);
  expect(pose.flashlightVisible).toBe(false);
  expect(pose.lightIntensity).toBe(0);
  expect(pose.bookAt[1]).toBeGreaterThan(7.7);
  expect(pose.bookAt[1]).toBeLessThan(pose.headAt[1]);
  expect(pose.headDirection[1]).toBeLessThan(-0.1);
  expect(Math.abs(pose.projected[0])).toBeLessThan(0.95);
  expect(Math.abs(pose.projected[1])).toBeLessThan(0.95);
  expect(pose.projected[2]).toBeLessThan(1);
  await page.screenshot({ path: info.outputPath('rollcall-book-real-ws.png') });
  await page.evaluate(() => { window.__escape.game()!.draw = false; });
  // Use the unmodified 60–90 s room schedule: this checks the player name and HUD are wired to a real call.
  await expect.poll(() => calls.find(s => s.call?.id === ownId), { timeout: 95_000, intervals: [200] }).toBeTruthy();
  await expect(page.locator('#broadcast-status')).toContainText('正在点名：点名形态验收');
  await expect(page.locator('#broadcast-status')).toContainText('位置暴露');
  await page.evaluate(() => { window.__escape.game()!.draw = true; });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.screenshot({ path: info.outputPath('rollcall-name-real-ws.png') });
  expect(teacher.form).toBe('rollcall');
  expect(errors).toEqual([]);
  const evidence = info.outputPath('rollcall-wire-and-pose.json');
  await writeFile(evidence, JSON.stringify({ pose, teacher, calls, errors }, null, 2));
  await info.attach('rollcall-wire-and-pose', { path: evidence, contentType: 'application/json' });
});
