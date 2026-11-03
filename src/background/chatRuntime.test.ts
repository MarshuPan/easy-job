import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CHAT_RUNTIME_RESPONSE } from '@/message/chatRuntimeProtocol'
import { getCurrentAppVersion } from '@/utils/extensionRuntimeHealth'

const { get, send, reload, stored, append } = vi.hoisted(() => ({
  get: vi.fn(),
  send: vi.fn(),
  reload: vi.fn(),
  stored: new Map<string, unknown>(),
  append: vi.fn(async (_event: unknown) => true),
}))
vi.mock('#imports', () => ({
  browser: { tabs: { get, sendMessage: send, reload } },
  storage: {
    getItem: vi.fn(async (key: string) => stored.get(key)),
    setItem: vi.fn(async (key: string, value: unknown) => {
      stored.set(key, value)
    }),
  },
}))
vi.mock('./localDiagnosticSink', () => ({ appendLocalDiagnosticEvent: append }))
import { prepareChatRuntime, probeChatRuntime } from './chatRuntime'

function ready(request: { requestId: string }) {
  return {
    type: CHAT_RUNTIME_RESPONSE,
    requestId: request.requestId,
    ready: true,
    code: 'READY',
    reason: 'ready',
    mainVersion: getCurrentAppVersion(),
    contentVersion: getCurrentAppVersion(),
    accountReady: true,
    accountMatches: true,
    consumerStarted: true,
    channelReady: true,
    wakeDelivered: true,
  }
}

describe('chat runtime readiness and bounded recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
    vi.clearAllMocks()
    stored.clear()
    get.mockResolvedValue({ status: 'complete' })
    send.mockImplementation(async (_tabId, request) => ready(request))
    reload.mockResolvedValue(undefined)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses a healthy consumer even when an unrelated resource keeps the tab loading', async () => {
    get.mockResolvedValue({ status: 'loading' })
    const result = await prepareChatRuntime(7, 'account-a', true)
    expect(result).toMatchObject({ ready: true, loaded: false, reloaded: false, handshakeMs: 0 })
    expect(reload).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledOnce()
  })

  it('recovers a stale content script once, then verifies the current account and channel', async () => {
    send.mockRejectedValueOnce(new Error('Receiving end does not exist'))
    const preparation = prepareChatRuntime(7, 'account-a', true)
    await vi.advanceTimersByTimeAsync(250)
    expect(await preparation).toMatchObject({ ready: true, reloaded: true })
    expect(reload).toHaveBeenCalledExactlyOnceWith(7)
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'runtime.chat-runtime',
        data: expect.objectContaining({ stage: 'prepared', accountMatches: true, loaded: true }),
      }),
    )
  })

  it('bounds an unresponsive new page at 12 seconds without adding a queue wait', async () => {
    send.mockImplementation(() => new Promise(() => {}))
    const preparation = prepareChatRuntime(7, 'account-a', false)
    await vi.advanceTimersByTimeAsync(12_000)
    expect(await preparation).toMatchObject({
      ready: false,
      code: 'CHAT_BRIDGE_UNAVAILABLE',
      handshakeMs: 12_000,
    })
    expect(reload).not.toHaveBeenCalled()
  })

  it('reports a known missing account and channel without reloading a working bridge', async () => {
    send.mockImplementation(async (_id, request) => ({
      ...ready(request),
      ready: false,
      accountReady: false,
      accountMatches: false,
      code: 'ACCOUNT_UNAVAILABLE',
      reason: '账号尚未初始化',
    }))
    const preparation = prepareChatRuntime(7, 'account-a', true)
    await vi.advanceTimersByTimeAsync(12_000)
    expect(await preparation).toMatchObject({
      code: 'ACCOUNT_UNAVAILABLE',
      ready: false,
      handshakeMs: 12_000,
    })
    expect(reload).not.toHaveBeenCalled()
  })

  it('stops immediately on an account mismatch', async () => {
    send.mockImplementation(async (_id, request) => ({
      ...ready(request),
      ready: false,
      accountMatches: false,
      code: 'ACCOUNT_MISMATCH',
      reason: '账号不一致',
    }))
    expect(await prepareChatRuntime(7, 'account-a', true)).toMatchObject({
      code: 'ACCOUNT_MISMATCH',
      handshakeMs: 0,
    })
    expect(reload).not.toHaveBeenCalled()
  })

  it.each(['sending', 'sent'])(
    'does not reload or erase an uncertain %s receipt',
    async (stage) => {
      const queue = [{ id: 'uncertain', status: { stage } }]
      stored.set('local:pending-greetings', queue)
      send.mockRejectedValue(new Error('stale context'))
      expect(await prepareChatRuntime(7, 'account-a', true)).toMatchObject({
        ready: false,
        recoveryCode: 'RECOVERY_BLOCKED_BY_UNCERTAIN_SEND',
      })
      expect(reload).not.toHaveBeenCalled()
      expect(stored.get('local:pending-greetings')).toBe(queue)
    },
  )

  it('keeps reload cooldown across background module restarts', async () => {
    send.mockRejectedValue(new Error('stale context'))
    const preparation = prepareChatRuntime(7, 'account-a', true)
    await vi.advanceTimersByTimeAsync(12_000)
    expect((await preparation).reloaded).toBe(true)
    vi.resetModules()
    const restarted = await import('./chatRuntime')
    expect(await restarted.prepareChatRuntime(7, 'account-a', true)).toMatchObject({
      recoveryCode: 'RECOVERY_COOLDOWN',
    })
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('serializes simultaneous recovery attempts so a tab reloads only once', async () => {
    send.mockRejectedValue(new Error('stale context'))
    const both = Promise.all([
      prepareChatRuntime(7, 'account-a', true),
      prepareChatRuntime(7, 'account-a', true),
    ])
    await vi.advanceTimersByTimeAsync(12_000)
    const results = await both
    expect(reload).toHaveBeenCalledTimes(1)
    expect(results.some((result) => result.recoveryCode === 'RECOVERY_COOLDOWN')).toBe(true)
  })

  it('rejects a ready response that lacks account confirmation or has the wrong request id', async () => {
    send.mockImplementationOnce(async (_id, request) => ({
      ...ready(request),
      accountMatches: false,
    }))
    expect(await probeChatRuntime(7, 'account-a')).toMatchObject({
      ready: false,
      code: 'CHAT_BRIDGE_UNAVAILABLE',
    })
    send.mockImplementationOnce(async (_id, request) => ({
      ...ready(request),
      requestId: 'unrelated',
    }))
    expect(await probeChatRuntime(7, 'account-a')).toMatchObject({
      ready: false,
      code: 'CHAT_BRIDGE_UNAVAILABLE',
    })
  })

  it('distinguishes main-world timeout from a genuine version mismatch', async () => {
    send.mockImplementationOnce(async (_id, request) => ({
      ...ready(request),
      ready: false,
      mainVersion: undefined,
      code: 'MAIN_WORLD_TIMEOUT',
      reason: '主脚本未响应',
    }))
    expect(await probeChatRuntime(7, 'account-a')).toMatchObject({ code: 'MAIN_WORLD_TIMEOUT' })
    send.mockImplementationOnce(async (_id, request) => ({ ...ready(request), mainVersion: 'old' }))
    expect(await probeChatRuntime(7, 'account-a')).toMatchObject({
      ready: false,
      code: 'CHAT_VERSION_MISMATCH',
    })
  })
})
