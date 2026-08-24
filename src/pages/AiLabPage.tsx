// ====== AiLabPage — AI 实验室 ======
// AI 热点漏斗：热点 → AI 摘要 → 值得关注？→ 知识 / 想法 / 研究
// 不建第二套数据系统：热点存于 Inbox（metadata.aiHotspot），转化后走标准对象

import { useState, useEffect, useCallback } from 'react'
import {
  FlaskConical, Sparkles, BookPlus, Lightbulb, Microscope,
  Trash2, CheckCircle2,
} from 'lucide-react'
import { db } from '../db'
import { captureInbox, processInbox } from '../repositories/inboxRepository'
import { createKnowledge } from '../repositories/knowledgeRepository'
import { createObject } from '../repositories/objectRepository'
import type { InboxItem } from '../types'

interface HotspotItem extends InboxItem {
  _summary?: string
}

const convertTargets = [
  { key: 'knowledge', label: '转入知识', icon: BookPlus, color: 'bg-indigo-50 text-indigo-600' },
  { key: 'inspiration', label: '转为想法', icon: Lightbulb, color: 'bg-yellow-50 text-yellow-600' },
  { key: 'research', label: '立项研究', icon: Microscope, color: 'bg-teal-50 text-teal-600' },
] as const

export default function AiLabPage() {
  const [hotspots, setHotspots] = useState<HotspotItem[]>([])
  const [converted, setConverted] = useState(0)
  const [newHotspot, setNewHotspot] = useState('')

  const refresh = useCallback(async () => {
    const items = await db.inbox.filter(i =>
      !i.processed && (i.metadata as any)?.aiHotspot === true).toArray()
    setHotspots(items.map(i => ({ ...i, _summary: (i.metadata as any)?.aiSummary })))
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const addHotspot = async () => {
    if (!newHotspot.trim()) return
    await captureInbox(newHotspot.trim(), 'idea', 'ai_lab', { aiHotspot: true })
    setNewHotspot('')
    refresh()
  }

  // AI 摘要（L1 启发式：提取关键词句；未来由 Provider 生成）
  const summarize = async (item: HotspotItem) => {
    const sentences = item.content.split(/[。.!?！？\n]/).map(s => s.trim()).filter(s => s.length > 6)
    const summary = sentences.slice(0, 2).join('；') || item.content.slice(0, 60)
    const full = await db.inbox.get(item.id)
    if (!full) return
    await db.inbox.put({
      ...full,
      metadata: { ...(full.metadata ?? {}), aiSummary: summary, summarizedAt: new Date().toISOString() },
    })
    refresh()
  }

  // 漏斗出口：转化为标准对象（知识 / 想法 / 研究），并关闭热点
  const convert = async (item: HotspotItem, target: 'knowledge' | 'inspiration' | 'research') => {
    const summary = (item.metadata as any)?.aiSummary ?? ''
    let createdId = ''
    if (target === 'knowledge') {
      const r = await createKnowledge({
        title: item.content.slice(0, 30),
        content: summary ? `摘要：${summary}\n\n原文：${item.content}` : item.content,
        category: 'ai-hotspot',
        tags: ['ai', '热点'],
        source: 'ai-lab',
      })
      if (r.ok) createdId = r.value.id
    } else if (target === 'inspiration') {
      const r = await createObject('inspiration', {
        title: item.content.slice(0, 30),
        description: summary || item.content,
        status: 'captured',
        tags: ['ai', '想法'],
      })
      if (r.ok) createdId = r.value.id
    } else {
      const r = await createObject('research', {
        title: `研究：${item.content.slice(0, 26)}`,
        status: 'planned',
        findings: summary,
      })
      if (r.ok) createdId = r.value.id
    }
    if (createdId) {
      await processInbox(item.id, target, createdId)
      setConverted(c => c + 1)
      refresh()
    }
  }

  const dismiss = async (item: HotspotItem) => {
    await db.inbox.delete(item.id)  // 不值得关注 → 直接丢弃，不进任何库
    refresh()
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-2 mb-1">
        <FlaskConical size={22} className="text-fuchsia-500" />
        <h1 className="text-xl font-bold text-gray-800">AI 实验室</h1>
      </div>
      <p className="text-xs text-gray-400 mb-5">
        热点漏斗：AI 热点 → 摘要 → 值得关注？→ 转入 知识 / 想法 / 研究。
        不直接进入 Memory —— 只有经过筛选的内容才进入知识体系。
      </p>

      {/* 录入 */}
      <div className="flex gap-2 mb-5">
        <input
          value={newHotspot}
          onChange={e => setNewHotspot(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && addHotspot()}
          placeholder="粘贴一条 AI 热点/新闻/工具…"
          className="flex-1 text-sm border border-gray-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-fuchsia-100"
        />
        <button onClick={addHotspot} className="px-4 bg-fuchsia-500 text-white rounded-xl text-xs font-medium hover:bg-fuchsia-600">
          收入实验室
        </button>
      </div>

      {/* 统计 */}
      <div className="flex items-center gap-3 mb-4 text-[11px] text-gray-400">
        <span>待筛选 {hotspots.length} 条</span>
        <span>·</span>
        <span>本次会话已转化 {converted} 条</span>
      </div>

      {/* 热点卡片 */}
      {hotspots.length === 0 ? (
        <div className="text-center py-16">
          <div className="text-4xl mb-3 opacity-40">🧪</div>
          <p className="text-sm text-gray-400">实验室空空如也。录入一条 AI 热点开始筛选。</p>
        </div>
      ) : (
        <div className="space-y-3">
          {hotspots.map(h => (
            <div key={h.id} className="bg-white border border-gray-200 rounded-2xl p-4 shadow-sm">
              <p className="text-sm text-gray-700 leading-relaxed mb-2">{h.content}</p>

              {(h.metadata as any)?.aiSummary ? (
                <div className="mb-3 px-3 py-2 bg-fuchsia-50/60 border border-fuchsia-100 rounded-lg">
                  <div className="flex items-center gap-1 text-[10px] text-fuchsia-500 mb-0.5">
                    <Sparkles size={10} /> AI 摘要
                  </div>
                  <p className="text-xs text-gray-600">{(h.metadata as any).aiSummary}</p>
                </div>
              ) : (
                <button
                  onClick={() => summarize(h)}
                  className="mb-3 flex items-center gap-1 px-2.5 py-1.5 bg-fuchsia-50 text-fuchsia-600 rounded-lg text-xs hover:bg-fuchsia-100"
                >
                  <Sparkles size={12} /> 生成摘要
                </button>
              )}

              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[10px] text-gray-400 mr-1">值得深入？</span>
                {convertTargets.map(t => (
                  <button
                    key={t.key}
                    onClick={() => convert(h, t.key)}
                    className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs ${t.color} hover:brightness-95`}
                  >
                    <t.icon size={12} /> {t.label}
                  </button>
                ))}
                <button
                  onClick={() => dismiss(h)}
                  title="不关注，丢弃"
                  className="ml-auto p-1.5 text-gray-300 hover:text-red-400 hover:bg-red-50 rounded-lg"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 已转化记录提示 */}
      <div className="mt-6 flex items-center gap-1.5 text-[11px] text-gray-300">
        <CheckCircle2 size={12} />
        转化后的内容可在「知识与思考」「成长」「外部集成」对应模块查看；原始热点自动归档。
      </div>
    </div>
  )
}
