import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

enableAutoUnmount(afterEach)

const {
  applyPersonalDefaultConfig,
  captureCurrentPageToDeliveryPool,
  createDeliveryTask,
  getDeliveryLimit,
  getDeliveryLimitSource,
  getDeliverySourceTargetPercent,
  getDeliveryLimitSuccess,
  hasDailyDeliveryRemaining,
  initJobList,
  loggerWarn,
  logData,
  setDeliveryPoolCaptureEnabled,
  setDeliveryLimitSourceOverride,
  sourceLists,
  statistics,
} = vi.hoisted(() => ({
  applyPersonalDefaultConfig: vi.fn(),
  captureCurrentPageToDeliveryPool: vi.fn(() => 0),
  createDeliveryTask: vi.fn(() => null),
  getDeliveryLimit: vi.fn(() => 10),
  getDeliveryLimitSource: vi.fn(() => 'search'),
  getDeliverySourceTargetPercent: vi.fn(() => 50),
  getDeliveryLimitSuccess: vi.fn(() => 0),
  hasDailyDeliveryRemaining: vi.fn(() => true),
  initJobList: vi.fn(async () => undefined),
  loggerWarn: vi.fn(),
  logData: {
    value: [
      {
        title: '分组失败',
        state: 'warning' as const,
        state_name: '岗位名筛选',
        message: '岗位名称不符',
        createdAt: new Date(2026, 6, 9, 10).getTime(),
        data: {
          deliverySource: 'group' as const,
          deliveryStage: '投递失败' as const,
          listData: {
            encryptJobId: 'group-failed',
            jobName: '分组失败',
          },
        },
      },
      {
        title: '搜索失败',
        state: 'danger' as const,
        state_name: '投递出错',
        message: '投递接口异常',
        createdAt: new Date(2026, 6, 9, 11).getTime(),
        data: {
          deliverySource: 'search' as const,
          deliveryStage: '投递失败' as const,
          retryable: true,
          listData: {
            encryptJobId: 'search-failed',
            jobName: '搜索失败',
          },
        },
      },
    ],
  },
  setDeliveryPoolCaptureEnabled: vi.fn(),
  setDeliveryLimitSourceOverride: vi.fn(),
  sourceLists: {
    group: [
      { encryptJobId: 'group-1', jobName: '分组岗位 1', status: { status: 'wait' } },
      { encryptJobId: 'group-2', jobName: '分组岗位 2', status: { status: 'wait' } },
    ],
    search: [
      { encryptJobId: 'search-1', jobName: '搜索岗位 1', status: { status: 'wait' } },
      { encryptJobId: 'search-2', jobName: '搜索岗位 2', status: { status: 'wait' } },
      { encryptJobId: 'search-3', jobName: '搜索岗位 3', status: { status: 'wait' } },
    ],
  },
  statistics: {
    todayData: {
      date: '2026-07-09',
      success: 34,
      total: 50,
      groupSuccess: 4,
      searchSuccess: 30,
      company: 0,
      jobTitle: 1,
      jobContent: 0,
      aiFiltering: 0,
      hrPosition: 0,
      salaryRange: 0,
      companySizeRange: 0,
      jobAddress: 0,
      amap: 0,
      repeat: 0,
      activityFilter: 0,
      goldHunterFilter: 0,
    },
    updateStatistics: vi.fn(async () => undefined),
    flush: vi.fn(async () => undefined),
  },
}))

vi.mock('@/stores/conf', () => ({
  useConf: () => ({
    hasPersonalConfig: true,
    personalSearchUrl: '',
    applyPersonalDefaultConfig,
    formData: {
      aiFiltering: { enable: true, score: 60 },
      aiGreeting: { enable: true },
      friendStatus: { value: true },
      sameCompanyFilter: { value: true },
      sameHrFilter: { value: true },
      deliveryLimit: { search: 150, group: 60 },
      delay: {
        deliveryInterval: 30,
        deliveryIntervalMax: 60,
        batchSize: 30,
        batchRestMinutes: 10,
      },
    },
  }),
}))

vi.mock('@/composables/useCommon', () => ({
  useCommon: () => ({
    deliverLock: false,
    deliverStop: false,
  }),
}))

vi.mock('@/composables/useStatistics', () => ({
  useStatistics: () => statistics,
}))

vi.mock('@/stores/jobs', () => ({
  jobList: {
    _list: ref([]),
    captureCurrentPageToDeliveryPool,
    flushSourcePools: vi.fn(async () => undefined),
    initJobList,
    listBySource: vi.fn((source: 'group' | 'search') => sourceLists[source]),
    setDeliveryPoolCaptureEnabled,
  },
}))

vi.mock('@/stores/log', () => ({
  useLog: () => ({
    data: logData,
    flush: vi.fn(async () => undefined),
  }),
}))

vi.mock('@/utils', () => ({
  delay: vi.fn(async () => undefined),
  getCurDay: (date = new Date()) => {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  },
}))

vi.mock('@/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    warn: loggerWarn,
  },
}))

