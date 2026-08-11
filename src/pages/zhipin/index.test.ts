import { beforeEach, describe, expect, it, vi } from 'vitest'

import { EXTENSION_CONTEXT_INVALIDATED_EVENT } from '@/utils/extensionRuntimeHealth'

const { appMount, appUnmount, createApp, createPinia, loggerInfo } = vi.hoisted(() => {
  const appUse = vi.fn()
  const appMount = vi.fn()
  const appUnmount = vi.fn()
  const createApp = vi.fn(() => ({
    use: appUse,
    mount: appMount,
    unmount: appUnmount,
  }))

  return {
    appMount,
    appUnmount,
    appUse,
    createApp,
    createPinia: vi.fn(() => ({})),
    loggerInfo: vi.fn(),
  }
})

vi.mock('vue', () => ({
  createApp,
}))

vi.mock('pinia', () => ({
  createPinia,
}))

vi.mock('@/utils/logger', () => ({
  logger: {
    info: loggerInfo,
  },
}))

vi.mock('./components/Ui.vue', () => ({
  default: { name: 'UiStub' },
}))

import { run } from './index'

describe('zhipin page UI mounting', () => {
  const options = {
    logoUrl: 'chrome-extension://test-extension/icons/logo.png',
    personalUrl: 'chrome-extension://test-extension/options.html',
    instanceId: 'instance-a',
  }

  beforeEach(() => {
    window.dispatchEvent(new Event(EXTENSION_CONTEXT_INVALIDATED_EVENT))
    vi.clearAllMocks()
    document.body.innerHTML = `
      <main class="job-search-wrapper" style="width: 870px">
        <div data-test="official-search">official search</div>
        <div data-test="official-list">official list</div>
      </main>
    `
    window.history.replaceState({}, '', '/web/geek/job-recommend')
  })

  it('mounts the plugin at document.body without modifying the official page DOM', async () => {
    const officialWrapper = document.querySelector<HTMLElement>('.job-search-wrapper')!
    const officialMarkup = officialWrapper.outerHTML
    const officialChildren = [...officialWrapper.children]

    await run(options)

    const jobRoot = document.querySelector<HTMLElement>('#agent-delivery-job')

    expect(jobRoot).not.toBeNull()
    expect(jobRoot?.parentElement).toBe(document.body)
    expect(document.querySelector('#agent-delivery-job-warp')).toBeNull()
    expect(officialWrapper.outerHTML).toBe(officialMarkup)
    expect([...officialWrapper.children]).toEqual(officialChildren)
    expect(officialWrapper.hasAttribute('help')).toBe(false)
    expect(createApp).toHaveBeenCalledWith(expect.anything(), options)
    expect(appMount).toHaveBeenCalledWith(jobRoot)
  })

  it('reuses the mounted UI root when the route hook runs again', async () => {
    await run(options)
    await run(options)

    expect(document.querySelectorAll('#agent-delivery-job')).toHaveLength(1)
    expect(createApp).toHaveBeenCalledTimes(1)
    expect(appMount).toHaveBeenCalledTimes(1)
  })

  it('replaces a root owned by a previous extension instance', async () => {
    await run(options)
    await run({ ...options, instanceId: 'instance-b' })

    expect(document.querySelectorAll('#agent-delivery-job')).toHaveLength(1)
    expect(createApp).toHaveBeenCalledTimes(2)
    expect(appUnmount).toHaveBeenCalledOnce()
  })

  it('unmounts and removes the plugin root when the extension context expires', async () => {
    await run(options)

    window.dispatchEvent(new Event(EXTENSION_CONTEXT_INVALIDATED_EVENT))

    expect(document.querySelector('#agent-delivery-job')).toBeNull()
    expect(appUnmount).toHaveBeenCalledOnce()
  })
})
