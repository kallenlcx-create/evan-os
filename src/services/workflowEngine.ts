// ====== Automation Engine ======
// 基于 Event / Agent / Context / Relation 的内部工作流引擎
// 触发器：Event / Time / Manual
// 条件：AND / OR / NOT（可嵌套）
// 动作：Create Object / Update Object / Create Relation / Run Agent / Send Notification / 外部 Mock
//
// 约束：
//   - 不连接 Gmail / Shopify / n8n；external_mock 仅返回桩结果且强制审批
//   - delete_object 强制审批
//   - Workflow 拥有：状态、版本、执行记录、错误、重试、日志

import { db } from '../db'
import type {
  WorkflowDefinition, WorkflowRunRecord, WorkflowStepLog,
  WorkflowConditionNode, WorkflowActionType, WorkflowStatus,
  ApprovalRecord, PermissionLevel, EventType,
} from '../types'
import { WORKFLOW_ACTION_LEVEL } from '../types'
import { uid, now, type Result, ok, err } from '../repositories/result'
import { createRelation } from '../repositories/relationRepository'
import { updateObject, createObject, getObject } from '../repositories/objectRepository'
import { MEMORY_AI_CONFIDENCE_CAP } from '../repositories/memoryRepository'

// ====== 高风险动作（硬编码，不可绕过）======
const ALWAYS_APPROVAL: WorkflowActionType[] = ['external_mock', 'delete_object']

// ====== 条件求值 ======

function resolvePath(obj: Record<string, any>, path: string): any {
  return path.split('.').reduce((acc: any, key) => (acc == null ? undefined : acc[key]), obj)
}

export function evaluateCondition(
  node: WorkflowConditionNode | undefined,
  context: Record<string, any>
): boolean {
  if (!node) return true
  if (node.kind === 'group') {
    if (node.op === 'and') return node.children.every(c => evaluateCondition(c, context))
    if (node.op === 'or') return node.children.some(c => evaluateCondition(c, context))
    if (node.op === 'not') return !node.children.every(c => evaluateCondition(c, context))
    return false
  }
  // leaf
  const actual = resolvePath(context, node.field)
  switch (node.operator) {
    case 'eq': return actual === node.value
    case 'ne': return actual !== node.value
    case 'contains':
      if (Array.isArray(actual)) return actual.includes(node.value)
      return String(actual ?? '').toLowerCase().includes(String(node.value ?? '').toLowerCase())
    case 'gt': return compare(actual, node.value) > 0
    case 'lt': return compare(actual, node.value) < 0
    case 'exists': return actual !== undefined && actual !== null
    case 'missing': return actual === undefined || actual === null
    default: return false
  }
}

function compare(a: any, b: any): number {
  const na = typeof a === 'number' ? a : Date.parse(a)
  const nb = typeof b === 'number' ? b : Date.parse(b)
  if (Number.isNaN(na) || Number.isNaN(nb)) return String(a ?? '').localeCompare(String(b ?? ''))
  return na - nb
}

// ====== 模板插值 {{path}} ======

export function interpolate(params: Record<string, any>, context: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(params)) {
    out[k] = typeof v === 'string' ? fillTemplate(v, context) : v
  }
  return out
}

function fillTemplate(tpl: string, context: Record<string, any>): string {
  return tpl.replace(/\{\{([^}]+)\}\}/g, (_, path) => {
    const v = resolvePath(context, path.trim())
    return v === undefined || v === null ? '' : String(v)
  })
}

// ====== 动作实现 ======

