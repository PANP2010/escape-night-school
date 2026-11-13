import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { frame } from './draw.ts';

// Real built client/server, low preset. Evidence labels never bypass optical assertions.
const evidence = process.env.OWN_TORCH_EVIDENCE ?? 'final';
const root = `test-results/own-torch-glare-${evidence}`;
const wallZ = 70.6, eyeY = 1.7; // A.s1 lectern's pale front wall, beside (not on) the blackboard

async function pose(page: Page, x: number, z: number, yaw: number, light: boolean, pitch = 0) {
  await page.evaluate(({ x, z, yaw, pitch, light }) => {
    const g = window.__escape.game()!;
    g.view = { x, y: 1.7, z, yaw, pitch }; g.light = light;
  }, { x, z, yaw, pitch, light });
  await page.waitForFunction(({ x, z, yaw, pitch }) => {
    const g = window.__escape.game()!;
    return Math.hypot(g.camera.position.x - x, g.camera.position.z - z) < 0.001
      && Math.abs(g.camera.position.y - 1.7) < 0.001 && Math.abs(g.camera.rotation.y - yaw) < 0.001
      && Math.abs(g.camera.rotation.x - pitch) < 0.001;
  }, { x, z, yaw, pitch });
}

// The real server may trip the breaker between browser tasks. Render both optical states in one task,
// changing only the own SpotLight visibility so the environment, uniforms and camera match exactly.
async function capturePair(page: Page, name: string, plane: number | null, endWall = false) {
  await frame(page, 1);
  const pair = await page.evaluate(({ plane, endWall }) => {
    const g = window.__escape.game()!, T = window.__escape.THREE;
    const v = g.view;
    if (!v || Math.hypot(g.camera.position.x - v.x, g.camera.position.y - v.y, g.camera.position.z - v.z) > 0.001
      || Math.abs(g.camera.rotation.x - v.pitch) > 0.001 || Math.abs(g.camera.rotation.y - v.yaw) > 0.001)
      throw new Error('another camera owner displaced the fixed optical fixture');
    const cv = document.createElement('canvas'); cv.width = innerWidth; cv.height = innerHeight;
    const ctx = cv.getContext('2d', { willReadFrequently: true })!;
    const W = cv.width, H = cv.height;
    let data: Uint8ClampedArray;
    const project = (x: number, y: number, z: number) => {
      const p = new T.Vector3(x, y, z).project(g.camera);
      return { x: (p.x + 1) * W / 2, y: (1 - p.y) * H / 2 };
    };
    const polygon = (points: { x: number; y: number }[]) => {
      const values: number[] = [], mask = new Uint8Array(W * H);
      let white = 0, visible = 0;
      const x0 = Math.max(0, Math.floor(Math.min(...points.map(p => p.x))));
      const x1 = Math.min(W, Math.ceil(Math.max(...points.map(p => p.x))));
      const y0 = Math.max(0, Math.floor(Math.min(...points.map(p => p.y))));
      const y1 = Math.min(H, Math.ceil(Math.max(...points.map(p => p.y))));
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        let inside = false;
        for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
          const a = points[i], b = points[j];
          if ((a.y > y + 0.5) !== (b.y > y + 0.5) && x + 0.5 < (b.x - a.x) * (y + 0.5 - a.y) / (b.y - a.y) + a.x) inside = !inside;
        }
        if (!inside) continue;
        const i = (y * W + x) * 4, luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        values.push(luma); if (luma >= 8) visible++;
        if (Math.min(data[i], data[i + 1], data[i + 2]) >= 250) { white++; mask[y * W + x] = 1; }
      }
      // Largest 4-connected white component: a small bright pixel cannot excuse a broad clipped patch.
      let largestWhite = 0;
      const queue = new Int32Array(W * H);
      for (let i = 0; i < mask.length; i++) if (mask[i]) {
        let head = 0, tail = 1; queue[0] = i; mask[i] = 0;
        while (head < tail) {
          const at = queue[head++], x = at % W;
          for (const next of [x ? at - 1 : -1, x + 1 < W ? at + 1 : -1, at - W, at + W]) {
            if (next >= 0 && next < mask.length && mask[next]) { mask[next] = 0; queue[tail++] = next; }
          }
        }
        largestWhite = Math.max(largestWhite, tail);
      }
      values.sort((a, b) => a - b);
      return { pixels: values.length, mean: values.reduce((s, v) => s + v, 0) / values.length,
        p10: values[Math.floor(values.length * 0.1)], p90: values[Math.floor(values.length * 0.9)],
        white: white / values.length, largestWhite: largestWhite / values.length, visible: visible / values.length };
    };
    const render = (on: boolean) => {
      g.flashlight.visible = on;
      g.renderer.render(g.scene, g.camera);
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(g.renderer.domElement, 0, 0, W, H);
      data = ctx.getImageData(0, 0, W, H).data;
      const wall = plane === null ? null : endWall ? polygon([
        project(plane, 2.25, 73.05), project(plane, 2.25, 73.65),
        project(plane, 2.7, 73.65), project(plane, 2.7, 73.05),
      ]) : polygon([
        project(plane, 1.36, 69.95), project(plane, 1.36, 71.85),
        project(plane, 2.75, 71.85), project(plane, 2.75, 69.95),
      ]);
      // Actual floor bands 5–7 m and 8–10 m ahead, neither HUD nor whole-frame averages.
      const floor = (near: number, far: number) => polygon([
        project(-41.285 - near, 0.03, 72.95), project(-41.285 - far, 0.03, 72.95),
        project(-41.285 - far, 0.03, 73.8), project(-41.285 - near, 0.03, 73.8),
      ]);
      const gl = g.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
      return { png: cv.toDataURL(), wall, far5: plane === null ? floor(5, 7) : null, far8: plane === null ? floor(8, 10) : null,
        renderer: ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '',
        toneMapping: g.renderer.toneMapping, light: g.flashlight.intensity, on, lightVisible: g.flashlight.visible,
        power: { blackout: g.campus.blackout, stutter: g.campus.stutter, outRadius: g.campus.outR }, out: g.campus.out,
        camera: g.camera.position.toArray(), rotation: g.camera.rotation.toArray(),
        width: g.renderer.domElement.width, height: g.renderer.domElement.height };
    };
    const visible = g.flashlight.visible;
    try { return { off: render(false), on: render(true) }; }
    finally { g.flashlight.visible = visible; }
  }, { plane, endWall });
  const save = (sample: typeof pair.off, state: 'off' | 'on') => {
    writeFileSync(`${root}/${name}-${state}.png`, Buffer.from(sample.png.split(',')[1], 'base64'));
    const { png: _png, ...stats } = sample;
    writeFileSync(`${root}/${name}-${state}.json`, JSON.stringify(stats, null, 2));
    return stats;
  };
  const off = save(pair.off, 'off'), on = save(pair.on, 'on');
  await page.evaluate(() => document.getElementById('e2e-shot')?.remove());
  expect(on.camera, 'paired renders keep the exact camera').toEqual(off.camera);
  expect(on.rotation).toEqual(off.rotation);
  expect(on.power, 'paired renders keep the exact power state').toEqual(off.power);
  expect(on.out).toBe(off.out);
  expect(off.lightVisible).toBe(false); expect(on.lightVisible).toBe(true);
  return { off, on };
}

