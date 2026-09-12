import { useState, useEffect } from 'react'
import { db } from '../db'
import type { FollowUpRecord } from '../types'
import { Calendar, Check, Clock } from 'lucide-react'

export default function FollowUpsPage(){
  const [list,setList]=useState<FollowUpRecord[]>([])
  const [filter,setFilter]=useState<'today'|'week'|'overdue'|'all'>('today')
  const [autoFollow, setAutoFollow] = useState(()=> localStorage.getItem('evan:autoFollow')!=='0')
  const [autoMarketing, setAutoMarketing] = useState(()=> localStorage.getItem('evan:autoMarketing')!=='0')
  const [followTime, setFollowTime] = useState(()=> localStorage.getItem('evan:followTime')||'09:30')
  const [marketingTime, setMarketingTime] = useState(()=> localStorage.getItem('evan:marketingTime')||'10:00')
  useEffect(()=> localStorage.setItem('evan:autoFollow', autoFollow?'1':'0'),[autoFollow])
  useEffect(()=> localStorage.setItem('evan:autoMarketing', autoMarketing?'1':'0'),[autoMarketing])
  useEffect(()=> localStorage.setItem('evan:followTime', followTime),[followTime])
  useEffect(()=> localStorage.setItem('evan:marketingTime', marketingTime),[marketingTime])
  const load=async()=> setList(await db.followUps.toArray())
  useEffect(()=>{void load()},[])
  const today=new Date().toISOString().slice(0,10)
  const week=new Date(Date.now()+7*86400000).toISOString().slice(0,10)
  const filtered=list.filter(f=>{
    if(filter==='today') return f.dueAt===today && f.status==='pending'
    if(filter==='overdue') return f.dueAt<today && f.status==='pending'
    if(filter==='week') return f.dueAt>=today && f.dueAt<=week
    return true
  })
  return (
    <div className="p-4 max-w-3xl mx-auto space-y-3">
      <h1 className="text-xl font-bold flex items-center gap-2"><Calendar size={20}/> 跟进</h1>
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
      <div className="flex gap-1">
        {(['today','week','overdue','all'] as const).map(k=> <button key={k} onClick={()=> setFilter(k)} className={`px-3 py-1 rounded-full text-xs ${filter===k?'bg-blue-600 text-white':'bg-white border'}`}>{k==='today'?'今天':k==='week'?'本周':k==='overdue'?'逾期':'全部'}</button>)}
        <span className="ml-auto text-xs text-gray-400">{filtered.length} 条</span>
      </div>
      <div className="space-y-2">
        {filtered.map(f=>(
          <div key={f.id} className={`bg-white rounded-xl border p-3 flex items-center gap-2 ${f.dueAt<today?'border-red-200 bg-red-50/40':''}`}>
            <Clock size={14} className="text-gray-400"/>
            <div className="flex-1">
              <div className="text-sm">{f.customerId} · {f.note||'跟进'}</div>
              <div className="text-xs text-gray-400">到期 {f.dueAt} · {f.channel.join(',')}</div>
            </div>
            <button onClick={async()=>{ await db.followUps.update(f.id,{status:'done'} as any); load()}} className="px-2 py-1 bg-green-500 text-white rounded text-xs flex items-center gap-1"><Check size={12}/> 完成</button>
          </div>
        ))}
        {filtered.length===0 && <div className="text-center text-xs text-gray-300 py-8">无跟进，来自邮件右侧“下次跟进”自动生成</div>}
      </div>
    </div>
  )
}
