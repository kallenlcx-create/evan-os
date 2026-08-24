import { db } from '../db'
import type { Project } from '../types'
import { uid, now, type Result, ok, err } from './result'
import { createEvent } from './eventRepository'
import { createRelation } from './relationRepository'

// ====== Project Repository ======

export async function createProject(data: Partial<Project>): Promise<Result<Project>> {
  const id = data.id || uid()
  const project: Project = {
    id,
    type: 'project',
    title: data.title || '',
    description: data.description || '',
    emoji: data.emoji || '🚀',
    tags: data.tags || [],
    relations: [],
    status: data.status || 'planning',
    progress: data.progress || 0,
    dueDate: data.dueDate,
    tasks: [],  // legacy
    createdAt: now(),
    updatedAt: now(),
  }

  try {
    await db.projects.add(project)
    await createEvent('object.created', 'user', 'project', id, { title: project.title })

    // 建立 goal ← project 的 supports 关系
    if (data.relations && data.relations.length > 0) {
      for (const rel of data.relations) {
        if (rel.targetType === 'goal') {
          await createRelation('project', id, 'goal', rel.targetId, 'supports', {
            metadata: { legacyLabel: rel.label },
          })
        }
      }
    }

    return ok(project)
  } catch (e) {
    return err(`创建项目失败: ${e}`)
  }
}

export async function startProject(id: string): Promise<Result<void>> {
  try {
    const project = await db.projects.get(id)
    if (!project) return err('项目不存在')

    const next = { ...project, status: 'in_progress' as const, updatedAt: now() }
    await db.projects.put(next)
    await createEvent('project.started', 'user', 'project', id, { title: project.title })

    return ok(undefined)
  } catch (e) {
    return err(`启动项目失败: ${e}`)
  }
}

export async function completeProject(id: string): Promise<Result<void>> {
  try {
    const project = await db.projects.get(id)
    if (!project) return err('项目不存在')

    const next = { ...project, status: 'done' as const, progress: 100, updatedAt: now() }
    await db.projects.put(next)
    await createEvent('project.completed', 'user', 'project', id, { title: project.title })

    return ok(undefined)
  } catch (e) {
    return err(`完成项目失败: ${e}`)
  }
}
