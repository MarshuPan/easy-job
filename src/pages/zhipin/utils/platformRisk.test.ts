import { describe, expect, it } from 'vitest'

import { detectPlatformRisk, getPlatformRiskTexts } from './platformRisk'

describe('platform risk response normalization', () => {
  it('finds rate-limit signals in nested response fields', () => {
    expect(
      detectPlatformRisk({
        code: 1,
        zpData: { bizData: { dialog: { content: '操作过于频繁，请稍后再试' } } },
      }),
    ).toBe('rate-limited')
  })

  it('prioritizes the hard daily limit over the warning threshold', () => {
    expect(
      detectPlatformRisk({
        message: '您今天已与120位BOSS沟通',
        dialog: { content: '您今天已与150位BOSS沟通' },
      }),
    ).toBe('daily-limit-reached')
  })

  it('only inspects bounded diagnostic text fields', () => {
    expect(getPlatformRiskTexts({ unrelated: { value: '操作过于频繁' } })).toEqual([])
    expect(getPlatformRiskTexts({ message: '操作过于频繁' })).toEqual(['操作过于频繁'])
  })

  it('returns null for ordinary business errors', () => {
    expect(detectPlatformRisk({ code: 1, message: '岗位已下线' })).toBeNull()
  })
})
