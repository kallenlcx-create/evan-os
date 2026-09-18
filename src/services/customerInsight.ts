// AI 洞察：读邮件 → 画像 + 意向 → 写回 customers → 桶同步
import { db } from '../db'
import type { Customer, EmailMessage } from '../types'
import { chatOnce } from './aiChat'
import { loadIntellectConfig, syncTiersFromRules } from './customerDailyClassify'
import { listPurchaseOrders } from './orderScan'

export type InsightResult = {
  customerId: string
  profile_cn: string
  intent: 'high'|'medium'|'low'
  opportunity: 'deal'|'repurchase'|'cross_sell'|'none'
  needs_followup: boolean
  followup_at?: string
  deal_hint?: string
  confidence: number
  error?: string
}

function customerEmails(c: Customer){
  return [c.email, ...(c.extraEmails||[])].filter(Boolean).map(e=> String(e).toLowerCase())
}

function pickScope(customers: Customer[], scope: string[]){
  return customers.filter(c=>{
    const tags = (c.tags||[]).map(String)
    if(scope.includes('isKey') && c.isKey) return true
    if(scope.includes(String(c.level||'')) ) return true
    if(scope.includes('已下单') && tags.includes('已下单')) return true
    return false
  })
}

export type AiInsightRunResult = {
  results: InsightResult[]
  ok: number
  fail: number
  scopeCount: number
  queued: number
  skippedCooldown: number
  note: string
}

export async function runAiInsight(opts?: { limit?: number; force?: boolean }): Promise<AiInsightRunResult> {
  const cfg = loadIntellectConfig()
  const limit = opts?.limit || cfg.aiInsightBatchMax || 30
  const cooldownMs = Math.max(0, (cfg.aiInsightCooldownDays || 7) * 86400000)
  const all = await db.customers.toArray() as Customer[]
  const scoped = pickScope(all, cfg.aiInsightScope)
  const emails = await db.emails.toArray() as EmailMessage[]
  const orders = await listPurchaseOrders()
  const now = Date.now()
  let skippedCooldown = 0
  const queue = scoped.filter(c=>{
    if(opts?.force) return true
    const at = (c as any).aiProfileAt || (c as any).aiCheckedAt
    if(!at) return true
    if(now - new Date(at).getTime() < cooldownMs){ skippedCooldown++; return false }
    return true
  }).slice(0, limit)

  const results: InsightResult[] = []
  let ok = 0, fail = 0

  if(!queue.length){
    return {
      results: [], ok:0, fail:0,
      scopeCount: scoped.length, queued:0, skippedCooldown,
      note: scoped.length
        ? `AI洞察：范围 ${scoped.length} 人，全部在冷却期内（${cfg.aiInsightCooldownDays}天），本次 0 人。可等冷却结束或强制重跑。`
        : 'AI洞察：范围内 0 人。请先自动分类或检查 isKey/A+/A/B/C。',
    }
  }

  for(const c of queue){
    const addrs = new Set(customerEmails(c))
    const hist = emails
      .filter(e=>{
        const from = (e.from.match(/<([^<>]+)>/)?.[1]||e.from||'').toLowerCase()
        const to = (e.to||'').toLowerCase()
        return addrs.has(from) || [...addrs].some(a=> to.includes(a))
      })
      .sort((a,b)=> (a.date||'').localeCompare(String(b.date||'')))
      .slice(-12)
    const ords = orders.filter(o=> o.customer_id===c.id).map(o=> `${o.order_date}: ${o.products.join('/')} x${o.qty||'?'} $${o.amount||'?'}`).join('; ')
    const mailText = hist.map(e=> `[${e.date}] ${e.from}\n${e.subject}\n${(e.text||'').slice(0,400)}`).join('\n---\n').slice(0, 4000)
    const prompt = `你是 Maxemblem 外贸销售分析助手。根据客户与邮件/订单信息输出 JSON，不要其它文字。
客户：${c.contactName||c.title}（${c.email}，${c.company||''}）等级${c.level||'C'}${c.isKey?'重点':''} 阶段${c.stage||'lead'} 复购${c.repurchaseCount||0}
订单：${ords||'无'}
邮件：
${mailText||'无'}

输出 JSON：
{"profile_cn":"中文客户背景2-4句","intent":"high|medium|low","opportunity":"deal|repurchase|cross_sell|none","needs_followup":true/false,"followup_at":"YYYY-MM-DD可空","deal_hint":"一句话","confidence":0到1}`
    try{
      const raw = await chatOnce(prompt)
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      if(!jsonMatch) throw new Error('无 JSON')
      const j = JSON.parse(jsonMatch[0])
      const r: InsightResult = {
        customerId: c.id,
        profile_cn: String(j.profile_cn||'').slice(0,500),
        intent: j.intent==='high'||j.intent==='low' ? j.intent : 'medium',
        opportunity: ['deal','repurchase','cross_sell','none'].includes(j.opportunity) ? j.opportunity : 'none',
        needs_followup: !!j.needs_followup,
        followup_at: j.followup_at || undefined,
        deal_hint: j.deal_hint || '',
        confidence: Number(j.confidence) || 0.6,
      }
      let tier: string | undefined
      let reason = r.deal_hint || r.profile_cn.slice(0,40)
      if(r.opportunity==='deal' || (r.intent==='high' && r.opportunity!=='none')){
        tier = r.opportunity==='deal' ? 'pending' : 'high'
        reason = r.deal_hint || 'AI：高意向/待成交'
      } else if(r.opportunity==='repurchase'){
        tier = 'repurchase'; reason = 'AI：复购机会'
      } else if(r.opportunity==='cross_sell'){
        tier = 'marketing'; reason = 'AI：交叉销售'
      } else if(r.needs_followup){
        tier = 'follow'; reason = 'AI：建议跟进'
      }
      const patch: any = {
        aiProfile: r.profile_cn,
        aiProfileAt: new Date().toISOString(),
        aiIntent: r.intent,
        aiOpportunity: r.opportunity,
        aiReason: reason,
        aiCheckedAt: new Date().toISOString(),
      }
      if(cfg.syncTierToFollowUps && tier){
        patch.aiTier = tier
        patch.aiReason = reason
      }
      if(r.needs_followup && r.followup_at){
        patch.followUpAt = r.followup_at
      } else if(r.needs_followup && !c.followUpAt){
        patch.followUpAt = new Date(Date.now()+ 2*86400000).toISOString().slice(0,10)
      }
      await db.customers.update(c.id, patch)
      if(r.needs_followup && patch.followUpAt){
        try{
          await db.followUps.put({
            id:`fu-ai-${Date.now()}-${c.id}`,
            customerId: c.id,
            dueAt: patch.followUpAt,
            channel:['AI洞察'],
            note: r.deal_hint || 'AI 建议跟进',
            status:'pending',
            createdAt: new Date().toISOString(),
          } as any)
        }catch{}
      }
      results.push(r)
      ok++
    }catch(e:any){
      results.push({
        customerId: c.id, profile_cn:'', intent:'medium', opportunity:'none',
        needs_followup:false, confidence:0,
        error: String(e?.message||e).slice(0,80),
      })
      fail++
    }
  }
  if(cfg.syncTierToFollowUps) await syncTiersFromRules()
  window.dispatchEvent(new CustomEvent('evan-customers-updated'))
  return {
    results, ok, fail,
    scopeCount: scoped.length,
    queued: queue.length,
    skippedCooldown,
    note: `AI洞察：范围 ${scoped.length} · 冷却跳过 ${skippedCooldown} · 本次 ${queue.length} · 成功 ${ok} · 失败 ${fail}`,
  }
}

