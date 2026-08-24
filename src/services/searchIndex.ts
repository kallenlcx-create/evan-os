// ====== SearchIndex — 内存倒排索引 ======
// 对所有可搜索对象建立关键词倒排索引，支持精确匹配和模糊匹配
// 不使用向量数据库，纯结构化搜索

import type { AnyObject, ObjectType, BaseObject } from '../types'

// ====== 类型定义 ======

export interface IndexedItem {
  id: string
  type: ObjectType
  title: string
  description: string
  emoji: string
  tags: string[]
  // 状态（task/project 等，用于结构化过滤）
  status?: string
  // 额外可搜索字段（如 content, company 等）
  extraFields: string[]
  createdAt: string
  updatedAt: string
  // 索引时间戳
  indexedAt: number
}

export interface SearchResult {
  item: IndexedItem
  score: number
  matchedFields: string[]
  matchType: 'exact' | 'fuzzy' | 'prefix'
}

// 倒排索引: token -> Set<itemId>
type PostingList = Map<string, Set<string>>

// ====== 分词器 ======

/**
 * 将文本分词为小写 token
 * 中文按字符拆分，英文按单词拆分
 */
export function tokenize(text: string): string[] {
  if (!text) return []
  const tokens: string[] = []
  const lower = text.toLowerCase()

  // 英文/数字单词
  const words = lower.match(/[a-z0-9]+/g)
  if (words) tokens.push(...words)

  // 中文字符（逐字索引，支持中文搜索）
  const chineseChars = lower.match(/[\u4e00-\u9fff]/g)
  if (chineseChars) tokens.push(...chineseChars)

  return tokens
}

/**
 * 生成 n-gram（用于模糊匹配）
 * bigram: 两字组合
 */
export function bigrams(text: string): string[] {
  const tokens = tokenize(text)
  const grams: string[] = []
  for (let i = 0; i < tokens.length - 1; i++) {
    // 中文 bigram：字符级
    if (tokens[i].length === 1 && tokens[i + 1].length === 1) {
      grams.push(tokens[i] + tokens[i + 1])
    }
  }
  // 英文 bigram
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i].length > 1) {
      grams.push(tokens[i])
    }
  }
  return grams
}

// ====== SearchIndex 类 ======

export class SearchIndex {
  private items: Map<string, IndexedItem> = new Map()
  private titleIndex: PostingList = new Map()      // title 倒排索引
  private descIndex: PostingList = new Map()        // description 倒排索引
  private tagIndex: PostingList = new Map()         // tags 倒排索引
  private extraIndex: PostingList = new Map()       // 额外字段倒排索引
  private typeIndex: Map<ObjectType, Set<string>> = new Map()  // 类型索引
  private recentIds: string[] = []                  // 最近访问
  private readonly MAX_RECENT = 20

  // ====== 从对象列表重建索引 ======
  rebuild(objects: AnyObject[]): void {
    this.clear()
    for (const obj of objects) {
      this.add(obj)
    }
  }

  // ====== 添加单个对象 ======
  add(obj: AnyObject): void {
    const item = this.toIndexedItem(obj)
    this.items.set(item.id, item)
    this.indexField(item.id, item.title, this.titleIndex)
    this.indexField(item.id, item.description, this.descIndex)
    for (const tag of item.tags) {
      this.indexToken(item.id, tag.toLowerCase(), this.tagIndex)
    }
    for (const field of item.extraFields) {
      this.indexField(item.id, field, this.extraIndex)
    }
    // 类型索引
    if (!this.typeIndex.has(item.type)) {
      this.typeIndex.set(item.type, new Set())
    }
    this.typeIndex.get(item.type)!.add(item.id)
  }

  // ====== 移除单个对象 ======
  remove(id: string): void {
    this.items.delete(id)
    this.removeFromPosting(this.titleIndex, id)
    this.removeFromPosting(this.descIndex, id)
    this.removeFromPosting(this.tagIndex, id)
    this.removeFromPosting(this.extraIndex, id)
    for (const set of this.typeIndex.values()) set.delete(id)
    this.recentIds = this.recentIds.filter(r => r !== id)
  }

  // ====== 清空索引 ======
  clear(): void {
    this.items.clear()
    this.titleIndex.clear()
    this.descIndex.clear()
    this.tagIndex.clear()
    this.extraIndex.clear()
    this.typeIndex.clear()
    this.recentIds = []
  }

  // ====== 记录最近访问 ======
  markRecent(id: string): void {
    this.recentIds = [id, ...this.recentIds.filter(r => r !== id)].slice(0, this.MAX_RECENT)
  }

  // ====== 获取最近访问 ======
  getRecent(limit = 10): IndexedItem[] {
    return this.recentIds
      .slice(0, limit)
      .map(id => this.items.get(id))
      .filter(Boolean) as IndexedItem[]
  }

  // ====== 获取索引大小 ======
  size(): number {
    return this.items.size
  }

  // ====== 获取所有已索引项 ======
  getAll(): IndexedItem[] {
    return Array.from(this.items.values())
  }

  // ====== 获取按类型过滤的项 ======
  getByType(type: ObjectType): IndexedItem[] {
    const ids = this.typeIndex.get(type)
    if (!ids) return []
    return Array.from(ids).map(id => this.items.get(id)).filter(Boolean) as IndexedItem[]
  }

