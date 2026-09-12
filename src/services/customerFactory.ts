// ====== 统一客户创建/确保入口 ======
import { db } from '../db'
import type { Customer } from '../types'
import { uid, now } from '../repositories/result'
import { extractAmount } from '../utils/emailHelpers'
import { EVENTS, emitEvent } from '../utils/emailHelpers'

// 确保客户存在，不存在则创建
export async function ensureCustomer(emailRaw: string, nameRaw: string): Promise<Customer> {
  const addr = (emailRaw.match(/<(.+?)>/)?.[1] || emailRaw).trim().toLowerCase()
  // 查找已有客户
  let c = await db.customers.filter((cc: any) => (cc.email || '').toLowerCase() === addr).first() as any
  if (c) return c
  // 创建新客户
  const rec: any = {
    id: uid(),
    type: 'customer',
    title: nameRaw.split('<')[0].trim() || addr.split('@')[0],
    description: '',
    emoji: '👤',
    tags: ['邮件'],
    createdAt: now(),
    updatedAt: now(),
    relations: [],
    company: '',
    email: addr,
    stage: 'lead',
    isKey: false,
    level: 'C',
    followUpAt: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10),
  }
  await db.customers.put(rec)
  emitEvent(EVENTS.CUSTOMERS_UPDATED, { id: rec.id, action: 'created' })
  return rec
}

// 根据邮件统计自动分级
export async function autoClassifyCustomer(c: Customer, emailCount: number, totalAmount: number): Promise<{ level: Customer['level']; isKey: boolean }> {
  let level: Customer['level'] = 'C'
  let isKey = c.isKey || false

  // 金额分级
  if (totalAmount >= 50000) { level = 'A+'; isKey = true }
  else if (totalAmount >= 20000) { level = 'A'; isKey = true }
  else if (totalAmount >= 5000) { level = 'B' }
  else if (totalAmount >= 1000) { level = 'C' }
  else { level = 'D' }

  // 互动加分
  if (emailCount >= 20 && level === 'C') level = 'B'
  if (emailCount >= 50 && level === 'B') level = 'A'

  return { level, isKey }
}

// 基于邮件意图自动推进客户阶段
export function advanceStage(currentStage: Customer['stage'], intent: string): Customer['stage'] {
  const stageFlow: Record<string, Customer['stage']> = {
    lead: 'contacted',
    contacted: 'qualified',
    qualified: 'proposal',
    proposal: 'negotiation',
  }
  // 高意向意图推进阶段
  const advancingIntents = ['新询价', '询问价格', '报价回复', '复购']
  if (advancingIntents.includes(intent) && stageFlow[currentStage]) {
    return stageFlow[currentStage]
  }
  // 成交意图
  if (intent === '确认订单') return 'won'
  return currentStage
}

// 计算客户邮件统计
export async function getCustomerEmailStats(customerEmail: string) {
  const allEmails = await db.emails.toArray()
  const addr = customerEmail.toLowerCase()
  const matched = allEmails.filter(e => {
    const from = (e.from || '').toLowerCase()
    const to = (e.to || '').toLowerCase()
    return from.includes(addr) || to.includes(addr)
  })
  const total = matched.length
  const sent = matched.filter(e => e.folder === 'sent').length
  const received = matched.filter(e => e.folder === 'inbox').length
  const unread = matched.filter(e => e.folder === 'inbox' && !e.isRead).length
  let totalAmount = 0
  for (const e of matched) {
    totalAmount += extractAmount(e.text || '')
  }
  const lastEmail = matched.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0]
  return { total, sent, received, unread, totalAmount, lastEmailDate: lastEmail?.date }
}

// 批量分析所有客户
export async function batchAnalyzeAll(): Promise<void> {
  const customers = await db.customers.toArray() as Customer[]
  for (const c of customers) {
    if (!c.email) continue
    const stats = await getCustomerEmailStats(c.email)
    const classified = await autoClassifyCustomer(c, stats.total, stats.totalAmount)
    await db.customers.update(c.id, {
      level: classified.level,
      isKey: classified.isKey,
      lastContactAt: stats.lastEmailDate,
      updatedAt: now(),
    } as any)
  }
  emitEvent(EVENTS.CUSTOMERS_UPDATED, { action: 'batch_analyzed' })
}
