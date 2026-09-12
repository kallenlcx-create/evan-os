// ====== 深度客户分析服务 ======
// 基于 RFM + BANT + Health Score + 行业定制分析框架
// 参考: GitHub RFM segmentation projects, Gartner CHS, MEDDIC/BANT qualification

import { db } from '../db'
import type { Customer, EmailMessage } from '../types'

// ====== 常量 ======
const PERSONAL_DOMAINS = ['gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com','live.com','aol.com','protonmail.com','mail.com','qq.com','163.com','126.com','foxmail.com']

// ====== RFM 评分维度 ======
export interface RFMScore {
  recency: number      // 1-5, 5=最近活跃
  frequency: number    // 1-5, 5=高频互动
  monetary: number     // 1-5, 5=高金额
  rfmTotal: number     // 15分制
  segment: string      // 客户分群
  segmentColor: string
}

// ====== BANT 资质评分 ======
export interface BANTScore {
  budget: number       // 0-25
  authority: number    // 0-25
  need: number         // 0-25
  timeline: number     // 0-25
  total: number        // 0-100
  grade: string        // A/B/C/D
  summary: string
}

// ====== 客户健康度 ======
export interface HealthScore {
  engagement: number   // 0-100 互动健康
  relationship: number // 0-100 关系质量
  value: number        // 0-100 价值实现
  overall: number      // 0-100 综合健康度
  trend: 'up'|'down'|'stable'
  status: 'healthy'|'attention'|'risk'|'critical'
  statusColor: string
}

// ====== 完整分析报告 ======
export interface FullAnalysis {
  rfm: RFMScore
  bant: BANTScore
  health: HealthScore
  // 客户画像
  profile: {
    type: string           // 政府/教育/企业/个人/非盈利/军队
    communicationStyle: string
    decisionCycle: string
    productPreference: string[]
    orderPattern: string
    priceRange: string
    responseSpeed: string
    engagementLevel: string
  }
  // 跟进方案
  strategy: {
    followUpType: string     // 紧急/定期/培育/唤醒
    followUpCadence: string  // 跟进频率
    keyTopics: string[]      // 关键话题
    riskFactors: string[]    // 风险因素
    opportunities: string[]  // 机会点
    nextActions: string[]    // 建议行动
    activationPlan: string   // 激活方案
    elevator: string         // 30秒电梯演讲
  }
  // 背景信息
  background: {
    summary: string
    keyFacts: string[]
    competitors: string[]
    notes: string
  }
}

// ====== 工具函数 ======
function extractEmailAddr(from: string): string {
  return (from.match(/<(.+?)>/)?.[1] || from).trim().toLowerCase()
}

function extractAmount(text: string): number {
  const patterns = [
    /\$\s*([\d,]+(?:\.\d{2})?)/g,
    /USD\s*([\d,]+(?:\.\d{2})?)/gi,
    /price[:\s]*\$?([\d,]+)/gi,
    /total[:\s]*\$?([\d,]+)/gi,
    /budget[:\s]*\$?([\d,]+)/gi,
    /报价[:\s]*[\$￥]?([\d,]+)/g,
  ]
  let max = 0
  for(const p of patterns){
    let m
    while((m = p.exec(text)) !== null){
      const n = parseFloat(m[1].replace(/,/g,''))
      if(n > max) max = n
    }
  }
  return max
}

function classifyEmailType(email?: string): string {
  if(!email) return '未知'
  const suffix = email.split('@')[1]?.toLowerCase() || ''
  if(suffix.endsWith('.gov')||suffix==='gov') return '政府'
  if(suffix.endsWith('.mil')||suffix==='mil') return '军队'
  if(suffix.endsWith('.edu')||suffix==='edu') return '教育'
  if(suffix.endsWith('.org')||suffix==='org') return '非盈利'
  if(PERSONAL_DOMAINS.includes(suffix)) return '个人'
  return '企业'
}

