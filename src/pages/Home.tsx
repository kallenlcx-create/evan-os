import { useState, useEffect, useRef, useCallback, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store'
import { Plus, Check, Clock, AlertCircle, ChevronRight, PenLine, CloudUpload, ShieldCheck, Inbox, Trash2 } from 'lucide-react'
import { db } from '../db'
import { cloudSync, getSyncConfig } from '../services/cloudSync'
import { readWorkHours, isWorkNow, isWorkDay, isoWeekNumber } from '../config/workHours'
import { pickDaily, RECIPES, fetchRecipeTutorial, pickDailyHotspots } from '../config/dailyContent'
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

function ClockWork() {
  const [now, setNow] = useState(new Date())
  const [hours, setHours] = useState(readWorkHours)
  const notifiedRef = useRef('')

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    const reload = () => setHours(readWorkHours())
    window.addEventListener('evan-work-hours', reload)
    window.addEventListener('storage', reload)
    return () => {
      clearInterval(t)
      window.removeEventListener('evan-work-hours', reload)
      window.removeEventListener('storage', reload)
    }
  }, [])

  const localTime = now.toLocaleTimeString('zh-CN', { hour12: false })
  const fmtTz = (tz: string) => new Intl.DateTimeFormat('zh-CN', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(now)
  const zones = [
    { flag: '🇺🇸', label: '美东', tz: 'America/New_York' },
    { flag: '🇺🇸', label: '中部', tz: 'America/Chicago' },
    { flag: '🇺🇸', label: '山区', tz: 'America/Denver' },
    { flag: '🇺🇸', label: '太平洋', tz: 'America/Los_Angeles' },
  ]

  const todayAt = (s: string) => { const [h, m] = s.split(':').map(Number); const d = new Date(); d.setHours(h, m, 0, 0); return d }
  const workdays: number[] = (hours as any).workdays ?? [1, 2, 3, 4, 5]
  const isOffDay = !workdays.includes(now.getDay())
  const scheduleNote = hours.schedule === 'alternating'
    ? (isoWeekNumber(now) % 2 === 0 ? '本周双休' : '本周单休')
    : ''
  const sAM = todayAt(hours.startAM), eAM = todayAt(hours.endAM), sPM = todayAt(hours.startPM), ePM = todayAt(hours.endPM)

  let target: Date | null = null
  let label = '已下班 🎉'
  if (isOffDay) { label = '今天休息 🎉' }
  else if (now < sAM) { target = sAM; label = '距离上班' }
  else if (now < eAM) { target = eAM; label = '距离上午下班' }
  else if (now < sPM) { target = sPM; label = '距离下午上班' }
  else if (now < ePM) { target = ePM; label = '距离下班' }

  let cd = ''
  let cdPct = 0
  if (target && now < target) {
    const diff = target.getTime() - now.getTime()
    const h = Math.floor(diff / 3.6e6)
    const m = Math.floor((diff % 3.6e6) / 6e4)
    const s = Math.floor((diff % 6e4) / 1000)
    cd = [h > 0 ? h + '小时' : '', m + '分', s + '秒'].filter(Boolean).join('')
    const dayStart = todayAt(hours.startAM).getTime()
    cdPct = Math.min(100, Math.round(((now.getTime() - dayStart) / (target.getTime() - dayStart)) * 100))
  }

  // 跨过节点 → 桌面通知
  useEffect(() => {
    if (isOffDay || !target || now < target) return
    const key = label + ':' + now.toDateString()
    if (notifiedRef.current === key) return
    notifiedRef.current = key
    if (localStorage.getItem('evan-os-offwork-notify') !== '0' && 'Notification' in window && Notification.permission === 'granted') {
      try { new Notification('Evan OS', { body: label + ' — 时间到！' }) } catch (e) { /* ignore */ }
    }
  }, [now, target, label, isOffDay])

  const isResting = isOffDay || label.includes('已下班') || label.includes('休息')
  const cardBg = isResting
    ? 'bg-gradient-to-br from-emerald-50 to-teal-50 border-emerald-100'
    : 'bg-gradient-to-br from-orange-50 to-amber-50 border-amber-100'

  return (
    <div className={`rounded-2xl px-4 py-2.5 shadow-sm border relative overflow-hidden ${cardBg}`}>
      <div className="absolute top-0 right-0 w-16 h-16 bg-white/30 rounded-bl-full pointer-events-none" />
      <div className="absolute bottom-0 left-0 w-10 h-10 bg-white/20 rounded-tr-full pointer-events-none" />
      <div className="flex items-center justify-between gap-3 relative">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-xs text-indigo-400 font-medium">🕐 {localTime}</span>
            <span className="text-[10px] text-gray-300">{now.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', weekday: 'short' })}</span>
          </div>
          {isResting ? (
            <div className="text-base font-bold text-emerald-500">{label}</div>
          ) : (
            <div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-gray-400">{label}</span>
                <span className="text-base font-bold text-amber-600 tabular-nums">{cd}</span>
              </div>
              {cdPct > 0 && (
                <div className="mt-1 w-full h-1.5 bg-white/50 rounded-full overflow-hidden">
                  <div className="h-full bg-amber-400 rounded-full transition-all" style={{ width: cdPct + '%' }} />
                </div>
              )}
            </div>
          )}
          <div className="text-[10px] text-gray-300 mt-0.5">
            {hours.startAM}–{hours.endAM} · {hours.startPM}–{hours.endPM}
            {scheduleNote && <span className="ml-1 text-purple-400">· {scheduleNote}</span>}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[10px] text-indigo-300 font-medium mb-0.5">🇺🇸</div>
          <div className="space-y-0.5">
            {zones.map(z => (
              <div key={z.tz} className="flex items-center justify-end gap-1.5 text-[11px]">
                <span className="text-gray-400 w-8">{z.label}</span>
                <span className="font-mono text-gray-600 tabular-nums bg-white/50 px-1.5 py-0.5 rounded">{fmtTz(z.tz)}</span>
              </div>
            ))}
          </div>
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
  const todayItems = tasks.filter(t => {
    if (t.status === 'cancelled' || t.status === 'done') return false
    if (t.isRecurring) return true
    if (!t.dueDate) return true
    return t.dueDate <= todayStr
  })

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

  // 今日食谱（按日轮换选 2 道 + AI 教程接口预留）
  const dayIdx = Math.floor(Date.now() / 86400000)
  const todayRecipe = RECIPES[dayIdx % RECIPES.length]
  const todayRecipe2 = RECIPES[(dayIdx + Math.floor(RECIPES.length / 2)) % RECIPES.length]
  const [showRecipe, setShowRecipe] = useState(false)
  const [recipeTutorialIdx, setRecipeTutorialIdx] = useState(0)
  const [tutorial, setTutorial] = useState<{ title: string; detail: string[] }>({ title: '', detail: [] })
  const toggleTutorial = async () => {
    const r = recipeTutorialIdx === 0 ? todayRecipe : todayRecipe2
    if (!showRecipe && tutorial.title === '') {
      const t = await fetchRecipeTutorial(r)
      setTutorial(t)
    }
    setShowRecipe(v => !v)
  }

  // AI 热点（每日轮换 + AI 接口预留）
  const [aiHotspots] = useState(() => pickDailyHotspots())

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
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">🏠 首页</h1>
          <p className="text-sm text-gray-400 mt-0.5">
            {new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}
          </p>
        </div>
        {/* 补水 & 久坐 */}
        <div className="flex items-center gap-3 bg-white rounded-xl px-4 py-2 shadow-sm border border-gray-100">
          <div className="flex items-center gap-1.5">
            {(water as any).am.map((v: boolean, i: number) => (
              <button key={`am${i}`} onClick={() => toggleCup('am', i)}
                title={`上午第 ${i + 1} 杯`}
                className={`w-7 h-7 rounded-full text-xs transition-colors ${v ? 'bg-sky-500 text-white' : 'bg-sky-50 text-sky-300 border border-sky-200 hover:border-sky-400'}`}>
                💧
              </button>
            ))}
            {(water as any).pm.map((v: boolean, i: number) => (
              <button key={`pm${i}`} onClick={() => toggleCup('pm', i)}
                title={`下午第 ${i + 1} 杯`}
                className={`w-7 h-7 rounded-full text-xs transition-colors ${v ? 'bg-sky-500 text-white' : 'bg-sky-50 text-sky-300 border border-sky-200 hover:border-sky-400'}`}>
                💧
              </button>
            ))}
          </div>
          <div className="text-[10px] text-gray-400 border-l border-gray-100 pl-3">
            <span className="text-sky-500 font-medium">{(water as any).am.filter(Boolean).length + (water as any).pm.filter(Boolean).length}</span>/4 杯
            {isWorkNow() && <span className="ml-2 text-gray-300">🪑 {sedentaryMin}分</span>}
          </div>
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
                {todayItems.length} 项
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

        {/* 右列：天气 + 食谱 + AI 热点 */}
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

          {/* 今日食谱（2道菜） */}
          <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold text-gray-800 flex items-center gap-2">
                <span>🍳</span> 今日食谱
              </h2>
              <span className="text-[10px] text-gray-300">每天两道 · 按日轮换</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {[todayRecipe, todayRecipe2].map((r, ri) => (
                <div key={ri} className="bg-orange-50/50 border border-orange-100 rounded-xl p-3">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-xl">{r.emoji}</span>
                    <span className="text-xs font-bold text-gray-700 truncate">{r.name}</span>
                  </div>
                  <div className="text-[10px] text-gray-400 truncate mb-1">{r.ingredients.join('、')}</div>
                  <div className="flex items-center justify-between">
                    <span className="text-[9px] text-gray-300">⏱ {r.minutes}min</span>
                    <button
                      onClick={() => { setRecipeTutorialIdx(ri); setShowRecipe(v => !v) }}
                      className="text-[10px] text-orange-400 hover:text-orange-600"
                    >
                      教程 →
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {showRecipe && (
              <div className="mt-3 bg-orange-50/60 border border-orange-100 rounded-xl p-3 space-y-1">
                {tutorial.detail.map((line, i) => (
                  <p key={i} className="text-[11px] text-gray-600">{line}</p>
                ))}
                <p className="text-[9px] text-gray-300 pt-1">🤖 AI 图文教程接口预留中</p>
              </div>
            )}
          </div>

          {/* AI 热点 */}
          <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold text-gray-800 flex items-center gap-2">
                <span>🤖</span> AI 热点
              </h2>
              <button onClick={() => navigate('/ai-lab')} className="text-[10px] text-purple-400 hover:text-purple-600">
                去实验室筛选 →
              </button>
            </div>
            <div className="space-y-2">
              {aiHotspots.map((h, i) => (
                <div key={i} className="p-2 bg-gray-50 rounded-lg">
                  <div className="text-xs font-medium text-gray-700">{h.title}</div>
                  <div className="text-[10px] text-gray-400 line-clamp-2 mt-0.5">{h.summary}</div>
                  <span className="text-[9px] text-gray-300">{h.source}</span>
                </div>
              ))}
            </div>
            <p className="text-[10px] text-gray-200 mt-2">每日轮换 · AI 接口预留中，接入后为实时热点</p>
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
                const openTasks = todayItems.length
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