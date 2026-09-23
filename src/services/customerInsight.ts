// AI 洞察：读邮件 → 画像 + 意向 → 写回 customers → 桶同步
import { db } from '../db'
import type { Customer, EmailMessage } from '../types'
import { chatOnce } from './aiChat'
import { loadIntellectConfig, syncTiersFromRules } from './customerDailyClassify'
import { listPurchaseOrders } from './orderScan'
import { addManualBuckets, isBucketOptOut } from './manualBuckets'
import {
  coercePortrait, mergePortrait, formatPortraitText, parsePortraitFromProfile,
  isFillableDim,
} from '../config/portrait'

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

export async function runAiInsight(opts?: {
  limit?: number
  force?: boolean
  onlyCustomerIds?: string[]
  /** 每人之间的间隔 ms（批量画像可放慢，降低限流） */
  delayMs?: number
  onProgress?: (done: number, total: number, name: string) => void
}): Promise<AiInsightRunResult> {
  const cfg = loadIntellectConfig()
  const limit = opts?.limit || cfg.aiInsightBatchMax || 30
  const cooldownMs = Math.max(0, (cfg.aiInsightCooldownDays || 7) * 86400000)
  const delayMs = Math.max(0, opts?.delayMs ?? 800)
  const all = await db.customers.toArray() as Customer[]
  let scoped = pickScope(all, cfg.aiInsightScope)
  if(opts?.onlyCustomerIds?.length){
    const set = new Set(opts.onlyCustomerIds)
    scoped = all.filter(c=> set.has(c.id))
  }
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
        ? `AI洞察：范围 ${scoped.length} 人，全部在冷却期内（${cfg.aiInsightCooldownDays}天），本次 0 人。可等冷却结束或对选中客户「批量AI画像」强制重跑。`
        : 'AI洞察：范围内 0 人。请先筛选/多选客户，或检查 isKey/A+/A/B/C 范围。',
    }
  }

  let idx = 0
  for(const c of queue){
    idx++
    opts?.onProgress?.(idx, queue.length, c.contactName || c.title || c.email || c.id)
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
    const prevPortrait = mergePortrait(
      coercePortrait((c as any).aiPortrait),
      parsePortraitFromProfile((c as any).aiProfile) || {},
    )
    const prevEdited = !!(c as any).portraitEditedAt
    const prevText = formatPortraitText(prevPortrait)
    const prompt = `你是 Maxemblem 外贸销售分析助手。根据客户邮件/订单输出 JSON，不要其它文字。
客户：${c.contactName||c.title}（${c.email}，${c.company||''}）等级${c.level||'C'}${c.isKey?'重点':''} 阶段${c.stage||'lead'} 复购${c.repurchaseCount||0}
订单：${ords||'无'}
邮件：
${mailText||'无'}

【已有十一维画像（可能含人工修正${prevEdited?'，人工已修订，优先采用':''}）】
${prevText}

必须按十一维画像填写 portrait（中文，信息不足写「邮件未体现」，禁止编造；AI 输出为空时保留已有画像值）：
1 order_times 下单/付款时间
2 order_count 下单次数
3 customer_type 客户类型（公司/军警/学校/赛事/俱乐部/个人/协会等）
4 product_preference 产品偏好（Medal/Coin/Pin/Patch/Keychain 等）
5 craft_preference 工艺偏好（Soft Enamel、3D、UV、Die Cast、Embroidery 等）
6 procurement_scale 采购规模（pcs + 金额，如 25 pcs / $900）
7 budget_sensitivity 预算敏感度（高/中/低）
8 decision_mode 决策方式（个人直接决定/团队审核/多人审批）
9 time_pattern 时间特征（年度赛事/毕业季/节日/纪念日等固定周期）
10 repurchase_potential 复购潜力（高/中/低）
11 next_marketing 下一次营销策略（复购提醒/新产品推荐/优惠/节日营销）

输出 JSON：
{"profile_cn":"中文背景2-4句","portrait":{"order_times":"","order_count":"","customer_type":"","product_preference":"","craft_preference":"","procurement_scale":"","budget_sensitivity":"","decision_mode":"","time_pattern":"","repurchase_potential":"","next_marketing":""},"intent":"high|medium|low","opportunity":"deal|repurchase|cross_sell|none","needs_followup":true/false,"followup_at":"YYYY-MM-DD可空","deal_hint":"一句话","confidence":0到1}`
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
      const portraitFields = mergePortrait(prevPortrait, j.portrait || {})
      const portraitText = formatPortraitText(portraitFields)
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
      if(isFillableDim(portraitFields.next_marketing)){
        reason = [reason, `策略:${portraitFields.next_marketing}`].filter(Boolean).join(' · ').slice(0,80)
      }
      const patch: any = {
        aiProfile: `${r.profile_cn}\n\n【十一维画像 v2】\n${portraitText}`,
        aiPortrait: portraitFields,
        aiPortraitVersion: prevEdited ? 3 : 2,
        aiProfileAt: new Date().toISOString(),
        aiIntent: r.intent,
        aiOpportunity: r.opportunity,
        aiReason: reason,
        aiCheckedAt: new Date().toISOString(),
      }
      if(prevEdited) patch.portraitEditedAt = (c as any).portraitEditedAt
      const prodStr = portraitFields.product_preference
      if(isFillableDim(prodStr)){
        const prods = String(prodStr).split(/[/、,，]/).map(s=> s.trim()).filter(s=> s && s.length < 24)
        if(prods.length) patch.portrait = { ...(c.portrait||{}), products: prods.slice(0,6) }
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
    // 批量画像：两人之间间隔，避免限流（速度可慢，保证走 AI）
    if(delayMs > 0 && idx < queue.length){
      await new Promise(res=> setTimeout(res, delayMs))
    }
  }
  if(cfg.syncTierToFollowUps) await syncTiersFromRules()
  window.dispatchEvent(new CustomEvent('evan-customers-updated'))
  return {
    results, ok, fail,
    scopeCount: scoped.length,
    queued: queue.length,
    skippedCooldown,
    note: `AI画像 v2（十一维）：本次 ${queue.length} 人 · 成功 ${ok} · 失败 ${fail}${skippedCooldown?` · 冷却跳过 ${skippedCooldown}`:''}（间隔 ${delayMs}ms）`,
  }
}

