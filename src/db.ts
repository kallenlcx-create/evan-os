import Dexie, { type Table } from 'dexie'
import type {
  Goal, Project, Task, Customer, Opportunity, Order, Communication,
  Knowledge, Inspiration, Question, Research, Experiment, Decision, Review, Process,
  Habit, InboxItem, LearningPath, AgentConfig, Notification,
  DailyLog, PomodoroSession,
  RelationRecord, EventRecord,
  Memory, AgentRunRecord, ApprovalRecord,
  WorkflowDefinition, WorkflowRunRecord,
  TradeDeal, SiteProduct, SiteMetric, SeoKeyword,
  Domain, AgentToolRecord, AgentPermissionRecord, ContextSnapshotRecord,
  WorkflowVersionRecord, WorkflowStepRecord,
  DeletionRecord, CollectionRecord,
} from './types'

// ====== 数据库版本 ======
// version 1: 初始数据表
// version 2: + dailyLogs
// version 3: + customers, opportunities, orders, communications, relations, events,
//            pomodoroSessions — 正确的独立表，修复错误映射
// version 4: + memories（AI 长期上下文，独立于 knowledge）
// version 5: + agentRuns, approvals（Agent Runtime 审计与审批队列）
// version 6: + workflows, workflowRuns（Automation Engine）
// version 7: + tradeDeals, siteProducts, siteMetrics, seoKeywords（外贸与独立站业务层）
// version 8: 四层数据库补齐 —— domains / agentTools / agentPermissions / contexts /
//            workflowVersions / workflowSteps

export class EvanOSDatabase extends Dexie {
  goals!: Table<Goal, string>
  projects!: Table<Project, string>
  tasks!: Table<Task, string>
  knowledge!: Table<Knowledge, string>
  inspirations!: Table<Inspiration, string>
  questions!: Table<Question, string>
  research!: Table<Research, string>
  experiments!: Table<Experiment, string>
  decisions!: Table<Decision, string>
  reviews!: Table<Review, string>
  processes!: Table<Process, string>
  habits!: Table<Habit, string>
  inbox!: Table<InboxItem, string>
  learningPaths!: Table<LearningPath, string>
  agents!: Table<AgentConfig, string>
  notifications!: Table<Notification, string>
  dailyLogs!: Table<DailyLog, string>
  appState!: Table<any, string> // 混合用途：UI 状态 + 云同步配置 + 备份快照
  // v3 新增
  customers!: Table<Customer, string>
  opportunities!: Table<Opportunity, string>
  orders!: Table<Order, string>
  communications!: Table<Communication, string>
  relations!: Table<RelationRecord, string>
  events!: Table<EventRecord, string>
  pomodoroSessions!: Table<PomodoroSession, string>
  // v4 新增
  memories!: Table<Memory, string>
  // v5 新增
  agentRuns!: Table<AgentRunRecord, string>
  approvals!: Table<ApprovalRecord, string>
  // v6 新增
  workflows!: Table<WorkflowDefinition, string>
  workflowRuns!: Table<WorkflowRunRecord, string>
  // v7 新增（外贸 + 独立站）
  tradeDeals!: Table<TradeDeal, string>
  siteProducts!: Table<SiteProduct, string>
  siteMetrics!: Table<SiteMetric, string>
  seoKeywords!: Table<SeoKeyword, string>
  // v8 新增（四层补齐）
  domains!: Table<Domain, string>
  agentTools!: Table<AgentToolRecord, string>
  agentPermissions!: Table<AgentPermissionRecord, string>
  contexts!: Table<ContextSnapshotRecord, string>
  workflowVersions!: Table<WorkflowVersionRecord, string>
  workflowSteps!: Table<WorkflowStepRecord, string>
  // v9 新增（云同步墓碑）
  deletions!: Table<DeletionRecord, string>
  // v10 新增（通用收藏/清单：提示词/AI工具/学习/生活清单）
  collections!: Table<CollectionRecord, string>

