// ====== 邮件同步服务（简化可靠版）======
// 策略：轮询为主，页面可见/聚焦时立即补同步
import { listAccounts, syncFromDb } from '../repositories/emailRepository'
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

// ====== 核心同步函数：浏览器只从服务端库拉信封（零 IMAP 连接）======
// IMAP 碰 Gmail 的事全部交给服务端 watcher/worker；这里只做库→本地镜像
export async function syncAllEmails(_limit: number | 'all' = 30): Promise<number> {
  if (syncing) return 0
  syncing = true
  let totalErrors = 0
  try {
    const accounts = await listAccounts()
    if (accounts.length === 0) throw new Error('未绑定邮箱')

    emitProgress({ status: '正在从服务端库同步...', done: 0, total: 0, errors: 0 })

    let totalAdded = 0
    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i]
      try {
        const res = await syncFromDb(acc.id, (done, total) => {
          emitProgress({
            status: `[${i + 1}/${accounts.length}] ${acc.email} 本地镜像 ${done}/${total || '?'}`,
            done: totalAdded + done, total, errors: totalErrors,
          })
        })
        totalAdded += res.added
        emitProgress({
          status: `[${i + 1}/${accounts.length}] ${acc.email} 完成（新增 ${res.added} 封）`,
          done: totalAdded, total: res.total, errors: totalErrors,
        })
      } catch (accErr: any) {
        totalErrors++
        emitProgress({
          status: `[${i + 1}/${accounts.length}] ${acc.email} 失败: ${String(accErr.message || accErr).slice(0, 40)}`,
          done: totalAdded, total: 0, errors: totalErrors,
        })
      }
    }

    emitDone({ total: totalAdded, errors: totalErrors })
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
