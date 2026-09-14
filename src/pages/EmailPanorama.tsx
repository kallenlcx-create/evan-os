import { useState, useEffect, useMemo } from 'react'
import { db } from '../db'
import type { EmailMessage } from '../types'

const TYPE_COLORS: Record<string,string> = { '政府':'#ef4444','军队':'#f97316','教育':'#3b82f6','非盈利':'#8b5cf6','个人':'#10b981','企业':'#6366f1','未知':'#9ca3af' }
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

function extractAmount(text: string): number {
  const p = [/\$\s*([\d,]+(?:\.\d{2})?)/g, /USD\s*([\d,]+(?:\.\d{2})?)/gi]
  let max = 0
  for(const rx of p){ let m; while((m=rx.exec(text))!==null){ const n=parseFloat(m[1].replace(/,/g,'')); if(n>max) max=n } }
  return max
}

export default function EmailPanorama(){
  const [emails,setEmails]=useState<EmailMessage[]>([])
  const [accounts,setAccounts]=useState<any[]>([])
  const [customers,setCustomers]=useState<any[]>([])
  useEffect(()=>{ const load=async()=>{ setEmails(await db.emails.toArray()); setAccounts(await db.emailAccounts.toArray()); setCustomers(await db.customers.toArray())}; void load(); const h=()=> void load(); window.addEventListener('evan-emails-updated', h); window.addEventListener('evan-customers-updated', h); return ()=>{ window.removeEventListener('evan-emails-updated', h); window.removeEventListener('evan-customers-updated', h) }},[])

  // === 客户标签分布 ===
  const tagStats = useMemo(()=>{
    const m=new Map<string,number>()
    for(const c of customers) for(const t of (c.tags||[])) m.set(t,(m.get(t)||0)+1)
    return [...m.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10)
  },[customers])
  const maxTag = tagStats[0]?.[1]||1

  // === 基础统计 ===
  const stats = useMemo(()=>{
    let totalAmount=0, hasAttach=0, sentCount=0, receivedCount=0
    const intentMap: Record<string,number> = {}
    const productMap: Record<string,number> = {}
    const customerEmails = new Set<string>()
    for(const e of emails){
      totalAmount += extractAmount(e.subject+' '+(e.text||''))
      if(e.hasAttachment) hasAttach++
      const from = (e.from||'').toLowerCase()
      if(from.includes('evan@maxemblem.com')) sentCount++
      else receivedCount++
      const intent = e.intent || '其他'
      intentMap[intent] = (intentMap[intent]||0)+1
      const product = e.product || 'Coin'
      productMap[product] = (productMap[product]||0)+1
      const addr = (e.from.match(/<(.+?)>/)?.[1]||e.from||'').trim().toLowerCase()
      if(addr && addr.includes('@') && !from.includes('evan@maxemblem.com')) customerEmails.add(addr)
    }
    return { totalAmount, hasAttach, sentCount, receivedCount, intentMap, productMap, customerCount: customerEmails.size }
  },[emails])

  // === 域名分布 ===
  const domains = useMemo(()=>{
    const m=new Map<string,{count:number,amount:number}>()
    for(const e of emails){
      const addr=(e.from.match(/<(.+?)>/)?.[1]||e.from||'').trim().toLowerCase()
      const d=addr.split('@')[1]||'other'
      const s=m.get(d)||{count:0,amount:0}
      s.count++
      s.amount+=extractAmount(e.subject+' '+(e.text||''))
      m.set(d,s)
    }
    return [...m.entries()].sort((a,b)=> b[1].count-a[1].count).slice(0,12)
  },[emails])

  // === 收件类型分布 ===
  const typeDist = useMemo(()=>{
    const m=new Map<string,number>()
    for(const e of emails){
      const addr=(e.from.match(/<(.+?)>/)?.[1]||e.from||'').trim().toLowerCase()
      const t=classifyEmailType(addr)
      m.set(t,(m.get(t)||0)+1)
    }
    return [...m.entries()].sort((a,b)=> b[1]-a[1])
  },[emails])

  // === 每月收发趋势 ===
  const monthly = useMemo(()=>{
    const m=new Map<string,{sent:number,received:number}>()
    for(const e of emails){
      const month=e.date.slice(0,7)
      const s=m.get(month)||{sent:0,received:0}
      if((e.from||'').toLowerCase().includes('evan@maxemblem.com')) s.sent++
      else s.received++
      m.set(month,s)
    }
    return [...m.entries()].sort((a,b)=> a[0].localeCompare(b[0])).slice(-12)
  },[emails])

  // === 最近30天时序 ===
  const series = useMemo(()=>{
    const map=new Map<string,{sent:number,received:number}>()
    for(const e of emails){
      const day=e.date.slice(0,10)
      const s=map.get(day)||{sent:0,received:0}
      if((e.from||'').toLowerCase().includes('evan@maxemblem.com')) s.sent++
      else s.received++
      map.set(day,s)
    }
    return [...map.entries()].sort((a,b)=> a[0].localeCompare(b[0])).slice(-30)
  },[emails])

  // === Top 金额客户 ===
  const topAmount = useMemo(()=>{
    const m=new Map<string,{name:string,count:number,amount:number}>()
    for(const e of emails){
      const addr=(e.from.match(/<(.+?)>/)?.[1]||e.from||'').trim().toLowerCase()
      if(!addr||!addr.includes('@')) continue
      const s=m.get(addr)||{name:e.from.split('<')[0].trim()||addr,count:0,amount:0}
      s.count++
      s.amount+=extractAmount(e.subject+' '+(e.text||''))
      m.set(addr,s)
    }
    return [...m.values()].filter(v=>v.amount>0).sort((a,b)=>b.amount-a.amount).slice(0,8)
  },[emails])

  const maxDomainCount = domains[0]?.[1].count||1
  const maxMonthly = Math.max(...monthly.map(m=>m[1].sent+m[1].received),1)

  return (
    <div className="p-4 max-w-6xl mx-auto space-y-4">
      <h1 className="text-xl font-bold">📊 邮件资产全景</h1>

      {/* 核心指标 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-white rounded-2xl border p-4 text-center">
          <div className="text-xs text-gray-400">收录邮件</div>
          <div className="text-2xl font-bold">{emails.length}</div>
          <div className="text-xs text-gray-400">来自 {accounts.length} 个邮箱</div>
        </div>
        <div className="bg-white rounded-2xl border p-4 text-center">
          <div className="text-xs text-gray-400">往来客户</div>
          <div className="text-2xl font-bold text-blue-600">{stats.customerCount}</div>
          <div className="text-xs text-gray-400">独立发件人</div>
        </div>
        <div className="bg-white rounded-2xl border p-4 text-center">
          <div className="text-xs text-gray-400">收发比</div>
          <div className="text-2xl font-bold"><span className="text-blue-500">{stats.receivedCount}</span> / <span className="text-green-500">{stats.sentCount}</span></div>
          <div className="text-xs text-gray-400">收件 / 发件</div>
        </div>
        <div className="bg-white rounded-2xl border p-4 text-center">
          <div className="text-xs text-gray-400">提及金额</div>
          <div className="text-2xl font-bold text-green-600">{stats.totalAmount>0?'$'+stats.totalAmount.toLocaleString():'—'}</div>
          <div className="text-xs text-gray-400">邮件中提及</div>
        </div>
      </div>

      {/* 产品分布 + 意图分布 + 附件 */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <div className="bg-white rounded-2xl border p-4">
          <div className="text-xs font-semibold mb-3">📦 产品分布</div>
          <div className="space-y-2">
            {Object.entries(stats.productMap).sort((a,b)=>b[1]-a[1]).map(([k,v])=>{
              const pct=Math.round(v/emails.length*100)
              return (
                <div key={k} className="flex items-center gap-2 text-xs">
                  <span className="w-14 text-right font-medium text-gray-600">{k}</span>
                  <div className="flex-1 h-2.5 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-2.5 rounded-full bg-indigo-400" style={{width:`${pct}%`}}/>
                  </div>
                  <span className="w-12 text-right text-gray-500">{v}封 ({pct}%)</span>
                </div>
              )
            })}
            {Object.keys(stats.productMap).length===0 && <div className="text-xs text-gray-300 text-center py-4">暂无数据</div>}
          </div>
        </div>
        <div className="bg-white rounded-2xl border p-4">
          <div className="text-xs font-semibold mb-3">🧠 意图分布</div>
          <div className="space-y-2">
            {Object.entries(stats.intentMap).sort((a,b)=>b[1]-a[1]).map(([k,v])=>{
              const pct=Math.round(v/emails.length*100)
              return (
                <div key={k} className="flex items-center gap-2 text-xs">
                  <span className="w-14 text-right font-medium text-gray-600">{k}</span>
                  <div className="flex-1 h-2.5 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-2.5 rounded-full bg-purple-400" style={{width:`${pct}%`}}/>
                  </div>
                  <span className="w-12 text-right text-gray-500">{v}封 ({pct}%)</span>
                </div>
              )
            })}
          </div>
        </div>
        <div className="bg-white rounded-2xl border p-4">
          <div className="text-xs font-semibold mb-3">📎 附件归档</div>
          <div className="text-center py-4">
            <div className="text-3xl font-bold text-orange-500">{stats.hasAttach}</div>
            <div className="text-xs text-gray-400 mt-1">封含附件</div>
            <div className="text-xs text-gray-400">占比 {emails.length>0?Math.round(stats.hasAttach/emails.length*100):0}%</div>
          </div>
        </div>
      </div>

      {/* 域名分布 + 收件类型 + 标签分布 */}
      <div className="grid lg:grid-cols-3 gap-3">
        <div className="bg-white rounded-2xl border p-4">
          <div className="text-xs font-semibold mb-3">🌐 域名分布 Top 12</div>
          <div className="space-y-1.5">
            {domains.map(([d,s])=>(
              <div key={d} className="flex items-center gap-2 text-xs">
                <span className="w-28 truncate text-gray-600">{d}</span>
                <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-2 rounded-full" style={{width:`${Math.min(100,s.count/maxDomainCount*100)}%`, background: TYPE_COLORS[classifyEmailType('x@'+d)]||'#6366f1'}}/>
                </div>
                <span className="w-8 text-right text-gray-500">{s.count}</span>
                {s.amount>0 && <span className="w-16 text-right text-green-600">${s.amount.toLocaleString()}</span>}
              </div>
            ))}
          </div>
        </div>
        <div className="bg-white rounded-2xl border p-4">
          <div className="text-xs font-semibold mb-3">🏷️ 收件类型分布</div>
          <div className="space-y-2 mt-3">
            {typeDist.map(([t,c])=>{
              const pct=Math.round(c/emails.length*100)
              return (
                <div key={t} className="flex items-center gap-2 text-xs">
                  <span className="w-10 text-right font-medium" style={{color:TYPE_COLORS[t]||'#9ca3af'}}>{t}</span>
                  <div className="flex-1 h-3 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-3 rounded-full" style={{width:`${pct}%`, background:TYPE_COLORS[t]||'#9ca3af'}}/>
                  </div>
                  <span className="w-12 text-right text-gray-500">{c}封 ({pct}%)</span>
                </div>
              )
            })}
          </div>
        </div>
        <div className="bg-white rounded-2xl border p-4">
          <div className="text-xs font-semibold mb-3">🏷️ 客户标签分布</div>
          <div className="space-y-2">
            {tagStats.map(([t,c])=>{
              const pct=Math.round(c/Math.max(1,customers.length)*100)
              return (
                <div key={t} className="flex items-center gap-2 text-xs">
                  <span className="w-20 truncate text-right font-medium text-teal-600">{t}</span>
                  <div className="flex-1 h-3 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-3 rounded-full bg-teal-400" style={{width:`${Math.min(100,c/maxTag*100)}%`}}/>
                  </div>
                  <span className="w-16 text-right text-gray-500">{c}人 ({pct}%)</span>
                </div>
              )
            })}
            {tagStats.length===0 && <div className="text-xs text-gray-300 text-center py-4">暂无标签（客户页添加）</div>}
          </div>
        </div>
      </div>

      {/* 收发趋势 + 金额客户 */}
      <div className="grid lg:grid-cols-2 gap-3">
        <div className="bg-white rounded-2xl border p-4">
          <div className="text-xs font-semibold mb-3">📈 月度收发趋势</div>
          <div className="flex items-end gap-1 h-32">
            {monthly.map(([m,s])=>{
              const total=s.sent+s.received
              const h=Math.max(4, total/maxMonthly*120)
              return (
                <div key={m} className="flex-1 flex flex-col items-center gap-0.5" title={`${m}: 收${s.received} 发${s.sent}`}>
                  <div className="w-full flex flex-col" style={{height:h}}>
                    <div className="flex-1 bg-blue-300 rounded-t" style={{flex:s.received, minHeight:2}}/>
                    <div className="flex-1 bg-green-300 rounded-b" style={{flex:s.sent, minHeight:2}}/>
                  </div>
                  <span className="text-[8px] text-gray-400">{m.slice(5)}</span>
                </div>
              )
            })}
          </div>
          <div className="flex items-center gap-3 mt-2 text-[10px] text-gray-400 justify-center">
            <span className="flex items-center gap-1"><span className="w-2 h-2 bg-blue-300 rounded"/>收件</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 bg-green-300 rounded"/>发件</span>
          </div>
        </div>
        <div className="bg-white rounded-2xl border p-4">
          <div className="text-xs font-semibold mb-3">💰 金额 Top 客户</div>
          {topAmount.length>0 ? (
            <div className="space-y-1.5">
              {topAmount.map((c,i)=>(
                <div key={i} className="flex items-center gap-2 text-xs">
                  <span className="text-gray-400 w-4 text-right">{i+1}</span>
                  <span className="w-2 h-2 rounded-full bg-green-400 shrink-0"/>
                  <span className="truncate flex-1">{c.name}</span>
                  <span className="text-gray-400">{c.count}封</span>
                  <span className="text-green-600 font-medium">${c.amount.toLocaleString()}</span>
                </div>
              ))}
            </div>
          ) : <div className="text-xs text-gray-300 text-center py-8">暂无金额数据</div>}
        </div>
      </div>

      {/* 30天时序 */}
      <div className="bg-white rounded-2xl border p-4">
        <div className="text-xs font-semibold mb-3">📅 近30天收发时序</div>
        <div className="flex items-end gap-px h-20">
          {series.map(([day,s])=>{
            return (
              <div key={day} title={`${day}: 收${s.received} 发${s.sent}`} className="flex-1 flex flex-col" style={{minWidth:2}}>
                <div className="flex-1 flex flex-col">
                  <div className="bg-blue-200 rounded-t" style={{flex:s.received,minHeight:1}}/>
                  <div className="bg-green-200 rounded-b" style={{flex:s.sent,minHeight:1}}/>
                </div>
              </div>
            )
          })}
        </div>
        <div className="text-[9px] text-gray-300 mt-1 flex justify-between"><span>{series[0]?.[0]}</span><span>{series[series.length-1]?.[0]}</span></div>
      </div>
    </div>
  )
}
