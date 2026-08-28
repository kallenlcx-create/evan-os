// ====== ContextEngine — AI 上下文引擎 ======
// 职责：收集 → 过滤 → 排序 → 压缩 → 组装
// 禁止：调用任何 AI Provider / 模型；隐式注入全部数据库
// 输出 AIContext 是纯数据（可 JSON 序列化），由上层 Provider 自行消费
//
// 解耦约定：
//   ContextEngine  ← 只依赖本地存储与 v0.4 MemoryService
//   AIProvider     ← 只消费 AIContext（未来实现，本文件不出现）

import type {
  AIContext, ContextItem, ContextItemType, ObjectType,
} from '../types'
import { db } from '../db'
import { memoryService } from './memoryService'
import { relationQueryService } from './relationQueryService'
import { getAllEvents } from '../repositories/eventRepository'

// ====== 输入定义 ======

export interface ContextEngineInput {
  user?: { id: string; name?: string }
  page?: { path: string; label: string }
  currentObject?: { type: ObjectType; id: string }
  currentProjectId?: string
  currentTaskId?: string
  /** 相关性查询词（如当前正在编辑的内容/问题），用于 relevance 计算 */
  query?: string
  /** 可选：外部直接提供数据（跳过内部收集） */
  recentEventsLimit?: number
  includeMemories?: boolean
  includeGoals?: boolean
  includeStudy?: boolean // v1.1：是否纳入学习日志/资源（真串联）
  tokenBudget?: number
  /** v1.0：构建后把快照持久化到 contexts 表（可追溯） */
  persist?: boolean
}

// ====== 配置 ======

const DEFAULT_TOKEN_BUDGET = 2000

const TYPE_PRIORITY: Record<ContextItemType, number> = {
  object: 95, task: 90, project: 85, memory: 70, goal: 60,
  related_object: 50, knowledge: 45, study_log: 42, study_resource: 40, event: 30, page: 20, user: 10,
}

const CATEGORY_CAPS: Partial<Record<ContextItemType, number>> = {
  related_object: 6, knowledge: 3, memory: 5, goal: 5, event: 5,
  study_log: 4, study_resource: 3,
}

const COMPRESS_MAX_CHARS = 160

// ====== Token 估算（启发式：CJK≈1 token/字，其他 ≈4 字符/token）======

export function estimateTokens(text: string): number {
  if (!text) return 0
  const cjk = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length
  const rest = text.length - cjk
  return Math.max(1, Math.ceil(cjk + rest / 4))
}

/** 压缩文本：去多余空白并截断 */
export function compressText(text: string, maxChars = COMPRESS_MAX_CHARS): string {
  const clean = (text || '').replace(/\s+/g, ' ').trim()
  return clean.length > maxChars ? clean.slice(0, maxChars) + '…' : clean
}

/** 关键词相关度：query 与文本的重叠（确定性）*/
function relevanceOf(text: string, query?: string): number {
  if (!query || !query.trim()) return 0.5
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  if (t.includes(q)) return 1
  const qChars = Array.from(q).filter(c => /\S/.test(c))
  if (qChars.length === 0) return 0.5
  let hit = 0
  for (const c of new Set(qChars)) if (t.includes(c)) hit++
  return Math.min(1, 0.2 + (hit / new Set(qChars).size) * 0.8)
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}

const typeLabels: Record<string, string> = {
  goal: '目标', project: '项目', task: '任务', customer: '客户',
  opportunity: '商机', order: '订单', communication: '沟通',
  knowledge: '知识', inspiration: '灵感', question: '问题',
  research: '研究', experiment: '实验', decision: '决策',
  review: '复盘', process: '流程',
}

// ====== 内部收集结果 ======

interface RawEntry {
  type: ContextItemType
  title: string
  content: string
  source: string
  ref?: { type: string; id: string }
  relevanceHint?: number   // 收集阶段已知的相关度提示（如 memory 的置信度）
}

