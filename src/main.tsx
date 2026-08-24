import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
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
root.render(<Root />)

// 初始化数据库
useStore.getState().initFromDB()

// 申请持久化存储：阻止浏览器在磁盘空间紧张时自动清除 IndexedDB
if (navigator.storage?.persist) {
  navigator.storage.persist().catch(() => {})
}