import { useState, useEffect, useRef, useCallback, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store'
import { Plus, Check, Clock, AlertCircle, ChevronRight, PenLine, CloudUpload, ShieldCheck, Inbox, Trash2 } from 'lucide-react'
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

function readWorkHours() {
  try { return { ...DEFAULT_WORK_HOURS, ...(JSON.parse(localStorage.getItem(WORK_HOURS_KEY) || 'null') ?? {}) } }
  catch { return { ...DEFAULT_WORK_HOURS } }
}
/** 是否处于工作时间（工作日 + 时段区间内） */
function isWorkNow(): boolean {
  const h = readWorkHours()
  const d = new Date()
  const workdays: number[] = (h as any).workdays ?? [1, 2, 3, 4, 5]
  if (!workdays.includes(d.getDay())) return false
  const cur = d.getHours() * 60 + d.getMinutes()
  const toMin = (s: string) => { const [a, b] = s.split(':').map(Number); return a * 60 + b }
  return cur >= toMin(h.startAM) && cur <= toMin(h.endPM)
}

function ClockWork() {
  const [now, setNow] = useState(new Date())
  const [hours, setHours] = useState(readWorkHours)
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
  const workdays: number[] = (hours as any).workdays ?? [1, 2, 3, 4, 5]
  const isOffDay = !workdays.includes(now.getDay())
  const sAM = todayAt(hours.startAM), eAM = todayAt(hours.endAM), sPM = todayAt(hours.startPM), ePM = todayAt(hours.endPM)

  let target: Date | null = null
  let label = '已下班 🎉'
  if (isOffDay) { label = '今天休息 🎉' }
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
    if (isOffDay || !target || now < target) return
    const key = `${label}:${now.toDateString()}`
    if (notifiedRef.current === key) return
    notifiedRef.current = key
    if (localStorage.getItem('evan-os-offwork-notify') !== '0' && 'Notification' in window && Notification.permission === 'granted') {
      try { new Notification('Evan OS', { body: `${label} — 时间到！` }) } catch { /* ignore */ }
    }
  }, [now, target, label, isOffDay])

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
        {isOffDay || label.includes('已下班') ? (
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
  const { projects, habits, learningPaths, tasks, toggleTaskStatus, addTask, getDailyLog, getTodayPomodoroStats, toggleHabit, addHabit, updateHabit, deleteHabit, updateObject, deleteObject } = useStore()
  const navigate = useNavigate()
  const todayStr = new Date().toISOString().slice(0, 10)
  const [newTask, setNewTask] = useState('')
  const [reviewDoneToday, setReviewDoneToday] = useState(false)
  const [inboxPending, setInboxPending] = useState(0)
  const [itemDate, setItemDate] = useState(todayStr)
  const todayItems = tasks.filter(t => (t.dueDate ?? '') === itemDate && t.status !== 'cancelled')

  // 补水（上午 2 杯 + 下午 2 杯，按天记录）
  const [water, setWater] = useState(() => {
    try { const r = JSON.parse(localStorage.getItem('evan-os-water') || 'null'); if (r?.date === todayStr) return r } catch { /* ignore */ }
    return { date: todayStr, am: [false, false], pm: [false, false] }
  })
  const toggleCup = (period: 'am' | 'pm', idx: number) => {
    const next = { ...water, date: todayStr, [period]: (water as any)[period].map((v: boolean, i: number) => i === idx ? !v : v) }
    setWater(next)
    localStorage.setItem('evan-os-water', JSON.stringify(next))
  }

  // 久坐提醒（50 分钟一次，仅工作时间）
  const [sedentaryMin, setSedentaryMin] = useState(0)
  useEffect(() => {
    const tick = () => {
      const last = Number(localStorage.getItem('evan-os-sedentary-last') || Date.now())
      setSedentaryMin(Math.floor((Date.now() - last) / 60000))
      if (isWorkNow() && Date.now() - last >= 50 * 60000) {
        localStorage.setItem('evan-os-sedentary-last', String(Date.now()))
        if ('Notification' in window && Notification.permission === 'granted') {
          try { new Notification('Evan OS', { body: '久坐 50 分钟啦，起来接杯水活动一下 💧' }) } catch { /* ignore */ }
        }
      }
    }
    tick()
    const t = setInterval(tick, 30_000)
    return () => clearInterval(t)
  }, [])
  const resetSedentary = () => {
    localStorage.setItem('evan-os-sedentary-last', String(Date.now()))
    setSedentaryMin(0)
  }

  // 天气
  const [weather, setWeather] = useState<{ temp: number; desc: string; emoji: string; city: string } | null>(null)
  const [weatherError, setWeatherError] = useState('')
  const loadWeather = useCallback(async (cityOverride?: string) => {
    setWeatherError('')
    try {
      const savedCity = cityOverride ?? localStorage.getItem('evan-os-weather-city') ?? ''
      const cacheRaw = localStorage.getItem('evan-os-weather')
      if (!cityOverride && cacheRaw) {
        const cached = JSON.parse(cacheRaw)
        if (Date.now() - cached.at < 3600_000 && cached.city === savedCity) { setWeather(cached); return }
      }
      let lat = 39.9042, lon = 116.4074, city = '北京'
      if (savedCity) {
        city = savedCity
        const geo = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(savedCity)}&count=1&language=zh`).then(r => r.json()).catch(() => null)
        if (geo?.results?.[0]) { lat = geo.results[0].latitude; lon = geo.results[0].longitude }
      } else if (navigator.geolocation) {
        const pos = await new Promise<GeolocationPosition>((res, rej) =>
          navigator.geolocation.getCurrentPosition(res, rej, { timeout: 5000 })
        ).catch(() => null)
        if (pos) { lat = pos.coords.latitude; lon = pos.coords.longitude; city = '当前位置' }
      }
      const w = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`).then(r => r.json())
      const code: number = w.current_weather?.weathercode ?? 0
      const table: [number[], string, string][] = [
        [[0], '晴', '☀️'],
        [[1, 2, 3], '多云', '⛅'],
        [[45, 48], '雾', '🌫️'],
        [[51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82], '雨', '🌧️'],
        [[71, 73, 75, 77, 85, 86], '雪', '🌨️'],
        [[95, 96, 99], '雷雨', '⛈️'],
      ]
      const hit = table.find(([codes]) => codes.includes(code))
      const data = {
        temp: Math.round(w.current_weather?.temperature ?? 0),
        desc: hit?.[1] ?? '—',
        emoji: hit?.[2] ?? '🌡️',
        city,
      }
      setWeather(data)
      localStorage.setItem('evan-os-weather', JSON.stringify({ at: Date.now(), ...data }))
    } catch {
      setWeatherError('天气获取失败（检查网络或定位权限）')
    }
  }, [])
  const changeCity = () => {
    const c = prompt('输入城市名（如：上海）')
    if (c?.trim()) { localStorage.setItem('evan-os-weather-city', c.trim()); loadWeather(c.trim()) }
  }
  useEffect(() => { loadWeather() }, [loadWeather])

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
    addTask({ title: newTask.trim(), dueDate: itemDate })
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
          {/* 今日事项 */}
          <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-800 flex items-center gap-2">
                <span>📋</span> 今日事项
              </h2>
              <span className="text-xs text-gray-400 bg-gray-100 px-2 py-1 rounded-full">
                {todayItems.filter(t => t.status === 'done').length}/{todayItems.length} 完成
              </span>
            </div>

            {/* 添加事项（可指定日期，到当天才显示） */}
            <div className="flex gap-2 mb-4 flex-wrap">
              <input
                type="text"
                value={newTask}
                onChange={e => setNewTask(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAddTask()}
                placeholder="添加事项..."
                className="flex-1 min-w-[140px] px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-300 transition-all"
              />
              <input
                type="date"
                value={itemDate}
                onChange={e => setItemDate(e.target.value)}
                title="事项日期（到该日期才会出现在首页）"
                className="px-2 py-2 bg-gray-50 border border-gray-200 rounded-lg text-xs text-gray-500"
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

            {/* 事项列表 */}
            <div className="space-y-1">
              {todayItems.length === 0 && (
                <div className="text-center py-8 text-gray-400 text-sm">
                  🎉 {itemDate === todayStr ? '今天没有安排事项，享受轻松的一天！' : '该日期暂无事项'}
                </div>
              )}
              {todayItems.map(task => (
                <TaskItem
                  key={task.id}
                  task={task}
                  onToggle={() => toggleTaskStatus(task.id)}
                  onEdit={() => {
                    const title = prompt('修改事项', task.title ?? ''); if (title === null || !title.trim()) return
                    updateObject('task', task.id, { title: title.trim() })
                  }}
                  onDelete={() => {
                    if (!confirm(`删除事项「${task.title}」？`)) return
                    deleteObject('task', task.id)
                  }}
                />
              ))}
            </div>
            <p className="text-[10px] text-gray-300 mt-3">💡 切换日期可预设未来事项，到当天才会出现在这里；也可在「行动 → 日历」中按月规划</p>
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
          {/* 天气 */}
          <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold text-gray-800 flex items-center gap-2">
                <span>🌤️</span> 天气
              </h2>
              <button onClick={() => loadWeather()} className="text-[10px] text-gray-300 hover:text-gray-500">刷新</button>
            </div>
            {weather ? (
              <div className="flex items-center gap-3">
                <span className="text-4xl">{weather.emoji}</span>
                <div>
                  <div className="text-2xl font-bold text-gray-800">{weather.temp}°C</div>
                  <div className="text-xs text-gray-400">{weather.desc} · {weather.city}</div>
                </div>
              </div>
            ) : weatherError ? (
              <p className="text-xs text-gray-400">{weatherError}</p>
            ) : (
              <p className="text-xs text-gray-400">获取中…</p>
            )}
            <button onClick={changeCity} className="mt-3 text-[10px] text-gray-300 hover:text-gray-500">
              📍 {weather?.city === '当前位置' ? '设置城市名' : '更换城市'}
            </button>
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

          {/* 补水 & 久坐提醒 */}
          <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
            <h2 className="text-lg font-semibold text-gray-800 flex items-center gap-2 mb-4">
              <span>💧</span> 补水 & 久坐
            </h2>

            {isWorkNow() ? (
              <>
                <div className="flex items-center justify-between text-[11px] text-gray-400 mb-2 px-1">
                  <span>上午 ×2</span>
                  <span>下午 ×2</span>
                </div>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex gap-2">
                    {(water as any).am.map((v: boolean, i: number) => (
                      <button key={`am${i}`} onClick={() => toggleCup('am', i)}
                        title={`上午第 ${i + 1} 杯`}
                        className={`w-10 h-10 rounded-full text-base transition-colors ${v ? 'bg-sky-500 text-white' : 'bg-sky-50 text-sky-300 border border-sky-200 hover:border-sky-400'}`}>
                        💧
                      </button>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    {(water as any).pm.map((v: boolean, i: number) => (
                      <button key={`pm${i}`} onClick={() => toggleCup('pm', i)}
                        title={`下午第 ${i + 1} 杯`}
                        className={`w-10 h-10 rounded-full text-base transition-colors ${v ? 'bg-sky-500 text-white' : 'bg-sky-50 text-sky-300 border border-sky-200 hover:border-sky-400'}`}>
                        💧
                      </button>
                    ))}
                  </div>
                </div>
                <div className="text-[10px] text-gray-300 text-right">
                  今日 {(water as any).am.filter(Boolean).length + (water as any).pm.filter(Boolean).length} / 4 杯
                </div>
              </>
            ) : (
              <p className="text-xs text-gray-400">当前非工作时间，提醒已暂停</p>
            )}

            <div className="mt-3 pt-3 border-t border-gray-100 flex items-center justify-between text-xs">
              <span className="text-gray-500">🪑 久坐 {sedentaryMin} 分钟</span>
              <button onClick={resetSedentary} className="px-2 py-1 bg-gray-100 rounded-lg text-[10px] text-gray-500 hover:bg-gray-200">
                刚活动过
              </button>
            </div>
            <p className="text-[10px] text-gray-300 mt-1.5">工作时间外不提醒 · 久坐每 50 分钟桌面弹窗</p>
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
                const openTasks = todayItems.filter(t => t.status !== 'done').length
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