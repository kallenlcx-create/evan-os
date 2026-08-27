import { useState, useEffect } from 'react'
import { useStore } from '../store'
import { useConfirm } from '../components/ConfirmModal'
import { format } from 'date-fns'
import { ChevronLeft, ChevronRight, Save, Calendar, Smile, Zap } from 'lucide-react'
import MarkdownEditor from '../components/MarkdownEditor'

import { MOODS, MOOD_COLORS, type MoodValue } from '../config/constants'

export default function DailyLogPage() {
  const today = format(new Date(), 'yyyy-MM-dd')
  const [selectedDate, setSelectedDate] = useState(today)
  const [confirmModal, confirm] = useConfirm()
  const [content, setContent] = useState('')
  const [mood, setMood] = useState('')
  const [energy, setEnergy] = useState(5)
  const [saved, setSaved] = useState(false)

  const { dailyLogs, getDailyLog, saveDailyLog, deleteDailyLog, tasks } = useStore()

  // 加载选中日期的日志
  useEffect(() => {
    const log = getDailyLog(selectedDate)
    if (log) {
      setContent(log.content)
      setMood(log.mood)
      setEnergy(log.energy)
    } else {
      setContent('')
      setMood('')
      setEnergy(5)
    }
    setSaved(false)
  }, [selectedDate, dailyLogs])

  const handleSave = async () => {
    await saveDailyLog(selectedDate, content, mood, energy)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const handlePrevDay = () => {
    const d = new Date(selectedDate)
    d.setDate(d.getDate() - 1)
    setSelectedDate(format(d, 'yyyy-MM-dd'))
  }

  const handleNextDay = () => {
    const d = new Date(selectedDate)
    d.setDate(d.getDate() + 1)
    setSelectedDate(format(d, 'yyyy-MM-dd'))
  }

  const isToday = selectedDate === today

  // 今日完成的任务
  const todayDone = selectedDate === today
    ? tasks.filter(t => t.status === 'done')
    : []

  // 日期格式化
  const displayDate = format(new Date(selectedDate + 'T00:00:00'), 'yyyy年M月d日 EEEE', { locale: undefined })
  const weekdayRaw = ['日', '一', '二', '三', '四', '五', '六']
  const d = new Date(selectedDate + 'T00:00:00')
  const displayDateCN = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${weekdayRaw[d.getDay()]}`

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault()
      handleSave()
    }
  }

  return (
    <div className="space-y-6" onKeyDown={handleKeyDown}>
      {confirmModal}
      {/* 页面标题 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">📝 每日日志</h1>
          <p className="text-sm text-gray-400 mt-0.5">记录每一天的思考与成长</p>
        </div>
        <button
          onClick={handleSave}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all ${
            saved
              ? 'bg-green-100 text-green-700'
              : 'bg-blue-600 text-white hover:bg-blue-700 shadow-sm'
          }`}
        >
          <Save size={16} />
          {saved ? '已保存 ✓' : '保存 (Ctrl+S)'}
        </button>
      </div>

      {/* 日期选择器 */}
      <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
        <div className="flex items-center justify-between">
          <button
            onClick={handlePrevDay}
            className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors"
          >
            <ChevronLeft size={20} />
          </button>

          <div className="text-center">
            <div className="text-lg font-semibold text-gray-800 flex items-center gap-2">
              <Calendar size={18} className="text-blue-500" />
              {displayDateCN}
              {isToday && (
                <span className="text-xs bg-blue-100 text-blue-600 px-2 py-0.5 rounded-full">今天</span>
              )}
            </div>
          </div>

          <button
            onClick={handleNextDay}
            className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors"
            disabled={isToday}
          >
            <ChevronRight size={20} className={isToday ? 'opacity-30' : ''} />
          </button>
        </div>

        {/* 删除当前日志 */}
        {dailyLogs.some(l => l.date === selectedDate) && (
          <div className="mt-2 text-right">
            <button
              onClick={async () => {
                if (!await confirm(`删除 ${selectedDate} 的日志？此操作不可恢复`)) return
                await deleteDailyLog(selectedDate)
                setContent(''); setMood(''); setEnergy(5)
              }}
              className="text-[10px] text-gray-300 hover:text-red-500"
            >
              🗑 删除该日日志
            </button>
          </div>
        )}

        {/* 历史日志列表 */}
        {dailyLogs.length > 1 && (
          <div className="mt-3 pt-3 border-t border-gray-100">
            <div className="text-[10px] text-gray-300 mb-1.5">历史日志（点击跳转）</div>
            <div className="flex gap-1.5 flex-wrap">
              {[...dailyLogs].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 14).map(l => (
                <button
                  key={l.id}
                  onClick={() => setSelectedDate(l.date)}
                  className={`px-2 py-1 rounded-lg text-[10px] transition-colors ${
                    l.date === selectedDate ? 'bg-blue-100 text-blue-600 font-medium' : 'bg-gray-50 text-gray-400 hover:bg-gray-100'
                  }`}
                >
                  {l.date.slice(5)}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 心情和能量 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* 心情 */}
        <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
          <h3 className="text-sm font-semibold text-gray-600 mb-3 flex items-center gap-2">
            <Smile size={16} /> 今日心情
          </h3>
          <div className="flex gap-2 flex-wrap">
            {MOODS.map(m => (
              <button
                key={m.value}
                onClick={() => setMood(mood === m.value ? '' : m.value)}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm transition-all border ${
                  mood === m.value
                    ? `${MOOD_COLORS[m.value as MoodValue]} border-current`
                    : 'border-gray-200 text-gray-400 hover:border-gray-300'
                }`}
              >
                <span className="text-lg">{m.emoji}</span>
                <span>{m.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 能量 */}
        <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
          <h3 className="text-sm font-semibold text-gray-600 mb-3 flex items-center gap-2">
            <Zap size={16} /> 能量水平
          </h3>
          <div className="flex items-center gap-2">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => (
              <button
                key={n}
                onClick={() => setEnergy(n)}
                className={`w-7 h-7 rounded-lg text-xs font-medium transition-all ${
                  n <= energy
                    ? 'bg-yellow-400 text-white shadow-sm'
                    : 'bg-gray-100 text-gray-300'
                }`}
              >
                {n}
              </button>
            ))}
            <span className="ml-2 text-sm text-gray-500">{energy}/10</span>
          </div>
        </div>
      </div>

      {/* Markdown 编辑器 */}
      <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
        <h3 className="text-sm font-semibold text-gray-600 mb-3">📄 日志内容</h3>
        <MarkdownEditor
          value={content}
          onChange={setContent}
          placeholder={`## ${displayDate} 的日志\n\n### 今日完成\n- \n\n### 今日收获\n\n### 明日计划\n\n### 随想\n`}
          minHeight="400px"
        />
      </div>

      {/* 今日完成的任务 */}
      {isToday && todayDone.length > 0 && (
        <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
          <h3 className="text-sm font-semibold text-gray-600 mb-3">✅ 今日已完成</h3>
          <div className="space-y-2">
            {todayDone.map(t => (
              <div key={t.id} className="flex items-center gap-2 text-sm text-gray-600 line-through">
                <span className="text-green-500">✓</span>
                {t.title}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}