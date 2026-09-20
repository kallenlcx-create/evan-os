// ====== 跟进中心：闭环跟进 + 真实发送 + 智能雷达 ======
import { useState, useEffect, useMemo, useCallback } from 'react'
import { db } from '../db'
import type { FollowUpRecord, Customer, EmailMessage } from '../types'
import { Calendar, Clock, Flame, AlertTriangle, DollarSign, Repeat, Megaphone, Send } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { listAccounts, sendEmail, enqueueMail, getSequences, startSequence, patchSequence, getSeqTemplates, saveSeqTemplate, getSeqConfig, saveSeqConfig, fetchCustomerAttachments, findLatestThreadHeaders, probeSeqServer } from '../repositories/emailRepository'
import { STAGE_LABELS, EVENTS, emitEvent } from '../utils/emailHelpers'
import { chatOnce } from '../services/aiChat'
import { runIntellectBatch, BATCH_SEND, getTodaySendCount, bumpTodaySendCount } from '../services/customerIntellect'
import { textToHtml, normalizeReplySubject } from '../utils/mailHtml'
import { MANUAL_BUCKETS, loadManualBuckets, loadManualBucketsAsync, removeManualBuckets, removeManualBucket, addManualBuckets, type ManualBucket } from '../services/manualBuckets'
import { runFollowBoardSync, setCustomerFollowMode, setCustomerSalesStage, followModeOf, salesStageOf, stepLabel, daysNoFollow, countFollowsSinceReply, generateAiFollowReply, customerAddrs, computeMailTimes, isBoardNoiseEmail, createdAtOf, bestFollowStepFromMails, type FollowMode, type SalesStage } from '../services/followProfile'
import { loadIntellectConfig, saveIntellectConfig, type IntellectConfig } from '../services/customerDailyClassify'
import { syncInquiriesFromMails, listInquiries, isInquiryCustomer, type InquiryRecord } from '../services/inquiryScan'
void MANUAL_BUCKETS
void removeManualBucket
void removeManualBuckets

// ====== 跟进模板库 ======
const TEMPLATES = [
  { id: 'check_in', name: '常规问候', subject: 'Checking in - {{product}}', body: 'Hi {{first_name}},\n\nJust wanted to check in and see how things are going with your {{product}} project.\n\nBest regards,\nEvan' },
  { id: 'quote_follow', name: '报价跟进', subject: 'Following up on our quote', body: 'Hi {{first_name}},\n\nI wanted to follow up on the quote we sent. Do you have any questions?\n\nBest regards,\nEvan' },
  { id: 'new_product', name: '新品推荐', subject: 'New products you might like', body: 'Hi {{first_name}},\n\nWe\'ve launched new designs that I think would be perfect for you.\n\nWould you like to see the catalog?\n\nBest regards,\nEvan' },
]

