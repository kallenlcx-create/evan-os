import { useState, useEffect, useRef } from 'react'
import { useStore } from '../store'
import { useConfirm } from '../components/ConfirmModal'
import { Plus, Target, Trash2, Check, ChevronDown, ChevronRight, X } from 'lucide-react'
import type { Goal, KeyResult } from '../types'

/**
 * KR 行：本地受控 + IME 合成隔离 + 防抖入库
 * 修复：中文打字时拼音串被当正文插入导致乱码（如 s'dffkk...）
 * 原理：composition 期间只改本地 draft，compositionEnd / blur / 防抖后才调 handleUpdateKR
 */
function KRRow({
  goalId,
  kr,
  onUpdate,
  onDelete,
}: {
  goalId: string
  kr: KeyResult
  onUpdate: (goalId: string, krId: string, field: keyof KeyResult, value: string | number) => void
  onDelete: (goalId: string, krId: string) => void
}) {
  const [draftTitle, setDraftTitle] = useState(kr.title)
  const [draftUnit, setDraftUnit] = useState(kr.unit)
  const isComposingTitle = useRef(false)
  const isComposingUnit = useRef(false)
  const debounceTitle = useRef<number | null>(null)
  const debounceUnit = useRef<number | null>(null)

  // 外部重置（如撤销/同步）时跟随
  useEffect(() => { setDraftTitle(kr.title) }, [kr.title])
  useEffect(() => { setDraftUnit(kr.unit) }, [kr.unit])

  useEffect(() => {
    return () => {
      if (debounceTitle.current) window.clearTimeout(debounceTitle.current)
      if (debounceUnit.current) window.clearTimeout(debounceUnit.current)
    }
  }, [])

  const commitTitle = (v: string) => {
    if (v !== kr.title) onUpdate(goalId, kr.id, 'title', v)
  }
  const commitUnit = (v: string) => {
    if (v !== kr.unit) onUpdate(goalId, kr.id, 'unit', v)
  }

  const krProgress = Math.min(100, Math.round((kr.current / kr.target) * 100))

  return (
    <div className="bg-white rounded-xl p-3 border border-gray-100">
      <div className="flex items-center gap-2 mb-2">
        <input
          type="text"
          value={draftTitle}
          onCompositionStart={() => { isComposingTitle.current = true }}
          onCompositionEnd={e => {
            isComposingTitle.current = false
            const v = (e.target as HTMLInputElement).value
            setDraftTitle(v)
            if (debounceTitle.current) { window.clearTimeout(debounceTitle.current); debounceTitle.current = null }
            commitTitle(v)
          }}
          onChange={e => {
            const v = e.target.value
            setDraftTitle(v)
            if (isComposingTitle.current) return
            if (debounceTitle.current) window.clearTimeout(debounceTitle.current)
            debounceTitle.current = window.setTimeout(() => commitTitle(v), 400) as unknown as number
          }}
          onBlur={() => {
            if (debounceTitle.current) { window.clearTimeout(debounceTitle.current); debounceTitle.current = null }
            commitTitle(draftTitle)
          }}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          placeholder="关键结果标题..."
          className="flex-1 text-sm font-medium text-gray-700 bg-transparent outline-none border-b border-transparent focus:border-blue-300"
        />
        <button onClick={() => onDelete(goalId, kr.id)} className="p-1 text-gray-300 hover:text-red-500">
          <X size={14} />
        </button>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="number"
          value={kr.current}
          onChange={e => onUpdate(goalId, kr.id, 'current', Number(e.target.value))}
          className="w-16 px-2 py-1 text-sm text-center bg-gray-50 rounded border border-gray-200 outline-none focus:ring-1 focus:ring-blue-200"
        />
        <span className="text-xs text-gray-400">/</span>
        <input
          type="number"
          value={kr.target}
          onChange={e => onUpdate(goalId, kr.id, 'target', Number(e.target.value))}
          className="w-16 px-2 py-1 text-sm text-center bg-gray-50 rounded border border-gray-200 outline-none focus:ring-1 focus:ring-blue-200"
        />
        <input
          type="text"
          value={draftUnit}
          onCompositionStart={() => { isComposingUnit.current = true }}
          onCompositionEnd={e => {
            isComposingUnit.current = false
            const v = (e.target as HTMLInputElement).value
            setDraftUnit(v)
            if (debounceUnit.current) { window.clearTimeout(debounceUnit.current); debounceUnit.current = null }
            commitUnit(v)
          }}
          onChange={e => {
            const v = e.target.value
            setDraftUnit(v)
            if (isComposingUnit.current) return
            if (debounceUnit.current) window.clearTimeout(debounceUnit.current)
            debounceUnit.current = window.setTimeout(() => commitUnit(v), 400) as unknown as number
          }}
          onBlur={() => {
            if (debounceUnit.current) { window.clearTimeout(debounceUnit.current); debounceUnit.current = null }
            commitUnit(draftUnit)
          }}
          className="w-12 px-2 py-1 text-sm text-center bg-gray-50 rounded border border-gray-200 outline-none focus:ring-1 focus:ring-blue-200"
        />
        <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
          <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${krProgress}%` }} />
        </div>
        <span className="text-xs text-gray-500 w-8 text-right">{krProgress}%</span>
        {krProgress >= 100 && <Check size={14} className="text-green-500" />}
      </div>
    </div>
  )
}

const levelLabels: Record<Goal['level'], string> = {
  vision: '人生愿景',
  three_year: '三年目标',
  one_year: '一年目标',
  '90_day': '90天目标',
  current: '当前重点',
}

const levelColors: Record<Goal['level'], string> = {
  vision: 'from-purple-500 to-pink-500',
  three_year: 'from-blue-500 to-purple-500',
  one_year: 'from-green-500 to-blue-500',
  '90_day': 'from-orange-500 to-green-500',
  current: 'from-gray-600 to-gray-400',
}

const levelOrder: Goal['level'][] = ['vision', 'three_year', 'one_year', '90_day', 'current']

export default function GoalsPage() {
  const { goals, addObject, updateObject, deleteObject } = useStore()
  const [confirmModal, confirm] = useConfirm()
  const [showForm, setShowForm] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newLevel, setNewLevel] = useState<Goal['level']>('current')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; title: string; level: Goal['level']; progress: number; deadline: string } | null>(null)

  const handleSaveEdit = async () => {
    if (!editing || !editing.title.trim()) return
    await updateObject('goal', editing.id, {
      title: editing.title.trim(),
      level: editing.level,
      progress: Math.min(100, Math.max(0, editing.progress)),
      deadline: editing.deadline || undefined,
    })
    setEditing(null)
  }

  const handleAdd = () => {
    if (!newTitle.trim()) return
    addObject('goal', { title: newTitle.trim(), level: newLevel, keyResults: [], progress: 0 })
    setNewTitle('')
    setShowForm(false)
  }

  const handleAddKR = (goalId: string) => {
    const goal = goals.find(g => g.id === goalId)
    if (!goal) return
    const newKR: KeyResult = {
      id: Date.now().toString(36),
      title: '新关键结果',
      current: 0,
      target: 100,
      unit: '%',
    }
    updateObject('goal', goalId, { keyResults: [...goal.keyResults, newKR] })
  }

  const handleUpdateKR = (goalId: string, krId: string, field: keyof KeyResult, value: string | number) => {
    const goal = goals.find(g => g.id === goalId)
    if (!goal) return
    const krs = goal.keyResults.map(kr =>
      kr.id === krId ? { ...kr, [field]: value } : kr
    )
    const progress = Math.round(krs.reduce((sum, kr) => sum + Math.min(100, (kr.current / kr.target) * 100), 0) / (krs.length || 1))
    updateObject('goal', goalId, { keyResults: krs, progress })
  }

  const handleDeleteKR = (goalId: string, krId: string) => {
    const goal = goals.find(g => g.id === goalId)
    if (!goal) return
    updateObject('goal', goalId, { keyResults: goal.keyResults.filter(kr => kr.id !== krId) })
  }

  const handleDeleteGoal = async (id: string) => {
    if (!await confirm('确定删除这个目标？相关关键结果也会一起删除。')) return
    deleteObject('goal', id)
  }

  return (
    <div className="space-y-6">
      {confirmModal}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">🎯 目标</h1>
          <p className="text-sm text-gray-400 mt-0.5">从愿景到行动，让每一步都有方向</p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition-colors"
        >
          <Plus size={16} /> 添加目标
        </button>
      </div>

      {showForm && (
        <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100 space-y-3">
          <input
            type="text"
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
            placeholder="目标标题..."
            className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-200"
            autoFocus
          />
          <div className="flex gap-2">
            {levelOrder.map(level => (
              <button
                key={level}
                onClick={() => setNewLevel(level)}
                className={`px-3 py-1.5 rounded-full text-xs transition-colors ${
                  newLevel === level
                    ? 'bg-blue-100 text-blue-700 font-medium'
                    : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                }`}
              >
                {levelLabels[level]}
              </button>
            ))}
          </div>
          <div className="flex justify-end">
            <button onClick={handleAdd} className="px-4 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">
              确认添加
            </button>
          </div>
        </div>
      )}

      {levelOrder.map(level => {
        const items = goals.filter(g => g.level === level)
        if (items.length === 0) return null
        return (
          <div key={level}>
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full bg-gradient-to-r ${levelColors[level]}`} />
              {levelLabels[level]}
              <span className="text-gray-300 normal-case">({items.length})</span>
            </h2>
            <div className="space-y-3">
              {items.map(goal => {
                const expanded = expandedId === goal.id
                return (
                  <div key={goal.id} className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
                    <div className="p-5">
                      <div className="flex items-start gap-3">
                        <button
                          onClick={() => setExpandedId(expanded ? null : goal.id)}
                          className="mt-0.5 text-gray-400 hover:text-gray-600"
                        >
                          {expanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                        </button>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <h3 className="font-semibold text-gray-800">{goal.title}</h3>
                            {goal.deadline && (
                              <span className="text-xs text-gray-400">截止 {goal.deadline}</span>
                            )}
                          </div>
                          {goal.description && (
                            <p className="text-xs text-gray-500 mt-1">{goal.description}</p>
                          )}
                          {/* 进度条 */}
                          <div className="mt-3 flex items-center gap-3">
                            <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                              <div
                                className={`h-full bg-gradient-to-r ${levelColors[goal.level]} rounded-full transition-all`}
                                style={{ width: `${goal.progress}%` }}
                              />
                            </div>
                            <span className="text-sm font-bold text-gray-700 w-10 text-right">{goal.progress}%</span>
                            <button
                              onClick={() => handleDeleteGoal(goal.id)}
                              className="p-1 text-gray-300 hover:text-red-500 transition-colors"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                          {/* KR 摘要 */}
                          {goal.keyResults.length > 0 && !expanded && (
                            <div className="mt-2 flex items-center gap-2 text-xs text-gray-400">
                              <Target size={12} />
                              {goal.keyResults.length} 个关键结果
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

{/* KR 展开区 */}
{expanded && (
<div className="border-t border-gray-50 bg-gray-50/50 p-5 space-y-3">
  {/* 编辑表单 */}
  {editing?.id === goal.id ? (
    <div className="bg-white border border-blue-200 rounded-xl p-3 space-y-2">
      <input value={editing.title} onChange={e => setEditing({ ...editing, title: e.target.value })} placeholder="目标标题" className="w-full text-sm px-2.5 py-1.5 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-100" />
      <div className="flex gap-2 flex-wrap">
        <select value={editing.level} onChange={e => setEditing({ ...editing, level: e.target.value as Goal['level'] })} className="text-xs border border-gray-200 rounded-lg px-2 py-1.5">
          {levelOrder.map(l => <option key={l} value={l}>{levelLabels[l]}</option>)}
        </select>
        <input type="number" min={0} max={100} value={editing.progress} onChange={e => setEditing({ ...editing, progress: Number(e.target.value) })} className="w-20 text-xs border border-gray-200 rounded-lg px-2 py-1.5" title="进度 %" />
        <input type="date" value={editing.deadline ?? ''} onChange={e => setEditing({ ...editing, deadline: e.target.value })} className="text-xs border border-gray-200 rounded-lg px-2 py-1.5" />
      </div>
      <div className="flex gap-2">
        <button onClick={handleSaveEdit} className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs hover:bg-blue-700">保存修改</button>
        <button onClick={() => setEditing(null)} className="px-3 py-1.5 text-gray-400 text-xs">取消</button>
      </div>
    </div>
  ) : (
    <div className="flex items-center justify-between">
      <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">关键结果 (OKR)</span>
      <div className="flex items-center gap-2">
        <button
          onClick={() => setEditing({ id: goal.id, title: goal.title, level: goal.level, progress: goal.progress, deadline: goal.deadline ?? '' })}
          className="text-xs text-gray-500 hover:text-blue-600 flex items-center gap-1"
        >
          ✏️ 编辑
        </button>
        <button
          onClick={() => handleAddKR(goal.id)}
          className="text-xs text-blue-600 hover:text-blue-700 flex items-center gap-1"
        >
          <Plus size={12} /> 添加 KR
        </button>
      </div>
    </div>
  )}
                        {goal.keyResults.length === 0 && (
                          <div className="text-center py-4 text-sm text-gray-400">
                            暂无关键结果，点击上方添加
                          </div>
                        )}
                        {goal.keyResults.map(kr => (
                          <KRRow key={kr.id} goalId={goal.id} kr={kr} onUpdate={handleUpdateKR} onDelete={handleDeleteKR} />
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}

      {goals.length === 0 && !showForm && (
        <div className="text-center py-16">
          <div className="text-5xl mb-4">🎯</div>
          <p className="text-gray-400 text-sm">还没有目标，点击"添加目标"开始规划你的未来</p>
        </div>
      )}
    </div>
  )
}