async function executeWorkflowAction(
  action: WorkflowActionType,
  params: Record<string, any>,
  meta: { workflowId: string; runId: string }
): Promise<Record<string, any>> {
  switch (action) {
    case 'create_object': {
      const r = await createObject(params.objectType, params.data ?? {})
      if (r.ok === false) throw new Error(String(r.error))
      return { id: r.value.id }
    }
    case 'update_object': {
      const r = await updateObject(params.objectType, params.objectId, params.patch ?? {})
      if (r.ok === false) throw new Error(String(r.error))
      return { updated: params.objectId }
    }
    case 'create_relation': {
      const confidence = Math.min(params.confidence ?? MEMORY_AI_CONFIDENCE_CAP, MEMORY_AI_CONFIDENCE_CAP)
      const r = await createRelation(
        params.sourceType, params.sourceId,
        params.targetType, params.targetId,
        params.relationType ?? 'related_to',
        { createdBy: 'system', source: 'automation', confidence, metadata: { workflowId: meta.workflowId, runId: meta.runId, reason: params.reason } }
      )
      if (r.ok === false) throw new Error(String(r.error))
      return { id: r.value.id }
    }
    case 'run_agent': {
      const { agentRuntime } = await import('./agentRuntime')
      const r = await agentRuntime.run(params.agentId, {
        trigger: 'manual',
        input: params.input ?? {},
      })
      if (r.ok === false) throw new Error(String(r.error))
      return { runId: r.value.id, summary: r.value.summary }
    }
    case 'send_notification': {
      const notification = {
        id: uid(),
        title: String(params.title ?? '自动化通知'),
        message: String(params.message ?? ''),
        type: 'system' as const,
        read: false,
        createdAt: now(),
        targetId: params.targetId,
        metadata: { workflowId: meta.workflowId, runId: meta.runId },
      }
      await db.notifications.add(notification)
      return { notificationId: notification.id }
    }
    case 'external_mock': {
      // Mock：绝不真实外呼。未来接入受信 Provider 后替换此桩。
      return { mock: true, endpoint: params.endpoint ?? null, note: 'external mock executed after human approval' }
    }
    case 'delete_object': {
      const obj = await getObject(params.objectType, params.objectId)
      if (!obj) throw new Error(`对象不存在: ${params.objectId}`)
      await db.table(tableNameFor(params.objectType)).delete(params.objectId)
      return { deleted: params.objectId }
    }
    default:
      throw new Error(`未知动作: ${action}`)
  }
}

function tableNameFor(type: string): string {
  const map: Record<string, string> = {
    goal: 'goals', project: 'projects', task: 'tasks', knowledge: 'knowledge',
    inspiration: 'inspirations', question: 'questions', research: 'research',
    experiment: 'experiments', decision: 'decisions', review: 'reviews', process: 'processes',
  }
  return map[type] ?? type
}

// ====== WorkflowEngine ======

class WorkflowEngine {
  /**
   * 注册/更新工作流。
   * 内容有变化时版本号自增；内容相同则保持版本不变。
   */
  async register(def: Omit<WorkflowDefinition, 'version' | 'createdAt' | 'updatedAt' | 'triggerType'> & { version?: number; createdAt?: string }): Promise<Result<WorkflowDefinition>> {
    if (!def.id || !def.name) return err('workflow 需要 id 与 name')
    if (!def.steps || def.steps.length === 0) return err('workflow 至少需要一个步骤')

    const existing = await db.workflows.get(def.id)
    const ts = now()
    let version = 1

    if (existing) {
      const sameContent =
        JSON.stringify(stripVolatile(existing)) === JSON.stringify(stripVolatile({ ...existing, ...def } as any))
      version = sameContent ? existing.version : existing.version + 1
    }

    const record: WorkflowDefinition = {
      ...def,
      status: def.status ?? 'draft',
      triggerType: def.trigger.type,
      version,
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
      lastRunAt: existing?.lastRunAt,
      runCount: existing?.runCount ?? 0,
    } as WorkflowDefinition

    await db.workflows.put(record)

    // v1.0：版本快照 + 步骤规范化视图持久化
    const { persistWorkflowVersion } = await import('./systemRegistry')
    await persistWorkflowVersion(record as WorkflowDefinition)

    return ok(record)
  }

  async get(id: string): Promise<WorkflowDefinition | undefined> {
    return db.workflows.get(id)
  }

