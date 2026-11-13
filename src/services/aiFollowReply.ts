// 批量AI回复核心：两阶段生成（分析 → 写信）+ 开篇槽位轮换 + shingleSim 去重
// 目标：不同客户产出「策略不同」的邮件，而非只换措辞；重复时自动换角度重写。
import type { Customer, EmailMessage } from '../types'
import { FOLLOW_ANALYSIS_SYSTEM_PROMPT, FOLLOW_WRITE_SYSTEM_PROMPT, buildAnalysisPrompt, buildWritePrompt } from '../config/aiFollowPrompt'
import { buildFollowReplyContext, buildBatchContextText, generateAiFollowReply, shingleSim, type FollowReplyOpts } from './followProfile'
import { isWholeJsonObject } from '../utils/mailShape'
import { chatOnce } from './aiChat'

/** 开篇方式槽位（只影响开篇与篇幅，不影响策略 —— 策略由阶段A 判断决定） */
const OPENER_HINTS = [
  '开门见山，第一句就点出这次联系的具体原因，不要寒暄套话。',
  '以对方最近邮件里的某一句话/某个细节切入，自然承接。',
  '用一个与客户业务相关的具体事实或数据切入，不要泛泛而谈。',
  '以一个客户容易回答的具体问题切入，低压力、易回复。',
  '极简开场：两三句内直接进入正题，不要铺垫。',
  '先给一点对客户有价值的信息（如工艺/材质/交期要点），再自然过渡到本次目标。',
]
const LENGTH_HINTS = [
  '篇幅约 120 词，尽量精炼。',
  '篇幅约 180 词，标准跟进长度。',
  '篇幅约 240 词，可稍展开说明，但仍不要冗长。',
]

export type SmartReplyResult = {
  subject: string
  body: string
  /** 阶段A 的分析（deep 模式才有） */
  analysis?: { state?: string; goal?: string; strategy?: string; insufficient?: boolean }
  /** 与本批已有正文的最大相似度（0-1），>阈值时标黄 */
  dupSim?: number
  /** 最相似的那一封的客户名（用于角标提示） */
  dupWith?: string
  /** 是否走了降级（deep 解析失败 / 单阶段） */
  degraded?: boolean
}

export type SmartReplyInput = {
  extraPrompt?: string
  /** 深度分析（两阶段） */
  deep?: boolean
  index?: number
  total?: number
  prior?: { opening?: string; strategy?: string }[]
  /** 本批已完成正文（用于 shingleSim 去重） */
  priorBodies?: { name: string; body: string }[]
  /** 重复阈值，超过则换角度重试一次 */
  dupThreshold?: number
  temperature?: number
}

/** 从 AI 返回文本里稳健地抽出 JSON 对象（剥围栏 / 取首个 { 到末个 }） */
function extractJsonObject(text: string): any | null {
  const s = String(text || '').trim()
  if (!s) return null
  const stripped = s.replace(/```json\s*/gi, '').replace(/```\s*/g, '')
  const first = stripped.indexOf('{')
  const last = stripped.lastIndexOf('}')
  if (first < 0 || last <= first) return null
  try { return JSON.parse(stripped.slice(first, last + 1)) } catch { return null }
}

/** 从 AI 返回的混杂文本中提取纯邮件正文：
 *  去掉阶段A的 JSON 分析块、中文阶段标记、markdown 围栏、思考痕迹；
 *  修复签名与人名粘连（如 Yours,Evan → Yours,\nEvan）。
 *  整段是 JSON（模型在写信阶段输出了分析对象）→ 返回空串，让调用方重试/走兜底，
 *  绝不能把 JSON 原样当正文发给客户。
 */
