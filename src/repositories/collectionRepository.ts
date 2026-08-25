// ====== Collection Repository ======
// 通用收藏/清单存储（v1.1）：替代 AICenter / Growth / Life 的 localStorage 孤岛
// 每个条目原始形状存于 data JSON，页面 UI 零改动

import { db } from '../db'
import type { CollectionKind, CollectionRecord } from '../types'
import { now } from './result'

/** 按 kind 列出条目（展开 data，按更新时间倒序） */
export async function listByKind(kind: CollectionKind): Promise<Record<string, any>[]> {
  try {
    const rows = await db.collections.where('kind').equals(kind).toArray()
    return rows
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(r => ({ ...(r.data ?? {}), id: r.id }))
  } catch {
    return []
  }
}

/**
 * 差异同步：以传入数组为准
 *   - 新增/修改 → put
 *   - 缺席的 id → 删除（自动进墓碑，云同步传播）
 */
export async function syncKind(kind: CollectionKind, items: Record<string, any>[]): Promise<void> {
  const existing = await db.collections.where('kind').equals(kind).toArray()
  const existingById = new Map(existing.map(r => [r.id, r]))
  const keepIds = new Set<string>()

  const ts = now()
  const toPut: CollectionRecord[] = []
  for (const item of items) {
    if (!item?.id) continue
    keepIds.add(String(item.id))
    const prev = existingById.get(String(item.id))
    toPut.push({
      id: String(item.id),
      kind,
      data: { ...item },
      createdAt: prev?.createdAt ?? ts,
      updatedAt: ts,
    })
  }
  if (toPut.length > 0) await db.collections.bulkPut(toPut)

  const removed = existing.filter(r => !keepIds.has(r.id)).map(r => r.id)
  if (removed.length > 0) await db.collections.bulkDelete(removed)
}

// ---------- localStorage 一次性迁移 ----------

/** 迁移 LS 顶层数组（如 evan-os-finances） */
export async function migrateLSList(lsKey: string, kind: CollectionKind): Promise<void> {
  await migrateLSItems(lsKey, kind, parsed => (Array.isArray(parsed) ? parsed : undefined))
}

/**
 * 迁移 LS 对象中的某个子数组（如 evan-os-ai-data.prompts）
 * 幂等：目标 kind 已有数据时跳过；LS 保留作为备份不删除
 */
export async function migrateLSItems(
  lsKey: string,
  kind: CollectionKind,
  pick: (parsed: any) => any[] | undefined
): Promise<void> {
  try {
    if (typeof localStorage === 'undefined') return
    const raw = localStorage.getItem(lsKey)
    if (!raw) return
    const arr = pick(JSON.parse(raw))
    if (!Array.isArray(arr)) return
    const existing = await listByKind(kind)
    if (existing.length > 0) return // 已有数据不重复迁移
    const ts = now()
    const rows: CollectionRecord[] = arr
      .filter(i => i?.id)
      .map(i => ({ id: String(i.id), kind, data: i, createdAt: ts, updatedAt: ts }))
    if (rows.length > 0) await db.collections.bulkPut(rows)
  } catch { /* 迁移失败不阻塞 */ }
}
