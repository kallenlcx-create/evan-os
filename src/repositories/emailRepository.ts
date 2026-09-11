import { db } from '../db'
import type { EmailAccount, EmailMessage, EmailIntent } from '../types'
import { classifyIntent } from '../services/emailAiService'
import { uid, now } from './result'

export const PROVIDER_PRESETS: Record<string, { imap:{host:string,port:number,ssl:boolean}, smtp:{host:string,port:number,ssl:boolean,tls?:boolean}, label:string }> = {
  '163': { label:'163 网易', imap:{host:'imap.163.com',port:993,ssl:true}, smtp:{host:'smtp.163.com',port:465,ssl:true} },
  'qq': { label:'QQ 邮箱', imap:{host:'imap.qq.com',port:993,ssl:true}, smtp:{host:'smtp.qq.com',port:465,ssl:true} },
  'outlook': { label:'Outlook / 365', imap:{host:'outlook.office365.com',port:993,ssl:true}, smtp:{host:'smtp.office365.com',port:587,ssl:false,tls:true} },
  'gmail': { label:'Gmail', imap:{host:'imap.gmail.com',port:993,ssl:true}, smtp:{host:'smtp.gmail.com',port:465,ssl:true} },
  'enterprise': { label:'企业邮箱', imap:{host:'imap.qiye.163.com',port:993,ssl:true}, smtp:{host:'smtp.qiye.163.com',port:465,ssl:true} },
  'custom': { label:'自定义 IMAP', imap:{host:'',port:993,ssl:true}, smtp:{host:'',port:465,ssl:true} },
}

export async function listAccounts(): Promise<EmailAccount[]> {
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
export async function deleteAccount(id:string){ await db.emailAccounts.delete(id) }

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

// Mock 同步：生成 20-30 封逼真邮件（878封的缩略版）
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
    // 同步创建/更新 Customer + Communication
    try {
      const emailAddr = s.from.match(/<(.+?)>/)?.[1] || s.from
      const existing = await db.customers.where('email').equals(emailAddr).first() as any
      if (!existing) {
        const { uid:uid2 } = await import('./result')
        await db.customers.put({ id: uid2(), type:'customer', title: s.from.split('<')[0].trim()||'客户', description:'', emoji:'👤', tags:['邮件'], createdAt:now(), updatedAt:now(), relations:[], company:(s as any).company||'', email:emailAddr, stage:'lead', isKey: Math.random()>0.6, level: (['A+','A','B','C'] as any)[Math.floor(Math.random()*4)], followUpAt: new Date(Date.now()+3*86400000).toISOString().slice(0,10), score: 70+Math.floor(Math.random()*25) } as any)
      }
    } catch{}
  }
  await db.emailAccounts.update(accountId,{lastSyncAt:now()} as any)
  return added
}
