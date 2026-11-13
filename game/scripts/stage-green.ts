// Last step of `npm run check` (--from-check): snapshot the build that just passed every check into .green/.
// escape.service (ExecStartPre) rsyncs .green/ → /root/escape/serve/ on (re)start and serves from there, so a red gate
// that rebuilt dist/ in place never reaches players (審查 #198: red WIP client was served against an old server).
import { cpSync, existsSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** What the server needs at runtime, relative to the game dir. `.cache` is optional (server rebuilds the nav lazily). */
export const GREEN_ITEMS = ['dist', 'dist-server', 'package.json', '.cache/campus-nav.json'];
const REQUIRED = ['dist/index.html', 'dist-server/index.js', 'package.json'];

/** Copy GREEN_ITEMS from `src` into `dest`, swapping the whole directory in at the end so readers never see half a copy. */
export function stageGreen(src: string, dest: string): string[] {
  const missing = REQUIRED.filter(f => !existsSync(join(src, f)));
  if (missing.length) throw new Error(`stage-green: build incomplete, missing ${missing.join(', ')}`);
  const tmp = `${dest}.tmp-${process.pid}`, old = `${dest}.old-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  const copied = GREEN_ITEMS.filter(f => existsSync(join(src, f)));
  // Static delivery compares sidecar mtimes with their source asset; copy order must not make a fresh
  // .br/.gz appear older than the asset and silently disable compression after staging.
  for (const f of copied) cpSync(join(src, f), join(tmp, f), { recursive: true, preserveTimestamps: true });
  if (existsSync(dest)) renameSync(dest, old);
  renameSync(tmp, dest);
  rmSync(old, { recursive: true, force: true });
  return copied;
}

/**
 * `npm run check` passes --from-check. A check run inside a Claude session (CLAUDECODE=1: an agent mid-iteration or the
 * supervisor) is green but not yet committed by loop.sh, so it must not become what a manual `systemctl restart escape`
 * ships; only loop.sh's gate (plain systemd env) stages. ESC_STAGE_GREEN=1 or a bare `npm run stage-green` forces it. (#200)
 */
export function skipReason(argv: string[], env: Record<string, string | undefined>): string | null {
  if (!argv.includes('--from-check') || env.ESC_STAGE_GREEN === '1') return null;
  return env.CLAUDECODE === '1' ? 'inside a Claude session (CLAUDECODE=1), only the loop.sh gate stages' : null;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const skip = skipReason(process.argv.slice(2), process.env);
  if (skip) { console.log(`stage-green: skipped, ${skip}; run \`npm run stage-green\` to force`); process.exit(0); }
  const src = resolve('.'), dest = resolve(process.env.GREEN_DIR ?? '.green');
  const copied = stageGreen(src, dest);
  console.log(`stage-green: ${copied.join(' ')} → ${dest}`);
}
