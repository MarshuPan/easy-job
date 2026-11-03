import { ref } from 'vue'

import type { LocalDiagnosticEventInput } from '@/background/localDiagnosticSink'
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
import { getCurDay } from '@/utils'
import { createAccountStorageKey, normalizeAccountUid } from '@/utils/accountStorage'
import { isRoutineAiRuntimeRecord } from '@/utils/aiRuntimeLogPolicy'
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
  /** 本次招呼语生成/发送尝试的关联 ID，供本机反馈流和岗位记录互相核对。 */
  greetingId?: string
  greetingAttempt?: number
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

const legacyDeliveryLogKey = 'local:web-geek-job-DeliveryLogs'
const deliveryRecordKeyPrefix = 'local:agent-delivery-records'
const runEventKey = 'local:agent-delivery-run-events'
const runtimeLogKey = 'local:agent-delivery-runtime-logs'
const diagnosticsFlagKey = 'agent-delivery:diagnostics'
/** 运行日志只保留最新这么多条（契约 §7）。 */
export const MAX_RUN_EVENTS = 200
/** 岗位记录按天保存，保留最近这么多天（含今天）。 */
export const DELIVERY_RECORD_RETENTION_DAYS = 7
/**
 * 岗位记录总条数上限（7 天合计），超出时先丢最早的记录。配额是和投递池、缓存、统计共用的，
 * 上限要按最坏情况算：摘要记录约 2.3 KB 一条，带全文和过程记录的约 16 KB 一条，合计约 3.4 MB
 * （log.quota.test.ts 按这个最坏情况量）。
 */
export const MAX_DELIVERY_RECORDS = 1000
/** 只有今天最新的这么多条记录保留 JD 全文和过程记录，其余只留摘要。 */
export const MAX_DETAILED_DELIVERY_RECORDS = 50
const maxPersistedTextLength = 8000
const maxPersistedDetailTextLength = 3000
// JD 只在有 AI 判断可复核时才需要留全文：要回答「过滤得准不准」，就得同时看到判断和它依据
// 的原文。但配额是和投递池、缓存、统计共用的，只有今天最新的一批记录留全文；其余只留摘要，
// 并去掉逐步过程记录——那只在当天排查问题时有用。
const maxPersistedJobDescriptionLength = 200
const maxAuditableJobDescriptionLength = 2000
const maxArchivedJobDescriptionLength = 200
const maxPersistedTraceEntries = 120
const redactedLogValue = '[已脱敏]'
const sensitiveLogKeys = new Set([
  'apikey',
  'xapikey',
  'accesskey',
  'clientsecret',
  'privatekey',
  'authorization',
  'cookie',
  'setcookie',
  'password',
  'passwd',
  'secret',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'sessiontoken',
  'credential',
  'credentials',
  'csrftoken',
  'xsrftoken',
  'bridgetoken',
])
/** 岗位记录：每个处理过的岗位一条，按天保存。 */
const data = ref<log[]>([])
/** 运行日志：任务、补池、异常等运行事件，与岗位记录分开存，互不挤占。 */
const events = ref<log[]>([])
/** 后台写入的 AI 请求诊断。 */
const runtimeData = ref<log[]>([])
let hydrated = false
let hydratePromise: Promise<void> | undefined
let runtimeHydratePromise: Promise<void> | undefined
let persistTimer: number | undefined
let persistQueue: Promise<void> = Promise.resolve()
let clearVersion = 0
let accountUid: string | undefined
let activeRuntimeLogKey: string | undefined
const dirtyRecordDays = new Set<string>()
let eventsDirty = false
/** Records created before the page learns its account must not disappear from the mirror. */
const pendingLocalEvents: Array<Omit<LocalDiagnosticEventInput, 'accountUid'>> = []
const deliveryLogMutex = createStorageMutex('agent-delivery:delivery-logs')