// ====== 复购开发：订单周期 + AI 洞察（绝不覆盖十一维画像）======
async function chatOnceSafe(prompt: string, timeoutMs = 45000): Promise<string> {
  return await Promise.race([
    chatOnce(prompt),
    new Promise<string>((_, reject)=> setTimeout(()=> reject(new Error('AI 超时')), timeoutMs)),
  ])
}

export async function runPurchaseLoop(opts?: {
  limit?: number
  force?: boolean
  delayMs?: number
  onProgress?: (done: number, total: number, name: string) => void
}): Promise<{
  updated: number
  totalOrdered: number
  skipped: number
  aiOk: number
  aiFail: number
  repurchaseQueued: number
  note: string
}>{
  const cfg = loadIntellectConfig()
  const cooldownMs = Math.max(0, (cfg.purchaseLoopCooldownDays || 14) * 86400000)
  const delayMs = Math.max(0, opts?.delayMs ?? 800)
  const limit = Math.max(1, opts?.limit || cfg.purchaseLoopBatchMax || 20)
  const orders = await listPurchaseOrders()
  const customers = await db.customers.toArray() as Customer[]
  const byCust = new Map<string, typeof orders>()
  for(const o of orders){
    const arr = byCust.get(o.customer_id) || []
    arr.push(o); byCust.set(o.customer_id, arr)
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
  let updated = 0, aiOk = 0, aiFail = 0, skipped = 0, repurchaseQueued = 0
  const ordered = customers.filter(c=>{
    const tags = (c.tags||[]).map(str=> String(str))
    return (byCust.get(c.id)||[]).length>0 || tags.includes('已下单')
  })
  const queue = ordered.filter(c=>{
    if(opts?.force) return true
    const at = (c as any).purchaseIntelAt
    if(!at) return true
    if(now - new Date(at).getTime() < cooldownMs){ skipped++; return false }
    return true
  }).slice(0, limit)

  let idx = 0
  for(const c of queue){
    idx++
    opts?.onProgress?.(idx, queue.length, c.contactName || c.title || c.email || c.id)
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
    const portrait = mergePortrait(
      coercePortrait((c as any).aiPortrait),
      parsePortraitFromProfile((c as any).aiProfile) || {},
    )
    const portraitText = formatPortraitText(portrait)
    let ai: any = null
    try{
      const addrs = new Set([c.email, ...(c.extraEmails||[])].filter(Boolean).map(e=> String(e).toLowerCase()))
      const hist = emails.filter(e=>{
        const from = (e.from.match(/<([^<>]+)>/)?.[1]||e.from||'').toLowerCase()
        const to = String(e.to||'').toLowerCase()
        return addrs.has(from) || [...addrs].some(a=> to.includes(a))
      }).sort((a,b)=> String(a.date||'').localeCompare(String(b.date||'')))
      const mailText = hist.slice(-30).map(e=> `[${e.date}] ${e.from}: ${e.subject} ${(e.text||'').slice(0,220)}`).join('\n').slice(0, 5000)
      const prompt = `你是 Maxemblem 外贸复购分析助手。只输出 JSON，禁止编造。
【客户背景 · 十一维画像（可能含人工修正，优先采用）】
${portraitText}

【基础】${c.contactName||c.title} ${c.email} 等级${c.level||'C'} 阶段${c.stage||''} 复购次数${c.repurchaseCount||0}
【订单】${os.map(o=> o.order_date+' '+o.products.join('/')+' $'+(o.amount||'?')).join('; ')||'无'}
距上次订单 ${daysSince} 天，估算周期 ${cycle} 天
【邮件往来（结合画像分析，勿覆盖画像）】
${mailText||'无'}

综合画像+订单+邮件输出复购经营建议：
{"buyer_type":"once|repeat|dormant|high_value","pattern":"same_product|multi_product|seasonal|unknown","cycle_days_est":数字,"next_products":["…"],"nba":"reorder|cross_sell|reactivation|nurture|none","nba_reason":"中文一句","should_contact_now":true/false,"repurchase_score":0到100,"purchase_ai_note":"3-6句中文经营分析，可引用画像维度","confidence":0到1}`
      const raw = await chatOnceSafe(prompt)
      const m = raw.match(/\{[\s\S]*\}/)
      if(m){ ai = JSON.parse(m[0]); aiOk++ }
      else aiFail++
    }catch{ aiFail++ }

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
    const score = Number(ai?.repurchase_score)
    const shouldContact = ai?.should_contact_now != null ? !!ai.should_contact_now : (nba==='reorder' || nba==='cross_sell')
    const potHigh = isFillableDim(portrait.repurchase_potential) && /高/.test(portrait.repurchase_potential)
    const repurchaseHit =
      nba==='reorder' || nba==='cross_sell'
      || (shouldContact && (buyerType==='repeat' || buyerType==='high_value'))
      || (Number.isFinite(score) && score >= 70)
      || (potHigh && cycle > 0 && daysSince >= Math.floor(cycle*0.6))

    // 写回复购字段；禁止碰 aiProfile / aiPortrait
    const patch: any = {
      purchaseTier: buyerType,
      purchasePattern: pattern,
      cycleDaysEst: cycle,
      nextWindowAt: cycle && last ? new Date(last + cycle*86400000).toISOString().slice(0,10) : undefined,
      nextBestAction: nba,
      nbaReason,
      purchaseAiNote: String(ai?.purchase_ai_note || '').slice(0, 800),
      purchaseSummary: `订单 ${os.length} 次 · ${(products.join('/')||'—')} · 距上次 ${daysSince} 天 · 周期约 ${cycle||'—'} 天`,
      purchaseIntelAt: new Date().toISOString(),
    }
    if(repurchaseHit && !suppressed && !isBucketOptOut(c, 'repurchase')){
      patch.aiTier = 'repurchase'
      patch.aiReason = nbaReason || 'AI：复购机会'
      try{
        addManualBuckets([c.id], ['repurchase'], nbaReason || '复购开发自动入桶', 'add')
        repurchaseQueued++
      }catch{ /* ignore */ }
    }
    await db.customers.update(c.id, patch)
    updated++
    if(delayMs > 0 && idx < queue.length){
      await new Promise(res=> setTimeout(res, delayMs))
    }
  }
  window.dispatchEvent(new CustomEvent('evan-customers-updated'))
  return {
    updated,
    totalOrdered: ordered.length,
    skipped,
    aiOk,
    aiFail,
    repurchaseQueued,
    note: `复购开发完成：已下单 ${ordered.length} · 本次 ${queue.length} · 更新 ${updated} · AI ${aiOk}${aiFail?`/${aiFail}失败`:''} · 进潜在复购 ${repurchaseQueued}${skipped?` · 冷却跳过 ${skipped}`:''}（每批上限 ${limit}）`,
  }
}
