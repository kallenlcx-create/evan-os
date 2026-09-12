import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { db } from '../db'
import type { Customer, EmailMessage } from '../types'
import { X } from 'lucide-react'

// ====== 邮箱分类（复用CustomersPage逻辑） ======
const PERSONAL_DOMAINS = ['gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com','live.com','aol.com','protonmail.com','mail.com','qq.com','163.com','126.com','foxmail.com']
function classifyEmailType(email?: string): string {
  if(!email) return '未知'
  const suffix = email.split('@')[1]?.toLowerCase() || ''
  if(suffix.endsWith('.gov')||suffix==='gov') return '政府'
  if(suffix.endsWith('.mil')||suffix==='mil') return '军队'
  if(suffix.endsWith('.edu')||suffix==='edu') return '教育'
  if(suffix.endsWith('.org')||suffix==='org') return '非盈利'
  if(PERSONAL_DOMAINS.includes(suffix)) return '个人'
  return '企业'
}
const TYPE_COLORS: Record<string,string> = { '政府':'#ef4444','军队':'#f97316','教育':'#3b82f6','非盈利':'#8b5cf6','个人':'#10b981','企业':'#6366f1','未知':'#9ca3af' }
const LEVEL_COLORS: Record<string,string> = { 'A+':'#f59e0b','A':'#f97316','B':'#3b82f6','C':'#6b7280','D':'#d1d5db' }
const LEVEL_LABELS: Record<string,string> = { 'A+':'VIP','A':'核心','B':'活跃','C':'普通','D':'沉睡' }

// ====== 金额提取 ======
function extractAmount(text: string): number {
  const p = [/\$\s*([\d,]+(?:\.\d{2})?)/g, /USD\s*([\d,]+(?:\.\d{2})?)/gi]
  let max = 0
  for(const rx of p){ let m; while((m=rx.exec(text))!==null){ const n=parseFloat(m[1].replace(/,/,'')); if(n>max) max=n } }
  return max
}

// ====== 简易力导向布局 ======
interface PosNode { id:string; x:number; y:number; vx:number; vy:number; label:string; level:string; emailType:string; emailCount:number; totalAmount:number; isKey:boolean; emoji:string; radius:number }
function forceLayout(nodes: PosNode[], edges:{source:string,target:string}[], w:number, h:number, iters=80): PosNode[] {
  const r=Math.min(w,h)/3, cx=w/2, cy=h/2
  nodes.forEach((n,i)=>{ const a=(i/nodes.length)*Math.PI*2-Math.PI/2; n.x=cx+Math.cos(a)*r; n.y=cy+Math.sin(a)*r; n.vx=0; n.vy=0 })
  const nm=new Map(nodes.map(n=>[n.id,n]))
  for(let iter=0;iter<iters;iter++){
    for(let i=0;i<nodes.length;i++) for(let j=i+1;j<nodes.length;j++){
      const dx=nodes[i].x-nodes[j].x, dy=nodes[i].y-nodes[j].y, dist=Math.sqrt(dx*dx+dy*dy)||1, f=2500/(dist*dist)
      nodes[i].vx+=(dx/dist)*f; nodes[i].vy+=(dy/dist)*f; nodes[j].vx-=(dx/dist)*f; nodes[j].vy-=(dy/dist)*f
    }
    for(const e of edges){ const s=nm.get(e.source),t=nm.get(e.target); if(!s||!t)continue; const dx=t.x-s.x,dy=t.y-s.y,dist=Math.sqrt(dx*dx+dy*dy)||1,f=(dist-100)*0.04; s.vx+=(dx/dist)*f;s.vy+=(dy/dist)*f;t.vx-=(dx/dist)*f;t.vy-=(dy/dist)*f }
    for(const n of nodes){ n.vx+=(cx-n.x)*0.008; n.vy+=(cy-n.y)*0.008; n.x+=n.vx*0.1; n.y+=n.vy*0.1; n.vx*=0.8; n.vy*=0.8; n.x=Math.max(40,Math.min(w-40,n.x)); n.y=Math.max(40,Math.min(h-40,n.y)) }
  }
  return nodes
}

