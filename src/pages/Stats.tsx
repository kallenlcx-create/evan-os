import { useState } from 'react'
import { useStore } from '../store'
import { localDate } from '../utils/date'
import { TrendingUp, CheckCircle2, Clock, Target, Flame, Calendar, Award, BarChart3 } from 'lucide-react'

export default function StatsPage() {
  const { tasks, habits, goals, projects, pomodoroSessions, getTodayPomodoroStats, dailyLogs } = useStore()
  const [period, setPeriod] = useState<'week' | 'month'>('week')

  // 任务完成率
  const doneTasks = tasks.filter(t => t.status === 'done')
  const completionRate = tasks.length > 0 ? Math.round((doneTasks.length / tasks.length) * 100) : 0

  // 番茄钟统计
  const todayPomo = getTodayPomodoroStats()
  const weekPomo = pomodoroSessions.filter(s => {
    const d = new Date(s.startTime)
    const now = new Date()
    const diff = (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24)
    return diff <= 7 && s.type === 'focus'
  })
  const totalFocusMinutes = weekPomo.reduce((sum, s) => sum + s.duration, 0)

  // 习惯打卡热力图（最近30天）
  const last30Days = Array.from({ length: 30 }, (_, i) => {
    const d = new Date()
    d.setDate(d.getDate() - (29 - i))
    return localDate(d)
  })

  const habitHeatmap = last30Days.map(date => {
    const doneCount = habits.filter(h => h.completedDates.includes(date)).length
    return { date, count: doneCount, total: habits.length }
  })

  // 目标进度
  const activeGoals = goals.filter(g => g.progress < 100)
  const avgGoalProgress = goals.length > 0
    ? Math.round(goals.reduce((sum, g) => sum + g.progress, 0) / goals.length)
    : 0

  // 项目状态分布
  const projectStatuses = [
    { label: '进行中', count: projects.filter(p => p.status === 'in_progress').length, color: 'bg-blue-500' },
    { label: '规划中', count: projects.filter(p => p.status === 'planning').length, color: 'bg-yellow-500' },
    { label: '已完成', count: projects.filter(p => p.status === 'done').length, color: 'bg-green-500' },
    { label: '已归档', count: projects.filter(p => p.status === 'archived').length, color: 'bg-gray-400' },
  ]

  // 日志统计
  const logCount = dailyLogs.length
  const recentLogs = dailyLogs.slice(-7)

  // 最近7天任务完成趋势
  const weekTaskTrend = Array.from({ length: 7 }, (_, i) => {
    const d = new Date()
    d.setDate(d.getDate() - (6 - i))
    const dateStr = localDate(d)
    const dayName = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]
    // 简化：统计所有已完成任务的 updatedAt 在当天的
    const done = doneTasks.filter(t => t.updatedAt.startsWith(dateStr)).length
    return { date: dateStr, day: dayName, count: done }
  })
  const maxTaskCount = Math.max(...weekTaskTrend.map(d => d.count), 1)

  return (
    <div className="space-y-6">
      {/* 页面标题 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">📊 统计分析</h1>
          <p className="text-sm text-gray-400 mt-0.5">数据驱动的自我管理仪表盘</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setPeriod('week')}
            className={`px-3 py-1.5 rounded-lg text-xs transition-colors ${period === 'week' ? 'bg-blue-600 text-white' : 'bg-white text-gray-500 border border-gray-200'}`}
          >
            本周
          </button>
          <button
            onClick={() => setPeriod('month')}
            className={`px-3 py-1.5 rounded-lg text-xs transition-colors ${period === 'month' ? 'bg-blue-600 text-white' : 'bg-white text-gray-500 border border-gray-200'}`}
          >
            本月
          </button>
        </div>
      </div>

      {/* 核心指标卡片 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={<CheckCircle2 size={20} />}
          label="任务完成率"
          value={`${completionRate}%`}
          subtext={`${doneTasks.length}/${tasks.length} 个任务`}
          color="from-blue-500 to-blue-600"
        />
        <StatCard
          icon={<Clock size={20} />}
          label="今日专注"
          value={`${todayPomo.minutes}分钟`}
          subtext={`${todayPomo.completed} 个番茄钟`}
          color="from-orange-500 to-red-500"
        />
        <StatCard
          icon={<Target size={20} />}
          label="目标平均进度"
          value={`${avgGoalProgress}%`}
          subtext={`${activeGoals.length} 个进行中`}
          color="from-purple-500 to-purple-600"
        />
        <StatCard
          icon={<Flame size={20} />}
          label="本周专注"
          value={`${totalFocusMinutes}分钟`}
          subtext={`${weekPomo.length} 个番茄钟`}
          color="from-green-500 to-teal-500"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 任务完成趋势 */}
        <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100">
          <h2 className="text-lg font-semibold text-gray-800 flex items-center gap-2 mb-5">
            <TrendingUp size={18} className="text-blue-500" />
            最近7天任务完成趋势
          </h2>
          <div className="flex items-end justify-between gap-2 h-40">
            {weekTaskTrend.map((d, i) => (
              <div key={i} className="flex-1 flex flex-col items-center gap-2">
                <div className="w-full flex-1 flex items-end">
                  <div
                    className="w-full bg-gradient-to-t from-blue-500 to-blue-400 rounded-t-lg transition-all hover:from-blue-600 hover:to-blue-500 relative group"
                    style={{ height: `${(d.count / maxTaskCount) * 100}%`, minHeight: d.count > 0 ? '8px' : '2px' }}
                  >
                    <span className="absolute -top-5 left-1/2 -translate-x-1/2 text-[10px] text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity">
                      {d.count}
                    </span>
                  </div>
                </div>
                <span className="text-[10px] text-gray-400">{d.day}</span>
              </div>
            ))}
          </div>
        </div>

        {/* 项目状态分布 */}
        <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100">
          <h2 className="text-lg font-semibold text-gray-800 flex items-center gap-2 mb-5">
            <BarChart3 size={18} className="text-purple-500" />
            项目状态分布
          </h2>
          <div className="space-y-4">
            {projectStatuses.map(s => {
              const max = Math.max(...projectStatuses.map(p => p.count), 1)
              return (
                <div key={s.label}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-sm text-gray-600">{s.label}</span>
                    <span className="text-xs text-gray-400">{s.count} 个</span>
                  </div>
                  <div className="w-full bg-gray-100 rounded-full h-2.5">
                    <div
                      className={`h-2.5 rounded-full ${s.color} transition-all`}
                      style={{ width: `${(s.count / max) * 100}%` }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
          <div className="mt-6 pt-4 border-t border-gray-100 flex items-center justify-between">
            <span className="text-xs text-gray-400">总项目数</span>
            <span className="text-lg font-bold text-gray-800">{projects.length}</span>
          </div>
        </div>
      </div>

      {/* 习惯打卡热力图 */}
      <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100">
        <h2 className="text-lg font-semibold text-gray-800 flex items-center gap-2 mb-5">
          <Calendar size={18} className="text-green-500" />
          习惯打卡热力图（近30天）
        </h2>
        <div className="flex gap-1 flex-wrap">
          {habitHeatmap.map((d, i) => {
            const intensity = d.total > 0 ? d.count / d.total : 0
            const bg = intensity === 0 ? 'bg-gray-100' :
                       intensity <= 0.33 ? 'bg-green-200' :
                       intensity <= 0.66 ? 'bg-green-400' : 'bg-green-600'
            return (
              <div
                key={i}
                className={`w-7 h-7 rounded ${bg} transition-transform hover:scale-110 cursor-default relative group`}
                title={`${d.date}: ${d.count}/${d.total} 个习惯`}
              />
            )
          })}
        </div>
        <div className="flex items-center gap-2 mt-4 text-xs text-gray-400">
          <span>少</span>
          <div className="w-4 h-4 rounded bg-gray-100" />
          <div className="w-4 h-4 rounded bg-green-200" />
          <div className="w-4 h-4 rounded bg-green-400" />
          <div className="w-4 h-4 rounded bg-green-600" />
          <span>多</span>
        </div>
      </div>

      {/* 目标进度概览 + 日志统计 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 目标进度 */}
        <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100">
          <h2 className="text-lg font-semibold text-gray-800 flex items-center gap-2 mb-5">
            <Target size={18} className="text-purple-500" />
            目标进度概览
          </h2>
          {goals.length === 0 ? (
            <div className="text-center py-8 text-gray-400 text-sm">暂无目标数据</div>
          ) : (
            <div className="space-y-4">
              {goals.slice(0, 5).map(g => (
                <div key={g.id}>
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2">
                      <span>{g.emoji}</span>
                      <span className="text-sm text-gray-700">{g.title}</span>
                    </div>
                    <span className="text-xs text-gray-400">{g.progress}%</span>
                  </div>
                  <div className="w-full bg-gray-100 rounded-full h-2">
                    <div
                      className="h-2 rounded-full bg-gradient-to-r from-purple-500 to-blue-500 transition-all"
                      style={{ width: `${g.progress}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 日志统计 */}
        <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100">
          <h2 className="text-lg font-semibold text-gray-800 flex items-center gap-2 mb-5">
            <Award size={18} className="text-orange-500" />
            日志记录统计
          </h2>
          <div className="grid grid-cols-3 gap-4 mb-4">
            <div className="text-center p-4 bg-orange-50 rounded-xl">
              <div className="text-2xl font-bold text-orange-600">{logCount}</div>
              <div className="text-xs text-gray-400 mt-1">总日志数</div>
            </div>
            <div className="text-center p-4 bg-blue-50 rounded-xl">
              <div className="text-2xl font-bold text-blue-600">{recentLogs.length}</div>
              <div className="text-xs text-gray-400 mt-1">本周新增</div>
            </div>
            <div className="text-center p-4 bg-green-50 rounded-xl">
              <div className="text-2xl font-bold text-green-600">
                {logCount > 0 ? Math.round((recentLogs.length / Math.min(logCount, 7)) * 100) : 0}%
              </div>
              <div className="text-xs text-gray-400 mt-1">活跃度</div>
            </div>
          </div>
          {recentLogs.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs text-gray-400 mb-2">最近日志</div>
              {recentLogs.slice(-3).reverse().map(log => (
                <div key={log.id} className="flex items-center gap-3 p-2 bg-gray-50 rounded-lg">
                  <span className="text-lg">{log.mood}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-gray-500">{log.date}</div>
                    <div className="text-xs text-gray-400 truncate">
                      {log.content.slice(0, 50) || '（无内容）'}
                    </div>
                  </div>
                  <div className="text-[10px] text-gray-400">⚡{log.energy}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function StatCard({ icon, label, value, subtext, color }: {
  icon: React.ReactNode
  label: string
  value: string
  subtext: string
  color: string
}) {
  return (
    <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
      <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${color} text-white flex items-center justify-center mb-3`}>
        {icon}
      </div>
      <div className="text-2xl font-bold text-gray-800">{value}</div>
      <div className="text-xs text-gray-500 mt-0.5">{label}</div>
      <div className="text-[10px] text-gray-400 mt-1">{subtext}</div>
    </div>
  )
}