  constructor() {
    super('EvanOSDatabase')

    // v1
    this.version(1).stores({
      goals: 'id, level, progress, deadline',
      projects: 'id, status, priority, deadline',
      tasks: 'id, status, priority, dueDate, projectId',
      knowledge: 'id, tags, *tokens',
      inspirations: 'id, tags, createdAt',
      questions: 'id, status',
      research: 'id, status',
      experiments: 'id, status',
      decisions: 'id, createdAt',
      reviews: 'id, type, period',
      processes: 'id, tags',
      habits: 'id, frequency',
      inbox: 'id, type, capturedAt, processed',
      learningPaths: 'id, status',
      agents: 'id, domain, status',
      notifications: 'id, type, read, createdAt',
      appState: 'key',
    })

    // v2: + dailyLogs
    this.version(2).stores({
      goals: 'id, level, progress, deadline',
      projects: 'id, status, priority, deadline',
      tasks: 'id, status, priority, dueDate, projectId',
      knowledge: 'id, tags, *tokens',
      inspirations: 'id, tags, createdAt',
      questions: 'id, status',
      research: 'id, status',
      experiments: 'id, status',
      decisions: 'id, createdAt',
      reviews: 'id, type, period',
      processes: 'id, tags',
      habits: 'id, frequency',
      inbox: 'id, type, capturedAt, processed',
      learningPaths: 'id, status',
      agents: 'id, domain, status',
      notifications: 'id, type, read, createdAt',
      dailyLogs: 'id, date',
      appState: 'key',
    })

    // v3: 新增独立表 + relations + events + pomodoroSessions
    this.version(3).stores({
      // 保留原有表
      goals: 'id, level, progress, deadline',
      projects: 'id, status, priority, deadline',
      tasks: 'id, status, priority, dueDate, projectId',
      knowledge: 'id, tags, *tokens',
      inspirations: 'id, tags, createdAt',
      questions: 'id, status',
      research: 'id, status',
      experiments: 'id, status',
      decisions: 'id, createdAt',
      reviews: 'id, type, period',
      processes: 'id, tags',
      habits: 'id, frequency',
      inbox: 'id, type, capturedAt, processed',
      learningPaths: 'id, status',
      agents: 'id, domain, status',
      notifications: 'id, type, read, createdAt',
      dailyLogs: 'id, date',
      appState: 'key',
      // 新增独立表
      customers: 'id, type, company, stage, createdAt',
      opportunities: 'id, type, stage, customerId, createdAt',
      orders: 'id, type, status, customerId, orderDate',
      communications: 'id, type, channel, customerId, communicatedAt',
      // 关系表
      relations: 'id, sourceType, sourceId, targetType, targetId, relationType, [sourceType+sourceId], [targetType+targetId]',
      // 事件表
      events: 'id, type, objectType, objectId, createdAt, [objectType+objectId]',
      // 番茄钟
      pomodoroSessions: 'id, taskId, startTime, type',
    })

    // v3 migration: 将被错误写入 goals 的 customer/opportunity/order/communication 数据迁移到正确的表
    this.version(3).upgrade(async (tx) => {
      await migrateMisplacedData(tx)
    })

    // v4: + memories（AI 长期上下文）
    this.version(4).stores({
      goals: 'id, level, progress, deadline',
      projects: 'id, status, priority, deadline',
      tasks: 'id, status, priority, dueDate, projectId',
      knowledge: 'id, tags, *tokens',
      inspirations: 'id, tags, createdAt',
      questions: 'id, status',
      research: 'id, status',
      experiments: 'id, status',
      decisions: 'id, createdAt',
      reviews: 'id, type, period',
      processes: 'id, tags',
      habits: 'id, frequency',
      inbox: 'id, type, capturedAt, processed',
      learningPaths: 'id, status',
      agents: 'id, domain, status',
      notifications: 'id, type, read, createdAt',
      dailyLogs: 'id, date',
      appState: 'key',
      customers: 'id, type, company, stage, createdAt',
      opportunities: 'id, type, stage, customerId, createdAt',
      orders: 'id, type, status, customerId, orderDate',
      communications: 'id, type, channel, customerId, communicatedAt',
      relations: 'id, sourceType, sourceId, targetType, targetId, relationType, [sourceType+sourceId], [targetType+targetId]',
      events: 'id, type, objectType, objectId, createdAt, [objectType+objectId]',
      pomodoroSessions: 'id, taskId, startTime, type',
      // 新增
      memories: 'id, status, type, confidence, updatedAt, *tags',
    })

    // v5: + agentRuns / approvals（Agent Runtime）
    this.version(5).stores({
      goals: 'id, level, progress, deadline',
      projects: 'id, status, priority, deadline',
      tasks: 'id, status, priority, dueDate, projectId',
      knowledge: 'id, tags, *tokens',
      inspirations: 'id, tags, createdAt',
      questions: 'id, status',
      research: 'id, status',
      experiments: 'id, status',
      decisions: 'id, createdAt',
      reviews: 'id, type, period',
      processes: 'id, tags',
      habits: 'id, frequency',
      inbox: 'id, type, capturedAt, processed',
      learningPaths: 'id, status',
      agents: 'id, domain, status',
      notifications: 'id, type, read, createdAt',
      dailyLogs: 'id, date',
      appState: 'key',
      customers: 'id, type, company, stage, createdAt',
      opportunities: 'id, type, stage, customerId, createdAt',
      orders: 'id, type, status, customerId, orderDate',
      communications: 'id, type, channel, customerId, communicatedAt',
      relations: 'id, sourceType, sourceId, targetType, targetId, relationType, [sourceType+sourceId], [targetType+targetId]',
      events: 'id, type, objectType, objectId, createdAt, [objectType+objectId]',
      pomodoroSessions: 'id, taskId, startTime, type',
      memories: 'id, status, type, confidence, updatedAt, *tags',
      // 新增
      agentRuns: 'id, agentId, status, trigger, startedAt',
      approvals: 'id, agentId, runId, level, status, actionType, source, createdAt',
    })

    // v6: + workflows / workflowRuns（Automation Engine）
    this.version(6).stores({
      goals: 'id, level, progress, deadline',
      projects: 'id, status, priority, deadline',
      tasks: 'id, status, priority, dueDate, projectId',
      knowledge: 'id, tags, *tokens',
      inspirations: 'id, tags, createdAt',
      questions: 'id, status',
      research: 'id, status',
      experiments: 'id, status',
      decisions: 'id, createdAt',
      reviews: 'id, type, period',
      processes: 'id, tags',
      habits: 'id, frequency',
      inbox: 'id, type, capturedAt, processed',
      learningPaths: 'id, status',
      agents: 'id, domain, status',
      notifications: 'id, type, read, createdAt',
      dailyLogs: 'id, date',
      appState: 'key',
      customers: 'id, type, company, stage, createdAt',
      opportunities: 'id, type, stage, customerId, createdAt',
      orders: 'id, type, status, customerId, orderDate',
      communications: 'id, type, channel, customerId, communicatedAt',
      relations: 'id, sourceType, sourceId, targetType, targetId, relationType, [sourceType+sourceId], [targetType+targetId]',
      events: 'id, type, objectType, objectId, createdAt, [objectType+objectId]',
      pomodoroSessions: 'id, taskId, startTime, type',
      memories: 'id, status, type, confidence, updatedAt, *tags',
      agentRuns: 'id, agentId, status, trigger, startedAt',
      approvals: 'id, agentId, runId, level, status, actionType, source, createdAt',
      // 新增
      workflows: 'id, status, version, triggerType, updatedAt',
      workflowRuns: 'id, workflowId, status, startedAt',
    })

    // v7: + 外贸与独立站业务表
    this.version(7).stores({
      goals: 'id, level, progress, deadline',
      projects: 'id, status, priority, deadline',
      tasks: 'id, status, priority, dueDate, projectId',
      knowledge: 'id, tags, *tokens',
      inspirations: 'id, tags, createdAt',
      questions: 'id, status',
      research: 'id, status',
      experiments: 'id, status',
      decisions: 'id, createdAt',
      reviews: 'id, type, period',
      processes: 'id, tags',
      habits: 'id, frequency',
      inbox: 'id, type, capturedAt, processed',
      learningPaths: 'id, status',
      agents: 'id, domain, status',
      notifications: 'id, type, read, createdAt',
      dailyLogs: 'id, date',
      appState: 'key',
      customers: 'id, type, company, stage, createdAt',
      opportunities: 'id, type, stage, customerId, createdAt',
      orders: 'id, type, status, customerId, orderDate',
      communications: 'id, type, channel, customerId, communicatedAt',
      relations: 'id, sourceType, sourceId, targetType, targetId, relationType, [sourceType+sourceId], [targetType+targetId]',
      events: 'id, type, objectType, objectId, createdAt, [objectType+objectId]',
      pomodoroSessions: 'id, taskId, startTime, type',
      memories: 'id, status, type, confidence, updatedAt, *tags',
      agentRuns: 'id, agentId, status, trigger, startedAt',
      approvals: 'id, agentId, runId, level, status, actionType, source, createdAt',
      workflows: 'id, status, version, triggerType, updatedAt',
      workflowRuns: 'id, workflowId, status, startedAt',
      // 新增
      tradeDeals: 'id, stage, customerId, updatedAt',
      siteProducts: 'id, handle, status, updatedAt',
      siteMetrics: 'id, date',
      seoKeywords: 'id, keyword',
    })

    // v8: 四层数据库补齐
    this.version(8).stores({
      goals: 'id, level, progress, deadline',
      domains: 'id, createdAt',
      projects: 'id, status, priority, deadline',
      tasks: 'id, status, priority, dueDate, projectId',
      customers: 'id, type, company, stage, createdAt',
      opportunities: 'id, type, stage, customerId, createdAt',
      orders: 'id, type, status, customerId, orderDate',
      communications: 'id, type, channel, customerId, communicatedAt',
      knowledge: 'id, tags, *tokens',
      inspirations: 'id, tags, createdAt',
      questions: 'id, status',
      research: 'id, status',
      experiments: 'id, status',
      decisions: 'id, createdAt',
      reviews: 'id, type, period',
      processes: 'id, tags',
      agents: 'id, domain, status',
      relations: 'id, sourceType, sourceId, targetType, targetId, relationType, [sourceType+sourceId], [targetType+targetId]',
      events: 'id, type, objectType, objectId, createdAt, [objectType+objectId]',
      memories: 'id, status, type, confidence, updatedAt, *tags',
      agentRuns: 'id, agentId, status, trigger, startedAt',
      agentTools: 'id, level, updatedAt',
      agentPermissions: 'id, domain, level, updatedAt',
      contexts: 'id, createdAt',
      habits: 'id, frequency',
      inbox: 'id, type, capturedAt, processed',
      learningPaths: 'id, status',
      notifications: 'id, type, read, createdAt',
      dailyLogs: 'id, date',
      appState: 'key',
      pomodoroSessions: 'id, taskId, startTime, type',
      workflows: 'id, status, version, triggerType, updatedAt',
      workflowVersions: 'id, workflowId, version, createdAt',
      workflowSteps: 'id, workflowId, version, action',
      workflowRuns: 'id, workflowId, status, startedAt',
      approvals: 'id, agentId, runId, level, status, actionType, source, createdAt',
      tradeDeals: 'id, stage, customerId, updatedAt',
      siteProducts: 'id, handle, status, updatedAt',
      siteMetrics: 'id, date',
      seoKeywords: 'id, keyword',
    })

    // v9: + deletions（云同步删除墓碑）
    this.version(9).stores({
      deletions: 'id, tableName, deletedAt',
    })

    // v10: + collections（通用收藏/清单，替代 localStorage 孤岛）
    this.version(10).stores({
      collections: 'id, kind, category, updatedAt',
    })

    // 全局删除捕获中间件：任何表的 delete 自动写入墓碑（云同步传播删除）
    this.use({
      stack: 'dbcore',
      name: 'tombstoneCapture',
      create(downlevel) {
        return {
          ...downlevel,
          table(tableName: string) {
            const inner = downlevel.table(tableName)
            return {
              ...inner,
              mutate(req: any) {
                const res = inner.mutate(req)
                if ((req.type === 'delete' || req.type === 'deleteRange') &&
                    tableName !== 'deletions' && tableName !== 'appState') {
                  const ids: string[] = req.type === 'delete'
                    ? (req.keys ?? []).filter((k: any) => typeof k === 'string')
                    : []
                  if (ids.length > 0) {
                    queueMicrotask(() => {
                      Promise.all(ids.map(id => db.deletions.put({
                        id: `${tableName}:${id}`,
                        tableName,
                        rowId: id,
                        deletedAt: new Date().toISOString(),
                      }))).catch(() => {})
                    })
                  }
                }
                return res
              },
            }
          },
        }
      },
    })
  }
}

