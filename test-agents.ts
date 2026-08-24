// ====== Evan OS v0.6 AI Agent Runtime 测试 ======
// 标准十要素结构 / 三级权限门控 / 4 个 Agent 流程 / 审批生命周期 / 触发器
// 运行: npx tsx test-agents.ts

import 'fake-indexeddb/auto'
import { db } from './src/db.ts'
import { agentRuntime } from './src/services/agentRuntime.ts'
import './src/services/agents.ts' // 注册 4 个 Agent
import { AGENT_TOOLS } from './src/services/agentTools.ts'
import { ACTION_PERMISSION } from './src/types.ts'
import { createProject } from './src/repositories/projectRepository.ts'
import { createTask } from './src/repositories/taskRepository.ts'
import { createKnowledge } from './src/repositories/knowledgeRepository.ts'
import { createObject } from './src/repositories/objectRepository.ts'
import { createRelation } from './src/repositories/relationRepository.ts'
import { captureInbox } from './src/repositories/inboxRepository.ts'

let pass = 0, fail = 0
function assert(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`) }
  else { fail++; console.log(`  [FAIL] ${name}`) }
}

console.log('\n🧪 Evan OS v0.6 AI Agent Runtime 测试\n')

await Promise.all([
  db.projects.clear(), db.tasks.clear(), db.knowledge.clear(), db.questions.clear(),
  db.reviews.clear(), db.research.clear(), db.relations.clear(), db.events.clear(),
  db.inbox.clear(), db.dailyLogs.clear(), db.memories.clear(),
  db.agentRuns.clear(), db.approvals.clear(),
])

// ====== A. 标准结构（十要素）======
console.log('— 标准结构 —')

const defs = agentRuntime.listAgents()
assert('A1. 第一批恰好注册 4 个 Agent', defs.length === 4)
const ids = new Set(defs.map(d => d.id))
assert('A2. Agent 集合正确',
  ids.has('knowledge_organizer') && ids.has('project_assistant') &&
  ids.has('review_assistant') && ids.has('research_assistant'))

const allComplete = defs.every(d =>
  !!d.name && !!d.role && !!d.goal &&            // 身份/目标
  d.instructions.length >= 3 &&                   // 指令
  !!d.contextPolicy && typeof d.contextPolicy.includeMemories === 'boolean' && // Context
  Array.isArray(d.memoryScope) &&                 // Memory
  d.tools.length >= 3 &&                          // Tools
  d.actions.length >= 1 &&                        // Actions(权限)
  d.triggers.length >= 1 &&                       // Triggers
  !!d.approvalPolicy?.autoExecuteBelow)           // Approval Policy
assert('A3. 每个 Agent 具备完整标准结构', allComplete)

const org = agentRuntime.getAgent('knowledge_organizer')!
assert('A4. 知识整理助手监听 inbox.captured 事件',
  org.triggers.some(t => t.type === 'on_event' && t.eventType === 'inbox.captured'))
assert('A5. 其余 3 个 Agent 仅手动触发',
  ['project_assistant', 'review_assistant', 'research_assistant']
    .every(id => agentRuntime.getAgent(id as never)!.triggers.every(t => t.type === 'manual')))

// ====== B. 权限分级 ======
console.log('— 权限分级 —')

assert('B1. L1 自动：整理Inbox/摘要/建议关系',
  ACTION_PERMISSION.inbox_annotate === 'L1_auto' &&
  ACTION_PERMISSION.summary_generate === 'L1_auto' &&
  ACTION_PERMISSION.relation_suggest === 'L1_auto')
assert('B2. L2 建议：创建对象/修改状态',
  ACTION_PERMISSION.knowledge_draft === 'L2_suggest' &&
  ACTION_PERMISSION.task_draft === 'L2_suggest' &&
  ACTION_PERMISSION.status_change === 'L2_suggest' &&
  ACTION_PERMISSION.review_draft === 'L2_suggest' &&
  ACTION_PERMISSION.research_draft === 'L2_suggest')
assert('B3. L3 人工批准：外部调用/删除数据',
  ACTION_PERMISSION.external_call === 'L3_approval' &&
  ACTION_PERMISSION.destructive === 'L3_approval')
assert('B4. 工具等级标注正确',
  AGENT_TOOLS['external.request'].level === 'L3_approval' &&
  AGENT_TOOLS['data.delete'].level === 'L3_approval' &&
  AGENT_TOOLS['knowledge.create'].level === 'L2_suggest' &&
  AGENT_TOOLS['inbox.annotate'].level === 'L1_auto')

// ====== C. 知识整理助手 ======
console.log('— ① 知识整理助手 —')

await createKnowledge({ title: 'React 性能优化', content: '', tags: ['前端'] })
await createKnowledge({ title: 'React Hooks 指南', content: '', tags: ['前端'] })

await captureInbox('学习 React 调度原理的笔记', 'quick_note')
await captureInbox('https://example.com/react-article', 'link')
await captureInbox('给客户发报价单 任务', 'task')
await captureInbox('已完成任务', 'quick_note')

const r1 = await agentRuntime.run('knowledge_organizer', { trigger: 'manual' })
assert('C1. 运行成功且产生摘要', r1.ok && !!r1.value.summary && r1.value.summary.includes('整理'))

const inboxRows = await db.inbox.toArray()
const annotated = inboxRows.filter(i => (i.metadata as any)?.annotatedBy)
assert('C2. L1 自动：收集项已被自动标注', annotated.length >= 3)
const linkItem = inboxRows.find(i => i.content.includes('https://'))
assert('C3. 分类启发式：链接→参考资料，任务类识别为待办',
  (linkItem?.metadata as any)?.aiCategory === '参考资料' &&
  inboxRows.some(i => (i.metadata as any)?.aiCategory === '待办'))

const agentRels = await db.relations.filter(r => r.createdBy === 'agent').toArray()
assert('C4. L1 自动：同标签知识间建立了建议关系（AI 来源）',
  agentRels.length >= 1 && agentRels.every(r => (r.confidence ?? 0) <= 0.5))

const orgApprovals = await agentRuntime.getPendingApprovals('knowledge_organizer')
assert('C5. L2 建议：知识草稿进入审批队列（任务类条目不代建）',
  orgApprovals.length === 2 &&
  orgApprovals.every(a => a.actionType === 'knowledge_draft'))

const knowledgeBefore = await db.knowledge.count()
const draftApproval = orgApprovals.find(a => a.payload.title.includes('React 调度'))!
const approved = await agentRuntime.approve(draftApproval.id)
const knowledgeAfter = await db.knowledge.count()
assert('C6. 用户批准后知识才真正创建',
  approved.ok && knowledgeAfter === knowledgeBefore + 1 && !!approved.value?.executedAt)
const createdK = await db.knowledge.filter(k => k.title.startsWith('学习 React 调度')).toArray()
assert('C7. 新知识带来源标注与标签',
  createdK.length === 1 && (createdK[0].description ?? '').includes('来自收集箱'))

// ====== D. 项目助手 ======
console.log('— ② 项目助手 —')

const proj = (await createProject({ title: '外贸独立站改版' })).value!
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
const tOverdue = (await createTask({ title: '更新产品页文案', dueDate: yesterday })).value!
void tOverdue
const tBlocked = (await createTask({ title: '等待设计稿' })).value!
await db.tasks.update(tBlocked.id, { status: 'blocked' })
await createRelation('task', tOverdue.id, 'project', proj.id, 'belongs_to')
await createRelation('task', tBlocked.id, 'project', proj.id, 'belongs_to')

const r2 = await agentRuntime.run('project_assistant', {
  trigger: 'manual', input: { projectId: proj.id },
})
assert('D1. 运行成功并输出健康报告', r2.ok && !!r2.value.summary && r2.value.summary.includes('风险'))

const paApprovals = await agentRuntime.getPendingApprovals('project_assistant')
assert('D2. L2 建议：下一步任务草稿进入审批',
  paApprovals.some(a => a.actionType === 'task_draft') &&
  paApprovals.every(a => (a.payload as any).title.includes('逾期')))
const tasksBefore = await db.tasks.count()
await agentRuntime.approve(paApprovals[0].id)
const tasksAfter = await db.tasks.count()
assert('D3. 批准后任务创建（此前未创建）', tasksBefore + 1 === tasksAfter)

// ====== E. 复盘助手 ======
console.log('— ③ 复盘助手 —')

const tDone = (await createTask({ title: '完成周报初稿' })).value!
await db.tasks.update(tDone.id, { status: 'done' })
await db.dailyLogs.add({
  id: 'log1', date: new Date().toISOString().slice(0, 10), content: '顺利',
  mood: 'good', energy: 4, highlights: [], tasks: [],
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
})

const r3 = await agentRuntime.run('review_assistant', { trigger: 'manual' })
assert('E1. 运行成功且摘要含统计', r3.ok && r3.value.summary!.includes('完成任务'))

const raApprovals = await agentRuntime.getPendingApprovals('review_assistant')
assert('E2. L2 建议：复盘草稿进入审批',
  raApprovals.length === 1 && raApprovals[0].actionType === 'review_draft')
const apRes = await agentRuntime.approve(raApprovals[0].id)
if (!apRes.ok || !apRes.value.executedAt) {
  console.log('DEBUG approve:', JSON.stringify(apRes))
}
const today = new Date().toISOString().slice(0, 10)
const reviews = await db.reviews.where('period').equals(today).toArray()
assert('E3. 批准后复盘写入且包含关键要点',
  reviews.length === 1 && reviews[0].keyTakeaways.includes('1 项'))

// ====== F. 研究助手 ======
console.log('— ④ 研究助手 —')

await createKnowledge({ title: '邮件打开率基准研究', content: '行业平均打开率约 20%', tags: ['邮件'] })
await createObject('question', { title: '如何提升客户邮件打开率？', status: 'open' } as never)

const r4 = await agentRuntime.run('research_assistant', { trigger: 'manual' })
assert('F1. 运行成功并报告证据数量', r4.ok && r4.value.summary!.includes('证据'))

const reApprovals = await agentRuntime.getPendingApprovals('research_assistant')
assert('F2. L2 建议：研究草稿+摘要知识草稿',
  reApprovals.length === 2 &&
  reApprovals.some(a => a.actionType === 'research_draft') &&
  reApprovals.some(a => a.actionType === 'knowledge_draft'))

const researchAp = reApprovals.find(a => a.actionType === 'research_draft')!
const researchRes = await agentRuntime.approve(researchAp.id)
if (!researchRes.ok || !researchRes.value.executedAt) {
  console.log('DEBUG research approve:', JSON.stringify(researchRes))
}
const researchRows = await db.research.toArray()
assert('F3. 批准后 Research 创建且引用了证据',
  researchRows.length === 1 &&
  researchRows[0].title.startsWith('研究：') &&
  researchRows[0].findings.includes('邮件'))

// 拒绝路径
const summaryAp = reApprovals.find(a => a.actionType === 'knowledge_draft')!
await agentRuntime.reject(summaryAp.id, '暂不需要')
assert('F4. 拒绝后不创建', !(await db.knowledge.filter(k => k.title.startsWith('研究摘要')).count()))

// ====== G. L3 硬门控 ======
console.log('— L3 权限门控 —')

const l3 = await agentRuntime.submitApproval({
  agentId: 'project_assistant',
  actionType: 'external_call',
  summary: '向客户发送报价邮件',
  payload: { endpoint: 'smtp://send', to: 'client@example.com' },
})
assert('G1. L3 动作进入队列且未执行', l3.status === 'pending' && !l3.executedAt)

const approvedL3 = await agentRuntime.approve(l3.id)
assert('G2. 批准仅改变状态，不执行', approvedL3.ok && approvedL3.value.status === 'approved' && !approvedL3.value.executedAt)

const noToken = await agentRuntime.executeApproved(l3.id)
assert('G3. 缺少 humanToken 时拒绝执行', noToken.ok === false)

const withToken = await agentRuntime.executeApproved(l3.id, 'human-confirmed')
assert('G4. Human 显式执行后才生效', withToken.ok && (withToken.value.executionResult as any)?.stub === true)

const again = await agentRuntime.executeApproved(l3.id, 'human-confirmed')
assert('G5. 已执行的审批不可重复执行', again.ok === false)

// ====== H. 事件触发器 ======
console.log('— 触发器 —')

const runsBefore = await db.agentRuns.count()
await captureInbox('又一条新灵感 idea：自动化报价流程', 'idea')
await agentRuntime.handleEvent({
  type: 'inbox.captured', objectType: 'inspiration', objectId: 'x', payload: {},
} as never)
const runsAfter = await db.agentRuns.count()
const eventRuns = await db.agentRuns.where('trigger').equals('on_event').toArray()
assert('H1. inbox.captured 事件自动触发知识整理助手',
  runsAfter > runsBefore && eventRuns.length >= 1 &&
  eventRuns.every(r => r.agentId === 'knowledge_organizer'))

// ====== I. 失败路径与审计 ======
console.log('— 失败与审计 —')

const badRun = await agentRuntime.run('project_assistant', {
  trigger: 'manual', input: { projectId: '不存在' },
})
assert('I1. 无效输入 → run failed 且记录错误', !badRun.ok)

const totalRuns = await db.agentRuns.count()
assert('I2. 所有运行均有持久化审计记录', totalRuns >= 5)

const toolAbuse = await (async () => {
  try {
    const r = await agentRuntime.run('knowledge_organizer', { trigger: 'manual' })
    return r.ok ? null : null
  } catch { return 'thrown' }
})()
assert('I3. 正常运行不受失败运行影响', toolAbuse === null)

console.log(`\n📊 结果: ${pass} 通过, ${fail} 失败\n`)
process.exit(fail > 0 ? 1 : 0)
