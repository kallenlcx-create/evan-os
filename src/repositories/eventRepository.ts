import { db } from '../db'
import type { EventRecord, EventType, ObjectType } from '../types'
import { uid, now } from './result'

// ====== Event Repository ======
// 写入事件记录，不支持删除（审计日志）

export async function createEvent(
  type: EventType,
  actorType: 'user' | 'system' | 'agent',
  objectType: ObjectType,
  objectId: string,
  payload: Record<string, any> = {},
  options?: { actorId?: string; correlationId?: string; causationId?: string }
): Promise<string> {
  const id = uid()
  const event: EventRecord = {
    id,
    type,
    actorType,
    actorId: options?.actorId,
    objectType,
    objectId,
    payload,
    createdAt: now(),
    correlationId: options?.correlationId,
    causationId: options?.causationId,
  }
  try {
    await db.events.add(event)
  } catch (e) {
    console.warn('[EventRepo] 写入事件失败:', e)
  }
  return id
}

// 查询单个对象的时间线（Event 查询视图）
export async function getTimeline(
  objectType: ObjectType,
  objectId: string,
  limit = 50
): Promise<EventRecord[]> {
  try {
    return await db.events
      .where('[objectType+objectId]')
      .equals([objectType, objectId])
      .reverse()
      .limit(limit)
      .toArray()
  } catch {
    return []
  }
}

// 查询全局事件流
export async function getAllEvents(limit = 100): Promise<EventRecord[]> {
  try {
    return await db.events.orderBy('createdAt').reverse().limit(limit).toArray()
  } catch {
    return []
  }
}
