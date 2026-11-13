// Real browser capture from the effects mix. Writes stereo PCM/WAV and measurement evidence.
// First run npm run build:client/build:server and serve this worktree on PORT (default 4382).
import { chromium } from '@playwright/test';
import { browserArgs } from './browser-args.mjs';
import { assertDebugAvailable } from './helpers.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
const out = process.env.AUDIO_EVIDENCE ?? 'test-results/audio-polish';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: browserArgs(['--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding']) });
const context = await browser.newContext({ baseURL: `http://127.0.0.1:${process.env.PORT ?? 4382}`, viewport: { width: 960, height: 540 } });
const page = await context.newPage(); const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  await page.goto('/?nodraw&steady'); await page.fill('#name', '声音试听'); await page.click('#create'); await page.click('#start');
  await page.waitForFunction(() => window.__escape.game()?.presentationReady);
  await assertDebugAvailable(page);
  await page.evaluate(() => { window.__escape.debug('safe', 600, 1); window.__escape.debug('safe', 600, 2); });
  await page.keyboard.press('KeyF');
  await page.waitForFunction(() => window.__escape.game().sound.diagnostics.ambientSources === 5);
  await page.evaluate(async () => {
    const sound = window.__escape.game().sound, ac = sound.context;
    const code = `class Capture extends AudioWorkletProcessor {
      process(inputs) {
        const channels = inputs[0];
        if (channels?.[0]) this.port.postMessage(channels.map((channel) => new Float32Array(channel)));
        return true;
      }
    } registerProcessor('escape-capture', Capture);`;
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    try { await ac.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    const capture = new AudioWorkletNode(ac, 'escape-capture');
    window.__soundCapture = { chunks: [], rate: ac.sampleRate, capture, sound };
    capture.port.onmessage = (e) => window.__soundCapture.chunks.push(e.data.map((ch) => Array.from(ch)));
    sound.master.connect(capture); capture.connect(ac.destination); // Processor emits silence.
  });
  const marks = [];
  const mark = async (kind) => marks.push({ kind, seconds: await page.evaluate(() => {
    const c = window.__soundCapture; return c.chunks.reduce((n, chunk) => n + chunk[0].length, 0) / c.rate;
  }) });
  await mark('indoor ambience'); await page.waitForTimeout(1800);
  await mark('actual footsteps'); await page.keyboard.down('KeyW'); await page.waitForTimeout(2600); await page.keyboard.up('KeyW');
  const door = await page.evaluate(() => {
    const g = window.__escape.game(); const d = g.doors.find((d) => g.doorLocked[d.id] === false && !g.doorOpen[d.id]);
    window.__escape.debug('tp', d.x + (d.alongX ? 0 : 1), d.z + (d.alongX ? 1 : 0), Math.round((d.y0 ?? 0) / 3.6)); return d.id;
  });
  await page.waitForTimeout(500); await mark('authoritative door opening');
  await page.evaluate((id) => window.__escape.net.send({ t: 'door', id }), door); await page.waitForTimeout(850);
  await mark('authoritative door closing'); await page.evaluate((id) => window.__escape.net.send({ t: 'door', id }), door); await page.waitForTimeout(650);
  await mark('flashlight click'); await page.keyboard.press('KeyF'); await page.waitForTimeout(600);
  await mark('down heartbeat'); await page.evaluate(() => window.__escape.debug('down', 20));
  await page.waitForTimeout(3000);
  const recording = await page.evaluate(() => {
    const c = window.__soundCapture; c.sound.master.disconnect(c.capture); c.capture.disconnect(); c.capture.port.close();
    return { rate: c.rate, chunks: c.chunks, diagnostics: c.sound.diagnostics };
  });
  const frames = recording.chunks.reduce((n, chunk) => n + chunk[0].length, 0), channels = 2;
  const pcm = Buffer.alloc(frames * channels * 2); let offset = 0, sum = 0, peak = 0;
  for (const chunk of recording.chunks) for (let f = 0; f < chunk[0].length; f++) for (let ch = 0; ch < channels; ch++) {
    const value = chunk[ch]?.[f] ?? chunk[0][f]; sum += value * value; peak = Math.max(peak, Math.abs(value));
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), offset); offset += 2;
  }
  const header = Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22); header.writeUInt32LE(recording.rate, 24);
  header.writeUInt32LE(recording.rate * channels * 2, 28); header.writeUInt16LE(channels * 2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  writeFileSync(`${out}/listening-sample.pcm`, pcm); writeFileSync(`${out}/listening-sample.wav`, Buffer.concat([header, pcm]));
  const report = { rate: recording.rate, channels, encoding: 's16le', seconds: frames / recording.rate, peak, rms: Math.sqrt(sum / (frames * channels)), marks, diagnostics: recording.diagnostics, errors };
  writeFileSync(`${out}/signal.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  if (errors.length || !(peak > 0.01 && peak < 0.95)) throw new Error('Audio capture failed signal/console checks');
} finally { await context.close(); await browser.close(); }
