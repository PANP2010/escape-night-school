import { expect, test, type Page } from '@playwright/test';
import WebSocket from 'ws';
import { mkdir, writeFile } from 'node:fs/promises';
import type { ServerMsg } from '../../shared/protocol.ts';

test.use({ viewport: { width: 960, height: 640 } });

async function enter(page: Page) {
  await page.goto('/?steady');
  await page.fill('#name', '视觉验收');
  await page.click('#create');
  await expect(page.locator('#wait-code')).toHaveText(/^[A-Z2-9]{4}$/);
}
async function start(page: Page) {
  await page.click('#start');
  await expect(page.locator('#intro-skip')).toBeVisible({ timeout: 30000 });
  await page.click('#intro-skip');
  await page.waitForFunction(() => {
    const game = window.__escape.game();
    return !!game?.presentationReady && !game.intro.active;
  }, null, { timeout: 30000 });
  await page.evaluate(() => window.__escape.debug('safe', 600));
}

test('teacher uses the campus fill and still responds to the real flashlight in the rendered corridor', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await mkdir('test-results/warden-contact', { recursive: true });
  await enter(page); await start(page);
  await page.evaluate(() => {
    const g = window.__escape.game()!;
    g.input.yaw = Math.PI / 2;
    window.__escape.debug('tp', -48, 73.4);
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => { window.__escape.debug('warden', 3); window.__escape.debug('safe', 600); });
  await page.waitForFunction(() => {
    const mob = window.__escape.game()!.mobs.byId.get(1);
    // A teacher may already exist in the room. Wait for the actual summon position before holding this render fixture.
    return !!mob && Math.hypot(mob.mesh.position.x + 48, mob.mesh.position.z - 73.4) < 4;
  });
  await page.evaluate(() => {
    const g = window.__escape.game() as any, mob = g.mobs.byId.get(1);
    // Hold one real snapshot model/pose for a repeatable material comparison. This is a render fixture, not a server catch.
    g.mobs.update = () => {};
    mob.warden.anim.pose('idle', .3); mob.mesh.rotation.y = -Math.PI / 2;
    g.view = { x: mob.mesh.position.x + 2.1, y: mob.mesh.position.y + 1.25,
      z: mob.mesh.position.z, yaw: Math.PI / 2, pitch: 0 };
  });
  await page.waitForTimeout(200);
  const probe = await page.evaluate(() => {
    const g = window.__escape.game() as any, mob = g.mobs.byId.get(1);
    g.renderFrame();
    const gl = g.renderer.getContext(), debug = gl.getExtension('WEBGL_debug_renderer_info');
    const materials = mob.warden.mesh.material;
    const uniforms = materials.map((material: any) => g.renderer.properties.get(material).uniforms)
      .filter((uniform: any) => uniform?.wardenAmbient);
    const fills = uniforms.map((uniform: any) => uniform.wardenAmbient.value.toArray());
    return { renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), fills };
  });
  expect(probe.fills.length).toBeGreaterThanOrEqual(7);
  expect(probe.fills.every((rgb: number[]) => rgb.every(value => value > .025 && value <= .2))).toBe(true);
  await page.screenshot({ path: 'test-results/warden-contact/corridor-fill.png' });
  await page.keyboard.press('KeyF');
  await page.waitForTimeout(150);
  await page.screenshot({ path: 'test-results/warden-contact/corridor-torch.png' });
  expect(errors).toEqual([]);
  await writeFile('test-results/warden-contact/lighting-evidence.json', JSON.stringify({ ...probe, errors }, null, 2));
});

