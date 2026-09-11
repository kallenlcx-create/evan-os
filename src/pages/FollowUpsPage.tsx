import { useState, useEffect } from 'react'
import { db } from '../db'
import type { FollowUpRecord } from '../types'
import { Calendar, Check, Clock } from 'lucide-react'

export default function FollowUpsPage(){
  const [list,setList]=useState<FollowUpRecord[]>([])
  const [filter,setFilter]=useState<'today'|'week'|'overdue'|'all'>('today')
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
