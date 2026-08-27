// ====== MemoryPage — AI 记忆管理 ======
// 用户对 Memory 拥有完全控制权：查看 / 确认 / 修改 / 删除 / 归档
// AI 建议只出现在"待确认"区，确认前不会进入 AI 上下文
// 注意：Memory ≠ Knowledge，此页面不读写知识库

import { useState, useEffect, useCallback } from 'react'
import {
  Brain, Check, X, Archive, ArchiveRestore, Trash2, Pencil,
  Sparkles, Clock, ShieldCheck, RotateCcw,
} from 'lucide-react'
import { memoryService } from '../services/memoryService'
import { useAskText } from '../components/PromptModal'
import { useConfirm } from '../components/ConfirmModal'
import type { Memory, MemoryStatus, MemoryType } from '../types'

const typeLabels: Record<MemoryType, string> = {
  preference: '偏好', fact: '事实', goal_context: '目标背景',
  workflow: '工作流', correction: '纠正', context: '背景',
}

const statusLabels: Record<MemoryStatus, string> = {
  candidate: '待确认', active: '生效中', expired: '已过期', archived: '已归档',
}

const sourceTypeLabels: Record<string, string> = {
  ai_suggestion: 'AI 建议', conversation: '对话提炼', observation: '行为观察',
  inference: '推理', user_manual: '手动创建',
}

function confidenceColor(c: number): string {
  if (c >= 0.8) return 'bg-green-500'
  if (c >= 0.5) return 'bg-yellow-500'
  return 'bg-orange-400'
}

