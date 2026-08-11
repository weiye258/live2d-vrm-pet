// panel-preload.js — 给 settings/characters 窗口提供 IPC 通信能力
// contextIsolation: false 时直接挂 window 上
const { ipcRenderer } = require('electron');
window.panelIPC = {
  notifyModelChanged: () => ipcRenderer.send('notify-model-changed'),
  notifyConfigChanged: () => ipcRenderer.send('notify-config-changed')
};
