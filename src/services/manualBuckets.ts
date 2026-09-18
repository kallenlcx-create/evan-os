// 手动分配客户到跟进六板块
export type ManualBucket = 'high' | 'today' | 'overdue' | 'pending' | 'repurchase' | 'marketing'

export const MANUAL_BUCKETS: { key: ManualBucket; label: string }[] = [
  { key: 'high', label: '高意向' },
  { key: 'today', label: '今日跟进' },
  { key: 'overdue', label: '逾期跟进' },
  { key: 'pending', label: '待成交机会' },
  { key: 'repurchase', label: '潜在复购' },
  { key: 'marketing', label: '营销机会' },
]

type Store = Record<string, { buckets: ManualBucket[]; note?: string; updatedAt: string }>

const KEY = 'evan:manualBuckets'

export function loadManualBuckets(): Store {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') as Store
  } catch { return {} }
}

function saveStore(store: Store) {
  localStorage.setItem(KEY, JSON.stringify(store))
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

export function addManualBuckets(customerIds: string[], buckets: ManualBucket[], note?: string) {
  const store = loadManualBuckets()
  const ts = new Date().toISOString()
  for (const id of customerIds) {
    const cur = store[id] || { buckets: [] as ManualBucket[], updatedAt: ts }
    store[id] = {
      buckets: [...new Set([...(cur.buckets || []), ...buckets])],
      note: note || cur.note,
      updatedAt: ts,
    }
  }
  saveStore(store)
  window.dispatchEvent(new CustomEvent('evan-manual-buckets'))
  return store
}

/** 移除某客户的某个板块；删光后从 store 去掉（默认不再展示） */
export function removeManualBucket(customerId: string, bucket: ManualBucket) {
  const store = loadManualBuckets()
  const cur = store[customerId]
  if (!cur) return store
  const next = (cur.buckets || []).filter(b => b !== bucket)
  if (!next.length) delete store[customerId]
  else store[customerId] = { ...cur, buckets: next, updatedAt: new Date().toISOString() }
  saveStore(store)
  window.dispatchEvent(new CustomEvent('evan-manual-buckets'))
  return store
}

export function clearCustomerManualBuckets(customerId: string) {
  const store = loadManualBuckets()
  delete store[customerId]
  saveStore(store)
  window.dispatchEvent(new CustomEvent('evan-manual-buckets'))
}
