import { beforeEach, describe, expect, it, vi } from 'vitest'

const { axiosMock } = vi.hoisted(() => ({
  axiosMock: vi.fn(),
}))

vi.mock('axios', () => ({ default: axiosMock }))
vi.mock('@/ui/instrument', () => ({ AgentMessage: { error: vi.fn() } }))
vi.mock('@/stores/log', () => ({ addLogTrace: vi.fn() }))
vi.mock('@/utils/logger', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))
vi.mock('@/utils/actionGateStore', () => ({
  acquireBossAction: vi.fn(async () => true),
}))

import {
  DeliveryStoppedError,
  LimitError,
  PageSessionUnavailableError,
  PublishError,
} from '@/types/deliverError'
import { ActionGateTimeoutError as GateTimeoutError } from '@/utils/actionGate'
import { acquireBossAction } from '@/utils/actionGateStore'

import { parseFiltering, requestBossData, requestDetail, sendPublishReq } from './utils'

it('classifies a missing bst token as a resumable page-session failure', async () => {
  window.Cookie = { get: vi.fn(() => undefined) } as any

  await expect(requestDetail({ securityId: 'security-1', lid: 'lid-1' })).rejects.toBeInstanceOf(
    PageSessionUnavailableError,
  )
  expect(axiosMock).not.toHaveBeenCalled()
})

it('classifies missing bst before publish and greeting follow-up as the same session failure', async () => {
  window.Cookie = { get: vi.fn(() => undefined) } as any

  await expect(
    sendPublishReq({ encryptJobId: 'job-1', securityId: 'security-1' } as any),
  ).rejects.toBeInstanceOf(PageSessionUnavailableError)
  await expect(
    requestBossData({ encryptUserId: 'boss-1', securityId: 'security-1' } as any),
  ).rejects.toBeInstanceOf(PageSessionUnavailableError)
  expect(axiosMock).not.toHaveBeenCalled()
})

it('passes BOSS communication-data requests through the detail action gate', async () => {
  vi.clearAllMocks()
  window.Cookie = { get: vi.fn(() => 'bst-token') } as any
  axiosMock.mockResolvedValueOnce({ data: { code: 0, zpData: { bossId: 1 } } })

  await expect(
    requestBossData({ encryptUserId: 'boss-1', securityId: 'security-1' } as any),
  ).resolves.toMatchObject({ bossId: 1 })
  expect(acquireBossAction).toHaveBeenCalledWith('detail', { shouldAbort: undefined })
})

it('normalizes filtering output to selected fact ids', () => {
  const result = parseFiltering(
    JSON.stringify({
      matchPercent: 78,
      level: 'good',
      reason: '岗位方向相关，但行业经验为相邻经验',
      risk: '没有直接行业项目',
      selectedFactIds: ['fact-agent-content', 'fact-b2b-saas', 'fact-agent-content'],
    }),
    70,
  )

  expect(result.passed).toBe(true)
  expect(result.data).toMatchObject({
    matchPercent: 78,
    level: 'good',
    selectedFactIds: ['fact-agent-content', 'fact-b2b-saas'],
  })
})

it('rejects a passing score without selected facts', () => {
  expect(() =>
    parseFiltering(
      JSON.stringify({ matchPercent: 80, level: 'good', reason: '相关', selectedFactIds: [] }),
      70,
    ),
  ).toThrow()
})

it('defaults filtering to the global minimum score', () => {
  const result = parseFiltering(
    JSON.stringify({
      matchPercent: 69,
      level: 'good',
      reason: '岗位方向相关',
      selectedFactIds: ['fact-agent-content'],
    }),
  )

  expect(result.passed).toBe(false)
})

it('accepts the exact configured filtering threshold', () => {
  const result = parseFiltering(
    JSON.stringify({
      matchPercent: 60,
      level: 'maybe',
      reason: '达到当前配置门槛',
      selectedFactIds: ['fact-agent-content'],
    }),
    60,
  )

  expect(result.passed).toBe(true)
})

it('keeps a legacy filtering score below the threshold for diagnostics only', () => {
  const result = parseFiltering(
    JSON.stringify({
      negative: [{ reason: '缺少行业经验', score: 20 }],
      positive: [{ reason: '岗位方向相关', score: 70 }],
    }),
    70,
  )

  expect(result).toMatchObject({
    rating: 50,
    passed: false,
    data: { selectedFactIds: [] },
  })
})

it('uses the configured threshold for a legacy filtering score too', () => {
  expect(
    parseFiltering(
      JSON.stringify({
        negative: [],
        positive: [{ reason: '岗位方向相关', score: 70 }],
      }),
      70,
    ),
  ).toMatchObject({
    rating: 70,
    passed: true,
    data: { matchPercent: 70, selectedFactIds: [] },
  })
})

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, reject, resolve }
}

function createPublishContext() {
  const data = { encryptJobId: 'job-1', securityId: 'security-1' } as any
  return { ctx: { listData: data } as any, data }
}

