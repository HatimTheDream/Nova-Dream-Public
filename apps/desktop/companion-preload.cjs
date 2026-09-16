const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('novaCompanion', {
  prepareLink: challenge => ipcRenderer.invoke('companion:prepare-link', challenge),
  finishLink: value => ipcRenderer.invoke('companion:finish-link', value),
  openControls: () => ipcRenderer.invoke('companion:open-controls'),
  linked: () => ipcRenderer.invoke('companion:linked'),
});
