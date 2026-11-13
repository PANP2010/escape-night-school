import { createRequire } from 'node:module';
import type { Page } from '@playwright/test';

type ChromiumPage = {
  delegate?: { _mainFrameSession?: { _client?: { send(method: string, params: { enabled: boolean }): Promise<unknown> } } };
};

/** Restore real focus/visibility on the session that enabled Playwright's focus override. */
export async function restoreRealFocus(page: Page): Promise<void> {
  const { version } = createRequire(import.meta.url)('playwright-core/package.json') as { version: string };
  if (version !== '1.63.0' || page.context().browser()?.browserType().name() !== 'chromium') {
    throw new Error(`restoreRealFocus requires the pinned local Playwright 1.63.0 Chromium implementation (found ${version})`);
  }
  // Playwright 1.63.0 enables focus in FrameSession._initialize. Chromium's EmulationHandler
  // retains a visibility capture handle per CDP session, so a newCDPSession(...).send(false)
  // cannot release the handle owned by Playwright. Use that original session, without patching dependencies.
  const connection = (page as unknown as { _connection?: { toImpl?: (owner: Page) => ChromiumPage } })._connection;
  if (typeof connection?.toImpl !== 'function') {
    throw new Error('restoreRealFocus requires local Playwright in-process page access; update the helper before changing the test runner');
  }
  const client = connection.toImpl(page)?.delegate?._mainFrameSession?._client;
  if (typeof client?.send !== 'function') {
    throw new Error('restoreRealFocus could not find the pinned Chromium main frame CDP session; review Playwright internals');
  }
  await client.send('Emulation.setFocusEmulationEnabled', { enabled: false });
}
