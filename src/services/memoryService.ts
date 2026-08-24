// ====== MemoryService — AI 长期上下文服务 ======
// Memory ≠ Knowledge：
//   Knowledge = 用户保存的信息（知识与思考模块）
//   Memory    = 对未来 AI 有价值的长期上下文
//
// 职责边界：
//   - suggestMemories()        AI 只能"建议"，产出 candidate，置信度封顶
//   - confirmMemory()          用户确认后才生效（唯一晋升通道）
//   - getRelevantMemories()    只返回 active 且未过期的记忆（AI 上下文入口）
//   - forgetMemory()           用户彻底删除
//
// 不做的事：
//   - 不自动晋升 candidate → active
//   - 不读写 knowledge 表（不是第二套知识库）
//   - 不实现 Agent Runtime

import type { Memory, MemoryType, MemorySource } from '../types'
import type { Result } from '../repositories/result'
import {
  suggestMemory, confirmMemoryRecord, forgetMemoryRecord,
  archiveMemoryRecord, updateMemoryRecord, setMemoryStatus,
  touchMemory, createManualMemory,
  getAllMemories, getMemoriesByStatus, getMemory,
  MEMORY_AI_CONFIDENCE_CAP,
  type SuggestMemoryInput, type ManualMemoryInput,
} from '../repositories/memoryRepository'

// ====== 上下文查询参数 ======

export interface MemoryContext {
  query?: string                  // 当前对话/任务关键词，用于相关性匹配
  types?: MemoryType[]            // 关注的记忆类型
  scopes?: string[]               // 生效范围过滤
  limit?: number                  // 返回上限（默认 10）
  minConfidence?: number          // 置信度阈值（默认 0.3）
}

export interface ScoredMemory {
  memory: Memory
  score: number
}

// ====== 评分权重 ======

const WEIGHTS = {
  confidence: 0.35,
  importance: 0.25,
  recency: 0.25,
  match: 0.15,
}

/** 时间衰减：30 天半衰期 */
function recencyScore(timestamp: string | undefined): number {
  if (!timestamp) return 0.5
  const ageDays = (Date.now() - new Date(timestamp).getTime()) / 86400000
  return Math.pow(0.5, Math.max(0, ageDays) / 30)
}

/** 关键词命中：content/tags/summary */
function matchScore(memory: Memory, query: string | undefined): number {
  if (!query || !query.trim()) return 0.5 // 无查询时不加分不减分
  const q = query.toLowerCase()
  const haystacks = [memory.content, memory.summary ?? '', ...memory.tags]
  const hit = haystacks.some(h => h.toLowerCase().includes(q))
  const partial = !hit && q.length >= 2 &&
    Array.from(q).some(ch => memory.content.toLowerCase().includes(ch))
  return hit ? 1 : partial ? 0.5 : 0
}

/** 类型/范围匹配加成 */
function contextBonus(memory: Memory, ctx: MemoryContext): number {
  let bonus = 0
  if (ctx.types?.length && ctx.types.includes(memory.type)) bonus += 1
  if (ctx.scopes?.length && memory.scope?.some(s => ctx.scopes!.includes(s))) bonus += 1
  return bonus
}

function isExpiredByTime(memory: Memory, nowMs = Date.now()): boolean {
  return !!memory.expiresAt && new Date(memory.expiresAt).getTime() < nowMs
}

// ====== MemoryService ======

export class MemoryService {
  private cache: Memory[] = []
  private lastLoadTime = 0
  private readonly CACHE_TTL = 3000

  /** 从数据库加载缓存 */
  async load(force = false): Promise<void> {
    const nowMs = Date.now()
    if (!force && nowMs - this.lastLoadTime < this.CACHE_TTL && this.cache.length > 0) return
    this.cache = await getAllMemories()
    this.lastLoadTime = nowMs
  }

  invalidate(): void {
    this.lastLoadTime = 0
    this.cache = []
  }

