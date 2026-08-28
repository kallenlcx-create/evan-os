import { useState, useEffect, useCallback, useMemo } from 'react'
import { useStore } from '../store'
import { db } from '../db'
import { Brain, Layers, Sparkles, RotateCw, Check, X, Eye, BookOpen, Zap, BarChart3, Clock, Lightbulb } from 'lucide-react'
import { classifyKnowledge, summarizeKnowledge, generateFlashcards, initFlashcard, scheduleNext, isDue, type Flashcard } from '../services/aiKnowledgeService'
import { localToday } from '../utils/date'

// 复用首页单词源（与 Home 同源，未来可抽 config）
const DAILY_WORDS = [
  { word: 'serendipity', meaning: '意外发现的美好', example: 'Finding that book was pure serendipity.' },
  { word: 'ephemeral', meaning: '短暂的，转瞬即逝的', example: 'The beauty of cherry blossoms is ephemeral.' },
  { word: 'resilience', meaning: '韧性，恢复力', example: 'Her resilience inspired everyone.' },
  { word: 'ubiquitous', meaning: '无处不在的', example: 'Smartphones have become ubiquitous.' },
  { word: 'eloquent', meaning: '雄辩的', example: 'She gave an eloquent speech.' },
  { word: 'nostalgia', meaning: '怀旧', example: 'The smell filled her with nostalgia.' },
  { word: 'paradigm', meaning: '范式', example: 'AI is creating a new paradigm.' },
  { word: 'lucid', meaning: '清晰的', example: 'He gave a lucid explanation.' },
]

type Tab = 'review' | 'knowledge'

