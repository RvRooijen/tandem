// What the window gives tandem's page besides what a browser does: the system's own folder picker.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tandemDesktop', {
  pickFolder: (title) => ipcRenderer.invoke('pick-folder', title),
});
