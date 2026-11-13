import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import type { MobSnap, PlayerSnap } from '../../shared/protocol.ts';
import { CollisionWorld } from '../../shared/campus/collision.ts';
import { lineOfSight } from '../../shared/campus/nav.ts';

type MobState = MobSnap & { form: string; anim: string; kind: string };
type WireSample = { tick: number; player: PlayerSnap; warden: MobState };

const stareText = '你喜欢我吗？看着我的眼睛，你真的喜欢我吗？！';
const angle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const facesWarden = ({ player: p, warden: w }: WireSample) =>
  Math.abs(angle(Math.atan2(-(w.p[0] - p.p[0]), -(w.p[2] - p.p[2])) - p.yaw)) < 0.25;

async function draw(page: Page, on: boolean) {
  await page.evaluate((on) => {
    const g = window.__escape.game() as any;
    g.draw = on;
    g.renderer.domElement.style.visibility = on ? '' : 'hidden';
  }, on);
  if (on) await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function frozenShot(page: Page, source: string, path: string) {
  await page.evaluate(async (source) => {
    const c = (window.__escape.game() as any).renderer.domElement as HTMLCanvasElement;
    const img = document.createElement('img'), r = c.getBoundingClientRect();
    img.id = 'forms-shot';
    Object.assign(img.style, { position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, pointerEvents: 'none' });
    img.src = source;
    c.after(img);
    await img.decode();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }, source);
  await page.screenshot({ path });
  await page.evaluate(() => document.getElementById('forms-shot')?.remove());
}

async function visibleWarden(page: Page, info: TestInfo, label: string, wire?: WireSample) {
  const state = await page.evaluate(() => {
    const g = window.__escape.game() as any, T = window.__escape.THREE, m = g.mobs.byId.get(1);
    const head = m.warden.bones.head.getWorldPosition(new T.Vector3());
    const projected = head.clone().project(g.camera), spot = g.scene.getObjectByName('warden-night-light');
    return {
      body: { ...g.body }, pos: { ...g.pos }, camera: g.camera.position.toArray(), yaw: g.input.yaw, pitch: g.input.pitch,
      cameraYaw: g.camera.rotation.y, cameraPitch: g.camera.rotation.x, view: g.view,
      mob: m.mesh.position.toArray(), mobWorld: m.mesh.getWorldPosition(new T.Vector3()).toArray(), mobYaw: m.mesh.rotation.y,
      form: m.form, rootVisible: m.mesh.visible, meshVisible: m.warden.mesh.visible, head: head.toArray(), projected: projected.toArray(),
      light: spot ? { p: spot.position.toArray(), target: spot.target.position.toArray(), intensity: spot.intensity } : null,
      boxes: g.campus.collision.query(Math.min(head.x, g.camera.position.x), Math.min(head.z, g.camera.position.z), Math.max(head.x, g.camera.position.x), Math.max(head.z, g.camera.position.z)),
    };
  });
  const [cx, cy, cz] = state.camera, [hx, hy, hz] = state.head;
  const los = lineOfSight(new CollisionWorld(state.boxes), { x: cx, y: cy, z: cz }, { x: hx, y: hy, z: hz });
  const { boxes: _boxes, ...report } = state;
  await info.attach(label, { body: Buffer.from(JSON.stringify({ ...report, los, wire }, null, 2)), contentType: 'application/json' });
  console.log(label, JSON.stringify({ ...report, los, wire }));
  expect(state.rootVisible).toBe(true);
  expect(state.meshVisible).toBe(true);
  expect(Math.abs(state.projected[0])).toBeLessThan(0.95);
  expect(Math.abs(state.projected[1])).toBeLessThan(0.95);
  expect(state.projected[2]).toBeGreaterThan(-1);
  expect(state.projected[2]).toBeLessThan(1);
  expect(los).toBe(true);
}

test('continuous real gaze changes Warden; L2 night patrol retains the monitor and sweeps a real light', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const mobs = new Map<number, MobState>();
  const samples: WireSample[] = [];
  const lines: { tick: number; id: string; text: string }[] = [];
  let ownId = 0, tick = 0;
  page.on('websocket', (ws) => {
    expect(new URL(ws.url()).pathname).toBe('/ws');
    ws.on('framereceived', ({ payload }) => {
      const m = JSON.parse(String(payload));
      if (m.t === 'welcome') ownId = m.id;
      if (m.t === 'event' && m.kind === 'line') lines.push({ tick: tick + 1, id: m.id, text: m.text });
      if (m.t !== 'snap') return;
      tick = m.tick;
      const ids = new Set<number>();
      for (const v of m.mobs as MobSnap[]) {
        ids.add(v.id);
        mobs.set(v.id, { ...mobs.get(v.id), ...v } as MobState);
      }
      for (const id of mobs.keys()) if (!ids.has(id)) mobs.delete(id);
      const player = (m.players as PlayerSnap[]).find((p) => p.id === ownId), warden = mobs.get(1);
      if (player && warden) samples.push({ tick, player, warden: { ...warden } });
    });
  });

  await page.goto('/?nodraw&steady');
  await page.fill('#name', '形态验收');
  await page.click('#create');
  await page.click('#start');
  await expect(page.locator('#hud')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => (window.__escape.game() as any)?.spawnSynced), { timeout: 30_000 }).toBe(true);
  const renderer = await page.evaluate(() => {
    const gl = (window.__escape.game() as any).renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
  });
  expect(renderer).toContain('Metal');
  await expect.poll(() => mobs.get(1)?.form, { timeout: 10_000 }).toBe('normal');
  await page.evaluate(() => {
    const g = window.__escape.game() as any;
    g.input.yaw = -Math.PI / 2;
    g.input.pitch = 0;
  });
  await expect.poll(() => Math.abs(angle((samples.at(-1)?.player.yaw ?? 0) + Math.PI / 2))).toBeLessThan(0.03);
  await page.evaluate(() => window.__escape.debug('warden', 19));
  await expect.poll(() => {
    const s = samples.at(-1);
    return s ? Math.hypot(s.warden.p[0] - s.player.p[0], s.warden.p[2] - s.player.p[2]) : 100;
  }, { timeout: 3_000, intervals: [25, 50] }).toBeLessThan(19.1);

  // A first one-second look must not count across an interruption.
  await page.evaluate(() => {
    const w = window as any, g = window.__escape.game() as any;
    w.__formsWatching = true;
    w.__formsAim = setInterval(() => {
      if (!w.__formsWatching) return;
      const m = g.mobs.byId.get(1);
      if (m) g.input.yaw = Math.atan2(-(m.mesh.position.x - g.body.x), -(m.mesh.position.z - g.body.z));
    }, 16);
  });
  await page.waitForTimeout(1_000);
  expect(mobs.get(1)?.form).toBe('normal');
  await page.evaluate(() => {
    (window as any).__formsWatching = false;
    (window.__escape.game() as any).input.yaw = Math.PI / 2;
  });
  await expect.poll(() => Math.abs(angle((samples.at(-1)?.player.yaw ?? 0) - Math.PI / 2)), { intervals: [25, 50] }).toBeLessThan(0.03);
  await page.waitForTimeout(350);
  expect(mobs.get(1)?.form).toBe('normal');
  await draw(page, true);
  const resumedAfter = tick;
  await page.evaluate(() => { (window as any).__formsWatching = true; });
  await expect.poll(() => mobs.get(1)?.form, { timeout: 5_000, intervals: [25, 50] }).toBe('changed');
  const changed = samples.find((s) => s.tick > resumedAfter && s.warden.form === 'changed')!;
  const restarted = samples.find((s) => s.tick > resumedAfter && facesWarden(s))!;
  expect(restarted).toBeTruthy();
  expect(changed.tick - restarted.tick).toBeGreaterThanOrEqual(39);
  expect(changed.warden.anim).toBe('chase');
  expect(lines.find((l) => l.id === 'likeme')?.text).toBe(stareText);
  await page.evaluate(() => {
    clearInterval((window as any).__formsAim);
    window.__escape.debug('safe', 600, 1);
    const g = window.__escape.game() as any;
    g.light = true;
    g.input.yaw = -Math.PI / 2;
    g.input.pitch = 0;
  });
  await page.waitForTimeout(250);
  await visibleWarden(page, info, 'changed-neck-position', samples.at(-1));
  await page.screenshot({ path: info.outputPath('changed-neck-real-ws.png') });
  await page.evaluate(() => {
    const g = window.__escape.game() as any;
    window.__escape.debug('tp', g.body.x - 1.5, g.body.z);
  });
  await expect.poll(() => page.evaluate(() => (window.__escape.game() as any).mobs.byId.get(1)?.form)).toBe('changed');
  await page.waitForTimeout(1_400);
  await draw(page, true);
  await visibleWarden(page, info, 'changed-restored-position', samples.at(-1));
  await page.screenshot({ path: info.outputPath('changed-real-ws.png') });
  await draw(page, false);

  // Travel through the real room's exit so the normal level-reset path restores the L2 base form.
  await page.evaluate(() => {
    window.__escape.debug('key', -1);
    window.__escape.debug('tp', -61, 66);
  });
  await expect(page.locator('#room-code')).toContainText('第 2 关', { timeout: 20_000 });
  await page.evaluate(() => {
    window.__escape.debug('safe', 600, 1);
    window.__escape.debug('safe', 600, 2);
  });
  await expect(page.locator('#fade-overlay')).toBeHidden({ timeout: 15_000 });
  await page.waitForFunction(() => {
    const g = window.__escape.game(); return g?.level.index === 1 && g.presentationReady && !g.intro.active;
  });
  await expect.poll(() => mobs.get(1)?.form).toBe('night');
  await expect.poll(() => mobs.get(2)?.kind).toBe('monitor');
  await expect.poll(() => page.evaluate(() => {
    const g = window.__escape.game() as any;
    return g.campus.blackout && g.body.y > 3 && g.mobs.byId.get(1)?.form === 'night' && g.mobs.byId.get(2)?.monitor;
  })).toBe(true);

  await page.evaluate(() => {
    window.__escape.debug('tp', 40, 84.2);
    const g = window.__escape.game() as any;
    g.input.yaw = Math.PI / 2;
    g.input.pitch = 0;
    g.light = false;
  });
  await expect.poll(() => samples.at(-1)?.player.p[0]).toBeCloseTo(40, 1);
  await expect.poll(() => Math.abs(angle((samples.at(-1)?.player.yaw ?? 0) - Math.PI / 2))).toBeLessThan(0.03);
  await page.evaluate(() => {
    window.__escape.debug('warden', 6);
    window.__escape.debug('safe', 600, 1);
    window.__escape.debug('tp', 47, 84.2);
  });
  await expect.poll(() => samples.at(-1)?.player.p[0]).toBeCloseTo(47, 1);
  await page.waitForTimeout(1_800);
  const light = await page.evaluate(async () => {
    const g = window.__escape.game() as any, T = window.__escape.THREE;
    const hat = g.scene.getObjectByName('warden-night-hat');
    const held = g.scene.getObjectByName('warden-night-flashlight');
    const spot = g.scene.getObjectByName('warden-night-light');
    if (!hat || !held || !spot) return null;
    const directions: number[][] = [];
    const start = performance.now();
    while (performance.now() - start < 2_000) {
      g.scene.updateMatrixWorld(true);
      const at = spot.getWorldPosition(new T.Vector3()), target = spot.target.getWorldPosition(new T.Vector3());
      directions.push(target.sub(at).normalize().toArray());
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    const first = new T.Vector3(...directions[0] as [number, number, number]);
    return {
      form: g.mobs.byId.get(1).form, monitor: g.mobs.byId.get(2).monitor,
      hat: hat.visible, held: held.visible, real: !!spot.isSpotLight,
      visible: spot.visible, intensity: spot.intensity, decay: spot.decay,
      sweep: Math.max(...directions.map((v) => first.angleTo(new T.Vector3(...v as [number, number, number])))),
      frames: directions.length,
    };
  });
  expect(light).not.toBeNull();
  expect(light).toMatchObject({ form: 'night', monitor: true, hat: true, held: true, real: true, visible: true });
  expect(light!.intensity).toBeGreaterThan(0);
  expect(light!.decay).toBeGreaterThanOrEqual(2);
  expect(light!.frames).toBeGreaterThan(10);
  expect(light!.sweep).toBeGreaterThan(0.05);
  // Stand behind the actual teacher so the beam's floor pool is ahead of the camera, inside the frame.
  const nightCamera = await page.evaluate(() => {
    const g = window.__escape.game() as any, m = g.mobs.byId.get(1), yaw = m.mesh.rotation.y;
    const x = m.mesh.position.x + Math.sin(yaw) * 4, z = m.mesh.position.z + Math.cos(yaw) * 4;
    window.__escape.debug('tp', x, z);
    g.input.yaw = yaw;
    g.input.pitch = -0.05;
    return { x, z };
  });
  await expect.poll(() => page.evaluate(({ x, z }) => {
    const g = window.__escape.game() as any;
    return Math.hypot(g.body.x - x, g.body.z - z);
  }, nightCamera)).toBeLessThan(0.08);
  await draw(page, true);
  await visibleWarden(page, info, 'night-position', samples.at(-1));
  // Compare identical camera / pose / scan phase, rendering the real SpotLight off and on in one task.
  const illumination = await page.evaluate(() => {
    const g = window.__escape.game() as any, spot = g.scene.getObjectByName('warden-night-light');
    const gl = g.renderer.getContext(), width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
    const off = new Uint8Array(width * height * 4), on = new Uint8Array(off.length), intensity = spot.intensity;
    spot.intensity = 0;
    g.renderer.render(g.scene, g.camera);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, off);
    const offImage = g.renderer.domElement.toDataURL();
    spot.intensity = intensity;
    g.renderer.render(g.scene, g.camera);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, on);
    const onImage = g.renderer.domElement.toDataURL();
    let gain = 0, maxGain = 0, changedPixels = 0, offMaxChannel = 0, onMaxChannel = 0, onBrightPixels = 0;
    for (let i = 0; i < off.length; i += 4) {
      const d = ((on[i] + on[i + 1] + on[i + 2]) - (off[i] + off[i + 1] + off[i + 2])) / 3;
      gain += Math.max(0, d);
      maxGain = Math.max(maxGain, d);
      if (d > 4) changedPixels++;
      offMaxChannel = Math.max(offMaxChannel, off[i], off[i + 1], off[i + 2]);
      onMaxChannel = Math.max(onMaxChannel, on[i], on[i + 1], on[i + 2]);
      if ((on[i] + on[i + 1] + on[i + 2]) / 3 >= 240) onBrightPixels++;
    }
    return { offImage, onImage, positiveMean: gain / (width * height), maxGain, changedPixels, offMaxChannel, onMaxChannel, onBrightPixelRatio: onBrightPixels / (width * height) };
  });
  await frozenShot(page, illumination.offImage, info.outputPath('night-real-spot-off.png'));
  await frozenShot(page, illumination.onImage, info.outputPath('night-real-spot-on.png'));
  const { offImage: _offImage, onImage: _onImage, ...illuminationStats } = illumination;
  await info.attach('night-illumination', { body: Buffer.from(JSON.stringify({ ...illuminationStats, light })), contentType: 'application/json' });
  console.log('night-illumination', JSON.stringify({ ...illuminationStats, light }));
  expect(illumination.changedPixels).toBeGreaterThan(100);
  expect(illumination.maxGain).toBeGreaterThan(10);
  expect(illumination.positiveMean).toBeGreaterThan(0.15);
  expect(illumination.onBrightPixelRatio).toBeLessThan(0.005);
  await draw(page, true);
  await page.screenshot({ path: info.outputPath('night-real-ws-light.png') });
  await page.waitForTimeout(8_000);
  await page.screenshot({ path: info.outputPath('night-real-ws-sweep.png') });
  const frontCamera = await page.evaluate(() => {
    const g = window.__escape.game() as any, m = g.mobs.byId.get(1), yaw = m.mesh.rotation.y;
    const x = m.mesh.position.x - Math.sin(yaw) * 4, z = m.mesh.position.z - Math.cos(yaw) * 4;
    window.__escape.debug('tp', x, z);
    g.input.yaw = yaw + Math.PI;
    g.input.pitch = 0;
    g.light = true;
    return { x, z };
  });
  await expect.poll(() => page.evaluate(({ x, z }) => {
    const g = window.__escape.game() as any;
    return Math.hypot(g.body.x - x, g.body.z - z);
  }, frontCamera)).toBeLessThan(0.08);
  await page.waitForTimeout(250);
  await visibleWarden(page, info, 'night-front-position', samples.at(-1));
  await page.screenshot({ path: info.outputPath('night-real-ws-hat.png') });
  expect(mobs.get(1)?.form).toBe('night');
  expect(mobs.get(2)?.kind).toBe('monitor');
  expect(errors).toEqual([]);
  const evidence = info.outputPath('real-ws-form-evidence.json');
  await writeFile(evidence, JSON.stringify({ renderer, resumedAfter, restarted, changed, lines, light, illumination: illuminationStats, errors }, null, 2));
  await info.attach('real-ws-form-evidence', { path: evidence, contentType: 'application/json' });
});