for (const viewport of [{ width: 1280, height: 720 }, { width: 844, height: 390 }]) {
  test(`own torch retains near-wall detail and distant reach at low ${viewport.width}`, async ({ browser, baseURL }) => {
    test.setTimeout(180_000);
    mkdirSync(root, { recursive: true });
    const context = await browser.newContext({ baseURL, viewport, deviceScaleFactor: 1 });
    await context.addInitScript(() => localStorage.setItem('escape.settings', JSON.stringify({ pixelRatio: 1, postprocessing: false })));
    const page = await context.newPage(), errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    try {
      await page.goto('/?nodraw&steady');
      await page.locator('#name').fill('近墙验收');
      await page.locator('#create').click(); await page.locator('#start').click();
      await page.waitForFunction(() => (window.__escape.game() as unknown as { spawnSynced: boolean })?.spawnSynced);
      await page.evaluate(() => window.__escape.debug('safe', 600));
      // Read geometry before the first render: the static mesh releases CPU attributes after GPU upload.
      const { plane, endPlane } = await page.evaluate(({ wallZ, eyeY }) => {
        const g = window.__escape.game()!, T = window.__escape.THREE;
        const interior = g.campus.world.interiors.find(i => i.b.id === 'A')!.mesh;
        interior.updateWorldMatrix(true, false);
        const ray = new T.Raycaster(new T.Vector3(-47.5, eyeY, wallZ), new T.Vector3(1, 0, 0), 0, 5);
        const hit = ray.intersectObject(interior)[0];
        if (!hit || hit.face?.normal.x !== -1) throw new Error('fixture must hit the lectern classroom front wall');
        const endRay = new T.Raycaster(new T.Vector3(-41.285, 2.4, 73.36), new T.Vector3(-1, 0, 0), 0, 20);
        const endHit = endRay.intersectObject(interior)[0];
        if (!endHit || endHit.face?.normal.x !== 1) throw new Error('corridor end wall fixture missing');
        const verify = (plane: number, zs: number[], ys: number[], distances: number[], sign: number) => {
          for (const distance of distances) for (const z of zs) for (const y of ys) {
            const origin = new T.Vector3(plane + sign * distance, eyeY, wallZ);
            const direction = new T.Vector3(plane, y, z).sub(origin).normalize();
            const h = new T.Raycaster(origin, direction, 0, 15).intersectObject(interior)[0];
            if (!h || Math.abs(h.point.x - plane) > 0.001 || h.face?.normal.x !== sign)
              throw new Error('projected ROI must first hit the same physical wall');
          }
        };
        verify(hit.point.x, [69.95, 71.85], [1.36, 2.75], [0.8, 1.1, 3], -1);
        // Use the corridor's own z for its independent wall patch, not the classroom centre.
        for (const distance of [5, 10]) for (const z of [73.05, 73.65]) for (const y of [2.25, 2.7]) {
          const origin = new T.Vector3(endHit.point.x + distance, eyeY, 73.36);
          const direction = new T.Vector3(endHit.point.x, y, z).sub(origin).normalize();
          const h = new T.Raycaster(origin, direction, 0, 15).intersectObject(interior)[0];
          if (!h || Math.abs(h.point.x - endHit.point.x) > 0.001 || h.face?.normal.x !== 1)
            throw new Error('far ROI must first hit the corridor end wall');
        }
        return { plane: hit.point.x, endPlane: endHit.point.x };
      }, { wallZ, eyeY });
      expect(plane).toBeCloseTo(-44.15, 3); // inward face of the 0.2 m partition
      await page.waitForFunction(() => {
        const g = window.__escape.game()!; return g.presentationReady && !g.intro.active;
      }, null, { timeout: 30_000 });
      await page.keyboard.press('Shift');
      await page.waitForFunction(() => window.__escape.game()!.openingComplete);
      for (const distance of [0.8, 1.1, 3]) {
        await pose(page, plane - distance, wallZ, -Math.PI / 2, true);
        const { off, on } = await capturePair(page, `${viewport.width}-wall-${distance}`, plane);
        console.log(JSON.stringify({ viewport, distance, off, on }));
        expect(on.toneMapping, 'low uses no tone mapping').toBe(0);
        expect(on.width).toBe(viewport.width); expect(on.height).toBe(viewport.height);
        if (process.env.ESC_GPU === '1') {
          expect(on.renderer).toMatch(/NVIDIA/i); expect(on.renderer).not.toMatch(/SwiftShader|llvmpipe/i);
        }
        expect(on.wall!.pixels).toBeGreaterThan(1500);
        expect.soft(on.wall!.white, `${distance}m clipped wall area`).toBeLessThan(0.005);
        expect.soft(on.wall!.largestWhite, `${distance}m contiguous white patch`).toBeLessThan(0.001);
        expect.soft(on.wall!.p90 - on.wall!.p10, `${distance}m wall retains a light gradient`).toBeGreaterThan(12);
        expect.soft(on.wall!.mean - off.wall!.mean, `${distance}m torch remains visible`).toBeGreaterThan(8);
      }
      await pose(page, -41.285, 73.36, Math.PI / 2, true, -0.12);
      const { off, on } = await capturePair(page, `${viewport.width}-corridor`, null);
      console.log(JSON.stringify({ viewport, corridor: { off, on } }));
      for (const band of ['far5', 'far8'] as const) {
        expect(on[band]!.pixels).toBeGreaterThan(80);
        expect.soft(on[band]!.visible, `${band} floor remains readable`).toBeGreaterThan(0.9);
      }
      // A perpendicular patch above the real corridor end doorway measures distant beam strength without
      // the floor's grazing incidence. Keep the same >5 luma on/off requirement at both distances.
      for (const distance of [5, 10]) {
        const pitch = Math.atan2(0.7, distance);
        await pose(page, endPlane + distance, 73.36, Math.PI / 2, true, pitch);
        const { off: farOff, on: farOn } = await capturePair(page, `${viewport.width}-end-${distance}`, endPlane, true);
        console.log(JSON.stringify({ viewport, distance, farOff, farOn }));
        expect(farOn.wall!.pixels).toBeGreaterThan(100);
        expect.soft(farOn.wall!.visible).toBeGreaterThan(0.9);
        expect.soft(farOn.wall!.mean - farOff.wall!.mean, `${distance}m end wall light on/off difference`).toBeGreaterThan(5);
      }
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });
}
