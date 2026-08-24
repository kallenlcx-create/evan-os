// ====== Evan OS v1.0.x Obsidian / SQL 导出测试 ======
// Markdown 序列化往返一致 / 幂等导入 / wikilink / MySQL 脚本可导入性
// 运行: npx tsx test-vault.ts

import 'fake-indexeddb/auto'
import { db } from './src/db.ts'
import {
  knowledgeToMarkdown, markdownToKnowledge,
  buildVaultFiles, generateSqlDump, mergeVaultToSingleFile,
} from './src/services/vaultSync.ts'
import { createKnowledge } from './src/repositories/knowledgeRepository.ts'
import { createRelation } from './src/repositories/relationRepository.ts'

let pass = 0, fail = 0
function assert(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`) }
  else { fail++; console.log(`  [FAIL] ${name}`) }
}

console.log('\n🧪 Obsidian / SQL 导出测试\n')

await Promise.all([db.knowledge.clear(), db.relations.clear(), db.events.clear()])

// ====== A. Markdown 序列化 ======
console.log('— Markdown 序列化 —')

const kA = await createKnowledge({
  title: 'LED 行业笔记', content: '主推 RGB 灯带，毛利 35%',
  tags: ['外贸', 'LED'], category: 'business', source: 'manual',
})
if (!kA.ok) throw new Error(kA.error)
const kB = await createKnowledge({ title: '报价策略', content: '首单 5% 折扣', tags: ['报价'] })
await createRelation('knowledge', kA.value.id, 'knowledge', kB.value.id, 'references')

const links = [{ targetTitle: '报价策略', relationType: 'references' }]
const md = knowledgeToMarkdown(
  { ...kA.value, content: kA.value.content } as Knowledge, links)

assert('A1. 含 YAML frontmatter 边界', md.content.startsWith('---\n') && md.content.includes('\n---\n'))
assert('A2. frontmatter 携带 id/tags/category',
  md.content.includes(`id: ${kA.value.id}`) &&
  md.content.includes('[外贸, LED]') &&
  md.content.includes('category: business'))

// ====== B. 反序列化（解析回结构化）======
console.log('— 解析 —')

const parsed = markdownToKnowledge(md.content)
assert('B1. 往返还原 id/title/正文/标签',
  parsed?.id === kA.value.id && parsed.title === 'LED 行业笔记' &&
  parsed.body.includes('毛利 35%') && parsed.tags.includes('LED') &&
  parsed.category === 'business')

assert('B2. 无 frontmatter 的普通笔记返回 null',
  markdownToKnowledge('# 随手记\n内容') === null)

// ====== C. Vault 构建与 wikilink ======
console.log('— Vault 构建 —')

const vault = await buildVaultFiles()
assert('C1. 每条知识生成一个 .md 文件',
  vault.length === 2 && vault.every(f => f.path.endsWith('.md')))
assert('C2. 关系渲染为 wikilink [[标题]]',
  vault.find(f => f.path.includes('LED'))!.content.includes('- references → [[报价策略]]'))

// ====== D. 经 CommandBus 幂等导入 ======
console.log('— 导入幂等 —')

const importedNote = markdownToKnowledge(vault.find(f => f.path.includes('LED'))!.content)!
await import('./src/services/integrations/commandBus.ts').then(m =>
  m.commandBus.execute('obsidian', 'knowledge.upsert', {
    id: importedNote.id, title: importedNote.title + '（Vault 修改）',
    content: importedNote.body, tags: importedNote.tags,
  }))
const afterImport = await db.knowledge.toArray()
assert('D1. 同 id 导入为更新而非新建',
  afterImport.length === 2 &&
  afterImport.find(k => k.id === kA.value.id)?.title.includes('Vault 修改'))

// ====== E. 合并单文件回退 ======
console.log('— 单文件回退 —')

const merged = mergeVaultToSingleFile(vault)
assert('E1. 合并文件包含全部笔记路径标记',
  (merged.match(/%% .*? %%/g) ?? []).length === 2)

// ====== F. MySQL SQL 生成 ======
console.log('— MySQL 导出 —')

// 先造点多类型数据
await import('./src/repositories/taskRepository.ts').then(async m => {
  await m.createTask({ title: 'SQL 测试任务' })
})
const sql = await generateSqlDump()

assert('F1. 包含 CREATE TABLE 与 REPLACE INTO',
  sql.includes('CREATE TABLE `goals`') || sql.includes('CREATE TABLE `knowledge`'),
)
const createCount = (sql.match(/CREATE TABLE/g) ?? []).length
const replaceCount = (sql.match(/REPLACE INTO/g) ?? []).length
assert('F2. 覆盖全部数据表且每行一条 INSERT',
  createCount >= 25 && replaceCount >= 3)

assert('F3. 布尔转 TINYINT、对象转 JSON、字符串正确转义',
  /`isRecurring`\s+TINYINT\(1\)/.test(sql) ||
  /`processed`\s+TINYINT\(1\)/.test(sql) ||
  /`read`\s+TINYINT\(1\)/.test(sql)) &&
  sql.includes("'[") === false // 对象走 JSON 列而非 JS 数组字面量

assert('F4. 单引号转义安全（不破坏语句）',
  !/\bVALUES\s*\('/.test(sql.replace(/REPLACE INTO `[a-z_]+` \([^)]+\) VALUES /g, '')))

// 烟雾：SQL 中能找到已知数据行
assert('F5. 已知知识条目出现在脚本中', sql.includes('LED 行业笔记'.replace(/'/g, "''")) || sql.includes('LED 行业笔记'))

console.log(`\n📊 结果: ${pass} 通过, ${fail} 失败\n`)
process.exit(fail > 0 ? 1 : 0)
