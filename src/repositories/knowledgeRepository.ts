import { db } from '../db'
import type { Knowledge } from '../types'
import { uid, now, type Result, ok, err } from './result'
import { createEvent } from './eventRepository'
import { createRelation, getKnowledgeBacklinks } from './relationRepository'

// ====== Knowledge Repository ======

export async function createKnowledge(data: Partial<Knowledge>): Promise<Result<Knowledge>> {
  const id = data.id || uid()
  const item: Knowledge = {
    id,
    type: 'knowledge',
    title: data.title || '',
    description: data.description || '',
    emoji: data.emoji || '📝',
    tags: data.tags || [],
    relations: [],
    category: data.category || 'general',
    source: data.source,
    content: data.content || '',
    isBookmarked: data.isBookmarked || false,
    format: data.format || 'plain',
    backlinks: [],  // legacy — 通过 Relation 动态计算
    createdAt: now(),
    updatedAt: now(),
  }

  try {
    await db.knowledge.add(item)
    await createEvent('object.created', 'user', 'knowledge', id, { title: item.title })
    return ok(item)
  } catch (e) {
    return err(`创建知识失败: ${e}`)
  }
}

// 动态计算 backlinks（通过 Relation 表，而非 backlinks 字段）
export async function getBacklinks(knowledgeId: string): Promise<Knowledge[]> {
  const backlinkRels = await getKnowledgeBacklinks(knowledgeId)
  const sourceIds = backlinkRels.map(r => r.sourceId)
  const items = await Promise.all(sourceIds.map(id => db.knowledge.get(id)))
  return items.filter(Boolean) as Knowledge[]
}

// 建立 knowledge → knowledge 的 references 关系
export async function addReference(
  sourceKnowledgeId: string,
  targetKnowledgeId: string
): Promise<Result<void>> {
  const result = await createRelation(
    'knowledge', sourceKnowledgeId,
    'knowledge', targetKnowledgeId,
    'references'
  )
  if (result.ok) {
    return ok(undefined)
  }
  return err((result as any).error)
}

// ====== Wiki 双链：[[标题]] ↔ references Relation ======

/** 解析内容中的 [[标题]]，返回去重后的标题列表 */
export function parseWikiLinks(content: string | undefined | null): string[] {
  if (!content) return []
  const titles: string[] = []
  const re = /\[\[([^\]]+)\]\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    const t = m[1].trim()
    if (t && !titles.includes(t)) titles.push(t)
  }
  return titles
}

/**
 * 把笔记内容中的 [[标题]] 同步为 references Relation（metadata.via = 'wiki'）：
 * 新链接建关系；内容中已移除的 wiki 链接删关系（不影响手动建立的同类型关系）
 */
export async function syncWikiLinkRelations(knowledgeId: string, content: string | undefined | null): Promise<void> {
  try {
    const all = await db.knowledge.toArray()
    const byTitle = new Map(all.map(k => [k.title, k.id]))
    const wanted = new Set<string>()
    for (const title of parseWikiLinks(content)) {
      const tid = byTitle.get(title)
      if (tid && tid !== knowledgeId) wanted.add(tid)
    }
    const existing = await db.relations
      .where('[sourceType+sourceId]')
      .equals(['knowledge', knowledgeId])
      .and(r => r.relationType === 'references' && r.metadata?.via === 'wiki')
      .toArray()
    const existingTargets = new Set(existing.map(r => r.targetId))
    for (const tid of wanted) {
      if (!existingTargets.has(tid)) {
        await createRelation('knowledge', knowledgeId, 'knowledge', tid, 'references', {
          metadata: { via: 'wiki' },
          createdBy: 'user',
          source: 'manual',
        })
      }
    }
    const stale = existing.filter(r => !wanted.has(r.targetId))
    if (stale.length > 0) await db.relations.bulkDelete(stale.map(r => r.id))
  } catch { /* 双链同步失败不阻塞保存 */ }
}

/** 反向链接：通过 references Relation 动态计算指向本笔记的知识 */
export async function getWikiBacklinks(knowledgeId: string): Promise<Knowledge[]> {
  try {
    const rels = await getKnowledgeBacklinks(knowledgeId)
    const sourceIds = [...new Set(rels.map(r => r.sourceId))]
    const items = await Promise.all(sourceIds.map(id => db.knowledge.get(id)))
    return items.filter(Boolean) as Knowledge[]
  } catch {
    return []
  }
}

/** 笔记改名后，把其他笔记中的 [[旧标题]] 批量替换为 [[新标题]]，返回受影响条数 */
export async function migrateWikiLinksOnRename(oldTitle: string, newTitle: string): Promise<number> {
  if (!oldTitle || !newTitle || oldTitle === newTitle) return 0
  try {
    const all = await db.knowledge.toArray()
    const affected = all.filter(k => k.content && k.content.includes(`[[${oldTitle}]]`))
    for (const k of affected) {
      await db.knowledge.update(k.id, {
        content: k.content.split(`[[${oldTitle}]]`).join(`[[${newTitle}]]`),
        updatedAt: now(),
      })
      await createEvent('object.updated', 'user', 'knowledge', k.id, { renamedLink: true })
    }
    return affected.length
  } catch {
    return 0
  }
}
