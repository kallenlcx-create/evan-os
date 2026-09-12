import { useState, useEffect, useMemo } from 'react'
import { db } from '../db'
import KnowledgeGraph from '../components/KnowledgeGraph'

export default function EmailGraphPage(){
  const [onlyKey, setOnlyKey]=useState(true)
  const [customers,setCustomers]=useState<any[]>([])
  const [emails,setEmails]=useState<any[]>([])
  useEffect(()=>{ const load=async()=>{ setCustomers(await db.customers.toArray()); setEmails(await db.emails.toArray())}; void load(); const h=()=> void load(); window.addEventListener('evan-emails-updated', h); window.addEventListener('evan-customers-updated', h); return ()=>{ window.removeEventListener('evan-emails-updated', h); window.removeEventListener('evan-customers-updated', h) }},[])
  const stats = useMemo(()=>{
    const map=new Map<string,number>()
    for(const e of emails){ const addr=e.from.match(/<(.+?)>/)?.[1]||e.from; map.set(addr,(map.get(addr)||0)+1)}
    const sorted=[...map.entries()].sort((a,b)=> b[1]-a[1]).slice(0,65)
    return sorted
  },[emails])
  const filteredStats = onlyKey? stats.filter(([addr])=> customers.find(c=> c.email===addr && c.isKey)) : stats

  return (
    <div className="p-4 max-w-6xl mx-auto space-y-3">
      <div className="flex items-center gap-2">
        <h1 className="text-xl font-bold">🕸️ 客户拓扑</h1>
        <span className="text-xs text-gray-400">力导向 · {filteredStats.length} 节点</span>
        <label className="ml-auto flex items-center gap-1 text-xs"><input type="checkbox" checked={onlyKey} onChange={e=> setOnlyKey(e.target.checked)}/> 默认只看重点</label>
        <button onClick={()=> setOnlyKey(v=> !v)} className="px-2 py-1 bg-white border rounded text-xs">{onlyKey?'显示全部':'只看重点'}</button>
      </div>
      <div className="grid lg:grid-cols-[1fr_300px] gap-3">
        <div className="bg-white rounded-2xl border p-2 h-[520px]">
          <KnowledgeGraph centerId={undefined} depth={1} height={500} onNodeClick={()=>{}}/>
          <div className="text-xs text-gray-400 p-2">节点大小=封数 · 颜色：蓝核心/黄SaaS/灰联系人 · 拖拽缩放</div>
        </div>
        <div className="bg-white rounded-2xl border p-3">
          <div className="text-xs font-semibold mb-2">核心往来排行（按封数） {onlyKey?'· 重点优先':''}</div>
          <div className="space-y-1 max-h-[460px] overflow-y-auto">
            {filteredStats.map(([addr,cnt],i)=>(
              <div key={addr} className="flex items-center gap-2 p-2 bg-gray-50 rounded text-xs">
                <span className="text-gray-400 w-4">{i+1}.</span>
                <span className="truncate flex-1">{addr}</span>
                <span className="text-red-500">{cnt}封</span>
              </div>
            ))}
            {filteredStats.length===0 && <div className="text-xs text-gray-300">暂无重点客户，去邮件标记 ⭐</div>}
          </div>
        </div>
      </div>
    </div>
  )
}
