// ====== SearchDeepLink —— 搜索深链悬浮定位卡 ======
// 全局搜索点击结果 → 跳转 ?focus=<type>:<id> → 本组件拉取并悬浮展示该对象
// 关闭即清除参数，不干扰页面本身

import { useState, useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { X, Crosshair } from 'lucide-react'
import { getObject } from '../repositories/objectRepository'
import { db } from '../db'

const TABLE_EXTRA: Record<string, string> = {
  memory: 'memories', tradeDeal: 'tradeDeals', siteProduct: 'siteProducts',
  seoKeyword: 'seoKeywords', habit: 'habits', dailyLog: 'dailyLogs',
  notification: 'notifications', prompt: 'collections', ai_tool: 'collections',
  study_log: 'collections', study_resource: 'collections', finance: 'collections',
  wish: 'collections', health: 'collections', life_plan: 'collections',
  personal_record: 'collections',
}

async function resolveAny(type: string, id: string): Promise<Record<string, any> | null> {
  try {
    if (TABLE_EXTRA[type] === 'collections') {
      const rec = await db.collections.get(id)
      if (rec) return { title: rec.data?.title ?? id, description: rec.data?.content ?? rec.data?.description ?? '', type }
      return null
    }
    if (TABLE_EXTRA[type]) {
      const row = await (db as any)[TABLE_EXTRA[type]].get(id)
      return row ? { ...row, type } : null
    }
    const obj = await getObject(type as never, id)
    return obj ? { ...obj } : null
  } catch {
    return null
  }
}

export default function SearchDeepLink() {
  const location = useLocation()
  const navigate = useNavigate()
  const [item, setItem] = useState<Record<string, any> | null>(null)

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const focus = params.get('focus')
    if (!focus) { setItem(null); return }
    const [type, id] = focus.split(':')
    if (!type || !id) { setItem(null); return }
    let alive = true
    resolveAny(decodeURIComponent(type), decodeURIComponent(id)).then(obj => {
      if (alive) setItem(obj ? { ...obj, _type: type, _id: id } : null)
    })
    return () => { alive = false }
  }, [location.search])

  if (!item) return null

  const close = () => {
    navigate(location.pathname, { replace: true })
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 w-[300px] bg-white dark:bg-[#161a22] border border-blue-200 dark:border-blue-900 rounded-2xl shadow-xl p-3.5">
      <div className="flex items-start gap-2">
        <Crosshair size={14} className="text-blue-500 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-blue-400">来自搜索</span>
            {item.emoji && <span className="text-sm">{item.emoji}</span>}
          </div>
          <div className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate mt-0.5">
            {item.title ?? item.id}
          </div>
          {item.description && (
            <p className="text-[11px] text-gray-400 line-clamp-2 mt-0.5">{String(item.description)}</p>
          )}
        </div>
        <button onClick={close} className="p-1 text-gray-300 hover:text-gray-500 shrink-0" title="关闭">
          <X size={13} />
        </button>
      </div>
    </div>
  )
}
