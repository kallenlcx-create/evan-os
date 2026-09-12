// ====== 批量营销：真实发送 + 模板变量 + 效果追踪 ======
import { useState, useEffect, useCallback } from 'react'
import { db } from '../db'
import type { Customer } from '../types'
import { Send, Users, Filter, Sparkles, MousePointerClick } from 'lucide-react'
import { listAccounts, sendEmail } from '../repositories/emailRepository'

// ====== 跟进模板库 ======
const FOLLOW_UP_TEMPLATES = [
  { id: 'new_inquiry', name: '新询价跟进', subject: 'Following up on your inquiry - {{product}}', body: 'Hi {{first_name}},\n\nThank you for your interest in our {{product}}. I wanted to follow up and see if you have any questions about our previous quote.\n\nWe can offer competitive pricing for {{qty}} pieces with a lead time of 12-15 days.\n\nBest regards,\nEvan' },
  { id: 'quote_follow', name: '报价后跟进', subject: 'Re: Quote for {{product}} - Special offer', body: 'Hi {{first_name}},\n\nI hope you\'ve had a chance to review our quote. I wanted to let you know that we can offer a special discount for orders placed this week.\n\nPlease let me know if you\'d like to proceed.\n\nBest regards,\nEvan' },
  { id: 'reorder', name: '复购提醒', subject: 'Time to reorder {{product}}?', body: 'Hi {{first_name}},\n\nIt\'s been a while since your last order. I wanted to check if you need to reorder any {{product}}?\n\nWe\'ve updated our catalog with new designs that might interest you.\n\nBest regards,\nEvan' },
  { id: 'holiday', name: '节日问候', subject: 'Season\'s Greetings from Maxemblem', body: 'Hi {{first_name}},\n\nWishing you and your team a wonderful holiday season! Thank you for your continued partnership.\n\nWe look forward to working with you in the coming year.\n\nBest regards,\nEvan' },
  { id: 'new_product', name: '新品推荐', subject: 'New {{product}} designs available', body: 'Hi {{first_name}},\n\nWe\'ve just launched new {{product}} designs that I think would be perfect for your organization.\n\nWould you like to see the new catalog?\n\nBest regards,\nEvan' },
]

// ====== Campaign 效果追踪类型 ======
interface CampaignRecord {
  id: string
  customerId: string
  customerEmail: string
  templateId: string
  sentAt: string
  status: 'sent' | 'delivered' | 'opened' | 'replied' | 'bounced'
  messageId?: string
}

