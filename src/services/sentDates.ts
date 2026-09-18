// 客户「我方发送」时间：创建/最近跟进/未跟进天数
import { db } from '../db'
import type { Customer, EmailMessage } from '../types'

const SELF = ['evan@maxemblem.com']

function extractAddr(raw: string){
  return String(raw||'').match(/<([^<>@\s]+@[^<>\s]+)>/)?.[1] || String(raw||'').match(/([^\s<>,;]+@[^\s<>,;]+)/)?.[1] || ''
}

function customerAddrs(c: Customer){
  return [c.email, ...(c.extraEmails||[])].filter(Boolean).map(e=> String(e).toLowerCase().trim())
}

export type SentDates = { firstSentAt: string | null; lastSentAt: string | null; daysSinceSent: number | null }

export function daysSince(iso?: string | null){
  if(!iso) return null
  const t = new Date(iso).getTime()
  if(!Number.isFinite(t)) return null
  return Math.floor((Date.now()-t)/86400000)
}

/** 本地邮件库：扫「我发出的」并写回 customers */
export async function refreshSentDatesFromLocal(): Promise<{ updated: number; customersWithSent: number }>{
  const customers = await db.customers.toArray() as Customer[]
  const emails = await db.emails.toArray() as EmailMessage[]
  const selfSet = new Set(SELF)
  const sentByAddr = new Map<string, { first: string; last: string }>()
  for(const e of emails){
    const isSent = e.folder==='sent' || selfSet.has(extractAddr(e.from).toLowerCase())
    if(!isSent) continue
    const tos = String(e.to||'').split(',').map(extractAddr).map(s=> s.toLowerCase()).filter(Boolean)
    const date = e.date
    if(!date) continue
    for(const to of tos){
      if(selfSet.has(to)) continue
      const cur = sentByAddr.get(to)
      if(!cur) sentByAddr.set(to, { first: date, last: date })
      else {
        if(date < cur.first) cur.first = date
        if(date > cur.last) cur.last = date
      }
    }
  }
  let updated = 0
  let withSent = 0
  const ts = new Date().toISOString()
  for(const c of customers){
    const addrs = customerAddrs(c)
    let first: string | null = null
    let last: string | null = null
    for(const a of addrs){
      const s = sentByAddr.get(a)
      if(!s) continue
      if(!first || s.first < first) first = s.first
      if(!last || s.last > last) last = s.last
    }
    const prevFirst = (c as any).firstSentAt
    const prevLast = (c as any).lastSentAt
    if(first || last || prevFirst || prevLast){
      if(first) withSent++
      if(prevFirst !== first || prevLast !== last){
        await db.customers.update(c.id, {
          firstSentAt: first,
          lastSentAt: last,
          updatedAt: ts,
        } as any)
        updated++
      }
    }
  }
  window.dispatchEvent(new CustomEvent('evan-customers-updated'))
  window.dispatchEvent(new CustomEvent('evan-sent-dates'))
  return { updated, customersWithSent: withSent }
}

export function sentDatesOf(c: Customer): SentDates {
  const first = (c as any).firstSentAt || null
  const last = (c as any).lastSentAt || null
  return { firstSentAt: first, lastSentAt: last, daysSinceSent: daysSince(last) }
}

export function formatDays(n: number | null){
  if(n == null) return '未发送'
  if(n === 0) return '0 天'
  return `${n} 天`
}
