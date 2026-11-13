import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, resolve, sep } from 'node:path';

interface DownloadArtifact { platform: string; architecture?: string | string[]; role?: string; artifact: string; bytes: number; sha256: string }
interface DownloadManifest { version: string; artifacts: DownloadArtifact[]; integrationState?: string }
const filename = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const metadata = new Set(['release-manifest.json', 'README.zh-CN.md', 'SHA256SUMS.txt', 'release-validation.json', 'android-verification.json', 'mac-verification.json', 'mac-arm64-launch-verification.json', 'windows-verification.json', 'windows-x64-verification.json', 'windows-arm64-verification.json', 'source-verification.json', 'integration-verification.json']);
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));

async function manifestAt(directory: string): Promise<DownloadManifest> {
  const path = join(directory, 'release-manifest.json');
  if ((await stat(path)).size > 1024 * 1024) throw new Error('invalid manifest');
  const value = JSON.parse(await readFile(path, 'utf8')) as DownloadManifest;
  if (typeof value.version !== 'string' || !Array.isArray(value.artifacts) || value.artifacts.length > 100
    || !value.artifacts.every(item => item && typeof item.artifact === 'string' && filename.test(item.artifact)
      && !item.artifact.includes('..') && typeof item.platform === 'string' && /^[a-f0-9]{64}$/i.test(item.sha256)
      && Number.isSafeInteger(item.bytes) && item.bytes >= 0)) throw new Error('invalid manifest');
  return value;
}

