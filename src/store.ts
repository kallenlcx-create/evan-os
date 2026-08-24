import { create } from 'zustand'
import { db, TABLES, exportDatabase, importDatabase, autoBackup } from './db'
import type {
  Goal, Project, Task, Customer, Opportunity, Order, Communication,
  Knowledge, Inspiration, Question, Research, Experiment, Decision, Review, Process,
  Habit, InboxItem, LearningPath, AgentConfig, Notification,
  DailyLog, PomodoroSession, TagStats, AppState, AnyObject, ObjectType
} from './types'
import { loadAllObjects } from './repositories/objectRepository'
import { uid, now } from './repositories/result'
import { searchService } from './services/searchService'
import { relationQueryService } from './services/relationQueryService'

// ====== Store 接口 ======
export interface EvanStore {
  // 加载状态
  loaded: boolean
  setLoaded: (v: boolean) => void

  // 数据
  goals: Goal[]
  projects: Project[]
  tasks: Task[]
  customers: Customer[]
  opportunities: Opportunity[]
  orders: Order[]
  communications: Communication[]
  knowledge: Knowledge[]
  inspirations: Inspiration[]
  questions: Question[]
  research: Research[]
  experiments: Experiment[]
  decisions: Decision[]
  reviews: Review[]
  processes: Process[]
  habits: Habit[]
  inbox: InboxItem[]
  learningPaths: LearningPath[]
  agents: AgentConfig[]
  notifications: Notification[]
  dailyLogs: DailyLog[]
  pomodoroSessions: PomodoroSession[]

  // UI 状态
  app: AppState

  // 初始化
  initFromDB: () => Promise<void>

  // UI 操作
  toggleSidebar: () => void
  setMobileNav: (open: boolean) => void
  toggleGlobalSearch: () => void
  toggleQuickCapture: () => void

  // 通用 CRUD（通过 Repository）
  addObject: (type: ObjectType, data: Record<string, any>) => Promise<string>
  updateObject: (type: ObjectType, id: string, data: Partial<AnyObject>) => Promise<void>
  deleteObject: (type: ObjectType, id: string) => Promise<void>

  // 任务
  addTask: (data: Partial<Task>) => Promise<string>
  toggleTaskStatus: (id: string) => Promise<void>
  reorderTasks: (ids: string[]) => Promise<void>

  // 项目
  updateProjectStatus: (id: string, status: Project['status']) => Promise<void>

  // 目标
  updateGoalProgress: (id: string, progress: number) => Promise<void>

  // 习惯
  toggleHabit: (id: string, date: string) => Promise<void>

  // 全局收集
  addToInbox: (content: string, type: InboxItem['type']) => Promise<string>
  processInboxItem: (id: string, processedType: ObjectType, processedId: string) => Promise<void>
  deleteInboxItem: (id: string) => Promise<void>

  // 通知
  addNotification: (data: Partial<Notification>) => Promise<void>
  markNotificationRead: (id: string) => Promise<void>
  markAllNotificationsRead: () => Promise<void>
  clearNotifications: () => Promise<void>

  // 学习路径
  addLearningPath: (data: Partial<LearningPath>) => Promise<string>
  updateLearningPathStatus: (id: string, status: LearningPath['status']) => Promise<void>

  // 导入导出 / 备份
  exportData: () => Promise<string>
  importData: (json: string) => Promise<void>
  backup: () => Promise<void>

  // 每日日志
  getDailyLog: (date: string) => DailyLog | undefined
  saveDailyLog: (date: string, content: string, mood: string, energy: number) => Promise<void>

  // 标签
  getAllTags: () => TagStats[]
  getObjectsByTag: (tag: string) => AnyObject[]

  // 知识双向链接
  computeBacklinks: (knowledgeId: string) => string[]
  getBacklinks: (knowledgeId: string) => Knowledge[]

  // 番茄钟
  addPomodoroSession: (data: Partial<PomodoroSession>) => Promise<void>
  getTodayPomodoroStats: () => { count: number; minutes: number; completed: number }

  // 四象限
  getQuadrantTasks: () => { q1: Task[]; q2: Task[]; q3: Task[]; q4: Task[] }

  // 目标层级
  getGoalHierarchy: () => Goal[]
  getChildGoals: (parentId: string) => Goal[]

