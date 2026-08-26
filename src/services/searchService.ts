// ====== SearchService — 统一搜索服务 ======
// 提供 search(query, filters, scope) API
// 支持：关键词、对象类型、标签、状态、时间、关系、关联对象
// 支持：搜索结果排序、最近使用、精确匹配、模糊匹配

import type { AnyObject, SearchKind, ObjectType, RelationRecord, EventRecord } from '../types'
import { SearchIndex, type SearchResult, type IndexedItem } from './searchIndex'
import { db } from '../db'
import { getAllRelations } from '../repositories/relationRepository'
import { getAllEvents } from '../repositories/eventRepository'

// ====== 搜索过滤器 ======

export interface SearchFilters {
  types?: SearchKind[]              // 对象类型过滤
  tags?: string[]                   // 标签过滤
  status?: string                   // 状态过滤（如 done, in_progress）
  dateFrom?: string                 // 创建时间起始
  dateTo?: string                   // 创建时间截止
  hasRelations?: boolean            // 只返回有关系的对象
  relationType?: string             // 关系类型过滤
  relatedTo?: { type: ObjectType; id: string }  // 关联对象过滤
}

// ====== 搜索范围 ======

export type SearchScope =
  | 'all'           // 全局
  | 'objects'       // 仅对象
  | 'relations'     // 仅关系
  | 'timeline'      // 仅时间线
  | 'knowledge'     // 知识关联

// ====== 统一搜索结果 ======

export interface UnifiedSearchResult {
  objects: SearchResult[]
  relations: RelationRecord[]
  events: EventRecord[]
  total: number
}

// ====== SearchService 类 ======

export class SearchService {
  private index: SearchIndex
  private allObjects: AnyObject[] = []
  private allRelations: RelationRecord[] = []
  private allEvents: EventRecord[] = []

  constructor() {
    this.index = new SearchIndex()
  }

