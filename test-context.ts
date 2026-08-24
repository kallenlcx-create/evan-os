// ====== Evan OS v0.5 Context Engine 测试 ======
// 收集/过滤/排序/压缩/组装、tokenBudget、焦点相关度、禁止全库注入、Provider 解耦
// 运行: npx tsx test-context.ts

import 'fake-indexeddb/auto'
import { db } from './src/db.ts'
import {
  contextEngine, estimateTokens, compressText,
} from './src/services/contextEngine.ts'
import { memoryService } from './src/services/memoryService.ts'
import { relationQueryService } from './src/services/relationQueryService.ts'
import { createProject } from './src/repositories/projectRepository.ts'
import { createTask } from './src/repositories/taskRepository.ts'
import { createKnowledge } from './src/repositories/knowledgeRepository.ts'
import { createObject } from './src/repositories/objectRepository.ts'
import type { Goal } from './src/types.ts'
import { createRelation } from './src/repositories/relationRepository.ts'

let pass = 0, fail = 0
function assert(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`) }
  else { fail++; console.log(`  [FAIL] ${name}`) }
}

console.log('\n🧪 Evan OS v0.5 Context Engine 测试\n')

await Promise.all([
  db.projects.clear(), db.tasks.clear(), db.knowledge.clear(),
  db.goals.clear(), db.relations.clear(), db.events.clear(), db.memories.clear(),
])
memoryService.invalidate()

// ====== A. 纯函数：token 估算 & 压缩 ======
console.log('— Token 估算 / 压缩 —')

assert('A1. 英文按 4 字符≈1 token', estimateTokens('abcdefgh') === 2)
assert('A2. 中文逐字估算', estimateTokens('四个汉字') === 4)
assert('A3. 估算单调递增', estimateTokens('短') < estimateTokens('这是一个比较长的中文句子'))
assert('A4. 压缩截断并带省略号', compressText('x'.repeat(300), 100).length === 101 && compressText('x'.repeat(300), 100).endsWith('…'))
assert('A5. 压缩规范化空白', compressText('a \n\t b', 100) === 'a b')

// ====== B. 数据准备 ======
const proj = (await createProject({ title: '上下文引擎项目', description: '用于验证 ContextEngine' })).value!
const task = (await createTask({ title: '编写引擎测试' })).value!
const k1 = (await createKnowledge({ title: '上下文工程笔记', content: '上下文窗口有限，需要预算控制' })).value!
const k2 = (await createKnowledge({ title: 'Token 计量', content: 'CJK 与拉丁字符成本不同' })).value!
const goal = await createObject<Goal>('goal', {
  title: '完成 v0.5 发布', level: '90_day', progress: 30,
} as Partial<Goal>)
if (!goal.ok || !proj || !task || !k1 || !k2) throw new Error('seed failed')

await createRelation('task', task.id, 'project', proj.id, 'belongs_to')
await createRelation('project', proj.id, 'knowledge', k1.id, 'references')
await createRelation('knowledge', k1.id, 'knowledge', k2.id, 'references')

// 一条 AI 建议 → 用户确认 → active
const sug = await memoryService.suggestMemories([{
  type: 'preference', content: '用户希望回复使用中文',
  source: memoryService.makeSource({ type: 'ai_suggestion' }),
}])
if (!sug.ok) throw new Error('memory seed failed')
await memoryService.confirmMemory(sug.value[0].id)
// 一条未确认候选（不得进入上下文）
await memoryService.suggestMemories([{
  type: 'fact', content: '未确认的敏感候选记忆XYZ', source: memoryService.makeSource({ type: 'ai_suggestion' }),
}])

console.log('— 收集与组装 —')

// ====== C. 基本组装 ======
const ctx = await contextEngine.build({
  user: { id: 'u1', name: 'Evan' },
  page: { path: '/inspector', label: 'Context Inspector' },
  currentObject: { type: 'project', id: proj.id },
  currentTaskId: task.id,
  query: '上下文',
  tokenBudget: 4000,
})

assert('C1. 输出为纯数据 AIContext（无模型调用字段）',
  typeof ctx.tokenBudget === 'number' && Array.isArray(ctx.items) &&
  !!ctx.createdAt && !!ctx.focus)

const types = new Set(ctx.items.map(i => i.type))
assert('C2. 收集到用户/页面/对象/任务/项目',
  types.has('user') && types.has('page') && types.has('object') &&
  types.has('task') && types.has('project'))

assert('C3. 关联知识来自 Relation 邻域',
  ctx.items.some(i => i.type === 'knowledge' && i.ref?.id === k1.id))

assert('C4. active 记忆进入上下文',
  ctx.items.some(i => i.type === 'memory' && i.content.includes('中文')))

assert('C5. 未确认 candidate 记忆绝不出现',
  !ctx.items.some(i => i.content.includes('未确认的敏感候选记忆XYZ')))

assert('C6. 每个条目都有 source/priority/relevance/tokenEstimate',
  ctx.items.every(i =>
    !!i.source && i.priority >= 0 && i.priority <= 100 &&
    i.relevance >= 0 && i.relevance <= 1 && i.tokenEstimate > 0))

assert('C7. included 条目按 priority 降序排列',
  (() => {
    const prios = ctx.items.filter(i => i.included).map(i => i.priority)
    for (let j = 1; j < prios.length; j++) {
      if (prios[j] > prios[j - 1]) return false
    }
    return true
  })())

assert('C8. 焦点对象优先级最高', ctx.items.filter(i => i.included)[0]?.type === 'object')

// ====== D. 预算控制 ======
console.log('— Token 预算 —')

const tiny = await contextEngine.build({
  page: { path: '/inspector', label: 'Inspector' },
  currentObject: { type: 'project', id: proj.id },
  tokenBudget: 60,
})
assert('D1. 小预算下 tokensUsed ≤ budget', tiny.tokensUsed <= tiny.tokenBudget)
assert('D2. 小预算产生预算排除且高优先级存活',
  tiny.stats.excludedByBudget > 0 &&
  tiny.items.find(i => i.type === 'object')?.included === true)
assert('D3. 大预算无排除', ctx.stats.excludedByBudget === 0 && ctx.tokensUsed <= ctx.tokenBudget)
assert('D4. 预算越小包含越少', tiny.stats.included < ctx.stats.included)

// ====== E. 过滤与压缩 ======
console.log('— 过滤与压缩 —')

const longK = (await createKnowledge({ title: '超长知识', content: '长'.repeat(500) })).value!
await createRelation('project', proj!.id, 'knowledge', longK.id, 'references')
relationQueryService.invalidate()
const ctxLong = await contextEngine.build({
  currentObject: { type: 'project', id: proj!.id },
  includeMemories: false,
  includeGoals: false,
  tokenBudget: 4000,
})
const longItem = ctxLong.items.find(i => i.ref?.id === longK.id)
assert('E1. 长内容被压缩至上限', !!longItem && longItem.content.length <= 161)
// 同一 ref 允许两种类型条目（related_object + knowledge），验证均存在
const longRefs = ctxLong.items.filter(i => i.ref?.id === longK.id)
assert('E2. 关联对象与关联知识双通道呈现', longRefs.some(i => i.type === 'related_object') && longRefs.some(i => i.type === 'knowledge'))
assert('E3. 分类上限生效（related_object ≤ 6）',
  ctxLong.items.filter(i => i.type === 'related_object').length <= 6)

// ====== F. 禁止隐式全库注入 ======
console.log('— 无全库注入 —')

for (let i = 0; i < 15; i++) {
  await createKnowledge({ title: `无关知识文档编号${i}`, content: '与当前焦点完全无关的内容UNRELATED' })
}
const isolated = await contextEngine.build({
  page: { path: '/projects', label: '项目' },
  currentObject: { type: 'project', id: proj.id },
  includeMemories: false, includeGoals: false,
  recentEventsLimit: 3,
  tokenBudget: 6000,
})
assert('F1. 无关知识不会出现在上下文中',
  !isolated.items.some(i => i.title.includes('无关知识文档')))
assert('F2. 收集数量有界（远小于全库规模）',
  isolated.stats.collected < 40 &&
  (await db.knowledge.count()) >= 17)
assert('F3. 所有数据库访问均定向（事件条目 ≤ limit）',
  isolated.items.filter(i => i.type === 'event').length <= 3)

// ====== G. 解耦验证 ======
console.log('— Provider 解耦 —')

const serialized = JSON.parse(JSON.stringify(ctx))
assert('G1. AIContext 可完整 JSON 序列化（Provider 可消费）',
  serialized.items.length === ctx.items.length)
const prompt = contextEngine.renderPrompt(ctx)
assert('G2. renderPrompt 只输出文本，不含任何调用逻辑',
  typeof prompt === 'string' && prompt.includes('[项目]') && !prompt.includes('function'))

console.log(`\n📊 结果: ${pass} 通过, ${fail} 失败\n`)
process.exit(fail > 0 ? 1 : 0)