export const db = new EvanOSDatabase()

// ====== Migration: 迁移被错误写入 goals 表的数据 ======
async function migrateMisplacedData(tx: any) {
  const goals = await tx.table('goals').toArray()

  const misplacedCustomers = goals.filter((g: any) => g.type === 'customer')
  const misplacedOpportunities = goals.filter((g: any) => g.type === 'opportunity')
  const misplacedOrders = goals.filter((g: any) => g.type === 'order')
  const misplacedCommunications = goals.filter((g: any) => g.type === 'communication')

  const totalMisplaced = misplacedCustomers.length + misplacedOpportunities.length
    + misplacedOrders.length + misplacedCommunications.length

  if (totalMisplaced === 0) return

  // 迁移到正确的表
  if (misplacedCustomers.length > 0) {
    for (const c of misplacedCustomers) await tx.table('customers').put(c)
  }
  if (misplacedOpportunities.length > 0) {
    for (const o of misplacedOpportunities) await tx.table('opportunities').put(o)
  }
  if (misplacedOrders.length > 0) {
    for (const o of misplacedOrders) await tx.table('orders').put(o)
  }
  if (misplacedCommunications.length > 0) {
    for (const c of misplacedCommunications) await tx.table('communications').put(c)
  }

  // 从 goals 表删除已迁移的数据
  const misplacedIds = [
    ...misplacedCustomers.map((c: any) => c.id),
    ...misplacedOpportunities.map((o: any) => o.id),
    ...misplacedOrders.map((o: any) => o.id),
    ...misplacedCommunications.map((c: any) => c.id),
  ]
  await tx.table('goals').bulkDelete(misplacedIds)

  // 为迁移的数据建立 legacy relations
  const now = new Date().toISOString()
  const migrationRelations: any[] = []

  // 检查旧 customer/opportunity 的 relations 字段，创建对应的 RelationRecord
  for (const item of [...misplacedCustomers, ...misplacedOpportunities, ...misplacedOrders, ...misplacedCommunications]) {
    const obj = item as any
    if (obj.relations && Array.isArray(obj.relations)) {
      for (const rel of obj.relations) {
        migrationRelations.push({
          id: now + '-' + obj.id + '-' + rel.targetId,
          sourceType: obj.type,
          sourceId: obj.id,
          targetType: rel.targetType,
          targetId: rel.targetId,
          relationType: 'related_to',
          metadata: { legacyLabel: rel.label },
          createdAt: now,
          updatedAt: now,
          createdBy: 'system' as const,
          source: 'migration' as const,
          confidence: 1.0,
        })
      }
    }
  }

  if (migrationRelations.length > 0) {
    for (const r of migrationRelations) await tx.table('relations').put(r)
  }
}

