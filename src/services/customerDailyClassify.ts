// 每日智能分类 + 配置 + 桶同步
// 等级：金额>1500=A+，>1000=A，>500=B，否则按往来 C/D
import { db } from '../db'
import type { Customer, EmailMessage } from '../types'

export type IntellectConfig = {
  autoDailyClassify: boolean
  autoDailyClassifyAt: string
  autoClassifyOnOpen: boolean
  autoOrderScan: boolean
  orderScanDays: number
  syncTierToFollowUps: boolean
  aiInsightScope: string[]
  aiInsightBatchMax: number
  marketingSuppressDays: number
  /** AI 洞察冷却（天） */
  aiInsightCooldownDays: number
  /** 复购开发冷却（天） */
  purchaseLoopCooldownDays: number
  /** 成交/下单关键词（不区分大小写） */
  dealKeywords: string[]
  /** 排除词：命中则不当作成交 */
  dealExcludeWords: string[]
}

const CFG_KEY = 'evan:intellectConfig'
const LAST_CLASSIFY_KEY = 'evan:lastDailyClassifyAt'

export const DEFAULT_DEAL_KEYWORDS = [
  'paid', 'payment sent', 'payment confirmed', 'remittance', 'wire transfer',
  'order confirmed', 'we placed the order', 'place order', 'po attached', 'proceed with order',
  '已付款', '已下单', '订单号', '汇款', '付款成功',
]
export const DEFAULT_DEAL_EXCLUDES = ['unpaid', 'not paid', 'pending payment', '未付款']

export function loadIntellectConfig(): IntellectConfig {
  const base: IntellectConfig = {
    autoDailyClassify: true,
    autoDailyClassifyAt: '09:30',
    autoClassifyOnOpen: true,
    autoOrderScan: true,
    orderScanDays: 5,
    syncTierToFollowUps: true,
    aiInsightScope: ['isKey', 'A+', 'A', 'B', 'C'],
    aiInsightBatchMax: 30,
    marketingSuppressDays: 7,
    aiInsightCooldownDays: 7,
    purchaseLoopCooldownDays: 14,
    dealKeywords: [...DEFAULT_DEAL_KEYWORDS],
    dealExcludeWords: [...DEFAULT_DEAL_EXCLUDES],
  }
  try {
    const raw = localStorage.getItem(CFG_KEY)
    if (raw) return { ...base, ...JSON.parse(raw) }
  } catch {}
  return base
}
export function saveIntellectConfig(patch: Partial<IntellectConfig>) {
  const next = { ...loadIntellectConfig(), ...patch }
  localStorage.setItem(CFG_KEY, JSON.stringify(next))
  return next
}

export function classifyEmailType(email?: string){
  if(!email) return { label:'未知', type:'Company' as const }
  const suffix = String(email).split('@')[1]?.toLowerCase() || ''
  if(suffix.endsWith('.gov') || suffix==='gov') return { label:'政府', type:'Government' as const }
  if(suffix.endsWith('.mil') || suffix==='mil') return { label:'军队', type:'Military' as const }
  if(suffix.endsWith('.edu') || suffix==='edu') return { label:'教育', type:'School' as const }
  if(suffix.endsWith('.org') || suffix==='org') return { label:'非盈利', type:'Organization' as const }
  const personal = ['gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com','live.com','aol.com','protonmail.com','mail.com','qq.com','163.com','126.com','foxmail.com']
  if(personal.includes(suffix)) return { label:'个人', type:'End Customer' as const }
  return { label:'企业', type:'Company' as const }
}

function extractAmount(text: string): number {
  const patterns = [
    /\$\s*([\d,]+(?:\.\d{2})?)/g,
    /USD\s*([\d,]+(?:\.\d{2})?)/gi,
    /price[:\s]*\$?([\d,]+(?:\.\d{2})?)/gi,
    /total[:\s]*\$?([\d,]+(?:\.\d{2})?)/gi,
  ]
  let max = 0
  for(const p of patterns){
    let m
    const re = new RegExp(p.source, p.flags)
    while((m = re.exec(text)) !== null){
      const n = parseFloat(m[1].replace(/,/g,''))
      if(n > max) max = n
    }
  }
  return max
}

/** 等级：>1500 A+，>1000 A，>500 B；往来次数兜底 */
export function levelFromSignals(totalAmount: number, emailCount: number): Customer['level'] {
  if(totalAmount > 1500) return 'A+'
  if(totalAmount > 1000) return 'A'
  if(totalAmount > 500) return 'B'
  if(emailCount >= 5) return 'B'
  if(emailCount >= 3) return 'C'
  return emailCount >= 1 ? 'C' : 'D'
}

const LEVEL_ORDER = ['D','C','B','A','A+'] as const
/** 由等级/邮箱类型派生，不在「标签」筛选行重复展示 */
export const SYSTEM_TAGS = ['政府','教育','非盈利','军队','个人','企业','已分类','重点客户','邮件','订单']
export const SYSTEM_TAG_SET = new Set(SYSTEM_TAGS)
function levelOnlyUp(old: Customer['level'], next: Customer['level']) {
  const oi = LEVEL_ORDER.indexOf((old||'D') as any)
  const ni = LEVEL_ORDER.indexOf((next||'D') as any)
  return ni >= oi ? next : old
}

