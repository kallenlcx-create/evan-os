// 跟进表高级筛选：字段注册表 + chip + 范围/多选/日期/文本 + 预设 + 导出
import type { Customer } from '../types'
import { quoteStatusOf, quoteStatusLabel, salesStageOf, daysNoFollow, businessCreatedAt } from './followProfile'

export type FilterKind = 'range' | 'enum' | 'date' | 'text' | 'bool'

export type FilterValue =
  | { kind: 'range'; min?: number | null; max?: number | null; includeEmpty?: boolean }
  | { kind: 'enum'; values: string[] }
  | { kind: 'date'; from?: string; to?: string; includeEmpty?: boolean }
  | { kind: 'text'; op: 'contains' | 'eq'; value: string }
  | { kind: 'bool'; value: boolean | null }

export type FilterChip = { field: string; value: FilterValue }

export type FilterFieldDef = {
  id: string
  label: string
  kind: FilterKind
  options?: string[]
  get: (c: Customer, ctx?: FilterCtx) => any
}

export type FilterCtx = {
  manualMap?: Record<string, { buckets?: string[] }>
  todaySet?: Set<string>
  overdueSet?: Set<string>
  orderedSet?: Set<string>
  inquiryDate?: (id: string) => string | undefined
}

export const BUCKET_OPTIONS = ['高意向', '今日跟进', '逾期跟进', '待成交机会', '潜在复购', '营销机会'] as const

const PRODUCT_TAGS = ['Patch', 'Pin', 'Coin', 'Medal', 'Keychain'] as const

function isOrdered(c: Customer, ctx?: FilterCtx){
  const tags = (c.tags || []).map(String)
  return tags.includes('已下单') || c.stage === 'won' || (c.repurchaseCount || 0) >= 1 || !!ctx?.orderedSet?.has(c.id)
}

function bucketsOf(c: Customer, ctx?: FilterCtx): string[] {
  const out: string[] = []
  const t = String((c as any).aiTier || '')
  const mb = (ctx?.manualMap?.[c.id]?.buckets || []).map(String)
  const hr = String((c as any).hasReply || '')
  if (t === 'high' || mb.includes('high') || hr === 'yes') out.push('高意向')
  if (ctx?.todaySet?.has(c.id) || mb.includes('today')) out.push('今日跟进')
  const ordered = isOrdered(c, ctx)
  if ((!ordered && ctx?.overdueSet?.has(c.id)) || mb.includes('overdue')) out.push('逾期跟进')
  if (t === 'pending' || mb.includes('pending')) out.push('待成交机会')
  const days = daysNoFollow(c)
  if (t === 'repurchase' || mb.includes('repurchase') || (ordered && (days == null || days >= 30))) out.push('潜在复购')
  if (t === 'marketing' || mb.includes('marketing')) out.push('营销机会')
  return out
}

