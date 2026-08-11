import type { GreetingFilteringContext, RecentGreetingSummary } from '@/types/aiGreeting'
import type { messageReps } from '@/types/aiProtocol'

import { getAiTaskDiagnostics } from './backgroundAiDiagnostics'

export const AI_TASK_REQUEST_TYPE = 'agent-delivery:ai-task-request'
export const AI_TASK_RESPONSE_TYPE = 'agent-delivery:ai-task-response'
/**
 * 单次 AI 请求的重试次数，也就是总共尝试 3 次。
 *
 * 上层遇到 AI 失败会暂停整轮投递，所以判定「失败」之前必须给足瞬时故障的机会——
 * 网络抖动、限流、供应商 5xx 都属于重试一次就能过去的情况。
 */
export const AI_TASK_MAX_RETRIES = 2
export const AI_TASK_MAX_RETRY_DELAY_SECONDS = 60
export const AI_TASK_CLIENT_TIMEOUT_BUFFER_SECONDS = 5
export const AI_TASK_MAX_DEPTH = 8
export const AI_TASK_MAX_STRING_LENGTH = 32 * 1024
export const AI_TASK_MAX_ARRAY_LENGTH = 200
export const AI_TASK_MAX_TOTAL_LENGTH = 256 * 1024
export const AI_TASK_ERROR_CODE = 'AI_TASK_FAILED'

export type AiTaskErrorCode =
  | 'AI_TASK_TIMEOUT'
  | 'AI_TASK_RATE_LIMITED'
  | 'AI_TASK_AUTH_FAILED'
  | 'AI_TASK_HTTP_FAILED'
  | 'AI_TASK_RESPONSE_INVALID'
  | typeof AI_TASK_ERROR_CODE

export type AiTaskType = 'aiFiltering' | 'aiGreeting'

export interface AiTaskData {
  accountUid?: string
  /** 只在招呼语任务里出现：匹配任务看到阈值就会先定结论再补分数。 */
  filteringThreshold?: number
  data?: bossZpJobItemData
  boss?: bossZpBossData
  card?: bossZpCardData
  amap?: unknown
  filtering?: GreetingFilteringContext
  recentGreetings?: RecentGreetingSummary[]
}

export interface AiTaskRequestMessage {
  type: typeof AI_TASK_REQUEST_TYPE
  requestId: string
  task: AiTaskType
  data: AiTaskData
  json?: boolean
  bridgeToken?: string | null
}

export interface AiTaskResponseMessage {
  type: typeof AI_TASK_RESPONSE_TYPE
  requestId: string
  ok: boolean
  data?: Omit<messageReps, 'prompt' | 'diagnostics' | 'reasoning_content'>
  error?: string
  errorCode?: AiTaskErrorCode
}

const aiTaskStaticErrors: Partial<Record<AiTaskErrorCode, string>> = {
  AI_TASK_TIMEOUT: '后台AI任务超时',
  AI_TASK_RATE_LIMITED: '后台AI请求触发限流',
  AI_TASK_AUTH_FAILED: '后台AI鉴权失败',
  AI_TASK_RESPONSE_INVALID: '后台AI响应格式异常',
  AI_TASK_FAILED: '后台AI任务失败',
}
const aiTaskErrorCodes = new Set<AiTaskErrorCode>([
  'AI_TASK_TIMEOUT',
  'AI_TASK_RATE_LIMITED',
  'AI_TASK_AUTH_FAILED',
  'AI_TASK_HTTP_FAILED',
  'AI_TASK_RESPONSE_INVALID',
  AI_TASK_ERROR_CODE,
])
const safeAiTaskIssueCodePattern = /^[A-Z][A-Z0-9_]{0,39}$/

export class AiTaskResponseInvalidError extends Error {
  readonly attempt: number
  readonly issueCodes: string[]

  constructor(attempt: number, issueCodes: string[]) {
    const safeAttempt = Math.max(1, Math.min(9, Math.trunc(attempt)))
    const safeIssueCodes = Array.from(
      new Set(issueCodes.filter((code) => safeAiTaskIssueCodePattern.test(code))),
    ).slice(0, 8)
    const normalizedIssueCodes = safeIssueCodes.length > 0 ? safeIssueCodes : ['UNKNOWN']
    super(`AI响应质量门禁失败（第${safeAttempt}次：${normalizedIssueCodes.join(',')}）`)
    this.name = 'AiTaskResponseInvalidError'
    this.attempt = safeAttempt
    this.issueCodes = normalizedIssueCodes
  }

