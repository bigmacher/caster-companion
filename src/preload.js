const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rode', {
  scanSessions: () => ipcRenderer.invoke('scan-sessions'),
  ejectVolume: () => ipcRenderer.invoke('eject-volume'),
  chooseDestination: () => ipcRenderer.invoke('choose-destination'),
  analyzeSession: (opts) => ipcRenderer.invoke('analyze-session', opts),
  exportSession: (opts) => ipcRenderer.invoke('export-session', opts),
  revealFile: (p) => ipcRenderer.invoke('reveal-file', p),
  scanHid: () => ipcRenderer.invoke('scan-hid'),
  onExportProgress: (cb) =>
    ipcRenderer.on('export-progress', (_e, data) => cb(data)),
});
