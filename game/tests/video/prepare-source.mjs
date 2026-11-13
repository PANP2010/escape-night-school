// Freeze a reviewed source commit into ignored evidence before recording it.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const gameRoot = fileURLToPath(new URL('../../', import.meta.url));
const sourceRoot = realpathSync(option('--source-root', resolve(gameRoot, '..')));
const ref = option('--source-ref', 'HEAD');
const output = resolve(gameRoot, option('--output', 'test-results/video-acceptance'));
const git = (...a) => execFileSync('git', ['-C', sourceRoot, ...a], { maxBuffer: 128 * 1024 * 1024 });
const commit = git('rev-parse', `${ref}^{commit}`).toString().trim();
const snapshot = resolve(output, 'source-snapshot');
if (existsSync(resolve(snapshot, 'game/package.json'))) throw new Error('Use a fresh output directory; existing evidence is never overwritten');
mkdirSync(snapshot, { recursive: true });
const archive = git('archive', commit, 'game');
execFileSync('tar', ['-x', '-C', snapshot], { input: archive });
symlinkSync(realpathSync(resolve(gameRoot, 'node_modules')), resolve(snapshot, 'game/node_modules'), 'dir');
const nav = resolve(output, 'campus-nav.json');
cpSync(resolve(sourceRoot, 'game/.cache/campus-nav.json'), nav);
const hash = data => createHash('sha256').update(data).digest('hex');
const manifest = {
  sourceRoot, commit, preparedAt: new Date().toISOString(), snapshot, nav,
  sourceStatus: git('status', '--short', '--untracked-files=no').toString().trim(),
  archiveSha256: hash(archive), navSha256: hash(readFileSync(nav)),
  files: Object.fromEntries(['client/src/warden/anim.ts', 'client/src/warden/model.ts', 'client/src/mobs.ts',
    'client/src/game.ts', 'server/room.ts'].map(file => [file, hash(readFileSync(resolve(snapshot, 'game', file)))])),
  runtime: 'Vite source server from immutable archived commit; pre-existing dist is not consumed',
};
writeFileSync(resolve(output, 'source.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
