import { Outlet, useLocation } from 'react-router-dom'
import { Search, Plus, Menu, X } from 'lucide-react'
import { useEffect, type CSSProperties } from 'react'
import Sidebar from './Sidebar'
import GlobalSearch from './GlobalSearch'
import QuickCapture from './QuickCapture'
import NotificationCenter from './NotificationCenter'
import SearchDeepLink from './SearchDeepLink'
import { PageErrorBoundary } from './ErrorBoundary'
import { useStore } from '../store'
import { getPresetCss } from '../config/wallpapers'

export default function Layout() {
  // 按需订阅：Layout 包裹全部页面，整店订阅会让任何状态变化重渲染当前页
  const mobileNavOpen = useStore(s => s.app.mobileNavOpen)
  const sidebarCollapsed = useStore(s => s.app.sidebarCollapsed)
  const wallpaper = useStore(s => s.wallpaper)
  const toggleSidebar = useStore(s => s.toggleSidebar)
  const setMobileNav = useStore(s => s.setMobileNav)
  const setNotificationPanel = useStore(s => s.setNotificationPanel)
  const toggleGlobalSearch = useStore(s => s.toggleGlobalSearch)
  const toggleQuickCapture = useStore(s => s.toggleQuickCapture)
  const backupNeeded = useStore(s => s.backupNeeded)
  const runBackupNow = useStore(s => s.runBackupNow)
  const snoozeBackupReminder = useStore(s => s.snoozeBackupReminder)
  const location = useLocation()

  // 应用壁纸（图片或预设渐变）+ 同步 body 背景
  const hasWallpaper = wallpaper.type === 'image' && !!wallpaper.imageDataUrl
    ? true
    : wallpaper.type === 'preset' && !!getPresetCss(wallpaper.presetId)

  const bgStyle: CSSProperties = {}
  if (wallpaper.type === 'image' && wallpaper.imageDataUrl) {
    bgStyle.backgroundImage = `url(${wallpaper.imageDataUrl})`
  } else if (wallpaper.type === 'preset') {
    bgStyle.backgroundImage = getPresetCss(wallpaper.presetId)
  }
  if (bgStyle.backgroundImage) {
    bgStyle.backgroundSize = 'cover'
    bgStyle.backgroundPosition = 'center'
    bgStyle.backgroundAttachment = 'fixed'
  }

  useEffect(() => {
    document.body.style.background = hasWallpaper ? (bgStyle.backgroundImage ?? '') : ''
    document.body.style.backgroundSize = hasWallpaper ? 'cover' : ''
    document.body.style.backgroundAttachment = hasWallpaper ? 'fixed' : ''
    return () => { document.body.style.background = '' }
  }, [hasWallpaper, wallpaper])

  // 路由变化时收起移动端抽屉（兜底，导航点击时已处理）
  useEffect(() => { setMobileNav(false); setNotificationPanel(false) }, [location.pathname, setMobileNav, setNotificationPanel])

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
    <div
      className={`min-h-screen relative ${hasWallpaper ? '' : 'bg-[#f5f5f7]'}`}
      style={bgStyle.backgroundImage ? bgStyle : undefined}
    >
      {/* 壁纸遮罩（保证白色卡片内容可读） */}
      {hasWallpaper && wallpaper.dim > 0 && (
        <div
          className="absolute inset-0 bg-black pointer-events-none"
          style={{ opacity: wallpaper.dim }}
        />
      )}
      <Sidebar />

      {/* 移动端顶栏 */}
      <div className="md:hidden sticky top-0 z-20 h-12 flex items-center gap-2 px-3 bg-white/90 backdrop-blur border-b border-gray-100">
        <button
          onClick={() => setMobileNav(!mobileNavOpen)}
          className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-600"
          title="菜单"
        >
          {mobileNavOpen ? <X size={20} /> : <Menu size={20} />}
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
        className={`relative transition-all duration-200
          ml-0
          ${sidebarCollapsed ? 'md:ml-[60px]' : 'md:ml-[220px]'}`}
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

        {/* 备份提醒横幅 */}
        {backupNeeded && (
          <div className="px-4 md:px-6 pt-3">
            <div className="max-w-7xl flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 text-xs text-amber-700">
              <span>🛡️ 已经超过 7 天没有备份数据了</span>
              <button onClick={runBackupNow} className="ml-auto px-2.5 py-1 bg-amber-500 text-white rounded-lg font-medium hover:bg-amber-600">立即备份</button>
              <button onClick={snoozeBackupReminder} className="px-2 py-1 text-amber-500 hover:text-amber-700">稍后</button>
            </div>
          </div>
        )}

        {/* 主内容区 */}
        <main className="p-4 md:p-6 max-w-7xl">
          <PageErrorBoundary key={location.pathname}>
            <Outlet />
          </PageErrorBoundary>
        </main>
      </div>
      <GlobalSearch />
      <QuickCapture />
      <NotificationCenter />
      <SearchDeepLink />
    </div>
  )
}
