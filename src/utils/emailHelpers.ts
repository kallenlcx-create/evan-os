// ====== 邮件相关公共工具函数 ======

// 个人邮箱域名列表
export const PERSONAL_DOMAINS = new Set([
  'gmail.com','yahoo.com','hotmail.com','outlook.com','live.com','aol.com','icloud.com',
  'mail.com','protonmail.com','zoho.com','yandex.com','163.com','126.com','qq.com',
  'foxmail.com','sina.com','sohu.com','yeah.net','139.com','189.cn','wo.cn',
])

// 从邮件地址提取公司域名
export function extractDomain(email: string): string {
  const match = email.match(/@([\w.-]+)/)
  return match ? match[1].toLowerCase() : ''
}

// 邮箱类型分类
export function classifyEmailType(email: string): { label: string; color: string; category: 'personal'|'government'|'military'|'education'|'organization'|'company' } {
  const domain = extractDomain(email)
  if (domain.endsWith('.gov.cn') || domain.endsWith('.gov')) return { label: '政府', color: 'bg-red-100 text-red-600', category: 'government' }
  if (domain.endsWith('.mil.cn') || domain.endsWith('.mil') || email.includes('pla.')) return { label: '军队', color: 'bg-orange-100 text-orange-600', category: 'military' }
  if (domain.endsWith('.edu.cn') || domain.endsWith('.edu') || domain.endsWith('.ac.cn')) return { label: '教育', color: 'bg-blue-100 text-blue-600', category: 'education' }
  if (domain.endsWith('.org.cn') || domain.endsWith('.org')) return { label: '非盈利', color: 'bg-purple-100 text-purple-600', category: 'organization' }
  if (PERSONAL_DOMAINS.has(domain)) return { label: '个人', color: 'bg-gray-100 text-gray-600', category: 'personal' }
  return { label: '企业', color: 'bg-green-100 text-green-600', category: 'company' }
}

// 从邮件正文提取金额（支持多种货币格式）
export function extractAmount(text: string): number {
  if (!text) return 0
  const patterns = [
    /\$\s*([\d,]+(?:\.\d{1,2})?)/g,           // $1,234.56
    /USD\s*([\d,]+(?:\.\d{1,2})?)/gi,         // USD 1234
    /(?:金额|总价|价格|报价|费用|预算)[：:\s]*[\$¥€]?\s*([\d,]+(?:\.\d{1,2})?)/g, // 金额：$1234
    /(?:total|amount|price|budget|cost)[：:\s]*[\$¥€]?\s*([\d,]+(?:\.\d{1,2})?)/gi, // total: $1234
    /[\$¥€]\s*([\d,]+(?:\.\d{1,2})?)/g,       // ¥1234
  ]
  let max = 0
  for (const p of patterns) {
    let m
    while ((m = p.exec(text)) !== null) {
      const n = parseFloat(m[1].replace(/,/g, ''))
      if (n > max) max = n
    }
  }
  return max
}

// 从邮件正文提取数量
export function extractQty(text: string): number | null {
  if (!text) return null
  const patterns = [
    /(\d[\d,]*)\s*(?:pcs?|pieces?|units?|件|个|只|套|批)/i,
    /(?:数量|qty|quantity|order)[：:\s]*(\d[\d,]*)/i,
    /(?:需要|要|订|采购|购买)\s*(\d[\d,]*)\s*(?:个|件|只|套|批|pcs)/i,
  ]
  for (const p of patterns) {
    const m = p.exec(text)
    if (m) return parseInt(m[1].replace(/,/g, ''), 10)
  }
  return null
}

// 从邮件正文提取产品关键词
export function extractProduct(text: string): string {
  if (!text) return 'Coin'
  const products = ['coin', 'medal', 'pin', 'patch', 'badge', 'token', 'keychain', 'bottle opener', ' bookmark', ' plaque', ' trophy', ' cufflink', ' ring', ' pendant']
  const lower = text.toLowerCase()
  for (const p of products) {
    if (lower.includes(p)) return p.charAt(0).toUpperCase() + p.slice(1)
  }
  return 'Coin'
}

// 事件名常量
export const EVENTS = {
  EMAILS_UPDATED: 'evan-emails-updated',
  CUSTOMERS_UPDATED: 'evan-customers-updated',
  EMAIL_SYNC_PROGRESS: 'evan-email-sync-progress',
  EMAIL_SYNCED: 'evan-email-synced',
  EMAIL_CONFIG_CHANGED: 'evan-email-config-changed',
} as const

// 触发事件
export function emitEvent(name: string, detail?: any) {
  window.dispatchEvent(new CustomEvent(name, { detail }))
}

// 监听事件（返回清理函数）
export function onEvent(name: string, handler: (e: CustomEvent) => void): () => void {
  window.addEventListener(name, handler as EventListener)
  return () => window.removeEventListener(name, handler as EventListener)
}

// 客户阶段标签
export const STAGE_LABELS: Record<string, string> = {
  lead: '线索', contacted: '已联系', qualified: '已确认',
  proposal: '报价中', negotiation: '谈判中', won: '已成交', lost: '已流失',
}

// 等级标签
export const LEVEL_LABELS: Record<string, string> = {
  'A+': '⭐️⭐️⭐️ VIP', 'A': '⭐️⭐️ 重要', 'B': '⭐️ 一般', 'C': '普通', 'D': '沉睡',
}

// 等级颜色
export const LEVEL_COLORS: Record<string, string> = {
  'A+': 'text-yellow-600 bg-yellow-50 border-yellow-200',
  'A': 'text-blue-600 bg-blue-50 border-blue-200',
  'B': 'text-green-600 bg-green-50 border-green-200',
  'C': 'text-gray-600 bg-gray-50 border-gray-200',
  'D': 'text-red-600 bg-red-50 border-red-200',
}

// 意图颜色
export const INTENT_COLORS: Record<string, string> = {
  '新询价': 'bg-red-50 text-red-600',
  '报价回复': 'bg-blue-50 text-blue-600',
  '询问价格': 'bg-orange-50 text-orange-600',
  '催货': 'bg-yellow-50 text-yellow-700',
  '复购': 'bg-green-50 text-green-600',
  '确认订单': 'bg-indigo-50 text-indigo-600',
  '修改设计': 'bg-purple-50 text-purple-600',
  '其他': 'bg-gray-100 text-gray-500',
}
