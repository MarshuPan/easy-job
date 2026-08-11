import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  cachePipelineResultMock,
  common,
  createHandleMock,
  delayMock,
  flushMock,
  formData,
  hydrateMock,
  jobListRef,
  logRecords,
  resolveRuntimeJobMock,
  logFinishDeliveryMock,
  logInfoMock,
  logStartDeliveryMock,
  logTouchDeliveryMock,
  sendPublishReqMock,
  statistics,
} = vi.hoisted(() => ({
  cachePipelineResultMock: vi.fn(async () => undefined),
  common: {
    deliverLock: false,
    deliverStop: false,
  },
  createHandleMock: vi.fn(),
  delayMock: vi.fn(async (_milliseconds: number): Promise<void> => undefined),
  flushMock: vi.fn(async () => undefined),
  hydrateMock: vi.fn(async () => undefined),
  formData: {
    aiGreeting: { enable: true },
    customGreeting: { enable: false },
    delay: {
      batchRestMinutes: 0,
      batchSize: 30,
      deliveryInterval: 0,
      deliveryIntervalMax: 0,
    },
    deliveryLimit: { group: 20, search: 20 },
  },
  jobListRef: { value: [] as any[] },
  logRecords: [] as any[],
  resolveRuntimeJobMock: vi.fn((job) => job),
  logFinishDeliveryMock: vi.fn(),
  logInfoMock: vi.fn(),
  logStartDeliveryMock: vi.fn(),
  logTouchDeliveryMock: vi.fn(),
  sendPublishReqMock: vi.fn(
    async (_data: any, _unused: unknown, _retry: number, _extra: any, ctx: any) => {
      ctx.publish = { ok: true, attempts: 1, code: 0, message: 'Success' }
    },
  ),
  statistics: {
    todayData: {
      date: '2026-07-07',
      success: 0,
      total: 0,
      groupSuccess: 0,
      searchSuccess: 0,
    } as any,
    flush: vi.fn(async () => undefined),
    updateStatistics: vi.fn(async () => undefined),
  },
}))

vi.mock('@/utils/actionGateStore', () => ({
  // 闸门是基础设施，业务单测不该去跑真实存储；它自己的行为由 actionGate/actionGateStore 的单测覆盖。
  acquireBossAction: vi.fn(async () => true),
  getCurrentPaceMultiplier: vi.fn(async () => 1),
  resetActionGate: vi.fn(async () => undefined),
}))

vi.mock('@/composables/useApplying', async () => {
  const actual = await vi.importActual<typeof import('@/composables/useApplying')>(
    '@/composables/useApplying',
  )
  return {
    ...actual,
    cachePipelineResult: cachePipelineResultMock,
    createHandle: createHandleMock,
    sendPublishReq: sendPublishReqMock,
  }
})

vi.mock('@/composables/useCommon', () => ({
  useCommon: () => common,
}))

vi.mock('@/composables/useStatistics', () => ({
  useStatistics: () => statistics,
}))

vi.mock('@/stores/conf', () => ({
  useConf: () => ({
    availableJobExpectations: [
      {
        id: '101',
        positionName: 'AI 产品经理',
      },
    ],
    formData,
  }),
}))

vi.mock('@/stores/jobs', () => ({
  jobList: {
    _list: jobListRef,
    resolveRuntimeJob: resolveRuntimeJobMock,
  },
}))

vi.mock('@/stores/log', async () => {
  const actual = await vi.importActual<typeof import('@/stores/log')>('@/stores/log')
  return {
    ...actual,
    useLog: () => ({
      // useLog() 暴露的是 Ref<log[]>，mock 必须保持同样的形状。
      // 曾经把它 mock 成裸数组，导致 getPendingGreetingRetryRecords 的
      // Array.isArray(log.data) 恒为 false，招呼语续发链路长期不执行而测试全绿。
      data: { value: logRecords },
      flush: flushMock,
      hydrate: hydrateMock,
      finishDelivery: logFinishDeliveryMock,
      info: logInfoMock,
      startDelivery: logStartDeliveryMock,
      touchDelivery: logTouchDeliveryMock,
    }),
  }
})

vi.mock('@/utils', () => ({
  delay: delayMock,
  getCurDay: () => '2026-07-07',
}))

