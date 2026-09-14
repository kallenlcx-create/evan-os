// ====== 批量营销：群发 + 复购激活 + 营销日历 ======
import { useState, useEffect, useMemo, useCallback } from 'react'
import { db } from '../db'
import type { Customer } from '../types'
import { Send, Users, Filter, Sparkles, MousePointerClick, CalendarDays, Repeat } from 'lucide-react'
import { listAccounts, sendEmail, enqueueMail, getHolidays, getRepurchasePool } from '../repositories/emailRepository'
import { chatOnce } from '../services/aiChat'

// ====== 跟进模板库 ======
const FOLLOW_UP_TEMPLATES = [
  { id: 'new_inquiry', name: '新询价跟进', subject: 'Following up on your inquiry - {{product}}', body: 'Hi {{first_name}},\n\nThank you for your interest in our {{product}}. I wanted to follow up and see if you have any questions about our previous quote.\n\nWe can offer competitive pricing for {{qty}} pieces with a lead time of 12-15 days.\n\nBest regards,\nEvan' },
  { id: 'quote_follow', name: '报价后跟进', subject: 'Re: Quote for {{product}} - Special offer', body: 'Hi {{first_name}},\n\nI hope you\'ve had a chance to review our quote. I wanted to let you know that we can offer a special discount for orders placed this week.\n\nPlease let me know if you\'d like to proceed.\n\nBest regards,\nEvan' },
  { id: 'reorder', name: '复购提醒', subject: 'Time to reorder {{product}}?', body: 'Hi {{first_name}},\n\nIt\'s been a while since your last order. I wanted to check if you need to reorder any {{product}}?\n\nWe\'ve updated our catalog with new designs that might interest you.\n\nBest regards,\nEvan' },
  { id: 'holiday', name: '节日问候', subject: 'Season\'s Greetings from Maxemblem', body: 'Hi {{first_name}},\n\nWishing you and your team a wonderful holiday season! Thank you for your continued partnership.\n\nWe look forward to working with you in the coming year.\n\nBest regards,\nEvan' },
  { id: 'new_product', name: '新品推荐', subject: 'New {{product}} designs available', body: 'Hi {{first_name}},\n\nWe\'ve just launched new {{product}} designs that I think would be perfect for your organization.\n\nWould you like to see the new catalog?\n\nBest regards,\nEvan' },
]

// ====== Campaign 效果追踪类型 ======
interface CampaignRecord {
  id: string
  customerId: string
  customerEmail: string
  templateId: string
  sentAt: string
  status: 'sent' | 'delivered' | 'opened' | 'replied' | 'bounced'
  messageId?: string
}

