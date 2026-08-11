import { ref } from 'vue'

import { counter } from '@/message'
import type { AiGreetingMeta, GreetingFilteringContext } from '@/types/aiGreeting'
import type {
  AgentDeliveryError,
  CompanyNameError,
  CompanySizeError,
  JobDescriptionError,
  JobTitleError,
  PublishError,
  SalaryError,
  UnknownError,
} from '@/types/deliverError'
import { createAccountStorageKey, normalizeAccountUid } from '@/utils/accountStorage'
import type { amapDistance, amapGeocode } from '@/utils/amap'
import { getRecentGreetingSummaries } from '@/utils/greetingHistory'
import { logger } from '@/utils/logger'
import { getProviderHeartbeatDiagnostic } from '@/utils/providerHealth'
import { toSafeJsonValue } from '@/utils/safeJson'
import { createStorageMutex } from '@/utils/storageMutex'

import type { MyJobListData } from './jobs'

export type logErr =
  | null
  | undefined
  | AgentDeliveryError
  | PublishError
  | JobTitleError
  | CompanyNameError
  | SalaryError
  | CompanySizeError
  | JobDescriptionError
  | UnknownError

export type logTraceStatus = 'info' | 'success' | 'warning' | 'danger'
export type DeliverySource = 'group' | 'search'
export type DeliveryStage =
  | '待处理'
  | 'JD筛选中'
  | '打招呼语生成中'
  | '正在建立沟通'
  | '正在打招呼'
  | '投递成功'
  | '已过滤'
  | '投递失败'

export interface logTrace {
  at: number
  stage: string
  status: logTraceStatus
  message: string
  detail?: unknown
}

export interface logData {
  listData: MyJobListData
  communicationCounted?: boolean
  /** 这个岗位是否向 BOSS 发过详情请求。节奏按请求计，不按投递结果计。 */
  detailAttempted?: boolean
  detailFetched?: boolean
  deliverySource?: DeliverySource
  deliverySourceName?: string
  deliveryStage?: DeliveryStage
  failureStage?: DeliveryStage
  failureReason?: string
  retryable?: boolean
  retryAttempts?: number
  maxRetryAttempts?: number
  matchPercent?: number
  aiFilteringThreshold?: number
  el?: Element
  amap?: {
    geocode?: Awaited<ReturnType<typeof amapGeocode>>
    distance?: Awaited<ReturnType<typeof amapDistance>>
  }
  bossData?: bossZpBossData
  message?: string
  state?: string
  err?: string
  trace?: logTrace[]
  publish?: {
    ok: boolean
    attempts: number
    phase?: 'sent' | 'confirmed' | 'unknown'
    code?: number
    message?: string
    error?: string
    data?: unknown
  }
  greetingSend?: {
    ok: boolean
    type: 'ai' | 'custom' | 'none'
    channel?: string
    error?: string
    contentLength?: number
    messageCount?: number
    messages?: Array<{
      index: number
      ok: boolean
      channel?: string
      content: string
      contentLength: number
      error?: string
    }>
    detail?: unknown
  }
  aiFilteringR?: string | null
  aiFilteringAjson?: object
  aiFilteringAtext?: string
  aiGreetingR?: string | null
  aiGreetingA?: string
  aiGreetingMessages?: string[]
  aiFilteringDecision?: GreetingFilteringContext
  aiGreetingMeta?: AiGreetingMeta
  greetingWarning?: string
}

export function addLogTrace(
  data: logData | undefined,
  stage: string,
  status: logTraceStatus,
  message: string,
  detail?: unknown,
) {
  if (!data) return
  data.trace ??= []
  data.trace.push({
    at: Date.now(),
    stage,
    status,
    message,
    detail,
  })
}

export type logState = 'info' | 'success' | 'warning' | 'danger'

export interface log {
  job?: MyJobListData
  title: string
  state: logState
  state_name: string
  message?: string
  data?: logData
  publicData?: logData
  createdAt: number
  updatedAt?: number
}