async function getObjectAny(type: ObjectType, id: string): Promise<Record<string, any> | undefined> {
  const map: Partial<Record<ObjectType, string>> = {
    goal: 'goals', project: 'projects', task: 'tasks', customer: 'customers',
    opportunity: 'opportunities', order: 'orders', communication: 'communications',
    knowledge: 'knowledge', inspiration: 'inspirations', question: 'questions',
    research: 'research', experiment: 'experiments', decision: 'decisions',
    review: 'reviews', process: 'processes',
  }
  const table = map[type]
  if (!table) return undefined
  try {
    return await (db as any)[table].get(id)
  } catch {
    return undefined
  }
}

// ====== ContextEngine ======

export class ContextEngine {
  /**
   * 构建AIContext。
   * 五个阶段全部在本方法内完成；不发起任何网络/模型请求。
   * 所有数据库访问均为定向查询（where/get/limit），禁止全表注入。
   */
  async build(input: ContextEngineInput): Promise<AIContext> {
    // ========== 1. 收集 Collect ==========
    const raw: RawEntry[] = []
    const focusType = input.currentObject?.type
    const focusId = input.currentObject?.id
    const query = input.query?.trim() ||
      input.page?.label || ''

    // 1a. 用户 & 页面（身份上下文）
    raw.push({
      type: 'user',
      title: `用户 ${input.user?.name ?? 'Evan'}`,
      content: `当前用户：${input.user?.name ?? 'Evan'}（${input.user?.id ?? 'local-user'}）`,
      source: 'local-profile',
      relevanceHint: 1,
    })
    if (input.page) {
      raw.push({
        type: 'page',
        title: input.page.label,
        content: `用户正在浏览页面：${input.page.label} (${input.page.path})`,
        source: 'navigation',
        relevanceHint: 1,
      })
    }

    // 1b. 焦点对象 / 当前任务 / 当前项目
    let projectFromRelation: string | undefined
    let focusTitle = ''
    if (focusType && focusId) {
      const obj = await getObjectAny(focusType, focusId)
      if (obj) {
        focusTitle = obj.title ?? ''
        raw.push({
          type: 'object',
          title: obj.title ?? '(无标题)',
          content: compressText(
            `[${typeLabels[focusType] ?? focusType}] ${obj.title ?? ''}` +
            (obj.description ? ` — ${obj.description}` : '')),
          source: `db:${focusType}`,
          ref: { type: focusType, id: focusId },
          relevanceHint: 1,
        })

        // 1c. 关联对象 + 关联知识（来自 Relation 表，N=1 邻域）
        try {
          const hood = await relationQueryService.getNeighborhood(focusType, focusId, 1)
          for (const node of hood.nodes) {
            const isFocus = node.id === focusId && node.type === focusType
            if (isFocus) continue
            raw.push({
              type: 'related_object',
              title: node.title,
              content: compressText(`[${typeLabels[node.type] ?? node.type}] ${node.title}（与「${obj.title}」关联）`),
              source: 'relationQueryService',
              ref: { type: node.type, id: node.id },
            })
            if (node.type === 'knowledge') {
              const k = await db.knowledge.get(node.id)
              if (k) {
                raw.push({
                  type: 'knowledge',
                  title: k.title,
                  content: compressText(`[知识] ${k.title}: ${(k as any).content || (k as any).description || ''}`),
                  source: 'db:knowledge',
                  ref: { type: 'knowledge', id: node.id },
                })
              }
            }
          }
        } catch { /* 图谱服务不可用时跳过关联 */ }
      }
    }

    // 当前任务
    if (input.currentTaskId) {
      const task = await getObjectAny('task', input.currentTaskId)
      if (task) {
        raw.push({
          type: 'task',
          title: task.title,
          content: compressText(
            `[任务] ${task.title} · 状态 ${task.status}` +
            (task.dueDate ? ` · 截止 ${String(task.dueDate).slice(0, 10)}` : '') +
            (task.priority ? ` · 优先级 ${task.priority}` : '')),
          source: 'db:tasks',
          ref: { type: 'task', id: input.currentTaskId },
          relevanceHint: 1,
        })
        // 从 belongs_to 关系推导所属项目
        try {
          const rels = await db.relations
            .where('[sourceType+sourceId]').equals(['task', input.currentTaskId])
            .and(r => r.relationType === 'belongs_to')
            .toArray()
          if (rels.length > 0) projectFromRelation = rels[0].targetId
        } catch { /* ignore */ }
      }
    }

    // 当前项目（显式指定 或 从任务关系推导）
    const projectId = input.currentProjectId ?? projectFromRelation
    if (projectId) {
      const proj = await getObjectAny('project', projectId)
      if (proj) {
        raw.push({
          type: 'project',
          title: proj.title,
          content: compressText(
            `[项目] ${proj.title} · 进度 ${proj.progress ?? 0}%` +
            (proj.status ? ` · ${proj.status}` : '')),
          source: 'db:projects',
          ref: { type: 'project', id: projectId },
          relevanceHint: 1,
        })
      }
    }

    // 1d. 记忆（只取 active，由 MemoryService 保证）
    if (input.includeMemories !== false) {
      const memories = await memoryService.getRelevantMemories({
        query: query || focusTitle || undefined,
        limit: CATEGORY_CAPS.memory,
      })
      for (const m of memories) {
        raw.push({
          type: 'memory',
          title: m.summary || m.content.slice(0, 30),
          content: compressText(`[记忆·${m.type}] ${m.content}`),
          source: 'memoryService',
          ref: { type: 'memory', id: m.id },
          relevanceHint: clamp01(m.confidence * 0.5 + m.importance * 0.3 + 0.2),
        })
      }
    }

    // 1e. 目标（定向查询：未完成的目标，限 5 条）
    if (input.includeGoals !== false) {
      try {
        const goals = (await db.goals.toArray())
          .filter(g => (g.progress ?? 100) < 100 && !g.archived)
          .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
          .slice(0, CATEGORY_CAPS.goal)
        for (const g of goals) {
          raw.push({
            type: 'goal',
            title: g.title,
            content: compressText(`[目标·${g.level}] ${g.title} · 进度 ${g.progress ?? 0}%`),
            source: 'db:goals',
            ref: { type: 'goal', id: g.id },
          })
        }
      } catch { /* ignore */ }
    }

    // 1g. 学习日志/资源（真串联：近7天，按相关度+时间）
    if (input.includeStudy !== false) {
      try {
        const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
        const cols = await db.collections.where('kind').anyOf(['study_log', 'study_resource']).toArray()
        const logs = cols.filter(c => c.kind === 'study_log').sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0, CATEGORY_CAPS.study_log)
        for (const c of logs) {
          const d: any = c.data ?? {}
          // 近期优先，过期7天以上 relevance 稍降
          const isRecent = (d.date ?? c.createdAt ?? '').slice(0, 10) >= cutoff
          raw.push({
            type: 'study_log',
            title: `${d.subject ?? '学习'} ${d.duration ?? ''}min`,
            content: compressText(`[学习日志·${d.date ?? c.createdAt.slice(0, 10)}] ${d.subject ?? ''} ${d.duration ? `· ${d.duration}分钟` : ''} ${d.notes ?? ''}`),
            source: 'db:collections:study_log',
            ref: { type: 'study_log', id: c.id },
            relevanceHint: isRecent ? 0.9 : 0.4,
          })
        }
        const ress = cols.filter(c => c.kind === 'study_resource').slice(0, CATEGORY_CAPS.study_resource)
        for (const c of ress) {
          const d: any = c.data ?? {}
          raw.push({
            type: 'study_resource',
            title: d.title ?? '资源',
            content: compressText(`[学习资源·${d.category ?? ''}] ${d.title ?? ''} ${d.url ?? ''}`),
            source: 'db:collections:study_resource',
            ref: { type: 'study_resource', id: c.id },
          })
        }
      } catch { /* 学习数据缺失时跳过 */ }
    }

