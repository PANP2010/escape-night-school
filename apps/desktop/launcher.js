const $ = id => document.getElementById(id);
let busy = false;
const buttons = () => ['solo', 'online', 'lan', 'host-play'].map(id => $(id));
const setBusy = value => { busy = value; for (const button of buttons()) button.disabled = value; };
window.nightSchool.onHostStopped(() => { $('lan-panel').hidden = true; });
try { $('endpoint').value = localStorage.getItem('escape.server') || $('endpoint').value; } catch {}
async function launch(mode) {
  if (busy) return;
  setBusy(true);
  $('status').textContent = mode === 'solo' ? '正在唤醒校园……' : '正在连接服务器……';
  const endpoint = $('endpoint').value.trim();
  try {
    const result = await window.nightSchool.launch(mode, endpoint);
    if (!result.ok) throw new Error(result.error);
    try { localStorage.setItem('escape.server', endpoint); } catch {}
    $('status').textContent = '';
  } catch (error) { $('status').textContent = error.message || '连接失败，请重试。'; }
  finally { setBusy(false); }
}
$('solo').onclick = () => launch('solo');
$('online').onclick = () => launch('online');
$('host-play').onclick = () => launch('lan');
$('host-stop').onclick = async () => { if (await window.nightSchool.stopHost()) $('lan-panel').hidden = true; };
$('lan').onclick = async () => {
  if (busy) return;
  setBusy(true); $('status').textContent = '正在开启局域网服务……';
  try {
    const host = await window.nightSchool.hostLan();
    if (!host.ok) throw new Error(host.error);
    $('lan-addresses').replaceChildren();
    for (const [label, addresses] of [['朋友加入地址', host.addresses], ['房主本机地址', [host.local]]]) {
      for (const address of addresses) {
        const group = document.createElement('label'); group.textContent = label;
        const row = document.createElement('div'); row.className = 'address-row';
        const input = document.createElement('input'); input.readOnly = true; input.value = address; input.setAttribute('aria-label', label);
        const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = '复制';
        copy.onclick = async () => { if (await window.nightSchool.copyAddress(address)) { copy.textContent = '已复制'; setTimeout(() => { copy.textContent = '复制'; }, 1400); } };
        row.append(input, copy); group.append(row); $('lan-addresses').append(group);
      }
    }
    $('lan-warning').textContent = host.addresses.length ? '有多个地址时，选择与朋友手机位于同一网段的地址。' : '未发现可分享的局域网 IPv4 地址，请先连接 Wi-Fi 或有线网络，再重新开房。';
    $('lan-panel').hidden = false; $('status').textContent = '';
    $('lan-panel').scrollIntoView({ block: 'nearest' });
  } catch (error) { $('status').textContent = error.message || '局域网服务未能启动。'; }
  finally { setBusy(false); }
};
$('quit').onclick = () => window.nightSchool.quit();
void window.nightSchool.version().then(release => { $('version').textContent = `v${release.id} · ${release.chapters || '?'} 个章节`; });
