// 信件形态守卫：判断一段文本「像不像一封可直接发送的英文商务邮件」
// 用途：批量AI回复出口处的兜底校验 —— 模型偶发输出分析 JSON / 说明文字时，
// 该判断为 false → 默认不勾选入队并提示人工改写，避免把 JSON 发给客户。

/** 去掉 markdown 代码围栏后的整体是否就是一个 JSON 对象 */
export function isWholeJsonObject(text: string): boolean {
  const s = String(text || '').trim().replace(/^```[a-zA-Z]*\s*/i, '').replace(/\s*```$/, '').trim()
  if (!s.startsWith('{') || !s.endsWith('}')) return false
  try { JSON.parse(s); return true } catch { return false }
}

/** 像不像一封信：问候语开头 + 商务落款结尾，且不是 JSON/键值对文本 */
export function looksLikeEmail(body: string): boolean {
  const s = String(body || '').trim()
  if (!s) return false
  // 整段是 JSON（含 ```json 围栏）→ 不是信
  if (isWholeJsonObject(s)) return false
  // 开头就是大括号/围栏，或前 120 字内出现 "key": 结构 → 判为非信
  if (s.startsWith('{') || s.startsWith('```')) return false
  if (/"[a-z_]+":\s*/i.test(s.slice(0, 120))) return false

  const hasGreeting = /\b(Hi|Hey|Hello|Dear|To)\b[^\n]{0,60}/i.test(s)
  const hasSignoff = /\b(Best regards|Kind regards|Warm regards|Yours|Sincerely|Regards|Thanks|Cheers),/i.test(s)
  return hasGreeting && hasSignoff
}