  // 查询
  getTodayTasks: () => Task[]
  getUnreadNotifications: () => Notification[]
  getRelatedObjects: (id: string) => AnyObject[]
  searchAll: (query: string) => AnyObject[]
}

// ====== 初始种子数据 ======
function getSeedData() {
  const seedGoals: Goal[] = [
    {
      id: 'goal-1', type: 'goal',
      title: '建立完整的个人与事业操作系统',
      description: '构建一个集目标管理、任务追踪、知识沉淀、AI 辅助于一体的个人工作台',
      emoji: '🧠', tags: ['系统', '效率'],
      level: 'current', progress: 10,
      keyResults: [
        { id: 'kr-1', title: '完成核心框架搭建', current: 1, target: 1, unit: '个' },
        { id: 'kr-2', title: '实现每日工作流闭环', current: 0, target: 1, unit: '个' },
        { id: 'kr-3', title: '沉淀 100 条知识', current: 0, target: 100, unit: '条' },
      ],
      relations: [], createdAt: now(), updatedAt: now(), deadline: '2026-12-31',
    },
    {
      id: 'goal-2', type: 'goal',
      title: '提升英语到商务沟通水平',
      description: '能用英语流利进行商务谈判、邮件沟通、产品介绍',
      emoji: '🗣️', tags: ['英语', '外贸'],
      level: '90_day', progress: 30,
      keyResults: [
        { id: 'kr-4', title: '每日学习 30 分钟', current: 22, target: 90, unit: '天' },
        { id: 'kr-5', title: '背诵 500 个商务词汇', current: 150, target: 500, unit: '个' },
      ],
      relations: [], createdAt: now(), updatedAt: now(),
    },
  ]

  const seedProjects: Project[] = [
    {
      id: 'proj-1', type: 'project',
      title: 'Evan OS 工作台搭建',
      description: '从零搭建个人工作台，本期实现核心功能',
      emoji: '🖥️', tags: ['开发', '系统'],
      status: 'in_progress', progress: 15, tasks: [],
      relations: [{ targetId: 'goal-1', targetType: 'goal', label: '支撑' }],
      createdAt: now(), updatedAt: now(),
    },
    {
      id: 'proj-2', type: 'project',
      title: '每日英语学习计划',
      description: '坚持每天学习英语，提升听说读写能力',
      emoji: '📖', tags: ['英语', '习惯'],
      status: 'in_progress', progress: 25, tasks: [],
      relations: [{ targetId: 'goal-2', targetType: 'goal', label: '支撑' }],
      createdAt: now(), updatedAt: now(),
    },
  ]

  const seedTasks: Task[] = [
    {
      id: 'task-1', type: 'task',
      title: '完成 Evan OS 核心框架搭建',
      description: '搭建 React 项目、配置路由、实现基础布局',
      emoji: '🔨', tags: ['开发'],
      status: 'in_progress', priority: 'high', importance: 'high',
      relations: [{ targetId: 'proj-1', targetType: 'project', label: '属于' }],
      todayOrder: 0, createdAt: now(), updatedAt: now(), isRecurring: false,
    },
    {
      id: 'task-2', type: 'task',
      title: '学习 30 分钟英语',
      description: '背单词 + 听力练习',
      emoji: '📝', tags: ['英语', '每日'],
      status: 'todo', priority: 'medium', importance: 'high',
      isRecurring: true, recurringRule: 'daily', todayOrder: 1,
      relations: [{ targetId: 'proj-2', targetType: 'project', label: '属于' }],
      createdAt: now(), updatedAt: now(),
    },
    {
      id: 'task-3', type: 'task',
      title: '复盘今日工作',
      description: '填写每日复盘：做了什么、学到了什么、明天重点',
      emoji: '🔄', tags: ['每日', '复盘'],
      status: 'todo', priority: 'medium', importance: 'medium',
      isRecurring: true, recurringRule: 'daily', todayOrder: 2,
      relations: [], createdAt: now(), updatedAt: now(),
    },
  ]

  const seedHabits: Habit[] = [
    { id: 'habit-1', title: '英语学习 30 分钟', emoji: '📖', frequency: 'daily', targetDays: [1,2,3,4,5,6,7], completedDates: [], streak: 0, createdAt: now() },
    { id: 'habit-2', title: '每日复盘', emoji: '🔄', frequency: 'daily', targetDays: [1,2,3,4,5,6,7], completedDates: [], streak: 0, createdAt: now() },
    { id: 'habit-3', title: '运动 20 分钟', emoji: '🏃', frequency: 'daily', targetDays: [1,2,3,4,5], completedDates: [], streak: 0, createdAt: now() },
  ]

  const seedLearningPaths: LearningPath[] = [
    { id: 'lp-1', title: 'React + TypeScript', emoji: '⚛️', status: 'practicing', resources: ['React 官方文档', 'TypeScript 手册'], notes: '正在通过 Evan OS 项目实践', createdAt: now() },
    { id: 'lp-2', title: 'AI Agent 开发', emoji: '🤖', status: 'learning', resources: [], notes: '了解 Agent 框架和自动化工作流', createdAt: now() },
    { id: 'lp-3', title: '英语商务沟通', emoji: '💼', status: 'learning', resources: [], notes: '外贸英语、邮件写作、口语表达', createdAt: now() },
  ]

  const seedAgents: AgentConfig[] = [
    { id: 'agent-1', name: '知识助手', emoji: '🧠', description: '自动整理和关联知识条目', domain: '知识管理', status: 'draft', triggers: ['新增知识', '发现关联'], createdAt: now() },
    { id: 'agent-2', name: '复盘助手', emoji: '🔍', description: '每日自动汇总工作，生成复盘草稿', domain: '效率', status: 'draft', triggers: ['每日结束'], createdAt: now() },
  ]

  const seedNotifications: Notification[] = [
    { id: 'notif-1', title: '欢迎使用 Evan OS', message: '你的个人与事业操作系统已经就绪！从今天开始，让一切井井有条。', type: 'system', read: false, createdAt: now() },
  ]

  return {
    goals: seedGoals, projects: seedProjects, tasks: seedTasks,
    knowledge: [] as Knowledge[], inspirations: [] as Inspiration[],
    questions: [] as Question[], research: [] as Research[],
    experiments: [] as Experiment[], decisions: [] as Decision[],
    reviews: [] as Review[], processes: [] as Process[],
    habits: seedHabits, inbox: [] as InboxItem[],
    learningPaths: seedLearningPaths, agents: seedAgents,
    notifications: seedNotifications,
    // v3 新增空表
    customers: [] as Customer[], opportunities: [] as Opportunity[],
    orders: [] as Order[], communications: [] as Communication[],
  }
}

