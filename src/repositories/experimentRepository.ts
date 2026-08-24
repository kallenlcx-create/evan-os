import { db } from '../db'
import type { Experiment } from '../types'
import { uid, now, type Result, ok, err } from './result'
import { createEvent } from './eventRepository'

export async function createExperiment(data: Partial<Experiment>): Promise<Result<Experiment>> {
  const id = data.id || uid()
  const exp: Experiment = {
    id,
    type: 'experiment',
    title: data.title || '',
    description: data.description || '',
    emoji: data.emoji || '🧪',
    tags: data.tags || [],
    relations: [],
    status: 'planned',
    hypothesis: data.hypothesis || '',
    result: data.result,
    createdAt: now(),
    updatedAt: now(),
  }

  try {
    await db.experiments.add(exp)
    await createEvent('experiment.created', 'user', 'experiment', id, { title: exp.title })
    return ok(exp)
  } catch (e) {
    return err(`创建实验失败: ${e}`)
  }
}

export async function completeExperiment(id: string, result: string): Promise<Result<void>> {
  try {
    const exp = await db.experiments.get(id)
    if (!exp) return err('实验不存在')

    const next = { ...exp, status: 'completed' as const, result, updatedAt: now() }
    await db.experiments.put(next)
    await createEvent('experiment.completed', 'user', 'experiment', id, { title: exp.title })

    return ok(undefined)
  } catch (e) {
    return err(`完成实验失败: ${e}`)
  }
}
