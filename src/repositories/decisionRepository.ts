import { db } from '../db'
import type { Decision } from '../types'
import { uid, now, type Result, ok, err } from './result'
import { createEvent } from './eventRepository'

export async function createDecision(data: Partial<Decision>): Promise<Result<Decision>> {
  const id = data.id || uid()
  const decision: Decision = {
    id,
    type: 'decision',
    title: data.title || '',
    description: data.description || '',
    emoji: data.emoji || '⚖️',
    tags: data.tags || [],
    relations: [],
    options: data.options || [],
    chosen: data.chosen || '',
    rationale: data.rationale || '',
    createdAt: now(),
    updatedAt: now(),
  }

  try {
    await db.decisions.add(decision)
    await createEvent('decision.created', 'user', 'decision', id, { title: decision.title })
    return ok(decision)
  } catch (e) {
    return err(`创建决策失败: ${e}`)
  }
}
