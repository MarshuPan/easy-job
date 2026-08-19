import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlerRefs = vi.hoisted(() => ({
  communicated: vi.fn(),
  sameCompany: vi.fn(),
  sameHr: vi.fn(),
  jobTitle: vi.fn(),
  goldHunter: vi.fn(),
  company: vi.fn(),
  salaryRange: vi.fn(),
  companySizeRange: vi.fn(),
  hrPosition: vi.fn(),
  jobAddress: vi.fn(),
  jobContent: vi.fn(),
  jobFriendStatus: vi.fn(),
  activityFilter: vi.fn(),
  amap: vi.fn(),
  aiFiltering: vi.fn(),
  greeting: vi.fn(),
  retryGreeting: vi.fn(),
}))

const handlesFactoryMock = vi.hoisted(() => vi.fn())
const acquireBossActionMock = vi.hoisted(() => vi.fn(async () => true))

vi.mock('@/utils/actionGateStore', () => ({
  // 闸门是基础设施，业务单测不该去跑真实存储；它自己的行为由 actionGate/actionGateStore 的单测覆盖。
  acquireBossAction: acquireBossActionMock,
  getCurrentPaceMultiplier: vi.fn(async () => 1),
  resetActionGate: vi.fn(async () => undefined),
}))

vi.mock('./handles', () => ({
  handles: handlesFactoryMock,
}))

import { JobCredentialExpiredError } from '@/types/deliverError'

import { createHandle } from './index'

describe('createHandle pipeline assembly', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
    acquireBossActionMock.mockImplementation(async () => true)
    handlesFactoryMock.mockReturnValue({
      communicated: () => handlerRefs.communicated,
      SameCompanyFilter: () => handlerRefs.sameCompany,
      SameHrFilter: () => handlerRefs.sameHr,
      jobTitle: () => handlerRefs.jobTitle,
      goldHunterFilter: () => handlerRefs.goldHunter,
      company: () => handlerRefs.company,
      salaryRange: () => handlerRefs.salaryRange,
      companySizeRange: () => handlerRefs.companySizeRange,
      hrPosition: () => handlerRefs.hrPosition,
      jobAddress: () => handlerRefs.jobAddress,
      jobContent: () => handlerRefs.jobContent,
      jobFriendStatus: () => handlerRefs.jobFriendStatus,
      activityFilter: () => handlerRefs.activityFilter,
      amap: () => handlerRefs.amap,
      aiFiltering: () => handlerRefs.aiFiltering,
      greeting: () => handlerRefs.greeting,
      retryGreeting: handlerRefs.retryGreeting,
    })
  })

  it('wires configured hard filters into the runtime pipeline in order', async () => {
    const { before, after, retryGreeting } = await createHandle()

    expect(after).toEqual([])
    expect(retryGreeting).toBe(handlerRefs.retryGreeting)

    // 岗位名/公司名/薪资范围/HR职位/岗位地址五个过滤器已移除：面板上没有入口，
    // 岗位方向的判断交给 JD 与简历的实时匹配，白名单式的关键词穷举不完还会误杀。
    expect(before).toHaveLength(12)
    expect(before[0]).toBe(handlerRefs.communicated)
    expect(before[1]).toBe(handlerRefs.sameCompany)
    expect(before[2]).toBe(handlerRefs.sameHr)
    expect(before[3]).toBe(handlerRefs.goldHunter)
    expect(before[4]).toBe(handlerRefs.companySizeRange)
    // 取详情这一步：它之前的都不需要详情，之后的都依赖详情
    expect(before[5]).toEqual(expect.any(Function))
    expect(before[6]).toBe(handlerRefs.jobContent)
    expect(before[7]).toBe(handlerRefs.jobFriendStatus)
    expect(before[8]).toBe(handlerRefs.activityFilter)
    expect(before[9]).toBe(handlerRefs.amap)
    expect(before[10]).toBe(handlerRefs.aiFiltering)
    expect(before[11]).toBe(handlerRefs.greeting)
  })

  it('refreshes job detail before every full delivery even when a card is already cached', async () => {
    const { before } = await createHandle()
    const getCard = vi.fn(async () => ({ postDescription: '最新 JD' }))
    const data = {
      card: { postDescription: '旧 JD' },
      fetchedAt: Date.now() - 2 * 60_000,
      getCard,
    }
    const ctx = { listData: data } as any

    await before[5]({ data } as any, ctx)

    expect(getCard).toHaveBeenCalledOnce()
    // 记一笔「这个岗位向 BOSS 要过详情」。投递节奏按请求算而不是按投递结果算，
    // 否则被过滤掉的岗位就是零等待，而它们每一个都已经发过这次请求了。
    expect(ctx.detailFetched).toBe(true)
    expect(ctx.trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detail: expect.objectContaining({ expired: false }),
          message: '投递前重新校验岗位详情与投递凭据',
          stage: '岗位时效',
        }),
      ]),
    )
  })

  // 这个用例原来断言的是「凭据 31 分钟了，记一句 stale:true，然后照发」——那正是真机上
  // 出事的那条路：BOSS 回一句含糊的「您的环境存在异常.」，被上层当成账号风控，整轮收工。
  it('does not spend a detail request on credentials BOSS will reject', async () => {
    const { before } = await createHandle()
    const getCard = vi.fn(async () => ({ postDescription: '最新 JD' }))
    const data = { fetchedAt: Date.now() - 31 * 60_000, getCard }
    const ctx = { listData: data } as any

    await expect(before[5]({ data } as any, ctx)).rejects.toBeInstanceOf(JobCredentialExpiredError)

    // 关键是「没发出去」：发了必然被拒，还白占一个闸门令牌。
    expect(getCard).not.toHaveBeenCalled()
    expect(ctx.detailFetched).toBeUndefined()
    expect(ctx.trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detail: expect.objectContaining({ expired: true }),
          stage: '岗位时效',
        }),
      ]),
    )
  })

  // 真机上凭据是在闸门里等老的：判断时 24.3 分钟，等了 222 秒之后发出去已经 28.1 分钟。
  // 时效必须按「请求真正发出的那一刻」算，否则限速本身就是在制造失败。
  it('measures credential age after the action gate, not before', async () => {
    const start = Date.now()
    const fetchedAt = start - 24 * 60_000
    // 进闸门时 24 分钟，还没过线；闸门里等掉 4 分钟，出来已经 28 分钟——真机上就是这么
    // 被推过去的（等了 222 秒）。判断写在闸门前面就永远看不到这 4 分钟。
    acquireBossActionMock.mockImplementationOnce(async () => {
      vi.spyOn(Date, 'now').mockReturnValue(start + 4 * 60_000)
      return true
    })

    const { before } = await createHandle()
    const getCard = vi.fn(async () => ({ postDescription: '最新 JD' }))
    const data = { fetchedAt, getCard }
    const ctx = { listData: data } as any

    await expect(before[5]({ data } as any, ctx)).rejects.toBeInstanceOf(JobCredentialExpiredError)
    expect(getCard).not.toHaveBeenCalled()
  })
})
