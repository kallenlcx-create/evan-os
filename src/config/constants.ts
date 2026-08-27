// ====== 共享常量 ======

export const MOODS = [
  { value: 'great', emoji: '😄', label: '很棒' },
  { value: 'good', emoji: '😊', label: '不错' },
  { value: 'ok', emoji: '😐', label: '一般' },
  { value: 'tired', emoji: '😫', label: '疲惫' },
  { value: 'bad', emoji: '😞', label: '不好' },
] as const

export type MoodValue = typeof MOODS[number]['value']

/** 各心情对应的 Tailwind 背景色（DailyLog 等需要彩色标签的场景） */
export const MOOD_COLORS: Record<MoodValue, string> = {
  great: 'bg-green-100 text-green-700',
  good: 'bg-blue-100 text-blue-700',
  ok: 'bg-gray-100 text-gray-700',
  tired: 'bg-orange-100 text-orange-700',
  bad: 'bg-red-100 text-red-700',
}

// ====== 卡片背景主题（统一系统：背景色 + 透明度）======

export interface CardTheme {
  key: string
  label: string
  /** 背景基础色（hex） */
  hex: string
  /** 设置页预览色块 class */
  preview: string
  /** 该主题的默认透明度 0-1 */
  defaultOpacity: number
}

export const CARD_THEMES: CardTheme[] = [
  { key: 'default', label: '经典白', hex: '#ffffff', preview: 'bg-white border-gray-200', defaultOpacity: 1 },
  { key: 'warm',    label: '暖阳',   hex: '#fff7ed', preview: 'bg-orange-50 border-orange-200', defaultOpacity: 0.6 },
  { key: 'ocean',   label: '海洋',   hex: '#f0f9ff', preview: 'bg-sky-50 border-sky-200', defaultOpacity: 0.6 },
  { key: 'forest',  label: '森林',   hex: '#f0fdf4', preview: 'bg-emerald-50 border-emerald-200', defaultOpacity: 0.6 },
  { key: 'lavender',label: '薰衣草', hex: '#f5f3ff', preview: 'bg-purple-50 border-purple-200', defaultOpacity: 0.6 },
  { key: 'rose',    label: '玫瑰',   hex: '#fff1f2', preview: 'bg-rose-50 border-rose-200', defaultOpacity: 0.6 },
  { key: 'slate',   label: '石墨',   hex: '#f8fafc', preview: 'bg-slate-50 border-slate-300', defaultOpacity: 0.8 },
  { key: 'amber',   label: '琥珀',   hex: '#fffbeb', preview: 'bg-amber-50 border-amber-200', defaultOpacity: 0.6 },
]

interface CardThemeState { key: string; opacity: number }

const LS_CARD_THEME = 'evan-os-card-theme'

/** 获取当前卡片主题（背景色 + 透明度） */
export function getCardTheme(): CardTheme & { opacity: number } {
  try {
    const raw = localStorage.getItem(LS_CARD_THEME)
    if (raw) {
      const state: CardThemeState = JSON.parse(raw)
      const t = CARD_THEMES.find(t => t.key === state.key) ?? CARD_THEMES[0]
      return { ...t, opacity: typeof state.opacity === 'number' ? state.opacity : t.defaultOpacity }
    }
  } catch {}
  return { ...CARD_THEMES[0], opacity: CARD_THEMES[0].defaultOpacity }
}

/** 设置卡片背景主题（仅切换主题，保留当前透明度） */
export function setCardTheme(key: string) {
  const cur = getCardTheme()
  const next = CARD_THEMES.find(t => t.key === key) ?? CARD_THEMES[0]
  localStorage.setItem(LS_CARD_THEME, JSON.stringify({ key: next.key, opacity: cur.opacity }))
  window.dispatchEvent(new CustomEvent('evan-card-theme-change'))
}

/** 设置卡片透明度（保持当前主题） */
export function setCardThemeOpacity(opacity: number) {
  const cur = getCardTheme()
  localStorage.setItem(LS_CARD_THEME, JSON.stringify({ key: cur.key, opacity }))
  window.dispatchEvent(new CustomEvent('evan-card-theme-change'))
}

/** hex -> "r,g,b" */
function hexToRgb(hex: string): string {
  const m = hex.replace('#', '')
  const full = m.length === 3 ? m.split('').map(c => c + c).join('') : m
  const n = parseInt(full, 16)
  if (Number.isNaN(n) || full.length !== 6) return '255,255,255'
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`
}

/** 返回卡片背景 inline style（背景色 + 透明度） */
export function cardBgStyle(): React.CSSProperties {
  const t = getCardTheme()
  return { backgroundColor: `rgba(${hexToRgb(t.hex)},${t.opacity})` }
}