function timeAgo(iso?: string): string {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

// ====== 记忆卡片 ======

function MemoryCard({
  memory,
  onUpdate, onConfirm, onForget, onArchive, onReactivate, confirm,
}: {
  memory: Memory
  onUpdate: (id: string, content: string) => void
  onConfirm: (id: string) => void
  onForget: (id: string) => void
  onArchive: (id: string) => void
  onReactivate: (id: string) => void
  confirm: (msg: string) => Promise<boolean>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(memory.content)

  return (
    <div className="bg-white border border-gray-100 rounded-xl p-4 shadow-sm hover:shadow-md transition-shadow">
      {/* 头部：类型 + 状态 */}
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <span className="px-2 py-0.5 bg-gray-100 text-gray-600 rounded-md text-[11px] font-medium">
          {typeLabels[memory.type] || memory.type}
        </span>
        <span className={`px-2 py-0.5 rounded-md text-[11px] font-medium ${
          memory.status === 'candidate' ? 'bg-amber-50 text-amber-600' :
          memory.status === 'active' ? 'bg-green-50 text-green-600' :
          memory.status === 'expired' ? 'bg-gray-100 text-gray-500' :
          'bg-blue-50 text-blue-500'
        }`}>
          {statusLabels[memory.status]}
        </span>
        <span className="text-[11px] text-gray-400 ml-auto">{timeAgo(memory.createdAt)}</span>
      </div>

      {/* 内容（查看/编辑） */}
      {editing ? (
        <div className="mb-3">
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            rows={3}
            className="w-full text-sm text-gray-700 border border-gray-200 rounded-lg p-2 focus:outline-none focus:ring-2 focus:ring-blue-100 resize-none"
            autoFocus
          />
        </div>
      ) : (
        <p className="text-sm text-gray-700 leading-relaxed mb-3 whitespace-pre-wrap">{memory.content}</p>
      )}

      {/* 来源 + 置信度 */}
      <div className="flex items-center gap-3 mb-3 text-[11px] text-gray-400 flex-wrap">
        <span className="flex items-center gap-1">
          <ShieldCheck size={12} />
          来源：{sourceTypeLabels[memory.source.type] || memory.source.type}
          {memory.source.actorId ? ` · ${memory.source.actorId}` : ''}
        </span>
        <span className="flex items-center gap-1.5">
          <span>置信度</span>
          <span className="w-14 h-1.5 bg-gray-100 rounded-full overflow-hidden inline-block">
            <span
              className={`h-full ${confidenceColor(memory.confidence)} ${memory.status === 'candidate' ? 'opacity-60' : ''}`}
              style={{ width: `${Math.round(memory.confidence * 100)}%` }}
            />
          </span>
          <span>{Math.round(memory.confidence * 100)}%</span>
        </span>
        {(memory.useCount ?? 0) > 0 && (
          <span>被使用 {memory.useCount} 次</span>
        )}
      </div>

      {/* 操作区 */}
      <div className="flex items-center gap-1.5">
        {memory.status === 'candidate' && (
          <>
            <button
              onClick={() => onConfirm(memory.id)}
              className="flex items-center gap-1 px-2.5 py-1.5 bg-green-50 text-green-600 rounded-lg text-xs font-medium hover:bg-green-100"
            >
              <Check size={13} /> 确认
            </button>
            <button
              onClick={() => onArchive(memory.id)}
              className="flex items-center gap-1 px-2.5 py-1.5 bg-gray-50 text-gray-500 rounded-lg text-xs hover:bg-gray-100"
            >
              <X size={13} /> 忽略
            </button>
          </>
        )}
        {memory.status === 'active' && (
          <button
            onClick={() => onArchive(memory.id)}
            className="flex items-center gap-1 px-2.5 py-1.5 bg-gray-50 text-gray-500 rounded-lg text-xs hover:bg-gray-100"
          >
            <Archive size={13} /> 归档
          </button>
        )}
        {memory.status === 'expired' && (
          <button
            onClick={() => onReactivate(memory.id)}
            className="flex items-center gap-1 px-2.5 py-1.5 bg-blue-50 text-blue-600 rounded-lg text-xs hover:bg-blue-100"
          >
            <RotateCcw size={13} /> 重新激活
          </button>
        )}
        {memory.status === 'archived' && (
          <button
            onClick={() => onReactivate(memory.id)}
            className="flex items-center gap-1 px-2.5 py-1.5 bg-blue-50 text-blue-600 rounded-lg text-xs hover:bg-blue-100"
          >
            <ArchiveRestore size={13} /> 恢复
          </button>
        )}

        <div className="ml-auto flex items-center gap-1">
          {editing ? (
            <>
              <button
                onClick={() => { onUpdate(memory.id, draft); setEditing(false) }}
                disabled={!draft.trim()}
                className="px-2.5 py-1.5 bg-blue-50 text-blue-600 rounded-lg text-xs hover:bg-blue-100 disabled:opacity-40"
              >
                保存
              </button>
              <button
                onClick={() => { setDraft(memory.content); setEditing(false) }}
                className="px-2.5 py-1.5 text-gray-400 text-xs hover:text-gray-600"
              >
                取消
              </button>
            </>
          ) : (
            <button
              onClick={() => setEditing(true)}
              className="p-1.5 text-gray-400 hover:text-blue-500 hover:bg-blue-50 rounded-lg"
              title="修改"
            >
              <Pencil size={14} />
            </button>
          )}
          <button
            onClick={async () => {
              if (await confirm('确定要彻底遗忘这条记忆吗？此操作不可恢复。')) onForget(memory.id)
            }}
            className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg"
            title="删除"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </div>
  )
}

// ====== 主页面 ======

export default function MemoryPage() {
  const [askModal, askText] = useAskText()
  const [confirmModal, confirm] = useConfirm()
  const [memories, setMemories] = useState<Memory[]>([])
  const [tab, setTab] = useState<MemoryStatus>('candidate')
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    memoryService.invalidate()
    await memoryService.load(true)
    const [pending, active, expired, archived] = await Promise.all([
      memoryService.getPendingSuggestions(),
      memoryService.getActiveMemories(),
      memoryService.getExpiredMemories(),
      memoryService.getArchivedMemories(),
    ])
    setMemories([...pending, ...active, ...expired, ...archived])
    setLoading(false)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const handleConfirm = async (id: string) => {
    await memoryService.confirmMemory(id)
    refresh()
  }

  const handleUpdate = async (id: string, content: string) => {
    await memoryService.updateMemory(id, { content })
    refresh()
  }

  const handleForget = async (id: string) => {
    await memoryService.forgetMemory(id)
    refresh()
  }

  const handleArchive = async (id: string) => {
    await memoryService.archiveMemory(id)
    refresh()
  }

  const handleReactivate = async (id: string) => {
    await memoryService.changeStatus(id, 'active')
    refresh()
  }

  // 模拟 AI 建议（Agent Runtime 就绪前的演示入口）
  const simulateSuggestions = async () => {
    await memoryService.suggestMemories([
      {
        type: 'preference',
        content: '用户偏好简洁直接的回复风格，不需要过多解释性文字',
        importance: 0.7,
        tags: ['沟通'],
        scope: ['ai'],
        source: memoryService.makeSource({
          type: 'ai_suggestion',
          excerpt: '（模拟）根据近期对话模式推断',
        }),
      },
      {
        type: 'fact',
        content: '用户主营外贸独立站业务，主要市场为欧美',
        importance: 0.8,
        tags: ['业务'],
        scope: ['ai', 'work'],
        source: memoryService.makeSource({
          type: 'conversation',
          excerpt: '（模拟）来自工作模块使用记录',
        }),
      },
      {
        type: 'correction',
        content: '生成周报时应按项目分组而不是按日期',
        importance: 0.6,
        tags: ['周报'],
        scope: ['ai'],
        source: memoryService.makeSource({
          type: 'inference',
          excerpt: '（模拟）来自复盘操作反馈',
        }),
      },
    ])
    setTab('candidate')
    refresh()
  }

  // 手动添加记忆
  const addManual = async () => {
    const content = await askText('输入记忆内容（将直接生效）：')
    if (!content || !content.trim()) return
    await memoryService.addManualMemory({ type: 'context', content, importance: 0.5 })
    setTab('active')
    refresh()
  }

  const filtered = memories.filter(m => m.status === tab)
  const counts = {
    candidate: memories.filter(m => m.status === 'candidate').length,
    active: memories.filter(m => m.status === 'active').length,
    expired: memories.filter(m => m.status === 'expired').length,
    archived: memories.filter(m => m.status === 'archived').length,
  }

  const tabs: { key: MemoryStatus; label: string; icon?: typeof Clock }[] = [
    { key: 'candidate', label: `待确认${counts.candidate ? ` (${counts.candidate})` : ''}`, icon: Sparkles },
    { key: 'active', label: `生效中${counts.active ? ` (${counts.active})` : ''}` },
    { key: 'expired', label: `已过期${counts.expired ? ` (${counts.expired})` : ''}`, icon: Clock },
    { key: 'archived', label: `已归档${counts.archived ? ` (${counts.archived})` : ''}` },
  ]

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {askModal}
      {confirmModal}
      {/* 标题栏 */}
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <Brain size={22} className="text-indigo-500" />
          <h1 className="text-xl font-bold text-gray-800">AI 记忆</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={simulateSuggestions}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-50 text-indigo-600 rounded-lg text-xs font-medium hover:bg-indigo-100"
            title="Agent Runtime 未接入，用模拟数据演示建议流程"
          >
            <Sparkles size={14} /> 模拟 AI 建议
          </button>
          <button
            onClick={addManual}
            className="px-3 py-1.5 bg-blue-500 text-white rounded-lg text-xs font-medium hover:bg-blue-600"
          >
            手动添加记忆
          </button>
        </div>
      </div>
      <p className="text-xs text-gray-400 mb-5">
        记忆是 AI 的长期上下文，与「知识与思考」相互独立。AI 只能建议，由你确认后才会生效。
      </p>

      {/* Tab 栏 */}
      <div role="tablist" className="flex items-center gap-1 mb-4 border-b border-gray-100 pb-px overflow-x-auto">
        {tabs.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            tabIndex={tab === key ? 0 : -1}
            onClick={() => setTab(key)}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm rounded-t-lg border-b-2 transition-colors whitespace-nowrap ${
              tab === key
                ? 'border-blue-500 text-blue-600 font-medium'
                : 'border-transparent text-gray-400 hover:text-gray-600'
            }`}
          >
            {Icon && <Icon size={14} />}
            {label}
          </button>
        ))}
      </div>

      {/* 列表 */}
      {loading ? (
        <div className="text-center text-gray-400 text-sm py-16">加载中...</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16">
          <div className="text-4xl mb-3 opacity-40">🧠</div>
          <p className="text-sm text-gray-400 mb-1">
            {tab === 'candidate' ? '暂无待确认的 AI 建议' :
             tab === 'active' ? '暂无生效中的记忆' :
             tab === 'expired' ? '暂无过期记忆' : '暂无归档记忆'}
          </p>
          {tab === 'candidate' && (
            <p className="text-[11px] text-gray-300">点击右上角「模拟 AI 建议」体验确认流程</p>
          )}
        </div>
      ) : (
        <div className="grid gap-3">
          {filtered.map(m => (
            <MemoryCard
              key={m.id}
              memory={m}
              onUpdate={handleUpdate}
              onConfirm={handleConfirm}
              onForget={handleForget}
              onArchive={handleArchive}
              onReactivate={handleReactivate}
              confirm={confirm}
            />
          ))}
        </div>
      )}

      {/* 底部说明 */}
      <div className="mt-6 p-3 bg-gray-50 rounded-xl text-[11px] text-gray-400 leading-relaxed">
        <strong className="text-gray-500">状态流转：</strong>
        候选 → 确认 → 生效中 → （到期）已过期 / 归档；任何状态可彻底删除。
        生效中的记忆会按置信度、重要性、最近使用与相关性排序进入 AI 上下文。
      </div>
    </div>
  )
}
