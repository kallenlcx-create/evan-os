// ====== SearchService — 统一搜索服务 ======
// 提供 search(query, filters, scope) API
// 支持：关键词、对象类型、标签、状态、时间、关系、关联对象
// 支持：搜索结果排序、最近使用、精确匹配、模糊匹配

import type { AnyObject, ObjectType, RelationRecord, EventRecord } from '../types'
import { SearchIndex, type SearchResult, type IndexedItem } from './searchIndex'
import { db } from '../db'
import { getAllRelations } from '../repositories/relationRepository'
import { getAllEvents, getTimeline } from '../repositories/eventRepository'

// ====== 搜索过滤器 ======

export interface SearchFilters {
  types?: ObjectType[]              // 对象类型过滤
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
    // 加载所有对象
    const tables: { type: ObjectType; table: string }[] = [
      { type: 'goal', table: 'goals' },
      { type: 'project', table: 'projects' },
      { type: 'task', table: 'tasks' },
      { type: 'customer', table: 'customers' },
      { type: 'opportunity', table: 'opportunities' },
      { type: 'order', table: 'orders' },
      { type: 'communication', table: 'communications' },
      { type: 'knowledge', table: 'knowledge' },
      { type: 'inspiration', table: 'inspirations' },
      { type: 'question', table: 'questions' },
      { type: 'research', table: 'research' },
      { type: 'experiment', table: 'experiments' },
      { type: 'decision', table: 'decisions' },
      { type: 'review', table: 'reviews' },
      { type: 'process', table: 'processes' },
    ]

    const objects: AnyObject[] = []
    for (const { table } of tables) {
      try {
        const items = await (db as any)[table].toArray()
        objects.push(...items)
      } catch { /* skip */ }
    }

    this.allObjects = objects
    this.index.rebuild(objects)

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

  removeObject(id: string, type: ObjectType): void {
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
  quickSearch(query: string, types?: ObjectType[]): SearchResult[] {
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
