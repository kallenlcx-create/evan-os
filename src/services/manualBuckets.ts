// 手动分配客户到跟进六板块
// 持久化：优先 Dexie collections（可云同步），localStorage 仅作迁移/降级缓存
import { db } from '../db'
import { now } from '../repositories/result'

export type ManualBucket = 'high' | 'today' | 'overdue' | 'pending' | 'repurchase' | 'marketing'

export const MANUAL_BUCKETS: { key: ManualBucket; label: string }[] = [
  { key: 'high', label: '高意向' },
  { key: 'today', label: '今日跟进' },
  { key: 'overdue', label: '逾期跟进' },
  { key: 'pending', label: '待成交机会' },
  { key: 'repurchase', label: '潜在复购' },
  { key: 'marketing', label: '营销机会' },
]

type BucketEntry = { buckets: ManualBucket[]; note?: string; updatedAt: string }
type Store = Record<string, BucketEntry>

const LS_KEY = 'evan:manualBuckets'
const COLLECTION_KIND = 'manual_bucket'
/** 内存缓存：避免列表页每次 render 都打 IndexedDB */
let memStore: Store | null = null
let migrated = false

function readLocal(): Store {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '{}') as Store
  } catch { return {} }
}

function writeLocal(store: Store) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(store)) } catch { /* ignore */ }
}

async function migrateLocalToDb(): Promise<Store> {
  if (migrated && memStore) return memStore
  const local = readLocal()
  try {
    const rows = await db.collections.where('kind').equals(COLLECTION_KIND).toArray() as any[]
    const store: Store = {}
    for (const r of rows) {
      const id = String(r.data?.customerId || r.id || '').replace(/^mb-/, '')
      if (!id) continue
      store[id] = {
        buckets: (r.data?.buckets || []) as ManualBucket[],
        note: r.data?.note,
        updatedAt: r.updatedAt || r.createdAt || now(),
      }
    }
    // 本地有、库里没有 → 写入 collections
    let dirty = false
    for (const [cid, entry] of Object.entries(local)) {
      if (store[cid]) continue
      const rec = {
        id: `mb-${cid}`,
        kind: COLLECTION_KIND,
        category: (entry.buckets || []).join(','),
        data: { customerId: cid, buckets: entry.buckets || [], note: entry.note },
        createdAt: entry.updatedAt || now(),
        updatedAt: entry.updatedAt || now(),
      }
      await db.collections.put(rec as any)
      store[cid] = entry
      dirty = true
    }
    if (dirty || rows.length) writeLocal(store)
    memStore = store
    migrated = true
    return store
  } catch {
    memStore = { ...local }
    migrated = true
    return memStore
  }
}

function notify() {
  window.dispatchEvent(new CustomEvent('evan-manual-buckets'))
}

export function loadManualBuckets(): Store {
  // 同步路径：先给内存/本地，后台补库
  if (memStore) return memStore
  const local = readLocal()
  memStore = local
  void migrateLocalToDb().then(s => {
    if (JSON.stringify(s) !== JSON.stringify(local)) notify()
  })
  return local
}

/** 异步加载（页面 mount 后调用一次，保证拿到库内最新） */
export async function loadManualBucketsAsync(): Promise<Store> {
  return migrateLocalToDb()
}

export function getCustomerBuckets(customerId: string): ManualBucket[] {
  return loadManualBuckets()[customerId]?.buckets || []
}

export function getManualCustomersByBucket(bucket: ManualBucket): string[] {
  const store = loadManualBuckets()
  return Object.entries(store)
    .filter(([, v]) => (v.buckets || []).includes(bucket))
    .map(([id]) => id)
}

async function persistEntry(customerId: string, entry: BucketEntry) {
  try {
    if (!entry.buckets.length) {
      await db.collections.delete(`mb-${customerId}`)
      return
    }
    await db.collections.put({
      id: `mb-${customerId}`,
      kind: COLLECTION_KIND,
      category: entry.buckets.join(','),
      data: { customerId, buckets: entry.buckets, note: entry.note },
      createdAt: entry.updatedAt,
      updatedAt: entry.updatedAt,
    } as any)
  } catch { /* 降级：仅 localStorage */ }
}

export function addManualBuckets(customerIds: string[], buckets: ManualBucket[], note?: string) {
  const store = { ...loadManualBuckets() }
  const ts = now()
  for (const id of customerIds) {
    const cur = store[id] || { buckets: [] as ManualBucket[], updatedAt: ts }
    const next: BucketEntry = {
      buckets: [...new Set([...(cur.buckets || []), ...buckets])],
      note: note || cur.note,
      updatedAt: ts,
    }
    store[id] = next
    void persistEntry(id, next)
  }
  memStore = store
  writeLocal(store)
  notify()
  return store
}

/** 移除某客户的某个板块；删光后从 store 去掉（默认不再展示） */
export function removeManualBucket(customerId: string, bucket: ManualBucket) {
  const store = { ...loadManualBuckets() }
  const cur = store[customerId]
  if (!cur) return store
  const nextBuckets = (cur.buckets || []).filter(b => b !== bucket)
  if (!nextBuckets.length) {
    delete store[customerId]
    void persistEntry(customerId, { buckets: [], updatedAt: now() })
  } else {
    const next: BucketEntry = { ...cur, buckets: nextBuckets, updatedAt: now() }
    store[customerId] = next
    void persistEntry(customerId, next)
  }
  memStore = store
  writeLocal(store)
  notify()
  return store
}

export function clearCustomerManualBuckets(customerId: string) {
  const store = { ...loadManualBuckets() }
  delete store[customerId]
  void persistEntry(customerId, { buckets: [], updatedAt: now() })
  memStore = store
  writeLocal(store)
  notify()
}

/** 一键清理：只保留邮件噪声类客户不动，供客户页批量归档前用 */
export function isLikelyNoiseCustomer(c: { email?: string; title?: string; tags?: string[] }): boolean {
  const addr = String(c.email || '').toLowerCase()
  if (!addr) return true
  return /(^|@)(noreply|no-reply|donotreply|mailer-daemon|postmaster|bounce)/.test(addr)
    || /@(youtube|quora|announce\.fiverr|flipboard)\./.test(addr)
}
