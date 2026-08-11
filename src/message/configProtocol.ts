import type {
  ConfigImportResult,
  PublicRuntimeConfig,
  ResumeDraftResult,
  ResumeSaveResult,
} from '@/background/configService'
import type { AiModelConfig, ConfigBundleV1 } from '@/config/types'
import {
  ConfigImportRunningError,
  ConfigMutationRunningError,
  ConfigValidationError,
} from '@/config/types'

export const CONFIG_REQUEST_TYPE = 'AGENT_DELIVERY_CONFIG_REQUEST' as const
export const CONFIG_RESPONSE_TYPE = 'AGENT_DELIVERY_CONFIG_RESPONSE' as const
export const CONFIG_REVISION_CHANGED_TYPE = 'AGENT_DELIVERY_CONFIG_REVISION_CHANGED' as const

export type ConfigRequest =
  | {
      type: typeof CONFIG_REQUEST_TYPE
      requestId: string
      action: 'get'
      uid: string
    }
  | {
      type: typeof CONFIG_REQUEST_TYPE
      requestId: string
      action: 'replace'
      uid: string
      bundle: ConfigBundleV1
    }
  | {
      type: typeof CONFIG_REQUEST_TYPE
      requestId: string
      action: 'save-ai-config'
      models: AiModelConfig[]
    }
  | {
      type: typeof CONFIG_REQUEST_TYPE
      requestId: string
      action: 'import-json'
      uid: string
      text: string
      sizeBytes: number
    }
  | {
      type: typeof CONFIG_REQUEST_TYPE
      requestId: string
      action: 'reset-all'
      uid: string
    }
  | {
      type: typeof CONFIG_REQUEST_TYPE
      requestId: string
      action: 'test-model'
      uid: string
      model: AiModelConfig
    }
  | {
      type: typeof CONFIG_REQUEST_TYPE
      requestId: string
      action: 'save-profile-draft'
      uid: string
      displayName: string
      markdown: string
    }
  | {
      type: typeof CONFIG_REQUEST_TYPE
      requestId: string
      action: 'commit-profile-evidence'
      uid: string
      markdown: string
      evidence: unknown
    }

export type ConfigResponseData =
  | ConfigBundleV1
  | ConfigImportResult
  | ResumeDraftResult
  | ResumeSaveResult
  | PublicRuntimeConfig['readiness']
  | { ok: true; durationMs: number; model: string; protocol: AiModelConfig['protocol'] }

export type ConfigResponse =
  | {
      type: typeof CONFIG_RESPONSE_TYPE
      requestId: string
      ok: true
      data: ConfigResponseData
    }
  | {
      type: typeof CONFIG_RESPONSE_TYPE
      requestId: string
      ok: false
      errorCode:
        | 'CONFIG_VALIDATION_FAILED'
        | 'CONFIG_FORBIDDEN'
        | 'CONFIG_IMPORT_BLOCKED'
        | 'CONFIG_MUTATION_BLOCKED'
        | 'CONFIG_OPERATION_FAILED'
        | 'MODEL_AUTH_FAILED'
        | 'MODEL_RATE_LIMITED'
        | 'MODEL_HTTP_FAILED'
        | 'MODEL_TIMEOUT'
        | 'MODEL_NETWORK_OR_PERMISSION'
        | 'MODEL_TASK_FAILED'
        | 'MODEL_RESPONSE_INVALID'
      error: string
      issues?: Array<{ path: string; message: string }>
    }

export interface ConfigRevisionChangedMessage {
  type: typeof CONFIG_REVISION_CHANGED_TYPE
  configRevision: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value)
}

export function isConfigRequest(value: unknown): value is ConfigRequest {
  if (!isRecord(value) || value.type !== CONFIG_REQUEST_TYPE) return false
  if (typeof value.requestId !== 'string' || value.requestId.length === 0) return false
  if (value.action === 'test-model') {
    return typeof value.uid === 'string' && value.uid.length > 0 && isRecord(value.model)
  }
  if (value.action === 'save-ai-config') {
    return Array.isArray(value.models) && !('tasks' in value)
  }
  if (value.action === 'save-profile-draft') {
    return (
      typeof value.uid === 'string' &&
      value.uid.length > 0 &&
      typeof value.displayName === 'string' &&
      typeof value.markdown === 'string'
    )
  }
  if (value.action === 'commit-profile-evidence') {
    return (
      typeof value.uid === 'string' &&
      value.uid.length > 0 &&
      typeof value.markdown === 'string' &&
      isRecord(value.evidence)
    )
  }
  if (typeof value.uid !== 'string' || value.uid.length === 0) return false
  if (value.action === 'get' || value.action === 'reset-all') return true
  if (value.action === 'replace') return isRecord(value.bundle)
  return (
    value.action === 'import-json' &&
    typeof value.text === 'string' &&
    typeof value.sizeBytes === 'number' &&
    Number.isFinite(value.sizeBytes)
  )
}