export default function FollowUpsPage() {
  const navigate = useNavigate()
  const [customers, setCustomers] = useState<Customer[]>([])
  const [emails, setEmails] = useState<EmailMessage[]>([])
  const [emailIndex, setEmailIndex] = useState<Map<string, string>>(new Map())
  const [list, setList] = useState<FollowUpRecord[]>([])
  const [catFilter, setCatFilter] = useState<string>('all')
  const [tagFilter, setTagFilter] = useState<string>('all')
  const allTags = useMemo(()=>{
    const m = new Map<string, number>()
    for(const c of customers) for(const t of (c.tags || [])) m.set(t, (m.get(t) || 0) + 1)
    return [...m.entries()].sort((a,b)=> b[1]-a[1])
  },[customers])
  const [page, setPage] = useState(1)
  /** 每分区各自可配每页条数，默认 10（逾期等桶人多时更干净） */
  const PER_PAGE_LS = 'evan:followupPerPage'
  const PER_PAGE_OPTIONS = [5, 10, 20, 30, 50] as const
  type PerPageKey = 'all' | ManualBucket
  const loadPerPageMap = (): Record<string, number> => {
    try { return JSON.parse(localStorage.getItem(PER_PAGE_LS) || '{}') } catch { return {} }
  }
  const [perPageMap, setPerPageMap] = useState<Record<string, number>>(() => loadPerPageMap())
  const perPage = perPageMap[catFilter as PerPageKey] ?? perPageMap.all ?? 10
  const setPerPage = (n: number) => {
    const next = { ...loadPerPageMap(), [catFilter as PerPageKey]: n }
    if (catFilter === 'all') next.all = n
    localStorage.setItem(PER_PAGE_LS, JSON.stringify(next))
    setPerPageMap(next)
    setPage(1)
  }
  const [showSendModal, setShowSendModal] = useState(false)
  const [sendTarget, setSendTarget] = useState<Customer | null>(null)
  const [sendTemplate, setSendTemplate] = useState(TEMPLATES[0])
  const [sendSubject, setSendSubject] = useState('')
  const [sendBody, setSendBody] = useState('')
  const [sending, setSending] = useState(false)
  // 批量选择 + 智能分类
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [manualMap, setManualMap] = useState<Record<string, { buckets: ManualBucket[] }>>(()=> loadManualBuckets())
  const [showManualOnly, setShowManualOnly] = useState(false)
  useEffect(()=>{
    const h = ()=> setManualMap(loadManualBuckets())
    window.addEventListener('evan-manual-buckets', h)
    return ()=> window.removeEventListener('evan-manual-buckets', h)
  },[])
  const [intellectBusy, setIntellectBusy] = useState(false)
  const [orderAlignBusy, setOrderAlignBusy] = useState(false)
  const [intellectNote, setIntellectNote] = useState('')
  const [batchSending, setBatchSending] = useState(false)
  const [batchProgress, setBatchProgress] = useState({ done: 0, total: 0, errors: 0 })
  // 批量发送弹窗
  const [showBatchModal, setShowBatchModal] = useState(false)
  const [batchTargets, setBatchTargets] = useState<Customer[]>([])
  const [batchTplId, setBatchTplId] = useState(TEMPLATES[0].id)
  const [batchSubject, setBatchSubject] = useState('')
  const [batchBody, setBatchBody] = useState('')
  const [batchAiBusy, setBatchAiBusy] = useState(false)
  const [batchResult, setBatchResult] = useState<{ok:number;errors:number;threaded?:number;subjectOnly?:number;newMail?:number}|null>(null)
  // 附件 + 会话回复
  const [custAtts, setCustAtts] = useState<any[]>([])
  const [pickedAttKeys, setPickedAttKeys] = useState<Set<string>>(new Set())
  const [threadInfo, setThreadInfo] = useState<{ found: boolean; subject: string; messageId: string }>({ found:false, subject:'', messageId:'' })
  const [threadLoading, setThreadLoading] = useState(false)
  const [useThreadReply, setUseThreadReply] = useState(true)
  const [attachMode, setAttachMode] = useState<'file'|'inline'|'both'>('file')
  const [showPreview, setShowPreview] = useState(false)
  const [batchCustAtts, setBatchCustAtts] = useState<Record<string, any[]>>({})
  const [batchAutoAtt, setBatchAutoAtt] = useState(true)
  /** 批量附件策略：require=无最新附件则跳过该客户；optional=可无附件 */
  const [batchAttPolicy, setBatchAttPolicy] = useState<'require'|'optional'>('require')
  /** 定时发送 */
  const [batchScheduleMode, setBatchScheduleMode] = useState<'now'|'at'>('now')
  const [batchScheduleAt, setBatchScheduleAt] = useState('')
  const [batchSkipped, setBatchSkipped] = useState(0)

  const attKey = (a: any) => `${a.accountId||''}|${a.uid||''}|${a.filename}`

  // ====== 自动跟进序列 ======
  const [seqTab, setSeqTab] = useState<'active'|'replied'|'dormant'>('active')
  /** 跟进档案视图 */
  const [mainView, setMainView] = useState<'radar'|'board'>('radar')
  const [boardMode, setBoardMode] = useState<'all'|FollowMode>('all')
  const [boardStage, setBoardStage] = useState<'all'|SalesStage>('all')
  const [boardReply, setBoardReply] = useState<'all'|'yes'|'no'>('all')
  const [boardBusy, setBoardBusy] = useState(false)
  const [followCfg, setFollowCfg] = useState<IntellectConfig>(()=> loadIntellectConfig())
  const [showFollowRules, setShowFollowRules] = useState(false)
  const [boardPage, setBoardPage] = useState(1)
  const [aiReplyBusy, setAiReplyBusy] = useState<string>('')
  const [copiedEmail, setCopiedEmail] = useState('')
  const [boardHideNoise, setBoardHideNoise] = useState(true)
  const [boardSelected, setBoardSelected] = useState<Set<string>>(new Set())
  const [boardBulkBusy, setBoardBulkBusy] = useState('')
  const BOARD_PER_PAGE_KEY = 'evan:followupBoardPerPage'
  const BOARD_COL_W_KEY = 'evan:followupBoardColW'
  const [boardPerPage, setBoardPerPage] = useState<number>(()=>{
    try{
      const v = Number(localStorage.getItem(BOARD_PER_PAGE_KEY))
      return [10,20,50,100].includes(v) ? v : 20
    }catch{ return 20 }
  })
  const setBoardPerPagePersist = (n: number) => {
    const v = [10,20,50,100].includes(n) ? n : 20
    try{ localStorage.setItem(BOARD_PER_PAGE_KEY, String(v)) }catch{}
    setBoardPerPage(v)
    setBoardPage(1)
  }
  const [boardSort, setBoardSort] = useState<'no_follow'|'created'|'level'|'reply'|'reply_time'|'follow_at'|'follow_count'|'step'|'name'|'stage'>('no_follow')
  const [boardSortDir, setBoardSortDir] = useState<'asc'|'desc'>('desc')
  /** 折叠筛选时隐藏多选框；可单独开「多选」 */
  const [boardSelectMode, setBoardSelectMode] = useState(false)
  const [boardQ, setBoardQ] = useState('')
  const [boardHighOnly, setBoardHighOnly] = useState(false)
  const [boardStepMin, setBoardStepMin] = useState(0)
  const [inquiries, setInquiries] = useState<InquiryRecord[]>([])
  const [boardInq, setBoardInq] = useState<'all'|'yes'|'today'|'pending'>('all')
  /** 筛选区折叠 */
  const [boardFiltersOpen, setBoardFiltersOpen] = useState(false)
  /** 列宽（px），拖拽表头边缘调整 */
  const [boardColW, setBoardColW] = useState<Record<string, number>>(()=>{
    try{
      const raw = JSON.parse(localStorage.getItem(BOARD_COL_W_KEY) || '{}')
      return raw && typeof raw === 'object' ? raw : {}
    }catch{ return {} }
  })
  const saveBoardColW = (w: Record<string, number>) => {
    setBoardColW(w)
    try{ localStorage.setItem(BOARD_COL_W_KEY, JSON.stringify(w)) }catch{}
  }
  const colW = (key: string, fallback: number) => Number(boardColW[key]) || fallback
  const startColResize = (key: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startW = colW(key, 120)
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(56, startW + (ev.clientX - startX))
      saveBoardColW({ ...boardColW, [key]: w })
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  const toggleBoardSort = (key: typeof boardSort) => {
    if(boardSort === key) setBoardSortDir(d=> d==='asc'?'desc':'asc')
    else { setBoardSort(key); setBoardSortDir(key==='name'||key==='created' ? 'asc' : 'desc') }
  }
  const SortIcon = ({ col }: { col: string }) => {
    if(boardSort !== col) return <span className="text-gray-300 text-[10px] ml-0.5">↕</span>
    return <span className="text-blue-600 text-[10px] ml-0.5">{boardSortDir==='asc'?'↑':'↓'}</span>
  }
  const [sequences, setSequences] = useState<any[]>([])
  const [seqTemplates, setSeqTemplates] = useState<any[]>([])
  const [seqIntervals, setSeqIntervals] = useState<number[]>([1,2,3,4,5,6,7])
  const [sendStart, setSendStart] = useState(8)
  const [sendEnd, setSendEnd] = useState(20)
  const [skipHolidays, setSkipHolidays] = useState(true)
  const [showTplModal, setShowTplModal] = useState(false)
  const [tplEdit, setTplEdit] = useState<any>(null)
  const loadSequences = useCallback(async () => {
    try{
      const j = await getSequences()
      const seqs = j.sequences || []
      setSequences(seqs)
      const t = await getSeqTemplates()
      const tpls = t.templates || []
      setSeqTemplates(tpls)
      const c = await getSeqConfig()
      if(c.intervals) setSeqIntervals(c.intervals)
      if(c.sendStart != null) setSendStart(c.sendStart)
      if(c.skipHolidays != null) setSkipHolidays(!!c.skipHolidays)
      if(c.sendEnd != null) setSendEnd(c.sendEnd)
      // 步号判断：优先用你保存的序列模板文案做相似度
      const r = await runFollowBoardSync({ sequences: seqs, seqTemplates: tpls })
      if(r.replies || r.modeChanged || r.stepsUpdated) setIntellectNote(r.note)
      try{
        const inq = await syncInquiriesFromMails()
        setInquiries(await listInquiries())
        if(inq.created || inq.updated) setIntellectNote(`${inq.note}${r.replies||r.modeChanged?' · '+r.note:''}`)
      }catch{ setInquiries(await listInquiries().catch(()=>[] as InquiryRecord[])) }
    }catch(e:any){
      setIntellectNote('序列/档案同步失败：'+String(e.message||e).slice(0,140))
    }
  }, [])
  const seqStats = useMemo(()=>{
    const auto = sequences.filter(s=> s.mode==='auto').length
    const replied = sequences.filter(s=> s.replied).length
    const dormant = sequences.filter(s=> s.mode==='dormant').length
    const sentSteps = sequences.reduce((n,s)=> n + (s.steps||[]).filter((t:any)=> t.status==='sent').length, 0)
    return { auto, replied, dormant, sentSteps, total: sequences.length }
  },[sequences])
  useEffect(()=>{ void loadSequences() },[loadSequences])
  const handleStartSeq = useCallback(async (c: Customer) => {
    try{
      const accs = await listAccounts()
      if(!accs.length) return alert('请先绑定邮箱账号')
      if(!confirm(`为 ${c.contactName || c.title} 启动7步自动跟进？（档案将标为「自动跟进」）`)) return
      await startSequence({ customerId: c.id, email: c.email, accountId: accs[0].id })
      await setCustomerFollowMode(c, 'auto', 'user')
      alert('自动跟进已启动')
      await loadSequences()
      window.dispatchEvent(new CustomEvent('evan-customers-updated'))
    }catch(e:any){ alert('启动失败：' + String(e.message||e).slice(0,150)) }
  }, [loadSequences])
  const handleSeqMode = useCallback(async (customerId: string, mode: string, fromStep?: number) => {
    try{
      await patchSequence(customerId, { mode, fromStep })
      const cust = (await db.customers.get(customerId)) as Customer | undefined
      if(cust){
        if(mode === 'auto') await setCustomerFollowMode(cust, 'auto', 'user')
        else if(mode === 'manual') await setCustomerFollowMode(cust, 'manual', 'user')
      }
      await loadSequences()
      window.dispatchEvent(new CustomEvent('evan-customers-updated'))
    }catch(e:any){ alert('操作失败：' + String(e.message||e).slice(0,150)) }
  }, [loadSequences])

  const load = useCallback(async () => {
    setCustomers(await db.customers.toArray() as Customer[])
    // 只建邮箱→最近往来索引，不把 1.6 万封邮件全文塞进 state
    const mails = await db.emails.toArray() as EmailMessage[]
    const byEmail = new Map<string, string>()
    for (const e of mails) {
      const raw = String(e.from || '')
      const addr = (raw.match(/<([^<>]+)>/)?.[1] || raw.match(/([^\s<>,;]+@[^\s<>,;]+)/)?.[1] || raw).toLowerCase().trim()
      if (addr && addr.includes('@')) {
        const cur = byEmail.get(addr)
        if (!cur || e.date > cur) byEmail.set(addr, e.date)
      }
    }
    setEmailIndex(byEmail)
    setEmails([])
    setList(await db.followUps.toArray() as FollowUpRecord[])
    try { setManualMap(await loadManualBucketsAsync()) } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    void load()
    let timer: any = null
    const h = () => {
      if (timer) return
      timer = setTimeout(() => { timer = null; void load() }, 800)
    }
    window.addEventListener(EVENTS.EMAILS_UPDATED, h)
    window.addEventListener(EVENTS.CUSTOMERS_UPDATED, h)
    window.addEventListener('evan-manual-buckets', h)
    return () => {
      window.removeEventListener(EVENTS.EMAILS_UPDATED, h)
      window.removeEventListener(EVENTS.CUSTOMERS_UPDATED, h)
      window.removeEventListener('evan-manual-buckets', h)
      if (timer) clearTimeout(timer)
    }
  }, [load])

  const today = new Date().toISOString().slice(0, 10)

  const followIndex = useMemo(() => {
    const todaySet = new Set<string>()
    const overdueSet = new Set<string>()
    const orderedSet = new Set<string>()
    for (const c of customers) {
      const tags = (c.tags||[]).map(String)
      // 仅认「已下单」标签 / stage=won / 复购次数；「订单」标签不再单独当成交（曾被误标污染）
      if (tags.includes('已下单') || c.stage==='won' || (c.repurchaseCount||0)>=1) {
        orderedSet.add(c.id)
      }
    }
    for (const f of list) {
      if (f.status !== 'pending') continue
      // 已下单客户的 pending 跟进不进「逾期」——业务上应走复购，而不是当线索催
      if (orderedSet.has(f.customerId)) continue
      if (f.dueAt === today) todaySet.add(f.customerId)
      if (f.dueAt < today) overdueSet.add(f.customerId)
    }
    return { todaySet, overdueSet, orderedSet }
  }, [list, today, customers])

  const daysByCustomer = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of customers) {
      const addrs = [c.email, ...(c.extraEmails || [])].filter(Boolean).map(e => String(e).toLowerCase())
      let last = c.updatedAt || ''
      for (const a of addrs) {
        const d = emailIndex.get(a)
        if (d && (!last || d > last)) last = d
      }
      m.set(c.id, last ? Math.floor((Date.now() - new Date(last).getTime()) / 86400000) : 99)
    }
    return m
  }, [customers, emailIndex])

  const stats = useMemo(() => {
    const manualCount = (b: ManualBucket) => {
      let n = 0
      for (const v of Object.values(manualMap)) if ((v.buckets || []).includes(b)) n++
      return n
    }
    let high = 0, pending = 0, repurchase = 0, marketing = 0
    for (const c of customers) {
      const t = (c as any).aiTier
      if (t === 'high') high++
      else if (t === 'pending') pending++
      else if (t === 'repurchase') repurchase++
      else if (t === 'marketing') marketing++
    }
    return {
      high: high + manualCount('high'),
      today: followIndex.todaySet.size + manualCount('today'),
      overdue: followIndex.overdueSet.size + manualCount('overdue'),
      pendingDeals: pending + manualCount('pending'),
      repurchase: repurchase + manualCount('repurchase'),
      marketing: marketing + manualCount('marketing'),
    }
  }, [customers, followIndex, manualMap])

  const catFiltered = useMemo(() => {
    const ts = (iso: string) => { const t = new Date(iso).getTime(); return Number.isFinite(t) ? t : 0 }
    const inManual = (c: Customer, b: ManualBucket) => (manualMap[c.id]?.buckets || []).includes(b)
    const tierOf = (c: Customer) => (c as any).aiTier as string | undefined
    const out: { c: Customer; days: number; stage: string }[] = []
    for (const c of customers) {
      // 噪声客户不进雷达
      if ((c.tags||[]).map(String).includes('噪声')) continue
      const stage = salesStageOf(c)
      if (stage === 'cancelled') continue
      const t = tierOf(c)
      const days = daysByCustomer.get(c.id) ?? 99
      const st = c.stage || 'lead'
      let hit = false
      if (catFilter === 'high') {
        hit = t === 'high' || inManual(c, 'high') || String((c as any).hasReply||'') === 'yes'
      }
      else if (catFilter === 'today') hit = followIndex.todaySet.has(c.id) || inManual(c, 'today')
      else if (catFilter === 'overdue') {
        // 逾期 = 未下单且跟进过期；已下单仅在手动勾选「逾期」时出现
        const ordered = followIndex.orderedSet.has(c.id)
        hit = (!ordered && followIndex.overdueSet.has(c.id)) || inManual(c, 'overdue')
      }
      else if (catFilter === 'pending') hit = t === 'pending' || inManual(c, 'pending')
      else if (catFilter === 'repurchase') {
        hit = t === 'repurchase' || inManual(c, 'repurchase')
          || (followIndex.orderedSet.has(c.id) && days >= 30)
      }
      else if (catFilter === 'marketing') hit = t === 'marketing' || inManual(c, 'marketing')
      else hit = true
      if (!hit) continue
      if (showManualOnly && !(manualMap[c.id]?.buckets || []).length) continue
      if (tagFilter !== 'all' && !(c.tags || []).includes(tagFilter)) continue
      out.push({ c, days, stage: st })
    }
    out.sort((x, y) => ts(y.c.updatedAt || '') - ts(x.c.updatedAt || ''))
    return out
  }, [customers, daysByCustomer, followIndex, catFilter, tagFilter, manualMap, showManualOnly])

  // 序列速览：按客户 id 索引 + 今日待发
  const seqMap = useMemo(()=>{
    const m = new Map<string, any>()
    for(const s of sequences) m.set(s.customer_id, s)
    return m
  },[sequences])
  const seqDueToday = useMemo(()=>{
    const t = new Date().toISOString().slice(0,10)
    return sequences.filter(s=> s.mode==='auto' && String(s.next_due_at||'').slice(0,10) <= t)
  },[sequences])

  const totalPages = Math.max(1, Math.ceil(catFiltered.length / perPage))
  const safePage = Math.min(page, totalPages)
  const pageData = catFiltered.slice((safePage - 1) * perPage, safePage * perPage)

  // ====== 打开发送弹窗 ======
  const openSendModal = useCallback(async (c: Customer) => {
    setSendTarget(c)
    const product = c.portrait?.products?.[0] || 'Challenge Coin'
    const tpl = TEMPLATES[0]
    setSendTemplate(tpl)
    setSendSubject(tpl.subject.replace(/\{\{product\}\}/g, product))
    setSendBody(tpl.body.replace(/\{\{first_name\}\}/g, (c.contactName || c.title || 'there').split(' ')[0]).replace(/\{\{product\}\}/g, product))
    setShowSendModal(true)
    setAttachMode('file')
    try{
      const atts = await fetchCustomerAttachments(c.email||'', 8)
      setCustAtts(atts)
      // 用唯一 key 勾选，避免同名附件被一起选中
      const keyOf = (a:any) => `${a.accountId||''}|${a.uid||''}|${a.filename}`
      setPickedAttKeys(atts[0] ? new Set([keyOf(atts[0])]) : new Set())
    }catch{ setCustAtts([]); setPickedAttKeys(new Set()) }
    try{
      setThreadLoading(true)
      const th = await findLatestThreadHeaders(c.email||'')
      setThreadInfo({ found: th.found, subject: th.subject, messageId: th.messageId })
      if(th.found){
        setUseThreadReply(true)
        setSendSubject(normalizeReplySubject(th.subject))
      }else{
        setUseThreadReply(false)
      }
    }catch{ setThreadInfo({ found:false, subject:'', messageId:'' }); setUseThreadReply(false) }
    finally{ setThreadLoading(false) }
  }, [])

  const pickedAttList = useCallback(()=>{
    return custAtts.filter(a=> pickedAttKeys.has(attKey(a))).map(a=>({
      filename: a.filename,
      path: a.path,
      contentType: a.mime,
    }))
  },[custAtts, pickedAttKeys])

  /** 按发送方式组装 HTML（附件作为文件 vs 图片插入正文） */
  const buildHtmlBody = useCallback((body: string)=>{
    const picked = custAtts.filter(a=> pickedAttKeys.has(attKey(a)))
    const isImg = (a:any)=> String(a.mime||'').toLowerCase().startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(a.filename||'')
    const imgs = picked.filter(isImg)
    let html = textToHtml(body)
    if(attachMode !== 'file' && imgs.length){
      html += imgs.map(a=> a.url
        ? `<p style="margin:8px 0"><img src="${a.url}" alt="${a.filename}" style="max-width:320px;border-radius:6px"/></p>`
        : `<p style="margin:8px 0;color:#888">[附件图: ${a.filename}]</p>`).join('')
    }
    return html
  },[custAtts, pickedAttKeys, attachMode])

  const previewSubject = threadInfo.found && useThreadReply
    ? normalizeReplySubject(sendSubject || threadInfo.subject)
    : sendSubject
  const previewAttachments = pickedAttList()

  // ====== AI 一键生成跟进草稿 ======
  const [aiDrafting, setAiDrafting] = useState(false)
  const handleAiDraft = useCallback(async () => {
    if (!sendTarget || aiDrafting) return
    setAiDrafting(true)
    try {
      const c = sendTarget
      const product = c.portrait?.products?.[0] || 'Challenge Coin'
      const prompt = `你是Maxemblem的外贸业务员Evan，给客户写一封英文跟进邮件。只返回邮件正文，不要解释。\n客户：${c.contactName || c.title}（${c.email}，${c.company || '公司未知'}）\n等级：${c.level || 'C'}${c.isKey ? '（重点客户）' : ''}，阶段：${c.stage || 'lead'}，复购${c.repurchaseCount || 0}次\n产品：${product}\n客户画像：${c.aiSummary || '无'}\n要求：简短亲切，提一下产品，结尾问一句是否需要报价或样品，落款Evan。`
      const draft = await chatOnce(prompt)
      if (draft && !draft.startsWith('⚠️')) {
        setSendBody(draft.trim())
        const subj = await chatOnce(`给下面这封跟进邮件起一个英文主题行，只返回主题本身：\n${draft.slice(0, 500)}`)
        if (subj && !subj.startsWith('⚠️')) setSendSubject(subj.trim().replace(/^["']|["']$/g, ''))
      } else {
        alert(draft || 'AI 生成失败，请检查 AI 设置')
      }
    } catch (e: any) {
      alert('AI 生成失败：' + String(e.message || e).slice(0, 150))
    } finally { setAiDrafting(false) }
  }, [sendTarget, aiDrafting])

  // ====== 真实发送 ======
  const handleSend = useCallback(async () => {
    if (!sendTarget || !sendBody.trim()) return
    setSending(true)
    try {
      const accounts = await listAccounts()
      const acc = accounts[0]
      if (!acc) { alert('无可用邮箱账号'); return }
      const html = buildHtmlBody(sendBody)
      const atts = pickedAttList()
      const subject = useThreadReply && threadInfo.found && threadInfo.subject
        ? normalizeReplySubject(threadInfo.subject) // 有往来：必须用历史主题挂线程，不用模板主题
        : sendSubject
      const mid = useThreadReply && threadInfo.found && threadInfo.messageId ? threadInfo.messageId : undefined
      const result = await sendEmail(
        acc.id,
        sendTarget.email || '',
        subject,
        sendBody,
        html,
        mid,
        mid,
        attachMode === 'inline' ? [] : atts
      )
      if (result.ok) {
        const { uid } = await import('../repositories/result')
        await db.emails.put({
          id: uid(), accountId: acc.id, folder: 'sent',
          from: acc.email, to: sendTarget.email || '', subject,
          text: sendBody, html, date: new Date().toISOString(),
          isRead: true, hasAttachment: atts.length>0,
          customerId: sendTarget.id,
        } as any)
        const fu = list.find(f => f.customerId === sendTarget.id && f.status === 'pending')
        if (fu) await db.followUps.update(fu.id, { status: 'sent' } as any)
        const { advanceStage } = await import('../services/customerFactory')
        const newStage = advanceStage(sendTarget.stage || 'lead', '报价回复')
        await db.customers.update(sendTarget.id, {
          stage: newStage,
          updatedAt: new Date().toISOString(),
          lastContactAt: new Date().toISOString(),
        } as any)
        emitEvent(EVENTS.CUSTOMERS_UPDATED, { id: sendTarget.id, action: 'followed_up' })
        alert(mid ? '已在最新会话中回复发出（含 In-Reply-To）' : (useThreadReply && threadInfo.found && threadInfo.subject ? '已按历史主题发出（库中暂无 Message-ID，可能不入线程）' : '邮件已发送！'))
        setShowSendModal(false)
        await load()
      }
    } catch (e: any) {
      alert('发送失败：' + String(e.message || e).slice(0, 200))
    } finally { setSending(false) }
  }, [sendTarget, sendSubject, sendBody, list, load, useThreadReply, threadInfo, pickedAttList, buildHtmlBody, attachMode])

  // ====== 一键生成跟进并发送 ======
  const handleQuickFollow = useCallback(async (c: Customer) => {
    openSendModal(c)
  }, [openSendModal])

  // ====== 标记完成 ======
  const handleComplete = useCallback(async (fu: FollowUpRecord) => {
    await db.followUps.update(fu.id, { status: 'completed' } as any)
    emitEvent(EVENTS.CUSTOMERS_UPDATED, { id: fu.customerId, action: 'followup_completed' })
    await load()
  }, [load])

  // ====== 智能分类 L1 ======
  const handleIntellect = useCallback(async () => {
    setIntellectBusy(true)
    setIntellectNote('')
    try{
      const autoSeqIds = new Set(sequences.filter(s=> s.mode==='auto').map(s=> s.customer_id))
      const pendFu = new Set(list.filter(f=> f.status==='pending').map(f=> f.customerId))
      const results = await runIntellectBatch(customers, emails, { autoSeqCustomerIds: autoSeqIds, pendingFuCustomerIds: pendFu })
      const c = { high:0, marketing:0, repurchase:0, pending:0, follow:0, dormant:0 }
      for(const r of results) (c as any)[r.tier] = ((c as any)[r.tier]||0)+1
      setIntellectNote(`智能分类完成：高意向 ${c.high} · 待成交 ${c.pending} · 复购 ${c.repurchase} · 营销 ${c.marketing} · 跟进 ${c.follow} · 沉寂 ${c.dormant}`)
      setCustomers(await db.customers.toArray() as Customer[])
      window.dispatchEvent(new CustomEvent('evan-customers-updated'))
    }catch(e:any){ setIntellectNote('分类失败：'+String(e?.message||e).slice(0,100)) }
    finally{ setIntellectBusy(false) }
  }, [customers, emails, sequences, list])

  // 默认排重（静默）
  useEffect(()=>{
    let cancelled = false
    ;(async()=>{
      try{
        const all = await db.customers.toArray() as Customer[]
        if(all.length < 2) return
        // 仅当存在同邮箱重复时才跑，避免每次空转
        const emailsSeen = new Map<string, number>()
        for(const c of all){
          const ms = [c.email, ...(c.extraEmails||[])].filter(Boolean).map((e:string)=> String(e).toLowerCase())
          for(const m of ms) emailsSeen.set(m, (emailsSeen.get(m)||0)+1)
        }
        const hasDup = [...emailsSeen.values()].some(n=> n>1)
        if(!hasDup || cancelled) return
        // 复用 CustomersPage 同类逻辑的轻量版：交给客户页排重太重，这里只打日志
        // 实际排重在 CustomersPage handleDedupe；此处触发全局事件请求客户页静默排重过重，改为直接跑精简排重
        const groups = new Map<string, Customer[]>()
        for(const c of all){
          const ms = new Set<string>()
          if(c.email) ms.add(c.email.toLowerCase())
          for(const e of (c.extraEmails||[])) ms.add(String(e).toLowerCase())
          for(const m of ms){ if(!groups.has(m)) groups.set(m, []); if(!groups.get(m)!.some(x=>x.id===c.id)) groups.get(m)!.push(c) }
        }
        const gone = new Set<string>()
        let removed = 0
        for(const [, arr] of groups){
          const alive = arr.filter(x=> !gone.has(x.id))
          if(alive.length<2) continue
          alive.sort((a,b)=> String(b.updatedAt||'') < String(a.updatedAt||'') ? -1 : 1)
          const keeper = alive[0]
          const patch:any = {
            extraEmails: [...new Set([...(keeper.extraEmails||[]), ...alive.slice(1).flatMap(x=>[x.email,...(x.extraEmails||[])].filter(Boolean).map((e:string)=>e.toLowerCase()))].filter(e=> e!==(keeper.email||'').toLowerCase()))],
            tags: [...new Set([...(keeper.tags||[]), ...alive.slice(1).flatMap(x=>x.tags||[])])],
            updatedAt: new Date().toISOString(),
          }
          for(const d of alive.slice(1)){
            if((d.repurchaseCount||0)>(keeper.repurchaseCount||0)) patch.repurchaseCount = d.repurchaseCount
            if(d.isKey) patch.isKey = true
            if(!keeper.company && d.company) patch.company = d.company
          }
          await db.customers.update(keeper.id, patch)
          for(const d of alive.slice(1)){
            await db.followUps.where('customerId').equals(d.id).modify({ customerId: keeper.id } as any).catch(()=>{})
            await db.customers.delete(d.id)
            gone.add(d.id); removed++
          }
        }
        if(removed>0 && !cancelled){
          setCustomers(await db.customers.toArray() as Customer[])
          window.dispatchEvent(new CustomEvent('evan-customers-updated'))
        }
      }catch{}
    })()
    return ()=>{ cancelled = true }
  }, [])

  // ====== 多选 ======
  const toggleSel = (id: string) => setSelectedIds(s => { const n = new Set(s); if(n.has(id)) n.delete(id); else n.add(id); return n })
    const toggleAllPage = () => {
    const ids = pageData.map(x=> x.c.id)
    const allOn = ids.length>0 && ids.every(id=> selectedIds.has(id))
    setSelectedIds(prev=>{
      const n = new Set(prev)
      if(allOn){ for(const id of ids) n.delete(id) }
      else { for(const id of ids) n.add(id) }
      return n
    })
  }
  /** 跨页全选：选中当前筛选结果中的全部客户 */
  const selectAllFiltered = () => {
    setSelectedIds(new Set(catFiltered.map(x=> x.c.id)))
  }

  // ====== 批量发跟进：先弹窗看名单+模板，再入队 ======
  const applyBatchTpl = useCallback((tplId: string, sample?: Customer) => {
    const tpl = TEMPLATES.find(t=> t.id===tplId) || TEMPLATES[0]
    const c = sample || batchTargets[0]
    const product = ((c?.portrait as any)?.products?.[0]) || 'Challenge Coin'
    const name = (c?.contactName || c?.title || 'there').split(' ')[0]
    setBatchTplId(tpl.id)
    setBatchSubject(tpl.subject.replace(/\{\{product\}\}/g, product))
    setBatchBody(tpl.body.replace(/\{\{first_name\}\}/g, name).replace(/\{\{product\}\}/g, product))
  }, [batchTargets])

  const openBatchModal = useCallback(async () => {
    const targets = catFiltered.filter(x=> selectedIds.has(x.c.id) && x.c.email).map(x=> x.c)
    if(!targets.length) return alert('请先勾选有邮箱的客户')
    setBatchTargets(targets)
    setBatchResult(null)
    applyBatchTpl(TEMPLATES[0].id, targets[0])
    setShowBatchModal(true)
    // 预加载各客户附件（最多每人 2 个）
    const attMap: Record<string, any[]> = {}
    await Promise.all(targets.slice(0, 40).map(async (c)=>{
      try{
        const list = await fetchCustomerAttachments(c.email||'', 4)
        attMap[c.id] = list
      }catch{ attMap[c.id] = [] }
    }))
    setBatchCustAtts(attMap)
  }, [catFiltered, selectedIds, applyBatchTpl])

const handleBatchAiTpl = useCallback(async () => {
    if(!batchTargets.length) return
    setBatchAiBusy(true)
    try{
      const c = batchTargets[0]
      const product = ((c.portrait as any)?.products?.[0]) || 'Challenge Coin'
      const prompt = `你是Maxemblem外贸业务员Evan。写一封简短英文跟进邮件主题+正文，适合群发给类似客户。只返回两行：第一行Subject:，第二行Body:。\n客户示例：${c.contactName||c.title}（${product}），阶段${c.stage||'lead'}。\n语气友好，问是否需要报价或样品，落款Evan。`
      const out = await chatOnce(prompt)
      const sIdx = out.indexOf('Subject:')
      const bIdx = out.indexOf('Body:')
      if(sIdx>=0 && bIdx>sIdx){
        setBatchSubject(out.slice(sIdx+8, bIdx).trim())
        setBatchBody(out.slice(bIdx+5).trim())
      }else{
        setBatchBody(out.trim())
      }
    }catch(e:any){ alert('AI 生成失败：'+String(e.message||e).slice(0,120)) }
    finally{ setBatchAiBusy(false) }
  }, [batchTargets])

  const handleBatchSend = useCallback(async () => {
    if(!batchTargets.length) return
    const used = getTodaySendCount()
    if(used >= BATCH_SEND.dailyLimit) return alert('今日批量已达上限 '+BATCH_SEND.dailyLimit+' 封，请明天再发')
    const remain = BATCH_SEND.dailyLimit - used
    if(batchTargets.length > remain && !confirm('今日剩余额度 '+remain+'，仅入队前 '+remain+' 封，继续？')) return
    const list2 = batchTargets.slice(0, remain)
    const accs = await listAccounts()
    if(!accs.length) return alert('请先绑定邮箱账号')
    const acc = accs[0]
    if(!batchSubject.trim() || !batchBody.trim()) return alert('请填写主题和正文')
    let sendAt: string | null = null
    if(batchScheduleMode === 'at'){
      if(!batchScheduleAt) return alert('请选择定时发送时间')
      const t = new Date(batchScheduleAt)
      if(!Number.isFinite(t.getTime())) return alert('定时时间无效')
      if(t.getTime() < Date.now() + 30000) return alert('定时时间需在约 1 分钟之后')
      sendAt = t.toISOString()
    }
    setBatchSending(true)
    setBatchResult(null)
    setBatchSkipped(0)
    setBatchProgress({ done: 0, total: list2.length, errors: 0 })
    let errors = 0
    let skipped = 0
    let threaded = 0
    let subjectOnly = 0
    let newMail = 0
    for(let i=0;i<list2.length;i++){
      const c = list2[i]
      const product = ((c.portrait as any)?.products?.[0]) || 'Challenge Coin'
      const name = (c.contactName || c.title || 'there').split(' ')[0]
      const subject = batchSubject.replace(/\{\{product\}\}/g, product).replace(/\{\{first_name\}\}/g, name)
      const body = batchBody.replace(/\{\{product\}\}/g, product).replace(/\{\{first_name\}\}/g, name)
      try{
        const custList = batchCustAtts[c.id] || []
        const latestAtt = custList[0] || null
        if(batchAutoAtt && batchAttPolicy === 'require' && !latestAtt){
          skipped++
          setBatchProgress({ done: i+1, total: list2.length, errors })
          if(i < list2.length-1) await new Promise(r=> setTimeout(r, 200))
          continue
        }
        // 有往来：必须挂到最新会话（历史主题 + In-Reply-To）；无往来才用模板新发
        const th = await findLatestThreadHeaders(c.email||'').catch(()=>({ found:false, subject:'', messageId:'', references:'', hasMessageId:false } as any))
        const hasHistory = !!(th.found && (th.subject || th.messageId))
        const mid = hasHistory && th.messageId ? th.messageId : undefined
        let subj: string
        if(hasHistory && th.subject){
          subj = normalizeReplySubject(th.subject) // Re: 历史主题，禁止 Re: 模板主题
        } else if(hasHistory && th.messageId){
          subj = normalizeReplySubject(subject) // 仅有 Message-ID 时用模板主题 + Re:
        } else {
          subj = subject
        }
        if(hasHistory && mid) threaded++
        else if(hasHistory) subjectOnly++
        else newMail++
        const isImg = !!latestAtt && (String(latestAtt.mime||'').toLowerCase().startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(latestAtt.filename||''))
        let html = textToHtml(body)
        const atts: any[] = []
        if(batchAutoAtt && latestAtt){
          const cid = 'att0'
          atts.push({ filename: latestAtt.filename, path: latestAtt.path, contentType: latestAtt.mime, ...(isImg ? { cid } : {}) })
          if(isImg){
            html += '<p style="margin:8px 0"><img src="cid:'+cid+'" alt="'+latestAtt.filename+'" style="max-width:360px;border-radius:6px"/></p>'
          }
        }
        await enqueueMail(acc.id, c.email || '', subj, body, 'batch-'+c.id+'-'+Date.now(), false, {
          html,
          sendAt,
          inReplyTo: mid,
          references: mid ? (th.references || mid) : undefined,
          attachments: atts.length ? atts : undefined,
        })
        bumpTodaySendCount(1)
        await db.followUps.put({
          id: 'fu-batch-'+Date.now()+'-'+c.id,
          customerId: c.id,
          dueAt: new Date().toISOString().slice(0,10),
          channel: ['批量跟进'],
          note: (sendAt ? '定时'+new Date(sendAt).toLocaleString()+'：' : '批量入队：')
            + (mid ? '会话回复' : hasHistory ? '历史主题(无MID)' : '新邮件') + ' ' + subj.slice(0,36),
          status: 'pending',
          createdAt: new Date().toISOString(),
        } as any)
      }catch{ errors++ }
      setBatchProgress({ done: i+1, total: list2.length, errors })
      if(i < list2.length-1) await new Promise(r=> setTimeout(r, BATCH_SEND.intervalMs))
    }
    setBatchSending(false)
    setSelectedIds(new Set())
    setBatchSkipped(skipped)
    setBatchResult({ ok: list2.length-errors-skipped, errors, threaded, subjectOnly, newMail })
    await load()
  }, [batchTargets, batchSubject, batchBody, load, batchAutoAtt, batchAttPolicy, batchScheduleMode, batchScheduleAt, batchCustAtts])

  const TIER_BADGE: Record<string, {label:string; cls:string}> = {
    high: { label:'高意向', cls:'bg-red-50 text-red-600' },
    pending: { label:'待成交', cls:'bg-green-50 text-green-700' },
    repurchase: { label:'复购', cls:'bg-purple-50 text-purple-600' },
    marketing: { label:'营销', cls:'bg-pink-50 text-pink-600' },
    follow: { label:'跟进', cls:'bg-blue-50 text-blue-600' },
    dormant: { label:'沉寂', cls:'bg-gray-100 text-gray-500' },
    active: { label:'活跃', cls:'bg-teal-50 text-teal-700' },
  }

  const cats = [
    { key: 'high', label: '高意向客户', icon: Flame, count: stats.high, color: 'text-red-500', bg: 'bg-red-50' },
    { key: 'today', label: '今日跟进', icon: Clock, count: stats.today, color: 'text-blue-500', bg: 'bg-blue-50' },
    { key: 'overdue', label: '逾期跟进', icon: AlertTriangle, count: stats.overdue, color: 'text-orange-500', bg: 'bg-orange-50' },
    { key: 'pending', label: '待成交机会', icon: DollarSign, count: stats.pendingDeals, color: 'text-green-600', bg: 'bg-green-50' },
    { key: 'repurchase', label: '潜在复购', icon: Repeat, count: stats.repurchase, color: 'text-purple-500', bg: 'bg-purple-50' },
    { key: 'marketing', label: '营销机会', icon: Megaphone, count: stats.marketing, color: 'text-pink-500', bg: 'bg-pink-50' },
  ]

  return (
    <div className={`${mainView==='board' ? 'w-full max-w-none' : 'max-w-7xl mx-auto'} p-0 space-y-4`}>
      <h1 className="text-xl font-bold flex items-center gap-2"><Calendar size={20} /> 跟进 · 客户跟进雷达</h1>
      <div className="flex items-center gap-2 flex-wrap -mt-1">
        <button onClick={()=> setMainView('radar')} className={`px-3 py-1 rounded-full text-xs ${mainView==='radar'?'bg-blue-600 text-white':'bg-white border'}`}>雷达六桶</button>
        <button onClick={()=> setMainView('board')} className={`px-3 py-1 rounded-full text-xs ${mainView==='board'?'bg-blue-600 text-white':'bg-white border'}`}>📋 跟进表</button>
        <button
          onClick={async()=>{
            setBoardBusy(true)
            try{
              const seqs = (await getSequences()).sequences || []
              setSequences(seqs)
              const r = await runFollowBoardSync({ sequences: seqs, seqTemplates, forceStepScan: true })
              const inq = await syncInquiriesFromMails()
              setInquiries(await listInquiries())
              setIntellectNote(`${r.note}｜${inq.note}`)
              setIntellectNote(r.note)
              await load()
            }catch(e:any){ setIntellectNote('档案同步失败：'+String(e.message||e).slice(0,100)) }
            finally{ setBoardBusy(false) }
          }}
          disabled={boardBusy}
          className="px-2 py-1 rounded-full text-xs bg-white border disabled:opacity-50"
          title="扫描邮件回复、同步跟进方式/步骤/销售阶段，并联动自动序列"
        >{boardBusy?'同步中…':'🔄 同步跟进档案'}</button>
        <button onClick={()=> setShowFollowRules(v=>!v)} className="px-2 py-1 rounded-full text-xs bg-white border">⚙️ 跟进规则</button>
      </div>
      {showFollowRules && (
        <div className="bg-white border rounded-2xl p-3 text-xs space-y-2">
          <div className="font-semibold text-sm">⚙️ 跟进规则（系统自动判断）</div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            <label className="flex items-center gap-1"><input type="checkbox" checked={followCfg.followReplyToManual} onChange={e=>{ const n={...followCfg, followReplyToManual:e.target.checked}; setFollowCfg(n); saveIntellectConfig({ followReplyToManual:e.target.checked }) }}/> 有回复→改手动跟进</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={followCfg.followReplyToHigh} onChange={e=>{ setFollowCfg({...followCfg, followReplyToHigh:e.target.checked}); saveIntellectConfig({ followReplyToHigh:e.target.checked }) }}/> 有回复→进高意向</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={followCfg.followStopSeqOnOrder} onChange={e=>{ setFollowCfg({...followCfg, followStopSeqOnOrder:e.target.checked}); saveIntellectConfig({ followStopSeqOnOrder:e.target.checked }) }}/> 已下单→停自动序列</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={followCfg.followStopSeqOnCancel} onChange={e=>{ setFollowCfg({...followCfg, followStopSeqOnCancel:e.target.checked}); saveIntellectConfig({ followStopSeqOnCancel:e.target.checked }) }}/> 取消→停自动序列</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={followCfg.followAutoEnrollNoReply} onChange={e=>{ setFollowCfg({...followCfg, followAutoEnrollNoReply:e.target.checked}); saveIntellectConfig({ followAutoEnrollNoReply:e.target.checked }) }}/> 无回复自动拉入序列</label>
            <label className="flex items-center gap-1">模板相似度阈值
              <input type="number" min={0.2} max={0.95} step={0.05} value={followCfg.followSimThreshold||0.6} onChange={e=>{ const v=Number(e.target.value)||0.6; setFollowCfg({...followCfg, followSimThreshold:v}); saveIntellectConfig({ followSimThreshold:v }) }} className="w-14 border rounded px-1"/>
            </label>
          </div>
          <div className="text-[11px] text-gray-400">跟进步号：自动序列按已发出步骤；手动邮件按「模板+间隔」里的序列文案关键词相似度判断（跟进1–7）。标记「自动跟进」才会进自动序列。</div>
          <div className="flex flex-wrap items-center gap-2 pt-1 border-t">
            <button
              onClick={async()=>{
                const p = await probeSeqServer()
                setIntellectNote(p.ok ? `连接正常：${p.url} · ${p.detail}` : `连接失败：${p.url} · ${p.detail}`)
                alert(p.ok
                  ? `✅ 同步服务器可访问\n${p.url}\n${p.detail}\n若保存模板仍失败，请到「云同步」重新登录。`
                  : `❌ 无法访问同步服务器\n地址：${p.url}\n${p.detail}\n\n请检查：\n1) 本机 server.mjs 是否在跑\n2) 云同步地址是否为 https://win-8c09k6b093h.tail73fe40.ts.net\n3) 浏览器能否直接打开该地址\n4) 云同步退出后重新登录`)
              }}
              className="px-3 py-1 bg-blue-600 text-white rounded-lg"
            >🔌 测试同步连接</button>
            <span className="text-[10px] text-gray-400">Failed to fetch 多为浏览器访问隧道失败或地址/登录无效，与模板内容无关。</span>
          </div>
        </div>
      )}
      {mainView==='radar' && (
      <>
      {catFilter !== 'all' && (
        <div className="text-xs text-gray-500 -mt-2">当前筛选：<b className="text-blue-600">{{high:'高意向客户',today:'今日跟进',overdue:'逾期跟进',pending:'待成交机会',repurchase:'潜在复购',marketing:'营销机会'}[catFilter]}</b>
          <button onClick={()=> setCatFilter('all')} className="ml-2 text-gray-400 hover:text-gray-600">✕ 清除</button>
        </div>
      )}

      {/* 6分类：点击进入分区；卡片上显示该分区每页条数 */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
        {cats.map(c => {
          const npp = perPageMap[c.key] ?? perPageMap.all ?? 10
          return (
          <button key={c.key} onClick={() => { setCatFilter(c.key); setPage(1) }} className={`p-3 rounded-2xl border text-left transition-all ${catFilter === c.key ? 'ring-2 ring-blue-300 border-blue-300' : 'border-gray-100 bg-white hover:border-gray-200'}`}>
            <div className={`w-7 h-7 rounded-full flex items-center justify-center ${c.bg} ${c.color} mb-1`}><c.icon size={14} /></div>
            <div className="text-xs text-gray-500">{c.label}</div>
            <div className={`text-lg font-bold ${c.color}`}>{c.count}</div>
            <div className="text-[10px] text-gray-300 mt-0.5">每页 {npp} 条</div>
          </button>
          )
        })}
      </div>

      {/* 雷达 */}
      <div className="bg-white rounded-2xl border p-4">
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <div className="w-7 h-7 bg-red-100 rounded-lg flex items-center justify-center">🔥</div>
          <div>
            <div className="text-sm font-bold">客户跟进雷达</div>
            <div className="text-xs text-gray-400">未成交客户沉寂预警 · 已下单客户不进逾期（走复购）· 每页可配</div>
          </div>
          <select value={tagFilter} onChange={e=> { setTagFilter(e.target.value); setPage(1) }} className="ml-auto px-2 py-1 border rounded text-xs">
            <option value="all">全部标签</option>
            {allTags.map(([t,n])=> <option key={t} value={t}>{t} ({n})</option>)}
          </select>
          <button onClick={()=> void handleIntellect()} disabled={intellectBusy} className="text-xs px-2 py-1 bg-purple-600 text-white rounded-lg disabled:opacity-50" title="规则引擎：高意向/待成交/复购/营销等">
            {intellectBusy ? '分类中…' : '🧠 智能分类'}
          </button>
          <button
            onClick={async()=>{
              if(!confirm('将已下单/阶段won/有订单记录的客户补上「已下单」标签，并关闭其逾期 pending 跟进？')) return
              setOrderAlignBusy(true)
              try{
                const { syncOrderedCustomersFollowUps, runOrderScan } = await import('../services/orderScan')
                const os = await runOrderScan({ rescanAll: true })
                const r = await syncOrderedCustomersFollowUps({ purge: true })
                setIntellectNote(`订单对齐：先清除误标 ${r.purged} · 严格重扫补单+${os.ordersAdded} · 真实已下单 ${r.ordered} · 新打标 ${r.newlyTagged} · 关闭跟进 ${r.followUpsClosed}`)
                await load()
              }catch(e:any){ setIntellectNote('订单对齐失败：'+String(e.message||e).slice(0,120)) }
              finally{ setOrderAlignBusy(false) }
            }}
            disabled={orderAlignBusy || intellectBusy}
            className="text-xs px-2 py-1 bg-orange-600 text-white rounded-lg disabled:opacity-50"
            title="全量扫邮件订单 + 补「已下单」标签 + 关闭已成交客户的逾期跟进"
          >{orderAlignBusy ? '对齐中…' : '🧾 订单对齐'}</button>
          <button onClick={()=> setShowManualOnly(v=>!v)} className={`text-xs px-2 py-1 border rounded ${showManualOnly?'bg-indigo-600 text-white border-indigo-600':'bg-white'}`}>仅手动板块</button>
          <button onClick={() => load()} className="text-xs px-2 py-1 bg-white border rounded">↻ 刷新</button>
        </div>
        {intellectNote && <div className="mb-2 text-[11px] px-2 py-1.5 bg-purple-50 text-purple-700 rounded-lg">{intellectNote}</div>}
        <div className="flex items-center gap-2 mb-2 text-xs">
          <label className="flex items-center gap-1 cursor-pointer">
            <input type="checkbox" checked={pageData.length>0 && pageData.every(x=> selectedIds.has(x.c.id))} onChange={toggleAllPage}/>
            全选本页
          </label>
          <button
            onClick={selectAllFiltered}
            className="text-[11px] px-2 py-1 border rounded-lg hover:bg-blue-50 text-blue-600"
            title="选中当前筛选结果中的全部客户（跨页，翻页不丢）"
          >全选筛选 {catFiltered.length}</button>
          <span className="text-gray-400">已选 {selectedIds.size}</span>
          {selectedIds.size>0 && (
            <div className="flex items-center gap-1 ml-2">
              <button onClick={()=> void openBatchModal()} disabled={batchSending}
                className="px-3 py-1 bg-pink-600 text-white rounded-lg disabled:opacity-50"
                title={`间隔 5s/封 · 今日配额 ${getTodaySendCount()}/${BATCH_SEND.dailyLimit}`}>
                {batchSending ? `批量发送 ${batchProgress.done}/${batchProgress.total}` : `📣 批量发跟进（${selectedIds.size}）`}
              </button>
              <button onClick={()=> void Promise.all([...selectedIds].map(id=> handleStartSeq(customers.find(c=>c.id===id)!).catch(()=>{})))} className="px-2 py-1 border rounded-lg text-purple-600">批量序列</button>
              <button onClick={()=> setSelectedIds(new Set())} className="px-2 py-1 text-gray-400">清空</button>
            </div>
          )}
          <span className="ml-auto text-[10px] text-gray-400">今日配额 {getTodaySendCount()}/{BATCH_SEND.dailyLimit}</span>
        </div>

        <div className="space-y-2">
          {seqDueToday.length > 0 && (
            <div className="px-3 py-2 bg-purple-50 border border-purple-100 rounded-xl text-xs text-purple-700">
              🔁 今日序列待发 {seqDueToday.length} 个：{seqDueToday.slice(0,5).map(s=> s.customer?.title || s.email).join('、')}{seqDueToday.length>5?'…':''}（半小时调度自动发出）
            </div>
          )}
          {pageData.map(({ c, days, stage }) => (
            <div key={c.id} className="flex items-center gap-3 p-3 bg-white border rounded-xl hover:border-blue-200 transition-all">
              <input type="checkbox" checked={selectedIds.has(c.id)} onChange={()=> toggleSel(c.id)} className="shrink-0"/>
              <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-400 to-purple-500 text-white flex items-center justify-center font-bold text-sm shrink-0">{(c.contactName || c.title || 'J')[0].toUpperCase()}</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-sm font-semibold truncate">{c.contactName || c.title}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${c.isKey ? 'bg-yellow-100 text-yellow-700' : 'bg-gray-100 text-gray-500'}`}>{c.level || 'C'}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-600">{STAGE_LABELS[stage] || stage}</span>
                  {(c as any).aiTier && (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${TIER_BADGE[(c as any).aiTier]?.cls || 'bg-gray-100'}`} title={(c as any).aiReason || ''}>
                      {TIER_BADGE[(c as any).aiTier]?.label || (c as any).aiTier}
                    </span>
                  )}
                  {(manualMap[c.id]?.buckets||[]).map(b=>{
                    const lb = MANUAL_BUCKETS.find(x=>x.key===b)?.label || b
                    return (
                      <span key={b} className="text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 inline-flex items-center gap-1">
                        手动·{lb}
                        <button type="button" title="移出该板块" className="text-indigo-400 hover:text-rose-600"
                          onClick={(e)=>{ e.stopPropagation(); removeManualBucket(c.id, b); setManualMap(loadManualBuckets()) }}>×</button>
                      </span>
                    )
                  })}
                  {days >= 7
                    ? <span className="text-[10px] text-red-500">沉寂{days}天</span>
                    : <span className="text-[10px] text-gray-400">近{days}天有动态</span>}
                  {seqMap.get(c.id)?.mode==='auto' && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-50 text-purple-600">🔁序列{Math.min(seqMap.get(c.id).current_step,7)}/7</span>}
                  {seqMap.get(c.id)?.replied ? <span className="text-[10px] text-red-500">🔔有回复</span> : null}
                </div>
                <div className="text-xs text-gray-400 truncate">{c.email} · {c.company || ''}
                  {(c.tags||[]).slice(0,3).map(t=> <span key={t} className="ml-1 px-1 rounded bg-teal-50 text-teal-600 text-[10px]">{t}</span>)}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={() => handleQuickFollow(c)} className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs flex items-center gap-1 hover:bg-blue-700">
                  <Send size={11} /> 跟进
                </button>
                <button onClick={() => handleStartSeq(c)} title="启动7步自动跟进序列" className="px-2 py-1.5 bg-purple-50 text-purple-600 border border-purple-200 rounded-lg text-xs hover:bg-purple-100">
                  🔁序列
                </button>
                {list.some(f => f.customerId === c.id && f.status === 'pending') && (
                  <button onClick={() => { const fu = list.find(f => f.customerId === c.id && f.status === 'pending'); if (fu) handleComplete(fu) }} className="px-2 py-1.5 bg-green-50 text-green-600 border border-green-200 rounded-lg text-xs">✓ 完成</button>
                )}
                <button onClick={() => navigate('/inbox')} className="px-2 py-1.5 bg-white border rounded-lg text-xs text-gray-500">邮件 ›</button>
              </div>
            </div>
          ))}
          {pageData.length === 0 && <div className="text-center text-xs text-gray-300 py-8">暂无预警</div>}
        </div>

        {/* 分页 + 每页条数（按当前分区记忆） */}
        <div className="flex items-center justify-between mt-3 text-xs text-gray-400 flex-wrap gap-2">
          <span>
            共 {catFiltered.length} 条
            {catFilter !== 'all' && (
              <span className="ml-1 text-blue-500">
                · 当前分区「{{high:'高意向',today:'今日跟进',overdue:'逾期跟进',pending:'待成交',repurchase:'复购',marketing:'营销'}[catFilter] || catFilter}」
              </span>
            )}
            {' · 第 '}{safePage}/{totalPages} 页
          </span>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1">
              每页
              <select
                value={perPage}
                onChange={e=> setPerPage(Number(e.target.value)||10)}
                className="border rounded px-1.5 py-0.5 text-[11px] bg-white text-gray-600"
                title="每个分区可单独设置，切换分区会记住各自条数"
              >
                {PER_PAGE_OPTIONS.map(n=> <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <div className="flex items-center gap-1">
              <button onClick={() => setPage(p => Math.max(1, p - 1))} className="w-6 h-6 bg-white border rounded">{'<'}</button>
              {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                const start = Math.max(1, Math.min(safePage - 3, totalPages - 6))
                return start + i
              }).filter(n=> n>=1 && n<=totalPages).map(n => (
                <button key={n} onClick={() => setPage(n)} className={`w-6 h-6 rounded ${safePage === n ? 'bg-blue-500 text-white' : 'bg-white border'}`}>{n}</button>
              ))}
              <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} className="w-6 h-6 bg-white border rounded">{'>'}</button>
            </div>
          </div>
        </div>
      </div>
      </>
      )}

      {/* ====== 跟进档案表 ====== */}
      {mainView==='board' && (()=>{
        const seqMapB = new Map<string, any>()
        for(const s of sequences) seqMapB.set(s.customer_id, s)
                const mailList = emails
        const liveFollowCount = (c: Customer) => {
          const addrs = customerAddrs(c)
          const { lastReply } = computeMailTimes(mailList, addrs)
          return countFollowsSinceReply(mailList, addrs, lastReply)
        }
        const followStepOf = (c: Customer) => {
          const seq = seqMapB.get(c.id)
          const sentSteps = seq ? (seq.steps||[]).filter((t:any)=> t.status==='sent').length : 0
          const persisted = Number((c as any).followStep || 0)
          if(sentSteps > 0) return Math.max(persisted, sentSteps)
          if(persisted > 0) return persisted
          // 本地按模板相似度扫描（即使档案未写入）
          const addrs = customerAddrs(c)
          const scan = bestFollowStepFromMails(mailList, addrs, seqTemplates?.length ? seqTemplates.map((tt:any, i:number)=>({
            n: Number(String(tt.id||'').match(/(\d+)$/)?.[1] || i+1),
            name: tt.name,
            keywords: [tt.subject, ...(String(tt.body||'').toLowerCase().split(/\s+/).filter((w:string)=> w.length>=4))].filter(Boolean).map(String),
          })) : undefined)
          return scan.step || 0
        }
        const followCountOf = (c: Customer) => Math.max(Number((c as any).followCountSinceReply || 0), liveFollowCount(c))
        const inqByCust = new Map<string, InquiryRecord>()
        const todayStr = new Date().toISOString().slice(0,10)
        for(const r of inquiries){
          if(r.customerId && !inqByCust.has(r.customerId)) inqByCust.set(r.customerId, r)
        }
        const rows = customers.filter(c=>{
          if(boardHideNoise && isBoardNoiseEmail(c.email)) return false
          if((c.tags||[]).map(String).includes('噪声') && boardHideNoise) return false
          const st = salesStageOf(c)
          if(boardStage !== 'all' && st !== boardStage) return false
          const fm = followModeOf(c)
          if(boardMode !== 'all' && fm !== boardMode) return false
          const hr = String((c as any).hasReply||'')
          if(boardReply === 'yes' && hr !== 'yes') return false
          if(boardReply === 'no' && hr === 'yes') return false
          if(boardHighOnly){
            const high = (c as any).aiTier==='high' || hr==='yes' || c.isKey
            if(!high) return false
          }
          if(boardStepMin > 0){
            if(followStepOf(c) < boardStepMin) return false
          }
          const inq = inqByCust.get(c.id)
          const inqTag = isInquiryCustomer(c)
          if(boardInq === 'yes' && !inq && !inqTag) return false
          if(boardInq === 'today'){
            const d = String(inq?.inquiryDate||'')
            if(d.slice(0,10) !== todayStr) return false
          }
          if(boardInq === 'pending'){
            const ok = !inq || !inq.customerEmail || inq.completeness === 'L0' || inq.status === 'pending_contact'
            if(!ok) return false
          }
          if(boardQ.trim()){
            const q = boardQ.trim().toLowerCase()
            const hay = `${c.contactName||''} ${c.title||''} ${c.email||''} ${c.company||''} ${inq?.inquiryNo||''} ${(c as any).inquiryNos?.join?.(' ')||''}`.toLowerCase()
            if(!hay.includes(q)) return false
          }
          return true
        })
        const LEVEL_RANK: Record<string, number> = { 'A+':5, 'A':4, 'B':3, 'C':2, 'D':1 }
        const STAGE_RANK: Record<string, number> = { ordered:3, following:2, cancelled:1 }
        const replyRank = (c: Customer) => String((c as any).hasReply||'')==='yes' ? 1 : 0
        const dir = boardSortDir === 'asc' ? 1 : -1
        rows.sort((a,b)=>{
          switch(boardSort){
            case 'created':
              return dir * String(createdAtOf(a)||'').localeCompare(String(createdAtOf(b)||''))
            case 'level':
              return dir * ((LEVEL_RANK[a.level||'C']||0) - (LEVEL_RANK[b.level||'C']||0))
            case 'reply':
              return dir * (replyRank(a) - replyRank(b))
            case 'reply_time':
              return dir * String((a as any).lastReplyAt||'').localeCompare(String((b as any).lastReplyAt||''))
            case 'follow_at':
              return dir * String((a as any).lastFollowAt||'').localeCompare(String((b as any).lastFollowAt||''))
            case 'follow_count':
              return dir * (followCountOf(a) - followCountOf(b))
            case 'step':
              return dir * (followStepOf(a) - followStepOf(b))
            case 'stage':
              return dir * ((STAGE_RANK[salesStageOf(a)]||0) - (STAGE_RANK[salesStageOf(b)]||0))
            case 'name':
              return dir * String(a.contactName||a.title||'').localeCompare(String(b.contactName||b.title||''))
            case 'no_follow':
            default:
              return dir * ((daysNoFollow(a) ?? 999) - (daysNoFollow(b) ?? 999))
          }
        })
        const showBoardChecks = boardFiltersOpen || boardSelectMode || boardSelected.size > 0
        const copyEmail = async (email: string) => {
          try{
            await navigator.clipboard.writeText(email)
            setCopiedEmail(email)
            setTimeout(()=> setCopiedEmail(''), 1200)
          }catch{
            const ta = document.createElement('textarea')
            ta.value = email
            document.body.appendChild(ta)
            ta.select()
            document.execCommand('copy')
            document.body.removeChild(ta)
            setCopiedEmail(email)
            setTimeout(()=> setCopiedEmail(''), 1200)
          }
        }
        const handleAiReply = async (c: Customer) => {
          try{
            const { getAiSettings } = await import('../config/aiProviders')
            const ai = getAiSettings()
            if(!(ai.apiKey || ai.proxyUrl) && !confirm('未配置 AI Key，生成可能失败。继续？')) return
            if(!confirm(`为 ${c.contactName||c.title} 用 AI 生成跟进并入队发送？（有往来则挂会话最下方）`)) return
            setAiReplyBusy(c.id)
            const mails = await db.emails.toArray()
            const gen = await generateAiFollowReply(c, mails)
            const accs = await listAccounts()
            if(!accs.length){ alert('请先绑定邮箱'); return }
            const { findLatestThreadHeaders } = await import('../repositories/emailRepository')
            const th = await findLatestThreadHeaders(c.email||'').catch(()=>({ found:false, messageId:'', references:'' } as any))
            const mid = th.found && th.messageId ? th.messageId : undefined
            await enqueueMail(accs[0].id, c.email||'', gen.subject, gen.body, 'ai-reply-'+c.id+'-'+Date.now(), false, {
              html: (await import('../utils/mailHtml')).textToHtml(gen.body),
              inReplyTo: mid,
              references: mid,
            })
            await setCustomerFollowMode(c, 'manual', 'user')
            setIntellectNote(`AI回复已入队：${c.contactName||c.email} · ${mid?'会话回复':'新邮件'}`)
            await loadSequences()
            await load()
          }catch(e:any){ setIntellectNote('AI回复失败：'+String(e.message||e).slice(0,120)) }
          finally{ setAiReplyBusy('') }
        }
        const totalPagesB = Math.max(1, Math.ceil(rows.length / boardPerPage))
        const safeB = Math.min(boardPage, totalPagesB)
        const pageRows = rows.slice((safeB-1)*boardPerPage, safeB*boardPerPage)
        const toggleBoard = (id: string) => setBoardSelected(prev=>{
          const n = new Set(prev)
          if(n.has(id)) n.delete(id); else n.add(id)
          return n
        })
        const selectedCustomers = customers.filter(c=> boardSelected.has(c.id))
        const applyBoardBulk = async (kind: string) => {
          if(!selectedCustomers.length) return alert('请先勾选客户')
          const n = selectedCustomers.length
          if(kind==='copy-emails'){
            const list = selectedCustomers.map(c=> c.email).filter(Boolean).join('\n')
            try{ await navigator.clipboard.writeText(list) }catch{}
            setIntellectNote(`已复制 ${n} 个邮箱`)
            return
          }
          if(kind==='seq-start'){
            if(!confirm(`对已选 ${n} 人启动自动跟进序列？`)) return
            setBoardBulkBusy('seq')
            let ok=0
            for(const c of selectedCustomers){ try{ await handleStartSeq(c); ok++ }catch{} }
            setIntellectNote(`批量启动序列：成功 ${ok}/${n}`)
            setBoardBulkBusy(''); await load(); return
          }
          if(kind==='seq-stop'){
            setBoardBulkBusy('seq-stop')
            for(const c of selectedCustomers){
              await setCustomerFollowMode(c, 'manual', 'user')
              try{ await patchSequence(c.id, { mode:'manual' }) }catch{}
            }
            setIntellectNote(`已批量停自动跟进 ${n} 人`)
            setBoardBulkBusy(''); await load(); return
          }
          if(kind==='high'){
            setBoardBulkBusy('high')
            for(const c of selectedCustomers){
              await addManualBuckets([c.id], ['high'], '跟进表批量高意向', 'add')
              await db.customers.update(c.id, { aiTier:'high', aiReason:'批量高意向', updatedAt:new Date().toISOString() } as any)
            }
            setIntellectNote(`已批量标高意向 ${n} 人`)
            setBoardBulkBusy(''); await load(); return
          }
          if(kind.startsWith('mode-')){
            const mode = kind==='mode-auto' ? 'auto' : 'manual'
            if(mode==='auto' && !confirm(`将 ${n} 人标为「自动跟进」并启动/恢复序列？`)) return
            setBoardBulkBusy('mode')
            for(const c of selectedCustomers){ await setCustomerFollowMode(c, mode, 'user') }
            setIntellectNote(`批量改跟进方式：${n} 人 → ${mode==='auto'?'自动':'手动'}`)
            setBoardBulkBusy(''); await load(); return
          }
          if(kind.startsWith('stage-')){
            const st = kind.replace('stage-','') as SalesStage
            const label = st==='ordered'?'已下单':st==='cancelled'?'取消':'跟进中'
            if(!confirm(`将 ${n} 人销售阶段改为「${label}」？`)) return
            setBoardBulkBusy('stage')
            for(const c of selectedCustomers){ await setCustomerSalesStage(c, st) }
            setIntellectNote(`批量销售阶段 → ${label}：${n} 人`)
            setBoardBulkBusy('')
            await load()
          }
        }
        return (
          <div className="bg-white rounded-2xl border p-4 space-y-3 w-full min-w-0">
            <div className="flex items-center gap-2 flex-wrap text-sm">
              <span className="font-semibold text-base">📋 跟进档案表</span>
              <span className="text-gray-500">共 {rows.length} 人</span>
              <button
                onClick={()=> setBoardFiltersOpen(v=>!v)}
                className={`px-2 py-1 border rounded text-sm ${boardFiltersOpen?'bg-blue-50 border-blue-300 text-blue-700':'bg-white'}`}
                title="展开/折叠筛选排序栏"
              >{boardFiltersOpen ? '收起筛选 ▲' : '筛选/排序 ▼'}</button>
              {boardFiltersOpen && (
                <button
                  onClick={()=> setBoardSelectMode(v=>!v)}
                  className={`px-2 py-1 border rounded text-sm ${boardSelectMode||boardSelected.size?'bg-indigo-600 text-white border-indigo-600':'bg-white'}`}
                >☑ 多选{boardSelected.size?`(${boardSelected.size})`:''}</button>
              )}
              {boardFiltersOpen && (<>
              <select value={boardMode} onChange={e=>{ setBoardMode(e.target.value as any); setBoardPage(1) }} className="border rounded px-2 py-1.5 text-sm">
                <option value="all">全部跟进方式</option><option value="auto">自动跟进</option><option value="manual">手动跟进</option>
              </select>
              <select value={boardReply} onChange={e=>{ setBoardReply(e.target.value as any); setBoardPage(1) }} className="border rounded px-2 py-1.5 text-sm">
                <option value="all">回复：全部</option><option value="yes">有回复</option><option value="no">无回复</option>
              </select>
              <select value={boardStage} onChange={e=>{ setBoardStage(e.target.value as any); setBoardPage(1) }} className="border rounded px-2 py-1.5 text-sm">
                <option value="all">销售阶段：全部</option><option value="following">跟进中</option><option value="ordered">已下单</option><option value="cancelled">取消</option>
              </select>
              <input value={boardQ} onChange={e=>{ setBoardQ(e.target.value); setBoardPage(1) }} placeholder="搜客户/邮箱/公司" className="border rounded px-2 py-1.5 text-sm w-40"/>
              <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={boardHighOnly} onChange={e=> setBoardHighOnly(e.target.checked)}/> 仅高意向</label>
              <select value={boardStepMin} onChange={e=>{ setBoardStepMin(Number(e.target.value)||0); setBoardPage(1) }} className="border rounded px-2 py-1.5 text-sm">
                <option value={0}>跟进步：全部</option>
                {[1,2,3,4,5,6,7].map(n=> <option key={n} value={n}>≥跟进{n}</option>)}
              </select>
              <select value={boardInq} onChange={e=>{ setBoardInq(e.target.value as any); setBoardPage(1) }} className="border rounded px-2 py-1.5 text-sm">
                <option value="all">询盘：全部</option>
                <option value="yes">仅询盘</option>
                <option value="today">今日询盘</option>
                <option value="pending">待补信息</option>
              </select>
              <select value={boardSort} onChange={e=> setBoardSort(e.target.value as any)} className="border rounded px-2 py-1.5 text-sm">
                <option value="no_follow">排序：未跟进天数</option>
                <option value="created">排序：创建时间</option>
                <option value="level">排序：客户等级</option>
                <option value="reply">排序：回复</option>
                <option value="reply_time">排序：最近回复</option>
                <option value="follow_at">排序：最近跟进</option>
                <option value="follow_count">排序：跟进次数</option>
                <option value="step">排序：跟进状态</option>
                <option value="stage">排序：销售阶段</option>
                <option value="name">排序：客户名</option>
              </select>
              <button onClick={()=> setBoardSortDir(d=> d==='asc'?'desc':'asc')} className="px-2 py-1.5 border rounded text-sm">{boardSortDir==='asc'?'↑ 升序':'↓ 降序'}</button>
              <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={boardHideNoise} onChange={e=> setBoardHideNoise(e.target.checked)}/> 隐藏噪声邮箱</label>
              </>)}
              <label className="flex items-center gap-1 ml-auto text-sm">每页
                <select value={boardPerPage} onChange={e=> setBoardPerPagePersist(Number(e.target.value)||20)} className="border rounded px-1 py-1 text-sm">
                  {[10,20,50,100].map(n=> <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
            </div>
            {boardSelected.size>0 && (
              <div className="flex flex-wrap items-center gap-2 bg-indigo-600 text-white rounded-xl px-3 py-2 text-sm sticky top-0 z-20">
                <span className="font-medium">已选 {boardSelected.size}</span>
                <button onClick={()=> setBoardSelected(new Set(pageRows.map(c=>c.id)))} className="px-2 py-1 bg-white/15 rounded">本页全选</button>
                <button onClick={()=> setBoardSelected(new Set(rows.map(c=>c.id)))} className="px-2 py-1 bg-white/15 rounded">筛选全选 {rows.length}</button>
                <span className="opacity-70">|</span>
                <button onClick={()=> void applyBoardBulk('mode-auto')} disabled={!!boardBulkBusy} className="px-2 py-1 bg-indigo-500 rounded disabled:opacity-50">批量自动跟进</button>
                <button onClick={()=> void applyBoardBulk('mode-manual')} disabled={!!boardBulkBusy} className="px-2 py-1 bg-indigo-500 rounded disabled:opacity-50">批量手动跟进</button>
                <button onClick={()=> void applyBoardBulk('stage-ordered')} disabled={!!boardBulkBusy} className="px-2 py-1 bg-emerald-600 rounded disabled:opacity-50">标已下单</button>
                <button onClick={()=> void applyBoardBulk('stage-cancelled')} disabled={!!boardBulkBusy} className="px-2 py-1 bg-rose-600 rounded disabled:opacity-50">标取消</button>
                <button onClick={()=> void applyBoardBulk('stage-following')} disabled={!!boardBulkBusy} className="px-2 py-1 bg-indigo-500 rounded disabled:opacity-50">标跟进中</button>
                <button onClick={()=> void applyBoardBulk('high')} disabled={!!boardBulkBusy} className="px-2 py-1 bg-orange-500 rounded disabled:opacity-50">批量高意向</button>
                <button onClick={()=> void applyBoardBulk('seq-start')} disabled={!!boardBulkBusy} className="px-2 py-1 bg-purple-600 rounded disabled:opacity-50">批量启动序列</button>
                <button onClick={()=> void applyBoardBulk('seq-stop')} disabled={!!boardBulkBusy} className="px-2 py-1 bg-gray-700 rounded disabled:opacity-50">批量停自动</button>
                <button onClick={()=> void applyBoardBulk('copy-emails')} className="px-2 py-1 bg-white/20 rounded">复制邮箱</button>
                <button onClick={()=> setBoardSelected(new Set())} className="px-2 py-1 text-white/80">取消选择</button>
                {boardBulkBusy && <span className="opacity-90">处理中…</span>}
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr className="text-left text-gray-600">
                    <th className="p-2 w-8">
                      {showBoardChecks ? (
                      <input type="checkbox"
                        checked={pageRows.length>0 && pageRows.every(c=> boardSelected.has(c.id))}
                        onChange={e=>{
                          if(e.target.checked) setBoardSelected(prev=>{ const n=new Set(prev); for(const c of pageRows) n.add(c.id); return n })
                          else setBoardSelected(prev=>{ const n=new Set(prev); for(const c of pageRows) n.delete(c.id); return n })
                        }}
                      />
                      ) : null}
                    </th>
                    {([
                      { key:'name', label:'客户', w:'name', sort:'name' },
                      { key:'created', label:'创建时间', w:'created', sort:'created' },
                      { key:'inq', label:'询盘号', w:'inq' },
                      { key:'level', label:'等级', w:'level', sort:'level' },
                      { key:'reply', label:'回复', w:'reply', sort:'reply' },
                      { key:'mode', label:'跟进方式', w:'mode' },
                      { key:'reply_time', label:'最近回复', w:'reply_time', sort:'reply_time' },
                      { key:'follow', label:'最近跟进', w:'follow', sort:'follow_at' },
                      { key:'count', label:'跟进次数', w:'count', sort:'follow_count' },
                      { key:'step', label:'跟进状态', w:'step', sort:'step' },
                      { key:'no_follow', label:'未跟进', w:'no_follow', sort:'no_follow' },
                      { key:'stage', label:'销售阶段', w:'stage', sort:'stage' },
                      { key:'ops', label:'操作', w:'ops' },
                    ] as const).map(col=>{
                      const sortKey = (col as any).sort as string | undefined
                      const sortable = !!sortKey
                      return (
                        <th
                          key={col.key}
                          className="p-2 select-none relative"
                          style={{ width: colW(col.w, col.key==='name'?180:110), minWidth: 56 }}
                          onClick={()=>{ if(sortable && sortKey) toggleBoardSort(sortKey as any) }}
                        >
                          <span className={sortable?'cursor-pointer inline-flex items-center':''}>
                            {col.label}
                            {sortable && sortKey && <SortIcon col={sortKey} />}
                          </span>
                          <span
                            onMouseDown={(e)=> startColResize(col.w, e)}
                            className="absolute right-0 top-1/2 -translate-y-1/2 w-1.5 h-5 cursor-col-resize hover:bg-blue-400 rounded"
                            title="拖拽调整列宽"
                          />
                        </th>
                      )
                    })}
                  </tr>
                </thead>

                <tbody>
                  {pageRows.map(c=>{
                    const seq = seqMapB.get(c.id)
                    const fm = followModeOf(c)
                    const st = salesStageOf(c)
                    const hr = String((c as any).hasReply||'')
                    const dn = daysNoFollow(c)
                    return (
                      <tr key={c.id} className={`border-t hover:bg-blue-50/40 ${boardSelected.has(c.id)?'bg-indigo-50/60':''}`}>
                        <td className="p-2">
                          {showBoardChecks && (
                            <input type="checkbox" checked={boardSelected.has(c.id)} onChange={()=> toggleBoard(c.id)}/>
                          )}
                        </td>
                        <td className="p-2" style={{ maxWidth: colW('name', 180) }}>
                          <div className="font-medium truncate text-sm">{c.contactName||c.title}
                            {c.isKey && <span className="ml-1 text-yellow-500" title="重点">★</span>}
                            {((c as any).aiTier==='high' || hr==='yes') && (
                              <span className="ml-1 px-1 rounded bg-red-50 text-red-600 text-[11px]">高意向</span>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={()=> void copyEmail(c.email||'')}
                            className="text-gray-500 hover:text-blue-600 hover:underline truncate max-w-full text-left text-xs"
                            title="点击复制邮箱"
                          >{copiedEmail===c.email ? '已复制 ✓' : (c.email||'—')}</button>
                        </td>
                        <td className="p-2 text-gray-600 whitespace-nowrap" style={{ width: colW('created', 110) }}>{createdAtOf(c)}</td>
                        <td className="p-2 text-xs">
                          {(()=>{
                            const inq = inqByCust.get(c.id)
                            const nos = (c as any).inquiryNos as string[] | undefined
                            const no = inq?.inquiryNo || nos?.[0]
                            if(!no && !isInquiryCustomer(c)) return <span className="text-gray-300">—</span>
                            return (
                              <div className="max-w-[140px]">
                                <div className="font-mono text-[11px] text-blue-700 truncate" title={no}>{no || '询盘'}</div>
                                <div className="text-[10px] text-gray-400 truncate">
                                  {[inq?.productName, inq?.qty?`${inq.qty}pcs`:null, inq?.amount?`$${inq.amount}`:null].filter(Boolean).join(' · ') || inq?.inquiryDate?.slice(0,10) || ''}
                                </div>
                                {inq?.completeness === 'L0' && <div className="text-[10px] text-amber-600">待补信息</div>}
                              </div>
                            )
                          })()}
                        </td>
                        <td className="p-2">{c.level||'C'}{c.isKey?'⭐':''}</td>
                        <td className="p-2"><span className={`px-2 py-0.5 rounded ${hr==='yes'?'bg-green-100 text-green-700':'bg-gray-100 text-gray-600'}`}>{hr==='yes'?'有':'无'}</span></td>
                        <td className="p-2">
                          <select value={fm} onChange={async(ev)=>{
                            await setCustomerFollowMode(c, ev.target.value as FollowMode, 'user')
                            await load()
                          }} className="border rounded px-1.5 py-1 text-sm">
                            <option value="manual">手动跟进</option>
                            <option value="auto">自动跟进</option>
                          </select>
                        </td>
                        <td className="p-2 text-gray-600">{(c as any).lastReplyAt ? String((c as any).lastReplyAt).slice(0,10) : '—'}</td>
                        <td className="p-2 text-gray-600">{(c as any).lastFollowAt ? String((c as any).lastFollowAt).slice(0,10) : '—'}</td>
                        <td className="p-2" title="距上次客户回复后我方发送数量">
                          <b className={followCountOf(c)>=3?'text-orange-600':''}>{followCountOf(c)}</b>
                        </td>
                        <td className="p-2">
                          <div className="text-sm">
                            {followStepOf(c) > 0 ? stepLabel(followStepOf(c)) : (seq?.mode==='auto' ? `待发步${Math.min(seq.current_step||1,7)}` : '—')}
                            {seq?.mode==='auto' ? ` · 序列${Math.min(seq.current_step||1,7)}/7` : ''}
                          </div>
                          {String((c as any).followStepMatched||'') && <div className="text-[10px] text-gray-400 truncate max-w-[120px]" title={String((c as any).followStepMatched)}>{(c as any).followStepMatched}</div>}
                        </td>
                        <td className={`p-2 text-sm ${(dn!=null && dn>7)?'text-rose-600 font-medium':''}`}>{dn==null?'—':`${dn}天`}</td>
                        <td className="p-2">
                          <select value={st} onChange={async(ev)=>{
                            await setCustomerSalesStage(c, ev.target.value as SalesStage)
                            await load()
                          }} className="border rounded px-1.5 py-1 text-sm">
                            <option value="following">跟进中</option>
                            <option value="ordered">已下单</option>
                            <option value="cancelled">取消</option>
                          </select>
                        </td>
                        <td className="p-2">
                          <div className="flex flex-wrap gap-1">
                            <button
                              onClick={async()=>{
                                await addManualBuckets([c.id], ['high'], '跟进表标高意向', 'add')
                                await db.customers.update(c.id, { aiTier:'high', aiReason:'手动高意向', updatedAt:new Date().toISOString() } as any)
                                setIntellectNote(`已标高意向：${c.contactName||c.email}`)
                                await load()
                              }}
                              className="px-2 py-1 border rounded text-xs text-orange-600"
                            >高意向</button>
                            <button
                              onClick={()=> void handleAiReply(c)}
                              disabled={aiReplyBusy===c.id || !!aiReplyBusy}
                              className="px-2 py-1 border rounded text-xs text-purple-700 disabled:opacity-50"
                              title="AI 读画像+邮件生成英文跟进，有往来挂会话入队"
                            >{aiReplyBusy===c.id?'AI中…':'AI回复'}</button>
                            {fm==='auto'
                              ? <button onClick={()=> void handleSeqMode(c.id,'manual')} className="px-2 py-1 border rounded text-xs">停自动</button>
                              : <button onClick={()=> void handleStartSeq(c)} className="px-2 py-1 border rounded text-xs text-blue-600">启动序列</button>}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between text-sm text-gray-500">
              <span>第 {safeB}/{totalPagesB} 页 · 勾选后可批量改方式/阶段/高意向/序列</span>
              <div className="flex gap-1">
                <button onClick={()=> setBoardPage(p=> Math.max(1,p-1))} className="w-8 h-8 border rounded bg-white">{'<'}</button>
                <button onClick={()=> setBoardPage(p=> Math.min(totalPagesB,p+1))} className="w-8 h-8 border rounded bg-white">{'>'}</button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* ====== 自动跟进序列（7步 / 回复转手动 / 沉睡池）====== */}
      <div className="bg-white rounded-2xl border p-4 mt-3">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <span className="text-sm font-semibold">🔁 自动跟进序列</span>
          <div className="flex gap-1">
            {([['active','进行中'],['replied','🔔有回复'],['dormant','沉睡池']] as const).map(([k, l]) => (
              <button key={k} onClick={()=> setSeqTab(k)} className={`px-2 py-1 rounded-full text-xs ${seqTab===k?'bg-blue-600 text-white':'bg-gray-100 text-gray-500'}`}>{l}</button>
            ))}
          </div>
          <button onClick={()=> setShowTplModal(true)} className="ml-auto px-2 py-1 text-xs border rounded-lg hover:border-blue-300">📝 模板+间隔</button>
        </div>
        <div className="text-[11px] text-gray-400 mb-2">
          共 {seqStats.total} 个序列 · 进行中 {seqStats.auto} · 已回复 {seqStats.replied} · 沉睡 {seqStats.dormant} · 累计发出 {seqStats.sentSteps} 步
        </div>
        {(() => {
          const rows = seqTab === 'active' ? sequences.filter(s=> s.mode==='auto')
            : seqTab === 'replied' ? sequences.filter(s=> s.replied)
            : sequences.filter(s=> s.mode==='dormant')
          if(!rows.length) return <div className="text-center text-xs text-gray-300 py-4">{seqTab==='replied' ? '暂无客户回复（有回复会自动标🔔并转手动）' : seqTab==='dormant' ? '沉睡池为空（7步无回复自动进入）' : '暂无进行中的序列，可在上方雷达点「跟进」旁启动'}</div>
          return rows.map(s=>(
            <div key={s.customer_id} className="flex items-center gap-2 py-2 border-b last:border-0 text-xs">
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{s.customer?.title || s.email} {s.replied ? <span className="text-red-500">🔔有回复</span> : null}</div>
                <div className="text-gray-400 truncate">{s.email} · 第 {Math.min(s.current_step,7)}/7 步{s.mode==='auto' ? ` · 下次 ${String(s.next_due_at||'').slice(0,10)}` : ''}</div>
                <div className="flex gap-0.5 mt-1">
                  {[1,2,3,4,5,6,7].map(n=>{
                    const st = (s.steps||[]).find((t:any)=> Number(t.n)===n)
                    return <span key={n} title={`跟进${n}${st?.status==='sent' ? '（已发）' : ''}`} className={`w-4 h-1.5 rounded-full ${st?.status==='sent'?'bg-green-500':(s.mode==='auto'&&n===s.current_step?'bg-blue-500 animate-pulse':'bg-gray-200')}`} />
                  })}
                </div>
              </div>
              <div className="flex gap-1 shrink-0">
                {s.mode==='auto' && <button onClick={()=> handleSeqMode(s.customer_id,'manual')} className="px-2 py-1 border rounded-lg text-gray-500">转手动</button>}
                {s.mode!=='auto' && s.mode!=='dormant' && <button onClick={()=> handleSeqMode(s.customer_id,'auto')} className="px-2 py-1 bg-blue-50 text-blue-600 border border-blue-200 rounded-lg">调回自动</button>}
                {s.mode==='dormant' && <button onClick={()=> handleSeqMode(s.customer_id,'auto',1)} className="px-2 py-1 bg-green-50 text-green-600 border border-green-200 rounded-lg">重新激活</button>}
              </div>
            </div>
          ))
        })()}
        {/* 雷达快捷启动 */}
        {seqTab==='active' && (
          <div className="mt-2 text-[11px] text-gray-400">在上方雷达客户行点「跟进」发单封；要进7步自动序列，点下面：</div>
        )}
      </div>

      {/* 发送预览 */}
      {showPreview && sendTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40" onClick={()=> setShowPreview(false)}>
          <div className="bg-white rounded-2xl w-full max-w-xl max-h-[85vh] flex flex-col" onClick={e=> e.stopPropagation()}>
            <div className="px-5 py-3 border-b flex items-center justify-between">
              <div className="text-sm font-semibold">👁 邮件预览</div>
              <button onClick={()=> setShowPreview(false)} className="p-1 hover:bg-gray-100 rounded">✕</button>
            </div>
            <div className="flex-1 overflow-y-auto p-5 space-y-3 text-xs">
              <div><span className="text-gray-400">收件人：</span>{sendTarget.email}</div>
              <div><span className="text-gray-400">主题：</span>{previewSubject}</div>
              <div><span className="text-gray-400">发送方式：</span>{threadInfo.found && useThreadReply ? '会话回复（Re: + In-Reply-To）' : '新邮件'}</div>
              <div><span className="text-gray-400">附件方式：</span>{attachMode==='file'?'文件附件':attachMode==='inline'?'仅插入正文':'附件+正文图'}</div>
              <div className="border rounded-lg p-3 bg-gray-50 whitespace-pre-wrap leading-relaxed min-h-[120px]">
                {sendBody || '(空)'}
                {attachMode!=='file' && previewAttachments.length>0 && (
                  <div className="mt-3 text-gray-500">[正文将附带 {previewAttachments.filter(a=> String(a.contentType||'').startsWith('image/')||/\.(png|jpe?g)$/i.test(a.filename)).length} 张图片]</div>
                )}
              </div>
              <div>
                <div className="text-gray-400 mb-1">附件（{previewAttachments.length}）</div>
                {previewAttachments.length===0 && <div className="text-gray-400">无</div>}
                {previewAttachments.map(a=>(
                  <div key={a.filename+String(a.path||'')} className="text-[11px]">📎 {a.filename}</div>
                ))}
              </div>
            </div>
            <div className="px-5 py-3 border-t flex justify-end gap-2">
              <button onClick={()=> setShowPreview(false)} className="px-4 py-2 border rounded-lg text-xs">返回修改</button>
              <button onClick={async()=>{ setShowPreview(false); /* 发送走 handleSend */ }} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-xs">关闭预览，点发送</button>
            </div>
          </div>
        </div>
      )}

      {/* 批量发跟进：名单 + 模板 + AI */}
      {showBatchModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={()=> !batchSending && setShowBatchModal(false)}>
          <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={e=> e.stopPropagation()}>
            <div className="px-5 py-3 border-b flex items-center justify-between">
              <div className="text-sm font-semibold">📣 批量发跟进 · 将入队 {batchTargets.length} 位客户</div>
              <button onClick={()=> setShowBatchModal(false)} disabled={batchSending} className="p-1 hover:bg-gray-100 rounded-lg">✕</button>
            </div>
            <div className="flex-1 overflow-y-auto p-5 space-y-3">
              <div className="text-[11px] text-gray-400">今日配额 {getTodaySendCount()}/{BATCH_SEND.dailyLimit} · 间隔 5 秒入队 · 发出由「待发」队列完成</div>
              <div>
                <div className="text-xs font-medium text-gray-700 mb-1">入队名单（{batchTargets.length}）</div>
                <div className="max-h-36 overflow-y-auto border rounded-lg divide-y">
                  {batchTargets.map(c=>(
                    <div key={c.id} className="px-2 py-1.5 text-xs flex items-center gap-2">
                      <span className="font-medium truncate">{c.contactName || c.title}</span>
                      <span className="text-gray-400 truncate flex-1">{c.email}</span>
                      <span className="text-gray-300 shrink-0">{c.level||'C'}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <select value={batchTplId} onChange={e=> applyBatchTpl(e.target.value)} className="px-2 py-1.5 border rounded-lg text-xs">
                  {TEMPLATES.map(t=> <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <button onClick={()=> void handleBatchAiTpl()} disabled={batchAiBusy} className="px-2 py-1.5 bg-purple-600 text-white rounded-lg text-xs disabled:opacity-50">
                  {batchAiBusy ? 'AI 生成中…' : '✨ AI 生成模板'}
                </button>
                <label className="flex items-center gap-1 text-[11px] text-gray-600">
                  <input type="checkbox" checked={batchAutoAtt} onChange={e=> setBatchAutoAtt(e.target.checked)}/>
                  附带最新附件
                </label>
                {batchAutoAtt && (
                  <>
                    <label className="flex items-center gap-1 text-[11px] text-gray-600">
                      <input type="radio" name="attPolicy" checked={batchAttPolicy==='require'} onChange={()=> setBatchAttPolicy('require')}/>
                      无附件不发
                    </label>
                    <label className="flex items-center gap-1 text-[11px] text-gray-600">
                      <input type="radio" name="attPolicy" checked={batchAttPolicy==='optional'} onChange={()=> setBatchAttPolicy('optional')}/>
                      无附件也发
                    </label>
                  </>
                )}
                <label className="flex items-center gap-1 text-[11px] text-gray-600">
                  <input type="radio" name="sch" checked={batchScheduleMode==='now'} onChange={()=> setBatchScheduleMode('now')}/>
                  立即
                </label>
                <label className="flex items-center gap-1 text-[11px] text-gray-600">
                  <input type="radio" name="sch" checked={batchScheduleMode==='at'} onChange={()=> setBatchScheduleMode('at')}/>
                  定时
                </label>
                {batchScheduleMode==='at' && (
                  <input type="datetime-local" value={batchScheduleAt} onChange={e=> setBatchScheduleAt(e.target.value)} className="px-2 py-1 border rounded text-xs"/>
                )}
                <span className="text-[10px] text-gray-400">支持 Hi + 客户名；图片默认用最新附件嵌正文</span>
              </div>
              <input value={batchSubject} onChange={e=> setBatchSubject(e.target.value)} placeholder="主题" className="w-full px-3 py-2 border rounded-lg text-sm"/>
              <textarea value={batchBody} onChange={e=> setBatchBody(e.target.value)} rows={8} placeholder="正文" className="w-full px-3 py-2 border rounded-lg text-sm resize-y font-mono"/>
              <div className="text-[10px] text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-2 py-1.5">
                会话规则：客户<strong>有邮件来往</strong>时，主题固定用「Re: 历史最新主题」+ In-Reply-To 挂到会话最下方；
                <strong>无来往</strong>才用上面的模板主题新发。主题框仅对新客户生效。
              </div>
              {batchResult && (
                <div className="text-xs px-3 py-2 rounded-lg bg-green-50 text-green-700 border border-green-100">
                  {batchScheduleMode==='at' && batchScheduleAt ? `已定时 ${new Date(batchScheduleAt).toLocaleString()} 入队` : '已入队'} {batchResult.ok} 封{batchResult.errors?`，失败 ${batchResult.errors}`:''}{batchSkipped?`，跳过无附件 ${batchSkipped}`:''}。
                  {' '}挂线程 {batchResult.threaded||0}{batchResult.subjectOnly?` · 仅历史主题 ${batchResult.subjectOnly}`:''}{batchResult.newMail?` · 新邮件 ${batchResult.newMail}`:''}。
                  打开邮件中心 → 顶栏「📤 待发」查看发送进度（可预览/取消）。
                </div>
              )}
              {batchSending && (
                <div className="text-xs text-blue-600">入队中 {batchProgress.done}/{batchProgress.total}{batchProgress.errors?` · 失败 ${batchProgress.errors}`:''}…</div>
              )}
            </div>
            <div className="px-5 py-3 border-t flex items-center gap-2">
              <button onClick={()=> setShowBatchModal(false)} disabled={batchSending} className="px-4 py-2 text-xs text-gray-500 hover:bg-gray-100 rounded-lg">关闭</button>
              <div className="flex-1"/>
              {batchResult ? (
                <button onClick={()=>{ setShowBatchModal(false); navigate('/inbox') }} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-xs">
                  打开邮件中心 · 待发
                </button>
              ) : (
                <button onClick={()=> void handleBatchSend()} disabled={batchSending || !batchSubject.trim() || !batchBody.trim()}
                  className="px-4 py-2 bg-pink-600 text-white rounded-lg text-xs disabled:opacity-50">
                  {batchSending ? '入队中…' : `确认入队 ${batchTargets.length} 封`}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 模板+间隔编辑弹窗 */}
      {showTplModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={()=> setShowTplModal(false)}>
          <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={e=> e.stopPropagation()}>
            <div className="px-5 py-3 border-b flex items-center justify-between">
              <div className="text-sm font-semibold">📝 跟进模板与间隔</div>
              <button onClick={()=> setShowTplModal(false)} className="p-1 hover:bg-gray-100 rounded-lg">✕</button>
            </div>
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              <div>
                <div className="text-xs text-gray-500 mb-1">每步间隔天数（跟进1报价后X天，之后每步+…天，可改）</div>
                <div className="flex gap-1 flex-wrap">
                  {seqIntervals.map((v,i)=>(
                    <label key={i} className="text-[11px] text-gray-500">第{i+1}步
                      <input type="number" min={1} value={v} onChange={e=>{
                        const n = [...seqIntervals]; n[i] = Math.max(1, Number(e.target.value)||1); setSeqIntervals(n)
                      }} className="w-12 ml-1 px-1 py-0.5 border rounded text-xs" />
                    </label>
                  ))}
                  <button onClick={async()=>{ try{ await saveSeqConfig(seqIntervals, { sendStart, sendEnd, skipHolidays }); alert('间隔与发送窗口已保存，新启动序列生效') }catch(e:any){ alert(String(e.message||e)) } }} className="px-3 py-1 bg-blue-600 text-white rounded-lg text-xs">保存间隔</button>
                </div>
                <div className="text-xs text-gray-500 mt-2">发送窗口（美东时间，自动序列/营销群发只在窗口内发出，用户手动发送不受限）</div>
                <div className="flex gap-2 items-center mt-1 text-xs text-gray-500 flex-wrap">
                  <label>开始 <input type="number" min={0} max={23} value={sendStart} onChange={e=> setSendStart(Number(e.target.value)||0)} className="w-12 px-1 py-0.5 border rounded text-xs" /> 点</label>
                  <label>结束 <input type="number" min={1} max={24} value={sendEnd} onChange={e=> setSendEnd(Number(e.target.value)||24)} className="w-12 px-1 py-0.5 border rounded text-xs" /> 点</label>
                  <label className="flex items-center gap-1"><input type="checkbox" checked={skipHolidays} onChange={e=> setSkipHolidays(e.target.checked)} className="accent-blue-600" /> 美国节假日避让</label>
                </div>
              </div>
              <div className="space-y-2">
                {seqTemplates.map(t=>(
                  <div key={t.id} className="border rounded-xl p-2">
                    <div className="text-xs font-semibold mb-1">{t.name}</div>
                    <input value={tplEdit?.id===t.id ? tplEdit.subject : t.subject} onChange={e=> setTplEdit({ id:t.id, subject:e.target.value, body: tplEdit?.id===t.id ? tplEdit.body : t.body })} placeholder="主题" className="w-full px-2 py-1 border rounded text-xs mb-1" />
                    <textarea value={tplEdit?.id===t.id ? tplEdit.body : t.body} onChange={e=> setTplEdit({ id:t.id, subject: tplEdit?.id===t.id ? tplEdit.subject : t.subject, body:e.target.value })} rows={3} placeholder="正文（支持{{first_name}}，图片占位{{image:1}}）" className="w-full px-2 py-1 border rounded text-xs resize-y" />
                    <button onClick={async()=>{ try{ await saveSeqTemplate({ id:t.id, name:t.name, kind:t.kind, subject: tplEdit?.id===t.id?tplEdit.subject:t.subject, body: tplEdit?.id===t.id?tplEdit.body:t.body }); setTplEdit(null); await loadSequences(); alert('已保存。此文案也用于判断跟进表「跟进状态」相似度。') }catch(e:any){ alert(String(e.message||e)) } }} className="mt-1 px-3 py-1 bg-green-600 text-white rounded-lg text-[11px]">保存此步</button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 发送弹窗 */}
      {showSendModal && sendTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowSendModal(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-3 border-b flex items-center justify-between">
              <div className="text-sm font-semibold">跟进邮件 → {sendTarget.contactName || sendTarget.title}</div>
              <button onClick={() => setShowSendModal(false)} className="p-1 hover:bg-gray-100 rounded-lg">✕</button>
            </div>
            <div className="flex-1 overflow-y-auto p-5 space-y-3">
              <div className="flex gap-1 flex-wrap">
                {TEMPLATES.map(t => (
                  <button key={t.id} onClick={() => {
                    setSendTemplate(t)
                    const product = sendTarget.portrait?.products?.[0] || 'Challenge Coin'
                    setSendSubject(t.subject.replace(/\{\{product\}\}/g, product))
                    setSendBody(t.body.replace(/\{\{first_name\}\}/g, (sendTarget.contactName || sendTarget.title || 'there').split(' ')[0]).replace(/\{\{product\}\}/g, product))
                  }} className={`px-2 py-1 rounded-full text-[11px] border ${sendTemplate.id === t.id ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-white text-gray-500'}`}>{t.name}</button>
                ))}
              </div>
              <div><label className="text-xs text-gray-400">收件人</label><input value={sendTarget.email || ''} readOnly className="w-full px-3 py-2 border rounded-lg text-sm bg-gray-50" /></div>
              <div><label className="text-xs text-gray-400">主题</label><input value={sendSubject} onChange={e => setSendSubject(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm" /></div>
              <div><label className="text-xs text-gray-400">正文</label><textarea value={sendBody} onChange={e => setSendBody(e.target.value)} className="w-full h-48 px-3 py-2 border rounded-lg text-sm resize-none" /></div>
              <div className="text-[11px] space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  {threadLoading ? (
                    <span className="text-gray-400">正在查询历史会话…</span>
                  ) : threadInfo.found ? (
                    <>
                      <label className="flex items-center gap-2">
                        <input type="checkbox" checked={useThreadReply} onChange={e=> setUseThreadReply(e.target.checked)}/>
                        <span>
                          在最新会话中回复 · <b className="truncate max-w-[220px] inline-block align-bottom">{threadInfo.subject||'(同主题)'}</b>
                          {!threadInfo.messageId && <span className="text-amber-600 ml-1">（将用 Re: 主题，无 Message-ID）</span>}
                        </span>
                      </label>
                      {!useThreadReply && <span className="text-orange-600">已改为发送新邮件</span>}
                    </>
                  ) : (
                    <span className="text-gray-500 bg-gray-50 border rounded px-2 py-1">ℹ️ 无历史往来 · 将发送新邮件</span>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-gray-500">附件方式：</span>
                  {([['file','作为附件发送'],['inline','图片插入正文'],['both','附件+正文图']] as const).map(([k,l])=>(
                    <label key={k} className="flex items-center gap-1">
                      <input type="radio" name="attMode" checked={attachMode===k} onChange={()=> setAttachMode(k)}/>
                      {l}
                    </label>
                  ))}
                </div>
                {custAtts.length>0 && (
                  <div className="border rounded-lg p-2">
                    <div className="text-gray-500 mb-1">📎 客户历史附件（可选）· 已勾选 {pickedAttKeys.size}</div>
                    <div className="max-h-32 overflow-y-auto space-y-1">
                      {custAtts.map((a, idx)=>{
                        const k = attKey(a)
                        return (
                          <label key={k} className="flex items-center gap-2 text-[11px]">
                            <input type="checkbox" checked={pickedAttKeys.has(k)}
                              onChange={e=>{
                                setPickedAttKeys(prev=>{
                                  const n=new Set(prev)
                                  if(e.target.checked) n.add(k); else n.delete(k)
                                  return n
                                })
                              }}/>
                            <span className="truncate flex-1">{a.filename} <span className="text-gray-300">#{idx+1} uid:{a.uid}</span></span>
                            <span className="text-gray-400 shrink-0">{Math.round((a.size||0)/1024)}KB</span>
                          </label>
                        )
                      })}
                    </div>
                    <div className="text-[10px] text-gray-400 mt-1">默认以文件附件随邮件发送；选「图片插入正文」时图片还会嵌进正文。</div>
                  </div>
                )}
                {custAtts.length===0 && <div className="text-gray-400">暂无该客户已入库附件</div>}
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={()=> setShowPreview(true)} className="px-3 py-1.5 border rounded-lg text-xs text-gray-600 hover:bg-gray-50">👁 预览</button>
              </div>
              <button onClick={handleAiDraft} disabled={aiDrafting} className="w-full py-2 bg-purple-50 text-purple-600 border border-purple-200 rounded-lg text-xs hover:bg-purple-100 disabled:opacity-50">
                ✨ {aiDrafting ? 'AI 生成中...' : 'AI 一键生成跟进草稿'}
              </button>
            </div>
            <div className="px-5 py-3 border-t flex items-center gap-2">
              <button onClick={() => setShowSendModal(false)} className="px-4 py-2 text-xs text-gray-500 hover:bg-gray-100 rounded-lg">取消</button>
              <div className="flex-1" />
              <button onClick={handleSend} disabled={sending || !sendBody.trim()} className="px-6 py-2 bg-blue-600 text-white rounded-lg text-xs flex items-center gap-1.5 hover:bg-blue-700 disabled:opacity-50">
                <Send size={12} /> {sending ? '发送中...' : '发送'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
