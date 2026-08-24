// ====== RelationQueryService — 关系图谱查询服务 ======
// 从 Relation 表实时生成图谱数据，不创建第二套知识数据库
// 支持：邻接查询、N度关系、路径查找、连通子图、知识关联

import type { ObjectType, RelationRecord, AnyObject, RelationType } from '../types'
import { db } from '../db'
import {
  getAllRelations,
  getOutgoingRelations,
  getIncomingRelations,
} from '../repositories/relationRepository'

// ====== 图谱节点 & 边 ======

export interface GraphNode {
  id: string
  type: ObjectType
  title: string
  emoji: string
  // 图谱布局坐标（由 UI 计算）
  x?: number
  y?: number
  // 度数
  degree: number
}

export interface GraphEdge {
  id: string
  source: string   // nodeId
  target: string   // nodeId
  relationType: RelationType
  label: string
  direction: 'outgoing' | 'incoming' | 'bidirectional'
}

export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

// ====== 关系查询结果 ======

export interface RelationPath {
  nodes: GraphNode[]
  edges: GraphEdge[]
  length: number
}

// ====== RelationQueryService 类 ======

export class RelationQueryService {
  private relationsCache: RelationRecord[] = []
  private objectCache: Map<string, AnyObject> = new Map()
  private adjacency: Map<string, Set<string>> = new Map()
  private lastLoadTime = 0
  private readonly CACHE_TTL = 5000 // 5 秒缓存

  // ====== 从数据库加载并构建邻接表 ======
  async load(): Promise<void> {
    const now = Date.now()
    if (now - this.lastLoadTime < this.CACHE_TTL && this.relationsCache.length > 0) {
      return // 缓存有效
    }

    this.relationsCache = await db.relations.toArray()
    this.lastLoadTime = now

    // 重建邻接表
    this.adjacency.clear()
    for (const rel of this.relationsCache) {
      const sourceKey = `${rel.sourceType}:${rel.sourceId}`
      const targetKey = `${rel.targetType}:${rel.targetId}`
      if (!this.adjacency.has(sourceKey)) this.adjacency.set(sourceKey, new Set())
      if (!this.adjacency.has(targetKey)) this.adjacency.set(targetKey, new Set())
      this.adjacency.get(sourceKey)!.add(targetKey)
      this.adjacency.get(targetKey)!.add(sourceKey)
    }
  }

  // ====== 强制刷新缓存 ======
  invalidate(): void {
    this.lastLoadTime = 0
    this.relationsCache = []
    this.objectCache.clear()
    this.adjacency.clear()
  }

  // ====== 获取对象（带缓存）======
  private async getObject(type: ObjectType, id: string): Promise<AnyObject | undefined> {
    const key = `${type}:${id}`
    if (this.objectCache.has(key)) return this.objectCache.get(key)

    const tableMap: Record<string, string> = {
      goal: 'goals', project: 'projects', task: 'tasks',
      customer: 'customers', opportunity: 'opportunities',
      order: 'orders', communication: 'communications',
      knowledge: 'knowledge', inspiration: 'inspirations',
      question: 'questions', research: 'research',
      experiment: 'experiments', decision: 'decisions',
      review: 'reviews', process: 'processes',
    }
    const tableName = tableMap[type]
    if (!tableName) return undefined

    try {
      const obj = await (db as any)[tableName].get(id)
      if (obj) this.objectCache.set(key, obj)
      return obj
    } catch {
      return undefined
    }
  }

  private toGraphNode(obj: AnyObject, degree = 0): GraphNode {
    return {
      id: obj.id,
      type: obj.type,
      title: obj.title || '(无标题)',
      emoji: obj.emoji || '📌',
      degree,
    }
  }

