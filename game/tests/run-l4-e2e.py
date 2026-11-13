"""Run the isolated L4 preview on 4294; build the game first. No dependency installation."""
from pathlib import Path
import os
import subprocess

root = Path(__file__).resolve().parent.parent
results = root / "test-results"
results.mkdir(exist_ok=True)
config = results / "l4.playwright.config.ts"
port = int(os.environ.get("ESC_TEST_PORT", "4294"))
config.write_text("""import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import base from '../playwright.config.ts';
export default defineConfig({ ...base,
  testDir: '../tests/e2e-l4', testMatch: 'l4.spec.ts', timeout: 240_000, retries: 0,
  outputDir: './l4-browser-artifacts',
  use: { baseURL: 'http://127.0.0.1:4294', viewport: { width: 960, height: 600 },
    launchOptions: base.use?.launchOptions },
  webServer: { command: 'PORT=4294 NAV_CACHE=.cache/campus-nav.json node dist-server/index.js --l4-preview',
    cwd: fileURLToPath(new URL('../', import.meta.url)), url: 'http://127.0.0.1:4294/healthz',
    reuseExistingServer: false, timeout: 20_000 },
});
""".replace("4294", str(port)))
with (results / "l4-browser.log").open("w") as log:
    result = subprocess.run(
        ["npx", "--no-install", "playwright", "test", "-c", str(config)],
        cwd=root, stdout=log, stderr=subprocess.STDOUT, timeout=420,
    )
print(f"L4 browser exit: {result.returncode}; log: {results / 'l4-browser.log'}")
raise SystemExit(result.returncode)
