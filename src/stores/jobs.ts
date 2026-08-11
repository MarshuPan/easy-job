import { reactive, ref } from 'vue'

import { checkJobCache, getCacheManager, requestDetail } from '@/composables/useApplying'
import { useHookVueData, useHookVueFn } from '@/composables/useVue'
import {
  normalizeDeliverySourceKey,
  type DeliveryQueueConfigScope,
} from '@/delivery/configSnapshot'
import { counter } from '@/message'
import {
  getDeliveryLimitSource,
  type DeliveryLimitSource,
} from '@/pages/zhipin/utils/deliveryLimit'
import { JobUnavailableError } from '@/types/deliverError'
import type { FormData } from '@/types/formData'
import { getCurDay } from '@/utils'
import { createAccountStorageKey, normalizeAccountUid } from '@/utils/accountStorage'
import { logger } from '@/utils/logger'
import { createStorageMutex } from '@/utils/storageMutex'

import { useLog } from './log'

export type EncryptJobId = bossZpJobItemData['encryptJobId']
export type JobStatus = 'pending' | 'wait' | 'running' | 'success' | 'filtered' | 'error' | 'warn'
export interface DeliveryJobMetadata {
  /**
   * 入池时这个岗位所属求职期望的名字。
   *
   * 名字只存在于「当前启用」的求职期望列表里，期望被停用、或列表还没加载完，投递记录的
   * 来源列就只能退回笼统的「求职期望」——用户看不出这条是从「推荐」还是从「AI产品经理」
   * 来的。入池那一刻正在处理的就是这个期望，名字是确定的，刻下来就不会再丢。
   */
  deliveryGroupName?: string
  deliveryGroupTargetIds?: string[]
  deliveryQueueOrder?: number
  deliveryQueueSource?: DeliveryLimitSource
  deliverySearchDirectionKeys?: string[]
  fetchedAt?: number
  retryAttempts?: number
}
export type MyJobListData = bossZpJobItemData & {
  card?: bossZpDetailData & bossZpCardData
  status: {
    status: JobStatus
    msg: string
    setStatus: (status: JobStatus, msg?: string) => void
  }
  getCard: () => Promise<bossZpCardData>
} & DeliveryJobMetadata

type PersistedJobStatus = {
  status?: JobStatus
  msg?: string
}

type PersistedSourceJob = bossZpJobItemData &
  DeliveryJobMetadata & {
    status?: PersistedJobStatus
  }

interface PersistedSourcePools {
  configFingerprint?: string
  date: string
  updatedAt: number
  sources: Record<DeliveryLimitSource, PersistedSourceJob[]>
}

export interface DeliveryQueueSnapshot {
  configFingerprint?: string
  date: string
  revision: number
  sources: Record<DeliveryLimitSource, MyJobListData[]>
  updatedAt: number
}

const sourcePoolsStorageKey = 'local:web-geek-job-SourcePools'
export const sourcePoolsSessionStorageKey = 'agent-delivery:source-pools:v1'
const sourcePoolPersistDebounceMs = 120
const maxPersistedSourceJobsPerSource = 300
const deliverySources: DeliveryLimitSource[] = ['group', 'search']
const sourcePoolsMutex = createStorageMutex('agent-delivery:source-pools')

/** 越靠后越终态；合并两个标签页的同一岗位时取更终态的一方，避免已投递岗位被重新排队。 */
const jobStatusFinality: Record<string, number> = {
  pending: 0,
  wait: 1,
  running: 2,
  filtered: 3,
  warn: 4,
  error: 5,
  success: 6,
}

/**
 * 合并两份投递池快照。
 *
 * 多个标签页各自持有内存副本，直接覆写会丢掉对方的岗位及其投递状态——被丢掉的
 * 已投递岗位会重新变成待处理，从而被重复投递。按 encryptJobId 合并：
 * 入池顺序取更早的（保持 FIFO），状态取更终态的一方。
 */
export function mergeSourcePoolSnapshots(
  stored: PersistedSourcePools | null,
  local: PersistedSourcePools,
): PersistedSourcePools {
  if (stored == null) return local
  // 配置作用域或日期变化时，旧快照已经不适用于当前这一轮，直接以本地为准。
  if (stored.configFingerprint !== local.configFingerprint || stored.date !== local.date) {
    return local
  }

  const sources = {} as PersistedSourcePools['sources']
  for (const source of deliverySources) {
    const merged = new Map<string, PersistedSourceJob>()
    for (const job of [...(stored.sources[source] ?? []), ...(local.sources[source] ?? [])]) {
      if (!isPersistedSourceJob(job)) continue
      const existing = merged.get(job.encryptJobId)
      if (existing == null) {
        merged.set(job.encryptJobId, job)
        continue
      }
      const existingFinality = jobStatusFinality[existing.status?.status ?? 'pending'] ?? 0
      const candidateFinality = jobStatusFinality[job.status?.status ?? 'pending'] ?? 0
      const winner = candidateFinality > existingFinality ? job : existing
      const existingOrder = safeNumber(existing.deliveryQueueOrder)
      const candidateOrder = safeNumber(job.deliveryQueueOrder)
      const earliestOrder = [existingOrder, candidateOrder].filter((value) => value > 0)
      merged.set(job.encryptJobId, {
        ...winner,
        deliveryQueueOrder:
          earliestOrder.length > 0 ? Math.min(...earliestOrder) : winner.deliveryQueueOrder,
      })
    }
    sources[source] = [...merged.values()]
      .sort(
        (left, right) => safeNumber(left.deliveryQueueOrder) - safeNumber(right.deliveryQueueOrder),
      )
      .slice(-maxPersistedSourceJobsPerSource)
  }

  return {
    ...local,
    sources,
    updatedAt: Math.max(safeNumber(stored.updatedAt), safeNumber(local.updatedAt)),
  }
}