/** 成交关键词匹配（含排除词） */
export function matchDealKeywords(text: string, cfg?: { dealKeywords?: string[]; dealExcludeWords?: string[] }){
  const kw = cfg?.dealKeywords?.length ? cfg.dealKeywords : DEFAULT_DEAL_KEYWORDS
  const ex = cfg?.dealExcludeWords?.length ? cfg.dealExcludeWords : DEFAULT_DEAL_EXCLUDES
  const t = String(text||'').toLowerCase()
  if(!t) return { hit:false, matched:'' }
  for(const w of ex){
    if(w && t.includes(String(w).toLowerCase())) return { hit:false, matched:'' }
  }
  for(const w of kw){
    if(w && t.includes(String(w).toLowerCase())) return { hit:true, matched:w }
  }
  return { hit:false, matched:'' }
}

/** 单客户：从往来邮件上下文提取可信金额与成交信号 */
export function analyzeCustomerMailContext(mails: EmailMessage[], cfg: IntellectConfig){
  let dealAmount = 0
  let anyAmount = 0
  let dealHit = ''
  for(const e of mails){
    const text = ((e.subject||'') + '\n' + (e.text||''))
    const amt = extractAmount(text)
    if(amt > anyAmount) anyAmount = amt
    const dm = matchDealKeywords(text, cfg)
    if(dm.hit){
      dealHit = dm.matched
      if(amt > dealAmount) dealAmount = amt
    }
  }
  const levelAmount = dealAmount > 0 ? dealAmount : anyAmount
  return { dealAmount, anyAmount, levelAmount, dealHit, mailCount: mails.length }
}

export type DailyClassifyResult = {
  processed: number
  upgraded: number
  keyCount: number
  byType: Record<string, number>
  byLevel: Record<string, number>
  dealKeywordHits: number
}

export async function runDailyClassify(opts?: { force?: boolean }): Promise<DailyClassifyResult> {
  const todayKey = new Date().toISOString().slice(0,10)
  const last = localStorage.getItem(LAST_CLASSIFY_KEY)
  if(!opts?.force && last === todayKey){
    return { processed:0, upgraded:0, keyCount:0, byType:{}, byLevel:{}, dealKeywordHits:0 }
  }
  const customers = await db.customers.toArray() as Customer[]
  const emails = await db.emails.toArray() as EmailMessage[]

  const byEmail = new Map<string, { count: number; amount: number }>()
  for(const e of emails){
    const addrs = [
      (e.from.match(/<([^<>]+)>/)?.[1] || e.from || '').toLowerCase(),
      ...String(e.to||'').split(',').map(s=> s.match(/<([^<>]+)>/)?.[1] || s).map(s=> String(s).trim().toLowerCase()),
    ].filter(Boolean)
    for(const a of addrs){
      if(!a.includes('@')) continue
      const cur = byEmail.get(a) || { count:0, amount:0 }
      cur.count++
      const amt = extractAmount(`${e.subject||''} ${e.text||''}`)
      if(amt > cur.amount) cur.amount = amt
      byEmail.set(a, cur)
    }
  }

  const result: DailyClassifyResult = { processed:0, upgraded:0, keyCount:0, byType:{}, byLevel:{}, dealKeywordHits:0 }
  const cfg = loadIntellectConfig()
  // 按邮箱索引：该客户全部相关邮件（上下文）
  const mailsByAddr = new Map<string, EmailMessage[]>()
  for(const e of emails){
    const addrs = [
      (e.from.match(/<([^<>]+)>/)?.[1] || e.from || '').toLowerCase(),
      ...String(e.to||'').split(',').map(s=> s.match(/<([^<>]+)>/)?.[1] || s).map(s=> String(s).trim().toLowerCase()),
    ].filter(Boolean)
    for(const a of addrs){
      if(!a.includes('@')) continue
      const arr = mailsByAddr.get(a) || []
      if(arr.length < 40) arr.push(e)
      mailsByAddr.set(a, arr)
    }
  }
  const ts = new Date().toISOString()
  for(const c of customers){
    const mails = [c.email, ...(c.extraEmails||[])].filter(Boolean).map(e=> String(e).toLowerCase())
    let emailCount = 0
    // 该客户邮件上下文（最近若干封）→ 可信金额 / 成交关键词
    const ctxMails: EmailMessage[] = []
    for(const m of mails){
      const st = byEmail.get(m)
      if(st) emailCount = Math.max(emailCount, st.count)
      const arr = mailsByAddr.get(m)
      if(arr) for(const e of arr) if(!ctxMails.includes(e)) ctxMails.push(e)
    }
    const ctx = analyzeCustomerMailContext(ctxMails, cfg)
    const amount = Math.max(Number((c as any).value || 0), ctx.levelAmount)
    if(ctx.dealHit) result.dealKeywordHits++
    const et = classifyEmailType(c.email)
    let level = levelFromSignals(amount, emailCount)
    level = levelOnlyUp(c.level || 'D', level)
    let isKey = !!c.isKey
    if(level === 'A+' || level === 'A' || amount > 1500 || emailCount >= 5) isKey = true
    // 系统分类写 customerType/level/isKey，不再往 tags 塞「政府/已分类…」
    // 避免与顶部筛选条（A~D + 邮箱类型）重复
    const oldTags = (c.tags||[]).map(String).filter(t=> !SYSTEM_TAG_SET.has(t))
    const tags = new Set(oldTags)
    if(level !== c.level) result.upgraded++
    if(isKey) result.keyCount++
    result.byType[et.label] = (result.byType[et.label]||0)+1
    result.byLevel[level] = (result.byLevel[level]||0)+1
    const patch: any = {
      level,
      isKey,
      customerType: et.type,
      tags: [...tags],
      classifiedAt: ts,
      updatedAt: ts,
      classifyReason: ctx.dealHit ? `邮件成交词「${ctx.dealHit}」金额${ctx.dealAmount||ctx.anyAmount}` : (ctx.anyAmount ? `邮件金额 ${ctx.anyAmount}` : '往来/邮箱类型'),
    }
    if(!c.followUpAt){
      patch.followUpAt = new Date(Date.now() + (isKey ? 3 : 7) * 86400000).toISOString().slice(0,10)
      try{
        await db.followUps.put({
          id: `fu-cls-${Date.now()}-${c.id}`,
          customerId: c.id,
          dueAt: patch.followUpAt,
          channel: ['智能分类'],
          note: `自动分类跟进（${level}${isKey?'/重点':''}）`,
          status: 'pending',
          createdAt: ts,
        } as any)
      }catch{}
    }
    await db.customers.update(c.id, patch)
    result.processed++
  }
  localStorage.setItem(LAST_CLASSIFY_KEY, todayKey)
  window.dispatchEvent(new CustomEvent('evan-customers-updated'))
  return result
}

