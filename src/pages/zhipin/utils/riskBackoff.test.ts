import { describe, expect, it, vi } from 'vitest'

import { decideRiskBackoff, readTodayRecord, withRiskBackoffStorageTimeout } from './riskBackoff'

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

  it('caps repeated warnings at 45 minutes without ending the day', () => {
    expect(decideRiskBackoff(3)).toMatchObject({ action: 'cool-down', coolDownMs: 45 * 60_000 })
    expect(decideRiskBackoff(20)).toMatchObject({ action: 'cool-down', coolDownMs: 45 * 60_000 })
  })

  it('never returns a cool-down of zero, which would just be a retry', () => {
    for (let hits = 1; hits <= 10; hits++) {
      expect(decideRiskBackoff(hits).coolDownMs).toBeGreaterThan(0)
    }
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

describe('withRiskBackoffStorageTimeout', () => {
  it('returns the fallback when storage never responds', async () => {
    vi.useFakeTimers()
    try {
      const pending = withRiskBackoffStorageTimeout(new Promise<never>(() => {}), 'fallback')
      await vi.advanceTimersByTimeAsync(2_000)
      await expect(pending).resolves.toBe('fallback')
    } finally {
      vi.useRealTimers()
    }
  })
})
