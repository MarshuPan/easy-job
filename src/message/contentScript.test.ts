import { describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

import {
  DELIVERY_WORKER_IDENTITY_REQUEST_TYPE,
  DELIVERY_WORKER_IDENTITY_RESPONSE_TYPE,
} from '@/message/types'
import { AI_TASK_REQUEST_TYPE, AI_TASK_RESPONSE_TYPE } from '@/utils/backgroundAiProtocol'
import {
  EXTENSION_BACKGROUND_PROBE_REQUEST_TYPE,
  EXTENSION_BACKGROUND_PROBE_RESPONSE_TYPE,
  EXTENSION_CONTEXT_INVALIDATED_EVENT,
  EXTENSION_RUNTIME_PROBE_REQUEST_TYPE,
  EXTENSION_RUNTIME_PROBE_RESPONSE_TYPE,
  getCurrentAppVersion,
} from '@/utils/extensionRuntimeHealth'

import type { BackgroundCounterApi } from './types'

const { runtimeListeners, runtimeSendMessage, storageGet } = vi.hoisted(() => ({
  runtimeListeners: [] as Array<(message: unknown) => unknown>,
  runtimeSendMessage: vi.fn().mockResolvedValue(undefined),
  storageGet: vi.fn().mockResolvedValue(null),
}))

vi.mock('#imports', () => ({
  browser: {
    runtime: {
      id: 'test-extension',
      onMessage: {
        addListener: vi.fn((listener) => runtimeListeners.push(listener)),
        removeListener: vi.fn(),
      },
      sendMessage: runtimeSendMessage,
    },
  },
  storage: {
    getItem: storageGet,
    removeItem: vi.fn(),
    setItem: vi.fn(),
  },
}))

import * as contentScriptModule from './contentScript'

const { ContentCounter, InjectBackgroundAdapter, ProvideContentAdapter, setBridgeToken } =
  contentScriptModule

describe('MAIN-world content counter', () => {
  it('resolves a tab-scoped delivery worker identity through a direct runtime message', async () => {
    runtimeSendMessage.mockResolvedValueOnce({
      type: DELIVERY_WORKER_IDENTITY_RESPONSE_TYPE,
      workerId: 'boss-tab-9:session-token-123',
    })
    const background = {} as BackgroundCounterApi
    const counter = new ContentCounter(background)

    await expect(counter.deliveryWorkerIdentity('session-token-123')).resolves.toBe(
      'boss-tab-9:session-token-123',
    )
    expect(runtimeSendMessage).toHaveBeenCalledWith('test-extension', {
      type: DELIVERY_WORKER_IDENTITY_REQUEST_TYPE,
      sessionToken: 'session-token-123',
    })
  })

  it('keeps both content bridge directions structured-cloneable', async () => {
    setBridgeToken('clone-token')
    const postMessage = vi
      .spyOn(window, 'postMessage')
      .mockImplementation((message) => structuredClone(message))
    runtimeSendMessage.mockImplementationOnce(async (_extensionId, message) => {
      structuredClone(message)
      return undefined
    })
    const payload = reactive([{ id: 'expect-1' }])

    new ProvideContentAdapter().sendMessage(
      {
        args: [payload],
        id: 'content-message',
        namespace: '__agent-delivery-content__',
        path: ['configRuntime'],
        sender: 'provider',
        type: 'result',
      } as never,
      undefined as never,
    )
    await new InjectBackgroundAdapter().sendMessage(
      {
        args: [payload],
        id: 'background-message',
        namespace: '__agent-delivery-background__',
        path: ['configRuntimeSave'],
        sender: 'injector',
        type: 'apply',
      } as never,
      undefined as never,
    )

    expect(postMessage).toHaveBeenCalledOnce()
    expect(runtimeSendMessage).toHaveBeenCalledOnce()
    postMessage.mockRestore()
  })

  it('forwards only the public config revision to the active MAIN-world bridge', () => {
    setBridgeToken('revision-token')
    const postMessage = vi.spyOn(window, 'postMessage')

    for (const listener of runtimeListeners) {
      listener({
        type: 'AGENT_DELIVERY_CONFIG_REVISION_CHANGED',
        configRevision: 7,
        apiKey: 'must-not-forward',
      })
      listener({
        type: 'AGENT_DELIVERY_CONFIG_REVISION_CHANGED',
        configRevision: 8,
      })
    }

    expect(postMessage).toHaveBeenCalledWith(
      {
        type: 'AGENT_DELIVERY_CONFIG_REVISION_CHANGED',
        configRevision: 8,
        bridgeToken: 'revision-token',
      },
      window.location.origin,
    )
    expect(JSON.stringify(postMessage.mock.calls)).not.toContain('must-not-forward')
    postMessage.mockRestore()
  })

  it.each(['conf-model', 'sync:signedKey', 'sync:signedKeyInfo', 'local:conf-user'])(
    'rejects sensitive storage key %s before reading extension storage',
    async (key) => {
      const counter = new ContentCounter({} as BackgroundCounterApi)

      await expect(counter.storageGet(key)).rejects.toThrow(`storage key is not allowed: ${key}`)
      expect(storageGet).not.toHaveBeenCalled()
    },
  )

  it('projects legacy FormData before returning it to MAIN world', async () => {
    const privatePrompt = 'legacy-private-prompt'
    storageGet.mockResolvedValueOnce({
      userId: 'account-a',
      customGreeting: { enable: true, value: '公开招呼语' },
      aiGreeting: {
        enable: true,
        model: 'private-model-key',
        prompt: privatePrompt,
        vip: 'private-vip-value',
      },
      amap: { enable: true, key: 'operational-amap-key', origins: '116.397,39.908' },
      record: { enable: true, model: ['private-record-model'] },
    })
    const counter = new ContentCounter({} as BackgroundCounterApi)

    const result = await counter.storageGet('local:web-geek-job-FormData')
    const serialized = JSON.stringify(result)

    expect(result).toEqual({
      userId: 'account-a',
      customGreeting: { enable: true, value: '公开招呼语' },
      aiGreeting: { enable: true, prompt: privatePrompt },
      amap: {
        enable: true,
        key: 'operational-amap-key',
        origins: '116.397,39.908',
      },
      record: { enable: true },
    })
    for (const secret of ['private-model-key', 'private-vip-value', 'private-record-model']) {
      expect(serialized).not.toContain(secret)
    }
  })

  it('allows the statistics epoch used by the runtime merge protocol', async () => {
    storageGet.mockResolvedValueOnce(7)
    const counter = new ContentCounter({} as BackgroundCounterApi)

    await expect(counter.storageGet('local:web-geek-job-StatisticsEpoch')).resolves.toBe(7)
    expect(storageGet).toHaveBeenCalledWith('local:web-geek-job-StatisticsEpoch', {
      fallback: undefined,
    })
  })

  it('normalizes a stale WXT storage context and asks the old page UI to stop', async () => {
    storageGet.mockRejectedValueOnce(
      new Error("'wxt/storage' must be loaded in a web extension environment"),
    )
    const invalidated = vi.fn()
    window.addEventListener(EXTENSION_CONTEXT_INVALIDATED_EVENT, invalidated, { once: true })
    const counter = new ContentCounter({} as BackgroundCounterApi)

    await expect(counter.storageGet('local:web-geek-job-Statistics')).rejects.toThrow(
      'Extension context invalidated.',
    )
    expect(invalidated).toHaveBeenCalledOnce()
  })

  it.each([
    'local:web-geek-job-DeliveryLogs:account-a',
    'local:web-geek-job-SourcePools:123456',
    'local:web-geek-job-SearchRotation:account-a',
    'local:web-geek-job-Statistics:account_a',
    'local:web-geek-job-StatisticsEpoch:account-a',
    'local:web-geek-job-Today:123456',
    'local:agent-delivery-runtime-logs:account-a',
  ])('allows an account-scoped runtime storage key %s', async (key) => {
    const counter = new ContentCounter({} as BackgroundCounterApi)

    await expect(counter.storageGet(key)).resolves.toBeNull()
  })

  it.each([
    'local:web-geek-job-DeliveryLogs:',
    'local:web-geek-job-DeliveryLogs:account/a',
    'local:web-geek-job-SearchRotation:account/a',
    'local:web-geek-job-Unknown:account-a',
    'local:agent-delivery-runtime-logs:',
    'local:agent-delivery-runtime-logs:account/a',
  ])('rejects a malformed account-scoped storage key %s', async (key) => {
    const counter = new ContentCounter({} as BackgroundCounterApi)

    await expect(counter.storageGet(key)).rejects.toThrow(`storage key is not allowed: ${key}`)
  })

  it('does not expose cookie or raw request methods to MAIN world', () => {
    const counter = new ContentCounter({} as BackgroundCounterApi)

    for (const method of [
      'cookieInfo',
      'cookieSave',
      'cookieSwitch',
      'cookieDelete',
      'cookieClear',
      'request',
    ]) {
      expect(counter).not.toHaveProperty(method)
    }
  })

  it('forwards a single account state lookup to background', async () => {
    const accountState = vi.fn(async (uid: string) => ({ uid }))
    const counter = new ContentCounter({
      accountState,
    } as unknown as BackgroundCounterApi) as InstanceType<typeof ContentCounter> & {
      accountState(uid: string): Promise<unknown>
    }

    await expect(counter.accountState('account-b')).resolves.toEqual({ uid: 'account-b' })
    expect(accountState).toHaveBeenCalledOnce()
    expect(accountState).toHaveBeenCalledWith('account-b')
  })

  it('allows only the narrow accountState method through the page RPC whitelist', () => {
    setBridgeToken('account-state-token')
    const isPageMessage = (
      contentScriptModule as typeof contentScriptModule & {
        isPageMessage(event: MessageEvent): boolean
      }
    ).isPageMessage
    const event = new MessageEvent('message', {
      data: {
        namespace: '__agent-delivery-content__',
        sender: 'injector',
        type: 'apply',
        path: ['accountState'],
        meta: { bridgeToken: 'account-state-token' },
      },
      origin: window.location.origin,
      source: window,
    })

    expect(isPageMessage).toBeTypeOf('function')
    expect(isPageMessage(event)).toBe(true)
  })

  it('returns an explicit error for a structurally invalid AI task request', () => {
    setBridgeToken('ai-validation-token')
    runtimeSendMessage.mockClear()
    const postMessage = vi.spyOn(window, 'postMessage')

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: AI_TASK_REQUEST_TYPE,
          requestId: 'invalid-ai-request',
          task: 'aiFiltering',
          data: {},
          bridgeToken: 'ai-validation-token',
          model: 'forbidden-page-model',
        },
        origin: window.location.origin,
        source: window,
      }),
    )

    expect(runtimeSendMessage).not.toHaveBeenCalled()
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: AI_TASK_RESPONSE_TYPE,
        requestId: 'invalid-ai-request',
        ok: false,
        errorCode: 'AI_TASK_FAILED',
        error: '后台AI任务失败',
      }),
      window.location.origin,
    )
    postMessage.mockRestore()
  })

  it('limits each tab to two concurrent AI tasks and returns an explicit error', async () => {
    setBridgeToken('ai-concurrency-token')
    runtimeSendMessage.mockClear()
    const resolvers: Array<(value: unknown) => void> = []
    runtimeSendMessage.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)))
    const postMessage = vi.spyOn(window, 'postMessage')

    for (let index = 1; index <= 3; index += 1) {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: AI_TASK_REQUEST_TYPE,
            requestId: `concurrent-ai-${index}`,
            task: 'aiFiltering',
            data: {},
            bridgeToken: 'ai-concurrency-token',
          },
          origin: window.location.origin,
          source: window,
        }),
      )
    }

    expect(runtimeSendMessage).toHaveBeenCalledTimes(2)
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: AI_TASK_RESPONSE_TYPE,
        requestId: 'concurrent-ai-3',
        ok: false,
        errorCode: 'AI_TASK_FAILED',
        error: '后台AI任务失败',
      }),
      window.location.origin,
    )

    resolvers.forEach((resolve) => resolve(undefined))
    await Promise.resolve()
    await Promise.resolve()
    runtimeSendMessage.mockResolvedValue(undefined)
    postMessage.mockRestore()
  })

  it('uses a sliding window rate limit that recovers after old requests expire', () => {
    const AdmissionController = (
      contentScriptModule as typeof contentScriptModule & {
        AiTaskAdmissionController: new (options: {
          maxConcurrent: number
          maxRequests: number
          windowMs: number
        }) => {
          acquire(now: number): { ok: true; release: () => void } | { ok: false; error: string }
        }
      }
    ).AiTaskAdmissionController

    expect(AdmissionController).toBeTypeOf('function')
    const admission = new AdmissionController({
      maxConcurrent: 2,
      maxRequests: 2,
      windowMs: 60_000,
    })
    const first = admission.acquire(0)
    expect(first.ok).toBe(true)
    if (first.ok) first.release()
    const second = admission.acquire(30_000)
    expect(second.ok).toBe(true)
    if (second.ok) second.release()

    expect(admission.acquire(59_999)).toEqual({
      ok: false,
      error: expect.stringContaining('速率超过 2 次/60秒限制'),
    })
    expect(admission.acquire(60_000).ok).toBe(true)
  })

  it('does not forward raw page background requests even with the DOM bridge token', () => {
    setBridgeToken('observable-page-token')

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'agent-delivery:page-background-request',
          requestId: 'raw-request-1',
          bridgeToken: 'observable-page-token',
          args: {
            url: 'https://ai.example.test/v1/chat/completions',
            data: {
              method: 'POST',
              headers: {
                Authorization: 'Bearer exposed-page-key',
                'Content-Type': 'application/json',
              },
              body: '{"messages":[]}',
            },
            timeout: 30,
            responseType: 'json',
          },
        },
        origin: window.location.origin,
        source: window,
      }),
    )

    expect(runtimeSendMessage).not.toHaveBeenCalled()
  })

  it('returns content and background health for the active bridge token', async () => {
    setBridgeToken('runtime-probe-token')
    runtimeSendMessage.mockResolvedValueOnce({
      type: EXTENSION_BACKGROUND_PROBE_RESPONSE_TYPE,
      requestId: 'runtime-probe-1',
      ok: true,
      version: getCurrentAppVersion(),
    })
    const postMessage = vi.spyOn(window, 'postMessage')

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: EXTENSION_RUNTIME_PROBE_REQUEST_TYPE,
          requestId: 'runtime-probe-1',
          bridgeToken: 'runtime-probe-token',
          version: getCurrentAppVersion(),
        },
        origin: window.location.origin,
        source: window,
      }),
    )
    await vi.waitFor(() => {
      expect(runtimeSendMessage).toHaveBeenCalledWith('test-extension', {
        type: EXTENSION_BACKGROUND_PROBE_REQUEST_TYPE,
        requestId: 'runtime-probe-1',
      })
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: EXTENSION_RUNTIME_PROBE_RESPONSE_TYPE,
          requestId: 'runtime-probe-1',
          bridgeToken: 'runtime-probe-token',
          ok: true,
        }),
        window.location.origin,
      )
    })
    postMessage.mockRestore()
  })
})
