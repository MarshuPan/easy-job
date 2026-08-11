import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 同一个 BOSS 账号常常同时开着多个标签页（一个跑投递、一个看聊天），每个标签页
 * 都持有自己的内存副本。持久化如果是「拿内存快照整体覆写」，后写的标签页会静默
 * 丢掉另一个标签页刚写入的数据：投递记录会消失，投递池里已投递的岗位会退回待处理
 * 并被重复投递。这组用例用两个共享同一份 storage 的实例来模拟这个场景。
 */
const { storageData, storageGetMock, storageRmMock, storageSetMock } = vi.hoisted(() => {
  const storageData = new Map<string, unknown>()
  return {
    storageData,
    storageGetMock: vi.fn(async (key: string, fallback?: unknown) =>
      storageData.has(key) ? storageData.get(key) : fallback,
    ),
    storageRmMock: vi.fn(async (key: string) => {
      storageData.delete(key)
      return true
    }),
    storageSetMock: vi.fn(async (key: string, value: unknown) => {
      // 结构化克隆，避免两个实例共享同一个对象引用而掩盖覆盖问题。
      storageData.set(key, structuredClone(value))
      return true
    }),
  }
})

vi.mock('@/message', () => ({
  counter: {
    storageGet: storageGetMock,
    storageRm: storageRmMock,
    storageSet: storageSetMock,
  },
}))

vi.mock('@/utils/logger', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

vi.mock('@/utils/providerHealth', () => ({
  getProviderHeartbeatDiagnostic: vi.fn((error) => ({ error })),
}))

import { mergeSourcePoolSnapshots } from './jobs'
import { mergeDeliveryLogs, type log } from './log'

function deliveryRecord(jobId: string, createdAt: number, overrides: Partial<log> = {}): log {
  return {
    job: { encryptJobId: jobId, status: { status: 'success', msg: '' } } as any,
    title: `岗位-${jobId}`,
    state: 'success',
    state_name: '投递成功',
    createdAt,
    ...overrides,
  }
}

function pooledJob(encryptJobId: string, order: number, status: string) {
  return {
    encryptJobId,
    deliveryQueueOrder: order,
    deliveryQueueSource: 'search' as const,
    status: { status, msg: '' },
  } as any
}

function poolSnapshot(jobs: any[], overrides: Record<string, unknown> = {}) {
  return {
    configFingerprint: 'cfg-1a2b3c4d',
    date: '2026-08-04',
    updatedAt: 1000,
    sources: { group: [], search: jobs },
    ...overrides,
  } as any
}

describe('cross-tab delivery log merging', () => {
  beforeEach(() => {
    storageData.clear()
    vi.clearAllMocks()
  })

  it('keeps records written by another tab instead of overwriting them', () => {
    const otherTab = [deliveryRecord('job-a', 1000), deliveryRecord('job-b', 2000)]
    const thisTab = [deliveryRecord('job-c', 3000)]

    const merged = mergeDeliveryLogs(otherTab, thisTab)

    expect(merged.map((item) => item.job?.encryptJobId).sort()).toEqual(['job-a', 'job-b', 'job-c'])
  })

  it('prefers the more recently updated version of the same record', () => {
    const stale = deliveryRecord('job-a', 1000, { updatedAt: 1000, state_name: '投递中' })
    const fresh = deliveryRecord('job-a', 1000, { updatedAt: 5000, state_name: '投递成功' })

    expect(mergeDeliveryLogs([stale], [fresh])[0].state_name).toBe('投递成功')
    expect(mergeDeliveryLogs([fresh], [stale])[0].state_name).toBe('投递成功')
  })

  it('treats the same job delivered at different times as separate records', () => {
    const merged = mergeDeliveryLogs(
      [deliveryRecord('job-a', 1000)],
      [deliveryRecord('job-a', 9000)],
    )
    expect(merged).toHaveLength(2)
  })
})

describe('cross-tab delivery pool merging', () => {
  it('keeps jobs that only exist in the other tab', () => {
    const merged = mergeSourcePoolSnapshots(
      poolSnapshot([pooledJob('job-a', 1, 'success')]),
      poolSnapshot([pooledJob('job-b', 2, 'wait')]),
    )
    expect(merged.sources.search.map((item: any) => item.encryptJobId)).toEqual(['job-a', 'job-b'])
  })

  it('never downgrades a delivered job back to pending', () => {
    // 这是重复投递的直接来源：另一个标签页已投递成功，本页面内存里还是 wait。
    const merged = mergeSourcePoolSnapshots(
      poolSnapshot([pooledJob('job-a', 1, 'success')]),
      poolSnapshot([pooledJob('job-a', 1, 'wait')]),
    )
    expect(merged.sources.search).toHaveLength(1)
    expect(merged.sources.search[0].status?.status).toBe('success')
  })

  it('keeps the earliest queue order so FIFO position does not regress', () => {
    const merged = mergeSourcePoolSnapshots(
      poolSnapshot([pooledJob('job-a', 3, 'wait')]),
      poolSnapshot([pooledJob('job-a', 9, 'wait')]),
    )
    expect(merged.sources.search[0].deliveryQueueOrder).toBe(3)
  })

  it('discards a stored snapshot from a different config scope or day', () => {
    const local = poolSnapshot([pooledJob('job-local', 1, 'wait')])
    expect(
      mergeSourcePoolSnapshots(
        poolSnapshot([pooledJob('job-old', 1, 'wait')], { configFingerprint: 'cfg-other' }),
        local,
      ).sources.search.map((item: any) => item.encryptJobId),
    ).toEqual(['job-local'])
    expect(
      mergeSourcePoolSnapshots(
        poolSnapshot([pooledJob('job-old', 1, 'wait')], { date: '2026-08-03' }),
        local,
      ).sources.search.map((item: any) => item.encryptJobId),
    ).toEqual(['job-local'])
  })
})
