import type { VueWrapper } from '@vue/test-utils'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AGENT_MESSAGE_BRIDGE_CHANNEL } from '@/ui/message'
import { ExtensionRuntimeHealthError } from '@/utils/extensionRuntimeHealth'
import { JOB_UI_VISIBILITY_EVENT } from '@/utils/zhipinRoute'

import Ui from './Ui.vue'

enableAutoUnmount(afterEach)
const logoUrl = 'chrome-extension://test-extension/icons/logo.png'
const personalUrl = 'chrome-extension://test-extension/options.html'

const {
  confInit,
  formData,
  hydrateLogs,
  hydrateRuntimeLogs,
  initJobList,
  initPager,
  initUser,
  loggerError,
  loggerWarn,
  messageError,
  messageInfo,
  messageSuccess,
  messageWarning,
  probeExtensionRuntimeHealth,
  resetRuntimeSettings,
  setJobAccountScope,
  setLogAccountScope,
  setStatisticsAccountScope,
} = vi.hoisted(() => ({
  confInit: vi.fn(async () => undefined),
  formData: {
    aiFiltering: { enable: true, score: 60 },
    aiGreeting: { enable: true },
    deliveryLimit: { search: 150, group: 60 },
    delay: {
      deliveryInterval: 30,
      deliveryIntervalMax: 60,
      batchSize: 30,
      batchRestMinutes: 10,
    },
    useCache: { value: false },
  },
  hydrateLogs: vi.fn(async () => undefined),
  hydrateRuntimeLogs: vi.fn(async () => undefined),
  initJobList: vi.fn(async () => undefined),
  initPager: vi.fn(async () => undefined),
  initUser: vi.fn(async () => undefined),
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
  messageError: vi.fn(),
  messageInfo: vi.fn(),
  messageSuccess: vi.fn(),
  messageWarning: vi.fn(),
  probeExtensionRuntimeHealth: vi.fn(async () => undefined),
  resetRuntimeSettings: vi.fn(async () => true),
  setJobAccountScope: vi.fn(async () => undefined),
  setLogAccountScope: vi.fn(async () => undefined),
  setStatisticsAccountScope: vi.fn(async () => undefined),
}))

vi.mock('@/composables/useStatistics', () => ({
  useStatistics: () => ({
    setAccountScope: setStatisticsAccountScope,
  }),
}))

vi.mock('@/stores/conf', () => ({
  useConf: () => ({
    confInit,
    isLoaded: true,
    formData,
    readiness: {
      aiFilteringReady: true,
      aiGreetingReady: true,
    },
  }),
}))

vi.mock('@/message', () => ({
  probeExtensionRuntimeHealth,
}))

vi.mock('@/stores/jobs', () => ({
  jobList: {
    initJobList,
    setAccountScope: setJobAccountScope,
  },
}))

vi.mock('@/stores/log', () => ({
  useLog: () => ({
    hydrate: hydrateLogs,
    hydrateRuntimeLogs,
    setAccountScope: setLogAccountScope,
  }),
}))

vi.mock('@/stores/user', () => ({
  useUser: () => ({
    getUserId: vi.fn(() => 'account-a'),
    initUser,
  }),
}))

vi.mock('@/utils/logger', () => ({
  logger: {
    error: loggerError,
    info: vi.fn(),
    warn: loggerWarn,
  },
}))

vi.mock('../hooks/usePager', () => ({
  usePager: () => ({
    initPager,
  }),
}))

vi.mock('./Config.vue', () => ({
  default: {
    name: 'Config',
    props: ['section'],
    template: '<section data-test="filter-config">filters</section>',
  },
}))

vi.mock('./OperationPanel.vue', () => ({
  default: {
    name: 'OperationPanel',
    props: ['runtimeReady'],
    emits: ['open-settings', 'show-search', 'show-group', 'show-logs'],
    template: `
      <section data-test="delivery-console" :data-runtime-ready="String(runtimeReady)">
        <button data-test="open-settings" @click="$emit('open-settings')">运行配置</button>
        <button data-test="show-search" @click="$emit('show-search')">岗位规则</button>
        <button data-test="show-group" @click="$emit('show-group')">求职期望来源</button>
        <button data-test="show-logs" @click="$emit('show-logs')">运行日志</button>
      </section>
    `,
  },
}))

