'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // The web/PWA build exposes this same surface with platform: 'web'.
  platform: 'electron',
  load: () => ipcRenderer.invoke('data:load'),
  save: (data) => ipcRenderer.invoke('data:save', data),
  backup: (data) => ipcRenderer.invoke('data:backup', data),
  reveal: () => ipcRenderer.invoke('data:reveal'),
  exportFile: (defaultName, contents) =>
    ipcRenderer.invoke('file:export', { defaultName, contents }),
});
