// ====== 批量搜索匹配器：客户页 / 跟进页共用 ======
// 分组语义（全 OR）：
//   - 空格 / 逗号（中英文）/ 分号 / 换行 / 顿号 / 竖线 分隔的多个词 = 任一命中即命中
//     → 支持批量粘贴 10 个邮箱，也支持多词公司名 OR（如 ABC Tactical 命中任一词）
//   - 双引号包住的内容 = 一个整体短语，需连续出现才命中（精确短语逃生口）
//   - 无缝粘连的邮箱（support@ubersuggest.comjohn@abc.com）自动在 TLD 后拆开
//   - 每个 token 按子串包含匹配（不区分大小写）

let cacheKey: string | null = null
let cacheVal: string[] = []

/** 把用户输入解析成去重后的搜索 token 列表（小写） */
export function parseSearch(input: string): string[] {
  const s = String(input ?? '')
  if (s === cacheKey) return cacheVal
  const out: string[] = []
  if (s.trim()) {
    let t = s
    // 1) 引号短语单独成 token（保留内部空格）
    t = t.replace(/"([^"]+)"|“([^”]+)”/g, (_m, a, b) => {
      const p = String(a ?? b ?? '').trim().toLowerCase()
      if (p) out.push(p)
      return ' '
    })
    // 2) 其余按分隔符切 token
    for (const raw of t.split(/[\s,，;；|、]+/)) {
      let w = raw.trim()
      if (!w) continue
      // 3) 同一 token 内出现 ≥2 个 @ = 无缝粘连，在已知 TLD 后断开
      let pieces = [w]
      if ((w.match(/@/g) || []).length > 1) {
        const fixed = w.replace(/\.(com|net|org|edu|gov|io|ai|me|tv|cc|cn|uk|de|fr|jp|ru|kr|au|ca|us|info|biz|xyz|top|site|online|app|dev|store|live|world)(?=[\w][\w.+-]*@)/gi, '.$1\n')
        pieces = fixed.split('\n')
      }
      for (const piece of pieces) {
        // 去掉包裹标点：<>、()、[]、引号、句末句号/逗号
        const v = piece.trim().toLowerCase().replace(/^[<(\[«“"'`]+|[>)\]»”"'`.,;，。]+$/g, '')
        if (v) out.push(v)
      }
    }
  }
  const uniq = [...new Set(out)]
  cacheKey = s
  cacheVal = uniq
  return uniq
}

/**
 * 批量匹配：任一 token 命中即 true。
 * @param textBlob 文本字段拼接（姓名/公司/主题/询盘号等）
 * @param emails   该行的邮箱列表（主邮箱 + extraEmails）
 */
export function matchSearch(input: string, textBlob: string, emails: string[] = []): boolean {
  const terms = parseSearch(input)
  if (!terms.length) return false
  const hay = (String(textBlob || '') + ' ' + emails.filter(Boolean).join(' ')).toLowerCase()
  return terms.some(t => hay.includes(t))
}
