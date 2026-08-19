import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  clickJobCardAction,
  cacheReadyMock,
  currentSource,
  logInfoMock,
  requestDetailMock,
  storageData,
  storageGetMock,
  storageRmMock,
  storageSetMock,
  vueJobList,
} = vi.hoisted(() => ({
  clickJobCardAction: vi.fn(async () => undefined),
  cacheReadyMock: vi.fn(async (): Promise<void> => undefined),
  currentSource: { value: 'search' as 'search' | 'group' },
  logInfoMock: vi.fn(),
  requestDetailMock: vi.fn(),
  storageData: new Map<string, unknown>(),
  storageGetMock: vi.fn(async (key: string, fallback?: unknown) =>
    storageData.has(key) ? storageData.get(key) : fallback,
  ),
  storageRmMock: vi.fn(async (key: string) => {
    storageData.delete(key)
    return true
  }),
  storageSetMock: vi.fn(async (key: string, value: unknown) => {
    storageData.set(key, value)
    return true
  }),
  vueJobList: [] as any[],
}))

vi.mock('@/composables/useApplying', () => ({
  checkJobCache: vi.fn(() => null),
  getCacheManager: vi.fn(() => ({ ready: cacheReadyMock })),
  requestDetail: requestDetailMock,
}))

vi.mock('@/composables/useVue', () => ({
  useHookVueData: vi.fn(
    (_selectors: string, key: string, data: any, update?: (val: any) => void) => async () => {
      if (key === 'jobList') {
        data.value = vueJobList
        update?.(vueJobList)
      }
    },
  ),
  useHookVueFn: vi.fn(() => async () => clickJobCardAction),
}))

vi.mock('@/pages/zhipin/utils/deliveryLimit', () => ({
  getDeliveryLimitSource: vi.fn(() => currentSource.value),
}))

vi.mock('@/message', () => ({
  counter: {
    storageGet: storageGetMock,
    storageRm: storageRmMock,
    storageSet: storageSetMock,
  },
}))

