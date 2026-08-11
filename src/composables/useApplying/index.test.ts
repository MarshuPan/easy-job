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

vi.mock('@/utils/actionGateStore', () => ({
  // 闸门是基础设施，业务单测不该去跑真实存储；它自己的行为由 actionGate/actionGateStore 的单测覆盖。
  acquireBossAction: vi.fn(async () => true),
  getCurrentPaceMultiplier: vi.fn(async () => 1),
  resetActionGate: vi.fn(async () => undefined),
}))

vi.mock('./handles', () => ({
  handles: handlesFactoryMock,
}))

import { createHandle } from './index'

describe('createHandle pipeline assembly', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
      fetchedAt: Date.now() - 31 * 60_000,
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
          detail: expect.objectContaining({ stale: true }),
          message: '投递前重新校验岗位详情与投递凭据',
          stage: '岗位时效',
        }),
      ]),
    )
  })
})
