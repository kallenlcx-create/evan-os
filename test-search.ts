// ====== Evan OS v0.3 统一搜索服务测试 ======
// SearchIndex + SearchService：精确/模糊/前缀匹配、过滤器、范围、排序、最近使用
// 运行: npx tsx test-search.ts

import 'fake-indexeddb/auto'
import { db } from './src/db.ts'
import { tokenize, bigrams, SearchIndex } from './src/services/searchIndex.ts'
import { searchService } from './src/services/searchService.ts'
import type { AnyObject } from './src/types.ts'

let pass = 0, fail = 0
function assert(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`) }
  else { fail++; console.log(`  [FAIL] ${name}`) }
}

async function seedObject(obj: Partial<AnyObject> & { id: string; type: AnyObject['type']; title: string }) {
  await (db as any)[{
    goal: 'goals', project: 'projects', task: 'tasks', knowledge: 'knowledge',
    inspiration: 'inspirations', question: 'questions', research: 'research',
    experiment: 'experiments', decision: 'decisions', review: 'reviews', process: 'processes',
  }[obj.type]!].put({
    description: '', tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    status: 'done', ...obj,
  })
}

console.log('\n🧪 Evan OS v0.3 统一搜索服务测试\n')

// ====== A. SearchIndex 纯逻辑 ======
console.log('— SearchIndex —')

assert('A1. tokenize 英文分词', JSON.stringify(tokenize('Hello World 123')) === JSON.stringify(['hello', 'world', '123']))
assert('A2. tokenize 中文逐字分词', JSON.stringify(tokenize('知识图谱')) === JSON.stringify(['知', '识', '图', '谱']))
assert('A3. bigrams 中文二元组', bigrams('知识图谱').includes('知识') && bigrams('知识图谱').includes('图谱'))

const idx = new SearchIndex()
idx.add({ id: 'k1', type: 'knowledge', title: '结构化搜索', description: '倒排索引原理', emoji: '📚', tags: ['搜索'], extraFields: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', indexedAt: 0 })
idx.add({ id: 'k2', type: 'knowledge', title: '向量数据库', description: 'embedding 相似度检索', emoji: '📚', tags: ['AI'], extraFields: [], createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', indexedAt: 0 })
idx.add({ id: 'p1', type: 'project', title: '搜索引擎项目', description: '', emoji: '🚀', tags: ['搜索'], extraFields: [], createdAt: '2026-01-03T00:00:00Z', updatedAt: '2026-01-03T00:00:00Z', indexedAt: 0 })

assert('A4. index size', idx.size() === 3)
assert('A5. getByType 过滤', idx.getByType('knowledge').length === 2)

// 精确匹配（英文整词 = 索引 token，可触发 exact 层）
const exact = idx.search('embedding')
assert('A6. 精确匹配 description 得分最高且 matchType=exact', exact.length >= 1 && exact[0].item.id === 'k2' && exact[0].matchType === 'exact')

// 前缀匹配
const prefix = idx.search('搜索引')
assert('A7. 前缀匹配命中 p1', prefix.some(r => r.item.id === 'p1'))

// 模糊匹配（description / token）
const fuzzy = idx.search('倒排')
assert('A8. 模糊匹配 description', fuzzy.some(r => r.item.id === 'k1'))

// 类型过滤
const typed = idx.search('搜索', { types: ['project'] })
assert('A9. types 过滤只剩 project', typed.length === 1 && typed[0].item.type === 'project')

// 标签过滤
const tagged = idx.search('搜索', { tags: ['AI'] })
assert('A10. tags 过滤排除无 AI 标签结果', tagged.every(r => r.item.id !== 'p1'))

// 排序：多字段命中（title+tag）> 单字段命中，确定性英文用例
idx.add({ id: 'k5', type: 'knowledge', title: 'Obsidian', description: '', emoji: '📚', tags: ['obsidian'], extraFields: [], createdAt: '2026-01-04T00:00:00Z', updatedAt: '2026-01-04T00:00:00Z', indexedAt: 0 })
idx.add({ id: 'k6', type: 'knowledge', title: 'Obsidian Sync Guide', description: 'note taking', emoji: '📚', tags: [], extraFields: [], createdAt: '2026-01-05T00:00:00Z', updatedAt: '2026-01-05T00:00:00Z', indexedAt: 0 })
const ranked = idx.search('obsidian')
assert('A11. 排序：完全匹配排第一且分数严格递减', ranked[0].item.id === 'k5' && ranked[0].score > ranked[ranked.length - 1].score)

// 最近使用
idx.markRecent('k2'); idx.markRecent('p1'); idx.markRecent('k2')
const recent = idx.getRecent(5)
assert('A12. 最近使用去重且最新在前', recent.length === 2 && recent[0].id === 'k2' && recent[1].id === 'p1')

// remove
idx.remove('k5')
idx.remove('k6')
assert('A13. remove 后索引不再命中', idx.search('obsidian').length === 0)

// ====== B. SearchService 集成 ======
console.log('— SearchService —')

await Promise.all([
  db.goals.clear(), db.projects.clear(), db.tasks.clear(), db.knowledge.clear(),
  db.relations.clear(), db.events.clear(),
])
await seedObject({ id: 'sk1', type: 'knowledge', title: '统一搜索设计', description: 'SearchService 架构', tags: ['搜索'] })
await seedObject({ id: 'sk2', type: 'knowledge', title: '知识图谱建模', description: 'Relation 驱动', tags: ['图谱'] })
await seedObject({ id: 'sp1', type: 'project', title: '统一登录改造', description: '', tags: [] })

await searchService.load()
assert('B1. load 后索引包含全部对象', searchService.getStats().totalObjects === 3)
assert('B2. getStats byType 统计', searchService.getStats().byType['knowledge'] === 2 && searchService.getStats().byType['project'] === 1)

// 全局搜索
const globalRes = await searchService.search('统一')
assert('B3. 全局搜索跨类型命中', globalRes.objects.some(r => r.item.id === 'sk1') && globalRes.objects.some(r => r.item.id === 'sp1'))

// 对象范围 + 类型过滤
const objRes = await searchService.search('统一', { types: ['knowledge'] }, 'objects')
assert('B4. objects 范围 + types 过滤', objRes.objects.length === 1 && objRes.objects[0].item.id === 'sk1' && objRes.events.length === 0)

// 状态过滤
await seedObject({ id: 'st1', type: 'task', title: '统一搜索联调', status: 'todo' })
await db.tasks.put(await db.tasks.get('st1') as any)
await searchService.load()
const doneRes = await searchService.search('统一', { types: ['task'], status: 'todo' })
const doneRes2 = await searchService.search('统一', { types: ['task'], status: 'done' })
assert('B5. status 过滤', doneRes.objects.length === 1 && doneRes.objects[0].item.id === 'st1' && doneRes2.objects.length === 0)

// 时间过滤
const yesterday = new Date(Date.now() - 86400000).toISOString()
const tomorrow = new Date(Date.now() + 86400000).toISOString()
const timeRes = await searchService.search('统一', { dateFrom: yesterday, dateTo: tomorrow }, 'objects')
assert('B6. 时间范围过滤命中今天创建对象', timeRes.objects.length === 3)
const timeRes2 = await searchService.search('统一', { dateFrom: tomorrow }, 'objects')
assert('B7. 未来起始时间过滤为空', timeRes2.objects.length === 0)

// 关系过滤：hasRelations / relatedTo
const { createRelation } = await import('./src/repositories/relationRepository.ts')
const relAB = await createRelation('knowledge', 'sk2', 'knowledge', 'sk1', 'references')
assert('B8. 建立测试关系', relAB.ok)
searchService.updateObject(await db.knowledge.get('sk1') as AnyObject)
searchService.updateObject(await db.knowledge.get('sk2') as AnyObject)
;(searchService as any).allRelations = await db.relations.toArray()

const relRes = await searchService.search('统一', { hasRelations: true, types: ['knowledge'] }, 'objects')
assert('B9. hasRelations 只返回有关系对象', relRes.objects.length === 1 && relRes.objects[0].item.id === 'sk1')

const relatedRes = await searchService.search('建模', { relatedTo: { type: 'knowledge', id: 'sk1' } }, 'objects')
assert('B10. relatedTo 关联对象过滤', relatedRes.objects.length === 1 && relatedRes.objects[0].item.id === 'sk2')

// 关系范围搜索
const relScope = await searchService.search('references', {}, 'relations')
assert('B11. relations 范围按 relationType 命中', relScope.relations.length === 1 && relScope.objects.length === 0)
const relFiltered = await searchService.search('', { relationType: 'references' }, 'relations')
assert('B12. 无关键词时 relationType 过滤生效', relFiltered.relations.length === 1)

// 时间线搜索
const { createEvent } = await import('./src/repositories/eventRepository.ts')
await createEvent('object.created', 'user', 'knowledge', 'sk1', { title: '统一搜索设计' })
await searchService.load() // 重新加载事件缓存
const tlRes = await searchService.search('created', {}, 'timeline')
assert('B13. timeline 范围命中事件', tlRes.events.length >= 1 && tlRes.events.every(e => e.type.includes('created')))

// 知识关联搜索
const knRes = await searchService.search('统一', {}, 'knowledge')
assert('B14. knowledge 范围只含知识对象', knRes.objects.length === 1 && knRes.objects[0].item.type === 'knowledge')
const knRels = await searchService.search('', { relatedTo: { type: 'knowledge', id: 'sk1' } }, 'knowledge')
assert('B15. knowledge 范围只含知识相关关系', knRels.relations.every(r => r.sourceType === 'knowledge' || r.targetType === 'knowledge'))

// quickSearch + markRecent
const quick = searchService.quickSearch('统一', ['knowledge'])
assert('B16. quickSearch 同步即时返回', quick.length === 1 && quick[0].item.id === 'sk1')
searchService.markRecent('sk2')
assert('B17. getRecent 返回最近访问', searchService.getRecent(1)[0]?.id === 'sk2')

// updateObject / removeObject 同步索引
searchService.removeObject('st1', 'task')
assert('B18. removeObject 后不再命中', searchService.quickSearch('联调').length === 0)

console.log(`\n📊 结果: ${pass} 通过, ${fail} 失败\n`)
process.exit(fail > 0 ? 1 : 0)