function pickJobDetailSummary(detail?: bossZpDetailData) {
  if (!detail) return null
  return {
    encryptJobId: detail.jobInfo?.encryptId || '',
    securityId: detail.securityId || '',
    lid: detail.lid || '',
    jobName: detail.jobInfo?.jobName || '',
    brandName: detail.brandComInfo?.brandName || detail.bossInfo?.brandName || '',
  }
}

function shortValue(value?: string) {
  if (!value) return ''
  return value.length > 36 ? `${value.slice(0, 16)}...${value.slice(-8)}` : value
}

function formatJobDetailSummary(summary: ReturnType<typeof pickJobDetailSummary>) {
  if (!summary) return '无详情数据'
  return [
    `encryptJobId=${shortValue(summary.encryptJobId) || '-'}`,
    `securityId=${shortValue(summary.securityId) || '-'}`,
    `lid=${shortValue(summary.lid) || '-'}`,
    `jobName=${summary.jobName || '-'}`,
    `brandName=${summary.brandName || '-'}`,
  ].join(', ')
}

function isDetailMatchedJob(detail: bossZpDetailData | undefined, item: bossZpJobItemData) {
  if (!detail) return false
  if (detail.jobInfo?.encryptId && detail.jobInfo.encryptId === item.encryptJobId) return true
  if (detail.securityId && detail.securityId === item.securityId) return true
  if (detail.lid && detail.lid === item.lid) return true
  return false
}

function isJobStatus(value: unknown): value is JobStatus {
  return (
    value === 'pending' ||
    value === 'wait' ||
    value === 'running' ||
    value === 'success' ||
    value === 'filtered' ||
    value === 'error' ||
    value === 'warn'
  )
}

