import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { gateStorageState } from '../gate-settings.ts';
import { frame } from './draw.ts';
import type { ServerMsg, Vec3 } from '../../shared/protocol.ts';

test('two clients keep the server handoff while chapters and audio settle at the new spawn', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ baseURL, viewport: { width: 844, height: 390 } });
  const peer = await browser.newContext({ baseURL, viewport: { width: 844, height: 390 } });
  const a = await context.newPage(), b = await peer.newPage();
  const errors: string[] = [];
  const fades: unknown[] = [];
  let selfId = 0, authoritativePosition: Vec3 | undefined;
  for (const p of [a, b]) p.on('pageerror', (e) => errors.push(e.message));
  a.on('websocket', (ws) => ws.on('framereceived', ({ payload }) => {
    const m = JSON.parse(String(payload)) as ServerMsg;
    if (m.t === 'fade') fades.push(m);
    if (m.t === 'welcome') selfId = m.id;
    if (m.t === 'snap') authoritativePosition = m.players.find(p => p.id === selfId)?.p;
  }));
  const ready = async (p: Page, index: number) => {
    await p.waitForFunction((index) => {
      const g = window.__escape.game(); return g?.level.index === index && g.presentationReady && !g.intro.active;
    }, index);
    await expect(p.locator('#fade-overlay')).toBeHidden();
    await p.evaluate(() => { window.__escape.debug('safe', 600, 1); window.__escape.debug('safe', 600, 2); });
  };
  const audio = (p: Page) => p.evaluate(() => window.__escape.game()!.sound.diagnostics);
  try {
    await a.goto('/?nodraw&steady'); await a.fill('#name', '过场甲'); await a.click('#create');
    await expect(a.locator('#wait-code')).not.toBeEmpty();
    await b.goto('/?nodraw&steady'); await b.fill('#name', '过场乙');
    await b.fill('#code', await a.locator('#wait-code').innerText()); await b.click('#join');
    await expect(a.locator('#wait-members li')).toHaveCount(2); await a.click('#start');
    for (const p of [a, b]) {
      await ready(p, 0); await p.keyboard.press('KeyF');
      await expect.poll(async () => (await audio(p)).ambientSources).toBe(5);
      await p.evaluate(() => { window.__escape.debug('key', -1); window.__escape.debug('tp', -61, 66); });
    }
    await expect(a.locator('#fade-overlay')).toBeVisible();
    await expect(a.locator('#fade-overlay')).toContainText('第 1 关 通过');
    await expect(a.locator('#fade-overlay')).toContainText(/用时 \d+:\d{2}/);
    await a.waitForTimeout(220);
    await expect(b.locator('#fade-overlay')).toContainText('第 1 关 通过');
    await expect(b.locator('#fade-overlay')).toContainText(/用时 \d+:\d{2}/);
    await a.screenshot({ path: 'test-results/audio-handoff-l1-l2.png' });
    for (const p of [a, b]) {
      await ready(p, 1);
      await expect.poll(async () => (await audio(p)).ambientSources).toBe(5);
      expect((await audio(p)).activeSources).toBeLessThanOrEqual(7);
    }
    await a.evaluate(() => { window.__escape.debug('key', -2); window.__escape.debug('tp', 40, 85); });
    await expect.poll(() => authoritativePosition ? Math.hypot(authoritativePosition[0] - 40,
      authoritativePosition[1] - 3.6, authoritativePosition[2] - 85) : Infinity).toBeLessThan(.08);
    await expect.poll(() => a.evaluate(() => (window.__escape.game() as any).bag.fuse)).toBe(3);
    for (let i = 1; i <= 3; i++) {
      await a.evaluate(() => window.__escape.net.send({ t: 'act', kind: 'fuse', id: 0 }));
      await expect.poll(() => a.evaluate(() => (window.__escape.game() as any).fusesIn)).toBe(i);
    }
    await expect(a.locator('#objective .g')).toContainText('集合');
    for (const p of [a, b]) await p.evaluate(() => window.__escape.debug('tp', 15.5, 84.2));
    await expect(a.locator('#fade-overlay')).toBeVisible();
    await expect(a.locator('#fade-overlay')).toContainText('第 2 关 通过');
    await expect(a.locator('#fade-overlay')).toContainText(/用时 \d+:\d{2}/);
    await a.waitForTimeout(220);
    await a.screenshot({ path: 'test-results/audio-handoff-l2-l3.png' });
    for (const p of [a, b]) {
      await ready(p, 2);
      await expect.poll(async () => (await audio(p)).ambientSources).toBe(5);
      const old = await p.evaluate(() => window.__escape.game()!.light);
      await p.keyboard.press('KeyF');
      await expect.poll(() => p.evaluate(() => window.__escape.game()!.light)).toBe(!old);
      expect((await audio(p)).activeSources).toBeLessThanOrEqual(8);
      expect(await p.locator('body').getAttribute('class')).not.toContain('level-handoff');
    }
    expect(fades).toEqual([{ t: 'fade', secs: 3, restart: false }, { t: 'fade', secs: 3, restart: false }]);
    expect(errors).toEqual([]);
  } finally { await context.close(); await peer.close(); }
});


