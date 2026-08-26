import { useState } from 'react'
import { useStore } from '../store'
import { Download, Upload, Trash2, Database, RotateCw, Check, AlertCircle, Bell, Palette, Info, BellOff } from 'lucide-react'
import { WALLPAPER_PRESETS, DEFAULT_WALLPAPER, getPresetCss, fileToWallpaperDataUrl } from '../config/wallpapers'

export default function SettingsPage() {
  const { app, toggleSidebar, backup, exportData, importData, goals, tasks, projects, knowledge, habits, learningPaths, notifications, markNotificationRead, markAllNotificationsRead, clearNotifications, wallpaper, setWallpaper } = useStore()
  const [status, setStatus] = useState<{ type: 'success' | 'error' | ''; msg: string }>({ type: '', msg: '' })
  const [importing, setImporting] = useState(false)
  const [pomodoroMin, setPomodoroMin] = useState(() => Number(localStorage.getItem('evan-os-pomodoro-min') || 25))
  const [workHours, setWorkHoursState] = useState(() => {
    const defaults = { startAM: '09:00', endAM: '12:00', startPM: '13:30', endPM: '18:00' }
    try { return { ...defaults, ...(JSON.parse(localStorage.getItem('evan-os-work-hours') || 'null') ?? {}) } }
    catch { return defaults }
  })
  const [activeSection, setActiveSection] = useState('data')

  const stats = {
    goals: goals.length,
    projects: projects.length,
    tasks: tasks.length,
    knowledge: knowledge.length,
    habits: habits.length,
    learningPaths: learningPaths.length,
    notifications: notifications.length,
  }
  const totalObjects = Object.values(stats).reduce((a, b) => a + b, 0)

  const showMsg = (type: 'success' | 'error', msg: string) => {
    setStatus({ type, msg })
    setTimeout(() => setStatus({ type: '', msg: '' }), 3000)
  }

  const handleBackup = async () => { try { await backup(); showMsg('success', '备份已下载到本地') } catch { showMsg('error', '备份失败') } }
  const handleExport = async () => {
    try {
      const json = await exportData()
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `evan-os-export-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url)
      showMsg('success', '导出成功')
    } catch { showMsg('error', '导出失败') }
  }
  const handleImport = async () => {
    const input = document.createElement('input')
    input.type = 'file'; input.accept = '.json'
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (!file) return
      setImporting(true)
      try { const text = await file.text(); await importData(text); showMsg('success', '导入成功，数据已加载') }
      catch { showMsg('error', '导入失败，请检查文件格式') }
      setImporting(false)
    }
    input.click()
  }
  const handleReset = async () => {
    if (!window.confirm('确定要清空所有数据吗？此操作不可撤销！')) return
    if (!window.confirm('再次确认：所有目标、项目、任务、知识、习惯等数据将被永久删除！')) return
    try { const { clearDatabase } = await import('../db'); await clearDatabase(); window.location.reload() }
    catch { showMsg('error', '重置失败') }
  }

  const sections = [
    { key: 'data', label: '数据管理', icon: Database },
    { key: 'notifications', label: '通知中心', icon: Bell },
    { key: 'appearance', label: '外观偏好', icon: Palette },
    { key: 'about', label: '关于', icon: Info },
  ]

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-800">⚙️ 设置</h1>

      {status.type && (
        <div className={`flex items-center gap-2 px-4 py-3 rounded-lg text-sm font-medium ${
          status.type === 'success' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
        }`}>
          {status.type === 'success' ? <Check size={16} /> : <AlertCircle size={16} />}
          {status.msg}
        </div>
      )}

      {/* Tab 切换 */}
      <div className="flex gap-2 flex-wrap">
        {sections.map(s => (
          <button
            key={s.key}
            onClick={() => setActiveSection(s.key)}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm transition-colors ${
              activeSection === s.key ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
            }`}
          >
            <s.icon size={16} />
            {s.label}
          </button>
        ))}
      </div>

      {/* 数据管理 */}
      {activeSection === 'data' && (
        <div className="space-y-4">
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-4 flex items-center gap-2">
              <Database size={16} /> 数据库概况
            </h2>
            <div className="grid grid-cols-4 gap-4 mb-4">
              {[
                { label: '目标', val: stats.goals, color: 'blue' },
                { label: '项目', val: stats.projects, color: 'purple' },
                { label: '任务', val: stats.tasks, color: 'green' },
                { label: '知识', val: stats.knowledge, color: 'orange' },
              ].map(s => (
                <div key={s.label} className={`bg-${s.color}-50 rounded-lg p-3 text-center`}>
                  <div className={`text-2xl font-bold text-${s.color}-700`}>{s.val}</div>
                  <div className={`text-xs text-${s.color}-500 mt-1`}>{s.label}</div>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-4 gap-4">
              <div className="bg-gray-50 rounded-lg p-3 text-center">
                <div className="text-xl font-bold text-gray-600">{stats.habits}</div>
                <div className="text-xs text-gray-400 mt-1">习惯</div>
              </div>
              <div className="bg-gray-50 rounded-lg p-3 text-center">
                <div className="text-xl font-bold text-gray-600">{stats.learningPaths}</div>
                <div className="text-xs text-gray-400 mt-1">学习路径</div>
              </div>
              <div className="bg-gray-50 rounded-lg p-3 text-center">
                <div className="text-xl font-bold text-gray-600">{stats.notifications}</div>
                <div className="text-xs text-gray-400 mt-1">通知</div>
              </div>
              <div className="bg-gray-50 rounded-lg p-3 text-center">
                <div className="text-xl font-bold text-gray-600">{totalObjects}</div>
                <div className="text-xs text-gray-400 mt-1">总计</div>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-4">数据操作</h2>
            <div className="grid grid-cols-2 gap-4">
              <button onClick={handleBackup} className="flex items-center gap-3 px-4 py-3 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-lg transition-colors">
                <Download size={20} />
                <div className="text-left"><div className="font-medium">📥 自动备份</div><div className="text-xs text-blue-500">导出 JSON 到下载文件夹</div></div>
              </button>
              <button onClick={handleExport} className="flex items-center gap-3 px-4 py-3 bg-green-50 hover:bg-green-100 text-green-700 rounded-lg transition-colors">
                <Upload size={20} />
                <div className="text-left"><div className="font-medium">📤 导出数据</div><div className="text-xs text-green-500">选择保存位置</div></div>
              </button>
              <button onClick={handleImport} disabled={importing} className="flex items-center gap-3 px-4 py-3 bg-purple-50 hover:bg-purple-100 text-purple-700 rounded-lg transition-colors disabled:opacity-50">
                <RotateCw size={20} className={importing ? 'animate-spin' : ''} />
                <div className="text-left"><div className="font-medium">📥 导入数据</div><div className="text-xs text-purple-500">从 JSON 文件恢复</div></div>
              </button>
              <button onClick={handleReset} className="flex items-center gap-3 px-4 py-3 bg-red-50 hover:bg-red-100 text-red-700 rounded-lg transition-colors">
                <Trash2 size={20} />
                <div className="text-left"><div className="font-medium">🗑️ 重置数据</div><div className="text-xs text-red-500">清空所有数据（不可恢复）</div></div>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 通知中心 */}
      {activeSection === 'notifications' && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-2">
              <Bell size={16} /> 通知列表
            </h2>
            {notifications.length > 0 && (
              <div className="flex gap-3">
                <button onClick={markAllNotificationsRead} className="text-xs text-blue-600 hover:text-blue-700">
                  全部已读
                </button>
                <button onClick={() => { if (window.confirm('清空所有通知？')) clearNotifications() }} className="text-xs text-red-500 hover:text-red-600">
                  清空
                </button>
              </div>
            )}
          </div>
          {notifications.length === 0 ? (
            <div className="text-center py-12">
              <BellOff size={32} className="mx-auto text-gray-300 mb-3" />
              <p className="text-gray-400 text-sm">暂无通知</p>
            </div>
          ) : (
            <div className="space-y-2">
              {notifications.map(n => (
                <div key={n.id} className={`flex items-start gap-3 p-3 rounded-lg ${n.read ? 'bg-gray-50' : 'bg-orange-50'}`}>
                  <span className="text-lg flex-shrink-0">{n.type === 'reminder' ? '⏰' : n.type === 'ai_suggestion' ? '🤖' : '🔔'}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-800">{n.title}</div>
                    <div className="text-xs text-gray-500 mt-0.5">{n.message}</div>
                    <div className="text-[10px] text-gray-400 mt-1">{new Date(n.createdAt).toLocaleString('zh-CN')}</div>
                  </div>
                  {!n.read && (
                    <button onClick={() => markNotificationRead(n.id)} className="text-xs text-blue-600 hover:text-blue-700 flex-shrink-0">
                      标记已读
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 外观偏好 */}
      {activeSection === 'appearance' && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-5">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-2">
            <Palette size={16} /> 外观偏好
          </h2>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium text-gray-700 block mb-2">侧边栏默认状态</label>
              <div className="flex gap-2">
                <button
                  onClick={() => { if (app.sidebarCollapsed) toggleSidebar() }}
                  className={`px-4 py-2 rounded-lg text-sm border ${!app.sidebarCollapsed ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-gray-50 text-gray-500 border-gray-200'}`}
                >
                  展开
                </button>
                <button
                  onClick={() => { if (!app.sidebarCollapsed) toggleSidebar() }}
                  className={`px-4 py-2 rounded-lg text-sm border ${app.sidebarCollapsed ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-gray-50 text-gray-500 border-gray-200'}`}
                >
                  折叠
                </button>
              </div>
            </div>
            <div>
              <label className="text-sm font-medium text-gray-700 block mb-2">番茄钟时长（分钟）</label>
              <div className="flex gap-2">
                {[15, 25, 30, 45, 50].map(m => (
                  <button
                    key={m}
                    onClick={() => {
                      localStorage.setItem('evan-os-pomodoro-min', String(m))
                      window.dispatchEvent(new Event('evan-pomodoro-min'))
                      setPomodoroMin(m)
                    }}
                    className={`px-3 py-1.5 rounded-lg text-sm border ${pomodoroMin === m ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-sm font-medium text-gray-700 block mb-2">首页显示模块</label>
              <div className="grid grid-cols-2 gap-2">
                {['今日重点', '进行中项目', '今日专注', '今日习惯', '重要提醒', 'AI 建议'].map(m => (
                  <label key={m} className="flex items-center gap-2 text-sm text-gray-600">
                    <input type="checkbox" defaultChecked className="rounded text-blue-600" />
                    {m}
                  </label>
                ))}
              </div>
            </div>

            {/* ====== 壁纸 ====== */}
            <div className="pt-4 border-t border-gray-100">
              <label className="text-sm font-medium text-gray-700 block mb-3">主题</label>
              <div className="flex gap-2 mb-1">
                {([
                  { key: 'light', label: '☀️ 浅色' },
                  { key: 'dark', label: '🌙 深色' },
                  { key: 'auto', label: '🌗 跟随系统' },
                ] as const).map(t => (
                  <button
                    key={t.key}
                    onClick={() => {
                      localStorage.setItem('evan-os-theme', t.key)
                      const dark = t.key === 'dark' || (t.key === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)
                      document.documentElement.classList.toggle('dark', dark)
                      window.dispatchEvent(new CustomEvent('evan-theme-change'))
                    }}
                    className={`px-4 py-2 rounded-lg text-sm border ${
                      (() => {
                        const cur = localStorage.getItem('evan-os-theme') ?? 'auto'
                        return cur === t.key ? 'bg-blue-600 text-white border-blue-600' : 'bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100'
                      })()
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-gray-300">深色模式覆盖全局界面；壁纸在两种主题下均可使用。</p>
            </div>

            <div className="pt-4 border-t border-gray-100">
              <label className="text-sm font-medium text-gray-700 block mb-3">工作时间（首页倒计时 & 下班桌面提醒）</label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {([
                  ['startAM', '上午上班'], ['endAM', '上午下班'],
                  ['startPM', '下午上班'], ['endPM', '下午下班'],
                ] as const).map(([k, label]) => (
                  <div key={k}>
                    <div className="text-[10px] text-gray-400 mb-1">{label}</div>
                    <input
                      type="time"
                      value={(workHours as any)[k]}
                      onChange={e => {
                        const next = { ...workHours, [k]: e.target.value }
                        setWorkHoursState(next)
                        localStorage.setItem('evan-os-work-hours', JSON.stringify(next))
                        window.dispatchEvent(new Event('evan-work-hours'))
                      }}
                      className="w-full text-sm border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-100"
                    />
                  </div>
                ))}
              </div>
              <label className="flex items-center gap-2 mt-3 text-xs text-gray-600">
                <input
                  type="checkbox"
                  checked={localStorage.getItem('evan-os-offwork-notify') !== '0'}
                  onChange={e => localStorage.setItem('evan-os-offwork-notify', e.target.checked ? '1' : '0')}
                  className="rounded text-blue-600"
                />
                到点桌面弹窗提醒
                {'Notification' in window && Notification.permission !== 'granted' && (
                  <button
                    onClick={async () => { try { await Notification.requestPermission() } catch { /* ignore */ } }}
                    className="text-blue-500 hover:underline"
                  >
                    （开启浏览器通知权限）
                  </button>
                )}
              </label>
              <div className="mt-3">
                {/* 排班模式 */}
                <div className="text-[10px] text-gray-400 mb-1.5">排班模式</div>
                <div className="flex gap-2 mb-3">
                  {([
                    { key: 'fixed', label: '每周固定' },
                    { key: 'alternating', label: '大小周' },
                  ] as const).map(m => (
                    <button
                      key={m.key}
                      onClick={() => {
                        const next = { ...workHours, schedule: m.key } as any
                        setWorkHoursState(next)
                        localStorage.setItem('evan-os-work-hours', JSON.stringify(next))
                        window.dispatchEvent(new Event('evan-work-hours'))
                      }}
                      className={`px-3 py-1.5 rounded-lg text-xs border ${
                        (workHours.schedule ?? 'fixed') === m.key ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>

                {/* 固定模式：每周工作日 */}
                {(workHours.schedule ?? 'fixed') === 'fixed' && (
                  <>
                    <div className="text-[10px] text-gray-400 mb-1.5">每周工作日（非工作日不提醒、首页显示休息）</div>
                    <div className="flex gap-1.5">
                      {['日', '一', '二', '三', '四', '五', '六'].map((d, idx) => {
                        const on = (workHours as any).workdays?.includes(idx) ?? (idx >= 1 && idx <= 5)
                        return (
                          <button
                            key={idx}
                            onClick={() => {
                              const wd = new Set<number>((workHours as any).workdays ?? [1, 2, 3, 4, 5])
                              if (wd.has(idx)) wd.delete(idx); else wd.add(idx)
                              const next = { ...workHours, workdays: [...wd].sort((a, b) => a - b) } as any
                              setWorkHoursState(next)
                              localStorage.setItem('evan-os-work-hours', JSON.stringify(next))
                              window.dispatchEvent(new Event('evan-work-hours'))
                            }}
                            className={`w-8 h-8 rounded-full text-[11px] border transition-colors ${on ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-400 border-gray-200 hover:border-gray-300'}`}
                          >
                            {d}
                          </button>
                        )
                      })}
                    </div>
                  </>
                )}

                {/* 大小周模式 */}
                {workHours.schedule === 'alternating' && (
                  <div className="space-y-2">
                    <p className="text-[10px] text-gray-400">按 ISO 周数奇偶自动交替：偶数周 = 双休周，奇数周 = 单休周</p>
                    {([
                      { key: 'offDaysFull', label: '双休周休息日', def: [0, 6] },
                      { key: 'offDaysSingle', label: '单休周休息日', def: [0] },
                    ] as const).map(row => {
                      const offList: number[] = (workHours as any)[row.key] ?? row.def
                      return (
                        <div key={row.key} className="flex items-center gap-2">
                          <span className="text-[11px] text-gray-500 w-24 shrink-0">{row.label}</span>
                          <div className="flex gap-1.5">
                            {['日', '一', '二', '三', '四', '五', '六'].map((d, idx) => {
                              const on = offList.includes(idx)
                              return (
                                <button
                                  key={idx}
                                  onClick={() => {
                                    const s = new Set<number>(offList)
                                    if (s.has(idx)) s.delete(idx); else s.add(idx)
                                    const next = { ...workHours, [row.key]: [...s].sort((a, b) => a - b) } as any
                                    setWorkHoursState(next)
                                    localStorage.setItem('evan-os-work-hours', JSON.stringify(next))
                                    window.dispatchEvent(new Event('evan-work-hours'))
                                  }}
                                  className={`w-7 h-7 rounded-full text-[10px] border transition-colors ${on ? 'bg-red-400 text-white border-red-400' : 'bg-white text-gray-300 border-gray-200 hover:border-gray-300'}`}
                                >
                                  {d}
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className="pt-4 border-t border-gray-100">
              {/* ====== 内容区壁纸 ====== */}
              <label className="text-sm font-medium text-gray-700 block mb-3">内容区壁纸</label>

              {/* 预览 */}
              <div
                className="h-24 rounded-xl border border-gray-200 mb-4 relative overflow-hidden bg-[#f5f5f7]"
                style={wallpaper.type === 'image' && wallpaper.imageDataUrl
                  ? { backgroundImage: `url(${wallpaper.imageDataUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }
                  : wallpaper.type === 'preset'
                    ? { backgroundImage: getPresetCss(wallpaper.presetId) }
                    : undefined}
              >
                {wallpaper.dim > 0 && (
                  <div className="absolute inset-0 bg-black" style={{ opacity: wallpaper.dim }} />
                )}
                <div className="absolute left-3 bottom-2 right-3">
                  <div className="h-6 bg-white rounded-lg shadow-sm flex items-center px-2">
                    <div className="w-2 h-2 rounded-full bg-blue-400 mr-1.5" />
                    <div className="h-1.5 w-16 bg-gray-200 rounded-full" />
                  </div>
                </div>
              </div>

              {/* 预设 */}
              <div className="grid grid-cols-5 gap-2 mb-4">
                <button
                  onClick={() => setWallpaper({ ...DEFAULT_WALLPAPER, sidebarType: wallpaper.sidebarType, sidebarPresetId: wallpaper.sidebarPresetId, sidebarImageDataUrl: wallpaper.sidebarImageDataUrl, sidebarDim: wallpaper.sidebarDim, contentCardOpacity: wallpaper.contentCardOpacity })}
                  className={`h-12 rounded-lg border-2 bg-[#f5f5f7] text-[10px] text-gray-400 flex items-center justify-center ${
                    wallpaper.type === 'none' ? 'border-blue-500' : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  无
                </button>
                {WALLPAPER_PRESETS.map(p => (
                  <button
                    key={p.id}
                    onClick={() => setWallpaper({ type: 'preset', presetId: p.id, dim: wallpaper.dim, sidebarType: wallpaper.sidebarType, sidebarPresetId: wallpaper.sidebarPresetId, sidebarImageDataUrl: wallpaper.sidebarImageDataUrl, sidebarDim: wallpaper.sidebarDim, contentCardOpacity: wallpaper.contentCardOpacity })}
                    title={p.name}
                    className={`h-12 rounded-lg border-2 ${
                      wallpaper.type === 'preset' && wallpaper.presetId === p.id ? 'border-blue-500' : 'border-transparent hover:border-gray-300'
                    }`}
                    style={{ backgroundImage: p.css }}
                  />
                ))}
              </div>

              {/* 自定义图片 */}
              <div className="flex items-center gap-2 mb-4">
                <label className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-100 text-gray-600 rounded-lg text-xs cursor-pointer hover:bg-gray-200">
                  🖼️ 上传自定义图片
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={async e => {
                      const file = e.target.files?.[0]
                      if (!file) return
                      try {
                        const dataUrl = await fileToWallpaperDataUrl(file)
                        setWallpaper({ type: 'image', imageDataUrl: dataUrl, dim: wallpaper.dim, sidebarType: wallpaper.sidebarType, sidebarPresetId: wallpaper.sidebarPresetId, sidebarImageDataUrl: wallpaper.sidebarImageDataUrl, sidebarDim: wallpaper.sidebarDim, contentCardOpacity: wallpaper.contentCardOpacity })
                      } catch (err) {
                        alert('图片处理失败：' + String(err).slice(0, 80))
                      }
                      e.target.value = ''
                    }}
                  />
                </label>
                {wallpaper.type !== 'none' && (
                  <button
                    onClick={() => setWallpaper({ ...DEFAULT_WALLPAPER, sidebarType: wallpaper.sidebarType, sidebarPresetId: wallpaper.sidebarPresetId, sidebarImageDataUrl: wallpaper.sidebarImageDataUrl, sidebarDim: wallpaper.sidebarDim, contentCardOpacity: wallpaper.contentCardOpacity })}
                    className="px-3 py-1.5 text-gray-400 text-xs hover:text-red-500"
                  >
                    清除壁纸
                  </button>
                )}
                <span className="text-[10px] text-gray-300">图片仅存本设备，自动压缩至 1920px</span>
              </div>

              {/* 遮罩调节 */}
              <div className="mb-4">
                <label className="text-[11px] text-gray-400 block mb-1">
                  暗色遮罩（提升文字可读性）：<span className="text-gray-600">{Math.round(wallpaper.dim * 100)}%</span>
                </label>
                <input
                  type="range" min={0} max={60} step={5}
                  value={Math.round(wallpaper.dim * 100)}
                  onChange={e => setWallpaper({ ...wallpaper, dim: Number(e.target.value) / 100 })}
                  className="w-full accent-blue-500"
                />
              </div>

              {/* 内容区卡片透明度 */}
              <div className="mb-6">
                <label className="text-[11px] text-gray-400 block mb-1">
                  卡片透明度（越大越透出壁纸）：<span className="text-gray-600">{Math.round((wallpaper.contentCardOpacity ?? 1) * 100)}%</span>
                </label>
                <input
                  type="range" min={0} max={100} step={5}
                  value={Math.round((wallpaper.contentCardOpacity ?? 1) * 100)}
                  onChange={e => setWallpaper({ ...wallpaper, contentCardOpacity: Number(e.target.value) / 100 })}
                  className="w-full accent-blue-500"
                />
              </div>

              {/* ====== 侧边栏壁纸 ====== */}
              <label className="text-sm font-medium text-gray-700 block mb-3">侧边栏壁纸</label>

              {/* 侧边栏预览 */}
              <div
                className="h-16 rounded-xl border border-gray-200 mb-4 relative overflow-hidden bg-[#f5f5f7]"
                style={wallpaper.sidebarType === 'image' && wallpaper.sidebarImageDataUrl
                  ? { backgroundImage: `url(${wallpaper.sidebarImageDataUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }
                  : wallpaper.sidebarType === 'preset'
                    ? { backgroundImage: getPresetCss(wallpaper.sidebarPresetId) }
                    : undefined}
              >
                <div className="absolute inset-0 flex items-center px-3">
                  <div className="flex gap-1.5">
                    {[1,2,3].map(i => (
                      <div key={i} className="w-6 h-4 bg-white/80 rounded" />
                    ))}
                  </div>
                </div>
              </div>

              {/* 侧边栏预设 */}
              <div className="grid grid-cols-5 gap-2 mb-4">
                <button
                  onClick={() => setWallpaper({ ...wallpaper, sidebarType: 'none', sidebarPresetId: undefined, sidebarImageDataUrl: undefined })}
                  className={`h-10 rounded-lg border-2 bg-[#f5f5f7] text-[10px] text-gray-400 flex items-center justify-center ${
                    !wallpaper.sidebarType || wallpaper.sidebarType === 'none' ? 'border-blue-500' : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  无
                </button>
                {WALLPAPER_PRESETS.map(p => (
                  <button
                    key={p.id}
                    onClick={() => setWallpaper({ ...wallpaper, sidebarType: 'preset', sidebarPresetId: p.id })}
                    title={p.name}
                    className={`h-10 rounded-lg border-2 ${
                      wallpaper.sidebarType === 'preset' && wallpaper.sidebarPresetId === p.id ? 'border-blue-500' : 'border-transparent hover:border-gray-300'
                    }`}
                    style={{ backgroundImage: p.css }}
                  />
                ))}
              </div>

              {/* 侧边栏自定义图片 */}
              <div className="flex items-center gap-2 mb-4">
                <label className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-100 text-gray-600 rounded-lg text-xs cursor-pointer hover:bg-gray-200">
                  🖼️ 上传侧边栏图片
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={async e => {
                      const file = e.target.files?.[0]
                      if (!file) return
                      try {
                        const dataUrl = await fileToWallpaperDataUrl(file)
                        setWallpaper({ ...wallpaper, sidebarType: 'image', sidebarImageDataUrl: dataUrl })
                      } catch (err) {
                        alert('图片处理失败：' + String(err).slice(0, 80))
                      }
                      e.target.value = ''
                    }}
                  />
                </label>
                {wallpaper.sidebarType && wallpaper.sidebarType !== 'none' && (
                  <button
                    onClick={() => setWallpaper({ ...wallpaper, sidebarType: 'none', sidebarPresetId: undefined, sidebarImageDataUrl: undefined })}
                    className="px-3 py-1.5 text-gray-400 text-xs hover:text-red-500"
                  >
                    清除壁纸
                  </button>
                )}
              </div>

              {/* 侧边栏透明度 */}
              <div>
                <label className="text-[11px] text-gray-400 block mb-1">
                  侧边栏透明度（越大越透出壁纸）：<span className="text-gray-600">{Math.round((wallpaper.sidebarDim ?? 0.15) * 100)}%</span>
                </label>
                <input
                  type="range" min={0} max={100} step={5}
                  value={Math.round((wallpaper.sidebarDim ?? 0.15) * 100)}
                  onChange={e => setWallpaper({ ...wallpaper, sidebarDim: Number(e.target.value) / 100 })}
                  className="w-full accent-blue-500"
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 关于 */}
      {activeSection === 'about' && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-2">
            <Info size={16} /> 关于 Evan OS
          </h2>
          <div className="text-sm text-gray-600 space-y-2">
            <div className="flex items-center gap-3 py-2">
              <span className="text-3xl">🧠</span>
              <div>
                <div className="font-bold text-gray-800">Evan OS</div>
                <div className="text-xs text-gray-400">个人与事业操作系统</div>
              </div>
            </div>
            <div className="border-t border-gray-100 pt-3 space-y-1.5">
              <p>版本：<span className="font-mono text-gray-700">v1.0 (Phase 6)</span></p>
              <p>存储引擎：<span className="font-mono text-gray-700">IndexedDB (Dexie.js)</span></p>
              <p>前端框架：<span className="font-mono text-gray-700">React 18 + TypeScript + Vite</span></p>
              <p>UI 组件：<span className="font-mono text-gray-700">Tailwind CSS + Lucide Icons</span></p>
              <p>数据表数：<span className="font-mono text-gray-700">17 张</span></p>
            </div>
            <div className="border-t border-gray-100 pt-3">
              <p className="text-xs text-gray-400">数据仅存储在本地浏览器中，不会上传到任何服务器。定期导出备份以防数据丢失。</p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
