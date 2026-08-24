// ====== ContextInspector — 检查 AI 当前看到的上下文 ======
// 原则：透明。用户可以随时查看 AIContext 的完整内容、来源、优先级与预算占用
// 本页面只调用 contextEngine（纯数据组装），不涉及任何模型

import { useState, useEffect, useCallback } from 'react'
import { useLocation } from 'react-router-dom'
import {
  Eye, RefreshCw, ChevronDown, ChevronRight,
  Gauge, Filter, Layers,
} from 'lucide-react'
import { contextEngine, type ContextEngineInput } from '../services/contextEngine'
import { searchService } from '../services/searchService'
import type { AIContext, ContextItem, ObjectType } from '../types'

const typeMeta: Record<string, { label: string; color: string }> = {
  user: { label: '用户', color: 'bg-slate-100 text-slate-600' },
  page: { label: '页面', color: 'bg-gray-100 text-gray-600' },
  object: { label: '焦点对象', color: 'bg-blue-100 text-blue-700' },
  task: { label: '任务', color: 'bg-green-100 text-green-700' },
  project: { label: '项目', color: 'bg-violet-100 text-violet-700' },
  related_object: { label: '关联对象', color: 'bg-cyan-50 text-cyan-600' },
  knowledge: { label: '知识', color: 'bg-indigo-50 text-indigo-600' },
  memory: { label: '记忆', color: 'bg-amber-50 text-amber-700' },
  goal: { label: '目标', color: 'bg-emerald-50 text-emerald-700' },
  event: { label: '事件', color: 'bg-orange-50 text-orange-600' },
}

const objectTypeOptions: { value: ObjectType; label: string }[] = [
  { value: 'knowledge', label: '知识' },
  { value: 'project', label: '项目' },
  { value: 'task', label: '任务' },
  { value: 'goal', label: '目标' },
  { value: 'customer', label: '客户' },
]

const pageLabels: Record<string, string> = {
  '/': '首页', '/goals': '目标', '/work': '工作', '/projects': '项目',
  '/actions': '行动', '/growth': '成长', '/knowledge': '知识与思考',
  '/memory': 'AI 记忆', '/life': '生活', '/ai': 'AI 中心',
  '/stats': '统计分析', '/inspector': 'Context Inspector',
}

