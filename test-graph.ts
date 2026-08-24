// ====== Evan OS v0.3 知识图谱测试 ======
// 图谱数据实时生成自 Relation 表、N 度邻域、最短路径、力导向布局
// 运行: npx tsx test-graph.ts

import 'fake-indexeddb/auto'
import { db } from './src/db.ts'
import { createRelation } from './src/repositories/relationRepository.ts'
import { createProject } from './src/repositories/projectRepository.ts'
import { createTask } from './src/repositories/taskRepository.ts'
import { createKnowledge } from './src/repositories/knowledgeRepository.ts'
import { deleteObject } from './src/repositories/objectRepository.ts'
import {
  relationQueryService,
  type GraphData,
} from './src/services/relationQueryService.ts'
import { applyForceLayout } from './src/components/KnowledgeGraph.tsx'

let pass = 0, fail = 0
function assert(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`) }
  else { fail++; console.log(`  [FAIL] ${name}`) }
}

console.log('\n🧪 Evan OS v0.3 知识图谱测试\n')

// 清空并构建拓扑:
//   task1 → proj1 (belongs_to)
//   k1 ← references ← k2 ← references ← k3   (k1-k2-k3 链)
//   k1 ← uses ← proj1                        (跨类型)
await Promise.all([
  db.projects.clear(), db.tasks.clear(), db.knowledge.clear(), db.relations.clear(),
])
const proj1 = (await createProject({ title: '图谱项目' })).value!
const task1 = (await createTask({ title: '图谱任务' })).value!
const k1 = (await createKnowledge({ title: '知识一' })).value!
const k2 = (await createKnowledge({ title: '知识二' })).value!
const k3 = (await createKnowledge({ title: '知识三' })).value!

await createRelation('task', task1.id, 'project', proj1.id, 'belongs_to')
await createRelation('knowledge', k2.id, 'knowledge', k1.id, 'references')
await createRelation('knowledge', k3.id, 'knowledge', k2.id, 'references')
await createRelation('project', proj1.id, 'knowledge', k1.id, 'references')

relationQueryService.invalidate()

// ====== A. N 度邻域 ======
console.log('— Neighborhood —')

const g1 = await relationQueryService.getNeighborhood('knowledge', k1.id, 1)
assert('A1. 1度邻域包含中心+直接邻居',
  g1.nodes.some(n => n.id === k1.id) && g1.nodes.some(n => n.id === k2.id) &&
  g1.nodes.some(n => n.id === proj1.id))
assert('A2. 1度邻域不含 2 度节点', !g1.nodes.some(n => n.id === k3.id))
assert('A3. 边端点均为 Relation 真实记录',
  g1.edges.every(e => e.id && e.source && e.target))

const g2 = await relationQueryService.getNeighborhood('knowledge', k1.id, 2)
assert('A4. 2度邻域扩展到 k3 与 task1',
  g2.nodes.some(n => n.id === k3.id) && g2.nodes.some(n => n.id === task1.id))

const k1NodeG2 = g2.nodes.find(n => n.id === k1.id)!
assert('A5. 度数计算正确（k1 连接 k2/proj1）', k1NodeG2.degree === 2)

// ====== B. 最短路径 ======
console.log('— ShortestPath —')

const path = await relationQueryService.getShortestPath('knowledge', k3.id, 'knowledge', k1.id)
assert('B1. k3→k1 存在路径且长度为 2', !!path && path.length === 2)
assert('B2. 路径节点顺序正确',
  !!path && path.nodes[0]?.id === k3.id && path.nodes[2]?.id === k1.id)

const samePath = await relationQueryService.getShortestPath('knowledge', k1.id, 'knowledge', k1.id)
assert('B3. 同一对象路径长度 0', !!samePath && samePath.length === 0)

const orphanProj = await createProject({ title: '孤立项目' })
if (!orphanProj.ok || !orphanProj.value) throw new Error('setup failed')
const noPath = await relationQueryService.getShortestPath('project', orphanProj.value.id, 'knowledge', k1.id)
assert('B4. 不连通时返回 null', noPath === null)

// ====== C. 知识图谱子图 ======
console.log('— KnowledgeGraph —')

const kgCentered = await relationQueryService.getKnowledgeGraph(k1.id, 1)
assert('C1. 指定 ID 时等价于邻域查询',
  kgCentered.nodes.some(n => n.id === k1.id) && !kgCentered.nodes.some(n => n.id === k3.id))

const kgAll = await relationQueryService.getKnowledgeGraph()
const knowledgeIds = new Set([k1.id, k2.id, k3.id])
assert('C2. 全局知识图节点全为知识', kgAll.nodes.every(n => n.type === 'knowledge' && knowledgeIds.has(n.id)))
assert('C3. 只保留知识↔知识边（排除 project→k1）',
  kgAll.edges.length === 2 && kgAll.edges.every(e =>
    knowledgeIds.has(e.source) && knowledgeIds.has(e.target)))

// ====== D. 全局图谱 & 实时性（无第二套数据库）======
console.log('— GlobalGraph & Live —')

const gg = await relationQueryService.getGlobalGraph()
assert('D1. 全局图节点 = 关系端点全集（5 个）', gg.nodes.length === 5)
assert('D2. 全局图保留全部 4 条边', gg.edges.length === 4)

// 实时性验证：新增关系 → invalidate → 图谱立即反映
const k4 = (await createKnowledge({ title: '知识四' })).value!
const newRel = await createRelation('knowledge', k4.id, 'knowledge', k3.id, 'references')
relationQueryService.invalidate()
const ggAfterAdd = await relationQueryService.getGlobalGraph()
assert('D3. 新增关系后图谱实时更新（无第二套数据库）',
  newRel.ok && ggAfterAdd.nodes.length === 6 &&
  ggAfterAdd.edges.some(e => e.source === k4.id))

// 删除关系 → 图谱同步收缩
await db.relations.delete(newRel.value.id)
await deleteObject('knowledge', k4.id)
relationQueryService.invalidate()
const ggAfterDel = await relationQueryService.getGlobalGraph()
assert('D4. 删除关系后图谱同步收缩', ggAfterDel.nodes.length === 5 && ggAfterDel.edges.length === 4)

// ====== E. 统计 ======
console.log('— Stats —')

const stats = await relationQueryService.getRelationTypeStats()
const refStat = stats.find(s => s.type === 'references')
const belongsStat = stats.find(s => s.type === 'belongs_to')
assert('E1. 关系类型统计正确', refStat?.count === 3 && belongsStat?.count === 1)
assert('E2. 统计按数量降序排列',
  stats.length >= 2 && stats[0].count >= stats[1].count)

// ====== F. 力导向布局 ======
console.log('— ForceLayout —')

const layoutInput: GraphData = {
  nodes: [
    { id: k1.id, type: 'knowledge', title: 'a', emoji: 'x', degree: 2 },
    { id: k2.id, type: 'knowledge', title: 'b', emoji: 'x', degree: 1 },
    { id: proj1.id, type: 'project', title: 'c', emoji: 'x', degree: 1 },
  ],
  edges: [
    { id: 'e1', source: k1.id, target: k2.id, relationType: 'references', label: 'references', direction: 'bidirectional' },
    { id: 'e2', source: proj1.id, target: k1.id, relationType: 'references', label: 'references', direction: 'bidirectional' },
  ],
}
const W = 800, H = 500
const laidOut = applyForceLayout(layoutInput, W, H)
assert('F1. 所有节点坐标有限（无 NaN/Infinity）',
  laidOut.every(n => Number.isFinite(n.x) && Number.isFinite(n.y)))
assert('F2. 坐标在画布边界内',
  laidOut.every(n => n.x >= 40 && n.x <= W - 40 && n.y >= 40 && n.y <= H - 40))
assert('F3. 相连节点不重叠（间距 > 30px）',
  (() => {
    for (const edge of layoutInput.edges) {
      const s = laidOut.find(n => n.id === edge.source)!
      const t = laidOut.find(n => n.id === edge.target)!
      const d = Math.hypot(s.x - t.x, s.y - t.y)
      if (d < 30) return false
    }
    return true
  })())

console.log(`\n📊 结果: ${pass} 通过, ${fail} 失败\n`)
process.exit(fail > 0 ? 1 : 0)
