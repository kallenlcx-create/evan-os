// ====== 工作时间配置（v1.1：支持固定周 + 大小周）======
// 所有时间相关功能（时钟倒计时/补水/久坐/下班提醒）统一从这里读取

export interface WorkHoursConfig {
  startAM: string
  endAM: string
  startPM: string
  endPM: string
  /** fixed: 每周固定工作日；alternating: 大小周 */
  schedule: 'fixed' | 'alternating'
  /** fixed 模式：每周工作日（0=周日） */
  workdays: number[]
  /** 大小周：双休那周的休息日（如 [0,6] 周六日） */
  offDaysFull: number[]
  /** 大小周：单休那周的休息日（如 [0] 仅周日） */
  offDaysSingle: number[]
}

export const WORK_HOURS_KEY = 'evan-os-work-hours'

export const DEFAULT_WORK_HOURS: WorkHoursConfig = {
  startAM: '09:00', endAM: '12:00', startPM: '13:30', endPM: '18:00',
  schedule: 'fixed',
  workdays: [1, 2, 3, 4, 5],
  offDaysFull: [0, 6],
  offDaysSingle: [0],
}

export function readWorkHours(): WorkHoursConfig {
  try {
    const parsed = JSON.parse(localStorage.getItem(WORK_HOURS_KEY) || 'null')
    return { ...DEFAULT_WORK_HOURS, ...(parsed ?? {}) }
  } catch {
    return { ...DEFAULT_WORK_HOURS }
  }
}

export function saveWorkHours(cfg: WorkHoursConfig): void {
  localStorage.setItem(WORK_HOURS_KEY, JSON.stringify(cfg))
  window.dispatchEvent(new Event('evan-work-hours'))
}

/** ISO 周数（用于大小周奇偶交替） */
export function isoWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
}

/** 某日期是否为工作日（含大小周判定） */
export function isWorkDay(date: Date, cfg: WorkHoursConfig = readWorkHours()): boolean {
  const day = date.getDay()
  if (cfg.schedule === 'alternating') {
    // 偶数周 = 双休周；奇数周 = 单休周
    const off = isoWeekNumber(date) % 2 === 0 ? cfg.offDaysFull : cfg.offDaysSingle
    return !off.includes(day)
  }
  return cfg.workdays.includes(day)
}

/** 当前时刻是否处于工作状态（工作日 + 时段区间内） */
export function isWorkNow(date: Date = new Date()): boolean {
  if (!isWorkDay(date)) return false
  const cur = date.getHours() * 60 + date.getMinutes()
  const toMin = (s: string) => { const [a, b] = s.split(':').map(Number); return a * 60 + b }
  return cur >= toMin(readWorkHours().startAM) && cur <= toMin(readWorkHours().endPM)
}