function ItemRow({ item }: { item: ContextItem }) {
  const [open, setOpen] = useState(false)
  const meta = typeMeta[item.type] ?? { label: item.type, color: 'bg-gray-100 text-gray-500' }

  return (
    <div className={`border rounded-xl mb-2 overflow-hidden ${
      item.included ? 'border-gray-200 bg-white' : 'border-dashed border-gray-200 bg-gray-50 opacity-60'
    }`}>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-gray-50"
      >
        {open ? <ChevronDown size={14} className="text-gray-400 shrink-0" />
               : <ChevronRight size={14} className="text-gray-400 shrink-0" />}
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${meta.color}`}>
          {meta.label}
        </span>
        <span className="text-xs font-medium text-gray-700 truncate flex-1">{item.title}</span>
        {!item.included && (
          <span className="text-[10px] text-red-400 border border-red-200 rounded px-1 shrink-0">超预算</span>
        )}
        <span className="text-[10px] text-gray-400 shrink-0 hidden sm:inline">
          P{item.priority} · R{Math.round(item.relevance * 100)}% · ~{item.tokenEstimate}tok
        </span>
      </button>
      {open && (
        <div className="px-4 pb-3 pt-1 space-y-1.5">
          <p className="text-xs text-gray-600 leading-relaxed whitespace-pre-wrap bg-gray-50 rounded-lg p-2.5">
            {item.content}
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-gray-400">
            <span>source: <code className="text-gray-500">{item.source}</code></span>
            <span>priority: {item.priority}/100</span>
            <span>relevance: {(item.relevance * 100).toFixed(0)}%</span>
            <span>tokens≈{item.tokenEstimate}</span>
            {item.ref && <span>ref: {item.ref.type}:{item.ref.id.slice(0, 10)}…</span>}
          </div>
        </div>
      )}
    </div>
  )
}

export default function ContextInspectorPage() {
  const location = useLocation()
  const [ctx, setCtx] = useState<AIContext | null>(null)
  const [loading, setLoading] = useState(false)
  const [budget, setBudget] = useState(2000)
  const [focusType, setFocusType] = useState<ObjectType>('knowledge')
  const [focusQuery, setFocusQuery] = useState('')
  const [focusId, setFocusId] = useState('')
  const [candidates, setCandidates] = useState<{ id: string; title: string }[]>([])

  const pageLabel = pageLabels[location.pathname] ?? location.pathname
  const input: ContextEngineInput = {
    page: { path: location.pathname, label: pageLabel },
    tokenBudget: budget,
    currentObject: focusId ? { type: focusType, id: focusId } : undefined,
    query: focusQuery || undefined,
  }

  const build = useCallback(async () => {
    setLoading(true)
    try {
      setCtx(await contextEngine.build(input))
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, budget, focusType, focusId, focusQuery])

  useEffect(() => { build() }, [build])

  // 焦点对象搜索
  const searchFocus = async () => {
    await searchService.load()
    const results = searchService.quickSearch(focusQuery || '', [focusType])
    setCandidates(results.map(r => ({ id: r.item.id, title: r.item.title })))
  }
  useEffect(() => {
    if (!focusQuery.trim()) { setCandidates([]); return }
    const t = setTimeout(searchFocus, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusQuery, focusType])

  const includedItems = ctx?.items.filter(i => i.included) ?? []
  const excludedItems = ctx?.items.filter(i => !i.included) ?? []
  const usagePct = ctx ? Math.min(100, Math.round((ctx.tokensUsed / ctx.tokenBudget) * 100)) : 0

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* 标题 */}
      <div className="flex items-center gap-2 mb-1">
        <Eye size={22} className="text-blue-500" />
        <h1 className="text-xl font-bold text-gray-800">Context Inspector</h1>
      </div>
      <p className="text-xs text-gray-400 mb-5">
        查看 AI 当前能看到什么。上下文由 ContextEngine 从本地数据定向收集并按预算裁剪——不会隐式注入全部数据库。
      </p>

      {/* 控制面板 */}
      <div className="bg-white border border-gray-200 rounded-2xl p-4 mb-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {/* 焦点对象类型 */}
          <div>
            <label className="block text-[11px] text-gray-400 mb-1">焦点对象类型</label>
            <select
              value={focusType}
              onChange={e => { setFocusType(e.target.value as ObjectType); setFocusId('') }}
              className="w-full text-sm border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-100"
            >
              {objectTypeOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          {/* 焦点对象搜索 */}
          <div className="relative">
            <label className="block text-[11px] text-gray-400 mb-1">焦点对象</label>
            <input
              value={focusQuery}
              onChange={e => { setFocusQuery(e.target.value); setFocusId('') }}
              placeholder="搜索并选择…"
              className="w-full text-sm border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-100"
            />
            {candidates.length > 0 && (
              <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                {candidates.map(c => (
                  <button
                    key={c.id}
                    onClick={() => { setFocusId(c.id); setFocusQuery(c.title); setCandidates([]) }}
                    className="block w-full text-left px-3 py-2 text-xs hover:bg-blue-50 truncate"
                  >
                    {c.title}
                  </button>
                ))}
              </div>
            )}
          </div>
          {/* Token 预算 */}
          <div>
            <label className="block text-[11px] text-gray-400 mb-1">
              Token 预算：<span className="text-gray-600 font-medium">{budget}</span>
            </label>
            <input
              type="range" min={200} max={6000} step={100}
              value={budget}
              onChange={e => setBudget(Number(e.target.value))}
              className="w-full accent-blue-500"
            />
          </div>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-gray-400">当前页面：<b className="text-gray-500">{pageLabel}</b>（自动检测）</span>
          <button
            onClick={build}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-500 text-white rounded-lg text-xs font-medium hover:bg-blue-600 disabled:opacity-50"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            重建上下文
          </button>
        </div>
      </div>

      {/* 统计条 */}
      {ctx && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
          <div className="bg-white border border-gray-200 rounded-xl p-3">
            <div className="flex items-center gap-1 text-[10px] text-gray-400 mb-0.5"><Gauge size={11} /> Token 用量</div>
            <div className="text-sm font-semibold text-gray-700">{ctx.tokensUsed} / {ctx.tokenBudget}</div>
            <div className="h-1.5 bg-gray-100 rounded-full mt-1.5 overflow-hidden">
              <div className={`h-full ${usagePct > 90 ? 'bg-red-400' : 'bg-blue-500'}`} style={{ width: `${usagePct}%` }} />
            </div>
          </div>
          <div className="bg-white border border-gray-200 rounded-xl p-3">
            <div className="flex items-center gap-1 text-[10px] text-gray-400 mb-0.5"><Layers size={11} /> 进入上下文</div>
            <div className="text-sm font-semibold text-gray-700">{ctx.stats.included} 条</div>
          </div>
          <div className="bg-white border border-gray-200 rounded-xl p-3">
            <div className="flex items-center gap-1 text-[10px] text-gray-400 mb-0.5"><Filter size={11} /> 过滤排除</div>
            <div className="text-sm font-semibold text-gray-700">{ctx.stats.excludedByFilter} 条</div>
          </div>
          <div className="bg-white border border-gray-200 rounded-xl p-3">
            <div className="flex items-center gap-1 text-[10px] text-gray-400 mb-0.5"><Gauge size={11} /> 预算排除</div>
            <div className="text-sm font-semibold text-gray-700">{ctx.stats.excludedByBudget} 条</div>
          </div>
        </div>
      )}

      {/* 渲染后的 Prompt 预览 */}
      {ctx && (
        <details className="mb-4 group">
          <summary className="cursor-pointer text-xs text-gray-500 hover:text-gray-700 select-none">
            ▸ 最终 Prompt 文本预览（{ctx.tokensUsed} tokens）
          </summary>
          <pre className="mt-2 text-[11px] leading-relaxed bg-gray-900 text-gray-100 rounded-xl p-4 overflow-x-auto whitespace-pre-wrap">
{contextEngine.renderPrompt(ctx)}
          </pre>
        </details>
      )}

      {/* Items 列表 */}
      {loading && <div className="text-center text-gray-400 text-sm py-12">构建中...</div>}
      {!loading && ctx && ctx.items.length === 0 && (
        <div className="text-center py-16">
          <div className="text-4xl mb-3 opacity-40">🧊</div>
          <p className="text-sm text-gray-400">没有可注入的上下文项</p>
        </div>
      )}
      {!loading && ctx && (
        <>
          <div className="text-[11px] text-gray-400 mb-2">
            按 Priority 排序（含被预算排除的项，虚线显示）· 构建于 {new Date(ctx.createdAt).toLocaleTimeString()}
          </div>
          {[...includedItems, ...excludedItems].map(item => <ItemRow key={item.id} item={item} />)}
        </>
      )}
    </div>
  )
}
