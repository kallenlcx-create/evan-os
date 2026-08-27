// ====== AICenterPage — AI 中心（v1.1 聚合版）======
// 六大 AI 能力统一入口：助手 / 智能体 / 记忆 / 上下文 / 工具 / 自动化
// 保留：提示词库 + AI 工具收藏（本地清单）

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Sparkles, Lightbulb, Cpu, Bot,
  MessageSquare, Eye, Plug, Copy, Trash2, Plus, ExternalLink, ArrowRight, Check,
} from 'lucide-react'
import { useCollectionData } from '../hooks/useCollectionData'

// ---------- 本地清单（提示词/工具） ----------

interface PromptItem {
  id: string
  title: string
  category: string
  content: string
}

interface ToolItem {
  id: string
  name: string
  url: string
  category: string
  description: string
}

const LS_KEY = 'evan-os-ai-data'

// ---------- AI 六模块入口 ----------

const hubEntries = [
  { emoji: '🤖', title: 'AI 智能体', desc: '4 个 Agent：整理 / 项目 / 复盘 / 研究', path: '/agents', color: 'from-blue-50 to-indigo-50 border-blue-100' },
  { emoji: '🧠', title: 'AI 记忆', desc: '长期上下文：建议 → 确认 → 生效', path: '/memory', color: 'from-amber-50 to-orange-50 border-amber-100' },
  { emoji: '🧩', title: 'AI 上下文', desc: 'Context Inspector：查看 AI 看到了什么', path: '/inspector', color: 'from-cyan-50 to-sky-50 border-cyan-100' },
  { emoji: '🔌', title: 'AI 工具', desc: 'Gmail / Hermes / Shopify / MCP', path: '/integrations', color: 'from-teal-50 to-emerald-50 border-teal-100' },
  { emoji: '⚡', title: 'AI 自动化', desc: '工作流：触发器 / 条件 / 审批', path: '/workflows', color: 'from-yellow-50 to-lime-50 border-yellow-100' },
  { emoji: '🧪', title: 'AI 实验室', desc: '热点漏斗：摘要 → 值得关注？→ 知识', path: '/ai-lab', color: 'from-fuchsia-50 to-purple-50 border-fuchsia-100' },
]

