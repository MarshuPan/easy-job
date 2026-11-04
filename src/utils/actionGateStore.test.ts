import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const storage = new Map<string, unknown>()
const storageGet = vi.fn(async (key: string, fallback: unknown) =>
  storage.has(key) ? storage.get(key) : fallback,
)
const storageSet = vi.fn(async (key: string, value: unknown) => {
  storage.set(key, value)
})

vi.mock('@/message', () => ({ counter: { storageGet, storageSet } }))
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const { acquireBossAction, actionGateKey, countRecentBossActions, resetActionGate } =
  await import('./actionGateStore')
const { defaultGateRules } = await import('./actionGate')

describe('acquireBossAction', () => {
  afterEach(() => vi.useRealTimers())
  beforeEach(async () => {
    storage.clear()
    storageGet.mockClear()
    storageSet.mockClear()
    storageGet.mockImplementation(async (key: string, fallback: unknown) =>
      storage.has(key) ? storage.get(key) : fallback,
    )
    storageSet.mockImplementation(async (key: string, value: unknown) => {
      storage.set(key, value)
    })
    await resetActionGate()
  })

  it('counts only the requested action kinds within the window', async () => {
    // 面板的「列表刷新 N 次/小时」：翻页和切换来源算，详情、投递不算，一小时以前的不算。
    const now = Date.now()
    storage.set(actionGateKey, [
      { kind: 'pageNext', at: now - 10 * 60_000 },
      { kind: 'navigate', at: now - 20 * 60_000 },
      { kind: 'detail', at: now - 5 * 60_000 },
      { kind: 'pageNext', at: now - 2 * 60 * 60_000 },
    ])

    expect(await countRecentBossActions(['pageNext', 'navigate'], 60 * 60_000, now)).toBe(2)
  })

  it('records every action it lets through so the window survives a page reload', () => {
    // 计数存在内存里等于每次翻页、跳聊天页、刷新都把限额清零，
    // 而那正好是最需要它生效的时刻。
    return (async () => {
      await acquireBossAction('publish')
      await acquireBossAction('publish')
      expect(storage.get(actionGateKey)).toEqual([
        expect.objectContaining({ kind: 'publish' }),
        expect.objectContaining({ kind: 'publish' }),
      ])
    })()
  })

  it('enforces a minimum gap even while the publish burst still has tokens', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2030-01-07T02:00:00Z'))
    const startedAt = Date.now()
    await acquireBossAction('publish', { minIntervalMs: 30_000 })
    const onWait = vi.fn()
    const pending = acquireBossAction('publish', { minIntervalMs: 30_000, onWait })
    await vi.advanceTimersByTimeAsync(29_999)
    expect(storage.get(actionGateKey) as unknown[]).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toBe(true)
    expect(onWait).toHaveBeenCalledWith(30_000)
    expect(storage.get(actionGateKey)).toEqual([
      { kind: 'publish', at: startedAt },
      { kind: 'publish', at: startedAt + 30_000 },
    ])
  })

  it('honors another page history and only waits for the missing part', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2030-01-07T02:00:00Z'))
    storage.set(actionGateKey, [{ kind: 'publish', at: Date.now() - 20_000 }])
    const onWait = vi.fn()
    const pending = acquireBossAction('publish', { minIntervalMs: 30_000, onWait })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await pending).toBe(true)
    expect(onWait).toHaveBeenCalledWith(10_000)
  })

  it('allows a configured long interval without treating it as a gate timeout', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2030-01-07T02:00:00Z'))
    const startedAt = Date.now()
    storage.set(actionGateKey, [{ kind: 'publish', at: startedAt - 3_600_000 - 1_000 }])
    await acquireBossAction('detail')
    const pending = acquireBossAction('publish', { minIntervalMs: 7_200_000 })
    await vi.advanceTimersByTimeAsync(3_599_000)
    expect(await pending).toBe(true)
    const publishes = (storage.get(actionGateKey) as Array<{ kind: string; at: number }>).filter(
      (e) => e.kind === 'publish',
    )
    expect(publishes.at(-1)?.at).toBe(startedAt + 3_599_000)
  })

  it('holds the caller once the burst is spent instead of letting the action out', async () => {
    // 桶容量用光之前是连着放行的（真人也是一口气点开几个），之后才开始计量。
    for (let i = 0; i < defaultGateRules.buckets.publish.burst; i++) {
      expect(await acquireBossAction('publish')).toBe(true)
    }

    const onWait = vi.fn()
    let aborted = false
    const result = await acquireBossAction('publish', {
      shouldAbort: () => aborted,
      onWait: (waitMs) => {
        onWait(waitMs)
        // 拿不到就应该一直等；这里模拟用户点了停止，让调用返回。
        aborted = true
      },
    })

    expect(onWait).toHaveBeenCalled()
    expect(onWait.mock.calls[0][0]).toBeGreaterThan(0)
    expect(result).toBe(false)
    // 被拦下的动作不能记账，否则限额会被没发生的请求吃掉。
    expect((storage.get(actionGateKey) as unknown[]).length).toBe(
      defaultGateRules.buckets.publish.burst,
    )
  })

  it('counts actions from a window written by another tab', async () => {
    // 两个标签页各自以为自己在限额内，合起来就是两倍速率。
    const now = Date.now()
    storage.set(
      actionGateKey,
      Array.from({ length: defaultGateRules.buckets.publish.burst }, (_, index) => ({
        kind: 'publish',
        at: now - (index + 1) * 500,
      })),
    )

    let aborted = false
    const result = await acquireBossAction('publish', {
      shouldAbort: () => aborted,
      onWait: () => {
        aborted = true
      },
    })

    expect(result).toBe(false)
  })

  it('keeps limiting when storage is unreachable rather than opening the floodgates', async () => {
    // 后台休眠时 storage 可能一直不返回。失效方向必须是「少记一些」，不是「不再限速」。
    // 先在存储正常时把桶用光，再让存储挂掉——模拟运行到一半后台睡了。
    for (let i = 0; i < defaultGateRules.buckets.publish.burst; i++) {
      await acquireBossAction('publish')
    }
    storageGet.mockImplementation(() => new Promise(() => {}))
    storageSet.mockImplementation(() => new Promise(() => {}))

    let aborted = false
    const result = await acquireBossAction('publish', {
      shouldAbort: () => aborted,
      onWait: () => {
        aborted = true
      },
    })

    expect(result).toBe(false)
  }, 60_000)

  it('does not block a caller that has already been told to stop', async () => {
    expect(await acquireBossAction('publish', { shouldAbort: () => true })).toBe(false)
    expect(storage.get(actionGateKey)).toEqual([])
  })
})
