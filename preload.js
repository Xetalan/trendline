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

  // Oura lives in the main process because its API sends no CORS headers.
  oura: {
    setToken: (token) => ipcRenderer.invoke('oura:setToken', token),
    hasToken: () => ipcRenderer.invoke('oura:hasToken'),
    sync: (range) => ipcRenderer.invoke('oura:sync', range),
  },
});
