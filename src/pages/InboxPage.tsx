// ====== 邮件中心：客户经营中心 ======
// 三栏：左邮件列表+搜索 | 中邮件往来（纯邮件展示） | 右AI侧栏（客户+工作台+分析+跟进+回复）
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Mail, Star, Clock, Languages, Sparkles, UserCheck, Calendar, Send, Settings, Search, Brain, FileText, TrendingUp, X } from 'lucide-react'
import { db } from '../db'
import type { EmailMessage, EmailAccount, Customer } from '../types'
import { listAccounts, upsertAccount, deleteAccount, PROVIDER_PRESETS, mockSync, syncReal, createAccountOnServer, markRead, listEmails, getEmailCount, sendEmail, dbMailStatus, startMailIngest, mailIngestStatus, searchDbMails, searchDbMailsAll, loadMailBody, listAttachments, appendGmailDraft, getUnreadCount, type DbMailFolderStatus, saveDraft, getDrafts, deleteDraft, enqueueMail, getOutbox, retryOutbox, cancelOutbox, setWatchPaused, getWatchPaused, getSequences, startSequence, patchSequence } from '../repositories/emailRepository'
import { classifyIntent, translateEnToZh, summarizeEmail, buildPortrait, suggestFollowUpDate } from '../services/emailAiService'
import { getEmailSyncConfig, setEmailSyncConfig, syncAllEmails, isEmailSyncing } from '../services/emailSyncService'
import { generateFullAnalysis, type FullAnalysis } from '../services/customerAnalysisService'
import { useAskText } from '../components/PromptModal'
import MailHtml from '../components/MailHtml'
import MailTextBody from '../components/MailTextBody'
import { OAuthBindButton, OAuthBadge, OAuthAppForm } from '../components/GmailOAuth'

const INTENT_COLOR: Record<string,string> = {
  '新询价':'bg-red-50 text-red-600','报价回复':'bg-blue-50 text-blue-600','询问价格':'bg-orange-50 text-orange-600',
  '催货':'bg-yellow-50 text-yellow-700','复购':'bg-green-50 text-green-600','其他':'bg-gray-100 text-gray-500',
}
const LEVEL_STAR: Record<string,string> = { 'A+':'⭐️⭐️⭐️','A':'⭐️⭐️','B':'⭐️','C':'','D':'' }