    // 1f. 最近事件（审计流尾部，非全量）
    try {
      const events = await getAllEvents(input.recentEventsLimit ?? CATEGORY_CAPS.event)
      for (const e of events) {
        const payload = e.payload ?? {}
        raw.push({
          type: 'event',
          title: e.type,
          content: compressText(`${e.type} · ${typeLabels[e.objectType] ?? e.objectType}${payload.title ? ` "${payload.title}"` : ''}`),
          source: 'eventRepository',
          ref: { type: e.objectType, id: e.objectId },
        })
      }
    } catch { /* ignore */ }

    // ========== 2. 过滤 Filter ==========
    // 去重（同类型+同 ref 只保留一条；不同类型视角允许共存，如 related_object 与 knowledge）
    const seenRefs = new Set<string>()
    const perTypeCount = new Map<ContextItemType, number>()
    const filtered: RawEntry[] = []
    let excludedByFilter = 0

    for (const entry of raw) {
      const refKey = entry.ref
        ? `${entry.type}:${entry.ref.type}:${entry.ref.id}`
        : `${entry.type}:${entry.title}`
      if (seenRefs.has(refKey)) { excludedByFilter++; continue }
      const cap = CATEGORY_CAPS[entry.type]
      if (cap && (perTypeCount.get(entry.type) ?? 0) >= cap &&
          !['user', 'page', 'object', 'task', 'project'].includes(entry.type)) {
        excludedByFilter++
        continue
      }
      seenRefs.add(refKey)
      perTypeCount.set(entry.type, (perTypeCount.get(entry.type) ?? 0) + 1)
      filtered.push(entry)
    }