vi.mock('@/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}))

vi.mock('@/stores/log', () => ({
  useLog: () => ({
    info: logInfoMock,
  }),
}))

import { JobList, sourcePoolsSessionStorageKey } from './jobs'

const sourcePoolsStorageKey = 'local:web-geek-job-SourcePools'

function today() {
  const date = new Date()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function job(overrides: Partial<bossZpJobItemData> = {}) {
  return {
    bossAvatar: '',
    bossCert: 0,
    bossName: '王老师',
    bossOnline: true,
    bossTitle: 'HR',
    brandName: '测试公司',
    brandScaleName: '100-499人',
    cityName: '上海',
    encryptBossId: 'boss-1',
    encryptJobId: 'job-1',
    goldHunter: 0,
    jobDegree: '本科',
    jobExperience: '5-10年',
    jobLabels: ['Agent'],
    jobName: 'AI 产品经理',
    lid: 'lid-1',
    salaryDesc: '30-40K',
    securityId: 'security-1',
    ...overrides,
  } as bossZpJobItemData
}

function detail(overrides: Partial<bossZpDetailData> = {}) {
  return {
    bossInfo: {
      activeTimeDesc: '刚刚活跃',
      bossOnline: true,
      brandName: '测试公司',
      certificated: true,
      name: '王老师',
      tiny: '',
      title: 'HR',
    },
    brandComInfo: {
      brandName: '测试公司',
    },
    jobInfo: {
      address: '上海',
      degreeName: '本科',
      encryptId: 'job-1',
      encryptUserId: 'boss-1',
      experienceName: '5-10年',
      jobName: 'AI 产品经理',
      locationName: '上海',
      postDescription: '负责 Agent 产品',
      proxyJob: 0,
      salaryDesc: '30-40K',
      showSkills: ['Agent'],
    },
    lid: 'lid-1',
    relationInfo: {
      beFriend: false,
      interestJob: false,
    },
    securityId: 'security-1',
    sessionId: 'session-1',
    ...overrides,
  }
}

/**
 * jobList 是模块级单例，`_list` 是裸 Ref。测试 mock 若把它写成普通数组，
 * 被测代码里的 `_list.value` 会静默变成 undefined（R1 就是同类问题）。
 */
describe('jobs store shape contract', () => {
  it('exposes _list as a ref', () => {
    const list = new JobList()
    expect(list._list).toHaveProperty('value')
    expect(Array.isArray(list._list.value)).toBe(true)
  })
})

describe('JobList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    currentSource.value = 'search'
    storageData.clear()
    window.sessionStorage.clear()
    vueJobList.length = 0
    requestDetailMock.mockResolvedValue({
      data: {
        code: 0,
        zpData: detail(),
      },
    })
    logInfoMock.mockClear()
    cacheReadyMock.mockResolvedValue(undefined)
  })

  it('restores filtered jobs as a distinct terminal state', async () => {
    storageData.set(sourcePoolsStorageKey, {
      date: today(),
      sources: {
        group: [],
        search: [
          {
            ...job({ encryptJobId: 'filtered-job' }),
            status: { status: 'filtered', msg: '已过滤' },
          },
        ],
      },
      updatedAt: Date.now(),
    })

    const list = new JobList()
    await list.initJobList({ useCache: { value: false } } as any)

    expect(list.listBySource('search')[0]?.status).toMatchObject({
      status: 'filtered',
      msg: '已过滤',
    })
  })

  it('waits for the persisted pipeline cache before creating runtime jobs', async () => {
    let releaseCache: (() => void) | undefined
    cacheReadyMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseCache = resolve
        }),
    )
    vueJobList.push(job({ encryptJobId: 'cache-gated-job' }))

    const list = new JobList()
    const initializing = list.initJobList({ useCache: { value: true } } as any)
    await vi.waitFor(() => expect(cacheReadyMock).toHaveBeenCalledOnce())

    expect(list.list).toHaveLength(0)
    expect(storageGetMock).not.toHaveBeenCalled()
    if (!releaseCache) throw new Error('缓存初始化门闩未建立')
    releaseCache()
    await initializing

    expect(cacheReadyMock).toHaveBeenCalledOnce()
    expect(list.list.map((item) => item.encryptJobId)).toEqual(['cache-gated-job'])
  })

  it('does not emit temporary JD summary diagnostic logs when the job list updates', async () => {
    vueJobList.push(
      job({
        encryptJobId: 'summary-jd-1',
        jobName: '摘要含JD岗位',
        postDescription: '这里是一段来自岗位摘要对象的完整 JD 描述，包含职责和要求。',
      } as any),
    )

    const list = new JobList()
    await list.initJobList({ useCache: { value: false } } as any)

    expect(logInfoMock).not.toHaveBeenCalledWith('JD概要诊断', expect.any(String))
  })

  it('restores same-day source pools from extension storage after a fresh runtime starts', async () => {
    storageData.set(sourcePoolsStorageKey, {
      date: today(),
      sources: {
        group: [job({ encryptJobId: 'stored-group-1', lid: 'lid-group-1' })],
        search: [
          job({ encryptJobId: 'stored-search-1', lid: 'lid-search-1' }),
          job({ encryptJobId: 'stored-search-2', lid: 'lid-search-2' }),
        ],
      },
      updatedAt: Date.now(),
    })
    vueJobList.push(job({ encryptJobId: 'current-search-1', lid: 'lid-current-1' }))

    const list = new JobList()
    await list.initJobList({ useCache: { value: false } } as any)

    expect(list.listBySource('search').map((item) => item.encryptJobId)).toEqual([
      'stored-search-1',
      'stored-search-2',
    ])
    expect(list.listBySource('group').map((item) => item.encryptJobId)).toEqual(['stored-group-1'])

    const restored = list.get('stored-search-1')
    expect(restored?.status.status).toBe('pending')
    restored?.status.setStatus('success', '已恢复')
    expect(restored?.status).toMatchObject({ status: 'success', msg: '已恢复' })

    await restored?.getCard()
    expect(requestDetailMock).toHaveBeenCalledWith({
      lid: 'lid-search-1',
      securityId: 'security-1',
    })
  })

  it('keeps the current page out of the delivery pool until capture is enabled', async () => {
    vueJobList.push(job({ encryptJobId: 'page-job-1', lid: 'page-lid-1' }))

    const list = new JobList()
    await list.initJobList({ useCache: { value: false } } as any)

    expect(list.list.map((item) => item.encryptJobId)).toEqual(['page-job-1'])
    expect(list.listBySource('search')).toHaveLength(0)

    list.setDeliveryPoolCaptureEnabled(true)
    expect(list.captureCurrentPageToDeliveryPool('search')).toBe(1)
    expect(list.listBySource('search').map((item) => item.encryptJobId)).toEqual(['page-job-1'])
  })

  it('keeps jobs the caller rules out from taking up delivery pool slots', async () => {
    // 池子的水位是「还能投几个」，不是「还剩几条记录」。必然投不出去的岗位一旦入池，
    // 水位就是虚的，补池不触发，整轮都在同一批死数据里打转。
    vueJobList.push(
      job({ encryptJobId: 'fresh-job', lid: 'fresh-lid' }),
      job({ encryptJobId: 'dupe-job', lid: 'dupe-lid' }),
    )

    const list = new JobList()
    await list.initJobList({ useCache: { value: false } } as any)
    list.setDeliveryPoolCaptureEnabled(true)

    const captured = list.captureCurrentPageToDeliveryPool(
      'search',
      undefined,
      undefined,
      (item) => item.encryptJobId !== 'dupe-job',
    )

    expect(captured).toBe(1)
    expect(list.listBySource('search').map((item) => item.encryptJobId)).toEqual(['fresh-job'])
  })

  it('persists merged source pools so fetched jobs survive a later runtime', async () => {
    const list = new JobList()
    list.setDeliveryPoolCaptureEnabled(true)

    vueJobList.push(job({ encryptJobId: 'job-page-1', lid: 'lid-page-1' }))
    await list.initJobList({ useCache: { value: false } } as any)

    vueJobList.length = 0
    vueJobList.push(job({ encryptJobId: 'job-page-2', lid: 'lid-page-2' }))
    await list.initJobList({ useCache: { value: false } } as any)

    await new Promise((resolve) => window.setTimeout(resolve, 160))

    expect(storageSetMock).toHaveBeenCalledWith(
      sourcePoolsStorageKey,
      expect.objectContaining({
        date: today(),
        sources: expect.objectContaining({
          search: expect.arrayContaining([
            expect.objectContaining({ encryptJobId: 'job-page-1' }),
            expect.objectContaining({ encryptJobId: 'job-page-2' }),
          ]),
        }),
      }),
    )

    list.get('job-page-1')?.status.setStatus('success', '已投递')
    await new Promise((resolve) => window.setTimeout(resolve, 160))

    const saved = storageData.get(sourcePoolsStorageKey) as any
    expect(
      saved.sources.search.find((item: any) => item.encryptJobId === 'job-page-1')?.status,
    ).toEqual({
      status: 'success',
      msg: '已投递',
    })
  })

  /**
   * 两个标签页各自持有内存副本。写入若是整体覆写，后写的一方会丢掉另一方的岗位，
   * 已投递的岗位会退回待处理并被重复投递。
   */
  it('logs when another tab’s jobs are merged back in', async () => {
    // 合并本身是静默的：岗位数对上了就没人会去查。一旦合并逻辑出错，
    // 现象是「投递池莫名变少」，没有这条日志就无从追查。
    const tabA = new JobList()
    const tabB = new JobList()
    tabA.setDeliveryPoolCaptureEnabled(true)
    tabB.setDeliveryPoolCaptureEnabled(true)

    vueJobList.length = 0
    await tabB.initJobList({ useCache: { value: false } } as any)

    vueJobList.length = 0
    vueJobList.push(job({ encryptJobId: 'from-a', lid: 'lid-a' }))
    await tabA.initJobList({ useCache: { value: false } } as any)
    await tabA.flushSourcePools()

    vueJobList.length = 0
    vueJobList.push(job({ encryptJobId: 'from-b', lid: 'lid-b' }))
    await tabB.initJobList({ useCache: { value: false } } as any)
    logInfoMock.mockClear()
    await tabB.flushSourcePools()

    expect(logInfoMock).toHaveBeenCalledWith(
      '投递池',
      expect.stringContaining('已合并其他标签页的投递池'),
    )
  })

  it('logs when the pre-merge read fails and the write degrades to an overwrite', async () => {
    const list = new JobList()
    list.setDeliveryPoolCaptureEnabled(true)
    vueJobList.push(job({ encryptJobId: 'only-job' }))
    await list.initJobList({ useCache: { value: false } } as any)

    storageGetMock.mockRejectedValueOnce(new Error('storage unavailable'))
    logInfoMock.mockClear()
    await list.flushSourcePools()

    expect(logInfoMock).toHaveBeenCalledWith('投递池', expect.stringContaining('合并前读取失败'))
  })

  it('does not let a second tab overwrite jobs persisted by the first', async () => {
    const tabA = new JobList()
    const tabB = new JobList()
    tabA.setDeliveryPoolCaptureEnabled(true)
    tabB.setDeliveryPoolCaptureEnabled(true)

    // 关键：两个标签页都要在对方写入之前完成 hydrate，否则后启动的一方会
    // 顺带读到对方的数据，覆盖问题就被掩盖了（投递池 hydrate 只发生一次）。
    vueJobList.length = 0
    await tabB.initJobList({ useCache: { value: false } } as any)

    vueJobList.length = 0
    vueJobList.push(job({ encryptJobId: 'job-from-tab-a', lid: 'lid-a' }))
    await tabA.initJobList({ useCache: { value: false } } as any)
    tabA.get('job-from-tab-a')?.status.setStatus('success', '已投递')
    await tabA.flushSourcePools()

    // tabB 的内存副本里没有 job-from-tab-a：它在 tabA 写入之前就 hydrate 完了。
    vueJobList.length = 0
    vueJobList.push(job({ encryptJobId: 'job-from-tab-b', lid: 'lid-b' }))
    await tabB.initJobList({ useCache: { value: false } } as any)
    await tabB.flushSourcePools()

    const saved = storageData.get(sourcePoolsStorageKey) as any
    const savedIds = saved.sources.search.map((item: any) => item.encryptJobId).sort()
    expect(savedIds).toEqual(['job-from-tab-a', 'job-from-tab-b'])
    // 第一个标签页记录的投递状态必须保留，否则该岗位会被重复投递。
    expect(
      saved.sources.search.find((item: any) => item.encryptJobId === 'job-from-tab-a')?.status
        ?.status,
    ).toBe('success')
  })

  it('persists and restores acquisition metadata for queued expectation jobs', async () => {
    currentSource.value = 'group'
    const list = new JobList()
    list.setDeliveryPoolCaptureEnabled(true)
    vueJobList.push(job({ encryptJobId: 'group-job-1', lid: 'group-lid-1' }))
    await list.initJobList({ useCache: { value: false } } as any)

    expect(list.captureCurrentPageToDeliveryPool('group', 'expectation-1')).toBe(0)
    const captured = list.get('group-job-1')
    expect(captured?.fetchedAt).toEqual(expect.any(Number))
    expect(captured?.deliveryGroupTargetIds).toEqual(['expectation-1'])
    if (captured) captured.retryAttempts = 2
    await list.flushSourcePools()

    vueJobList.length = 0
    const restoredRuntime = new JobList()
    await restoredRuntime.initJobList({ useCache: { value: false } } as any)

    expect(restoredRuntime.get('group-job-1')).toMatchObject({
      deliveryGroupTargetIds: ['expectation-1'],
      deliveryQueueOrder: 1,
      deliveryQueueSource: 'group',
      fetchedAt: expect.any(Number),
      retryAttempts: 2,
    })
  })

  it('persists and restores the search direction that acquired a queued job', async () => {
    const list = new JobList()
    list.setDeliveryPoolCaptureEnabled(true)
    vueJobList.push(job({ encryptJobId: 'search-job-1', lid: 'search-lid-1' }))
    await list.initJobList({ useCache: { value: false } } as any)

    expect(list.captureCurrentPageToDeliveryPool('search', undefined, ' AI 产品经理 ')).toBe(0)
    await list.flushSourcePools()

    vueJobList.length = 0
    const restoredRuntime = new JobList()
    await restoredRuntime.initJobList({ useCache: { value: false } } as any)

    expect(restoredRuntime.get('search-job-1')?.deliverySearchDirectionKeys).toEqual(['ai产品经理'])
  })

  it('publishes one FIFO snapshot using the source that first acquired each job', async () => {
    const list = new JobList()
    vueJobList.push(job({ encryptJobId: 'shared-job-1', lid: 'shared-lid-1' }))
    await list.initJobList({ useCache: { value: false } } as any)

    const initialRevision = list.deliveryQueueRevision
    expect(list.captureCurrentPageToDeliveryPool('search', undefined, 'AI 产品经理')).toBe(1)
    expect(list.captureCurrentPageToDeliveryPool('group', 'expectation-1')).toBe(1)

    const snapshot = list.readDeliveryQueueSnapshot()
    expect(snapshot.revision).toBeGreaterThan(initialRevision)
    expect(snapshot.sources.group).toEqual([])
    expect(snapshot.sources.search.map((item) => item.encryptJobId)).toEqual(['shared-job-1'])
    expect([...snapshot.sources.group, ...snapshot.sources.search]).toHaveLength(1)

    const statusRevision = list.deliveryQueueRevision
    list.get('shared-job-1')?.status.setStatus('success', '已投递')
    expect(list.deliveryQueueRevision).toBeGreaterThan(statusRevision)
    expect(list.readDeliveryQueueSnapshot().sources.search[0]?.status.status).toBe('success')
  })

  it('drops incompatible pending jobs while preserving completed records', async () => {
    storageData.set(sourcePoolsStorageKey, {
      date: today(),
      sources: {
        group: [
          {
            ...job({ encryptJobId: 'disabled-group-job' }),
            deliveryGroupTargetIds: ['expectation-old'],
          },
          {
            ...job({ encryptJobId: 'completed-group-job' }),
            deliveryGroupTargetIds: ['expectation-old'],
            status: { status: 'success', msg: '已投递' },
          },
        ],
        search: [
          {
            ...job({ encryptJobId: 'enabled-search-job' }),
            deliverySearchDirectionKeys: ['ai产品经理'],
          },
          {
            ...job({ encryptJobId: 'disabled-search-job' }),
            deliverySearchDirectionKeys: ['java开发'],
          },
        ],
      },
      updatedAt: Date.now(),
    })
    const list = new JobList()
    list.setConfigScope({
      fingerprint: 'cfg-current',
      groupEnabled: true,
      enabledGroupTargetIds: ['expectation-current'],
      searchEnabled: true,
      searchDirectionKeys: ['ai产品经理'],
    })
    await list.initJobList({ useCache: { value: false } } as any)

    expect(list.listBySource('group').map((item) => item.encryptJobId)).toEqual([
      'completed-group-job',
    ])
    expect(list.listBySource('search').map((item) => item.encryptJobId)).toEqual([
      'enabled-search-job',
    ])
  })

  it('does not restore the tab snapshot before the extension backup is durable', async () => {
    const firstRuntime = new JobList()
    firstRuntime.setDeliveryPoolCaptureEnabled(true)
    vueJobList.push(job({ encryptJobId: 'session-job-1', lid: 'session-lid-1' }))
    await firstRuntime.initJobList({ useCache: { value: false } } as any)

    expect(storageSetMock).not.toHaveBeenCalled()
    expect(window.sessionStorage.getItem(sourcePoolsSessionStorageKey)).not.toBeNull()

    vueJobList.length = 0
    const refreshedRuntime = new JobList()
    await refreshedRuntime.initJobList({ useCache: { value: false } } as any)

    expect(refreshedRuntime.listBySource('search')).toHaveLength(0)

    await firstRuntime.flushSourcePools()
  })

  it('keeps the extension backup authoritative when a tab snapshot is newer', async () => {
    storageData.set(sourcePoolsStorageKey, {
      date: today(),
      sources: { group: [], search: [job({ encryptJobId: 'older-extension-job' })] },
      updatedAt: 100,
    })
    window.sessionStorage.setItem(
      sourcePoolsSessionStorageKey,
      JSON.stringify({
        date: today(),
        sources: { group: [], search: [job({ encryptJobId: 'newer-session-job' })] },
        updatedAt: 200,
      }),
    )

    const list = new JobList()
    await list.initJobList({ useCache: { value: false } } as any)

    expect(list.listBySource('search').map((item) => item.encryptJobId)).toEqual([
      'older-extension-job',
    ])
    await list.flushSourcePools()
  })

  it('does not restore a tab snapshot when extension storage communication fails', async () => {
    window.sessionStorage.setItem(
      sourcePoolsSessionStorageKey,
      JSON.stringify({
        date: today(),
        sources: { group: [], search: [job({ encryptJobId: 'offline-session-job' })] },
        updatedAt: Date.now(),
      }),
    )
    storageGetMock.mockRejectedValueOnce(new Error('extension runtime unavailable'))

    const list = new JobList()
    await list.initJobList({ useCache: { value: false } } as any)

    expect(list.listBySource('search')).toHaveLength(0)
    await list.flushSourcePools()
  })

  it('restores completed job status instead of returning the job to the pending pool', async () => {
    storageData.set(sourcePoolsStorageKey, {
      date: today(),
      sources: {
        group: [],
        search: [
          {
            ...job({ encryptJobId: 'completed-session-job' }),
            status: { status: 'success', msg: '已投递' },
          },
        ],
      },
      updatedAt: Date.now(),
    })

    const list = new JobList()
    await list.initJobList({ useCache: { value: false } } as any)

    const restored = list.get('completed-session-job')
    expect(restored?.status).toMatchObject({ status: 'success', msg: '已投递' })
    expect(
      list
        .listBySource('search')
        .filter((item) => ['pending', 'wait', 'running'].includes(item.status.status)),
    ).toHaveLength(0)
    await list.flushSourcePools()
  })

  it('marks an interrupted persisted job for manual verification during restore', async () => {
    storageData.set(sourcePoolsStorageKey, {
      date: today(),
      sources: {
        group: [],
        search: [
          {
            ...job({ encryptJobId: 'interrupted-session-job' }),
            status: { status: 'running', msg: '正在建立沟通' },
          },
        ],
      },
      updatedAt: Date.now(),
    })

    const list = new JobList()
    await list.initJobList({ useCache: { value: false } } as any)

    expect(list.get('interrupted-session-job')?.status).toMatchObject({
      status: 'warn',
      msg: expect.stringContaining('结果不确定'),
    })
  })

  it('finishes an in-flight account restore before switching source-pool keys', async () => {
    const accountAKey = `${sourcePoolsStorageKey}:account-a`
    const accountBKey = `${sourcePoolsStorageKey}:account-b`
    const accountASnapshot = {
      date: today(),
      sources: { group: [], search: [job({ encryptJobId: 'account-a-job' })] },
      updatedAt: 100,
    }
    const accountBSnapshot = {
      date: today(),
      sources: { group: [], search: [job({ encryptJobId: 'account-b-job' })] },
      updatedAt: 200,
    }
    storageData.set(accountBKey, accountBSnapshot)
    let releaseAccountA!: () => void
    // 只挂起第一次读取。flush 现在会在写入前重新读取以合并其他标签页的数据，
    // 若每次读都新建一个 promise 并覆盖 resolver，最初那次挂起将永远解不开。
    let accountAGate: Promise<void> | null = new Promise<void>((resolve) => {
      releaseAccountA = resolve
    })
    storageGetMock.mockImplementation(async (key: string, fallback?: unknown) => {
      if (key === accountAKey) {
        if (accountAGate != null) {
          const gate = accountAGate
          accountAGate = null
          await gate
        }
        return accountASnapshot
      }
      return storageData.has(key) ? storageData.get(key) : fallback
    })

    const list = new JobList()
    await list.setAccountScope('account-a')
    const hydratingA = list.initJobList({ useCache: { value: false } } as any)
    await vi.waitFor(() => expect(releaseAccountA).toBeTypeOf('function'))
    const switchingToB = list.setAccountScope('account-b')

    releaseAccountA()
    await hydratingA
    await switchingToB
    await list.initJobList({ useCache: { value: false } } as any)

    expect(list.listBySource('search').map((item) => item.encryptJobId)).toEqual(['account-b-job'])
    expect(storageData.get(accountBKey)).toEqual(accountBSnapshot)
  })

  it('projects platform jobs to clone-safe fields before saving snapshots', async () => {
    const unsafeJob = job({ encryptJobId: 'unsafe-platform-job' }) as any
    unsafeJob.iconFlagList = [unsafeJob]
    unsafeJob.platformRuntime = () => undefined
    vueJobList.push(unsafeJob)

    const list = new JobList()
    list.setDeliveryPoolCaptureEnabled(true)
    await list.initJobList({ useCache: { value: false } } as any)
    await list.flushSourcePools()

    const sessionSnapshot = JSON.parse(
      window.sessionStorage.getItem(sourcePoolsSessionStorageKey) ?? '{}',
    )
    const savedJob = sessionSnapshot.sources.search[0]
    expect(savedJob.iconFlagList).toEqual([])
    expect(savedJob).not.toHaveProperty('platformRuntime')
    expect(() => structuredClone(storageData.get(sourcePoolsStorageKey))).not.toThrow()
  })

  it('loads job detail through the detail API before falling back to page clicks', async () => {
    vueJobList.push({
      brandName: '测试公司',
      encryptJobId: 'job-1',
      jobName: 'AI 产品经理',
      lid: 'lid-1',
      securityId: 'security-1',
    })

    const list = new JobList()
    await list.initJobList({ useCache: { value: false } } as any)
    const card = await list.list[0].getCard()

    expect(requestDetailMock).toHaveBeenCalledWith({
      lid: 'lid-1',
      securityId: 'security-1',
    })
    expect(clickJobCardAction).not.toHaveBeenCalled()
    expect(card.postDescription).toBe('负责 Agent 产品')
    expect(card.friendStatus).toBe(0)
  })

  it('maps the real detail relation into the runtime friend status', async () => {
    requestDetailMock.mockResolvedValueOnce({
      data: {
        code: 0,
        zpData: detail({
          relationInfo: {
            beFriend: true,
            interestJob: false,
          } as bossZpDetailData['relationInfo'],
        }),
      },
    })
    vueJobList.push(job())

    const list = new JobList()
    await list.initJobList({ useCache: { value: false } } as any)
    const card = await list.list[0].getCard()

    expect(card.friendStatus).toBe(1)
  })

  it('keeps a cross-page source pool instead of replacing the source with the latest page', async () => {
    const list = new JobList()
    list.setDeliveryPoolCaptureEnabled(true)

    vueJobList.push({
      brandName: '第一页公司',
      encryptJobId: 'job-page-1',
      jobName: '第一页岗位',
      lid: 'lid-page-1',
      securityId: 'security-page-1',
    })
    await list.initJobList({ useCache: { value: false } } as any)

    vueJobList.length = 0
    vueJobList.push({
      brandName: '第二页公司',
      encryptJobId: 'job-page-2',
      jobName: '第二页岗位',
      lid: 'lid-page-2',
      securityId: 'security-page-2',
    })
    await list.initJobList({ useCache: { value: false } } as any)

    expect(list.listBySource('search').map((item) => item.encryptJobId)).toEqual([
      'job-page-1',
      'job-page-2',
    ])
    expect(list.get('job-page-1')).toBeDefined()
    expect(list.get('job-page-2')).toBeDefined()
  })

  it('does not fall back to page clicking when a pooled job is no longer on the current page', async () => {
    const list = new JobList()
    list.setDeliveryPoolCaptureEnabled(true)

    vueJobList.push({
      brandName: '第一页公司',
      encryptJobId: 'job-page-1',
      jobName: '第一页岗位',
      lid: 'lid-page-1',
      securityId: 'security-page-1',
    })
    await list.initJobList({ useCache: { value: false } } as any)

    vueJobList.length = 0
    vueJobList.push({
      brandName: '第二页公司',
      encryptJobId: 'job-page-2',
      jobName: '第二页岗位',
      lid: 'lid-page-2',
      securityId: 'security-page-2',
    })
    await list.initJobList({ useCache: { value: false } } as any)

    requestDetailMock.mockRejectedValueOnce(new Error('detail api failed'))

    // 报错要带上真实原因。原来这里断言的是代码自己编的「岗位已下线」——那句话把真正的
    // 失败原因盖掉了，真机上连续十几个岗位失败时，日志里查不到任何线索。
    await expect(list.get('job-page-1')?.getCard()).rejects.toThrow('detail api failed')
    expect(clickJobCardAction).not.toHaveBeenCalled()
  })

  // BOSS 用不同的 code 表示不同的拒绝原因，而处理方式完全不同：会话额度只能接受，
  // Zp_token 失效和 lid 过期是可修的。原来这里写的是 `message || code`——message 有值
  // 时 code 就被丢掉，于是连着三轮真机日志里全是同一句「您的环境存在异常.」，
  // 分不出是哪一种。两个都必须留下。
  // 走的是「岗位已经不在当前页」这条路，跟上面那个用例一样——否则失败会退回点卡片，
  // 一等就是 60 秒，测的就不是接口返回的这句话了。
  async function pooledJobFromAnEarlierPage(id: string) {
    const list = new JobList()
    list.setDeliveryPoolCaptureEnabled(true)
    vueJobList.push({
      brandName: '第一页公司',
      encryptJobId: id,
      jobName: '第一页岗位',
      lid: `lid-${id}`,
      securityId: `security-${id}`,
    })
    await list.initJobList({ useCache: { value: false } } as any)
    vueJobList.length = 0
    await list.initJobList({ useCache: { value: false } } as any)
    return list
  }

  it('records the BOSS error code alongside the message', async () => {
    const list = await pooledJobFromAnEarlierPage('job-coded')
    requestDetailMock.mockResolvedValueOnce({
      data: { code: 37, message: '您的环境存在异常.', zpData: null },
    })

    const card = list.get('job-coded')?.getCard()
    await expect(card).rejects.toThrow(/37/)
    // 两个都要在，不是二选一。
    await expect(card).rejects.toThrow(/您的环境存在异常/)
  })

  it('still says something useful when BOSS sends a code with no message', async () => {
    const list = await pooledJobFromAnEarlierPage('job-bare')
    requestDetailMock.mockResolvedValueOnce({ data: { code: 500, message: '', zpData: null } })

    // 不能退化成「详情接口返回异常：」这种后面什么都没有的空句子。
    await expect(list.get('job-bare')?.getCard()).rejects.toThrow(/500/)
  })
})

