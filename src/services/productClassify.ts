// 产品分类：从邮件上下文识别 Patch/Pin/Coin/Medal/Keychain，多标签并存
import { db } from '../db'
import type { Customer, EmailMessage } from '../types'

export const PRODUCT_TAGS = ['Patch', 'Pin', 'Coin', 'Medal', 'Keychain'] as const
export type ProductTag = typeof PRODUCT_TAGS[number]

/** 产品关键词（邮件主题+正文，不区分大小写） */
const PRODUCT_PATTERNS: Record<ProductTag, RegExp> = {
  Patch: /patch(es)?\b|臂章|徽章布|embroider(ed|y)\s*patch|woven\s*patch/i,
  Pin: /\bpins?\b|enamel\s*pins?|软珐琅|胸针|徽章|lapel\s*pin|challeng(e|ing)\s*pin/i,
  Coin: /\bcoins?\b|challenge\s*coin|纪念币|奖币|medallion|3d\s*coin|custom\s*coin/i,
  Medal: /\bmedals?\b|奖牌|奖章|challenge\s*medal|custom\s*medal/i,
  Keychain: /key\s*chain|keychain|钥匙扣|钥匙链|bag\s*tag/i,
}

function customerAddrs(c: Customer){
  return [c.email, ...(c.extraEmails||[])].filter(Boolean).map(e=> String(e).toLowerCase())
}

/** 从一批邮件文本识别产品标签（可多标签） */
export function detectProductsFromText(text: string): ProductTag[] {
  const out = new Set<ProductTag>()
  for(const p of PRODUCT_TAGS){
    if(PRODUCT_PATTERNS[p].test(text)) out.add(p)
  }
  return [...out]
}

/** 单客户：聚合其邮件上下文识别产品 */
export function detectProductsForCustomer(c: Customer, emails: EmailMessage[]): ProductTag[] {
  const addrs = new Set(customerAddrs(c))
  const texts: string[] = []
  // 订单字段也参与
  const portrait = (c.portrait as any)?.products as string[] | undefined
  if(portrait?.length) texts.push(portrait.join(' '))
  for(const e of emails){
    const from = String(e.from||'').toLowerCase()
    const to = String(e.to||'').toLowerCase()
    const hit = addrs.has(from) || [...addrs].some(a=> to.includes(a))
    if(!hit) continue
    texts.push(`${e.subject||''}\n${e.text||''}`)
  }
  return detectProductsFromText(texts.join('\n'))
}

export type ProductClassifyResult = {
  processed: number
  tagged: number
  multiTagged: number
  byProduct: Record<string, number>
}

/** 批量产品分类：写入 tags（保留业务标签，去掉旧产品标签再写新的） */
export async function runProductClassify(opts?: { onlyCustomerIds?: string[] }){
  const customers = await db.customers.toArray() as Customer[]
  const emails = await db.emails.toArray() as EmailMessage[]
  const targets = opts?.onlyCustomerIds?.length
    ? customers.filter(c=> opts.onlyCustomerIds!.includes(c.id))
    : customers
  const result: ProductClassifyResult = { processed:0, tagged:0, multiTagged:0, byProduct:{} }
  const ts = new Date().toISOString()
  for(const c of targets){
    const detected = detectProductsForCustomer(c, emails)
    result.processed++
    if(!detected.length) continue
    for(const p of detected) result.byProduct[p] = (result.byProduct[p]||0)+1
    if(detected.length > 1) result.multiTagged++
    const old = (c.tags||[]).map(String).filter(t=> !PRODUCT_TAGS.includes(t as ProductTag))
    const tags = [...new Set([...old, ...detected])]
    await db.customers.update(c.id, {
      tags,
      productTags: detected,
      productTaggedAt: ts,
      updatedAt: ts,
    } as any)
    result.tagged++
  }
  window.dispatchEvent(new CustomEvent('evan-customers-updated'))
  return result
}

export function formatProductResult(r: ProductClassifyResult){
  const b = Object.entries(r.byProduct).map(([k,v])=> `${k} ${v}`).join(' · ')
  return `产品分类 ${r.processed} 人：打标 ${r.tagged} · 多品类 ${r.multiTagged}${b?`｜${b}`:''}`
}
