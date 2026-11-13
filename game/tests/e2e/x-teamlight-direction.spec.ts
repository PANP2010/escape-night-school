import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { devices, expect, test, type Page } from '@playwright/test';
import { CollisionWorld } from '../../shared/campus/collision.ts';
import { beamHit } from '../../shared/campus/nav.ts';
import { frame } from './draw.ts';

// BASELINE=1 records the old optical result without declaring it fixed. All placement, real-ws, shader/console,
// source alignment and light-budget checks remain hard assertions. The normal run always checks the optical limits.
const baseline = process.env.BASELINE === '1';
const evidence = process.env.TEAMLIGHT_EVIDENCE ?? (baseline ? 'before' : 'final');
const { defaultBrowserType: _browser, ...phone } = devices['iPhone 13 landscape'];
const names = ['甲', '乙', '丙'];
const YAW = Math.PI / 2, PITCH = -0.4;
const AT = { x: -41.285, z: 73.36 };
type PixelPoint = { x: number; y: number };
type Region = { mean: number; p10: number; p90: number; max: number; pixels: number; visible: number; saturated: number };
type Capture = Awaited<ReturnType<typeof capture>>;
type PerformanceSample = { fps: number; maxGapMs: number; snaps: number };

async function pose(page: Page, yaw: number, light: boolean, pitch = PITCH) {
  await page.evaluate(({ yaw, light, pitch }) => {
    const g = window.__escape.game()!; g.input.yaw = yaw; g.input.pitch = pitch; g.light = light;
  }, { yaw, light, pitch });
}

/** A rejected or collision-adjusted teleport fails here instead of silently measuring a different scene. */
async function place(page: Page, x: number, z: number) {
  await page.evaluate(({ x, z }) => {
    const g = window.__escape.game()!, a = g.level.def.area;
    if (x < a.x0 || x > a.x1 || z < a.z0 || z > a.z1) throw new Error(`out-of-level placement: ${x},${z}`);
    window.__escape.debug('tp', x, z, 0);
  }, { x, z });
  await expect.poll(() => page.evaluate(({ x, z }) => {
    const g = window.__escape.game()!; return Math.hypot(g.pos.x - x, g.pos.z - z);
  }, { x, z }), { timeout: 15_000, message: `server accepted tp(${x},${z})` }).toBeLessThan(0.08);
}

async function remotePlacement(observer: Page, name: string, x: number, z: number) {
  await expect.poll(() => observer.evaluate(({ name, x, z }) => {
    const g = window.__escape.game()!;
    const r = [...g.remotes].find(([id]) => g.names.get(id) === name)?.[1];
    return r ? Math.hypot(r.mesh.position.x - x, r.mesh.position.z - z) : Infinity;
  }, { name, x, z }), { timeout: 15_000, message: `${name}'s interpolated real-ws placement (${x},${z})` }).toBeLessThan(0.08);
}

async function settled(page: Page, b: boolean, c: boolean, cYaw = YAW + 0.3) {
  await expect.poll(() => page.evaluate(({ b, c, cYaw }) => {
    const g = window.__escape.game()!;
    const rs = [...g.remotes].map(([id, r]) => ({ name: g.names.get(id), r }));
    return [['乙', b, Math.PI / 2 + 0.3], ['丙', c, cYaw]].every(([n, lit, yaw]) => {
      const r = rs.find((o) => o.name === n)?.r;
      return r && !!(r.f & 4) === lit && Math.abs(r.pitch + 0.4) < 0.02
        && Math.abs(Math.atan2(Math.sin(r.mesh.rotation.y - Number(yaw)), Math.cos(r.mesh.rotation.y - Number(yaw)))) < 0.025;
    });
  }, { b, c, cYaw }), { timeout: 15_000, message: 'real remote snapshots and yaw/pitch settled' }).toBe(true);
  await page.waitForTimeout(450); // completes the existing 0.15/0.2 s holder fade, not an input substitute
}

