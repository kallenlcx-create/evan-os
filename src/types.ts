// ====== 统一数据对象 ======

export type ObjectType =
  | 'goal'       // 目标
  | 'domain'     // 领域
  | 'project'    // 项目
  | 'task'       // 任务
  | 'customer'   // 客户
  | 'opportunity'// 商机
  | 'order'      // 订单
  | 'communication' // 沟通记录
  | 'knowledge'  // 知识
  | 'inspiration'// 想法（兼容旧名，= Idea）
  | 'question'   // 问题（兼容旧名，= Problem）
  | 'research'   // 研究
  | 'experiment' // 实验
  | 'decision'   // 决策
  | 'review'     // 复盘
  | 'process'    // 标准流程（兼容旧名，= SOP）
  | 'agent'      // AI智能体

export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'cancelled'
export type ProjectStatus = 'idea' | 'someday' | 'planning' | 'in_progress' | 'waiting' | 'blocked' | 'done' | 'archived'
export type Priority = 'urgent' | 'high' | 'medium' | 'low'

// ====== 独立 Relation 类型（Source of Truth）======
export type RelationType =
  | 'supports'
  | 'belongs_to'
  | 'contains'
  | 'depends_on'
  | 'blocked_by'
  | 'related_to'
  | 'derived_from'
  | 'created_from'
  | 'caused_by'
  | 'references'
  | 'answers'
  | 'solves'
  | 'tested_by'
  | 'produces'
  | 'influences'
  | 'follows'
  | 'duplicates'
  | 'replaces'

export interface RelationRecord {
  id: string
  sourceType: ObjectType
  sourceId: string
  targetType: ObjectType
  targetId: string
  relationType: RelationType
  metadata?: Record<string, any>
  createdAt: string
  updatedAt: string
  createdBy: 'user' | 'system' | 'agent'
  source: 'manual' | 'migration' | 'ai' | 'automation'
  confidence?: number
}

// ====== Event 类型 ======
export type EventType =
  | 'object.created'
  | 'object.updated'
  | 'object.deleted'
  | 'object.archived'
  | 'object.restored'
  | 'relation.created'
  | 'relation.deleted'
  | 'task.completed'
  | 'project.started'
  | 'project.completed'
  | 'decision.created'
  | 'experiment.created'
  | 'experiment.completed'
  | 'review.created'
  | 'inbox.captured'
  | 'inbox.processed'
  | 'agent.started'
  | 'agent.completed'
  | 'agent.failed'

export interface EventRecord {
  id: string
  type: EventType
  actorType: 'user' | 'system' | 'agent'
  actorId?: string
  objectType: ObjectType
  objectId: string
  payload: Record<string, any>
  createdAt: string
  correlationId?: string
  causationId?: string
}

// ====== BaseObject ======
export interface BaseObject {
  id: string
  type: ObjectType
  title: string
  description: string
  emoji: string
  tags: string[]
  createdAt: string
  updatedAt: string
  relations: Relation[]   // legacy 字段 — 不再是 Source of Truth
  parentId?: string
  archived?: boolean      // 归档标记
}

// legacy inline relation（兼容旧数据）
export interface Relation {
  targetId: string
  targetType: ObjectType
  label: string
}

// ====== 目标 ======
export interface Goal extends BaseObject {
  type: 'goal'
  level: 'vision' | 'three_year' | 'one_year' | '90_day' | 'current'
  progress: number // 0-100
  keyResults: KeyResult[]
  deadline?: string
  parentGoalId?: string
}

export interface KeyResult {
  id: string
  title: string
  current: number
  target: number
  unit: string
}

// ====== 领域 ======
export interface Domain extends BaseObject {
  type: 'domain'
  color?: string
}

// ====== 项目 ======
export interface Project extends BaseObject {
  type: 'project'
  status: ProjectStatus
  progress: number
  dueDate?: string
  tasks: string[] // legacy — 新数据通过 Relation 表达
}

// ====== 任务 ======
export interface Task extends BaseObject {
  type: 'task'
  status: TaskStatus
  priority: Priority
  importance: 'high' | 'medium' | 'low'
  dueDate?: string
  dueTime?: string
  isRecurring: boolean
  recurringRule?: string
  estimatedMinutes?: number
  todayOrder: number
}

