// ====== Evan OS v0.7 Automation Engine 测试 ======
// 版本/状态/条件(AND,OR,NOT)/三种触发器/动作/重试/日志/高风险审批门控
// 运行: npx tsx test-workflow.ts

import 'fake-indexeddb/auto'
import { db } from './src/db.ts'
import {
  workflowEngine, evaluateCondition, interpolate,
} from './src/services/workflowEngine.ts'
import './src/services/agents.ts'

let pass = 0, fail = 0
function assert(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`) }
  else { fail++; console.log(`  [FAIL] ${name}`) }
}

console.log('\n🧪 Evan OS v0.7 Automation Engine 测试\n')

await Promise.all([
  db.workflows.clear(), db.workflowRuns.clear(), db.approvals.clear(),
  db.notifications.clear(), db.relations.clear(), db.knowledge.clear(),
  db.agentRuns.clear(), db.tasks.clear(), db.events.clear(),
])

// ====== A. 条件求值 ======
console.log('— 条件 AND / OR / NOT —')

const ctx = { event: { type: 'inbox.captured', payload: { hasUrl: true, title: 'React 文章' } }, input: { level: 5 } }

assert('A1. leaf eq 命中', evaluateCondition({ kind: 'leaf', field: 'event.payload.hasUrl', operator: 'eq', value: true }, ctx))
assert('A2. leaf contains 不区分大小写', evaluateCondition({ kind: 'leaf', field: 'event.payload.title', operator: 'contains', value: 'react' }, ctx))
assert('A3. gt 数值与日期', evaluateCondition({ kind: 'leaf', field: 'input.level', operator: 'gt', value: 3 }, ctx) && evaluateCondition({ kind: 'leaf', field: 'event.payload.title', operator: 'lt', value: 'zzz' }, ctx))
assert('A4. exists / missing', evaluateCondition({ kind: 'leaf', field: 'event.type', operator: 'exists' }, ctx) && evaluateCondition({ kind: 'leaf', field: 'event.nope.deep', operator: 'missing' }, ctx))

const andNode = { kind: 'group' as const, op: 'and' as const, children: [
  { kind: 'leaf' as const, field: 'event.payload.hasUrl', operator: 'eq', value: true },
  { kind: 'leaf' as const, field: 'event.payload.title', operator: 'contains', value: 'Vue' },
] }
const orNode = { kind: 'group' as const, op: 'or' as const, children: [
  { kind: 'leaf' as const, field: 'event.payload.hasUrl', operator: 'eq', value: false },
  { kind: 'leaf' as const, field: 'event.payload.title', operator: 'contains', value: 'react' },
] }
const notNode = { kind: 'group' as const, op: 'not' as const, children: [andNode] }

assert('A5. AND：两条件须同时成立', !evaluateCondition(andNode, ctx))
assert('A6. OR：任一成立即可', evaluateCondition(orNode, ctx))
assert('A7. NOT：取反 AND', evaluateCondition(notNode, ctx))
assert('A8. 嵌套：NOT(AND) OR leaf',
  evaluateCondition({ kind: 'group', op: 'or', children: [notNode, { kind: 'leaf', field: 'input.level', operator: 'lt', value: 1 }] }, ctx))

assert('A9. 模板插值 {{path}}',
  interpolate({ t: '新条目 {{event.payload.title}} ({{event.type}})' }, ctx).t === '新条目 React 文章 (inbox.captured)')

// ====== B. 注册与版本 ======
console.log('— 注册与版本 —')

const baseDef = {
  id: 'wf-test-basic',
  name: '基础测试流',
  emoji: '🧪',
  description: '',
  trigger: { type: 'manual' as const, description: '' },
  steps: [{ id: 's1', name: '通知', action: 'send_notification' as const, params: { title: 'hi', message: 'm' } }],
}
const v1 = await workflowEngine.register(baseDef)
assert('B1. 首次注册 version=1', v1.ok && v1.value.version === 1)

const same = await workflowEngine.register(baseDef)
assert('B2. 内容相同不升版本', same.ok && same.value.version === 1)

const changed = await workflowEngine.register({ ...baseDef, name: '改名后' })
assert('B3. 内容变更 version 自增', changed.ok && changed.value.version === 2)

// ====== C. 状态门控 ======
console.log('— 状态 —')

await workflowEngine.setStatus('wf-test-basic', 'archived')
const archivedRun = await workflowEngine.triggerManual('wf-test-basic')
assert('C1. archived 工作流拒绝手动运行', archivedRun.ok === false && String(archivedRun.error).includes('archived'))
await workflowEngine.setStatus('wf-test-basic', 'paused')
const pausedRun = await workflowEngine.triggerManual('wf-test-basic')
assert('C2. paused 工作流拒绝手动运行', pausedRun.ok === false)
await workflowEngine.setStatus('wf-test-basic', 'active')

// ====== D. Manual 触发 + 动作 + 插值 + 关系 ======
console.log('— Manual 触发 —')

const kA = await import('./src/repositories/knowledgeRepository.ts').then(m => m.createKnowledge({ title: '知识甲', tags: ['x'] }))
const kB = await import('./src/repositories/knowledgeRepository.ts').then(m => m.createKnowledge({ title: '知识乙', tags: ['y'] }))
if (!kA.ok || !kB.ok) throw new Error('seed failed')

await workflowEngine.register({
  id: 'wf-relate',
  name: '关系连接器',
  trigger: { type: 'manual' },
  steps: [{
    id: 's1', name: '建立关联', action: 'create_relation',
    params: { sourceType: 'knowledge', sourceId: '{{input.a}}', targetType: 'knowledge', targetId: '{{input.b}}', relationType: 'related_to', reason: '测试' },
  }],
})
await workflowEngine.setStatus('wf-relate', 'active')
const relRun = await workflowEngine.triggerManual('wf-relate', { input: { a: kA.value.id, b: kB.value.id } })
assert('D1. 手动运行成功', relRun.ok && relRun.value.status === 'completed')
const autoRel = await db.relations.filter(r => r.createdBy === 'system' && r.source === 'automation').toArray()
assert('D2. create_relation 落库且标记 automation 来源',
  autoRel.length === 1 &&
  autoRel[0].sourceId === kA.value.id && autoRel[0].targetId === kB.value.id)

// ====== E. Event 触发 + 通知 ======
console.log('— Event 触发 —')

await workflowEngine.register({
  id: 'wf-on-capture-url',
  name: '链接捕获提醒',
  trigger: { type: 'event', eventType: 'inbox.captured' },
  condition: { kind: 'leaf', field: 'event.payload.hasUrl', operator: 'eq', value: true },
  steps: [{
    id: 's1', name: '提醒', action: 'send_notification',
    params: { title: '捕获到链接：{{event.payload.title}}', message: '记得整理' },
  }],
})
await workflowEngine.setStatus('wf-on-capture-url', 'active')

const notifBefore = await db.notifications.count()
await workflowEngine.handleEvent({
  type: 'inbox.captured', objectType: 'inspiration', objectId: 'o1',
  payload: { hasUrl: true, title: '好文章' },
})
const runsAfterMatch = await workflowEngine.getRuns('wf-on-capture-url')
const notifAfter = await db.notifications.count()
assert('E1. 匹配事件触发运行并发送通知（模板已插值）',
  runsAfterMatch.length === 1 && runsAfterMatch[0].status === 'completed' &&
  notifAfter === notifBefore + 1 &&
  (runsAfterMatch[0].logs[0].result as any)?.notificationId)

const latestNotif = await db.notifications.orderBy('createdAt').reverse().first()
assert('E2. 通知标题来自模板插值', latestNotif?.title === '捕获到链接：好文章')

await workflowEngine.handleEvent({
  type: 'inbox.captured', objectType: 'inspiration', objectId: 'o2',
  payload: { hasUrl: false, title: '纯文本' },
})
assert('E3. 条件不满足时不运行', (await workflowEngine.getRuns('wf-on-capture-url')).length === 1)

// ====== F. Run Agent 动作 ======
console.log('— Run Agent —')

const agentRunsBefore = await db.agentRuns.count()
await workflowEngine.register({
  id: 'wf-run-review-agent',
  name: '自动复盘',
  trigger: { type: 'manual' },
  steps: [{ id: 's1', name: '调用复盘助手', action: 'run_agent', params: { agentId: 'review_assistant', input: {} } }],
})
await workflowEngine.setStatus('wf-run-review-agent', 'active')
const agentWfRun = await workflowEngine.triggerManual('wf-run-review-agent')
const agentRunsAfter = await db.agentRuns.count()
assert('F1. run_agent 执行且 Agent 运行被记录',
  agentWfRun.ok && agentWfRun.value.status === 'completed' && agentRunsAfter === agentRunsBefore + 1)

// ====== G. 重试 / 错误 / 日志 ======
console.log('— 重试与错误 —')

await workflowEngine.register({
  id: 'wf-retry-continue',
  name: '重试但继续',
  trigger: { type: 'manual' },
  steps: [
    { id: 's1', name: '更新不存在对象', action: 'update_object', continueOnError: true, retry: { maxAttempts: 3, backoffMs: 5 }, params: { objectType: 'task', objectId: 'ghost', patch: { status: 'done' } } },
    { id: 's2', name: '后续通知', action: 'send_notification', params: { title: '仍然继续', message: '' } },
  ],
})
await workflowEngine.setStatus('wf-retry-continue', 'active')
const retryRun = await workflowEngine.triggerManual('wf-retry-continue')
assert('G1. continueOnError 时最终完成', retryRun.ok && retryRun.value.status === 'completed')
const s1log = retryRun.value!.logs.find(l => l.stepId === 's1')!
assert('G2. 失败步骤重试 3 次并记录错误', s1log.attempts === 3 && s1log.status === 'failed' && !!s1log.error)
assert('G3. 后续步骤仍执行', retryRun.value!.logs.find(l => l.stepId === 's2')?.status === 'success')

await workflowEngine.register({
  id: 'wf-fatal',
  name: '致命失败',
  trigger: { type: 'manual' },
  steps: [
    { id: 's1', name: '必然失败', action: 'delete_object', requireApproval: false, params: { objectType: 'task', objectId: 'ghost', confirm: true } },
  ],
})
await workflowEngine.setStatus('wf-fatal', 'active')
// delete_object 强制审批 → 先批准再执行才会失败于 ghost
const fatalManual = await workflowEngine.triggerManual('wf-fatal')
assert('G4. delete_object 强制进入审批（即使 requireApproval:false）',
  fatalManual.ok && fatalManual.value.status === 'awaiting_approval')
const fatalApproval = (await workflowEngine.getWorkflowApprovals('pending'))
  .find(a => a.workflowId === 'wf-fatal')!
await workflowEngine.reject(fatalApproval.id, '测试拒绝')
const fatalRunAfterReject = (await workflowEngine.getRuns('wf-fatal'))[0]
assert('G5. 拒绝后运行为 cancelled 且记录原因',
  fatalRunAfterReject.status === 'cancelled' && !!fatalRunAfterReject.error)

// ====== H. 高风险 L3 门控全流程 ======
console.log('— 高风险 L3 —')

let executedExternalCalls = 0
await workflowEngine.register({
  id: 'wf-l3-flow',
  name: '外呼流程',
  trigger: { type: 'manual' },
  steps: [
    { id: 's1', name: '外部 Mock 调用', action: 'external_mock', params: { endpoint: 'mock://crm/contact' } },
    { id: 's2', name: '成功通知', action: 'send_notification', params: { title: '外呼完成', message: '' } },
  ],
})
await workflowEngine.setStatus('wf-l3-flow', 'active')
const l3Run = await workflowEngine.triggerManual('wf-l3-flow')
assert('H1. external_mock 使运行挂起等待审批',
  l3Run.ok && l3Run.value.status === 'awaiting_approval' &&
  l3Run.value.logs[0].status === 'awaiting_approval')

const l3Approval = (await workflowEngine.getWorkflowApprovals('pending'))
  .find(a => a.workflowId === 'wf-l3-flow')!
const notifCountMid = await db.notifications.count()

const l3Approved = await workflowEngine.approve(l3Approval.id)
assert('H2. 批准仅改状态，未执行、未恢复后续',
  l3Approved.ok && l3Approved.value.status === 'approved' && !l3Approved.value.executedAt &&
  (await db.notifications.count()) === notifCountMid)

const noToken = await workflowEngine.executeApproved(l3Approval.id)
assert('H3. 缺 humanToken 拒绝执行', noToken.ok === false)

const withToken = await workflowEngine.executeApproved(l3Approval.id, 'human-confirmed')
const l3FinalRun = (await workflowEngine.getRuns('wf-l3-flow'))[0]
assert('H4. Human 显式执行后：Mock 生效、后续步骤恢复、运行完成',
  withToken.ok && (withToken.value.executionResult as any)?.mock === true &&
  l3FinalRun.status === 'completed' &&
  l3FinalRun.logs.every(l => l.status === 'success') &&
  (await db.notifications.count()) === notifCountMid + 1)

// ====== I. Create Object 自动执行（非高风险）======
console.log('— Create Object 自动执行 —')

await workflowEngine.register({
  id: 'wf-create-task',
  name: '自动建任务',
  trigger: { type: 'manual' },
  steps: [{ id: 's1', name: '建任务', action: 'create_object', params: { objectType: 'task', data: { title: '自动化创建的任务' } } }],
})
await workflowEngine.setStatus('wf-create-task', 'active')
const createRun = await workflowEngine.triggerManual('wf-create-task')
const autoTask = await db.tasks.filter(t => t.title === '自动化创建的任务').toArray()
assert('I1. create_object 直接自动执行，无需审批',
  createRun.ok && createRun.value.status === 'completed' && autoTask.length === 1)

// ====== J. Time 触发 ======
console.log('— Time 触发 —')

await workflowEngine.register({
  id: 'wf-tick',
  name: '定时心跳',
  trigger: { type: 'time', intervalMinutes: 60 },
  steps: [{ id: 's1', name: '心跳通知', action: 'send_notification', params: { title: 'tick', message: '' } }],
})
await workflowEngine.setStatus('wf-tick', 'active')

await workflowEngine.tick()
const tickRuns1 = await workflowEngine.getRuns('wf-tick')
assert('J1. 首次 tick 到期即运行', tickRuns1.length === 1 && tickRuns1[0].status === 'completed')

await workflowEngine.tick()
assert('J2. 间隔内重复 tick 不重复运行', (await workflowEngine.getRuns('wf-tick')).length === 1)

const wfRow = await db.workflows.get('wf-tick')
await db.workflows.put({ ...wfRow!, lastRunAt: new Date(Date.now() - 3600000).toISOString() })
await workflowEngine.tick()
assert('J3. 超过间隔后再次到期', (await workflowEngine.getRuns('wf-tick')).length === 2)

// ====== K. 版本快照与审计 ======
console.log('— 审计 —')

const allRuns = await workflowEngine.getAllRuns(50)
assert('K1. 所有运行记录持久化且带版本快照',
  allRuns.length >= 8 && allRuns.every(r => typeof r.workflowVersion === 'number' && r.workflowVersion >= 1))

const wfTick = await db.workflows.get('wf-tick')
assert('K2. runCount 与 lastRunAt 已累计',
  (wfTick?.runCount ?? 0) === 2 && !!wfTick?.lastRunAt)

console.log(`\n📊 结果: ${pass} 通过, ${fail} 失败\n`)
process.exit(fail > 0 ? 1 : 0)
