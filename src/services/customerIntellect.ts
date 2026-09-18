// L1 客户智能分类（规则引擎，无 LLM）
// 输出：高意向 / 跟进中 / 待成交 / 复购 / 营销机会 / 沉寂
import type { Customer, EmailMessage } from '../types'

export type IntellectTier = 'high' | 'follow' | 'pending' | 'repurchase' | 'marketing' | 'dormant' | 'active'

export type IntellectResult = {
  customerId: string
  tier: IntellectTier
  reason: string
  daysSilent: number
  emailCount: number
}

function extractAddr(raw: string){
  return String(raw||'').match(/<([^<>@\s]+@[^<>\s]+)>/)?.[1] || String(raw||'').match(/([^\s<>,;]+@[^\s<>,;]+)/)?.[1] || ''
}

function customerEmails(c: Customer){
  const set = new Set<string>()
  if(c.email) set.add(String(c.email).toLowerCase().trim())
  for(const e of (c.extraEmails || [])) if(e) set.add(String(e).toLowerCase().trim())
  return [...set].filter(Boolean)
}

function lastContactAt(c: Customer, byEmail: Map<string, string>){
  let last = c.updatedAt || ''
  for(const a of customerEmails(c)){
    const d = byEmail.get(a)
    if(d && (!last || d > last)) last = d
  }
  return last
}

function daysBetween(iso: string){
  if(!iso) return 9999
  const t = new Date(iso).getTime()
  if(!Number.isFinite(t)) return 9999
  return Math.floor((Date.now() - t) / 86400000)
}

const INTENT_HOT = ['新询价','报价回复','询问价格','催货','复购']

/** 构建邮箱→最近邮件日期 */
export function buildEmailIndex(emails: EmailMessage[]){
  const byEmail = new Map<string, string>()
  for(const e of emails){
    const addr = (extractAddr(e.from) || extractAddr(e.to||'')).toLowerCase()
    if(!addr) continue
    const cur = byEmail.get(addr)
    if(!cur || e.date > cur) byEmail.set(addr, e.date)
  }
  return byEmail
}

/** 单客户 L1 分类（营销机会：超 30 天未联系，且非高意向/待成交/序列中） */
export function classifyOne(
  c: Customer,
  byEmail: Map<string, string>,
  opts?: { inAutoSeq?: boolean; hasFollowUpPending?: boolean }
): IntellectResult {
  const emails = customerEmails(c)
  const last = lastContactAt(c, byEmail)
  const days = daysBetween(last)
  const emailCount = emails.length ? (emails as any)._n || 0 : 0
  const level = c.level || 'C'
  const stage = c.stage || 'lead'
  const isKey = !!c.isKey
  const repurchaseCount = c.repurchaseCount || 0
  const intent = String((c as any).lastIntent || '')
  const inSeq = !!opts?.inAutoSeq

  // 待成交
  if(stage === 'proposal' || stage === 'negotiation'){
    return { customerId: c.id, tier: 'pending', reason: '报价/谈判阶段', daysSilent: days, emailCount }
  }
  // 高意向：重点高等级 或 热意图且近 14 天有往来
  if((isKey && (level === 'A+' || level === 'A')) ||
     (INTENT_HOT.includes(intent) && days <= 14) ||
     (stage === 'qualified' && days <= 7)){
    return { customerId: c.id, tier: 'high', reason: isKey&&level.startsWith('A') ? `重点${level}` : '近期热意图/已资格化', daysSilent: days, emailCount }
  }
  // 复购（与 syncTiersFromRules 对齐：已下单/有复购次数 + 静默 30–400 天）
  const hasOrderTag = (c.tags||[]).map(String).includes('已下单')
  if((repurchaseCount >= 1 || hasOrderTag) && days >= 30 && days <= 400){
    return { customerId: c.id, tier: 'repurchase', reason: hasOrderTag||repurchaseCount>=1 ? `已下单/复购${repurchaseCount||''}·静默${days}天` : `静默${days}天`, daysSilent: days, emailCount }
  }
  // 跟进中：有未完成跟进或自动序列
  if(inSeq || opts?.hasFollowUpPending || (days <= 30 && stage !== 'won' && stage !== 'lost')){
    return { customerId: c.id, tier: 'follow', reason: inSeq ? '自动序列中' : (days<=30 ? `近${days}天有往来` : '有待跟进'), daysSilent: days, emailCount }
  }
  // 沉寂/流失
  if(stage === 'lost' || days > 180){
    return { customerId: c.id, tier: 'dormant', reason: stage==='lost' ? '已流失' : `静默${days}天`, daysSilent: days, emailCount }
  }
  // 营销机会：>30 天未联系（且非高意向/待成交/序列）
  if(days > 30){
    return { customerId: c.id, tier: 'marketing', reason: `${days}天未联系`, daysSilent: days, emailCount }
  }
  return { customerId: c.id, tier: 'active', reason: `近${days}天活跃`, daysSilent: days, emailCount }
}

/** 批量 L1；写回 customer.aiTier / aiReason / aiCheckedAt */
export async function runIntellectBatch(
  customers: Customer[],
  emails: EmailMessage[],
  opts?: { autoSeqCustomerIds?: Set<string>; pendingFuCustomerIds?: Set<string> }
): Promise<IntellectResult[]> {
  const byEmail = buildEmailIndex(emails)
  const results: IntellectResult[] = []
  const ts = new Date().toISOString()
  for(const c of customers){
    const r = classifyOne(c, byEmail, {
      inAutoSeq: opts?.autoSeqCustomerIds?.has(c.id),
      hasFollowUpPending: opts?.pendingFuCustomerIds?.has(c.id),
    })
    results.push(r)
    try{
      const { db } = await import('../db')
      await db.customers.update(c.id, {
        aiTier: r.tier,
        aiReason: r.reason,
        aiCheckedAt: ts,
      } as any)
    }catch{}
  }
  return results
}

export function countTiers(results: IntellectResult[]){
  const m: Record<string, number> = { high:0, follow:0, pending:0, repurchase:0, marketing:0, dormant:0, active:0 }
  for(const r of results) m[r.tier] = (m[r.tier]||0)+1
  return m
}

/** 批量发送限速配置 */
export const BATCH_SEND = {
  intervalMs: 5000,
  dailyLimit: 500,
}
export function getTodaySendCount(){
  const key = `evan:batchSendCount:${new Date().toISOString().slice(0,10)}`
  return Number(localStorage.getItem(key) || 0)
}
export function bumpTodaySendCount(n = 1){
  const key = `evan:batchSendCount:${new Date().toISOString().slice(0,10)}`
  localStorage.setItem(key, String(getTodaySendCount() + n))
}
