import { db } from '../db'
import type { InboxItem, ObjectType } from '../types'
import { uid, now, type Result, ok, err } from './result'
import { createEvent } from './eventRepository'

// ====== Inbox Repository ======

export async function captureInbox(
  content: string,
  type: InboxItem['type'],
  source?: string,
  metadata?: Record<string, any>
): Promise<Result<InboxItem>> {
  if (!content.trim()) return err('内容不能为空')

  const id = uid()
  const item: InboxItem = {
    id,
    content: content.trim(),
    type,
    capturedAt: now(),
    processed: false,
    source,
    metadata,
  }

  try {
    await db.inbox.add(item)
    await createEvent('inbox.captured', 'user', 'knowledge', id, {
      content: content.slice(0, 100), type, source,
    })
    // 注：inbox 不属于标准 ObjectType，这里用 knowledge 作为占位
    return ok(item)
  } catch (e) {
    return err(`收集失败: ${e}`)
  }
}

export async function processInbox(
  id: string,
  processedType: ObjectType,
  processedId: string
): Promise<Result<void>> {
  try {
    const item = await db.inbox.get(id)
    if (!item) return err('Inbox 项不存在')

    const next: InboxItem = {
      ...item,
      processed: true,
      processedType,
      processedId,
    }
    await db.inbox.put(next)

    await createEvent('inbox.processed', 'user', 'knowledge', id, {
      processedType, processedId,
    })

    return ok(undefined)
  } catch (e) {
    return err(`处理失败: ${e}`)
  }
}

export async function deleteInboxItem(id: string): Promise<Result<void>> {
  try {
    await db.inbox.delete(id)
    return ok(undefined)
  } catch (e) {
    return err(`删除失败: ${e}`)
  }
}

export async function getAllInbox(): Promise<InboxItem[]> {
  try { return await db.inbox.toArray() } catch { return [] }
}
