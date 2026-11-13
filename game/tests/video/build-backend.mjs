// Run through gate heavy. Only ignored evidence artifacts are written.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const gameRoot = fileURLToPath(new URL('../../', import.meta.url));
const output = resolve(gameRoot, process.env.ESC_VIDEO_OUTPUT ?? 'test-results/video-acceptance');
const file = resolve(output, 'source.json');
const metadata = JSON.parse(readFileSync(file, 'utf8'));
const source = resolve(metadata.snapshot, 'game');
await build({ configFile: false, root: source, publicDir: false,
  build: { ssr: 'server/index.ts', outDir: resolve(output, 'backend'), emptyOutDir: false,
    target: 'node22', rollupOptions: { output: { entryFileNames: 'index.mjs' } } } });
const entry = resolve(output, 'backend/index.mjs');
const before = readFileSync(metadata.nav);
const navCheck = execFileSync(process.execPath, [entry, '--build-nav'], {
  cwd: source, encoding: 'utf8', env: { ...process.env, NAV_CACHE: metadata.nav },
});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
metadata.backend = { file: entry, sha256: sha(readFileSync(entry)) };
metadata.navIdentity = { verifiedBy: 'frozen source campusNavCached validates campusKey through --build-nav',
  key: JSON.parse(readFileSync(metadata.nav, 'utf8')).key, rebuilt: sha(before) !== sha(readFileSync(metadata.nav)),
  consumedSha256: sha(readFileSync(metadata.nav)), output: navCheck.trim() };
writeFileSync(file, JSON.stringify(metadata, null, 2) + '\n');
console.log(JSON.stringify({ backend: metadata.backend, navIdentity: metadata.navIdentity }, null, 2));
