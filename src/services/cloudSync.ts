// ====== CloudSync — 云同步引擎（v1.1）======
// 架构：IndexedDB 始终是本地主库（离线可用）；云端是副本。
// 策略：按 updatedAt 的 Last-Write-Wins 合并 + 删除墓碑传播 + 游标增量拉取。
//
// 服务端协议（见 server/server.mjs 参考实现）：
//   POST /login            {username,password} → {token}
//   POST /upsert/:table    {rows:[...]}        → {ok}
//   GET  /changes?since=   → {serverNow, changes:[{table,rows}], deletions:[{tableName,rowId,deletedAt}]}
//   POST /deletions        {deletions:[...]}   → {ok}

import { db } from '../db'
import type { CloudSyncConfig, DeletionRecord } from '../types'
import { now } from '../repositories/result'
import { notifyKindsChanged } from '../repositories/collectionRepository'

// ====== 同步表清单（排除本地态/审计噪声/派生表）======

export const EXCLUDED_TABLES = new Set(['appState', 'deletions', 'contexts', 'events'])

export const SYNC_TABLES: string[] = db.tables.map(t => t.name).filter(n => !EXCLUDED_TABLES.has(n))

/** 每张表用于 LWW 比较的时间字段 */
const TIME_FIELD: Record<string, string> = {
  goals: 'updatedAt', domains: 'updatedAt', projects: 'updatedAt', tasks: 'updatedAt',
  customers: 'updatedAt', opportunities: 'updatedAt', orders: 'updatedAt', communications: 'updatedAt',
  knowledge: 'updatedAt', inspirations: 'updatedAt', questions: 'updatedAt',
  research: 'updatedAt', experiments: 'updatedAt', decisions: 'updatedAt',
  reviews: 'updatedAt', processes: 'updatedAt', agents: 'createdAt',
  relations: 'updatedAt', memories: 'updatedAt',
  agentRuns: 'startedAt', agentTools: 'updatedAt', agentPermissions: 'updatedAt',
  habits: 'createdAt', inbox: 'capturedAt', learningPaths: 'createdAt',
  notifications: 'createdAt', dailyLogs: 'updatedAt',
  workflows: 'updatedAt', workflowVersions: 'createdAt', workflowRuns: 'startedAt',
  approvals: 'createdAt', tradeDeals: 'updatedAt', siteProducts: 'updatedAt',
  seoKeywords: 'checkedAt', events: 'createdAt',
  // v1.2 补齐：此前缺失导致这三张表的远端变更永远无法应用回本地
  collections: 'updatedAt', siteMetrics: 'createdAt', workflowSteps: 'updatedAt',
  pomodoroSessions: 'startTime',
}

// 启动断言：同步清单内的每张表必须有 LWW 时钟字段，防止再出现「只上传永下载」盲区
for (const t of SYNC_TABLES) {
  if (!TIME_FIELD[t]) console.warn(`[CloudSync] 表 ${t} 在 TIME_FIELD 中无映射，将退化为全量推/永不拉`)
}

function timeOf(table: string, row: Record<string, any>): string {
  const field = TIME_FIELD[table]
  if (field) {
    const v = row[field]
    if (typeof v === 'string' && v) return v
  }
  // 无时间字段的微型表：视为永远需要推送/覆盖
  return '9999-12-31T00:00:00.000Z'
}

// ====== Transport 抽象（测试可注入 Mock）======

export interface SyncTransport {
  login(serverUrl: string, username: string, password: string): Promise<{ token: string }>
  push(serverUrl: string, token: string, table: string, rows: Record<string, any>[]): Promise<void>
  pullChanges(serverUrl: string, token: string, since: string): Promise<{
    serverNow: string
    changes: { table: string; rows: Record<string, any>[] }[]
    deletions: { tableName: string; rowId: string; deletedAt: string }[]
  }>
  pushDeletions(serverUrl: string, token: string, deletions: DeletionRecord[]): Promise<void>
}