describe('sendPublishReq publish phase', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.Cookie = { get: vi.fn(() => 'bst-token') } as any
  })

  it('marks a dispatched request sent until its response confirms the result', async () => {
    const response = createDeferred<any>()
    axiosMock.mockReturnValueOnce(response.promise)
    const { ctx, data } = createPublishContext()

    const request = sendPublishReq(data, undefined, 3, {}, ctx)

    expect(ctx.publish).toMatchObject({ attempts: 1, phase: 'sent' })
    expect(axiosMock).toHaveBeenCalledWith(expect.objectContaining({ timeout: 15_000 }))

    response.resolve({ data: { code: 0, message: 'Success' } })
    await expect(request).resolves.toMatchObject({ code: 0 })
    expect(ctx.publish).toMatchObject({ attempts: 1, ok: true, phase: 'confirmed' })
  })

  it('marks an unconfirmed heartbeat failure unknown without dispatching publish again', async () => {
    const heartbeat = new Error('Provider unavailable: heartbeat check timeout 30000ms.')
    axiosMock.mockRejectedValue(heartbeat)
    const { ctx, data } = createPublishContext()

    await expect(sendPublishReq(data, undefined, 3, {}, ctx)).rejects.toBe(heartbeat)

    expect(axiosMock).toHaveBeenCalledTimes(1)
    expect(ctx.publish).toMatchObject({ attempts: 1, ok: false, phase: 'unknown' })
  })

  it('marks any unconfirmed network failure unknown without dispatching publish again', async () => {
    const networkError = new Error('Network Error: request timed out')
    const response = createDeferred<any>()
    axiosMock.mockReturnValue(response.promise)
    const { ctx, data } = createPublishContext()

    const request = sendPublishReq(data, undefined, 3, {}, ctx)
    expect(ctx.publish).toMatchObject({ attempts: 1, phase: 'sent' })
    response.reject(networkError)
    await expect(request).rejects.toBe(networkError)

    expect(axiosMock).toHaveBeenCalledTimes(1)
    expect(ctx.publish).toMatchObject({ attempts: 1, ok: false, phase: 'unknown' })
  })

  it('confirms the 120 reminder once and then retries publish with cid=1', async () => {
    axiosMock
      .mockResolvedValueOnce({
        data: {
          code: 1,
          message: '需要确认',
          zpData: {
            bizData: {
              chatRemindDialog: { ba: 'confirm-token', content: '您今天已与120位BOSS沟通' },
            },
          },
        },
      })
      .mockResolvedValueOnce({ data: { code: 0 } })
      .mockResolvedValueOnce({ data: { code: 0, message: 'Success' } })
    const { ctx, data } = createPublishContext()

    await expect(sendPublishReq(data, undefined, 3, {}, ctx)).resolves.toMatchObject({ code: 0 })

    expect(axiosMock).toHaveBeenCalledTimes(3)
    expect(acquireBossAction).toHaveBeenCalledWith('publish', { shouldAbort: undefined })
    expect(axiosMock.mock.calls[2]?.[0]).toMatchObject({
      params: expect.objectContaining({ cid: 1 }),
      url: 'https://www.zhipin.com/wapi/zpgeek/friend/add.json',
    })
  })

  it('stops when the 120 reminder repeats after its single confirmation', async () => {
    const reminder = {
      data: {
        code: 1,
        message: '需要确认',
        zpData: {
          bizData: {
            chatRemindDialog: { ba: 'confirm-token', content: '您今天已与120位BOSS沟通' },
          },
        },
      },
    }
    axiosMock
      .mockResolvedValueOnce(reminder)
      .mockResolvedValueOnce({ data: { code: 0 } })
      .mockResolvedValueOnce(reminder)
    const { ctx, data } = createPublishContext()

    await expect(sendPublishReq(data, undefined, 3, {}, ctx)).rejects.toBeInstanceOf(LimitError)
    expect(axiosMock).toHaveBeenCalledTimes(3)
  })

  it('preserves a user stop while confirming the 120 reminder', async () => {
    axiosMock.mockResolvedValueOnce({
      data: {
        code: 1,
        message: '需要确认',
        zpData: {
          bizData: {
            chatRemindDialog: { ba: 'confirm-token', content: '您今天已与120位BOSS沟通' },
          },
        },
      },
    })
    vi.mocked(acquireBossAction).mockRejectedValueOnce(new DeliveryStoppedError('用户已停止投递'))
    const { ctx, data } = createPublishContext()

    await expect(sendPublishReq(data, undefined, 3, {}, ctx)).rejects.toBeInstanceOf(
      DeliveryStoppedError,
    )
  })

  it('preserves an action gate timeout while confirming the 120 reminder', async () => {
    axiosMock.mockResolvedValueOnce({
      data: {
        code: 1,
        message: '需要确认',
        zpData: {
          bizData: {
            chatRemindDialog: { ba: 'confirm-token', content: '您今天已与120位BOSS沟通' },
          },
        },
      },
    })
    vi.mocked(acquireBossAction).mockRejectedValueOnce(new GateTimeoutError('publish', 15 * 60_000))
    const { ctx, data } = createPublishContext()

    await expect(sendPublishReq(data, undefined, 3, {}, ctx)).rejects.toBeInstanceOf(
      GateTimeoutError,
    )
  })

  it('reports a missing 120 confirmation token as a publish error', async () => {
    axiosMock.mockResolvedValueOnce({
      data: {
        code: 1,
        message: '需要确认',
        zpData: {
          bizData: {
            chatRemindDialog: { content: '您今天已与120位BOSS沟通' },
          },
        },
      },
    })
    const { ctx, data } = createPublishContext()

    await expect(sendPublishReq(data, undefined, 3, {}, ctx)).rejects.toMatchObject({
      name: '投递出错',
      message: '投递限制确认缺少 BOSS 校验参数',
    } satisfies Partial<PublishError>)
  })
})
