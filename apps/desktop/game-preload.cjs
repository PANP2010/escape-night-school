const { contextBridge } = require('electron');
// Presentation metadata only: game pages receive none of the launcher's privileged IPC methods.
contextBridge.exposeInMainWorld('nightSchoolNative', Object.freeze({ platform: 'desktop' }));