  // ====== 从数据库加载数据并重建索引 ======
  async load(): Promise<void> {
    // 数据源清单：核心对象直接索引；扩展源经 mapRow 归一化为可索引形状
    const SOURCES: {
      kind: SearchKind
      table: string
      filterKind?: string
      map?: (r: Record<string, any>) => Record<string, any>
    }[] = [
      { kind: 'goal', table: 'goals' },
      { kind: 'domain', table: 'domains' },
      { kind: 'project', table: 'projects' },
      { kind: 'task', table: 'tasks' },
      { kind: 'customer', table: 'customers' },
      { kind: 'opportunity', table: 'opportunities' },
      { kind: 'order', table: 'orders' },
      { kind: 'communication', table: 'communications' },
      { kind: 'knowledge', table: 'knowledge' },
      { kind: 'inspiration', table: 'inspirations' },
      { kind: 'question', table: 'questions' },
      { kind: 'research', table: 'research' },
      { kind: 'experiment', table: 'experiments' },
      { kind: 'decision', table: 'decisions' },
      { kind: 'review', table: 'reviews' },
      { kind: 'process', table: 'processes' },
      // ---- v1.1 扩展源 ----
      {
        kind: 'memory', table: 'memories',
        map: r => ({
          ...r,
          title: r.summary || String(r.content ?? '').slice(0, 24),
          description: String(r.content ?? ''),
          emoji: '🧠',
        }),
      },
      {
        kind: 'tradeDeal', table: 'tradeDeals',
        map: r => ({
          ...r,
          type: 'tradeDeal',
          description: `${r.stage ?? ''}${r.value ? ` · $${r.value}` : ''}${r.inquirySource ? ` · ${r.inquirySource}` : ''}`,
          emoji: '💼',
          status: r.stage,
        }),
      },
      {
        kind: 'siteProduct', table: 'siteProducts',
        map: r => ({
          ...r,
          type: 'siteProduct',
          description: `${r.vendor ?? ''}${r.price ? ` · $${r.price}` : ''}`,
          emoji: '🛍️',
        }),
      },
      {
        kind: 'seoKeyword', table: 'seoKeywords',
        map: r => ({
          id: r.id, type: 'seoKeyword',
          title: r.keyword ?? '关键词',
          description: `排名 #${r.position ?? '-'} · 流量 ${r.volume ?? '-'}`,
          emoji: '🔍', tags: ['seo'],
          createdAt: r.checkedAt, updatedAt: r.checkedAt,
        }),
      },
      {
        kind: 'habit', table: 'habits',
        map: r => ({ ...r, type: 'habit', description: `连续 ${r.streak ?? 0} 天`, emoji: '✅' }),
      },
      {
        kind: 'dailyLog', table: 'dailyLogs',
        map: r => ({
          id: r.id, type: 'dailyLog',
          title: `日志 ${r.date}`,
          description: String(r.content ?? '').slice(0, 80),
          emoji: '📔', tags: [],
          createdAt: r.createdAt, updatedAt: r.updatedAt,
        }),
      },
      {
        kind: 'notification', table: 'notifications',
        map: r => ({
          id: r.id, type: 'notification',
          title: r.title ?? '通知',
          description: String(r.message ?? ''),
          emoji: '🔔', tags: [],
          status: r.read ? 'read' : 'unread',
          createdAt: r.createdAt, updatedAt: r.createdAt,
        }),
      },
      // ---- v1.1 通用收藏/清单 ----
      {
        kind: 'prompt', table: 'collections', filterKind: 'prompt',
        map: r => ({
          id: r.id, type: 'prompt',
          title: r.data?.title ?? '提示词',
          description: String(r.data?.content ?? ''),
          emoji: '📝', tags: [r.data?.category].filter(Boolean),
          createdAt: r.createdAt, updatedAt: r.updatedAt,
        }),
      },
      {
        kind: 'ai_tool', table: 'collections', filterKind: 'ai_tool',
        map: r => ({
          id: r.id, type: 'ai_tool',
          title: r.data?.name ?? 'AI 工具',
          description: `${r.data?.description ?? ''} ${r.data?.url ?? ''}`.trim(),
          emoji: '🛠', tags: [r.data?.category].filter(Boolean),
          createdAt: r.createdAt, updatedAt: r.updatedAt,
        }),
      },
      {
        kind: 'study_log', table: 'collections', filterKind: 'study_log',
        map: r => ({
          id: r.id, type: 'study_log',
          title: `${r.data?.subject ?? '学习'} · ${r.data?.date ?? ''}`,
          description: `${r.data?.duration ?? ''}分钟 ${r.data?.notes ?? ''}`.trim(),
          emoji: '📚', tags: [],
          createdAt: r.createdAt, updatedAt: r.updatedAt,
        }),
      },
      {
        kind: 'study_resource', table: 'collections', filterKind: 'study_resource',
        map: r => ({
          id: r.id, type: 'study_resource',
          title: r.data?.title ?? '资源',
          description: String(r.data?.url ?? ''),
          emoji: '🔗', tags: [r.data?.category].filter(Boolean),
          createdAt: r.createdAt, updatedAt: r.updatedAt,
        }),
      },
      {
        kind: 'finance', table: 'collections', filterKind: 'finance',
        map: r => ({
          id: r.id, type: 'finance',
          title: `${r.data?.type === 'income' ? '收入' : '支出'} ¥${r.data?.amount ?? 0}`,
          description: `${r.data?.category ?? ''} ${r.data?.note ?? ''}`.trim(),
          emoji: '💰', tags: [],
          createdAt: r.createdAt, updatedAt: r.updatedAt,
        }),
      },
      {
        kind: 'wish', table: 'collections', filterKind: 'wish',
        map: r => ({
          id: r.id, type: 'wish',
          title: `${r.data?.emoji ?? '⭐'} ${r.data?.title ?? '愿望'}`,
          description: r.data?.done ? '已达成' : '待实现',
          emoji: '⭐', tags: [],
          status: r.data?.done ? 'done' : 'open',
          createdAt: r.createdAt, updatedAt: r.updatedAt,
        }),
      },
      {
        kind: 'health', table: 'collections', filterKind: 'health',
        map: r => ({
          id: r.id, type: 'health',
          title: `${r.data?.type ?? '健康'} ${r.data?.value ?? ''}`,
          description: String(r.data?.note ?? ''),
          emoji: '🏃', tags: [],
          createdAt: r.createdAt, updatedAt: r.updatedAt,
        }),
      },
      {
        kind: 'life_plan', table: 'collections', filterKind: 'life_plan',
        map: r => ({
          id: r.id, type: 'life_plan',
          title: r.data?.title ?? '计划',
          description: String(r.data?.status ?? ''),
          emoji: '📋', tags: [r.data?.category].filter(Boolean),
          status: r.data?.status,
          createdAt: r.createdAt, updatedAt: r.updatedAt,
        }),
      },
      {
        kind: 'personal_record', table: 'collections', filterKind: 'personal_record',
        map: r => ({
          id: r.id, type: 'personal_record',
          title: String(r.data?.content ?? r.data?.title ?? '记录').slice(0, 40),
          description: String(r.data?.note ?? ''),
          emoji: '📝', tags: [],
          createdAt: r.createdAt, updatedAt: r.updatedAt,
        }),
      },
    ]

    const objects: Record<string, any>[] = []
    // collections 表被 9 个 filterKind 源共用：只读一次按 kind 分桶，避免同表反复全量扫描
    let collectionRows: Record<string, any>[] | null = null
    for (const src of SOURCES) {
      try {
        let items: Record<string, any>[]
        if (src.filterKind) {
          if (!collectionRows) collectionRows = await db.collections.toArray()
          items = collectionRows.filter(r => r.kind === src.filterKind)
        } else {
          items = await (db as any)[src.table].toArray()
        }
        for (const item of items) {
          objects.push(src.map ? src.map(item) : item)
        }
      } catch { /* 表缺失时跳过 */ }
    }

    this.allObjects = objects as unknown as AnyObject[]
    this.index.rebuild(objects as unknown as AnyObject[])

    // 加载关系和事件
    try {
      this.allRelations = await db.relations.toArray()
    } catch { this.allRelations = [] }

    try {
      this.allEvents = await db.events.orderBy('createdAt').reverse().limit(200).toArray()
    } catch { this.allEvents = [] }
  }

