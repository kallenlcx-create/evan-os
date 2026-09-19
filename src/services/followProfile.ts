// 跟进档案：字段规则 + 回复/阶段同步 + 模板相似度 → followStep
// 与自动跟进序列互通：followMode=auto|manual 控制序列
import { db } from '../db'
import type { Customer, EmailMessage } from '../types'
import { loadIntellectConfig } from './customerDailyClassify'
import { addManualBuckets } from './manualBuckets'
import { isNoiseEmailAddress } from '../utils/emailHelpers'
import { startSequence, patchSequence, listAccounts } from '../repositories/emailRepository'
import { isOrderedCustomer } from './orderScan'

export type FollowMode = 'auto' | 'manual'
export type SalesStage = 'following' | 'ordered' | 'cancelled'

export type FollowStepTemplate = {
  n: number
  name: string
  keywords: string[]
}

export const DEFAULT_FOLLOW_STEP_TEMPLATES: FollowStepTemplate[] = [
  { n: 1, name: '报价跟进', keywords: ['quotation', 'quote', 'price', '报价', 'following up on the quotation'] },
  { n: 2, name: '顶邮/可调', keywords: ['floating', 'top of your inbox', 'adjust quantity', 'budget', '适配'] },
  { n: 3, name: '锁产/决策', keywords: ['reserve', 'production slot', 'finalize', '锁单', 'production slots'] },
  { n: 4, name: '成本/交期', keywords: ['raw material', 'lead time', 'trending up', 'locking in', '交期', '材料'] },
  { n: 5, name: '障碍确认', keywords: ['holding this back', 'timeline', 'payment terms', '设计', '付款'] },
  { n: 6, name: '最后跟进', keywords: ['last check', "don't clutter", 'come back', 'clutter your inbox'] },
  { n: 7, name: '收口', keywords: ['closing the loop', 'pick it right up', '收口', 'closing the loop on my side'] },
]

const SELF = new Set(['evan@maxemblem.com'])

function extractAddr(raw: string){
  return String(raw||'').match(/<([^<>@\s]+@[^<>\s]+)>/)?.[1]
    || String(raw||'').match(/([^\s<>,;]+@[^\s<>,;]+)/)?.[1]
    || ''
}

export function customerAddrs(c: Customer): string[] {
  return [c.email, ...(c.extraEmails||[])].filter(Boolean).map(e=> String(e).toLowerCase().trim())
}

export function daysSince(iso?: string | null): number | null {
  if(!iso) return null
  const t = new Date(iso).getTime()
  if(!Number.isFinite(t)) return null
  return Math.floor((Date.now()-t)/86400000)
}

export function salesStageOf(c: Customer): SalesStage {
  const s = String((c as any).salesStage || '')
  if (s === 'ordered' || s === 'cancelled' || s === 'following') return s
  const tags = (c.tags||[]).map(String)
  if (tags.includes('取消') || (c.stage === 'lost' && tags.includes('取消'))) return 'cancelled'
  if (isOrderedCustomer(c) || c.stage === 'won' || tags.includes('已下单')) return 'ordered'
  return 'following'
}

export function followModeOf(c: Customer): FollowMode {
  const m = String((c as any).followMode || '')
  if (m === 'auto' || m === 'manual') return m
  // 默认：已下单/取消 → 手动；其余若未设置 → 手动（需你显式标自动才进序列）
  return 'manual'
}

/** 关键词/片段相似度：覆盖 + 主题包含 */
export function matchFollowStep(subject: string, body: string, templates?: FollowStepTemplate[], threshold?: number){
  const list = templates?.length ? templates : DEFAULT_FOLLOW_STEP_TEMPLATES
  const th = threshold ?? (loadIntellectConfig().followSimThreshold || 0.6)
  const s = `${subject||''}\n${body||''}`.toLowerCase()
  if(!s.trim()) return { step: 0, score: 0, matched: '' }
  let best = { step: 0, score: 0, matched: '' }
  for(const t of list){
    const kws = (t.keywords||[]).map(k=> String(k).toLowerCase()).filter(Boolean)
    if(!kws.length) continue
    let hit = 0
    for(const k of kws) if(s.includes(k)) hit++
    const score = hit / kws.length
    const subjBoost = kws.some(k => String(subject||'').toLowerCase().includes(k)) ? 0.15 : 0
    const total = Math.min(1, score + subjBoost)
    if(total >= th && (total > best.score || (total === best.score && t.n > best.step))){
      best = { step: t.n, score: total, matched: kws.filter(k=> s.includes(k)).join(',') }
    }
  }
  return best
}

