import { db } from '../db'
import type { EmailAccount, EmailMessage, EmailIntent } from '../types'
import { classifyIntent } from '../services/emailAiService'
import { uid, now } from './result'
import { getSyncConfig } from '../services/cloudSync'

async function serverHeaders(): Promise<{url:string, token:string}|null>{
  try{
    const cfg = await getSyncConfig()
    if(!cfg?.serverUrl || !cfg?.token) return null
    return { url: cfg.serverUrl.replace(/\/+$/,''), token: cfg.token }
  }catch{ return null }
}

export const PROVIDER_PRESETS: Record<string, { imap:{host:string,port:number,ssl:boolean}, smtp:{host:string,port:number,ssl:boolean,tls?:boolean}, label:string }> = {
  '163': { label:'163', imap:{host:'imap.163.com',port:993,ssl:true}, smtp:{host:'smtp.163.com',port:465,ssl:true} },
  'qq': { label:'QQ', imap:{host:'imap.qq.com',port:993,ssl:true}, smtp:{host:'smtp.qq.com',port:465,ssl:true} },
  'outlook': { label:'Outlook / 365', imap:{host:'outlook.office365.com',port:993,ssl:true}, smtp:{host:'smtp.office365.com',port:587,ssl:false,tls:true} },
  'gmail': { label:'Gmail', imap:{host:'imap.gmail.com',port:993,ssl:true}, smtp:{host:'smtp.gmail.com',port:465,ssl:true} },
  'enterprise': { label:'Enterprise', imap:{host:'imap.qiye.163.com',port:993,ssl:true}, smtp:{host:'smtp.qiye.163.com',port:465,ssl:true} },
  'custom': { label:'Custom IMAP', imap:{host:'',port:993,ssl:true}, smtp:{host:'',port:465,ssl:true} },
}

function bypassHeaders(h:{url:string,token:string}){
  const hdr: Record<string,string> = { 'x-evan-token': h.token }
  if(h.url.includes('loca.lt')) hdr['Bypass-Tunnel-Reminder']='true'
  return hdr
}

export async function listAccounts(): Promise<EmailAccount[]> {
  const h = await serverHeaders()
  if(h){
    try{
      const r = await fetch(`${h.url}/email/accounts`,{ headers: bypassHeaders(h) })
      if(r.ok){ const rows = await r.json(); if(Array.isArray(rows)) return rows as EmailAccount[] }
    }catch{}
  }
  try { return await db.emailAccounts.toArray() } catch { return [] }
}
export async function upsertAccount(a: Partial<EmailAccount>): Promise<EmailAccount> {
  const rec: EmailAccount = {
    id: a.id || uid(),
    provider: (a.provider||'custom') as any,
    email: a.email||'',
    imap: a.imap || PROVIDER_PRESETS[a.provider||'custom'].imap,
    smtp: a.smtp || PROVIDER_PRESETS[a.provider||'custom'].smtp,
    authEnc: a.authEnc,
    createdAt: (a as any).createdAt || now(),
    status: 'connected',
  }
  await db.emailAccounts.put(rec)
  return rec
}
export async function getEmailCount(accountId:string): Promise<number>{
  const h = await serverHeaders()
  if(!h) throw new Error('请先登录云同步')
  const r = await fetch(`${h.url}/email/count/${accountId}`,{ headers: bypassHeaders(h) })
  const j = await r.json().catch(()=>({}))
  if(!r.ok) throw new Error(j.error||`获取邮件数失败 ${r.status}`)
  return Number(j.total)||0
}

export async function deleteAccount(id:string){
  const h = await serverHeaders()
  if(h){
    try{ await fetch(`${h.url}/email/accounts/${id}`,{ method:'DELETE', headers: bypassHeaders(h) }) }catch{}
  }
  await db.emailAccounts.delete(id)
}