export default function CampaignsPage() {
  const [tab, setTab] = useState<'blast'|'reorder'|'calendar'>('blast')
  const [customers, setCustomers] = useState<Customer[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filterLevel, setFilterLevel] = useState<string>('all')
  const [filterStage, setFilterStage] = useState<string>('all')
  const [filterType, setFilterType] = useState<string>('all')
  const [filterTag, setFilterTag] = useState<string>('all')
  const allTags = useMemo(()=>{
    const m = new Map<string, number>()
    for(const c of customers) for(const t of (c.tags || [])) m.set(t, (m.get(t) || 0) + 1)
    return [...m.entries()].sort((a,b)=> b[1]-a[1])
  },[customers])
  const [minRepurchase, setMinRepurchase] = useState(0)
  const [days, setDays] = useState(7)
  const [preview, setPreview] = useState('')
  const [selectedTemplate, setSelectedTemplate] = useState(FOLLOW_UP_TEMPLATES[0])
  const [customSubject, setCustomSubject] = useState('')
  const [customBody, setCustomBody] = useState('')
  const [useCustom, setUseCustom] = useState(false)
  const [aiTplLoading, setAiTplLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [sendProgress, setSendProgress] = useState({ done: 0, total: 0, errors: 0 })
  const [campaignHistory, setCampaignHistory] = useState<CampaignRecord[]>([])
  // 复购
  const [silentDays, setSilentDays] = useState(90)
  const [reorderPool, setReorderPool] = useState<any[]>([])
  const [reorderLoading, setReorderLoading] = useState(false)
  // 日历
  const [holidays, setHolidays] = useState<Array<{date:string;name:string}>>([])
  const [holidaySource, setHolidaySource] = useState('')
  const [bulkFollow, setBulkFollow] = useState(() => localStorage.getItem('evan:bulkFollow') !== '0')
  const [bulkMarketing, setBulkMarketing] = useState(() => localStorage.getItem('evan:bulkMarketing') !== '0')
  const [bulkFollowTime, setBulkFollowTime] = useState(() => localStorage.getItem('evan:bulkFollowTime') || '09:30')
  const [bulkMarketingTime, setBulkMarketingTime] = useState(() => localStorage.getItem('evan:bulkMarketingTime') || '10:00')

  useEffect(() => localStorage.setItem('evan:bulkFollow', bulkFollow ? '1' : '0'), [bulkFollow])
  useEffect(() => localStorage.setItem('evan:bulkMarketing', bulkMarketing ? '1' : '0'), [bulkMarketing])
  useEffect(() => localStorage.setItem('evan:bulkFollowTime', bulkFollowTime), [bulkFollowTime])
  useEffect(() => localStorage.setItem('evan:bulkMarketingTime', bulkMarketingTime), [bulkMarketingTime])

  useEffect(() => {
    ;(async () => {
      setCustomers(await db.customers.toArray() as Customer[])
      // 从 IndexedDB 加载 Campaign 历史
      try {
        const saved = await db.appState.get('evan:campaignHistory')
        if (saved?.data) setCampaignHistory(saved.data)
      } catch {}
    })()
  }, [])

  const filtered = customers.filter(c => {
    if (filterLevel !== 'all' && c.level !== filterLevel) return false
    if (filterStage !== 'all' && c.stage !== filterStage) return false
    if (filterType !== 'all' && c.customerType !== filterType) return false
    if (filterTag !== 'all' && !(c.tags || []).includes(filterTag)) return false
    if ((c.repurchaseCount || 0) < minRepurchase) return false
    const last = new Date(c.updatedAt).getTime()
    const cutoff = Date.now() - days * 86400000
    return last < cutoff
  })

  const toggle = (id: string) => setSelected(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const toggleAll = () => setSelected(filtered.length === selected.size ? new Set() : new Set(filtered.map(c => c.id)))

  // 当前生效模板（预设或自定义/AI）
  const activeTemplate = useCustom
    ? { id: 'custom', name: '自定义', subject: customSubject, body: customBody }
    : selectedTemplate

  // ====== AI 生成营销模板 ======
  const handleAiTemplate = useCallback(async (occasion: string) => {
    setAiTplLoading(true)
    try{
      const r = await chatOnce(`你是Maxemblem外贸营销文案。写一封英文营销邮件，场合：${occasion}。要求：主题行单独第一行以Subject:开头，正文简短有行动召唤，变量用{{first_name}} {{company}} {{product}}，落款Evan。只返回主题+正文。`)
      if(!r || r.startsWith('⚠️')) return alert(r || 'AI 生成失败，请检查 AI 设置')
      const lines = r.trim().split('\n')
      let subj = '', body = r.trim()
      const si = lines.findIndex(l=> /^subject\s*:/i.test(l.trim()))
      if(si >= 0){ subj = lines[si].replace(/^subject\s*:/i,'').trim(); body = [...lines.slice(0,si), ...lines.slice(si+1)].join('\n').trim() }
      setCustomSubject(subj || `${occasion} from Maxemblem`)
      setCustomBody(body)
      setUseCustom(true)
    }catch(e:any){ alert('AI 生成失败：' + String(e.message||e).slice(0,150)) }
    finally{ setAiTplLoading(false) }
  }, [])

  // ====== 模板变量替换 ======
  const renderTemplate = (template: string, customer: Customer): string => {
    const firstName = (customer.contactName || customer.title || '').split(' ')[0] || 'there'
    return template
      .replace(/\{\{first_name\}\}/g, firstName)
      .replace(/\{\{last_name\}\}/g, (customer.contactName || '').split(' ').slice(1).join(' ') || '')
      .replace(/\{\{company\}\}/g, customer.company || 'your company')
      .replace(/\{\{product\}\}/g, customer.portrait?.products?.[0] || 'Challenge Coin')
      .replace(/\{\{level\}\}/g, customer.level || 'C')
      .replace(/\{\{email\}\}/g, customer.email || '')
  }

  // ====== AI 差异化生成 ======
  const gen = useCallback(async () => {
    if (selected.size === 0) return alert('请先选择客户')
    const selectedCustomers = filtered.filter(c => selected.has(c.id))
    // 为每个客户生成差异化内容
    const parts = selectedCustomers.slice(0, 5).map(c => {
      const name = c.contactName || c.title || 'there'
      const level = c.level || 'C'
      const product = c.portrait?.products?.[0] || 'Challenge Coin'
      if (level === 'A+' || level === 'A') {
        return `${name}（${level}级·${product}客户）：个性化报价+优先交期`
      }
      return `${name}（${level}级）：标准跟进+新品推荐`
    })
    setPreview(`为 ${selectedCustomers.length} 位客户生成差异化邮件：\n\n${parts.join('\n')}\n\n使用模板：${activeTemplate.name}\n支持变量：{{first_name}} {{company}} {{product}} {{level}}`)
  }, [selected, filtered, activeTemplate])

  // ====== 发送（direct=立即直发，queue=进发件队列一人一封/群发单显）======
  const customerById = useMemo(()=>{
    const m = new Map<string, Customer>()
    for(const c of customers) m.set(c.id, c)
    for(const p of reorderPool){
      if(!m.has(p.customerId)) m.set(p.customerId, {
        id: p.customerId, type:'customer', title: p.title, contactName: p.title, company: p.company,
        email: p.email, stage:'won', level: p.level, isKey: p.isKey, customerType:'Company',
        portrait: { products: p.products || [] }, repurchaseCount: p.repurchaseCount || 0,
        createdAt:'', updatedAt:'',
      } as any)
    }
    return m
  },[customers, reorderPool])
  const doSend = useCallback(async (ids: string[], mode: 'direct' | 'queue') => {
    const list = ids.map(id=> customerById.get(id)).filter(Boolean) as Customer[]
    if (list.length === 0) return alert('请先选择客户')
    const ok = confirm(`确认向 ${list.length} 位客户${mode === 'queue' ? '排队发送（一人一封，后台自动发出）' : '立即发送'}？`)
    if (!ok) return

    setSending(true)
    setSendProgress({ done: 0, total: list.length, errors: 0 })
    const accounts = await listAccounts()
    const acc = accounts[0]
    if (!acc) { alert('无可用邮箱账号'); setSending(false); return }

    const newHistory: CampaignRecord[] = []
    let errors = 0

    for (let i = 0; i < list.length; i++) {
      const c = list[i]
      setSendProgress({ done: i, total: list.length, errors })
      try {
        const subject = renderTemplate(activeTemplate.subject, c)
        const body = renderTemplate(activeTemplate.body, c)
        if (mode === 'queue') {
          await enqueueMail(acc.id, c.email || '', subject, body, `camp-${Date.now()}-${c.id}`, true)
          newHistory.push({ id: `camp-${Date.now()}-${i}`, customerId: c.id, customerEmail: c.email || '',
            templateId: activeTemplate.id, sentAt: new Date().toISOString(), status: 'sent' })
        } else {
          const result = await sendEmail(acc.id, c.email || '', subject, body)
          if (result.ok) {
            const { uid } = await import('../repositories/result')
            await db.emails.put({
              id: uid(), accountId: acc.id, folder: 'sent',
              from: acc.email, to: c.email || '', subject,
              text: body, html: '', date: new Date().toISOString(),
              isRead: true, hasAttachment: false,
              customerId: c.id, intent: '营销邮件', product: activeTemplate.name,
            } as any)
            newHistory.push({
              id: `camp-${Date.now()}-${i}`,
              customerId: c.id,
              customerEmail: c.email || '',
              templateId: activeTemplate.id,
              sentAt: new Date().toISOString(),
              status: 'sent',
              messageId: result.messageId,
            })
          }
        }
        // 自动创建跟进记录，3天后跟进
        const dueAt = new Date(Date.now() + 3 * 86400000).toISOString()
        await db.followUps.put({
          id: `fu-camp-${Date.now()}-${i}`,
          customerId: c.id,
          dueAt,
          channel: ['campaign'],
          note: `批量营销: ${activeTemplate.name}`,
          status: 'sent',
          createdAt: new Date().toISOString(),
        } as any)
        await db.customers.update(c.id, {
          updatedAt: new Date().toISOString(),
          lastContactAt: new Date().toISOString(),
          followUpAt: dueAt.slice(0, 10),
        } as any)
      } catch (e) {
        errors++
        setSendProgress(prev => ({ ...prev, errors }))
      }
      if (mode === 'direct') await new Promise(r => setTimeout(r, 1000))
    }

    const allHistory = [...campaignHistory, ...newHistory]
    setCampaignHistory(allHistory)
    await db.appState.put({ key: 'evan:campaignHistory', data: allHistory })

    setSendProgress({ done: list.length, total: list.length, errors })
    setSending(false)
    alert(mode === 'queue' ? `已入队 ${list.length} 封，后台自动发出（发件箱可查）` : `发送完成！成功 ${list.length} 封，失败 ${errors} 封`)
  }, [activeTemplate, campaignHistory, customerById])

  // ====== 真实批量发送（保留直发）======
  const handleSend = useCallback(async () => {
    await doSend([...selected], 'direct')
  }, [doSend, selected])
  const handleQueueSend = useCallback(async () => {
    await doSend([...selected], 'queue')
  }, [doSend, selected])

  // ====== 复购池 / 日历加载 ======
  const loadReorder = useCallback(async () => {
    setReorderLoading(true)
    try{
      const j = await getRepurchasePool(silentDays)
      setReorderPool(j.pool || [])
    }catch(e:any){ alert('复购池加载失败：' + String(e.message||e).slice(0,120)) }
    finally{ setReorderLoading(false) }
  }, [silentDays])
  const loadHolidays = useCallback(async () => {
    try{
      const j = await getHolidays(new Date().getFullYear())
      setHolidays(j.holidays || [])
      setHolidaySource(j.source === 'live' ? '联网已确认' : '缓存/内置')
    }catch{}
  }, [])
  useEffect(()=>{ if(tab === 'calendar' && !holidays.length) void loadHolidays() },[tab, holidays.length, loadHolidays])

  // 下三个固定档期
  const fixedSlots = useMemo(() => {
    const out: Array<{ date: string; name: string }> = []
    const now = new Date()
    for(let m = 0; m < 3; m++){
      const base = new Date(now.getFullYear(), now.getMonth() + m, 1)
      for(const [d, name] of [[1,'月初营销'],[15,'月中营销'],[28,'月底营销']] as const){
        const dt = new Date(base.getFullYear(), base.getMonth(), d)
        if(dt >= new Date(now.toDateString())) out.push({ date: dt.toISOString().slice(0,10), name })
      }
    }
    return out.sort((a,b)=> a.date < b.date ? -1 : 1).slice(0, 9)
  }, [])

  // ====== 统计 ======
  const stats = {
    total: campaignHistory.length,
    sent: campaignHistory.filter(c => c.status === 'sent').length,
    opened: campaignHistory.filter(c => c.status === 'opened').length,
    replied: campaignHistory.filter(c => c.status === 'replied').length,
    bounced: campaignHistory.filter(c => c.status === 'bounced').length,
  }

  return (
    <div className="p-4 max-w-6xl mx-auto space-y-4">
      <div className="flex items-center gap-2">
        <Users size={20} className="text-purple-500" />
        <h1 className="text-xl font-bold">批量跟进 / 营销活动</h1>
        <span className="text-xs text-gray-400">Campaign Builder · 真实发送 + 效果追踪</span>
        <div className="ml-auto flex gap-1">
          {([['blast','📣 群发'],['reorder','🔁 复购激活'],['calendar','📅 营销日历']] as const).map(([k,l])=>(
            <button key={k} onClick={()=> setTab(k)} className={`px-3 py-1 rounded-full text-xs ${tab===k?'bg-purple-600 text-white':'bg-white border text-gray-500'}`}>{l}</button>
          ))}
        </div>
      </div>

      {tab === 'calendar' ? (
        <div className="bg-white rounded-2xl border p-4 space-y-3">
          <div className="flex items-center gap-2">
            <CalendarDays size={16} className="text-purple-500" />
            <span className="text-sm font-semibold">营销日历</span>
            <span className="text-[10px] text-gray-400">美国节假日{holidaySource ? `（${holidaySource}）` : ''}</span>
            <button onClick={loadHolidays} className="ml-auto px-2 py-1 text-xs border rounded-lg">刷新节假日</button>
          </div>
          <div>
            <div className="text-xs font-semibold text-gray-600 mb-1">固定档期（月初/月中/月底）</div>
            <div className="grid md:grid-cols-3 gap-1.5">
              {fixedSlots.map(s=>(
                <div key={s.date+s.name} className="flex items-center gap-2 p-2 border rounded-xl text-xs">
                  <span className="font-mono">{s.date}</span><span>{s.name}</span>
                  <button onClick={()=>{ setTab('blast'); handleAiTemplate(s.name) }} className="ml-auto px-2 py-0.5 bg-purple-50 text-purple-600 border border-purple-200 rounded-lg text-[11px]">AI写模板</button>
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="text-xs font-semibold text-gray-600 mb-1">美国节假日（前7天自动备战）</div>
            <div className="grid md:grid-cols-3 gap-1.5 max-h-[300px] overflow-y-auto">
              {holidays.filter(h=> h.date >= new Date().toISOString().slice(0,10)).slice(0,12).map(h=>(
                <div key={h.date} className="flex items-center gap-2 p-2 border rounded-xl text-xs">
                  <span className="font-mono">{h.date}</span><span className="truncate">{h.name}</span>
                  <button onClick={()=>{ setTab('blast'); handleAiTemplate(h.name) }} className="ml-auto px-2 py-0.5 bg-purple-50 text-purple-600 border border-purple-200 rounded-lg text-[11px] shrink-0">AI写模板</button>
                </div>
              ))}
              {holidays.length===0 && <div className="text-xs text-gray-300">加载中…</div>}
            </div>
          </div>
        </div>
      ) : tab === 'reorder' ? (
        <div className="bg-white rounded-2xl border p-4 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Repeat size={16} className="text-green-600" />
            <span className="text-sm font-semibold">复购激活池</span>
            <span className="text-[10px] text-gray-400">已下单且近期无往来 → 激活促单</span>
            <label className="text-xs text-gray-500 ml-auto">静默超过
              <select value={silentDays} onChange={e=> setSilentDays(Number(e.target.value))} className="mx-1 px-2 py-1 border rounded text-xs">
                <option value={30}>30天</option><option value={60}>60天</option><option value={90}>90天</option><option value={180}>180天</option>
              </select>
            </label>
            <button onClick={loadReorder} disabled={reorderLoading} className="px-3 py-1 bg-green-600 text-white rounded text-xs disabled:opacity-50">{reorderLoading?'筛选中…':'筛选'}</button>
          </div>
          <div className="text-xs text-gray-400">共 {reorderPool.length} 位沉睡已下单客户 · 勾选后切回「群发」页发送（已自动同步勾选）</div>
          <div className="max-h-[380px] overflow-y-auto divide-y">
            {reorderPool.map((p:any)=>(
              <label key={p.customerId} className="flex items-center gap-2 p-2 text-xs cursor-pointer hover:bg-gray-50">
                <input type="checkbox" checked={selected.has(p.customerId)} onChange={()=>{
                  setSelected(s=>{ const n = new Set(s); if(n.has(p.customerId)) n.delete(p.customerId); else n.add(p.customerId); return n })
                }} />
                <span className="font-medium">{p.title}</span>
                <span className="text-gray-400 truncate">{p.company} · {p.email}</span>
                <span className="ml-auto text-gray-400 shrink-0">静默{p.silentDays}天 · 复购{p.repurchaseCount||0}次 · {Array.isArray(p.products)?p.products.join('/'):''}</span>
              </label>
            ))}
            {reorderPool.length===0 && <div className="p-6 text-center text-xs text-gray-300">点筛选，找出沉睡的已下单客户</div>}
          </div>
        </div>
      ) : (
      <>
      {/* 筛选 + 操作 */}
      <div className="bg-white rounded-2xl border p-3 space-y-2">
        <div className="flex flex-wrap gap-2 items-center">
          <Filter size={14} className="text-gray-400" />
          <select value={filterLevel} onChange={e => setFilterLevel(e.target.value)} className="px-2 py-1 border rounded text-xs">
            <option value="all">全部等级</option><option value="A+">A+</option><option value="A">A</option><option value="B">B</option><option value="C">C</option>
          </select>
          <select value={filterStage} onChange={e => setFilterStage(e.target.value)} className="px-2 py-1 border rounded text-xs">
            <option value="all">全部阶段</option><option value="lead">新线索</option><option value="contacted">已联系</option><option value="qualified">已确认</option><option value="proposal">报价中</option><option value="negotiation">谈判中</option><option value="won">已下单</option><option value="lost">流失</option>
          </select>
          <select value={filterType} onChange={e => setFilterType(e.target.value)} className="px-2 py-1 border rounded text-xs">
            <option value="all">全部类型</option><option value="Company">企业</option><option value="Government">政府</option><option value="School">学校</option><option value="End Customer">个人</option><option value="Distributor">经销商</option>
          </select>
          <select value={filterTag} onChange={e => setFilterTag(e.target.value)} className="px-2 py-1 border rounded text-xs">
            <option value="all">全部标签</option>
            {allTags.map(([t,n])=> <option key={t} value={t}>{t} ({n})</option>)}
          </select>
          <label className="text-xs text-gray-500">复购≥<input type="number" min={0} value={minRepurchase} onChange={e=> setMinRepurchase(Number(e.target.value)||0)} className="w-12 px-1 py-0.5 border rounded text-xs" /></label>
          <select value={days} onChange={e => setDays(Number(e.target.value))} className="px-2 py-1 border rounded text-xs">
            <option value={7}>7天未联系</option><option value={14}>14天</option><option value={30}>30天</option><option value={90}>90天</option>
          </select>
          <span className="text-xs text-gray-400">{filtered.length} 人命中</span>
          <button onClick={toggleAll} className="ml-auto px-3 py-1 bg-white border rounded text-xs">{selected.size === filtered.length ? '取消全选' : '全选'}</button>
          <button onClick={gen} disabled={!bulkFollow && !bulkMarketing} className="px-3 py-1 bg-purple-600 text-white rounded text-xs flex items-center gap-1 disabled:opacity-40"><Sparkles size={12} /> AI 批量差异化生成</button>
        </div>
        {/* 模板选择 + AI 生成 */}
        <div className="flex flex-wrap gap-1.5 items-center">
          {FOLLOW_UP_TEMPLATES.map(t => (
            <button key={t.id} onClick={() => { setSelectedTemplate(t); setUseCustom(false) }} className={`px-2 py-1 rounded-full text-[11px] border ${!useCustom && selectedTemplate.id === t.id ? 'bg-purple-50 border-purple-300 text-purple-700' : 'bg-white text-gray-500'}`}>{t.name}</button>
          ))}
          <button onClick={()=> setUseCustom(v=>!v)} className={`px-2 py-1 rounded-full text-[11px] border ${useCustom?'bg-green-50 border-green-300 text-green-700':'bg-white text-gray-500'}`}>✏️ 自定义</button>
          <button onClick={()=> handleAiTemplate('季节性促销')} disabled={aiTplLoading} className="px-2 py-1 rounded-full text-[11px] border bg-white text-gray-500 disabled:opacity-40">✨ AI写模板{aiTplLoading?'…':''}</button>
        </div>
        {useCustom && (
          <div className="grid md:grid-cols-2 gap-2">
            <input value={customSubject} onChange={e=> setCustomSubject(e.target.value)} placeholder="自定义主题" className="px-2 py-1 border rounded text-xs" />
            <textarea value={customBody} onChange={e=> setCustomBody(e.target.value)} placeholder="自定义正文（支持{{first_name}} {{company}} {{product}} {{level}}）" rows={3} className="px-2 py-1 border rounded text-xs resize-y md:col-span-2" />
          </div>
        )}
        {/* 定时配置 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <label className="flex items-center justify-between p-2 bg-gray-50 rounded-xl border">
            <span className="text-xs font-medium">批量跟进</span>
            <span className="flex items-center gap-2">
              <input type="time" value={bulkFollowTime} onChange={e => setBulkFollowTime(e.target.value)} className="px-2 py-1 border rounded text-xs" />
              <input type="checkbox" checked={bulkFollow} onChange={e => setBulkFollow(e.target.checked)} className="accent-blue-600" />
            </span>
          </label>
          <label className="flex items-center justify-between p-2 bg-gray-50 rounded-xl border">
            <span className="text-xs font-medium">批量营销</span>
            <span className="flex items-center gap-2">
              <input type="time" value={bulkMarketingTime} onChange={e => setBulkMarketingTime(e.target.value)} className="px-2 py-1 border rounded text-xs" />
              <input type="checkbox" checked={bulkMarketing} onChange={e => setBulkMarketing(e.target.checked)} className="accent-purple-600" />
            </span>
          </label>
        </div>
      </div>

      {/* 客户列表 + 预览 */}
      <div className="grid lg:grid-cols-[1fr_380px] gap-3">
        <div className="bg-white rounded-2xl border overflow-hidden">
          <div className="px-3 py-2 border-b text-xs font-semibold text-gray-600 flex items-center gap-2">
            <span>客户列表</span>
            <span className="text-gray-400">已选 {selected.size} 人</span>
          </div>
          <div className="max-h-[420px] overflow-y-auto">
            {filtered.map(c => (
              <label key={c.id} className="flex items-center gap-2 p-2 border-b hover:bg-gray-50 text-xs cursor-pointer">
                <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                <span className={`w-5 h-5 rounded-full bg-gradient-to-br from-blue-400 to-purple-500 flex items-center justify-center text-white text-[9px] font-bold shrink-0`}>{(c.contactName || c.title || '?')[0].toUpperCase()}</span>
                <span className="font-medium truncate">{c.contactName || c.title}</span>
                <span className="text-gray-400 truncate">{c.company}</span>
                <span className="ml-auto px-1.5 py-0.5 bg-gray-100 rounded text-[10px]">{c.level || 'C'}</span>
                <span className="text-gray-300 text-[10px] truncate">{c.email}</span>
              </label>
            ))}
            {filtered.length === 0 && <div className="p-8 text-center text-xs text-gray-300">无匹配客户</div>}
          </div>
        </div>

        <div className="space-y-3">
          {/* 预览 + 发送 */}
          <div className="bg-white rounded-2xl border p-3">
            <div className="text-xs font-semibold mb-1">邮件预览（模板：{activeTemplate.name}）</div>
            <div className="text-[10px] text-gray-400 mb-2">变量：{'{{first_name}}'} {'{{company}}'} {'{{product}}'} {'{{level}}'}</div>
            <textarea value={preview} onChange={e => setPreview(e.target.value)} placeholder="点击 AI 生成 或直接编辑模板内容..." className="w-full h-40 p-2 border rounded text-xs resize-none" />
            <div className="flex gap-1 mt-2">
              <button onClick={handleSend} disabled={sending || selected.size === 0} className="flex-1 py-2 bg-blue-600 text-white rounded text-xs flex items-center justify-center gap-1 disabled:opacity-50">
                {sending ? `发送中 ${sendProgress.done}/${sendProgress.total}...` : <><Send size={12} /> 立即发送 ({selected.size})</>}
              </button>
              <button onClick={handleQueueSend} disabled={sending || selected.size === 0} title="一人一封进发件队列，失败自动重试（群发单显）" className="flex-1 py-2 bg-green-50 text-green-600 border border-green-200 rounded text-xs disabled:opacity-50">
                ⏳ 排队群发 ({selected.size})
              </button>
            </div>
            {sending && (
              <div className="mt-2">
                <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${Math.min(100, Math.round(sendProgress.done / sendProgress.total * 100))}%` }} />
                </div>
              </div>
            )}
          </div>

          {/* 效果追踪 */}
          <div className="bg-white rounded-2xl border p-3">
            <div className="text-xs font-semibold mb-2 flex items-center gap-1"><MousePointerClick size={12} /> 效果追踪</div>
            <div className="grid grid-cols-4 gap-1.5 text-center">
              <div className="bg-blue-50 rounded-lg p-2"><div className="text-sm font-bold text-blue-600">{stats.sent}</div><div className="text-[9px] text-gray-500">已发送</div></div>
              <div className="bg-green-50 rounded-lg p-2"><div className="text-sm font-bold text-green-600">{stats.opened}</div><div className="text-[9px] text-gray-500">已打开</div></div>
              <div className="bg-purple-50 rounded-lg p-2"><div className="text-sm font-bold text-purple-600">{stats.replied}</div><div className="text-[9px] text-gray-500">已回复</div></div>
              <div className="bg-red-50 rounded-lg p-2"><div className="text-sm font-bold text-red-600">{stats.bounced}</div><div className="text-[9px] text-gray-500">退信</div></div>
            </div>
            {stats.total > 0 && (
              <div className="mt-2 text-[10px] text-gray-400">
                回复率 {stats.total > 0 ? Math.round(stats.replied / stats.total * 100) : 0}% · 
                打开率 {stats.total > 0 ? Math.round(stats.opened / stats.total * 100) : 0}%
              </div>
            )}
          </div>
        </div>
      </div>
      </>
      )}
    </div>
  )
}