  // ====== 获取以某对象为中心的 N 度关系子图 ======
  async getNeighborhood(
    centerType: ObjectType,
    centerId: string,
    depth = 1
  ): Promise<GraphData> {
    await this.load()

    const nodes = new Map<string, GraphNode>()
    const edges: GraphEdge[] = []
    const visited = new Set<string>()
    const centerKey = `${centerType}:${centerId}`

    // 获取中心节点
    const centerObj = await this.getObject(centerType, centerId)
    if (centerObj) {
      nodes.set(centerObj.id, this.toGraphNode(centerObj, 0))
      visited.add(centerKey)
    }

    // BFS 遍历
    let frontier: string[] = [centerKey]
    for (let d = 1; d <= depth; d++) {
      const nextFrontier: string[] = []
      for (const nodeKey of frontier) {
        // 找到与当前节点相关的所有关系
        const relatedRels = this.relationsCache.filter(r =>
          `${r.sourceType}:${r.sourceId}` === nodeKey ||
          `${r.targetType}:${r.targetId}` === nodeKey
        )

        for (const rel of relatedRels) {
          const srcKey = `${rel.sourceType}:${rel.sourceId}`
          const tgtKey = `${rel.targetType}:${rel.targetId}`
          const otherKey = srcKey === nodeKey ? tgtKey : srcKey

          // 添加边
          const edgeId = rel.id
          if (!edges.find(e => e.id === edgeId)) {
            const direction = srcKey === nodeKey ? 'outgoing' : 'incoming'
            edges.push({
              id: edgeId,
              source: rel.sourceId,
              target: rel.targetId,
              relationType: rel.relationType,
              label: rel.relationType.replace(/_/g, ' '),
              direction,
            })
          }

          // 添加未访问的节点
          if (!visited.has(otherKey)) {
            visited.add(otherKey)
            nextFrontier.push(otherKey)
            const [otherType, otherId] = otherKey.split(':')
            const otherObj = await this.getObject(otherType as ObjectType, otherId)
            if (otherObj) {
              nodes.set(otherObj.id, this.toGraphNode(otherObj, d))
            }
          }
        }
      }
      frontier = nextFrontier
    }

    // 计算度数
    for (const node of nodes.values()) {
      node.degree = edges.filter(e => e.source === node.id || e.target === node.id).length
    }

    return { nodes: Array.from(nodes.values()), edges }
  }

  // ====== 获取两个对象之间的最短路径 ======
  async getShortestPath(
    fromType: ObjectType, fromId: string,
    toType: ObjectType, toId: string
  ): Promise<RelationPath | null> {
    await this.load()

    const fromKey = `${fromType}:${fromId}`
    const toKey = `${toType}:${toId}`
    if (fromKey === toKey) return { nodes: [], edges: [], length: 0 }

    // BFS
    const queue: string[] = [fromKey]
    const parent = new Map<string, { key: string; edge: GraphEdge }>()
    const visited = new Set<string>([fromKey])

    while (queue.length > 0) {
      const current = queue.shift()!
      if (current === toKey) break

      const neighbors = this.adjacency.get(current) || new Set()
      for (const neighbor of neighbors) {
        if (visited.has(neighbor)) continue
        visited.add(neighbor)
        // 找到 current → neighbor 的边
        const rel = this.relationsCache.find(r =>
          (`${r.sourceType}:${r.sourceId}` === current && `${r.targetType}:${r.targetId}` === neighbor) ||
          (`${r.sourceType}:${r.sourceId}` === neighbor && `${r.targetType}:${r.targetId}` === current)
        )
        if (rel) {
          parent.set(neighbor, {
            key: current,
            edge: {
              id: rel.id,
              source: rel.sourceId,
              target: rel.targetId,
              relationType: rel.relationType,
              label: rel.relationType.replace(/_/g, ' '),
              direction: 'bidirectional',
            }
          })
          queue.push(neighbor)
        }
      }
    }

    if (!parent.has(toKey)) return null // 没有路径

    // 回溯路径
    const pathEdges: GraphEdge[] = []
    const pathNodeKeys: string[] = [toKey]
    let current = toKey
    while (current !== fromKey) {
      const p = parent.get(current)
      if (!p) break
      pathEdges.unshift(p.edge)
      pathNodeKeys.unshift(p.key)
      current = p.key
    }

    // 加载路径上的节点对象
    const nodes: GraphNode[] = []
    for (let i = 0; i < pathNodeKeys.length; i++) {
      const [type, id] = pathNodeKeys[i].split(':')
      const obj = await this.getObject(type as ObjectType, id)
      if (obj) nodes.push(this.toGraphNode(obj, i))
    }

    return { nodes, edges: pathEdges, length: pathEdges.length }
  }

