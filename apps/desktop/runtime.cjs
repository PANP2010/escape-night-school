const { join } = require('node:path');
const DEFAULT_ENDPOINT = 'http://154.217.245.217:4100';
function endpointUrl(value = DEFAULT_ENDPOINT) {
  const url = new URL(value || DEFAULT_ENDPOINT);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) throw new Error('请输入有效的 HTTP 或 HTTPS 服务器地址。');
  return url.href;
}
function privateIPv4Addresses(interfaces = require('node:os').networkInterfaces()) {
  const addresses = [];
  for (const list of Object.values(interfaces)) for (const entry of list || []) {
    if (entry.internal || !['IPv4', 4].includes(entry.family)) continue;
    const parts = entry.address.split('.').map(Number);
    if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) continue;
    const [a, b] = parts;
    if (a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168) addresses.push(entry.address);
  }
  return [...new Set(addresses)];
}
function serverEnvironment(source, root, port, { lan = false, dataPath = root } = {}) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']) {
    if (typeof source[key] === 'string') env[key] = source[key];
  }
  return { ...env, NODE_ENV: 'production', HOST: lan ? '0.0.0.0' : '127.0.0.1', PORT: String(port), DIST: join(root, 'dist'), NAV_CACHE: join(root, 'campus-nav.json'), LEADERBOARD_FILE: join(dataPath, 'leaderboard.json') };
}
module.exports = { endpointUrl, serverEnvironment, privateIPv4Addresses, DEFAULT_ENDPOINT };