const deliveryLogKey = 'local:web-geek-job-DeliveryLogs'
const runtimeLogKey = 'local:agent-delivery-runtime-logs'
export const MAX_DELIVERY_LOGS = 200
const maxPersistedTextLength = 8000
const maxPersistedDetailTextLength = 3000
// JD 只在有 AI 判断可复核时才需要留全文。
//
// AI 匹配是拿简历事实和这段 JD 比出来的，要回答「过滤得准不准」，就必须能同时看到判断
// 结果和它依据的原文。原来一律只存 200 字，等于把做判断的材料丢了——真机上五条过滤记录
// 里有两条的扣分理由核对不了，因为它引用的 JD 内容正好在被截掉的部分。
//
// 但也不能一律存全文：配额是和投递池、缓存、统计共用的，实测一律按 2000 字存会把日志
// 从 1.69 MB 推到 2.85 MB，直接顶穿预算。没有 AI 判断的记录（硬规则过滤、取详情失败）
// 本来就没有什么可复核的，摘要够用。
const maxPersistedJobDescriptionLength = 200
const maxAuditableJobDescriptionLength = 2000
const maxPersistedTraceEntries = 120
const redactedLogValue = '[已脱敏]'
const sensitiveLogKeys = new Set([
  'securityid',
  'lid',
  'encryptbossid',
  'encryptuserid',
  'authorization',
  'cookie',
  'set-cookie',
  'api_key',
  'bridgetoken',
])
const data = ref<log[]>([])
const runtimeData = ref<log[]>([])
let hydrated = false
let hydratePromise: Promise<void> | undefined
let runtimeHydratePromise: Promise<void> | undefined
let persistTimer: number | undefined
let persistQueue: Promise<void> = Promise.resolve()
let clearVersion = 0
let accountUid: string | undefined
let activeDeliveryLogKey = deliveryLogKey
let activeRuntimeLogKey: string | undefined
const deliveryLogMutex = createStorageMutex('agent-delivery:delivery-logs')