// ====== 计算连续天数 ======
function calcStreak(dates: string[]): number {
  if (dates.length === 0) return 0
  const sorted = [...dates].sort((a, b) => b.localeCompare(a))
  const today = new Date().toISOString().slice(0, 10)
  let current = new Date(sorted[0])
  let streak = 0
  if (sorted[0] > today) { current = new Date(today); sorted.shift() }
  while (sorted.length) {
    const d = new Date(sorted[0])
    if (d.toISOString().slice(0, 10) === current.toISOString().slice(0, 10)) {
      streak++; sorted.shift()
    } else break
    current.setDate(current.getDate() - 1)
  }
  return streak
}

// ====== 辅助：ObjectType → Zustand collection key ======
// 修复版：customer/opportunity/order/communication 不再映射到 goals
function getCollectionKey(type: ObjectType): string {
  const map: Record<ObjectType, string> = {
    goal: 'goals', domain: 'goals',
    project: 'projects', task: 'tasks',
    customer: 'customers',        // ✅ 修复
    opportunity: 'opportunities', // ✅ 修复
    order: 'orders',              // ✅ 修复
    communication: 'communications', // ✅ 修复
    knowledge: 'knowledge', inspiration: 'inspirations',
    question: 'questions', research: 'research',
    experiment: 'experiments', decision: 'decisions',
    review: 'reviews', process: 'processes', agent: 'agents',
  }
  return map[type]
}

// ====== 安全写入 ======
async function safeWrite<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try { return await fn() } catch (err) { console.warn('[EvanOS] 写入失败:', err); return undefined }
}

