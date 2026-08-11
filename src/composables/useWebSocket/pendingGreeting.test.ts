import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  configRuntimeMock,
  loggerError,
  sendMessage,
  storageData,
  storageGetMock,
  storageReadBarrier,
  storageRmMock,
  storageSetMock,
} = vi.hoisted(() => {
  const storageData = new Map<string, unknown>()
  return {
    configRuntimeMock: vi.fn(),
    loggerError: vi.fn(),
    sendMessage: vi.fn((_args: unknown) => 'ChatWebsocket' as const),
    storageData,
    storageGetMock: vi.fn(),
    storageReadBarrier: {
      promise: undefined as Promise<void> | undefined,
      release: undefined as (() => void) | undefined,
      remainingReads: 0,
    },
    storageRmMock: vi.fn(async (key: string) => {
      storageData.delete(key)
      return true
    }),
    storageSetMock: vi.fn(async (key: string, value: unknown) => {
      storageData.set(key, value)
      return true
    }),
  }
})

vi.mock('@/message', () => ({
  counter: {
    configRuntime: configRuntimeMock,
    storageGet: storageGetMock,
    storageRm: storageRmMock,
    storageSet: storageSetMock,
  },
}))

vi.mock('@/utils/logger', () => ({
  logger: {
    error: loggerError,
    info: vi.fn(),
    warn: vi.fn(),
  },
}))

vi.mock('./protobuf', () => ({
  Message: class {
    constructor(private readonly args: unknown) {}

    send() {
      return sendMessage(this.args)
    }
  },
}))

import { useUser } from '@/stores/user'

import {
  claimPendingGreetingForFallback,
  consumePendingGreetings,
  enqueuePendingGreeting,
  getPendingGreeting,
  pendingGreetingKey,
  removePendingGreeting,
  startPendingGreetingConsumer,
  stopPendingGreetingConsumer,
  type PendingGreeting,
} from './pendingGreeting'

function setCurrentUid(uid: string) {
  Object.assign(window, { _PAGE: { uid } })
}

function deferNextStorageReads(count = 1) {
  storageReadBarrier.remainingReads = count
  storageReadBarrier.promise = new Promise<void>((resolve) => {
    storageReadBarrier.release = resolve
  })
}

function pendingGreeting(fromUid: string, id: string): PendingGreeting {
  return {
    id,
    brandName: '测试公司',
    content: '您好',
    createdAt: Date.now(),
    fromUid,
    jobName: 'AI 产品经理',
    toName: '王老师',
    toUid: `boss-${fromUid}`,
    type: 'custom',
  }
}

