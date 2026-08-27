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
