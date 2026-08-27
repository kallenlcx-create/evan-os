// ====== useCollectionData — 多 kind 的 localStorage→IndexedDB 水合 + 双向同步 ======
// 抽取 AICenter / Growth 等页面的重复持久化模式

import { useState, useEffect, useCallback, type DependencyList } from 'react'
import { listByKind, migrateLSItems, syncKind, onKindsChanged } from '../repositories/collectionRepository'

/**
 * @param lsKey       localStorage 的 key（如 'evan-os-ai-data'）
 * @param kinds       要管理的 kind 列表（如 ['prompt', 'ai_tool']）
 * @param extract     从 localStorage JSON 中提取各 kind 数组的函数
 * @param defaults    localStorage 为空时的默认值（结构同 extract 返回值）
 * @param deps        额外的依赖数组（如 [hydrateKinds]）
 */
export function useCollectionData<K extends string, T extends Record<K, unknown[]>>(
  lsKey: string,
  kinds: K[],
  extract: (raw: unknown) => Partial<Record<K, unknown[]>>,
  defaults: T,
  deps?: DependencyList,
) {
  const [data, setData] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(lsKey)
      if (raw) return { ...defaults, ...extract(JSON.parse(raw)) } as T
    } catch { /* ignore */ }
    return defaults
  })

  const [hydrated, setHydrated] = useState(false)

  const hydrateKinds = useCallback(async (first = false) => {
    if (first) {
      await Promise.all(kinds.map(k => migrateLSItems(lsKey, k as any, d => extract(d)?.[k])))
    }
    const results = await Promise.all(kinds.map(k => listByKind(k as any)))
    setData(prev => {
      let changed = false
      const next = { ...prev }
      kinds.forEach((k, i) => {
        const rows = results[i]
        if (rows.length > 0 && JSON.stringify(rows) !== JSON.stringify(prev[k])) {
          ;(next as any)[k] = rows
          changed = true
        }
      })
      return changed ? next : prev
    })
    if (first) setHydrated(true)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void hydrateKinds(true) }, [hydrateKinds])
  useEffect(() => onKindsChanged(() => { void hydrateKinds() }), [hydrateKinds, ...(deps ?? [])])

  // 写回 IndexedDB
  useEffect(() => {
    if (!hydrated) return
    kinds.forEach(k => syncKind(k as any, (data as any)[k] as unknown[]).catch(() => {}))
  }, [data, hydrated, kinds])

  return [data, setData] as const
}
