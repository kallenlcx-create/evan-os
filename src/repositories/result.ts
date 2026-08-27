// ====== Result / Error 统一错误处理 ======
export type Result<T, E = string> =
  | { ok: true; value: T }
  | { ok: false; error: E }

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value }
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error }
}

// ====== ID 生成 ======
export function uid(): string {
  // crypto.randomUUID() 在现代浏览器中可用，128 位随机，无碰撞风险
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // 降级：时间戳 + 8 字符随机
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

export function now(): string {
  return new Date().toISOString()
}
