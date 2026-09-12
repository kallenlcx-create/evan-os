// ====== 邮件 AI 服务（真实LLM + 智能兜底）======
import type { EmailIntent, EmailMessage } from '../types'
import { extractAmount, extractQty, extractProduct } from '../utils/emailHelpers'

// ====== 意图分类（16类）======
const INTENT_KEYWORDS: Record<EmailIntent, string[]> = {
  '新询价': ['inquiry','询价','quote','price','quotation','interested','need','want','looking for','searching','do you have','can you make','custom',' personalized'],
  '报价回复': ['replied','quote sent','proposal','attached','please find','as discussed','per your request'],
  '询问价格': ['price','cost','how much','报价','pricing','rate','discount','cheaper','best price'],
  '询问交期': ['lead time','delivery','交期','when','ETA','timeline','how long','urgent rush'],
  '修改设计': ['design','artwork','modify','change','revision','adjust','update','fix','alter'],
  '确认订单': ['confirm','order','proceed','purchase','place order','go ahead','approved','accept'],
  '付款': ['payment','paid','invoice','paypal','wire','transfer','bank','receipt','transaction'],
  '样品': ['sample','样品','trial','test piece','prototype'],
  '催货': ['催','follow up','urgent','where is my order','status','update','pending','overdue'],
  '售后': ['after sales','售后','defect','broken','damaged','quality issue','wrong','missing'],
  '投诉': ['complaint','投诉','angry','unacceptable','disappointed','refund','compensation'],
  '物流': ['shipping','tracking','logistics','物流','dispatch','shipped','carrier','delivery status'],
  '复购': ['reorder','again','repeat','复购','same as before','last time','another batch','continuation'],
  '营销机会': ['campaign','promotion','营销','bulk order','volume','wholesale','distributor'],
  '暂时没有需求': ['not need','no demand','later','maybe next time','not now','postpone'],
  '已读不回': ['no reply','ghost'],
  '其他': [],
}

export async function classifyIntent(text: string): Promise<EmailIntent> {
  const t = text.toLowerCase()
  let best: EmailIntent = '其他'
  let score = -1
  for (const [intent, kws] of Object.entries(INTENT_KEYWORDS) as [EmailIntent, string[]][]) {
    if (intent === '其他') continue
    const hit = kws.filter(k => t.includes(k.toLowerCase())).length
    if (hit > score) { score = hit; best = intent }
  }
  if (score <= 0) {
    if (/\d+\s*(pcs|pieces|units|件|个)/i.test(t)) best = '新询价'
    else if (/thank|thanks|appreciate/i.test(t)) best = '其他'
    else best = '其他'
  }
  return best
}

// ====== 翻译（真实 LLM 或智能兜底）======
export async function translateEnToZh(text: string): Promise<string> {
  if (!text.trim()) return ''
  // 尝试调用真实 LLM
  const llmResult = await callLLM(`你是一个专业的外贸邮件翻译助手。请将以下英文邮件翻译成中文，保留专业术语（如Coin/Medal/Patch等产品名不翻译），保持邮件格式。只返回翻译结果，不要添加额外说明。\n\n邮件内容：\n${text.slice(0, 3000)}`)
  if (llmResult) return llmResult
  // 智能兜底翻译
  return heuristicTranslate(text)
}

function heuristicTranslate(text: string): string {
  const translations: [RegExp, string][] = [
    [/Hi\s+(\w+),?/gi, '你好 $1，'],
    [/Dear\s+(\w+),?/gi, '尊敬的 $1，'],
    [/I hope you are doing well/gi, '希望您一切顺利'],
    [/I hope this email finds you well/gi, '希望此邮件找到您时一切安好'],
    [/I wanted to follow up/gi, '我想跟进一下'],
    [/Just checking in/gi, '只是想确认一下'],
    [/Looking forward to hearing from you/gi, '期待您的回复'],
    [/Please let me know if you have any questions/gi, '如有任何问题请告诉我'],
    [/Thank you for your inquiry/gi, '感谢您的询价'],
    [/Thank you for your time/gi, '感谢您的时间'],
    [/Best regards/gi, '此致敬礼'],
    [/Kind regards/gi, '此致敬礼'],
    [/Sincerely/gi, '此致敬礼'],
    [/Thanks/gi, '谢谢'],
    [/Please find attached/gi, '请查收附件'],
    [/As discussed/gi, '如我们所讨论的'],
    [/Per your request/gi, '根据您的要求'],
    [/We can offer/gi, '我们可以提供'],
    [/Our best price/gi, '我们的最优价格'],
    [/Lead time/gi, '交货周期'],
    [/Custom design/gi, '定制设计'],
    [/Challenge Coin/gi, '挑战币'],
    [/Coin/gi, '纪念币'],
    [/Medal/gi, '奖章'],
    [/Patch/gi, '臂章'],
    [/Pin/gi, '胸针'],
    [/Badge/gi, '徽章'],
    [/\$[\d,]+/g, '¥$&'],
    [/(\d+)\s*pcs/gi, '$1件'],
  ]
  let result = text
  for (const [pattern, replacement] of translations) {
    result = result.replace(pattern, replacement)
  }
  return result + '\n\n[AI翻译·仅供参考，原文见上]'
}