    // ========== 3+4. 排序评分 & 压缩 ==========
    const items: ContextItem[] = filtered.map((entry, i) => {
      const basePriority = TYPE_PRIORITY[entry.type]
      const relevance = entry.relevanceHint !== undefined
        ? entry.relevanceHint
        : relevanceOf(`${entry.title} ${entry.content}`, query || focusTitle)
      const priority = Math.round(clamp01(basePriority / 100 * 0.7 + relevance * 0.3) * 100)
      return {
        id: `ctx-${entry.type}-${i}`,
        type: entry.type,
        title: entry.title,
        content: entry.content, // 已在收集时压缩
        source: entry.source,
        priority,
        relevance: Number(relevance.toFixed(2)),
        tokenEstimate: estimateTokens(`${entry.title} ${entry.content}`),
        included: false,
        ref: entry.ref,
      }
    }).sort((a, b) =>
      b.priority - a.priority ||
      b.relevance - a.relevance ||
      a.id.localeCompare(b.id))

    // ========== 5. 组装 Assemble（tokenBudget 贪心装入）==========
    const budget = Math.max(1, input.tokenBudget ?? DEFAULT_TOKEN_BUDGET)
    let used = 0
    let excludedByBudget = 0
    for (const item of items) {
      if (used + item.tokenEstimate <= budget) {
        item.included = true
        used += item.tokenEstimate
      } else {
        excludedByBudget++
      }
    }

    const aiContext = {
      id: `aictx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      createdAt: new Date().toISOString(),
      focus: {
        userId: input.user?.id,
        page: input.page,
        objectType: focusType,
        objectId: focusId,
        projectId,
        taskId: input.currentTaskId,
      },
      items,
      tokenBudget: budget,
      tokensUsed: used,
      stats: {
        collected: raw.length,
        included: items.filter(i => i.included).length,
        excludedByFilter,
        excludedByBudget,
      },
    }

    // v1.0：可选持久化快照（contexts 表，保留最近 N 份）
    if (input.persist) {
      try {
        const { saveContextSnapshot } = await import('./systemRegistry')
        await saveContextSnapshot(aiContext as AIContext)
      } catch { /* 持久化失败不影响构建 */ }
    }

    return aiContext
  }

  /**
   * 将 AIContext 渲染为纯文本提示片段（供未来 Provider 使用）。
   * 仍然不涉及任何模型调用——只是字符串组装。
   */
  renderPrompt(ctx: AIContext): string {
    const lines: string[] = []
    for (const item of ctx.items.filter(i => i.included)) {
      lines.push(item.content)
    }
    return lines.join('\n')
  }
}

export const contextEngine = new ContextEngine()
