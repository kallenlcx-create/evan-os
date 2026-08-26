// ====== 本地日期工具 ======
// toISOString().slice(0,10) 是 UTC 日期：东八区每天 0:00-8:00 会把"今天"算成昨天。
// 全站凡涉及「今天」语义的日期键一律使用本模块。

/** 本地时区 YYYY-MM-DD（默认当前时间） */
export function localDate(d: Date | number = new Date()): string {
  const dt = typeof d === 'number' ? new Date(d) : d
  const y = dt.getFullYear()
  const m = String(dt.getMonth() + 1).padStart(2, '0')
  const day = String(dt.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 本地时区的"今天" */
export function localToday(): string {
  return localDate(new Date())
}