// ====== 所有数据表集合 ======
export const TABLES = {
  goals: db.goals,
  projects: db.projects,
  tasks: db.tasks,
  knowledge: db.knowledge,
  inspirations: db.inspirations,
  questions: db.questions,
  research: db.research,
  experiments: db.experiments,
  decisions: db.decisions,
  reviews: db.reviews,
  processes: db.processes,
  habits: db.habits,
  inbox: db.inbox,
  learningPaths: db.learningPaths,
  agents: db.agents,
  notifications: db.notifications,
  dailyLogs: db.dailyLogs,
  // v3 新增
  customers: db.customers,
  opportunities: db.opportunities,
  orders: db.orders,
  communications: db.communications,
  relations: db.relations,
  events: db.events,
  pomodoroSessions: db.pomodoroSessions,
  // v4 新增
  memories: db.memories,
  // v5 新增
  agentRuns: db.agentRuns,
  approvals: db.approvals,
  // v6 新增
  workflows: db.workflows,
  workflowRuns: db.workflowRuns,
  // v7 新增
  tradeDeals: db.tradeDeals,
  siteProducts: db.siteProducts,
  siteMetrics: db.siteMetrics,
  seoKeywords: db.seoKeywords,
  // v8 新增（四层补齐）
  domains: db.domains,
  agentTools: db.agentTools,
  agentPermissions: db.agentPermissions,
  contexts: db.contexts,
  workflowVersions: db.workflowVersions,
  workflowSteps: db.workflowSteps,
  // v10 新增
  collections: db.collections,
} as const

