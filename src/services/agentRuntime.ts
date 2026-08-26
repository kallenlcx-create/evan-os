// ====== Agent Runtime ======
// 职责：
//   1. 注册/描述 Agent（标准十要素结构）
//   2. 执行 Runner：注入 Context / Memory / Tools
//   3. 三级权限门控：
//        L1_auto    → 立即执行
//        L2_suggest → 入审批队列，用户批准后执行
//        L3_approval→ 入审批队列；用户批准后仍需显式 executeApproved（Human in the loop）
//   4. 触发器分发（manual / on_event）
// 不做：模型调用（分析由确定性启发式完成，未来可替换为 Provider）

import { db } from '../db'
import type {
  AgentId, AgentDefinition, AgentRunRecord, AgentRunInput,
  ApprovalRecord, AgentActionType, PermissionLevel,
  AgentActionOutcome, EventRecord, AIContext, Memory,
} from '../types'
import { ACTION_PERMISSION } from '../types'
import { uid, now, type Result, ok, err } from '../repositories/result'
import { AGENT_TOOLS, TOOL_IMPLS } from './agentTools'
import { memoryService } from './memoryService'
import { contextEngine } from './contextEngine'

// ====== Runner 签名 ======

export interface AgentRunContext {
  runId: string
  agentId: AgentId
  input: Record<string, any>
  /** L1 工具直呼（读写仅限 L1） */
  call: <T = any>(toolName: string, args?: any) => Promise<T>
  /** 提出动作：按权限等级路由（L1 即时 / L2、L3 入审批） */
  act: (type: AgentActionType, payload: Record<string, any>, summary: string) => Promise<AgentActionOutcome>
  /** 构建上下文（经 ContextEngine） */
  buildContext: () => Promise<AIContext>
  /** 读取生效中的记忆 */
  readMemories: (query?: string, limit?: number) => Promise<Memory[]>
}

export type AgentRunner = (ctx: AgentRunContext) => Promise<{ summary: string }>

// ====== Runtime ======

class AgentRuntime {
  private definitions = new Map<AgentId, AgentDefinition>()
  private runners = new Map<AgentId, AgentRunner>()

  // ---------- 注册与描述 ----------

  register(def: AgentDefinition, runner: AgentRunner): void {
    this.definitions.set(def.id, def)
    this.runners.set(def.id, runner)
  }

  listAgents(): AgentDefinition[] {
    return Array.from(this.definitions.values())
  }

  getAgent(id: AgentId): AgentDefinition | undefined {
    return this.definitions.get(id)
  }

  // ---------- 执行 ----------

