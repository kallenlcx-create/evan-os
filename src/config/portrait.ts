// 十一维客户画像：常量 + 格式化 + 合并（人工/AI 共用）
export type AiPortraitV2 = {
  order_times?: string
  order_count?: string
  customer_type?: string
  product_preference?: string
  craft_preference?: string
  procurement_scale?: string
  budget_sensitivity?: string
  decision_mode?: string
  time_pattern?: string
  repurchase_potential?: string
  next_marketing?: string
}

export const PORTRAIT_DIMENSIONS: {
  key: keyof AiPortraitV2
  label: string
  hint: string
}[] = [
  { key: 'order_times', label: '① 下单时间', hint: '付款时间，如 2025年6月6日' },
  { key: 'order_count', label: '② 下单次数', hint: '如 2次' },
  { key: 'customer_type', label: '③ 客户类型', hint: '公司/军警/学校/赛事/俱乐部/个人/协会' },
  { key: 'product_preference', label: '④ 产品偏好', hint: 'Medal / Coin / Pin / Patch / Keychain' },
  { key: 'craft_preference', label: '⑤ 工艺偏好', hint: 'Soft Enamel、3D、UV、Die Cast、Embroidery' },
  { key: 'procurement_scale', label: '⑥ 采购规模', hint: 'pcs + 金额，如 25 pcs / $900' },
  { key: 'budget_sensitivity', label: '⑦ 预算敏感度', hint: '高 / 中 / 低' },
  { key: 'decision_mode', label: '⑧ 决策方式', hint: '个人直接决定 / 团队审核 / 多人审批' },
  { key: 'time_pattern', label: '⑨ 时间特征', hint: '年度赛事、毕业季、节日、纪念日' },
  { key: 'repurchase_potential', label: '⑩ 复购潜力', hint: '高 / 中 / 低' },
  { key: 'next_marketing', label: '⑪ 营销策略', hint: '复购提醒 / 新品推荐 / 优惠 / 节日营销' },
]

export function emptyPortrait(): AiPortraitV2 {
  const o: AiPortraitV2 = {}
  for (const d of PORTRAIT_DIMENSIONS) o[d.key] = ''
  return o
}

export function coercePortrait(raw: any): AiPortraitV2 {
  const o = emptyPortrait()
  if (!raw || typeof raw !== 'object') return o
  for (const d of PORTRAIT_DIMENSIONS) {
    const v = raw[d.key]
    if (v != null && String(v).trim()) o[d.key] = String(v).trim()
  }
  return o
}

const EMPTY_PAT = /^(邮件未体现|—|-|无|未知|n\/a|null)$/i

export function isFillableDim(v?: string): boolean {
  const s = String(v || '').trim()
  return !!s && !EMPTY_PAT.test(s)
}

/** AI 更新时：AI 有效值覆盖；AI 空/未体现 → 保留旧值（含人工修正） */
export function mergePortrait(prev: AiPortraitV2 | undefined, next: Partial<AiPortraitV2> | undefined): AiPortraitV2 {
  const base = coercePortrait(prev)
  const inc = coercePortrait(next)
  const out = emptyPortrait()
  for (const d of PORTRAIT_DIMENSIONS) {
    const nv = inc[d.key]
    const pv = base[d.key]
    out[d.key] = isFillableDim(nv) ? nv! : (pv || '')
  }
  return out
}

export function formatPortraitText(p?: AiPortraitV2 | null): string {
  const po = coercePortrait(p)
  return PORTRAIT_DIMENSIONS
    .map(d => `${d.label}：${po[d.key] || '—'}`)
    .join('\n')
}

export function portraitHasContent(p?: AiPortraitV2 | null): boolean {
  return PORTRAIT_DIMENSIONS.some(d => isFillableDim(coercePortrait(p)[d.key]))
}

/** 从旧版纯文本 aiProfile 尽力解析十一维（兼容无 aiPortrait 的历史数据） */
export function parsePortraitFromProfile(text?: string | null): AiPortraitV2 | null {
  if (!text) return null
  const out = emptyPortrait()
  let hit = 0
  const t = String(text)
  // 【十一维画像 v2】① label：value
  for (const d of PORTRAIT_DIMENSIONS) {
    // 匹配「① 下单时间：xxx」或「① 下单时间: xxx」
    const re = new RegExp(`${d.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[：:]\\s*([^\\n]+)`)
    const m = t.match(re)
    if (m) {
      const v = m[1].trim()
      if (isFillableDim(v)) { out[d.key] = v; hit++ }
    }
  }
  return hit > 0 ? out : null
}

export function portraitDisplay(p?: AiPortraitV2 | null): { key: keyof AiPortraitV2; label: string; value: string }[] {
  const po = coercePortrait(p)
  return PORTRAIT_DIMENSIONS.map(d => ({
    key: d.key,
    label: d.label,
    value: po[d.key] || '',
  }))
}
