// ====== Vault Sync — Obsidian 双向同步 + SQL 导出 ======
// Obsidian：知识库 ↔ Markdown 文件夹（YAML frontmatter + wikilink）
// SQL：全库导出为可导入 MySQL 的脚本
// 浏览器不能随意写磁盘：Chromium 走 File System Access API，其余回退下载

import { db } from '../db'
import { TABLES } from '../db'
import type { Knowledge } from '../types'
import { now, uid } from '../repositories/result'

// ============================================================
// Markdown 序列化
// ============================================================

function yamlEscapeList(tags: string[]): string {
  return `[${tags.map(t => t.replace(/[[\]]/g, '')).join(', ')}]`
}

export function knowledgeToMarkdown(
  note: Knowledge,
  links: { targetTitle: string; relationType: string }[]
): { path: string; content: string } {
  const front = [
    '---',
    `id: ${note.id}`,
    'type: knowledge',
    `title: "${note.title.replace(/"/g, "'")}"`,
    `category: ${note.category ?? 'general'}`,
    `tags: ${yamlEscapeList(note.tags ?? [])}`,
    `created: ${note.createdAt}`,
    `updated: ${note.updatedAt}`,
    'source: evan-os',
    '---',
  ].join('\n')

  const linkSection = links.length > 0
    ? '\n\n## Links\n\n' + links.map(l => `- ${l.relationType} → [[${l.targetTitle}]]`).join('\n')
    : ''

  return {
    path: sanitizeFileName(note.title || note.id) + '.md',
    content: `${front}\n\n# ${note.title}\n\n${note.content ?? ''}${linkSection}\n`,
  }
}

/** 从 Obsidian 笔记解析回结构化对象 */
export function markdownToKnowledge(content: string): {
  id?: string; title: string; body: string; tags: string[]; category?: string
} | null {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!fmMatch) return null
  const fm = fmMatch[1]
  const body = content.slice(fmMatch[0].length)

  const get = (key: string): string | undefined => {
    const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
    return m?.[1]?.trim()
  }
  const id = get('id')
  const titleM = body.match(/^#\s+(.+)$/m)
  const title = (get('title') ?? titleM?.[1] ?? '').replace(/^"|"$/g, '')
  if (!id && !title) return null

  let tags: string[] = []
  const tagsRaw = get('tags')
  if (tagsRaw) {
    tags = [...tagsRaw.matchAll(/[^\[\],\s]+/g)].map(m => m[0])
  }

  // 去掉 Links 段落与一级标题行，还原纯正文
  const cleanBody = body
    .replace(/^#\s+.+\r?\n+/, '')
    .replace(/\n## Links\n[\s\S]*$/, '')
    .trim()

  return { id, title, body: cleanBody, tags, category: get('category') }
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|#^[\]]/g, '_').slice(0, 80)
}

// ============================================================
// 导出：构建 Vault 文件集
// ============================================================

export async function buildVaultFiles(): Promise<{ path: string; content: string }[]> {
  const notes = await db.knowledge.toArray()
  const relations = await db.relations.toArray()
  const byId = new Map(notes.map(n => [n.id, n]))

  return notes.map(note => {
    const links = relations
      .filter(r =>
        r.sourceType === 'knowledge' && r.sourceId === note.id &&
        byId.has(r.targetId))
      .map(r => ({
        targetTitle: byId.get(r.targetId)!.title,
        relationType: r.relationType,
      }))
    return knowledgeToMarkdown(note, links)
  })
}

// ============================================================
// 写入目标：目录句柄（File System Access）或浏览器下载回退
// ============================================================

export interface WritableDirHandle {
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<{
    createWritable(): Promise<{ write(data: any): Promise<void>; close(): Promise<void> }>
  }>
}

export async function writeToDirectory(
  dir: WritableDirHandle,
  files: { path: string; content: string }[],
  subfolder = 'EvanOS'
): Promise<number> {
  let folder = dir
  try {
    folder = await dir.getFileHandle(subfolder, { create: true } as any) as unknown as WritableDirHandle
  } catch { /* 某些实现不支持目录嵌套，退回根目录 */ }
  for (const f of files) {
    const fh = await folder.getFileHandle(f.path, { create: true })
    const w = await fh.createWritable()
    await w.write(f.content)
    await w.close()
  }
  return files.length
}

export function downloadFile(filename: string, content: string, mime = 'text/plain'): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/** 单文件回退：所有笔记合并为一个 Obsidian 可打开的 md */
export function mergeVaultToSingleFile(files: { path: string; content: string }[]): string {
  return files.map(f => `%% ${f.path} %%\n${f.content}`).join('\n\n---\n\n')
}

// ============================================================
// MySQL / SQL 导出
// ============================================================

function sqlValue(v: any): string {
  if (v === undefined || v === null) return 'NULL'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  if (typeof v === 'boolean') return v ? '1' : '0'
  if (typeof v === 'object') return quoteSql(JSON.stringify(v))
  return quoteSql(String(v))
}

function quoteSql(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/\n/g, '\\n').replace(/\r/g, '')}'`
}

function sqlTypeOf(values: any[]): string {
  for (const v of values) {
    if (v === undefined || v === null) continue
    if (typeof v === 'number') return 'DOUBLE'
    if (typeof v === 'boolean') return 'TINYINT(1)'
    if (typeof v === 'object') return 'JSON'
    return 'TEXT'
  }
  return 'TEXT'
}

/**
 * 生成完整 MySQL 导入脚本：
 *   mysql -u root -p evan_os < evan-os-export.sql
 */
export async function generateSqlDump(options?: { tables?: string[] }): Promise<string> {
  const tableNames = options?.tables ?? Object.keys(TABLES)
  const out: string[] = [
    '-- Evan OS v1.0 全库导出',
    `-- generated: ${now()}`,
    '-- 用法: mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS evan_os CHARACTER SET utf8mb4" && mysql -u root -p evan_os < this-file.sql',
    'SET NAMES utf8mb4;',
    'SET FOREIGN_KEY_CHECKS = 0;',
    '',
  ]

  for (const name of tableNames) {
    const table = (TABLES as Record<string, any>)[name]
    if (!table) continue
    const rows: Record<string, any>[] = await table.toArray()
    out.push(`-- ---- ${name} (${rows.length} rows) ----`)
    out.push(`DROP TABLE IF EXISTS \`${name}\`;`)

    if (rows.length === 0) {
      out.push(`CREATE TABLE \`${name}\` (\`id\` VARCHAR(64) PRIMARY KEY);`, '')
      continue
    }

    // 列集合：取所有行字段的并集
    const colSet = new Set<string>()
    for (const row of rows) for (const k of Object.keys(row)) colSet.add(k)
    const cols = [...colSet]
    const colDefs = cols.map(c => {
      const vals = rows.map(r => r[c])
      const isId = c === 'id'
      return `\`${c}\` ${sqlTypeOf(vals)}${isId ? ' PRIMARY KEY' : ''}`
    })
    out.push(`CREATE TABLE \`${name}\` (${colDefs.join(', ')});`)

    const colList = cols.map(c => `\`${c}\``).join(', ')
    for (const row of rows) {
      const values = cols.map(c => sqlValue(row[c])).join(', ')
      out.push(`REPLACE INTO \`${name}\` (${colList}) VALUES (${values});`)
    }
    out.push('')
  }

  out.push('SET FOREIGN_KEY_CHECKS = 1;', `-- done ${uid()}`)
  return out.join('\n')
}
