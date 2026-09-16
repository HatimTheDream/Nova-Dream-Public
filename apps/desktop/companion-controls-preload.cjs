const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktopControls', {
  status: () => ipcRenderer.invoke('companion:status'),
  open: url => ipcRenderer.invoke('companion:open', url),
  chooseApps: () => ipcRenderer.invoke('companion:choose-apps'),
  enable: access => ipcRenderer.invoke('companion:enable', access),
  stop: () => ipcRenderer.invoke('companion:stop'),
  forget: () => ipcRenderer.invoke('companion:forget'),
});
