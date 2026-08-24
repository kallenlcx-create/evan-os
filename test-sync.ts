// ====== Evan OS v1.1 云同步引擎测试 ======
// 登录门控 / 推送 / 拉取 / 版本合并 / 删除墓碑传播 / 游标幂等 / 覆盖范围
// 时钟策略：MockRemote.mockNow 以真实当前时间为基点向前推进，与引擎时钟域一致
// 运行: npx tsx test-sync.ts

import 'fake-indexeddb/auto'
import { db } from './src/db.ts'
import {
  cloudSync, SYNC_TABLES, type SyncTransport,
} from './src/services/cloudSync.ts'
import { createKnowledge } from './src/repositories/knowledgeRepository.ts'
import { deleteObject } from './src/repositories/objectRepository.ts'

let pass = 0, fail = 0
function assert(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`) }
  else { fail++; console.log(`  [FAIL] ${name}`) }
}

console.log('\n🧪 云同步引擎测试\n')

;(globalThis as any).__SYNC_DEBUG__ = true

await Promise.all([
  db.knowledge.clear(), db.tasks.clear(), db.relations.clear(),
  db.events.clear(), db.deletions.clear(), db.appState.clear(),
])

class MockRemote implements SyncTransport {
  store = new Map<string, Map<string, Record<string, any>>>()
  deletions: { tableName: string; rowId: string; deletedAt: string }[] = []
  loggedIn = false
  calls = { push: 0, pull: 0 }
  /** 时钟以真实当下为基点 */
  mockNow = new Date().toISOString()

  private table(t: string) {
    if (!this.store.has(t)) this.store.set(t, new Map())
    return this.store.get(t)!
  }
  advance(seconds: number): void {
    const t = new Date(this.mockNow)
    t.setSeconds(t.getSeconds() + seconds)
    this.mockNow = t.toISOString()
  }
  at(offsetSeconds: number): string {
    const t = new Date(this.mockNow)
    t.setSeconds(t.getSeconds() + offsetSeconds)
    return t.toISOString()
  }
  remoteUpsert(table: string, row: Record<string, any>): void {
    this.table(table).set(row.id, { ...row })
  }

  async login(): Promise<{ token: string }> {
    this.loggedIn = true
    return { token: 'mock-token' }
  }
  async push(_s: string, _t: string, table: string, rows: any[]): Promise<void> {
    this.calls.push++
    for (const row of rows) {
      // 服务端 LWW 守门：只接受比已存版本更新的行（与 server.mjs 一致）
      const existing = this.table(table).get(row.id)
      const incomingTs = row.updatedAt || row.createdAt || ''
      if (existing) {
        const existingTs = existing.updatedAt || existing.createdAt || ''
        if (incomingTs <= existingTs) continue
      }
      this.table(table).set(row.id, { ...row })
    }
  }
  async pullChanges(_s: string, _t: string, since: string) {
    this.calls.pull++
    const changes: { table: string; rows: any[] }[] = []
    for (const [table, map] of this.store) {
      const rows = [...map.values()].filter(r => {
        const t = r.updatedAt || r.createdAt || ''
        return t > since && r._deleted !== true
      })
      if (rows.length > 0) changes.push({ table, rows })
    }
    const deletions = this.deletions.filter(d => d.deletedAt > since)
    return { serverNow: this.mockNow, changes, deletions }
  }
  async pushDeletions(_s: string, _t: string, deletions: any[]): Promise<void> {
    for (const d of deletions) {
      // 服务端以收到时刻记录删除时间（可控时钟）
      this.table(d.tableName).delete(d.rowId)
      this.deletions.push({ tableName: d.tableName, rowId: d.rowId, deletedAt: this.mockNow })
    }
  }
}

const remote = new MockRemote()
cloudSync.setTransport(remote)
await cloudSync.configure('https://sync.test', 'evan')

// ====== A. 登录门控 ======
console.log('— 登录门控 —')

const noLogin = await cloudSync.syncNow().then(() => null).catch(e => String(e))
assert('A1. 未登录时同步被拒绝', !!noLogin && noLogin.includes('登录'))
await cloudSync.login('pass-123')
assert('A2. 登录成功获得令牌', remote.loggedIn && (await cloudSync.isLoggedIn()))

// ====== B. 推送 ======
console.log('— 推送 —')

await createKnowledge({ title: '设备甲的知识', content: '', tags: ['a'] })
await createKnowledge({ title: '冲突行', content: 'v1 本地版本', tags: [] })
const summary1 = await cloudSync.syncNow()

assert('B1. 同步完成且推送了行', summary1.pushedRows >= 2 && summary1.tablesPushed >= 1)
assert('B2. 知识到达远端',
  [...(remote.store.get('knowledge')?.values() ?? [])].some(r => r.title === '设备甲的知识'))
assert('B3. 墓碑推送后清空本地日志', (await db.deletions.toArray()).length === 0)

// 记录冲突行的远端版本时间戳（B 推送时刻）
const kXRemoteV1 = remote.store.get('knowledge')!.get(
  [...remote.store.get('knowledge')!.keys()].find(id => remote.store.get('knowledge')!.get(id)!.title === '冲突行')!)
if (!kXRemoteV1) throw new Error('fixture missing')

// ====== C. 拉取新行 ======
console.log('— 拉取 —')

remote.advance(120)
remote.remoteUpsert('tasks', {
  id: 'from-b', title: '设备乙的任务', status: 'todo', priority: 'medium',
  updatedAt: remote.at(0), createdAt: remote.at(0),
  emoji: '✅', description: '', tags: [], relations: [],
})
const beforeTasks = await db.tasks.count()
await cloudSync.syncNow()
assert('C1. 远端新行拉取到本地',
  (await db.tasks.count()) === beforeTasks + 1 && !!(await db.tasks.get('from-b')))

// ====== D. 版本合并 ======
console.log('— 版本合并 —')

// D1: 设备乙改出较新版本（晚于游标）→ 覆盖本地
remote.advance(120)
remote.remoteUpsert('knowledge', {
  ...kXRemoteV1, content: 'v2 远端较新',
  updatedAt: remote.at(0),
})
await cloudSync.syncNow()
const kxId = kXRemoteV1.id
assert('D1. 远端较新版本覆盖本地',
  (await db.knowledge.get(kxId))?.content === 'v2 远端较新')

// D2: 过期回声（时间戳早于游标）不再应用
remote.advance(30)
remote.remoteUpsert('knowledge', {
  ...kXRemoteV1, content: 'v0 过期回声',
  updatedAt: remote.at(-30),
})
await cloudSync.syncNow()
assert('D2. 游标之前的过期版本不会被重新应用',
  (await db.knowledge.get(kxId))?.content === 'v2 远端较新')

// ====== E. 删除传播 ======
console.log('— 删除传播 —')

await deleteObject('task', 'from-b')
assert('E1. 中间件自动捕获删除为墓碑',
  (await db.deletions.filter(d => d.rowId === 'from-b').toArray()).length === 1)

remote.advance(60)
await cloudSync.syncNow()
assert('E2. 墓碑推送后远端行被删除',
  !remote.store.get('tasks')!.has('from-b'))

// 旧数据写回远端（时间戳早于删除）→ 不复活
remote.advance(30)
remote.remoteUpsert('tasks', {
  id: 'from-b', title: '设备乙的任务', status: 'todo', priority: 'medium',
  updatedAt: remote.at(-120), createdAt: remote.at(-120),
  emoji: '✅', description: '', tags: [], relations: [],
})
await cloudSync.syncNow()
assert('E3. 早于删除时间的旧行不复活',
  !(await db.tasks.get('from-b')))

// 比删除更新的一次合法编辑 → 重建（编辑赢过删除）
remote.advance(60)
remote.remoteUpsert('tasks', {
  id: 'from-b', title: '设备乙重建的任务', status: 'todo', priority: 'high',
  updatedAt: remote.at(0), createdAt: remote.at(0),
  emoji: '✅', description: '', tags: [], relations: [],
})
remote.advance(30)
await cloudSync.syncNow()
assert('E4. 晚于删除的合法编辑正常重建（编辑赢过删除）',
  (await db.tasks.get('from-b'))?.title === '设备乙重建的任务')

// ====== F. 游标幂等 ======
console.log('— 游标幂等 —')

const callsBefore = remote.calls.pull
const s4 = await cloudSync.syncNow()
assert('F1. 无变更同步为空操作',
  remote.calls.pull === callsBefore + 1 &&
  s4.appliedRows === 0 && s4.appliedDeletions === 0)

// ====== G. 覆盖范围 ======
console.log('— 覆盖范围 —')

assert('G1. 同步表排除本地态/审计噪声表',
  !SYNC_TABLES.includes('appState') && !SYNC_TABLES.includes('deletions') &&
  !SYNC_TABLES.includes('contexts') && !SYNC_TABLES.includes('events') &&
  SYNC_TABLES.length >= 25)

console.log(`\n📊 结果: ${pass} 通过, ${fail} 失败\n`)
process.exit(fail > 0 ? 1 : 0)
