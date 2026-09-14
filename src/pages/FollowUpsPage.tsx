// ====== 跟进中心：闭环跟进 + 真实发送 + 智能雷达 ======
import { useState, useEffect, useMemo, useCallback } from 'react'
import { db } from '../db'
import type { FollowUpRecord, Customer, EmailMessage } from '../types'
import { Calendar, Clock, Flame, AlertTriangle, DollarSign, Repeat, Megaphone, Send } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { listAccounts, sendEmail } from '../repositories/emailRepository'
import { STAGE_LABELS, EVENTS, emitEvent } from '../utils/emailHelpers'

// ====== 跟进模板库 ======
const TEMPLATES = [
  { id: 'check_in', name: '常规问候', subject: 'Checking in - {{product}}', body: 'Hi {{first_name}},\n\nJust wanted to check in and see how things are going with your {{product}} project.\n\nBest regards,\nEvan' },
  { id: 'quote_follow', name: '报价跟进', subject: 'Following up on our quote', body: 'Hi {{first_name}},\n\nI wanted to follow up on the quote we sent. Do you have any questions?\n\nBest regards,\nEvan' },
  { id: 'new_product', name: '新品推荐', subject: 'New products you might like', body: 'Hi {{first_name}},\n\nWe\'ve launched new designs that I think would be perfect for you.\n\nWould you like to see the catalog?\n\nBest regards,\nEvan' },
]