// ====== 客户 ======
export interface Customer extends BaseObject {
  type: 'customer'
  company?: string
  contactName?: string
  email?: string
  phone?: string
  country?: string
  website?: string
  stage: 'lead' | 'contacted' | 'qualified' | 'proposal' | 'negotiation' | 'won' | 'lost'
  value?: number
  currency?: string
  notes?: string
}

// ====== 商机 ======
export interface Opportunity extends BaseObject {
  type: 'opportunity'
  stage: 'prospecting' | 'qualification' | 'proposal' | 'negotiation' | 'closed_won' | 'closed_lost'
  value?: number
  currency?: string
  expectedCloseDate?: string
  probability?: number // 0-100
  customerId?: string  // legacy — 新数据通过 Relation 表达
}

// ====== 订单 ======
export interface Order extends BaseObject {
  type: 'order'
  orderNumber?: string
  status: 'pending' | 'confirmed' | 'production' | 'shipped' | 'delivered' | 'cancelled' | 'refunded'
  amount?: number
  currency?: string
  orderDate?: string
  deliveryDate?: string
  customerId?: string  // legacy
  opportunityId?: string // legacy
  items?: OrderItem[]
}

export interface OrderItem {
  id: string
  productName: string
  quantity: number
  unitPrice: number
  total: number
}

// ====== 沟通记录 ======
export interface Communication extends BaseObject {
  type: 'communication'
  channel: 'email' | 'phone' | 'wechat' | 'meeting' | 'video_call' | 'other'
  direction: 'inbound' | 'outbound'
  participants?: string[]
  customerId?: string  // legacy
  opportunityId?: string // legacy
  orderId?: string    // legacy
  summary: string
  actionItems?: string[]
  nextSteps?: string
  communicatedAt: string
}

// ====== 番茄钟 ======
export interface PomodoroSession {
  id: string
  taskId?: string
  taskTitle?: string
  startTime: string
  endTime: string
  duration: number
  type: 'focus' | 'break'
  completed: boolean
}

// ====== 知识 ======
export interface Knowledge extends BaseObject {
  type: 'knowledge'
  category: string
  source?: string
  content: string
  isBookmarked: boolean
  format: 'plain' | 'markdown' | 'json'
  /** 知识标记：可标记为灵感/问题/研究/实验/决策（对应顶部 Tab 归类） */
  markType?: 'inspiration' | 'question' | 'research' | 'experiment' | 'decision'
  backlinks: string[] // legacy — 新数据通过 Relation 动态计算
}

// ====== 灵感 / 想法 ======
export interface Inspiration extends BaseObject {
  type: 'inspiration'
  status: 'captured' | 'processing' | 'converted'
}

// ====== 问题 ======
export interface Question extends BaseObject {
  type: 'question'
  status: 'open' | 'researching' | 'resolved'
  answer?: string
}

// ====== 研究 ======
export interface Research extends BaseObject {
  type: 'research'
  status: 'planned' | 'in_progress' | 'completed'
  findings: string
  conclusion?: string
}

// ====== 实验 ======
export interface Experiment extends BaseObject {
  type: 'experiment'
  status: 'planned' | 'running' | 'completed' | 'failed'
  hypothesis: string
  result?: string
}

// ====== 决策 ======
export interface Decision extends BaseObject {
  type: 'decision'
  options: string[]
  chosen: string
  rationale: string
}

// ====== 复盘 ======
export interface Review extends BaseObject {
  type: 'review'
  reviewType: 'daily' | 'weekly' | 'monthly' | 'yearly'
  period: string
  whatWentWell: string
  whatToImprove: string
  keyTakeaways: string
  mood: string
  energy: number
  completedTasks: string[]
  nextDayPlan: string
}

// ====== 流程 / SOP ======
export interface Process extends BaseObject {
  type: 'process'
  steps: ProcessStep[]
  category: string
}

export interface ProcessStep {
  id: string
  order: number
  title: string
  description: string
  checklist: string[]
}