vi.mock('@/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}))

// 每日上限必须与实现一致：mock 成另一个数值会让所有额度相关断言测的是一个
// 生产中不存在的阈值，真正的边界问题反而测不出来。
vi.mock('../utils/deliveryLimit', async () => {
  const actual =
    await vi.importActual<typeof import('../utils/deliveryLimit')>('../utils/deliveryLimit')
  return {
    ...actual,
    getDeliveryLimit: vi.fn(() => 20),
    getDeliveryLimitSource: vi.fn(() => 'group'),
  }
})

vi.mock('@/ui/instrument', () => ({
  AgentMessage: {
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}))

import {
  AIFilteringError,
  AIProviderError,
  GreetError,
  JobTitleError,
  JobDataIncompleteError,
  JobUnavailableError,
  RateLimitError,
} from '@/types/deliverError'
import { ActionGateTimeoutError } from '@/utils/actionGate'
import { getCurrentPaceMultiplier } from '@/utils/actionGateStore'

import { DAILY_DELIVERY_LIMIT } from '../utils/deliveryLimit'
import { useDeliver } from './useDeliver'

function createJob(encryptJobId: string) {
  const status = {
    msg: '等待中',
    status: 'wait',
    setStatus(nextStatus: string, msg?: string) {
      status.status = nextStatus
      status.msg = msg ?? ''
    },
  }

  return {
    brandName: `公司-${encryptJobId}`,
    encryptJobId,
    expectId: 101,
    jobName: `岗位-${encryptJobId}`,
    status,
  }
}

describe('useDeliver job list flow', () => {
  beforeEach(() => {
    // 曲线倍率是全局 mock，用例之间必须还原，否则前一条会把后一条的节奏基准带偏。
    vi.mocked(getCurrentPaceMultiplier).mockResolvedValue(1)
    setActivePinia(createPinia())
    vi.clearAllMocks()
    common.deliverLock = false
    common.deliverStop = false
    statistics.todayData.date = '2026-07-07'
    statistics.todayData.success = 0
    statistics.todayData.total = 0
    statistics.todayData.groupSuccess = 0
    statistics.todayData.searchSuccess = 0
    formData.aiGreeting.enable = true
    formData.customGreeting.enable = false
    formData.delay.deliveryInterval = 0
    formData.delay.deliveryIntervalMax = 0
    formData.delay.batchSize = 30
    formData.delay.batchRestMinutes = 0
    logRecords.splice(0)
    hydrateMock.mockResolvedValue(undefined)
    delayMock.mockImplementation(async () => undefined)

    logStartDeliveryMock.mockImplementation((job: any, data: any) => ({
      createdAt: Date.now(),
      data,
      job,
      state: 'info',
      state_name: '待处理',
      title: job.jobName,
    }))
  })

  it('does not establish communication after a manual stop during filtering', async () => {
    const job = createJob('job-stop-before-publish')
    jobListRef.value = [job]
    const after = vi.fn()
    createHandleMock.mockResolvedValue({
      before: [
        vi.fn(async () => {
          common.deliverStop = true
        }),
      ],
      after: [after],
      retryGreeting: vi.fn(),
    })

    const result = await useDeliver().jobListHandle()

    expect(result).toBe('stopped')
    expect(sendPublishReqMock).not.toHaveBeenCalled()
    expect(after).not.toHaveBeenCalled()
    expect(job.status).toMatchObject({ status: 'wait', msg: '已停止，可再次手动投递' })
    expect(logFinishDeliveryMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ name: '手动停止' }),
      expect.objectContaining({
        deliveryStage: '投递失败',
        state: '已停止',
        retryable: true,
      }),
    )
  })

  it('pauses instead of burning the job when the gate says slow down', async () => {
    // 撞上硬顶是「跑太快」的信号，不是这个岗位的错。原来它顺着未知错误走成岗位失败并
    // 清掉检查点，方向正好反了：应该停下、岗位留在待处理、检查点保住。
    const job = createJob('job-gate-timeout')
    jobListRef.value = [job]
    createHandleMock.mockResolvedValue({
      before: [
        vi.fn(async () => {
          throw new ActionGateTimeoutError('detail', 15 * 60_000)
        }),
      ],
      after: [],
      retryGreeting: vi.fn(),
    })

    const result = await useDeliver().jobListHandle()

    expect(result).toBe('aiUnavailable')
    expect(job.status.status).toBe('wait')
    expect(sendPublishReqMock).not.toHaveBeenCalled()
  })

  it('records which pace band produced the wait, not just the wait', async () => {
    // 只看到「目标 22 秒」判断不出该不该调曲线：同一个数可能来自 1.8 档，
    // 也可能来自用户把配置调小了，两者要采取的动作完全相反。
    vi.mocked(getCurrentPaceMultiplier).mockResolvedValue(1.8)
    formData.delay.deliveryInterval = 40
    formData.delay.deliveryIntervalMax = 40
    // delayWithStop 走真实时钟轮询，不接假时钟这里会空转到真的等完。
    const clock = { now: Date.now() }
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock.now)
    delayMock.mockImplementation(async (seconds: number) => {
      clock.now += seconds * 1000
    })
    jobListRef.value = [createJob('job-pace-log')]
    createHandleMock.mockResolvedValue({ before: [], after: [], retryGreeting: vi.fn() })

    try {
      await useDeliver().jobListHandle()
    } finally {
      nowSpy.mockRestore()
    }

    const paceLog = logInfoMock.mock.calls.find(([stage]) => stage === '投递节奏')
    expect(paceLog).toBeDefined()
    expect(String(paceLog?.[1])).toContain('"paceMultiplier":1.8')
  })

  it('runs a job faster early in a session than late in one', async () => {
    // 决定吞吐的是这个目标耗时，不是闸门。曲线只接闸门等于白接：真正卡住速度的一项没动。
    //
    // 耗时是重尾分布抽出来的，单次采样必然偶发假红——所以比的是中位数，不是某一次。
    const measure = async (multiplier: number, index: number) => {
      vi.mocked(getCurrentPaceMultiplier).mockResolvedValue(multiplier)
      delayMock.mockClear()
      formData.delay.deliveryInterval = 40
      formData.delay.deliveryIntervalMax = 40
      const clock = { now: Date.now() }
      const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock.now)
      delayMock.mockImplementation(async (seconds: number) => {
        clock.now += seconds * 1000
      })
      jobListRef.value = [createJob(`job-pace-${multiplier}-${index}`)]
      createHandleMock.mockResolvedValue({ before: [], after: [], retryGreeting: vi.fn() })
      try {
        await useDeliver().jobListHandle()
      } finally {
        nowSpy.mockRestore()
      }
      return delayMock.mock.calls.reduce((sum, [seconds]) => sum + Number(seconds) * 1000, 0)
    }
    // 这里要比的是「同一档节奏的典型耗时」，不是某一次抽样。原来靠多抽几次取中位数逼近，
    // 但耗时是重尾分布，样本中位数本身方差不小——整套并行跑时仍会偶发假红，加到 31 个样本
    // 也只是把概率压低，没有消掉。
    //
    // 改成把随机源钉死：延迟走 Box-Muller，u=0.5、v=0.25 时 cos(2π·0.25)=0，高斯项为 0，
    // 抽样值恰好落在中位数上。于是「典型耗时」不用估计，直接就是它，一个样本即可。
    const withFixedRandom = async (multiplier: number) => {
      let call = 0
      const spy = vi.spyOn(Math, 'random').mockImplementation(() => (call++ % 2 === 0 ? 0.5 : 0.25))
      try {
        return await measure(multiplier, 0)
      } finally {
        spy.mockRestore()
      }
    }

    const early = await withFixedRandom(1.8)
    const late = await withFixedRandom(0.75)

    expect(early).toBeLessThan(late)
    // 常规档是用户配的 40 秒：开头那档应该明显快于它，跑久之后明显慢于它。
    expect(early).toBeLessThan(40_000)
    expect(late).toBeGreaterThan(40_000)
  })

  it('paces a job that was only looked at, not just the ones actually delivered', async () => {
    // 节奏原来只在真的投出去之后才等。一页里被 AI 或岗位规则筛掉的岗位是零等待，
    // 而它们每一个都已经向 BOSS 要过一次详情——几秒内连打十几次比投递本身更像脚本。
    //
    // 和曲线那条一样比中位数：耗时是重尾分布抽出来的，单次采样会偶发假红。
    const measure = async (index: number) => {
      formData.delay.deliveryInterval = 40
      formData.delay.deliveryIntervalMax = 40
      delayMock.mockClear()
      const clock = { now: Date.now() }
      const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock.now)
      delayMock.mockImplementation(async (seconds: number) => {
        clock.now += seconds * 1000
      })
      jobListRef.value = [createJob(`job-browsed-only-${index}`)]
      createHandleMock.mockResolvedValue({
        before: [
          vi.fn(async (_args: unknown, ctx: any) => {
            // 取过详情，然后被过滤掉——最常见的一类岗位。
            ctx.detailAttempted = true
            ctx.detailFetched = true
            throw new AIFilteringError('AI匹配度不足')
          }),
        ],
        after: [],
        retryGreeting: vi.fn(),
      })
      try {
        await useDeliver().jobListHandle()
      } finally {
        nowSpy.mockRestore()
      }
      return delayMock.mock.calls.reduce((sum, [seconds]) => sum + Number(seconds) * 1000, 0)
    }

    const samples: number[] = []
    for (let i = 0; i < 11; i++) samples.push(await measure(i))
    const median = samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)]

    expect(sendPublishReqMock).not.toHaveBeenCalled()
    // 只看不投走的是折扣比例（30%~55%），所以既要明显大于零，也不该等满整轮。
    expect(median).toBeGreaterThan(40_000 * 0.2)
    expect(median).toBeLessThan(40_000)
  })

  it('counts detail failures consecutively, not cumulatively over the whole run', async () => {
    // 「连续」不清零就是「累计」：第 5 个失败一次、第 30 个失败一次、第 80 个再失败一次
    // 也会停，中间七十多个全成功也不算数。停下来的门槛必须是「问题正在持续」。
    jobListRef.value = [
      createJob('fail-1'),
      createJob('ok-1'),
      createJob('fail-2'),
      createJob('ok-2'),
      createJob('fail-3'),
    ]
    createHandleMock.mockResolvedValue({
      before: [
        vi.fn(async (args: any, ctx: any) => {
          ctx.detailAttempted = true
          if (String(args.data.encryptJobId).startsWith('fail')) {
            throw new JobUnavailableError('取岗位详情失败，已跳过该岗位：详情接口返回异常')
          }
          ctx.detailFetched = true
        }),
      ],
      after: [],
      retryGreeting: vi.fn(),
    })

    const result = await useDeliver().jobListHandle()

    // 三次失败之间各夹着一次成功，不构成「连续」，整轮应该跑完而不是中途暂停。
    expect(result).toBe('completed')
  })

  it('skips a job whose data is incomplete instead of ending the whole run', async () => {
    // 岗位名为空、地址为空、通勤查不出来——这些是这一条数据的问题，和后面几十个岗位没有
    // 关系。原来它们和「账号 uid 拿不到」「高德 Key 没配」共用 RetryablePipelineError，
    // 走同一条终止分支，于是一条脏数据判了整轮的死刑。
    jobListRef.value = [createJob('bad-1'), createJob('ok-1'), createJob('ok-2')]
    const seen: string[] = []
    createHandleMock.mockResolvedValue({
      before: [
        vi.fn(async (args: any, ctx: any) => {
          seen.push(String(args.data.encryptJobId))
          ctx.detailAttempted = true
          if (String(args.data.encryptJobId).startsWith('bad')) {
            throw new JobDataIncompleteError('岗位地址为空，无法执行工作地址筛选')
          }
          ctx.detailFetched = true
        }),
      ],
      after: [],
      retryGreeting: vi.fn(),
    })

    const result = await useDeliver().jobListHandle()

    expect(result).toBe('completed')
    // 坏数据那个之后的两个都要跑到——这才是「一条脏数据没有判整轮死刑」。
    expect(seen).toEqual(['bad-1', 'ok-1', 'ok-2'])
  })

  it('still stops when job after job cannot be evaluated', async () => {
    // 反过来，连着三个都评不上说明问题不在单个岗位上，继续跑只是把整个池子磨掉。
    // 这里三个都缺数据，中间没有成功打断，应当停。
    jobListRef.value = [
      createJob('bad-1'),
      createJob('bad-2'),
      createJob('bad-3'),
      createJob('ok-1'),
    ]
    createHandleMock.mockResolvedValue({
      before: [
        vi.fn(async (args: any, ctx: any) => {
          ctx.detailAttempted = true
          throw new JobDataIncompleteError('岗位地址为空，无法执行工作地址筛选')
        }),
      ],
      after: [],
      retryGreeting: vi.fn(),
    })

    const result = await useDeliver().jobListHandle()

    expect(result).toBe('terminalError')
  })

  it('paces a job whose detail request failed, not just the ones that succeeded', async () => {
    // 真机上详情开始连续失败之后，每个失败岗位都是零等待——6 个请求在 565 毫秒内打空了
    // 令牌桶。请求发出去了就该计时间，拿没拿到结果是 BOSS 那边的事，不改变我们发过请求。
    formData.delay.deliveryInterval = 20
    formData.delay.deliveryIntervalMax = 40
    delayMock.mockClear()
    const clock = { now: Date.now() }
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock.now)
    delayMock.mockImplementation(async (seconds: number) => {
      clock.now += seconds * 1000
    })
    jobListRef.value = [createJob('job-detail-failed')]
    createHandleMock.mockResolvedValue({
      before: [
        vi.fn(async (_args: unknown, ctx: any) => {
          // 请求发出去了，但没拿到结果——detailFetched 停在 false。
          ctx.detailAttempted = true
          throw new JobUnavailableError('取岗位详情失败，已跳过该岗位：detail api failed')
        }),
      ],
      after: [],
      retryGreeting: vi.fn(),
    })
    try {
      await useDeliver().jobListHandle()
    } finally {
      nowSpy.mockRestore()
    }
    const waited = delayMock.mock.calls.reduce((sum, [seconds]) => sum + Number(seconds) * 1000, 0)
    expect(waited).toBeGreaterThan(0)
  })

  it('waits for persisted delivery logs before scanning pending greeting retries', async () => {
    let resolveHydrate!: (value: undefined) => void
    hydrateMock.mockReturnValueOnce(
      new Promise<undefined>((resolve) => {
        resolveHydrate = resolve
      }),
    )
    jobListRef.value = []
    createHandleMock.mockResolvedValue({ after: [], before: [], retryGreeting: vi.fn() })

    const running = useDeliver().jobListHandle()
    await Promise.resolve()

    expect(createHandleMock).not.toHaveBeenCalled()

    resolveHydrate(undefined)
    await expect(running).resolves.toBe('completed')
    expect(createHandleMock).toHaveBeenCalledTimes(1)
  })

  it('stops before greeting while preserving a confirmed communication', async () => {
    const job = createJob('job-stop-after-publish')
    jobListRef.value = [job]
    const after = vi.fn()
    createHandleMock.mockResolvedValue({
      before: [],
      after: [after],
      retryGreeting: vi.fn(),
    })
    sendPublishReqMock.mockImplementationOnce(
      async (_data: any, _unused: unknown, _retry: number, _extra: any, ctx: any) => {
        ctx.publish = { ok: true, attempts: 1, code: 0, message: 'Success' }
        common.deliverStop = true
      },
    )

    const result = await useDeliver().jobListHandle()

    expect(result).toBe('stopped')
    expect(sendPublishReqMock).toHaveBeenCalledTimes(1)
    expect(after).not.toHaveBeenCalled()
    expect(statistics.todayData.success).toBe(1)
    expect(statistics.todayData.total).toBe(1)
    expect(job.status).toMatchObject({
      status: 'warn',
      msg: '已建立沟通，招呼语未完成，可从记录中继续',
    })
    expect(logFinishDeliveryMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ name: '手动停止' }),
      expect.objectContaining({
        deliveryStage: '投递失败',
        state: '已停止',
        retryable: true,
        communicationCounted: true,
      }),
    )
  })

  it('continues the page when greeting generation fails after publish succeeds', async () => {
    const first = createJob('job-1')
    const second = createJob('job-2')
    jobListRef.value = [first, second]
    createHandleMock.mockResolvedValue({
      after: [
        vi.fn(async ({ data }: any, ctx: any) => {
          if (data.encryptJobId === 'job-1') {
            ctx.greetingSend = { ok: false, type: 'ai', error: 'AI 502' }
            throw new GreetError('AI招呼语生成失败：502 Bad Gateway')
          }
          ctx.greetingSend = { ok: true, type: 'ai', messageCount: 3 }
          ctx.message = '招呼语已发送'
        }),
      ],
      before: [],
      retryGreeting: vi.fn(),
    })

    const deliver = useDeliver()
    const result = await deliver.jobListHandle()

    expect(result).toBe('completed')
    expect(common.deliverStop).toBe(false)
    expect(sendPublishReqMock).toHaveBeenCalledTimes(2)
    expect(statistics.todayData.success).toBe(2)
    expect(statistics.todayData.total).toBe(2)
    expect(logInfoMock).toHaveBeenCalledWith(
      '岗位处理',
      expect.stringContaining('当前页岗位处理结束：completed'),
    )
  })

  it('persists the confirmed communication before starting greeting work', async () => {
    let releaseGreeting!: () => void
    const after = vi.fn(async (_payload: any, ctx: any) => {
      await new Promise<void>((resolve) => (releaseGreeting = resolve))
      ctx.greetingSend = { ok: true, type: 'ai', messageCount: 3 }
    })
    jobListRef.value = [createJob('job-persist-before-greeting')]
    createHandleMock.mockResolvedValue({ before: [], after: [after], retryGreeting: vi.fn() })

    const running = useDeliver().jobListHandle()
    await vi.waitFor(() => expect(after).toHaveBeenCalledOnce())

    expect(statistics.flush).toHaveBeenCalled()
    expect(flushMock).toHaveBeenCalled()
    expect(statistics.flush.mock.invocationCallOrder[0]).toBeLessThan(
      after.mock.invocationCallOrder[0],
    )
    expect(statistics.todayData.success).toBe(1)

    releaseGreeting()
    await expect(running).resolves.toBe('completed')
  })

  it('automatically resumes only the greeting stage after a refresh', async () => {
    const job = createJob('job-auto-greeting-resume')
    job.status.setStatus('warn', '已建立沟通，招呼语未完成')
    const context = {
      listData: job,
      communicationCounted: true,
      deliverySource: 'group',
      deliveryStage: '投递失败',
      failureStage: '正在打招呼',
      failureReason: '插件后台连接中断',
      greetingSend: { ok: false, type: 'ai' },
      publish: { ok: true, attempts: 1, phase: 'confirmed' },
      retryable: true,
    }
    logRecords.push({
      createdAt: Date.now(),
      data: context,
      job,
      state: 'danger',
      state_name: '投递失败',
      title: job.jobName,
    })
    statistics.todayData.success = 1
    statistics.todayData.total = 1
    jobListRef.value = []
    const retryGreeting = vi.fn(async (_payload: any, ctx: any) => {
      ctx.greetingSend = { ok: true, type: 'ai', messageCount: 3 }
    })
    createHandleMock.mockResolvedValue({ before: [], after: [], retryGreeting })

    await expect(useDeliver().jobListHandle()).resolves.toBe('completed')

    expect(retryGreeting).toHaveBeenCalledOnce()
    expect(sendPublishReqMock).not.toHaveBeenCalled()
    expect(statistics.todayData.success).toBe(1)
    expect(statistics.todayData.total).toBe(1)
    expect(context.retryable).toBe(false)
  })

  it('does not offer automatic greeting retry when the send result is unknown', async () => {
    jobListRef.value = [createJob('job-greeting-result-unknown')]
    createHandleMock.mockResolvedValue({
      before: [],
      after: [
        vi.fn(async (_payload: any, ctx: any) => {
          ctx.greetingSend = {
            ok: false,
            type: 'ai',
            detail: { confirmed: false, resultUnknown: true },
          }
          throw new GreetError('招呼语发送结果不确定，请人工核对后再处理')
        }),
      ],
      retryGreeting: vi.fn(),
    })

    await expect(useDeliver().jobListHandle()).resolves.toBe('completed')

    expect(logFinishDeliveryMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: '打招呼出错' }),
      expect.objectContaining({
        retryable: false,
        greetingSend: expect.objectContaining({
          detail: expect.objectContaining({ resultUnknown: true }),
        }),
      }),
    )
  })

  it('applies batch rest to confirmed communications even when greeting later fails', async () => {
    formData.delay.batchSize = 1
    formData.delay.batchRestMinutes = 1
    jobListRef.value = [createJob('job-greeting-failed-at-rest-boundary')]
    createHandleMock.mockResolvedValue({
      before: [],
      after: [
        vi.fn(async (_payload: any, ctx: any) => {
          ctx.greetingSend = { ok: false, type: 'ai', error: 'send failed' }
          throw new GreetError('招呼语发送失败')
        }),
      ],
      retryGreeting: vi.fn(),
    })
    delayMock.mockImplementationOnce(async () => {
      common.deliverStop = true
    })

    await useDeliver().jobListHandle()

    expect(statistics.todayData.success).toBe(1)
    expect(delayMock).toHaveBeenCalledWith(expect.any(Number))
    expect(Number(delayMock.mock.calls[0]?.[0])).toBeLessThanOrEqual(5)
  })

  it('does not enter batch rest after reaching the daily delivery limit', async () => {
    formData.delay.batchSize = 1
    formData.delay.batchRestMinutes = 1
    statistics.todayData.success = DAILY_DELIVERY_LIMIT - 1
    statistics.todayData.groupSuccess = DAILY_DELIVERY_LIMIT - 1
    jobListRef.value = [createJob('job-daily-limit')]
    createHandleMock.mockResolvedValue({
      before: [],
      after: [
        vi.fn(async (_payload: any, ctx: any) => {
          ctx.greetingSend = { ok: true, type: 'ai', messageCount: 3 }
        }),
      ],
      retryGreeting: vi.fn(),
    })

    await expect(useDeliver().jobListHandle()).resolves.toBe('sourceLimit')

    expect(statistics.todayData.success).toBe(DAILY_DELIVERY_LIMIT)
    expect(delayMock).not.toHaveBeenCalled()
  })

  it('hands a rate limit up instead of sleeping and burning the next job', async () => {
    // 原来的反应是「等 30 秒、单岗位加 3 秒、接着投下一个」。被限流说明这一段行为已经
    // 被判定成异常，30 秒后接着投等于拿后面的岗位去验证同一个判定。
    //
    // 单个岗位不知道今天已经命中过几次，所以它只负责把岗位留在待处理并交出信号，
    // 退多久、要不要今天收工由上层决定。
    const job = createJob('job-rate-limit')
    jobListRef.value = [job]
    createHandleMock.mockResolvedValue({ after: [], before: [], retryGreeting: vi.fn() })
    sendPublishReqMock.mockRejectedValueOnce(new RateLimitError('操作过于频繁'))

    await expect(useDeliver().jobListHandle()).resolves.toBe('rateLimited')

    expect(job.status.status).toBe('wait')
    expect(common.deliverStop).toBe(true)
    // 不该在这一层自己睡一个固定的冷却。
    const longSleeps = delayMock.mock.calls.filter(([seconds]) => Number(seconds) >= 30)
    expect(longSleeps).toHaveLength(0)
  })

  it('does not mutate the delivery configuration when a rate limit hits', async () => {
    // 退避是运行时行为。运行配置快照是冻结的，写回去会直接抛错；
    // 无快照时写 live store 又会让界面显示一个从未持久化的值。
    formData.delay.deliveryInterval = 30
    formData.delay.deliveryIntervalMax = 60
    jobListRef.value = [createJob('job-rate-limit-config')]
    createHandleMock.mockResolvedValue({ after: [], before: [], retryGreeting: vi.fn() })
    sendPublishReqMock.mockRejectedValueOnce(new RateLimitError('操作过于频繁'))

    await useDeliver().jobListHandle()

    expect(formData.delay.deliveryInterval).toBe(30)
    expect(formData.delay.deliveryIntervalMax).toBe(60)
  })

  it('pauses when the AI provider fails before publishing', async () => {
    const job = createJob('job-ai-provider-error')
    jobListRef.value = [job]
    createHandleMock.mockResolvedValue({
      after: [],
      before: [
        vi.fn(async () => {
          throw new AIProviderError('模型服务不可用')
        }),
      ],
      retryGreeting: vi.fn(),
    })

    const deliver = useDeliver()

    // 暂停而不是终止：模型是能修好的，检查点留着，点「继续」接着原位置跑。
    await expect(deliver.jobListHandle()).resolves.toBe('aiUnavailable')
    expect(deliver.terminalError).toBe('模型服务不可用')
    expect(common.deliverStop).toBe(true)
    expect(sendPublishReqMock).not.toHaveBeenCalled()
  })

  it('treats communication as successful with zero text when AI greeting is disabled', async () => {
    formData.aiGreeting.enable = false
    formData.customGreeting.enable = true
    jobListRef.value = [createJob('job-no-text')]
    createHandleMock.mockResolvedValue({
      after: [],
      before: [],
      retryGreeting: vi.fn(),
    })

    const result = await useDeliver().jobListHandle()

    expect(result).toBe('completed')
    expect(statistics.todayData.success).toBe(1)
    expect(statistics.todayData.total).toBe(1)
    expect(sendPublishReqMock).toHaveBeenCalledOnce()
    expect(logFinishDeliveryMock).toHaveBeenCalledWith(
      expect.anything(),
      null,
      expect.objectContaining({ deliveryStage: '投递成功', state: '成功' }),
      undefined,
    )
  })

  it('keeps successful jobs successful when runtime state persistence hits a provider heartbeat timeout', async () => {
    const first = createJob('job-1')
    const second = createJob('job-2')
    jobListRef.value = [first, second]
    statistics.flush.mockRejectedValueOnce(
      new Error('Provider unavailable: heartbeat check timeout 30000ms.'),
    )
    createHandleMock.mockResolvedValue({
      after: [
        vi.fn(async (_payload: any, ctx: any) => {
          ctx.greetingSend = { ok: true, type: 'ai', messageCount: 3 }
          ctx.message = '招呼语已发送'
        }),
      ],
      before: [],
      retryGreeting: vi.fn(),
    })

    const deliver = useDeliver()
    const result = await deliver.jobListHandle()

    expect(result).toBe('completed')
    expect(common.deliverStop).toBe(false)
    expect(first.status.status).toBe('success')
    expect(second.status.status).toBe('success')
    expect(statistics.todayData.success).toBe(2)
    expect(statistics.todayData.total).toBe(2)
    expect(logFinishDeliveryMock).toHaveBeenCalledTimes(2)
    expect(logTouchDeliveryMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        trace: expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining('统计保存失败'),
            stage: '运行状态保存',
            status: 'warning',
          }),
        ]),
      }),
    )
  })

  it('propagates provider heartbeat failures to the batch retry layer', async () => {
    const first = createJob('job-1')
    jobListRef.value = [first]
    createHandleMock.mockResolvedValue({
      after: [],
      before: [
        vi.fn(async () => {
          throw new Error('Provider unavailable: heartbeat check timeout 30000ms.')
        }),
      ],
      retryGreeting: vi.fn(),
    })

    const deliver = useDeliver()

    await expect(deliver.jobListHandle()).rejects.toThrow(
      'Provider unavailable: heartbeat check timeout 30000ms.',
    )
    expect(common.deliverStop).toBe(false)
    expect(sendPublishReqMock).not.toHaveBeenCalled()
    expect(statistics.todayData.total).toBe(0)
    expect(logTouchDeliveryMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        failureReason: 'Provider unavailable: heartbeat check timeout 30000ms.',
        retryable: true,
      }),
    )
  })

  it('keeps total aligned when the heartbeat fails after communication is confirmed', async () => {
    const first = createJob('job-heartbeat-after-publish')
    jobListRef.value = [first]
    createHandleMock.mockResolvedValue({
      before: [],
      after: [
        vi.fn(async () => {
          throw new Error('Provider unavailable: heartbeat check timeout 30000ms.')
        }),
      ],
      retryGreeting: vi.fn(),
    })

    await expect(useDeliver().jobListHandle()).rejects.toThrow('heartbeat check timeout')

    expect(statistics.todayData.success).toBe(1)
    expect(statistics.todayData.total).toBe(1)
  })

  it('restores the heartbeat-interrupted job so the next batch call retries that job', async () => {
    const first = createJob('job-1')
    jobListRef.value = [first]
    const before = vi
      .fn()
      .mockRejectedValueOnce(new Error('Provider unavailable: heartbeat check timeout 30000ms.'))
      .mockResolvedValue(undefined)
    createHandleMock.mockResolvedValue({
      after: [
        vi.fn(async (_payload: any, ctx: any) => {
          ctx.greetingSend = { ok: true, type: 'ai', messageCount: 3 }
        }),
      ],
      before: [before],
      retryGreeting: vi.fn(),
    })

    const deliver = useDeliver()

    await expect(deliver.jobListHandle()).rejects.toThrow('heartbeat check timeout')
    expect(first.status.status).toBe('wait')

    await expect(deliver.jobListHandle()).resolves.toBe('completed')
    expect(before).toHaveBeenCalledTimes(2)
    expect(sendPublishReqMock).toHaveBeenCalledTimes(1)
    expect(statistics.todayData.success).toBe(1)
  })

  it('requires manual verification when publish was sent but its result is unknown', async () => {
    const first = createJob('job-unknown-publish')
    jobListRef.value = [first]
    sendPublishReqMock.mockImplementationOnce(
      async (_data: any, _unused: unknown, _retry: number, _extra: any, ctx: any) => {
        ctx.publish = { ok: false, attempts: 1, phase: 'unknown' }
        throw new Error('Provider unavailable: heartbeat check timeout 30000ms.')
      },
    )
    createHandleMock.mockResolvedValue({ after: [], before: [], retryGreeting: vi.fn() })

    const deliver = useDeliver()

    await expect(deliver.jobListHandle()).rejects.toThrow('heartbeat check timeout')
    await expect(deliver.jobListHandle()).resolves.toBe('completed')

    expect(sendPublishReqMock).toHaveBeenCalledTimes(1)
    expect(first.status.status).toBe('warn')
    expect(statistics.todayData.success).toBe(1)
    expect(statistics.todayData.groupSuccess).toBe(1)
  })

  it('keeps a non-heartbeat unconfirmed publish warning out of the retry queue', async () => {
    const first = createJob('job-network-unknown')
    jobListRef.value = [first]
    sendPublishReqMock.mockImplementationOnce(
      async (_data: any, _unused: unknown, _retry: number, _extra: any, ctx: any) => {
        ctx.publish = { ok: false, attempts: 1, phase: 'unknown' }
        throw new Error('Network Error: request timed out')
      },
    )
    createHandleMock.mockResolvedValue({ after: [], before: [], retryGreeting: vi.fn() })

    const deliver = useDeliver()

    await expect(deliver.jobListHandle()).resolves.toBe('completed')
    await expect(deliver.jobListHandle()).resolves.toBe('completed')

    expect(sendPublishReqMock).toHaveBeenCalledTimes(1)
    expect(first.status.status).toBe('warn')
    expect(statistics.todayData.success).toBe(1)
    expect(statistics.todayData.groupSuccess).toBe(1)
  })

  it('stops before another publish when an unknown request consumes the daily remainder', async () => {
    statistics.todayData.success = DAILY_DELIVERY_LIMIT - 1
    statistics.todayData.groupSuccess = DAILY_DELIVERY_LIMIT - 1
    const first = createJob('job-network-unknown-at-limit')
    const second = createJob('job-must-not-publish')
    jobListRef.value = [first, second]
    sendPublishReqMock.mockImplementationOnce(
      async (_data: any, _unused: unknown, _retry: number, _extra: any, ctx: any) => {
        ctx.publish = { ok: false, attempts: 1, phase: 'unknown' }
        throw new Error('Network Error: request timed out')
      },
    )
    createHandleMock.mockResolvedValue({ after: [], before: [], retryGreeting: vi.fn() })

    await expect(useDeliver().jobListHandle()).resolves.toBe('sourceLimit')

    expect(sendPublishReqMock).toHaveBeenCalledTimes(1)
    expect(statistics.todayData.success).toBe(DAILY_DELIVERY_LIMIT)
    expect(statistics.todayData.groupSuccess).toBe(DAILY_DELIVERY_LIMIT)
    expect(first.status.status).toBe('warn')
    expect(second.status.status).toBe('wait')
  })

  it('leaves an already filtered job alone instead of resetting it to wait', async () => {
    // 批次开头会把状态归一到 wait。filtered 原本落在 default 分支被一起重置，
    // 于是刚判掉的岗位马上又变回待处理：它不走投递节奏，下一轮立刻再判一次，
    // 循环空转，统计里的「处理」按次累加一路虚涨。
    const filtered = createJob('job-filtered')
    filtered.status.setStatus('filtered', '已过滤')
    jobListRef.value = [filtered]
    createHandleMock.mockResolvedValue({ after: [], before: [], retryGreeting: vi.fn() })

    const deliver = useDeliver()
    await expect(deliver.jobListHandle()).resolves.toBe('completed')

    expect(filtered.status.status).toBe('filtered')
    expect(sendPublishReqMock).not.toHaveBeenCalled()
    expect(statistics.todayData.total).toBe(0)
  })

  it('marks a persisted running job for manual verification instead of publishing it again', async () => {
    const interrupted = createJob('job-running')
    interrupted.status.setStatus('running', '正在建立沟通')
    jobListRef.value = [interrupted]
    createHandleMock.mockResolvedValue({ after: [], before: [], retryGreeting: vi.fn() })

    const deliver = useDeliver()
    await expect(deliver.jobListHandle()).resolves.toBe('completed')

    expect(sendPublishReqMock).not.toHaveBeenCalled()
    expect(interrupted.status.status).toBe('warn')
    expect(interrupted.status.msg).toContain('需核对')
  })

  it('does not apply the full human-like pace delay to locally filtered jobs', async () => {
    const first = createJob('job-1')
    const second = createJob('job-2')
    jobListRef.value = [first, second]
    formData.delay.deliveryInterval = 30
    formData.delay.deliveryIntervalMax = 60
    delayMock.mockImplementation(async () => {
      throw new Error('filtered jobs should not enter full pace delay')
    })
    createHandleMock.mockResolvedValue({
      after: [],
      before: [
        vi.fn(async () => {
          throw new JobTitleError('岗位名不是产品岗')
        }),
      ],
      retryGreeting: vi.fn(),
    })

    const deliver = useDeliver()
    const result = await deliver.jobListHandle()

    expect(result).toBe('completed')
    expect(sendPublishReqMock).not.toHaveBeenCalled()
    expect(statistics.todayData.success).toBe(0)
    expect(statistics.todayData.total).toBe(2)
    expect(delayMock).not.toHaveBeenCalled()
    expect(first.status).toMatchObject({ status: 'filtered', msg: '已过滤' })
    expect(second.status).toMatchObject({ status: 'filtered', msg: '已过滤' })
    expect(logFinishDeliveryMock).toHaveBeenCalledTimes(2)
    for (const call of logFinishDeliveryMock.mock.calls) {
      expect(call[2]).toMatchObject({
        deliveryStage: '已过滤',
        failureStage: 'JD筛选中',
        retryable: false,
        state: '过滤',
      })
    }
    expect(logInfoMock).toHaveBeenCalledWith(
      '岗位处理',
      expect.stringContaining('当前页岗位处理结束：completed'),
    )
  })

  it('does not stop the page when the current source reaches its ratio target before the daily limit', async () => {
    const first = createJob('job-1')
    jobListRef.value = [first]
    statistics.todayData.success = 58
    statistics.todayData.groupSuccess = 20
    statistics.todayData.searchSuccess = 38
    createHandleMock.mockResolvedValue({
      after: [
        vi.fn(async (_payload: any, ctx: any) => {
          ctx.greetingSend = { ok: true, type: 'ai', messageCount: 3 }
          ctx.message = '招呼语已发送'
        }),
      ],
      before: [],
      retryGreeting: vi.fn(),
    })

    const deliver = useDeliver()
    const result = await deliver.jobListHandle()

    expect(result).toBe('completed')
    expect(statistics.todayData.success).toBe(59)
    expect(statistics.todayData.groupSuccess).toBe(21)
    expect(logInfoMock).not.toHaveBeenCalledWith(
      '岗位处理',
      expect.stringContaining('当前页处理触发来源额度上限'),
    )
  })

  it('processes an explicit mixed-source batch without relying on the current page list', async () => {
    const groupJob = createJob('group-1')
    const searchJob = createJob('search-1')
    jobListRef.value = []
    createHandleMock.mockResolvedValue({
      after: [
        vi.fn(async (_payload: any, ctx: any) => {
          ctx.greetingSend = { ok: true, type: 'ai', messageCount: 3 }
          ctx.message = '招呼语已发送'
        }),
      ],
      before: [],
      retryGreeting: vi.fn(),
    })

    const deliver = useDeliver()
    const result = await deliver.jobListHandle([
      { source: 'group', item: groupJob as any },
      { source: 'search', item: searchJob as any },
    ])

    expect(result).toBe('completed')
    expect(statistics.todayData.success).toBe(2)
    expect(statistics.todayData.groupSuccess).toBe(1)
    expect(statistics.todayData.searchSuccess).toBe(1)
    expect(logStartDeliveryMock.mock.calls[0]?.[1].deliverySource).toBe('group')
    expect(logStartDeliveryMock.mock.calls[0]?.[1].deliverySourceName).toBe('AI 产品经理')
    expect(logStartDeliveryMock.mock.calls[1]?.[1].deliverySource).toBe('search')
    expect(logStartDeliveryMock.mock.calls[1]?.[1].deliverySourceName).toBe('搜索')
  })

  it('disables manual retry after three failed attempts', async () => {
    const job = createJob('job-retry-limit')
    const record = {
      data: {
        deliverySource: 'group',
        listData: job,
        retryable: true,
      },
      job,
    } as any
    const retryStep = vi.fn(async () => {
      throw new AIProviderError('模型服务不可用')
    })
    createHandleMock.mockResolvedValue({
      after: [],
      before: [retryStep],
      retryGreeting: vi.fn(),
    })
    const deliver = useDeliver()

    await deliver.retryRecord(record)
    await deliver.retryRecord(record)
    await deliver.retryRecord(record)
    await deliver.retryRecord(record)

    expect(retryStep).toHaveBeenCalledTimes(3)
    expect(record.data).toMatchObject({
      retryAttempts: 3,
      maxRetryAttempts: 3,
      retryable: false,
    })
    expect((job as typeof job & { retryAttempts?: number }).retryAttempts).toBe(3)
    expect(job.status).toMatchObject({
      status: 'error',
      msg: '已达到 3 次重试上限',
    })
  })
})

