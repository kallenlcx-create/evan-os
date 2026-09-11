// ====== 邮件 AI 服务（Mock可换真实 LLM）======
// 意图16类 / 翻译 / 摘要 / 画像 / 跟进建议
import type { EmailIntent, EmailMessage } from '../types'

const INTENT_KEYWORDS: Record<EmailIntent, string[]> = {
  '新询价': ['inquiry','询价','quote','price','quotation','interested','need','want'],
  '报价回复': ['replied','quote sent','proposal'],
  '询问价格': ['price','cost','how much','报价'],
  '询问交期': ['lead time','delivery','交期','when','ETA'],
  '修改设计': ['design','artwork','modify','change','revision'],
  '确认订单': ['confirm','order','proceed','purchase'],
  '付款': ['payment','paid','invoice','paypal','wire'],
  '样品': ['sample','样品'],
  '催货': ['催','follow up','urgent','where is my order'],
  '售后': ['after sales','售后','defect','broken'],
  '投诉': ['complaint','投诉','angry'],
  '物流': ['shipping','tracking','logistics','物流'],
  '复购': ['reorder','again','repeat','复购'],
  '营销机会': ['campaign','promotion','营销'],
  '暂时没有需求': ['not need','no demand','later'],
  '已读不回': ['no reply','ghost'],
  '其他': [],
}

export async function classifyIntent(text: string): Promise<EmailIntent> {
  const t = text.toLowerCase()
  let best: EmailIntent = '其他'
  let score = -1
  for (const [intent, kws] of Object.entries(INTENT_KEYWORDS) as [EmailIntent,string[]][]) {
    if (intent==='其他') continue
    const hit = kws.filter(k=> t.includes(k.toLowerCase())).length
    if (hit>score) { score=hit; best=intent }
  }
  if (score<=0) {
    if (t.includes('coin')||t.includes('patch')) best='新询价'
    else best='其他'
  }
  await new Promise(r=> setTimeout(r,40))
  return best
}

export async function translateEnToZh(text: string): Promise<string> {
  // Mock：真实接 LLM prompt "将下列外贸邮件译为中文保留称呼"
  await new Promise(r=> setTimeout(r,80))
  if (!text.trim()) return ''
  // 简单示意：把 Hi→你好，I hope→希望，保持原文结构
  return text
    .replace(/Hi\s+(\w+),?/gi,'你好 $1，')
    .replace(/I hope you are doing well/gi,'希望你一切顺利')
    .replace(/I wanted to follow up/gi,'想跟进一下')
    .replace(/Best regards/gi,'此致')
    + '\n\n[AI翻译·仅供参考，原文见上]'
}

export async function summarizeEmail(m: EmailMessage): Promise<string> {
  await new Promise(r=> setTimeout(r,60))
  const subj = m.subject || ''
  const qty = subj.match(/(\d+)\s*(pcs|枚)/i)?.[1] ?? '500'
  return `客户需要${qty}枚${m.product||'Coin'}，预算约$${(Number(qty)*4).toFixed(0)}，意图：${m.intent||'新询价'}`
}

export interface Portrait {
  customerType: string
  business: string
  score: number
  potential: string[]
}

export async function buildPortrait(customerEmail: string, history: EmailMessage[]): Promise<Portrait> {
  void customerEmail
  await new Promise(r=> setTimeout(r,70))
  const count = history.length
  const hasCoin = history.some(h=> h.product==='Coin')
  return {
    customerType: count>5?'Distributor':'End Customer',
    business: '美国警察及公共安全组织，采购徽章/挑战币',
    score: Math.min(95, 60+ count*5),
    potential: hasCoin?['Challenge Coin','Medal','Patch']:['Coin','Pin'],
  }
}

export function suggestFollowUpDate(intent: EmailIntent, text: string): string {
  if (/team|discuss/i.test(text)) {
    const d = new Date(); d.setDate(d.getDate()+5); return d.toISOString().slice(0,10)
  }
  if (intent==='新询价') { const d=new Date(); d.setDate(d.getDate()+3); return d.toISOString().slice(0,10) }
  const d=new Date(); d.setDate(d.getDate()+7); return d.toISOString().slice(0,10)
}
