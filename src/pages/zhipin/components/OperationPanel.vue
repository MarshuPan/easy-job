<script lang="ts" setup>
import { Pause, Play, RotateCcw, Square } from 'lucide-vue-next'
import { computed, onMounted, onUnmounted, ref } from 'vue'

import type {
  DeliveryTaskActivePhase,
  DeliveryTaskTerminalReason,
  DurableDeliveryTask,
} from '@/background/deliveryTaskCoordinator'
import { DELIVERY_WORKER_LEASE_MS } from '@/background/deliveryTaskCoordinator'
import { sameCompanyKey, sameHrKey } from '@/composables/useApplying/utils'
import { useCommon } from '@/composables/useCommon'
import { useStatistics } from '@/composables/useStatistics'
import { getRootVue } from '@/composables/useVue'
import { decideAcquisition } from '@/delivery/acquisition/decide'
import {
  buildDeliveryConfigSnapshot,
  buildDeliveryQueueConfigScope,
  parseDeliveryConfigSnapshot,
  type DeliveryConfigSnapshot,
} from '@/delivery/configSnapshot'
import { counter, probeExtensionRuntimeHealth } from '@/message'
import { useConf } from '@/stores/conf'
import { jobList, type MyJobListData } from '@/stores/jobs'
import { useLog } from '@/stores/log'
import { useUser } from '@/stores/user'
import { AgentButton, AgentMessage } from '@/ui/instrument'
import { delay, getCurDay } from '@/utils'
import { createAccountStorageKey } from '@/utils/accountStorage'
import { acquireBossAction } from '@/utils/actionGateStore'
import { startBackgroundKeepAlive } from '@/utils/backgroundKeepAlive'
import {
  ExtensionRuntimeHealthError,
  getExtensionRuntimeHealthDiagnostic,
} from '@/utils/extensionRuntimeHealth'
import { sampleHumanDelayMs } from '@/utils/humanPace'
import { logger } from '@/utils/logger'
import {
  getProviderHeartbeatDiagnostic,
  isExtensionContextInvalidatedError,
  isProviderHeartbeatError,
} from '@/utils/providerHealth'
import { buildBossSearchUrls } from '@/utils/searchConditions'
import {
  formatStorageBytes,
  isStorageQuotaError,
  isStorageUsageOverSoftLimit,
  shouldReportStorageQuota,
  STORAGE_QUOTA_ERROR_MESSAGE,
} from '@/utils/storageQuota'

import { useDeliver } from '../hooks/useDeliver'
import { usePager } from '../hooks/usePager'
import {
  buildDeliveryDashboard,
  buildDeliveryTaskTitle,
  type DeliveryFailureCategoryId,
} from '../utils/deliveryDashboard'
import {
  createPoolAdmission,
  type DeliveredKeys,
  explainImpossibleDelivery,
  sameCompanyPoolQuota,
} from '../utils/deliveryDedupe'
import {
  findNextTaskStepIndexBySource,
  getDeliverableJobs,
  getDeliveryJobKey,
  getDeliveryJobOrder,
  getDeliveryJobSource,
  getTaskStepLabel,
  hasPrefetchableStep,
  isSameNavigationLocation,
  isSameTaskStep,
  summarizePools,
  summarizeTaskSteps,
} from '../utils/deliveryEngine'
import {
  DAILY_DELIVERY_LIMIT,
  getDeliveryLimit,
  getDeliveryLimitSuccess,
  hasDailyDeliveryRemaining,
  setRiskAdjustedDailyLimit,
  inferDeliveryLimitSource,
  setDeliveryLimitSourceOverride,
  type DeliveryLimitSource,
} from '../utils/deliveryLimit'
import {
  buildDeliveryBatchPlan,
  canCaptureIntoDeliveryPool,
  dedupeDeliverySourcePools,
  selectDeliveryBatch,
} from '../utils/deliveryQueue'
import {
  advanceDeliveryTaskCycleProgress,
  clearDeliveryTask,
  createDeliveryTask,
  DELIVERY_TASK_HEARTBEAT_INTERVAL_MS,
  DELIVERY_TASK_HEARTBEAT_MAX_AGE_MS,
  DELIVERY_TASK_MAX_EMPTY_CYCLES,
  findNextWarmupStepIndex,
  getFreshDeliveryTaskHeartbeat,
  hasReachedDeliveryTaskEmptyCycleLimit,
  getCurrentTaskStep,
  getDefaultGroupUrl,
  markCurrentStepDone,
  readDeliveryTask,
  restoreDeliveryTask,
  rotateToNextTaskStep,
  saveDeliveryTask,
  touchDeliveryTaskHeartbeat,
  type DeliveryTask,
} from '../utils/deliveryTask'
import {
  extractJobExpectations,
  filterJobsByGroupTargets,
  findNativeJobExpectationOption,
  getEnabledJobExpectations,
  getExpectationLabel,
  getInitialJobExpectation,
  getJobGroupTargetId,
  getJobSourceLabel,
  getRecommendationJobExpectation,
  isGroupExpectationListReady,
  isRecommendationExpectation,
  readNativeJobExpectationOptions,
  type JobExpectation,
} from '../utils/jobExpectations'
import { diffJobListSnapshot, type JobListSnapshot } from '../utils/jobListDelta'
import {
  decideRiskBackoff,
  getRiskAdjustedDailyLimit,
  readTodayRecord,
  riskBackoffKey,
} from '../utils/riskBackoff'
import operationPanelRuntimeStyles from './OperationPanel.styles.css.txt?raw'

const conf = useConf()
const common = useCommon()
const deliver = useDeliver()
const log = useLog()
const pager = usePager()
const { initPager, next, page } = pager
const statistics = useStatistics()
const user = useUser()
const { todayData } = statistics
const currentLocalDate = ref(getCurDay())
const emit = defineEmits<{
  (event: 'open-settings'): void
  (event: 'show-search'): void
  (event: 'show-group'): void
  (event: 'show-logs'): void
}>()

const builtInDeliveryStartDelay = 8
/**
 * 翻页间隔：中位数与 p90（秒）。
 *
 * 精确到毫秒的等周期翻页本身就是机器特征，比间隔短更容易被认出来。取重尾分布而不是
 * 固定值加均匀抖动：大部分翻页比中位数还快，偶尔一次很慢——这既是真人的形状，
 * 均值也低于原来固定的 60 秒。
 */
const builtInDeliveryPageNextTypicalSeconds = 45
const builtInDeliveryPageNextP90Seconds = 90
const builtInDeliveryPageLoadTimeoutMs = 30_000
const builtInDeliveryPageRuntimeRefreshIntervalMs = 5000
const resumeNavigationPendingTimeoutMs = 15000
const deliveryQueueBatchSize = 10
const deliveryPoolBatchTargetSize = 100
const sourcePoolMaxLowWaterMark = 20
const sourcePoolPrefetchMaxPages = 1
const sourcePoolPrefetchPageTimeoutMs = 30_000
const deliveryReconnectRetryMs = 5_000
const dailyDeliveryLimit = DAILY_DELIVERY_LIMIT
const sourceLabelMap: Record<DeliveryLimitSource, string> = {
  group: '求职期望',
  search: '搜索',
}
const deliveryRuntimeInstanceId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const failureCategoryHintMap: Record<DeliveryFailureCategoryId, string> = {
  jobFit: 'JD 筛选',
  hardFilter: '条件规则',
  dedupe: '公司 / HR',
  activity: '活跃 / 猎头',
  publish: '可重试',
  aiGreeting: 'AI 生成',
}
const operationPanelRuntimeStyleId = 'agent-delivery-operation-panel-runtime-style'
const statisticsRefreshIntervalMs = 60_000
// Keep critical panel layout in JS so overwrite-style extension updates cannot leave new DOM with stale scoped CSS.
const aiGreetingStatus = computed(() =>
  getExecutionFormData().aiGreeting.enable && conf.formData.aiGreeting.enable ? '已开启' : '未开启',
)
function getDeliveryQueueSnapshot() {
  void jobList.deliveryQueueRevision
  if (typeof jobList.readDeliveryQueueSnapshot === 'function') {
    return jobList.readDeliveryQueueSnapshot()
  }
  return {
    sources: {
      group: jobList.listBySource('group'),
      search: jobList.listBySource('search'),
    },
  }
}
let resumeDeliveryTaskPromise: Promise<void> | null = null
type DeliveryRunToken = symbol
let activeRunToken: DeliveryRunToken | null = null
/** 当前执行阶段，仅用于后台检查点上报。 */
let activePhase: DeliveryTaskActivePhase = 'acquiring'
const deliveryWorkerStorageKey = 'agent-delivery:worker-id'
const durableDeliveryTask = ref<DurableDeliveryTask | null>(null)
const activeDeliveryConfigSnapshot = ref<DeliveryConfigSnapshot | null>(null)
const deliveryWorkerSessionToken = getOrCreateDeliveryWorkerSessionToken()
let deliveryWorkerIdPromise: Promise<string> | null = null
/**
 * 本次运行的终止原因。这四种情况互斥且有优先级，以前是四个独立布尔，
 * 退出时再用一串三元把它们推导回一个原因——那个推导才是真正的状态，这里直接持有它。
 */
type DeliveryStopReason =
  | 'manual-stop'
  | 'manual-pause'
  | 'ai-unavailable'
  | 'daily-limit'
  | 'terminal-error'
  | 'runtime-reconnect'
  | 'risk-control'
  | 'rate-limited'
// manual-pause 与 runtime-reconnect 同属「中断循环但保留任务」，区别只在于恢复由用户触发，
// 因此优先级排在 manual-stop 之下：结束是终态，暂停不能盖过它。
const stopReasonPriority: Record<DeliveryStopReason, number> = {
  // 风控优先级最高：任何别的停止理由都不该盖过它，否则会被当成可自动恢复的中断。
  'risk-control': 6,
  // 冷却保留任务并自动恢复，优先级与手动暂停同级。
  'rate-limited': 4,
  'manual-stop': 5,
  'manual-pause': 4,
  // 模型不可用与手动暂停同属「保留任务」，都要能靠「继续」接着跑。
  'ai-unavailable': 4,
  'daily-limit': 3,
  'terminal-error': 2,
  'runtime-reconnect': 1,
}
let stopReason: DeliveryStopReason | null = null
let terminalFailureMessage: string | null = null
/**
 * 未拿到后台执行权（另一个标签页正在跑）。它不是「停止原因」——本次运行根本没有开始，
 * 因此不并入 stopReason：并入会让「已停止」与「未开始」在退出处理上互相污染。
 */
let workerOwnershipBlocked = false

function requestDeliveryStop(reason: DeliveryStopReason, message?: string) {
  if (stopReason == null || stopReasonPriority[reason] > stopReasonPriority[stopReason]) {
    stopReason = reason
  }
  if (reason === 'terminal-error') terminalFailureMessage ??= message ?? '投递任务发生运行错误'
}
let scheduledDeliveryResumeTimer: number | undefined
let boundBossRuntimeVue: unknown
const searchRotationStorageKey = 'local:web-geek-job-SearchRotation'

interface SearchRotationState {
  nextDirectionKey: string
}

function getOrCreateDeliveryWorkerSessionToken() {
  const existing = window.sessionStorage.getItem(deliveryWorkerStorageKey)
  if (existing != null && /^[A-Za-z0-9-]{8,80}$/.test(existing)) return existing
  const randomId =
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
  window.sessionStorage.setItem(deliveryWorkerStorageKey, randomId)
  return randomId
}

function getDeliveryWorkerId() {
  deliveryWorkerIdPromise ??= counter
    .deliveryWorkerIdentity(deliveryWorkerSessionToken)
    .catch((error) => {
      deliveryWorkerIdPromise = null
      throw error
    })
  return deliveryWorkerIdPromise
}

function acquireDeliveryRun(owner: 'manual' | 'resume', _runId?: string) {
  if (common.deliverLock || activeRunToken != null) return null
  const token = Symbol(owner)
  activeRunToken = token
  activePhase = 'acquiring'
  common.deliverLock = true
  common.deliverStop = false
  stopReason = null
  terminalFailureMessage = null
  workerOwnershipBlocked = false
  return token
}

function ownsDeliveryRun(token: DeliveryRunToken) {
  return activeRunToken === token
}

function canContinueDeliveryRun(token: DeliveryRunToken) {
  return ownsDeliveryRun(token) && stopReason == null && !common.deliverStop
}

function setDeliveryPhase(token: DeliveryRunToken, phase: DeliveryTaskActivePhase) {
  if (ownsDeliveryRun(token)) activePhase = phase
}

function releaseDeliveryRun(token: DeliveryRunToken) {
  if (!ownsDeliveryRun(token)) return
  activeRunToken = null
  common.deliverLock = false
  jobList.setDeliveryPoolCaptureEnabled(false)
}
const progressPercentage = computed(() =>
  Number(((todayData.success / dailyDeliveryLimit) * 100).toFixed(1)),
)
const dedupeStatus = computed(() => {
  const formData = getExecutionFormData()
  const items = []
  if (formData.sameCompanyFilter.value) items.push('同公司')
  if (formData.sameHrFilter.value) items.push('同HR')
  return items.length === 0 ? '未开启' : items.join(' + ')
})
const dashboard = computed(() =>
  buildDeliveryDashboard({
    dailyLimit: dailyDeliveryLimit,
    pools: {
      group: getConfiguredSourcePool('group'),
      search: getConfiguredSourcePool('search'),
    },
    records: log.data.value,
    targetDate: currentLocalDate.value,
    todayData,
    weights: {
      group: getConfiguredSourceWeight('group'),
      search: getConfiguredSourceWeight('search'),
    },
  }),
)
const taskTitle = computed(() =>
  buildDeliveryTaskTitle(
    deliver.currentData?.jobName,
    isDeliveryActive.value || isDeliveryPaused.value,
  ),
)
const deliveryPaceText = computed(
  () =>
    `${getExecutionFormData().delay.deliveryInterval}-${getExecutionFormData().delay.deliveryIntervalMax} 秒随机`,
)
const batchRestText = computed(
  () =>
    `${getExecutionFormData().delay.batchSize} 个 / ${getExecutionFormData().delay.batchRestMinutes} 分钟`,
)
const currentSourceText = computed(() => sourceLabelMap[inferDeliveryLimitSource()])
const hasDurableRunningTask = computed(() => {
  const status = durableDeliveryTask.value?.status
  return status === 'running' || status === 'waiting-for-page'
})
const isDeliveryActive = computed(
  () => (common.deliverLock && !common.deliverStop) || hasDurableRunningTask.value,
)
const isDeliveryPaused = computed(
  () => !isDeliveryActive.value && durableDeliveryTask.value?.status === 'paused',
)
const runState = computed(() => {
  if (isDeliveryActive.value) return { label: '投递中', type: 'success' as const }
  if (isDeliveryPaused.value) return { label: '已暂停', type: 'warning' as const }
  if (durableDeliveryTask.value?.status === 'failed')
    return { label: '运行出错', type: 'warning' as const }
  if (durableDeliveryTask.value?.status === 'completed')
    return { label: '今日已完成', type: 'success' as const }
  if (common.deliverStop || durableDeliveryTask.value?.status === 'stopped')
    return { label: '已停止', type: 'warning' as const }
  return { label: '待启动', type: 'warning' as const }
})
const sourceDashboardRows = computed(() => dashboard.value.sourceRows)
const activeFailureCategories = computed(() =>
  dashboard.value.failureCategories.filter((item) => item.count > 0),
)
const sourcePoolCompositionText = computed(
  () =>
    `求职期望 ${formatPercent(dashboard.value.sources.group.targetPercent)} / 搜索 ${formatPercent(dashboard.value.sources.search.targetPercent)}`,
)
const compactStatusItems = computed(() =>
  [
    sourcePoolCompositionText.value,
    `AI 筛选 ${getExecutionFormData().aiFiltering.enable ? `≥ ${getExecutionFormData().aiFiltering.score}%` : '未开启'}`,
    `招呼语${getExecutionFormData().aiGreeting.enable && conf.formData.aiGreeting.enable ? '开启' : '关闭'}`,
    `节奏 ${deliveryPaceText.value}`,
    `批休 ${batchRestText.value}`,
    `去重 ${dedupeStatus.value}`,
  ].filter(Boolean),
)
const instrumentProgressStyle = computed(() => ({
  '--delivery-progress': `${Math.min(100, Math.max(0, progressPercentage.value))}%`,
}))
const queueContinuationText = computed(() => {
  if (dashboard.value.summary.pending > 0) return '当前投递池可继续'
  if (dashboard.value.summary.retryableFailures > 0) return '可重试任务待处理'
  return dashboard.value.summary.fetched > 0 ? '等待任务启动' : '等待获取岗位'
})
const heroStatusText = computed(() => {
  if (isDeliveryActive.value) return `${currentSourceText.value}来源 · 投递流程运行中`
  if (isDeliveryPaused.value) return `${currentSourceText.value}来源 · 已暂停，可继续或结束本轮`
  if (common.deliverStop || durableDeliveryTask.value?.status === 'stopped')
    return `${currentSourceText.value}来源 · 任务已停止`
  const poolState = dashboard.value.summary.fetched > 0 ? '投递池已就绪' : '等待获取岗位'
  return `${currentSourceText.value}来源 · ${poolState} · 下一步：JD 筛选`
})
const taskSequence = computed(() => {
  const running = isDeliveryActive.value
  const attentionCount = activeFailureCategories.value.reduce(
    (total, item) => total + item.count,
    0,
  )
  return [
    {
      number: '01',
      label: '获取岗位',
      description: dashboard.value.summary.fetched > 0 ? '投递池已就绪' : '等待获取岗位',
      state: dashboard.value.summary.fetched > 0 ? 'complete' : 'current',
    },
    {
      number: '02',
      label: 'JD 筛选',
      description: running
        ? '投递流程正在筛选'
        : common.deliverStop
          ? '流程已暂停'
          : '等待任务启动',
      state: running ? 'current' : 'idle',
    },
    {
      number: '03',
      label: '生成招呼语',
      description: `AI 能力${aiGreetingStatus.value}`,
      state:
        running && getExecutionFormData().aiGreeting.enable && conf.formData.aiGreeting.enable
          ? 'current'
          : 'idle',
    },
    {
      number: '04',
      label: '建立沟通',
      description: running ? '投递流程运行中' : '平台接口待调用',
      state: running ? 'current' : 'idle',
    },
    {
      number: '!',
      label: '需要关注',
      description: attentionCount > 0 ? `异常 / 过滤 ${attentionCount} 条` : '当前没有异常归因',
      state: attentionCount > 0 ? 'warning' : 'idle',
    },
  ] as const
})

let statisticsRefreshTimer: number | undefined
let statisticsRefreshDisabled = false
let statisticsReadyForDelivery = false

onMounted(() => {
  statisticsRefreshDisabled = false
  jobList.setDeliveryPoolCaptureEnabled(false)
  ensureOperationPanelRuntimeStyles()
  window.addEventListener('agent-delivery:job-runtime-ready', handleRuntimeReady)
  window.addEventListener('focus', handleStatisticsFocus)
  document.addEventListener('visibilitychange', handleStatisticsVisibilityChange)
  statisticsRefreshTimer = window.setInterval(requestStatisticsRefresh, statisticsRefreshIntervalMs)
  void (async () => {
    await refreshStatisticsForCurrentDate()
    try {
      await resumeDeliveryTask('mounted')
    } catch (error) {
      logger.warn('读取后台投递任务失败，等待运行时恢复后重试', error)
    }
  })()
})

/**
 * 投递运行期间保住 background service worker。
 *
 * 长等待（限速、AI 请求、翻页）期间没有任何 RPC，worker 空闲 30 秒就被回收，
 * 之后写检查点会以心跳超时失败，岗位状态落不了盘。详见 utils/backgroundKeepAlive.ts。
 */
let backgroundKeepAlive: { stop: () => void } | undefined

function beginBackgroundKeepAlive() {
  backgroundKeepAlive?.stop()
  backgroundKeepAlive = startBackgroundKeepAlive(() => counter.backgroundTest('success'))
}

function endBackgroundKeepAlive() {
  backgroundKeepAlive?.stop()
  backgroundKeepAlive = undefined
}

onUnmounted(() => {
  window.removeEventListener('agent-delivery:job-runtime-ready', handleRuntimeReady)
  if (scheduledDeliveryResumeTimer != null) {
    window.clearTimeout(scheduledDeliveryResumeTimer)
    scheduledDeliveryResumeTimer = undefined
  }
  endBackgroundKeepAlive()
  stopStatisticsRefresh()
})

function stopStatisticsRefresh() {
  window.removeEventListener('focus', handleStatisticsFocus)
  document.removeEventListener('visibilitychange', handleStatisticsVisibilityChange)
  if (statisticsRefreshTimer != null) {
    window.clearInterval(statisticsRefreshTimer)
    statisticsRefreshTimer = undefined
  }
}

async function refreshStatisticsForCurrentDate() {
  if (statisticsRefreshDisabled) return false
  currentLocalDate.value = getCurDay()
  try {
    await statistics.updateStatistics()
    statisticsReadyForDelivery = true
    return true
  } catch (error) {
    statisticsReadyForDelivery = false
    if (isExtensionContextInvalidatedError(error)) {
      statisticsRefreshDisabled = true
      common.deliverStop = true
      stopStatisticsRefresh()
      return false
    }
    logger.warn('刷新当日统计失败，已保留当前页面内存统计', error)
    return false
  } finally {
    currentLocalDate.value = getCurDay()
  }
}

