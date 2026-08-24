import { useState, useEffect } from 'react'
import { useStore } from '../store'
import { Bot, Cpu, Brain, Lightbulb, Zap, FlaskConical, MessageSquare, Play, Pause, Settings, Plus, Trash2, Copy, Bookmark, Sparkles, Search } from 'lucide-react'

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

function loadAI(): { prompts: PromptItem[]; tools: ToolItem[] } {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return {
    prompts: [
      { id: 'p1', title: '客户邮件润色', category: '外贸', content: '请帮我润色以下外贸邮件，使其更加专业、礼貌，同时保持简洁：\n\n[粘贴邮件内容]' },
      { id: 'p2', title: '产品描述生成', category: '独立站', content: '请为以下产品生成一段吸引人的 Shopify 产品描述，包含 SEO 关键词、卖点列表和使用场景：\n\n产品名：[名称]\n材质：[材质]\n卖点：[卖点]' },
      { id: 'p3', title: '竞品分析', category: '独立站', content: '请帮我分析以下竞品网站，总结其产品策略、定价策略和营销策略：\n\n网站：[URL]' },
      { id: 'p4', title: '学习计划制定', category: '成长', content: '我想在 [时间] 内学会 [技能]，每天可投入 [小时] 小时。请帮我制定一个详细的学习计划，包含每周学习目标、推荐资源和实践项目。' },
      { id: 'p5', title: '日报/周报生成', category: '效率', content: '请根据以下要点帮我生成一份工作日报：\n\n1. [今日完成事项1]\n2. [今日完成事项2]\n3. [遇到的问题]\n4. [明日计划]' },
      { id: 'p6', title: '头脑风暴', category: '创意', content: '请围绕 [主题] 进行头脑风暴，给出 10 个创意方案，每个方案包含简要说明和可行性评估（高/中/低）。' },
    ],
    tools: [
      { id: 't1', name: 'ChatGPT', url: 'https://chat.openai.com', category: '对话', description: '通用 AI 对话助手' },
      { id: 't2', name: 'Claude', url: 'https://claude.ai', category: '对话', description: '擅长长文本分析和写作' },
      { id: 't3', name: 'Cursor', url: 'https://cursor.com', category: '编程', description: 'AI 驱动的代码编辑器' },
      { id: 't4', name: 'Midjourney', url: 'https://midjourney.com', category: '图像', description: 'AI 图像生成' },
      { id: 't5', name: 'Notion AI', url: 'https://notion.so', category: '效率', description: '笔记和知识管理 AI' },
      { id: 't6', name: 'Zapier', url: 'https://zapier.com', category: '自动化', description: '连接各种应用实现自动化' },
      { id: 't7', name: 'n8n', url: 'https://n8n.io', category: '自动化', description: '开源自动化工作流工具' },
      { id: 't8', name: 'Perplexity', url: 'https://perplexity.ai', category: '搜索', description: 'AI 驱动的搜索引擎' },
    ],
  }
}

function saveAI(data: any) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(data)) } catch { /* ignore */ }
}

const tabs = [
  { key: 'assistants', label: '🤖 AI 助手', icon: MessageSquare },
  { key: 'agents', label: '🤖 AI 智能体', icon: Bot },
  { key: 'prompts', label: '📝 提示词库', icon: Lightbulb },
  { key: 'tools', label: '🛠 AI 工具', icon: Cpu },
  { key: 'memory', label: '🧠 AI 记忆', icon: Brain },
  { key: 'automation', label: '⚡ AI 自动化', icon: Zap },
  { key: 'lab', label: '🧪 AI 实验室', icon: FlaskConical },
]

