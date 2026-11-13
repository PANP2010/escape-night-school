import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { ClientMsg, ServerMsg } from '../../shared/protocol.ts';
import { clickCanvas, shot } from './draw.ts';

async function aimAtCabinet(page: Page, offset = 0) {
  await page.evaluate((offset) => {
    const g = window.__escape.game() as any;
    const box = g.blackoutObjs.find((o: any) => o.userData.touchFuse);
    const dx = box.position.x - g.camera.position.x, dz = box.position.z - g.camera.position.z;
    g.input.yaw = Math.atan2(-dx, -dz);
    g.input.pitch = Math.atan2(box.position.y + offset - g.camera.position.y, Math.hypot(dx, dz));
  }, offset);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

for (const touch of [false, true]) {
  test.describe(touch ? 'phone' : 'desktop', () => {
    test.use({ viewport: touch ? { width: 844, height: 390 } : { width: 640, height: 400 }, hasTouch: touch, isMobile: touch });
    test('fuse box: aim at the rendered cabinet, follow its marker and insert through real input', async ({ page }) => {
      test.setTimeout(70_000);
      const errors: string[] = [], sent: ClientMsg[] = [], received: ServerMsg[] = [];
      const device = touch ? 'phone' : 'desktop';
      const evidence: Record<string, unknown> = { device };
      mkdirSync('test-results/fuse-box', { recursive: true });
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('websocket', (ws) => {
        ws.on('framesent', ({ payload }) => sent.push(JSON.parse(String(payload)) as ClientMsg));
        ws.on('framereceived', ({ payload }) => received.push(JSON.parse(String(payload)) as ServerMsg));
      });
      try {
        await page.goto('/?nodraw&steady');
        await page.fill('#name', '配电箱检查');
        await page.click('#create'); await page.click('#start');
        await page.waitForFunction(() => {
          const g = window.__escape.game(); return g?.presentationReady && !g.intro.active;
        });
        await page.evaluate(() => window.__escape.debug('level', 1));
        await page.waitForFunction(() => {
          const g = window.__escape.game(); return g?.level.index === 1 && g.presentationReady && !g.intro.active;
        });
        await page.evaluate(async () => {
          if (document.fullscreenElement) await document.exitFullscreen();
          window.__escape.debug('safe', 600);
          window.__escape.debug('key', -2);
          window.__escape.debug('tp', 40, 84.3);
        });
        await expect(page.locator('#objective .g')).toContainText('把保险丝插进');
        await expect.poll(() => page.evaluate(() => {
          const g = window.__escape.game()!; return Math.hypot(g.pos.x - 40, g.pos.z - 84.3);
        })).toBeLessThan(.15);
        // A forced spawn updates authority before the camera's reveal frame. Aim from the view actually shown.
        await expect.poll(() => page.evaluate(() => {
          const g = window.__escape.game()!; return Math.hypot(g.camera.position.x - 40, g.camera.position.z - 84.3);
        })).toBeLessThan(.15);
        if (!touch) await clickCanvas(page);

        // The regression aims at the real mesh, not the old floor-level target. Both its centre and
        // the upper part of its door must offer the same keyboard/auxiliary-button interaction.
        for (const offset of [0, .32]) {
          await aimAtCabinet(page, offset);
          await expect(page.locator('#prompt')).toHaveText(touch ? '点配电箱 · 插入保险丝' : 'E 插入保险丝');
        }
        await aimAtCabinet(page);
        await expect(page.locator('#goal-arrow')).toHaveClass(/\bon\b/);
        await expect.poll(() => page.evaluate(() => {
          const g = window.__escape.game() as any, arrow = document.getElementById('goal-arrow')!;
          const box = g.blackoutObjs.find((o: any) => o.userData.touchFuse);
          const p = box.position.clone().project(g.camera), r = arrow.getBoundingClientRect();
          return Math.hypot(r.left - (p.x + 1) * innerWidth / 2, r.top - (1 - p.y) * innerHeight / 2);
        })).toBeLessThan(3);
        evidence.before = await page.evaluate(() => {
          const g = window.__escape.game() as any, box = g.blackoutObjs.find((o: any) => o.userData.touchFuse);
          return { p: [g.pos.x, g.body.y, g.pos.z], cabinet: box.position.toArray(),
            waypoint: { ...g.guide }, target: g.target(), prompt: document.getElementById('prompt')!.textContent };
        });
        await shot(page, `test-results/fuse-box/${device}-cabinet-aim.png`);
        if (touch) {
          // Tap the actual panel while it is off the crosshair: direct world touch must share its reach.
          await page.evaluate(() => { window.__escape.game()!.input.yaw += .22; });
          await page.waitForTimeout(150);
          const p = await page.evaluate(() => {
            const g = window.__escape.game() as any;
            const v = g.blackoutObjs.find((o: any) => o.userData.touchFuse).position.clone().project(g.camera);
            return { x: (v.x + 1) * innerWidth / 2, y: (1 - v.y) * innerHeight / 2 };
          });
          await page.touchscreen.tap(p.x, p.y);
          evidence.tap = p;
        } else await page.keyboard.press('KeyE');
        await expect.poll(() => received.filter((m) => m.t === 'power').at(-1)).toMatchObject({ t: 'power', n: 1 });
        await expect(page.locator('#objective .g')).toContainText('1/3');
        expect(sent.filter((m) => m.t === 'act')).toEqual([{ t: 'act', kind: 'fuse', id: 0 }]);
        expect(errors).toEqual([]);
      } finally {
        evidence.final = await page.evaluate(() => {
          const g = window.__escape.game() as any;
          return g && { p: [g.pos.x, g.body.y, g.pos.z], camera: g.camera.position.toArray(),
            look: [g.input.yaw, g.input.pitch], bag: g.bag, target: g.target(), intro: g.intro.active };
        }).catch(() => null);
        writeFileSync(`test-results/fuse-box/${device}.json`, JSON.stringify({ ...evidence, errors,
          acts: sent.filter((m) => m.t === 'act'), power: received.filter((m) => m.t === 'power') }, null, 2));
      }
    });
  });
}
