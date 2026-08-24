// ====== SyncPage — 云同步 ======
// 多设备/多地区数据同步：IndexedDB 本地主库 + MySQL 云端副本 + LWW 合并

import { useState, useEffect, useCallback } from 'react'
import { CloudUpload, LogIn, LogOut, RefreshCw, CheckCircle2, XCircle, CloudOff } from 'lucide-react'
import {
  cloudSync, getSyncConfig, SYNC_TABLES,
  type SyncSummary,
} from '../services/cloudSync'
import type { CloudSyncConfig } from '../types'

export default function SyncPage() {
  const [cfg, setCfg] = useState<CloudSyncConfig | null>(null)
  const [serverUrl, setServerUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [summary, setSummary] = useState<SyncSummary | null>(null)
  const [pending, setPending] = useState(0)

  const refresh = useCallback(async () => {
    const config = await getSyncConfig()
    setCfg(config)
    setServerUrl(config?.serverUrl ?? 'http://localhost:3000')
    setUsername(config?.username ?? '')
    setPending(await cloudSync.pendingCount())
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const handleLogin = async () => {
    if (!serverUrl.trim() || !username.trim() || !password.trim()) {
      setMessage({ ok: false, text: '请填写服务器地址、用户名和密码' })
      return
    }
    setBusy('login')
    setMessage(null)
    try {
      await cloudSync.configure(serverUrl.trim(), username.trim())
      await cloudSync.login(password)
      await cloudSync.configure(serverUrl.trim(), username.trim())
      setMessage({ ok: true, text: '登录成功（新用户名会自动注册）' })
    } catch (e) {
      setMessage({ ok: false, text: String(e).slice(0, 160) })
    } finally {
      setBusy('')
      refresh()
    }
  }

  const handleLogout = async () => {
    await cloudSync.logout()
    setMessage({ ok: true, text: '已退出登录' })
    refresh()
  }

  const handleSync = async () => {
    setBusy('sync')
    setMessage(null)
    try {
      const s = await cloudSync.syncNow()
      setSummary(s)
      setMessage({
        ok: true,
        text: `同步完成：推送 ${s.pushedRows} 行（${s.tablesPushed} 表）· 拉取 ${s.pulledRows} 行 · 应用 ${s.appliedRows} 行 · 删除 ${s.appliedDeletions} · 冲突保留本地 ${s.skippedConflicts}`,
      })
    } catch (e) {
      setMessage({ ok: false, text: `同步失败：${String(e).slice(0, 200)}` })
    } finally {
      setBusy('')
      refresh()
    }
  }

  const loggedIn = !!cfg?.token

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-2 mb-1">
        {loggedIn
          ? <CloudUpload size={22} className="text-green-500" />
          : <CloudOff size={22} className="text-gray-400" />}
        <h1 className="text-xl font-bold text-gray-800">云同步</h1>
        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
          loggedIn ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
        }`}>
          {loggedIn ? `已登录 · ${cfg!.username}` : '未登录'}
        </span>
      </div>
      <p className="text-xs text-gray-400 mb-5">
        IndexedDB 始终是本地主库（离线可用）。同步采用 Last-Write-Wins 合并 + 删除墓碑传播，
        覆盖 {SYNC_TABLES.length} 张业务表。服务器部署见仓库 server/ 目录。
      </p>

      {/* 状态卡 */}
      {loggedIn && (
        <div className="grid grid-cols-3 gap-2 mb-4">
          <Stat label="上次推送" value={cfg?.lastPushAt ? new Date(cfg.lastPushAt).toLocaleString() : '从未'} />
          <Stat label="上次拉取" value={cfg?.lastPullCursor ? new Date(cfg.lastPullCursor).toLocaleString() : '从未'} />
          <Stat label="待推送变更" value={`${pending} 条`} highlight={pending > 0} />
        </div>
      )}

      {/* 配置表单 */}
      <div className="bg-white border border-gray-200 rounded-2xl p-4 mb-4 space-y-3">
        <div>
          <label className="block text-[11px] text-gray-400 mb-1">同步服务器地址</label>
          <input
            value={serverUrl}
            onChange={e => setServerUrl(e.target.value)}
            placeholder="https://sync.your-domain.com"
            disabled={loggedIn}
            className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-100 disabled:bg-gray-50 disabled:text-gray-400"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[11px] text-gray-400 mb-1">用户名（各设备使用同一账号）</label>
            <input
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="evan"
              disabled={loggedIn}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-100 disabled:bg-gray-50 disabled:text-gray-400"
            />
          </div>
          <div>
            <label className="block text-[11px] text-gray-400 mb-1">密码</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !loggedIn && handleLogin()}
              placeholder={loggedIn ? '已登录' : '首次输入即注册'}
              disabled={loggedIn}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-100 disabled:bg-gray-50"
            />
          </div>
        </div>

        {!loggedIn ? (
          <button onClick={handleLogin} disabled={!!busy}
            className="flex items-center gap-1.5 px-4 py-2 bg-blue-500 text-white rounded-xl text-sm font-medium hover:bg-blue-600 disabled:opacity-50">
            <LogIn size={14} /> {busy === 'login' ? '登录中…' : '登录 / 注册'}
          </button>
        ) : (
          <div className="flex gap-2">
            <button onClick={handleSync} disabled={busy === 'sync'}
              className="flex items-center gap-1.5 px-4 py-2 bg-green-500 text-white rounded-xl text-sm font-medium hover:bg-green-600 disabled:opacity-50">
              <RefreshCw size={14} className={busy === 'sync' ? 'animate-spin' : ''} />
              {busy === 'sync' ? '同步中…' : '立即同步'}
            </button>
            <button onClick={handleLogout}
              className="flex items-center gap-1.5 px-4 py-2 bg-gray-100 text-gray-600 rounded-xl text-sm hover:bg-gray-200">
              <LogOut size={14} /> 退出登录
            </button>
          </div>
        )}
      </div>

      {/* 消息 */}
      {message && (
        <div className={`flex items-start gap-2 border rounded-xl p-3 mb-4 text-xs ${
          message.ok ? 'bg-green-50 border-green-200 text-green-700' : 'bg-red-50 border-red-200 text-red-600'
        }`}>
          {message.ok ? <CheckCircle2 size={14} className="mt-0.5 shrink-0" /> : <XCircle size={14} className="mt-0.5 shrink-0" />}
          <span className="break-all">{message.text}</span>
        </div>
      )}

      {/* 最近一次同步详情 */}
      {summary && (
        <details className="mb-4">
          <summary className="cursor-pointer text-xs text-gray-500">▸ 上次同步明细</summary>
          <pre className="mt-2 text-[10px] bg-gray-900 text-gray-100 rounded-xl p-3 overflow-x-auto">
{JSON.stringify(summary, null, 2)}
          </pre>
        </details>
      )}

      {/* 说明 */}
      <div className="bg-gray-50 border border-gray-100 rounded-xl p-3 text-[11px] text-gray-400 leading-relaxed space-y-1">
        <p><b className="text-gray-500">冲突规则：</b>同一条记录两端都被修改时，保留 updatedAt 较新的一方；删除用墓碑传播，不会被旧数据复活。</p>
        <p><b className="text-gray-500">混合内容提醒：</b>GitHub Pages 是 HTTPS，服务器也必须 HTTPS（localhost 除外），否则浏览器拦截请求。</p>
        <p><b className="text-gray-500">多地区：</b>把服务端部署在云厂商任意地域；多个实例连同一个 MySQL 即共享数据。</p>
      </div>
    </div>
  )
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={`border rounded-xl p-3 ${highlight ? 'bg-amber-50 border-amber-200' : 'bg-white border-gray-200'}`}>
      <div className="text-[10px] text-gray-400">{label}</div>
      <div className={`text-xs font-semibold mt-0.5 truncate ${highlight ? 'text-amber-600' : 'text-gray-700'}`}>{value}</div>
    </div>
  )
}