vi.mock('../hooks/useDeliver', () => ({
  useDeliver: () => ({
    currentData: { jobName: 'AI 产品经理' },
    resetBatchPace: vi.fn(),
    jobListHandle: vi.fn(async () => 'done'),
  }),
}))

vi.mock('../hooks/usePager', () => ({
  usePager: () => ({
    next: vi.fn(() => false),
    page: ref({ page: 1 }),
  }),
}))

vi.mock('../utils/deliveryLimit', () => ({
  DAILY_DELIVERY_LIMIT: 100,
  getDeliveryLimit,
  getDeliveryLimitSource,
  getDeliverySourceTargetPercent,
  getDeliveryLimitSuccess,
  hasDailyDeliveryRemaining,
  inferDeliveryLimitSource: vi.fn(() => 'search'),
  setDeliveryLimitSourceOverride,
}))

vi.mock('../utils/deliveryTask', () => ({
  clearDeliveryTask: vi.fn(),
  createDeliveryTask,
  getCurrentTaskStep: vi.fn(() => null),
  getDefaultGroupUrl: vi.fn(() => ''),
  markCurrentStepDone: vi.fn(),
  readDeliveryTask: vi.fn(() => null),
  rotateToNextTaskStep: vi.fn(() => null),
  saveDeliveryTask: vi.fn(),
}))

vi.mock('@/ui/instrument', () => ({
  AgentButton: {
    name: 'AgentButton',
    emits: ['click'],
    template: '<button @click="$emit(\'click\')"><slot /></button>',
  },
  AgentButtonGroup: {
    name: 'AgentButtonGroup',
    template: '<div><slot /></div>',
  },
  AgentMessage: {
    info: vi.fn(),
  },
  AgentProgress: {
    name: 'AgentProgress',
    template: '<div />',
  },
  AgentTag: {
    name: 'AgentTag',
    template: '<span><slot /></span>',
  },
}))

import OperationPanel from './OperationPanel.vue'

const operationPanelRuntimeStyleId = 'agent-delivery-operation-panel-runtime-style'

