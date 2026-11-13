import { expect, test } from '@playwright/test';

test('real campus interior shaders compile with both mirror and main-scene lights', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/?nodraw&steady'); await page.fill('#name', '照明验收');
  await page.click('#create'); await page.click('#start');
  await page.waitForFunction(() => (window.__escape.game() as any)?.spawnSynced, null, { timeout: 20_000 });
  const variants = await page.evaluate(() => {
    const g = window.__escape.game()!, T = window.__escape.THREE;
    const scene = new T.Scene(), camera = new T.PerspectiveCamera(60, 1, .1, 10);
    camera.position.set(0, 0, 3);
    const ambient = new T.AmbientLight('#bed1c3', 1.2), hemi = new T.HemisphereLight();
    scene.add(ambient);
    const geometry = new T.BoxGeometry(1, 1, 1), count = geometry.getAttribute('position').count;
    geometry.setAttribute('color', new T.BufferAttribute(new Float32Array(count * 3).fill(1), 3));
    geometry.setAttribute('surf', new T.BufferAttribute(new Float32Array(count * 2), 2));
    const target = new T.WebGLRenderTarget(32, 32), previous = g.renderer.getRenderTarget(), variants: number[] = [];
    try {
      g.renderer.setRenderTarget(target);
      for (const lights of [0, 1]) {
        if (lights) scene.add(hemi);
        for (const interior of g.campus.world.interiors) {
          const mesh = new T.Mesh(geometry, interior.mesh.material);
          scene.add(mesh); g.renderer.compile(scene, camera); g.renderer.render(scene, camera); scene.remove(mesh);
        }
        variants.push(lights);
      }
    } finally { g.renderer.setRenderTarget(previous); geometry.dispose(); target.dispose(); }
    return variants;
  });
  expect(variants).toEqual([0, 1]);
  expect(errors, 'mirror scene must compile real interior materials without HemisphereLight declarations').toEqual([]);
});