function truncateText(value: string, maxLength: number) {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength)}\n...[已截断 ${value.length - maxLength} 字]`
}

function getLogSortTime(record: log) {
  return record.updatedAt ?? record.createdAt
}

export function newestDeliveryLogs(records: readonly log[]) {
  return records
    .slice()
    .sort((left, right) => getLogSortTime(right) - getLogSortTime(left))
    .slice(0, MAX_DELIVERY_LOGS)
}

/**
 * 持久化时 `data.listData` 被省略以避免与 `record.job` 重复保存同一份岗位（含完整 JD）。
 * 读回后在内存中回填，保证运行期 `logData.listData` 始终可用，下游无需感知这个差异。
 * 旧数据里 `data.listData` 仍然存在，此时保持原值不动。
 */
function restoreLogDataListData(record: log) {
  const data = record.data
  if (data && data.listData == null && record.job != null) {
    data.listData = record.job
  }
  return record
}

function finalizeInterruptedDelivery(record: log) {
  const ctx = record.data
  if (!ctx) return record
  if (
    ctx.deliveryStage === '投递成功' ||
    ctx.deliveryStage === '已过滤' ||
    ctx.deliveryStage === '投递失败'
  ) {
    return record
  }

  const interruptedStage = ctx.deliveryStage ?? '待处理'
  if (ctx.publish?.ok === true && ctx.greetingSend?.ok !== true) {
    const detail = ctx.greetingSend?.detail
    const resultUnknown =
      typeof detail === 'object' &&
      detail != null &&
      (detail as Record<string, unknown>).resultUnknown === true
    const message = resultUnknown
      ? '已建立沟通，招呼语发送结果不确定，请人工核对'
      : '已建立沟通，招呼语未完成，将从招呼语阶段继续'
    record.state = 'warning'
    record.state_name = resultUnknown ? '结果不确定' : '招呼语待续发'
    record.message = message
    ctx.failureStage = '正在打招呼'
    ctx.failureReason = message
    ctx.retryable = !resultUnknown
    ctx.state = resultUnknown ? '结果未知' : '招呼语待续发'
    ctx.err = message
    ctx.deliveryStage = '投递失败'
    for (const job of [record.job, ctx.listData]) {
      if (!job?.status) continue
      job.status.status = 'warn'
      job.status.msg = message
    }
    return record
  }

  const message = '上次运行中断，结果不确定，请人工核对后再处理'
  record.state = 'warning'
  record.state_name = '结果不确定'
  record.message = message
  ctx.failureStage = interruptedStage
  ctx.failureReason = message
  ctx.retryable = false
  ctx.state = '结果未知'
  ctx.err = message
  ctx.deliveryStage = '投递失败'
  for (const job of [record.job, ctx.listData]) {
    if (!job?.status) continue
    job.status.status = 'warn'
    job.status.msg = message
  }
  return record
}

function compactValue(value: unknown, maxStringLength = maxPersistedDetailTextLength): unknown {
  const safe = toSafeJsonValue(value)
  return trimValue(redactLogValue(safe), maxStringLength)
}

function redactLogValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactLogValue)
  if (typeof value === 'object' && value != null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        sensitiveLogKeys.has(key.toLowerCase()) ? redactedLogValue : redactLogValue(item),
      ]),
    )
  }
  return value
}

function trimValue(value: unknown, maxStringLength: number): unknown {
  if (typeof value === 'string') return truncateText(value, maxStringLength)
  if (Array.isArray(value)) return value.map((item) => trimValue(item, maxStringLength))
  if (typeof value === 'object' && value != null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        trimValue(item, maxStringLength),
      ]),
    )
  }
  return value
}

function toPersistedJob(
  job?: MyJobListData,
  keepFullDescription = false,
): MyJobListData | undefined {
  if (!job) return undefined
  const card = job.card
  return compactValue(
    {
      encryptJobId: job.encryptJobId,
      expectId: job.expectId,
      jobName: job.jobName,
      cityName: job.cityName,
      salaryDesc: job.salaryDesc,
      jobExperience: job.jobExperience,
      jobDegree: job.jobDegree,
      jobLabels: job.jobLabels,
      brandName: job.brandName,
      brandScaleName: job.brandScaleName,
      bossName: job.bossName,
      bossTitle: job.bossTitle,
      status: {
        status: job.status?.status ?? 'pending',
        msg: job.status?.msg ?? '',
      },
      card: card
        ? {
            postDescription: truncateText(
              card.postDescription || card.jobInfo?.postDescription || '',
              keepFullDescription
                ? maxAuditableJobDescriptionLength
                : maxPersistedJobDescriptionLength,
            ),
            jobName: card.jobName || card.jobInfo?.jobName,
            salaryDesc: card.salaryDesc || card.jobInfo?.salaryDesc,
            cityName: card.cityName || card.jobInfo?.locationName,
            experienceName: card.experienceName || card.jobInfo?.experienceName,
            degreeName: card.degreeName || card.jobInfo?.degreeName,
            jobLabels: card.jobLabels || card.jobInfo?.showSkills,
            address: card.address || card.jobInfo?.address,
            bossName: card.bossName || card.bossInfo?.name,
            bossTitle: card.bossTitle || card.bossInfo?.title,
            activeTimeDesc: card.activeTimeDesc || card.bossInfo?.activeTimeDesc,
            brandName: card.brandName || card.brandComInfo?.brandName,
            encryptJobId: card.encryptJobId || card.jobInfo?.encryptId,
          }
        : undefined,
    },
    maxPersistedTextLength,
  ) as MyJobListData
}

function toPersistedLogData(logdata?: logData): logData | undefined {
  if (!logdata) return undefined
  return compactValue(
    {
      // listData 与 record.job 指向同一个岗位，两处都写会让每条记录保存两份完整 JD
      // （实测占单条记录的 56%~64%）。这里只写 record.job 一份，hydrate 时回填 listData。
      communicationCounted: logdata.communicationCounted,
      deliverySource: logdata.deliverySource,
      deliverySourceName: logdata.deliverySourceName,
      deliveryStage: logdata.deliveryStage,
      failureStage: logdata.failureStage,
      failureReason: logdata.failureReason,
      retryable: logdata.retryable,
      retryAttempts: logdata.retryAttempts,
      maxRetryAttempts: logdata.maxRetryAttempts,
      matchPercent: logdata.matchPercent,
      aiFilteringThreshold: logdata.aiFilteringThreshold,
      message: logdata.message,
      state: logdata.state,
      err: logdata.err,
      trace: logdata.trace?.slice(-maxPersistedTraceEntries).map((item) => ({
        ...item,
        detail: compactValue(item.detail),
      })),
      publish: logdata.publish
        ? {
            ok: logdata.publish.ok,
            attempts: logdata.publish.attempts,
            phase: logdata.publish.phase,
            code: logdata.publish.code,
            message: logdata.publish.message,
            error: logdata.publish.error,
          }
        : undefined,
      greetingSend: logdata.greetingSend,
      aiFilteringAjson: logdata.aiFilteringAjson,
      aiFilteringAtext: logdata.aiFilteringAtext,
      aiGreetingA: logdata.aiGreetingA,
      aiGreetingMessages: logdata.aiGreetingMessages,
      aiFilteringDecision: logdata.aiFilteringDecision,
      aiGreetingMeta: logdata.aiGreetingMeta,
      greetingWarning: logdata.greetingWarning,
    },
    maxPersistedTextLength,
  ) as logData
}

export function toPublicLogData(logdata?: logData): logData | undefined {
  if (!logdata) return undefined
  const serializableData = { ...logdata }
  delete serializableData.el
  return compactValue(serializableData, maxPersistedTextLength) as logData
}

function refreshPublicLogData(record: log, logdata?: logData) {
  try {
    record.publicData = toPublicLogData(logdata)
  } catch {
    // A malformed runtime object must never interrupt delivery or hide the remaining logs.
    record.publicData = undefined
  }
  return record
}

function toPersistedLog(record: log): log {
  // 有 AI 判断才留 JD 全文：只有这种记录需要拿原文去核对扣分理由站不站得住。
  const job = toPersistedJob(
    record.job ?? record.data?.listData,
    record.data?.aiFilteringAjson != null,
  )
  return compactValue(
    {
      job,
      title: record.title,
      state: record.state,
      state_name: record.state_name,
      message: record.message,
      data: toPersistedLogData(record.data),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    },
    maxPersistedTextLength,
  ) as log
}

function persist() {
  if (persistTimer != null) {
    window.clearTimeout(persistTimer)
  }
  persistTimer = window.setTimeout(() => {
    persistTimer = undefined
    void flush().catch((error) => {
      logger.warn('日志自动保存失败，已保留当前页面内存日志', getProviderHeartbeatDiagnostic(error))
    })
  }, 120)
}

function enqueuePersistence(operation: () => Promise<void>) {
  const queued = persistQueue.then(operation)
  persistQueue = queued.then(
    () => undefined,
    () => undefined,
  )
  return queued
}

function getDeliveryLogIdentity(record: log) {
  const jobId = record.job?.encryptJobId ?? record.data?.listData?.encryptJobId ?? ''
  // 同一岗位可以有多条记录（不同时间投递），createdAt 参与标识；
  // 纯信息日志没有岗位，用标题兜底。
  return `${jobId}|${record.createdAt}|${jobId ? '' : record.title}`
}

/**
 * 合并两份投递记录。跨标签页写入时，任何一边都可能持有对方没有的记录，
 * 因此不能用「后写覆盖」——那正是多标签页丢投递记录的原因。
 */
export function mergeDeliveryLogs(stored: readonly log[], local: readonly log[]) {
  const merged = new Map<string, log>()
  for (const record of [...stored, ...local]) {
    if (record == null) continue
    const key = getDeliveryLogIdentity(record)
    const existing = merged.get(key)
    if (existing == null) {
      merged.set(key, record)
      continue
    }
    // 同一条记录取更新的一版：updatedAt 缺失时视为未更新过。
    const existingAt = existing.updatedAt ?? existing.createdAt
    const candidateAt = record.updatedAt ?? record.createdAt
    if (candidateAt >= existingAt) merged.set(key, record)
  }
  return newestDeliveryLogs([...merged.values()])
}

async function flush() {
  if (persistTimer != null) {
    window.clearTimeout(persistTimer)
    persistTimer = undefined
  }
  await hydrate()
  const storageKey = activeDeliveryLogKey
  const version = clearVersion
  await enqueuePersistence(async () => {
    await deliveryLogMutex(async () => {
      // 必须在锁内重新读取：另一个标签页可能在本次 flush 之前写入过新记录。
      let stored: log[] = []
      try {
        const saved = await counter.storageGet<log[]>(storageKey, [])
        if (Array.isArray(saved)) stored = saved
      } catch {
        // 读失败时退化为只写本地记录，与之前的行为一致。
      }
      if (version !== clearVersion || storageKey !== activeDeliveryLogKey) return
      const merged = mergeDeliveryLogs(stored, data.value)
      data.value = merged
      await counter.storageSet(storageKey, merged.map(toPersistedLog))
    })
  })
}

async function hydrate() {
  if (hydrated) return
  if (hydratePromise) return hydratePromise

  const version = clearVersion
  hydratePromise = (async () => {
    try {
      const saved = await counter.storageGet<log[]>(activeDeliveryLogKey, [])
      if (version === clearVersion && Array.isArray(saved) && saved.length > 0) {
        const pending = data.value
        const restored = newestDeliveryLogs(saved).map((record) => {
          const hydratedRecord = finalizeInterruptedDelivery(
            restoreLogDataListData({
              ...record,
              publicData: undefined,
            }),
          )
          return refreshPublicLogData(hydratedRecord, hydratedRecord.data)
        })
        data.value = newestDeliveryLogs([...restored, ...pending])
      }
    } catch {
      // Storage failures should not erase in-memory logs from the current page session.
    } finally {
      hydrated = true
      hydratePromise = undefined
    }
    await hydrateRuntimeLogs()
  })()

  return hydratePromise
}

async function hydrateRuntimeLogs() {
  if (!activeRuntimeLogKey) {
    runtimeData.value = []
    return
  }
  if (runtimeHydratePromise) return runtimeHydratePromise
  const version = clearVersion
  const storageKey = activeRuntimeLogKey
  runtimeHydratePromise = (async () => {
    try {
      const saved = await counter.storageGet<log[]>(storageKey, [])
      if (version !== clearVersion || storageKey !== activeRuntimeLogKey) return
      runtimeData.value = Array.isArray(saved)
        ? newestDeliveryLogs(saved).map((record) =>
            refreshPublicLogData({ ...record, publicData: undefined }, record.data),
          )
        : []
    } catch {
      // Background diagnostics are supplementary and must not hide delivery logs.
    } finally {
      runtimeHydratePromise = undefined
    }
  })()
  return runtimeHydratePromise
}

export function useLog() {
  void hydrate()
  const setAccountScope = async (uid: string | number) => {
    const nextAccountUid = normalizeAccountUid(uid)
    if (accountUid === nextAccountUid) {
      await hydrate()
      return
    }

    if (accountUid == null) {
      await hydrate()
      await persistQueue
    } else {
      await flush()
    }
    const legacyRecords = accountUid == null ? newestDeliveryLogs(data.value) : []
    if (persistTimer != null) {
      window.clearTimeout(persistTimer)
      persistTimer = undefined
    }

    clearVersion += 1
    accountUid = nextAccountUid
    activeDeliveryLogKey = createAccountStorageKey(deliveryLogKey, nextAccountUid)
    activeRuntimeLogKey = createAccountStorageKey(runtimeLogKey, nextAccountUid)
    data.value = []
    runtimeData.value = []
    hydrated = false
    hydratePromise = undefined
    runtimeHydratePromise = undefined
    await hydrate()

    if (data.value.length === 0 && legacyRecords.length > 0) {
      data.value = legacyRecords
      const scopedStorageKey = activeDeliveryLogKey
      const snapshot = data.value.map(toPersistedLog)
      await enqueuePersistence(async () => {
        await counter.storageSet(scopedStorageKey, snapshot)
        await counter.storageRm(deliveryLogKey)
      })
    }
  }
  const add = (job: MyJobListData, err: logErr, logdata?: logData, msg?: string) => {
    const state = !err ? 'success' : err.state
    const message = msg ?? (err ? err.message : undefined)

    const record: log = {
      job,
      title: job.jobName,
      state,
      state_name: err?.name ?? '投递成功',
      message,
      data: logdata,
      createdAt: Date.now(),
    }
    refreshPublicLogData(record, logdata)
    data.value = newestDeliveryLogs([record, ...data.value])
    persist()
    return record
  }
  const startDelivery = (job: MyJobListData, logdata: logData) => {
    const record: log = {
      job,
      title: job.jobName,
      state: 'info',
      state_name: '待处理',
      message: undefined,
      data: logdata,
      createdAt: Date.now(),
    }
    refreshPublicLogData(record, logdata)
    data.value = newestDeliveryLogs([record, ...data.value])
    persist()
    return record
  }
  const finishDelivery = (record: log, err: logErr, logdata?: logData, msg?: string) => {
    record.job = record.job ?? logdata?.listData
    record.title = record.job?.jobName ?? record.title
    record.state = !err ? 'success' : err.state
    record.state_name = err?.name ?? '投递成功'
    record.message = msg ?? (err ? err.message : undefined)
    record.data = logdata
    record.updatedAt = Date.now()
    refreshPublicLogData(record, logdata)
    data.value = newestDeliveryLogs(data.value)
    persist()
    return record
  }
  const touchDelivery = (record: log, logdata?: logData) => {
    record.data = logdata ?? record.data
    record.updatedAt = Date.now()
    refreshPublicLogData(record, record.data)
    data.value = newestDeliveryLogs(data.value)
    persist()
    return record
  }
  const info = (title: string, message: string) => {
    data.value = newestDeliveryLogs([
      {
        title,
        state: 'info',
        state_name: '消息',
        message,
        data: undefined,
        createdAt: Date.now(),
      },
      ...data.value,
    ])
    persist()
  }
  const clear = () => {
    clearVersion += 1
    data.value = []
    runtimeData.value = []
    if (persistTimer != null) {
      window.clearTimeout(persistTimer)
      persistTimer = undefined
    }
    const storageKey = activeDeliveryLogKey
    const runtimeStorageKey = activeRuntimeLogKey
    void enqueuePersistence(async () => {
      await counter.storageRm(storageKey)
      if (runtimeStorageKey) await counter.storageRm(runtimeStorageKey)
    }).catch((error) => {
      logger.warn('日志清空失败，请稍后重试', getProviderHeartbeatDiagnostic(error))
    })
  }
  const remove = (record: log) => {
    data.value = data.value.filter((item) => item !== record)
    persist()
  }
  const recentAiGreetings = (limit = 10) => getRecentGreetingSummaries(data.value, limit)

  return {
    data,
    runtimeData,
    setAccountScope,
    hydrate,
    hydrateRuntimeLogs,
    flush,
    clear,
    add,
    startDelivery,
    finishDelivery,
    touchDelivery,
    remove,
    info,
    recentAiGreetings,
  }
}
