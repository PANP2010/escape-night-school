import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import WebSocket from 'ws';
import { type ServerMsg, type ClientMsg } from '../../shared/protocol.ts';
import { audioState, installOfflineAudio, renderOfflineAudio } from './offline-audio.ts';
import { shot } from './draw.ts';

const evidence = 'test-results/blackout-lifecycle';
type Trip = Extract<ServerMsg, { t: 'trip' }>;
const tripState = (page: Page) => page.evaluate(() => {
  const g = window.__escape.game() as any;
  return { trip: g.trip ? { ...g.trip } : null, out: g.campus.out, stutter: g.campus.stutter };
});

async function joinBot(baseURL: string, code: string, name: string) {
  const messages: ServerMsg[] = [];
  const ws = new WebSocket(`${baseURL.replace('http', 'ws')}/ws`);
  let selfId = 0, incarnation = 0, readyIncarnation = 0;
  ws.on('message', (data) => {
    const message = JSON.parse(String(data)) as ServerMsg;
    messages.push(message);
    if (message.t === 'welcome') selfId = message.id;
    if (message.t === 'room' && message.started) incarnation = message.incarnation;
    if (message.t === 'event' && message.kind === 'intro' && !message.ended) {
      ws.send(JSON.stringify({ t: 'intro-skip', id: message.id } satisfies ClientMsg));
    }
    if (message.t === 'snap' && incarnation && readyIncarnation !== incarnation &&
      message.players.some(p => p.id === selfId && (p.st ?? 0) === 0)) {
      readyIncarnation = incarnation;
      ws.send(JSON.stringify({ t: 'ready', incarnation } satisfies ClientMsg));
    }
  });
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const send = (m: ClientMsg) => ws.send(JSON.stringify(m));
  send({ t: 'hello', name }); send({ t: 'join', code });
  await expect.poll(() => messages.some((m) => m.t === 'doors')).toBe(true);
  return { ws, messages };
}

