import { useState, useEffect } from 'react'
import { useStore } from '../store'
import { listByKind, migrateLSList, syncKind } from '../repositories/collectionRepository'
import type { CollectionKind } from '../types'
import { DollarSign, Heart, ListTodo, Star, FileText, Check, Plus, TrendingUp, TrendingDown, Trash2, Pencil } from 'lucide-react'
import type { Habit } from '../types'

const sections = [
  { key: 'habits', label: '✅ 习惯', icon: Check, emoji: '✅' },
  { key: 'finance', label: '💰 财务', icon: DollarSign, emoji: '💰' },
  { key: 'health', label: '🏃 健康', icon: Heart, emoji: '🏃' },
  { key: 'plans', label: '📋 生活计划', icon: ListTodo, emoji: '📋' },
  { key: 'wishlist', label: '⭐ 愿望清单', icon: Star, emoji: '⭐' },
  { key: 'records', label: '📝 个人记录', icon: FileText, emoji: '📝' },
]

// v1.1：持久层为 IndexedDB collections（首次自动迁移 LS，幂等）；签名与旧版一致
function useLocalData<T>(key: string, initial: T) {
  const kindMap: Record<string, CollectionKind> = {
    finances: 'finance', wishes: 'wish', health: 'health',
    plans: 'life_plan', records: 'personal_record',
  }
  const kind = kindMap[key] ?? 'personal_record'
  const [data, setData] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(`evan-os-${key}`)
      return raw ? JSON.parse(raw) : initial
    } catch { return initial }
  })
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => {
    ;(async () => {
      try { await migrateLSList(`evan-os-${key}`, kind) } catch { /* ignore */ }
      const rows = await listByKind(kind)
      if (rows.length > 0) setData(rows as T)
      setHydrated(true)
    })()
  }, [key])
  const update = (newData: T) => {
    setData(newData)
    if (hydrated) syncKind(kind, newData as any[]).catch(() => {})
  }
  return [data, update] as const
}

interface FinanceRecord {
  id: string
  type: 'income' | 'expense'
  amount: number
  category: string
  note: string
  date: string
}

interface WishItem {
  id: string
  title: string
  emoji: string
  done: boolean
  createdAt: string
}

interface HealthRecord {
  id: string
  date: string
  type: 'exercise' | 'sleep' | 'weight'
  value: string
  note: string
}

interface LifePlan {
  id: string
  title: string
  category: 'travel' | 'family' | 'social' | 'learning'
  status: 'idea' | 'planning' | 'doing' | 'done'
  createdAt: string
}

interface PersonalRecord {
  id: string
  date: string
  mood: string
  content: string
}

