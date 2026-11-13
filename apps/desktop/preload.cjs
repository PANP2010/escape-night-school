const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('nightSchool', Object.freeze({
  launch: (mode, endpoint) => ipcRenderer.invoke('game:launch', { mode, endpoint }),
  hostLan: () => ipcRenderer.invoke('game:host'),
  stopHost: () => ipcRenderer.invoke('game:stop-host'),
  copyAddress: (address) => ipcRenderer.invoke('game:copy-address', address),
  onHostStopped: (callback) => ipcRenderer.on('game:host-stopped', () => callback()),
  version: () => ipcRenderer.invoke('app:version'),
  quit: () => ipcRenderer.invoke('app:quit'),
}));
