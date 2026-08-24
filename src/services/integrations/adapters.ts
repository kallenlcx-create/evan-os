// ====== Integration Adapters ======
// 每个外部系统一个适配器。适配器只做两件事：
//   1. 把外部数据/能力翻译成 CommandBus 命令
//   2. 描述自己暴露的工具（名称 + 权限等级）
// 适配器永远不直接写业务表（读接口除外），写入一律走 CommandBus。

import type { IntegrationId, IntegrationToolDescriptor } from '../../types'
import { commandBus } from './commandBus'
import { getAllCustomers, getAllCommunications } from '../../repositories/customerRepository'
import { buildVaultFiles, markdownToKnowledge } from '../vaultSync'

export interface AdapterCallContext {
  actorId?: string
}

export interface IntegrationAdapter {
  id: IntegrationId
  name: string
  emoji: string
  description: string
  tools: IntegrationToolDescriptor[]
  impls: Record<string, (args?: any, ctx?: AdapterCallContext) => Promise<any>>
}

const nowIso = () => new Date().toISOString()

// ============================================================
// Gmail - 收件导入
// ============================================================

const GMAIL_MOCK_MESSAGES = [
  { id: 'gm-1', from: 'buyer@walmart-supp.com', fromName: 'Walmart Sourcing', subject: 'RFQ for LED strips', snippet: 'Please quote 5000pcs', hasUrl: false },
  { id: 'gm-2', from: 'existing@oldclient.com', fromName: 'Old Client', subject: 'Re: Order ORD-2024-001', snippet: 'When will it ship?', hasUrl: false },
  { id: 'gm-3', from: 'newsletter@shopify.com', fromName: 'Shopify', subject: 'Your weekly report', snippet: 'See dashboard https://shopify.com', hasUrl: true },
]

const gmailAdapter: IntegrationAdapter = {
  id: 'gmail',
  name: 'Gmail',
  emoji: '📧',
  description: '收件导入：客户来信自动建沟通记录与跟进任务',
  tools: [
    { name: 'gmail.fetch_messages', level: 'L1_auto', description: '拉取最近邮件（Mock）' },
    { name: 'gmail.import_message', level: 'L1_auto', description: '导入一封邮件为客户+沟通记录' },
  ],
  impls: {
    'gmail.fetch_messages': async () => GMAIL_MOCK_MESSAGES,
    'gmail.import_message': async (args) => {
      const msg = GMAIL_MOCK_MESSAGES.find(m => m.id === (args?.messageId ?? args?.id))
      if (!msg) return { ok: false, error: 'message not found' }
      const cust = await commandBus.execute('gmail', 'customer.upsert', {
        email: msg.from, company: msg.fromName,
      })
      if (cust.ok === false) return cust
      const comm = await commandBus.execute('gmail', 'communication.log', {
        title: msg.subject,
        channel: 'email',
        direction: 'inbound',
        customerId: cust.objectId,
        summary: msg.snippet,
        participants: [msg.from],
        communicatedAt: nowIso(),
      })
      let taskId: string | undefined
      if (/^Re:|when|quote|rfq/i.test(msg.subject + ' ' + msg.snippet)) {
        const t = await commandBus.execute('gmail', 'task.create', {
          title: `回复 ${msg.fromName}：${msg.subject}`, priority: 'high',
        })
        if (t.ok) taskId = t.objectId
      }
      return { ok: true, messageId: msg.id, customerId: cust.objectId, communicationId: comm.objectId, taskId }
    },
  },
}

// ============================================================
// Hermes - 邮件外发层（Agent 的手）
// ============================================================

