// ====== AiChat 邮件/客户上下文组装（纯函数，可单测） ======
// 事故背景（2026-11 线上）：emailCtx 曾经「组装完成却没拼进 system 消息」——
// 模型只收到"数据已在上下文"的指令、看不到任何邮件内容，
// 于是回答"当前上下文中并未提供该客户的邮件或档案数据"。
// 这里把抽取/过滤/拼装拆成纯函数，由 test-ai-chat-context.ts 做回归。

export interface MailLike {
  from?: string
  to?: string
  subject?: string
  text?: string
  html?: string
  date?: string
  uid?: number | string
  accountId?: string
  imapFolder?: string
  folder?: string
}

export interface CustomerLike {
  id?: string
  email?: string
  extraEmails?: string[]
  contactName?: string
  title?: string
  company?: string
  level?: string
  stage?: string
  repurchaseCount?: number
  notes?: string
  aiSummary?: string
}

/** 正文覆盖统计：total=进入上下文的邮件数，withBody=真有正文的封数 */
export interface MailCtxStat { total: number; withBody: number; missingBody: number }

/** 邮件数据块的头部标记 */
export const MAIL_CTX_HEADER = '\n\n【系统已读取并提供以下真实邮件/客户数据 — 你必须基于这些内容分析】\n'
/** 有邮件数据时附加给模型的纪律指令 */
export const MAIL_CTX_RULE = '\n\n【重要】用户提供的客户邮件与档案已经在上下文中。你必须阅读、提炼、总结这些邮件内容来回答。严禁回答「无法访问邮件/系统/数据库」。若数据不足，请说明缺哪封邮件，而不是说自己没有权限。'

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

/** 从用户消息里抽邮箱（小写去重，最多在组装时用前 3 个） */
export function extractMailHits(text: string): string[] {
  return [...new Set((String(text || '').match(EMAIL_RE) || []).map(x => x.toLowerCase()))]
}

/** 正文 = text，缺则用去标签的 html；统一去掉 HTML 标签并 trim */
export function mailBodyOf(m: MailLike): string {
  const raw = String(m.text || m.html || '')
  return raw.replace(/<[^>]+>/g, ' ').trim()
}

export function mailHasBody(m: MailLike): boolean {
  return mailBodyOf(m).length > 0
}

/**
 * 取某地址相关的邮件：按 from/to 匹配 → 按日期倒序 → 截断。
 * 同 accountId+uid 的重复行（本地空壳信封 + 远端带正文）只留一条，且优先保留有正文的那条。
 */
export function mailsForAddress<T extends MailLike>(all: T[], em: string, limit = 10): T[] {
  const key = String(em || '').toLowerCase()
  const byKey = new Map<string, T>()
  const unkeyed: T[] = []
  for (const m of all) {
    const from = String(m.from || '').toLowerCase()
    const to = String(m.to || '').toLowerCase()
    if (!from.includes(key) && !to.includes(key)) continue
    if (m.uid != null && m.accountId) {
      const k = `${m.accountId}-${m.uid}`
      const prev = byKey.get(k)
      if (!prev || (!mailHasBody(prev) && mailHasBody(m))) byKey.set(k, m)
    } else {
      unkeyed.push(m)
    }
  }
  return [...byKey.values(), ...unkeyed]
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, limit)
}

export function isOurSide(from: string): boolean {
  return /evan@maxemblem/i.test(String(from || ''))
}

/** 客户档案块；无建档时给占位邮箱块 */
export function buildCustomerPart(em: string, c: CustomerLike | null | undefined): { part: string; linkedCustomerId: string } {
  if (!c) return { part: `【客户邮箱】${em}（暂无详细建档）`, linkedCustomerId: '' }
  return {
    linkedCustomerId: String(c.id || ''),
    part: `【客户档案】${c.contactName || c.title || ''} ${c.email || em} 公司${c.company || '—'} 等级${c.level || 'C'} 阶段${c.stage || ''} 复购${c.repurchaseCount || 0} 备注${c.notes || ''} 画像摘要${c.aiSummary || ''}`,
  }
}

/** 单封邮件块：发件方 + 主题 + 正文（截 900 字）；缺正文显式标「(无正文)」 */
export function buildMailPart(m: MailLike): string {
  const body = mailBodyOf(m).slice(0, 900)
  return `[${m.date || ''}] ${isOurSide(String(m.from || '')) ? '我方' : '客户'} 主题：${m.subject || '(无)'}\n${body || '(无正文)'}`
}

/** 组装单个邮箱的全部片段 + 正文覆盖统计 + 关联客户 id */
export function buildPartsForAddress(
  em: string,
  customer: CustomerLike | null | undefined,
  mails: MailLike[],
): { parts: string[]; stat: MailCtxStat; linkedCustomerId: string } {
  const cp = buildCustomerPart(em, customer)
  const parts = [cp.part]
  const shown = mails.slice(0, 10)
  for (const m of shown) parts.push(buildMailPart(m))
  if (!shown.length) {
    parts.push(`（未找到 ${em} 的邮件正文。请到邮件中心点「拉邮件」同步后再问；或粘贴邮件内容。）`)
  }
  const withBody = shown.filter(mailHasBody).length
  return {
    parts,
    stat: { total: shown.length, withBody, missingBody: shown.length - withBody },
    linkedCustomerId: cp.linkedCustomerId,
  }
}

/** 把所有片段合成 emailCtx（带数据块头部；整体截 16000 字） */
export function buildEmailCtx(parts: string[]): string {
  if (!parts.length) return ''
  return MAIL_CTX_HEADER + parts.join('\n\n---\n\n').slice(0, 16000)
}

/**
 * P0 核心：把邮件数据真正拼进发给模型的 system 消息。
 * 回归点：emailCtx 不能只当布尔值用（旧 bug：造好了数据却只拼指令）。
 */
export function buildSystemPrompt(baseSys: string, emailCtx: string): string {
  return emailCtx ? `${baseSys}${MAIL_CTX_RULE}${emailCtx}` : baseSys
}

/** 输入区提示：按「有正文的封数」统计，并透出取数错误（不再静默） */
export function buildMailLoadNote(x: { hits: string[]; stat: MailCtxStat; errors: string[] }): string {
  const { hits, stat, errors } = x
  if (!hits.length) return ''
  const err = errors.length ? `；⚠ ${errors[0]}${errors.length > 1 ? ` 等${errors.length}项` : ''}` : ''
  if (stat.withBody > 0) {
    const miss = stat.missingBody > 0 ? `（${stat.missingBody} 封缺正文）` : ''
    return `已读取 ${stat.withBody}/${stat.total} 封邮件正文${miss}，AI 可基于正文分析${err}`
  }
  if (stat.total > 0) return `找到 ${stat.total} 封 ${hits[0]} 的邮件但正文为空，请到邮件中心点「拉邮件」同步${err}`
  return `未找到 ${hits[0]} 的邮件正文，请先在邮件中心「拉邮件」或直接粘贴邮件${err}`
}
