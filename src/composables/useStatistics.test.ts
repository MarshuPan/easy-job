import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { storageData, storageGetMock, storageSetMock, watchCallbacks } = vi.hoisted(() => {
  const storageData = new Map<string, unknown>()
  return {
    storageData,
    storageGetMock: vi.fn(async (key: string, fallback?: unknown) =>
      storageData.has(key) ? structuredClone(storageData.get(key)) : fallback,
    ),
    storageSetMock: vi.fn(async (key: string, value: unknown) => {
      storageData.set(key, structuredClone(value))
    }),
    watchCallbacks: [] as Array<(value: any) => void>,
  }
})

vi.mock('@vueuse/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vueuse/core')>()
  return {
    ...actual,
    watchThrottled: vi.fn((_source, callback) => {
      watchCallbacks.push(callback)
    }),
  }
})

vi.mock('#imports', async () => {
  const { ref } = await import('vue')
  return { ref }
})

vi.mock('@/message', () => ({
  counter: {
    storageGet: storageGetMock,
    storageSet: storageSetMock,
  },
}))

vi.mock('@/utils', () => ({
  getCurDay: (date = new Date()) => {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  },
}))

vi.mock('@/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
  },
}))

vi.mock('@/utils/providerHealth', () => ({
  getProviderHeartbeatDiagnostic: vi.fn((error: unknown) => ({ error: String(error) })),
}))

import { createEmptyStatistics, useStatistics } from './useStatistics'

function statistics(date: string, success = 0) {
  return {
    date,
    success,
    searchSuccess: success,
    groupSuccess: 0,
    searchTotal: success,
    groupTotal: 0,
    searchFiltered: 0,
    groupFiltered: 0,
    total: success,
    company: 0,
    jobTitle: 0,
    jobContent: 0,
    aiFiltering: 0,
    hrPosition: 0,
    salaryRange: 0,
    companySizeRange: 0,
    activityFilter: 0,
    goldHunterFilter: 0,
    repeat: 0,
    jobAddress: 0,
    amap: 0,
  }
}

function createDeferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/**
 * 统计计数器由 `todayData.<field>++` 直接递增，缺字段不会报错、只会静默产生 NaN。
 * 实现与测试因此必须共用 createEmptyStatistics 的字段全集：
 * handles.test.ts 曾把 useStatistics mock 成 { todayData: {} }，
 * 导致 14 个过滤计数器全部无覆盖。
 */
describe('statistics field contract', () => {
  const requiredFields = [
    'date',
    'success',
    'searchSuccess',
    'groupSuccess',
    'searchTotal',
    'groupTotal',
    'searchFiltered',
    'groupFiltered',
    'total',
    'jobContent',
    'aiFiltering',
    'companySizeRange',
    'activityFilter',
    'goldHunterFilter',
    'repeat',
    'amap',
  ] as const

  it('initialises every counter the delivery pipeline increments', () => {
    const empty = createEmptyStatistics('2026-08-04') as unknown as Record<string, unknown>
    expect(Object.keys(empty).sort()).toEqual([...requiredFields].sort())
    for (const field of requiredFields) {
      if (field === 'date') continue
      expect(empty[field], `${field} 必须初始化为 0，否则 ++ 会得到 NaN`).toBe(0)
    }
  })

  it('exposes todayData as a plain reactive object, not a ref', () => {
    setActivePinia(createPinia())
    const todayData = useStatistics().todayData as Record<string, unknown>
    expect(todayData).not.toHaveProperty('value')
    expect(Object.keys(todayData).sort()).toEqual([...requiredFields].sort())
  })
})