const hermesAdapter: IntegrationAdapter = {
  id: 'hermes',
  name: 'Hermes',
  emoji: '📨',
  description: '邮件外发：分析待跟进客户，草拟邮件，经审批后发送',
  tools: [
    { name: 'hermes.find_unreplied', level: 'L1_auto', description: '找出过去 N 天没有收到回复的客户' },
    { name: 'hermes.draft_email', level: 'L1_auto', description: '为客户草拟跟进邮件' },
    { name: 'hermes.send_email', level: 'L3_approval', description: '发送邮件（必须人工批准）' },
  ],
  impls: {
    // “找出过去 7 天没有回复的客户”：有来信、超期、且之后没有出站
    'hermes.find_unreplied': async (args) => {
      const days = Number(args?.days ?? 7)
      const cutoff = Date.now() - days * 86400000
      const customers = await getAllCustomers()
      const comms = await getAllCommunications()
      const unreplied: Array<Record<string, any>> = []
      for (const c of customers) {
        const related = comms.filter(m => m.customerId === c.id)
        const lastInbound = related
          .filter(m => m.direction === 'inbound')
          .sort((a, b) => b.communicatedAt.localeCompare(a.communicatedAt))[0]
        const lastOutbound = related
          .filter(m => m.direction === 'outbound')
          .sort((a, b) => b.communicatedAt.localeCompare(a.communicatedAt))[0]
        if (lastInbound && Date.parse(lastInbound.communicatedAt) < cutoff) {
          if (!lastOutbound || lastOutbound.communicatedAt < lastInbound.communicatedAt) {
            unreplied.push({
              customerId: c.id, customerTitle: c.title, email: c.email,
              lastInboundAt: lastInbound.communicatedAt,
              lastOutboundAt: lastOutbound?.communicatedAt,
            })
          }
        }
      }
      return { ok: true, days, count: unreplied.length, customers: unreplied }
    },

    // 草拟邮件（模板化 Mock 文案；未来由 Provider 生成）
    'hermes.draft_email': async (args) => {
      const customerTitle = args?.customerTitle ?? 'friend'
      const subject = args?.subject ?? `Following up - ${customerTitle}`
      const points = Array.isArray(args?.points) ? args.points : []
      const body =
        `Dear ${customerTitle},\n\n` +
        `Hope this email finds you well.\n\n` +
        points.map((p: string) => `- ${p}`).join('\n') +
        (points.length ? '\n\n' : '') +
        `I am following up to see if you had any questions.\n` +
        `Looking forward to hearing from you.\n\nBest regards,\nEvan`
      return { ok: true, draft: { to: args?.to, customerId: args?.customerId, subject, body } }
    },

    // L3！只能被审批执行器调用：_notApproved 标记未清除时总线拒绝
    'hermes.send_email': async (args) => {
      return commandBus.execute('hermes', 'email.send', {
        _notApproved: true, ...args,
      })
    },
  },
}

// 审批执行器专用：清除标记后真正发送（Mock 外呼 + 出站审计）
export async function executeApprovedHermesSend(args: Record<string, any>) {
  return commandBus.execute('hermes', 'email.send', { ...args })
}

// ============================================================
// Shopify - 独立站同步
// ============================================================

const SHOPIFY_MOCK_PRODUCTS = [
  { handle: 'led-strip-rgb-5m', title: 'RGB LED Strip 5m', price: 12.5, inventory: 320, vendor: 'EvanLight', tags: ['lighting'] },
  { handle: 'smart-plug-eu', title: 'Smart Plug EU', price: 8.9, inventory: 150, vendor: 'EvanHome', tags: ['smart-home'] },
]

const SHOPIFY_MOCK_METRICS = [
  { date: new Date(Date.now() - 0 * 86400000).toISOString().slice(0, 10), visitors: 420, ordersCount: 12, conversionRate: 2.86, revenue: 1580, adSpend: 210, repeatOrderRate: 18.4, seoTopKeywords: 23 },
  { date: new Date(Date.now() - 1 * 86400000).toISOString().slice(0, 10), visitors: 385, ordersCount: 9, conversionRate: 2.34, revenue: 1210, adSpend: 190, repeatOrderRate: 16.7, seoTopKeywords: 22 },
]

const shopifyAdapter: IntegrationAdapter = {
  id: 'shopify',
  name: 'Shopify',
  emoji: '🛍️',
  description: '独立站同步：产品目录与每日经营指标经命令总线入账',
  tools: [
    { name: 'shopify.sync_products', level: 'L1_auto', description: '同步产品目录（Mock）' },
    { name: 'shopify.sync_metrics', level: 'L1_auto', description: '同步流量/转化/广告日指标（Mock）' },
  ],
  impls: {
    'shopify.sync_products': async () => {
      const results = []
      for (const p of SHOPIFY_MOCK_PRODUCTS) {
        results.push(await commandBus.execute('shopify', 'product.upsert', p))
      }
      return { ok: results.every(r => r.ok), synced: results.length, results }
    },
    'shopify.sync_metrics': async () => {
      const results = []
      for (const m of SHOPIFY_MOCK_METRICS) {
        results.push(await commandBus.execute('shopify', 'metric.record', { ...m, source: 'shopify' }))
      }
      return { ok: results.every(r => r.ok), synced: results.length }
    },
  },
}

