import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  todayData,
  addLogTraceMock,
  amapDistanceMock,
  claimPendingGreetingForFallbackMock,
  commonState,
  currentUidState,
  enqueuePendingGreetingMock,
  getPendingGreetingMock,
  messageConstructorMock,
  logHydrateMock,
  openChatTabMock,
  recentAiGreetingsMock,
  removePendingGreetingMock,
  resolveAmapLocationMock,
  runBackgroundAiTaskMock,
  sendMessageMock,
  storageGetMock,
  storageSetMock,
} = vi.hoisted(() => {
  const sendMessageMock = vi.fn(() => 'MockChannel')
  const storageGetMock = vi.fn()
  const storageSetMock = vi.fn()
  return {
    // 与 createEmptyStatistics 的字段全集保持一致；beforeEach 会重置为 0。
    todayData: {
      date: '2026-08-04',
      success: 0,
      searchSuccess: 0,
      groupSuccess: 0,
      total: 0,
      jobContent: 0,
      aiFiltering: 0,
      companySizeRange: 0,
      activityFilter: 0,
      goldHunterFilter: 0,
      repeat: 0,
      amap: 0,
    } as Record<string, any>,
    addLogTraceMock: vi.fn(
      (data: any, stage: string, status: string, message: string, detail?: unknown) => {
        data.trace ??= []
        data.trace.push({ at: Date.now(), stage, status, message, detail })
      },
    ),
    amapDistanceMock: vi.fn(),
    claimPendingGreetingForFallbackMock: vi.fn(),
    commonState: { deliverStop: false },
    currentUidState: { value: 10001 as string | number | null },
    enqueuePendingGreetingMock: vi.fn(),
    getPendingGreetingMock: vi.fn(),
    messageConstructorMock: vi.fn(function () {
      return {
        send: sendMessageMock,
      }
    }),
    logHydrateMock: vi.fn(async () => undefined),
    openChatTabMock: vi.fn(),
    recentAiGreetingsMock: vi.fn(() => [] as any[]),
    removePendingGreetingMock: vi.fn(),
    resolveAmapLocationMock: vi.fn(),
    runBackgroundAiTaskMock: vi.fn(),
    sendMessageMock,
    storageGetMock,
    storageSetMock,
  }
})

const { requestBossDataMock } = vi.hoisted(() => ({
  requestBossDataMock: vi.fn(async () => ({
    data: { bossId: 1, encryptBossId: 'b', name: '宣先生' },
  })),
}))

vi.mock('./utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./utils')>()),
  requestBossData: requestBossDataMock,
}))

vi.mock('@/utils/actionGateStore', () => ({
  // 闸门是基础设施，业务单测不该去跑真实存储；它自己的行为由 actionGate/actionGateStore 的单测覆盖。
  acquireBossAction: vi.fn(async () => true),
  getCurrentPaceMultiplier: vi.fn(async () => 1),
  resetActionGate: vi.fn(async () => undefined),
}))

vi.mock('@/message', () => ({
  counter: {
    openChatTab: openChatTabMock,
    storageGet: storageGetMock,
    storageSet: storageSetMock,
  },
  runBackgroundAiTask: runBackgroundAiTaskMock,
}))

const confState = vi.hoisted(() => ({
  aiTaskTimeoutSeconds: 180,
  formData: {
    activityFilter: { value: false },
    aiFiltering: { enable: false, score: 70 },
    aiGreeting: {
      enable: true,
      messageCount: 3,
      targetTotalCharacters: 150,
      prompt: '默认招呼语要求',
    },
    amap: {
      enable: false,
      key: '',
      origins: '',
      straightDistance: 0,
      drivingDistance: 0,
      drivingDuration: 0,
      walkingDistance: 0,
      walkingDuration: 0,
    },
    companySize: { enable: false, value: [0, 0, false] },
    customGreeting: { enable: false, value: '' },
    delay: { messageSending: 1 },
    friendStatus: { value: false },
    goldHunterFilter: { value: false },
    jobContent: { enable: false, include: true, value: [] },
    sameCompanyFilter: { value: false },
    sameHrFilter: { value: false },
  },
}))

vi.mock('@/stores/conf', () => ({
  useConf: () => confState,
}))

vi.mock('@/stores/log', () => ({
  addLogTrace: addLogTraceMock,
  useLog: () => ({
    hydrate: logHydrateMock,
    recentAiGreetings: recentAiGreetingsMock,
  }),
}))

vi.mock('@/stores/user', () => ({
  useUser: () => ({
    getUserId: () => currentUidState.value,
  }),
}))

// 必须是完整的统计形状。曾经 mock 成 {}，于是 handles.ts 里 14 处
// `statistics.todayData.<field>++` 全部变成 undefined++ → NaN 且不报错，
// 所有筛选计数器因此完全没有覆盖。
vi.mock('@/composables/useStatistics', () => ({
  useStatistics: () => ({ todayData }),
}))

vi.mock('@/composables/useCommon', () => ({
  useCommon: () => commonState,
}))

vi.mock('@/composables/useWebSocket', () => ({
  Message: messageConstructorMock,
}))

vi.mock('@/composables/useWebSocket/pendingGreeting', () => ({
  claimPendingGreetingForFallback: claimPendingGreetingForFallbackMock,
  enqueuePendingGreeting: enqueuePendingGreetingMock,
  getPendingGreeting: getPendingGreetingMock,
  PENDING_GREETING_MAX_AGE_MS: 300_000,
  removePendingGreeting: removePendingGreetingMock,
}))