export default function LifePage() {
  const { habits, toggleHabit, addHabit, updateHabit, deleteHabit } = useStore()
  const [newHabitTitle, setNewHabitTitle] = useState('')
  const [newHabitEmoji, setNewHabitEmoji] = useState('')
  const [activeSection, setActiveSection] = useState('habits')
  const today = new Date().toISOString().slice(0, 10)

  // 本地数据
  const [finances, setFinances] = useLocalData<FinanceRecord[]>('finances', [])
  const [wishes, setWishes] = useLocalData<WishItem[]>('wishes', [])
  const [healthRecs, setHealthRecs] = useLocalData<HealthRecord[]>('health', [])
  const [plans, setPlans] = useLocalData<LifePlan[]>('plans', [])
  const [records, setRecords] = useLocalData<PersonalRecord[]>('records', [])

  const renderContent = () => {
    switch (activeSection) {
case 'habits':
return (
<div className="space-y-4">
<div className="bg-white border border-gray-200 rounded-2xl p-4 flex gap-2">
  <input value={newHabitEmoji} onChange={e => setNewHabitEmoji(e.target.value)} placeholder="😀" className="w-12 text-center text-sm border border-gray-200 rounded-lg py-1.5 focus:outline-none" />
  <input value={newHabitTitle} onChange={e => setNewHabitTitle(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && newHabitTitle.trim()) { addHabit({ title: newHabitTitle.trim(), emoji: newHabitEmoji || '✅' }); setNewHabitTitle(''); setNewHabitEmoji('') } }} placeholder="添加习惯，如：每天运动 30 分钟" className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-green-100" />
  <button onClick={() => { if (!newHabitTitle.trim()) return; addHabit({ title: newHabitTitle.trim(), emoji: newHabitEmoji || '✅' }); setNewHabitTitle(''); setNewHabitEmoji('') }} className="px-3 py-1.5 bg-green-500 text-white rounded-lg text-xs hover:bg-green-600">添加</button>
</div>
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
{habits.map((habit: Habit) => {
                const done = habit.completedDates.includes(today)
                const weekDays = ['一', '二', '三', '四', '五', '六', '日']
                const thisWeek = Array.from({ length: 7 }, (_, i) => {
                  const d = new Date()
                  d.setDate(d.getDate() - d.getDay() + 1 + i)
                  return d.toISOString().slice(0, 10)
                })
                return (
                  <div key={habit.id} className={`bg-white rounded-2xl p-5 border ${done ? 'border-green-200' : 'border-gray-100'} shadow-sm`}>
                    <div className="flex items-center gap-3 mb-4">
                      <span className="text-2xl">{habit.emoji}</span>
                      <div className="flex-1">
                        <h3 className="font-semibold text-gray-800 text-sm">{habit.title}</h3>
                        <p className="text-[11px] text-gray-400">🔥 连续 {habit.streak} 天 · {habit.frequency === 'daily' ? '每天' : '每周'}</p>
                      </div>
                      <div className="flex items-center gap-0.5">
                        <button onClick={() => {
                          const title = prompt('修改习惯名称', habit.title ?? ''); if (title === null || !title.trim()) return
                          updateHabit(habit.id, { title: title.trim() })
                        }} className="p-1.5 text-gray-300 hover:text-blue-500" title="编辑">
                          <Pencil size={13} />
                        </button>
                        <button onClick={() => { if (confirm(`删除习惯「${habit.title}」？打卡记录将一并删除`)) deleteHabit(habit.id) }} className="p-1.5 text-gray-300 hover:text-red-500" title="删除">
                          <Trash2 size={13} />
                        </button>
                      </div>
                      <button onClick={() => toggleHabit(habit.id, today)} className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${done ? 'bg-green-500 text-white' : 'bg-gray-100 text-gray-400 hover:bg-gray-200'}`}>
                        <Check size={20} />
                      </button>
                    </div>
                    <div className="flex gap-1.5">
                      {thisWeek.map((date, i) => {
                        const isDone = habit.completedDates.includes(date)
                        const isToday = date === today
                        return (
                          <div key={date} className="flex flex-col items-center gap-1 flex-1">
                            <div className={`w-full aspect-square rounded-md flex items-center justify-center text-[10px] transition-colors ${isDone ? 'bg-green-500 text-white' : isToday ? 'bg-blue-50 text-blue-600 border border-blue-200' : 'bg-gray-100 text-gray-400'}`} onClick={() => toggleHabit(habit.id, date)} style={{ cursor: 'pointer' }}>
                              {isDone ? '✓' : ''}
                            </div>
                            <span className="text-[9px] text-gray-400">{weekDays[i]}</span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )

      case 'finance': {
        const totalIncome = finances.filter(f => f.type === 'income').reduce((s, f) => s + f.amount, 0)
        const totalExpense = finances.filter(f => f.type === 'expense').reduce((s, f) => s + f.amount, 0)
        const balance = totalIncome - totalExpense
        return (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-4">
              <div className="bg-green-50 rounded-xl p-4 text-center">
                <div className="text-xs text-gray-400 mb-1">总收入</div>
                <div className="text-xl font-bold text-green-600 flex items-center justify-center gap-1">
                  <TrendingUp size={16} /> ¥{totalIncome.toLocaleString()}
                </div>
              </div>
              <div className="bg-red-50 rounded-xl p-4 text-center">
                <div className="text-xs text-gray-400 mb-1">总支出</div>
                <div className="text-xl font-bold text-red-600 flex items-center justify-center gap-1">
                  <TrendingDown size={16} /> ¥{totalExpense.toLocaleString()}
                </div>
              </div>
              <div className={`rounded-xl p-4 text-center ${balance >= 0 ? 'bg-blue-50' : 'bg-orange-50'}`}>
                <div className="text-xs text-gray-400 mb-1">结余</div>
                <div className={`text-xl font-bold ${balance >= 0 ? 'text-blue-600' : 'text-orange-600'}`}>¥{balance.toLocaleString()}</div>
              </div>
            </div>

            <FinanceForm onAdd={(rec) => setFinances([...finances, rec])} />

            <div className="space-y-2">
              {finances.length === 0 ? (
                <div className="text-center py-8 text-gray-400 text-sm">暂无财务记录</div>
              ) : (
                finances.slice().reverse().map(f => (
                  <div key={f.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl">
                    <span className={`text-lg ${f.type === 'income' ? 'text-green-500' : 'text-red-500'}`}>{f.type === 'income' ? '📈' : '📉'}</span>
                    <div className="flex-1">
                      <div className="text-sm font-medium text-gray-700">{f.category} {f.note && <span className="text-gray-400">· {f.note}</span>}</div>
                      <div className="text-xs text-gray-400">{f.date}</div>
                    </div>
                    <span className={`text-sm font-bold ${f.type === 'income' ? 'text-green-600' : 'text-red-600'}`}>
                      {f.type === 'income' ? '+' : '-'}¥{f.amount.toLocaleString()}
                    </span>
                    <button onClick={() => {
                      const amount = prompt('修改金额', String(f.amount ?? 0)); if (amount === null) return
                      const note = prompt('修改备注', f.note ?? '') ?? f.note
                      setFinances(finances.map(x => x.id === f.id ? { ...x, amount: Number(amount) || 0, note } : x))
                    }} className="p-1 text-gray-300 hover:text-blue-500" title="编辑">
                      <Pencil size={14} />
                    </button>
                    <button onClick={() => setFinances(finances.filter(x => x.id !== f.id))} className="p-1 text-gray-300 hover:text-red-400">
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        )
      }

      case 'health': {
        return (
          <div className="space-y-4">
            <HealthForm onAdd={(rec) => setHealthRecs([...healthRecs, rec])} />
            <div className="space-y-2">
              {healthRecs.length === 0 ? (
                <div className="text-center py-8 text-gray-400 text-sm">暂无健康记录，开始记录你的运动、睡眠和体重吧</div>
              ) : (
                healthRecs.slice().reverse().map(h => (
                  <div key={h.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl">
                    <span className="text-lg">{h.type === 'exercise' ? '🏃' : h.type === 'sleep' ? '😴' : '⚖️'}</span>
                    <div className="flex-1">
                      <div className="text-sm font-medium text-gray-700">
                        {h.type === 'exercise' ? '运动' : h.type === 'sleep' ? '睡眠' : '体重'}: {h.value}
                      </div>
                      <div className="text-xs text-gray-400">{h.date} {h.note && `· ${h.note}`}</div>
                    </div>
                    <button onClick={() => {
                      const value = prompt('修改数值', h.value ?? ''); if (value === null) return
                      const note = prompt('修改备注', h.note ?? '') ?? h.note
                      setHealthRecs(healthRecs.map(x => x.id === h.id ? { ...x, value, note } : x))
                    }} className="p-1 text-gray-300 hover:text-blue-500" title="编辑">
                      <Pencil size={14} />
                    </button>
                    <button onClick={() => setHealthRecs(healthRecs.filter(x => x.id !== h.id))} className="p-1 text-gray-300 hover:text-red-400">
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        )
      }

      case 'plans': {
        const planCats = [
          { key: 'travel', label: '✈️ 旅行' },
          { key: 'family', label: '👨‍👩‍👧 家庭' },
          { key: 'social', label: '👥 社交' },
          { key: 'learning', label: '📖 学习' },
        ]
        const planStatuses = [
          { key: 'idea', label: '想法', color: 'bg-gray-100 text-gray-500' },
          { key: 'planning', label: '计划中', color: 'bg-yellow-100 text-yellow-600' },
          { key: 'doing', label: '进行中', color: 'bg-blue-100 text-blue-600' },
          { key: 'done', label: '已完成', color: 'bg-green-100 text-green-600' },
        ]
        return (
          <div className="space-y-4">
            <PlanForm cats={planCats} onAdd={(plan) => setPlans([...plans, plan])} />
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {planStatuses.map(ps => (
                <div key={ps.key} className="bg-gray-50 rounded-xl p-3 min-h-[120px]">
                  <div className={`text-xs font-medium px-2 py-1 rounded-full inline-block mb-3 ${ps.color}`}>{ps.label}</div>
                  <div className="space-y-2">
                    {plans.filter(p => p.status === ps.key).map(p => (
                      <div key={p.id} className="bg-white rounded-lg p-3 shadow-sm">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm text-gray-700">{p.title}</span>
                          <div className="flex items-center gap-1">
                            <button onClick={() => {
                              const title = prompt('修改计划', p.title ?? ''); if (title === null || !title.trim()) return
                              setPlans(plans.map(x => x.id === p.id ? { ...x, title: title.trim() } : x))
                            }} className="text-gray-300 hover:text-blue-500" title="编辑">
                              <Pencil size={12} />
                            </button>
                            <button onClick={() => setPlans(plans.filter(x => x.id !== p.id))} className="text-gray-300 hover:text-red-400">
                              <Trash2 size={12} />
                            </button>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-gray-400">{planCats.find(c => c.key === p.category)?.label}</span>
                          <select
                            value={p.status}
                            onChange={e => setPlans(plans.map(x => x.id === p.id ? { ...x, status: e.target.value as LifePlan['status'] } : x))}
                            className="text-[10px] border border-gray-200 rounded px-1 py-0.5 bg-white"
                          >
                            {planStatuses.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                          </select>
                        </div>
                      </div>
                    ))}
                    {plans.filter(p => p.status === ps.key).length === 0 && (
                      <div className="text-center text-xs text-gray-300 py-4">-</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      }

      case 'wishlist': {
        return (
          <div className="space-y-4">
            <WishForm onAdd={(item) => setWishes([...wishes, item])} />
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {wishes.length === 0 ? (
                <div className="col-span-full text-center py-12 text-gray-400 text-sm">暂无愿望清单，记录你想做的事情和想去的地方</div>
              ) : (
                wishes.map(w => (
                  <div key={w.id} className={`bg-white rounded-xl p-4 border ${w.done ? 'border-green-200 bg-green-50' : 'border-gray-100'} shadow-sm`}>
                    <div className="flex items-center gap-3">
                      <span className="text-2xl">{w.done ? '✅' : w.emoji}</span>
                      <div className="flex-1">
                        <div className={`text-sm font-medium ${w.done ? 'text-green-700 line-through' : 'text-gray-700'}`}>{w.title}</div>
                        <div className="text-[10px] text-gray-400">{w.createdAt}</div>
                      </div>
                      <button
                        onClick={() => setWishes(wishes.map(x => x.id === w.id ? { ...x, done: !x.done } : x))}
                        className={`w-8 h-8 rounded-full flex items-center justify-center ${w.done ? 'bg-green-500 text-white' : 'bg-gray-100 text-gray-400 hover:bg-gray-200'}`}
                      >
                        <Check size={16} />
                      </button>
                      <button onClick={() => {
                      const title = prompt('修改愿望', w.title ?? ''); if (title === null || !title.trim()) return
                      setWishes(wishes.map(x => x.id === w.id ? { ...x, title: title.trim() } : x))
                    }} className="p-1 text-gray-300 hover:text-blue-500" title="编辑">
                      <Pencil size={14} />
                    </button>
                    <button onClick={() => setWishes(wishes.filter(x => x.id !== w.id))} className="p-1 text-gray-300 hover:text-red-400">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )
      }

      case 'records': {
        return (
          <div className="space-y-4">
            <RecordForm onAdd={(rec) => setRecords([...records, rec])} />
            <div className="space-y-2">
              {records.length === 0 ? (
                <div className="text-center py-8 text-gray-400 text-sm">暂无个人记录，记录你的成长轨迹和心情变化</div>
              ) : (
                records.slice().reverse().map(r => (
                  <div key={r.id} className="flex items-start gap-3 p-4 bg-gray-50 rounded-xl">
                    <span className="text-2xl">{r.mood}</span>
                    <div className="flex-1">
                      <div className="text-xs text-gray-400 mb-1">{r.date}</div>
                      <div className="text-sm text-gray-700 whitespace-pre-wrap">{r.content}</div>
                    </div>
                    <button onClick={() => {
                      const content = prompt('修改记录内容', r.content ?? ''); if (content === null) return
                      setRecords(records.map(x => x.id === r.id ? { ...x, content } : x))
                    }} className="p-1 text-gray-300 hover:text-blue-500" title="编辑">
                      <Pencil size={14} />
                    </button>
                    <button onClick={() => setRecords(records.filter(x => x.id !== r.id))} className="p-1 text-gray-300 hover:text-red-400">
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        )
      }

      default:
        return null
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-800">🌿 生活</h1>
        <p className="text-sm text-gray-400 mt-0.5">平衡工作与生活，照顾好自己</p>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-2">
        {sections.map(s => (
          <button
            key={s.key}
            onClick={() => setActiveSection(s.key)}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-full text-sm whitespace-nowrap transition-colors ${activeSection === s.key ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-100 border border-gray-200'}`}
          >
            <s.icon size={14} />
            {s.label}
          </button>
        ))}
      </div>
      <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100 min-h-[400px]">
        {renderContent()}
      </div>
    </div>
  )
}

// ===== 子表单组件 =====
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

function FinanceForm({ onAdd }: { onAdd: (rec: FinanceRecord) => void }) {
  const [type, setType] = useState<'income' | 'expense'>('expense')
  const [amount, setAmount] = useState('')
  const [category, setCategory] = useState('')
  const [note, setNote] = useState('')
  const categories = type === 'income'
    ? ['工资', '副业', '投资', '其他收入']
    : ['餐饮', '交通', '购物', '住房', '娱乐', '教育', '医疗', '其他支出']

  const submit = () => {
    if (!amount || !category) return
    onAdd({ id: uid(), type, amount: Number(amount), category, note, date: new Date().toISOString().slice(0, 10) })
    setAmount(''); setCategory(''); setNote('')
  }
  return (
    <div className="bg-gray-50 rounded-xl p-4 space-y-3">
      <div className="flex gap-2">
        <button onClick={() => setType('income')} className={`px-3 py-1.5 rounded-lg text-xs ${type === 'income' ? 'bg-green-500 text-white' : 'bg-white text-gray-500'}`}>收入</button>
        <button onClick={() => setType('expense')} className={`px-3 py-1.5 rounded-lg text-xs ${type === 'expense' ? 'bg-red-500 text-white' : 'bg-white text-gray-500'}`}>支出</button>
      </div>
      <div className="flex gap-2 flex-wrap">
        {categories.map(c => (
          <button key={c} onClick={() => setCategory(c)} className={`px-2.5 py-1 rounded-full text-xs ${category === c ? 'bg-blue-100 text-blue-600' : 'bg-white text-gray-400 border border-gray-200'}`}>{c}</button>
        ))}
      </div>
      <div className="flex gap-2">
        <input type="number" value={amount} onChange={e => setAmount(e.target.value)} placeholder="金额" className="w-28 px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-200" />
        <input type="text" value={note} onChange={e => setNote(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} placeholder="备注（可选）" className="flex-1 px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-200" />
        <button onClick={submit} disabled={!amount || !category} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-40">
          <Plus size={16} />
        </button>
      </div>
    </div>
  )
}

function HealthForm({ onAdd }: { onAdd: (rec: HealthRecord) => void }) {
  const [type, setType] = useState<HealthRecord['type']>('exercise')
  const [value, setValue] = useState('')
  const [note, setNote] = useState('')
  const types = [
    { key: 'exercise', label: '🏃 运动', ph: '如：跑步30分钟' },
    { key: 'sleep', label: '😴 睡眠', ph: '如：7.5小时' },
    { key: 'weight', label: '⚖️ 体重', ph: '如：65.2kg' },
  ]
  const submit = () => {
    if (!value) return
    onAdd({ id: uid(), type, value, note, date: new Date().toISOString().slice(0, 10) })
    setValue(''); setNote('')
  }
  return (
    <div className="bg-gray-50 rounded-xl p-4 space-y-3">
      <div className="flex gap-2">
        {types.map(t => (
          <button key={t.key} onClick={() => setType(t.key as HealthRecord['type'])} className={`px-3 py-1.5 rounded-lg text-xs ${type === t.key ? 'bg-blue-500 text-white' : 'bg-white text-gray-500'}`}>{t.label}</button>
        ))}
      </div>
      <div className="flex gap-2">
        <input type="text" value={value} onChange={e => setValue(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} placeholder={types.find(t => t.key === type)?.ph} className="flex-1 px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-200" />
        <input type="text" value={note} onChange={e => setNote(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} placeholder="备注（可选）" className="flex-1 px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-200" />
        <button onClick={submit} disabled={!value} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-40">
          <Plus size={16} />
        </button>
      </div>
    </div>
  )
}

function WishForm({ onAdd }: { onAdd: (item: WishItem) => void }) {
  const [title, setTitle] = useState('')
  const [emoji, setEmoji] = useState('⭐')
  const emojis = ['⭐', '✈️', '🏝️', '🎁', '🎮', '📚', '🏠', '💰', '🎬', '🍜']
  const submit = () => {
    if (!title.trim()) return
    onAdd({ id: uid(), title: title.trim(), emoji, done: false, createdAt: new Date().toISOString().slice(0, 10) })
    setTitle('')
  }
  return (
    <div className="bg-gray-50 rounded-xl p-4 space-y-3">
      <div className="flex gap-2 flex-wrap">
        {emojis.map(e => (
          <button key={e} onClick={() => setEmoji(e)} className={`w-9 h-9 rounded-lg text-lg ${emoji === e ? 'bg-blue-100 ring-2 ring-blue-300' : 'bg-white'}`}>{e}</button>
        ))}
      </div>
      <div className="flex gap-2">
        <input type="text" value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} placeholder="想做的事情、想去的地方..." className="flex-1 px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-200" />
        <button onClick={submit} disabled={!title.trim()} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-40">
          <Plus size={16} /> 添加
        </button>
      </div>
    </div>
  )
}

function PlanForm({ cats, onAdd }: { cats: { key: string; label: string }[]; onAdd: (plan: LifePlan) => void }) {
  const [title, setTitle] = useState('')
  const [category, setCategory] = useState<LifePlan['category']>('travel')
  const submit = () => {
    if (!title.trim()) return
    onAdd({ id: uid(), title: title.trim(), category, status: 'idea', createdAt: new Date().toISOString().slice(0, 10) })
    setTitle('')
  }
  return (
    <div className="bg-gray-50 rounded-xl p-4 space-y-3">
      <div className="flex gap-2 flex-wrap">
        {cats.map(c => (
          <button key={c.key} onClick={() => setCategory(c.key as LifePlan['category'])} className={`px-3 py-1.5 rounded-lg text-xs ${category === c.key ? 'bg-blue-100 text-blue-600' : 'bg-white text-gray-500 border border-gray-200'}`}>{c.label}</button>
        ))}
      </div>
      <div className="flex gap-2">
        <input type="text" value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} placeholder="生活计划..." className="flex-1 px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-200" />
        <button onClick={submit} disabled={!title.trim()} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-40">
          <Plus size={16} /> 添加
        </button>
      </div>
    </div>
  )
}

function RecordForm({ onAdd }: { onAdd: (rec: PersonalRecord) => void }) {
  const [mood, setMood] = useState('😊')
  const [content, setContent] = useState('')
  const moods = ['😊', '😴', '😤', '🤔', '😢', '🥳', '😎', '😰']
  const submit = () => {
    if (!content.trim()) return
    onAdd({ id: uid(), mood, content: content.trim(), date: new Date().toISOString().slice(0, 10) })
    setContent('')
  }
  return (
    <div className="bg-gray-50 rounded-xl p-4 space-y-3">
      <div className="flex gap-2 flex-wrap">
        {moods.map(m => (
          <button key={m} onClick={() => setMood(m)} className={`w-9 h-9 rounded-lg text-lg ${mood === m ? 'bg-blue-100 ring-2 ring-blue-300' : 'bg-white'}`}>{m}</button>
        ))}
      </div>
      <div className="flex gap-2">
        <input type="text" value={content} onChange={e => setContent(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} placeholder="今天的心情和记录..." className="flex-1 px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-200" />
        <button onClick={submit} disabled={!content.trim()} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-40">
          <Plus size={16} /> 记录
        </button>
      </div>
    </div>
  )
}
