import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildDeliveryConfigSnapshot } from '@/delivery/configSnapshot'
import { defaultFormData } from '@/stores/conf/info'
import { getCurDay } from '@/utils'
import { ExtensionRuntimeHealthError } from '@/utils/extensionRuntimeHealth'
import { resetStorageQuotaNotice } from '@/utils/storageQuota'

enableAutoUnmount(afterEach)

const {
  storageGetMock,
  storageSetMock,
  storageUsageMock,
  clock,
  common,
  confPersist,
  deliveryPoolCaptureEnabled,
  dailyRemaining,
  durableTaskState,
  delayMock,
  deliverJobListHandle,
  getDeliveryLimit,
  getDeliverySourceTargetPercent,
  getDeliveryLimitSuccess,
  getRootVueMock,
  initJobList,
  initPager,
  jobSourcesConfig,
  availableJobExpectations,
  jobListRef,
  logInfo,
  autoMergeOnInit,
  pagerNext,
  pagerNextAttempt,
  pagerPage,
  pagerReady,
  pagerReload,
  jobListRevision,
  probeExtensionRuntimeHealth,
  resetBatchPace,
  routerPush,
  setDeliveryLimitSourceOverride,
  sourceOverride,
  sourceLists,
  sourceSuccesses,
  statistics,
  actualSource,
  visibleSource,
  getUserResumeData,
  setAvailableJobExpectations,
} = vi.hoisted(() => ({
  storageGetMock: vi.fn(async (_key: string, fallback: unknown) => fallback),
  storageSetMock: vi.fn(async () => true),
  storageUsageMock: vi.fn(async () => null as { bytesInUse: number; quotaBytes: number } | null),
  clock: {
    now: 1_000_000,
    pendingPageLoad: null as null | {
      availableAt: number
      firstJobId: string
      requiresRuntimeRefresh?: boolean
    },
  },
  common: {
    deliverLock: false,
    deliverStop: false,
  },
  confPersist: vi.fn(async () => true),
  delayMock: vi.fn(async (_seconds: number) => undefined),
  deliverJobListHandle: vi.fn(),
  getDeliveryLimit: vi.fn(),
  getDeliverySourceTargetPercent: vi.fn(() => 50),
  getDeliveryLimitSuccess: vi.fn(),
  getRootVueMock: vi.fn(),
  initJobList: vi.fn(),
  initPager: vi.fn(),
  jobSourcesConfig: {
    value: undefined as
      | undefined
      | {
          searchEnabled: boolean
          recommendEnabled: boolean
          enabledExpectIds: string[]
          expectationsInitialized: boolean
        },
  },
  availableJobExpectations: {
    value: [] as Array<{
      id: string
      index: number
      positionName: string
      locationName: string
      salaryDesc: string
    }>,
  },
  jobListRef: { value: [] as any[] },
  logInfo: vi.fn(),
  autoMergeOnInit: { value: false },
  deliveryPoolCaptureEnabled: { value: false },
  dailyRemaining: { value: true },
  durableTaskState: { value: null as any },
  pagerNext: vi.fn(),
  pagerNextAttempt: { value: 0 },
  pagerPage: {
    value: { page: 1, pageSize: 15 } as {
      page: number
      pageSize: number
      total?: number
    },
  },
  pagerReady: { value: true },
  pagerReload: vi.fn(),
  jobListRevision: { value: 0 },
  probeExtensionRuntimeHealth: vi.fn(),
  resetBatchPace: vi.fn(),
  routerPush: vi.fn(async (_route?: string) => undefined),
  setDeliveryLimitSourceOverride: vi.fn(),
  sourceOverride: { value: null as null | 'group' | 'search' },
  sourceLists: {
    group: [] as any[],
    search: [] as any[],
  },
  sourceSuccesses: { group: 0, search: 0 },
  actualSource: { value: 'group' as 'group' | 'search' },
  statistics: {
    todayData: {
      success: 0,
      total: 0,
      repeat: 0,
      activityFilter: 0,
    },
    updateStatistics: vi.fn(async () => undefined),
    flush: vi.fn(async () => undefined),
  },
  visibleSource: { value: 'group' as 'group' | 'search' },
  getUserResumeData: vi.fn(),
  setAvailableJobExpectations: vi.fn(),
}))

setAvailableJobExpectations.mockImplementation(
  (
    expectations: Array<{
      id: string
      index: number
      positionName: string
      locationName: string
      salaryDesc: string
    }>,
  ) => {
    availableJobExpectations.value = expectations.map((item) => ({ ...item }))
  },
)

function createDeferred<T = undefined>() {
  let resolve!: (value?: T) => void
  const promise = new Promise<T>((res) => {
    resolve = (value?: T) => res(value as T)
  })
  return { promise, resolve }
}

delayMock.mockImplementation(async (seconds: number) => {
  clock.now += seconds * 1000
  const pendingPageLoad = clock.pendingPageLoad
  if (
    pendingPageLoad != null &&
    !pendingPageLoad.requiresRuntimeRefresh &&
    clock.now >= pendingPageLoad.availableAt
  ) {
    jobListRef.value = [job(pendingPageLoad.firstJobId)]
    clock.pendingPageLoad = null
  }
})

initJobList.mockImplementation(async () => {
  const pendingPageLoad = clock.pendingPageLoad
  if (autoMergeOnInit.value && deliveryPoolCaptureEnabled.value) {
    const source = sourceOverride.value ?? visibleSource.value
    const next = new Map(sourceLists[source].map((item) => [item.encryptJobId, item]))
    for (const item of jobListRef.value) next.set(item.encryptJobId, item)
    sourceLists[source] = [...next.values()]
  }
  if (
    pendingPageLoad != null &&
    pendingPageLoad.requiresRuntimeRefresh &&
    clock.now >= pendingPageLoad.availableAt
  ) {
    jobListRef.value = [job(pendingPageLoad.firstJobId)]
    clock.pendingPageLoad = null
  }
})

initPager.mockResolvedValue(undefined)

function job(encryptJobId: string) {
  return {
    encryptJobId,
    status: {
      status: 'wait',
      msg: '',
      setStatus(status: string, msg = '') {
        this.status = status
        this.msg = msg
      },
    },
  }
}

function currentConfigSnapshot(checkpoint?: Record<string, any>) {
  const formData = structuredClone(defaultFormData)
  formData.aiFiltering = { ...formData.aiFiltering, enable: true, score: 60 }
  formData.aiGreeting = { ...formData.aiGreeting, enable: true }
  formData.deliveryLimit = {
    search: Math.max(0, Number(getDeliveryLimit(formData, 'search')) || 0),
    group: Math.max(0, Number(getDeliveryLimit(formData, 'group')) || 0),
  }
  const steps = Array.isArray(checkpoint?.steps) ? checkpoint.steps : []
  const hasSearchStep = steps.some((step: any) => step?.source === 'search')
  const hasGroupStep = steps.some((step: any) => step?.source === 'group')
  formData.searchConditions.directions = [
    ...new Set(
      steps
        .filter((step: any) => step?.source === 'search')
        .map((step: any) => String(step.searchDirection || 'AI').trim())
        .filter(Boolean),
    ),
  ]
  if (formData.searchConditions.directions.length === 0) {
    formData.searchConditions.directions = ['AI']
  }
  formData.jobSources = structuredClone(
    jobSourcesConfig.value ?? {
      searchEnabled: hasSearchStep,
      recommendEnabled: hasGroupStep || checkpoint == null,
      enabledExpectIds: [],
      expectationsInitialized: false,
    },
  )
  return buildDeliveryConfigSnapshot(formData, 1)
}

function registerDurableTask(checkpoint: Record<string, any>, overrides: Record<string, any> = {}) {
  durableTaskState.value = {
    schemaVersion: 1,
    accountUid: checkpoint.accountUid ?? 'account-a',
    runId: checkpoint.id,
    status: 'waiting-for-page',
    checkpoint: structuredClone(checkpoint),
    configSnapshot: currentConfigSnapshot(checkpoint),
    startedAt: checkpoint.startedAt ?? clock.now,
    updatedAt: clock.now,
    revision: 1,
    ...overrides,
  }
}

function registerStoredTask(overrides: Record<string, any> = {}) {
  const checkpoint = JSON.parse(
    window.sessionStorage.getItem('agent-delivery:combined-delivery-task') ?? 'null',
  )
  if (checkpoint == null) throw new Error('缺少页面任务夹具')
  registerDurableTask(checkpoint, overrides)
}

function markBatchProcessed(batchItems?: Array<{ item?: any }>) {
  if (Array.isArray(batchItems) && batchItems.length > 0) {
    for (const entry of batchItems) {
      if (entry?.item?.status != null) {
        entry.item.status.status = 'success'
        entry.item.status.msg = 'ok'
      }
    }
    return
  }
  for (const item of jobListRef.value) {
    if (item?.status != null) {
      item.status.status = 'success'
      item.status.msg = 'ok'
    }
  }
}

vi.mock('@/utils/actionGateStore', () => ({
  // 闸门是基础设施，业务单测不该去跑真实存储；它自己的行为由 actionGate/actionGateStore 的单测覆盖。
  acquireBossAction: vi.fn(async () => true),
  getCurrentPaceMultiplier: vi.fn(async () => 1),
  resetActionGate: vi.fn(async () => undefined),
}))

vi.mock('@/stores/conf', () => ({
  useConf: () => ({
    get availableJobExpectations() {
      return availableJobExpectations.value
    },
    confPersist,
    hasPersonalConfig: true,
    personalSearchUrl: 'https://www.zhipin.com/web/geek/job?query=AI',
    formData: {
      aiFiltering: { enable: true, score: 60 },
      aiGreeting: { enable: true },
      searchConditions: {
        directions: ['AI'],
        city: '',
        businessDistricts: [],
        salary: '',
        experience: [],
        degree: [],
        jobType: [],
      },
      friendStatus: { value: true },
      sameCompanyFilter: { value: true },
      sameHrFilter: { value: true },
      deliveryLimit: { search: 0, group: 10 },
      get jobSources() {
        return jobSourcesConfig.value
      },
      delay: {
        deliveryInterval: 30,
        deliveryIntervalMax: 60,
        batchSize: 30,
        batchRestMinutes: 10,
      },
    },
    setAvailableJobExpectations,
  }),
}))

vi.mock('@/stores/user', () => ({
  useUser: () => ({ getUserId: () => 'account-a', getUserResumeData }),
}))

// 真实的 useCommon 是 Pinia store，deliverLock / deliverStop 都是响应式的。
// 这里必须同样返回响应式代理：isDeliveryActive 写成
// `(deliverLock && !deliverStop) || hasDurableRunningTask`，第一项为真时会短路，
// 于是这个 computed 可能一个响应式依赖都收集不到。对着普通对象跑，它会被永久缓存成 true，
// 所有依赖运行状态的界面断言都会变成假通过。
vi.mock('@/composables/useCommon', async () => {
  const { reactive } = await import('vue')
  return { useCommon: () => reactive(common) }
})

vi.mock('@/composables/useVue', () => ({
  getRootVue: getRootVueMock,
}))

vi.mock('@/composables/useStatistics', () => ({
  useStatistics: () => statistics,
}))

vi.mock('@/message', () => ({
  counter: {
    deliveryWorkerIdentity: vi.fn(async (token: string) => `boss-tab-test:${token}`),
    configRuntime: vi.fn(async () => ({
      accountInitialized: true,
      enabledExpectations: [],
      formData: {},
      readiness: {
        configRevision: 1,
        modelReady: true,
        resumeReady: true,
        aiFilteringReady: true,
        aiGreetingReady: true,
      },
    })),
    deliveryTaskRead: vi.fn(async () => structuredClone(durableTaskState.value)),
    deliveryTaskStart: vi.fn(async (request: any) => {
      if (
        durableTaskState.value != null &&
        ['running', 'waiting-for-page'].includes(durableTaskState.value.status) &&
        durableTaskState.value.runId !== request.runId
      ) {
        return {
          accepted: false,
          task: structuredClone(durableTaskState.value),
          conflict: 'active-run',
        }
      }
      durableTaskState.value = {
        schemaVersion: 1,
        accountUid: request.uid,
        runId: request.runId,
        status: 'running',
        checkpoint: structuredClone(request.checkpoint),
        configSnapshot: structuredClone(request.configSnapshot),
        workerId: request.workerId,
        leaseExpiresAt: clock.now + 15_000,
        startedAt: request.checkpoint.startedAt,
        updatedAt: clock.now,
        lastWorkerAt: clock.now,
        revision: 1,
      }
      return { accepted: true, task: structuredClone(durableTaskState.value) }
    }),
    deliveryTaskResume: vi.fn(async (request: any) => {
      if (durableTaskState.value == null || durableTaskState.value.runId !== request.runId) {
        return { accepted: false, task: durableTaskState.value, conflict: 'task-missing' }
      }
      if (durableTaskState.value.status !== 'paused') {
        return {
          accepted: false,
          task: structuredClone(durableTaskState.value),
          conflict: 'worker-owned',
        }
      }
      durableTaskState.value = {
        ...durableTaskState.value,
        status: 'running',
        workerId: request.workerId,
        leaseExpiresAt: clock.now + 15_000,
        updatedAt: clock.now,
        revision: durableTaskState.value.revision + 1,
      }
      return { accepted: true, task: structuredClone(durableTaskState.value) }
    }),
    deliveryTaskClaim: vi.fn(async (request: any) => {
      if (durableTaskState.value == null || durableTaskState.value.runId !== request.runId) {
        return { accepted: false, task: durableTaskState.value, conflict: 'task-missing' }
      }
      // 与真实协调器一致：claim 只用于执行端续约，不得接管暂停中的任务。
      if (durableTaskState.value.status === 'paused') {
        return {
          accepted: false,
          task: structuredClone(durableTaskState.value),
          conflict: 'task-paused',
        }
      }
      durableTaskState.value = {
        ...durableTaskState.value,
        status: 'running',
        workerId: request.workerId,
        updatedAt: clock.now,
        revision: durableTaskState.value.revision + 1,
      }
      return { accepted: true, task: structuredClone(durableTaskState.value) }
    }),
    deliveryTaskCheckpoint: vi.fn(async (request: any) => {
      if (durableTaskState.value == null || durableTaskState.value.runId !== request.runId) {
        return { accepted: false, task: durableTaskState.value, conflict: 'task-missing' }
      }
      if (durableTaskState.value.status === 'paused') {
        return {
          accepted: false,
          task: structuredClone(durableTaskState.value),
          conflict: 'task-paused',
        }
      }
      durableTaskState.value = {
        ...durableTaskState.value,
        status: 'running',
        checkpoint: structuredClone(request.checkpoint),
        workerId: request.workerId,
        updatedAt: clock.now,
        revision: durableTaskState.value.revision + 1,
      }
      return { accepted: true, task: structuredClone(durableTaskState.value) }
    }),
    deliveryTaskPause: vi.fn(async (request: any) => {
      if (durableTaskState.value == null || durableTaskState.value.runId !== request.runId) {
        return { accepted: false, task: durableTaskState.value, conflict: 'task-missing' }
      }
      const {
        workerId: _workerId,
        leaseExpiresAt: _leaseExpiresAt,
        ...task
      } = durableTaskState.value
      durableTaskState.value = {
        ...task,
        status: 'paused',
        updatedAt: clock.now,
        revision: task.revision + 1,
      }
      return { accepted: true, task: structuredClone(durableTaskState.value) }
    }),
    deliveryTaskRelease: vi.fn(async (request: any) => {
      if (durableTaskState.value == null || durableTaskState.value.runId !== request.runId) {
        return { accepted: false, task: durableTaskState.value, conflict: 'task-missing' }
      }
      // 与真实协调器一致：暂停中的任务不接受执行端写入，否则收尾时的 release
      // 会把状态改成 waiting-for-page，等于自动取消暂停。
      if (durableTaskState.value.status === 'paused') {
        return {
          accepted: false,
          task: structuredClone(durableTaskState.value),
          conflict: 'task-paused',
        }
      }
      const {
        workerId: _workerId,
        leaseExpiresAt: _leaseExpiresAt,
        ...task
      } = durableTaskState.value
      durableTaskState.value = {
        ...task,
        status: 'waiting-for-page',
        updatedAt: clock.now,
        revision: task.revision + 1,
      }
      return { accepted: true, task: structuredClone(durableTaskState.value) }
    }),
    deliveryTaskTerminate: vi.fn(async (request: any) => {
      if (durableTaskState.value == null || durableTaskState.value.runId !== request.runId) {
        return { accepted: false, task: durableTaskState.value, conflict: 'task-missing' }
      }
      const status =
        request.reason === 'manual-stop'
          ? 'stopped'
          : request.reason === 'daily-limit'
            ? 'completed'
            : 'failed'
      durableTaskState.value = {
        ...durableTaskState.value,
        status,
        terminalReason: request.reason,
        terminalMessage: request.message,
        updatedAt: clock.now,
        revision: durableTaskState.value.revision + 1,
      }
      return { accepted: true, task: structuredClone(durableTaskState.value) }
    }),
    storageGet: storageGetMock,
    storageSet: storageSetMock,
    storageUsage: storageUsageMock,
  },
  probeExtensionRuntimeHealth,
}))

vi.mock('@/stores/jobs', () => ({
  jobList: {
    _list: jobListRef,
    get listRevision() {
      return jobListRevision.value
    },
    captureCurrentPageToDeliveryPool: vi.fn(
      (
        source?: 'group' | 'search',
        groupTargetId?: string,
        searchDirection?: string,
        canDeliver?: (job: any) => boolean,
        _groupName?: string,
        pageNumber?: number,
      ) => {
        const targetSource = source ?? sourceOverride.value ?? visibleSource.value
        const next = new Map(sourceLists[targetSource].map((item) => [item.encryptJobId, item]))
        const before = next.size
        // 与真实实现一致：必然投不出去的岗位根本不进池，否则它们会把水位撑起来。
        const candidates = canDeliver ? jobListRef.value.filter(canDeliver) : jobListRef.value
        for (const item of candidates) {
          if (targetSource === 'group' && groupTargetId) {
            item.deliveryGroupTargetIds = Array.from(
              new Set([...(item.deliveryGroupTargetIds ?? []), groupTargetId]),
            )
          }
          item.deliveryCredentialOrigin = {
            source: targetSource,
            page: Math.max(1, Number(pageNumber) || 1),
            ...(targetSource === 'group' && groupTargetId ? { groupTargetId } : {}),
            ...(targetSource === 'search' && searchDirection
              ? { searchDirectionKey: searchDirection.replace(/\s+/g, '').toLocaleLowerCase() }
              : {}),
          }
          next.set(item.encryptJobId, item)
        }
        sourceLists[targetSource] = [...next.values()]
        return next.size - before
      },
    ),
    flushSourcePools: vi.fn(async () => undefined),
    initJobList,
    get: vi.fn((encryptJobId: string) =>
      [...sourceLists.group, ...sourceLists.search, ...jobListRef.value].find(
        (item) => item.encryptJobId === encryptJobId,
      ),
    ),
    listBySource: vi.fn((source: 'group' | 'search') => sourceLists[source]),
    setDeliveryPoolCaptureEnabled: vi.fn((enabled: boolean) => {
      deliveryPoolCaptureEnabled.value = enabled
    }),
  },
}))