// ====== 邮件摘要 ======
export async function summarizeEmail(m: EmailMessage): Promise<string> {
  const llmResult = await callLLM(`请用中文总结这封外贸邮件的要点（2-3句话），包括：客户意图、产品需求、数量、预算、关键信息。\n\n主题：${m.subject}\n发件人：${m.from}\n内容：\n${(m.text || '').slice(0, 2000)}`)
  if (llmResult) return llmResult
  // 智能兜底
  const text = m.text || m.subject || ''
  const qty = extractQty(text) || m.qty || 500
  const product = extractProduct(text) || m.product || 'Coin'
  const amount = extractAmount(text)
  const intent = m.intent || '新询价'
  let summary = `📧 ${m.subject || '无主题'}\n`
  summary += `👤 ${m.from?.split('<')[0]?.trim() || '未知'}\n`
  summary += `🎯 意图：${intent}\n`
  summary += `📦 产品：${product} × ${qty}件`
  if (amount > 0) summary += ` (约$${amount.toLocaleString()})`
  summary += '\n'
  if (m.deadline) summary += `📅 交期：${m.deadline}\n`
  if (m.budget) summary += `💰 预算：${m.budget}\n`
  summary += `📝 ${text.slice(0, 150).replace(/\n/g, ' ')}...`
  return summary
}

// ====== 客户画像 ======
export interface Portrait {
  customerType: string
  business: string
  score: number
  potential: string[]
  communicationStyle: string
  engagementLevel: string
}

export async function buildPortrait(_customerEmail: string, history: EmailMessage[]): Promise<Portrait> {
  const llmResult = await callLLM(`基于以下邮件往来历史，分析这个客户的画像。返回JSON格式：{"customerType":"类型","business":"业务描述","score":0-100,"potential":["可能感兴趣的产品"],"communicationStyle":"沟通风格","engagementLevel":"互动水平(high/medium/low)"}\n\n邮件历史（最近10封）：\n${history.slice(-10).map(e => `[${e.date}] ${e.folder === 'sent' ? '发给' : '来自'} ${e.from}: ${e.subject} | ${(e.text || '').slice(0, 200)}`).join('\n')}`)
  if (llmResult) {
    try {
      const parsed = JSON.parse(llmResult.replace(/```json\n?/g, '').replace(/```\n?/g, ''))
      return parsed
    } catch {}
  }
  // 智能兜底
  const count = history.length
  const hasCoin = history.some(h => /coin/i.test(h.product || ''))
  const hasMedal = history.some(h => /medal/i.test(h.product || ''))
  const sentCount = history.filter(h => h.folder === 'sent').length
  const receivedCount = count - sentCount
  const totalAmount = history.reduce((s, h) => s + extractAmount(h.text || ''), 0)
  let customerType = 'End Customer'
  if (count > 20) customerType = 'Distributor'
  else if (count > 10) customerType = 'Wholesaler'
  else if (count > 5) customerType = 'Retailer'

  const products = []
  if (hasCoin) products.push('Challenge Coin')
  if (hasMedal) products.push('Medal')
  if (history.some(h => /patch/i.test(h.product || ''))) products.push('Patch')
  if (history.some(h => /pin/i.test(h.product || ''))) products.push('Pin')
  if (history.some(h => /badge/i.test(h.product || ''))) products.push('Badge')
  if (products.length === 0) products.push('Coin', 'Medal')

  return {
    customerType,
    business: `外贸客户，${count}次邮件往来，累计金额约$${totalAmount.toLocaleString()}`,
    score: Math.min(95, 40 + count * 3 + (totalAmount > 10000 ? 20 : 0)),
    potential: products,
    communicationStyle: sentCount > receivedCount ? '主动跟进型' : '被动回复型',
    engagementLevel: count > 20 ? 'high' : count > 5 ? 'medium' : 'low',
  }
}

// ====== 跟进建议 ======
export function suggestFollowUpDate(intent: EmailIntent, text: string): string {
  const d = new Date()
  switch (intent) {
    case '新询价': d.setDate(d.getDate() + 2); break
    case '报价回复': d.setDate(d.getDate() + 3); break
    case '催货': d.setDate(d.getDate() + 1); break
    case '确认订单': d.setDate(d.getDate() + 1); break
    case '付款': d.setDate(d.getDate() + 5); break
    case '样品': d.setDate(d.getDate() + 7); break
    case '复购': d.setDate(d.getDate() + 14); break
    default:
      if (/team|discuss/i.test(text)) d.setDate(d.getDate() + 5)
      else d.setDate(d.getDate() + 7)
  }
  return d.toISOString().slice(0, 10)
}

// ====== 邮件重要度评分（0-100）======
export function calculateImportance(m: EmailMessage): number {
  let score = 50 // 基础分
  // 意图加分
  const highIntent = ['新询价', '确认订单', '复购', '付款']
  const medIntent = ['报价回复', '询问价格', '催货']
  if (highIntent.includes(m.intent || '')) score += 25
  else if (medIntent.includes(m.intent || '')) score += 15
  // 金额加分
  const amount = extractAmount(m.text || '')
  if (amount >= 10000) score += 20
  else if (amount >= 5000) score += 10
  else if (amount >= 1000) score += 5
  // 数量加分
  const qty = extractQty(m.text || '') || m.qty || 0
  if (qty >= 1000) score += 10
  else if (qty >= 500) score += 5
  // 附件加分
  if (m.hasAttachment) score += 5
  // 未读扣分（表示可能被忽略）
  if (!m.isRead) score -= 5
  return Math.max(0, Math.min(100, score))
}

// ====== LLM 调用（尝试 ARK API，失败则返回 null）======
async function callLLM(prompt: string): Promise<string | null> {
  try {
    // 尝试从 localStorage 获取 ARK API 配置
    const raw = localStorage.getItem('evan:arkConfig')
    if (!raw) return null
    const config = JSON.parse(raw)
    if (!config.apiKey || !config.baseUrl) return null

    const response = await fetch(`${config.baseUrl}/v3/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model || 'doubao-1-5-pro-32k-250115',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1000,
        temperature: 0.3,
      }),
    })
    if (!response.ok) return null
    const data = await response.json()
    return data.choices?.[0]?.message?.content || null
  } catch {
    return null
  }
}
