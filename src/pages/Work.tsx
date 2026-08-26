// ====== WorkPage — 外贸与独立站工作台（v1.1 合并版）======
// 整合原 Work.tsx（客户/询盘/SOP/模板）与 BusinessPage（管道/独立站）
// 数据统一走 IndexedDB；首次挂载自动迁移旧 localStorage 数据

import { useState, useEffect, useCallback } from 'react'
import { Plus, Globe, TrendingUp, Copy, Check, Users, FileText, Settings as SettingsIcon, Mail, Package } from 'lucide-react'
import { db } from '../db'
import {
  getAllTradeDeals, createTradeDeal, advanceTradeStage,
  groupByStage, pipelineValue,
} from '../repositories/tradeRepository'
import {
  getAllCustomers, createCustomer,
} from '../repositories/customerRepository'
import {
  getAllProducts, getRecentMetrics, analyzeMetrics, getAllSeoKeywords,
} from '../repositories/siteRepository'
import { useStore } from '../store'
import type { TradeDeal, TradeStage } from '../types'

// ---------- 旧数据迁移（localStorage → IndexedDB，一次性） ----------

const MIGRATED_KEY = 'evan-os-work-migrated-v1'

async function migrateLegacyData(): Promise<void> {
  if (localStorage.getItem(MIGRATED_KEY)) return
  try {
    const raw = localStorage.getItem('evan-os-work-data')
    if (raw) {
      const d = JSON.parse(raw)
      const stageMap: Record<string, TradeStage> = {
        new: 'inquiry', quoted: 'quotation', negotiating: 'negotiation',
        won: 'payment', lost: 'lost',
      }
      for (const c of d.customers ?? []) {
        const stageMapC: Record<string, 'lead' | 'contacted' | 'won' | 'lost'> = {
          lead: 'lead', active: 'contacted', vip: 'won', inactive: 'lost',
        }
        await createCustomer({
          title: c.name, company: c.name, contactName: c.contact,
          country: c.country, stage: stageMapC[c.status] ?? 'lead', notes: c.notes,
        })
      }
      for (const i of d.inquiries ?? []) {
        const deal = await createTradeDeal({
          title: i.product || i.customerName,
          value: i.amount,
          inquirySource: '迁移',
          tags: ['迁移'],
        })
        if (deal.ok) {
          const target = stageMap[i.status]
          if (target && target !== 'inquiry') await advanceTradeStage(deal.value.id, target)
        }
      }
      for (const s of d.sops ?? []) {
        await useStore.getState().addObject('process', {
          title: s.title, category: s.category,
          steps: (s.steps ?? []).map((t: string, idx: number) => ({
            id: `s${idx}`, order: idx, title: t, description: '', checklist: [],
          })),
        })
      }
      for (const t of d.templates ?? []) {
        await useStore.getState().addObject('knowledge', {
          title: t.title, content: t.content,
          category: 'template', tags: ['模板', t.category].filter(Boolean),
        })
      }
    }
  } catch { /* 迁移失败不阻塞 */ }
  localStorage.setItem(MIGRATED_KEY, '1')
}

// ---------- 常量 ----------

type TabKey = 'pipeline' | 'customers' | 'sops' | 'templates' | 'site'

const tabs: { key: TabKey; label: string; icon: typeof Globe }[] = [
  { key: 'pipeline', label: '管道', icon: TrendingUp },
  { key: 'customers', label: '客户', icon: Users },
  { key: 'sops', label: 'SOP', icon: SettingsIcon },
  { key: 'templates', label: '模板', icon: Mail },
  { key: 'site', label: '独立站', icon: Globe },
]

