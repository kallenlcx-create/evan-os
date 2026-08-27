import { useState, useEffect, useRef } from 'react'
import { useStore } from '../store'
import { Play, Pause, RotateCcw, Timer, Coffee, Check, X } from 'lucide-react'

const FOCUS = (Number(localStorage.getItem('evan-os-pomodoro-min')) || 25) * 60
const BREAK = 5 * 60

export default function PomodoroTimer() {
  const { addPomodoroSession, getTodayPomodoroStats } = useStore()
  const [seconds, setSeconds] = useState(FOCUS)
  useEffect(() => {
    const reload = () => setSeconds((Number(localStorage.getItem('evan-os-pomodoro-min')) || 25) * 60)
    window.addEventListener('evan-pomodoro-min', reload)
    return () => window.removeEventListener('evan-pomodoro-min', reload)
  }, [])
  const [isRunning, setIsRunning] = useState(false)
  const [isBreak, setIsBreak] = useState(false)
  const [sessionStart, setSessionStart] = useState<string | null>(null)
  const intervalRef = useRef<number | null>(null)
  const isBreakRef = useRef(false)
  const sessionStartRef = useRef<string | null>(null)

  // 同步 ref
  useEffect(() => { isBreakRef.current = isBreak }, [isBreak])
  useEffect(() => { sessionStartRef.current = sessionStart }, [sessionStart])

  const stats = getTodayPomodoroStats()

  // 清理定时器
  useEffect(() => {
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [])

  const tick = () => {
    setSeconds(s => {
      if (s <= 1) {
        // 计时结束 —— 用 ref 确保读到最新值
        const curBreak = isBreakRef.current
        const curStart = sessionStartRef.current
        if (curStart) {
          addPomodoroSession({
            startTime: curStart,
            endTime: new Date().toISOString(),
            duration: curBreak ? 5 : 25,
            type: curBreak ? 'break' : 'focus',
            completed: true,
          })
        }
        setIsRunning(false)
        setSessionStart(null)
        if (intervalRef.current) clearInterval(intervalRef.current)
        return curBreak ? FOCUS : BREAK
      }
      return s - 1
    })
  }

  const startPause = () => {
    if (isRunning) {
      setIsRunning(false)
      if (intervalRef.current) clearInterval(intervalRef.current)
    } else {
      if (!sessionStart) setSessionStart(new Date().toISOString())
      setIsRunning(true)
      intervalRef.current = window.setInterval(tick, 1000)
    }
  }

  const reset = () => {
    setIsRunning(false)
    if (intervalRef.current) clearInterval(intervalRef.current)
    setSessionStart(null)
    setSeconds(isBreak ? BREAK : FOCUS)
  }

  const skip = () => {
    const curBreak = isBreakRef.current
    const curStart = sessionStartRef.current
    if (curStart) {
      addPomodoroSession({
        startTime: curStart,
        endTime: new Date().toISOString(),
        duration: Math.round((curBreak ? BREAK : FOCUS - seconds) / 60),
        type: curBreak ? 'break' : 'focus',
        completed: false,
      })
    }
    setIsRunning(false)
    if (intervalRef.current) clearInterval(intervalRef.current)
    setSessionStart(null)
    setIsBreak(!curBreak)
    setSeconds(curBreak ? FOCUS : BREAK)
  }

  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  const total = isBreak ? BREAK : FOCUS
  const progress = ((total - seconds) / total) * 100

  return (
    <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100">
      <h3 className="text-lg font-semibold text-gray-800 flex items-center gap-2 mb-4">
        <Timer size={20} className="text-red-400" />
        {isBreak ? '☕ 休息' : '🍅 番茄钟'}
      </h3>

      {/* 计时器 */}
      <div className="text-center mb-4">
        <div className={`text-5xl font-mono font-bold mb-3 ${isRunning ? (isBreak ? 'text-green-600' : 'text-red-500') : 'text-gray-700'}`}>
          {String(mins).padStart(2, '0')}:{String(secs).padStart(2, '0')}
        </div>

        {/* 进度条 */}
        <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden mb-4">
          <div
            className={`h-full rounded-full transition-all duration-1000 ${isBreak ? 'bg-green-400' : 'bg-red-400'}`}
            style={{ width: `${progress}%` }}
          />
        </div>

        {/* 控制按钮 */}
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={reset}
            className="p-2.5 rounded-xl bg-gray-100 hover:bg-gray-200 text-gray-500 transition-colors"
            title="重置"
          >
            <RotateCcw size={18} />
          </button>
          <button
            onClick={startPause}
            className={`px-6 py-2.5 rounded-xl font-medium text-white transition-all ${
              isRunning
                ? 'bg-yellow-500 hover:bg-yellow-600'
                : 'bg-red-500 hover:bg-red-600'
            }`}
          >
            {isRunning ? <Pause size={18} /> : <Play size={18} />}
          </button>
          <button
            onClick={skip}
            className="p-2.5 rounded-xl bg-gray-100 hover:bg-gray-200 text-gray-500 transition-colors"
            title="跳过"
          >
            {isBreak ? <Check size={18} /> : <X size={18} />}
          </button>
        </div>
      </div>

      {/* 预设时长 */}
      <div className="flex gap-2 justify-center mb-4">
        {[25, 45, 60].map(m => (
          <button
            key={m}
            onClick={() => { if (!isRunning) { setSeconds(m * 60); setIsBreak(false); setSessionStart(null) } }}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              !isBreak && seconds === m * 60 ? 'bg-red-100 text-red-700' : 'bg-gray-50 text-gray-500 hover:bg-gray-100'
            }`}
          >
            {m}分钟
          </button>
        ))}
        <span className="text-xs text-gray-300 px-1">|</span>
        {[5, 10, 15].map(m => (
          <button
            key={m}
            onClick={() => { if (!isRunning) { setSeconds(m * 60); setIsBreak(true); setSessionStart(null) } }}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              isBreak && seconds === m * 60 ? 'bg-green-100 text-green-700' : 'bg-gray-50 text-gray-500 hover:bg-gray-100'
            }`}
          >
            {m}分钟
          </button>
        ))}
      </div>

      {/* 统计 */}
      {stats.count > 0 && (
        <div className="border-t border-gray-100 pt-3 flex justify-around text-center">
          <div>
            <div className="text-lg font-bold text-gray-700">{stats.completed}</div>
            <div className="text-xs text-gray-400">完成番茄</div>
          </div>
          <div>
            <div className="text-lg font-bold text-gray-700">{stats.minutes}</div>
            <div className="text-xs text-gray-400">专注分钟</div>
          </div>
          <div>
            <div className="text-lg font-bold text-gray-700">{stats.count}</div>
            <div className="text-xs text-gray-400">总次数</div>
          </div>
        </div>
      )}
    </div>
  )
}