  async run(agentId: AgentId, opts?: AgentRunInput): Promise<Result<AgentRunRecord>> {
    const def = this.definitions.get(agentId)
    const runner = this.runners.get(agentId)
    if (!def || !runner) return err(`Agent 未注册: ${agentId}`)

    const trigger = opts?.trigger ?? 'manual'
    const run: AgentRunRecord = {
      id: uid(),
      agentId,
      trigger,
      status: 'running',
      steps: [],
      actions: [],
      startedAt: now(),
    }
    await db.agentRuns.add(run)

    const pushStep = async (step: string) => {
      run.steps.push(step)
      await db.agentRuns.update(run.id, { steps: run.steps })
    }

    // 工具调用（仅允许 L1）
    const call = async <T>(toolName: string, args?: any): Promise<T> => {
      const tool = AGENT_TOOLS[toolName]
      if (!tool) throw new Error(`未知工具: ${toolName}`)
      if (!def.tools.includes(toolName)) throw new Error(`Agent ${agentId} 无权使用工具: ${toolName}`)
      if (tool.level !== 'L1_auto') {
        throw new Error(`工具 ${toolName} 权限为 ${tool.level}，只能通过 act()/审批流程触发`)
      }
      await pushStep(`tool:${toolName}(${safeJson(args)})`)
      return TOOL_IMPLS[toolName](args ?? {}, { agentId, runId: run.id }) as Promise<T>
    }

    // 动作路由
    const act = async (
      type: AgentActionType, payload: Record<string, any>, summary: string
    ): Promise<AgentActionOutcome> => {
      // 白名单：动作必须在 def.actions 中声明，防止 Runner 越权调用未授权动作
      if (!def.actions.some(a => a.type === type)) {
        throw new Error(`Agent ${agentId} 未声明动作: ${type}`)
      }
      const level = ACTION_PERMISSION[type]
      // Approval Policy 校验：声明强制人工确认的动作即使 L1 也升级
      const forcedHuman = def.approvalPolicy.requireHumanConfirm.includes(type)
      const autoBelow = def.approvalPolicy.autoExecuteBelow

      let outcome: AgentActionOutcome
      if (level === 'L1_auto' && !forcedHuman && autoBelow === 'L1_auto') {
        const implResult = await executeL1Action(type, payload, { agentId, runId: run.id })
        outcome = { type, level, mode: 'auto_executed', summary, result: implResult }
      } else {
        const approval = await enqueueApproval({
          runId: run.id, agentId, actionType: type, level, summary, payload,
        })
        outcome = { type, level, mode: 'pending_approval', summary, approvalId: approval.id }
      }
      run.actions.push(outcome)
      await db.agentRuns.update(run.id, { actions: run.actions })
      await pushStep(`act:${type}[${level}]→${outcome.mode}`)
      return outcome
    }

    const ctx: AgentRunContext = {
      runId: run.id,
      agentId,
      input: opts?.input ?? {},
      call,
      act,
      buildContext: async () => contextEngine.build({
        page: { path: `/agents`, label: `Agent: ${def.name}` },
        currentProjectId: opts?.input?.projectId,
        currentTaskId: opts?.input?.taskId,
        currentObject: opts?.input?.objectType && opts?.input?.objectId
          ? { type: opts.input.objectType, id: opts.input.objectId } : undefined,
        query: def.contextPolicy.queryHint ?? opts?.input?.query,
        includeMemories: def.contextPolicy.includeMemories,
        includeGoals: def.contextPolicy.includeGoals,
        recentEventsLimit: def.contextPolicy.recentEventsLimit,
        tokenBudget: 1500,
      }),
      readMemories: (q, limit) => memoryService.getRelevantMemories({
        query: q ?? def.contextPolicy.queryHint, limit: limit ?? 5, scopes: def.memoryScope.length ? def.memoryScope : undefined,
      }),
    }

    try {
      await pushStep(`start trigger=${trigger}`)
      const { summary } = await runner(ctx)
      run.status = 'completed'
      run.summary = summary
    } catch (e) {
      run.status = 'failed'
      run.error = String(e).slice(0, 500)
    }
    // 运行失败时级联驳回其未决审批，避免孤儿审批在运行结束后仍可被执行
    if (run.status === 'failed') {
      try {
        const pendings = await db.approvals.where('runId').equals(run.id).toArray()
        for (const p of pendings.filter(x => x.status === 'pending')) {
          await db.approvals.put({
            ...p, status: 'rejected', decidedAt: now(),
            executionError: '所属运行失败，自动驳回',
          })
        }
      } catch { /* 级联驳回失败不影响主流程 */ }
    }
    run.finishedAt = now()
    await db.agentRuns.put(run)
    return run.status === 'completed' ? ok(run) : err(run.error ?? 'run failed')
  }

  // ---------- 审批队列 ----------

