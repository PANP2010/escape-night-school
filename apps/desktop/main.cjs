const { app, BrowserWindow, ipcMain, utilityProcess, dialog, clipboard } = require('electron');
const { join, resolve } = require('node:path');
const { existsSync, readFileSync, mkdirSync, appendFileSync } = require('node:fs');
const { createServer } = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');

const { endpointUrl, serverEnvironment, privateIPv4Addresses } = require('./runtime.cjs');
const { allowGamePointerLock } = require('./permissions.cjs');
let launcher, gameWindow, gameOrigin, serverProcess, serverAddress, serverMode, serverPort;
let shuttingDown = false;
const runtimeRoot = () => app.isPackaged ? join(process.resourcesPath, 'game') : resolve(__dirname, '../stage/runtime');
const log = (message) => {
  try { const dir = app.getPath('logs'); mkdirSync(dir, { recursive: true }); appendFileSync(join(dir, 'game.log'), `${new Date().toISOString()} ${message}\n`); } catch {}
};

function stopServer() {
  const child = serverProcess;
  serverProcess = undefined; serverAddress = undefined; serverMode = undefined; serverPort = undefined;
  child?.kill();
  if (launcher && !launcher.isDestroyed()) launcher.webContents.send('game:host-stopped');
}
function hostDetails() {
  return { local: serverAddress, addresses: privateIPv4Addresses().map(ip => `http://${ip}:${serverPort}`) };
}
async function localServer(mode = 'solo') {
  if (serverProcess && serverAddress && serverMode === mode) return serverAddress;
  stopServer();
  const root = runtimeRoot();
  if (!existsSync(join(root, 'server.cjs'))) throw new Error('游戏文件不完整，请重新安装。');
  const port = await new Promise((resolvePort, reject) => {
    const probe = createServer(); probe.once('error', reject);
    probe.listen(0, mode === 'lan' ? '0.0.0.0' : '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolvePort(p)); });
  });
  const child = utilityProcess.fork(join(root, 'server.cjs'), [], {
    cwd: root, env: serverEnvironment(process.env, root, port, { lan: mode === 'lan', dataPath: app.getPath('userData') }), stdio: 'pipe', serviceName: '逃离夜校 · 本地游戏',
  });
  serverProcess = child;
  let exited = false;
  child.stdout?.on('data', (data) => log(String(data).trim()));
  child.stderr?.on('data', (data) => log(String(data).trim()));
  child.on('exit', (code) => {
    exited = true; const unexpected = serverProcess === child;
    if (unexpected) stopServer();
    log(`server exit ${code}`);
    if (unexpected && gameWindow && !shuttingDown) { void dialog.showMessageBox(gameWindow, { type: 'error', title: '游戏连接中断', message: '本地服务已退出，请返回主界面重试。' }); }
  });
  const address = `http://127.0.0.1:${port}`;
  for (let n = 0; n < 150; n++) {
    if (exited) throw new Error('本地游戏未能启动，请重试或查看日志。');
    try { const response = await fetch(`${address}/healthz`, { signal: AbortSignal.timeout(700) }); if (response.ok) { serverAddress = address; serverMode = mode; serverPort = port; return address; } } catch {}
    await delay(150);
  }
  stopServer(); throw new Error('本地游戏启动超时，请重试。');
}

function createLauncher() {
  launcher = new BrowserWindow({ width: 1100, height: 740, minWidth: 760, minHeight: 580, title: '逃离夜校',
    backgroundColor: '#080e12', show: false, autoHideMenuBar: true,
    icon: join(__dirname, 'assets/icon.png'),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false },
  });
  launcher.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  launcher.webContents.on('will-navigate', (event) => event.preventDefault());
  launcher.once('ready-to-show', () => launcher.show());
  launcher.on('closed', () => { launcher = undefined; if (!gameWindow) app.quit(); });
  void launcher.loadFile(join(__dirname, 'launcher.html'));
}

app.whenReady().then(() => {
  app.setName('逃离夜校');
  const { session } = require('electron');
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) =>
    callback(allowGamePointerLock(wc, permission, details, gameWindow, gameOrigin)));
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin, details) =>
    allowGamePointerLock(wc, permission, details, gameWindow, gameOrigin, origin));
  ipcMain.handle('app:version', () => {
    for (const file of [join(runtimeRoot(), 'release.json'), join(__dirname, 'release.json')]) {
      try { return JSON.parse(readFileSync(file, 'utf8')); } catch {}
    }
    return { id: app.getVersion(), entries: [] };
  });
  ipcMain.handle('app:quit', () => { app.quit(); });
  ipcMain.handle('game:host', async (event) => {
    if (event.sender !== launcher?.webContents || gameWindow) return { ok: false, error: '请先关闭当前游戏窗口。' };
    try { await localServer('lan'); return { ok: true, ...hostDetails() }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('game:copy-address', (event, address) => {
    if (event.sender !== launcher?.webContents || serverMode !== 'lan') return false;
    const host = hostDetails();
    if (address !== host.local && !host.addresses.includes(address)) return false;
    clipboard.writeText(address); return true;
  });
  ipcMain.handle('game:stop-host', (event) => {
    if (event.sender !== launcher?.webContents || gameWindow) return false;
    stopServer(); return true;
  });
  ipcMain.handle('game:launch', async (event, { mode, endpoint } = {}) => {
    if (event.sender !== launcher?.webContents) return { ok: false, error: '无效请求。' };
    if (gameWindow) { gameWindow.focus(); return { ok: true }; }
    try {
      if (!['solo', 'online', 'lan'].includes(mode)) throw new Error('请选择本地、局域网或在线游玩。');
      const address = mode === 'solo' || mode === 'lan' ? await localServer(mode) : endpointUrl(endpoint);
      if (mode === 'online') stopServer();
      const origin = new URL(address).origin;
      const win = new BrowserWindow({ width: 1360, height: 820, minWidth: 800, minHeight: 500,
        title: '逃离夜校', backgroundColor: '#03060a', show: false, autoHideMenuBar: true,
        webPreferences: { preload: join(__dirname, 'game-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, backgroundThrottling: false },
      });
      gameWindow = win; gameOrigin = origin;
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', (e, url) => { if (new URL(url).origin !== origin) e.preventDefault(); });
      win.webContents.on('before-input-event', (e, input) => {
        if (input.type === 'keyDown' && (input.key === 'F11' || (input.key === 'Enter' && input.alt))) { e.preventDefault(); win.setFullScreen(!win.isFullScreen()); }
      });
      win.on('closed', () => { gameWindow = undefined; gameOrigin = undefined; stopServer(); launcher?.show(); });
      await win.loadURL(address);
      win.show(); launcher?.hide(); return { ok: true };
    } catch (error) {
      if (gameWindow) { gameWindow.destroy(); gameWindow = undefined; gameOrigin = undefined; }
      stopServer();
      log(error.message); return { ok: false, error: '进入失败：' + error.message };
    }
  });
  createLauncher();
  app.on('activate', () => { if (!launcher && !gameWindow) createLauncher(); else (gameWindow || launcher)?.show(); });
}).catch((error) => { log(error.stack); dialog.showErrorBox('无法启动逃离夜校', error.message); app.quit(); });
app.on('before-quit', () => { shuttingDown = true; stopServer(); });
app.on('window-all-closed', () => app.quit());
