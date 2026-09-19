// 近 N 天付款/成交扫描 + 订单去重 + CSV 订单导入
import { db } from '../db'
import type { Customer, EmailMessage } from '../types'
import { loadIntellectConfig, syncTiersFromRules } from './customerDailyClassify'

export type PurchaseOrder = {
  id: string
  customer_id: string
  order_date: string
  products: string[]
  qty: number | null
  amount: number | null
  source: 'email_scan' | 'csv_import' | 'manual'
  mail_id?: string
  ext_key: string
  created_at: string
}

// ====== 严格成交证据：INQC 是询盘单号，绝不能单独当订单 ======
const STRONG = [
  /payment\s*(has\s+been\s+)?(sent|confirmed|done|received|made)/i,
  /(?:we\s+(?:have\s+)?|i\s+have\s+)paid\b/i,
  /\bfully\s+paid\b/i,
  /remittance\s*(advice|copy|attached)?/i,
  /wire\s+transfer\s*(copy|confirm|attached|sent)?/i,
  /\bTT\s+(copy|payment|slip|receipt)/i,
  /we\s*(have\s*)?(placed|confirmed)\s*(the\s*)?order/i,
  /please\s+proceed\s+with\s+(the\s+)?order/i,
  /\bPO[-\s]?\d{4,}/i,
  /maxemblem\s+order\s+confirm/i,
  /order\s+confirmation\s*[:\-]/i,
  /已付款|付款成功|汇款凭证|请查收.*(款|汇款)|款已付/i,
]
const NEGATIVE = [
  /\bunpaid\b/i,
  /\bnot\s+paid\b/i,
  /pending\s+payment/i,
  /awaiting\s+(payment|deposit)/i,
  /未付款|待付款|尚未付款|未支付/i,
]
function extractAmount(text: string): number | null {
  const m = text.match(/\$\s*([\d,]+(?:\.\d{2})?)/) || text.match(/USD\s*([\d,]+)/i)
  if(!m) return null
  const n = parseFloat(m[1].replace(/,/g,''))
  return Number.isFinite(n) ? n : null
}
function extractQty(text: string): number | null {
  const m = text.match(/(\d{1,6})\s*(?:pcs?|pc|枚|个)/i)
  return m ? Number(m[1].replace(/,/g,'')) : null
}
function extractProducts(text: string){
  const out = new Set<string>()
  const t = text.toLowerCase()
  if(/medal/i.test(t)) out.add('Medal')
  if(/challenge\s*coin|\bcoins?\b/i.test(t)) out.add('Coin')
  if(/\bpins?\b/i.test(t)) out.add('Pin')
  if(/patch/i.test(t)) out.add('Patch')
  if(/belt/i.test(t)) out.add('Belt')
  if(/trophy/i.test(t)) out.add('Trophy')
  if(/key\s*chain|keychain/i.test(t)) out.add('Keychain')
  return [...out]
}
function extractPo(text: string){
  return text.match(/INQC\d{8,}/)?.[0] || text.match(/\bPO[- ]?\d{4,}/i)?.[0] || null
}
function extractAddr(raw: string){
  return String(raw||'').match(/<([^<>@\s]+@[^<>\s]+)>/)?.[1] || String(raw||'').match(/([^\s<>,;]+@[^\s<>,;]+)/)?.[1] || ''
}
export function isStrictOrderEvidence(subject: string, text: string){
  const s = `${subject||''}\n${text||''}`
  if (NEGATIVE.some(re => re.test(s))) return false
  const stripped = s.replace(/\bINQC\d+/gi, '')
  const inquiryOnly = /\b(custom|inquiry|quote|quotation|price|checking\s+in)\b/i.test(s)
    && /\bINQC\d+/i.test(s)
    && !STRONG.some(re => re.test(stripped))
  if (inquiryOnly) return false
  return STRONG.some(re => re.test(s))
}
function isStrongOrderMail(subject: string, text: string){
  return isStrictOrderEvidence(subject, text)
}
void isStrongOrderMail
function extKey(customerId: string, dateDay: string, amount: number|null, product: string, po: string|null, mailId: string){
  if(po) return `po:${customerId}:${po}`
  if(mailId) return `mail:${customerId}:${mailId}`
  return `anon:${customerId}:${dateDay}:${amount||0}:${product||'-'}`
}

const PO_KIND = 'purchase_order'
let poMigrated = false

