import { db } from '../db'
import type { Knowledge } from '../types'
import { uid, now, type Result, ok, err } from './result'
import { createEvent } from './eventRepository'
import { createRelation, getKnowledgeBacklinks } from './relationRepository'

// ====== Knowledge Repository ======

export async function createKnowledge(data: Partial<Knowledge>): Promise<Result<Knowledge>> {
  const id = data.id || uid()
  const item: Knowledge = {
    id,
    type: 'knowledge',
    title: data.title || '',
    description: data.description || '',
    emoji: data.emoji || '📝',
    tags: data.tags || [],
    relations: [],
    category: data.category || 'general',
    source: data.source,
    content: data.content || '',
    isBookmarked: data.isBookmarked || false,
    format: data.format || 'plain',
    backlinks: [],  // legacy — 通过 Relation 动态计算
    createdAt: now(),
    updatedAt: now(),
  }

  try {
    await db.knowledge.add(item)
    await createEvent('object.created', 'user', 'knowledge', id, { title: item.title })
    return ok(item)
  } catch (e) {
    return err(`创建知识失败: ${e}`)
  }
}

// 动态计算 backlinks（通过 Relation 表，而非 backlinks 字段）
export async function getBacklinks(knowledgeId: string): Promise<Knowledge[]> {
  const backlinkRels = await getKnowledgeBacklinks(knowledgeId)
  const sourceIds = backlinkRels.map(r => r.sourceId)
  const items = await Promise.all(sourceIds.map(id => db.knowledge.get(id)))
  return items.filter(Boolean) as Knowledge[]
}

// 建立 knowledge → knowledge 的 references 关系
export async function addReference(
  sourceKnowledgeId: string,
  targetKnowledgeId: string
): Promise<Result<void>> {
  const result = await createRelation(
    'knowledge', sourceKnowledgeId,
    'knowledge', targetKnowledgeId,
    'references'
  )
  if (result.ok) {
    return ok(undefined)
  }
  return err((result as any).error)
}
