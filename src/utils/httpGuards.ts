/**
 * 出站 HTTP 请求的通用校验与归一化。
 *
 * 这些函数原本住在 backgroundRequestBridge.ts 里。那个通用请求桥已经删除
 * （内容脚本出于安全考虑不再转发页面发起的任意请求），但 AI 任务链路仍然需要
 * 这几项检查，因此单独保留在这里。
 */
export type ResponseType = 'text' | 'json' | 'arraybuffer' | 'blob' | 'document' | 'stream'

export function createBackgroundRequestId() {
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function toFiniteNumber(value: unknown) {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim()) return Number(value)
  return Number.NaN
}

export function normalizeRequestTimeout(timeout?: unknown) {
  const raw = toFiniteNumber(timeout ?? 180)
  if (!Number.isFinite(raw) || raw <= 0) return 180
  // 旧配置里存过 axios 风格的毫秒值；本项目统一使用秒。
  return raw > 1800 ? Math.ceil(raw / 1000) : raw
}

export function assertHttpUrl(url: string) {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`不支持的请求协议: ${parsed.protocol}`)
  }
}

export function assertRequestTimeout(timeout: number) {
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 1800) {
    throw new Error('请求超时时间不合法')
  }
}