const poolIds = (list: JobList, source: 'group' | 'search') =>
  list.readDeliveryQueueSnapshot().sources[source].map((item) => item.encryptJobId)

describe('delivery pool survives a page refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storageData.clear()
    vueJobList.length = 0
  })

  // 真实页面初始化顺序（Ui.vue）是：setAccountScope → setConfigScope → initJobList。
  // 已有的恢复用例都没有设置配置作用域，因此 restoreSourcePools 内部的
  // filterIncompatiblePendingJobs 在测试里始终是空操作，刷新丢池子的问题照不出来。
  const scope = {
    fingerprint: 'fp-1',
    groupEnabled: true,
    enabledGroupTargetIds: ['recommend', 'expectation-1'],
    searchEnabled: true,
    searchDirectionKeys: ['ai产品经理'],
  }

  it('keeps a queued job that was captured without a resolvable group target', async () => {
    currentSource.value = 'group'
    const list = new JobList()
    list.setDeliveryPoolCaptureEnabled(true)
    vueJobList.push(job({ encryptJobId: 'group-untagged', lid: 'lid-untagged' }))
    await list.initJobList({ useCache: { value: false } } as any)
    // groupTargetId 解析不出来时（推荐页没有选中的求职期望、任务步骤里也没有），
    // OperationPanel 会以 undefined 调用，岗位入池但不带任何 target id。
    list.captureCurrentPageToDeliveryPool('group', undefined)
    await list.flushSourcePools()

    vueJobList.length = 0
    const refreshed = new JobList()
    refreshed.setConfigScope(scope)
    await refreshed.initJobList({ useCache: { value: false } } as any)

    expect(poolIds(refreshed, 'group')).toContain('group-untagged')
  })

  it('keeps a queued search job that was captured without a resolvable direction', async () => {
    currentSource.value = 'search'
    const list = new JobList()
    list.setDeliveryPoolCaptureEnabled(true)
    vueJobList.push(job({ encryptJobId: 'search-untagged', lid: 'lid-search' }))
    await list.initJobList({ useCache: { value: false } } as any)
    list.captureCurrentPageToDeliveryPool('search', undefined, undefined)
    await list.flushSourcePools()

    vueJobList.length = 0
    const refreshed = new JobList()
    refreshed.setConfigScope(scope)
    await refreshed.initJobList({ useCache: { value: false } } as any)

    expect(poolIds(refreshed, 'search')).toContain('search-untagged')
  })
})