export const FOLLOW_FILTER_FIELDS: FilterFieldDef[] = [
  { id: 'bucket', label: '跟进板块', kind: 'enum', options: [...BUCKET_OPTIONS], get: (c, ctx) => bucketsOf(c, ctx) },
  { id: 'no_follow', label: '未跟进天数', kind: 'range', get: (c) => daysNoFollow(c) },
  { id: 'quote', label: '设计稿/报价', kind: 'enum', options: ['未报价', '已报价', '谈价中', '已接受'], get: (c) => quoteStatusLabel(quoteStatusOf(c)) },
  { id: 'follow_status', label: '业务跟进状态', kind: 'enum', options: ['跟进1', '跟进2', '跟进3', '跟进4', '跟进5', '跟进6', '跟进7'], get: (c) => {
    const n = Number((c as any).followStep || 0)
    return n >= 1 && n <= 7 ? `跟进${n}` : String((c as any).followStepLabel || '')
  }},
  { id: 'sales_stage', label: '销售阶段', kind: 'enum', options: ['跟进中', '已下单', '取消'], get: (c) => salesStageOf(c) === 'ordered' ? '已下单' : salesStageOf(c) === 'cancelled' ? '取消' : '跟进中' },
  { id: 'created_at', label: '创建时间', kind: 'date', get: (c, ctx) => businessCreatedAt(c, { inquiryDate: ctx?.inquiryDate?.(c.id) }) },
  { id: 'last_follow', label: '最近跟进时间', kind: 'date', get: (c) => String((c as any).lastFollowAt || (c as any).lastSentAt || '').slice(0, 10) || null },
  { id: 'last_reply', label: '最近回复', kind: 'date', get: (c) => String((c as any).lastReplyAt || '').slice(0, 10) || null },
  { id: 'expected_amount', label: '预计金额', kind: 'range', get: (c) => (c as any).value ?? (c as any).expectedAmount ?? null },
  { id: 'note', label: '客户备注', kind: 'text', get: (c) => String((c as any).notes || (c as any).description || '') },
  { id: 'company', label: '公司名称', kind: 'text', get: (c) => c.company || '' },
  { id: 'contact', label: '主联系人', kind: 'text', get: (c) => c.contactName || c.title || '' },
  { id: 'owner', label: '负责人', kind: 'enum', options: ['Evan'], get: () => 'Evan' },
  { id: 'level', label: '等级', kind: 'enum', options: ['A+', 'A', 'B', 'C', 'D'], get: (c) => c.level || 'C' },
  { id: 'product', label: '产品', kind: 'enum', options: [...PRODUCT_TAGS], get: (c) => ((c.tags || []).filter(t => (PRODUCT_TAGS as readonly string[]).includes(String(t))) as string[]) },
  { id: 'key', label: '重点标记', kind: 'bool', get: (c) => !!c.isKey },
  { id: 'reply', label: '回复', kind: 'enum', options: ['有', '无'], get: (c) => String((c as any).hasReply || 'no') === 'yes' ? '有' : '无' },
  { id: 'inq', label: '询盘号', kind: 'text', get: (c) => {
    const nos = (c as any).inquiryNos as string[] | undefined
    return nos?.join(' ') || String((c as any).inquiryNo || '')
  }},
]

function isEmptyVal(v: any){
  return v == null || v === '' || (Array.isArray(v) && v.length === 0)
}

export function matchFilterChip(c: Customer, chip: FilterChip, ctx?: FilterCtx){
  const def = FOLLOW_FILTER_FIELDS.find(f => f.id === chip.field)
  if (!def) return true
  const raw = def.get(c, ctx)
  const v = chip.value
  if (v.kind === 'range'){
    const noConstraint = v.min == null && v.max == null
    if (noConstraint) return true
    const empty = isEmptyVal(raw)
    if (empty) return !!v.includeEmpty
    const n = Number(raw)
    if (!Number.isFinite(n)) return !!v.includeEmpty
    if (v.min != null && n < v.min) return false
    if (v.max != null && n > v.max) return false
    return true
  }
  if (v.kind === 'enum'){
    if (!v.values.length) return true
    const arr = Array.isArray(raw) ? raw.map(String) : [String(raw ?? '')]
    return v.values.some(x => arr.includes(x))
  }
  if (v.kind === 'date'){
    const noConstraint = !v.from && !v.to
    if (noConstraint) return true
    const empty = !raw
    if (empty) return !!v.includeEmpty
    const t = new Date(String(raw)).getTime()
    if (!Number.isFinite(t)) return !!v.includeEmpty
    if (v.from){ const f = new Date(v.from + 'T00:00:00').getTime(); if (t < f) return false }
    if (v.to){ const tt = new Date(v.to + 'T23:59:59').getTime(); if (t > tt) return false }
    return true
  }
  if (v.kind === 'text'){
    const s = String(raw ?? '').toLowerCase()
    const q = String(v.value || '').toLowerCase()
    if (!q) return true
    return v.op === 'eq' ? s === q : s.includes(q)
  }
  if (v.kind === 'bool'){
    const b = !!raw
    return v.value == null ? true : b === !!v.value
  }
  return true
}

export function applyFollowFilters<T extends Customer>(rows: T[], chips: FilterChip[], search?: string, ctx?: FilterCtx): T[] {
  let out = rows
  const q = (search || '').trim().toLowerCase()
  if (q){
    out = out.filter(c => {
      const nos = (c as any).inquiryNos as string[] | undefined
      const blob = `${c.contactName || ''} ${c.title || ''} ${c.email || ''} ${c.company || ''} ${(c as any).notes || ''} ${nos?.join(' ') || (c as any).inquiryNo || ''}`.toLowerCase()
      return blob.includes(q)
    })
  }
  for (const chip of chips){
    out = out.filter(c => matchFilterChip(c, chip, ctx))
  }
  return out
}