describe('an AI request that failed', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    common.deliverLock = false
    common.deliverStop = false
    statistics.todayData.date = '2026-07-07'
    statistics.todayData.success = 0
    statistics.todayData.total = 0
    formData.delay.deliveryInterval = 0
    formData.delay.deliveryIntervalMax = 0
    delayMock.mockImplementation(async () => undefined)
    hydrateMock.mockResolvedValue(undefined)
    logStartDeliveryMock.mockImplementation((job: any, data: any) => ({
      createdAt: Date.now(),
      job,
      data,
    }))
  })

  it('pauses immediately instead of trying the next job', async () => {
    // 一个岗位的 AI 请求失败就说明 AI 有问题，再拿后面的岗位去试结果一样，
    // 只会把它们一并废掉。
    jobListRef.value = [createJob('job-1'), createJob('job-2'), createJob('job-3')]
    createHandleMock.mockResolvedValue({
      after: [],
      before: [
        vi.fn(async () => {
          throw new AIProviderError('AI请求失败，状态码: 400')
        }),
      ],
      retryGreeting: vi.fn(),
    })

    const deliver = useDeliver()
    await expect(deliver.jobListHandle()).resolves.toBe('aiUnavailable')

    expect(common.deliverStop).toBe(true)
    expect(sendPublishReqMock).not.toHaveBeenCalled()
  })

  it('leaves the job deliverable so 继续 picks it up again', async () => {
    // 岗位不该为一次 AI 故障买单：暂停保留了检查点，它应该还在待处理里。
    const job = createJob('job-1')
    jobListRef.value = [job]
    createHandleMock.mockResolvedValue({
      after: [],
      before: [
        vi.fn(async () => {
          throw new AIProviderError('AI请求失败，状态码: 400')
        }),
      ],
      retryGreeting: vi.fn(),
    })

    const deliver = useDeliver()
    await deliver.jobListHandle()

    expect(job.status.status).toBe('wait')
  })
})

