import { Outlet, useLocation } from 'react-router-dom'
import { Search, Plus, Menu, X } from 'lucide-react'
import { useEffect } from 'react'
import Sidebar from './Sidebar'
import GlobalSearch from './GlobalSearch'
import QuickCapture from './QuickCapture'
import { PageErrorBoundary } from './ErrorBoundary'
import { useStore } from '../store'

export default function Layout() {
  const { app, toggleSidebar, setMobileNav, toggleGlobalSearch, toggleQuickCapture } = useStore()
  const location = useLocation()

  // 路由变化时收起移动端抽屉（兜底，导航点击时已处理）
  useEffect(() => { setMobileNav(false) }, [location.pathname, setMobileNav])

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

      {/* 移动端顶栏 */}
      <div className="md:hidden sticky top-0 z-20 h-12 flex items-center gap-2 px-3 bg-white/90 backdrop-blur border-b border-gray-100">
        <button
          onClick={() => setMobileNav(!app.mobileNavOpen)}
          className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-600"
          title="菜单"
        >
          {app.mobileNavOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
        <span className="text-sm font-bold text-gray-800">🧠 EVAN OS</span>
        <button
          onClick={toggleGlobalSearch}
          className="ml-auto p-2 rounded-lg hover:bg-gray-100 text-gray-500"
          title="搜索"
        >
          <Search size={18} />
        </button>
        <button
          onClick={toggleQuickCapture}
          className="p-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700"
          title="快速收集"
        >
          <Plus size={18} />
        </button>
      </div>

      <div
        className={`transition-all duration-200
          ml-0
          ${app.sidebarCollapsed ? 'md:ml-[60px]' : 'md:ml-[220px]'}`}
      >
        {/* 桌面端顶栏 */}
        <header className="hidden md:sticky md:top-0 md:z-20 md:h-12 md:flex md:items-center md:gap-3 md:px-4 bg-white/80 backdrop-blur border-b border-gray-100">
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
        <main className="p-4 md:p-6 max-w-7xl">
          <PageErrorBoundary key={location.pathname}>
            <Outlet />
          </PageErrorBoundary>
        </main>
      </div>
      <GlobalSearch />
      <QuickCapture />
    </div>
  )
}
