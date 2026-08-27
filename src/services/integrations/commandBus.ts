// ====== Integration Layer ======
// 铁律：外部系统永远不直接修改业务数据。
//   Gmail Tool → CommandBus → Command → Repository → Event
// 所有外部数据遵守 Evan OS 数据规则（统一对象模型 + 事件审计）。

import { db } from '../../db'
import type {
  IntegrationId, IntegrationCommand, IntegrationCommandResult,
} from '../../types'
import { uid, now } from '../../repositories/result'
import {
  createCommunication, createCustomer, createOrder, getAllCustomers,
} from '../../repositories/customerRepository'
import { createKnowledge } from '../../repositories/knowledgeRepository'
import { createTask } from '../../repositories/taskRepository'
import type { Customer } from '../../types'

// ====== 命令路由 ======

type RouteHandler = (payload: Record<string, any>, cmd: IntegrationCommand) => Promise<IntegrationCommandResult>

const routes = new Map<string, RouteHandler>()

function route(type: string, handler: RouteHandler) {
  routes.set(type, handler)
}

// customer.upsert —— 以 email 为幂等键
route('customer.upsert', async (payload) => {
  const email = String(payload.email ?? '').toLowerCase().trim()
  if (!email && !payload.company) return { ok: false, error: '需要 email 或 company' }
  let existing: Customer | undefined
  if (email) {
    const all = await getAllCustomers()
    existing = all.find(c => String(c.email ?? '').toLowerCase() === email)
  }
  if (existing) {
    await db.customers.update(existing.id, {
      company: payload.company ?? existing.company,
      contactName: payload.contactName ?? existing.contactName,
      country: payload.country ?? existing.country,
      updatedAt: now(),
    })
    return { ok: true, objectType: 'customer', objectId: existing.id, updated: true }
  }
  const r = await createCustomer({
    title: payload.company ?? payload.contactName ?? email,
    email: email || undefined,
    company: payload.company,
    contactName: payload.contactName,
    country: payload.country,
    stage: payload.stage ?? 'lead',
    notes: payload.notes,
  })
  if (r.ok === false) return { ok: false, error: r.error }
  return { ok: true, objectType: 'customer', objectId: r.value.id }
})

// communication.log —— 外部消息 → 沟通记录（含集成来源元数据）
route('communication.log', async (payload, cmd) => {
  const r = await createCommunication({
    title: payload.title ?? `来自 ${cmd.integration}`,
    channel: payload.channel ?? 'email',
    direction: payload.direction ?? 'inbound',
    customerId: payload.customerId,
    summary: payload.summary ?? '',
    communicatedAt: payload.communicatedAt ?? now(),
  })
  if (r.ok === false) return { ok: false, error: r.error }
  // 来源追溯写入 participants 标记（不污染核心字段）
  await db.communications.update(r.value.id, {
    participants: [...(payload.participants ?? []), `via:${cmd.integration}`],
  })
  return { ok: true, objectType: 'communication', objectId: r.value.id }
})

// knowledge.upsert —— 以 id 为幂等键（Obsidian 等外部知识源回写）
route('knowledge.upsert', async (payload) => {
  if (!payload.id && !payload.title) return { ok: false, error: '需要 id 或 title' }
  const existing = payload.id ? await db.knowledge.get(payload.id) : undefined
  if (existing) {
    await db.knowledge.put({
      ...existing,
      title: payload.title ?? existing.title,
      content: payload.content ?? existing.content,
      tags: payload.tags ?? existing.tags,
      category: payload.category ?? existing.category,
      updatedAt: now(),
    })
    return { ok: true, objectType: 'knowledge', objectId: existing.id, updated: true }
  }
  const r = await createKnowledge({
    id: payload.id,
    title: payload.title ?? '未命名',
    content: payload.content ?? '',
    category: payload.category ?? 'general',
    tags: payload.tags ?? [],
    description: payload.description,
    source: payload.source ?? 'obsidian',
  })
  if (r.ok === false) return { ok: false, error: r.error }
  return { ok: true, objectType: 'knowledge', objectId: r.value.id }
})

// task.create
route('task.create', async (payload) => {
  const r = await createTask({ title: payload.title, priority: payload.priority })
  if (r.ok === false) return { ok: false, error: r.error }
  return { ok: true, objectType: 'task', objectId: r.value.id }
})

// order.upsert —— 以 orderNumber 为幂等键
route('order.upsert', async (payload) => {
  const orderNumber = payload.orderNumber
  if (!orderNumber) return { ok: false, error: '需要 orderNumber' }
  const all = await db.orders.toArray()
  const existing = all.find(o => o.orderNumber === orderNumber)
  if (existing) {
    await db.orders.update(existing.id, {
      status: payload.status ?? existing.status,
      amount: payload.amount ?? existing.amount,
      updatedAt: now(),
    })
    return { ok: true, objectType: 'order', objectId: existing.id, updated: true }
  }
  const r = await createOrder({
    title: payload.title ?? `订单 ${orderNumber}`,
    orderNumber,
    status: payload.status ?? 'confirmed',
    amount: payload.amount,
    currency: payload.currency,
    customerId: payload.customerId,
  })
  if (r.ok === false) return { ok: false, error: r.error }
  return { ok: true, objectType: 'order', objectId: r.value.id }
})

