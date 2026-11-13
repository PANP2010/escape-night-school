const $ = id => document.getElementById(id);
let busy = false;
try { $('endpoint').value = new URLSearchParams(location.search).get('server') || localStorage.getItem('escape.server') || $('endpoint').value; } catch {}
window.nativeLaunchFailed = message => { busy = false; $('enter').disabled = false; $('status').textContent = message || '未能进入校园，请重试。'; };
$('enter').onclick = () => {
  if (busy) return;
  let server;
  try {
    const address = new URL($('endpoint').value.trim());
    if (!['http:', 'https:'].includes(address.protocol) || !address.hostname || address.username || address.password) throw new Error();
    server = address.href;
  } catch { window.nativeLaunchFailed('请输入有效的 HTTP 或 HTTPS 服务器地址。'); return; }
  busy = true; $('enter').disabled = true; $('status').textContent = '正在进入校园……';
  try { localStorage.setItem('escape.server', server); } catch {}
  location.href = `escape-native://launch?server=${encodeURIComponent(server)}`;
  setTimeout(() => { if (busy) window.nativeLaunchFailed('未能进入校园，请重试。'); }, 8000);
};
$('quit').onclick = () => { location.href = 'escape-native://quit'; };
fetch('release.json', { cache: 'no-store' }).then(response => response.ok ? response.json() : null).then(release => {
  if (release?.id && release.chapters) $('version').textContent = `v${release.id} · ${release.chapters} 个章节`;
}).catch(() => {});