vi.mock('./DeliveryRecords.vue', () => ({
  default: {
    name: 'DeliveryRecords',
    props: ['visible'],
    template:
      '<section data-test="delivery-records" :data-visible="String(visible)">records</section>',
  },
}))

vi.mock('./Logs.vue', () => ({
  default: {
    name: 'Logs',
    template: '<section data-test="logs">logs</section>',
  },
}))

vi.mock('./RuntimeSettingsDrawer.vue', () => ({
  default: {
    name: 'RuntimeSettingsDrawer',
    data: () => ({ draft: '' }),
    methods: { resetRuntimeSettings },
    template: `
      <section data-test="runtime-settings">
        <div class="runtime-settings__toolbar instrument-view-toolbar">
          <strong>运行配置</strong>
          <button data-test="reset-runtime-settings" @click="resetRuntimeSettings">重置</button>
        </div>
        <input data-test="runtime-settings-draft" v-model="draft" />
      </section>
    `,
  },
}))

vi.mock('@/ui/instrument', async () => {
  const actual = await vi.importActual<typeof import('@/ui/instrument')>('@/ui/instrument')
  return {
    ...actual,
    AgentMessage: {
      error: messageError,
      info: messageInfo,
      success: messageSuccess,
      warning: messageWarning,
    },
  }
})

function menuButton(wrapper: VueWrapper, label: string) {
  const button = wrapper
    .findAll('.agent-delivery-workspace__nav-item')
    .find((item) => item.text().includes(label))
  if (!button) throw new Error(`Missing menu button: ${label}`)
  return button
}

function mountUi() {
  const jobRoot = document.createElement('div')
  jobRoot.id = 'agent-delivery-job'
  document.body.appendChild(jobRoot)
  return mount(Ui, {
    attachTo: jobRoot,
    props: { logoUrl, personalUrl },
  })
}

