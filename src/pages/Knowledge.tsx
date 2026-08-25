import { useState, useMemo } from 'react'
import { useStore } from '../store'
import { Plus, Lightbulb, HelpCircle, Search, FlaskConical, GitBranch, Brain, Bookmark, Link2, Tag, Pencil, Trash2, ArrowLeftRight, X, Network } from 'lucide-react'
import MarkdownEditor from '../components/MarkdownEditor'
import KnowledgeGraph from '../components/KnowledgeGraph'
import RelationCreator from '../components/RelationCreator'
import type { Knowledge, ObjectType } from '../types'

const tabs = [
  { key: 'all', label: '📚 全部知识', icon: Brain },
  { key: 'inspiration', label: '💡 灵感', icon: Lightbulb },
  { key: 'question', label: '❓ 问题', icon: HelpCircle },
  { key: 'research', label: '🔬 研究', icon: Search },
  { key: 'experiment', label: '🧪 实验', icon: FlaskConical },
  { key: 'decision', label: '🧩 决策', icon: GitBranch },
  { key: 'bookmark', label: '⭐ 收藏', icon: Bookmark },
  { key: 'relations', label: '🔗 知识关系', icon: Link2 },
  { key: 'graph', label: '🕸️ 知识图谱', icon: Network },
]

const categories = [
  { value: 'general', label: '通用', emoji: '📌' },
  { value: '外贸', label: '外贸', emoji: '🌍' },
  { value: '独立站', label: '独立站', emoji: '🛒' },
  { value: 'AI', label: 'AI', emoji: '🤖' },
  { value: '英语', label: '英语', emoji: '🇬🇧' },
  { value: '效率', label: '效率', emoji: '⚡' },
  { value: '思考', label: '思考', emoji: '💭' },
  { value: '技术', label: '技术', emoji: '💻' },
]