// ====== RFM 分析 ======
function calculateRFM(emails: EmailMessage[], customerEmail: string): RFMScore {
  const now = new Date()
  const addr = customerEmail.toLowerCase()
  const related = emails.filter(e => {
    const from = extractEmailAddr(e.from)
    const to = (e.to||'').toLowerCase()
    return from === addr || to.includes(addr)
  })

  if(related.length === 0){
    return { recency:1, frequency:1, monetary:1, rfmTotal:3, segment:'未知', segmentColor:'#9ca3af' }
  }

  // Recency: 最近一封邮件距今天数
  const dates = related.map(e => new Date(e.date).getTime())
  const lastContact = Math.max(...dates)
  const daysSinceContact = Math.max(0, (now.getTime() - lastContact) / 86400000)

  // Frequency: 邮件总数 / 交往月数
  const firstContact = Math.min(...dates)
  const monthsActive = Math.max(1, (lastContact - firstContact) / (30*86400000))
  const freq = related.length / monthsActive

  // Monetary: 累计提及金额
  const totalAmount = related.reduce((s,e) => s + extractAmount(e.subject+' '+(e.text||'')), 0)

  // 评分 (1-5)
  const rScore = daysSinceContact <= 7 ? 5 : daysSinceContact <= 30 ? 4 : daysSinceContact <= 90 ? 3 : daysSinceContact <= 180 ? 2 : 1
  const fScore = freq >= 4 ? 5 : freq >= 2 ? 4 : freq >= 1 ? 3 : freq >= 0.5 ? 2 : 1
  const mScore = totalAmount >= 10000 ? 5 : totalAmount >= 5000 ? 4 : totalAmount >= 1000 ? 3 : totalAmount >= 200 ? 2 : 1

  const rfmTotal = rScore + fScore + mScore

  // 客户分群
  let segment: string, segmentColor: string
  if(rfmTotal >= 13) { segment = '冠军客户'; segmentColor = '#f59e0b' }
  else if(rfmTotal >= 10) { segment = '忠诚客户'; segmentColor = '#10b981' }
  else if(rfmTotal >= 8) { segment = '潜力客户'; segmentColor = '#3b82f6' }
  else if(rfmTotal >= 6) { segment = '需关注'; segmentColor = '#f97316' }
  else if(rfmTotal >= 4) { segment = '沉睡客户'; segmentColor = '#ef4444' }
  else { segment = '流失风险'; segmentColor = '#dc2626' }

  return { recency: rScore, frequency: fScore, monetary: mScore, rfmTotal, segment, segmentColor }
}