export type TableName = keyof typeof TABLES

// ====== 清空整个数据库 ======
export async function clearDatabase(opts?: { keepAppState?: boolean }) {
  await Promise.all(Object.values(TABLES).map(table => table.clear()))
  // 墓碑表不在 TABLES 中（避免被 loadAllObjects 载入内存），此处显式清理
  await db.deletions.clear()
  if (!opts?.keepAppState) await db.appState.clear()
}

// ====== 导出所有数据为 JSON ======
export async function exportDatabase(): Promise<string> {
  const data: Record<string, any[]> = {}
  await Promise.all(
    Object.entries(TABLES).map(async ([name, table]) => {
      data[name] = await table.toArray()
    })
  )
  // 墓碑随备份走：换机恢复后删除传播链不断裂
  const deletions = await db.deletions.toArray()
  const appState = await db.appState.get('app')
  return JSON.stringify({
    version: db.verno,
    exportedAt: new Date().toISOString(),
    appState,
    deletions,
    data,
  }, null, 2)
}

// ====== 从 JSON 导入数据 ======
// 注意：只恢复数据表与备份内的 UI 状态（key='app'）；
// 本机专属的云同步配置、滚动快照、壁纸等其余 appState 键全部保留。
export async function importDatabase(json: string): Promise<void> {
  const parsed = JSON.parse(json)
  if (!parsed.data) throw new Error('Invalid backup file')

  await clearDatabase({ keepAppState: true })

  await Promise.all([
    ...Object.entries(TABLES).map(async ([name, table]) => {
      const items = (parsed.data as Record<string, any[]>)[name] || []
      if (items.length > 0) {
        await (table as any).bulkPut(items)
      }
    }),
    Array.isArray(parsed.deletions) && parsed.deletions.length > 0
      ? db.deletions.bulkPut(parsed.deletions)
      : Promise.resolve(),
  ])

  if (parsed.appState) {
    await db.appState.put(parsed.appState, 'app')
  }
}

