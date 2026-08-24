import { useState, useEffect } from 'react'
import { useStore } from '../store'
import { Plus, Globe, ShoppingCart, Bot, Settings as SettingsIcon, ChevronRight, Trash2, Mail, FileText, CheckCircle, Clock, TrendingUp } from 'lucide-react'

type TabKey = 'customers' | 'inquiries' | 'sop' | 'templates'

interface Customer {
  id: string
  name: string
  country: string
  contact: string
  status: 'lead' | 'active' | 'vip' | 'inactive'
  notes: string
  createdAt: string
}

interface Inquiry {
  id: string
  customerName: string
  product: string
  status: 'new' | 'quoted' | 'negotiating' | 'won' | 'lost'
  amount?: number
  date: string
  notes: string
}

interface SopItem {
  id: string
  title: string
  steps: string[]
  category: string
}

interface Template {
  id: string
  title: string
  category: string
  content: string
}

const LS_KEY = 'evan-os-work-data'

function loadData(): { customers: Customer[]; inquiries: Inquiry[]; sops: SopItem[]; templates: Template[] } {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  // 种子数据
  return {
    customers: [
      { id: 'c1', name: 'John Smith', country: '美国', contact: 'john@smithco.com', status: 'vip', notes: '老客户，主要采购电子产品', createdAt: new Date().toISOString() },
      { id: 'c2', name: 'Maria Garcia', country: '西班牙', contact: 'maria@garcia.es', status: 'active', notes: '新客户，对家居用品感兴趣', createdAt: new Date().toISOString() },
    ],
    inquiries: [
      { id: 'i1', customerName: 'John Smith', product: '蓝牙耳机 x500', status: 'negotiating', amount: 12500, date: new Date().toISOString().slice(0, 10), notes: '客户要求定制包装' },
      { id: 'i2', customerName: 'Maria Garcia', product: '竹制餐具套装 x200', status: 'new', date: new Date().toISOString().slice(0, 10), notes: '首次询盘，需报价' },
    ],
    sops: [
      { id: 's1', title: '询盘处理流程', category: '外贸', steps: ['收到询盘，24小时内回复', '确认产品规格、数量、目标价', '制作报价单（PI）', '跟进客户反馈', '成交后录入订单系统'] },
      { id: 's2', title: '独立站上新流程', category: '独立站', steps: ['选品调研（竞品+趋势）', '拍摄/制作产品图', '编写 SEO 标题和描述', '上传产品并检查页面', '设置广告投放计划'] },
    ],
    templates: [
      { id: 't1', title: '询盘回复模板', category: '外贸', content: 'Dear [Name],\n\nThank you for your inquiry about [Product].\n\nWe are pleased to offer you the following:\n- Product: [Product]\n- Quantity: [Qty]\n- Unit Price: [Price] FOB Shanghai\n- Lead Time: [Days] days\n- Payment Terms: T/T 30% deposit\n\nPlease find the attached quotation for details. Looking forward to your reply.\n\nBest regards,\n[Your Name]' },
      { id: 't2', title: '跟进邮件模板', category: '外贸', content: 'Dear [Name],\n\nHope you are doing well.\n\nI am following up on the quotation sent on [Date]. Have you had a chance to review it? Please let me know if you have any questions or need any adjustments.\n\nLooking forward to hearing from you.\n\nBest regards,\n[Your Name]' },
      { id: 't3', title: '产品描述模板', category: '独立站', content: 'Product Title: [SEO关键词 + 产品名]\n\nFeatures:\n• [卖点1]\n• [卖点2]\n• [卖点3]\n\nSpecifications:\n- Material: [材质]\n- Size: [尺寸]\n- Weight: [重量]\n\nPackage Includes:\n- [内容物]\n\nPerfect for [使用场景]. Order now and enjoy fast shipping!' },
    ],
  }
}

function saveData(data: any) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(data)) } catch { /* ignore */ }
}

const statusColors: Record<string, string> = {
  lead: 'bg-blue-100 text-blue-600',
  active: 'bg-green-100 text-green-600',
  vip: 'bg-purple-100 text-purple-600',
  inactive: 'bg-gray-100 text-gray-500',
  new: 'bg-orange-100 text-orange-600',
  quoted: 'bg-blue-100 text-blue-600',
  negotiating: 'bg-yellow-100 text-yellow-600',
  won: 'bg-green-100 text-green-600',
  lost: 'bg-red-100 text-red-600',
}

const statusLabels: Record<string, string> = {
  lead: '潜在客户', active: '活跃客户', vip: 'VIP', inactive: ' inactive',
  new: '新建', quoted: '已报价', negotiating: '谈判中', won: '已成交', lost: '已流失',
}

