// ====== AI 知识服务（Mock版，可一键替换为真实 LLM Provider）======
// 职责：分类 / 汇总 / 提炼 / 抽卡（闪卡生成）
// 设计：所有函数为纯异步，内部为确定性启发式，未来把 `await callLLM(prompt)` 替换即可
// 参：GitHub open-spaced-repetition/ts-fsrs + SM-2/Leitner 最佳实践见 review 页

import type { Knowledge } from '../types'

export interface ClassifiedGroup {
  category: string
  items: Knowledge[]
  confidence: number
  keywords: string[]
}

export interface KnowledgeSummary {
  category: string
  count: number
  keyPoints: string[] // 提炼的要点
  summary: string
  coverage: string // 如 "外贸 3条 / AI 5条"
}

export interface Flashcard {
  id: string
  front: string
  back: string
  hint?: string
  sourceType: 'knowledge' | 'word' | 'study_log' | 'seoKeyword'
  sourceId: string
  // FSRS/Leitner 调度字段（持久化到 collections:flashcard）
  box: number // 1-5 Leitner
  interval: number // 天
  dueDate: string // YYYY-MM-DD
  ease: number // 1.3 - 2.5
  reps: number
  lapses: number
  createdAt: string
  lastReviewedAt?: string
}

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  '英语': ['英语','english','单词','语法','口语','听力','vocab'],
  '外贸': ['外贸','客户','询盘','报价','谈判','贸易','trade','customer'],
  '独立站': ['shopify','独立站','电商','转化','引流','seo','流量'],
  'AI': ['ai','模型','自动化','workflow','agent','提示词','llm'],
  '效率': ['效率','习惯','任务','番茄','复盘','时间'],
  '思考': ['思考','决策','研究','实验','复盘','反思'],
  '技术': ['技术','代码','react','typescript','vite','dexie'],
  '通用': [],
}

function normalize(s: string): string { return s.toLowerCase() }

export async function classifyKnowledge(items: Knowledge[]): Promise<ClassifiedGroup[]> {
  // Mock LLM：按标题+内容+tags 关键词命中归类，置信度按命中数
  const groups = new Map<string, Knowledge[]>()
  const kwMap = new Map<string, string[]>()
  for (const k of items) {
    const hay = normalize(`${k.title} ${k.content} ${k.tags.join(' ')} ${k.category}`)
    let best = '通用'
    let bestScore = -1
    let hits: string[] = []
    for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
      if (cat === '通用') continue
      const matched = kws.filter(w => hay.includes(normalize(w)))
      if (matched.length > bestScore) { best = cat; bestScore = matched.length; hits = matched }
    }
    // 若显式 category 命中已有 L1/L2，直接用它
    if (k.category && CATEGORY_KEYWORDS[k.category] !== undefined) best = k.category
    if (!groups.has(best)) { groups.set(best, []); kwMap.set(best, []) }
    groups.get(best)!.push(k)
    // 累积关键词
    const prev = kwMap.get(best)!
    hits.forEach(h => { if (!prev.includes(h)) prev.push(h) })
  }
  const out: ClassifiedGroup[] = []
  for (const [cat, arr] of groups) {
    const avgHits = arr.length ? (kwMap.get(cat)?.length ?? 0) / arr.length : 0
    const confidence = Math.min(0.95, 0.5 + avgHits * 0.15 + Math.min(0.2, arr.length * 0.02))
    out.push({ category: cat, items: arr, confidence: Number(confidence.toFixed(2)), keywords: kwMap.get(cat) ?? [] })
  }
  out.sort((a, b) => b.items.length - a.items.length)
  // 模拟网络延迟
  await new Promise(r => setTimeout(r, 80))
  return out
}

export async function summarizeKnowledge(items: Knowledge[]): Promise<KnowledgeSummary[]> {
  const groups = await classifyKnowledge(items)
  const summaries: KnowledgeSummary[] = groups.map(g => {
    const contents = g.items.map(k => (k.content || k.description || '').replace(/\s+/g, ' ').trim()).filter(Boolean)
    // 提炼要点：每条取首句
    const keyPoints = contents.slice(0, 5).map(c => {
      const sentence = c.split(/。|！|？|\. /)[0] || c
      return sentence.slice(0, 80) + (sentence.length > 80 ? '…' : '')
    }).filter(Boolean).slice(0, 3)
    const summary = g.items.length === 0 ? '暂无内容' :
      `${g.category} 共 ${g.items.length} 条，关键词：${g.keywords.join('、') || g.category}。核心：${keyPoints.join('；').slice(0, 120)}`
    return {
      category: g.category,
      count: g.items.length,
      keyPoints,
      summary,
      coverage: `${g.category} ${g.items.length}条 / 共${items.length}条`,
    }
  })
  await new Promise(r => setTimeout(r, 80))
  return summaries
}

