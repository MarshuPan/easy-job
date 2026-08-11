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
    ...overrides,
  }
}

describe('decideAcquisition', () => {
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

  it('prefers refilling in place over switching, even with a bigger gap elsewhere', () => {
    // 切换来源要走页面导航，代价远高于就地翻页。
    expect(
      decideAcquisition(input({ poolSizes: { group: 8, search: 2 }, currentSource: 'search' })),
    ).toMatchObject({ kind: 'prefetch-current', source: 'search' })
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
