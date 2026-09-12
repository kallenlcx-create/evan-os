import { useState, useEffect, useMemo } from 'react'
import { db } from '../db'
import type { FollowUpRecord, Customer } from '../types'
import { Calendar, Clock, Flame, AlertTriangle, DollarSign, Repeat, Megaphone } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

export default function FollowUpsPage(){
  const navigate = useNavigate()
  const [customers, setCustomers] = useState<Customer[]>([])
  const [emails, setEmails] = useState<any[]>([])
  const [tradeDeals, setTradeDeals] = useState<any[]>([])
  const [list,setList]=useState<FollowUpRecord[]>([])
  const [catFilter, setCatFilter]=useState<string>('all')
  const [page, setPage]=useState(1)
  const [perPage, setPerPage]=useState(4)
  const [autoFollow, setAutoFollow] = useState(()=> localStorage.getItem('evan:autoFollow')!=='0')
  const [autoMarketing, setAutoMarketing] = useState(()=> localStorage.getItem('evan:autoMarketing')!=='0')
  const [followTime, setFollowTime] = useState(()=> localStorage.getItem('evan:followTime')||'09:30')
  const [marketingTime, setMarketingTime] = useState(()=> localStorage.getItem('evan:marketingTime')||'10:00')
  useEffect(()=> localStorage.setItem('evan:autoFollow', autoFollow?'1':'0'),[autoFollow])
  useEffect(()=> localStorage.setItem('evan:autoMarketing', autoMarketing?'1':'0'),[autoMarketing])
  useEffect(()=> localStorage.setItem('evan:followTime', followTime),[followTime])
  useEffect(()=> localStorage.setItem('evan:marketingTime', marketingTime),[marketingTime])

  const load=async()=>{
    setCustomers(await db.customers.toArray() as any)
    setEmails(await db.emails.toArray())
    setTradeDeals(await db.tradeDeals.toArray().catch(()=>[]) as any)
    setList(await db.followUps.toArray())
  }
  useEffect(()=>{void load(); const h=()=> void load(); window.addEventListener('evan-emails-updated', h); window.addEventListener('evan-customers-updated', h); return ()=>{ window.removeEventListener('evan-emails-updated', h); window.removeEventListener('evan-customers-updated', h) }},[])
  const today=new Date().toISOString().slice(0,10)

  // 6分类统计
  const stats = useMemo(()=>{
    const high = customers.filter(c=> c.isKey && (c.level==='A+'||c.level==='A')).length
    const todayCnt = list.filter(f=> f.dueAt===today && f.status==='pending').length
    const overdue = list.filter(f=> f.dueAt<today && f.status==='pending').length
    const pendingDeals = tradeDeals.filter(t=> !['lost','repurchase'].includes(t.stage)).length
    const repurchase = customers.filter(c=> c.isKey && (c.score||0)>70).length
    const marketing = customers.filter(c=> c.isKey).length
    return { high, today:todayCnt, overdue, pendingDeals, repurchase, marketing }
  },[customers, list, tradeDeals])

  // 雷达：A/B重点沉寂客户
  const radar = useMemo(()=>{
    // 按最后邮件时间算沉寂天数
    const byEmail = new Map<string, string>()
    for(const e of emails){
      const addr=(e.from.match(/<(.+?)>/)?.[1]||e.from).toLowerCase()
      const cur=byEmail.get(addr)
      if(!cur || e.date > cur) byEmail.set(addr, e.date)
    }
    const keyCustomers = customers.filter(c=> c.isKey && (c.level==='A+'||c.level==='A' || c.level==='B'))
    const scored = keyCustomers.map(c=>{
      const last = byEmail.get((c.email||'').toLowerCase()) || c.updatedAt
      const days = last? Math.floor((Date.now() - new Date(last).getTime())/86400000) : 99
      const stage = (c as any).stage || 'won'
      return { c, days, stage }
    }).filter(x=> x.days>=7) // 沉寂7天以上才预警
    .sort((a,b)=> b.days - a.days)
    const aList = scored.filter(x=> x.c.level==='A+'||x.c.level==='A')
    const bList = scored.filter(x=> x.c.level==='B')
    return { all: scored, aList, bList }
  },[customers, emails])

  // 根据顶部6分类筛选雷达
  const catFiltered = useMemo(()=>{
    if(catFilter==='high') return radar.aList
    if(catFilter==='today') return radar.all.filter(x=> list.some(f=> f.customerId===x.c.id && f.dueAt===today))
    if(catFilter==='overdue') return radar.all.filter(x=> list.some(f=> f.customerId===x.c.id && f.dueAt<today))
    if(catFilter==='pending') return radar.all // 待成交即全部重点
    if(catFilter==='repurchase') return radar.all.filter(x=> (x.c.score||0)>70)
    if(catFilter==='marketing') return radar.all
    return radar.all
  },[catFilter, radar, list, today])

  const totalPages = Math.max(1, Math.ceil(catFiltered.length / perPage))
  const pageData = catFiltered.slice((page-1)*perPage, page*perPage)

  const cats = [
    {key:'high', label:'高意向客户', icon:Flame, count:stats.high, color:'text-red-500', bg:'bg-red-50'},
    {key:'today', label:'今日跟进', icon:Clock, count:stats.today, color:'text-blue-500', bg:'bg-blue-50'},
    {key:'overdue', label:'逾期跟进', icon:AlertTriangle, count:stats.overdue, color:'text-orange-500', bg:'bg-orange-50'},
    {key:'pending', label:'待成交机会', icon:DollarSign, count:stats.pendingDeals, color:'text-green-600', bg:'bg-green-50'},
    {key:'repurchase', label:'潜在复购', icon:Repeat, count:stats.repurchase, color:'text-purple-500', bg:'bg-purple-50'},
    {key:'marketing', label:'营销机会', icon:Megaphone, count:stats.marketing, color:'text-pink-500', bg:'bg-pink-50'},
  ]

  return (
    <div className="p-4 max-w-6xl mx-auto space-y-4">
      <h1 className="text-xl font-bold flex items-center gap-2"><Calendar size={20}/> 跟进 · 客户跟进雷达</h1>

      {/* 6分类 */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
        {cats.map(c=>(
          <button key={c.key} onClick={()=> setCatFilter(c.key)} className={`p-3 rounded-2xl border text-left ${catFilter===c.key?'ring-2 ring-blue-300 border-blue-300':'border-gray-100 bg-white'}`}>
            <div className={`w-7 h-7 rounded-full flex items-center justify-center ${c.bg} ${c.color} mb-1`}><c.icon size={14}/></div>
            <div className="text-xs text-gray-500">{c.label}</div>
            <div className={`text-lg font-bold ${c.color}`}>{c.count}</div>
          </button>
        ))}
      </div>

      {/* 客户跟进雷达 */}
      <div className="bg-white rounded-2xl border p-4">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-7 h-7 bg-red-100 rounded-lg flex items-center justify-center">🔥</div>
          <div>
            <div className="text-sm font-bold flex items-center gap-1">客户跟进雷达 (Follow-up Radar) <span className="text-xs px-1.5 py-0.5 bg-purple-50 text-purple-600 rounded">AI 智能流失预警</span></div>
            <div className="text-xs text-gray-400">实时监测 A/B 类客户互动沉寂与停滞风险，防止大单流失</div>
          </div>
          <button onClick={()=> load()} className="ml-auto text-xs px-2 py-1 bg-white border rounded">↻ 刷新</button>
        </div>
        <div className="grid grid-cols-3 gap-2 text-center border-y py-2 mb-3">
          <div><div className="text-xs text-gray-400 flex items-center justify-center gap-1">🔥 A类急需跟进</div><div className="text-lg font-bold text-red-600">{radar.aList.length}</div></div>
          <div className="border-x"><div className="text-xs text-gray-400 flex items-center justify-center gap-1">↗ B类需推进</div><div className="text-lg font-bold text-blue-600">{radar.bList.length}</div></div>
          <div><div className="text-xs text-gray-400">全部预警总数</div><div className="text-lg font-bold">{radar.all.length}</div></div>
        </div>
        <div className="space-y-2">
          {pageData.map(({c, days, stage})=>(
            <div key={c.id} className="flex items-center gap-3 p-3 bg-white border rounded-xl hover:border-blue-200">
              <div className="w-9 h-9 rounded-full bg-red-50 text-red-600 flex items-center justify-center font-bold">{(c.contactName||c.title||'J').slice(0,1).toUpperCase()}</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-semibold truncate">{c.contactName||c.title}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded-full ${c.isKey?'bg-red-50 text-red-600':'bg-gray-100'}`}>● {c.isKey?'A 重点战略':c.level}</span>
                  <span className="text-xs text-gray-400">阶段: {stage}</span>
                  <span className="text-xs text-red-500">◎ 已沉寂 {days} 天</span>
                </div>
                <div className="text-xs text-gray-400 truncate">{c.email} · {(c as any).company||''}</div>
                <div className="text-xs text-amber-600 mt-0.5">⭐ A类重点战略客户已沉寂 {days} 天未互动 · 建议: 建议发送项目进展关怀或原料调价窗口预警，锁住大单排期</div>
              </div>
              <button onClick={()=> navigate(`/inbox`)} className="px-3 py-1.5 bg-white border rounded-lg text-xs">往来联络 ›</button>
              <button onClick={async()=>{
                const { uid, now } = await import('../repositories/result')
                const draft=`Hi ${c.contactName||c.title},\n\nJust checking in on your project. We can offer updated pricing window.\n\nBest, Evan`
                await db.communications.put({ id: uid(), type:'communication', title:`跟进: ${c.title}`, description: draft, emoji:'✉️', tags:['雷达'], createdAt:now(), updatedAt:now(), relations:[], channel:'email', direction:'outbound', summary: draft, communicatedAt: new Date().toISOString(), customerId: c.id } as any)
                await db.emails.put({ id: uid(), accountId:'radar', folder:'drafts', from:'Evan <evan@maxemblem.com>', to: c.email||'', subject:`Re: Follow-up`, text: draft, date: new Date().toISOString(), isRead:false, customerId: c.id } as any)
                alert('已一键生成跟进草稿到 草稿 箱')
              }} className="px-3 py-1.5 bg-red-500 text-white rounded-lg text-xs flex items-center gap-1">✨ 一键生成跟进草稿</button>
            </div>
          ))}
          {pageData.length===0 && <div className="text-center text-xs text-gray-300 py-8">暂无预警，A/B重点客户均在跟进期内</div>}
        </div>
        <div className="flex items-center justify-between mt-3 text-xs text-gray-400">
          <span>显示第 {(page-1)*perPage+1} - {Math.min(page*perPage, catFiltered.length)} 条，共 {catFiltered.length} 条待跟进 · 每页:</span>
          <div className="flex items-center gap-1">
            {[3,4,8,12].map(n=> <button key={n} onClick={()=> { setPerPage(n); setPage(1)}} className={`w-6 h-6 rounded ${perPage===n?'bg-gray-900 text-white':'bg-white border'}`}>{n}</button>)}
          </div>
          <div className="flex items-center gap-1">
            <button onClick={()=> setPage(p=> Math.max(1,p-1))} className="w-6 h-6 bg-white border rounded">{'<'}</button>
            {Array.from({length: totalPages},(_,i)=> i+1).slice(0,7).map(n=> <button key={n} onClick={()=> setPage(n)} className={`w-6 h-6 rounded ${page===n?'bg-red-500 text-white':'bg-white border'}`}>{n}</button>)}
            <button onClick={()=> setPage(p=> Math.min(totalPages,p+1))} className="w-6 h-6 bg-white border rounded">{'>'}</button>
          </div>
        </div>
      </div>

      {/* 原跟进开关与列表（保留） */}
      <div className="bg-white rounded-2xl border p-3 grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="flex items-center justify-between gap-2 p-2 bg-gray-50 rounded-xl border">
          <div><div className="text-xs font-medium">自动跟进</div><div className="text-xs text-gray-400">报价后3天未回自动生成</div></div>
          <input type="checkbox" checked={autoFollow} onChange={e=> setAutoFollow(e.target.checked)} className="w-10 h-5 accent-blue-600"/>
        </label>
        <label className="flex items-center justify-between gap-2 p-2 bg-gray-50 rounded-xl border">
          <div><div className="text-xs font-medium">自动营销</div><div className="text-xs text-gray-400">复购到期自动推荐</div></div>
          <input type="checkbox" checked={autoMarketing} onChange={e=> setAutoMarketing(e.target.checked)} className="w-10 h-5 accent-purple-600"/>
        </label>
        <label className="flex items-center gap-2 p-2 bg-white rounded-xl border">
          <Clock size={14} className="text-gray-400"/> <span className="text-xs">跟进时间</span>
          <input type="time" value={followTime} onChange={e=> setFollowTime(e.target.value)} className="ml-auto px-2 py-1 border rounded text-xs"/>
          <span className={`text-xs ${autoFollow?'text-green-600':'text-gray-300'}`}>{autoFollow?'开启':'关闭'}</span>
        </label>
        <label className="flex items-center gap-2 p-2 bg-white rounded-xl border">
          <Clock size={14} className="text-gray-400"/> <span className="text-xs">营销时间</span>
          <input type="time" value={marketingTime} onChange={e=> setMarketingTime(e.target.value)} className="ml-auto px-2 py-1 border rounded text-xs"/>
          <span className={`text-xs ${autoMarketing?'text-purple-600':'text-gray-300'}`}>{autoMarketing?'开启':'关闭'}</span>
        </label>
      </div>
    </div>
  )
}
