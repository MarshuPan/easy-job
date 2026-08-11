import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

import {
  AI_TASK_CLIENT_TIMEOUT_BUFFER_SECONDS,
  AI_TASK_MAX_RETRIES,
  AI_TASK_MAX_RETRY_DELAY_SECONDS,
  AI_TASK_REQUEST_TYPE,
  AI_TASK_RESPONSE_TYPE,
} from '@/utils/backgroundAiProtocol'
import {
  EXTENSION_RUNTIME_PROBE_REQUEST_TYPE,
  EXTENSION_RUNTIME_PROBE_RESPONSE_TYPE,
} from '@/utils/extensionRuntimeHealth'

import InjectAdapter, {
  onConfigRevisionChanged,
  probeExtensionRuntimeHealth,
  runBackgroundAiTask,
} from './index'

describe('runBackgroundAiTask', () => {
  let messageHandler: ((event: MessageEvent<unknown>) => void) | undefined

  beforeEach(() => {
    messageHandler = undefined
    vi.useFakeTimers()
    vi.stubGlobal('crypto', { randomUUID: () => 'request-1' })
    vi.stubGlobal('window', {
      addEventListener: vi.fn((_type, handler) => {
        messageHandler = handler as (event: MessageEvent<unknown>) => void
      }),
      clearTimeout: vi.fn((id) => clearTimeout(id)),
      location: { origin: 'https://www.zhipin.com' },
      postMessage: vi.fn(),
      removeEventListener: vi.fn(),
      setTimeout: vi.fn((handler, timeout) => setTimeout(handler as TimerHandler, timeout)),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('keeps the foreground AI task waiting through the bounded retry window', () => {
    runBackgroundAiTask({
      data: { filteringThreshold: 70 },
      task: 'aiFiltering',
      timeout: 180,
    }).catch(() => {})

    // 前台等待窗口按重试次数推导，写死数字会在调整重试预算时静默失配。
    const expectedWindowMs =
      (180 * (AI_TASK_MAX_RETRIES + 1) +
        AI_TASK_MAX_RETRY_DELAY_SECONDS +
        AI_TASK_CLIENT_TIMEOUT_BUFFER_SECONDS) *
      1000
    expect(window.setTimeout).toHaveBeenCalledWith(expect.any(Function), expectedWindowMs)
    expect(window.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'request-1',
        task: 'aiFiltering',
        type: AI_TASK_REQUEST_TYPE,
      }),
      expect.any(String),
    )
  })

  it('posts comctx calls with reactive arguments as plain cloneable messages', () => {
    const adapter = new InjectAdapter()

    adapter.sendMessage(
      {
        args: [reactive([{ id: 'expect-1' }])],
        id: 'message-1',
        namespace: '__agent-delivery-content__',
        path: ['configRuntimeSave'],
        sender: 'injector',
        type: 'apply',
      } as never,
      undefined as never,
    )

    const [message] = vi.mocked(window.postMessage).mock.calls[0]
    expect(() => structuredClone(message)).not.toThrow()
    expect((message as { args: unknown[] }).args).toEqual([[{ id: 'expect-1' }]])
  })

  it('uses only the stable background error code and generic message', async () => {
    const promise = runBackgroundAiTask({
      data: { filteringThreshold: 70 },
      task: 'aiGreeting',
      timeout: 180,
    })
    const origin = vi.mocked(window.postMessage).mock.calls[0][1] as string

    messageHandler?.({
      data: {
        error: '后台AI任务失败',
        errorCode: 'AI_TASK_FAILED',
        ok: false,
        requestId: 'request-1',
        type: AI_TASK_RESPONSE_TYPE,
      },
      origin,
      source: window,
    } as unknown as MessageEvent<unknown>)

    await expect(promise).rejects.toMatchObject({
      message: '后台AI任务失败',
      name: 'AI_TASK_FAILED',
    })
    await expect(promise).rejects.not.toHaveProperty('diagnostics')
  })

  it('probes content and background runtime health without using comctx', async () => {
    const promise = probeExtensionRuntimeHealth({ bridgeToken: 'probe-token', timeoutMs: 2000 })
    const [request, origin] = vi.mocked(window.postMessage).mock.calls[0] as [
      Record<string, string>,
      string,
    ]

    expect(request).toMatchObject({
      type: EXTENSION_RUNTIME_PROBE_REQUEST_TYPE,
      bridgeToken: 'probe-token',
    })
    messageHandler?.({
      data: {
        type: EXTENSION_RUNTIME_PROBE_RESPONSE_TYPE,
        requestId: request.requestId,
        bridgeToken: 'probe-token',
        ok: true,
        mainVersion: request.version,
        contentVersion: request.version,
        backgroundVersion: request.version,
      },
      origin,
      source: window,
    } as unknown as MessageEvent<unknown>)

    await expect(promise).resolves.toMatchObject({
      mainVersion: request.version,
      contentVersion: request.version,
      backgroundVersion: request.version,
    })
  })

  it('fails the runtime probe quickly when the content script does not respond', async () => {
    const promise = probeExtensionRuntimeHealth({ bridgeToken: 'stale-token', timeoutMs: 2000 })
    const rejection = expect(promise).rejects.toMatchObject({
      code: 'CONTENT_SCRIPT_UNAVAILABLE',
    })

    await vi.advanceTimersByTimeAsync(2000)
    await rejection
  })

  it('subscribes to validated public config revision messages', () => {
    const listener = vi.fn()
    const unsubscribe = onConfigRevisionChanged(listener)

    for (const bridgeToken of [null, undefined]) {
      messageHandler?.({
        data: {
          type: 'AGENT_DELIVERY_CONFIG_REVISION_CHANGED',
          configRevision: 9,
          bridgeToken,
        },
        origin: document.location.origin,
        source: window,
      } as unknown as MessageEvent<unknown>)
    }

    expect(listener).toHaveBeenCalledWith(9)
    unsubscribe()
    expect(window.removeEventListener).toHaveBeenCalled()
  })
})
