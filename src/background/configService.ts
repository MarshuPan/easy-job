import { canonicalizeAiConfiguration } from '@/config/aiConfiguration'
import { backfillStoredConfigState } from '@/config/backfill'
import {
  CONFIG_LIMITS,
  COMMUTE_FEATURE_AVAILABLE,
  DEFAULT_AI_FILTERING_PROMPT,
  DEFAULT_AI_GREETING_PROMPT,
  canonicalizeDeliveryFeatureAvailability,
  createDefaultConfigBundle,
  createDefaultStoredConfigState,
  createDefaultDeliverySettings,
} from '@/config/defaults'
import {
  applyGreetingTarget,
  GREETING_TARGET_MAX,
  GREETING_TARGET_MIN,
} from '@/config/greetingLength'
import {
  cloneConfigForTransfer,
  parseConfigJson,
  prepareImportedConfigBundle,
} from '@/config/import'
import { migrateLegacyFormDataToSettings, settingsToLegacyFormData } from '@/config/migrate'
import {
  CONFIG_SCHEMA_VERSION,
  ConfigImportRunningError,
  ConfigMutationRunningError,
  ConfigValidationError,
  type ConfigBundleV1,
  type JobExpectationConfig,
  type AiModelConfig,
  type AiTaskConfig,
  type PersonalProfileConfig,
  type StoredConfigStateV1,
} from '@/config/types'
import { migrateAiGreetingUserPrompt } from '@/config/userPrompt'
import {
  assertConfigImportSize,
  validateConfigBundle,
  validateResumeEvidenceForMarkdown,
  validateStoredConfigState,
} from '@/config/validate'
import { projectPageFormData } from '@/message/publicStateProjection'
import { RESUME_EVIDENCE_VERSION } from '@/profile/resumeExtraction'
import { hashResumeMarkdown } from '@/profile/resumeHash'
import { isPlainObject, jsonClone } from '@/utils/deepmerge'

import { version as appVersion } from '../../package.json'
import type { ConfigStateStorage } from './configStorage'

export interface PublicConfigReadiness {
  configRevision: number
  displayNameReady?: boolean
  modelReady: boolean
  resumeReady: boolean
  resumeStatus?: 'empty' | 'ready' | 'error'
  aiFilteringReady: boolean
  aiGreetingReady: boolean
}

export interface PublicRuntimeConfig {
  accountInitialized: boolean
  aiTaskTimeoutSeconds: number
  enabledExpectations: JobExpectationConfig[]
  formData: ReturnType<typeof settingsToLegacyFormData>
  readiness: PublicConfigReadiness
}

export interface AiTaskExecutionConfig {
  configRevision: number
  model: AiModelConfig
  profile: PersonalProfileConfig
  task: AiTaskConfig['aiFiltering'] | AiTaskConfig['aiGreeting']
}

export interface ConfigImportResult {
  configRevision: number
  resumeEvidenceDiscarded: boolean
  modelCount: number
  aiFilteringEnabled: boolean
  aiGreetingEnabled: boolean
}

export interface ResumeSaveResult {
  configRevision: number
  evidenceVersion: number
  factCount: number
  reused: boolean
  status: 'ready'
}

export interface ResumeDraftResult {
  configRevision: number
  evidenceVersion: number
  factCount: number
  reused: boolean
  status: 'pending' | 'ready'
}

function assertUid(uid: unknown): asserts uid is string {
  if (typeof uid !== 'string' || uid.trim().length === 0 || uid.length > 128) {
    throw new ConfigValidationError([{ path: '$.uid', message: '$.uid: 当前 BOSS 账号无效' }])
  }
}

