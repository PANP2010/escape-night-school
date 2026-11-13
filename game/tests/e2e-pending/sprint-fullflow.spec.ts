import { expect, test } from '@playwright/test';
import { Flow } from '../fullflow/harness.ts';
import { firstChapter, secondChapter, thirdChapter, fourthChapter } from '../fullflow/chapters.ts';
import { futureChapters } from '../fullflow/future.ts';

const chapters = Number(process.env.ESC_FULLFLOW_CHAPTERS ?? 8);
if (![4, 8].includes(chapters)) throw new Error('ESC_FULLFLOW_CHAPTERS must be 4 or 8');
for (const mode of ['desktop', 'mobile'] as const) {
  test(`${mode}: L1→L${chapters} authoritative puzzle campaign (${process.env.ESC_FULLFLOW_NATURAL === '1' ? 'natural threats' : 'NPC damage isolated; directed monster checks'})`, async ({ browser, baseURL }, info) => {
    const context = await browser.newContext({ baseURL, viewport: mode === 'mobile' ? { width: 844, height: 390 } : { width: 1280, height: 720 },
      deviceScaleFactor: 1, isMobile: mode === 'mobile', hasTouch: mode === 'mobile' });
    const page = await context.newPage(), f = new Flow(page, info, mode);
    try {
      await page.goto('/?nodraw&steady'); await page.fill('#name', `验收${mode === 'mobile' ? '手机' : '桌面'}`);
      await page.click('#create'); await expect(page.locator('#wait-code')).toHaveText(/^[A-HJ-NP-Z2-9]{4}$/);
      await page.click('#start'); await f.ready(0);
      const renderer = await page.evaluate(() => {
        const gl = window.__escape.game()!.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
        return String(gl.getParameter(ext?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER));
      });
      expect(renderer, 'this sprint requires real Apple Metal; a software run cannot count').toMatch(/Apple|Metal/i);
      expect(renderer).not.toMatch(/SwiftShader|llvmpipe/i); f.note('renderer', renderer);
      await firstChapter(f); await f.exit(0, false);
      await secondChapter(f); await f.exit(1, false);
      await thirdChapter(f); await f.exit(2, false);
      await fourthChapter(f); await f.exit(3, chapters === 4 ? 'prefix' : false);
      if (chapters === 8) await futureChapters(f);
      else {
        // Current-content completion is deliberately distinct from the requested eight-chapter statistics screen.
        expect(f.latest('completed'), 'a four-chapter prefix cannot claim the eight-chapter final statistics').toBeUndefined();
        if (f.latest('complete')?.level === 3) {
          await expect(page.locator('#fade-overlay.complete')).toContainText('当前 4 个关卡已完成');
          await f.photo('l4-current-content-completion');
          f.note('four-chapter-result', 'current four-chapter content completed');
        } else {
          expect(f.latest('room')?.level).toBe(4);
          expect((await f.state()).level).toBe(4);
          await f.photo('l4-passed-l5-ready');
          f.note('four-chapter-result', 'L1–L4 cleared; L5 ready in the same room; eight-chapter ending not tested');
        }
      }
      expect(f.sent.filter(m => m.t === 'debug' && !['safe', 'monitor'].includes(m.op)), 'no key/tp/level jump may substitute for a cleared chapter').toEqual([]);
      f.assertTransport();
      expect(f.errors).toEqual([]); f.note('campaign-finished', { chapters });
    } finally { await f.save(); await context.close(); }
  });
}
