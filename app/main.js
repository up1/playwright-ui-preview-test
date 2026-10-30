const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');
const { spawn } = require('child_process');

const IGNORED = new Set(['node_modules', '.git', '.DS_Store', 'dist', 'out']);
const MAX_FILE_SIZE = 1024 * 1024;

let win;
const processes = new Map();

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0b1433',
    title: 'UI Test Studio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// ---------- File system ----------

ipcMain.handle('fs:defaults', () => ({
  folder: path.join(__dirname, 'sample'),
  url: 'file://' + path.join(__dirname, 'sample', 'site', 'checkout.html'),
}));

ipcMain.handle('fs:openFolder', async () => {
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('fs:list', async (_e, dir) => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((d) => !IGNORED.has(d.name))
    .map((d) => ({ name: d.name, path: path.join(dir, d.name), isDir: d.isDirectory() }))
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
});

ipcMain.handle('fs:read', async (_e, file) => {
  const stat = await fs.stat(file);
  if (stat.size > MAX_FILE_SIZE) return { error: 'File too large to preview' };
  return { content: await fs.readFile(file, 'utf8') };
});

// ---------- Terminal ----------

ipcMain.handle('term:home', () => os.homedir());

ipcMain.handle('term:cd', async (_e, cwd, target) => {
  const next = path.resolve(cwd, (target || '~').replace(/^~/, os.homedir()));
  const stat = await fs.stat(next).catch(() => null);
  if (!stat || !stat.isDirectory()) return { error: `cd: no such directory: ${target}` };
  return { cwd: next };
});

ipcMain.handle('term:run', (e, id, command, cwd) => {
  const child = spawn(command, {
    cwd,
    shell: process.env.SHELL || true,
    env: { ...process.env, FORCE_COLOR: '0', CI: '1' },
  });
  processes.set(id, child);
  const send = (data) => e.sender.send('term:data', id, data.toString());
  child.stdout.on('data', send);
  child.stderr.on('data', send);
  child.on('error', (err) => send(err.message + '\n'));
  child.on('close', (code) => {
    processes.delete(id);
    e.sender.send('term:exit', id, code);
  });
});

ipcMain.handle('term:kill', (_e, id) => {
  processes.get(id)?.kill('SIGINT');
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  processes.forEach((p) => p.kill());
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