  /**
   * 外部直接提交审批（供未来 Provider / 测试 / 高级流程使用）。
   * 白名单校验：Agent 必须已注册且动作在其 def.actions 中声明。
   */
  async submitApproval(a: {
    agentId: AgentId
    actionType: AgentActionType
    summary: string
    payload: Record<string, any>
    runId?: string
    level?: PermissionLevel
  }): Promise<ApprovalRecord> {
    const def = this.definitions.get(a.agentId)
    if (!def) throw new Error(`Agent 未注册: ${a.agentId}`)
    if (!def.actions.some(x => x.type === a.actionType)) {
      throw new Error(`Agent ${a.agentId} 未声明动作: ${a.actionType}`)
    }
    return enqueueApproval({
      runId: a.runId ?? 'external',
      agentId: a.agentId,
      actionType: a.actionType,
      level: a.level ?? ACTION_PERMISSION[a.actionType],
      summary: a.summary,
      payload: a.payload,
    })
  }

  async getPendingApprovals(agentId?: AgentId): Promise<ApprovalRecord[]> {
    try {
      const rows = await db.approvals.where('status').equals('pending').toArray()
      return agentId ? rows.filter(a => a.agentId === agentId) : rows
    } catch {
      return []
    }
  }

  async getAllApprovals(limit = 50): Promise<ApprovalRecord[]> {
    try {
      return await db.approvals.orderBy('createdAt').reverse().limit(limit).toArray()
    } catch {
      return []
    }
  }

  /**
   * 用户批准。
   * L2：批准即执行。
   * L3：批准只改变状态，必须再调用 executeApproved()（Human → Execute）。
   * CAS 事务迁移 pending→approved：并发双击只有一次生效。
   */
  async approve(approvalId: string): Promise<Result<ApprovalRecord>> {
    const claimed = await casApproval(approvalId, 'pending', 'approved')
    if (claimed.ok === false) return err(claimed.error)
    const a = claimed.value
    if (a.source === 'workflow') return err('工作流审批请使用 workflowEngine 执行')

    if (a.level === 'L2_suggest') {
      return this.executeApproved(approvalId)
    }
    return ok(a) // L3 停在 approved，等待显式执行
  }

  async reject(approvalId: string, reason?: string): Promise<Result<ApprovalRecord>> {
    return casApproval(approvalId, 'pending', 'rejected', { executionError: reason })
  }

  /**
   * 显式执行已批准的动作。
   * L3 必须携带 humanToken —— 这是 AI → Approval → Human → Execute 的最后一环。
   * 执行前在事务内预占 executedAt（CAS），防止双击/并发导致动作重复执行。
   */
  async executeApproved(approvalId: string, humanToken?: string): Promise<Result<ApprovalRecord>> {
    const claim = await db.transaction('rw', db.approvals, async (): Promise<Result<ApprovalRecord>> => {
      const cur = await db.approvals.get(approvalId)
      if (!cur) return err('审批不存在')
      if (cur.source === 'workflow') return err('工作流审批请使用 workflowEngine 执行')
      if ((cur.status as string) !== 'approved') return err('只有 approved 状态才能执行')
      if (cur.executedAt) return err('该审批已执行过，不可重复执行')
      if (cur.level === 'L3_approval' && humanToken !== 'human-confirmed') {
        return err('L3 动作必须人工显式执行（缺少 humanToken）')
      }
      const claimed: ApprovalRecord = { ...cur, executedAt: now() }
      await db.approvals.put(claimed)
      return ok(claimed)
    })
    if (claim.ok === false) return err(claim.error)
    const a = claim.value

    const impl = TOOL_IMPLS[toolForAction(a)]
    if (!impl) {
      const failed: ApprovalRecord = { ...a, executionError: `无实现工具: ${a.actionType}` }
      await db.approvals.put(failed)
      return err(failed.executionError)
    }

    try {
      const result = await impl(a.payload, { agentId: a.agentId, runId: a.runId })
      if (result && result.ok === false) {
        const failed: ApprovalRecord = { ...a, executionError: String(result.error) }
        await db.approvals.put(failed)
        return err(String(result.error))
      }
      const done: ApprovalRecord = {
        ...a,
        executionResult: normalizeExecResult(result),
      }
      await db.approvals.put(done)
      return ok(done)
    } catch (e) {
      const failed: ApprovalRecord = { ...a, executionError: String(e).slice(0, 300) }
      await db.approvals.put(failed)
      return err(failed.executionError!)
    }
  }

