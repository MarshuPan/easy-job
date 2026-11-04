import type { FormData } from '@/types/formData'
import { jsonClone } from '@/utils/deepmerge'

export const DELIVERY_CONFIG_SNAPSHOT_SCHEMA_VERSION = 1

export interface DeliveryConfigSnapshot {
  schemaVersion: typeof DELIVERY_CONFIG_SNAPSHOT_SCHEMA_VERSION
  configRevision: number
  configFingerprint: string
  formData: FormData
  sources: {
    groupEnabled: boolean
    enabledGroupTargetIds: string[]
    searchEnabled: boolean
    searchDirectionKeys: string[]
  }
  weights: {
    group: number
    search: number
  }
  pipeline: {
    aiFiltering: boolean
    aiGreeting: boolean
    customGreeting: boolean
  }
}

export interface DeliveryQueueConfigScope {
  fingerprint: string
  groupEnabled: boolean
  enabledGroupTargetIds: string[]
  searchEnabled: boolean
  searchDirectionKeys: string[]
}

export function normalizeDeliverySourceKey(value: string) {
  return value.replace(/\s+/g, '').trim().toLocaleLowerCase()
}

export function buildDeliveryQueueConfigScope(
  formData: Partial<Pick<FormData, 'jobSources' | 'searchConditions'>>,
): DeliveryQueueConfigScope {
  const jobSources = formData.jobSources
  const searchDirections = formData.searchConditions?.directions ?? []
  const enabledGroupTargetIds = [
    ...(jobSources?.recommendEnabled ? ['recommend'] : []),
    ...(jobSources?.enabledExpectIds ?? []),
  ]
    .map((item) => String(item).trim())
    .filter(Boolean)
  const searchDirectionKeys = searchDirections.map(normalizeDeliverySourceKey).filter(Boolean)
  const config = {
    groupEnabled: enabledGroupTargetIds.length > 0,
    enabledGroupTargetIds: [...new Set(enabledGroupTargetIds)].sort(),
    searchEnabled: Boolean(jobSources?.searchEnabled && searchDirectionKeys.length > 0),
    searchDirectionKeys: [...new Set(searchDirectionKeys)].sort(),
  }

  return {
    ...config,
    fingerprint: hashDeliveryConfig(JSON.stringify(config)),
  }
}

export function buildDeliveryConfigSnapshot(
  formData: Partial<FormData>,
  configRevision = 0,
): DeliveryConfigSnapshot {
  // Pinia exposes the active form as a Vue Proxy, which structuredClone cannot
  // clone. Delivery configuration is JSON-backed, so serialize it into plain
  // data before the snapshot crosses the extension message boundary.
  const runtimeFormData = jsonClone(formData) as FormData
  runtimeFormData.customGreeting ??= { enable: false, value: '' }
  // Older configurations do not have the public source selector yet. Keep
  // their historical behavior (both sources available) in the durable task
  // instead of registering a snapshot that cannot be parsed on resume.
  runtimeFormData.jobSources ??= {
    searchEnabled: true,
    recommendEnabled: true,
    enabledExpectIds: [],
    expectationsInitialized: false,
  }
  const queueScope = buildDeliveryQueueConfigScope(runtimeFormData)
  if (runtimeFormData.aiFiltering) runtimeFormData.aiFiltering.prompt = ''
  if (runtimeFormData.aiGreeting) runtimeFormData.aiGreeting.prompt = ''
  if (runtimeFormData.amap) {
    runtimeFormData.amap.key = ''
    runtimeFormData.amap.origins = ''
  }
  return {
    schemaVersion: DELIVERY_CONFIG_SNAPSHOT_SCHEMA_VERSION,
    configRevision: Math.max(0, Math.trunc(configRevision)),
    configFingerprint: queueScope.fingerprint,
    formData: runtimeFormData,
    sources: {
      groupEnabled: queueScope.groupEnabled,
      enabledGroupTargetIds: queueScope.enabledGroupTargetIds,
      searchEnabled: queueScope.searchEnabled,
      searchDirectionKeys: queueScope.searchDirectionKeys,
    },
    weights: {
      group: Math.max(0, Number(formData.deliveryLimit?.group) || 0),
      search: Math.max(0, Number(formData.deliveryLimit?.search) || 0),
    },
    pipeline: {
      aiFiltering: Boolean(formData.aiFiltering?.enable),
      aiGreeting: Boolean(formData.aiGreeting?.enable),
      customGreeting: Boolean(runtimeFormData.customGreeting.enable),
    },
  }
}

