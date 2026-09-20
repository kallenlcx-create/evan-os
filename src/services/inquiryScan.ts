// 询盘 P0：INQC 解析 + 无回执/有回执合并建档 + 客户关联
// INQC + YYMMDD(6) + 当日流水(5+)，如 INQC26091900018 → 2026-09-19 第18条
import { db } from '../db'
import type { Customer, EmailMessage } from '../types'
import { uid, now } from '../repositories/result'
import { isNoiseEmailAddress } from '../utils/emailHelpers'
import { isBoardNoiseEmail } from './followProfile'

export type InquiryRecord = {
  id: string
  inquiryNo: string
  inquiryDate: string
  seqNo: number
  customerId?: string
  customerName?: string
  customerEmail?: string
  phone?: string
  sku?: string
  qty?: number | null
  productName?: string
  amount?: number | null
  comments?: string
  status: 'new' | 'contacted' | 'replied' | 'won' | 'cancelled' | 'pending_contact'
  completeness: 'L0' | 'L1' | 'L2'
  source: 'mail_inqc' | 'receipt' | 'manual'
  sourceMailIds: string[]
  createdAt: string
  updatedAt: string
}

const INQ_KIND = 'inquiry'
const SELF = new Set(['evan@maxemblem.com'])
const SYSTEM_FROM = /support@maxemblem\.com|noreply@maxemblem\.com|no-reply@maxemblem\.com/i

function extractAddr(raw: string){
  return String(raw||'').match(/<([^<>@\s]+@[^<>\s]+)>/)?.[1]
    || String(raw||'').match(/([^\s<>,;]+@[^\s<>,;]+)/)?.[1]
    || ''
}

export type InqcHit = { inquiryNo: string; ymd: string; seq: number; date: string }

/** 从任意文本提取 INQC（大写），可多个 */
export function extractInqcList(text: string): InqcHit[] {
  const out: InqcHit[] = []
  const re = /\b(INQC)(\d{6})(\d{3,})\b/gi
  let m: RegExpExecArray | null
  const seen = new Set<string>()
  while((m = re.exec(String(text||''))) !== null){
    const no = (m[1] + m[2] + m[3]).toUpperCase()
    if(seen.has(no)) continue
    seen.add(no)
    const ymd = m[2]
    const seq = Number(m[3]) || 0
    const yy = Number(ymd.slice(0,2))
    const mm = Number(ymd.slice(2,4))
    const dd = Number(ymd.slice(4,6))
    const year = 2000 + yy
    let date = `${year}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`
    if(!(mm>=1 && mm<=12 && dd>=1 && dd<=31)) date = ''
    out.push({ inquiryNo: no, ymd, seq, date })
  }
  return out
}

