// ====== Agent Tools ======
// Agent 可用的工具注册表：每个工具声明权限等级
// L1 工具可被 Agent 直接调用；L2/L3 工具只能由审批流程触发执行

import { db } from '../db'
import type { PermissionLevel, Task } from '../types'
import type { Result } from '../repositories/result'
import { now } from '../repositories/result'
import {
  createKnowledge, getBacklinks,
} from '../repositories/knowledgeRepository'
import { createProject } from '../repositories/projectRepository'
import { createTask } from '../repositories/taskRepository'
import { createRelation, getTasksForProject } from '../repositories/relationRepository'
import { createObject, getObject } from '../repositories/objectRepository'
import { createEvent, getAllEvents } from '../repositories/eventRepository'
import { MEMORY_AI_CONFIDENCE_CAP } from '../repositories/memoryRepository'

// ====== 工具描述符 ======

export interface ToolDescriptor {
  name: string
  level: PermissionLevel
  description: string
}

export const AGENT_TOOLS: Record<string, ToolDescriptor> = {
  // ---- L1 读取 ----
  'inbox.list':        { name: 'inbox.list',        level: 'L1_auto', description: '读取未处理的收集项' },
  'knowledge.search':  { name: 'knowledge.search',  level: 'L1_auto', description: '按关键词搜索知识' },
  'knowledge.get':     { name: 'knowledge.get',     level: 'L1_auto', description: '读取知识详情/backlinks' },
  'knowledge.list_all': { name: 'knowledge.list_all', level: 'L1_auto', description: '有界读取全部知识（供整理分析）' },
  'project.get':       { name: 'project.get',       level: 'L1_auto', description: '读取项目详情' },
  'project.tasks':     { name: 'project.tasks',     level: 'L1_auto', description: '读取项目下的任务关系' },
  'task.list_open':    { name: 'task.list_open',    level: 'L1_auto', description: '读取未完成任务' },
  'task.list_done':    { name: 'task.list_done',    level: 'L1_auto', description: '读取已完成任务（按更新时间倒序）' },
  'event.recent':      { name: 'event.recent',      level: 'L1_auto', description: '读取最近事件流' },
  'dailyLog.latest':   { name: 'dailyLog.latest',   level: 'L1_auto', description: '读取最近的每日日志' },
  'question.list_open': { name: 'question.list_open', level: 'L1_auto', description: '读取开放的问题' },
  // ---- Hermes（v0.8 集成工具层）----
  'hermes.find_unreplied': { name: 'hermes.find_unreplied', level: 'L1_auto', description: '找出过去 N 天未收到回复的客户' },
  'hermes.draft_email':    { name: 'hermes.draft_email',    level: 'L1_auto', description: '草拟跟进邮件' },
  'hermes.send_email':     { name: 'hermes.send_email',     level: 'L3_approval', description: '发送邮件（必须人工批准，经 CommandBus Mock 外呼）' },
  'context.build':     { name: 'context.build',     level: 'L1_auto', description: '构建 AIContext（经 ContextEngine）' },
  'memory.read':       { name: 'memory.read',       level: 'L1_auto', description: '读取生效中的记忆' },
  // ---- L1 写入（整理/摘要/建议关系）----
  'inbox.annotate':    { name: 'inbox.annotate',    level: 'L1_auto', description: '为收集项标注 AI 分类与标签' },
  'relation.create':   { name: 'relation.create',   level: 'L1_auto', description: '创建 AI 建议的关系记录（置信度封顶）' },
  // ---- L2 写入（需用户确认）----
  'knowledge.create':  { name: 'knowledge.create',  level: 'L2_suggest', description: '创建知识条目' },
  'task.create':       { name: 'task.create',       level: 'L2_suggest', description: '创建任务' },
  'project.create':    { name: 'project.create',    level: 'L2_suggest', description: '创建项目' },
  'review.create':     { name: 'review.create',     level: 'L2_suggest', description: '创建复盘记录' },
  'research.create':   { name: 'research.create',   level: 'L2_suggest', description: '创建研究条目' },
  'task.status':       { name: 'task.status',       level: 'L2_suggest', description: '修改任务状态' },
  // ---- L3（必须人工批准 + 显式执行）----
  'external.request':  { name: 'external.request',  level: 'L3_approval', description: '执行外部 API / 发送邮件 / 支付等外部动作' },
  'data.delete':       { name: 'data.delete',       level: 'L3_approval', description: '删除重要数据' },
}

// ====== 工具实现（由 Runtime 调度，Agent 不直接触达数据库写入）======

