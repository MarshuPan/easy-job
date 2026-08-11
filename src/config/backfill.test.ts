import { describe, expect, it } from 'vitest'

import { backfillStoredConfigState } from './backfill'
import { createDefaultDeliverySettings, createDefaultStoredConfigState } from './defaults'
import { validateStoredConfigState } from './validate'

/** 造一份 0.9.36 时代的配置：结构完整，只是没有后来才加的那个字段。 */
function storedStateWithoutGreetingSegment() {
  const state = createDefaultStoredConfigState()
  const settings = createDefaultDeliverySettings()
  delete (settings.delivery.timing as unknown as Record<string, unknown>).greetingSegmentSeconds
  state.accountSettings['account-a'] = settings
  return state as unknown
}

describe('backfillStoredConfigState', () => {
  it('lets a config written before a field existed still load', () => {
    // 用户真机上就是这个：greetingSegmentSeconds 加在 0.9.37，之前存的配置里没有它，
    // 校验直接判损坏，面板起不来。加字段不该让老用户的扩展变砖。
    const stored = storedStateWithoutGreetingSegment()

    expect(() => validateStoredConfigState(stored)).toThrow()

    const repaired = backfillStoredConfigState(stored) as ReturnType<
      typeof createDefaultStoredConfigState
    >
    expect(() => validateStoredConfigState(repaired)).not.toThrow()
    expect(repaired.accountSettings['account-a'].delivery.timing.greetingSegmentSeconds).toBe(
      createDefaultDeliverySettings().delivery.timing.greetingSegmentSeconds,
    )
  })

  it('never overwrites a value the user already set', () => {
    // 补齐只能补「缺的」。要是顺手把已有的值也刷成默认，用户改过的节奏、开关会在某次
    // 升级后被静默还原——那比读不出来更难发现。
    const state = createDefaultStoredConfigState()
    const settings = createDefaultDeliverySettings()
    settings.delivery.timing.batchSize = 7
    settings.delivery.timing.batchRestMinutes = 0
    settings.filters.sameCompany = !settings.filters.sameCompany
    delete (settings.delivery.timing as unknown as Record<string, unknown>).greetingSegmentSeconds
    state.accountSettings['account-a'] = settings

    const repaired = backfillStoredConfigState(state) as ReturnType<
      typeof createDefaultStoredConfigState
    >
    const timing = repaired.accountSettings['account-a'].delivery.timing
    expect(timing.batchSize).toBe(7)
    // 0 是合法取值，不能被当成「没设置」而补成默认。
    expect(timing.batchRestMinutes).toBe(0)
    expect(repaired.accountSettings['account-a'].filters.sameCompany).toBe(false)
  })

  it('leaves a wrecked settings block to fail validation instead of silently replacing it', () => {
    // 缺字段是版本差异，整块坏了是真损坏。后者套上默认值等于把用户的配置悄悄换成空的，
    // 而且换完还校验通过——用户永远不知道自己的配置没了。
    const state = createDefaultStoredConfigState() as unknown as Record<string, unknown>
    ;(state.accountSettings as Record<string, unknown>)['account-a'] = 'corrupted'

    const repaired = backfillStoredConfigState(state) as Record<string, unknown>
    expect((repaired.accountSettings as Record<string, unknown>)['account-a']).toBe('corrupted')
    expect(() => validateStoredConfigState(repaired)).toThrow()
  })

  it('带着已移除过滤器字段的老配置仍然能加载', () => {
    // 校验用 exactKeys，多出来的键会被判成「未知字段」。删字段和加字段一样能把配置判成
    // 损坏，面板照样起不来——0.9.37 加 greetingSegmentSeconds 那次就是这个形态。
    // 所以移除一个过滤器必须配一次清理，方向和补齐正好相反。
    const state = createDefaultStoredConfigState()
    const settings = createDefaultDeliverySettings()
    const filters = settings.filters as unknown as Record<string, unknown>
    filters.salaryRange = { enabled: true, monthlyK: [10, 20, true] }
    filters.company = { enabled: true, mode: 'exclude', values: ['某公司'], options: [] }
    filters.hrPosition = { enabled: false, mode: 'include', values: [], options: [] }
    filters.jobAddress = { enabled: false, values: [], options: [] }
    filters.jobTitle = { enabled: true, mode: 'include', values: ['AI产品经理'], options: [] }
    state.accountSettings['account-a'] = settings

    const repaired = backfillStoredConfigState(state)

    expect(() => validateStoredConfigState(repaired)).not.toThrow()
    const cleaned = (repaired as ReturnType<typeof createDefaultStoredConfigState>).accountSettings[
      'account-a'
    ].filters as unknown as Record<string, unknown>
    for (const removed of ['salaryRange', 'company', 'hrPosition', 'jobAddress', 'jobTitle']) {
      expect(cleaned).not.toHaveProperty(removed)
    }
    // 还在用的过滤器不能被误删
    expect(cleaned).toHaveProperty('jobContent')
    expect(cleaned).toHaveProperty('companySizeRange')
  })

  it('replaces arrays wholesale rather than merging them item by item', () => {
    // 逐项合并数组会让默认值的尾巴混进用户的列表里，产生用户没配过的条目。
    const state = createDefaultStoredConfigState()
    const settings = createDefaultDeliverySettings()
    settings.filters.jobContent.values = ['只留这一个']
    state.accountSettings['account-a'] = settings

    const repaired = backfillStoredConfigState(state) as ReturnType<
      typeof createDefaultStoredConfigState
    >
    expect(repaired.accountSettings['account-a'].filters.jobContent.values).toEqual(['只留这一个'])
  })
})
