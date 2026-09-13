// ====== 邮件同步服务（简化可靠版）======
// 策略：轮询为主，页面可见/聚焦时立即补同步
import { listAccounts, syncReal, getEmailCount } from '../repositories/emailRepository'
import { EVENTS, emitEvent } from '../utils/emailHelpers'

export type EmailSyncConfig = {
  enabled: boolean
  intervalMinutes: number
  limit: number | 'all'
  lastSyncAt?: string
  nextSyncAt?: string
}

const LS_KEY = 'evan:emailSyncConfig'
const EVT_PROGRESS = 'evan-email-sync-progress'

let timer: ReturnType<typeof setInterval> | null = null
let syncing = false
let progress = { done: 0, total: 0, status: '' as string, errors: 0 }

function loadConfig(): EmailSyncConfig {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) return JSON.parse(raw)
  } catch {}
  return { enabled: true, intervalMinutes: 2, limit: 30 }
}

function saveConfig(c: EmailSyncConfig) {
  localStorage.setItem(LS_KEY, JSON.stringify(c))
  emitEvent('evan-email-config-changed')
}

export function getEmailSyncConfig() { return loadConfig() }

export function setEmailSyncConfig(patch: Partial<EmailSyncConfig>) {
  const cur = loadConfig()
  const next = { ...cur, ...patch }
  saveConfig(next)
  if (next.enabled) startAutoSync()
  else stopAutoSync()
  return next
}

function emitProgress(p: Partial<typeof progress>) {
  progress = { ...progress, ...p }
  window.dispatchEvent(new CustomEvent(EVT_PROGRESS, { detail: { ...progress } }))
}

function emitDone(detail: any) {
  emitEvent(EVENTS.EMAIL_SYNCED, detail)
  emitEvent(EVENTS.EMAILS_UPDATED, detail)
  emitEvent(EVENTS.CUSTOMERS_UPDATED, detail)
}

// ====== 核心同步函数 ======
export async function syncAllEmails(limit: number | 'all' = 30): Promise<number> {
  const lim = limit === 'all' ? 1000000 : Number(limit) || 30
  if (syncing) return 0
  syncing = true
  let totalErrors = 0
  try {
    const accounts = await listAccounts()
    if (accounts.length === 0) throw new Error('未绑定邮箱')

    // 预读总邮件数
    const accountTotals: Record<string, number> = {}
    emitProgress({ status: '正在读取邮箱...', done: 0, total: 0, errors: 0 })
    for (const acc of accounts) {
      try { accountTotals[acc.id] = await getEmailCount(acc.id) } catch { accountTotals[acc.id] = 0 }
    }
    const grandTotal = Object.values(accountTotals).reduce((s, n) => s + n, 0)
    emitProgress({ status: `共 ${accounts.length} 账号，${grandTotal} 封，开始同步...`, done: 0, total: grandTotal, errors: 0 })

    let totalAdded = 0
    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i]
      const accTotal = accountTotals[acc.id] || 0

      try {
        // ====== 第一步：优先拉未读邮件（UNSEEN）======
        emitProgress({
          status: `[${i + 1}/${accounts.length}] ${acc.email} 拉取未读邮件...`,
          done: totalAdded, total: grandTotal, errors: totalErrors,
        })
        let unreadOffset = 0
        while (true) {
          let res: any
          try {
            res = await syncReal(acc.id, 200, unreadOffset, true, 'UNSEEN')
          } catch (batchErr: any) {
            totalErrors++
            emitProgress({
              status: `[${i + 1}/${accounts.length}] ${acc.email} 未读拉取失败: ${String(batchErr.message || batchErr).slice(0, 40)}`,
              done: totalAdded, total: grandTotal, errors: totalErrors,
            })
            break
          }
          const added = typeof res === 'object' ? res.added : Number(res) || 0
          const hasMore = typeof res === 'object' ? res.hasMore : false
          if (added > 0) { totalAdded += added; unreadOffset += added }
          emitProgress({
            status: `[${i + 1}/${accounts.length}] ${acc.email} 已拉未读 ${unreadOffset} 封`,
            done: totalAdded, total: grandTotal, errors: totalErrors,
          })
          if (!hasMore || added === 0) break
          await new Promise(r => setTimeout(r, 30))
        }

        // ====== 第二步：拉最新邮件（补充已读邮件）======
        emitProgress({
          status: `[${i + 1}/${accounts.length}] ${acc.email} 拉取最新邮件...`,
          done: totalAdded, total: grandTotal, errors: totalErrors,
        })
        let recentOffset = 0
        const recentLimit = Math.min(lim, 500) // 最多拉500封最新邮件
        while (true) {
          let res: any
          try {
            res = await syncReal(acc.id, 200, recentOffset, true)
          } catch (batchErr: any) {
            totalErrors++
            break
          }
          const added = typeof res === 'object' ? res.added : Number(res) || 0
          const hasMore = typeof res === 'object' ? res.hasMore : false
          if (added > 0) { totalAdded += added; recentOffset += added }
          emitProgress({
            status: `[${i + 1}/${accounts.length}] ${acc.email} 已同步 ${recentOffset}/${accTotal || '?'}`,
            done: totalAdded, total: grandTotal, errors: totalErrors,
          })
          if (!hasMore || added === 0) break
          if (recentOffset >= recentLimit) break
          await new Promise(r => setTimeout(r, 30))
        }
      } catch (accErr: any) {
        totalErrors++
        emitProgress({
          status: `[${i + 1}/${accounts.length}] ${acc.email} 失败: ${String(accErr.message || accErr).slice(0, 40)}`,
          done: totalAdded, total: grandTotal, errors: totalErrors,
        })
      }
    }

    emitDone({ total: totalAdded, limit: lim, errors: totalErrors })
    const cfg = loadConfig()
    cfg.lastSyncAt = new Date().toISOString()
    cfg.nextSyncAt = new Date(Date.now() + cfg.intervalMinutes * 60000).toISOString()
    saveConfig(cfg)
    return totalAdded
  } finally {
    syncing = false
    emitProgress({ status: '空闲', done: 0, total: 0, errors: 0 })
  }
}