describe('useStatistics daily rollover', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 9, 23, 59))
    setActivePinia(createPinia())
    storageData.clear()
    storageData.set('local:web-geek-job-Today', statistics('2026-07-09', 2))
    storageData.set('local:web-geek-job-Statistics', [])
    watchCallbacks.length = 0
    vi.clearAllMocks()
    storageGetMock.mockReset()
    storageGetMock.mockImplementation(async (key: string, fallback?: unknown) =>
      storageData.has(key) ? structuredClone(storageData.get(key)) : fallback,
    )
    storageSetMock.mockReset()
    storageSetMock.mockImplementation(async (key: string, value: unknown) => {
      storageData.set(key, structuredClone(value))
    })
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined })
  })

  afterEach(() => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined })
    vi.useRealTimers()
  })

  it('rolls a store created before midnight into the current call-time date', async () => {
    const store = useStatistics()
    await store.updateStatistics()

    vi.setSystemTime(new Date(2026, 6, 10, 0, 1))
    await store.updateStatistics()

    expect(store.todayData.date).toBe('2026-07-10')
    expect(store.todayData.success).toBe(0)
    expect(storageData.get('local:web-geek-job-Today')).toMatchObject({
      date: '2026-07-10',
      success: 0,
    })
    expect(storageData.get('local:web-geek-job-Statistics')).toEqual([
      expect.objectContaining({ date: '2026-07-09', success: 2 }),
    ])
  })

  it('adopts new-day storage written by another tab instead of overwriting it', async () => {
    const store = useStatistics()
    await store.updateStatistics()

    vi.setSystemTime(new Date(2026, 6, 10, 0, 1))
    storageData.set('local:web-geek-job-Today', statistics('2026-07-10', 3))
    storageSetMock.mockClear()

    await store.updateStatistics()

    expect(store.todayData).toMatchObject({ date: '2026-07-10', success: 3 })
    expect(storageData.get('local:web-geek-job-Today')).toMatchObject({
      date: '2026-07-10',
      success: 3,
    })
    expect(storageSetMock).not.toHaveBeenCalledWith(
      'local:web-geek-job-Today',
      expect.objectContaining({ date: '2026-07-09' }),
    )
  })

  it('keeps loading archived statistics on same-day updates', async () => {
    storageData.set('local:web-geek-job-Statistics', [statistics('2026-07-08', 5)])

    const store = useStatistics()
    await store.updateStatistics()

    expect(store.statisticsData).toEqual([
      expect.objectContaining({ date: '2026-07-08', success: 5 }),
    ])
  })

  it('serializes deferred automatic saves from two stores so an old day cannot win', async () => {
    const firstStore = useStatistics()
    const oldWriteStarted = createDeferred()
    const releaseOldWrite = createDeferred()
    const oldWriteFinished = createDeferred()
    const newWriteFinished = createDeferred()
    let todayWrites = 0
    storageSetMock.mockImplementation(async (key: string, value: unknown) => {
      if (key !== 'local:web-geek-job-Today') {
        storageData.set(key, structuredClone(value))
        return
      }
      const writeNumber = ++todayWrites
      if (writeNumber === 1) {
        oldWriteStarted.resolve()
        await releaseOldWrite.promise
      }
      storageData.set(key, structuredClone(value))
      if (writeNumber === 1) oldWriteFinished.resolve()
      else newWriteFinished.resolve()
    })

    watchCallbacks[0](statistics('2026-07-09', 7))
    await oldWriteStarted.promise

    vi.setSystemTime(new Date(2026, 6, 10, 0, 1))
    setActivePinia(createPinia())
    const secondStore = useStatistics()
    expect(firstStore).not.toBe(secondStore)
    watchCallbacks[1](statistics('2026-07-10', 3))

    releaseOldWrite.resolve()
    await Promise.all([oldWriteFinished.promise, newWriteFinished.promise])

    expect(storageData.get('local:web-geek-job-Today')).toMatchObject({
      date: '2026-07-10',
      success: 3,
    })
  })

  it('never lets an old-day automatic-save snapshot overwrite the current day', async () => {
    useStatistics()
    vi.setSystemTime(new Date(2026, 6, 10, 0, 1))
    storageData.set('local:web-geek-job-Today', statistics('2026-07-10', 3))
    storageSetMock.mockClear()

    watchCallbacks[0](statistics('2026-07-09', 9))
    await Promise.resolve()
    await Promise.resolve()

    expect(storageData.get('local:web-geek-job-Today')).toMatchObject({
      date: '2026-07-10',
      success: 3,
    })
    expect(storageSetMock).not.toHaveBeenCalledWith(
      'local:web-geek-job-Today',
      expect.objectContaining({ date: '2026-07-09' }),
    )
  })

  it('does not let an old watcher overwrite a deferred account statistics restore', async () => {
    const staleStore = useStatistics()
    await staleStore.updateStatistics()
    setActivePinia(createPinia())
    const restoreStore = useStatistics()
    await restoreStore.updateStatistics()
    const setTodayStarted = createDeferred()
    const releaseSetToday = createDeferred()
    storageSetMock.mockImplementation(async (key: string, value: any) => {
      if (key === 'local:web-geek-job-Today' && value?.success === 5) {
        setTodayStarted.resolve()
        await releaseSetToday.promise
      }
      storageData.set(key, structuredClone(value))
    })

    const restore = restoreStore.setStatistics(
      JSON.stringify({ t: statistics('2026-07-09', 5), s: [statistics('2026-07-08', 2)] }),
    )
    await setTodayStarted.promise
    watchCallbacks[0](statistics('2026-07-09', 3))

    releaseSetToday.resolve()
    await restore
    await vi.waitFor(() =>
      expect(storageData.get('local:web-geek-job-Today')).toMatchObject({ success: 5 }),
    )
    expect(storageData.get('local:web-geek-job-Statistics')).toEqual([
      expect.objectContaining({ date: '2026-07-08', success: 2 }),
    ])
  })

  it('merges concurrent same-day increments from two independent stores', async () => {
    storageData.set('local:web-geek-job-Today', statistics('2026-07-09'))
    let webLockQueue: Promise<unknown> = Promise.resolve()
    const request = vi.fn((_name: string, callback: () => Promise<unknown>) => {
      const result = webLockQueue.then(callback, callback)
      webLockQueue = result.catch(() => undefined)
      return result
    })
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } })

    const firstStore = useStatistics()
    await firstStore.updateStatistics()
    setActivePinia(createPinia())
    const secondStore = useStatistics()
    await secondStore.updateStatistics()

    firstStore.todayData.success++
    firstStore.todayData.total++
    watchCallbacks[0](firstStore.todayData)
    secondStore.todayData.success++
    secondStore.todayData.total++
    watchCallbacks[1](secondStore.todayData)

    await vi.waitFor(() =>
      expect(storageData.get('local:web-geek-job-Today')).toMatchObject({ success: 2, total: 2 }),
    )
  })

  it('preserves a local increment queued while updateStatistics is in flight', async () => {
    const store = useStatistics()
    await store.updateStatistics()
    storageData.set('local:web-geek-job-Today', statistics('2026-07-09', 5))
    const updateReadStarted = createDeferred()
    const releaseUpdateRead = createDeferred()
    let deferTodayRead = true
    storageGetMock.mockImplementation(async (key: string, fallback?: unknown) => {
      if (key === 'local:web-geek-job-Today' && deferTodayRead) {
        deferTodayRead = false
        updateReadStarted.resolve()
        await releaseUpdateRead.promise
      }
      return storageData.has(key) ? structuredClone(storageData.get(key)) : fallback
    })

    const update = store.updateStatistics()
    await updateReadStarted.promise
    store.todayData.success++
    store.todayData.total++
    watchCallbacks[0](store.todayData)

    releaseUpdateRead.resolve()
    await update
    await vi.waitFor(() =>
      expect(storageData.get('local:web-geek-job-Today')).toMatchObject({ success: 6, total: 6 }),
    )
  })

  it('does not double-count cumulative watcher snapshots queued behind a slow write', async () => {
    storageData.set('local:web-geek-job-Today', statistics('2026-07-09'))
    const store = useStatistics()
    await store.updateStatistics()
    const firstWriteStarted = createDeferred()
    const releaseFirstWrite = createDeferred()
    let deferFirstWrite = true
    storageSetMock.mockImplementation(async (key: string, value: any) => {
      if (key === 'local:web-geek-job-Today' && value?.success === 1 && deferFirstWrite) {
        deferFirstWrite = false
        firstWriteStarted.resolve()
        await releaseFirstWrite.promise
      }
      storageData.set(key, structuredClone(value))
    })

    store.todayData.success++
    store.todayData.total++
    watchCallbacks[0](store.todayData)
    await firstWriteStarted.promise

    store.todayData.success++
    store.todayData.total++
    watchCallbacks[0](store.todayData)
    releaseFirstWrite.resolve()

    await vi.waitFor(() =>
      expect(storageData.get('local:web-geek-job-Today')).toMatchObject({ success: 2, total: 2 }),
    )
  })

  it('keeps the in-memory increment when an automatic save fails', async () => {
    const store = useStatistics()
    await store.updateStatistics()
    storageSetMock.mockRejectedValueOnce(new Error('storage unavailable'))

    store.todayData.success++
    store.todayData.total++
    watchCallbacks[0](store.todayData)

    await vi.waitFor(() => expect(storageSetMock).toHaveBeenCalled())
    await Promise.resolve()
    await Promise.resolve()

    expect(store.todayData).toMatchObject({ success: 3, total: 3 })
    expect(storageData.get('local:web-geek-job-Today')).toMatchObject({ success: 2, total: 2 })
  })

  it('does not reapply an increment when storage committed but the RPC response was lost', async () => {
    const store = useStatistics()
    await store.updateStatistics()
    const unknownWriteCommitted = createDeferred()
    let loseFirstResponse = true
    storageSetMock.mockImplementation(async (key: string, value: any) => {
      storageData.set(key, structuredClone(value))
      if (key === 'local:web-geek-job-Today' && value?.success === 3 && loseFirstResponse) {
        loseFirstResponse = false
        unknownWriteCommitted.resolve()
        throw new Error('provider response lost after commit')
      }
    })

    store.todayData.success++
    store.todayData.total++
    watchCallbacks[0](store.todayData)
    await unknownWriteCommitted.promise
    await Promise.resolve()
    await Promise.resolve()

    store.todayData.success++
    store.todayData.total++
    watchCallbacks[0](store.todayData)

    await vi.waitFor(() =>
      expect(storageData.get('local:web-geek-job-Today')).toMatchObject({ success: 4, total: 4 }),
    )
  })

  it('does not let a lower same-epoch watcher snapshot decrement newer storage', async () => {
    const store = useStatistics()
    await store.updateStatistics()
    storageData.set('local:web-geek-job-Today', statistics('2026-07-09', 5))
    await store.updateStatistics()

    watchCallbacks[0](statistics('2026-07-09', 2))
    await store.updateStatistics()

    expect(storageData.get('local:web-geek-job-Today')).toMatchObject({ success: 5, total: 5 })
  })

  it('merges independent increments after both stores cross midnight', async () => {
    storageData.set('local:web-geek-job-Today', statistics('2026-07-09'))
    const firstStore = useStatistics()
    await firstStore.updateStatistics()
    setActivePinia(createPinia())
    const secondStore = useStatistics()
    await secondStore.updateStatistics()

    vi.setSystemTime(new Date(2026, 6, 10, 0, 1))
    await firstStore.updateStatistics()
    await secondStore.updateStatistics()
    firstStore.todayData.success++
    firstStore.todayData.total++
    watchCallbacks[0](firstStore.todayData)
    secondStore.todayData.success++
    secondStore.todayData.total++
    watchCallbacks[1](secondStore.todayData)

    await vi.waitFor(() =>
      expect(storageData.get('local:web-geek-job-Today')).toMatchObject({
        date: '2026-07-10',
        success: 2,
        total: 2,
      }),
    )
    expect(storageData.get('local:web-geek-job-Statistics')).toEqual([
      expect.objectContaining({ date: '2026-07-09', success: 0 }),
    ])
  })

  it('atomically repairs corrupt Today and Statistics blobs with finite counters', async () => {
    storageData.set('local:web-geek-job-Today', {
      ...statistics('2026-07-09', 4),
      searchSuccess: 'broken',
      success: Number.POSITIVE_INFINITY,
      total: Number.NaN,
    })
    storageData.set('local:web-geek-job-Statistics', [
      {
        ...statistics('2026-07-08', 2),
        groupSuccess: Number.NEGATIVE_INFINITY,
        success: Number.NaN,
      },
      null,
      'broken',
    ])

    const store = useStatistics()
    await store.updateStatistics()
    await store.flush()

    const storedToday = storageData.get('local:web-geek-job-Today') as Record<string, unknown>
    const storedHistory = storageData.get('local:web-geek-job-Statistics') as Array<
      Record<string, unknown>
    >
    expect(storedToday).toMatchObject({ date: '2026-07-09', success: 0, total: 4 })
    expect(storedHistory).toHaveLength(1)
    expect(storedHistory[0]).toMatchObject({ date: '2026-07-08', success: 0, groupSuccess: 0 })
    expect(
      [...Object.values(storedToday), ...Object.values(storedHistory[0])]
        .filter((value): value is number => typeof value === 'number')
        .every(Number.isFinite),
    ).toBe(true)
  })

  it('repairs persisted statistics when success is greater than total', async () => {
    storageData.set('local:web-geek-job-Today', {
      ...statistics('2026-07-09', 2),
      success: 2,
      total: 1,
    })

    const store = useStatistics()
    await store.updateStatistics()
    await store.flush()

    expect(storageData.get('local:web-geek-job-Today')).toMatchObject({
      date: '2026-07-09',
      success: 2,
      total: 2,
    })
  })

  it('increments a corrupt epoch before rejecting a stale watcher snapshot', async () => {
    const store = useStatistics()
    await store.updateStatistics()
    storageData.set('local:web-geek-job-Today', statistics('2026-07-09', 5))
    storageData.set('local:web-geek-job-StatisticsEpoch', 'broken')

    store.todayData.success++
    store.todayData.total++
    watchCallbacks[0](store.todayData)

    await vi.waitFor(() => expect(storageData.get('local:web-geek-job-StatisticsEpoch')).toBe(1))
    expect(storageData.get('local:web-geek-job-Today')).toMatchObject({ success: 5, total: 5 })
  })

  it('uses the same Web Lock for rollover and automatic saves', async () => {
    const request = vi.fn(async (_name: string, callback: () => Promise<unknown>) => callback())
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request },
    })
    const store = useStatistics()

    vi.setSystemTime(new Date(2026, 6, 10, 0, 1))
    await store.updateStatistics()
    watchCallbacks[0](statistics('2026-07-10', 4))
    await vi.waitFor(() =>
      expect(storageData.get('local:web-geek-job-Today')).toMatchObject({ success: 4 }),
    )
    await store.setStatistics(
      JSON.stringify({ t: statistics('2026-07-10', 5), s: [statistics('2026-07-09', 2)] }),
    )

    expect(request).toHaveBeenCalledTimes(3)
    expect(request.mock.calls.map(([name]) => name)).toEqual([
      'agent-delivery:statistics',
      'agent-delivery:statistics',
      'agent-delivery:statistics',
    ])
  })
})
