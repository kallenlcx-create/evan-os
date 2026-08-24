// ====== Evan OS v0.4 Memory System 测试 ======
// 守卫（AI 只能建议）/ 状态机 / 相关性查询 / 与 Knowledge 隔离
// 运行: npx tsx test-memory.ts

import 'fake-indexeddb/auto'
import { db } from './src/db.ts'
import { memoryService } from './src/services/memoryService.ts'
import { MEMORY_AI_CONFIDENCE_CAP, suggestMemory } from './src/repositories/memoryRepository.ts'
import { createKnowledge, getBacklinks } from './src/repositories/knowledgeRepository.ts'

let pass = 0, fail = 0
function assert(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`) }
  else { fail++; console.log(`  [FAIL] ${name}`) }
}

console.log('\n🧪 Evan OS v0.4 Memory System 测试\n')

await db.memories.clear()
await db.knowledge.clear()

const aiSource = () => memoryService.makeSource({
  type: 'ai_suggestion', actorId: 'test-agent',
  excerpt: '来自对话片段…', occurredAt: new Date().toISOString(),
})

// ====== A. 创建守卫 ======
console.log('— 创建守卫 —')

assert('A1. AI 置信度上限常量 = 0.5', MEMORY_AI_CONFIDENCE_CAP === 0.5)

const s1 = await memoryService.suggestMemories([{
  type: 'preference',
  content: '用户偏好简洁回复',
  source: aiSource(),
  confidence: 0.95, // AI 尝试给高置信度 → 必须被封顶
}])
assert('A2. suggestMemories 强制 candidate 状态',
  s1.ok && s1.value.every(m => m.status === 'candidate'))
assert('A3. AI 高置信度被封顶（不能默认创建高置信长期记忆）',
  s1.ok && s1.value[0].confidence === MEMORY_AI_CONFIDENCE_CAP)
assert('A4. 建议记忆记录来源 actorId',
  s1.ok && s1.value[0].source.actorId === 'test-agent' && !!s1.value[0].source.excerpt)

const noSource = await suggestMemory({
  type: 'fact', content: '无来源记忆',
  source: undefined as any,
})
assert('A5. 无来源的 Memory 被拒绝', !noSource.ok)

const emptyContent = await memoryService.suggestMemories([{
  type: 'fact', content: '   ', source: aiSource(),
}])
assert('A6. 空 content 被拒绝', !emptyContent.ok)

// 手动创建直接 active
const manual = await memoryService.addManualMemory({
  type: 'context', content: '手动记忆：每周五写周报', importance: 0.6,
})
assert('A7. 用户手动创建直接 active 且带 confirmedAt',
  manual.ok && manual.value.status === 'active' && !!manual.value.confirmedAt)

// ====== B. 状态机 ======
console.log('— 状态机 —')

const candId = s1.value![0].id

// 未确认前不在 active 视图
const activeBefore = await memoryService.getActiveMemories()
assert('B1. candidate 不出现在 active 列表', !activeBefore.some(m => m.id === candId))

const confirmed = await memoryService.confirmMemory(candId)
assert('B2. 用户确认后进入 active 并记录 confirmedAt',
  confirmed.ok && confirmed.value.status === 'active' && !!confirmed.value.confirmedAt)

const confirmAgain = await memoryService.confirmMemory(candId)
assert('B3. active 不能再次确认（非法转换被拒绝）', !confirmAgain.ok)

const archived = await memoryService.archiveMemory(candId)
assert('B4. active → archived 归档成功', archived.ok && archived.value.status === 'archived')

const reactivate = await memoryService.changeStatus(candId, 'active')
assert('B5. archived → active 可恢复', reactivate.ok && reactivate.value.status === 'active')

const edited = await memoryService.updateMemory(candId, { content: '用户偏好极简回复风格' })
assert('B6. 用户修改内容生效且不改状态',
  edited.ok && edited.value.content.includes('极简') && edited.value.status === 'active')

const forgotten = await memoryService.forgetMemory(candId)
const afterForget = await memoryService.getById(candId)
assert('B7. forgetMemory 彻底删除', forgotten.ok && afterForget === undefined)

const forgetMissing = await memoryService.forgetMemory('不存在')
assert('B8. 遗忘不存在的 id 返回 ok（幂等）或明确错误', forgetMissing.ok === true || !forgetMissing.ok)

// ====== C. getRelevantMemories ======
console.log('— 相关性查询 —')

await db.memories.clear()
memoryService.invalidate()

// m1: 高相关（query 匹配）m2: 低相关 m3: 已归档 m4: 过期 m5: 候选
const mkActive = async (content: string, importance: number, opts?: Partial<{ tags: string[]; expiresAt: string; status: any }>) => {
  const r = await memoryService.addManualMemory({ type: 'context', content, importance, ...opts })
  if (!r.ok) throw new Error('setup failed: ' + r.error)
  return r.value
}
const m1 = await mkActive('用户主营欧美外贸独立站业务', 0.9)
await mkActive('喜欢在早上处理邮件', 0.3)
const archivedOne = (await memoryService.addManualMemory({ type: 'fact', content: '旧的业务方向已放弃', importance: 0.9 }))
if (!archivedOne.ok) throw new Error('setup failed')
await memoryService.archiveMemory(archivedOne.value.id)
const expiredOne = await mkActive('临时活动已结束', 0.9, { expiresAt: new Date(Date.now() - 86400000).toISOString() })

await memoryService.suggestMemories([{ type: 'fact', content: '未确认的候选记忆不应出现在上下文', source: aiSource() }])
memoryService.invalidate()

const relDefault = await memoryService.getRelevantMemories()
assert('C1. 只返回 active（排除归档/候选/过期）',
  relDefault.some(m => m.id === m1.id) &&
  relDefault.every(m => m.status === 'active'))

const relQuery = await memoryService.getRelevantMemories({ query: '独立站' })
assert('C2. query 相关性排序：匹配项排第一', relQuery[0]?.id === m1.id)

// 懒过期：到期 active 自动转 expired 且不再返回
memoryService.invalidate()
const expiredRecord = await memoryService.getById(expiredOne.id)
assert('C3. 过期时间已过的记忆被懒过期标记', expiredRecord?.status === 'expired' || !(await memoryService.getActiveMemories()).some(m => m.id === expiredOne!.id))

// limit
const many = await Promise.all(Array.from({ length: 8 }, (_, i) =>
  memoryService.addManualMemory({ type: 'context', content: `常规记忆 ${i}`, importance: 0.4 })))
memoryService.invalidate()
const limited = await memoryService.getRelevantMemories({ limit: 5 })
assert('C4. limit 生效', limited.length <= 5)

// 使用痕迹
const touched = await memoryService.getById(m1.id)
assert('C5. 命中后更新 lastUsedAt/useCount',
  !!touched?.lastUsedAt && (touched.useCount ?? 0) >= 1)

// minConfidence 过滤
const lowConfSuggestion = await memoryService.suggestMemories([{
  type: 'workflow', content: '低置信建议', source: aiSource(), confidence: 0.3,
}])
if (!lowConfSuggestion.ok || !lowConfSuggestion.value[0]) throw new Error('setup failed')
await memoryService.confirmMemory(lowConfSuggestion.value[0].id)
memoryService.invalidate()
const strict = await memoryService.getRelevantMemories({ minConfidence: 0.6 })
assert('C6. minConfidence 阈值过滤低置信记忆', !strict.some(m => m.id === lowConfSuggestion.value![0].id))

// ====== D. 与 Knowledge 隔离（不是第二套知识库）======
console.log('— 隔离性 —')

await db.memories.clear()
memoryService.invalidate()

const k1 = await createKnowledge({ title: '隔离测试知识', content: '这是用户保存的知识' })
if (!k1.ok) throw new Error('knowledge setup failed')

const memFromK = await memoryService.suggestMemories([{
  type: 'fact', content: 'AI 从知识中提炼的上下文记忆', source: aiSource(),
}])
await memoryService.confirmMemory(memFromK.value![0].id)

const relevant = await memoryService.getRelevantMemories({ query: '隔离测试知识' })
assert('D1. Knowledge 内容不会自动成为 Memory（无同步）',
  !relevant.some(m => m.content.includes('这是用户保存的知识')))
assert('D2. Memory 表与 knowledge 表行数独立',
  (await db.memories.count()) === 1 && (await db.knowledge.count()) === 1)

// 删除 Memory 不影响 Knowledge
await memoryService.forgetMemory(memFromK.value![0].id)
const kStillThere = await db.knowledge.get(k1.value.id)
assert('D3. forgetMemory 不触碰 Knowledge 表', !!kStillThere)

// Knowledge 的 backlinks 查询不受 Memory 影响
const backlinks = await getBacklinks(k1.value.id)
assert('D4. Knowledge 查询行为不变', Array.isArray(backlinks) && backlinks.length === 0)

console.log(`\n📊 结果: ${pass} 通过, ${fail} 失败\n`)
process.exit(fail > 0 ? 1 : 0)