export function isEmailSyncing() { return syncing }
export function getEmailSyncProgress() { return { ...progress } }

// ====== 自动同步 ======
export function startAutoSync() {
  stopAutoSync()
  const cfg = loadConfig()
  if (!cfg.enabled) return

  // 立即同步一次
  setTimeout(() => {
    if (!syncing) syncAllEmails(cfg.limit).catch(() => {})
  }, 2000)

  // 定时同步
  timer = setInterval(() => {
    if (syncing) return
    syncAllEmails(cfg.limit).catch(() => {})
  }, cfg.intervalMinutes * 60000)

  // 更新下次时间
  const cfg2 = loadConfig()
  cfg2.nextSyncAt = new Date(Date.now() + cfg2.intervalMinutes * 60000).toISOString()
  saveConfig(cfg2)
}

export function stopAutoSync() {
  if (timer) { clearInterval(timer); timer = null }
}

// ====== 页面可见性/聚焦监听 ======
let lastSyncByVisibility = 0

function handleVisibilityChange() {
  if (document.visibilityState === 'visible') {
    const now = Date.now()
    // 距离上次同步超过30秒才触发，避免频繁同步
    if (now - lastSyncByVisibility > 30000 && !syncing) {
      lastSyncByVisibility = now
      const cfg = loadConfig()
      if (cfg.enabled) {
        syncAllEmails(cfg.limit).catch(() => {})
      }
    }
  }
}

function handleFocus() {
  const now = Date.now()
  if (now - lastSyncByVisibility > 30000 && !syncing) {
    lastSyncByVisibility = now
    const cfg = loadConfig()
    if (cfg.enabled) {
      syncAllEmails(cfg.limit).catch(() => {})
    }
  }
}

let listenersAttached = false

function attachListeners() {
  if (listenersAttached) return
  listenersAttached = true
  document.addEventListener('visibilitychange', handleVisibilityChange)
  window.addEventListener('focus', handleFocus)
}

function detachListeners() {
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  window.removeEventListener('focus', handleFocus)
  listenersAttached = false
}

// ====== 初始化（供 App 启动时调用）======
export function initEmailSync() {
  const cfg = loadConfig()
  attachListeners()
  if (cfg.enabled) startAutoSync()
}

export function destroyEmailSync() {
  stopAutoSync()
  detachListeners()
}