test('a genuine server catch shows one readable near-face accent and hands off to the original shoulder animation', async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await mkdir('test-results/warden-contact', { recursive: true });
  await enter(page);
  const code = await page.locator('#wait-code').innerText();
  const teammate = new WebSocket(baseURL!.replace(/^http/, 'ws') + '/ws');
  const messages: ServerMsg[] = [];
  teammate.on('message', raw => {
    const message = JSON.parse(String(raw)) as ServerMsg; messages.push(message);
    if (message.t === 'event' && message.kind === 'intro' && !message.ended) teammate.send(JSON.stringify({ t: 'intro-skip', id: message.id }));
    if (message.t === 'room' && message.started) teammate.send(JSON.stringify({ t: 'ready', incarnation: message.incarnation }));
  });
  await new Promise<void>((resolve, reject) => { teammate.once('open', resolve); teammate.once('error', reject); });
  teammate.send(JSON.stringify({ t: 'hello', name: '保留救援窗口' }));
  teammate.send(JSON.stringify({ t: 'join', code }));
  try {
    await expect(page.locator('#wait-members li')).toHaveCount(2);
    await start(page);
    await page.keyboard.press('KeyF');
    await page.evaluate(() => {
      const g = window.__escape.game() as any;
      g.input.yaw = Math.PI / 2; g.input.pitch = 0;
      window.__escape.debug('tp', -48, 73.4);
      const probe: any = { events: [], samples: [], running: true };
      (window as any).__wardenContact = probe;
      const handle = window.__escape.net.onMsg.bind(window.__escape.net);
      window.__escape.net.onMsg = message => { if (message.t === 'caught') probe.events.push(message); handle(message); };
      const sample = () => {
        if (!probe.running) return;
        const frame = g.captureFrame, actor = g.camera.getObjectByName('capture-warden-contact');
        probe.samples.push({ elapsed: frame.elapsed, caught: frame.caught, shoulder: frame.shoulder,
          visible: actor.visible, position: actor.position.toArray(), opacity: actor.children[0].material[0].opacity,
          sourceVisible: g.mobs.byId.get(1)?.warden.mesh.visible,
          body: [g.body.x, g.body.y, g.body.z] });
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.waitForTimeout(250); // the accepted look input sets the authoritative summon direction along the corridor
    await page.evaluate(() => window.__escape.debug('warden', 1.5));
    await page.waitForFunction(() => (window.__escape.game() as any).capture.diagnostics.starts === 1, null, { polling: 'raf', timeout: 15000 });
    await page.waitForFunction(() => (window.__escape.game() as any).captureFrame.elapsed > 110, null, { polling: 'raf' });
    await page.screenshot({ path: 'test-results/warden-contact/actual-catch-face.png' });
    await page.waitForFunction(() => (window.__escape.game() as any).captureFrame.elapsed > 650, null, { polling: 'raf' });
    await page.screenshot({ path: 'test-results/warden-contact/actual-catch-shoulder.png' });
    await page.waitForFunction(() => (window.__escape.game() as any).captureFrame.phase === 'down', null, { polling: 'raf' });
    const evidence = await page.evaluate(() => {
      const g = window.__escape.game() as any, probe = (window as any).__wardenContact;
      probe.running = false;
      return { ...probe, starts: g.capture.diagnostics.starts, sound: g.sound.diagnostics };
    });
    expect(evidence.events).toHaveLength(1);
    const event = evidence.events[0];
    expect(event).toMatchObject({ t: 'caught', by: 'warden', hold: 30 });
    expect(Math.hypot(event.at[0] - event.source[0], event.at[2] - event.source[2])).toBeLessThanOrEqual(3);
    expect(evidence.samples.some((s: any) => s.caught && s.visible && s.opacity > .8)).toBe(true);
    expect(evidence.samples.filter((s: any) => s.caught && s.visible).every((s: any) => !s.sourceVisible)).toBe(true);
    expect(evidence.samples.some((s: any) => s.caught && s.elapsed > 600 && !s.visible && s.shoulder > .8)).toBe(true);
    expect(evidence.samples.some((s: any) => s.caught && s.elapsed > 600 && s.sourceVisible)).toBe(true);
    expect(evidence.sound.played.capture).toBe(1);
    const captured = evidence.samples.filter((s: any) => s.caught);
    expect(captured.every((s: any) => Math.hypot(s.body[0] - event.at[0], s.body[2] - event.at[2]) < .015)).toBe(true);
    await page.evaluate(caught => { for (let i = 0; i < 5; i++) window.__escape.net.onMsg(caught); }, event);
    expect(await page.evaluate(() => (window.__escape.game() as any).capture.diagnostics.starts)).toBe(1);
    expect(await page.evaluate(() => (window.__escape.game() as any).sound.diagnostics.played.capture)).toBe(1);
    expect(errors).toEqual([]);
    await writeFile('test-results/warden-contact/capture-evidence.json', JSON.stringify({ ...evidence, errors }, null, 2));
  } finally {
    teammate.close();
  }
});

test('the real stairwell introduction lights the restored original teacher without changing its palette', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await mkdir('test-results/warden-contact', { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await enter(page); await page.click('#start');
  await page.waitForFunction(() => {
    const g = window.__escape.game() as any;
    return g?.presentationReady && g.intro.active && g.intro.remaining < 2.75
      && g.intro.remaining > 2.4 && g.intro.figure?.root.visible;
  }, null, { polling: 'raf', timeout: 20000 });
  const result = await page.evaluate(() => {
    const g = window.__escape.game() as any;
    const figure = g.intro.figure;
    g.renderFrame();
    const fills = figure.mesh.material.map((material: any) => g.renderer.properties.get(material).uniforms)
      .filter((uniform: any) => uniform?.wardenAmbient)
      .map((uniform: any) => ({ uniform, ambient: uniform.wardenAmbient.value.clone(), eye: uniform.wardenEye.value }));
    const gl = g.renderer.getContext(), width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
    const capture = () => {
      g.renderFrame();
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return { pixels, png: g.renderer.domElement.toDataURL('image/png') };
    };
    // Same real cinematic camera, original palette, pose and room in one frame. Compare actual diffuse fill on/off.
    fills.forEach(({ uniform }: any) => { uniform.wardenAmbient.value.setRGB(0, 0, 0); uniform.wardenEye.value = 0; });
    const before = capture();
    fills.forEach(({ uniform, ambient, eye }: any) => { uniform.wardenAmbient.value.copy(ambient); uniform.wardenEye.value = eye; });
    const after = capture();
    let count = 0, previous = 0, current = 0;
    for (let i = 0; i < before.pixels.length; i += 4) {
      const a = before.pixels, b = after.pixels;
      if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) < 6) continue;
      previous += a[i] * .2126 + a[i + 1] * .7152 + a[i + 2] * .0722;
      current += b[i] * .2126 + b[i + 1] * .7152 + b[i + 2] * .0722; count++;
    }
    return { before: before.png, after: after.png, metrics: {
      pixelsCompared: count, unlitMeanLuma: previous / count, litMeanLuma: current / count,
      camera: g.camera.position.toArray(), figure: figure.root.position.toArray(),
    } };
  });
  await writeFile('test-results/warden-contact/intro-without-fill.png', Buffer.from(result.before.split(',')[1], 'base64'));
  await writeFile('test-results/warden-contact/intro-with-fill.png', Buffer.from(result.after.split(',')[1], 'base64'));
  await page.screenshot({ path: 'test-results/warden-contact/intro-stairwell.png' });
  await writeFile('test-results/warden-contact/intro-colour-evidence.json', JSON.stringify({ ...result.metrics, errors }, null, 2));
  expect(result.metrics.pixelsCompared).toBeGreaterThan(100);
  expect(result.metrics.litMeanLuma).toBeGreaterThan(result.metrics.unlitMeanLuma * 1.15);
  expect(errors).toEqual([]);
});
