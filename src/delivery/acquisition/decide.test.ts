import { describe, expect, it } from 'vitest'

import { decideAcquisition, type AcquisitionInput } from './decide'

function input(overrides: Partial<AcquisitionInput> = {}): AcquisitionInput {
  return {
    enabledSources: ['group', 'search'],
    poolSizes: { group: 50, search: 50 },
    targetPoolPlan: { group: 50, search: 50 },
    prefetchableSources: ['group', 'search'],
    currentSource: 'group',
    lowWaterMark: 20,
    warmupJustCompleted: false,
    readyBatchSize: 10,
    refillDue: true,
    ...overrides,
  }
}

describe('decideAcquisition', () => {
  it.each([1, 7])('processes %i remaining jobs while the refill countdown runs', (size) => {
    expect(
      decideAcquisition(
        input({
          poolSizes: { group: size, search: 0 },
          lowWaterMark: 8,
          readyBatchSize: size,
          refillDue: false,
        }),
      ),
    ).toEqual({ kind: 'process-batch' })
  })

  it('refills an empty pool without waiting for a ready batch', () => {
    expect(
      decideAcquisition(
        input({
          poolSizes: { group: 0, search: 0 },
          readyBatchSize: 0,
          refillDue: false,
        }),
      ),
    ).toMatchObject({ kind: 'prefetch-current' })
  })
  it('consumes the ready batch when both pools are full', () => {
    expect(decideAcquisition(input())).toEqual({ kind: 'process-batch' })
  })

  it('refills in place when the whole pool drops below low water', () => {
    expect(decideAcquisition(input({ poolSizes: { group: 5, search: 5 } }))).toEqual({
      kind: 'prefetch-current',
      source: 'group',
      trigger: 'low-water',
    })
  })

  it('refills the source with the largest gap first', () => {
    // 整池 17 < 低水位 20；group 缺 48、search 缺 35，应切到缺口更大的 group。
    expect(
      decideAcquisition(
        input({
          poolSizes: { group: 2, search: 15 },
          targetPoolPlan: { group: 50, search: 50 },
          prefetchableSources: ['group'],
          currentSource: 'search',
        }),
      ),
    ).toMatchObject({ kind: 'switch-source', source: 'group', trigger: 'low-water' })
  })

  it('switches to the source with the largest gap instead of staying on the current source', () => {
    // 当前来源是 search，但 group 距离软目标差 42、search 只差 30，应先补 group。
    expect(
      decideAcquisition(
        input({
          poolSizes: { group: 8, search: 20 },
          currentSource: 'search',
          readyBatchSize: 0,
        }),
      ),
    ).toMatchObject({ kind: 'switch-source', source: 'group', trigger: 'underfilled' })
  })

  it('stays on the current source when both sources are equally short', () => {
    // 切来源要多一次跳转，也就是多一次列表刷新；其他条件都一样时不值得。
    expect(
      decideAcquisition(input({ poolSizes: { group: 5, search: 5 }, currentSource: 'search' })),
    ).toMatchObject({ kind: 'prefetch-current', source: 'search', trigger: 'low-water' })
  })

  it('refills the source furthest below its ratio today, not the one with the emptier pool', () => {
    // 真机：设 50/50，今天求职期望已处理 24、搜索 0。该补搜索，哪怕求职期望池更空。
    expect(
      decideAcquisition(
        input({
          poolSizes: { group: 2, search: 3 },
          lowWaterMark: 8,
          currentSource: 'group',
          weights: { group: 50, search: 50 },
          processedBySource: { group: 24, search: 0 },
        }),
      ),
    ).toMatchObject({ kind: 'switch-source', source: 'search', trigger: 'low-water' })
  })

  it('does not trigger low-water refill right after a full warmup pass', () => {
    expect(
      decideAcquisition(input({ poolSizes: { group: 5, search: 5 }, warmupJustCompleted: true })),
    ).toEqual({ kind: 'process-batch' })
  })

  it('delivers the ready batch before topping an underfilled pool', () => {
    // 池子略浅可以边投边补；让用户看到进度停滞更糟。
    expect(
      decideAcquisition(input({ poolSizes: { group: 30, search: 50 }, readyBatchSize: 10 })),
    ).toEqual({ kind: 'process-batch' })
  })

  it('tops up an underfilled pool once no batch is ready', () => {
    expect(
      decideAcquisition(input({ poolSizes: { group: 30, search: 50 }, readyBatchSize: 0 })),
    ).toEqual({ kind: 'prefetch-current', source: 'group', trigger: 'underfilled' })
  })

  it('switches to the other source when the current one cannot be refilled', () => {
    expect(
      decideAcquisition(
        input({
          poolSizes: { group: 30, search: 30 },
          prefetchableSources: ['search'],
          currentSource: 'group',
          readyBatchSize: 0,
        }),
      ),
    ).toMatchObject({ kind: 'switch-source', source: 'search', trigger: 'underfilled' })
  })

  it('goes idle when every source is exhausted and nothing can be delivered', () => {
    expect(
      decideAcquisition(
        input({
          poolSizes: { group: 0, search: 0 },
          prefetchableSources: [],
          readyBatchSize: 0,
        }),
      ),
    ).toMatchObject({ kind: 'idle' })
  })

  it('still delivers what is left when no source can be refilled', () => {
    expect(
      decideAcquisition(
        input({
          poolSizes: { group: 3, search: 0 },
          prefetchableSources: [],
          readyBatchSize: 3,
        }),
      ),
    ).toEqual({ kind: 'process-batch' })
  })

  it('ignores a disabled source when judging low water', () => {
    // 只启用 group：不能因为 search 为空就判定整池低水位。
    expect(
      decideAcquisition(
        input({
          enabledSources: ['group'],
          poolSizes: { group: 50, search: 0 },
          prefetchableSources: ['group'],
        }),
      ),
    ).toEqual({ kind: 'process-batch' })
  })

  it('reports idle when no source is enabled at all', () => {
    expect(decideAcquisition(input({ enabledSources: [] }))).toMatchObject({ kind: 'idle' })
  })
})
