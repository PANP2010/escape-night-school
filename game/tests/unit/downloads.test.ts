import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleDownloads } from '../../server/downloads.ts';

const data = Buffer.from('native-artifact-0123456789'), sha256 = createHash('sha256').update(data).digest('hex');
let directory: string, origin: string;
const server = createServer((req, res) => { if (!handleDownloads(req, res, new URL(req.url!, 'http://local'), directory)) res.writeHead(404).end(); });
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'escape-downloads-'));
  await writeFile(join(directory, 'game.exe'), data);
  await writeFile(join(directory, 'secret.txt'), 'not listed');
  await writeFile(join(directory, 'README.zh-CN.md'), '中文说明');
  await writeFile(join(directory, 'release-manifest.json'), JSON.stringify({ version: '0.5.0', artifacts: [
    { platform: 'windows', architecture: 'x64', artifact: 'game.exe', bytes: data.length, sha256 },
    { platform: 'windows', architecture: 'arm64', artifact: 'link.exe', bytes: data.length, sha256 },
    { platform: 'macos', architecture: 'arm64', artifact: 'mac-arm64.zip', bytes: data.length, sha256 },
    { platform: 'macos', architecture: 'x64', artifact: 'mac-x64.dmg', bytes: data.length, sha256 },
  ] }));
  await symlink(join(directory, '../outside-secret'), join(directory, 'link.exe'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('no port');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });

describe('native download delivery', () => {
  it('renders a Chinese page from the existing release manifest and explains Android/LAN behavior', async () => {
    const response = await fetch(`${origin}/downloads/`), html = await response.text();
    expect(response.status).toBe(200); expect(html).toContain('0.5.0'); expect(html).toContain('game.exe');
    expect(html).toContain('原版 v0.6.2 安装包未经匿名化');
    expect(html).toContain('不代表从本匿名源码重新构建的版本');
    expect(html).toContain('GitHub 上的旧安装包已撤下');
    expect(html).toContain('局域网'); expect(html).toContain('不包含离线服务'); expect(html).toContain('pending');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
  });
  it('distinguishes unsigned macOS ZIP applications from DMG installation steps', async () => {
    const html = await (await fetch(`${origin}/downloads/`)).text();
    const articles = html.match(/<article>.*?<\/article>/g) ?? [];
    const zip = articles.find(article => article.includes('mac-arm64.zip'));
    const dmg = articles.find(article => article.includes('mac-x64.dmg'));
    expect(zip).toContain('解压后将 .app 移入 Applications');
    expect(zip).toContain('未签名且未做 macOS 实机验收');
    expect(zip).not.toContain('打开 DMG');
    expect(dmg).toContain('打开 DMG 后拖入 Applications');
    expect(dmg).not.toContain('解压后');
  });
  it('streams the original bytes as an attachment and supports HEAD and ETag', async () => {
    const response = await fetch(`${origin}/downloads/game.exe`);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(data);
    expect(response.headers.get('content-disposition')).toContain('attachment;');
    expect(response.headers.get('content-length')).toBe(String(data.length));
    const head = await fetch(`${origin}/downloads/game.exe`, { method: 'HEAD' });
    expect(head.status).toBe(200); expect(await head.text()).toBe(''); expect(head.headers.get('content-length')).toBe(String(data.length));
    expect((await fetch(`${origin}/downloads/game.exe`, { headers: { 'if-none-match': response.headers.get('etag')! } })).status).toBe(304);
  });
  it('serves bounded, open and suffix byte ranges and range HEAD', async () => {
    for (const [range, start, end] of [['bytes=2-5', 2, 5], ['bytes=20-', 20, data.length - 1], ['bytes=-4', data.length - 4, data.length - 1]] as const) {
      const response = await fetch(`${origin}/downloads/game.exe`, { headers: { range } });
      expect(response.status).toBe(206); expect(response.headers.get('content-range')).toBe(`bytes ${start}-${end}/${data.length}`);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(data.subarray(start, end + 1));
    }
    const head = await fetch(`${origin}/downloads/game.exe`, { method: 'HEAD', headers: { range: 'bytes=2-5' } });
    expect(head.status).toBe(206); expect(head.headers.get('content-length')).toBe('4'); expect(await head.text()).toBe('');
  });
  it('rejects malformed or unsatisfiable ranges without streaming the artifact', async () => {
    for (const range of ['bytes=999-', 'bytes=5-2', 'bytes=-0', 'bytes=1-2,5-6', 'words=0-2']) {
      const response = await fetch(`${origin}/downloads/game.exe`, { headers: { range } });
      expect(response.status).toBe(416); expect(response.headers.get('content-range')).toBe(`bytes */${data.length}`);
    }
  });
  it('allows manifest aliases but refuses unlisted files, encoded paths, symlink escapes and writes', async () => {
    expect((await fetch(`${origin}/downloads/manifest.json`)).status).toBe(200);
    expect((await fetch(`${origin}/downloads/secret.txt`)).status).toBe(404);
    expect((await fetch(`${origin}/downloads/%2e%2e%2fsecret.txt`)).status).toBe(404);
    expect((await fetch(`${origin}/downloads/link.exe`)).status).toBe(404);
    expect((await fetch(`${origin}/downloads/game.exe`, { method: 'POST' })).status).toBe(405);
  });
});
