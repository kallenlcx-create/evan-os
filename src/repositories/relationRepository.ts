import { db } from '../db'
import type { RelationRecord, RelationType, ObjectType } from '../types'
import { uid, now, type Result, ok, err } from './result'

// ====== Relation Repository ======
// Relation 是独立的数据表，不再放在对象内部

export async function createRelation(
  sourceType: ObjectType,
  sourceId: string,
  targetType: ObjectType,
  targetId: string,
  relationType: RelationType,
  options?: {
    metadata?: Record<string, any>
    createdBy?: 'user' | 'system' | 'agent'
    source?: 'manual' | 'migration' | 'ai' | 'automation'
    confidence?: number
  }
): Promise<Result<RelationRecord>> {
  if (!sourceId || !targetId) return err('sourceId 和 targetId 不能为空')
  if (sourceId === targetId) return err('不能创建自引用关系')

  const rel: RelationRecord = {
    id: uid(),
    sourceType,
    sourceId,
    targetType,
    targetId,
    relationType,
    metadata: options?.metadata,
    createdAt: now(),
    updatedAt: now(),
    createdBy: options?.createdBy || 'user',
    source: options?.source || 'manual',
    confidence: options?.confidence,
  }

  try {
    await db.relations.add(rel)
    return ok(rel)
  } catch (e) {
    return err(`创建关系失败: ${e}`)
  }
}

export async function deleteRelation(id: string): Promise<Result<void>> {
  try {
    await db.relations.delete(id)
    return ok(undefined)
  } catch (e) {
    return err(`删除关系失败: ${e}`)
  }
}

// 查询某对象作为 source 的所有关系
export async function getOutgoingRelations(
  sourceType: ObjectType,
  sourceId: string
): Promise<RelationRecord[]> {
  try {
    return await db.relations
      .where('[sourceType+sourceId]')
      .equals([sourceType, sourceId])
      .toArray()
  } catch {
    return []
  }
}

// 查询某对象作为 target 的所有关系（反向查询）
export async function getIncomingRelations(
  targetType: ObjectType,
  targetId: string
): Promise<RelationRecord[]> {
  try {
    return await db.relations
      .where('[targetType+targetId]')
      .equals([targetType, targetId])
      .toArray()
  } catch {
    return []
  }
}

// 双向查询：获取某对象的所有关系
export async function getAllRelations(
  objectType: ObjectType,
  objectId: string
): Promise<{ outgoing: RelationRecord[]; incoming: RelationRecord[] }> {
  const [outgoing, incoming] = await Promise.all([
    getOutgoingRelations(objectType, objectId),
    getIncomingRelations(objectType, objectId),
  ])
  return { outgoing, incoming }
}

// 便捷方法：获取属于某项目的所有任务（通过 belongs_to 关系）
export async function getTasksForProject(projectId: string): Promise<RelationRecord[]> {
  try {
    return await db.relations
      .where('[targetType+targetId]')
      .equals(['project', projectId])
      .and(r => r.relationType === 'belongs_to')
      .toArray()
  } catch {
    return []
  }
}

// 便捷方法：获取知识笔记的反向链接（references 关系）
export async function getKnowledgeBacklinks(knowledgeId: string): Promise<RelationRecord[]> {
  try {
    return await db.relations
      .where('[targetType+targetId]')
      .equals(['knowledge', knowledgeId])
      .and(r => r.relationType === 'references')
      .toArray()
  } catch {
    return []
  }
}