export default function KnowledgePage() {
  const { knowledge, inspirations, questions, research, experiments, decisions, addObject, updateObject, deleteObject, getAllTags, getBacklinks } = useStore()
  const [activeTab, setActiveTab] = useState('all')
  const [selectedTag, setSelectedTag] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newContent, setNewContent] = useState('')
  const [newCategory, setNewCategory] = useState('general')
  const [newTags, setNewTags] = useState('')
  const [editContent, setEditContent] = useState('')
  const [editTitle, setEditTitle] = useState('')
  const [editTags, setEditTags] = useState('')
  const [viewingId, setViewingId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [graphDepth, setGraphDepth] = useState(1)
  const [graphCenterId, setGraphCenterId] = useState<string | undefined>(undefined)

  const allTags = useMemo(() => getAllTags(), [knowledge, inspirations, questions, research, experiments, decisions])

  // 过滤知识
  const filteredKnowledge = useMemo(() => {
    let items = knowledge
    if (selectedTag) items = items.filter(k => k.tags.includes(selectedTag))
    if (activeTab === 'bookmark') items = items.filter(k => k.isBookmarked)
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      items = items.filter(k =>
        k.title.toLowerCase().includes(q) ||
        k.content.toLowerCase().includes(q) ||
        k.tags.some(t => t.toLowerCase().includes(q))
      )
    }
    return items
  }, [knowledge, selectedTag, activeTab, searchQuery])

  const handleAddKnowledge = async () => {
    if (!newTitle.trim()) return
    const tags = newTags.split(',').map(t => t.trim()).filter(Boolean)
    await addObject('knowledge', {
      title: newTitle.trim(),
      description: '',
      content: newContent,
      category: newCategory,
      tags,
      isBookmarked: false,
      format: 'markdown',
      backlinks: [],
    })
    setNewTitle('')
    setNewContent('')
    setNewTags('')
    setShowForm(false)
  }

  const handleAddSimple = async (type: ObjectType) => {
    if (!newTitle.trim()) return
    await addObject(type, { title: newTitle.trim() })
    setNewTitle('')
    setShowForm(false)
  }

  const handleSaveEdit = async (id: string) => {
    const tags = editTags.split(',').map(t => t.trim()).filter(Boolean)
    await updateObject('knowledge', id, { title: editTitle, content: editContent, tags } as any)
    setEditingId(null)
  }

  const handleDelete = async (id: string) => {
    if (window.confirm('确定删除这条知识？')) {
      await deleteObject('knowledge', id)
      if (viewingId === id) setViewingId(null)
      if (editingId === id) setEditingId(null)
    }
  }

  const handleToggleBookmark = async (k: Knowledge) => {
    await updateObject('knowledge', k.id, { isBookmarked: !k.isBookmarked } as any)
  }

  const viewingItem = viewingId ? knowledge.find(k => k.id === viewingId) : null
  const backlinks = viewingId ? getBacklinks(viewingId) : []

  // 解析 [[...]] 链接
  const parseContent = (content: string) => {
    const parts = content.split(/(\[\[([^\]]+)\]\])/g)
    return parts.map((part, i) => {
      if (i % 3 === 0) return <span key={i}>{part}</span>
      const name = parts[i + 1]
      if (!name) return <span key={i}>{part}</span>
      const linked = knowledge.find(k => k.title === name)
      if (linked) {
        return (
          <button
            key={i}
            onClick={() => setViewingId(linked.id)}
            className="text-blue-600 underline hover:text-blue-800"
          >
            {name}
          </button>
        )
      }
      return <span key={i} className="text-gray-400">{part}</span>
    })
  }

  const renderContent = () => {
    switch (activeTab) {
      case 'all':
      case 'bookmark':
        return (
          <div className="space-y-4">
            {/* 搜索和新增 */}
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="搜索知识..."
                  className="w-full pl-9 pr-4 py-2 rounded-xl border border-gray-200 text-sm outline-none focus:border-blue-400"
                />
              </div>
              <button
                onClick={() => setShowForm(true)}
                className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700"
              >
                <Plus size={16} /> 新建
              </button>
            </div>

            {/* 标签云 */}
            {allTags.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => setSelectedTag(null)}
                  className={`px-2.5 py-1 rounded-lg text-xs transition-colors ${
                    !selectedTag ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                  }`}
                >
                  全部
                </button>
                {allTags.slice(0, 20).map(t => (
                  <button
                    key={t.tag}
                    onClick={() => setSelectedTag(t.tag === selectedTag ? null : t.tag)}
                    className={`px-2.5 py-1 rounded-lg text-xs transition-colors ${
                      t.tag === selectedTag ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                    }`}
                  >
                    {t.tag} ({t.count})
                  </button>
                ))}
              </div>
            )}

            {/* 新建表单 */}
            {showForm && (
              <div className="bg-white rounded-2xl p-6 shadow-sm border border-blue-200">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-semibold text-gray-800">📝 新建知识</h3>
                  <button onClick={() => setShowForm(false)} className="text-gray-400 hover:text-gray-600">
                    <X size={18} />
                  </button>
                </div>
                <div className="space-y-3">
                  <input
                    type="text"
                    value={newTitle}
                    onChange={e => setNewTitle(e.target.value)}
                    placeholder="标题"
                    className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm outline-none focus:border-blue-400"
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <select
                      value={newCategory}
                      onChange={e => setNewCategory(e.target.value)}
                      className="px-3 py-2 rounded-xl border border-gray-200 text-sm outline-none"
                    >
                      {categories.map(c => (
                        <option key={c.value} value={c.value}>{c.emoji} {c.label}</option>
                      ))}
                    </select>
                    <input
                      type="text"
                      value={newTags}
                      onChange={e => setNewTags(e.target.value)}
                      placeholder="标签（逗号分隔）"
                      className="flex-1 px-3 py-2 rounded-xl border border-gray-200 text-sm outline-none focus:border-blue-400"
                    />
                  </div>
                  <MarkdownEditor
                    value={newContent}
                    onChange={setNewContent}
                    placeholder="内容... 支持 Markdown，用 [[笔记名]] 创建链接"
                    minHeight="150px"
                  />
                  <button
                    onClick={handleAddKnowledge}
                    className="px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700"
                  >
                    保存
                  </button>
                </div>
              </div>
            )}

            {/* 知识列表 */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredKnowledge.map(k => (
                <div
                  key={k.id}
                  className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100 hover:border-blue-200 hover:shadow-md transition-all cursor-pointer group"
                  onClick={() => setViewingId(k.id)}
                >
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-lg">{k.emoji || '📌'}</span>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">
                        {categories.find(c => c.value === k.category)?.label || k.category}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={e => { e.stopPropagation(); handleToggleBookmark(k) }}
                        className={`p-1 rounded-lg ${k.isBookmarked ? 'text-yellow-500' : 'text-gray-300 hover:text-yellow-500'}`}
                      >
                        <Bookmark size={14} fill={k.isBookmarked ? 'currentColor' : 'none'} />
                      </button>
                    </div>
                  </div>
                  <h3 className="font-semibold text-gray-800 mb-1.5 line-clamp-1">{k.title}</h3>
                  <p className="text-sm text-gray-400 line-clamp-2 mb-3">
                    {k.content.replace(/[#*\[\]`]/g, '').slice(0, 100)}
                  </p>
                  {k.tags.length > 0 && (
                    <div className="flex gap-1 flex-wrap">
                      {k.tags.slice(0, 3).map(t => (
                        <span key={t} className="text-[10px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">{t}</span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {filteredKnowledge.length === 0 && (
              <div className="text-center py-12 text-gray-400">
                <Brain size={48} className="mx-auto mb-3 opacity-30" />
                <p>暂无知识记录</p>
                <p className="text-sm mt-1">点击"新建"开始记录你的知识</p>
              </div>
            )}
          </div>
        )

      case 'inspiration':
      case 'question':
      case 'research':
      case 'experiment':
      case 'decision': {
        const typeMap: Record<string, { items: any[]; label: string; emoji: string; type: ObjectType }> = {
          inspiration: { items: inspirations, label: '灵感', emoji: '💡', type: 'inspiration' },
          question: { items: questions, label: '问题', emoji: '❓', type: 'question' },
          research: { items: research, label: '研究', emoji: '🔬', type: 'research' },
          experiment: { items: experiments, label: '实验', emoji: '🧪', type: 'experiment' },
          decision: { items: decisions, label: '决策', emoji: '🧩', type: 'decision' },
        }
        const info = typeMap[activeTab]
        return (
          <div className="space-y-4">
            <div className="flex gap-2">
              <input
                type="text"
                value={newTitle}
                onChange={e => setNewTitle(e.target.value)}
                placeholder={`添加${info.label}...`}
                className="flex-1 px-4 py-2 rounded-xl border border-gray-200 text-sm outline-none focus:border-blue-400"
                onKeyDown={e => e.key === 'Enter' && handleAddSimple(info.type)}
              />
              <button
                onClick={() => handleAddSimple(info.type)}
                className="px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-medium"
              >
                <Plus size={16} />
              </button>
            </div>
            <div className="space-y-2">
              {info.items.map(item => (
                <div key={item.id} className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-lg">{info.emoji}</span>
                    <span className="text-sm font-medium text-gray-700">{item.title}</span>
                  </div>
                  <button
                    onClick={() => deleteObject(info.type, item.id)}
                    className="text-gray-300 hover:text-red-500 transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              {info.items.length === 0 && (
                <div className="text-center py-8 text-gray-400 text-sm">暂无{info.label}</div>
              )}
            </div>
          </div>
        )
      }

      case 'relations':
        return (
          <div className="space-y-4">
            <RelationCreator />
            <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100">
              <h3 className="font-semibold text-gray-800 mb-4">🔗 知识关系</h3>
              <p className="text-sm text-gray-500 mb-4">
                在知识内容中使用 <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">[[笔记名称]]</code> 来创建链接。
                点击任意知识卡片查看。
              </p>
              {/* 标签统计 */}
              {allTags.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold text-gray-600 mb-3">🏷️ 标签统计</h4>
                  <div className="flex gap-2 flex-wrap">
                    {allTags.map(t => (
                      <div key={t.tag} className="px-3 py-2 rounded-xl bg-gray-50 border border-gray-100">
                        <span className="text-sm font-medium text-gray-700">{t.tag}</span>
                        <span className="text-xs text-gray-400 ml-1.5">{t.count}</span>
                        <div className="text-[10px] text-gray-400 mt-0.5">{t.types.join(', ')}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )

      case 'graph':
        return (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-semibold text-gray-800">🕸️ 知识图谱</h3>
                <p className="text-xs text-gray-400 mt-0.5">从 Relation 数据实时生成 · 拖拽平移 · 滚轮缩放</p>
              </div>
              <div className="flex gap-2">
                <select
                  value={graphDepth}
                  onChange={e => setGraphDepth(Number(e.target.value))}
                  className="text-xs px-2 py-1 border border-gray-200 rounded-lg text-gray-600"
                >
                  <option value={1}>1 度关系</option>
                  <option value={2}>2 度关系</option>
                  <option value={3}>3 度关系</option>
                </select>
              </div>
            </div>
            <KnowledgeGraph
              centerId={graphCenterId}
              depth={graphDepth}
              height={550}
              onNodeClick={(node) => {
                if (node.type === 'knowledge') {
                  setViewingId(node.id)
                  setActiveTab('all')
                }
              }}
            />
          </div>
        )
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">🧠 知识与思考</h1>
          <p className="text-sm text-gray-400 mt-0.5">构建你的第二大脑</p>
        </div>
      </div>

      {/* 标签页 */}
      <div className="flex gap-1 overflow-x-auto pb-1">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => { setActiveTab(tab.key); setViewingId(null); setEditingId(null) }}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium whitespace-nowrap transition-colors ${
              activeTab === tab.key
                ? 'bg-blue-600 text-white shadow-sm'
                : 'bg-white text-gray-500 hover:bg-gray-50 border border-gray-200'
            }`}
          >
            <tab.icon size={16} />
            {tab.label}
          </button>
        ))}
      </div>

      {/* 主内容区 */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className={viewingId ? 'lg:col-span-2' : 'lg:col-span-3'}>
          {renderContent()}
        </div>

        {/* 详情面板 */}
        {viewingItem && (
          <div className="lg:col-span-1">
            <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100 sticky top-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-gray-800 text-lg">{viewingItem.emoji || '📌'} {viewingItem.title}</h3>
                <button onClick={() => setViewingId(null)} className="text-gray-400 hover:text-gray-600">
                  <X size={18} />
                </button>
              </div>

              {editingId === viewingItem.id ? (
                <div className="space-y-3">
                  <input
                    type="text"
                    value={editTitle}
                    onChange={e => setEditTitle(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm outline-none"
                  />
                  <input
                    type="text"
                    value={editTags}
                    onChange={e => setEditTags(e.target.value)}
                    placeholder="标签（逗号分隔）"
                    className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm outline-none"
                  />
                  <MarkdownEditor
                    value={editContent}
                    onChange={setEditContent}
                    minHeight="200px"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleSaveEdit(viewingItem.id)}
                      className="px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-medium"
                    >
                      保存
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      className="px-4 py-2 bg-gray-100 text-gray-600 rounded-xl text-sm"
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">
                      {categories.find(c => c.value === viewingItem.category)?.label || viewingItem.category}
                    </span>
                    {viewingItem.tags.map(t => (
                      <span key={t} className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-600">{t}</span>
                    ))}
                  </div>

                  <div className="prose prose-sm max-w-none mb-4 text-gray-700">
                    {viewingItem.content ? parseContent(viewingItem.content) : (
                      <p className="text-gray-300 italic">暂无内容</p>
                    )}
                  </div>

                  <div className="flex gap-2 mb-4">
                    <button
                      onClick={() => {
                        setEditingId(viewingItem.id)
                        setEditTitle(viewingItem.title)
                        setEditContent(viewingItem.content)
                        setEditTags(viewingItem.tags.join(', '))
                      }}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200"
                    >
                      <Pencil size={12} /> 编辑
                    </button>
                    <button
                      onClick={() => handleDelete(viewingItem.id)}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs bg-red-50 text-red-500 rounded-lg hover:bg-red-100"
                    >
                      <Trash2 size={12} /> 删除
                    </button>
                    <button
                      onClick={() => handleToggleBookmark(viewingItem)}
                      className={`flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg ${
                        viewingItem.isBookmarked ? 'bg-yellow-50 text-yellow-600' : 'bg-gray-100 text-gray-500'
                      }`}
                    >
                      <Bookmark size={12} fill={viewingItem.isBookmarked ? 'currentColor' : 'none'} />
                      {viewingItem.isBookmarked ? '已收藏' : '收藏'}
                    </button>
                  </div>

                  {/* 反向链接 */}
                  {backlinks.length > 0 && (
                    <div className="border-t border-gray-100 pt-4">
                      <h4 className="text-xs font-semibold text-gray-500 mb-2 flex items-center gap-1">
                        <ArrowLeftRight size={12} /> 反向链接 ({backlinks.length})
                      </h4>
                      <div className="space-y-1">
                        {backlinks.map(b => (
                          <button
                            key={b.id}
                            onClick={() => setViewingId(b.id)}
                            className="w-full text-left px-3 py-2 rounded-lg hover:bg-gray-50 text-sm text-gray-600 transition-colors"
                          >
                            {b.emoji || '📌'} {b.title}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {backlinks.length === 0 && (
                    <div className="border-t border-gray-100 pt-4">
                      <p className="text-xs text-gray-400">
                        暂无反向链接。在其他笔记中使用 <code className="bg-gray-100 px-1 rounded">[[{viewingItem.title}]]</code> 来引用这篇笔记。
                      </p>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}