async function loadAllOrders(): Promise<PurchaseOrder[]> {
  try {
    const rows = await db.collections.where('kind').equals(PO_KIND).toArray() as any[]
    const fromDb = rows.map(r => (r.data || r) as PurchaseOrder).filter((o: any) => o && o.ext_key)
    if (fromDb.length) return fromDb
    // 旧数据在 appState：迁移一次到 collections（可云同步）
    const legacy = await db.appState.get('evan:purchaseOrders')
    const list: PurchaseOrder[] = ((legacy?.data as any) || []) as PurchaseOrder[]
    if (list.length && !poMigrated) {
      for (const o of list) {
        await db.collections.put({
          id: `po-${o.ext_key}`,
          kind: PO_KIND,
          category: o.source || 'email_scan',
          data: o,
          createdAt: o.created_at || new Date().toISOString(),
          updatedAt: o.created_at || new Date().toISOString(),
        } as any)
      }
      poMigrated = true
    }
    return list
  } catch { return [] }
}

async function upsertOrder(o: PurchaseOrder){
  try{
    const list = await loadAllOrders()
    if(list.some(x=> x.ext_key === o.ext_key || (x.customer_id===o.customer_id && x.order_date.slice(0,10)===o.order_date.slice(0,10) && x.amount!=null && o.amount!=null && Math.abs(x.amount-o.amount)<0.01 && x.source===o.source))){
      return false
    }
    await db.collections.put({
      id: `po-${o.ext_key}`,
      kind: PO_KIND,
      category: o.source || 'email_scan',
      data: o,
      createdAt: o.created_at,
      updatedAt: o.created_at,
    } as any)
    // 兼容旧读路径
    try {
      const all = await db.appState.get('evan:purchaseOrders')
      const prev: PurchaseOrder[] = (all?.data as any) || []
      await db.appState.put({ key:'evan:purchaseOrders', data:[...prev, o] } as any)
    } catch { /* ignore */ }
    return true
  }catch{
    return false
  }
}
export async function listPurchaseOrders(): Promise<PurchaseOrder[]>{
  return loadAllOrders()
}

export type OrderScanResult = {
  scanned: number
  ordersAdded: number
  customersTagged: number
  duplicates: number
  pending: number
}

export function isOrderedCustomer(c: Customer, orders?: PurchaseOrder[]): boolean {
  const tags = (c.tags||[]).map(String)
  // 仅认：人工/CSV 成交标签、阶段 won、复购次数、库内订单（订单本身也应来自严格扫描/CSV）
  if (tags.includes('已下单')) return true
  if ((c.stage||'') === 'won') return true
  if ((c.repurchaseCount||0) >= 1) return true
  if (orders && orders.some(o => o.customer_id === c.id)) return true
  return false
}

/** 清理误标：无严格订单证据的「已下单/订单/won」回退为线索 */
export async function purgeFalseOrderedTags(): Promise<{
  scanned: number; purged: number; kept: number; ordersPurged: number
}>{
  const customers = await db.customers.toArray() as Customer[]
  const allOrders = await listPurchaseOrders()
  // 只保留 CSV/人工订单；误扫描产生的 email_scan 订单丢弃，稍后严格重扫
  const keepOrders = allOrders.filter(o => o.source === 'csv_import' || o.source === 'manual')
  const purgeOrderIds = allOrders.filter(o => o.source === 'email_scan').map(o => o.ext_key)
  for (const key of purgeOrderIds) {
    try { await db.collections.delete(`po-${key}`) } catch {}
  }
  try {
    const legacy = await db.appState.get('evan:purchaseOrders')
    if (legacy?.data) {
      await db.appState.put({
        key: 'evan:purchaseOrders',
        data: (legacy.data as PurchaseOrder[]).filter(o => o.source !== 'email_scan'),
      } as any)
    }
  } catch {}

  const keepByCust = new Map<string, PurchaseOrder[]>()
  for (const o of keepOrders) {
    const arr = keepByCust.get(o.customer_id) || []
    arr.push(o); keepByCust.set(o.customer_id, arr)
  }

  let purged = 0, kept = 0
  const now = new Date().toISOString()
  for (const c of customers) {
    const tags = (c.tags||[]).map(String)
    const hasOrderTag = tags.includes('已下单') || tags.includes('订单')
    const won = (c.stage||'') === 'won'
    const rep = (c.repurchaseCount||0) >= 1
    if (!hasOrderTag && !won && !rep) continue
    const manualOrders = keepByCust.get(c.id) || []
    // 人工导入/明确 CSV 订单 → 保留
    if (manualOrders.length) { kept++; continue }
    // 无严格证据：去掉成交标签，阶段 won → lead（除非 lost）
    const nextTags = tags.filter(t => t !== '已下单' && t !== '订单')
    const nextStage = c.stage === 'lost' ? 'lost' : 'lead'
    const nextRep = 0
    await db.customers.update(c.id, {
      tags: nextTags,
      stage: nextStage,
      repurchaseCount: nextRep,
      updatedAt: now,
      orderTagAt: undefined,
    } as any)
    purged++
  }
  return { scanned: customers.length, purged, kept, ordersPurged: purgeOrderIds.length }
}

