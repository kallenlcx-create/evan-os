import { useState, useEffect, useCallback } from 'react'
import { getOAuthAppConfig, saveOAuthAppConfig, getOAuthAuthUrl, getOAuthStatus, disconnectOAuth } from '../repositories/emailRepository'

async function pollUntilConnected(accountId: string, timeoutMs = 120000): Promise<boolean>{
  const t0 = Date.now()
  while(Date.now() - t0 < timeoutMs){
    await new Promise(r=>setTimeout(r, 3000))
    try{
      const s = await getOAuthStatus(accountId).catch(()=>null)
      if(s && s.connected) return true
    }catch{}
  }
  return false
}

export function OAuthBindButton({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const start = async () => {
    setBusy(true)
    try{
      const url = await getOAuthAuthUrl('')
      window.open(url, '_blank', 'width=560,height=700')
      const { listAccounts } = await import('../repositories/emailRepository')
      const before = new Set<string>()
      try{ (await listAccounts()).forEach((a:any)=> before.add(a.id)) }catch{}
      const t0 = Date.now()
      let ok = false
      while(Date.now() - t0 < 180000){
        await new Promise(r=>setTimeout(r, 4000))
        try{
          const accs = await listAccounts()
          for(const a of accs as any[]){
            if(!before.has(a.id) || ((a.provider||'')==='gmail')){
              try{ const s = await getOAuthStatus(a.id); if(s.connected){ ok = true; break } }catch{}
            }
          }
          if(ok) break
        }catch{}
      }
      if(ok){ alert('Gmail 授权成功，已开始可用新引擎同步'); onDone() }
      else alert('未检测到授权完成，如已授权请点刷新重试')
    }catch(e:any){ alert('获取授权链接失败：' + String(e.message||e).slice(0,150)) }
    finally{ setBusy(false) }
  }
  return <button onClick={start} disabled={busy} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">{busy ? '等待 Google 授权…' : '🔐 用 Google 账号授权绑定'}</button>
}

export function OAuthBadge({ accountId, email, onChanged }: { accountId: string; email: string; onChanged: () => void }) {
  const [st, setSt] = useState<{ connected: boolean; historyId: boolean } | null>(null)
  const load = useCallback(async () => {
    try{ const s = await getOAuthStatus(accountId); setSt({ connected: s.connected, historyId: s.historyId }) }
    catch{ setSt(null) }
  }, [accountId])
  useEffect(()=>{ void load() }, [load])
  const reauth = async () => {
    try{
      const url = await getOAuthAuthUrl(accountId)
      window.open(url, '_blank', 'width=560,height=700')
      const ok = await pollUntilConnected(accountId)
      if(ok){ alert('升级成功：该邮箱已从 IMAP 授权码切换为 Google 官方 API 模式，IMAP 监听已自动停用，去点一次同步即可'); await load(); onChanged() }
      else alert('未检测到授权完成（请确认在 Google 页面点了允许）')
    }catch(e:any){ alert(String(e.message||e).slice(0,150)) }
  }
  const unbind = async () => {
    if(!confirm(`解除 ${email} 的 Google 授权？（本地邮件库保留）`)) return
    await disconnectOAuth(accountId)
    await load(); onChanged()
  }
  if(st === null) return <span className="text-[11px] text-gray-400">{email} · 状态查询中…</span>
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-1 bg-white border rounded-lg text-[11px]">
      <span className={`w-1.5 h-1.5 rounded-full ${st.connected ? 'bg-green-500' : 'bg-gray-300'}`} />
      {email} · {st.connected ? `OAuth 已连接${st.historyId ? '（增量游标就绪）' : ''}` : 'IMAP 授权码模式（易限流）'}
      {st.connected
        ? <button onClick={unbind} className="text-gray-400 hover:text-red-500">解绑</button>
        : <button onClick={reauth} className="text-blue-600 hover:underline font-medium">⬆️ 升级到官方 API</button>}
    </span>
  )
}

export function OAuthAppForm() {
  const [cid, setCid] = useState('')
  const [sec, setSec] = useState('')
  const [info, setInfo] = useState('')
  useEffect(()=>{ getOAuthAppConfig().then(c=> setInfo(c.hasId ? `已配置 Client ID${c.hasSecret ? ' + Secret' : '（缺 Secret）'}` : '未配置')).catch(()=>{}) },[])
  const save = async () => {
    if(!cid.trim() && !sec.trim()) return
    try{
      const j = await saveOAuthAppConfig(cid.trim(), sec.trim())
      setInfo(`已保存（ID:${j.hasId?'✓':'×'} Secret:${j.hasSecret?'✓':'×'}），回调地址以服务端为准`)
      setSec('')
    }catch(e:any){ alert(String(e.message||e).slice(0,150)) }
  }
  return (
    <div className="mt-2 space-y-1.5">
      <div className="text-[11px]">状态：{info || '…'}</div>
      <input value={cid} onChange={e=> setCid(e.target.value)} placeholder="Client ID（xxx.apps.googleusercontent.com）" className="w-full px-2 py-1 border rounded text-[11px]" />
      <input value={sec} onChange={e=> setSec(e.target.value)} placeholder="Client Secret（只填一次，不回显）" type="password" className="w-full px-2 py-1 border rounded text-[11px]" />
      <button onClick={save} className="px-3 py-1 bg-white border rounded text-[11px] hover:border-blue-300">保存</button>
      <div className="text-[10px] text-gray-400">回调 URI（填到 GCP 凭据页）：https://win-8c09k6b093h.tail73fe40.ts.net/email/oauth/callback</div>
    </div>
  )
}