function createReadiness(state: StoredConfigStateV1): PublicConfigReadiness {
  const modelIds = new Set(state.models.map((model) => model.id))
  const resume = state.profile.resume
  const resumeReady = Boolean(resume.markdown && resume.sourceHash && resume.evidence)
  const resumeStatus = !resume.markdown ? 'empty' : resumeReady ? 'ready' : 'error'
  const filteringModelReady = Boolean(
    state.tasks.aiFiltering.modelId && modelIds.has(state.tasks.aiFiltering.modelId),
  )
  const greetingModelReady = Boolean(
    state.tasks.aiGreeting.modelId && modelIds.has(state.tasks.aiGreeting.modelId),
  )
  const greetingProfileReady = Boolean(state.profile.displayName.trim())
  return {
    configRevision: state.configRevision,
    displayNameReady: greetingProfileReady,
    modelReady: state.models.length > 0,
    resumeReady,
    resumeStatus,
    aiFilteringReady: !state.tasks.aiFiltering.enabled || (filteringModelReady && resumeReady),
    aiGreetingReady:
      !state.tasks.aiGreeting.enabled ||
      (greetingModelReady && greetingProfileReady && resumeReady),
  }
}

export class ConfigService {
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly stateStorage: ConfigStateStorage,
    private readonly currentAppVersion = appVersion,
    private readonly onRevision?: (revision: number) => void | Promise<void>,
    private readonly isDeliveryRunning: (uid: string) => boolean | Promise<boolean> = () => false,
    private readonly isAnyDeliveryRunning: () => boolean | Promise<boolean> = () => false,
  ) {}

  private async readState() {
    const stored = await this.stateStorage.read()
    if (stored == null) return createDefaultStoredConfigState()
    const state = validateStoredConfigState(
      canonicalizeAiConfiguration(backfillStoredConfigState(stored) as StoredConfigStateV1),
    )
    state.tasks.aiGreeting.prompt = migrateAiGreetingUserPrompt(
      state.tasks.aiGreeting.prompt,
      DEFAULT_AI_GREETING_PROMPT,
    )
    if (!COMMUTE_FEATURE_AVAILABLE) {
      for (const [uid, settings] of Object.entries(state.accountSettings)) {
        state.accountSettings[uid] = canonicalizeDeliveryFeatureAvailability(settings)
      }
    }
    return jsonClone(state)
  }

  private async isConfigMutationBlocked(uid?: string) {
    if (uid && (await this.isDeliveryRunning(uid))) return true
    return this.isAnyDeliveryRunning()
  }

  private mutate<T>(mutation: (state: StoredConfigStateV1) => Promise<T> | T): Promise<T> {
    let resolveResult!: (value: T | PromiseLike<T>) => void
    let rejectResult!: (reason?: unknown) => void
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })
    const operation = this.mutationQueue.then(async () => {
      try {
        const current = await this.readState()
        const next = jsonClone(current)
        const value = await mutation(next)
        next.schemaVersion = CONFIG_SCHEMA_VERSION
        next.configRevision = current.configRevision + 1
        validateStoredConfigState(next)
        await this.stateStorage.write(next)
        await this.onRevision?.(next.configRevision)
        resolveResult(value)
      } catch (error) {
        rejectResult(error)
      }
    })
    this.mutationQueue = operation.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async getBundle(uid: string): Promise<ConfigBundleV1> {
    assertUid(uid)
    const state = await this.readState()
    const bundle: ConfigBundleV1 = {
      ...createDefaultConfigBundle({ appVersion: this.currentAppVersion }),
      profile: jsonClone(state.profile),
      models: jsonClone(state.models),
      tasks: jsonClone(state.tasks),
      settings: jsonClone(state.accountSettings[uid] ?? createDefaultDeliverySettings()),
    }
    return cloneConfigForTransfer(validateConfigBundle(bundle))
  }

  async getPublicRuntimeConfig(uid: string): Promise<PublicRuntimeConfig> {
    assertUid(uid)
    const state = await this.readState()
    const settings = state.accountSettings[uid] ?? createDefaultDeliverySettings()
    return {
      accountInitialized: Object.prototype.hasOwnProperty.call(state.accountSettings, uid),
      aiTaskTimeoutSeconds: state.models[0]?.timeoutSeconds ?? 180,
      enabledExpectations: jsonClone(settings.jobRules.sources.enabledExpectations),
      formData: settingsToLegacyFormData(settings, state.tasks, uid),
      readiness: createReadiness(state),
    }
  }

  async getAiTaskExecutionConfig(
    uid: string,
    task: 'aiFiltering' | 'aiGreeting',
  ): Promise<AiTaskExecutionConfig | null> {
    assertUid(uid)
    const state = await this.readState()
    if (!Object.prototype.hasOwnProperty.call(state.accountSettings, uid)) return null
    const taskConfig = state.tasks[task]
    if (!taskConfig.enabled)
      throw new Error(`${task === 'aiFiltering' ? 'AI匹配' : 'AI招呼语'}未开启`)
    if (!taskConfig.modelId) throw new Error('AI任务未选择模型')
    const model = state.models.find((item) => item.id === taskConfig.modelId)
    if (!model) throw new Error('AI任务选择的模型不存在')
    const resume = state.profile.resume
    if (!resume.markdown || !resume.sourceHash || !resume.evidence) {
      throw new Error('个人简历尚未完成事实解析')
    }
    if (task === 'aiGreeting' && !state.profile.displayName.trim()) {
      throw new Error('AI招呼语需要先填写姓名或对外称呼')
    }
    return {
      configRevision: state.configRevision,
      model: jsonClone(model),
      profile: jsonClone(state.profile),
      task: jsonClone(taskConfig),
    }
  }

  async savePublicRuntimeConfig(uid: string, value: unknown, expectations: unknown = []) {
    assertUid(uid)
    const projected = projectPageFormData(value)
    if (!projected || !isPlainObject(projected)) {
      throw new ConfigValidationError([
        { path: '$.formData', message: '$.formData: 运行配置格式无效' },
      ])
    }
    // AI 任务是全局数据，由 saveAiTasks / disableAiGreeting 独立负责。这里只写账号级
    // 运行配置，因此运行中一律拒绝——「关闭 AI 招呼语」那个即时安全控制走独立入口，
    // 不再需要靠比较整份配置来判断本次改动是否只动了那一个字段。
    if (await this.isConfigMutationBlocked(uid)) throw new ConfigMutationRunningError()
    return this.mutate((state) => {
      state.accountSettings[uid] = canonicalizeDeliveryFeatureAvailability(
        migrateLegacyFormDataToSettings(projected, {
          appearance: state.accountSettings[uid]?.appearance,
          expectations: parsePublicExpectations(expectations),
        }),
      )
      return createReadiness({ ...state, configRevision: state.configRevision + 1 })
    })
  }

  /**
   * 保存三个 AI 任务的设置。AI 任务是全局数据，不属于任何单个账号，因此独立于
   * 账号级运行配置保存——混在一起会让新账号的首次保存静默丢掉 AI 设置。
   */
  async saveAiTasks(value: {
    aiFiltering?: { enabled?: boolean; score?: number }
    aiGreeting?: {
      enabled?: boolean
      messageCount?: number
      targetTotalCharacters?: number
      prompt?: string
    }
  }) {
    if (await this.isAnyDeliveryRunning()) throw new ConfigMutationRunningError()
    return this.mutate((state) => {
      const filtering = value.aiFiltering ?? {}
      const greeting = value.aiGreeting ?? {}
      if (typeof filtering.enabled === 'boolean') {
        state.tasks.aiFiltering.enabled = filtering.enabled
      }
      if (
        typeof filtering.score === 'number' &&
        Number.isInteger(filtering.score) &&
        filtering.score >= 0 &&
        filtering.score <= 100
      ) {
        state.tasks.aiFiltering.score = filtering.score
      }
      // 匹配用的系统 Prompt 由插件维护，不接受外部写入（契约 §5.1）。
      state.tasks.aiFiltering.prompt = DEFAULT_AI_FILTERING_PROMPT
      if (typeof greeting.enabled === 'boolean') {
        state.tasks.aiGreeting.enabled = greeting.enabled
      }
      if (
        typeof greeting.messageCount === 'number' &&
        Number.isInteger(greeting.messageCount) &&
        greeting.messageCount >= 1 &&
        greeting.messageCount <= 5
      ) {
        state.tasks.aiGreeting.messageCount = greeting.messageCount
      }
      if (
        typeof greeting.targetTotalCharacters === 'number' &&
        Number.isInteger(greeting.targetTotalCharacters) &&
        greeting.targetTotalCharacters >= GREETING_TARGET_MIN &&
        greeting.targetTotalCharacters <= GREETING_TARGET_MAX
      ) {
        applyGreetingTarget(state.tasks.aiGreeting, greeting.targetTotalCharacters)
      }
      if (
        typeof greeting.prompt === 'string' &&
        greeting.prompt.length <= CONFIG_LIMITS.promptCharacters
      ) {
        state.tasks.aiGreeting.prompt = greeting.prompt
      }
      return createReadiness({ ...state, configRevision: state.configRevision + 1 })
    })
  }

  /**
   * 契约 §3 把「关闭 AI 招呼语」列为即时安全控制，运行中必须可用。
   * 它是唯一允许在投递运行期间写入配置的操作，且只能改这一个字段。
   */
  async disableAiGreeting() {
    return this.mutate((state) => {
      state.tasks.aiGreeting.enabled = false
      return createReadiness({ ...state, configRevision: state.configRevision + 1 })
    })
  }

  async saveAiConfiguration(value: { models: unknown }) {
    if (await this.isAnyDeliveryRunning()) throw new ConfigMutationRunningError()
    return this.mutate((state) => {
      const candidate = validateConfigBundle(
        canonicalizeAiConfiguration({
          ...createDefaultConfigBundle({ appVersion: this.currentAppVersion }),
          profile: state.profile,
          models: value.models as AiModelConfig[],
          tasks: state.tasks,
          settings: Object.values(state.accountSettings)[0] ?? createDefaultDeliverySettings(),
        }),
      )
      state.models = jsonClone(candidate.models)
      const modelId = candidate.models[0]?.id ?? null
      state.tasks.resumeExtraction.modelId = modelId
      state.tasks.aiFiltering.modelId = modelId
      state.tasks.aiGreeting.modelId = modelId
      return createReadiness({ ...state, configRevision: state.configRevision + 1 })
    })
  }

  async replaceBundle(uid: string, value: unknown): Promise<ConfigImportResult> {
    assertUid(uid)
    if (await this.isAnyDeliveryRunning()) throw new ConfigMutationRunningError()
    const { bundle, resumeEvidenceDiscarded } = await prepareImportedConfigBundle(value)
    return this.mutate((state) => {
      state.profile = jsonClone(bundle.profile)
      state.models = jsonClone(bundle.models)
      state.tasks = jsonClone(bundle.tasks)
      state.accountSettings[uid] = canonicalizeDeliveryFeatureAvailability(bundle.settings)
      return {
        configRevision: state.configRevision + 1,
        resumeEvidenceDiscarded,
        modelCount: bundle.models.length,
        aiFilteringEnabled: bundle.tasks.aiFiltering.enabled,
        aiGreetingEnabled: bundle.tasks.aiGreeting.enabled,
      }
    })
  }

  async importJson(uid: string, text: string, sizeBytes: number) {
    if (await this.isConfigMutationBlocked(uid)) throw new ConfigImportRunningError()
    assertConfigImportSize(sizeBytes)
    return this.replaceBundle(uid, parseConfigJson(text))
  }

  async saveProfileDraft(value: { displayName: unknown; markdown: unknown }) {
    if (await this.isAnyDeliveryRunning()) throw new ConfigMutationRunningError()
    const displayName = validateProfileText(
      value.displayName,
      'displayName',
      CONFIG_LIMITS.displayNameCharacters,
    ).trim()
    const markdown = validateResumeMarkdown(value.markdown)
    const sourceHash = await hashResumeMarkdown(markdown)
    return this.mutate((state): ResumeDraftResult => {
      const resume = state.profile.resume
      const canReuse = Boolean(
        resume.markdown === markdown &&
        resume.sourceHash === sourceHash &&
        resume.evidenceVersion === RESUME_EVIDENCE_VERSION &&
        resume.evidence,
      )
      state.profile.displayName = displayName
      if (canReuse) {
        return {
          configRevision: state.configRevision + 1,
          evidenceVersion: RESUME_EVIDENCE_VERSION,
          factCount: resume.evidence?.facts.length ?? 0,
          reused: true,
          status: 'ready' as const,
        }
      }
      state.profile.resume = {
        markdown,
        sourceHash: null,
        evidenceVersion: RESUME_EVIDENCE_VERSION,
        evidence: null,
      }
      return {
        configRevision: state.configRevision + 1,
        evidenceVersion: RESUME_EVIDENCE_VERSION,
        factCount: 0,
        reused: false,
        status: 'pending',
      }
    })
  }

  async commitProfileEvidence(value: { markdown: unknown; evidence: unknown }) {
    if (await this.isAnyDeliveryRunning()) throw new ConfigMutationRunningError()
    const markdown = validateResumeMarkdown(value.markdown)
    const evidence = validateResumeEvidenceForMarkdown(markdown, value.evidence)
    const sourceHash = await hashResumeMarkdown(markdown)
    return this.mutate((state): ResumeSaveResult => {
      if (state.profile.resume.markdown !== markdown) {
        throw new Error('简历内容已更新，本次解析结果已丢弃')
      }
      state.profile.resume = {
        markdown,
        sourceHash,
        evidenceVersion: RESUME_EVIDENCE_VERSION,
        evidence: jsonClone(evidence),
      }
      return {
        configRevision: state.configRevision + 1,
        evidenceVersion: RESUME_EVIDENCE_VERSION,
        factCount: evidence.facts.length,
        reused: false,
        status: 'ready',
      }
    })
  }

  async resetAll(uid: string) {
    assertUid(uid)
    if (await this.isAnyDeliveryRunning()) throw new ConfigMutationRunningError()
    return this.mutate((state) => {
      const defaults = createDefaultStoredConfigState()
      state.profile = defaults.profile
      state.models = defaults.models
      state.tasks = defaults.tasks
      state.accountSettings[uid] = createDefaultDeliverySettings()
      return createReadiness({ ...state, configRevision: state.configRevision + 1 })
    })
  }
}