const stageLabels: Record<TradeStage, string> = {
  inquiry: '询盘', quotation: '报价', negotiation: '谈判', payment: '付款',
  production: '生产', shipping: '发货', after_sales: '售后', repurchase: '复购', lost: '流失',
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

const inputClass = 'w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-200'

export default function WorkPage() {
  const [tab, setTab] = useState<TabKey>('pipeline')
  const [deals, setDeals] = useState<TradeDeal[]>([])
  const [customers, setCustomers] = useState<Awaited<ReturnType<typeof getAllCustomers>>>([])
  const [metrics, setMetrics] = useState<ReturnType<typeof analyzeMetrics> | null>(null)
  const [productCount, setProductCount] = useState({ total: 0, active: 0 })
  const [keywords, setKeywords] = useState<{ keyword: string; position?: number }[]>([])
  const [sops, setSops] = useState<any[]>([])
  const [templates, setTemplates] = useState<any[]>([])
  const [copiedId, setCopiedId] = useState('')

  const refresh = useCallback(async () => {
    setDeals(await getAllTradeDeals())
    setCustomers(await getAllCustomers())
    const recent = await getRecentMetrics(7)
    setMetrics(analyzeMetrics(recent, 7))
    const products = await getAllProducts()
    setProductCount({ total: products.length, active: products.filter(p => p.status === 'active').length })
    setKeywords((await getAllSeoKeywords()).slice(0, 6))
    const allProcesses = await db.processes.toArray()
    setSops(allProcesses.filter(p => !p.archived).slice(0, 20))
    const allK = await db.knowledge.toArray()
    setTemplates(allK.filter(k => k.category === 'template' && !k.archived).slice(0, 20))
  }, [])

  useEffect(() => {
    migrateLegacyData().then(refresh)
  }, [refresh])

  // ---------- 动作 ----------
  const handleAdvance = async (deal: TradeDeal) => {
    const next = nextStageMap[deal.stage]
    if (next) { await advanceTradeStage(deal.id, next); refresh() }
  }

  const [newCustomer, setNewCustomer] = useState({ name: '', country: '', contact: '', notes: '' })
  const handleAddCustomer = async () => {
    if (!newCustomer.name.trim()) return
    await createCustomer({
      title: newCustomer.name.trim(), company: newCustomer.name.trim(),
      contactName: newCustomer.contact, country: newCustomer.country,
      stage: 'lead', notes: newCustomer.notes,
    })
    setNewCustomer({ name: '', country: '', contact: '', notes: '' })
    refresh()
  }

  const [newSop, setNewSop] = useState({ title: '', category: '外贸', stepsText: '' })
  const handleAddSop = async () => {
    if (!newSop.title.trim() || !newSop.stepsText.trim()) return
    await useStore.getState().addObject('process', {
      title: newSop.title.trim(), category: newSop.category,
      steps: newSop.stepsText.split('\n').filter(Boolean).map((t, idx) => ({
        id: `s${idx}`, order: idx, title: t.trim(), description: '', checklist: [],
      })),
    })
    setNewSop({ title: '', category: '外贸', stepsText: '' })
    refresh()
  }

  const [newTpl, setNewTpl] = useState({ title: '', category: '外贸', content: '' })
  const handleAddTemplate = async () => {
    if (!newTpl.title.trim() || !newTpl.content.trim()) return
    await useStore.getState().addObject('knowledge', {
      title: newTpl.title.trim(), content: newTpl.content,
      category: 'template', tags: ['模板', newTpl.category],
      format: 'markdown',
    })
    setNewTpl({ title: '', category: '外贸', content: '' })
    refresh()
  }

  const copyTemplate = (t: any) => {
    navigator.clipboard?.writeText(t.content).then(() => {
      setCopiedId(t.id)
      setTimeout(() => setCopiedId(''), 1500)
    }).catch(() => {})
  }

  const handleNewInquiry = async () => {
    const title = prompt('商机标题（如：LED 灯带 5000pcs 询盘）：')
    if (!title?.trim()) return
    const valueStr = prompt('预估金额 USD（可留空）：') ?? ''
    await createTradeDeal({ title: title.trim(), value: valueStr ? Number(valueStr) : undefined, inquirySource: '手动录入', tags: ['外贸'] })
    refresh()
  }

  const grouped = groupByStage(deals)

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Globe size={22} className="text-emerald-500" />
          <h1 className="text-xl font-bold text-gray-800">工作台</h1>
          <span className="text-xs text-gray-400">外贸 + 独立站</span>
        </div>
        <button onClick={handleNewInquiry} className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500 text-white rounded-lg text-xs font-medium hover:bg-emerald-600">
          <Plus size={14} /> 新建询盘
        </button>
      </div>
      <p className="text-xs text-gray-400 mb-4">
        客户 → 商机 → 报价 → 订单 → 沟通 → 售后 → 复购。跟进沉淀在沟通记录，阶段流转全程留痕。
      </p>

      {/* Tabs */}
      <div className="flex items-center gap-1 mb-4 overflow-x-auto border-b border-gray-100 pb-px">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm rounded-t-lg border-b-2 whitespace-nowrap transition-colors ${
              tab === t.key ? 'border-emerald-500 text-emerald-600 font-medium' : 'border-transparent text-gray-400 hover:text-gray-600'
            }`}
          >
            <t.icon size={14} /> {t.label}
          </button>
        ))}
      </div>

      {/* ====== 管道 ====== */}
      {tab === 'pipeline' && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-gray-400">管道价值 <b className="text-gray-600">${pipelineValue(deals).toLocaleString()}</b></span>
            <span className="text-xs text-gray-400">悬停卡片可推进阶段</span>
          </div>
          <div className="grid grid-cols-3 lg:grid-cols-9 gap-1.5 overflow-x-auto pb-2">
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
                        {!isLost && nextStageMap[d.stage] && (
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
          {deals.length === 0 && (
            <p className="text-xs text-gray-400 text-center py-8">暂无商机 —— 点右上角「新建询盘」开始</p>
          )}
        </div>
      )}

      {/* ====== 客户 ====== */}
      {tab === 'customers' && (
        <div className="space-y-4">
          <div className="bg-white border border-gray-200 rounded-2xl p-4 grid grid-cols-1 sm:grid-cols-4 gap-2">
            <input value={newCustomer.name} onChange={e => setNewCustomer({ ...newCustomer, name: e.target.value })} placeholder="客户名/公司" className={inputClass} />
            <input value={newCustomer.country} onChange={e => setNewCustomer({ ...newCustomer, country: e.target.value })} placeholder="国家/地区" className={inputClass} />
            <input value={newCustomer.contact} onChange={e => setNewCustomer({ ...newCustomer, contact: e.target.value })} placeholder="联系方式（邮箱/WhatsApp）" className={inputClass} />
            <button onClick={handleAddCustomer} className="flex items-center justify-center gap-1 px-3 py-2 bg-blue-500 text-white rounded-lg text-sm hover:bg-blue-600">
              <Plus size={14} /> 添加客户
            </button>
          </div>
          {customers.length === 0 ? (
            <p className="text-xs text-gray-400 text-center py-8">暂无客户</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {customers.map(c => (
                <div key={c.id} className="bg-white border border-gray-200 rounded-xl p-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-800 truncate">{c.title}</span>
                    <span className="px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded text-[10px]">{c.stage}</span>
                  </div>
                  <div className="text-[11px] text-gray-400 mt-1 flex flex-wrap gap-x-3">
                    {c.email && <span>✉️ {c.email}</span>}
                    {c.country && <span>📍 {c.country}</span>}
                  </div>
                  {c.notes && <p className="text-[11px] text-gray-400 mt-1 line-clamp-1">{c.notes}</p>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ====== SOP ====== */}
      {tab === 'sops' && (
        <div className="space-y-4">
          <div className="bg-white border border-gray-200 rounded-2xl p-4 space-y-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input value={newSop.title} onChange={e => setNewSop({ ...newSop, title: e.target.value })} placeholder="SOP 标题" className={inputClass} />
              <select value={newSop.category} onChange={e => setNewSop({ ...newSop, category: e.target.value })} className={inputClass}>
                <option>外贸</option><option>独立站</option><option>通用</option>
              </select>
            </div>
            <textarea value={newSop.stepsText} onChange={e => setNewSop({ ...newSop, stepsText: e.target.value })} rows={3} placeholder="每个步骤一行" className={inputClass} />
            <button onClick={handleAddSop} className="flex items-center gap-1 px-3 py-1.5 bg-blue-500 text-white rounded-lg text-xs hover:bg-blue-600">
              <Plus size={13} /> 添加 SOP
            </button>
          </div>
          {sops.length === 0 ? <p className="text-xs text-gray-400 text-center py-8">暂无 SOP</p> : (
            <div className="grid gap-2 sm:grid-cols-2">
              {sops.map(s => (
                <div key={s.id} className="bg-white border border-gray-200 rounded-xl p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-gray-800">{s.title}</span>
                    <span className="px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded text-[10px]">{s.category}</span>
                  </div>
                  <ol className="text-[11px] text-gray-500 list-decimal ml-4 space-y-0.5">
                    {(s.steps ?? []).slice(0, 5).map((st: any) => <li key={st.id ?? st.order}>{st.title}</li>)}
                  </ol>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ====== 模板 ====== */}
      {tab === 'templates' && (
        <div className="space-y-4">
          <div className="bg-white border border-gray-200 rounded-2xl p-4 space-y-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input value={newTpl.title} onChange={e => setNewTpl({ ...newTpl, title: e.target.value })} placeholder="模板标题" className={inputClass} />
              <select value={newTpl.category} onChange={e => setNewTpl({ ...newTpl, category: e.target.value })} className={inputClass}>
                <option>外贸</option><option>独立站</option><option>通用</option>
              </select>
            </div>
            <textarea value={newTpl.content} onChange={e => setNewTpl({ ...newTpl, content: e.target.value })} rows={3} placeholder="模板内容（支持占位符 [Name] [Product]）" className={inputClass} />
            <button onClick={handleAddTemplate} className="flex items-center gap-1 px-3 py-1.5 bg-blue-500 text-white rounded-lg text-xs hover:bg-blue-600">
              <Plus size={13} /> 添加模板
            </button>
          </div>
          {templates.length === 0 ? <p className="text-xs text-gray-400 text-center py-8">暂无模板</p> : (
            <div className="grid gap-2 sm:grid-cols-2">
              {templates.map(t => (
                <div key={t.id} className="bg-white border border-gray-200 rounded-xl p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-gray-800 truncate">{t.title}</span>
                    <button onClick={() => copyTemplate(t)} className="ml-auto p-1 text-gray-300 hover:text-blue-500" title="复制">
                      {copiedId === t.id ? <Check size={13} className="text-green-500" /> : <Copy size={13} />}
                    </button>
                  </div>
                  <pre className="text-[10px] text-gray-400 bg-gray-50 rounded-lg p-2 max-h-24 overflow-y-auto whitespace-pre-wrap">{t.content}</pre>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ====== 独立站 ====== */}
      {tab === 'site' && (
        <div className="space-y-4">
          {(!metrics || metrics.days === 0) ? (
            <div className="bg-white border border-gray-200 rounded-2xl p-8 text-center">
              <Package size={28} className="mx-auto text-gray-200 mb-2" />
              <p className="text-xs text-gray-400">暂无站点数据 —— 到「外部集成」页运行 Shopify 同步</p>
            </div>
          ) : metrics && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <MetricCard label="访客" value={metrics.totalVisitors.toLocaleString()} sub={`${metrics.days} 天合计`} />
                <MetricCard label="转化率" value={`${metrics.avgConversionRate}%`} sub={`${metrics.totalOrders} 单`} />
                <MetricCard label="收入" value={`$${metrics.totalRevenue.toLocaleString()}`} sub={metrics.roas > 0 ? `ROAS ${metrics.roas}` : ''} highlight={metrics.roas >= 3} />
                <MetricCard label="广告花费" value={`$${metrics.totalAdSpend.toLocaleString()}`} sub={`复购率 ${metrics.avgRepeatOrderRate}%`} />
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                <div className="bg-white border border-gray-200 rounded-2xl p-4">
                  <h3 className="text-xs font-bold text-gray-700 mb-2">产品目录（{productCount.total}）</h3>
                  <p className="text-[11px] text-gray-500">在售 {productCount.active} 个</p>
                </div>
                <div className="bg-white border border-gray-200 rounded-2xl p-4">
                  <h3 className="text-xs font-bold text-gray-700 mb-2">SEO 关键词</h3>
                  {keywords.length === 0 ? <p className="text-[11px] text-gray-400">暂无</p> : keywords.map(k => (
                    <div key={k.keyword} className="flex justify-between text-[11px] text-gray-600 py-0.5">
                      <span className="truncate">{k.keyword}</span>
                      <span className={((k.position ?? 99) <= 10) ? 'text-green-600' : 'text-gray-400'}>#{k.position ?? '-'}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
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
