import { afterEach, describe, expect, it, vi } from 'vitest'

import { requestMainWorldChatRuntime } from './chatRuntimeBridge'
import {
  CHAT_RUNTIME_REQUEST,
  CHAT_RUNTIME_RESPONSE,
  CHAT_RUNTIME_TIMEOUT_MS,
} from './chatRuntimeProtocol'

describe('chat readiness bridge authentication and timeout', () => {
  afterEach(() => {
    vi.useRealTimers()
  })
  it('accepts only the matching request, origin, window, and bridge token', async () => {
    vi.useFakeTimers()
    vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    let done = false
    const result = requestMainWorldChatRuntime(
      { type: CHAT_RUNTIME_REQUEST, requestId: 'request-1', expectedUid: 'account-a', wake: true },
      'token-a',
    ).then((value) => {
      done = true
      return value
    })
    const response = {
      type: CHAT_RUNTIME_RESPONSE,
      requestId: 'request-1',
      ready: true,
      code: 'READY',
      reason: 'ready',
      mainVersion: 'test',
      bridgeToken: 'token-a',
      accountReady: true,
      accountMatches: true,
      consumerStarted: true,
      channelReady: true,
      accountUid: 'must-not-leak',
      privateData: 'must-not-leak',
    }
    for (const override of [{ requestId: 'wrong' }, { bridgeToken: 'wrong' }]) {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: window,
          origin: location.origin,
          data: { ...response, ...override },
        }),
      )
    }
    window.dispatchEvent(
      new MessageEvent('message', { source: window, origin: 'https://other.test', data: response }),
    )
    window.dispatchEvent(
      new MessageEvent('message', { source: null, origin: location.origin, data: response }),
    )
    await Promise.resolve()
    expect(done).toBe(false)
    window.dispatchEvent(
      new MessageEvent('message', { source: window, origin: location.origin, data: response }),
    )
    expect(await result).toMatchObject({ requestId: 'request-1', ready: true })
    expect(JSON.stringify(await result)).not.toMatch(/must-not-leak|token-a/)
  })
  it('returns a bounded, explicit main-world timeout', async () => {
    vi.useFakeTimers()
    vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    const result = requestMainWorldChatRuntime(
      {
        type: CHAT_RUNTIME_REQUEST,
        requestId: 'request-timeout',
        expectedUid: 'account-a',
        wake: false,
      },
      'token-a',
    )
    await vi.advanceTimersByTimeAsync(CHAT_RUNTIME_TIMEOUT_MS)
    expect(await result).toMatchObject({ ready: false, code: 'MAIN_WORLD_TIMEOUT' })
  })
})
