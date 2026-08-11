import { beforeEach, describe, expect, it, vi } from 'vitest'

const storage = new Map<string, unknown>()
const storageGet = vi.fn(async (key: string, fallback: unknown) =>
  storage.has(key) ? storage.get(key) : fallback,
)
const storageSet = vi.fn(async (key: string, value: unknown) => {
  storage.set(key, value)
})

vi.mock('@/message', () => ({ counter: { storageGet, storageSet } }))
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const { acquireBossAction, actionGateKey, resetActionGate } = await import('./actionGateStore')
const { defaultGateRules } = await import('./actionGate')

describe('acquireBossAction', () => {
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