describe('config scope still evicts jobs from a disabled source', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storageData.clear()
    vueJobList.length = 0
  })

  it('drops queued jobs when the whole source is turned off', async () => {
    currentSource.value = 'group'
    const list = new JobList()
    list.setDeliveryPoolCaptureEnabled(true)
    vueJobList.push(job({ encryptJobId: 'group-untagged-2', lid: 'lid-untagged-2' }))
    await list.initJobList({ useCache: { value: false } } as any)
    list.captureCurrentPageToDeliveryPool('group', undefined)

    expect(
      list.setConfigScope({
        fingerprint: 'fp-off',
        groupEnabled: false,
        enabledGroupTargetIds: [],
        searchEnabled: true,
        searchDirectionKeys: ['ai产品经理'],
      }),
    ).toBe(1)
    expect(poolIds(list, 'group')).not.toContain('group-untagged-2')
  })

  it('drops queued jobs whose own expectation was turned off', async () => {
    currentSource.value = 'group'
    const list = new JobList()
    list.setDeliveryPoolCaptureEnabled(true)
    vueJobList.push(job({ encryptJobId: 'group-tagged', lid: 'lid-tagged' }))
    await list.initJobList({ useCache: { value: false } } as any)
    list.captureCurrentPageToDeliveryPool('group', 'expectation-gone')

    expect(
      list.setConfigScope({
        fingerprint: 'fp-2',
        groupEnabled: true,
        enabledGroupTargetIds: ['expectation-1'],
        searchEnabled: true,
        searchDirectionKeys: ['ai产品经理'],
      }),
    ).toBe(1)
    expect(poolIds(list, 'group')).not.toContain('group-tagged')
  })
})