export default function AICenterPage() {
  const navigate = useNavigate()
  const [tab, setTab] = useState<'hub' | 'prompts' | 'tools'>('hub')
  const [showForm, setShowForm] = useState<'prompt' | 'tool' | ''>('')
  const [searchQuery, setSearchQuery] = useState('')
  const [copiedId, setCopiedId] = useState('')
  const [newPrompt, setNewPrompt] = useState({ title: '', category: '', content: '' })
  const [newTool, setNewTool] = useState({ name: '', url: '', category: '', description: '' })

  const DEFAULT_AI = {
    prompt: [
      { id: 'p1', title: '外贸跟进邮件', category: '外贸', content: '请以专业外贸业务员口吻，给 [客户名] 写一封跟进邮件，关于 [产品] 的报价，语气友好专业，150 词以内。' },
      { id: 'p2', title: '产品描述生成', category: '独立站', content: '为 [产品名] 写一段 Shopify 产品描述：包含 SEO 关键词 [关键词]、3 个卖点、规格参数、行动号召。' },
      { id: 'p3', title: '周报总结', category: '效率', content: '根据以下工作记录，生成一份结构化周报：本周完成 / 下周计划 / 风险与求助。\n记录：' },
    ] as PromptItem[],
    ai_tool: [
      { id: 't1', name: 'ChatGPT', url: 'https://chat.openai.com', category: '对话', description: '通用对话与写作' },
      { id: 't2', name: 'Claude', url: 'https://claude.ai', category: '对话', description: '长文分析与代码' },
      { id: 't3', name: 'Midjourney', url: 'https://midjourney.com', category: '图像', description: '产品图与营销素材' },
      { id: 't4', name: 'n8n', url: 'https://n8n.io', category: '自动化', description: '工作流自动化平台' },
    ] as ToolItem[],
  }

  const [aiData, setAiData] = useCollectionData(
    LS_KEY,
    ['prompt', 'ai_tool'] as const,
    (raw: any) => ({ prompt: raw?.prompts, ai_tool: raw?.tools }),
    DEFAULT_AI,
  )

  const addPrompt = () => {
    if (!newPrompt.title.trim()) return
    const p: PromptItem = { id: Date.now().toString(), ...newPrompt, category: newPrompt.category || '通用' }
    setAiData(d => ({ ...d, prompt: [p, ...d.prompt] }))
    setNewPrompt({ title: '', category: '', content: '' }); setShowForm('')
  }
  const addTool = () => {
    if (!newTool.name.trim()) return
    const t: ToolItem = { id: Date.now().toString(), ...newTool, category: newTool.category || '通用' }
    setAiData(d => ({ ...d, ai_tool: [t, ...d.ai_tool] }))
    setNewTool({ name: '', url: '', category: '', description: '' }); setShowForm('')
  }
  const deletePrompt = (id: string) => setAiData(d => ({ ...d, prompt: d.prompt.filter(p => p.id !== id) }))
  const deleteTool = (id: string) => setAiData(d => ({ ...d, ai_tool: d.ai_tool.filter(t => t.id !== id) }))
  const copyPrompt = (p: PromptItem) => {
    navigator.clipboard?.writeText(p.content).then(() => {
      setCopiedId(p.id); setTimeout(() => setCopiedId(''), 1500)
    }).catch(() => {})
  }

  const inputClass = 'w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-200'
  const filteredPrompts = aiData.prompt.filter(p =>
    !searchQuery || p.title.includes(searchQuery) || p.category.includes(searchQuery) || p.content.includes(searchQuery))
  const filteredTools = aiData.ai_tool.filter(t =>
    !searchQuery || t.name.includes(searchQuery) || t.category.includes(searchQuery) || t.description.includes(searchQuery))

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-2 mb-1">
        <Sparkles size={22} className="text-purple-500" />
        <h1 className="text-xl font-bold text-gray-800">AI 中心</h1>
      </div>
      <p className="text-xs text-gray-400 mb-4">六大 AI 能力统一入口 —— 数据仍遵守四层架构与权限管线。</p>

      {/* Tab 切换 */}
      <div role="tablist" className="flex items-center gap-1 mb-4 overflow-x-auto border-b border-gray-100 pb-px">
        {([
          { key: 'hub', label: '能力入口', icon: Sparkles },
          { key: 'prompts', label: '提示词库', icon: Lightbulb },
          { key: 'tools', label: 'AI 工具收藏', icon: Cpu },
        ] as const).map(t => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            tabIndex={tab === t.key ? 0 : -1}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm rounded-t-lg border-b-2 whitespace-nowrap transition-colors ${
              tab === t.key ? 'border-purple-500 text-purple-600 font-medium' : 'border-transparent text-gray-400 hover:text-gray-600'
            }`}
          >
            <t.icon size={14} /> {t.label}
          </button>
        ))}
      </div>

      {/* ====== 能力入口 ====== */}
      {tab === 'hub' && (
        <div className="grid gap-3 sm:grid-cols-2">
          {hubEntries.map(e => (
            <button
              key={e.path}
              onClick={() => navigate(e.path)}
              className={`text-left bg-gradient-to-br ${e.color} border rounded-2xl p-4 hover:shadow-md transition-shadow group`}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-2xl">{e.emoji}</span>
                <span className="text-sm font-bold text-gray-800">{e.title}</span>
                <ArrowRight size={14} className="ml-auto text-gray-300 group-hover:text-gray-500 group-hover:translate-x-0.5 transition-all" />
              </div>
              <p className="text-[11px] text-gray-500">{e.desc}</p>
            </button>
          ))}
          {/* 快捷：AI 助手场景（配合外部 Hermes/提示词使用） */}
          <div className="sm:col-span-2 bg-white border border-gray-200 rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <MessageSquare size={15} className="text-blue-500" />
              <span className="text-sm font-bold text-gray-700">AI 助手场景</span>
              <span className="text-[10px] text-gray-300">与提示词库、Hermes 邮件工具配合</span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {[
                { emoji: '📧', title: '写邮件', path: '/integrations' },
                { emoji: '📊', title: '数据分析', path: '/workflows' },
                { emoji: '📚', title: '学习助手', path: '/ai-lab' },
                { emoji: '✍️', title: '内容创作', path: '/ai-lab' },
              ].map(s => (
                <button key={s.title} onClick={() => navigate(s.path)}
                  className="p-2.5 bg-gray-50 rounded-xl border border-gray-100 hover:border-blue-200 hover:bg-blue-50/50 transition-colors text-left">
                  <div className="text-lg">{s.emoji}</div>
                  <div className="text-[11px] text-gray-600 mt-0.5">{s.title}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ====== 提示词库 ====== */}
      {tab === 'prompts' && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="搜索提示词…" className="flex-1 text-sm border border-gray-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-purple-100" />
            <button onClick={() => setShowForm(showForm === 'prompt' ? '' : 'prompt')} className="flex items-center gap-1 px-3 py-2 bg-purple-500 text-white rounded-xl text-xs font-medium hover:bg-purple-600">
              <Plus size={13} /> 新建
            </button>
          </div>

          {showForm === 'prompt' && (
            <div className="bg-white border border-gray-200 rounded-2xl p-4 space-y-2">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <input value={newPrompt.title} onChange={e => setNewPrompt({ ...newPrompt, title: e.target.value })} placeholder="标题" className={inputClass} />
                <input value={newPrompt.category} onChange={e => setNewPrompt({ ...newPrompt, category: e.target.value })} placeholder="分类（外贸/独立站/效率…）" className={inputClass} />
              </div>
              <textarea value={newPrompt.content} onChange={e => setNewPrompt({ ...newPrompt, content: e.target.value })} rows={3} placeholder="提示词内容…" className={inputClass} />
              <button onClick={addPrompt} className="px-4 py-1.5 bg-purple-500 text-white rounded-lg text-xs hover:bg-purple-600">保存</button>
            </div>
          )}

          {filteredPrompts.length === 0 ? (
            <p className="text-xs text-gray-400 text-center py-8">暂无提示词</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {filteredPrompts.map(p => (
                <div key={p.id} className="bg-white border border-gray-200 rounded-xl p-3 group">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-gray-800 truncate">{p.title}</span>
                    <span className="px-1.5 py-0.5 bg-purple-50 text-purple-500 rounded text-[10px]">{p.category}</span>
                    <div className="ml-auto flex gap-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                      <button onClick={() => copyPrompt(p)} className="p-1 text-gray-300 hover:text-blue-500" title="复制">
                        {copiedId === p.id ? <Check size={13} className="text-green-500" /> : <Copy size={13} />}
                      </button>
                      <button onClick={() => deletePrompt(p.id)} className="p-1 text-gray-300 hover:text-red-500" title="删除">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                  <p className="text-[11px] text-gray-400 line-clamp-2">{p.content}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ====== AI 工具收藏 ====== */}
      {tab === 'tools' && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="搜索工具…" className="flex-1 text-sm border border-gray-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-cyan-100" />
            <button onClick={() => setShowForm(showForm === 'tool' ? '' : 'tool')} className="flex items-center gap-1 px-3 py-2 bg-cyan-500 text-white rounded-xl text-xs font-medium hover:bg-cyan-600">
              <Plus size={13} /> 新建
            </button>
          </div>

          {showForm === 'tool' && (
            <div className="bg-white border border-gray-200 rounded-2xl p-4 space-y-2">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <input value={newTool.name} onChange={e => setNewTool({ ...newTool, name: e.target.value })} placeholder="工具名" className={inputClass} />
                <input value={newTool.url} onChange={e => setNewTool({ ...newTool, url: e.target.value })} placeholder="网址" className={inputClass} />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <input value={newTool.category} onChange={e => setNewTool({ ...newTool, category: e.target.value })} placeholder="分类" className={inputClass} />
                <input value={newTool.description} onChange={e => setNewTool({ ...newTool, description: e.target.value })} placeholder="一句话描述" className={inputClass} />
              </div>
              <button onClick={addTool} className="px-4 py-1.5 bg-cyan-500 text-white rounded-lg text-xs hover:bg-cyan-600">保存</button>
            </div>
          )}

          <div className="grid gap-2 sm:grid-cols-2">
            {filteredTools.map(t => (
              <div key={t.id} className="bg-white border border-gray-200 rounded-xl p-3 group">
                <div className="flex items-center gap-2">
                  <Cpu size={14} className="text-cyan-500 shrink-0" />
                  <span className="text-sm font-medium text-gray-800 truncate">{t.name}</span>
                  <span className="px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded text-[10px]">{t.category}</span>
                  <div className="ml-auto flex gap-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                    {t.url && (
                      <a href={t.url} target="_blank" rel="noreferrer" className="p-1 text-gray-300 hover:text-blue-500" title="打开">
                        <ExternalLink size={13} />
                      </a>
                    )}
                    <button onClick={() => deleteTool(t.id)} className="p-1 text-gray-300 hover:text-red-500" title="删除">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
                {t.description && <p className="text-[11px] text-gray-400 mt-1">{t.description}</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 底部说明 */}
      <div className="mt-6 flex items-center gap-1.5 text-[11px] text-gray-300">
        <Eye size={11} /> AI 热点筛选走「AI 实验室」；热点不直接进入 Memory。
        <Bot size={11} className="ml-2" /> 智能体产生的所有写入都经过审批管线。
        <Plug size={11} className="ml-2" /> 外部系统永远不直接改库。
      </div>
    </div>
  )
}