/** Actual WebGL frames; cone isolation changes only mesh visibility for one synchronous comparison render. */
async function capture(page: Page, file: string, withHud = false, isolateCones = false) {
  await frame(page, 1);
  const result = await page.evaluate((isolateCones) => {
    const g = window.__escape.game()!, T = window.__escape.THREE;
    const image = document.getElementById('e2e-shot') as HTMLImageElement;
    // Graphics settings may supersample at 1.5 DPR. Compare the actual rendered view
    // in CSS pixels so the historical 640×360 fixture and projected pixel limits retain their units.
    const cv = document.createElement('canvas'); cv.width = innerWidth; cv.height = innerHeight;
    const ctx = cv.getContext('2d', { willReadFrequently: true })!;
    // Both comparison frames use one JS task: no game update, snapshot, camera movement or light/spot change can
    // occur between them. Copy each backbuffer immediately, restoring every cone even if the render fails.
    if (isolateCones) g.renderer.render(g.scene, g.camera);
    ctx.drawImage(isolateCones ? g.renderer.domElement : image, 0, 0, cv.width, cv.height);
    const render = { ...window.__escape.stats(), geometries: g.renderer.info.memory.geometries, textures: g.renderer.info.memory.textures };
    const png = cv.toDataURL();
    let withoutConesData: Uint8ClampedArray | undefined, withoutConesPng: string | null = null;
    let coneIsolation: { hiddenCones: number; restored: boolean; render: { calls: number; triangles: number } } | null = null;
    if (isolateCones) {
      const cones = [...g.remotes.values()].map((r) => {
        const cone = (r.st as unknown as { cone: { visible: boolean } }).cone;
        return { cone, visible: cone.visible };
      });
      const hidden = document.createElement('canvas'); hidden.width = cv.width; hidden.height = cv.height;
      const hiddenCtx = hidden.getContext('2d', { willReadFrequently: true })!;
      try {
        for (const { cone } of cones) cone.visible = false;
        g.renderer.render(g.scene, g.camera);
        hiddenCtx.drawImage(g.renderer.domElement, 0, 0, hidden.width, hidden.height);
        coneIsolation = { hiddenCones: cones.filter((c) => c.visible).length, restored: false, render: window.__escape.stats() };
      } finally {
        for (const { cone, visible } of cones) cone.visible = visible;
      }
      if (coneIsolation) coneIsolation.restored = cones.every(({ cone, visible }) => cone.visible === visible);
      withoutConesData = hiddenCtx.getImageData(0, 0, hidden.width, hidden.height).data;
      withoutConesPng = hidden.toDataURL();
      image.src = png; // Keep the complete beam in the optional HUD screenshot.
    }
    const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
    const W = cv.width, H = cv.height;
    const project = (v: InstanceType<typeof T.Vector3>): PixelPoint => {
      const p = v.clone().project(g.camera); return { x: (p.x + 1) * W / 2, y: (1 - p.y) * H / 2 };
    };
    const polygon = (points: PixelPoint[], pixels: Uint8ClampedArray = data): Region => {
      const x0 = Math.max(0, Math.floor(Math.min(...points.map((p) => p.x))));
      const x1 = Math.min(W, Math.ceil(Math.max(...points.map((p) => p.x))));
      const y0 = Math.max(0, Math.floor(Math.min(...points.map((p) => p.y))));
      const y1 = Math.min(H, Math.ceil(Math.max(...points.map((p) => p.y))));
      const values: number[] = [];
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        let inside = false;
        for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
          const a = points[i], b = points[j];
          if ((a.y > y + 0.5) !== (b.y > y + 0.5) && x + 0.5 < (b.x - a.x) * (y + 0.5 - a.y) / (b.y - a.y) + a.x) inside = !inside;
        }
        if (inside) { const i = (y * W + x) * 4; values.push(0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]); }
      }
      values.sort((a, b) => a - b);
      return { mean: values.reduce((s, v) => s + v, 0) / Math.max(1, values.length), p10: values[Math.floor(values.length * 0.1)] ?? 0,
        p90: values[Math.floor(values.length * 0.9)] ?? 0, max: values.at(-1) ?? 0, pixels: values.length,
        visible: values.filter((v) => v >= 8).length / Math.max(1, values.length),
        saturated: values.filter((v) => v >= 250).length / Math.max(1, values.length) };
    };
    const box = (x0: number, y0: number, x1: number, y1: number) => polygon([
      { x: x0 * W, y: y0 * H }, { x: x1 * W, y: y0 * H }, { x: x1 * W, y: y1 * H }, { x: x0 * W, y: y1 * H },
    ]);
    const remote = [...g.remotes].map(([id, r]) => {
      const o = new T.Vector3(), d = new T.Vector3(); r.st.beam(o, d);
      r.st.spot.updateWorldMatrix(true, false);
      const hit = new T.Vector3().setFromMatrixPosition(r.st.spot.matrixWorld);
      const forwardFloor = (yaw: number, near = 3, far = 6, halfWidth = 0.45) => {
        const f = new T.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)), side = new T.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
        // The requested 3–6 m band in front of the player, 0.9 m wide. Its corners remain inside the L1 corridor.
        const worldPoints = [[near, -halfWidth], [far, -halfWidth], [far, halfWidth], [near, halfWidth]].map(([s, w]) =>
          r.mesh.position.clone().addScaledVector(f, s).addScaledVector(side, w).add(new T.Vector3(0, 0.025, 0)));
        const points = worldPoints.map(project), a = g.level.def.area;
        return { points, worldPoints: worldPoints.map((v) => v.toArray()),
          inLevel: worldPoints.every((v) => v.x >= a.x0 && v.x <= a.x1 && v.z >= a.z0 && v.z <= a.z1),
          inFrame: points.every((p) => p.x >= 0 && p.x < W && p.y >= 0 && p.y < H), stats: polygon(points) };
      };
      // Only the jacket torso: no floating name tag, hand-held lens, or landing decal in this region.
      const side = new T.Vector3(1, 0, 0).applyQuaternion(g.camera.quaternion); side.y = 0; side.normalize();
      const torso = [[-0.13, 0.65], [0.13, 0.65], [0.13, 1.2], [-0.13, 1.2]].map(([w, y]) =>
        project(r.mesh.position.clone().addScaledVector(side, w).add(new T.Vector3(0, y, 0))));
      // A small vertical strip through the airborne beam, deliberately above the floor and clear of the name tag.
      const air = [[0.9, -0.08], [2.1, -0.08], [2.1, 0.08], [0.9, 0.08]].map(([t, y]) =>
        project(o.clone().addScaledVector(d, t).add(new T.Vector3(0, y, 0))));
      const ownSlot = g.teamPick.slots.findIndex((s) => s.holder === id);
      const lamp = ownSlot >= 0 ? g.teamLights[ownSlot] : undefined;
      const lampDir = lamp ? lamp.target.position.clone().sub(lamp.position).normalize() : undefined;
      return { id, name: g.names.get(id), lit: !!(r.f & 4), pos: r.mesh.position.toArray(), yaw: r.mesh.rotation.y, pitch: r.pitch,
        origin: o.toArray(), direction: d.toArray(), spotVisible: r.st.spot.visible, spot: hit.toArray(), spotPx: project(hit),
        floorPlus: forwardFloor(Math.PI / 2 + 0.3), floorMinus: forwardFloor(Math.PI / 2 - 0.3),
        // Every point lies within 3 m of the feet, preserving the separate review #210 acceptance region.
        feet: forwardFloor(Math.PI / 2 + 0.3, 0.3, 2.8, 0.4),
        torso: { points: torso, inFrame: torso.every((p) => p.x >= 0 && p.x < W && p.y >= 0 && p.y < H), stats: polygon(torso) },
        air: { points: air, stats: polygon(air), withoutCones: withoutConesData ? polygon(air, withoutConesData) : null },
        alignment: lampDir ? lampDir.dot(d) : null, sourceGap: lamp ? lamp.position.distanceTo(o) : null };
    });
    let spotLights = 0, wardenNightLights = 0, pointLights = 0;
    g.scene.traverse((o) => { const l = o as InstanceType<typeof T.Light> & { isSpotLight?: boolean; isPointLight?: boolean }; if (l.isSpotLight) { spotLights++; if (l.name === 'warden-night-light') wardenNightLights++; } if (l.isPointLight) pointLights++; });
    const l = g.flashlight;
    const gl = g.renderer.getContext(), debug = gl.getExtension('WEBGL_debug_renderer_info');
    const webgl = {
      renderer: String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER)),
      vendor: String(gl.getParameter(debug ? debug.UNMASKED_VENDOR_WEBGL : gl.VENDOR)),
      version: String(gl.getParameter(gl.VERSION)),
    };
    return { png: png.split(',')[1], withoutConesPng: withoutConesPng?.split(',')[1] ?? null,
      width: W, height: H, frame: box(0, 0, 1, 1), centre: box(1 / 3, 1 / 3, 2 / 3, 2 / 3),
      camera: g.camera.position.toArray(), cameraRotation: g.camera.rotation.toArray(), snaps: g.snaps, remote,
      blackout: g.campus.blackout, out: g.campus.out, stutter: g.campus.stutter, outRadius: g.campus.outR,
      budget: { teamSlots: g.teamLights.length, activeTeam: g.teamLights.filter((t) => t.intensity > 0).length, spotLights, wardenNightLights, pointLights },
      own: { intensity: l.intensity, angle: l.angle, penumbra: l.penumbra, decay: l.decay, distance: l.distance, pos: l.position.toArray() },
      render, webgl, coneIsolation,
    };
  }, isolateCones);
  writeFileSync(file, Buffer.from(result.png, 'base64'));
  if (result.withoutConesPng) {
    writeFileSync(file.replace('.png', '-no-cones.png'), Buffer.from(result.withoutConesPng, 'base64'));
    expect(result.coneIsolation?.restored, 'all cone visibility restored immediately after comparison').toBe(true);
    await page.locator('#e2e-shot').evaluate((img) => (img as HTMLImageElement).decode());
  }
  if (withHud) await page.screenshot({ path: file.replace('.png', '-hud.png') });
  await page.evaluate(() => document.getElementById('e2e-shot')?.remove());
  expect(result.frame.mean, 'actual WebGL frame contains the scene').toBeGreaterThan(0.5);
  expect(result.render.calls, 'complete frame draw-call budget').toBeLessThanOrEqual(150);
  expect(result.render.triangles, 'complete frame triangle budget').toBeLessThanOrEqual(150_000);
  expect(result.budget.teamSlots, 'the existing two teammate light slots are preserved').toBe(2);
  // Warden's later night-patrol rig owns a separate light, also allocated while hidden in L1.
  // Keep the original seven-light gameplay budget and verify that exact addition independently.
  expect(result.budget.wardenNightLights, 'exactly one light belongs to the night-patrol rig').toBe(1);
  expect(result.budget.spotLights - result.budget.wardenNightLights, 'the existing scene keeps seven other SpotLights').toBe(7);
  expect(result.budget.pointLights, 'no extra PointLight is introduced').toBe(0);
  if (process.platform === 'darwin') {
    expect(result.webgl.renderer, 'macOS visual evidence uses the real ANGLE Metal renderer').toMatch(/Metal/i);
  }
  const { png: _png, withoutConesPng: _withoutConesPng, ...metrics } = result;
  return metrics;
}

