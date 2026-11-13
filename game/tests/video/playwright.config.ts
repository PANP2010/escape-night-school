import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('This acceptance config requires macOS ANGLE Metal');

const port = Number(process.env.ESC_VIDEO_PORT ?? 4466);
const gameRoot = fileURLToPath(new URL('../../', import.meta.url));
const output = resolve(gameRoot, process.env.ESC_VIDEO_OUTPUT ?? 'test-results/video-acceptance');
export default defineConfig({
  testDir: '.', testMatch: 'acceptance.spec.mjs', outputDir: `${output}/runner`,
  timeout: 600_000, workers: 1, retries: 0, reporter: 'line',
  use: {
    baseURL: `http://127.0.0.1:${port}`, headless: true,
    // Chromium's screencast scale uses the initial physical window, even when
    // the emulated viewport is later resized. Keep it within the smallest shot.
    launchOptions: { args: ['--use-angle=metal', '--mute-audio', '--window-size=844,390', '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] },
  },
  webServer: { command: 'node tests/video/source-server.mjs', cwd: gameRoot,
    url: `http://127.0.0.1:${port}/healthz`,
    reuseExistingServer: false, timeout: 60_000 },
});