// ====== 习惯 ======
export interface Habit {
  id: string
  title: string
  emoji: string
  frequency: 'daily' | 'weekly' | 'monthly'
  targetDays: number[]
  completedDates: string[]
  streak: number
  createdAt: string
}

// ====== 全局收集 / Inbox ======
export interface InboxItem {
  id: string
  content: string
  type: 'quick_note' | 'task' | 'idea' | 'link'
  capturedAt: string
  processed: boolean
  processedType?: ObjectType
  processedId?: string
  suggestedType?: ObjectType
  suggestedObjectId?: string
  confidence?: number
  source?: string
  metadata?: Record<string, any>
}

// ====== 学习路径 ======
export interface LearningPath {
  id: string
  title: string
  emoji: string
  status: 'not_started' | 'learning' | 'practicing' | 'applying' | 'mastered'
  resources: string[]
  notes: string
  createdAt: string
}

// ====== 通知 ======
export interface Notification {
  id: string
  title: string
  message: string
  type: 'reminder' | 'ai_suggestion' | 'system'
  read: boolean
  createdAt: string
  targetId?: string
}

// ====== AI 智能体配置 ======
export interface AgentConfig {
  id: string
  name: string
  emoji: string
  description: string
  domain: string
  status: 'active' | 'paused' | 'draft'
  triggers: string[]
  createdAt: string
}

// 联合类型
export type AnyObject =
  | Goal | Domain | Project | Task | Customer | Opportunity | Order | Communication
  | Knowledge | Inspiration | Question | Research | Experiment | Decision | Review | Process

// 可搜索对象的形状
export interface SearchableObject {
  id: string
  type: string
  title: string
  description: string
  emoji: string
  tags: string[]
  relations: Relation[]
}

// ====== 每日日志 ======
export interface DailyLog {
  id: string
  date: string
  content: string
  mood: string
  energy: number
  highlights: string[]
  tasks: string[]
  createdAt: string
  updatedAt: string
}

// ====== 标签统计 ======
export interface TagStats {
  tag: string
  count: number
  types: string[]
}
export interface AppState {
  sidebarCollapsed: boolean
  globalSearchOpen: boolean
  quickCaptureOpen: boolean
  mobileNavOpen: boolean
  notificationPanelOpen: boolean
}

/** 统一搜索覆盖的对象种类（核心对象 + v1.1 扩展源） */
export type SearchKind = ObjectType
  | 'memory'
  | 'tradeDeal'
  | 'siteProduct'
  | 'seoKeyword'
  | 'habit'
  | 'dailyLog'
  | 'notification'
  | 'prompt'
  | 'ai_tool'
  | 'study_log'
  | 'study_resource'
  | 'finance'
  | 'wish'
  | 'health'
  | 'life_plan'
  | 'personal_record'

// ====== 通用收藏/清单表（v1.1：替代 localStorage 孤岛）======
// 提示词 · AI 工具 · 学习日志 · 学习资源 · 财务 · 愿望 · 健康 · 生活计划 · 个人记录

export type CollectionKind =
  | 'prompt'
  | 'ai_tool'
  | 'study_log'
  | 'study_resource'
  | 'finance'
  | 'wish'
  | 'health'
  | 'life_plan'
  | 'personal_record'
  | 'tag_l1'
  | 'tag_l2'

export interface CollectionRecord {
  id: string
  kind: CollectionKind
  data: Record<string, any>     // 原始条目形状（页面 UI 无需改动）
  createdAt: string
  updatedAt: string
}

// ====== Memory System（v0.4）======
// Memory ≠ Knowledge：
//   Knowledge = 用户主动保存的信息（知识与思考模块，Source of Truth）
//   Memory    = 对未来 AI 有价值的长期上下文（AI 的记忆，独立生命周期）
// Memory 不是 Knowledge 的镜像或副本，禁止互相同步。

export type MemoryStatus =
  | 'candidate'  // 候选：AI 建议，待用户确认
  | 'active'     // 生效：已确认，可进入 AI 上下文
  | 'expired'    // 已过期：超出有效期，不再进入上下文
  | 'archived'   // 已归档：用户手动归档，保留但不用