  // ---------- 触发器分发 ----------

  /** 事件发生时调用：匹配 on_event 触发器并自动运行对应 Agent */
  async handleEvent(event: Pick<EventRecord, 'type'> & Record<string, any>): Promise<void> {
    for (const def of this.definitions.values()) {
      const match = def.triggers.some(t =>
        t.type === 'on_event' && t.eventType === event.type)
      if (match) {
        await this.run(def.id, {
          trigger: 'on_event',
          input: { eventType: event.type, objectId: (event as any).objectId },
        }).catch(() => {})
      }
    }
  }
}

// ====== 内部辅助 ======

function safeJson(v: any): string {
  try { return JSON.stringify(v)?.slice(0, 120) ?? '' } catch { return '' }
}

/** 审批状态 CAS 迁移（事务内校验 from 状态，防止并发双击双执行） */
async function casApproval(
  approvalId: string,
  from: 'pending' | 'approved',
  to: ApprovalRecord['status'],
  extra?: Partial<ApprovalRecord>
): Promise<Result<ApprovalRecord>> {
  try {
    return await db.transaction('rw', db.approvals, async (): Promise<Result<ApprovalRecord>> => {
      const cur = await db.approvals.get(approvalId)
      if (!cur) return err('审批不存在')
      if ((cur.status as string) !== from) return err(`当前状态不可操作: ${cur.status}`)
      const next: ApprovalRecord = { ...cur, status: to, decidedAt: now(), ...extra }
      await db.approvals.put(next)
      return ok(next)
    })
  } catch (e) {
    return err(String(e))
  }
}

/** L1 动作的立即执行实现 */
async function executeL1Action(
  type: AgentActionType,
  payload: Record<string, any>,
  tctx: { agentId: string; runId: string }
): Promise<Record<string, any> | undefined> {
  switch (type) {
    case 'inbox_annotate':
      return TOOL_IMPLS['inbox.annotate'](payload, tctx)
    case 'relation_suggest':
      return TOOL_IMPLS['relation.create'](payload, tctx)
    case 'summary_generate':
      return { ok: true }  // 摘要内容随 report 返回，无需副作用
    default:
      throw new Error(`动作 ${type} 不是 L1 自动动作`)
  }
}

/** 审批入队 */
async function enqueueApproval(a: {
  runId: string; agentId: AgentId; actionType: AgentActionType
  level: PermissionLevel; summary: string; payload: Record<string, any>
}): Promise<ApprovalRecord> {
  const record: ApprovalRecord = {
    id: uid(),
    runId: a.runId,
    agentId: a.agentId,
    source: 'agent',
    actionType: a.actionType,
    level: a.level,
    summary: a.summary,
    payload: a.payload,
    status: 'pending',
    createdAt: now(),
  }
  await db.approvals.add(record)
  return record
}

/** 动作类型 → 执行工具名 */
function toolForAction(a: Pick<ApprovalRecord, 'actionType'>): string {
  const map: Partial<Record<AgentActionType, string>> = {
    knowledge_draft: 'knowledge.create',
    task_draft: 'task.create',
    project_draft: 'project.create',
    review_draft: 'review.create',
    research_draft: 'research.create',
    status_change: 'task.status',
    external_call: 'external.request',
    destructive: 'data.delete',
  }
  return map[a.actionType] ?? ''
}

function normalizeExecResult(r: any): Record<string, any> {
  if (r && typeof r === 'object' && 'id' in r) return { id: r.id, title: (r as any).title }
  if (r && typeof r === 'object') return r as Record<string, any>
  return {}
}

// ====== 全局单例 ======
export const agentRuntime = new AgentRuntime()
