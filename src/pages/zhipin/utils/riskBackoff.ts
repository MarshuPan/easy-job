/** 平台明确返回频率限制之后的自动退避记录。 */

export const riskBackoffKey = 'local:risk-backoff'
export const riskBackoffStorageTimeoutMs = 2000

export interface RiskDayRecord {
  date: string
  hits: number
  lastHitAt: number
}

export interface BackoffDecision {
  action: 'cool-down'
  coolDownMs: number
  message: string
}

/** 风控记账不能阻塞投递主链路，存储超时或拒绝时使用回退值。 */
export async function withRiskBackoffStorageTimeout<T>(
  operation: Promise<T>,
  fallback: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), riskBackoffStorageTimeoutMs)
      }),
    ])
  } catch {
    return fallback
  } finally {
    if (timer != null) clearTimeout(timer)
  }
}

/**
 * 冷却按 10 / 20 / 45 分钟递增并封顶。命中次数只是选择等待时长的证据，不能据此
 * 推导“今天永久停止”或擅自修改用户的每日目标。
 */
const coolDownMinutesByHit = [10, 20, 45]

export function decideRiskBackoff(hitsToday: number): BackoffDecision {
  const normalizedHits = Math.max(1, Math.floor(Number(hitsToday) || 1))
  const minutes = coolDownMinutesByHit[Math.min(normalizedHits, coolDownMinutesByHit.length) - 1]
  return {
    action: 'cool-down',
    coolDownMs: minutes * 60_000,
    message: `平台明确提示操作频繁，已暂停 ${minutes} 分钟，之后自动继续`,
  }
}

/** 跨天自动归零：昨天的命中不该压着今天。 */
export function readTodayRecord(stored: unknown, today: string): RiskDayRecord {
  if (stored == null || typeof stored !== 'object') return { date: today, hits: 0, lastHitAt: 0 }
  const record = stored as Record<string, unknown>
  if (record.date !== today) return { date: today, hits: 0, lastHitAt: 0 }
  const hits = Number(record.hits)
  return {
    date: today,
    hits: Number.isFinite(hits) && hits > 0 ? Math.floor(hits) : 0,
    lastHitAt: Number(record.lastHitAt) || 0,
  }
}