export function stepLabel(n?: number): string {
  const v = Number(n||0)
  return v > 0 ? `跟进${v}` : '—'
}

export type FollowBoardStats = {
  scanned: number
  replies: number
  modeChanged: number
  stepsUpdated: number
  highQueued: number
  ordersStopped: number
  note: string
}

/** 从本地邮件计算客户最近回复/我方最近发出 */
export function computeMailTimes(emails: EmailMessage[], addrs: string[]){
  const set = new Set(addrs.map(a=> a.toLowerCase()))
  let lastReply: string | null = null
  let lastSent: string | null = null
  for(const e of emails){
    const from = extractAddr(e.from).toLowerCase()
    const to = extractAddr(e.to||'').toLowerCase()
    const isSelf = e.folder === 'sent' || SELF.has(from)
    if(!isSelf && set.has(from)){
      if(!lastReply || String(e.date) > lastReply) lastReply = String(e.date)
    }
    if(isSelf && (set.has(to) || String(e.to||'').toLowerCase().split(',').some(x=> set.has(extractAddr(x))))){
      if(!lastSent || String(e.date) > lastSent) lastSent = String(e.date)
    }
  }
  return { lastReply, lastSent }
}

/**
 * 同步跟进档案 + 规则动作
 * - 回复 → hasReply / followMode=manual / 高意向
 * - 序列状态由调用方传入（可选）
 * - 我方邮件相似度 → followStep
 * - 销售阶段：已下单/取消
 */
export async function runFollowBoardSync(opts?: {
  sequences?: any[]
  forceStepScan?: boolean
}): Promise<FollowBoardStats> {
  const cfg = loadIntellectConfig()
  const customers = await db.customers.toArray() as Customer[]
  const emails = await db.emails.toArray() as EmailMessage[]
  const seqMap = new Map<string, any>()
  for(const s of opts?.sequences || []) seqMap.set(s.customer_id, s)

  const templates = (cfg as any).followStepTemplates as FollowStepTemplate[] | undefined
  const th = (cfg as any).followSimThreshold || 0.6
  const ts = new Date().toISOString()
  let replies = 0, modeChanged = 0, stepsUpdated = 0, highQueued = 0, ordersStopped = 0
  const scanned = customers.length

  for(const c of customers){
    if(!c.email && !(c.extraEmails||[]).length) continue
    if(isNoiseEmailAddress(c.email)) continue
    const addrs = customerAddrs(c)
    const { lastReply, lastSent } = computeMailTimes(emails, addrs)
    const stage = salesStageOf(c)
    let followMode = followModeOf(c)
    let hasReply = String((c as any).hasReply || '') === 'yes'
    if(lastReply){
      hasReply = true
      replies++
    }
    const seq = seqMap.get(c.id)
    // 序列有回复 → 档案对齐
    if(seq?.replied) hasReply = true
    // 规则：回复 → 手动 + 高意向
    if(hasReply && (cfg as any).followReplyToManual !== false){
      if(followMode !== 'manual'){
        followMode = 'manual'
        modeChanged++
      }
      if(seq && seq.mode === 'auto'){
        try{ await patchSequence(c.id, { mode: 'manual' }) }catch{ /* server optional */ }
      }
    }
    if(hasReply && (cfg as any).followReplyToHigh !== false){
      if(!(c as any).aiTier || (c as any).aiTier !== 'high'){
        try{
          await db.customers.update(c.id, { aiTier: 'high', aiReason: '有客户回复', aiCheckedAt: ts } as any)
        }catch{}
      }
      try{ addManualBuckets([c.id], ['high'], '客户有回复', 'add'); highQueued++ }catch{}
    }
    // 已下单/取消：销售阶段 + 可选停序列
    if(stage === 'ordered' || stage === 'cancelled'){
      const stop = stage === 'ordered'
        ? (cfg as any).followStopSeqOnOrder !== false
        : (cfg as any).followStopSeqOnCancel !== false
      if(stop && seq && seq.mode === 'auto'){
        try{ await patchSequence(c.id, { mode: 'manual' }) }catch{}
        ordersStopped++
        followMode = 'manual'
      }
    }
    // 跟进步：序列步优先；否则对我方邮件做模板相似度
    let followStep = Number((c as any).followStep || 0)
    let followStepMatched = String((c as any).followStepMatched || '')
    if(seq && Number(seq.current_step) > 0){
      const sentSteps = (seq.steps||[]).filter((t:any)=> t.status==='sent').length
      const step = sentSteps > 0 ? sentSteps : 0
      if(step > 0){
        followStep = Math.max(followStep, step)
        followStepMatched = `序列 ${step}/7`
        stepsUpdated++
      }
    } else if(lastSent){
      const myMails = emails.filter(e=>{
        const from = extractAddr(e.from).toLowerCase()
        return (e.folder==='sent' || SELF.has(from)) && addrs.some(a=> String(e.to||'').toLowerCase().includes(a))
      }).sort((a,b)=> String(b.date||'').localeCompare(String(a.date||'')))
      const last = myMails[0]
      if(last){
        const m = matchFollowStep(last.subject||'', last.text||'', templates, th)
        if(m.step > 0 && m.step !== followStep){
          followStep = m.step
          followStepMatched = m.matched
          stepsUpdated++
        }
      }
    }

    const patch: any = {
      hasReply: hasReply ? 'yes' : 'no',
      lastReplyAt: lastReply || (c as any).lastReplyAt || null,
      lastFollowAt: lastSent || (c as any).lastFollowAt || null,
      followMode,
      followModeSource: hasReply && followMode==='manual' && followModeOf(c)!=='manual' ? 'reply' : ((c as any).followModeSource || 'system'),
      salesStage: stage,
      followStep,
      followStepLabel: stepLabel(followStep),
      followStepMatched,
      updatedAt: ts,
    }
    if(hasReply && lastReply) patch.lastReplyAt = lastReply
    await db.customers.update(c.id, patch)
  }

  window.dispatchEvent(new CustomEvent('evan-customers-updated'))
  const note = `跟进档案：扫描 ${scanned} · 回复 ${replies} · 转手动 ${modeChanged} · 步号更新 ${stepsUpdated} · 高意向+${highQueued}${ordersStopped?` · 停序列 ${ordersStopped}`:''}`
  return { scanned, replies, modeChanged, stepsUpdated, highQueued, ordersStopped, note }
}

