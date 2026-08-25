import fs from 'node:fs'

let c = fs.readFileSync('src/pages/Home.tsx', 'utf8')

// 用完整正确的 ClockWork 替换受损版本
const start = c.indexOf('function ClockWork() {')
const endMarker = 'export default function HomePage() {'
const end = c.indexOf(endMarker)

const clockWork = `function ClockWork() {
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
    { label: '美东 ET', tz: 'America/New_York' },
    { label: '中部 CT', tz: 'America/Chicago' },
    { label: '山区 MT', tz: 'America/Denver' },
    { label: '太平洋 PT', tz: 'America/Los_Angeles' },
  ]

  const todayAt = (s: string) => { const [h, m] = s.split(':').map(Number); const d = new Date(); d.setHours(h, m, 0, 0); return d }
  const isOffDay = !isWorkDay(now)
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
  if (target && now < target) {
    const diff = target.getTime() - now.getTime()
    const h = Math.floor(diff / 3.6e6)
    const m = Math.floor((diff % 3.6e6) / 6e4)
    const s = Math.floor((diff % 6e4) / 1000)
    cd = \`\${h ? \`\${h}小时\` : ''}\${m}分\${s}秒\`
  }

  // 跨过节点 → 桌面通知（每天每节点一次）
  useEffect(() => {
    if (isOffDay || !target || now < target) return
    const key = \`\${label}:\${now.toDateString()}\`
    if (notifiedRef.current === key) return
    notifiedRef.current = key
    if (localStorage.getItem('evan-os-offwork-notify') !== '0' && 'Notification' in window && Notification.permission === 'granted') {
      try { new Notification('Evan OS', { body: \`\${label} — 时间到！\` }) } catch { /* ignore */ }
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
        <div className="text-[10px] text-gray-400 mb-1">💼 工作状态 {scheduleNote && <span className="text-purple-400">· {scheduleNote}</span>}</div>
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

`

c = c.slice(0, start) + clockWork + c.slice(end)
fs.writeFileSync('src/pages/Home.tsx', c)
console.log('ClockWork rewritten, schedule note included')