describe('pending greeting account scope', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'))
    window.history.replaceState({}, '', '/web/geek/chat')
    Object.assign(window, {
      ChatWebsocket: {
        client: { isConnected: () => true },
        send: vi.fn(),
      },
      GeekChatCore: undefined,
    })
    useUser().info.value = undefined
    setCurrentUid('account-b')
    storageData.clear()
    storageReadBarrier.promise = undefined
    storageReadBarrier.release = undefined
    storageReadBarrier.remainingReads = 0
    configRuntimeMock.mockReset().mockResolvedValue({
      accountInitialized: true,
      formData: { aiGreeting: { enable: true } },
    })
    loggerError.mockReset()
    storageGetMock.mockReset().mockImplementation(async (key: string, fallback?: unknown) => {
      const stored = storageData.has(key) ? storageData.get(key) : fallback
      const barrier = storageReadBarrier.promise
      if (barrier != null && storageReadBarrier.remainingReads > 0) {
        storageReadBarrier.remainingReads -= 1
        if (storageReadBarrier.remainingReads === 0) storageReadBarrier.promise = undefined
        await barrier
      }
      return stored
    })
    storageRmMock.mockReset().mockImplementation(async (key: string) => {
      storageData.delete(key)
      return true
    })
    storageSetMock.mockReset().mockImplementation(async (key: string, value: unknown) => {
      storageData.set(key, value)
      return true
    })
  })

  afterEach(() => {
    stopPendingGreetingConsumer()
    storageReadBarrier.release?.()
    vi.useRealTimers()
  })

  it('retains account A greetings without sending while account B is active', async () => {
    const pending = pendingGreeting('account-a', 'pending-a')
    storageData.set(pendingGreetingKey, [pending])

    const results = await consumePendingGreetings('account-b')

    expect(results).toEqual([])
    expect(sendMessage).not.toHaveBeenCalled()
    expect(storageData.get(pendingGreetingKey)).toEqual([pending])
  })

  it('does not read or remove a pending greeting when its UID does not match', async () => {
    const accountA = pendingGreeting('account-a', 'pending-a')
    const accountB = pendingGreeting('account-b', 'pending-b')
    storageData.set(pendingGreetingKey, [accountA, accountB])
    const originalQueue = storageData.get(pendingGreetingKey)

    await expect(getPendingGreeting(accountA.id, 'account-b')).resolves.toBeUndefined()
    await expect(removePendingGreeting(accountA.id, 'account-b')).resolves.toBe(false)

    expect(storageData.get(pendingGreetingKey)).toEqual(originalQueue)
  })

  it('rechecks the current UID after deferred reads before returning or removing an item', async () => {
    const accountA = pendingGreeting('account-a', 'pending-a')
    storageData.set(pendingGreetingKey, [accountA])
    const originalQueue = storageData.get(pendingGreetingKey)

    setCurrentUid('account-a')
    deferNextStorageReads()
    const deferredRead = getPendingGreeting(accountA.id, 'account-a')
    setCurrentUid('account-b')
    storageReadBarrier.release?.()

    await expect(deferredRead).resolves.toBeUndefined()
    expect(storageData.get(pendingGreetingKey)).toEqual(originalQueue)

    setCurrentUid('account-a')
    deferNextStorageReads()
    const deferredRemoval = removePendingGreeting(accountA.id, 'account-a')
    setCurrentUid('account-b')
    storageReadBarrier.release?.()

    await expect(deferredRemoval).resolves.toBe(false)
    expect(storageData.get(pendingGreetingKey)).toEqual(originalQueue)
  })

  it('stops an account A continuation after switching to B and lets each account resume its own queue', async () => {
    setCurrentUid('account-a')
    const accountA = await enqueuePendingGreeting({
      brandName: '公司 A',
      content: '您好 A',
      fromUid: 'account-a',
      jobName: '岗位 A',
      toName: '老师 A',
      toUid: 'boss-a',
      type: 'custom',
    })
    const accountB = await enqueuePendingGreeting({
      brandName: '公司 B',
      content: '您好 B',
      fromUid: 'account-b',
      jobName: '岗位 B',
      toName: '老师 B',
      toUid: 'boss-b',
      type: 'custom',
    })

    await consumePendingGreetings('account-a')
    vi.advanceTimersByTime(7_000)
    await consumePendingGreetings('account-a')
    vi.advanceTimersByTime(6_000)
    const queueBeforeSwitch = storageData.get(pendingGreetingKey)

    deferNextStorageReads()
    const accountAContinuation = consumePendingGreetings('account-a')
    setCurrentUid('account-b')
    storageReadBarrier.release?.()

    await expect(accountAContinuation).resolves.toEqual([])
    expect(sendMessage).not.toHaveBeenCalled()
    expect(storageData.get(pendingGreetingKey)).toEqual(queueBeforeSwitch)

    await expect(consumePendingGreetings('account-b')).resolves.toEqual([
      { id: accountB.id, ok: true, channel: 'ChatWebsocket' },
    ])
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ form_uid: 'account-b' }))
    expect(storageData.get(pendingGreetingKey)).toEqual([
      expect.objectContaining({ id: accountA.id, fromUid: 'account-a' }),
    ])

    setCurrentUid('account-a')
    vi.advanceTimersByTime(6_000)
    await expect(consumePendingGreetings('account-a')).resolves.toEqual([
      { id: accountA.id, ok: true, channel: 'ChatWebsocket' },
    ])
    expect(sendMessage).toHaveBeenCalledTimes(2)
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ form_uid: 'account-a' }))
    expect(storageData.has(pendingGreetingKey)).toBe(false)
  })

  it('removes expired greetings only for the active account', async () => {
    const accountA = pendingGreeting('account-a', 'pending-a')
    const accountB = pendingGreeting('account-b', 'pending-b')
    accountA.createdAt -= 6 * 60 * 1000
    accountB.createdAt -= 6 * 60 * 1000
    storageData.set(pendingGreetingKey, [accountA, accountB])
    setCurrentUid('account-a')

    await expect(consumePendingGreetings('account-a')).resolves.toEqual([
      { id: accountA.id, ok: false, error: '待发送招呼语已过期' },
    ])

    expect(sendMessage).not.toHaveBeenCalled()
    expect(storageData.get(pendingGreetingKey)).toEqual([accountB])
  })

  it('cancels the active account queue without sending when AI greeting is disabled', async () => {
    const accountAFirst = pendingGreeting('account-a', 'pending-a-1')
    const accountB = pendingGreeting('account-b', 'pending-b')
    const accountASecond = pendingGreeting('account-a', 'pending-a-2')
    storageData.set(pendingGreetingKey, [accountAFirst, accountB, accountASecond])
    setCurrentUid('account-a')
    configRuntimeMock.mockResolvedValue({
      accountInitialized: true,
      formData: { aiGreeting: { enable: false } },
    })
    vi.advanceTimersByTime(5 * 60_000)

    await expect(consumePendingGreetings('account-a')).resolves.toEqual([
      {
        id: accountAFirst.id,
        ok: false,
        error: 'AI招呼语已关闭，已取消待发送文本',
      },
      {
        id: accountASecond.id,
        ok: false,
        error: 'AI招呼语已关闭，已取消待发送文本',
      },
    ])

    expect(sendMessage).not.toHaveBeenCalled()
    expect(storageData.get(pendingGreetingKey)).toEqual([
      expect.objectContaining({
        id: accountAFirst.id,
        status: expect.objectContaining({ stage: 'cancelled' }),
      }),
      accountB,
      expect.objectContaining({
        id: accountASecond.id,
        status: expect.objectContaining({ stage: 'cancelled' }),
      }),
    ])
  })

  it('never gives a cancelled greeting to DOM fallback and removes it on the next consume', async () => {
    const cancelled = {
      ...pendingGreeting('account-a', 'pending-cancelled'),
      status: {
        stage: 'cancelled' as const,
        reason: 'AI招呼语已关闭，已取消待发送文本',
        observedAt: Date.now(),
      },
    }
    storageData.set(pendingGreetingKey, [cancelled])
    setCurrentUid('account-a')

    await expect(
      claimPendingGreetingForFallback(cancelled.id, 'account-a'),
    ).resolves.toBeUndefined()
    await expect(consumePendingGreetings('account-a')).resolves.toEqual([
      {
        id: cancelled.id,
        ok: false,
        error: 'AI招呼语已关闭，已取消待发送文本',
      },
    ])

    expect(sendMessage).not.toHaveBeenCalled()
    expect(storageData.has(pendingGreetingKey)).toBe(false)
  })

  it('serializes enqueue and removal so neither stale queue write overwrites the other', async () => {
    const accountA = pendingGreeting('account-a', 'pending-a')
    storageData.set(pendingGreetingKey, [accountA])
    setCurrentUid('account-a')

    deferNextStorageReads(2)
    const concurrentEnqueue = enqueuePendingGreeting({
      brandName: '公司 B',
      content: '您好 B',
      fromUid: 'account-b',
      jobName: '岗位 B',
      toName: '老师 B',
      toUid: 'boss-b',
      type: 'custom',
    })
    const concurrentRemoval = removePendingGreeting(accountA.id, 'account-a')
    storageReadBarrier.release?.()

    const [accountB, removed] = await Promise.all([concurrentEnqueue, concurrentRemoval])

    expect(removed).toBe(true)
    expect(storageData.get(pendingGreetingKey)).toEqual([accountB])
  })

  it('gives either the queue consumer or DOM fallback exclusive ownership', async () => {
    vi.setSystemTime(new Date('2040-01-01T00:00:00.000Z'))
    window.history.replaceState({}, '', '/web/geek/chat?race=1')
    setCurrentUid('account-a')

    const warmup = pendingGreeting('account-a', 'warmup')
    storageData.set(pendingGreetingKey, [warmup])
    for (let attempt = 0; attempt < 3 && storageData.has(pendingGreetingKey); attempt++) {
      await consumePendingGreetings('account-a')
      vi.advanceTimersByTime(7_000)
    }
    expect(storageData.has(pendingGreetingKey)).toBe(false)

    const beforeRaceSends = sendMessage.mock.calls.length
    const raced = pendingGreeting('account-a', 'pending-race')
    storageData.set(pendingGreetingKey, [raced])
    vi.advanceTimersByTime(7_000)

    deferNextStorageReads()
    const consumed = consumePendingGreetings('account-a')
    const claimed = claimPendingGreetingForFallback(raced.id, 'account-a')
    storageReadBarrier.release?.()

    await expect(consumed).resolves.toEqual([{ id: raced.id, ok: true, channel: 'ChatWebsocket' }])
    await expect(claimed).resolves.toBeUndefined()
    expect(sendMessage).toHaveBeenCalledTimes(beforeRaceSends + 1)
    expect(storageData.has(pendingGreetingKey)).toBe(false)
  })

  it('does not resend when the channel accepted a message but queue removal failed', async () => {
    vi.resetModules()
    const freshQueue = await import('./pendingGreeting')
    vi.setSystemTime(new Date('2050-01-01T00:00:00.000Z'))
    window.history.replaceState({}, '', '/web/geek/chat?uncertain=1')
    setCurrentUid('account-a')
    const pending = pendingGreeting('account-a', 'pending-uncertain')
    storageData.set(pendingGreetingKey, [pending])

    await freshQueue.consumePendingGreetings('account-a')
    vi.advanceTimersByTime(7_000)
    await freshQueue.consumePendingGreetings('account-a')
    vi.advanceTimersByTime(7_000)
    storageRmMock.mockRejectedValueOnce(new Error('storage unavailable'))

    await expect(freshQueue.consumePendingGreetings('account-a')).rejects.toThrow(
      'storage unavailable',
    )
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(storageData.get(pendingGreetingKey)).toEqual([
      expect.objectContaining({
        id: pending.id,
        status: expect.objectContaining({ stage: 'sending' }),
      }),
    ])

    await expect(freshQueue.consumePendingGreetings('account-a')).resolves.toEqual([
      {
        id: pending.id,
        ok: false,
        error: '招呼语发送结果不确定，已停止自动重试',
      },
    ])
    await expect(
      freshQueue.claimPendingGreetingForFallback(pending.id, 'account-a'),
    ).resolves.toBeUndefined()
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(storageData.get(pendingGreetingKey)).toEqual([
      expect.objectContaining({
        id: pending.id,
        status: expect.objectContaining({ stage: 'sending' }),
      }),
    ])
  })

  it('clears a corrupt persisted queue without throwing on every consume attempt', async () => {
    storageData.set(pendingGreetingKey, { entries: 'invalid' })

    await expect(consumePendingGreetings('account-b')).resolves.toEqual([])

    expect(storageData.has(pendingGreetingKey)).toBe(false)
  })

  it('stops polling after the extension context is invalidated', async () => {
    const pending = pendingGreeting('account-b', 'pending-context-invalidated')
    storageData.set(pendingGreetingKey, [pending])
    storageGetMock.mockRejectedValue(new Error('Extension context invalidated.'))

    startPendingGreetingConsumer(800)
    await vi.advanceTimersByTimeAsync(5_000)

    expect(storageGetMock).toHaveBeenCalledTimes(1)
    expect(loggerError).toHaveBeenCalledTimes(1)
    expect(loggerError).toHaveBeenCalledWith('插件已更新，当前聊天页需刷新后才能继续发送招呼语', {
      code: 'EXTENSION_CONTEXT_INVALIDATED',
    })
    expect(storageData.get(pendingGreetingKey)).toEqual([pending])
    expect(sendMessage).not.toHaveBeenCalled()
  })
})