// 抽卡：把知识/单词/学习日志转成记忆卡
export async function generateFlashcards(opts: {
  knowledges: Knowledge[]
  words?: { word: string; meaning: string; example: string }[]
  logs?: { subject: string; notes: string; date: string; id: string }[]
  max?: number
}): Promise<Omit<Flashcard,'box'|'interval'|'dueDate'|'ease'|'reps'|'lapses'|'createdAt'>[]> {
  const { knowledges, words = [], logs = [], max = 20 } = opts
  const cards: Omit<Flashcard,'box'|'interval'|'dueDate'|'ease'|'reps'|'lapses'|'createdAt'>[] = []

  // 1) 知识 → 问答卡（只抽取 reviewEnabled !== false 的条目）
  const reviewable = knowledges.filter(k => k.reviewEnabled !== false)
  for (const k of reviewable.slice(0, 12)) {
    const q = k.title.length < 30 ? `什么是「${k.title}」？` : k.title
    const a = (k.content || k.description || '').slice(0, 180) || '暂无内容，需补充'
    cards.push({ id: `kc-${k.id}`, front: q, back: a, hint: k.category, sourceType: 'knowledge', sourceId: k.id })
    // 追加一道“应用题”
    if (cards.length < max && a.length > 40) {
      cards.push({ id: `kc2-${k.id}`, front: `如何应用：${k.title}`, back: a.slice(0, 120), hint: '应用', sourceType: 'knowledge', sourceId: k.id })
    }
    if (cards.length >= max) break
  }
  // 2) 单词 → 中英互译双向卡（GitHub Anki 最佳实践：正向+反向）
  for (const w of words.slice(0, 8)) {
    if (cards.length >= max) break
    cards.push({ id: `w1-${w.word}`, front: w.word, back: `${w.meaning}\n${w.example}`, hint: '英→中', sourceType: 'word', sourceId: w.word })
    if (cards.length < max) cards.push({ id: `w2-${w.word}`, front: w.meaning, back: `${w.word}\n${w.example}`, hint: '中→英', sourceType: 'word', sourceId: w.word })
  }
  // 3) 学习日志 → 回忆卡
  for (const l of logs.slice(0, 6)) {
    if (cards.length >= max) break
    cards.push({ id: `lg-${l.id}`, front: `${l.date} 学了什么？\n${l.subject}`, back: l.notes || '无笔记', hint: '回忆', sourceType: 'study_log', sourceId: l.id })
  }
  await new Promise(r => setTimeout(r, 120))
  return cards.slice(0, max)
}

// ====== SM-2 / FSRS 简化调度（兼容 GitHub open-spaced-repetition/ts-fsrs 的四档）======
// 评级：0 Again 1 Hard 2 Good 3 Easy
// 简化公式：基于 SM-2，易度 ease 起 2.5，Again 重置，Hard +1天，Good *ease，Easy *ease*1.3
// 真 FSRS 接入：把此函数替换为 `import { fsrs, Rating } from 'ts-fsrs'` 调用即可，卡结构兼容
export type Rating = 0 | 1 | 2 | 3

export function scheduleNext(card: Flashcard, rating: Rating): Flashcard {
  const now = new Date()
  let { box, interval, ease, reps, lapses } = card
  reps += 1
  if (rating === 0) { // Again：退回 Box1，间隔1天，引入惩罚
    box = 1; interval = 1; lapses += 1; ease = Math.max(1.3, ease - 0.2)
  } else if (rating === 1) { // Hard
    box = Math.max(1, box); interval = Math.max(2, Math.round(interval * 1.2)); ease = Math.max(1.3, ease - 0.05)
  } else if (rating === 2) { // Good
    box = Math.min(5, box + 1); interval = Math.max(3, Math.round(interval * ease)); ease = Math.min(2.8, ease + 0.02)
  } else { // Easy
    box = Math.min(5, box + 1); interval = Math.max(4, Math.round(interval * ease * 1.3)); ease = Math.min(2.9, ease + 0.08)
  }
  // Leitner 盒子天数映射（与间隔取大）：Box1:1 Box2:3 Box3:7 Box4:14 Box5:30
  const boxDays = [1, 1, 3, 7, 14, 30][box] ?? 30
  interval = Math.max(interval, boxDays)
  // 最长 365 天
  interval = Math.min(365, interval)
  const due = new Date(now.getTime() + interval * 86400000)
  const dueStr = due.toISOString().slice(0, 10)
  return { ...card, box, interval, ease: Number(ease.toFixed(2)), reps, lapses, dueDate: dueStr, lastReviewedAt: now.toISOString() }
}

export function isDue(card: Flashcard, today = new Date().toISOString().slice(0, 10)): boolean {
  return card.dueDate <= today
}

// 本地启发：生成 mock 时给初始 interval/due
export function initFlashcard(raw: Omit<Flashcard,'box'|'interval'|'dueDate'|'ease'|'reps'|'lapses'|'createdAt'>): Flashcard {
  return {
    ...raw,
    box: 1,
    interval: 1,
    dueDate: new Date().toISOString().slice(0, 10),
    ease: 2.5,
    reps: 0,
    lapses: 0,
    createdAt: new Date().toISOString(),
  }
}
