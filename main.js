const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Sorted v2',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    // Dark until the page reports its theme (see set-window-background).
    backgroundColor: '#0d0d0f',
    show: false
  });

  // The stored theme is in the renderer's localStorage, which isn't readable
  // here — so the window starts dark and the page corrects it on load, before
  // the first paint (the page is shown on ready-to-show).
  mainWindow.loadFile('docs/index.html');
  
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// IPC handlers for data export/import
ipcMain.handle('export-data', async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Sorted Data',
    defaultPath: path.join(app.getPath('downloads'), 'sorted-backup.json'),
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  
  if (!result.canceled && result.filePath) {
    const data = await mainWindow.webContents.executeJavaScript('getAllData()');
    fs.writeFileSync(result.filePath, JSON.stringify(data, null, 2));
    return { success: true, path: result.filePath };
  }
  return { success: false };
});

// The renderer picks light or dark in Settings; the window background has to
// follow, or a light theme opens onto a dark window for a frame (and on
// resize). Only a plain hex colour is accepted — nothing else crosses over.
ipcMain.on('set-window-background', (_event, color) => {
  if (mainWindow && typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) {
    mainWindow.setBackgroundColor(color);
  }
});

ipcMain.handle('import-data', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Sorted Data',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false };
  }

  try {
    const data = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8'));
    mainWindow.webContents.send('sorted:import', data);
    return { success: true };
  } catch (err) {
    return { success: false, error: "That file isn't valid JSON" };
  }
});
