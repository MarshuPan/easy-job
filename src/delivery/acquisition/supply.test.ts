import { describe, expect, it } from 'vitest'

import { estimateSupplyPolicy, SupplyRefillSchedule } from './supply'

describe('supply planning', () => {
  it('plans more inventory for fast filtering than for complete AI processing', () => {
    const fast = estimateSupplyPolicy([1000, 1000, 1000, 70_000])
    const slow = estimateSupplyPolicy([70_000, 70_000, 70_000, 70_000])
    expect(fast.lowWaterMark).toBeGreaterThan(slow.lowWaterMark)
    expect(fast.targetSize).toBeGreaterThan(slow.targetSize)
    expect(fast.jobMs).toBe(18_250)
  })

  it('starts replenishing earlier when recent refills are slower', () => {
    const normal = estimateSupplyPolicy([30_000, 30_000, 30_000])
    const slow = estimateSupplyPolicy([30_000, 30_000, 30_000], [180_000, 180_000, 180_000])
    expect(slow.lowWaterMark).toBeGreaterThan(normal.lowWaterMark)
  })

  it('bounds inventory under rapid duplicates and rejects invalid samples', () => {
    const policy = estimateSupplyPolicy([0, 0, 0, Number.NaN, -100, Number.POSITIVE_INFINITY])
    expect(policy.targetSize).toBe(60)
    expect(policy.lowWaterMark).toBeLessThanOrEqual(policy.targetSize)
    expect(estimateSupplyPolicy([]).jobMs).toBe(70_000)
  })

  it('uses recent consumption instead of letting old slow jobs hide a duplicate streak', () => {
    const recent = Array.from({ length: 20 }, () => 1000)
    expect(estimateSupplyPolicy([300_000, ...recent])).toEqual(estimateSupplyPolicy(recent))
  })

  it('counts down while processing instead of restarting the wait at each checkpoint', () => {
    const schedule = new SupplyRefillSchedule()
    expect(schedule.schedule('task-a', 45_000, 1000)).toBe(46_000)
    expect(schedule.schedule('task-a', 45_000, 31_000)).toBe(46_000)
    expect(Math.max(0, schedule.getReadyAt('task-a')! - 61_000)).toBe(0)
    schedule.clear('task-a')
    expect(schedule.schedule('task-a', 45_000, 61_000)).toBe(106_000)
  })

  it('does not carry a refill countdown into a different task or account', () => {
    const schedule = new SupplyRefillSchedule()
    schedule.schedule('task-a', 45_000, 1000)
    expect(schedule.getReadyAt('task-b')).toBeUndefined()
    expect(schedule.schedule('task-b', 45_000, 61_000)).toBe(106_000)
  })
})