export default function EmailGraphPage(){
  const [customers,setCustomers]=useState<Customer[]>([])
  const [emails,setEmails]=useState<EmailMessage[]>([])
  const [onlyKey,setOnlyKey]=useState(true)
  const [levelFilter,setLevelFilter]=useState<string>('all')
  const [typeFilter,setTypeFilter]=useState<string>('all')
  const [selected,setSelected]=useState<PosNode|null>(null)
  const [selectedCustomer,setSelectedCustomer]=useState<Customer|null>(null)
  const [selectedSummary,setSelectedSummary]=useState<{count:number;totalAmount:number;lastDate:string;topSubjects:string[];emailType:string}|null>(null)
  const [zoom,setZoom]=useState(1)
  const [pan,setPan]=useState({x:0,y:0})
  const isDrag=useRef(false)
  const dragStart=useRef({x:0,y:0})

  const load=useCallback(async()=>{
    setCustomers(await db.customers.toArray() as any[])
    setEmails(await db.emails.toArray() as any[])
  },[])
  useEffect(()=>{void load(); const h=()=>void load(); window.addEventListener('evan-emails-updated',h); window.addEventListener('evan-customers-updated',h); return()=>{window.removeEventListener('evan-emails-updated',h); window.removeEventListener('evan-customers-updated',h)}},[load])

  // 构建图数据
  const {nodes,edges,statsMap}=useMemo(()=>{
    const smap=new Map<string,{count:number;totalAmount:number;lastDate:string;subjects:string[]}>()
    for(const e of emails){
      const addr=(e.from.match(/<(.+?)>/)?.[1]||e.from).trim().toLowerCase()
      if(!addr||!addr.includes('@')) continue
      const s=smap.get(addr)||{count:0,totalAmount:0,lastDate:'',subjects:[]}
      s.count++
      s.totalAmount+=extractAmount(e.subject+' '+(e.text||''))
      if(!s.lastDate||e.date>s.lastDate) s.lastDate=e.date
      if(s.subjects.length<5) s.subjects.push(e.subject)
      smap.set(addr,s)
    }
    // 构建节点：每个客户一个
    const ns:PosNode[]=[]
    for(const c of customers){
      if(!c.email) continue
      const addr=c.email.toLowerCase()
      const s=smap.get(addr)
      if(onlyKey && !c.isKey) continue
      if(s && s.count===0) continue
      const emailType=classifyEmailType(c.email)
      const cLevel=c.level||'C'
      if(levelFilter!=='all' && cLevel!==levelFilter) continue
      if(typeFilter!=='all' && emailType!==typeFilter) continue
      const count=s?.count||0
      const amount=s?.totalAmount||0
      ns.push({
        id:c.id, label:c.contactName||c.title, level:c.level||'C', emailType,
        emailCount:count, totalAmount:amount, isKey:!!c.isKey,
        emoji: c.isKey?'⭐':'👤', radius: 8+Math.min(count*1.5,15),
        x:0,y:0,vx:0,vy:0
      })
    }
    // 构建边：同一邮件地址互连（简化：客户之间如有共同邮件往来则连接）
    const es:{source:string;target:string}[]=[]
    // 用邮件 from→to 构建客户间关系
    const emailAddrs=new Map<string,string[]>() // addr -> customerIds
    for(const c of customers){ if(c.email) emailAddrs.set(c.email.toLowerCase(), [...(emailAddrs.get(c.email.toLowerCase())||[]), c.id]) }
    for(const e of emails){
      const from=(e.from.match(/<(.+?)>/)?.[1]||e.from).trim().toLowerCase()
      const to=(e.to||'').toLowerCase()
      const fromC=emailAddrs.get(from)
      const toC=emailAddrs.get(to)
      if(fromC&&toC){ for(const a of fromC) for(const b of toC){ if(a!==b) es.push({source:a,target:b}) } }
    }
    return {nodes:ns,edges:es,statsMap:smap}
  },[customers,emails,onlyKey,levelFilter,typeFilter])

  const positioned=useMemo(()=>forceLayout([...nodes],edges,780,480,nodes.length<20?40:70),[nodes,edges])

  const handleClick=useCallback((node:PosNode)=>{
    setSelected(node)
    const c=customers.find(cc=>cc.id===node.id)
    setSelectedCustomer(c||null)
    const addr=(c?.email||'').toLowerCase()
    const s=statsMap.get(addr)
    setSelectedSummary(s?{count:s.count,totalAmount:s.totalAmount,lastDate:s.lastDate,topSubjects:s.subjects,emailType:classifyEmailType(c?.email)}:null)
  },[customers,statsMap])

  const nm=useMemo(()=>new Map(positioned.map(n=>[n.id,n])),[positioned])

  return(
    <div className="p-4 max-w-6xl mx-auto space-y-3">
      <div className="flex items-center gap-2">
        <h1 className="text-xl font-bold">🕸️ 客户拓扑</h1>
        <span className="text-xs text-gray-400">力导向 · {nodes.length} 节点</span>
        <label className="ml-auto flex items-center gap-1 text-xs"><input type="checkbox" checked={onlyKey} onChange={e=>setOnlyKey(e.target.checked)}/> 只看重点</label>
      </div>
      <div className="flex gap-1 flex-wrap text-[10px]">
        <span className="text-gray-400 self-center mr-1">等级:</span>
        {(['all','A+','A','B','C','D'] as const).map(l=> <button key={l} onClick={()=>setLevelFilter(l)} className={`px-2 py-0.5 rounded-full border ${levelFilter===l?'bg-blue-600 text-white':'bg-white text-gray-600'}`}>{l==='all'?'全部':l}</button>)}
        <span className="text-gray-300 self-center mx-1">|</span>
        <span className="text-gray-400 self-center mr-1">类型:</span>
        {(['all','政府','军队','教育','非盈利','个人','企业'] as const).map(t=> <button key={t} onClick={()=>setTypeFilter(t)} className={`px-2 py-0.5 rounded-full border ${typeFilter===t?'bg-blue-600 text-white':'bg-white text-gray-600'}`}>{t==='all'?'全部':t}</button>)}
      </div>
      <div className="grid lg:grid-cols-[1fr_300px] gap-3">
        {/* 图谱 */}
        <div className="bg-white rounded-2xl border p-2 relative" style={{height:500}}>
          <svg width="100%" height={480} className="cursor-grab active:cursor-grabbing"
            onMouseDown={e=>{isDrag.current=true;dragStart.current={x:e.clientX-pan.x,y:e.clientY-pan.y}}}
            onMouseMove={e=>{if(!isDrag.current)return;setPan({x:e.clientX-dragStart.current.x,y:e.clientY-dragStart.current.y})}}
            onMouseUp={()=>{isDrag.current=false}} onMouseLeave={()=>{isDrag.current=false}}
            onWheel={e=>{e.preventDefault();setZoom(z=>Math.max(0.3,Math.min(3,z+(e.deltaY>0?-0.1:0.1))))}}>
            <rect width="100%" height="100%" fill="#fafafa"/>
            {/* 边 */}
            <g>{edges.map((e,i)=>{
              const s=nm.get(e.source),t=nm.get(e.target); if(!s||!t) return null
              const sx=s.x*zoom+pan.x, sy=s.y*zoom+pan.y, tx=t.x*zoom+pan.x, ty=t.y*zoom+pan.y
              const hl=selected&&(selected.id===e.source||selected.id===e.target)
              return <line key={i} x1={sx} y1={sy} x2={tx} y2={ty} stroke={hl?'#6366f1':'#e5e7eb'} strokeWidth={hl?1.5:0.8}/>
            })}</g>
            {/* 节点 */}
            <g>{positioned.map(n=>{
              const cx=n.x*zoom+pan.x, cy=n.y*zoom+pan.y
              const sel=selected?.id===n.id
              const color=n.isKey?(LEVEL_COLORS[n.level]||'#f59e0b'):(TYPE_COLORS[n.emailType]||'#9ca3af')
              return(
                <g key={n.id} transform={`translate(${cx},${cy})`} className="cursor-pointer" onClick={()=>handleClick(n)}>
                  {sel && <circle r={n.radius+6} fill={color} opacity={0.2}/>}
                  <circle r={n.radius} fill={color} opacity={sel?1:0.85} stroke="white" strokeWidth={2}/>
                  <text textAnchor="middle" dominantBaseline="central" fontSize={n.radius*0.8} className="pointer-events-none select-none">{n.emoji}</text>
                  <text y={n.radius+12} textAnchor="middle" fill="#374151" fontSize="10" fontWeight={sel?600:400} className="pointer-events-none select-none">
                    {n.label.length>10?n.label.slice(0,10)+'…':n.label}
                  </text>
                  {n.emailCount>0 && <text x={n.radius-1} y={-n.radius+2} textAnchor="middle" fill="#fff" fontSize="8" className="pointer-events-none">{n.emailCount}</text>}
                </g>
              )
            })}</g>
          </svg>
          {/* 图例 */}
          <div className="absolute bottom-2 right-2 bg-white/90 border rounded-lg p-2 shadow-sm">
            <div className="text-[10px] text-gray-400 mb-1">等级/类型</div>
            <div className="flex flex-wrap gap-1.5 max-w-[220px]">
              {Object.entries(LEVEL_LABELS).map(([k,v])=><div key={k} className="flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{background:LEVEL_COLORS[k]}}/><span className="text-[10px] text-gray-500">{k} {v}</span></div>)}
              <span className="text-gray-300">|</span>
              {Object.entries(TYPE_COLORS).filter(([k])=>k!=='未知').map(([k,v])=><div key={k} className="flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{background:v}}/><span className="text-[10px] text-gray-500">{k}</span></div>)}
            </div>
          </div>
          <div className="absolute bottom-2 left-2 text-[10px] text-gray-400">节点大小=封数 · 拖拽缩放 · 点击查看详情</div>
        </div>

        {/* 右侧：排行榜 + 选中详情 */}
        <div className="space-y-3">
          {/* 选中客户总结 */}
          {selectedCustomer && selectedSummary && (
            <div className="bg-white rounded-2xl border p-3 space-y-2">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center text-blue-600 font-bold text-sm">{(selectedCustomer.contactName||selectedCustomer.title||'?')[0]}</div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-sm truncate">{selectedCustomer.contactName||selectedCustomer.title}</div>
                  <div className="text-[10px] text-gray-500 truncate">{selectedCustomer.email}</div>
                </div>
                <button onClick={()=>{setSelected(null);setSelectedCustomer(null)}} className="p-1 hover:bg-gray-100 rounded"><X size={14}/></button>
              </div>
              <div className="flex flex-wrap gap-1">
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${selectedCustomer.isKey?'bg-yellow-100 text-yellow-700':'bg-gray-100 text-gray-500'}`}>{selectedCustomer.level||'C'} {LEVEL_LABELS[selectedCustomer.level||'C']||''}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{background:TYPE_COLORS[selectedSummary.emailType]+'20',color:TYPE_COLORS[selectedSummary.emailType]}}>{selectedSummary.emailType}</span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="bg-blue-50 rounded-lg p-2"><div className="text-blue-400 text-[10px]">邮件往来</div><div className="font-bold text-blue-700">{selectedSummary.count} 封</div></div>
                <div className="bg-green-50 rounded-lg p-2"><div className="text-green-400 text-[10px]">累计金额</div><div className="font-bold text-green-700">{selectedSummary.totalAmount>0?'$'+selectedSummary.totalAmount.toLocaleString():'—'}</div></div>
              </div>
              <div className="text-[10px] text-gray-400">最近联系 {selectedSummary.lastDate ? new Date(selectedSummary.lastDate).toLocaleDateString():'—'}</div>
              {selectedSummary.topSubjects.length>0 && (
                <div><div className="text-[10px] text-gray-400 mb-1">近期主题</div>
                  <div className="space-y-0.5">{selectedSummary.topSubjects.map((s,i)=><div key={i} className="text-[11px] text-gray-600 truncate bg-gray-50 rounded px-2 py-0.5">📧 {s}</div>)}</div>
                </div>
              )}
              {selectedCustomer.aiSummary && <div className="text-[10px] bg-purple-50 rounded p-1.5">{selectedCustomer.aiSummary}</div>}
            </div>
          )}

          {/* 排行榜 */}
          <div className="bg-white rounded-2xl border p-3">
            <div className="text-xs font-semibold mb-2">核心往来排行（按封数）</div>
            <div className="space-y-1 max-h-[340px] overflow-y-auto">
              {positioned.sort((a,b)=>b.emailCount-a.emailCount).map((n,i)=>(
                <div key={n.id} onClick={()=>handleClick(n)} className={`flex items-center gap-2 p-1.5 rounded text-xs cursor-pointer hover:bg-gray-50 ${selected?.id===n.id?'bg-blue-50':''}`}>
                  <span className="text-gray-400 w-4 text-right">{i+1}</span>
                  <span className="w-2 h-2 rounded-full shrink-0" style={{background:n.isKey?LEVEL_COLORS[n.level]:TYPE_COLORS[n.emailType]}}/>
                  <span className="truncate flex-1">{n.label}</span>
                  <span className="text-[10px] px-1 py-0.5 rounded" style={{background:(TYPE_COLORS[n.emailType]||'#9ca3af')+'15',color:TYPE_COLORS[n.emailType]||'#9ca3af'}}>{n.emailType}</span>
                  <span className="text-red-500 text-[10px]">{n.emailCount}封</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
