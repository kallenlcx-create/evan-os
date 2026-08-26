// Electron 主进程
// 负责：主窗口、桌宠窗口、系统托盘、IPC 通信、自动更新

const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage } = require('electron')
const path = require('path')

const isDev = !app.isPackaged

// ====== 全局引用 ======
let mainWindow = null
let petWindow = null
let tray = null
let petPosition = { x: 0, y: 0 }

// ====== 主窗口 ======
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    title: 'Evan OS',
    icon: path.join(__dirname, '../public/favicon.svg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('close', () => { mainWindow = null })
}

// ====== 桌宠窗口 ======
function createPetWindow() {
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize
  petPosition = { x: screenW - 180, y: screenH - 220 }

  petWindow = new BrowserWindow({
    width: 150,
    height: 200,
    x: petPosition.x,
    y: petPosition.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (isDev) {
    petWindow.loadURL('http://localhost:5173/#/pet')
  } else {
    petWindow.loadFile(path.join(__dirname, '../dist/index.html'), {
      hash: '/pet',
    })
  }

  petWindow.setIgnoreMouseEvents(false)
  petWindow.on('close', () => { petWindow = null })

  // 允许拖拽
  ipcMain.on('pet-drag', (e, dx, dy) => {
    if (!petWindow) return
    const [x, y] = petWindow.getPosition()
    petWindow.setPosition(x + dx, y + dy)
  })
}

// ====== 系统托盘 ======
function createTray() {
  const iconPath = path.join(__dirname, '../public/favicon.svg')
  const icon = nativeImage.createFromPath(iconPath)
  tray = new Tray(icon.resize({ width: 16, height: 16 }))

  const contextMenu = Menu.buildFromTemplate([
    { label: '打开 Evan OS', click: () => mainWindow?.show() ?? createMainWindow() },
    { label: '显示桌宠', click: () => petWindow?.show() ?? createPetWindow(), type: 'checkbox', checked: !!petWindow },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ])

  tray.setToolTip('Evan OS')
  tray.setContextMenu(contextMenu)
  tray.on('click', () => mainWindow?.show() ?? createMainWindow())
}

// ====== IPC 通信 ======
function setupIPC() {
  // 桌宠通知 → 发送到桌宠窗口
  ipcMain.on('pet-notify', (e, data) => {
    petWindow?.webContents.send('pet-notification', data)
    // 同时发到主窗口
    mainWindow?.webContents.send('pet-notification', data)
  })

  // 桌宠交互 → 打开主窗口
  ipcMain.on('pet-click', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })

  // 获取桌宠位置
  ipcMain.handle('get-pet-position', () => petPosition)

  // 设置桌宠忽略鼠标（拖拽时）
  ipcMain.on('pet-ignore-mouse', (e, ignore) => {
    petWindow?.setIgnoreMouseEvents(ignore, { forward: true })
  })
}

// ====== 应用生命周期 ======
app.whenReady().then(() => {
  createMainWindow()
  createPetWindow()
  createTray()
  setupIPC()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// 阻止多实例
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
}

