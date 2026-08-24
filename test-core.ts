// ====== Evan OS v0.2 核心数据层测试 ======
// 运行: npx tsx test-core.ts

import 'fake-indexeddb/auto'
import { db } from './src/db.ts'
import { createObject, updateObject, deleteObject, getObject, getAllObjects } from './src/repositories/objectRepository.ts'
import { createRelation, getOutgoingRelations, getIncomingRelations, getTasksForProject, getKnowledgeBacklinks, deleteRelation } from './src/repositories/relationRepository.ts'
import { createTask, completeTask } from './src/repositories/taskRepository.ts'
import { createProject } from './src/repositories/projectRepository.ts'
import { createKnowledge, addReference, getBacklinks } from './src/repositories/knowledgeRepository.ts'
import { createCustomer, createOpportunity, createOrder, createCommunication } from './src/repositories/customerRepository.ts'
import { captureInbox, processInbox } from './src/repositories/inboxRepository.ts'
import { getTimeline } from './src/repositories/eventRepository.ts'

let pass = 0, fail = 0
function assert(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}`) }
}

// 清空测试数据
await db.goals.clear()
await db.projects.clear()
await db.tasks.clear()
await db.knowledge.clear()
await db.customers.clear()
await db.opportunities.clear()
await db.orders.clear()
await db.communications.clear()
await db.relations.clear()
await db.events.clear()
await db.inbox.clear()

console.log('\n🧪 Evan OS v0.2 核心数据层测试\n')

// 1. 创建 Project
const projResult = await createProject({ title: '测试项目', emoji: '🧪' })
assert('1. 创建 Project', projResult.ok && projResult.value.title === '测试项目')

// 2. 创建 Task
const taskResult = await createTask({ title: '测试任务', emoji: '✅' })
assert('2. 创建 Task', taskResult.ok && taskResult.value.title === '测试任务')

// 3. Project 与 Task 建立关系
const relResult = await createRelation('task', taskResult.value.id, 'project', projResult.value.id, 'belongs_to')
assert('3. Task→Project belongs_to 关系', relResult.ok)

// 4. 删除关系
const delRelResult = await deleteRelation(relResult.value.id)
assert('4. 删除关系', delRelResult.ok)

// 重新创建关系用于后续查询
await createRelation('task', taskResult.value.id, 'project', projResult.value.id, 'belongs_to')

// 5. 查询 Project Tasks
const projectTasks = await getTasksForProject(projResult.value.id)
assert('5. 查询 Project Tasks', projectTasks.length === 1)

// 6. 创建 Knowledge
const kResult = await createKnowledge({ title: 'React Hooks', content: 'useState use', category: 'frontend' })
assert('6. 创建 Knowledge', kResult.ok)

// 7. Knowledge 建立引用
const k2Result = await createKnowledge({ title: 'Custom Hooks', content: 'use custom', category: 'frontend' })
const refResult = await addReference(k2Result.value.id, kResult.value.id)
assert('7. Knowledge references 关系', refResult.ok)

// 8. 查询 backlinks
const backlinks = await getBacklinks(kResult.value.id)
assert('8. 查询 backlinks', backlinks.length === 1 && backlinks[0].title === 'Custom Hooks')

// 9. 创建 Customer
const custResult = await createCustomer({ title: '测试客户', company: 'Test Co', email: 'test@test.com', stage: 'lead' })
assert('9. 创建 Customer', custResult.ok && custResult.value.type === 'customer')

// 10. 创建 Opportunity
const oppResult = await createOpportunity({ title: '测试商机', value: 10000, customerId: custResult.value.id })
assert('10. 创建 Opportunity', oppResult.ok)

// 11. Customer 与 Opportunity 建立关系
const custOppRels = await getIncomingRelations('customer', custResult.value.id)
assert('11. Customer←Opportunity 关系', custOppRels.length >= 1)

// 12. 创建 Order
const orderResult = await createOrder({ title: '测试订单', orderNumber: 'ORD-001', amount: 5000, customerId: custResult.value.id })
assert('12. 创建 Order', orderResult.ok && orderResult.value.type === 'order')

// 13. Event 是否产生
const events = await getTimeline('project', projResult.value.id)
assert('13. Event 产生', events.length >= 1)

// 14. 数据持久化（读回验证）
const reloaded = await getObject('project', projResult.value.id)
assert('14. 数据持久化', !!reloaded && reloaded.title === '测试项目')

// 15. Customer 不在 goals 表
const goalsCount = await db.goals.count()
const customersCount = await db.customers.count()
assert('15. Customer 不在 goals 表', customersCount > 0 && goalsCount === 0)

// 16. Inbox
const inboxResult = await captureInbox('测试收集内容', 'quick_note')
assert('16. Inbox 收集', inboxResult.ok)

console.log(`\n📊 结果: ${pass} 通过, ${fail} 失败\n`)
process.exit(fail > 0 ? 1 : 0)
