import type { ResumeEvidence } from '@/types/aiGreeting'

/**
 * 导出配置文件的格式标识，导入时严格比对（见 import.ts）。
 *
 * 产品在 1.0 改名为 Easy Job，这个值刻意没跟着改：它写在用户已经导出的配置文件里，
 * 改了那些文件就再也导不回来。存储键里的 agent-delivery-* 同理——改名换不动已经落盘
 * 的数据，换了等于让所有现有安装的配置、投递记录和运行状态一起消失。
 */
export const CONFIG_FORMAT = 'agent-delivery-assistant-config' as const
export const CONFIG_SCHEMA_VERSION = 1 as const
export const CONFIG_SETTINGS_SCOPE = 'active-boss-account' as const
export const CONFIG_STORAGE_KEY = 'local:agent-delivery-config-v1' as const

export type AiProtocol = 'openai-chat-completions' | 'openai-responses' | 'anthropic-messages'

export type ResponsesBackgroundMode = 'auto' | 'on' | 'off'

export interface AiGenerationConfig {
  temperature: number | null
  topP: number | null
  presencePenalty: number | null
  frequencyPenalty: number | null
}

export interface AiModelConfig {
  id: string
  name: string
  color?: string
  protocol: AiProtocol
  url: string
  apiKey: string
  model: string
  reasoningEffort: string
  timeoutSeconds: number
  responsesBackground: ResponsesBackgroundMode
  generation: AiGenerationConfig
}

export interface ResumeConfig {
  markdown: string
  sourceHash: string | null
  evidenceVersion: number
  evidence: ResumeEvidence | null
}

export interface PersonalProfileConfig {
  displayName: string
  resume: ResumeConfig
}

export interface AiTaskConfig {
  resumeExtraction: {
    modelId: string | null
  }
  aiFiltering: {
    enabled: boolean
    modelId: string | null
    score: number
    prompt: string
  }
  aiGreeting: {
    enabled: boolean
    modelId: string | null
    messageCount: number
    minTotalCharacters: number
    maxTotalCharacters: number
    prompt: string
  }
}

export interface JobExpectationConfig {
  id: string
  positionName: string
  locationName: string
  salaryDesc: string
}

export interface SearchConditionsConfig {
  directions: string[]
  city: string
  salary: string
  experience: string[]
  degree: string[]
  jobType: string[]
}

export interface JobRulesConfig {
  sources: {
    searchEnabled: boolean
    recommendEnabled: boolean
    expectationsInitialized: boolean
    enabledExpectations: JobExpectationConfig[]
  }
  sourceWeights: {
    search: number
    expectations: number
  }
  search: SearchConditionsConfig
}

export type KeywordMode = 'include' | 'exclude'

export interface KeywordRuleConfig {
  enabled: boolean
  mode: KeywordMode
  values: string[]
  options: string[]
}

export interface AddressRuleConfig {
  enabled: boolean
  values: string[]
  options: string[]
}

export type RangeTuple = [number, number, boolean]

export interface FiltersConfig {
  jobContent: KeywordRuleConfig
  companySizeRange: {
    enabled: boolean
    range: RangeTuple
  }
  activity: boolean
  friendStatus: boolean
  sameCompany: boolean
  sameHr: boolean
  goldHunter: boolean
}

export interface DeliveryTimingConfig {
  initialDelaySeconds: number
  minJobIntervalSeconds: number
  maxJobIntervalSeconds: number
  nextPageDelaySeconds: number
  messageSendDelaySeconds: number
  greetingSegmentSeconds: number
  batchSize: number
  batchRestMinutes: number
}

export interface DeliveryConfig {
  customGreeting: {
    enabled: boolean
    value: string
  }
  useCache: boolean
  timing: DeliveryTimingConfig
}

export interface CommuteConfig {
  enabled: boolean
  apiKey: string
  origin: string
  straightDistanceKm: number
  drivingDistanceKm: number
  drivingDurationMinutes: number
  walkingDistanceKm: number
  walkingDurationMinutes: number
}

export interface AppearanceConfig {
  hideHeader: boolean
  listSink: boolean
}

export interface DeliverySettingsConfig {
  jobRules: JobRulesConfig
  filters: FiltersConfig
  delivery: DeliveryConfig
  commute: CommuteConfig
  appearance: AppearanceConfig
}

export interface ConfigBundleV1 {
  format: typeof CONFIG_FORMAT
  schemaVersion: typeof CONFIG_SCHEMA_VERSION
  appVersion: string
  exportedAt: string
  containsSecrets: true
  settingsScope: typeof CONFIG_SETTINGS_SCOPE
  profile: PersonalProfileConfig
  models: AiModelConfig[]
  tasks: AiTaskConfig
  settings: DeliverySettingsConfig
}

export interface StoredConfigStateV1 {
  schemaVersion: typeof CONFIG_SCHEMA_VERSION
  configRevision: number
  profile: PersonalProfileConfig
  models: AiModelConfig[]
  tasks: AiTaskConfig
  accountSettings: Record<string, DeliverySettingsConfig>
}

export interface ConfigValidationIssue {
  path: string
  message: string
}

export class ConfigValidationError extends Error {
  readonly issues: ConfigValidationIssue[]

  constructor(issues: ConfigValidationIssue[]) {
    super(issues[0]?.message ?? '配置校验失败')
    this.name = 'ConfigValidationError'
    this.issues = issues
  }
}

export class ConfigImportRunningError extends Error {
  constructor() {
    super('投递正在运行，停止投递后才能导入配置')
    this.name = 'ConfigImportRunningError'
  }
}

export class ConfigMutationRunningError extends Error {
  constructor(message = '投递正在运行，仅可关闭 AI 招呼语，停止投递后才能修改其他配置') {
    super(message)
    this.name = 'ConfigMutationRunningError'
  }
}
