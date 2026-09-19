// 近 N 天付款/成交扫描 + 订单去重 + CSV 订单导入
import { db } from '../db'
import type { Customer, EmailMessage } from '../types'
import { loadIntellectConfig, syncTiersFromRules, matchDealKeywords, DEFAULT_DEAL_KEYWORDS, DEFAULT_DEAL_EXCLUDES } from './customerDailyClassify'

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

// ====== 成交判定：以「智能设置 → 成交/下单关键词 / 排除词」为准（用户可改，非写死）======
// INQC 等询盘单号单独出现不算订单
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

/**
 * 是否算成交邮件：读智能设置里的 dealKeywords / dealExcludeWords。
 * 关键词用户可随时改；改完请点「订单对齐」重算已下单。
 */
export function isStrictOrderEvidence(subject: string, text: string, cfgOverride?: { dealKeywords?: string[]; dealExcludeWords?: string[] }){
  const cfg = cfgOverride || loadIntellectConfig()
  const kw = (cfg.dealKeywords?.length ? cfg.dealKeywords : DEFAULT_DEAL_KEYWORDS).map(s=> String(s||'').trim()).filter(Boolean)
  const ex = (cfg.dealExcludeWords?.length ? cfg.dealExcludeWords : DEFAULT_DEAL_EXCLUDES).map(s=> String(s||'').trim()).filter(Boolean)
  // 主题 + 正文一起判；本地镜像常无正文，主题也必须参与
  const s = `${subject||''}\n${text||''}`
  const dm = matchDealKeywords(s, { dealKeywords: kw, dealExcludeWords: ex })
  if(!dm.hit) return false
  // 仅有 INQC/询盘措辞、且命中词又很弱时：仍要求排除词已通过（matchDeal 已处理排除词）
  return true
}

/** 命中的成交词（用于备注/调试） */
export function matchOrderKeyword(subject: string, text: string): string {
  const cfg = loadIntellectConfig()
  const dm = matchDealKeywords(`${subject||''}\n${text||''}`, cfg)
  return dm.hit ? dm.matched : ''
}

function extKey(customerId: string, dateDay: string, amount: number|null, product: string, po: string|null, mailId: string){
  if(po) return `po:${customerId}:${po}`
  if(mailId) return `mail:${customerId}:${mailId}`
  return `anon:${customerId}:${dateDay}:${amount||0}:${product||'-'}`
}

const PO_KIND = 'purchase_order'
let poMigrated = false

/** collections 行 id 必须短：MySQL data.row_id 过长会推送 500 */
function poRowId(o: PurchaseOrder): string {
  const seed = String(o.ext_key || o.id || '')
  let h = 0
  for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0
  const cust = String(o.customer_id || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)
  return `po_${Math.abs(h).toString(36)}_${cust}`.slice(0, 64)
}

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
          id: poRowId(o),
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
      id: poRowId(o),
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
    try { await db.collections.delete(poRowId({ ext_key: key, customer_id: '', id: key } as PurchaseOrder)) } catch {}
  }
  // 清掉历史超长 id（会导致云同步推送 collections 500）
  try {
    const cols = await db.collections.where('kind').equals(PO_KIND).toArray() as any[]
    for (const r of cols) {
      if (!r?.id) continue
      const id = String(r.id)
      if (id.length > 80 || id.startsWith('po-mail:') || id.startsWith('po-anon:')) {
        await db.collections.delete(id)
      }
    }
  } catch {}
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

export async function closePendingFollowUps(customerId: string, note?: string): Promise<number> {
  const msg = note || '已下单，自动关闭逾期跟进'
  try {
    const rows = await db.followUps.where('customerId').equals(customerId).toArray() as any[]
    let n = 0
    const ts = new Date().toISOString()
    for (const f of rows) {
      if (f.status !== 'pending') continue
      await db.followUps.update(f.id, { status: 'done', note: [f.note, msg].filter(Boolean).join(' | ').slice(0,200), updatedAt: ts } as any)
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
    // 成交与否完全由「智能设置」关键词/排除词决定（用户可改）
    const strong = isStrictOrderEvidence(e.subject||'', e.text||'', cfg)
    if(!strong){ continue }
    const matchedKw = matchOrderKeyword(e.subject||'', e.text||'')
    const from = extractAddr(e.from).toLowerCase()
    const toList = String(e.to||'').split(',').map(extractAddr).filter(Boolean).map(s=> s.toLowerCase())
    const isSelf = from.includes('maxemblem.com')
    let c: Customer | undefined
    // 优先绑定「客户侧」地址，避免把自己打成已下单
    if(!isSelf && from && byAddr.get(from)) c = byAddr.get(from)
    if(!c){
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
      await closePendingFollowUps(c.id, matchedKw ? `成交词「${matchedKw}」` : '已下单，自动关闭逾期跟进')
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
        classifyReason: matchedKw ? `成交词「${matchedKw}」` : undefined,
      } as any)
      await closePendingFollowUps(c.id, matchedKw ? `成交词「${matchedKw}」` : '已下单，自动关闭逾期跟进')
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
