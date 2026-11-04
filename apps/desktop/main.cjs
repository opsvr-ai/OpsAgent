const { app, BrowserWindow, Menu, ipcMain, safeStorage, shell } = require('electron');
const { readFile, writeFile, mkdir } = require('node:fs/promises');
const path = require('node:path');

const targetUrl = process.env.OPSAGENT_DESKTOP_URL ?? 'http://127.0.0.1:5173';
const secretFile = () => path.join(app.getPath('userData'), 'desktop-secret');

app.disableHardwareAcceleration();

async function readSecret() {
  try {
    const encoded = await readFile(secretFile(), 'utf8');
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
  } catch {
    return null;
  }
}

async function writeSecret(value) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统密钥链不可用');
  }
  await mkdir(path.dirname(secretFile()), { recursive: true });
  await writeFile(secretFile(), safeStorage.encryptString(value).toString('base64'), {
    mode: 0o600,
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 720,
    title: 'OpsAgent',
    backgroundColor: '#0b0e14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.loadURL(targetUrl);
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  return window;
}

app.whenReady().then(() => {
  ipcMain.handle('opsagent:secure-store', async (_event, value) => {
    if (typeof value !== 'string') throw new Error('value must be string');
    await writeSecret(value);
    return true;
  });
  ipcMain.handle('opsagent:secure-load', () => readSecret());

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'OpsAgent',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
  ]));

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