describe('operation panel', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 9, 12))
    document.getElementById(operationPanelRuntimeStyleId)?.remove()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('injects runtime layout styles so dashboard does not depend only on cached content css', () => {
    mount(OperationPanel)

    const style = document.getElementById(operationPanelRuntimeStyleId)

    expect(style).not.toBeNull()
    expect(style!.textContent).toContain('.operation-panel__summary')
    expect(style!.textContent).toContain('.operation-panel__source-table')
    expect(style!.textContent).toContain('.operation-panel__source-name')
    expect(style!.textContent).not.toContain('.operation-panel__source-chart')
    expect(style!.textContent).toContain('.operation-panel__instrument-head')
    expect(style!.textContent).toContain('.operation-panel__sequence-step')
    expect(style!.textContent).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))')
  })

  it('keeps personal config entry inside runtime settings only', () => {
    const wrapper = mount(OperationPanel)
    const actionText = wrapper.find('.operation-panel__hero-actions').text()

    expect(actionText).toContain('运行配置')
    expect(actionText).not.toContain('应用个人配置')
    expect(wrapper.find('.operation-panel__toolbar').exists()).toBe(false)
  })

  it('offers a single run switch instead of a disabled start beside a stop', () => {
    const wrapper = mount(OperationPanel)
    const buttonTexts = wrapper.findAll('button').map((button) => button.text())

    expect(buttonTexts).toContain('开始投递')
    expect(buttonTexts).not.toContain('停止')
  })

  it('renders a lightweight delivery dashboard instead of large configuration cards', () => {
    const wrapper = mount(OperationPanel)
    const text = wrapper.text()

    expect(wrapper.find('.operation-panel__hero-copy h3').text()).toBe('AI 产品经理投递')
    expect(wrapper.find('.operation-panel__instrument-head').exists()).toBe(true)
    expect(wrapper.find('.operation-panel__ruler').attributes('aria-valuenow')).toBe('34')
    expect(wrapper.findAll('.operation-panel__sequence-step')).toHaveLength(5)
    expect(text).not.toContain('批量投递')
    expect(text).toContain('TODAY / DELIVERED')
    expect(text).toContain('034 / 100')
    expect(text).toContain('投递成功率')
    expect(text).toContain('68%')
    expect(text).toContain('求职期望 2 · 搜索 3')
    expect(text).toContain('来源效率')
    expect(wrapper.find('.operation-panel__source-table').exists()).toBe(true)
    expect(wrapper.find('.operation-panel__source-chart').exists()).toBe(false)
    expect(wrapper.find('.operation-panel__source-result-bar').exists()).toBe(false)
    expect(text).toContain('来源')
    expect(text).toContain('获取')
    expect(text).toContain('处理')
    expect(text).toContain('成功')
    expect(text).toContain('过滤')
    expect(text).toContain('异常')
    expect(text).toContain('成功率')
    expect(text).not.toContain('成功/失败')
    expect(text).not.toContain('过滤/异常')
    // 来源只有两个大类：求职期望和搜索。原来叫「求职期望投递池」「搜索投递池」——
    // 「投递池」是实现细节，用户在这张表上看的是哪个来源投得好，不是岗位存在哪个池子里。
    expect(text).toContain('求职期望')
    expect(text).toContain('搜索')
    expect(text).not.toContain('投递池已就绪 · 求职期望投递池')
    expect(text).not.toContain('搜索投递池')
    const groupSourceRow = wrapper
      .findAll('.operation-panel__source-table-row')
      .find((row) => row.text().includes('求职期望'))
    expect(groupSourceRow?.find('strong').exists()).toBe(false)
    expect(groupSourceRow?.find('.operation-panel__source-name').exists()).toBe(true)
    // 来源表恒定按投递记录统计；这个 fixture 里求职期望只有一条已过滤记录，
    // 成功数不再从统计计数器借。
    expect(groupSourceRow?.findAll('span').map((cell) => cell.text())).toEqual([
      '2',
      '1',
      '0',
      '1',
      '0',
      '0%',
    ])
    expect(text).toContain('失败归因')
    expect(text).toContain('岗位方向不符')
    expect(text).toContain('接口/风控')
    expect(text).toContain('运行参数')
    expect(text).toContain('求职期望 50% / 搜索 50%')
  })

  it('shows unassigned source records separately from search source metrics', () => {
    const previousLogs = logData.value
    logData.value = [
      ...previousLogs,
      {
        title: '历史失败',
        state: 'danger' as const,
        state_name: '投递出错',
        message: '旧日志没有来源字段',
        createdAt: new Date(2026, 6, 9, 12).getTime(),
        data: {
          deliveryStage: '投递失败' as const,
          listData: {
            encryptJobId: 'unknown-failed',
            jobName: '历史失败',
          },
        },
      } as any,
    ]

    try {
      const wrapper = mount(OperationPanel)
      const text = wrapper.text()
      const unknownSourceRow = wrapper
        .findAll('.operation-panel__source-table-row')
        .find((row) => row.text().includes('未归因来源'))

      expect(text).toContain('未归因来源')
      expect(text).not.toContain('目标 0% / 实际 12.5%')
      expect(unknownSourceRow?.findAll('span').map((cell) => cell.text())).toEqual([
        '未归因来源',
        '0',
        '1',
        '0',
        '0',
        '1',
        '0%',
      ])
    } finally {
      logData.value = previousLogs
    }
  })

  it('refreshes the reactive local day on focus, visibility, and the interval', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 9, 23, 59))
    const previousLogs = logData.value
    logData.value = [
      {
        title: '昨天过滤',
        state: 'warning' as const,
        state_name: '岗位名筛选',
        message: '岗位名称不符',
        createdAt: new Date(2026, 6, 9, 12).getTime(),
        data: {
          deliverySource: 'group' as const,
          deliveryStage: '投递失败' as const,
          listData: { encryptJobId: 'yesterday', jobName: '昨天过滤' },
        },
      } as any,
      {
        title: '今天失败',
        state: 'danger' as const,
        state_name: '投递出错',
        message: '投递接口异常',
        createdAt: new Date(2026, 6, 10, 0, 1).getTime(),
        data: {
          deliverySource: 'search' as const,
          deliveryStage: '投递失败' as const,
          listData: { encryptJobId: 'today', jobName: '今天失败' },
        },
      } as any,
    ]
    statistics.updateStatistics.mockClear()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })

    try {
      const wrapper = mount(OperationPanel)
      await flushPromises()
      expect(wrapper.find('.operation-panel__failure-list').text()).toContain('岗位方向不符')
      expect(statistics.updateStatistics).toHaveBeenCalledTimes(1)

      vi.setSystemTime(new Date(2026, 6, 10, 0, 1))
      window.dispatchEvent(new Event('focus'))
      await flushPromises()
      expect(statistics.updateStatistics).toHaveBeenCalledTimes(2)
      expect(wrapper.find('.operation-panel__failure-list').text()).toContain('接口/风控')
      expect(wrapper.find('.operation-panel__failure-list').text()).not.toContain('岗位方向不符')

      document.dispatchEvent(new Event('visibilitychange'))
      await flushPromises()
      expect(statistics.updateStatistics).toHaveBeenCalledTimes(3)

      await vi.advanceTimersByTimeAsync(60_000)
      await flushPromises()
      expect(statistics.updateStatistics).toHaveBeenCalledTimes(4)
    } finally {
      logData.value = previousLogs
      delete (document as any).visibilityState
    }
  })

  it('stops scheduled statistics refreshes when an extension update invalidates the page context', async () => {
    statistics.updateStatistics.mockClear()
    statistics.updateStatistics.mockRejectedValueOnce(new Error('Extension context invalidated.'))
    loggerWarn.mockClear()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })

    try {
      mount(OperationPanel)
      await flushPromises()
      expect(statistics.updateStatistics).toHaveBeenCalledTimes(1)
      expect(loggerWarn).not.toHaveBeenCalled()

      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(120_000)
      await flushPromises()

      expect(statistics.updateStatistics).toHaveBeenCalledTimes(1)
      expect(loggerWarn).not.toHaveBeenCalled()
    } finally {
      delete (document as any).visibilityState
    }
  })
})