export interface ToolExecutionContext {
  agentId: string
  runId: string
}

export const TOOL_IMPLS: Record<string, (args: any, tctx: ToolExecutionContext) => Promise<any>> = {
  // ---- 读 ----
  'inbox.list': async () => {
    // 注意：processed 为布尔值，IndexedDB 不索引布尔键，必须用 filter 扫描
    return await db.inbox.filter(i => !i.processed).limit(30).toArray()
  },
  'knowledge.search': async (args) => {
    const q = String(args.query ?? '').toLowerCase().trim()
    if (!q) return []
    // 分词检索：英文整词 + 中文字符，任一命中即入选，按命中数排序（有界）
    const tokens = new Set<string>()
    for (const w of q.match(/[a-z0-9]+/g) ?? []) if (w.length >= 2) tokens.add(w)
    for (const c of q.match(/[\u4e00-\u9fff]/g) ?? []) tokens.add(c)
    if (tokens.size === 0) return []

    const all = await db.knowledge.toArray()
    const scored = all.map(k => {
      const hay = `${k.title}\n${k.content || ''}\n${k.tags.join(',')}`.toLowerCase()
      let hits = 0
      for (const t of tokens) if (hay.includes(t)) hits++
      return { k, hits }
    })
    return scored.filter(s => s.hits > 0)
      .sort((a, b) => b.hits - a.hits)
      .slice(0, 10)
      .map(s => s.k)
  },
  'knowledge.get': async (args) => {
    const k = await db.knowledge.get(args.id)
    if (!k) return null
    return { ...k, backlinks: await getBacklinks(args.id) }
  },
  'knowledge.list_all': async () => {
    // 有界读取：最多 50 条（设计原则：AI 经工具访问数据，不直连数据库）
    return (await db.knowledge.toArray()).slice(0, 50)
  },
  'project.get': async (args) => getObject('project', args.id),
  'project.tasks': async (args) => getTasksForProject(args.id),
  'task.list_open': async () => {
    try {
      return await db.tasks.where('status').anyOf(['todo', 'in_progress']).limit(50).toArray()
    } catch {
      return (await db.tasks.toArray()).filter(t => t.status === 'todo' || t.status === 'in_progress').slice(0, 50)
    }
  },
  'task.list_done': async (args) => {
    try {
      const rows = await db.tasks.where('status').equals('done').limit(50).toArray()
      return rows
        .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
        .slice(0, args?.limit ?? 20)
    } catch {
      return []
    }
  },
  'event.recent': async (args) => getAllEvents(args.limit ?? 20),
  'dailyLog.latest': async (args) => {
    try {
      return await db.dailyLogs.orderBy('date').reverse().limit(args.limit ?? 7).toArray()
    } catch {
      return []
    }
  },
  'question.list_open': async () => {
    try {
      return await db.questions.where('status').equals('open').limit(20).toArray()
    } catch {
      return []
    }
  },
  // ---- Hermes 集成（经 Integration Layer，只读分析类）----
  'hermes.find_unreplied': async (args) => {
    const { callIntegrationTool } = await import('./integrations/adapters')
    const r = await callIntegrationTool('hermes', 'hermes.find_unreplied', args)
    if (r.ok === false) throw new Error(r.error)
    return r.data
  },
  'hermes.draft_email': async (args) => {
    const { callIntegrationTool } = await import('./integrations/adapters')
    const r = await callIntegrationTool('hermes', 'hermes.draft_email', args)
    if (r.ok === false) throw new Error(r.error)
    return r.data
  },

  // ---- L1 写 ----
  'inbox.annotate': async (args) => {
    const item = await db.inbox.get(args.id)
    if (!item) return { ok: false, error: 'inbox item not found' }
    await db.inbox.put({
      ...item,
      suggestedType: args.suggestedType ?? item.suggestedType,
      confidence: typeof args.confidence === 'number' ? args.confidence : item.confidence,
      metadata: { ...(item.metadata ?? {}), aiCategory: args.category, aiTags: args.aiTags ?? [], annotatedBy: args.annotatedBy ?? 'agent' },
    })
    // 设计原则：写入必须落 Event 审计
    const { createEvent } = await import('../repositories/eventRepository')
    await createEvent('object.updated', 'agent', 'knowledge', args.id, {
      kind: 'inbox_annotated', category: args.category, aiTags: args.aiTags ?? [],
    })
    return { ok: true }
  },
  'relation.create': async (args, tctx) => {
    // AI 建议关系：来源标记 ai，置信度封顶
    const confidence = Math.min(args.confidence ?? MEMORY_AI_CONFIDENCE_CAP, MEMORY_AI_CONFIDENCE_CAP)
    const result: Result<unknown> = await createRelation(
      args.sourceType, args.sourceId, args.targetType, args.targetId,
      args.relationType ?? 'related_to',
      { createdBy: 'agent', source: 'ai', confidence, metadata: { runId: tctx.runId, reason: args.reason } }
    )
    if (result.ok === false) return { ok: false, error: result.error }
    return { ok: true, id: (result.value as { id: string }).id }
  },

  // ---- L2 写（仅审批通过后执行）----
  'knowledge.create': async (args) => {
    const r = await createKnowledge({
      title: args.title,
      content: args.content ?? '',
      category: args.category,
      tags: args.tags,
      description: args.description,
    })
    if (r.ok === false) return { ok: false, error: r.error }
    return r.value
  },
  'task.create': async (args) => {
    const r = await createTask({ title: args.title, dueDate: args.dueDate, priority: args.priority })
    if (r.ok === false) return { ok: false, error: r.error }
    return r.value
  },
  'project.create': async (args) => {
    const r = await createProject({ title: args.title, description: args.description })
    if (r.ok === false) return { ok: false, error: r.error }
    return r.value
  },
  'review.create': async (args) => {
    const r = await createObject('review', {
      title: args.title ?? `复盘 ${args.period}`,
      reviewType: args.reviewType ?? 'daily',
      period: args.period,
      whatWentWell: args.whatWentWell ?? '',
      whatToImprove: args.whatToImprove ?? '',
      keyTakeaways: args.keyTakeaways ?? '',
      mood: args.mood ?? '',
      energy: args.energy ?? 3,
      completedTasks: args.completedTasks ?? [],
      nextDayPlan: args.nextDayPlan ?? '',
    })
    if (r.ok === false) return { ok: false, error: r.error }
    return r.value
  },
  'research.create': async (args) => {
    const r = await createObject('research', {
      title: args.title,
      status: 'planned',
      findings: args.findings ?? '',
      conclusion: args.conclusion,
    })
    if (r.ok === false) return { ok: false, error: r.error }
    return r.value
  },
  'task.status': async (args) => {
    const task = await db.tasks.get(args.id)
    if (!task) return { ok: false, error: '任务不存在' }
    const VALID: Task['status'][] = ['todo', 'in_progress', 'done', 'cancelled']
    if (!VALID.includes(args.status)) return { ok: false, error: `非法状态: ${args.status}` }
    // 直写也必须维护 LWW 时钟并落审计事件（与 repository 写路径一致）
    await db.tasks.update(args.id, { status: args.status, updatedAt: now() })
    await createEvent('object.updated', 'agent', 'task', args.id, {
      via: 'tool:task.status', changedFields: ['status'],
    })
    return { ok: true }
  },

  // ---- L3（人工批准后仍需显式 execute；外部动作经 Integration Layer）----
  'external.request': async (args) => {
    // Hermes 发送：走 CommandBus（Mock 外呼 + 出站沟通审计）
    if (args?.tool === 'hermes.send_email') {
      const { commandBus } = await import('./integrations/commandBus')
      return commandBus.execute('hermes', 'email.send', args)
    }
    // 其他外部调用：安全桩，真实 Provider 接入后替换
    return { ok: true, stub: true, endpoint: args?.endpoint ?? null, note: 'external stub executed after human approval' }
  },
  'data.delete': async (args) => {
    if (args.confirm !== true) return { ok: false, error: 'data.delete requires confirm:true in payload' }
    const r = await deleteObjectSafe(args.type, args.id)
    return r
  },
}

async function deleteObjectSafe(type: string, id: string) {
  const obj = await getObject(type as never, id)
  if (!obj) return { ok: false, error: 'object not found' }
  await db.table(objTableName(type)).delete(id)
  return { ok: true, deleted: id }
}

const OBJECT_TABLES: Record<string, string> = {
  goal: 'goals', project: 'projects', task: 'tasks', knowledge: 'knowledge',
  inspiration: 'inspirations', question: 'questions', research: 'research',
  experiment: 'experiments', decision: 'decisions', review: 'reviews', process: 'processes',
}

/** 严格白名单：未知/系统表名一律拒绝，防止 payload.type 触达审计等系统表 */
function objTableName(type: string): string {
  const t = OBJECT_TABLES[type]
  if (!t) throw new Error(`不允许操作的对象类型: ${type}`)
  return t
}
