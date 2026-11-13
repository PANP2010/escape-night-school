import type { Page } from '@playwright/test';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { shot } from '../e2e/draw.ts';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'escape-draw-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

test.each(['render', 'screenshot'] as const)('%s failure survives a closed page during cleanup and removes stale evidence', async (stage) => {
  const path = join(directory, 'capture.png');
  await writeFile(path, 'old screenshot');
  const failure = new Error(stage === 'render' ? 'render failed' : 'capture failed');
  const evaluate = vi.fn();
  if (stage === 'render') evaluate.mockRejectedValueOnce(failure);
  else evaluate.mockResolvedValueOnce(undefined);
  evaluate.mockRejectedValueOnce(new Error('page closed'));
  const screenshot = vi.fn().mockRejectedValue(failure);
  // Only orchestrate remote calls: browser tests cover the actual rendering, decode and pixel checks.
  const page = { evaluate, screenshot } as unknown as Page;

  await expect(shot(page, path)).rejects.toBe(failure);
  await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(evaluate).toHaveBeenCalledTimes(2);
  expect(screenshot).toHaveBeenCalledTimes(stage === 'render' ? 0 : 1);
});
