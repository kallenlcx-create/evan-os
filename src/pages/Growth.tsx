import { useState } from 'react'
import { useStore } from '../store'
import { useCollectionData } from '../hooks/useCollectionData'
import { localDate } from '../utils/date'
import { Plus, Globe, Bot, TrendingUp, Wrench, Clock, BookOpen, Link2, Trash2 } from 'lucide-react'
import type { LearningPath } from '../types'
import Card from '../components/Card'

const statusLabels: Record<LearningPath['status'], { label: string; color: string }> = {
  not_started: { label: '未开始', color: 'bg-gray-100 text-gray-500' },
  learning: { label: '学习中', color: 'bg-blue-100 text-blue-600' },
  practicing: { label: '实践中', color: 'bg-orange-100 text-orange-600' },
  applying: { label: '应用中', color: 'bg-green-100 text-green-600' },
  mastered: { label: '已掌握', color: 'bg-purple-100 text-purple-600' },
}

const categories = [
  { key: 'english', label: '🇬🇧 英语', icon: Globe },
  { key: 'shopify', label: '🛒 Shopify / 独立站', icon: Globe },
  { key: 'ai', label: '🤖 AI / 自动化', icon: Bot },
  { key: 'trade', label: '💼 外贸能力', icon: TrendingUp },
  { key: 'skills', label: '🛠 技能树', icon: Wrench },
]

interface StudyLog {
  id: string
  date: string
  subject: string
  duration: number
  notes: string
}

interface Resource {
  id: string
  title: string
  url: string
  category: string
  bookmarked: boolean
}

const LS_KEY = 'evan-os-growth-data'

type SubTab = 'paths' | 'logs' | 'resources'

