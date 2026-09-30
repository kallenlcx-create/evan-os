// 跟进档案：字段规则 + 回复/阶段同步 + 模板相似度 → followStep
// 与自动跟进序列互通：followMode=auto|manual 控制序列
import { db } from '../db'
import type { Customer, EmailMessage } from '../types'
import { loadIntellectConfig } from './customerDailyClassify'
import { addManualBuckets, isBucketOptOut } from './manualBuckets'
import { isNoiseEmailAddress } from '../utils/emailHelpers'
import { startSequence, patchSequence, listAccounts } from '../repositories/emailRepository'
import { isOrderedCustomer } from './orderScan'

export type FollowMode = 'auto' | 'manual'
export type SalesStage = 'following' | 'ordered' | 'direct_order' | 'cancelled'
/** 报价状态：未报价 / 已报价 / 谈价中 / 已接受 */
export type QuoteStatus = 'none' | 'sent' | 'negotiating' | 'accepted'

export type FollowStepTemplate = {
  n: number
  name: string
  keywords: string[]
}

export const DEFAULT_FOLLOW_STEP_TEMPLATES: FollowStepTemplate[] = [
  { n: 1, name: '报价跟进', keywords: ['quotation', 'quote', 'price', '报价', 'following up on the quotation', 'artwork', 'design team'] },
  { n: 2, name: '顶邮/可调', keywords: ['floating', 'top of your inbox', 'adjust quantity', 'budget', '适配'] },
  { n: 3, name: '锁产/决策', keywords: ['reserve', 'production slot', 'finalize', '锁单', 'production slots'] },
  { n: 4, name: '成本/交期', keywords: ['raw material', 'lead time', 'trending up', 'locking in', '交期', '材料'] },
  { n: 5, name: '障碍确认', keywords: ['holding this back', 'timeline', 'payment terms', '设计', '付款'] },
  { n: 6, name: '最后跟进', keywords: ['last check', "don't clutter", 'come back', 'clutter your inbox'] },
  { n: 7, name: '收口', keywords: ['closing the loop', 'pick it right up', '收口', 'closing the loop on my side'] },
]

