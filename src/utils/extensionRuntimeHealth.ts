export const EXTENSION_RUNTIME_PROBE_REQUEST_TYPE = 'agent-delivery:runtime-probe-request'
export const EXTENSION_RUNTIME_PROBE_RESPONSE_TYPE = 'agent-delivery:runtime-probe-response'
export const EXTENSION_BACKGROUND_PROBE_REQUEST_TYPE = 'agent-delivery:background-probe-request'
export const EXTENSION_BACKGROUND_PROBE_RESPONSE_TYPE = 'agent-delivery:background-probe-response'
export const EXTENSION_RUNTIME_PROBE_TIMEOUT_MS = 4000
export const EXTENSION_BACKGROUND_PROBE_TIMEOUT_MS = 3000
export const EXTENSION_RPC_HEARTBEAT_TIMEOUT_MS = 5000
export const EXTENSION_CONTEXT_INVALIDATED_EVENT = 'agent-delivery:extension-context-invalidated'

export type ExtensionRuntimeHealthErrorCode =
  | 'CONTENT_SCRIPT_UNAVAILABLE'
  | 'BACKGROUND_UNAVAILABLE'
  | 'VERSION_MISMATCH'

export interface ExtensionRuntimeProbeRequest {
  type: typeof EXTENSION_RUNTIME_PROBE_REQUEST_TYPE
  requestId: string
  bridgeToken: string
  version: string
}

export interface ExtensionRuntimeProbeResponse {
  type: typeof EXTENSION_RUNTIME_PROBE_RESPONSE_TYPE
  requestId: string
  bridgeToken: string
  ok: boolean
  mainVersion: string
  contentVersion: string
  backgroundVersion?: string
  errorCode?: Exclude<ExtensionRuntimeHealthErrorCode, 'CONTENT_SCRIPT_UNAVAILABLE'>
}

export interface ExtensionBackgroundProbeRequest {
  type: typeof EXTENSION_BACKGROUND_PROBE_REQUEST_TYPE
  requestId: string
}

export interface ExtensionBackgroundProbeResponse {
  type: typeof EXTENSION_BACKGROUND_PROBE_RESPONSE_TYPE
  requestId: string
  ok: true
  version: string
}

export interface ExtensionRuntimeHealth {
  mainVersion: string
  contentVersion: string
  backgroundVersion: string
  durationMs: number
}

export class ExtensionRuntimeHealthError extends Error {
  code: ExtensionRuntimeHealthErrorCode

  constructor(code: ExtensionRuntimeHealthErrorCode) {
    super(getExtensionRuntimeHealthMessage(code))
    this.name = 'ExtensionRuntimeHealthError'
    this.code = code
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export function getCurrentAppVersion() {
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown'
}

export function getExtensionRuntimeHealthMessage(code: ExtensionRuntimeHealthErrorCode) {
  switch (code) {
    case 'CONTENT_SCRIPT_UNAVAILABLE':
      return '插件页面通信已失效，请关闭当前 BOSS 标签页并重新打开后再开始投递'
    case 'BACKGROUND_UNAVAILABLE':
      return '插件后台暂不可用，请重新加载扩展并重新打开 BOSS 页面后再开始投递'
    case 'VERSION_MISMATCH':
      return '插件页面与扩展版本不一致，请重新打开 BOSS 页面后再开始投递'
  }
}

export function getExtensionRuntimeHealthDiagnostic(error: unknown) {
  if (error instanceof ExtensionRuntimeHealthError) {
    return {
      code: error.code,
      error: error.message,
      runtimeHealth: false,
    }
  }
  return {
    code: 'UNKNOWN_RUNTIME_HEALTH_ERROR',
    error: error instanceof Error ? error.message : String(error),
    runtimeHealth: false,
  }
}

export function isExtensionRuntimeProbeRequest(
  value: unknown,
): value is ExtensionRuntimeProbeRequest {
  if (!isRecord(value)) return false
  return (
    value.type === EXTENSION_RUNTIME_PROBE_REQUEST_TYPE &&
    typeof value.requestId === 'string' &&
    value.requestId.length > 0 &&
    typeof value.bridgeToken === 'string' &&
    value.bridgeToken.length > 0 &&
    typeof value.version === 'string' &&
    value.version.length > 0
  )
}

export function isExtensionRuntimeProbeResponse(
  value: unknown,
): value is ExtensionRuntimeProbeResponse {
  if (!isRecord(value)) return false
  const validShape =
    value.type === EXTENSION_RUNTIME_PROBE_RESPONSE_TYPE &&
    typeof value.requestId === 'string' &&
    typeof value.bridgeToken === 'string' &&
    typeof value.ok === 'boolean' &&
    typeof value.mainVersion === 'string' &&
    typeof value.contentVersion === 'string' &&
    (value.backgroundVersion == null || typeof value.backgroundVersion === 'string') &&
    (value.errorCode == null ||
      value.errorCode === 'BACKGROUND_UNAVAILABLE' ||
      value.errorCode === 'VERSION_MISMATCH')
  if (!validShape) return false
  if (value.ok) return typeof value.backgroundVersion === 'string' && value.errorCode == null
  return value.errorCode === 'BACKGROUND_UNAVAILABLE' || value.errorCode === 'VERSION_MISMATCH'
}

export function isExtensionBackgroundProbeRequest(
  value: unknown,
): value is ExtensionBackgroundProbeRequest {
  return (
    isRecord(value) &&
    value.type === EXTENSION_BACKGROUND_PROBE_REQUEST_TYPE &&
    typeof value.requestId === 'string' &&
    value.requestId.length > 0
  )
}

export function isExtensionBackgroundProbeResponse(
  value: unknown,
): value is ExtensionBackgroundProbeResponse {
  return (
    isRecord(value) &&
    value.type === EXTENSION_BACKGROUND_PROBE_RESPONSE_TYPE &&
    typeof value.requestId === 'string' &&
    value.ok === true &&
    typeof value.version === 'string' &&
    value.version.length > 0
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value)
}
