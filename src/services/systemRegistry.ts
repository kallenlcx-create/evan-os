// ====== System Registry —— 四层数据库注册中心（v1.0）======
// 把运行时的内存注册表（工具/权限/上下文/工作流版本）持久化到数据库，
// 并提供四层架构的唯一定义来源。

import { db } from '../db'
import type {
  AIContext, AgentToolRecord, AgentPermissionRecord,
  ContextSnapshotRecord, WorkflowDefinition,
} from '../types'
import { ACTION_PERMISSION, WORKFLOW_ACTION_LEVEL } from '../types'
import { AGENT_TOOLS } from './agentTools'
import { now } from '../repositories/result'

// ====== 四层架构定义（Single Source of Truth）======

export const DATA_LAYERS = {
  // 第一层：核心对象
  layer1_core_objects: [
    'goals', 'domains', 'projects', 'tasks',
    'customers', 'opportunities', 'orders', 'communications',
    'knowledge', 'inspirations', 'questions', 'research',
    'experiments', 'decisions', 'reviews', 'processes', 'agents',
  ],
  // 第二层：系统关系
  layer2_system_relations: ['relations', 'events'],
  // 第三层：AI
  layer3_ai: [
    'memories', 'agentRuns', 'agentTools', 'agentPermissions', 'contexts',
  ],
  // 第四层：自动化
  layer4_automation: [
    'workflows', 'workflowVersions', 'workflowSteps', 'workflowRuns', 'approvals',
  ],
} as const

export type LayerKey = keyof typeof DATA_LAYERS

export function layerOf(tableName: string): LayerKey | null {
  for (const key of Object.keys(DATA_LAYERS) as LayerKey[]) {
    if ((DATA_LAYERS[key] as readonly string[]).includes(tableName)) return key
  }
  return null
}

// ====== 工具/权限持久化同步 ======

/** 把运行时工具注册表写入 agentTools 表（幂等） */
export async function syncAgentTools(): Promise<number> {
  const ts = now()
  const records: AgentToolRecord[] = Object.values(AGENT_TOOLS).map(t => ({
    id: t.name, name: t.name, level: t.level, description: t.description, updatedAt: ts,
  }))
  await db.agentTools.bulkPut(records)
  return records.length
}

/** 把动作权限映射写入 agentPermissions 表（幂等，含 agent 与 workflow 两个域） */
export async function syncAgentPermissions(): Promise<number> {
  const ts = now()
  const rows: AgentPermissionRecord[] = []
  for (const [actionType, level] of Object.entries(ACTION_PERMISSION)) {
    rows.push({ id: `agent:${actionType}`, actionType, domain: 'agent', level, updatedAt: ts })
  }
  for (const [actionType, level] of Object.entries(WORKFLOW_ACTION_LEVEL)) {
    rows.push({ id: `workflow:${actionType}`, actionType, domain: 'workflow', level, updatedAt: ts })
  }
  await db.agentPermissions.bulkPut(rows)
  return rows.length
}

// ====== Context 快照持久化 ======

const MAX_CONTEXT_SNAPSHOTS = 30

export async function saveContextSnapshot(ctx: AIContext): Promise<void> {
  const focusSummary =
    (ctx.focus.page?.label ?? '') +
    (ctx.focus.objectType ? ` · ${ctx.focus.objectType}` : '')
  const record: ContextSnapshotRecord = {
    id: ctx.id,
    createdAt: ctx.createdAt,
    focusSummary,
    tokensUsed: ctx.tokensUsed,
    tokenBudget: ctx.tokenBudget,
    itemsCount: ctx.items.length,
    context: ctx,
  }
  await db.contexts.put(record)

  // 只保留最近 N 份快照
  const all = await db.contexts.orderBy('createdAt').reverse().toArray()
  if (all.length > MAX_CONTEXT_SNAPSHOTS) {
    await db.contexts.bulkDelete(all.slice(MAX_CONTEXT_SNAPSHOTS).map(r => r.id))
  }
}

export async function getRecentContextSnapshots(limit = 10): Promise<ContextSnapshotRecord[]> {
  try {
    return await db.contexts.orderBy('createdAt').reverse().limit(limit).toArray()
  } catch {
    return []
  }
}

// ====== 工作流版本/步骤规范化写入（由 workflowEngine.register 调用）======

export async function persistWorkflowVersion(wf: WorkflowDefinition): Promise<void> {
  const versionRow = {
    id: `${wf.id}:v${wf.version}`,
    workflowId: wf.id,
    version: wf.version,
    definition: wf as unknown as Record<string, any>,
    createdAt: now(),
  }
  await db.workflowVersions.put(versionRow)

  // 步骤规范化视图：每个版本各自保留一份（历史可回溯）
  const existingForVersion = await db.workflowSteps
    .where('workflowId').equals(wf.id)
    .filter(s => s.version === wf.version)
    .toArray()
  if (existingForVersion.length > 0) {
    await db.workflowSteps.bulkDelete(existingForVersion.map(s => s.id))
  }
  const stepRows = wf.steps.map((s, i) => ({
    id: `${wf.id}:v${wf.version}:${s.id}`,
    workflowId: wf.id,
    version: wf.version,
    order: i,
    stepId: s.id,
    name: s.name,
    action: s.action,
    requireApproval: s.requireApproval ?? false,
    updatedAt: now(),
  }))
  if (stepRows.length > 0) await db.workflowSteps.bulkPut(stepRows)
}

// ====== 全量同步（应用启动 / 系统页刷新时调用）======

export interface SystemSyncResult {
  tools: number
  permissions: number
  layers: Record<LayerKey, string[]>
}

export async function syncSystemRegistry(): Promise<SystemSyncResult> {
  const tools = await syncAgentTools()
  const permissions = await syncAgentPermissions()
  return {
    tools,
    permissions,
    layers: DATA_LAYERS as unknown as Record<LayerKey, string[]>,
  }
}
