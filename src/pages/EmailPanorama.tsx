import { useState, useEffect, useMemo } from 'react'
import { db } from '../db'

export default function EmailPanorama(){
  const [emails,setEmails]=useState<any[]>([])
  const [accounts,setAccounts]=useState<any[]>([])
  useEffect(()=>{ (async()=>{ setEmails(await db.emails.toArray()); setAccounts(await db.emailAccounts.toArray())})()},[])
  const hasAttach = emails.filter(e=> e.hasAttachment).length
  const services = useMemo(()=>{
    const m=new Map<string,number>()
    for(const e of emails){ const d=e.from.split('@')[1]?.split('>')[0]||'other'; m.set(d,(m.get(d)||0)+1)}
    return [...m.entries()].sort((a,b)=> b[1]-a[1]).slice(0,8)
  },[emails])
  const series = useMemo(()=>{
    const map=new Map<string,number>()
    for(const e of emails){ const day=e.date.slice(0,10); map.set(day,(map.get(day)||0)+1)}
    return [...map.entries()].sort((a,b)=> a[0].localeCompare(b[0])).slice(-30)
  },[emails])

  return (
    <div className="p-4 max-w-6xl mx-auto space-y-4">
      <h1 className="text-xl font-bold">📊 邮件资产全景</h1>
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-white rounded-2xl border p-4 text-center"><div className="text-xs text-gray-400">收录邮件</div><div className="text-2xl font-bold">{emails.length}封</div><div className="text-xs text-gray-400">来自 {accounts.length}个邮箱</div></div>
        <div className="bg-white rounded-2xl border p-4 text-center"><div className="text-xs text-gray-400">服务平台</div><div className="text-2xl font-bold">{services.length}项</div><div className="text-xs text-gray-400">SaaS与平台注册追踪</div></div>
        <div className="bg-white rounded-2xl border p-4 text-center"><div className="text-xs text-gray-400">附件归档</div><div className="text-2xl font-bold">{hasAttach}个</div><div className="text-xs text-gray-400">累计 762.93 MB (mock)</div></div>
      </div>
      <div className="grid lg:grid-cols-2 gap-3">
        <div className="bg-white rounded-2xl border p-4">
          <div className="text-xs font-semibold">SaaS与数字服务分类</div>
          <div className="mt-2 space-y-1">
            {services.map(([d,c])=>(
              <div key={d} className="flex items-center gap-2 text-xs">
                <span className="w-24 truncate">{d}</span>
                <div className="flex-1 h-2 bg-gray-100 rounded"><div className="h-2 bg-red-400 rounded" style={{width:`${Math.min(100, c*8)}%`}}/></div>
                <span>{c}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="bg-white rounded-2xl border p-4">
          <div className="text-xs font-semibold">收发时序 30天</div>
          <div className="mt-2 flex items-end gap-1 h-24">
            {series.map(([day,cnt])=> <div key={day} title={`${day} ${cnt}`} className="flex-1 bg-red-300 rounded-t" style={{height:`${Math.max(4, cnt*12)}px`}}/>)}
          </div>
          <div className="text-xs text-gray-300 mt-1">{series[0]?.[0]} → {series[series.length-1]?.[0]}</div>
        </div>
      </div>
    </div>
  )
}