// ====== 复购开发：订单周期 + AI 洞察 ======
export async function runPurchaseLoop(opts?: { limit?: number; force?: boolean }){
  const cfg = loadIntellectConfig()
  const cooldownMs = Math.max(0, (cfg.purchaseLoopCooldownDays || 14) * 86400000)
  const orders = await listPurchaseOrders()
  const customers = await db.customers.toArray() as Customer[]
  const byCust = new Map<string, typeof orders>()
  for(const o of orders){
    if(!byCust.has(o.customer_id)) byCust.set(o.customer_id, [])
    byCust.get(o.customer_id)!.push(o)
  }
  const CROSS: Record<string, string[]> = {
    Medal: ['Medal','Coin','Belt','Trophy'],
    Coin: ['Coin','Pin','Medal','Keychain'],
    Pin: ['Pin','Patch','Coin'],
    Keychain: ['Keychain','Pin','Coin'],
    Belt: ['Medal','Trophy'],
    Patch: ['Patch','Pin','Coin'],
    Trophy: ['Trophy','Medal','Belt'],
  }
  const emails = await db.emails.toArray() as EmailMessage[]
  const now = Date.now()
  const limit = opts?.limit || cfg.aiInsightBatchMax || 20
  let updated = 0
  let aiOk = 0
  let skipped = 0
  const ordered = customers.filter(c=>{
    const tags = (c.tags||[]).map(String)
    return (byCust.get(c.id)||[]).length>0 || tags.includes('已下单')
  })
  const queue = ordered.filter(c=>{
    if(opts?.force) return true
    const at = (c as any).purchaseIntelAt
    if(!at) return true
    if(now - new Date(at).getTime() < cooldownMs){ skipped++; return false }
    return true
  }).slice(0, limit)

  for(const c of queue){
    const os = (byCust.get(c.id)||[]).sort((a,b)=> a.order_date.localeCompare(b.order_date))
    const dates = os.map(o=> new Date(o.order_date).getTime()).filter(t=> Number.isFinite(t))
    let cycle = 0
    if(dates.length >= 2){
      const gaps: number[] = []
      for(let i=1;i<dates.length;i++) gaps.push(Math.round((dates[i]-dates[i-1])/86400000))
      gaps.sort((a,b)=>a-b)
      cycle = gaps[Math.floor(gaps.length/2)] || 0
    }
    const last = dates.length ? dates[dates.length-1] : null
    const daysSince = last ? Math.floor((now-last)/86400000) : 999
    const products = [...new Set(os.flatMap(o=> o.products||[]))]
    // AI 读邮件补充
    let ai: any = null
    try{
      const addrs = new Set([c.email, ...(c.extraEmails||[])].filter(Boolean).map(e=> String(e).toLowerCase()))
      const hist = emails.filter(e=>{
        const from = (e.from.match(/<([^<>]+)>/)?.[1]||e.from||'').toLowerCase()
        const to = String(e.to||'').toLowerCase()
        return addrs.has(from) || [...addrs].some(a=> to.includes(a))
      }).slice(-10)
      const mailText = hist.map(e=> `[${e.date}] ${e.from}: ${e.subject} ${(e.text||'').slice(0,250)}`).join('\n').slice(0, 3000)
      const prompt = `你是外贸复购分析助手。只输出 JSON。
客户 ${c.contactName||c.title} ${c.email}
历史订单：${os.map(o=> o.order_date+' '+o.products.join('/')+' $'+(o.amount||'?')).join('; ')||'无'}
距上次订单 ${daysSince} 天，估算周期 ${cycle} 天
邮件摘录：${mailText||'无'}
输出：{"buyer_type":"once|repeat|dormant|high_value","pattern":"same_product|multi_product|seasonal|unknown","cycle_days_est":数字,"next_products":["…"],"nba":"reorder|cross_sell|reactivation|nurture|none","nba_reason":"中文一句","should_contact_now":true/false,"profile_cn":"中文摘要","confidence":0到1}`
      const raw = await chatOnce(prompt)
      const m = raw.match(/\{[\s\S]*\}/)
      if(m){ ai = JSON.parse(m[0]); aiOk++ }
    }catch{}

    let buyerType = ai?.buyer_type || (dates.length<=1 ? 'once' : (daysSince>420 ? 'dormant' : 'repeat'))
    const pattern = ai?.pattern || (products.length<=1 ? 'same_product' : (dates.length>=2 ? 'multi_product' : 'unknown'))
    if(ai?.cycle_days_est) cycle = Number(ai.cycle_days_est) || cycle
    const rec = new Set<string>(ai?.next_products || [])
    if(!rec.size){
      for(const p of products) for(const x of (CROSS[p]||[])) rec.add(x)
    }
    let nba = ai?.nba || 'none'
    let nbaReason = ai?.nba_reason || ''
    const suppressedUntil = (c as any).marketingSuppressedUntil ? new Date((c as any).marketingSuppressedUntil).getTime() : 0
    const suppressed = suppressedUntil > now
    if(!ai){
      if(cycle > 0 && daysSince >= Math.floor(cycle*0.85) && daysSince <= Math.floor(cycle*1.6)){
        nba = 'reorder'; nbaReason = `历史复购约${cycle}天，已${daysSince}天`
      } else if(cycle > 0 && daysSince >= Math.floor(cycle*0.65)){
        nba = 'reorder'; nbaReason = `复购窗口将至（约${cycle}天，已${daysSince}天）`
      } else if(daysSince > 420){
        nba = 'reactivation'; nbaReason = `已${daysSince}天无订单`
      } else if(daysSince < 30){
        nba = 'nurture'; nbaReason = '刚下单，暂缓营销'
      } else if(rec.size){
        nba = 'cross_sell'; nbaReason = `可交叉：${[...rec].slice(0,3).join('/')}`
      }
    }
    const shouldContact = ai?.should_contact_now != null ? !!ai.should_contact_now : (nba==='reorder' || nba==='cross_sell')
    const profile = ai?.profile_cn || `订单 ${os.length} 次 · ${products.join('/')||'—'} · 距上次 ${daysSince} 天 · 周期约 ${cycle||'—'} 天`
    await db.customers.update(c.id, {
      purchaseTier: buyerType,
      purchasePattern: pattern,
      cycleDaysEst: cycle,
      nextWindowAt: cycle && last ? new Date(last + cycle*86400000).toISOString().slice(0,10) : undefined,
      nextBestAction: nba,
      nbaReason,
      aiProfile: profile,
      purchaseIntelAt: new Date().toISOString(),
      aiReason: nbaReason || (c as any).aiReason,
      ...(cfg.syncTierToFollowUps && shouldContact && nba==='reorder' && !suppressed
        ? { aiTier:'repurchase', aiReason: nbaReason || '复购窗口' }
        : {}),
    } as any)
    updated++
  }
  window.dispatchEvent(new CustomEvent('evan-customers-updated'))
  return {
    updated,
    totalOrdered: ordered.length,
    skipped,
    aiOk,
    note: `复购开发：已下单 ${ordered.length} · 冷却跳过 ${skipped} · 本次 ${queue.length} · AI ${aiOk} · 更新 ${updated}`,
  }
}