export type MemoryType =
  | 'preference'     // 用户偏好（沟通风格、工作习惯）
  | 'fact'           // 关于用户/业务的事实
  | 'goal_context'   // 目标相关背景
  | 'workflow'       // 工作流模式
  | 'correction'     // 纠正记录（用户对 AI 的反馈）
  | 'context'        // 一般背景上下文

export type MemorySourceType =
  | 'ai_suggestion'  // AI 对话中建议
  | 'conversation'   // 从对话提炼
  | 'observation'    // 行为观察推断
  | 'inference'      // 推理得出
  | 'user_manual'    // 用户手动创建

export interface MemorySource {
  type: MemorySourceType
  actorType: 'user' | 'agent'          // 谁产生的来源
  actorId?: string                     // agent 标识（如 'assistant-v1'）
  sessionId?: string                   // 关联会话
  excerpt?: string                     // 原文摘录（溯源证据）
  objectRef?: { type: ObjectType; id: string }  // 关联业务对象（可选）
  occurredAt: string                   // 来源发生时间
}

export interface Memory {
  id: string
  type: MemoryType
  status: MemoryStatus
  content: string                      // 记忆内容（自然语言，面向未来 AI）
  summary?: string
  source: MemorySource                 // 必须有来源（无来源的 Memory 非法）
  confidence: number                   // 0-1；AI 建议强制 ≤ MEMORY_AI_CONFIDENCE_CAP
  importance: number                   // 0-1；影响相关性排序
  tags: string[]                       // 仅用于 Memory 检索，与 Knowledge tags 无关
  scope?: string[]                     // 生效范围（如 ['ai','work']）
  createdAt: string
  updatedAt: string
  confirmedAt?: string                 // 用户确认时间
  expiresAt?: string                   // 过期时间（可选）
  lastUsedAt?: string                  // 最近被 getRelevantMemories 命中
  useCount?: number
}

// ====== Context Engine（v0.5）======
// ContextEngine 只做：收集 / 过滤 / 排序 / 压缩 / 组装
// 不调用任何模型；AIContext 是纯数据，可交给任意 AI Provider

export type ContextItemType =
  | 'user'              // 当前用户
  | 'page'              // 当前页面
  | 'object'            // 焦点对象
  | 'project'           // 当前项目
  | 'task'              // 当前任务
  | 'related_object'    // 关联对象（来自 Relation）
  | 'knowledge'         // 关联知识
  | 'memory'            // 生效中的记忆
  | 'goal'              // 活跃目标
  | 'event'             // 最近事件

export interface ContextItem {
  id: string
  type: ContextItemType
  title: string
  content: string                 // 压缩后的文本片段
  source: string                  // 可追溯来源，如 'memoryService' / 'db:tasks'
  priority: number                // 0-100
  relevance: number               // 0-1 与当前焦点的相关度
  tokenEstimate: number           // 估算 token 数
  included: boolean               // 是否进入最终上下文
  ref?: { type: string; id: string }
}

export interface AIContext {
  id: string
  createdAt: string
  focus: {
    userId?: string
    page?: { path: string; label: string }
    objectType?: ObjectType
    objectId?: string
    projectId?: string
    taskId?: string
  }
  items: ContextItem[]
  tokenBudget: number
  tokensUsed: number
  stats: {
    collected: number
    included: number
    excludedByFilter: number
    excludedByBudget: number
  }
}

// ====== AI Agent Runtime（v0.6）======
// 第一批只做 4 个 Agent；标准十要素结构；三级权限

export type PermissionLevel =
  | 'L1_auto'      // 自动执行（读、分析、摘要、建议关系、整理 Inbox）
  | 'L2_suggest'   // AI 建议，用户确认后才执行（创建对象、修改状态）
  | 'L3_approval'  // 必须人工批准且显式执行（外部 API、邮件、删除重要数据、订单、付款）

export type AgentId =
  | 'knowledge_organizer'  // 知识整理助手
  | 'project_assistant'    // 项目助手
  | 'review_assistant'     // 复盘助手
  | 'research_assistant'   // 研究助手

export type AgentTriggerType = 'manual' | 'on_event' | 'schedule'

export interface AgentTrigger {
  type: AgentTriggerType
  eventType?: EventType     // on_event 时匹配的事件类型
  description: string
}

