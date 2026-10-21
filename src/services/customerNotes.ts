// 客户人工备注：跟进表 / 客户界面「AI 客户画像」/ AI 分析 —— 单一事实源
// 事实源字段：customers.notes
// 双向同步：跟进表与客户界面读写同一字段；写入后广播 CUSTOMERS_UPDATED，两端自动刷新
import { db } from '../db'
import type { Customer } from '../types'
import { EVENTS } from '../utils/emailHelpers'

/** 读取客户备注 */
export function getCustomerNote(c?: Customer | null): string {
  if (!c) return ''
  return String((c as any).notes || '')
}

/** 写入客户备注（更新 customers.notes + updatedAt，使云同步 LWW 正确传播） */
export async function setCustomerNote(customerId: string, note: string): Promise<void> {
  const clean = String(note || '').replace(/\s+$/g, '')
  const ts = new Date().toISOString()
  await db.customers.update(customerId, {
    notes: clean,
    noteUpdatedAt: ts,
    updatedAt: ts,
  } as any)
  window.dispatchEvent(new CustomEvent(EVENTS.CUSTOMERS_UPDATED, { detail: { customerId, notes: clean } }))
}

/** 注入 AI prompt 的备注文本（人工输入，AI 视为最高优先级上下文，不得覆盖） */
export function noteForPrompt(c?: Customer | null, maxLen = 600): string {
  const n = getCustomerNote(c).trim()
  return n ? n.slice(0, maxLen) : ''
}
