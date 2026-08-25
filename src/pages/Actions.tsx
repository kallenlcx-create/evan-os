import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store'
import { Plus, Check, Clock, Calendar, RotateCw, ArrowRight, Save, Smile, Timer, Grid3X3 } from 'lucide-react'
import QuadrantView from '../components/QuadrantView'
import PomodoroTimer from '../components/PomodoroTimer'
import type { Task } from '../types'

const tabs = [
  { key: 'today', label: '📅 今日', icon: Calendar },
  { key: 'calendar', label: '🗓️ 日历', icon: Calendar },
  { key: 'quadrant', label: '📊 四象限', icon: Grid3X3 },
  { key: 'pomodoro', label: '🍅 番茄钟', icon: Timer },
  { key: 'recurring', label: '🔄 重复事项', icon: RotateCw },
  { key: 'journal', label: '📝 日志', icon: Calendar },
  { key: 'review', label: '🔄 复盘', icon: RotateCw },
]

const moods = [
  { value: 'great', emoji: '😄', label: '很棒' },
  { value: 'good', emoji: '😊', label: '不错' },
  { value: 'ok', emoji: '😐', label: '一般' },
  { value: 'tired', emoji: '😫', label: '疲惫' },
  { value: 'bad', emoji: '😞', label: '不好' },
]