export type AgentActionType =
  | 'inbox_annotate'     // L1 整理 Inbox（分类标注）
  | 'relation_suggest'   // L1 建立建议关系（AI 来源、置信度封顶）
  | 'summary_generate'   // L1 生成摘要
  | 'knowledge_draft'    // L2 创建知识（建议）
  | 'task_draft'         // L2 建议任务
  | 'project_draft'      // L2 建议项目
  | 'status_change'      // L2 修改状态（建议）
  | 'review_draft'       // L2 创建复盘（建议）
  | 'research_draft'     // L2 创建研究（建议）
  | 'external_call'      // L3 外部 API / 发邮件 / 付款
  | 'destructive'        // L3 删除重要数据

/** Agent 动作 → 权限等级映射（运行时强制执行） */
export const ACTION_PERMISSION: Record<AgentActionType, PermissionLevel> = {
  inbox_annotate: 'L1_auto',
  relation_suggest: 'L1_auto',
  summary_generate: 'L1_auto',
  knowledge_draft: 'L2_suggest',
  task_draft: 'L2_suggest',
  project_draft: 'L2_suggest',
  status_change: 'L2_suggest',
  review_draft: 'L2_suggest',
  research_draft: 'L2_suggest',
  external_call: 'L3_approval',
  destructive: 'L3_approval',
}

/** Agent 标准结构（十要素） */
export interface AgentDefinition {
  id: AgentId
  // 身份
  name: string
  emoji: string
  role: string
  // 目标
  goal: string
  // 指令
  instructions: string[]
  // Context 策略（交给 ContextEngine）
  contextPolicy: {
    queryHint?: string
    includeMemories: boolean
    includeGoals: boolean
    recentEventsLimit: number
  }
  // Memory 使用范围
  memoryScope: string[]
  // Tools（工具名，见 agentTools）
  tools: string[]
  // Permissions（本 agent 会用到的动作及其等级，运行时以 ACTION_PERMISSION 为准）
  actions: { type: AgentActionType; description: string }[]
  // Triggers
  triggers: AgentTrigger[]
  // Approval Policy
  approvalPolicy: {
    autoExecuteBelow: PermissionLevel   // 低于此等级自动执行（含）
    requireHumanConfirm: AgentActionType[] // 额外强制人工确认的动作
  }
}

/** Runner 输入输出 */
export interface AgentRunInput {
  trigger?: AgentTriggerType
  input?: Record<string, any>
}

export interface AgentActionOutcome {
  type: AgentActionType
  level: PermissionLevel
  mode: 'auto_executed' | 'pending_approval'
  summary: string
  approvalId?: string
  result?: Record<string, any>
}

export interface AgentRunRecord {
  id: string
  agentId: AgentId
  trigger: AgentTriggerType
  status: 'running' | 'completed' | 'failed'
  steps: string[]                  // 执行日志
  actions: AgentActionOutcome[]
  summary?: string
  error?: string
  startedAt: string
  finishedAt?: string
}

export interface ApprovalRecord {
  id: string
  runId: string
  agentId?: AgentId
  source: 'agent' | 'workflow'      // v0.7：区分审批来源
  workflowId?: string
  workflowRunId?: string
  stepId?: string
  actionType: AgentActionType | WorkflowActionType
  level: PermissionLevel
  summary: string
  payload: Record<string, any>
  status: 'pending' | 'approved' | 'rejected'
  createdAt: string
  decidedAt?: string
  executedAt?: string
  executionResult?: Record<string, any>
  executionError?: string
}

// ====== Automation Engine（v0.7）======
// 基于 Event / Agent / Context / Relation 的内部自动化引擎
// 不连接 Gmail / Shopify / n8n；外部动作一律 Mock 且强制审批

export type WorkflowStatus = 'draft' | 'active' | 'paused' | 'archived'

export type WorkflowTriggerType = 'event' | 'time' | 'manual'

export interface WorkflowTrigger {
  type: WorkflowTriggerType
  eventType?: EventType            // event 触发：匹配的事件类型
  intervalMinutes?: number         // time 触发：间隔分钟
  atTime?: string                  // time 触发：每日 "HH:mm"
  description?: string
}

