// Preload: the renderer never touches Node or ipcRenderer directly.
// It gets this narrow bridge instead, so even a compromised page can't
// reach the filesystem or spawn processes.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sortedBridge', {
  isElectron: true,
  exportData: () => ipcRenderer.invoke('export-data'),
  importData: () => ipcRenderer.invoke('import-data'),
  // Main sends the parsed backup contents after the file dialog.
  onImport: (callback) => ipcRenderer.on('sorted:import', (_event, data) => callback(data)),
  // The window is painted before the page loads, so a light theme would
  // otherwise flash dark behind it on launch and on every theme change.
  setWindowBackground: (color) => ipcRenderer.send('set-window-background', color)
});
