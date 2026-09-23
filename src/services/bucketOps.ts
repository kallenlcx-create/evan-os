// 板块/标签批量操作：客户页与跟进雷达共用，保证移出后两边同步消失
import { db } from '../db'
import type { Customer } from '../types'
import { daysNoFollow } from './followProfile'
import {
  addManualBuckets,
  removeManualBuckets,
  loadManualBuckets,
  loadManualBucketsAsync,
  type ManualBucket,
  MANUAL_BUCKETS,
} from './manualBuckets'

const AI_TIER_FOR: Partial<Record<ManualBucket, string>> = {
  high: 'high',
  pending: 'pending',
  repurchase: 'repurchase',
  marketing: 'marketing',
}

export function bucketOptOutSet(c: Customer | any): Set<string> {
  const o = (c as any)?.bucketOptOut
  if (!o) return new Set()
  if (Array.isArray(o)) return new Set(o.map(String))
  if (typeof o === 'object') return new Set(Object.keys(o).filter(k => (o as any)[k]).map(String))
  return new Set()
}

function withOptOut(c: Customer | any, key: ManualBucket, on: boolean) {
  const set = bucketOptOutSet(c)
  if (on) set.add(key)
  else set.delete(key)
  const obj: Record<string, boolean> = {}
  for (const k of set) obj[k] = true
  return obj
}

/** 是否属于某六板块（手动 / aiTier / 系统推断）；用户点过「移出」则永久屏蔽自动来源 */
export function isInBucket(
  c: Customer | any,
  key: ManualBucket,
  ctx?: {
    manualMap?: Record<string, { buckets?: string[] }>
    todaySet?: Set<string>
    overdueSet?: Set<string>
    orderedSet?: Set<string>
  },
): boolean {
  const opt = bucketOptOutSet(c)
  const mb = (ctx?.manualMap?.[c.id as string]?.buckets || []).map(String)
  // 手动放入优先（重新移入会清掉 opt-out）
  if (mb.includes(key)) return true
  if (opt.has(key)) return false
  const t = String((c as any).aiTier || '')
  const tags = (c.tags || []).map(String)
  const ordered = tags.includes('已下单') || c.stage === 'won' || (c.repurchaseCount || 0) >= 1 || !!ctx?.orderedSet?.has(c.id)
  const days = daysNoFollow(c)
  switch (key) {
    case 'high':
      // 不把「仅有回复」算高意向，否则移出后仍会回来
      return t === 'high'
    case 'today':
      return !!ctx?.todaySet?.has(String(c.id))
    case 'overdue':
      return !ordered && !!ctx?.overdueSet?.has(String(c.id))
    case 'pending':
      return t === 'pending'
    case 'repurchase':
      return t === 'repurchase' || (ordered && Number.isFinite(days) && days >= 30)
    case 'marketing':
      return t === 'marketing'
    default:
      return false
  }
}

function notifyAll() {
  window.dispatchEvent(new CustomEvent('evan-manual-buckets'))
  window.dispatchEvent(new CustomEvent('evan-customers-updated'))
}

/**
 * 批量移入/移出六板块（完整语义）：
 * - 写手动板块
 * - 移出时清掉对应 aiTier，并打 bucketOptOut，系统自动分类不再悄悄加回
 * - 移入时清掉 opt-out，必要时写回 aiTier
 */
export async function applyBuckets(opts: {
  customerIds: string[]
  add?: ManualBucket[]
  remove?: ManualBucket[]
  mode?: 'replace' | 'add'
  clearAll?: boolean
  note?: string
}): Promise<{ changed: number }> {
  const ids = [...new Set(opts.customerIds.filter(Boolean))]
  if (!ids.length) return { changed: 0 }
  const ts = new Date().toISOString()
  let changed = 0

  if (opts.clearAll) {
    removeManualBuckets(ids, [])
    for (const id of ids) {
      const c = await db.customers.get(id) as Customer | undefined
      if (!c) continue
      const patch: any = { bucketOptOut: {}, updatedAt: ts }
      // 清空=从全部板块移出
      for (const b of MANUAL_BUCKETS) patch.bucketOptOut = withOptOut({ bucketOptOut: patch.bucketOptOut }, b.key, true)
      const t = String((c as any).aiTier || '')
      if (['high', 'pending', 'repurchase', 'marketing'].includes(t)) {
        patch.aiTier = ''
        patch.aiReason = '用户清空板块'
      }
      await db.customers.update(id, patch)
      changed++
    }
    notifyAll()
    return { changed }
  }

  if (opts.remove?.length) {
    removeManualBuckets(ids, opts.remove)
    for (const id of ids) {
      const c = await db.customers.get(id) as Customer | undefined
      if (!c) continue
      let opt = bucketOptOutSet(c)
      const patch: any = { updatedAt: ts }
      for (const b of opts.remove) {
        opt = new Set([...opt, b])
        const tier = AI_TIER_FOR[b]
        if (tier && String((c as any).aiTier || '') === tier) {
          patch.aiTier = ''
          patch.aiReason = `用户移出${MANUAL_BUCKETS.find(x=>x.key===b)?.label || b}`
        }
      }
      const obj: Record<string, boolean> = {}
      for (const k of opt) obj[k] = true
      patch.bucketOptOut = obj
      await db.customers.update(id, patch)
      changed++
    }
  }

  if (opts.add?.length) {
    addManualBuckets(ids, opts.add, opts.note, opts.mode || 'replace')
    for (const id of ids) {
      const c = await db.customers.get(id) as Customer | undefined
      if (!c) continue
      let opt = bucketOptOutSet(c)
      const patch: any = { updatedAt: ts }
      for (const b of opts.add) {
        opt = new Set([...opt].filter(x => x !== b))
        const tier = AI_TIER_FOR[b]
        if (tier && b === 'high') {
          // 高意向以手动为准，补 aiTier 让客户页角标一致
          patch.aiTier = 'high'
          patch.aiReason = opts.note || '手动移入高意向'
        }
      }
      const obj: Record<string, boolean> = {}
      for (const k of opt) obj[k] = true
      patch.bucketOptOut = obj
      await db.customers.update(id, patch)
      changed++
    }
  }

  await loadManualBucketsAsync().catch(() => loadManualBuckets())
  notifyAll()
  return { changed }
}

/** 批量打/删客户标签（产品标 Patch/Pin… 或自定义），与客户页同步 */
export async function applyCustomerTags(opts: {
  customerIds: string[]
  add?: string[]
  remove?: string[]
}): Promise<{ changed: number }> {
  const ids = [...new Set(opts.customerIds.filter(Boolean))]
  const add = (opts.add || []).map(s => s.trim()).filter(Boolean)
  const remove = (opts.remove || []).map(s => s.trim()).filter(Boolean)
  if (!ids.length || (!add.length && !remove.length)) return { changed: 0 }
  const ts = new Date().toISOString()
  let changed = 0
  for (const id of ids) {
    const c = await db.customers.get(id) as Customer | undefined
    if (!c) continue
    let tags = [...(c.tags || []).map(String)]
    if (add.length) tags = [...new Set([...tags, ...add])]
    if (remove.length) tags = tags.filter(t => !remove.includes(t))
    await db.customers.update(id, { tags, updatedAt: ts } as any)
    changed++
  }
  notifyAll()
  return { changed }
}