export function parseDeliveryConfigSnapshot(value: unknown): DeliveryConfigSnapshot | null {
  if (!isRecord(value)) return null
  if (value.schemaVersion !== DELIVERY_CONFIG_SNAPSHOT_SCHEMA_VERSION) return null
  if (!Number.isInteger(value.configRevision) || Number(value.configRevision) < 0) return null
  if (typeof value.configFingerprint !== 'string' || value.configFingerprint.length === 0) {
    return null
  }
  if (
    !isRecord(value.formData) ||
    !isRecord(value.sources) ||
    !isRecord(value.weights) ||
    !isRecord(value.pipeline)
  ) {
    return null
  }
  if (
    typeof value.sources.groupEnabled !== 'boolean' ||
    !isStringArray(value.sources.enabledGroupTargetIds) ||
    typeof value.sources.searchEnabled !== 'boolean' ||
    !isStringArray(value.sources.searchDirectionKeys) ||
    !isFiniteNonNegative(value.weights.group) ||
    !isFiniteNonNegative(value.weights.search) ||
    typeof value.pipeline.aiFiltering !== 'boolean' ||
    typeof value.pipeline.aiGreeting !== 'boolean'
  ) {
    return null
  }
  const hasCustomGreeting = Object.hasOwn(value.pipeline, 'customGreeting')
  if (hasCustomGreeting && typeof value.pipeline.customGreeting !== 'boolean') return null

  const snapshot = structuredClone(value)
  const formData = snapshot.formData as Record<string, unknown>
  const pipeline = snapshot.pipeline as Record<string, unknown>
  // Older tasks stored an unused account-level field with the same name.
  // Only snapshots with the new pipeline marker may execute fixed text.
  if (!hasCustomGreeting) {
    formData.customGreeting = {
      enable: false,
      value:
        isRecord(formData.customGreeting) && typeof formData.customGreeting.value === 'string'
          ? formData.customGreeting.value
          : '',
    }
    pipeline.customGreeting = false
  }
  if (!isRuntimeFormData(formData) || pipeline.customGreeting !== formData.customGreeting.enable) {
    return null
  }
  // 运行期间必须使用同一份配置版本（当前产品契约 §3）。冻结让「就地改写快照」
  // 变成一个立即失败的错误，而不是一处静默的配置漂移。
  return deepFreeze(snapshot as unknown as DeliveryConfigSnapshot)
}

function deepFreeze<T>(value: T): T {
  if (value == null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  Object.values(value as Record<string, unknown>).forEach(deepFreeze)
  return value
}

function isRuntimeFormData(value: unknown): value is FormData {
  if (!isRecord(value)) return false
  return (
    isRecord(value.jobSources) &&
    isRecord(value.searchConditions) &&
    isRecord(value.deliveryLimit) &&
    isRecord(value.aiFiltering) &&
    isRecord(value.aiGreeting) &&
    isRecord(value.customGreeting) &&
    typeof value.customGreeting.enable === 'boolean' &&
    typeof value.customGreeting.value === 'string' &&
    !(value.customGreeting.enable && value.aiGreeting.enable) &&
    isRecord(value.delay)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isFiniteNonNegative(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function hashDeliveryConfig(value: string) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `cfg-${(hash >>> 0).toString(16).padStart(8, '0')}`
}