  async list(status?: WorkflowStatus): Promise<WorkflowDefinition[]> {
    try {
      const rows = status
        ? await db.workflows.where('status').equals(status).toArray()
        : await db.workflows.toArray()
      return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    } catch {
      return []
    }
  }

  async setStatus(id: string, status: WorkflowStatus): Promise<Result<WorkflowDefinition>> {
    const wf = await db.workflows.get(id)
    if (!wf) return err('工作流不存在')
    const updated: WorkflowDefinition = { ...wf, status, updatedAt: now() }
    await db.workflows.put(updated)
    return ok(updated)
  }

  // ---------- 触发 ----------

  /** Manual Trigger */
  async triggerManual(id: string, opts?: { input?: Record<string, any> }): Promise<Result<WorkflowRunRecord>> {
    const wf = await db.workflows.get(id)
    if (!wf) return err('工作流不存在')
    if (wf.status !== 'active' && wf.status !== 'draft') {
      return err(`工作流状态为 ${wf.status}，无法手动运行`)
    }
    return this.execute(wf, { type: 'manual', source: 'user' }, { input: opts?.input ?? {} })
  }

  /** Event Trigger */
  async handleEvent(event: { type: EventType; payload?: Record<string, any>; objectType?: string; objectId?: string }): Promise<void> {
    try {
      const actives = await db.workflows.where('status').equals('active').toArray()
      const matches = actives.filter(w =>
        w.trigger.type === 'event' && w.trigger.eventType === event.type)
      for (const wf of matches) {
        const context = {
          event: {
            type: event.type,
            objectType: event.objectType,
            objectId: event.objectId,
            payload: event.payload ?? {},
          },
          input: {},
        }
        if (!evaluateCondition(wf.condition, context)) continue
        await this.execute(wf, { type: 'event', source: `${event.type}` }, context)
      }
    } catch { /* 事件分发失败不阻塞业务 */ }
  }

  /** Time Trigger：由外部周期调用（UI 定时器 / 手动 tick） */
  async tick(nowMs = Date.now()): Promise<void> {
    try {
      const actives = await db.workflows.where('status').equals('active').toArray()
      for (const wf of actives) {
        if (wf.trigger.type !== 'time') continue
        if (!this.isTimeDue(wf, nowMs)) continue
        await this.execute(wf, { type: 'time', source: wf.trigger.atTime ? `daily@${wf.trigger.atTime}` : `every${wf.trigger.intervalMinutes}m` }, { input: {} })
      }
    } catch { /* ignore */ }
  }

  private isTimeDue(wf: WorkflowDefinition, nowMs: number): boolean {
    const last = wf.lastRunAt ? Date.parse(wf.lastRunAt) : 0
    if (wf.trigger.intervalMinutes != null) {
      return nowMs - last >= wf.trigger.intervalMinutes * 60000
    }
    if (wf.trigger.atTime) {
      const [h, m] = wf.trigger.atTime.split(':').map(Number)
      const due = new Date(nowMs)
      due.setHours(h, m, 0, 0)
      return nowMs >= due.getTime() && last < due.getTime()
    }
    return false
  }

  // ---------- 执行 ----------

  private async execute(
    wf: WorkflowDefinition,
    triggerInfo: { type: 'event' | 'time' | 'manual'; source?: string },
    context: Record<string, any>
  ): Promise<Result<WorkflowRunRecord>> {
    const run: WorkflowRunRecord = {
      id: uid(),
      workflowId: wf.id,
      workflowVersion: wf.version,
      status: 'running',
      triggerInfo,
      contextSnapshot: boundedContext(context),
      logs: [],
      startedAt: now(),
    }
    await db.workflowRuns.add(run)

    try {
      await this.runSteps(wf, run, context, 0)
    } catch (e) {
      // 审批挂起是正常暂停，不算失败；步骤失败已在 runSteps 内落状态
      if (!(e instanceof AWAITING_APPROVAL_SIGNAL) && !(e instanceof STEP_FAILURE_SIGNAL)) {
        run.status = 'failed'
        run.error = String(e).slice(0, 500)
      }
    }

    if (run.status === 'running') run.status = 'completed'
    run.finishedAt = now()
    await db.workflowRuns.put(run)
    await bumpWorkflowStats(wf.id)
    return ok(run)
  }