// ====== BANT 资质评估 ======
function calculateBANT(c: Customer, _emails: EmailMessage[], relatedEmails: EmailMessage[]): BANTScore {
  // Budget: 基于邮件中提及金额
  const amounts = relatedEmails.map(e => extractAmount(e.subject+' '+(e.text||''))).filter(a=>a>0)
  const maxAmount = Math.max(...amounts, 0)
  const budget = maxAmount >= 5000 ? 25 : maxAmount >= 2000 ? 20 : maxAmount >= 500 ? 15 : maxAmount > 0 ? 10 : 5

  // Authority: 基于职位/角色推断
  const title = (c.title||'').toLowerCase()
  const isDecisionMaker = /ceo|cto|cfo|president|director|vp|manager|owner|founder|chief/.test(title)
  const isInfluencer = /lead|senior|specialist|coordinator|analyst/.test(title)
  const authority = isDecisionMaker ? 25 : isInfluencer ? 18 : 12

  // Need: 基于意图分类
  const intents = relatedEmails.map(e => e.intent||'其他')
  const hasUrgent = intents.some(i => i==='催货')
  const hasInquiry = intents.some(i => i==='新询价')
  const hasRepeat = intents.some(i => i==='复购')
  const need = hasRepeat ? 25 : hasInquiry ? 22 : hasUrgent ? 20 : intents.length > 3 ? 15 : 10

  // Timeline: 基于邮件中提及时间/紧急度
  const bodyTexts = relatedEmails.map(e => (e.text||'').toLowerCase() + ' ' + (e.subject||'').toLowerCase())
  const hasDeadline = bodyTexts.some(t => /deadline|urgent|asap|by\s+\w+|before|需要.*前|deadline|交期/.test(t))
  const hasDate = bodyTexts.some(t => /\d{4}[\/-]\d{1,2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i.test(t))
  const timeline = hasDeadline ? 25 : hasDate ? 18 : relatedEmails.length > 5 ? 15 : 10

  const total = budget + authority + need + timeline
  const grade = total >= 85 ? 'A' : total >= 70 ? 'B' : total >= 50 ? 'C' : 'D'

  const summary = [
    budget >= 20 ? '预算充足' : budget >= 15 ? '预算有限' : '预算不明',
    authority >= 20 ? '决策者' : authority >= 15 ? '影响者' : '执行者',
    need >= 20 ? '需求明确' : need >= 15 ? '有需求' : '需求弱',
    timeline >= 20 ? '时间紧迫' : timeline >= 15 ? '有时间线' : '时间模糊',
  ].join(' | ')

  return { budget, authority, need, timeline, total, grade, summary }
}

// ====== 客户健康度 ======
function calculateHealth(c: Customer, _emails: EmailMessage[], relatedEmails: EmailMessage[]): HealthScore {
  const now = new Date()

  // Engagement: 互动频率和响应速度
  const dates = relatedEmails.map(e => new Date(e.date).getTime()).sort((a,b)=>b-a)
  const lastContact = dates[0] || 0
  const daysSince = (now.getTime() - lastContact) / 86400000

  // 响应时间（收件→发件的间隔）
  const sentEmails = relatedEmails.filter(e => (e.from||'').toLowerCase().includes('evan@maxemblem.com'))
  const receivedEmails = relatedEmails.filter(e => !(e.from||'').toLowerCase().includes('evan@maxemblem.com'))
  let avgResponseTime = 48 // 默认48小时
  if(sentEmails.length > 0 && receivedEmails.length > 0){
    const responseTimes = sentEmails.map(se => {
      const nearest = receivedEmails.find(re => re.date < se.date && new Date(se.date).getTime() - new Date(re.date).getTime() < 7*86400000)
      return nearest ? (new Date(se.date).getTime() - new Date(nearest.date).getTime()) / 3600000 : 72
    })
    avgResponseTime = responseTimes.reduce((s,t)=>s+t,0) / responseTimes.length
  }
  const engagement = Math.max(0, Math.min(100,
    (daysSince <= 7 ? 40 : daysSince <= 30 ? 30 : daysSince <= 90 ? 20 : 10) +
    (relatedEmails.length >= 10 ? 30 : relatedEmails.length >= 5 ? 25 : relatedEmails.length >= 2 ? 15 : 5) +
    (avgResponseTime <= 24 ? 30 : avgResponseTime <= 72 ? 20 : 10)
  ))

  // Relationship: 关系深度
  const hasNotes = !!(c as any).notes
  const hasAiSummary = !!(c as any).aiSummary
  const isKey = c.isKey
  const relationship = Math.min(100,
    (relatedEmails.length >= 10 ? 30 : relatedEmails.length >= 5 ? 20 : 10) +
    (isKey ? 25 : 10) +
    (hasNotes ? 20 : 0) +
    (hasAiSummary ? 25 : 10)
  )

  // Value: 价值实现
  const totalAmount = relatedEmails.reduce((s,e) => s + extractAmount(e.subject+' '+(e.text||'')), 0)
  const value = Math.min(100,
    (totalAmount >= 10000 ? 40 : totalAmount >= 5000 ? 30 : totalAmount >= 1000 ? 20 : totalAmount > 0 ? 10 : 0) +
    (relatedEmails.filter(e=>e.intent==='复购').length > 0 ? 30 : relatedEmails.filter(e=>e.intent==='新询价').length > 0 ? 20 : 10) +
    (relatedEmails.length >= 10 ? 30 : relatedEmails.length >= 5 ? 20 : 10)
  )

  const overall = Math.round(engagement * 0.35 + relationship * 0.3 + value * 0.35)

  // Trend: 趋势
  const recentEmails = relatedEmails.filter(e => new Date(e.date).getTime() > now.getTime() - 30*86400000)
  const olderEmails = relatedEmails.filter(e => {
    const d = new Date(e.date).getTime()
    return d > now.getTime() - 60*86400000 && d <= now.getTime() - 30*86400000
  })
  const trend = recentEmails.length > olderEmails.length ? 'up' : recentEmails.length < olderEmails.length ? 'down' : 'stable'

  let status: HealthScore['status'], statusColor: string
  if(overall >= 75) { status = 'healthy'; statusColor = '#10b981' }
  else if(overall >= 50) { status = 'attention'; statusColor = '#f59e0b' }
  else if(overall >= 30) { status = 'risk'; statusColor = '#f97316' }
  else { status = 'critical'; statusColor = '#ef4444' }

  return { engagement, relationship, value, overall, trend, status, statusColor }
}

// ====== 生成完整分析报告 ======
export async function generateFullAnalysis(c: Customer): Promise<FullAnalysis> {
  const allEmails = await db.emails.toArray() as EmailMessage[]
  const addr = (c.email||'').toLowerCase()

  const relatedEmails = allEmails.filter(e => {
    const from = extractEmailAddr(e.from)
    const to = (e.to||'').toLowerCase()
    return from === addr || to.includes(addr)
  }).sort((a,b) => new Date(a.date).getTime() - new Date(b.date).getTime())

  // RFM
  const rfm = calculateRFM(allEmails, c.email||'')

  // BANT
  const bant = calculateBANT(c, allEmails, relatedEmails)

  // Health
  const health = calculateHealth(c, allEmails, relatedEmails)

  // Profile
  const amounts = relatedEmails.map(e => extractAmount(e.subject+' '+(e.text||''))).filter(a=>a>0)
  const products = [...new Set(relatedEmails.map(e => e.product || 'Coin'))]
  const intents = relatedEmails.map(e => e.intent || '其他')
  const intentCounts: Record<string,number> = {}
  intents.forEach(i => { intentCounts[i] = (intentCounts[i]||0)+1 })
  const topIntents = Object.entries(intentCounts).sort((a,b)=>b[1]-a[1]).slice(0,3)

  const firstDate = relatedEmails[0]?.date ? new Date(relatedEmails[0].date) : new Date()
  const lastDate = relatedEmails[relatedEmails.length-1]?.date ? new Date(relatedEmails[relatedEmails.length-1].date) : new Date()
  const daySpan = Math.max(1, Math.round((lastDate.getTime()-firstDate.getTime())/86400000))
  const freq = relatedEmails.length / Math.max(1, daySpan/30)

  const bodyTexts = relatedEmails.map(e => (e.text||'').toLowerCase())
  const hasFormal = bodyTexts.some(t => /dear|sincerely|regards|thank you/.test(t))
  const hasCasual = bodyTexts.some(t => /hi|hey|hello|thanks|cheers/.test(t))

  // Response speed
  const sentEmails = relatedEmails.filter(e => (e.from||'').toLowerCase().includes('evan@maxemblem.com'))
  const receivedEmails = relatedEmails.filter(e => !(e.from||'').toLowerCase().includes('evan@maxemblem.com'))
  let avgResponseHours = 48
  if(sentEmails.length > 0 && receivedEmails.length > 0){
    const times = sentEmails.map(se => {
      const nearest = receivedEmails.find(re => re.date < se.date && new Date(se.date).getTime() - new Date(re.date).getTime() < 7*86400000)
      return nearest ? (new Date(se.date).getTime() - new Date(nearest.date).getTime()) / 3600000 : 72
    })
    avgResponseHours = times.reduce((s,t)=>s+t,0) / times.length
  }

  const profile = {
    type: classifyEmailType(c.email),
    communicationStyle: hasFormal ? '正式商务' : hasCasual ? '轻松友好' : '标准商务',
    decisionCycle: daySpan > 60 ? '长周期(>2月)' : daySpan > 14 ? '中周期(2周-2月)' : '短周期(<2周)',
    productPreference: products,
    orderPattern: amounts.length > 0 ? `${relatedEmails.length}次互动，平均$${Math.round(amounts.reduce((s,a)=>s+a,0)/amounts.length).toLocaleString()}` : `${relatedEmails.length}次互动，无明确金额`,
    priceRange: amounts.length > 0 ? `$${Math.round(Math.min(...amounts)).toLocaleString()} - $${Math.round(Math.max(...amounts)).toLocaleString()}` : '待确认',
    responseSpeed: avgResponseHours <= 24 ? '快速响应(<24h)' : avgResponseHours <= 72 ? '正常(1-3天)' : '较慢(>3天)',
    engagementLevel: freq >= 2 ? '高频互动' : freq >= 0.5 ? '正常互动' : '低频互动',
  }

  // Strategy
  const isChampion = rfm.rfmTotal >= 13
  const isAtRisk = rfm.rfmTotal <= 5 || health.status === 'critical'
  const isNewCustomer = relatedEmails.length < 3
  const hasRepeatOrder = intents.includes('复购')

  const followUpType = isChampion ? 'VIP维护' : isAtRisk ? '紧急唤醒' : isNewCustomer ? '新客培育' : hasRepeatOrder ? '复购促进' : '常规跟进'
  const followUpCadence = isChampion ? '每月1次深度沟通' : isAtRisk ? '每周1次触达' : isNewCustomer ? '3天内首次跟进' : '每2周跟进'

  const keyTopics: string[] = []
  if(amounts.length > 0) keyTopics.push(`订单金额$${Math.round(amounts.reduce((s,a)=>s+a,0)/amounts.length).toLocaleString()}`)
  if(products.length > 0) keyTopics.push(`偏好产品: ${products.join('/')}`)
  if(topIntents[0]) keyTopics.push(`主要意图: ${topIntents.map(i=>i[0]).join('/')}`)
  if(hasRepeatOrder) keyTopics.push('有复购记录')

  const maxAmount = Math.max(...amounts, 0)
  const riskFactors: string[] = []
  if(daySpan > 90 && relatedEmails.length < 5) riskFactors.push('长期低频互动')
  if(relatedEmails.length < 3) riskFactors.push('互动次数少')
  if(health.trend === 'down') riskFactors.push('活跃度下降')
  if(amounts.length === 0) riskFactors.push('无明确订单金额')

  const opportunities: string[] = []
  if(isChampion) opportunities.push('可申请VIP折扣/专属服务')
  if(hasRepeatOrder) opportunities.push('交叉销售/升级销售机会')
  if(profile.type === '政府' || profile.type === '军队') opportunities.push('政府采购周期，提前布局')
  if(profile.type === '教育') opportunities.push('教育机构年度预算周期')
  if(maxAmount >= 2000) opportunities.push('大客户，可定制专属方案')

  const nextActions: string[] = []
  if(isAtRisk) nextActions.push('立即发送关怀邮件，了解近况')
  if(isNewCustomer) nextActions.push('发送公司介绍+成功案例')
  if(hasRepeatOrder) nextActions.push('推荐新品/升级方案')
  if(bant.grade === 'A') nextActions.push('优先跟进，48小时内报价')
  if(bant.grade === 'C' || bant.grade === 'D') nextActions.push('补充BANT信息，明确需求')
  nextActions.push(`建议${followUpCadence}`)

  const activationPlan = isChampion ? '维护关系：定期发送行业资讯、新品预览、VIP活动邀请' :
    isAtRisk ? '唤醒计划：发送限时优惠+成功案例+亲自问候' :
    isNewCustomer ? '培育计划：发送产品手册+FAQ+首次下单优惠' :
    hasRepeatOrder ? '深化合作：推荐关联产品+批量折扣方案' :
    '常规维护：每月发送Newsletter+节日问候'

  const strategy = {
    followUpType,
    followUpCadence,
    keyTopics,
    riskFactors,
    opportunities,
    nextActions,
    activationPlan,
    elevator: `${c.contactName||c.title||'客户'}，${profile.type}行业，${profile.communicationStyle}风格，${relatedEmails.length}次互动，${amounts.length>0?'累计$'+Math.round(amounts.reduce((s,a)=>s+a,0)).toLocaleString():'订单金额待确认'}，${followUpType}阶段。`,
  }

  // Background
  const background = {
    summary: profile.type + ' | ' + profile.communicationStyle + ' | ' + profile.engagementLevel,
    keyFacts: [
      `邮箱: ${c.email}`,
      `类型: ${profile.type}`,
      `首次联系: ${firstDate.toLocaleDateString()}`,
      `最近联系: ${lastDate.toLocaleDateString()}`,
      `交往天数: ${daySpan}天`,
      `互动频率: ${freq.toFixed(1)}封/月`,
      `响应速度: ${profile.responseSpeed}`,
    ],
    competitors: [],
    notes: (c as any).notes || '',
  }

  return { rfm, bant, health, profile, strategy, background }
}

// ====== 批量分析所有客户 ======
export async function batchAnalyzeAll(): Promise<{analyzed: number, segments: Record<string,number>}> {
  const customers = await db.customers.toArray() as Customer[]
  const segments: Record<string,number> = {}
  let analyzed = 0

  for(const c of customers){
    if(!c.email) continue
    try{
      const analysis = await generateFullAnalysis(c)
      await db.customers.update(c.id, {
        level: analysis.rfm.rfmTotal >= 13 ? 'A+' : analysis.rfm.rfmTotal >= 10 ? 'A' : analysis.rfm.rfmTotal >= 7 ? 'B' : analysis.rfm.rfmTotal >= 4 ? 'C' : 'D',
        isKey: analysis.rfm.rfmTotal >= 10,
        aiSummary: analysis.strategy.elevator,
        score: analysis.health.overall,
        customerType: analysis.profile.type,
        portrait: analysis as any,
      } as any)
      segments[analysis.rfm.segment] = (segments[analysis.rfm.segment]||0) + 1
      analyzed++
    }catch{}
  }

  window.dispatchEvent(new CustomEvent('evan-customers-updated'))
  return { analyzed, segments }
}

// ====== 导入已有下单客户 ======
export interface ImportCustomerData {
  email: string
  contactName?: string
  company?: string
  orderAmount?: number
  orderDate?: string
  product?: string
  notes?: string
}

export async function importOrderedCustomers(dataList: ImportCustomerData[]): Promise<{imported: number, skipped: number}> {
  let imported = 0, skipped = 0
  const allEmails = await db.emails.toArray() as EmailMessage[]

  for(const d of dataList){
    const addr = d.email.trim().toLowerCase()
    if(!addr || !addr.includes('@')) { skipped++; continue }

    // 检查是否已存在
    const existing = await db.customers.filter((cc:any)=> (cc.email||'').toLowerCase()===addr).first() as any
    if(existing){
      const patch: any = { updatedAt: new Date().toISOString() }
      if(d.contactName) patch.contactName = d.contactName
      if(d.company) patch.company = d.company
      if(d.notes) patch.notes = d.notes
      await db.customers.update(existing.id, patch)
      skipped++
      continue
    }

    // 自动分类
    const emailType = classifyEmailType(addr)
    const typeMap: Record<string, string> = {
      '政府':'Government','军队':'Military','教育':'School','非盈利':'Organization','企业':'Company','个人':'End Customer'
    }

    // RFM 评估
    const rfm = calculateRFM(allEmails, addr)
    const level = rfm.rfmTotal >= 13 ? 'A+' : rfm.rfmTotal >= 10 ? 'A' : rfm.rfmTotal >= 7 ? 'B' : rfm.rfmTotal >= 4 ? 'C' : 'D'

    const { uid } = await import('../repositories/result')
    const { now } = await import('../repositories/result')

    const rec: any = {
      id: uid(),
      type: 'customer',
      title: d.contactName || addr.split('@')[0],
      contactName: d.contactName || '',
      description: d.notes || `导入客户 - ${emailType}`,
      emoji: '👤',
      tags: ['邮件', '导入客户'],
      createdAt: now(),
      updatedAt: now(),
      relations: [],
      company: d.company || '',
      email: addr,
      stage: 'lead',
      isKey: rfm.rfmTotal >= 10,
      level: level,
      customerType: typeMap[emailType] || 'Company',
      followUpAt: new Date(Date.now()+3*86400000).toISOString().slice(0,10),
      score: 0,
      notes: d.notes || '',
    }

    await db.customers.put(rec)
    imported++
  }

  window.dispatchEvent(new CustomEvent('evan-customers-updated'))
  return { imported, skipped }
}