// ====== Gmail 式会话：对方邮箱 + 规范主题 ======
const SELF_ADDRS = ['evan@maxemblem.com']
function extractAddr(raw: string){
  return String(raw||'').match(/<([^<>@\s]+@[^<>\s]+)>/)?.[1] || String(raw||'').match(/([^\s<>,;]+@[^\s<>,;]+)/)?.[1] || ''
}
function counterpartOf(m: EmailMessage){
  const from = extractAddr(m.from).toLowerCase()
  const to = extractAddr(m.to||'').toLowerCase()
  // 收件：对方是 from；已发送：对方是 to 里非自己的地址
  if(from && !SELF_ADDRS.includes(from)) return from
  const tos = String(m.to||'').split(',').map(s=> extractAddr(s).toLowerCase()).filter(Boolean)
  const other = tos.find(a=> a && !SELF_ADDRS.includes(a))
  return other || from || to || 'unknown'
}
function normSubject(s: string){
  return String(s||'').replace(/^(\s*(re|fwd|fw)\s*:\s*)+/i,'').trim().toLowerCase()
}
function threadKeyOf(m: EmailMessage){
  return `${m.accountId||''}|${counterpartOf(m)}|${normSubject(m.subject)}`
}
function displayNameOf(m: EmailMessage){
  const name = String(m.from||'').split('<')[0].trim()
  if(name && !name.includes('@')) return name
  if(m.folder==='sent'){
    const tname = String(m.to||'').split('<')[0].trim()
    if(tname && !tname.includes('@')) return tname
  }
  const c = counterpartOf(m)
  return c.split('@')[0] || c
}
type ThreadRow = {
  key: string
  title: string
  subject: string
  latest: EmailMessage
  count: number
  hasUnread: boolean
  date: string
  intent: string
  hasAttachment: boolean
}
function groupThreads(list: EmailMessage[]): ThreadRow[] {
  const map = new Map<string, EmailMessage[]>()
  for(const m of list){
    const k = threadKeyOf(m)
    const arr = map.get(k)
    if(arr) arr.push(m)
    else map.set(k, [m])
  }
  const ts = (d: string) => { const t = new Date(d).getTime(); return Number.isFinite(t) ? t : 0 }
  const rows: ThreadRow[] = []
  for(const [key, msgs] of map){
    const sorted = [...msgs].sort((a,b)=> ts(a.date)-ts(b.date))
    const latest = sorted[sorted.length-1]
    rows.push({
      key,
      title: displayNameOf(latest),
      subject: latest.subject || '(无主题)',
      latest,
      count: sorted.length,
      hasUnread: sorted.some(m=> !m.isRead),
      date: latest.date,
      intent: latest.intent||'其他',
      hasAttachment: sorted.some(m=> m.hasAttachment),
    })
  }
  rows.sort((a,b)=> ts(b.date)-ts(a.date))
  return rows
}
function isImageAtt(a: {filename:string;mime?:string}){
  const mime = String(a.mime||'').toLowerCase()
  if(mime.startsWith('image/')) return true
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(a.filename||'')
}
function avatarColor(seed: string){
  let h = 0
  for(let i=0;i<seed.length;i++) h = (h*31 + seed.charCodeAt(i)) >>> 0
  const hues = [210, 12, 280, 160, 30, 340, 200]
  const hue = hues[h % hues.length]
  return `hsl(${hue} 55% 48%)`
}
function mailSnippet(m: EmailMessage, max = 90){
  const raw = String(m.text||'').replace(/\s+/g,' ').trim()
  if(raw) return raw.slice(0, max)
  const html = String(m.html||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim()
  if(html) return html.slice(0, max)
  return ''
}
/** 我（Evan）：仅当「发件人」是自己时才算「我」；to 含 Evan 不能算，否则客户来信也会被标成我 */
const SELF_COLOR = '#1d4ed8'
function isSelfSender(m: EmailMessage){
  const from = extractAddr(m.from).toLowerCase()
  return SELF_ADDRS.includes(from)
}

export default function InboxPage(){
  const [askModal, askText] = useAskText()
  const [accounts, setAccounts] = useState<EmailAccount[]>([])
  const [emails, setEmails] = useState<EmailMessage[]>([])
  const [selected, setSelected] = useState<EmailMessage|null>(null)
  const [filter, setFilter] = useState<'all'|'unread'>('all')
  const [folder, setFolder] = useState<'inbox'|'sent'|'drafts'>('inbox')
  // 会话展开：唯一真相
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [q, setQ] = useState('')
  const [translated, setTranslated] = useState('')
  const [showTrans, setShowTrans] = useState(false)
  const [allowRemoteImg, setAllowRemoteImg] = useState(false)
  const [showConfig, setShowConfig] = useState(false)
  const [showAccountPop, setShowAccountPop] = useState(false)
  const [customer, setCustomer] = useState<Customer|null>(null)
  const [deepAnalysis, setDeepAnalysis] = useState<FullAnalysis|null>(null)
  const [analyzingCustomer, setAnalyzingCustomer] = useState(false)
  const [searchMode, setSearchMode] = useState(false)
  const [searchResults, setSearchResults] = useState<EmailMessage[]>([])

  // 回复邮件
  const [showReply, setShowReply] = useState(false)
  const [replyTo, setReplyTo] = useState('')
  const [replySubject, setReplySubject] = useState('')
  const [replyBody, setReplyBody] = useState('')
  const [replyHtml, setReplyHtml] = useState('')
  const [scheduleAt, setScheduleAt] = useState('')
  const editorRef = useRef<HTMLDivElement>(null)
  const syncEditor = useCallback(()=>{
    const el = editorRef.current
    if(!el) return
    const html = el.innerHTML
    setReplyHtml(html)
    setReplyBody(el.innerText || '')
  },[])
  // 打开回复/恢复草稿时灌入编辑器
  useEffect(()=>{
    if(!showReply) return
    const el = editorRef.current
    if(!el) return
    const html = replyHtml || (replyBody ? `<div>${replyBody.replace(/\n/g,'<br/>')}</div>` : '')
    if(el.innerHTML !== html) el.innerHTML = html
  },[showReply, replyHtml, replyBody])
  const [sending, setSending] = useState(false)
  const [replyDraftId, setReplyDraftId] = useState('')
  const [draftNote, setDraftNote] = useState('')
  const [aiDraftingReply, setAiDraftingReply] = useState(false)
  const [showOutbox, setShowOutbox] = useState(false)
  const [outboxList, setOutboxList] = useState<any[]>([])
  const [bodyLoading, setBodyLoading] = useState(false)
  const [bodyError, setBodyError] = useState('')
  const [attachments, setAttachments] = useState<Array<{filename:string;size:number;mime:string;url:string}>>([])
  const [serverDrafts, setServerDrafts] = useState<any[]>([])
  const [serverUnread, setServerUnread] = useState<number|null>(null)
  const [loadingDraftId, setLoadingDraftId] = useState('')

  // 配置表单
  const [provider, setProvider] = useState<EmailAccount['provider']>('qq')
  const [emailAddr, setEmailAddr] = useState('3254136783@qq.com')
  const [authCode, setAuthCode] = useState('')
  const [customImap, setCustomImap] = useState('')
  const [customSmtp, setCustomSmtp] = useState('')

  // 服务端邮箱总邮件数
  const fetchServerCounts = useCallback(async(accs?: EmailAccount[]) => {
    const list = accs || await listAccounts()
    const counts: Record<string, number> = {}
    await Promise.allSettled(list.map(async(a) => {
      try { counts[a.id] = await getEmailCount(a.id) } catch { counts[a.id] = 0 }
    }))
  }, [])

  const refresh = useCallback(async()=>{
    const accs = await listAccounts()
    setAccounts(accs)
    const list = await listEmails()
    // 意图补齐只处理前 300 封缺失的，避免上万封一次性阻塞/爆内存；其余打开或搜索时再补
    let fixed = 0
    for(const m of list){
      if(fixed >= 300) break
      if(!m.intent) { m.intent = await classifyIntent(m.text); await db.emails.put(m); fixed++ }
    }
    setEmails(list)
    fetchServerCounts(accs)
  },[fetchServerCounts])
  useEffect(()=>{ void refresh() },[refresh])

  const ensureCustomer = async (emailRaw:string, nameRaw:string): Promise<Customer> =>{
    const addr = emailRaw.match(/<(.+?)>/)?.[1] || emailRaw
    const clean = addr.trim().toLowerCase()
    let c = await db.customers.filter((cc:any)=> (cc.email||'').toLowerCase()===clean).first() as any
    if(!c){
      const { uid } = await import('../repositories/result'); const { now } = await import('../repositories/result')
      const rec:any = { id: uid(), type:'customer', title: nameRaw.split('<')[0].trim()||clean.split('@')[0], description:'', emoji:'👤', tags:['邮件'], createdAt:now(), updatedAt:now(), relations:[], company:'', email: clean, stage:'lead', isKey:false, level:'C', followUpAt: new Date(Date.now()+3*86400000).toISOString().slice(0,10) }
      await db.customers.put(rec); c = rec
    }
    return c
  }

  const openMail = useCallback(async (m: EmailMessage, markAsRead = true) => {
    setSelected(m)
    setBodyError('')
    setAttachments([])
    setShowTrans(false)
    setTranslated('')
    setExpandedIds(new Set([m.id]))
    if (markAsRead) {
      await markRead(m.id, true)
      setEmails(prev => prev.map(x => x.id === m.id ? { ...x, isRead: true } : x))
      // 未读列表：读完即从列表消失（Gmail 行为）
      void refreshServerMeta()
    }
    if (!m.text && !m.html) {
      setBodyLoading(true)
      try {
        const full = await loadMailBody(m)
        setSelected(full)
        setEmails(prev => prev.map(x => x.id === full.id ? full : x))
        if (!full.text && !full.html) setBodyError('正文未入库，可点「入库」补全文或稍后再试')
      } catch (e: any) {
        setBodyError(String(e?.message || e).slice(0, 80))
      } finally {
        setBodyLoading(false)
      }
    }
    if (m.uid != null) {
      listAttachments(m.accountId, m.uid).then(setAttachments).catch(()=>{})
    }
  }, [])

  const refreshServerMeta = useCallback(async () => {
    try {
      const accs = accounts.length ? accounts : await listAccounts()
      if (!accs.length) { setServerDrafts([]); setServerUnread(null); return }
      setServerDrafts(await getDrafts())
      setServerUnread(await getUnreadCount(accs[0].id))
    } catch {}
  }, [accounts])
  useEffect(() => { void refreshServerMeta() }, [refreshServerMeta])

  useEffect(()=>{
    if(!selected) { setCustomer(null); setDeepAnalysis(null); setAttachments([]); setBodyError(''); setCustSeq(null); return }
    ;(async()=>{
      const c = await db.customers.filter((cc:any)=> (cc.email||'').toLowerCase()=== (selected.from.match(/<(.+?)>/)?.[1]||selected.from).trim().toLowerCase()).first() as any
      setCustomer(c||null)
      setDeepAnalysis(null)
      await refreshCustSeq(c?.id)
      if(selected.text && !selected.translated){
        const t = await translateEnToZh(selected.text)
        selected.translated = t; await db.emails.put(selected); setTranslated(t)
      } else setTranslated(selected.translated||'')
    })()
  },[selected?.id])

  const [syncing, setSyncing] = useState(false)
  const [syncProgress, setSyncProgress] = useState<{status:string, done:number, total:number, errors:number}>({status:'', done:0, total:0, errors:0})
  const handleAddAccount = async()=>{
    if(!emailAddr.trim()||!authCode.trim()) return alert('请填邮箱和16位授权码/应用密码')
    const preset = PROVIDER_PRESETS[provider]
    const imap = provider==='custom'? {host:customImap,port:993,ssl:true}: preset.imap
    const smtp = provider==='custom'? {host:customSmtp,port:465,ssl:true}: preset.smtp
    setSyncing(true)
    try{
      try{
        const cleanPass = authCode.replace(/\s/g,'')
        const { id } = await createAccountOnServer({ provider, email:emailAddr.trim(), imap, smtp, pass: cleanPass })
        let totalEmails = 0
        try { totalEmails = await getEmailCount(id) } catch {}
        const r:any = await syncReal(id, 20)
        const n = typeof r==='object' ? r.added : r
        alert(`已连接 ${emailAddr.trim()}\n邮箱共 ${totalEmails} 封邮件，本次拉取 ${n} 封`)
      }catch(e:any){
        const msg = String(e.message||e)
        if(msg.includes('请先在 云同步 登录')){
          const acc = await upsertAccount({ provider, email:emailAddr.trim(), imap, smtp, authEnc: authCode.replace(/\s/g,'') })
          await mockSync(acc.id)
          alert('未登录云同步，已用本地演示数据')
        } else { throw e }
      }
    }catch(e:any){
      alert('绑定失败：' + String(e.message||e).slice(0,200))
    }finally{
      setSyncing(false); setShowConfig(false); setAuthCode(''); await refresh()
    }
  }
  const [syncCount, setSyncCount] = useState<string>(()=> getEmailSyncConfig().limit.toString())
  const [syncInterval, setSyncInterval] = useState<number>(()=> getEmailSyncConfig().intervalMinutes)
  const [autoSync, setAutoSync] = useState<boolean>(()=> getEmailSyncConfig().enabled)
  const [analyzing, setAnalyzing] = useState(false)
  useEffect(()=>{
    const onProg=(e:any)=> setSyncProgress({status: e.detail.status||'', done: e.detail.done||0, total: e.detail.total||0, errors: e.detail.errors||0})
    const onDone=()=> refresh()
    window.addEventListener('evan-email-sync-progress', onProg as any)
    window.addEventListener('evan-email-synced', onDone as any)
    // 注意：同步进行中不再定时 refresh（之前每3秒全量重载上万封+并发写库=浏览器崩溃），只靠进度条+结束时刷新一次
    const id=setInterval(()=> setSyncProgress(prev=>{
      if(isEmailSyncing()) return prev
      const cfg = getEmailSyncConfig()
      return { status: cfg.nextSyncAt? `下次 ${new Date(cfg.nextSyncAt).toLocaleTimeString()}`:'', done:0, total:0, errors:0 }
    }), 5000)
    return ()=>{ window.removeEventListener('evan-email-sync-progress', onProg as any); window.removeEventListener('evan-email-synced', onDone as any); clearInterval(id) }
  },[])
  const handleSyncSelected = async()=>{
    if(accounts.length===0) return alert('先绑定邮箱')
    let limit: number|string = syncCount==='all' ? 1000000 : Number(syncCount)||20
    if(syncCount==='custom'){
      const v = await askText('自定义同步数量', '100')
      if(v===null) return
      if(v.trim().toLowerCase()==='all') limit=1000000 as any
      else { const n=Number(v); if(!n||n<1) return alert('数量无效'); limit=n }
    }
    setEmailSyncConfig({ limit: limit as any })
    setSyncing(true)
    try{
      const total = await syncAllEmails(limit as any)
      if(total===0) alert('未拉到新邮件')
      else alert(`后台同步完成：${total} 封`)
      await refresh()
    }catch(e:any){ alert(String(e.message||e)) }finally{ setSyncing(false) }
  }
  // 全量本地镜像已并入「刷新本地」（配置 limit=全部）；保留函数供配置抽屉调用
  const handleImportAll = async()=>{
    if(accounts.length===0) return alert('先绑定邮箱')
    if(!confirm('将后台同步全部邮件，是否继续？')) return
    setSyncCount('all'); setEmailSyncConfig({limit:1000000 as any})
    setSyncing(true)
    try{
      const total = await syncAllEmails(1000000 as any)
      alert(`后台同步完成：${total} 封邮件`)
      await refresh()
    }finally{ setSyncing(false) }
  }
  void handleImportAll
  const handleAiAnalyzeAll = async()=>{
    const pending = emails.filter(e=> !e.intent || e.intent==='其他').slice(0, 200)
    if(pending.length===0) return alert('全部已分析')
    if(emails.filter(e=> !e.intent || e.intent==='其他').length>200 && !confirm(`待分析较多，仅分析前 200 封（防浏览器崩溃），其余打开邮件时自动补，继续？`)) return
    setAnalyzing(true)
    try{
      for(const m of pending){
        m.intent = await classifyIntent(m.subject+' '+(m.text||'').slice(0,500)) as any
        m.product = /coin/i.test(m.subject+m.text)?'Coin': /patch/i.test(m.subject+m.text)?'Patch':'Coin'
        await db.emails.put(m)
      }
      await refresh(); alert('AI 分析完成')
    }finally{ setAnalyzing(false) }
  }

  const handleFollowUp = async()=>{
    if(!selected) return
    let c = customer
    if(!c){ c = await ensureCustomer(selected.from, selected.from); setCustomer(c) }
    const due = suggestFollowUpDate(selected.intent||'其他', selected.text)
    const note = await askText('跟进备注', '')
    if(note===null) return
    await db.followUps.put({ id:`fu-${Date.now()}`, customerId:c.id, dueAt: due, channel:['workbench'], note: note||'跟进', status:'pending', createdAt:new Date().toISOString()} as any)
    await db.customers.update(c.id, { followUpAt: due, notes: note } as any)
    alert(`已安排 ${due} 跟进`)
    refresh()
  }

  const handleMarkKey = async()=>{
    let c = customer
    if(!c && selected){ c = await ensureCustomer(selected.from, selected.from); setCustomer(c) }
    if(!c) return
    setMarkKeyBusy(true)
    try{
      const next = !c.isKey
      await db.customers.update(c.id, { isKey: next, level: next? 'A': 'C' } as any)
      setCustomer({...c, isKey: next, level: next? 'A':'C'} as any)
      showToast(next ? '已标为重点客户' : '已取消重点')
    }catch(e:any){
      showToast('标记失败：' + String(e?.message||e).slice(0,80))
    }finally{ setMarkKeyBusy(false) }
  }

  const handleOpenReply = ()=>{
    if(!selected) return
    const fromAddr = (selected.from.match(/<(.+?)>/)?.[1]||selected.from).trim()
    const subj = selected.subject.startsWith('Re:') ? selected.subject : `Re: ${selected.subject}`
    setReplyTo(fromAddr)
    setReplySubject(subj)
    setReplyBody('')
    setReplyHtml('')
    setScheduleAt('')
    setReplyDraftId('')
    setDraftNote('')
    setShowReply(true)
    // 恢复同收件人+主题的草稿
    getDrafts().then(ds=>{
      const hit = ds.find((d:any)=> (d.to_addr||'').includes(fromAddr) && (d.subject||'')===subj)
      if(hit){
        setReplyBody(hit.body_text||'')
        if(hit.body_html && hit.body_html !== hit.body_text) setReplyHtml(hit.body_html)
        else setReplyHtml(hit.body_text ? `<div>${String(hit.body_text).replace(/\n/g,'<br/>')}</div>` : '')
        setReplyDraftId(hit.id)
        setDraftNote(`已恢复草稿（${new Date(hit.updated_at).toLocaleString()}）`)
      }
    }).catch(()=>{})
  }

  // 草稿 10 秒自动保存（刷新不丢）
  useEffect(()=>{
    if(!showReply || !replyBody.trim()) return
    const t = setInterval(async()=>{
      try{
        const acc = accounts.find(a=> a.id === selected?.accountId) || accounts[0]
        const id = await saveDraft({ id: replyDraftId || undefined, account_id: acc?.id || '', to_addr: replyTo, subject: replySubject, body_text: replyBody, body_html: replyHtml || replyBody })
        setReplyDraftId(id)
        setDraftNote(`草稿已自动保存 ${new Date().toLocaleTimeString()}`)
        void refreshServerMeta()
      }catch{}
    }, 10000)
    return ()=> clearInterval(t)
  },[showReply, replyBody, replyTo, replySubject, replyDraftId, accounts, selected?.accountId])

  const handleQueueSend = async()=>{
    if(!selected || !replyTo || !replyBody.trim()) return
    const acc = accounts.find(a=> a.id === selected.accountId) || accounts[0]
    if(!acc){ alert('无可用邮箱账号'); return }
    setSending(true)
    try{
      const sendAt = scheduleAt ? new Date(scheduleAt).toISOString() : null
      const r = await enqueueMail(
        acc.id, replyTo, replySubject, replyBody,
        replyDraftId ? `draft-${replyDraftId}` : undefined,
        false,
        { html: replyHtml || undefined, sendAt }
      )
      if(replyDraftId) await deleteDraft(replyDraftId).catch(()=>{})
      setReplyDraftId(''); setShowReply(false); setScheduleAt('')
      alert(sendAt
        ? `已定时发送：${new Date(sendAt).toLocaleString()}（${r.id.slice(0,8)}）`
        : (r.status==='sent' ? '已发送' : `已入队，后台自动发出（${r.id.slice(0,8)}）`))
      await refreshOutbox()
    }catch(e:any){ alert('入队失败：' + String(e.message||e).slice(0,200)) }
    finally{ setSending(false) }
  }

  const refreshOutbox = useCallback(async()=>{
    try{ setOutboxList(await getOutbox()) }catch{}
  },[])

  const handleSendReply = async()=>{
    if(!selected || !replyTo || !replyBody.trim()) return
    setSending(true)
    try{
      // 找到对应账号
      const acc = accounts.find(a=> a.id === selected.accountId) || accounts[0]
      if(!acc){ alert('无可用邮箱账号'); return }
      const result = await sendEmail(acc.id, replyTo, replySubject, replyBody, replyHtml || undefined)
      if(result.ok){
        if(replyDraftId) await deleteDraft(replyDraftId).catch(()=>{})
        setReplyDraftId('')
        // 保存到已发送
        const { uid: uidFn } = await import('../repositories/result')
        await db.emails.put({
          id: uidFn(), accountId: acc.id, folder:'sent',
          from: acc.email, to: replyTo, subject: replySubject,
          text: replyBody, html: replyHtml || '', date: new Date().toISOString(),
          isRead: true, hasAttachment: false,
          customerId: customer?.id, intent: selected.intent, product: selected.product,
        } as any)
        alert('邮件已发送！')
        setShowReply(false)
        const list = await listEmails(); setEmails(list)
      }
    }catch(e:any){
      alert('发送失败：' + String(e.message||e).slice(0,200))
    }finally{ setSending(false) }
  }

  const handleAiSummary = async()=>{
    if(!selected) return
    let c = customer
    if(!c){ c = await ensureCustomer(selected.from, selected.from); setCustomer(c) }
    if(!c) return
    const hist = emails.filter(e=> e.from.includes(c.email||'') || e.to.includes(c.email||''))
    const p = await buildPortrait(c.email||'', hist)
    const summary = `${p.business} 评分${p.score} 潜在:${p.potential.join('、')}`
    await db.customers.update(c.id, { aiSummary: summary, score:p.score, portrait: p as any } as any)
    setCustomer({...c, aiSummary: summary, score:p.score} as any)
  }

  const handleDeepAnalysis = async()=>{
    if(!selected) return
    let c = customer
    if(!c){ c = await ensureCustomer(selected.from, selected.from); setCustomer(c) }
    if(!c) return
    setAnalyzingCustomer(true)
    try{
      const analysis = await generateFullAnalysis(c)
      setDeepAnalysis(analysis)
      await db.customers.update(c.id, {
        aiSummary: analysis.strategy.elevator,
        score: analysis.health.overall,
        customerType: analysis.profile.type,
        portrait: analysis as any,
      } as any)
    }finally{ setAnalyzingCustomer(false) }
  }

  const [custSeq, setCustSeq] = useState<any>(null)
  const refreshCustSeq = useCallback(async (customerId?: string) => {
    if(!customerId){ setCustSeq(null); return }
    try{
      const j = await getSequences()
      setCustSeq((j.sequences || []).find((s:any)=> s.customer_id === customerId) || null)
    }catch{ setCustSeq(null) }
  }, [])

  const handleCustomFollow = async(days:number)=>{
    if(!selected) return
    let c = customer
    if(!c){ c = await ensureCustomer(selected.from, selected.from); setCustomer(c) }
    if(!c) return
    // 防撞车：该客户正在自动序列中，设手动日期前确认是否暂停序列
    try{
      const j = await getSequences()
      const s = (j.sequences || []).find((x:any)=> x.customer_id === c.id && x.mode === 'auto')
      if(s && !confirm(`该客户正在自动序列第 ${Math.min(s.current_step,7)}/7 步，设手动跟进日期会和序列撞车。\n确定设为 ${days} 天后并暂停自动序列吗？`)) return
      if(s) await patchSequence(c.id, { mode: 'manual' })
      setCustSeq(s ? { ...s, mode: 'manual' } : null)
    }catch{}
    const d=new Date(); d.setDate(d.getDate()+days); const v=d.toISOString().slice(0,10)
    await db.customers.update(c.id,{followUpAt:v} as any)
    await db.followUps.put({id:`fu-${Date.now()}`,customerId:c.id,dueAt:v,channel:['workbench'],status:'pending',createdAt:new Date().toISOString()} as any)
    setCustomer({...c,followUpAt:v} as any)
    alert(`已设 ${v} 跟进`)
  }

  const handleStartSeqFromInbox = async()=>{
    if(!selected) return
    let c = customer
    if(!c){ c = await ensureCustomer(selected.from, selected.from); setCustomer(c) }
    if(!c || !c.email) return
    try{
      const accs = await listAccounts()
      if(!accs.length) return alert('请先绑定邮箱账号')
      if(!confirm(`为 ${c.contactName || c.title} 启动7步自动跟进？`)) return
      await startSequence({ customerId: c.id, email: c.email, accountId: accs[0].id })
      alert('自动跟进已启动，去跟进页查看进度')
      await refreshCustSeq(c.id)
    }catch(e:any){ alert('启动失败：' + String(e.message||e).slice(0,150)) }
  }

  // ====== 左栏：邮件列表（按文件夹+搜索过滤） ======
  // 未读列表：读完即移出（对齐 Gmail，不再 keepReadIds 粘住）
  const filtered = useMemo(()=>{
    return emails.filter(m=>{
      if(folder==='inbox' && m.folder!=='inbox' && m.folder!=='sent') return false
      if(folder==='sent' && m.folder!=='sent') return false
      if(folder==='drafts' && m.folder!=='drafts') return false
      if(folder==='inbox' && filter==='unread' && m.isRead) return false
      if(q && !(`${m.subject} ${m.from} ${m.text} ${m.intent}`).toLowerCase().includes(q.toLowerCase())) return false
      return true
    })
  },[emails, folder, filter, q])

  // Gmail 式会话列表：1 行 = 1 条会话
  const threadRows = useMemo(()=>{
    const src = searchMode ? searchResults : filtered
    return groupThreads(src).slice(0, searchMode ? 50 : 200)
  },[searchMode, searchResults, filtered])
  const [selectedThreadId, setSelectedThreadId] = useState<string|null>(null)
  // P2：轻量 toast
  const [uiToast, setUiToast] = useState<string>('')
  const showToast = useCallback((msg: string)=>{
    setUiToast(msg)
    window.setTimeout(()=> setUiToast(''), 3200)
  },[])
  const [aiBusy, setAiBusy] = useState<'translate'|'summary'|null>(null)
  const [markKeyBusy, setMarkKeyBusy] = useState(false)
  const openThread = useCallback(async (row: ThreadRow)=>{
    setSelectedThreadId(row.key)
    setExpandedIds(new Set([row.latest.id]))
    await openMail(row.latest, true)
  },[openMail])
  const toggleExpand = useCallback((id: string)=>{
    setExpandedIds(prev=>{
      const n = new Set(prev)
      if(n.has(id)) n.delete(id); else n.add(id)
      return n
    })
  },[])

  // ====== 中栏：当前选中邮件的往来线程（仅该客户的对话） ======
  // 合并本地 emails + 服务端搜索结果，避免搜到的会话在内存里不全
  const threadPool = useMemo(()=>{
    const m = new Map<string, EmailMessage>()
    emails.forEach(e=> m.set(e.id, e))
    searchResults.forEach(e=> { if(!m.has(e.id)) m.set(e.id, e) })
    return [...m.values()]
  },[emails, searchResults])
  const thread = useMemo(()=>{
    if(!selected) return []
    const selectedAddr = (selected.from.match(/<(.+?)>/)?.[1]||selected.from).toLowerCase()
    const selectedSubj = selected.subject.replace(/^Re:\s*/i,'').replace(/^Fwd:\s*/i,'').trim().toLowerCase()
    const ts = (d: string) => { const t = new Date(d).getTime(); return Number.isFinite(t) ? t : 0 }
    return threadPool.filter(e=>{
      const eAddr = (e.from.match(/<(.+?)>/)?.[1]||e.from).toLowerCase()
      const eTo = (e.to||'').toLowerCase()
      const eSubj = e.subject.replace(/^Re:\s*/i,'').replace(/^Fwd:\s*/i,'').trim().toLowerCase()
      // 匹配条件：同一发件人地址 + 相同主题（去掉Re:/Fwd:）
      return (eAddr===selectedAddr || eTo.includes(selectedAddr)) && eSubj===selectedSubj
      // Gmail 式：从上至下按时间正序，最新的沉底
    }).sort((a,b)=> ts(a.date)-ts(b.date))
  },[threadPool, selected])
  // 会话内任一封的正文（展开旧邮件时懒加载）
  const [threadBodies, setThreadBodies] = useState<Record<string, EmailMessage>>({})
  const ensureBody = useCallback(async (m: EmailMessage)=>{
    if(m.text || m.html){
      setThreadBodies(prev=> prev[m.id] ? prev : { ...prev, [m.id]: m })
      return m
    }
    try{
      const full = await loadMailBody(m)
      setEmails(prev=> prev.map(x=> x.id===full.id ? full : x))
      setThreadBodies(prev=> ({ ...prev, [m.id]: full }))
      return full
    }catch{
      setThreadBodies(prev=> ({ ...prev, [m.id]: m }))
      return m
    }
  },[])
  // 线程打开/变化时自动滚到底（最新邮件处，和 Gmail 一致）
  const threadBoxRef = useRef<HTMLDivElement>(null)
  useEffect(()=>{
    const el = threadBoxRef.current
    if(el) el.scrollTop = el.scrollHeight
  },[thread.length, selected?.id, expandedIds.size])

  // ====== 搜索模式：优先服务端邮件库全文检索 ======
  const [searching, setSearching] = useState(false)
  const [searchHint, setSearchHint] = useState('')
  const handleSearch = useCallback(async()=>{
    if(!q.trim()){ setSearchMode(false); setSearchResults([]); setSearchHint(''); return }
    setSearching(true); setSearchHint('')
    const kw = q.trim().toLowerCase()
    const merged = new Map<string, EmailMessage>()
    try{
      const accs = accounts.length ? accounts : await listAccounts()
      if(accs.length){
        const results = accs.length > 1
          ? await searchDbMailsAll(q.trim(), 50)
          : await searchDbMails(accs[0].id, q.trim(), 50)
        results.forEach(e=> merged.set(e.id, e))
      } else {
        setSearchHint('未绑定邮箱账号，仅搜本地')
      }
    }catch(e:any){
      setSearchHint(`服务端检索失败（${String(e.message||e).slice(0,40)}），已回退本地`)
    }
    finally{ setSearching(false) }
    // 本地库直查（不依赖内存 state，state 可能为空或过期）
    try{
      const local = await db.emails.toArray()
      local.filter(e =>
        `${e.subject} ${e.from} ${e.to||''} ${e.text||''} ${e.intent||''}`.toLowerCase().includes(kw)
      ).slice(0, 50).forEach(e=>{ if(!merged.has(e.id)) merged.set(e.id, e as EmailMessage) })
    }catch{}
    // 内存 state 兜底
    emails.filter(e =>
      `${e.subject} ${e.from} ${e.text} ${e.intent}`.toLowerCase().includes(kw)
    ).slice(0, 50).forEach(e=>{ if(!merged.has(e.id)) merged.set(e.id, e) })
    setSearchResults([...merged.values()].slice(0, 50))
    if(merged.size===0) setSearchHint(h=> h || '本地与服务端库均无匹配：可点顶栏「🗄️ 入库」把邮件先入库，或点「⟳ 同步」拉取到本地')
    setSearchMode(true)
  },[emails, q, accounts])

  // ====== 服务端邮件库：一次全量入库 + 增量状态 ======
  const [dbFolders, setDbFolders] = useState<DbMailFolderStatus[]>([])
  const [ingestJob, setIngestJob] = useState<any>(null)
  const [watchOff, setWatchOff] = useState(false)
  const refreshDbStatus = useCallback(async()=>{
    try{
      const accs = accounts.length ? accounts : await listAccounts()
      if(!accs.length) return
      setDbFolders(await dbMailStatus(accs[0].id))
      setIngestJob(await mailIngestStatus(accs[0].id))
      try{ setWatchOff((await getWatchPaused()).paused) }catch{}
    }catch{}
  },[accounts])
  useEffect(()=>{ void refreshDbStatus() },[refreshDbStatus])
  // 后台轻量轮询：捕获服务端自动增量（Gmail API tick）并刷新库计数
  useEffect(()=>{
    const t = setInterval(()=>{ void refreshDbStatus() }, 10000)
    return ()=> clearInterval(t)
  },[refreshDbStatus])
  // 实时同步：运行中每 2s 拉 job（含 dbCount/bodyCount/added/apiCalls）
  useEffect(()=>{
    if(!ingestJob?.running) return
    const t = setInterval(async()=>{
      try{
        const accs = await listAccounts()
        if(!accs.length) return
        const job = await mailIngestStatus(accs[0].id)
        setIngestJob(job)
        // 同步中也轻量刷库计数（服务端 COUNT 单行，不重载邮件列表）
        if(job?.running || job?.dbCount){
          try{ setDbFolders(await dbMailStatus(accs[0].id, true)) }catch{}
        }
        if(!job?.running){
          setDbFolders(await dbMailStatus(accs[0].id))
          void refresh()
        }
      }catch{}
    }, 2000)
    return ()=> clearInterval(t)
  },[ingestJob?.running])
  const handleIngest = useCallback(async(mode: 'full'|'incremental')=>{
    try{
      const accs = accounts.length ? accounts : await listAccounts()
      if(!accs.length){ alert('请先绑定邮箱账号'); return }
      const job = await startMailIngest(accs[0].id, mode)
      setIngestJob(job)
    }catch(e:any){ alert(String(e.message||e).slice(0,200)) }
  },[accounts])

  return (
    <div className="flex flex-col h-[calc(100vh-48px)] -m-4 md:-m-6 max-w-none">
      {askModal}
      {uiToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-gray-900 text-white text-xs rounded-full shadow-lg">
          {uiToast}
        </div>
      )}
      {/* 顶部配置条 */}
      <div className="px-4 py-2 border-b border-gray-100 bg-white flex items-center gap-2 flex-wrap">
        <Mail size={18} className="text-blue-500"/>
        <span className="text-sm font-bold text-gray-800">邮件中心 · 客户经营</span>
        <span className="text-xs text-gray-400">通用 IMAP 全量支持 · 自动翻译/意图/跟进</span>
        <div className="ml-auto flex items-center gap-1.5 flex-wrap">
          {folder==='inbox' && (
            <button
              onClick={()=> setFilter(filter==='unread'?'all':'unread')}
              className="px-2 py-1 border rounded text-xs bg-white text-gray-600 hover:bg-gray-50"
              title="收件箱内切换：全部 / 仅未读（读完即消失）"
            >{filter==='unread'?'仅未读':'收件箱'}</button>
          )}
          <label
            className="flex items-center gap-1 px-2 py-1 bg-white border rounded text-xs text-gray-600 cursor-pointer"
            title="从服务器库自动刷新到浏览器本地（不碰 Gmail）"
          >
            <input
              type="checkbox"
              checked={autoSync}
              onChange={e=>{ setAutoSync(e.target.checked); setEmailSyncConfig({enabled:e.target.checked}) }}
            />
            自动
            <select
              value={String(syncInterval)}
              onChange={e=>{ const v=Number(e.target.value); setSyncInterval(v); setEmailSyncConfig({intervalMinutes:v}) }}
              className="border-0 bg-transparent text-[11px] text-gray-500 outline-none cursor-pointer"
              title="本地镜像间隔"
            >
              <option value="1">1分</option><option value="5">5分</option><option value="10">10分</option>
              <option value="30">30分</option><option value="60">1时</option><option value="1440">1天</option>
            </select>
          </label>
          <button
            onClick={handleSyncSelected}
            disabled={syncing}
            className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs flex items-center gap-1.5 hover:bg-blue-700 disabled:opacity-50"
            title="从服务器库刷新本地邮件列表（镜像，不重新拉 Gmail）"
          >{syncing?'刷新中…':'⟳ 刷新本地'}</button>
          <button
            onClick={async()=>{ await refreshOutbox(); setShowOutbox(true) }}
            className="px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-xs hover:bg-gray-50"
            title="排队中 / 发送失败的邮件"
          >
            📤 待发{outboxList.filter(o=> o.status==='failed').length>0 ? ` · ${outboxList.filter(o=> o.status==='failed').length}失败` : ''}
          </button>
          <button
            onClick={()=> handleIngest(dbFolders[0]?.fullSyncDone ? 'incremental' : 'full')}
            disabled={!!ingestJob?.running}
            className="px-3 py-1.5 bg-teal-600 text-white rounded-lg text-xs hover:bg-teal-700 disabled:opacity-50"
            title="从 Gmail 拉入服务器邮件库（首次全量，之后增量；含附件补全）"
          >
            {ingestJob?.running
              ? (ingestJob.engine === 'gmail-api' || ingestJob.mode === 'gmail'
                  ? `${ingestJob.phase?.startsWith('full-body')||ingestJob.phase==='body-backfill' ? '补正文' : ingestJob.phase==='attachments' ? '补附件' : ingestJob.phase === 'incremental' ? '增量' : '拉邮件'} ${ingestJob.dbCount || ingestJob.done || 0}`
                  : `拉取中 ${ingestJob.done}/${ingestJob.total}`)
              : '📥 拉邮件'}
          </button>
          {accounts.some(a=> (a.provider||'')!=='gmail') && (
            <button
              onClick={async()=>{
                try{
                  const r = await setWatchPaused(!watchOff)
                  setWatchOff(r.paused)
                }catch(e:any){ alert(String(e.message||e).slice(0,150)) }
              }}
              className={`px-2 py-1.5 rounded-lg text-xs border ${watchOff ? 'bg-green-50 text-green-600 border-green-200' : 'bg-white text-gray-500'}`}
              title="IMAP 实时监听开关（Gmail OAuth 账号不使用）"
            >{watchOff ? '▶ 实时' : '⏸ 监听'}</button>
          )}
          {(dbFolders.length>0 && dbFolders[0] || ingestJob?.running) && (
            <span
              className="text-[10px] text-gray-400 hidden lg:inline flex items-center gap-1"
              title={`服务器库 ${(ingestJob?.running ? ingestJob.dbCount : dbFolders[0]?.dbCount) || 0} 封 · 正文 ${(ingestJob?.running ? ingestJob.bodyCount : dbFolders[0]?.bodyCount) || 0} · 占位 ${ingestJob?.running ? ingestJob.placeholderCount : dbFolders[0]?.placeholderCount || 0}${ingestJob?.running && ingestJob.apiCalls>0 ? ` · 本次 API ${ingestJob.apiCalls}` : ''}`}
            >
              {ingestJob?.running && <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse inline-block" />}
              {(ingestJob?.running ? ingestJob.dbCount : dbFolders[0]?.dbCount) || 0} 封
              {' · 正文 '}{(ingestJob?.running ? ingestJob.bodyCount : dbFolders[0]?.bodyCount) || 0}
              {ingestJob?.phase==='attachments' && (ingestJob.attDone||0)>0 && ` · 附件+${ingestJob.attDone}`}
            </span>
          )}
          <button
            onClick={handleAiAnalyzeAll}
            disabled={analyzing}
            className="px-2 py-1 bg-green-600 text-white rounded-lg text-xs hidden md:block"
            title="对本地邮件批量跑意图/产品分类"
          >{analyzing?'分析中…':'AI分析'}</button>
        </div>
        <button onClick={()=> setShowConfig(v=>!v)} className="px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-xs flex items-center gap-1.5 hover:bg-gray-50"><Settings size={12}/> 配置</button>
        <div className="relative">
          <button onClick={()=> setShowAccountPop(v=>!v)} className="px-2 py-1 bg-gray-900 text-white rounded-full text-xs flex items-center gap-1">{accounts.length} 账号 · {emails.length} 封 ▾</button>
          {showAccountPop && (
            <div className="absolute right-0 top-7 w-72 bg-white border rounded-xl shadow-lg p-3 z-20">
              <div className="text-xs font-semibold mb-2">已绑定账号</div>
              {accounts.map(a=>{
                const cnt = emails.filter(e=> e.accountId===a.id).length
                return <div key={a.id} className="flex items-center gap-2 py-1.5 border-b last:border-0 text-xs">
                  <span className="w-2 h-2 bg-green-500 rounded-full"/>
                  <span className="truncate flex-1">{a.email}</span>
                  <span className="text-gray-400">{cnt}封</span>
                  <button onClick={async(e)=>{ e.stopPropagation(); if(!confirm(`移除 ${a.email}？`)) return; await deleteAccount(a.id); await refresh() }} className="px-1.5 py-0.5 text-red-400 hover:text-red-600 border rounded text-[10px]">移除</button>
                </div>
              })}
              {accounts.length===0 && <div className="text-xs text-gray-400">暂无账号</div>}
            </div>
          )}
        </div>
      </div>

      {/* 配置抽屉（含同步进度，功能不变） */}
      {showConfig && (
        <div className="m-3 p-4 bg-white rounded-2xl border shadow-sm">
          <div className="text-xs font-semibold text-gray-600 mb-2">通用 IMAP 接入</div>
          <div className="grid grid-cols-3 md:grid-cols-6 gap-2 mb-3">
            {Object.entries(PROVIDER_PRESETS).map(([k,v])=>(
              <button key={k} onClick={()=> setProvider(k as any)} className={`px-3 py-2 rounded-lg border text-xs ${provider===k?'border-red-300 bg-red-50 text-red-600':'border-gray-200 text-gray-500'}`}>{v.label}</button>
            ))}
          </div>
          {provider==='gmail' && (
            <div className="mb-3 p-3 bg-blue-50/60 border border-blue-100 rounded-xl space-y-2">
              <div className="text-xs font-semibold text-blue-700">🔐 Gmail 推荐走 Google 授权（OAuth，不限流）</div>
              <div className="text-[11px] text-gray-500">已用 IMAP 授权码绑过的 Gmail，点账号旁「⬆️ 升级到官方 API」：会弹出 Google 官方授权窗口，同意后自动切换为 REST API 模式并停用 IMAP 同步。QQ/网易/163/Outlook 请继续用下面的授权码方式。</div>
              <div className="flex flex-wrap items-center gap-2">
                {accounts.filter(a=> (a.provider||'')==='gmail').map(a=>(
                  <OAuthBadge key={a.id} accountId={a.id} email={a.email} onChanged={()=> refresh()} />
                ))}
                {accounts.filter(a=> (a.provider||'')==='gmail').length===0 && <OAuthBindButton onDone={()=> refresh()} />}
              </div>
              <details className="text-[11px] text-gray-500">
                <summary className="cursor-pointer hover:text-gray-700">高级：Client ID 配置（Google Cloud Console 建一次即可）</summary>
                <OAuthAppForm />
              </details>
            </div>
          )}
          <div className="grid md:grid-cols-2 gap-3">
            <div><div className="text-xs text-gray-400 mb-1">邮箱地址：</div><input value={emailAddr} onChange={e=> setEmailAddr(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm"/></div>
            <div><div className="text-xs text-gray-400 mb-1">授权码：</div><input value={authCode} onChange={e=> setAuthCode(e.target.value)} type="password" className="w-full px-3 py-2 border rounded-lg text-sm"/></div>
          </div>
          {provider==='custom' && <div className="grid md:grid-cols-2 gap-3 mt-2"><input value={customImap} onChange={e=> setCustomImap(e.target.value)} placeholder="IMAP 主机" className="px-3 py-2 border rounded-lg text-sm"/><input value={customSmtp} onChange={e=> setCustomSmtp(e.target.value)} placeholder="SMTP 主机" className="px-3 py-2 border rounded-lg text-sm"/></div>}
          <div className="mt-3 flex gap-2">
            <button onClick={handleAddAccount} className="px-4 py-2 bg-pink-500 text-white rounded-lg text-sm">连接并绑定</button>
            <button onClick={()=> setShowConfig(false)} className="px-3 py-2 text-xs text-gray-400">收起</button>
          </div>
          {/* 同步进度（ idle 倒计时也在内，功能不变） */}
          {(syncing || syncProgress.status) && (
            <div className="mt-3 px-3 py-1.5 bg-blue-50 border border-blue-100 rounded-lg text-xs text-blue-700 flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${syncing?'bg-blue-500 animate-pulse':'bg-green-500'}`}/>
              {syncing ? `同步中… ${syncProgress.status}` : syncProgress.status}
              {syncing && syncProgress.total>0 && (
                <div className="flex-1 max-w-[200px] h-1.5 bg-blue-100 rounded-full overflow-hidden ml-2">
                  <div className="h-full bg-blue-500 rounded-full transition-all" style={{width:`${Math.min(100,Math.round(syncProgress.done/syncProgress.total*100))}%`}}/>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 三栏主体 */}
      <div className="flex-1 flex gap-2 p-2 overflow-hidden min-w-0">

        {/* ====== 左栏：邮件列表 + 搜索 ====== */}
        <div className="w-[240px] shrink-0 bg-white rounded-2xl border flex flex-col overflow-hidden">
          <div className="p-2 border-b space-y-2">
            <div className="flex items-center gap-1">
              <button
                onClick={()=>{ setFolder('inbox'); setFilter('all'); setSearchMode(false); void refreshServerMeta() }}
                className={`flex-1 py-1 rounded-lg text-xs ${folder==='inbox'&&filter==='all'?'bg-blue-600 text-white':'bg-gray-100 text-gray-600'}`}
                title="收件箱 + 已发送，最新在上"
              >收件箱</button>
              <button
                onClick={()=>{ setFolder('inbox'); setFilter('unread'); setSearchMode(false); void refreshServerMeta() }}
                className={`flex-1 py-1 rounded-lg text-xs ${folder==='inbox'&&filter==='unread'?'bg-blue-600 text-white':'bg-gray-100 text-gray-600'}`}
                title="仅未读；读完即消失"
              >未读{serverUnread!=null?` ·${serverUnread}`:''}</button>
              <button
                onClick={async()=>{ setFolder('drafts'); setSearchMode(false); try{ setServerDrafts(await getDrafts()) }catch{} }}
                className={`flex-1 py-1 rounded-lg text-xs ${folder==='drafts'?'bg-orange-500 text-white':'bg-gray-100 text-gray-600'}`}
              >草稿{folder==='drafts'&&serverDrafts.length?`·${serverDrafts.length}`:''}</button>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-300"/>
                <input value={q} onChange={e=> setQ(e.target.value)} onKeyDown={e=>{ if(e.key==='Enter') handleSearch() }} placeholder="搜索邮件（回车检索）" className="w-full pl-7 pr-2 py-1.5 bg-gray-50 border rounded-lg text-xs"/>
              </div>
              {q && <button onClick={()=>{ setQ(''); setSearchMode(false); setSearchHint('') }} className="text-gray-400 hover:text-gray-600"><X size={14}/></button>}
            </div>
          </div>
          <div className="px-2 py-1 border-b text-xs text-gray-400">
            {searching ? '服务端检索中…' : searchMode
              ? `搜索结果 ${threadRows.length} 个会话${searchHint ? ` · ${searchHint}` : ''}`
              : `${threadRows.length} 个会话 · ${filtered.length} 封`}
          </div>
          <div className="flex-1 overflow-y-auto">
            {/* 搜索模式：显示搜索结果 */}
            {!searchMode && folder==='drafts' && serverDrafts.length>0 && (
              <>
                {serverDrafts.map(d=>(
                  <button key={d.id} onClick={async()=>{
                    setLoadingDraftId(d.id)
                    setReplyTo(d.to_addr||'')
                    setReplySubject(d.subject||'')
                    setReplyBody(d.body_text||d.body_html||'')
                    setReplyDraftId(d.id)
                    setDraftNote(`已打开草稿（${new Date(d.updated_at).toLocaleString()}）`)
                    setShowReply(true)
                    setLoadingDraftId('')
                  }} className="w-full text-left p-3 border-b border-gray-50 hover:bg-orange-50/50">
                    <div className="flex items-center gap-1.5 text-xs">
                      <span className="font-medium text-gray-700 truncate">{(d.to_addr||'未填收件人').split('<')[0].trim()||d.to_addr}</span>
                      {loadingDraftId===d.id && <span className="ml-auto text-[10px] text-orange-500">打开中…</span>}
                    </div>
                    <div className="text-xs text-gray-800 truncate mt-1">{d.subject||'(无主题)'}</div>
                    <div className="text-xs text-gray-400 truncate">{(d.body_text||'').slice(0,60)}</div>
                    <div className="flex gap-1 mt-1">
                      <span className="text-[10px] text-gray-400">{new Date(d.updated_at).toLocaleDateString()}</span>
                      <span
                        className="ml-auto text-[10px] text-red-400 hover:text-red-600"
                        onClick={async(e)=>{ e.stopPropagation(); if(!confirm('删除该草稿？')) return; await deleteDraft(d.id); setServerDrafts(await getDrafts()) }}
                      >删除</span>
                      <span
                        className="text-[10px] text-blue-500 hover:text-blue-700"
                        onClick={async(e)=>{ e.stopPropagation(); const r = await appendGmailDraft(d.account_id||'', d.id); alert(r.ok?`已写入 Gmail 草稿箱${r.uid?` UID ${r.uid}`:''}`:`写入失败：${r.error||'未知'}`) }}
                      >同步到Gmail</span>
                    </div>
                  </button>
                ))}
              </>
            )}
            {folder!=='drafts' && threadRows.map(row=>{
              const m = row.latest
              const isSel = selectedThreadId===row.key || selected?.id===m.id
              return (
                <button key={row.key} onClick={()=> void openThread(row)}
                  className={`w-full text-left p-3 border-b border-gray-50 hover:bg-blue-50/50 ${isSel?'bg-blue-50 border-l-2 border-l-blue-500':''}`}>
                  <div className="flex items-center gap-1.5 text-xs">
                    <span className={`w-1.5 h-1.5 rounded-full ${row.hasUnread?'bg-blue-500':'bg-gray-200'}`}/>
                    <span className={`truncate ${row.hasUnread?'font-semibold text-gray-900':'font-medium text-gray-700'}`}>{row.title}</span>
                    <span className={`ml-auto shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-600 font-medium`} title={`会话共 ${row.count} 封`}>{row.count}</span>
                    <span className={`text-[9px] px-1 py-0.5 rounded shrink-0 ${INTENT_COLOR[row.intent]||'bg-gray-100'}`}>{row.intent}</span>
                  </div>
                  <div className={`text-xs truncate mt-1 ${row.hasUnread?'text-gray-900 font-medium':'text-gray-800'}`}>{row.subject}</div>
                  <div className="flex items-center gap-1 mt-1 text-[10px] text-gray-400">
                    <span>{row.hasAttachment?'📎':''} {(m.text||'').slice(0,50) || '（打开查看正文）'}</span>
                    <span className="ml-auto shrink-0">{new Date(row.date).toLocaleDateString()}</span>
                  </div>
                </button>
              )
            })}
            {folder!=='drafts' && threadRows.length===0 && (
              <div className="p-8 text-center text-xs text-gray-300">{searchMode?'无搜索结果':'暂无邮件'}</div>
            )}
            {!searchMode && threadRows.length>=200 && (
              <div className="p-3 text-center text-[11px] text-gray-400 border-t">仅显示前 200 个会话，更多请用上方搜索（走服务端全库检索）</div>
            )}
          </div>
        </div>

        {/* ====== 中栏：邮件往来（纯邮件展示） ====== */}
        <div className="flex-1 min-w-0 bg-white rounded-2xl border flex flex-col overflow-hidden">
          {!selected ? (
            <div className="flex-1 flex flex-col items-center justify-center text-gray-300 space-y-3">
              <Mail size={48} className="opacity-30"/>
              <div className="text-sm">选择一封邮件开始</div>
              <div className="text-xs text-gray-300">或在左侧搜索关键词查找邮件</div>
            </div>
          ) : (
            <>
              {/* 选中邮件头部 */}
              <div className="p-3 border-b flex items-center justify-between">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-gray-800 flex items-center gap-2 truncate">
                    {selected.subject}
                    {thread.length>1 && (
                      <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-600 border border-blue-100" title="会话内邮件数">
                        {thread.length} 封
                      </span>
                    )}
                    <button onClick={()=> setShowTrans(v=>!v)} className="px-2 py-0.5 bg-white border rounded text-xs flex items-center gap-1 shrink-0"><Languages size={12}/> {showTrans?'原文':'翻译'}</button>
                    <button onClick={()=> setAllowRemoteImg(v=>!v)} title="外部图片可能泄露已读回执" className="px-2 py-0.5 bg-white border rounded text-xs shrink-0">{allowRemoteImg?'🖼️':'🚫🖼️'}</button>
                  </div>
                  <div className="text-xs text-gray-400 truncate">发件：{selected.from} → {selected.to} · {new Date(selected.date).toLocaleString()}</div>
                </div>
              </div>

              <div ref={threadBoxRef} className="flex-1 overflow-y-auto">
                {/* Gmail 式会话：头像 + 名字 + 正文摘要；旧邮件默认折叠，最新默认展开 */}
                <div className="divide-y divide-gray-100">
                {(thread.length ? thread : [selected]).map((m)=>{
                  const isFocus = m.id === selected.id
                  // 只认 expandedIds；最新/焦点也可手动收起
                  const expanded = expandedIds.has(m.id)
                  const bodyM = threadBodies[m.id] || m
                  const name = displayNameOf(m)
                  const snippet = mailSnippet(bodyM, 110) || '（打开加载正文）'
                  const self = isSelfSender(m)
                  const color = self ? SELF_COLOR : avatarColor(counterpartOf(m) || name)
                  const initial = (name || '?').trim().charAt(0).toUpperCase()
                  return (
                    <div key={m.id} className={`${isFocus?'bg-blue-50/30':''}`}>
                      {/* 行头：Gmail 式「头像 + 名字 + 摘要」 */}
                      <button
                        onClick={async()=>{
                          const willOpen = !expanded
                          toggleExpand(m.id)
                          if(willOpen){
                            setSelected(m)
                            await ensureBody(m)
                            if(m.uid!=null) listAttachments(m.accountId, m.uid).then(setAttachments).catch(()=>{})
                          }
                        }}
                        className="w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-gray-50/80">
                        <span
                          className={`w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-semibold shrink-0 mt-0.5 relative ${self?'ring-2 ring-blue-200':''}`}
                          style={{ background: color }}
                          title={self?'我（Evan）':name}
                        >
                          {initial}
                          {self && <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 bg-white rounded-full flex items-center justify-center text-[8px]">✓</span>}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline gap-2">
                            <span className="text-[13px] font-semibold text-gray-900 truncate">
                              {name}
                              {self && <span className="ml-1 text-[10px] px-1 py-0.5 rounded bg-blue-50 text-blue-700 align-middle">我</span>}
                            </span>
                            <span className="text-[11px] text-gray-400 shrink-0 ml-auto">
                              {new Date(m.date).toLocaleString(undefined,{ month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })}
                            </span>
                          </span>
                          {!expanded ? (
                            <span className="block text-[12px] text-gray-500 truncate mt-0.5">{snippet}</span>
                          ) : (
                            <span className="block text-[11px] text-gray-400 truncate mt-0.5">
                              {m.folder==='sent'?'发给':'来自'} {m.folder==='sent'? (m.to||'').slice(0,60) : (m.from||'').slice(0,60)}
                            </span>
                          )}
                        </span>
                        <span className="text-[11px] text-gray-300 shrink-0 self-center">{expanded?'▾':'▸'}</span>
                      </button>
                      {/* 展开正文 */}
                      {expanded && (
                        <div className="px-4 pb-4 pl-15 space-y-2" style={{ paddingLeft: 52 }}>
                          {showTrans && isFocus ? (
                            <div className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">{translated || '翻译中...'}</div>
                          ) : bodyLoading && isFocus ? (
                            <div className="text-sm text-gray-500 flex items-center gap-2 py-2">
                              <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse"/> 正文加载中…
                            </div>
                          ) : bodyM.html ? (
                            <MailHtml html={bodyM.html} allowRemote={allowRemoteImg} />
                          ) : (
                            <div>
                              <MailTextBody text={bodyM.text||''} />
                              {isFocus && bodyError && (
                                <button onClick={()=> openMail(m, false)} className="ml-2 mt-1 px-2 py-0.5 text-[11px] border rounded bg-blue-50 text-blue-600">重试</button>
                              )}
                            </div>
                          )}
                          {isFocus && attachments.length>0 && (
                            <div className="space-y-2">
                              {attachments.filter(isImageAtt).length>0 && (
                                <div className="flex flex-wrap gap-2">
                                  {attachments.filter(isImageAtt).map(a=>(
                                    <a key={a.filename} href={a.url} target="_blank" rel="noreferrer" className="block">
                                      <img src={a.url} alt={a.filename} className="max-h-48 max-w-[280px] rounded-lg border object-contain bg-gray-50" loading="lazy"/>
                                      <div className="text-[10px] text-gray-400 mt-0.5 truncate max-w-[280px]">{a.filename}</div>
                                    </a>
                                  ))}
                                </div>
                              )}
                              <div className="flex flex-wrap gap-2">
                                {attachments.map(a=>(
                                  <a key={`att-${a.filename}`} href={a.url} target="_blank" rel="noreferrer" className="text-[11px] px-2 py-1 border rounded-lg bg-gray-50 hover:bg-blue-50 text-blue-600">
                                    {isImageAtt(a)?'🖼️':'📎'} {a.filename} <span className="text-gray-400">({Math.round((a.size||0)/1024)}KB)</span>
                                  </a>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
                </div>
                {thread.length===0 && <div className="p-6 text-center text-xs text-gray-300">暂无同主题往来</div>}

                {/* 快捷操作（P2：loading / toast） */}
                <div className="flex gap-1 flex-wrap p-4 pt-2">
                  <button
                    disabled={aiBusy!==null || !selected?.text}
                    onClick={async()=>{
                      if(!selected?.text) return showToast('无正文可翻译')
                      setAiBusy('translate')
                      try{
                        const t = await translateEnToZh(selected.text)
                        if(!t) showToast('翻译失败，请检查 AI 配置或云同步')
                        else { setTranslated(t); setShowTrans(true); showToast('已切换为中文翻译') }
                      }catch(e:any){ showToast('翻译失败：'+String(e?.message||e).slice(0,80)) }
                      finally{ setAiBusy(null) }
                    }}
                    className="px-2 py-1 bg-white border rounded text-xs flex items-center gap-1 disabled:opacity-50"
                  ><Languages size={12}/> {aiBusy==='translate'?'翻译中…':'翻译'}</button>
                  <button
                    disabled={aiBusy!==null || !selected}
                    onClick={async()=>{
                      if(!selected) return
                      setAiBusy('summary')
                      try{
                        const s = await summarizeEmail(selected)
                        if(!s) showToast('摘要失败，请检查 AI 配置')
                        else alert(s)
                      }catch(e:any){ showToast('摘要失败：'+String(e?.message||e).slice(0,80)) }
                      finally{ setAiBusy(null) }
                    }}
                    className="px-2 py-1 bg-white border rounded text-xs disabled:opacity-50"
                  >{aiBusy==='summary'?'摘要中…':'AI摘要'}</button>
                  <button
                    disabled={markKeyBusy}
                    onClick={handleMarkKey}
                    className={`px-2 py-1 rounded text-xs flex items-center gap-1 disabled:opacity-50 ${customer?.isKey?'bg-yellow-500 text-white':'bg-white border'}`}
                  ><Star size={12}/> {markKeyBusy?'保存中…':(customer?.isKey?'已重点':'标记重点')}</button>
                  <button onClick={handleOpenReply} className="px-2 py-1 bg-blue-50 text-blue-600 border border-blue-200 rounded text-xs flex items-center gap-1"><Send size={10}/> 回复</button>
                  <button onClick={async()=>{
                    if(!selected) return
                    try{
                      await markRead(selected.id, false)
                      setEmails(prev=> prev.map(x=> x.id===selected.id? {...x, isRead:false}:x))
                      setSelected(s=> s? {...s, isRead:false}:s)
                      void refreshServerMeta()
                      showToast('已标为未读')
                    }catch(e:any){ showToast('标为未读失败：'+String(e?.message||e).slice(0,80)) }
                  }} className="px-2 py-1 bg-white border rounded text-xs">标为未读</button>
                </div>
              </div>
            </>
          )}
        </div>

        {/* ====== 右栏：AI 侧栏（含客户信息 + AI工作台 + 深度分析 + 跟进 + 推荐回复） ====== */}
        <div className="w-[320px] shrink-0 bg-white rounded-2xl border flex flex-col overflow-hidden">
          <div className="p-3 border-b text-xs font-semibold text-gray-600 flex items-center gap-1.5">
            <Brain size={12}/> AI 侧栏
            {customer && <span className="ml-auto text-[10px] text-gray-400">{customer.title||customer.email}</span>}
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {/* 客户信息卡片 */}
            <div className="rounded-xl border p-3 bg-gradient-to-br from-blue-50 to-purple-50">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-400 to-purple-500 flex items-center justify-center text-white font-bold text-sm">
                  {(customer?.contactName||selected?.from||'?')[0].toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-gray-800 truncate">{customer?.contactName||selected?.from?.split('<')[0]||'未知'}</div>
                  <div className="text-[10px] text-gray-500 truncate">{customer?.company||'—'}</div>
                </div>
                {customer?.isKey && <span className="text-yellow-500 text-lg">⭐</span>}
              </div>
              <div className="text-[10px] text-gray-400 mb-2 flex items-center gap-1">
                <Mail size={10}/> {customer?.email||selected?.from||'—'}
              </div>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs px-2 py-0.5 bg-white rounded-full border">{customer?.level||'C'} {LEVEL_STAR[customer?.level||'C']}</span>
                <span className="text-[10px] text-gray-400">|</span>
                <span className="text-[10px] text-gray-500">{customer?.stage==='lead'?'线索':customer?.stage==='contacted'?'已联系':customer?.stage==='qualified'?'已确认':customer?.stage==='proposal'?'报价中':customer?.stage==='negotiation'?'谈判中':customer?.stage==='won'?'已成交':'线索'}</span>
              </div>
              <div className="flex gap-1">
                <button onClick={handleMarkKey} className={`flex-1 py-1.5 rounded-lg text-xs flex items-center justify-center gap-1 ${customer?.isKey?'bg-yellow-100 text-yellow-600 border border-yellow-200':'bg-white text-gray-600'}`}><UserCheck size={12}/> {customer?.isKey?'已重点':'标记重点'}</button>
                <button onClick={handleAiSummary} className="flex-1 py-1.5 bg-white text-purple-600 rounded-lg text-xs flex items-center justify-center gap-1"><Sparkles size={12}/> AI总结</button>
              </div>
              {customer?.aiSummary && <div className="mt-2 text-[11px] bg-white/70 rounded p-2 text-gray-600">{customer.aiSummary}</div>}
            </div>

            {/* 邮件往来统计 */}
            <div className="rounded-xl border p-3">
              <div className="text-xs font-semibold text-gray-700 mb-2 flex items-center gap-1"><TrendingUp size={12}/> 往来统计</div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="bg-blue-50 rounded-lg p-2">
                  <div className="text-lg font-bold text-blue-600">{customer?.email ? emails.filter(e=>(e.from||'').toLowerCase().includes(customer.email!.toLowerCase()) || (e.to||'').toLowerCase().includes(customer.email!.toLowerCase())).length : 0}</div>
                  <div className="text-[10px] text-gray-500">{customer?.email ? '往来' : '往来（未选客户）'}</div>
                </div>
                <div className="bg-green-50 rounded-lg p-2">
                  <div className="text-lg font-bold text-green-600">{customer?.email ? emails.filter(e=>e.folder==='sent' && (e.to||'').toLowerCase().includes(customer.email!.toLowerCase())).length : 0}</div>
                  <div className="text-[10px] text-gray-500">已发送</div>
                </div>
                <div className="bg-orange-50 rounded-lg p-2">
                  <div className="text-lg font-bold text-orange-600">{customer?.email ? emails.filter(e=>e.folder==='inbox' && (e.from||'').toLowerCase().includes(customer.email!.toLowerCase()) && !e.isRead).length : 0}</div>
                  <div className="text-[10px] text-gray-500">未读</div>
                </div>
              </div>
              {/* 最近活跃 */}
              <div className="mt-2 text-[10px] text-gray-400">
                最近联系：{customer?.updatedAt ? new Date(customer.updatedAt).toLocaleDateString() : '—'}
                {customer?.followUpAt && <span className="ml-2">· 下次跟进：<span className={new Date(customer.followUpAt) < new Date() ? 'text-red-500 font-medium' : ''}>{customer.followUpAt}</span></span>}
              </div>
            </div>

            {/* AI工作台 */}
            {selected && (
              <div className="rounded-xl border border-blue-100 bg-blue-50/40 p-3 space-y-2">
                <div className="text-xs font-semibold text-gray-700">AI 工作台</div>
                <div className="grid grid-cols-2 gap-1.5 text-[11px]">
                  <div className="bg-white rounded-lg p-1.5 border"><span className="text-gray-400">意图</span> <b className="text-gray-700">{selected.intent}</b></div>
                  <div className="bg-white rounded-lg p-1.5 border"><span className="text-gray-400">产品</span> <b className="text-gray-700">{selected.product}</b></div>
                  <div className="bg-white rounded-lg p-1.5 border"><span className="text-gray-400">数量</span> <b className="text-gray-700">{selected.qty||500}</b></div>
                  <div className="bg-white rounded-lg p-1.5 border"><span className="text-gray-400">预算</span> <b className="text-gray-700">{selected.budget||'未提及'}</b></div>
                  <div className="bg-white rounded-lg p-1.5 border"><span className="text-gray-400">交期</span> <b className="text-gray-700">{selected.deadline||'Oct 15'}</b></div>
                  <div className="bg-white rounded-lg p-1.5 border"><span className="text-gray-400">意愿</span> <b className="text-orange-600">高</b></div>
                </div>
                <div className="text-[11px] bg-white rounded-lg p-2 border text-gray-600">💡 建议立即报价，并询问预算和交期</div>
                <div className="flex gap-1">
                  <button onClick={async()=>{ const t=await translateEnToZh(selected.text); setTranslated(t); setShowTrans(true)}} className="flex-1 py-1.5 bg-white border rounded text-[11px] flex items-center justify-center gap-1 hover:bg-blue-50"><Languages size={10}/> 翻译</button>
                  <button onClick={async()=>{ const s=await summarizeEmail(selected); alert(s) }} className="flex-1 py-1.5 bg-white border rounded text-[11px] hover:bg-blue-50">AI摘要</button>
                </div>
              </div>
            )}

            {/* 深度分析 */}
            <div className="rounded-xl border p-3">
              <button onClick={handleDeepAnalysis} disabled={analyzingCustomer || !selected} className="w-full py-2 bg-gradient-to-r from-blue-500 to-purple-500 text-white rounded-lg text-xs flex items-center justify-center gap-2 disabled:opacity-50">
                <Brain size={14}/>
                {analyzingCustomer ? '分析中...' : '深度客户分析'}
              </button>
              {deepAnalysis && (
                <div className="mt-3 space-y-2 text-xs">
                  <div className="font-semibold text-gray-700 flex items-center gap-1"><FileText size={12}/> 分析报告</div>
                  <div className="bg-amber-50 rounded p-2">
                    <b>RFM:</b> <span style={{color:deepAnalysis.rfm.segmentColor}}>{deepAnalysis.rfm.segment}</span>
                    <span className="ml-2">R:{deepAnalysis.rfm.recency} F:{deepAnalysis.rfm.frequency} M:{deepAnalysis.rfm.monetary} = {deepAnalysis.rfm.rfmTotal}/15</span>
                  </div>
                  <div className="bg-blue-50 rounded p-2">
                    <b>BANT:</b> <span className={`font-bold ${deepAnalysis.bant.grade==='A'?'text-green-600':deepAnalysis.bant.grade==='B'?'text-blue-600':'text-orange-600'}`}>{deepAnalysis.bant.grade}</span> ({deepAnalysis.bant.total}/100)
                  </div>
                  <div className="bg-green-50 rounded p-2">
                    <b>健康度:</b> <span style={{color:deepAnalysis.health.statusColor}}>{deepAnalysis.health.overall}/100 {deepAnalysis.health.trend==='up'?'↑':deepAnalysis.health.trend==='down'?'↓':'→'}</span>
                  </div>
                  <div className="bg-purple-50 rounded p-2"><b>画像:</b> {deepAnalysis.profile.type} · {deepAnalysis.profile.communicationStyle}</div>
                  <div className="bg-red-50 rounded p-2"><b>跟进:</b> {deepAnalysis.strategy.followUpType} · {deepAnalysis.strategy.followUpCadence}</div>
                  <div className="bg-teal-50 rounded p-2"><b>激活:</b> {deepAnalysis.strategy.activationPlan}</div>
                  {deepAnalysis.strategy.keyTopics.length > 0 && <div className="bg-gray-50 rounded p-2"><b>话题:</b> {deepAnalysis.strategy.keyTopics.join(' | ')}</div>}
                  {deepAnalysis.strategy.riskFactors.length > 0 && <div className="bg-red-50 rounded p-2"><b>风险:</b> {deepAnalysis.strategy.riskFactors.join(' | ')}</div>}
                  {deepAnalysis.strategy.opportunities.length > 0 && <div className="bg-yellow-50 rounded p-2"><b>机会:</b> {deepAnalysis.strategy.opportunities.join(' | ')}</div>}
                  {deepAnalysis.strategy.nextActions.length > 0 && <div className="bg-blue-50 rounded p-2"><b>行动:</b><ul className="mt-1 space-y-0.5">{deepAnalysis.strategy.nextActions.map((a,i)=><li key={i} className="flex items-start gap-1"><TrendingUp size={10} className="mt-0.5 shrink-0"/> {a}</li>)}</ul></div>}
                </div>
              )}
            </div>

            {/* 跟进 */}
            <div className="rounded-xl border p-3">
              <div className="text-xs font-medium text-gray-700 mb-1 flex items-center gap-1"><Calendar size={12}/> 下次跟进</div>
              <div className="text-[10px] text-gray-400 mb-1">当前：{customer?.followUpAt||'未设置'}</div>
              {custSeq ? (
                <div className="text-[11px] mb-1 px-2 py-1 rounded-lg bg-purple-50 text-purple-700">
                  🔁 自动序列{custSeq.mode==='auto' ? `第 ${Math.min(custSeq.current_step,7)}/7 步，下次 ${String(custSeq.next_due_at||'').slice(0,10)}` : custSeq.mode==='dormant' ? '（沉睡池）' : '（已转手动）'}
                </div>
              ) : (
                <button onClick={handleStartSeqFromInbox} className="w-full mb-1 py-1 rounded-lg text-[11px] bg-purple-50 text-purple-600 border border-purple-200 hover:bg-purple-100">🔁 为该客户启动7步自动序列</button>
              )}
              <div className="flex gap-1 flex-wrap">
                {[1,3,7,14,30].map(d=> <button key={d} onClick={()=> handleCustomFollow(d)} className="px-2 py-1 bg-white border rounded text-[11px] hover:bg-blue-50">{d}天</button>)}
                <button onClick={handleFollowUp} className="px-2 py-1 bg-blue-600 text-white rounded text-[11px]"><Clock size={10}/> 自定义</button>
              </div>
            </div>

            {/* AI推荐回复 */}
            <div className="rounded-xl bg-blue-50 border border-blue-100 p-3">
              <div className="text-xs font-semibold text-blue-700 mb-1 flex items-center gap-1"><Send size={12}/> AI推荐回复</div>
              <div className="text-[11px] bg-white rounded p-2 border">
                Hi {customer?.contactName||'there'},<br/>Thanks for your inquiry about {selected?.product||'our products'}. Our best price for {selected?.qty||500} pcs is $680, lead time 12 days. Could you confirm?<br/>Best regards, Evan
              </div>
              <div className="flex gap-1 mt-2">
                <button onClick={async()=>{
                  let c=customer
                  if(!c && selected){ c=await ensureCustomer(selected.from, selected.from); setCustomer(c) }
                  if(!c||!selected) return
                  const draft=`Hi ${c.contactName||c.title},\n\nThanks for your inquiry. Our best price for ${selected.qty||500} pcs is $680, lead time 12 days.\n\nBest regards, Evan`
                  const { uid } = await import('../repositories/result')
                  await db.emails.put({ id: uid(), accountId: selected.accountId, folder:'drafts', from: `Evan <evan@maxemblem.com>`, to: c.email||selected.from, subject:`Re: ${selected.subject}`, text: draft, html:'', date: new Date().toISOString(), isRead:false, hasAttachment:false, customerId: c.id, status:'待处理' } as any)
                  setFolder('drafts'); setSearchMode(false)
                  const list = await listEmails(); setEmails(list)
                  alert('草稿已生成')
                }} className="flex-1 py-1.5 bg-blue-600 text-white rounded text-[11px]">一键生成</button>
                <button onClick={handleOpenReply} className="flex-1 py-1.5 bg-green-50 text-green-600 border border-green-200 rounded text-[11px] flex items-center justify-center gap-1"><Send size={10}/> 回复</button>
                <button onClick={async()=>{
                  if(!selected) return
                  setAiDraftingReply(true)
                  try{
                    const c = customer || await ensureCustomer(selected.from, selected.from)
                    const hist = thread.slice(-10).map(e=> `[${e.date}] ${e.folder==='sent'?'我':'客'}: ${(e.text||'').slice(0,300)}`).join('\n')
                    const amounts = (hist.match(/\$\s*[\d,]+/g)||[]).slice(0,5).join(' ')
                    const prompt = `你是Maxemblem外贸业务员Evan，给下面这位客户写一封专属英文回复邮件（不是模板，必须结合他的背景和往来记录）。只返回正文，落款Evan。\n客户：${c?.contactName||c?.title}（${c?.email}，${c?.company||'公司未知'}），等级${c?.level||'C'}${c?.isKey?'重点':''}，阶段${c?.stage||''}，复购${c?.repurchaseCount||0}次\n画像：${c?.aiSummary||'无'}，常购：${(c?.portrait as any)?.products?.join('/')||'未知'}，出现过的金额：${amounts||'无'}\n最近往来：\n${hist}\n当前这封：${selected.subject}\n${(selected.text||'').slice(0,1500)}`
                    const { chatOnce } = await import('../services/aiChat')
                    const draft = await chatOnce(prompt)
                    if(!draft || draft.startsWith('⚠️')){ alert(draft||'AI 生成失败'); return }
                    const fromAddr = (selected.from.match(/<(.+?)>/)?.[1]||selected.from).trim()
                    setReplyTo(fromAddr)
                    setReplySubject(selected.subject.startsWith('Re:') ? selected.subject : `Re: ${selected.subject}`)
                    setReplyBody(draft.trim())
                    setReplyDraftId(''); setDraftNote('')
                    setShowReply(true)
                  }finally{ setAiDraftingReply(false) }
                }} disabled={aiDraftingReply} className="flex-1 py-1.5 bg-purple-50 text-purple-600 border border-purple-200 rounded text-[11px] disabled:opacity-50">{aiDraftingReply?'生成中…':'✨ 专属回复'}</button>
                <button onClick={async()=>{ if(selected){ const t=await translateEnToZh(selected.text); setTranslated(t); setShowTrans(true)} }} className="flex-1 py-1.5 bg-white border rounded text-[11px]">翻译对照</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 回复邮件弹窗：富文本 + 定时发送 */}
      {showReply && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={()=> setShowReply(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={e=> e.stopPropagation()}>
            <div className="px-5 py-3 border-b flex items-center justify-between">
              <div className="text-sm font-semibold text-gray-800">回复邮件</div>
              <button onClick={()=> setShowReply(false)} className="p-1 hover:bg-gray-100 rounded-lg"><X size={16}/></button>
            </div>
            <div className="flex-1 overflow-y-auto p-5 space-y-3">
              <div className="grid grid-cols-[60px_1fr] gap-2 text-xs items-center">
                <span className="text-gray-400">收件人</span>
                <input value={replyTo} onChange={e=> setReplyTo(e.target.value)} className="px-3 py-2 border rounded-lg text-sm bg-gray-50"/>
              </div>
              <div className="grid grid-cols-[60px_1fr] gap-2 text-xs items-center">
                <span className="text-gray-400">主题</span>
                <input value={replySubject} onChange={e=> setReplySubject(e.target.value)} className="px-3 py-2 border rounded-lg text-sm"/>
              </div>
              {/* 富文本工具栏 */}
              <div className="flex flex-wrap items-center gap-1 px-1 py-1 border rounded-t-lg bg-gray-50">
                {([
                  ['bold','B','加粗'],
                  ['italic','I','斜体'],
                  ['underline','U','下划线'],
                ] as const).map(([cmd, label, tip])=>(
                  <button key={cmd} type="button" title={tip}
                    onMouseDown={e=>{ e.preventDefault(); document.execCommand(cmd); syncEditor()}}
                    className={`w-7 h-7 rounded text-xs font-bold border bg-white ${cmd==='italic'?'italic':cmd==='underline'?'underline':''}`}
                  >{label}</button>
                ))}
                <span className="w-px h-5 bg-gray-200 mx-0.5"/>
                <label className="flex items-center gap-1 text-[10px] text-gray-500 px-1" title="文字颜色">
                  <span>A</span>
                  <input type="color" defaultValue="#111827" className="w-6 h-6 border-0 bg-transparent cursor-pointer"
                    onChange={e=>{ document.execCommand('foreColor', false, e.target.value); syncEditor() }}/>
                </label>
                <label className="flex items-center gap-1 text-[10px] text-gray-500 px-1" title="背景色">
                  <span className="px-1 rounded bg-yellow-100">底</span>
                  <input type="color" defaultValue="#fef08a" className="w-6 h-6 border-0 bg-transparent cursor-pointer"
                    onChange={e=>{ document.execCommand('hiliteColor', false, e.target.value); syncEditor() }}/>
                </label>
                <span className="w-px h-5 bg-gray-200 mx-0.5"/>
                {([
                  ['insertUnorderedList','•','无序列表'],
                  ['insertOrderedList','1.','有序列表'],
                  ['justifyLeft','☰','左对齐'],
                  ['justifyCenter','≡','居中'],
                ] as const).map(([cmd, label, tip])=>(
                  <button key={cmd} type="button" title={tip}
                    onMouseDown={e=>{ e.preventDefault(); document.execCommand(cmd); syncEditor()}}
                    className="w-7 h-7 rounded text-xs border bg-white"
                  >{label}</button>
                ))}
                <button type="button" title="插入链接"
                  onMouseDown={e=>{
                    e.preventDefault()
                    const url = prompt('链接地址 https://…')
                    if(url) { document.execCommand('createLink', false, url); syncEditor() }
                  }}
                  className="w-7 h-7 rounded text-xs border bg-white">🔗</button>
                <button type="button" title="清除格式"
                  onMouseDown={e=>{ e.preventDefault(); document.execCommand('removeFormat'); syncEditor()}}
                  className="w-7 h-7 rounded text-xs border bg-white">Tx</button>
              </div>
              <div
                ref={editorRef}
                contentEditable
                suppressContentEditableWarning
                onInput={()=> syncEditor()}
                data-ph="输入回复内容…（支持加粗、颜色、列表、链接）"
                className="min-h-[220px] px-4 py-3 border border-t-0 rounded-b-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-200 empty:before:content-[attr(data-ph)] empty:before:text-gray-300"
              />
              <div className="grid grid-cols-[60px_1fr] gap-2 text-xs items-center">
                <span className="text-gray-400">定时</span>
                <div className="flex items-center gap-2">
                  <input type="datetime-local" value={scheduleAt} onChange={e=> setScheduleAt(e.target.value)}
                    className="px-3 py-2 border rounded-lg text-sm bg-gray-50"/>
                  {scheduleAt && (
                    <button type="button" onClick={()=> setScheduleAt('')} className="text-[11px] text-gray-400 hover:text-gray-600">清除（立即）</button>
                  )}
                  <span className="text-[10px] text-gray-400">{scheduleAt ? `到点由服务器发出` : '不填=立即排队发出'}</span>
                </div>
              </div>
            </div>
            <div className="px-5 py-3 border-t flex items-center gap-2">
              <button onClick={()=> setShowReply(false)} className="px-4 py-2 text-xs text-gray-500 hover:bg-gray-100 rounded-lg">取消</button>
              {draftNote && <span className="text-[10px] text-gray-400">{draftNote}</span>}
              <div className="flex-1"/>
              <button onClick={handleQueueSend} disabled={sending || !replyBody.trim() || !replyTo} className="px-4 py-2 bg-green-50 text-green-600 border border-green-200 rounded-lg text-xs hover:bg-green-100 disabled:opacity-50" title={scheduleAt?`将在 ${scheduleAt} 发出`:'网络不稳时用这个，后台队列发出'}>
                {scheduleAt ? '📅 定时发送' : '⏳ 排队发送'}
              </button>
              <button onClick={handleSendReply} disabled={sending || !replyBody.trim() || !replyTo || !!scheduleAt} title={scheduleAt?'已设定时，只能走定时/排队':'立即 SMTP 发送'} className="px-6 py-2 bg-blue-600 text-white rounded-lg text-xs flex items-center gap-1.5 hover:bg-blue-700 disabled:opacity-50">
                <Send size={12}/> {sending ? '发送中...' : '发送'}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 发件箱弹窗 */}
      {showOutbox && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={()=> setShowOutbox(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col" onClick={e=> e.stopPropagation()}>
            <div className="px-5 py-3 border-b flex items-center justify-between">
              <div className="text-sm font-semibold">📤 发件箱 <span className="text-xs text-gray-400 font-normal">排队自动发出，失败可重试</span></div>
              <button onClick={()=> setShowOutbox(false)} className="p-1 hover:bg-gray-100 rounded-lg"><X size={16}/></button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              {outboxList.length===0 && <div className="text-center text-xs text-gray-300 py-8">暂无排队邮件</div>}
              {outboxList.map(o=>{
                const isBatch = String(o.idempotency_key||'').startsWith('batch-')
                return (
                <div key={o.id} className="p-3 border rounded-xl text-xs">
                  <div className="flex items-center gap-2">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] ${o.status==='sent'?'bg-green-100 text-green-700':o.status==='failed'?'bg-red-100 text-red-600':o.status==='cancelled'?'bg-gray-100 text-gray-500':'bg-yellow-100 text-yellow-700'}`}>
                      {o.status==='sent'?'已发送':o.status==='failed'?'失败':o.status==='cancelled'?'已取消':o.status==='sending'?'发送中':'排队中'}
                    </span>
                    {isBatch && <span className="px-1.5 py-0.5 rounded text-[10px] bg-pink-50 text-pink-600">批量跟进</span>}
                    <span className="font-medium truncate">{o.subject}</span>
                    <span className="ml-auto text-[10px] text-gray-400 shrink-0">
                      {o.send_at ? `定时 ${new Date(o.send_at).toLocaleString()}` : new Date(o.created_at).toLocaleString()}
                    </span>
                  </div>
                  <div className="text-gray-400 mt-1 truncate">→ {o.to_list}</div>
                  {o.error && <div className="text-red-400 mt-1 break-all">{o.error}</div>}
                  <div className="flex gap-2 mt-2">
                    {o.status==='failed' && (
                      <button onClick={async()=>{ await retryOutbox(o.id); await refreshOutbox() }} className="px-3 py-1 bg-blue-600 text-white rounded-lg text-[11px]">重试发送</button>
                    )}
                    {(o.status==='queued' || o.status==='failed') && (
                      <button onClick={async()=>{
                        if(!confirm('取消这封待发/定时邮件？')) return
                        try{ await cancelOutbox(o.id); await refreshOutbox(); showToast('已取消') }catch(e:any){ showToast(String(e.message||e).slice(0,80)) }
                      }} className="px-3 py-1 border rounded-lg text-[11px] text-gray-500 hover:bg-gray-50">取消发送</button>
                    )}
                  </div>
                </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
