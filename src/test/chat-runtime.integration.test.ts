import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { store, sent, append, rootVue } = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  sent: vi.fn((_args: unknown) => 'ChatWebsocket' as const),
  append: vi.fn(async (_input: unknown) => true),
  rootVue: vi.fn(),
}))
vi.mock('@/message', () => ({
  counter: {
    storageGet: vi.fn(async (key: string, fallback: unknown) => store.get(key) ?? fallback),
    storageSet: vi.fn(async (key: string, value: unknown) => {
      store.set(key, structuredClone(value))
    }),
    storageRm: vi.fn(async (key: string) => store.delete(key)),
    configRuntime: vi.fn(async () => ({
      accountInitialized: true,
      formData: { aiGreeting: { enable: true } },
    })),
    localDiagnosticAppend: append,
  },
}))
vi.mock('@/composables/useVue', () => ({ getRootVue: rootVue }))
vi.mock('@/composables/useWebSocket/protobuf', () => ({
  Message: class {
    constructor(private args: unknown) {}
    send() {
      return sent(this.args)
    }
  },
}))
vi.mock('@/composables/useWebSocket/chatNetworkFeedback', () => ({
  startChatNetworkFeedbackObserver: vi.fn(),
}))
vi.mock('@/composables/useWebSocket/chatFeedback', () => ({ startChatFeedbackObserver: vi.fn() }))
vi.mock('@/utils/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

describe('synthetic chat page: account initialization through queue handoff', () => {
  let stopConsumer: (() => void) | undefined
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
    store.clear()
    document.body.innerHTML = ''
    window.history.replaceState({}, '', '/web/geek/chat')
    Object.assign(window, {
      _PAGE: { isGeekChat: true },
      GeekChatCore: undefined,
      ChatWebsocket: { send: vi.fn(), client: { isConnected: () => true } },
    })
    rootVue.mockResolvedValue({ $store: { state: { userInfo: { userId: 10001 } } } })
    const script = document.createElement('script')
    script.dataset.agentDeliveryToken = 'integration-token'
    Object.defineProperty(document, 'currentScript', { configurable: true, value: script })
    vi.spyOn(window, 'postMessage').mockImplementation((data) => {
      window.dispatchEvent(
        new MessageEvent('message', { data, source: window, origin: location.origin }),
      )
    })
  })
  afterEach(() => {
    stopConsumer?.()
    Reflect.deleteProperty(document, 'currentScript')
    vi.useRealTimers()
  })

  it('initializes from the page store without _PAGE.uid, confirms readiness, and sends once', async () => {
    store.set('local:pending-greetings', [
      {
        id: 'pending-integration',
        createdAt: Date.now(),
        type: 'ai',
        fromUid: '10001',
        toUid: '20002',
        toName: 'fixture-recipient',
        content: '测试招呼语',
        status: { stage: 'queued', observedAt: Date.now() },
      },
    ])
    const entry = (await import('../entrypoints/main-world')).default as unknown as () => void
    const queue = await import('@/composables/useWebSocket/pendingGreeting')
    stopConsumer = queue.stopPendingGreetingConsumer
    entry()
    const { requestMainWorldChatRuntime } = await import('@/message/chatRuntimeBridge')
    const { CHAT_RUNTIME_REQUEST } = await import('@/message/chatRuntimeProtocol')
    const result = await requestMainWorldChatRuntime(
      {
        type: CHAT_RUNTIME_REQUEST,
        requestId: 'integration-ready',
        expectedUid: '10001',
        wake: true,
      },
      'integration-token',
    )
    expect(result).toMatchObject({
      ready: true,
      accountReady: true,
      accountMatches: true,
      consumerStarted: true,
      channelReady: true,
      wakeDelivered: true,
    })
    expect((await import('@/stores/user')).useUser().getUserId()).toBe(10001)
    await vi.advanceTimersByTimeAsync(12_000)
    expect(sent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ form_uid: '10001', to_uid: '20002', content: '测试招呼语' }),
    )
    expect(store.has('local:pending-greetings')).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(sent).toHaveBeenCalledTimes(1)
    const stages = append.mock.calls.map(([event]) => (event as any).data?.stage)
    expect(stages).toContain('sending')
    expect(stages).toContain('local-channel-handoff')
    expect(document.querySelector('#agent-delivery-job')).toBeNull()
  })
})