  get publicMessage() {
    return `后台AI响应格式异常（第${this.attempt}次：${this.issueCodes.join(',')}）`
  }
}

function omitPrivateAiResult(
  data: Omit<messageReps, 'prompt'> | messageReps,
): Omit<messageReps, 'prompt' | 'diagnostics' | 'reasoning_content'> {
  const cloned = { ...data } as Partial<messageReps>
  delete cloned.prompt
  delete cloned.diagnostics
  delete cloned.reasoning_content
  return cloned as Omit<messageReps, 'prompt' | 'diagnostics' | 'reasoning_content'>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value)
}

function getErrorText(error: unknown) {
  if (error instanceof Error) return `${error.name} ${error.message}`
  return typeof error === 'string' ? error : ''
}

function getFailedHttpStatus(error: unknown) {
  const attempts = getAiTaskDiagnostics(error)?.attempts ?? []
  for (let index = attempts.length - 1; index >= 0; index--) {
    const attempt = attempts[index]
    if (
      attempt?.ok === false &&
      Number.isInteger(attempt.status) &&
      attempt.status! >= 400 &&
      attempt.status! <= 599
    ) {
      return attempt.status
    }
  }
  return undefined
}

function classifyAiTaskError(error: unknown): { errorCode: AiTaskErrorCode; error: string } {
  const status = getFailedHttpStatus(error)
  if (status === 401 || status === 403) {
    return { errorCode: 'AI_TASK_AUTH_FAILED', error: '后台AI鉴权失败' }
  }
  if (status === 429) {
    return { errorCode: 'AI_TASK_RATE_LIMITED', error: '后台AI请求触发限流' }
  }
  if (status === 408 || status === 504) {
    return { errorCode: 'AI_TASK_TIMEOUT', error: '后台AI任务超时' }
  }
  if (status != null) {
    return {
      errorCode: 'AI_TASK_HTTP_FAILED',
      error: `后台AI请求失败（HTTP ${status}）`,
    }
  }

  const errorText = getErrorText(error)
  if (error instanceof AiTaskResponseInvalidError) {
    return { errorCode: 'AI_TASK_RESPONSE_INVALID', error: error.publicMessage }
  }
  if (/timeout|timed out|aborterror|超时/i.test(errorText)) {
    return { errorCode: 'AI_TASK_TIMEOUT', error: '后台AI任务超时' }
  }
  if (
    /(?:AI|后台AI).*响应.*(?:JSON|Content-Type|格式|过大|缺少|不合法|未完成)|response id/i.test(
      errorText,
    )
  ) {
    return { errorCode: 'AI_TASK_RESPONSE_INVALID', error: '后台AI响应格式异常' }
  }
  return { errorCode: AI_TASK_ERROR_CODE, error: '后台AI任务失败' }
}

function isSafeAiTaskError(errorCode: unknown, error: unknown) {
  if (typeof errorCode !== 'string' || !aiTaskErrorCodes.has(errorCode as AiTaskErrorCode)) {
    return false
  }
  if (typeof error !== 'string') return false
  if (errorCode === 'AI_TASK_HTTP_FAILED') {
    return /^后台AI请求失败（HTTP [45]\d{2}）$/.test(error)
  }
  if (errorCode === 'AI_TASK_RESPONSE_INVALID') {
    return (
      error === aiTaskStaticErrors.AI_TASK_RESPONSE_INVALID ||
      /^后台AI响应格式异常（第[1-9]次：[A-Z][A-Z0-9_]{0,39}(?:,[A-Z][A-Z0-9_]{0,39}){0,7}）$/.test(
        error,
      )
    )
  }
  return aiTaskStaticErrors[errorCode as AiTaskErrorCode] === error
}

