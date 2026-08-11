import { describe, expect, it } from 'vitest'

import {
  decideRiskBackoff,
  getRiskAdjustedDailyLimit,
  readTodayRecord,
  riskDailyPenaltyPerHit,
  riskStopForTodayHits,
} from './riskBackoff'

describe('decideRiskBackoff', () => {
  it('cools down long enough to reset the pace curve', () => {
    // 停下来的收益不只是这段时间不发请求，还包括回来时节奏被重置成「刚开工」。
    // 冷却如果短于会话间隔阈值，回来还是接着那段已经被盯上的连续行为往下跑。
    const sessionGapMs = 8 * 60_000
    expect(decideRiskBackoff(1).coolDownMs).toBeGreaterThan(sessionGapMs)
  })

  it('backs off harder the second time', () => {
    expect(decideRiskBackoff(2).coolDownMs).toBeGreaterThan(decideRiskBackoff(1).coolDownMs)
  })

  it('stops for the day once hits keep coming', () => {
    // 同一天反复命中说明不是偶发抖动，继续试的期望收益是负的。
    expect(decideRiskBackoff(riskStopForTodayHits).action).toBe('stop-for-today')
    expect(decideRiskBackoff(riskStopForTodayHits + 5).action).toBe('stop-for-today')
  })

  it('never returns a cool-down of zero, which would just be a retry', () => {
    for (let hits = 1; hits < riskStopForTodayHits; hits++) {
      expect(decideRiskBackoff(hits).coolDownMs).toBeGreaterThan(0)
    }
  })
})

describe('getRiskAdjustedDailyLimit', () => {
  it('stops pushing towards the platform cap after a warning', () => {
    expect(getRiskAdjustedDailyLimit(150, 0)).toBe(150)
    expect(getRiskAdjustedDailyLimit(150, 1)).toBe(150 - riskDailyPenaltyPerHit)
    expect(getRiskAdjustedDailyLimit(150, 2)).toBe(150 - 2 * riskDailyPenaltyPerHit)
  })

  it('never goes negative', () => {
    expect(getRiskAdjustedDailyLimit(30, 5)).toBe(0)
  })
})

describe('readTodayRecord', () => {
  it('forgets yesterday, because yesterday should not hold today down', () => {
    expect(readTodayRecord({ date: '2026-08-05', hits: 3, lastHitAt: 1 }, '2026-08-06')).toEqual({
      date: '2026-08-06',
      hits: 0,
      lastHitAt: 0,
    })
  })

  it('keeps today', () => {
    expect(readTodayRecord({ date: '2026-08-06', hits: 2, lastHitAt: 99 }, '2026-08-06')).toEqual({
      date: '2026-08-06',
      hits: 2,
      lastHitAt: 99,
    })
  })

  it('survives junk in storage', () => {
    for (const junk of [null, undefined, 'x', 42, { date: '2026-08-06', hits: -3 }]) {
      expect(readTodayRecord(junk, '2026-08-06').hits).toBe(0)
    }
  })
})