function normalizePersistedStatus(status?: PersistedJobStatus): Required<PersistedJobStatus> {
  if (status?.status === 'running') {
    return {
      status: 'warn',
      msg: '上次投递中断，结果不确定，需核对后再处理',
    }
  }
  return {
    status: isJobStatus(status?.status) ? status.status : 'pending',
    msg: typeof status?.msg === 'string' ? status.msg : '未开始',
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null
}

function isPersistedSourceJob(value: unknown): value is PersistedSourceJob {
  return isRecord(value) && typeof value.encryptJobId === 'string' && value.encryptJobId.length > 0
}

function isPersistedSourcePools(value: unknown): value is PersistedSourcePools {
  if (
    !isRecord(value) ||
    typeof value.date !== 'string' ||
    typeof value.updatedAt !== 'number' ||
    !Number.isFinite(value.updatedAt) ||
    !isRecord(value.sources)
  )
    return false
  const sources = value.sources
  return deliverySources.every((source) => Array.isArray(sources[source]))
}

function safeString(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function safeNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function safeBoolean(value: unknown) {
  return typeof value === 'boolean' ? value : false
}

function safeStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function toPlainSourceJob(job: bossZpJobItemData): bossZpJobItemData {
  const gps = isRecord(job.gps) ? job.gps : null
  return {
    securityId: safeString(job.securityId),
    bossAvatar: safeString(job.bossAvatar),
    bossCert: safeNumber(job.bossCert),
    encryptBossId: safeString(job.encryptBossId),
    bossName: safeString(job.bossName),
    bossTitle: safeString(job.bossTitle),
    goldHunter: safeNumber(job.goldHunter),
    bossOnline: safeBoolean(job.bossOnline),
    encryptJobId: safeString(job.encryptJobId),
    expectId: safeNumber(job.expectId),
    jobName: safeString(job.jobName),
    lid: safeString(job.lid),
    salaryDesc: safeString(job.salaryDesc),
    jobLabels: safeStringArray(job.jobLabels),
    jobValidStatus: safeNumber(job.jobValidStatus),
    iconWord: safeString(job.iconWord),
    skills: safeStringArray(job.skills),
    jobExperience: safeString(job.jobExperience),
    daysPerWeekDesc: safeString(job.daysPerWeekDesc),
    leastMonthDesc: safeString(job.leastMonthDesc),
    jobDegree: safeString(job.jobDegree),
    cityName: safeString(job.cityName),
    areaDistrict: safeString(job.areaDistrict),
    businessDistrict: safeString(job.businessDistrict),
    jobType: safeNumber(job.jobType),
    proxyJob: safeNumber(job.proxyJob),
    proxyType: safeNumber(job.proxyType),
    anonymous: safeNumber(job.anonymous),
    outland: safeNumber(job.outland),
    optimal: safeNumber(job.optimal),
    // Platform icon descriptors are not used by delivery and may contain non-cloneable values.
    iconFlagList: [],
    itemId: safeNumber(job.itemId),
    city: safeNumber(job.city),
    isShield: safeNumber(job.isShield),
    atsDirectPost: safeBoolean(job.atsDirectPost),
    gps: {
      longitude: safeNumber(gps?.longitude),
      latitude: safeNumber(gps?.latitude),
    },
    lastModifyTime: safeNumber(job.lastModifyTime),
    encryptBrandId: safeString(job.encryptBrandId),
    brandName: safeString(job.brandName),
    brandLogo: safeString(job.brandLogo),
    brandStageName: safeString(job.brandStageName),
    brandIndustry: safeString(job.brandIndustry),
    brandScaleName: safeString(job.brandScaleName),
    welfareList: safeStringArray(job.welfareList),
    industry: safeNumber(job.industry),
    contact: safeBoolean(job.contact),
  }
}

function toPersistedSourceJob(job: MyJobListData): PersistedSourceJob {
  const { status } = job
  return {
    ...toPlainSourceJob(job),
    deliveryGroupTargetIds: safeStringArray(job.deliveryGroupTargetIds),
    deliveryQueueOrder: safeNumber(job.deliveryQueueOrder),
    deliveryQueueSource: job.deliveryQueueSource,
    deliverySearchDirectionKeys: safeStringArray(job.deliverySearchDirectionKeys),
    fetchedAt: safeNumber(job.fetchedAt),
    retryAttempts: safeNumber(job.retryAttempts),
    status: {
      status: status.status,
      msg: status.msg,
    },
  }
}

export class JobList {
  private _vue_jobList = ref<bossZpJobItemData[]>([])
  private _vue_jobDetail = ref<bossZpDetailData>()

  _list = ref<Array<MyJobListData>>([])
  _sourceLists = reactive<Record<DeliveryLimitSource, MyJobListData[]>>({
    search: [],
    group: [],
  })
  _map = reactive<Record<EncryptJobId, MyJobListData>>({})

  _use_cache = ref<boolean>(true)
  private _sourcePoolsHydrated = false
  private _sourcePoolsHydratePromise: Promise<void> | undefined
  private _sourcePoolsPersistTimer: number | undefined
  private _sourcePoolsUpdatedAt = 0
  /** 上一次合并带回的岗位数；用于避免每次 flush 重复记录同一个结果。 */
  private _lastMergedRecoveredCount = 0

  private _sourcePoolsPersistQueue: Promise<void> = Promise.resolve()
  private _sessionStorageWarningLogged = false
  private _accountUid: string | undefined
  private _activeSourcePoolsStorageKey = sourcePoolsStorageKey
  private _activeSourcePoolsSessionStorageKey = sourcePoolsSessionStorageKey
  private _deliveryPoolCaptureEnabled = false
  private _configScope: DeliveryQueueConfigScope | undefined
  private _listRevision = 0
  private _deliveryQueueRevision = ref(0)
  private _nextDeliveryQueueOrder = 1

  private hookJobDetail = useHookVueData(
    '#wrap .page-job-wrapper,.job-recommend-main,.page-jobs-main',
    'jobDetail',
    this._vue_jobDetail,
  )
  private hookClickJobCardAction = useHookVueFn(
    '#wrap .page-job-wrapper,.job-recommend-main,.page-jobs-main',
    'clickJobCardAction',
  )
  private clickJobCardAction = async (_: bossZpJobItemData) => {}

  private hookJobList = useHookVueData(
    '#wrap .page-job-wrapper,.job-recommend-main,.page-jobs-main',
    'jobList',
    this._vue_jobList,
    (v) => {
      this._listRevision += 1
      logger.debug('初始化岗位列表', v)

      const jobSet = this.getKnownJobSet()

      this._list.value = v.map((item) => {
        const existing = jobSet.get(item.encryptJobId)
        const val = existing ? this.refreshRuntimeJob(existing, item) : this.createRuntimeJob(item)
        this._map[item.encryptJobId] = val
        return val
      })
      if (this._deliveryPoolCaptureEnabled) {
        this.mergeSourceList(getDeliveryLimitSource(), this._list.value)
      }
      this.rebuildMap()
    },
  )

  async initJobList(formData: FormData) {
    this._use_cache.value = formData.useCache.value
    if (this._use_cache.value) await getCacheManager().ready()
    await this.hydrateSourcePools()
    await this.hookJobDetail()
    this.clickJobCardAction = await this.hookClickJobCardAction()
    await this.hookJobList()
  }

  async setAccountScope(uid: string | number) {
    const accountUid = normalizeAccountUid(uid)
    if (this._accountUid === accountUid) return

    // Do not let an in-flight restore continue against keys that are about to change accounts.
    if (this._sourcePoolsHydratePromise != null) await this._sourcePoolsHydratePromise

    if (this._accountUid != null && this._sourcePoolsHydrated) {
      await this.flushSourcePools()
    } else {
      await this._sourcePoolsPersistQueue
    }
    if (this._sourcePoolsPersistTimer != null) {
      window.clearTimeout(this._sourcePoolsPersistTimer)
      this._sourcePoolsPersistTimer = undefined
    }

    this._accountUid = accountUid
    this._activeSourcePoolsStorageKey = createAccountStorageKey(sourcePoolsStorageKey, accountUid)
    this._activeSourcePoolsSessionStorageKey = createAccountStorageKey(
      sourcePoolsSessionStorageKey,
      accountUid,
    )
    this._sourcePoolsHydrated = false
    this._sourcePoolsHydratePromise = undefined
    this._sourcePoolsUpdatedAt = 0
    this._deliveryPoolCaptureEnabled = false
    this._configScope = undefined
    this._nextDeliveryQueueOrder = 1
    this._list.value = []
    this._sourceLists.search = []
    this._sourceLists.group = []
    this.rebuildMap()
    this.markDeliveryQueueChanged()
  }

  setDeliveryPoolCaptureEnabled(enabled: boolean) {
    this._deliveryPoolCaptureEnabled = enabled
  }

  setConfigScope(scope: DeliveryQueueConfigScope) {
    const previousFingerprint = this._configScope?.fingerprint
    this._configScope = {
      ...scope,
      enabledGroupTargetIds: [...scope.enabledGroupTargetIds],
      searchDirectionKeys: [...scope.searchDirectionKeys],
    }
    const removed = this.filterIncompatiblePendingJobs()
    if (this._sourcePoolsHydrated && (removed > 0 || previousFingerprint !== scope.fingerprint)) {
      this.queuePersistSourcePools()
    }
    return removed
  }

  readDeliveryQueueSnapshot(): DeliveryQueueSnapshot {
    const seen = new Set<EncryptJobId>()
    const sources: Record<DeliveryLimitSource, MyJobListData[]> = {
      group: [],
      search: [],
    }
    const entries = deliverySources
      .flatMap((source) => this._sourceLists[source].map((item) => ({ item, source })))
      .sort(
        (left, right) =>
          safeNumber(left.item.deliveryQueueOrder) - safeNumber(right.item.deliveryQueueOrder),
      )
    for (const { item, source } of entries) {
      if (seen.has(item.encryptJobId)) continue
      seen.add(item.encryptJobId)
      sources[item.deliveryQueueSource ?? source].push(item)
    }
    return {
      configFingerprint: this._configScope?.fingerprint,
      date: getCurDay(),
      revision: this._deliveryQueueRevision.value,
      sources,
      updatedAt: this._sourcePoolsUpdatedAt,
    }
  }

  get deliveryQueueRevision() {
    return this._deliveryQueueRevision.value
  }

  /**
   * @param canDeliver 入池前的预判。必然投不出去的岗位不该占投递池的名额——池子的水位
   *   用「状态为待处理」来算，而这些岗位在处理之前正是待处理，会把水位撑在低水位线之上，
   *   补池因此不触发，整轮都在同一批死数据里打转。
   */
  captureCurrentPageToDeliveryPool(
    source: DeliveryLimitSource = getDeliveryLimitSource(),
    groupTargetId?: string,
    searchDirection?: string,
    canDeliver?: (job: MyJobListData) => boolean,
    groupName?: string,
  ) {
    if (this._list.value.length === 0) return 0
    const fetchedAt = Date.now()
    const candidates = canDeliver ? this._list.value.filter(canDeliver) : this._list.value
    if (candidates.length === 0) return 0
    for (const item of candidates) {
      item.fetchedAt = fetchedAt
      if (source === 'group' && groupTargetId) {
        item.deliveryGroupTargetIds = Array.from(
          new Set([...(item.deliveryGroupTargetIds ?? []), groupTargetId]),
        )
        if (groupName) item.deliveryGroupName = groupName
      } else if (source === 'search' && searchDirection) {
        const directionKey = normalizeDeliverySourceKey(searchDirection)
        if (directionKey) {
          item.deliverySearchDirectionKeys = Array.from(
            new Set([...(item.deliverySearchDirectionKeys ?? []), directionKey]),
          )
        }
      }
    }
    const before = this._sourceLists[source].length
    this.mergeSourceList(source, candidates)
    return this._sourceLists[source].length - before
  }

  private createRuntimeJob(
    item: bossZpJobItemData & DeliveryJobMetadata,
    savedStatus?: PersistedJobStatus,
  ) {
    const cacheCheck = this._use_cache.value ? checkJobCache(item.encryptJobId) : null
    const restoredStatus = normalizePersistedStatus(savedStatus)
    let val: MyJobListData

    val = {
      ...item,
      deliveryGroupName: safeString(item.deliveryGroupName) || undefined,
      deliveryGroupTargetIds: safeStringArray(item.deliveryGroupTargetIds),
      deliveryQueueOrder: safeNumber(item.deliveryQueueOrder),
      deliveryQueueSource:
        item.deliveryQueueSource === 'group' || item.deliveryQueueSource === 'search'
          ? item.deliveryQueueSource
          : undefined,
      deliverySearchDirectionKeys: safeStringArray(item.deliverySearchDirectionKeys),
      fetchedAt: safeNumber(item.fetchedAt) || Date.now(),
      retryAttempts: safeNumber(item.retryAttempts),
      status: {
        status: savedStatus ? restoredStatus.status : cacheCheck ? cacheCheck.status : 'pending',
        msg: savedStatus
          ? restoredStatus.msg
          : cacheCheck
            ? `${cacheCheck.message} (缓存)`
            : '未开始',
        setStatus: (status: JobStatus, msg?: string) => {
          const target = this._map[item.encryptJobId] ?? val
          target.status.status = status
          target.status.msg = msg ?? ''
          this.markDeliveryQueueChanged()
          this.queuePersistSourcePools()
        },
      },
      getCard: async () => {
        const runtimeItem = this._map[item.encryptJobId] ?? val
        const data = await getJobDetail(
          runtimeItem,
          async () => {
            await this.clickJobCardAction(runtimeItem)
            return new Promise<bossZpDetailData>((resolve, reject) => {
              let done = false
              let lastSummary = pickJobDetailSummary(this._vue_jobDetail.value)
              const cleanup = () => {
                done = true
                clearTimeout(timeoutId)
                clearInterval(interval)
              }
              const timeoutId = setTimeout(() => {
                cleanup()
                reject(
                  new Error(
                    [
                      'bossZpDetailData获取超时',
                      `目标 encryptJobId=${shortValue(runtimeItem.encryptJobId) || '-'}`,
                      `目标 lid=${shortValue(runtimeItem.lid) || '-'}`,
                      `最后详情：${formatJobDetailSummary(lastSummary)}`,
                    ].join('；'),
                  ),
                )
              }, 1000 * 60)
              const interval = setInterval(() => {
                const detail = this._vue_jobDetail.value
                if (!done && detail) {
                  lastSummary = pickJobDetailSummary(detail)
                }
                if (!done && isDetailMatchedJob(detail, runtimeItem)) {
                  cleanup()
                  resolve(detail!)
                }
              }, 100)
            })
          },
          this.isCurrentPageJob(runtimeItem),
        )
        const card: bossZpDetailData & bossZpCardData = {
          ...data,
          jobName: data.jobInfo.jobName,
          postDescription: data.jobInfo.postDescription,
          encryptJobId: data.jobInfo.encryptId,
          atsDirectPost: false,
          atsProxyJob: data.jobInfo.proxyJob === 1,
          salaryDesc: data.jobInfo.salaryDesc,
          cityName: data.jobInfo.locationName,
          experienceName: data.jobInfo.experienceName,
          degreeName: data.jobInfo.degreeName,
          jobLabels: data.jobInfo.showSkills || [],
          address: data.jobInfo.address,
          lid: data.lid,
          sessionId: data.sessionId || '',
          securityId: data.securityId,
          encryptUserId: data.jobInfo.encryptUserId,
          bossName: data.bossInfo.name,
          bossTitle: data.bossInfo.title,
          bossAvatar: data.bossInfo.tiny,
          online: data.bossInfo.bossOnline,
          certificated: data.bossInfo.certificated,
          activeTimeDesc: data.bossInfo.activeTimeDesc,
          brandName: data.brandComInfo.brandName,
          canAddFriend: true,
          friendStatus: data.relationInfo?.beFriend ? 1 : 0,
          isInterested: data.relationInfo.interestJob ? 1 : 0,
          login: true,
        }
        val.card = card
        const current = this._map[item.encryptJobId]
        if (current) {
          current.card = card
        }
        return card
      },
    }

    return val
  }

  get(encryptJobId: EncryptJobId): MyJobListData | undefined {
    return this._map[encryptJobId]
  }

  resolveRuntimeJob(item: MyJobListData): MyJobListData | null {
    if (!item || typeof item.encryptJobId !== 'string' || item.encryptJobId.length === 0) {
      return null
    }
    const existing = this._map[item.encryptJobId]
    if (existing) return existing

    const restored = this.createRuntimeJob(
      {
        ...toPlainSourceJob(item),
        deliveryGroupName: safeString(item.deliveryGroupName) || undefined,
        deliveryGroupTargetIds: safeStringArray(item.deliveryGroupTargetIds),
        deliveryQueueOrder: safeNumber(item.deliveryQueueOrder),
        deliveryQueueSource: item.deliveryQueueSource,
        deliverySearchDirectionKeys: safeStringArray(item.deliverySearchDirectionKeys),
        fetchedAt: safeNumber(item.fetchedAt),
        retryAttempts: safeNumber(item.retryAttempts),
      },
      item.status,
    )
    this._map[restored.encryptJobId] = restored
    return restored
  }

  set(encryptJobId: EncryptJobId, val: MyJobListData) {
    this._map[encryptJobId] = val
  }

  /**
   * 把投递池里所有非成功岗位放回待处理。
   *
   * 面板原来遍历的是 `_list.value`，也就是当前页可见的十几个岗位，而投递池里通常有上百个，
   * 「重置待处理」实际只覆盖了很小一部分。这里按投递池遍历，成功的岗位始终保留终态。
   */
  resetPendingDeliveryPool() {
    let reset = 0
    const seen = new Set<EncryptJobId>()
    for (const source of deliverySources) {
      for (const item of this._sourceLists[source]) {
        if (seen.has(item.encryptJobId)) continue
        seen.add(item.encryptJobId)
        if (item.status.status === 'success' || item.status.status === 'wait') continue
        item.status.setStatus('wait', '等待中')
        reset += 1
      }
    }
    if (reset > 0) {
      this.markDeliveryQueueChanged()
      this.queuePersistSourcePools()
    }
    return reset
  }

  remove(encryptJobId: EncryptJobId) {
    this._list.value = this._list.value.filter((item) => item.encryptJobId !== encryptJobId)
    this._sourceLists.search = this._sourceLists.search.filter(
      (item) => item.encryptJobId !== encryptJobId,
    )
    this._sourceLists.group = this._sourceLists.group.filter(
      (item) => item.encryptJobId !== encryptJobId,
    )
    delete this._map[encryptJobId]
    this.markDeliveryQueueChanged()
    this.queuePersistSourcePools()
  }

  get list() {
    return this._list.value
  }

  get listRevision() {
    return this._listRevision
  }

  listBySource(source: DeliveryLimitSource) {
    return this._sourceLists[source]
  }

  get sourceLists() {
    return this._sourceLists
  }

  get map() {
    return this._map
  }

  private getKnownJobSet() {
    const items = [...this._list.value, ...this._sourceLists.search, ...this._sourceLists.group]
    return items.reduce((acc, item) => {
      acc.set(item.encryptJobId, item)
      return acc
    }, new Map<EncryptJobId, MyJobListData>())
  }

  private mergeSourceList(source: DeliveryLimitSource, items: MyJobListData[]) {
    const next = new Map<EncryptJobId, MyJobListData>()
    for (const item of this._sourceLists[source]) {
      next.set(item.encryptJobId, item)
    }
    for (const item of items) {
      if (!Number.isFinite(item.deliveryQueueOrder) || Number(item.deliveryQueueOrder) <= 0) {
        item.deliveryQueueOrder = this._nextDeliveryQueueOrder
        this._nextDeliveryQueueOrder += 1
      }
      item.deliveryQueueSource ??= source
      next.set(item.encryptJobId, item)
    }
    this._sourceLists[source] = [...next.values()]
    this.markDeliveryQueueChanged()
    this.queuePersistSourcePools()
  }

  private filterIncompatiblePendingJobs() {
    const scope = this._configScope
    if (scope == null) return 0
    const enabledGroupTargetIds = new Set(scope.enabledGroupTargetIds)
    const searchDirectionKeys = new Set(scope.searchDirectionKeys)
    let removed = 0
    const isPending = (item: MyJobListData) =>
      item.status.status === 'pending' ||
      item.status.status === 'wait' ||
      item.status.status === 'running'

    // 没有来源归属的岗位不能当成「不兼容」删除。取岗时求职期望或搜索方向未必解析得出来
    // （推荐页没有选中的期望、任务步骤和 URL 里都没有搜索词），这类岗位入池时归属为空数组，
    // 而空数组永远匹配不上 some()。这个过滤器要挡的是「来源已被关掉」的岗位，
    // 归属未知不等于来源已关，只有整个来源被关掉时才应该清出去。
    this._sourceLists.group = this._sourceLists.group.filter((item) => {
      if (!isPending(item)) return true
      const targetIds = safeStringArray(item.deliveryGroupTargetIds)
      const compatible =
        scope.groupEnabled &&
        (targetIds.length === 0 || targetIds.some((key) => enabledGroupTargetIds.has(key)))
      if (!compatible) removed += 1
      return compatible
    })
    this._sourceLists.search = this._sourceLists.search.filter((item) => {
      if (!isPending(item)) return true
      const directionKeys = safeStringArray(item.deliverySearchDirectionKeys)
      const compatible =
        scope.searchEnabled &&
        (directionKeys.length === 0 || directionKeys.some((key) => searchDirectionKeys.has(key)))
      if (!compatible) removed += 1
      return compatible
    })
    if (removed > 0) {
      this.rebuildMap()
      this.markDeliveryQueueChanged()
    }
    return removed
  }

  private markDeliveryQueueChanged() {
    this._deliveryQueueRevision.value += 1
  }

  private refreshRuntimeJob(target: MyJobListData, item: bossZpJobItemData) {
    Object.assign(target, toPlainSourceJob(item))
    target.fetchedAt = Date.now()
    return target
  }

  private rebuildMap() {
    for (const key of Object.keys(this._map)) {
      delete this._map[key]
    }
    for (const item of [
      ...this._sourceLists.search,
      ...this._sourceLists.group,
      ...this._list.value,
    ]) {
      this._map[item.encryptJobId] = item
    }
  }

  private isCurrentPageJob(item: bossZpJobItemData) {
    return this._list.value.some((current) => current.encryptJobId === item.encryptJobId)
  }

  private async hydrateSourcePools() {
    if (this._sourcePoolsHydrated) return
    if (this._sourcePoolsHydratePromise) return this._sourcePoolsHydratePromise

    this._sourcePoolsHydratePromise = (async () => {
      let selected: PersistedSourcePools | null = null

      try {
        const saved = await counter.storageGet<PersistedSourcePools | null>(
          this._activeSourcePoolsStorageKey,
          null,
        )
        if (isPersistedSourcePools(saved) && saved.date !== getCurDay()) {
          await counter.storageRm(this._activeSourcePoolsStorageKey)
        } else if (isPersistedSourcePools(saved) && saved.date === getCurDay()) {
          selected = saved
        }

        let migratedLegacy = false
        if (selected == null && this._accountUid != null) {
          const legacySaved = await counter.storageGet<PersistedSourcePools | null>(
            sourcePoolsStorageKey,
            null,
          )
          const sameDayLegacySaved =
            isPersistedSourcePools(legacySaved) && legacySaved.date === getCurDay()
              ? legacySaved
              : null
          selected = sameDayLegacySaved
          migratedLegacy = selected != null
        }

        if (selected) {
          this.restoreSourcePools(selected)
          this.writeSessionSourcePools(this.createSourcePoolsSnapshot(selected.updatedAt))
        }
        if (migratedLegacy && selected) {
          await counter.storageSet(this._activeSourcePoolsStorageKey, selected)
          await counter.storageRm(sourcePoolsStorageKey)
          try {
            window.sessionStorage.removeItem(sourcePoolsSessionStorageKey)
          } catch {
            // The scoped copy is already durable; legacy cleanup can be retried on a later load.
          }
        }
      } catch (error) {
        logger.warn(
          '岗位投递池扩展存储恢复失败，已使用当前页面岗位列表',
          error instanceof Error ? error.message : String(error),
        )
      } finally {
        this._sourcePoolsHydrated = true
        this._sourcePoolsHydratePromise = undefined
      }
    })()

    return this._sourcePoolsHydratePromise
  }

  private queuePersistSourcePools() {
    this.writeSessionSourcePools(this.createSourcePoolsSnapshot())
    if (this._sourcePoolsPersistTimer != null) {
      window.clearTimeout(this._sourcePoolsPersistTimer)
    }
    this._sourcePoolsPersistTimer = window.setTimeout(() => {
      this._sourcePoolsPersistTimer = undefined
      void this.flushSourcePools().catch((error) => {
        logger.warn(
          '岗位投递池保存失败，已保留当前页面内存数据',
          error instanceof Error ? error.message : String(error),
        )
      })
    }, sourcePoolPersistDebounceMs)
  }

  async flushSourcePools() {
    if (this._sourcePoolsPersistTimer != null) {
      window.clearTimeout(this._sourcePoolsPersistTimer)
      this._sourcePoolsPersistTimer = undefined
    }
    if (!this._sourcePoolsHydrated) await this.hydrateSourcePools()

    const snapshot = this.createSourcePoolsSnapshot()
    this.writeSessionSourcePools(snapshot)
    const storageKey = this._activeSourcePoolsStorageKey
    const persist = this._sourcePoolsPersistQueue.then(async () => {
      await sourcePoolsMutex(async () => {
        // 必须在锁内重新读取并合并：另一个标签页可能已经写入了本页面没有的岗位，
        // 直接覆写会让那些岗位连同其投递状态一起消失，进而被重复投递。
        let stored: PersistedSourcePools | null = null
        try {
          const saved = await counter.storageGet<unknown>(storageKey, null)
          if (isPersistedSourcePools(saved)) stored = saved
        } catch (error) {
          // 读失败会让本次写入退化成整体覆写，也就是跨标签页丢岗位的老问题。
          // 必须留痕：否则它会以「投递池莫名变少」的形式出现，且无从追查。
          useLog().info(
            '投递池',
            `合并前读取失败，本次退化为整体覆写（可能丢失其他标签页的岗位）：${
              error instanceof Error ? error.message : String(error)
            }`,
          )
        }
        if (storageKey !== this._activeSourcePoolsStorageKey) return
        const merged = mergeSourcePoolSnapshots(stored, snapshot)
        const storedCount = stored
          ? deliverySources.reduce(
              (total, source) => total + (stored.sources[source]?.length ?? 0),
              0,
            )
          : 0
        const localCount = deliverySources.reduce(
          (total, source) => total + snapshot.sources[source].length,
          0,
        )
        const mergedCount = deliverySources.reduce(
          (total, source) => total + merged.sources[source].length,
          0,
        )
        // 只在「带回的数量发生变化」时记录。用 mergedCount > localCount 作条件是错的：
        // 本地内存不会吸收合并结果（存储才是权威），所以两者的差值在整轮运行里恒定，
        // 条件恒真，每次 flush 都会打同一行日志。
        const recovered = mergedCount - localCount
        if (recovered > 0 && recovered !== this._lastMergedRecoveredCount) {
          this._lastMergedRecoveredCount = recovered
          useLog().info(
            '投递池',
            `已合并其他标签页的投递池
${JSON.stringify({
  storedCount,
  localCount,
  mergedCount,
  recovered,
})}`,
          )
        } else if (recovered === 0) {
          this._lastMergedRecoveredCount = 0
        }
        await counter.storageSet(storageKey, merged)
      })
    })
    this._sourcePoolsPersistQueue = persist.catch(() => undefined)
    await persist
  }

  private createSourcePoolsSnapshot(updatedAt?: number): PersistedSourcePools {
    const snapshotUpdatedAt = updatedAt ?? Math.max(Date.now(), this._sourcePoolsUpdatedAt + 1)
    this._sourcePoolsUpdatedAt = Math.max(this._sourcePoolsUpdatedAt, snapshotUpdatedAt)
    return {
      configFingerprint: this._configScope?.fingerprint,
      date: getCurDay(),
      sources: {
        group: this._sourceLists.group
          .slice(-maxPersistedSourceJobsPerSource)
          .map(toPersistedSourceJob),
        search: this._sourceLists.search
          .slice(-maxPersistedSourceJobsPerSource)
          .map(toPersistedSourceJob),
      },
      updatedAt: snapshotUpdatedAt,
    }
  }

  private restoreSourcePools(snapshot: PersistedSourcePools) {
    const restoredJobs = new Map<EncryptJobId, MyJobListData>()
    for (const source of deliverySources) {
      this._sourceLists[source] = snapshot.sources[source]
        .filter(isPersistedSourceJob)
        .slice(-maxPersistedSourceJobsPerSource)
        .map((item) => {
          const existing = restoredJobs.get(item.encryptJobId)
          if (existing) return existing
          const restored = this.createRuntimeJob(
            {
              ...toPlainSourceJob(item),
              deliveryGroupTargetIds: safeStringArray(item.deliveryGroupTargetIds),
              deliveryQueueOrder: safeNumber(item.deliveryQueueOrder),
              deliveryQueueSource:
                item.deliveryQueueSource === 'group' || item.deliveryQueueSource === 'search'
                  ? item.deliveryQueueSource
                  : undefined,
              deliverySearchDirectionKeys: safeStringArray(item.deliverySearchDirectionKeys),
              fetchedAt: safeNumber(item.fetchedAt),
              retryAttempts: safeNumber(item.retryAttempts),
            },
            item.status,
          )
          if ((restored.deliveryQueueOrder ?? 0) <= 0) {
            restored.deliveryQueueOrder = this._nextDeliveryQueueOrder
            this._nextDeliveryQueueOrder += 1
          }
          restored.deliveryQueueSource ??= source
          restoredJobs.set(item.encryptJobId, restored)
          return restored
        })
    }
    this._nextDeliveryQueueOrder =
      Math.max(
        0,
        ...Array.from(restoredJobs.values(), (item) => safeNumber(item.deliveryQueueOrder)),
      ) + 1
    this._sourcePoolsUpdatedAt = Math.max(this._sourcePoolsUpdatedAt, snapshot.updatedAt)
    this.rebuildMap()
    this.filterIncompatiblePendingJobs()
    this.markDeliveryQueueChanged()
  }

  private writeSessionSourcePools(snapshot: PersistedSourcePools) {
    if (typeof window === 'undefined') return
    try {
      window.sessionStorage.setItem(
        this._activeSourcePoolsSessionStorageKey,
        JSON.stringify(snapshot),
      )
      this._sessionStorageWarningLogged = false
    } catch (error) {
      this.warnSessionStorageOnce('岗位投递池标签页快照保存失败，已继续使用扩展备份', error)
    }
  }

  private warnSessionStorageOnce(message: string, error: unknown) {
    if (this._sessionStorageWarningLogged) return
    this._sessionStorageWarningLogged = true
    logger.warn(message, error instanceof Error ? error.message : String(error))
  }
}

export const jobList = new JobList()

async function getJobDetail(
  item: bossZpJobItemData,
  fallback: () => Promise<bossZpDetailData>,
  allowPageFallback: boolean,
) {
  try {
    const res = await requestDetail({
      lid: item.lid,
      securityId: item.securityId,
    })
    if (res.data.code !== 0 || !res.data.zpData) {
      throw new Error(`详情接口返回异常：${res.data.message || res.data.code}`)
    }
    return res.data.zpData
  } catch (error) {
    if (!allowPageFallback) {
      // 原来这里把失败原因扔了，直接断言「岗位已失效或已下线」。那是猜的——代码并没有看
      // 失败原因，只知道请求没成功。真实原因只进了浏览器控制台，没进运行日志，于是连续
      // 十几个岗位被判成「下线」时，日志里没有任何东西能说明到底发生了什么。
      //
      // 「不在当前页」也不代表岗位有问题：投递池是跨来源累积的，切过来源之后池子里绝大
      // 多数岗位本来就不在当前页。它只决定「能不能退回点页面」，不能拿来给岗位定性。
      const reason = error instanceof Error ? error.message : String(error)
      const message = [
        '取岗位详情失败，且岗位不在当前页，无法退回页面点击',
        `encryptJobId=${shortValue(item.encryptJobId) || '-'}`,
        `lid=${shortValue(item.lid) || '-'}`,
        `原因=${reason}`,
      ].join('；')
      logger.warn(message)
      throw new JobUnavailableError(`取岗位详情失败，已跳过该岗位：${reason}`, {
        cause: error instanceof Error ? error : undefined,
      })
    }
    logger.warn('接口获取职位详情失败，回退页面点击', {
      error: error instanceof Error ? error.message : String(error),
      encryptJobId: item.encryptJobId,
      lid: item.lid,
    })
    return fallback()
  }
}