export default function AIReviewPage() {
  const { knowledge } = useStore()
  const [tab, setTab] = useState<Tab>('review')

  // ====== 复习：Flashcards 持久化（collections:flashcard） ======
  const [cards, setCards] = useState<Flashcard[]>([])
  const [filter, setFilter] = useState<'due' | 'all' | 'new'>('due')
  const [currentIdx, setCurrentIdx] = useState(0)
  const [flipped, setFlipped] = useState(false)
  const [generating, setGenerating] = useState(false)

  const loadCards = useCallback(async () => {
    try {
      const rows = await db.collections.where('kind').equals('flashcard').toArray()
      const list: Flashcard[] = rows.map(r => r.data as Flashcard).sort((a, b) => a.dueDate.localeCompare(b.dueDate))
      setCards(list)
    } catch { setCards([]) }
  }, [])
  useEffect(() => { void loadCards() }, [loadCards])

  const saveCard = async (card: Flashcard) => {
    await db.collections.put({ id: card.id, kind: 'flashcard', data: card as any, createdAt: card.createdAt, updatedAt: new Date().toISOString() })
  }

  // 学习日志拉取（用于生成卡）
  const [studyLogs, setStudyLogs] = useState<any[]>([])
  useEffect(() => {
    ;(async () => {
      try {
        const rows = await db.collections.where('kind').equals('study_log').toArray()
        setStudyLogs(rows.map(r => ({ id: r.id, ...(r.data as any) })))
      } catch { setStudyLogs([]) }
    })()
  }, [])

  const todayStr = localToday()
  const dueCards = useMemo(() => cards.filter(c => isDue(c, todayStr)), [cards, todayStr])
  const newCards = useMemo(() => cards.filter(c => c.reps === 0), [cards])
  const boxCounts = useMemo(() => {
    const m: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
    for (const c of cards) m[c.box] = (m[c.box] || 0) + 1
    return m
  }, [cards])

  const visiblePool = filter === 'due' ? dueCards : filter === 'new' ? newCards : cards
  const current = visiblePool[currentIdx] ?? null

  const handleRate = async (rating: 0 | 1 | 2 | 3) => {
    if (!current) return
    const next = scheduleNext(current, rating)
    await saveCard(next)
    setCards(prev => prev.map(c => c.id === current.id ? next : c))
    setFlipped(false)
    // 移动指针
    setCurrentIdx(i => Math.min(i, Math.max(0, visiblePool.length - 2)))
    if (visiblePool.length <= 1) setTimeout(() => loadCards(), 200)
  }

  const handleGenerate = async () => {
    setGenerating(true)
    try {
      const dayIdx = Math.floor(Date.now() / 86400000)
      const words = [DAILY_WORDS[dayIdx % DAILY_WORDS.length], DAILY_WORDS[(dayIdx + 1) % DAILY_WORDS.length]]
      const raws = await generateFlashcards({ knowledges: knowledge, words, logs: studyLogs, max: 18 })
      const inited = raws.map(initFlashcard)
      // 去重：已存在同 sourceId 不重复
      const existingIds = new Set(cards.map(c => c.id))
      const toAdd = inited.filter(c => !existingIds.has(c.id))
      for (const c of toAdd) await saveCard(c)
      await loadCards()
      setFilter('due'); setCurrentIdx(0)
    } finally { setGenerating(false) }
  }

  const handleDeleteAll = async () => {
    if (!confirm('清空所有复习卡？')) return
    const rows = await db.collections.where('kind').equals('flashcard').toArray()
    for (const r of rows) await db.collections.delete(r.id)
    setCards([])
  }

  // ====== 知识 AI 汇总 ======
  const [groups, setGroups] = useState<Awaited<ReturnType<typeof classifyKnowledge>>>([])
  const [summaries, setSummaries] = useState<Awaited<ReturnType<typeof summarizeKnowledge>>>([])
  const [aiLoading, setAiLoading] = useState(false)
  const runAI = async () => {
    setAiLoading(true)
    try {
      const [g, s] = await Promise.all([classifyKnowledge(knowledge), summarizeKnowledge(knowledge)])
      setGroups(g); setSummaries(s)
    } finally { setAiLoading(false) }
  }
  useEffect(() => { if (knowledge.length > 0 && groups.length === 0) void runAI() }, [knowledge.length])

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2">🧠 AI 复习中心</h1>
          <p className="text-xs text-gray-400 mt-1">SM-2 / FSRS + Leitner 5盒 · 单词×知识×学习日志 一键抽卡 · 遵循 <a href="https://github.com/open-spaced-repetition/fsrs4anki" target="_blank" className="text-blue-500 underline">open-spaced-repetition/fsrs</a> 最佳实践</p>
        </div>
        <div className="flex gap-2">
          <button onClick={handleGenerate} disabled={generating} className="px-4 py-2 bg-blue-600 text-white rounded-xl text-sm hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5">
            <Sparkles size={14} /> {generating ? '生成中...' : 'AI 一键生成今日卡'}
          </button>
        </div>
      </div>

      {/* 数据总览 */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="bg-white rounded-2xl p-4 border border-gray-100 text-center">
          <div className="text-2xl font-bold text-red-500">{dueCards.length}</div>
          <div className="text-[11px] text-gray-400">今日到期</div>
        </div>
        <div className="bg-white rounded-2xl p-4 border border-gray-100 text-center">
          <div className="text-2xl font-bold text-blue-600">{newCards.length}</div>
          <div className="text-[11px] text-gray-400">新卡</div>
        </div>
        <div className="bg-white rounded-2xl p-4 border border-gray-100 text-center">
          <div className="text-2xl font-bold text-gray-700">{cards.length}</div>
          <div className="text-[11px] text-gray-400">总卡片</div>
        </div>
        <div className="bg-white rounded-2xl p-4 border border-gray-100 text-center">
          <div className="text-2xl font-bold text-green-600">{cards.filter(c=>c.box===5).length}</div>
          <div className="text-[11px] text-gray-400">已掌握 Box5</div>
        </div>
        <div className="bg-white rounded-2xl p-4 border border-gray-100 text-center">
          <div className="text-2xl font-bold text-purple-600">{knowledge.length}</div>
          <div className="text-[11px] text-gray-400">知识条目</div>
        </div>
      </div>

      {/* Leitner 盒子可视化 */}
      <div className="bg-white rounded-2xl p-4 border border-gray-100">
        <div className="text-xs font-semibold text-gray-500 mb-3 flex items-center gap-2"><Layers size={14}/> Leitner 5盒（GitHub 方案：Box1每日 / Box2隔3天 / Box3周 / Box4两周 / Box5月）</div>
        <div className="grid grid-cols-5 gap-2">
          {[1,2,3,4,5].map(box => (
            <div key={box} className={`rounded-xl p-3 text-center border ${dueCards.some(c=>c.box===box) ? 'border-amber-300 bg-amber-50' : 'border-gray-100 bg-gray-50'}`}>
              <div className="text-[10px] text-gray-400">Box {box}</div>
              <div className="text-lg font-bold text-gray-700">{boxCounts[box] ?? 0}</div>
              <div className="text-[9px] text-gray-400">{[1,3,7,14,30][box-1]}天</div>
            </div>
          ))}
        </div>
        <div className="text-[10px] text-gray-300 mt-2">Again→Box1 重置 · Hard停留 · Good/Easy 晋盒 · 间隔 = max(盒天数, SM-2 ease×interval) · FSRS 可直接替换 <code>scheduleNext</code> 为 <code>ts-fsrs</code></div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2">
        {([{key:'review',label:'🔁 复习',icon:RotateCw},{key:'knowledge',label:'📚 知识AI汇总',icon:Brain}] as const).map(t=>(
          <button key={t.key} onClick={()=>setTab(t.key)} className={`px-4 py-2 rounded-xl text-sm flex items-center gap-1.5 ${tab===t.key?'bg-blue-600 text-white':'bg-white border border-gray-200 text-gray-500'}`}>
            <t.icon size={14}/> {t.label}
          </button>
        ))}
        <div className="ml-auto flex gap-1">
          {(['due','new','all'] as const).map(k=>(
            <button key={k} onClick={()=>{setFilter(k);setCurrentIdx(0)}} className={`px-3 py-1.5 rounded-full text-xs ${filter===k?'bg-gray-900 text-white':'bg-white border text-gray-500'}`}>{k==='due'?'到期':k==='new'?'新卡':'全部'} ({k==='due'?dueCards.length:k==='new'?newCards.length:cards.length})</button>
          ))}
        </div>
      </div>

      {tab==='review' ? (
        <div className="grid lg:grid-cols-[1.2fr_0.8fr] gap-4">
          {/* 闪卡区 */}
          <div className="bg-white rounded-2xl border border-gray-100 p-6 min-h-[380px] flex flex-col">
            {cards.length===0 ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center py-12">
                <Sparkles size={36} className="text-blue-200 mb-3"/>
                <p className="text-sm text-gray-500">还没有复习卡</p>
                <p className="text-xs text-gray-400 mt-1">点右上「AI 一键生成今日卡」将你的知识+单词+学习日志抽成 Anki 式卡片</p>
                <button onClick={handleGenerate} className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-xl text-sm">立即生成</button>
              </div>
            ) : visiblePool.length===0 ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center py-12">
                <Check size={36} className="text-green-400 mb-3"/>
                <p className="text-sm font-medium text-gray-700">今日已完成 🎉</p>
                <p className="text-xs text-gray-400 mt-1">{filter==='due'?'到期卡清零，去看看全部或新卡':filter==='new'?'无新卡，去复习到期卡':''}</p>
              </div>
            ) : current ? (
              <>
                <div className="flex items-center justify-between text-[11px] text-gray-400 mb-4">
                  <span>{currentIdx+1} / {visiblePool.length} · {current.sourceType} · Box{current.box} · 间隔{current.interval}天 · 到期{current.dueDate}</span>
                  <span className="px-2 py-0.5 bg-gray-100 rounded-full">{current.hint ?? ''}</span>
                </div>
                <div onClick={()=>setFlipped(v=>!v)} className="flex-1 flex flex-col items-center justify-center cursor-pointer select-none min-h-[180px] rounded-2xl border-2 border-dashed border-blue-100 bg-blue-50/30 p-6 text-center hover:bg-blue-50/50 transition">
                  {!flipped ? (
                    <>
                      <Eye size={20} className="text-blue-300 mb-2"/>
                      <div className="text-lg font-semibold text-gray-800 whitespace-pre-wrap">{current.front}</div>
                      <div className="text-[11px] text-gray-400 mt-3">点击翻面 · 主动回忆（Active Recall）比重读有效 2倍</div>
                    </>
                  ) : (
                    <div className="whitespace-pre-wrap text-sm text-gray-700 leading-relaxed">{current.back}</div>
                  )}
                </div>
                <div className="text-[10px] text-gray-300 text-center mt-2">GitHub Anki 最佳实践：先在脑内检索答案，再翻面核对</div>
                {/* 四档按钮（SM-2/FSRS） */}
                <div className="grid grid-cols-4 gap-2 mt-4">
                  {([
                    {k:0,label:'重来',sub:'1天',color:'bg-red-500 hover:bg-red-600',icon:X},
                    {k:1,label:'困难',sub:'2-3天',color:'bg-orange-400 hover:bg-orange-500',icon:Clock},
                    {k:2,label:'良好',sub:`${Math.max(3,Math.round(current.interval*current.ease))}天`,color:'bg-green-500 hover:bg-green-600',icon:Check},
                    {k:3,label:'简单',sub:`${Math.max(4,Math.round(current.interval*current.ease*1.3))}天`,color:'bg-blue-500 hover:bg-blue-600',icon:Sparkles},
                  ] as const).map(b=>(
                    <button key={b.k} onClick={()=>handleRate(b.k)} className={`py-2.5 rounded-xl text-white text-sm font-medium ${b.color} flex flex-col items-center leading-tight`}>
                      <span className="flex items-center gap-1"><b.icon size={12}/>{b.label}</span>
                      <span className="text-[10px] opacity-80">{b.sub}</span>
                    </button>
                  ))}
                </div>
                <div className="flex justify-between mt-3">
                  <button onClick={()=>setCurrentIdx(i=> (i+1)%visiblePool.length)} className="text-xs text-gray-400 hover:text-gray-600">跳过 →</button>
                  <button onClick={handleDeleteAll} className="text-xs text-gray-300 hover:text-red-400">清空卡库</button>
                </div>
              </>
            ) : null}
          </div>

          {/* 右：今日到期列表+说明 */}
          <div className="space-y-4">
            <div className="bg-white rounded-2xl border border-gray-100 p-4">
              <div className="text-xs font-semibold text-gray-600 mb-2 flex items-center gap-1.5"><BarChart3 size={14}/> 今日队列（按到期排序）</div>
              <div className="space-y-1 max-h-[220px] overflow-y-auto">
                {dueCards.slice(0,12).map(c=>(
                  <div key={c.id} className={`flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs ${c.id===current?.id?'bg-blue-50 border border-blue-200':'bg-gray-50'}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${c.box===1?'bg-red-400':c.box===5?'bg-green-500':'bg-gray-300'}`}/>
                    <span className="truncate flex-1 text-gray-700">{c.front.slice(0,22)}</span>
                    <span className="text-[10px] text-gray-400">Box{c.box}</span>
                  </div>
                ))}
                {dueCards.length===0 && <div className="text-xs text-gray-300 text-center py-6">今日无到期，超前学点新卡吧</div>}
              </div>
            </div>
            <div className="bg-gradient-to-br from-purple-50 to-blue-50 rounded-2xl border border-purple-100 p-4">
              <div className="text-xs font-semibold text-gray-700 mb-1 flex items-center gap-1"><Zap size={13}/> 为何这样设计</div>
              <ul className="text-[11px] text-gray-500 space-y-1 leading-relaxed">
                <li>• 遗忘曲线：Box1-5 间隔 1-3-7-14-30 天，卡住的退回 Box1（Leitner 原教旨）</li>
                <li>• SM-2 易度：Again -0.2 / Hard -0.05 / Good +0.02 / Easy +0.08（Anki 实测有效）</li>
                <li>• FSRS 升级：已留 <code>ts-fsrs</code> 接口，替换 <code>scheduleNext</code> 即可获得个性化 21 参数预测（open-spaced-repetition/fsrs4anki 4k★）</li>
                <li>• 双向卡：单词正向+反向各一张，知识“是什么→怎么用”各一张，符合主动回忆</li>
              </ul>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <button onClick={runAI} disabled={aiLoading} className="px-4 py-2 bg-white border border-gray-200 rounded-xl text-sm flex items-center gap-1.5 hover:bg-gray-50">
              <RotateCw size={14} className={aiLoading?'animate-spin':''}/> {aiLoading?'分析中...':'重新分类汇总'}
            </button>
            <span className="text-xs text-gray-400">基于 标题/内容/标签 关键词 + 记忆置信度，Mock 可无缝换真实 LLM</span>
          </div>

          {summaries.length===0 ? (
            <div className="text-center py-12 text-gray-400 text-sm">暂无知识，去「知识与思考」新建几条再来</div>
          ) : (
            <>
              <div className="grid md:grid-cols-3 gap-3">
                {summaries.map(s=>(
                  <div key={s.category} className="bg-white rounded-2xl border border-gray-100 p-4">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-bold text-gray-700">{s.category}</span>
                      <span className="text-[10px] px-1.5 py-0.5 bg-blue-50 text-blue-600 rounded-full">{s.count}条</span>
                    </div>
                    <div className="text-xs text-gray-600 leading-relaxed">{s.summary}</div>
                    <div className="text-[11px] text-gray-400 mt-2 space-y-0.5">
                      {s.keyPoints.map((p,i)=><div key={i} className="flex gap-1"><span className="text-blue-300">•</span><span className="truncate">{p}</span></div>)}
                    </div>
                  </div>
                ))}
              </div>

              {/* 分类细表 */}
              <div className="space-y-3">
                {groups.map(g=>(
                  <div key={g.category} className="bg-white rounded-2xl border border-gray-100 p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-sm font-semibold text-gray-700">{g.category} <span className="text-xs text-gray-300">({g.items.length})</span></span>
                      <span className="text-[10px] px-1.5 py-0.5 bg-green-50 text-green-600 rounded-full">置信 {(g.confidence*100).toFixed(0)}%</span>
                      <span className="text-[10px] text-gray-400 truncate">关键词: {g.keywords.join('、')||'—'}</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {g.items.slice(0,12).map(k=>(
                        <span key={k.id} className="px-2 py-1 bg-gray-50 border border-gray-100 rounded-full text-xs text-gray-600 flex items-center gap-1">
                          <BookOpen size={10} className="text-gray-300"/> {k.title}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <div className="bg-white rounded-2xl border border-gray-100 p-4">
                <div className="text-xs font-semibold text-gray-600 mb-2 flex items-center gap-1.5"><Lightbulb size={14}/> 提炼说明（可接 LLM）</div>
                <div className="text-xs text-gray-500 leading-relaxed space-y-1">
                  <div>当前为<strong>确定性启发式</strong>（关键词+类别），已把 <code>classifyKnowledge/summarizeKnowledge/generateFlashcards</code> 抽到 <code>src/services/aiKnowledgeService.ts</code>，替换内部 80ms 延迟为 <code>fetch('/v1/chat/completions', prompt)</code> 即可真 AI。</div>
                  <div>建议 Prompt：你是知识管理员，将下列 {knowledge.length} 条笔记按“英语/外贸/独立站/AI/通用”分类，输出JSON category/confidence/keywords/summary/keyPoints[3]，温度 0.2。</div>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
