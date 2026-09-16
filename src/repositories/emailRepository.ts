import { db } from '../db'
import type { EmailAccount, EmailMessage, EmailIntent } from '../types'
import { classifyIntent } from '../services/emailAiService'
import { uid, now } from './result'
import { getSyncConfig } from '../services/cloudSync'

export async function serverHeaders(): Promise<{url:string, token:string}|null>{
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

export function bypassHeaders(h:{url:string,token:string}){
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

export async function syncReal(accountId:string, limit:number|'all'=20, offset=0, headersOnly=false, search='', sinceUid=0): Promise<{added:number, total:number, hasMore:boolean, maxUid?:number}>{
  const lim = limit==='all' ? 1000000 : limit
  const h = await serverHeaders()
  if(!h) throw new Error('请先登录云同步')
  const ho = headersOnly ? '&headersOnly=true' : ''
  const sq = search ? `&search=${encodeURIComponent(search)}` : ''
  const su = sinceUid > 0 ? `&sinceUid=${sinceUid}` : ''
  const r = await fetch(`${h.url}/email/sync/${accountId}?limit=${lim}&offset=${offset}${ho}${sq}${su}`,{ headers: bypassHeaders(h) })
  const j = await r.json().catch(()=>({}))
  if(!r.ok) throw new Error(j.error||`拉取失败 ${r.status}`)
  const emails: any[] = j.emails||[]
  // 并行分类意图（批量 Promise.all）
  const intents = await Promise.all(emails.map(e => classifyIntent(e.subject+' '+ (e.text||'').slice(0,500))))
  // 并行写 IndexedDB（分组50一批，避免锁冲突；用 bulkPut 减少事务次数）
  const BATCH = 50
  let added=0
  for(let i=0; i<emails.length; i+=BATCH){
    const chunk = emails.slice(i, i+BATCH)
    const intentChunk = intents.slice(i, i+BATCH)
    const mails: EmailMessage[] = chunk.map((e, idx)=>({
      id: e.id, accountId: e.accountId||accountId, folder: e.folder||'inbox',
      from: e.from, to: e.to, subject: e.subject, text: e.text||'', html: e.html||'',
      date: e.date, isRead: !!e.isRead, hasAttachment: !!e.hasAttachment,
      product: /coin/i.test(e.subject+e.text)?'Coin': /patch/i.test(e.subject+e.text)?'Patch': /pin/i.test(e.subject)?'Pin':'Coin',
      intent: intentChunk[idx] as EmailIntent,
      priority: '中', status: e.isRead?'已处理':'待处理',
    }))
    await db.emails.bulkPut(mails)
    // 客户去重：整批一次查询 + 一次批量写入（之前是每封2次查询）
    try{
      const addrTitle = new Map<string,string>()
      for(const e of chunk){
        const addr = (e.from.match(/<(.+?)>/)?.[1]||e.from).trim()
        if(addr && addr.includes('@') && !addrTitle.has(addr.toLowerCase()))
          addrTitle.set(addr.toLowerCase(), e.from.split('<')[0].trim()||addr.split('@')[0])
      }
      if(addrTitle.size){
        const keys = [...addrTitle.keys()]
        const existRows = await db.customers.where('email').anyOf(keys).toArray() as any[]
        const existSet = new Set(existRows.map(c=> (c.email||'').toLowerCase()))
        const fresh = keys.filter(k=> !existSet.has(k)).map(k=>({
          id: uid(), type:'customer', title: addrTitle.get(k), description:'', emoji:'👤', tags:['邮件'],
          createdAt:now(), updatedAt:now(), relations:[], company:'', email:k, stage:'lead',
          isKey:false, level:'C', followUpAt: new Date(Date.now()+3*86400000).toISOString().slice(0,10),
        } as any))
        if(fresh.length) await db.customers.bulkPut(fresh)
      }
    }catch{}
    added += chunk.length
  }
  await db.emailAccounts.update(accountId,{lastSyncAt: now()} as any).catch(()=>{})
  // 计算本次同步的最大UID，用于增量同步
  let maxUid = 0
  for(const e of emails){
    const uid = Number(e.id?.split('-').pop()) || 0
    if(uid > maxUid) maxUid = uid
  }
  if(maxUid > 0){
    const acc = await db.emailAccounts.get(accountId)
    if(!acc || !acc.lastSyncUid || maxUid > acc.lastSyncUid){
      await db.emailAccounts.update(accountId, { lastSyncUid: maxUid } as any).catch(()=>{})
    }
  }
  return { added, total: (j as any).total||0, hasMore: !!(j as any).hasMore, maxUid }
}

export async function listEmails(folder?: string): Promise<EmailMessage[]> {
  try {
    if (folder) return await db.emails.where('folder').equals(folder).reverse().sortBy('date')
    return await db.emails.orderBy('date').reverse().toArray()
  } catch { return [] }
}
export async function getEmail(id:string){ try{ return await db.emails.get(id)}catch{ return undefined} }
// ====== 浏览器同步改走服务端库：零 IMAP 连接，只读库内信封 ======
export async function syncFromDb(accountId: string, onBatch?: (done: number, total: number) => void): Promise<{ added: number; total: number }>{
  const h = await serverHeaders()
  if(!h) throw new Error('请先登录云同步')
  const acc = await db.emailAccounts.get(accountId)
  let since = Number((acc as any)?.lastSyncUid) || 0
  let added = 0
  let total = 0
  for(let n = 0; n < 200; n++){
    const r = await fetch(`${h.url}/email/db-envelopes/${accountId}?sinceUid=${since}&limit=1000`,{ headers: bypassHeaders(h) })
    const j = await r.json().catch(()=>({}))
    if(!r.ok) throw new Error(j.error||`拉取失败 ${r.status}`)
    const rows: any[] = j.envelopes || []
    total = Number(j.total) || total
    if(!rows.length) break
    const mails: EmailMessage[] = []
    for(const e of rows){
      const subj = e.subject || '(无主题)'
      mails.push({
        id: `${accountId}-${e.uid}`, accountId, folder: String(e.folder||'').includes('sent') ? 'sent' : 'inbox',
        from: e.from_name ? `${e.from_name} <${e.from_addr}>` : (e.from_addr || ''),
        to: e.to_addr || '', subject: subj, text: '', html: '',
        date: e.msg_date ? new Date(e.msg_date).toISOString() : new Date().toISOString(),
        isRead: !!e.is_read, hasAttachment: !!e.has_attachment,
        imapFolder: String(e.folder||''), uid: Number(e.uid)||undefined,
        gmailMsgId: (e as any).gmail_msgid || undefined,
        product: /coin/i.test(subj)?'Coin': /patch/i.test(subj)?'Patch': /pin/i.test(subj)?'Pin':'Coin',
        intent: await classifyIntent(subj) as EmailIntent,
        priority: '中', status: e.is_read?'已处理':'待处理',
      })
      const u = Number(e.uid) || 0
      if(u > since) since = u
    }
    await db.emails.bulkPut(mails)
    // 客户去重（整批一次查询+一次写入）
    try{
      const addrTitle = new Map<string,string>()
      for(const m of mails){
        const addr = (m.from.match(/<(.+?)>/)?.[1]||m.from).trim()
        if(addr && addr.includes('@') && !addrTitle.has(addr.toLowerCase()))
          addrTitle.set(addr.toLowerCase(), m.from.split('<')[0].trim()||addr.split('@')[0])
      }
      if(addrTitle.size){
        const keys = [...addrTitle.keys()]
        const existRows = await db.customers.where('email').anyOf(keys).toArray() as any[]
        const existSet = new Set(existRows.map(c=> (c.email||'').toLowerCase()))
        const fresh = keys.filter(k=> !existSet.has(k)).map(k=>({
          id: uid(), type:'customer', title: addrTitle.get(k), description:'', emoji:'👤', tags:['邮件'],
          createdAt:now(), updatedAt:now(), relations:[], company:'', email:k, stage:'lead',
          isKey:false, level:'C', followUpAt: new Date(Date.now()+3*86400000).toISOString().slice(0,10),
        } as any))
        if(fresh.length) await db.customers.bulkPut(fresh)
      }
    }catch{}
    added += mails.length
    await db.emailAccounts.update(accountId, { lastSyncUid: since, lastSyncAt: now() } as any).catch(()=>{})
    onBatch?.(added, total)
    if(!j.hasMore) break
    await new Promise(rr=> setTimeout(rr, 30))
  }
  return { added, total }
}

export async function markRead(id:string, isRead:boolean){
  const m = await getEmail(id); if(m){ m.isRead=isRead; await db.emails.put(m)}
  // 尽力回写服务端库 + Gmail（失败静默，限流时下轮自动对齐）
  try{
    const h = await serverHeaders()
    if(h && m){
      const uid = m.uid != null ? String(m.uid) : id.split('-').pop()
      await fetch(`${h.url}/email/mark-read`, { method:'POST',
        headers:{ 'Content-Type':'application/json', ...bypassHeaders(h) },
        body: JSON.stringify({ accountId: m.accountId, uid, read: isRead, folder: m.imapFolder || undefined }) })
    }
  }catch{}
}
export async function upsertEmail(m: EmailMessage){ await db.emails.put(m); return m }

export async function fetchDbMail(accountId: string, uid: string|number, folder?: string): Promise<{text:string;html:string;from:string;to:string;subject:string;cached?:boolean;folder?:string;uid?:number}|null>{
  const h = await serverHeaders()
  if(!h) return null
  try{
    const fq = folder ? `?folder=${encodeURIComponent(folder)}` : ''
    const r = await fetch(`${h.url}/email/db-mail/${accountId}/${uid}${fq}`,{ headers: bypassHeaders(h) })
    if(!r.ok) return null
    return await r.json()
  }catch{ return null }
}

/** 统一正文加载：本地已有 → db-mail → full(IMAP)，成功后写回 IDB */
export async function loadMailBody(m: EmailMessage): Promise<EmailMessage> {
  if (m.text || m.html) return m
  const uid = m.uid != null ? m.uid : Number(String(m.id).split('-').pop())
  if (!isFinite(uid)) return m
  let body = await fetchDbMail(m.accountId, uid, m.imapFolder)
  if (!body || (!body.text && !body.html) || body.cached === false) {
    const full = await fetchFullEmail(m.accountId, String(uid))
    if (full && ((full as any).text || (full as any).html)) {
      body = {
        text: (full as any).text || body?.text || '',
        html: (full as any).html || body?.html || '',
        from: (full as any).from || '',
        to: (full as any).to || '',
        subject: (full as any).subject || body?.subject || '',
        cached: true,
      }
    }
  }
  if (!body || (!body.text && !body.html)) return m
  const next: EmailMessage = {
    ...m,
    text: body.text || '',
    html: body.html || '',
    bodyCached: body.cached !== false,
    subject: body.subject || m.subject,
  }
  await db.emails.put(next)
  return next
}

export async function getUnreadCount(accountId: string, folder?: string): Promise<number> {
  const h = await serverHeaders()
  if(!h) throw new Error('请先登录云同步')
  const fq = folder ? `?folder=${encodeURIComponent(folder)}` : ''
  const r = await fetch(`${h.url}/email/unread-count/${accountId}${fq}`, { headers: bypassHeaders(h) })
  const j = await r.json().catch(()=>({}))
  if(!r.ok) throw new Error(j.error||`未读数失败 ${r.status}`)
  return Number(j.unread)||0
}

export async function searchDbMailsAll(q: string, limit = 50): Promise<EmailMessage[]> {
  const h = await serverHeaders()
  if (!h) throw new Error('请先登录云同步')
  const r = await fetch(`${h.url}/email/db-search-all?q=${encodeURIComponent(q)}&limit=${limit}`, { headers: bypassHeaders(h) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || `搜索失败 ${r.status}`)
  const rows: any[] = j.emails || []
  return Promise.all(rows.map(async (e) => ({
    id: `${e.account_id}-${e.uid}`,
    accountId: e.account_id,
    folder: String(e.folder||'').includes('sent') ? 'sent' as const : 'inbox' as const,
    from: e.from_name ? `${e.from_name} <${e.from_addr}>` : (e.from_addr || ''),
    to: e.to_addr || '', subject: e.subject || '(无主题)',
    text: e.body_text || e.snippet || '', html: e.body_html || '',
    date: e.msg_date ? new Date(e.msg_date).toISOString() : new Date().toISOString(),
    isRead: !!e.is_read, hasAttachment: !!e.has_attachment,
    imapFolder: e.folder || '', uid: Number(e.uid)||undefined,
    gmailMsgId: e.gmail_msgid || undefined,
    bodyCached: !!e.body_cached,
    product: 'Coin' as any,
    intent: await classifyIntent(`${e.subject || ''} ${(e.body_text || '').slice(0, 500)}`) as EmailIntent,
    priority: '中' as const, status: e.is_read ? '已处理' : '待处理',
  })))
}

export async function listAttachments(accountId: string, uid: number): Promise<Array<{filename:string;size:number;mime:string;url:string}>> {
  const h = await serverHeaders()
  if(!h) return []
  try{
    const r = await fetch(`${h.url}/email/attachments/${accountId}/${uid}`, { headers: bypassHeaders(h) })
    if(!r.ok) return []
    const j = await r.json()
    return (j.attachments || []).map((a:any)=>({
      ...a,
      url: `${h.url}/email/attachment/${accountId}/${uid}/${encodeURIComponent(a.filename)}?token=${encodeURIComponent(h.token)}`
    }))
  }catch{ return [] }
}

export async function downloadAttachmentBlob(accountId: string, uid: number, filename: string): Promise<Blob|null> {
  const h = await serverHeaders()
  if(!h) return null
  try{
    const r = await fetch(`${h.url}/email/attachment/${accountId}/${uid}/${encodeURIComponent(filename)}`, { headers: bypassHeaders(h) })
    if(!r.ok) return null
    return await r.blob()
  }catch{ return null }
}

/** 可选：把草稿 APPEND 到 Gmail [Gmail]/Drafts */
export async function appendGmailDraft(accountId: string, draftId: string): Promise<{ok:boolean;uid?:number;error?:string}> {
  const h = await serverHeaders()
  if(!h) return { ok:false, error:'未登录云同步' }
  try{
    const r = await fetch(`${h.url}/email/drafts/${draftId}/append-gmail`, {
      method:'POST', headers:{ 'Content-Type':'application/json', ...bypassHeaders(h) },
      body: JSON.stringify({ accountId }),
    })
    const j = await r.json().catch(()=>({}))
    if(!r.ok) return { ok:false, error: j.error || String(r.status) }
    return { ok:true, uid: j.uid }
  }catch(e:any){ return { ok:false, error: String(e?.message||e).slice(0,120) } }
}

export interface CustomerMailThread {
  threadId: string; subject: string; count: number; lastDate: string
  mails: Array<{ folder: string; uid: number; message_id: string; subject: string; from_addr: string; from_name: string; to_addr: string; msg_date: string; is_read: number; has_attachment: number; body_cached: number; body_len: number; snippet: string }>
}
export async function fetchCustomerThreads(accountId: string, email: string, page = 0): Promise<{ threads: CustomerMailThread[]; totalMails: number } | null>{
  const h = await serverHeaders()
  if(!h) return null
  try{
    const r = await fetch(`${h.url}/email/customer-mails/${accountId}?email=${encodeURIComponent(email)}&page=${page}`,{ headers: bypassHeaders(h) })
    if(!r.ok) return null
    return await r.json()
  }catch{ return null }
}

export async function fetchFullEmail(accountId: string, uid: string): Promise<{text:string;html:string;from:string;to:string;subject:string}|null>{
  const h = await serverHeaders()
  if(!h) return null
  try{
    const r = await fetch(`${h.url}/email/full/${accountId}/${uid}`,{ headers: bypassHeaders(h) })
    if(!r.ok) return null
    return await r.json()
  }catch{ return null }
}

export async function fetchFullEmailBatch(accountId: string, uids: string[]): Promise<Record<string,{text:string;html:string;from:string;to:string;subject:string}>>{
  const h = await serverHeaders()
  if(!h) return {}
  try{
    const r = await fetch(`${h.url}/email/full-batch`,{ method:'POST', headers:{'Content-Type':'application/json', ...bypassHeaders(h)}, body:JSON.stringify({accountId, uids}) })
    if(!r.ok) return {}
    const j = await r.json()
    return j.results || {}
  }catch{ return {} }
}

// ====== 服务端邮件库（MySQL）：一次全量入库 + 增量 + 库内搜索 ======
export interface DbMailFolderStatus {
  folder: string; dbCount: number; bodyCount: number; imapTotal: number; lastUid: number
  uidnext: number; uidvalidity: number; fullSyncDone: boolean; live: boolean
  lastSyncAt: string | null; pending: number; job: any
}
export async function dbMailStatus(accountId: string, light = true): Promise<DbMailFolderStatus[]> {
  const h = await serverHeaders()
  if (!h) throw new Error('请先登录云同步')
  const r = await fetch(`${h.url}/email/db-status/${accountId}${light ? '?light=1' : ''}`, { headers: bypassHeaders(h) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || `查询失败 ${r.status}`)
  return j.folders || []
}
export async function startMailIngest(accountId: string, mode: 'full' | 'incremental' = 'full'): Promise<any> {
  const h = await serverHeaders()
  if (!h) throw new Error('请先登录云同步')
  const r = await fetch(`${h.url}/email/ingest/${accountId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...bypassHeaders(h) },
    body: JSON.stringify({ mode }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || `启动失败 ${r.status}`)
  return j.job
}
export async function mailIngestStatus(accountId: string): Promise<any> {
  const h = await serverHeaders()
  if (!h) return null
  const r = await fetch(`${h.url}/email/ingest-status/${accountId}`, { headers: bypassHeaders(h) })
  const j = await r.json().catch(() => ({}))
  return j.job || null
}
export async function stopMailIngest(accountId: string): Promise<void>{
  const h = await serverHeaders()
  if (!h) return
  try{ await fetch(`${h.url}/email/ingest-stop/${accountId}`, { method: 'POST', headers: bypassHeaders(h) }) }catch{}
}
export async function startScopedIngest(emails: string[], since = '2026-09-01'): Promise<any>{
  const h = await serverHeaders()
  if (!h) throw new Error('请先登录云同步')
  const r = await fetch(`${h.url}/email/ingest-scoped`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...bypassHeaders(h) },
    body: JSON.stringify({ emails, since }) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || `启动失败 ${r.status}`)
  return j.job
}
export async function scopedIngestStatus(): Promise<any[]>{
  const h = await serverHeaders()
  if (!h) return []
  try{
    const r = await fetch(`${h.url}/email/ingest-scoped-status`, { headers: bypassHeaders(h) })
    const j = await r.json().catch(() => ({}))
    return j.jobs || []
  }catch{ return [] }
}
// ====== Gmail OAuth（替代 IMAP 授权码）======
export async function getOAuthAppConfig(): Promise<{ hasId: boolean; hasSecret: boolean }>{
  const h = await serverHeaders()
  if (!h) throw new Error('请先登录云同步')
  const r = await fetch(`${h.url}/email/oauth/config`, { headers: bypassHeaders(h) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || '查询失败')
  return j
}
export async function saveOAuthAppConfig(clientId: string, clientSecret: string): Promise<any>{
  const h = await serverHeaders()
  if (!h) throw new Error('请先登录云同步')
  const r = await fetch(`${h.url}/email/oauth/config`, { method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...bypassHeaders(h) },
    body: JSON.stringify({ clientId, clientSecret }) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || '保存失败')
  return j
}
export async function getOAuthAuthUrl(accountId = ''): Promise<string>{
  const h = await serverHeaders()
  if (!h) throw new Error('请先登录云同步')
  const r = await fetch(`${h.url}/email/oauth/url${accountId ? `?accountId=${accountId}` : ''}`, { headers: bypassHeaders(h) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || '获取授权链接失败')
  return j.url
}
export async function getOAuthStatus(accountId: string): Promise<{ connected: boolean; email: string; historyId: boolean; authType: string }>{
  const h = await serverHeaders()
  if (!h) throw new Error('请先登录云同步')
  const r = await fetch(`${h.url}/email/oauth/status/${accountId}`, { headers: bypassHeaders(h) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || '查询失败')
  return j
}
export async function disconnectOAuth(accountId: string): Promise<void>{
  const h = await serverHeaders()
  if (!h) return
  try{ await fetch(`${h.url}/email/oauth/disconnect/${accountId}`, { method: 'POST', headers: bypassHeaders(h) }) }catch{}
}
export async function startGsync(accountId: string, mode: 'auto' | 'full' | 'incremental' = 'auto'): Promise<any>{
  const h = await serverHeaders()
  if (!h) throw new Error('请先登录云同步')
  const r = await fetch(`${h.url}/email/gsync/${accountId}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...bypassHeaders(h) },
    body: JSON.stringify({ mode }) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || `启动失败 ${r.status}`)
  return j.job
}
export async function setWatchPaused(pause: boolean): Promise<{ paused: boolean; watchers: number }>{  const h = await serverHeaders()
  if (!h) throw new Error('请先登录云同步')
  const r = await fetch(`${h.url}/email/watch-pause`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...bypassHeaders(h) }, body: JSON.stringify({ pause }) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || '操作失败')
  return j
}
export async function getWatchPaused(): Promise<{ paused: boolean; watchers: number }>{
  const h = await serverHeaders()
  if (!h) return { paused: false, watchers: 0 }
  try{
    const r = await fetch(`${h.url}/email/watch-pause`, { headers: bypassHeaders(h) })
    return await r.json().catch(() => ({ paused: false, watchers: 0 }))
  }catch{ return { paused: false, watchers: 0 } }
}
export async function searchDbMails(accountId: string, q: string, limit = 50): Promise<EmailMessage[]> {
  const h = await serverHeaders()
  if (!h) throw new Error('请先登录云同步')
  const r = await fetch(`${h.url}/email/db-search/${accountId}?q=${encodeURIComponent(q)}&limit=${limit}`, { headers: bypassHeaders(h) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || `搜索失败 ${r.status}`)
  const rows: any[] = j.emails || []
  return Promise.all(rows.map(async (e) => ({
    id: `${accountId}-${e.uid}`,
    accountId, folder: 'inbox' as const,
    from: e.from_name ? `${e.from_name} <${e.from_addr}>` : (e.from_addr || ''),
    to: e.to_addr || '', subject: e.subject || '(无主题)',
    text: e.body_text || e.snippet || '', html: e.body_html || '',
    date: e.msg_date ? new Date(e.msg_date).toISOString() : new Date().toISOString(),
    isRead: !!e.is_read, hasAttachment: !!e.has_attachment,
    imapFolder: e.folder || '', uid: Number(e.uid)||undefined,
    gmailMsgId: e.gmail_msgid || undefined, bodyCached: !!e.body_cached,
    product: 'Coin' as any,
    intent: await classifyIntent(`${e.subject || ''} ${(e.body_text || '').slice(0, 500)}`) as EmailIntent,
    priority: '中' as const, status: e.is_read ? '已处理' : '待处理',
  })))
}

// ====== 草稿箱 + 发件队列 ======
export interface MailDraft { id: string; account_id: string; to_addr: string; subject: string; body_text: string; body_html?: string }
export async function saveDraft(d: Partial<MailDraft> & { id?: string }): Promise<string>{
  const h = await serverHeaders()
  if(!h) throw new Error('请先登录云同步')
  const r = await fetch(`${h.url}/email/drafts`, { method:'PUT', headers:{ 'Content-Type':'application/json', ...bypassHeaders(h) },
    body: JSON.stringify({ id: d.id, accountId: d.account_id, to: d.to_addr, subject: d.subject, body_text: d.body_text, body_html: d.body_html || d.body_text }) })
  const j = await r.json().catch(()=>({}))
  if(!r.ok) throw new Error(j.error||`保存失败 ${r.status}`)
  return j.id
}
export async function getDrafts(): Promise<any[]>{
  const h = await serverHeaders()
  if(!h) return []
  try{
    const r = await fetch(`${h.url}/email/drafts`, { headers: bypassHeaders(h) })
    const j = await r.json().catch(()=>({}))
    return j.drafts || []
  }catch{ return [] }
}
export async function deleteDraft(id: string){
  const h = await serverHeaders()
  if(!h) return
  try{ await fetch(`${h.url}/email/drafts/${id}`, { method:'DELETE', headers: bypassHeaders(h) }) }catch{}
}
export async function enqueueMail(accountId: string, to: string, subject: string, text: string, idempotencyKey?: string, respectWindow = false): Promise<{id:string;status:string}>{
  const h = await serverHeaders()
  if(!h) throw new Error('请先登录云同步')
  const r = await fetch(`${h.url}/email/outbox`, { method:'POST', headers:{ 'Content-Type':'application/json', ...bypassHeaders(h) },
    body: JSON.stringify({ accountId, to, subject, text, idempotencyKey, respectWindow }) })
  const j = await r.json().catch(()=>({}))
  if(!r.ok) throw new Error(j.error||`入队失败 ${r.status}`)
  return j
}
export async function getOutbox(status = ''): Promise<any[]>{
  const h = await serverHeaders()
  if(!h) return []
  try{
    const r = await fetch(`${h.url}/email/outbox${status?`?status=${status}`:''}`, { headers: bypassHeaders(h) })
    const j = await r.json().catch(()=>({}))
    return j.outbox || []
  }catch{ return [] }
}
export async function retryOutbox(id: string){
  const h = await serverHeaders()
  if(!h) throw new Error('请先登录云同步')
  const r = await fetch(`${h.url}/email/outbox/${id}/retry`, { method:'POST', headers: bypassHeaders(h) })
  const j = await r.json().catch(()=>({}))
  if(!r.ok) throw new Error(j.error||`重试失败 ${r.status}`)
  return j
}

// ====== 营销：节假日 + 复购池 ======
export async function getHolidays(year?: number): Promise<{ year: number; holidays: Array<{date:string;name:string}>; source: string }>{
  const h = await serverHeaders()
  if(!h) throw new Error('请先登录云同步')
  const r = await fetch(`${h.url}/email/holidays${year?`?year=${year}`:''}`, { headers: bypassHeaders(h) })
  const j = await r.json().catch(()=>({}))
  if(!r.ok) throw new Error(j.error||`获取失败 ${r.status}`)
  return j
}
export async function getRepurchasePool(silentDays = 90): Promise<{ silentDays: number; total: number; pool: any[] }>{
  const h = await serverHeaders()
  if(!h) throw new Error('请先登录云同步')
  const r = await fetch(`${h.url}/email/repurchase-pool?silentDays=${silentDays}`, { headers: bypassHeaders(h) })
  const j = await r.json().catch(()=>({}))
  if(!r.ok) throw new Error(j.error||`获取失败 ${r.status}`)
  return j
}

// ====== 自动跟进序列 ======
async function seqApi(path: string, method = 'GET', body?: any){
  const h = await serverHeaders()
  if(!h) throw new Error('请先登录云同步')
  const r = await fetch(`${h.url}${path}`, { method,
    headers: { 'Content-Type': 'application/json', ...bypassHeaders(h) },
    body: body ? JSON.stringify(body) : undefined })
  const j = await r.json().catch(()=>({}))
  if(!r.ok) throw new Error(j.error||`请求失败 ${r.status}`)
  return j
}
export const getSequences = (mode = '') => seqApi(`/email/sequences${mode?`?mode=${mode}`:''}`)
export const startSequence = (p: any) => seqApi('/email/sequences', 'POST', p)
export const patchSequence = (customerId: string, p: any) => seqApi(`/email/sequences/${customerId}`, 'PATCH', p)
export const getSeqTemplates = () => seqApi('/email/seq-templates?kind=auto')
export const saveSeqTemplate = (p: any) => seqApi('/email/seq-templates', 'PUT', p)
export const getSeqConfig = () => seqApi('/email/seq-config')
export const saveSeqConfig = (intervals: number[], opts?: { sendStart?: number; sendEnd?: number; skipHolidays?: boolean }) => seqApi('/email/seq-config', 'PUT', { intervals, ...opts })

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

export async function sendEmail(accountId: string, to: string, subject: string, text: string, html?: string, inReplyTo?: string, references?: string): Promise<{ok:boolean;messageId?:string}>{
  const h = await serverHeaders()
  if(!h) throw new Error('未登录云同步')
  const r = await fetch(`${h.url}/email/send`,{
    method:'POST',
    headers:{'Content-Type':'application/json', ...bypassHeaders(h)},
    body: JSON.stringify({ accountId, to, subject, text, html: html||text, inReplyTo, references })
  })
  if(!r.ok) throw new Error('发送失败: ' + (await r.json().catch(()=>({error:r.statusText}))).error)
  return await r.json()
}

