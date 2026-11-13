import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { browserArgs } from '../../game/tests/browser-args.mjs';

const apps = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const gameRequire = createRequire(new URL('../../game/package.json', import.meta.url));
const { _electron } = gameRequire('@playwright/test');
const WebSocket = gameRequire('ws');
const index = process.argv.indexOf('--executable');
const executable = index >= 0 ? process.argv[index + 1] : undefined;
const output = join(apps, 'output/lan-verification');
await mkdir(output, { recursive: true });
const app = await _electron.launch({ executablePath: executable || require('electron'),
  args: [...browserArgs(['--mute-audio']), ...(executable ? [] : [apps])], env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' }, timeout: 30_000 });
const errors = [], peers = [];
const report = { actualElectron: true, packaged: Boolean(executable), checkedAt: new Date().toISOString() };
async function until(check, label, timeout = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { if (await check()) return; await delay(75); }
  throw new Error(`Timed out: ${label}`);
}
async function peer(address, name) {
  const ws = new WebSocket(address.replace(/^http/, 'ws') + '/ws'), messages = [];
  peers.push(ws); ws.on('message', value => messages.push(JSON.parse(String(value))));
  await until(() => messages.some(m => m.t === 'welcome'), 'welcome');
  ws.send(JSON.stringify({ t: 'hello', name }));
  return { ws, messages, send: m => ws.send(JSON.stringify(m)) };
}
try {
  const launcher = await app.firstWindow();
  launcher.on('pageerror', error => errors.push(error.message));
  await launcher.click('#lan');
  await launcher.locator('#lan-panel').waitFor({ state: 'visible', timeout: 30_000 });
  const local = await launcher.getByLabel('房主本机地址', { exact: true }).inputValue();
  const addresses = await launcher.getByLabel('朋友加入地址', { exact: true }).evaluateAll(nodes => nodes.map(n => n.value));
  assert.ok(addresses.length, 'A real private LAN interface is required for this verification');
  const address = addresses[0];
  const health = await fetch(address + '/healthz').then(r => { assert.equal(r.status, 200); return r.json(); });
  const version = await fetch(address + '/version.json').then(r => r.json());
  await launcher.getByLabel('朋友加入地址', { exact: true }).first().locator('..').locator('button').click();
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), address);
  const a = await peer(address, '局域网甲'), b = await peer(address, '局域网乙');
  a.send({ t: 'create', difficulty: 'story' });
  await until(() => a.messages.some(m => m.t === 'room'), 'create room');
  const code = a.messages.find(m => m.t === 'room').code;
  b.send({ t: 'join', code });
  await until(() => a.messages.some(m => m.t === 'room' && m.players.length === 2)
    && b.messages.some(m => m.t === 'room' && m.players.length === 2), 'two players joined');
  a.send({ t: 'start' });
  await until(() => [a, b].every(p => p.messages.some(m => m.t === 'room' && m.started)
    && p.messages.filter(m => m.t === 'snap').length >= 3), 'two peers receive live campaign snapshots');
  report.lan = { local, addresses, health, version, room: code, players: 2,
    snapshots: [a, b].map(p => p.messages.filter(m => m.t === 'snap').length), clipboard: true };
  await launcher.screenshot({ path: join(output, 'lan-addresses.png') });
  const window = app.waitForEvent('window');
  await launcher.click('#host-play');
  const game = await window;
  game.on('pageerror', error => errors.push(error.message));
  await game.locator('#create').waitFor({ timeout: 30_000 });
  assert.equal(new URL(game.url()).origin, local);
  for (const ws of peers) ws.close();
  await game.close();
  await until(async () => { try { await fetch(local + '/healthz', { signal: AbortSignal.timeout(300) }); return false; } catch { return true; } }, 'host server exits when game window closes');
  assert.equal(await launcher.locator('#lan-panel').isVisible(), false);
  report.closedHostStopsServer = true;
  const soloWindow = app.waitForEvent('window');
  await launcher.click('#solo');
  const solo = await soloWindow;
  await solo.locator('#create').waitFor({ timeout: 30_000 });
  const soloUrl = new URL(solo.url());
  assert.equal(soloUrl.hostname, '127.0.0.1');
  const privateSolo = new URL(address); privateSolo.port = soloUrl.port;
  await assert.rejects(fetch(privateSolo.origin + '/healthz', { signal: AbortSignal.timeout(1000) }));
  report.soloLoopbackOnly = true;
  await solo.close();
  report.release = JSON.parse(await readFile(join(apps, 'stage/prepared.json'), 'utf8'));
  report.errors = errors; assert.deepEqual(errors, []);
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally { for (const ws of peers) ws.close(); await app.close(); }
