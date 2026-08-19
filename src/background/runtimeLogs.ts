import { storage } from '#imports'
import { createAccountStorageKey, normalizeAccountUid } from '@/utils/accountStorage'
import type { AiRuntimeDiagnosticEvent } from '@/utils/backgroundAi'

const runtimeLogKey = 'local:agent-delivery-runtime-logs'
const maxRuntimeLogs = 200
const maxDiagnosticTextLength = 320
const writeQueues = new Map<string, Promise<void>>()

export interface BackgroundRuntimeLogRecord {
  title: string
  state: 'info' | 'success' | 'warning' | 'danger'
  state_name: string
  message: string
  data?: {
    trace: Array<{
      at: number
      stage: string
      status: 'info' | 'success' | 'warning' | 'danger'
      message: string
      detail?: unknown
    }>
  }
  createdAt: number
}

export function createRuntimeLogStorageKey(uid: string | number): `local:${string}` {
  return createAccountStorageKey(runtimeLogKey, uid) as `local:${string}`
}

function sanitizeDiagnosticText(value: unknown) {
  const messages: string[] = []
  let current = value
  const seen = new Set<unknown>()
  for (let depth = 0; depth < 4 && current != null && !seen.has(current); depth += 1) {
    seen.add(current)
    if (current instanceof Error) messages.push(current.name, current.message)
    if (typeof current !== 'object') {
      if (typeof current === 'string') messages.push(current)
      break
    }
    current = (current as { cause?: unknown }).cause
  }
  const text = messages.join(' ')
  return text
    .replace(/\bBearer\s+\S+/gi, 'Bearer [已脱敏]')
    .replace(/\b(?:sk|key)-[A-Za-z0-9._-]{8,}\b/g, '[已脱敏]')
    .replace(/https?:\/\/\S+/gi, '[请求地址已脱敏]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxDiagnosticTextLength)
}

function enqueueWrite(key: string, operation: () => Promise<void>) {
  const queued = (writeQueues.get(key) ?? Promise.resolve()).then(operation)
  writeQueues.set(
    key,
    queued.then(
      () => undefined,
      () => undefined,
    ),
  )
  return queued
}

export async function appendAccountRuntimeLog(
  uid: string | number,
  record: Omit<BackgroundRuntimeLogRecord, 'createdAt'> & { createdAt?: number },
) {
  const normalizedUid = normalizeAccountUid(uid)
  const key = createRuntimeLogStorageKey(normalizedUid)
  const createdAt = record.createdAt ?? Date.now()
  const safeRecord: BackgroundRuntimeLogRecord = {
    ...record,
    createdAt,
  }
  await enqueueWrite(key, async () => {
    const saved = await storage.getItem<BackgroundRuntimeLogRecord[]>(key, { fallback: [] })
    const records = Array.isArray(saved) ? saved : []
    const next = [safeRecord, ...records]
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, maxRuntimeLogs)
    await storage.setItem(key, next)
  })
}

function taskTitle(task: AiRuntimeDiagnosticEvent['task']) {
  if (task === 'resumeExtraction') return '简历解析'
  if (task === 'aiFiltering') return 'AI 匹配请求'
  if (task === 'aiGreeting') return 'AI 招呼语请求'
  return '模型连接测试'
}

function requestModeLabel(mode: AiRuntimeDiagnosticEvent['requestMode']) {
  if (mode === 'background') return '后台任务'
  if (mode === 'stream') return '流式'
  return '同步'
}

function failureMessage(event: AiRuntimeDiagnosticEvent) {
  const status = [...event.diagnostics.attempts]
    .reverse()
    .find((attempt) => typeof attempt.status === 'number' && attempt.status >= 400)?.status
  if (status === 401 || status === 403) return '模型鉴权失败'
  if (status === 429) return '模型服务限流'
  if (status != null) return `模型请求失败（HTTP ${status}）`
  const detail = sanitizeDiagnosticText(event.error)
  if (/timeout|abort|超时/i.test(detail)) return '模型请求超时'
  if (/Content-Type|JSON|格式|响应体|流式响应|response id/i.test(detail)) {
    return '模型返回格式无效'
  }
  return detail || '模型请求失败'
}

function eventMessage(event: AiRuntimeDiagnosticEvent) {
  if (event.phase === 'started') return `模型请求已发出（${requestModeLabel(event.requestMode)}）`
  if (event.phase === 'progress') {
    if (event.providerStatus === 'fallback_stream') {
      return '兼容接口不支持后台模式，已切换流式请求'
    }
    const status =
      event.providerStatus === 'queued'
        ? '排队中'
        : event.providerStatus === 'in_progress'
          ? '处理中'
          : event.providerStatus || '处理中'
    return `模型任务${status}`
  }
  if (event.phase === 'succeeded') return '模型请求完成'
  return failureMessage(event)
}

function eventState(event: AiRuntimeDiagnosticEvent) {
  if (event.phase === 'succeeded') {
    return { state: 'success' as const, stateName: '请求成功' }
  }
  if (event.phase === 'failed') {
    return { state: 'danger' as const, stateName: '请求失败' }
  }
  return {
    state: 'info' as const,
    stateName: event.phase === 'progress' ? '处理中' : '请求中',
  }
}

function eventDetail(event: AiRuntimeDiagnosticEvent) {
  const background = event.diagnostics.background
  return {
    task: event.task ?? 'modelTest',
    protocol: event.protocol,
    model: event.model.slice(0, 160),
    reasoningEffort: event.reasoningEffort || '未设置',
    // 配了但当前协议发不出去的设置。空数组时不写，避免给正常日志加噪音。
    unsupportedSettings: event.unsupportedSettings?.length ? event.unsupportedSettings : undefined,
    requestMode: event.requestMode,
    timeoutSeconds: event.diagnostics.timeoutSeconds,
    durationMs: event.durationMs,
    // 光有耗时没法判断慢在哪：输出 token 数才能说明是模型慢还是我们要的输出太多。
    inputTokens: event.usage?.input_tokens,
    outputTokens: event.usage?.output_tokens,
    // 推理 token 含在 outputTokens 里。两者的差值才是真正复述出来的内容。
    reasoningTokens: event.usage?.reasoning_tokens,
    // 缓存命中数。服务商不返回时为 undefined——那本身也是信息：说明这条链路上无从判断。
    cachedTokens: event.usage?.cached_tokens,
    promptChars: event.diagnostics.promptChars,
    requestBodyChars: event.diagnostics.requestBodyChars,
    attempts: event.diagnostics.attempts.map((attempt) => ({
      attempt: attempt.attempt,
      ok: attempt.ok,
      status: attempt.status,
      durationMs: attempt.durationMs,
      error: sanitizeDiagnosticText(attempt.error),
    })),
    background: background
      ? {
          status: background.status,
          pollCount: background.pollCount,
          durationMs: background.durationMs,
        }
      : undefined,
    providerStatus: event.providerStatus,
    error: event.phase === 'failed' ? sanitizeDiagnosticText(event.error) : undefined,
  }
}

export function createAccountAiRuntimeLogger(uid: string | number) {
  const normalizedUid = normalizeAccountUid(uid)
  return async (event: AiRuntimeDiagnosticEvent) => {
    const { state, stateName } = eventState(event)
    const message = eventMessage(event)
    const detail = eventDetail(event)
    await appendAccountRuntimeLog(normalizedUid, {
      title: taskTitle(event.task),
      state,
      state_name: stateName,
      message,
      data: {
        trace: [
          {
            at: event.at,
            stage: taskTitle(event.task),
            status: state,
            message,
            detail,
          },
        ],
      },
    })
  }
}
