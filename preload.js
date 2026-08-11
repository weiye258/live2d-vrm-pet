// preload.js — IPC bridge for window dragging
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('winDrag', {
  start: () => ipcRenderer.send('drag-start'),
  move: () => ipcRenderer.send('drag-move'),
  end: () => ipcRenderer.send('drag-end'),
});