// ====== 创建 Store ======
export const useStore = create<EvanStore>()((set, get) => ({

  loaded: false,
  setLoaded: (v) => set({ loaded: v }),

  // ====== 初始空数据 ======
  goals: [], projects: [], tasks: [],
  customers: [], opportunities: [], orders: [], communications: [],
  knowledge: [], inspirations: [], questions: [], research: [],
  experiments: [], decisions: [], reviews: [], processes: [],
  habits: [], inbox: [], learningPaths: [], agents: [],
  notifications: [], dailyLogs: [], pomodoroSessions: [],

  app: { sidebarCollapsed: false, globalSearchOpen: false, quickCaptureOpen: false, mobileNavOpen: false },

  // ====== 从 IndexedDB 加载（通过 Repository）======
  initFromDB: async () => {
    const seed = getSeedData()
    let state: any = {}

    try {
      await Promise.race([
        (async () => {
          // 通过 Repository 层加载所有数据
          state = await loadAllObjects()

          // 种子数据：如果表为空，写入种子
          const seedEntries = Object.entries(seed) as [string, any[]][]
          await Promise.all(seedEntries.map(async ([name, seedItems]) => {
            if (!state[name] || state[name].length === 0) {
              if (seedItems.length > 0) {
                state[name] = seedItems
                const table = (TABLES as any)[name]
                if (table) {
                  await safeWrite(() => table.bulkPut(seedItems))
                }
              } else {
                state[name] = []
              }
            }
          }))

          // 加载 UI 状态
          try {
            const appState = await db.appState.get('app')
            if (appState) state.app = appState
          } catch (err) {
            console.warn('[EvanOS] 读取 UI 状态失败:', err)
          }
        })(),
        new Promise(resolve => setTimeout(resolve, 4000)),
      ])
    } catch (err) {
      console.warn('[EvanOS] 数据库初始化失败，使用种子数据:', err)
    }

    // 确保每个表都有数据（兜底）
    Object.keys(TABLES).forEach(name => {
      if (!state[name]) state[name] = (seed as any)[name] || []
    })
    if (!state.app) state.app = { sidebarCollapsed: false, globalSearchOpen: false, quickCaptureOpen: false }

    set(state)
    set({ loaded: true })

    // 初始化搜索索引和关系缓存
    try {
      await searchService.load()
      relationQueryService.invalidate()
    } catch (err) {
      console.warn('[EvanOS] 搜索索引初始化失败:', err)
    }
  },

  // ====== UI 操作 ======
  toggleSidebar: () => {
    const next = { ...get().app, sidebarCollapsed: !get().app.sidebarCollapsed }
    set({ app: next })
    db.appState.put(next, 'app').catch(() => {})
  },
  setMobileNav: (open: boolean) => {
    // mobileNavOpen 为瞬态状态，不持久化
    set({ app: { ...get().app, mobileNavOpen: open } })
  },
  toggleGlobalSearch: () => {
    const next = { ...get().app, globalSearchOpen: !get().app.globalSearchOpen }
    set({ app: next })
    db.appState.put(next, 'app').catch(() => {})
  },
  toggleQuickCapture: () => {
    const next = { ...get().app, quickCaptureOpen: !get().app.quickCaptureOpen }
    set({ app: next })
    db.appState.put(next, 'app').catch(() => {})
  },

  // ====== 通用 CRUD（通过 Repository）======
  addObject: async (type, data) => {
    const { createObject } = await import('./repositories/objectRepository')
    const result = await createObject(type, data)
    if (result.ok) {
      const key = getCollectionKey(type)
      set(s => ({ [key]: [...(s[key] as any[] || []), result.value] } as any))
      searchService.updateObject(result.value)
      relationQueryService.invalidate()
      return result.value.id
    }
    // 降级：内存模式
    const id = data.id || uid()
    const item = { ...data, id, type, createdAt: now(), updatedAt: now() }
    const key = getCollectionKey(type)
    set(s => ({ [key]: [...(s[key] as any[] || []), item] } as any))
    searchService.updateObject(item as AnyObject)
    return id
  },

  updateObject: async (type, id, data) => {
    const { updateObject: repoUpdate } = await import('./repositories/objectRepository')
    await repoUpdate(type, id, data)
    const key = getCollectionKey(type)
    const updated = (get()[key] as any[] || []).map(item =>
      item.id === id ? { ...item, ...data, updatedAt: now() } : item
    )
    set({ [key]: updated } as any)
    const obj = updated.find(i => i.id === id)
    if (obj) searchService.updateObject(obj)
    relationQueryService.invalidate()
  },

  deleteObject: async (type, id) => {
    const { deleteObject: repoDelete } = await import('./repositories/objectRepository')
    await repoDelete(type, id)
    const key = getCollectionKey(type)
    set(s => ({ [key]: (s[key] as any[] || []).filter(item => item.id !== id) } as any))
    searchService.removeObject(id, type)
    relationQueryService.invalidate()
  },

  // ====== 任务 ======
  addTask: async (data) => {
    const { createTask } = await import('./repositories/taskRepository')
    const result = await createTask(data)
    if (result.ok) {
      set(s => ({ tasks: [...s.tasks, result.value] }))
      return result.value.id
    }
    // 降级
    const id = uid()
    const task: Task = {
      id, type: 'task',
      title: data.title || '', description: data.description || '',
      emoji: data.emoji || '✅', tags: data.tags || [], relations: [],
      status: 'todo', priority: data.priority || 'medium',
      importance: data.importance || 'medium', dueDate: data.dueDate,
      isRecurring: data.isRecurring || false, todayOrder: get().tasks.length,
      createdAt: now(), updatedAt: now(),
    }
    set(s => ({ tasks: [...s.tasks, task] }))
    return id
  },

  toggleTaskStatus: async (id) => {
    const { toggleTaskStatus: repoToggle } = await import('./repositories/taskRepository')
    await repoToggle(id)
    const task = get().tasks.find(t => t.id === id)
    if (task) {
      const next = { ...task, status: task.status === 'done' ? 'todo' : 'done' as Task['status'], updatedAt: now() }
      set(s => ({ tasks: s.tasks.map(t => t.id === id ? next : t) }))
    }
  },

  reorderTasks: async (ids) => {
    const tasks = get().tasks
    const updated = tasks.map(t => {
      const idx = ids.indexOf(t.id)
      return idx >= 0 ? { ...t, todayOrder: idx } : t
    })
    set({ tasks: updated })
    await safeWrite(() => Promise.all(updated.map(t => db.tasks.put(t))))
  },

  // ====== 项目 ======
  updateProjectStatus: async (id, status) => {
    const project = get().projects.find(p => p.id === id)
    if (!project) return
    const next = { ...project, status, updatedAt: now() }
    set(s => ({ projects: s.projects.map(p => p.id === id ? next : p) }))
    await safeWrite(() => db.projects.put(next))
  },

  // ====== 目标 ======
  updateGoalProgress: async (id, progress) => {
    const goal = get().goals.find(g => g.id === id)
    if (!goal) return
    const next = { ...goal, progress, updatedAt: now() }
    set(s => ({ goals: s.goals.map(g => g.id === id ? next : g) }))
    await safeWrite(() => db.goals.put(next))
  },

  // ====== 习惯 ======
  toggleHabit: async (id, date) => {
    const habit = get().habits.find(h => h.id === id)
    if (!habit) return
    const already = habit.completedDates.includes(date)
    const dates = already ? habit.completedDates.filter(d => d !== date) : [...habit.completedDates, date]
    const next = { ...habit, completedDates: dates, streak: calcStreak(dates) }
    set(s => ({ habits: s.habits.map(h => h.id === id ? next : h) }))
    await safeWrite(() => db.habits.put(next))
  },

  // ====== 全局收集 ======
  addToInbox: async (content, type) => {
    const { captureInbox } = await import('./repositories/inboxRepository')
    const result = await captureInbox(content, type)
    if (result.ok) {
      set(s => ({ inbox: [result.value, ...s.inbox] }))
      return result.value.id
    }
    // 降级
    const id = uid()
    const item: InboxItem = { id, content, type, capturedAt: now(), processed: false }
    set(s => ({ inbox: [item, ...s.inbox] }))
    return id
  },

  processInboxItem: async (id, processedType, processedId) => {
    const { processInbox } = await import('./repositories/inboxRepository')
    await processInbox(id, processedType, processedId)
    set(s => ({ inbox: s.inbox.map(i => i.id === id ? { ...i, processed: true, processedType, processedId } : i) }))
  },

  deleteInboxItem: async (id) => {
    const { deleteInboxItem: repoDelete } = await import('./repositories/inboxRepository')
    await repoDelete(id)
    set(s => ({ inbox: s.inbox.filter(i => i.id !== id) }))
  },

  // ====== 通知 ======
  addNotification: async (data) => {
    const notif: Notification = {
      id: uid(), title: data.title || '', message: data.message || '',
      type: data.type || 'system', read: false, createdAt: now(), targetId: data.targetId,
    }
    set(s => ({ notifications: [notif, ...s.notifications] }))
    await safeWrite(() => db.notifications.add(notif))
  },
  markNotificationRead: async (id) => {
    const notif = get().notifications.find(n => n.id === id)
    if (!notif) return
    const next = { ...notif, read: true }
    set(s => ({ notifications: s.notifications.map(n => n.id === id ? next : n) }))
    await safeWrite(() => db.notifications.put(next))
  },
  markAllNotificationsRead: async () => {
    const updated = get().notifications.map(n => ({ ...n, read: true }))
    set({ notifications: updated })
    await safeWrite(() => Promise.all(updated.map(n => db.notifications.put(n))))
  },
  clearNotifications: async () => {
    set({ notifications: [] })
    await safeWrite(() => db.notifications.clear())
  },

  // ====== 学习路径 ======
  addLearningPath: async (data) => {
    const id = uid()
    const lp: LearningPath = {
      id, title: data.title || '', emoji: data.emoji || '📚',
      status: data.status || 'not_started', resources: data.resources || [],
      notes: data.notes || '', createdAt: now(),
    }
    set(s => ({ learningPaths: [...s.learningPaths, lp] }))
    await safeWrite(() => db.learningPaths.add(lp))
    return id
  },
  updateLearningPathStatus: async (id, status) => {
    const lp = get().learningPaths.find(l => l.id === id)
    if (!lp) return
    const next = { ...lp, status }
    set(s => ({ learningPaths: s.learningPaths.map(l => l.id === id ? next : l) }))
    await safeWrite(() => db.learningPaths.put(next))
  },

  // ====== 导入导出 / 备份 ======
  exportData: exportDatabase,
  importData: async (json) => { await importDatabase(json); await get().initFromDB() },
  backup: autoBackup,

  // ====== 查询 ======
  getTodayTasks: () => get().tasks.filter(t => t.status !== 'done' && t.status !== 'cancelled'),
  getUnreadNotifications: () => get().notifications.filter(n => !n.read),

  getRelatedObjects: (id) => {
    const s = get()
    const allObjects: AnyObject[] = [
      ...s.goals, ...s.projects, ...s.tasks, ...s.knowledge,
      ...s.inspirations, ...s.questions, ...s.research,
      ...s.experiments, ...s.decisions, ...s.reviews, ...s.processes,
      ...s.customers, ...s.opportunities, ...s.orders, ...s.communications,
    ]
    // 先查 Relation 表（Source of Truth）
    const relations = searchService.getAllRelations().filter(r =>
      r.sourceId === id || r.targetId === id
    )
    const relatedIds = new Set(relations.flatMap(r =>
      r.sourceId === id ? [r.targetId] : [r.sourceId]
    ))
    if (relatedIds.size > 0) {
      return allObjects.filter(o => relatedIds.has(o.id))
    }
    // 兼容旧数据：查 relations 字段
    const target = allObjects.find(o => o.id === id)
    if (!target) return []
    return target.relations
      .map(r => allObjects.find(o => o.id === r.targetId))
      .filter(Boolean) as AnyObject[]
  },

  searchAll: (query) => {
    if (!query.trim()) return []
    // 使用 SearchService 的快速搜索
    const results = searchService.quickSearch(query)
    return results.map(sr => sr.item as unknown as AnyObject)
  },

  // ====== 每日日志 ======
  getDailyLog: (date) => get().dailyLogs.find(l => l.date === date),
  saveDailyLog: async (date, content, mood, energy) => {
    const existing = get().dailyLogs.find(l => l.date === date)
    if (existing) {
      const updated = { ...existing, content, mood, energy, updatedAt: now() }
      set(s => ({ dailyLogs: s.dailyLogs.map(l => l.id === existing.id ? updated : l) }))
      await safeWrite(() => db.dailyLogs.put(updated))
    } else {
      const entry: DailyLog = {
        id: uid(), date, content, mood, energy, highlights: [], tasks: [],
        createdAt: now(), updatedAt: now(),
      }
      set(s => ({ dailyLogs: [...s.dailyLogs, entry] }))
      await safeWrite(() => db.dailyLogs.add(entry))
    }
  },

  // ====== 番茄钟 ======
  addPomodoroSession: async (data) => {
    const session: PomodoroSession = {
      id: uid(), taskId: data.taskId, taskTitle: data.taskTitle,
      startTime: data.startTime || now(), endTime: data.endTime || now(),
      duration: data.duration || 25, type: data.type || 'focus',
      completed: data.completed ?? true,
    }
    set(s => ({ pomodoroSessions: [...s.pomodoroSessions, session] }))
  },
  getTodayPomodoroStats: () => {
    const today = new Date().toISOString().slice(0, 10)
    const sessions = get().pomodoroSessions.filter(s => s.startTime.startsWith(today))
    return {
      count: sessions.length,
      minutes: sessions.reduce((sum, s) => sum + s.duration, 0),
      completed: sessions.filter(s => s.completed && s.type === 'focus').length,
    }
  },

  // ====== 四象限 ======
  getQuadrantTasks: () => {
    const active = get().tasks.filter(t => t.status !== 'done' && t.status !== 'cancelled')
    return {
      q1: active.filter(t => t.priority === 'urgent' && t.importance === 'high'),
      q2: active.filter(t => t.priority !== 'urgent' && t.importance === 'high'),
      q3: active.filter(t => t.priority === 'urgent' && t.importance !== 'high'),
      q4: active.filter(t => t.priority !== 'urgent' && t.importance !== 'high'),
    }
  },

  // ====== 目标层级 ======
  getGoalHierarchy: () => get().goals.filter(g => !g.parentGoalId),
  getChildGoals: (parentId) => get().goals.filter(g => g.parentGoalId === parentId),

  // ====== 标签系统 ======
  getAllTags: () => {
    const s = get()
    const tagMap = new Map<string, { count: number; types: Set<string> }>()
    const all: AnyObject[] = [
      ...s.goals, ...s.projects, ...s.tasks, ...s.knowledge,
      ...s.inspirations, ...s.questions, ...s.research,
      ...s.experiments, ...s.decisions, ...s.reviews, ...s.processes,
      ...s.customers, ...s.opportunities, ...s.orders, ...s.communications,
    ]
    all.forEach(o => {
      o.tags.forEach(tag => {
        const e = tagMap.get(tag) || { count: 0, types: new Set<string>() }
        e.count++; e.types.add(o.type); tagMap.set(tag, e)
      })
    })
    return Array.from(tagMap.entries())
      .map(([tag, v]) => ({ tag, count: v.count, types: Array.from(v.types) }))
      .sort((a, b) => b.count - a.count)
  },

  getObjectsByTag: (tag) => {
    const s = get()
    const all: AnyObject[] = [
      ...s.goals, ...s.projects, ...s.tasks, ...s.knowledge,
      ...s.inspirations, ...s.questions, ...s.research,
      ...s.experiments, ...s.decisions, ...s.reviews, ...s.processes,
      ...s.customers, ...s.opportunities, ...s.orders, ...s.communications,
    ]
    return all.filter(o => o.tags.includes(tag))
  },

  // ====== 双向链接 ======
  computeBacklinks: (knowledgeId) => {
    const s = get()
    const pattern = new RegExp(`\\[\\[([^\\]]*)\\]\\(knowledge:${knowledgeId}\\)`, 'g')
    const backlinks: string[] = []
    s.knowledge.forEach(k => {
      if (k.id === knowledgeId) return
      let m
      while ((m = pattern.exec(k.content)) !== null) {
        if (!backlinks.includes(k.id)) backlinks.push(k.id)
      }
    })
    return backlinks
  },
  getBacklinks: (knowledgeId) => {
    const ids = get().computeBacklinks(knowledgeId)
    return get().knowledge.filter(k => ids.includes(k.id))
  },
}))
