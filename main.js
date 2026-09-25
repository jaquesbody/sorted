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
      nodeIntegration: true,
      contextIsolation: false
    },
    backgroundColor: '#0d0d0f',
    show: false
  });

  mainWindow.loadFile('renderer/index.html');
  
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

ipcMain.handle('import-data', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Sorted Data',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  });
  
  if (!result.canceled && result.filePaths.length > 0) {
    const data = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8'));
    await mainWindow.webContents.executeJavaScript(`importData(${JSON.stringify(data)})`);
    return { success: true };
  }
  return { success: false };
});
