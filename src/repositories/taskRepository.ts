import { db } from '../db'
import type { Task } from '../types'
import { uid, now, type Result, ok, err } from './result'
import { createEvent } from './eventRepository'
import { createRelation, deleteRelation, getOutgoingRelations } from './relationRepository'

// ====== Task Repository ======

export async function createTask(data: Partial<Task>): Promise<Result<Task>> {
  const id = data.id || uid()
  const task: Task = {
    id,
    type: 'task',
    title: data.title || '',
    description: data.description || '',
    emoji: data.emoji || '✅',
    tags: data.tags || [],
    relations: [],  // legacy
    status: 'todo',
    priority: data.priority || 'medium',
    importance: data.importance || 'medium',
    dueDate: data.dueDate,
    dueTime: data.dueTime,
    isRecurring: data.isRecurring || false,
    recurringRule: data.recurringRule,
    estimatedMinutes: data.estimatedMinutes,
    todayOrder: data.todayOrder ?? 0,
    createdAt: now(),
    updatedAt: now(),
  }

  try {
    await db.tasks.add(task)
    await createEvent('object.created', 'user', 'task', id, { title: task.title })

    // 如果有 projectId，通过 Relation 建立 belongs_to 关系
    if (data.relations && data.relations.length > 0) {
      for (const rel of data.relations) {
        if (rel.targetType === 'project') {
          await createRelation('task', id, 'project', rel.targetId, 'belongs_to', {
            metadata: { legacyLabel: rel.label },
            source: 'manual',
          })
        }
      }
    }

    return ok(task)
  } catch (e) {
    return err(`创建任务失败: ${e}`)
  }
}

export async function completeTask(id: string): Promise<Result<void>> {
  try {
    const task = await db.tasks.get(id)
    if (!task) return err('任务不存在')

    const next = { ...task, status: 'done' as const, updatedAt: now() }
    await db.tasks.put(next)

    await createEvent('task.completed', 'user', 'task', id, { title: task.title })

    return ok(undefined)
  } catch (e) {
    return err(`完成任务失败: ${e}`)
  }
}

export async function toggleTaskStatus(id: string): Promise<Result<void>> {
  try {
    const task = await db.tasks.get(id)
    if (!task) return err('任务不存在')

    const nextStatus = task.status === 'done' ? 'todo' : 'done'
    const next = { ...task, status: nextStatus as Task['status'], updatedAt: now() }
    await db.tasks.put(next)

    if (nextStatus === 'done') {
      await createEvent('task.completed', 'user', 'task', id, { title: task.title })
    }

    return ok(undefined)
  } catch (e) {
    return err(`更新任务状态失败: ${e}`)
  }
}

export async function getProjectTasks(projectId: string): Promise<Task[]> {
  const rels = await getOutgoingRelations('project', projectId)
  // 不太对 — 应该是 task → project 的 belongs_to
  // 用 relationRepository 的 getTasksForProject
  const { getTasksForProject } = await import('./relationRepository')
  const taskRels = await getTasksForProject(projectId)
  const taskIds = taskRels.map(r => r.sourceId)
  const tasks = await Promise.all(taskIds.map(id => db.tasks.get(id)))
  return tasks.filter(Boolean) as Task[]
}
