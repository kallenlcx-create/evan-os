// ====== BusinessPage — 外贸管道 + 独立站经营 ======
// v0.9 业务层：询盘→报价→谈判→付款→生产→发货→售后→复购
// 独立站：产品 / 流量 / SEO / 广告 / 转化 / 复购

import { useState, useEffect, useCallback } from 'react'
import {
  TrendingUp, Globe, Package, Plus,
} from 'lucide-react'
import {
  getAllTradeDeals, createTradeDeal, advanceTradeStage, groupByStage, pipelineValue,
} from '../repositories/tradeRepository'
import {
  getAllProducts, getRecentMetrics, analyzeMetrics, getAllSeoKeywords,
} from '../repositories/siteRepository'
import type { TradeDeal, TradeStage } from '../types'

const stageLabels: Record<TradeStage, string> = {
  inquiry: '询盘', quotation: '报价', negotiation: '谈判', payment: '付款',
  production: '生产', shipping: '发货', after_sales: '售后', repurchase: '复购',
  lost: '流失',
}
const stageOrder: TradeStage[] = [
  'inquiry', 'quotation', 'negotiation', 'payment',
  'production', 'shipping', 'after_sales', 'repurchase', 'lost',
]

const nextStageMap: Partial<Record<TradeStage, TradeStage>> = {
  inquiry: 'quotation', quotation: 'negotiation', negotiation: 'payment',
  payment: 'production', production: 'shipping', shipping: 'after_sales',
  after_sales: 'repurchase',
}

