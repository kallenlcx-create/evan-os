// ====== RelationCreator —— 手动建立关系 ======
// 任意两个对象之间创建 Relation（18 种关系类型可选）
// 对象选择复用统一搜索（有界结果）

import { useState, useEffect } from 'react'
import { Link2, Search, X } from 'lucide-react'
import { createRelation } from '../repositories/relationRepository'
import { searchService } from '../services/searchService'
import type { ObjectType, RelationType, SearchKind } from '../types'

const PICK_TYPES: { value: SearchKind; label: string }[] = [
  { value: 'goal', label: '目标' },
  { value: 'project', label: '项目' },
  { value: 'task', label: '任务' },
  { value: 'knowledge', label: '知识' },
  { value: 'customer', label: '客户' },
  { value: 'opportunity', label: '商机' },
  { value: 'order', label: '订单' },
  { value: 'inspiration', label: '灵感' },
  { value: 'question', label: '问题' },
  { value: 'decision', label: '决策' },
  { value: 'process', label: 'SOP' },
]

const RELATION_TYPES: { value: RelationType; label: string }[] = [
  { value: 'related_to', label: '相关' },
  { value: 'references', label: '引用' },
  { value: 'supports', label: '支撑' },
  { value: 'belongs_to', label: '属于' },
  { value: 'contains', label: '包含' },
  { value: 'depends_on', label: '依赖' },
  { value: 'blocked_by', label: '受阻于' },
  { value: 'derived_from', label: '衍生自' },
  { value: 'created_from', label: '创建于' },
  { value: 'caused_by', label: '起因于' },
  { value: 'answers', label: '回答' },
  { value: 'solves', label: '解决' },
  { value: 'tested_by', label: '验证于' },
  { value: 'produces', label: '产出' },
  { value: 'influences', label: '影响' },
  { value: 'follows', label: '跟随' },
  { value: 'duplicates', label: '重复' },
  { value: 'replaces', label: '替代' },
]

interface PickerState {
  type: SearchKind
  query: string
  picked: { id: string; title: string } | null
  candidates: { id: string; title: string; type: SearchKind }[]
}

export default function RelationCreator({ onCreated }: { onCreated?: () => void }) {
  const [open, setOpen] = useState(false)
  const [source, setSource] = useState<PickerState>({ type: 'knowledge', query: '', picked: null, candidates: [] })
  const [target, setTarget] = useState<PickerState>({ type: 'knowledge', query: '', picked: null, candidates: [] })
  const [relType, setRelType] = useState<RelationType>('related_to')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const search = async (which: 'source' | 'target', type: SearchKind, query: string) => {
    await searchService.load()
    const hits = searchService.quickSearch(query, [type]).slice(0, 8)
    const setter = which === 'source' ? setSource : setTarget
    setter(prev => ({ ...prev, candidates: hits.map(h => ({ id: h.item.id, title: h.item.title, type: h.item.type })) }))
  }

  const pick = (which: 'source' | 'target', item: { id: string; title: string }) => {
    const setter = which === 'source' ? setSource : setTarget
    setter(prev => ({ ...prev, picked: item, query: item.title, candidates: [] }))
  }

  const create = async () => {
    setMsg(null)
    if (!source.picked || !target.picked) {
      setMsg({ ok: false, text: '请先选择来源与目标对象' })
      return
    }
    if (source.picked.id === target.picked.id) {
      setMsg({ ok: false, text: '来源与目标不能是同一对象' })
      return
    }
    // SearchKind → ObjectType（关系仅支持核心对象）
    const toObjType = (k: SearchKind): ObjectType | null =>
      (PICK_TYPES.find(t => t.value === k)?.value as ObjectType) ?? null
    const st = toObjType(source.type)
    const tt = toObjType(target.type)
    if (!st || !tt) {
      setMsg({ ok: false, text: '该类型暂不支持建立关系' })
      return
    }
    const r = await createRelation(st, source.picked.id, tt, target.picked.id, relType)
    if (r.ok === false) {
      setMsg({ ok: false, text: r.error })
      return
    }
    setMsg({ ok: true, text: `已建立：${source.picked.title} —${RELATION_TYPES.find(t => t.value === relType)?.label}→ ${target.picked.title}` })
    setSource({ type: source.type, query: '', picked: null, candidates: [] })
    setTarget({ type: target.type, query: '', picked: null, candidates: [] })
    onCreated?.()
  }

  const renderPicker = (which: 'source' | 'target', state: PickerState, label: string) => (
    <div className="flex-1 min-w-0">
      <label className="block text-[10px] text-gray-400 mb-1">{label}</label>
      {state.picked ? (
        <div className="flex items-center gap-1.5 bg-green-50 border border-green-200 rounded-lg px-2.5 py-2">
          <span className="text-xs text-gray-700 truncate flex-1">{state.picked.title}</span>
          <button onClick={() => { const s = which === 'source' ? setSource : setTarget; s(prev => ({ ...prev, picked: null, query: '' })) }} className="text-gray-300 hover:text-red-400">
            <X size={12} />
          </button>
        </div>
      ) : (
        <div className="relative">
          <input
            value={state.query}
            onChange={e => { const v = e.target.value; const s = which === 'source' ? setSource : setTarget; s(prev => ({ ...prev, query: v })); search(which, state.type, v) }}
            onFocus={() => state.query && search(which, state.type, state.query)}
            placeholder="搜索对象…"
            className="w-full text-xs border border-gray-200 rounded-lg px-2.5 py-2 focus:outline-none focus:ring-2 focus:ring-blue-100"
          />
          {state.candidates.length > 0 && (
            <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-40 overflow-y-auto">
              {state.candidates.map(c => (
                <button key={c.id} onClick={() => pick(which, c)} className="block w-full text-left px-2.5 py-1.5 text-xs hover:bg-blue-50 truncate">
                  {c.title}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <select
        value={state.type}
        onChange={e => { const s = which === 'source' ? setSource : setTarget; s(prev => ({ ...prev, type: e.target.value as SearchKind, picked: null, query: '' })) }}
        className="mt-1 w-full text-[10px] text-gray-400 border-0 bg-transparent focus:outline-none cursor-pointer"
      >
        {PICK_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
      </select>
    </div>
  )

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-100 text-gray-600 rounded-lg text-xs hover:bg-gray-200"
      >
        <Link2 size={12} /> 手动建立关系
      </button>
    )
  }

  return (
    <div className="bg-white border border-blue-200 rounded-2xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-bold text-gray-700 flex items-center gap-1.5">
          <Link2 size={13} className="text-blue-500" /> 手动建立关系
        </h4>
        <button onClick={() => setOpen(false)} className="text-gray-300 hover:text-gray-500 text-xs">收起 ✕</button>
      </div>

      <div className="flex items-start gap-2">
        {renderPicker('source', source, '来源')}
        <div className="pt-6 shrink-0">
          <Search size={13} className="text-gray-300 rotate-90" />
        </div>
        {renderPicker('target', target, '目标')}
      </div>

      <div className="flex items-center gap-2">
        <select
          value={relType}
          onChange={e => setRelType(e.target.value as RelationType)}
          className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none"
        >
          {RELATION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}（{t.value}）</option>)}
        </select>
        <button onClick={create} className="px-3 py-1.5 bg-blue-500 text-white rounded-lg text-xs font-medium hover:bg-blue-600">
          建立关系
        </button>
      </div>

      {msg && (
        <p className={`text-[11px] ${msg.ok ? 'text-green-600' : 'text-red-500'}`}>{msg.text}</p>
      )}
    </div>
  )
}