export function isConfigResponse(value: unknown): value is ConfigResponse {
  return (
    isRecord(value) &&
    value.type === CONFIG_RESPONSE_TYPE &&
    typeof value.requestId === 'string' &&
    typeof value.ok === 'boolean'
  )
}

export function isConfigRevisionChangedMessage(
  value: unknown,
): value is ConfigRevisionChangedMessage {
  return (
    isRecord(value) &&
    value.type === CONFIG_REVISION_CHANGED_TYPE &&
    typeof value.configRevision === 'number' &&
    Number.isInteger(value.configRevision) &&
    value.configRevision >= 0
  )
}

export function createConfigSuccess(requestId: string, data: ConfigResponseData): ConfigResponse {
  return { type: CONFIG_RESPONSE_TYPE, requestId, ok: true, data }
}

export function createConfigFailure(requestId: string, error: unknown): ConfigResponse {
  if (error instanceof ConfigValidationError) {
    return {
      type: CONFIG_RESPONSE_TYPE,
      requestId,
      ok: false,
      errorCode: 'CONFIG_VALIDATION_FAILED',
      error: error.message,
      issues: error.issues.map(({ path, message }) => ({ path, message })),
    }
  }
  if (error instanceof ConfigImportRunningError) {
    return {
      type: CONFIG_RESPONSE_TYPE,
      requestId,
      ok: false,
      errorCode: 'CONFIG_IMPORT_BLOCKED',
      error: error.message,
    }
  }
  if (error instanceof ConfigMutationRunningError) {
    return {
      type: CONFIG_RESPONSE_TYPE,
      requestId,
      ok: false,
      errorCode: 'CONFIG_MUTATION_BLOCKED',
      error: error.message,
    }
  }
  const modelFailure = classifyModelFailure(error)
  if (modelFailure) {
    return {
      type: CONFIG_RESPONSE_TYPE,
      requestId,
      ok: false,
      ...modelFailure,
    }
  }
  return {
    type: CONFIG_RESPONSE_TYPE,
    requestId,
    ok: false,
    errorCode: 'CONFIG_OPERATION_FAILED',
    error: '配置操作失败',
  }
}

function classifyModelFailure(
  error: unknown,
): Pick<Extract<ConfigResponse, { ok: false }>, 'errorCode' | 'error'> | null {
  const record = isRecord(error) ? error : {}
  const diagnostics = isRecord(record.diagnostics) ? record.diagnostics : {}
  const attempts = Array.isArray(diagnostics.attempts) ? diagnostics.attempts : []
  const status = [...attempts]
    .reverse()
    .map((attempt) => (isRecord(attempt) ? attempt.status : undefined))
    .find(
      (value): value is number =>
        typeof value === 'number' && Number.isInteger(value) && value >= 400,
    )
  if (status === 401 || status === 403) {
    return { errorCode: 'MODEL_AUTH_FAILED', error: '模型鉴权失败，请检查 API Key' }
  }
  if (status === 429) {
    return { errorCode: 'MODEL_RATE_LIMITED', error: '模型服务限流，请稍后重试' }
  }
  if (status != null) {
    return { errorCode: 'MODEL_HTTP_FAILED', error: `模型服务返回 HTTP ${status}` }
  }

  const messages = collectErrorMessages(error).join(' ')
  if (/超时|timeout|abort/i.test(messages)) {
    return { errorCode: 'MODEL_TIMEOUT', error: '模型请求超时' }
  }
  if (/AI流式响应返回失败事件/i.test(messages)) {
    const providerCode = messages.match(/失败事件：([A-Za-z0-9_.-]{1,80})\b/)?.[1]
    return {
      errorCode: 'MODEL_TASK_FAILED',
      error: providerCode ? `模型任务执行失败（${providerCode}）` : '模型任务执行失败',
    }
  }
  if (/Content-Type|合法 JSON|结构化 JSON|响应体过大|返回格式|响应结构|流式响应/i.test(messages)) {
    return { errorCode: 'MODEL_RESPONSE_INVALID', error: '模型服务返回结构无效' }
  }
  if (/AI请求网络失败|Failed to fetch|fetch failed|network|CORS|permission/i.test(messages)) {
    return {
      errorCode: 'MODEL_NETWORK_OR_PERMISSION',
      error: '模型网络请求失败，请检查地址、网络和浏览器站点权限',
    }
  }
  return null
}

function collectErrorMessages(error: unknown) {
  const messages: string[] = []
  let current = error
  const seen = new Set<unknown>()
  for (let depth = 0; depth < 4 && current != null && !seen.has(current); depth += 1) {
    seen.add(current)
    if (current instanceof Error) messages.push(current.name, current.message)
    if (!isRecord(current)) break
    current = current.cause
  }
  return messages
}

export function createConfigForbidden(requestId: string): ConfigResponse {
  return {
    type: CONFIG_RESPONSE_TYPE,
    requestId,
    ok: false,
    errorCode: 'CONFIG_FORBIDDEN',
    error: '当前上下文无权访问完整配置',
  }
}
