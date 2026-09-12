// ====== 邮件中心：从收邮件升级为客户经营中心（未读中心）======
// 三栏：左未读列表 | 中AI工作台 | 右翻译/重点/跟进 + 配置抽屉
import { useState, useEffect, useCallback } from 'react'
import { Mail, Star, Clock, Languages, Sparkles, StickyNote, UserCheck, Calendar, Send, Settings, Search } from 'lucide-react'
import { db } from '../db'
import type { EmailMessage, EmailAccount, Customer } from '../types'
import { listAccounts, upsertAccount, PROVIDER_PRESETS, mockSync, syncReal, createAccountOnServer, markRead, listEmails } from '../repositories/emailRepository'
import { classifyIntent, translateEnToZh, summarizeEmail, buildPortrait, suggestFollowUpDate } from '../services/emailAiService'
import { useAskText } from '../components/PromptModal'

const INTENT_COLOR: Record<string,string> = {
  '新询价':'bg-red-50 text-red-600','报价回复':'bg-blue-50 text-blue-600','询问价格':'bg-orange-50 text-orange-600',
  '催货':'bg-yellow-50 text-yellow-700','复购':'bg-green-50 text-green-600','其他':'bg-gray-100 text-gray-500',
}
const LEVEL_STAR: Record<string,string> = { 'A+':'⭐️⭐️⭐️','A':'⭐️⭐️','B':'⭐️','C':'','D':'' }