function validateProfileText(value: unknown, field: string, max: number) {
  if (typeof value !== 'string') {
    throw new ConfigValidationError([
      { path: `$.profile.${field}`, message: `$.profile.${field}: 必须是字符串` },
    ])
  }
  if (value.length > max) {
    throw new ConfigValidationError([
      { path: `$.profile.${field}`, message: `$.profile.${field}: 长度不能超过 ${max}` },
    ])
  }
  return value
}

function validateResumeMarkdown(value: unknown) {
  const markdown = validateProfileText(value, 'resume.markdown', CONFIG_LIMITS.resumeCharacters)
  if (markdown.trim().length === 0) {
    throw new ConfigValidationError([
      { path: '$.profile.resume.markdown', message: '$.profile.resume.markdown: 不能为空' },
    ])
  }
  return markdown
}

function parsePublicExpectations(value: unknown): JobExpectationConfig[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, CONFIG_LIMITS.arrayItems).flatMap((item) => {
    if (!isPlainObject(item)) return []
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    if (!id) return []
    return [
      {
        id,
        positionName: typeof item.positionName === 'string' ? item.positionName.trim() : '',
        locationName: typeof item.locationName === 'string' ? item.locationName.trim() : '',
        salaryDesc: typeof item.salaryDesc === 'string' ? item.salaryDesc.trim() : '',
      },
    ]
  })
}
