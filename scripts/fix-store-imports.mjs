import fs from 'node:fs'

let c = fs.readFileSync('src/store.ts', 'utf8')

// 1. 静态导入补齐
c = c.replace(
  "import { createTask as repoCreateTask } from './repositories/taskRepository'",
  "import { createTask as repoCreateTask, toggleTaskStatus as repoToggleTask } from './repositories/taskRepository'"
)
c = c.replace(
  "import { loadAllObjects, createObject, updateObject as repoUpdateObject, deleteObject as repoDeleteObject } from './repositories/objectRepository'",
  "import { loadAllObjects, createObject, updateObject as repoUpdateObject, deleteObject as repoDeleteObject } from './repositories/objectRepository'"
)
c = c.replace(
  "import { searchService } from './services/searchService'",
  "import { searchService } from './services/searchService'\nimport { captureInbox as repoCaptureInbox, processInbox as repoProcessInbox, deleteInboxItem as repoDeleteInboxItem } from './repositories/inboxRepository'"
)

// 2. 六处动态 import → 静态引用
c = c.replace(
  "const { updateObject: repoUpdate } = await import('./repositories/objectRepository')",
  'const repoUpdate = repoUpdateObject'
)
c = c.replace(
  "const { deleteObject: repoDelete } = await import('./repositories/objectRepository')",
  'const repoDelete = repoDeleteObject'
)
c = c.replace(
  "const { toggleTaskStatus: repoToggle } = await import('./repositories/taskRepository')",
  'const repoToggle = repoToggleTask'
)
c = c.replace(
  "const { captureInbox } = await import('./repositories/inboxRepository')",
  'const captureInbox = repoCaptureInbox'
)
c = c.replace(
  "const { processInbox } = await import('./repositories/inboxRepository')",
  'const processInbox = repoProcessInbox'
)
c = c.replace(
  "const { deleteInboxItem: repoDelete } = await import('./repositories/inboxRepository')",
  'const repoDelete = repoDeleteInboxItem'
)

fs.writeFileSync('src/store.ts', c)
console.log('dynamic imports left:', (c.match(/await import/g) || []).length)
