import type { BrowserContextOptions } from '@playwright/test';

/** The gate runs real scenes at the existing low settings on this software WebGL host. */
export function gateStorageState(baseURL: string): BrowserContextOptions['storageState'] {
  return {
    cookies: [],
    origins: [{
      origin: new URL(baseURL).origin,
      localStorage: [{ name: 'escape.settings', value: JSON.stringify({ pixelRatio: 1, postprocessing: false }) }],
    }],
  };
}
