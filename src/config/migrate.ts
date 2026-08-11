import { defaultFormData } from '@/stores/conf/info'
import type { FormData, FormDataRange } from '@/types/formData'
import { isPlainObject, jsonClone } from '@/utils/deepmerge'
import { normalizeSearchConditions } from '@/utils/searchConditions'

import {
  createDefaultAiTasks,
  createDefaultDeliverySettings,
  createDefaultProfile,
} from './defaults'
import { greetingTargetFromTask } from './greetingLength'
import type {
  AiModelConfig,
  AiTaskConfig,
  AppearanceConfig,
  DeliverySettingsConfig,
  JobExpectationConfig,
  PersonalProfileConfig,
  RangeTuple,
} from './types'

type LegacyRecord = Record<string, unknown>

/** 旧版页面模型配置的形状，仅用于迁移历史数据。 */
interface LegacyModelRecord {
  key?: string
  name?: string
  color?: string
  data?: Record<string, unknown>
}

export interface LegacyConfigMigrationOptions {
  legacySearchUrl?: string
  legacyJobTitles?: readonly string[]
  expectations?: readonly JobExpectationConfig[]
  appearance?: Partial<AppearanceConfig>
}

function asRecord(value: unknown): LegacyRecord {
  return isPlainObject(value) ? value : {}
}

function asBoolean(value: unknown, fallback: boolean) {
  return typeof value === 'boolean' ? value : fallback
}