function requestStatisticsRefresh() {
  if (statisticsRefreshDisabled) return
  void refreshStatisticsForCurrentDate()
}

function handleStatisticsFocus() {
  requestStatisticsRefresh()
}

function handleStatisticsVisibilityChange() {
  if (document.visibilityState === 'visible') requestStatisticsRefresh()
}

function handleRuntimeReady() {
  void (async () => {
    try {
      statisticsRefreshDisabled = false
      window.addEventListener('focus', handleStatisticsFocus)
      document.addEventListener('visibilitychange', handleStatisticsVisibilityChange)
      if (statisticsRefreshTimer == null) {
        statisticsRefreshTimer = window.setInterval(
          requestStatisticsRefresh,
          statisticsRefreshIntervalMs,
        )
      }
      await resumeDeliveryTask('runtime-ready')
    } catch (error) {
      logger.warn('插件运行时恢复后读取投递任务失败', error)
    }
  })()
}

function ensureOperationPanelRuntimeStyles() {
  if (document.getElementById(operationPanelRuntimeStyleId)) return
  const style = document.createElement('style')
  style.id = operationPanelRuntimeStyleId
  style.textContent = operationPanelRuntimeStyles
  document.head.appendChild(style)
}

function formatPercent(value: number) {
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`
}

function formatInstrumentNumber(value: number, digits: number) {
  return String(value).padStart(digits, '0')
}

function getConfiguredSourceWeight(source: DeliveryLimitSource) {
  const formData = getExecutionFormData()
  const sourceConfig = formData.jobSources
  if (sourceConfig == null) return getDeliveryLimit(formData, source)
  if (
    source === 'search' &&
    (!sourceConfig.searchEnabled || formData.searchConditions?.directions.length === 0)
  ) {
    return 0
  }
  if (
    source === 'group' &&
    sourceConfig.expectationsInitialized &&
    sourceConfig.enabledExpectIds.length === 0 &&
    sourceConfig.recommendEnabled === false
  ) {
    return 0
  }
  return getDeliveryLimit(formData, source)
}

function getConfiguredSourcePool(source: DeliveryLimitSource) {
  const jobs = getDeliveryQueueSnapshot().sources[source]
  const sourceConfig = getExecutionFormData().jobSources
  if (sourceConfig == null) return jobs
  if (source === 'search') {
    return sourceConfig.searchEnabled ? jobs : []
  }
  if (!sourceConfig.expectationsInitialized) return jobs
  return filterJobsByGroupTargets(
    jobs,
    sourceConfig.enabledExpectIds,
    sourceConfig.recommendEnabled !== false,
  )
}

/**
 * 已投递过的公司与 HR。入池预判要用，但读取是异步的，而抓取页面是同步的，
 * 所以在每次补池之前刷新一份快照。没加载出来时预判一律放行，退化成原来的行为。
 *
 * 集合在运行中会随着投递成功而增长，快照稍旧只意味着少拦几个，处理岗位时的判定仍是权威。
 */
let deliveredKeysSnapshot: DeliveredKeys | null = null

async function refreshDeliveredKeys() {
  const uid = getCurrentAccountUid()
  if (uid == null) return
  try {
    const [companies, bosses] = await Promise.all([
      counter.storageGet<Record<string, string[]>>(sameCompanyKey, {}),
      counter.storageGet<Record<string, string[]>>(sameHrKey, {}),
    ])
    deliveredKeysSnapshot = {
      companies: new Set(companies?.[uid] ?? []),
      bosses: new Set(bosses?.[uid] ?? []),
    }
  } catch (error) {
    // 预判失败不该拦住投递：保持上一次快照，继续按原来的行为抓取。
    logger.warn('读取去重快照失败，本次跳过入池预判', { error })
  }
}

function getDedupeSettings() {
  const formData = getExecutionFormData()
  return {
    sameCompany: formData.sameCompanyFilter.value,
    sameHr: formData.sameHrFilter.value,
    friendStatus: formData.friendStatus.value,
  }
}

/**
 * 把已经投过的公司留在池子里的同伴作废。
 *
 * 入池预判只能拦住入池那一刻就已知重复的岗位。一家还没投过的公司发了 20 个 JD，20 个都是
 * 合法候选；等第一个投出去，剩下的当场变成死数据，却仍然是待处理状态，继续把水位撑着。
 * 所以每次刷新快照之后再扫一遍池子，把新变成死数据的标掉。
 */
function pruneDeliveredCompanySiblings() {
  if (deliveredKeysSnapshot == null) return
  const settings = getDedupeSettings()
  const pruned: Record<string, number> = {}
  for (const source of ['group', 'search'] as const) {
    for (const job of getDeliverableJobs(getConfiguredSourcePool(source))) {
      const reason = explainImpossibleDelivery(job, settings, deliveredKeysSnapshot)
      if (reason == null) continue
      job.status.setStatus('filtered', reason)
      pruned[reason] = (pruned[reason] ?? 0) + 1
    }
  }
  const total = Object.values(pruned).reduce((sum, count) => sum + count, 0)
  if (total > 0) {
    logBatchDiagnostic('投递池中已失效的岗位已作废', { pruned, total })
  }
}

/**
 * 算出当前页有哪些岗位可以进池。
 *
 * 判据带状态（每放行一个就占掉该公司一个名额），所以只跑一遍，把结果固化成 id 集合再交给
 * store，避免第二次调用把配额算重。
 */
function selectAdmissibleJobs(source: DeliveryLimitSource) {
  const candidates = jobList._list.value
  if (deliveredKeysSnapshot == null) return null
  const admit = createPoolAdmission({
    settings: getDedupeSettings(),
    delivered: deliveredKeysSnapshot,
    pooled: getDeliverableJobs(getConfiguredSourcePool(source)),
  })
  return new Set(candidates.filter(admit).map((job) => job.encryptJobId))
}

function captureCurrentPageToDeliveryPool(
  source: DeliveryLimitSource = inferDeliveryLimitSource(),
  groupTargetId?: string,
) {
  const currentTask = readCurrentAccountDeliveryTask()
  const currentStep = currentTask == null ? undefined : getCurrentTaskStep(currentTask)
  const taskGroupTargetId = currentStep?.expectation?.id
  const resolvedGroupTargetId =
    source === 'group'
      ? groupTargetId || taskGroupTargetId || getCurrentGroupTargetId() || undefined
      : undefined
  const searchDirection =
    source === 'search'
      ? currentStep?.searchDirection ||
        new URL(location.href).searchParams.get('query') ||
        undefined
      : undefined
  // 搜索来源必须能说清「这一页是按哪个方向搜出来的」。取不到方向说明当前页根本不是某次
  // 搜索的结果——真机上就是一个只带 salary 筛选、没有 query 的岗位列表页，整页被原样收进
  // 投递池，于是「运营总监」「政府关系」这种和求职方向毫无关系的岗位混了进来，还各自烧掉
  // 一次详情请求和一次 AI 调用。
  //
  // 真实的搜索步骤一定带 searchDirection（见 deliveryTask 的步骤构造），所以这里拦掉的
  // 只有「哪儿都没有方向」这一种情况。调用方忽略返回值、无论如何都继续，拦掉是安全的。
  if (!canCaptureIntoDeliveryPool(source, searchDirection)) {
    logBatchDiagnostic('当前页没有可归属的搜索方向，未入池', {
      source,
      listLength: jobList._list.value.length,
      url: location.href,
    })
    return 0
  }
  const listLength = jobList._list.value.length
  const admissibleIds = selectAdmissibleJobs(source)
  // 名字在这一刻是确定的（正在处理的就是这个期望），刻进岗位后就不再依赖启用列表。
  const resolvedGroupName =
    resolvedGroupTargetId == null
      ? undefined
      : getJobSourceLabel(
          'group',
          { deliveryGroupTargetIds: [resolvedGroupTargetId] },
          conf.availableJobExpectations,
        )
  const added = jobList.captureCurrentPageToDeliveryPool(
    source,
    resolvedGroupTargetId,
    searchDirection,
    admissibleIds == null ? undefined : (job) => admissibleIds.has(job.encryptJobId),
    resolvedGroupName === '求职期望' ? undefined : resolvedGroupName,
  )
  const skipped = admissibleIds == null ? 0 : listLength - admissibleIds.size
  if (skipped > 0) {
    logBatchDiagnostic('入池前已排除的岗位', {
      source,
      skipped,
      listLength,
      companyQuota: sameCompanyPoolQuota,
      reason: '同公司/同HR/已沟通，或同公司名额已满',
    })
  }
  if (added > 0) {
    logBatchDiagnostic('当前页面岗位已写入投递池', {
      source,
      added,
      listLength: jobList._list.value.length,
      page: Number(page.value.page) || null,
      firstJobId: jobList._list.value[0]?.encryptJobId ?? '',
      groupTargetId: resolvedGroupTargetId ?? null,
    })
  }
  return added
}

async function pauseDeliver() {
  logBatchDiagnostic('用户暂停投递', {
    page: Number(page.value.page) || null,
    listLength: jobList._list.value.length,
    success: todayData.success,
    total: todayData.total,
  })
  requestDeliveryStop('manual-pause')
  if (scheduledDeliveryResumeTimer != null) {
    window.clearTimeout(scheduledDeliveryResumeTimer)
    scheduledDeliveryResumeTimer = undefined
  }
  common.deliverStop = true
  jobList.setDeliveryPoolCaptureEnabled(false)
  await flushRunState('用户暂停投递')
  // 和 stopDeliver 的关键差别：不调用 terminate，也不清掉本地检查点。
  const accountUid = getCurrentAccountUid()
  const taskId = readCurrentAccountDeliveryTask()?.id ?? durableDeliveryTask.value?.runId
  if (accountUid == null || taskId == null) return
  const workerId = await getDeliveryWorkerId()
  const result = await counter.deliveryTaskPause({ uid: accountUid, runId: taskId, workerId })
  endBackgroundKeepAlive()
  setDurableDeliveryTask(result.task)
  if (!result.accepted) {
    logBatchDiagnostic('暂停投递未被接受', { taskId, conflict: result.conflict ?? null })
    AgentMessage.warning('任务已经结束，无法暂停')
  }
}

async function resumeFromPause() {
  const accountUid = getCurrentAccountUid()
  const taskId = durableDeliveryTask.value?.runId
  if (accountUid == null || taskId == null) {
    AgentMessage.warning('没有可继续的投递任务')
    return
  }
  const workerId = await getDeliveryWorkerId()
  // claim 把暂停中的任务重新置为 running 并取回租约；拿不到就说明别的标签页已经接管。
  const result = await counter.deliveryTaskResume({ uid: accountUid, runId: taskId, workerId })
  setDurableDeliveryTask(result.task)
  if (result.accepted) beginBackgroundKeepAlive()
  if (!result.accepted) {
    logBatchDiagnostic('继续投递未被接受', { taskId, conflict: result.conflict ?? null })
    AgentMessage.warning(
      result.conflict === 'worker-owned'
        ? '另一个标签页正在执行这个任务'
        : '任务已结束，请重新开始',
    )
    return
  }
  logBatchDiagnostic('用户继续投递', { taskId })
  stopReason = null
  common.deliverStop = false
  jobList.setDeliveryPoolCaptureEnabled(true)
  await resumeDeliveryTask('manual-resume')
}

async function stopDeliver() {
  logBatchDiagnostic('用户手动停止投递', {
    page: Number(page.value.page) || null,
    listLength: jobList._list.value.length,
    success: todayData.success,
    total: todayData.total,
  })
  requestDeliveryStop('manual-stop')
  if (scheduledDeliveryResumeTimer != null) {
    window.clearTimeout(scheduledDeliveryResumeTimer)
    scheduledDeliveryResumeTimer = undefined
  }
  common.deliverStop = true
  jobList.setDeliveryPoolCaptureEnabled(false)
  await flushRunState('用户手动停止')
  const task = readCurrentAccountDeliveryTask()
  const durableTask = durableDeliveryTask.value
  const taskId = task?.id ?? durableTask?.runId
  if (taskId != null) {
    await terminatePersistentDeliveryTask(taskId, 'manual-stop', '用户手动停止投递')
    clearDeliveryTask(taskId)
  }
}

function getCurrentAccountUid() {
  const uid = user.getUserId()
  return uid == null || String(uid).trim().length === 0 ? null : String(uid)
}

function readCurrentAccountDeliveryTask() {
  const accountUid = getCurrentAccountUid()
  return accountUid == null ? null : readDeliveryTask(accountUid)
}

function setDurableDeliveryTask(task: DurableDeliveryTask | null) {
  durableDeliveryTask.value = task
  // 暂停同样要保住快照：继续时这一轮必须沿用开始时的配置，而不是用户暂停期间改过的配置。
  const keepsSnapshot =
    task?.status === 'running' || task?.status === 'waiting-for-page' || task?.status === 'paused'
  activeDeliveryConfigSnapshot.value = keepsSnapshot
    ? parseDeliveryConfigSnapshot(task.configSnapshot)
    : null
}

function getExecutionFormData() {
  return activeDeliveryConfigSnapshot.value?.formData ?? conf.formData
}

async function hydratePersistentDeliveryTask() {
  const accountUid = getCurrentAccountUid()
  if (accountUid == null) return null
  const localTask = readDeliveryTask(accountUid)
  const durableTask = await counter.deliveryTaskRead(accountUid)
  setDurableDeliveryTask(durableTask)
  if (
    durableTask != null &&
    (durableTask.status === 'running' || durableTask.status === 'waiting-for-page')
  ) {
    if (activeDeliveryConfigSnapshot.value == null) {
      if (localTask != null) clearDeliveryTask(localTask.id)
      throw new Error('运行配置快照已失效，请重新开始投递')
    }
    return restoreDeliveryTask(durableTask.checkpoint, accountUid)
  }

  if (localTask != null) {
    clearDeliveryTask(localTask.id)
  }
  return null
}

async function startPersistentDeliveryTask(
  task: DeliveryTask,
  snapshot = activeDeliveryConfigSnapshot.value,
) {
  if (snapshot == null) throw new Error('投递运行配置快照无效')
  const workerId = await getDeliveryWorkerId()
  const result = await counter.deliveryTaskStart({
    uid: task.accountUid,
    runId: task.id,
    workerId,
    checkpoint: task,
    configSnapshot: snapshot,
  })
  setDurableDeliveryTask(result.task)
  if (!result.accepted) {
    const message =
      result.conflict === 'active-run' ? '同一账号已有投递任务在运行' : '投递任务后台登记失败'
    throw new Error(message)
  }
  beginBackgroundKeepAlive()
}

async function claimPersistentDeliveryTask(task: DeliveryTask) {
  const workerId = await getDeliveryWorkerId()
  let result = await counter.deliveryTaskClaim({
    uid: task.accountUid,
    runId: task.id,
    workerId,
  })
  if (!result.accepted && result.conflict === 'task-missing') {
    await startPersistentDeliveryTask(task)
    result = await counter.deliveryTaskClaim({
      uid: task.accountUid,
      runId: task.id,
      workerId,
    })
  }
  setDurableDeliveryTask(result.task)
  if (!result.accepted && result.conflict === 'worker-owned') {
    workerOwnershipBlocked = true
    const retryAt = Math.max(
      Date.now() + 250,
      result.task?.leaseExpiresAt ?? Date.now() + DELIVERY_WORKER_LEASE_MS,
    )
    scheduleDeliveryResumeAt(retryAt)
    logBatchDiagnostic('投递任务等待：其他标签页正在执行', {
      ...summarizeTask(task),
      retryAt,
    })
    return false
  }
  if (!result.accepted) {
    throw new Error('当前投递任务已停止或不存在')
  }
  // 页面重载后的自动恢复走的是 claim 而不是 start（任务还在，只是换了个执行者），
  // 保活必须挂在这里——否则恰恰是重载之后的那一段没有保活，而那正是问题高发段。
  beginBackgroundKeepAlive()
  return true
}

async function checkpointPersistentDeliveryTask(task: DeliveryTask) {
  const workerId = await getDeliveryWorkerId()
  const result = await counter.deliveryTaskCheckpoint({
    uid: task.accountUid,
    runId: task.id,
    workerId,
    checkpoint: task,
    phase: getPersistentDeliveryTaskPhase(),
  })
  setDurableDeliveryTask(result.task)
  if (!result.accepted) {
    throw new Error(
      result.conflict === 'worker-owned' ? '当前页面已失去投递执行权' : '后台投递任务已停止',
    )
  }
}

async function saveAndCheckpointDeliveryTask(task: DeliveryTask, failureMessage: string) {
  if (!saveDeliveryTask(task, task.id)) throw new Error(failureMessage)
  await checkpointPersistentDeliveryTask(task)
}

function getPersistentDeliveryTaskPhase(): DeliveryTaskActivePhase {
  return activePhase
}

async function releasePersistentDeliveryTask(task: DeliveryTask) {
  const workerId = await getDeliveryWorkerId()
  const result = await counter.deliveryTaskRelease({
    uid: task.accountUid,
    runId: task.id,
    workerId,
  })
  endBackgroundKeepAlive()
  setDurableDeliveryTask(result.task)
}

async function terminatePersistentDeliveryTask(
  taskId: string,
  reason: DeliveryTaskTerminalReason,
  message?: string,
) {
  const accountUid = getCurrentAccountUid()
  if (accountUid == null) return
  const workerId = await getDeliveryWorkerId()
  const result = await counter.deliveryTaskTerminate({
    uid: accountUid,
    runId: taskId,
    workerId,
    reason,
    message,
  })
  endBackgroundKeepAlive()
  setDurableDeliveryTask(result.task)
}

async function pausePersistentDeliveryTask(taskId: string) {
  const accountUid = getCurrentAccountUid()
  if (accountUid == null) return
  const workerId = await getDeliveryWorkerId()
  const result = await counter.deliveryTaskPause({ uid: accountUid, runId: taskId, workerId })
  setDurableDeliveryTask(result.task)
}

/**
 * 模型不可用时暂停整轮。
 *
 * 批次结果有三个出口（页面批次、混合投递池、恢复批次），抽成一处是因为它们已经漂移过一次：
 * 只改了其中一个，运行从另一个走掉，任务被释放成 waiting-for-page 而不是 paused，
 * 检查点没保住。
 */
function pauseForUnavailableAi(fallbackMessage: string) {
  const message = deliver.terminalError || fallbackMessage
  requestDeliveryStop('ai-unavailable', message)
  common.deliverStop = true
  return message
}

/**
 * 命中频率限制之后怎么退。
 *
 * 三个批次出口都走这一个入口，理由和 pauseForUnavailableAi 一样：上一次 AI 失败就是因为
 * 三个出口只改了两个，运行从没改的那个走掉，检查点没保住。
 *
 * 冷却而不是重试：被限流说明这一段行为已经被判定成异常，等一会儿接着投等于拿后面的岗位
 * 去验证同一个判定。冷却时长长于会话间隔，回来时节奏曲线也已经重置成「刚开工」。
 */
async function backOffForRateLimit() {
  const today = getCurDay()
  const uid = getCurrentAccountUid()
  const stored = await counter
    .storageGet<unknown>(riskBackoffKey, null)
    .catch(() => null as unknown)
  const all = (stored != null && typeof stored === 'object' ? stored : {}) as Record<
    string,
    unknown
  >
  const record = readTodayRecord(uid == null ? null : all[String(uid)], today)
  const hits = record.hits + 1
  const decision = decideRiskBackoff(hits)
  if (uid != null) {
    await counter
      .storageSet(riskBackoffKey, {
        ...all,
        [String(uid)]: { date: today, hits, lastHitAt: Date.now() },
      })
      .catch(() => undefined)
  }
  // 记账与提示不能影响退避本身。这条路径的失效方向必须是「少记一笔」，
  // 绝不能因为一次日志或额度写入出错，就让本该暂停的任务被外层当成运行异常而终止——
  // 那会连检查点一起清掉，比不退避更糟。
  try {
    // 下调当日额度：算出来不用等于没做。
    setRiskAdjustedDailyLimit(getRiskAdjustedDailyLimit(DAILY_DELIVERY_LIMIT, hits))
    logBatchDiagnostic('触发频率限制，进入退避', {
      hitsToday: hits,
      action: decision.action,
      coolDownMs: decision.coolDownMs,
      adjustedDailyLimit: getRiskAdjustedDailyLimit(DAILY_DELIVERY_LIMIT, hits),
    })
    log.info('风控', decision.message)
    AgentMessage.warning(decision.message)
  } catch (error) {
    logger.warn('退避记账失败，不影响暂停本身', { error })
  }
  if (decision.action === 'stop-for-today') {
    requestDeliveryStop('risk-control', decision.message)
    common.deliverStop = true
    return decision.message
  }
  requestDeliveryStop('rate-limited', decision.message)
  common.deliverStop = true
  scheduleDeliveryResumeAt(Date.now() + decision.coolDownMs)
  return decision.message
}

function markTerminalFailure(message: string) {
  requestDeliveryStop('terminal-error', message)
  common.deliverStop = true
}

function scheduleDeliveryResumeAt(retryAt: number) {
  activePhase = 'waiting'
  if (scheduledDeliveryResumeTimer != null) {
    window.clearTimeout(scheduledDeliveryResumeTimer)
  }
  const delayMs = Math.max(0, retryAt - Date.now())
  scheduledDeliveryResumeTimer = window.setTimeout(() => {
    scheduledDeliveryResumeTimer = undefined
    const trigger = stopReason === 'runtime-reconnect' ? 'runtime-reconnect' : 'acquisition-retry'
    void resumeDeliveryTask(trigger).finally(() => {
      // 停止原因互斥，等待重连时不可能同时是手动停止，无需再排除后者。
      if (stopReason === 'runtime-reconnect' && readCurrentAccountDeliveryTask() != null) {
        scheduleDeliveryResumeAt(Date.now() + deliveryReconnectRetryMs)
      }
    })
  }, delayMs)
}

async function assertDeliveryRuntimeHealthy(
  phase: string,
  detail: Record<string, unknown>,
  logSuccess = false,
) {
  try {
    const health = await probeExtensionRuntimeHealth()
    if (logSuccess) {
      logBatchDiagnostic('投递运行时检查通过', {
        ...detail,
        phase,
        ...health,
      })
    }
    return health
  } catch (error) {
    logBatchDiagnostic('投递运行时检查失败：执行端等待重连', {
      ...detail,
      phase,
      ...getRuntimeCommunicationDiagnostic(error),
      nextAction: '刷新或重新打开 BOSS 页面后自动继续',
    })
    throw error
  }
}

function getRuntimeCommunicationDiagnostic(error: unknown) {
  if (error instanceof ExtensionRuntimeHealthError) {
    return getExtensionRuntimeHealthDiagnostic(error)
  }
  return {
    ...getProviderHeartbeatDiagnostic(error),
    code: isProviderHeartbeatError(error)
      ? 'CONTENT_SCRIPT_UNAVAILABLE'
      : 'UNKNOWN_RUNTIME_HEALTH_ERROR',
    runtimeHealth: false,
  }
}

function getRuntimeCommunicationMessage(error: unknown) {
  if (error instanceof ExtensionRuntimeHealthError) return error.message
  return '插件页面通信已失效，请关闭当前 BOSS 标签页并重新打开后再开始投递'
}

async function startBatch() {
  const runToken = acquireDeliveryRun('manual')
  if (runToken == null) {
    AgentMessage.info('当前已有投递任务在执行')
    return
  }
  try {
    if (!(await refreshStatisticsForCurrentDate())) {
      AgentMessage.info('当日投递统计暂不可用，请稍后重试')
      return
    }
    if (!hasDailyDeliveryRemaining(todayData)) {
      logBatchDiagnostic('开始投递被拦截：今日额度已完成', {
        dailyLimit: DAILY_DELIVERY_LIMIT,
        success: todayData.success,
        total: todayData.total,
      })
      AgentMessage.info(`今日投递已达到 ${DAILY_DELIVERY_LIMIT}`)
      return
    }
    await warnIfStorageNearQuota()
    const aiRuntime = await ensureEnabledAiTasksReady()
    if (aiRuntime == null) return
    let task: DeliveryTask | null
    try {
      // 初始化只发生在启动路径，且必须在任务登记到后台之前完成。
      if (!(await ensureJobExpectationsInitialized())) {
        throw new Error('求职期望初始化保存失败')
      }
      task = await createCombinedTask()
    } catch (error) {
      logBatchDiagnostic('开始投递被拦截：求职期望读取失败', {
        error: error instanceof Error ? error.message : String(error),
      })
      AgentMessage.error('求职期望读取失败，请稍后重试')
      return
    }
    if (task == null) {
      logBatchDiagnostic('开始投递被拦截：没有可用岗位来源', {
        searchSuccess: getDeliveryLimitSuccess(todayData, 'search'),
        searchEnabled: conf.formData.jobSources?.searchEnabled ?? true,
        searchWeight: getConfiguredSourceWeight('search'),
        groupSuccess: getDeliveryLimitSuccess(todayData, 'group'),
        recommendEnabled: conf.formData.jobSources?.recommendEnabled ?? true,
        enabledExpectIds: conf.formData.jobSources?.enabledExpectIds ?? null,
        groupWeight: getConfiguredSourceWeight('group'),
      })
      AgentMessage.info('请至少开启一个有效岗位来源，并确认来源比例大于 0')
      return
    }
    try {
      await assertDeliveryRuntimeHealthy('手动启动投递前', summarizeTask(task), true)
    } catch (error) {
      AgentMessage.error(getRuntimeCommunicationMessage(error))
      return
    }
    let configSnapshot: DeliveryConfigSnapshot
    try {
      configSnapshot = buildDeliveryConfigSnapshot(
        conf.formData,
        aiRuntime.readiness.configRevision,
      )
    } catch (error) {
      logBatchDiagnostic('创建投递任务失败：运行配置读取失败', {
        ...summarizeTask(task),
        error: error instanceof Error ? error.message : String(error),
      })
      AgentMessage.error('投递配置读取失败，请重试')
      return
    }
    logBatchDiagnostic('创建投递任务', {
      ...summarizeTask(task),
      steps: summarizeTaskSteps(task),
    })
    const replacedTaskId = readCurrentAccountDeliveryTask()?.id ?? null
    if (!saveDeliveryTask(task, replacedTaskId)) {
      logBatchDiagnostic('创建投递任务失败：持久任务已变化', summarizeTask(task))
      return
    }
    try {
      await startPersistentDeliveryTask(task, configSnapshot)
    } catch (error) {
      clearDeliveryTask(task.id)
      logBatchDiagnostic('创建投递任务失败：后台任务登记失败', {
        ...summarizeTask(task),
        error: error instanceof Error ? error.message : String(error),
      })
      AgentMessage.error(error instanceof Error ? error.message : '投递任务启动失败')
      return
    }
    activeDeliveryConfigSnapshot.value = configSnapshot
    jobList.setDeliveryPoolCaptureEnabled(true)
    await persistSearchRotation(task)
    await runDeliveryTask(task, runToken)
  } finally {
    releaseDeliveryRun(runToken)
  }
}

/**
 * 首次使用求职期望来源时，把平台上的期望列表写入配置并选定默认启用项。
 *
 * 只能在手动启动路径调用：它会写运行配置，而后台在投递任务登记后会拒绝一切
 * 配置写入。补池换轮若走到这里，`confPersist` 必然失败，进而把整个投递任务
 * 判成任务级错误终止（契约 §6 要求这类失败只在自身边界内降级）。
 */
async function ensureJobExpectationsInitialized() {
  // 明确使用 live store：此时任务尚未登记，写配置是合法的。
  const formData = conf.formData
  const sourceConfig = formData.jobSources
  if (sourceConfig == null || getDeliveryLimit(formData, 'group') <= 0) return true
  if (sourceConfig.expectationsInitialized && sourceConfig.enabledExpectIds.length === 0) {
    return true
  }

  const resume = await user.getUserResumeData()
  const availableExpectations = extractJobExpectations(resume)
  const previousExpectations = JSON.stringify(conf.availableJobExpectations)
  const previousJobSources = JSON.stringify(sourceConfig)
  conf.setAvailableJobExpectations(availableExpectations)
  if (!sourceConfig.expectationsInitialized) {
    const initialExpectation = getInitialJobExpectation(availableExpectations)
    sourceConfig.enabledExpectIds = initialExpectation ? [initialExpectation.id] : []
    sourceConfig.expectationsInitialized = true
  }
  if (
    previousExpectations === JSON.stringify(conf.availableJobExpectations) &&
    previousJobSources === JSON.stringify(sourceConfig)
  ) {
    return true
  }
  return conf.confPersist()
}

/**
 * 构造本轮取岗任务。每轮补池都会调用，因此必须保持为纯读：
 * 不写运行配置、不改运行快照。期望的初始化由 ensureJobExpectationsInitialized 负责。
 */
/**
 * 投递开始前检查一次存储用量。写满配额后投递记录、投递池和统计都会停止落盘，
 * 而失败路径全部是降级继续，用户不会看到硬报错——所以要在开始前就提醒。
 * 这里只提醒不阻断：是否清理由用户决定，自动裁剪用户数据风险更高。
 */
async function warnIfStorageNearQuota() {
  try {
    const usage = await counter.storageUsage()
    if (usage == null || !isStorageUsageOverSoftLimit(usage.bytesInUse)) return
    const detail = `${formatStorageBytes(usage.bytesInUse)} / ${formatStorageBytes(usage.quotaBytes)}`
    logBatchDiagnostic('扩展本地存储接近上限', {
      bytesInUse: usage.bytesInUse,
      quotaBytes: usage.quotaBytes,
      nextAction: '建议在运行日志或投递记录中清理历史数据',
    })
    if (shouldReportStorageQuota()) {
      AgentMessage.warning(`扩展本地存储已用 ${detail}，建议清理历史投递记录后再继续`)
    }
  } catch (error) {
    logger.warn('读取扩展存储用量失败，已跳过配额检查', error)
  }
}

async function createCombinedTask() {
  const accountUid = getCurrentAccountUid()
  if (accountUid == null) throw new Error('账号信息尚未就绪')
  const formData = getExecutionFormData()
  const sourceConfig = formData.jobSources
  const searchConditions = formData.searchConditions
  const configuredExpectIds = sourceConfig?.enabledExpectIds ?? []
  const enabledExpectations: JobExpectation[] =
    sourceConfig?.recommendEnabled !== false ? [getRecommendationJobExpectation()] : []
  if (
    sourceConfig != null &&
    getDeliveryLimit(formData, 'group') > 0 &&
    configuredExpectIds.length > 0
  ) {
    // 每轮都重新读取平台期望（恢复场景下页面刚加载，内存里可能是空的）。
    // 这是纯读；setAvailableJobExpectations 只写内存，不触发持久化，运行中安全。
    const availableExpectations = extractJobExpectations(await user.getUserResumeData())
    conf.setAvailableJobExpectations(availableExpectations)
    enabledExpectations.push(
      ...getEnabledJobExpectations(availableExpectations, configuredExpectIds),
    )
    const availableIds = new Set(availableExpectations.map((item) => item.id))
    const missingExpectIds = configuredExpectIds.filter((id) => !availableIds.has(id))
    if (missingExpectIds.length > 0) {
      logBatchDiagnostic('部分已配置求职期望已不存在，本次已跳过', {
        missingExpectIds,
        availableExpectIds: availableExpectations.map((item) => item.id),
      })
    }
  }
  const currentGroupExpectId =
    inferDeliveryLimitSource() === 'group' ? getCurrentGroupTargetId() : undefined
  const searchUrls = searchConditions == null ? undefined : buildBossSearchUrls(searchConditions)
  const searchRotation =
    hasSourceRemaining('search') && searchUrls && searchUrls.length > 0
      ? await readSearchRotationState(accountUid)
      : null
  jobList.setConfigScope?.(buildDeliveryQueueConfigScope(formData))
  const task = createDeliveryTask({
    accountUid,
    currentSource: inferDeliveryLimitSource(),
    currentUrl: location.href,
    currentGroupExpectId,
    searchUrl: undefined,
    searchUrls,
    searchCursorKey: searchRotation?.nextDirectionKey ?? '',
    groupUrl: getDefaultGroupUrl(),
    groupExpectations: sourceConfig == null ? undefined : enabledExpectations,
    hasRemaining: hasSourceRemaining,
  })
  if (task != null) {
    task.cycleStartedSuccess = todayData.success
    task.cycleStartedTotal = todayData.total
  }
  return task
}

/**
 * 换轮结果需要区分「已安排重试」和「已终止」：两者都不能继续本轮循环，但只有后者
 * 是错误。以前统一返回 false，调用方无法分辨，于是把等待重试的任务判成任务级错误。
 */
type AcquisitionRestartOutcome = 'continue' | 'waiting' | 'stopped'

async function restartAcquisitionCycle(
  task: DeliveryTask,
  runToken: DeliveryRunToken,
): Promise<AcquisitionRestartOutcome> {
  if (!canContinueDeliveryRun(runToken) || !hasDailyDeliveryRemaining(todayData)) return 'stopped'
  const previousCycle = task.acquisitionCycle ?? 1
  const { madeProgress, noProgressCycles } = advanceDeliveryTaskCycleProgress(task, todayData)
  if (hasReachedDeliveryTaskEmptyCycleLimit(task)) {
    task.retryAt = undefined
    saveDeliveryTask(task, task.id)
    logBatchDiagnostic('连续多轮没有可处理岗位，投递任务停止', {
      ...summarizeTask(task),
      previousCycle,
      noProgressCycles,
      maxEmptyCycles: DELIVERY_TASK_MAX_EMPTY_CYCLES,
    })
    markTerminalFailure(`连续 ${DELIVERY_TASK_MAX_EMPTY_CYCLES} 轮没有获取到可处理岗位`)
    return 'stopped'
  }
  // 本轮取岗失败属于岗位/来源边界内的问题（读简历、读轮转位置都可能临时失败），
  // 按契约 §6 应当重试或降级，不能升级成任务级错误把整个投递任务终止。
  let nextCycle: DeliveryTask | null
  try {
    nextCycle = await createCombinedTask()
  } catch (error) {
    const retryAt = Date.now() + deliveryReconnectRetryMs
    task.retryAt = retryAt
    saveDeliveryTask(task, task.id)
    logBatchDiagnostic('本轮取岗准备失败，任务保持运行并稍后重试', {
      ...summarizeTask(task),
      previousCycle,
      error: error instanceof Error ? error.message : String(error),
      retryAt,
    })
    scheduleDeliveryResumeAt(retryAt)
    return 'waiting'
  }
  if (nextCycle == null) {
    markTerminalFailure('没有可继续使用的岗位来源')
    return 'stopped'
  }

  task.currentIndex = nextCycle.currentIndex
  task.steps = nextCycle.steps
  task.poolWarmup = nextCycle.poolWarmup
  task.searchRotation = nextCycle.searchRotation
  task.runtimeHeartbeat = undefined
  task.acquisitionCycle = previousCycle + 1
  const retryDelaySeconds =
    noProgressCycles > 0 ? Math.min(300, Math.max(60, noProgressCycles * 60)) : 0
  task.retryAt = retryDelaySeconds > 0 ? Date.now() + retryDelaySeconds * 1000 : undefined
  if (!saveDeliveryTask(task, task.id)) {
    markTerminalFailure('下一轮取岗检查点写入失败')
    return 'stopped'
  }
  await persistSearchRotation(task)
  await checkpointPersistentDeliveryTask(task)
  logBatchDiagnostic('上一轮投递池已处理完，开始补充下一轮岗位', {
    ...summarizeTask(task),
    previousCycle,
    acquisitionCycle: task.acquisitionCycle,
    madeProgress,
    noProgressCycles,
  })

  if (noProgressCycles > 0) {
    logBatchDiagnostic('本轮没有可处理岗位，任务保持运行并等待重新取岗', {
      ...summarizeTask(task),
      retryDelaySeconds,
    })
    scheduleDeliveryResumeAt(task.retryAt ?? Date.now())
    return 'waiting'
  }
  return canContinueDeliveryRun(runToken) ? 'continue' : 'stopped'
}

async function readSearchRotationState(accountUid: string): Promise<SearchRotationState> {
  try {
    const stored = await counter.storageGet<unknown>(
      createAccountStorageKey(searchRotationStorageKey, accountUid),
      null,
    )
    if (
      typeof stored === 'object' &&
      stored != null &&
      !Array.isArray(stored) &&
      typeof (stored as { nextDirectionKey?: unknown }).nextDirectionKey === 'string'
    ) {
      return {
        nextDirectionKey: (stored as { nextDirectionKey: string }).nextDirectionKey.trim(),
      }
    }
    return { nextDirectionKey: '' }
  } catch (error) {
    logBatchDiagnostic('搜索词轮转位置读取失败，本次从首个搜索词开始', {
      error: error instanceof Error ? error.message : String(error),
    })
    return { nextDirectionKey: '' }
  }
}

async function persistSearchRotation(task: DeliveryTask) {
  const nextDirectionKey = task.searchRotation?.nextDirectionKey
  if (!nextDirectionKey) return
  try {
    const storageKey = createAccountStorageKey(searchRotationStorageKey, task.accountUid)
    await counter.storageSet<SearchRotationState>(storageKey, { nextDirectionKey })
    logBatchDiagnostic('搜索词轮转位置已保存', {
      selectedDirections: task.searchRotation?.selectedDirections ?? [],
      nextDirectionKey,
    })
  } catch (error) {
    logBatchDiagnostic('搜索词轮转位置保存失败，本次投递继续', {
      selectedDirections: task.searchRotation?.selectedDirections ?? [],
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function getCurrentGroupTargetId() {
  const root = document.querySelector<HTMLElement>('.c-expect-select')
  const activeOption = root
    ? readNativeJobExpectationOptions(root).find((option) => option.active)
    : null
  if (activeOption?.id) return activeOption.id

  const targetIds = new Set(
    jobList._list.value
      .map(getJobGroupTargetId)
      .filter((targetId): targetId is string => targetId != null),
  )
  return targetIds.size === 1 ? [...targetIds][0] : ''
}

function hasSourceRemaining(source: DeliveryLimitSource) {
  return hasDailyDeliveryRemaining(todayData) && getConfiguredSourceWeight(source) > 0
}

async function flushRunState(reason = '未指定') {
  await flushRunStatePart('投递池', () => jobList.flushSourcePools(), reason)
  await flushRunStatePart('统计', () => statistics.flush(), reason)
  await flushRunStatePart('日志', () => log.flush(), reason)
}

async function flushRunStatePart(target: string, flush: () => Promise<unknown>, reason: string) {
  try {
    await flush()
  } catch (error) {
    const diagnostic = {
      ...getProviderHeartbeatDiagnostic(error),
      firstJobId: jobList._list.value[0]?.encryptJobId ?? '',
      listLength: jobList._list.value.length,
      page: Number(page.value.page) || null,
      reason,
      target,
    }
    logBatchDiagnostic('运行状态保存失败，已保留当前页面内存状态', diagnostic)
    logger.warn('运行状态保存失败，已降级继续', diagnostic)
    // 同上：配额写满时日志也写不进去，只能直接提示用户。
    if (isStorageQuotaError(error) && shouldReportStorageQuota()) {
      AgentMessage.error(STORAGE_QUOTA_ERROR_MESSAGE)
    }
  }
}

async function resumeDeliveryTask(trigger = 'unknown') {
  if (resumeDeliveryTaskPromise != null) {
    const task = readCurrentAccountDeliveryTask()
    if (task != null) {
      logBatchDiagnostic('恢复投递任务跳过：已有恢复流程运行中', {
        ...summarizeTask(task),
        trigger,
      })
    }
    return resumeDeliveryTaskPromise
  }

  resumeDeliveryTaskPromise = resumeDeliveryTaskOnce(trigger)
  try {
    await resumeDeliveryTaskPromise
  } finally {
    resumeDeliveryTaskPromise = null
  }
}

async function resumeDeliveryTaskOnce(trigger = 'unknown') {
  if (!common.deliverLock) {
    try {
      await hydratePersistentDeliveryTask()
    } catch (error) {
      logBatchDiagnostic('恢复投递任务等待：后台任务状态暂不可用', {
        trigger,
        error: error instanceof Error ? error.message : String(error),
      })
      scheduleDeliveryResumeAt(Date.now() + deliveryReconnectRetryMs)
      return
    }
  }
  const task = readCurrentAccountDeliveryTask()
  if (task == null) return
  if (!statisticsReadyForDelivery && !(await refreshStatisticsForCurrentDate())) {
    logBatchDiagnostic('恢复投递任务等待：当日统计尚未就绪', {
      ...summarizeTask(task),
      trigger,
    })
    scheduleDeliveryResumeAt(Date.now() + deliveryReconnectRetryMs)
    return
  }
  if (task.retryAt != null && task.retryAt > Date.now()) {
    scheduleDeliveryResumeAt(task.retryAt)
    logBatchDiagnostic('投递任务保持运行，等待下一轮取岗时间', {
      ...summarizeTask(task),
      trigger,
      retryAt: task.retryAt,
      waitMs: task.retryAt - Date.now(),
    })
    return
  }
  if (task.retryAt != null) {
    task.retryAt = undefined
    saveDeliveryTask(task, task.id)
  }
  // 用户主动结束或暂停时不得把停止标志清掉。暂停是异步的（要先落盘再调后台），
  // 在它完成之前持久状态仍是 running，这里若照常清标志，自动恢复就会把刚暂停的任务重新拉起来。
  if (
    stopReason !== 'manual-stop' &&
    stopReason !== 'manual-pause' &&
    (durableDeliveryTask.value?.status === 'running' ||
      durableDeliveryTask.value?.status === 'waiting-for-page')
  ) {
    common.deliverStop = false
  }
  if (common.deliverLock || common.deliverStop) {
    logBatchDiagnostic('恢复投递任务跳过：任务锁定或已停止', {
      ...summarizeTask(task),
      trigger,
      deliverLock: common.deliverLock,
      deliverStop: common.deliverStop,
    })
    return
  }
  const step = getCurrentTaskStep(task)
  if (step == null) {
    // 换轮瞬间 currentIndex 会短暂越过步骤边界。运行循环把这个状态解读为「该补池换轮」，
    // 恢复路径以前却判成任务级错误——于是恰好在换轮时刷新页面会杀掉一个健康的任务。
    // 只有 steps 本身为空才是真正的结构损坏（后台的 assertCheckpoint 也按此判定）。
    if (task.steps.length > 0) {
      const runToken = acquireDeliveryRun('resume', task.id)
      if (runToken == null) return
      try {
        logBatchDiagnostic('恢复投递任务：当前轮次已处理完，继续补充下一轮岗位', {
          ...summarizeTask(task),
          trigger,
        })
        await runDeliveryTask(task, runToken)
      } finally {
        releaseDeliveryRun(runToken)
      }
      return
    }
    logBatchDiagnostic('恢复投递任务失败：投递任务没有任何执行步骤', {
      ...summarizeTask(task),
      trigger,
    })
    await terminatePersistentDeliveryTask(task.id, 'terminal-error', '投递任务缺少执行步骤')
    clearDeliveryTask(task.id)
    return
  }
  const actualSource = inferDeliveryLimitSource()
  const resumeNavigation = getValidAutoResumeNavigation(step)
  const runtimeHeartbeat = getFreshDeliveryTaskHeartbeat(
    task,
    step.source,
    Date.now(),
    step.expectation?.id,
    step.searchDirection,
  )
  const onExpectedSearchLocation = step.source !== 'search' || isSearchStepLocation(step)
  const resumeFromHeartbeat =
    resumeNavigation == null &&
    runtimeHeartbeat != null &&
    actualSource === step.source &&
    onExpectedSearchLocation
  const resumeFromPersistentTask =
    durableDeliveryTask.value?.runId === task.id &&
    (task.legacyMigrationPending !== true || Boolean(task.activeBatch?.items.length)) &&
    (durableDeliveryTask.value.status === 'running' ||
      durableDeliveryTask.value.status === 'waiting-for-page')
  if (resumeNavigation == null && !resumeFromHeartbeat && !resumeFromPersistentTask) {
    const heartbeatAgeMs =
      task.runtimeHeartbeat == null ? null : Date.now() - task.runtimeHeartbeat.at
    logBatchDiagnostic('恢复投递任务跳过：缺少主动恢复标记', {
      ...summarizeTask(task),
      trigger,
      actualSource,
      expectedSource: step.source,
      currentStepStatus: step.status,
      heartbeatAgeMs,
      heartbeatSource: task.runtimeHeartbeat?.source ?? null,
      heartbeatMaxAgeMs: DELIVERY_TASK_HEARTBEAT_MAX_AGE_MS,
      nextAction: '清理未登记到后台的历史任务，等待用户手动点击开始投递',
    })
    await flushRunState('恢复任务缺少主动恢复标记')
    clearDeliveryTask(task.id)
    return
  }
  if (resumeNavigation != null && !resumeFromPersistentTask && actualSource !== step.source) {
    if (resumeNavigation.onFromUrl) {
      logBatchDiagnostic('恢复投递任务等待目标来源跳转生效', {
        ...summarizeTask(task),
        trigger,
        expectedSource: step.source,
        actualSource,
        attemptedTargetUrl: resumeNavigation.attempt.targetUrl,
        attemptedFromUrl: resumeNavigation.attempt.fromUrl,
        attemptAgeMs: resumeNavigation.attemptAgeMs,
        waitTimeoutMs: resumeNavigationPendingTimeoutMs,
      })
      return
    }

    logBatchDiagnostic('恢复投递任务停止：目标来源跳转后仍不匹配', {
      ...summarizeTask(task),
      trigger,
      expectedSource: step.source,
      actualSource,
      attemptedTargetUrl: resumeNavigation.attempt.targetUrl,
      attemptedFromUrl: resumeNavigation.attempt.fromUrl,
      attemptAgeMs: resumeNavigation.attemptAgeMs,
      waitTimeoutMs: resumeNavigationPendingTimeoutMs,
    })
    await flushRunState('恢复任务跳转后仍不匹配')
    if (task.legacyMigrationPending) {
      await terminatePersistentDeliveryTask(task.id, 'terminal-error', '旧投递任务恢复位置无效')
    }
    clearDeliveryTask(task.id)
    return
  }
  if (resumeNavigation != null && !resumeFromPersistentTask && !resumeNavigation.onTargetUrl) {
    logBatchDiagnostic('恢复投递任务停止：主动恢复标记未到目标页', {
      ...summarizeTask(task),
      trigger,
      expectedSource: step.source,
      actualSource,
      attemptedTargetUrl: resumeNavigation.attempt.targetUrl,
      attemptedFromUrl: resumeNavigation.attempt.fromUrl,
      attemptAgeMs: resumeNavigation.attemptAgeMs,
      waitTimeoutMs: resumeNavigationPendingTimeoutMs,
    })
    await flushRunState('恢复任务未到目标页')
    if (task.legacyMigrationPending) {
      await terminatePersistentDeliveryTask(task.id, 'terminal-error', '旧投递任务恢复位置无效')
    }
    clearDeliveryTask(task.id)
    return
  }
  if (task.legacyMigrationPending) {
    task.legacyMigrationPending = false
    saveDeliveryTask(task, task.id)
  }
  const runToken = acquireDeliveryRun('resume', task.id)
  if (runToken == null) {
    logBatchDiagnostic('恢复投递任务跳过：已有投递 owner', {
      ...summarizeTask(task),
      trigger,
    })
    return
  }
  try {
    try {
      await assertDeliveryRuntimeHealthy(
        '自动恢复投递前',
        { ...summarizeTask(task), trigger },
        true,
      )
    } catch (error) {
      requestDeliveryStop('runtime-reconnect')
      await releasePersistentDeliveryTask(task).catch(() => undefined)
      scheduleDeliveryResumeAt(Date.now() + deliveryReconnectRetryMs)
      AgentMessage.info('插件后台正在重连，投递任务会自动继续')
      return
    }
    jobList.setDeliveryPoolCaptureEnabled(true)
    step.resumeNavigationAttempt = undefined
    saveDeliveryTask(task, task.id)
    if (!hasDailyDeliveryRemaining(todayData)) {
      logBatchDiagnostic('恢复投递任务停止：今日额度已完成', {
        ...summarizeTask(task),
        trigger,
      })
      await terminatePersistentDeliveryTask(task.id, 'daily-limit', '今日投递额度已完成')
      clearDeliveryTask(task.id)
      return
    }
    if (task.poolWarmup?.completed === false) {
      logBatchDiagnostic('恢复投递任务继续首次补充投递池', {
        ...summarizeTask(task),
        trigger,
      })
      await runDeliveryTask(task, runToken)
      return
    }
    const onExpectedStepLocation =
      actualSource === step.source && (step.source !== 'search' || isSearchStepLocation(step))
    if (onExpectedStepLocation) {
      const expectationReady = await ensureGroupExpectationStep(step, runToken, '恢复投递任务')
      if (!expectationReady || !canContinueDeliveryRun(runToken)) {
        logBatchDiagnostic('恢复投递任务停止：求职期望岗位列表不可用', {
          ...summarizeTask(task),
          expectation: step.expectation ? getExpectationLabel(step.expectation) : null,
          trigger,
        })
        if (!canContinueDeliveryRun(runToken)) return
        await terminatePersistentDeliveryTask(task.id, 'terminal-error', '求职期望岗位列表不可用')
        clearDeliveryTask(task.id)
        return
      }
      const ready = await waitForJobListReady(step.source)
      if (!ready || !canContinueDeliveryRun(runToken)) {
        logBatchDiagnostic('恢复投递任务等待岗位列表超时或已停止', {
          ...summarizeTask(task),
          source: step.source,
          listLength: jobList._list.value.length,
          trigger,
        })
        return
      }
    }
    logBatchDiagnostic('恢复投递任务继续执行', {
      ...summarizeTask(task),
      trigger,
      resumeReason: resumeFromPersistentTask
        ? 'durable-background-task'
        : resumeFromHeartbeat
          ? 'fresh-runtime-heartbeat'
          : 'internal-navigation',
    })
    await runDeliveryTask(task, runToken)
  } finally {
    releaseDeliveryRun(runToken)
  }
}

function getValidAutoResumeNavigation(step: DeliveryTask['steps'][number]) {
  const attempt = step.resumeNavigationAttempt
  if (attempt?.targetUrl !== step.url) return null

  const attemptAgeMs = Date.now() - attempt.at
  const onFromUrl = isSameNavigationLocation(location.href, attempt.fromUrl)
  const onTargetUrl =
    step.source === 'search'
      ? isSearchStepLocation(step, location.href)
      : isSameNavigationLocation(location.href, attempt.targetUrl)
  if (
    attemptAgeMs < 0 ||
    attemptAgeMs >= resumeNavigationPendingTimeoutMs ||
    (!onFromUrl && !onTargetUrl)
  ) {
    return null
  }

  return {
    attempt,
    attemptAgeMs,
    onFromUrl,
    onTargetUrl,
  }
}

function isSearchStepLocation(step: DeliveryTask['steps'][number], href = location.href) {
  if (step.source !== 'search') return false
  try {
    const actual = new URL(href, location.origin)
    const target = new URL(step.url, location.origin)
    if (!['/web/geek/job', '/web/geek/jobs'].includes(actual.pathname)) return false
    for (const key of ['query', 'city', 'salary', 'experience', 'degree', 'jobType']) {
      const expected = target.searchParams.get(key)
      if (expected != null && actual.searchParams.get(key) !== expected) return false
    }
    return Boolean(target.searchParams.get('query')?.trim())
  } catch {
    return isSameNavigationLocation(href, step.url)
  }
}

function prepareStepNavigation(task: DeliveryTask, step: DeliveryTask['steps'][number]) {
  const existingAttempt = step.resumeNavigationAttempt
  if (
    existingAttempt?.targetUrl === step.url &&
    Date.now() - existingAttempt.at < resumeNavigationPendingTimeoutMs &&
    isSameNavigationLocation(location.href, existingAttempt.fromUrl)
  ) {
    saveDeliveryTask(task, task.id)
    return existingAttempt
  }

  if (step.source === 'search') {
    step.poolSizeAtEntry = getDeliverableJobs(getConfiguredSourcePool('search')).length
  }
  step.resumeNavigationAttempt = {
    at: Date.now(),
    fromUrl: location.href,
    targetUrl: step.url,
  }
  saveDeliveryTask(task, task.id)
  return step.resumeNavigationAttempt
}

function isCurrentJobListKnownEmpty() {
  if (jobList._list.value.length > 0) return false
  const pageState = page.value as {
    count?: unknown
    pageCount?: unknown
    total?: unknown
    totalCount?: unknown
    totalPage?: unknown
  }
  return [
    pageState.total,
    pageState.totalCount,
    pageState.count,
    pageState.pageCount,
    pageState.totalPage,
  ]
    .map(Number)
    .some((value) => Number.isFinite(value) && value === 0)
}

async function waitForJobListReady(source: DeliveryLimitSource, groupTargetId?: string) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (jobList._list.value.length > 0) {
      captureCurrentPageToDeliveryPool(source, groupTargetId)
      return true
    }
    if (isCurrentJobListKnownEmpty()) return true
    await delay(0.5)
  }
  return false
}

async function waitForJobListChanged(beforePageSnapshot: JobListSnapshot) {
  const startedAt = Date.now()
  const deadline = startedAt + builtInDeliveryPageLoadTimeoutMs
  let nextRuntimeRefreshAt = startedAt
  while (Date.now() < deadline) {
    if (common.deliverStop) return false
    const currentPageSnapshot = getCurrentJobListSnapshot()
    const delta = diffJobListSnapshot(beforePageSnapshot, currentPageSnapshot)
    if (delta.responded) {
      await refreshBossRuntimeBinding('下一页岗位列表已进入插件状态')
      logPaginationDiagnostic('下一页岗位列表已加载', {
        previousFirstJobId: beforePageSnapshot.jobIds[0] ?? '',
        currentFirstJobId: currentPageSnapshot.jobIds[0] ?? '',
        addedJobCount: delta.addedJobIds.length,
        listLength: jobList._list.value.length,
        page: Number(page.value.page) || null,
        waitedMs: Date.now() - startedAt,
        timeoutMs: builtInDeliveryPageLoadTimeoutMs,
      })
      return true
    }
    if (Date.now() >= nextRuntimeRefreshAt) {
      await refreshBossRuntimeBinding('等待下一页岗位列表加载')
      nextRuntimeRefreshAt = Date.now() + builtInDeliveryPageRuntimeRefreshIntervalMs
    }
    await delay(0.5)
  }
  logPaginationDiagnostic('等待下一页岗位列表超时', {
    previousFirstJobId: beforePageSnapshot.jobIds[0] ?? '',
    currentFirstJobId: jobList._list.value[0]?.encryptJobId ?? '',
    listLength: jobList._list.value.length,
    page: Number(page.value.page) || null,
    waitedMs: Date.now() - startedAt,
    timeoutMs: builtInDeliveryPageLoadTimeoutMs,
  })
  return false
}

async function refreshBossRuntimeBinding(reason: string) {
  const runtimeVue = document.querySelector<any>(
    '#wrap .page-job-wrapper,.job-recommend-main,.page-jobs-main',
  )?.__vue__
  if (runtimeVue != null && runtimeVue === boundBossRuntimeVue && pager.ready?.value === true) {
    return true
  }
  logPaginationDiagnostic('刷新BOSS页面运行时绑定', {
    reason,
    page: Number(page.value.page) || null,
    listLength: jobList._list.value.length,
    firstJobId: jobList._list.value[0]?.encryptJobId ?? '',
  })
  try {
    await jobList.initJobList(getExecutionFormData())
    await initPager()
    boundBossRuntimeVue =
      document.querySelector<any>('#wrap .page-job-wrapper,.job-recommend-main,.page-jobs-main')
        ?.__vue__ ?? runtimeVue
    logPaginationDiagnostic('BOSS页面运行时绑定刷新完成', {
      reason,
      page: Number(page.value.page) || null,
      listLength: jobList._list.value.length,
      firstJobId: jobList._list.value[0]?.encryptJobId ?? '',
    })
    return true
  } catch (error) {
    logger.error('刷新BOSS页面运行时绑定失败', error)
    logPaginationDiagnostic('BOSS页面运行时绑定刷新失败', {
      reason,
      page: Number(page.value.page) || null,
      listLength: jobList._list.value.length,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

async function ensureGroupExpectationStep(
  step: DeliveryTask['steps'][number],
  runToken: DeliveryRunToken,
  reason: string,
) {
  const expectation = step.expectation
  if (step.source !== 'group' || expectation == null) return true

  const root = await waitForNativeExpectationRoot(runToken)
  if (!root) {
    logBatchDiagnostic('求职期望切换失败：未找到 BOSS 求职期望控件', {
      reason,
      expectId: expectation.id,
      expectation: getExpectationLabel(expectation),
    })
    return false
  }
  const option = findNativeJobExpectationOption(root, expectation)
  if (!option) {
    logBatchDiagnostic('求职期望切换失败：未找到已配置的求职期望', {
      reason,
      expectId: expectation.id,
      expectation: getExpectationLabel(expectation),
    })
    return false
  }

  const currentTargetIds = new Set(
    jobList._list.value
      .map(getJobGroupTargetId)
      .filter((targetId): targetId is string => targetId != null),
  )
  if (
    option.active &&
    jobList._list.value.length > 0 &&
    (currentTargetIds.size === 0 || currentTargetIds.has(expectation.id))
  ) {
    captureCurrentPageToDeliveryPool('group', expectation.id)
    return true
  }

  const beforeFirstJobId = jobList._list.value[0]?.encryptJobId ?? ''
  if (!option.active) {
    logBatchDiagnostic('正在切换求职期望', {
      reason,
      expectId: expectation.id,
      expectation: getExpectationLabel(expectation),
      nativeText: option.text,
    })
    option.element.click()
  }
  const ready = await waitForGroupExpectationReady(
    step,
    runToken,
    beforeFirstJobId,
    option.active,
    reason,
  )
  if (!ready) {
    logBatchDiagnostic('求职期望切换失败：岗位列表未就绪', {
      reason,
      expectId: expectation.id,
      expectation: getExpectationLabel(expectation),
      beforeFirstJobId,
      currentFirstJobId: jobList._list.value[0]?.encryptJobId ?? '',
    })
  }
  return ready
}

async function waitForNativeExpectationRoot(runToken: DeliveryRunToken) {
  const deadline = Date.now() + resumeNavigationPendingTimeoutMs
  while (Date.now() < deadline && canContinueDeliveryRun(runToken)) {
    const root = document.querySelector<HTMLElement>('.c-expect-select')
    if (root) return root
    await delay(0.5)
  }
  return null
}

async function waitForGroupExpectationReady(
  step: DeliveryTask['steps'][number],
  runToken: DeliveryRunToken,
  previousFirstJobId: string,
  wasAlreadyActive: boolean,
  reason: string,
) {
  const expectation = step.expectation
  if (!expectation) return true
  const startedAt = Date.now()
  const deadline = startedAt + resumeNavigationPendingTimeoutMs
  let nextRuntimeRefreshAt = startedAt
  while (Date.now() < deadline && canContinueDeliveryRun(runToken)) {
    if (Date.now() >= nextRuntimeRefreshAt) {
      await refreshBossRuntimeBinding(`${reason}：读取求职期望岗位`)
      nextRuntimeRefreshAt = Date.now() + 2_000
    }
    const currentFirstJobId = jobList._list.value[0]?.encryptJobId ?? ''
    const currentTargetIds = new Set(
      jobList._list.value
        .map(getJobGroupTargetId)
        .filter((targetId): targetId is string => targetId != null),
    )
    const root = document.querySelector<HTMLElement>('.c-expect-select')
    const active = root ? findNativeJobExpectationOption(root, expectation)?.active === true : false
    const firstJobChanged = currentFirstJobId.length > 0 && currentFirstJobId !== previousFirstJobId
    if (
      isGroupExpectationListReady({
        active,
        currentFirstJobId,
        currentTargetIds,
        expectationId: expectation.id,
        listLength: jobList._list.value.length,
        previousFirstJobId,
        waitedMs: Date.now() - startedAt,
        wasAlreadyActive,
      })
    ) {
      captureCurrentPageToDeliveryPool('group', expectation.id)
      logBatchDiagnostic('求职期望岗位列表已就绪', {
        reason,
        expectId: expectation.id,
        expectation: getExpectationLabel(expectation),
        firstJobChanged,
        listLength: jobList._list.value.length,
        waitedMs: Date.now() - startedAt,
      })
      return true
    }
    if (active && isCurrentJobListKnownEmpty()) {
      logBatchDiagnostic('求职期望岗位列表为空', {
        reason,
        expectId: expectation.id,
        expectation: getExpectationLabel(expectation),
        waitedMs: Date.now() - startedAt,
      })
      return true
    }
    await delay(0.5)
  }
  return false
}

async function runDeliveryBatch(
  task: DeliveryTask,
  runToken: DeliveryRunToken,
  batchItems?: Parameters<typeof deliver.jobListHandle>[0],
  batchTarget = '当前页',
) {
  if (!canContinueDeliveryRun(runToken)) return 'stopped'
  setDeliveryPhase(runToken, 'processing')
  await assertDeliveryRuntimeHealthy(`${batchTarget}处理前`, summarizeTask(task))
  if (!canContinueDeliveryRun(runToken)) return 'stopped'
  return deliver.jobListHandle(batchItems, getExecutionFormData())
}

async function runDeliveryTask(task: DeliveryTask, runToken: DeliveryRunToken) {
  if (!canContinueDeliveryRun(runToken)) return
  const heartbeatTimer = await startDeliveryTaskHeartbeat(task, runToken)
  if (heartbeatTimer == null) {
    if (terminalFailureMessage != null) {
      await terminatePersistentDeliveryTask(
        task.id,
        'terminal-error',
        terminalFailureMessage,
      ).catch(() => undefined)
      clearDeliveryTask(task.id)
    } else if (!workerOwnershipBlocked) {
      await releasePersistentDeliveryTask(task).catch(() => undefined)
    }
    if (stopReason === 'runtime-reconnect') {
      scheduleDeliveryResumeAt(Date.now() + deliveryReconnectRetryMs)
    }
    return
  }
  const runStartedAt = Date.now()
  const runStartedStatistics = {
    success: todayData.success,
    total: todayData.total,
    jobContent: todayData.jobContent,
    aiFiltering: todayData.aiFiltering,
    companySizeRange: todayData.companySizeRange,
    activityFilter: todayData.activityFilter,
    goldHunterFilter: todayData.goldHunterFilter,
    repeat: todayData.repeat,
    amap: todayData.amap,
  }
  deliver.resetBatchPace()
  let stepMsg = '投递结束'
  try {
    logger.debug('start combined delivery task', { task, page })
    logBatchDiagnostic('投递任务启动', summarizeTask(task))
    while (canContinueDeliveryRun(runToken)) {
      // 每批开始前刷一次去重快照并清理池子。不能只在补池时做：补池要等水位跌到低水位线，
      // 而死数据把水位撑住正是要解决的问题，只挂在补池上就成了循环，永远等不到那一刻。
      await refreshDeliveredKeys()
      pruneDeliveredCompanySiblings()
      setDeliveryPhase(runToken, 'acquiring')
      if (!hasDailyDeliveryRemaining(todayData)) {
        requestDeliveryStop('daily-limit')
        stepMsg = `今日投递已达到 ${DAILY_DELIVERY_LIMIT}`
        logBatchDiagnostic('投递任务停止：今日额度已完成', summarizeTask(task))
        await flushRunState('今日额度完成')
        break
      }
      const step = getCurrentTaskStep(task)
      if (step == null) {
        stepMsg = '当前投递池已处理完，正在补充下一轮岗位'
        logBatchDiagnostic('当前投递池已处理完，准备补充下一轮岗位', summarizeTask(task))
        const restartOutcome = await restartAcquisitionCycle(task, runToken)
        if (restartOutcome === 'continue') continue
        // 'waiting' 表示换轮已安排重试，任务应保持运行；只有 'stopped' 才是失败，
        // 且失败原因由 restartAcquisitionCycle 内部给出，这里只做兜底。
        if (
          restartOutcome === 'stopped' &&
          terminalFailureMessage == null &&
          canContinueDeliveryRun(runToken)
        ) {
          markTerminalFailure('无法创建下一轮取岗任务')
        }
        break
      }
      const mixedQueueResult = await runMixedQueueBatchIfReady(task, runToken)
      if (!canContinueDeliveryRun(runToken)) {
        stepMsg = stopReason === 'runtime-reconnect' ? '等待页面重新连接' : '投递已停止'
        break
      }
      if (mixedQueueResult === 'finished') break
      if (mixedQueueResult === 'continue') continue
      const actualSource = inferDeliveryLimitSource()
      const searchLocationMismatch = step.source === 'search' && !isSearchStepLocation(step)
      const searchPoolReadyOnCurrentPage =
        step.source === 'search' &&
        actualSource === 'search' &&
        searchLocationMismatch &&
        getCurrentSearchPoolSize() > 0
      if (searchPoolReadyOnCurrentPage) {
        step.resumeNavigationAttempt = undefined
        step.poolSizeAtEntry = Math.max(step.poolSizeAtEntry ?? 0, getCurrentSearchPoolSize())
        saveDeliveryTask(task, task.id)
        logBatchDiagnostic('搜索来源沿用当前投递池继续执行', {
          ...summarizeTask(task),
          actualSource,
          currentUrl: location.href,
          targetUrl: step.url,
          poolSize: getCurrentSearchPoolSize(),
        })
      } else if (actualSource !== step.source || searchLocationMismatch) {
        const previousListSignature = getCurrentJobListSignature()
        prepareStepNavigation(task, step)
        stepMsg = `切换到${sourceLabelMap[step.source]}继续投递`
        logBatchDiagnostic('投递任务切换来源', {
          ...summarizeTask(task),
          actualSource,
          targetSource: step.source,
          targetUrl: step.url,
        })
        await flushRunState()
        if (!canContinueDeliveryRun(runToken)) {
          stepMsg = stopReason === 'runtime-reconnect' ? '等待页面重新连接' : '投递已停止'
          break
        }
        jobList.setDeliveryPoolCaptureEnabled(false)
        const navigated = await navigateToStep(step.url, '投递任务切换来源', runToken)
        if (!navigated) {
          jobList.setDeliveryPoolCaptureEnabled(true)
          stepMsg = `${getTaskStepLabel(step)}本轮切换失败，已跳过`
          markAcquisitionStepUnavailable(task, step, '投递任务切换来源失败')
          if (await finishCurrentStep(task, runToken)) break
          continue
        }
        const ready =
          step.source === 'search'
            ? await waitForSearchStepReadyAfterNavigation(
                step,
                previousListSignature,
                '投递任务切换来源',
              )
            : await waitForSourceReadyAfterNavigation(
                step.source,
                '投递任务切换来源',
                previousListSignature,
              )
        jobList.setDeliveryPoolCaptureEnabled(true)
        if (!canContinueDeliveryRun(runToken)) {
          stepMsg = stopReason === 'runtime-reconnect' ? '等待页面重新连接' : '投递已停止'
          break
        }
        if (!ready) {
          stepMsg = `${getTaskStepLabel(step)}本轮加载失败，已跳过`
          markAcquisitionStepUnavailable(task, step, '投递任务切换后岗位列表未就绪')
          if (await finishCurrentStep(task, runToken)) break
          continue
        }
        step.resumeNavigationAttempt = undefined
        saveDeliveryTask(task, task.id)
        touchDeliveryTaskHeartbeat(task)
        continue
      }
      setDeliveryLimitSourceOverride(step.source)
      step.status = 'running'
      saveDeliveryTask(task, task.id)
      const expectationReady = await ensureGroupExpectationStep(step, runToken, '执行投递步骤')
      if (!canContinueDeliveryRun(runToken)) {
        stepMsg = stopReason === 'runtime-reconnect' ? '等待页面重新连接' : '投递已停止'
        break
      }
      if (!expectationReady) {
        stepMsg = `${getTaskStepLabel(step)}无法读取岗位列表`
        if (await finishCurrentStep(task, runToken)) break
        continue
      }
      if (
        getDeliverableJobs(getConfiguredSourcePool(step.source)).length === 0 &&
        getDeliverableJobs(jobList._list.value).length === 0
      ) {
        stepMsg = `${sourceLabelMap[step.source]}当前可投递岗位已耗尽`
        logBatchDiagnostic('当前来源可投递岗位已耗尽', {
          ...summarizeTask(task),
          source: step.source,
          poolSize: getDeliverableJobs(getConfiguredSourcePool(step.source)).length,
          listLength: jobList._list.value.length,
        })
        if (await finishCurrentStep(task, runToken)) break
        continue
      }
      if (!hasSourceRemaining(step.source)) {
        stepMsg = `${sourceLabelMap[step.source]}未启用或今日额度已完成`
        logBatchDiagnostic('当前来源不可继续', {
          ...summarizeTask(task),
          source: step.source,
          sourceSuccess: getDeliveryLimitSuccess(todayData, step.source),
          sourceWeight: getConfiguredSourceWeight(step.source),
        })
        if (await finishCurrentStep(task, runToken)) break
        continue
      }
      if (step.pagesDone > 0) {
        const targetPage = step.pagesDone + 1
        const pageReady = await jumpToTaskPage(targetPage, runToken)
        if (!pageReady) {
          stepMsg = `${sourceLabelMap[step.source]}无法继续第 ${targetPage} 页`
          logBatchDiagnostic('投递任务停止：无法跳转到目标页', {
            ...summarizeTask(task),
            source: step.source,
            targetPage,
            page: Number(page.value.page) || null,
            listLength: jobList._list.value.length,
          })
          if (await finishCurrentStep(task, runToken)) break
          continue
        }
      }
      await delay(builtInDeliveryStartDelay)
      if (!canContinueDeliveryRun(runToken)) {
        stepMsg = stopReason === 'runtime-reconnect' ? '等待页面重新连接' : '投递已停止'
        break
      }
      if (jobList._list.value.length === 0) {
        stepMsg = `${sourceLabelMap[step.source]}岗位列表为空`
        logBatchDiagnostic('投递任务停止：岗位列表为空', {
          ...summarizeTask(task),
          source: step.source,
          page: Number(page.value.page) || null,
        })
        if (await finishCurrentStep(task, runToken)) break
        continue
      }
      const currentFirstJobId = jobList._list.value[0]?.encryptJobId ?? ''
      if (
        (location.href.includes('/web/geek/job-recommend') ||
          location.href.includes('/web/geek/jobs')) &&
        step.lastPage?.len === jobList._list.value.length &&
        step.lastPage.firstJobId === currentFirstJobId
      ) {
        stepMsg = `${sourceLabelMap[step.source]}未能获取更多岗位(job列表无变化)`
        logBatchDiagnostic('投递任务停止：岗位列表无变化', {
          ...summarizeTask(task),
          source: step.source,
          page: Number(page.value.page) || null,
          listLength: jobList._list.value.length,
          firstJobId: currentFirstJobId,
          lastPage: step.lastPage,
        })
        if (await finishCurrentStep(task, runToken)) break
        continue
      }
      logBatchDiagnostic('开始处理当前页岗位', {
        ...summarizeTask(task),
        source: step.source,
        page: Number(page.value.page) || null,
        pagesDone: step.pagesDone,
        listLength: jobList._list.value.length,
        firstJobId: currentFirstJobId,
      })
      const result = await runDeliveryBatch(task, runToken)
      logBatchDiagnostic('当前页处理完成', {
        ...summarizeTask(task),
        source: step.source,
        result,
        page: Number(page.value.page) || null,
        listLength: jobList._list.value.length,
        firstJobId: jobList._list.value[0]?.encryptJobId ?? '',
      })
      if (result === 'rateLimited') {
        stepMsg = await backOffForRateLimit()
        break
      }
      if (result === 'aiUnavailable') {
        stepMsg = pauseForUnavailableAi('AI 请求失败，投递已暂停')
        break
      }
      if (result === 'terminalError') {
        stepMsg = deliver.terminalError || '岗位处理发生运行错误'
        markTerminalFailure(stepMsg)
        break
      }
      if (result === 'sourceLimit') requestDeliveryStop('daily-limit')
      if (result === 'completed' || result === 'sourceLimit') {
        step.lastPage = {
          len: jobList._list.value.length,
          firstJobId: jobList._list.value[0]?.encryptJobId ?? '',
        }
        saveDeliveryTask(task, task.id)
      }
      if (common.deliverStop) {
        await flushRunState(stopReason === 'manual-stop' ? '用户手动停止' : '执行端中断')
        stepMsg = stopReason === 'manual-stop' ? '投递已停止' : '等待页面重新连接'
        logBatchDiagnostic('处理当前页后检测到任务停止标记', {
          ...summarizeTask(task),
          manualStop: stopReason === 'manual-stop',
          waitingForReconnect: stopReason === 'runtime-reconnect',
        })
        break
      }
      if (result === 'sourceLimit') {
        requestDeliveryStop('daily-limit')
        stepMsg = '今日额度已完成'
        logBatchDiagnostic('投递任务切换：当前页触发每日额度完成', {
          ...summarizeTask(task),
          source: step.source,
        })
        if (await finishCurrentStep(task, runToken)) break
        continue
      }
      stepMsg = `${sourceLabelMap[step.source]}当前页处理完成`
      if (await rotateToNextPool(task, runToken)) break
    }
  } catch (e) {
    const providerHeartbeat = isProviderHeartbeatError(e)
    const runtimeHealthFailure = e instanceof ExtensionRuntimeHealthError
    const runtimeCommunicationFailure = providerHeartbeat || runtimeHealthFailure
    logger.error(runtimeCommunicationFailure ? '插件运行时通信异常，等待重连' : '获取失败', e)
    stepMsg = runtimeCommunicationFailure ? getRuntimeCommunicationMessage(e) : `获取失败! - ${e}`
    logBatchDiagnostic(
      runtimeCommunicationFailure ? '投递任务运行时通信异常：保留任务等待重连' : '投递任务异常退出',
      {
        ...summarizeTask(task),
        error: runtimeCommunicationFailure
          ? getRuntimeCommunicationDiagnostic(e)
          : getProviderHeartbeatDiagnostic(e),
      },
    )
    if (runtimeCommunicationFailure) requestDeliveryStop('runtime-reconnect')
    if (!runtimeCommunicationFailure) {
      markTerminalFailure(e instanceof Error ? e.message : String(e))
    }
    await flushRunState(runtimeCommunicationFailure ? '运行时通信异常等待重连' : '异常退出')
  } finally {
    window.clearInterval(heartbeatTimer)
    try {
      if (stopReason === 'manual-stop') {
        await terminatePersistentDeliveryTask(task.id, 'manual-stop', '用户手动停止投递')
        clearDeliveryTask(task.id)
      } else if (
        stopReason === 'risk-control' ||
        stopReason === 'rate-limited' ||
        stopReason === 'ai-unavailable'
      ) {
        // 检查点必须留着：模型修好后点「继续」要能接着原来的位置跑，
        // 而 terminate 会连同检查点一起清掉，等于让用户从头再来。
        await pausePersistentDeliveryTask(task.id)
      } else if (stopReason === 'daily-limit' || !hasDailyDeliveryRemaining(todayData)) {
        await terminatePersistentDeliveryTask(task.id, 'daily-limit', '今日投递额度已完成')
        clearDeliveryTask(task.id)
      } else if (terminalFailureMessage != null) {
        await terminatePersistentDeliveryTask(task.id, 'terminal-error', terminalFailureMessage)
        clearDeliveryTask(task.id)
      } else {
        activePhase = 'waiting'
        await releasePersistentDeliveryTask(task)
      }
    } catch (error) {
      logger.warn('保存后台投递任务退出状态失败', { error })
    }
    const shouldScheduleResume =
      // 风控命中之后绝不能自动重试：人工过掉校验之前每一次请求都在加重判定。
      !(stopReason === 'risk-control') &&
      !(stopReason === 'manual-stop') &&
      !(stopReason === 'daily-limit') &&
      terminalFailureMessage == null &&
      !workerOwnershipBlocked &&
      hasDailyDeliveryRemaining(todayData)
    if (shouldScheduleResume) {
      scheduleDeliveryResumeAt(
        task.retryAt != null && task.retryAt > Date.now()
          ? task.retryAt
          : Date.now() + deliveryReconnectRetryMs,
      )
    }
    if (ownsDeliveryRun(runToken)) {
      try {
        setDeliveryLimitSourceOverride(null)
        logger.debug('日志信息', log.data)
        // stopReason 已经是权威。剩下两种退出态不是「停止」：没拿到执行权（未开始），
        // 以及正常让出等待下一次恢复。额度耗尽即使没走到设置处也按 daily-limit 汇报。
        const exitReason: DeliveryStopReason | 'worker-handoff' | 'waiting-for-page' =
          stopReason ??
          (!hasDailyDeliveryRemaining(todayData)
            ? 'daily-limit'
            : workerOwnershipBlocked
              ? 'worker-handoff'
              : 'waiting-for-page')
        const hardFiltered =
          todayData.jobContent -
          runStartedStatistics.jobContent +
          (todayData.companySizeRange - runStartedStatistics.companySizeRange) +
          (todayData.activityFilter - runStartedStatistics.activityFilter) +
          (todayData.goldHunterFilter - runStartedStatistics.goldHunterFilter) +
          (todayData.amap - runStartedStatistics.amap)
        const cycleSummary = {
          durationMs: Date.now() - runStartedAt,
          processed: todayData.total - runStartedStatistics.total,
          delivered: todayData.success - runStartedStatistics.success,
          hardFiltered,
          aiFiltered: todayData.aiFiltering - runStartedStatistics.aiFiltering,
          duplicate: todayData.repeat - runStartedStatistics.repeat,
          remainingPools: summarizePools({
            group: getDeliverableJobs(getConfiguredSourcePool('group')),
            search: getDeliverableJobs(getConfiguredSourcePool('search')),
          }),
          pendingActiveBatch: getPendingActiveDeliveryBatchItems(task).length,
          stopReason: exitReason,
          terminalMessage: terminalFailureMessage,
          waitingForReconnect: exitReason === 'runtime-reconnect',
        }
        logBatchDiagnostic('投递运行周期摘要', {
          ...summarizeTask(task),
          ...cycleSummary,
        })
        logBatchDiagnostic('投递任务退出', {
          ...summarizeTask(task),
          message: stepMsg,
          deliverStop: common.deliverStop,
          deliverLock: common.deliverLock,
          stopReason: exitReason,
          terminalMessage: terminalFailureMessage,
          waitingForReconnect: exitReason === 'runtime-reconnect',
          willResume:
            exitReason === 'manual-pause' ||
            exitReason === 'runtime-reconnect' ||
            exitReason === 'worker-handoff' ||
            exitReason === 'waiting-for-page',
        })
        AgentMessage.info(stepMsg)
        await flushRunState('投递任务退出')
      } finally {
        releaseDeliveryRun(runToken)
      }
    }
  }
}

async function startDeliveryTaskHeartbeat(task: DeliveryTask, runToken: DeliveryRunToken) {
  if (!touchDeliveryTaskHeartbeat(task)) {
    common.deliverStop = true
    logBatchDiagnostic('投递任务停止：运行心跳写入失败', summarizeTask(task))
    return null
  }
  try {
    const claimed = await claimPersistentDeliveryTask(task)
    if (!claimed) {
      return null
    }
    try {
      await checkpointPersistentDeliveryTask(task)
    } catch (error) {
      if (isProviderHeartbeatError(error)) {
        logBatchDiagnostic('投递任务检查点暂时不可用，将继续重试', {
          ...summarizeTask(task),
          ...getProviderHeartbeatDiagnostic(error),
        })
      } else {
        throw error
      }
    }
  } catch (error) {
    const reconnectRequested =
      isProviderHeartbeatError(error) || isExtensionContextInvalidatedError(error)
    if (stopReason === 'runtime-reconnect') requestDeliveryStop('runtime-reconnect')
    logBatchDiagnostic(
      stopReason === 'runtime-reconnect'
        ? '投递任务等待：后台连接暂时中断'
        : '投递任务停止：后台运行态登记失败',
      {
        ...summarizeTask(task),
        error: error instanceof Error ? error.message : String(error),
      },
    )
    if (!(stopReason === 'runtime-reconnect')) {
      markTerminalFailure(error instanceof Error ? error.message : '后台运行态登记失败')
    } else {
      scheduleDeliveryResumeAt(Date.now() + deliveryReconnectRetryMs)
    }
    return null
  }

  let timer: number
  let checkpointInFlight = false
  let transientCheckpointFailure = false
  timer = window.setInterval(() => {
    if (!canContinueDeliveryRun(runToken)) {
      window.clearInterval(timer)
      return
    }
    if (!touchDeliveryTaskHeartbeat(task)) {
      window.clearInterval(timer)
      common.deliverStop = true
      markTerminalFailure('当前页面已失去投递任务所有权')
      logBatchDiagnostic('投递任务停止：运行心跳已失去任务所有权', summarizeTask(task))
      return
    }
    if (checkpointInFlight) return

    checkpointInFlight = true
    void checkpointPersistentDeliveryTask(task)
      .then(() => {
        if (transientCheckpointFailure) {
          transientCheckpointFailure = false
          logBatchDiagnostic('投递任务检查点连接已恢复', summarizeTask(task))
        }
      })
      .catch((error) => {
        if (isProviderHeartbeatError(error)) {
          if (!transientCheckpointFailure) {
            transientCheckpointFailure = true
            logBatchDiagnostic('投递任务检查点暂时不可用，将继续重试', {
              ...summarizeTask(task),
              ...getProviderHeartbeatDiagnostic(error),
            })
          }
          return
        }

        window.clearInterval(timer)
        const reconnectRequested = isExtensionContextInvalidatedError(error)
        if (stopReason === 'runtime-reconnect') {
          requestDeliveryStop('runtime-reconnect')
          scheduleDeliveryResumeAt(Date.now() + deliveryReconnectRetryMs)
        } else {
          common.deliverStop = true
          markTerminalFailure(error instanceof Error ? error.message : '后台任务检查点写入失败')
        }
        logBatchDiagnostic(
          stopReason === 'runtime-reconnect'
            ? '投递任务等待：后台连接中断，保留任务并自动重连'
            : '投递任务停止：后台任务检查点写入失败',
          {
            ...summarizeTask(task),
            error: error instanceof Error ? error.message : String(error),
          },
        )
      })
      .finally(() => {
        checkpointInFlight = false
      })
  }, DELIVERY_TASK_HEARTBEAT_INTERVAL_MS)
  return timer
}

async function ensureEnabledAiTasksReady() {
  const uid = user.getUserId()
  if (uid == null || String(uid).trim() === '') {
    AgentMessage.error('未识别当前 BOSS 账号')
    return null
  }
  try {
    const runtime = await counter.configRuntime(String(uid))
    if (conf.formData.aiFiltering.enable && !runtime.readiness.aiFilteringReady) {
      AgentMessage.error('AI 匹配未就绪，请先配置模型并解析简历')
      return null
    }
    if (conf.formData.aiGreeting.enable && !runtime.readiness.aiGreetingReady) {
      AgentMessage.error('AI 招呼语未就绪，请先填写姓名、配置模型并解析简历')
      return null
    }
    return runtime
  } catch (error) {
    logger.warn('读取 AI 运行就绪状态失败', { error })
    AgentMessage.error('无法读取 AI 配置状态，请重新加载扩展后再试')
    return null
  }
}

function getPendingActiveDeliveryBatchItems(task: DeliveryTask) {
  const activeBatch = task.activeBatch
  if (activeBatch == null) return []
  const pools = {
    group: getConfiguredSourcePool('group'),
    search: getConfiguredSourcePool('search'),
  }
  const bySource = {
    group: new Map(pools.group.map((item) => [item.encryptJobId, item])),
    search: new Map(pools.search.map((item) => [item.encryptJobId, item])),
  }
  return activeBatch.items.flatMap(({ source, encryptJobId }) => {
    const item = bySource[source].get(encryptJobId)
    if (item == null || getDeliverableJobs([item]).length === 0) return []
    return [{ source, item }]
  })
}

async function runMixedQueueBatchIfReady(task: DeliveryTask, runToken: DeliveryRunToken) {
  const weights = {
    group: getConfiguredSourceWeight('group'),
    search: getConfiguredSourceWeight('search'),
  }
  const enabledSources = (['group', 'search'] as const).filter((source) => weights[source] > 0)
  if (enabledSources.length === 0) return 'fallback'

  const resumedBatchResult = await resumeActiveDeliveryBatch(task, runToken)
  if (resumedBatchResult != null) return resumedBatchResult

  const pendingBeforeFill = dedupeDeliverySourcePools(
    {
      group: getDeliverableJobs(getConfiguredSourcePool('group')),
      search: getDeliverableJobs(getConfiguredSourcePool('search')),
    },
    getDeliveryJobKey,
    getDeliveryJobSource,
  )
  const pendingBeforeFillSize = pendingBeforeFill.group.length + pendingBeforeFill.search.length
  if (
    task.poolWarmup != null &&
    pendingBeforeFillSize >= sourcePoolMaxLowWaterMark &&
    task.poolWarmup.lowWaterArmed === false
  ) {
    task.poolWarmup.lowWaterArmed = true
    saveDeliveryTask(task, task.id)
  }
  if (
    task.poolWarmup?.completed === true &&
    task.poolWarmup.lowWaterArmed !== false &&
    pendingBeforeFillSize < sourcePoolMaxLowWaterMark &&
    enabledSources.some((source) => hasPrefetchableStep(task, source))
  ) {
    task.poolWarmup = {
      completed: false,
      attemptedStepIndexes: [],
      lowWaterArmed: false,
    }
    saveDeliveryTask(task, task.id)
    logBatchDiagnostic('投递池低水位触发整轮补充', {
      ...summarizeTask(task),
      pendingPoolSize: pendingBeforeFillSize,
      lowWaterMark: sourcePoolMaxLowWaterMark,
      targetPoolPlan: buildDeliveryBatchPlan({
        batchSize: deliveryPoolBatchTargetSize,
        weights,
      }),
      pools: summarizePools(pendingBeforeFill),
    })
  }

  let completedWarmupThisPass = false
  if (task.poolWarmup?.completed === false) {
    const warmedUp = await warmupDeliveryPool(task, runToken, weights, enabledSources)
    if (!warmedUp || !canContinueDeliveryRun(runToken)) return 'finished'
    completedWarmupThisPass = true
  }

  const pools = {
    group: getDeliverableJobs(getConfiguredSourcePool('group')),
    search: getDeliverableJobs(getConfiguredSourcePool('search')),
  }
  const uniquePools = dedupeDeliverySourcePools(pools, getDeliveryJobKey, getDeliveryJobSource)
  if (finalizeDrainedPrefetchSteps(task, uniquePools)) {
    saveDeliveryTask(task, task.id)
    return 'continue'
  }
  const currentSource = inferDeliveryLimitSource()
  const targetPoolPlan = buildDeliveryBatchPlan({
    batchSize: deliveryPoolBatchTargetSize,
    weights,
  })
  const plan = buildDeliveryBatchPlan({
    batchSize: deliveryQueueBatchSize,
    weights,
  })
  const readyBatch = selectDeliveryBatch({
    batchSize: deliveryQueueBatchSize,
    getItemKey: getDeliveryJobKey,
    getItemOrder: getDeliveryJobOrder,
    getItemSource: getDeliveryJobSource,
    pools: uniquePools,
    weights,
  })
  // 「下一步做什么」是纯判断，交给 decideAcquisition；这里只负责执行它的结论。
  const decision = decideAcquisition({
    enabledSources,
    poolSizes: {
      group: uniquePools.group.length,
      search: uniquePools.search.length,
    },
    targetPoolPlan,
    prefetchableSources: enabledSources.filter((source) => hasPrefetchableStep(task, source)),
    currentSource,
    lowWaterMark: sourcePoolMaxLowWaterMark,
    warmupJustCompleted: completedWarmupThisPass,
    readyBatchSize: readyBatch.items.length,
  })

  if (decision.kind === 'switch-source') {
    logBatchDiagnostic('混合投递池切换来源补充', {
      ...summarizeTask(task),
      trigger: decision.trigger,
      targetSource: decision.source,
      candidates: decision.candidates,
      pools: summarizePools(uniquePools),
      targetPoolPlan,
    })
    const switchResult = await switchToSourceForPrefetch(task, runToken, decision.source, {
      missingSources: decision.candidates,
      plan,
      pools: uniquePools,
    })
    return switchResult === 'switched' || switchResult === 'skipped' ? 'continue' : 'finished'
  }

  if (decision.kind === 'prefetch-current') {
    const prefetchResult =
      decision.trigger === 'low-water'
        ? await prefetchCurrentSourceIfLowWater(task, runToken, currentSource, plan)
        : await prefetchUnderfilledCurrentSource(task, runToken, currentSource)
    if (!canContinueDeliveryRun(runToken)) return 'finished'
    if (prefetchResult === 'finished') return 'finished'
    if (prefetchResult === 'grew') return 'continue'

    // 当前来源抓不动了：标记该步骤耗尽，若同来源还有后续步骤就切过去，
    // 否则回到常规路径消费现有投递池。
    const unavailableStep = getCurrentTaskStep(task)
    if (unavailableStep?.source === currentSource) {
      unavailableStep.prefetchExhausted = true
      unavailableStep.status = 'done'
      saveDeliveryTask(task, task.id)
    }
    const nextStepIndex = findNextTaskStepIndexBySource(task, currentSource)
    if (nextStepIndex >= 0) {
      const switchResult = await switchToSourceForPrefetch(
        task,
        runToken,
        currentSource,
        { missingSources: [currentSource], plan, pools: uniquePools },
        { targetStepIndex: nextStepIndex },
      )
      return switchResult === 'switched' || switchResult === 'skipped' ? 'continue' : 'finished'
    }
    const alternative = enabledSources.find(
      (source) => source !== currentSource && hasPrefetchableStep(task, source),
    )
    if (alternative) {
      const switchResult = await switchToSourceForPrefetch(task, runToken, alternative, {
        missingSources: [alternative],
        plan,
        pools: uniquePools,
      })
      return switchResult === 'switched' || switchResult === 'skipped' ? 'continue' : 'finished'
    }
    if (readyBatch.items.length === 0) {
      logBatchDiagnostic('混合投递池等待补充', {
        ...summarizeTask(task),
        pools: summarizePools(uniquePools),
        targetPoolPlan,
        nextAction: '当前来源已无更多可抓岗位，继续处理现有投递池',
      })
      return 'fallback'
    }
  }

  if (decision.kind === 'idle' && readyBatch.items.length === 0) {
    logBatchDiagnostic('混合投递池暂无可执行动作', {
      ...summarizeTask(task),
      reason: decision.reason,
      pools: summarizePools(uniquePools),
    })
    return 'fallback'
  }

  const batch = readyBatch
  if (batch.items.length === 0) return 'fallback'

  logBatchDiagnostic('投递池 FIFO 批次启动', {
    ...summarizeTask(task),
    batchSize: deliveryQueueBatchSize,
    sources: batch.plan,
    pools: summarizePools(uniquePools),
    items: batch.items.map(({ source, item }) => ({
      source,
      encryptJobId: item.encryptJobId,
      jobName: item.jobName,
    })),
  })
  task.activeBatch = {
    id: `${task.id}:${Date.now()}`,
    startedAt: Date.now(),
    items: batch.items.map(({ source, item }) => ({
      source,
      encryptJobId: item.encryptJobId,
    })),
  }
  await saveAndCheckpointDeliveryTask(task, 'FIFO 批次检查点写入失败')
  const result = await runDeliveryBatch(task, runToken, batch.items, '当前批次')
  logBatchDiagnostic('投递池 FIFO 批次完成', {
    ...summarizeTask(task),
    result,
    remainingPools: summarizePools({
      group: getDeliverableJobs(getConfiguredSourcePool('group')),
      search: getDeliverableJobs(getConfiguredSourcePool('search')),
    }),
  })
  if (result === 'completed' || result === 'sourceLimit') {
    delete task.activeBatch
    await saveAndCheckpointDeliveryTask(task, 'FIFO 批次完成检查点写入失败')
  }
  if (result === 'sourceLimit') {
    requestDeliveryStop('daily-limit')
    await flushRunState('混合投递池触发每日额度完成')
    return 'finished'
  }
  if (result === 'rateLimited') {
    await backOffForRateLimit()
    await flushRunState('混合投递池触发频率限制')
    return 'finished'
  }
  if (result === 'aiUnavailable') {
    pauseForUnavailableAi('AI 请求失败，投递已暂停')
    await flushRunState('混合投递池等待可用模型')
    return 'finished'
  }
  if (result === 'terminalError') {
    markTerminalFailure(deliver.terminalError || '岗位处理发生运行错误')
    await flushRunState('混合投递池运行错误')
    return 'finished'
  }
  if (result === 'stopped' || common.deliverStop) {
    await flushRunState(stopReason === 'manual-stop' ? '混合投递池手动停止' : '混合投递池等待重连')
    return 'finished'
  }
  saveDeliveryTask(task, task.id)
  return 'continue'
}

async function resumeActiveDeliveryBatch(task: DeliveryTask, runToken: DeliveryRunToken) {
  const activeBatch = task.activeBatch
  if (activeBatch == null) return null
  const items = getPendingActiveDeliveryBatchItems(task)
  const skippedCount = activeBatch.items.length - items.length
  if (items.length === 0) {
    logBatchDiagnostic('未完成 FIFO 批次已无待处理岗位', {
      ...summarizeTask(task),
      batchId: activeBatch.id,
      skippedCount,
      nextAction: '清理批次检查点并继续消费投递池',
    })
    delete task.activeBatch
    await saveAndCheckpointDeliveryTask(task, '空 FIFO 批次清理检查点写入失败')
    return 'continue' as const
  }

  logBatchDiagnostic('恢复未完成 FIFO 批次', {
    ...summarizeTask(task),
    batchId: activeBatch.id,
    originalSize: activeBatch.items.length,
    remainingSize: items.length,
    skippedCount,
    items: items.map(({ source, item }) => ({ source, encryptJobId: item.encryptJobId })),
  })
  const result = await runDeliveryBatch(task, runToken, items, '恢复批次')
  logBatchDiagnostic('恢复的 FIFO 批次处理完成', {
    ...summarizeTask(task),
    batchId: activeBatch.id,
    result,
  })
  if (result === 'completed' || result === 'sourceLimit') {
    delete task.activeBatch
    await saveAndCheckpointDeliveryTask(task, '恢复批次完成检查点写入失败')
  }
  if (result === 'sourceLimit') {
    requestDeliveryStop('daily-limit')
    await flushRunState('恢复批次触发每日额度完成')
    return 'finished' as const
  }
  if (result === 'rateLimited') {
    await backOffForRateLimit()
    await flushRunState('恢复批次触发频率限制')
    return 'finished' as const
  }
  if (result === 'aiUnavailable') {
    pauseForUnavailableAi('AI 请求失败，投递已暂停')
    await flushRunState('恢复批次等待可用模型')
    return 'finished' as const
  }
  if (result === 'terminalError') {
    markTerminalFailure(deliver.terminalError || '恢复批次处理发生运行错误')
    await flushRunState('恢复批次运行错误')
    return 'finished' as const
  }
  if (result === 'stopped' || common.deliverStop) {
    await flushRunState(stopReason === 'manual-stop' ? '恢复批次手动停止' : '恢复批次等待重连')
    return 'finished' as const
  }
  return 'continue' as const
}

async function warmupDeliveryPool(
  task: DeliveryTask,
  runToken: DeliveryRunToken,
  weights: Record<DeliveryLimitSource, number>,
  enabledSources: DeliveryLimitSource[],
) {
  const warmup = task.poolWarmup
  if (warmup == null || warmup.completed) return true

  const targetPoolPlan = buildDeliveryBatchPlan({
    batchSize: deliveryPoolBatchTargetSize,
    weights,
  })
  logBatchDiagnostic('投递池首次补充开始', {
    ...summarizeTask(task),
    targetPoolPlan,
    attemptedStepIndexes: warmup.attemptedStepIndexes,
  })

  while (canContinueDeliveryRun(runToken)) {
    const pools = dedupeDeliverySourcePools(
      {
        group: getDeliverableJobs(getConfiguredSourcePool('group')),
        search: getDeliverableJobs(getConfiguredSourcePool('search')),
      },
      getDeliveryJobKey,
      getDeliveryJobSource,
    )
    const underfilledSources = enabledSources.filter(
      (source) => pools[source].length < targetPoolPlan[source],
    )
    if (underfilledSources.length === 0) {
      warmup.completed = true
      saveDeliveryTask(task, task.id)
      logBatchDiagnostic('投递池首次补充完成', {
        ...summarizeTask(task),
        completionReason: 'target-reached',
        targetPoolPlan,
        pools: summarizePools(pools),
      })
      return true
    }

    const nextStepIndex = findNextWarmupStepIndex(task, underfilledSources)
    if (nextStepIndex < 0) {
      warmup.completed = true
      saveDeliveryTask(task, task.id)
      logBatchDiagnostic('投递池首次补充完成', {
        ...summarizeTask(task),
        completionReason: 'source-round-complete',
        targetPoolPlan,
        pools: summarizePools(pools),
        underfilledSources,
        attemptedStepIndexes: warmup.attemptedStepIndexes,
      })
      return true
    }

    const step = task.steps[nextStepIndex]
    const activated = await activateWarmupStep(task, nextStepIndex, runToken, {
      missingSources: underfilledSources,
      plan: targetPoolPlan,
      pools,
    })
    if (!canContinueDeliveryRun(runToken)) return false
    if (!activated && readCurrentAccountDeliveryTask()?.id !== task.id) return false
    if (!activated) {
      if (!warmup.attemptedStepIndexes.includes(nextStepIndex)) {
        warmup.attemptedStepIndexes.push(nextStepIndex)
      }
      saveDeliveryTask(task, task.id)
      logBatchDiagnostic('投递池首次补充跳过：来源未就绪', {
        ...summarizeTask(task),
        stepIndex: nextStepIndex,
        step: getTaskStepLabel(step),
        attemptedStepIndexes: warmup.attemptedStepIndexes,
      })
      continue
    }
    const prefetchResult = await prefetchCurrentSourcePool(task, step.source, runToken)
    if (!canContinueDeliveryRun(runToken)) return false
    if (prefetchResult.outcome === 'load-failed') {
      if (!warmup.attemptedStepIndexes.includes(nextStepIndex)) {
        warmup.attemptedStepIndexes.push(nextStepIndex)
      }
      saveDeliveryTask(task, task.id)
      logBatchDiagnostic('投递池首次补充跳过：来源翻页加载失败', {
        ...summarizeTask(task),
        stepIndex: nextStepIndex,
        step: getTaskStepLabel(step),
        prefetchResult,
        attemptedStepIndexes: warmup.attemptedStepIndexes,
      })
      continue
    }
    if (prefetchResult.outcome === 'source-exhausted') {
      step.prefetchExhausted = true
      step.status = 'done'
    }

    if (!warmup.attemptedStepIndexes.includes(nextStepIndex)) {
      warmup.attemptedStepIndexes.push(nextStepIndex)
    }
    saveDeliveryTask(task, task.id)
    logBatchDiagnostic('投递池首次补充步骤完成', {
      ...summarizeTask(task),
      stepIndex: nextStepIndex,
      step: getTaskStepLabel(step),
      activated,
      attemptedStepIndexes: warmup.attemptedStepIndexes,
    })
  }
  return false
}

async function activateWarmupStep(
  task: DeliveryTask,
  stepIndex: number,
  runToken: DeliveryRunToken,
  detail: {
    missingSources: DeliveryLimitSource[]
    plan: ReturnType<typeof buildDeliveryBatchPlan>
    pools: {
      group: MyJobListData[]
      search: MyJobListData[]
    }
  },
) {
  const step = task.steps[stepIndex]
  if (step == null) return false
  if (
    inferDeliveryLimitSource() === step.source &&
    (step.source === 'group' || isSearchStepLocation(step))
  ) {
    task.currentIndex = stepIndex
    step.status = 'running'
    step.resumeNavigationAttempt = undefined
    setDeliveryLimitSourceOverride(step.source)
    saveDeliveryTask(task, task.id)
    const expectationReady = await ensureGroupExpectationStep(
      step,
      runToken,
      '投递池首次补充当前求职期望',
    )
    if (!canContinueDeliveryRun(runToken)) return false
    const ready =
      expectationReady &&
      (await waitForJobListReady(
        step.source,
        step.source === 'group' ? step.expectation?.id : undefined,
      ))
    if (!ready) {
      logBatchDiagnostic('投递池首次补充：当前步骤岗位为空或未就绪', {
        ...summarizeTask(task),
        stepIndex,
        step: getTaskStepLabel(step),
      })
      if (isCurrentJobListKnownEmpty()) {
        step.prefetchExhausted = true
        step.status = 'done'
        saveDeliveryTask(task, task.id)
        return true
      }
    }
    return ready
  }

  const switchResult = await switchToSourceForPrefetch(task, runToken, step.source, detail, {
    acceptEmptyPage: true,
    targetStepIndex: stepIndex,
  })
  if (switchResult !== 'switched' && isCurrentJobListKnownEmpty()) {
    step.prefetchExhausted = true
    step.status = 'done'
    step.resumeNavigationAttempt = undefined
    saveDeliveryTask(task, task.id)
    return true
  }
  return switchResult === 'switched'
}

/** 补池结果：运行已终止 / 池子确实变大了 / 当前来源抓不动了。 */
type PrefetchOutcome = 'finished' | 'grew' | 'exhausted'

async function prefetchCurrentSourceIfLowWater(
  task: DeliveryTask,
  runToken: DeliveryRunToken,
  source: DeliveryLimitSource,
  plan: ReturnType<typeof buildDeliveryBatchPlan>,
): Promise<PrefetchOutcome> {
  const poolSize = getDeliverableJobs(getConfiguredSourcePool(source)).length
  const lowWaterMark = getSourcePoolLowWaterMark(source)
  // 单来源已经够深：整池低水位由另一个来源造成，这里无需抓取。
  if (poolSize >= lowWaterMark) return 'exhausted'

  logBatchDiagnostic('混合投递池低水位补充', {
    ...summarizeTask(task),
    source,
    poolSize,
    lowWaterMark,
    plan,
    targetSize: getSourcePoolTargetSize(source),
  })
  const prepared = await prepareCurrentSourceForPrefetch(task, runToken, source)
  if (!prepared) return 'finished'
  const result = await prefetchCurrentSourcePool(task, source, runToken)
  if (result.outcome === 'load-failed') {
    logBatchDiagnostic('混合投递池低水位来源补充失败，继续处理现有岗位', {
      ...summarizeTask(task),
      source,
      result,
    })
  }
  if (result.outcome === 'load-failed' || result.outcome === 'source-exhausted') {
    return 'exhausted'
  }
  return result.after > result.before ? 'grew' : 'exhausted'
}

/** 池子未达目标容量时的补充，与低水位补充共用同一套执行步骤，只是不看低水位线。 */
async function prefetchUnderfilledCurrentSource(
  task: DeliveryTask,
  runToken: DeliveryRunToken,
  source: DeliveryLimitSource,
): Promise<PrefetchOutcome> {
  const prepared = await prepareCurrentSourceForPrefetch(task, runToken, source)
  if (!prepared) return 'finished'
  const result = await prefetchCurrentSourcePool(task, source, runToken)
  if (result.outcome === 'load-failed') {
    logBatchDiagnostic('混合投递池来源补充失败，继续其他来源或已有岗位', {
      ...summarizeTask(task),
      source,
      prefetchResult: result,
    })
  }
  return result.after > result.before ? 'grew' : 'exhausted'
}

async function prepareCurrentSourceForPrefetch(
  task: DeliveryTask,
  runToken: DeliveryRunToken,
  source: DeliveryLimitSource,
) {
  const currentStep = getCurrentTaskStep(task)
  if (
    source === 'search' &&
    currentStep?.source === 'search' &&
    !isSearchStepLocation(currentStep)
  ) {
    const previousListSignature = getCurrentJobListSignature()
    setDeliveryLimitSourceOverride(source)
    prepareStepNavigation(task, currentStep)
    logBatchDiagnostic('混合投递池回到当前搜索方向补充', {
      ...summarizeTask(task),
      currentDirection: currentStep.searchDirection ?? null,
      currentUrl: location.href,
      targetUrl: currentStep.url,
    })
    await flushRunState('混合投递池回到当前搜索方向补充')
    if (!canContinueDeliveryRun(runToken)) return false
    const navigated = await navigateToStep(
      currentStep.url,
      '混合投递池回到当前搜索方向补充',
      runToken,
    )
    if (!navigated || !canContinueDeliveryRun(runToken)) return false
    const ready = await waitForSearchStepReadyAfterNavigation(
      currentStep,
      previousListSignature,
      '混合投递池回到当前搜索方向补充',
    )
    if (ready) {
      currentStep.resumeNavigationAttempt = undefined
      saveDeliveryTask(task, task.id)
      touchDeliveryTaskHeartbeat(task)
    }
    return ready
  }

  const sourceSteps = task.steps.filter(
    (step) => step.source === source && step.status !== 'done' && !step.prefetchExhausted,
  )
  if (sourceSteps.length <= 1) return true

  const nextIndex = findNextTaskStepIndexBySource(task, source)
  const nextStep = nextIndex >= 0 ? task.steps[nextIndex] : null
  if (nextStep == null || isSameTaskStep(currentStep, nextStep)) return true

  const previousListSignature = getCurrentJobListSignature()
  task.currentIndex = nextIndex
  nextStep.status = 'running'
  nextStep.resumeNavigationAttempt = undefined
  setDeliveryLimitSourceOverride(source)

  if (source === 'search') {
    prepareStepNavigation(task, nextStep)
    logBatchDiagnostic('混合投递池轮转搜索方向补充', {
      ...summarizeTask(task),
      fromDirection: currentStep?.searchDirection ?? null,
      nextDirection: nextStep.searchDirection ?? null,
      targetUrl: nextStep.url,
    })
    await flushRunState('混合投递池轮转搜索方向补充')
    if (!canContinueDeliveryRun(runToken)) return false
    const navigated = await navigateToStep(nextStep.url, '混合投递池轮转搜索方向补充', runToken)
    if (!navigated || !canContinueDeliveryRun(runToken)) return false
    const ready = await waitForSearchStepReadyAfterNavigation(
      nextStep,
      previousListSignature,
      '混合投递池轮转搜索方向补充',
    )
    if (ready) {
      nextStep.resumeNavigationAttempt = undefined
      saveDeliveryTask(task, task.id)
      touchDeliveryTaskHeartbeat(task)
    }
    return ready
  }

  saveDeliveryTask(task, task.id)
  touchDeliveryTaskHeartbeat(task)
  logBatchDiagnostic('混合投递池轮转求职期望补充', {
    ...summarizeTask(task),
    fromExpectation: currentStep?.expectation ? getExpectationLabel(currentStep.expectation) : null,
    nextExpectation: nextStep.expectation ? getExpectationLabel(nextStep.expectation) : null,
  })
  return ensureGroupExpectationStep(nextStep, runToken, '混合投递池轮转求职期望补充')
}

function getPrefetchPool(task: DeliveryTask, source: DeliveryLimitSource) {
  const pool = getConfiguredSourcePool(source)
  const expectation = source === 'group' ? getCurrentTaskStep(task)?.expectation : undefined
  if (!expectation) return pool
  return filterJobsByGroupTargets(
    pool,
    isRecommendationExpectation(expectation) ? [] : [expectation.id],
    isRecommendationExpectation(expectation),
  )
}

function getPrefetchTargetSize(task: DeliveryTask, source: DeliveryLimitSource) {
  const sourceTarget = getSourcePoolTargetSize(source)
  if (sourceTarget <= 0) return 0
  if (source === 'search') {
    const searchStepCount = task.steps.filter((step) => step.source === 'search').length
    if (searchStepCount <= 1) return sourceTarget
    const currentStep = getCurrentTaskStep(task)
    const entrySize = Math.max(0, currentStep?.poolSizeAtEntry ?? 0)
    const directionShare = Math.max(1, Math.ceil(sourceTarget / searchStepCount))
    return Math.min(sourceTarget, entrySize + directionShare)
  }
  const expectationCount = task.steps.filter(
    (step) => step.source === 'group' && step.expectation != null,
  ).length
  return expectationCount > 0
    ? Math.max(1, Math.ceil(sourceTarget / expectationCount))
    : sourceTarget
}

function getSourcePoolTargetSize(source: DeliveryLimitSource) {
  return buildDeliveryBatchPlan({
    batchSize: deliveryPoolBatchTargetSize,
    weights: {
      group: getConfiguredSourceWeight('group'),
      search: getConfiguredSourceWeight('search'),
    },
  })[source]
}

function getSourcePoolLowWaterMark(source: DeliveryLimitSource) {
  return Math.min(sourcePoolMaxLowWaterMark, getSourcePoolTargetSize(source))
}

async function prefetchCurrentSourcePool(
  task: DeliveryTask,
  source: DeliveryLimitSource,
  runToken: DeliveryRunToken,
) {
  setDeliveryLimitSourceOverride(source)
  await refreshDeliveredKeys()
  pruneDeliveredCompanySiblings()
  const currentStep = getCurrentTaskStep(task)
  const groupTargetId = source === 'group' ? currentStep?.expectation?.id : undefined
  const targetSize = getPrefetchTargetSize(task, source)
  const before = getDeliverableJobs(getPrefetchPool(task, source)).length
  const initialCaptured = captureCurrentPageToDeliveryPool(source, groupTargetId)
  if (currentStep != null) {
    currentStep.pagesDone = Math.max(currentStep.pagesDone, Number(page.value.page) || 1)
    saveDeliveryTask(task, task.id)
  }
  logBatchDiagnostic('混合投递池补充当前来源', {
    source,
    expectId: getCurrentTaskStep(task)?.expectation?.id ?? null,
    before,
    captured: initialCaptured,
    lowWaterMark: getSourcePoolLowWaterMark(source),
    targetSize,
    maxPages: sourcePoolPrefetchMaxPages,
    page: Number(page.value.page) || null,
  })

  let loadedPages = 0
  let capturedTotal = initialCaptured
  let outcome:
    | 'target-reached'
    | 'source-exhausted'
    | 'page-budget-reached'
    | 'load-failed'
    | 'stopped' = 'target-reached'
  if (isCurrentJobListKnownEmpty()) {
    outcome = 'source-exhausted'
  }
  while (
    outcome === 'target-reached' &&
    loadedPages < sourcePoolPrefetchMaxPages &&
    getDeliverableJobs(getPrefetchPool(task, source)).length < targetSize
  ) {
    const beforePageSnapshot = getCurrentJobListSnapshot()
    const beforePoolSize = getDeliverableJobs(getPrefetchPool(task, source)).length
    const pageNextWaitMs = sampleHumanDelayMs(builtInDeliveryPageNextTypicalSeconds * 1000, {
      p90Ms: builtInDeliveryPageNextP90Seconds * 1000,
      minMs: 8000,
      maxMs: 4 * 60_000,
    })
    logPaginationDiagnostic('混合投递池准备抓取下一页', {
      source,
      loadedPages,
      poolSize: beforePoolSize,
      targetSize,
      page: Number(page.value.page) || null,
      firstJobId: beforePageSnapshot.jobIds[0] ?? '',
      waitSeconds: Math.round(pageNextWaitMs / 1000),
    })
    await delay(pageNextWaitMs / 1000)
    if (!canContinueDeliveryRun(runToken)) {
      outcome = 'stopped'
      break
    }
    await acquireBossAction('pageNext', {
      shouldAbort: () => common.deliverStop,
      onWait: (waitMs) => logPaginationDiagnostic('翻页被闸门限速', { waitMs }),
    })
    if (!next()) {
      outcome = 'source-exhausted'
      logBatchDiagnostic('混合投递池补充停止：没有下一页', {
        source,
        loadedPages,
        poolSize: getDeliverableJobs(getPrefetchPool(task, source)).length,
      })
      break
    }
    await refreshBossRuntimeBinding('混合投递池抓取下一页')
    const pageResult = await waitForSourcePoolGrowth(
      task,
      source,
      beforePoolSize,
      beforePageSnapshot,
      groupTargetId,
    )
    if (!pageResult) {
      outcome = 'load-failed'
      logBatchDiagnostic('混合投递池补充停止：下一页加载失败', {
        source,
        loadedPages,
        poolSize: getDeliverableJobs(getPrefetchPool(task, source)).length,
      })
      break
    }
    capturedTotal += pageResult.queueCapturedCount
    loadedPages += 1
    if (currentStep != null) {
      currentStep.pagesDone = Math.max(currentStep.pagesDone + 1, Number(page.value.page) || 0)
      saveDeliveryTask(task, task.id)
    }
  }
  const after = getDeliverableJobs(getPrefetchPool(task, source)).length
  if (
    outcome === 'target-reached' &&
    after < targetSize &&
    loadedPages >= sourcePoolPrefetchMaxPages
  ) {
    outcome = 'page-budget-reached'
  }

  logBatchDiagnostic('混合投递池当前来源补充完成', {
    source,
    before,
    after,
    loadedPages,
    captured: capturedTotal,
    deliverableAdded: Math.max(0, after - before),
    outcome,
    targetSize,
  })
  return {
    after,
    before,
    loadedPages,
    outcome,
  }
}

function getCurrentJobListSnapshot(): JobListSnapshot {
  return {
    page: Number(page.value.page) || 0,
    listRevision: Number(jobList.listRevision) || 0,
    jobIds: jobList._list.value.map((item) => item.encryptJobId).filter(Boolean),
  }
}

async function waitForSourcePoolGrowth(
  task: DeliveryTask,
  source: DeliveryLimitSource,
  beforePoolSize: number,
  beforePageSnapshot: JobListSnapshot,
  groupTargetId?: string,
) {
  const startedAt = Date.now()
  const deadline = startedAt + sourcePoolPrefetchPageTimeoutMs
  let nextRuntimeRefreshAt = startedAt + builtInDeliveryPageRuntimeRefreshIntervalMs
  logPaginationDiagnostic('等待混合投递池下一页加载', {
    source,
    beforePoolSize,
    previousFirstJobId: beforePageSnapshot.jobIds[0] ?? '',
    timeoutMs: sourcePoolPrefetchPageTimeoutMs,
  })
  while (Date.now() < deadline) {
    if (common.deliverStop) return false
    let poolSize = getDeliverableJobs(getPrefetchPool(task, source)).length
    const currentPageSnapshot = getCurrentJobListSnapshot()
    if (poolSize > beforePoolSize) {
      logPaginationDiagnostic('混合投递池下一页已进入投递池', {
        source,
        beforePoolSize,
        poolSize,
        previousFirstJobId: beforePageSnapshot.jobIds[0] ?? '',
        currentFirstJobId: currentPageSnapshot.jobIds[0] ?? '',
        waitedMs: Date.now() - startedAt,
        timeoutMs: sourcePoolPrefetchPageTimeoutMs,
      })
      return {
        queueCapturedCount: Math.max(0, poolSize - beforePoolSize),
      }
    }
    const pageDelta = diffJobListSnapshot(beforePageSnapshot, currentPageSnapshot)
    if (pageDelta.responded) {
      const queueCapturedCount = captureCurrentPageToDeliveryPool(source, groupTargetId)
      poolSize = getDeliverableJobs(getPrefetchPool(task, source)).length
      const deliverablePoolAdded = Math.max(0, poolSize - beforePoolSize)
      const pageNewJobCount = pageDelta.addedJobIds.length
      if (poolSize > beforePoolSize) {
        logPaginationDiagnostic('混合投递池下一页已进入投递池', {
          source,
          beforePoolSize,
          poolSize,
          previousFirstJobId: beforePageSnapshot.jobIds[0] ?? '',
          currentFirstJobId: currentPageSnapshot.jobIds[0] ?? '',
          pageNewJobCount,
          queueCapturedCount,
          deliverablePoolAdded,
          waitedMs: Date.now() - startedAt,
          timeoutMs: sourcePoolPrefetchPageTimeoutMs,
        })
        return { queueCapturedCount }
      }
      logPaginationDiagnostic('混合投递池页面已响应，投递池净新增为 0', {
        source,
        beforePoolSize,
        poolSize,
        previousFirstJobId: beforePageSnapshot.jobIds[0] ?? '',
        currentFirstJobId: currentPageSnapshot.jobIds[0] ?? '',
        pageNewJobCount,
        queueCapturedCount,
        deliverablePoolAdded,
        duplicateOrIneligibleCount: Math.max(0, pageNewJobCount - deliverablePoolAdded),
        waitedMs: Date.now() - startedAt,
        timeoutMs: sourcePoolPrefetchPageTimeoutMs,
      })
      return { queueCapturedCount }
    }
    if (Date.now() >= nextRuntimeRefreshAt) {
      await refreshBossRuntimeBinding('等待混合投递池下一页加载')
      nextRuntimeRefreshAt = Date.now() + builtInDeliveryPageRuntimeRefreshIntervalMs
    }
    await delay(0.5)
  }
  logPaginationDiagnostic('混合投递池等待下一页超时', {
    source,
    beforePoolSize,
    poolSize: getDeliverableJobs(getPrefetchPool(task, source)).length,
    previousFirstJobId: beforePageSnapshot.jobIds[0] ?? '',
    currentFirstJobId: jobList._list.value[0]?.encryptJobId ?? '',
    waitedMs: Date.now() - startedAt,
    timeoutMs: sourcePoolPrefetchPageTimeoutMs,
  })
  return null
}

async function switchToSourceForPrefetch(
  task: DeliveryTask,
  runToken: DeliveryRunToken,
  source: DeliveryLimitSource,
  detail: {
    missingSources: DeliveryLimitSource[]
    plan: ReturnType<typeof buildDeliveryBatchPlan>
    pools: {
      group: MyJobListData[]
      search: MyJobListData[]
    }
  },
  options: {
    acceptEmptyPage?: boolean
    targetStepIndex?: number
  } = {},
) {
  const requestedStep = options.targetStepIndex == null ? null : task.steps[options.targetStepIndex]
  const nextIndex =
    requestedStep?.source === source && requestedStep.status !== 'done'
      ? options.targetStepIndex!
      : findNextTaskStepIndexBySource(task, source)
  const nextStep = nextIndex >= 0 ? task.steps[nextIndex] : null
  if (nextStep == null) {
    logBatchDiagnostic('混合投递池补充跳过：没有可用目标来源步骤', {
      ...summarizeTask(task),
      targetSource: source,
      missingSources: detail.missingSources,
    })
    return 'skipped' as const
  }

  const previousListSignature = getCurrentJobListSignature()
  task.currentIndex = nextIndex
  nextStep.status = 'running'
  prepareStepNavigation(task, nextStep)
  logBatchDiagnostic('混合投递池切换来源补充', {
    ...summarizeTask(task),
    targetSource: source,
    targetUrl: nextStep.url,
    missingSources: detail.missingSources,
    plan: detail.plan,
    pools: summarizePools(detail.pools),
    nextAction: '站内路由切到缺失来源，一次补充多页投递池岗位',
  })
  await flushRunState('混合投递池切换来源补充')
  if (!canContinueDeliveryRun(runToken)) return 'stopped' as const
  jobList.setDeliveryPoolCaptureEnabled(false)
  const navigated = await navigateToStep(nextStep.url, '混合投递池切换来源补充', runToken)
  if (!canContinueDeliveryRun(runToken)) {
    jobList.setDeliveryPoolCaptureEnabled(true)
    return 'stopped' as const
  }
  if (!navigated) {
    jobList.setDeliveryPoolCaptureEnabled(true)
    markAcquisitionStepUnavailable(task, nextStep, '投递池补充切换来源失败')
    return 'skipped' as const
  }
  setDeliveryLimitSourceOverride(source)
  const expectationReady = await ensureGroupExpectationStep(
    nextStep,
    runToken,
    '混合投递池切换求职期望补充',
  )
  if (!canContinueDeliveryRun(runToken) || !expectationReady) {
    jobList.setDeliveryPoolCaptureEnabled(true)
    saveDeliveryTask(task, task.id)
    if (!canContinueDeliveryRun(runToken)) return 'stopped' as const
    if (!options.acceptEmptyPage) return 'waiting' as const
    logBatchDiagnostic('投递池补充：求职期望当前页为空或未就绪', {
      ...summarizeTask(task),
      targetSource: source,
      targetStepIndex: nextIndex,
    })
    markAcquisitionStepUnavailable(task, nextStep, '求职期望岗位列表未就绪')
    return 'skipped' as const
  }
  const ready =
    nextStep.source === 'search'
      ? await waitForSearchStepReadyAfterNavigation(
          nextStep,
          previousListSignature,
          '混合投递池切换来源补充',
        )
      : await waitForSourceReadyAfterNavigation(
          source,
          '混合投递池切换来源补充',
          previousListSignature,
        )
  jobList.setDeliveryPoolCaptureEnabled(true)
  if (!canContinueDeliveryRun(runToken)) return 'stopped' as const
  if (!ready) {
    saveDeliveryTask(task, task.id)
    if (!options.acceptEmptyPage) return 'waiting' as const
    logBatchDiagnostic('投递池补充：目标来源当前页为空', {
      ...summarizeTask(task),
      targetSource: source,
      targetStepIndex: nextIndex,
    })
    markAcquisitionStepUnavailable(task, nextStep, '目标来源岗位列表未就绪')
    return 'skipped' as const
  }
  nextStep.resumeNavigationAttempt = undefined
  saveDeliveryTask(task, task.id)
  return 'switched' as const
}

function finalizeDrainedPrefetchSteps(
  task: DeliveryTask,
  pools: Record<DeliveryLimitSource, MyJobListData[]>,
) {
  let changed = false
  for (const step of task.steps) {
    if (!step.prefetchExhausted || pools[step.source].length > 0) continue
    if (step.status !== 'done') {
      step.status = 'done'
      changed = true
    }
  }

  const currentStep = getCurrentTaskStep(task)
  if (
    currentStep?.status === 'done' &&
    currentStep.prefetchExhausted &&
    pools[currentStep.source].length === 0
  ) {
    const nextIndex = task.steps.findIndex((step) => step.status !== 'done')
    if (nextIndex !== task.currentIndex) {
      task.currentIndex = nextIndex
      changed = true
    }
  }
  return changed
}

async function waitForSourceReadyAfterNavigation(
  source: DeliveryLimitSource,
  reason: string,
  previousListSignature = '',
) {
  const startedAt = Date.now()
  const deadline = startedAt + resumeNavigationPendingTimeoutMs
  while (Date.now() < deadline) {
    if (common.deliverStop) return false
    const actualSource = inferDeliveryLimitSource()
    if (actualSource === source) {
      await refreshBossRuntimeBinding(`${reason}后等待目标来源`)
      const listLength = jobList._list.value.length
      const currentListSignature = getCurrentJobListSignature()
      const poolSize = getDeliverableJobs(getConfiguredSourcePool(source)).length
      if (
        listLength > 0 &&
        currentListSignature &&
        (!previousListSignature || currentListSignature !== previousListSignature || poolSize > 0)
      ) {
        captureCurrentPageToDeliveryPool(source)
        logBatchDiagnostic('来源切换后目标来源已就绪', {
          reason,
          source,
          listLength,
          poolSize,
          waitedMs: Date.now() - startedAt,
          timeoutMs: resumeNavigationPendingTimeoutMs,
        })
        return true
      }
      if (isCurrentJobListKnownEmpty()) {
        logBatchDiagnostic('来源切换后目标来源为空', {
          reason,
          source,
          waitedMs: Date.now() - startedAt,
        })
        return true
      }
    }
    await delay(0.5)
  }
  logBatchDiagnostic('来源切换后等待目标来源超时', {
    reason,
    source,
    actualSource: inferDeliveryLimitSource(),
    poolSize: getDeliverableJobs(getConfiguredSourcePool(source)).length,
    waitedMs: Date.now() - startedAt,
    timeoutMs: resumeNavigationPendingTimeoutMs,
  })
  return false
}

function getCurrentJobListSignature() {
  return jobList._list.value
    .slice(0, 8)
    .map((item) => getDeliveryJobKey(item))
    .join('|')
}

function getCurrentSearchPoolSize() {
  return getDeliverableJobs(getConfiguredSourcePool('search')).length
}

async function waitForSearchStepReadyAfterNavigation(
  step: DeliveryTask['steps'][number],
  previousListSignature: string,
  reason: string,
) {
  const startedAt = Date.now()
  const deadline = startedAt + resumeNavigationPendingTimeoutMs
  let triggeredRuntimeVue: unknown
  let searchTriggered = false
  let triggerRevision = Number(jobList.listRevision) || 0
  while (Date.now() < deadline) {
    if (common.deliverStop) return false
    if (isSearchStepLocation(step)) {
      const bound = await refreshBossRuntimeBinding(`${reason}：读取搜索方向岗位`)
      if (!bound) return false
      const runtimeVue = document.querySelector<any>(
        '#wrap .page-job-wrapper,.job-recommend-main,.page-jobs-main',
      )?.__vue__
      const runtimeKey = runtimeVue ?? 'current-runtime'
      if (!searchTriggered || runtimeKey !== triggeredRuntimeVue) {
        const reload = pager.reload
        if (typeof reload !== 'function') {
          logBatchDiagnostic('搜索方向岗位加载失败：搜索动作不可用', {
            reason,
            direction: step.searchDirection ?? null,
          })
          return false
        }
        triggerRevision = Number(jobList.listRevision) || 0
        try {
          await Promise.resolve(reload(1))
          triggeredRuntimeVue = runtimeKey
          searchTriggered = true
          logBatchDiagnostic('已执行目标搜索方向查询', {
            reason,
            direction: step.searchDirection ?? null,
            targetUrl: step.url,
          })
        } catch (error) {
          logBatchDiagnostic('搜索方向岗位加载失败：执行搜索动作失败', {
            reason,
            direction: step.searchDirection ?? null,
            error: error instanceof Error ? error.message : String(error),
          })
          return false
        }
      }
      const currentSignature = getCurrentJobListSignature()
      const listUpdatedAfterSearch =
        (Number(jobList.listRevision) || 0) > triggerRevision ||
        (currentSignature.length > 0 && currentSignature !== previousListSignature)
      if (currentSignature && searchTriggered && listUpdatedAfterSearch) {
        captureCurrentPageToDeliveryPool('search')
        logBatchDiagnostic('搜索方向岗位列表已就绪', {
          reason,
          direction: step.searchDirection ?? null,
          listLength: jobList._list.value.length,
          waitedMs: Date.now() - startedAt,
        })
        logBatchDiagnostic('来源切换后目标来源已就绪', {
          reason,
          source: 'search',
          direction: step.searchDirection ?? null,
          poolSize: getDeliverableJobs(getConfiguredSourcePool('search')).length,
          waitedMs: Date.now() - startedAt,
          timeoutMs: resumeNavigationPendingTimeoutMs,
        })
        return true
      }
      if (searchTriggered && listUpdatedAfterSearch && isCurrentJobListKnownEmpty()) {
        logBatchDiagnostic('搜索方向岗位列表为空', {
          reason,
          direction: step.searchDirection ?? null,
          waitedMs: Date.now() - startedAt,
        })
        return true
      }
    }
    await delay(0.5)
  }
  logBatchDiagnostic('搜索方向岗位列表等待超时', {
    reason,
    direction: step.searchDirection ?? null,
    targetUrl: step.url,
    listLength: jobList._list.value.length,
    waitedMs: Date.now() - startedAt,
  })
  return false
}

function markAcquisitionStepUnavailable(
  task: DeliveryTask,
  step: DeliveryTask['steps'][number],
  reason: string,
) {
  step.prefetchExhausted = true
  step.status = 'done'
  step.resumeNavigationAttempt = undefined
  saveDeliveryTask(task, task.id)
  logBatchDiagnostic('当前取岗步骤本轮不可用，继续其他步骤', {
    ...summarizeTask(task),
    step: getTaskStepLabel(step),
    source: step.source,
    reason,
  })
}

async function finishCurrentStep(task: DeliveryTask, runToken: DeliveryRunToken) {
  const previousStep = getCurrentTaskStep(task)
  markCurrentStepDone(task)
  const nextStep = getNextRunnableStep(task)
  if (nextStep == null) {
    logBatchDiagnostic('当前取岗轮次完成：准备下一轮', summarizeTask(task))
    await flushRunState()
    if (!canContinueDeliveryRun(runToken)) return true
    // 只有换轮成功才继续本轮循环；'waiting' 与 'stopped' 都退出，由各自路径负责后续。
    return (await restartAcquisitionCycle(task, runToken)) !== 'continue'
  }
  task.currentIndex = task.steps.indexOf(nextStep)
  nextStep.status = 'running'
  if (
    nextStep.source === previousStep?.source &&
    isSameNavigationLocation(location.href, nextStep.url)
  ) {
    nextStep.resumeNavigationAttempt = undefined
    setDeliveryLimitSourceOverride(nextStep.source)
    saveDeliveryTask(task, task.id)
    touchDeliveryTaskHeartbeat(task)
    const ready = await ensureGroupExpectationStep(nextStep, runToken, '切换到下一求职期望')
    if (!ready) {
      logBatchDiagnostic('当前来源完成：下一求职期望不可用', {
        ...summarizeTask(task),
        expectation: nextStep.expectation ? getExpectationLabel(nextStep.expectation) : null,
      })
      markAcquisitionStepUnavailable(task, nextStep, '下一求职期望岗位列表不可用')
      return await finishCurrentStep(task, runToken)
    }
    return false
  }
  prepareStepNavigation(task, nextStep)
  logBatchDiagnostic('当前来源完成：切换到下一步', {
    ...summarizeTask(task),
    nextSource: nextStep.source,
    nextUrl: nextStep.url,
  })
  AgentMessage.info(`切换到${getTaskStepLabel(nextStep)}继续投递`)
  await delay(1)
  if (!canContinueDeliveryRun(runToken)) return true
  await flushRunState('切换来源')
  if (!canContinueDeliveryRun(runToken)) return true
  jobList.setDeliveryPoolCaptureEnabled(false)
  const navigated = await navigateToStep(nextStep.url, '当前来源完成切换下一来源', runToken)
  if (!navigated) {
    jobList.setDeliveryPoolCaptureEnabled(true)
    markAcquisitionStepUnavailable(task, nextStep, '当前来源完成后切换下一来源失败')
    return await finishCurrentStep(task, runToken)
  }
  return true
}

async function rotateToNextPool(task: DeliveryTask, runToken: DeliveryRunToken) {
  const currentStep = getCurrentTaskStep(task)
  const currentSource = currentStep?.source
  const previousListSignature = getCurrentJobListSignature()
  let nextStep = rotateToNextTaskStep(task)
  if (nextStep == null) {
    logBatchDiagnostic('轮转下一来源结束：准备下一轮取岗', summarizeTask(task))
    await flushRunState()
    return !(await restartAcquisitionCycle(task, runToken))
  }
  if (isSameTaskStep(nextStep, currentStep)) {
    saveDeliveryTask(task, task.id)
    logBatchDiagnostic('当前来源继续下一页', {
      ...summarizeTask(task),
      source: nextStep.source,
      pagesDone: nextStep.pagesDone,
    })
    return false
  }
  if (nextStep.source === currentSource && isSameNavigationLocation(location.href, nextStep.url)) {
    nextStep.status = 'running'
    nextStep.resumeNavigationAttempt = undefined
    setDeliveryLimitSourceOverride(nextStep.source)
    saveDeliveryTask(task, task.id)
    touchDeliveryTaskHeartbeat(task)
    logBatchDiagnostic('轮转到下一求职期望', {
      ...summarizeTask(task),
      fromExpectation: currentStep?.expectation
        ? getExpectationLabel(currentStep.expectation)
        : null,
      nextExpectation: nextStep.expectation ? getExpectationLabel(nextStep.expectation) : null,
    })
    const ready = await ensureGroupExpectationStep(nextStep, runToken, '轮转到下一求职期望')
    if (!ready) {
      markAcquisitionStepUnavailable(task, nextStep, '轮转到下一求职期望失败')
      return await finishCurrentStep(task, runToken)
    }
    saveDeliveryTask(task, task.id)
    return false
  }
  logBatchDiagnostic('轮转到下一来源', {
    ...summarizeTask(task),
    fromSource: currentSource,
    nextSource: nextStep.source,
    nextUrl: nextStep.url,
  })
  prepareStepNavigation(task, nextStep)
  AgentMessage.info(`切换到${getTaskStepLabel(nextStep)}继续投递`)
  await delay(1)
  if (!canContinueDeliveryRun(runToken)) return true
  await flushRunState('轮转到下一来源')
  if (!canContinueDeliveryRun(runToken)) return true
  jobList.setDeliveryPoolCaptureEnabled(false)
  const navigated = await navigateToStep(nextStep.url, '轮转到下一来源', runToken)
  if (!canContinueDeliveryRun(runToken)) {
    jobList.setDeliveryPoolCaptureEnabled(true)
    return true
  }
  if (!navigated) {
    jobList.setDeliveryPoolCaptureEnabled(true)
    markAcquisitionStepUnavailable(task, nextStep, '轮转到下一来源失败')
    return await finishCurrentStep(task, runToken)
  }
  setDeliveryLimitSourceOverride(nextStep.source)
  const expectationReady = await ensureGroupExpectationStep(nextStep, runToken, '轮转到下一来源')
  if (!canContinueDeliveryRun(runToken)) {
    jobList.setDeliveryPoolCaptureEnabled(true)
    return true
  }
  if (!expectationReady) {
    jobList.setDeliveryPoolCaptureEnabled(true)
    markAcquisitionStepUnavailable(task, nextStep, '轮转后求职期望岗位列表不可用')
    return await finishCurrentStep(task, runToken)
  }
  const ready =
    nextStep.source === 'search'
      ? await waitForSearchStepReadyAfterNavigation(
          nextStep,
          previousListSignature,
          '轮转到下一搜索方向',
        )
      : await waitForSourceReadyAfterNavigation(
          nextStep.source,
          '轮转到下一来源',
          previousListSignature,
        )
  jobList.setDeliveryPoolCaptureEnabled(true)
  if (!canContinueDeliveryRun(runToken)) return true
  if (!ready) {
    markAcquisitionStepUnavailable(task, nextStep, '轮转后目标来源岗位列表未就绪')
    return await finishCurrentStep(task, runToken)
  }
  nextStep.resumeNavigationAttempt = undefined
  saveDeliveryTask(task, task.id)
  return false
}

function getNextRunnableStep(task: DeliveryTask) {
  return task.steps.find((step) => step.status !== 'done') ?? null
}

async function jumpToTaskPage(targetPage: number, runToken: DeliveryRunToken) {
  let currentPage = Number(page.value.page) || 1
  while (currentPage < targetPage) {
    const beforePageSnapshot = getCurrentJobListSnapshot()
    const beforePageFirstJobId = beforePageSnapshot.jobIds[0] ?? ''
    const pageNextWaitMs = sampleHumanDelayMs(builtInDeliveryPageNextTypicalSeconds * 1000, {
      p90Ms: builtInDeliveryPageNextP90Seconds * 1000,
      minMs: 8000,
      maxMs: 4 * 60_000,
    })
    logPaginationDiagnostic('翻页前等待下一页触发', {
      currentPage,
      targetPage,
      page: Number(page.value.page) || null,
      listLength: jobList._list.value.length,
      firstJobId: beforePageFirstJobId,
      waitSeconds: Math.round(pageNextWaitMs / 1000),
    })
    await delay(pageNextWaitMs / 1000)
    if (!canContinueDeliveryRun(runToken)) return false
    logPaginationDiagnostic('准备触发下一页', {
      currentPage,
      targetPage,
      page: Number(page.value.page) || null,
      listLength: jobList._list.value.length,
      firstJobId: beforePageFirstJobId,
    })
    await acquireBossAction('pageNext', {
      shouldAbort: () => common.deliverStop,
      onWait: (waitMs) => logPaginationDiagnostic('翻页被闸门限速', { waitMs }),
    })
    if (!next()) return false
    logPaginationDiagnostic('等待下一页岗位列表加载', {
      currentPage,
      targetPage,
      page: Number(page.value.page) || null,
      previousFirstJobId: beforePageFirstJobId,
      listLength: jobList._list.value.length,
      timeoutMs: builtInDeliveryPageLoadTimeoutMs,
    })
    await refreshBossRuntimeBinding('触发下一页后')
    const changed = await waitForJobListChanged(beforePageSnapshot)
    if (!changed) return false
    currentPage = Math.max(currentPage + 1, Number(page.value.page) || currentPage)
  }
  return true
}

function logPaginationDiagnostic(message: string, detail: Record<string, unknown>) {
  log.info(
    '分页诊断',
    `${message}\n${JSON.stringify({
      ...detail,
      runtimeInstanceId: deliveryRuntimeInstanceId,
      securityCheck: new URL(location.href).searchParams.has('_security_check'),
      url: location.href,
    })}`,
  )
}

function summarizeTask(task: DeliveryTask) {
  const currentStep = getCurrentTaskStep(task)
  return {
    taskId: task.id,
    currentIndex: task.currentIndex,
    stepCount: task.steps.length,
    completedStepCount: task.steps.filter((step) => step.status === 'done').length,
    startedAt: task.startedAt,
    page: Number(page.value.page) || null,
    listLength: jobList._list.value.length,
    success: todayData.success,
    total: todayData.total,
    runtimeHeartbeat: task.runtimeHeartbeat,
    poolWarmup: task.poolWarmup,
    activeBatch: task.activeBatch
      ? {
          id: task.activeBatch.id,
          startedAt: task.activeBatch.startedAt,
          size: task.activeBatch.items.length,
        }
      : null,
    currentStep: currentStep
      ? {
          source: currentStep.source,
          expectId: currentStep.expectation?.id ?? null,
          expectation: currentStep.expectation
            ? getExpectationLabel(currentStep.expectation)
            : null,
          searchDirection: currentStep.searchDirection ?? null,
          status: currentStep.status,
          pagesDone: currentStep.pagesDone,
        }
      : null,
  }
}

function logBatchDiagnostic(message: string, detail: Record<string, unknown>) {
  log.info(
    '投递批次',
    `${message}\n${JSON.stringify({
      ...detail,
      runtimeInstanceId: deliveryRuntimeInstanceId,
      securityCheck: new URL(location.href).searchParams.has('_security_check'),
      url: location.href,
    })}`,
  )
}

async function navigateToStep(url: string, reason: string, runToken: DeliveryRunToken) {
  if (isSameNavigationLocation(location.href, url)) return true
  // 换来源、换搜索方向都会让 BOSS 重新加载一整页数据，代价不比翻页小，所以同样要过闸门。
  // 这一类原本只在闸门里定义了限额、没有任何调用点——那是看起来有覆盖、其实没有。
  await acquireBossAction('navigate', {
    shouldAbort: () => common.deliverStop,
    onWait: (waitMs) => logBatchDiagnostic('来源切换被闸门限速', { waitMs, reason, url }),
  })
  if (!canContinueDeliveryRun(runToken)) return false
  const target = new URL(url, location.origin)
  const route = `${target.pathname}${target.search}${target.hash}`
  try {
    const rootVue = await getRootVue()
    if (!canContinueDeliveryRun(runToken)) return false
    const push = rootVue?.$router?.push
    if (typeof push !== 'function') {
      throw new Error('BOSS SPA router unavailable')
    }
    logBatchDiagnostic('来源切换使用站内路由', {
      reason,
      targetUrl: url,
      route,
    })
    await push.call(rootVue.$router, route)
    if (!canContinueDeliveryRun(runToken)) return false
    return true
  } catch (error) {
    logBatchDiagnostic('来源切换失败：未执行整页刷新', {
      reason,
      targetUrl: url,
      route,
      error: error instanceof Error ? error.message : String(error),
    })
    logger.error('来源切换失败，已阻止整页刷新', error)
    return false
  }
}

function resetFilter() {
  const reset = jobList.resetPendingDeliveryPool()
  AgentMessage.info(reset > 0 ? `已重置 ${reset} 个岗位为待处理` : '投递池没有需要重置的岗位')
}
</script>

<template>
  <section class="operation-panel">
    <section class="operation-panel__instrument-head">
      <div class="operation-panel__capacity" :style="instrumentProgressStyle">
        <p>TODAY / DELIVERED</p>
        <strong
          >{{ formatInstrumentNumber(todayData.success, 3) }}
          <small>/ {{ dailyDeliveryLimit }}</small></strong
        >
        <div
          class="operation-panel__ruler"
          role="progressbar"
          aria-label="今日投递进度"
          aria-valuemin="0"
          :aria-valuemax="dailyDeliveryLimit"
          :aria-valuenow="todayData.success"
        />
      </div>
      <div class="operation-panel__hero-copy">
        <div class="operation-panel__task-meta">
          <span :class="['operation-panel__run-state', `is-${runState.type}`]">
            <i />
            {{ runState.label }}
          </span>
        </div>
        <h3>{{ taskTitle }}</h3>
        <span>{{ heroStatusText }}</span>
      </div>
      <div class="operation-panel__hero-actions operation-panel__command-bank">
        <AgentButton class="operation-panel__command-button" plain @click="emit('open-settings')">
          运行配置
        </AgentButton>
        <div class="operation-panel__command-group">
          <!-- 一个运行开关的三个状态：未开始只给「开始投递」，投递中只给「暂停」，
               暂停后才分叉成「继续」和「结束」——暂停是唯一需要用户二选一的状态。 -->
          <AgentButton
            v-if="isDeliveryActive"
            class="operation-panel__command-button is-warning"
            type="warning"
            @click="pauseDeliver"
          >
            <Pause :size="14" fill="currentColor" aria-hidden="true" />
            暂停
          </AgentButton>
          <template v-else-if="isDeliveryPaused">
            <AgentButton
              class="operation-panel__command-button is-primary"
              type="primary"
              @click="resumeFromPause"
            >
              <Play :size="15" :stroke-width="0" fill="currentColor" aria-hidden="true" />
              继续
            </AgentButton>
            <AgentButton
              class="operation-panel__command-button is-warning"
              type="warning"
              @click="stopDeliver"
            >
              <Square :size="14" fill="currentColor" aria-hidden="true" />
              结束
            </AgentButton>
          </template>
          <AgentButton
            v-else
            class="operation-panel__command-button is-primary"
            type="primary"
            :loading="common.deliverLock"
            @click="startBatch"
          >
            <Play :size="15" :stroke-width="0" fill="currentColor" aria-hidden="true" />
            开始投递
          </AgentButton>
          <AgentButton
            v-if="!isDeliveryActive && !isDeliveryPaused && common.deliverStop"
            class="operation-panel__command-button is-warning"
            type="warning"
            @click="resetFilter"
          >
            <RotateCcw :size="15" aria-hidden="true" />
            重置待处理
          </AgentButton>
        </div>
      </div>
    </section>

    <section class="operation-panel__summary">
      <div class="operation-panel__metric-card">
        <div>
          <p>投递成功率</p>
          <strong>{{ formatPercent(dashboard.summary.successRate) }}</strong>
        </div>
        <span>成功 {{ dashboard.summary.success }} · 处理 {{ dashboard.summary.processed }}</span>
      </div>
      <div class="operation-panel__metric-card">
        <div>
          <p>投递池待处理</p>
          <strong>{{ formatInstrumentNumber(dashboard.summary.pending, 3) }}</strong>
        </div>
        <span>
          求职期望 {{ dashboard.sources.group.pending }} · 搜索
          {{ dashboard.sources.search.pending }}
        </span>
      </div>
      <div class="operation-panel__metric-card">
        <div>
          <p>已获取 / 可重试</p>
          <strong>
            {{ formatInstrumentNumber(dashboard.summary.fetched, 3) }} /
            {{ formatInstrumentNumber(dashboard.summary.retryableFailures, 2) }}
          </strong>
        </div>
        <span>
          {{ queueContinuationText }}
        </span>
      </div>
    </section>

    <section class="operation-panel__dashboard-grid">
      <div class="operation-panel__dashboard-card operation-panel__dashboard-card--sources">
        <div class="operation-panel__section-head">
          <p>来源效率</p>
          <!-- 这张表按投递记录统计，而记录只保留最近 200 条；上方摘要用的是全量统计计数器。
               标明口径，免得两处数字对不上时被当成 bug。 -->
          <span>SOURCE / 按记录</span>
        </div>
        <div class="operation-panel__source-table" role="table" aria-label="来源效率">
          <div class="operation-panel__source-table-head" role="row">
            <span>来源</span>
            <span>获取</span>
            <span>处理</span>
            <span>成功</span>
            <span>过滤</span>
            <span>异常</span>
            <span>成功率</span>
          </div>
          <div
            v-for="item in sourceDashboardRows"
            :key="item.source"
            class="operation-panel__source-table-row"
            role="row"
          >
            <AgentButton
              v-if="item.source === 'group'"
              class="operation-panel__source-name"
              link
              @click="emit('show-group')"
            >
              {{ item.label }}
            </AgentButton>
            <span v-else class="operation-panel__source-name">{{ item.label }}</span>
            <span>{{ item.fetched }}</span>
            <span>{{ item.processed }}</span>
            <span>{{ item.success }}</span>
            <span>{{ item.filtered }}</span>
            <span>{{ item.failed }}</span>
            <span>{{ formatPercent(item.successRate) }}</span>
          </div>
        </div>
        <div class="operation-panel__section-head operation-panel__section-head--subsection">
          <p>失败归因</p>
          <span>FILTER / ERROR</span>
        </div>
        <div v-if="activeFailureCategories.length > 0" class="operation-panel__failure-list">
          <div
            v-for="item in activeFailureCategories"
            :key="item.id"
            class="operation-panel__failure-row"
          >
            <span>{{ item.label }}</span>
            <strong>{{ item.count }}</strong>
            <span>{{ failureCategoryHintMap[item.id] }}</span>
          </div>
        </div>
        <div v-else class="operation-panel__empty-state">暂无失败记录</div>
      </div>

      <div class="operation-panel__dashboard-card operation-panel__dashboard-card--sequence">
        <div class="operation-panel__section-head">
          <p>任务序列</p>
          <span>SEQUENCE</span>
        </div>
        <div class="operation-panel__sequence">
          <div
            v-for="item in taskSequence"
            :key="item.number"
            class="operation-panel__sequence-step"
          >
            <span class="operation-panel__step-number">{{ item.number }}</span>
            <span class="operation-panel__step-copy">
              <strong>{{ item.label }}</strong>
              <span>{{ item.description }}</span>
            </span>
            <i :class="['operation-panel__step-signal', `is-${item.state}`]" />
          </div>
        </div>
      </div>
    </section>

    <section class="operation-panel__status-strip">
      <p>运行参数</p>
      <div>
        <span v-for="item in compactStatusItems" :key="item">{{ item }}</span>
      </div>
    </section>
  </section>
</template>
