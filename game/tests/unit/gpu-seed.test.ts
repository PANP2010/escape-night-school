import { afterEach, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const fixtures: string[] = [];
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(installed = true, present = false) {
  const root = mkdtempSync(join(tmpdir(), 'escape-gpu-seed-'));
  fixtures.push(root);
  for (const folder of ['game', 'tmp', 'cache']) mkdirSync(join(root, folder));
  if (installed) {
    const core = join(root, 'game/node_modules/playwright-core');
    mkdirSync(core, { recursive: true });
    writeFileSync(join(core, 'package.json'), JSON.stringify({ version: '1.63.0' }));
    writeFileSync(join(root, 'game/package-lock.json'), JSON.stringify({ packages: {
      'node_modules/playwright-core': { version: '1.63.0' },
    } }));
    const browsers = [
      { name: 'chromium', revision: '1243' },
      { name: 'chromium-headless-shell', revision: '1243' },
      { name: 'ffmpeg', revision: '1011' },
      { name: 'firefox', revision: '1543' },
    ];
    writeFileSync(join(core, 'browsers.json'), JSON.stringify({ browsers }));
    for (const browser of browsers) {
      const folder = join(root, 'cache', `${browser.name.replaceAll('-', '_')}-${browser.revision}`);
      mkdirSync(folder);
      writeFileSync(join(folder, 'INSTALLATION_COMPLETE'), '');
      writeFileSync(join(folder, 'DEPENDENCIES_VALIDATED'), 'local only');
      writeFileSync(join(folder, 'binary'), 'browser payload');
    }
    mkdirSync(join(root, 'cache/.links'));
    writeFileSync(join(root, 'cache/.links/local'), 'local dependency link');
  }
  return {
    root,
    run: () => spawnSync('bash', ['-c', `
set -Eeuo pipefail
source "$1"
gpu_api() {
  printf '%s\\n' "$1" >> "$GPU_FIXTURE/calls"
  if [[ $1 == ssh-short ]]; then
    printf '%s\\n' "$2" >> "$GPU_FIXTURE/commands"
    [[ $2 != test* ]] || echo "$GPU_SEED_PRESENT"
  elif [[ $1 == cp-seed ]]; then
    [[ $3 == :/home/ubuntu/escape-gpu-browsers.tar.gz ]]
  else
    return 99
  fi
}
gpu_seed_browsers
`, 'gpu-seed-test', resolve('../tools/gpu-seed')], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, GPU_GAME: join(root, 'game'), GPU_TMP: join(root, 'tmp'),
        GPU_FIXTURE: root, PLAYWRIGHT_BROWSERS_PATH: join(root, 'cache'), GPU_SEED_PRESENT: present ? 'present' : 'missing' },
    }),
  };
}

test('seed helper skips fixtures without local Playwright and makes no cloud calls', () => {
  const f = fixture(false);
  expect(f.run().status).toBe(0);
  expect(existsSync(join(f.root, 'calls'))).toBe(false);
});

test('matching remote installation avoids archive creation and transfer', () => {
  const f = fixture(true, true);
  const result = f.run();
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(join(f.root, 'calls'), 'utf8')).toBe('ssh-short\n');
  expect(existsSync(join(f.root, 'tmp/browsers.tar.gz'))).toBe(false);
});

test('seed archive contains only exact browser revisions and excludes host-specific cache markers', () => {
  const f = fixture();
  const result = f.run();
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(join(f.root, 'calls'), 'utf8')).toBe('ssh-short\ncp-seed\nssh-short\n');
  const archive = spawnSync('tar', ['-tzf', join(f.root, 'tmp/browsers.tar.gz')], { encoding: 'utf8' });
  expect(archive.status).toBe(0);
  expect(archive.stdout).toContain('chromium-1243/INSTALLATION_COMPLETE');
  expect(archive.stdout).toContain('chromium_headless_shell-1243/binary');
  expect(archive.stdout).toContain('ffmpeg-1011/binary');
  expect(archive.stdout).not.toMatch(/firefox|\.links|DEPENDENCIES_VALIDATED/);
  expect(readFileSync(join(f.root, 'commands'), 'utf8')).toContain('tar -xzf /home/ubuntu/escape-gpu-browsers.tar.gz -C /home/ubuntu/.cache/ms-playwright');
});

test('a local Playwright version different from lockfile cannot seed another browser build', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'game/node_modules/playwright-core/package.json'), '{"version":"1.62.0"}');
  const result = f.run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('differs from lockfile');
  expect(existsSync(join(f.root, 'calls'))).toBe(false);
});
