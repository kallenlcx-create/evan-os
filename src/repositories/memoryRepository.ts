// ====== Memory Repository ======
// Memory = AI 的长期上下文，独立于 Knowledge
// 核心守卫：
//   1. Memory 必须有来源（source）
//   2. AI 建议只能创建 candidate，且 confidence 封顶
//   3. 只有用户确认后才进入 active

import { db } from '../db'
import type { Memory, MemoryStatus, MemoryType, MemorySource } from '../types'
import { uid, now, type Result, ok, err } from './result'

// ====== 常量 ======

/** AI 建议（未经用户确认）的置信度上限 */
export const MEMORY_AI_CONFIDENCE_CAP = 0.5

const VALID_TRANSITIONS: Record<MemoryStatus, MemoryStatus[]> = {
  candidate: ['active', 'archived'],       // 确认 / 拒绝归档
  active: ['expired', 'archived'],         // 过期 / 归档
  expired: ['active', 'archived'],         // 重新激活 / 归档
  archived: ['candidate', 'active'],       // 重新打开 / 恢复
}

function canTransition(from: MemoryStatus, to: MemoryStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false
}

// ====== 输入类型 ======

export interface SuggestMemoryInput {
  type: MemoryType
  content: string
  source: MemorySource
  confidence?: number
  importance?: number
  tags?: string[]
  scope?: string[]
  summary?: string
  expiresAt?: string
}

export interface ManualMemoryInput {
  type: MemoryType
  content: string
  confidence?: number
  importance?: number
  tags?: string[]
  scope?: string[]
  summary?: string
  expiresAt?: string
}

// ====== 内部构造 ======

interface MemoryCoreInput {
  type: MemoryType
  content: string
  confidence?: number
  importance?: number
  tags?: string[]
  scope?: string[]
  summary?: string
  expiresAt?: string
}

function buildMemory(
  input: MemoryCoreInput,
  source: MemorySource,
  status: MemoryStatus,
  forceCandidateCap: boolean
): Result<Memory> {
  if (!input.content || !input.content.trim()) return err('content 不能为空')
  if (!source || !source.type || !source.actorType) {
    return err('Memory 必须拥有来源 (source)')
  }

  let confidence = input.confidence ?? 0.5
  if (forceCandidateCap && confidence > MEMORY_AI_CONFIDENCE_CAP) {
    confidence = MEMORY_AI_CONFIDENCE_CAP
  }

  const ts = now()
  const memory: Memory = {
    id: uid(),
    type: input.type,
    status,
    content: input.content.trim(),
    summary: input.summary,
    source: { ...source },
    confidence,
    importance: Math.min(1, Math.max(0, input.importance ?? 0.5)),
    tags: input.tags ?? [],
    scope: input.scope,
    createdAt: ts,
    updatedAt: ts,
    expiresAt: input.expiresAt,
    confirmedAt: status === 'active' ? ts : undefined,
    useCount: 0,
  }
  return ok(memory)
}

// ====== AI 建议路径：只能创建 candidate，置信度封顶 ======

export async function suggestMemory(input: SuggestMemoryInput): Promise<Result<Memory>> {
  const built = buildMemory(input, input.source, 'candidate', true)
  if (!built.ok) return built
  try {
    await db.memories.add(built.value)
    return ok(built.value)
  } catch (e) {
    return err(`保存建议记忆失败: ${e}`)
  }
}

// ====== 用户手动路径：直接 active（用户自己写的不需要再确认）======

export async function createManualMemory(input: ManualMemoryInput): Promise<Result<Memory>> {
  const built = buildMemory(
    input,
    { type: 'user_manual', actorType: 'user', occurredAt: now() },
    'active',
    false
  )
  if (!built.ok) return built
  try {
    await db.memories.add(built.value)
    return ok(built.value)
  } catch (e) {
    return err(`保存记忆失败: ${e}`)
  }
}

// ====== 查询 ======

export async function getMemory(id: string): Promise<Memory | undefined> {
  return db.memories.get(id)
}

export async function getAllMemories(): Promise<Memory[]> {
  try {
    return await db.memories.toArray()
  } catch {
    return []
  }
}

export async function getMemoriesByStatus(status: MemoryStatus): Promise<Memory[]> {
  try {
    return await db.memories.where('status').equals(status).toArray()
  } catch {
    return []
  }
}

// ====== 用户操作 ======

/** 用户确认候选记忆 → active */
export async function confirmMemoryRecord(
  id: string,
  edits?: Partial<Pick<Memory, 'content' | 'type' | 'importance' | 'tags' | 'scope'>>
): Promise<Result<Memory>> {
  const memory = await getMemory(id)
  if (!memory) return err(`记忆不存在: ${id}`)
  if (!canTransition(memory.status, 'active')) {
    return err(`非法状态转换: ${memory.status} → active`)
  }
  const updated: Memory = {
    ...memory,
    ...edits,
    status: 'active',
    confirmedAt: now(),
    updatedAt: now(),
  }
  try {
    await db.memories.put(updated)
    return ok(updated)
  } catch (e) {
    return err(`确认记忆失败: ${e}`)
  }
}

/** 用户修改记忆内容/属性（不改变状态） */
export async function updateMemoryRecord(
  id: string,
  edits: Partial<Pick<Memory, 'content' | 'summary' | 'type' | 'importance' | 'tags' | 'scope' | 'confidence' | 'expiresAt'>>
): Promise<Result<Memory>> {
  const memory = await getMemory(id)
  if (!memory) return err(`记忆不存在: ${id}`)
  const updated: Memory = { ...memory, ...edits, updatedAt: now() }
  try {
    await db.memories.put(updated)
    return ok(updated)
  } catch (e) {
    return err(`更新记忆失败: ${e}`)
  }
}

/** 归档 */
export async function archiveMemoryRecord(id: string): Promise<Result<Memory>> {
  const memory = await getMemory(id)
  if (!memory) return err(`记忆不存在: ${id}`)
  if (!canTransition(memory.status, 'archived')) {
    return err(`非法状态转换: ${memory.status} → archived`)
  }
  const updated: Memory = { ...memory, status: 'archived', updatedAt: now() }
  try {
    await db.memories.put(updated)
    return ok(updated)
  } catch (e) {
    return err(`归档记忆失败: ${e}`)
  }
}

/** 标记过期 / 重新激活 */
export async function setMemoryStatus(id: string, status: MemoryStatus): Promise<Result<Memory>> {
  const memory = await getMemory(id)
  if (!memory) return err(`记忆不存在: ${id}`)
  if (!canTransition(memory.status, status)) {
    return err(`非法状态转换: ${memory.status} → ${status}`)
  }
  const updated: Memory = {
    ...memory,
    status,
    updatedAt: now(),
    ...(status === 'active' ? { confirmedAt: memory.confirmedAt ?? now() } : {}),
  }
  try {
    await db.memories.put(updated)
    return ok(updated)
  } catch (e) {
    return err(`变更记忆状态失败: ${e}`)
  }
}

/** 遗忘（彻底删除）*/
export async function forgetMemoryRecord(id: string): Promise<Result<void>> {
  try {
    await db.memories.delete(id)
    return ok(undefined)
  } catch (e) {
    return err(`遗忘记忆失败: ${e}`)
  }
}

/** 记录一次被 AI 使用（lastUsedAt/useCount）*/
export async function touchMemory(id: string): Promise<void> {
  const memory = await getMemory(id)
  if (!memory) return
  await db.memories.put({
    ...memory,
    lastUsedAt: now(),
    useCount: (memory.useCount ?? 0) + 1,
    updatedAt: memory.updatedAt,
  })
}