for (const [mode, width, height] of [['desktop', 1280, 720], ['phone', 844, 390]] as const) {
  test(`${mode}: three real clients expose a forward teammate beam and readable dark students`, async ({ browser, baseURL }, testInfo) => {
    const contexts = await Promise.all(names.map(() => browser.newContext({
      ...(mode === 'phone' ? phone : {}), baseURL, viewport: { width, height }, deviceScaleFactor: 1,
    })));
    const pages = await Promise.all(contexts.map((ctx) => ctx.newPage()));
    const [A, B, C] = pages;
    const errors: string[] = [], sockets = pages.map(() => ({ opened: 0, snaps: 0, inputs: 0 }));
    const optical: { name: string; actual: number; min: number; passed: boolean }[] = [];
    const shots: Record<string, Capture> = {};
    const perf: Record<string, PerformanceSample | PerformanceSample[] | number> = {};
    const root = join('test-results', `teamlight-${evidence}-${mode}`); mkdirSync(root, { recursive: true });
    const opticalMin = (name: string, actual: number, min: number) => {
      optical.push({ name, actual, min, passed: actual >= min });
      if (!baseline) expect.soft(actual, name).toBeGreaterThanOrEqual(min);
    };
    const snap = async (name: string, page = A, hud = false, isolateCones = false, expectedOut: 0 | 1 = 0) => {
      const shot = shots[name] = await capture(page, join(root, `${name}.png`), hud, isolateCones);
      expect(shot.out, 'the capture uses the explicitly requested real power state').toBe(expectedOut);
      expect(shot.stutter, 'no breaker flicker contaminates the torch comparison').toBe(0);
      if (expectedOut === 1) expect(shot.outRadius, 'the real outage has spread across the entire visible L1 corridor').toBeGreaterThanOrEqual(60);
      return shot;
    };
    const readRemote = (s: Capture, name: string) => { const r = s.remote.find((r) => r.name === name); expect(r, `${name} rendered`).toBeDefined(); return r!; };
    const fps = (page: Page) => page.evaluate(async () => {
      const g = window.__escape.game()!, t0 = performance.now(), s0 = g.snaps; let n = 0, active = true, maxGap = 0, last = t0;
      const tick = (t: number) => { n++; maxGap = Math.max(maxGap, t - last); last = t; if (active) requestAnimationFrame(tick); };
      requestAnimationFrame(tick); await new Promise((r) => setTimeout(r, 1000)); active = false;
      return { fps: n * 1000 / (performance.now() - t0), maxGapMs: maxGap, snaps: g.snaps - s0 };
    });
    try {
      pages.forEach((p, i) => {
        p.on('pageerror', (e) => errors.push(`${names[i]} pageerror: ${e.message}`));
        p.on('console', (msg) => { if (msg.type() === 'error') errors.push(`${names[i]} console: ${msg.text()}`); });
        p.on('crash', () => errors.push(`${names[i]} renderer crashed`));
        p.on('websocket', (ws) => {
          if (!ws.url().endsWith('/ws')) return;
          sockets[i].opened++;
          ws.on('framereceived', ({ payload }) => { const m = JSON.parse(String(payload)); if (m.t === 'snap') sockets[i].snaps++; });
          ws.on('framesent', ({ payload }) => { const m = JSON.parse(String(payload)); if (m.t === 'input') sockets[i].inputs++; });
        });
      });
      for (const [i, p] of pages.entries()) { await p.goto('/?nodraw&steady'); await p.fill('#name', names[i]); }
      await A.click('#create'); await expect(A.locator('#wait-code')).not.toBeEmpty();
      const code = await A.locator('#wait-code').innerText();
      for (const p of [B, C]) { await p.fill('#code', code); await p.click('#join'); }
      for (const p of pages) await expect(p.locator('#wait-members li')).toHaveCount(3);
      await A.click('#start');
      for (const p of pages) {
        await p.waitForFunction(() => {
          const g = window.__escape.game(); return g?.presentationReady && !g.intro.active;
        }, null, { timeout: 90_000 });
        await p.evaluate(() => { window.__escape.debug('safe', 600, 1); window.__escape.debug('safe', 600, 2); });
      }
      await expect(A.locator('#fade-overlay')).toBeHidden();
      for (const [i, p] of pages.entries()) { await place(p, AT.x - [0, 3, 5][i], AT.z); await pose(p, i ? YAW + 0.3 : YAW, false, i ? PITCH : -0.1); }
      await A.evaluate(() => {
        const g = window.__escape.game()!; g.view = { x: g.pos.x, y: g.body.y + g.eye, z: g.pos.z, yaw: Math.PI / 2, pitch: -0.1 };
      });
      for (const p of pages) await expect.poll(() => p.evaluate(() => window.__escape.game()!.remotes.size)).toBe(2);
      await remotePlacement(A, '乙', AT.x - 3, AT.z); await remotePlacement(A, '丙', AT.x - 5, AT.z);
      if (mode === 'phone') {
        const button = B.locator('.touch-btn').filter({ hasText: /^手电$/ });
        await expect(button).toBeVisible();
        for (const on of [true, false]) {
          await button.tap();
          await expect.poll(() => B.evaluate(() => window.__escape.game()!.light)).toBe(on);
          for (const observer of [A, C]) await expect.poll(() => observer.evaluate(() => {
            const g = window.__escape.game()!;
            const remote = [...g.remotes].find(([id]) => g.names.get(id) === '乙')?.[1];
            return !!(remote && (remote.f & 4));
          }), { message: 'touch F propagates through real ws to both other clients' }).toBe(on);
        }
      }
      // The real debug trip is at least 0.5 s and schedules the next random trip 80–140 s after recovery.
      // Let every client observe and recover from it before the optical samples; no shader/light state is patched.
      await A.evaluate(() => window.__escape.debug('power', 0.5));
      await Promise.all(pages.map((p) => p.waitForFunction(() => window.__escape.game()!.campus.out === 1, null, { timeout: 15_000 })));
      await Promise.all(pages.map((p) => p.waitForFunction(() => {
        const c = window.__escape.game()!.campus; return c.out === 0 && c.stutter === 0;
      }, null, { timeout: 15_000 })));
      const nodraw = await Promise.all(pages.map(fps)); perf.nodraw = nodraw;
      for (const p of nodraw) {
        expect.soft(p.fps, 'each of the three real clients keeps updating at >=15 fps').toBeGreaterThanOrEqual(15);
        expect(p.snaps, 'each real client keeps receiving authoritative snapshots').toBeGreaterThan(5);
      }
      // Review #220 and #225 use this same camera and 3 m / 5 m placement, yaw π/2 + 0.3, pitch -0.4.
      for (const [name, b, c] of [['off', false, false], ['c-on', false, true], ['both-on', true, true], ['b-on', true, false]] as const) {
        await pose(B, YAW + 0.3, b); await pose(C, YAW + 0.3, c); await settled(A, b, c);
        const s = await snap(name, A, name === 'both-on');
        if (name === 'off' || name === 'both-on') {
          await A.evaluate(() => { window.__escape.game()!.draw = true; });
          const drawn = await fps(A); perf[`drawn-${Number(b) + Number(c)}-team-lights`] = drawn;
          expect.soft(drawn.fps, 'full WebGL rendering with 0 or 2 team lights stays >=15 fps').toBeGreaterThanOrEqual(15);
          expect(drawn.snaps, 'drawing does not starve the real ws snapshots').toBeGreaterThan(5);
          await A.evaluate(() => { window.__escape.game()!.draw = false; });
        }
        expect(s.budget.teamSlots).toBe(2); expect(s.budget.activeTeam).toBe(Number(b) + Number(c));
        for (const r of s.remote.filter((r) => r.lit)) {
          expect(r.alignment, 'real light stays co-axial with the visible beam').toBeGreaterThan(0.999);
          expect(r.sourceGap, 'real light source stays on the hand beam').toBeLessThan(0.03);
        }
      }
      expect(shots['off'].budget).toEqual({ ...shots['both-on'].budget, activeTeam: 0 });
      for (const name of ['c-on', 'both-on', 'b-on']) {
        expect(shots[name].camera, 'on/off comparison keeps the exact same camera position').toEqual(shots.off.camera);
        expect(shots[name].cameraRotation, 'on/off comparison keeps the exact same camera direction').toEqual(shots.off.cameraRotation);
        opticalMin(`${name}: fixed-camera centre on/off`, shots[name].centre.mean / shots.off.centre.mean, 1.3);
      }
      const cOff = readRemote(shots.off, '丙'), cOn = readRemote(shots['c-on'], '丙');
      expect(cOn.floorPlus.inLevel, 'review #220/#225 floor sample stays inside L1').toBe(true);
      expect(cOn.floorPlus.inFrame, 'review #220/#225 whole floor sample is visible').toBe(true);
      expect(cOn.floorPlus.stats.pixels, 'the projected 3–6 m floor band is in the image').toBeGreaterThan(50);
      opticalMin('C alone: projected floor 3–6 m ahead on/off', cOn.floorPlus.stats.mean / cOff.floorPlus.stats.mean, 1.5);
      // Two independently transmitted lights overlap in the same physical corridor. Check the sampled floor
      // itself as well as the whole frame, so a small pool cannot hide behind a low global clipping fraction.
      const overlap = shots['both-on'];
      expect.soft(overlap.frame.saturated, 'two teammate lights clip less than 1% of the complete frame').toBeLessThan(0.01);
      for (const name of ['乙', '丙']) {
        const floor = readRemote(overlap, name).floorPlus;
        expect(floor.inLevel).toBe(true); expect(floor.inFrame).toBe(true);
        expect(floor.stats.pixels).toBeGreaterThan(50);
        expect.soft(floor.stats.p90, `${name}: overlapping teammate floor pool stays below white`).toBeLessThan(250);
        expect.soft(floor.stats.saturated, `${name}: overlapping teammate pool clips less than 1%`).toBeLessThan(0.01);
      }

      if (mode === 'desktop') {
        // Review #210: the same browser and three actual clients, A at 640×360, B/C 5 m / 8 m ahead.
        await A.setViewportSize({ width: 640, height: 360 });
        await place(B, AT.x - 5, AT.z); await place(C, AT.x - 8, AT.z);
        await pose(B, YAW + 0.3, false); await pose(C, YAW + 0.3, false); await settled(A, false, false);
        await remotePlacement(A, '乙', AT.x - 5, AT.z); await remotePlacement(A, '丙', AT.x - 8, AT.z);
        const off210 = await snap('review210-off', A, true);
        await pose(B, YAW + 0.3, true); await pose(C, YAW + 0.3, true); await settled(A, true, true);
        const on210 = await snap('review210-both-on', A, true);
        expect(on210.width).toBe(640); expect(on210.height).toBe(360);
        expect(on210.camera).toEqual(off210.camera); expect(on210.cameraRotation).toEqual(off210.cameraRotation);
        expect(on210.budget.teamSlots).toBe(2); expect(on210.budget.activeTeam).toBe(2);
        for (const name of ['乙', '丙']) {
          const off = readRemote(off210, name), on = readRemote(on210, name);
          expect(on.feet.inLevel, `#210 ${name}: 3 m foot region remains inside L1`).toBe(true);
          expect(on.feet.inFrame, `#210 ${name}: complete projected foot region is visible`).toBe(true);
          expect(on.feet.stats.pixels, `#210 ${name}: real floor region covers enough pixels`).toBeGreaterThan(50);
          opticalMin(`#210 ${name}: projected ground within 3 m of feet on/off`, on.feet.stats.mean / off.feet.stats.mean, 1.5);
        }
        await A.setViewportSize({ width, height });
        await place(C, AT.x - 5, AT.z); await remotePlacement(A, '丙', AT.x - 5, AT.z);
      }

      // Keep the exact #225 placement above; remove the foreground occluder only for the independent direction proof.
      await place(B, AT.x + 2, AT.z); await pose(B, YAW + 0.3, false); await pose(C, YAW + 0.3, false); await settled(A, false, false);
      await remotePlacement(A, '乙', AT.x + 2, AT.z);
      await snap('direction-off');
      await pose(C, YAW + 0.3, true); await settled(A, false, true);
      const plus = await snap('direction-plus', A, true, true);
      await pose(C, YAW - 0.3, true); await settled(A, false, true, YAW - 0.3);
      const minus = await snap('direction-minus', A, true);
      const rp = readRemote(plus, '丙'), rm = readRemote(minus, '丙');
      for (const [r, yaw] of [[rp, YAW + 0.3], [rm, YAW - 0.3]] as const) {
        const [dx, , dz] = r.direction, horizontal = Math.hypot(dx, dz);
        expect((dx * -Math.sin(yaw) + dz * -Math.cos(yaw)) / horizontal, 'beam follows remote yaw').toBeGreaterThan(0.999);
        expect(r.direction[1], 'a downward look still points below the horizon').toBeLessThan(-0.05);
        expect(r.spotVisible).toBe(true);
      }
      opticalMin('yaw ±0.3: landing pool moves in the correct screen direction (px)', rm.spotPx.x - rp.spotPx.x, 8);
      expect(plus.coneIsolation?.hiddenCones, 'the isolated frame actually hides the lit cone').toBeGreaterThan(0);
      expect(rp.air.stats.pixels, 'the airborne beam strip covers enough pixels').toBeGreaterThan(20);
      expect(rp.air.withoutCones, 'same-camera frame with only the cones hidden').not.toBeNull();
      opticalMin('airborne cone alone, with the same SpotLight and landing spot (luma)', rp.air.stats.mean - rp.air.withoutCones!.mean, 2);

      // Preserve and report the existing own-torch tuning; the release unit guard owns its historical lower bounds.
      await pose(C, YAW + 0.3, false); await settled(A, false, false);
      await pose(A, YAW, false, -0.1); const ownOff = await snap('own-off');
      await pose(A, YAW, true, -0.1); const ownOn = await snap('own-on');
      expect(ownOn.own).toEqual({ intensity: 10, angle: 0.7, penumbra: 0.8, decay: 2, distance: 30, pos: [0.15, -0.15, 0.3] });
      opticalMin('own torch still raises centre brightness', ownOn.centre.mean / ownOff.centre.mean, 1.01);
      perf.ownCentreRatio = ownOn.centre.mean / ownOff.centre.mean;

      // The historical own-torch scene has an empty corridor in front of A: both real teammates stand behind it.
      await place(B, AT.x + 2, AT.z); await place(C, AT.x + 4, AT.z);
      await remotePlacement(A, '乙', AT.x + 2, AT.z); await remotePlacement(A, '丙', AT.x + 4, AT.z);
      // Historical own-torch ratios were measured in darkness. Keep the normal-light regression above and use
      // a real server-driven 30 s outage for the historical thresholds and the following three-client body checks.
      await A.evaluate(() => window.__escape.debug('power', 30));
      await Promise.all(pages.map((p) => p.waitForFunction(() => {
        const c = window.__escape.game()!.campus; return c.out === 1 && c.stutter === 0 && c.outR >= 60;
      }, null, { timeout: 15_000 })));
      await A.evaluate(() => { window.__escape.game()!.view!.pitch = -0.05; });
      await pose(A, YAW, false, -0.05); const isolatedOwnOff = await snap('isolated-own-off', A, false, false, 1);
      await pose(A, YAW, true, -0.05); const isolatedOwnOn = await snap('isolated-own-on', A, true, false, 1);
      expect(isolatedOwnOn.camera).toEqual(isolatedOwnOff.camera); expect(isolatedOwnOn.cameraRotation).toEqual(isolatedOwnOff.cameraRotation);
      opticalMin('isolated own torch: historical centre on/off', isolatedOwnOn.centre.mean / isolatedOwnOff.centre.mean, 2);
      opticalMin('isolated own torch: historical whole-frame on/off', isolatedOwnOn.frame.mean / isolatedOwnOff.frame.mean, 1.4);
      await pose(A, YAW, false, -0.1); await place(B, AT.x - 3, AT.z);
      await place(C, AT.x - 5, AT.z);
      await remotePlacement(A, '乙', AT.x - 3, AT.z); await remotePlacement(A, '丙', AT.x - 5, AT.z);
      await A.evaluate(() => {
        const g = window.__escape.game()!; g.view = { x: g.pos.x, y: g.body.y + g.eye, z: g.pos.z, yaw: Math.PI / 2, pitch: -0.1 };
      });
      await pose(B, YAW, false, -0.1); await pose(C, -YAW, false, -0.1);
      // Continue the same real outage: student readability comes from the body, not name tags or a test light.
      const darkPages = mode === 'phone' ? pages : [A];
      for (const [i, p] of darkPages.entries()) {
        if (i === 2) {
          // A/B have already sampled the original scene. C now looks west along the corridor at B 3 m ahead;
          // the east-facing campus background by the open classrooms exceeds the separate 150-call scene budget.
          await place(B, AT.x - 8, AT.z); await pose(C, YAW, false, -0.1);
          await remotePlacement(C, '乙', AT.x - 8, AT.z);
          await expect.poll(() => C.evaluate(() => Math.abs(window.__escape.game()!.camera.rotation.y - Math.PI / 2))).toBeLessThan(0.025);
        }
        const dark = await snap(`dark-${names[i]}`, p, true, false, 1);
        expect(dark.out, 'dark readability frame captured during the real power outage').toBe(1);
        const seen = readRemote(dark, i === 1 ? '丙' : '乙');
        expect(seen.torso.inFrame, 'the complete unlit torso lies inside the actual viewport').toBe(true);
        expect(seen.torso.stats.pixels).toBeGreaterThan(40);
        opticalMin(`${names[i]}: unlit teammate torso luminance`, seen.torso.stats.mean, 8);
        opticalMin(`${names[i]}: readable torso coverage`, seen.torso.stats.visible, 0.6);
      }
      // Choose a real wall section, rather than an open classroom window, from the actual static campus boxes.
      // This sample runs after all body checks so a bad fixture cannot discard any of the three dark screenshots.
      const campusWall = await A.evaluate(() => {
        const g = window.__escape.game()!; return { boxes: g.campus.collision.boxes, eye: g.body.y + g.eye };
      });
      const staticWorld = new CollisionWorld(campusWall.boxes);
      let wallFixture: { x: number; z: number; yaw: number; direction: { x: number; y: number; z: number } } | undefined;
      for (let offset = -2; offset <= 2 && !wallFixture; offset += 0.25) for (const yaw of [0, Math.PI]) {
        const x = AT.x - 10 + offset, z = AT.z;
        const direction = { x: -Math.sin(yaw) * Math.cos(-0.1), y: Math.sin(-0.1), z: -Math.cos(yaw) * Math.cos(-0.1) };
        const hit = beamHit(staticWorld, { x, y: campusWall.eye, z }, direction, 3);
        if (hit && hit.t >= 0.8 && hit.t <= 1.6 && Math.abs(hit.nz) === 1) { wallFixture = { x, z, yaw, direction }; break; }
      }
      expect(wallFixture, 'a solid corridor wall section exists 0.8–1.6 m from a legal near-wall pose').toBeDefined();
      const wall = wallFixture!;
      await place(A, wall.x, wall.z);
      const wallOrigin = await A.evaluate(({ yaw }) => {
        const g = window.__escape.game()!;
        g.view = { x: g.pos.x, y: g.body.y + g.eye, z: g.pos.z, yaw, pitch: -0.1 };
        return { x: g.pos.x, y: g.body.y + g.eye, z: g.pos.z };
      }, wall);
      // Collision boxes exclude avatars, beam meshes and floating labels; repeat the ray from the accepted pose.
      const wallHit = beamHit(staticWorld, wallOrigin, wall.direction, 3);
      expect(wallHit, 'the accepted near-wall pose faces the physical campus wall').not.toBeNull();
      expect(Math.abs(wallHit!.nz)).toBe(1);
      expect(wallHit!.t, 'the physical wall is at least 0.8 m from the camera').toBeGreaterThanOrEqual(0.8);
      expect(wallHit!.t, 'the physical wall is at most 1.6 m from the camera').toBeLessThanOrEqual(1.6);
      perf.nearWallDistance = wallHit!.t;
      // Refresh the server-driven outage for both near-wall samples instead of racing the body checks'
      // earlier 30 s trip. Observe this new trip's omen first, so a previous outage cannot satisfy the wait.
      await A.evaluate(() => window.__escape.debug('power', 30));
      await A.waitForFunction(() => window.__escape.game()!.campus.stutter > 0, null, { timeout: 15_000 });
      await Promise.all(pages.map((p) => p.waitForFunction(() => {
        const c = window.__escape.game()!.campus; return c.out === 1 && c.stutter === 0 && c.outR >= 60;
      }, null, { timeout: 15_000 })));
      await pose(A, wall.yaw, true, -0.1); const nearOwn = await snap('isolated-own-near-wall', A, true, false, 1);
      expect.soft(nearOwn.centre.max, 'own torch facing the verified near wall stays below white').toBeLessThan(250);
      expect.soft(nearOwn.frame.saturated, 'own torch near-wall frame has less than 1% clipped pixels').toBeLessThan(0.01);
      // Keep A's accepted wall pose and camera unchanged. A real teammate stands 0.65 m behind A and
      // aims at that same solid wall; only ordinary player pose/light input reaches the remote SpotLight.
      await pose(A, wall.yaw, false, -0.1);
      const nearB = { x: wall.x + Math.sin(wall.yaw) * 0.65, z: wall.z + Math.cos(wall.yaw) * 0.65 };
      await place(B, nearB.x, nearB.z); await remotePlacement(A, '乙', nearB.x, nearB.z);
      await pose(B, wall.yaw, false, -0.1); await pose(C, wall.yaw, false, -0.1);
      // settled() also validates pitch/yaw; this fixture deliberately uses the near-wall pose instead.
      const nearSettled = async (on: boolean) => { await expect.poll(() => A.evaluate(({ yaw, on }) => {
        const g = window.__escape.game()!;
        return [...g.remotes].every(([id, r]) => {
          const lit = on && g.names.get(id) === '乙';
          return !!(r.f & 4) === lit && Math.abs(r.pitch + 0.1) < 0.02
            && Math.abs(Math.atan2(Math.sin(r.mesh.rotation.y - yaw), Math.cos(r.mesh.rotation.y - yaw))) < 0.025;
        });
      }, { yaw: wall.yaw, on }), { timeout: 15_000, message: 'near-wall teammate real snapshot settles' }).toBe(true);
        await A.waitForTimeout(450);
      };
      await nearSettled(false);
      const nearTeamOff = await snap('isolated-team-near-wall-off', A, false, false, 1);
      await pose(B, wall.yaw, true, -0.1); await nearSettled(true);
      const nearTeam = await snap('isolated-team-near-wall', A, true, false, 1);
      expect(nearTeam.camera).toEqual(nearOwn.camera); expect(nearTeam.cameraRotation).toEqual(nearOwn.cameraRotation);
      expect(nearTeam.camera).toEqual(nearTeamOff.camera); expect(nearTeam.cameraRotation).toEqual(nearTeamOff.cameraRotation);
      expect(nearTeam.budget.activeTeam).toBe(1);
      expect.soft(nearTeam.centre.mean, 'the near-wall clipping sample actually receives teammate light').toBeGreaterThan(nearTeamOff.centre.mean);
      const nearRemote = readRemote(nearTeam, '乙');
      const [ox, oy, oz] = nearRemote.origin, [dx, dy, dz] = nearRemote.direction;
      const teamWallHit = beamHit(staticWorld, { x: ox, y: oy, z: oz }, { x: dx, y: dy, z: dz }, 3);
      expect(teamWallHit, 'near teammate beam hits the physical campus wall within 3 m').not.toBeNull();
      expect(Math.abs(teamWallHit!.nz)).toBe(1);
      expect(teamWallHit!.t).toBeGreaterThanOrEqual(0.5); expect(teamWallHit!.t).toBeLessThanOrEqual(2.5);
      perf.nearTeamWallDistance = teamWallHit!.t;
      expect(nearRemote.alignment).toBeGreaterThan(0.999); expect(nearRemote.sourceGap).toBeLessThan(0.03);
      expect.soft(nearTeam.centre.p90, 'teammate torch facing the verified near wall stays below white').toBeLessThan(250);
      expect.soft(nearTeam.centre.saturated, 'teammate near-wall centre clips less than 1%').toBeLessThan(0.01);
      expect.soft(nearTeam.frame.saturated, 'teammate torch near-wall frame clips less than 1%').toBeLessThan(0.01);
      await place(A, AT.x, AT.z); await pose(A, YAW, false, -0.1);
      await A.evaluate(() => {
        const g = window.__escape.game()!; g.view = { x: g.pos.x, y: g.body.y + g.eye, z: g.pos.z, yaw: Math.PI / 2, pitch: -0.1 };
      });
      // Both drawn perf samples above use real rAF, while the other two real clients continue sending inputs/snapshots.
      for (const s of Object.values(shots)) {
        expect(s.budget.spotLights, 'fixed scene SpotLight budget').toBe(shots.off.budget.spotLights);
        expect(s.budget.pointLights, 'no extra per-student PointLight').toBe(shots.off.budget.pointLights);
      }
      for (const s of sockets) { expect(s.opened).toBe(1); expect(s.snaps).toBeGreaterThan(5); expect(s.inputs).toBeGreaterThan(5); }
      expect(errors, 'all three consoles, including WebGL shader errors').toEqual([]);
    } finally {
      const summary = { baseline, mode, viewport: { width, height }, optical, sockets, errors, perf, shots };
      const summaryPath = join(root, 'metrics.json'); writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
      console.log('TEAMLIGHT', JSON.stringify({ baseline, mode, optical, sockets, errors, perf, webgl: shots.off?.webgl }));
      await testInfo.attach(`${mode}-metrics`, { path: summaryPath, contentType: 'application/json' });
      await Promise.all(contexts.map((ctx) => ctx.close()));
    }
  });
}
