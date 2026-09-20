import { useState, useEffect, useMemo, useCallback } from 'react'
import { db } from '../db'
import type { Customer, EmailMessage } from '../types'
import { Star, Search, Calendar, X, GraduationCap, Shield, Users, Globe, Briefcase, Landmark } from 'lucide-react'
import { fetchFullEmailBatch, fetchDbMail, fetchCustomerThreads, listAccounts } from '../repositories/emailRepository'
import MailHtml from '../components/MailHtml'
import { runDailyClassify, formatClassifyResult, loadIntellectConfig, saveIntellectConfig, syncTiersFromRules, levelFromSignals, type IntellectConfig, SYSTEM_TAG_SET } from '../services/customerDailyClassify'
import { coercePortrait, mergePortrait, formatPortraitText, parsePortraitFromProfile, portraitDisplay, PORTRAIT_DIMENSIONS, isFillableDim, type AiPortraitV2 } from '../config/portrait'
import { runOrderScan, importOrdersCsv } from '../services/orderScan'
import { runAiInsight, runPurchaseLoop } from '../services/customerInsight'
import { setCustomerFollowMode, setCustomerSalesStage, followModeOf, salesStageOf, stepLabel, daysNoFollow } from '../services/followProfile'
import { MANUAL_BUCKETS, addManualBuckets, getCustomerBuckets, removeManualBuckets } from '../services/manualBuckets'
import { refreshSentDatesFromLocal, sentDatesOf, formatDays } from '../services/sentDates'

// ====== 邮箱后缀自动分类 ======
const EMAIL_SUFFIX_MAP: Record<string, { label: string; icon: any; color: string }> = {
  'gov': { label: '政府', icon: Landmark, color: 'bg-red-50 text-red-600' },
  'mil': { label: '军队', icon: Shield, color: 'bg-orange-50 text-orange-600' },
  'edu': { label: '教育', icon: GraduationCap, color: 'bg-blue-50 text-blue-600' },
  'org': { label: '非盈利', icon: Users, color: 'bg-purple-50 text-purple-600' },
}
const PERSONAL_DOMAINS = ['gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com','live.com','aol.com','protonmail.com','mail.com','qq.com','163.com','126.com','foxmail.com']

function classifyEmailType(email?: string): { label: string; icon: any; color: string } {
  if(!email) return { label: '未知', icon: Globe, color: 'bg-gray-50 text-gray-500' }
  const suffix = email.split('@')[1]?.toLowerCase() || ''
  // 检查特殊后缀
  for(const [key, val] of Object.entries(EMAIL_SUFFIX_MAP)){
    if(suffix.endsWith('.'+key) || suffix === key) return val
  }
  // 个人邮箱
  if(PERSONAL_DOMAINS.includes(suffix)) return { label: '个人', icon: Users, color: 'bg-green-50 text-green-600' }
  // 企业邮箱
  return { label: '企业', icon: Briefcase, color: 'bg-indigo-50 text-indigo-600' }
}