  /** 从 stepIndex 开始执行步骤；遇审批门控则挂起 */
  private async runSteps(
    wf: WorkflowDefinition,
    run: WorkflowRunRecord,
    context: Record<string, any>,
    stepIndex: number
  ): Promise<void> {
    for (let i = stepIndex; i < wf.steps.length; i++) {
      const step = wf.steps[i]
      const level: PermissionLevel = WORKFLOW_ACTION_LEVEL[step.action]
      // 高风险动作（external_mock/delete_object）强制审批；
      // 其他动作默认随运行自动执行，除非步骤显式 requireApproval
      const mustApprove =
        ALWAYS_APPROVAL.includes(step.action) || step.requireApproval === true

      const log: WorkflowStepLog = {
        stepId: step.id, name: step.name,
        status: 'success', attempts: 0,
        startedAt: now(),
      }

      if (mustApprove) {
        log.status = 'awaiting_approval'
        log.finishedAt = now()
        run.logs.push(log)
        run.pendingStepIndex = i
        run.status = 'awaiting_approval'
        await this.enqueueStepApproval(wf, run, step, i)
        // 挂起：后续步骤等批准后由 resume 驱动
        throw new AWAITING_APPROVAL_SIGNAL()
      }

      const resolved = interpolate(step.params, context)
      const maxAttempts = (step.retry?.maxAttempts ?? 1)
      let lastError = ''

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        log.attempts = attempt
        try {
          log.result = await executeWorkflowAction(step.action, resolved, {
            workflowId: wf.id, runId: run.id,
          })
          lastError = ''
          break
        } catch (e) {
          lastError = String(e).slice(0, 300)
          if (attempt < maxAttempts) await sleep(step.retry?.backoffMs ?? 50)
        }
      }

      if (lastError) {
        log.status = 'failed'
        log.error = lastError
        log.finishedAt = now()
        run.logs.push(log)
        await db.workflowRuns.update(run.id, { logs: run.logs })

        if (step.continueOnError) continue
        run.status = 'failed'
        run.error = `步骤「${step.name}」失败: ${lastError}`
        throw new STEP_FAILURE_SIGNAL()
      }

      log.finishedAt = now()
      run.logs.push(log)
      // 把步骤产出注入后续模板上下文
      context.lastResult = log.result
      await db.workflowRuns.update(run.id, { logs: run.logs })
    }
  }

  private async enqueueStepApproval(
    wf: WorkflowDefinition,
    run: WorkflowRunRecord,
    step: { id: string; name: string; action: WorkflowActionType },
    stepIndex: number
  ): Promise<void> {
    const level: PermissionLevel = WORKFLOW_ACTION_LEVEL[step.action]
    const approval: ApprovalRecord = {
      id: uid(),
      runId: run.id,
      source: 'workflow',
      workflowId: wf.id,
      workflowRunId: run.id,
      stepId: step.id,
      actionType: step.action,
      level,
      summary: `工作流「${wf.name}」步骤「${step.name}」等待批准`,
      payload: {},
      status: 'pending',
      createdAt: now(),
    }
    approval.payload = {
      stepIndex, action: step.action, stepName: step.name, note: '参数在执行时从上下文重新解析',
    }
    await db.approvals.add(approval)
    await db.workflowRuns.update(run.id, { status: run.status, logs: run.logs, pendingStepIndex: run.pendingStepIndex })
  }

  // ---------- 审批与恢复 ----------

  async getWorkflowApprovals(status?: 'pending' | 'approved' | 'rejected'): Promise<ApprovalRecord[]> {
    try {
      const rows = await db.approvals.where('source').equals('workflow').toArray()
      return rows.filter(a => !status || a.status === status)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    } catch {
      return []
    }
  }

  /**
   * 用户批准挂起的步骤。
   * L2（create/update object）：批准即执行并恢复后续流程。
   * L3（external_mock/delete）：批准后仍需 executeApproved(humanToken) 显式执行。
   * CAS 事务迁移，防并发双击。
   */
  async approve(approvalId: string): Promise<Result<ApprovalRecord>> {
    const claimed = await casWorkflowApproval(approvalId, 'pending', 'approved')
    if (claimed.ok === false) return err(claimed.error)
    const a = claimed.value

    if (a.level === 'L3_approval') return ok(a) // 等 Human 显式执行
    return this.executeApproved(approvalId)
  }

  async reject(approvalId: string, reason?: string): Promise<Result<ApprovalRecord>> {
    const rejected = await casWorkflowApproval(approvalId, 'pending', 'rejected', { executionError: reason })
    if (rejected.ok === false) return err(rejected.error)
    const a = rejected.value

    // 拒绝 = 取消整个运行
    if (a.workflowRunId) {
      const run = await db.workflowRuns.get(a.workflowRunId)
      if (run && (run.status as string) === 'awaiting_approval') {
        run.status = 'cancelled'
        run.error = reason ?? '步骤被拒绝'
        run.finishedAt = now()
        await db.workflowRuns.put(run)
      }
    }
    return ok(a)
  }

  /** L3 显式执行 + 恢复后续步骤；事务内预占 executedAt 防重复执行 */
  async executeApproved(approvalId: string, humanToken?: string): Promise<Result<ApprovalRecord>> {
    const claim = await db.transaction('rw', db.approvals, async (): Promise<Result<ApprovalRecord>> => {
      const cur = await db.approvals.get(approvalId)
      if (!cur) return err('审批不存在')
      if (cur.source !== 'workflow') return err('非工作流审批')
      if ((cur.status as string) !== 'approved') return err('只有 approved 状态才能执行')
      if (cur.executedAt) return err('该审批已执行过，不可重复执行')
      if (cur.level === 'L3_approval' && humanToken !== 'human-confirmed') {
        return err('高风险动作必须人工显式执行（缺少 humanToken）')
      }
      const claimed: ApprovalRecord = { ...cur, executedAt: now() }
      await db.approvals.put(claimed)
      return ok(claimed)
    })
    if (claim.ok === false) return err(claim.error)
    const a = claim.value

    const wf = a.workflowId ? await db.workflows.get(a.workflowId) : undefined
    const run = a.workflowRunId ? await db.workflowRuns.get(a.workflowRunId) : undefined
    if (!wf || !run) return err('找不到关联的工作流或运行记录')

    // 重新解析该步参数（上下文可能已被前序步骤更新）
    const step = wf.steps.find(s => s.id === a.stepId) ?? wf.steps[a.payload.stepIndex ?? 0]
    if (!step) return err('找不到对应步骤定义')

    try {
      const result = await executeWorkflowAction(step.action, interpolate(step.params, run.contextSnapshot), {
        workflowId: wf.id, runId: run.id,
      })
      // 更新日志
      const log = run.logs.find(l => l.stepId === step.id)
      if (log) {
        log.status = 'success'
        log.result = result
        log.finishedAt = now()
      }
      const done: ApprovalRecord = { ...a, executionResult: result }
      await db.approvals.put(done)

      // 恢复后续步骤
      const startIndex = wf.steps.findIndex(s => s.id === step.id) + 1
      run.status = 'running'
      run.pendingStepIndex = undefined
      await db.workflowRuns.put(run)
      try {
        await this.runSteps(wf, run, run.contextSnapshot, startIndex)
      } catch (e) {
        // 连续第二个审批门控会再次抛出挂起信号：运行保持 awaiting，不得盖上结束时间
        if (!(e instanceof AWAITING_APPROVAL_SIGNAL)) {
          run.status = 'failed'
          run.error = String(e).slice(0, 500)
        }
      }
      if ((run.status as string) === 'running') run.status = 'completed'
      if ((run.status as string) !== 'awaiting_approval') run.finishedAt = now()
      await db.workflowRuns.put(run)
      return ok(done)
    } catch (e) {
      const failed: ApprovalRecord = { ...a, executionError: String(e).slice(0, 300) }
      await db.approvals.put(failed)
      run.status = 'failed'
      run.error = String(e).slice(0, 500)
      run.finishedAt = now()
      await db.workflowRuns.put(run)
      return err(failed.executionError!)
    }
  }

  // ---------- 运行记录查询 ----------

  async getRuns(workflowId: string, limit = 20): Promise<WorkflowRunRecord[]> {
    try {
      const rows = await db.workflowRuns.where('workflowId').equals(workflowId).toArray()
      return rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit)
    } catch {
      return []
    }
  }

  async getAllRuns(limit = 30): Promise<WorkflowRunRecord[]> {
    try {
      return await db.workflowRuns.orderBy('startedAt').reverse().limit(limit).toArray()
    } catch {
      return []
    }
  }
}