const tabs: { key: TabKey; label: string; icon: any }[] = [
  { key: 'customers', label: '👥 客户管理', icon: Globe },
  { key: 'inquiries', label: '📋 询盘跟进', icon: FileText },
  { key: 'sop', label: '📝 工作流程', icon: SettingsIcon },
  { key: 'templates', label: '✉️ 邮件模板', icon: Mail },
]

export default function WorkPage() {
  const [data, setData] = useState(loadData())
  const [activeTab, setActiveTab] = useState<TabKey>('customers')
  const [showForm, setShowForm] = useState(false)

  useEffect(() => { saveData(data) }, [data])

  // ====== 表单状态 ======
  const [newCustomer, setNewCustomer] = useState({ name: '', country: '', contact: '', notes: '' })
  const [newInquiry, setNewInquiry] = useState({ customerName: '', product: '', amount: '', notes: '' })
  const [newSop, setNewSop] = useState({ title: '', category: '', steps: '' })
  const [newTemplate, setNewTemplate] = useState({ title: '', category: '', content: '' })

  const addCustomer = () => {
    if (!newCustomer.name.trim()) return
    const c: Customer = { id: Date.now().toString(), name: newCustomer.name, country: newCustomer.country, contact: newCustomer.contact, status: 'lead', notes: newCustomer.notes, createdAt: new Date().toISOString() }
    setData(d => ({ ...d, customers: [...d.customers, c] }))
    setNewCustomer({ name: '', country: '', contact: '', notes: '' }); setShowForm(false)
  }
  const addInquiry = () => {
    if (!newInquiry.customerName.trim()) return
    const i: Inquiry = { id: Date.now().toString(), customerName: newInquiry.customerName, product: newInquiry.product, status: 'new', amount: newInquiry.amount ? Number(newInquiry.amount) : undefined, date: new Date().toISOString().slice(0, 10), notes: newInquiry.notes }
    setData(d => ({ ...d, inquiries: [...d.inquiries, i] }))
    setNewInquiry({ customerName: '', product: '', amount: '', notes: '' }); setShowForm(false)
  }
  const addSop = () => {
    if (!newSop.title.trim()) return
    const s: SopItem = { id: Date.now().toString(), title: newSop.title, category: newSop.category || '通用', steps: newSop.steps.split('\n').filter(s => s.trim()) }
    setData(d => ({ ...d, sops: [...d.sops, s] }))
    setNewSop({ title: '', category: '', steps: '' }); setShowForm(false)
  }
  const addTemplate = () => {
    if (!newTemplate.title.trim()) return
    const t: Template = { id: Date.now().toString(), title: newTemplate.title, category: newTemplate.category || '通用', content: newTemplate.content }
    setData(d => ({ ...d, templates: [...d.templates, t] }))
    setNewTemplate({ title: '', category: '', content: '' }); setShowForm(false)
  }

  const deleteItem = (tab: TabKey, id: string) => {
    if (tab === 'customers') setData(d => ({ ...d, customers: d.customers.filter(c => c.id !== id) }))
    if (tab === 'inquiries') setData(d => ({ ...d, inquiries: d.inquiries.filter(i => i.id !== id) }))
    if (tab === 'sop') setData(d => ({ ...d, sops: d.sops.filter(s => s.id !== id) }))
    if (tab === 'templates') setData(d => ({ ...d, templates: d.templates.filter(t => t.id !== id) }))
  }

  const updateInquiryStatus = (id: string, status: Inquiry['status']) => {
    setData(d => ({ ...d, inquiries: d.inquiries.map(i => i.id === id ? { ...i, status } : i) }))
  }
  const updateCustomerStatus = (id: string, status: Customer['status']) => {
    setData(d => ({ ...d, customers: d.customers.map(c => c.id === id ? { ...c, status } : c) }))
  }

  const copyTemplate = (content: string) => {
    navigator.clipboard?.writeText(content).then(() => {
      // 简单反馈
    }).catch(() => {})
  }

  const inputClass = 'w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-200'

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">💼 工作</h1>
          <p className="text-sm text-gray-400 mt-0.5">外贸业务 · 独立站运营 · 工作流程</p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition-colors"
        >
          <Plus size={16} /> 新增
        </button>
      </div>

      {/* Tab 切换 */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => { setActiveTab(tab.key); setShowForm(false) }}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-full text-sm whitespace-nowrap transition-colors ${
              activeTab === tab.key ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-100 border border-gray-200'
            }`}
          >
            <tab.icon size={14} />
            {tab.label}
          </button>
        ))}
      </div>

      {/* 表单 */}
      {showForm && (
        <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100 space-y-3">
          {activeTab === 'customers' && (
            <>
              <h3 className="text-sm font-semibold text-gray-700">新增客户</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <input value={newCustomer.name} onChange={e => setNewCustomer({ ...newCustomer, name: e.target.value })} placeholder="客户名称" className={inputClass} autoFocus />
                <input value={newCustomer.country} onChange={e => setNewCustomer({ ...newCustomer, country: e.target.value })} placeholder="国家/地区" className={inputClass} />
                <input value={newCustomer.contact} onChange={e => setNewCustomer({ ...newCustomer, contact: e.target.value })} placeholder="联系方式（邮箱/WhatsApp）" className={inputClass} />
              </div>
              <textarea value={newCustomer.notes} onChange={e => setNewCustomer({ ...newCustomer, notes: e.target.value })} placeholder="备注..." rows={2} className={inputClass} />
              <button onClick={addCustomer} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">添加客户</button>
            </>
          )}
          {activeTab === 'inquiries' && (
            <>
              <h3 className="text-sm font-semibold text-gray-700">新增询盘</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <input value={newInquiry.customerName} onChange={e => setNewInquiry({ ...newInquiry, customerName: e.target.value })} placeholder="客户名称" className={inputClass} autoFocus />
                <input value={newInquiry.product} onChange={e => setNewInquiry({ ...newInquiry, product: e.target.value })} placeholder="产品 + 数量" className={inputClass} />
                <input value={newInquiry.amount} onChange={e => setNewInquiry({ ...newInquiry, amount: e.target.value })} placeholder="预估金额（USD）" type="number" className={inputClass} />
              </div>
              <textarea value={newInquiry.notes} onChange={e => setNewInquiry({ ...newInquiry, notes: e.target.value })} placeholder="备注..." rows={2} className={inputClass} />
              <button onClick={addInquiry} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">添加询盘</button>
            </>
          )}
          {activeTab === 'sop' && (
            <>
              <h3 className="text-sm font-semibold text-gray-700">新增工作流程（SOP）</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <input value={newSop.title} onChange={e => setNewSop({ ...newSop, title: e.target.value })} placeholder="流程名称" className={inputClass} autoFocus />
                <input value={newSop.category} onChange={e => setNewSop({ ...newSop, category: e.target.value })} placeholder="分类（外贸/独立站/通用）" className={inputClass} />
              </div>
              <textarea value={newSop.steps} onChange={e => setNewSop({ ...newSop, steps: e.target.value })} placeholder="每行一个步骤..." rows={5} className={inputClass} />
              <button onClick={addSop} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">添加流程</button>
            </>
          )}
          {activeTab === 'templates' && (
            <>
              <h3 className="text-sm font-semibold text-gray-700">新增模板</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <input value={newTemplate.title} onChange={e => setNewTemplate({ ...newTemplate, title: e.target.value })} placeholder="模板名称" className={inputClass} autoFocus />
                <input value={newTemplate.category} onChange={e => setNewTemplate({ ...newTemplate, category: e.target.value })} placeholder="分类（外贸/独立站/通用）" className={inputClass} />
              </div>
              <textarea value={newTemplate.content} onChange={e => setNewTemplate({ ...newTemplate, content: e.target.value })} placeholder="模板内容...（用 [变量] 标记可替换部分）" rows={8} className={inputClass} />
              <button onClick={addTemplate} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">添加模板</button>
            </>
          )}
        </div>
      )}

      {/* 客户管理 */}
      {activeTab === 'customers' && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {data.customers.map(c => (
            <div key={c.id} className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100 group">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 font-bold">
                    {c.name[0]?.toUpperCase()}
                  </div>
                  <div>
                    <h3 className="font-semibold text-gray-800 text-sm">{c.name}</h3>
                    <p className="text-xs text-gray-400">🌍 {c.country}</p>
                  </div>
                </div>
                <button onClick={() => deleteItem('customers', c.id)} className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-500 transition-all">
                  <Trash2 size={14} />
                </button>
              </div>
              <div className="space-y-1.5 text-xs">
                {c.contact && <p className="text-gray-500">📧 {c.contact}</p>}
                {c.notes && <p className="text-gray-400">{c.notes}</p>}
              </div>
              <div className="mt-3 flex items-center gap-2">
                <select
                  value={c.status}
                  onChange={e => updateCustomerStatus(c.id, e.target.value as Customer['status'])}
                  className={`text-[10px] px-2 py-1 rounded-full border-0 outline-none cursor-pointer ${statusColors[c.status]}`}
                >
                  <option value="lead">潜在客户</option>
                  <option value="active">活跃客户</option>
                  <option value="vip">VIP</option>
                  <option value="inactive">inactive</option>
                </select>
              </div>
            </div>
          ))}
          {data.customers.length === 0 && (
            <div className="col-span-full text-center py-12 text-gray-400 text-sm">暂无客户，点击「新增」添加第一个客户</div>
          )}
        </div>
      )}

      {/* 询盘跟进 */}
      {activeTab === 'inquiries' && (
        <div className="space-y-3">
          {/* 统计条 */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {(['new', 'quoted', 'negotiating', 'won', 'lost'] as const).map(s => (
              <div key={s} className="bg-white rounded-xl p-3 border border-gray-100 text-center">
                <div className={`text-2xl font-bold ${statusColors[s].split(' ')[1]}`}>{data.inquiries.filter(i => i.status === s).length}</div>
                <div className="text-[10px] text-gray-400 mt-0.5">{statusLabels[s]}</div>
              </div>
            ))}
          </div>
          {/* 询盘列表 */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
            {data.inquiries.map((i, idx) => (
              <div key={i.id} className={`flex items-center gap-4 p-4 group hover:bg-gray-50 transition-colors ${idx > 0 ? 'border-t border-gray-50' : ''}`}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-gray-800">{i.customerName}</span>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full ${statusColors[i.status]}`}>{statusLabels[i.status]}</span>
                  </div>
                  <p className="text-xs text-gray-500">{i.product}</p>
                  {i.notes && <p className="text-[11px] text-gray-400 mt-0.5">{i.notes}</p>}
                </div>
                {i.amount && (
                  <div className="text-right">
                    <div className="text-sm font-bold text-gray-700">${i.amount.toLocaleString()}</div>
                    <div className="text-[10px] text-gray-400">{i.date}</div>
                  </div>
                )}
                <select
                  value={i.status}
                  onChange={e => updateInquiryStatus(i.id, e.target.value as Inquiry['status'])}
                  className="text-xs border border-gray-200 rounded-lg px-2 py-1 bg-white opacity-0 group-hover:opacity-100 transition-opacity outline-none"
                >
                  <option value="new">新建</option>
                  <option value="quoted">已报价</option>
                  <option value="negotiating">谈判中</option>
                  <option value="won">已成交</option>
                  <option value="lost">已流失</option>
                </select>
                <button onClick={() => deleteItem('inquiries', i.id)} className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-500 transition-all">
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            {data.inquiries.length === 0 && (
              <div className="p-12 text-center text-gray-400 text-sm">暂无询盘记录</div>
            )}
          </div>
        </div>
      )}

      {/* 工作流程 SOP */}
      {activeTab === 'sop' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {data.sops.map(sop => (
            <div key={sop.id} className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100 group">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-600">{sop.category}</span>
                  <h3 className="font-semibold text-gray-800 text-sm">{sop.title}</h3>
                </div>
                <button onClick={() => deleteItem('sop', sop.id)} className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-500 transition-all">
                  <Trash2 size={14} />
                </button>
              </div>
              <ol className="space-y-2">
                {sop.steps.map((step, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs text-gray-600">
                    <span className="flex-shrink-0 w-5 h-5 rounded-full bg-gray-100 flex items-center justify-center text-[10px] font-bold text-gray-500">{i + 1}</span>
                    <span className="pt-0.5">{step}</span>
                  </li>
                ))}
              </ol>
            </div>
          ))}
          {data.sops.length === 0 && (
            <div className="col-span-full text-center py-12 text-gray-400 text-sm">暂无工作流程</div>
          )}
        </div>
      )}

      {/* 邮件模板 */}
      {activeTab === 'templates' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {data.templates.map(t => (
            <div key={t.id} className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100 group">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs px-2 py-0.5 rounded-full bg-green-50 text-green-600">{t.category}</span>
                  <h3 className="font-semibold text-gray-800 text-sm">{t.title}</h3>
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => copyTemplate(t.content)} className="text-xs text-blue-600 hover:text-blue-700 px-2 py-1 rounded hover:bg-blue-50 transition-colors">
                    复制
                  </button>
                  <button onClick={() => deleteItem('templates', t.id)} className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-500 transition-all">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              <pre className="text-xs text-gray-500 whitespace-pre-wrap bg-gray-50 rounded-lg p-3 max-h-48 overflow-y-auto font-mono leading-relaxed">{t.content}</pre>
            </div>
          ))}
          {data.templates.length === 0 && (
            <div className="col-span-full text-center py-12 text-gray-400 text-sm">暂无模板</div>
          )}
        </div>
      )}
    </div>
  )
}