  // ====== 同步更新索引（对象变更时调用）======
  updateObject(obj: AnyObject): void {
    this.index.remove(obj.id)
    this.index.add(obj)
    // 更新内存缓存
    const idx = this.allObjects.findIndex(o => o.id === obj.id)
    if (idx >= 0) {
      this.allObjects[idx] = obj
    } else {
      this.allObjects.push(obj)
    }
  }

  removeObject(id: string, type: SearchKind): void {
    this.index.remove(id)
    this.allObjects = this.allObjects.filter(o => o.id !== id)
  }

  // ====== 核心搜索 API ======
  async search(
    query: string,
    filters?: SearchFilters,
    scope: SearchScope = 'all'
  ): Promise<UnifiedSearchResult> {
    let objects: SearchResult[] = []
    let relations: RelationRecord[] = []
    let events: EventRecord[] = []

    // 对象搜索
    if (scope === 'all' || scope === 'objects' || scope === 'knowledge') {
      objects = this.index.search(query, {
        types: filters?.types,
        tags: filters?.tags,
        limit: 50,
      })

      // 应用额外过滤器
      if (filters?.status) {
        objects = objects.filter(sr => sr.item.status === filters.status)
      }

      if (filters?.dateFrom) {
        objects = objects.filter(sr =>
          sr.item.createdAt >= filters.dateFrom!
        )
      }

      if (filters?.dateTo) {
        objects = objects.filter(sr =>
          sr.item.createdAt <= filters.dateTo!
        )
      }

      // 关系过滤
      if (filters?.hasRelations) {
        const idsWithRelations = new Set(
          this.allRelations.flatMap(r => [r.sourceId, r.targetId])
        )
        objects = objects.filter(sr => idsWithRelations.has(sr.item.id))
      }

      // 关联对象过滤
      if (filters?.relatedTo) {
        const { type, id } = filters.relatedTo
        const relatedIds = new Set(
          this.allRelations
            .filter(r =>
              (r.sourceType === type && r.sourceId === id) ||
              (r.targetType === type && r.targetId === id)
            )
            .flatMap(r => [r.sourceId, r.targetId])
            .filter(rid => rid !== id)
        )
        objects = objects.filter(sr => relatedIds.has(sr.item.id))
      }
    }

    // 关系搜索（结构化过滤不依赖关键词）
    if (scope === 'all' || scope === 'relations') {
      relations = this.allRelations
      if (query.trim()) {
        const q = query.toLowerCase()
        relations = relations.filter(r =>
          r.relationType.toLowerCase().includes(q) ||
          r.sourceType.toLowerCase().includes(q) ||
          r.targetType.toLowerCase().includes(q)
        )
      }
      if (filters?.relationType) {
        relations = relations.filter(r => r.relationType === filters.relationType)
      }
      if (filters?.relatedTo) {
        const { type, id } = filters.relatedTo
        relations = relations.filter(r =>
          (r.sourceType === type && r.sourceId === id) ||
          (r.targetType === type && r.targetId === id)
        )
      }
    }

    // 时间线搜索
    if (scope === 'all' || scope === 'timeline') {
      if (query.trim()) {
        const q = query.toLowerCase()
        events = this.allEvents.filter(e =>
          e.type.toLowerCase().includes(q) ||
          e.objectType.toLowerCase().includes(q) ||
          JSON.stringify(e.payload).toLowerCase().includes(q)
        )
      }
    }

    // 知识关联搜索（只搜知识类型 + 相关关系）
    if (scope === 'knowledge') {
      objects = objects.filter(sr => sr.item.type === 'knowledge')
      relations = relations.filter(r =>
        r.sourceType === 'knowledge' || r.targetType === 'knowledge'
      )
    }

    return {
      objects,
      relations,
      events,
      total: objects.length + relations.length + events.length,
    }
  }

  // ====== 快速对象搜索（同步，用于 UI 即时反馈）======
  quickSearch(query: string, types?: SearchKind[]): SearchResult[] {
    return this.index.search(query, { types, limit: 20 })
  }

  // ====== 最近使用 ======
  markRecent(id: string): void {
    this.index.markRecent(id)
  }

  getRecent(limit = 10): IndexedItem[] {
    return this.index.getRecent(limit)
  }

  // ====== 获取索引统计 ======
  getStats(): { totalObjects: number; byType: Record<string, number> } {
    const byType: Record<string, number> = {}
    for (const obj of this.allObjects) {
      byType[obj.type] = (byType[obj.type] || 0) + 1
    }
    return { totalObjects: this.allObjects.length, byType }
  }

  // ====== 获取所有对象（用于图谱）======
  getAllObjects(): AnyObject[] {
    return this.allObjects
  }

  getAllRelations(): RelationRecord[] {
    return this.allRelations
  }
}

// ====== 全局单例 ======
export const searchService = new SearchService()