function wav(rate: number, channels: number[][]) {
  const frames = channels[0].length, pcm = Buffer.alloc(frames * channels.length * 2);
  for (let f = 0; f < frames; f++) for (let c = 0; c < channels.length; c++)
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, channels[c][f])) * 32767), (f * channels.length + c) * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels.length, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * channels.length * 2, 28);
  header.writeUInt16LE(channels.length * 2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

test('real WS trip joins and cancellation preserve the fade, then a same-seed restart restores audible ambience', async ({ browser, baseURL }) => {
  test.setTimeout(150_000);
  mkdirSync(evidence, { recursive: true });
  const context = await browser.newContext({ baseURL, viewport: { width: 844, height: 390 } });
  const pages = [await context.newPage(), await context.newPage()];
  const errors: string[] = [], wire: ServerMsg[][] = [[], []], bots: WebSocket[] = [];
  const report: Record<string, unknown> = {};
  try {
    for (const [i, p] of pages.entries()) {
      p.on('pageerror', (e) => errors.push(e.message));
      p.on('websocket', (ws) => ws.on('framereceived', ({ payload }) => wire[i].push(JSON.parse(String(payload)) as ServerMsg)));
      await installOfflineAudio(p);
      await p.goto('/?nodraw&steady'); await p.fill('#name', `重开${i + 1}`);
    }
    const [a, b] = pages;
    await a.click('#create'); await expect(a.locator('#wait-code')).not.toBeEmpty();
    const code = await a.locator('#wait-code').innerText();
    await b.fill('#code', code); await b.click('#join');
    await expect(a.locator('#wait-members li')).toHaveCount(2); await a.click('#start');
    for (const p of pages) {
      await p.waitForFunction(() => {
        const g = window.__escape.game(); return g?.presentationReady && !g.intro.active;
      });
      await expect(p.locator('#fade-overlay')).toBeHidden();
      await p.evaluate(() => { window.__escape.debug('safe', 600, 1); window.__escape.debug('safe', 600, 2); });
      await p.keyboard.press('KeyF');
      await expect.poll(async () => (await audioState(p)).ambientSources).toBe(5);
    }
    const renderer = await a.evaluate(() => {
      const gl = (window.__escape.game() as any).renderer.getContext(), debug = gl.getExtension('WEBGL_debug_renderer_info');
      return debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) as string : '';
    });
    if (process.platform === 'darwin') expect(renderer).toMatch(/Metal/);
    report.renderer = renderer;
    await a.waitForTimeout(1000);
    const initial = await Promise.all(pages.map(audioState)); report.initial = initial;
    const windows: Record<string, [number, number]>[] = initial.map((s) => ({ before: [s.seconds - 0.6, s.seconds - 0.1] }));

    // A cancelled omen must not leave a climbing hum or one last stutter on either client.
    let requested = await a.evaluate(() => { window.__escape.debug('power', 8); return performance.now(); });
    for (const p of pages) await expect.poll(async () => (await tripState(p)).trip?.beat).toBe(1);
    await a.evaluate(() => window.__escape.debug('power', 0));
    for (const p of pages) await expect.poll(() => tripState(p)).toEqual({ trip: null, out: 0, stutter: 0 });

    requested = await a.evaluate(() => { window.__escape.debug('power', 8); return performance.now(); });
    await expect.poll(async () => {
      const s = await tripState(a); return !!s.trip && s.trip.t0 > requested && s.trip.beat === 2 && s.out === 1;
    }).toBe(true);
    const late = await joinBot(baseURL!, code, '暗相晚加入'); bots.push(late.ws);
    await expect.poll(() => late.messages.some((m) => m.t === 'trip')).toBe(true);
    const remaining = late.messages.find((m): m is Trip => m.t === 'trip');
    expect(remaining).toBeDefined(); expect(remaining!.omen).toBe(0);
    expect(remaining!.off).toBeGreaterThan(0); expect(remaining!.off).toBeLessThan(8);
    report.lateTrip = remaining;
    for (const [i, p] of pages.entries()) {
      await expect(p.locator('#room-code')).toContainText('3 人');
      expect((await tripState(p)).trip?.beat).toBe(2);
      expect((await audioState(p)).transitioning).toBe(false);
      expect((await audioState(p)).seed).toBe(initial[i].seed);
      expect((await audioState(p)).contextId).toBe(initial[i].contextId);
    }
    await a.evaluate(() => window.__escape.debug('power', 0));
    for (const p of pages) await expect.poll(() => tripState(p)).toEqual({ trip: null, out: 0, stutter: 0 });

    // power(1) means a one-second dark phase after the 1.6-second omen. Start
    // the wipe only once darkness is observed, so the short trip can expire
    // within the fade while levelFlow has paused stepTrip's retirement logic.
    // A fourth real WS connection refreshes room membership, without being a new level arrival.
    await a.evaluate(() => window.__escape.debug('power', 1));
    for (const p of pages) await expect.poll(async () => {
      const state = await tripState(p);
      return { beat: state.trip?.beat, out: state.out };
    }).toEqual({ beat: 2, out: 1 });
    report.shortTripBeforeFade = await Promise.all(pages.map(tripState));
    for (const p of pages) await p.evaluate(() => window.__escape.debug('down', 1));
    for (const p of pages) await expect(p.locator('#fade-overlay')).toBeVisible();
    await a.waitForTimeout(1850);
    const fading = await Promise.all(pages.map(audioState));
    for (const [i, state] of fading.entries()) {
      expect(state.transitioning).toBe(true);
      windows[i].fade = [state.seconds - 0.6, state.seconds - 0.1];
    }
    const duringFade = await joinBot(baseURL!, code, '过场晚加入'); bots.push(duringFade.ws);
    await expect.poll(() => duringFade.messages.some((m) => m.t === 'fade')).toBe(true);
    expect(duringFade.messages.filter((m) => m.t === 'trip')).toEqual([]);
    expect(duringFade.messages.find((m) => m.t === 'fade')).toMatchObject({ restart: true });
    report.fadeJoin = duringFade.messages.filter((m) => m.t === 'trip' || m.t === 'fade' || m.t === 'room');
    for (const p of pages) {
      await expect(p.locator('#room-code')).toContainText('4 人');
      expect((await audioState(p)).transitioning).toBe(true);
      await expect(p.locator('#fade-overlay')).toBeVisible();
    }
    // A roster-triggered reveal finishes after its 280 ms animation, so a same-task visibility
    // assertion alone would miss a stale spawn incorrectly ending the handoff on the next snap.
    await a.waitForTimeout(350);
    for (const p of pages) {
      await expect(p.locator('#fade-overlay')).toBeVisible();
      expect((await audioState(p)).transitioning).toBe(true);
    }
    await a.screenshot({ path: `${evidence}/same-seed-fade.png` });
    report.fading = fading;
    for (const [i, p] of pages.entries()) {
      await expect(p.locator('#fade-overlay')).toBeHidden({ timeout: 15_000 });
      await expect.poll(async () => (await audioState(p)).ambientSources).toBe(5);
      const state = await audioState(p);
      expect(state.seed).toBe(initial[i].seed); expect(state.level).toBe(initial[i].level);
      expect(state.contextId).toBe(initial[i].contextId);
      expect(state.transitioning).toBe(false); expect(state.spectate).toBe(false); expect(state.down).toBe(false);
      expect(state.activeSources).toBeLessThanOrEqual(7);
      await expect.poll(() => tripState(p)).toEqual({ trip: null, out: 0, stutter: 0 });
    }
    await a.waitForTimeout(1400);
    const resumed = await Promise.all(pages.map(audioState)); report.resumed = resumed;
    for (const [i, state] of resumed.entries()) windows[i].resumed = [state.seconds - 0.8, state.seconds - 0.1];
    await shot(a, `${evidence}/same-seed-resumed.png`);
    const signals: unknown[] = []; report.signals = signals;
    for (const [i, p] of pages.entries()) {
      const { channels, ...signal } = await renderOfflineAudio(p, windows[i]);
      signals.push(signal); writeFileSync(`${evidence}/client-${i + 1}-resumed.wav`, wav(signal.rate, channels));
      const { before, fade, resumed } = signal.measurements;
      expect(before.rms).toBeGreaterThan(0.0001);
      expect(fade.rms).toBeLessThan(0.00001);
      expect(resumed.rms).toBeGreaterThan(0.0001);
      expect(resumed.rms).toBeGreaterThan(before.rms * 0.15);
      expect(resumed.peak).toBeLessThan(0.95);
    }
    for (const messages of wire) {
      const fade = messages.findIndex((m) => m.t === 'fade');
      expect(messages[fade]).toMatchObject({ restart: true });
      const post = messages.slice(fade + 1), spawn = post.findIndex((m) => m.t === 'correct' && m.forced);
      expect(spawn).toBeGreaterThanOrEqual(0);
      expect(post.slice(spawn + 1).find((m) => m.t === 'room')).toMatchObject({ level: 0, seed: initial[0].seed });
      expect(post.some((m) => m.t === 'trip' && m.omen === 0 && m.off === 0)).toBe(true);
    }
    expect(errors).toEqual([]);
  } finally {
    report.errors = errors;
    report.wire = wire.map((messages) => messages.filter((m) => ['room', 'fade', 'trip', 'correct'].includes(m.t)));
    writeFileSync(`${evidence}/lifecycle.json`, JSON.stringify(report, null, 2));
    for (const bot of bots) bot.close();
    await context.close();
  }
});
