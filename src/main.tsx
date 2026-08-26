import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './index.css'

// 预加载数据库，等数据就绪后再渲染
import { useStore } from './store'

function Root() {
  const { loaded, initFromDB } = useStore()

  return (
    <StrictMode>
      {loaded ? (
        <App />
      ) : (
        <div className="min-h-screen flex items-center justify-center bg-[#f5f5f7]">
          <div className="text-center">
            <div className="text-5xl mb-4 animate-pulse">🧠</div>
            <div className="text-lg text-gray-600 font-medium">Evan OS 正在启动...</div>
            <div className="text-sm text-gray-400 mt-1">加载数据中</div>
          </div>
        </div>
      )}
    </StrictMode>
  )
}

const container = document.getElementById('root')!
const root = createRoot(container)
root.render(
  <ErrorBoundary level="root">
    <Root />
  </ErrorBoundary>
)

// 初始化数据库
useStore.getState().initFromDB()

// 请求桌面通知权限（首次访问时静默请求）
if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission().catch(() => {})
}

// 申请持久化存储：阻止浏览器在磁盘空间紧张时自动清除 IndexedDB
if (navigator.storage?.persist) {
  navigator.storage.persist().catch(() => {})
}

// 云同步：已开启自动同步的设备，启动即挂载同步循环
import { cloudSync } from './services/cloudSync'
void cloudSync.startAutoSync()

// 历史数据清理：events/运行记录/已完结审批 保留 90 天
import { cleanupOldRecords } from './db'
cleanupOldRecords(90).catch(() => {})

// Service Worker：离线可靠 + 版本缓存（仅生产构建注册）
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {})
  })
}

// 未处理的异步错误 → 通知中心（不再静默）
window.addEventListener('unhandledrejection', e => {
  console.error('[EvanOS] 未处理的异步错误:', e.reason)
  try {
    useStore.getState().addNotification({
      title: '操作失败',
      message: String(e.reason).slice(0, 140),
      type: 'system',
    })
  } catch { /* ignore */ }
})