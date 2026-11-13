import { afterAll, beforeAll, expect, test } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join, resolve } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { WebSocket } from 'ws';
import { build } from 'vite';
import { precompress } from '../../scripts/precompress.ts';
import { stageGreen } from '../../scripts/stage-green.ts';

const port = 4385;
const script = Buffer.from('console.log("静态资源与 WebSocket 保持一致");\n'.repeat(500));
let fixture: string, root: string, server: ChildProcess;

function get(path: string, encoding?: string, method = 'GET') {
  return new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: Buffer }>((resolveRequest, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method,
      headers: encoding === undefined ? {} : { 'accept-encoding': encoding } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolveRequest({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  await mkdir(resolve('.cache'), { recursive: true });
  fixture = await mkdtemp(resolve('.cache/escape-static-'));
  const source = join(fixture, 'build'), staged = join(fixture, 'green');
  root = join(source, 'dist');
  await mkdir(root, { recursive: true });
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'assets/app.js'), script);
  await writeFile(join(root, 'index.html'), '<html>compressed static delivery</html>'.repeat(50));
  await writeFile(join(root, 'version.json'), '{"version":"test"}');
  await precompress(root);
  // Build this source into an isolated output, so tests never depend on a previous dist-server build.
  await build({ configFile: false, publicDir: false, logLevel: 'error', build: {
    ssr: resolve('server/index.ts'), outDir: join(source, 'dist-server'), target: 'node22',
    rollupOptions: { output: { entryFileNames: 'index.js' } },
  } });
  await writeFile(join(source, 'package.json'), '{"type":"module"}');
  // Exercise the deployed snapshot path, including asset/sidecar freshness after the whole build is copied.
  stageGreen(source, staged);
  root = join(staged, 'dist');
  server = spawn(process.execPath, [join(staged, 'dist-server/index.js')], { cwd: resolve('.'), env: {
    ...process.env, PORT: String(port), HOST: '127.0.0.1', DIST: root, NODE_ENV: 'production',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((ready, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`server startup timeout: ${output}`)), 15_000);
    server.once('exit', code => { clearTimeout(timeout); reject(new Error(`server exited ${code}: ${output}`)); });
    server.stdout!.on('data', chunk => {
      output += chunk.toString();
      if (output.includes('escape server on')) { clearTimeout(timeout); ready(); }
    });
    server.stderr!.on('data', chunk => { output += chunk.toString(); });
    server.once('error', reject);
  });
});

afterAll(async () => {
  if (server && server.exitCode === null) {
    const closed = new Promise<void>(done => server.once('exit', () => done()));
    server.kill('SIGTERM');
    await closed;
  }
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

test('real HTTP serves smaller gzip/br with original MIME, length, Vary and exact decoded bytes', async () => {
  for (const encoding of ['gzip', 'br']) {
    const response = await get('/assets/app.js', encoding);
    expect(response.status).toBe(200);
    expect(response.headers['content-encoding']).toBe(encoding);
    expect(response.headers['content-type']).toBe('text/javascript');
    expect(response.headers.vary).toBe('Accept-Encoding');
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(Number(response.headers['content-length'])).toBe(response.body.length);
    expect(response.body.length).toBeLessThan(script.length / 2);
    expect(encoding === 'br' ? brotliDecompressSync(response.body) : gunzipSync(response.body)).toEqual(script);
  }
});

test('negotiation honors q values, wildcards, identity exclusions, unsupported and absent encodings', async () => {
  const cases: [string | undefined, string | undefined, number][] = [
    [undefined, undefined, 200], ['', undefined, 200], ['zstd', undefined, 200],
    ['gzip, br', 'br', 200], ['GZIP, BR;q=0', 'gzip', 200],
    ['gzip ; q=1, br ; q=0', 'gzip', 200],
    ['br;q=0.5, gzip;q=0.9, identity;q=0', 'gzip', 200],
    ['gzip;q=0.5, identity;q=1', undefined, 200],
    ['br;q=0, gzip;q=0, *;q=1', undefined, 200],
    ['*;q=1', 'br', 200], ['*;q=0', undefined, 406],
    ['identity;q=0, zstd', undefined, 406],
    ['gzip;q=0, identity;q=0, br;q=0', undefined, 406],
    ['gzip;q=bogus, identity;q=0', undefined, 406],
  ];
  for (const [header, encoding, status] of cases) {
    const response = await get('/assets/app.js', header);
    expect({ header, encoding: response.headers['content-encoding'], status: response.status })
      .toEqual({ header, encoding, status });
    if (status === 200 && !encoding) expect(response.body).toEqual(script);
    if (status === 406) expect(response.headers['cache-control']).toBe('no-store');
  }
});

test('HEAD has the selected representation headers and no body; HTML/version retain cache policy', async () => {
  const head = await get('/assets/app.js', 'br', 'HEAD');
  expect(head.status).toBe(200);
  expect(head.headers['content-encoding']).toBe('br');
  expect(Number(head.headers['content-length'])).toBe((await readFile(join(root, 'assets/app.js.br'))).length);
  expect(head.body.length).toBe(0);
  const html = await get('/', 'gzip');
  expect(html.headers['cache-control']).toBe('no-cache');
  expect(html.headers['content-type']).toBe('text/html; charset=utf-8');
  const version = await get('/version.json', 'gzip, br');
  expect(version.headers['cache-control']).toBe('no-store');
  expect(version.body.toString()).toBe('{"version":"test"}');
  expect((await get('/version.json', 'identity;q=0, br')).status).toBe(406);
});

test('stale sidecars are skipped; malformed/traversal paths cannot escape static root', async () => {
  const stale = join(root, 'assets/app.js.br');
  await utimes(stale, new Date(0), new Date(0));
  expect((await get('/assets/app.js', 'br')).headers['content-encoding']).toBeUndefined();
  expect((await get('/assets/app.js', 'br, identity;q=0')).status).toBe(406);
  expect((await get('/%')).status).toBe(400);
  expect((await get('/%2e%2e%2fescape-static-sibling/private.txt')).status).toBe(403);
});

test('health and production WebSocket welcome still work beside static requests', async () => {
  const health = await get('/healthz', 'br');
  expect(JSON.parse(health.body.toString())).toEqual({ ok: true, rooms: 0 });
  expect(health.headers['content-encoding']).toBeUndefined();
  const welcome = await new Promise<unknown>((done, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.once('message', raw => { done(JSON.parse(raw.toString())); ws.close(); });
    ws.once('error', reject);
  });
  expect(welcome).toMatchObject({ t: 'welcome', id: 1 });
});

test('leaderboard is a read-only server API with validated filters and no writable score endpoint', async () => {
  const response = await get('/api/leaderboard?difficulty=story&team=solo');
  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(JSON.parse(response.body.toString())).toEqual({ difficulty: 'story', team: 'solo', entries: [] });
  expect((await get('/api/leaderboard?difficulty=madeup')).status).toBe(400);
  expect((await get('/api/leaderboard', undefined, 'POST')).status).toBe(405);
  expect((await get('/api/leaderboard', undefined, 'HEAD')).body.length).toBe(0);
});

test.skipIf(process.getuid?.() === 0)('a file stream read error does not crash the server', async () => {
  const file = join(root, 'assets/unreadable.js');
  await writeFile(file, script);
  await chmod(file, 0);
  try {
    await expect(get('/assets/unreadable.js')).rejects.toThrow();
    expect((await get('/healthz')).status).toBe(200);
  } finally { await chmod(file, 0o600); }
});
