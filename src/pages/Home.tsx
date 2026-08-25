import { useState, useEffect, useRef, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store'
import { Plus, Check, Clock, AlertCircle, ChevronRight, PenLine, CloudUpload, ShieldCheck, Inbox } from 'lucide-react'
import { db } from '../db'
import { cloudSync, getSyncConfig } from '../services/cloudSync'
import type { Task } from '../types'

// ====== 状态聚合条（登录 / 审批 / 收集 / 同步 / 备份）======
function StatusStrip() {
  const navigate = useNavigate()
  const { backupNeeded } = useStore()
  const [pendingApprovals, setPendingApprovals] = useState(0)
  const [pendingInbox, setPendingInbox] = useState(0)
  const [syncInfo, setSyncInfo] = useState<{ loggedIn: boolean; username?: string; auto: boolean; last?: string } | null>(null)

  useEffect(() => {
    ;(async () => {
      try { setPendingApprovals(await db.approvals.where('status').equals('pending').count()) } catch {}
      try { setPendingInbox(await db.inbox.filter(i => !i.processed).count()) } catch {}
      try {
        const cfg = await getSyncConfig()
        if (cfg?.serverUrl) {
          setSyncInfo({ loggedIn: !!cfg.token, username: cfg.username, auto: !!cfg.autoSync, last: cfg.lastSyncAt })
        } else {
          setSyncInfo({ loggedIn: false, auto: false })
        }
      } catch {}
    })()
  }, [])

  const tiles: { key: string; emoji: string; label: string; cls: string; path: string; extra?: string }[] = []
  if (syncInfo) {
    tiles.push(syncInfo.loggedIn
      ? { key: 'sync', emoji: '☁️', label: `已登录 · ${syncInfo.username}`, cls: 'bg-green-50 border-green-200 text-green-700', path: '/sync', extra: syncInfo.auto ? '自动' : '手动' }
      : { key: 'sync', emoji: '☁️', label: '未登录', cls: 'bg-amber-50 border-amber-200 text-amber-700', path: '/sync', extra: '' })
  } else {
    tiles.push({ key: 'sync', emoji: '☁️', label: '未配置同步', cls: 'bg-white border-gray-200 text-gray-400', path: '/sync', extra: '' })
  }
  if (pendingApprovals > 0) tiles.push({ key: 'approvals', emoji: '🛡️', label: `待审批 ${pendingApprovals}`, cls: 'bg-amber-50 border-amber-200 text-amber-700', path: '/agents', extra: '' })
  if (pendingInbox > 0) tiles.push({ key: 'inbox', emoji: '📥', label: `收集 ${pendingInbox}`, cls: 'bg-sky-50 border-sky-200 text-sky-700', path: '/inbox', extra: '' })
  if (backupNeeded) tiles.push({ key: 'backup', emoji: '🛡️', label: '该备份了', cls: 'bg-amber-50 border-amber-200 text-amber-700', path: '/settings', extra: '' })

  return (
    <div className="flex items-center gap-2 mb-4 overflow-x-auto">
      {tiles.map(t => (
        <button key={t.key} onClick={() => navigate(t.path)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs whitespace-nowrap ${t.cls}`}>
          <span>{t.emoji}</span> {t.label}
          {t.extra && <span className="text-[9px] opacity-70">{t.extra}</span>}
        </button>
      ))}
    </div>
  )
}

// ====== 时钟 + 美国时区 + 下班倒计时 ======
const WORK_HOURS_KEY = 'evan-os-work-hours'
const DEFAULT_WORK_HOURS = { startAM: '09:00', endAM: '12:00', startPM: '13:30', endPM: '18:00' }

function ClockWork() {
  const [now, setNow] = useState(new Date())
  const [hours, setHours] = useState(() => {
    try { return { ...DEFAULT_WORK_HOURS, ...(JSON.parse(localStorage.getItem(WORK_HOURS_KEY) || 'null') ?? {}) } }
    catch { return DEFAULT_WORK_HOURS }
  })
  const notifiedRef = useRef('')

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    const reload = () => {
      try { setHours({ ...DEFAULT_WORK_HOURS, ...(JSON.parse(localStorage.getItem(WORK_HOURS_KEY) || 'null') ?? {}) }) }
      catch { /* ignore */ }
    }
    window.addEventListener('evan-work-hours', reload)
    window.addEventListener('storage', reload)
    return () => { clearInterval(t); window.removeEventListener('evan-work-hours', reload); window.removeEventListener('storage', reload) }
  }, [])

  const localTime = now.toLocaleTimeString('zh-CN', { hour12: false })
  const fmtTz = (tz: string) => new Intl.DateTimeFormat('zh-CN', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(now)
  const zones = [
    { label: '美东 ET', tz: 'America/New_York' },
    { label: '中部 CT', tz: 'America/Chicago' },
    { label: '山区 MT', tz: 'America/Denver' },
    { label: '太平洋 PT', tz: 'America/Los_Angeles' },
  ]

  const todayAt = (s: string) => { const [h, m] = s.split(':').map(Number); const d = new Date(); d.setHours(h, m, 0, 0); return d }
  const isWeekend = now.getDay() === 0 || now.getDay() === 6
  const sAM = todayAt(hours.startAM), eAM = todayAt(hours.endAM), sPM = todayAt(hours.startPM), ePM = todayAt(hours.endPM)

  let target: Date | null = null
  let label = '已下班 🎉'
  if (isWeekend) { label = '周末休息 🎉' }
  else if (now < sAM) { target = sAM; label = '距离上班' }
  else if (now < eAM) { target = eAM; label = '距离上午下班' }
  else if (now < sPM) { target = sPM; label = '距离下午上班' }
  else if (now < ePM) { target = ePM; label = '距离下班' }

  let cd = ''
  if (target && now < target) {
    const diff = target.getTime() - now.getTime()
    const h = Math.floor(diff / 3.6e6)
    const m = Math.floor((diff % 3.6e6) / 6e4)
    const s = Math.floor((diff % 6e4) / 1000)
    cd = `${h ? `${h}小时` : ''}${m}分${s}秒`
  }

  // 跨过下班/上班节点 → 桌面通知（每天每节点一次）
  useEffect(() => {
    if (isWeekend || !target || now < target) return
    const key = `${label}:${now.toDateString()}`
    if (notifiedRef.current === key) return
    notifiedRef.current = key
    if (localStorage.getItem('evan-os-offwork-notify') !== '0' && 'Notification' in window && Notification.permission === 'granted') {
      try { new Notification('Evan OS', { body: `${label} — 时间到！` }) } catch { /* ignore */ }
    }
  }, [now, target, label, isWeekend])

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
        <div className="text-[10px] text-gray-400 mb-1">🕐 本地时间</div>
        <div className="text-2xl font-bold text-gray-800 tabular-nums">{localTime}</div>
        <div className="text-[10px] text-gray-300">{now.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}</div>
      </div>
      <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
        <div className="text-[10px] text-gray-400 mb-1.5">🇺🇸 美国时间</div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          {zones.map(z => (
            <div key={z.tz} className="flex items-center justify-between text-[11px] gap-1">
              <span className="text-gray-400 whitespace-nowrap">{z.label}</span>
              <span className="font-mono text-gray-700 tabular-nums">{fmtTz(z.tz)}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="col-span-2 bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
        <div className="text-[10px] text-gray-400 mb-1">💼 工作状态</div>
        {isWeekend || label.includes('已下班') ? (
          <div className="text-xl font-bold text-emerald-500">{label}</div>
        ) : (
          <>
            <div className="text-[10px] text-gray-400">{label}</div>
            <div className="text-2xl font-bold text-gray-800 tabular-nums">{cd}</div>
          </>
        )}
        <div className="text-[10px] text-gray-300 mt-1">
          {hours.startAM}-{hours.endAM} · {hours.startPM}-{hours.endPM}
          <span className="ml-1 text-gray-200">（设置 → 外观可改）</span>
        </div>
      </div>
    </div>
  )
}

export default function HomePage() {
  const { projects, habits, learningPaths, getTodayTasks, getUnreadNotifications, toggleTaskStatus, addTask, getDailyLog, getTodayPomodoroStats, toggleHabit, markNotificationRead, setNotificationPanel, updateObject, deleteObject } = useStore()
  const navigate = useNavigate()
  const [newTask, setNewTask] = useState('')
  const [reviewDoneToday, setReviewDoneToday] = useState(false)
  const [inboxPending, setInboxPending] = useState(0)
  const todayTasks = getTodayTasks()
  const unreadNotifs = getUnreadNotifications()

  const todayStr = new Date().toISOString().slice(0, 10)
  const todayLog = getDailyLog(todayStr)
  const todayPomo = getTodayPomodoroStats()

  // AI 建议数据源：复盘状态 + 收集箱
  useEffect(() => {
    ;(async () => {
      try {
        const n = await db.reviews.where('period').equals(todayStr).count()
        setReviewDoneToday(n > 0)
      } catch {}
      try { setInboxPending(await db.inbox.filter(i => !i.processed).count()) } catch {}
    })()
  }, [todayStr])

  const handleAddTask = () => {
    if (!newTask.trim()) return
    addTask({ title: newTask.trim() })
    setNewTask('')
  }

  const inProgressProjects = projects.filter(p => p.status === 'in_progress')

  return (
    <div className="space-y-6">
      <StatusStrip />
      <ClockWork />
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
                <TaskItem
                  key={task.id}
                  task={task}
                  onToggle={() => toggleTaskStatus(task.id)}
                  onEdit={() => {
                    const title = prompt('修改任务', task.title ?? ''); if (title === null || !title.trim()) return
                    updateObject('task', task.id, { title: title.trim() })
                  }}
                  onDelete={() => {
                    if (!confirm(`删除任务「${task.title}」？`)) return
                    deleteObject('task', task.id)
                  }}
                />
              ))}
            </div>
          </div>

          {/* 进行中的项目 */}
          <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-800 flex items-center gap-2">
                <span>🚀</span> 进行中的项目
              </h2>
              <button onClick={() => navigate('/projects')} className="text-xs text-blue-600 hover:text-blue-700 flex items-center gap-1">
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
                  <button
                    key={n.id}
                    onClick={() => { markNotificationRead(n.id); setNotificationPanel(true) }}
                    className="w-full text-left flex items-start gap-2 p-2 bg-orange-50 rounded-lg hover:bg-orange-100 transition-colors"
                  >
                    <AlertCircle size={16} className="text-orange-500 mt-0.5 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-800">{n.title}</div>
                      <div className="text-xs text-gray-500 line-clamp-1">{n.message}</div>
                    </div>
                  </button>
                ))}
                {unreadNotifs.length > 5 && (
                  <button onClick={() => setNotificationPanel(true)} className="text-[11px] text-gray-400 hover:text-gray-600">
                    还有 {unreadNotifs.length - 5} 条 → 打开通知中心
                  </button>
                )}
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
              {habits.length === 0 && (
                <div className="text-center py-4 text-gray-400 text-sm">
                  还没有习惯 —— 到「生活」页添加
                </div>
              )}
              {habits.map(h => {
                const done = h.completedDates.includes(todayStr)
                return (
                  <div key={h.id} className={`flex items-center gap-2 p-2 rounded-lg ${done ? 'bg-green-50' : 'bg-gray-50'}`}>
                    <span className="text-lg">{h.emoji}</span>
                    <span className={`text-sm flex-1 ${done ? 'text-green-700 line-through' : 'text-gray-700'}`}>
                      {h.title}
                    </span>
                    <button
                      onClick={() => toggleHabit(h.id, todayStr)}
                      title={done ? '取消打卡' : '打卡'}
                      className={`w-7 h-7 rounded-full flex items-center justify-center text-xs transition-colors ${
                        done ? 'bg-green-500 text-white' : 'border-2 border-gray-300 text-gray-300 hover:border-green-400 hover:text-green-400'
                      }`}
                    >
                      {done ? <Check size={14} /> : '打卡'}
                    </button>
                  </div>
                )
              })}
            </div>
          </div>

          {/* AI 建议（基于真实状态动态生成） */}
          <div className="bg-gradient-to-br from-purple-50 to-blue-50 rounded-2xl p-5 shadow-sm border border-purple-100">
            <h2 className="text-lg font-semibold text-gray-800 flex items-center gap-2 mb-3">
              <span>🤖</span> AI 建议
            </h2>
            <div className="space-y-1">
              {(() => {
                const tips: { emoji: string; title: string; desc: string; path: string }[] = []
                if (!reviewDoneToday) {
                  tips.push({ emoji: '📝', title: '开始今日复盘', desc: '今天还没写复盘——复盘助手可以帮你起草', path: '/actions' })
                }
                if (inboxPending > 0) {
                  tips.push({ emoji: '📥', title: `整理收件箱（${inboxPending} 条）`, desc: '有未分拣的收集内容，转成任务或知识', path: '/inbox' })
                }
                if (learningPaths.length === 0) {
                  tips.push({ emoji: '📚', title: '设置学习目标', desc: '在成长模块创建你的第一个学习路径', path: '/growth' })
                }
                const openTasks = todayTasks.filter(t => t.status !== 'done').length
                if (openTasks > 0) {
                  tips.push({ emoji: '⏰', title: `还有 ${openTasks} 个今日任务`, desc: '完成它们，然后好好休息', path: '/actions' })
                }
                if (tips.length === 0) {
                  tips.push({ emoji: '🎉', title: '今天全部搞定', desc: '复盘已写、收件箱已清、任务已完成', path: '/stats' })
                }
                return tips.slice(0, 3).map((t, i) => (
                  <button
                    key={i}
                    onClick={() => navigate(t.path)}
                    className="w-full text-left flex items-start gap-2 p-2 rounded-lg hover:bg-white/70 transition-colors"
                  >
                    <span className="mt-0.5">{t.emoji}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-gray-700">{t.title}</div>
                      <div className="text-xs text-gray-400">{t.desc}</div>
                    </div>
                    <ChevronRight size={14} className="text-gray-300 mt-1" />
                  </button>
                ))
              })()}
            </div>
            <button
              onClick={() => navigate('/agents')}
              className="mt-3 w-full flex items-center justify-center gap-1.5 py-1.5 bg-white/70 border border-purple-100 rounded-lg text-[11px] text-purple-600 hover:bg-white"
            >
              🤖 让智能体帮我整理 → Agents
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// 任务项组件
function TaskItem({ task, onToggle, onEdit, onDelete }: { task: Task; onToggle: () => void; onEdit: () => void; onDelete: () => void }) {
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
      <button
        onClick={(e) => { e.stopPropagation(); onEdit() }}
        className="p-1 text-gray-200 hover:text-blue-500 transition-colors"
        title="编辑"
      >
        <PenLine size={13} />
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete() }}
        className="p-1 text-gray-200 hover:text-red-500 transition-colors"
        title="删除"
      >
        🗑
      </button>
    </div>
  )
}