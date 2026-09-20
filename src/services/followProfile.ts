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

const STOP = new Set(['your','you','the','and','for','with','from','this','that','have','will','best','regards','dear','hello','please','just','would','could','about','email','thanks','thank','evan','maxemblem','following','follow','check','checking'])

/** 从用户保存的序列模板提取关键词，供「跟进状态」相似度判断 */
export function templatesFromSeqTemplates(list: any[]): FollowStepTemplate[] {
  if(!list?.length) return []
  const out: FollowStepTemplate[] = []
  for(let i=0;i<list.length && i<7;i++){
    const t = list[i]
    const id = String(t.id||'')
    let n = i+1
    const m = id.match(/(\d+)\s*$/)
    if(m) n = Number(m[1]) || (i+1)
    const name = String(t.name||`跟进${n}`)
    const text = `${t.subject||''}\n${t.body||''}`.toLowerCase()
    const words = text.split(/[^a-z0-9一-鿿']+/).filter(w=> w.length>=4 && !STOP.has(w))
    const uniq = [...new Set(words)].slice(0, 12)
    const phrase: string[] = []
    const subj = String(t.subject||'').toLowerCase().trim()
    if(subj) phrase.push(subj)
    if(String(t.body||'').includes('{{')) phrase.push(...uniq.slice(0,6))
    const keywords = [...new Set([...phrase, ...uniq])].filter(Boolean).slice(0, 14)
    const def = DEFAULT_FOLLOW_STEP_TEMPLATES[n-1]
    out.push({
      n,
      name,
      keywords: keywords.length >= 2 ? keywords : (def?.keywords || keywords),
    })
  }
  return out.length ? out : []
}

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

/** 关键词/片段相似度：覆盖 + 主题包含；templates 优先用「用户在序列模板里填的文案」 */
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
    const hitList: string[] = []
    for(const k of kws){ if(s.includes(k)){ hit++; hitList.push(k) } }
    let score = hit / Math.max(kws.length, 1)
    // 主题与模板主题高度一致时加分
    const subj = String(subject||'').toLowerCase()
    if(subj && kws.some(k=> subj.includes(k))) score = Math.min(1, score + 0.25)
    if(kws.length<=2 && hit>=1) score = Math.max(score, 0.75) // 短关键词集：命中即较可信
    const total = score
    if(total >= th && (total > best.score || (total === best.score && t.n > best.step))){
      best = { step: t.n, score: total, matched: hitList.slice(0,5).join(',') || t.name }
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

/** 客户上次回复之后，我方发给该客户的邮件数量 */
export function countFollowsSinceReply(emails: EmailMessage[], addrs: string[], lastReply: string | null): number {
  const set = new Set(addrs.map(a=> a.toLowerCase()))
  const since = lastReply || '' // 无回复则统计全部我方发给TA的信
  let n = 0
  for(const e of emails){
    const from = extractAddr(e.from).toLowerCase()
    const isSelf = e.folder === 'sent' || SELF.has(from)
    if(!isSelf) continue
    const to = String(e.to||'').toLowerCase()
    const hit = to.split(',').some(x=> set.has(extractAddr(x)))
    if(!hit) continue
    if(since && String(e.date||'') < since) continue
    n++
  }
  return n
}

/** 读邮件上下文 + 十一维 → 生成专业跟进英文（只返回正文） */
export async function generateAiFollowReply(c: Customer, emails: EmailMessage[]): Promise<{ subject: string; body: string }>{
  const { chatOnce } = await import('./aiChat')
  const { mergePortrait, coercePortrait, parsePortraitFromProfile, formatPortraitText } = await import('../config/portrait')
  const addrs = customerAddrs(c)
  const hist = emails.filter(e=>{
    const from = extractAddr(e.from).toLowerCase()
    const to = String(e.to||'').toLowerCase()
    return addrs.includes(from) || to.split(',').some(x=> addrs.includes(extractAddr(x)))
  }).sort((a,b)=> String(a.date||'').localeCompare(String(b.date||''))).slice(-15)
  const portrait = mergePortrait(coercePortrait((c as any).aiPortrait), parsePortraitFromProfile((c as any).aiProfile) || {})
  const portraitText = formatPortraitText(portrait)
  const mailText = hist.map(e=> `[${e.date}] ${e.folder==='sent'?'我方':'客户'} ${e.subject}\n${(e.text||'').slice(0,300)}`).join('\n---\n').slice(0, 4500)
  const prompt = `你是 Maxemblem 外贸业务员 Evan。根据客户画像与邮件上下文，写一封专业、简洁的英文跟进邮件正文。
【十一维画像】
${portraitText}
【客户】${c.contactName||c.title} ${c.email} 等级${c.level||'C'}
【往来】
${mailText||'无'}
要求：只输出邮件正文（不要主题、不要解释）；语气专业友好；结合产品/订单/画像；结尾留一句明确行动引导；落款 Best regards,\\nEvan。不超过180词。`
  const body = String(await chatOnce(prompt) || '').trim()
  const { findLatestThreadHeaders } = await import('../repositories/emailRepository')
  const th = await findLatestThreadHeaders(c.email||'').catch(()=>({ found:false, subject:'', messageId:'' } as any))
  const { normalizeReplySubject } = await import('../utils/mailHtml')
  const product = (c.portrait as any)?.products?.[0] || 'your project'
  const subject = th.found && th.subject
    ? normalizeReplySubject(th.subject)
    : `Following up - ${product}`
  return { subject, body: body || `Hi ${c.contactName||c.title||'there'},\n\nJust wanted to follow up on your project. Let me know if you have any questions.\n\nBest regards,\nEvan` }
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
  seqTemplates?: any[]
  forceStepScan?: boolean
}): Promise<FollowBoardStats> {
  const cfg = loadIntellectConfig()
  const customers = await db.customers.toArray() as Customer[]
  const emails = await db.emails.toArray() as EmailMessage[]
  const seqMap = new Map<string, any>()
  for(const s of opts?.sequences || []) seqMap.set(s.customer_id, s)

  // 优先用用户在「模板+间隔」里保存的 7 步文案做相似度
  const fromUser = templatesFromSeqTemplates(opts?.seqTemplates || [])
  const templates = fromUser.length ? fromUser : ((cfg as any).followStepTemplates as FollowStepTemplate[] | undefined)
  const th = (cfg as any).followSimThreshold || 0.6
  const ts = new Date().toISOString()
  let replies = 0, modeChanged = 0, stepsUpdated = 0, highQueued = 0, ordersStopped = 0
  const scanned = customers.length

  for(const c of customers){
    if(!c.email && !(c.extraEmails||[]).length) continue
    if(isNoiseEmailAddress(c.email)) continue
    const addrs = customerAddrs(c)
    const { lastReply, lastSent } = computeMailTimes(emails, addrs)
    const followCount = countFollowsSinceReply(emails, addrs, lastReply)
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
    } else if(lastSent || (c as any).followCountSinceReply > 0){
      const scan = bestFollowStepFromMails(emails, addrs, templates, th)
      if(scan.step > 0 && scan.step !== followStep){
        followStep = scan.step
        followStepMatched = scan.matched
        stepsUpdated++
      } else if(!followStep && scan.step > 0){
        followStep = scan.step
        followStepMatched = scan.matched
        stepsUpdated++
      }
    }

    const patch: any = {
      hasReply: hasReply ? 'yes' : 'no',
      // 时间一律以邮件收发为准
      lastReplyAt: lastReply || null,
      lastFollowAt: lastSent || (c as any).lastFollowAt || null,
      followCountSinceReply: followCount,
      followMode,
      followModeSource: hasReply && followMode==='manual' && followModeOf(c)!=='manual' ? 'reply' : ((c as any).followModeSource || 'system'),
      salesStage: stage,
      followStep,
      followStepLabel: stepLabel(followStep),
      followStepMatched,
      updatedAt: ts,
    }
    // 回填业务创建时间（询盘日 / 邮件最早往来）
    const mailBiz = businessCreatedAt(c, { emails })
    const prevInq = String((c as any).inquiryAt||'').slice(0,10)
    const inqDate = String((c as any).inquiryAt||'').slice(0,10)
    const biz = inqDate || (prevInq || mailBiz)
    if(biz && biz !== createdAtOf(c) && /^\d{4}-\d{2}-\d{2}$/.test(biz)){
      patch.inquiryAt = (c as any).inquiryAt || biz
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

export function createdAtOf(c: Customer): string {
  return String((c as any).createdAt || (c as any).created_at || '').slice(0, 10) || '—'
}

/**
 * 业务创建时间：必须以收发邮件 / 询盘日为准，不用系统建档时间。
 * 优先：inquiryAt → 询盘表 inquiryDate → 邮件最早往来 → firstSentAt/lastFollowAt → createdAt
 */
export function businessCreatedAt(
  c: Customer,
  opts?: { inquiryDate?: string; emails?: EmailMessage[] }
): string {
  const fromIso = (v?: string | null) => {
    if(!v) return ''
    const s = String(v).slice(0, 10)
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''
  }
  const inquiryAt = fromIso((c as any).inquiryAt) || fromIso(opts?.inquiryDate)
  if(inquiryAt) return inquiryAt

  // 客户相关邮件最早日期（收或发）
  if(opts?.emails?.length){
    const addrs = customerAddrs(c)
    let earliest = ''
    for(const e of opts.emails){
      const from = extractAddr(e.from).toLowerCase()
      const to = extractAddr(e.to||'').toLowerCase()
      const hit = addrs.some(a=> a && (a===from || to.includes(a) || from===a))
      if(!hit) continue
      const d = fromIso(e.date)
      if(d && (!earliest || d < earliest)) earliest = d
    }
    if(earliest) return earliest
  }

  const firstSent = fromIso((c as any).firstSentAt)
  if(firstSent) return firstSent
  // 最近跟进时间可作弱回退（仍来自邮件）
  const lastFollow = fromIso((c as any).lastFollowAt)
  if(lastFollow) return lastFollow
  return createdAtOf(c)
}

/** 未跟进天数：只认我方发送时间（邮件），不认建档/更新时间 */
export function daysNoFollow(c: Customer): number | null {
  const last = (c as any).lastFollowAt || (c as any).lastSentAt || null
  return daysSince(last)
}

/** 跟进表用噪声判断（比 isNoiseEmailAddress 更宽） */
export function isBoardNoiseEmail(email?: string | null): boolean {
  const addr = String(email||'').toLowerCase().trim()
  if(!addr.includes('@')) return true
  const local = addr.split('@')[0] || ''
  const domain = addr.split('@')[1] || ''
  if(local.startsWith('noreply') || local.startsWith('no-reply') || local.startsWith('donotreply')) return true
  const noiseLocal = ['welcome','service','info','marketing','announce','newsletter','bounce','mailer-daemon','postmaster','notifications']
  if(noiseLocal.includes(local)) return true
  const noiseDom = [
    'wordpress.com','blogger.com','googlemail.com','youtube.com','quora.com',
    'support.whatsapp.com','abnewswire.com','slickdeals.net','dealnews.com',
    'bradsdeals.com','getmecodes.com','mediafuse.org','flipboard.com',
  ]
  if(noiseDom.includes(domain) || domain.endsWith('.blogger.com')) return true
  if(domain === 'microsoft.com' || domain.endsWith('.microsoft.com')) {
    if(/outlook|exchange|notifications/.test(local)) return true
  }
  return isNoiseEmailAddress(email)
}

/** 从该客户「我方发出」的最近邮件里找最匹配的模板步号 */
export function bestFollowStepFromMails(
  emails: EmailMessage[],
  addrs: string[],
  templates?: FollowStepTemplate[],
  threshold?: number,
): { step: number; matched: string; lastSent: string | null; count: number } {
  const set = new Set(addrs.map(a=> a.toLowerCase()))
  const mine = emails.filter(e=>{
    const from = extractAddr(e.from).toLowerCase()
    if(!(e.folder === 'sent' || SELF.has(from))) return false
    const to = String(e.to||'').toLowerCase()
    return to.split(',').some(x=> set.has(extractAddr(x)))
  }).sort((a,b)=> String(b.date||'').localeCompare(String(a.date||'')))
  const lastSent = mine[0]?.date ? String(mine[0].date) : null
  let step = 0
  let matched = ''
  // 扫最近 12 封我方邮件，取最高步号匹配
  for(const e of mine.slice(0, 12)){
    const m = matchFollowStep(e.subject||'', e.text||'', templates, threshold)
    if(m.step > step){
      step = m.step
      matched = m.matched || ''
    }
  }
  return { step, matched, lastSent, count: mine.length }
}