export function isInquiryReceipt(mail: EmailMessage): boolean {
  const from = extractAddr(mail.from).toLowerCase()
  const subj = String(mail.subject||'')
  const text = String(mail.text||'')
  if(SYSTEM_FROM.test(from) && (/^inquiry:/i.test(subj) || /\bINQC\d+/i.test(subj) || /inquiry\s*(info|'s information)/i.test(text))) return true
  if(/Inquiry Info|OrderID\s*:|Sku\s*:/i.test(text) && /\bINQC\d+/i.test(subj+text)) return true
  return false
}

/** 从主题猜产品名 */
function productFromSubject(subj: string): string {
  const s = String(subj||'').toLowerCase()
  if(/patch/.test(s)) return 'Patch'
  if(/coin|challenge/.test(s)) return 'Coin'
  if(/\bpin/.test(s)) return 'Pin'
  if(/medal/.test(s)) return 'Medal'
  if(/belt/.test(s)) return 'Belt'
  if(/trophy/.test(s)) return 'Trophy'
  if(/key\s*chain|keychain/.test(s)) return 'Keychain'
  return ''
}

function nameFromSubject(subj: string): string {
  // Maxemblem--Custom Patches for Robert Keelen Jr. INQC…
  const m = String(subj||'').match(/\bfor\s+([A-Z][A-Za-z0-9'.,\- ]{2,60})\s+INQC/i)
    || String(subj||'').match(/\bfor\s+([A-Z][A-Za-z0-9'.,\- ]{2,60})$/)
  return m ? m[1].replace(/\s+INQC.*$/i,'').trim() : ''
}

/** 系统回执字段解析 */
export function parseReceiptFields(mail: EmailMessage): Partial<InquiryRecord> {
  const subj = String(mail.subject||'')
  const text = String(mail.text||'')
  const all = `${subj}\n${text}`
  const field = (key: string) => {
    const m = all.match(new RegExp(`${key}\\s*:\\s*([^\\n\\r]+)`, 'i'))
    return m ? m[1].trim() : ''
  }
  const email = field('Email') || field('E-mail')
  const name = field('Name')
  const phone = field('Phone')
  const sku = field('Sku') || field('SKU')
  const qtyRaw = field('Qty')
  const product = field('Product Name') || productFromSubject(subj)
  const comments = field('Order Comments') || field('Comments')
  // 主题金额 156.10(USD) / $156
  const am = subj.match(/(\d{1,6}(?:\.\d{1,2})?)\s*\(\s*USD/i) || subj.match(/USD\s*(\d{1,6}(?:\.\d{1,2})?)/i) || all.match(/\$\s*(\d{1,6}(?:\.\d{1,2})?)/)
  return {
    customerEmail: email && email.includes('@') ? email.toLowerCase() : '',
    customerName: name || '',
    phone,
    sku,
    qty: qtyRaw ? (Number(qtyRaw.replace(/[^\d.]/g,'')) || null) : null,
    productName: product || '',
    amount: am ? Number(am[1]) : null,
    comments,
  }
}

function completenessOf(r: { customerEmail?: string; productName?: string; qty?: number|null; amount?: number|null }): InquiryRecord['completeness'] {
  if(!r.customerEmail) return 'L0'
  if(r.productName || r.qty || r.amount) return 'L2'
  return 'L1'
}

async function loadInquiries(): Promise<InquiryRecord[]> {
  try {
    const rows = await db.collections.where('kind').equals(INQ_KIND).toArray() as any[]
    return rows.map(r => (r.data || r) as InquiryRecord).filter(x => x && x.inquiryNo)
  } catch { return [] }
}

async function saveInquiry(rec: InquiryRecord) {
  const id = `inq-${rec.inquiryNo}`
  try {
    await db.collections.put({
      id,
      kind: INQ_KIND,
      category: rec.status,
      data: { ...rec, id },
      createdAt: rec.createdAt || now(),
      updatedAt: rec.updatedAt || now(),
    } as any)
  } catch { /* ignore */ }
}

/** 空字段合并：不覆盖已有非空 */
function mergeInquiry(prev: InquiryRecord | undefined, next: Partial<InquiryRecord> & { inquiryNo: string }): InquiryRecord {
  const ts = now()
  const base: InquiryRecord = prev || {
    id: `inq-${next.inquiryNo}`,
    inquiryNo: next.inquiryNo,
    inquiryDate: next.inquiryDate || '',
    seqNo: next.seqNo || 0,
    status: 'new',
    completeness: 'L0',
    source: next.source || 'mail_inqc',
    sourceMailIds: [],
    createdAt: ts,
    updatedAt: ts,
  }
  const pick = <K extends keyof InquiryRecord>(k: K, nv: InquiryRecord[K] | undefined | null): InquiryRecord[K] => {
    const a = nv as any
    const b = base[k] as any
    if(a !== undefined && a !== null && String(a) !== '' && !(typeof a === 'number' && Number.isNaN(a))) return a
    return b
  }
  const merged: InquiryRecord = {
    ...base,
    inquiryDate: pick('inquiryDate', next.inquiryDate),
    seqNo: pick('seqNo', next.seqNo),
    customerId: pick('customerId', next.customerId),
    customerName: pick('customerName', next.customerName),
    customerEmail: pick('customerEmail', next.customerEmail),
    phone: pick('phone', next.phone),
    sku: pick('sku', next.sku),
    qty: next.qty != null ? next.qty : base.qty,
    productName: pick('productName', next.productName),
    amount: next.amount != null ? next.amount : base.amount,
    comments: pick('comments', next.comments),
    sourceMailIds: [...new Set([...(base.sourceMailIds||[]), ...(next.sourceMailIds||[])])],
    updatedAt: ts,
    source: next.source === 'receipt' ? 'receipt' : (base.source === 'receipt' ? 'receipt' : (next.source || base.source)),
  }
  merged.completeness = completenessOf(merged)
  return merged
}

/** 确保客户存在（噪声不建）；返回 id 或 null */
export async function ensureInquiryCustomer(email: string, name: string): Promise<string | null> {
  const addr = String(email||'').toLowerCase().trim()
  if(!addr || !addr.includes('@')) return null
  if(isNoiseEmailAddress(addr) || isBoardNoiseEmail(addr) || addr.includes('maxemblem.com')) return null
  try {
    const existing = await db.customers.filter((c: any) =>
      String(c.email||'').toLowerCase() === addr
      || (c.extraEmails||[]).some((e: string)=> String(e).toLowerCase() === addr)
    ).first() as Customer | undefined
    if(existing){
      const tags = new Set([...(existing.tags||[]).map(String), '询盘'])
      await db.customers.update(existing.id, { tags: [...tags], updatedAt: now() } as any)
      return existing.id
    }
    const rec: any = {
      id: uid(),
      type: 'customer',
      title: (name||'').trim() || addr.split('@')[0],
      description: '',
      emoji: '👤',
      tags: ['询盘','邮件'],
      createdAt: now(),
      updatedAt: now(),
      relations: [],
      company: '',
      email: addr,
      stage: 'lead',
      isKey: false,
      level: 'C',
      salesStage: 'following',
      followMode: 'manual',
      hasReply: 'no',
      inquiryAt: undefined as string | undefined,
      followUpAt: new Date(Date.now() + 2*86400000).toISOString().slice(0,10),
    }
    await db.customers.put(rec)
    return rec.id
  } catch { return null }
}

/**
 * 从邮件同步询盘（P0）
 * - 主题/正文含 INQC 即建档（无需回执）
 * - 系统回执补全字段
 * - 我方已联系过的单号 → status=contacted
 */
export async function syncInquiriesFromMails(emails?: EmailMessage[]): Promise<{
  scanned: number
  inquiries: number
  created: number
  updated: number
  pendingContact: number
  note: string
}> {
  const mails = emails || await db.emails.toArray() as EmailMessage[]
  const byNo = new Map<string, InquiryRecord>()
  for(const r of await loadInquiries()) byNo.set(r.inquiryNo, r)

  let created = 0, updated = 0, pendingContact = 0
  const hits = new Map<string, { mails: EmailMessage[]; hit: InqcHit }>()

  for(const e of mails){
    const blob = `${e.subject||''}\n${e.text||''}\n${(e as any).html||''}`
    const list = extractInqcList(blob)
    if(!list.length) continue
    for(const hit of list){
      const cur = hits.get(hit.inquiryNo) || { mails: [], hit }
      cur.mails.push(e)
      if(hit.date && !cur.hit.date) cur.hit = hit
      hits.set(hit.inquiryNo, cur)
    }
  }

  for(const [no, pack] of hits){
    const prev = byNo.get(no)
    const mailsFor = pack.mails
    const receipt = mailsFor.find(m=> isInquiryReceipt(m))
    const customerMail = mailsFor.find(m=>{
      const from = extractAddr(m.from).toLowerCase()
      return from && !from.includes('maxemblem.com') && !isBoardNoiseEmail(from) && !SELF.has(from)
    })
    const selfMail = mailsFor.find(m=>{
      const from = extractAddr(m.from).toLowerCase()
      return SELF.has(from) || from.includes('maxemblem.com')
    })

    let email = ''
    let name = ''
    let product = ''
    let partial: Partial<InquiryRecord> = {}
    let source: InquiryRecord['source'] = 'mail_inqc'
    let status: InquiryRecord['status'] = 'new'

    if(receipt){
      partial = parseReceiptFields(receipt)
      email = partial.customerEmail || ''
      name = partial.customerName || ''
      product = partial.productName || ''
      source = 'receipt'
    }
    if(!email && customerMail){
      email = extractAddr(customerMail.from).toLowerCase()
      if(!name) name = String(customerMail.from||'').split('<')[0].trim()
      if(!product) product = productFromSubject(customerMail.subject||'')
      if(customerMail) status = 'replied'
    }
    if(!email && selfMail){
      // 我方信：从主题 for XXX / to 客户推断
      const subj = selfMail.subject||''
      if(!name) name = nameFromSubject(subj)
      if(!product) product = productFromSubject(subj)
      const to = extractAddr(selfMail.to||'').toLowerCase()
      if(to && !to.includes('maxemblem.com') && !isBoardNoiseEmail(to)) email = to
      if(email || name) status = status === 'replied' ? 'replied' : 'contacted'
      else status = 'pending_contact'
    }

    // 营销垃圾里的 INQC 不建
    if(email && (isBoardNoiseEmail(email) || email.includes('maxemblem.com'))) email = ''

    if(!email && !name && !prev){
      // 完全无法识别客户：仍建档 L0，便于你手工补
      pendingContact++
      status = 'pending_contact'
    }

    let customerId = prev?.customerId
    if(email){
      customerId = (await ensureInquiryCustomer(email, name)) || customerId
    } else if(customerId){
      const c = await db.customers.get(customerId) as Customer | undefined
      if(c) { email = email || c.email || ''; name = name || c.contactName || c.title }
    }

    const next = mergeInquiry(prev, {
      inquiryNo: no,
      inquiryDate: pack.hit.date,
      seqNo: pack.hit.seq,
      customerId,
      customerName: name,
      customerEmail: email,
      productName: product,
      status: (prev?.status === 'won' || prev?.status === 'cancelled') ? prev.status : status,
      source,
      sourceMailIds: mailsFor.map(m=> m.id),
    })
    // 回执字段优先覆盖
    if(receipt){
      const rf = parseReceiptFields(receipt)
      const m2 = mergeInquiry(next, { ...rf, inquiryNo: no, source: 'receipt' })
      if(rf.customerEmail && m2.customerId !== customerId && rf.customerEmail){
        const id2 = await ensureInquiryCustomer(rf.customerEmail, rf.customerName||'')
        if(id2) { m2.customerId = id2; customerId = id2 }
      }
      byNo.set(no, m2)
    } else {
      byNo.set(no, next)
    }

    if(!prev) created++
    else updated++

    // 客户关联询盘号
    const rec = byNo.get(no)!
    if(rec.customerId){
      try{
        const c = await db.customers.get(rec.customerId) as any
        if(c){
          const tags = [...new Set([...(c.tags||[]).map(String), '询盘'])]
          const nos = [...new Set([...(c.inquiryNos||[]).map(String), rec.inquiryNo])]
          const patch: any = { tags, inquiryNos: nos, updatedAt: now() }
          // 业务创建时间 = 询盘日（INQC），不改 createdAt
          const inqDate = String(rec.inquiryDate||'').slice(0,10)
          if(/^\d{4}-\d{2}-\d{2}$/.test(inqDate)){
            const prevInq = String(c.inquiryAt||'').slice(0,10)
            if(!prevInq || inqDate < prevInq) patch.inquiryAt = inqDate
            if(!c.followUpAt){
              const d = new Date(inqDate)
              if(Number.isFinite(d.getTime())) patch.followUpAt = new Date(d.getTime() + 2*86400000).toISOString().slice(0,10)
            }
          }
          await db.customers.update(rec.customerId, patch)
        }
      }catch{ /* ignore */ }
    }
  }

  for(const rec of byNo.values()) await saveInquiry(rec)
  window.dispatchEvent(new CustomEvent('evan-customers-updated'))
  const note = `询盘同步：邮件 ${mails.length} · 单号 ${byNo.size} · 新建 ${created} · 更新 ${updated}${pendingContact?` · 待补信息 ${pendingContact}`:''}`
  return { scanned: mails.length, inquiries: byNo.size, created, updated, pendingContact, note }
}

export async function listInquiries(): Promise<InquiryRecord[]> {
  const list = await loadInquiries()
  return list.sort((a,b)=> String(b.inquiryDate||b.updatedAt).localeCompare(String(a.inquiryDate||a.updatedAt)))
}

export function inquiryMapOf(list: InquiryRecord[]): Map<string, InquiryRecord> {
  const m = new Map<string, InquiryRecord>()
  for(const r of list){
    if(r.customerId) m.set(r.customerId, r)
  }
  return m
}

export function isInquiryCustomer(c: Customer): boolean {
  const tags = (c.tags||[]).map(String)
  return tags.includes('询盘') || !!(c as any).inquiryNos?.length
}

export async function markInquiryStatus(inquiryNo: string, status: InquiryRecord['status']){
  const rec = (await loadInquiries()).find(x=> x.inquiryNo === inquiryNo)
  if(!rec) return
  await saveInquiry({ ...rec, status, updatedAt: now() })
}