export const httpTransport: SyncTransport = {
  async login(serverUrl, username, password) {
    const r = await fetch(`${serverUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    if (!r.ok) throw new Error(`登录失败 (${r.status})`)
    const data = await r.json()
    return { token: data.token }
  },

  async push(serverUrl, token, table, rows) {
    if (rows.length === 0) return
    const r = await fetch(`${serverUrl}/upsert/${encodeURIComponent(table)}`, {
      method: 'POST',
      headers: jsonHeaders(token),
      body: JSON.stringify({ rows }),
    })
    if (!r.ok) throw new Error(`推送 ${table} 失败 (${r.status})`)
    let data: any = null
    try { data = await r.json() } catch { /* 非 JSON 响应视为成功 */ }
    if (data && data.ok === false) throw new Error(`推送 ${table} 被服务端拒绝`)
    if (data && typeof data.accepted === 'number' && data.accepted < rows.length) {
      console.info(`[CloudSync] ${table}: 服务端 LWW 拒绝了 ${rows.length - data.accepted} 行旧版本（属正常）`)
    }
  },

  async pullChanges(serverUrl, token, since) {
    const r = await fetch(`${serverUrl}/changes?since=${encodeURIComponent(since)}`, {
      headers: jsonHeaders(token),
    })
    if (!r.ok) throw new Error(`拉取变更失败 (${r.status})`)
    return r.json()
  },

  async pushDeletions(serverUrl, token, deletions) {
    if (deletions.length === 0) return
    const r = await fetch(`${serverUrl}/deletions`, {
      method: 'POST',
      headers: jsonHeaders(token),
      body: JSON.stringify({ deletions }),
    })
    if (!r.ok) throw new Error(`推送删除记录失败 (${r.status})`)
  },
}

function jsonHeaders(token: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'x-evan-token': token }
}

// ====== 配置存取（appState 表 key='cloud'）======

// ====== 同步配置缓存（避免每次路由变化都查 IndexedDB）======
let _syncConfigCache: { value: CloudSyncConfig | null; ts: number } | null = null
const SYNC_CONFIG_TTL = 5 * 60 * 1000 // 5 分钟

export async function getSyncConfig(): Promise<CloudSyncConfig | null> {
  if (_syncConfigCache && Date.now() - _syncConfigCache.ts < SYNC_CONFIG_TTL) {
    return _syncConfigCache.value
  }
  try {
    const rec = (await db.appState.get('cloud')) as any
    const cfg = rec ? (({ key, ...rest }) => rest)(rec) as CloudSyncConfig : null
    _syncConfigCache = { value: cfg, ts: Date.now() }
    return cfg
  } catch {
    return null
  }
}

/** 供 clearSyncConfig / saveConfig 等写操作后调用，立即失效缓存 */
export function invalidateSyncConfigCache() {
  _syncConfigCache = null
}

async function saveConfig(cfg: CloudSyncConfig): Promise<void> {
  await db.appState.put({ ...cfg, key: 'cloud' } as any)
  invalidateSyncConfigCache()
}

export async function clearSyncConfig(): Promise<void> {
  await db.appState.delete('cloud')
  invalidateSyncConfigCache()
}

// ====== 结果类型 ======

export interface SyncSummary {
  pushedRows: number
  pulledRows: number
  appliedRows: number
  appliedDeletions: number
  skippedConflicts: number
  tablesPushed: number
}

// ====== 引擎 ======

class CloudSyncService {
  private transport: SyncTransport = httpTransport
  private autoTimer: ReturnType<typeof setInterval> | null = null
  private lastAutoSyncAt = 0

  /** 测试注入 Mock 传输层 */
  setTransport(t: SyncTransport): void {
    this.transport = t
  }

  /** 设置自动同步开关（持久化到配置） */
  async setAutoSync(on: boolean): Promise<void> {
    const cfg = await getSyncConfig()
    if (!cfg) throw new Error('请先配置同步服务器')
    await saveConfig({ ...cfg, autoSync: on })
    if (on) this.startAutoSync()
  }

  async configure(serverUrl: string, username: string): Promise<void> {
    const prev = await getSyncConfig()
    const cfg: CloudSyncConfig = {
      ...(prev ?? { token: undefined }),
      serverUrl: serverUrl.replace(/\/+$/, ''),
      username,
      lastPushAt: prev?.lastPushAt,
      lastPullCursor: prev?.lastPullCursor,
      lastSyncAt: prev?.lastSyncAt,
    }
    await saveConfig(cfg)
  }

  async login(password: string): Promise<void> {
    const cfg = await requireConfig()
    const { token } = await this.transport.login(cfg.serverUrl, cfg.username, password)
    await saveConfig({ ...cfg, token })
  }

  async logout(): Promise<void> {
    const cfg = await getSyncConfig()
    if (!cfg) return
    await saveConfig({ ...cfg, token: undefined })
  }

  async isConfigured(): Promise<boolean> {
    const cfg = await getSyncConfig()
    return !!(cfg && cfg.serverUrl && cfg.username)
  }

  async isLoggedIn(): Promise<boolean> {
    const cfg = await getSyncConfig()
    return !!(cfg && cfg.token)
  }

  /** 本地待推送行数估算（供 UI 显示） */
  async pendingCount(): Promise<number> {
    const cfg = await getSyncConfig()
    const since = cfg?.lastPushAt ?? '1970-01-01T00:00:00.000Z'
    let count = 0
    for (const table of SYNC_TABLES) {
      const rows = await (db as any)[table].toArray()
      count += rows.filter((r: any) => timeOf(table, r) > since).length
    }
    const tombs = await db.deletions.toArray()
    return count + tombs.length
  }

  /**
   * 执行一次完整同步：推 → 推墓碑 → 拉 → LWW 应用
   */
  /**
   * 启动自动同步循环（应用启动时调用，幂等）。
   * 策略：已登录且 autoSync 开启时，前台每 5 分钟 + 回到前台立即同步一次。
   */
  startAutoSync(): void {
    if (this.autoTimer) return
    const tick = async () => {
      try {
        const cfg = await getSyncConfig()
        if (!cfg?.autoSync || !cfg.token) return
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
        if (Date.now() - this.lastAutoSyncAt < 60_000) return // 防抖
        this.lastAutoSyncAt = Date.now()
        await this.syncNow()
      } catch { /* 静默失败，不打扰用户 */ }
    }
    this.autoTimer = setInterval(tick, 5 * 60_000)
    void tick()
  }

  async syncNow(): Promise<SyncSummary> {
    const cfg = await requireConfig()
    if (!cfg.token) throw new Error('尚未登录，请先在同步页登录')

    const summary: SyncSummary = {
      pushedRows: 0, pulledRows: 0, appliedRows: 0,
      appliedDeletions: 0, skippedConflicts: 0, tablesPushed: 0,
    }

    // ---------- PUSH ----------
    // 水位线采用「已推送内容的最大时间戳」而非墙钟，
    // 避免时钟偏移/导入旧数据时永久漏推或反复重推。
    const since = cfg.lastPushAt ?? '1970-01-01T00:00:00.000Z'
    const overlapSince = new Date(Date.parse(since) - 60000).toISOString() // 1 分钟重叠防漏
    let maxPushedTs = ''
    const SENTINEL = '9999-12-31T00:00:00.000Z'
    const PUSH_CHUNK = 400 // 服务端单请求上限 500 行，客户端分片防静默截断

    for (const table of SYNC_TABLES) {
      const rows: Record<string, any>[] = await (db as any)[table].toArray()
      const dirty = rows.filter(r => {
        const t = timeOf(table, r)
        return t !== SENTINEL && t > overlapSince
      })
      // 无时间字段的微型表：全量推（幂等）
      const alwaysAll = rows.filter(r => timeOf(table, r) === SENTINEL)
      const toPush = dirty.length > 0 ? dirty : alwaysAll
      if (toPush.length === 0) continue
      for (let i = 0; i < toPush.length; i += PUSH_CHUNK) {
        await this.transport.push(cfg.serverUrl, cfg.token, table, toPush.slice(i, i + PUSH_CHUNK))
      }
      summary.pushedRows += toPush.length
      summary.tablesPushed++
      for (const r of dirty) {
        const t = timeOf(table, r)
        if (!maxPushedTs || t > maxPushedTs) maxPushedTs = t
      }
    }

    // 推送删除墓碑（服务端按 id 幂等去重）；分片防服务端 slice 截断
    const tombstones = await db.deletions.toArray()
    if (tombstones.length > 0) {
      const pushedIds = new Set(tombstones.map(t => t.id))
      for (let i = 0; i < tombstones.length; i += PUSH_CHUNK) {
        await this.transport.pushDeletions(cfg.serverUrl, cfg.token, tombstones.slice(i, i + PUSH_CHUNK))
      }
      // 只删除本次已推送的墓碑；推送期间新产生的墓碑保留，待下次同步
      const staleIds = (await db.deletions.toArray())
        .filter(t => pushedIds.has(t.id))
        .map(t => t.id)
      if (staleIds.length > 0) await db.deletions.bulkDelete(staleIds)
    }

    // ---------- PULL ----------
    const cursor = cfg.lastPullCursor ?? '1970-01-01T00:00:00.000Z'
    const pulled = await this.transport.pullChanges(cfg.serverUrl, cfg.token, cursor)

    let collectionsTouched = false
    for (const change of pulled.changes ?? []) {
      summary.pulledRows += change.rows.length
      const table = (db as any)[change.table]
      if (!table) continue
      if (change.table === 'collections') collectionsTouched = true
      const timeField = TIME_FIELD[change.table]
      for (const remote of change.rows) {
        if (remote._deleted === true) continue // 删除走 deletions 通道
        const local = await table.get(remote.id)
        if (!local) {
          await table.put(stripMeta(remote))
          summary.appliedRows++
          continue
        }
        const localTime = timeField ? (local as any)[timeField] ?? '' : '9999-12-31T00:00:00.000Z'
        const remoteTime = timeField ? remote[timeField] ?? '' : ''
        if (remoteTime > localTime) {
          await table.put(stripMeta(remote))
          summary.appliedRows++
        } else {
          summary.skippedConflicts++
        }
      }
    }

    // 应用远端删除
    for (const d of pulled.deletions ?? []) {
      const table = (db as any)[d.tableName]
      if (!table) continue
      if (d.tableName === 'collections') collectionsTouched = true
      const local = await table.get(d.rowId)
      if (local) {
        const localTime = TIME_FIELD[d.tableName]
          ? (local as any)[TIME_FIELD[d.tableName]] ?? ''
          : ''
        if (!localTime || localTime <= d.deletedAt) {
          await table.delete(d.rowId)
          summary.appliedDeletions++
        } else {
          summary.skippedConflicts++ // 本地更新，保留本地（LWW）
        }
      }
    }

    // ---------- 游标推进 ----------
    await saveConfig({
      ...cfg,
      lastPushAt: maxPushedTs || cfg.lastPushAt,
      lastPullCursor: pulled.serverNow ?? now(),
      lastSyncAt: now(),
    })

    // collections 落地了远端变更 → 通知挂载中的页面重水合，
    // 防止其下次「整组保存」把拉下来的行当缺席数据误删（syncKind 差异同步保护）
    if (collectionsTouched) notifyKindsChanged()

    return summary
  }
}

function stripMeta(row: Record<string, any>): Record<string, any> {
  const { _deleted, ...rest } = row
  void _deleted
  return rest
}

async function requireConfig(): Promise<CloudSyncConfig> {
  const cfg = await getSyncConfig()
  if (!cfg || !cfg.serverUrl || !cfg.username) {
    throw new Error('请先配置服务器地址与用户名')
  }
  return cfg
}

export const cloudSync = new CloudSyncService()
