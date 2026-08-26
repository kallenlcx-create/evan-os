// ====== Evan OS 第一批 4 个 Agent ======
// ① 知识整理助手  Inbox → 分析 → 建议分类 → 建议关系 → 创建知识(L2)
// ② 项目助手      Project → 分析 → 找风险 → 找阻塞 → 建议下一步(L2)
// ③ 复盘助手      Task + Event + DailyLog → Review(L2)
// ④ 研究助手      Problem → Research(L2) → Summary → Knowledge(L2)
//
// 当前分析为确定性启发式（无模型调用）；
// 未来接入 AI Provider 时仅需替换 analysis 部分，权限管线不变。

import type {
  AgentDefinition, AgentId,
} from '../types'
import { agentRuntime, type AgentRunContext } from './agentRuntime'
import { localToday } from '../utils/date'

const todayStr = () => localToday()

// ====== 启发式分类器（知识整理助手用）======

interface InboxClassification {
  suggestedType: 'task' | 'idea' | 'link' | 'quick_note'
  category: string
  tags: string[]
}

const TAG_KEYWORDS: [RegExp, string][] = [
  [/react|前端|hooks?/i, '前端'],
  [/ai|gpt|llm|智能/i, 'AI'],
  [/外贸|客户|询盘|报价/i, '外贸'],
  [/shopify|独立站|seo/i, '独立站'],
  [/邮件|email|打开率/i, '邮件'],
]

function classifyInbox(content: string): InboxClassification {
  const tags: string[] = []
  for (const [re, tag] of TAG_KEYWORDS) {
    if (re.test(content)) tags.push(tag)
    if (tags.length >= 3) break
  }

  if (/https?:\/\//.test(content)) {
    return { suggestedType: 'link', category: '参考资料', tags: [...new Set([...tags, '链接'])] }
  }
  if (/(^做|^完成|^提醒|^联系|^买|任务|todo)/i.test(content.trim())) {
    return { suggestedType: 'task', category: '待办', tags }
  }
  if (/想法|点子|idea|灵感/i.test(content)) {
    return { suggestedType: 'idea', category: '灵感', tags }
  }
  return { suggestedType: 'quick_note', category: '笔记', tags }
}

// ====== ① 知识整理助手 ======

const knowledgeOrganizerDef: AgentDefinition = {
  id: 'knowledge_organizer',
  name: '知识整理助手',
  emoji: '📥',
  role: '收集箱整理员：把随手捕获的内容分类、打标、建立关联，并起草知识条目',
  goal: '让 Inbox 保持清空，让信息流向正确的位置，不遗漏任何有价值的内容',
  instructions: [
    '读取所有未处理的收集项',
    '按内容特征建议类型与标签，并自动标注（L1）',
    '发现同标签但未关联的既有知识时，自动建立 AI 来源的建议关系（L1，置信度封顶）',
    '对有沉淀价值的条目起草知识草稿——必须等用户确认后才真正创建（L2）',
    '绝不删除用户的收集项',
  ],
  contextPolicy: { queryHint: '知识整理', includeMemories: true, includeGoals: false, recentEventsLimit: 5 },
  memoryScope: [],
  tools: ['inbox.list', 'knowledge.list_all', 'knowledge.search', 'context.build', 'memory.read', 'inbox.annotate', 'relation.create', 'knowledge.create'],
  actions: [
    { type: 'inbox_annotate', description: '自动标注收集项的分类与标签' },
    { type: 'relation_suggest', description: '在相关知识点之间建立 AI 建议关系' },
    { type: 'summary_generate', description: '生成整理摘要' },
    { type: 'knowledge_draft', description: '起草知识条目（需确认）' },
  ],
  triggers: [
    { type: 'manual', description: '手动运行' },
    { type: 'on_event', eventType: 'inbox.captured', description: '新内容进入收集箱时自动整理' },
  ],
  approvalPolicy: { autoExecuteBelow: 'L1_auto', requireHumanConfirm: [] },
}