// ====== 辅助 ======

class AWAITING_APPROVAL_SIGNAL extends Error {}

/** 工作流审批状态 CAS 迁移（事务内校验 from 状态，防并发双击） */
async function casWorkflowApproval(
  approvalId: string,
  from: 'pending' | 'approved',
  to: ApprovalRecord['status'],
  extra?: Partial<ApprovalRecord>
): Promise<Result<ApprovalRecord>> {
  try {
    return await db.transaction('rw', db.approvals, async (): Promise<Result<ApprovalRecord>> => {
      const cur = await db.approvals.get(approvalId)
      if (!cur) return err('审批不存在')
      if (cur.source !== 'workflow') return err('非工作流审批')
      if ((cur.status as string) !== from) return err(`当前状态不可操作: ${cur.status}`)
      const next: ApprovalRecord = { ...cur, status: to, decidedAt: now(), ...extra }
      await db.approvals.put(next)
      return ok(next)
    })
  } catch (e) {
    return err(String(e))
  }
}
class STEP_FAILURE_SIGNAL extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function stripVolatile(def: Partial<WorkflowDefinition>): Record<string, any> {
  const { version, createdAt, updatedAt, lastRunAt, runCount, status, ...rest } = def as any
  void version; void createdAt; void updatedAt; void lastRunAt; void runCount; void status
  return rest
}

