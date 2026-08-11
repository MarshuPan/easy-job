import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  afterHooks,
  getRootVue,
  loggerInfo,
  loggerWarn,
  route,
  startPendingGreetingConsumer,
  zhipinModuleLoaded,
  zhipinModuleState,
  zhipinRun,
} = vi.hoisted(() => {
  const afterHooks: Array<(router: { path: string }) => void | Promise<void>> = []
  const route = { path: '/web/geek/chat' }
  return {
    afterHooks,
    getRootVue: vi.fn(async () => ({
      $route: route,
      $router: { afterHooks },
    })),
    loggerInfo: vi.fn(),
    loggerWarn: vi.fn(),
    route,
    startPendingGreetingConsumer: vi.fn(),
    zhipinModuleLoaded: vi.fn(),
    zhipinModuleState: { wait: Promise.resolve() as Promise<void> },
    zhipinRun: vi.fn(),
  }
})

vi.mock('axios', () => ({
  default: {
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
  },
}))

vi.mock('@/composables/useVue', () => ({
  getRootVue,
}))

vi.mock('@/composables/useWebSocket/pendingGreeting', () => ({
  startPendingGreetingConsumer,
}))

vi.mock('@/pages/zhipin', async () => {
  await zhipinModuleState.wait
  zhipinModuleLoaded()
  return { run: zhipinRun }
})

vi.mock('@/utils', () => ({
  loader: vi.fn(() => vi.fn()),
}))

vi.mock('@/utils/logger', () => ({
  logger: {
    error: vi.fn(),
    info: loggerInfo,
    warn: loggerWarn,
  },
}))

describe('main-world entrypoint', () => {
  const logoUrl = 'chrome-extension://test-extension/icons/logo.png'
  const personalUrl = 'chrome-extension://test-extension/options.html'

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    afterHooks.length = 0
    route.path = '/web/geek/chat'
    zhipinModuleState.wait = Promise.resolve()
    document.body.innerHTML = ''
    window.history.replaceState({}, '', '/web/geek/chat')
    const mainWorldScript = document.createElement('script')
    mainWorldScript.src = 'chrome-extension://test-extension/main-world.js'
    mainWorldScript.dataset.agentDeliveryLogoUrl = logoUrl
    mainWorldScript.dataset.agentDeliveryPersonalUrl = personalUrl
    Object.defineProperty(document, 'currentScript', {
      configurable: true,
      value: mainWorldScript,
    })
  })

  afterEach(() => {
    Reflect.deleteProperty(document, 'currentScript')
  })

  it('keeps the chat page lightweight without mounting the job UI', async () => {
    const entrypoint = (await import('../entrypoints/main-world'))
      .default as unknown as () => void | Promise<void>

    await entrypoint()

    expect(getRootVue).not.toHaveBeenCalled()
    expect(startPendingGreetingConsumer).toHaveBeenCalledTimes(1)
    expect(document.querySelector('#agent-delivery-job')).toBeNull()
    expect(document.querySelector('#agent-delivery')).toBeNull()
    expect(loggerInfo).not.toHaveBeenCalledWith('Easy Job 加载成功')
    expect(loggerWarn).not.toHaveBeenCalledWith('当前页面无对应hook脚本', '/web/geek/chat')
  })

  it('ignores a stale job UI import after a newer route has already hidden the popup', async () => {
    let resolveModule: (() => void) | undefined
    zhipinModuleState.wait = new Promise<void>((resolve) => {
      resolveModule = resolve
    })
    route.path = '/web/geek/jobs'
    window.history.replaceState({}, '', '/web/geek/jobs')
    const jobRoot = document.createElement('div')
    jobRoot.id = 'agent-delivery-job'
    document.body.appendChild(jobRoot)
    const entrypoint = (await import('../entrypoints/main-world'))
      .default as unknown as () => void | Promise<void>

    await entrypoint()
    await vi.waitFor(() => expect(afterHooks).toHaveLength(1))
    await afterHooks[0]?.({ path: '/web/geek/home' })
    resolveModule?.()
    await vi.waitFor(() => expect(zhipinModuleLoaded).toHaveBeenCalledOnce())

    expect(jobRoot.hidden).toBe(true)
    expect(zhipinRun).not.toHaveBeenCalled()
  })

  it('shows the existing popup only on job routes and hides it elsewhere', async () => {
    route.path = '/web/geek/jobs'
    window.history.replaceState({}, '', '/web/geek/jobs')
    const jobRoot = document.createElement('div')
    jobRoot.id = 'agent-delivery-job'
    jobRoot.hidden = true
    document.body.appendChild(jobRoot)
    const entrypoint = (await import('../entrypoints/main-world'))
      .default as unknown as () => void | Promise<void>
    const visibilityEvents: boolean[] = []
    const visibilityListener = (event: Event) => {
      visibilityEvents.push((event as CustomEvent<{ visible: boolean }>).detail.visible)
    }
    window.addEventListener('agent-delivery:job-ui-visibility', visibilityListener)

    try {
      await entrypoint()
      await vi.waitFor(() => expect(zhipinRun).toHaveBeenCalledTimes(1))

      expect(afterHooks).toHaveLength(1)
      expect(jobRoot.hidden).toBe(false)
      expect(document.querySelector('#agent-delivery')).toBeNull()
      expect(zhipinRun).toHaveBeenLastCalledWith({
        logoUrl,
        personalUrl,
        instanceId: expect.any(String),
      })

      await afterHooks[0]?.({ path: '/web/geek/home' })
      expect(jobRoot.hidden).toBe(true)

      await afterHooks[0]?.({ path: '/web/geek/job-recommend' })
      expect(jobRoot.hidden).toBe(false)
      expect(zhipinRun).toHaveBeenCalledTimes(2)
      expect(visibilityEvents).toEqual([true, false, true])
    } finally {
      window.removeEventListener('agent-delivery:job-ui-visibility', visibilityListener)
    }
  })

  it('hides the popup and starts the existing chat consumer once after a route transition', async () => {
    route.path = '/web/geek/jobs'
    window.history.replaceState({}, '', '/web/geek/jobs')
    const jobRoot = document.createElement('div')
    jobRoot.id = 'agent-delivery-job'
    document.body.appendChild(jobRoot)
    const entrypoint = (await import('../entrypoints/main-world'))
      .default as unknown as () => void | Promise<void>

    await entrypoint()
    await vi.waitFor(() => expect(zhipinRun).toHaveBeenCalledTimes(1))

    await afterHooks[0]?.({ path: '/web/geek/chat' })
    await afterHooks[0]?.({ path: '/web/geek/chat' })

    expect(jobRoot.hidden).toBe(true)
    expect(startPendingGreetingConsumer).toHaveBeenCalledTimes(1)
  })
})
