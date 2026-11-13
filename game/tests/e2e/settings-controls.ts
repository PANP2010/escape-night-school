import { expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { frame } from './draw.ts';

/** Exercise the single native settings entry with trusted browser input. */
export async function toggleSettings(page: Page, touch = false) {
  const open = await page.locator('#game-settings').evaluate((dialog: HTMLDialogElement) => dialog.open);
  const button = page.locator(open ? '#settings-close' : '#settings-open');
  if (touch) await button.tap(); else await button.click();
  if (open) await expect(page.locator('#game-settings')).toBeHidden();
  else await expect(page.locator('#game-settings')).toBeVisible();
}

/** The modal may cover every scene sample on a phone; capture its UI separately from scene evidence. */
export async function settingsShot(page: Page, path: string) {
  await expect(page.locator('#game-settings')).toBeVisible();
  await mkdir(dirname(path), { recursive: true });
  await frame(page);
  try { await page.screenshot({ path }); }
  finally { await page.evaluate(() => document.getElementById('e2e-shot')?.remove()); }
}
