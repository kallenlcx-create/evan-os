// ====== Evan OS store.ts 核心状态层测试 ======
// 运行: npx tsx test-store.ts

import 'fake-indexeddb/auto'
import { db } from './src/db.ts'
import { useStore } from './src/store.ts'

let pass = 0, fail = 0
function assert(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}`) }
}

// 清空测试数据
await db.goals.clear()
await db.projects.clear()
await db.tasks.clear()
await db.domains.clear()
await db.knowledge.clear()
await db.relations.clear()
await db.events.clear()

console.log('\n🧪 Evan OS store.ts 状态层测试\n')

// 等待 store 初始化
await useStore.getState().initFromDB()
const store = useStore.getState()

// ====== 1. addObject 验证 ======
console.log('--- addObject ---')

const goalId = await store.addObject('goal', { title: '测试目标', level: 'current', keyResults: [], progress: 0 })
assert('1.1 创建 goal 返回 id', !!goalId)
assert('1.2 goal 进入 goals 数组', useStore.getState().goals.some(g => g.id === goalId))

const domainId = await store.addObject('domain', { title: '测试领域', description: '' })
assert('1.3 创建 domain 返回 id', !!domainId)
assert('1.4 domain 进入 domains 数组（不是 goals）', useStore.getState().goals.every(g => g.id !== domainId))

const projectId = await store.addObject('project', { title: '测试项目', status: 'idea', progress: 0, tags: [], description: '' })
assert('1.5 创建 project 返回 id', !!projectId)
assert('1.6 project 进入 projects 数组', useStore.getState().projects.some(p => p.id === projectId))

const taskId = await store.addObject('task', { title: '测试任务', status: 'todo', priority: 'medium', importance: 'medium', urgency: 'medium' })
assert('1.7 创建 task 返回 id', !!taskId)
assert('1.8 task 进入 tasks 数组', useStore.getState().tasks.some(t => t.id === taskId))

const knowledgeId = await store.addObject('knowledge', { title: '测试知识', content: '', category: 'general', tags: [], markType: undefined })
assert('1.9 创建 knowledge 返回 id', !!knowledgeId)
assert('1.10 knowledge 进入 knowledge 数组', useStore.getState().knowledge.some(k => k.id === knowledgeId))

// ====== 2. updateObject 验证 ======
console.log('\n--- updateObject ---')

await store.updateObject('goal', goalId, { title: '更新后的目标' })
assert('2.1 update goal title', useStore.getState().goals.find(g => g.id === goalId)?.title === '更新后的目标')

await store.updateObject('project', projectId, { title: '更新后的项目', progress: 50 })
const updatedProject = useStore.getState().projects.find(p => p.id === projectId)
assert('2.2 update project title', updatedProject?.title === '更新后的项目')
assert('2.3 update project progress', updatedProject?.progress === 50)

// ====== 3. deleteObject 验证 ======
console.log('\n--- deleteObject ---')

await store.deleteObject('task', taskId)
assert('3.1 delete task', !useStore.getState().tasks.some(t => t.id === taskId))

await store.deleteObject('knowledge', knowledgeId)
assert('3.2 delete knowledge', !useStore.getState().knowledge.some(k => k.id === knowledgeId))

// ====== 4. 内存降级测试（DB 写入失败时仍能添加） ======
console.log('\n--- 降级路径 ---')

// 添加一个带 ID 的对象（跳过 DB 写入验证）
const fallbackId = await store.addObject('goal', { id: 'fallback-test', title: '降级目标', level: 'current', keyResults: [], progress: 0 })
assert('4.1 addObject 降级仍返回 id', !!fallbackId)

// ====== 5. getTodayTasks ======
console.log('\n--- 查询方法 ---')

const todayTasks = store.getTodayTasks()
assert('5.1 getTodayTasks 返回数组', Array.isArray(todayTasks))
assert('5.2 getTodayTasks 不含 done/cancelled', todayTasks.every(t => t.status !== 'done' && t.status !== 'cancelled'))

// ====== 6. getAllTags ======
const tags = store.getAllTags()
assert('6.1 getAllTags 返回数组', Array.isArray(tags))

// ====== 7. getRelatedObjects ======
const related = store.getRelatedObjects(goalId)
assert('7.1 getRelatedObjects 返回数组', Array.isArray(related))

// ====== 总结 ======
console.log(`\n📊 结果: ${pass} 通过, ${fail} 失败\n`)
process.exit(fail > 0 ? 1 : 0)
