import { test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { browserArgs } from '../browser-args.mjs';
// Register the original test unchanged: its movement and 0.84 excess assertions remain the acceptance criteria.
import '../e2e/x-lowfps-remote.spec.ts';

// The imported spec supplies its own args; make Metal and audio muting explicit for this isolated run too.
test.use({ launchOptions: { args: browserArgs(['--mute-audio', '--renderer-process-limit=1', '--disable-gpu-vsync'], { softwareGL: '0' }) } });

test.beforeEach(async ({ page, browser }) => {
  const cdp = await browser.newBrowserCDPSession();
  const args = (await cdp.send('Browser.getBrowserCommandLine')).arguments;
  if (!args.includes('--mute-audio') || !args.includes('--use-angle=metal')) throw Error('Motion verification requires muted Metal Chromium');
  await cdp.detach();
  await page.addInitScript(() => {
    const state = { wire: [] as unknown[], frames: [] as unknown[] };
    (window as unknown as { __lowfpsObserved: typeof state }).__lowfpsObserved = state;
    const Base = window.WebSocket;
    window.WebSocket = class extends Base {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener('message', e => {
          const m = JSON.parse(String(e.data));
          if (m.t === 'snap' || m.t === 'correct') state.wire.push({ received: performance.now(), ...m });
        });
      }
    };
    const sample = (t: number) => {
      const g = window.__escape?.game(), r = g && [...g.remotes.values()][0];
      state.frames.push({ t, remote: r && { p: r.mesh.position.toArray(), clock: r.clock.t, latest: r.buf.lastT(), pace: r.buf.paceSpeed() },
        snaps: g?.snaps, draw: g?.draw });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
});

test.afterEach(async ({ page }, info) => {
  const directory = resolve('test-results/remote-motion');
  mkdirSync(directory, { recursive: true });
  const path = `${directory}/lowfps-${info.repeatEachIndex}.json`;
  const observed = await page.evaluate(() => (window as unknown as { __lowfpsObserved: unknown }).__lowfpsObserved).catch(e => ({ error: String(e) }));
  writeFileSync(path, JSON.stringify({ repeat: info.repeatEachIndex, status: info.status, errors: info.errors, observed }));
  await info.attach('raw-ws-clock-raf', { path, contentType: 'application/json' });
});
