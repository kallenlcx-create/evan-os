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

// ====== 卡片背景主题 ======

export interface CardTheme {
  key: string
  label: string
  /** 卡片背景类（浅色模式） */
  bg: string
  /** 卡片边框类 */
  border: string
  /** 卡片预览色块（用于设置页展示） */
  preview: string
}

export const CARD_THEMES: CardTheme[] = [
  { key: 'default', label: '经典白', bg: 'bg-white', border: 'border-gray-100', preview: 'bg-white border-gray-200' },
  { key: 'warm',    label: '暖阳',   bg: 'bg-orange-50/60', border: 'border-orange-100', preview: 'bg-orange-50 border-orange-200' },
  { key: 'ocean',   label: '海洋',   bg: 'bg-sky-50/60', border: 'border-sky-100', preview: 'bg-sky-50 border-sky-200' },
  { key: 'forest',  label: '森林',   bg: 'bg-emerald-50/60', border: 'border-emerald-100', preview: 'bg-emerald-50 border-emerald-200' },
  { key: 'lavender',label: '薰衣草', bg: 'bg-purple-50/60', border: 'border-purple-100', preview: 'bg-purple-50 border-purple-200' },
  { key: 'rose',    label: '玫瑰',   bg: 'bg-rose-50/60', border: 'border-rose-100', preview: 'bg-rose-50 border-rose-200' },
  { key: 'slate',   label: '石墨',   bg: 'bg-slate-50/80', border: 'border-slate-200', preview: 'bg-slate-50 border-slate-300' },
  { key: 'amber',   label: '琥珀',   bg: 'bg-amber-50/60', border: 'border-amber-100', preview: 'bg-amber-50 border-amber-200' },
]

const LS_CARD_THEME = 'evan-os-card-theme'

/** 获取当前卡片背景主题 */
export function getCardTheme(): CardTheme {
  try {
    const key = localStorage.getItem(LS_CARD_THEME) ?? 'default'
    return CARD_THEMES.find(t => t.key === key) ?? CARD_THEMES[0]
  } catch { return CARD_THEMES[0] }
}

/** 设置卡片背景主题 */
export function setCardTheme(key: string) {
  localStorage.setItem(LS_CARD_THEME, key)
  window.dispatchEvent(new CustomEvent('evan-card-theme-change'))
}

/** 返回卡片通用背景+边框类（可在任意组件中直接拼入 className） */
export function cardBg(): string {
  const t = getCardTheme()
  return `${t.bg} ${t.border}`
}