/** 条件叶子 */
export interface WorkflowConditionLeaf {
  kind: 'leaf'
  field: string                    // 点路径，如 'event.payload.title'、'input.status'
  operator: 'eq' | 'ne' | 'contains' | 'gt' | 'lt' | 'exists' | 'missing'
  value?: any
}

/** 条件组合：AND / OR / NOT 可嵌套 */
export interface WorkflowConditionGroup {
  kind: 'group'
  op: 'and' | 'or' | 'not'
  children: WorkflowConditionNode[]
}

export type WorkflowConditionNode = WorkflowConditionLeaf | WorkflowConditionGroup

export type WorkflowActionType =
  | 'create_object'       // 创建对象（默认自动，可强制审批）
  | 'update_object'       // 更新对象
  | 'create_relation'     // 创建关系（source='automation'）
  | 'run_agent'           // 运行已有 Agent
  | 'send_notification'   // 发送站内通知（L1）
  | 'external_mock'       // 外部调用 Mock —— 高风险，强制审批
  | 'delete_object'       // 删除对象 —— 高风险，强制审批

/** 动作风险分级（运行时强制）。
 * 工作流定义由用户预先批准，常规动作随运行自动执行；
 * 高风险动作（外部调用/删除）无论配置如何都强制审批。 */
export const WORKFLOW_ACTION_LEVEL: Record<WorkflowActionType, PermissionLevel> = {
  create_object: 'L1_auto',
  update_object: 'L1_auto',
  create_relation: 'L1_auto',
  run_agent: 'L1_auto',
  send_notification: 'L1_auto',
  external_mock: 'L3_approval',
  delete_object: 'L3_approval',
}

export interface WorkflowStep {
  id: string
  name: string
  action: WorkflowActionType
  params: Record<string, any>      // 支持 {{path}} 模板插值
  requireApproval?: boolean        // 手动升级为审批门控
  continueOnError?: boolean        // 失败后继续后续步骤
  retry?: { maxAttempts: number; backoffMs: number }
}

export interface WorkflowDefinition {
  id: string                       // 稳定 slug
  name: string
  emoji?: string
  description?: string
  status: WorkflowStatus
  version: number                  // 内容变更时自增
  trigger: WorkflowTrigger
  condition?: WorkflowConditionNode
  steps: WorkflowStep[]
  createdAt: string
  updatedAt: string
  lastRunAt?: string
  runCount?: number
  triggerType: WorkflowTriggerType // 冗余字段，便于索引查询
}

export interface WorkflowStepLog {
  stepId: string
  name: string
  status: 'success' | 'failed' | 'skipped' | 'awaiting_approval'
  attempts: number
  error?: string
  startedAt: string
  finishedAt?: string
  result?: Record<string, any>
}

export interface WorkflowRunRecord {
  id: string
  workflowId: string
  workflowVersion: number          // 执行时的定义版本快照
  status: 'running' | 'completed' | 'failed' | 'awaiting_approval' | 'cancelled'
  triggerInfo: { type: WorkflowTriggerType; source?: string }
  contextSnapshot: Record<string, any>   // 有界的触发上下文
  logs: WorkflowStepLog[]
  pendingStepIndex?: number        // 审批恢复指针
  error?: string
  startedAt: string
  finishedAt?: string
}

// ====== 外部集成 Integration Layer（v0.8）======
// 铁律：外部系统永远不直接修改业务数据
//   Gmail Tool → Integration Layer(CommandBus) → Command → Repository → Event

export type IntegrationId =
  | 'gmail' | 'calendar' | 'shopify' | 'hermes' | 'n8n' | 'mcp' | 'obsidian'

export interface IntegrationCommand {
  id: string
  integration: IntegrationId
  type: string                     // 如 customer.upsert / communication.log / email.send
  payload: Record<string, any>
  createdAt: string
}

export interface IntegrationCommandResult {
  ok: boolean
  objectType?: ObjectType
  objectId?: string
  error?: string
  [key: string]: any
}

export interface IntegrationToolDescriptor {
  name: string
  level: PermissionLevel           // L3 的工具只能经 Approval 执行
  description: string
}

// ====== 外贸管道（v0.9）======