describe('zhipin popup UI shell', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.history.replaceState({}, '', '/web/geek/job-recommend')
    document.body.innerHTML = ''
    confInit.mockResolvedValue(undefined)
    hydrateLogs.mockResolvedValue(undefined)
    initJobList.mockResolvedValue(undefined)
    initPager.mockResolvedValue(undefined)
    initUser.mockResolvedValue(undefined)
    probeExtensionRuntimeHealth.mockResolvedValue(undefined)
    formData.useCache.value = false
  })

  it('waits for a sleeping background instead of failing startup on the first probe', async () => {
    // MV3 的后台 service worker 闲置几十秒就休眠，重新打开页面时第一次探测大概率失败。
    // 那不是故障，是它还没醒——裸探一次就判死会让每次重开页面都启动不了。
    probeExtensionRuntimeHealth
      .mockRejectedValueOnce(new ExtensionRuntimeHealthError('BACKGROUND_UNAVAILABLE'))
      .mockResolvedValue(undefined)

    mountUi()
    await flushPromises()
    await vi.waitFor(() => expect(confInit).toHaveBeenCalled())

    expect(setStatisticsAccountScope).toHaveBeenCalled()
    expect(messageError).not.toHaveBeenCalled()
  })

  it('reports a readable non-retryable runtime error and stops dependent initialization', async () => {
    // 通信桥的检查现在排在最前面。以前它排在账号数据之后，版本不一致会先把账号那一步炸掉，
    // 用户看到的是「账号数据加载失败」——真正该做的动作（重开页面）被这句话盖住了。
    probeExtensionRuntimeHealth.mockRejectedValueOnce(
      new ExtensionRuntimeHealthError('VERSION_MISMATCH'),
    )

    mountUi()
    await flushPromises()

    expect(setStatisticsAccountScope).not.toHaveBeenCalled()
    expect(confInit).not.toHaveBeenCalled()
    expect(initJobList).not.toHaveBeenCalled()
    expect(initPager).not.toHaveBeenCalled()
    expect(loggerWarn).not.toHaveBeenCalled()
    expect(loggerError).toHaveBeenCalledWith(
      '插件运行时不可用 [VERSION_MISMATCH] 插件页面与扩展版本不一致，请重新打开 BOSS 页面后再开始投递',
    )
    expect(messageError).toHaveBeenCalledWith(
      '插件页面与扩展版本不一致，请重新打开 BOSS 页面后再开始投递',
    )
    expect(loggerError.mock.calls.flat().join(' ')).not.toContain('[object Object]')
  })

  it('keeps an account-scope failure readable instead of logging an opaque object', async () => {
    // 这条路径上原来写的是 logger.error('...', { error: e })：控制台里是可展开对象，
    // 复制出来只剩 [object Object]，用户能贴过来的诊断等于空的。
    setStatisticsAccountScope.mockRejectedValueOnce(new Error('Provider unavailable: heartbeat'))

    mountUi()
    await flushPromises()

    expect(confInit).not.toHaveBeenCalled()
    const logged = loggerError.mock.calls.flat().join(' ')
    expect(logged).not.toContain('[object Object]')
    expect(logged).toContain('Provider unavailable: heartbeat')
    expect(messageError).toHaveBeenCalledWith('账号数据加载失败，请刷新后重试')
  })

  it('mounts secondary views on first visit and keeps them mounted across navigation', async () => {
    const wrapper = mountUi()
    await flushPromises()

    const launcher = wrapper.find('.agent-delivery-launcher')
    const overlay = wrapper.find('.agent-delivery-overlay')

    expect(launcher.find('.agent-delivery-logo').attributes('src')).toBe(logoUrl)
    expect(launcher.isVisible()).toBe(true)
    expect(overlay.isVisible()).toBe(false)
    expect(wrapper.find('[data-test="delivery-console"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="delivery-records"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="filter-config"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="runtime-settings"]').exists()).toBe(false)
    expect(wrapper.find('.agent-delivery-personal-frame').exists()).toBe(false)
    expect(wrapper.find('[data-test="logs"]').exists()).toBe(false)

    await launcher.trigger('click')

    expect(overlay.isVisible()).toBe(true)
    expect(
      wrapper.find('.agent-delivery-workspace__brand-mark.agent-delivery-logo').attributes('src'),
    ).toBe(logoUrl)
    expect(wrapper.find('.agent-delivery-workspace__rail').exists()).toBe(true)
    expect(wrapper.find('[data-agent-message-host]').exists()).toBe(true)
    expect(wrapper.findAll('.agent-delivery-workspace__rail-scale i')).toHaveLength(6)
    expect(
      wrapper.findAll('.agent-delivery-workspace__nav-number').map((item) => item.text()),
    ).toEqual(['01', '02', '03', '04', '05', '06'])
    expect(wrapper.find('.agent-delivery-workspace__title-block').text()).toContain(
      'DAILY DELIVERY / 150',
    )
    const menuStatus = wrapper.find(
      '.agent-delivery-workspace__menu .agent-delivery-workspace__config-state',
    )
    expect(menuStatus.text()).toContain('系统正常')
    expect(menuStatus.attributes('aria-label')).toBe('系统正常')
    expect(
      wrapper
        .find('.agent-delivery-workspace__header-actions .agent-delivery-workspace__config-state')
        .exists(),
    ).toBe(false)
    expect(wrapper.find('.agent-delivery-workspace__menu-foot').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('私有配置已加载')
    expect(wrapper.text()).not.toContain('账户配置')
    expect(wrapper.find('[data-test="reset-runtime-settings"]').exists()).toBe(false)
    expect(wrapper.find('[data-view="dashboard"]').isVisible()).toBe(true)

    await menuButton(wrapper, '运行配置').trigger('click')
    const settingsDraft = wrapper.get<HTMLInputElement>('[data-test="runtime-settings-draft"]')
    await settingsDraft.setValue('keep-this-draft')

    await menuButton(wrapper, '岗位规则').trigger('click')
    expect(wrapper.find('[data-test="filter-config"]').exists()).toBe(true)

    await menuButton(wrapper, '个人信息').trigger('click')
    expect(wrapper.find('[data-view="personal"]').isVisible()).toBe(true)
    expect(wrapper.find('.agent-delivery-workspace__title-block').text()).toContain(
      'PROFILE / AI / CONFIG',
    )
    expect(wrapper.get('.agent-delivery-personal-frame').attributes('src')).toBe(
      `${personalUrl}?uid=account-a`,
    )

    await menuButton(wrapper, '投递记录').trigger('click')

    expect(wrapper.find('[data-view="dashboard"]').isVisible()).toBe(false)
    expect(wrapper.find('[data-view="records"]').isVisible()).toBe(true)
    expect(wrapper.find('.agent-delivery-workspace__title-block').text()).toContain(
      'DELIVERY RECORDS',
    )
    expect(wrapper.find('[data-test="delivery-records"]').attributes('data-visible')).toBe('true')

    await menuButton(wrapper, '运行日志').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="logs"]').exists()).toBe(true)

    await menuButton(wrapper, '运行配置').trigger('click')
    expect(
      wrapper.get<HTMLInputElement>('[data-test="runtime-settings-draft"]').element.value,
    ).toBe('keep-this-draft')

    await wrapper.find('.agent-delivery-workspace__close').trigger('click')

    expect(overlay.isVisible()).toBe(false)
    expect(wrapper.find('[data-test="delivery-console"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="delivery-records"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="delivery-records"]').attributes('data-visible')).toBe('false')
  })

  it('routes only valid personal-frame notifications into the parent panel host', async () => {
    const wrapper = mountUi()
    await flushPromises()
    await wrapper.find('.agent-delivery-launcher').trigger('click')
    await menuButton(wrapper, '个人信息').trigger('click')
    const frame = wrapper.get<HTMLIFrameElement>('.agent-delivery-personal-frame').element
    const frameWindow = frame.contentWindow
    expect(frameWindow).not.toBeNull()
    if (frameWindow == null) return

    const payload = {
      channel: AGENT_MESSAGE_BRIDGE_CHANNEL,
      version: 1,
      type: 'success',
      content: '导入成功',
      duration: 3000,
    }
    window.dispatchEvent(
      new MessageEvent('message', {
        data: payload,
        origin: 'chrome-extension://test-extension',
        source: frameWindow,
      }),
    )
    expect(messageSuccess).toHaveBeenCalledWith('导入成功', 3000)

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { ...payload, content: '伪造来源' },
        origin: 'chrome-extension://test-extension',
        source: window,
      }),
    )
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { ...payload, content: '错误来源' },
        origin: 'https://example.com',
        source: frameWindow,
      }),
    )
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { ...payload, channel: 'other-channel', content: '非法载荷' },
        origin: 'chrome-extension://test-extension',
        source: frameWindow,
      }),
    )

    expect(messageSuccess).toHaveBeenCalledOnce()
    expect(messageInfo).not.toHaveBeenCalled()
    expect(messageWarning).not.toHaveBeenCalled()
    expect(messageError).not.toHaveBeenCalled()
  })

  it('moves a notification created before the panel into the single panel host on mount', async () => {
    const existingContainer = document.createElement('div')
    existingContainer.id = 'agent-ui-message-container'
    document.body.appendChild(existingContainer)

    const wrapper = mountUi()
    await flushPromises()

    expect(document.querySelectorAll('#agent-ui-message-container')).toHaveLength(1)
    expect(existingContainer.parentElement).toBe(wrapper.get('[data-agent-message-host]').element)
  })

  it('routes existing console actions into the matching right-side content', async () => {
    const wrapper = mountUi()
    await flushPromises()
    await wrapper.find('.agent-delivery-launcher').trigger('click')

    await wrapper.find('[data-test="open-settings"]').trigger('click')
    expect(wrapper.find('[data-view="settings"]').isVisible()).toBe(true)
    expect(
      wrapper
        .find('.agent-delivery-workspace__header-actions [data-test="reset-runtime-settings"]')
        .exists(),
    ).toBe(false)
    expect(wrapper.get('[data-test="reset-runtime-settings"]').text()).toContain('重置')
    expect(
      wrapper.get('[data-test="reset-runtime-settings"]').attributes('disabled'),
    ).toBeUndefined()
    await wrapper.get('[data-test="reset-runtime-settings"]').trigger('click')
    expect(resetRuntimeSettings).toHaveBeenCalledOnce()

    await menuButton(wrapper, '投递控制').trigger('click')
    await wrapper.find('[data-test="show-search"]').trigger('click')
    expect(wrapper.find('[data-view="filters"]').isVisible()).toBe(true)
  })

  it('hydrates stored logs before making the log view active', async () => {
    let resolveHydrate: (() => void) | undefined
    hydrateLogs.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          resolveHydrate = () => resolve(undefined)
        }),
    )
    const wrapper = mountUi()
    await flushPromises()
    await wrapper.find('.agent-delivery-launcher').trigger('click')

    await menuButton(wrapper, '运行日志').trigger('click')

    expect(hydrateLogs).toHaveBeenCalledOnce()
    expect(wrapper.find('[data-view="dashboard"]').isVisible()).toBe(true)
    expect(wrapper.find('[data-view="logs"]').isVisible()).toBe(false)

    resolveHydrate?.()
    await flushPromises()

    expect(wrapper.find('[data-view="dashboard"]').isVisible()).toBe(false)
    expect(wrapper.find('[data-view="logs"]').isVisible()).toBe(true)
  })

  it('does not let a slow log hydration override a newer menu selection', async () => {
    let resolveHydrate: (() => void) | undefined
    hydrateLogs.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          resolveHydrate = () => resolve(undefined)
        }),
    )
    const wrapper = mountUi()
    await flushPromises()
    await wrapper.find('.agent-delivery-launcher').trigger('click')

    await menuButton(wrapper, '运行日志').trigger('click')
    await menuButton(wrapper, '投递记录').trigger('click')
    resolveHydrate?.()
    await flushPromises()

    expect(wrapper.find('[data-view="records"]').isVisible()).toBe(true)
    expect(wrapper.find('[data-view="logs"]').isVisible()).toBe(false)
  })

  it('opens the in-memory log view even when hydration unexpectedly rejects', async () => {
    const error = new Error('storage unavailable')
    hydrateLogs.mockRejectedValueOnce(error)
    const wrapper = mountUi()
    await flushPromises()
    await wrapper.find('.agent-delivery-launcher').trigger('click')

    await menuButton(wrapper, '运行日志').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-view="logs"]').isVisible()).toBe(true)
    const loggedHydrationFailure = loggerError.mock.calls.flat().join(' ')
    expect(loggedHydrationFailure).toContain('加载运行日志失败')
    expect(loggedHydrationFailure).toContain(error.message)
    expect(loggedHydrationFailure).not.toContain('[object Object]')
  })

  it('closes the popup when the UI is hidden by a route change', async () => {
    const wrapper = mountUi()
    await flushPromises()
    await wrapper.find('.agent-delivery-launcher').trigger('click')

    expect(wrapper.find('.agent-delivery-overlay').isVisible()).toBe(true)

    window.dispatchEvent(
      new CustomEvent(JOB_UI_VISIBILITY_EVENT, {
        detail: { visible: false },
      }),
    )
    await flushPromises()

    expect(wrapper.find('.agent-delivery-overlay').isVisible()).toBe(false)
    expect(wrapper.find('[data-test="delivery-console"]').exists()).toBe(true)
  })

  it('moves focus into the dialog and restores it after Escape closes the popup', async () => {
    const wrapper = mountUi()
    await flushPromises()
    const launcher = wrapper.find<HTMLButtonElement>('.agent-delivery-launcher')
    launcher.element.focus()

    await launcher.trigger('click')
    await flushPromises()

    expect(document.activeElement).toBe(wrapper.find('.agent-delivery-workspace').element)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()

    expect(wrapper.find('.agent-delivery-overlay').isVisible()).toBe(false)
    expect(document.activeElement).toBe(launcher.element)
  })

  it('keeps the official jobs controls in their original DOM positions', async () => {
    window.history.replaceState({}, '', '/web/geek/jobs')
    document.body.innerHTML = `
      <main class="page-jobs-main">
        <section class="expect-and-search" style="position: sticky">
          <div class="c-search-input">search</div>
          <div class="c-expect-select" style="width: 420px">
            <button class="active">上海 AI产品经理</button>
          </div>
        </section>
        <section class="filter-condition" style="position: sticky">filters</section>
      </main>
    `
    const searchArea = document.querySelector<HTMLElement>('.expect-and-search')!
    const expectSelect = document.querySelector<HTMLElement>('.c-expect-select')!
    const filterArea = document.querySelector<HTMLElement>('.filter-condition')!
    const pageMarkup = document.querySelector<HTMLElement>('.page-jobs-main')!.outerHTML

    mountUi()
    await flushPromises()

    expect(document.querySelector<HTMLElement>('.page-jobs-main')!.outerHTML).toBe(pageMarkup)
    expect(expectSelect.parentElement).toBe(searchArea)
    expect(filterArea.parentElement).toBe(document.querySelector('.page-jobs-main'))
    expect(document.querySelector('.agent-delivery-native-stack')).toBeNull()
  })

  it('opens job rules for expectation source details without manipulating native controls', async () => {
    window.history.replaceState({}, '', '/web/geek/jobs')
    const staleTarget = document.createElement('div')
    staleTarget.className = 'c-expect-select'
    staleTarget.innerHTML = '<button class="active">上海 AI产品经理</button>'
    document.body.appendChild(staleTarget)
    const wrapper = mountUi()
    await flushPromises()

    staleTarget.remove()
    const currentTarget = document.createElement('div')
    currentTarget.className = 'c-expect-select'
    const currentButton = document.createElement('button')
    currentButton.textContent = '上海 AI产品经理'
    currentTarget.appendChild(currentButton)
    document.body.appendChild(currentTarget)
    const nativeClick = vi.spyOn(currentButton, 'click')

    await wrapper.find('.agent-delivery-launcher').trigger('click')
    await wrapper.find('[data-test="show-group"]').trigger('click')

    expect(wrapper.find('[data-view="filters"]').isVisible()).toBe(true)
    expect(wrapper.find('.agent-delivery-overlay').isVisible()).toBe(true)
    expect(nativeClick).not.toHaveBeenCalled()
  })

  it('waits for stored configuration before initializing the job cache runtime', async () => {
    let resolveConfInit: (() => void) | undefined
    confInit.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          resolveConfInit = () => resolve(undefined)
        }),
    )

    mountUi()
    await flushPromises()

    expect(initJobList).not.toHaveBeenCalled()

    formData.useCache.value = true
    resolveConfInit?.()
    await flushPromises()

    expect(initJobList).toHaveBeenCalledWith(
      expect.objectContaining({ useCache: expect.objectContaining({ value: true }) }),
    )
  })

  it('activates the delivery controller only after pager initialization completes', async () => {
    let resolveInitPager: (() => void) | undefined
    initPager.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          resolveInitPager = () => resolve(undefined)
        }),
    )

    const wrapper = mountUi()
    await flushPromises()

    expect(wrapper.get('[data-test="delivery-console"]').attributes('data-runtime-ready')).toBe(
      'false',
    )

    resolveInitPager?.()
    await flushPromises()

    expect(wrapper.get('[data-test="delivery-console"]').attributes('data-runtime-ready')).toBe(
      'true',
    )
  })

  it('does not activate the delivery controller when the job cache fails to initialize', async () => {
    initJobList.mockRejectedValueOnce(new Error('job cache unavailable'))

    const wrapper = mountUi()
    await flushPromises()

    expect(initPager).not.toHaveBeenCalled()
    expect(wrapper.get('[data-test="delivery-console"]').attributes('data-runtime-ready')).toBe(
      'false',
    )
    expect(loggerError).toHaveBeenCalledWith('初始化职位列表失败：[Error] job cache unavailable')
    expect(messageError).toHaveBeenCalledWith('岗位列表初始化失败，请刷新后重试')
  })

  it('preserves the existing user, configuration, job-cache, and pager initialization order', async () => {
    mountUi()
    await flushPromises()

    expect(initUser).toHaveBeenCalledWith({ pollIntervalMs: 200, timeoutMs: 2_000 })
    expect(confInit).toHaveBeenCalledOnce()
    expect(initJobList).toHaveBeenCalledOnce()
    expect(initPager).toHaveBeenCalledOnce()
    expect(initUser.mock.invocationCallOrder[0]).toBeLessThan(confInit.mock.invocationCallOrder[0])
    expect(confInit.mock.invocationCallOrder[0]).toBeLessThan(
      initJobList.mock.invocationCallOrder[0],
    )
    expect(initJobList.mock.invocationCallOrder[0]).toBeLessThan(
      initPager.mock.invocationCallOrder[0],
    )
  })
})
