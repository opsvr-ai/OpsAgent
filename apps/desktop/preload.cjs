const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('opsagentDesktop', {
  platform: process.platform,
  secureStore: (value) => ipcRenderer.invoke('opsagent:secure-store', value),
  secureLoad: () => ipcRenderer.invoke('opsagent:secure-load'),
});
