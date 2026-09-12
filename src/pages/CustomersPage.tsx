import { useState, useEffect, useCallback } from 'react'
import { db } from '../db'
import type { Customer, EmailMessage } from '../types'
import { Star, Search, Calendar, X, GraduationCap, Shield, Users, Globe, Briefcase, Landmark } from 'lucide-react'
import { fetchFullEmailBatch } from '../repositories/emailRepository'

// ====== 邮箱后缀自动分类 ======
const EMAIL_SUFFIX_MAP: Record<string, { label: string; icon: any; color: string }> = {
  'gov': { label: '政府', icon: Landmark, color: 'bg-red-50 text-red-600' },
  'mil': { label: '军队', icon: Shield, color: 'bg-orange-50 text-orange-600' },
  'edu': { label: '教育', icon: GraduationCap, color: 'bg-blue-50 text-blue-600' },
  'org': { label: '非盈利', icon: Users, color: 'bg-purple-50 text-purple-600' },
}
const PERSONAL_DOMAINS = ['gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com','live.com','aol.com','protonmail.com','mail.com','qq.com','163.com','126.com','foxmail.com']

function classifyEmailType(email?: string): { label: string; icon: any; color: string } {
  if(!email) return { label: '未知', icon: Globe, color: 'bg-gray-50 text-gray-500' }
  const suffix = email.split('@')[1]?.toLowerCase() || ''
  // 检查特殊后缀
  for(const [key, val] of Object.entries(EMAIL_SUFFIX_MAP)){
    if(suffix.endsWith('.'+key) || suffix === key) return val
  }
  // 个人邮箱
  if(PERSONAL_DOMAINS.includes(suffix)) return { label: '个人', icon: Users, color: 'bg-green-50 text-green-600' }
  // 企业邮箱
  return { label: '企业', icon: Briefcase, color: 'bg-indigo-50 text-indigo-600' }
}

// ====== 从邮件文本提取金额 ======
function extractAmount(text: string): number {
  const patterns = [
    /\$\s*([\d,]+(?:\.\d{2})?)/g,
    /USD\s*([\d,]+(?:\.\d{2})?)/gi,
    /price[:\s]*\$?([\d,]+(?:\.\d{2})?)/gi,
    /total[:\s]*\$?([\d,]+(?:\.\d{2})?)/gi,
    /预算[:\s]*[\$￥]?([\d,]+)/g,
  ]
  let max = 0
  for(const p of patterns){
    let m
    while((m = p.exec(text)) !== null){
      const n = parseFloat(m[1].replace(/,/g,''))
      if(n > max) max = n
    }
  }
  return max
}

// ====== 自动分类客户等级 ======
function autoClassifyCustomer(c: Customer, emailCount: number, totalAmount: number): { level: Customer['level']; isKey: boolean; customerType: Customer['customerType'] } {
  let level: Customer['level'] = 'C'
  let isKey = c.isKey || false
  // 1. 订单金额分级
  if(totalAmount >= 1000) level = 'A'
  else if(totalAmount >= 500) level = 'B'
  else if(emailCount >= 5) level = 'B'
  else if(emailCount >= 3) level = 'C'
  else level = 'D'
  // 2. 订单次数（邮件往来>=3次 = 重点）
  if(emailCount >= 3) isKey = true
  // 3. VIP 金额>=2000
  if(totalAmount >= 2000) { level = 'A+'; isKey = true }
  // 4. 邮箱类型
  const emailType = classifyEmailType(c.email)
  const typeMap: Record<string, Customer['customerType']> = {
    '政府':'Government','军队':'Military','教育':'School','非盈利':'Organization','企业':'Company','个人':'End Customer'
  }
  const customerType = typeMap[emailType.label] || 'Company'
  return { level, isKey, customerType }
}