export default function BusinessPage() {
  const [deals, setDeals] = useState<TradeDeal[]>([])
  const [metrics, setMetrics] = useState<ReturnType<typeof analyzeMetrics> | null>(null)
  const [productCount, setActiveCount] = useState({ total: 0, active: 0 })
  const [keywords, setKeywords] = useState<{ keyword: string; position?: number }[]>([])

  const refresh = useCallback(async () => {
    const allDeals = await getAllTradeDeals()
    setDeals(allDeals)
    const recent = await getRecentMetrics(7)
    setMetrics(analyzeMetrics(recent, 7))
    const products = await getAllProducts()
    setActiveCount({ total: products.length, active: products.filter(p => p.status === 'active').length })
    setKeywords((await getAllSeoKeywords()).slice(0, 6))
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const handleNewInquiry = async () => {
    const title = prompt('商机标题（如：LED 灯带 5000pcs 询盘）：')
    if (!title?.trim()) return
    const valueStr = prompt('预估金额 USD（可留空）：') ?? ''
    await createTradeDeal({
      title: title.trim(),
      value: valueStr ? Number(valueStr) : undefined,
      inquirySource: '手动录入',
      tags: ['外贸'],
    })
    refresh()
  }

  const handleAdvance = async (deal: TradeDeal) => {
    const next = nextStageMap[deal.stage]
    if (!next) return
    await advanceTradeStage(deal.id, next)
    refresh()
  }

  const grouped = groupByStage(deals)

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <TrendingUp size={22} className="text-emerald-500" />
          <h1 className="text-xl font-bold text-gray-800">业务</h1>
          <span className="text-xs text-gray-400">外贸管道 + 独立站</span>
        </div>
        <button onClick={handleNewInquiry} className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500 text-white rounded-lg text-xs font-medium hover:bg-emerald-600">
          <Plus size={14} /> 新建询盘
        </button>
      </div>
      <p className="text-xs text-gray-400 mb-5">
        基于 Customer / Opportunity / Order / Communication 的业务层。跟进通过沟通记录沉淀，阶段流转全部留痕。
      </p>

      {/* 外贸看板 */}
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-bold text-gray-700">外贸管道</h2>
        <span className="text-xs text-gray-400">
          管道价值 <b className="text-gray-600">${pipelineValue(deals).toLocaleString()}</b>
        </span>
      </div>
      <div className="grid grid-cols-3 lg:grid-cols-9 gap-1.5 mb-8 overflow-x-auto">
        {stageOrder.map(stage => {
          const items = grouped[stage] ?? []
          const isLost = stage === 'lost'
          return (
            <div key={stage} className={`rounded-xl border p-2 min-h-[100px] ${isLost ? 'bg-red-50/50 border-red-100' : 'bg-white border-gray-200'}`}>
              <div className={`text-[10px] font-medium mb-1.5 ${isLost ? 'text-red-400' : 'text-gray-400'}`}>
                {stageLabels[stage]} {items.length > 0 && `(${items.length})`}
              </div>
              <div className="space-y-1">
                {items.slice(0, 4).map(d => (
                  <div key={d.id} className="bg-gray-50 border border-gray-100 rounded-lg p-1.5 group relative" title={d.title}>
                    <div className="text-[10px] text-gray-700 truncate">{d.title}</div>
                    {d.value != null && <div className="text-[9px] text-gray-400">${d.value}</div>}
                    {!isLost && nextStageMap[deal_stage_key(d.stage)] && (
                      <button
                        onClick={() => handleAdvance(d)}
                        className="absolute inset-0 bg-emerald-500/90 text-white text-[9px] rounded-lg opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        推进 →
                      </button>
                    )}
                  </div>
                ))}
                {items.length > 4 && <div className="text-[9px] text-gray-300">+{items.length - 4}…</div>}
              </div>
            </div>
          )
        })}
      </div>

      {/* 独立站 */}
      <h2 className="text-sm font-bold text-gray-700 mb-2 flex items-center gap-1.5">
        <Globe size={14} className="text-green-500" /> 独立站经营（近 7 天）
      </h2>

      {(!metrics || metrics.days === 0) ? (
        <div className="bg-white border border-gray-200 rounded-2xl p-8 text-center mb-8">
          <Package size={28} className="mx-auto text-gray-200 mb-2" />
          <p className="text-xs text-gray-400">暂无站点数据 —— 到「外部集成」页运行 Shopify 同步</p>
        </div>
      ) : metrics && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
          <MetricCard label="访客" value={metrics.totalVisitors.toLocaleString()} sub={`${metrics.days} 天合计`} />
          <MetricCard label="转化率" value={`${metrics.avgConversionRate}%`} sub={`${metrics.totalOrders} 单`} />
          <MetricCard label="收入" value={`$${metrics.totalRevenue.toLocaleString()}`} sub={metrics.roas > 0 ? `ROAS ${metrics.roas}` : ''} highlight={metrics.roas >= 3} />
          <MetricCard label="广告花费" value={`$${metrics.totalAdSpend.toLocaleString()}`} sub={`复购率 ${metrics.avgRepeatOrderRate}%`} />
        </div>
      )}

      {/* 产品 + SEO */}
      <div className="grid sm:grid-cols-2 gap-3">
        <div className="bg-white border border-gray-200 rounded-2xl p-4">
          <h3 className="text-xs font-bold text-gray-700 mb-2">产品目录（{productCount.total}）</h3>
          {productCount.total === 0 ? (
            <p className="text-[11px] text-gray-400">Shopify 同步后显示</p>
          ) : (
            <p className="text-[11px] text-gray-500">在售 {productCount.active} 个 · 全部 {productCount.total} 个</p>
          )}
        </div>
        <div className="bg-white border border-gray-200 rounded-2xl p-4">
          <h3 className="text-xs font-bold text-gray-700 mb-2">SEO 关键词</h3>
          {keywords.length === 0 ? (
            <p className="text-[11px] text-gray-400">暂无关键词追踪</p>
          ) : keywords.map(k => (
            <div key={k.keyword} className="flex justify-between text-[11px] text-gray-600 py-0.5">
              <span className="truncate">{k.keyword}</span>
              <span className={((k.position ?? 99) <= 10) ? 'text-green-600' : 'text-gray-400'}>#{k.position ?? '-'}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function deal_stage_key(s: TradeStage): TradeStage {
  return s
}

function MetricCard({ label, value, sub, highlight }: { label: string; value: string; sub?: string; highlight?: boolean }) {
  return (
    <div className={`border rounded-2xl p-3 ${highlight ? 'bg-green-50 border-green-200' : 'bg-white border-gray-200'}`}>
      <div className="text-[10px] text-gray-400 mb-0.5">{label}</div>
      <div className={`text-base font-bold ${highlight ? 'text-green-700' : 'text-gray-800'}`}>{value}</div>
      {sub && <div className="text-[10px] text-gray-400">{sub}</div>}
    </div>
  )
}
