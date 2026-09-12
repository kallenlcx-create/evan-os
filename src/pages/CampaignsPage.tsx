import { useState, useEffect } from 'react'
import { db } from '../db'
import { Send, Users, Filter, Sparkles } from 'lucide-react'

export default function CampaignsPage(){
  const [customers, setCustomers] = useState<any[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filterLevel, setFilterLevel] = useState<string>('all')
  const [days, setDays] = useState(7)
  const [preview, setPreview] = useState('')
  const [bulkFollow, setBulkFollow] = useState(()=> localStorage.getItem('evan:bulkFollow')!=='0')
  const [bulkMarketing, setBulkMarketing] = useState(()=> localStorage.getItem('evan:bulkMarketing')!=='0')
  const [bulkFollowTime, setBulkFollowTime] = useState(()=> localStorage.getItem('evan:bulkFollowTime')||'09:30')
  const [bulkMarketingTime, setBulkMarketingTime] = useState(()=> localStorage.getItem('evan:bulkMarketingTime')||'10:00')
  useEffect(()=> localStorage.setItem('evan:bulkFollow', bulkFollow?'1':'0'),[bulkFollow])
  useEffect(()=> localStorage.setItem('evan:bulkMarketing', bulkMarketing?'1':'0'),[bulkMarketing])
  useEffect(()=> localStorage.setItem('evan:bulkFollowTime', bulkFollowTime),[bulkFollowTime])
  useEffect(()=> localStorage.setItem('evan:bulkMarketingTime', bulkMarketingTime),[bulkMarketingTime])
  useEffect(()=>{ (async()=> setCustomers(await db.customers.toArray()))() },[])
  const filtered = customers.filter(c=>{
    if(filterLevel!=='all' && c.level!==filterLevel) return false
    // last contact > days  简化：用 updatedAt
    const last = new Date(c.updatedAt).getTime()
    const cutoff = Date.now() - days*86400000
    return last < cutoff
  })
  const toggle = (id:string)=> setSelected(s=>{ const n=new Set(s); if(n.has(id)) n.delete(id); else n.add(id); return n })
  const toggleAll = ()=> setSelected(filtered.length===selected.size? new Set(): new Set(filtered.map(c=>c.id)))
  const gen = async()=>{
    if(selected.size===0) return alert('先选客户')
    // Mock AI 差异化生成
    const names = filtered.filter(c=> selected.has(c.id)).map(c=>c.contactName||c.title).join('、')
    setPreview(`Hi ${names.split('、')[0]||'there'},\n\n这是为 ${selected.size} 位 ${filterLevel==='all'?'客户':filterLevel+'级客户'} 定制的跟进（上次联系>${days}天）。\n已按每人历史意向差异化：A级强调价格与交期，B级推新品。\n\nBest regards, Evan`)
  }
  return (
    <div className="p-4 max-w-6xl mx-auto space-y-4">
      <div className="flex items-center gap-2">
        <Users size={20} className="text-purple-500"/>
        <h1 className="text-xl font-bold">批量跟进 / 营销活动</h1>
        <span className="text-xs text-gray-400">Campaign Builder · 差异化生成非群发</span>
      </div>

      <div className="bg-white rounded-2xl border p-3 space-y-2">
        <div className="flex flex-wrap gap-2 items-center">
          <Filter size={14} className="text-gray-400"/>
          <select value={filterLevel} onChange={e=> setFilterLevel(e.target.value)} className="px-2 py-1 border rounded text-xs">
            <option value="all">全部等级</option><option value="A+">A+</option><option value="A">A</option><option value="B">B</option><option value="C">C</option>
          </select>
          <select value={days} onChange={e=> setDays(Number(e.target.value))} className="px-2 py-1 border rounded text-xs">
            <option value={7}>7天未联系</option><option value={14}>14天</option><option value={30}>30天</option><option value={90}>90天</option>
          </select>
          <span className="text-xs text-gray-400">{filtered.length} 人命中</span>
          <button onClick={toggleAll} className="ml-auto px-3 py-1 bg-white border rounded text-xs">{selected.size===filtered.length?'取消全选':'全选'}</button>
          <button onClick={gen} disabled={!bulkFollow && !bulkMarketing} className="px-3 py-1 bg-purple-600 text-white rounded text-xs flex items-center gap-1 disabled:opacity-40"><Sparkles size={12}/> AI 批量差异化生成</button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <label className="flex items-center justify-between p-2 bg-gray-50 rounded-xl border">
            <span className="text-xs font-medium">批量跟进</span>
            <span className="flex items-center gap-2">
              <input type="time" value={bulkFollowTime} onChange={e=> setBulkFollowTime(e.target.value)} className="px-2 py-1 border rounded text-xs"/>
              <input type="checkbox" checked={bulkFollow} onChange={e=> setBulkFollow(e.target.checked)} className="accent-blue-600"/>
              <span className={`text-xs ${bulkFollow?'text-green-600':'text-gray-300'}`}>{bulkFollow?'开启':'关闭'}</span>
            </span>
          </label>
          <label className="flex items-center justify-between p-2 bg-gray-50 rounded-xl border">
            <span className="text-xs font-medium">批量营销</span>
            <span className="flex items-center gap-2">
              <input type="time" value={bulkMarketingTime} onChange={e=> setBulkMarketingTime(e.target.value)} className="px-2 py-1 border rounded text-xs"/>
              <input type="checkbox" checked={bulkMarketing} onChange={e=> setBulkMarketing(e.target.checked)} className="accent-purple-600"/>
              <span className={`text-xs ${bulkMarketing?'text-purple-600':'text-gray-300'}`}>{bulkMarketing?'开启':'关闭'}</span>
            </span>
          </label>
        </div>
        {!bulkFollow && !bulkMarketing && <div className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded p-2">批量跟进与营销均已关闭，生成按钮已禁用</div>}
      </div>

      <div className="grid lg:grid-cols-[1fr_380px] gap-3">
        <div className="bg-white rounded-2xl border overflow-hidden">
          <div className="max-h-[420px] overflow-y-auto">
            {filtered.map(c=>(
              <label key={c.id} className="flex items-center gap-2 p-2 border-b hover:bg-gray-50 text-xs">
                <input type="checkbox" checked={selected.has(c.id)} onChange={()=> toggle(c.id)}/>
                <span className="font-medium">{c.contactName||c.title}</span>
                <span className="text-gray-400">{c.company}</span>
                <span className="ml-auto px-1.5 py-0.5 bg-gray-100 rounded">{c.level||'C'}</span>
                <span className="text-gray-300">{c.email}</span>
              </label>
            ))}
            {filtered.length===0 && <div className="p-8 text-center text-xs text-gray-300">无匹配，改筛选或先标记重点客户</div>}
          </div>
        </div>
        <div className="bg-white rounded-2xl border p-3">
          <div className="text-xs font-semibold mb-1">生成预览（每人不同）</div>
          <textarea value={preview} onChange={e=> setPreview(e.target.value)} placeholder="点左上 AI 生成后可编辑，支持 {{first_name}}/{{product}} 变量" className="w-full h-48 p-2 border rounded text-xs"/>
          <div className="flex gap-1 mt-2">
            <button onClick={()=> alert(`已加入 ${selected.size} 条 L2 待审（批量审核后发）`)} className="flex-1 py-2 bg-blue-600 text-white rounded text-xs flex items-center justify-center gap-1"><Send size={12}/> 批量审核后发送</button>
          </div>
          <div className="text-xs text-gray-400 mt-2">Level1 建议 · Level2 生成待审 · Level3 仅白名单自动发（安全）</div>
        </div>
      </div>
    </div>
  )
}