  // ====== 搜索（核心）======
  search(
    query: string,
    options?: {
      types?: ObjectType[]
      tags?: string[]
      limit?: number
    }
  ): SearchResult[] {
    if (!query.trim()) return []
    const q = query.toLowerCase().trim()
    const limit = options?.limit || 50
    const results = new Map<string, SearchResult>()

    // 1. 精确匹配（title 完全匹配得分最高）
    this.exactMatch(q, this.titleIndex, results, 100, 'title')
    this.exactMatch(q, this.descIndex, results, 50, 'description')

    // 2. 前缀匹配
    this.prefixMatch(q, this.titleIndex, results, 70, 'title')
    this.prefixMatch(q, this.tagIndex, results, 60, 'tags')

    // 3. 模糊匹配（token 级别）
    const queryTokens = tokenize(q)
    for (const token of queryTokens) {
      if (token.length < 1) continue
      this.tokenMatch(token, this.titleIndex, results, 40, 'title')
      this.tokenMatch(token, this.descIndex, results, 20, 'description')
      this.tokenMatch(token, this.extraIndex, results, 15, 'content')
      this.tokenMatch(token, this.tagIndex, results, 30, 'tags')
    }

    // 4. 多 token 同时命中加分
    if (queryTokens.length > 1) {
      for (const [id, sr] of results) {
        const allMatched = queryTokens.every(token =>
          sr.matchedFields.length > 0
        )
        if (allMatched) {
          sr.score += 25
        }
      }
    }

    // 5. 过滤
    let filtered = Array.from(results.values())
    if (options?.types && options.types.length > 0) {
      const typeSet = new Set(options.types)
      filtered = filtered.filter(sr => typeSet.has(sr.item.type))
    }
    if (options?.tags && options.tags.length > 0) {
      const tagSet = new Set(options.tags.map(t => t.toLowerCase()))
      filtered = filtered.filter(sr =>
        sr.item.tags.some(t => tagSet.has(t.toLowerCase()))
      )
    }

    // 6. 排序：分数降序 → 更新时间降序
    filtered.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return (b.item.updatedAt || '').localeCompare(a.item.updatedAt || '')
    })

    return filtered.slice(0, limit)
  }

  // ====== 私有方法 ======

  private toIndexedItem(obj: AnyObject): IndexedItem {
    const base = obj as BaseObject & Record<string, any>
    // 收集额外可搜索字段
    const extraFields: string[] = []
    const extraKeys = ['content', 'company', 'contactName', 'email', 'phone',
      'country', 'website', 'notes', 'summary', 'hypothesis', 'findings',
      'conclusion', 'rationale', 'answer', 'result', 'keyTakeaways']
    for (const key of extraKeys) {
      if (base[key] && typeof base[key] === 'string') {
        extraFields.push(base[key])
      }
    }

    return {
      id: base.id,
      type: base.type,
      title: base.title || '',
      description: base.description || '',
      emoji: base.emoji || '📌',
      tags: base.tags || [],
      status: typeof base.status === 'string' ? base.status : undefined,
      extraFields,
      createdAt: base.createdAt || '',
      updatedAt: base.updatedAt || '',
      indexedAt: Date.now(),
    }
  }

  private indexField(itemId: string, text: string, index: PostingList): void {
    const tokens = tokenize(text)
    for (const token of tokens) {
      this.indexToken(itemId, token, index)
    }
  }

  private indexToken(itemId: string, token: string, index: PostingList): void {
    if (!index.has(token)) index.set(token, new Set())
    index.get(token)!.add(itemId)
  }

  private removeFromPosting(index: PostingList, itemId: string): void {
    for (const [token, ids] of index) {
      ids.delete(itemId)
      if (ids.size === 0) index.delete(token)
    }
  }

  private exactMatch(
    q: string, index: PostingList, results: Map<string, SearchResult>,
    score: number, field: string
  ): void {
    const ids = index.get(q)
    if (!ids) return
    for (const id of ids) {
      this.updateResult(results, id, score, field, 'exact')
    }
  }

  private prefixMatch(
    q: string, index: PostingList, results: Map<string, SearchResult>,
    score: number, field: string
  ): void {
    for (const [token, ids] of index) {
      if (token.startsWith(q) && token !== q) {
        for (const id of ids) {
          this.updateResult(results, id, score, field, 'prefix')
        }
      }
    }
  }

  private tokenMatch(
    token: string, index: PostingList, results: Map<string, SearchResult>,
    score: number, field: string
  ): void {
    // 精确 token 匹配
    const exactIds = index.get(token)
    if (exactIds) {
      for (const id of exactIds) {
        this.updateResult(results, id, score, field, 'fuzzy')
      }
    }
    // 前缀 token 匹配（得分略低）
    if (token.length >= 2) {
      for (const [t, ids] of index) {
        if (t.startsWith(token) && t !== token) {
          for (const id of ids) {
            this.updateResult(results, id, Math.floor(score * 0.6), field, 'fuzzy')
          }
        }
      }
    }
  }

  private updateResult(
    results: Map<string, SearchResult>,
    id: string,
    score: number,
    field: string,
    matchType: 'exact' | 'fuzzy' | 'prefix'
  ): void {
    const item = this.items.get(id)
    if (!item) return

    const existing = results.get(id)
    if (existing) {
      existing.score += score
      if (!existing.matchedFields.includes(field)) {
        existing.matchedFields.push(field)
      }
      // 保留最高匹配级别
      if (matchType === 'exact') existing.matchType = 'exact'
      else if (matchType === 'prefix' && existing.matchType === 'fuzzy') {
        existing.matchType = 'prefix'
      }
    } else {
      results.set(id, {
        item,
        score,
        matchedFields: [field],
        matchType,
      })
    }
  }
}