// Observe layout before every paint, including the short arrive()/intro overlap and reveal cleanup.
async function watchTitles(page: Page) {
  await page.evaluate(() => {
    const frames: any[] = [];
    (window as any).__handoffFrames = frames;
    const text = (selector: string) => {
      const el = document.querySelector<HTMLElement>(selector);
      if (!el) return { text: '', painted: false, rects: [] };
      const range = document.createRange(); range.selectNodeContents(el);
      const rects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0)
        .map(r => ({ x: r.x, y: r.y, right: r.right, bottom: r.bottom }));
      return { text: el.textContent, painted: el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }), rects };
    };
    const sample = () => {
      const g = window.__escape.game(), fade = document.getElementById('fade-overlay')!;
      if (g) frames.push({ at: performance.now(), id: g.intro.id, active: g.intro.active,
        handoffOpen: !fade.hidden, revealing: fade.classList.contains('revealing'),
        enabled: g.input.enabled, player: [g.pos.x, g.body.y, g.pos.z], light: g.light,
        veil: Number(document.querySelector<HTMLElement>('.intro-veil')?.style.opacity),
        title: text('#intro-title'), goal: text('#intro-objective'),
        old: ['.handoff-kicker', '#transition-title', '#transition-detail'].map(text) });
      if (frames.length < 6_000) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

for (const viewport of [{ width: 1280, height: 720 }, { width: 844, height: 390 }]) {
  test(`intro titles exclude old handoff text through retry and clear at ${viewport.width}x${viewport.height}`, async ({ browser, baseURL }) => {
    test.setTimeout(120_000);
    const label = viewport.width === 1280 ? 'desktop' : 'mobile';
    const evidence = `test-results/iter-58-${process.env.HANDOFF_EVIDENCE ?? 'final'}-${label}`;
    const options = { baseURL, viewport, hasTouch: label === 'mobile', storageState: gateStorageState(baseURL!),
      reducedMotion: 'no-preference' as const };
    const ca = await browser.newContext({ ...options, recordVideo: { dir: 'test-results/handoff-video', size: viewport } });
    const cb = await browser.newContext(options);
    const a = await ca.newPage(), b = await cb.newPage(), pages = [a, b];
    const video = a.video();
    const wire: { at: number; message: ServerMsg }[] = [], errors: string[] = [];
    for (const p of pages) p.on('pageerror', e => errors.push(e.message));
    a.on('websocket', ws => ws.on('framereceived', ({ payload }) => {
      wire.push({ at: Date.now(), message: JSON.parse(String(payload)) as ServerMsg });
    }));
    const ready = async (index: number) => {
      for (const p of pages) {
        await p.waitForFunction(index => {
          const g = window.__escape.game(); return g?.level.index === index && g.presentationReady && !g.intro.active;
        }, index);
        await p.evaluate(() => { window.__escape.debug('safe', 600, 1); window.__escape.debug('safe', 600, 2); });
      }
    };
    const frames = (p: Page) => p.evaluate(() => (window as any).__handoffFrames as any[]);
    const newIntro = (p: Page, previous: number) => p.waitForFunction(previous => {
      const g = window.__escape.game();
      return g && g.intro.id > previous && g.intro.active;
    }, previous, { polling: 'raf', timeout: 10_000 });
    const capture = async (kind: string) => {
      // The RAF audit captures the short overlap even if the screenshot completes after cleanup.
      await a.screenshot({ path: `${evidence}-${kind}.png` });
    };
    const assertEpoch = async (id: number, index: number, revealing = false) => {
      for (const p of pages) {
        const epoch = (await frames(p)).filter(f => f.id === id);
        if (index === 0) expect(epoch.some(f => f.active && f.handoffOpen), 'sample both logically active layers on retry').toBe(true);
        const readable = epoch.filter(f => f.active && (index > 0 || f.handoffOpen) && f.title.painted && f.goal.painted);
        if (!revealing) expect(readable.length, 'sample readable intro in the retry overlap or the next chapter').toBeGreaterThan(0);
        for (const f of epoch) {
          expect(f.old.filter((t: any) => t.painted), `old text painted at ${f.at}`).toEqual([]);
          if (f.active) expect(f.enabled).toBe(false);
        }
        for (const f of readable) {
          expect(f.title.text).toContain(`第 ${index + 1} 关`);
          expect(f.goal.text).not.toBe('');
          expect(f.title.rects.length).toBeGreaterThan(0); expect(f.goal.rects.length).toBeGreaterThan(0);
          for (const r of [...f.title.rects, ...f.goal.rects]) {
            expect(r.x).toBeGreaterThanOrEqual(0); expect(r.right).toBeLessThanOrEqual(viewport.width);
            expect(r.y).toBeGreaterThanOrEqual(0); expect(r.bottom).toBeLessThanOrEqual(viewport.height);
          }
          expect(Math.min(...f.goal.rects.map((r: any) => r.y)) - Math.max(...f.title.rects.map((r: any) => r.bottom))).toBeGreaterThanOrEqual(4);
        }
        if (revealing) expect(epoch.some(f => !f.active && f.handoffOpen && f.revealing), 'cover pre-fallback spawned/reveal cleanup').toBe(true);
        expect(epoch.some(f => !f.active), 'observe intro end and subsequent cleanup').toBe(true);
        expect(epoch.at(-1)!.at - epoch.find(f => !f.active)!.at).toBeGreaterThanOrEqual(400);
      }
    };
    let retryId = 0;
    try {
      await a.goto(process.env.ESC_GPU === '1' ? '/?steady' : '/?nodraw&steady'); await a.fill('#name', '重试甲'); await a.click('#create');
      await expect(a.locator('#wait-code')).not.toBeEmpty();
      await b.goto('/?nodraw&steady'); await b.fill('#name', '重试乙');
      await b.fill('#code', await a.locator('#wait-code').innerText()); await b.click('#join');
      await expect(a.locator('#wait-members li')).toHaveCount(2); await a.click('#start');
      await ready(0);
      if (process.env.ESC_GPU !== '1') await frame(a, 1);
      for (const p of pages) await watchTitles(p);
      const original = await a.evaluate(() => { const g = window.__escape.game()!; return { id: g.intro.id, seed: g.level.seed }; });
      // Real server all-down flow, not a synthetic room/intro message.
      await Promise.all(pages.map(p => p.evaluate(() => window.__escape.debug('down', 30))));
      await expect(a.locator('#fade-overlay')).toContainText('全员出局');
      await Promise.all(pages.map(p => newIntro(p, original.id)));
      retryId = await a.evaluate(() => window.__escape.game()!.intro.id);
      await capture('retry');
      await ready(0); await a.waitForTimeout(500);
      expect(await a.evaluate(() => window.__escape.game()!.level.seed)).toBe(original.seed);
      await assertEpoch(retryId, 0);
      // Arm real skip-button handlers before arrival: software rendering can leave <280ms
      // before the fallback finishes, too little for a screenshot or several CDP round trips.
      for (const [i, p] of pages.entries()) await p.evaluate(({ previous, second }) => {
        const vote = () => {
          const g = window.__escape.game()!, intro = g.intro as any;
          if (!intro.active || intro.id <= previous || second && intro.event.skipped.length !== 1) {
            requestAnimationFrame(vote); return;
          }
          const before = { p: [g.pos.x, g.body.y, g.pos.z], light: g.light };
          document.getElementById('intro-skip')!.click();
          window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF', bubbles: true }));
          window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyF', bubbles: true }));
          (window as any).__skipVote = { id: intro.id, active: intro.active, skipped: intro.skipped,
            enabled: g.input.enabled, waiting: !document.getElementById('intro-wait')!.hidden,
            before, after: { p: [g.pos.x, g.body.y, g.pos.z], light: g.light } };
        };
        requestAnimationFrame(vote);
      }, { previous: retryId, second: i === 1 });
      await Promise.all(pages.map(p => p.evaluate(() => window.__escape.debug('down', 30))));
      await a.waitForFunction(previous => window.__escape.game()!.intro.id > previous && !!(window as any).__skipVote, retryId);
      const skippedId = await a.evaluate(() => window.__escape.game()!.intro.id);
      await ready(0); await a.waitForTimeout(600);
      await assertEpoch(skippedId, 0, true);
      const vote = await a.evaluate(() => (window as any).__skipVote);
      expect(vote).toMatchObject({ id: skippedId, active: true, skipped: true, enabled: false, waiting: true });
      expect(vote.after).toEqual(vote.before);
      for (const p of pages) await p.evaluate(() => { window.__escape.debug('key', -1); window.__escape.debug('tp', -61, 66); });
      await expect(a.locator('#fade-overlay')).toContainText('第 1 关 通过');
      await Promise.all(pages.map(p => newIntro(p, skippedId)));
      const clearId = await a.evaluate(() => window.__escape.game()!.intro.id);
      await capture('clear');
      await ready(1); await a.waitForTimeout(600);
      await assertEpoch(clearId, 1);
      const fades = wire.filter(r => r.message.t === 'fade');
      expect(fades.map(r => r.message)).toEqual([{ t: 'fade', secs: 3, restart: true }, { t: 'fade', secs: 3, restart: true }, { t: 'fade', secs: 3, restart: false }]);
      const intros = wire.filter(r => r.message.t === 'event' && r.message.kind === 'intro');
      for (const [i, id] of [retryId, skippedId, clearId].entries()) {
        const start = intros.find(r => (r.message as any).id === id && !(r.message as any).ended)!;
        const end = intros.find(r => (r.message as any).id === id && (r.message as any).ended)!;
        const message = start.message as any;
        expect(message.endsAt - message.startedAt).toBe(8_000);
        expect(start.at - fades[i]!.at).toBeGreaterThanOrEqual(2_850);
        if (id !== skippedId) expect((end.message as any).now).toBeGreaterThanOrEqual(message.endsAt);
        else expect((end.message as any).now).toBeLessThan(message.endsAt);
      }
      expect(errors).toEqual([]);
    } finally {
      const recorded = await Promise.allSettled(pages.map(frames));
      writeFileSync(`${evidence}-facts.json`, JSON.stringify({ wire, frames: recorded, errors }, null, 2));
      await ca.close(); await cb.close();
      if (video) await video.saveAs(`${evidence}.webm`);
    }
  });
}
