// Electron preload 脚本
// 安全地暴露 IPC 通信接口给渲染进程

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // 桌宠相关
  petDrag: (dx, dy) => ipcRenderer.send('pet-drag', dx, dy),
  petClick: () => ipcRenderer.send('pet-click'),
  petIgnoreMouse: (ignore) => ipcRenderer.send('pet-ignore-mouse', ignore),
  getPetPosition: () => ipcRenderer.invoke('get-pet-position'),

  // 通知相关
  petNotify: (data) => ipcRenderer.send('pet-notify', data),
  onPetNotification: (callback) => {
    ipcRenderer.on('pet-notification', (event, data) => callback(data))
  },

  // 平台信息
  platform: process.platform,
  isElectron: true,
})
