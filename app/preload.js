const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  defaults: () => ipcRenderer.invoke('fs:defaults'),
  openFolder: () => ipcRenderer.invoke('fs:openFolder'),
  listDir: (dir) => ipcRenderer.invoke('fs:list', dir),
  readFile: (file) => ipcRenderer.invoke('fs:read', file),

  home: () => ipcRenderer.invoke('term:home'),
  cd: (cwd, target) => ipcRenderer.invoke('term:cd', cwd, target),
  run: (id, command, cwd) => ipcRenderer.invoke('term:run', id, command, cwd),
  kill: (id) => ipcRenderer.invoke('term:kill', id),
  onData: (cb) => ipcRenderer.on('term:data', (_e, id, data) => cb(id, data)),
  onExit: (cb) => ipcRenderer.on('term:exit', (_e, id, code) => cb(id, code)),
});