function downloadPage(manifest: DownloadManifest): string {
  const validation = manifest.version === '0.5.0'
    ? '0.5.0 记录：各平台安装包通过文件结构与签名 / 架构核验；Apple 芯片 Mac 有历史实机启动记录。Windows、Android 与 Intel Mac 尚无对应实机运行记录，整体验收记录仍标记 pending。'
    : '各平台构建、签名和实机验证范围以本次验收记录为准。';
  const lanHelp = manifest.version === '0.5.0'
    ? 'Windows / macOS 的“本地游玩”支持离线单人；该内置服务只接受本机连接。连接局域网服务器时填写 http://主机局域网IP:4100，主机须单独运行对局域网开放的游戏服务。'
    : 'Windows / macOS 的“本地游玩”支持离线单人；选择“局域网开房”后，可将界面给出的局域网地址发给同一 Wi-Fi 的朋友，保持主机游戏窗口开启。';
  const rows = manifest.artifacts.map(item => {
    const platform = item.platform.toLowerCase(), architecture = Array.isArray(item.architecture) ? item.architecture.join(' / ') : item.architecture ?? '';
    const title = platform === 'android' ? 'Android 手机 / 平板' : platform === 'macos' ? `macOS · ${architecture === 'arm64' ? 'Apple 芯片' : 'Intel'}`
      : platform === 'windows' ? `Windows · ${architecture === 'x64' ? 'Intel / AMD' : architecture === 'arm64' ? 'ARM' : '双架构'}` : '源码';
    const note = platform === 'android' ? 'Android 8.0+；内置画面资源，连接服务器游玩。' : platform === 'macos' ? (item.artifact.toLowerCase().endsWith('.zip')
      ? 'macOS 13+；解压后将 .app 移入 Applications；未签名且未做 macOS 实机验收。'
      : 'macOS 13+；打开 DMG 后拖入 Applications。')
      : platform === 'windows' ? '下载后运行安装向导。桌面版本内置本地游戏服务。' : '包含客户端、服务端和桌面 / Android 构建源码。';
    return `<article><div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(note)}</p><small>${(item.bytes / 1048576).toFixed(2)} MiB · ${escapeHtml(item.artifact)}</small></div><a class="button" href="/downloads/${encodeURIComponent(item.artifact)}" download>下载</a><details><summary>SHA-256 校验值</summary><code>${item.sha256}</code></details></article>`;
  }).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>下载逃离夜校 ${escapeHtml(manifest.version)}</title><style>
:root{color-scheme:dark;font-family:system-ui,"Microsoft YaHei",sans-serif;background:#14231f;color:#e8e4d8}*{box-sizing:border-box}body{margin:0}main{max-width:920px;margin:auto;padding:36px 20px 64px}nav{display:flex;gap:20px;margin-bottom:30px}a{color:#c8dfc0}h1{font-size:32px;margin:10px 0}h2{font-size:19px;margin:0 0 8px}p{line-height:1.7;color:#c2cbbb}article{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px 20px;margin-top:18px;padding:20px;border:1px dashed #829b86;background:#192d26;border-radius:3px}article p{margin:0 0 8px}small{font-size:12px;overflow-wrap:anywhere;color:#a9b8a9}.button{align-self:center;background:#c9d5ae;color:#213023;padding:12px 22px;min-height:44px;text-decoration:none;border-radius:3px;font-weight:700}details{grid-column:1/-1;font-size:12px}summary{cursor:pointer;padding:4px 0}code{display:block;overflow-wrap:anywhere;line-height:1.7;padding-top:6px}.notes{margin-top:36px;border-top:1px solid #64796b;padding-top:15px}.notes p{font-size:14px}a:focus-visible,summary:focus-visible{outline:2px solid #fff4b9;outline-offset:4px}@media(max-width:520px){main{padding:24px 14px}article{padding:16px;gap:12px}.button{padding:12px 18px}h1{font-size:27px}}
</style></head><body><main><nav><a href="/">在线游玩</a><a href="/downloads/release-manifest.json">完整文件清单</a><a href="/downloads/SHA256SUMS.txt">校验文件</a></nav><h1>把夜校带到你的设备</h1><p>已打包客户端 ${escapeHtml(manifest.version)} · 八章游戏。网页版与安装包分别更新；桌面“本地游玩”运行安装包内置版本，在线组队连接所选服务器。</p>${rows}<section class="notes"><h2>迁移时旧安装包隐私说明 · 2026-11-13</h2><p>服务迁移时，原主机提供的原版 v0.6.2 安装包未经匿名化，包含旧角色名，请勿将其误认为匿名新版或再次公开分发。GitHub 上的旧安装包已撤下；截至 2026-11-13，匿名化安装包尚未重建。此说明仅针对迁移时的旧包，不代表从本匿名源码重新构建的版本；自建或后续安装包请核验其实际内容、版本与验收记录。请勿将私有迁移备份上传至下载页。</p><h2>本地与局域网游玩</h2><p>${escapeHtml(lanHelp)} 朋友组队可选“在线组队”，Android 也可在服务器输入框填写同一地址，所有设备进入同一房间。</p><p>Android 安装包内置客户端资源，需要连接云端或局域网服务器，不包含离线服务。各安装包内置的画面和玩法以该客户端版本为准。</p><h2>安装与验证</h2><p>Mac 包的签名与 Apple 公证状态以本次验收记录为准；Windows 未做商业签名。具体安装方式见 <a href="/downloads/README.zh-CN.md">中文说明</a>。安装包已提供 SHA-256；下载后可与上方校验值核对。</p><p>${escapeHtml(validation)} <a href="/downloads/release-validation.json">查看验收记录</a>。</p></section></main></body></html>`;
}

/** Owns only /downloads routes. No client-supplied path may escape the configured release directory. */
export function handleDownloads(req: IncomingMessage, res: ServerResponse, url: URL, directory: string): boolean {
  if (url.pathname !== '/downloads' && !url.pathname.startsWith('/downloads/')) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD' }).end(); return true; }
  void serve(req, res, url, directory).catch(error => {
    if (res.headersSent) res.destroy();
    else res.writeHead((error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 503, { 'cache-control': 'no-store' }).end('下载暂不可用');
  });
  return true;
}

async function serve(req: IncomingMessage, res: ServerResponse, url: URL, directory: string) {
  const root = await realpath(resolve(directory));
  const manifest = await manifestAt(root);
  if (url.pathname === '/downloads' || url.pathname === '/downloads/') {
    const body = Buffer.from(downloadPage(manifest));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" });
    res.end(req.method === 'HEAD' ? undefined : body); return;
  }
  let name: string;
  try { name = decodeURIComponent(url.pathname.slice('/downloads/'.length)); }
  catch { res.writeHead(400).end(); return; }
  if (!filename.test(name) || name.includes('..')) { res.writeHead(404).end(); return; }
  if (name === 'manifest.json') name = 'release-manifest.json';
  const artifact = manifest.artifacts.find(item => item.artifact === name);
  if (!artifact && !metadata.has(name)) { res.writeHead(404).end(); return; }
  const file = await realpath(join(root, name));
  if (!file.startsWith(`${root}${sep}`)) { res.writeHead(404).end(); return; }
  const info = await stat(file);
  if (!info.isFile() || (artifact && info.size !== artifact.bytes)) { res.writeHead(503).end(); return; }
  const etag = `"${artifact?.sha256 ?? `${info.size}-${Math.floor(info.mtimeMs)}`}"`;
  const headers: Record<string, string | number> = { 'accept-ranges': 'bytes', etag, 'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff', 'content-type': name.endsWith('.json') ? 'application/json; charset=utf-8' : name.endsWith('.txt') || name.endsWith('.md') ? 'text/plain; charset=utf-8' : 'application/octet-stream' };
  if (artifact) headers['content-disposition'] = `attachment; filename="${name}"`;
  if (req.headers['if-none-match']?.split(',').map(value => value.trim()).some(value => value === etag || value === '*')) { res.writeHead(304, headers).end(); return; }
  let start = 0, end = info.size - 1, partial = false;
  const range = req.headers.range;
  if (range && (!req.headers['if-range'] || req.headers['if-range'] === etag)) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    let valid = !!match && !!(match[1] || match[2]);
    if (valid && match) {
      if (!match[1]) { const suffix = Number(match[2]); valid = Number.isSafeInteger(suffix) && suffix > 0; start = Math.max(0, info.size - suffix); }
      else { start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), end); }
      valid = valid && Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start <= end && start < info.size;
    }
    if (!valid) { res.writeHead(416, { ...headers, 'content-range': `bytes */${info.size}`, 'content-length': 0 }).end(); return; }
    partial = true; headers['content-range'] = `bytes ${start}-${end}/${info.size}`;
  }
  headers['content-length'] = Math.max(0, end - start + 1);
  res.writeHead(partial ? 206 : 200, headers);
  if (req.method === 'HEAD' || info.size === 0) { res.end(); return; }
  const stream = createReadStream(file, { start, end });
  stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
}