  /**
   * 获取与当前上下文相关的记忆（AI 上下文入口）
   * 只返回 active 且未过期的记忆；candidate 永不出现。
   * 命中的记忆会更新 lastUsedAt/useCount。
   */
  async getRelevantMemories(context: MemoryContext = {}): Promise<Memory[]> {
    await this.load()

    const limit = context.limit ?? 10
    const minConfidence = context.minConfidence ?? 0.3
    const nowMs = Date.now()
    const expiredIds: string[] = []

    const eligible = this.cache.filter(m => {
      if (m.status !== 'active') return false
      // 懒过期：到期即视为 expired 并落库
      if (isExpiredByTime(m, nowMs)) {
        expiredIds.push(m.id)
        return false
      }
      if (m.confidence < minConfidence) return false
      if (context.scopes?.length && !m.scope?.some(s => context.scopes!.includes(s))) return false
      return true
    })

    // 异步落库懒过期结果（不阻塞返回）
    if (expiredIds.length > 0) {
      Promise.all(expiredIds.map(id => setMemoryStatus(id, 'expired')))
        .then(() => this.invalidate())
        .catch(() => {})
    }

    const scored: ScoredMemory[] = eligible.map(m => ({
      memory: m,
      score:
        m.confidence * WEIGHTS.confidence +
        m.importance * WEIGHTS.importance +
        recencyScore(m.lastUsedAt ?? m.updatedAt) * WEIGHTS.recency +
        matchScore(m, context.query) * WEIGHTS.match +
        contextBonus(m, context),
    }))

    scored.sort((a, b) => b.score - a.score)
    const top = scored.slice(0, limit).map(s => s.memory)

    // 记录使用痕迹
    for (const m of top) {
      touchMemory(m.id).catch(() => {})
    }

    return top
  }

  /**
   * AI 建议记忆（Agent Runtime 就绪前的唯一 AI 入口）
   * 强制：status=candidate、confidence ≤ CAP、source.actorType='agent' 或标注来源
   * 返回的候选必须经用户 confirmMemory 后才会进入上下文。
   */
  async suggestMemories(inputs: SuggestMemoryInput[], actorId?: string): Promise<Result<Memory[]>> {
    if (!inputs || inputs.length === 0) return { ok: true, value: [] }
    const created: Memory[] = []
    for (const input of inputs) {
      const normalized: SuggestMemoryInput = {
        ...input,
        source: {
          ...input.source,
          actorType: input.source.actorType === 'user' ? 'agent' : input.source.actorType,
          actorId: input.source.actorId ?? actorId ?? 'ai-assistant',
        },
      }
      const result = await suggestMemory(normalized)
      if (result.ok === false) return { ok: false, error: result.error }
      created.push(result.value)
    }
    this.invalidate()
    return { ok: true, value: created }
  }

  /** 用户手动创建（直接 active，用户无需自确认）*/
  async addManualMemory(input: ManualMemoryInput): Promise<Result<Memory>> {
    const result = await createManualMemory(input)
    if (result.ok) this.invalidate()
    return result
  }

  /** 用户确认（可附带修改）→ candidate/expired → active */
  async confirmMemory(
    id: string,
    edits?: Partial<Pick<Memory, 'content' | 'type' | 'importance' | 'tags' | 'scope'>>
  ): Promise<Result<Memory>> {
    const result = await confirmMemoryRecord(id, edits)
    if (result.ok) this.invalidate()
    return result
  }

  /** 用户遗忘（彻底删除）*/
  async forgetMemory(id: string): Promise<Result<void>> {
    const result = await forgetMemoryRecord(id)
    if (result.ok) this.invalidate()
    return result
  }

  /** 用户归档 */
  async archiveMemory(id: string): Promise<Result<Memory>> {
    const result = await archiveMemoryRecord(id)
    if (result.ok) this.invalidate()
    return result
  }

  /** 用户修改 */
  async updateMemory(
    id: string,
    edits: Parameters<typeof updateMemoryRecord>[1]
  ): Promise<Result<Memory>> {
    const result = await updateMemoryRecord(id, edits)
    if (result.ok) this.invalidate()
    return result
  }

  /** 状态变更（重新激活/标记过期等）*/
  async changeStatus(id: string, status: Memory['status']): Promise<Result<Memory>> {
    const result = await setMemoryStatus(id, status)
    if (result.ok) this.invalidate()
    return result
  }

  // ====== 视图查询 ======

  async getPendingSuggestions(): Promise<Memory[]> {
    return getMemoriesByStatus('candidate')
  }

  async getActiveMemories(): Promise<Memory[]> {
    return getMemoriesByStatus('active')
  }

  async getExpiredMemories(): Promise<Memory[]> {
    return getMemoriesByStatus('expired')
  }

  async getArchivedMemories(): Promise<Memory[]> {
    return getMemoriesByStatus('archived')
  }

  async getById(id: string): Promise<Memory | undefined> {
    return getMemory(id)
  }

  /** 构造来源对象（供 UI/测试使用，保证形状合法）*/
  makeSource(partial: Partial<MemorySource>): MemorySource {
    return {
      type: partial.type ?? 'ai_suggestion',
      actorType: partial.actorType ?? 'agent',
      actorId: partial.actorId,
      sessionId: partial.sessionId,
      excerpt: partial.excerpt,
      objectRef: partial.objectRef,
      occurredAt: partial.occurredAt ?? new Date().toISOString(),
    }
  }

  /** AI 置信度上限 */
  get aiConfidenceCap(): number {
    return MEMORY_AI_CONFIDENCE_CAP
  }
}

// 全局单例
export const memoryService = new MemoryService()
