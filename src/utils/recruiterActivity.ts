export const RECRUITER_ACTIVITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

const earliestPlausibleTimestamp = Date.UTC(2000, 0, 1)

export type RecruiterActivityDecision =
  | {
      status: 'recent'
      source: 'text' | 'timestamp'
      label: string
      ageMs?: number
    }
  | {
      status: 'stale'
      source: 'text' | 'timestamp'
      label: string
      ageMs?: number
    }
  | {
      status: 'unknown'
      source: 'text' | 'timestamp' | 'missing'
      label: string
    }

export interface RecruiterActivityInput {
  activeText?: unknown
  activeTime?: unknown
  now?: number
}

function normalizeActivityText(value: unknown) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, '').toLocaleLowerCase() : ''
}

function parseChineseInteger(value: string) {
  if (/^\d+$/.test(value)) return Number(value)
  const digits: Record<string, number> = {
    零: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  }
  if (value === '十') return 10
  const parts = value.split('十')
  if (parts.length === 2) {
    const tens = parts[0] === '' ? 1 : digits[parts[0]]
    const ones = parts[1] === '' ? 0 : digits[parts[1]]
    if (tens != null && ones != null) return tens * 10 + ones
  }
  return value.length === 1 ? digits[value] : undefined
}

function classifyText(text: string): RecruiterActivityDecision | null {
  if (!text) return null

  if (/不活跃|未活跃|很久|长期未/.test(text)) {
    return { status: 'stale', source: 'text', label: text }
  }
  if (/不在线|离线/.test(text)) {
    return { status: 'unknown', source: 'text', label: text }
  }
  if (/在线|刚刚(?:活跃|回复)|当前活跃/.test(text)) {
    return { status: 'recent', source: 'text', label: text }
  }
  if (/(?:今日|今天|昨日|昨天)(?:活跃|回复)/.test(text)) {
    return { status: 'recent', source: 'text', label: text }
  }
  if (/(?:一周内|本周)(?:活跃|回复)?/.test(text)) {
    return { status: 'recent', source: 'text', label: text }
  }
  const shortTimeMatch = text.match(
    /([0-9零一二两三四五六七八九十]+)(分钟|小时|钟头)前(?:活跃|回复)?/,
  )
  if (shortTimeMatch) {
    const amount = parseChineseInteger(shortTimeMatch[1])
    if (amount != null) {
      const unitMs = shortTimeMatch[2] === '分钟' ? 60 * 1000 : 60 * 60 * 1000
      const ageMs = amount * unitMs
      return {
        status: ageMs <= RECRUITER_ACTIVITY_WINDOW_MS ? 'recent' : 'stale',
        source: 'text',
        label: text,
        ageMs,
      }
    }
  }

  const dayMatch = text.match(/([0-9零一二两三四五六七八九十]+)(?:天|日)(前|以内|内)(?:活跃|回复)?/)
  if (dayMatch) {
    const days = parseChineseInteger(dayMatch[1])
    if (days != null) {
      return {
        status: days <= 7 ? 'recent' : 'stale',
        source: 'text',
        label: text,
        ageMs: days * 24 * 60 * 60 * 1000,
      }
    }
  }

  if (/上周|月|年/.test(text)) {
    return { status: 'stale', source: 'text', label: text }
  }
  return null
}

function normalizeTimestamp(value: unknown, now: number) {
  const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof numeric !== 'number' || !Number.isFinite(numeric) || numeric <= 0) return null
  const milliseconds = numeric < 100_000_000_000 ? numeric * 1000 : numeric
  if (milliseconds < earliestPlausibleTimestamp || milliseconds > now) {
    return null
  }
  return milliseconds
}

export function evaluateRecruiterActivity({
  activeText,
  activeTime,
  now = Date.now(),
}: RecruiterActivityInput): RecruiterActivityDecision {
  const normalizedNow = Number.isFinite(now) ? now : Date.now()
  const text = normalizeActivityText(activeText)
  const textDecision = classifyText(text)
  if (textDecision) return textDecision

  const timestamp = normalizeTimestamp(activeTime, normalizedNow)
  if (timestamp != null) {
    const ageMs = Math.max(0, normalizedNow - timestamp)
    return {
      status: ageMs <= RECRUITER_ACTIVITY_WINDOW_MS ? 'recent' : 'stale',
      source: 'timestamp',
      label: new Date(timestamp).toISOString(),
      ageMs,
    }
  }

  if (text) return { status: 'unknown', source: 'text', label: text }
  if (activeTime != null) {
    return { status: 'unknown', source: 'timestamp', label: '时间戳无效' }
  }
  return { status: 'unknown', source: 'missing', label: '无活跃信息' }
}
