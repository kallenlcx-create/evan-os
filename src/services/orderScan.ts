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

const STRONG = [
  /payment\s*(sent|confirmed|done|received)/i,
  /\bpaid\b/i,
  /remittance/i,
  /wire\s*transfer/i,
  /TT\s*(copy|payment)?/i,
  /we\s*(have\s*)?(placed|confirmed)\s*(the\s*)?order/i,
  /proceed\s*with\s*(the\s*)?order/i,
  /PO\s*(number|#|attached)/i,
  /已付款|付款成功|已下单|订单号|请查收.*款|汇款/i,
]
function extractAmount(text: string): number | null {
  const m = text.match(/\$\s*([\d,]+(?:\.\d{2})?)/) || text.match(/USD\s*([\d,]+(?:\.\d{2})?)/i)
  if(!m) return null
  const n = parseFloat(m[1].replace(/,/g,''))
  return Number.isFinite(n) ? n : null
}
function extractQty(text: string): number | null {
  const m = text.match(/(\d{1,6})\s*(?:pcs?|pc|枚|个)/i)
  return m ? Number(m[1]) : null
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
function isStrongOrderMail(subject: string, text: string){
  const s = `${subject}\n${text}`
  return STRONG.some(re => re.test(s))
}
function extKey(customerId: string, dateDay: string, amount: number|null, product: string, po: string|null, mailId: string){
  if(po) return `po:${customerId}:${po}`
  if(mailId) return `mail:${customerId}:${mailId}`
  return `anon:${customerId}:${dateDay}:${amount||0}:${product||'-'}`
}

async function upsertOrder(o: PurchaseOrder){
  try{
    const all = await db.appState.get('evan:purchaseOrders')
    const list: PurchaseOrder[] = (all?.data as any) || []
    if(list.some(x=> x.ext_key === o.ext_key || (x.customer_id===o.customer_id && x.order_date.slice(0,10)===o.order_date.slice(0,10) && x.amount!=null && o.amount!=null && Math.abs(x.amount-o.amount)<0.01 && x.source===o.source))){
      return false
    }
    list.push(o)
    await db.appState.put({ key:'evan:purchaseOrders', data:list } as any)
    return true
  }catch{
    return false
  }
}
export async function listPurchaseOrders(): Promise<PurchaseOrder[]>{
  try{
    const all = await db.appState.get('evan:purchaseOrders')
    return ((all?.data as any) || []) as PurchaseOrder[]
  }catch{ return [] }
}

export type OrderScanResult = {
  scanned: number
  ordersAdded: number
  customersTagged: number
  duplicates: number
  pending: number
}

export async function runOrderScan(opts?: { days?: number }): Promise<OrderScanResult> {
  const cfg = loadIntellectConfig()
  const days = opts?.days || cfg.orderScanDays || 5
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
    const strong = isStrongOrderMail(e.subject||'', e.text||'')
    if(!strong){ continue }
    const from = extractAddr(e.from).toLowerCase()
    const toList = String(e.to||'').split(',').map(extractAddr).filter(Boolean).map(s=> s.toLowerCase())
    let c: Customer | undefined
    if(from && byAddr.get(from) && !from.includes('maxemblem.com')) c = byAddr.get(from)
    else {
      for(const a of toList){
        if(a && !a.includes('maxemblem.com') && byAddr.get(a)){ c = byAddr.get(a); break }
      }
    }
    if(!c) { result.pending++; continue }
    const day = e.date ? new Date(e.date).toISOString().slice(0,10) : now.slice(0,10)
    const amount = extractAmount(text)
    const qty = extractQty(text)
    const products = extractProducts(text)
    const po = extractPo(text)
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
      result.duplicates++
    } else {
      tags.add('已下单')
      tags.add('订单')
      const stage = c.stage === 'lost' || c.stage === 'lead' || !c.stage ? 'won' : c.stage
      const rep = (c.repurchaseCount||0) + 1
      await db.customers.update(c.id, {
        tags: [...tags],
        stage,
        isKey: true,
        repurchaseCount: rep,
        orderTagAt: now,
        updatedAt: now,
        marketingSuppressedUntil: new Date(Date.now() + cfgSuppress*86400000).toISOString(),
      } as any)
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
    }catch{ errors++ }
  }
  if(cfg.syncTierToFollowUps) await syncTiersFromRules()
  window.dispatchEvent(new CustomEvent('evan-customers-updated'))
  return { added, skipped, errors }
}