function truncateText(value: string, maxLength: number) {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength)}\n...[已截断 ${value.length - maxLength} 字]`
}

function getLogSortTime(record: log) {
  return record.updatedAt ?? record.createdAt
}

function sortNewest(records: readonly log[]) {
  return records.slice().sort((left, right) => getLogSortTime(right) - getLogSortTime(left))
}

/** 运行日志按时间倒序，只留最新 MAX_RUN_EVENTS 条。 */
export function newestRunEvents(records: readonly log[]) {
  return sortNewest(records).slice(0, MAX_RUN_EVENTS)
}

function isDeliveryRecord(record: log) {
  return record.job != null || record.data?.listData != null
}

function recordDay(record: log) {
  return getCurDay(new Date(record.createdAt))
}

function retainedDays(now = Date.now()) {
  return Array.from({ length: DELIVERY_RECORD_RETENTION_DAYS }, (_, index) =>
    getCurDay(new Date(now - index * 24 * 60 * 60 * 1000)),
  )
}

function isRetainedDay(day: string, now = Date.now()) {
  return retainedDays(now).includes(day)
}

function recordDayKey(uid: string, day: string) {
  return `${createAccountStorageKey(deliveryRecordKeyPrefix, uid)}:${day}`
}

function recordIndexKey(uid: string) {
  return `${createAccountStorageKey(deliveryRecordKeyPrefix, uid)}:days`
}

/** 诊断模式：分页、心跳、运行时检查这类实现细节只在打开时才记录。 */
export function isDiagnosticsEnabled() {
  try {
    return window.localStorage.getItem(diagnosticsFlagKey) === '1'
  } catch {
    return false
  }
}

export function setDiagnosticsEnabled(enabled: boolean) {
  try {
    if (enabled) window.localStorage.setItem(diagnosticsFlagKey, '1')
    else window.localStorage.removeItem(diagnosticsFlagKey)
  } catch {
    // 标签页存储不可用时诊断模式保持关闭，不影响投递。
  }
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

/** 投递请求尚未发出的阶段。此后的阶段都由 `ctx.publish` 推导而来。 */
const prePublishStages: ReadonlySet<string> = new Set<DeliveryStage>([
  '待处理',
  'JD筛选中',
  '打招呼语生成中',
])

/**
 * 判断中断时是否已经发出过 friend/add 请求。
 *
 * 三个信号必须一致才认定「没发出」，任一存疑都按发出过处理：误判成没发会导致重复投递，
 * 白白吃掉沟通额度，而误判成发过只是多让用户核对一次。
 */
function hasAttemptedPublish(ctx: NonNullable<log['data']>, interruptedStage: string) {
  if (ctx.publish != null) return true
  // 阶段名是持久化的，且 `正在建立沟通` 及之后都由 publish 推导，比 trace 可靠——
  // trace 只在内存里累积，页面被重载时未必来得及落盘。
  if (!prePublishStages.has(interruptedStage)) return true
  const trace = ctx.trace
  if (!Array.isArray(trace)) return false
  return trace.some((item) => item?.stage === '投递接口')
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

  // 中断发生在发出投递请求之前时，结果并非「不确定」而是「确定没投」。
  //
  // 最常见的情形是卡在动作闸门限速——日志里出现过等待 158 秒、186 秒的记录，
  // 而 BOSS 的安全校验会在这期间重载页面，content script 连同未写完的检查点一起没了。
  // 这类记录的 trace 停在「动作闸门」，publish 字段根本不存在，却被一律标成
  // 「结果不确定，请人工核对」，把一件本可自动重试的事推给用户去 BOSS 上翻聊天列表。
  //
  // 判据取 trace 里有没有出现过「投递接口」：那是唯一发出 friend/add 请求的阶段，
  // 没有它就不可能建立沟通。请求发出之后被中断的仍然保持原有的保守处理。
  if (!hasAttemptedPublish(ctx, interruptedStage)) {
    const pendingMessage = '上次运行中断于投递请求之前，未发出投递，可重新处理'
    record.state = 'warning'
    record.state_name = '待重试'
    record.message = pendingMessage
    ctx.failureStage = interruptedStage
    ctx.failureReason = pendingMessage
    ctx.retryable = true
    ctx.state = '待重试'
    ctx.err = pendingMessage
    ctx.deliveryStage = '投递失败'
    for (const job of [record.job, ctx.listData]) {
      if (!job?.status) continue
      job.status.status = 'warn'
      job.status.msg = pendingMessage
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
        sensitiveLogKeys.has(key.toLowerCase().replace(/[\s_-]/g, ''))
          ? redactedLogValue
          : redactLogValue(item),
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
  job: MyJobListData | undefined,
  descriptionLength: number,
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
              descriptionLength,
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

/**
 * 岗位记录每类信息只存一份：AI 匹配存结构化结论（原始响应与之重复），招呼语存拆分后的
 * 消息（原始 JSON 与之重复），发送结果不再重复存正文。往天的记录不存过程记录。
 */
function toPersistedLogData(logdata: logData | undefined, archived: boolean): logData | undefined {
  if (!logdata) return undefined
  const persistedGreetingSend = logdata.greetingSend
    ? archived
      ? (() => {
          const { messages: _messages, ...summary } = logdata.greetingSend
          return summary
        })()
      : logdata.greetingSend
    : undefined
  return compactValue(
    {
      // listData 与 record.job 指向同一个岗位，只写 record.job 一份，hydrate 时回填。
      communicationCounted: logdata.communicationCounted,
      greetingId: logdata.greetingId,
      greetingAttempt: logdata.greetingAttempt,
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
      trace: archived
        ? undefined
        : logdata.trace?.slice(-maxPersistedTraceEntries).map((item) => ({
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
      // The local diagnostic mirror receives the complete sent text before this
      // recovery copy is compacted. Archived extension records keep the outcome
      // and counts, while the newest records keep the text for the in-app view.
      greetingSend: persistedGreetingSend,
      aiGreetingMessages: archived ? undefined : logdata.aiGreetingMessages,
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

function localText(value: unknown, _maxLength?: number) {
  // The in-app recovery copy is bounded below, but the local diagnostic mirror
  // must retain the complete business text. The receiver applies only the
  // explicit credential and last-resort resource boundaries.
  return typeof value === 'string' ? value : undefined
}

/** 本机测试镜像不做业务文本摘要；凭据字段由 localDiagnosticSink 统一拦截。 */
function localAuditText(value: unknown) {
  return typeof value === 'string' ? value : undefined
}

function localAuditValue(value: unknown) {
  return toSafeJsonValue(value)
}

function localJobSummary(job: MyJobListData | undefined) {
  if (!job) return undefined
  return {
    jobId: localText(job.encryptJobId),
    encryptBossId: localText(job.encryptBossId),
    securityId: localText(job.securityId),
    lid: localText(job.lid),
    encryptBrandId: localAuditValue(
      (job as MyJobListData & { encryptBrandId?: unknown }).encryptBrandId,
    ),
    jobName: localText(job.jobName),
    brandName: localText(job.brandName),
    brandScaleName: localText(job.brandScaleName),
    salaryDesc: localText(job.salaryDesc),
    cityName: localText(job.cityName),
    jobExperience: localText(job.jobExperience),
    jobDegree: localText(job.jobDegree),
    bossTitle: localText(job.bossTitle),
  }
}

function localTraceDetail(value: unknown) {
  const safe = localAuditValue(value)
  if (!safe || typeof safe !== 'object' || Array.isArray(safe)) return safe
  const detail = safe as Record<string, unknown>
  const pending = detail.pendingStatus
  if (!pending || typeof pending !== 'object' || Array.isArray(pending)) return detail
  const pendingRecord = pending as Record<string, unknown>
  return {
    ...detail,
    pendingStage: pendingRecord.stage,
    pendingReason: pendingRecord.reason,
    pendingWaitingFor: pendingRecord.waitingFor,
    pendingObservedAt: pendingRecord.observedAt,
  }
}

function localDeliverySummary(record: log) {
  const context = record.data
  return {
    // Keep the complete top-level record as a forward-compatible escape hatch:
    // adding a field to `log` must not silently make it unavailable to local
    // diagnosis before this projection is updated.
    recordSnapshot: localAuditValue(record),
    job: localJobSummary(record.job ?? context?.listData),
    // Keep both candidates: choosing record.job first can otherwise hide a
    // newer detail object held in logData.listData.
    jobSnapshot: localAuditValue(record.job),
    listDataSnapshot: localAuditValue(context?.listData),
    // 摘要便于检索，完整对象用于复核岗位/招聘者字段是否在采集或合并时复用。
    jobDetail: localAuditValue(record.job ?? context?.listData),
    // Preserve fields added to logData in later versions without having to
    // update this mirror projection first.
    dataSnapshot: localAuditValue(context),
    bossData: localAuditValue(context?.bossData),
    bossId: localAuditValue(context?.bossData?.data?.bossId),
    title: localText(record.title),
    state: record.state,
    stateName: localText(record.state_name),
    message: localAuditText(record.message),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    deliverySource: context?.deliverySource,
    deliverySourceName: localText(context?.deliverySourceName),
    greetingId: context?.greetingId,
    greetingAttempt: context?.greetingAttempt,
    deliveryStage: context?.deliveryStage,
    failureStage: context?.failureStage,
    failureReason: localAuditText(context?.failureReason),
    retryable: context?.retryable,
    retryAttempts: context?.retryAttempts,
    matchPercent: context?.matchPercent,
    aiFilteringThreshold: context?.aiFilteringThreshold,
    aiFilteringRawResponse: localAuditValue(context?.aiFilteringAjson),
    aiFilteringResponseText: localAuditText(context?.aiFilteringAtext),
    aiFilteringReasoningContent: localAuditText(context?.aiFilteringR),
    aiGreetingRawResponse: localAuditText(context?.aiGreetingA),
    aiGreetingReasoningContent: localAuditText(context?.aiGreetingR),
    aiGreetingMessages: localAuditValue(context?.aiGreetingMessages),
    aiFilteringDecision: context?.aiFilteringDecision
      ? {
          rawResponse: localAuditValue(context.aiFilteringAjson),
          responseText: localAuditText(context.aiFilteringAtext),
          reasoningContent: localAuditText(context.aiFilteringR),
          matchPercent: context.aiFilteringDecision.matchPercent,
          level: context.aiFilteringDecision.level,
          selectedFactIds: context.aiFilteringDecision.selectedFactIds,
          claimMode: context.aiFilteringDecision.claimMode,
          reason: localAuditText(context.aiFilteringDecision.reason),
          risk: localAuditText(context.aiFilteringDecision.risk),
        }
      : undefined,
    aiGreetingMeta: context?.aiGreetingMeta
      ? {
          rawResponse: localAuditText(context.aiGreetingA),
          reasoningContent: localAuditText(context.aiGreetingR),
          messages: localAuditValue(context.aiGreetingMessages),
          promptFingerprint: context.aiGreetingMeta.promptFingerprint,
          usedFactIds: context.aiGreetingMeta.usedFactIds,
          segmentFactIds: context.aiGreetingMeta.segmentFactIds,
          resumeEvidenceVersion: context.aiGreetingMeta.resumeEvidenceVersion,
          resumeSourceHash: context.aiGreetingMeta.resumeSourceHash,
          anchor: context.aiGreetingMeta.anchor,
          review: context.aiGreetingMeta.review,
          audit: context.aiGreetingMeta.audit,
        }
      : undefined,
    publish: context?.publish
      ? {
          ok: context.publish.ok,
          attempts: context.publish.attempts,
          phase: context.publish.phase,
          code: context.publish.code,
          message: localAuditText(context.publish.message),
          error: localAuditText(context.publish.error),
          response: localAuditValue(context.publish.data),
        }
      : undefined,
    greetingSend: context?.greetingSend
      ? {
          ok: context.greetingSend.ok,
          type: context.greetingSend.type,
          channel: localAuditText(context.greetingSend.channel),
          error: localAuditText(context.greetingSend.error),
          contentLength: context.greetingSend.contentLength,
          messageCount: context.greetingSend.messageCount,
          messages: localAuditValue(context.greetingSend.messages),
          detail: localAuditValue(context.greetingSend.detail),
        }
      : undefined,
    trace: context?.trace?.map((item) => ({
      at: item.at,
      stage: localAuditText(item.stage),
      status: item.status,
      message: localAuditText(item.message),
      detail: localTraceDetail(item.detail),
    })),
  }
}

function mirrorLocalEvent(input: Omit<LocalDiagnosticEventInput, 'accountUid'>) {
  const append = (
    counter as typeof counter & {
      localDiagnosticAppend?: (event: LocalDiagnosticEventInput) => Promise<boolean>
    }
  ).localDiagnosticAppend
  if (accountUid == null || typeof append !== 'function') {
    pendingLocalEvents.push(input)
    return
  }
  void append({ ...input, accountUid }).catch(() => undefined)
}

function flushPendingLocalEvents() {
  if (accountUid == null || pendingLocalEvents.length === 0) return
  const append = (
    counter as typeof counter & {
      localDiagnosticAppend?: (event: LocalDiagnosticEventInput) => Promise<boolean>
    }
  ).localDiagnosticAppend
  if (typeof append !== 'function') return
  const pending = pendingLocalEvents.splice(0)
  for (const input of pending) void append({ ...input, accountUid }).catch(() => undefined)
}

function mirrorDeliveryRecord(record: log, event: string) {
  mirrorLocalEvent({
    stream: 'deliveries',
    event,
    at: record.updatedAt ?? record.createdAt,
    data: localDeliverySummary(record),
  })
}

function toPersistedLog(record: log, archived = false): log {
  const hasAiDecision =
    record.data?.aiFilteringDecision != null || record.data?.matchPercent != null
  const descriptionLength = archived
    ? maxArchivedJobDescriptionLength
    : hasAiDecision
      ? maxAuditableJobDescriptionLength
      : maxPersistedJobDescriptionLength
  return compactValue(
    {
      job: toPersistedJob(record.job ?? record.data?.listData, descriptionLength),
      title: record.title,
      state: record.state,
      state_name: record.state_name,
      message: record.message,
      data: toPersistedLogData(record.data, archived),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    },
    maxPersistedTextLength,
  ) as log
}

function toPersistedEvent(record: log): log {
  return compactValue(
    {
      title: record.title,
      state: record.state,
      state_name: record.state_name,
      message: record.message,
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

function markRecordDirty(record: log) {
  dirtyRecordDays.add(recordDay(record))
  persist()
}

function markEventsDirty() {
  eventsDirty = true
  persist()
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
  // 同一岗位可以有多条记录（不同时间投递），createdAt 参与标识；运行事件没有岗位，用标题兜底。
  return `${jobId}|${record.createdAt}|${jobId ? '' : record.title}`
}

function mergeByIdentity(stored: readonly log[], local: readonly log[]) {
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
  return sortNewest([...merged.values()])
}

/**
 * 合并两份岗位记录。跨标签页写入时，任何一边都可能持有对方没有的记录，
 * 因此不能用「后写覆盖」——那正是多标签页丢投递记录的原因。
 */
export function mergeDeliveryLogs(stored: readonly log[], local: readonly log[]) {
  return mergeByIdentity(stored, local).slice(0, MAX_DELIVERY_RECORDS)
}

/** 超出总上限时，早于这个时间的记录要丢掉；没超出时返回 undefined。 */
function retainedRecordCutoff(records: readonly log[]) {
  if (records.length <= MAX_DELIVERY_RECORDS) return undefined
  const createdAt = records.map((record) => record.createdAt).sort((left, right) => right - left)
  return createdAt[MAX_DELIVERY_RECORDS - 1]
}

async function readArray(key: string): Promise<log[]> {
  try {
    const saved = await counter.storageGet<log[]>(key, [])
    return Array.isArray(saved) ? saved : []
  } catch {
    return []
  }
}

async function readRecordDays(uid: string) {
  try {
    const saved = await counter.storageGet<string[]>(recordIndexKey(uid), [])
    return Array.isArray(saved) ? saved.filter((day) => typeof day === 'string') : []
  } catch {
    return []
  }
}

async function flush() {
  if (persistTimer != null) {
    window.clearTimeout(persistTimer)
    persistTimer = undefined
  }
  await hydrate()
  const uid = accountUid
  // 账号识别前只留在内存里；识别账号后整体写入该账号的存储。
  if (uid == null) return
  const version = clearVersion
  const today = getCurDay()
  const days = new Set([...dirtyRecordDays, today])
  dirtyRecordDays.clear()
  const cutoff = retainedRecordCutoff(data.value)
  if (cutoff != null) {
    // 超出总上限的记录分布在最早的几天里，那几天要重写一遍才能真正删掉。
    for (const record of data.value) if (record.createdAt < cutoff) days.add(recordDay(record))
  }
  const writeEvents = eventsDirty
  eventsDirty = false
  try {
    await enqueuePersistence(async () => {
      await deliveryLogMutex(async () => {
        const indexedDays = new Set(await readRecordDays(uid))
        let indexChanged = false
        for (const day of days) {
          if (!isRetainedDay(day)) continue
          // 必须在锁内重新读取：另一个标签页可能在本次 flush 之前写入过新记录。
          const stored = (await readArray(recordDayKey(uid, day))).map(restoreLogDataListData)
          if (version !== clearVersion || uid !== accountUid) return
          const local = data.value.filter((record) => recordDay(record) === day)
          if (stored.length === 0 && local.length === 0) continue
          const merged = mergeDeliveryLogs(stored, local).filter(
            (record) => cutoff == null || record.createdAt >= cutoff,
          )
          data.value = sortNewest([
            ...data.value.filter((record) => recordDay(record) !== day),
            ...merged,
          ])
          if (merged.length === 0) {
            await counter.storageRm(recordDayKey(uid, day))
            indexChanged = indexedDays.delete(day) || indexChanged
            continue
          }
          await counter.storageSet(
            recordDayKey(uid, day),
            merged.map((record, index) =>
              toPersistedLog(record, day !== today || index >= MAX_DETAILED_DELIVERY_RECORDS),
            ),
          )
          if (!indexedDays.has(day)) {
            indexedDays.add(day)
            indexChanged = true
          }
        }
        if (indexChanged) {
          await counter.storageSet(recordIndexKey(uid), [...indexedDays].sort())
        }
        if (writeEvents) {
          const eventKey = createAccountStorageKey(runEventKey, uid)
          const storedEvents = await readArray(eventKey)
          if (version !== clearVersion || uid !== accountUid) return
          const merged = newestRunEvents(mergeByIdentity(storedEvents, events.value))
          events.value = merged
          await counter.storageSet(eventKey, merged.map(toPersistedEvent))
        }
      })
    })
  } catch (error) {
    for (const day of days) dirtyRecordDays.add(day)
    if (writeEvents) eventsDirty = true
    throw error
  }
}

/**
 * 旧版把岗位记录和运行消息存在同一个键里、共用 200 条上限。迁移时岗位记录按天归档，
 * 运行消息并入运行日志，然后删掉旧键。
 */
async function migrateLegacyLogs(uid: string) {
  const keys = [legacyDeliveryLogKey, createAccountStorageKey(legacyDeliveryLogKey, uid)]
  const legacy: log[] = []
  for (const key of keys) legacy.push(...(await readArray(key)))
  if (legacy.length === 0) return
  const migratedRecords: log[] = []
  const migratedEvents: log[] = []
  for (const record of legacy) {
    if (isDeliveryRecord(record)) {
      if (!isRetainedDay(recordDay(record))) continue
      const restored = finalizeInterruptedDelivery(restoreLogDataListData(record))
      migratedRecords.push(restored)
      dirtyRecordDays.add(recordDay(restored))
    } else {
      migratedEvents.push(record)
    }
  }
  data.value = mergeByIdentity(migratedRecords, data.value)
  if (migratedEvents.length > 0) {
    events.value = newestRunEvents(mergeByIdentity(migratedEvents, events.value))
    eventsDirty = true
  }
  await flush()
  await enqueuePersistence(async () => {
    for (const key of keys) await counter.storageRm(key)
  })
}

async function hydrate() {
  if (hydrated) return
  if (hydratePromise) return hydratePromise
  const uid = accountUid
  if (uid == null) {
    hydrated = true
    return
  }

  const version = clearVersion
  hydratePromise = (async () => {
    try {
      const storedDays = await readRecordDays(uid)
      const keepDays = storedDays.filter((day) => isRetainedDay(day))
      const expiredDays = storedDays.filter((day) => !isRetainedDay(day))
      const restored: log[] = []
      for (const day of keepDays) {
        const saved = await readArray(recordDayKey(uid, day))
        restored.push(
          ...saved.map((record) => finalizeInterruptedDelivery(restoreLogDataListData(record))),
        )
      }
      const savedEvents = await readArray(createAccountStorageKey(runEventKey, uid))
      if (version !== clearVersion || uid !== accountUid) return
      data.value = mergeByIdentity(restored, data.value)
      events.value = newestRunEvents(mergeByIdentity(savedEvents, events.value))
      if (expiredDays.length > 0) {
        await enqueuePersistence(async () => {
          for (const day of expiredDays) await counter.storageRm(recordDayKey(uid, day))
          await counter.storageSet(recordIndexKey(uid), keepDays)
        })
      }
    } catch {
      // Storage failures should not erase in-memory logs from the current page session.
    } finally {
      hydrated = true
      hydratePromise = undefined
    }
    try {
      await migrateLegacyLogs(uid)
    } catch (error) {
      logger.warn('旧版日志迁移失败，下次加载时重试', getProviderHeartbeatDiagnostic(error))
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
        ? newestRunEvents(saved.filter((record) => !isRoutineAiRuntimeRecord(record))).map(
            (record) => refreshPublicLogData({ ...record, publicData: undefined }, record.data),
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

    if (accountUid != null) await flush()
    await persistQueue
    // 账号识别前产生的记录属于这个页面、也就是即将识别出的账号；换账号时则清空。
    const carriedRecords = accountUid == null ? data.value : []
    const carriedEvents = accountUid == null ? events.value : []
    if (persistTimer != null) {
      window.clearTimeout(persistTimer)
      persistTimer = undefined
    }

    clearVersion += 1
    accountUid = nextAccountUid
    activeRuntimeLogKey = createAccountStorageKey(runtimeLogKey, nextAccountUid)
    data.value = [...carriedRecords]
    events.value = [...carriedEvents]
    runtimeData.value = []
    dirtyRecordDays.clear()
    for (const record of carriedRecords) dirtyRecordDays.add(recordDay(record))
    eventsDirty = carriedEvents.length > 0
    hydrated = false
    hydratePromise = undefined
    runtimeHydratePromise = undefined
    await hydrate()
    flushPendingLocalEvents()
    if (carriedRecords.length > 0 || carriedEvents.length > 0) await flush()
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
    data.value = sortNewest([record, ...data.value])
    markRecordDirty(record)
    mirrorDeliveryRecord(record, 'delivery.finished')
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
    data.value = sortNewest([record, ...data.value])
    markRecordDirty(record)
    mirrorDeliveryRecord(record, 'delivery.started')
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
    data.value = sortNewest(data.value)
    markRecordDirty(record)
    mirrorDeliveryRecord(record, 'delivery.finished')
    return record
  }
  const touchDelivery = (record: log, logdata?: logData) => {
    record.data = logdata ?? record.data
    record.updatedAt = Date.now()
    data.value = sortNewest(data.value)
    markRecordDirty(record)
    mirrorDeliveryRecord(record, 'delivery.updated')
    return record
  }
  const pushEvent = (
    title: string,
    message: string,
    state: logState,
    detail?: Record<string, unknown>,
  ) => {
    const record: log = {
      title,
      state,
      state_name: runEventStateNames[state],
      message,
      data: undefined,
      createdAt: Date.now(),
    }
    events.value = newestRunEvents([record, ...events.value])
    markEventsDirty()
    mirrorLocalEvent({
      stream: 'logs',
      event: 'runtime.event',
      at: record.createdAt,
      data: {
        title: localText(record.title, 160),
        state: record.state,
        stateName: localText(record.state_name, 80),
        // The UI keeps its compact message, but the local diagnostic mirror is
        // the source used to reconstruct a run and must retain the full text.
        message: localAuditText(record.message),
        detail: localAuditValue(detail),
      },
    })
  }
  /** 运行日志：用户需要知道的运行事件。 */
  const info = (
    title: string,
    message: string,
    state: logState = 'info',
    detail?: Record<string, unknown>,
  ) => pushEvent(title, message, state, detail)
  /** 实现细节：只在诊断模式打开时记录。 */
  const debug = (title: string, message: string, detail?: Record<string, unknown>) => {
    if (isDiagnosticsEnabled()) pushEvent(`诊断 · ${title}`, message, 'info', detail)
  }
  /** 本机结构化诊断不依赖界面文案或诊断模式，也不占运行日志条数。 */
  const recordDiagnostic = (message: string, detail: Record<string, unknown>) => {
    mirrorLocalEvent({
      stream: 'logs',
      event: 'runtime.diagnostic',
      at: Date.now(),
      data: {
        message: localAuditText(message),
        detail: localAuditValue(detail) as Record<string, unknown>,
      },
    })
  }
  /** 清空运行日志。岗位记录是投递历史，不随运行日志一起清空。 */
  const clear = () => {
    clearVersion += 1
    events.value = []
    runtimeData.value = []
    eventsDirty = false
    if (persistTimer != null) {
      window.clearTimeout(persistTimer)
      persistTimer = undefined
    }
    const uid = accountUid
    const runtimeStorageKey = activeRuntimeLogKey
    void enqueuePersistence(async () => {
      if (uid != null) await counter.storageRm(createAccountStorageKey(runEventKey, uid))
      if (runtimeStorageKey) await counter.storageRm(runtimeStorageKey)
    })
      .then(() => {
        // 清空打断了本轮自动保存；岗位记录的变更仍要写下去。
        if (dirtyRecordDays.size > 0) persist()
      })
      .catch((error) => {
        logger.warn('日志清空失败，请稍后重试', getProviderHeartbeatDiagnostic(error))
      })
  }
  const remove = (record: log) => {
    data.value = data.value.filter((item) => item !== record)
    const uid = accountUid
    if (uid == null) return
    const day = recordDay(record)
    const identity = getDeliveryLogIdentity(record)
    // 合并写入不会删掉存储里已有的记录，删除要按天直接重写。
    void enqueuePersistence(async () => {
      await deliveryLogMutex(async () => {
        const stored = await readArray(recordDayKey(uid, day))
        await counter.storageSet(
          recordDayKey(uid, day),
          stored.filter((item) => getDeliveryLogIdentity(item) !== identity),
        )
      })
    }).catch((error) => {
      logger.warn('删除岗位记录失败', getProviderHeartbeatDiagnostic(error))
    })
  }
  const recentAiGreetings = (limit = 10) => getRecentGreetingSummaries(data.value, limit)

  return {
    data,
    events,
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
    debug,
    recordDiagnostic,
    recentAiGreetings,
  }
}

const runEventStateNames: Record<logState, string> = {
  info: '消息',
  success: '完成',
  warning: '注意',
  danger: '异常',
}