export function formatClassifyResult(r: DailyClassifyResult){
  const t = Object.entries(r.byType).map(([k,v])=> `${k}${v}`).join(' · ')
  const l = Object.entries(r.byLevel).map(([k,v])=> `${k} ${v}`).join(' · ')
  return `自动分类 ${r.processed} 人：升级 ${r.upgraded} · 重点 ${r.keyCount} · 成交词 ${r.dealKeywordHits||0}｜${l}${t?`｜${t}`:''}`
}

// ====== 桶同步：规则 L1（与跟进页共用口径）=====
export async function syncTiersFromRules(opts?: { ids?: Set<string> }){
  const cfg = loadIntellectConfig()
  if(!cfg.syncTierToFollowUps) return 0
  const customers = await db.customers.toArray() as Customer[]
  const emails = await db.emails.toArray() as EmailMessage[]
  const byEmail = new Map<string, string>()
  for(const e of emails){
    const addr = (e.from.match(/<([^<>]+)>/)?.[1] || e.from || '').toLowerCase()
    if(addr.includes('@')){
      const prev = byEmail.get(addr)
      if(!prev || e.date > prev) byEmail.set(addr, e.date)
    }
  }
  let n = 0
  for(const c of customers){
    if(opts?.ids && !opts.ids.has(c.id)) continue
    const mails = [c.email, ...(c.extraEmails||[])].filter(Boolean).map(e=> String(e).toLowerCase())
    let last = c.updatedAt || ''
    for(const m of mails){
      const d = byEmail.get(m)
      if(d && (!last || d > last)) last = d
    }
    const days = last ? Math.floor((Date.now() - new Date(last).getTime())/86400000) : 9999
    const tags = (c.tags||[]).map(t=> String(t))
    const hasOrder = tags.includes('已下单')
    const stage = c.stage || 'lead'
    const level = c.level || 'C'
    let tier: any = 'active'
    let reason = `近${days}天活跃`
    if(stage==='proposal' || stage==='negotiation'){
      tier = 'pending'; reason = '报价/谈判阶段'
    } else if((c.isKey && (level==='A+' || level==='A')) || stage==='qualified'){
      tier = 'high'; reason = `等级${level}${c.isKey?'/重点':''}`
    } else if(hasOrder && days >= 30 && days <= 400){
      tier = 'repurchase'; reason = `已下单·静默${days}天`
    } else if(stage==='lost' || days > 180){
      tier = 'dormant'; reason = stage==='lost'?'已流失':`静默${days}天`
    } else if(days > 30){
      tier = 'marketing'; reason = `${days}天未联系`
    } else if(days <= 30){
      tier = 'follow'; reason = `近${days}天往来`
    }
    await db.customers.update(c.id, {
      aiTier: tier,
      aiReason: reason,
      aiCheckedAt: new Date().toISOString(),
    } as any)
    n++
  }
  window.dispatchEvent(new CustomEvent('evan-customers-updated'))
  return n
}
