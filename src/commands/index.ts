// ====== 统一 Command 层 ======
// Command = Validate → Repository Write → Event → Return Result

import type { AnyObject, ObjectType, RelationType } from '../types'
import { type Result } from '../repositories/result'
import {
  createObject, updateObject, deleteObject, archiveObject, restoreObject,
} from '../repositories/objectRepository'
import { createRelation, deleteRelation } from '../repositories/relationRepository'
import { completeTask, createTask } from '../repositories/taskRepository'
import { startProject, completeProject, createProject } from '../repositories/projectRepository'
import { createDecision } from '../repositories/decisionRepository'
import { createExperiment, completeExperiment } from '../repositories/experimentRepository'
import { captureInbox, processInbox } from '../repositories/inboxRepository'

// ====== 对象 Commands ======

export async function cmdCreateObject<T extends AnyObject>(
  type: ObjectType,
  data: Partial<T>
): Promise<Result<T>> {
  // Validate
  if (!(data as any).title && !(data as any).contactName && !(data as any).company) {
    return { ok: false, error: '标题不能为空' }
  }
  return createObject<T>(type, data)
}

export async function cmdUpdateObject(
  type: ObjectType,
  id: string,
  data: Partial<AnyObject>
): Promise<Result<void>> {
  if (!id) return { ok: false, error: 'ID 不能为空' }
  return updateObject(type, id, data)
}

export async function cmdDeleteObject(
  type: ObjectType,
  id: string
): Promise<Result<void>> {
  if (!id) return { ok: false, error: 'ID 不能为空' }
  return deleteObject(type, id)
}

export async function cmdArchiveObject(
  type: ObjectType,
  id: string
): Promise<Result<void>> {
  return archiveObject(type, id)
}

export async function cmdRestoreObject(
  type: ObjectType,
  id: string
): Promise<Result<void>> {
  return restoreObject(type, id)
}

// ====== Relation Commands ======

export async function cmdCreateRelation(
  sourceType: ObjectType,
  sourceId: string,
  targetType: ObjectType,
  targetId: string,
  relationType: RelationType,
  metadata?: Record<string, any>
): Promise<Result<void>> {
  const result = await createRelation(sourceType, sourceId, targetType, targetId, relationType, { metadata })
  if (result.ok) return { ok: true, value: undefined }
  return { ok: false, error: (result as any).error }
}

export async function cmdDeleteRelation(id: string): Promise<Result<void>> {
  return deleteRelation(id)
}

// ====== Task Commands ======

export async function cmdCreateTask(data: Partial<AnyObject>): Promise<Result<AnyObject>> {
  return createTask(data as any)
}

export async function cmdCompleteTask(id: string): Promise<Result<void>> {
  return completeTask(id)
}

// ====== Project Commands ======

export async function cmdCreateProject(data: Partial<AnyObject>): Promise<Result<AnyObject>> {
  return createProject(data as any)
}

export async function cmdStartProject(id: string): Promise<Result<void>> {
  return startProject(id)
}

export async function cmdCompleteProject(id: string): Promise<Result<void>> {
  return completeProject(id)
}

// ====== Decision Commands ======

export async function cmdCreateDecision(data: Partial<AnyObject>): Promise<Result<AnyObject>> {
  return createDecision(data as any)
}

// ====== Experiment Commands ======

export async function cmdCreateExperiment(data: Partial<AnyObject>): Promise<Result<AnyObject>> {
  return createExperiment(data as any)
}

export async function cmdCompleteExperiment(id: string, result: string): Promise<Result<void>> {
  return completeExperiment(id, result)
}

// ====== Inbox Commands ======

export async function cmdCaptureInbox(
  content: string,
  type: 'quick_note' | 'task' | 'idea' | 'link',
  source?: string
): Promise<Result<AnyObject>> {
  return captureInbox(content, type, source) as any
}

export async function cmdProcessInbox(
  id: string,
  processedType: ObjectType,
  processedId: string
): Promise<Result<void>> {
  return processInbox(id, processedType, processedId)
}