// product.upsert —— 独立站产品（handle 幂等）
route('product.upsert', async (payload) => {
  const handle = payload.handle
  if (!handle) return { ok: false, error: '需要 handle' }
  const existing = await db.siteProducts.where('handle').equals(handle).first()
  const ts = now()
  if (existing) {
    await db.siteProducts.put({ ...existing, ...payload, id: existing.id, updatedAt: ts })
    return { ok: true, objectType: 'siteProduct' as never, objectId: existing.id, updated: true }
  }
  const product = {
    id: uid(), handle,
    title: payload.title ?? handle,
    status: payload.status ?? 'active',
    price: payload.price, currency: payload.currency ?? 'USD',
    inventory: payload.inventory, vendor: payload.vendor,
    tags: payload.tags ?? [], updatedAt: ts,
  }
  await db.siteProducts.add(product)
  return { ok: true, objectId: product.id }
})

// metric.record —— 站点日指标快照（date 幂等）
route('metric.record', async (payload) => {
  const date = payload.date
  if (!date) return { ok: false, error: '需要 date' }
  const existing = await db.siteMetrics.get(date)
  if (existing) {
    await db.siteMetrics.put({ ...existing, ...payload, id: date })
    return { ok: true, objectId: date, updated: true }
  }
  await db.siteMetrics.add({
    id: date, date,
    visitors: payload.visitors ?? 0,
    ordersCount: payload.ordersCount ?? 0,
    conversionRate: payload.conversionRate ?? 0,
    revenue: payload.revenue, currency: payload.currency ?? 'USD',
    adSpend: payload.adSpend, repeatOrderRate: payload.repeatOrderRate,
    seoTopKeywords: payload.seoTopKeywords,
    source: payload.source ?? 'shopify',
    createdAt: now(),
  })
  return { ok: true, objectId: date }
})

// email.send —— Hermes 发送（Mock）。只能由 L3 审批执行器调用。
route('email.send', async (payload, cmd) => {
  if (cmd.payload._notApproved === true) {
    return { ok: false, error: 'email.send 必须经过人工审批后才能执行' }
  }
  // Mock 外呼：记录出站沟通作为审计痕迹
  const r = await createCommunication({
    title: `已发送：${payload.subject}`,
    channel: 'email',
    direction: 'outbound',
    customerId: payload.customerId,
    summary: payload.body?.slice(0, 200) ?? '',
    communicatedAt: now(),
  })
  if (r.ok === false) return { ok: false, error: r.error }
  return { ok: true, objectType: 'communication', objectId: r.value.id, mock: true, to: payload.to }
})

// ====== CommandBus ======

export class IntegrationCommandBus {
  private auditLog: IntegrationCommand[] = []
  private static readonly MAX_AUDIT = 200

  /** 外部适配器写入业务数据的唯一入口 */
  async execute(
    integration: IntegrationId,
    type: string,
    payload: Record<string, any>,
    opts?: { skipAudit?: boolean }
  ): Promise<IntegrationCommandResult> {
    const handler = routes.get(type)
    if (!handler) return { ok: false, error: `未注册的命令: ${type}` }

    const cmd: IntegrationCommand = {
      id: uid(), integration, type,
      payload: { ...payload },
      createdAt: now(),
    }
    this.auditLog.push(cmd)
    if (this.auditLog.length > IntegrationCommandBus.MAX_AUDIT) {
      this.auditLog = this.auditLog.slice(-IntegrationCommandBus.MAX_AUDIT)
    }

    try {
      const result = await handler(payload, cmd)
      // Repository 层已产生 Event；此处补一条命令级审计（有界保留）
      if (!opts?.skipAudit) {
        await db.events.add({
          id: uid(),
          type: 'object.updated',
          actorType: 'system',
          actorId: `integration:${integration}`,
          objectType: (result.objectType ?? 'process') as never,
          objectId: result.objectId ?? cmd.id,
          payload: { integrationCommand: type, ok: result.ok },
          createdAt: now(),
        })
      }
      return result
    } catch (e) {
      return { ok: false, error: String(e).slice(0, 300) }
    }
  }

  /** 审计日志（最近 N 条） */
  getRecentCommands(n = 20): IntegrationCommand[] {
    return this.auditLog.slice(-n)
  }

  hasRoute(type: string): boolean {
    return routes.has(type)
  }
}

export const commandBus = new IntegrationCommandBus()

// 便于测试注入
export function registerRoute(type: string, handler: RouteHandler): void {
  route(type, handler)
}