export function extractEmailBody(text: string): string {
  const raw = String(text || '').trim()
  if (!raw) return ''
  // 整段就是 JSON（含 ```json 围栏）→ 生成失败
  if (isWholeJsonObject(raw)) return ''

  let s = raw

  // 去掉 markdown 代码围栏（```json ... ```）
  s = s.replace(/```[\s\S]*?```/g, '')

  // 去掉独立的 JSON 对象块（{ ... }）
  s = s.replace(/{[\s\S]*?}/g, '')

  // 去掉中文阶段标记，如 【阶段 A·JSON 分析对象】、【阶段 B·邮件正文】
  s = s.replace(/【[^】]*】/g, '')

  // 去掉残留的 analysis / client_status / strategy / goal / state 等键值对残渣
  s = s.replace(/"(analysis|client_status|unresolved_issues|core_objective|strategy_rationale|customization_hooks|state|goal|strategy|subject|evidence|insufficient|swapTest)"\s*:\s*[^,}]+/g, '')

  // 去掉常见 AI 思考前缀
  s = s.replace(/^(这里是|以下是|邮件正文[:：]\s*|正文[:：]\s*|阶段[AB][:：]\s*)/i, '')

  // 修复签名与人名粘连：常见敬语后若直接跟人名，强制插入换行
  const signoffs = ['Yours', 'Best regards', 'Kind regards', 'Warm regards', 'Sincerely', 'Thanks', 'Thank you', 'Cheers', 'Regards']
  for (const so of signoffs) {
    s = s.replace(new RegExp(`(${so}),\\s*([A-Z][a-zA-Z .'-]{1,40})`, 'g'), '$1,\n$2')
  }

  // 尝试提取从 "Hi/Dear/Hello" 开始到 "Best regards/Yours" 结束的正文段
  const hiMatch = s.match(/\b(Hi|Dear|Hello)\b[^\n]*/i)
  const signoffMatch = s.match(/\b(Yours|Best regards|Kind regards|Warm regards|Sincerely|Thanks|Thank you|Cheers|Regards),/i)

  if (hiMatch && signoffMatch && signoffMatch.index! > hiMatch.index!) {
    const start = hiMatch.index!
    const signoffEnd = signoffMatch.index! + signoffMatch[0].length // 落款逗号之后的下标
    // 落款后紧跟的人名（同行或下一行）一并保留；注意：必须基于**原串**下标计算，
    // 不能先 slice 再用旧下标去切（此前的写法会把 Evan 整个丢掉）。
    const nameMatch = s.slice(signoffEnd).match(/^\s*(?:\r?\n)?\s*([A-Z][A-Za-z'.-]{0,20}(?:\s+[A-Z][A-Za-z'.-]{0,20})?)/)
    const end = nameMatch ? signoffEnd + nameMatch[0].length : signoffEnd
    s = s.slice(start, end).trim()
  } else if (hiMatch) {
    s = s.slice(hiMatch.index!).trim()
  }

  // 清理多余空行
  s = s.replace(/\n{3,}/g, '\n\n').trim()
  if (s) return s

  // 剥空了：原文里含 JSON/代码块 → 视为生成失败，返回空串让调用方重试/兜底
  // （此前这里 `return s || text.trim()` 会把整段 JSON 原样放行成正文 —— 客户收到 JSON 的根因）
  if (raw.includes('{') || raw.includes('```')) return ''
  return raw
}

/** 与本批已有正文的最大相似度 + 最相似客户名 */
export function maxSimAgainst(body: string, priorBodies?: { name: string; body: string }[]): { sim: number; with?: string } {
  const list = (priorBodies || []).filter(x => x && x.body)
  if (!list.length || !String(body || '').trim()) return { sim: 0 }
  let sim = 0, withName: string | undefined
  for (const p of list) {
    const s = shingleSim(body, p.body)
    if (s > sim) { sim = s; withName = p.name }
  }
  return { sim, with: withName }
}

