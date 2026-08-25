import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store'
import { Plus, Check, Clock, AlertCircle, Lightbulb, TrendingUp, ChevronRight, PenLine, CloudUpload, ShieldCheck, Inbox } from 'lucide-react'
import { db } from '../db'
import { cloudSync, getSyncConfig } from '../services/cloudSync'
import type { Task } from '../types'

// ====== 状态聚合条（审批 / 收集 / 同步 / 备份）======
function StatusStrip() {
  const navigate = useNavigate()
  const [pendingApprovals, setPendingApprovals] = useState(0)
  const [pendingInbox, setPendingInbox] = useState(0)
  const [syncInfo, setSyncInfo] = useState<{ last?: string; auto: boolean } | null>(null)

  useEffect(() => {
    ;(async () => {
      try { setPendingApprovals(await db.approvals.where('status').equals('pending').count()) } catch {}
      try { setPendingInbox(await db.inbox.filter(i => !i.processed).count()) } catch {}
      try {
        const cfg = await getSyncConfig()
        if (cfg?.serverUrl) setSyncInfo({ last: cfg.lastSyncAt, auto: !!cfg.autoSync })
      } catch {}
    })()
  }, [])

  const tiles = [
    pendingApprovals > 0 && {
      key: 'approvals', emoji: '🛡️', label: `待审批 ${pendingApprovals}`, cls: 'bg-amber-50 border-amber-200 text-amber-700', path: '/agents',
    },
    pendingInbox > 0 && {
      key: 'inbox', emoji: '📥', label: `收集 ${pendingInbox}`, cls: 'bg-sky-50 border-sky-200 text-sky-700', path: '/inbox',
    },
    syncInfo && {
      key: 'sync', emoji: '☁️',
      label: syncInfo.last ? `已同步 ${new Date(syncInfo.last).toLocaleTimeString()}` : '未同步',
      cls: 'bg-white border-gray-200 text-gray-500', path: '/sync',
    },
  ].filter(Boolean) as { key: string; emoji: string; label: string; cls: string; path: string }[]

  if (tiles.length === 0) return null
  return (
    <div className="flex items-center gap-2 mb-4 overflow-x-auto">
      {tiles.map(t => (
        <button key={t.key} onClick={() => navigate(t.path)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs whitespace-nowrap ${t.cls}`}>
          <span>{t.emoji}</span> {t.label}
          {t.key === 'sync' && syncInfo?.auto && <span className="text-[9px] text-green-500">auto</span>}
        </button>
      ))}
    </div>
  )
}

export default function HomePage() {
  const { projects, habits, getTodayTasks, getUnreadNotifications, toggleTaskStatus, addTask, getDailyLog, getTodayPomodoroStats } = useStore()
  const navigate = useNavigate()
  const [newTask, setNewTask] = useState('')
  const todayTasks = getTodayTasks()
  const unreadNotifs = getUnreadNotifications()

  const todayStr = new Date().toISOString().slice(0, 10)
  const todayLog = getDailyLog(todayStr)
  const todayPomo = getTodayPomodoroStats()

  const handleAddTask = () => {
    if (!newTask.trim()) return
    addTask({ title: newTask.trim() })
    setNewTask('')
  }

  const inProgressProjects = projects.filter(p => p.status === 'in_progress')

  return (
    <div className="space-y-6">
      <StatusStrip />
      {/* 页面标题 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">🏠 首页</h1>
          <p className="text-sm text-gray-400 mt-0.5">
            {new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}
          </p>
        </div>
        <button
          onClick={() => navigate('/journal')}
          className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-xl text-sm text-gray-600 hover:border-blue-300 hover:text-blue-600 transition-all shadow-sm"
        >
          <PenLine size={16} />
          {todayLog ? '✏️ 继续写日志' : '📝 写今日日志'}
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* 左列：今日重点 + 待办 */}
        <div className="lg:col-span-2 space-y-6">
          {/* 今日重点 */}
          <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-800 flex items-center gap-2">
                <span>📋</span> 今日重点
              </h2>
              <span className="text-xs text-gray-400 bg-gray-100 px-2 py-1 rounded-full">
                {todayTasks.filter(t => t.status === 'done').length}/{todayTasks.length} 完成
              </span>
            </div>

            {/* 添加任务 */}
            <div className="flex gap-2 mb-4">
              <input
                type="text"
                value={newTask}
                onChange={e => setNewTask(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAddTask()}
                placeholder="添加今日任务..."
                className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-300 transition-all"
              />
              <button
                onClick={handleAddTask}
                disabled={!newTask.trim()}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-40 transition-colors flex items-center gap-1"
              >
                <Plus size={16} />
                添加
              </button>
            </div>

            {/* 任务列表 */}
            <div className="space-y-1">
              {todayTasks.length === 0 && (
                <div className="text-center py-8 text-gray-400 text-sm">
                  🎉 今天没有待办事项，享受轻松的一天！
                </div>
              )}
              {todayTasks.map(task => (
                <TaskItem key={task.id} task={task} onToggle={() => toggleTaskStatus(task.id)} />
              ))}
            </div>
          </div>

          {/* 进行中的项目 */}
          <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-800 flex items-center gap-2">
                <span>🚀</span> 进行中的项目
              </h2>
              <button className="text-xs text-blue-600 hover:text-blue-700 flex items-center gap-1">
                查看全部 <ChevronRight size={14} />
              </button>
            </div>
            {inProgressProjects.length === 0 ? (
              <div className="text-center py-6 text-gray-400 text-sm">暂无进行中的项目</div>
            ) : (
              <div className="space-y-3">
                {inProgressProjects.map(proj => (
                  <div key={proj.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl">
                    <span className="text-2xl">{proj.emoji}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-800">{proj.title}</div>
                      <div className="mt-1.5 w-full bg-gray-200 rounded-full h-1.5">
                        <div
                          className="bg-blue-500 h-1.5 rounded-full transition-all"
                          style={{ width: `${proj.progress}%` }}
                        />
                      </div>
                    </div>
                    <span className="text-xs text-gray-400">{proj.progress}%</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 右列：重要提醒 + 习惯 + AI 建议 */}
        <div className="space-y-6">
          {/* 重要提醒 */}
          <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
            <h2 className="text-lg font-semibold text-gray-800 flex items-center gap-2 mb-4">
              <span>🔔</span> 重要提醒
            </h2>
            {unreadNotifs.length === 0 ? (
              <div className="text-center py-4 text-gray-400 text-sm">暂无新提醒</div>
            ) : (
              <div className="space-y-2">
                {unreadNotifs.slice(0, 5).map(n => (
                  <div key={n.id} className="flex items-start gap-2 p-2 bg-orange-50 rounded-lg">
                    <AlertCircle size={16} className="text-orange-500 mt-0.5 flex-shrink-0" />
                    <div>
                      <div className="text-sm font-medium text-gray-800">{n.title}</div>
                      <div className="text-xs text-gray-500">{n.message}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 今日习惯 */}
          <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
            <h2 className="text-lg font-semibold text-gray-800 flex items-center gap-2 mb-4">
              <span>🍅</span> 今日专注
            </h2>
            <div className="flex items-center gap-4">
              <div className="text-center">
                <div className="text-3xl font-bold text-orange-500">{todayPomo.completed}</div>
                <div className="text-[10px] text-gray-400">番茄钟</div>
              </div>
              <div className="w-px h-10 bg-gray-200" />
              <div className="text-center">
                <div className="text-3xl font-bold text-blue-500">{todayPomo.minutes}</div>
                <div className="text-[10px] text-gray-400">分钟</div>
              </div>
              <div className="w-px h-10 bg-gray-200" />
              <button
                onClick={() => navigate('/actions')}
                className="px-3 py-1.5 bg-orange-50 text-orange-600 rounded-lg text-xs hover:bg-orange-100 transition-colors"
              >
                开始专注 →
              </button>
            </div>
          </div>

          {/* 今日习惯 */}
          <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
            <h2 className="text-lg font-semibold text-gray-800 flex items-center gap-2 mb-4">
              <span>✅</span> 今日习惯
            </h2>
            <div className="space-y-2">
              {habits.map(h => {
                const done = h.completedDates.includes(new Date().toISOString().slice(0, 10))
                return (
                  <div key={h.id} className={`flex items-center gap-2 p-2 rounded-lg ${done ? 'bg-green-50' : 'bg-gray-50'}`}>
                    <span className="text-lg">{h.emoji}</span>
                    <span className={`text-sm flex-1 ${done ? 'text-green-700 line-through' : 'text-gray-700'}`}>
                      {h.title}
                    </span>
                    {done && <Check size={16} className="text-green-500" />}
                    {!done && <span className="text-[10px] text-gray-400">待完成</span>}
                  </div>
                )
              })}
            </div>
          </div>

          {/* AI 建议 */}
          <div className="bg-gradient-to-br from-purple-50 to-blue-50 rounded-2xl p-5 shadow-sm border border-purple-100">
            <h2 className="text-lg font-semibold text-gray-800 flex items-center gap-2 mb-3">
              <span>🤖</span> AI 建议
            </h2>
            <div className="space-y-3">
              <div className="flex items-start gap-2 p-2">
                <Lightbulb size={16} className="text-purple-500 mt-0.5 flex-shrink-0" />
                <div>
                  <div className="text-sm text-gray-700">开始每日复盘</div>
                  <div className="text-xs text-gray-400">坚持复盘能帮你更快成长，今天还没写复盘笔记</div>
                </div>
              </div>
              <div className="flex items-start gap-2 p-2">
                <TrendingUp size={16} className="text-blue-500 mt-0.5 flex-shrink-0" />
                <div>
                  <div className="text-sm text-gray-700">设置学习目标</div>
                  <div className="text-xs text-gray-400">在"成长"模块中创建你的第一个学习路径</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// 任务项组件
function TaskItem({ task, onToggle }: { task: Task; onToggle: () => void }) {
  const priorityColors = {
    urgent: 'text-red-500 bg-red-50',
    high: 'text-orange-500 bg-orange-50',
    medium: 'text-blue-500 bg-blue-50',
    low: 'text-gray-400 bg-gray-100',
  }

  return (
    <div
      className={`flex items-center gap-3 p-3 rounded-xl transition-colors group cursor-pointer ${
        task.status === 'done' ? 'bg-gray-50' : 'bg-white hover:bg-gray-50'
      }`}
      onClick={onToggle}
    >
      <div
        className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
          task.status === 'done'
            ? 'bg-green-500 border-green-500'
            : 'border-gray-300 group-hover:border-gray-400'
        }`}
      >
        {task.status === 'done' && <Check size={12} className="text-white" />}
      </div>
      <span className="text-xl flex-shrink-0">{task.emoji}</span>
      <span className={`flex-1 text-sm ${task.status === 'done' ? 'text-gray-400 line-through' : 'text-gray-700'}`}>
        {task.title}
      </span>
      {task.priority === 'high' || task.priority === 'urgent' ? (
        <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${priorityColors[task.priority]}`}>
          {task.priority === 'urgent' ? '紧急' : '重要'}
        </span>
      ) : null}
      {task.dueDate && (
        <span className="flex items-center gap-1 text-[11px] text-gray-400">
          <Clock size={12} />
          {task.dueDate}
        </span>
      )}
    </div>
  )
}