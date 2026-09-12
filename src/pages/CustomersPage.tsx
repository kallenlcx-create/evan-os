import { useState, useEffect } from 'react'
import { db } from '../db'
import type { Customer } from '../types'
import { Star, Search, Calendar } from 'lucide-react'

export default function CustomersPage(){
  const [list, setList] = useState<Customer[]>([])
  const [filter, setFilter] = useState<'all'|'A+'|'A'|'B'|'C'|'D'|'key'>( 'all')
  const [q,setQ]=useState('')
  const load=async()=> setList(await db.customers.toArray() as any)
  useEffect(()=>{void load(); const h=()=> void load(); window.addEventListener('evan-emails-updated', h); window.addEventListener('evan-customers-updated', h); return ()=>{ window.removeEventListener('evan-emails-updated', h); window.removeEventListener('evan-customers-updated', h) }},[])
  const filtered = list.filter(c=>{
    if(filter==='key' && !c.isKey) return false
    if(['A+','A','B','C','D'].includes(filter) && c.level!==filter) return false
    if(q && !`${c.title} ${c.company} ${c.email}`.toLowerCase().includes(q.toLowerCase())) return false
    return true
  })
  return (
    <div className="p-4 max-w-6xl mx-auto space-y-3">
      <div className="flex items-center gap-2">
        <h1 className="text-xl font-bold">👥 客户</h1>
        <span className="text-xs text-gray-400">{filtered.length} / {list.length}</span>
          <button onClick={()=> setFilter('key' as any)} className={`ml-auto px-3 py-1 rounded-full text-xs ${filter==='key'?'bg-yellow-500 text-white':'bg-white border'}`}>⭐ 重点</button>
      </div>
      <div className="flex gap-1 flex-wrap">
        {(['all','A+','A','B','C','D'] as const).map(l=> <button key={l} onClick={()=> setFilter(l as any)} className={`px-3 py-1 rounded-full text-xs border ${filter===l?'bg-blue-600 text-white':'bg-white'}`}>{l==='all'?'全部':l}</button>)}
        <div className="ml-auto relative"><Search size={12} className="absolute left-2 top-2 text-gray-300"/><input value={q} onChange={e=>setQ(e.target.value)} placeholder="搜公司/邮箱" className="pl-6 pr-2 py-1 border rounded-lg text-xs"/></div>
      </div>
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
        {filtered.map(c=>(
          <div key={c.id} className={`bg-white rounded-2xl border p-4 ${c.isKey?'border-yellow-200 bg-yellow-50/30':''}`}>
            <div className="flex items-center gap-2">
              <span className="font-semibold text-sm">{c.contactName||c.title}</span>
              {c.isKey && <Star size={12} className="text-yellow-500"/>}
              <span className="ml-auto text-xs px-1.5 py-0.5 bg-gray-100 rounded">{c.level||'C'}</span>
            </div>
            <div className="text-xs text-gray-500">{c.company} · {c.email}</div>
            <div className="text-xs mt-1">评分 {c.score||'-'} | {c.stage}</div>
            {c.aiSummary && <div className="text-xs bg-purple-50 rounded p-2 mt-2">{c.aiSummary}</div>}
            <div className="text-xs text-gray-400 flex items-center gap-1 mt-2"><Calendar size={10}/> 下次 {c.followUpAt||'—'}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