export default function ActionsPage() {
  const { tasks, reviews, addTask, toggleTaskStatus, addObject } = useStore()
  const navigate = useNavigate()
  const [activeTab, setActiveTab] = useState('today')
  const [newTask, setNewTask] = useState('')
  const [calMonth, setCalMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1) })

  // 复盘表单状态
  const [showReviewForm, setShowReviewForm] = useState(false)
  const [reviewType, setReviewType] = useState<'daily' | 'weekly' | 'monthly' | 'yearly'>('daily')
  const [reviewMood, setReviewMood] = useState('')
  const [reviewWell, setReviewWell] = useState('')
  const [reviewImprove, setReviewImprove] = useState('')
  const [reviewTakeaway, setReviewTakeaway] = useState('')
  const [reviewNextPlan, setReviewNextPlan] = useState('')

  const handleAddTask = () => {
    if (!newTask.trim()) return
    addTask({ title: newTask.trim() })
    setNewTask('')
  }

  const handleSaveReview = async () => {
    if (!reviewWell.trim() && !reviewImprove.trim()) return
    const today = new Date().toISOString().slice(0, 10)
    await addObject('review', {
      title: `${reviewType === 'daily' ? '每日' : reviewType === 'weekly' ? '每周' : reviewType === 'monthly' ? '每月' : '年度'}复盘 - ${today}`,
      emoji: reviewType === 'daily' ? '📝' : reviewType === 'weekly' ? '📊' : reviewType === 'monthly' ? '📈' : '🎯',
      reviewType,
      period: today,
      whatWentWell: reviewWell,
      whatToImprove: reviewImprove,
      keyTakeaways: reviewTakeaway,
      mood: reviewMood,
      energy: 5,
      completedTasks: [],
      nextDayPlan: reviewNextPlan,
    })
    setShowReviewForm(false)
    setReviewWell('')
    setReviewImprove('')
    setReviewTakeaway('')
    setReviewNextPlan('')
    setReviewMood('')
  }

  const todayTasks = tasks.filter(t => t.status !== 'done' && t.status !== 'cancelled')
  const doneTasks = tasks.filter(t => t.status === 'done')
  const recurringTasks = tasks.filter(t => t.isRecurring)

  const renderContent = () => {
    switch (activeTab) {
      case 'calendar': {
        const year = calMonth.getFullYear()
        const month = calMonth.getMonth()
        const firstDow = (new Date(year, month, 1).getDay() + 6) % 7 // 周一=0
        const daysInMonth = new Date(year, month + 1, 0).getDate()
        const cells: (string | null)[] = Array(firstDow).fill(null)
        for (let d = 1; d <= daysInMonth; d++) {
          cells.push(`${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`)
        }
        const todayKey = new Date().toISOString().slice(0, 10)
        return (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <button onClick={() => setCalMonth(new Date(year, month - 1, 1))} className="px-3 py-1.5 bg-gray-100 rounded-lg text-xs hover:bg-gray-200">← 上月</button>
              <span className="text-sm font-semibold text-gray-700">{year} 年 {month + 1} 月</span>
              <button onClick={() => setCalMonth(new Date(year, month + 1, 1))} className="px-3 py-1.5 bg-gray-100 rounded-lg text-xs hover:bg-gray-200">下月 →</button>
            </div>
            <div className="grid grid-cols-7 gap-1 text-center text-[10px] text-gray-400">
              {['一', '二', '三', '四', '五', '六', '日'].map(d => <div key={d} className="py-1">{d}</div>)}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {cells.map((ds, i) => ds === null ? <div key={`e${i}`} /> : (() => {
                const dayItems = tasks.filter(t => t.dueDate === ds && t.status !== 'cancelled')
                const isToday = ds === todayKey
                return (
                  <div key={ds} className={`min-h-[76px] rounded-lg border p-1 ${isToday ? 'border-blue-400 bg-blue-50/40' : 'border-gray-100 bg-white'}`}>
                    <div className={`text-[10px] mb-0.5 ${isToday ? 'text-blue-600 font-bold' : 'text-gray-400'}`}>
                      {Number(ds.slice(-2))}
                    </div>
                    <div className="space-y-0.5">
                      {dayItems.map(it => (
                        <button
                          key={it.id}
                          onClick={() => toggleTaskStatus(it.id)}
                          title={`${it.title}（点击切换完成）`}
                          className={`block w-full text-left text-[9px] px-1 py-0.5 rounded truncate ${it.status === 'done' ? 'bg-green-100 text-green-600 line-through' : 'bg-blue-100 text-blue-700'}`}
                        >
                          {it.title}
                        </button>
                      ))}
                    </div>
                    <button
                      onClick={async () => {
                        const title = prompt(`${ds} 添加特殊事项：`)
                        if (title?.trim()) await addTask({ title: title.trim(), dueDate: ds })
                      }}
                      className="w-full text-[9px] text-gray-300 hover:text-blue-500 mt-0.5"
                    >
                      ＋
                    </button>
                  </div>
                )
              })())}
            </div>
            <p className="text-[10px] text-gray-300">
              点日期格内「＋」添加特殊事项（到该日期才会出现在首页「今日事项」）；点事项条目切换完成状态。
            </p>
          </div>
        )
      }
      case 'today':
        return (
          <div className="space-y-4">
            <div className="flex gap-2">
              <input
                type="text"
                value={newTask}
                onChange={e => setNewTask(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAddTask()}
                placeholder="添加任务..."
                className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-200"
              />
              <button
                onClick={handleAddTask}
                disabled={!newTask.trim()}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-40"
              >
                <Plus size={16} />
              </button>
            </div>

            {todayTasks.length === 0 && doneTasks.length === 0 ? (
              <div className="text-center py-12 text-gray-400">
                <div className="text-4xl mb-2">📋</div>
                <div className="text-sm">今天还没有任务，添加一个吧</div>
              </div>
            ) : (
              <>
                {todayTasks.length > 0 && (
                  <div>
                    <h3 className="text-xs font-semibold text-gray-400 mb-2">待完成 ({todayTasks.length})</h3>
                    <div className="space-y-1">
                      {todayTasks.map(task => (
                        <div
                          key={task.id}
                          onClick={() => toggleTaskStatus(task.id)}
                          className="flex items-center gap-3 p-3 bg-white rounded-xl border border-gray-100 hover:bg-gray-50 cursor-pointer transition-colors"
                        >
                          <div className="w-5 h-5 rounded-full border-2 border-gray-300 flex items-center justify-center flex-shrink-0" />
                          <span className="text-lg">{task.emoji}</span>
                          <span className="text-sm text-gray-700 flex-1">{task.title}</span>
                          {task.priority === 'high' && (
                            <span className="text-[10px] px-1.5 py-0.5 bg-orange-50 text-orange-500 rounded-full">重要</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {doneTasks.length > 0 && (
                  <div className="mt-6">
                    <h3 className="text-xs font-semibold text-gray-400 mb-2">已完成 ({doneTasks.length})</h3>
                    <div className="space-y-1">
                      {doneTasks.map(task => (
                        <div
                          key={task.id}
                          onClick={() => toggleTaskStatus(task.id)}
                          className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl border border-gray-100 cursor-pointer transition-colors"
                        >
                          <div className="w-5 h-5 rounded-full bg-green-500 border-2 border-green-500 flex items-center justify-center flex-shrink-0">
                            <Check size={12} className="text-white" />
                          </div>
                          <span className="text-lg">{task.emoji}</span>
                          <span className="text-sm text-gray-400 line-through flex-1">{task.title}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )

      case 'quadrant':
        return <QuadrantView />

      case 'pomodoro':
        return <PomodoroTimer />

      case 'recurring':
        return (
          <div className="space-y-3">
            {recurringTasks.length === 0 ? (
              <div className="text-center py-12 text-gray-400 text-sm">暂无重复事项</div>
            ) : (
              recurringTasks.map(task => (
                <div key={task.id} className="flex items-center gap-3 p-3 bg-white rounded-xl border border-gray-100">
                  <span className="text-lg">{task.emoji}</span>
                  <span className="text-sm text-gray-700 flex-1">{task.title}</span>
                  <span className="text-[10px] px-2 py-0.5 bg-purple-50 text-purple-500 rounded-full">
                    {task.recurringRule === 'daily' ? '每天' : task.recurringRule}
                  </span>
                </div>
              ))
            )}
          </div>
        )

      case 'journal':
        return (
          <div className="space-y-4">
            <div className="text-center py-8">
              <div className="text-5xl mb-4">📝</div>
              <h3 className="text-lg font-semibold text-gray-800 mb-2">每日日志</h3>
              <p className="text-sm text-gray-500 mb-4">
                用 Markdown 记录每一天的思考、收获与计划。<br />
                支持 [[链接]] 和 #标签。
              </p>
              <button
                onClick={() => navigate('/journal')}
                className="inline-flex items-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700 shadow-sm transition-all"
              >
                打开日志 <ArrowRight size={16} />
              </button>
            </div>
          </div>
        )

      case 'review':
        return (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-500">选择复盘类型</h3>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {[
                { type: 'daily' as const, label: '📝 每日复盘', desc: '今天做了什么？学到了什么？' },
                { type: 'weekly' as const, label: '📊 每周复盘', desc: '本周成就、问题、下周重点' },
                { type: 'monthly' as const, label: '📈 每月复盘', desc: '目标回顾、关键事件、下月计划' },
                { type: 'yearly' as const, label: '🎯 年度复盘', desc: '年度总结、人生方向' },
              ].map(item => (
                <div
                  key={item.type}
                  className="bg-white rounded-xl p-5 border border-gray-100 hover:border-blue-200 cursor-pointer transition-all"
                  onClick={() => { setReviewType(item.type); setShowReviewForm(true) }}
                >
                  <h3 className="text-sm font-semibold text-gray-800 mb-1">{item.label}</h3>
                  <p className="text-xs text-gray-400">{item.desc}</p>
                </div>
              ))}
            </div>

            {/* 复盘表单 */}
            {showReviewForm && (
              <div className="bg-white rounded-2xl p-6 shadow-sm border border-blue-200">
                <h3 className="font-semibold text-gray-800 mb-4">
                  {reviewType === 'daily' ? '📝 每日复盘' :
                   reviewType === 'weekly' ? '📊 每周复盘' :
                   reviewType === 'monthly' ? '📈 每月复盘' : '🎯 年度复盘'}
                </h3>

                <div className="space-y-4">
                  {/* 心情 */}
                  <div>
                    <label className="text-xs font-semibold text-gray-500 mb-2 block">今日心情</label>
                    <div className="flex gap-2">
                      {moods.map(m => (
                        <button
                          key={m.value}
                          onClick={() => setReviewMood(m.value)}
                          className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs transition-all ${
                            reviewMood === m.value
                              ? 'bg-blue-100 text-blue-700 border border-blue-300'
                              : 'bg-gray-50 text-gray-500 border border-gray-200'
                          }`}
                        >
                          {m.emoji} {m.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* 做得好的 */}
                  <div>
                    <label className="text-xs font-semibold text-gray-500 mb-2 block">✅ 做得好的</label>
                    <textarea
                      value={reviewWell}
                      onChange={e => setReviewWell(e.target.value)}
                      placeholder="今天/本周有哪些做得好的地方..."
                      className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm outline-none focus:border-blue-400 resize-none"
                      rows={3}
                    />
                  </div>

                  {/* 需要改进 */}
                  <div>
                    <label className="text-xs font-semibold text-gray-500 mb-2 block">🔧 需要改进的</label>
                    <textarea
                      value={reviewImprove}
                      onChange={e => setReviewImprove(e.target.value)}
                      placeholder="有哪些地方可以做得更好..."
                      className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm outline-none focus:border-blue-400 resize-none"
                      rows={3}
                    />
                  </div>

                  {/* 关键收获 */}
                  <div>
                    <label className="text-xs font-semibold text-gray-500 mb-2 block">💡 关键收获</label>
                    <textarea
                      value={reviewTakeaway}
                      onChange={e => setReviewTakeaway(e.target.value)}
                      placeholder="最重要的收获是什么..."
                      className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm outline-none focus:border-blue-400 resize-none"
                      rows={2}
                    />
                  </div>

                  {/* 下一步 */}
                  <div>
                    <label className="text-xs font-semibold text-gray-500 mb-2 block">📋 下一步计划</label>
                    <textarea
                      value={reviewNextPlan}
                      onChange={e => setReviewNextPlan(e.target.value)}
                      placeholder="明天/下周的计划..."
                      className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm outline-none focus:border-blue-400 resize-none"
                      rows={2}
                    />
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={handleSaveReview}
                      className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700"
                    >
                      <Save size={14} /> 保存复盘
                    </button>
                    <button
                      onClick={() => setShowReviewForm(false)}
                      className="px-4 py-2 bg-gray-100 text-gray-600 rounded-xl text-sm"
                    >
                      取消
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* 历史复盘 */}
            {reviews.length > 0 && (
              <div className="space-y-3 mt-6">
                <h3 className="text-sm font-semibold text-gray-500">📚 历史复盘</h3>
                {reviews.slice().reverse().slice(0, 10).map(r => (
                  <div key={r.id} className="bg-white rounded-xl p-4 border border-gray-100">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-lg">{r.emoji}</span>
                      <span className="text-sm font-medium text-gray-800">{r.title}</span>
                      <span className="text-[10px] text-gray-400">{r.period}</span>
                      {r.mood && (
                        <span className="text-xs">{moods.find(m => m.value === r.mood)?.emoji}</span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 line-clamp-2">
                      {r.whatWentWell || r.whatToImprove || r.keyTakeaways}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )

      default:
        return (
          <div className="text-center py-12 text-gray-400 text-sm">
            此视图即将上线
          </div>
        )
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-800">📅 行动</h1>
        <p className="text-sm text-gray-400 mt-0.5">管理任务、日志与复盘，让每一天都有节奏</p>
      </div>

      {/* 标签页 */}
      <div className="flex gap-2 overflow-x-auto pb-2">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-full text-sm whitespace-nowrap transition-colors ${
              activeTab === tab.key
                ? 'bg-blue-600 text-white'
                : 'bg-white text-gray-600 hover:bg-gray-100 border border-gray-200'
            }`}
          >
            <tab.icon size={14} />
            {tab.label}
          </button>
        ))}
      </div>

      {/* 内容 */}
      <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100 min-h-[400px]">
        {renderContent()}
      </div>
    </div>
  )
}