export async function createAccountOnServer(opts:{ provider:string, email:string, imap:{host:string,port:number,ssl:boolean}, smtp:{host:string,port:number,ssl:boolean}, pass:string }): Promise<{id:string}>{
  const h = await serverHeaders()
  if(!h) throw new Error('请先在 云同步 登录（云同步即IMAP中台，需同一账号）')
  const r = await fetch(`${h.url}/email/accounts`,{ method:'POST', headers:{ 'Content-Type':'application/json', 'x-evan-token': h.token, 'Bypass-Tunnel-Reminder':'true' }, body: JSON.stringify({ provider:opts.provider, email:opts.email, imap_host:opts.imap.host, imap_port:opts.imap.port, smtp_host:opts.smtp.host, smtp_port:opts.smtp.port, pass:opts.pass })})
  const j = await r.json().catch(()=>({}))
  if(!r.ok) throw new Error(j.error||`绑定失败 ${r.status}`)
  return j
}

export async function syncReal(accountId:string, limit:number|'all'=20, offset=0, headersOnly=false): Promise<{added:number, total:number, hasMore:boolean}>{
  const lim = limit==='all' ? 1000000 : limit
  const h = await serverHeaders()
  if(!h) throw new Error('请先登录云同步')
  const ho = headersOnly ? '&headersOnly=true' : ''
  const r = await fetch(`${h.url}/email/sync/${accountId}?limit=${lim}&offset=${offset}${ho}`,{ headers: bypassHeaders(h) })
  const j = await r.json().catch(()=>({}))
  if(!r.ok) throw new Error(j.error||`拉取失败 ${r.status}`)
  const emails: any[] = j.emails||[]
  // 并行分类意图（批量 Promise.all）
  const intents = await Promise.all(emails.map(e => classifyIntent(e.subject+' '+ (e.text||'').slice(0,500))))
  // 并行写 IndexedDB（分组50一批避免锁冲突）
  const BATCH = 50
  let added=0
  for(let i=0; i<emails.length; i+=BATCH){
    const chunk = emails.slice(i, i+BATCH)
    const intentChunk = intents.slice(i, i+BATCH)
    await Promise.all(chunk.map(async(e, idx)=>{
      const m: EmailMessage = {
        id: e.id, accountId: e.accountId||accountId, folder: e.folder||'inbox',
        from: e.from, to: e.to, subject: e.subject, text: e.text||'', html: e.html||'',
        date: e.date, isRead: !!e.isRead, hasAttachment: !!e.hasAttachment,
        product: /coin/i.test(e.subject+e.text)?'Coin': /patch/i.test(e.subject+e.text)?'Patch': /pin/i.test(e.subject)?'Pin':'Coin',
        intent: intentChunk[idx] as EmailIntent,
        priority: '中', status: e.isRead?'已处理':'待处理',
      }
      await db.emails.put(m)
      try{
        const addr = (e.from.match(/<(.+?)>/)?.[1]||e.from).trim()
        if(addr && addr.includes('@')){
          const exist = await db.customers.filter((cc:any)=> (cc.email||'').toLowerCase()===addr.toLowerCase()).first() as any
          if(!exist){
            const { uid:uid2 } = await import('./result')
            await db.customers.put({ id: uid2(), type:'customer', title: (e.from.split('<')[0].trim()||addr.split('@')[0]), description:'', emoji:'👤', tags:['邮件'], createdAt:now(), updatedAt:now(), relations:[], company:'', email:addr, stage:'lead', isKey:false, level:'C', followUpAt: new Date(Date.now()+3*86400000).toISOString().slice(0,10) } as any)
          }
        }
      }catch{}
    }))
    added += chunk.length
  }
  await db.emailAccounts.update(accountId,{lastSyncAt: now()} as any).catch(()=>{})
  return { added, total: (j as any).total||0, hasMore: !!(j as any).hasMore }
}

export async function listEmails(folder?: string): Promise<EmailMessage[]> {
  try {
    if (folder) return await db.emails.where('folder').equals(folder).reverse().sortBy('date')
    return await db.emails.orderBy('date').reverse().toArray()
  } catch { return [] }
}
export async function getEmail(id:string){ try{ return await db.emails.get(id)}catch{ return undefined} }
export async function markRead(id:string, isRead:boolean){
  const m = await getEmail(id); if(m){ m.isRead=isRead; await db.emails.put(m)}
}
export async function upsertEmail(m: EmailMessage){ await db.emails.put(m); return m }

