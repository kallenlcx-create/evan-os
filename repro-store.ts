import 'fake-indexeddb/auto'
import { useStore } from './src/store.ts'
import { db } from './src/db.ts'

await Promise.all([db.goals.clear(), db.tasks.clear(), db.appState.clear(), db.events.clear()])

const s = useStore.getState()
console.log('1. initFromDB...')
await s.initFromDB()
console.log('   goals in store:', useStore.getState().goals.length)

console.log('2. addObject goal...')
const id = await s.addObject('goal', { title: 'Node 复现目标', level: 'current', keyResults: [], progress: 0 })
console.log('   returned id:', id)
const inDb = await db.goals.get(id)
console.log('   in DB:', !!inDb, inDb?.title)
console.log('   in store:', useStore.getState().goals.some(g => g.id === id))

console.log('3. addTask...')
const tid = await s.addTask({ title: 'Node 复现任务' })
console.log('   task in DB:', !!(await db.tasks.get(tid)))

process.exit(0)
