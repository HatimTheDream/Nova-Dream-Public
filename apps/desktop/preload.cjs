const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('novaDesktop', { chooseWorkingFolder: () => ipcRenderer.invoke('edition3:choose-working-folder') });