async function knowledgeOrganizerRunner(ctx: AgentRunContext) {
  const items = await ctx.call<Array<{ id: string; content: string; metadata?: any }>>('inbox.list')
  let annotated = 0
  const drafts: string[] = []

  for (const item of items) {
    if ((item.metadata as any)?.annotatedBy) continue // 已处理过则跳过
    const cls = classifyInbox(item.content)
    await ctx.act('inbox_annotate', {
      id: item.id,
      suggestedType: cls.suggestedType === 'task' ? undefined : cls.suggestedType,
      category: cls.category,
      aiTags: cls.tags,
      confidence: 0.4,
      annotatedBy: ctx.agentId,
    }, `标注「${item.content.slice(0, 16)}…」→ ${cls.category}`)

    // 任务类条目交给用户自己处理，不代建
    if (cls.suggestedType !== 'task') {
      const outcome = await ctx.act('knowledge_draft', {
        title: item.content.slice(0, 24),
        content: item.content,
        tags: cls.tags,
        description: `来自收集箱 · ${cls.category}`,
        category: cls.category,
        fromInboxId: item.id,
      }, `起草知识「${item.content.slice(0, 16)}…」`)
      drafts.push(outcome.summary)
    }
    annotated++
  }

  // 同标签未关联的知识 → 自动建议关系（L1）
  // 经工具层有界读取（设计原则：AI 不直连数据库）
  const allK = await ctx.call<Array<{ id: string; tags: string[] }>>('knowledge.list_all')
  const pairsByTag = new Map<string, [string, string]>()
  for (let i = 0; i < allK.length && pairsByTag.size < 3; i++) {
    for (let j = i + 1; j < allK.length; j++) {
      const shared = allK[i].tags.filter(t => allK[j].tags.includes(t))
      if (shared.length > 0) {
        const key = `${allK[i].id}|${allK[j].id}`
        if (!pairsByTag.has(key)) pairsByTag.set(key, [allK[i].id, allK[j].id])
        if (pairsByTag.size >= 3) break
      }
    }
  }
  let relations = 0
  for (const [, [a, b]] of pairsByTag) {
    await ctx.act('relation_suggest', {
      sourceType: 'knowledge', sourceId: a,
      targetType: 'knowledge', targetId: b,
      relationType: 'related_to', reason: '共享标签，自动建议关联',
      confidence: 0.4,
    }, '为共享标签的知识建立关联')
    relations++
  }

  return {
    summary: `整理 ${annotated} 条收集项；起草 ${drafts.length} 个知识草稿（待确认）；建议 ${relations} 条关联关系`,
  }
}

// ====== ② 项目助手 ======

const projectAssistantDef: AgentDefinition = {
  id: 'project_assistant',
  name: '项目助手',
  emoji: '🚀',
  role: '项目分析师：识别项目风险与阻塞，推动项目向前走',
  goal: '让每个项目都有清晰的下一步，风险和阻塞被尽早暴露',
  instructions: [
    '读取目标项目的任务与最近事件',
    '识别逾期、阻塞、停滞三类风险（L1 分析）',
    '生成项目健康摘要（L1）',
    '给出下一步行动建议并起草任务——用户确认后才会创建（L2）',
    '不擅自修改任务状态',
  ],
  contextPolicy: { includeMemories: true, includeGoals: true, recentEventsLimit: 10 },
  memoryScope: [],
  tools: ['project.get', 'project.tasks', 'task.list_open', 'event.recent', 'context.build', 'memory.read', 'task.create'],
  actions: [
    { type: 'summary_generate', description: '生成项目健康报告' },
    { type: 'task_draft', description: '起草下一步任务（需确认）' },
    { type: 'external_call', description: 'L3 外呼（如 Hermes 客户邮件发送，需人工批准并显式执行）' },
  ],
  triggers: [{ type: 'manual', description: '手动运行（选择项目）' }],
  approvalPolicy: { autoExecuteBelow: 'L1_auto', requireHumanConfirm: [] },
}

