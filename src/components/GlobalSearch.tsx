// ====== GlobalSearch — 升级版全局搜索 ======
// 基于 SearchService 统一搜索，支持类型过滤、最近使用、精确/模糊匹配

import { Search, X, Clock, Filter } from 'lucide-react'
import { useState, useEffect, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store'
import { searchService, type SearchScope } from '../services/searchService'
import type { ObjectType } from '../types'

const typeLabel: Record<string, string> = {
  goal: '目标', domain: '领域', project: '项目', task: '任务',
  customer: '客户', opportunity: '商机', order: '订单',
  communication: '沟通', knowledge: '知识', inspiration: '灵感',
  question: '问题', research: '研究', experiment: '实验',
  decision: '决策', review: '复盘', process: '流程',
}

const typeRoute: Record<string, string> = {
  goal: '/goals', project: '/projects', task: '/actions',
  knowledge: '/knowledge', inspiration: '/knowledge', question: '/knowledge',
  research: '/knowledge', experiment: '/knowledge', decision: '/knowledge',
  review: '/actions', process: '/knowledge',
  customer: '/work', opportunity: '/work', order: '/work', communication: '/work',
}

const allTypes: { type: ObjectType; label: string }[] = [
  { type: 'goal', label: '目标' },
  { type: 'project', label: '项目' },
  { type: 'task', label: '任务' },
  { type: 'knowledge', label: '知识' },
  { type: 'customer', label: '客户' },
  { type: 'inspiration', label: '灵感' },
  { type: 'question', label: '问题' },
  { type: 'decision', label: '决策' },
]

const matchTypeBadge: Record<string, { label: string; color: string }> = {
  exact: { label: '精确', color: 'bg-green-100 text-green-600' },
  prefix: { label: '前缀', color: 'bg-blue-100 text-blue-600' },
  fuzzy: { label: '模糊', color: 'bg-gray-100 text-gray-500' },
}

export default function GlobalSearch() {
  const { app, toggleGlobalSearch } = useStore()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ReturnType<typeof searchService.quickSearch>>([])
  const [recent, setRecent] = useState<ReturnType<typeof searchService.getRecent>>([])
  const [activeIdx, setActiveIdx] = useState(0)
  const [showFilters, setShowFilters] = useState(false)
  const [selectedTypes, setSelectedTypes] = useState<Set<ObjectType>>(new Set())
  const [scope, setScope] = useState<SearchScope>('all')
  const inputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()

  useEffect(() => {
    if (app.globalSearchOpen && inputRef.current) {
      inputRef.current.focus()
      setRecent(searchService.getRecent(5))
    }
  }, [app.globalSearchOpen])

  // 搜索（防抖）
  useEffect(() => {
    if (query.trim().length < 1) {
      setResults([])
      return
    }
    const timer = setTimeout(() => {
      const types = selectedTypes.size > 0 ? Array.from(selectedTypes) : undefined
      setResults(searchService.quickSearch(query, types))
      setActiveIdx(0)
    }, 100)
    return () => clearTimeout(timer)
  }, [query, selectedTypes])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx(i => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && results.length > 0) {
      e.preventDefault()
      openItem(results[activeIdx])
    } else if (e.key === 'Escape') {
      toggleGlobalSearch()
    }
  }

  const openItem = (sr: typeof results[0]) => {
    searchService.markRecent(sr.item.id)
    const route = typeRoute[sr.item.type] || '/'
    toggleGlobalSearch()
    navigate(route)
  }

  const toggleType = (type: ObjectType) => {
    setSelectedTypes(prev => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  if (!app.globalSearchOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={toggleGlobalSearch} />
      <div className="relative w-full max-w-xl bg-white rounded-2xl shadow-2xl overflow-hidden">
        {/* 搜索框 */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100">
          <Search size={20} className="text-gray-400 flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索任何内容... (目标、项目、任务、知识等)"
            className="flex-1 text-base outline-none text-gray-800 placeholder-gray-400"
          />
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`p-1.5 rounded-lg transition-colors ${showFilters ? 'bg-blue-50 text-blue-600' : 'text-gray-400 hover:bg-gray-100'}`}
            title="过滤器"
          >
            <Filter size={18} />
          </button>
          <button onClick={toggleGlobalSearch} className="text-gray-400 hover:text-gray-600">
            <X size={20} />
          </button>
        </div>

        {/* 过滤器面板 */}
        {showFilters && (
          <div className="px-4 py-3 bg-gray-50 border-b border-gray-100">
            <div className="flex flex-wrap gap-1.5">
              {allTypes.map(t => (
                <button
                  key={t.type}
                  onClick={() => toggleType(t.type)}
                  className={`px-2.5 py-1 rounded-lg text-xs transition-colors ${
                    selectedTypes.has(t.type)
                      ? 'bg-blue-600 text-white'
                      : 'bg-white text-gray-500 border border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {selectedTypes.size > 0 && (
              <button
                onClick={() => setSelectedTypes(new Set())}
                className="mt-2 text-xs text-gray-400 hover:text-gray-600"
              >
                清除过滤
              </button>
            )}
          </div>
        )}

        {/* 结果列表 */}
        <div className="max-h-[400px] overflow-y-auto p-2">
          {/* 最近使用 */}
          {query.length < 1 && recent.length > 0 && (
            <div className="mb-2">
              <div className="flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-medium text-gray-400 uppercase tracking-wider">
                <Clock size={12} /> 最近使用
              </div>
              {recent.map(item => (
                <div
                  key={item.id}
                  onClick={() => {
                    searchService.markRecent(item.id)
                    const route = typeRoute[item.type] || '/'
                    toggleGlobalSearch()
                    navigate(route)
                  }}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer hover:bg-gray-50 transition-colors"
                >
                  <span className="text-xl">{item.emoji}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-800 truncate">{item.title}</div>
                  </div>
                  <span className="text-[10px] px-2 py-0.5 bg-gray-100 text-gray-500 rounded-full flex-shrink-0">
                    {typeLabel[item.type] || item.type}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* 无输入 */}
          {query.length < 1 && recent.length === 0 && (
            <div className="text-center py-8 text-gray-400 text-sm">
              输入关键词开始搜索...
            </div>
          )}

          {/* 无结果 */}
          {query.length >= 1 && results.length === 0 && (
            <div className="text-center py-8 text-gray-400 text-sm">
              没有找到匹配 "<span className="text-gray-600">{query}</span>" 的内容
            </div>
          )}

          {/* 搜索结果 */}
          {results.map((sr, idx) => {
            const item = sr.item
            const badge = matchTypeBadge[sr.matchType]
            return (
              <div
                key={item.id}
                onClick={() => openItem(sr)}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-colors ${
                  idx === activeIdx ? 'bg-blue-50' : 'hover:bg-gray-50'
                }`}
              >
                <span className="text-xl flex-shrink-0">{item.emoji}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-800 truncate">{item.title}</div>
                  {item.description && (
                    <div className="text-xs text-gray-400 truncate">{item.description}</div>
                  )}
                  {/* 匹配字段 */}
                  {sr.matchedFields.length > 0 && (
                    <div className="flex gap-1 mt-0.5">
                      {sr.matchedFields.slice(0, 3).map(f => (
                        <span key={f} className="text-[9px] px-1 py-0.5 bg-gray-50 text-gray-400 rounded">
                          {f}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1 flex-shrink-0">
                  <span className="text-[10px] px-2 py-0.5 bg-gray-100 text-gray-500 rounded-full">
                    {typeLabel[item.type] || item.type}
                  </span>
                  {badge && (
                    <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${badge.color}`}>
                      {badge.label}
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {/* 底部提示 */}
        <div className="px-4 py-2 bg-gray-50 text-[11px] text-gray-400 flex gap-4">
          <span>↑↓ 导航</span>
          <span>↵ 打开</span>
          <span>Esc 关闭</span>
          {results.length > 0 && (
            <span className="ml-auto">{results.length} 个结果</span>
          )}
        </div>
      </div>
    </div>
  )
}
