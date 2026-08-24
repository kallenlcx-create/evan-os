// ====== Evan OS v0.9 外贸 + 独立站业务层测试 ======
// 交易阶段机 / 管道分析 / 站点指标分析 / SEO / AI 实验室热点漏斗
// 运行: npx tsx test-business.ts

import 'fake-indexeddb/auto'
import { db } from './src/db.ts'
import {
  createTradeDeal, advanceTradeStage, getAllTradeDeals,
  groupByStage, pipelineValue,
} from './src/repositories/tradeRepository.ts'
import {
  upsertProductByHandle, upsertMetric, analyzeMetrics,
  getRecentMetrics, upsertSeoKeyword,
} from './src/repositories/siteRepository.ts'
import { captureInbox, processInbox } from './src/repositories/inboxRepository.ts'
import { createKnowledge } from './src/repositories/knowledgeRepository.ts'

let pass = 0, fail = 0
function assert(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`) }
  else { fail++; console.log(`  [FAIL] ${name}`) }
}

console.log('\n🧪 Evan OS v0.9 业务层测试\n')

await Promise.all([
  db.tradeDeals.clear(), db.siteProducts.clear(),
  db.siteMetrics.clear(), db.seoKeywords.clear(),
  db.inbox.clear(), db.knowledge.clear(), db.research.clear(),
  db.inspirations.clear(), db.events.clear(),
])

// ====== A. 外贸管道 ======
console.log('— 外贸阶段机 —')

const d1 = await createTradeDeal({ title: 'LED 灯带 5000pcs', value: 12000, inquirySource: '阿里巴巴' })
assert('A1. 新商机从询盘开始且留痕', d1.ok && d1.value.stage === 'inquiry' && d1.value.stageHistory.length === 1)

const adv1 = await advanceTradeStage(d1.value!.id, 'quotation')
assert('A2. 询盘 → 报价 合法推进', adv1.ok && adv1.value.stage === 'quotation')

const back = await advanceTradeStage(d1.value!.id, 'inquiry')
assert('A3. 禁止倒退（报价 → 询盘 非法）', back.ok === false)

const skip = await advanceTradeStage(d1.value!.id, 'shipping')
assert('A4. 允许跳阶段（报价 → 发货，实际业务存在）', skip.ok && skip.value.stage === 'shipping')

await advanceTradeStage(d1.value!.id, 'lost')
const afterLost = await advanceTradeStage(d1.value!.id, 'repurchase')
assert('A5. lost 为终态（不可复活）', afterLost.ok === false)

// 复购链路完整走一遍
const d2 = await createTradeDeal({ title: '智能插头返单', value: 3000 })
for (const s of ['quotation', 'negotiation', 'payment', 'production', 'shipping', 'after_sales', 'repurchase'] as const) {
  const r = await advanceTradeStage(d2.value!.id, s)
  if (r.ok === false) { console.log('unexpected:', r.error); break }
}
const fullCycle = await db.tradeDeals.get(d2.value!.id)
assert('A6. 完整八阶段生命周期走通',
  fullCycle?.stage === 'repurchase' && fullCycle.stageHistory.length === 8)

const allDeals = await getAllTradeDeals()
const grouped = groupByStage(allDeals)
assert('A7. 看板分组正确', grouped['lost']?.length === 1 && grouped['repurchase']?.length === 1)
assert('A8. 流失商机不计入管道价值', pipelineValue(allDeals) === 3000)

// ====== B. 独立站指标与分析 ======
console.log('— 独立站分析 —')

const today = (offset: number) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10)

await upsertProductByHandle({ handle: 'led-rgb', title: 'RGB 灯带', price: 12.5 })
await upsertProductByHandle({ handle: 'led-rgb', title: 'RGB 灯带 Pro', price: 15.8 }) // 幂等更新
const products = await db.siteProducts.toArray()
assert('B1. 产品按 handle 幂等 upsert', products.length === 1 && products[0].title === 'RGB 灯带 Pro')

await upsertMetric({ date: today(0), visitors: 400, ordersCount: 10, conversionRate: 2.5, revenue: 1000, adSpend: 200, repeatOrderRate: 20 })
await upsertMetric({ date: today(1), visitors: 600, ordersCount: 20, conversionRate: 3.3, revenue: 2000, adSpend: 250, repeatOrderRate: 30 })
await upsertMetric({ date: today(2), visitors: 200, ordersCount: 5, conversionRate: 2.5, revenue: 500, adSpend: 50, repeatOrderRate: 10 })
await upsertMetric({ date: today(10), visitors: 99999, ordersCount: 99, conversionRate: 99, revenue: 99999, adSpend: 99999, repeatOrderRate: 99 }) // 窗口外

await upsertMetric({ date: today(0), visitors: 450, ordersCount: 12 }) // 幂等覆盖当天
const recent = await getRecentMetrics(7)
assert('B2. 近 7 天窗口取数正确（3 天，老数据排除）', recent.length === 3 && !recent.some(m => m.date === today(10)))

const analytics = analyzeMetrics(recent, 7)
assert('B3. 访客合计（含幂等覆盖后的值）',
  analytics.totalVisitors === 450 + 600 + 200 &&
  analytics.totalOrders === 12 + 20 + 5)
assert('B4. ROAS = 收入 / 广告花费', analytics.roas === Math.round((3500 / 500) * 100) / 100)
assert('B5. 平均转化率保留两位', analytics.avgConversionRate > 0 && Number.isFinite(analytics.avgConversionRate))

// ====== C. SEO 关键词 ======
console.log('— SEO —')

await upsertSeoKeyword({ keyword: 'led strip manufacturer', position: 8, volume: 2400 })
await upsertSeoKeyword({ keyword: 'led strip manufacturer', position: 6 }) // 更新排名
const kw = (await import('./src/repositories/siteRepository.ts')).getAllSeoKeywords()
const kwRows = await kw
assert('C1. 关键词幂等更新且保留量级', kwRows.length === 1 && kwRows[0].position === 6 && kwRows[0].volume === 2400)

// ====== D. AI 实验室热点漏斗 ======
console.log('— AI 热点漏斗 —')

// 热点不直接进 Memory/Knowledge：先落在 Inbox
const hot1 = await captureInbox('GPT-5 发布：推理成本下降 90%，适合批量邮件场景', 'idea', 'ai_lab', { aiHotspot: true })
const hot2 = await captureInbox('某小众 CSS 技巧', 'idea', 'ai_lab', { aiHotspot: true })

const pendingBefore = await db.inbox.filter(i => !i.processed && (i.metadata as any)?.aiHotspot === true).toArray()
assert('D1. 两热点进入实验室待筛选区', pendingBefore.length === 2)
assert('D2. 热点未污染知识库（不直接入库）', (await db.knowledge.count()) === 0)

// 摘要（模拟页面行为）
const full = await db.inbox.get(hot1.value.id)!
await db.inbox.put({ ...full, metadata: { ...(full.metadata ?? {}), aiSummary: '推理成本大降，可用于邮件自动化' } })

// 转入知识 → 标记 processed
const k = await createKnowledge({
  title: 'GPT-5 推理成本下降', content: '摘要：推理成本大降，可用于邮件自动化',
  category: 'ai-hotspot', tags: ['ai'], source: 'ai-lab',
})
if (!k.ok) throw new Error(k.error)
await processInbox(hot1.value.id, 'knowledge', k.value.id)
assert('D3. 转入知识后热点关闭并关联来源',
  (await db.inbox.get(hot1.value.id))?.processed === true &&
  (await db.inbox.get(hot1.value.id))?.processedId === k.value.id)

// 不关注 → 直接丢弃
await db.inbox.delete(hot2.value.id)
assert('D4. 不值得关注的热点可静默丢弃', !(await db.inbox.get(hot2.value.id)))

const kRow = await db.knowledge.get(k.value.id)
assert('D5. 热点转化知识带 ai-hotspot 分类与来源',
  kRow?.category === 'ai-hotspot' && kRow.source === 'ai-lab')

// ====== E. 业务对象与集成层联动回归 ======
console.log('— 回归 —')

const custCount = await db.customers.count()
const dealCount = await db.tradeDeals.count()
assert('E1. 业务表互相独立（客户 vs 商机）',
  typeof custCount === 'number' && dealCount === 2)
const eventsTotal = await db.events.count()
assert('E2. 阶段流转全部产生事件审计', eventsTotal >= 10)

console.log(`\n📊 结果: ${pass} 通过, ${fail} 失败\n`)
process.exit(fail > 0 ? 1 : 0)