async function projectAssistantRunner(ctx: AgentRunContext) {
  const projectId = ctx.input.projectId as string | undefined
  if (!projectId) throw new Error('project_assistant 需要 input.projectId')

  const project = await ctx.call<{ id: string; title?: string }>('project.get', { id: projectId })
  if (!project || !('title' in project)) throw new Error(`项目不存在: ${projectId}`)

  const taskRelations = await ctx.call<Array<{ sourceId: string }>>('project.tasks', { id: projectId })
  const openTasks = await ctx.call<Array<{ id: string; title: string; status: string; dueDate?: string; updatedAt: string }>>('task.list_open')
  const relatedOpen = taskRelations.length > 0
    ? openTasks.filter(t => taskRelations.some(r => r.sourceId === t.id))
    : openTasks.slice(0, 10)

  const today = todayStr()
  const overdue = relatedOpen.filter(t => t.dueDate && String(t.dueDate).slice(0, 10) < today)
  const blocked = relatedOpen.filter(t => t.status === 'blocked' || t.status === 'waiting')
  const weekAgo = Date.now() - 7 * 86400000
  const stale = relatedOpen.filter(t =>
    t.status === 'in_progress' && new Date(t.updatedAt).getTime() < weekAgo)

  const risks: string[] = []
  if (overdue.length > 0) risks.push(`${overdue.length} 个逾期任务`)
  if (stale.length > 0) risks.push(`${stale.length} 个任务超过 7 天未更新`)
  if (relatedOpen.length === 0) risks.push('项目下没有进行中的任务')

  // Memory 注入（演示 Context/Memory 要素）
  const mems = await ctx.readMemories(project.title ?? '项目')

  await ctx.act('summary_generate', {}, '')
  const report =
    `项目「${project.title}」健康报告：` +
    `开放任务 ${relatedOpen.length}；` +
    (risks.length ? `风险：${risks.join('、')}。` : '暂无明显风险。') +
    (blocked.length ? `阻塞/等待中 ${blocked.length} 项（${blocked.map(b => b.title).join('、')}）。` : '') +
    (mems.length ? `已参考 ${mems.length} 条生效中的记忆。` : '')

  // 下一步建议（L2）
  if (overdue.length > 0) {
    await ctx.act('task_draft', {
      title: `处理逾期：${overdue[0].title}`,
      priority: 'high',
    }, `建议优先处理逾期任务「${overdue[0].title}」`)
  } else if (blocked.length > 0) {
    await ctx.act('task_draft', {
      title: `解除阻塞：${blocked[0].title}`,
      priority: 'high',
    }, `建议解除阻塞「${blocked[0].title}」`)
  } else if (relatedOpen.length === 0) {
    await ctx.act('task_draft', {
      title: `规划「${project.title}」下一批任务`,
    }, '项目空闲，建议规划下一批任务')
  }

  return { summary: report }
}

// ====== ③ 复盘助手 ======

const reviewAssistantDef: AgentDefinition = {
  id: 'review_assistant',
  name: '复盘助手',
  emoji: '🔄',
  role: '复盘撰写员：汇总当日完成的任务、事件流与日志，起草每日复盘',
  goal: '让每天都被记录和反思，复盘不再依赖意志力',
  instructions: [
    '读取今日完成任务、最近事件、最新日志（L1）',
    '生成结构化复盘摘要（L1）',
    '起草复盘记录——用户确认后写入（L2）',
    '只陈述事实和数据，不过度评价',
  ],
  contextPolicy: { queryHint: '今日复盘', includeMemories: false, includeGoals: false, recentEventsLimit: 15 },
  memoryScope: [],
  tools: ['task.list_done', 'event.recent', 'dailyLog.latest', 'context.build', 'review.create'],
  actions: [
    { type: 'summary_generate', description: '生成今日摘要' },
    { type: 'review_draft', description: '起草复盘记录（需确认）' },
  ],
  triggers: [{ type: 'manual', description: '手动运行' }],
  approvalPolicy: { autoExecuteBelow: 'L1_auto', requireHumanConfirm: [] },
}

