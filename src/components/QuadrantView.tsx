import { useStore } from '../store'
import { Check } from 'lucide-react'
import type { Task } from '../types'

const quadrants = [
  { key: 'q1', label: '重要且紧急', emoji: '🔥', bg: 'bg-red-50 border-red-200', dot: 'bg-red-400', tip: '立即去做' },
  { key: 'q2', label: '重要不紧急', emoji: '🎯', bg: 'bg-blue-50 border-blue-200', dot: 'bg-blue-400', tip: '计划去做' },
  { key: 'q3', label: '紧急不重要', emoji: '⚠️', bg: 'bg-yellow-50 border-yellow-200', dot: 'bg-yellow-400', tip: '委托他人' },
  { key: 'q4', label: '不重要不紧急', emoji: '🗑️', bg: 'bg-gray-50 border-gray-200', dot: 'bg-gray-300', tip: '尽量删除' },
] as const

export default function QuadrantView() {
  const { getQuadrantTasks, toggleTaskStatus } = useStore()
  const quadrantsData = getQuadrantTasks()

  const total = quadrantsData.q1.length + quadrantsData.q2.length + quadrantsData.q3.length + quadrantsData.q4.length

  return (
    <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100">
      <h3 className="text-lg font-semibold text-gray-800 mb-1">📊 四象限任务</h3>
      <p className="text-xs text-gray-400 mb-4">艾森豪威尔矩阵 — 共 {total} 个待办任务</p>

      <div className="grid grid-cols-2 gap-3">
        {quadrants.map(q => {
          const tasks = quadrantsData[q.key] as Task[]
          return (
            <div key={q.key} className={`rounded-xl border p-3 ${q.bg}`}>
              <div className="flex items-center gap-2 mb-2">
                <span className={`w-2 h-2 rounded-full ${q.dot}`} />
                <span className="text-xs font-semibold text-gray-700">{q.emoji} {q.label}</span>
                <span className="text-[10px] text-gray-400 ml-auto">{q.tip}</span>
              </div>
              {tasks.length === 0 ? (
                <p className="text-xs text-gray-400 italic py-2 text-center">暂无任务</p>
              ) : (
                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                  {tasks.map(task => (
                    <div
                      key={task.id}
                      onClick={() => toggleTaskStatus(task.id)}
                      className={`flex items-center gap-2 p-2 rounded-lg text-xs cursor-pointer transition-colors ${
                        task.status === 'done'
                          ? 'bg-white/50 line-through text-gray-400'
                          : 'bg-white/80 hover:bg-white text-gray-700'
                      }`}
                    >
                      <div className={`w-3.5 h-3.5 rounded border-2 flex items-center justify-center flex-shrink-0 ${
                        task.status === 'done' ? 'bg-green-400 border-green-400' : 'border-gray-300'
                      }`}>
                        {task.status === 'done' && <Check size={10} className="text-white" />}
                      </div>
                      <span className="truncate">{task.title}</span>
                      {task.importance === 'high' && (
                        <span className="text-[10px] text-blue-500 flex-shrink-0 ml-auto">重要</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}