describe('resetting the delivery pool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storageData.clear()
    vueJobList.length = 0
  })

  it('resets the whole pool, not just the jobs visible on the current page', async () => {
    // 面板原来遍历当前页列表（通常十几个），而投递池常有上百个，
    // 「重置待处理」实际只覆盖了很小一部分。
    currentSource.value = 'group'
    const list = new JobList()
    list.setDeliveryPoolCaptureEnabled(true)
    // 第一页抓一个岗位入池，然后翻到第二页——第一页的岗位留在投递池里，
    // 但已经不在当前页列表中，正是「重置」原来漏掉的那部分。
    vueJobList.push(job({ encryptJobId: 'off-page', lid: 'lid-2' }))
    await list.initJobList({ useCache: { value: false } } as any)
    list.captureCurrentPageToDeliveryPool('group', 'expectation-1')
    vueJobList.length = 0
    vueJobList.push(job({ encryptJobId: 'on-page', lid: 'lid-1' }))
    await list.initJobList({ useCache: { value: false } } as any)
    list.captureCurrentPageToDeliveryPool('group', 'expectation-1')

    expect(list.list.map((item) => item.encryptJobId)).toEqual(['on-page'])
    list.get('on-page')!.status.setStatus('filtered', '已过滤')
    list.get('off-page')!.status.setStatus('filtered', '已过滤')

    expect(list.resetPendingDeliveryPool()).toBe(2)
    expect(list.get('on-page')?.status.status).toBe('wait')
    expect(list.get('off-page')?.status.status).toBe('wait')
  })

  it('never drags a delivered job back into the queue', async () => {
    currentSource.value = 'group'
    const list = new JobList()
    list.setDeliveryPoolCaptureEnabled(true)
    vueJobList.push(job({ encryptJobId: 'delivered', lid: 'lid-3' }))
    await list.initJobList({ useCache: { value: false } } as any)
    list.captureCurrentPageToDeliveryPool('group', 'expectation-1')
    list.get('delivered')!.status.setStatus('success', '投递成功')

    expect(list.resetPendingDeliveryPool()).toBe(0)
    expect(list.get('delivered')?.status.status).toBe('success')
  })
})