const aiTaskRequestKeys = new Set(['type', 'requestId', 'task', 'data', 'json', 'bridgeToken'])
const aiTaskDataKeys = new Set([
  'accountUid',
  'filteringThreshold',
  'data',
  'boss',
  'card',
  'amap',
  'filtering',
  'recentGreetings',
])
const filteringContextKeys = new Set([
  'matchPercent',
  'level',
  'reason',
  'risk',
  'selectedFactIds',
  'claimMode',
])
const recentGreetingKeys = new Set([
  'sentAt',
  'usedFactIds',
  'openingPattern',
  'messages',
  'fingerprint',
])
const matchLevels = new Set(['strong', 'good', 'maybe', 'weak', 'reject'])

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: Set<string>) {
  return Object.keys(value).every((key) => allowedKeys.has(key))
}

function isBoundedFactIdList(value: unknown, minimumLength = 1): value is string[] {
  if (!Array.isArray(value) || value.length < minimumLength || value.length > 2) return false
  if (
    !value.every(
      (item): item is string => typeof item === 'string' && item.length > 0 && item === item.trim(),
    )
  ) {
    return false
  }
  return new Set(value).size === value.length
}

function isGreetingFilteringContext(
  value: unknown,
  filteringThreshold: number,
): value is GreetingFilteringContext {
  if (!isRecord(value) || !hasOnlyKeys(value, filteringContextKeys)) return false
  if (
    !Number.isInteger(value.matchPercent) ||
    (value.matchPercent as number) < filteringThreshold ||
    (value.matchPercent as number) > 100 ||
    !matchLevels.has(value.level as string) ||
    typeof value.reason !== 'string' ||
    (value.risk !== undefined && typeof value.risk !== 'string') ||
    !isBoundedFactIdList(value.selectedFactIds, 1)
  ) {
    return false
  }
  return value.claimMode === 'adjacent' || value.claimMode === 'direct'
}

function isRecentGreetingSummary(value: unknown): value is RecentGreetingSummary {
  if (!isRecord(value) || !hasOnlyKeys(value, recentGreetingKeys)) return false
  return (
    typeof value.sentAt === 'number' &&
    Number.isFinite(value.sentAt) &&
    isBoundedFactIdList(value.usedFactIds) &&
    typeof value.openingPattern === 'string' &&
    Array.isArray(value.messages) &&
    value.messages.length >= 1 &&
    value.messages.length <= 5 &&
    value.messages.every((message) => typeof message === 'string') &&
    typeof value.fingerprint === 'string'
  )
}

function getTaskSpecificDataValidationError(task: AiTaskType, data: Record<string, unknown>) {
  if (
    data.accountUid !== undefined &&
    (typeof data.accountUid !== 'string' ||
      data.accountUid.length === 0 ||
      data.accountUid.length > 128)
  ) {
    return '后台AI任务账号 UID 不合法'
  }
  if (task === 'aiFiltering') {
    if ('filtering' in data || 'recentGreetings' in data) {
      return 'AI匹配度任务不接受招呼语上下文'
    }
    // 匹配任务不接受投递阈值。阈值一旦进了发给模型的数据，模型就会先决定「投不投」再
    // 反推一个刚好落在线下的分数——真机上整整一轮的理由都写着「暂不达到自动投递门槛」，
    // 分数成了结论的装饰。评分和阈值比较必须分开：模型只评能力，达标与否由代码判定。
    if ('filteringThreshold' in data) {
      return 'AI匹配度任务不接受投递阈值'
    }
    return null
  }

  if (
    !Number.isInteger(data.filteringThreshold) ||
    (data.filteringThreshold as number) < 0 ||
    (data.filteringThreshold as number) > 100
  ) {
    return 'AI匹配度阈值不合法'
  }

  if (
    data.filtering !== undefined &&
    !isGreetingFilteringContext(data.filtering, data.filteringThreshold as number)
  ) {
    return 'AI招呼语筛选上下文不合法'
  }
  if (
    data.recentGreetings !== undefined &&
    (!Array.isArray(data.recentGreetings) ||
      data.recentGreetings.length > 10 ||
      !data.recentGreetings.every(isRecentGreetingSummary))
  ) {
    return 'AI招呼语近期记录不合法'
  }
  return null
}