export default function GrowthPage() {
  const { learningPaths, addLearningPath, updateLearningPathStatus } = useStore()
  const [activeCategory, setActiveCategory] = useState('english')
  const [subTab, setSubTab] = useState<SubTab>('paths')
  const [showForm, setShowForm] = useState(false)
  const [newTitle, setNewTitle] = useState('')

  const DEFAULT_GROWTH = {
    logs: [
      { id: 'l1', date: localDate(), subject: '英语听力', duration: 30, notes: 'BBC 6 Minute English，完成2集' },
      { id: 'l2', date: localDate(), subject: 'Shopify 主题开发', duration: 45, notes: '学习 Liquid 模板语法' },
    ] as StudyLog[],
    resources: [
      { id: 'r1', title: 'Shopify 官方文档', url: 'https://shopify.dev', category: 'shopify', bookmarked: true },
      { id: 'r2', title: 'BBC Learning English', url: 'https://bbc.co.uk/learningenglish', category: 'english', bookmarked: true },
      { id: 'r3', title: 'AI for Work (提示词库)', url: 'https://aiforwork.com', category: 'ai', bookmarked: true },
    ] as Resource[],
  }

  const [growth, setGrowth] = useCollectionData(
    LS_KEY,
    ['study_log', 'study_resource'] as const,
    (raw: any) => ({ study_log: raw?.logs, study_resource: raw?.resources }),
    DEFAULT_GROWTH,
  )
  const [newLog, setNewLog] = useState({ subject: '', duration: '', notes: '' })
  const [newResource, setNewResource] = useState({ title: '', url: '', category: 'english' })

  const handleAdd = () => {
    if (!newTitle.trim()) return
    addLearningPath({ title: newTitle.trim() })
    setNewTitle('')
    setShowForm(false)
  }

  const addLog = () => {
    if (!newLog.subject.trim()) return
    const log: StudyLog = { id: Date.now().toString(), date: localDate(), subject: newLog.subject, duration: Number(newLog.duration) || 0, notes: newLog.notes }
    setGrowth(g => ({ ...g, logs: [log, ...g.logs] }))
    setNewLog({ subject: '', duration: '', notes: '' }); setShowForm(false)
  }

  const addResource = () => {
    if (!newResource.title.trim()) return
    const r: Resource = { id: Date.now().toString(), title: newResource.title, url: newResource.url, category: newResource.category, bookmarked: true }
    setGrowth(g => ({ ...g, resources: [...g.resources, r] }))
    setNewResource({ title: '', url: '', category: 'english' }); setShowForm(false)
  }

  const deleteLog = (id: string) => setGrowth(g => ({ ...g, logs: g.logs.filter(l => l.id !== id) }))
  const deleteResource = (id: string) => setGrowth(g => ({ ...g, resources: g.resources.filter(r => r.id !== id) }))

  const grouped = [
    { status: 'not_started' as const, items: learningPaths.filter(l => l.status === 'not_started') },
    { status: 'learning' as const, items: learningPaths.filter(l => l.status === 'learning') },
    { status: 'practicing' as const, items: learningPaths.filter(l => l.status === 'practicing') },
    { status: 'applying' as const, items: learningPaths.filter(l => l.status === 'applying') },
    { status: 'mastered' as const, items: learningPaths.filter(l => l.status === 'mastered') },
  ]

  // 本周学习时长统计
  const today = new Date()
  const weekStart = new Date(today)
  weekStart.setDate(today.getDate() - today.getDay() + 1)
  const weekLogs = growth.logs.filter(l => new Date(l.date) >= weekStart)
  const weekMinutes = weekLogs.reduce((sum, l) => sum + l.duration, 0)

  const inputClass = 'w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-200'

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">📚 成长</h1>
          <p className="text-sm text-gray-400 mt-0.5">学习 → 实践 → 结果 → 复盘 → 能力</p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition-colors"
        >
          <Plus size={16} /> {subTab === 'paths' ? '添加学习' : subTab === 'logs' ? '记录学习' : '添加资源'}
        </button>
      </div>

      {/* 子标签 */}
      <div role="tablist" className="flex gap-2">
        {([
          { key: 'paths' as const, label: '🛤️ 学习路径', icon: BookOpen },
          { key: 'logs' as const, label: '📝 学习日志', icon: Clock },
          { key: 'resources' as const, label: '🔗 资源库', icon: Link2 },
        ]).map(t => (
          <button
            key={t.key}
            role="tab"
            aria-selected={subTab === t.key}
            tabIndex={subTab === t.key ? 0 : -1}
            onClick={() => { setSubTab(t.key); setShowForm(false) }}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-full text-sm transition-colors ${
              subTab === t.key ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-100 border border-gray-200'
            }`}
          >
            <t.icon size={14} />
            {t.label}
          </button>
        ))}
      </div>

      {/* ====== 学习路径 ====== */}
      {subTab === 'paths' && (
        <>
          {/* 分类 */}
          <div role="tablist" className="flex gap-2 overflow-x-auto pb-2">
            {categories.map(cat => (
              <button
                key={cat.key}
                role="tab"
                aria-selected={activeCategory === cat.key}
                tabIndex={activeCategory === cat.key ? 0 : -1}
                onClick={() => setActiveCategory(cat.key)}
                className={`flex items-center gap-1.5 px-4 py-2 rounded-full text-sm whitespace-nowrap transition-colors ${
                  activeCategory === cat.key ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-100 border border-gray-200'
                }`}
              >
                <cat.icon size={14} />
                {cat.label}
              </button>
            ))}
          </div>

          {showForm && (
            <Card className="p-4 flex gap-2">
              <input
                type="text"
                value={newTitle}
                onChange={e => setNewTitle(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAdd()}
                placeholder="学习主题..."
                className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-200"
                autoFocus
              />
              <button
                onClick={handleAdd}
                disabled={!newTitle.trim()}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-40"
              >
                添加
              </button>
            </Card>
          )}

          {/* 学习路径看板 */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
            {grouped.map(group => (
              <div key={group.status} className="bg-white rounded-xl border border-gray-100 shadow-sm min-h-[150px]">
                <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
                  <span className="text-xs font-semibold text-gray-500">{statusLabels[group.status].label}</span>
                  <span className="text-[10px] text-gray-400">{group.items.length}</span>
                </div>
                <div className="p-2 space-y-2">
                  {group.items.map(lp => (
                    <div key={lp.id} className="p-3 bg-gray-50 rounded-lg group">
                      <div className="flex items-center gap-2">
                        <span className="text-lg">{lp.emoji}</span>
                        <span className="text-sm text-gray-700 flex-1">{lp.title}</span>
                        <select
                          value={lp.status}
                          onChange={e => updateLearningPathStatus(lp.id, e.target.value as LearningPath['status'])}
                          className="text-[10px] border border-gray-200 rounded px-1 py-0.5 bg-white opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity"
                        >
                          {Object.entries(statusLabels).map(([k, v]) => (
                            <option key={k} value={k}>{v.label}</option>
                          ))}
                        </select>
                      </div>
                      {lp.notes && (
                        <p className="text-[11px] text-gray-400 mt-1 ml-7">{lp.notes}</p>
                      )}
                    </div>
                  ))}
                  {group.items.length === 0 && (
                    <div className="p-3 text-center text-xs text-gray-300">-</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ====== 学习日志 ====== */}
      {subTab === 'logs' && (
        <div className="space-y-4">
          {/* 本周统计 */}
          <div className="grid grid-cols-3 gap-4">
            <Card className="p-5">
              <div className="text-3xl font-bold text-blue-600">{weekMinutes}</div>
              <div className="text-xs text-gray-400 mt-1">本周学习分钟</div>
            </Card>
            <Card className="p-5">
              <div className="text-3xl font-bold text-green-600">{weekLogs.length}</div>
              <div className="text-xs text-gray-400 mt-1">本周学习次数</div>
            </Card>
            <Card className="p-5">
              <div className="text-3xl font-bold text-orange-600">{growth.logs.length}</div>
              <div className="text-xs text-gray-400 mt-1">累计学习记录</div>
            </Card>
          </div>

          {showForm && (
            <Card className="p-5 space-y-3">
              <h3 className="text-sm font-semibold text-gray-700">记录学习</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <input value={newLog.subject} onChange={e => setNewLog({ ...newLog, subject: e.target.value })} placeholder="学习主题" className={inputClass} autoFocus />
                <input value={newLog.duration} onChange={e => setNewLog({ ...newLog, duration: e.target.value })} placeholder="时长（分钟）" type="number" className={inputClass} />
              </div>
              <textarea value={newLog.notes} onChange={e => setNewLog({ ...newLog, notes: e.target.value })} placeholder="学到了什么..." rows={2} className={inputClass} />
              <button onClick={addLog} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">记录</button>
            </Card>
          )}

          {/* 日志列表 */}
          <Card className="overflow-hidden">
            {growth.logs.map((log, idx) => (
              <div key={log.id} className={`flex items-center gap-4 p-4 group hover:bg-gray-50 transition-colors ${idx > 0 ? 'border-t border-gray-50' : ''}`}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-sm font-medium text-gray-800">{log.subject}</span>
                    <span className="text-[10px] text-gray-400">{log.date}</span>
                  </div>
                  {log.notes && <p className="text-xs text-gray-500">{log.notes}</p>}
                </div>
                <div className="text-right">
                  <div className="text-sm font-bold text-blue-600">{log.duration}</div>
                  <div className="text-[10px] text-gray-400">分钟</div>
                </div>
                <button onClick={() => deleteLog(log.id)} className="opacity-100 md:opacity-0 md:group-hover:opacity-100 text-gray-300 hover:text-red-500 transition-all">
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            {growth.logs.length === 0 && (
              <div className="p-12 text-center text-gray-400 text-sm">暂无学习日志</div>
            )}
          </Card>
        </div>
      )}

      {/* ====== 资源库 ====== */}
      {subTab === 'resources' && (
        <div className="space-y-4">
          {showForm && (
            <Card className="p-5 space-y-3">
              <h3 className="text-sm font-semibold text-gray-700">添加资源</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <input value={newResource.title} onChange={e => setNewResource({ ...newResource, title: e.target.value })} placeholder="资源名称" className={inputClass} autoFocus />
                <input value={newResource.url} onChange={e => setNewResource({ ...newResource, url: e.target.value })} placeholder="URL" className={inputClass} />
                <select value={newResource.category} onChange={e => setNewResource({ ...newResource, category: e.target.value })} className={inputClass}>
                  {categories.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
                </select>
              </div>
              <button onClick={addResource} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">添加</button>
            </Card>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {growth.resources.map(r => {
              const cat = categories.find(c => c.key === r.category)
              return (
                <Card className="p-5 group">
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-lg">{cat?.label.split(' ')[0] || '🔗'}</span>
                      <h3 className="font-semibold text-gray-800 text-sm">{r.title}</h3>
                    </div>
                    <button onClick={() => deleteResource(r.id)} className="opacity-100 md:opacity-0 md:group-hover:opacity-100 text-gray-300 hover:text-red-500 transition-all">
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-500 hover:text-blue-700 hover:underline break-all">
                    {r.url}
                  </a>
                  <div className="mt-2">
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">{cat?.label || '通用'}</span>
                  </div>
                </Card>
              )
            })}
            {growth.resources.length === 0 && (
              <div className="col-span-full text-center py-12 text-gray-400 text-sm">暂无资源</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