export async function closePendingFollowUps(customerId: string, note = '已下单，自动关闭逾期跟进'): Promise<number> {
  try {
    const rows = await db.followUps.where('customerId').equals(customerId).toArray() as any[]
    let n = 0
    const ts = new Date().toISOString()
    for (const f of rows) {
      if (f.status !== 'pending') continue
      await db.followUps.update(f.id, { status: 'done', note: [f.note, note].filter(Boolean).join(' | ').slice(0,200), updatedAt: ts } as any)
      n++
    }
    return n
  } catch { return 0 }
}

export async function markCustomerOrdered(c: Customer, _orders?: PurchaseOrder[]): Promise<boolean> {
  const tags = new Set([...(c.tags||[]).map(String)])
  const needTag = !tags.has('已下单')
  const needStage = (c.stage||'') !== 'won' && (c.stage||'') !== 'lost'
  if (!needTag && !needStage) {
    await closePendingFollowUps(c.id)
    return false
  }
  tags.add('已下单')
  tags.add('订单')
  const now = new Date().toISOString()
  await db.customers.update(c.id, {
    tags: [...tags],
    stage: needStage ? 'won' : c.stage,
    isKey: true,
    orderTagAt: (c as any).orderTagAt || now,
    updatedAt: now,
  } as any)
  await closePendingFollowUps(c.id)
  return true
}

export async function syncOrderedCustomersFollowUps(opts?: { purge?: boolean }): Promise<{
  ordered: number; newlyTagged: number; followUpsClosed: number; purged: number
}>{
  let purged = 0
  if (opts?.purge !== false) {
    const p = await purgeFalseOrderedTags()
    purged = p.purged
  }
  const customers = await db.customers.toArray() as Customer[]
  const orders = await listPurchaseOrders()
  const byCust = new Map<string, PurchaseOrder[]>()
  for (const o of orders) {
    const arr = byCust.get(o.customer_id) || []
    arr.push(o); byCust.set(o.customer_id, arr)
  }
  let ordered = 0, newlyTagged = 0, followUpsClosed = 0
  const now = new Date().toISOString()
  for (const c of customers) {
    const list = byCust.get(c.id)
    let cur = c
    // 仅当库内有 CSV/人工订单时补标；扫描标只由 runOrderScan 严格证据写入
    if (list?.length && !(c.tags||[]).map(String).includes('已下单')) {
      const tags = [...new Set([...(c.tags||[]).map(String), '已下单', '订单'])]
      const stage = (c.stage==='lost') ? c.stage : 'won'
      await db.customers.update(c.id, { tags, stage, isKey: true, repurchaseCount: Math.max(1, c.repurchaseCount||0), updatedAt: now } as any)
      cur = { ...c, tags, stage } as Customer
      newlyTagged++
    }
    if (!isOrderedCustomer(cur, list)) continue
    ordered++
    const changed = await markCustomerOrdered(cur, list)
    if (changed) newlyTagged++
    followUpsClosed += await closePendingFollowUps(c.id)
  }
  if (loadIntellectConfig().syncTierToFollowUps) await syncTiersFromRules()
  window.dispatchEvent(new CustomEvent('evan-customers-updated'))
  return { ordered, newlyTagged, followUpsClosed, purged }
}

