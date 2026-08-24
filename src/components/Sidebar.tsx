import { NavLink, useNavigate } from 'react-router-dom'
import {
  Home, Target, Briefcase, FolderKanban, CalendarCheck,
  GraduationCap, Brain, Heart, Bot, Inbox, Search, Bell,
  ChevronLeft, ChevronRight, Plus, Settings, BarChart3, Eye, Zap,
  Plug, TrendingUp, FlaskConical, Database, CloudUpload
} from 'lucide-react'
import { useStore } from '../store'

const menuItems = [
  { path: '/', icon: Home, label: '首页', emoji: '🏠' },
  { path: '/goals', icon: Target, label: '目标', emoji: '🎯' },
  { path: '/work', icon: Briefcase, label: '工作', emoji: '💼' },
  { path: '/projects', icon: FolderKanban, label: '项目', emoji: '🚀' },
  { path: '/actions', icon: CalendarCheck, label: '行动', emoji: '📅' },
  { path: '/growth', icon: GraduationCap, label: '成长', emoji: '📚' },
  { path: '/knowledge', icon: Brain, label: '知识与思考', emoji: '🧠' },
  { path: '/memory', icon: Brain, label: 'AI 记忆', emoji: '💾' },
  { path: '/inspector', icon: Eye, label: 'Context Inspector', emoji: '🧩' },
  { path: '/life', icon: Heart, label: '生活', emoji: '🌿' },
  { path: '/ai', icon: Bot, label: 'AI 中心', emoji: '🤖' },
  { path: '/agents', icon: Bot, label: 'Agents', emoji: '🧑‍🚀' },
  { path: '/workflows', icon: Zap, label: '自动化', emoji: '⚡' },
  { path: '/integrations', icon: Plug, label: '外部集成', emoji: '🔌' },
  { path: '/business', icon: TrendingUp, label: '业务', emoji: '📈' },
  { path: '/ai-lab', icon: FlaskConical, label: 'AI 实验室', emoji: '🧪' },
  { path: '/system', icon: Database, label: '系统架构', emoji: '🗄️' },
  { path: '/sync', icon: CloudUpload, label: '云同步', emoji: '☁️' },
  { path: '/stats', icon: BarChart3, label: '统计分析', emoji: '📊' },
]

const bottomItems = [
  { action: 'inbox', icon: Inbox, label: '全局收集', emoji: '📥' },
  { action: 'search', icon: Search, label: '全局搜索', emoji: '🔍' },
  { action: 'settings', icon: Settings, label: '设置', emoji: '⚙️' },
  { action: 'notifications', icon: Bell, label: '通知', emoji: '🔔' },
]

export default function Sidebar() {
  const { app, toggleSidebar, toggleQuickCapture, toggleGlobalSearch, getUnreadNotifications } = useStore()
  const navigate = useNavigate()
  const unreadCount = getUnreadNotifications().length

  return (
    <aside
      className={`fixed left-0 top-0 h-full bg-white border-r border-gray-200 flex flex-col z-30 transition-all duration-200 ${
        app.sidebarCollapsed ? 'w-[60px]' : 'w-[220px]'
      }`}
    >
      {/* Logo */}
      <div className="h-12 flex items-center px-3 border-b border-gray-100 shrink-0">
        {!app.sidebarCollapsed && (
          <span className="text-base font-bold text-gray-800 tracking-tight">🧠 EVAN OS</span>
        )}
        {app.sidebarCollapsed && (
          <span className="text-lg mx-auto">🧠</span>
        )}
      </div>

      {/* Main Menu */}
      <nav className="flex-1 overflow-y-auto py-2 px-2">
        {menuItems.map(item => (
          <NavLink
            key={item.path}
            to={item.path}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2 rounded-lg mb-0.5 transition-colors ${
                isActive
                  ? 'bg-blue-50 text-blue-700 font-medium'
                  : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
              } ${app.sidebarCollapsed ? 'justify-center px-2' : ''}`
            }
          >
            <span className="text-lg flex-shrink-0">{item.emoji}</span>
            {!app.sidebarCollapsed && <span className="text-sm">{item.label}</span>}
          </NavLink>
        ))}
      </nav>

      {/* Bottom Global Tools */}
      <div className="border-t border-gray-100 py-2 px-2">
        <button
          onClick={toggleQuickCapture}
          className={`flex items-center gap-3 px-3 py-2 rounded-lg mb-0.5 w-full text-gray-500 hover:bg-gray-50 hover:text-gray-900 transition-colors ${
            app.sidebarCollapsed ? 'justify-center px-2' : ''
          }`}
        >
          <Plus size={18} className="flex-shrink-0" />
          {!app.sidebarCollapsed && <span className="text-sm">快速捕获</span>}
        </button>

        {bottomItems.map(item => (
          <button
            key={item.action}
            onClick={() => {
              if (item.action === 'inbox') toggleQuickCapture()
              if (item.action === 'search') toggleGlobalSearch()
              if (item.action === 'settings') navigate('/settings')
              if (item.action === 'notifications') toggleGlobalSearch()
            }}
            className={`flex items-center gap-3 px-3 py-2 rounded-lg mb-0.5 w-full text-gray-500 hover:bg-gray-50 hover:text-gray-900 transition-colors relative ${
              app.sidebarCollapsed ? 'justify-center px-2' : ''
            }`}
          >
            <span className="text-lg flex-shrink-0">{item.emoji}</span>
            {!app.sidebarCollapsed && <span className="text-sm">{item.label}</span>}
            {item.action === 'notifications' && unreadCount > 0 && (
              <span className="absolute top-1 right-1 min-w-[18px] h-[18px] bg-red-500 text-white text-[10px] rounded-full flex items-center justify-center font-bold">
                {unreadCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Toggle */}
      <button
        onClick={toggleSidebar}
        className="h-10 flex items-center justify-center border-t border-gray-100 text-gray-400 hover:text-gray-600 hover:bg-gray-50 transition-colors"
      >
        {app.sidebarCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
      </button>
    </aside>
  )
}