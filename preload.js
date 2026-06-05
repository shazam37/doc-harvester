const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),
  startDownload: (options) => ipcRenderer.invoke('start-download', options),
  stopDownload: () => ipcRenderer.invoke('stop-download'),

  // Returns a cleanup function to remove the listener
  onProgress: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('progress-update', handler);
    return () => ipcRenderer.removeListener('progress-update', handler);
  },
});