export async function runOrderScan(opts?: { days?: number; rescanAll?: boolean }): Promise<OrderScanResult> {
  const cfg = loadIntellectConfig()
  const days = opts?.rescanAll ? 3650 : (opts?.days || Math.max(cfg.orderScanDays || 5, 30))
  const cutoff = Date.now() - days * 86400000
  const emails = (await db.emails.toArray() as EmailMessage[]).filter(e=>{
    const t = new Date(e.date).getTime()
    return Number.isFinite(t) && t >= cutoff
  })
  const customers = await db.customers.toArray() as Customer[]
  const byAddr = new Map<string, Customer>()
  for(const c of customers){
    if(c.email) byAddr.set(String(c.email).toLowerCase(), c)
    for(const e of (c.extraEmails||[])) byAddr.set(String(e).toLowerCase(), c)
  }

  const result: OrderScanResult = { scanned: emails.length, ordersAdded:0, customersTagged:0, duplicates:0, pending:0 }
  const tagged = new Set<string>()
  const now = new Date().toISOString()
  const cfgSuppress = cfg.marketingSuppressDays || 7

  for(const e of emails){
    const text = `${e.subject||''}\n${e.text||''}`
    const strong = isStrictOrderEvidence(e.subject||'', e.text||'')
    if(!strong){ continue }
    const from = extractAddr(e.from).toLowerCase()
    const toList = String(e.to||'').split(',').map(extractAddr).filter(Boolean).map(s=> s.toLowerCase())
    // 仅：客户来信中的付款证据，或我方明确 Order Confirmation 发给该客户
    let c: Customer | undefined
    const isSelf = from.includes('maxemblem.com')
    const isOrderConfirmMail = /maxemblem\s+order\s+confirm|order\s+confirmation\s*[:\-]/i.test(e.subject||'')
    if(!isSelf && from && byAddr.get(from)) c = byAddr.get(from)
    else if(isSelf && isOrderConfirmMail){
      for(const a of toList){
        if(a && !a.includes('maxemblem.com') && byAddr.get(a)){ c = byAddr.get(a); break }
      }
    }
    if(!c) { result.pending++; continue }
    const day = e.date ? new Date(e.date).toISOString().slice(0,10) : now.slice(0,10)
    const amount = extractAmount(text)
    const qty = extractQty(text)
    const products = extractProducts(text)
    const po = extractPo(text) || extractPo(e.subject||'')
    const key = extKey(c.id, day, amount, products[0]||'', po, e.id)
    const order: PurchaseOrder = {
      id: `po-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
      customer_id: c.id,
      order_date: day,
      products,
      qty,
      amount,
      source: 'email_scan',
      mail_id: e.id,
      ext_key: key,
      created_at: now,
    }
    const added = await upsertOrder(order)
    if(!added){ result.duplicates++; }
    else result.ordersAdded++

    const tags = new Set([...(c.tags||[]).map(String)])
    if(tags.has('已下单')){
      await closePendingFollowUps(c.id)
      result.duplicates++
    } else {
      tags.add('已下单')
      tags.add('订单')
      const stage = c.stage === 'lost' ? c.stage : 'won'
      const rep = Math.max(1, (c.repurchaseCount||0) + 1)
      await db.customers.update(c.id, {
        tags: [...tags],
        stage,
        isKey: true,
        repurchaseCount: rep,
        orderTagAt: now,
        updatedAt: now,
        marketingSuppressedUntil: new Date(Date.now() + cfgSuppress*86400000).toISOString(),
      } as any)
      await closePendingFollowUps(c.id)
      tagged.add(c.id)
      result.customersTagged++
    }
  }
  if(cfg.syncTierToFollowUps && tagged.size){
    await syncTiersFromRules({ ids: tagged })
  }
  window.dispatchEvent(new CustomEvent('evan-customers-updated'))
  return result
}

/** CSV 订单导入：订单号,客户邮箱,日期,产品,数量,金额 */
export async function importOrdersCsv(text: string){
  const lines = text.split(/\r?\n/).map(l=> l.trim()).filter(Boolean)
  if(lines.length < 2) return { added:0, skipped:0, errors:0 }
  const customers = await db.customers.toArray() as Customer[]
  const byAddr = new Map<string, Customer>()
  for(const c of customers){
    if(c.email) byAddr.set(String(c.email).toLowerCase(), c)
    for(const e of (c.extraEmails||[])) byAddr.set(String(e).toLowerCase(), c)
  }
  let added=0, skipped=0, errors=0
  const now = new Date().toISOString()
  const cfg = loadIntellectConfig()
  for(let i=1;i<lines.length;i++){
    const cols = lines[i].split(',').map(s=> s.trim())
    try{
      const [po, email, date, products, qty, amount] = cols
      const addr = String(email||'').toLowerCase()
      const c = byAddr.get(addr)
      if(!c){ errors++; continue }
      const day = date ? new Date(date).toISOString().slice(0,10) : now.slice(0,10)
      const key = po ? `po:${c.id}:${po}` : `csv:${c.id}:${day}:${amount||0}:${products||''}`
      const order: PurchaseOrder = {
        id: `po-csv-${Date.now()}-${i}`,
        customer_id: c.id,
        order_date: day,
        products: String(products||'').split(/[\/|]/).map(s=>s.trim()).filter(Boolean),
        qty: qty ? Number(qty) : null,
        amount: amount ? Number(String(amount).replace(/,/g,'')) : null,
        source: 'csv_import',
        ext_key: key,
        created_at: now,
      }
      const ok = await upsertOrder(order)
      if(!ok){ skipped++; continue }
      added++
      const tags = new Set([...(c.tags||[]).map(String), '已下单', '订单'])
      await db.customers.update(c.id, {
        tags: [...tags],
        stage: c.stage==='lost'?c.stage:'won',
        isKey: true,
        repurchaseCount: (c.repurchaseCount||0)+1,
        orderTagAt: now,
        updatedAt: now,
        marketingSuppressedUntil: new Date(Date.now()+ (cfg.marketingSuppressDays||7)*86400000).toISOString(),
      } as any)
      await closePendingFollowUps(c.id)
    }catch{ errors++ }
  }
  if(cfg.syncTierToFollowUps) await syncTiersFromRules()
  window.dispatchEvent(new CustomEvent('evan-customers-updated'))
  return { added, skipped, errors }
}