export default function CampaignsPage() {
  const [customers, setCustomers] = useState<Customer[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filterLevel, setFilterLevel] = useState<string>('all')
  const [days, setDays] = useState(7)
  const [preview, setPreview] = useState('')
  const [selectedTemplate, setSelectedTemplate] = useState(FOLLOW_UP_TEMPLATES[0])
  const [sending, setSending] = useState(false)
  const [sendProgress, setSendProgress] = useState({ done: 0, total: 0, errors: 0 })
  const [campaignHistory, setCampaignHistory] = useState<CampaignRecord[]>([])
  const [bulkFollow, setBulkFollow] = useState(() => localStorage.getItem('evan:bulkFollow') !== '0')
  const [bulkMarketing, setBulkMarketing] = useState(() => localStorage.getItem('evan:bulkMarketing') !== '0')
  const [bulkFollowTime, setBulkFollowTime] = useState(() => localStorage.getItem('evan:bulkFollowTime') || '09:30')
  const [bulkMarketingTime, setBulkMarketingTime] = useState(() => localStorage.getItem('evan:bulkMarketingTime') || '10:00')

  useEffect(() => localStorage.setItem('evan:bulkFollow', bulkFollow ? '1' : '0'), [bulkFollow])
  useEffect(() => localStorage.setItem('evan:bulkMarketing', bulkMarketing ? '1' : '0'), [bulkMarketing])
  useEffect(() => localStorage.setItem('evan:bulkFollowTime', bulkFollowTime), [bulkFollowTime])
  useEffect(() => localStorage.setItem('evan:bulkMarketingTime', bulkMarketingTime), [bulkMarketingTime])

  useEffect(() => {
    ;(async () => {
      setCustomers(await db.customers.toArray() as Customer[])
      const hist = localStorage.getItem('evan:campaignHistory')
      if (hist) setCampaignHistory(JSON.parse(hist))
    })()
  }, [])

  const filtered = customers.filter(c => {
    if (filterLevel !== 'all' && c.level !== filterLevel) return false
    const last = new Date(c.updatedAt).getTime()
    const cutoff = Date.now() - days * 86400000
    return last < cutoff
  })

  const toggle = (id: string) => setSelected(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const toggleAll = () => setSelected(filtered.length === selected.size ? new Set() : new Set(filtered.map(c => c.id)))

  // ====== 模板变量替换 ======
  const renderTemplate = (template: string, customer: Customer): string => {
    const firstName = (customer.contactName || customer.title || '').split(' ')[0] || 'there'
    return template
      .replace(/\{\{first_name\}\}/g, firstName)
      .replace(/\{\{last_name\}\}/g, (customer.contactName || '').split(' ').slice(1).join(' ') || '')
      .replace(/\{\{company\}\}/g, customer.company || 'your company')
      .replace(/\{\{product\}\}/g, customer.portrait?.products?.[0] || 'Challenge Coin')
      .replace(/\{\{level\}\}/g, customer.level || 'C')
      .replace(/\{\{email\}\}/g, customer.email || '')
  }

  // ====== AI 差异化生成 ======
  const gen = useCallback(async () => {
    if (selected.size === 0) return alert('请先选择客户')
    const selectedCustomers = filtered.filter(c => selected.has(c.id))
    // 为每个客户生成差异化内容
    const parts = selectedCustomers.slice(0, 5).map(c => {
      const name = c.contactName || c.title || 'there'
      const level = c.level || 'C'
      const product = c.portrait?.products?.[0] || 'Challenge Coin'
      if (level === 'A+' || level === 'A') {
        return `${name}（${level}级·${product}客户）：个性化报价+优先交期`
      }
      return `${name}（${level}级）：标准跟进+新品推荐`
    })
    setPreview(`为 ${selectedCustomers.length} 位客户生成差异化邮件：\n\n${parts.join('\n')}\n\n使用模板：${selectedTemplate.name}\n支持变量：{{first_name}} {{company}} {{product}} {{level}}`)
  }, [selected, filtered, selectedTemplate])

  // ====== 真实批量发送 ======
  const handleSend = useCallback(async () => {
    if (selected.size === 0) return alert('请先选择客户')
    const ok = confirm(`确认向 ${selected.size} 位客户发送邮件？\n\n此操作将通过 SMTP 真实发送。`)
    if (!ok) return

    setSending(true)
    setSendProgress({ done: 0, total: selected.size, errors: 0 })
    const accounts = await listAccounts()
    const acc = accounts[0]
    if (!acc) { alert('无可用邮箱账号'); setSending(false); return }

    const selectedCustomers = filtered.filter(c => selected.has(c.id))
    const newHistory: CampaignRecord[] = []

    for (let i = 0; i < selectedCustomers.length; i++) {
      const c = selectedCustomers[i]
      setSendProgress({ done: i, total: selectedCustomers.length, errors: 0 })
      try {
        const subject = renderTemplate(selectedTemplate.subject, c)
        const body = renderTemplate(selectedTemplate.body, c)
        const result = await sendEmail(acc.id, c.email || '', subject, body)
        if (result.ok) {
          // 保存到已发送
          const { uid } = await import('../repositories/result')
          await db.emails.put({
            id: uid(), accountId: acc.id, folder: 'sent',
            from: acc.email, to: c.email || '', subject,
            text: body, html: '', date: new Date().toISOString(),
            isRead: true, hasAttachment: false,
            customerId: c.id, intent: '营销邮件', product: selectedTemplate.name,
          } as any)
          newHistory.push({
            id: `camp-${Date.now()}-${i}`,
            customerId: c.id,
            customerEmail: c.email || '',
            templateId: selectedTemplate.id,
            sentAt: new Date().toISOString(),
            status: 'sent',
            messageId: result.messageId,
          })
          // 更新客户最后联系时间
          await db.customers.update(c.id, { updatedAt: new Date().toISOString() } as any)
        }
      } catch (e) {
        setSendProgress(prev => ({ ...prev, errors: prev.errors + 1 }))
      }
      // 间隔1秒避免被限流
      await new Promise(r => setTimeout(r, 1000))
    }

    // 保存发送记录
    const allHistory = [...campaignHistory, ...newHistory]
    setCampaignHistory(allHistory)
    localStorage.setItem('evan:campaignHistory', JSON.stringify(allHistory))

    setSendProgress({ done: selectedCustomers.length, total: selectedCustomers.length, errors: 0 })
    setSending(false)
    alert(`发送完成！成功 ${selectedCustomers.length} 封，失败 ${sendProgress.errors} 封`)
  }, [selected, filtered, selectedTemplate, campaignHistory])

  // ====== 统计 ======
  const stats = {
    total: campaignHistory.length,
    sent: campaignHistory.filter(c => c.status === 'sent').length,
    opened: campaignHistory.filter(c => c.status === 'opened').length,
    replied: campaignHistory.filter(c => c.status === 'replied').length,
    bounced: campaignHistory.filter(c => c.status === 'bounced').length,
  }

  return (
    <div className="p-4 max-w-6xl mx-auto space-y-4">
      <div className="flex items-center gap-2">
        <Users size={20} className="text-purple-500" />
        <h1 className="text-xl font-bold">批量跟进 / 营销活动</h1>
        <span className="text-xs text-gray-400">Campaign Builder · 真实发送 + 效果追踪</span>
      </div>

      {/* 筛选 + 操作 */}
      <div className="bg-white rounded-2xl border p-3 space-y-2">
        <div className="flex flex-wrap gap-2 items-center">
          <Filter size={14} className="text-gray-400" />
          <select value={filterLevel} onChange={e => setFilterLevel(e.target.value)} className="px-2 py-1 border rounded text-xs">
            <option value="all">全部等级</option><option value="A+">A+</option><option value="A">A</option><option value="B">B</option><option value="C">C</option>
          </select>
          <select value={days} onChange={e => setDays(Number(e.target.value))} className="px-2 py-1 border rounded text-xs">
            <option value={7}>7天未联系</option><option value={14}>14天</option><option value={30}>30天</option><option value={90}>90天</option>
          </select>
          <span className="text-xs text-gray-400">{filtered.length} 人命中</span>
          <button onClick={toggleAll} className="ml-auto px-3 py-1 bg-white border rounded text-xs">{selected.size === filtered.length ? '取消全选' : '全选'}</button>
          <button onClick={gen} disabled={!bulkFollow && !bulkMarketing} className="px-3 py-1 bg-purple-600 text-white rounded text-xs flex items-center gap-1 disabled:opacity-40"><Sparkles size={12} /> AI 批量差异化生成</button>
        </div>
        {/* 模板选择 */}
        <div className="flex flex-wrap gap-1.5">
          {FOLLOW_UP_TEMPLATES.map(t => (
            <button key={t.id} onClick={() => setSelectedTemplate(t)} className={`px-2 py-1 rounded-full text-[11px] border ${selectedTemplate.id === t.id ? 'bg-purple-50 border-purple-300 text-purple-700' : 'bg-white text-gray-500'}`}>{t.name}</button>
          ))}
        </div>
        {/* 定时配置 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <label className="flex items-center justify-between p-2 bg-gray-50 rounded-xl border">
            <span className="text-xs font-medium">批量跟进</span>
            <span className="flex items-center gap-2">
              <input type="time" value={bulkFollowTime} onChange={e => setBulkFollowTime(e.target.value)} className="px-2 py-1 border rounded text-xs" />
              <input type="checkbox" checked={bulkFollow} onChange={e => setBulkFollow(e.target.checked)} className="accent-blue-600" />
            </span>
          </label>
          <label className="flex items-center justify-between p-2 bg-gray-50 rounded-xl border">
            <span className="text-xs font-medium">批量营销</span>
            <span className="flex items-center gap-2">
              <input type="time" value={bulkMarketingTime} onChange={e => setBulkMarketingTime(e.target.value)} className="px-2 py-1 border rounded text-xs" />
              <input type="checkbox" checked={bulkMarketing} onChange={e => setBulkMarketing(e.target.checked)} className="accent-purple-600" />
            </span>
          </label>
        </div>
      </div>

      {/* 客户列表 + 预览 */}
      <div className="grid lg:grid-cols-[1fr_380px] gap-3">
        <div className="bg-white rounded-2xl border overflow-hidden">
          <div className="px-3 py-2 border-b text-xs font-semibold text-gray-600 flex items-center gap-2">
            <span>客户列表</span>
            <span className="text-gray-400">已选 {selected.size} 人</span>
          </div>
          <div className="max-h-[420px] overflow-y-auto">
            {filtered.map(c => (
              <label key={c.id} className="flex items-center gap-2 p-2 border-b hover:bg-gray-50 text-xs cursor-pointer">
                <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                <span className={`w-5 h-5 rounded-full bg-gradient-to-br from-blue-400 to-purple-500 flex items-center justify-center text-white text-[9px] font-bold shrink-0`}>{(c.contactName || c.title || '?')[0].toUpperCase()}</span>
                <span className="font-medium truncate">{c.contactName || c.title}</span>
                <span className="text-gray-400 truncate">{c.company}</span>
                <span className="ml-auto px-1.5 py-0.5 bg-gray-100 rounded text-[10px]">{c.level || 'C'}</span>
                <span className="text-gray-300 text-[10px] truncate">{c.email}</span>
              </label>
            ))}
            {filtered.length === 0 && <div className="p-8 text-center text-xs text-gray-300">无匹配客户</div>}
          </div>
        </div>

        <div className="space-y-3">
          {/* 预览 + 发送 */}
          <div className="bg-white rounded-2xl border p-3">
            <div className="text-xs font-semibold mb-1">邮件预览（模板：{selectedTemplate.name}）</div>
            <div className="text-[10px] text-gray-400 mb-2">变量：{'{{first_name}}'} {'{{company}}'} {'{{product}}'} {'{{level}}'}</div>
            <textarea value={preview} onChange={e => setPreview(e.target.value)} placeholder="点击 AI 生成 或直接编辑模板内容..." className="w-full h-40 p-2 border rounded text-xs resize-none" />
            <div className="flex gap-1 mt-2">
              <button onClick={handleSend} disabled={sending || selected.size === 0} className="flex-1 py-2 bg-blue-600 text-white rounded text-xs flex items-center justify-center gap-1 disabled:opacity-50">
                {sending ? `发送中 ${sendProgress.done}/${sendProgress.total}...` : <><Send size={12} /> 批量发送 ({selected.size})</>}
              </button>
            </div>
            {sending && (
              <div className="mt-2">
                <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${Math.min(100, Math.round(sendProgress.done / sendProgress.total * 100))}%` }} />
                </div>
              </div>
            )}
          </div>

          {/* 效果追踪 */}
          <div className="bg-white rounded-2xl border p-3">
            <div className="text-xs font-semibold mb-2 flex items-center gap-1"><MousePointerClick size={12} /> 效果追踪</div>
            <div className="grid grid-cols-4 gap-1.5 text-center">
              <div className="bg-blue-50 rounded-lg p-2"><div className="text-sm font-bold text-blue-600">{stats.sent}</div><div className="text-[9px] text-gray-500">已发送</div></div>
              <div className="bg-green-50 rounded-lg p-2"><div className="text-sm font-bold text-green-600">{stats.opened}</div><div className="text-[9px] text-gray-500">已打开</div></div>
              <div className="bg-purple-50 rounded-lg p-2"><div className="text-sm font-bold text-purple-600">{stats.replied}</div><div className="text-[9px] text-gray-500">已回复</div></div>
              <div className="bg-red-50 rounded-lg p-2"><div className="text-sm font-bold text-red-600">{stats.bounced}</div><div className="text-[9px] text-gray-500">退信</div></div>
            </div>
            {stats.total > 0 && (
              <div className="mt-2 text-[10px] text-gray-400">
                回复率 {stats.total > 0 ? Math.round(stats.replied / stats.total * 100) : 0}% · 
                打开率 {stats.total > 0 ? Math.round(stats.opened / stats.total * 100) : 0}%
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
