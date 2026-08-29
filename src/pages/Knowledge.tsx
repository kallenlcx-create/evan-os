import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import { useConfirm } from '../components/ConfirmModal'
import remarkGfm from 'remark-gfm'
import { useStore } from '../store'
import { useNavigate } from 'react-router-dom'
import { Plus, Lightbulb, HelpCircle, Search, FlaskConical, GitBranch, Brain, Bookmark, Link2, Pencil, Trash2, ArrowLeftRight, X, Network, ChevronDown, ChevronRight, RotateCw, CheckSquare, Check } from 'lucide-react'
import MarkdownEditor from '../components/MarkdownEditor'
import { useAskText } from '../components/PromptModal'
import RelationCreator from '../components/RelationCreator'
import KnowledgeGraph from '../components/KnowledgeGraph'
import MindMap from '../components/MindMap'
import { listByKind, syncKind, onKindsChanged } from '../repositories/collectionRepository'
import { downloadFile } from '../services/vaultSync'
import {
  syncWikiLinkRelations,
  getWikiBacklinks,
  migrateWikiLinksOnRename,
} from '../repositories/knowledgeRepository'
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
  { key: 'graph', label: '🧠 思维导图', icon: Network },
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
  const navigate = useNavigate()
  const { knowledge, inspirations, questions, research, experiments, decisions, addObject, updateObject, deleteObject, getAllTags } = useStore()
  const [activeTab, setActiveTab] = useState('all')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newContent, setNewContent] = useState('')
  const [newCategory, setNewCategory] = useState('general')
  const [newTags, setNewTags] = useState('')
  const [newFormat, setNewFormat] = useState<Knowledge['format']>('markdown')
  const [editContent, setEditContent] = useState('')
  const [editTitle, setEditTitle] = useState('')
  const [editCategory, setEditCategory] = useState('')
  const [editFormat, setEditFormat] = useState<Knowledge['format']>('markdown')
  const [editTags, setEditTags] = useState('')
  const [viewingId, setViewingId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [graphDepth, setGraphDepth] = useState(1)
  const [graphCenterId, setGraphCenterId] = useState<string | undefined>(undefined)
  const [backlinks, setBacklinks] = useState<Knowledge[]>([])

  // 批量操作模式
  const [batchMode, setBatchMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // 页内输入弹窗（替代原生 prompt）
  const [askModal, askText] = useAskText()
  const [confirmModal, confirm] = useConfirm()

  // ====== 标签体系（v1.1）：1级分类 → 2级标签 → 3级知识条目 ======
  interface TagL1 { id: string; name: string }
  interface TagL2 { id: string; name: string; parent: string }
  const [l1List, setL1List] = useState<TagL1[]>([])
  const [l2List, setL2List] = useState<TagL2[]>([])
  const [expandedL1, setExpandedL1] = useState<string | null>(null)
  const [selectedL2Filter, setSelectedL2Filter] = useState<string | null>(null)

  const loadTagTree = useCallback(async () => {
    const [l1, l2] = await Promise.all([listByKind('tag_l1'), listByKind('tag_l2')])
    setL1List(l1.map(r => ({ id: r.id, name: r.name })))
    setL2List(l2.map(r => ({ id: r.id, name: r.name, parent: r.parent })))
  }, [])

  // 云同步拉到 collections 变更时重水合，防止本地旧数组把远端新标签误删
  useEffect(() => onKindsChanged(() => { void loadTagTree() }), [loadTagTree])

  // 种子：等 store 从 IndexedDB 水合（knowledge 非空）后再播种，避免空数据竞态
  const seededRef = useRef(false)
  useEffect(() => {
    if (seededRef.current || knowledge.length === 0) return
    seededRef.current = true
    ;(async () => {
      const l1 = await listByKind('tag_l1')
      if (l1.length === 0) {
        const cats = [...new Set(knowledge.map(k => k.category).filter(c => c && c !== 'general' && c !== 'template' && c !== 'ai-hotspot' && c !== 'research'))]
        const defaults = ['业务', '运营', '生活', ...cats].filter(Boolean)
        await syncKind('tag_l1', defaults.map(n => ({ id: 'l1-' + n, name: n })))
      }
      const l2 = await listByKind('tag_l2')
      if (l2.length === 0) {
        const l1Now = await listByKind('tag_l1')
        const firstL1 = l1Now[0]?.name ?? '通用'
        const tags = getAllTags()
        await syncKind('tag_l2', tags.map(t => {
          const firstItem = knowledge.find(k => k.tags.includes(t.tag))
          return { id: 'l2-' + t.tag, name: t.tag, parent: firstItem?.category && l1Now.some(l => l.name === firstItem.category) ? firstItem.category : firstL1 }
        }))
      }
      await loadTagTree()
    })()
  }, [knowledge]) // 播种一次后由操作函数手动刷新
  // eslint-disable-next-line react-hooks/exhaustive-deps

  const allTags = useMemo(() => getAllTags(), [knowledge, inspirations, questions, research, experiments, decisions])

  // 分类计数：一次遍历建 Map，替代侧边栏逐节点全量扫描
  const countByCategory = useMemo(() => {
    const m = new Map<string, number>()
    knowledge.forEach(k => { if (k.category) m.set(k.category, (m.get(k.category) || 0) + 1) })
    return m
  }, [knowledge])

  // 过滤知识
  const filteredKnowledge = useMemo(() => {
    let items = knowledge
    // v1.1：统一走 l2 体系过滤（category = l2.name）
    if (selectedL2Filter && selectedL2Filter !== '__未分类__') items = items.filter(k => k.category === selectedL2Filter)
    if (selectedL2Filter === '__未分类__') items = items.filter(k => !l2List.some(l2 => l2.name === k.category))
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
  }, [knowledge, l2List, selectedL2Filter, activeTab, searchQuery])

  const handleAddKnowledge = async () => {
    if (!newTitle.trim()) return
    const tags = newTags.split(',').map(t => t.trim()).filter(Boolean)
    const id = await addObject('knowledge', {
      title: newTitle.trim(),
      description: '',
      content: newContent,
      category: newCategory,
      tags,
      format: newFormat,
    })
    await syncWikiLinkRelations(id, newContent)
    setNewTitle('')
    setNewContent('')
    setNewTags('')
    setNewFormat('markdown')
    setShowForm(false)
  }

  const handleAddSimple = async (type: ObjectType) => {
    if (!newTitle.trim()) return
    await addObject(type, { title: newTitle.trim() })
    setNewTitle('')
    setShowForm(false)
  }

  const handleSaveEdit = async (id: string) => {
    const title = editTitle.trim()
    if (!title) return
    const tags = editTags.split(',').map(t => t.trim()).filter(Boolean)
    const old = knowledge.find(k => k.id === id)
    await updateObject('knowledge', id, {
      title,
      content: editContent,
      tags,
      category: editCategory,
      format: editFormat,
    } as any)
    if (old && old.title !== title) await migrateWikiLinksOnRename(old.title, title)
    await syncWikiLinkRelations(id, editContent)
    setEditingId(null)
  }

  const handleDelete = async (id: string) => {
    if (await confirm('确定删除这条知识？')) {
      await deleteObject('knowledge', id)
      if (viewingId === id) setViewingId(null)
      if (editingId === id) setEditingId(null)
    }
  }

  const handleToggleBookmark = async (k: Knowledge) => {
    await updateObject('knowledge', k.id, { isBookmarked: !k.isBookmarked } as any)
  }

  const viewingItem = viewingId ? knowledge.find(k => k.id === viewingId) : null

  // 反向链接：从 Relation 表动态加载（references 关系）
  useEffect(() => {
    let cancelled = false
    if (!viewingId) { setBacklinks([]); return }
    getWikiBacklinks(viewingId).then(list => { if (!cancelled) setBacklinks(list) })
    return () => { cancelled = true }
  }, [viewingId, knowledge])

  // ====== 标签树 CRUD 与导入导出 ======
  const saveL1 = async (list: TagL1[]) => {
    setL1List(list)
    await syncKind('tag_l1', list.map(x => ({ id: x.id, name: x.name })))
  }
  const saveL2 = async (list: TagL2[]) => {
    setL2List(list)
    await syncKind('tag_l2', list.map(x => ({ id: x.id, name: x.name, parent: x.parent })))
  }
  const addL1Category = async () => {
    const name = await askText('新增一级分类名（如：业务 / 运营 / 生活）')
    if (!name?.trim()) return
    if (l1List.some(l => l.name === name.trim())) { alert('分类已存在'); return }
    await saveL1([...l1List, { id: 'l1-' + name.trim(), name: name.trim() }])
    setExpandedL1('l1-' + name.trim()) // 自动展开，方便立即添加 2级标签
  }
  const renameL1Category = async (l1: TagL1) => {
    const name = await askText(`重命名一级分类「${l1.name}」`, l1.name)
    if (!name?.trim() || name.trim() === l1.name) return
    await saveL1(l1List.map(x => x.id === l1.id ? { ...x, name: name.trim() } : x))
    await saveL2(l2List.map(x => x.parent === l1.name ? { ...x, parent: name.trim() } : x))
  }
  const deleteL1Category = async (l1: TagL1) => {
    const childCount = l2List.filter(x => x.parent === l1.name).length
    if (!await confirm(`删除分类「${l1.name}」？${childCount ? `其下 ${childCount} 个标签将变为未分类` : ''}`)) return
    await saveL1(l1List.filter(x => x.id !== l1.id))
    await saveL2(l2List.filter(x => x.parent !== l1.name))
  }
  const addL2Tag = async (parent: string) => {
    const name = await askText(`在分类「${parent}」下添加标签：`)
    if (!name?.trim()) return
    if (l2List.some(l => l.name === name.trim())) { alert('标签已存在'); return }
    await saveL2([...l2List, { id: 'l2-' + name.trim(), name: name.trim(), parent }])
  }
  const renameL2Tag = async (l2: TagL2) => {
    const name = await askText(`重命名标签「${l2.name}」`, l2.name)
    if (!name?.trim() || name.trim() === l2.name) return
    await saveL2(l2List.map(x => x.id === l2.id ? { ...x, name: name.trim() } : x))
    for (const k of knowledge.filter(kk => kk.category === l2.name)) {
      await updateObject('knowledge', k.id, { category: name.trim() } as any)
    }
  }
  const deleteL2Tag = async (l2: TagL2) => {
    const count = knowledge.filter(k => k.category === l2.name).length
    if (!await confirm(`删除标签「${l2.name}」？${count ? `其下 ${count} 条知识将变为未分类` : ''}`)) return
    await saveL2(l2List.filter(x => x.id !== l2.id))
    if (selectedL2Filter === l2.name) setSelectedL2Filter(null)
  }
  const knowledgeExportItem = (k: Knowledge) => ({
    id: k.id,
    title: k.title,
    content: k.content,
    tags: k.tags,
    category: k.category,
    format: k.format,
    isBookmarked: k.isBookmarked,
    markType: (k as any).markType,
    createdAt: k.createdAt,
    updatedAt: k.updatedAt,
  })
  const exportL2 = (l2: TagL2, fmt: 'md' | 'json') => {
    const items = knowledge.filter(k => k.category === l2.name)
    if (fmt === 'json') {
      downloadFile(
        `evan-tags-${l2.name}.json`,
        JSON.stringify({ name: l2.name, parent: l2.parent, items: items.map(knowledgeExportItem) }, null, 2),
        'application/json'
      )
    } else {
      const md = `# ${l2.name} 标签导出\n\n` + items.map(k => `## ${k.title}\n\n${k.content}\n`).join('\n---\n\n')
      downloadFile(`evan-tags-${l2.name}.md`, md, 'text/markdown')
    }
  }
  const exportAllTags = () => {
    downloadFile(
      'evan-tags-all.json',
      JSON.stringify({
        l1: l1List.map(l => l.name),
        l2: l2List.map(l => ({ name: l.name, parent: l.parent })),
        items: knowledge.map(knowledgeExportItem),
      }, null, 2),
      'application/json'
    )
  }

  // 按 id 或「标题+分类」去重；文件内部重复也只导入第一条
  const makeImportDedup = () => {
    const seen = new Set<string>()
    for (const k of knowledge) {
      seen.add(`${k.id}`)
      seen.add(`${k.title}|${k.category}`)
    }
    return (it: any, category?: string): boolean => {
      const key = it?.id ? `${it.id}` : `${String(it?.title ?? '')}|${category ?? ''}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }
  }

  const importTagsFile = async (file: File, parentL1: string) => {
    try {
      const text = await file.text()
      if (file.name.endsWith('.json')) {
        const parsed = JSON.parse(text)
        if (parsed.name && parsed.items) {
          // 标签级导入：确保父级 l1 存在；合并而非覆盖
          const parent = parsed.parent || parentL1 || '通用'
          if (!l1List.some(l => l.name === parent)) {
            await saveL1([...l1List, { id: 'l1-' + parent, name: parent }])
          }
          await saveL2([...l2List.filter(x => x.name !== parsed.name), { id: 'l2-' + parsed.name, name: parsed.name, parent }])
          const shouldImport = makeImportDedup()
          let imported = 0, skipped = 0
          for (const it of parsed.items) {
            if (!it?.title || !shouldImport(it, parsed.name)) { skipped++; continue }
            await addObject('knowledge', {
              ...(it.id ? { id: String(it.id) } : {}),
              title: it.title, content: it.content ?? '', tags: it.tags ?? [],
              category: parsed.name, format: it.format ?? 'markdown',
              isBookmarked: !!it.isBookmarked,
            })
            imported++
          }
          setSelectedL2Filter(parsed.name)
          alert(`导入完成 ✓ 新增 ${imported} 条${skipped ? `，跳过重复 ${skipped} 条` : ''}`)
        } else if (parsed.l1 && parsed.l2) {
          // 全量导入：合并模式 —— 只增改，绝不删除现有标签/条目
          const l1Incoming = (parsed.l1 as string[]).filter(Boolean).map((n: string) => ({ id: 'l1-' + n, name: n }))
          const l1Map = new Map(l1List.map(x => [x.id, x]))
          for (const inc of l1Incoming) l1Map.set(inc.id, { ...l1Map.get(inc.id), ...inc } as TagL1)
          await saveL1(Array.from(l1Map.values()))

          const l2Incoming = (parsed.l2 as any[]).filter(x => x?.name).map((x: any) => ({ id: 'l2-' + x.name, name: x.name, parent: x.parent }))
          const l2Map = new Map(l2List.map(x => [x.id, x]))
          for (const inc of l2Incoming) l2Map.set(inc.id, { ...l2Map.get(inc.id), ...inc } as TagL2)
          await saveL2(Array.from(l2Map.values()))

          const shouldImport = makeImportDedup()
          let imported = 0, skipped = 0
          for (const it of parsed.items ?? []) {
            const category = it.category ?? parsed.l2[0]?.name
            if (!it?.title || !shouldImport(it, category)) { skipped++; continue }
            await addObject('knowledge', {
              ...(it.id ? { id: String(it.id) } : {}),
              title: it.title, content: it.content ?? '', tags: it.tags ?? [],
              category, format: it.format ?? 'markdown',
              isBookmarked: !!it.isBookmarked,
            })
            imported++
          }
          if (parsed.l2.length > 0) setSelectedL2Filter(parsed.l2[0].name)
          alert(`导入完成 ✓ 新增 ${imported} 条${skipped ? `，跳过重复 ${skipped} 条` : ''}（合并模式，未删除任何现有数据）`)
        } else {
          alert('导入失败：JSON 结构无法识别。\n支持两种格式：\n① 单标签导出 {name, parent, items}\n② 全量导出 {l1, l2, items}')
          return
        }
        await loadTagTree()
      } else {
        const firstLine = text.split('\n')[0]?.replace(/^#\s*/, '').trim() ?? ''
        const tagMatch = firstLine.match(/^(.*?)\s*标签导出$/)
        const tagName = tagMatch?.[1]?.trim()
        const category = tagName || parentL1
        if (tagName && !l2List.some(l => l.name === tagName)) {
          await saveL2([...l2List, { id: 'l2-' + tagName, name: tagName, parent: parentL1 }])
        }
        let imported = 0
        const sections = text.split(/\n## /).slice(1)
        for (const sec of sections) {
          const title = sec.split('\n')[0].replace(/^## /, '').trim()
          const content = sec.split('\n').slice(1).join('\n').trim()
          if (title) {
            await addObject('knowledge', { title, content, category, tags: ['导入'], format: 'markdown' })
            imported++
          }
        }
        alert(`Markdown 导入完成 ✓ 新增 ${imported} 条，归类到「${category}」`)
        await loadTagTree()
      }
    } catch (e) {
      alert('导入失败：' + String(e).slice(0, 160))
    }
  }

  // Markdown 查看：[[标题]] 转内部链接，其余走 react-markdown 完整渲染
  const renderMarkdown = (content: string) => {
    const md = content.replace(/\[\[([^\]]+)\]\]/g, (_m, p1) => `[${p1}](#wiki:${encodeURIComponent(String(p1).trim())})`)
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: (props: any) => {
            const href = String(props.href ?? '')
            if (href.startsWith('#wiki:')) {
              const name = decodeURIComponent(href.slice(6))
              const linked = knowledge.find(k => k.title === name)
              if (linked) {
                return (
                  <button onClick={() => setViewingId(linked.id)} className="text-blue-600 underline hover:text-blue-800">
                    {props.children}
                  </button>
                )
              }
              return <span className="text-gray-400" title={`未找到笔记「${name}」`}>{props.children}</span>
            }
            return <a href={href} target="_blank" rel="noreferrer" className="text-blue-600 underline hover:text-blue-800">{props.children}</a>
          },
        }}
      >
        {md}
      </ReactMarkdown>
    )
  }

  // 搜索关键词高亮（首个匹配）
  const highlight = (text: string) => {
    const q = searchQuery.trim()
    if (!q) return text
    const idx = text.toLowerCase().indexOf(q.toLowerCase())
    if (idx === -1) return text
    return (
      <>
        {text.slice(0, idx)}
        <mark className="bg-yellow-100 text-inherit rounded px-0.5">{text.slice(idx, idx + q.length)}</mark>
        {text.slice(idx + q.length)}
      </>
    )
  }

  const renderContent = () => {
    switch (activeTab) {
      case 'all': {
        // 标签树数据：l1 → 其下 l2（含计数）
        const l2sByL1 = l1List.map(l1 => ({
          l1,
          children: l2List.filter(l2 => l2.parent === l1.name),
        }))
        const uncategorized = knowledge.filter(k => !l2List.some(l2 => l2.name === k.category))
        const visibleItems = selectedL2Filter
          ? filteredKnowledge.filter(k => k.category === selectedL2Filter)
          : filteredKnowledge

        return (
        <div className="grid lg:grid-cols-[280px_1fr] gap-4 items-start">
          {/* ====== 左：标签树 ====== */}
          <aside className="bg-white rounded-2xl border border-gray-100 p-3 space-y-1 lg:sticky lg:top-16 max-h-[70vh] overflow-y-auto">
            <div className="flex items-center justify-between px-1 mb-1">
              <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">标签体系</span>
              <button onClick={addL1Category} className="text-[10px] text-blue-500 hover:text-blue-700">＋ 分类</button>
            </div>

            {/* 全部 */}
            <button
              onClick={() => { setSelectedL2Filter(null) }}
              className={`w-full flex items-center justify-between px-2 py-1.5 rounded-lg text-xs ${
                !selectedL2Filter ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-500 hover:bg-gray-50'
              }`}
            >
              📚 全部知识
              <span className="text-[10px] text-gray-300">{knowledge.length}</span>
            </button>

            {l2sByL1.map(({ l1, children }) => {
              const expanded = expandedL1 === l1.id
              children.reduce((s, l2) => s + (countByCategory.get(l2.name) ?? 0), 0)
              return (
                <div key={l1.id}>
                  <div className="flex items-center gap-1 px-1 py-1 group">
                    <button onClick={() => setExpandedL1(expanded ? null : l1.id)} className="flex items-center gap-1 flex-1 text-left">
                      <ChevronDown size={11} className={`text-gray-300 transition-transform ${expanded ? '' : '-rotate-90'}`} />
                      <span className="text-[11px] font-medium text-gray-600">{l1.name}</span>
                      <span className="text-[9px] text-gray-300">{children.length}</span>
                    </button>
                    <button onClick={() => renameL1Category(l1)} className="p-0.5 text-gray-200 hover:text-blue-500 opacity-100 md:opacity-0 md:group-hover:opacity-100"><Pencil size={10} /></button>
                    <button onClick={() => deleteL1Category(l1)} className="p-0.5 text-gray-200 hover:text-red-500 opacity-100 md:opacity-0 md:group-hover:opacity-100"><Trash2 size={10} /></button>
                  </div>
                  {expanded && (
                    <div className="ml-3 pl-2 border-l border-gray-100 space-y-0.5">
                      {children.map(l2 => (
                        <div key={l2.id} className="flex items-center gap-1 group/l2">
                          <button
                            onClick={() => setSelectedL2Filter(selectedL2Filter === l2.name ? null : l2.name)}
                            className={`flex-1 flex items-center justify-between px-2 py-1 rounded-md text-[11px] ${
                              selectedL2Filter === l2.name ? 'bg-purple-50 text-purple-600 font-medium' : 'text-gray-500 hover:bg-gray-50'
                            }`}
                          >
                            <span className="truncate">🏷 {l2.name}</span>
                            <span className="text-[9px] text-gray-300">{countByCategory.get(l2.name) ?? 0}</span>
                          </button>
                          <button onClick={() => exportL2(l2, 'md')} className="p-0.5 text-gray-200 hover:text-gray-500 opacity-100 md:opacity-0 md:group-hover/l2:opacity-100" title="导出 MD">⬇</button>
                          <button onClick={() => exportL2(l2, 'json')} className="p-0.5 text-gray-200 hover:text-gray-500 opacity-100 md:opacity-0 md:group-hover/l2:opacity-100" title="导出 JSON">⬇</button>
                          <button onClick={() => renameL2Tag(l2)} className="p-0.5 text-gray-200 hover:text-blue-500 opacity-100 md:opacity-0 md:group-hover/l2:opacity-100"><Pencil size={9} /></button>
                          <button onClick={() => deleteL2Tag(l2)} className="p-0.5 text-gray-200 hover:text-red-500 opacity-100 md:opacity-0 md:group-hover/l2:opacity-100"><Trash2 size={9} /></button>
                        </div>
                      ))}
                      <button onClick={() => addL2Tag(l1.name)} className="w-full text-left px-2 py-1 text-[10px] text-gray-300 hover:text-blue-500">＋ 标签</button>
                    </div>
                  )}
                </div>
              )
            })}

            {/* 未分类 */}
            {uncategorized.length > 0 && (
              <button
                onClick={() => setSelectedL2Filter(selectedL2Filter === '__未分类__' ? null : '__未分类__')}
                className={`w-full flex items-center justify-between px-2 py-1.5 rounded-lg text-xs ${
                  selectedL2Filter === '__未分类__' ? 'bg-blue-50 text-blue-700' : 'text-gray-400 hover:bg-gray-50'
                }`}
              >
                📦 未分类
                <span className="text-[10px] text-gray-300">{uncategorized.length}</span>
              </button>
            )}

            {/* 导入导出 */}
            <div className="pt-2 mt-2 border-t border-gray-100 flex flex-wrap gap-1">
              <button onClick={exportAllTags} className="px-2 py-1 bg-gray-50 text-gray-500 rounded text-[10px] hover:bg-gray-100">⬇ 导出全部</button>
              <label className="px-2 py-1 bg-gray-50 text-gray-500 rounded text-[10px] hover:bg-gray-100 cursor-pointer">
                ⬆ 导入
                <input type="file" accept=".json,.md" className="hidden" onChange={e => {
                  const f = e.target.files?.[0]
                  if (f) importTagsFile(f, l1List[0]?.name ?? '通用')
                  e.target.value = ''
                }} />
              </label>
            </div>
          </aside>

          {/* ====== 右：条目列表（3级只显示标题）====== */}
          <div className="space-y-4 min-w-0">
            {/* 搜索和新建 */}
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="搜索知识..."
                  className="w-full pl-9 pr-4 py-2 rounded-xl border border-gray-200 text-sm outline-none focus:ring-2 focus:ring-blue-100"
                />
              </div>
              <button
                onClick={() => setShowForm(true)}
                className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-xl text-sm hover:bg-blue-700"
              >
                <Plus size={16} /> 新建
              </button>
              <button
                onClick={() => { setBatchMode(!batchMode); setSelectedIds(new Set()) }}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm border transition-colors ${
                  batchMode ? 'bg-purple-50 border-purple-300 text-purple-600' : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                }`}
              >
                <CheckSquare size={15} /> 批量
              </button>
            </div>

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
                    placeholder="标题（3级条目）"
                    className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm outline-none focus:ring-2 focus:ring-blue-100"
                    autoFocus
                  />
                  <div className="flex gap-2 flex-wrap">
                    <select
                      value={newCategory}
                      onChange={e => {
                        if (e.target.value === '__add_new__') {
                          const parent = l1List[0]?.name ?? '通用'
                          void (async () => {
                            const name = await askText('新标签名称（将创建在「' + parent + '」分类下）：')
                            if (!name?.trim()) return
                            const id = 'l2-' + name.trim()
                            if (!l2List.some(l => l.id === id)) {
                              await saveL2([...l2List, { id, name: name.trim(), parent }])
                              setNewCategory(name.trim())
                            }
                          })()
                        } else {
                          setNewCategory(e.target.value)
                        }
                      }}
                      className="px-3 py-2 rounded-xl border border-gray-200 text-sm outline-none"
                    >
                      <option value="" disabled>选择标签…</option>
                      {/* 按 l1 分组显示 optgroup */}
                      {l1List.map(l1 => {
                        const children = l2List.filter(l2 => l2.parent === l1.name)
                        if (children.length === 0) return null
                        return (
                          <optgroup key={l1.id} label={l1.name}>
                            {children.map(l2 => (
                              <option key={l2.id} value={l2.name}>{l2.name}</option>
                            ))}
                          </optgroup>
                        )
                      })}
                      {/* 无标签时兜底 */}
                      {l2List.length === 0 && <option value="general">通用</option>}
                      <option value="__add_new__">＋ 新建标签…</option>
                    </select>
                    <select
                      value={newFormat}
                      onChange={e => setNewFormat(e.target.value as Knowledge['format'])}
                      className="px-3 py-2 rounded-xl border border-gray-200 text-sm outline-none"
                    >
                      <option value="markdown">Markdown</option>
                      <option value="json">JSON</option>
                      <option value="plain">纯文本</option>
                    </select>
                    <input
                      type="text"
                      value={newTags}
                      onChange={e => setNewTags(e.target.value)}
                      placeholder="标签（逗号分隔）"
                      className="flex-1 px-3 py-2 rounded-xl border border-gray-200 text-sm outline-none focus:ring-2 focus:ring-blue-100"
                    />
                  </div>
                  <MarkdownEditor
                    value={newContent}
                    onChange={setNewContent}
                    placeholder={newFormat === 'json' ? '{"key": "value", ...}  输入合法 JSON' : '内容... 支持 Markdown，用 [[笔记名]] 创建链接'}
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

            {/* 条目标题列表（3级只显示标题） */}
            <div className="space-y-1">
              {visibleItems.length === 0 && (
                <div className="text-center py-12 text-gray-400">
                  <Brain size={48} className="mx-auto mb-3 opacity-30" />
                  <p>暂无知识记录</p>
                  <p className="text-sm mt-1">点击"新建"开始记录你的知识</p>
                </div>
              )}
              {visibleItems.map(k => (
                <button
                  key={k.id}
                  onClick={() => {
                    if (batchMode) {
                      setSelectedIds(prev => {
                        const next = new Set(prev)
                        if (next.has(k.id)) next.delete(k.id); else next.add(k.id)
                        return next
                      })
                    } else {
                      setViewingId(k.id)
                    }
                  }}
                  className={`w-full text-left flex items-center gap-2.5 px-4 py-2.5 rounded-xl border transition-colors ${
                    viewingId === k.id && !batchMode ? 'border-blue-300 bg-blue-50/50' :
                    selectedIds.has(k.id) ? 'border-purple-300 bg-purple-50/50' : 'border-gray-100 bg-white hover:border-blue-200'
                  }`}
                >
                  {batchMode && (
                    <span className={`w-5 h-5 rounded-md border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
                      selectedIds.has(k.id) ? 'bg-purple-500 border-purple-500' : 'border-gray-300'
                    }`}>
                      {selectedIds.has(k.id) && <Check size={12} className="text-white" />}
                    </span>
                  )}
                  <span className="text-base">{k.emoji || '📄'}</span>
                  <span className="text-sm text-gray-700 truncate flex-1">{highlight(k.title)}</span>
                  {(k as any).markType && (
                    <span className="text-[9px] px-1.5 py-0.5 bg-purple-50 text-purple-500 rounded">{(k as any).markType}</span>
                  )}
                  {k.reviewEnabled === false && <span className="text-[9px] px-1 py-0.5 bg-gray-100 text-gray-400 rounded" title="不参与复习">🚫</span>}
                  {k.isBookmarked && <span className="text-yellow-500 text-xs">★</span>}
                  <ChevronRight size={13} className="text-gray-200" />
                </button>
              ))}
            </div>
          </div>
        </div>
        )
        }

        case 'bookmark': {
          const bookmarked = knowledge.filter(k => k.isBookmarked)
          return (
            <div className="space-y-2">
              {bookmarked.length === 0 ? (
                <div className="text-center py-12 text-gray-400">
                  <Bookmark size={48} className="mx-auto mb-3 opacity-30" />
                  <p>暂无收藏 —— 在知识条目详情里点 ★ 收藏</p>
                </div>
              ) : bookmarked.map(k => (
                <button
                  key={k.id}
                  onClick={() => setViewingId(k.id)}
                  className="w-full text-left flex items-center gap-2.5 px-4 py-3 bg-white rounded-xl border border-gray-100 hover:border-yellow-200"
                >
                  <span className="text-base">{k.emoji || '📌'}</span>
                  <span className="text-sm text-gray-700 truncate flex-1">{k.title}</span>
                  <span className="text-[10px] text-gray-300 truncate max-w-[40%]">{k.category}</span>
                </button>
              ))}
            </div>
          )
        }

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

        // 合并：markType 匹配的 knowledge 条目 + 对应表记录
        const markedK = knowledge.filter(k => (k as any).markType === activeTab)
        const tableItems: any[] = info.items.map(item => ({
          ...item, _source: 'table', _type: info.type,
        }))
        const markedItems: any[] = markedK.map(k => ({
          id: k.id, title: k.title, _source: 'knowledge', _type: 'knowledge',
          content: k.content, createdAt: k.createdAt,
        }))
        const allItems = [...markedItems, ...tableItems]

        const handleEditItem = async (item: any) => {
          const title = await askText('修改标题', item.title ?? '')
          if (title === null || !title.trim()) return
          if (item._source === 'knowledge') {
            await updateObject('knowledge', item.id, { title: title.trim() })
          } else {
            await updateObject(item._type, item.id, { title: title.trim() })
          }
        }

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
              {allItems.length === 0 && (
                <div className="text-center py-8 text-gray-400 text-sm">暂无{info.label}</div>
              )}
              {allItems.map(item => (
                <div key={item.id} className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 flex items-center justify-between group">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <span className="text-lg">{info.emoji}</span>
                    <span className="text-sm font-medium text-gray-700 truncate">{item.title}</span>
                    {item._source === 'knowledge' && (
                      <button onClick={() => setViewingId(item.id)} className="text-[10px] text-blue-400 hover:text-blue-600 shrink-0" title="查看详情">
                        📄
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity shrink-0">
                    <button onClick={() => handleEditItem(item)} className="p-1 text-gray-300 hover:text-blue-500" title="编辑">
                      <Pencil size={13} />
                    </button>
                    <button
                      onClick={() => {
                        const src = item._source === 'knowledge' ? 'knowledge' : item._type
                        deleteObject(src, item.id)
                      }}
                      className="p-1 text-gray-300 hover:text-red-500"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
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

      case 'graph': {
        // 思维导图：1级分类 → 2级标签 → 3级知识条目
        const branches = l1List.map(l1 => ({
          name: l1.name,
          children: l2List
            .filter(l2 => l2.parent === l1.name)
            .map(l2 => {
              const items = knowledge.filter(k => k.category === l2.name)
              return {
                name: l2.name,
                items: items.map(k => k.title),
                summaries: items.map(k => (k.content || '').replace(/[#*`\[\]]/g, '').slice(0, 30)),
              }
            }),
        }))
        const totalItems = branches.reduce((s, b) => s + b.children.reduce((s2, c) => s2 + c.items.length, 0), 0)
        return (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-semibold text-gray-800">🧠 思维导图</h3>
                <p className="text-xs text-gray-400 mt-0.5">
                  一级分类 → 二级标签 → 三级知识 · 共 {l1List.length} 分类 / {l2List.length} 标签 / {totalItems} 条目
                </p>
              </div>
              <div className="flex gap-2">
                <button onClick={() => navigate('/ai')} className="px-3 py-1.5 bg-gray-100 text-gray-500 rounded-lg text-xs hover:bg-gray-200">
                  ← AI 中心
                </button>
              </div>
            </div>
            {l1List.length === 0 ? (
              <div className="text-center py-12 text-gray-400 text-sm">
                暂无标签体系 —— 在「全部知识」左侧添加一级分类和标签后，这里会自动生成思维导图
              </div>
            ) : (
              <MindMap
                root="📚 知识"
                branches={branches}
                onLeafClick={(title) => {
                  const k = knowledge.find(x => x.title === title)
                  if (k) {
                    setActiveTab('all')
                    setSelectedL2Filter(null)
                    setViewingId(k.id)
                  }
                }}
              />
            )}
            {/* 关系图谱保留入口 */}
            <details className="bg-white rounded-2xl border border-gray-100 p-4">
              <summary className="cursor-pointer text-xs text-gray-500">🕸️ 关系图谱（基于 Relation 连线，独立于标签层级）</summary>
              <div className="mt-3">
                <div className="flex items-center justify-between mb-2">
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
                  height={450}
                  onNodeClick={(node) => {
                    setGraphCenterId(node.id)
                    if (node.type === 'knowledge') {
                      setViewingId(node.id)
                      setActiveTab('all')
                    }
                  }}
                />
              </div>
            </details>
          </div>
        )
      }
    }
  }

  return (
    <div className="space-y-6">
      {askModal}
      {confirmModal}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">🧠 知识与思考</h1>
          <p className="text-sm text-gray-400 mt-0.5">构建你的第二大脑</p>
        </div>
      </div>

      {/* 标签页 */}
      <div role="tablist" className="flex gap-1 overflow-x-auto pb-1">
        {tabs.map(tab => (
          <button
            key={tab.key}
            role="tab"
            aria-selected={activeTab === tab.key}
            tabIndex={activeTab === tab.key ? 0 : -1}
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
                  <div className="flex gap-2 flex-wrap">
                    <select
                      value={editCategory}
                      onChange={e => {
                        if (e.target.value === '__add_new__') {
                          const parent = l1List[0]?.name ?? '通用'
                          void (async () => {
                            const name = await askText('新标签名称（将创建在「' + parent + '」分类下）：')
                            if (!name?.trim()) return
                            const id = 'l2-' + name.trim()
                            if (!l2List.some(l => l.id === id)) {
                              await saveL2([...l2List, { id, name: name.trim(), parent }])
                              setEditCategory(name.trim())
                            }
                          })()
                        } else {
                          setEditCategory(e.target.value)
                        }
                      }}
                      className="px-3 py-2 rounded-xl border border-gray-200 text-sm outline-none"
                    >
                      {l1List.map(l1 => {
                        const children = l2List.filter(l2 => l2.parent === l1.name)
                        if (children.length === 0) return null
                        return (
                          <optgroup key={l1.id} label={l1.name}>
                            {children.map(l2 => (
                              <option key={l2.id} value={l2.name}>{l2.name}</option>
                            ))}
                          </optgroup>
                        )
                      })}
                      <option value="__add_new__">＋ 新建标签…</option>
                    </select>
                    <select
                      value={editFormat}
                      onChange={e => setEditFormat(e.target.value as Knowledge['format'])}
                      className="px-3 py-2 rounded-xl border border-gray-200 text-sm outline-none"
                    >
                      <option value="markdown">Markdown</option>
                      <option value="json">JSON</option>
                      <option value="plain">纯文本</option>
                    </select>
                    <input
                      type="text"
                      value={editTags}
                      onChange={e => setEditTags(e.target.value)}
                      placeholder="标签（逗号分隔）"
                      className="flex-1 min-w-[120px] px-3 py-2 rounded-xl border border-gray-200 text-sm outline-none"
                    />
                  </div>
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

                  <div className="mb-4 flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] text-gray-400">标记为：</span>
                    {(['inspiration', 'question', 'research', 'experiment', 'decision'] as const).map(mt => (
                      <button
                        key={mt}
                        onClick={async () => {
                          const next = (viewingItem as any).markType === mt ? '' : mt
                          await updateObject('knowledge', viewingItem.id, { markType: next || undefined } as any)
                          // 真实创建对应表记录 + Relation 连线（A 修复）
                          if (next) {
                            const typeMap: Record<string, { type: ObjectType; label: string }> = {
                              inspiration: { type: 'inspiration', label: '灵感' },
                              question: { type: 'question', label: '问题' },
                              research: { type: 'research', label: '研究' },
                              experiment: { type: 'experiment', label: '实验' },
                              decision: { type: 'decision', label: '决策' },
                            }
                            const info = typeMap[mt]
                            if (info) {
                              const r = await addObject(info.type, {
                                title: viewingItem.title,
                                description: viewingItem.content?.slice(0, 100) ?? '',
                                status: mt === 'inspiration' ? 'captured' : mt === 'question' ? 'open' : mt === 'research' ? 'planned' : 'planned',
                              })
                              if (typeof r === 'string') {
                                const { createRelation } = await import('../repositories/relationRepository')
                                await createRelation('knowledge', viewingItem.id, info.type, r, 'related_to', { createdBy: 'user', source: 'manual' })
                              }
                            }
                          }
                        }}
                        className={`px-2 py-0.5 rounded-full text-[10px] border transition-colors ${
                          (viewingItem as any).markType === mt
                            ? 'bg-purple-500 text-white border-purple-500'
                            : 'bg-white text-gray-400 border-gray-200 hover:border-purple-300 hover:text-purple-500'
                        }`}
                      >
                        {mt === 'inspiration' ? '💡 灵感' : mt === 'question' ? '❓ 问题' : mt === 'research' ? '🔬 研究' : mt === 'experiment' ? '🧪 实验' : '🧩 决策'}
                      </button>
                    ))}
                  </div>

                  {/* 转化链路按钮 */}
                  <div className="mb-4 flex items-center gap-1.5 flex-wrap">
                    <span className="text-[10px] text-gray-400">下一步：</span>
                    {(() => {
                      const mt = (viewingItem as any).markType
                      if (mt === 'inspiration') return (
                        <button onClick={async () => {
                          const title = await askText('问题标题：', viewingItem.title + ' → 怎么解决？')
                          if (!title?.trim()) return
                          const r = await addObject('question', { title: title.trim(), status: 'open' })
                          if (typeof r === 'string') {
                            const { createRelation } = await import('../repositories/relationRepository')
                            await createRelation('question', r, 'knowledge', viewingItem.id, 'derived_from', { createdBy: 'user', source: 'manual' })
                            await updateObject('knowledge', viewingItem.id, { markType: 'question' } as any)
                            setViewingId(null); setViewingId(viewingItem.id)
                          }
                        }} className="px-2.5 py-1 bg-blue-50 text-blue-600 rounded-lg text-[10px] hover:bg-blue-100">
                          ❓ 转为问题
                        </button>
                      )
                      if (mt === 'question') return (
                        <button onClick={async () => {
                          const title = await askText('研究标题：', '研究：' + viewingItem.title)
                          if (!title?.trim()) return
                          const r = await addObject('research', { title: title.trim(), status: 'planned', findings: viewingItem.content?.slice(0, 100) ?? '' })
                          if (typeof r === 'string') {
                            const { createRelation } = await import('../repositories/relationRepository')
                            await createRelation('research', r, 'question', viewingItem.id, 'derived_from', { createdBy: 'user', source: 'manual' })
                            await updateObject('knowledge', viewingItem.id, { markType: 'research' } as any)
                            setViewingId(null); setViewingId(viewingItem.id)
                          }
                        }} className="px-2.5 py-1 bg-blue-50 text-blue-600 rounded-lg text-[10px] hover:bg-blue-100">
                          🔬 立项研究
                        </button>
                      )
                      if (mt === 'research') return (
                        <button onClick={async () => {
                          const r = await addObject('experiment', { title: '实验：' + viewingItem.title, status: 'planned', hypothesis: viewingItem.content?.slice(0, 100) ?? '' })
                          if (typeof r === 'string') {
                            const { createRelation } = await import('../repositories/relationRepository')
                            await createRelation('experiment', r, 'research', viewingItem.id, 'derived_from', { createdBy: 'user', source: 'manual' })
                            setViewingId(null); setViewingId(viewingItem.id)
                          }
                        }} className="px-2.5 py-1 bg-blue-50 text-blue-600 rounded-lg text-[10px] hover:bg-blue-100">
                          🧪 创建实验
                        </button>
                      )
                      if (mt === 'decision') return (
                        <button onClick={async () => {
                          const r = await addObject('process', { title: 'SOP：' + viewingItem.title, category: '决策沉淀', steps: [{ id: 's0', order: 0, title: viewingItem.content?.slice(0, 50) ?? '', description: '', checklist: [] }] })
                          if (typeof r === 'string') {
                            const { createRelation } = await import('../repositories/relationRepository')
                            await createRelation('process', r, 'knowledge', viewingItem.id, 'derived_from', { createdBy: 'user', source: 'manual' })
                          }
                        }} className="px-2.5 py-1 bg-blue-50 text-blue-600 rounded-lg text-[10px] hover:bg-blue-100">
                          📋 沉淀为 SOP
                        </button>
                      )
                      return null
                    })()}
                  </div>

                  <div className="prose prose-sm max-w-none mb-4 text-gray-700">
                    {viewingItem.format === 'json' ? (
                      <pre className="bg-gray-900 text-green-100 rounded-xl p-4 text-[11px] overflow-x-auto whitespace-pre-wrap">
                        {(() => { try { return JSON.stringify(JSON.parse(viewingItem.content), null, 2) } catch { return viewingItem.content } })()}
                      </pre>
                    ) : !viewingItem.content ? (
                      <p className="text-gray-300 italic">暂无内容</p>
                    ) : viewingItem.format === 'plain' ? (
                      <p className="whitespace-pre-wrap">{viewingItem.content}</p>
                    ) : (
                      renderMarkdown(viewingItem.content)
                    )}
                  </div>

                  <div className="flex gap-2 mb-4">
                    <button
                      onClick={() => {
                        setEditingId(viewingItem.id)
                        setEditTitle(viewingItem.title)
                        setEditContent(viewingItem.content)
                        setEditCategory(viewingItem.category)
                        setEditFormat(viewingItem.format)
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
                    <button
                      onClick={() => updateObject('knowledge', viewingItem.id, { reviewEnabled: viewingItem.reviewEnabled === false ? true : false } as any)}
                      className={`flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg ${
                        viewingItem.reviewEnabled !== false ? 'bg-purple-50 text-purple-600' : 'bg-gray-100 text-gray-400'
                      }`}
                    >
                      <RotateCw size={12} />
                      {viewingItem.reviewEnabled !== false ? '参与复习' : '不参与复习'}
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

      {/* 批量操作浮动栏 */}
      {batchMode && selectedIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-white rounded-2xl shadow-lg border border-gray-200 px-5 py-3 flex items-center gap-4 z-50">
          <span className="text-sm text-gray-500">已选 <strong className="text-purple-600">{selectedIds.size}</strong> 条</span>
          <div className="w-px h-5 bg-gray-200" />
          <button
            onClick={async () => {
              for (const id of selectedIds) await updateObject('knowledge', id, { reviewEnabled: true } as any)
              setSelectedIds(new Set())
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-50 text-purple-600 rounded-lg text-xs font-medium hover:bg-purple-100"
          >
            <RotateCw size={13} /> 全部参与复习
          </button>
          <button
            onClick={async () => {
              for (const id of selectedIds) await updateObject('knowledge', id, { reviewEnabled: false } as any)
              setSelectedIds(new Set())
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-100 text-gray-500 rounded-lg text-xs font-medium hover:bg-gray-200"
          >
            <RotateCw size={13} /> 全部关闭复习
          </button>
          <button onClick={() => { setBatchMode(false); setSelectedIds(new Set()) }} className="text-gray-400 hover:text-gray-600 ml-1">
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  )
}