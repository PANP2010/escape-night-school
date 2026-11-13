// All generated caches live beside evidence. The source worktree is only read by prepare-source.mjs.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const gameRoot = fileURLToPath(new URL('../../', import.meta.url));
const output = resolve(gameRoot, process.env.ESC_VIDEO_OUTPUT ?? 'test-results/video-acceptance');
const metadata = JSON.parse(readFileSync(resolve(output, 'source.json'), 'utf8'));
const source = resolve(metadata.snapshot, 'game');
const port = Number(process.env.ESC_VIDEO_PORT ?? 4466);
const reservation = createNetServer();
await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
const backendPort = reservation.address().port;
await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
if (!metadata.backend?.file) throw new Error('Run build-backend.mjs through gate heavy before starting the source server');
const backend = spawn(process.execPath, [metadata.backend.file], {
  cwd: source, stdio: 'inherit',
  env: { ...process.env, PORT: String(backendPort), HOST: '127.0.0.1', NODE_ENV: 'development',
    NAV_CACHE: metadata.nav, DIST: resolve(source, 'client') },
});
let vite;
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  await vite?.close();
  if (backend.pid && backend.exitCode === null && backend.signalCode === null) {
    const exited = once(backend, 'exit'); backend.kill('SIGTERM'); await exited;
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void stop().then(() => process.exit()); });
backend.on('exit', code => { if (!stopping) void stop().then(() => process.exit(code ?? 1)); });
backend.on('error', error => { console.error(error); void stop().then(() => process.exit(1)); });
try {
const release = JSON.parse(readFileSync(resolve(source, 'client/public/version.json'), 'utf8'));
vite = await createServer({
  configFile: false, root: resolve(source, 'client'), cacheDir: resolve(output, 'vite-cache'),
  define: { __GAME_RELEASE__: JSON.stringify(release) },
  server: { host: '127.0.0.1', port, strictPort: true, fs: { allow: [source] },
    proxy: { '/ws': { target: `ws://127.0.0.1:${backendPort}`, ws: true },
      '/healthz': { target: `http://127.0.0.1:${backendPort}` } } },
});
await vite.listen();
console.log(`Video source ${metadata.commit}: http://127.0.0.1:${port}, backend PID ${backend.pid}`);
} catch (error) { await stop(); throw error; }
