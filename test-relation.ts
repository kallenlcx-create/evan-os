// ====== Evan OS v0.3 Relation 数据层测试 ======
// 关系 CRUD、方向查询、便捷查询、元数据
// 运行: npx tsx test-relation.ts

import 'fake-indexeddb/auto'
import { db } from './src/db.ts'
import {
  createRelation, deleteRelation,
  getOutgoingRelations, getIncomingRelations, getAllRelations,
  getTasksForProject, getKnowledgeBacklinks,
} from './src/repositories/relationRepository.ts'
import { createProject } from './src/repositories/projectRepository.ts'
import { createTask } from './src/repositories/taskRepository.ts'
import { createKnowledge } from './src/repositories/knowledgeRepository.ts'

let pass = 0, fail = 0
function assert(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`) }
  else { fail++; console.log(`  [FAIL] ${name}`) }
}

console.log('\n🧪 Evan OS v0.3 Relation 数据层测试\n')

// 清空
await Promise.all([
  db.projects.clear(), db.tasks.clear(), db.knowledge.clear(), db.relations.clear(),
])

// 准备数据
const proj = (await createProject({ title: '关系测试项目' })).value!
const task1 = (await createTask({ title: '任务一' })).value!
const task2 = (await createTask({ title: '任务二' })).value!
const kA = (await createKnowledge({ title: '知识A', content: '' })).value!
const kB = (await createKnowledge({ title: '知识B', content: '' })).value!

// ====== A. 创建与校验 ======
console.log('— 创建 —')

const r1 = await createRelation('task', task1.id, 'project', proj.id, 'belongs_to')
assert('A1. 创建 belongs_to 关系', r1.ok && r1.value.relationType === 'belongs_to')
assert('A2. 记录字段完整（createdBy/source/时间戳）',
  r1.value.createdBy === 'user' && r1.value.source === 'manual' &&
  !!r1.value.createdAt && !!r1.value.updatedAt)

const selfRef = await createRelation('task', task1.id, 'project', task1.id, 'related_to')
assert('A3. 自引用被拒绝', !selfRef.ok)

const emptyRef = await createRelation('task', '', 'project', proj.id, 'related_to')
assert('A4. 空 sourceId 被拒绝', !emptyRef.ok)

const withMeta = await createRelation('knowledge', kB.id, 'knowledge', kA.id, 'references', {
  metadata: { note: '延伸阅读' }, createdBy: 'agent', source: 'ai', confidence: 0.9,
})
assert('A5. metadata/createdBy/confidence 持久化',
  withMeta.ok && withMeta.value.metadata?.note === '延伸阅读' &&
  withMeta.value.createdBy === 'agent' && withMeta.value.confidence === 0.9)

// ====== B. 方向查询 ======
console.log('— 方向查询 —')

await createRelation('task', task2.id, 'project', proj.id, 'belongs_to')

const outgoing = await getOutgoingRelations('task', task1.id)
assert('B1. getOutgoing 只返回作为 source 的关系',
  outgoing.length === 1 && outgoing[0].sourceId === task1.id)

const incomingProj = await getIncomingRelations('project', proj.id)
assert('B2. getIncoming 返回两个任务的 belongs_to',
  incomingProj.length === 2 && incomingProj.every(r => r.targetId === proj.id))

const both = await getAllRelations('knowledge', kA.id)
assert('B3. getAllRelations 双向聚合',
  both.outgoing.length === 0 && both.incoming.length === 1)

const noRel = await getAllRelations('goal', '不存在id')
assert('B4. 无关系时返回空数组', noRel.outgoing.length === 0 && noRel.incoming.length === 0)

// ====== C. 便捷查询 ======
console.log('— 便捷查询 —')

const projTasks = await getTasksForProject(proj.id)
assert('C1. getTasksForProject 按 belongs_to 过滤', projTasks.length === 2)

const backlinks = await getKnowledgeBacklinks(kA.id)
assert('C2. getKnowledgeBacklinks 按 references 过滤',
  backlinks.length === 1 && backlinks[0].sourceId === kB.id)

const wrongTypeBacklinks = await db.relations
  .where('[targetType+targetId]').equals(['knowledge', kA.id])
  .and(r => r.relationType === 'belongs_to').toArray()
assert('C3. 关系类型不匹配时不误报', wrongTypeBacklinks.length === 0)

// ====== D. 删除 ======
console.log('— 删除 —')

const before = await db.relations.count()
const del = await deleteRelation(r1.value.id)
const after = await db.relations.count()
assert('D1. 删除后总数减一', del.ok && after === before - 1)

const goneFromOutgoing = await getOutgoingRelations('task', task1.id)
assert('D2. 删除后方向查询为空', goneFromOutgoing.length === 0)

const delAgain = await deleteRelation(r1.value.id)
assert('D3. 重复删除不报错（幂等）', delAgain.ok)

const relCountAfterDel = await db.relations.where('relationType').equals('belongs_to').count()
assert('D4. 其余关系不受影响', relCountAfterDel === 1)

console.log(`\n📊 结果: ${pass} 通过, ${fail} 失败\n`)
process.exit(fail > 0 ? 1 : 0)