// ============================================================
// Calendar / n8n / MCP — 描述就绪的桩适配器
// ============================================================

const calendarAdapter: IntegrationAdapter = {
  id: 'calendar',
  name: 'Calendar',
  emoji: '📅',
  description: '日程桥接（桩）：未来把会议同步为跟进沟通',
  tools: [{ name: 'calendar.upcoming', level: 'L1_auto', description: '读取近期日程（Mock）' }],
  impls: {
    'calendar.upcoming': async () => ({
      ok: true, events: [
        { title: '客户视频会议', start: nowIso(), attendeeEmail: 'buyer@walmart-supp.com' },
      ],
    }),
  },
}

const n8nAdapter: IntegrationAdapter = {
  id: 'n8n',
  name: 'n8n',
  emoji: '🕸️',
  description: '自动化桥（桩）：触发外部 n8n 工作流，回传结果走命令总线',
  tools: [{ name: 'n8n.trigger', level: 'L3_approval', description: '触发外部工作流（高风险，需审批）' }],
  impls: {
    'n8n.trigger': async (args) => ({
      ok: true, mock: true, webhookId: args?.webhookId ?? null,
      note: 'external trigger mocked; requires approval flow',
    }),
  },
}

const mcpAdapter: IntegrationAdapter = {
  id: 'mcp',
  name: 'MCP',
  emoji: '🔌',
  description: 'MCP 桥（桩）：列出可挂载的外部工具服务器',
  tools: [{ name: 'mcp.list_servers', level: 'L1_auto', description: '列出 MCP 服务器（Mock）' }],
  impls: {
    'mcp.list_servers': async () => ({
      ok: true,
      servers: [
        { name: 'evan-fs', transport: 'stdio', status: 'ready' },
        { name: 'web-search', transport: 'sse', status: 'ready' },
      ],
    }),
  },
}

// ============================================================
// 📓 Obsidian — Markdown Vault 双向同步（本地文件夹即数据库）
// ============================================================

const obsidianAdapter: IntegrationAdapter = {
  id: 'obsidian',
  name: 'Obsidian',
  emoji: '📓',
  description: '知识库 ↔ Markdown Vault：frontmatter + wikilink 双向同步',
  tools: [
    { name: 'obsidian.build_vault', level: 'L1_auto', description: '把知识库构建为 Obsidian 笔记集' },
    { name: 'obsidian.import_note', level: 'L1_auto', description: '导入一篇 Obsidian 笔记（id 幂等）' },
    { name: 'obsidian.count_notes', level: 'L1_auto', description: '统计当前知识条目数' },
  ],
  impls: {
    'obsidian.build_vault': async () => {
      const files = await buildVaultFiles()
      return { ok: true, files }
    },
    'obsidian.import_note': async (args) => {
      const parsed = markdownToKnowledge(String(args?.content ?? ''))
      if (!parsed) return { ok: false, error: '不是有效的 Evan OS/Obsidian 笔记格式' }
      const r = await commandBus.execute('obsidian', 'knowledge.upsert', {
        id: parsed.id,
        title: parsed.title,
        content: parsed.body,
        tags: parsed.tags,
        category: parsed.category,
        source: 'obsidian',
      })
      return r
    },
    'obsidian.count_notes': async () => {
      const files = await buildVaultFiles()
      return { ok: true, count: files.length }
    },
  },
}

// ============================================================
// 注册表
// ============================================================

export const INTEGRATIONS: IntegrationAdapter[] = [
  gmailAdapter,
  hermesAdapter,
  shopifyAdapter,
  obsidianAdapter,
  calendarAdapter,
  n8nAdapter,
  mcpAdapter,
]

export function getIntegration(id: IntegrationId): IntegrationAdapter | undefined {
  return INTEGRATIONS.find(a => a.id === id)
}

/** 统一调用入口：校验工具存在后执行 */
export async function callIntegrationTool(
  integration: IntegrationId,
  toolName: string,
  args?: any,
  ctx?: AdapterCallContext
): Promise<{ ok: boolean; data?: any; error?: string }> {
  const adapter = getIntegration(integration)
  if (!adapter) return { ok: false, error: `未知集成: ${integration}` }
  const impl = adapter.impls[toolName]
  if (!impl) return { ok: false, error: `${integration} 未实现工具: ${toolName}` }
  try {
    return { ok: true, data: await impl(args, ctx) }
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 300) }
  }
}
