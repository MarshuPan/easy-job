/**
 * 风控命中之后怎么退。
 *
 * 原来的反应是「等 30 秒，单岗位间隔加 3 秒，接着投下一个」。这个方向是错的：
 * 被限流说明当前这一段的行为已经被判定成异常，而 30 秒之后接着投，等于拿后面的岗位
 * 去验证同一个判定——真人被提示「操作频繁」不会 30 秒后继续点，会走开一会儿。
 *
 * 所以退避要退在三件事上，而不是只退速度：
 *
 * 一、结束当前会话。冷却时间必须长于会话间隔阈值，这样曲线会重新从最快档算起——
 * 停下来的收益不只是这段时间不发请求，还包括回来之后节奏被重置成「刚开工」，
 * 而不是接着一段已经被盯上的连续行为往下跑。
 *
 * 二、下调当日额度。已经被提示过一次，就不该再往平台上限上顶。
 *
 * 三、次数升级。同一天里反复命中，说明不是偶发抖动而是行为本身有问题，
 * 这时候继续试的期望收益是负的，直接收工。
 */

export const riskBackoffKey = 'local:risk-backoff'

/** 当天累计命中到这个次数就不再重试，直接收工。 */
export const riskStopForTodayHits = 3

/** 每命中一次，当日额度砍掉这么多。 */
export const riskDailyPenaltyPerHit = 40

export interface RiskDayRecord {
  date: string
  hits: number
  lastHitAt: number
}

export interface BackoffDecision {
  action: 'cool-down' | 'stop-for-today'
  /** 冷却时长，stop-for-today 时为 0。 */
  coolDownMs: number
  message: string
}

/**
 * 冷却时长按命中次数递增。
 *
 * 第一次给 20 分钟：既远长于会话间隔阈值（8 分钟）足以重置曲线，也接近一个人
 * 被打断之后真的会离开多久。第二次翻倍，说明第一次的退让不够。
 */
const coolDownMinutesByHit = [20, 45]

export function decideRiskBackoff(hitsToday: number): BackoffDecision {
  if (hitsToday >= riskStopForTodayHits) {
    return {
      action: 'stop-for-today',
      coolDownMs: 0,
      message: `今日已第 ${hitsToday} 次触发频率限制，今天不再继续投递`,
    }
  }
  const minutes = coolDownMinutesByHit[Math.min(hitsToday, coolDownMinutesByHit.length) - 1]
  return {
    action: 'cool-down',
    coolDownMs: minutes * 60_000,
    message: `触发频率限制，已暂停 ${minutes} 分钟，之后自动继续`,
  }
}

/** 当日还能投多少个：基础额度减去已命中的惩罚。 */
export function getRiskAdjustedDailyLimit(baseLimit: number, hitsToday: number) {
  return Math.max(0, baseLimit - hitsToday * riskDailyPenaltyPerHit)
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