export default function InboxPage(){
  const [askModal, askText] = useAskText()
  const [accounts, setAccounts] = useState<EmailAccount[]>([])
  const [emails, setEmails] = useState<EmailMessage[]>([])
  const [selected, setSelected] = useState<EmailMessage|null>(null)
  const [filter, setFilter] = useState<'all'|'unread'>('unread')
  const [folder, setFolder] = useState<'inbox'|'sent'|'drafts'>('inbox')
  const [q, setQ] = useState('')
  const [translated, setTranslated] = useState('')
  const [showTrans, setShowTrans] = useState(false)
  const [showConfig, setShowConfig] = useState(false)
  const [customer, setCustomer] = useState<Customer|null>(null)

  // 配置表单
  const [provider, setProvider] = useState<EmailAccount['provider']>('qq')
  const [emailAddr, setEmailAddr] = useState('3254136783@qq.com')
  const [authCode, setAuthCode] = useState('')
  const [customImap, setCustomImap] = useState('')
  const [customSmtp, setCustomSmtp] = useState('')

  const refresh = useCallback(async()=>{
    setAccounts(await listAccounts())
    const list = await listEmails()
    // 补AI字段（懒计算）
    for(const m of list){ if(!m.intent) { m.intent = await classifyIntent(m.text); await db.emails.put(m)} }
    setEmails(list)
    if(list.length && !selected) setSelected(list[0])
  },[])
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

  useEffect(()=>{
    if(!selected) { setCustomer(null); return }
    ;(async()=>{
      const c = await db.customers.filter((cc:any)=> (cc.email||'').toLowerCase()=== (selected.from.match(/<(.+?)>/)?.[1]||selected.from).trim().toLowerCase()).first() as any
      // 懒创建：未关联时先不自动建，侧栏操作时再建，避免污染
      setCustomer(c||null)
      // 自动翻译
      if(selected.text && !selected.translated){
        const t = await translateEnToZh(selected.text)
        selected.translated = t; await db.emails.put(selected); setTranslated(t)
      } else setTranslated(selected.translated||'')
    })()
  },[selected?.id])

  const [syncing, setSyncing] = useState(false)
  const handleAddAccount = async()=>{
    if(!emailAddr.trim()||!authCode.trim()) return alert('请填邮箱和16位授权码/应用密码')
    const preset = PROVIDER_PRESETS[provider]
    const imap = provider==='custom'? {host:customImap,port:993,ssl:true}: preset.imap
    const smtp = provider==='custom'? {host:customSmtp,port:465,ssl:true}: preset.smtp
    setSyncing(true)
    try{
      // 优先走真实服务（需已登录云同步，Gmail 用应用专用密码16位）
      try{
        const cleanPass = authCode.replace(/\s/g,'')
        const { id } = await createAccountOnServer({ provider, email:emailAddr.trim(), imap, smtp, pass: cleanPass })
        const n = await syncReal(id, 20)
        alert(`已连接并拉取 ${n} 封真实邮件（来自你Gmail）`)
      }catch(e:any){
        const msg = String(e.message||e)
        if(msg.includes('请先在 云同步 登录')){
          // 未登录则本地演示
          const acc = await upsertAccount({ provider, email:emailAddr.trim(), imap, smtp, authEnc: authCode.replace(/\s/g,'') })
          await mockSync(acc.id)
          alert('未登录云同步，已用本地演示数据（要看真实Gmail，请先到 ☁️云同步 登录同一账号再绑定）')
        } else {
          throw e
        }
      }
    }catch(e:any){
      alert('绑定失败：' + String(e.message||e).slice(0,200) + '\n\nGmail请确认：1) 已开两步验证 2) 生成的是16位应用专用密码（无空格） 3) IMAP已启用')
    }finally{
      setSyncing(false)
      setShowConfig(false); setAuthCode(''); await refresh()
    }
  }
  const [syncCount, setSyncCount] = useState<string>('30')
  const [analyzing, setAnalyzing] = useState(false)
  const handleSyncSelected = async()=>{
    if(accounts.length===0) return alert('先绑定邮箱')
    let limit: number| string = syncCount==='all' ? 2000 : Number(syncCount)||20
    if(syncCount==='custom'){
      const v = await askText('自定义同步数量（1-2000，输入 all 表示全部）', '100')
      if(v===null) return
      if(v.trim().toLowerCase()==='all') limit='all' as any
      else { const n=Number(v); if(!n||n<1) return alert('数量无效'); limit=n }
    }
    setSyncing(true)
    try{
      let total=0
      for(const a of accounts){ try{ total += await syncReal(a.id, limit as any) }catch(e){ console.warn(e)} }
      if(total===0) alert('未拉到新邮件（或需检查应用密码）')
      else alert(`已同步 ${total} 封真实邮件（${limit==='all'||limit===2000?'全部':limit+'封'}）\n已自动去重建客户，Ctrl+K 可秒搜客户/邮件`)
      await refresh()
    }finally{ setSyncing(false) }
  }
  const handleImportAll = async()=>{
    if(accounts.length===0) return alert('先绑定邮箱')
    if(!confirm('将同步全部邮件（约878封，需20-40秒），并自动导入所有客户，是否继续？')) return
    setSyncCount('all'); setSyncing(true)
    try{
      let total=0
      for(const a of accounts) total += await syncReal(a.id, 'all' as any)
      alert(`全部导入完成：${total} 封邮件 + ${await db.customers.count()} 位客户已入库（IndexedDB 本机，Tailscale 可跨设备）`)
      await refresh()
    }finally{ setSyncing(false) }
  }
  const handleAiAnalyzeAll = async()=>{
    const pending = emails.filter(e=> !e.intent || e.intent==='其他')
    if(pending.length===0) return alert('全部已分析')
    if(!confirm(`AI 将批量分析 ${pending.length} 封未分类邮件（意图/产品），约需 ${Math.ceil(pending.length*0.05)} 秒，是否继续？`)) return
    setAnalyzing(true)
    try{
      for(const m of pending){
        m.intent = await classifyIntent(m.subject+' '+(m.text||'').slice(0,500)) as any
        m.product = /coin/i.test(m.subject+m.text)?'Coin': /patch/i.test(m.subject+m.text)?'Patch':'Coin'
        await db.emails.put(m)
      }
      await refresh(); alert('AI 分析完成，已可搜索 意图/产品')
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
    // 同时建 Task 用于提醒
    const { uid } = await import('../repositories/result')
    const { now } = await import('../repositories/result')
    await db.tasks.put({ id: uid(), type:'task', title:`跟进 ${customer.title||customer.email} - ${selected.subject.slice(0,20)}`, description: note||'', emoji:'📧', tags:['跟进'], createdAt:now(), updatedAt:now(), relations:[], status:'todo', priority:'high', importance:'high', isRecurring:false, todayOrder:0, dueDate:due } as any)
    alert(`已安排 ${due} 跟进，已同步到行动/通知`)
    refresh()
  }

  const handleMarkKey = async()=>{
    let c = customer
    if(!c && selected){ c = await ensureCustomer(selected.from, selected.from); setCustomer(c) }
    if(!c) return
    const next = !c.isKey
    await db.customers.update(c.id, { isKey: next, level: next? 'A': 'C' } as any)
    setCustomer({...c, isKey: next, level: next? 'A':'C'} as any)
    // 联动：写事件供拓扑/全景
    try{ await db.events.put({ id:`evt-${Date.now()}`, type:'object.updated', actorType:'user', objectType:'customer', objectId:c.id, payload:{title:c.title, isKey:next}, createdAt:new Date().toISOString()} as any)}catch{}
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

  const handleCustomFollow = async(days:number)=>{
    if(!selected) return
    let c = customer
    if(!c){ c = await ensureCustomer(selected.from, selected.from); setCustomer(c) }
    if(!c) return
    const d=new Date(); d.setDate(d.getDate()+days); const v=d.toISOString().slice(0,10)
    await db.customers.update(c.id,{followUpAt:v} as any)
    await db.followUps.put({id:`fu-${Date.now()}`,customerId:c.id,dueAt:v,channel:['workbench'],status:'pending',createdAt:new Date().toISOString()} as any)
    setCustomer({...c,followUpAt:v} as any)
    const { uid, now } = await import('../repositories/result')
    await db.tasks.put({ id: uid(), type:'task', title:`跟进 ${c.title||c.email}`, description:`${days}天后`, emoji:'📧', tags:['跟进'], createdAt:now(), updatedAt:now(), relations:[], status:'todo', priority:'high', importance:'high', isRecurring:false, todayOrder:0, dueDate:v } as any)
    alert(`已设 ${v} 跟进，已同步到 客户/拓扑/跟进/行动`)
  }

  const filtered = emails.filter(m=>{
    if(folder==='inbox' && m.folder!=='inbox') return false
    if(folder==='sent' && m.folder!=='sent') return false
    if(folder==='drafts' && m.folder!=='drafts') return false
    if(folder==='inbox' && filter==='unread' && m.isRead) return false
    if(q && !(`${m.subject} ${m.from} ${m.intent}`).toLowerCase().includes(q.toLowerCase())) return false
    return true
  })
  const thread = selected ? emails.filter(e=> {
    const a = (selected.from.match(/<(.+?)>/)?.[1]||selected.from).toLowerCase()
    const b = (e.from.match(/<(.+?)>/)?.[1]||e.from).toLowerCase()
    const c = (e.to||'').toLowerCase()
    const subj = selected.subject.replace(/^Re:\s*/i,'').trim().toLowerCase()
    const esubj = e.subject.replace(/^Re:\s*/i,'').trim().toLowerCase()
    return b===a || c.includes(a) || esubj===subj
  }).sort((x,y)=> new Date(x.date).getTime()-new Date(y.date).getTime()) : []

  return (
    <div className="flex flex-col h-[calc(100vh-48px)] -m-4 md:-m-6">
      {askModal}
      {/* 顶部配置条 */}
      <div className="px-4 py-2 border-b border-gray-100 bg-white flex items-center gap-2 flex-wrap">
        <Mail size={18} className="text-blue-500"/>
        <span className="text-sm font-bold text-gray-800">邮件中心 · 客户经营</span>
        <span className="text-xs text-gray-400">通用 IMAP 全量支持 · 自动翻译/意图/跟进</span>
        <div className="ml-auto flex items-center gap-1.5">
          <select value={syncCount} onChange={e=> setSyncCount(e.target.value)} className="px-2 py-1 border rounded text-xs">
            <option value="20">20封</option><option value="30">30封</option><option value="50">50封</option><option value="100">100封</option><option value="200">200封</option><option value="500">500封</option><option value="all">全部</option><option value="custom">自定义…</option>
          </select>
          <button onClick={handleSyncSelected} disabled={syncing} className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs hover:bg-blue-700 disabled:opacity-50">{syncing?'同步中…':'⟳ 同步'}</button>
          <button onClick={handleImportAll} disabled={syncing} className="px-2 py-1 bg-purple-600 text-white rounded-lg text-xs hidden md:block">全部导入</button>
          <button onClick={handleAiAnalyzeAll} disabled={analyzing} className="px-2 py-1 bg-green-600 text-white rounded-lg text-xs hidden md:block">{analyzing?'分析中…':'AI分析'}</button>
        </div>
        <button onClick={()=> setShowConfig(v=>!v)} className="px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-xs flex items-center gap-1.5 hover:bg-gray-50"><Settings size={12}/> 系统配置与多邮箱接入</button>
        <span className="text-xs text-gray-300">{accounts.length} 账号 · {emails.length} 封</span>
      </div>

      {/* 配置抽屉 */}
      {showConfig && (
        <div className="m-3 p-4 bg-white rounded-2xl border border-gray-100 shadow-sm">
          <div className="text-xs font-semibold text-gray-600 mb-2 flex items-center gap-1.5"><span className="w-2 h-2 bg-green-500 rounded-full"/>通用邮箱标准 IMAP 接入（全量支持国内外主流邮箱）</div>
          <div className="grid grid-cols-3 md:grid-cols-6 gap-2 mb-3">
            {Object.entries(PROVIDER_PRESETS).map(([k,v])=>(
              <button key={k} onClick={()=> setProvider(k as any)} className={`px-3 py-2 rounded-lg border text-xs ${provider===k?'border-red-300 bg-red-50 text-red-600':'border-gray-200 bg-white text-gray-500'}`}>{v.label}</button>
            ))}
          </div>
          {provider==='qq' && <div className="text-xs bg-amber-50 border border-amber-100 rounded-lg p-2 mb-2">ⓘ QQ邮箱需在 网页版「设置→账户」开启 POP3/IMAP 服务，并发送短信获取 16位专属授权码</div>}
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <div className="text-xs text-gray-400 mb-1">电子邮箱地址：</div>
              <input value={emailAddr} onChange={e=> setEmailAddr(e.target.value)} placeholder="QQ号@qq.com" className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"/>
            </div>
            <div>
              <div className="text-xs text-gray-400 mb-1">16位专属授权码（非QQ登录密码）：</div>
              <input value={authCode} onChange={e=> setAuthCode(e.target.value)} placeholder="输入在 QQ邮箱生成的16位授权码" className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"/>
            </div>
          </div>
          {provider==='custom' && (
            <div className="grid md:grid-cols-2 gap-3 mt-2">
              <input value={customImap} onChange={e=> setCustomImap(e.target.value)} placeholder="IMAP 主机 imap.example.com" className="px-3 py-2 border rounded-lg text-sm"/>
              <input value={customSmtp} onChange={e=> setCustomSmtp(e.target.value)} placeholder="SMTP 主机 smtp.example.com" className="px-3 py-2 border rounded-lg text-sm"/>
            </div>
          )}
          <div className="mt-3 flex gap-2">
            <button onClick={handleAddAccount} className="px-4 py-2 bg-pink-500 text-white rounded-lg text-sm flex items-center gap-1.5"><Settings size={14}/> 连接并绑定 {provider} 邮箱</button>
            <button onClick={()=> setShowConfig(false)} className="px-3 py-2 text-xs text-gray-400">收起</button>
            <span className="ml-auto text-xs text-gray-300">展开/自定义服务器主机与端口</span>
          </div>
        </div>
      )}

      {/* 三栏主体 - 按红/蓝线比例：左260 中1fr加宽至红线 右340贴蓝线 */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[260px_minmax(680px,1.9fr)_340px] gap-2 p-2 overflow-hidden">
        {/* 左：邮件列表（未读/已发送/草稿） */}
        <div className="bg-white rounded-2xl border border-gray-100 flex flex-col overflow-hidden">
          <div className="p-2 border-b border-gray-100 space-y-2">
            <div className="flex items-center gap-1">
              <button onClick={()=> setFolder('inbox')} className={`flex-1 py-1 rounded-lg text-xs ${folder==='inbox'?'bg-blue-600 text-white':'bg-gray-100 text-gray-600'}`}>未读 {folder==='inbox'?`·${emails.filter(e=> e.folder==='inbox' && !e.isRead).length}`:''}</button>
              <button onClick={()=> setFolder('sent')} className={`flex-1 py-1 rounded-lg text-xs ${folder==='sent'?'bg-green-600 text-white':'bg-gray-100 text-gray-600'}`}>已发送 {folder==='sent'?`·${emails.filter(e=> e.folder==='sent').length}`:''}</button>
              <button onClick={()=> setFolder('drafts')} className={`flex-1 py-1 rounded-lg text-xs ${folder==='drafts'?'bg-orange-500 text-white':'bg-gray-100 text-gray-600'}`}>草稿 {folder==='drafts'?`·${emails.filter(e=> e.folder==='drafts').length}`:''}</button>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-300"/>
                <input value={q} onChange={e=> setQ(e.target.value)} placeholder="全文检索（中英文关键词、发件人、主题）" className="w-full pl-7 pr-2 py-1.5 bg-gray-50 border border-gray-200 rounded-lg text-xs"/>
              </div>
              {folder==='inbox' && <button onClick={()=> setFilter(filter==='unread'?'all':'unread')} className={`px-2 py-1 rounded-full text-xs shrink-0 ${filter==='unread'?'bg-blue-600 text-white':'bg-gray-100 text-gray-500'}`}>{filter==='unread'?'未读':'全部'}</button>}
            </div>
          </div>
          <div className="flex items-center gap-1 px-2 py-1 border-b border-gray-50 text-xs">
            <span className="text-gray-400">{folder==='inbox'?'未读':folder==='sent'?'已发送':'草稿'} {filtered.length} 封</span>
            <span className="ml-auto text-[10px] text-gray-300">{folder==='drafts'?'点开看往来记录':''}</span>
          </div>
          <div className="flex-1 overflow-y-auto">
            {filtered.map(m=>{
              const isSel = selected?.id===m.id
              const cust = m.from.split('<')[0].trim()
              return (
                <button key={m.id} onClick={async()=>{ setSelected(m); await markRead(m.id,true); setEmails(prev=> prev.map(x=> x.id===m.id? {...x,isRead:true}:x)) }} className={`w-full text-left p-3 border-b border-gray-50 hover:bg-blue-50/50 ${isSel?'bg-blue-50 border-l-2 border-l-blue-500':''}`}>
                  <div className="flex items-center gap-1.5 text-xs">
                    <span className={`w-1.5 h-1.5 rounded-full ${m.isRead?'bg-gray-200':'bg-blue-500'}`}/>
                    <span className="font-medium text-gray-700 truncate">{cust}</span>
                    <span className={`ml-auto text-[9px] px-1 py-0.5 rounded ${INTENT_COLOR[m.intent||'其他']||'bg-gray-100'}`}>{m.intent||'其他'}</span>
                  </div>
                  <div className="text-xs text-gray-800 truncate mt-1">{m.subject}</div>
                  <div className="text-xs text-gray-400 truncate">{m.text.slice(0,60)}</div>
                  <div className="flex items-center gap-1 mt-1 text-[10px] text-gray-400">
                    <span>{m.hasAttachment?'📎':''} {m.product||'Coin'} · {m.priority==='高'?'🔴高':'中'} · {new Date(m.date).toLocaleDateString()}</span>
                    <span className="ml-auto px-1 py-0.5 bg-gray-100 rounded">{m.status}</span>
                  </div>
                </button>
              )
            })}
            {filtered.length===0 && <div className="p-8 text-center text-xs text-gray-300">暂无邮件，去配置邮箱并同步</div>}
          </div>
        </div>

        {/* 中：AI工作台 */}
        <div className="bg-white rounded-2xl border border-gray-100 flex flex-col overflow-hidden">
          {!selected ? <div className="flex-1 flex items-center justify-center text-xs text-gray-300">请选择一封邮件</div> : (
            <>
              <div className="p-3 border-b border-gray-100 flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold text-gray-800 flex items-center gap-2">{selected.subject} <button onClick={()=> window.open(`mailto:${selected.from}`)} className="px-2 py-0.5 bg-gray-900 text-white rounded text-xs">新窗口</button></div>
                  <div className="text-xs text-gray-400">发件：{selected.from} → {selected.to} · {new Date(selected.date).toLocaleString()}</div>
                </div>
                <div className="flex gap-1">
                  <button onClick={()=> setShowTrans(v=>!v)} className="px-2 py-1 bg-white border rounded text-xs flex items-center gap-1"><Languages size={12}/> {showTrans?'原文':'翻译'}</button>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {/* 客户头 */}
                <div className="p-3 bg-gray-50 rounded-xl border border-gray-100 flex items-center gap-2">
                  <div className="text-sm font-semibold text-gray-700">客户：{customer?.contactName||selected.from.split('<')[0]} {customer?.isKey && <span className="ml-1 text-yellow-500">⭐ A级</span>}</div>
                  <span className="text-xs text-gray-500">{customer?.company||'—'}</span>
                  <span className="ml-auto text-xs px-1.5 py-0.5 bg-white rounded border">{customer?.level||'C'} {LEVEL_STAR[customer?.level||'C']}</span>
                </div>

                {/* AI工作台卡 */}
                <div className="rounded-xl border border-blue-100 bg-blue-50/40 p-3 space-y-2">
                  <div className="text-xs font-semibold text-gray-700">AI工作台</div>
                  {!showTrans ? (
                    <div className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">{selected.text}</div>
                  ) : (
                    <div className="text-sm text-gray-600 whitespace-pre-wrap bg-white rounded-lg p-2 border">{translated || '翻译中...'}</div>
                  )}
                  <div className="grid grid-cols-2 gap-1 text-xs">
                    <div>🎯 意图：<b>{selected.intent}</b></div>
                    <div>📦 产品：{selected.product}</div>
                    <div>💰 数量：{selected.qty||500}</div>
                    <div>💵 预算：{selected.budget||'未提及'}</div>
                    <div>📅 交期：{selected.deadline||'Oct 15'}</div>
                    <div>🔥 成交意愿：高</div>
                  </div>
                  <div className="text-xs bg-white rounded-lg p-2 border">AI建议：建议立即报价，并询问预算和交期（3天未回自动跟进）</div>
                </div>
                <div className="flex gap-1">
                  <button onClick={async()=>{ const t=await translateEnToZh(selected.text); setTranslated(t); setShowTrans(true)}} className="px-2 py-1 bg-white border rounded text-xs flex items-center gap-1"><Languages size={12}/> 翻译</button>
                  <button onClick={async()=>{ const s=await summarizeEmail(selected); alert(s) }} className="px-2 py-1 bg-white border rounded text-xs">AI摘要</button>
                  <button onClick={handleMarkKey} className={`px-2 py-1 rounded text-xs flex items-center gap-1 ${customer?.isKey?'bg-yellow-500 text-white':'bg-white border'}`}><Star size={12}/> {customer?.isKey?'已重点':'标记重点'}</button>
                </div>
                {/* 草稿往来记录 */}
                {selected.folder==='drafts' && (
                  <div className="rounded-xl border border-amber-200 bg-amber-50/40 p-3">
                    <div className="text-xs font-semibold text-amber-700 mb-2">往来记录 · 草稿关联 {thread.length} 封</div>
                    <div className="space-y-2 max-h-64 overflow-y-auto">
                      {thread.map(e=>(
                        <div key={e.id} className={`p-2 rounded-lg border text-xs ${e.id===selected.id?'bg-white border-amber-300':'bg-white/70'}`}>
                          <div className="flex items-center gap-1 text-[11px] text-gray-400">
                            <span>{e.folder==='sent'?'我 →':'→我'} {e.from.split('<')[0]}</span>
                            <span className="ml-auto">{new Date(e.date).toLocaleDateString()}</span>
                          </div>
                          <div className="font-medium text-gray-700 truncate">{e.subject}</div>
                          <div className="text-gray-500 truncate">{e.text.slice(0,80)}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* 右：翻译/AI推荐/重点跟进 */}
        <div className="bg-white rounded-2xl border border-gray-100 flex flex-col overflow-hidden">
          <div className="p-3 border-b border-gray-100 text-xs font-semibold text-gray-600">AI 侧栏 · 重点客户</div>
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            <div className="rounded-xl border border-gray-100 p-3">
              <div className="text-xs font-medium text-gray-700 mb-1">记录重点客户 · 添加备注</div>
              <div className="text-xs text-gray-500 mb-2">{customer? `${customer.title||customer.email} ${customer.company||''}`:'未关联客户'}</div>
              <div className="flex gap-1">
                <button onClick={handleMarkKey} className={`flex-1 py-1.5 rounded-lg text-xs flex items-center justify-center gap-1 ${customer?.isKey?'bg-yellow-50 text-yellow-600 border border-yellow-200':'bg-gray-50 text-gray-500'}`}><UserCheck size={12}/> {customer?.isKey?'已标记重点':'标记重点'}</button>
                <button onClick={async()=>{ let c=customer; if(!c && selected){ c=await ensureCustomer(selected.from, selected.from); setCustomer(c)} if(!c) return; const n=await askText('备注', c.notes||''); if(n!==null){ await db.customers.update(c.id,{notes:n} as any); setCustomer({...c,notes:n} as any); try{ await db.events.put({id:`evt-${Date.now()}`,type:'object.updated',actorType:'user',objectType:'customer',objectId:c.id,payload:{notes:n},createdAt:new Date().toISOString()} as any)}catch{}}} } className="flex-1 py-1.5 bg-white border rounded-lg text-xs flex items-center justify-center gap-1"><StickyNote size={12}/> 备注</button>
              </div>
              {customer?.notes && <div className="mt-2 text-xs bg-yellow-50 border border-yellow-100 rounded p-2">{customer.notes}</div>}
              <button onClick={handleAiSummary} className="mt-2 w-full py-1.5 bg-purple-50 text-purple-600 rounded-lg text-xs flex items-center justify-center gap-1"><Sparkles size={12}/> AI总结客户</button>
              {customer?.aiSummary && <div className="mt-2 text-xs bg-purple-50 rounded p-2">{customer.aiSummary} 评分:{customer.score}</div>}
            </div>

            <div className="rounded-xl border border-gray-100 p-3">
              <div className="text-xs font-medium text-gray-700 mb-1 flex items-center gap-1"><Calendar size={12}/> 下次跟进</div>
              <div className="text-xs text-gray-400 mb-1">当前：{customer?.followUpAt||'未设置'} · AI建议：{selected? suggestFollowUpDate(selected.intent||'其他', selected.text):'—'}</div>
              <div className="flex gap-1 flex-wrap">
                {[1,3,7,14,30].map(d=> <button key={d} onClick={()=> handleCustomFollow(d)} className="px-2 py-1 bg-white border rounded text-xs hover:bg-blue-50">{d}天后</button>)}
                <button onClick={handleFollowUp} className="px-2 py-1 bg-blue-600 text-white rounded text-xs flex items-center gap-1"><Clock size={10}/> 自定义</button>
              </div>
              <div className="text-xs text-gray-400 mt-2">提醒方式：☑ 工作台 ☑ Telegram ☑ Email（存 followUps，首页通知）</div>
            </div>

            <div className="rounded-xl bg-blue-50 border border-blue-100 p-3">
              <div className="text-xs font-semibold text-blue-700 mb-1 flex items-center gap-1"><Send size={12}/> AI推荐回复</div>
              <div className="text-xs bg-white rounded p-2 border">
                Hi {customer?.contactName||'there'},<br/>Thanks for your inquiry about {selected?.product}. Our best price for {selected?.qty||500} pcs is $680, lead time 12 days. Could you confirm quantity & deadline?<br/>Best regards, Evan
              </div>
              <div className="flex gap-1 mt-2">
                <button onClick={async()=>{
                  let c=customer
                  if(!c && selected){ c=await ensureCustomer(selected.from, selected.from); setCustomer(c) }
                  if(!c||!selected) return
                  const draft=`Hi ${c.contactName||c.title},\n\nThanks for your inquiry about ${selected.product}. Our best price for ${selected.qty||500} pcs is $680, lead time 12 days.\n\nBest regards, Evan`
                  const { uid, now } = await import('../repositories/result')
                  const draftId = uid()
                  await db.emails.put({ id: draftId, accountId: selected.accountId, folder:'drafts', from: `Evan <evan@maxemblem.com>`, to: c.email||selected.from, subject:`Re: ${selected.subject}`, text: draft, html:'', date: new Date().toISOString(), isRead:false, hasAttachment:false, customerId: c.id, status:'待处理' } as any)
                  await db.communications.put({ id: uid(), type:'communication', title:`回复: ${selected.subject}`, description: draft, emoji:'✉️', tags:['AI生成'], createdAt:now(), updatedAt:now(), relations:[], channel:'email', direction:'outbound', summary: draft, communicatedAt: new Date().toISOString(), customerId: c.id } as any)
                  setFolder('drafts')
                  // 选中新草稿
                  const nm = await db.emails.get(draftId) as any
                  if(nm) setSelected(nm)
                  const list = await listEmails(); setEmails(list)
                  alert('AI草稿已生成到 草稿 箱并关联往来记录')
                }} className="flex-1 py-1.5 bg-blue-600 text-white rounded text-xs">一键生成</button>
                <button onClick={async()=>{ if(selected){ const t=await translateEnToZh(selected.text); setTranslated(t); alert('翻译已更新到中栏')} }} className="flex-1 py-1.5 bg-white border rounded text-xs">翻译对照</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