function boundedContext(ctx: Record<string, any>): Record<string, any> {
  const json = JSON.stringify(ctx)
  if (json.length <= 4000) return ctx
  return { _truncated: true, preview: json.slice(0, 4000) }
}

async function bumpWorkflowStats(id: string): Promise<void> {
  const wf = await db.workflows.get(id)
  if (!wf) return
  await db.workflows.put({
    ...wf,
    lastRunAt: now(),
    runCount: (wf.runCount ?? 0) + 1,
  })
}

export const workflowEngine = new WorkflowEngine()

// ====== 示例模板（页面可一键安装）======

export const WORKFLOW_TEMPLATES: Array<Omit<WorkflowDefinition,
  'version' | 'createdAt' | 'updatedAt' | 'triggerType' | 'status' | 'lastRunAt' | 'runCount'>> = [
  {
    id: 'wf-inbox-auto-organize',
    name: '收集箱自动整理',
    emoji: '📥',
    description: '新内容进入收集箱时，自动运行知识整理助手',
    trigger: { type: 'event', eventType: 'inbox.captured', description: '捕获新内容时' },
    steps: [
      { id: 's1', name: '运行知识整理助手', action: 'run_agent', params: { agentId: 'knowledge_organizer', input: {} } },
    ],
  },
  {
    id: 'wf-daily-review-reminder',
    name: '每日复盘提醒',
    emoji: '⏰',
    description: '每天 21:00 发送复盘提醒通知',
    trigger: { type: 'time', atTime: '21:00', description: '每日 21:00' },
    steps: [
      { id: 's1', name: '发送提醒通知', action: 'send_notification', params: { title: '复盘时间到', message: '花 5 分钟回顾一下今天吧' } },
    ],
  },
]