export default function FollowUpsPage() {
  const navigate = useNavigate()
  const [customers, setCustomers] = useState<Customer[]>([])
  const [emails, setEmails] = useState<EmailMessage[]>([])
  const [list, setList] = useState<FollowUpRecord[]>([])
  const [catFilter, setCatFilter] = useState<string>('all')
  const [page, setPage] = useState(1)
  const [perPage] = useState(4)
  const [showSendModal, setShowSendModal] = useState(false)
  const [sendTarget, setSendTarget] = useState<Customer | null>(null)
  const [sendTemplate, setSendTemplate] = useState(TEMPLATES[0])
  const [sendSubject, setSendSubject] = useState('')
  const [sendBody, setSendBody] = useState('')
  const [sending, setSending] = useState(false)

  const load = useCallback(async () => {
    setCustomers(await db.customers.toArray() as Customer[])
    setEmails(await db.emails.toArray() as EmailMessage[])
    setList(await db.followUps.toArray() as FollowUpRecord[])
  }, [])

  useEffect(() => {
    void load()
    const h = () => void load()
    window.addEventListener(EVENTS.EMAILS_UPDATED, h)
    window.addEventListener(EVENTS.CUSTOMERS_UPDATED, h)
    return () => { window.removeEventListener(EVENTS.EMAILS_UPDATED, h); window.removeEventListener(EVENTS.CUSTOMERS_UPDATED, h) }
  }, [load])

  const today = new Date().toISOString().slice(0, 10)

  // ====== 6分类统计 ======
  const stats = useMemo(() => {
    const high = customers.filter(c => c.isKey && (c.level === 'A+' || c.level === 'A')).length
    const todayCnt = list.filter(f => f.dueAt === today && f.status === 'pending').length
    const overdue = list.filter(f => f.dueAt < today && f.status === 'pending').length
    const pendingDeals = customers.filter(c => c.stage === 'proposal' || c.stage === 'negotiation').length
    const repurchase = customers.filter(c => c.isKey && (c.score || 0) > 70).length
    const marketing = customers.filter(c => c.isKey).length
    return { high, today: todayCnt, overdue, pendingDeals, repurchase, marketing }
  }, [customers, list, today])

  // ====== 雷达：沉寂客户 ======
  const radar = useMemo(() => {
    const byEmail = new Map<string, string>()
    for (const e of emails) {
      const addr = (e.from?.match(/<(.+?)>/)?.[1] || e.from || '').toLowerCase()
      const cur = byEmail.get(addr)
      if (!cur || e.date > cur) byEmail.set(addr, e.date)
    }
    const keyCustomers = customers.filter(c => c.isKey || (c.level === 'A+' || c.level === 'A' || c.level === 'B'))
    const scored = keyCustomers.map(c => {
      const last = byEmail.get((c.email || '').toLowerCase()) || c.updatedAt
      const days = last ? Math.floor((Date.now() - new Date(last).getTime()) / 86400000) : 99
      return { c, days, stage: c.stage || 'lead' }
    }).filter(x => x.days >= 7)
      .sort((a, b) => b.days - a.days)
    const aList = scored.filter(x => x.c.level === 'A+' || x.c.level === 'A')
    const bList = scored.filter(x => x.c.level === 'B')
    return { all: scored, aList, bList }
  }, [customers, emails])

  const catFiltered = useMemo(() => {
    if (catFilter === 'high') return radar.aList
    if (catFilter === 'today') return radar.all.filter(x => list.some(f => f.customerId === x.c.id && f.dueAt === today))
    if (catFilter === 'overdue') return radar.all.filter(x => list.some(f => f.customerId === x.c.id && f.dueAt < today && f.status === 'pending'))
    if (catFilter === 'pending') return radar.all
    if (catFilter === 'repurchase') return radar.all.filter(x => (x.c.score || 0) > 70)
    if (catFilter === 'marketing') return radar.all
    return radar.all
  }, [catFilter, radar, list, today])

  const totalPages = Math.max(1, Math.ceil(catFiltered.length / perPage))
  const pageData = catFiltered.slice((page - 1) * perPage, page * perPage)

  // ====== 打开发送弹窗 ======
  const openSendModal = useCallback((c: Customer) => {
    setSendTarget(c)
    const product = c.portrait?.products?.[0] || 'Challenge Coin'
    const tpl = TEMPLATES[0]
    setSendTemplate(tpl)
    setSendSubject(tpl.subject.replace(/\{\{product\}\}/g, product))
    setSendBody(tpl.body.replace(/\{\{first_name\}\}/g, (c.contactName || c.title || 'there').split(' ')[0]).replace(/\{\{product\}\}/g, product))
    setShowSendModal(true)
  }, [])

  // ====== 真实发送 ======
  const handleSend = useCallback(async () => {
    if (!sendTarget || !sendBody.trim()) return
    setSending(true)
    try {
      const accounts = await listAccounts()
      const acc = accounts[0]
      if (!acc) { alert('无可用邮箱账号'); return }
      const result = await sendEmail(acc.id, sendTarget.email || '', sendSubject, sendBody)
      if (result.ok) {
        const { uid } = await import('../repositories/result')
        // 保存到已发送
        await db.emails.put({
          id: uid(), accountId: acc.id, folder: 'sent',
          from: acc.email, to: sendTarget.email || '', subject: sendSubject,
          text: sendBody, html: '', date: new Date().toISOString(),
          isRead: true, hasAttachment: false, customerId: sendTarget.id,
        } as any)
        // 更新跟进记录状态
        const fu = list.find(f => f.customerId === sendTarget.id && f.status === 'pending')
        if (fu) await db.followUps.update(fu.id, { status: 'sent' } as any)
        // 更新客户阶段
        const { advanceStage } = await import('../services/customerFactory')
        const newStage = advanceStage(sendTarget.stage || 'lead', '报价回复')
        await db.customers.update(sendTarget.id, {
          stage: newStage,
          updatedAt: new Date().toISOString(),
          lastContactAt: new Date().toISOString(),
        } as any)
        emitEvent(EVENTS.CUSTOMERS_UPDATED, { id: sendTarget.id, action: 'followed_up' })
        alert('邮件已发送！')
        setShowSendModal(false)
        await load()
      }
    } catch (e: any) {
      alert('发送失败：' + String(e.message || e).slice(0, 200))
    } finally { setSending(false) }
  }, [sendTarget, sendSubject, sendBody, list, load])

  // ====== 一键生成跟进并发送 ======
  const handleQuickFollow = useCallback(async (c: Customer) => {
    openSendModal(c)
  }, [openSendModal])

  // ====== 标记完成 ======
  const handleComplete = useCallback(async (fu: FollowUpRecord) => {
    await db.followUps.update(fu.id, { status: 'completed' } as any)
    emitEvent(EVENTS.CUSTOMERS_UPDATED, { id: fu.customerId, action: 'followup_completed' })
    await load()
  }, [load])

  const cats = [
    { key: 'high', label: '高意向客户', icon: Flame, count: stats.high, color: 'text-red-500', bg: 'bg-red-50' },
    { key: 'today', label: '今日跟进', icon: Clock, count: stats.today, color: 'text-blue-500', bg: 'bg-blue-50' },
    { key: 'overdue', label: '逾期跟进', icon: AlertTriangle, count: stats.overdue, color: 'text-orange-500', bg: 'bg-orange-50' },
    { key: 'pending', label: '待成交机会', icon: DollarSign, count: stats.pendingDeals, color: 'text-green-600', bg: 'bg-green-50' },
    { key: 'repurchase', label: '潜在复购', icon: Repeat, count: stats.repurchase, color: 'text-purple-500', bg: 'bg-purple-50' },
    { key: 'marketing', label: '营销机会', icon: Megaphone, count: stats.marketing, color: 'text-pink-500', bg: 'bg-pink-50' },
  ]

  return (
    <div className="p-4 max-w-6xl mx-auto space-y-4">
      <h1 className="text-xl font-bold flex items-center gap-2"><Calendar size={20} /> 跟进 · 客户跟进雷达</h1>

      {/* 6分类 */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
        {cats.map(c => (
          <button key={c.key} onClick={() => { setCatFilter(c.key); setPage(1) }} className={`p-3 rounded-2xl border text-left transition-all ${catFilter === c.key ? 'ring-2 ring-blue-300 border-blue-300' : 'border-gray-100 bg-white hover:border-gray-200'}`}>
            <div className={`w-7 h-7 rounded-full flex items-center justify-center ${c.bg} ${c.color} mb-1`}><c.icon size={14} /></div>
            <div className="text-xs text-gray-500">{c.label}</div>
            <div className={`text-lg font-bold ${c.color}`}>{c.count}</div>
          </button>
        ))}
      </div>

      {/* 雷达 */}
      <div className="bg-white rounded-2xl border p-4">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-7 h-7 bg-red-100 rounded-lg flex items-center justify-center">🔥</div>
          <div>
            <div className="text-sm font-bold">客户跟进雷达</div>
            <div className="text-xs text-gray-400">A/B类客户沉寂预警 · 一键发送跟进邮件</div>
          </div>
          <button onClick={() => load()} className="ml-auto text-xs px-2 py-1 bg-white border rounded">↻ 刷新</button>
        </div>

        <div className="space-y-2">
          {pageData.map(({ c, days, stage }) => (
            <div key={c.id} className="flex items-center gap-3 p-3 bg-white border rounded-xl hover:border-blue-200 transition-all">
              <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-400 to-purple-500 text-white flex items-center justify-center font-bold text-sm shrink-0">{(c.contactName || c.title || 'J')[0].toUpperCase()}</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-sm font-semibold truncate">{c.contactName || c.title}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${c.isKey ? 'bg-yellow-100 text-yellow-700' : 'bg-gray-100 text-gray-500'}`}>{c.level || 'C'}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-600">{STAGE_LABELS[stage] || stage}</span>
                  <span className="text-[10px] text-red-500">沉寂{days}天</span>
                </div>
                <div className="text-xs text-gray-400 truncate">{c.email} · {c.company || ''}</div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={() => handleQuickFollow(c)} className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs flex items-center gap-1 hover:bg-blue-700">
                  <Send size={11} /> 跟进
                </button>
                {list.some(f => f.customerId === c.id && f.status === 'pending') && (
                  <button onClick={() => { const fu = list.find(f => f.customerId === c.id && f.status === 'pending'); if (fu) handleComplete(fu) }} className="px-2 py-1.5 bg-green-50 text-green-600 border border-green-200 rounded-lg text-xs">✓ 完成</button>
                )}
                <button onClick={() => navigate('/inbox')} className="px-2 py-1.5 bg-white border rounded-lg text-xs text-gray-500">邮件 ›</button>
              </div>
            </div>
          ))}
          {pageData.length === 0 && <div className="text-center text-xs text-gray-300 py-8">暂无预警</div>}
        </div>

        {/* 分页 */}
        <div className="flex items-center justify-between mt-3 text-xs text-gray-400">
          <span>共 {catFiltered.length} 条</span>
          <div className="flex items-center gap-1">
            <button onClick={() => setPage(p => Math.max(1, p - 1))} className="w-6 h-6 bg-white border rounded">{'<'}</button>
            {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => i + 1).map(n => (
              <button key={n} onClick={() => setPage(n)} className={`w-6 h-6 rounded ${page === n ? 'bg-blue-500 text-white' : 'bg-white border'}`}>{n}</button>
            ))}
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} className="w-6 h-6 bg-white border rounded">{'>'}</button>
          </div>
        </div>
      </div>

      {/* 发送弹窗 */}
      {showSendModal && sendTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowSendModal(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-3 border-b flex items-center justify-between">
              <div className="text-sm font-semibold">跟进邮件 → {sendTarget.contactName || sendTarget.title}</div>
              <button onClick={() => setShowSendModal(false)} className="p-1 hover:bg-gray-100 rounded-lg">✕</button>
            </div>
            <div className="flex-1 overflow-y-auto p-5 space-y-3">
              <div className="flex gap-1 flex-wrap">
                {TEMPLATES.map(t => (
                  <button key={t.id} onClick={() => {
                    setSendTemplate(t)
                    const product = sendTarget.portrait?.products?.[0] || 'Challenge Coin'
                    setSendSubject(t.subject.replace(/\{\{product\}\}/g, product))
                    setSendBody(t.body.replace(/\{\{first_name\}\}/g, (sendTarget.contactName || sendTarget.title || 'there').split(' ')[0]).replace(/\{\{product\}\}/g, product))
                  }} className={`px-2 py-1 rounded-full text-[11px] border ${sendTemplate.id === t.id ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-white text-gray-500'}`}>{t.name}</button>
                ))}
              </div>
              <div><label className="text-xs text-gray-400">收件人</label><input value={sendTarget.email || ''} readOnly className="w-full px-3 py-2 border rounded-lg text-sm bg-gray-50" /></div>
              <div><label className="text-xs text-gray-400">主题</label><input value={sendSubject} onChange={e => setSendSubject(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm" /></div>
              <div><label className="text-xs text-gray-400">正文</label><textarea value={sendBody} onChange={e => setSendBody(e.target.value)} className="w-full h-48 px-3 py-2 border rounded-lg text-sm resize-none" /></div>
            </div>
            <div className="px-5 py-3 border-t flex items-center gap-2">
              <button onClick={() => setShowSendModal(false)} className="px-4 py-2 text-xs text-gray-500 hover:bg-gray-100 rounded-lg">取消</button>
              <div className="flex-1" />
              <button onClick={handleSend} disabled={sending || !sendBody.trim()} className="px-6 py-2 bg-blue-600 text-white rounded-lg text-xs flex items-center gap-1.5 hover:bg-blue-700 disabled:opacity-50">
                <Send size={12} /> {sending ? '发送中...' : '发送'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