function findAiTaskValueLimitError(value: unknown, depth = 0): string | null {
  if (typeof value === 'string') {
    return value.length > AI_TASK_MAX_STRING_LENGTH
      ? `后台AI任务字符串超过 ${AI_TASK_MAX_STRING_LENGTH} 字符限制`
      : null
  }
  if (
    value == null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    value === undefined
  ) {
    return null
  }
  if (depth > AI_TASK_MAX_DEPTH) {
    return `后台AI任务数据嵌套超过 ${AI_TASK_MAX_DEPTH} 层限制`
  }
  if (Array.isArray(value)) {
    if (value.length > AI_TASK_MAX_ARRAY_LENGTH) {
      return `后台AI任务数组超过 ${AI_TASK_MAX_ARRAY_LENGTH} 项限制`
    }
    for (const item of value) {
      const error = findAiTaskValueLimitError(item, depth + 1)
      if (error) return error
    }
    return null
  }
  if (!isRecord(value)) return '后台AI任务包含不支持的数据类型'

  for (const item of Object.values(value)) {
    const error = findAiTaskValueLimitError(item, depth + 1)
    if (error) return error
  }
  return null
}

export function getAiTaskRequestValidationError(message: unknown): string | null {
  if (!isRecord(message) || message.type !== AI_TASK_REQUEST_TYPE) {
    return '后台AI任务消息类型不合法'
  }
  const unknownRequestKey = Object.keys(message).find((key) => !aiTaskRequestKeys.has(key))
  if (unknownRequestKey) return `后台AI任务包含不允许的顶层字段: ${unknownRequestKey}`
  if (typeof message.requestId !== 'string' || message.requestId.length === 0) {
    return '后台AI任务 requestId 不合法'
  }
  if (message.task !== 'aiFiltering' && message.task !== 'aiGreeting') {
    return '后台AI任务类型不合法'
  }
  if (message.json != null && typeof message.json !== 'boolean') {
    return '后台AI任务 json 标记不合法'
  }
  if (message.bridgeToken != null && typeof message.bridgeToken !== 'string') {
    return '后台AI任务 bridgeToken 不合法'
  }
  if (!isRecord(message.data)) return '后台AI任务 data 不合法'
  const unknownDataKey = Object.keys(message.data).find((key) => !aiTaskDataKeys.has(key))
  if (unknownDataKey) return `后台AI任务 data 包含不允许的顶层字段: ${unknownDataKey}`
  const taskSpecificError = getTaskSpecificDataValidationError(message.task, message.data)
  if (taskSpecificError) return taskSpecificError

  let serialized: string
  try {
    serialized = JSON.stringify(message)
  } catch {
    return '后台AI任务必须是可序列化数据'
  }
  if (serialized.length > AI_TASK_MAX_TOTAL_LENGTH) {
    return `后台AI任务总大小超过 ${AI_TASK_MAX_TOTAL_LENGTH} 字符限制`
  }
  return findAiTaskValueLimitError(message.data)
}

export function isAiTaskRequestMessage(message: unknown): message is AiTaskRequestMessage {
  return getAiTaskRequestValidationError(message) == null
}

export function isAiTaskResponseMessage(message: unknown): message is AiTaskResponseMessage {
  if (
    !isRecord(message) ||
    message.type !== AI_TASK_RESPONSE_TYPE ||
    typeof message.requestId !== 'string' ||
    typeof message.ok !== 'boolean'
  ) {
    return false
  }
  const allowedKeys = message.ok
    ? new Set(['type', 'requestId', 'ok', 'data'])
    : new Set(['type', 'requestId', 'ok', 'error', 'errorCode'])
  if (Object.keys(message).some((key) => !allowedKeys.has(key))) return false
  if (message.ok) return message.data == null || isRecord(message.data)
  return isSafeAiTaskError(message.errorCode, message.error)
}

export function createAiTaskResponse(
  requestId: string,
  result:
    | { ok: true; data: Omit<messageReps, 'prompt'> | messageReps }
    | { ok: false; error: unknown },
): AiTaskResponseMessage {
  if (result.ok) {
    return {
      type: AI_TASK_RESPONSE_TYPE,
      requestId,
      ok: true,
      data: omitPrivateAiResult(result.data),
    }
  }

  const safeError = classifyAiTaskError(result.error)
  return {
    type: AI_TASK_RESPONSE_TYPE,
    requestId,
    ok: false,
    ...safeError,
  }
}