export default function AICenterPage() {
  const { agents } = useStore()
  const [activeTab, setActiveTab] = useState('assistants')
  const [aiData, setAiData] = useState(loadAI)
  const [showForm, setShowForm] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [copiedId, setCopiedId] = useState('')

  useEffect(() => { saveAI(aiData) }, [aiData])

  const [newPrompt, setNewPrompt] = useState({ title: '', category: '', content: '' })
  const [newTool, setNewTool] = useState({ name: '', url: '', category: '', description: '' })

  const addPrompt = () => {
    if (!newPrompt.title.trim()) return
    const p: PromptItem = { id: Date.now().toString(), ...newPrompt, category: newPrompt.category || '通用' }
    setAiData(d => ({ ...d, prompts: [...d.prompts, p] }))
    setNewPrompt({ title: '', category: '', content: '' }); setShowForm(false)
  }
  const addTool = () => {
    if (!newTool.name.trim()) return
    const t: ToolItem = { id: Date.now().toString(), ...newTool, category: newTool.category || '通用' }
    setAiData(d => ({ ...d, tools: [...d.tools, t] }))
    setNewTool({ name: '', url: '', category: '', description: '' }); setShowForm(false)
  }
  const deletePrompt = (id: string) => setAiData(d => ({ ...d, prompts: d.prompts.filter(p => p.id !== id) }))
  const deleteTool = (id: string) => setAiData(d => ({ ...d, tools: d.tools.filter(t => t.id !== id) }))

  const copyPrompt = (p: PromptItem) => {
    navigator.clipboard?.writeText(p.content).then(() => {
      setCopiedId(p.id)
      setTimeout(() => setCopiedId(''), 2000)
    }).catch(() => {})
  }

  const inputClass = 'w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-200'

  const filteredPrompts = aiData.prompts.filter(p =>
    !searchQuery || p.title.includes(searchQuery) || p.category.includes(searchQuery) || p.content.includes(searchQuery)
  )
  const promptCategories = [...new Set(aiData.prompts.map(p => p.category))]
  const toolCategories = [...new Set(aiData.tools.map(t => t.category))]

  const renderContent = () => {
    switch (activeTab) {
      case 'assistants':
        return (
          <div className="space-y-4">
            <div className="p-6 bg-gradient-to-br from-blue-50 to-purple-50 rounded-2xl border border-blue-100">
              <h3 className="text-lg font-semibold text-gray-800 mb-2 flex items-center gap-2">
                <Sparkles size={18} className="text-blue-500" /> AI 助手
              </h3>
              <p className="text-sm text-gray-500 mb-4">选择一个场景，快速开始与 AI 协作</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {[
                  { emoji: '📧', title: '写邮件', desc: '生成外贸邮件、客户跟进邮件' },
                  { emoji: '📊', title: '数据分析', desc: '分析销售数据、生成报表' },
                  { emoji: '📚', title: '学习助手', desc: '制定学习计划、解释概念' },
                  { emoji: '✍️', title: '内容创作', desc: '产品描述、博客文章、营销文案' },
                ].map(item => (
                  <button key={item.title} className="flex items-center gap-3 p-3 bg-white rounded-xl border border-gray-100 hover:border-blue-300 hover:shadow-sm transition-all text-left">
                    <span className="text-2xl">{item.emoji}</span>
                    <div>
                      <div className="text-sm font-medium text-gray-800">{item.title}</div>
                      <div className="text-xs text-gray-400">{item.desc}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
            <div className="bg-white rounded-2xl p-5 border border-gray-100">
              <p className="text-xs text-gray-400 text-center">
                💡 提示：将 AI 助手与提示词库配合使用，效率更高
              </p>
            </div>
          </div>
        )

      case 'agents':
        return (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-700">已配置的智能体</h3>
            </div>
            {agents.length === 0 ? (
              <div className="text-center py-12 text-gray-400 text-sm">
                <Bot size={48} className="mx-auto mb-3 text-gray-200" />
                暂无智能体，AI 智能体功能将在后续版本接入
              </div>
            ) : (
              <div className="space-y-3">
                {agents.map(agent => (
                  <div key={agent.id} className="bg-white rounded-xl p-4 border border-gray-100">
                    <div className="flex items-center gap-3">
                      <span className="text-2xl">{agent.emoji}</span>
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-gray-800">{agent.name}</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                            agent.status === 'active' ? 'bg-green-100 text-green-600' :
                            agent.status === 'paused' ? 'bg-yellow-100 text-yellow-600' : 'bg-gray-100 text-gray-500'
                          }`}>
                            {agent.status === 'active' ? '运行中' : agent.status === 'paused' ? '已暂停' : '草稿'}
                          </span>
                        </div>
                        <p className="text-xs text-gray-400 mt-0.5">{agent.description}</p>
                      </div>
                      <button className="p-2 hover:bg-gray-100 rounded-lg">
                        {agent.status === 'active' ? <Pause size={16} /> : <Play size={16} />}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )

      case 'prompts':
        return (
          <div className="space-y-4">
            {/* 搜索栏 */}
            <div className="flex gap-2">
              <div className="flex-1 relative">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-300" />
                <input
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="搜索提示词..."
                  className="w-full pl-9 pr-3 py-2 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-200"
                />
              </div>
              <button
                onClick={() => setShowForm(!showForm)}
                className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700"
              >
                <Plus size={16} /> 新建
              </button>
            </div>

            {/* 新建表单 */}
            {showForm && (
              <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100 space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <input value={newPrompt.title} onChange={e => setNewPrompt({ ...newPrompt, title: e.target.value })} placeholder="提示词名称" className={inputClass} autoFocus />
                  <input value={newPrompt.category} onChange={e => setNewPrompt({ ...newPrompt, category: e.target.value })} placeholder="分类（外贸/独立站/成长/效率/创意）" className={inputClass} />
                </div>
                <textarea value={newPrompt.content} onChange={e => setNewPrompt({ ...newPrompt, content: e.target.value })} placeholder="提示词内容...（用 [变量] 标记可替换部分）" rows={5} className={inputClass} />
                <button onClick={addPrompt} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">添加</button>
              </div>
            )}

            {/* 分类标签 */}
            <div className="flex gap-2 flex-wrap">
              {promptCategories.map(cat => (
                <span key={cat} className="text-xs px-3 py-1 rounded-full bg-gray-100 text-gray-500">{cat}</span>
              ))}
            </div>

            {/* 提示词列表 */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {filteredPrompts.map(p => (
                <div key={p.id} className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100 group">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-600">{p.category}</span>
                      <h3 className="font-semibold text-gray-800 text-sm">{p.title}</h3>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => copyPrompt(p)}
                        className={`text-xs px-2 py-1 rounded transition-colors ${copiedId === p.id ? 'text-green-600 bg-green-50' : 'text-blue-600 hover:bg-blue-50'}`}
                      >
                        {copiedId === p.id ? '✓ 已复制' : '复制'}
                      </button>
                      <button onClick={() => deletePrompt(p.id)} className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-500 transition-all">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                  <pre className="text-xs text-gray-500 whitespace-pre-wrap bg-gray-50 rounded-lg p-3 max-h-32 overflow-y-auto font-mono leading-relaxed">{p.content}</pre>
                </div>
              ))}
              {filteredPrompts.length === 0 && (
                <div className="col-span-full text-center py-12 text-gray-400 text-sm">
                  {searchQuery ? '未找到匹配的提示词' : '暂无提示词，点击「新建」添加'}
                </div>
              )}
            </div>
          </div>
        )

      case 'tools':
        return (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-700">AI 工具收藏</h3>
              <button
                onClick={() => setShowForm(!showForm)}
                className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700"
              >
                <Plus size={16} /> 添加工具
              </button>
            </div>

            {showForm && (
              <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100 space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <input value={newTool.name} onChange={e => setNewTool({ ...newTool, name: e.target.value })} placeholder="工具名称" className={inputClass} autoFocus />
                  <input value={newTool.url} onChange={e => setNewTool({ ...newTool, url: e.target.value })} placeholder="URL" className={inputClass} />
                  <input value={newTool.category} onChange={e => setNewTool({ ...newTool, category: e.target.value })} placeholder="分类（对话/编程/图像/搜索/自动化/效率）" className={inputClass} />
                </div>
                <input value={newTool.description} onChange={e => setNewTool({ ...newTool, description: e.target.value })} placeholder="简短描述" className={inputClass} />
                <button onClick={addTool} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">添加</button>
              </div>
            )}

            {/* 分类筛选 */}
            <div className="flex gap-2 flex-wrap">
              {toolCategories.map(cat => (
                <span key={cat} className="text-xs px-3 py-1 rounded-full bg-gray-100 text-gray-500 flex items-center gap-1">
                  <Bookmark size={10} /> {cat}
                </span>
              ))}
            </div>

            {/* 工具列表 */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {aiData.tools.map(t => (
                <div key={t.id} className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100 group">
                  <div className="flex items-start justify-between mb-2">
                    <h3 className="font-semibold text-gray-800 text-sm">{t.name}</h3>
                    <button onClick={() => deleteTool(t.id)} className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-500 transition-all">
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <p className="text-xs text-gray-400 mb-2">{t.description}</p>
                  <a href={t.url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-500 hover:text-blue-700 hover:underline">
                    {t.url} →
                  </a>
                  <div className="mt-2">
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">{t.category}</span>
                  </div>
                </div>
              ))}
              {aiData.tools.length === 0 && (
                <div className="col-span-full text-center py-12 text-gray-400 text-sm">暂无工具</div>
              )}
            </div>
          </div>
        )

      case 'memory':
        return (
          <div className="space-y-4">
            <div className="p-6 bg-gradient-to-br from-purple-50 to-pink-50 rounded-2xl border border-purple-100">
              <div className="flex items-center gap-3 mb-3">
                <Brain size={24} className="text-purple-500" />
                <h3 className="text-lg font-semibold text-gray-800">AI 记忆系统</h3>
              </div>
              <p className="text-sm text-gray-500">AI 会记住你的偏好、工作模式和重要信息，提供个性化服务</p>
            </div>
            <div className="bg-white rounded-2xl p-5 border border-gray-100 space-y-3">
              {[
                { label: '工作偏好', value: '主要做外贸和独立站，目标市场是欧美', icon: '💼' },
                { label: '语言偏好', value: '中文沟通，英文工作', icon: '🌐' },
                { label: '学习偏好', value: '偏好看视频和动手实践', icon: '📚' },
              ].map(m => (
                <div key={m.label} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                  <span className="text-xl">{m.icon}</span>
                  <div>
                    <div className="text-xs text-gray-400">{m.label}</div>
                    <div className="text-sm text-gray-700">{m.value}</div>
                  </div>
                </div>
              ))}
              <p className="text-xs text-gray-400 text-center pt-2">记忆将在后续版本支持自动学习和更新</p>
            </div>
          </div>
        )

      case 'automation':
        return (
          <div className="space-y-4">
            <div className="p-6 bg-gradient-to-br from-yellow-50 to-orange-50 rounded-2xl border border-orange-100">
              <div className="flex items-center gap-3 mb-3">
                <Zap size={24} className="text-orange-500" />
                <h3 className="text-lg font-semibold text-gray-800">AI 自动化</h3>
              </div>
              <p className="text-sm text-gray-500">让 AI 自动处理重复性工作，释放你的时间</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {[
                { emoji: '📧', title: '邮件自动分类', desc: 'AI 识别邮件类型并自动归类', status: '即将上线' },
                { emoji: '📊', title: '日报自动生成', desc: '根据任务完成情况自动生成日报', status: '即将上线' },
                { emoji: '🔄', title: '数据同步', desc: '自动同步各平台数据到统一看板', status: '即将上线' },
                { emoji: '🔔', title: '智能提醒', desc: '根据优先级和截止日期智能提醒', status: '即将上线' },
              ].map(item => (
                <div key={item.title} className="bg-white rounded-2xl p-5 border border-gray-100">
                  <div className="flex items-center gap-3 mb-2">
                    <span className="text-2xl">{item.emoji}</span>
                    <div>
                      <h4 className="text-sm font-semibold text-gray-800">{item.title}</h4>
                      <p className="text-xs text-gray-400">{item.desc}</p>
                    </div>
                  </div>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-400">{item.status}</span>
                </div>
              ))}
            </div>
          </div>
        )

      case 'lab':
        return (
          <div className="space-y-4">
            <div className="p-6 bg-gradient-to-br from-green-50 to-teal-50 rounded-2xl border border-green-100">
              <div className="flex items-center gap-3 mb-3">
                <FlaskConical size={24} className="text-green-500" />
                <h3 className="text-lg font-semibold text-gray-800">AI 实验室</h3>
              </div>
              <p className="text-sm text-gray-500">探索 AI 新能力，实验前沿工作流</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {[
                { emoji: '🔥', title: 'AI 热点追踪', desc: 'AI 领域最新动态和趋势', status: '即将上线' },
                { emoji: '🧪', title: 'AI 实验', desc: '实验新的 AI 工作流和方法', status: '即将上线' },
                { emoji: '📊', title: 'AI 模型对比', desc: '对比不同 AI 模型的效果', status: '即将上线' },
                { emoji: '🔌', title: 'MCP 集成', desc: '连接外部工具和数据源', status: '即将上线' },
                { emoji: '⚡', title: 'n8n 工作流', desc: '可视化自动化工作流', status: '即将上线' },
                { emoji: '🔬', title: '自动化研究', desc: 'AI 自动收集和分析信息', status: '即将上线' },
              ].map(item => (
                <div key={item.title} className="bg-white rounded-2xl p-5 border border-gray-100">
                  <div className="flex items-center gap-3 mb-2">
                    <span className="text-2xl">{item.emoji}</span>
                    <div>
                      <h4 className="text-sm font-semibold text-gray-800">{item.title}</h4>
                      <p className="text-xs text-gray-400">{item.desc}</p>
                    </div>
                  </div>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-400">{item.status}</span>
                </div>
              ))}
            </div>
          </div>
        )

      default:
        return null
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-800">🤖 AI 中心</h1>
        <p className="text-sm text-gray-400 mt-0.5">AI 助手 · 提示词库 · 工具收藏 · 自动化</p>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-2">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => { setActiveTab(tab.key); setShowForm(false) }}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-full text-sm whitespace-nowrap transition-colors ${
              activeTab === tab.key ? 'bg-purple-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-100 border border-gray-200'
            }`}
          >
            <tab.icon size={14} />
            {tab.label}
          </button>
        ))}
      </div>

      {renderContent()}
    </div>
  )
}