vi.mock('@/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}))

vi.mock('@/utils/amap', () => ({
  amapDistance: amapDistanceMock,
  resolveAmapLocation: resolveAmapLocationMock,
}))

import { AIFilteringError, AIProviderError } from '@/types/deliverError'
import { acquireBossAction } from '@/utils/actionGateStore'

import { getPendingGreetingWaitTimeoutMs, handles } from './handles'
import type { Handler } from './type'

function createJobData(): any {
  return {
    bossName: '宣先生',
    brandName: '黑湖科技',
    card: {
      bossName: '宣先生',
      brandName: '黑湖科技',
      cityName: '上海',
      degreeName: '本科',
      encryptJobId: 'job-1',
      encryptUserId: 'boss-user-1',
      experienceName: '5-10年',
      jobLabels: ['AI Agent'],
      jobName: 'AI产品经理',
      postDescription: '负责 AI Agent 产品',
      salaryDesc: '30-60K',
      securityId: 'security-1',
    },
    encryptJobId: 'job-1',
    jobName: 'AI产品经理',
    securityId: 'security-1',
    status: {
      setStatus: vi.fn(),
    },
  }
}

function createCtx() {
  const listData = createJobData()
  return {
    bossData: {
      data: {
        bossId: 20002,
        encryptBossId: 'boss-enc-1',
        name: '宣先生',
      },
      job: {
        jobName: 'AI产品经理',
      },
    },
    aiFilteringDecision: {
      matchPercent: 82,
      level: 'good',
      reason: '平台经验匹配',
      selectedFactIds: ['fact-agent-content'],
      claimMode: 'direct',
    },
    aiFilteringThreshold: 70,
    listData,
  } as any
}

function recentGreeting(primaryFactId: string) {
  return {
    sentAt: Date.now(),
    usedFactIds: [primaryFactId],
    openingPattern: 'history',
    messages: ['历史第一条', '历史第二条', '历史第三条'],
    fingerprint: '1234abcd',
  }
}

function createFilteringCtx() {
  const ctx = createCtx()
  ctx.aiFilteringDecision = undefined
  ctx.aiFilteringThreshold = undefined
  return ctx
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('useApplying handles greeting flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    commonState.deliverStop = false
    currentUidState.value = 10001
    document.body.replaceChildren()
    window.history.replaceState({}, '', '/web/geek/job')
    Object.assign(window, { _PAGE: { isGeekChat: false, uid: 10001 } })
    claimPendingGreetingForFallbackMock.mockReset()
    enqueuePendingGreetingMock.mockReset()
    getPendingGreetingMock.mockReset()
    openChatTabMock.mockReset()
    openChatTabMock.mockResolvedValue({ id: 1 })
    removePendingGreetingMock.mockReset()
    sendMessageMock.mockReset()
    sendMessageMock.mockReturnValue('MockChannel')
    runBackgroundAiTaskMock.mockResolvedValue({
      content: JSON.stringify({
        messages: [
          '宣老师您好，我是林小舟。我看到了这个 AI Agent 岗位。',
          '我有 Agent 产品和闭环经验。',
          '期待进一步沟通。',
        ],
        usedFactIds: ['fact-agent-content'],
        claimMode: 'direct',
        openingPattern: 'jd-hook',
      }),
      reasoning_content: 'reasoning',
    })
    confState.formData.aiFiltering.enable = false
    confState.formData.aiFiltering.score = 70
    confState.formData.aiGreeting.enable = true
    confState.formData.aiGreeting.messageCount = 3
    confState.formData.aiGreeting.targetTotalCharacters = 150
    confState.formData.activityFilter.value = false
    confState.formData.customGreeting.enable = false
    confState.formData.customGreeting.value = ''
    confState.formData.friendStatus.value = false
    confState.formData.sameCompanyFilter.value = false
    confState.formData.sameHrFilter.value = false
    confState.formData.amap.enable = false
    confState.formData.amap.key = ''
    confState.formData.amap.origins = ''
    confState.formData.amap.straightDistance = 0
    confState.formData.amap.drivingDistance = 0
    confState.formData.amap.drivingDuration = 0
    confState.formData.amap.walkingDistance = 0
    confState.formData.amap.walkingDuration = 0
    amapDistanceMock.mockReset()
    resolveAmapLocationMock.mockReset()
    recentAiGreetingsMock.mockReset()
    recentAiGreetingsMock.mockReturnValue([])
    logHydrateMock.mockClear()
    storageGetMock.mockReset()
    storageSetMock.mockReset()
  })

  it('migrates the legacy company list and allows three distinct jobs before limiting the company', async () => {
    confState.formData.sameCompanyFilter.value = true
    let storageState: unknown = { '10001': ['brand-a'] }
    storageGetMock.mockImplementation(async () => storageState)
    storageSetMock.mockImplementation(async (_key: string, value: unknown) => {
      storageState = value
      return true
    })
    const step = handles().SameCompanyFilter() as { fn: Handler; afterPublish: Handler }

    const jobs = ['job-2', 'job-3']
    for (const jobId of jobs) {
      const data = { ...createJobData(), encryptBrandId: 'brand-a', encryptJobId: jobId }
      await step.fn({ data }, createCtx())
      await step.afterPublish({ data }, createCtx())
    }

    const blocked = { ...createJobData(), encryptBrandId: 'brand-a', encryptJobId: 'job-4' }
    await expect(step.fn({ data: blocked }, createCtx())).rejects.toThrow(
      '同公司15天内已投递3个不同岗位',
    )
    expect(storageState).toEqual({
      '10001': [
        {
          brandId: 'brand-a',
          jobIds: ['job-2', 'job-3'],
          deliveredCount: 3,
          lastDeliveredAt: expect.any(Number),
        },
      ],
    })
  })

  it('blocks the same JD independently of the company allowance', async () => {
    confState.formData.sameCompanyFilter.value = true
    storageGetMock.mockResolvedValue({
      '10001': [
        {
          brandId: 'brand-a',
          jobIds: ['job-1'],
          deliveredCount: 1,
          lastDeliveredAt: Date.now(),
        },
      ],
    })
    const step = handles().SameCompanyFilter() as { fn: Handler }
    const data = { ...createJobData(), encryptBrandId: 'brand-a', encryptJobId: 'job-1' }

    await expect(step.fn({ data }, createCtx())).rejects.toThrow('相同JD已投递')
  })

  it('ends queue waiting before the pending greeting can expire', () => {
    expect(getPendingGreetingWaitTimeoutMs(600, 5)).toBe(290_000)
    expect(getPendingGreetingWaitTimeoutMs(20, 3)).toBe(105_000)
  })

  it('logs AI greeting generation boundaries before sending messages', async () => {
    const ctx = createCtx()
    const greetingStep = handles().greeting() as { after: Handler }

    await greetingStep.after({ data: ctx.listData }, ctx)

    expect(ctx.trace.map((item: any) => item.message)).toEqual(
      expect.arrayContaining([
        '开始生成AI招呼语，超时 180 秒',
        expect.stringContaining('AI招呼语已生成 3 条'),
        '准备发送第 1/3 条招呼语',
        '准备发送第 2/3 条招呼语',
        '准备发送第 3/3 条招呼语',
        'AI招呼语样本已记录，可用于后续复盘',
        'AI招呼语3条已全部发送',
      ]),
    )
    expect(runBackgroundAiTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: 'aiGreeting',
        timeout: 180,
      }),
    )
  })

  it('checks the stop flag before every greeting message', async () => {
    sendMessageMock.mockImplementationOnce(() => {
      commonState.deliverStop = true
      return 'MockChannel'
    })
    const ctx = createCtx()
    const greetingStep = handles().greeting() as { after: Handler }

    await expect(greetingStep.after({ data: ctx.listData }, ctx)).rejects.toThrow('用户已停止投递')

    expect(sendMessageMock).toHaveBeenCalledTimes(1)
    expect(ctx.greetingSend.messages).toEqual([
      expect.objectContaining({ index: 1, ok: true }),
      expect.objectContaining({
        index: 2,
        ok: false,
        error: expect.stringContaining('用户已停止'),
      }),
    ])
  })

  it('generates an AI greeting without a filtering decision when AI matching is disabled', async () => {
    const ctx = createCtx()
    ctx.aiFilteringDecision = undefined
    const greetingStep = handles().greeting() as { after: Handler }

    await greetingStep.after({ data: ctx.listData }, ctx)

    expect(runBackgroundAiTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: 'aiGreeting',
        data: expect.not.objectContaining({ filtering: expect.anything() }),
      }),
    )
    expect(ctx.greetingSend).toMatchObject({ ok: true, type: 'ai', messageCount: 3 })
  })

  it('sends zero text when AI greeting is disabled even if legacy custom text is enabled', async () => {
    confState.formData.aiGreeting.enable = false
    confState.formData.customGreeting.enable = true
    confState.formData.customGreeting.value = '不应发送的旧话术'
    const ctx = createCtx()
    const greetingStep = handles().greeting() as { after: Handler }

    await greetingStep.after({ data: ctx.listData }, ctx)

    expect(runBackgroundAiTaskMock).not.toHaveBeenCalled()
    expect(messageConstructorMock).not.toHaveBeenCalled()
    expect(ctx.message).toBeUndefined()
    expect(ctx.greetingSend).toEqual({
      ok: true,
      type: 'none',
      contentLength: 0,
      messageCount: 0,
      messages: [],
    })
  })

  it('rechecks AI greeting after the handler was created', async () => {
    const ctx = createCtx()
    const greetingStep = handles().greeting() as { after: Handler }
    confState.formData.aiGreeting.enable = false

    await greetingStep.after({ data: ctx.listData }, ctx)

    expect(runBackgroundAiTaskMock).not.toHaveBeenCalled()
    expect(messageConstructorMock).not.toHaveBeenCalled()
    expect(ctx.greetingSend).toMatchObject({ ok: true, type: 'none', messageCount: 0 })
  })

  it('does not send generated text when AI greeting is disabled during generation', async () => {
    const generated = createDeferred<{
      content: string
      reasoning_content: string
    }>()
    runBackgroundAiTaskMock.mockReturnValueOnce(generated.promise)
    const ctx = createCtx()
    const greetingStep = handles().greeting() as { after: Handler }
    const running = greetingStep.after({ data: ctx.listData }, ctx)
    await vi.waitFor(() => expect(runBackgroundAiTaskMock).toHaveBeenCalledOnce())

    confState.formData.aiGreeting.enable = false
    generated.resolve({
      content: JSON.stringify({
        messages: ['第一条', '第二条', '第三条'],
        usedFactIds: ['fact-agent-content'],
        claimMode: 'direct',
        openingPattern: 'jd-hook',
      }),
      reasoning_content: 'reasoning',
    })
    await running

    expect(messageConstructorMock).not.toHaveBeenCalled()
    expect(ctx.message).toBeUndefined()
    expect(ctx.aiGreetingMessages).toBeUndefined()
    expect(ctx.greetingSend).toMatchObject({ ok: true, type: 'none', messageCount: 0 })
  })

  it('stops remaining AI greeting messages when disabled after the first send', async () => {
    sendMessageMock.mockImplementationOnce(() => {
      confState.formData.aiGreeting.enable = false
      return 'MockChannel'
    })
    const ctx = createCtx()
    const greetingStep = handles().greeting() as { after: Handler }

    await greetingStep.after({ data: ctx.listData }, ctx)

    expect(sendMessageMock).toHaveBeenCalledOnce()
    expect(ctx.greetingSend).toMatchObject({
      ok: true,
      type: 'ai',
      messageCount: 1,
      messages: [expect.objectContaining({ index: 1, ok: true })],
    })
    expect(ctx.trace.map((item: any) => item.message)).toContain(
      'AI招呼语已关闭，已停止剩余文本；关闭前已发送 1 条',
    )
  })

  it('uses the communication-status switch for both list and detail relationship checks', async () => {
    expect(handles().communicated()).toBeUndefined()
    expect(handles().jobFriendStatus()).toBeUndefined()

    confState.formData.friendStatus.value = true
    const listStep = handles().communicated() as Handler
    const detailStep = handles().jobFriendStatus() as Handler
    const ctx = createCtx()
    ctx.listData.contact = true

    await expect(listStep({ data: ctx.listData }, ctx)).rejects.toThrow('已经沟通过')

    ctx.listData.contact = false
    ctx.listData.card.friendStatus = 1
    await expect(detailStep({ data: ctx.listData }, ctx)).rejects.toThrow('已经是好友了')
  })

  it('applies the strict recruiter activity decision in the delivery step', async () => {
    confState.formData.activityFilter.value = true
    const recent = createCtx()
    recent.listData.card.activeTimeDesc = '今日回复'
    const recentStep = handles().activityFilter() as Handler

    await expect(recentStep({ data: recent.listData }, recent)).resolves.toBeUndefined()

    const stale = createCtx()
    stale.listData.card.activeTimeDesc = '本月活跃'
    const staleStep = handles().activityFilter() as Handler

    await expect(staleStep({ data: stale.listData }, stale)).rejects.toThrow('招聘者超过7日未活跃')
  })

  it('does not run commute filtering even when legacy page state says it is enabled', () => {
    confState.formData.amap = {
      enable: true,
      key: 'amap-key',
      origins: '上海市静安区',
      straightDistance: 0,
      drivingDistance: 30,
      drivingDuration: 60,
      walkingDistance: 0,
      walkingDuration: 0,
    }

    expect(handles().amap()).toBeUndefined()
    expect(resolveAmapLocationMock).not.toHaveBeenCalled()
    expect(amapDistanceMock).not.toHaveBeenCalled()
  })

  it('stops a 69-point filtering result before greeting generation', async () => {
    confState.formData.aiFiltering.enable = true
    runBackgroundAiTaskMock.mockResolvedValue({
      content: JSON.stringify({
        matchPercent: 69,
        level: 'maybe',
        reason: '低于门槛',
        selectedFactIds: [],
      }),
    })
    const ctx = createFilteringCtx()
    const filteringStep = handles().aiFiltering() as Handler

    await expect(filteringStep({ data: ctx.listData }, ctx)).rejects.toThrow()

    expect(runBackgroundAiTaskMock).toHaveBeenCalledTimes(1)
    expect(runBackgroundAiTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'aiFiltering' }),
    )
    expect(ctx.aiFilteringDecision).toBeUndefined()
  })

  it('uses 60 exactly when the configured threshold is 60', async () => {
    confState.formData.aiFiltering.enable = true
    confState.formData.aiFiltering.score = 60
    runBackgroundAiTaskMock.mockResolvedValue({
      content: JSON.stringify({
        matchPercent: 60,
        level: 'maybe',
        reason: '达到当前门槛',
        selectedFactIds: ['fact-agent-content'],
        claimMode: 'direct',
      }),
    })
    const ctx = createFilteringCtx()
    const filteringStep = handles().aiFiltering() as Handler

    await filteringStep({ data: ctx.listData }, ctx)

    expect(ctx.aiFilteringDecision.claimMode).toBe('direct')
    expect(ctx.aiFilteringThreshold).toBe(60)
    // 阈值记在 ctx 上用于判定，但不能进发给模型的数据。模型一旦知道门槛在哪，就会先决定
    // 「投不投」再倒推一个刚好卡在线上或线下的分数，分值本身就失去了意义——用户在真机上
    // 看到的正是这个：改阈值不改变结果。
    const payload = runBackgroundAiTaskMock.mock.calls.at(-1)?.[0]
    expect(payload.task).toBe('aiFiltering')
    expect(payload.data).not.toHaveProperty('filteringThreshold')
  })

  it('skips one job when the model returns an unusable result, instead of ending the run', async () => {
    // 真机上「储能技术总工」这种和候选人毫不相关的岗位让模型给出了不合法的输出，请求本身
    // 200、有 token 产出，整轮投递却在第 4 个岗位停了。一个岗位的坏输出不该连累其余几十个。
    confState.formData.aiFiltering.enable = true
    const invalid = new Error('后台AI响应格式异常')
    invalid.name = 'AI_TASK_RESPONSE_INVALID'
    runBackgroundAiTaskMock.mockRejectedValue(invalid)
    const ctx = createFilteringCtx()
    const filteringStep = handles().aiFiltering() as Handler

    await expect(filteringStep({ data: ctx.listData }, ctx)).rejects.toThrow(AIFilteringError)
  })

  it('still ends the run when the model service itself is unavailable', async () => {
    // 反过来，超时/限流/鉴权/HTTP 错误换个岗位结果一样，继续跑只是把剩下的岗位一个个撞死，
    // 这种才该停。
    for (const name of [
      'AI_TASK_TIMEOUT',
      'AI_TASK_RATE_LIMITED',
      'AI_TASK_AUTH_FAILED',
      'AI_TASK_HTTP_FAILED',
    ]) {
      confState.formData.aiFiltering.enable = true
      const outage = new Error(`服务故障 ${name}`)
      outage.name = name
      runBackgroundAiTaskMock.mockRejectedValue(outage)
      const ctx = createFilteringCtx()
      const filteringStep = handles().aiFiltering() as Handler

      await expect(filteringStep({ data: ctx.listData }, ctx)).rejects.toThrow(AIProviderError)
    }
  })

  it('sends the job detail card once without duplicating runtime-only list fields', async () => {
    confState.formData.aiFiltering.enable = true
    runBackgroundAiTaskMock.mockResolvedValue({
      content: JSON.stringify({
        matchPercent: 80,
        level: 'good',
        reason: '岗位相关',
        selectedFactIds: ['fact-agent-content'],
        claimMode: 'direct',
      }),
    })
    const ctx = createFilteringCtx()
    ctx.listData.getCard = vi.fn()
    const filteringStep = handles().aiFiltering() as Handler

    await filteringStep({ data: ctx.listData }, ctx)

    const request = runBackgroundAiTaskMock.mock.calls[0]?.[0]
    expect(request.data.card).toEqual(ctx.listData.card)
    expect(request.data.data).not.toHaveProperty('card')
    expect(request.data.data).not.toHaveProperty('status')
    expect(request.data.data).not.toHaveProperty('getCard')
  })

  it('falls back to the public 60-point threshold when a legacy score is missing', async () => {
    confState.formData.aiFiltering.enable = true
    confState.formData.aiFiltering.score = undefined as unknown as number
    runBackgroundAiTaskMock.mockResolvedValue({
      content: JSON.stringify({
        matchPercent: 60,
        level: 'maybe',
        reason: '达到公共默认门槛',
        selectedFactIds: ['fact-agent-content'],
        claimMode: 'direct',
      }),
    })
    const ctx = createFilteringCtx()
    const filteringStep = handles().aiFiltering() as Handler

    await filteringStep({ data: ctx.listData }, ctx)

    // 这条测的是缺省回退到 60，不是阈值怎么传。判定用的仍是 ctx 上这一份快照。
    expect(ctx.aiFilteringThreshold).toBe(60)
    expect(runBackgroundAiTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'aiFiltering' }),
    )
  })

  it('keeps one threshold snapshot while an AI filtering request is in flight', async () => {
    confState.formData.aiFiltering.enable = true
    confState.formData.aiFiltering.score = 60
    const response = createDeferred<{ content: string }>()
    runBackgroundAiTaskMock.mockReturnValueOnce(response.promise)
    const ctx = createFilteringCtx()
    const filteringStep = handles().aiFiltering() as Handler

    const filtering = filteringStep({ data: ctx.listData }, ctx)
    await vi.waitFor(() => expect(runBackgroundAiTaskMock).toHaveBeenCalledTimes(1))
    confState.formData.aiFiltering.score = 80
    response.resolve({
      content: JSON.stringify({
        matchPercent: 60,
        level: 'maybe',
        reason: '达到启动时门槛',
        selectedFactIds: ['fact-agent-content'],
        claimMode: 'direct',
      }),
    })

    await expect(filtering).resolves.toBeUndefined()
    expect(ctx.aiFilteringThreshold).toBe(60)
    expect(ctx.aiFilteringDecision.claimMode).toBe('direct')
  })

  it.each([
    [70, 69],
    [80, 79],
  ])('stops a score below configured threshold %s', async (threshold, matchPercent) => {
    confState.formData.aiFiltering.enable = true
    confState.formData.aiFiltering.score = threshold
    runBackgroundAiTaskMock.mockResolvedValue({
      content: JSON.stringify({
        matchPercent,
        level: 'good',
        reason: '低于当前门槛',
        selectedFactIds: [],
      }),
    })
    const ctx = createFilteringCtx()
    const filteringStep = handles().aiFiltering() as Handler

    await expect(filteringStep({ data: ctx.listData }, ctx)).rejects.toThrow()
  })

  it.each([
    [70, 'direct'],
    [80, 'adjacent'],
  ] as const)(
    'stores the backend %s-point decision with %s claim mode',
    async (matchPercent, claimMode) => {
      confState.formData.aiFiltering.enable = true
      confState.formData.aiFiltering.score = matchPercent
      runBackgroundAiTaskMock.mockResolvedValue({
        content: JSON.stringify({
          matchPercent,
          level: 'good',
          reason: '岗位相关',
          selectedFactIds: ['fact-agent-content'],
          claimMode,
        }),
      })
      const ctx = createFilteringCtx()
      const filteringStep = handles().aiFiltering() as Handler

      await filteringStep({ data: ctx.listData }, ctx)

      expect(ctx.aiFilteringDecision).toEqual({
        matchPercent,
        level: 'good',
        reason: '岗位相关',
        risk: undefined,
        selectedFactIds: ['fact-agent-content'],
        claimMode,
      })
    },
  )

  it('does not reject a passing job when its only fact was used in recent greetings', async () => {
    confState.formData.aiFiltering.enable = true
    recentAiGreetingsMock.mockReturnValue([
      recentGreeting('fact-agent-content'),
      recentGreeting('fact-agent-content'),
    ])
    runBackgroundAiTaskMock.mockResolvedValue({
      content: JSON.stringify({
        matchPercent: 80,
        level: 'good',
        reason: '岗位相关',
        selectedFactIds: ['fact-agent-content'],
        claimMode: 'direct',
      }),
    })
    const ctx = createFilteringCtx()
    const filteringStep = handles().aiFiltering() as Handler

    await expect(filteringStep({ data: ctx.listData }, ctx)).resolves.toBeUndefined()
    expect(ctx.aiFilteringDecision.selectedFactIds).toEqual(['fact-agent-content'])
  })

  it('preserves selected fact order for the user-defined writing prompt', async () => {
    confState.formData.aiFiltering.enable = true
    recentAiGreetingsMock.mockReturnValue([
      recentGreeting('fact-agent-content'),
      recentGreeting('fact-agent-content'),
    ])
    runBackgroundAiTaskMock.mockResolvedValue({
      content: JSON.stringify({
        matchPercent: 80,
        level: 'good',
        reason: '岗位相关',
        selectedFactIds: ['fact-agent-content', 'fact-b2b-saas'],
        claimMode: 'direct',
      }),
    })
    const ctx = createFilteringCtx()
    const filteringStep = handles().aiFiltering() as Handler

    await filteringStep({ data: ctx.listData }, ctx)

    expect(ctx.aiFilteringDecision.selectedFactIds).toEqual(['fact-agent-content', 'fact-b2b-saas'])
  })

  it('sends the stored filtering context and recent history to greeting generation', async () => {
    const recent = [recentGreeting('fact-other')]
    recentAiGreetingsMock.mockReturnValue(recent)
    const ctx = createCtx()
    confState.formData.aiFiltering.score = 80
    const greetingStep = handles().greeting() as { after: Handler }

    await greetingStep.after({ data: ctx.listData }, ctx)

    expect(logHydrateMock).toHaveBeenCalled()
    expect(runBackgroundAiTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: 'aiGreeting',
        data: expect.objectContaining({
          filteringThreshold: ctx.aiFilteringThreshold,
          filtering: ctx.aiFilteringDecision,
          recentGreetings: recent,
        }),
      }),
    )
  })

  it('persists parsed greeting metadata on the delivery context', async () => {
    const ctx = createCtx()
    const greetingStep = handles().greeting() as { after: Handler }

    await greetingStep.after({ data: ctx.listData }, ctx)

    expect(ctx.aiGreetingMeta).toEqual({
      usedFactIds: ['fact-agent-content'],
      claimMode: 'direct',
      openingPattern: 'jd-hook',
      fingerprint: expect.stringMatching(/^[0-9a-f]{8}$/),
    })
  })

  it('refetches the job detail when a greeting resend has no card', async () => {
    // 真机上这里崩了：card 是运行时字段，持久化存不住；续发从投递记录恢复、岗位又不在当前页
    // 时就没有 card，而续发走 greetingOnly，取详情那一步整个跳过。原来用 `ctx.listData.card!`
    // 直接传下去，requestBossData 读 card.encryptUserId 就抛 TypeError——连崩三次，三次续发
    // 机会全废，沟通额度已经花掉、招呼语始终没发出去。
    const ctx = createCtx()
    ctx.bossData = undefined
    ctx.publish = { ok: true, attempts: 1 }
    ctx.greetingSend = { ok: false, type: 'ai', error: '后台AI任务超时 180s' }
    const refetched = { ...createJobData().card }
    ctx.listData.card = undefined
    ctx.listData.getCard = vi.fn(async () => {
      ctx.listData.card = refetched
      return refetched
    })
    requestBossDataMock.mockClear()

    await handles().retryGreeting({ data: ctx.listData }, ctx)

    expect(ctx.listData.getCard).toHaveBeenCalledTimes(1)
    // 补详情是一次真实的详情请求，BOSS 那边看到的和正常投递的那次没区别，必须过闸门。
    expect(acquireBossAction).toHaveBeenCalledWith('detail', expect.anything())
    expect(requestBossDataMock).toHaveBeenCalledWith(refetched, undefined, 3, expect.any(Function))
  })

  it('fails the resend with a clear reason when the detail is gone for good', async () => {
    // 取不到详情要给出能看懂的原因，不能再变成 TypeError。
    const ctx = createCtx()
    ctx.bossData = undefined
    ctx.publish = { ok: true, attempts: 1 }
    ctx.greetingSend = { ok: false, type: 'ai', error: '后台AI任务超时 180s' }
    ctx.listData.card = undefined
    ctx.listData.getCard = vi.fn(async () => null)

    await expect(handles().retryGreeting({ data: ctx.listData }, ctx)).rejects.toThrow(
      '岗位详情已失效，无法补齐BOSS沟通数据',
    )
  })

  it('does not spend a detail request when the card is already there', async () => {
    // 正常投递路径上 card 就在手边，不能顺手多打一次详情——那是最紧的一类配额。
    const ctx = createCtx()
    ctx.bossData = undefined
    ctx.publish = { ok: true, attempts: 1 }
    ctx.greetingSend = { ok: false, type: 'ai', error: '后台AI任务超时 180s' }
    ctx.listData.getCard = vi.fn(async () => ctx.listData.card)

    await handles().retryGreeting({ data: ctx.listData }, ctx)

    expect(ctx.listData.getCard).not.toHaveBeenCalled()
  })

  it('regenerates AI greeting content when greeting retry has no saved messages', async () => {
    const ctx = createCtx()
    ctx.publish = { ok: true, attempts: 1 }
    ctx.greetingSend = { ok: false, type: 'ai', error: '后台AI任务超时 180s' }
    const retryGreeting = handles().retryGreeting

    await retryGreeting({ data: ctx.listData }, ctx)

    expect(runBackgroundAiTaskMock).toHaveBeenCalledTimes(1)
    expect(ctx.aiGreetingMessages).toHaveLength(3)
    expect(ctx.greetingSend).toMatchObject({
      ok: true,
      messageCount: 3,
      type: 'ai',
    })
    expect(ctx.trace.map((item: any) => item.message)).toEqual(
      expect.arrayContaining(['没有可续发的招呼语内容，重新生成AI招呼语']),
    )
  })

  it('discards complete legacy AI messages without metadata and regenerates them', async () => {
    const ctx = createCtx()
    ctx.aiGreetingMessages = ['旧第一条', '旧第二条', '旧第三条']
    ctx.aiGreetingMeta = undefined
    ctx.greetingSend = { ok: false, type: 'ai', messages: [] }
    const retryGreeting = handles().retryGreeting

    await retryGreeting({ data: ctx.listData }, ctx)

    expect(runBackgroundAiTaskMock).toHaveBeenCalledTimes(1)
    expect(ctx.aiGreetingMessages).not.toContain('旧第一条')
    expect(ctx.aiGreetingMeta).toBeDefined()
  })

  it('stops legacy AI partial resend when quality metadata is missing', async () => {
    const ctx = createCtx()
    ctx.aiGreetingMessages = ['旧第一条', '旧第二条', '旧第三条']
    ctx.aiGreetingMeta = undefined
    ctx.greetingSend = {
      ok: false,
      type: 'ai',
      messages: [{ index: 1, ok: true, content: '旧第一条', contentLength: 4 }],
    }
    const retryGreeting = handles().retryGreeting

    await expect(retryGreeting({ data: ctx.listData }, ctx)).rejects.toThrow(
      '旧招呼语缺少质量元数据，停止自动补发',
    )

    expect(runBackgroundAiTaskMock).not.toHaveBeenCalled()
    expect(messageConstructorMock).not.toHaveBeenCalled()
  })

  it('preserves index-aware resend when AI quality metadata exists', async () => {
    const ctx = createCtx()
    ctx.aiGreetingMessages = ['第一条', '第二条', '第三条']
    ctx.aiGreetingMeta = {
      usedFactIds: ['fact-agent-content'],
      claimMode: 'direct',
      openingPattern: 'jd-hook',
      fingerprint: '1234abcd',
    }
    ctx.greetingSend = {
      ok: false,
      type: 'ai',
      messages: [{ index: 1, ok: true, content: '第一条', contentLength: 3 }],
    }
    const retryGreeting = handles().retryGreeting

    await retryGreeting({ data: ctx.listData }, ctx)

    expect(runBackgroundAiTaskMock).not.toHaveBeenCalled()
    const sentContents = (
      messageConstructorMock.mock.calls as unknown as Array<[{ content: string }]>
    ).map((call) => call[0].content)
    expect(sentContents).toEqual(['第二条', '第三条'])
    expect(ctx.greetingSend).toMatchObject({ ok: true, messageCount: 3, type: 'ai' })
  })

  it('cancels DOM fallback when the queue consumer wins the atomic claim', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'))
    window.history.replaceState({}, '', '/web/geek/chat')
    Object.assign(window, { _PAGE: { isGeekChat: true, uid: 10001 } })

    const input = document.createElement('div')
    input.className = 'chat-input'
    input.contentEditable = 'true'
    input.getBoundingClientRect = () => ({
      bottom: 30,
      height: 20,
      left: 10,
      right: 210,
      toJSON: () => ({}),
      top: 10,
      width: 200,
      x: 10,
      y: 10,
    })
    const sendButton = document.createElement('button')
    sendButton.textContent = '发送'
    sendButton.getBoundingClientRect = input.getBoundingClientRect
    sendButton.click = vi.fn()
    document.body.append(input, sendButton)

    const pending = {
      id: 'pending-race',
      brandName: '测试公司',
      content: '您好',
      createdAt: Date.now(),
      fromUid: '10001',
      jobName: 'AI 产品经理',
      toName: '宣先生',
      toUid: '20002',
      type: 'ai' as const,
    }
    sendMessageMock.mockImplementation(() => {
      throw new Error('WebSocket unavailable')
    })
    enqueuePendingGreetingMock.mockResolvedValue(pending)
    getPendingGreetingMock.mockResolvedValue(pending)
    claimPendingGreetingForFallbackMock.mockResolvedValue(undefined)

    const ctx = createCtx()
    ctx.aiGreetingMessages = ['您好']
    ctx.aiGreetingMeta = {
      usedFactIds: ['fact-agent-content'],
      claimMode: 'direct',
      openingPattern: 'jd-hook',
      fingerprint: '1234abcd',
    }
    ctx.greetingSend = { ok: false, type: 'ai', messages: [] }
    const continuation = handles().retryGreeting({ data: ctx.listData }, ctx)

    try {
      await vi.advanceTimersByTimeAsync(90_000)
      await expect(continuation).resolves.toBeUndefined()
      expect(claimPendingGreetingForFallbackMock).toHaveBeenCalledWith('pending-race', 10001)
      expect(sendButton.click).not.toHaveBeenCalled()
      expect(removePendingGreetingMock).not.toHaveBeenCalled()
      expect(ctx.greetingSend).toMatchObject({ ok: true, channel: 'ChatWebsocket' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks a queue handoff as result unknown instead of sending the greeting again', async () => {
    const pending = {
      id: 'pending-uncertain',
      brandName: '测试公司',
      content: '您好',
      createdAt: Date.now(),
      fromUid: '10001',
      jobName: 'AI 产品经理',
      status: {
        stage: 'sending' as const,
        reason: '发送通道已接管消息',
        observedAt: Date.now(),
      },
      toName: '宣先生',
      toUid: '20002',
      type: 'ai' as const,
    }
    sendMessageMock.mockImplementation(() => {
      throw new Error('WebSocket unavailable')
    })
    enqueuePendingGreetingMock.mockResolvedValue(pending)
    getPendingGreetingMock.mockResolvedValue(pending)

    const ctx = createCtx()
    ctx.aiGreetingMessages = ['您好']
    ctx.aiGreetingMeta = {
      usedFactIds: ['fact-agent-content'],
      claimMode: 'direct',
      openingPattern: 'jd-hook',
      fingerprint: '1234abcd',
    }
    ctx.greetingSend = { ok: false, type: 'ai', messages: [] }

    await expect(handles().retryGreeting({ data: ctx.listData }, ctx)).rejects.toThrow(
      '招呼语发送结果不确定，请人工核对后再处理',
    )

    expect(claimPendingGreetingForFallbackMock).not.toHaveBeenCalled()
    expect(ctx.greetingSend).toMatchObject({
      ok: false,
      detail: { confirmed: false, pendingId: pending.id, resultUnknown: true },
    })
  })

  it('marks the result unknown when a queued greeting cannot be removed', async () => {
    const pending = {
      id: 'pending-remove-failed',
      brandName: '测试公司',
      content: '您好',
      createdAt: Date.now(),
      fromUid: '10001',
      jobName: 'AI 产品经理',
      toName: '宣先生',
      toUid: '20002',
      type: 'ai' as const,
    }
    sendMessageMock.mockImplementation(() => {
      throw new Error('WebSocket unavailable')
    })
    enqueuePendingGreetingMock.mockResolvedValue(pending)
    openChatTabMock.mockRejectedValue(new Error('聊天页打开失败'))
    removePendingGreetingMock.mockRejectedValue(new Error('storage unavailable'))

    const ctx = createCtx()
    ctx.aiGreetingMessages = ['您好']
    ctx.aiGreetingMeta = {
      usedFactIds: ['fact-agent-content'],
      claimMode: 'direct',
      openingPattern: 'jd-hook',
      fingerprint: '1234abcd',
    }
    ctx.greetingSend = { ok: false, type: 'ai', messages: [] }

    await expect(handles().retryGreeting({ data: ctx.listData }, ctx)).rejects.toThrow(
      '招呼语发送结果不确定，请人工核对后再处理',
    )

    expect(removePendingGreetingMock).toHaveBeenCalledWith(pending.id, 10001)
    expect(ctx.greetingSend).toMatchObject({
      ok: false,
      detail: { confirmed: false, pendingId: pending.id, resultUnknown: true },
    })
  })

  it('stops a queued greeting continuation when the active account changes while waiting', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'))
    window.history.replaceState({}, '', '/web/geek/chat')
    Object.assign(window, { _PAGE: { isGeekChat: true, uid: 10001 } })

    const input = document.createElement('div')
    input.className = 'chat-input'
    input.contentEditable = 'true'
    input.getBoundingClientRect = () => ({
      bottom: 30,
      height: 20,
      left: 10,
      right: 210,
      toJSON: () => ({}),
      top: 10,
      width: 200,
      x: 10,
      y: 10,
    })
    const sendButton = document.createElement('button')
    sendButton.textContent = '发送'
    sendButton.getBoundingClientRect = input.getBoundingClientRect
    sendButton.click = vi.fn()
    document.body.append(input, sendButton)

    const pending = {
      id: 'pending-a',
      brandName: '测试公司',
      content: '您好',
      createdAt: Date.now(),
      fromUid: '10001',
      jobName: 'AI 产品经理',
      toName: '宣先生',
      toUid: '20002',
      type: 'custom' as const,
    }
    let releasePendingRead!: (value: typeof pending) => void
    const deferredPendingRead = new Promise<typeof pending>((resolve) => {
      releasePendingRead = resolve
    })
    sendMessageMock.mockImplementation(() => {
      throw new Error('WebSocket unavailable')
    })
    enqueuePendingGreetingMock.mockResolvedValue(pending)
    getPendingGreetingMock.mockReturnValueOnce(deferredPendingRead).mockResolvedValue(pending)
    removePendingGreetingMock.mockResolvedValue(true)

    const ctx = createCtx()
    ctx.aiGreetingMessages = ['您好']
    ctx.greetingSend = { ok: false, type: 'custom' }
    const continuation = handles().retryGreeting({ data: ctx.listData }, ctx)
    const continuationError = continuation.catch((error) => error)
    for (let index = 0; index < 10 && getPendingGreetingMock.mock.calls.length === 0; index++) {
      await Promise.resolve()
    }
    expect(getPendingGreetingMock).toHaveBeenCalledOnce()

    currentUidState.value = 20002
    Object.assign(window, { _PAGE: { isGeekChat: true, uid: 20002 } })
    releasePendingRead(pending)

    try {
      await vi.advanceTimersByTimeAsync(100_000)
      expect(sendButton.click).not.toHaveBeenCalled()
      expect(removePendingGreetingMock).not.toHaveBeenCalled()
      await expect(continuationError).resolves.toMatchObject({
        message: expect.stringContaining('账号已切换'),
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * 过滤计数器驱动了投递看板的归因展示和运行周期摘要里的 hardFiltered 汇总，
 * 但在此之前完全没有覆盖：useStatistics 曾被 mock 成 { todayData: {} }，
 * 于是每一处 `statistics.todayData.<field>++` 都是 undefined++ → NaN 且不报错。
 * 下面的用例逐个钉住「触发该过滤时，且仅有对应计数器 +1」。
 */
describe('useApplying handles filter statistics', () => {
  const counterFields = [
    'jobContent',
    'companySizeRange',
    'activityFilter',
    'goldHunterFilter',
    'aiFiltering',
    'repeat',
    'amap',
  ] as const

  beforeEach(() => {
    vi.clearAllMocks()
    commonState.deliverStop = false
    for (const field of counterFields) todayData[field] = 0
    Object.assign(confState.formData as Record<string, unknown>, {
      activityFilter: { value: false },
      companySizeRange: { enable: false, value: [0, 0, false] },
      goldHunterFilter: { value: false },
      jobContent: { enable: false, include: false, value: [] },
      salaryRange: {
        enable: false,
        value: [0, 0, false],
        advancedValue: { H: [0, 0, false], D: [0, 0, false], M: [0, 0, false] },
      },
    })
  })

  /** confState.formData 的字段类型由字面量推断，过滤配置在用例里统一按宽类型写入。 */
  function setFilter(name: string, config: Record<string, unknown>) {
    ;(confState.formData as Record<string, unknown>)[name] = config
  }

  function expectOnlyCounted(field: (typeof counterFields)[number]) {
    for (const other of counterFields) {
      expect({ [other]: todayData[other] }).toEqual({ [other]: other === field ? 1 : 0 })
    }
  }

  async function runFilter(factory: () => any, ctx: any) {
    const handler = factory()
    expect(handler, '过滤器未启用，用例没有真正执行').toBeTypeOf('function')
    await expect(handler({ data: ctx.listData }, ctx)).rejects.toThrow()
  }

  it('counts a job content rejection', async () => {
    setFilter('jobContent', { enable: true, include: false, value: ['agent'] })
    await runFilter(() => handles().jobContent(), createCtx())
    expectOnlyCounted('jobContent')
  })

  it('counts a company size rejection', async () => {
    setFilter('companySizeRange', { enable: true, value: [1000, 9999, false] })
    const ctx = createCtx()
    ctx.listData.brandScaleName = '20-99人'
    await runFilter(() => handles().companySizeRange(), ctx)
    expectOnlyCounted('companySizeRange')
  })

  it('counts a gold hunter rejection', async () => {
    setFilter('goldHunterFilter', { value: true })
    const ctx = createCtx()
    ctx.listData.goldHunter = 1
    await runFilter(() => handles().goldHunterFilter(), ctx)
    expectOnlyCounted('goldHunterFilter')
  })

  it('counts a recruiter activity rejection', async () => {
    setFilter('activityFilter', { value: true })
    const ctx = createCtx()
    ctx.listData.card.activeTimeDesc = '半年前活跃'
    await runFilter(() => handles().activityFilter(), ctx)
    expectOnlyCounted('activityFilter')
  })
})