export function chipLabel(chip: FilterChip){
  const def = FOLLOW_FILTER_FIELDS.find(f => f.id === chip.field)
  const name = def?.label || chip.field
  const v = chip.value
  if (v.kind === 'range'){
    const parts: string[] = []
    if (v.min != null || v.max != null) parts.push(`${v.min ?? ''}–${v.max ?? ''}`)
    if (v.includeEmpty) parts.push('空')
    return `${name} ${parts.join(' / ') || '—'}`
  }
  if (v.kind === 'enum') return `${name} ${v.values.slice(0, 3).join('/')}${v.values.length > 3 ? '…' : ''}`
  if (v.kind === 'date') return `${name} ${v.from || '…'}~${v.to || '…'}${v.includeEmpty ? '+空' : ''}`
  if (v.kind === 'text') return `${name} ${v.op === 'eq' ? '=' : '含'} ${v.value}`
  if (v.kind === 'bool') return `${name} ${v.value == null ? '—' : (v.value ? '是' : '否')}`
  return name
}

export function defaultFilterValue(def: FilterFieldDef): FilterValue {
  if (def.kind === 'range') return { kind: 'range', min: null, max: null, includeEmpty: false }
  if (def.kind === 'enum') return { kind: 'enum', values: [] }
  if (def.kind === 'date') return { kind: 'date', from: '', to: '', includeEmpty: false }
  if (def.kind === 'bool') return { kind: 'bool', value: true }
  return { kind: 'text', op: 'contains', value: '' }
}

/** 六板块 → 跟进表筛选 chips */
export function bucketPresetChips(key: string): FilterChip[] {
  const map: Record<string, string> = {
    high: '高意向',
    today: '今日跟进',
    overdue: '逾期跟进',
    pending: '待成交机会',
    repurchase: '潜在复购',
    marketing: '营销机会',
  }
  const label = map[key] || key
  return [{ field: 'bucket', value: { kind: 'enum', values: [label] } }]
}

// ====== 筛选预设（localStorage）======
export type FilterPreset = { id: string; name: string; chips: FilterChip[]; search?: string }
const PRESET_KEY = 'evan:followFilterPresets'

export function loadFilterPresets(): FilterPreset[] {
  try {
    const arr = JSON.parse(localStorage.getItem(PRESET_KEY) || '[]')
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}

export function saveFilterPresets(list: FilterPreset[]) {
  localStorage.setItem(PRESET_KEY, JSON.stringify(list))
}

export function upsertFilterPreset(name: string, chips: FilterChip[], search?: string): FilterPreset[] {
  const list = loadFilterPresets()
  const id = 'p-' + Date.now().toString(36)
  const item: FilterPreset = { id, name, chips, search }
  const next = [...list, item]
  saveFilterPresets(next)
  return next
}

export function removeFilterPreset(id: string): FilterPreset[] {
  const next = loadFilterPresets().filter(p => p.id !== id)
  saveFilterPresets(next)
  return next
}

// ====== 导出当前筛选行 CSV ======
export function exportFollowRowsCsv(rows: Customer[], filename = '跟进表筛选.csv') {
  const cols = ['客户', '邮箱', '公司', '等级', '产品', '报价', '销售阶段', '跟进方式', '跟进状态', '未跟进天数', '最近跟进', '最近回复', '询盘号', '备注']
  const esc = (v: any) => {
    const s = String(v ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')
    return `"${s}"`
  }
  const lines = [cols.map(esc).join(',')]
  for (const c of rows) {
    const nos = (c as any).inquiryNos as string[] | undefined
    const product = ((c.tags || []).filter(t => (PRODUCT_TAGS as readonly string[]).includes(String(t))) as string[]).join('/')
    lines.push([
      c.contactName || c.title || '',
      c.email || '',
      c.company || '',
      c.level || 'C',
      product,
      quoteStatusLabel(quoteStatusOf(c)),
      salesStageOf(c) === 'ordered' ? '已下单' : salesStageOf(c) === 'cancelled' ? '取消' : '跟进中',
      String((c as any).followMode || (c as any).mode || ''),
      (() => { const n = Number((c as any).followStep || 0); return n >= 1 && n <= 7 ? `跟进${n}` : '' })(),
      daysNoFollow(c) ?? '',
      String((c as any).lastFollowAt || (c as any).lastSentAt || '').slice(0, 10),
      String((c as any).lastReplyAt || '').slice(0, 10),
      nos?.join(' ') || String((c as any).inquiryNo || ''),
      String((c as any).notes || ''),
    ].map(esc).join(','))
  }
  // BOM 便于 Excel 打开中文
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}
