import { db } from '../db'
import type { AnyObject, ObjectType, BaseObject } from '../types'
import { uid, now, type Result, ok, err } from './result'
import { createEvent } from './eventRepository'
import { TABLES } from '../db'

// ====== 对象类型到表名的映射（修复版）======
const TYPE_TO_TABLE: Record<ObjectType, string> = {
  goal: 'goals',
  domain: 'domains',
  project: 'projects',
  task: 'tasks',
  customer: 'customers',       // ✅ 修复：不再写入 goals
  opportunity: 'opportunities', // ✅ 修复
  order: 'orders',              // ✅ 修复
  communication: 'communications', // ✅ 修复
  knowledge: 'knowledge',
  inspiration: 'inspirations',
  question: 'questions',
  research: 'research',
  experiment: 'experiments',
  decision: 'decisions',
  review: 'reviews',
  process: 'processes',
  agent: 'agents',
}

export function getTableName(type: ObjectType): string {
  return TYPE_TO_TABLE[type]
}

export function getTable(type: ObjectType) {
  return (db as any)[TYPE_TO_TABLE[type]]
}

// ====== 通用 CRUD ======

export async function createObject<T extends AnyObject>(
  type: ObjectType,
  data: Partial<T>
): Promise<Result<T>> {
  const id = data.id || uid()
  const base: BaseObject = {
    id,
    type,
    title: (data as any).title || '',
    description: (data as any).description || '',
    emoji: (data as any).emoji || '📌',
    tags: (data as any).tags || [],
    createdAt: (data as any).createdAt || now(),
    updatedAt: now(),
    relations: (data as any).relations || [],  // legacy
  }

  const obj = { ...base, ...data, id, type, updatedAt: now() } as T

  try {
    const table = getTable(type)
    await table.add(obj)

    // 生成 event
    await createEvent('object.created', 'user', type, id, {
      title: (obj as any).title,
      type,
    })

    return ok(obj)
  } catch (e) {
    return err(`创建失败: ${e}`)
  }
}

export async function updateObject(
  type: ObjectType,
  id: string,
  data: Partial<AnyObject>
): Promise<Result<void>> {
  try {
    const table = getTable(type)
    const existing = await table.get(id)
    if (!existing) return err('对象不存在')

    const updated = { ...existing, ...data, updatedAt: now() }
    await table.put(updated)

    await createEvent('object.updated', 'user', type, id, {
      changedFields: Object.keys(data),
    })

    return ok(undefined)
  } catch (e) {
    return err(`更新失败: ${e}`)
  }
}

export async function deleteObject(
  type: ObjectType,
  id: string
): Promise<Result<void>> {
  try {
    const table = getTable(type)
    await table.delete(id)

    await createEvent('object.deleted', 'user', type, id, {})

    // 清理关联的 relations
    try {
      const outgoing = await db.relations
        .where('[sourceType+sourceId]')
        .equals([type, id]).toArray()
      const incoming = await db.relations
        .where('[targetType+targetId]')
        .equals([type, id]).toArray()
      const allRelIds = [...outgoing, ...incoming].map(r => r.id)
      if (allRelIds.length > 0) {
        await db.relations.bulkDelete(allRelIds)
      }
    } catch {
      // 关系清理失败不影响删除
    }

    return ok(undefined)
  } catch (e) {
    return err(`删除失败: ${e}`)
  }
}

export async function archiveObject(
  type: ObjectType,
  id: string
): Promise<Result<void>> {
  try {
    const table = getTable(type)
    const existing = await table.get(id)
    if (!existing) return err('对象不存在')

    const updated = { ...existing, archived: true, updatedAt: now() }
    await table.put(updated)

    await createEvent('object.archived', 'user', type, id, {})

    return ok(undefined)
  } catch (e) {
    return err(`归档失败: ${e}`)
  }
}

export async function restoreObject(
  type: ObjectType,
  id: string
): Promise<Result<void>> {
  try {
    const table = getTable(type)
    const existing = await table.get(id)
    if (!existing) return err('对象不存在')

    const updated = { ...existing, archived: false, updatedAt: now() }
    await table.put(updated)

    await createEvent('object.restored', 'user', type, id, {})

    return ok(undefined)
  } catch (e) {
    return err(`恢复失败: ${e}`)
  }
}

export async function getObject<T extends AnyObject>(
  type: ObjectType,
  id: string
): Promise<T | undefined> {
  const table = getTable(type)
  return table.get(id) as Promise<T | undefined>
}

export async function getAllObjects<T extends AnyObject>(
  type: ObjectType
): Promise<T[]> {
  const table = getTable(type)
  return table.toArray() as Promise<T[]>
}

// ====== 批量加载所有对象（用于 Store 初始化）======
export async function loadAllObjects(): Promise<Record<string, any[]>> {
  const result: Record<string, any[]> = {}
  await Promise.all(
    Object.entries(TABLES).map(async ([name, table]) => {
      try {
        result[name] = await table.toArray()
      } catch {
        result[name] = []
      }
    })
  )
  return result
}