describe('an AI failure after communication was established', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    common.deliverLock = false
    common.deliverStop = false
    statistics.todayData.date = '2026-07-07'
    statistics.todayData.success = 0
    statistics.todayData.total = 0
    formData.delay.deliveryInterval = 0
    formData.delay.deliveryIntervalMax = 0
    delayMock.mockImplementation(async () => undefined)
    hydrateMock.mockResolvedValue(undefined)
    logStartDeliveryMock.mockImplementation((job: any, data: any) => ({
      createdAt: Date.now(),
      job,
      data,
    }))
  })

  it('does not put the job back in the queue once the boss has been contacted', async () => {
    // 招呼语在建立沟通之后生成。此时把岗位放回待处理，点「继续」会让它从头再跑一遍，
    // 对同一个 boss 重复建立沟通，今日额度也会重复计一次。
    const job = createJob('job-1')
    jobListRef.value = [job]
    createHandleMock.mockResolvedValue({
      after: [
        vi.fn(async () => {
          throw new AIProviderError('AI招呼语返回空内容')
        }),
      ],
      before: [],
      retryGreeting: vi.fn(),
    })

    const deliver = useDeliver()
    await expect(deliver.jobListHandle()).resolves.toBe('aiUnavailable')

    expect(sendPublishReqMock).toHaveBeenCalledTimes(1)
    expect(job.status.status).not.toBe('wait')
    expect(job.status.msg).toContain('已建立沟通')
  })
})
