import { expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { skipReason, stageGreen } from '../../scripts/stage-green.ts';
import { assetRefs, compareDeploy } from '../../scripts/verify-deploy.ts';

const put = (root: string, f: string, s: string) => { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), s); };
const fakeBuild = (tag: string) => {
  const src = mkdtempSync(join(tmpdir(), 'green-src-'));
  put(src, 'dist/index.html', `<script src="assets/index-${tag}.js">`);
  put(src, `dist/assets/index-${tag}.js`, tag);
  put(src, 'dist-server/index.js', `server ${tag}`);
  put(src, 'package.json', '{}');
  put(src, 'client/src/x.ts', 'source, not shipped');
  return src;
};

test('stageGreen copies only the runtime files and replaces the previous snapshot whole', () => {
  const dest = join(mkdtempSync(join(tmpdir(), 'green-')), '.green');
  stageGreen(fakeBuild('AAA'), dest);
  expect(readFileSync(join(dest, 'dist-server/index.js'), 'utf8')).toBe('server AAA');
  expect(existsSync(join(dest, 'client'))).toBe(false);
  const src = fakeBuild('BBB');
  put(src, '.cache/campus-nav.json', '{"key":"k"}');
  expect(stageGreen(src, dest)).toEqual(['dist', 'dist-server', 'package.json', '.cache/campus-nav.json']);
  expect(readFileSync(join(dest, 'dist/index.html'), 'utf8')).toContain('index-BBB.js');
  expect(existsSync(join(dest, 'dist/assets/index-AAA.js'))).toBe(false); // stale hashed bundle gone
  expect(existsSync(join(dest, '.cache/campus-nav.json'))).toBe(true);
});

test('stageGreen refuses an incomplete build and leaves the last green snapshot untouched', () => {
  const dest = join(mkdtempSync(join(tmpdir(), 'green-')), '.green');
  stageGreen(fakeBuild('AAA'), dest);
  const half = mkdtempSync(join(tmpdir(), 'green-half-'));
  put(half, 'dist-server/index.js', 'server BBB');
  put(half, 'package.json', '{}');
  expect(() => stageGreen(half, dest)).toThrow(/dist\/index.html/);
  expect(readFileSync(join(dest, 'dist/index.html'), 'utf8')).toContain('index-AAA.js');
  expect(readFileSync(join(dest, 'dist-server/index.js'), 'utf8')).toBe('server AAA');
});

test('stageGreen preserves asset and sidecar timestamps so fresh compression stays eligible', () => {
  const src = fakeBuild('COMPRESSED'), dest = join(mkdtempSync(join(tmpdir(), 'green-')), '.green');
  const asset = 'dist/assets/index-COMPRESSED.js';
  for (const [i, ext] of ['', '.gz', '.br'].entries()) {
    put(src, asset + ext, `bytes ${ext}`);
    const date = new Date(1_700_000_000_000 + i * 1000);
    utimesSync(join(src, asset + ext), date, date);
  }
  stageGreen(src, dest);
  for (const ext of ['', '.gz', '.br']) {
    expect(readFileSync(join(dest, asset + ext))).toEqual(readFileSync(join(src, asset + ext)));
    expect(statSync(join(dest, asset + ext)).mtimeMs).toBe(statSync(join(src, asset + ext)).mtimeMs);
  }
});

test('check-run staging is skipped inside a Claude session unless forced; the loop.sh gate and explicit runs stage', () => {
  expect(skipReason(['--from-check'], { CLAUDECODE: '1' })).toMatch(/CLAUDECODE/); // agent / supervisor mid-iteration
  expect(skipReason(['--from-check'], {})).toBeNull(); // loop.sh gate under systemd
  expect(skipReason(['--from-check'], { CLAUDECODE: '1', ESC_STAGE_GREEN: '1' })).toBeNull();
  expect(skipReason([], { CLAUDECODE: '1' })).toBeNull(); // bare `npm run stage-green`
});

test('compareDeploy matches the hashed bundles a served index.html references against the green snapshot', () => {
  const page = (js: string, css = 'DMehcwmh') =>
    `<script type="module" crossorigin src="/assets/index-${js}.js"></script>\n<link rel="stylesheet" crossorigin href="/assets/index-${css}.css">`;
  expect(assetRefs(page('BQvnERHL'))).toEqual(['assets/index-BQvnERHL.js', 'assets/index-DMehcwmh.css']);
  expect(compareDeploy(page('BQvnERHL'), page('BQvnERHL')).ok).toBe(true);
  expect(compareDeploy(page('DblNyGBN'), page('BQvnERHL'))).toMatchObject({ ok: false, served: ['assets/index-DMehcwmh.css', 'assets/index-DblNyGBN.js'] });
  expect(compareDeploy(page('BQvnERHL', 'other'), page('BQvnERHL')).ok).toBe(false); // css alone differs
  expect(compareDeploy('<html>maintenance</html>', '<html></html>').ok).toBe(false); // no assets on either side ≠ ok
});