/** 客户侧改「跟进方式」时联动自动序列 */
export async function setCustomerFollowMode(c: Customer, mode: FollowMode, source: 'user'|'system' = 'user'){
  const ts = new Date().toISOString()
  await db.customers.update(c.id, {
    followMode: mode,
    followModeSource: source,
    followModeUpdatedAt: ts,
    updatedAt: ts,
  } as any)
  const stage = salesStageOf(c)
  try{
    const accs = await listAccounts()
    if(accs.length && c.email && !isNoiseEmailAddress(c.email)){
      if(mode === 'auto' && stage === 'following'){
        // 已有序列则调回自动；没有则启动
        try{
          const { getSequences } = await import('../repositories/emailRepository')
          const j = await getSequences()
          const has = (j.sequences||[]).some((s: any)=> s.customer_id === c.id)
          if(has) await patchSequence(c.id, { mode: 'auto', fromStep: Math.max(1, Number((c as any).followStep||0)+1) })
          else await startSequence({ customerId: c.id, email: c.email, accountId: accs[0].id })
        }catch{
          await startSequence({ customerId: c.id, email: c.email, accountId: accs[0].id })
        }
      } else if(mode === 'manual'){
        await patchSequence(c.id, { mode: 'manual' })
      }
    }
  }catch{ /* 无服务器时仅改本地档案 */ }
  window.dispatchEvent(new CustomEvent('evan-customers-updated'))
}

/** 保存销售阶段（已下单/取消/跟进中）并联动停序列 */
export async function setCustomerSalesStage(c: Customer, stage: SalesStage){
  const cfg = loadIntellectConfig()
  const ts = new Date().toISOString()
  const tags = new Set([...(c.tags||[]).map(String)])
  if(stage === 'ordered'){ tags.add('已下单'); tags.add('订单') }
  if(stage === 'cancelled'){ tags.add('取消') }
  if(stage === 'following'){ tags.delete('取消') }
  const patch: any = {
    salesStage: stage,
    tags: [...tags],
    updatedAt: ts,
  }
  if(stage === 'ordered') patch.stage = c.stage === 'lost' ? c.stage : 'won'
  if(stage === 'cancelled') patch.stage = 'lost'
  if(stage === 'ordered' || stage === 'cancelled'){
    patch.followMode = 'manual'
    patch.followModeSource = 'system'
  }
  await db.customers.update(c.id, patch)
  const stop = stage === 'ordered' ? cfg.followStopSeqOnOrder !== false : stage === 'cancelled' ? cfg.followStopSeqOnCancel !== false : false
  if(stop){
    try{ await patchSequence(c.id, { mode: 'manual' }) }catch{}
  }
  window.dispatchEvent(new CustomEvent('evan-customers-updated'))
}

export function daysNoFollow(c: Customer): number | null {
  const last = (c as any).lastFollowAt || (c as any).lastSentAt || null
  return daysSince(last)
}
