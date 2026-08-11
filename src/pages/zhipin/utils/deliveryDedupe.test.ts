import { describe, expect, it } from 'vitest'

import {
  canPossiblyDeliver,
  createPoolAdmission,
  explainImpossibleDelivery,
  sameCompanyPoolQuota,
} from './deliveryDedupe'

const allOn = { sameCompany: true, sameHr: true, friendStatus: true }
const delivered = {
  companies: new Set(['brand-contacted']),
  bosses: new Set(['boss-contacted']),
}

describe('canPossiblyDeliver', () => {
  it('keeps a job from a company that has not been contacted', () => {
    expect(
      canPossiblyDeliver(
        { encryptBrandId: 'brand-new', encryptBossId: 'boss-new' },
        allOn,
        delivered,
      ),
    ).toBe(true)
  })

  it('drops a job whose company was already delivered to', () => {
    // 真机上一批 10 个岗位里 7 个是这种情况，其中 5 个来自同一家公司。
    expect(canPossiblyDeliver({ encryptBrandId: 'brand-contacted' }, allOn, delivered)).toBe(false)
  })

  it('drops a job whose HR was already contacted', () => {
    expect(canPossiblyDeliver({ encryptBossId: 'boss-contacted' }, allOn, delivered)).toBe(false)
  })

  it('drops a job the platform already marks as contacted', () => {
    expect(
      canPossiblyDeliver({ encryptBrandId: 'brand-new', contact: true }, allOn, delivered),
    ).toBe(false)
  })

  it('respects each switch being off', () => {
    // 用户关掉某条去重时，这里不能替他继续拦。
    expect(
      canPossiblyDeliver(
        { encryptBrandId: 'brand-contacted' },
        { ...allOn, sameCompany: false },
        delivered,
      ),
    ).toBe(true)
    expect(
      canPossiblyDeliver(
        { encryptBossId: 'boss-contacted' },
        { ...allOn, sameHr: false },
        delivered,
      ),
    ).toBe(true)
    expect(
      canPossiblyDeliver({ contact: true }, { ...allOn, friendStatus: false }, delivered),
    ).toBe(true)
  })

  it('keeps a job whose identifiers are missing rather than guessing', () => {
    // 预判只在信息明确时排除。少拦一个只是让它多占一会儿名额，
    // 处理岗位时的那道判定仍然是权威；误拦才是真的丢机会。
    expect(canPossiblyDeliver({}, allOn, delivered)).toBe(true)
    expect(canPossiblyDeliver({ encryptBrandId: '' }, allOn, delivered)).toBe(true)
    expect(canPossiblyDeliver({ encryptBossId: '' }, allOn, delivered)).toBe(true)
  })
})

describe('explainImpossibleDelivery', () => {
  it('gives the same reason the pipeline would give, because the job is marked with it', () => {
    // 预判命中会直接把岗位标成已过滤，用户在记录里看到的理由必须和真正走完流程时一致。
    expect(explainImpossibleDelivery({ contact: true }, allOn, delivered)).toBe('已经沟通过')
    expect(explainImpossibleDelivery({ encryptBrandId: 'brand-contacted' }, allOn, delivered)).toBe(
      '相同公司已投递',
    )
    expect(explainImpossibleDelivery({ encryptBossId: 'boss-contacted' }, allOn, delivered)).toBe(
      '相同hr已投递',
    )
    expect(explainImpossibleDelivery({ encryptBrandId: 'brand-new' }, allOn, delivered)).toBeNull()
  })
})

describe('createPoolAdmission', () => {
  const flood = (count: number, brandId = 'brand-flood') =>
    Array.from({ length: count }, (_, index) => ({
      encryptBrandId: brandId,
      encryptBossId: `boss-${index}`,
    }))

  it('caps how many jobs one company may take from the pool', () => {
    // 一家公司针对同一个岗位发 20 个 JD，全放进来就把整个池子的名额吃光，
    // 水位看着是满的，实际上能投出去的只有一个。
    const admit = createPoolAdmission({ settings: allOn, delivered, pooled: [] })
    const passed = flood(20).filter(admit)
    expect(passed).toHaveLength(sameCompanyPoolQuota)
  })

  it('counts jobs already in the pool so refills do not hand out the quota again', () => {
    // 补池是一页一页来的。名额如果每次从零算起，翻三页就进来三倍的同公司岗位。
    const admit = createPoolAdmission({
      settings: allOn,
      delivered,
      pooled: flood(sameCompanyPoolQuota),
    })
    expect(flood(5).filter(admit)).toHaveLength(0)
  })

  it('keeps the quota per company rather than across the page', () => {
    const admit = createPoolAdmission({ settings: allOn, delivered, pooled: [] })
    const passed = [...flood(5, 'brand-a'), ...flood(5, 'brand-b')].filter(admit)
    expect(passed).toHaveLength(sameCompanyPoolQuota * 2)
  })

  it('still drops jobs that can never be delivered, quota or not', () => {
    const admit = createPoolAdmission({ settings: allOn, delivered, pooled: [] })
    expect([{ encryptBrandId: 'brand-contacted' }].filter(admit)).toHaveLength(0)
  })

  it('does not limit jobs whose company is unknown', () => {
    // 认不出是哪家公司就不该凭猜测限量：宁可让它占个名额。
    const admit = createPoolAdmission({ settings: allOn, delivered, pooled: [] })
    expect(flood(10, '').filter(admit)).toHaveLength(10)
  })
})
