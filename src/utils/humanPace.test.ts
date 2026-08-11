import { describe, expect, it } from 'vitest'

import { greetingSegmentDelayMs, sampleHumanDelayMs } from './humanPace'

/** Box-Muller 用两个均匀数：v=0.25 时 cos(2πv)=0，也就是正好抽到中位数。 */
function scriptedRandom(...values: number[]) {
  let index = 0
  return () => values[Math.min(index++, values.length - 1)]
}
const atMedian = () => scriptedRandom(0.5, 0.25)

describe('sampleHumanDelayMs', () => {
  it('centres on the typical value rather than the middle of a range', () => {
    // 这是均匀抖动最亏效率的地方：按区间取值会把均值抬到区间中点。
    expect(sampleHumanDelayMs(30_000, { p90Ms: 60_000 }, atMedian())).toBe(30_000)
  })

  it('puts most samples at or below the typical value', () => {
    // 重尾的形状：大多数很快，少数很慢。真人就是这样，而且平均下来更快。
    const samples = Array.from({ length: 2000 }, () =>
      sampleHumanDelayMs(30_000, { p90Ms: 60_000 }),
    )
    const atOrBelow = samples.filter((value) => value <= 30_000).length
    expect(atOrBelow / samples.length).toBeGreaterThan(0.45)
    expect(atOrBelow / samples.length).toBeLessThan(0.55)
  })

  it('keeps roughly nine in ten under the configured p90', () => {
    const samples = Array.from({ length: 2000 }, () =>
      sampleHumanDelayMs(30_000, { p90Ms: 60_000 }),
    )
    const under = samples.filter((value) => value <= 60_000).length
    expect(under / samples.length).toBeGreaterThan(0.85)
    expect(under / samples.length).toBeLessThan(0.94)
  })

  it('still produces a long tail, which is what a rectangle distribution cannot', () => {
    // 均匀抖动永远不会给出「偶尔特别久」，而那恰恰是真人会有的。
    const samples = Array.from({ length: 3000 }, () =>
      sampleHumanDelayMs(30_000, { p90Ms: 60_000 }),
    )
    expect(Math.max(...samples)).toBeGreaterThan(60_000)
  })

  it('never repeats one exact value, because equal intervals are the tell', () => {
    const samples = Array.from({ length: 200 }, () => sampleHumanDelayMs(45_000))
    expect(new Set(samples).size).toBeGreaterThan(150)
  })

  it('honours the floor and the cap', () => {
    expect(sampleHumanDelayMs(1000, { minMs: 5000 }, scriptedRandom(0.99, 0.5))).toBe(5000)
    expect(
      sampleHumanDelayMs(30_000, { maxMs: 40_000 }, scriptedRandom(0.01, 0.25)),
    ).toBeLessThanOrEqual(40_000)
  })
})

describe('greetingSegmentDelayMs', () => {
  it('waits longer for a longer segment, the way typing does', () => {
    const short = greetingSegmentDelayMs(10, 5, atMedian())
    const long = greetingSegmentDelayMs(120, 5, atMedian())
    expect(long).toBeGreaterThan(short)
  })

  it('follows the configured base interval', () => {
    expect(greetingSegmentDelayMs(40, 5, atMedian())).toBe(5000 + 40 * 45)
    expect(greetingSegmentDelayMs(40, 12, atMedian())).toBe(12_000 + 40 * 45)
  })

  it('never collapses back to sending segments together', () => {
    // 用户把基础值设成 0 也不能变成连发：这条路径原来就是 0 间隔，是最强的自动化特征。
    expect(greetingSegmentDelayMs(0, 0, atMedian())).toBeGreaterThanOrEqual(1500)
    expect(greetingSegmentDelayMs(1, 0, scriptedRandom(0.99, 0.5))).toBeGreaterThanOrEqual(1500)
  })

  it('caps a mistyped setting so the run does not look frozen', () => {
    expect(greetingSegmentDelayMs(200, 600, scriptedRandom(0.001, 0.25))).toBe(90_000)
  })
})