/** 付款链接主判定：Purchase Links / 任意支付/设计链接 */
export const PURCHASE_LINKS_LABEL_RE = /purchase\s*links?/i
export const PURCHASE_LINK_ANY_RE = /purchase\s*links?\s*:\s*https?:\/\/[^\s"'<>]+/i
export const PURCHASE_LINK_NEAR_RE = /purchase\s*links?\s*:[\s\S]{0,400}?(https?:\/\/[^\s"'<>]+)/i
export const DESIGN_NO_RE = /design_no=(\d+)/i
export const MAXEMBLEM_DESIGN_RE = /https?:\/\/[^\s"'<>]*maxemblem\.com\/design\/[^\s"'<>]*/i

export function extractPurchaseLink(text: string): { url: string; designNo: string } | null {
  let raw = String(text || '')
  if (!raw) return null
  const hrefs = [...raw.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map(m => m[1])
  raw = raw.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  const blob = raw + '\n' + hrefs.join('\n')
  const no = blob.match(DESIGN_NO_RE)
  const tight = blob.match(PURCHASE_LINK_ANY_RE)
  const near = tight ? null : blob.match(PURCHASE_LINK_NEAR_RE)
  if (tight || near || PURCHASE_LINKS_LABEL_RE.test(blob)) {
    let url = ''
    if (tight) url = tight[0].replace(/^purchase\s*links?\s*:\s*/i, '')
    else if (near) url = near[1]
    else {
      url = hrefs.find(h => /maxemblem\.com\/design/i.test(h) || /design_no=/i.test(h))
        || blob.match(MAXEMBLEM_DESIGN_RE)?.[0]
        || blob.match(/https?:\/\/[^\s"'<>]+/i)?.[0]
        || ''
    }
    return { url: String(url || '').slice(0, 300), designNo: no?.[1] || '' }
  }
  const loose = blob.match(MAXEMBLEM_DESIGN_RE) || hrefs.find(h => /design_no=\d+/i.test(h))
  if (loose || /design_no=\d+/i.test(blob)) {
    return { url: String(loose || '').slice(0, 300), designNo: no?.[1] || '' }
  }
  return null
}

/** 旧关键词：付款链接缺失时的兜底 */
export const QUOTE_SENT_KW = [
  'purchase link', 'purchase links', 'please find our quotation',
  'quotation', 'please find our quote', 'quote attached', 'price list',
  'unit price', 'final cost', 'final fee', 'mold fee', 'mold / setup', 'total us$',
  '报价单', '报价如下', 'our quotation', 'attached is the quote',
  'design team has completed', 'artwork attached', 'please find the artwork',
  'draft for your', 'project specifications',
  'complete the payment', 'click the link above',
]
const QUOTE_SHAPE_RE: RegExp[] = [
  /unit\s*price/i, /mold\s*(fee|\/\s*setup)/i, /final\s*(fee|cost)/i,
  /qty[\s\t]+unit\s*price/i, /size[\s\t]+qty/i, /\$\s*\d+(\.\d+)?/,
]
export const QUOTE_NEGO_KW = [
  'too expensive', 'too high', 'best price', 'can you do $', 'discount',
  'cheaper', 'out of budget', '太贵', '便宜', '折扣', '砍价',
]
export const QUOTE_ACCEPT_KW = [
  'approved', 'proceed with', "let's move forward", 'we accept',
  'please send invoice', 'payment sent', 'payment completed', 'ok to order',
  '确认报价', '可以下单', '已付款',
]

const RANK: Record<QuoteStatus, number> = { none: 0, sent: 1, negotiating: 2, accepted: 3 }

export function detectQuoteFromText(text: string): {
  status: QuoteStatus
  matched: string
  quoteUrl?: string
  designNo?: string
} {
  const raw = String(text || '')
  const t = raw.toLowerCase()
  if (!t) return { status: 'none', matched: '' }
  const link = extractPurchaseLink(raw)
  // 付款链接 = 强「已报价」信号（优先于零散关键词）
  if (link) {
    // 同信里有「已付款/确认」才升 accepted
    for (const k of QUOTE_ACCEPT_KW) {
      if (t.includes(k)) return { status: 'accepted', matched: k, quoteUrl: link.url, designNo: link.designNo }
    }
    return {
      status: 'sent',
      matched: link.designNo
        ? ('Purchase Links design_no=' + link.designNo)
        : (link.url ? 'Purchase Links' : 'Purchase Links'),
      quoteUrl: link.url,
      designNo: link.designNo,
    }
  }
  for (const k of QUOTE_ACCEPT_KW) {
    if (t.includes(k)) return { status: 'accepted', matched: k }
  }
  for (const k of QUOTE_NEGO_KW) {
    if (t.includes(k)) return { status: 'negotiating', matched: k }
  }
  if (PURCHASE_LINKS_LABEL_RE.test(raw) || /payment\s*link|pay\s*now|checkout\s*link/i.test(raw)) {
    return { status: 'sent', matched: 'Purchase Links/付款链接' }
  }
  for (const k of QUOTE_SENT_KW) {
    if (t.includes(k)) return { status: 'sent', matched: k }
  }
  for (const re of QUOTE_SHAPE_RE) {
    const m = raw.match(re) || t.match(re)
    if (m) return { status: 'sent', matched: m[0].slice(0, 40) }
  }
  return { status: 'none', matched: '' }
}

export function daysSince(iso?: string | null): number | null {
  if(!iso) return null
  const t = new Date(iso).getTime()
  if(!Number.isFinite(t)) return null
  return Math.floor((Date.now()-t)/86400000)
}

export function salesStageOf(c: Customer): SalesStage {
  const s = String((c as any).salesStage || '')
  if (s === 'ordered' || s === 'cancelled' || s === 'following' || s === 'direct_order') return s
  const tags = (c.tags||[]).map(String)
  if (tags.includes('取消') || (c.stage === 'lost' && tags.includes('取消'))) return 'cancelled'
  if (tags.includes('直接下单')) return 'direct_order'
  if (isOrderedCustomer(c) || c.stage === 'won' || tags.includes('已下单') || tags.includes('订单')) return 'ordered'
  return 'following'
}

export function followModeOf(c: Customer): FollowMode {
  const m = String((c as any).followMode || '')
  if (m === 'auto' || m === 'manual') return m
  return 'manual'
}

export function quoteStatusOf(c: Customer): QuoteStatus {
  const q = String((c as any).quoteStatus || '')
  if (q === 'none' || q === 'sent' || q === 'negotiating' || q === 'accepted') {
    if (q === 'none') {
      const tags = (c.tags || []).map(String)
      if (tags.includes('已报价') || tags.includes('已接受')) return tags.includes('已接受') ? 'accepted' : 'sent'
    }
    return q
  }
  return 'none'
}

export function quoteStatusLabel(s: QuoteStatus){
  return s === 'sent' ? '已报价' : s === 'negotiating' ? '谈价中' : s === 'accepted' ? '已接受' : '未报价'
}

export function quoteStatusClass(s: QuoteStatus){
  return s === 'sent' ? 'bg-blue-50 text-blue-700'
    : s === 'negotiating' ? 'bg-orange-50 text-orange-700'
    : s === 'accepted' ? 'bg-green-100 text-green-700'
    : 'bg-gray-100 text-gray-500'
}

const STOP = new Set(['your','you','the','and','for','with','from','this','that','have','will','best','regards','dear','hello','please','just','would','could','about','email','thanks','thank','evan','maxemblem','following','follow','check','checking'])

const SELF = new Set(['evan@maxemblem.com'])

function extractAddr(raw: string){
  return String(raw||'').match(/<([^<>@\s]+@[^<>\s]+)>/)?.[1]
    || String(raw||'').match(/([^\s<>,;]+@[^\s<>,;]+)/)?.[1]
    || ''
}

/** 我方发件人：Gmail 常把收发都放 All Mail，不能只看 folder==='sent' */
export function isSelfSender(fromRaw: string, folder?: string): boolean {
  const f = extractAddr(fromRaw).toLowerCase()
  const fd = String(folder || '').toLowerCase()
  const folderSent = fd === 'sent' || fd.includes('sent mail') || fd.includes('/sent') || fd.includes('发件')
  if (!f) return folderSent
  if (SELF.has(f)) return true
  if (f.endsWith('@maxemblem.com') && !f.startsWith('noreply')) return true
  return folderSent
}

function involvesCustomer(e: EmailMessage, set: Set<string>): boolean {
  const from = extractAddr(e.from).toLowerCase()
  if (from && set.has(from)) return true
  const to = `${String(e.to||'')},${String((e as any).cc||'')},${String((e as any).bcc||'')}`
  return to.toLowerCase().split(/[,;]/).some(x => {
    const a = extractAddr(x).toLowerCase()
    return a && set.has(a)
  })
}

function mailBodyText(e: EmailMessage): string {
  const text = String(e.text || '')
  const html = String((e as any).html || '')
  if (text && /purchase\s*links?|design_no=/i.test(text)) return text
  if (html) {
    const hrefs = [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]).join('\n')
    const stripped = html.replace(/<[^>]+>/g, ' ')
    return [text, stripped, hrefs].filter(Boolean).join('\n')
  }
  return text
}

export function customerAddrs(c: Customer): string[] {
  return [c.email, ...(c.extraEmails||[])].filter(Boolean).map(e=> String(e).toLowerCase().trim())
}

/** 扫描客户邮件，识别报价状态（取最高状态） */
export function detectQuoteFromMails(c: Customer, emails: EmailMessage[], selfAddrs: string[] = ['evan@maxemblem.com']){
  const addrs = customerAddrs(c)
  const set = new Set(addrs.map(a => a.toLowerCase()))
  let best: QuoteStatus = 'none'
  let matched = ''
  let quoteAt = ''
  let quoteUrl = ''
  let designNo = ''
  for (const e of emails) {
    if (!involvesCustomer(e, set)) continue
    const from = extractAddr(e.from).toLowerCase()
    const isSent = selfAddrs.some(s => from.includes(s)) || isSelfSender(e.from, e.folder)
    const text = `${e.subject||''}\n${mailBodyText(e)}`
    let st: QuoteStatus = 'none'
    let hit = ''
    let url = ''
    let no = ''
    if (isSent) {
      const d = detectQuoteFromText(text)
      if (d.status === 'accepted' || d.status === 'sent' || d.status === 'negotiating') {
        st = d.status === 'negotiating' ? 'sent' : d.status
        hit = d.matched
        url = d.quoteUrl || ''
        no = d.designNo || ''
        if (st === 'sent' && RANK[best] < 1) quoteAt = e.date || quoteAt
      }
    } else {
      const d = detectQuoteFromText(text)
      st = d.status
      hit = d.matched
      url = d.quoteUrl || ''
      no = d.designNo || ''
    }
    if (RANK[st] > RANK[best]) {
      best = st
      matched = hit || matched
      if (url) quoteUrl = url
      if (no) designNo = no
    } else if (RANK[st] === RANK[best] && url && !quoteUrl) {
      quoteUrl = url
      if (no) designNo = no
    }
  }
  return { status: best, matched, quoteAt, quoteUrl, designNo }
}

/** 从用户保存的序列模板提取关键词，供「跟进状态」相似度判断 */
export function templatesFromSeqTemplates(list: any[]): FollowStepTemplate[] {
  if (!list?.length) return []
  const sorted = [...list].map((t, i) => {
    const id = String(t.id || '')
    let n = i + 1
    const m1 = id.match(/(\d+)\s*$/)
    const m2 = String(t.name || '').match(/(\d+)/)
    if (m1) n = Number(m1[1]) || (i + 1)
    else if (m2) n = Number(m2[1]) || (i + 1)
    return { t, n }
  }).sort((a, b) => a.n - b.n).slice(0, 7)

  // 只保留「本步独有」关键词，避免跟进1–5 主题/客套话雷同导致乱跳
  const bags = sorted.map(({ t }) => {
    const raw = `${t.subject || ''}\n${t.body || ''}`
    const text = raw.toLowerCase()
    const cjk = (raw.match(/[\u4e00-\u9fff]{2,12}/g) || []).map(x => x.toLowerCase())
    const words = text.split(/[^a-z0-9']+/).filter(w => w.length >= 3 && !STOP.has(w))
    const phrases: string[] = []
    for (let k = 0; k < words.length - 1; k++) {
      phrases.push(words[k] + ' ' + words[k + 1])
      if (k < words.length - 2) phrases.push(words[k] + ' ' + words[k + 1] + ' ' + words[k + 2])
    }
    return { subj: String(t.subject || '').toLowerCase().trim(), cjk, phrases, words }
  })
  const countMap = new Map<string, number>()
  for (const b of bags) {
    for (const k of new Set([...b.cjk, ...b.phrases, ...b.words.filter(w => w.length >= 5)])) {
      countMap.set(k, (countMap.get(k) || 0) + 1)
    }
  }
  const out: FollowStepTemplate[] = []
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i].t
    const n = sorted[i].n
    const name = String(t.name || `跟进${n}`)
    const b = bags[i]
    const uniqPhrases = b.phrases.filter(k => (countMap.get(k) || 0) === 1)
    const uniqWords = b.words.filter(w => w.length >= 5 && (countMap.get(w) || 0) === 1)
    const uniqCjk = b.cjk.filter(k => (countMap.get(k) || 0) === 1)
    const subjCount = bags.filter(x => x.subj === b.subj).length
    const subjUnique = b.subj && subjCount === 1 ? b.subj : ''
    const keywords = [...new Set([
      subjUnique,
      ...uniqCjk.slice(0, 6),
      ...uniqPhrases.slice(0, 10),
      ...uniqWords.slice(0, 10),
    ])].filter(k => k && k.length >= 2).slice(0, 16)
    const def = DEFAULT_FOLLOW_STEP_TEMPLATES[n - 1]
    out.push({
      n,
      name,
      keywords: keywords.length >= 2 ? keywords : (def?.keywords || keywords),
    })
  }
  return out

}

/** 关键词/片段相似度：覆盖 + 主题包含；templates 优先用「用户在序列模板里填的文案」 */
export function matchFollowStep(subject: string, body: string, templates?: FollowStepTemplate[], threshold?: number){
  const list = templates?.length ? templates : DEFAULT_FOLLOW_STEP_TEMPLATES
  const th = threshold ?? (loadIntellectConfig().followSimThreshold || 0.6)
  const s = `${subject||''}\n${body||''}`.toLowerCase()
  if (!s.trim()) return { step: 0, score: 0, matched: '' }
  let best = { step: 0, score: 0, matched: '' }
  for (const t of list) {
    const kws = (t.keywords || []).map(k => String(k).toLowerCase()).filter(Boolean)
    if (!kws.length) continue
    let hit = 0
    let phraseHit = 0
    const hitList: string[] = []
    for (const k of kws) {
      if (s.includes(k)) {
        hit++
        if (k.includes(' ') || /[一-鿿]/.test(k)) phraseHit++
        hitList.push(k)
      }
    }
    let score = hit / Math.max(kws.length, 1)
    if (phraseHit > 0) score = Math.min(1, score + 0.15 * Math.min(phraseHit, 3))
    const subj = String(subject || '').toLowerCase()
    if (subj && kws.some(k => subj.includes(k))) score = Math.min(1, score + 0.25)
    if (kws.length <= 3 && hit >= 1) score = Math.max(score, 0.7)
    if (hit >= 3) score = Math.max(score, 0.65)
    const total = score
    if (total >= th && (total > best.score || (total === best.score && t.n > best.step))) {
      best = { step: t.n, score: total, matched: hitList.slice(0, 5).join(',') || t.name }
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
  quotesUpdated: number
  note: string
}

/** 从本地邮件计算客户最近回复/我方最近发出 */
export function computeMailTimes(emails: EmailMessage[], addrs: string[]){
  const set = new Set(addrs.map(a=> a.toLowerCase()))
  let lastReply: string | null = null
  let lastSent: string | null = null
  for (const e of emails) {
    const from = extractAddr(e.from).toLowerCase()
    const isSelf = isSelfSender(e.from, e.folder)
    if (!isSelf && from && set.has(from)) {
      if (!lastReply || String(e.date) > lastReply) lastReply = String(e.date)
    }
    if (isSelf && involvesCustomer(e, set)) {
      if (!lastSent || String(e.date) > lastSent) lastSent = String(e.date)
    }
  }
  return { lastReply, lastSent }
}

/** 客户上次回复之后，我方发给该客户的邮件数量 */
export function countFollowsSinceReply(emails: EmailMessage[], addrs: string[], lastReply: string | null): number {
  const set = new Set(addrs.map(a=> a.toLowerCase()))
  const since = lastReply || ''
  let n = 0
  for (const e of emails) {
    if (!isSelfSender(e.from, e.folder)) continue
    if (!involvesCustomer(e, set)) continue
    if (since && String(e.date || '') < since) continue
    n++
  }
  return n
}

/** 读邮件上下文 + 十一维 → 生成专业跟进英文（只返回正文） */
export async function generateAiFollowReply(c: Customer, emails: EmailMessage[]): Promise<{ subject: string; body: string }>{
  const { chatOnce } = await import('./aiChat')
  const { mergePortrait, coercePortrait, parsePortraitFromProfile, formatPortraitText } = await import('../config/portrait')
  const addrs = customerAddrs(c)
  const set = new Set(addrs.map(a => a.toLowerCase()))
  const hist = emails.filter(e => involvesCustomer(e, set))
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || ''))).slice(-15)
  const portrait = mergePortrait(coercePortrait((c as any).aiPortrait), parsePortraitFromProfile((c as any).aiProfile) || {})
  const portraitText = formatPortraitText(portrait)
  const mailText = hist.map(e => `[${e.date}] ${isSelfSender(e.from, e.folder) ? '我方' : '客户'} ${e.subject}\n${mailBodyText(e).slice(0, 300)}`).join('\n---\n').slice(0, 4500)
  const prompt = `你是 Maxemblem 外贸业务员 Evan。根据客户画像与邮件上下文，写一封专业、简洁的英文跟进邮件正文。
【十一维画像】
${portraitText}
【客户】${c.contactName||c.title} ${c.email} 等级${c.level||'C'}
【往来】
${mailText||'无'}
要求：只输出邮件正文（不要主题、不要解释）；语气专业友好；结合产品/订单/画像；结尾留一句明确行动引导；落款 Best regards,\\nEvan。不超过180词。`
  const body = String(await chatOnce(prompt) || '').trim()
  const { findLatestThreadHeaders } = await import('../repositories/emailRepository')
  const th = await findLatestThreadHeaders(c.email||'').catch(()=>({ found:false, messageId:'', subject:'' } as any))
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
  for (const s of opts?.sequences || []) seqMap.set(s.customer_id, s)

  const fromUser = templatesFromSeqTemplates(opts?.seqTemplates || [])
  const templates = fromUser.length ? fromUser : ((cfg as any).followStepTemplates as FollowStepTemplate[] | undefined)
  const th = (cfg as any).followSimThreshold || 0.6
  const ts = new Date().toISOString()
  let replies = 0, modeChanged = 0, stepsUpdated = 0, highQueued = 0, ordersStopped = 0, quotesUpdated = 0
  const scanned = customers.length

  for (const c of customers) {
    if (!c.email && !(c.extraEmails||[]).length) continue
    if (isNoiseEmailAddress(c.email)) continue
    const addrs = customerAddrs(c)
    const { lastReply, lastSent } = computeMailTimes(emails, addrs)
    const followCount = countFollowsSinceReply(emails, addrs, lastReply)
    const stage = salesStageOf(c)
    let followMode = followModeOf(c)
    let hasReply = String((c as any).hasReply || '') === 'yes'
    if (lastReply) {
      hasReply = true
      replies++
    }
    const seq = seqMap.get(c.id)
    if (seq?.replied) hasReply = true
    if (hasReply && (cfg as any).followReplyToManual !== false) {
      if (followMode !== 'manual') {
        followMode = 'manual'
        modeChanged++
      }
      if (seq && seq.mode === 'auto') {
        try { await patchSequence(c.id, { mode: 'manual' }) } catch { /* server optional */ }
      }
    }
    // 默认关闭「有回复→高意向」；仅当用户显式打开 followReplyToHigh === true
    if (hasReply && (cfg as any).followReplyToHigh === true && !isBucketOptOut(c, 'high')) {
      if (!(c as any).aiTier || (c as any).aiTier !== 'high') {
        try {
          await db.customers.update(c.id, { aiTier: 'high', aiReason: '有客户回复', aiCheckedAt: ts } as any)
        } catch {}
      }
      try { addManualBuckets([c.id], ['high'], '客户有回复', 'add'); highQueued++ } catch {}
    }
    if (stage === 'ordered' || stage === 'direct_order' || stage === 'cancelled') {
      const stop = stage === 'ordered' || stage === 'direct_order'
        ? (cfg as any).followStopSeqOnOrder !== false
        : (cfg as any).followStopSeqOnCancel !== false
      if (stop && seq && seq.mode === 'auto') {
        try { await patchSequence(c.id, { mode: 'manual' }) } catch {}
        ordersStopped++
        followMode = 'manual'
      }
    }
    let followStep = Number((c as any).followStep || 0)
    let followStepMatched = String((c as any).followStepMatched || '')
    if (seq && Number(seq.current_step) > 0) {
      const sentSteps = (seq.steps || []).filter((t: any) => t.status === 'sent').length
      const step = sentSteps > 0 ? sentSteps : 0
      if (step > 0) {
        followStep = Math.max(followStep, step)
        followStepMatched = `序列 ${step}/7`
        stepsUpdated++
      }
    } else if (lastSent || (c as any).followCountSinceReply > 0 || opts?.forceStepScan) {
      const scan = bestFollowStepFromMails(emails, addrs, templates, th)
      if (scan.step > 0 && scan.step !== followStep) {
        followStep = scan.step
        followStepMatched = scan.matched
        stepsUpdated++
      } else if (!followStep && scan.step > 0) {
        followStep = scan.step
        followStepMatched = scan.matched
        stepsUpdated++
      }
    }

    const patch: any = {
      hasReply: hasReply ? 'yes' : 'no',
      lastReplyAt: lastReply || null,
      lastFollowAt: lastSent || (c as any).lastFollowAt || null,
      followCountSinceReply: followCount,
      followMode,
      followModeSource: hasReply && followMode === 'manual' && followModeOf(c) !== 'manual' ? 'reply' : ((c as any).followModeSource || 'system'),
      salesStage: stage,
      followStep,
      followStepLabel: stepLabel(followStep),
      followStepMatched,
      updatedAt: ts,
    }
    try {
      const q = detectQuoteFromMails(c, emails)
      const prevQ = quoteStatusOf(c)
      if (q.status !== 'none' && RANK[q.status] >= RANK[prevQ]) {
        patch.quoteStatus = q.status
        patch.quoteMatched = q.matched
        if (q.quoteUrl) patch.quoteUrl = q.quoteUrl
        if (q.designNo) patch.designNo = q.designNo
        if (q.quoteAt || !(c as any).quoteAt) patch.quoteAt = (c as any).quoteAt || q.quoteAt || ts
        quotesUpdated++
      }
      // 已报价/付款链接 → 至少 跟进1
      const nowQ = (patch.quoteStatus as QuoteStatus) || quoteStatusOf(c)
      if (nowQ !== 'none' && !(patch.followStep > 0)) {
        patch.followStep = 1
        patch.followStepLabel = stepLabel(1)
        if (!patch.followStepMatched) patch.followStepMatched = (q as any).designNo ? ('付款链接 ' + (q as any).designNo) : '付款链接/报价'
        stepsUpdated++
      }
    } catch {}
    const mailBiz = businessCreatedAt(c, { emails })
    const prevInq = String((c as any).inquiryAt || '').slice(0, 10)
    const inqDate = String((c as any).inquiryAt || '').slice(0, 10)
    const biz = inqDate || (prevInq || mailBiz)
    if (biz && biz !== createdAtOf(c) && /^\d{4}-\d{2}-\d{2}$/.test(biz)) {
      patch.inquiryAt = (c as any).inquiryAt || biz
    }
    if (hasReply && lastReply) patch.lastReplyAt = lastReply
    await db.customers.update(c.id, patch)
  }

  window.dispatchEvent(new CustomEvent('evan-customers-updated'))
  const note = `跟进档案：扫描 ${scanned} · 回复 ${replies} · 转手动 ${modeChanged} · 步号 ${stepsUpdated} · 报价 ${quotesUpdated} · 高意向+${highQueued}${ordersStopped ? ` · 停序列 ${ordersStopped}` : ''}`
  return { scanned, replies, modeChanged, stepsUpdated, highQueued, ordersStopped, quotesUpdated, note }
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
  try {
    const accs = await listAccounts()
    if (accs.length && c.email && !isNoiseEmailAddress(c.email)) {
      if (mode === 'auto' && stage === 'following') {
        try {
          const { getSequences } = await import('../repositories/emailRepository')
          const j = await getSequences()
          const has = (j.sequences || []).some((s: any) => s.customer_id === c.id)
          if (has) await patchSequence(c.id, { mode: 'auto', fromStep: Math.max(1, Number((c as any).followStep || 0) + 1) })
          else await startSequence({ customerId: c.id, email: c.email, accountId: accs[0].id })
        } catch {
          await startSequence({ customerId: c.id, email: c.email, accountId: accs[0].id })
        }
      } else if (mode === 'manual') {
        await patchSequence(c.id, { mode: 'manual' })
      }
    }
  } catch { /* 无服务器时仅改本地档案 */ }
  window.dispatchEvent(new CustomEvent('evan-customers-updated'))
}

/** 保存销售阶段（已下单/取消/跟进中）并联动停序列 */
export async function setCustomerSalesStage(c: Customer, stage: SalesStage){
  const cfg = loadIntellectConfig()
  const ts = new Date().toISOString()
  const tags = new Set([...(c.tags || []).map(String)])
  if (stage === 'ordered') { tags.add('已下单'); tags.add('订单'); tags.delete('直接下单') }
  if (stage === 'direct_order') { tags.add('直接下单'); tags.delete('已下单'); tags.delete('订单') }
  if (stage === 'cancelled') { tags.add('取消') }
  if (stage === 'following') { tags.delete('取消'); tags.delete('直接下单') }
  const patch: any = {
    salesStage: stage,
    tags: [...tags],
    updatedAt: ts,
  }
  if (stage === 'ordered') patch.stage = c.stage === 'lost' ? c.stage : 'won'
  if (stage === 'cancelled') patch.stage = 'lost'
  if (stage === 'ordered' || stage === 'direct_order' || stage === 'cancelled') {
    patch.followMode = 'manual'
    patch.followModeSource = 'system'
  }
  await db.customers.update(c.id, patch)
  const stop = (stage === 'ordered' || stage === 'direct_order') ? cfg.followStopSeqOnOrder !== false : stage === 'cancelled' ? cfg.followStopSeqOnCancel !== false : false
  if (stop) {
    try { await patchSequence(c.id, { mode: 'manual' }) } catch {}
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
    if (!v) return ''
    const s = String(v).slice(0, 10)
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''
  }
  const inquiryAt = fromIso((c as any).inquiryAt) || fromIso(opts?.inquiryDate)
  if (inquiryAt) return inquiryAt

  if (opts?.emails?.length) {
    const addrs = customerAddrs(c)
    const set = new Set(addrs.map(a => a.toLowerCase()))
    let earliest = ''
    for (const e of opts.emails) {
      if (!involvesCustomer(e, set)) continue
      const d = fromIso(e.date)
      if (d && (!earliest || d < earliest)) earliest = d
    }
    if (earliest) return earliest
  }

  const firstSent = fromIso((c as any).firstSentAt)
  if (firstSent) return firstSent
  const lastFollow = fromIso((c as any).lastFollowAt)
  if (lastFollow) return lastFollow
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
  if (!addr.includes('@')) return true
  const local = addr.split('@')[0] || ''
  const domain = addr.split('@')[1] || ''
  if (local.startsWith('noreply') || local.startsWith('no-reply') || local.startsWith('donotreply')) return true
  const noiseLocal = ['welcome','service','info','marketing','announce','newsletter','bounce','mailer-daemon','postmaster','notifications']
  if (noiseLocal.includes(local)) return true
  const noiseDom = [
    'wordpress.com','blogger.com','googlemail.com','youtube.com','quora.com',
    'support.whatsapp.com','abnewswire.com','slickdeals.net','dealnews.com',
    'bradsdeals.com','getmecodes.com','mediafuse.org','flipboard.com',
  ]
  if (noiseDom.includes(domain) || domain.endsWith('.blogger.com')) return true
  if (domain === 'microsoft.com' || domain.endsWith('.microsoft.com')) {
    if (/outlook|exchange|notifications/.test(local)) return true
  }
  return isNoiseEmailAddress(email)
}

/** 从该客户「我方发出」的最近邮件里找最匹配的模板步号 */
export function bestFollowStepFromMails(
  emails: EmailMessage[],
  addrs: string[],
  templates?: FollowStepTemplate[],
  threshold?: number,
): { step: number; matched: string; lastSent: string | null; count: number; designNo?: string } {
  const set = new Set(addrs.map(a => a.toLowerCase()))
  const mine = emails.filter(e => {
    if (!isSelfSender(e.from, e.folder)) return false
    return involvesCustomer(e, set)
  }).sort((a, b) => String(a.date || '').localeCompare(String(b.date || ''))) // 旧→新，数进度
  const lastSent = mine.length ? String(mine[mine.length - 1].date || '') : null
  let step = 0
  let matched = ''
  let designNo = ''
  let afterQuote = 0
  let sawQuote = false
  for (const e of mine) {
    const body = mailBodyText(e)
    const text = `${e.subject || ''}\n${body}`
    const link = extractPurchaseLink(text)
    const q = link ? { status: 'sent' as const, matched: link.designNo ? ('付款链接 design_no='+link.designNo) : '付款链接' } : detectQuoteFromText(text)
    if (link?.designNo) designNo = link.designNo
    // 付款链接发出 → 跟进1（报价）
    if (q.status !== 'none' && !sawQuote) {
      sawQuote = true
      afterQuote = 0
      if (step < 1) { step = 1; matched = q.matched || '付款链接/报价' }
    } else if (sawQuote && !link) {
      // 报价之后我方再发的跟进信：跟进2、3…
      afterQuote++
      const next = Math.min(7, 1 + afterQuote)
      if (next > step) { step = next; matched = '报价后第' + afterQuote + '次跟进' }
    }
    // 用户保存的 7 步文案相似度（可抬高）
    const m = matchFollowStep(e.subject || '', body, templates, threshold)
    if (m.step > step && (m.score >= 0.75 || !templates?.length)) {
      step = m.step
      matched = m.matched || matched
    }
  }
  if (!step && mine.length && sawQuote) step = 1
  return { step, matched, lastSent, count: mine.length, designNo }
}
