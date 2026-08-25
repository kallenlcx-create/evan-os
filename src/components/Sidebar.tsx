import { NavLink, useNavigate, useLocation } from 'react-router-dom'
import {
  Home, Target, Briefcase, FolderKanban, CalendarCheck,
  GraduationCap, Brain, Heart, Bot, Inbox, Search, Bell,
  ChevronLeft, ChevronRight, Plus, Settings, BarChart3, Eye, Zap,
  Plug, TrendingUp, FlaskConical, Database, CloudUpload,
  ChevronDown, Layers
} from 'lucide-react'
import { useState } from 'react'
import { useStore } from '../store'
import { getPresetCss } from '../config/wallpapers'

// ====== 全部导航项 ======
const ITEMS: Record<string, { icon: any; label: string; emoji: string }> = {
  '/': { icon: Home, label: '首页', emoji: '🏠' },
  '/goals': { icon: Target, label: '目标', emoji: '🎯' },
  '/work': { icon: Briefcase, label: '工作台', emoji: '💼' },
  '/projects': { icon: FolderKanban, label: '项目', emoji: '🚀' },
  '/actions': { icon: CalendarCheck, label: '行动', emoji: '📅' },
  '/growth': { icon: GraduationCap, label: '成长', emoji: '📚' },
  '/knowledge': { icon: Brain, label: '知识与思考', emoji: '🧠' },
  '/memory': { icon: Brain, label: 'AI 记忆', emoji: '💾' },
  '/inspector': { icon: Eye, label: 'Context Inspector', emoji: '🧩' },
  '/life': { icon: Heart, label: '生活', emoji: '🌿' },
  '/ai': { icon: Bot, label: 'AI 中心', emoji: '🤖' },
  '/agents': { icon: Bot, label: 'Agents', emoji: '🧑‍🚀' },
  '/workflows': { icon: Zap, label: '自动化', emoji: '⚡' },
  '/integrations': { icon: Plug, label: '外部集成', emoji: '🔌' },
  '/business': { icon: TrendingUp, label: '业务', emoji: '📈' },
  '/ai-lab': { icon: FlaskConical, label: 'AI 实验室', emoji: '🧪' },
  '/system': { icon: Database, label: '系统架构', emoji: '🗄️' },
  '/sync': { icon: CloudUpload, label: '云同步', emoji: '☁️' },
  '/stats': { icon: BarChart3, label: '统计分析', emoji: '📊' },
  '/settings': { icon: Settings, label: '设置', emoji: '⚙️' },
}

// ====== 分组定义 ======
const GROUPS: { key: string; label: string; paths: string[] }[] = [
  { key: 'core', label: '概览', paths: ['/', '/goals', '/actions', '/life'] },
  { key: 'work', label: '工作', paths: ['/work', '/projects'] },
  { key: 'knowledge', label: '知识与成长', paths: ['/knowledge', '/growth', '/ai-lab'] },
  { key: 'ai', label: 'AI', paths: ['/ai', '/agents', '/workflows', '/memory', '/inspector'] },
  { key: 'system', label: '系统', paths: ['/integrations', '/sync', '/stats', '/system', '/settings'] },
]

const GROUP_LS_KEY = 'evan-os-nav-collapsed'