// ====== 从邮件文本提取金额 ======
function extractAmount(text: string): number {
  const patterns = [
    /\$\s*([\d,]+(?:\.\d{2})?)/g,
    /USD\s*([\d,]+(?:\.\d{2})?)/gi,
    /price[:\s]*\$?([\d,]+(?:\.\d{2})?)/gi,
    /total[:\s]*\$?([\d,]+(?:\.\d{2})?)/gi,
    /预算[:\s]*[\$￥]?([\d,]+)/g,
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

// ====== 自动分类客户等级（与 customerDailyClassify.levelFromSignals 同一口径）=====
function autoClassifyCustomer(c: Customer, emailCount: number, totalAmount: number): { level: Customer['level']; isKey: boolean; customerType: Customer['customerType'] } {
  const level = levelFromSignals(totalAmount, emailCount)
  const isKey = level === 'A+' || level === 'A' || totalAmount > 1500 || emailCount >= 5 || !!c.isKey
  const emailType = classifyEmailType(c.email)
  const typeMap: Record<string, Customer['customerType']> = {
    '政府':'Government','军队':'Military','教育':'School','非盈利':'Organization','企业':'Company','个人':'End Customer'
  }
  const customerType = typeMap[emailType.label] || 'Company'
  return { level, isKey, customerType }
}

export default function CustomersPage(){
  const [list, setList] = useState<Customer[]>([])
  const [filter, setFilter] = useState<'all'|'A+'|'A'|'B'|'C'|'D'|'key'|'gov'|'edu'|'org'|'mil'|'personal'|'enterprise'>( 'all')
  const [tagFilter, setTagFilter] = useState<string>('all')
  const [showTagMgr, setShowTagMgr] = useState(false)
  const [tagInput, setTagInput] = useState('')
  // 全部自定义标签（去掉系统派生标签，避免与 A~D/邮箱类型筛选重复）
  const allTags = useMemo(()=>{
    const m = new Map<string, number>()
    for(const c of list) for(const t of (c.tags || [])){
      const tag = String(t)
      if(SYSTEM_TAG_SET.has(tag)) continue
      m.set(tag, (m.get(tag) || 0) + 1)
    }
    return [...m.entries()].sort((a,b)=> b[1]-a[1])
  },[list])
  const levelCounts = useMemo(()=>{
    const acc: Record<string, number> = { all: list.length, key: 0 }
    for(const c of list){
      const lv = c.level || 'C'
      acc[lv] = (acc[lv]||0)+1
      if(c.isKey) acc.key++
    }
    return acc
  },[list])
  const saveTags = async (c: Customer, tags: string[]) => {
    const clean = [...new Set(tags.map(t=>t.trim()).filter(Boolean))].slice(0, 20)
    await db.customers.update(c.id, { tags: clean, updatedAt: new Date().toISOString() } as any)
    setList(prev => prev.map(x=> x.id===c.id ? { ...x, tags: clean } as Customer : x))
    if(selectedCustomer?.id === c.id) setSelectedCustomer({ ...selectedCustomer, tags: clean } as Customer)
    window.dispatchEvent(new CustomEvent('evan-customers-updated'))
  }
  const deleteTagGlobal = async (tag: string) => {
    if(!confirm(`删除标签「${tag}」？将从所有客户身上移除。`)) return
    const hit = list.filter(c=> (c.tags||[]).includes(tag))
    for(const c of hit) await db.customers.update(c.id, { tags: (c.tags||[]).filter(t=> t!==tag), updatedAt: new Date().toISOString() } as any)
    if(tagFilter === tag) setTagFilter('all')
    setShowTagMgr(false)
    await load()
    window.dispatchEvent(new CustomEvent('evan-customers-updated'))
  }

  const [q,setQ]=useState('')
  /** 客户卡片分页：避免 700+ 张一次性渲染卡死（localStorage 持久化） */
  const [page, setPage] = useState(1)
  const PER_PAGE_CUST_KEY = 'evan:customersPerPage'
  const [perPage, setPerPage] = useState<number>(()=>{
    try{
      const v = Number(localStorage.getItem(PER_PAGE_CUST_KEY))
      return [12,30,60,120].includes(v) ? v : 30
    }catch{ return 30 }
  })
  const setPerPagePersist = (n: number) => {
    const v = [12,30,60,120].includes(n) ? n : 30
    try{ localStorage.setItem(PER_PAGE_CUST_KEY, String(v)) }catch{}
    setPerPage(v)
    setPage(1)
  }
  /** 高级筛选：未跟进天数等 */
  const [showFilters, setShowFilters] = useState(false)
  const [minSilentDays, setMinSilentDays] = useState(0) // 0=不限；>0 则「未跟进 ≥ N 天」
  const [maxSilentDays, setMaxSilentDays] = useState(0) // 0=不限
  const [includeNeverSent, setIncludeNeverSent] = useState(true)
  const [hideOrdered, setHideOrdered] = useState(false)
  /** 组合筛选：等级（空=跟随顶部 A+/A/B 按钮；有值则按此列表） */
  const [comboLevels, setComboLevels] = useState<string[]>([])
  const [selectMode, setSelectMode] = useState(false)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [bulkLevel, setBulkLevel] = useState('')
  const [bulkStage, setBulkStage] = useState('')
  const [bulkTag, setBulkTag] = useState('')
  /** 板块移入：replace=只保留本次选的（默认）；add=叠加 */
  const [bucketAddMode, setBucketAddMode] = useState<'replace'|'add'>('replace')
  const toggleCheck = (id: string) => setChecked(prev => { const n = new Set(prev); if(n.has(id)) n.delete(id); else n.add(id); return n })
  const clearCheck = () => { setChecked(new Set()); setSelectMode(false) }
  const bulkApply = async (kind: 'level' | 'stage' | 'tag' | 'delete') => {
    if(!checked.size) return alert('请先勾选客户')
    if(kind === 'delete' && !confirm(`删除选中的 ${checked.size} 个客户？跟进记录一并删除，该操作可通过云同步墓碑同步。`)) return
    if(kind === 'level' && !bulkLevel) return alert('请先选择等级')
    if(kind === 'stage' && !bulkStage) return alert('请先选择阶段')
    if(kind === 'tag' && !bulkTag.trim()) return alert('请先输入标签')
    const ts = new Date().toISOString()
    let n = 0
    for(const id of checked){
      if(kind === 'delete'){
        await db.followUps.where('customerId').equals(id).delete().catch(()=>{})
        await db.customers.delete(id)
      } else if(kind === 'level'){
        await db.customers.update(id, { level: bulkLevel, updatedAt: ts } as any)
      } else if(kind === 'stage'){
        await db.customers.update(id, { stage: bulkStage, updatedAt: ts } as any)
      } else if(kind === 'tag'){
        const c = await db.customers.get(id) as Customer | undefined
        if(!c) continue
        const tags = [...new Set([...(c.tags || []), bulkTag.trim()])]
        await db.customers.update(id, { tags, updatedAt: ts } as any)
      }
      n++
    }
    setBulkTag('')
    clearCheck()
    await load()
    window.dispatchEvent(new CustomEvent('evan-customers-updated'))
    alert(`批量${kind === 'delete' ? '删除' : kind === 'level' ? '改等级' : kind === 'stage' ? '改阶段' : '加标签'}完成：${n} 个`)
  }
  const [selectedCustomer, setSelectedCustomer] = useState<Customer|null>(null)
  const [customerEmails, setCustomerEmails] = useState<EmailMessage[]>([])
  const [emailStats, setEmailStats] = useState<Record<string, { count: number; totalAmount: number }>>({})
  const [autoClassified, setAutoClassified] = useState(false)
  const [fullContent, setFullContent] = useState<Record<string, {text:string;html:string}>>({})
  const [loadingContent, setLoadingContent] = useState<Record<string, boolean>>({})
  const [contentError, setContentError] = useState<Record<string, boolean>>({})
  const [allowRemoteImg, setAllowRemoteImg] = useState(false)
  const [threadMode, setThreadMode] = useState<'server'|'local'|''>('')
  const [intelCfg, setIntelCfg] = useState<IntellectConfig>(()=> loadIntellectConfig())
  const [showIntel, setShowIntel] = useState(false)
  const [intelBusy, setIntelBusy] = useState<string>('')
  const [intelNote, setIntelNote] = useState('')
  const [showCsvOrder, setShowCsvOrder] = useState(false)
  const [csvOrderText, setCsvOrderText] = useState('')
  /** 十一维画像编辑 */
  const [portraitEdit, setPortraitEdit] = useState<AiPortraitV2 | null>(null)
  const [portraitSaving, setPortraitSaving] = useState(false)
  const openPortraitEdit = (c: Customer) => {
    const merged = mergePortrait(
      coercePortrait((c as any).aiPortrait),
      parsePortraitFromProfile((c as any).aiProfile) || {},
    )
    setPortraitEdit(merged)
  }
  const savePortraitEdit = async () => {
    if(!selectedCustomer || !portraitEdit) return
    setPortraitSaving(true)
    try{
      // 空输入保留原值，避免误清
      const prev = mergePortrait(
        coercePortrait((selectedCustomer as any).aiPortrait),
        parsePortraitFromProfile((selectedCustomer as any).aiProfile) || {},
      )
      const next = mergePortrait(prev, portraitEdit)
      const text = formatPortraitText(next)
      const ts = new Date().toISOString()
      await db.customers.update(selectedCustomer.id, {
        aiPortrait: next,
        aiProfile: `【十一维画像 v2】\n${text}`,
        aiPortraitVersion: 3,
        aiProfileAt: ts,
        portraitEditedAt: ts,
        portraitEditedBy: 'user',
      } as any)
      const fresh = await db.customers.get(selectedCustomer.id) as any
      if(fresh) setSelectedCustomer(fresh)
      setPortraitEdit(null)
      setIntelNote('十一维画像已保存（人工修订，不会被复购开发覆盖）')
      await load()
    }catch(e:any){ setIntelNote('画像保存失败：'+String(e.message||e).slice(0,100)) }
    finally{ setPortraitSaving(false) }
  }

  const patchIntelCfg = useCallback((p: Partial<IntellectConfig>)=>{
    const n = saveIntellectConfig(p)
    setIntelCfg(n)
  },[])

  // ====== 批量导入客户（CSV粘贴）：等级/重点/阶段/多品类/复购/类型/多邮箱 ======
  const [showImport, setShowImport] = useState(false)
  const [importText, setImportText] = useState('')
  const [importing, setImporting] = useState(false)
  const IMPORT_TEMPLATE = `姓名,邮箱(多个用;分隔),公司,等级(A+/A/B/C/D),重点(是/否),阶段(lead/contacted/qualified/proposal/negotiation/won/lost/已下单),产品(多个用/分隔pin/patch/coin/medal/keychains),复购次数,类型(政府/企业/消防/学校/个人),电话,国家,备注,下次跟进(YYYY-MM-DD),分类(多个用/分隔,自动同步为标签),金额(USD)
Pete Escanilla,pete.escamilla82@gmail.com,ABC Corp,A,是,contacted,pin/patch,2,企业,,USA,老客户,2026-09-20,复购/重要,2500`
  const PRODUCT_MAP: Record<string,string> = { pin:'Pin', patch:'Patch', coin:'Coin', medal:'Medal', keychain:'Keychain', keychains:'Keychain' }
  const TYPE_MAP: Record<string, Customer['customerType']> = { '政府':'Government', '企业':'Company', '学校':'School', '非盈利':'Organization', '个人':'End Customer', '消防':'Government' }
  // CSV 文本转行数组（支持引号包裹逗号）
  const csvToRows = (text: string): string[][] => {
    const out: string[][] = []
    for(const line of text.split('\n')){
      const t = line.trim()
      if(!t) continue
      const cols: string[] = []
      let cur = '', inQ = false
      for(const ch of t){
        if(ch === '"'){ inQ = !inQ; continue }
        if((ch === ',' || ch === '\t') && !inQ){ cols.push(cur.trim()); cur = ''; continue }
        cur += ch
      }
      cols.push(cur.trim())
      out.push(cols)
    }
    return out
  }
  const rowsToCustomers = (rows: string[][]) => {
    if(!rows.length) return []
    const hasHeader = /姓名|name/i.test(rows[0][0] || '')
    // 表头识别：兼容13列老格式与15列新格式（末尾+分类,金额）
    let colIndex: Record<string, number> = {}
    if(hasHeader){
      const heads = rows[0].map(h=> h.replace(/\(.*\)/g, '').trim())
      const find = (...keys: string[]) => heads.findIndex(h=> keys.some(k=> h.includes(k)))
      const fixed = ['姓名','邮箱','公司','等级','重点','阶段','产品','复购次数','类型','电话','国家','备注','下次跟进']
      fixed.forEach((k, i)=> { colIndex[k] = i });
      colIndex['分类'] = find('分类', '标签')
      colIndex['金额'] = find('金额', '订单金额', 'amount')
    }
    const get = (cols: string[], key: string, fallbackIdx: number) => {
      const i = colIndex[key]
      if(i != null && i >= 0 && i < cols.length) return cols[i]
      return cols[fallbackIdx] || ''
    }
    const body = hasHeader ? rows.slice(1) : rows
    const out: any[] = []
    for(const cols0 of body){
      const cols = [...cols0]
      while(cols.length < 15) cols.push('')
      const name = get(cols, '姓名', 0)
      const emailsRaw = get(cols, '邮箱', 1)
      const company = get(cols, '公司', 2)
      const level = get(cols, '等级', 3)
      const isKeyRaw = get(cols, '重点', 4)
      const stageRaw = get(cols, '阶段', 5)
      const productsRaw = get(cols, '产品', 6)
      const repRaw = get(cols, '复购次数', 7)
      const typeRaw = get(cols, '类型', 8)
      const phone = get(cols, '电话', 9)
      const country = get(cols, '国家', 10)
      const notes = get(cols, '备注', 11)
      const followUpAt = get(cols, '下次跟进', 12)
      const catsRaw = get(cols, '分类', 13)
      const amountRaw = get(cols, '金额', 14)
      const emails = emailsRaw.split(';').map(e=>e.trim().toLowerCase()).filter(e=>e.includes('@'))
      if(!emails.length) continue
      const products = productsRaw.split('/').map(p=> PRODUCT_MAP[p.trim().toLowerCase()] || p.trim()).filter(Boolean)
      const categories = catsRaw.split('/').map(s=> s.trim()).filter(Boolean)
      const stage = stageRaw === '已下单' ? 'won' : (['lead','contacted','qualified','proposal','negotiation','won','lost'].includes(stageRaw) ? stageRaw : 'lead')
      out.push({
        name: name || emails[0].split('@')[0], emails, primary: emails[0],
        company, level: (['A+','A','B','C','D'].includes(level) ? level : 'C') as Customer['level'],
        isKey: isKeyRaw === '是' || level === 'A' || level === 'A+',
        stage, products, categories, amount: parseFloat(String(amountRaw).replace(/[$,]/g, '')) || 0,
        repurchaseCount: Number(repRaw) || 0,
        customerType: TYPE_MAP[typeRaw] || 'Company', typeRaw,
        phone, country, notes, followUpAt: /^\d{4}-\d{2}-\d{2}$/.test(followUpAt) ? followUpAt : new Date(Date.now()+3*86400000).toISOString().slice(0,10),
      })
    }
    return out
  }
  const parseImport = (text: string) => rowsToCustomers(csvToRows(text))
  const [importFileName, setImportFileName] = useState('')
  const handleImportFile = async (f: File) => {
    try{
      const XLSX = await import('xlsx')
      const buf = await f.arrayBuffer()
      const wb = XLSX.read(buf, { type: 'array' })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: '', raw: false }) as string[][]
      const clean = rows.filter(r => r.some(c => String(c||'').trim() !== '')).map(r => r.map(c => String(c||'').trim()))
      // Excel 里多邮箱可能用换行分隔，统一成 ;
      for(const r of clean) for(let i=0;i<r.length;i++) r[i] = r[i].replace(/\n+/g, ';')
      setImportText(clean.map(r => r.map(c => /[,\"\n]/.test(c) ? `"${c.replace(/"/g,'""')}"` : c).join(',')).join('\n'))
      setImportFileName(f.name)
    }catch(e:any){ alert('文件解析失败：' + String(e.message||e).slice(0,150)) }
  }
  const importPreview = parseImport(importText)
  const handleImportConfirm = async () => {
    if(!importPreview.length) return alert('没有可导入的有效行')
    setImporting(true)
    try{
      const { uid, now } = await import('../repositories/result')
      const existing = await db.customers.toArray() as Customer[]
      const byEmail = new Map<string, Customer>()
      for(const c of existing){
        if(c.email) byEmail.set(c.email.toLowerCase(), c)
        for(const e of (c.extraEmails || [])) byEmail.set(e.toLowerCase(), c)
      }
      const LEVEL_ORDER = ['D','C','B','A','A+']
      let nNew = 0, nMerge = 0, nFu = 0
      const ts = now()
      for(const r of importPreview){
        let target = byEmail.get(r.primary)
        if(!target){
          for(const e of r.emails){ const hit = byEmail.get(e); if(hit){ target = hit; break } }
        }
        if(target){
          // 合并：只升级不降级；分类并入标签
          const patch: any = {}
          if(LEVEL_ORDER.indexOf(r.level) > LEVEL_ORDER.indexOf(target.level || 'C')) patch.level = r.level
          if(r.isKey && !target.isKey) patch.isKey = true
          if(r.stage === 'won' && target.stage !== 'won') patch.stage = 'won'
          const mergedTags = [...new Set([...(target.tags || []), ...(r.categories || [])])]
          if(mergedTags.join() !== (target.tags || []).join()) patch.tags = mergedTags
          if((r.amount || 0) > 0 && !(target.value || 0)) { patch.value = r.amount; patch.currency = 'USD' }
          const mergedExtra = [...new Set([...(target.extraEmails || []), ...r.emails.filter((e:string)=> e !== target!.email!.toLowerCase())])]
          if(mergedExtra.join() !== (target.extraEmails || []).join()) patch.extraEmails = mergedExtra
          const mergedProd = [...new Set([...(target.portrait?.products || []), ...r.products])]
          if(mergedProd.length !== (target.portrait?.products || []).length) patch.portrait = { ...(target.portrait || {}), products: mergedProd }
          if((r.repurchaseCount || 0) > (target.repurchaseCount || 0)) patch.repurchaseCount = r.repurchaseCount
          if(r.notes) patch.notes = [target.notes, `导入:${r.notes}`].filter(Boolean).join(' | ').slice(0, 500)
          patch.updatedAt = ts
          if(Object.keys(patch).length > 1){
            await db.customers.update(target.id, patch)
            // 同步内存索引，避免同批重复建
            Object.assign(target, patch)
            nMerge++
          }
          for(const e of r.emails) byEmail.set(e, target)
        } else {
          const id = `import-${uid()}`
          const rec: any = {
            id, type:'customer', title: r.name, contactName: r.name, company: r.company,
            email: r.primary, extraEmails: r.emails.slice(1),
            stage: r.stage, isKey: r.isKey, level: r.level, customerType: r.customerType,
            tags: [...new Set(['邮件','批量导入', ...(r.categories || []), ...(r.typeRaw === '消防' ? ['消防'] : [])])],
            phone: r.phone, country: r.country,
            notes: [r.notes, r.typeRaw === '消防' ? '[消防部门]' : ''].filter(Boolean).join(' | '),
            repurchaseCount: r.repurchaseCount,
            value: r.amount || 0, currency: r.amount ? 'USD' : undefined,
            portrait: r.products.length ? { products: r.products } : undefined,
            createdAt: ts, updatedAt: ts, relations: [],
            followUpAt: r.followUpAt, score: 0,
          }
          await db.customers.put(rec)
          byEmail.set(r.primary, rec)
          for(const e of r.emails) byEmail.set(e, rec)
          nNew++
          target = rec
        }
        // 无待办跟进则建一条（客户/跟进/营销/拓扑/全景读同一份数据，写一次全端同步）
        const hasPending = await db.followUps.filter((f:any)=> f.customerId === target!.id && f.status === 'pending').first()
        if(!hasPending){
          await db.followUps.put({ id:`fu-${uid()}`, customerId: target!.id, dueAt: r.followUpAt, channel:['批量导入'], note:`批量导入跟进（${r.level}${r.isKey?'/重点':''}）`, status:'pending', createdAt: ts } as any)
          nFu++
        }
      }
      window.dispatchEvent(new CustomEvent('evan-customers-updated'))
      alert(`导入完成：新建 ${nNew} 个，合并 ${nMerge} 个，新建跟进 ${nFu} 条\n客户/跟进/营销/拓扑/全景已同步（云同步会自动上传多端）`)
      setShowImport(false); setImportText('')
      await load()
      // 导入后自动排重（邮件自动建的 vs 批量导入的，保留批量导入）
      try{ await handleDedupe(true) }catch{}
    }catch(e:any){ alert('导入失败：' + String(e.message||e).slice(0,200)) }
    finally{ setImporting(false) }
  }

  const load = useCallback(async()=>{
    const customers = await db.customers.toArray() as any[]
    setList(customers)
    // 统计每个客户的邮件数和金额
    const allEmails = await db.emails.toArray() as EmailMessage[]
    const stats: Record<string, { count: number; totalAmount: number }> = {}
    for(const e of allEmails){
      const addr = (e.from.match(/<(.+?)>/)?.[1]||e.from).trim().toLowerCase()
      if(!addr) continue
      if(!stats[addr]) stats[addr] = { count:0, totalAmount:0 }
      stats[addr].count++
      stats[addr].totalAmount += extractAmount(e.subject+' '+(e.text||''))
    }
    setEmailStats(stats)
    // 自动分类（首次）
    if(!autoClassified){
      setAutoClassified(true)
      let changed = false
      for(const c of customers){
        if(!c.email) continue
        const addr = c.email.toLowerCase()
        const s = stats[addr] || { count:0, totalAmount:0 }
        const cls = autoClassifyCustomer(c, s.count, s.totalAmount)
        if(cls.level !== c.level || cls.isKey !== c.isKey || cls.customerType !== c.customerType){
          await db.customers.update(c.id, { level: cls.level, isKey: cls.isKey, customerType: cls.customerType } as any)
          changed = true
        }
      }
      if(changed) setList(await db.customers.toArray() as any[])
    }
  },[autoClassified])

  useEffect(()=>{void load(); const h=()=> void load(); window.addEventListener('evan-emails-updated', h); window.addEventListener('evan-customers-updated', h); return ()=>{ window.removeEventListener('evan-emails-updated', h); window.removeEventListener('evan-customers-updated', h) }},[load])

  // 自动分类（含订单扫描）/ AI 洞察 / 复购开发
  const handleDailyClassify = useCallback(async ()=>{
    setIntelBusy('classify'); setIntelNote('')
    try{
      const r = await runDailyClassify({ force: true })
      let note = '自动分类：' + formatClassifyResult(r)
      const os = await runOrderScan({ rescanAll: true })
      const { syncOrderedCustomersFollowUps } = await import('../services/orderScan')
      const align = await syncOrderedCustomersFollowUps({ purge: true })
      note += ' · 订单+' + os.ordersAdded + ' 已下单' + os.customersTagged + ' 重复' + os.duplicates
      note += ` · 清误标${align.purged}/真实已下单${align.ordered}/关跟进${align.followUpsClosed}`
      setIntelNote(note)
      await load()
    }catch(e:any){ setIntelNote('自动分类失败：'+String(e.message||e).slice(0,100)) }
    finally{ setIntelBusy('') }
  },[load])

  const handleAiInsight = useCallback(async ()=>{
    const { getAiSettings } = await import('../config/aiProviders')
    const ai = getAiSettings()
    const aiReady = !!(ai.apiKey || ai.proxyUrl)
    setIntelBusy('insight')
    setIntelNote(aiReady
      ? 'AI洞察进行中…（读取往来并调用大模型）'
      : '⚠️ 未配置 AI Key/代理，可能失败。请到 AI 设置配置后再跑。')
    try{
      const r = await runAiInsight({ limit: intelCfg.aiInsightBatchMax })
      let note = r.note || ('AI 洞察：成功 '+r.ok+' · 失败 '+r.fail)
      if(r.queued===0) note += '｜请先自动分类，或把冷却调成 0'
      if(r.fail>0 && r.ok===0) note += '｜请检查 AI Key/网络'
      setIntelNote(note)
      await load()
    }catch(e:any){ setIntelNote('洞察失败：'+String(e.message||e).slice(0,120)) }
    finally{ setIntelBusy('') }
  },[load, intelCfg])

  const handlePurchaseLoop = useCallback(async ()=>{
    const { getAiSettings } = await import('../config/aiProviders')
    const ai = getAiSettings()
    const aiReady = !!(ai.apiKey || ai.proxyUrl)
    const batch = Math.max(1, Math.min(500, intelCfg.purchaseLoopBatchMax || 20))
    setIntelBusy('loop')
    setIntelNote(aiReady
      ? `复购开发进行中：结合十一维画像+订单+邮件分析（每次最多 ${batch} 人）…`
      : `复购开发：未配置 AI Key，将用规则估算；每次最多 ${batch} 人…`)
    try{
      const r = await runPurchaseLoop({
        limit: batch,
        delayMs: 800,
        onProgress: (done, total, name)=>{
          setIntelNote(`复购开发 ${done}/${total} · ${name} …（画像+订单+邮件，不覆盖十一维）`)
        },
      })
      let note = r.note || `复购开发：更新 ${r.updated} 位`
      if(!r.totalOrdered) note += '｜无已下单客户，请先「订单对齐」或导入订单 CSV'
      if(r.aiFail && !r.aiOk) note += '｜AI 未返回，已用规则兜底'
      setIntelNote(note)
      await load()
    }catch(e:any){ setIntelNote('复购开发失败：'+String(e.message||e).slice(0,120)) }
    finally{ setIntelBusy('') }
  },[load, intelCfg])

  // 打开页面：默认自动每日分类 + 近 N 天订单扫描
  useEffect(()=>{
    if(!intelCfg.autoDailyClassify && !intelCfg.autoOrderScan) return
    let cancelled = false
    ;(async()=>{
      try{
        if(intelCfg.autoDailyClassify){
          const r = await runDailyClassify()
          if(!cancelled && r.processed) setIntelNote(formatClassifyResult(r))
        }
        if(intelCfg.autoOrderScan && !cancelled){
          const r = await runOrderScan()
          if(r.ordersAdded || r.customersTagged){
            setIntelNote(prev=> (prev? prev+' · ':'')+`订单扫描+${r.ordersAdded}`)
          }
        }
        if(intelCfg.syncTierToFollowUps && !cancelled) await syncTiersFromRules()
        if(!cancelled) await load()
      }catch{}
    })()
    return ()=>{ cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ====== 一键排重：同邮箱多条 → 保留批量导入的，合并后删除其余 ======
  const [deduping, setDeduping] = useState(false)
  const handleDedupe = useCallback(async (silent = false) => {
    setDeduping(true)
    try{
      const all = await db.customers.toArray() as Customer[]
      const groups = new Map<string, Customer[]>()
      for(const c of all){
        const mails = new Set<string>()
        if(c.email) mails.add(c.email.toLowerCase())
        for(const e of (c.extraEmails || [])) mails.add(String(e).toLowerCase())
        for(const m of mails){
          if(!groups.has(m)) groups.set(m, [])
          if(!groups.get(m)!.some(x=> x.id === c.id)) groups.get(m)!.push(c)
        }
      }
      const LEVEL_ORDER = ['D','C','B','A','A+']
      let merged = 0, removed = 0
      const gone = new Set<string>()
      for(const [, arr] of groups){
        const alive = arr.filter(c=> !gone.has(c.id))
        if(alive.length < 2) continue
        // 保留优先级：有“批量导入”标签 > 最近更新
        alive.sort((a, b)=>{
          const ai = (a.tags||[]).includes('批量导入') ? 0 : 1
          const bi = (b.tags||[]).includes('批量导入') ? 0 : 1
          if(ai !== bi) return ai - bi
          return String(b.updatedAt||'') < String(a.updatedAt||'') ? -1 : 1
        })
        const keeper = alive[0]
        const patch: any = {
          extraEmails: [...new Set([...(keeper.extraEmails||[]), ...alive.slice(1).flatMap(c=> [c.email, ...(c.extraEmails||[])].filter(Boolean).map((e:string)=> e.toLowerCase())).filter(e=> e !== (keeper.email||'').toLowerCase())])],
          tags: [...new Set([...(keeper.tags||[]), ...alive.slice(1).flatMap(c=> c.tags||[])])],
          updatedAt: new Date().toISOString(),
        }
        for(const d of alive.slice(1)){
          if(LEVEL_ORDER.indexOf(d.level || 'C') > LEVEL_ORDER.indexOf(keeper.level || 'C')) patch.level = d.level
          if(d.isKey) patch.isKey = true
          if(d.stage === 'won') patch.stage = 'won'
          if((d.repurchaseCount || 0) > (keeper.repurchaseCount || 0)) patch.repurchaseCount = d.repurchaseCount
          if((d.value || 0) > (keeper.value || 0)){ patch.value = d.value; patch.currency = (d as any).currency || 'USD' }
          const dp = [...(keeper.portrait?.products || []), ...((d.portrait as any)?.products || [])]
          if(dp.length) patch.portrait = { ...(keeper.portrait || {}), products: [...new Set(dp)] }
          if(d.notes) patch.notes = [patch.notes || keeper.notes, d.notes].filter(Boolean).join(' | ').slice(0, 500)
          if(!keeper.company && d.company) patch.company = d.company
          if(!keeper.phone && (d as any).phone) patch.phone = (d as any).phone
        }
        await db.customers.update(keeper.id, patch)
        for(const d of alive.slice(1)){
          // 跟进记录转给保留者
          await db.followUps.where('customerId').equals(d.id).modify({ customerId: keeper.id } as any).catch(()=>{})
          await db.customers.delete(d.id)
          gone.add(d.id)
          removed++
        }
        merged++
      }
      await load()
      window.dispatchEvent(new CustomEvent('evan-customers-updated'))
      if(!silent) alert(`排重完成：合并 ${merged} 组，删除重复 ${removed} 条（已保留批量导入的，跟进已转移）`)
      return { merged, removed }
    }finally{ setDeduping(false) }
  }, [load])

  // 点击客户 → 优先服务端线程接口（预聚合，秒开），回退本地库匹配
  const handleCustomerClick = useCallback(async(c: Customer)=>{
    setSelectedCustomer(c)
    setFullContent({})
    setLoadingContent({})
    setContentError({})
    setThreadMode('')
    const addr = (c.email||'').toLowerCase()
    let serverHit = false
    let serverMapped: EmailMessage[] = []
    // 1. 先试服务端线程
    try{
      const accs = await listAccounts()
      if(accs.length && addr){
        const res = await fetchCustomerThreads(accs[0].id, addr, 0)
        if(res && res.threads.length){
          for(const th of res.threads){
            for(const m of th.mails){
              serverMapped.push({
                id: `${accs[0].id}-${m.uid}`, accountId: accs[0].id,
                folder: String(m.folder||'').includes('sent') ? 'sent' : 'inbox',
                from: m.from_name ? `${m.from_name} <${m.from_addr}>` : (m.from_addr||''),
                to: m.to_addr||'', subject: m.subject||'(无主题)',
                text: m.snippet||'', html: '',
                date: m.msg_date ? new Date(m.msg_date).toISOString() : new Date().toISOString(),
                isRead: !!m.is_read, hasAttachment: !!m.has_attachment,
                intent: '其他' as any, priority: '中' as any, status: m.is_read?'已处理':'待处理',
              } as EmailMessage)
            }
          }
          serverMapped.sort((a,b)=> new Date(b.date).getTime() - new Date(a.date).getTime())
          setCustomerEmails(serverMapped)
          setThreadMode('server')
          serverHit = true
        }
      }
    }catch{}
    // 2. 服务端无命中则回退本地库匹配（含多邮箱）
    let current: EmailMessage[] = serverMapped
    if(!serverHit){
      const allEmails = await db.emails.toArray() as EmailMessage[]
      const addrs = new Set([addr, ...((c.extraEmails || []).map((e:string)=> e.toLowerCase()))])
      current = allEmails.filter(e=>{
        const from = (e.from.match(/<(.+?)>/)?.[1]||e.from).trim().toLowerCase()
        const to = (e.to||'').toLowerCase()
        return addrs.has(from) || [...addrs].some(a=> to.includes(a))
      }).sort((a,b)=> new Date(b.date).getTime() - new Date(a.date).getTime())
      setCustomerEmails(current)
      setThreadMode('local')
    }

    // 批量加载所有 text/html 为空的邮件
    const missing = current.filter(e => !e.text && !e.html)
    if(missing.length === 0) return
    // 按 accountId 分组
    const byAccount = new Map<string, {email: EmailMessage; uid: string}[]>()
    for(const e of missing){
      const parts = e.id.split('-')
      const uid = parts[parts.length-1]
      const accountId = e.accountId || parts[0]
      if(!byAccount.has(accountId)) byAccount.set(accountId, [])
      byAccount.get(accountId)!.push({email:e, uid})
    }
    setLoadingContent(prev => {
      const next = {...prev}
      for(const e of missing) next[e.id] = true
      return next
    })
    // 并行请求所有账号（先走 IMAP 实时，失败的再走服务端邮件库，最后仍失败则标错可重试）
    const promises = [...byAccount.entries()].map(async([accId, items])=>{
      const uids = items.map(i => i.uid)
      let results: Record<string,{text:string;html:string}> = {}
      try{ results = await fetchFullEmailBatch(accId, uids) }catch{}
      for(const {email: e, uid} of items){
        const full = results[uid]
        if(full && (full.text || full.html)){
          setFullContent(prev=>({...prev,[e.id]:{text:full.text||'',html:full.html||''}}))
          await db.emails.update(e.id,{ text:full.text||e.text, html:full.html||e.html } as any)
          setLoadingContent(prev=>({...prev,[e.id]:false}))
          continue
        }
        // 回退：服务端邮件库（D盘MySQL，不碰IMAP）
        try{
          const dbm = await fetchDbMail(accId, uid)
          if(dbm && (dbm.text || dbm.html)){
            setFullContent(prev=>({...prev,[e.id]:{text:dbm.text||'',html:dbm.html||''}}))
            await db.emails.update(e.id,{ text:dbm.text||e.text, html:dbm.html||e.html } as any)
            setLoadingContent(prev=>({...prev,[e.id]:false}))
            continue
          }
        }catch{}
        setLoadingContent(prev=>({...prev,[e.id]:false}))
        setContentError(prev=>({...prev,[e.id]:true}))
      }
    })
    await Promise.allSettled(promises)
  },[])

  // 单封重试：库 → IMAP
  const retryMailContent = useCallback(async(e: EmailMessage)=>{
    setContentError(prev=>({...prev,[e.id]:false}))
    setLoadingContent(prev=>({...prev,[e.id]:true}))
    const parts = e.id.split('-')
    const uid = parts[parts.length-1]
    const accountId = e.accountId || parts[0]
    try{
      const dbm = await fetchDbMail(accountId, uid)
      if(dbm && (dbm.text || dbm.html)){
        setFullContent(prev=>({...prev,[e.id]:{text:dbm.text||'',html:dbm.html||''}}))
        await db.emails.update(e.id,{ text:dbm.text||e.text, html:dbm.html||e.html } as any)
        return
      }
      const results = await fetchFullEmailBatch(accountId, [uid]).catch(()=> ({} as Record<string,{text:string;html:string}>))
      const full = (results as any)[uid]
      if(full && (full.text || full.html)){
        setFullContent(prev=>({...prev,[e.id]:{text:full.text||'',html:full.html||''}}))
        await db.emails.update(e.id,{ text:full.text||e.text, html:full.html||e.html } as any)
        return
      }
    }catch{}
    finally{ setLoadingContent(prev=>({...prev,[e.id]:false})) }
    setContentError(prev=>({...prev,[e.id]:true}))
  },[])

  const filtered = list.filter(c=>{
    // 默认藏起已标噪声的客户（可用搜索仍命中）
    if(!q && (c.tags||[]).map(String).includes('噪声') && filter==='all' && tagFilter==='all') return false
    // 「已下单」标签筛选同时认 stage=won，避免只扫标签时漏人
    if(tagFilter === '已下单'){
      const tags = (c.tags||[]).map(String)
      const stage = String((c as any).salesStage||'')
      if(!tags.includes('已下单') && !tags.includes('订单') && c.stage !== 'won' && stage !== 'ordered') return false
    } else if(tagFilter === '取消'){
      const tags = (c.tags||[]).map(String)
      const stage = String((c as any).salesStage||'')
      if(!tags.includes('取消') && stage !== 'cancelled' && c.stage !== 'lost') return false
    } else if(tagFilter !== 'all' && !(c.tags || []).includes(tagFilter)) return false
    if(filter==='key' && !c.isKey) return false
    if(comboLevels.length > 0){
      if(!comboLevels.includes(c.level || 'C')) return false
    } else if(['A+','A','B','C','D'].includes(filter) && c.level!==filter) return false
    if(filter==='gov'||filter==='edu'||filter==='org'||filter==='mil'){
      const emailType = classifyEmailType(c.email)
      const filterMap: Record<string,string> = { gov:'政府', edu:'教育', org:'非盈利', mil:'军队' }
      if(emailType.label !== filterMap[filter]) return false
    }
    if(filter==='personal'){
      const emailType = classifyEmailType(c.email)
      if(emailType.label !== '个人') return false
    }
    if(filter==='enterprise'){
      const emailType = classifyEmailType(c.email)
      if(emailType.label !== '企业') return false
    }
    if(q && !`${c.title} ${c.company} ${c.email}`.toLowerCase().includes(q.toLowerCase())) return false
    // 未跟进天数筛选（sentDates：我方最近发送距今天数；从未发送=9999）
    if(minSilentDays > 0 || maxSilentDays > 0){
      const sd = sentDatesOf(c)
      const never = sd.daysSinceSent == null
      if(never && !includeNeverSent) return false
      const days = never ? 9999 : Number(sd.daysSinceSent)
      if(minSilentDays > 0 && days < minSilentDays) return false
      if(maxSilentDays > 0 && !never && days > maxSilentDays) return false
    }
    if(hideOrdered){
      const tags = (c.tags||[]).map(String)
      if(tags.includes('已下单') || c.stage === 'won' || (c.repurchaseCount||0) >= 1) return false
    }
    return true
  })
  // 筛选变化时回到第 1 页；页码越界自动夹紧
  useEffect(()=>{ setPage(1) }, [filter, tagFilter, q, perPage, list.length, minSilentDays, maxSilentDays, includeNeverSent, hideOrdered, comboLevels])
  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage))
  const safePage = Math.min(page, totalPages)
  const pageData = filtered.slice((safePage - 1) * perPage, safePage * perPage)

  const emailTypeCounts = list.reduce((acc, c)=>{
    const t = classifyEmailType(c.email).label
    acc[t] = (acc[t]||0) + 1
    return acc
  }, {} as Record<string, number>)

  /** 批量 AI 七维画像：优先选中，否则当前筛选；每次人数可配，必须走大模型 */
  const handleBatchPortrait = useCallback(async (opts?: { force?: boolean })=>{
    const { getAiSettings } = await import('../config/aiProviders')
    const ai = getAiSettings()
    const aiReady = !!(ai.apiKey || ai.proxyUrl)
    const ids = checked.size > 0 ? [...checked] : filtered.map(c=> c.id)
    if(!ids.length) return alert('请先筛选或勾选客户')
    const batchSize = Math.max(1, Math.min(500, intelCfg.aiInsightBatchMax || 10))
    const batchIds = ids.slice(0, batchSize)
    const delayMs = 1000
    if(!aiReady && !confirm('未检测到 AI Key/代理，继续可能失败。仍要尝试？')) return
    setIntelBusy('portrait')
    setIntelNote(`批量 AI 画像：目标 ${batchIds.length} 人（上限 ${batchSize}）· 每人间隔约 ${delayMs}ms · ${aiReady?'调用大模型七维模板':'未配置 Key'}…`)
    try{
      const r = await runAiInsight({
        limit: batchIds.length,
        onlyCustomerIds: batchIds,
        force: opts?.force !== false,
        delayMs,
        onProgress: (done, total, name)=>{
          setIntelNote(`批量 AI 画像 ${done}/${total} · ${name} …（七维模板，每人间隔约 1s）`)
        },
      })
      let note = r.note || `AI画像 成功${r.ok} 失败${r.fail}`
      if(r.fail>0 && r.ok===0) note += '｜请检查 AI 设置里的 API Key/代理'
      if(ids.length > batchIds.length) note += `｜还有 ${ids.length-batchIds.length} 人未处理，可提高「每次画像客户数」后再跑`
      setIntelNote(note)
      await load()
    }catch(e:any){ setIntelNote('批量AI画像失败：'+String(e.message||e).slice(0,120)) }
    finally{ setIntelBusy('') }
  },[checked, filtered, intelCfg, load])

  return (
    <div className="p-4 max-w-6xl mx-auto space-y-3">
      <div className="flex items-center gap-2">
        <h1 className="text-xl font-bold">👥 客户</h1>
        <span className="text-xs text-gray-400">{filtered.length} / {list.length}</span>
        <button onClick={()=> { setImportText(IMPORT_TEMPLATE); setShowImport(true) }} className="px-3 py-1 rounded-full text-xs bg-green-600 text-white hover:bg-green-700" title="批量导入：等级/重点/阶段/多品类/复购/类型/多邮箱">📥 批量导入</button>
        <button onClick={()=> void handleDedupe(false)} disabled={deduping} className="px-3 py-1 rounded-full text-xs bg-white border hover:border-orange-300 hover:text-orange-600 disabled:opacity-50" title="同邮箱多条合并，保留批量导入的">🧹 {deduping ? '排重中…' : '一键排重'}</button>
        <button
          onClick={async()=>{
            if(!confirm('将 noreply/系统退信/订阅源等噪声客户标记为「噪声」并移出跟进？不会物理删除。')) return
            const { isNoiseEmailAddress } = await import('../utils/emailHelpers')
            const ts = new Date().toISOString()
            let n = 0
            for(const c of list){
              if(!isNoiseEmailAddress(c.email)) continue
              const tags = [...new Set([...(c.tags||[]).map(String), '噪声'])]
              if((c.tags||[]).includes('噪声')) continue
              await db.customers.update(c.id, { tags, stage: 'lost', updatedAt: ts } as any)
              n++
            }
            setIntelNote(`已标记噪声客户 ${n} 个（标签「噪声」+阶段流失，不再新建同类）`)
            await load()
          }}
          className="px-2 py-1 rounded-full text-xs border bg-white hover:border-rose-300 hover:text-rose-600"
          title="过滤 noreply/系统邮件/订阅源，避免污染跟进雷达"
        >🚫 标噪声</button>
        <button onClick={()=> { setSelectMode(v=>!v); setChecked(new Set()) }} className={`px-3 py-1 rounded-full text-xs border ${selectMode?'bg-gray-800 text-white':'bg-white'}`}>{selectMode?'退出多选':'☑️ 多选'}</button>
        <button onClick={()=> void handleDailyClassify()} disabled={!!intelBusy} className="px-3 py-1 rounded-full text-xs bg-blue-600 text-white disabled:opacity-50" title="分级/重点 + 近N天订单扫描 + 跟进桶同步">🏷️ 自动分类</button>
        <button
          onClick={async()=>{
            if(!confirm('全量扫描订单邮件，为已成交客户补「已下单」标签，并关闭其逾期跟进？')) return
            setIntelBusy('order-align'); setIntelNote('订单对齐中…')
            try{
              const { syncOrderedCustomersFollowUps, runOrderScan } = await import('../services/orderScan')
              const os = await runOrderScan({ rescanAll: true })
              const r = await syncOrderedCustomersFollowUps({ purge: true })
              setIntelNote(`订单对齐：清除误标 ${r.purged} · 扫描+${os.ordersAdded} · 真实已下单 ${r.ordered} · 新打标 ${r.newlyTagged} · 关跟进 ${r.followUpsClosed}`)
              await load()
            }catch(e:any){ setIntelNote('订单对齐失败：'+String(e.message||e).slice(0,120)) }
            finally{ setIntelBusy('') }
          }}
          disabled={!!intelBusy}
          className="px-2 py-1 rounded-full text-xs border bg-white hover:border-orange-400 hover:text-orange-600 disabled:opacity-50"
          title="修复：已下单却在逾期跟进、客户页搜不到已下单标签"
        >🧾 订单对齐</button>
        <button onClick={()=> void handleAiInsight()} disabled={!!intelBusy} className="px-3 py-1 rounded-full text-xs bg-purple-600 text-white disabled:opacity-50" title="AI 读往来：背景/高意向/跟进/机会，同步跟进桶">🔍 AI洞察</button>
        <button
          onClick={()=> void handleBatchPortrait({ force: true })}
          disabled={!!intelBusy}
          className="px-3 py-1 rounded-full text-xs bg-fuchsia-600 text-white disabled:opacity-50"
          title={`批量 AI 十一维画像 v2：优先选中客户，否则当前筛选；每次最多 ${intelCfg.aiInsightBatchMax} 人，每人间隔约 1 秒，必须走大模型；旧七维请强制重跑`}
        >🤖 批量AI画像{checked.size>0 ? `（选中${checked.size}）` : `（筛选${filtered.length}）`}</button>
        <button
          onClick={()=> void handlePurchaseLoop()}
          disabled={!!intelBusy}
          className="px-3 py-1 rounded-full text-xs bg-orange-600 text-white disabled:opacity-50"
          title="复购开发：对「已下单」客户估算采购周期、复购/交叉销售机会与下一步动作（NBA）；写入客户字段，跟进雷达可筛「潜在复购」。单次最多约 20 人，每人约 1 次 AI，速度偏慢属正常"
        >🔁 复购开发</button>
        <button onClick={async()=>{
          setIntelBusy('sent'); setIntelNote('正在从邮件库刷新客户发送时间…')
          try{
            const r = await refreshSentDatesFromLocal()
            setIntelNote(`跟进时间已刷新：更新 ${r.updated} 人 · 有发送记录 ${r.customersWithSent}`)
            await load()
          }catch(e:any){ setIntelNote('刷新失败：'+String(e.message||e).slice(0,80)) }
          finally{ setIntelBusy('') }
        }} disabled={!!intelBusy} className="px-2 py-1 rounded-full text-xs border bg-white disabled:opacity-50">⟳ 刷新跟进时间</button>
        <button onClick={()=> setShowCsvOrder(true)} className="px-2 py-1 rounded-full text-xs border bg-white" title="CSV：订单号,邮箱,日期,产品,数量,金额">📥 订单CSV</button>
        <button onClick={()=> setShowIntel(v=>!v)} className="px-2 py-1 rounded-full text-xs border bg-white">⚙️ 智能设置</button>
        <button onClick={()=> setFilter('key' as any)} className={`ml-auto px-3 py-1 rounded-full text-xs ${filter==='key'?'bg-yellow-500 text-white':'bg-white border'}`}>⭐ 重点 {levelCounts.key||0}</button>
      </div>
      {selectMode && checked.size>0 && (
        <div className="flex items-center gap-2 flex-wrap bg-indigo-600 text-white rounded-2xl px-3 py-2 text-xs">
          <span>已选 {checked.size}</span>
          <button onClick={()=> void handleBatchPortrait({ force: true })} disabled={!!intelBusy}
            className="px-2 py-1 bg-fuchsia-500 hover:bg-fuchsia-400 rounded-lg disabled:opacity-50"
            title="对选中客户批量调用 AI 生成十一维画像"
          >🤖批量AI画像</button>
          <label className="flex items-center gap-1 opacity-90 cursor-pointer" title="替换=只保留本次点的板块；叠加=在原有手动板块上追加">
            <input type="checkbox" checked={bucketAddMode==='add'} onChange={e=> setBucketAddMode(e.target.checked?'add':'replace')}/>
            叠加
          </label>
          <span className="opacity-80">板块（{bucketAddMode==='add'?'叠加':'替换'}）</span>
          {MANUAL_BUCKETS.map(b=>(
            <button key={'p-in-'+b.key}
              onClick={async()=>{
                if(!checked.size) return alert('请先勾选客户')
                await addManualBuckets([...checked], [b.key], undefined, bucketAddMode)
                setIntelNote(bucketAddMode==='add'
                  ? `已叠加「${b.label}」到 ${checked.size} 人`
                  : `已将 ${checked.size} 人板块设为「${b.label}」（替换，其它手动板块已清）`)
                await load()
              }}
              className="px-2 py-1 bg-white/15 hover:bg-white/25 rounded-lg border border-white/20"
            >{b.label}</button>
          ))}
          {MANUAL_BUCKETS.map(b=>(
            <button key={'p-out-'+b.key}
              onClick={async()=>{
                const n = removeManualBuckets([...checked], [b.key])
                setIntelNote(`已从「${b.label}」批量移出 ${n} 人`)
                await load()
              }}
              className="px-2 py-1 bg-rose-500/50 hover:bg-rose-500/70 rounded-lg border border-white/20"
            >×{b.label}</button>
          ))}
          <button
            onClick={async()=>{
              if(!confirm(`清空 ${checked.size} 人的全部手动板块？`)) return
              const n = removeManualBuckets([...checked], [])
              setIntelNote(`已清空 ${n} 人手动板块`)
              await load()
            }}
            className="px-2 py-1 bg-white/10 hover:bg-white/20 rounded-lg border border-white/20"
          >清空板块</button>
        </div>
      )}
      {(intelNote || intelBusy) && (
        <div className="text-[11px] px-3 py-2 bg-purple-50 text-purple-800 border border-purple-100 rounded-xl flex items-center gap-2">
          <span className="flex-1">
            {intelBusy ? (intelNote || `处理中（${intelBusy}）…`) : intelNote}
          </span>
          {!intelBusy && <button onClick={()=> setIntelNote('')} className="text-purple-400">✕</button>}
        </div>
      )}
      {showIntel && (
        <div className="bg-white rounded-2xl border p-3 text-xs space-y-2">
          <div className="font-semibold text-sm">⚙️ 智能设置</div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            <label className="flex items-center gap-1"><input type="checkbox" checked={intelCfg.autoDailyClassify} onChange={e=> patchIntelCfg({ autoDailyClassify: e.target.checked })}/> 每日自动分类</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={intelCfg.autoOrderScan} onChange={e=> patchIntelCfg({ autoOrderScan: e.target.checked })}/> 自动订单扫描</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={intelCfg.syncTierToFollowUps} onChange={e=> patchIntelCfg({ syncTierToFollowUps: e.target.checked })}/> 跟进桶同步（默认开）</label>
            <label className="flex items-center gap-1">订单窗口
              <select value={intelCfg.orderScanDays} onChange={e=> patchIntelCfg({ orderScanDays: Number(e.target.value)||5 })} className="border rounded px-1 py-0.5">
                {[3,5,7,14].map(d=> <option key={d} value={d}>{d}天</option>)}
              </select>
            </label>
            <label className="flex items-center gap-1">每次画像客户数（批量AI画像上限）
              <input type="number" min={1} max={500} value={intelCfg.aiInsightBatchMax} onChange={e=> patchIntelCfg({ aiInsightBatchMax: Number(e.target.value)||20 })} className="w-14 border rounded px-1"/>
              <span className="text-[10px] text-gray-400">人/次</span>
            </label>
            <label className="flex items-center gap-1">AI洞察冷却(天)
              <input type="number" min={0} max={30} value={intelCfg.aiInsightCooldownDays} onChange={e=> patchIntelCfg({ aiInsightCooldownDays: Number(e.target.value)||7 })} className="w-14 border rounded px-1"/>
            </label>
            <label className="flex items-center gap-1">复购开发每次人数
              <input type="number" min={1} max={500} value={intelCfg.purchaseLoopBatchMax || 20} onChange={e=> patchIntelCfg({ purchaseLoopBatchMax: Number(e.target.value)||20 })} className="w-14 border rounded px-1"/>
              <span className="text-[10px] text-gray-400">人/次</span>
            </label>
            <label className="flex items-center gap-1">复购冷却(天)
              <input type="number" min={0} max={90} value={intelCfg.purchaseLoopCooldownDays} onChange={e=> patchIntelCfg({ purchaseLoopCooldownDays: Number(e.target.value)||14 })} className="w-14 border rounded px-1"/>
            </label>
          </div>
          <div className="space-y-1">
            <div className="text-[11px] text-gray-500">成交/下单关键词（逗号分隔；<b>订单扫描 · 已下单标签 · 自动分类金额</b>都按这里判断，可随时改，改完点「订单对齐」重算）</div>
            <textarea
              className="w-full border rounded-lg p-2 text-[11px] font-mono"
              rows={2}
              defaultValue={(intelCfg.dealKeywords||[]).join(', ')}
              onBlur={e=>{
                const list = e.target.value.split(/[,，\n]/).map(x=>x.trim()).filter(Boolean)
                if(list.length) patchIntelCfg({ dealKeywords: list })
              }}
            />
            <div className="text-[11px] text-gray-500">排除词（命中则不当作成交；与关键词同样作用于订单扫描）</div>
            <input className="w-full border rounded-lg p-2 text-[11px]"
              defaultValue={(intelCfg.dealExcludeWords||[]).join(', ')}
              onBlur={e=>{
                const list = e.target.value.split(/[,，\n]/).map(x=>x.trim()).filter(Boolean)
                patchIntelCfg({ dealExcludeWords: list })
              }}
            />
          </div>
          <div className="text-[10px] text-gray-400">等级阈值：金额 &gt;1500=A+ · &gt;1000=A · &gt;500=B（只升不降）· 金额取该客户邮件上下文（成交词优先）</div>
        </div>
      )}
      {showCsvOrder && (
        <div className="bg-white rounded-2xl border p-3 text-xs space-y-2">
          <div className="font-semibold">📥 CSV 订单导入</div>
          <div className="text-[10px] text-gray-400">每行：订单号,客户邮箱,日期(YYYY-MM-DD),产品(可/分隔),数量,金额；首行可为表头</div>
          <textarea value={csvOrderText} onChange={e=> setCsvOrderText(e.target.value)} rows={4} className="w-full border rounded-lg p-2 font-mono" placeholder={'INQC001,customer@gmail.com,2026-09-10,Medal,150,650'}/>
          <div className="flex gap-2">
            <button onClick={async()=>{
              try{
                const r = await importOrdersCsv(csvOrderText)
                setIntelNote(`订单CSV：新增 ${r.added} · 跳过重复 ${r.skipped} · 错误 ${r.errors}`)
                setShowCsvOrder(false); setCsvOrderText(''); await load()
              }catch(e:any){ alert(String(e.message||e).slice(0,120)) }
            }} className="px-3 py-1 bg-green-600 text-white rounded-lg">导入</button>
            <button onClick={()=> setShowCsvOrder(false)} className="px-3 py-1 border rounded-lg">取消</button>
          </div>
        </div>
      )}
      {/* 批量操作条 */}
      {selectMode && (
        <div className="flex items-center gap-2 flex-wrap bg-gray-900 text-white rounded-2xl px-3 py-2 text-xs sticky top-0 z-10">
          <span>已选 {checked.size} / 筛选 {filtered.length}</span>
          <button
            onClick={()=> setChecked(new Set(filtered.map(c=> c.id)))}
            className="px-2 py-1 bg-white/10 rounded border border-white/20"
          >全选筛选</button>
          <select value={bulkLevel} onChange={e=> setBulkLevel(e.target.value)} className="px-2 py-1 rounded text-xs text-gray-800">
            <option value="">改等级…</option><option value="A+">A+</option><option value="A">A</option><option value="B">B</option><option value="C">C</option><option value="D">D</option>
          </select>
          <button onClick={()=> void bulkApply('level')} className="px-2 py-1 bg-blue-600 rounded text-[11px]">应用等级</button>
          <input value={bulkTag} onChange={e=> setBulkTag(e.target.value)} placeholder="加标签…" className="w-24 px-2 py-1 rounded text-xs text-gray-800" />
          <button onClick={()=> void bulkApply('tag')} className="px-2 py-1 bg-teal-600 rounded text-[11px]">打标签</button>
          <button
            onClick={()=> void handleBatchPortrait({ force: true })}
            disabled={!!intelBusy}
            className="px-2 py-1 bg-fuchsia-600 rounded text-[11px] disabled:opacity-50"
            title="对已选客户批量调用 AI 生成七维画像；每次人数见智能设置"
          >🤖批量AI画像</button>
          <span className="text-gray-400">移入</span>
          <label className="flex items-center gap-0.5 text-gray-300 cursor-pointer" title="默认替换；勾选后叠加">
            <input type="checkbox" checked={bucketAddMode==='add'} onChange={e=> setBucketAddMode(e.target.checked?'add':'replace')} className="accent-indigo-400"/>
            叠加
          </label>
          {MANUAL_BUCKETS.map(b=>(
            <button key={'in-'+b.key}
              onClick={async()=>{
                if(!checked.size) return alert('请先勾选客户')
                await addManualBuckets([...checked], [b.key], undefined, bucketAddMode)
                setIntelNote(bucketAddMode==='add'
                  ? `已叠加「${b.label}」到 ${checked.size} 人`
                  : `已将 ${checked.size} 人板块设为「${b.label}」（替换）`)
                window.dispatchEvent(new CustomEvent('evan-customers-updated'))
                await load()
              }}
              className="px-2 py-1 bg-indigo-500/80 hover:bg-indigo-400 rounded text-[11px]"
            >{b.label}</button>
          ))}
          <span className="text-gray-400">移出</span>
          {MANUAL_BUCKETS.map(b=>(
            <button key={'out-'+b.key}
              onClick={async()=>{
                if(!checked.size) return alert('请先勾选客户')
                const n = removeManualBuckets([...checked], [b.key])
                setIntelNote(`已从「${b.label}」移出 ${n} 人的手动板块标记`)
                window.dispatchEvent(new CustomEvent('evan-customers-updated'))
                await load()
              }}
              className="px-2 py-1 bg-rose-500/70 hover:bg-rose-400 rounded text-[11px]"
              title={`从「手动·${b.label}」批量移除`}
            >×{b.label}</button>
          ))}
          <button
            onClick={async()=>{
              if(!checked.size) return alert('请先勾选客户')
              if(!confirm(`清空 ${checked.size} 人的全部手动跟进板块标记？`)) return
              const n = removeManualBuckets([...checked], [])
              setIntelNote(`已清空 ${n} 人的全部手动板块`)
              window.dispatchEvent(new CustomEvent('evan-customers-updated'))
              await load()
            }}
            className="px-2 py-1 bg-gray-600 hover:bg-gray-500 rounded text-[11px] border border-white/20"
          >清空手动板块</button>
          <select value={bulkStage} onChange={e=> setBulkStage(e.target.value)} className="px-2 py-1 rounded text-xs text-gray-800">
            <option value="">改阶段…</option><option value="lead">新线索</option><option value="contacted">已联系</option><option value="qualified">已确认</option><option value="proposal">报价中</option><option value="negotiation">谈判中</option><option value="won">已下单</option><option value="lost">流失</option>
          </select>
          <button onClick={()=> void bulkApply('stage')} className="px-2 py-1 bg-blue-600 rounded text-[11px]">应用阶段</button>
          <button onClick={()=> void bulkApply('delete')} className="ml-auto px-2 py-1 bg-red-600 rounded text-[11px]">删除</button>
          <button onClick={clearCheck} className="px-2 py-1 text-gray-300">取消</button>
        </div>
      )}
      <div className="flex gap-1 flex-wrap items-center">
        <button onClick={()=> setFilter('all' as any)} className={`px-3 py-1 rounded-full text-xs border ${filter==='all'?'bg-blue-600 text-white':'bg-white'}`}>全部 {levelCounts.all||0}</button>
        {(['A+','A','B','C','D'] as const).map(l=> (
          <button key={l} onClick={()=> setFilter(l as any)} className={`px-3 py-1 rounded-full text-xs border ${filter===l?'bg-blue-600 text-white':'bg-white'}`}>{l}</button>
        ))}
        <span className="text-gray-300 self-center">|</span>
        {([
          {k:'gov',l:'🏛 政府',c:'bg-red-50 text-red-600', label:'政府'},
          {k:'edu',l:'🎓 教育',c:'bg-blue-50 text-blue-600', label:'教育'},
          {k:'org',l:'🤝 非盈利',c:'bg-purple-50 text-purple-600', label:'非盈利'},
          {k:'mil',l:'🎖 军队',c:'bg-orange-50 text-orange-600', label:'军队'},
          {k:'personal',l:'👤 个人',c:'bg-green-50 text-green-600', label:'个人'},
          {k:'enterprise',l:'🏢 企业',c:'bg-indigo-50 text-indigo-600', label:'企业'},
        ] as const).map(({k,l,c,label})=> (
          <button key={k} onClick={()=> setFilter(filter===k?'all':k as any)} className={`px-2 py-1 rounded-full text-[10px] border ${filter===k?c+' ring-1 ring-current':'bg-white text-gray-500'}`}>{l} {emailTypeCounts[label]||0}</button>
        ))}
        <div className="ml-auto relative flex items-center gap-1">
          <button
            onClick={()=> setShowFilters(v=>!v)}
            className={`px-2 py-1 rounded-full text-xs border ${showFilters || minSilentDays>0 || maxSilentDays>0 || hideOrdered ? 'bg-blue-600 text-white border-blue-600' : 'bg-white'}`}
            title="按未跟进天数等条件筛选"
          >⚗️ 筛选{(minSilentDays>0||maxSilentDays>0||hideOrdered) ? ` · ${filtered.length}` : ''}</button>
          <Search size={12} className="absolute left-[68px] top-2 text-gray-300 pointer-events-none"/>
          <input value={q} onChange={e=>setQ(e.target.value)} placeholder="搜公司/邮箱" className="pl-6 pr-2 py-1 border rounded-lg text-xs w-40"/>
        </div>
      </div>
      {showFilters && (
        <div className="bg-white border rounded-2xl p-3 text-xs space-y-2">
          <div className="font-semibold text-sm flex items-center gap-2">
            ⚗️ 筛选条件
            <span className="text-[11px] font-normal text-gray-400">当前命中 {filtered.length} / {list.length}</span>
            <button
              onClick={()=>{ setMinSilentDays(0); setMaxSilentDays(0); setHideOrdered(false); setIncludeNeverSent(true); setComboLevels([]); setTagFilter('all'); setFilter('all' as any); setQ('') }}
              className="ml-auto px-2 py-0.5 border rounded text-[11px] text-gray-500 hover:bg-gray-50"
            >清空筛选</button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-gray-500 font-medium">组合预设</span>
            {([
              { label: 'A级且未跟进≥14天', levels: ['A','A+'], days: 14 },
              { label: 'A/B且≥30天', levels: ['A','A+','B'], days: 30 },
              { label: 'C/D且≥60天', levels: ['C','D'], days: 60 },
              { label: '全部≥90天', levels: [], days: 90 },
            ] as const).map(p=>(
              <button key={p.label}
                onClick={()=>{ setComboLevels([...p.levels]); setMinSilentDays(p.days); setFilter('all' as any); setHideOrdered(true); setIncludeNeverSent(true) }}
                className="px-2 py-0.5 border rounded-full bg-indigo-50 text-indigo-700 hover:bg-indigo-100"
              >{p.label}</button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-gray-500">等级</span>
            {(['A+','A','B','C','D'] as const).map(l=>(
              <button key={l}
                onClick={()=> setComboLevels(prev=> prev.includes(l) ? prev.filter(x=>x!==l) : [...prev, l])}
                className={`px-2 py-0.5 border rounded-full ${comboLevels.includes(l)?'bg-blue-600 text-white border-blue-600':'bg-white text-gray-600'}`}
              >{l}</button>
            ))}
            {comboLevels.length===0 && <span className="text-[10px] text-gray-400">未选则跟随顶部等级按钮</span>}
            {comboLevels.length>0 && <button onClick={()=> setComboLevels([])} className="text-[10px] text-gray-400 underline">不限等级</button>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-gray-500">未跟进天数 ≥</span>
            <input
              type="number" min={0} max={9999} value={minSilentDays || ''}
              onChange={e=> setMinSilentDays(Math.max(0, Number(e.target.value)||0))}
              placeholder="不限" className="w-16 border rounded px-1.5 py-0.5"
            />
            <span className="text-gray-400">天</span>
            <span className="text-gray-300 mx-1">·</span>
            <span className="text-gray-500">且 ≤</span>
            <input
              type="number" min={0} max={9999} value={maxSilentDays || ''}
              onChange={e=> setMaxSilentDays(Math.max(0, Number(e.target.value)||0))}
              placeholder="不限" className="w-16 border rounded px-1.5 py-0.5"
            />
            <span className="text-gray-400">天</span>
            {[7,14,30,60,90,180].map(n=>(
              <button key={n} onClick={()=> setMinSilentDays(n)} className={`px-2 py-0.5 border rounded-full ${minSilentDays===n?'bg-blue-600 text-white border-blue-600':'bg-white text-gray-600'}`}>≥{n}天</button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1 cursor-pointer">
              <input type="checkbox" checked={includeNeverSent} onChange={e=> setIncludeNeverSent(e.target.checked)}/>
              含「从未发送」客户
            </label>
            <label className="flex items-center gap-1 cursor-pointer" title="已下单/won/有复购次数的不显示">
              <input type="checkbox" checked={hideOrdered} onChange={e=> setHideOrdered(e.target.checked)}/>
              排除已下单
            </label>
            <span className="text-[11px] text-gray-400">天数来自「⟳ 刷新跟进时间」</span>
          </div>
          <div className="text-[11px] text-gray-500 bg-gray-50 rounded-lg px-2 py-1">
            当前条件：
            {comboLevels.length ? `等级∈[${comboLevels.join('/')}]` : (['A+','A','B','C','D'].includes(filter)?`等级=${filter}`:'等级不限')}
            {minSilentDays>0 ? ` 且 未跟进≥${minSilentDays}天` : ''}
            {maxSilentDays>0 ? ` 且 未跟进≤${maxSilentDays}天` : ''}
            {hideOrdered ? ' 且 排除已下单' : ''}
            {tagFilter!=='all' ? ` 且 标签=${tagFilter}` : ''}
            {q ? ` 且 搜索「${q}」` : ''}
            {' →命中 '}
            <b>{filtered.length}</b>
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-gray-100">
            <button
              onClick={()=>{
                if(!filtered.length) return
                setSelectMode(true)
                setChecked(new Set(filtered.map(c=> c.id)))
                setIntelNote(`已全选筛选结果 ${filtered.length} 人，可批量打标签 / 改等级 / 移入或移出跟进板块`)
              }}
              className="px-3 py-1 bg-blue-600 text-white rounded-lg"
            >☑️ 全选筛选结果（{filtered.length}）</button>
            <span className="text-[11px] text-gray-400">全选后用多选条：打标签、改等级、移入/移出六板块</span>
          </div>
        </div>
      )}
      {/* 自定义标签筛选 */}
      <div className="flex gap-1 flex-wrap items-center">
        <span className="text-[11px] text-gray-400">🏷️ 标签：</span>
        <button onClick={()=> setTagFilter('all')} className={`px-2 py-1 rounded-full text-[10px] border ${tagFilter==='all'?'bg-teal-600 text-white':'bg-white text-gray-500'}`}>全部</button>
        {allTags.map(([t, n])=>(
          <button key={t} onClick={()=> setTagFilter(tagFilter===t?'all':t)} className={`px-2 py-1 rounded-full text-[10px] border ${tagFilter===t?'bg-teal-600 text-white':'bg-white text-gray-500'}`}>{t} {n}</button>
        ))}
        <div className="relative ml-auto">
          <button onClick={()=> setShowTagMgr(v=>!v)} className="px-2 py-1 rounded-full text-[10px] border bg-white text-gray-500">管理标签</button>
          {showTagMgr && (
            <div className="absolute right-0 top-7 w-56 bg-white border rounded-xl shadow-lg p-2 z-20 max-h-64 overflow-y-auto">
              <div className="text-[11px] text-gray-400 px-1 pb-1">删除标签会从所有客户身上移除</div>
              {allTags.length===0 && <div className="text-[11px] text-gray-300 p-2">暂无标签（导入或编辑客户时添加）</div>}
              {allTags.map(([t, n])=>(
                <div key={t} className="flex items-center gap-1 px-1 py-1 text-xs">
                  <span className="flex-1 truncate">{t} <span className="text-gray-300">×{n}</span></span>
                  <button onClick={()=> void deleteTagGlobal(t)} className="text-red-400 hover:text-red-600 text-[11px]">删除</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 text-[11px] text-gray-400">
        <span>共 {filtered.length} 条 · 第 {safePage}/{totalPages} 页</span>
        <label className="flex items-center gap-1 ml-auto">
          每页
          <select value={perPage} onChange={e=> setPerPagePersist(Number(e.target.value)||30)} className="border rounded px-1 py-0.5 text-[11px] bg-white">
            {[12, 30, 60, 120].map(n=> <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
        {pageData.length===0 && (
          <div className="col-span-full text-center text-sm text-gray-400 py-10">没有匹配的客户</div>
        )}
        {pageData.map(c=>{
          const emailType = classifyEmailType(c.email)
          const EmailIcon = emailType.icon
          const stats = emailStats[(c.email||'').toLowerCase()] || { count:0, totalAmount:0 }
          return(
            <div key={c.id} onClick={()=> selectMode ? toggleCheck(c.id) : handleCustomerClick(c)} className={`relative bg-white rounded-2xl border p-4 cursor-pointer hover:shadow-md transition-shadow ${c.isKey?'border-yellow-200 bg-yellow-50/30':''} ${selectMode && checked.has(c.id)?'ring-2 ring-blue-400':''}`}>
              {selectMode && (
                <input type="checkbox" checked={checked.has(c.id)} onChange={()=> toggleCheck(c.id)} onClick={e=> e.stopPropagation()} className="absolute top-2 right-2 w-4 h-4 accent-blue-600" />
              )}
              <div className="flex items-center gap-2">
                <span className="font-semibold text-sm">{c.contactName||c.title}</span>
                {c.isKey && <Star size={12} className="text-yellow-500 fill-yellow-500"/>}
                <span className="ml-auto text-xs px-1.5 py-0.5 bg-gray-100 rounded">{c.level||'C'}</span>
              </div>
              <div className="text-xs text-gray-500 truncate">{c.email || '无邮箱'}</div>
              {c.company && <div className="text-[11px] text-gray-400 truncate">🏢 {c.company}</div>}
              <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full flex items-center gap-0.5 ${emailType.color}`}><EmailIcon size={9}/>{emailType.label}</span>
                {(c as any).aiTier && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-50 text-purple-700" title={(c as any).aiReason||''}>
                    {{high:'高意向',pending:'待成交',repurchase:'复购',marketing:'营销',follow:'跟进',dormant:'沉寂',active:'活跃'}[(c as any).aiTier as string] || (c as any).aiTier}
                  </span>
                )}
                {getCustomerBuckets(c.id).map(b=>{
                  const label = MANUAL_BUCKETS.find(x=>x.key===b)?.label || b
                  return <span key={b} className="text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700">手动·{label}</span>
                })}
                {(c.tags||[]).filter(t=> !['政府','教育','非盈利','军队','个人','企业','已分类','重点客户','邮件','订单'].includes(String(t))).slice(0,3).map(t=> <span key={t} className="text-[10px] px-1.5 py-0.5 rounded-full bg-teal-50 text-teal-600">{t}</span>)}
                {stats.count>0 && <span className="text-[10px] text-gray-400">📧{stats.count}封</span>}
                {(c.value||0)>0 && <span className="text-[10px] text-green-600">💰${Number(c.value).toLocaleString()}</span>}
                {stats.totalAmount>0 && <span className="text-[10px] text-green-600">${stats.totalAmount.toLocaleString()}</span>}
                {((c as any).aiProfile || (c as any).aiTier || (c as any).nextBestAction) && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-50 text-purple-700" title="已生成 AI 画像（点开客户查看）">🤖 画像</span>
                )}
              </div>
              <div className="text-[10px] text-gray-400 flex items-center gap-1 mt-1.5 flex-wrap">
                <Calendar size={9}/> 下次 {c.followUpAt||'—'}
                <span className="mx-1 text-gray-300">|</span>
                {(()=>{
                  const sd = sentDatesOf(c)
                  const d = sd.daysSinceSent
                  const tone = d==null ? 'text-gray-400' : d<=3 ? 'text-green-600' : d<=7 ? 'text-orange-500' : 'text-rose-600'
                  return (
                    <span className={tone} title={sd.lastSentAt?`最近发送 ${new Date(sd.lastSentAt).toLocaleString()}\n首次发送 ${sd.firstSentAt?new Date(sd.firstSentAt).toLocaleString():'—'}`:'尚未发送过邮件'}>
                      ⏳未跟进 {formatDays(d)}
                    </span>
                  )
                })()}
              </div>
            </div>
          )
        })}
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-1 flex-wrap pt-1 pb-2">
          <button onClick={()=> setPage(1)} disabled={safePage<=1} className="px-2 py-1 text-[11px] border rounded bg-white disabled:opacity-40">«</button>
          <button onClick={()=> setPage(p=> Math.max(1, p-1))} disabled={safePage<=1} className="px-2 py-1 text-[11px] border rounded bg-white disabled:opacity-40">上一页</button>
          {Array.from({ length: Math.min(totalPages, 7) }, (_, i)=>{
            const start = Math.max(1, Math.min(safePage - 3, totalPages - 6))
            return start + i
          }).filter(n=> n>=1 && n<=totalPages).map(n=>(
            <button key={n} onClick={()=> setPage(n)} className={`w-7 h-7 text-[11px] border rounded ${n===safePage?'bg-blue-600 text-white border-blue-600':'bg-white'}`}>{n}</button>
          ))}
          <button onClick={()=> setPage(p=> Math.min(totalPages, p+1))} disabled={safePage>=totalPages} className="px-2 py-1 text-[11px] border rounded bg-white disabled:opacity-40">下一页</button>
          <button onClick={()=> setPage(totalPages)} disabled={safePage>=totalPages} className="px-2 py-1 text-[11px] border rounded bg-white disabled:opacity-40">»</button>
        </div>
      )}

      {/* 批量导入弹窗 */}
      {showImport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={()=> setShowImport(false)}>
          <div className="bg-white rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl" onClick={e=> e.stopPropagation()}>
            <div className="p-4 border-b flex items-center gap-2">
              <div className="font-semibold text-sm">📥 批量导入客户</div>
              <span className="text-[11px] text-gray-400">CSV格式，第一行为表头；写入后客户/跟进/营销/拓扑/全景自动同步</span>
              <button onClick={()=> setShowImport(false)} className="ml-auto p-1.5 hover:bg-gray-100 rounded-lg"><X size={16}/></button>
            </div>
            <div className="p-4 space-y-2 overflow-y-auto">
              <div className="flex items-center gap-2">
                <label className="px-3 py-1.5 bg-blue-50 text-blue-600 border border-blue-200 rounded-lg text-xs cursor-pointer hover:bg-blue-100">
                  📂 选择 Excel / CSV 文件
                  <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={e=>{ const f = e.target.files?.[0]; if(f) void handleImportFile(f); e.target.value = '' }} />
                </label>
                {importFileName && <span className="text-[11px] text-gray-500">已载入：{importFileName}</span>}
                <span className="text-[11px] text-gray-400 ml-auto">或直接粘贴 CSV（第一行为表头）</span>
              </div>
              <textarea value={importText} onChange={e=> { setImportText(e.target.value); setImportFileName('') }} placeholder="粘贴CSV…" className="w-full h-40 px-3 py-2 border rounded-lg text-xs font-mono resize-y" />
              {importText.trim() && (
                <div className="text-xs">
                  <div className="font-semibold text-gray-600 mb-1">预览（{importPreview.length} 行有效）</div>
                  <div className="max-h-48 overflow-auto border rounded-lg">
                    <table className="w-full text-[11px]">
                      <thead className="bg-gray-50 sticky top-0"><tr><th className="p-1 text-left">姓名</th><th className="p-1 text-left">邮箱</th><th className="p-1">等级</th><th className="p-1">重点</th><th className="p-1">阶段</th><th className="p-1 text-left">产品</th><th className="p-1">复购</th><th className="p-1">类型</th><th className="p-1 text-left">分类</th><th className="p-1">金额</th></tr></thead>
                      <tbody>
                        {importPreview.slice(0, 50).map((r, i)=>(
                          <tr key={i} className="border-t">
                            <td className="p-1">{r.name}</td>
                            <td className="p-1 break-all">{r.emails.join('; ')}</td>
                            <td className="p-1 text-center">{r.level}</td>
                            <td className="p-1 text-center">{r.isKey?'⭐':''}</td>
                            <td className="p-1 text-center">{r.stage}</td>
                            <td className="p-1">{r.products.join('/')}</td>
                            <td className="p-1 text-center">{r.repurchaseCount||''}</td>
                            <td className="p-1 text-center">{r.customerType}</td>
                            <td className="p-1">{(r.categories||[]).join('/')}</td>
                            <td className="p-1 text-center">{r.amount||''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {importPreview.length > 50 && <div className="text-center text-gray-400 py-1">仅预览前50行</div>}
                  </div>
                </div>
              )}
            </div>
            <div className="p-4 border-t flex items-center gap-2">
              <button onClick={()=> setShowImport(false)} className="px-4 py-2 text-xs text-gray-500 hover:bg-gray-100 rounded-lg">取消</button>
              <div className="flex-1" />
              <button onClick={handleImportConfirm} disabled={importing || !importPreview.length} className="px-6 py-2 bg-green-600 text-white rounded-lg text-xs hover:bg-green-700 disabled:opacity-50">
                {importing ? '导入中...' : `确认导入 ${importPreview.length} 个`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 客户邮件详情弹窗 */}
      {selectedCustomer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={()=> setSelectedCustomer(null)}>
          <div className="bg-white rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl" onClick={e=> e.stopPropagation()}>
            {/* 头部 */}
            <div className="p-4 border-b border-gray-100 flex items-center gap-3">
              <div className="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center text-blue-600 font-bold">{(selectedCustomer.contactName||selectedCustomer.title||'?')[0]}</div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-sm">{selectedCustomer.contactName||selectedCustomer.title}</div>
                <div className="text-xs text-gray-500">{selectedCustomer.email} · {selectedCustomer.company||'—'}</div>
                <div className="flex items-center gap-1 mt-1 flex-wrap">
                  {(selectedCustomer.tags || []).map(t=>(
                    <span key={t} className="text-[10px] px-1.5 py-0.5 bg-teal-50 text-teal-600 rounded-full flex items-center gap-0.5">{t}
                      <button onClick={()=> void saveTags(selectedCustomer, (selectedCustomer.tags||[]).filter(x=> x!==t))} className="hover:text-red-500">×</button>
                    </span>
                  ))}
                  <span className="flex items-center gap-0.5">
                    <input value={tagInput} onChange={e=> setTagInput(e.target.value)} onKeyDown={e=>{ if(e.key==='Enter' && tagInput.trim()){ void saveTags(selectedCustomer, [...(selectedCustomer.tags||[]), tagInput.trim()]); setTagInput('') } }} placeholder="+标签" className="w-16 px-1.5 py-0.5 border rounded-full text-[10px]" />
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                {selectedCustomer.isKey && <span className="text-xs px-2 py-0.5 bg-yellow-100 text-yellow-700 rounded-full">⭐ 重点</span>}
                <span className="text-xs px-2 py-0.5 bg-gray-100 rounded-full">{selectedCustomer.level||'C'}</span>
                {(() => { const t = classifyEmailType(selectedCustomer.email); return <span className={`text-xs px-2 py-0.5 rounded-full ${t.color}`}>{t.label}</span> })()}
              </div>
              <button onClick={()=> setSelectedCustomer(null)} className="p-1.5 hover:bg-gray-100 rounded-lg"><X size={16}/></button>
            </div>
            {/* 统计 */}
            <div className="px-4 py-2 bg-gray-50 border-b flex items-center gap-4 text-xs text-gray-500 flex-wrap">
              <span>📧 邮件往来 <b className="text-gray-800">{customerEmails.length}</b> 封</span>
              {threadMode==='server' && <span className="text-green-600">· 服务端线程秒开</span>}
              {threadMode==='local' && <span className="text-orange-500">· 本地库（服务端无命中）</span>}
              <button onClick={()=> setAllowRemoteImg(v=>!v)} className="ml-auto px-2 py-0.5 border rounded-full hover:border-blue-300 hover:text-blue-600" title="外部图片可能泄露已读回执">
                {allowRemoteImg ? '🖼️ 已显示外部图片' : '🖼️ 外部图片已拦截'}
              </button>
              {(() => { const s = emailStats[(selectedCustomer.email||'').toLowerCase()]; return s && s.totalAmount>0 ? <span>💰 累计金额 <b className="text-green-600">${s.totalAmount.toLocaleString()}</b></span> : null })()}
              <span>📅 下次跟进 {selectedCustomer.followUpAt||'未设置'}</span>
              {(()=>{
                const sd = sentDatesOf(selectedCustomer)
                return (
                  <>
                    <span title="第一次发送给客户的邮件时间">📤 首次发送 <b className="text-gray-800">{sd.firstSentAt?new Date(sd.firstSentAt).toLocaleDateString():'—'}</b></span>
                    <span title="最近一次发送给客户的邮件时间">最近跟进 <b className="text-gray-800">{sd.lastSentAt?new Date(sd.lastSentAt).toLocaleDateString():'—'}</b></span>
                    <span className={sd.daysSinceSent!=null && sd.daysSinceSent>7?'text-rose-600 font-medium':''}>未跟进 <b>{formatDays(sd.daysSinceSent)}</b></span>
                  </>
                )
              })()}
            </div>
            {/* 跟进档案 */}
            <div className="px-4 py-2 border-b bg-gray-50 text-[11px] text-gray-700 space-y-1">
              <div className="font-semibold text-gray-800">📋 跟进档案</div>
              <div className="flex flex-wrap items-center gap-3">
                <span>方式
                  <select
                    value={followModeOf(selectedCustomer)}
                    onChange={async e=>{
                      await setCustomerFollowMode(selectedCustomer, e.target.value as any, 'user')
                      const fresh = await db.customers.get(selectedCustomer.id) as any
                      if(fresh) setSelectedCustomer(fresh)
                    }}
                    className="ml-1 border rounded px-1 py-0.5"
                  >
                    <option value="manual">手动跟进</option>
                    <option value="auto">自动跟进</option>
                  </select>
                </span>
                <span>回复 <b>{String((selectedCustomer as any).hasReply||'')==='yes'?'有':'无'}</b></span>
                <span>状态 <b>{stepLabel((selectedCustomer as any).followStep)}</b></span>
                <span>销售阶段
                  <select
                    value={salesStageOf(selectedCustomer)}
                    onChange={async e=>{
                      await setCustomerSalesStage(selectedCustomer, e.target.value as any)
                      const fresh = await db.customers.get(selectedCustomer.id) as any
                      if(fresh) setSelectedCustomer(fresh)
                    }}
                    className="ml-1 border rounded px-1 py-0.5"
                  >
                    <option value="following">跟进中</option>
                    <option value="ordered">已下单</option>
                    <option value="cancelled">取消</option>
                  </select>
                </span>
                <span>未跟进 <b className={(daysNoFollow(selectedCustomer)||0)>7?'text-rose-600':''}>{daysNoFollow(selectedCustomer)==null?'—':`${daysNoFollow(selectedCustomer)}天`}</b></span>
                <span>最近回复 {String((selectedCustomer as any).lastReplyAt||'').slice(0,10)||'—'}</span>
              </div>
            </div>
            {/* 红框：十一维背景画像（只可 AI 更新或人工编辑，复购开发永不覆盖） */}
            <div className="px-4 py-3 border-b bg-purple-50/40 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <div className="text-xs font-semibold text-purple-800">🤖 AI 客户画像（背景知识）</div>
                <span className="text-[10px] text-purple-600">
                  {(selectedCustomer as any).aiProfileAt
                    ? `更新 ${new Date((selectedCustomer as any).aiProfileAt).toLocaleString()}`
                    : '尚未生成'}
                  {(selectedCustomer as any).portraitEditedAt
                    ? ` · 人工修订 ${new Date((selectedCustomer as any).portraitEditedAt).toLocaleString()}`
                    : ''}
                </span>
                <div className="ml-auto flex items-center gap-1">
                  {portraitEdit ? (
                    <>
                      <button onClick={()=> void savePortraitEdit()} disabled={portraitSaving}
                        className="px-2 py-1 text-[11px] bg-emerald-600 text-white rounded-lg disabled:opacity-50"
                      >{portraitSaving?'保存中…':'保存画像'}</button>
                      <button onClick={()=> setPortraitEdit(null)} className="px-2 py-1 text-[11px] border rounded-lg text-gray-500">取消</button>
                    </>
                  ) : (
                    <>
                      <button onClick={()=> openPortraitEdit(selectedCustomer)}
                        className="px-2 py-1 text-[11px] border border-purple-200 text-purple-700 rounded-lg hover:bg-purple-100"
                        title="手工修改十一维；空栏保留原值，保存后不会被复购开发清除"
                      >✏️ 编辑</button>
                      <button
                        onClick={async()=>{
                          try{
                            setIntelBusy('one'); setIntelNote('单客户 AI 画像生成中（合并已有十一维）…')
                            const { runAiInsight } = await import('../services/customerInsight')
                            const r = await runAiInsight({ limit: 30, force: true, onlyCustomerIds: [selectedCustomer.id], delayMs: 0 })
                            setIntelNote(r.note || '画像已生成')
                            const fresh = await db.customers.get(selectedCustomer.id) as any
                            if(fresh) setSelectedCustomer(fresh)
                            await load()
                          }catch(e:any){ setIntelNote('画像失败：'+String(e.message||e).slice(0,100)) }
                          finally{ setIntelBusy('') }
                        }}
                        disabled={!!intelBusy}
                        className="px-2 py-1 text-[11px] bg-purple-600 text-white rounded-lg disabled:opacity-50"
                      >读邮件生成画像</button>
                    </>
                  )}
                </div>
              </div>
              {portraitEdit ? (
                <div className="space-y-1.5">
                  <div className="text-[10px] text-gray-500">十一维可编辑；保存后仅可通过「读邮件生成画像」或再次编辑更新，复购开发不会覆盖。</div>
                  {PORTRAIT_DIMENSIONS.map(d=>(
                    <div key={d.key} className="flex items-start gap-2">
                      <span className="w-24 shrink-0 text-[11px] text-purple-800 pt-1">{d.label}</span>
                      <input
                        value={portraitEdit[d.key] || ''}
                        onChange={e=> setPortraitEdit(prev=> prev ? { ...prev, [d.key]: e.target.value } : prev)}
                        placeholder={d.hint}
                        className="flex-1 border rounded px-2 py-1 text-[11px]"
                      />
                    </div>
                  ))}
                </div>
              ) : (()=>{
                const portrait = mergePortrait(
                  coercePortrait((selectedCustomer as any).aiPortrait),
                  parsePortraitFromProfile((selectedCustomer as any).aiProfile) || {},
                )
                const rows = portraitDisplay(portrait)
                const has = rows.some(r=> isFillableDim(r.value)) || !!(selectedCustomer as any).aiProfile
                if(!has){
                  return <div className="text-[11px] text-gray-400">尚未生成十一维画像。点「读邮件生成画像」或「批量AI画像」。</div>
                }
                return (
                  <div className="text-[11px] text-gray-700 space-y-0.5">
                    <div className="font-semibold text-purple-900">【十一维画像 v2】</div>
                    {rows.map(r=>(
                      <div key={r.key} className="flex gap-1">
                        <span className="text-purple-800 shrink-0">{r.label}：</span>
                        <span className={isFillableDim(r.value)?'':'text-gray-400'}>{r.value || '—'}</span>
                      </div>
                    ))}
                    {(selectedCustomer as any).aiProfile && !rows.some(r=> isFillableDim(r.value)) && (
                      <div className="whitespace-pre-wrap text-gray-600 mt-1">{(selectedCustomer as any).aiProfile}</div>
                    )}
                  </div>
                )
              })()}
              <div className="flex flex-wrap gap-1.5 text-[10px]">
                {(selectedCustomer as any).aiTier && (
                  <span className="px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">
                    桶：{{high:'高意向',pending:'待成交',repurchase:'复购',marketing:'营销',follow:'跟进',dormant:'沉寂',active:'活跃'}[(selectedCustomer as any).aiTier as string] || (selectedCustomer as any).aiTier}
                  </span>
                )}
                {(selectedCustomer as any).aiIntent && <span className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-700">意向 {(selectedCustomer as any).aiIntent}</span>}
              </div>
            </div>
            {/* 蓝框：复购经营情报（独立字段，不覆盖画像） */}
            <div className="px-4 py-2 border-b bg-blue-50/40 space-y-1.5">
              <div className="flex items-center gap-2">
                <div className="text-xs font-semibold text-blue-800">🔁 复购分析（经营情报）</div>
                <span className="text-[10px] text-blue-600">
                  {(selectedCustomer as any).purchaseIntelAt
                    ? `分析 ${new Date((selectedCustomer as any).purchaseIntelAt).toLocaleString()}`
                    : '尚未分析'}
                </span>
                <button
                  onClick={async()=>{
                    setIntelBusy('loop-p1')
                    try{
                      const { runPurchaseLoop } = await import('../services/customerInsight')
                      const r = await runPurchaseLoop({
                        limit: 1, force: true, delayMs: 0,
                        onProgress: ()=> setIntelNote('复购开发（单客户）结合十一维+订单+邮件…'),
                      })
                      setIntelNote(r.note || '复购分析完成')
                      const fresh = await db.customers.get(selectedCustomer.id) as any
                      if(fresh) setSelectedCustomer(fresh)
                      await load()
                    }catch(e:any){ setIntelNote('复购分析失败：'+String(e.message||e).slice(0,100)) }
                    finally{ setIntelBusy('') }
                  }}
                  disabled={!!intelBusy}
                  className="ml-auto px-2 py-1 text-[11px] bg-blue-600 text-white rounded-lg disabled:opacity-50"
                  title="读取十一维画像+订单+邮件做复购分析，不修改画像"
                >运行复购开发</button>
              </div>
              {(() => {
                const c = selectedCustomer as any
                const has = c.purchaseSummary || c.nextBestAction || c.purchaseAiNote || c.purchaseTier
                if(!has) return <div className="text-[11px] text-gray-400">暂无复购分析。点「运行复购开发」；人数上限见智能设置。</div>
                return (
                  <div className="text-[11px] text-gray-700 space-y-1">
                    {c.purchaseSummary && <div>📊 {c.purchaseSummary}</div>}
                    {(c.purchaseTier || c.nextBestAction) && (
                      <div>
                        🎯 类型 <b>{c.purchaseTier||'—'}</b>
                        {c.nextBestAction && <> · NBA <b>{c.nextBestAction}</b></>}
                        {c.cycleDaysEst ? <> · 周期约 {c.cycleDaysEst} 天</> : null}
                        {c.nextWindowAt ? <> · 窗口 {c.nextWindowAt}</> : null}
                      </div>
                    )}
                    {c.nbaReason && <div className="text-blue-800">💡 {c.nbaReason}</div>}
                    {c.purchaseAiNote && (
                      <div className="text-gray-700 whitespace-pre-wrap bg-white/60 rounded-lg p-2 border border-blue-100">
                        {c.purchaseAiNote}
                      </div>
                    )}
                  </div>
                )
              })()}
            </div>
            {/* 邮件列表 */}
            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              {customerEmails.length===0 && <div className="text-center text-gray-400 py-8">暂无邮件来往记录</div>}
              {customerEmails.map(e=>{
                const isSent = e.folder==='sent' || (e.from||'').toLowerCase().includes('evan@maxemblem.com')
                const loaded = fullContent[e.id]
                const loading = loadingContent[e.id]
                const failed = contentError[e.id]
                const displayText = loaded?.text || e.text || ''
                const displayHtml = loaded?.html || e.html || ''
                return(
                  <div key={e.id} className={`p-3 rounded-xl border ${isSent?'bg-green-50/50 border-green-100 ml-8':'bg-blue-50/50 border-blue-100 mr-8'}`}>
                    <div className="flex items-center gap-2 text-xs mb-1">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] ${isSent?'bg-green-100 text-green-700':'bg-blue-100 text-blue-700'}`}>{isSent?'发件':'收件'}</span>
                      <span className="font-medium text-gray-700 truncate">{isSent ? `我 → ${selectedCustomer.email}` : e.from.split('<')[0].trim()}</span>
                      <span className="ml-auto text-[10px] text-gray-400">{new Date(e.date).toLocaleString()}</span>
                    </div>
                    <div className="text-xs font-medium text-gray-700 mb-1">{e.subject}</div>
                    {loading ? (
                      <div className="text-[11px] text-blue-400 py-2 flex items-center gap-1">
                        <span className="animate-spin">⏳</span> 正在加载邮件全文...
                      </div>
                    ) : displayHtml ? (
                      <MailHtml html={displayHtml} allowRemote={allowRemoteImg} height={320} />
                    ) : displayText ? (
                      <div className="text-[11px] text-gray-600 whitespace-pre-wrap max-h-40 overflow-auto border rounded-lg p-2 bg-white">{displayText.slice(0,2000)}</div>
                    ) : failed ? (
                      <button onClick={()=> retryMailContent(e)} className="text-[11px] text-red-400 py-2 hover:text-red-600">⚠️ 全文加载失败，点击重试（先查服务端库，再走IMAP）</button>
                    ) : (
                      <div className="text-[11px] text-gray-400 py-2">暂无内容</div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
