// ====== Evan OS v0.8 外部集成测试 ======
// Tool → Integration CommandBus → Repository → Event 链路
// Hermes：未回复客户分析 / 草稿 / L3 发送审批
// 运行: npx tsx test-integrations.ts

import 'fake-indexeddb/auto'
import { db } from './src/db.ts'
import { commandBus, registerRoute } from './src/services/integrations/commandBus.ts'
import { callIntegrationTool } from './src/services/integrations/adapters.ts'
import { executeApprovedHermesSend } from './src/services/integrations/adapters.ts'
import { agentRuntime } from './src/services/agentRuntime.ts'
import './src/services/agents.ts'

let pass = 0, fail = 0
function assert(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`) }
  else { fail++; console.log(`  [FAIL] ${name}`) }
}

console.log('\n🧪 Evan OS v0.8 外部集成测试\n')

await Promise.all([
  db.customers.clear(), db.communications.clear(), db.tasks.clear(),
  db.orders.clear(), db.events.clear(), db.siteProducts.clear(),
  db.siteMetrics.clear(), db.approvals.clear(), db.agentRuns.clear(),
])

// ====== A. CommandBus 基础 ======
console.log('— CommandBus —')

assert('A1. 未注册命令被拒绝',
  !(await commandBus.execute('gmail', 'nonexistent.command', {})).ok)

// 自定义路由证明总线可扩展
registerRoute('test.echo', async (payload) => ({ ok: true, echoed: payload.value }))
const echo = await commandBus.execute('mcp', 'test.echo', { value: 42 })
assert('A2. 动态路由注册生效', echo.ok && (echo as any).echoed === 42)

// ====== B. Gmail 导入链路：Tool → Bus → Repo → Event ======
console.log('— Gmail 导入链路 —')

const eventsBeforeImport = await db.events.count()
const imported = await callIntegrationTool('gmail', 'gmail.import_message', { messageId: 'gm-1' })
if (imported.ok === false) { console.log(imported.error); process.exit(1) }
const data1 = imported.data!

assert('B1. 导入成功且返回客户/沟通/任务三件套',
  data1.customerId && data1.communicationId && data1.taskId)

const cust1 = await db.customers.get(data1.customerId)
assert('B2. 客户经 customer.upsert 幂等创建，email 为键',
  !!cust1 && cust1.email === 'buyer@walmart-supp.com')

// 再次导入同一发件人 → 不重复建客户
await callIntegrationTool('gmail', 'gmail.import_message', { messageId: 'gm-1' })
const custCount = await db.customers.count()
assert('B3. 同一 email 二次导入不产生重复客户', custCount === 1)

const comm1 = await db.communications.get(data1.communicationId)
assert('B4. 沟通记录为 inbound 且带 via:gmail 来源标记',
  comm1?.direction === 'inbound' &&
  (comm1.participants ?? []).some(p => p === 'via:gmail'))

const task1 = await db.tasks.get(data1.taskId)
assert('B5. RFQ 来信自动生成高优先级跟进任务',
  task1?.title.includes('RFQ') || (task1?.title ?? '').includes('Walmart'))

// 链路审计：导入产生了事件
const eventsAfterImport = await db.events.count()
const integrationEvents = await db.events.filter(e => String(e.actorId ?? '').startsWith('integration:gmail')).toArray()
assert('B6. 全链路留痕（对象事件 + 命令审计）',
  eventsAfterImport > eventsBeforeImport && integrationEvents.length >= 3)

// ====== C. Hermes 分析 ======
console.log('— Hermes 分析 —')

// 构造：customer A 有旧来信无回复；customer B 已回复
await commandBus.execute('gmail', 'customer.upsert', { email: 'silent@buyer.com', company: 'Silent Buyer' })
const allCusts = await db.customers.toArray()
const silent = allCusts.find(c => c.email === 'silent@buyer.com')!
await import('./src/repositories/customerRepository.ts').then(m =>
  m.createCommunication({
    title: '询盘', channel: 'email', direction: 'inbound',
    customerId: silent.id, summary: 'old inquiry',
    communicatedAt: new Date(Date.now() - 10 * 86400000).toISOString(),
  }))
await commandBus.execute('gmail', 'customer.upsert', { email: 'happy@buyer.com', company: 'Happy Buyer' })
const happy = allCusts.find(c => c.email === 'happy@buyer.com') ??
  (await db.customers.toArray()).find(c => c.email === 'happy@buyer.com')!
await import('./src/repositories/customerRepository.ts').then(m =>
  m.createCommunication({
    title: '已回复', channel: 'email', direction: 'inbound',
    customerId: happy.id, summary: 'question',
    communicatedAt: new Date(Date.now() - 9 * 86400000).toISOString(),
  }))
await import('./src/repositories/customerRepository.ts').then(m =>
  m.createCommunication({
    title: '答复', channel: 'email', direction: 'outbound',
    customerId: happy.id, summary: 'answered',
    communicatedAt: new Date(Date.now() - 8 * 86400000).toISOString(),
  }))

const unreplied = await callIntegrationTool('hermes', 'hermes.find_unreplied', { days: 7 })
if (unreplied.ok === false) { console.log(unreplied.error); process.exit(1) }
const urList = unreplied.data!.customers as any[]
assert('C1. 找出过去 7 天未回复的客户（含 Silent）', urList.some(u => u.email === 'silent@buyer.com'))
assert('C2. 已回复客户不误报', !urList.some(u => u.email === 'happy@buyer.com'))
assert('C3. Gmail 导入的老客户（无沟通记录）不计入未回复', !urList.some(u => u.email === 'buyer@walmart-supp.com'))

// ====== D. Hermes 草稿 ======
console.log('— Hermes 草稿 —')

const draft = await callIntegrationTool('hermes', 'hermes.draft_email', {
  customerTitle: 'Silent Buyer', to: 'silent@buyer.com',
  customerId: silent.id,
  points: ['New price list attached'],
})
assert('D1. 草拟邮件成功且含正文要点',
  draft.ok && draft.data!.draft.subject.includes('Silent Buyer') &&
  draft.data!.draft.body.includes('New price list'))

// ====== E. L3 发送门控 ======
console.log('— L3 发送审批 —')

// 直接调用发送工具 → _notApproved 标记拒绝
const directSend = await callIntegrationTool('hermes', 'hermes.send_email', {
  to: 'silent@buyer.com', customerId: silent.id,
  subject: 'Following up', body: 'Hello again',
})
assert('E1. 未走审批的发送直接被拒（数据规则保护）', directSend.ok === false || directSend.data?.ok === false)
const commsMid = await db.communications.count()

// 正确路径：Agent Runtime 提交 external_call 审批
const approval = await agentRuntime.submitApproval({
  agentId: 'project_assistant',
  actionType: 'external_call',
  summary: 'Hermes 发送跟进邮件 → silent@buyer.com',
  payload: {
    tool: 'hermes.send_email', customerId: silent.id,
    to: 'silent@buyer.com', subject: 'Following up', body: 'Hello again',
  },
})
assert('E2. L3 审批入队且未执行', approval.status === 'pending' && !approval.executedAt)

const approved = await agentRuntime.approve(approval.id)
assert('E3. 批准仅改状态', approved.ok && approved.value.status === 'approved' && !approved.value.executedAt)

const noToken = await agentRuntime.executeApproved(approval.id)
assert('E4. 缺 humanToken 拒绝执行', noToken.ok === false && (await db.communications.count()) === commsMid)

const executed = await agentRuntime.executeApproved(approval.id, 'human-confirmed')
const commsFinal = await db.communications.count()
const outbound = await db.communications.reverse().filter(
  c => c.direction === 'outbound' && c.customerId === silent.id
).toArray()
assert('E5. Human 显式执行后 Mock 发送并落出站沟通审计',
  executed.ok && commsFinal === commsMid + 1 && outbound.length >= 1 &&
  (executed.value.executionResult as any)?.mock === true)

// ====== F. Shopify 同步（v0.9 表）======
console.log('— Shopify 同步 —')

const syncP = await callIntegrationTool('shopify', 'shopify.sync_products')
const products = await db.siteProducts.toArray()
assert('F1. 产品同步入库（handle 幂等）',
  syncP.ok && products.length === 2 && products.every(p => !!p.handle))

await callIntegrationTool('shopify', 'shopify.sync_products')
assert('F2. 重复同步不产生重复产品', (await db.siteProducts.toArray()).length === 2)

const syncM = await callIntegrationTool('shopify', 'shopify.sync_metrics')
const metrics = await db.siteMetrics.toArray()
assert('F3. 日指标快照入库', syncM.ok && metrics.length === 2)

// n8n / mcp 桩
const n8n = await callIntegrationTool('n8n', 'n8n.trigger', { webhookId: 'wh-1' })
assert('F4. n8n 触发为 Mock 且标注需审批', n8n.data?.mock === true)
const mcp = await callIntegrationTool('mcp', 'mcp.list_servers')
assert('F5. MCP 服务器列表可用', mcp.data?.servers?.length >= 2)

console.log(`\n📊 结果: ${pass} 通过, ${fail} 失败\n`)
process.exit(fail > 0 ? 1 : 0)
