import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

export const baseURL = 'http://127.0.0.1:4412';
const cwd = fileURLToPath(new URL('..', import.meta.url));

/** Own only this child; never reuse or terminate a process already listening on 4412. */
export async function startL6Server(label) {
  // Probe TCP ownership as well as HTTP: an unrelated/non-HTTP listener must also be left alone.
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', error => reject(new Error(`Port 4412 is unavailable; refusing to reuse or stop its owner: ${error.message}`)));
    probe.listen(4412, '127.0.0.1', () => probe.close(resolve));
  });
  await mkdir(`${cwd}/test-results`, { recursive: true });
  const child = spawn(process.execPath, ['dist-server/index.js'], {
    cwd,
    env: { ...process.env, PORT: '4412', HOST: '127.0.0.1', NODE_ENV: 'development', ESCAPE_TEST_LEVEL: '6' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lifecycle = { label, pid: child.pid, parentPid: process.pid, started: new Date().toISOString(), command: 'node dist-server/index.js', port: 4412 };
  const log = [];
  let spawnError;
  child.once('error', error => { spawnError = error; });
  child.stdout.on('data', data => log.push(data.toString()));
  child.stderr.on('data', data => log.push(data.toString()));
  const artifact = `${cwd}/test-results/l6-server-${label}`;
  await writeFile(`${artifact}.json`, JSON.stringify(lifecycle, null, 2));
  let stopping;
  const stop = () => stopping ??= (async () => {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 2500).unref()),
      ]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await new Promise(resolve => child.once('exit', resolve));
      }
    }
    await writeFile(`${artifact}.json`, JSON.stringify({ ...lifecycle, stopped: new Date().toISOString(), exitCode: child.exitCode, signal: child.signalCode }, null, 2));
    await writeFile(`${artifact}.log`, log.join(''));
  })();
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`L6 server exited: ${log.join('')}`);
      try {
        const response = await fetch(`${baseURL}/healthz`, { signal: AbortSignal.timeout(500) });
        if (response.ok && log.join('').includes('escape server on http://127.0.0.1:4412')) return { child, stop };
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`L6 server did not become healthy: ${log.join('')}`);
  } catch (error) {
    await stop(); throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await startL6Server('playwright');
  const stop = async () => { await server.stop(); process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  server.child.once('exit', async (code, signal) => { await server.stop(); process.exit(signal ? 1 : code ?? 1); });
}