// ====== 自动备份 ======
export async function autoBackup() {
  const json = await exportDatabase()
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  const date = new Date().toISOString().slice(0, 10)
  a.download = `evan-os-backup-${date}.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ====== 滚动快照（存于 appState，误操作后可恢复最近 3 份）======
export async function rotateBackupSnapshot(): Promise<string> {
  const json = await exportDatabase()
  const ts = new Date().toISOString()
  // 顺移：prev2 ← prev ← latest ← 新快照
  const prev = await db.appState.get('backup:latest')
  const prev2 = await db.appState.get('backup:prev')
  if (prev) await db.appState.put({ ...prev, key: 'backup:prev' })
  if (prev2) await db.appState.put({ ...prev2, key: 'backup:prev2' })
  await db.appState.put({ key: 'backup:latest', at: ts, json })
  return ts
}

export async function listBackupSnapshots(): Promise<{ key: string; at?: string }[]> {
  const out: { key: string; at?: string }[] = []
  for (const key of ['backup:latest', 'backup:prev', 'backup:prev2']) {
    const rec = (await db.appState.get(key)) as any
    if (rec) out.push({ key, at: rec.at })
  }
  return out
}

// ====== 历史数据清理（保留 N 天）======
// events / agentRuns / workflowRuns / 已完结 approvals / 已同步墓碑 随时间无限增长，
// 启动时调用一次即可控制体积。未完结审批永不清除。

export async function cleanupOldRecords(days = 90): Promise<Record<string, number>> {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString()
  const result: Record<string, number> = {}

  result.events = await db.events.where('createdAt').below(cutoff).delete()
  result.agentRuns = await db.agentRuns.where('startedAt').below(cutoff).delete()
  result.workflowRuns = await db.workflowRuns.where('startedAt').below(cutoff).delete()
  result.deletions = await db.deletions.where('deletedAt').below(cutoff).delete()

  // 审批：只清已完结（拒绝 或 已执行）的旧记录
  result.approvals = await db.approvals
    .where('createdAt').below(cutoff)
    .filter(a => a.status === 'rejected' || !!a.executedAt)
    .delete()

  return result
}