export type TradeStage =
  | 'inquiry'       // 询盘
  | 'quotation'     // 报价
  | 'negotiation'   // 谈判
  | 'payment'       // 付款
  | 'production'    // 生产
  | 'shipping'      // 发货
  | 'after_sales'   // 售后
  | 'repurchase'    // 复购
  | 'lost'          // 流失

export const TRADE_STAGE_ORDER: TradeStage[] = [
  'inquiry', 'quotation', 'negotiation', 'payment',
  'production', 'shipping', 'after_sales', 'repurchase',
]

export interface TradeDeal {
  id: string
  title: string
  customerId?: string
  stage: TradeStage
  stageHistory: { stage: TradeStage; at: string }[]
  value?: number
  currency?: string
  inquirySource?: string        // 来源渠道（展会/阿里/B2B…）
  assigneeNote?: string
  tags: string[]
  createdAt: string
  updatedAt: string
}

// ====== 独立站（Shopify，v0.9）======

export interface SiteProduct {
  id: string
  handle: string                 // shopify handle，幂等 upsert 键
  title: string
  status: 'active' | 'draft' | 'archived'
  price?: number
  currency?: string
  inventory?: number
  vendor?: string
  tags: string[]
  updatedAt: string
}

/** 每日站点指标快照（流量/转化/广告/复购） */
export interface SiteMetric {
  id: string                     // `${date}` 每日一条，幂等 upsert
  date: string                   // YYYY-MM-DD
  visitors: number
  ordersCount: number
  conversionRate: number         // %
  revenue?: number
  currency?: string
  adSpend?: number
  repeatOrderRate?: number       // %
  seoTopKeywords?: number
  source: 'shopify' | 'manual'
  createdAt: string
}

export interface SeoKeyword {
  id: string
  keyword: string
  position?: number
  volume?: number
  difficulty?: number
  targetUrl?: string
  checkedAt: string
}


// ====== 四层数据库（v1.0 补齐）======

/** 第三层：AI —— 工具注册表持久化 */
export interface AgentToolRecord {
  id: string                    // = name
  name: string                  // 如 'inbox.annotate'
  level: PermissionLevel
  description: string
  updatedAt: string
}

/** 第三层：AI —— 动作权限映射持久化 */
export interface AgentPermissionRecord {
  id: string                    // = `${domain}:${actionType}`
  actionType: string            // 如 'knowledge_draft' / 'external_mock'
  domain: 'agent' | 'workflow'
  level: PermissionLevel
  updatedAt: string
}

/** 第三层：AI —— AIContext 快照（可追溯 AI 当时看到了什么） */
export interface ContextSnapshotRecord {
  id: string                    // = AIContext.id
  createdAt: string
  focusSummary: string          // 页面/焦点的简述
  tokensUsed: number
  tokenBudget: number
  itemsCount: number
  context: any                  // 完整 AIContext
}

// ---------- 第四层：自动化 ----------

/** 工作流版本快照（每次内容变更冻结一份） */
export interface WorkflowVersionRecord {
  id: string                    // `${workflowId}:v${version}`
  workflowId: string
  version: number
  definition: Record<string, any>
  createdAt: string
}

/** 工作流步骤（定义的规范化视图，执行引擎仍读内嵌副本） */
export interface WorkflowStepRecord {
  id: string                    // `${workflowId}:v${version}:${stepId}`
  workflowId: string
  version: number
  order: number
  stepId: string
  name: string
  action: WorkflowActionType
  requireApproval: boolean
  updatedAt: string             // 云同步 LWW 时钟（步骤无独立时间戳会退化为永不拉取）
}


// ====== 云同步（v1.1 草案）======

/** 删除墓碑：本地删除记录的日志，用于向其他设备传播删除 */
export interface DeletionRecord {
  id: string                    // `${tableName}:${rowId}`
  tableName: string
  rowId: string
  deletedAt: string
}

export interface CloudSyncConfig {
  serverUrl: string
  username: string
  token?: string
  lastPushAt?: string
  lastPullCursor?: string
  lastSyncAt?: string
  /** 自动同步：应用启动时 + 每 5 分钟（前台时） */
  autoSync?: boolean
}