function asFiniteNumber(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asString(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function asStringArray(value: unknown, fallback: readonly string[] = []) {
  if (!Array.isArray(value)) return [...fallback]
  return [
    ...new Set(
      value
        .filter((item): item is string | number => {
          return typeof item === 'string' || typeof item === 'number'
        })
        .map(String)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ]
}

function asRange(value: unknown, fallback: FormDataRange | RangeTuple): RangeTuple {
  if (!Array.isArray(value) || value.length < 3) return [...fallback]
  const min = asFiniteNumber(value[0], fallback[0])
  const max = asFiniteNumber(value[1], fallback[1])
  const strict = asBoolean(value[2], fallback[2])
  return [min, max, strict]
}

function migrateKeywordRule(
  value: unknown,
  fallback: FormData['jobContent'],
): DeliverySettingsConfig['filters']['jobContent'] {
  const source = asRecord(value)
  return {
    enabled: asBoolean(source.enable, fallback.enable),
    mode: asBoolean(source.include, fallback.include) ? 'include' : 'exclude',
    values: asStringArray(source.value, fallback.value),
    options: asStringArray(source.options, fallback.options),
  }
}

function normalizeSourceWeights(value: unknown) {
  const source = asRecord(value)
  const fallback = defaultFormData.deliveryLimit
  const rawSearch = Math.max(0, asFiniteNumber(source.search, fallback.search))
  const rawExpectations = Math.max(0, asFiniteNumber(source.group, fallback.group))
  const total = rawSearch + rawExpectations
  if (total <= 0) {
    return { search: fallback.search, expectations: fallback.group }
  }
  const search = Math.round((rawSearch / total) * 100)
  return { search, expectations: 100 - search }
}

function migrateEnabledExpectations(
  ids: readonly string[],
  expectations: readonly JobExpectationConfig[] = [],
) {
  const expectationById = new Map(expectations.map((item) => [String(item.id), item]))
  return ids.map((id) => {
    const existing = expectationById.get(id)
    return existing
      ? jsonClone(existing)
      : { id, positionName: '', locationName: '', salaryDesc: '' }
  })
}

export function migrateLegacyFormDataToSettings(
  value: unknown,
  options: LegacyConfigMigrationOptions = {},
): DeliverySettingsConfig {
  const source = asRecord(value)
  const defaults = createDefaultDeliverySettings()
  const jobSources = asRecord(source.jobSources)
  const companySizeRange = asRecord(source.companySizeRange)
  const customGreeting = asRecord(source.customGreeting)
  const delay = asRecord(source.delay)
  const amap = asRecord(source.amap)
  const enabledExpectationIds = asStringArray(jobSources.enabledExpectIds)
  const legacyJobTitles = options.legacyJobTitles ?? asStringArray(asRecord(source.jobTitle).value)
  const hasLegacySearch =
    typeof options.legacySearchUrl === 'string' && options.legacySearchUrl.trim().length > 0
  const hasStructuredSearch = isPlainObject(source.searchConditions)
  const search =
    hasStructuredSearch || hasLegacySearch || legacyJobTitles.length > 0
      ? normalizeSearchConditions(source.searchConditions, {
          legacySearchUrl: options.legacySearchUrl,
          legacyJobTitles,
        })
      : {
          directions: [...defaults.jobRules.search.directions],
          city: defaults.jobRules.search.city,
          businessDistricts: [],
          salary: defaults.jobRules.search.salary,
          experience: [...defaults.jobRules.search.experience],
          degree: [...defaults.jobRules.search.degree],
          jobType: [...defaults.jobRules.search.jobType],
        }

  return {
    jobRules: {
      sources: {
        searchEnabled: asBoolean(jobSources.searchEnabled, defaults.jobRules.sources.searchEnabled),
        recommendEnabled: asBoolean(
          jobSources.recommendEnabled,
          defaults.jobRules.sources.recommendEnabled,
        ),
        expectationsInitialized: asBoolean(
          jobSources.expectationsInitialized,
          enabledExpectationIds.length > 0,
        ),
        enabledExpectations: migrateEnabledExpectations(
          enabledExpectationIds,
          options.expectations,
        ),
      },
      sourceWeights: normalizeSourceWeights(source.deliveryLimit),
      search: {
        directions: search.directions,
        city: search.city,
        salary: search.salary,
        experience: search.experience,
        degree: search.degree,
        jobType: search.jobType,
      },
    },
    filters: {
      jobContent: migrateKeywordRule(source.jobContent, defaultFormData.jobContent),
      companySizeRange: {
        enabled: asBoolean(companySizeRange.enable, defaultFormData.companySizeRange.enable),
        range: asRange(companySizeRange.value, defaultFormData.companySizeRange.value),
      },
      activity: asBoolean(asRecord(source.activityFilter).value, defaults.filters.activity),
      friendStatus: asBoolean(asRecord(source.friendStatus).value, defaults.filters.friendStatus),
      sameCompany: asBoolean(
        asRecord(source.sameCompanyFilter).value,
        defaults.filters.sameCompany,
      ),
      sameHr: asBoolean(asRecord(source.sameHrFilter).value, defaults.filters.sameHr),
      goldHunter: asBoolean(asRecord(source.goldHunterFilter).value, defaults.filters.goldHunter),
    },
    delivery: {
      customGreeting: {
        enabled: asBoolean(customGreeting.enable, defaults.delivery.customGreeting.enabled),
        value: asString(customGreeting.value, defaults.delivery.customGreeting.value),
      },
      useCache: asBoolean(asRecord(source.useCache).value, defaults.delivery.useCache),
      timing: {
        // 初始等待与翻页等待已固化为运行时常量，运行配置里不再有对应字段；
        // 导出格式保留这两个键以便旧配置仍可导入，值取默认即可。
        initialDelaySeconds: defaults.delivery.timing.initialDelaySeconds,
        minJobIntervalSeconds: asFiniteNumber(
          delay.deliveryInterval,
          defaults.delivery.timing.minJobIntervalSeconds,
        ),
        maxJobIntervalSeconds: asFiniteNumber(
          delay.deliveryIntervalMax,
          defaults.delivery.timing.maxJobIntervalSeconds,
        ),
        nextPageDelaySeconds: defaults.delivery.timing.nextPageDelaySeconds,
        messageSendDelaySeconds: asFiniteNumber(
          delay.messageSending,
          defaults.delivery.timing.messageSendDelaySeconds,
        ),
        greetingSegmentSeconds: asFiniteNumber(
          delay.greetingSegment,
          defaults.delivery.timing.greetingSegmentSeconds,
        ),
        batchSize: asFiniteNumber(delay.batchSize, defaults.delivery.timing.batchSize),
        batchRestMinutes: asFiniteNumber(
          delay.batchRestMinutes,
          defaults.delivery.timing.batchRestMinutes,
        ),
      },
    },
    commute: {
      enabled: asBoolean(amap.enable, defaults.commute.enabled),
      apiKey: asString(amap.key, defaults.commute.apiKey),
      origin: asString(amap.origins, defaults.commute.origin),
      straightDistanceKm: asFiniteNumber(
        amap.straightDistance,
        defaults.commute.straightDistanceKm,
      ),
      drivingDistanceKm: asFiniteNumber(amap.drivingDistance, defaults.commute.drivingDistanceKm),
      drivingDurationMinutes: asFiniteNumber(
        amap.drivingDuration,
        defaults.commute.drivingDurationMinutes,
      ),
      walkingDistanceKm: asFiniteNumber(amap.walkingDistance, defaults.commute.walkingDistanceKm),
      walkingDurationMinutes: asFiniteNumber(
        amap.walkingDuration,
        defaults.commute.walkingDurationMinutes,
      ),
    },
    appearance: {
      hideHeader: asBoolean(options.appearance?.hideHeader, defaults.appearance.hideHeader),
      listSink: asBoolean(options.appearance?.listSink, defaults.appearance.listSink),
    },
  }
}

export function migrateLegacyAiTasks(value: unknown): AiTaskConfig {
  const source = asRecord(value)
  const defaults = createDefaultAiTasks()
  const filtering = asRecord(source.aiFiltering)
  const greeting = asRecord(source.aiGreeting)
  return {
    resumeExtraction: { modelId: null },
    aiFiltering: {
      ...defaults.aiFiltering,
      enabled: asBoolean(filtering.enable, defaults.aiFiltering.enabled),
      modelId: typeof filtering.model === 'string' && filtering.model ? filtering.model : null,
      score: asFiniteNumber(filtering.score, defaults.aiFiltering.score),
      prompt:
        typeof filtering.prompt === 'string' && filtering.prompt.trim()
          ? filtering.prompt
          : defaults.aiFiltering.prompt,
    },
    aiGreeting: {
      ...defaults.aiGreeting,
      enabled: asBoolean(greeting.enable, defaults.aiGreeting.enabled),
      modelId: typeof greeting.model === 'string' && greeting.model ? greeting.model : null,
      prompt:
        typeof greeting.prompt === 'string' && greeting.prompt.trim()
          ? greeting.prompt
          : defaults.aiGreeting.prompt,
    },
  }
}

function protocolFromLegacyUrl(url: string): AiModelConfig['protocol'] {
  return /\/responses\/?(?:\?.*)?$/.test(url) ? 'openai-responses' : 'openai-chat-completions'
}

export function migrateLegacyModels(value: unknown): AiModelConfig[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item, index) => {
    const source = asRecord(item) as unknown as LegacyModelRecord
    const data = asRecord(source.data)
    const advanced = asRecord(data.advanced)
    const other = asRecord(data.other)
    const id = asString(source.key).trim() || `model-${index + 1}`
    const url = asString(data.url).trim()
    const model = asString(data.model).trim()
    if (!url || !model) return []
    const protocol = protocolFromLegacyUrl(url)
    return [
      {
        id,
        name: asString(source.name).trim() || id,
        ...(typeof source.color === 'string' ? { color: source.color } : {}),
        protocol,
        url,
        apiKey: asString(data.api_key),
        model,
        reasoningEffort: asString(advanced.reasoning_effort),
        timeoutSeconds: asFiniteNumber(other.timeout, 180),
        responsesBackground:
          protocol === 'openai-responses'
            ? asBoolean(other.background, false)
              ? 'on'
              : 'off'
            : 'off',
        generation: {
          temperature: typeof advanced.temperature === 'number' ? advanced.temperature : null,
          topP: typeof advanced.top_p === 'number' ? advanced.top_p : null,
          presencePenalty:
            typeof advanced.presence_penalty === 'number' ? advanced.presence_penalty : null,
          frequencyPenalty:
            typeof advanced.frequency_penalty === 'number' ? advanced.frequency_penalty : null,
        },
      },
    ] satisfies AiModelConfig[]
  })
}

export function settingsToLegacyFormData(
  settings: DeliverySettingsConfig,
  tasks: AiTaskConfig,
  userId?: string | number,
): FormData {
  const result = jsonClone(defaultFormData)
  const filters = settings.filters
  result.jobContent = {
    enable: filters.jobContent.enabled,
    include: filters.jobContent.mode === 'include',
    value: [...filters.jobContent.values],
    options: [...filters.jobContent.options],
  }
  result.companySizeRange = {
    enable: filters.companySizeRange.enabled,
    value: [...filters.companySizeRange.range],
  }
  result.activityFilter.value = filters.activity
  result.friendStatus.value = filters.friendStatus
  result.sameCompanyFilter.value = filters.sameCompany
  result.sameHrFilter.value = filters.sameHr
  result.goldHunterFilter.value = filters.goldHunter
  result.customGreeting = {
    enable: settings.delivery.customGreeting.enabled,
    value: settings.delivery.customGreeting.value,
  }
  result.useCache.value = settings.delivery.useCache
  result.deliveryLimit = {
    search: settings.jobRules.sourceWeights.search,
    group: settings.jobRules.sourceWeights.expectations,
  }
  result.jobSources = {
    searchEnabled: settings.jobRules.sources.searchEnabled,
    recommendEnabled: settings.jobRules.sources.recommendEnabled,
    expectationsInitialized: settings.jobRules.sources.expectationsInitialized,
    enabledExpectIds: settings.jobRules.sources.enabledExpectations.map((item) => item.id),
  }
  result.searchConditions = {
    ...jsonClone(settings.jobRules.search),
    businessDistricts: [],
  }
  result.aiFiltering = {
    ...result.aiFiltering,
    enable: tasks.aiFiltering.enabled,
    score: tasks.aiFiltering.score,
    prompt: '',
  }
  result.aiGreeting = {
    ...result.aiGreeting,
    enable: tasks.aiGreeting.enabled,
    messageCount: tasks.aiGreeting.messageCount,
    targetTotalCharacters: greetingTargetFromTask(tasks.aiGreeting),
    prompt: tasks.aiGreeting.prompt,
  }
  result.delay = {
    deliveryInterval: settings.delivery.timing.minJobIntervalSeconds,
    deliveryIntervalMax: settings.delivery.timing.maxJobIntervalSeconds,
    messageSending: settings.delivery.timing.messageSendDelaySeconds,
    greetingSegment: settings.delivery.timing.greetingSegmentSeconds,
    batchSize: settings.delivery.timing.batchSize,
    batchRestMinutes: settings.delivery.timing.batchRestMinutes,
  }
  result.amap = {
    key: settings.commute.apiKey,
    origins: settings.commute.origin,
    straightDistance: settings.commute.straightDistanceKm,
    drivingDistance: settings.commute.drivingDistanceKm,
    drivingDuration: settings.commute.drivingDurationMinutes,
    walkingDistance: settings.commute.walkingDistanceKm,
    walkingDuration: settings.commute.walkingDurationMinutes,
    enable: settings.commute.enabled,
  }
  result.userId = userId
  return result
}

export function sanitizeImportedProfile(profile: PersonalProfileConfig): PersonalProfileConfig {
  if (!profile.resume.markdown) return createDefaultProfile()
  return jsonClone(profile)
}