vi.mock('@/stores/log', () => ({
  useLog: () => ({
    data: { value: [] },
    flush: vi.fn(async () => undefined),
    info: logInfo,
  }),
}))

vi.mock('@/utils', () => ({
  delay: delayMock,
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
    warn: vi.fn(),
  },
}))

vi.mock('../hooks/useDeliver', () => ({
  useDeliver: () => ({
    resetBatchPace,
    jobListHandle: deliverJobListHandle,
  }),
}))

vi.mock('../hooks/usePager', () => ({
  usePager: () => ({
    initPager,
    next: pagerNext,
    page: pagerPage,
    ready: pagerReady,
    reload: pagerReload,
  }),
}))

vi.mock('../utils/deliveryLimit', () => ({
  DAILY_DELIVERY_LIMIT: 100,
  getDeliveryLimit,
  getDeliverySourceTargetPercent,
  getDeliveryLimitSource: vi.fn(() => visibleSource.value),
  getDeliveryLimitSuccess,
  hasDailyDeliveryRemaining: vi.fn(() => dailyRemaining.value),
  inferDeliveryLimitSource: vi.fn(() => actualSource.value),
  setDeliveryLimitSourceOverride,
  setRiskAdjustedDailyLimit: vi.fn(),
  getEffectiveDailyDeliveryLimit: vi.fn(() => 100),
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
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
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

import { counter } from '@/message'
import { AgentMessage } from '@/ui/instrument'

import OperationPanel from './OperationPanel.vue'

describe('operation panel pagination delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    deliverJobListHandle.mockReset()
    getDeliveryLimit.mockReset()
    getDeliveryLimitSuccess.mockReset()
    getRootVueMock.mockReset()
    getRootVueMock.mockResolvedValue({ $router: { push: routerPush } })
    pagerNext.mockReset()
    pagerReload.mockReset()
    probeExtensionRuntimeHealth.mockReset()
    resetBatchPace.mockReset()
    routerPush.mockReset()
    setDeliveryLimitSourceOverride.mockReset()
    statistics.flush.mockReset()
    statistics.flush.mockResolvedValue(undefined)
    window.sessionStorage.clear()
    document.querySelectorAll('.c-expect-select').forEach((node) => node.remove())
    window.history.replaceState({}, '', '/web/geek/jobs')
    vi.spyOn(Date, 'now').mockImplementation(() => clock.now)

    clock.now = 1_000_000
    clock.pendingPageLoad = null
    common.deliverLock = false
    common.deliverStop = false
    durableTaskState.value = null
    dailyRemaining.value = true
    statistics.todayData.success = 0
    statistics.todayData.total = 0
    sourceSuccesses.group = 0
    sourceSuccesses.search = 0
    actualSource.value = 'group'
    visibleSource.value = 'group'
    pagerNextAttempt.value = 0
    jobListRevision.value = 0
    pagerPage.value = { page: 1, pageSize: 15 }
    routerPush.mockResolvedValue(undefined)
    autoMergeOnInit.value = true
    deliveryPoolCaptureEnabled.value = false
    sourceOverride.value = null
    jobSourcesConfig.value = undefined
    availableJobExpectations.value = []
    getUserResumeData.mockReset()
    setDeliveryLimitSourceOverride.mockImplementation((source) => {
      sourceOverride.value = source
    })
    sourceLists.group = []
    sourceLists.search = []
    jobListRef.value = [job('page-1-first')]

    getDeliveryLimit.mockImplementation((_, source) => (source === 'search' ? 0 : 10))
    getDeliveryLimitSuccess.mockImplementation((_, source) =>
      source === 'search' ? sourceSuccesses.search : sourceSuccesses.group,
    )
    deliverJobListHandle.mockImplementation(async (items?: Array<{ item?: any }>) => {
      markBatchProcessed(items)
      return 'completed'
    })
    probeExtensionRuntimeHealth.mockResolvedValue({
      mainVersion: '0.6.59',
      contentVersion: '0.6.59',
      backgroundVersion: '0.6.59',
      durationMs: 1,
    })
    pagerNext.mockImplementation(() => {
      pagerNextAttempt.value += 1
      if (pagerNextAttempt.value === 1) {
        jobListRef.value = [job('page-2-first')]
        return true
      }
      return false
    })
    pagerReload.mockImplementation(() => {
      jobListRevision.value += 1
    })
  })

  afterEach(async () => {
    for (let index = 0; index < 12; index++) {
      // A mounted resume can acquire the run lock after teardown begins.
      // Keep asserting stop until all queued resume continuations have observed it.
      common.deliverStop = true
      await flushPromises()
    }
    expect(common.deliverLock).toBe(false)
    clock.pendingPageLoad = null
    sourceLists.group = []
    sourceLists.search = []
    jobListRef.value = []
    document.querySelectorAll('.c-expect-select').forEach((node) => node.remove())
    window.sessionStorage.clear()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('fails fast before creating a task when the page bridge is stale', async () => {
    probeExtensionRuntimeHealth.mockRejectedValueOnce(
      new ExtensionRuntimeHealthError('CONTENT_SCRIPT_UNAVAILABLE'),
    )
    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')

    await startButton!.trigger('click')
    await flushPromises()

    expect(deliverJobListHandle).not.toHaveBeenCalled()
    expect(window.sessionStorage.getItem('agent-delivery:combined-delivery-task')).toBeNull()
    expect(logInfo).not.toHaveBeenCalledWith('投递批次', expect.stringContaining('创建投递任务'))
    expect(logInfo).toHaveBeenCalledWith(
      '投递批次',
      expect.stringContaining('投递运行时检查失败：执行端等待重连'),
    )
  })

  it('does not persist or register a task when its configuration snapshot cannot be built', async () => {
    const circularSources: any = {
      searchEnabled: false,
      recommendEnabled: true,
      enabledExpectIds: [],
      expectationsInitialized: true,
    }
    circularSources.invalidCycle = circularSources
    jobSourcesConfig.value = circularSources
    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')

    await startButton!.trigger('click')
    await flushPromises()

    expect(counter.deliveryTaskStart).not.toHaveBeenCalled()
    expect(window.sessionStorage.getItem('agent-delivery:combined-delivery-task')).toBeNull()
    expect(common.deliverLock).toBe(false)
    expect(logInfo).toHaveBeenCalledWith(
      '投递批次',
      expect.stringContaining('创建投递任务失败：运行配置读取失败'),
    )
    expect(AgentMessage.error).toHaveBeenCalledWith('投递配置读取失败，请重试')

    await startButton!.trigger('click')
    await flushPromises()

    expect(counter.deliveryTaskStart).not.toHaveBeenCalled()
    expect(AgentMessage.info).not.toHaveBeenCalledWith('当前已有投递任务在执行')
  })

  it('keeps the local checkpoint when background task registration is temporarily unavailable', async () => {
    vi.mocked(counter.deliveryTaskStart).mockRejectedValueOnce(
      new Error('background rpc temporarily unavailable'),
    )
    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')

    await startButton!.trigger('click')
    await vi.waitFor(() => expect(counter.deliveryTaskStart).toHaveBeenCalled())

    expect(window.sessionStorage.getItem('agent-delivery:combined-delivery-task')).not.toBeNull()
    expect(durableTaskState.value).toBeNull()
    expect(logInfo).toHaveBeenCalledWith(
      '投递批次',
      expect.stringContaining('后台连接暂时中断，保留本地检查点'),
    )
    expect(deliverJobListHandle).not.toHaveBeenCalled()
  })

  it('automatically registers and resumes the preserved local task after reconnecting', async () => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
    })
    vi.mocked(counter.deliveryTaskStart).mockRejectedValueOnce(
      new Error('background rpc temporarily unavailable'),
    )
    deliverJobListHandle.mockImplementationOnce(async (items) => {
      markBatchProcessed(items)
      common.deliverStop = true
      return 'stopped'
    })
    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')

    await startButton!.trigger('click')
    await vi.waitFor(() => expect(counter.deliveryTaskStart).toHaveBeenCalledTimes(1))
    await vi.waitFor(() =>
      expect(logInfo).toHaveBeenCalledWith(
        '投递批次',
        expect.stringContaining('后台连接暂时中断，保留本地检查点'),
      ),
    )

    await vi.advanceTimersByTimeAsync(5_000)
    await vi.waitFor(() => expect(counter.deliveryTaskStart).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(deliverJobListHandle).toHaveBeenCalled())

    expect(durableTaskState.value?.runId).toBeTruthy()
    expect(durableTaskState.value?.status).not.toBe('failed')
    expect(window.sessionStorage.getItem('agent-delivery:combined-delivery-task')).not.toBeNull()
    expect(wrapper.exists()).toBe(true)
  })

  it('keeps an existing task waiting when claiming the background lease throws', async () => {
    const checkpoint = {
      accountUid: 'account-a',
      id: 'claim-rpc-task',
      startedAt: clock.now - 60_000,
      currentIndex: 0,
      poolWarmup: { completed: true, attemptedStepIndexes: [], lowWaterArmed: true },
      steps: [
        {
          source: 'group',
          url: 'https://www.zhipin.com/web/geek/jobs',
          status: 'running',
          pagesDone: 0,
        },
      ],
    }
    window.sessionStorage.setItem(
      'agent-delivery:combined-delivery-task',
      JSON.stringify(checkpoint),
    )
    registerDurableTask(checkpoint)
    vi.mocked(counter.deliveryTaskClaim).mockRejectedValueOnce(new Error('claim rpc failed'))

    const wrapper = mount(OperationPanel)
    await vi.waitFor(() => expect(counter.deliveryTaskClaim).toHaveBeenCalled())

    expect(durableTaskState.value?.status).not.toBe('failed')
    expect(window.sessionStorage.getItem('agent-delivery:combined-delivery-task')).not.toBeNull()
    expect(logInfo).toHaveBeenCalledWith(
      '投递批次',
      expect.stringContaining('投递任务等待：后台连接暂时中断'),
    )
    expect(counter.deliveryTaskTerminate).not.toHaveBeenCalled()
    expect(deliverJobListHandle).not.toHaveBeenCalled()
    const buttonTexts = wrapper.findAll('button').map((button) => button.text())
    expect(buttonTexts).toContain('等待中')
    expect(buttonTexts).not.toContain('开始投递')
    expect(buttonTexts).not.toContain('暂停')
    expect(wrapper.find('.operation-panel__run-state').text()).toContain('等待中')
    expect(wrapper.exists()).toBe(true)
  })

  it('continues delivering the loaded next page even when page metadata stays stale', async () => {
    deliverJobListHandle.mockImplementationOnce(async (items) => {
      markBatchProcessed(items)
      common.deliverStop = true
      return 'stopped'
    })
    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')

    expect(startButton).toBeDefined()
    await startButton!.trigger('click')
    await flushPromises()
    await flushPromises()

    expect(deliverJobListHandle).toHaveBeenCalled()
    expect(logInfo).toHaveBeenCalledWith(
      '投递批次',
      expect.stringContaining('投递池 FIFO 批次启动'),
    )
    const savedTask = JSON.parse(
      window.sessionStorage.getItem('agent-delivery:combined-delivery-task') ?? 'null',
    )
    expect(savedTask?.steps[0]?.pagesDone).toBe(2)
  })

  it('keeps waiting when the next page finishes loading after the old short timeout', async () => {
    deliverJobListHandle.mockImplementationOnce(async (items) => {
      markBatchProcessed(items)
      common.deliverStop = true
      return 'stopped'
    })
    pagerNext.mockImplementation(() => {
      pagerNextAttempt.value += 1
      if (pagerNextAttempt.value === 1) {
        clock.pendingPageLoad = {
          availableAt: clock.now + 20_000,
          firstJobId: 'page-2-first',
        }
        return true
      }
      return false
    })

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')

    expect(startButton).toBeDefined()
    await startButton!.trigger('click')
    await flushPromises()
    await flushPromises()

    expect(deliverJobListHandle).toHaveBeenCalled()
    expect(logInfo).toHaveBeenCalledWith(
      '分页诊断',
      expect.stringContaining('等待混合投递池下一页加载'),
    )
    expect(logInfo).toHaveBeenCalledWith(
      '投递批次',
      expect.stringContaining('当前页面岗位已写入投递池'),
    )
  })

  it('refreshes BOSS runtime hooks when the next page remounts the job list component', async () => {
    deliverJobListHandle.mockImplementationOnce(async (items) => {
      markBatchProcessed(items)
      common.deliverStop = true
      return 'stopped'
    })
    pagerNext.mockImplementation(() => {
      pagerNextAttempt.value += 1
      if (pagerNextAttempt.value === 1) {
        clock.pendingPageLoad = {
          availableAt: clock.now + 5_000,
          firstJobId: 'page-2-first',
          requiresRuntimeRefresh: true,
        }
        return true
      }
      return false
    })

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')

    expect(startButton).toBeDefined()
    await startButton!.trigger('click')
    for (let i = 0; i < 8; i++) {
      await flushPromises()
    }

    expect(initJobList).toHaveBeenCalled()
    expect(initPager).toHaveBeenCalled()
    expect(deliverJobListHandle).toHaveBeenCalled()
    expect(logInfo).toHaveBeenCalledWith(
      '分页诊断',
      expect.stringContaining('刷新BOSS页面运行时绑定'),
    )
    expect(logInfo).toHaveBeenCalledWith(
      '分页诊断',
      expect.stringContaining('混合投递池下一页已进入投递池'),
    )
  })

  it('keeps the task waiting when the batch runtime probe detects a stale page bridge', async () => {
    probeExtensionRuntimeHealth
      .mockResolvedValueOnce({
        mainVersion: '0.6.59',
        contentVersion: '0.6.59',
        backgroundVersion: '0.6.59',
        durationMs: 1,
      })
      .mockRejectedValueOnce(new ExtensionRuntimeHealthError('CONTENT_SCRIPT_UNAVAILABLE'))
    pagerNext.mockReturnValue(false)

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')

    expect(startButton).toBeDefined()
    await startButton!.trigger('click')
    for (let i = 0; i < 8; i++) {
      await flushPromises()
    }

    expect(deliverJobListHandle).not.toHaveBeenCalled()
    expect(initJobList).not.toHaveBeenCalled()
    expect(logInfo).toHaveBeenCalledWith(
      '投递批次',
      expect.stringContaining('投递运行时检查失败：执行端等待重连'),
    )
    expect(logInfo).toHaveBeenCalledWith(
      '投递批次',
      expect.stringContaining('投递任务运行时通信异常：保留任务等待重连'),
    )
  })

  it('does not retry a batch when the legacy comctx heartbeat fails mid-job', async () => {
    deliverJobListHandle.mockRejectedValue(
      new Error('Provider unavailable: heartbeat check timeout 30000ms.'),
    )
    pagerNext.mockReturnValue(false)

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')

    expect(startButton).toBeDefined()
    await startButton!.trigger('click')
    for (let i = 0; i < 14; i++) {
      await flushPromises()
    }

    expect(deliverJobListHandle).toHaveBeenCalled()
    expect(initJobList).not.toHaveBeenCalled()
    expect(window.sessionStorage.getItem('agent-delivery:combined-delivery-task')).not.toBeNull()
    expect(durableTaskState.value).toMatchObject({ status: 'waiting-for-page' })
    expect(logInfo).toHaveBeenCalledWith(
      '投递批次',
      expect.stringContaining('投递任务运行时通信异常：保留任务等待重连'),
    )
    expect(logInfo).not.toHaveBeenCalledWith(
      '投递批次',
      expect.stringContaining('Provider心跳异常，准备重试'),
    )
  })

  it('serializes checkpoint heartbeats while a delivery batch is still running', async () => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
    })
    let releaseBatch!: (result: 'stopped') => void
    let releaseCheckpoint!: () => void
    let checkpointCalls = 0
    const checkpoint = vi.mocked(counter.deliveryTaskCheckpoint)
    checkpoint.mockImplementation(async (request: any) => {
      checkpointCalls += 1
      if (checkpointCalls === 3) {
        await new Promise<void>((resolve) => {
          releaseCheckpoint = resolve
        })
        throw new Error('Provider unavailable: heartbeat check timeout 5000ms.')
      }
      if (durableTaskState.value == null) {
        return { accepted: false, task: null, conflict: 'task-missing' } as any
      }
      durableTaskState.value = {
        ...durableTaskState.value,
        checkpoint: structuredClone(request.checkpoint),
        updatedAt: clock.now,
        revision: durableTaskState.value.revision + 1,
      }
      return { accepted: true, task: structuredClone(durableTaskState.value) }
    })
    sourceLists.group = Array.from({ length: 100 }, (_, index) =>
      job(`heartbeat-queue-${index + 1}`),
    )
    jobListRef.value = sourceLists.group.slice(0, 15)
    pagerNext.mockReturnValue(false)
    deliverJobListHandle.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseBatch = resolve
        }),
    )

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')
    await startButton!.trigger('click')
    for (let index = 0; index < 8; index++) await flushPromises()
    expect(deliverJobListHandle).toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(6_000)
    await flushPromises()
    expect(checkpoint).toHaveBeenCalledTimes(3)
    expect(common.deliverStop).toBe(false)

    releaseCheckpoint()
    await flushPromises()
    await vi.advanceTimersByTimeAsync(2_000)
    await flushPromises()
    expect(checkpoint.mock.calls.length).toBeGreaterThanOrEqual(4)
    expect(common.deliverStop).toBe(false)
    expect(logInfo).toHaveBeenCalledWith(
      '投递批次',
      expect.stringContaining('投递任务检查点暂时不可用，将继续重试'),
    )
    expect(logInfo).toHaveBeenCalledWith(
      '投递批次',
      expect.stringContaining('投递任务检查点连接已恢复'),
    )

    common.deliverStop = true
    releaseBatch('stopped')
    await flushPromises()
    wrapper.unmount()
    vi.useRealTimers()
  })

  it('logs before waiting for the next page turn so long page gaps are visible', async () => {
    delayMock.mockImplementationOnce(async (seconds: number) => {
      clock.now += seconds * 1000
      common.deliverStop = true
    })
    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')

    expect(startButton).toBeDefined()
    await startButton!.trigger('click')
    await flushPromises()

    const waitLogIndex = logInfo.mock.calls.findIndex(
      ([stage, message]) =>
        stage === '分页诊断' && String(message).includes('混合投递池准备抓取下一页'),
    )
    // 翻页间隔是重尾分布抽出来的，不再是精确的 60 秒——固定周期本身就是机器特征。
    // 所以不写死秒数，改成「日志里报的等待值必须就是真正等的那个值」：
    // 报一个数、等另一个数，比等多久更值得拦。分布的形状由 humanPace 的单测覆盖。
    const loggedWaitSeconds = Number(
      String(logInfo.mock.calls[waitLogIndex]?.[1] ?? '').match(/"waitSeconds":(\d+)/)?.[1],
    )
    expect(loggedWaitSeconds).toBeGreaterThan(0)
    const nextDelayIndex = delayMock.mock.calls.findIndex(
      ([seconds]) => Math.abs(Number(seconds) - loggedWaitSeconds) <= 1,
    )

    expect(waitLogIndex).toBeGreaterThanOrEqual(0)
    expect(nextDelayIndex).toBeGreaterThanOrEqual(0)
    expect(logInfo.mock.invocationCallOrder[waitLogIndex]).toBeLessThan(
      delayMock.mock.invocationCallOrder[nextDelayIndex],
    )
  })

  it('does not turn the page when stop is requested during the long page wait', async () => {
    delayMock.mockImplementationOnce(async (seconds: number) => {
      clock.now += seconds * 1000
      common.deliverStop = true
    })

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')

    await startButton!.trigger('click')
    for (let i = 0; i < 6; i++) await flushPromises()

    expect(pagerNext).not.toHaveBeenCalled()
  })

  it('does not prefetch the next page when stop is requested during the pool wait', async () => {
    actualSource.value = 'group'
    visibleSource.value = 'group'
    getDeliveryLimit.mockImplementation((_, source) => (source === 'search' ? 60 : 40))
    sourceLists.group = Array.from({ length: 5 }, (_, index) => job(`group-seed-${index + 1}`))
    sourceLists.search = []
    const wait = createDeferred()
    delayMock.mockImplementationOnce(() => wait.promise)

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')
    await startButton!.trigger('click')
    await vi.waitFor(() => expect(delayMock).toHaveBeenCalled())

    common.deliverStop = true
    window.sessionStorage.clear()
    wait.resolve()
    for (let i = 0; i < 6; i++) await flushPromises()

    expect(pagerNext).not.toHaveBeenCalled()
    expect(window.sessionStorage.getItem('agent-delivery:combined-delivery-task')).toBeNull()
  })

  it('does not auto resume a local task missing background authority', async () => {
    actualSource.value = 'group'
    visibleSource.value = 'group'
    getDeliveryLimit.mockImplementation((_, source) => (source === 'group' ? 10 : 0))
    window.history.replaceState({}, '', '/web/geek/jobs?salary=406')
    window.sessionStorage.setItem(
      'agent-delivery:combined-delivery-task',
      JSON.stringify({
        accountUid: 'account-a',
        id: 'stale-group-task',
        startedAt: Date.now() - 60_000,
        currentIndex: 0,
        steps: [
          {
            source: 'group',
            url: 'https://www.zhipin.com/web/geek/jobs?salary=406',
            status: 'running',
            pagesDone: 0,
          },
        ],
      }),
    )
    mount(OperationPanel)
    await flushPromises()
    await flushPromises()

    expect(deliverJobListHandle).not.toHaveBeenCalled()
    expect(routerPush).not.toHaveBeenCalled()
    expect(window.sessionStorage.getItem('agent-delivery:combined-delivery-task')).toBeNull()
  })

  it('keeps every fetched job in the unified pool until the normal delivery filters run', async () => {
    // 来源只负责取岗和记录归属；同公司、已沟通等业务过滤在岗位处理阶段执行。
    actualSource.value = 'group'
    visibleSource.value = 'group'
    getDeliveryLimit.mockImplementation((_, source) => (source === 'group' ? 10 : 0))
    storageGetMock.mockImplementation(async (key: string, fallback: unknown) =>
      key === 'local:sameCompany' ? { 'account-a': ['brand-contacted'] } : fallback,
    )
    sourceLists.group = []
    jobListRef.value = [
      { ...job('fresh-1'), encryptBrandId: 'brand-new' },
      { ...job('dupe-1'), encryptBrandId: 'brand-contacted' },
      { ...job('dupe-2'), encryptBrandId: 'brand-contacted' },
    ]

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')
    await startButton!.trigger('click')
    for (let i = 0; i < 10; i++) await flushPromises()

    // 入池不能提前消耗岗位：即使是已沟通过的公司，也要保留在统一 FIFO 队列中，
    // 由正常岗位处理流程记录过滤结果。
    const pooled = sourceLists.group.map((item) => item.encryptJobId)
    expect(pooled).toContain('dupe-1')
    expect(pooled).toContain('dupe-2')
    expect(pooled).toContain('fresh-1')
    expect(pooled.length).toBeGreaterThanOrEqual(3)
  })

  it('does not impose a company quota while acquiring the unified pool', async () => {
    // 同一家公司多个 JD 仍是岗位数据，必须先进入 FIFO；公司去重只影响后续处理结论。
    actualSource.value = 'group'
    visibleSource.value = 'group'
    getDeliveryLimit.mockImplementation((_, source) => (source === 'group' ? 30 : 0))
    sourceLists.group = []
    jobListRef.value = Array.from({ length: 20 }, (_, index) => ({
      ...job(`flood-${index + 1}`),
      encryptBrandId: 'brand-flood',
    }))

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')
    await startButton!.trigger('click')
    for (let i = 0; i < 10; i++) await flushPromises()

    const fromFlood = sourceLists.group.filter((item) => item.encryptBrandId === 'brand-flood')
    expect(fromFlood).toHaveLength(20)
  })

  it('does not preemptively rewrite FIFO siblings before normal job processing', async () => {
    // 入池只建立 FIFO 顺序。即使同公司岗位已经在池中，也必须等它们各自进入正常处理流程，
    // 由该流程记录过滤或成功，不能由补池扫描直接改状态。
    actualSource.value = 'group'
    visibleSource.value = 'group'
    getDeliveryLimit.mockImplementation((_, source) => (source === 'group' ? 10 : 0))
    // 第一次读到的是空集合（还没投过），之后读到的是「这家公司已经投过了」——
    // 模拟运行途中投出去一个的效果。
    let sameCompanyReads = 0
    storageGetMock.mockImplementation(async (key: string, fallback: unknown) => {
      if (key !== 'local:sameCompany') return fallback
      sameCompanyReads++
      return sameCompanyReads > 1 ? { 'account-a': ['brand-x'] } : {}
    })
    // 同伴排在后面，第一批投的是别家公司；等第二批开始时 brand-x 已经投过了。
    sourceLists.group = [
      ...Array.from({ length: 20 }, (_, index) => ({
        ...job(`other-${index + 1}`),
        encryptBrandId: `brand-other-${index + 1}`,
      })),
      { ...job('sibling-1'), encryptBrandId: 'brand-x' },
      { ...job('sibling-2'), encryptBrandId: 'brand-x' },
    ]
    jobListRef.value = []
    deliverJobListHandle.mockImplementationOnce(async () => {
      common.deliverStop = true
      return 'stopped'
    })

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')
    await startButton!.trigger('click')
    for (let i = 0; i < 10; i++) await flushPromises()

    const siblings = sourceLists.group.filter((item) => item.encryptBrandId === 'brand-x')
    expect(siblings).not.toHaveLength(0)
    for (const sibling of siblings) {
      expect(sibling.status.status).not.toBe('filtered')
    }
  })

  it('cools down instead of retrying when BOSS says the pace is too fast', async () => {
    // 被限流之后 30 秒接着投，等于拿后面的岗位去验证同一个判定。冷却要长到足以
    // 让节奏曲线重置，回来时不是接着那段已经被盯上的连续行为往下跑。
    actualSource.value = 'group'
    visibleSource.value = 'group'
    getDeliveryLimit.mockImplementation((_, source) => (source === 'group' ? 10 : 0))
    sourceLists.group = Array.from({ length: 20 }, (_, index) => job(`rl-${index + 1}`))
    deliverJobListHandle.mockImplementation(async () => {
      common.deliverStop = true
      return 'rateLimited'
    })

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')
    await startButton!.trigger('click')
    for (let i = 0; i < 10; i++) await flushPromises()

    // 检查点保住，任务进入可自动接管的等待态；paused 只用于必须由用户点击继续的暂停。
    expect(durableTaskState.value?.status).toBe('waiting-for-page')
    expect(durableTaskState.value?.checkpoint?.retryAt).toBeGreaterThan(clock.now)
    const stored = (storageSetMock.mock.calls as unknown as [string, unknown][]).find(
      ([key]) => key === 'local:risk-backoff',
    )
    expect(stored?.[1]).toMatchObject({ 'account-a': expect.objectContaining({ hits: 1 }) })
  })

  it('pauses independently on a BOSS security-check page and keeps the checkpoint', async () => {
    actualSource.value = 'group'
    visibleSource.value = 'group'
    window.history.replaceState({}, '', '/web/geek/jobs?_security_check=1')
    getDeliveryLimit.mockImplementation((_, source) => (source === 'group' ? 10 : 0))
    sourceLists.group = Array.from({ length: 20 }, (_, index) => job(`security-${index + 1}`))
    jobListRef.value = sourceLists.group.slice(0, 15)

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')
    await startButton!.trigger('click')
    await vi.waitFor(() => expect(durableTaskState.value?.status).toBe('paused'))

    expect(deliverJobListHandle).not.toHaveBeenCalled()
    expect(durableTaskState.value?.checkpoint).toBeTruthy()
    expect(storageSetMock).not.toHaveBeenCalledWith('local:risk-backoff', expect.anything())
  })

  it('keeps the run resumable after a third explicit platform rate limit', async () => {
    actualSource.value = 'group'
    visibleSource.value = 'group'
    getDeliveryLimit.mockImplementation((_, source) => (source === 'group' ? 10 : 0))
    sourceLists.group = Array.from({ length: 20 }, (_, index) => job(`rl-again-${index + 1}`))
    storageGetMock.mockImplementation(async (key: string, fallback: unknown) =>
      key === 'local:risk-backoff'
        ? { 'account-a': { date: getCurDay(), hits: 2, lastHitAt: Date.now() } }
        : fallback,
    )
    deliverJobListHandle.mockImplementation(async () => {
      common.deliverStop = true
      return 'rateLimited'
    })

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')
    await startButton!.trigger('click')
    for (let i = 0; i < 10; i++) await flushPromises()

    expect(durableTaskState.value?.status).toBe('waiting-for-page')
    expect(durableTaskState.value?.checkpoint?.retryAt).toBeGreaterThan(clock.now)
    const stored = (storageSetMock.mock.calls as unknown as [string, unknown][]).find(
      ([key]) => key === 'local:risk-backoff',
    )
    expect(stored?.[1]).toMatchObject({ 'account-a': expect.objectContaining({ hits: 3 }) })
    expect(logInfo).not.toHaveBeenCalledWith(
      '投递批次',
      expect.stringContaining('"exitReason":"risk-control"'),
    )
  })

  it('pauses a resumed run when the AI is unavailable', async () => {
    // 恢复批次是第三个出口。真实漏掉的就是它：另外两个改了、它没改，
    // 运行从这里走掉，任务被释放成 waiting-for-page，检查点没保住。
    actualSource.value = 'group'
    visibleSource.value = 'group'
    getDeliveryLimit.mockImplementation((_, source) => (source === 'group' ? 10 : 0))
    sourceLists.group = Array.from({ length: 20 }, (_, index) => job(`ai-down-${index + 1}`))
    // 真实的 useDeliver 在返回 aiUnavailable 之前会置起 deliverStop，mock 要跟上，
    // 否则少了这个信号，缺陷会表现成空转崩溃而不是一个清楚的断言失败。
    deliverJobListHandle.mockImplementation(async () => {
      common.deliverStop = true
      return 'aiUnavailable'
    })
    window.sessionStorage.setItem(
      'agent-delivery:combined-delivery-task',
      JSON.stringify({
        accountUid: 'account-a',
        id: 'ai-down-task',
        startedAt: Date.now() - 60_000,
        currentIndex: 0,
        runtimeHeartbeat: { at: Date.now() - 1_000, source: 'group' },
        // 关键：带一个未完成的批次，运行才会走「恢复批次」这条出口，
        // 而不是从投递池重新取一批。
        activeBatch: {
          id: 'ai-down-task:1',
          startedAt: Date.now() - 30_000,
          size: 2,
          items: [
            { source: 'group', encryptJobId: 'ai-down-1' },
            { source: 'group', encryptJobId: 'ai-down-2' },
          ],
        },
        steps: [
          {
            source: 'group',
            url: 'https://www.zhipin.com/web/geek/jobs',
            status: 'running',
            pagesDone: 0,
          },
        ],
      }),
    )
    durableTaskState.value = {
      schemaVersion: 2,
      accountUid: 'account-a',
      runId: 'ai-down-task',
      status: 'waiting-for-page',
      phase: 'waiting',
      checkpoint: JSON.parse(
        window.sessionStorage.getItem('agent-delivery:combined-delivery-task') ?? 'null',
      ),
      configSnapshot: currentConfigSnapshot(),
      startedAt: Date.now() - 60_000,
      updatedAt: clock.now,
      revision: 1,
    }

    mount(OperationPanel)
    await vi.waitFor(() => expect(deliverJobListHandle).toHaveBeenCalled())
    for (let i = 0; i < 10; i++) await flushPromises()

    await vi.waitFor(() => expect(durableTaskState.value).toMatchObject({ status: 'paused' }))
    expect(durableTaskState.value.checkpoint).toBeTruthy()
    expect(window.sessionStorage.getItem('agent-delivery:combined-delivery-task')).not.toBeNull()
  })

  it('refreshes the pool automatically after consecutive detail refusals', async () => {
    // 详情连续被拒不应把整轮任务直接标成 failed。恢复动作必须真实调用列表 reload，
    // 并保留原 FIFO 批次；这里第二次调用用 stopped 收束测试运行。
    actualSource.value = 'group'
    visibleSource.value = 'group'
    getDeliveryLimit.mockImplementation((_, source) => (source === 'group' ? 10 : 0))
    sourceLists.group = Array.from({ length: 20 }, (_, index) => job(`detail-refused-${index + 1}`))
    jobListRef.value = sourceLists.group.slice(0, 15)
    pagerNext.mockReturnValue(false)
    deliverJobListHandle
      .mockImplementationOnce(async (items: Array<{ item: any }> = []) => {
        const blocked = items[0]?.item
        blocked.credentialRefreshRequired = true
        blocked.deliveryCredentialOrigin = { source: 'group', page: 1 }
        return 'detailRefused'
      })
      .mockImplementationOnce(async (items) => {
        markBatchProcessed(items)
        common.deliverStop = true
        return 'stopped'
      })

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')
    await startButton!.trigger('click')
    await vi.waitFor(() => expect(deliverJobListHandle).toHaveBeenCalledTimes(2))

    expect(pagerReload).toHaveBeenCalled()
    expect(logInfo).toHaveBeenCalledWith(
      '投递批次',
      expect.stringContaining('详情接口连续被拒，重抓列表后继续'),
    )
    expect(durableTaskState.value?.status).not.toBe('failed')
    expect(durableTaskState.value?.checkpoint?.detailRecoveryAttempts).toBe(1)
    expect(durableTaskState.value?.checkpoint?.activeBatch?.items).not.toHaveLength(0)
    expect(wrapper.exists()).toBe(true)
  })

  it('reloads the original page and retries the first blocked FIFO job before later jobs', async () => {
    actualSource.value = 'group'
    visibleSource.value = 'group'
    getDeliveryLimit.mockImplementation((_, source) => (source === 'group' ? 10 : 0))
    const first = {
      ...job('blocked-page-2'),
      credentialRefreshRequired: true,
      deliveryQueueOrder: 1,
      deliveryQueueSource: 'group',
      deliveryCredentialOrigin: { source: 'group', page: 2 },
    }
    const second = {
      ...job('later-job'),
      deliveryQueueOrder: 2,
      deliveryQueueSource: 'group',
      deliveryCredentialOrigin: { source: 'group', page: 1 },
    }
    sourceLists.group = [first, second]
    jobListRef.value = [second]
    pagerReload.mockImplementation((targetPage: number) => {
      expect(targetPage).toBe(2)
      first.credentialRefreshRequired = false
      jobListRef.value = [first]
      jobListRevision.value += 1
    })
    const seenBatches: string[][] = []
    deliverJobListHandle.mockImplementation(async (items: Array<{ item: any }> = []) => {
      seenBatches.push(items.map(({ item }) => item.encryptJobId))
      markBatchProcessed(items)
      common.deliverStop = true
      return 'stopped'
    })
    const checkpoint = {
      accountUid: 'account-a',
      id: 'blocked-fifo-task',
      startedAt: clock.now - 60_000,
      currentIndex: 0,
      activeBatch: {
        id: 'blocked-fifo-batch',
        startedAt: clock.now - 30_000,
        items: [
          { source: 'group', encryptJobId: first.encryptJobId },
          { source: 'group', encryptJobId: second.encryptJobId },
        ],
      },
      detailRecoveryAttempts: 1,
      poolWarmup: { completed: true, attemptedStepIndexes: [], lowWaterArmed: true },
      steps: [
        {
          source: 'group',
          url: 'https://www.zhipin.com/web/geek/jobs',
          status: 'running',
          pagesDone: 1,
        },
      ],
    }
    window.sessionStorage.setItem(
      'agent-delivery:combined-delivery-task',
      JSON.stringify(checkpoint),
    )
    registerDurableTask(checkpoint)

    const wrapper = mount(OperationPanel)
    await vi.waitFor(() => expect(deliverJobListHandle).toHaveBeenCalled())

    expect(pagerReload).toHaveBeenCalledWith(2)
    expect(seenBatches[0]).toEqual(['blocked-page-2', 'later-job'])
    expect(wrapper.exists()).toBe(true)
  })

  it('does not guess the current step for a legacy blocked job without an origin', async () => {
    actualSource.value = 'group'
    visibleSource.value = 'group'
    getDeliveryLimit.mockImplementation(() => 50)
    const blocked = {
      ...job('legacy-search-without-origin'),
      credentialRefreshRequired: true,
      deliveryQueueOrder: 1,
      deliveryQueueSource: 'search',
    }
    const later = {
      ...job('later-group-job'),
      deliveryQueueOrder: 2,
      deliveryQueueSource: 'group',
      deliveryCredentialOrigin: { source: 'group', page: 1 },
    }
    sourceLists.search = [blocked]
    sourceLists.group = [later]
    jobListRef.value = [later]
    deliverJobListHandle.mockImplementationOnce(async (items) => {
      expect(items.map((entry: any) => entry.item.encryptJobId)).toEqual(['later-group-job'])
      markBatchProcessed(items)
      common.deliverStop = true
      return 'stopped'
    })
    const checkpoint = {
      accountUid: 'account-a',
      id: 'legacy-origin-task',
      startedAt: clock.now - 60_000,
      currentIndex: 0,
      activeBatch: {
        id: 'legacy-origin-batch',
        startedAt: clock.now - 30_000,
        items: [
          { source: 'search', encryptJobId: blocked.encryptJobId },
          { source: 'group', encryptJobId: later.encryptJobId },
        ],
      },
      poolWarmup: { completed: true, attemptedStepIndexes: [], lowWaterArmed: true },
      steps: [
        {
          source: 'group',
          url: 'https://www.zhipin.com/web/geek/jobs',
          status: 'running',
          pagesDone: 1,
        },
      ],
    }
    window.sessionStorage.setItem(
      'agent-delivery:combined-delivery-task',
      JSON.stringify(checkpoint),
    )
    registerDurableTask(checkpoint)

    mount(OperationPanel)
    await vi.waitFor(() => expect(deliverJobListHandle).toHaveBeenCalledTimes(1))

    expect(pagerReload).not.toHaveBeenCalled()
    expect(routerPush).not.toHaveBeenCalled()
    expect(blocked).toMatchObject({
      credentialRefreshRequired: false,
      credentialRefreshDeferred: true,
      status: { status: 'wait' },
    })
  })

  it('defers only the missing job when its original page no longer contains it', async () => {
    actualSource.value = 'group'
    visibleSource.value = 'group'
    getDeliveryLimit.mockImplementation((_, source) => (source === 'group' ? 10 : 0))
    const blocked = {
      ...job('gone-from-original-page'),
      credentialRefreshRequired: true,
      deliveryQueueOrder: 1,
      deliveryQueueSource: 'group',
      deliveryCredentialOrigin: { source: 'group', page: 2 },
    }
    const later = {
      ...job('still-deliverable'),
      deliveryQueueOrder: 2,
      deliveryQueueSource: 'group',
      deliveryCredentialOrigin: { source: 'group', page: 1 },
    }
    sourceLists.group = [blocked, later]
    jobListRef.value = [later]
    pagerReload.mockImplementation((targetPage: number) => {
      expect(targetPage).toBe(2)
      jobListRef.value = [job('different-page-job')]
      jobListRevision.value += 1
    })
    deliverJobListHandle.mockImplementationOnce(async (items) => {
      expect(items.map((entry: any) => entry.item.encryptJobId)).toEqual(['still-deliverable'])
      markBatchProcessed(items)
      common.deliverStop = true
      return 'stopped'
    })
    const checkpoint = {
      accountUid: 'account-a',
      id: 'missing-original-job-task',
      startedAt: clock.now - 60_000,
      currentIndex: 0,
      activeBatch: {
        id: 'missing-original-job-batch',
        startedAt: clock.now - 30_000,
        items: [
          { source: 'group', encryptJobId: blocked.encryptJobId },
          { source: 'group', encryptJobId: later.encryptJobId },
        ],
      },
      poolWarmup: { completed: true, attemptedStepIndexes: [], lowWaterArmed: true },
      steps: [
        {
          source: 'group',
          url: 'https://www.zhipin.com/web/geek/jobs',
          status: 'running',
          pagesDone: 1,
        },
      ],
    }
    window.sessionStorage.setItem(
      'agent-delivery:combined-delivery-task',
      JSON.stringify(checkpoint),
    )
    registerDurableTask(checkpoint)

    mount(OperationPanel)
    await vi.waitFor(() => expect(deliverJobListHandle).toHaveBeenCalledTimes(1))

    expect(pagerReload).toHaveBeenCalledWith(2)
    expect(blocked).toMatchObject({
      credentialRefreshRequired: false,
      credentialRefreshDeferred: true,
    })
    expect(durableTaskState.value?.status).not.toBe('failed')
  })

  it('uses a source retry after three failed detail recoveries without losing the active batch', async () => {
    actualSource.value = 'group'
    visibleSource.value = 'group'
    getDeliveryLimit.mockImplementation((_, source) => (source === 'group' ? 10 : 0))
    const blocked = {
      ...job('cooldown-blocked'),
      credentialRefreshRequired: true,
      deliveryQueueOrder: 1,
      deliveryQueueSource: 'group',
      deliveryCredentialOrigin: { source: 'group', page: 2 },
    }
    sourceLists.group = [blocked]
    jobListRef.value = [job('other-page')]
    pagerReload.mockImplementation(() => {
      jobListRevision.value += 1
    })
    const checkpoint = {
      accountUid: 'account-a',
      id: 'detail-cooldown-task',
      startedAt: clock.now - 60_000,
      currentIndex: 0,
      activeBatch: {
        id: 'detail-cooldown-batch',
        startedAt: clock.now - 30_000,
        items: [{ source: 'group', encryptJobId: blocked.encryptJobId }],
      },
      detailRecoveryAttempts: 3,
      poolWarmup: { completed: true, attemptedStepIndexes: [], lowWaterArmed: true },
      steps: [
        {
          source: 'group',
          url: 'https://www.zhipin.com/web/geek/jobs',
          status: 'running',
          pagesDone: 1,
        },
      ],
    }
    window.sessionStorage.setItem(
      'agent-delivery:combined-delivery-task',
      JSON.stringify(checkpoint),
    )
    registerDurableTask(checkpoint)

    const wrapper = mount(OperationPanel)
    await vi.waitFor(() =>
      expect(durableTaskState.value?.checkpoint?.detailRecoveryAttempts).toBe(4),
    )

    expect(pagerReload).not.toHaveBeenCalled()
    expect(durableTaskState.value?.checkpoint).toMatchObject({
      detailRecoveryAttempts: 4,
      activeBatch: { id: 'detail-cooldown-batch' },
    })
    expect(durableTaskState.value?.checkpoint?.retryAt).toBe(clock.now + 60_000)
    expect(deliverJobListHandle).not.toHaveBeenCalled()
    expect(wrapper.exists()).toBe(true)
  })

  it('recovers a single blocked pool job even after its original batch was completed', async () => {
    actualSource.value = 'group'
    visibleSource.value = 'group'
    getDeliveryLimit.mockImplementation((_, source) => (source === 'group' ? 10 : 0))
    const blocked = {
      ...job('orphaned-credential-job'),
      credentialRefreshRequired: true,
      deliveryQueueOrder: 1,
      deliveryQueueSource: 'group',
      deliveryCredentialOrigin: { source: 'group', page: 2 },
    }
    sourceLists.group = [blocked]
    jobListRef.value = [job('current-page-job')]
    pagerReload.mockImplementation((targetPage: number) => {
      expect(targetPage).toBe(2)
      blocked.credentialRefreshRequired = false
      jobListRef.value = [blocked]
      jobListRevision.value += 1
    })
    deliverJobListHandle.mockImplementation(async (items) => {
      markBatchProcessed(items)
      common.deliverStop = true
      return 'stopped'
    })
    const checkpoint = {
      accountUid: 'account-a',
      id: 'orphaned-credential-task',
      startedAt: clock.now - 60_000,
      currentIndex: 0,
      poolWarmup: { completed: true, attemptedStepIndexes: [], lowWaterArmed: true },
      steps: [
        {
          source: 'group',
          url: 'https://www.zhipin.com/web/geek/jobs',
          status: 'running',
          pagesDone: 1,
        },
      ],
    }
    window.sessionStorage.setItem(
      'agent-delivery:combined-delivery-task',
      JSON.stringify(checkpoint),
    )
    registerDurableTask(checkpoint)

    const wrapper = mount(OperationPanel)
    await vi.waitFor(() => expect(pagerReload).toHaveBeenCalledWith(2))
    await vi.waitFor(() => expect(deliverJobListHandle).toHaveBeenCalled())

    expect(durableTaskState.value?.status).not.toBe('failed')
    expect(wrapper.exists()).toBe(true)
  })

  it('does not let an unrelated blocked pool job interrupt an active FIFO batch', async () => {
    actualSource.value = 'group'
    visibleSource.value = 'group'
    getDeliveryLimit.mockImplementation((_, source) => (source === 'group' ? 10 : 0))
    const active = {
      ...job('active-fifo-job'),
      deliveryQueueOrder: 1,
      deliveryQueueSource: 'group',
    }
    const unrelated = {
      ...job('unrelated-blocked-job'),
      credentialRefreshRequired: true,
      deliveryQueueOrder: 2,
      deliveryQueueSource: 'group',
      deliveryCredentialOrigin: { source: 'group', page: 2 },
    }
    sourceLists.group = [active, unrelated]
    jobListRef.value = [active]
    deliverJobListHandle.mockImplementationOnce(async (items) => {
      expect(items.map(({ item }: any) => item.encryptJobId)).toContain('active-fifo-job')
      markBatchProcessed(items)
      common.deliverStop = true
      return 'stopped'
    })
    const checkpoint = {
      accountUid: 'account-a',
      id: 'active-fifo-task',
      startedAt: clock.now - 60_000,
      currentIndex: 0,
      activeBatch: {
        id: 'active-fifo-batch',
        startedAt: clock.now - 30_000,
        items: [{ source: 'group', encryptJobId: active.encryptJobId }],
      },
      poolWarmup: { completed: true, attemptedStepIndexes: [], lowWaterArmed: true },
      steps: [
        {
          source: 'group',
          url: 'https://www.zhipin.com/web/geek/jobs',
          status: 'running',
          pagesDone: 1,
        },
      ],
    }
    window.sessionStorage.setItem(
      'agent-delivery:combined-delivery-task',
      JSON.stringify(checkpoint),
    )
    registerDurableTask(checkpoint)

    mount(OperationPanel)
    await vi.waitFor(() => expect(deliverJobListHandle).toHaveBeenCalledTimes(1))
    expect(pagerReload).not.toHaveBeenCalled()
  })

  it('resumes one owner after refresh when the background run is active', async () => {
    actualSource.value = 'group'
    visibleSource.value = 'group'
    getDeliveryLimit.mockImplementation((_, source) => (source === 'group' ? 10 : 0))
    sourceLists.group = Array.from({ length: 20 }, (_, index) => job(`resume-${index + 1}`))
    const resumedRun = createDeferred<'stopped'>()
    deliverJobListHandle.mockReturnValueOnce(resumedRun.promise)
    window.sessionStorage.setItem(
      'agent-delivery:combined-delivery-task',
      JSON.stringify({
        accountUid: 'account-a',
        id: 'fresh-refresh-task',
        startedAt: Date.now() - 60_000,
        currentIndex: 0,
        runtimeHeartbeat: {
          at: Date.now() - 1_000,
          source: 'group',
        },
        steps: [
          {
            source: 'group',
            url: 'https://www.zhipin.com/web/geek/jobs',
            status: 'running',
            pagesDone: 0,
          },
        ],
      }),
    )
    durableTaskState.value = {
      schemaVersion: 2,
      accountUid: 'account-a',
      runId: 'fresh-refresh-task',
      status: 'waiting-for-page',
      phase: 'waiting',
      checkpoint: JSON.parse(
        window.sessionStorage.getItem('agent-delivery:combined-delivery-task') ?? 'null',
      ),
      configSnapshot: currentConfigSnapshot(),
      startedAt: Date.now() - 60_000,
      updatedAt: clock.now,
      revision: 1,
    }

    mount(OperationPanel)
    await vi.waitFor(() => expect(deliverJobListHandle).toHaveBeenCalledTimes(1))
    await flushPromises()

    expect(deliverJobListHandle).toHaveBeenCalledTimes(1)
    expect(routerPush).not.toHaveBeenCalled()
    expect(common.deliverLock).toBe(true)
    expect(logInfo).toHaveBeenCalledWith(
      '投递批次',
      expect.stringContaining('durable-background-task'),
    )

    common.deliverStop = true
    resumedRun.resolve('stopped')
    await flushPromises()
  })

  it('restores a running task from the background checkpoint when page session state is empty', async () => {
    pagerNext.mockReturnValue(false)
    deliverJobListHandle.mockImplementationOnce(async (items) => {
      markBatchProcessed(items)
      common.deliverStop = true
      return 'stopped'
    })
    const checkpoint = {
      accountUid: 'account-a',
      id: 'durable-refresh-task',
      startedAt: clock.now - 60_000,
      currentIndex: 0,
      acquisitionCycle: 2,
      cycleStartedSuccess: 0,
      noProgressCycles: 0,
      poolWarmup: { completed: true, attemptedStepIndexes: [0] },
      runtimeHeartbeat: { at: clock.now - 60_000, source: 'group' },
      steps: [
        {
          source: 'group',
          url: 'https://www.zhipin.com/web/geek/jobs',
          status: 'running',
          pagesDone: 0,
        },
      ],
    }
    durableTaskState.value = {
      schemaVersion: 1,
      accountUid: 'account-a',
      runId: checkpoint.id,
      status: 'waiting-for-page',
      checkpoint,
      configSnapshot: currentConfigSnapshot(),
      startedAt: checkpoint.startedAt,
      updatedAt: clock.now - 20_000,
      revision: 4,
    }

    mount(OperationPanel)
    await vi.waitFor(() => expect(deliverJobListHandle).toHaveBeenCalled())

    const restored = JSON.parse(
      window.sessionStorage.getItem('agent-delivery:combined-delivery-task') ?? 'null',
    )
    expect(restored.id).toBe(checkpoint.id)
    expect(restored.acquisitionCycle).toBeGreaterThanOrEqual(2)
    expect(logInfo).toHaveBeenCalledWith(
      '投递批次',
      expect.stringContaining('"resumeReason":"durable-background-task"'),
    )
  })

  it('keeps another live tab as the task owner instead of terminating the shared task', async () => {
    const { counter } = await import('@/message')
    const checkpoint = {
      accountUid: 'account-a',
      id: 'other-tab-task',
      startedAt: clock.now - 10_000,
      currentIndex: 0,
      poolWarmup: { completed: true, attemptedStepIndexes: [0] },
      steps: [
        {
          source: 'group',
          url: 'https://www.zhipin.com/web/geek/jobs',
          status: 'running',
          pagesDone: 0,
        },
      ],
    }
    durableTaskState.value = {
      schemaVersion: 1,
      accountUid: 'account-a',
      runId: checkpoint.id,
      status: 'running',
      checkpoint,
      configSnapshot: currentConfigSnapshot(),
      workerId: 'boss-tab-other:session',
      leaseExpiresAt: clock.now + 15_000,
      startedAt: checkpoint.startedAt,
      updatedAt: clock.now,
      revision: 2,
    }
    vi.mocked(counter.deliveryTaskClaim).mockResolvedValueOnce({
      accepted: false,
      conflict: 'worker-owned',
      task: structuredClone(durableTaskState.value),
    })

    mount(OperationPanel)
    await vi.waitFor(() =>
      expect(logInfo).toHaveBeenCalledWith(
        '投递批次',
        expect.stringContaining('其他标签页正在执行'),
      ),
    )

    expect(deliverJobListHandle).not.toHaveBeenCalled()
    expect(counter.deliveryTaskTerminate).not.toHaveBeenCalled()
    expect(counter.deliveryTaskRelease).not.toHaveBeenCalled()
    expect(durableTaskState.value).toMatchObject({ status: 'running', runId: checkpoint.id })
  })

  it('navigates to the checkpoint source before validating its native expectation controls', async () => {
    const { counter } = await import('@/message')
    actualSource.value = 'search'
    visibleSource.value = 'search'
    window.history.replaceState({}, '', '/web/geek/job?query=other')
    const expectation = {
      id: '101',
      index: 0,
      positionName: 'AI 产品经理',
      locationName: '上海',
      salaryDesc: '30-50K',
    }
    const checkpoint = {
      accountUid: 'account-a',
      id: 'resume-to-group-task',
      startedAt: clock.now - 10_000,
      currentIndex: 0,
      poolWarmup: { completed: true, attemptedStepIndexes: [0] },
      steps: [
        {
          source: 'group',
          url: 'https://www.zhipin.com/web/geek/jobs',
          status: 'running',
          pagesDone: 0,
          expectation,
        },
      ],
    }
    durableTaskState.value = {
      schemaVersion: 1,
      accountUid: 'account-a',
      runId: checkpoint.id,
      status: 'waiting-for-page',
      checkpoint,
      configSnapshot: currentConfigSnapshot(),
      startedAt: checkpoint.startedAt,
      updatedAt: clock.now,
      revision: 2,
    }
    routerPush.mockImplementationOnce(async () => {
      actualSource.value = 'group'
      visibleSource.value = 'group'
      window.history.replaceState({}, '', '/web/geek/jobs')
      jobListRef.value = [{ ...job('group-after-resume'), expectId: 101 }]
      const expectationRoot = document.createElement('div')
      expectationRoot.className = 'c-expect-select'
      expectationRoot.innerHTML = `
        <div class="expect-list">
          <button class="expect-item active" data-expect-id="101">
            <span class="text-content">AI 产品经理（上海）</span>
          </button>
        </div>
      `
      document.body.appendChild(expectationRoot)
    })
    deliverJobListHandle.mockImplementationOnce(async (items) => {
      markBatchProcessed(items)
      common.deliverStop = true
      return 'stopped'
    })

    mount(OperationPanel)
    await vi.waitFor(() => expect(routerPush).toHaveBeenCalledWith('/web/geek/jobs'))
    await vi.waitFor(() => expect(deliverJobListHandle).toHaveBeenCalled())

    expect(counter.deliveryTaskTerminate).not.toHaveBeenCalled()
    expect(logInfo).not.toHaveBeenCalledWith(
      '投递批次',
      expect.stringContaining('求职期望岗位列表不可用'),
    )
  })

  it('restores the durable checkpoint even when the page cache is newer', async () => {
    const { counter } = await import('@/message')
    pagerNext.mockReturnValue(false)
    const backgroundCheckpoint = {
      accountUid: 'account-a',
      id: 'checkpoint-race-task',
      startedAt: clock.now - 10_000,
      checkpointAt: clock.now - 2_000,
      currentIndex: 0,
      poolWarmup: { completed: true, attemptedStepIndexes: [0] },
      steps: [
        {
          source: 'group',
          url: 'https://www.zhipin.com/web/geek/jobs',
          status: 'running',
          pagesDone: 0,
        },
      ],
    }
    const localRetryAt = clock.now + 60_000
    window.sessionStorage.setItem(
      'agent-delivery:combined-delivery-task',
      JSON.stringify({
        ...backgroundCheckpoint,
        checkpointAt: clock.now - 1_000,
        retryAt: localRetryAt,
      }),
    )
    durableTaskState.value = {
      schemaVersion: 1,
      accountUid: 'account-a',
      runId: backgroundCheckpoint.id,
      status: 'running',
      checkpoint: backgroundCheckpoint,
      configSnapshot: currentConfigSnapshot(),
      workerId: 'boss-tab-test:previous-session',
      leaseExpiresAt: clock.now + 10_000,
      startedAt: backgroundCheckpoint.startedAt,
      updatedAt: clock.now - 2_000,
      revision: 2,
    }
    vi.mocked(counter.deliveryTaskClaim).mockResolvedValueOnce({
      accepted: false,
      conflict: 'worker-owned',
      task: structuredClone(durableTaskState.value),
    })

    mount(OperationPanel)
    for (let index = 0; index < 6; index++) await flushPromises()

    expect(deliverJobListHandle).not.toHaveBeenCalled()
    const restored = JSON.parse(
      window.sessionStorage.getItem('agent-delivery:combined-delivery-task') ?? 'null',
    )
    expect(restored.id).toBe(backgroundCheckpoint.id)
    expect(restored.retryAt).toBeUndefined()
    expect(localRetryAt).toBeGreaterThan(backgroundCheckpoint.checkpointAt)
  })

  it('keeps a durable task waiting until daily statistics can be restored safely', async () => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
    })
    pagerNext.mockReturnValue(false)
    const checkpoint = {
      accountUid: 'account-a',
      id: 'statistics-wait-task',
      startedAt: clock.now - 10_000,
      currentIndex: 0,
      poolWarmup: { completed: true, attemptedStepIndexes: [0] },
      steps: [
        {
          source: 'group',
          url: 'https://www.zhipin.com/web/geek/jobs',
          status: 'running',
          pagesDone: 0,
        },
      ],
    }
    durableTaskState.value = {
      schemaVersion: 1,
      accountUid: 'account-a',
      runId: checkpoint.id,
      status: 'waiting-for-page',
      checkpoint,
      configSnapshot: currentConfigSnapshot(),
      startedAt: checkpoint.startedAt,
      updatedAt: clock.now,
      revision: 1,
    }
    statistics.updateStatistics
      .mockRejectedValueOnce(new Error('storage temporarily unavailable'))
      .mockRejectedValueOnce(new Error('storage temporarily unavailable'))
      .mockResolvedValue(undefined)

    mount(OperationPanel)
    for (let index = 0; index < 4; index++) await flushPromises()
    expect(deliverJobListHandle).not.toHaveBeenCalled()
    expect(durableTaskState.value).toMatchObject({ status: 'waiting-for-page' })

    window.dispatchEvent(new Event('focus'))
    await flushPromises()
    expect(deliverJobListHandle).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(5_000)
    await vi.waitFor(() => expect(deliverJobListHandle).toHaveBeenCalled())
  })

  it('pauses without destroying the checkpoint, and only 结束 marks the task stopped', async () => {
    pagerNext.mockReturnValue(false)
    const batch = createDeferred<'stopped'>()
    deliverJobListHandle.mockImplementation(() => batch.promise)
    const wrapper = mount(OperationPanel)
    const findButton = (label: string) =>
      wrapper.findAll('button').find((button) => button.text() === label)
    await findButton('开始投递')!.trigger('click')
    await vi.waitFor(() => expect(deliverJobListHandle).toHaveBeenCalled())

    // 投递中只提供「暂停」。暂停必须保住检查点，否则「继续」就只是重新开始。
    expect(findButton('结束')).toBeUndefined()
    await findButton('暂停')!.trigger('click')
    await vi.waitFor(() => expect(durableTaskState.value).toMatchObject({ status: 'paused' }))
    expect(durableTaskState.value.checkpoint).toBeTruthy()
    expect(durableTaskState.value.workerId).toBeUndefined()
    expect(window.sessionStorage.getItem('agent-delivery:combined-delivery-task')).not.toBeNull()

    // 暂停是异步的：waitFor 命中的是后台状态，界面还要再等一轮微任务和渲染。
    for (let i = 0; i < 6; i++) await flushPromises()
    expect(findButton('暂停')).toBeUndefined()
    // 暂停态只给两个出口，「重置待处理」不掺和进来。
    expect(findButton('重置待处理')).toBeUndefined()
    expect(findButton('继续')).toBeDefined()
    expect(wrapper.find('.operation-panel__run-state').text()).toContain('已暂停')
    await findButton('结束')!.trigger('click')
    await vi.waitFor(() =>
      expect(durableTaskState.value).toMatchObject({
        status: 'stopped',
        terminalReason: 'manual-stop',
      }),
    )
    expect(window.sessionStorage.getItem('agent-delivery:combined-delivery-task')).toBeNull()
    batch.resolve('stopped')
  })

  it('automatically retries a manual pause after the background runtime reconnects', async () => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
    })
    pagerNext.mockReturnValue(false)
    const batch = createDeferred<'stopped'>()
    deliverJobListHandle.mockImplementation(() => batch.promise)
    const wrapper = mount(OperationPanel)
    const findButton = (label: string) =>
      wrapper.findAll('button').find((button) => button.text() === label)
    await findButton('开始投递')!.trigger('click')
    await vi.waitFor(() => expect(deliverJobListHandle).toHaveBeenCalled())
    vi.mocked(counter.deliveryTaskPause).mockRejectedValueOnce(new Error('pause rpc failed'))

    await findButton('暂停')!.trigger('click')
    await vi.waitFor(() =>
      expect(AgentMessage.info).toHaveBeenCalledWith(
        '插件后台暂时不可用，暂停状态将在连接恢复后保存',
      ),
    )
    expect(window.sessionStorage.getItem('agent-delivery:combined-delivery-task')).not.toBeNull()
    expect(durableTaskState.value?.status).toBe('running')
    const waitingButtonTexts = wrapper.findAll('button').map((button) => button.text())
    expect(waitingButtonTexts).toContain('等待中')
    expect(waitingButtonTexts).not.toContain('暂停')
    expect(waitingButtonTexts).not.toContain('开始投递')

    await vi.advanceTimersByTimeAsync(5_000)
    await vi.waitFor(() => expect(counter.deliveryTaskPause).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(durableTaskState.value?.status).toBe('paused'))

    batch.resolve('stopped')
  })

  it('keeps a paused task resumable when the resume RPC is temporarily unavailable', async () => {
    pagerNext.mockReturnValue(false)
    deliverJobListHandle.mockImplementation(async (items?: Array<{ item?: any }>) => {
      markBatchProcessed(items)
      return 'aiUnavailable'
    })
    const wrapper = mount(OperationPanel)
    const findButton = (label: string) =>
      wrapper.findAll('button').find((button) => button.text() === label)
    await findButton('开始投递')!.trigger('click')
    await vi.waitFor(() => expect(durableTaskState.value?.status).toBe('paused'))
    vi.mocked(counter.deliveryTaskResume).mockRejectedValueOnce(new Error('resume rpc failed'))

    await findButton('继续')!.trigger('click')
    await vi.waitFor(() =>
      expect(AgentMessage.info).toHaveBeenCalledWith('插件后台暂时不可用，请稍后再次继续'),
    )

    expect(durableTaskState.value?.status).toBe('paused')
    expect(window.sessionStorage.getItem('agent-delivery:combined-delivery-task')).not.toBeNull()
    expect(findButton('继续')).toBeDefined()
  })

  it('restores a paused background checkpoint after a page refresh and continues the same task', async () => {
    pagerNext.mockReturnValue(false)
    const checkpoint = {
      accountUid: 'account-a',
      id: 'paused-refresh-task',
      startedAt: clock.now - 60_000,
      currentIndex: 0,
      poolWarmup: { completed: true, attemptedStepIndexes: [], lowWaterArmed: true },
      steps: [
        {
          source: 'group',
          url: 'https://www.zhipin.com/web/geek/jobs',
          status: 'running',
          pagesDone: 0,
        },
      ],
    }
    registerDurableTask(checkpoint, { status: 'paused' })
    deliverJobListHandle.mockImplementation(async (items) => {
      markBatchProcessed(items)
      common.deliverStop = true
      return 'stopped'
    })

    const wrapper = mount(OperationPanel)
    await vi.waitFor(() =>
      expect(window.sessionStorage.getItem('agent-delivery:combined-delivery-task')).not.toBeNull(),
    )
    const findButton = (label: string) =>
      wrapper.findAll('button').find((button) => button.text() === label)
    expect(findButton('继续')).toBeDefined()

    await findButton('继续')!.trigger('click')
    await vi.waitFor(() => expect(counter.deliveryTaskResume).toHaveBeenCalled())
    await vi.waitFor(() => expect(deliverJobListHandle).toHaveBeenCalled())

    expect(durableTaskState.value?.runId).toBe(checkpoint.id)
    expect(counter.deliveryTaskStart).not.toHaveBeenCalled()
  })

  it('pauses instead of terminating when the AI channel keeps failing', async () => {
    // 模型不可用是能修好的。终止会连同检查点一起清掉，用户配好模型后只能从头再来；
    // 暂停把位置留着，点「继续」就接着原来的投递池跑。
    pagerNext.mockReturnValue(false)
    deliverJobListHandle.mockImplementation(async (items?: Array<{ item?: any }>) => {
      markBatchProcessed(items)
      return 'aiUnavailable'
    })
    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')
    await startButton!.trigger('click')

    await vi.waitFor(() => expect(durableTaskState.value).toMatchObject({ status: 'paused' }))
    expect(durableTaskState.value.checkpoint).toBeTruthy()
    expect(window.sessionStorage.getItem('agent-delivery:combined-delivery-task')).not.toBeNull()
  })

  it('survives an AI outage end to end: pause, keep everything, resume', async () => {
    // 这条走完整条链路，而不是分别验各个环节——这次改动来回了五个版本，
    // 出问题的恰恰是「每段都对、拼起来断了」：三个出口只改了两个，
    // 运行从没改的那个走掉，任务被释放成 waiting-for-page，检查点没保住。
    pagerNext.mockReturnValue(false)
    deliverJobListHandle.mockImplementation(async (items?: Array<{ item?: any }>) => {
      markBatchProcessed(items)
      return 'aiUnavailable'
    })
    const wrapper = mount(OperationPanel)
    const findButton = (label: string) =>
      wrapper.findAll('button').find((button) => button.text() === label)

    await findButton('开始投递')!.trigger('click')

    // 1. 暂停而不是终止，检查点和任务都留着
    await vi.waitFor(() => expect(durableTaskState.value).toMatchObject({ status: 'paused' }))
    expect(durableTaskState.value.checkpoint).toBeTruthy()
    expect(durableTaskState.value.terminalReason).toBeUndefined()
    expect(window.sessionStorage.getItem('agent-delivery:combined-delivery-task')).not.toBeNull()

    // 2. 界面进入可继续的状态
    for (let i = 0; i < 6; i++) await flushPromises()
    expect(wrapper.find('.operation-panel__run-state').text()).toContain('已暂停')
    expect(findButton('继续')).toBeDefined()
    expect(findButton('结束')).toBeDefined()

    // 3. 换好模型后继续，运行从原任务接着跑，而不是新建一轮
    const pausedRunId = durableTaskState.value.runId
    deliverJobListHandle.mockImplementation(async (items?: Array<{ item?: any }>) => {
      markBatchProcessed(items)
      return 'completed'
    })
    await findButton('继续')!.trigger('click')

    await vi.waitFor(() => expect(durableTaskState.value.status).not.toBe('paused'))
    expect(durableTaskState.value.runId).toBe(pausedRunId)
  })

  it('marks a running task completed when the daily limit is reached', async () => {
    pagerNext.mockReturnValue(false)
    deliverJobListHandle.mockImplementation(async (items?: Array<{ item?: any }>) => {
      markBatchProcessed(items)
      statistics.todayData.success = 100
      dailyRemaining.value = false
      return 'sourceLimit'
    })
    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')
    await startButton!.trigger('click')

    await vi.waitFor(() =>
      expect(durableTaskState.value).toMatchObject({
        status: 'completed',
        terminalReason: 'daily-limit',
      }),
    )
    expect(window.sessionStorage.getItem('agent-delivery:combined-delivery-task')).toBeNull()
  })

  it('marks a non-recoverable execution failure as a terminal error', async () => {
    pagerNext.mockReturnValue(false)
    deliverJobListHandle.mockRejectedValue(new Error('job workflow failed'))
    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')
    await startButton!.trigger('click')

    await vi.waitFor(() =>
      expect(durableTaskState.value).toMatchObject({
        status: 'failed',
        terminalReason: 'terminal-error',
      }),
    )
    expect(window.sessionStorage.getItem('agent-delivery:combined-delivery-task')).toBeNull()
  })

  it('marks an explicit terminal batch result as failed instead of waiting for a page', async () => {
    pagerNext.mockReturnValue(false)
    deliverJobListHandle.mockResolvedValue('terminalError')
    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')
    await startButton!.trigger('click')

    await vi.waitFor(() =>
      expect(durableTaskState.value).toMatchObject({
        status: 'failed',
        terminalReason: 'terminal-error',
      }),
    )
    expect(durableTaskState.value?.status).not.toBe('waiting-for-page')
    expect(window.sessionStorage.getItem('agent-delivery:combined-delivery-task')).toBeNull()
  })

  // 用户的原话：「不可能说现在每投十多个，我就得手动一次，不合理」。详情接口连着拒三个
  // 岗位时，之前是直接收工。手动继续之所以每次都好使，无非是重抓了一遍列表页——那就自己做。
  it('re-warms the pool instead of failing when detail requests are refused', async () => {
    pagerNext.mockReturnValue(false)
    deliverJobListHandle.mockResolvedValue('detailRefused')
    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')
    await startButton!.trigger('click')

    await vi.waitFor(() =>
      expect(logInfo).toHaveBeenCalledWith(
        '投递批次',
        expect.stringContaining('详情接口连续被拒，重抓列表后继续'),
      ),
    )
    // 关键：没有被判成运行错误收工。
    expect(durableTaskState.value).not.toMatchObject({ terminalReason: 'terminal-error' })

    // 重抓有上限，不能无限空转。放弃那一步走的是 markTerminalFailure，用集成测试卡不住
    // ——这个环境跑完三轮就自然收尾了，第四轮不会发生——所以在这里把计数和上限钉住。
    const payload = logInfo.mock.calls.find(
      (call: unknown[]) =>
        typeof call[1] === 'string' && call[1].includes('详情接口连续被拒，重抓列表后继续'),
    )?.[1] as string
    expect(payload).toContain('"recovery":1')
    expect(payload).toContain('"maxRecoveries":3')
  })

  it('does not resume an expired runtime heartbeat after refresh', async () => {
    actualSource.value = 'group'
    visibleSource.value = 'group'
    getDeliveryLimit.mockImplementation((_, source) => (source === 'group' ? 10 : 0))
    window.sessionStorage.setItem(
      'agent-delivery:combined-delivery-task',
      JSON.stringify({
        accountUid: 'account-a',
        id: 'expired-refresh-task',
        startedAt: Date.now() - 180_000,
        currentIndex: 0,
        runtimeHeartbeat: {
          at: Date.now() - 120_000,
          source: 'group',
        },
        steps: [
          {
            source: 'group',
            url: 'https://www.zhipin.com/web/geek/jobs',
            status: 'running',
            pagesDone: 0,
          },
        ],
      }),
    )
    mount(OperationPanel)
    await flushPromises()
    await flushPromises()

    expect(deliverJobListHandle).not.toHaveBeenCalled()
    expect(window.sessionStorage.getItem('agent-delivery:combined-delivery-task')).toBeNull()
  })

  it('does not navigate or resume when a fresh heartbeat belongs to another source', async () => {
    actualSource.value = 'group'
    visibleSource.value = 'group'
    getDeliveryLimit.mockImplementation((_, source) => (source === 'search' ? 10 : 0))
    window.sessionStorage.setItem(
      'agent-delivery:combined-delivery-task',
      JSON.stringify({
        accountUid: 'account-a',
        id: 'wrong-source-refresh-task',
        startedAt: Date.now() - 60_000,
        currentIndex: 0,
        runtimeHeartbeat: {
          at: Date.now() - 1_000,
          source: 'search',
        },
        steps: [
          {
            source: 'search',
            url: 'https://www.zhipin.com/web/geek/job?query=AI',
            status: 'running',
            pagesDone: 0,
          },
        ],
      }),
    )
    mount(OperationPanel)
    await flushPromises()
    await flushPromises()

    expect(deliverJobListHandle).not.toHaveBeenCalled()
    expect(routerPush).not.toHaveBeenCalled()
    expect(window.sessionStorage.getItem('agent-delivery:combined-delivery-task')).toBeNull()
  })

  it('clears an unregistered local task before starting a new manual task', async () => {
    actualSource.value = 'group'
    visibleSource.value = 'group'
    getDeliveryLimit.mockImplementation((_, source) => (source === 'group' ? 10 : 0))
    const manualRun = createDeferred<'stopped'>()
    deliverJobListHandle.mockReturnValueOnce(manualRun.promise)
    window.sessionStorage.setItem(
      'agent-delivery:combined-delivery-task',
      JSON.stringify({
        accountUid: 'account-a',
        id: 'stale-resume-task',
        startedAt: Date.now() - 60_000,
        currentIndex: 0,
        steps: [
          {
            source: 'group',
            url: 'https://www.zhipin.com/web/geek/jobs',
            status: 'running',
            pagesDone: 0,
          },
        ],
      }),
    )
    const wrapper = mount(OperationPanel)
    await flushPromises()
    expect(window.sessionStorage.getItem('agent-delivery:combined-delivery-task')).toBeNull()

    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')
    await startButton!.trigger('click')
    await vi.waitFor(() => expect(deliverJobListHandle).toHaveBeenCalledTimes(1))
    const manualTaskId = JSON.parse(
      window.sessionStorage.getItem('agent-delivery:combined-delivery-task')!,
    ).id
    expect(manualTaskId).not.toBe('stale-resume-task')

    common.deliverStop = true
    manualRun.resolve('stopped')
    await flushPromises()
  })

  it('resumes a saved search task on mount even when the runtime-ready event was missed', async () => {
    actualSource.value = 'search'
    visibleSource.value = 'search'
    jobListRef.value = [job('search-page-first')]
    getDeliveryLimit.mockImplementation((_, source) => (source === 'search' ? 10 : 0))
    deliverJobListHandle.mockImplementationOnce(async (items) => {
      markBatchProcessed(items)
      common.deliverStop = true
      return 'stopped'
    })
    window.history.replaceState({}, '', '/web/geek/job?query=AI')
    window.sessionStorage.setItem(
      'agent-delivery:combined-delivery-task',
      JSON.stringify({
        accountUid: 'account-a',
        id: 'resume-search-task',
        startedAt: Date.now(),
        currentIndex: 1,
        steps: [
          {
            source: 'group',
            url: 'https://www.zhipin.com/web/geek/jobs?salary=406',
            status: 'waiting',
            pagesDone: 1,
          },
          {
            source: 'search',
            url: 'https://www.zhipin.com/web/geek/job?query=AI',
            status: 'pending',
            pagesDone: 0,
            resumeNavigationAttempt: {
              at: Date.now() - 1000,
              fromUrl: 'https://www.zhipin.com/web/geek/jobs?salary=406',
              targetUrl: 'https://www.zhipin.com/web/geek/job?query=AI',
            },
          },
        ],
      }),
    )
    registerStoredTask()
    mount(OperationPanel)
    await flushPromises()
    await flushPromises()

    expect(deliverJobListHandle).toHaveBeenCalled()
    expect(logInfo).toHaveBeenCalledWith(
      '投递批次',
      expect.stringContaining('恢复投递任务继续执行'),
    )
  })

  it('continues an unfinished pool warmup after an internal SPA remount', async () => {
    actualSource.value = 'search'
    visibleSource.value = 'search'
    jobListRef.value = Array.from({ length: 15 }, (_, index) => job(`resume-warmup-${index + 1}`))
    getDeliveryLimit.mockImplementation((_, source) => (source === 'search' ? 10 : 0))
    pagerNext.mockReturnValue(false)
    deliverJobListHandle.mockImplementationOnce(async (items) => {
      expect(items).toHaveLength(10)
      markBatchProcessed(items)
      common.deliverStop = true
      return 'stopped'
    })
    window.history.replaceState({}, '', '/web/geek/job?query=AI')
    window.sessionStorage.setItem(
      'agent-delivery:combined-delivery-task',
      JSON.stringify({
        accountUid: 'account-a',
        id: 'resume-warmup-task',
        startedAt: Date.now(),
        currentIndex: 0,
        poolWarmup: {
          completed: false,
          attemptedStepIndexes: [],
        },
        steps: [
          {
            source: 'search',
            searchDirection: 'AI',
            url: 'https://www.zhipin.com/web/geek/job?query=AI',
            status: 'running',
            pagesDone: 0,
            poolSizeAtEntry: 0,
            resumeNavigationAttempt: {
              at: Date.now() - 1000,
              fromUrl: 'https://www.zhipin.com/web/geek/jobs',
              targetUrl: 'https://www.zhipin.com/web/geek/job?query=AI',
            },
          },
        ],
      }),
    )
    registerStoredTask()

    mount(OperationPanel)
    for (let i = 0; i < 8; i++) {
      await flushPromises()
    }

    expect(deliverJobListHandle).toHaveBeenCalledTimes(1)
    expect(logInfo).toHaveBeenCalledWith(
      '投递批次',
      expect.stringContaining('恢复投递任务继续首次补充投递池'),
    )
    expect(logInfo).toHaveBeenCalledWith(
      '投递批次',
      expect.stringContaining('"completionReason":"source-round-complete"'),
    )
  })

  it('resumes the remaining active FIFO batch before starting another pool warmup', async () => {
    actualSource.value = 'group'
    visibleSource.value = 'group'
    const groupJobs = Array.from({ length: 20 }, (_, index) => job(`group-${index + 1}`))
    sourceLists.group = groupJobs
    sourceLists.search = []
    jobListRef.value = groupJobs.slice(0, 15)
    getDeliveryLimit.mockImplementation((_, source) => (source === 'group' ? 100 : 0))
    deliverJobListHandle.mockImplementationOnce(async (items) => {
      expect(items.map((entry: any) => entry.item.encryptJobId)).toEqual([
        'group-6',
        'group-7',
        'group-8',
        'group-9',
      ])
      markBatchProcessed(items)
      common.deliverStop = true
      return 'stopped'
    })
    window.history.replaceState({}, '', '/web/geek/jobs')
    window.sessionStorage.setItem(
      'agent-delivery:combined-delivery-task',
      JSON.stringify({
        accountUid: 'account-a',
        id: 'resume-active-batch-task',
        startedAt: Date.now(),
        currentIndex: 0,
        poolWarmup: {
          completed: false,
          attemptedStepIndexes: [],
          lowWaterArmed: false,
        },
        activeBatch: {
          id: 'batch-before-remount',
          startedAt: Date.now() - 10_000,
          items: [
            { source: 'group', encryptJobId: 'group-6' },
            { source: 'group', encryptJobId: 'group-7' },
            { source: 'group', encryptJobId: 'group-8' },
            { source: 'group', encryptJobId: 'group-9' },
          ],
        },
        steps: [
          {
            source: 'group',
            url: 'https://www.zhipin.com/web/geek/jobs',
            status: 'running',
            pagesDone: 1,
          },
        ],
      }),
    )
    registerStoredTask()

    mount(OperationPanel)
    await vi.waitFor(() => expect(deliverJobListHandle).toHaveBeenCalledTimes(1))

    expect(pagerNext).not.toHaveBeenCalled()
    expect(logInfo).toHaveBeenCalledWith(
      '投递批次',
      expect.stringContaining('恢复未完成 FIFO 批次'),
    )
  })

  it('writes a new FIFO batch to the durable checkpoint before processing its first job', async () => {
    sourceLists.group = Array.from({ length: 20 }, (_, index) => job(`durable-${index + 1}`))
    jobListRef.value = sourceLists.group.slice(0, 15)
    pagerNext.mockReturnValue(false)
    deliverJobListHandle.mockImplementationOnce(async (items) => {
      expect(durableTaskState.value?.checkpoint?.activeBatch?.items).toEqual(
        items.map(({ source, item }: any) => ({ source, encryptJobId: item.encryptJobId })),
      )
      markBatchProcessed(items)
      common.deliverStop = true
      return 'stopped'
    })

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')
    await startButton!.trigger('click')
    await vi.waitFor(() => expect(deliverJobListHandle).toHaveBeenCalledTimes(1))
  })

  it('retries a waiting page run without another runtime-ready event', async () => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
    })
    sourceLists.group = Array.from({ length: 20 }, (_, index) => job(`waiting-${index + 1}`))
    jobListRef.value = sourceLists.group.slice(0, 15)
    pagerNext.mockReturnValue(false)
    deliverJobListHandle.mockResolvedValueOnce('stopped').mockImplementationOnce(async (items) => {
      markBatchProcessed(items)
      common.deliverStop = true
      return 'stopped'
    })

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')
    await startButton!.trigger('click')
    await vi.waitFor(() => expect(deliverJobListHandle).toHaveBeenCalledTimes(1))
    expect(durableTaskState.value).toMatchObject({ status: 'waiting-for-page' })

    await vi.advanceTimersByTimeAsync(5_000)
    await vi.waitFor(() => expect(deliverJobListHandle).toHaveBeenCalledTimes(2))
  })

  it('reports only the still-deliverable jobs in the active batch summary', async () => {
    sourceLists.group = Array.from({ length: 20 }, (_, index) => job(`summary-${index + 1}`))
    jobListRef.value = sourceLists.group.slice(0, 15)
    pagerNext.mockReturnValue(false)
    deliverJobListHandle.mockImplementationOnce(async (items) => {
      items[0].item.status.status = 'success'
      common.deliverStop = true
      return 'stopped'
    })

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')
    await startButton!.trigger('click')
    await vi.waitFor(() =>
      expect(logInfo).toHaveBeenCalledWith(
        '投递批次',
        expect.stringContaining('"pendingActiveBatch":9'),
      ),
    )
  })

  it('holds one run owner while resume waits so manual start cannot run concurrently', async () => {
    actualSource.value = 'group'
    visibleSource.value = 'group'
    jobListRef.value = []
    sourceLists.group = []
    let releaseResumeWait!: () => void
    delayMock.mockImplementationOnce(
      async () =>
        new Promise<undefined>((resolve) => {
          releaseResumeWait = () => resolve(undefined)
        }),
    )
    deliverJobListHandle.mockImplementationOnce(async (items) => {
      markBatchProcessed(items)
      common.deliverStop = true
      return 'stopped'
    })
    window.sessionStorage.setItem(
      'agent-delivery:combined-delivery-task',
      JSON.stringify({
        accountUid: 'account-a',
        id: 'resume-owner-task',
        startedAt: Date.now(),
        currentIndex: 0,
        steps: [
          {
            source: 'group',
            url: 'https://www.zhipin.com/web/geek/jobs',
            status: 'pending',
            pagesDone: 0,
            resumeNavigationAttempt: {
              at: Date.now() - 1000,
              fromUrl: 'https://www.zhipin.com/web/geek/job?query=AI',
              targetUrl: 'https://www.zhipin.com/web/geek/jobs',
            },
          },
        ],
      }),
    )
    registerStoredTask()

    const wrapper = mount(OperationPanel)
    await flushPromises()

    expect(common.deliverLock).toBe(true)
    // 后台正在等待页面恢复时仍保留运行所有权，但页面不应把等待误报成「投递中」，
    // 也不应暴露暂停或重新开始入口。
    const buttonTexts = wrapper.findAll('button').map((button) => button.text())
    expect(buttonTexts).toContain('等待中')
    expect(buttonTexts).not.toContain('暂停')
    expect(buttonTexts).not.toContain('开始投递')

    jobListRef.value = [job('resume-job')]
    releaseResumeWait()
    for (let i = 0; i < 6; i++) await flushPromises()

    expect(deliverJobListHandle).toHaveBeenCalledTimes(1)
  })

  it('does not navigate to a saved target source without an internal navigation marker', async () => {
    actualSource.value = 'group'
    visibleSource.value = 'search'
    jobListRef.value = [job('group-page-first')]
    getDeliveryLimit.mockImplementation((_, source) => (source === 'search' ? 18 : 12))
    window.history.replaceState({}, '', '/web/geek/jobs?salary=406')
    window.sessionStorage.setItem(
      'agent-delivery:combined-delivery-task',
      JSON.stringify({
        accountUid: 'account-a',
        id: 'resume-search-task-on-group-page',
        startedAt: Date.now(),
        currentIndex: 1,
        steps: [
          {
            source: 'group',
            url: 'https://www.zhipin.com/web/geek/jobs?salary=406',
            status: 'waiting',
            pagesDone: 1,
          },
          {
            source: 'search',
            url: 'https://www.zhipin.com/web/geek/job?query=AI',
            status: 'pending',
            pagesDone: 0,
          },
        ],
      }),
    )

    mount(OperationPanel)
    await flushPromises()
    await flushPromises()

    expect(deliverJobListHandle).not.toHaveBeenCalled()
    expect(routerPush).not.toHaveBeenCalled()
    expect(window.sessionStorage.getItem('agent-delivery:combined-delivery-task')).toBeNull()
  })

  it('records a pending navigation when rotating to another source', async () => {
    actualSource.value = 'group'
    visibleSource.value = 'group'
    getDeliveryLimit.mockImplementation((_, source) => (source === 'search' ? 18 : 12))
    deliverJobListHandle.mockImplementationOnce(async (items) => {
      markBatchProcessed(items)
      return 'completed'
    })
    window.history.replaceState({}, '', '/web/geek/jobs?salary=406')
    window.sessionStorage.setItem(
      'agent-delivery:combined-delivery-task',
      JSON.stringify({
        accountUid: 'account-a',
        id: 'rotate-from-group-to-search',
        startedAt: Date.now(),
        currentIndex: 0,
        steps: [
          {
            source: 'group',
            url: 'https://www.zhipin.com/web/geek/jobs?salary=406',
            status: 'running',
            pagesDone: 0,
            resumeNavigationAttempt: {
              at: Date.now() - 1000,
              fromUrl: 'https://www.zhipin.com/web/geek/job?query=AI',
              targetUrl: 'https://www.zhipin.com/web/geek/jobs?salary=406',
            },
          },
          {
            source: 'search',
            url: 'https://www.zhipin.com/web/geek/job?query=AI',
            status: 'pending',
            pagesDone: 0,
          },
        ],
      }),
    )
    registerStoredTask()

    mount(OperationPanel)
    await flushPromises()
    await flushPromises()

    const task = JSON.parse(
      window.sessionStorage.getItem('agent-delivery:combined-delivery-task') ?? '{}',
    )
    expect(task.currentIndex).toBe(1)
    expect(task.steps[1].resumeNavigationAttempt).toMatchObject({
      fromUrl: 'http://localhost:3000/web/geek/jobs?salary=406',
      targetUrl: 'https://www.zhipin.com/web/geek/job?query=AI',
    })
    expect(routerPush).toHaveBeenCalledWith('/web/geek/job?query=AI')
  })

  it('does not navigate when stop is requested while mixed-source switch state is flushing', async () => {
    actualSource.value = 'group'
    visibleSource.value = 'group'
    getDeliveryLimit.mockImplementation((_, source) => (source === 'search' ? 18 : 12))
    deliverJobListHandle.mockImplementationOnce(async (items) => {
      markBatchProcessed(items)
      return 'completed'
    })
    window.history.replaceState({}, '', '/web/geek/jobs?salary=406')
    const flush = createDeferred()
    statistics.flush.mockReturnValue(flush.promise)

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')
    await startButton!.trigger('click')
    await vi.waitFor(() => expect(statistics.flush).toHaveBeenCalled())

    common.deliverStop = true
    flush.resolve()
    for (let i = 0; i < 6; i++) await flushPromises()

    expect(routerPush).not.toHaveBeenCalled()
  })

  it('does not push a route when stop is requested while the SPA router is resolving', async () => {
    actualSource.value = 'group'
    visibleSource.value = 'group'
    getDeliveryLimit.mockImplementation((_, source) => (source === 'search' ? 18 : 12))
    window.history.replaceState({}, '', '/web/geek/jobs?salary=406')
    const routerReady = createDeferred<any>()
    getRootVueMock.mockReturnValue(routerReady.promise)

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')
    await startButton!.trigger('click')
    await vi.waitFor(() => expect(getRootVueMock).toHaveBeenCalled())

    common.deliverStop = true
    routerReady.resolve({ $router: { push: routerPush } })
    for (let i = 0; i < 6; i++) await flushPromises()

    expect(routerPush).not.toHaveBeenCalled()
  })

  it('does not restore a cleared task when stop is requested while router push is pending', async () => {
    actualSource.value = 'group'
    visibleSource.value = 'group'
    getDeliveryLimit.mockImplementation((_, source) => (source === 'search' ? 18 : 12))
    window.history.replaceState({}, '', '/web/geek/jobs?salary=406')
    const navigation = createDeferred()
    routerPush.mockReturnValue(navigation.promise)

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')
    await startButton!.trigger('click')
    await vi.waitFor(() => expect(routerPush).toHaveBeenCalled())

    common.deliverStop = true
    window.sessionStorage.clear()
    navigation.resolve()
    for (let i = 0; i < 6; i++) await flushPromises()

    expect(window.sessionStorage.getItem('agent-delivery:combined-delivery-task')).toBeNull()
  })

  it('does not navigate when stop is requested while source rotation state is flushing', async () => {
    actualSource.value = 'group'
    visibleSource.value = 'group'
    getDeliveryLimit.mockImplementation((_, source) => (source === 'search' ? 18 : 12))
    sourceLists.group = []
    sourceLists.search = Array.from({ length: 10 }, (_, index) => job(`search-${index + 1}`))
    pagerNext.mockReturnValue(false)
    deliverJobListHandle.mockImplementationOnce(async (items) => {
      markBatchProcessed(items)
      return 'completed'
    })
    window.history.replaceState({}, '', '/web/geek/jobs?salary=406')
    const flush = createDeferred()
    statistics.flush.mockReturnValue(flush.promise)

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')
    await startButton!.trigger('click')
    await vi.waitFor(() => expect(statistics.flush).toHaveBeenCalled())

    common.deliverStop = true
    flush.resolve()
    for (let i = 0; i < 6; i++) await flushPromises()

    expect(routerPush).not.toHaveBeenCalled()
  })

  it('does not navigate when stop is requested while step completion state is flushing', async () => {
    actualSource.value = 'group'
    visibleSource.value = 'group'
    getDeliveryLimit.mockImplementation((_, source) => (source === 'search' ? 18 : 12))
    sourceLists.group = []
    sourceLists.search = Array.from({ length: 10 }, (_, index) => job(`search-${index + 1}`))
    pagerNext.mockReturnValue(false)
    deliverJobListHandle.mockImplementationOnce(async (items) => {
      markBatchProcessed(items)
      return 'sourceLimit'
    })
    window.history.replaceState({}, '', '/web/geek/jobs?salary=406')
    const flush = createDeferred()
    statistics.flush.mockReturnValue(flush.promise)

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')
    await startButton!.trigger('click')
    await vi.waitFor(() => expect(statistics.flush).toHaveBeenCalled())

    common.deliverStop = true
    flush.resolve()
    for (let i = 0; i < 6; i++) await flushPromises()

    expect(routerPush).not.toHaveBeenCalled()
  })

  it('does not navigate when stop is requested while mismatched-source state is flushing', async () => {
    actualSource.value = 'group'
    visibleSource.value = 'group'
    getDeliveryLimit.mockImplementation((_, source) => (source === 'group' ? 10 : 0))
    window.history.replaceState({}, '', '/web/geek/jobs?salary=406')
    resetBatchPace.mockImplementationOnce(() => {
      actualSource.value = 'search'
      visibleSource.value = 'search'
      window.history.replaceState({}, '', '/web/geek/job?query=AI')
    })
    const flush = createDeferred()
    statistics.flush.mockReturnValue(flush.promise)

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')
    await startButton!.trigger('click')
    await vi.waitFor(() => expect(statistics.flush).toHaveBeenCalled())

    common.deliverStop = true
    flush.resolve()
    for (let i = 0; i < 6; i++) await flushPromises()

    expect(routerPush).not.toHaveBeenCalled()
  })

  it('clears a page-only navigation task without background authority', async () => {
    actualSource.value = 'group'
    visibleSource.value = 'search'
    jobListRef.value = [job('group-page-first')]
    getDeliveryLimit.mockImplementation((_, source) => (source === 'search' ? 18 : 12))
    window.history.replaceState({}, '', '/web/geek/job?query=AI')
    window.sessionStorage.setItem(
      'agent-delivery:combined-delivery-task',
      JSON.stringify({
        accountUid: 'account-a',
        id: 'resume-search-task-redirected-back',
        startedAt: Date.now(),
        currentIndex: 1,
        steps: [
          {
            source: 'group',
            url: 'https://www.zhipin.com/web/geek/jobs?salary=406',
            status: 'waiting',
            pagesDone: 1,
          },
          {
            source: 'search',
            url: 'https://www.zhipin.com/web/geek/job?query=AI',
            status: 'pending',
            pagesDone: 0,
            resumeNavigationAttempt: {
              at: Date.now() - 1000,
              fromUrl: 'https://www.zhipin.com/web/geek/jobs?salary=406',
              targetUrl: 'https://www.zhipin.com/web/geek/job?query=AI',
            },
          },
        ],
      }),
    )
    mount(OperationPanel)
    await flushPromises()
    await flushPromises()

    expect(deliverJobListHandle).not.toHaveBeenCalled()
    expect(window.sessionStorage.getItem('agent-delivery:combined-delivery-task')).toBeNull()
  })

  it('does not trust a recent page-only navigation marker without background authority', async () => {
    actualSource.value = 'group'
    visibleSource.value = 'search'
    jobListRef.value = [job('group-page-first')]
    getDeliveryLimit.mockImplementation((_, source) => (source === 'search' ? 18 : 12))
    window.history.replaceState({}, '', '/web/geek/jobs?salary=406')
    window.sessionStorage.setItem(
      'agent-delivery:combined-delivery-task',
      JSON.stringify({
        accountUid: 'account-a',
        id: 'resume-search-task-navigation-pending',
        startedAt: Date.now(),
        currentIndex: 1,
        steps: [
          {
            source: 'group',
            url: 'https://www.zhipin.com/web/geek/jobs?salary=406',
            status: 'waiting',
            pagesDone: 1,
          },
          {
            source: 'search',
            url: 'https://www.zhipin.com/web/geek/job?query=AI',
            status: 'pending',
            pagesDone: 0,
            resumeNavigationAttempt: {
              at: Date.now() - 1000,
              fromUrl: 'https://www.zhipin.com/web/geek/jobs?salary=406',
              targetUrl: 'https://www.zhipin.com/web/geek/job?query=AI',
            },
          },
        ],
      }),
    )

    mount(OperationPanel)
    await flushPromises()
    await flushPromises()

    expect(deliverJobListHandle).not.toHaveBeenCalled()
    expect(window.sessionStorage.getItem('agent-delivery:combined-delivery-task')).toBeNull()
  })

  it('prefetches the next page before the first batch when only one source is enabled', async () => {
    getDeliveryLimit.mockImplementation((_, source) => (source === 'search' ? 0 : 12))
    sourceSuccesses.group = 0
    sourceSuccesses.search = 12
    let handleCalls = 0
    deliverJobListHandle.mockImplementation(async (items) => {
      markBatchProcessed(items)
      handleCalls += 1
      if (visibleSource.value === 'group') sourceSuccesses.group += 6
      if (visibleSource.value === 'search') sourceSuccesses.search += 6
      if (handleCalls === 2) {
        common.deliverStop = true
        return 'stopped'
      }
      return 'completed'
    })
    pagerNext.mockImplementation(() => {
      pagerNextAttempt.value += 1
      if (pagerNextAttempt.value === 1) {
        jobListRef.value = [job('group-page-2-first')]
        return true
      }
      return false
    })

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')

    expect(startButton).toBeDefined()
    await startButton!.trigger('click')
    for (let i = 0; i < 6; i++) {
      await flushPromises()
    }

    expect(pagerNext).toHaveBeenCalled()
    expect(deliverJobListHandle).toHaveBeenCalledTimes(1)
    expect(logInfo).toHaveBeenCalledWith('投递批次', expect.stringContaining('投递池首次补充完成'))
    expect(sourceLists.group.some((item) => item.encryptJobId === 'group-page-2-first')).toBe(true)
  })

  it('switches enabled expectations inside the existing group workflow without route changes', async () => {
    jobSourcesConfig.value = {
      searchEnabled: false,
      recommendEnabled: false,
      enabledExpectIds: ['101', '202'],
      expectationsInitialized: true,
    }
    getUserResumeData.mockResolvedValue({
      expectList: [
        {
          id: '101',
          positionType: 0,
          positionName: 'AI 产品经理',
          locationName: '上海',
          salaryDesc: '30-50K',
        },
        {
          id: '202',
          positionType: 0,
          positionName: '产品负责人',
          locationName: '杭州',
          salaryDesc: '40-60K',
        },
      ],
    })
    const firstJob = { ...job('expect-101-job'), expectId: 101 }
    const secondJob = { ...job('expect-202-job'), expectId: 202 }
    jobListRef.value = [firstJob]
    sourceLists.group = [firstJob, secondJob]
    getDeliveryLimit.mockImplementation((_, source) => (source === 'group' ? 10 : 0))
    deliverJobListHandle
      .mockImplementationOnce(async (items) => {
        markBatchProcessed(items)
        return 'completed'
      })
      .mockImplementationOnce(async (items) => {
        markBatchProcessed(items)
        common.deliverStop = true
        return 'stopped'
      })

    const expectationRoot = document.createElement('div')
    expectationRoot.className = 'c-expect-select'
    expectationRoot.innerHTML = `
      <div class="expect-list">
        <button class="expect-item active" data-expect-id="101">
          <span class="text-content">AI 产品经理（上海）</span>
        </button>
        <button class="expect-item" data-expect-id="202">
          <span class="text-content">产品负责人（杭州）</span>
        </button>
      </div>
    `
    const [firstOption, secondOption] = Array.from(
      expectationRoot.querySelectorAll<HTMLElement>('.expect-item'),
    )
    secondOption.addEventListener('click', () => {
      firstOption.classList.remove('active')
      secondOption.classList.add('active')
      jobListRef.value = [secondJob]
    })
    const secondClick = vi.spyOn(secondOption, 'click')
    document.body.appendChild(expectationRoot)

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')
    await startButton!.trigger('click')
    for (let index = 0; index < 10; index++) await flushPromises()

    expect(getUserResumeData).toHaveBeenCalled()
    expect(setAvailableJobExpectations).toHaveBeenCalled()
    expect(confPersist).toHaveBeenCalled()
    expect(secondClick).toHaveBeenCalledOnce()
    expect(deliverJobListHandle).toHaveBeenCalled()
    expect(routerPush).not.toHaveBeenCalled()
    expect(logInfo).toHaveBeenCalledWith('投递批次', expect.stringContaining('正在切换求职期望'))
  })

  it('switches to the native recommendation group and keeps it inside the group quota', async () => {
    jobSourcesConfig.value = {
      searchEnabled: false,
      recommendEnabled: true,
      enabledExpectIds: [],
      expectationsInitialized: true,
    }
    const expectationJob = { ...job('expectation-job'), expectId: 101 }
    const recommendationJob = { ...job('recommendation-job'), expectId: 0 }
    jobListRef.value = [expectationJob]
    sourceLists.group = [expectationJob, recommendationJob]
    getDeliveryLimit.mockImplementation((_, source) => (source === 'group' ? 10 : 0))
    deliverJobListHandle.mockImplementationOnce(async (items) => {
      markBatchProcessed(items)
      common.deliverStop = true
      return 'stopped'
    })

    const expectationRoot = document.createElement('div')
    expectationRoot.className = 'c-expect-select'
    expectationRoot.innerHTML = `
      <button class="synthesis">推荐</button>
      <div class="expect-list">
        <button class="expect-item active" data-expect-id="101">AI 产品经理（上海）</button>
      </div>
    `
    const recommendationOption = expectationRoot.querySelector<HTMLElement>('.synthesis')!
    const expectationOption = expectationRoot.querySelector<HTMLElement>('.expect-item')!
    recommendationOption.addEventListener('click', () => {
      expectationOption.classList.remove('active')
      recommendationOption.classList.add('active')
      jobListRef.value = [recommendationJob]
    })
    const recommendationClick = vi.spyOn(recommendationOption, 'click')
    document.body.appendChild(expectationRoot)

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')
    await startButton!.trigger('click')
    for (let index = 0; index < 8; index++) await flushPromises()

    expect(getUserResumeData).not.toHaveBeenCalled()
    expect(recommendationClick).toHaveBeenCalledOnce()
    expect(deliverJobListHandle).toHaveBeenCalledOnce()
    expect(logInfo).toHaveBeenCalledWith(
      '投递批次',
      expect.stringContaining('"expectId":"recommend"'),
    )
  })

  it('migrates the legacy group source to the currently active real expectation', async () => {
    jobSourcesConfig.value = {
      searchEnabled: false,
      recommendEnabled: false,
      enabledExpectIds: [],
      expectationsInitialized: false,
    }
    getUserResumeData.mockResolvedValue({
      expectList: [
        {
          id: '101',
          positionType: 0,
          positionName: 'AI 产品经理',
          locationName: '上海',
          salaryDesc: '30-50K',
        },
        {
          id: '202',
          positionType: 0,
          positionName: '产品负责人',
          locationName: '杭州',
          salaryDesc: '40-60K',
        },
      ],
    })
    const currentJob = { ...job('expect-202-job'), expectId: 202 }
    jobListRef.value = [currentJob]
    sourceLists.group = [currentJob]
    getDeliveryLimit.mockImplementation((_, source) => (source === 'group' ? 10 : 0))
    deliverJobListHandle.mockImplementationOnce(async (items) => {
      markBatchProcessed(items)
      common.deliverStop = true
      return 'stopped'
    })

    const expectationRoot = document.createElement('div')
    expectationRoot.className = 'c-expect-select'
    expectationRoot.innerHTML = `
      <div class="expect-list">
        <button class="expect-item" data-expect-id="101">AI 产品经理（上海）</button>
        <button class="expect-item active" data-expect-id="202">产品负责人（杭州）</button>
      </div>
    `
    document.body.appendChild(expectationRoot)

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')
    await startButton!.trigger('click')
    for (let index = 0; index < 8; index++) await flushPromises()

    expect(jobSourcesConfig.value).toEqual({
      searchEnabled: false,
      recommendEnabled: false,
      enabledExpectIds: ['202'],
      expectationsInitialized: true,
    })
    // 期望初始化与任务构造已拆成两步，各自读取一次平台期望列表；
    // 关键是最终写入的启用项正确，调用次数是实现细节。
    expect(setAvailableJobExpectations).toHaveBeenCalled()
    expect(setAvailableJobExpectations).toHaveBeenLastCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: '202' })]),
    )
    expect(confPersist).toHaveBeenCalled()
    expect(deliverJobListHandle).toHaveBeenCalledOnce()
    expect(logInfo).toHaveBeenCalledWith('投递批次', expect.stringContaining('"expectId":"202"'))
  })

  /**
   * 后台在投递任务登记后会拒绝一切运行配置写入。补池换轮若尝试写配置，
   * 保存失败会冒泡成任务级错误，把整个投递任务终止。换轮路径必须保持纯读。
   */
  function mountWithRunningTaskAwaitingRefill() {
    jobSourcesConfig.value = {
      searchEnabled: false,
      recommendEnabled: false,
      enabledExpectIds: ['101'],
      expectationsInitialized: true,
    }
    getDeliveryLimit.mockImplementation((_, source) => (source === 'group' ? 10 : 0))
    // 岗位列表非空（否则恢复流程会卡在 waitForJobListReady），但列表里只剩已投递
    // 的岗位，getDeliverableJobs 会把它们全部滤掉。运行循环因此判定该来源无岗位
    // 可投，经 finishCurrentStep 进入补池换轮（restartAcquisitionCycle）。
    pagerNext.mockReturnValue(false)
    const deliveredJob = job('already-delivered')
    deliveredJob.status.setStatus('success', '投递成功')
    jobListRef.value = [deliveredJob]
    sourceLists.group = [deliveredJob]
    sourceLists.search = []
    const checkpoint = {
      accountUid: 'account-a',
      id: 'refill-task',
      startedAt: clock.now - 60_000,
      currentIndex: 0,
      acquisitionCycle: 1,
      cycleStartedSuccess: 0,
      noProgressCycles: 0,
      poolWarmup: { completed: true, attemptedStepIndexes: [0], lowWaterArmed: true },
      runtimeHeartbeat: { at: clock.now - 1_000, source: 'group' },
      steps: [
        {
          source: 'group',
          url: 'https://www.zhipin.com/web/geek/jobs',
          status: 'running',
          pagesDone: 1,
          prefetchExhausted: true,
        },
      ],
    }
    durableTaskState.value = {
      schemaVersion: 1,
      accountUid: 'account-a',
      runId: checkpoint.id,
      status: 'running',
      checkpoint,
      configSnapshot: currentConfigSnapshot(),
      startedAt: checkpoint.startedAt,
      updatedAt: clock.now - 1_000,
      revision: 4,
    }
    return mount(OperationPanel)
  }

  it('never writes runtime config while a registered task refills the pool', async () => {
    getUserResumeData.mockResolvedValue({
      expectList: [
        {
          id: '101',
          positionType: 0,
          positionName: 'AI 产品经理',
          locationName: '上海',
          salaryDesc: '30-50K',
        },
      ],
    })

    mountWithRunningTaskAwaitingRefill()
    for (let index = 0; index < 12; index++) await flushPromises()

    // 先确认确实走到了补池换轮，否则下面的断言会 vacuously 通过。
    expect(logInfo).toHaveBeenCalledWith(
      '投递批次',
      expect.stringContaining('当前投递池已处理完，准备补充下一轮岗位'),
    )
    // 换轮只读取平台期望，不得触碰运行配置。
    expect(confPersist).not.toHaveBeenCalled()
    // 后台任务被判成 failed 即表示走了 terminal-error 终止路径。
    expect(durableTaskState.value?.status).not.toBe('failed')
  })

  it('keeps a registered task alive when refill preparation fails', async () => {
    // 读简历失败属于来源边界内的临时故障，应重试而不是终止整个任务。
    getUserResumeData.mockRejectedValue(new Error('求职期望读取失败'))

    mountWithRunningTaskAwaitingRefill()
    for (let index = 0; index < 12; index++) await flushPromises()

    expect(durableTaskState.value?.status).not.toBe('failed')
    expect(durableTaskState.value?.terminalReason).toBeUndefined()
    expect(logInfo).toHaveBeenCalledWith(
      '投递批次',
      expect.stringContaining('本轮取岗准备失败，任务保持运行并稍后重试'),
    )
  })

  it('warns before starting when extension storage is near its quota', async () => {
    // 配额写满后投递记录、投递池和统计都会停止落盘，而所有失败路径都是降级继续，
    // 用户不会看到硬报错。因此必须在开始投递前提醒。
    storageUsageMock.mockResolvedValueOnce({
      bytesInUse: 9 * 1024 * 1024,
      quotaBytes: 10 * 1024 * 1024,
    })
    resetStorageQuotaNotice()

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')
    await startButton!.trigger('click')
    for (let index = 0; index < 6; index++) await flushPromises()

    expect(logInfo).toHaveBeenCalledWith(
      '投递批次',
      expect.stringContaining('扩展本地存储接近上限'),
    )
  })

  it('resumes a task whose steps are all done instead of killing it', async () => {
    // 换轮瞬间 currentIndex 会越过步骤边界。若此时刷新页面，恢复路径以前把这个
    // 状态判成任务级错误并清除任务；它应当与运行循环一致，视为「该补池换轮」。
    jobSourcesConfig.value = {
      searchEnabled: false,
      recommendEnabled: false,
      enabledExpectIds: ['101'],
      expectationsInitialized: true,
    }
    getDeliveryLimit.mockImplementation((_, source) => (source === 'group' ? 10 : 0))
    getUserResumeData.mockResolvedValue({
      expectList: [
        {
          id: '101',
          positionType: 0,
          positionName: 'AI 产品经理',
          locationName: '上海',
          salaryDesc: '30-50K',
        },
      ],
    })
    const checkpoint = {
      accountUid: 'account-a',
      id: 'boundary-task',
      startedAt: clock.now - 60_000,
      // 越过唯一步骤，getCurrentTaskStep 返回 undefined。
      currentIndex: 1,
      acquisitionCycle: 1,
      cycleStartedSuccess: 0,
      noProgressCycles: 0,
      poolWarmup: { completed: true, attemptedStepIndexes: [0], lowWaterArmed: true },
      runtimeHeartbeat: { at: clock.now - 1_000, source: 'group' },
      steps: [
        {
          source: 'group',
          url: 'https://www.zhipin.com/web/geek/jobs',
          status: 'done',
          pagesDone: 1,
        },
      ],
    }
    durableTaskState.value = {
      schemaVersion: 1,
      accountUid: 'account-a',
      runId: checkpoint.id,
      status: 'running',
      checkpoint,
      configSnapshot: currentConfigSnapshot(),
      startedAt: checkpoint.startedAt,
      updatedAt: clock.now - 1_000,
      revision: 4,
    }

    mount(OperationPanel)
    for (let index = 0; index < 12; index++) await flushPromises()

    expect(durableTaskState.value?.status).not.toBe('failed')
    expect(durableTaskState.value?.terminalReason).toBeUndefined()
    expect(logInfo).toHaveBeenCalledWith(
      '投递批次',
      expect.stringContaining('当前轮次已处理完，继续补充下一轮岗位'),
    )
  })

  it('rotates by source order instead of successful delivery ratio', async () => {
    actualSource.value = 'group'
    visibleSource.value = 'group'
    window.history.replaceState({}, '', '/web/geek/jobs?salary=406')
    getDeliveryLimit.mockImplementation((_, source) => (source === 'search' ? 60 : 40))
    sourceSuccesses.group = 0
    sourceSuccesses.search = 55
    sourceLists.group = [job('group-current')]
    sourceLists.search = Array.from({ length: 20 }, (_, index) => job(`search-${index + 1}`))
    pagerNext.mockReturnValue(false)
    deliverJobListHandle.mockImplementationOnce(async (items) => {
      markBatchProcessed(items)
      return 'completed'
    })

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')

    await startButton!.trigger('click')
    for (let i = 0; i < 8; i++) {
      await flushPromises()
    }

    expect(routerPush).toHaveBeenCalledWith('/web/geek/job?query=AI')
    expect(logInfo).not.toHaveBeenCalledWith(
      '投递批次',
      expect.stringContaining('按成功配比调整下一来源'),
    )
  })

  it('consumes the oldest FIFO jobs without rebuilding a source ratio', async () => {
    actualSource.value = 'group'
    visibleSource.value = 'group'
    getDeliveryLimit.mockImplementation((_, source) => (source === 'search' ? 60 : 40))
    sourceLists.group = Array.from({ length: 40 }, (_, index) => job(`group-${index + 1}`))
    sourceLists.search = Array.from({ length: 60 }, (_, index) => job(`search-${index + 1}`))
    deliverJobListHandle.mockImplementationOnce(async (items) => {
      markBatchProcessed(items)
      expect(items.map((item: any) => item.source)).toEqual(
        Array.from({ length: 10 }, () => 'group'),
      )
      common.deliverStop = true
      return 'stopped'
    })

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')

    await startButton!.trigger('click')
    await flushPromises()
    await flushPromises()

    expect(deliverJobListHandle).toHaveBeenCalledTimes(1)
    expect(routerPush).not.toHaveBeenCalled()
    expect(logInfo).toHaveBeenCalledWith(
      '投递批次',
      expect.stringContaining('投递池 FIFO 批次启动'),
    )
  })

  it('switches to replenish a non-current source only after the whole pool falls below low water', async () => {
    actualSource.value = 'search'
    visibleSource.value = 'search'
    window.history.replaceState({}, '', '/web/geek/job?query=AI')
    getDeliveryLimit.mockImplementation((_, source) => (source === 'group' ? 20 : 80))
    sourceLists.group = Array.from({ length: 20 }, (_, index) => job(`group-${index + 1}`))
    sourceLists.search = Array.from({ length: 80 }, (_, index) => job(`search-${index + 1}`))
    jobListRef.value = sourceLists.search.slice(0, 15)
    deliverJobListHandle.mockImplementationOnce(async (items) => {
      markBatchProcessed(items)
      return 'completed'
    })
    let deliveryCallsAtRefill = -1
    pagerNext.mockImplementationOnce(() => {
      deliveryCallsAtRefill = deliverJobListHandle.mock.calls.length
      pagerNextAttempt.value += 1
      jobListRevision.value += 1
      jobListRef.value = Array.from({ length: 80 }, (_, index) => job(`search-refill-${index + 1}`))
      return true
    })
    routerPush.mockImplementationOnce(async (route?: string) => {
      expect(deliveryCallsAtRefill).toBeGreaterThan(0)
      expect(deliverJobListHandle).toHaveBeenCalledTimes(deliveryCallsAtRefill)
      actualSource.value = 'group'
      visibleSource.value = 'group'
      window.history.replaceState({}, '', route)
      common.deliverStop = true
    })

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')

    await startButton!.trigger('click')
    for (let index = 0; index < 12; index++) await flushPromises()

    expect(routerPush).toHaveBeenCalledWith('/web/geek/jobs')
    expect(deliverJobListHandle.mock.calls.length).toBeGreaterThan(1)
    expect(logInfo).toHaveBeenCalledWith(
      '投递批次',
      expect.stringContaining('投递池低水位触发整轮补充'),
    )
  })

  it('does not retry the same mixed-source batch after a heartbeat failure', async () => {
    actualSource.value = 'group'
    visibleSource.value = 'group'
    getDeliveryLimit.mockImplementation((_, source) => (source === 'search' ? 60 : 40))
    sourceLists.group = Array.from({ length: 40 }, (_, index) => job(`group-${index + 1}`))
    sourceLists.search = Array.from({ length: 60 }, (_, index) => job(`search-${index + 1}`))
    deliverJobListHandle.mockRejectedValueOnce(
      new Error('Provider unavailable: heartbeat check timeout 30000ms.'),
    )

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')

    await startButton!.trigger('click')
    for (let i = 0; i < 8; i++) await flushPromises()

    expect(deliverJobListHandle).toHaveBeenCalledTimes(1)
    expect(logInfo).toHaveBeenCalledWith(
      '投递批次',
      expect.stringContaining('投递任务运行时通信异常：保留任务等待重连'),
    )
  })

  it('continues the task after SPA switching to a missing source when the target source becomes ready', async () => {
    actualSource.value = 'group'
    visibleSource.value = 'group'
    window.history.replaceState({}, '', '/web/geek/jobs?salary=406')
    getDeliveryLimit.mockImplementation((_, source) => (source === 'search' ? 60 : 40))
    const exhaustedGroupJob = job('group-current-exhausted')
    exhaustedGroupJob.status.status = 'success'
    exhaustedGroupJob.status.msg = 'done'
    jobListRef.value = [exhaustedGroupJob]
    sourceLists.group = []
    sourceLists.search = []
    pagerNext.mockReturnValue(false)
    routerPush.mockImplementationOnce(async () => {
      actualSource.value = 'search'
      visibleSource.value = 'search'
      window.history.replaceState({}, '', '/web/geek/job?query=AI')
      const searchJobs = Array.from({ length: 20 }, (_, index) => job(`search-${index + 1}`))
      sourceLists.search = searchJobs
      jobListRef.value = searchJobs
    })
    deliverJobListHandle.mockImplementationOnce(async (items) => {
      markBatchProcessed(items)
      expect(items).toHaveLength(10)
      common.deliverStop = true
      return 'stopped'
    })

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')

    await startButton!.trigger('click')
    for (let i = 0; i < 10; i++) {
      await flushPromises()
    }

    expect(routerPush).toHaveBeenCalledWith('/web/geek/job?query=AI')
    expect(pagerReload).toHaveBeenCalledWith(1)
    expect(deliverJobListHandle).toHaveBeenCalledTimes(1)
    expect(logInfo).toHaveBeenCalledWith(
      '投递批次',
      expect.stringContaining('来源切换后目标来源已就绪'),
    )
  })

  it('attributes jobs loaded after SPA switching to the target source pool before mixed batching', async () => {
    actualSource.value = 'group'
    visibleSource.value = 'group'
    autoMergeOnInit.value = true
    window.history.replaceState({}, '', '/web/geek/jobs?salary=406')
    getDeliveryLimit.mockImplementation((_, source) => (source === 'search' ? 60 : 40))
    const exhaustedGroupJob = job('group-current-exhausted')
    exhaustedGroupJob.status.status = 'success'
    exhaustedGroupJob.status.msg = 'done'
    jobListRef.value = [exhaustedGroupJob]
    sourceLists.group = []
    sourceLists.search = []
    pagerNext.mockReturnValue(false)
    routerPush.mockImplementationOnce(async () => {
      actualSource.value = 'search'
      visibleSource.value = 'group'
      window.history.replaceState({}, '', '/web/geek/jobs?query=AI')
      jobListRef.value = Array.from({ length: 15 }, (_, index) => job(`search-${index + 1}`))
    })
    deliverJobListHandle.mockImplementationOnce(async (items) => {
      markBatchProcessed(items)
      expect(items.map((item: any) => item.source)).toEqual(
        Array.from({ length: 10 }, () => 'search'),
      )
      common.deliverStop = true
      return 'stopped'
    })

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')

    await startButton!.trigger('click')
    for (let i = 0; i < 12; i++) {
      await flushPromises()
    }

    expect(setDeliveryLimitSourceOverride).toHaveBeenCalledWith('search')
    expect(deliverJobListHandle).toHaveBeenCalledTimes(1)
    expect(logInfo).toHaveBeenCalledWith(
      '投递批次',
      expect.stringContaining('投递池 FIFO 批次启动'),
    )
  })

  it('consumes the existing search pool before forcing a search-direction switch', async () => {
    actualSource.value = 'search'
    visibleSource.value = 'search'
    window.history.replaceState({}, '', '/web/geek/jobs?query=AIGC')
    getDeliveryLimit.mockImplementation((_, source) => (source === 'search' ? 60 : 0))
    sourceLists.group = []
    sourceLists.search = Array.from({ length: 100 }, (_, index) => job(`search-pool-${index + 1}`))
    jobListRef.value = Array.from({ length: 15 }, (_, index) => job(`search-seed-${index + 1}`))
    deliverJobListHandle.mockImplementationOnce(async (items) => {
      markBatchProcessed(items)
      expect(items?.map((item: any) => item.source)).toEqual(
        Array.from({ length: 10 }, () => 'search'),
      )
      common.deliverStop = true
      return 'stopped'
    })

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')

    await startButton!.trigger('click')
    for (let i = 0; i < 10; i++) {
      await flushPromises()
    }

    expect(deliverJobListHandle).toHaveBeenCalledTimes(1)
    expect(logInfo).toHaveBeenCalledWith(
      '投递批次',
      expect.stringContaining('投递池 FIFO 批次启动'),
    )
    expect(routerPush).not.toHaveBeenCalled()
  })

  it('keeps the same run alive when switching from one search direction to another', async () => {
    actualSource.value = 'search'
    visibleSource.value = 'search'
    window.history.replaceState({}, '', '/web/geek/jobs?query=AIGC')
    getDeliveryLimit.mockImplementation((_, source) => (source === 'search' ? 60 : 0))
    sourceLists.group = []
    sourceLists.search = []
    const staleJob = job('stale-search-page')
    staleJob.status.status = 'success'
    staleJob.status.msg = 'done'
    jobListRef.value = [staleJob]
    routerPush.mockImplementationOnce(async () => {
      actualSource.value = 'search'
      visibleSource.value = 'search'
      window.history.replaceState({}, '', '/web/geek/job?query=AI')
      jobListRef.value = Array.from({ length: 15 }, (_, index) => job(`search-next-${index + 1}`))
    })
    deliverJobListHandle.mockImplementationOnce(async (items) => {
      markBatchProcessed(items)
      expect(items?.map((item: any) => item.source)).toEqual(
        Array.from({ length: 10 }, () => 'search'),
      )
      common.deliverStop = true
      return 'stopped'
    })

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')

    await startButton!.trigger('click')
    for (let i = 0; i < 12; i++) {
      await flushPromises()
    }

    expect(routerPush).toHaveBeenCalledTimes(1)
    expect(deliverJobListHandle).toHaveBeenCalledTimes(1)
    expect(logInfo).toHaveBeenCalledWith(
      '投递批次',
      expect.stringContaining('来源切换后目标来源已就绪'),
    )
    expect(logInfo).toHaveBeenCalledWith(
      '投递批次',
      expect.stringContaining('投递池 FIFO 批次启动'),
    )
  })

  it('prefetches the current source pool during startup before consuming an incomplete pool', async () => {
    actualSource.value = 'group'
    visibleSource.value = 'group'
    getDeliveryLimit.mockImplementation((_, source) => (source === 'search' ? 60 : 40))
    sourceLists.group = Array.from({ length: 5 }, (_, index) => job(`group-seed-${index + 1}`))
    sourceLists.search = Array.from({ length: 30 }, (_, index) => job(`search-seed-${index + 1}`))
    pagerNext.mockImplementationOnce(() => {
      pagerNextAttempt.value += 1
      const pageJobs = Array.from({ length: 15 }, (_, index) => job(`group-prefetch-${index + 1}`))
      sourceLists.group = [...sourceLists.group, ...pageJobs]
      jobListRef.value = pageJobs
      return true
    })
    deliverJobListHandle
      .mockImplementationOnce(async (items) => {
        markBatchProcessed(items)
        return 'completed'
      })
      .mockImplementationOnce(async (items) => {
        markBatchProcessed(items)
        common.deliverStop = true
        return 'stopped'
      })

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')

    await startButton!.trigger('click')
    for (let i = 0; i < 10; i++) {
      await flushPromises()
    }

    expect(pagerNext).toHaveBeenCalled()
    expect(logInfo).toHaveBeenCalledWith('投递批次', expect.stringContaining('投递池首次补充开始'))
  })

  it('captures a changed page into the active source pool before declaring growth', async () => {
    actualSource.value = 'group'
    visibleSource.value = 'group'
    autoMergeOnInit.value = false
    window.history.replaceState({}, '', '/web/geek/jobs?salary=406')
    getDeliveryLimit.mockImplementation((_, source) => (source === 'search' ? 60 : 40))
    sourceLists.group = Array.from({ length: 5 }, (_, index) => job(`group-seed-${index + 1}`))
    sourceLists.search = []
    pagerNext.mockImplementationOnce(() => {
      pagerNextAttempt.value += 1
      jobListRef.value = [job('page-changed-but-pool-not-merged')]
      return true
    })

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')

    await startButton!.trigger('click')
    for (let i = 0; i < 10; i++) {
      await flushPromises()
    }

    expect(logInfo).toHaveBeenCalledWith(
      '分页诊断',
      expect.stringContaining('混合投递池下一页已进入投递池'),
    )
    expect(
      sourceLists.group.some((item) => item.encryptJobId === 'page-changed-but-pool-not-merged'),
    ).toBe(true)
  })

  it('captures jobs appended by the next page while the first job stays unchanged', async () => {
    const { counter } = await import('@/message')
    actualSource.value = 'group'
    visibleSource.value = 'group'
    autoMergeOnInit.value = false
    window.history.replaceState({}, '', '/web/geek/jobs?salary=406')
    getDeliveryLimit.mockImplementation((_, source) => (source === 'search' ? 0 : 100))
    const firstPageJobs = Array.from({ length: 15 }, (_, index) => job(`group-page-1-${index + 1}`))
    const secondPageJobs = Array.from({ length: 15 }, (_, index) =>
      job(`group-page-2-${index + 1}`),
    )
    jobListRef.value = firstPageJobs
    sourceLists.group = []
    sourceLists.search = []
    pagerNext.mockImplementation(() => {
      pagerNextAttempt.value += 1
      if (pagerNextAttempt.value > 1) return false
      pagerPage.value = { page: 2, pageSize: 15 }
      jobListRevision.value += 1
      jobListRef.value = [...firstPageJobs, ...secondPageJobs]
      return true
    })
    deliverJobListHandle.mockImplementationOnce(async (items) => {
      expect(items).toHaveLength(10)
      expect(items.every((entry: any) => entry.source === 'group')).toBe(true)
      markBatchProcessed(items)
      common.deliverStop = true
      return 'stopped'
    })

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')

    await startButton!.trigger('click')
    await vi.waitFor(() => expect(deliverJobListHandle).toHaveBeenCalledTimes(1))

    expect(jobListRef.value[0]?.encryptJobId).toBe('group-page-1-1')
    expect(
      secondPageJobs.every((item) =>
        sourceLists.group.some((poolItem) => poolItem.encryptJobId === item.encryptJobId),
      ),
    ).toBe(true)
    expect(counter.deliveryTaskTerminate).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'terminal-error' }),
    )
  })

  it('continues with search jobs when the current expectation page times out', async () => {
    const { counter } = await import('@/message')
    actualSource.value = 'group'
    visibleSource.value = 'group'
    autoMergeOnInit.value = false
    window.history.replaceState({}, '', '/web/geek/jobs?salary=406')
    getDeliveryLimit.mockImplementation((_, source) => (source === 'search' ? 50 : 50))
    const groupJobs = Array.from({ length: 5 }, (_, index) => job(`group-seed-${index + 1}`))
    const searchJobs = Array.from({ length: 29 }, (_, index) => job(`search-seed-${index + 1}`))
    jobListRef.value = groupJobs
    sourceLists.group = [...groupJobs]
    sourceLists.search = [...searchJobs]
    pagerNext.mockImplementation(() => {
      pagerNextAttempt.value += 1
      return pagerNextAttempt.value === 1
    })
    routerPush.mockImplementationOnce(async (route?: string) => {
      actualSource.value = 'search'
      visibleSource.value = 'search'
      window.history.replaceState({}, '', route)
      pagerPage.value = { page: 1, pageSize: 15, total: searchJobs.length }
      jobListRevision.value += 1
      jobListRef.value = searchJobs.slice(0, 15)
    })
    deliverJobListHandle.mockImplementationOnce(async (items) => {
      expect(items.some((entry: any) => entry.source === 'search')).toBe(true)
      markBatchProcessed(items)
      common.deliverStop = true
      return 'stopped'
    })

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')

    await startButton!.trigger('click')
    await vi.waitFor(() => expect(deliverJobListHandle).toHaveBeenCalledTimes(1))

    expect(logInfo).toHaveBeenCalledWith(
      '投递批次',
      expect.stringContaining('投递池首次补充跳过：来源翻页加载失败'),
    )
    expect(counter.deliveryTaskTerminate).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'terminal-error' }),
    )
  })

  it('continues with expectation jobs when the current search page times out', async () => {
    const { counter } = await import('@/message')
    actualSource.value = 'search'
    visibleSource.value = 'search'
    autoMergeOnInit.value = false
    window.history.replaceState({}, '', '/web/geek/job?query=AI')
    getDeliveryLimit.mockImplementation((_, source) => (source === 'search' ? 50 : 50))
    const searchJobs = Array.from({ length: 5 }, (_, index) => job(`search-seed-${index + 1}`))
    const groupJobs = Array.from({ length: 29 }, (_, index) => job(`group-seed-${index + 1}`))
    jobListRef.value = searchJobs
    sourceLists.search = [...searchJobs]
    sourceLists.group = [...groupJobs]
    pagerNext.mockImplementation(() => {
      pagerNextAttempt.value += 1
      return pagerNextAttempt.value === 1
    })
    routerPush.mockImplementationOnce(async (route?: string) => {
      actualSource.value = 'group'
      visibleSource.value = 'group'
      window.history.replaceState({}, '', route)
      pagerPage.value = { page: 1, pageSize: 15, total: groupJobs.length }
      jobListRevision.value += 1
      jobListRef.value = groupJobs.slice(0, 15)
    })
    deliverJobListHandle.mockImplementationOnce(async (items) => {
      expect(items.some((entry: any) => entry.source === 'group')).toBe(true)
      markBatchProcessed(items)
      common.deliverStop = true
      return 'stopped'
    })

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')

    await startButton!.trigger('click')
    await vi.waitFor(() => expect(deliverJobListHandle).toHaveBeenCalledTimes(1))

    expect(logInfo).toHaveBeenCalledWith(
      '投递批次',
      expect.stringContaining('投递池首次补充跳过：来源翻页加载失败'),
    )
    expect(counter.deliveryTaskTerminate).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'terminal-error' }),
    )
  })

  it('attempts every underfilled source before consuming an incomplete startup pool', async () => {
    actualSource.value = 'group'
    visibleSource.value = 'group'
    window.history.replaceState({}, '', '/web/geek/jobs?salary=406')
    getDeliveryLimit.mockImplementation((_, source) => (source === 'search' ? 60 : 40))
    sourceLists.group = Array.from({ length: 5 }, (_, index) => job(`group-seed-${index + 1}`))
    sourceLists.search = []
    pagerNext.mockImplementation(() => {
      pagerNextAttempt.value += 1
      const pageJobs = Array.from({ length: 15 }, (_, index) =>
        job(`group-prefetch-${pagerNextAttempt.value}-${index + 1}`),
      )
      sourceLists.group = [...sourceLists.group, ...pageJobs]
      jobListRef.value = pageJobs
      return true
    })
    routerPush.mockImplementationOnce(async (route?: string) => {
      actualSource.value = 'search'
      visibleSource.value = 'search'
      window.history.replaceState({}, '', route)
      pagerPage.value = { page: 1, pageSize: 15, total: 0 } as any
      jobListRef.value = []
    })
    deliverJobListHandle.mockImplementationOnce(async (items) => {
      markBatchProcessed(items)
      expect(items.length).toBeGreaterThan(0)
      expect(items.map((item: any) => item.source)).toEqual(
        Array.from({ length: items.length }, () => 'group'),
      )
      common.deliverStop = true
      return 'stopped'
    })

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')

    await startButton!.trigger('click')
    await vi.waitFor(() => expect(deliverJobListHandle).toHaveBeenCalledTimes(1))

    // search 的缺口更大，预热先尝试 search；当前 group 不再因为“正好在这页”插队。
    expect(pagerNext).not.toHaveBeenCalled()
    expect(routerPush).toHaveBeenCalledWith('/web/geek/job?query=AI')
    expect(logInfo).toHaveBeenCalledWith('投递批次', expect.stringContaining('投递池首次补充完成'))
    expect(logInfo).toHaveBeenCalledWith(
      '投递批次',
      expect.stringContaining('混合投递池切换来源补充'),
    )
  })

  it('does not deliver 29 search jobs until the enabled group source has been attempted', async () => {
    actualSource.value = 'search'
    visibleSource.value = 'search'
    window.history.replaceState({}, '', '/web/geek/job?query=AI')
    getDeliveryLimit.mockImplementation((_, source) => (source === 'search' ? 50 : 50))
    sourceLists.search = Array.from({ length: 29 }, (_, index) => job(`search-${index + 1}`))
    sourceLists.group = []
    jobListRef.value = sourceLists.search.slice(0, 15)
    pagerNext.mockReturnValue(false)
    routerPush.mockImplementationOnce(async (route?: string) => {
      expect(deliverJobListHandle).not.toHaveBeenCalled()
      actualSource.value = 'group'
      visibleSource.value = 'group'
      window.history.replaceState({}, '', route)
      jobListRef.value = Array.from({ length: 15 }, (_, index) => job(`group-${index + 1}`))
    })
    deliverJobListHandle.mockImplementationOnce(async (items) => {
      expect(routerPush).toHaveBeenCalledWith('/web/geek/jobs')
      expect(items.some((item: any) => item.source === 'group')).toBe(true)
      markBatchProcessed(items)
      common.deliverStop = true
      return 'stopped'
    })

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')

    await startButton!.trigger('click')
    for (let i = 0; i < 12; i++) {
      await flushPromises()
    }

    expect(routerPush).toHaveBeenCalledWith('/web/geek/jobs')
    expect(deliverJobListHandle).toHaveBeenCalledTimes(1)
    expect(logInfo).toHaveBeenCalledWith(
      '投递批次',
      expect.stringContaining('"completionReason":"source-round-complete"'),
    )
  })

  it('keeps a group step retryable when its native expectation control is temporarily missing', async () => {
    actualSource.value = 'search'
    visibleSource.value = 'search'
    window.history.replaceState({}, '', '/web/geek/job?query=AI')
    jobSourcesConfig.value = {
      searchEnabled: true,
      recommendEnabled: false,
      enabledExpectIds: ['101'],
      expectationsInitialized: true,
    }
    getUserResumeData.mockResolvedValue({
      expectList: [
        {
          id: '101',
          positionType: 0,
          positionName: 'AI 产品经理',
          locationName: '上海',
          salaryDesc: '30-50K',
        },
      ],
    })
    getDeliveryLimit.mockImplementation(() => 50)
    const searchJobs = Array.from({ length: 29 }, (_, index) => job(`search-${index + 1}`))
    sourceLists.search = [...searchJobs]
    sourceLists.group = []
    jobListRef.value = searchJobs.slice(0, 15)
    pagerNext.mockReturnValue(false)
    routerPush.mockImplementation(async (route?: string) => {
      window.history.replaceState({}, '', route)
      if (route?.includes('/web/geek/job?')) {
        actualSource.value = 'search'
        visibleSource.value = 'search'
        pagerPage.value = { page: 1, pageSize: 15, total: searchJobs.length }
        jobListRevision.value += 1
        jobListRef.value = searchJobs.slice(0, 15)
        return
      }
      actualSource.value = 'group'
      visibleSource.value = 'group'
      pagerPage.value = { page: 1, pageSize: 15 }
      jobListRef.value = []
    })
    deliverJobListHandle.mockImplementationOnce(async (items) => {
      expect(items.every((item: any) => item.source === 'search')).toBe(true)
      markBatchProcessed(items)
      common.deliverStop = true
      return 'stopped'
    })

    const wrapper = mount(OperationPanel)
    const startButton = wrapper.findAll('button').find((button) => button.text() === '开始投递')

    await startButton!.trigger('click')
    await vi.waitFor(() => expect(deliverJobListHandle).toHaveBeenCalledTimes(1))

    const checkpoint = JSON.parse(
      window.sessionStorage.getItem('agent-delivery:combined-delivery-task') ?? 'null',
    )
    const groupStep = checkpoint.steps.find((step: any) => step.source === 'group')
    expect(groupStep).toMatchObject({ status: 'waiting', prefetchExhausted: false })
    expect(groupStep.prefetchRetryAt).toEqual(expect.any(Number))
    expect(groupStep.prefetchRetryAt).toBeGreaterThan(checkpoint.startedAt)
    expect(logInfo).toHaveBeenCalledWith(
      '投递批次',
      expect.stringContaining('当前取岗步骤暂时不可用，保留并稍后自动重试'),
    )
  })
})
