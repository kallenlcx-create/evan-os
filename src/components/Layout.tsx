import { Outlet } from 'react-router-dom'
import { Search, Plus, Menu } from 'lucide-react'
import { useEffect } from 'react'
import Sidebar from './Sidebar'
import GlobalSearch from './GlobalSearch'
import QuickCapture from './QuickCapture'
import { useStore } from '../store'

export default function Layout() {
  const { app, toggleSidebar, toggleGlobalSearch, toggleQuickCapture } = useStore()

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        toggleGlobalSearch()
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault()
        toggleQuickCapture()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [toggleGlobalSearch, toggleQuickCapture])

  return (
    <div className="min-h-screen bg-[#f5f5f7]">
      <Sidebar />
      <div
        className={`transition-all duration-200 ${
          app.sidebarCollapsed ? 'ml-[60px]' : 'ml-[220px]'
        }`}
      >
        {/* 顶栏 */}
        <header className="sticky top-0 z-20 h-12 flex items-center gap-3 px-4 bg-white/80 backdrop-blur border-b border-gray-100">
          <button
            onClick={toggleSidebar}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500"
            title="切换侧边栏"
          >
            <Menu size={18} />
          </button>
          <button
            onClick={toggleGlobalSearch}
            className="flex-1 flex items-center gap-2 px-3 py-1.5 bg-gray-50 hover:bg-gray-100 rounded-lg text-sm text-gray-400 transition-colors"
          >
            <Search size={16} />
            <span>搜索...</span>
            <kbd className="ml-auto text-[10px] px-1.5 py-0.5 bg-white border border-gray-200 rounded text-gray-400">Ctrl K</kbd>
          </button>
          <button
            onClick={toggleQuickCapture}
            className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm transition-colors"
            title="快速收集"
          >
            <Plus size={16} />
            <span className="hidden sm:inline">快速收集</span>
          </button>
        </header>

        {/* 主内容区 */}
        <main className="p-6 max-w-7xl">
          <Outlet />
        </main>
      </div>
      <GlobalSearch />
      <QuickCapture />
    </div>
  )
}