/** 生成单封（deep=两阶段；否则单阶段）。内部已做去重重试。 */
export async function generateSmartFollowReply(
  c: Customer,
  emails: EmailMessage[],
  input: SmartReplyInput = {},
): Promise<SmartReplyResult> {
  const ctx = buildFollowReplyContext(c, emails)
  const temperature = input.temperature ?? 0.9
  const opts: FollowReplyOpts = {
    index: input.index, total: input.total, prior: input.prior, temperature,
  }
  const batchContext = buildBatchContextText(opts)
  const extra = String(input.extraPrompt || '').trim().slice(0, 1000)

  // ── 阶段A：分析（仅 deep） ──
  let analysis: SmartReplyResult['analysis']
  let subjectOverride = ''
  if (input.deep) {
    try {
      const raw = await chatOnce(
        buildAnalysisPrompt({
          customer: ctx.customerLabel,
          portraitText: [ctx.portraitText, ctx.profileText].filter(Boolean).join('\n'),
          mailText: ctx.mailText,
          extra,
          insufficientHint: ctx.insufficient,
        }),
        FOLLOW_ANALYSIS_SYSTEM_PROMPT,
        { maxTokens: 800, temperature },
      )
      const j = extractJsonObject(raw)
      if (j && j.state) {
        analysis = {
          state: String(j.state || '').slice(0, 80),
          goal: String(j.goal || '').slice(0, 120),
          strategy: String(j.strategy || '').slice(0, 300),
          insufficient: !!j.insufficient,
        }
        subjectOverride = String(j.subject || '').trim().slice(0, 140)
        // 换名测试不通过 → 阶段B 强制换角度
        if (j.swapTest === false && analysis.strategy) {
          analysis.strategy = `${analysis.strategy}\n（注意：换名测试未通过，本封必须使用与客户强相关的真实细节，绝不可是通用套信）`
        }
      }
    } catch {
      analysis = undefined // 解析/调用失败 → 走单阶段降级
    }
  }

  const openerHint = OPENER_HINTS[(input.index || 0) % OPENER_HINTS.length]
  const lengthHint = LENGTH_HINTS[(input.index || 0) % LENGTH_HINTS.length]
  const portraitForPrompt = [ctx.portraitText, ctx.profileText].filter(Boolean).join('\n')

  const writeOnce = async (avoidText?: string, failNote?: string) => {
    const note = failNote ? `${extra ? `\n${extra}\n` : ''}【上一次输出无效】${failNote}` : extra
    if (analysis?.state && analysis.goal) {
      // 阶段B：只输出正文
      const raw = String(await chatOnce(
        buildWritePrompt({
          customer: ctx.customerLabel,
          portraitText: portraitForPrompt,
          mailText: ctx.mailText,
          extra: note,
          analysis: { state: analysis.state, goal: analysis.goal, strategy: analysis.strategy || '', unresolved: '' },
          batchContext,
          openerHint,
          lengthHint,
          avoidText,
        }),
        FOLLOW_WRITE_SYSTEM_PROMPT,
        { temperature },
      ) || '').trim()
      return extractEmailBody(raw)
    }
    // 单阶段（deep 关 或 阶段A 失败）：沿用已升级数据层的 generateAiFollowReply
    const r = await generateAiFollowReply(c, emails, note || input.extraPrompt, opts)
    return extractEmailBody(r.body)
  }

  let body = await writeOnce()
  const fallback = `Hi ${c.contactName || c.title || 'there'},\n\nJust wanted to follow up on your project. Let me know if you have any questions.\n\nBest regards,\nEvan`
  // 首次输出是 JSON/空 → 带「输出无效」提示重写一次，仍失败才落兜底模板
  if (!body) {
    const retry = await writeOnce(undefined, '你上一次返回的是分析 JSON 或空内容，而不是邮件正文。这次必须只输出可直接发送的英文邮件正文（Hi/Hey 开头，Best regards, Evan 落款），禁止任何 JSON、字段名或解释。')
    if (retry) body = retry
  }
  if (!body) body = fallback

  // ── 去重重试：与本批已有正文相似度超阈值 → 带负面示例重写一次 ──
  const threshold = input.dupThreshold ?? 0.55
  let { sim, with: withName } = maxSimAgainst(body, input.priorBodies)
  if (sim > threshold) {
    const avoidText = (input.priorBodies || [])
      .filter(p => p.body && shingleSim(body, p.body) > threshold)
      .slice(0, 2)
      .map(p => `- ${p.name}：${p.body.replace(/\s+/g, ' ').slice(0, 600)}`)
      .join('\n')
    const retry = await writeOnce(avoidText || undefined)
    if (retry && retry !== body) {
      const r2 = maxSimAgainst(retry, input.priorBodies)
      if (r2.sim < sim) { body = retry; sim = r2.sim; withName = r2.with }
    }
  }

  // ── 主题：优先阶段A → 会话 → 产品式 ──
  let subject = subjectOverride
  if (!subject) {
    const { findLatestThreadHeaders } = await import('../repositories/emailRepository')
    const { normalizeReplySubject } = await import('../utils/mailHtml')
    const th = await findLatestThreadHeaders(c.email || '').catch(() => ({ found: false, subject: '' } as any))
    const product = (c.portrait as any)?.products?.[0] || 'your project'
    subject = th.found && th.subject ? normalizeReplySubject(th.subject) : `Following up - ${product}`
  } else if (!/^re:/i.test(subject)) {
    const { normalizeReplySubject } = await import('../utils/mailHtml')
    subject = normalizeReplySubject(subject)
  }

  return {
    subject,
    body,
    analysis,
    dupSim: sim,
    dupWith: withName,
    degraded: input.deep && !analysis,
  }
}