function loadCollapsed(): string[] {
  try {
    const raw = localStorage.getItem(GROUP_LS_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return []
}

export default function Sidebar() {
  const { app, toggleSidebar, setMobileNav, setNotificationPanel, toggleQuickCapture, toggleGlobalSearch, getUnreadNotifications } = useStore()
  const navigate = useNavigate()
  const location = useLocation()
  const unreadCount = getUnreadNotifications().length

  const mobileOpen = app.mobileNavOpen
  const closeMobile = () => setMobileNav(false)

  // 壁纸激活时侧边栏毛玻璃化，让背景透出
  const wp = useStore(s => s.wallpaper)
  const hasWallpaper =
    (wp.type === 'image' && !!wp.imageDataUrl) ||
    (wp.type === 'preset' && !!getPresetCss(wp.presetId))
  const sidebarBg = hasWallpaper ? 'bg-white/85 backdrop-blur-md' : 'bg-white'

  const [collapsedGroups, setCollapsedGroups] = useState<string[]>(loadCollapsed)
  const toggleGroup = (key: string) => {
    setCollapsedGroups(prev => {
      const next = prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
      localStorage.setItem(GROUP_LS_KEY, JSON.stringify(next))
      return next
    })
  }

  const renderLink = (path: string) => {
    const item = ITEMS[path]
    if (!item) return null
    return (
      <NavLink
        key={path}
        to={path}
        onClick={closeMobile}
        className={({ isActive }) =>
          `flex items-center gap-3 px-3 py-2 rounded-lg mb-0.5 transition-colors ${
            isActive
              ? 'bg-blue-50 text-blue-700 font-medium'
              : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
          } ${app.sidebarCollapsed ? 'md:justify-center md:px-2' : ''}`
        }
      >
        <span className="text-lg flex-shrink-0">{item.emoji}</span>
        {!app.sidebarCollapsed && <span className="text-sm">{item.label}</span>}
      </NavLink>
    )
  }

  return (
    <>
      {/* 移动端遮罩 */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-30 md:hidden"
          onClick={closeMobile}
        />
      )}

      <aside
        className={`fixed left-0 top-0 h-full border-r border-gray-200 flex flex-col z-40
          w-[240px] transition-transform duration-200 ease-out
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}
          md:translate-x-0 md:transition-all
          ${app.sidebarCollapsed ? 'md:w-[60px]' : 'md:w-[220px]'}
          ${sidebarBg}`}
      >
      {/* Logo */}
      <div className="h-12 flex items-center px-3 border-b border-gray-100 shrink-0">
        {!app.sidebarCollapsed && (
          <span className="text-base font-bold text-gray-800 tracking-tight">🧠 EVAN OS</span>
        )}
        {app.sidebarCollapsed && (
          <span className="text-lg mx-auto">🧠</span>
        )}
        <button
          onClick={closeMobile}
          className="ml-auto p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 md:hidden"
          title="关闭菜单"
        >
          ✕
        </button>
      </div>

      {/* 分组菜单 */}
      <nav className="flex-1 overflow-y-auto py-2 px-2">
        {GROUPS.map(group => {
          const collapsed = collapsedGroups.includes(group.key)
          // 折叠时：若当前路由在本组内，自动视为展开（保持可见）
          const activeInside = group.paths.some(p => location.pathname === p || (p !== '/' && location.pathname.startsWith(p)))
          const showItems = !collapsed || activeInside
          return (
            <div key={group.key} className="mb-1.5">
              {!app.sidebarCollapsed ? (
                <button
                  onClick={() => toggleGroup(group.key)}
                  className="w-full flex items-center gap-1.5 px-2 py-1 text-[10px] font-medium text-gray-400 uppercase tracking-wider hover:text-gray-600"
                >
                  <Layers size={10} />
                  {group.label}
                  <ChevronDown size={11} className={`ml-auto transition-transform ${collapsed ? '-rotate-90' : ''}`} />
                </button>
              ) : (
                <div className="border-t border-gray-100 my-1 mx-2" />
              )}
              {showItems && group.paths.map(renderLink)}
            </div>
          )
        })}
      </nav>

      {/* Bottom Global Tools */}
      <div className="border-t border-gray-100 py-2 px-2">
        <button
          onClick={() => { closeMobile(); toggleQuickCapture() }}
          className={`flex items-center gap-3 px-3 py-2 rounded-lg mb-0.5 w-full text-gray-500 hover:bg-gray-50 hover:text-gray-900 transition-colors ${
            app.sidebarCollapsed ? 'md:justify-center md:px-2' : ''
          }`}
        >
          <Plus size={18} className="flex-shrink-0" />
          {!app.sidebarCollapsed && <span className="text-sm">快速捕获</span>}
        </button>

        <button
          onClick={() => { closeMobile(); toggleGlobalSearch() }}
          className={`flex items-center gap-3 px-3 py-2 rounded-lg mb-0.5 w-full text-gray-500 hover:bg-gray-50 hover:text-gray-900 transition-colors ${
            app.sidebarCollapsed ? 'md:justify-center md:px-2' : ''
          }`}
        >
          <Search size={18} className="flex-shrink-0" />
          {!app.sidebarCollapsed && <span className="text-sm">全局搜索</span>}
        </button>

        <button
          onClick={() => { closeMobile(); setNotificationPanel(true) }}
          className={`flex items-center gap-3 px-3 py-2 rounded-lg mb-0.5 w-full text-gray-500 hover:bg-gray-50 hover:text-gray-900 transition-colors relative ${
            app.sidebarCollapsed ? 'md:justify-center md:px-2' : ''
          }`}
        >
          <Bell size={18} className="flex-shrink-0" />
          {!app.sidebarCollapsed && <span className="text-sm">通知</span>}
          {unreadCount > 0 && (
            <span className="absolute top-1 right-1 min-w-[18px] h-[18px] bg-red-500 text-white text-[10px] rounded-full flex items-center justify-center font-bold">
              {unreadCount}
            </span>
          )}
        </button>
      </div>

      {/* Toggle（仅桌面端显示） */}
      <button
        onClick={toggleSidebar}
        className="hidden md:flex h-10 items-center justify-center border-t border-gray-100 text-gray-400 hover:text-gray-600 hover:bg-gray-50 transition-colors"
      >
        {app.sidebarCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
      </button>
    </aside>
    </>
  )
}
