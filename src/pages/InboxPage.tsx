// ====== InboxPage — 收件箱管理 ======
// QuickCapture / AI 捕获的条目在此分拣：转任务 / 转知识 / 转想法 / 删除
// 组织者 Agent 的 AI 标注（aiCategory/aiTags）一并展示

import { useState, useEffect, useCallback } from 'react'
import {
  Inbox as InboxIcon, Trash2, CheckCircle2, BookPlus,
  Lightbulb, ListTodo, Sparkles, Inbox,
} from 'lucide-react'
import { db } from '../db'
import { useStore } from '../store'
import { processInbox, deleteInboxItem } from '../repositories/inboxRepository'
import type { InboxItem } from '../types'

const typeEmoji: Record<string, string> = {
  quick_note: '📝', task: '✅', idea: '💡', link: '🔗',
}

export default function InboxPage() {
  const addObject = useStore(s => s.addObject)
  const [items, setItems] = useState<InboxItem[]>([])
  const [busyId, setBusyId] = useState('')

  const refresh = useCallback(async () => {
    const rows = await db.inbox.toArray()
    rows.sort((a, b) => {
      if (a.processed !== b.processed) return a.processed ? 1 : -1
      return b.capturedAt.localeCompare(a.capturedAt)
    })
    setItems(rows)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // 经 store 写入：IndexedDB + zustand + 搜索索引三处同步，其他页面立即可见
  const convert = async (item: InboxItem, target: 'task' | 'knowledge' | 'inspiration') => {
    setBusyId(item.id)
    try {
      let id = ''
      if (target === 'task') {
        id = await addObject('task', { title: item.content.slice(0, 40) })
      } else if (target === 'knowledge') {
        const aiTags = (item.metadata as any)?.aiTags ?? []
        id = await addObject('knowledge', {
          title: item.content.slice(0, 30),
          content: item.content,
          category: (item.metadata as any)?.aiCategory ?? 'inbox',
          tags: aiTags,
        })
      } else {
        id = await addObject('inspiration', {
          title: item.content.slice(0, 30),
          description: item.content,
          status: 'captured',
        })
      }
      if (id) await processInbox(item.id, target, id)
    } finally {
      setBusyId('')
      refresh()
    }
  }

  const handleDelete = async (id: string) => {
    await deleteInboxItem(id)
    refresh()
  }

  const pending = items.filter(i => !i.processed)
  const processed = items.filter(i => i.processed)

  const renderCard = (item: InboxItem, isProcessed: boolean) => {
    const meta = (item.metadata ?? {}) as any
    return (
      <div key={item.id} className={`bg-white border rounded-xl p-3.5 ${isProcessed ? 'border-gray-100 opacity-60' : 'border-gray-200'}`}>
        <div className="flex items-start gap-2.5">
          <span className="text-xl shrink-0">{typeEmoji[item.type] ?? '📝'}</span>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-gray-700 leading-relaxed break-words">{item.content}</p>
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              {meta.aiCategory && (
                <span className="px-1.5 py-0.5 bg-purple-50 text-purple-500 rounded text-[10px]">
                  <Sparkles size={9} className="inline mr-0.5" />{meta.aiCategory}
                </span>
              )}
              {(meta.aiTags ?? []).map((t: string) => (
                <span key={t} className="px-1.5 py-0.5 bg-gray-100 text-gray-400 rounded text-[10px]">{t}</span>
              ))}
              <span className="text-[10px] text-gray-300">{new Date(item.capturedAt).toLocaleString()}</span>
              {isProcessed && item.processedType && (
                <span className="px-1.5 py-0.5 bg-green-50 text-green-500 rounded text-[10px]">
                  已转 {item.processedType}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* 操作区 */}
        <div className="flex items-center gap-1.5 mt-2.5 pl-8">
          {!isProcessed ? (
            <>
              <button
                onClick={() => convert(item, 'task')}
                disabled={busyId === item.id}
                className="flex items-center gap-1 px-2.5 py-1.5 bg-green-50 text-green-600 rounded-lg text-xs hover:bg-green-100 disabled:opacity-40"
              >
                <ListTodo size={12} /> 转任务
              </button>
              <button
                onClick={() => convert(item, 'knowledge')}
                disabled={busyId === item.id}
                className="flex items-center gap-1 px-2.5 py-1.5 bg-indigo-50 text-indigo-600 rounded-lg text-xs hover:bg-indigo-100 disabled:opacity-40"
              >
                <BookPlus size={12} /> 转知识
              </button>
              <button
                onClick={() => convert(item, 'inspiration')}
                disabled={busyId === item.id}
                className="flex items-center gap-1 px-2.5 py-1.5 bg-yellow-50 text-yellow-600 rounded-lg text-xs hover:bg-yellow-100 disabled:opacity-40"
              >
                <Lightbulb size={12} /> 转想法
              </button>
              <button
                onClick={() => handleDelete(item.id)}
                className="ml-auto p-1.5 text-gray-300 hover:text-red-500 rounded-lg hover:bg-red-50"
                title="删除"
              >
                <Trash2 size={13} />
              </button>
            </>
          ) : (
            <span className="flex items-center gap-1 text-[10px] text-gray-300">
              <CheckCircle2 size={11} /> 已处理
            </span>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-2 mb-1">
        <InboxIcon size={22} className="text-sky-500" />
        <h1 className="text-xl font-bold text-gray-800">收件箱</h1>
        {pending.length > 0 && (
          <span className="px-2 py-0.5 bg-sky-100 text-sky-600 rounded-full text-[10px] font-bold">{pending.length} 待处理</span>
        )}
      </div>
      <p className="text-xs text-gray-400 mb-5">
        快速捕获与 AI 收集的条目在此分拣。知识整理助手会自动标注分类——你只需决定流向。
      </p>

      {items.length === 0 ? (
        <div className="text-center py-16">
          <Inbox size={36} className="mx-auto text-gray-200 mb-3" />
          <p className="text-sm text-gray-400">收件箱是空的</p>
          <p className="text-[11px] text-gray-300 mt-1">用底部「快速捕获」或 AI 实验室随手记录</p>
        </div>
      ) : (
        <div className="space-y-5">
          {pending.length > 0 && (
            <div className="space-y-2.5">
              <h3 className="text-[11px] font-medium text-gray-400 uppercase tracking-wider">待处理</h3>
              {pending.map(i => renderCard(i, false))}
            </div>
          )}
          {processed.length > 0 && (
            <div className="space-y-2.5">
              <h3 className="text-[11px] font-medium text-gray-400 uppercase tracking-wider">已处理</h3>
              {processed.map(i => renderCard(i, true))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