async function reviewAssistantRunner(ctx: AgentRunContext) {
  const period = (ctx.input.period as string) ?? todayStr()
  const done = await ctx.call<Array<{ id: string; title: string; updatedAt: string }>>('task.list_done', { limit: 20 })
  const doneToday = done.filter(t => String(t.updatedAt).startsWith(period))
  const events = await ctx.call<Array<{ type: string; createdAt: string; payload?: any }>>('event.recent', { limit: 30 })
  const todayEvents = events.filter(e => String(e.createdAt).startsWith(period))
  const logs = await ctx.call<Array<{ date: string; mood: string; energy: number; highlights: string[] }>>('dailyLog.latest', { limit: 1 })
  const latestLog = logs[0]

  const whatWentWell = doneToday.length > 0
    ? `完成 ${doneToday.length} 项：${doneToday.map(t => t.title).join('、')}`
    : '今天暂无完成的任务'
  const keyTakeaways =
    `完成任务 ${doneToday.length} 项；产生事件 ${todayEvents.length} 条` +
    (latestLog ? `；日志情绪 ${latestLog.mood} / 精力 ${latestLog.energy}/5` : '')

  await ctx.act('summary_generate', {}, keyTakeaways)
  await ctx.act('review_draft', {
    reviewType: 'daily',
    period,
    title: `每日复盘 ${period}`,
    whatWentWell,
    whatToImprove: doneToday.length === 0 ? '尝试把大任务拆小，先完成一件最小的事' : '',
    keyTakeaways,
    mood: latestLog?.mood ?? '',
    energy: latestLog?.energy ?? 3,
    completedTasks: doneToday.map(t => t.title),
    nextDayPlan: '',
  }, `起草 ${period} 复盘`)

  return { summary: `${period} 摘要：${keyTakeaways}` }
}

// ====== ④ 研究助手 ======

const researchAssistantDef: AgentDefinition = {
  id: 'research_assistant',
  name: '研究助手',
  emoji: '🔬',
  role: '问题研究员：把开放问题转化为研究计划，汇聚证据形成摘要',
  goal: '不让任何一个问题悬而未决，用研究推动问题走向答案',
  instructions: [
    '读取开放的问题，选定研究目标（L1）',
    '检索知识库中与问题相关的既有知识作为证据（L1）',
    '起草研究条目（L2，需确认）',
    '基于证据起草研究摘要知识条目（L2，需确认）',
    '不虚构证据，只引用检索到的内容',
  ],
  contextPolicy: { queryHint: '问题研究', includeMemories: true, includeGoals: false, recentEventsLimit: 5 },
  memoryScope: [],
  tools: ['question.list_open', 'knowledge.search', 'context.build', 'memory.read', 'research.create', 'knowledge.create'],
  actions: [
    { type: 'summary_generate', description: '生成研究简报' },
    { type: 'research_draft', description: '起草研究条目（需确认）' },
    { type: 'knowledge_draft', description: '起草研究摘要知识（需确认）' },
  ],
  triggers: [{ type: 'manual', description: '手动运行（可选指定问题）' }],
  approvalPolicy: { autoExecuteBelow: 'L1_auto', requireHumanConfirm: [] },
}

async function researchAssistantRunner(ctx: AgentRunContext) {
  const questions = await ctx.call<Array<{ id: string; title: string; status: string }>>('question.list_open')
  const target = (ctx.input.questionId as string)
    ? questions.find(q => q.id === ctx.input.questionId)
    : questions[0]
  if (!target) throw new Error('没有开放的问题可研究')

  const evidence = await ctx.call<Array<{ id: string; title: string; content?: string }>>(
    'knowledge.search', { query: target.title })
  const bullets = evidence.map(k => `• ${k.title}${k.content ? `：${String(k.content).slice(0, 60)}` : ''}`)

  await ctx.act('summary_generate', {}, '')
  const brief = `针对「${target.title}」找到 ${evidence.length} 条相关证据`
  await ctx.act('research_draft', {
    title: `研究：${target.title}`,
    findings: bullets.join('\n') || '暂无直接证据，需要先收集资料',
  }, brief)
  await ctx.act('knowledge_draft', {
    title: `研究摘要：${target.title}`,
    content: `${brief}\n${bullets.join('\n')}`,
    tags: ['研究摘要'],
    category: 'research',
    objectRefQuestion: target.id,
  }, brief)

  return { summary: `${brief}${evidence.length ? '，证据已列出' : '，注意当前知识库证据不足'}` }
}

// ====== 注册 ======

let registered = false

export function registerAgents(): void {
  if (registered) return
  agentRuntime.register(knowledgeOrganizerDef, knowledgeOrganizerRunner)
  agentRuntime.register(projectAssistantDef, projectAssistantRunner)
  agentRuntime.register(reviewAssistantDef, reviewAssistantRunner)
  agentRuntime.register(researchAssistantDef, researchAssistantRunner)
  registered = true
}

registerAgents()

export const AGENT_IDS: AgentId[] = [
  'knowledge_organizer', 'project_assistant', 'review_assistant', 'research_assistant',
]