  // ====== 获取知识关联子图（Knowledge Graph 专用）======
  async getKnowledgeGraph(knowledgeId?: string, depth = 1): Promise<GraphData> {
    if (knowledgeId) {
      return this.getNeighborhood('knowledge', knowledgeId, depth)
    }

    // 无指定 ID：返回所有知识节点及其关系
    await this.load()

    // 获取所有知识对象
    const allKnowledge = await db.knowledge.toArray()
    const knowledgeIds = new Set(allKnowledge.map(k => k.id))

    const nodes: GraphNode[] = allKnowledge.map(k => ({
      id: k.id,
      type: 'knowledge' as ObjectType,
      title: k.title || '(无标题)',
      emoji: k.emoji || '📝',
      degree: 0,
    }))

    // 只保留知识→知识的关系
    const edges: GraphEdge[] = this.relationsCache
      .filter(r =>
        knowledgeIds.has(r.sourceId) && knowledgeIds.has(r.targetId)
      )
      .map(r => ({
        id: r.id,
        source: r.sourceId,
        target: r.targetId,
        relationType: r.relationType,
        label: r.relationType.replace(/_/g, ' '),
        direction: 'bidirectional' as const,
      }))

    // 计算度数
    const degreeMap = new Map<string, number>()
    for (const edge of edges) {
      degreeMap.set(edge.source, (degreeMap.get(edge.source) || 0) + 1)
      degreeMap.set(edge.target, (degreeMap.get(edge.target) || 0) + 1)
    }
    for (const node of nodes) {
      node.degree = degreeMap.get(node.id) || 0
    }

    return { nodes, edges }
  }

  // ====== 获取全局图谱（所有类型）======
  async getGlobalGraph(limit = 100): Promise<GraphData> {
    await this.load()

    // 收集所有出现在关系中的节点 ID
    const nodeKeys = new Set<string>()
    for (const rel of this.relationsCache) {
      nodeKeys.add(`${rel.sourceType}:${rel.sourceId}`)
      nodeKeys.add(`${rel.targetType}:${rel.targetId}`)
    }

    // 加载对象
    const nodes: GraphNode[] = []
    let count = 0
    for (const key of nodeKeys) {
      if (count >= limit) break
      const [type, id] = key.split(':')
      const obj = await this.getObject(type as ObjectType, id)
      if (obj) {
        nodes.push(this.toGraphNode(obj, 0))
        count++
      }
    }

    const nodeIds = new Set(nodes.map(n => n.id))
    const edges: GraphEdge[] = this.relationsCache
      .filter(r => nodeIds.has(r.sourceId) && nodeIds.has(r.targetId))
      .map(r => ({
        id: r.id,
        source: r.sourceId,
        target: r.targetId,
        relationType: r.relationType,
        label: r.relationType.replace(/_/g, ' '),
        direction: 'bidirectional' as const,
      }))

    // 计算度数
    for (const node of nodes) {
      node.degree = edges.filter(e => e.source === node.id || e.target === node.id).length
    }

    return { nodes, edges }
  }

  // ====== 获取关系类型统计 ======
  getRelationTypeStats(): { type: RelationType; count: number }[] {
    const counts = new Map<RelationType, number>()
    for (const rel of this.relationsCache) {
      counts.set(rel.relationType, (counts.get(rel.relationType) || 0) + 1)
    }
    return Array.from(counts.entries())
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count)
  }
}

// ====== 全局单例 ======
export const relationQueryService = new RelationQueryService()