export default function CustomersPage(){
  const [list, setList] = useState<Customer[]>([])
  const [filter, setFilter] = useState<'all'|'A+'|'A'|'B'|'C'|'D'|'key'|'gov'|'edu'|'org'|'mil'|'personal'|'enterprise'>( 'all')
  const [q,setQ]=useState('')
  const [selectedCustomer, setSelectedCustomer] = useState<Customer|null>(null)
  const [customerEmails, setCustomerEmails] = useState<EmailMessage[]>([])
  const [emailStats, setEmailStats] = useState<Record<string, { count: number; totalAmount: number }>>({})
  const [autoClassified, setAutoClassified] = useState(false)
  const [fullContent, setFullContent] = useState<Record<string, {text:string;html:string}>>({})
  const [loadingContent, setLoadingContent] = useState<Record<string, boolean>>({})

  const load = useCallback(async()=>{
    const customers = await db.customers.toArray() as any[]
    setList(customers)
    // 统计每个客户的邮件数和金额
    const allEmails = await db.emails.toArray() as EmailMessage[]
    const stats: Record<string, { count: number; totalAmount: number }> = {}
    for(const e of allEmails){
      const addr = (e.from.match(/<(.+?)>/)?.[1]||e.from).trim().toLowerCase()
      if(!addr) continue
      if(!stats[addr]) stats[addr] = { count:0, totalAmount:0 }
      stats[addr].count++
      stats[addr].totalAmount += extractAmount(e.subject+' '+(e.text||''))
    }
    setEmailStats(stats)
    // 自动分类（首次）
    if(!autoClassified){
      setAutoClassified(true)
      let changed = false
      for(const c of customers){
        if(!c.email) continue
        const addr = c.email.toLowerCase()
        const s = stats[addr] || { count:0, totalAmount:0 }
        const cls = autoClassifyCustomer(c, s.count, s.totalAmount)
        if(cls.level !== c.level || cls.isKey !== c.isKey || cls.customerType !== c.customerType){
          await db.customers.update(c.id, { level: cls.level, isKey: cls.isKey, customerType: cls.customerType } as any)
          changed = true
        }
      }
      if(changed) setList(await db.customers.toArray() as any[])
    }
  },[autoClassified])

  useEffect(()=>{void load(); const h=()=> void load(); window.addEventListener('evan-emails-updated', h); window.addEventListener('evan-customers-updated', h); return ()=>{ window.removeEventListener('evan-emails-updated', h); window.removeEventListener('evan-customers-updated', h) }},[load])

  // 点击客户 → 加载该客户所有邮件 + 批量加载全文
  const handleCustomerClick = useCallback(async(c: Customer)=>{
    setSelectedCustomer(c)
    setFullContent({})
    setLoadingContent({})
    const allEmails = await db.emails.toArray() as EmailMessage[]
    const addr = (c.email||'').toLowerCase()
    const matched = allEmails.filter(e=>{
      const from = (e.from.match(/<(.+?)>/)?.[1]||e.from).trim().toLowerCase()
      const to = (e.to||'').toLowerCase()
      return from===addr || to.includes(addr)
    }).sort((a,b)=> new Date(b.date).getTime() - new Date(a.date).getTime())
    setCustomerEmails(matched)

    // 批量加载所有 text/html 为空的邮件
    const missing = matched.filter(e => !e.text && !e.html)
    if(missing.length === 0) return
    // 按 accountId 分组
    const byAccount = new Map<string, {email: EmailMessage; uid: string}[]>()
    for(const e of missing){
      const parts = e.id.split('-')
      const uid = parts[parts.length-1]
      const accountId = e.accountId || parts[0]
      if(!byAccount.has(accountId)) byAccount.set(accountId, [])
      byAccount.get(accountId)!.push({email:e, uid})
    }
    setLoadingContent(prev => {
      const next = {...prev}
      for(const e of missing) next[e.id] = true
      return next
    })
    // 并行请求所有账号
    const promises = [...byAccount.entries()].map(async([accId, items])=>{
      const uids = items.map(i => i.uid)
      const results = await fetchFullEmailBatch(accId, uids)
      for(const {email: e, uid} of items){
        const full = results[uid]
        if(full && (full.text || full.html)){
          setFullContent(prev=>({...prev,[e.id]:{text:full.text||'',html:full.html||''}}))
          await db.emails.update(e.id,{ text:full.text||e.text, html:full.html||e.html } as any)
        }
        setLoadingContent(prev=>({...prev,[e.id]:false}))
      }
    })
    await Promise.allSettled(promises)
  },[])

  const filtered = list.filter(c=>{
    if(filter==='key' && !c.isKey) return false
    if(['A+','A','B','C','D'].includes(filter) && c.level!==filter) return false
    if(filter==='gov'||filter==='edu'||filter==='org'||filter==='mil'){
      const emailType = classifyEmailType(c.email)
      const filterMap: Record<string,string> = { gov:'政府', edu:'教育', org:'非盈利', mil:'军队' }
      if(emailType.label !== filterMap[filter]) return false
    }
    if(filter==='personal'){
      const emailType = classifyEmailType(c.email)
      if(emailType.label !== '个人') return false
    }
    if(filter==='enterprise'){
      const emailType = classifyEmailType(c.email)
      if(emailType.label !== '企业') return false
    }
    if(q && !`${c.title} ${c.company} ${c.email}`.toLowerCase().includes(q.toLowerCase())) return false
    return true
  })

  const emailTypeCounts = list.reduce((acc, c)=>{
    const t = classifyEmailType(c.email).label
    acc[t] = (acc[t]||0) + 1
    return acc
  }, {} as Record<string, number>)

  return (
    <div className="p-4 max-w-6xl mx-auto space-y-3">
      <div className="flex items-center gap-2">
        <h1 className="text-xl font-bold">👥 客户</h1>
        <span className="text-xs text-gray-400">{filtered.length} / {list.length}</span>
        <button onClick={()=> setFilter('key' as any)} className={`ml-auto px-3 py-1 rounded-full text-xs ${filter==='key'?'bg-yellow-500 text-white':'bg-white border'}`}>⭐ 重点</button>
      </div>
      <div className="flex gap-1 flex-wrap">
        {(['all','A+','A','B','C','D'] as const).map(l=> <button key={l} onClick={()=> setFilter(l as any)} className={`px-3 py-1 rounded-full text-xs border ${filter===l?'bg-blue-600 text-white':'bg-white'}`}>{l==='all'?'全部':l}</button>)}
        <span className="text-gray-300 self-center">|</span>
        {([
          {k:'gov',l:'🏛 政府',c:'bg-red-50 text-red-600'},
          {k:'edu',l:'🎓 教育',c:'bg-blue-50 text-blue-600'},
          {k:'org',l:'🤝 非盈利',c:'bg-purple-50 text-purple-600'},
          {k:'mil',l:'🎖 军队',c:'bg-orange-50 text-orange-600'},
          {k:'personal',l:'👤 个人',c:'bg-green-50 text-green-600'},
          {k:'enterprise',l:'🏢 企业',c:'bg-indigo-50 text-indigo-600'},
        ] as const).map(({k,l,c})=> <button key={k} onClick={()=> setFilter(filter===k?'all':k as any)} className={`px-2 py-1 rounded-full text-[10px] border ${filter===k?c+' ring-1 ring-current':'bg-white text-gray-500'}`}>{l} {emailTypeCounts[k.replace('personal','个人').replace('enterprise','企业')]||''}</button>)}
        <div className="ml-auto relative"><Search size={12} className="absolute left-2 top-2 text-gray-300"/><input value={q} onChange={e=>setQ(e.target.value)} placeholder="搜公司/邮箱" className="pl-6 pr-2 py-1 border rounded-lg text-xs"/></div>
      </div>
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
        {filtered.map(c=>{
          const emailType = classifyEmailType(c.email)
          const EmailIcon = emailType.icon
          const stats = emailStats[(c.email||'').toLowerCase()] || { count:0, totalAmount:0 }
          return(
            <div key={c.id} onClick={()=> handleCustomerClick(c)} className={`bg-white rounded-2xl border p-4 cursor-pointer hover:shadow-md transition-shadow ${c.isKey?'border-yellow-200 bg-yellow-50/30':''}`}>
              <div className="flex items-center gap-2">
                <span className="font-semibold text-sm">{c.contactName||c.title}</span>
                {c.isKey && <Star size={12} className="text-yellow-500 fill-yellow-500"/>}
                <span className="ml-auto text-xs px-1.5 py-0.5 bg-gray-100 rounded">{c.level||'C'}</span>
              </div>
              <div className="text-xs text-gray-500 truncate">{c.company || c.email}</div>
              <div className="flex items-center gap-1.5 mt-1.5">
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full flex items-center gap-0.5 ${emailType.color}`}><EmailIcon size={9}/>{emailType.label}</span>
                {stats.count>0 && <span className="text-[10px] text-gray-400">📧{stats.count}封</span>}
                {stats.totalAmount>0 && <span className="text-[10px] text-green-600">${stats.totalAmount.toLocaleString()}</span>}
              </div>
              {c.aiSummary && <div className="text-[10px] bg-purple-50 rounded p-1.5 mt-1.5 truncate">{c.aiSummary}</div>}
              <div className="text-[10px] text-gray-400 flex items-center gap-1 mt-1.5"><Calendar size={9}/> 下次 {c.followUpAt||'—'}</div>
            </div>
          )
        })}
      </div>

      {/* 客户邮件详情弹窗 */}
      {selectedCustomer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={()=> setSelectedCustomer(null)}>
          <div className="bg-white rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl" onClick={e=> e.stopPropagation()}>
            {/* 头部 */}
            <div className="p-4 border-b border-gray-100 flex items-center gap-3">
              <div className="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center text-blue-600 font-bold">{(selectedCustomer.contactName||selectedCustomer.title||'?')[0]}</div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-sm">{selectedCustomer.contactName||selectedCustomer.title}</div>
                <div className="text-xs text-gray-500">{selectedCustomer.email} · {selectedCustomer.company||'—'}</div>
              </div>
              <div className="flex items-center gap-1.5">
                {selectedCustomer.isKey && <span className="text-xs px-2 py-0.5 bg-yellow-100 text-yellow-700 rounded-full">⭐ 重点</span>}
                <span className="text-xs px-2 py-0.5 bg-gray-100 rounded-full">{selectedCustomer.level||'C'}</span>
                {(() => { const t = classifyEmailType(selectedCustomer.email); return <span className={`text-xs px-2 py-0.5 rounded-full ${t.color}`}>{t.label}</span> })()}
              </div>
              <button onClick={()=> setSelectedCustomer(null)} className="p-1.5 hover:bg-gray-100 rounded-lg"><X size={16}/></button>
            </div>
            {/* 统计 */}
            <div className="px-4 py-2 bg-gray-50 border-b flex items-center gap-4 text-xs text-gray-500">
              <span>📧 邮件往来 <b className="text-gray-800">{customerEmails.length}</b> 封</span>
              {(() => { const s = emailStats[(selectedCustomer.email||'').toLowerCase()]; return s && s.totalAmount>0 ? <span>💰 累计金额 <b className="text-green-600">${s.totalAmount.toLocaleString()}</b></span> : null })()}
              <span>📅 下次跟进 {selectedCustomer.followUpAt||'未设置'}</span>
            </div>
            {/* 邮件列表 */}
            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              {customerEmails.length===0 && <div className="text-center text-gray-400 py-8">暂无邮件来往记录</div>}
              {customerEmails.map(e=>{
                const isSent = e.folder==='sent' || (e.from||'').toLowerCase().includes('evan@maxemblem.com')
                const loaded = fullContent[e.id]
                const loading = loadingContent[e.id]
                const displayText = loaded?.text || e.text || ''
                const displayHtml = loaded?.html || e.html || ''
                return(
                  <div key={e.id} className={`p-3 rounded-xl border ${isSent?'bg-green-50/50 border-green-100 ml-8':'bg-blue-50/50 border-blue-100 mr-8'}`}>
                    <div className="flex items-center gap-2 text-xs mb-1">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] ${isSent?'bg-green-100 text-green-700':'bg-blue-100 text-blue-700'}`}>{isSent?'发件':'收件'}</span>
                      <span className="font-medium text-gray-700 truncate">{isSent ? `我 → ${selectedCustomer.email}` : e.from.split('<')[0].trim()}</span>
                      <span className="ml-auto text-[10px] text-gray-400">{new Date(e.date).toLocaleString()}</span>
                    </div>
                    <div className="text-xs font-medium text-gray-700 mb-1">{e.subject}</div>
                    {loading ? (
                      <div className="text-[11px] text-blue-400 py-2 flex items-center gap-1">
                        <span className="animate-spin">⏳</span> 正在加载邮件全文...
                      </div>
                    ) : displayHtml ? (
                      <div className="email-html text-[11px] leading-relaxed max-h-40 overflow-auto border rounded-lg p-2 bg-white" dangerouslySetInnerHTML={{__html: displayHtml}} />
                    ) : displayText ? (
                      <div className="text-[11px] text-gray-600 whitespace-pre-wrap max-h-40 overflow-auto border rounded-lg p-2 bg-white">{displayText.slice(0,2000)}</div>
                    ) : (
                      <div className="text-[11px] text-gray-400 py-2">暂无内容</div>
                    )}
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