export async function fetchFullEmail(accountId: string, uid: string): Promise<{text:string;html:string;from:string;to:string;subject:string}|null>{
  const h = await serverHeaders()
  if(!h) return null
  try{
    const r = await fetch(`${h.url}/email/full/${accountId}/${uid}`,{ headers: bypassHeaders(h) })
    if(!r.ok) return null
    return await r.json()
  }catch{ return null }
}

// Mock 同步：生成假邮件（878封缩略版）仅演示用
export async function mockSync(accountId:string): Promise<number> {
  const acc = await db.emailAccounts.get(accountId)
  if (!acc) return 0
  const samples = [
    { from:'John Smith <john@abc.com>', company:'ABC Tactical', subject:'Custom Challenge Coins INQC26090400006', text:'Hi Evan, we need 500 challenge coins for police event, budget around $2000. Please quote. Thanks!' , product:'Coin' },
    { from:'Esly Marin-Landa <izzlanda@icloud.com>', subject:'Re: Maxemblem—Custom Coins for Esly Martinez INQC26090400006', text:'Dear Esly, I hope you are doing well! I just wanted to follow up regarding your custom 3" coins. Since tomorrow, September 14, is the date you expect final quantity ready, check if updated?' , product:'Coin' },
    { from:'Paul Kotz <pkotz@irisnow.com>', subject:'Re: Maxemblem—Custom Medals for Paul INQC26080100004', text:'Hi Paul, I hope you been doing well! I wanted to check in regarding your custom medals project.' , product:'Medal' },
    { from:'Sunn Dunn <sunndunn9@gmail.com>', subject:'Re: Maxemblem—Custom Patches for SUNNI INQC26082500005', text:'Hi there, Just checking regarding your custom patches. Do you currently need 300 pcs?' , product:'Patch' },
    { from:'Zane Smith <zanesmithdtx@gmail.com>', subject:'Re: Maxemblem—Custom Patches for Zane Smith INQC2608190002', text:'Hi Zane, follow up regarding your patches project.', product:'Patch' },
  ]
  let added=0
  for (let i=0;i<samples.length;i++){
    const s=samples[i]
    const id = `${accountId}-${Date.now()}-${i}`
    const intent = await classifyIntent(s.text) as EmailIntent
    const m: EmailMessage = {
      id, accountId, folder: i%2===0?'inbox':'sent',
      from: i%2===0?s.from:`Evan Maxemblem <evan@maxemblem.com>`,
      to: i%2===0? acc.email : s.from,
      subject: s.subject,
      text: s.text,
      date: new Date(Date.now()- i*86400000).toISOString(),
      isRead: i>2,
      hasAttachment: i%3===0,
      product: s.product as any,
      intent,
      priority: intent==='新询价'?'高':'中',
      status: i>2?'已处理':'待处理',
      aiSummary: `客户需要${s.product}，意图：${intent}`,
    }
    await db.emails.put(m); added++
    try {
      const emailAddr = s.from.match(/<(.+?)>/)?.[1] || s.from
      const existing = await db.customers.filter((cc:any)=> (cc.email||'').toLowerCase()===emailAddr.toLowerCase()).first() as any
      if (!existing) {
        const { uid:uid2 } = await import('./result')
        await db.customers.put({ id: uid2(), type:'customer', title: s.from.split('<')[0].trim()||'客户', description:'', emoji:'👤', tags:['邮件'], createdAt:now(), updatedAt:now(), relations:[], company:(s as any).company||'', email:emailAddr, stage:'lead', isKey: Math.random()>0.6, level: (['A+','A','B','C'] as any)[Math.floor(Math.random()*4)], followUpAt: new Date(Date.now()+3*86400000).toISOString().slice(0,10), score: 70+Math.floor(Math.random()*25) } as any)
      }
    } catch{}
  }
  await db.emailAccounts.update(accountId,{lastSyncAt:now()} as any)
  return added
}

